import { getMemoryDatabase } from '../memory/memoryStore';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { commitGiftWork, loadGiftView } from './giftStore';
import type { GiftSubject, GiftVersion, GiftWorkToken } from './giftTypes';

export type GiftProcessingState = { lastFailedAttempt: number; retryAt: number; errorCode: string | null };
export type GiftUnderstandingReceipt = {
  subject: 'I'; token: GiftWorkToken; attachmentId: string; originalId: string; content: string; understoodAt: number;
};
type StateRow = { last_failed_attempt: number; retry_at: number; error_code: string | null };
type ReceiptRow = { attachment_id: string; original_id: string; content: string; understood_at: number };

const LOCAL_STARTED = 'gift-local-started';

export async function isGiftLocalWorkStarted(token: GiftWorkToken, stage: string, attempt: number) {
  const state = await loadGiftProcessingState(token, stage);
  return state.errorCode === LOCAL_STARTED && state.lastFailedAttempt + 1 === attempt;
}

/** The existing stage row is the local start boundary, not a new receipt. */
export async function startGiftLocalWork(token: GiftWorkToken, stage: string, attempt: number) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw Error('gift-invalid-processing-state');
  const result = await commitGiftWork(token, async transaction => {
    const row = await transaction.getFirstAsync<StateRow>(
      'SELECT * FROM gift_processing_state WHERE gift_id=? AND gift_revision=? AND stage=?', token.id, token.revision, stage);
    const previous = row?.last_failed_attempt ?? 0;
    if (attempt !== previous + 1 || row?.error_code === LOCAL_STARTED) return false;
    await transaction.runAsync(`INSERT INTO gift_processing_state(gift_id,gift_revision,stage,last_failed_attempt,retry_at,error_code)
      VALUES(?,?,?,?,?,?) ON CONFLICT(gift_id,gift_revision,stage) DO UPDATE SET
      last_failed_attempt=excluded.last_failed_attempt,retry_at=excluded.retry_at,error_code=excluded.error_code`,
    token.id, token.revision, stage, previous, Date.now(), LOCAL_STARTED);
    return true;
  });
  return result.committed && result.value;
}

/** Reception saves a new gift revision; only its real receipt may retire the old stage start. */
export async function clearGiftLocalReceptionStart(token: GiftWorkToken, attempt: number, savedRevision: number) {
  if (savedRevision !== token.revision + 1) throw Error('gift-invalid-processing-state');
  return commitGiftWork({ ...token, revision: savedRevision }, transaction => transaction.runAsync(
    'DELETE FROM gift_processing_state WHERE gift_id=? AND gift_revision=? AND stage=? AND error_code=? AND last_failed_attempt=?',
    token.id, token.revision, 'reception', LOCAL_STARTED, attempt - 1));
}

/** These errors prove no accepted result needs recovering; transport uncertainty does not. */
export function isKnownGiftLocalFailure(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return /^gift-(?:original|echo)-request-(?:auth|rate-limited|http-error|invalid-config|invalid-input|preflight-failed|empty-response|incomplete-response|invalid-response|provider-error)$/.test(code)
    || ['gift-request-postponed', 'gift-echo-request-postponed', 'gift-invalid-reception-response', 'gift-echo-invalid-choice',
      'gift-audio-connection-unavailable', 'gift-image-connection-unavailable', 'gift-chat-connection-unavailable',
      'gift-reception-connection-unavailable'].includes(code);
}

export async function listDueGiftVersions(now: number): Promise<GiftVersion[]> {
  const rows = await (await getMemoryDatabase()).getAllAsync<{ id: string; revision: number }>(
    `SELECT id,revision FROM gift_records WHERE json_extract(record_json,'$.deliveryStatus')='scheduled'
      AND json_extract(record_json,'$.scheduledAt') <= ? ORDER BY json_extract(record_json,'$.scheduledAt'),id`, now);
  return rows.map(row => ({ id: row.id, revision: row.revision }));
}

export async function loadGiftProcessingState(token: GiftWorkToken, stage: string): Promise<GiftProcessingState> {
  const row = await (await getMemoryDatabase()).getFirstAsync<StateRow>(
    'SELECT * FROM gift_processing_state WHERE gift_id=? AND gift_revision=? AND stage=?', token.id, token.revision, stage);
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  return row ? { lastFailedAttempt: row.last_failed_attempt, retryAt: row.retry_at, errorCode: row.error_code }
    : { lastFailedAttempt: 0, retryAt: 0, errorCode: null };
}

