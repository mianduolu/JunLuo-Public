import type { ShiyingMixedMaterialV1 } from './shiyingMixedMaterials';
import { hashShiyingJson as hash } from './shiyingImageNoteContract';

export type ReviewRange = { start: number; end: number };
export type ReviewRef = {
  ref: string; parent: string; kind: 'entry' | 'record'; id: string; date: string;
  contentHash: string; materialHash: string; imageIds: string[];
  component: 'body' | 'image_note'; imageNoteHash: string | null; range: ReviewRange;
};
export type ReviewEventContext = {
  id: string; ref: string; updatedAt: number; title: string; overview: string;
  nodes: Array<{ id: string; ref: string; date: string; body: string }>;
  feedback: Array<{ nodeId: string; ref: string; body: string; fromRef: string; toRef: string | null }>;
};
export type ReviewPlan = {
  version: 1; periodStart: string; periodEnd: string; inputHash: string; basisHash: string; promptHash: string;
  refs: ReviewRef[]; materials: Array<{ kind: 'entry' | 'record'; id: string; materialHash: string; parent: string; date: string; imageState: ShiyingMixedMaterialV1['imageState'] }>;
  events: Array<{ id: string; ref: string; updatedAt: number; hash: string }>;
  chunks: string[][]; direct: boolean;
  contractVersion?: 2; expectedSummaryStateHash?: string | null; regenerationIntentId?: string | null;
  imageCoverage?: import('./shiyingSummaryContract').ShiyingSummaryImageCoverageV1;
};
const fail = (code: string): never => { throw new Error(`shiying_review_${code}`); };

/** Every original code unit is covered. Boundaries never bisect a surrogate pair. */
export function splitShiyingReviewText(text: string, maximum: number): ReviewRange[] {
  if (!Number.isSafeInteger(maximum) || maximum < 2) fail('range_limit');
  const ranges: ReviewRange[] = []; let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maximum);
    if (end < text.length) {
      const window = text.slice(start, end);
      const paragraph = window.lastIndexOf('\n\n');
      const sentence = Math.max(...['。', '！', '？', '!', '?', '\n'].map(mark => window.lastIndexOf(mark)));
      if (paragraph >= 0) end = start + paragraph + 2;
      else if (sentence >= 0) end = start + sentence + 1;
      const unit = text.charCodeAt(end - 1), next = text.charCodeAt(end);
      if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    if (end <= start) fail('range_progress');
    ranges.push({ start, end }); start = end;
  }
  return ranges;
}
export function reviewContextText(events: readonly ReviewEventContext[]) {
  if (!events.length) return '';
  const lines = events.flatMap(event => [`${event.ref}｜${event.title}${event.overview ? `：${event.overview}` : ''}`,
    ...event.nodes.map(node => `${node.ref}｜${node.date}：${node.body}`)]);
  const corrections = events.flatMap(event => event.feedback.map(item => `${item.ref}｜${item.body}｜you 已将它${item.toRef
    ? `从 ${item.fromRef} 移到 ${item.toRef}` : `移出 ${item.fromRef}`}`));
  return `【I｜已有事件】\n${lines.join('\n')}${corrections.length ? `\n\n【事件关联纠正】\n${corrections.join('\n')}` : ''}`;
}
export function buildShiyingReviewMaterial(plan: Pick<ReviewPlan, 'periodStart' | 'periodEnd' | 'refs' | 'materials'>,
  visibleRefs: readonly string[], materials: readonly ShiyingMixedMaterialV1[], events: readonly ReviewEventContext[], part?: { index: number; total: number }) {
  const selected = new Set(visibleRefs); const refs = plan.refs.filter(ref => selected.has(ref.ref));
  const byId = new Map(materials.map(item => [`${item.kind}:${item.id}`, item]));
  const lines = [`${part ? `材料：第 ${part.index + 1} 段，共 ${part.total} 段\n\n` : ''}周期：${plan.periodStart}～${plan.periodEnd}`];
  for (const item of plan.materials) {
    const own = refs.filter(ref => ref.id === item.id && ref.kind === item.kind);
    if (!own.length) continue;
    const material = byId.get(`${item.kind}:${item.id}`);
    if (!material || material.materialHash !== item.materialHash) throw new Error('shiying_review_source_changed');
    const body = own.filter(ref => ref.component === 'body');
    if (item.kind === 'record') {
      lines.push(`【you｜纸条】\n${item.parent}｜${item.date}`);
      if (body.length) lines.push(body.map(ref => `${ref.ref}：${material.body.slice(ref.range.start, ref.range.end)}`).join('\n'));
    } else lines.push(`【I｜荧迹】\n${body.map(ref => `${ref.ref}｜${item.date}：${material.body.slice(ref.range.start, ref.range.end)}`).join('\n')}`);
    for (const ref of own.filter(ref => ref.component === 'image_note')) lines.push(
      `【I｜图片记录】\n${ref.ref}｜${item.parent}：${material.imageNote!.body.slice(ref.range.start, ref.range.end)}`);
  }
  const context = reviewContextText(events); if (context) lines.push(context);
  const states = plan.materials.filter(item => item.kind === 'record' && ['pending', 'skipped', 'stale'].includes(item.imageState));
  if (states.length) lines.push(`【图片状态】\n${states.map(item => `${item.parent}｜${item.imageState === 'pending'
    ? '图片尚未读完' : item.imageState === 'skipped' ? '图片暂时跳过' : '图片记录待核对'}`).join('\n')}`);
  return lines.join('\n\n');
}

