import { assertShiyingLifeDate } from './shiyingContract';
import { parseShiyingModelJson } from './shiyingModelJson';
import { hashShiyingJson as hash } from './shiyingImageNoteContract';
import type { ShiyingMixedMaterialV1 } from './shiyingMixedMaterials';
import { splitShiyingReviewText, type ReviewRange } from './shiyingReviewPlan';
import type { ShiyingSummarySourceV3, ShiyingSummaryInputV1, ShiyingSummaryImageCoverageV1 } from './shiyingSummaryContract';
import { SHIYING_MONTH_REVIEW_FINAL_MATERIAL, SHIYING_YEAR_REVIEW_FINAL_MATERIAL,
  type ShiyingPeriodReviewKind } from './shiyingPeriodReviewPrompt';

export const SHIYING_PERIOD_REVIEW_FLOOR = '2026-10-01';
export type PeriodReviewLower = {
  id: string; kind: 'week' | 'month' | 'year'; periodStart: string; periodEnd: string;
  title: string; factSummary: string; baiyunNote: string; status: 'active' | 'rejected'; dirty: boolean;
  editedAt: number | null; sourceInvalidated: boolean; contentHash: string;
  sources: ShiyingSummarySourceV3[]; imageCoverage?: ShiyingSummaryImageCoverageV1;
};
export type PeriodReviewEvent = {
  id: string; title: string; nodes: Array<{ id: string; date: string; body: string; contentHash: string;
    sources: ShiyingSummarySourceV3[]; sourceDates: Array<{ kind: 'entry' | 'record'; id: string; date: string | null }> }>;
};
export type PeriodReviewInputs = { facts: ShiyingMixedMaterialV1[]; lowerReviews: PeriodReviewLower[]; events: PeriodReviewEvent[];
  imageCoverage?: ShiyingSummaryImageCoverageV1 };
