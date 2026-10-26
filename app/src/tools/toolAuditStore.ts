import {
  toolsAuditStorageBridge as AsyncStorage,
} from '../sync/syncToolsAuditStorageBridge';
import {
  observeRuntimeWorkload,
  type RuntimeWorkloadCounts,
  type RuntimeWorkloadStage,
} from '../runtime/runtimeWorkloadDiagnostics';

import type {
  JunLuoToolAuditRecord,
  JunLuoToolInputPreviewValue,
  JunLuoToolPermissionAuthorizationSource,
  JunLuoToolPermissionDecision,
  JunLuoToolAgentAuditMetadata,
} from './toolAuditTypes';
import {
  buildToolInputPreview,
  previewToolInputValue,
  sanitizeToolAuditFieldName,
  sanitizeToolAuditText,
} from './toolInputPreview';
import { getToolDefinition } from './toolRegistry';
import { normalizeOwnScheduleSave, type OwnScheduleSave } from '../schedule/ownScheduleSaveState';
import { normalizeUserRoutineSave, type UserRoutineSaveState } from '../schedule/userRoutineSaveState';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import { normalizePhoneLimitSave, type PhoneLimitSave } from './phoneLimitAuditState';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import {
  mergeMusicPlaybackObservations,
  normalizeMusicPlaybackObservations,
  type MusicPlaybackObservation,
} from '../music/musicPlaybackObservation';

const TOOL_AUDIT_LOG_KEY = 'junluo.tools.auditLog.v1';
const MAX_AUDIT_RECORDS = 200;
let toolAuditWriteQueue = Promise.resolve();
// References only: updates still live in the original deferred audit batch.
const pendingAuditBatches = new Map<string, { batch: ToolAuditWriteBatch; dataEpoch: number | null }>();

type ToolAuditRecordUpdate = (
  record?: JunLuoToolAuditRecord,
) => JunLuoToolAuditRecord;

export type ToolAuditWriteBatch = {
  callId: string;
  flushed: boolean;
  updates: ToolAuditRecordUpdate[];
};

export function createToolAuditWriteBatch(callId: string): ToolAuditWriteBatch {
  return { callId, flushed: false, updates: [] };
}

function observeToolAuditStorageStage<T>(
  stage: RuntimeWorkloadStage,
  operation: () => Promise<T>,
  diagnosticParentToken?: number,
  summarize?: (value: T) => RuntimeWorkloadCounts,
) {
  return diagnosticParentToken
    ? observeRuntimeWorkload(
        stage,
        operation,
        summarize,
        { parentToken: diagnosticParentToken },
      )
    : operation();
}

export function enqueueToolAuditWrite<T>(
  callback: () => Promise<T>,
) {
  const current = toolAuditWriteQueue
    .catch(() => undefined)
    .then(callback);
  toolAuditWriteQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function sanitizeStoredPreviewValue(
  value: unknown,
  fieldName: string,
): JunLuoToolInputPreviewValue {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (value === '[redacted]' || /^\[private text: \d+ chars\]$/.test(value)) {
      return value;
    }
    return previewToolInputValue(value, fieldName);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as { type?: unknown; length?: unknown; keys?: unknown };
    if (item.type === 'array' && typeof item.length === 'number' && Number.isFinite(item.length)) {
      return { type: 'array', length: Math.max(0, Math.round(item.length)) };
    }
    if (item.type === 'object' && Array.isArray(item.keys)) {
      return {
        type: 'object',
        keys: item.keys
          .filter((nested): nested is string => typeof nested === 'string')
          .slice(0, 12)
          .map(sanitizeToolAuditFieldName),
      };
    }
    if (item.type === 'unknown') return { type: 'unknown' };
  }
  return previewToolInputValue(value, fieldName);
}

function sanitizeStoredInputPreview(value: unknown): Record<string, JunLuoToolInputPreviewValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 12)
      .map(([key, nestedValue]) => [
        sanitizeToolAuditFieldName(key),
        sanitizeStoredPreviewValue(nestedValue, key),
      ]),
  );
}

