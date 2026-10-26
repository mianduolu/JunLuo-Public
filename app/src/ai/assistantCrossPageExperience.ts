import type { LetterEntry } from '../letters/letterStore';
import type { BaiyunPostComment } from '../posts/baiyunPostContract';
import { knownPostCommentLine, postExperienceBody, postExperienceHeader, postMaterialKey, postReadRef, type PostKnownMaterial } from '../posts/baiyunPostReading';
import type { VoiceCallTurnRecord, VoiceCallRecordDirection } from '../voiceCall/voiceCallRecord';
import { formatChatAfterglowMessageTime as time } from '../chat/chatAfterglowProbe';
import { innerMaterialKey } from '../chat/chatAfterglowState';
import type { SharedExperienceCandidate, SharedExperienceProgress, SharedExperienceRef } from './assistantSharedExperienceMaterial';
import type { GiftCrossPageSource } from '../gifts/giftCrossPageSource';

export type CrossPageSource =
  | { kind: 'post'; id: string; content: string; createdAt: number; comments: BaiyunPostComment[]; known?: PostKnownMaterial }
  | { kind: 'call'; id: string; startedAt: number; endedAt: number; direction: VoiceCallRecordDirection; turns: VoiceCallTurnRecord[] }
  | GiftCrossPageSource
  | (Omit<LetterEntry, 'kind'> & { kind: 'letter' });
export type CrossPageBlock = { text: string; role?: 'I' | 'you'; at?: number; label?: string };
export type CrossPageDocument = { header: string; blocks: CrossPageBlock[] };
export type ExperienceSegments = { ends: number[]; index: number };
export const isCrossPageExperience = (kind: string) => ['post', 'call', 'letter', 'gift'].includes(kind);
export const CHAT_OWNED_LETTER = 'chat-owned';
const nonempty = (text: string | undefined): text is string => !!text?.trim();

function rounds<T extends { role: 'I' | 'you' }>(messages: T[], keepUnanswered: boolean) {
  const result: T[][] = [];
  let current: T[] = [], replied = false;
  for (const message of messages) {
    if (message.role === 'you') {
      if (replied) { result.push(current); current = []; replied = false; }
      current.push(message);
    } else if (current.length) { current.push(message); replied = true; }
  }
  if (replied || keepUnanswered && current.length) result.push(current);
  return result;
}

export function renderCrossPageDocument(document: CrossPageDocument, segments?: ExperienceSegments) {
  let offset = 0;
  const from = segments && segments.index ? segments.ends[segments.index - 1] : 0;
  const through = segments ? segments.ends[segments.index] : Infinity;
  const body = document.blocks.flatMap(block => {
    const begin = offset; offset += block.text.length;
    const content = block.text.slice(Math.max(0, from - begin), Math.max(0, Math.min(block.text.length, through - begin)));
    if (!content) return [];
    return [block.role ? JSON.stringify({ role: block.role, time: time(block.at!), content })
      : `${block.label ? `${block.label}\n` : ''}${content}`];
  }).join('\n\n');
  const note = segments ? `\n\n这段经历较长，现在读的是第 ${segments.index + 1} 段，共 ${segments.ends.length} 段。` : '';
  return `${document.header}${note}\n\n${body}`;
}

/** Boundaries refer to original text only. No source text is persisted a second time. */
export async function splitCrossPageDocument(document: CrossPageDocument,
  fits: (material: string) => Promise<boolean>, previous?: ExperienceSegments): Promise<ExperienceSegments | null> {
  const text = document.blocks.map(block => block.text).join('');
  if (!text.length) return null;
  const preferred: number[] = [];
  let offset = 0;
  for (const block of document.blocks) {
    for (const match of block.text.matchAll(/[。！？!?\n]+/g)) preferred.push(offset + match.index! + match[0].length);
    offset += block.text.length; preferred.push(offset);
  }
  const ends: number[] = previous ? previous.ends.slice(0, previous.index) : [];
  let from = ends.at(-1) ?? 0;
  while (from < text.length) {
    let low = from + 1, high = text.length, best = from;
    // A conservative digit-width placeholder keeps the final part-count header within capacity.
    const material = (end: number) => renderCrossPageDocument(document,
      { ends: [from, end, text.length], index: 1 }).replace('第 2 段，共 3 段', `第 ${text.length} 段，共 ${text.length} 段`);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (await fits(material(middle))) { best = middle; low = middle + 1; } else high = middle - 1;
    }
    if (best === from) return null; // Even the unchanged prefix/header cannot fit.
    const boundary = preferred.filter(end => end > from && end <= best).at(-1);
    if (boundary !== undefined) best = boundary;
    if (best < text.length && /[\uD800-\uDBFF]/.test(text[best - 1])) best--;
    if (best <= from) return null;
    ends.push(best); from = best;
  }
  return { ends, index: previous?.index ?? 0 };
}

