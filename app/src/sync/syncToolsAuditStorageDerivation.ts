import type {
  JunLuoToolAuditRecord,
  JunLuoToolInputPreviewValue,
  JunLuoToolPermissionAuthorizationSource,
  JunLuoToolPermissionDecision,
} from '../tools/toolAuditTypes';
import {
  previewToolInputValue,
  sanitizeToolAuditFieldName,
  sanitizeToolAuditText,
} from '../tools/toolInputPreview';
import type { JunLuoToolCallSource } from '../tools/toolTypes';
import { mergeMusicPlaybackObservations, normalizeMusicPlaybackObservations } from '../music/musicPlaybackObservation';
import { mergeOwnScheduleSaves, normalizeOwnScheduleSave } from '../schedule/ownScheduleSaveState';
import { mergeUserRoutineSaves, normalizeUserRoutineSave } from '../schedule/userRoutineSaveState';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  buildToolsAuditMutation,
  type ToolsAuditRecordKind,
  type ToolsAuditRecordValue,
} from './syncToolsAudit';
import type { PlainMutationV1 } from './syncProtocol';

export const TOOLS_AUDIT_LOG_KEY =
  'junluo.tools.auditLog.v1' as const;
export const TOOLS_AUDIT_MAX_LOCAL_RECORDS = 200 as const;

const TOOL_CALL_SOURCES = new Set<JunLuoToolCallSource>([
  'chat',
  'proactive',
  'life_agent',
  'social_agent',
  'background',
  'manual',
]);

const PERMISSION_DECISIONS =
new Set<JunLuoToolPermissionDecision>([
  'not_checked',
  'allowed',
  'denied',
  'cancelled',
]);

const PERMISSION_SOURCES =
new Set<JunLuoToolPermissionAuthorizationSource>([
  'bypass',
  'tool_override',
  'package_override',
  'global_default',
  'tool_definition',
  'risk_default',
  'session_grant',
  'today_grant',
  'parameter_grant',
  'prompt',
]);

const AUDIT_STATUSES =
new Set<JunLuoToolAuditRecord['status']>([
  'requested',
  'permission_denied',
  'running',
  'success',
  'error',
  'cancelled',
]);

const TERMINAL_STATUSES =
new Set<JunLuoToolAuditRecord['status']>([
  'permission_denied',
  'success',
  'error',
  'cancelled',
]);

type UnknownRecord = Record<string, unknown>;

export type ToolsAuditStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type ToolsAuditStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type ToolsAuditEnvelopeFactory = (
  entity: {
    domain: 'tools';
    type: 'call-intent' | 'call-result' | 'audit-event';
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type ToolsAuditProjectedRecord = {
  kind: ToolsAuditRecordKind;
  entityId: string;
  value: ToolsAuditRecordValue;
};

function finiteTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function optionalString(
  value: unknown,
  maximumLength: number,
) {
  return typeof value === 'string'
    ? value.slice(0, maximumLength)
    : undefined;
}

function sanitizeStoredPreviewValue(
  value: unknown,
  fieldName: string,
): JunLuoToolInputPreviewValue {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (
      value === '[redacted]'
      || /^\[private text: \d+ chars\]$/u.test(value)
    ) {
      return value;
    }
    return previewToolInputValue(value, fieldName);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const item = value as {
      type?: unknown;
      length?: unknown;
      keys?: unknown;
    };
    if (
      item.type === 'array'
      && typeof item.length === 'number'
      && Number.isFinite(item.length)
    ) {
      return {
        type: 'array',
        length: Math.max(0, Math.round(item.length)),
      };
    }
    if (item.type === 'object' && Array.isArray(item.keys)) {
      return {
        type: 'object',
        keys: item.keys
          .filter((key): key is string => typeof key === 'string')
          .slice(0, 12)
          .map(sanitizeToolAuditFieldName),
      };
    }
    if (item.type === 'unknown') return { type: 'unknown' };
  }
  return previewToolInputValue(value, fieldName);
}

function normalizeInputPreview(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as UnknownRecord)
      .slice(0, 12)
      .map(([key, nested]) => {
        const fieldName = sanitizeToolAuditFieldName(key);
        return [
          fieldName,
          sanitizeStoredPreviewValue(nested, fieldName),
        ];
      }),
  );
}

