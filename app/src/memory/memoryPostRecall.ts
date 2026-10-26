import { listPostRecallSnapshots, loadPostRecallSnapshot, type PostRecallSnapshot, type PostRecallSource } from '../posts/baiyunPostRecallSource';
import type { PostMaterialBinding } from '../posts/baiyunPostMemorySource';
import type { PostDerivedReader } from '../posts/baiyunPostMemoryBasis';
import { knownPostImageLine } from '../posts/baiyunPostReading';
import { scoreMemoryForRecall } from './memoryRecallScoring';
import type { PostReadReference } from './memoryReadReference';

export type PostRecallHit = { sourceId: string; sourceHash?: string; start: number; end: number; score: number };
export type PostRecallCandidate = { snapshot: PostRecallSnapshot; textScore: number; semanticScore: number; hits: PostRecallHit[]; excludedRanges?: PostMaterialBinding[] };
export type PostRecallSelection = { items: PostRecallCandidate[]; failure?: 'source_unavailable' | 'read_failed' };
export type PostSourceRangeMap = ReadonlyMap<string, { sourceHash: string; start: number; end: number }>;

function scored(source: PostRecallSource, snapshot: PostRecallSnapshot, query: string, semantic = 0) {
  return scoreMemoryForRecall({ id: source.messageId, title: '', content: [source.content,
    ...(source.kind === 'post' ? snapshot.material.tags : [])].join('\n'), domain: '日常',
    tags: [], recallCues: [], importance: 5, confidence: 1,
    pinned: false, protected: false, anchor: false, resolved: false, tier: 'working', semanticType: 'other', activationCount: 0, lastActiveAt: 0 },
  query, { semanticScores: new Map([[source.messageId, semantic]]) });
}
function terms(query: string) {
  return [...new Set([query.trim(), ...(query.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/giu) ?? [])])].filter(Boolean);
}
function localHits(source: PostRecallSource, query: string, score: number): PostRecallHit[] {
  const lower = source.content.toLocaleLowerCase(), hits: PostRecallHit[] = [];
  const direct = terms(query);
  for (const term of direct) {
    let from = 0;
    for (;;) {
      const start = lower.indexOf(term.toLocaleLowerCase(), from);
      if (start < 0) break;
      hits.push({ sourceId: source.messageId, sourceHash: source.sourceVersion, start, end: start + term.length, score });
      from = start + Math.max(1, term.length);
      if (hits.length >= 24) return hits;
    }
  }
  if (!hits.length) for (const term of direct) if (/\p{Script=Han}/u.test(term)) {
    for (let index = 0; index < term.length - 1; index++) {
      const start = lower.indexOf(term.slice(index, index + 2).toLocaleLowerCase());
      if (start >= 0) hits.push({ sourceId: source.messageId, sourceHash: source.sourceVersion, start, end: start + 2, score });
    }
  }
  return hits;
}
export function scorePostText(snapshot: PostRecallSnapshot, query: string) {
  return Math.max(0, ...snapshot.sources.map(source => { const result = scored(source, snapshot, query); return result.admitted ? result.textScore : 0; }));
}
export async function postRecallCandidates(selection?: PostRecallSelection, signal?: AbortSignal, readOnly?: boolean) {
  if (!selection) return [];
  try { const snapshots = await listPostRecallSnapshots({ signal, readOnly }); selection.failure = undefined; return snapshots; }
  catch (error) {
    if (signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error;
    selection.items = []; selection.failure = 'read_failed'; return [];
  }
}
export function selectPostRecall(selection: PostRecallSelection | undefined, snapshots: PostRecallSnapshot[], query: string,
  semantic: ReadonlyMap<string, number> = new Map(), ranges: PostSourceRangeMap = new Map()) {
  if (!selection) return;
  selection.items = snapshots.flatMap(snapshot => {
    let textScore = 0, semanticScore = 0;
    const hits: PostRecallHit[] = [];
    for (const source of snapshot.sources) {
      const range = ranges.get(source.messageId);
      const vector = range && range.sourceHash !== source.sourceVersion ? 0 : semantic.get(source.messageId) ?? 0;
      const result = scored(source, snapshot, query, vector);
      if (!result.admitted) continue;
      textScore = Math.max(textScore, result.textScore); semanticScore = Math.max(semanticScore, vector);
      const lexical = localHits(source, query, result.score);
      hits.push(...lexical);
      if (vector >= 0.62 && range && range.sourceHash === source.sourceVersion
        && Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= source.content.length) {
        hits.push({ sourceId: source.messageId, ...range, score: result.score });
      } else if (!lexical.length) hits.push({ sourceId: source.messageId, sourceHash: source.sourceVersion,
        start: 0, end: source.content.length, score: result.score });
    }
    return hits.length ? [{ snapshot, textScore, semanticScore, hits: hits.sort((a, b) => b.score - a.score) }] : [];
  }).sort((a, b) => b.textScore + b.semanticScore - a.textScore - a.semanticScore
    || b.snapshot.material.post.createdAt - a.snapshot.material.post.createdAt || a.snapshot.postId.localeCompare(b.snapshot.postId));
}
export function postReadReference(post: PostRecallSnapshot, hits: readonly PostRecallHit[] = [], excludedRanges: readonly PostMaterialBinding[] = []): PostReadReference {
  return { targetKind: 'post', post, version: post.materialHash, hits: [...hits], excludedRanges: [...excludedRanges] };
}

function reliableRanges(source: PostRecallSource, bindings: readonly PostMaterialBinding[]) {
  return bindings.filter(binding => binding.sessionId === source.sessionId && binding.messageId === source.messageId
    && binding.sourceHash === source.sourceHash && Number.isInteger(binding.start) && Number.isInteger(binding.end)
    && binding.start >= 0 && binding.end <= source.content.length && binding.end > binding.start);
}
function subtractRanges(range: { start: number; end: number }, bindings: readonly Pick<PostMaterialBinding, 'start' | 'end'>[]) {
  let remaining = [range];
  for (const binding of bindings) remaining = remaining.flatMap(part => binding.end <= part.start || binding.start >= part.end ? [part]
    : [{ start: part.start, end: Math.min(binding.start, part.end) }, { start: Math.max(binding.end, part.start), end: part.end }].filter(part => part.end > part.start));
  return remaining;
}

/** Only exact confirmed ranges are removed; sharing a parent never removes another topic. */
export function postRecallWithoutConfirmedRanges(candidate: PostRecallCandidate, bindings: readonly PostMaterialBinding[]): PostRecallCandidate | null {
  const excludedRanges = [...new Map([...candidate.excludedRanges ?? [], ...bindings]
    .filter(binding => candidate.snapshot.sources.some(source => reliableRanges(source, [binding]).length))
    .map(binding => [JSON.stringify([binding.sessionId, binding.messageId, binding.sourceHash, binding.start, binding.end]), binding])).values()];
  const hits = candidate.hits.flatMap(hit => {
    const source = candidate.snapshot.sources.find(source => source.messageId === hit.sourceId);
    if (!source) return [];
    const remaining = subtractRanges({ start: hit.start, end: hit.end }, reliableRanges(source, excludedRanges));
    return remaining.map(range => ({ ...hit, ...range }));
  });
  return hits.length ? { ...candidate, hits, excludedRanges } : null;
}
export async function preferConfirmedPostMemories(selection: PostRecallSelection, memories: readonly { id: string }[], database?: PostDerivedReader) {
  if (!selection.items.length || !memories.length) return;
  const db = database ?? await (await import('./memoryStore')).getMemoryDatabase();
  const inspected = await (await import('../posts/baiyunPostMemoryBasis')).inspectPostDerivedTargets(db,
    memories.map(memory => ({ kind: 'memory' as const, id: memory.id })));
  const bindings = inspected.filter(target => target.status === 'current').flatMap(target => target.bindings);
  selection.items = selection.items.flatMap(candidate => postRecallWithoutConfirmedRanges(candidate, bindings) ?? []);
}

function wholeEnd(text: string, end: number) {
  return end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end] ?? '') ? end - 1 : end;
}
function time(at: number) { return new Date(at).toLocaleString('zh-CN', { hour12: false }); }

