import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import { formatReadingOrganizationDate, takeReadingPunctuationPrefix } from '../reading/readingMemoryOrganizationProtocol';
import type { WebVoyageLogEntry } from './webVoyage';
import type { JunluoInnerThoughtV2 } from './junluoInnerState';

export type LifeSelfSourceKind = 'exploration' | 'wish';
export type LifeSelfSource = {
  kind: LifeSelfSourceKind; id: string; sessionId: string; message: SubjectiveMessage;
  sourceHash: string; occurrenceKey: string; authoredContent: string; body: string;
  query?: string; reason?: string; title?: string; url?: string;
  newExploration?: boolean;
  wishOrigin?: { sourceKind: string; sourceId: string };
};
export type LifeSelfBinding = {
  kind: LifeSelfSourceKind; id: string; sessionId: string; messageId: string;
  sourceHash: string; start: number; end: number; sentHash: string; reference: string;
};
export type PreparedLifeSelfMaterial = {
  source: LifeSelfSource; binding: LifeSelfBinding; message: SubjectiveMessage; content: string;
};
export const LIFE_SELF_MATERIAL_CHARACTER_LIMIT = 6000;
const PREFIX = 'life-self-v1:';
function invalid(): never { throw new Error('LIFE_SELF_MEMORY_SOURCE_INVALID'); }
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function validTime(value: number) { return Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime()); }

export function lifeSelfSessionId(kind: LifeSelfSourceKind, id: string) {
  if ((kind !== 'exploration' && kind !== 'wish') || typeof id !== 'string' || !id.trim()) return invalid();
  return `${PREFIX}${kind}:${encodeURIComponent(id)}`;
}
export function parseLifeSelfMemorySource(sessionId: string): { kind: LifeSelfSourceKind; id: string } | null {
  const match = /^life-self-v1:(exploration|wish):(.+)$/.exec(sessionId);
  if (!match) return null;
  try {
    const kind = match[1] as LifeSelfSourceKind, id = decodeURIComponent(match[2]);
    return id.trim() && lifeSelfSessionId(kind, id) === sessionId ? { kind, id } : null;
  } catch { return null; }
}
/** Malformed source identifiers still belong here; never fall through to chat storage. */
export function isLifeSelfMemorySource(sessionId: string) { return sessionId.startsWith(PREFIX); }
export function lifeSelfOccurrenceKey(sessionId: string) {
  const identity = parseLifeSelfMemorySource(sessionId);
  return identity ? lifeSelfSessionId(identity.kind, identity.id) : null;
}
export function lifeSelfMessageId(kind: LifeSelfSourceKind, id: string) {
  lifeSelfSessionId(kind, id);
  return `life-self-${kind}-${encodeURIComponent(id)}`;
}

function referenceFits(source: Pick<LifeSelfSource, 'kind'>, reference: string) {
  return (source.kind === 'exploration' ? /^E[1-9]\d*$/ : /^W[1-9]\d*$/).test(reference);
}
function atBoundary(body: string, offset: number) {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= body.length
    && (offset === 0 || offset === body.length || takeReadingPunctuationPrefix(body, offset).length === offset);
}
function render(source: LifeSelfSource, start: number, end: number, reference: string) {
  if (!referenceFits(source, reference) || !atBoundary(source.body, start) || !atBoundary(source.body, end)
    || end <= start) return invalid();
  const date = formatReadingOrganizationDate(source.message.createdAt);
  const body = source.body.slice(start, end);
  if (source.kind === 'wish') return `【I 当时的愿望｜${reference}｜${date}】\n${body}`;
  const location = [source.title, source.url].filter(Boolean).join(' ');
  return [`【I 的一次探索｜${reference}｜${date}】`,
    source.query ? `查找内容：${source.query}` : '', source.reason ? `探索原因：${source.reason}` : '',
    location ? `网页来源：${location}` : '', `网页正文摘录：${body}`].filter(Boolean).join('\n');
}

function finish(input: Omit<LifeSelfSource, 'message'>, createdAt: number): LifeSelfSource {
  if (!validTime(createdAt) || !input.body.trim()) return invalid();
  const source = { ...input, message: { id: lifeSelfMessageId(input.kind, input.id), role: 'I' as const,
    createdAt, content: '', source: 'life-message' as const } };
  // This is the owned source record, never a newly fabricated chat utterance.
  source.message.content = render(source, 0, source.body.length, input.kind === 'exploration' ? 'E1' : 'W1');
  return source;
}
export function makeLifeSelfExplorationSource(entry: WebVoyageLogEntry): LifeSelfSource | null {
  if (entry.status !== 'completed' || entry.readingStatus !== 'body_excerpt' || !optionalText(entry.summary)) return null;
  if (!entry.id || !validTime(entry.at)) return invalid();
  const fields = { query: optionalText(entry.query), reason: optionalText(entry.driveReason),
    title: optionalText(entry.title), url: optionalText(entry.url) };
  const sessionId = lifeSelfSessionId('exploration', entry.id);
  return finish({ kind: 'exploration', id: entry.id, sessionId, ...fields, body: entry.summary!,
    newExploration: (entry as WebVoyageLogEntry & { memoryIngestionVersion?: 1 }).memoryIngestionVersion === 1,
    authoredContent: fields.reason ?? '', occurrenceKey: sessionId,
    sourceHash: stableMemoryHash(JSON.stringify(['exploration', entry.id, entry.at, fields.query ?? null,
      fields.reason ?? null, fields.title ?? null, fields.url ?? null, entry.summary, entry.readingStatus])) }, entry.at);
}
export function makeLifeSelfWishSource(thought: JunluoInnerThoughtV2): LifeSelfSource | null {
  if (!optionalText(thought.content)) return null;
  if (!thought.thoughtId || !thought.sourceId || !thought.sourceKind || !validTime(thought.createdAt)) return invalid();
  const sessionId = lifeSelfSessionId('wish', thought.thoughtId);
  return finish({ kind: 'wish', id: thought.thoughtId, sessionId, body: thought.content,
    authoredContent: thought.content, occurrenceKey: sessionId,
    wishOrigin: { sourceKind: thought.sourceKind, sourceId: thought.sourceId },
    sourceHash: stableMemoryHash(JSON.stringify(['wish', thought.thoughtId, thought.sourceKind,
      thought.sourceId, thought.createdAt, thought.content])) }, thought.createdAt);
}
export function lifeSelfSourceHash(source: LifeSelfSource) { return source.sourceHash; }
export function lifeSelfAuthoredContent(source: LifeSelfSource) { return source.authoredContent; }