export function normalizeToolsAuditStorageRecord(
  value: unknown,
): JunLuoToolAuditRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const item = value as Partial<JunLuoToolAuditRecord>;
  if (
    typeof item.callId !== 'string'
    || !item.callId
    || typeof item.toolId !== 'string'
    || !item.toolId
    || typeof item.packageId !== 'string'
    || finiteTimestamp(item.createdAt) === undefined
  ) {
    return null;
  }
  const source = TOOL_CALL_SOURCES.has(item.source as JunLuoToolCallSource)
    ? item.source as JunLuoToolCallSource
    : 'manual';
  const permissionDecision = PERMISSION_DECISIONS.has(
    item.permissionDecision as JunLuoToolPermissionDecision,
  )
    ? item.permissionDecision as JunLuoToolPermissionDecision
    : 'not_checked';
  const permissionSource = PERMISSION_SOURCES.has(
    item.permissionSource as JunLuoToolPermissionAuthorizationSource,
  )
    ? item.permissionSource as JunLuoToolPermissionAuthorizationSource
    : undefined;
  const status = AUDIT_STATUSES.has(
    item.status as JunLuoToolAuditRecord['status'],
  )
    ? item.status as JunLuoToolAuditRecord['status']
    : 'requested';
  const startedAt = finiteTimestamp(item.startedAt);
  const finishedAt = finiteTimestamp(item.finishedAt);
  return {
    callId: item.callId.slice(0, 512),
    ...(optionalString(item.executionId, 512)
      ? { executionId: optionalString(item.executionId, 512) }
      : {}),
    toolId: item.toolId.slice(0, 256),
    packageId: item.packageId.slice(0, 256),
    source,
    ...(optionalString(item.sourceMessageId, 512)
      ? { sourceMessageId: optionalString(item.sourceMessageId, 512) }
      : {}),
    inputPreview: normalizeInputPreview(item.inputPreview),
    permissionDecision,
    ...(permissionSource ? { permissionSource } : {}),
    ...(optionalString(item.permissionGrantId, 240)
      ? {
          permissionGrantId: sanitizeToolAuditText(
            String(item.permissionGrantId),
          ),
        }
      : {}),
    ...(finiteTimestamp(item.permissionExpiresAt) !== undefined
      ? {
          permissionExpiresAt: finiteTimestamp(
            item.permissionExpiresAt,
          ),
        }
      : {}),
    ...(typeof item.permissionSilent === 'boolean'
      ? { permissionSilent: item.permissionSilent }
      : {}),
    status,
    ...(typeof item.resultSummary === 'string'
      ? {
          resultSummary: sanitizeToolAuditText(
            item.resultSummary,
          ),
        }
      : {}),
    ...(typeof item.errorMessage === 'string'
      ? {
          errorMessage: sanitizeToolAuditText(
            item.errorMessage,
          ),
        }
      : {}),
    createdAt: Number(item.createdAt),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(item.toolId === 'music.play' && item.musicPlayback !== undefined
      ? { musicPlayback: normalizeMusicPlaybackObservations(item.musicPlayback) } : {}),
    ...(item.toolId === 'schedule.save_own' && normalizeOwnScheduleSave(item.scheduleSave)
      ? { scheduleSave: normalizeOwnScheduleSave(item.scheduleSave) } : {}),
    ...(item.toolId === 'schedule.save_routine' && normalizeUserRoutineSave(item.routineSave)
      ? { routineSave: normalizeUserRoutineSave(item.routineSave) } : {}),
  };
}

