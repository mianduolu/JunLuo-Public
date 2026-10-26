import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';

export const ACTIVE_VOICE_CALL_RECORD_DRAFT_KEY = 'junluo.voiceCall.activeRecordDraft.v1';

const DELETED_VOICE_CALL_RECORD_IDS_KEY = 'junluo.voiceCall.deletedRecordIds.v1';
const MAX_DELETED_VOICE_CALL_RECORD_IDS = 256;

function readDeletedRecordIds(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
      : [];
  } catch {
    return [];
  }
}

export async function isVoiceCallRecordDeleted(callId: string) {
  const deletedIds = readDeletedRecordIds(
    await AsyncStorage.getItem(DELETED_VOICE_CALL_RECORD_IDS_KEY),
  );
  return deletedIds.includes(callId);
}

let deletionWriteQueue: Promise<unknown> = Promise.resolve();

export async function markVoiceCallRecordDeleted(callId: string) {
  const normalizedCallId = callId.trim();
  if (!normalizedCallId) return;
  const dataEpoch = captureBackupRestoreDataEpoch();
  const pending = deletionWriteQueue.catch(() => undefined).then(() =>
    runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const deletedIds = readDeletedRecordIds(
        await AsyncStorage.getItem(DELETED_VOICE_CALL_RECORD_IDS_KEY),
      ).filter((entry) => entry !== normalizedCallId);
      deletedIds.push(normalizedCallId);
      await AsyncStorage.setItem(
        DELETED_VOICE_CALL_RECORD_IDS_KEY,
        JSON.stringify(deletedIds.slice(-MAX_DELETED_VOICE_CALL_RECORD_IDS)),
      );

      const { loadActiveVoiceCallRecordDraft, clearActiveVoiceCallRecordDraft, voiceCallRecordVersion } = await import('./voiceCallRecordStorage');
      const draft = await loadActiveVoiceCallRecordDraft();
      if (draft?.record.callId === normalizedCallId) await clearActiveVoiceCallRecordDraft({
        callId: normalizedCallId, recordHash: voiceCallRecordVersion(draft.record),
      }, dataEpoch);
    }));
  deletionWriteQueue = pending;
  await pending;
}