/** Known local failures advance the claim identity; relay uncertainty keeps it. */
export async function deferGiftProcessing(token: GiftWorkToken, stage: string, attempt: number,
  errorCode: string, retryAt: number, knownFailure: boolean) {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(retryAt) || retryAt < 0
    || !/^gift-[a-z-]+$/.test(errorCode)) throw Error('gift-invalid-processing-state');
  return commitGiftWork(token, async transaction => {
    const row = await transaction.getFirstAsync<StateRow>(
      'SELECT * FROM gift_processing_state WHERE gift_id=? AND gift_revision=? AND stage=?', token.id, token.revision, stage);
    const previous = row?.last_failed_attempt ?? 0;
    if (row?.error_code === LOCAL_STARTED && !knownFailure) return false;
    if (attempt !== previous + 1) return false;
    await transaction.runAsync(`INSERT INTO gift_processing_state(gift_id,gift_revision,stage,last_failed_attempt,retry_at,error_code)
      VALUES(?,?,?,?,?,?) ON CONFLICT(gift_id,gift_revision,stage) DO UPDATE SET
      last_failed_attempt=excluded.last_failed_attempt,retry_at=excluded.retry_at,error_code=excluded.error_code`,
      token.id, token.revision, stage, knownFailure ? attempt : previous, retryAt, errorCode);
    return true;
  });
}

export async function loadGiftUnderstandingReceipt(token: GiftWorkToken, attachmentId: string): Promise<GiftUnderstandingReceipt | null> {
  const view = await loadGiftView(token.id, 'I');
  if (!view?.revealed || view.gift.revision !== token.revision || view.gift.sender !== 'you'
    || view.gift.openedAt === null) return null;
  const row = await (await getMemoryDatabase()).getFirstAsync<ReceiptRow>(
    'SELECT * FROM gift_understanding_receipts WHERE gift_id=? AND gift_revision=? AND attachment_id=?',
    token.id, token.revision, attachmentId);
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  const latest = await loadGiftView(token.id, 'I');
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  if (!latest?.revealed || latest.gift.revision !== token.revision || latest.gift.deliveryStatus !== 'delivered') return null;
  const attachment = latest.gift.attachments.find(item => item.id === attachmentId);
  if (row && (!attachment || attachment.kind === 'url' || attachment.kind === 'html'
    || attachment.original.id !== row.original_id)) return null;
  return row ? { subject: 'I', token: { ...token }, attachmentId: row.attachment_id, originalId: row.original_id,
    content: row.content, understoodAt: row.understood_at } : null;
}

/** Adopt the actual first expression once; ordinary reply threads are chapter 6. */
export async function saveGiftUnderstandingReceipt(result: {
  subject: 'I'; token: GiftWorkToken; attachmentId: string; kind: 'image' | 'audio'; content: string; understoodAt: number;
}) {
  const value = { ...result, token: { ...result.token } };
  if (value.subject !== 'I' || !value.content.trim() || !Number.isSafeInteger(value.understoodAt)) throw Error('gift-invalid-understanding');
  return commitGiftWork(value.token, async (transaction, gift) => {
    if (gift.sender !== 'you' || gift.deliveryStatus !== 'delivered' || gift.openedAt === null) throw Error('gift-not-opened');
    const attachment = gift.attachments.find(item => item.id === value.attachmentId);
    if (!attachment || attachment.kind !== value.kind) throw Error('gift-attachment-not-owned');
    await transaction.runAsync(`INSERT INTO gift_understanding_receipts(gift_id,gift_revision,attachment_id,original_id,subject,content,understood_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(gift_id,gift_revision,attachment_id) DO NOTHING`,
      gift.id, gift.revision, attachment.id, attachment.original.id, 'I', value.content, value.understoodAt);
    const saved = await transaction.getFirstAsync<ReceiptRow>(
      'SELECT * FROM gift_understanding_receipts WHERE gift_id=? AND gift_revision=? AND attachment_id=?', gift.id, gift.revision, attachment.id);
    if (!saved || saved.original_id !== attachment.original.id) throw Error('gift-invalid-understanding');
    await transaction.runAsync('DELETE FROM gift_processing_state WHERE gift_id=? AND gift_revision=? AND stage=?',
      gift.id, gift.revision, `attachment:${attachment.id}`);
    return { subject: 'I' as const, token: value.token, attachmentId: saved.attachment_id, originalId: saved.original_id,
      content: saved.content, understoodAt: saved.understood_at };
  });
}

/** Human-facing technical facts only; hidden interiors remain hidden for a recipient. */
export async function readGiftProcessingSummary(version: GiftVersion, viewer: GiftSubject) {
  const epoch = captureBackupRestoreDataEpoch();
  const view = await loadGiftView(version.id, viewer);
  if (!view?.revealed || view.gift.revision !== version.revision) return null;
  const database = await getMemoryDatabase();
  const receipts = await database.getAllAsync<{ attachment_id: string }>(
    'SELECT attachment_id FROM gift_understanding_receipts WHERE gift_id=? AND gift_revision=?', version.id, version.revision);
  const failure = await database.getFirstAsync<StateRow>(
    'SELECT * FROM gift_processing_state WHERE gift_id=? AND gift_revision=? ORDER BY retry_at DESC LIMIT 1', version.id, version.revision);
  const latest = await loadGiftView(version.id, viewer);
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw Error('gift-stale-data-epoch');
  if (!latest?.revealed || latest.gift.revision !== version.revision) return null;
  const media = view.gift.attachments.filter(item => item.kind === 'audio' || item.kind === 'image');
  return { understood: receipts.filter(item => media.some(attachment => attachment.id === item.attachment_id)).length,
    total: media.length, retryAt: failure?.retry_at ?? null, errorCode: failure?.error_code ?? null };
}
