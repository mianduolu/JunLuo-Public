import type { JunLuoToolResult } from '../tools/toolTypes';
import type { JunLuoToolCallCard } from './toolCallMessageTypes';

export type ChatTextFileReference = NonNullable<JunLuoToolCallCard['fileReference']>;

const fileTools = new Set([
  'files.pick_document', 'files.read_text', 'files.read_part', 'files.search_text', 'files.write_text',
]);

export function isChatTextFileReference(value: unknown): value is ChatTextFileReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => key === 'cacheId' || key === 'name' || key === 'end')
    && typeof item.cacheId === 'string' && !!item.cacheId.trim()
    && typeof item.name === 'string' && !!item.name.trim()
    && (item.end === undefined || (Number.isSafeInteger(item.end) && (item.end as number) >= 0));
}

/** Only host execution results create references; never parse a model's text or input. */
export function chatTextFileReferenceFromResult(result: JunLuoToolResult): ChatTextFileReference | undefined {
  if (!result.ok || result.status !== 'success' || !fileTools.has(result.toolId)) return undefined;
  const data = result.data as Record<string, unknown> | undefined;
  const file = result.toolId === 'files.write_text' ? data?.file : data;
  if (!file || typeof file !== 'object') return undefined;
  const { cacheId, name, deliveredEnd: end } = file as Record<string, unknown>;
  const reference = { cacheId, name, ...(end === undefined ? {} : { end }) };
  return isChatTextFileReference(reference) ? reference : undefined;
}

export function hasChatTextFileCard(
  cards: readonly JunLuoToolCallCard[] | undefined,
  card: JunLuoToolCallCard,
) {
  const reference = card.fileReference;
  return !!reference && isChatTextFileReference(reference) && cards?.some(current => (
    current.callId === card.callId && current.toolId === card.toolId
    && current.status === 'success' && fileTools.has(current.toolId)
    && current.fileReference?.cacheId === reference.cacheId
    && current.fileReference.name === reference.name
  )) === true;
}
