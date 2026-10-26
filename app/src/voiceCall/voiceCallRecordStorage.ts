import AsyncStorage from '@react-native-async-storage/async-storage';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { AiConnection } from '../ai/types';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { emitChatMessagesAppended } from '../chat/chatMessageEvents';
import {
  appendMessagesToChatSession,
  loadChatStateFast,
} from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import {
  hasReliableVoiceCallText,
  isVoiceCallRecord,
  type VoiceCallRecord,
  type VoiceCallRecordDraft,
} from './voiceCallRecord';
import {
  ACTIVE_VOICE_CALL_RECORD_DRAFT_KEY,
  isVoiceCallRecordDeleted,
} from './voiceCallRecordDeletion';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import { getVoiceCallMemorySessionId, loadVoiceCallMemoryRecord } from './voiceCallMemorySource';
import { settleVoiceCallMemoryUsage } from './voiceCallMemoryUsage';
import { isVoiceCallMemoryOrganizationRunning, organizeVoiceCallMemoryRecord, recoverVoiceCallMemoryResults } from './voiceCallMemoryOrganizationRuntime';

function cloneRecord(record: VoiceCallRecord): VoiceCallRecord {
  return JSON.parse(JSON.stringify(record)) as VoiceCallRecord;
}
export const voiceCallRecordVersion = (record: VoiceCallRecord) => stableMemoryHash(JSON.stringify(record));
let draftWriteQueue: Promise<unknown> = Promise.resolve();
function queueDraftWrite<T>(work: () => Promise<T>): Promise<T> {
  const pending = draftWriteQueue.catch(() => undefined).then(work);
  draftWriteQueue = pending;
  return pending;
}

function readDraft(value: string | null): VoiceCallRecordDraft | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<VoiceCallRecordDraft>;
    if (parsed.version !== 1 || !isVoiceCallRecord(parsed.record)) return null;
    return {
      dataEpoch: parsed.dataEpoch,
      record: parsed.record,
      targetSessionId: typeof parsed.targetSessionId === 'string' ? parsed.targetSessionId : undefined,
      version: 1,
    };
  } catch {
    return null;
  }
}

export async function persistActiveVoiceCallRecordDraft(draft: VoiceCallRecordDraft,
  expected?: { callId: string; recordHash: string } | null) {
  const dataEpoch = draft.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : draft.dataEpoch;
  return queueDraftWrite(async () => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch) || await isVoiceCallRecordDeleted(draft.record.callId)) return false;
    if (expected !== undefined) {
      const raw = await AsyncStorage.getItem(ACTIVE_VOICE_CALL_RECORD_DRAFT_KEY);
      const current = readDraft(raw);
      if (expected === null ? raw !== null
        : current?.record.callId !== expected.callId || voiceCallRecordVersion(current.record) !== expected.recordHash) return false;
    }
    const result = await runBackupRestoreDataEpochCommit(dataEpoch,
      () => AsyncStorage.setItem(ACTIVE_VOICE_CALL_RECORD_DRAFT_KEY, JSON.stringify(draft)));
    return result.committed;
  });
}

export async function clearActiveVoiceCallRecordDraft(expected?: { callId: string; recordHash: string },
  dataEpoch = captureBackupRestoreDataEpoch()) {
  return queueDraftWrite(async () => {
    const current = readDraft(await AsyncStorage.getItem(ACTIVE_VOICE_CALL_RECORD_DRAFT_KEY));
    if (expected && (current?.record.callId !== expected.callId || voiceCallRecordVersion(current.record) !== expected.recordHash)) return false;
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, () => AsyncStorage.removeItem(ACTIVE_VOICE_CALL_RECORD_DRAFT_KEY));
    return result.committed;
  });
}

export async function loadActiveVoiceCallRecordDraft() {
  return readDraft(await AsyncStorage.getItem(ACTIVE_VOICE_CALL_RECORD_DRAFT_KEY));
}

function makeVoiceCallRecordMessage(record: VoiceCallRecord): SubjectiveMessage {
  return {
    content: '',
    createdAt: record.endedAt,
    id: `voice-call-record-${record.callId}`,
    role: 'I',
    source: 'voice-call',
    voiceCallRecord: record,
  };
}

async function resolveTargetSessionId(preferred?: string) {
  if (preferred && preferred !== PRIMARY_CHAT_SESSION_ID) return null;
  const state = await loadChatStateFast({ activeMessageLimit: 1 });
  return state.sessions.some((session) => session.id === PRIMARY_CHAT_SESSION_ID) ? PRIMARY_CHAT_SESSION_ID : null;
}