type Unit = { ref: SharedExperienceRef; eligibleAt: number; blocks: CrossPageBlock[]; entries?: Unit[] };
function sourceUnits(source: CrossPageSource): { header: string; prefix: CrossPageBlock[]; units: Unit[] } {
  const make = (kind: SharedExperienceRef['kind'], id: string, at: number, blocks: CrossPageBlock[], facts: unknown,
    eligibleAt = at): Unit => ({ ref: { kind, id, createdAt: at, ownerId: source.id,
      revision: innerMaterialKey([facts, blocks]) }, eligibleAt, blocks });
  if (source.kind === 'gift') return { header: '【这份礼物里发生过的事】', prefix: [],
    units: source.events.map(event => make('gift-event', event.id, event.at,
      [{ text: JSON.stringify(event.facts) }, ...event.messages], [source.revision, event.facts])) };
  if (source.kind === 'post') {
    if (source.known) {
      const known = source.known, header = postExperienceHeader(known.post);
      const prefix = [{ text: postExperienceBody(known) }];
      const units = known.readings.flatMap(reading => {
        const fresh = reading.added.filter(ref => {
          const item = ref.source === null ? known.post : known.comments.find(line => line.source === ref.source);
          if (!item) return false;
          const current = postReadRef(item, known.images);
          return (item.author === 'I' || current.revision === ref.revision)
            && (item.author === 'you' || !!ref.image && current.image === ref.image);
        });
        if (!fresh.length) return [];
        const ids = new Set(fresh.map(ref => ref.source));
        const latest = known.readings.filter(item => item.source === reading.source).at(-1) === reading;
        const lines = known.comments.filter(line => ids.has(line.source) || latest && line.author === 'I' && line.source === reading.source);
        const blocks = lines.map(line => ({ text: knownPostCommentLine(line, known.images) }));
        return [make('post-exchange', `${source.id}:read:${postMaterialKey([reading.source, reading.added])}`, reading.at,
          blocks, [header, prefix, fresh])];
      });
      return { header, prefix, units };
    }
    const comments = source.comments.filter(item => nonempty(item.content)).map(item => ({ ...item, role: item.author }))
      .sort((a, b) => a.createdAt - b.createdAt || a.source.localeCompare(b.source));
    return { header: `【动态下面聊过的话】\n\n动态发表时间：${time(source.createdAt)}`,
      prefix: [{ label: 'I 的动态：', text: source.content }],
      units: rounds(comments, false).map(round => {
        const entries = round.map(item => make('post-exchange', `${source.id}:${item.source}`, item.createdAt,
          [{ role: item.role, at: item.createdAt, text: item.content }], [source.createdAt, source.content, item.source]));
        return { ...entries.at(-1)!, entries };
      }) };
  }
  if (source.kind === 'call') {
    const turns = source.direction === 'test' ? [] : source.turns.filter(item => nonempty(item.text)
      && item.at >= source.startedAt && item.at <= source.endedAt
      && (item.role === 'you' && item.transcriptStatus === 'ok' || item.role === 'I' && item.delivery === 'completed'));
    const entries = turns.map(item => make('call-round', `${source.id}:${item.role}:${item.turnId}`, source.endedAt,
      [{ role: item.role, at: item.at, text: item.text }], [source.startedAt, source.endedAt, item.turnId]));
    return { header: `【这通电话里说过的话】\n\n通话开始时间：${time(source.startedAt)}\n通话结束时间：${time(source.endedAt)}`,
      // The completed call is one experience; only dynamic comments have a six-round batch limit.
      prefix: [], units: turns.some(turn => turn.role === 'you') ? [{ ...entries.at(-1)!, entries }] : [] };
  }
  const at = source.direction === 'you-to-ai' ? source.deliveredAt : source.completedAt;
  const complete = source.status === 'completed' && source.direction !== 'ai-to-future-you'
    && nonempty(source.content) && nonempty(source.replyContent) && at !== undefined;
  return { header: `【这次往返信件】${nonempty(source.title) ? `\n\n信件标题：${source.title}` : ''}`, prefix: [],
    units: complete ? [make('letter-exchange', source.id, at!, [
      { role: source.direction === 'you-to-ai' ? 'you' : 'I', at: source.createdAt, text: source.content },
      { role: source.direction === 'you-to-ai' ? 'I' : 'you', at: at!, text: source.replyContent! },
    ], [source.id, source.direction, source.createdAt, at])] : [] };
}

