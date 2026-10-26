import { listShiyingMemorySnapshots, loadShiyingMemorySnapshot, type ShiyingMemorySnapshot } from '../shiying/shiyingMemorySource';
import { renderShiyingMemoryMaterial } from '../shiying/shiyingMemoryOrganizationProtocol';
import type { ShiyingReadReference } from './memoryReadReference';

export type ShiyingRecallCandidate = { snapshot: ShiyingMemorySnapshot; textScore: number; semanticScore: number };
export type ShiyingRecallSelection = { items: ShiyingRecallCandidate[]; failure?: 'source_unavailable' | 'read_failed' };
export const SHIYING_TEXT_THRESHOLD = 0.24;
export const SHIYING_SEMANTIC_THRESHOLD = 0.62;

export function scoreShiyingText(snapshot: ShiyingMemorySnapshot, query: string) {
  const text = [snapshot.body, snapshot.imageNote?.body].filter(Boolean).join('\n').toLocaleLowerCase();
  const tokens = [...new Set(query.toLocaleLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) ?? [])];
  let matched = 0, total = 0;
  for (const token of tokens) {
    const parts = /\p{Script=Han}/u.test(token) ? Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2)) : [token];
    for (const part of parts) { total++; if (text.includes(part)) matched++; }
  }
  return total ? matched / total : 0;
}
export async function shiyingRecallCandidates(selection?: ShiyingRecallSelection, signal?: AbortSignal) {
  if (!selection) return [];
  let snapshots: ShiyingMemorySnapshot[];
  try { snapshots = await listShiyingMemorySnapshots(); }
  catch (error) {
    if (signal?.aborted) throw error;
    selection.items = [];
    selection.failure = error instanceof Error && error.message === 'SHIYING_MEMORY_SOURCE_UNAVAILABLE' ? 'source_unavailable' : 'read_failed';
    return [];
  }
  selection.failure = undefined;
  if (signal?.aborted) throw Object.assign(new Error('memory-recall-cancelled'), { name: 'AbortError' });
  return snapshots;
}
export function selectShiyingRecall(selection: ShiyingRecallSelection | undefined, snapshots: ShiyingMemorySnapshot[],
  query: string, semantic = new Map<string, number>()) {
  if (!selection) return;
  selection.items = snapshots.map(snapshot => ({ snapshot, textScore: scoreShiyingText(snapshot, query), semanticScore: semantic.get(snapshot.recordId) ?? 0 }))
    .filter(item => item.textScore >= SHIYING_TEXT_THRESHOLD || item.semanticScore >= SHIYING_SEMANTIC_THRESHOLD)
    .sort((a, b) => (b.textScore + b.semanticScore) - (a.textScore + a.semanticScore)
      || b.snapshot.finalizedAt - a.snapshot.finalizedAt || a.snapshot.recordId.localeCompare(b.snapshot.recordId));
}
export function shiyingReadReference(shiying: ShiyingMemorySnapshot): ShiyingReadReference {
  return { targetKind: 'shiying_record', shiying, version: shiying.materialHash };
}
function wholeEnd(text: string, end: number) {
  return end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end] ?? '') ? end - 1 : end;
}
/** The wrapper, both identities and the actual original ranges share the existing short-material budget. */
export function formatShiyingRecallMaterial(snapshot: ShiyingMemorySnapshot, number: number | string, limit = 180, focus = '') {
  const ranges = { body: { start: 0, end: 0 }, imageNote: { start: 0, end: 0 } };
  const render = () => renderShiyingMemoryMaterial(snapshot, { reference: String(number), ranges: {
    ...(ranges.body.end > ranges.body.start ? { body: ranges.body } : {}),
    ...(ranges.imageNote.end > ranges.imageNote.start ? { imageNote: ranges.imageNote } : {}),
  } });
  const terms = [...new Set([focus.trim(), ...(focus.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/giu) ?? [])])].filter(Boolean);
  const locate = (text: string) => {
    const lower = text.toLocaleLowerCase();
    for (const term of terms) { const index = lower.indexOf(term.toLocaleLowerCase()); if (index >= 0) return index; }
    for (const term of terms) if (/\p{Script=Han}/u.test(term)) {
      for (let index = 0; index < term.length - 1; index++) { const hit = lower.indexOf(term.slice(index, index + 2)); if (hit >= 0) return hit; }
    }
    return -1;
  };
  const pieces = ([['body', snapshot.body], ['imageNote', snapshot.imageNote?.body ?? '']] as const)
    .map(([part, text]) => ({ part, text, hit: locate(text) }))
    .sort((a, b) => Number(b.hit >= 0) - Number(a.hit >= 0));
  // Add only original characters. The shared renderer retains you-before-I even when the image matches first.
  for (const { part, text, hit } of pieces) {
    if (!text) continue;
    const start = wholeEnd(text, Math.max(0, hit - 24));
    ranges[part].start = start;
    let low = 0, high = text.length - start;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      ranges[part].end = wholeEnd(text, start + middle);
      if (render().length <= limit) low = middle; else high = middle - 1;
    }
    ranges[part].end = low ? wholeEnd(text, start + low) : 0;
  }
  const content = render();
  return content.length <= limit && (ranges.body.end > ranges.body.start || ranges.imageNote.end > ranges.imageNote.start) ? content : '';
}
/** One local reread is shared by all final-request refreshes of this selection. */
export type ShiyingRecallRefreshState = { current: ShiyingMemorySnapshot | null; refreshed: boolean; failure?: 'read_failed' };
export function createShiyingRecallRefresh(initial: ShiyingMemorySnapshot, query: string,
  state: ShiyingRecallRefreshState = { current: initial, refreshed: false }) {
  return async () => {
    if (!state.current) return null;
    let latest: ShiyingMemorySnapshot | null;
    try { latest = await loadShiyingMemorySnapshot(state.current.recordId); }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      state.failure = 'read_failed'; return state.current = null;
    }
    if (!latest) return state.current = null;
    if (latest.materialHash !== state.current.materialHash) {
      if (state.refreshed || scoreShiyingText(latest, query) < SHIYING_TEXT_THRESHOLD) return state.current = null;
      state.refreshed = true;
      state.current = latest;
    }
    return state.current;
  };
}