export function planShiyingReview(input: {
  periodStart: string; periodEnd: string; materials: ShiyingMixedMaterialV1[]; events: ReviewEventContext[];
  promptHash: string; fits: (material: string, reading: boolean) => boolean;
}) {
  const base: ReviewPlan = { version: 1, periodStart: input.periodStart, periodEnd: input.periodEnd,
    inputHash: '', basisHash: '', promptHash: input.promptHash, refs: [], materials: [], events: input.events.map(event => ({
      id: event.id, ref: event.ref, updatedAt: event.updatedAt, hash: hash(event),
    })), chunks: [], direct: true };
  let r = 0, p = 0, l = 0;
  for (const material of input.materials) {
    const parent = material.kind === 'record' ? `R${++r}` : `L${++l}`;
    base.materials.push({ kind: material.kind, id: material.id, date: material.date, materialHash: material.materialHash, parent, imageState: material.imageState });
    const add = (component: ReviewRef['component'], text: string, root: string) => {
      if (!text.length) return;
      const ranges: ReviewRange[] = [];
      let start = 0;
      while (start < text.length) {
        const separator = text.indexOf('\n\n', start);
        const end = component === 'body' && material.kind === 'record' && separator >= 0 ? separator + 2 : text.length;
        ranges.push({ start, end }); start = end;
      }
      ranges.forEach((range, index) => base.refs.push({ ref: component === 'body' && material.kind === 'record' ? `${parent}-${index + 1}` : ranges.length > 1 ? `${root}-${index + 1}` : root, parent, kind: material.kind, id: material.id, date: material.date,
        contentHash: material.sourceContentHash, materialHash: material.materialHash, imageIds: material.imageIds,
        component, imageNoteHash: material.imageNote?.resultHash ?? null, range }));
    };
    add('body', material.body, material.kind === 'record' ? `${parent}-1` : parent);
    if (material.imageNote) add('image_note', material.imageNote.body, `P${++p}`);
  }
  const render = (refs: string[], reading: boolean) => buildShiyingReviewMaterial(base, refs, input.materials, input.events,
    reading ? { index: 0, total: 9999 } : undefined);
  const all = base.refs.map(ref => ref.ref);
  if (input.fits(render(all, false), false)) base.chunks = all.length ? [all] : [];
  else {
    base.direct = false;
    const original = [...base.refs]; base.refs = [];
    for (const ref of original) {
      const material = input.materials.find(item => item.kind === ref.kind && item.id === ref.id)!;
      const text = (ref.component === 'body' ? material.body : material.imageNote!.body).slice(ref.range.start, ref.range.end);
      let maximum = Math.max(2, text.length);
      let split: ReviewRef[] = [];
      while (true) {
        split = splitShiyingReviewText(text, maximum).map((range, index) => ({ ...ref, ref: `${ref.ref}-${index + 1}`, range: { start: ref.range.start + range.start, end: ref.range.start + range.end } }));
        base.refs = [...base.refs.filter(existing => existing.ref !== ref.ref && !existing.ref.startsWith(`${ref.ref}-`)), ...split];
        if (split.every(part => input.fits(render([part.ref], true), true))) break;
        if (maximum === 2) fail('capacity_blocked');
        maximum = Math.max(2, Math.floor(maximum / 2));
      }
    }
    let current: string[] = [];
    for (const ref of base.refs) {
      if (current.length && !input.fits(render([...current, ref.ref], true), true)) { base.chunks.push(current); current = []; }
      if (!input.fits(render([ref.ref], true), true)) fail('capacity_blocked');
      current.push(ref.ref);
    }
    if (current.length) base.chunks.push(current);
  }
  base.inputHash = hash({ periodStart: base.periodStart, periodEnd: base.periodEnd, promptHash: base.promptHash,
    materials: base.materials, events: base.events });
  base.basisHash = hash({ materials: base.materials.map(({ parent: _parent, ...material }) => material),
    corrections: input.events.flatMap(event => event.feedback.map(item => ({ nodeId: item.nodeId, body: item.body,
      fromId: input.events.find(event => event.ref === item.fromRef)?.id ?? item.fromRef,
      toId: input.events.find(event => event.ref === item.toRef)?.id ?? item.toRef }))).sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
    promptHash: base.promptHash });
  return base;
}
export function buildShiyingReviewFinalMaterial(plan: ReviewPlan, events: ReviewEventContext[], results: string[]) {
  return [`周期：${plan.periodStart}～${plan.periodEnd}`, reviewContextText(events), ...results.map((json, index) =>
    `【I｜第 ${index + 1} 段阅读结果】\n${json}`)].filter(Boolean).join('\n\n');
}
