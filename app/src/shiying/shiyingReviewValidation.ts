import type { ReviewRef, ReviewEventContext } from './shiyingReviewPlan';
import { parseShiyingModelJson } from './shiyingModelJson';

export type ShiyingReviewModelNode = { ref: string | null; body: string; sources: string[] };
export type ShiyingReviewModelEvent = { ref: string | null; title: string; overview: string; nodes: ShiyingReviewModelNode[] };
export type ShiyingReviewModelTopic = { title: string; sources: string[] };
export type ShiyingReviewModelResult = {
  review?: { title: string; factSummary: string; baiyunNote: string; sources: string[] };
  notes?: Array<{ text: string; sources: string[] }>;
  events: ShiyingReviewModelEvent[]; topics: ShiyingReviewModelTopic[];
};
const fail = (code: string): never => { throw new Error(`shiying_review_output_${code}`); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('object');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))) fail('fields');
  return row;
}
function text(value: unknown, limit = 8000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) return fail('text');
  return value.trim();
}
function title(value: unknown) { const result = text(value, 200); if (/[\r\n]/u.test(result)) fail('title'); return result; }
function list(value: unknown): unknown[] { if (!Array.isArray(value)) return fail('array'); return value; }
export function parseShiyingReviewModelResult(raw: string, input: {
  reading: boolean; refs: ReviewRef[]; visible: string[]; events: ReviewEventContext[]; summaryTextLimit?: number;
}): ShiyingReviewModelResult {
  let value: unknown; try { value = parseShiyingModelJson(raw); } catch { return fail('json'); }
  const root = object(value, [input.reading ? 'notes' : 'review', 'events', 'topics']);
  const available = input.refs.filter(ref => input.visible.includes(ref.ref));
  const resolve = (value: unknown) => {
    const labels = list(value); if (!labels.length || labels.some(ref => typeof ref !== 'string')) return fail('sources');
    const resolved: string[] = [];
    for (const label of labels) {
      const exact = available.find(ref => ref.ref === label);
      const expanded = exact ? [exact] : available.filter(ref => ref.parent === label);
      if (!expanded.length) fail('unknown_source');
      expanded.forEach(ref => { if (!resolved.includes(ref.ref)) resolved.push(ref.ref); });
    }
    return resolved;
  };
  const eventsSeen = new Set<string>(), nodesSeen = new Set<string>();
  const events = list(root.events).map(value => {
    const row = object(value, ['ref', 'title', 'overview', 'nodes']);
    const prior = input.events.find(event => event.ref === row.ref);
    if (row.ref !== null && (!prior || eventsSeen.has(prior.ref))) fail('event_ref');
    if (prior) eventsSeen.add(prior.ref);
    const nodes = list(row.nodes).map(value => {
      const node = object(value, ['ref', 'body', 'sources']);
      if (node.ref !== null && (typeof node.ref !== 'string' || nodesSeen.has(node.ref) || !prior?.nodes.some(item => item.ref === node.ref))) fail('node_ref');
      if (typeof node.ref === 'string') nodesSeen.add(node.ref);
      return { ref: node.ref as string | null, body: text(node.body), sources: resolve(node.sources) };
    });
    if (!nodes.length) fail('event_without_source');
    return { ref: row.ref as string | null, title: title(row.title), overview: text(row.overview), nodes };
  });
  const topics = list(root.topics).map(value => { const row = object(value, ['title', 'sources']); return { title: title(row.title), sources: resolve(row.sources) }; });
  if (input.reading && !list(root.notes).length) fail('empty_notes');
  if (input.reading) return { notes: list(root.notes).map(value => {
    const row = object(value, ['text', 'sources']); return { text: text(row.text), sources: resolve(row.sources) };
  }), events, topics };
  const review = object(root.review, ['title', 'factSummary', 'baiyunNote', 'sources']);
  const maximum = input.summaryTextLimit ?? 8000;
  const result = { title: title(review.title), factSummary: text(review.factSummary, maximum), baiyunNote: text(review.baiyunNote, maximum), sources: resolve(review.sources) };
  if (!input.summaryTextLimit && `# ${result.title}\n\n${result.factSummary}`.length > 8000) fail('summary_length');
  return { review: result, events, topics };
}
