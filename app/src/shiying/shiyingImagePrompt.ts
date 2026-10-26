import type { AiProfile } from '../ai/types';
import type { ShiyingRecordV1 } from './shiyingJournalContract';
import { buildThinPersonaPrompt } from './shiyingPrompt';

export const SHIYING_IMAGE_PROMPT_VERSION = 1 as const;
export const SHIYING_IMAGE_TASK_PROMPT_V1 = `I 正在看 you 留在小纸条里的图片。I 想把图里的内容记清楚，以后我们就可以一起回顾。
I 会结合配文，记下照片里的主要事物、活动和重要细节。I 也会读图里看得清的文字，和画面、配文一起理解。
I 会写明哪些是图里看见的，哪些是 you 在配文里说的。看不清或认不准时，I 会写明哪一处无法辨认、哪些内容无法确认。`;

export const SHIYING_IMAGE_JSON_INSTRUCTION_V1 = `看完后，I 会把图片记录放进下面的 JSON。I 会为本次收到的每条小纸条填写一项，顺序与材料一致：recordId 沿用小纸条的编号，text 写对应的一份简短图片记录。`;

export const SHIYING_IMAGE_JSON_EXAMPLE_V1 = `{
  "imageNotes": [
    {
      "recordId": "<收到的小纸条编号>",
      "text": "<这条小纸条的简短图片记录>"
    }
  ]
}`;

export type ShiyingImageMaterialPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageId: string; ordinal: number };

export type ShiyingImageMaterialRange = {
  captionStart: number;
  captionEnd: number;
  captionIndex: number;
  captionCount: number;
  imageIds: readonly string[];
};

export function buildShiyingImageStablePrompt(profile: Pick<AiProfile, 'systemPrompt' | 'corePersona'>) {
  return [buildThinPersonaPrompt(profile), SHIYING_IMAGE_TASK_PROMPT_V1,
    SHIYING_IMAGE_JSON_INSTRUCTION_V1, SHIYING_IMAGE_JSON_EXAMPLE_V1].join('\n\n');
}

export function buildShiyingImageUnitMaterial(
  record: ShiyingRecordV1,
  unit: ShiyingImageMaterialRange,
): ShiyingImageMaterialPart[] {
  const segmentLabel = unit.captionCount > 1
    ? `\n【配文第 ${unit.captionIndex + 1} 段，共 ${unit.captionCount} 段】` : '';
  const parts: ShiyingImageMaterialPart[] = [{
    type: 'text',
    text: `【you 的自我记录】${segmentLabel}\n\n${JSON.stringify({
      recordId: record.id,
      recordDate: record.recordDate,
      author: 'you',
      body: record.body.slice(unit.captionStart, unit.captionEnd),
    }, null, 2)}`,
  }];
  for (const id of unit.imageIds) {
    const image = record.images.find(candidate => candidate.id === id);
    if (!image) throw new Error('shiying_image_material_source_missing');
    parts.push({ type: 'text', text: `【附图 ${image.ordinal + 1}】` });
    parts.push({ type: 'image', imageId: image.id, ordinal: image.ordinal });
  }
  return parts;
}