export function selectCrossPageCandidates(sources: CrossPageSource[], progress: SharedExperienceProgress,
  now: number, maxUnits = 6): SharedExperienceCandidate[] {
  if (progress.crossPageActivatedAt === undefined) return [];
  return sources.flatMap(source => {
    const { header, prefix, units } = sourceUnits(source);
    const unseen = (unit: Unit) => progress.processed[`${unit.ref.kind}:${unit.ref.id}`] === undefined;
    const selected = units.filter(unit => unit.eligibleAt > progress.crossPageActivatedAt!
      && unit.eligibleAt <= now && (unit.entries
        ? unit.entries.some(item => unseen(item) && (source.kind !== 'post' || item.blocks[0].role === 'I')) : unseen(unit)))
      .slice(0, Math.max(1, Math.min(6, maxUnits)));
    if (!selected.length) return [];
    const entries = selected.flatMap(unit => unit.entries ?? [unit]).filter(unseen);
    const document = { header, blocks: [...prefix, ...entries.flatMap(unit => unit.blocks)] };
    return [{ kind: source.kind, ownerId: source.id, refs: entries.map(unit => unit.ref),
      fromAt: selected[0].eligibleAt, throughAt: selected.at(-1)!.eligibleAt,
      ...(source.kind === 'letter' ? { chatMessageIds: source.chatMessageIds ?? [] } : {}),
      document, material: renderCrossPageDocument(document) }];
  }).sort((a, b) => a.fromAt - b.fromAt || a.ownerId.localeCompare(b.ownerId));
}

export function rebuildCrossPageCandidate(sources: CrossPageSource[], candidate: Omit<SharedExperienceCandidate, 'material' | 'document'>,
  allowChanged = false): SharedExperienceCandidate | null {
  const source = sources.find(item => item.kind === candidate.kind && item.id === candidate.ownerId);
  if (!source) return null;
  const { header, prefix, units } = sourceUnits(source);
  const entries = units.flatMap(unit => unit.entries ?? [unit]);
  const selected = candidate.refs.map(ref => entries.find(unit => unit.ref.id === ref.id && unit.ref.kind === ref.kind));
  if (!allowChanged && selected.some((unit, index) => !unit || unit.ref.revision !== candidate.refs[index].revision
    || unit.ref.createdAt !== candidate.refs[index].createdAt)) return null;
  const remaining = selected.filter((unit): unit is Unit => !!unit);
  if (!remaining.length) return null;
  const document = { header, blocks: [...prefix, ...remaining.flatMap(unit => unit.blocks)] };
  return { ...candidate, refs: remaining.map(unit => unit.ref), document, material: renderCrossPageDocument(document) };
}

export async function loadCrossPageSources(progress?: SharedExperienceProgress,
  owner?: { kind: string; ownerId: string }): Promise<CrossPageSource[]> {
  if (!owner && progress?.crossPageActivatedAt === undefined) return [];
  const sources: CrossPageSource[] = [];
  if (!owner || owner.kind === 'post') {
    const { loadKnownPostMaterials } = await import('../posts/baiyunPostKnown');
    for (const known of await loadKnownPostMaterials(owner?.ownerId)) sources.push({ ...known.post, kind: 'post', known,
      comments: known.comments.map(line => ({ ...line, id: line.storageId })) });
  }
  if (!owner || owner.kind === 'call') {
    const chat = await import('../chat/chatStorage');
    const { sessions } = await chat.loadChatStateFast({ activeMessageLimit: 1 });
    for (const session of sessions) {
      const order = await chat.loadChatSessionMessageOrder(session.id);
      for (const ref of order.filter(item => item.id.startsWith('voice-call-record-')
        && (owner ? item.id === `voice-call-record-${owner.ownerId}` : item.createdAt > progress!.crossPageActivatedAt!))) {
        const record = (await chat.loadChatSessionMessage(session.id, ref.id))?.voiceCallRecord;
        if (record) sources.push({ ...record, kind: 'call', id: record.callId });
      }
    }
  }
  if (!owner || owner.kind === 'letter') {
    const { loadLetters } = await import('../letters/letterStore');
    for (const letter of await loadLetters()) if (letter.kind === 'exchange' && (!owner || letter.id === owner.ownerId))
      sources.push({ ...letter, kind: 'letter' });
  }
  if (!owner || owner.kind === 'gift') {
    const { loadGiftCrossPageSources } = await import('../gifts/giftCrossPageSource');
    sources.push(...await loadGiftCrossPageSources(owner?.ownerId));
  }
  return sources;
}

/** Chat copies stay visible, but a cross-page-owned exchange has only one numeric consumer. */
export async function crossPageChatExclusions(progress?: SharedExperienceProgress): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (progress?.crossPageActivatedAt === undefined) return excluded;
  const { loadLetters } = await import('../letters/letterStore');
  for (const letter of await loadLetters()) {
    if (letter.kind !== 'exchange' || progress.processed[`letter-exchange:${letter.id}`] === CHAT_OWNED_LETTER) continue;
    // Reserve new exchange copies even before the reply arrives, so the original
    // cannot first be consumed with unrelated main-chat replies and then again here.
    const at = (letter.direction === 'you-to-ai' ? letter.deliveredAt : letter.completedAt)
      ?? letter.deliveredAt ?? letter.createdAt;
    if (at === undefined || at <= progress.crossPageActivatedAt) continue;
    for (const id of letter.chatMessageIds ?? []) excluded.add(id);
    // New deterministic IDs are also recognizable before the receipt write finishes.
    excluded.add(`letter-${letter.id}-original`); excluded.add(`letter-${letter.id}-reply`);
  }
  return excluded;
}