export type PeriodReviewRef = {
  key: string; ref: string; parent: string; kind: 'entry' | 'record' | 'summary' | 'event_node'; id: string;
  component: 'body' | 'image_note' | 'note'; range: ReviewRange; contentHash: string; materialHash: string;
};
export type PeriodReviewMaterial = {
  kind: PeriodReviewRef['kind']; id: string; parent: string; date: string; materialHash: string;
  title: string | null; periodStart: string | null; periodEnd: string | null; eventId: string | null;
  eventRef: string | null; imageState: ShiyingMixedMaterialV1['imageState'];
};
export type PeriodReviewPlan = {
  version: 2; kind: ShiyingPeriodReviewKind; periodStart: string; periodEnd: string;
  promptHash: string; inputHash: string; basisHash: string; frozenMembershipHash: string;
  regenerationIntentId: string | null; refs: PeriodReviewRef[]; materials: PeriodReviewMaterial[];
  rootSources: Array<{ kind: PeriodReviewRef['kind']; id: string; sources: ShiyingSummarySourceV3[] }>;
  recordImageOrders?: Array<{ recordId: string; imageIds: string[] }>;
  imageCoverage: ShiyingSummaryImageCoverageV1; chunks: string[][]; direct: boolean;
};
export type PeriodReviewModelResult = {
  review?: { title: string; factSummary: string; baiyunNote: string; sources: string[] };
  notes?: Array<{ text: string; sources: string[] }>;
};
const fail = (code: string): never => { throw new Error(`shiying_period_review_${code}`); };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function dateText(value: Date) { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`; }
function date(value: string) { assertShiyingLifeDate(value, 'period_date'); return new Date(`${value}T12:00:00`); }
export function shiyingPeriodForDate(kind: ShiyingPeriodReviewKind, value: string) {
  const start = date(value); start.setDate(1);
  if (kind === 'year') start.setMonth(0);
  const end = new Date(start); end.setMonth(end.getMonth() + (kind === 'month' ? 1 : 12)); end.setDate(0);
  return { start: dateText(start) < SHIYING_PERIOD_REVIEW_FLOOR ? SHIYING_PERIOD_REVIEW_FLOOR : dateText(start), end: dateText(end) };
}
export function shiyingPeriodReadyAt(kind: ShiyingPeriodReviewKind, periodStart: string) {
  const period = shiyingPeriodForDate(kind, periodStart);
  const ready = date(period.end); ready.setDate(ready.getDate() + 1); ready.setHours(5, 0, 0, 0); return ready.getTime();
}
export function getShiyingLatestClosedPeriod(kind: ShiyingPeriodReviewKind, now = Date.now()) {
  const today = new Date(now); const period = shiyingPeriodForDate(kind, dateText(today));
  const previous = date(period.start); previous.setDate(previous.getDate() - 1);
  let result = shiyingPeriodForDate(kind, dateText(previous));
  if (result.end < SHIYING_PERIOD_REVIEW_FLOOR) return null;
  if (now < shiyingPeriodReadyAt(kind, result.start)) {
    const prior = date(result.start); prior.setDate(prior.getDate() - 1);
    if (dateText(prior) < SHIYING_PERIOD_REVIEW_FLOOR) return null;
    result = shiyingPeriodForDate(kind, dateText(prior));
  }
  return result.start > result.end || result.end < SHIYING_PERIOD_REVIEW_FLOOR ? null : result;
}
export function listShiyingClosedPeriods(kind: ShiyingPeriodReviewKind, now = Date.now(), floor = SHIYING_PERIOD_REVIEW_FLOOR) {
  const latest = getShiyingLatestClosedPeriod(kind, now); if (!latest) return [];
  const result: Array<{ start: string; end: string }> = []; let period = latest;
  while (period.start >= floor && period.end >= SHIYING_PERIOD_REVIEW_FLOOR) {
    result.push(period); const prior = date(period.start); prior.setDate(prior.getDate() - 1);
    if (dateText(prior) < SHIYING_PERIOD_REVIEW_FLOOR) break;
    period = shiyingPeriodForDate(kind, dateText(prior));
  }
  return result;
}
function inPeriod(value: string | null, start: string, end: string) { return value !== null && value >= start && value <= end; }
function validLower(value: PeriodReviewLower, kind: ShiyingPeriodReviewKind, start: string, end: string) {
  return value.kind === (kind === 'month' ? 'week' : 'month') && value.periodStart >= start && value.periodEnd <= end
    && value.status === 'active' && !value.sourceInvalidated && (!value.dirty || value.editedAt !== null);
}
function selectInputs(kind: ShiyingPeriodReviewKind, start: string, end: string, input: PeriodReviewInputs) {
  const lowerReviews = input.lowerReviews.filter(value => validLower(value, kind, start, end))
    .sort((a, b) => compare(a.periodStart, b.periodStart) || compare(a.id, b.id));
  const periodFacts = input.facts.filter(value => inPeriod(value.date, start, end));
  const fallbackIds = new Set<string>();
  const events = input.events.map(event => ({ ...event, nodes: event.nodes.filter(node => {
    const dates = node.sources.map(source => node.sourceDates.find(value => value.kind === source.kind && value.id === source.id)?.date ?? null);
    if (!dates.some(value => inPeriod(value, start, end))) return false;
    if (dates.some(value => !inPeriod(value, start, end))) {
      node.sourceDates.filter(value => inPeriod(value.date, start, end)).forEach(value => fallbackIds.add(`${value.kind}:${value.id}`));
      return false;
    }
    return true;
  }).sort((a, b) => compare(a.date, b.date) || compare(a.id, b.id)) })).filter(event => event.nodes.length)
    .sort((a, b) => compare(a.nodes[0].date, b.nodes[0].date) || compare(a.id, b.id));
  const facts = periodFacts.filter(value => fallbackIds.has(`${value.kind}:${value.id}`)
    || !lowerReviews.some(lower => value.date >= lower.periodStart && value.date <= lower.periodEnd))
    .sort((a, b) => compare(a.date, b.date) || a.createdAt - b.createdAt || compare(a.kind, b.kind) || compare(a.id, b.id));
  return { facts, lowerReviews, events };
}
export function createShiyingPeriodReviewMembershipHash(kind: ShiyingPeriodReviewKind, start: string, end: string, input: PeriodReviewInputs) {
  return hash({ kind, start, end,
    facts: input.facts.filter(value => inPeriod(value.date, start, end)).map(value => ({ kind: value.kind, id: value.id, hash: value.materialHash }))
      .sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`)),
    reviews: input.lowerReviews.filter(value => value.periodEnd >= start && value.periodStart <= end).map(value => ({ id: value.id,
      hash: value.contentHash, status: value.status, dirty: value.dirty, editedAt: value.editedAt, sourceInvalidated: value.sourceInvalidated })).sort((a, b) => compare(a.id, b.id)),
    events: input.events.flatMap(event => event.nodes.filter(node => node.sourceDates.some(value => inPeriod(value.date, start, end)))
      .map(node => ({ id: node.id, hash: node.contentHash }))).sort((a, b) => compare(a.id, b.id)),
  });
}
export function shiyingPeriodReviewEligibility(kind: ShiyingPeriodReviewKind, start: string, end: string, input: PeriodReviewInputs) {
  const selected = selectInputs(kind, start, end, input);
  if (selected.lowerReviews.length || selected.events.length || selected.facts.some(value => value.kind === 'record'
    && (value.body.trim() || value.imageNote))) return 'review' as const;
  const entries = selected.facts.filter(value => value.kind === 'entry').length;
  if (entries >= 2) return 'review' as const;
  if (entries === 1) return 'sparse' as const;
  if (selected.facts.some(value => value.kind === 'record' && value.imageIds.length)) return 'waiting_images' as const;
  return 'empty' as const;
}
function mergeRanges(values: ReviewRange[]) {
  const result: ReviewRange[] = [];
  for (const range of [...values].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result[result.length - 1]; if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}
function mergeSources(values: ShiyingSummarySourceV3[]) {
  const result = new Map<string, ShiyingSummarySourceV3>();
  for (const source of values) {
    const key = `${source.kind}:${source.id}`, previous = result.get(key);
    if (!previous) result.set(key, { ...source, imageIds: [...source.imageIds], textRanges: source.textRanges?.map(value => ({ ...value })) ?? null,
      imageNoteRanges: source.imageNoteRanges?.map(value => ({ ...value })) ?? null });
    else {
      const imageIds = [...new Set([...previous.imageIds, ...source.imageIds])];
      previous.imageIds = imageIds;
      const unknown = (value: ShiyingSummarySourceV3) => value.contentHash === null || value.textRanges === null || value.imageNoteRanges === null;
      if (unknown(previous)) continue;
      if (unknown(source)) { result.set(key, { ...source, imageIds }); continue; }
      if (previous.contentHash !== null && source.contentHash !== null && previous.contentHash !== source.contentHash) fail('source_conflict');
      previous.contentHash ??= source.contentHash;
      previous.textRanges = previous.textRanges === null || source.textRanges === null ? null : mergeRanges([...previous.textRanges, ...source.textRanges]);
      previous.imageNoteRanges = previous.imageNoteRanges === null || source.imageNoteRanges === null ? null : mergeRanges([...previous.imageNoteRanges, ...source.imageNoteRanges]);
      if (previous.imageNoteHash !== null && source.imageNoteHash !== null && previous.imageNoteHash !== source.imageNoteHash) fail('image_note_conflict');
      previous.imageNoteHash ??= source.imageNoteHash;
    }
  }
  return [...result.values()].sort((a, b) => compare(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
}
function textFor(ref: PeriodReviewRef, inputs: PeriodReviewInputs) {
  if (ref.kind === 'summary') {
    const value = inputs.lowerReviews.find(value => value.id === ref.id);
    if (!value || value.contentHash !== ref.materialHash) fail('source_changed');
    return ref.component === 'note' ? value!.baiyunNote : value!.factSummary;
  }
  if (ref.kind === 'event_node') {
    const value = inputs.events.flatMap(event => event.nodes).find(value => value.id === ref.id);
    if (!value || value.contentHash !== ref.materialHash) fail('source_changed'); return value!.body;
  }
  const value = inputs.facts.find(value => value.kind === ref.kind && value.id === ref.id);
  if (!value || value.materialHash !== ref.materialHash) fail('source_changed');
  return ref.component === 'image_note' ? value!.imageNote?.body ?? fail('source_changed') : value!.body;
}
export function buildShiyingPeriodReviewMaterial(plan: PeriodReviewPlan, visible: readonly string[], facts: ShiyingMixedMaterialV1[],
  lowerReviews: PeriodReviewLower[], events: PeriodReviewEvent[], part?: { index: number; total: number }) {
  const inputs = { facts, lowerReviews, events }; const selected = new Set(visible);
  const refs = plan.refs.filter(ref => selected.has(ref.key));
  const lines = [`${part ? `材料：第 ${part.index + 1} 段，共 ${part.total} 段\n\n` : ''}周期：${plan.periodStart}～${plan.periodEnd}`];
  for (const material of plan.materials) {
    const own = refs.filter(ref => ref.kind === material.kind && ref.id === material.id); if (!own.length) continue;
    const text = (component: PeriodReviewRef['component']) => own.filter(ref => ref.component === component)
      .map(ref => textFor(ref, inputs).slice(ref.range.start, ref.range.end)).join('');
    if (material.kind === 'summary') {
      lines.push(`【I｜${plan.kind === 'month' ? '周' : '月'}回顾】\n${material.parent}｜${material.periodStart}～${material.periodEnd}｜${material.title}`
        + `${own.some(ref => ref.component === 'body') ? `\n正文：${text('body')}` : ''}`
        + `${own.some(ref => ref.component === 'note') ? `\n心里话：${text('note')}` : ''}`);
    } else if (material.kind === 'event_node') lines.push(`【I｜事件发展】\n${material.eventRef}｜${material.title}\n${material.parent}｜记录于${material.date}：${text('body')}`);
    else {
      const body = own.filter(ref => ref.component === 'body');
      if (material.kind === 'record') {
        lines.push(`【you｜纸条】\n${material.parent}｜${material.date}${body.length ? `\n${body.map(ref => `${ref.ref}：${textFor(ref, inputs).slice(ref.range.start, ref.range.end)}`).join('\n')}` : ''}`);
      } else if (body.length) lines.push(`【I｜荧迹】\n${body.map(ref => `${ref.ref}｜${material.date}：${textFor(ref, inputs).slice(ref.range.start, ref.range.end)}`).join('\n')}`);
      for (const ref of own.filter(ref => ref.component === 'image_note')) lines.push(`【I｜图片记录】\n${ref.ref}｜${material.parent}：${textFor(ref, inputs).slice(ref.range.start, ref.range.end)}`);
    }
  }
  const states = plan.materials.filter(value => value.kind === 'record' && ownVisible(value, refs)
    && ['pending', 'skipped', 'stale'].includes(value.imageState));
  if (states.length) lines.push(`【图片状态】\n${states.map(value => `${value.parent}｜${value.imageState === 'pending'
    ? '图片尚未读完' : value.imageState === 'skipped' ? '图片暂时跳过' : '图片记录待核对'}`).join('\n')}`);
  return lines.join('\n\n');
}
function ownVisible(value: PeriodReviewMaterial, refs: PeriodReviewRef[]) { return refs.some(ref => ref.kind === value.kind && ref.id === value.id); }
export function planShiyingPeriodReview(input: PeriodReviewInputs & { kind: ShiyingPeriodReviewKind; periodStart: string; periodEnd: string;
  promptHash: string; fits: (material: string, reading: boolean) => boolean; regenerationIntentId?: string | null }): PeriodReviewPlan {
  assertShiyingLifeDate(input.periodStart, 'period_start'); assertShiyingLifeDate(input.periodEnd, 'period_end');
  const expected = shiyingPeriodForDate(input.kind, input.periodStart);
  if (input.periodStart !== expected.start || input.periodEnd !== expected.end || input.periodEnd < SHIYING_PERIOD_REVIEW_FLOOR) fail('period');
  const selected = selectInputs(input.kind, input.periodStart, input.periodEnd, input);
  const plan: PeriodReviewPlan = { version: 2, kind: input.kind, periodStart: input.periodStart, periodEnd: input.periodEnd,
    promptHash: input.promptHash, inputHash: '', basisHash: '', frozenMembershipHash: createShiyingPeriodReviewMembershipHash(input.kind, input.periodStart, input.periodEnd, input),
    regenerationIntentId: input.regenerationIntentId ?? null, refs: [], materials: [], rootSources: [], imageCoverage: { records: [], legacyUnknownSummaryIds: [] }, chunks: [], direct: true };
  const add = (material: PeriodReviewMaterial, component: PeriodReviewRef['component'], value: string, label: string, contentHash: string) => {
    if (!value.length) return;
    const actual: ReviewRange[] = []; let start = 0;
    while (start < value.length) {
      const separator = material.kind === 'record' && component === 'body' ? value.indexOf('\n\n', start) : -1;
      const end = separator < 0 ? value.length : separator + 2; actual.push({ start, end }); start = end;
    }
    actual.forEach((range, index) => { const ref = material.kind === 'record' && component === 'body' ? `${material.parent}-${index + 1}` : label;
      plan.refs.push({ key: `${ref}:${component}:${range.start}:${range.end}`, ref, parent: material.parent,
        kind: material.kind, id: material.id, component, range, contentHash, materialHash: material.materialHash }); });
  };
  let r = 0, p = 0, l = 0, s = 0, n = 0, e = 0;
  for (const lower of selected.lowerReviews) {
    const material: PeriodReviewMaterial = { kind: 'summary', id: lower.id, parent: `${input.kind === 'month' ? 'W' : 'M'}${++s}`,
      date: lower.periodStart, materialHash: lower.contentHash, title: lower.title, periodStart: lower.periodStart, periodEnd: lower.periodEnd,
      eventId: null, eventRef: null, imageState: 'none' };
    plan.materials.push(material); plan.rootSources.push({ kind: material.kind, id: material.id, sources: lower.sources });
    add(material, 'body', lower.factSummary, material.parent, lower.contentHash); add(material, 'note', lower.baiyunNote, material.parent, lower.contentHash);
  }
  for (const event of selected.events) {
    const eventRef = `E${++e}`;
    for (const node of event.nodes) {
      const material: PeriodReviewMaterial = { kind: 'event_node', id: node.id, parent: `N${++n}`, date: node.date,
        materialHash: node.contentHash, title: event.title, periodStart: null, periodEnd: null, eventId: event.id, eventRef, imageState: 'none' };
      plan.materials.push(material); plan.rootSources.push({ kind: material.kind, id: material.id, sources: node.sources });
      add(material, 'body', node.body, material.parent, node.contentHash);
    }
  }
  for (const fact of selected.facts) {
    if (!fact.body.trim() && !fact.imageNote) continue;
    const material: PeriodReviewMaterial = { kind: fact.kind, id: fact.id, parent: fact.kind === 'record' ? `R${++r}` : `L${++l}`,
      date: fact.date, materialHash: fact.materialHash, title: null, periodStart: null, periodEnd: null, eventId: null, eventRef: null, imageState: fact.imageState };
    plan.materials.push(material); plan.rootSources.push({ kind: material.kind, id: material.id, sources: [{ kind: fact.kind, id: fact.id,
      contentHash: fact.sourceContentHash, imageIds: fact.imageIds, textRanges: [], imageNoteRanges: [], imageNoteHash: fact.imageNote?.resultHash ?? null }] });
    add(material, 'body', fact.body, material.parent, fact.sourceContentHash);
    if (fact.imageNote) add(material, 'image_note', fact.imageNote.body, `P${++p}`, fact.sourceContentHash);
  }
  const recordImageOrders = input.facts.filter(fact => fact.kind === 'record' && fact.imageIds.length
    && plan.rootSources.some(root => root.sources.some(source => source.kind === 'record' && source.id === fact.id)))
    .map(fact => ({ recordId: fact.id, imageIds: [...fact.imageIds] }));
  if (recordImageOrders.length) plan.recordImageOrders = recordImageOrders;
  const directCoverage = input.imageCoverage ? { ...input.imageCoverage,
    records: input.imageCoverage.records.filter(record => selected.facts.some(value => value.kind === 'record' && value.id === record.recordId)) } : null;
  const coverage = [...selected.lowerReviews.map(value => value.imageCoverage).filter((value): value is ShiyingSummaryImageCoverageV1 => !!value), ...(directCoverage ? [directCoverage] : [])];
  plan.imageCoverage = { records: [...new Map(coverage.flatMap(value => value.records).map(value => [value.recordId, value])).values()],
    legacyUnknownSummaryIds: [...new Set([...coverage.flatMap(value => value.legacyUnknownSummaryIds), ...selected.lowerReviews.filter(value => !value.imageCoverage).map(value => value.id)])] };
  const render = (keys: string[], reading: boolean) => buildShiyingPeriodReviewMaterial(plan, keys, input.facts, input.lowerReviews, input.events,
    reading ? { index: 0, total: 9999 } : undefined);
  const all = plan.refs.map(value => value.key);
  if (input.fits(render(all, false), false)) plan.chunks = all.length ? [all] : [];
  else {
    plan.direct = false; const original = [...plan.refs]; plan.refs = [];
    for (const ref of original) {
      const value = textFor(ref, input).slice(ref.range.start, ref.range.end); let maximum = Math.max(2, value.length);
      for (;;) {
        const split = splitShiyingReviewText(value, maximum).map(range => ({ ...ref,
          range: { start: ref.range.start + range.start, end: ref.range.start + range.end },
          key: `${ref.ref}:${ref.component}:${ref.range.start + range.start}:${ref.range.start + range.end}` }));
        const prior = plan.refs; plan.refs = [...prior, ...split];
        if (split.every(value => input.fits(render([value.key], true), true))) break;
        plan.refs = prior; if (maximum === 2) fail('capacity_blocked'); maximum = Math.max(2, Math.floor(maximum / 2));
      }
    }
    let current: string[] = [];
    for (const ref of plan.refs) {
      if (current.length && !input.fits(render([...current, ref.key], true), true)) { plan.chunks.push(current); current = []; }
      if (!input.fits(render([ref.key], true), true)) fail('capacity_blocked'); current.push(ref.key);
    }
    if (current.length) plan.chunks.push(current);
  }
  plan.inputHash = hash({ kind: input.kind, periodStart: input.periodStart, periodEnd: input.periodEnd, promptHash: input.promptHash,
    materials: plan.materials, sources: plan.rootSources, imageCoverage: plan.imageCoverage });
  plan.basisHash = hash({ kind: input.kind, periodStart: input.periodStart, periodEnd: input.periodEnd,
    materials: plan.materials.map(({ parent: _parent, eventRef: _eventRef, ...value }) => value), sources: plan.rootSources, promptHash: input.promptHash });
  return plan;
}
function resolveRefs(plan: PeriodReviewPlan, labels: readonly string[], visible: readonly string[]) {
  const keys = new Set(visible); const available = plan.refs.filter(value => keys.has(value.key)); const result: PeriodReviewRef[] = [];
  for (const label of labels) {
    const exact = available.filter(value => value.ref === label); const refs = exact.length ? exact : available.filter(value => value.parent === label);
    if (!refs.length) fail('unknown_source'); refs.forEach(value => { if (!result.some(existing => existing.key === value.key)) result.push(value); });
  }
  return result;
}
export function projectShiyingPeriodReviewSources(plan: PeriodReviewPlan, labels: readonly string[], visible = plan.refs.map(value => value.key)) {
  const refs = resolveRefs(plan, labels, visible); const inputs: ShiyingSummaryInputV1[] = []; const roots: ShiyingSummarySourceV3[] = [];
  for (const material of plan.materials) {
    const own = refs.filter(value => value.kind === material.kind && value.id === material.id); if (!own.length) continue;
    const sources = plan.rootSources.find(value => value.kind === material.kind && value.id === material.id)!.sources;
    if (material.kind === 'summary') {
      roots.push(...sources); inputs.push({ kind: 'summary', id: material.id, summaryKind: plan.kind === 'month' ? 'week' : 'month',
        periodStartLifeDate: material.periodStart!, periodEndLifeDate: material.periodEnd!, contentHash: material.materialHash,
        textRanges: mergeRanges(own.filter(value => value.component === 'body').map(value => value.range)),
        noteRanges: mergeRanges(own.filter(value => value.component === 'note').map(value => value.range)), sources });
    } else if (material.kind === 'event_node') {
      roots.push(...sources); inputs.push({ kind: 'event_node', id: material.id, eventId: material.eventId!, eventDate: material.date,
        title: material.title!, contentHash: material.materialHash, textRanges: mergeRanges(own.map(value => value.range)), sources });
    } else roots.push({ ...sources[0], textRanges: mergeRanges(own.filter(value => value.component === 'body').map(value => value.range)),
      imageNoteRanges: mergeRanges(own.filter(value => value.component === 'image_note').map(value => value.range)) });
  }
  const sources = mergeSources(roots).map(source => {
    const order = plan.recordImageOrders?.find(value => value.recordId === source.id)?.imageIds;
    if (source.kind === 'record' && order && source.imageIds.some(id => !order.includes(id))) fail('source_conflict');
    return source.kind === 'record' && order ? { ...source, imageIds: order.filter(id => source.imageIds.includes(id)) } : source;
  });
  return { sources, inputSources: inputs, imageCoverage: plan.imageCoverage };
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('output_object'); const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) fail('output_fields'); return result;
}
function outputText(value: unknown, maximum: number) { if (typeof value !== 'string' || !value.trim() || value.length > maximum) return fail('output_text'); return value.trim(); }
export function parseShiyingPeriodReviewModelResult(raw: string, input: { plan: PeriodReviewPlan; visible: string[]; reading: boolean }): PeriodReviewModelResult {
  let value: unknown; try { value = parseShiyingModelJson(raw); } catch { return fail('output_json'); }
  const root = object(value, [input.reading ? 'notes' : 'review']);
  const sources = (value: unknown) => {
    if (!Array.isArray(value) || !value.length || value.some(label => typeof label !== 'string') || new Set(value).size !== value.length) return fail('output_sources');
    resolveRefs(input.plan, value, input.visible); return value as string[];
  };
  if (input.reading) {
    if (!Array.isArray(root.notes) || !root.notes.length) return fail('empty_notes');
    return { notes: root.notes.map(value => { const row = object(value, ['text', 'sources']); return { text: outputText(row.text, 8000), sources: sources(row.sources) }; }) };
  }
  const row = object(root.review, ['title', 'factSummary', 'baiyunNote', 'sources']); const title = outputText(row.title, 200);
  if (/[\r\n]/u.test(title)) fail('output_title'); const limit = input.plan.kind === 'month' ? 64000 : 128000;
  return { review: { title, factSummary: outputText(row.factSummary, limit), baiyunNote: outputText(row.baiyunNote, limit), sources: sources(row.sources) } };
}
export function collectShiyingPeriodReviewFinalVisible(plan: PeriodReviewPlan, results: Array<{ visible: string[]; resultJson: string }>) {
  const keys = new Set<string>();
  for (const value of results) {
    const parsed = parseShiyingPeriodReviewModelResult(value.resultJson, { plan, visible: value.visible, reading: true });
    for (const note of parsed.notes!) resolveRefs(plan, note.sources, value.visible).forEach(ref => keys.add(ref.key));
  }
  return plan.refs.filter(ref => keys.has(ref.key)).map(ref => ref.key);
}
export function buildShiyingPeriodReviewFinalMaterial(plan: PeriodReviewPlan, results: string[]) {
  if (plan.direct || results.length !== plan.chunks.length) fail('reading_incomplete');
  results.forEach((json, index) => parseShiyingPeriodReviewModelResult(json, { plan, visible: plan.chunks[index], reading: true }));
  return [`周期：${plan.periodStart}～${plan.periodEnd}`, plan.kind === 'month' ? SHIYING_MONTH_REVIEW_FINAL_MATERIAL : SHIYING_YEAR_REVIEW_FINAL_MATERIAL,
    ...results.map((json, index) => `【I｜第 ${index + 1} 段阅读笔记】\n${json}`)].join('\n\n');
}
