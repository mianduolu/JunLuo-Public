import type { SQLiteDatabase } from 'expo-sqlite';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import type { MemoryCandidateReview } from '../memory/memoryCandidateReview';
import { getMemoryDatabase } from '../memory/memoryStore';
import type { GiftRecord } from './giftTypes';

type Reader = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>;
export type GiftMemoryReadOptions = { database?: Reader };
export type GiftMemoryBinding = { sessionId: string; messageId: string; sourceHash: string; giftHash: string };
export type GiftMemorySource = { sessionId: string; gift: GiftRecord; messages: SubjectiveMessage[];
  bindings: GiftMemoryBinding[]; dataEpoch: number | null };
type GiftRow = { id: string; revision: number; record_json: string };
type EchoRow = { sequence: number; subject: 'I' | 'you'; content: string; created_at: number;
  attachment_id: string | null; original_id: string | null };

export const isGiftMemorySource = (sessionId: string) => sessionId.startsWith('gift-source:');
export const giftMemorySourceSessionId = (gift: Pick<GiftRecord, 'id' | 'revision'>) => `gift-source:${gift.id}:${gift.revision}`;
function version(sessionId: string) {
  const match = /^gift-source:(.+):([1-9]\d*)$/.exec(sessionId);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { id: match[1], revision: Number(match[2]) };
}
const validTime = (at: unknown): at is number => typeof at === 'number' && Number.isSafeInteger(at)
  && at >= 0 && Number.isFinite(new Date(at).getTime());
function openedGift(row: GiftRow | null): GiftRecord | null {
  if (!row) return null;
  const gift = JSON.parse(row.record_json) as GiftRecord;
  if (gift.id !== row.id || gift.revision !== row.revision || !['I', 'you'].includes(gift.sender)
    || gift.deliveryStatus !== 'delivered' || gift.receptionStatus !== 'opened'
    || !validTime(gift.deliveredAt) || !validTime(gift.openedAt)
    || typeof gift.title !== 'string' || typeof gift.note !== 'string' || !Array.isArray(gift.attachments)) return null;
  return gift;
}
function headerHash(gift: GiftRecord) {
  return stableMemoryHash(JSON.stringify({ sender: gift.sender, title: gift.title,
    deliveredAt: gift.deliveredAt, openedAt: gift.openedAt }));
}
/** Same plain-message hash as the existing understanding reader; no new model fields. */
export function giftMemoryMessageHash(sessionId: string, message: SubjectiveMessage) {
  return stableMemoryHash(JSON.stringify({ sessionId, messageId: message.id, role: message.role,
    time: message.createdAt, content: message.content }));
}