function normalizeRecord(value: unknown): JunLuoToolAuditRecord | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<JunLuoToolAuditRecord>;
  if (
    typeof item.callId !== 'string' ||
    typeof item.toolId !== 'string' ||
    typeof item.packageId !== 'string' ||
    typeof item.createdAt !== 'number'
  ) {
    return null;
  }
  return {
    callId: item.callId,
    executionId: typeof item.executionId === 'string' ? item.executionId : undefined,
    toolId: item.toolId,
    packageId: item.packageId,
    source: item.source ?? 'manual',
    sourceMessageId: typeof item.sourceMessageId === 'string' ? item.sourceMessageId : undefined,
    executionIntentId: typeof item.executionIntentId === 'string'
      ? item.executionIntentId.slice(0, 256)
      : undefined,
    executionIntentSource: typeof item.executionIntentSource === 'string'
      ? item.executionIntentSource.slice(0, 80)
      : undefined,
    inputPreview: sanitizeStoredInputPreview(item.inputPreview),
    permissionDecision: item.permissionDecision ?? 'not_checked',
    permissionSource: typeof item.permissionSource === 'string'
      ? item.permissionSource as JunLuoToolPermissionAuthorizationSource
      : undefined,
    permissionGrantId: typeof item.permissionGrantId === 'string' ? item.permissionGrantId : undefined,
    permissionExpiresAt: typeof item.permissionExpiresAt === 'number' ? item.permissionExpiresAt : undefined,
    permissionSilent: typeof item.permissionSilent === 'boolean' ? item.permissionSilent : undefined,
    status: item.status ?? 'requested',
    resultSummary: typeof item.resultSummary === 'string'
      ? sanitizeToolAuditText(item.resultSummary)
      : undefined,
    errorMessage: typeof item.errorMessage === 'string'
      ? sanitizeToolAuditText(item.errorMessage)
      : undefined,
    createdAt: item.createdAt,
    startedAt: typeof item.startedAt === 'number' ? item.startedAt : undefined,
    finishedAt: typeof item.finishedAt === 'number' ? item.finishedAt : undefined,
    ...(item.toolId === 'music.play' && item.musicPlayback !== undefined
      ? { musicPlayback: normalizeMusicPlaybackObservations(item.musicPlayback) } : {}),
    ...(item.toolId === 'schedule.save_own' && normalizeOwnScheduleSave(item.scheduleSave)
      ? { scheduleSave: normalizeOwnScheduleSave(item.scheduleSave) } : {}),
    ...(item.toolId === 'schedule.save_routine' && normalizeUserRoutineSave(item.routineSave)
      ? { routineSave: normalizeUserRoutineSave(item.routineSave) } : {}),
    ...(item.toolId === 'camera.look_once' && item.cameraReply
      && typeof item.cameraReply.sessionId === 'string' && Array.isArray(item.cameraReply.messageIds)
      ? { cameraReply: { sessionId: item.cameraReply.sessionId,
          messageIds: item.cameraReply.messageIds.filter((id): id is string => typeof id === 'string').slice(0, 24) } } : {}),
    ...(item.phoneLimitSave !== undefined
      ? { phoneLimitSave: normalizePhoneLimitSave(item.phoneLimitSave, item.callId, item.toolId) } : {}),
    agent: item.agent && typeof item.agent === 'object'
      ? {
          auditId: String(item.agent.auditId ?? '').slice(0, 256),
          turnId: String(item.agent.turnId ?? '').slice(0, 256),
          providerCallId: String(item.agent.providerCallId ?? '').slice(0, 256),
          toolRound: item.agent.toolRound === 3 ? 3 : item.agent.toolRound === 2 ? 2 : 1,
          candidateSource: typeof item.agent.candidateSource === 'string' ? item.agent.candidateSource.slice(0, 80) : undefined,
          authorityKind: typeof item.agent.authorityKind === 'string' ? item.agent.authorityKind.slice(0, 80) : undefined,
          providerFinishReason: typeof item.agent.providerFinishReason === 'string' ? item.agent.providerFinishReason.slice(0, 80) : undefined,
          proposalId: typeof item.agent.proposalId === 'string' ? item.agent.proposalId.slice(0, 256) : undefined,
          confirmationDecision: item.agent.confirmationDecision,
          settlement: item.agent.settlement,
          dataEpoch: typeof item.agent.dataEpoch === 'number' ? item.agent.dataEpoch : 0,
          executionDurationMs: typeof item.agent.executionDurationMs === 'number'
            ? Math.max(0, item.agent.executionDurationMs)
            : undefined,
        }
      : undefined,
  };
}