/** The approved wrapper and selected original characters share the existing material budget. */
export function formatPostRecallMaterial(snapshot: PostRecallSnapshot, number: number | string, limit = 1000, query = '', hits: readonly PostRecallHit[] = [], excludedRanges: readonly PostMaterialBinding[] = []) {
  const { post, comments, images, tags } = snapshot.material;
  const rows = [post, ...comments].map(item => {
    const source = snapshot.sources.find(source => source.messageId === ('source' in item ? `comment:${post.id}:${item.source}` : `post:${post.id}`));
    const hit = hits.find(hit => hit.sourceId === source?.messageId && (!hit.sourceHash || hit.sourceHash === source.sourceVersion));
    const bodyOffset = !('source' in item) && post.title ? post.title.length + 2 : 0;
    const lexical = source ? localHits(source, query, 1)[0] : undefined;
    const rawOffset = hit?.start ?? lexical?.start ?? bodyOffset;
    const offset = rawOffset >= bodyOffset && rawOffset < bodyOffset + item.content.length ? rawOffset : bodyOffset;
    const excluded = source ? reliableRanges(source, excludedRanges) : [];
    const allowed = subtractRanges({ start: bodyOffset, end: bodyOffset + item.content.length }, excluded)
      .map(range => {
        let start = range.start - bodyOffset;
        if (start > 0 && /[\uDC00-\uDFFF]/u.test(item.content[start] ?? '') && /[\uD800-\uDBFF]/u.test(item.content[start - 1])) start++;
        return { start: bodyOffset + start, end: bodyOffset + wholeEnd(item.content, range.end - bodyOffset) };
      })
      .filter(range => range.end > range.start);
    const bound = allowed.find(range => range.start <= offset && range.end > offset)
      ?? allowed.find(range => hit && range.start < hit.end && range.end > hit.start) ?? allowed[0];
    let start = bound ? Math.max(bound.start, Math.min(offset, bound.end - 1) - 24) - bodyOffset : 0;
    if (start > 0 && /[\uDC00-\uDFFF]/u.test(item.content[start] ?? '') && /[\uD800-\uDBFF]/u.test(item.content[start - 1])) start++;
    return { item, source, hit, excluded, bound: bound ? { start: bound.start - bodyOffset, end: bound.end - bodyOffset } : null,
      range: { start, end: 0 }, image: '' };
  });
  const primary = rows.find(row => row.source?.messageId === hits[0]?.sourceId && row.hit)
    ?? rows.find(row => row.hit) ?? rows.find(row => row.source && localHits(row.source, query, 1).length) ?? rows[0];
  let title = post.title?.trim() ? `标题：${post.title}\n` : '', tagLine = tags.length ? `tag：${tags.join('、')}\n` : '';
  const render = () => {
    const header = `[记忆 ${number}]【I 想起的一条动态】\n\n聊到这里，I 忽然想起了这条动态。\n\n发布者：${post.author}\n发布时间：${time(post.createdAt)}\n${title}${tagLine}`;
    const lines = rows.flatMap((row, index) => {
      const { item, range } = row;
      const text = range.end > range.start ? item.content.slice(range.start, range.end) : '';
      if (!text && !row.image) return [];
      const label = `${index ? '留言' : '正文'}（${range.start === 0 && range.end === item.content.length ? '全文' : '片段'}）：`;
      return [(index ? `${time(item.createdAt)} ${item.author}：\n` : '') + (text ? label + text : '') + (row.image ? `${text ? '\n' : ''}${row.image}` : '')];
    });
    const postLine = rows[0].range.end > rows[0].range.start || rows[0].image ? lines.shift() : undefined;
    return header + (postLine ?? '') + (lines.length ? `${postLine ? '\n\n' : ''}【相关评论】\n${lines.join('\n\n')}` : '');
  };
  if (render().length >= limit) { tagLine = ''; if (render().length >= limit) title = ''; }
  const grow = (row: typeof rows[number], desired: number) => {
    if (!row.item.content || !row.bound) return;
    row.range.start = Math.min(row.range.start, row.bound.end - 1);
    const previous = row.range.end;
    let low = Math.max(0, previous - row.range.start), high = Math.min(row.bound.end - row.range.start, desired);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      row.range.end = wholeEnd(row.item.content, row.range.start + middle);
      if (render().length <= limit) low = middle; else high = middle - 1;
    }
    row.range.end = low ? wholeEnd(row.item.content, row.range.start + low) : previous;
  };
  grow(primary, Math.max(0, Math.floor((limit - render().length) * 0.72)));
  if (primary !== rows[0]) grow(rows[0], 80);
  const index = rows.indexOf(primary);
  if (index > 1) grow(rows[index - 1], 80);
  if (index + 1 < rows.length) grow(rows[index + 1], 80);
  grow(primary, primary.item.content.length);
  for (const row of rows) {
    const image = knownPostImageLine(row.item, images);
    if (!image || !row.item.imageGroup || !images[row.item.imageGroup.id]) continue;
    const imageStart = row.source?.content.lastIndexOf(image) ?? -1;
    // The existing image format is whole: a partially covered image is not reintroduced as a prefix.
    if (imageStart < 0 || row.excluded.some(range => range.start < imageStart + image.length && range.end > imageStart)) continue;
    row.image = image;
    if (render().length > limit) row.image = '';
  }
  const content = render();
  return content.length <= limit && rows.some(row => row.range.end > row.range.start || row.image) ? content : '';
}

export type PostRecallRefreshState = { current: PostRecallSnapshot | null; refreshed: boolean; failure?: 'read_failed' };
export function createPostRecallRefresh(initial: PostRecallSnapshot, query: string,
  state: PostRecallRefreshState = { current: initial, refreshed: false }, readOnly?: boolean) {
  return async () => {
    if (!state.current) return null;
    let latest: PostRecallSnapshot | null;
    try { latest = await loadPostRecallSnapshot(initial.postId, { readOnly }); }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      state.failure = 'read_failed'; return state.current = null;
    }
    if (!latest) return state.current = null;
    if (latest.materialHash !== state.current.materialHash) {
      if (state.refreshed || scorePostText(latest, query) <= 0) return state.current = null;
      state.refreshed = true; state.current = latest;
    }
    return state.current;
  };
}