/** Reads from the caller's transaction when supplied, never its queued global connection. */
export async function readGiftMemorySource(sessionId: string, options: GiftMemoryReadOptions = {}): Promise<GiftMemorySource | null> {
  const expected = version(sessionId), dataEpoch = captureBackupRestoreDataEpoch();
  if (!expected || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
  const database = options.database ?? await getMemoryDatabase();
  const row = await database.getFirstAsync<GiftRow>('SELECT * FROM gift_records WHERE id = ?', expected.id);
  const gift = openedGift(row);
  if (!gift || gift.revision !== expected.revision) return null;
  const messages: SubjectiveMessage[] = [];
  if (gift.title.trim()) messages.push({ id: 'title', role: gift.sender, content: gift.title, createdAt: gift.deliveredAt! });
  if (gift.note.trim()) messages.push({ id: 'note', role: gift.sender, content: gift.note, createdAt: gift.deliveredAt! });
  const echoes = await database.getAllAsync<EchoRow>(
    'SELECT * FROM gift_echoes WHERE gift_id = ? AND gift_revision = ? ORDER BY sequence', gift.id, gift.revision);
  for (const echo of echoes) {
    if (!['I', 'you'].includes(echo.subject) || typeof echo.content !== 'string' || !echo.content.trim()
      || !validTime(echo.created_at) || !Number.isSafeInteger(echo.sequence) || echo.sequence < 1) continue;
    if (echo.attachment_id && !gift.attachments.some(item => item.id === echo.attachment_id
      && item.kind !== 'url' && item.original.id === echo.original_id)) continue;
    messages.push({ id: `echo:${echo.sequence}`, role: echo.subject, content: echo.content, createdAt: echo.created_at });
  }
  const latest = await database.getFirstAsync<GiftRow>('SELECT * FROM gift_records WHERE id = ?', expected.id);
  if (!canCommitBackupRestoreDataEpoch(dataEpoch) || latest?.record_json !== row!.record_json
    || latest?.revision !== expected.revision) return null;
  const giftHash = headerHash(gift);
  return { sessionId, gift, messages, dataEpoch, bindings: messages.map(message => ({ sessionId,
    messageId: message.id, sourceHash: giftMemoryMessageHash(sessionId, message), giftHash })) };
}

export async function readGiftMemoryMessage(sessionId: string, messageId: string, options: GiftMemoryReadOptions = {}) {
  return (await readGiftMemorySource(sessionId, options))?.messages.find(message => message.id === messageId) ?? null;
}
export async function readGiftMemoryMessages(sessionId: string, options: GiftMemoryReadOptions = {}) {
  return (await readGiftMemorySource(sessionId, options))?.messages ?? [];
}
export async function listGiftMemorySourceSessionIds(options: GiftMemoryReadOptions = {}) {
  const database = options.database ?? await getMemoryDatabase();
  const rows = await database.getAllAsync<GiftRow>(
    "SELECT * FROM gift_records WHERE json_extract(record_json, '$.deliveryStatus') = 'delivered' AND json_extract(record_json, '$.openedAt') IS NOT NULL ORDER BY json_extract(record_json, '$.updatedAt'), id");
  return rows.map(openedGift).filter((gift): gift is GiftRecord => !!gift).map(giftMemorySourceSessionId);
}

export function giftMemorySourceEnvelope(source: GiftMemorySource, messages: readonly SubjectiveMessage[]) {
  return `【这份礼物的来源】\n${JSON.stringify({ sender: source.gift.sender, title: source.gift.title,
    deliveredAt: new Date(source.gift.deliveredAt!).toISOString(), openedAt: new Date(source.gift.openedAt!).toISOString(),
    sources: messages.map(message => ({ id: message.id, subject: message.role,
      kind: message.id === 'title' ? 'title' : message.id === 'note' ? 'note' : 'echo', at: new Date(message.createdAt).toISOString() })) })}`;
}

/** A process epoch protects in-flight work, not a registered durable proposal. */
export function giftMemoryCandidateForPersistence(candidate: MemoryCandidateReview): MemoryCandidateReview {
  if (!candidate.sourceRefs?.some(ref => isGiftMemorySource(ref.sessionId))) return candidate;
  const continuationReview = candidate.continuationReview ? { ...candidate.continuationReview } : undefined;
  const currentStateReview = candidate.currentStateReview ? { ...candidate.currentStateReview } : undefined;
  if (continuationReview) delete continuationReview.dataEpoch;
  if (currentStateReview) delete currentStateReview.dataEpoch;
  return { ...candidate, ...(continuationReview ? { continuationReview } : {}), ...(currentStateReview ? { currentStateReview } : {}) };
}

export async function prepareGiftMemoryRecheck(originals: readonly { sessionId: string; message: SubjectiveMessage; hash: string }[],
  dataEpoch: number | null) {
  const selected = originals.filter(original => isGiftMemorySource(original.sessionId));
  const bindings: GiftMemoryBinding[] = [], envelopes: string[] = [];
  for (const sessionId of new Set(selected.map(original => original.sessionId))) {
    const source = await readGiftMemorySource(sessionId);
    const messages = selected.filter(original => original.sessionId === sessionId);
    if (!source || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw Error('MEMORY_SOURCE_CHANGED');
    for (const original of messages) {
      const binding = source.bindings.find(binding => binding.messageId === original.message.id && binding.sourceHash === original.hash);
      if (!binding) throw Error('MEMORY_SOURCE_CHANGED');
      bindings.push(binding);
    }
    envelopes.push(giftMemorySourceEnvelope(source, messages.map(original => original.message)));
  }
  return { envelope: envelopes.join('\n\n'), metadata: { bindings, dataEpoch } };
}

export async function validateGiftMemoryBindings(bindings: readonly GiftMemoryBinding[], dataEpoch: number | null,
  options: GiftMemoryReadOptions = {}) {
  if (!canCommitBackupRestoreDataEpoch(dataEpoch) || !bindings.length) return false;
  const sources = new Map<string, GiftMemorySource | null>();
  for (const binding of bindings) {
    if (!isGiftMemorySource(binding.sessionId)) return false;
    if (!sources.has(binding.sessionId)) sources.set(binding.sessionId, await readGiftMemorySource(binding.sessionId, options));
    if (!sources.get(binding.sessionId)?.bindings.some(current => current.messageId === binding.messageId
      && current.sourceHash === binding.sourceHash && current.giftHash === binding.giftHash)) return false;
  }
  return canCommitBackupRestoreDataEpoch(dataEpoch);
}

/** Immutable batch metadata owns exact source hashes, including plain new-memory proposals. */
export async function validateGiftCandidateSources(candidate: Pick<MemoryCandidateReview, 'sourceRefs' | 'ingestionRefs'> & { reviewId?: string },
  options: GiftMemoryReadOptions = {}) {
  const refs = candidate.sourceRefs?.filter(ref => isGiftMemorySource(ref.sessionId)) ?? [];
  if (!refs.length) return true;
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
  const database = options.database ?? await getMemoryDatabase();
  const direct = refs.filter(ref => (ref.relation ?? 'direct') === 'direct');
  const covered = new Set<string>();
  for (const batchId of new Set((candidate.ingestionRefs ?? []).map(ref => ref.batchId))) {
    const row = await database.getFirstAsync<{ work_metadata_json: string | null }>(
      'SELECT work_metadata_json FROM memory_ingestion_batches WHERE id = ?', batchId);
    const work = row?.work_metadata_json ? JSON.parse(row.work_metadata_json)?.gift : null;
    if (!work) continue;
    const registered = candidate.reviewId && await database.getFirstAsync(
      "SELECT 1 FROM memory_ingestion_items WHERE batch_id = ? AND status IN ('pending', 'waiting') AND json_extract(candidate_json, '$.reviewId') = ?",
      batchId, candidate.reviewId);
    if (!Array.isArray(work.bindings) || !await validateGiftMemoryBindings(work.bindings, registered ? dataEpoch : work.dataEpoch, { database })) return false;
    for (const binding of work.bindings as GiftMemoryBinding[]) covered.add(`${binding.sessionId}\0${binding.messageId}`);
  }
  if (direct.some(ref => !covered.has(`${ref.sessionId}\0${ref.messageId}`))) return false;
  for (const ref of refs) {
    const message = await readGiftMemoryMessage(ref.sessionId, ref.messageId, { database });
    if (!message || message.role !== ref.role || message.createdAt !== ref.messageCreatedAt || message.content !== ref.excerpt) return false;
  }
  return canCommitBackupRestoreDataEpoch(dataEpoch);
}