function normalizeAuditRecordList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeRecord)
    .filter((record): record is JunLuoToolAuditRecord => !!record)
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-MAX_AUDIT_RECORDS);
}

function serializeAuditRecords(records: JunLuoToolAuditRecord[]) {
  return JSON.stringify(normalizeAuditRecordList(records));
}

function serializeNormalizedAuditRecords(records: JunLuoToolAuditRecord[]) {
  return JSON.stringify(
    [...records]
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(-MAX_AUDIT_RECORDS),
  );
}

async function loadAuditRecords(options: {
  diagnosticParentToken?: number;
  strictPhoneSave?: boolean;
} = {}) {
  const loaded = await observeToolAuditStorageStage(
    'tools.audit.storage_load',
    async () => {
      const raw = await AsyncStorage.getItem(TOOL_AUDIT_LOG_KEY);
      if (!raw) {
        return {
          parsed: true,
          raw: null,
          records: [] as JunLuoToolAuditRecord[],
        };
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        if (options.strictPhoneSave && (!Array.isArray(parsed) || parsed.some(record => !normalizeRecord(record)))) {
          throw new Error('PHONE_LIMIT_AUDIT_UNREADABLE');
        }
        return {
          parsed: true,
          raw,
          records: normalizeAuditRecordList(parsed),
        };
      } catch {
        return {
          parsed: false,
          raw,
          records: [] as JunLuoToolAuditRecord[],
        };
      }
    },
    options.diagnosticParentToken,
    (value) => ({ itemCount: value.records.length }),
  );
  if (options.strictPhoneSave && !loaded.parsed) throw new Error('PHONE_LIMIT_AUDIT_UNREADABLE');
  if (loaded.parsed && loaded.raw) {
    const sanitizedRaw = await observeToolAuditStorageStage(
      'tools.audit.storage_serialize',
      async () => serializeNormalizedAuditRecords(loaded.records),
      options.diagnosticParentToken,
      () => ({ itemCount: loaded.records.length }),
    );
    if (sanitizedRaw !== loaded.raw) {
      await AsyncStorage.setItem(TOOL_AUDIT_LOG_KEY, sanitizedRaw);
    }
  }
  return loaded.records;
}

async function saveAuditRecords(
  records: JunLuoToolAuditRecord[],
  recordChange: {
    previous?: JunLuoToolAuditRecord;
    next: JunLuoToolAuditRecord;
  },
  diagnosticParentToken?: number,
) {
  const serialized = await observeToolAuditStorageStage(
    'tools.audit.storage_serialize',
    async () => serializeAuditRecords(records),
    diagnosticParentToken,
    () => ({ itemCount: records.length }),
  );
  await AsyncStorage.setItemForRecordChange(
    TOOL_AUDIT_LOG_KEY,
    serialized,
    recordChange,
    diagnosticParentToken,
  );
}

async function upsertAuditRecord(
  callId: string,
  update: ToolAuditRecordUpdate,
  batch?: ToolAuditWriteBatch,
  diagnosticParentToken?: number,
  strictPhoneSave = false,
) {
  if (batch) {
    if (batch.callId !== callId) throw new Error('TOOL_AUDIT_BATCH_CALL_MISMATCH');
    if (batch.flushed) throw new Error('TOOL_AUDIT_BATCH_ALREADY_FLUSHED');
    batch.updates.push(update);
    return;
  }
  await enqueueToolAuditWrite(async () => {
    const records = await loadAuditRecords({ diagnosticParentToken, strictPhoneSave });
    const index = records.findIndex((record) => record.callId === callId);
    const previous = index >= 0 ? records[index] : undefined;
    const next = update(previous);
    if (previous && JSON.stringify(previous) === JSON.stringify(normalizeRecord(next))) return;
    if (index >= 0) {
      records[index] = next;
    } else {
      records.push(next);
    }
    await saveAuditRecords(
      records,
      { previous, next },
      diagnosticParentToken,
    );
  });
}