export function normalizeToolsAuditStorageRecords(value: unknown) {
  if (!Array.isArray(value)) return [] as JunLuoToolAuditRecord[];
  const byCallId = new Map<string, JunLuoToolAuditRecord>();
  for (const item of value) {
    const record = normalizeToolsAuditStorageRecord(item);
    if (record) {
      const previous = byCallId.get(record.callId);
      if (previous?.musicPlayback || record.musicPlayback) {
        record.musicPlayback = mergeMusicPlaybackObservations(previous?.musicPlayback, record.musicPlayback);
      }
      if (previous?.scheduleSave || record.scheduleSave) record.scheduleSave = mergeOwnScheduleSaves(previous?.scheduleSave, record.scheduleSave);
      if (previous?.routineSave || record.routineSave) record.routineSave = mergeUserRoutineSaves(previous?.routineSave, record.routineSave);
      byCallId.set(record.callId, record);
    }
  }
  return [...byCallId.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .slice(-TOOLS_AUDIT_MAX_LOCAL_RECORDS);
}

export function parseToolsAuditStorageRaw(raw: string | null) {
  if (!raw) return [] as JunLuoToolAuditRecord[];
  try {
    return normalizeToolsAuditStorageRecords(
      JSON.parse(raw) as unknown,
    );
  } catch {
    return [] as JunLuoToolAuditRecord[];
  }
}

export function serializeToolsAuditStorageRecords(
  records: readonly JunLuoToolAuditRecord[],
) {
  return JSON.stringify(
    normalizeToolsAuditStorageRecords(records),
  );
}

function callIntentValue(
  record: JunLuoToolAuditRecord,
): ToolsAuditRecordValue {
  return {
    callId: record.callId,
    toolId: record.toolId,
    packageId: record.packageId,
    source: record.source,
    ...(record.sourceMessageId
      ? { sourceMessageId: record.sourceMessageId }
      : {}),
    inputPreview: record.inputPreview,
    permissionDecision: 'not_checked',
    status: 'requested',
    createdAt: record.createdAt,
  };
}

function terminalResultValue(
  record: JunLuoToolAuditRecord,
) {
  if (
    !TERMINAL_STATUSES.has(record.status)
    || record.finishedAt === undefined
  ) {
    return null;
  }
  const result = { ...record } as ToolsAuditRecordValue;
  delete result.musicPlayback;
  delete result.scheduleSave;
  delete result.routineSave;
  return result;
}

export function projectToolsAuditRecord(
  record: JunLuoToolAuditRecord,
): ToolsAuditProjectedRecord[] {
  const projected: ToolsAuditProjectedRecord[] = [
    {
      kind: 'call-intent',
      entityId: record.callId,
      value: callIntentValue(record),
    },
    {
      kind: 'audit-event',
      entityId: record.callId,
      value: { ...record },
    },
  ];
  const result = terminalResultValue(record);
  if (result) {
    projected.push({
      kind: 'call-result',
      entityId: record.callId,
      value: result,
    });
  }
  return projected;
}

export function projectToolsAuditStorage(
  raw: string | null,
) {
  return parseToolsAuditStorageRaw(raw)
    .flatMap(projectToolsAuditRecord);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as UnknownRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

function projectionKey(record: ToolsAuditProjectedRecord) {
  return `${record.kind}\u0000${record.entityId}`;
}

function entityType(kind: ToolsAuditRecordKind) {
  return kind;
}

async function mutationsForProjectionChanges(input: {
  previous: readonly ToolsAuditProjectedRecord[];
  next: readonly ToolsAuditProjectedRecord[];
  capturedAt: number;
  envelopeFactory: ToolsAuditEnvelopeFactory;
}) {
  const previousByKey = new Map(
    input.previous.map((record) => [
      projectionKey(record),
      record,
    ]),
  );
  const mutations: PlainMutationV1[] = [];
  for (const record of input.next) {
    const previous = previousByKey.get(projectionKey(record));
    if (
      previous
      && canonicalJson(previous.value)
        === canonicalJson(record.value)
    ) {
      continue;
    }
    const envelope = await input.envelopeFactory({
      domain: 'tools',
      type: entityType(record.kind),
      id: record.entityId,
    });
    mutations.push(buildToolsAuditMutation({
      envelope: {
        ...envelope,
        createdAt: input.capturedAt,
      },
      kind: record.kind,
      value: record.value,
    }));
  }
  return mutations;
}

export async function deriveToolsAuditMutationsForRecordChange(
  input: {
    previous?: JunLuoToolAuditRecord;
    next: JunLuoToolAuditRecord;
    capturedAt: number;
    envelopeFactory: ToolsAuditEnvelopeFactory;
  },
) {
  const previous = input.previous
    ? normalizeToolsAuditStorageRecord(input.previous)
    : null;
  const next = normalizeToolsAuditStorageRecord(input.next);
  if (!next) return [] as PlainMutationV1[];
  return mutationsForProjectionChanges({
    previous: previous ? projectToolsAuditRecord(previous) : [],
    next: projectToolsAuditRecord(next),
    capturedAt: input.capturedAt,
    envelopeFactory: input.envelopeFactory,
  });
}

export function isToolsAuditGlobalStorageKey(key: string) {
  return key === TOOLS_AUDIT_LOG_KEY;
}

export async function deriveToolsAuditMutationsForStorageChanges(
  input: {
    changes: readonly ToolsAuditStorageChange[];
    reader: ToolsAuditStorageReadPort;
    capturedAt: number;
    envelopeFactory: ToolsAuditEnvelopeFactory;
  },
) {
  const applicable = input.changes.filter(
    (change) => (
      isToolsAuditGlobalStorageKey(change.key)
      && change.kind === 'set'
    ),
  );
  if (!applicable.length) return [] as PlainMutationV1[];
  const previousRaw = await input.reader.getItem(
    TOOLS_AUDIT_LOG_KEY,
  );
  const last = applicable[applicable.length - 1]!;
  const nextRaw = last.kind === 'set' ? last.value : null;
  return mutationsForProjectionChanges({
    previous: projectToolsAuditStorage(previousRaw),
    next: projectToolsAuditStorage(nextRaw),
    capturedAt: input.capturedAt,
    envelopeFactory: input.envelopeFactory,
  });
}

export async function deriveToolsAuditBootstrapMutations(input: {
  raw: string | null;
  capturedAt: number;
  envelopeFactory: ToolsAuditEnvelopeFactory;
}) {
  return mutationsForProjectionChanges({
    previous: [],
    next: projectToolsAuditStorage(input.raw),
    capturedAt: input.capturedAt,
    envelopeFactory: input.envelopeFactory,
  });
}