async function loadWishSources() {
  // The general loader may migrate or return an empty default on a read error.
  // Evidence reads must be strict and must not write while merely browsing.
  const [{ assistantLifeStateStorageBridge }, { JUNLUO_INNER_STATE_KEYS }, { upgradeJunluoThoughtState }] = await Promise.all([
    import('../sync/syncAssistantLifeStateStorageBridge'), import('./junluoInnerState'), import('./junluoInnerStatePersistence'),
  ]);
  const raw = await assistantLifeStateStorageBridge.getItem(JUNLUO_INNER_STATE_KEYS.thought);
  if (raw === null) return [];
  const state = upgradeJunluoThoughtState(JSON.parse(raw));
  if (!state) throw new Error('LIFE_SELF_WISH_STORAGE_INVALID');
  return state.thoughts.flatMap(thought => {
    const source = makeLifeSelfWishSource(thought);
    return source ? [source] : [];
  });
}
export async function listLifeSelfSources(kind?: LifeSelfSourceKind): Promise<LifeSelfSource[]> {
  const sources: LifeSelfSource[] = [];
  if (kind !== 'wish') {
    for (const entry of await (await import('./webVoyage')).loadWebVoyageLog({ unpruned: true })) {
      const source = makeLifeSelfExplorationSource(entry);
      if (source) sources.push(source);
    }
  }
  if (kind !== 'exploration') sources.push(...await loadWishSources());
  const unique = new Map<string, LifeSelfSource>();
  for (const source of sources) {
    if (unique.has(source.sessionId) && unique.get(source.sessionId)!.sourceHash !== source.sourceHash) return invalid();
    unique.set(source.sessionId, source);
  }
  return [...unique.values()].sort((a, b) => a.message.createdAt - b.message.createdAt || a.sessionId.localeCompare(b.sessionId));
}
export async function loadLifeSelfSource(sessionId: string, messageId?: string) {
  const identity = parseLifeSelfMemorySource(sessionId);
  if (!identity || (messageId !== undefined && messageId !== lifeSelfMessageId(identity.kind, identity.id))) return null;
  return (await listLifeSelfSources(identity.kind)).find(source => source.sessionId === sessionId) ?? null;
}

function bindingFits(source: LifeSelfSource, binding: LifeSelfBinding) {
  return binding.kind === source.kind && binding.id === source.id && binding.sessionId === source.sessionId
    && binding.messageId === source.message.id && binding.sourceHash === source.sourceHash
    && referenceFits(source, binding.reference) && atBoundary(source.body, binding.start)
    && atBoundary(source.body, binding.end) && binding.end > binding.start;
}
export function renderLifeSelfMaterial(source: LifeSelfSource, binding: LifeSelfBinding, reference = binding.reference) {
  if (!bindingFits(source, binding)) return invalid();
  return render(source, binding.start, binding.end, reference);
}
export function prepareLifeSelfFragment(source: LifeSelfSource, start: number, limit: number,
  reference: string): PreparedLifeSelfMaterial | null {
  if (!atBoundary(source.body, start) || !referenceFits(source, reference)) return invalid();
  if (start === source.body.length) return null;
  const budget = Math.min(LIFE_SELF_MATERIAL_CHARACTER_LIMIT, Math.floor(limit)) - 2;
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const full = render(source, start, source.body.length, reference);
  const overhead = full.length - (source.body.length - start);
  const body = takeReadingPunctuationPrefix(source.body.slice(start), budget - overhead);
  if (!body.trim()) return null;
  const end = start + body.length;
  const content = render(source, start, end, reference);
  const binding: LifeSelfBinding = { kind: source.kind, id: source.id, sessionId: source.sessionId,
    messageId: source.message.id, sourceHash: source.sourceHash, start, end, reference,
    sentHash: stableMemoryHash(content) };
  return { source, binding, content, message: { ...source.message, content } };
}
export async function validateLifeSelfBinding(binding: LifeSelfBinding, message?: SubjectiveMessage) {
  const source = await loadLifeSelfSource(binding.sessionId, binding.messageId);
  if (!source || !bindingFits(source, binding)) return false;
  const content = renderLifeSelfMaterial(source, binding);
  return stableMemoryHash(content) === binding.sentHash && (!message || message.id === binding.messageId
    && message.role === 'I' && message.createdAt === source.message.createdAt && message.content === content);
}