export async function recordToolCallRequested(
  call: JunLuoToolCall,
  executionId?: string,
  agent?: JunLuoToolAgentAuditMetadata,
  batch?: ToolAuditWriteBatch,
) {
  const tool = getToolDefinition(call.toolId);
  if (batch && call.toolId === 'music.play') {
    for (const [id, entry] of pendingAuditBatches) {
      if (!canCommitBackupRestoreDataEpoch(entry.dataEpoch)) pendingAuditBatches.delete(id);
    }
    pendingAuditBatches.set(call.callId, { batch, dataEpoch: captureBackupRestoreDataEpoch() });
  }
  await upsertAuditRecord(call.callId, (current) => ({
    callId: call.callId,
    executionId: executionId ?? current?.executionId,
    toolId: call.toolId,
    packageId: tool?.packageId ?? current?.packageId ?? '',
    source: call.requestedBy,
    sourceMessageId: call.sourceMessageId,
    executionIntentId: call.executionIntentId ?? current?.executionIntentId,
    executionIntentSource: call.executionIntentSource ?? current?.executionIntentSource,
    inputPreview: agent ? current?.inputPreview ?? {} : buildToolInputPreview(call.input),
    permissionDecision: current?.permissionDecision ?? 'not_checked',
    permissionSource: current?.permissionSource,
    permissionGrantId: current?.permissionGrantId,
    permissionExpiresAt: current?.permissionExpiresAt,
    permissionSilent: current?.permissionSilent,
    status: 'requested',
    createdAt: call.toolId === 'browser.open' && current?.toolId === call.toolId
      && agent?.auditId && agent.auditId === current.agent?.auditId
      && Number.isSafeInteger(current.createdAt) && current.createdAt >= 0 && current.createdAt <= call.createdAt
      ? current.createdAt : call.createdAt,
    startedAt: current?.startedAt,
    finishedAt: current?.finishedAt,
    resultSummary: current?.resultSummary,
    errorMessage: current?.errorMessage,
    musicPlayback: current?.musicPlayback,
    scheduleSave: current?.scheduleSave,
    routineSave: current?.routineSave,
    phoneLimitSave: current?.phoneLimitSave,
    agent: agent ?? current?.agent,
  }), batch);
}

export async function recordToolPermissionDecision(
  callId: string,
  decision: JunLuoToolPermissionDecision,
  executionId?: string,
  authorization?: {
    source?: JunLuoToolPermissionAuthorizationSource;
    grantId?: string;
    expiresAt?: number;
    silent?: boolean;
  },
  batch?: ToolAuditWriteBatch,
) {
  const recordedAt = Date.now();
  await upsertAuditRecord(callId, (current) => ({
    callId,
    executionId: executionId ?? current?.executionId,
    toolId: current?.toolId ?? '',
    packageId: current?.packageId ?? '',
    source: current?.source ?? 'manual',
    inputPreview: current?.inputPreview ?? {},
    permissionDecision: decision,
    permissionSource: authorization?.source ?? current?.permissionSource,
    permissionGrantId: authorization?.grantId ?? current?.permissionGrantId,
    permissionExpiresAt: authorization?.expiresAt ?? current?.permissionExpiresAt,
    permissionSilent: authorization?.silent ?? current?.permissionSilent,
    status: decision === 'denied' ? 'permission_denied' : decision === 'cancelled' ? 'cancelled' : current?.status ?? 'requested',
    createdAt: current?.createdAt ?? recordedAt,
    sourceMessageId: current?.sourceMessageId,
    executionIntentId: current?.executionIntentId,
    executionIntentSource: current?.executionIntentSource,
    startedAt: current?.startedAt,
    finishedAt: current?.finishedAt,
    resultSummary: current?.resultSummary,
    errorMessage: current?.errorMessage,
    musicPlayback: current?.musicPlayback,
    scheduleSave: current?.scheduleSave,
    routineSave: current?.routineSave,
    phoneLimitSave: current?.phoneLimitSave,
    agent: current?.agent,
  }), batch);
}

