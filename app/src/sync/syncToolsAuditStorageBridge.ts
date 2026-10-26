import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type { JunLuoToolAuditRecord } from '../tools/toolAuditTypes';
import {
  observeRuntimeWorkload,
  type RuntimeWorkloadCounts,
  type RuntimeWorkloadStage,
} from '../runtime/runtimeWorkloadDiagnostics';
import { hasCurrentSyncDeviceSelection } from './syncCurrentDeviceSelection';
const TOOLS_AUDIT_LOG_KEY =
  'junluo.tools.auditLog.v1' as const;

type ToolsAuditStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

type ToolsAuditKnownRecordChange = {
  previous?: JunLuoToolAuditRecord;
  next: JunLuoToolAuditRecord;
};

type ToolsAuditCapturedChangeOptions = {
  diagnosticParentToken?: number;
  recordChange?: ToolsAuditKnownRecordChange;
};

function observeToolsAuditBridgeStage<T>(
  stage: RuntimeWorkloadStage,
  operation: () => Promise<T>,
  options: ToolsAuditCapturedChangeOptions,
  summarize?: (value: T) => RuntimeWorkloadCounts,
) {
  return options.diagnosticParentToken
    ? observeRuntimeWorkload(
        stage,
        operation,
        summarize,
        { parentToken: options.diagnosticParentToken },
      )
    : operation();
}

async function performCapturedChange<T>(
  changes: readonly ToolsAuditStorageChange[],
  performBusinessWrite: () => Promise<T>,
  options: ToolsAuditCapturedChangeOptions = {},
) {
  const globalSetChanges = changes.filter(
    (change) => (
      change.kind === 'set'
      && change.key === TOOLS_AUDIT_LOG_KEY
    ),
  );
  if (!globalSetChanges.length) return performBusinessWrite();
  const writeBusinessValue = () => observeToolsAuditBridgeStage(
    'tools.audit.storage_set',
    performBusinessWrite,
    options,
  );
  if (!(await hasCurrentSyncDeviceSelection())) return writeBusinessValue();
  const prepared = await observeToolsAuditBridgeStage(
    'tools.audit.sync_prepare',
    async () => {
      const [
        { TOOLS_AUDIT_BATCH_CAPTURE_POLICY },
        { runToolsAuditCaptureExclusive },
        {
          deriveToolsAuditMutationsForRecordChange,
          deriveToolsAuditMutationsForStorageChanges,
        },
        { loadCurrentSyncDevice },
        { captureSyncMutationBatch },
        { createSyncMutationEnvelope },
        {
          enqueueSyncMutationAndAdvanceHeads,
          syncMutationStatePort,
        },
        {
          advanceSyncDurableIntent,
          prepareSyncDurableIntent,
        },
        { expoSyncRandomUuidV1 },
      ] = await Promise.all([
        import('./syncToolsAuditApply'),
        import('./syncToolsAuditCaptureQueue'),
        import('./syncToolsAuditStorageDerivation'),
        import('./syncCurrentDevice'),
        import('./syncMutationBatchCapture'),
        import('./syncMutationEnvelope'),
        import('./syncMutationStateStore'),
        import('./syncStore'),
        import('./syncCryptoExpo'),
      ]);
      return {
        TOOLS_AUDIT_BATCH_CAPTURE_POLICY,
        runToolsAuditCaptureExclusive,
        deriveToolsAuditMutationsForRecordChange,
        deriveToolsAuditMutationsForStorageChanges,
        captureSyncMutationBatch,
        createSyncMutationEnvelope,
        enqueueSyncMutationAndAdvanceHeads,
        syncMutationStatePort,
        advanceSyncDurableIntent,
        prepareSyncDurableIntent,
        expoSyncRandomUuidV1,
        loadCurrentSyncDevice,
      };
    },
    options,
  );
  if (!prepared) return writeBusinessValue();
  return observeToolsAuditBridgeStage(
    'tools.audit.sync_queue',
    () => prepared.runToolsAuditCaptureExclusive(async () => {
      const currentDevice = await observeToolsAuditBridgeStage(
        'tools.audit.sync_device',
        prepared.loadCurrentSyncDevice,
        options,
      );
      if (!currentDevice) return writeBusinessValue();
      const durableCapture = {
        prepareSyncDurableIntent: prepared.prepareSyncDurableIntent,
        advanceSyncDurableIntent: prepared.advanceSyncDurableIntent,
        enqueueSyncMutation: prepared.enqueueSyncMutationAndAdvanceHeads,
      };
      const now = Date.now();
      const envelopeFactory = (entity: {
        domain: 'tools';
        type: 'call-intent' | 'call-result' | 'audit-event';
        id: string;
      }) => prepared.createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: prepared.syncMutationStatePort,
        randomUuid: prepared.expoSyncRandomUuidV1,
        now: () => now,
      });
      const mutations = await observeToolsAuditBridgeStage(
        'tools.audit.sync_derive',
        () => options.recordChange
          ? prepared.deriveToolsAuditMutationsForRecordChange({
              ...options.recordChange,
              capturedAt: now,
              envelopeFactory,
            })
          : prepared.deriveToolsAuditMutationsForStorageChanges({
              changes: globalSetChanges,
              reader: RawAsyncStorage,
              capturedAt: now,
              envelopeFactory,
            }),
        options,
        (value) => ({ itemCount: value.length }),
      );
      if (!mutations.length) return writeBusinessValue();
      let value!: T;
      await observeToolsAuditBridgeStage(
        'tools.audit.sync_capture',
        () => prepared.captureSyncMutationBatch({
          operationId: prepared.expoSyncRandomUuidV1(),
          policy: prepared.TOOLS_AUDIT_BATCH_CAPTURE_POLICY,
          durableCapture,
          mutations,
          performBusinessWrite: async () => {
            value = await writeBusinessValue();
          },
          now: () => now,
        }),
        options,
        () => ({ itemCount: mutations.length }),
      );
      return value;
    }),
    options,
  );
}

export const toolsAuditStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  setItem: (key: string, value: string) =>
    performCapturedChange(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  setItemForRecordChange: (
    key: string,
    value: string,
    recordChange: ToolsAuditKnownRecordChange,
    diagnosticParentToken?: number,
  ) => performCapturedChange(
    [{ kind: 'set', key, value }],
    () => RawAsyncStorage.setItem(key, value),
    { diagnosticParentToken, recordChange },
  ),
  removeItem: (key: string) =>
    performCapturedChange(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
};