export async function upsertVoiceCallRecord(record: VoiceCallRecord, preferredSessionId?: string,
  options: { dataEpoch?: number | null; expectedRecordHash?: string | null; usageRecovery?: boolean } = {}) {
  if (await isVoiceCallRecordDeleted(record.callId)) return null;
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const sessionId = await resolveTargetSessionId(preferredSessionId);
  if (
    !sessionId
    || !canCommitBackupRestoreDataEpoch(dataEpoch)
    || await isVoiceCallRecordDeleted(record.callId)
  ) return null;
  const saved = cloneRecord(record);
  if (saved.memoryUsageReceipts?.length && saved.memoryUsageSavedAt === undefined) saved.memoryUsageSavedAt = Date.now();
  const message = makeVoiceCallRecordMessage(saved);
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => (
    appendMessagesToChatSession(sessionId, [message], { activeSessionId: sessionId, beforeAppend: async messages => {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch) || await isVoiceCallRecordDeleted(record.callId)) return false;
      if (options.expectedRecordHash === undefined) return true;
      const existing = messages.find(item => item.id === message.id)?.voiceCallRecord;
      return options.expectedRecordHash === null ? !existing : !!existing && voiceCallRecordVersion(existing) === options.expectedRecordHash;
    } })
  ));
  if (!committed.committed || !committed.value.session) return null;
  const actual = await loadVoiceCallMemoryRecord(getVoiceCallMemorySessionId(record.callId));
  if (!actual || voiceCallRecordVersion(actual) !== voiceCallRecordVersion(saved) || !canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
  if (saved.memoryUsageSavedAt !== undefined) record.memoryUsageSavedAt = saved.memoryUsageSavedAt;
  if (actual.memoryUsageSavedAt && !await isVoiceCallRecordDeleted(record.callId)) {
    try { await settleVoiceCallMemoryUsage(actual, actual.memoryUsageSavedAt, () => canCommitBackupRestoreDataEpoch(dataEpoch),
      options.usageRecovery ? { recoveryDataEpoch: dataEpoch } : undefined); }
    catch { console.warn('[voice-call] usage settlement failed', { callId: record.callId }); }
  }
  try { emitChatMessagesAppended({ messages: [message], sessionId, source: 'voice-call-record' }); }
  catch { console.warn('[voice-call] record refresh failed', { callId: record.callId }); }
  return sessionId;
}

export async function finalizeVoiceCallRecord(input: {
  ai: { apiKey: string; connection: AiConnection | null };
  record: VoiceCallRecord;
  dataEpoch?: number | null;
  saveCallSummary: boolean;
  targetSessionId?: string;
}) {
  let record = cloneRecord(input.record);
  const dataEpoch = input.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : input.dataEpoch;
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
  const originalDraft = await loadActiveVoiceCallRecordDraft();
  const draftIdentity = originalDraft?.record.callId === record.callId
    ? { callId: record.callId, recordHash: voiceCallRecordVersion(originalDraft.record) } : undefined;
  const previous = await loadVoiceCallMemoryRecord(getVoiceCallMemorySessionId(record.callId));
  if (previous?.memoryOrganization) {
    if (isVoiceCallMemoryOrganizationRunning(record.callId)) return previous;
    record = cloneRecord(previous);
  }
  const eligibleForSummary = input.saveCallSummary && hasReliableVoiceCallText(record);
  if (!previous?.memoryOrganization) {
    if (!input.saveCallSummary) record.summaryStatus = 'disabled';
    else if (!hasReliableVoiceCallText(record)) record.summaryStatus = 'skipped';
    else if (!input.ai.apiKey.trim() || !input.ai.connection) {
      record.summaryStatus = 'failed';
      record.summaryFailureReason = 'ai_not_configured';
    } else {
      record.summaryStatus = 'pending';
    }
  }

  const sessionId = await upsertVoiceCallRecord(record, input.targetSessionId,
    { dataEpoch, expectedRecordHash: previous ? voiceCallRecordVersion(previous) : null });
  if (!sessionId) return null;
  let expectedRecordHash = voiceCallRecordVersion(record);
  const saveRecord = async (next: VoiceCallRecord) => {
    if (next.callId !== record.callId || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
    const saved = await upsertVoiceCallRecord(next, sessionId, { dataEpoch, expectedRecordHash });
    if (saved) expectedRecordHash = voiceCallRecordVersion(next);
    return !!saved;
  };
  const finishLocalResult = async (result: VoiceCallRecord) => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
    const saved = await loadVoiceCallMemoryRecord(getVoiceCallMemorySessionId(record.callId));
    const needsLocalRecovery = result.memoryOrganization?.segments.some(segment => segment.candidateStatus === 'cached');
    if (saved && voiceCallRecordVersion(saved) === voiceCallRecordVersion(result) && !needsLocalRecovery) {
      if (draftIdentity) await clearActiveVoiceCallRecordDraft(draftIdentity, dataEpoch);
    } else {
      await persistActiveVoiceCallRecordDraft({ record: result, targetSessionId: sessionId, version: 1, dataEpoch }, draftIdentity ?? null);
    }
    return result;
  };
  if (previous?.memoryOrganization) {
    // A repeated hangup or restart continues local work; it cannot replace returned results or request the next range.
    try { return finishLocalResult(await recoverVoiceCallMemoryResults(record, { dataEpoch, saveRecord })); }
    catch { console.warn('[voice-call] local result recovery failed', { callId: record.callId }); return record; }
  }
  if (!eligibleForSummary || record.summaryStatus !== 'pending' || !input.ai.connection) {
    if (draftIdentity) await clearActiveVoiceCallRecordDraft(draftIdentity, dataEpoch);
    return record;
  }

  const result = await organizeVoiceCallMemoryRecord({ record, apiKey: input.ai.apiKey,
    connection: input.ai.connection, mode: 'automatic', dataEpoch, saveRecord });
  return finishLocalResult(result);
}