export async function recordToolExecutionStarted(
  callId: string,
  executionId?: string,
  batch?: ToolAuditWriteBatch,
) {
  const startedAt = Date.now();
  await upsertAuditRecord(callId, (current) => ({
    callId,
    executionId: executionId ?? current?.executionId,
    toolId: current?.toolId ?? '',
    packageId: current?.packageId ?? '',
    source: current?.source ?? 'manual',
    inputPreview: current?.inputPreview ?? {},
    permissionDecision: current?.permissionDecision ?? 'not_checked',
    permissionSource: current?.permissionSource,
    permissionGrantId: current?.permissionGrantId,
    permissionExpiresAt: current?.permissionExpiresAt,
    permissionSilent: current?.permissionSilent,
    status: 'running',
    createdAt: current?.createdAt ?? startedAt,
    sourceMessageId: current?.sourceMessageId,
    executionIntentId: current?.executionIntentId,
    executionIntentSource: current?.executionIntentSource,
    startedAt,
    finishedAt: current?.finishedAt,
    resultSummary: current?.resultSummary,
    errorMessage: current?.errorMessage,
    musicPlayback: current?.musicPlayback,
    scheduleSave: current?.scheduleSave,
    routineSave: current?.routineSave,
    phoneLimitSave: current?.phoneLimitSave,
    agent: current?.agent,
  }), batch);
}

export async function recordToolExecutionResult(
  callId: string,
  result: JunLuoToolResult,
  executionId?: string,
  batch?: ToolAuditWriteBatch,
) {
  await upsertAuditRecord(callId, (current) => ({
    callId,
    executionId: executionId ?? current?.executionId,
    toolId: current?.toolId || result.toolId,
    packageId: current?.packageId ?? '',
    source: current?.source ?? 'manual',
    inputPreview: current?.inputPreview ?? {},
    permissionDecision: current?.permissionDecision ?? 'not_checked',
    permissionSource: current?.permissionSource,
    permissionGrantId: current?.permissionGrantId,
    permissionExpiresAt: current?.permissionExpiresAt,
    permissionSilent: current?.permissionSilent,
    status: result.status === 'success'
      ? 'success'
      : result.status === 'permission_denied'
        ? 'permission_denied'
        : result.status === 'cancelled'
          ? 'cancelled'
          : 'error',
    createdAt: current?.createdAt ?? result.startedAt,
    sourceMessageId: current?.sourceMessageId,
    executionIntentId: current?.executionIntentId,
    executionIntentSource: current?.executionIntentSource,
    startedAt: current?.startedAt ?? result.startedAt,
    finishedAt: result.finishedAt,
    resultSummary: sanitizeToolAuditText(result.summary),
    errorMessage: result.error?.message
      ? sanitizeToolAuditText(result.error.message)
      : undefined,
    musicPlayback: current?.musicPlayback,
    scheduleSave: current?.scheduleSave,
    routineSave: current?.routineSave,
    phoneLimitSave: current?.phoneLimitSave,
    agent: current?.agent,
  }), batch);
}

export async function recordToolAgentAuditMetadata(
  callId: string,
  update: Partial<JunLuoToolAgentAuditMetadata>,
) {
  await upsertAuditRecord(callId, (current) => {
    if (!current?.agent) throw new Error('TOOL_AGENT_AUDIT_RECORD_NOT_FOUND');
    return {
      ...current,
      agent: {
        ...current.agent,
        ...update,
      },
    };
  });
}

export async function flushToolAuditWriteBatch(
  batch: ToolAuditWriteBatch,
  diagnosticParentToken?: number,
) {
  try {
    if (batch.flushed || !batch.updates.length) return;
    const updates = [...batch.updates];
    await upsertAuditRecord(batch.callId, (current) => (
      updates.reduce<JunLuoToolAuditRecord | undefined>(
        (record, update) => update(record),
        current,
      )!
    ), undefined, diagnosticParentToken);
    batch.flushed = true;
  } finally {
    if (pendingAuditBatches.get(batch.callId)?.batch === batch) pendingAuditBatches.delete(batch.callId);
  }
}

