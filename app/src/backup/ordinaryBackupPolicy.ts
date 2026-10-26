import { isTheaterLocalStorageKey } from '../theater/theaterLocalState';
import { CHAT_REPLY_DRAFT_KEY } from '../chat/chatReplyDraft';
import { SLEEP_REPLY_DRAFT_KEY } from '../life/sleepPlanPolicy';

const APP_STORAGE_PREFIX = 'junluo.';
const SYNC_STORAGE_PREFIX = 'junluo.sync.';
const VOICE_CALL_DIAGNOSTIC_PREFIX = 'junluo.voiceCall.diagnostics.v1.';

export const ORDINARY_BACKUP_FORMAT_VERSION = 14 as const;

export function isSyncTechnicalStorageKey(key: string) {
  return key.startsWith(SYNC_STORAGE_PREFIX);
}

export function isOrdinaryBackupStorageKey(key: string) {
  return key.startsWith(APP_STORAGE_PREFIX)
    && !isSyncTechnicalStorageKey(key)
    && !key.startsWith(VOICE_CALL_DIAGNOSTIC_PREFIX)
    && key !== CHAT_REPLY_DRAFT_KEY
    && key !== SLEEP_REPLY_DRAFT_KEY
    && key !== 'junluo.shiying.notifications.local.v1'
    && key !== 'junluo.shiying.review.local.v1'
    && !isTheaterLocalStorageKey(key);
}

export function sanitizeOrdinaryBackupStorage(
  storage: Readonly<Record<string, string>>,
) {
  return Object.fromEntries(
    Object.entries(storage).filter(([key]) => isOrdinaryBackupStorageKey(key)),
  );
}
