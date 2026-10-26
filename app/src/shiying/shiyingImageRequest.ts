import type { VisionContentPart } from '../ai/postImageVisionRequest';
import { requestCompiledVisionMaterial } from '../ai/openAiCompatibleProvider';
import type { AiConnection } from '../ai/types';
import type { ShiyingRecordV1 } from './shiyingJournalContract';
import { buildShiyingImageUnitMaterial } from './shiyingImagePrompt';
import type { ShiyingImageRequestPlan } from './shiyingImagePlan';
import { readShiyingRecordImageForVision } from './shiyingRecordImages';

export async function buildShiyingImageRequestMaterial(input: {
  plan: ShiyingImageRequestPlan; records: readonly ShiyingRecordV1[];
  readImage?: typeof readShiyingRecordImageForVision;
}) {
  const content: VisionContentPart[] = [];
  const readImage = input.readImage ?? readShiyingRecordImageForVision;
  // Only this request's bytes are held in memory; jobs store ranges and references, never base64.
  const bytes = new Map<string, string>();
  for (const { recordId, unit } of input.plan.units) {
    const record = input.records.find(record => record.id === recordId);
    if (!record) throw new Error(`shiying_image_record_missing:${recordId}`);
    for (const part of buildShiyingImageUnitMaterial(record, unit)) {
      if (part.type === 'text') { content.push({ type: 'text', text: part.text }); continue; }
      const image = record.images.find(image => image.id === part.imageId);
      if (!image) throw new Error(`shiying_image_source_mismatch:${recordId}`);
      let url = bytes.get(image.contentHash);
      if (!url) {
        try { url = (await readImage(image)).dataUrl; }
        catch { throw new Error(`shiying_image_file_unavailable:${recordId}`); }
        bytes.set(image.contentHash, url);
      }
      content.push({ type: 'image_url', image_url: { url } });
    }
  }
  return { role: 'you' as const, content };
}

export function requestShiyingImageNotes(input: {
  apiKey: string; connection: AiConnection; stablePrompt: string;
  material: Awaited<ReturnType<typeof buildShiyingImageRequestMaterial>>;
  outputTokens: number; onRequestStart: (assertTransportReady: () => void) => Promise<void>;
}) {
  return requestCompiledVisionMaterial({
    apiKey: input.apiKey, connection: input.connection, systemPrompt: input.stablePrompt,
    material: input.material, maxOutputTokens: input.outputTokens, onRequestStart: input.onRequestStart,
  });
}