export async function recordMusicPlaybackObservation(
  call: JunLuoToolCall,
  observation: MusicPlaybackObservation,
  dataEpoch: number,
): Promise<boolean> {
  if (call.toolId !== 'music.play') return false;
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) {
    pendingAuditBatches.delete(call.callId);
    return false;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const events = normalizeMusicPlaybackObservations([observation]);
      if (events.length !== 1) return false;
      const commit = await runBackupRestoreDataEpochCommit(dataEpoch, () => upsertAuditRecord(call.callId, current => {
        const pending = pendingAuditBatches.get(call.callId)?.batch;
        const record = current ?? pending?.updates.reduce<JunLuoToolAuditRecord | undefined>(
          (value, update) => update(value), undefined,
        );
        if (!record) throw new Error('MUSIC_OBSERVATION_ORIGINAL_CALL_UNAVAILABLE');
        if (record.toolId !== call.toolId || record.createdAt !== call.createdAt) {
          throw new Error('MUSIC_OBSERVATION_CALL_MISMATCH');
        }
        return { ...record, musicPlayback: mergeMusicPlaybackObservations(record.musicPlayback, events) };
      }));
      return commit.committed;
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
      if (attempt === 3) console.warn('[tool-audit] music observation save failed');
    }
  }
  return false;
}

export async function recordToolAgentAuditStatus(
  callId: string,
  status: Extract<
    JunLuoToolAuditRecord['status'],
    'awaiting_permission' | 'awaiting_confirmation' | 'outcome_unknown'
  >,
) {
  await upsertAuditRecord(callId, (current) => {
    if (!current) throw new Error('TOOL_AGENT_AUDIT_RECORD_NOT_FOUND');
    if (current.toolId === 'camera.look_once' && status === 'outcome_unknown'
      && ['success', 'error', 'cancelled', 'permission_denied'].includes(current.status)) return current;
    return {
      ...current,
      status,
      finishedAt: status === 'outcome_unknown' ? Date.now() : undefined,
    };
  });
}

export async function loadRecentToolCalls(limit = 50) {
  const records = await enqueueToolAuditWrite(() => loadAuditRecords());
  return records
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, Math.max(1, Math.min(MAX_AUDIT_RECORDS, Math.round(limit))));
}

export async function clearToolAuditLogForTests() {
  await enqueueToolAuditWrite(
    () => AsyncStorage.removeItem(TOOL_AUDIT_LOG_KEY),
  );
}

export async function loadToolAuditRecord(callId: string) {
  return (await enqueueToolAuditWrite(() => loadAuditRecords())).find(record => record.callId === callId) ?? null;
}

/** Claim once in the existing audit queue. A later host timestamp cannot replace the first facts. */
export async function claimPhoneLimitSave(call: JunLuoToolCall, dataEpoch: number, inputHash: string) {
  const initial = normalizePhoneLimitSave({ dataEpoch, toolId: call.toolId, inputHash, prepared: null, result: null }, call.callId, call.toolId);
  if (!initial) throw new Error('PHONE_LIMIT_AUDIT_INVALID');
  let claimed = false; let state = initial;
  await upsertAuditRecord(call.callId, current => {
    if (current?.phoneLimitSave !== undefined) {
      const existing = normalizePhoneLimitSave(current.phoneLimitSave, call.callId, call.toolId);
      if (!existing || existing.inputHash !== inputHash || existing.dataEpoch !== dataEpoch) throw new Error('PHONE_LIMIT_AUDIT_MISMATCH');
      state = existing;
      return current;
    }
    if (current && current.toolId !== call.toolId) throw new Error('PHONE_LIMIT_AUDIT_MISMATCH');
    claimed = true;
    return { callId: call.callId, toolId: call.toolId, packageId: 'phone_limit', source: call.requestedBy,
      inputPreview: {}, permissionDecision: 'allowed', status: 'running', createdAt: call.createdAt,
      ...current, phoneLimitSave: initial };
  }, undefined, undefined, true);
  return { claimed, state };
}

async function updatePhoneLimitSave(callId: string, dataEpoch: number, inputHash: string,
  update: (state: PhoneLimitSave) => PhoneLimitSave) {
  let result: PhoneLimitSave | undefined;
  await upsertAuditRecord(callId, current => {
    const state = current && normalizePhoneLimitSave(current.phoneLimitSave, callId, current.toolId);
    if (!current || !state || state.dataEpoch !== dataEpoch || state.inputHash !== inputHash) throw new Error('PHONE_LIMIT_AUDIT_MISMATCH');
    result = normalizePhoneLimitSave(update(state), callId, current.toolId) ?? undefined;
    if (!result) throw new Error('PHONE_LIMIT_AUDIT_INVALID');
    return { ...current, phoneLimitSave: result };
  }, undefined, undefined, true);
  return result!;
}

