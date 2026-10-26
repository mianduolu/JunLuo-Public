import RawAsyncStorage from '@react-native-async-storage/async-storage';
import type { JunLuoToolAuditRecord } from '../tools/toolAuditTypes';
import { enqueueToolAuditWrite } from '../tools/toolAuditStore';

import {
  assertToolsAuditRecord,
} from './syncToolsAudit';
import type {
  ToolsAuditBusinessPort,
} from './syncToolsAuditApply';
import {
  mergeToolsAuditProjection,
  repairLegacyToolsAuditFallback,
} from './syncToolsAuditMerge';
import {
  parseToolsAuditStorageRaw,
  serializeToolsAuditStorageRecords,
  TOOLS_AUDIT_LOG_KEY,
} from './syncToolsAuditStorageDerivation';

async function upsertAuditRecord(
  input: Parameters<
    ToolsAuditBusinessPort['upsertAuditRecord']
  >[0],
) {
  assertToolsAuditRecord(
    input.kind,
    input.value.callId,
    input.value,
  );
  const raw = await RawAsyncStorage.getItem(TOOLS_AUDIT_LOG_KEY);
  const current = parseToolsAuditStorageRaw(raw);
  // Local camera replies are ID links, not a new desktop/wire field. The
  // projection parser deliberately discards them; preserve them on this device.
  let localCameraReplies = new Map<string, unknown>();
  let localPhoneLimitSaves = new Map<string, unknown>();
  try {
    const records: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(records)) localCameraReplies = new Map(records.filter(record =>
      record?.toolId === 'camera.look_once' && record.cameraReply).map(record => [record.callId, record.cameraReply]));
    if (Array.isArray(records)) localPhoneLimitSaves = new Map(records.filter(record =>
      record?.phoneLimitSave !== undefined).map(record => [record.callId, record.phoneLimitSave]));
  } catch { /* The existing projection parser owns malformed storage handling. */ }
  const index = current.findIndex(
    (record) => record.callId === input.value.callId,
  );
  const currentRecord = index >= 0 ? current[index]! : null;
  const repairedCurrent = currentRecord
    ? repairLegacyToolsAuditFallback({
        kind: input.kind,
        current: input.value,
        incoming: currentRecord,
      })
    : null;
  const incoming = repairedCurrent
    ? repairLegacyToolsAuditFallback({
        kind: input.kind,
        current: repairedCurrent,
        incoming: input.value,
      })
    : input.value;
  const merged = mergeToolsAuditProjection({
    current: repairedCurrent,
    incoming,
  });
  if (index >= 0) current[index] = merged;
  else current.push(merged);
  await RawAsyncStorage.setItem(
    TOOLS_AUDIT_LOG_KEY,
    JSON.stringify((JSON.parse(serializeToolsAuditStorageRecords(current)) as JunLuoToolAuditRecord[])
      .map(record => ({ ...record,
        ...(localCameraReplies.has(record.callId) && record.toolId === 'camera.look_once'
          ? { cameraReply: localCameraReplies.get(record.callId) } : {}),
        ...(localPhoneLimitSaves.has(record.callId) ? { phoneLimitSave: localPhoneLimitSaves.get(record.callId) } : {}),
      }))),
  );
}

async function deleteAuditEvent(
  input: Parameters<
    ToolsAuditBusinessPort['deleteAuditEvent']
  >[0],
) {
  void input;
  // Android 的单条本机记录同时承载长期正式 intent/result；
  // audit-event 墓碑只删除独立共享技术投影，不能连带抹掉正式记录。
}

export const toolsAuditAsyncStorageBusinessPort:
ToolsAuditBusinessPort = {
  upsertAuditRecord: (input) => enqueueToolAuditWrite(
    () => upsertAuditRecord(input),
  ),
  deleteAuditEvent: (input) => enqueueToolAuditWrite(
    () => deleteAuditEvent(input),
  ),
};