export async function recoverInterruptedVoiceCallRecord() {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const draft = await loadActiveVoiceCallRecordDraft();
  if (!draft) return null;
  // A recovered draft must retain its original target; it is not a new call.
  if (draft.targetSessionId !== PRIMARY_CHAT_SESSION_ID) {
    await clearActiveVoiceCallRecordDraft({ callId: draft.record.callId, recordHash: voiceCallRecordVersion(draft.record) }, dataEpoch);
    return null;
  }
  let recovered = cloneRecord(draft.record);
  const current = await loadVoiceCallMemoryRecord(getVoiceCallMemorySessionId(recovered.callId));
  if (current && JSON.stringify(current.turns) !== JSON.stringify(recovered.turns)) {
    // The formal source has changed. An older cached result cannot restore its old text.
    console.warn('[voice-call] cached source changed', { callId: recovered.callId });
    return current;
  }
  if (current && !recovered.memoryOrganization) recovered = cloneRecord(current);
  if (!recovered.memoryOrganization) {
    if (!current) recovered.endReason = 'app-left';
    recovered.summary = current?.summary ?? '';
    recovered.memoryCandidates = current?.memoryCandidates ?? [];
    recovered.summaryFailureReason = current?.summaryFailureReason ?? 'recovered_after_app_exit';
    recovered.summaryStatus = current?.summaryStatus === 'ready' ? 'ready' : 'skipped';
  }
  recovered.rawAudioSaved = false;
  const sessionId = await upsertVoiceCallRecord(recovered, draft.targetSessionId,
    { dataEpoch, expectedRecordHash: current ? voiceCallRecordVersion(current) : null, usageRecovery: true });
  if (!sessionId) return null;
  let expectedRecordHash = voiceCallRecordVersion(recovered);
  let result: VoiceCallRecord;
  try { result = await recoverVoiceCallMemoryResults(recovered, { dataEpoch, saveRecord: async (next: VoiceCallRecord) => {
    const saved = await upsertVoiceCallRecord(next, sessionId, { dataEpoch, expectedRecordHash, usageRecovery: true });
    if (saved) expectedRecordHash = voiceCallRecordVersion(next);
    return !!saved;
  } }); } catch { console.warn('[voice-call] local result recovery failed', { callId: recovered.callId }); return recovered; }
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return null;
  const actual = await loadVoiceCallMemoryRecord(getVoiceCallMemorySessionId(recovered.callId));
  const identity = { callId: recovered.callId, recordHash: voiceCallRecordVersion(draft.record) };
  const needsLocalRecovery = result.memoryOrganization?.segments.some(segment => segment.candidateStatus === 'cached');
  if (actual && voiceCallRecordVersion(actual) === voiceCallRecordVersion(result) && !needsLocalRecovery) await clearActiveVoiceCallRecordDraft(identity, dataEpoch);
  else await persistActiveVoiceCallRecordDraft({ ...draft, record: result, dataEpoch }, identity);
  return result;
}