export function recordPhoneLimitPrepared(callId: string, dataEpoch: number, inputHash: string, prepared: NonNullable<PhoneLimitSave['prepared']>) {
  return updatePhoneLimitSave(callId, dataEpoch, inputHash, state => {
    if (state.prepared !== null) {
      const normalized = normalizePhoneLimitSave({ ...state, prepared }, callId, state.toolId);
      if (!normalized || JSON.stringify(normalized.prepared) !== JSON.stringify(state.prepared)) throw new Error('PHONE_LIMIT_AUDIT_PREPARED_MISMATCH');
      return state;
    }
    if (state.result !== null) throw new Error('PHONE_LIMIT_AUDIT_ALREADY_SETTLED');
    return { ...state, prepared };
  });
}

export function recordPhoneLimitResult(callId: string, dataEpoch: number, inputHash: string, result: JunLuoToolResult) {
  return updatePhoneLimitSave(callId, dataEpoch, inputHash, state => ({ ...state, result }));
}

export async function recordOwnScheduleSave(call: JunLuoToolCall, state: OwnScheduleSave) {
  const normalized = normalizeOwnScheduleSave(state);
  if (call.toolId !== 'schedule.save_own' || !normalized || normalized.batch.opId !== call.callId) {
    throw new Error('OWN_SCHEDULE_SAVE_INVALID');
  }
  await upsertAuditRecord(call.callId, current => {
    if (current && (current.toolId !== call.toolId || current.createdAt !== call.createdAt)) throw new Error('OWN_SCHEDULE_CALL_MISMATCH');
    if (current?.scheduleSave && (current.scheduleSave.dataEpoch !== state.dataEpoch
      || current.scheduleSave.attempts > state.attempts)) throw new Error('OWN_SCHEDULE_SAVE_STALE');
    return { callId: call.callId, toolId: call.toolId, packageId: 'schedule', source: call.requestedBy,
      inputPreview: {}, permissionDecision: 'allowed', status: 'running', createdAt: call.createdAt,
      ...current, scheduleSave: normalized };
  });
}

export async function recordUserRoutineSave(call: JunLuoToolCall, state: UserRoutineSaveState) {
  const normalized = normalizeUserRoutineSave(state);
  if (call.toolId !== 'schedule.save_routine' || !normalized || state.operationId !== call.callId) throw new Error('ROUTINE_SAVE_INVALID');
  await upsertAuditRecord(call.callId, current => {
    if (current && (current.toolId !== call.toolId || current.createdAt !== call.createdAt)) throw new Error('ROUTINE_CALL_MISMATCH');
    if (current?.routineSave && (current.routineSave.dataEpoch !== state.dataEpoch || current.routineSave.attempts > state.attempts)) throw new Error('ROUTINE_SAVE_STALE');
    return { callId: call.callId, toolId: call.toolId, packageId: 'schedule', source: call.requestedBy,
      inputPreview: {}, permissionDecision: 'allowed', createdAt: call.createdAt,
      ...current, routineSave: normalized, status: state.stage === 'complete' ? 'success'
        : state.stage === 'failed' ? 'error' : state.stage === 'unknown' ? 'outcome_unknown' : 'running' };
  });
}

export async function recordCameraToolReply(callId: string, reply: { sessionId: string; messageIds: string[] }) {
  await upsertAuditRecord(callId, current => {
    if (!current || current.toolId !== 'camera.look_once') throw new Error('CAMERA_TOOL_AUDIT_NOT_FOUND');
    if (current.cameraReply && current.cameraReply.sessionId !== reply.sessionId) throw new Error('CAMERA_TOOL_REPLY_SESSION_MISMATCH');
    return { ...current, cameraReply: { sessionId: reply.sessionId,
      messageIds: [...new Set([...(current.cameraReply?.messageIds ?? []), ...reply.messageIds])].slice(0, 24) } };
  });
}

export async function loadToolExecutionOutcome(callId: string) {
  const record = (await enqueueToolAuditWrite(() => loadAuditRecords())).find(
    (item) => item.callId === callId,
  );
  if (!record || record.status === 'requested' || record.status === 'running') {
    return null;
  }
  if (record.status === 'success') return 'completed' as const;
  if (record.status === 'cancelled') return 'cancelled' as const;
  return 'failed' as const;
}
