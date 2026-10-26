import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  ToolsWorkspaceStorageChange,
} from './syncToolsWorkspaceStorageDerivation';
import { hasCurrentSyncDeviceSelection } from './syncCurrentDeviceSelection';
const FILES_KEY = 'junluo.tools.files.imports.v1' as const;
const FILE_INDEX_KEY = 'junluo.sync.tools.workspace.files.v1' as const;

let fileRecordsQueue: Promise<void> = Promise.resolve();

// Shared by local registration and received file materialization. Lock the
// read-modify-write, not merely the final storage write.
export function runToolsWorkspaceFileRecordsExclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = fileRecordsQueue.then(operation);
  fileRecordsQueue = result.then(() => undefined, () => undefined);
  return result;
}

export class ToolsWorkspacePendingFileCaptureError extends Error {
  readonly toolsWorkspaceFileCapturePending = true;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : '文件同步保存结果尚未确认', { cause });
  }
}

const GLOBAL_KEYS = new Set([
  'junluo.tool.workflows.v1',
  'junluo.tools.browser.records.v1',
  'junluo.tool.mcp.servers.v1',
  'junluo.tools.github.settings.v1',
  FILES_KEY,
  'junluo.tools.permissions.v1',
]);

async function performCapturedChanges<T>(
  changes: readonly ToolsWorkspaceStorageChange[],
  performBusinessWrite: () => Promise<T>,
  options: { forceCapture?: boolean } = {},
) {
  const applicable = changes.filter((change) =>
    GLOBAL_KEYS.has(change.key));
  if (!applicable.length) return performBusinessWrite();
  if (!(await hasCurrentSyncDeviceSelection())) return performBusinessWrite();
  const [
    {
      parseToolsWorkspaceFileIndex,
      readToolsWorkspaceProjection,
      storageOverridesForChanges,
    },
    { TOOLS_WORKSPACE_BATCH_CAPTURE_POLICY },
    { runToolsWorkspaceCaptureExclusive },
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
    { deriveToolsWorkspaceMutations },
  ] = await Promise.all([
    import('./syncToolsWorkspaceStorageDerivation'),
    import('./syncToolsWorkspaceApply'),
    import('./syncToolsWorkspaceCaptureQueue'),
    import('./syncCurrentDevice'),
    import('./syncMutationBatchCapture'),
    import('./syncMutationEnvelope'),
    import('./syncMutationStateStore'),
    import('./syncStore'),
    import('./syncCryptoExpo'),
    import('./syncToolsWorkspaceStorageDerivation'),
  ]);
  return runToolsWorkspaceCaptureExclusive(async () => {
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return performBusinessWrite();
    const now = Date.now();
    const previousFileIndex = parseToolsWorkspaceFileIndex(
      await RawAsyncStorage.getItem(FILE_INDEX_KEY),
    );
    const overrides = storageOverridesForChanges(applicable);
    let nextFileIndex = previousFileIndex;
    let nextFileIndexRaw: string | null = null;
    if (overrides.has(FILES_KEY)) {
      const { prepareToolsWorkspaceFileIndexRuntime } =
        await import('./syncToolsWorkspaceContentRuntime');
      const prepared = await prepareToolsWorkspaceFileIndexRuntime({
        filesRaw: overrides.get(FILES_KEY) ?? null,
        identity: currentDevice.identity,
        secrets: currentDevice.secrets,
        now,
      });
      nextFileIndex = prepared.index;
      nextFileIndexRaw = prepared.raw;
    }
    const [previous, next] = await Promise.all([
      readToolsWorkspaceProjection({
        reader: RawAsyncStorage,
        capturedAt: now,
        fileIndex: previousFileIndex,
      }),
      readToolsWorkspaceProjection({
        reader: RawAsyncStorage,
        capturedAt: now,
        fileIndex: nextFileIndex,
        overrides,
      }),
    ]);
    const mutations = await deriveToolsWorkspaceMutations({
      previous,
      next,
      capturedAt: now,
      envelopeFactory: (entity) => createSyncMutationEnvelope({
        identity: currentDevice.identity,
        entity,
        state: syncMutationStatePort,
        randomUuid: expoSyncRandomUuidV1,
        now: () => now,
      }),
    });
    const write = async () => {
      const value = await performBusinessWrite();
      if (nextFileIndexRaw !== null) {
        await RawAsyncStorage.setItem(FILE_INDEX_KEY, nextFileIndexRaw);
      }
      return value;
    };
    if (!mutations.length) return write();
    let value!: T;
    try {
      await captureSyncMutationBatch({
        operationId: expoSyncRandomUuidV1(),
        policy: TOOLS_WORKSPACE_BATCH_CAPTURE_POLICY,
        durableCapture: {
          prepareSyncDurableIntent,
          advanceSyncDurableIntent,
          enqueueSyncMutation: enqueueSyncMutationAndAdvanceHeads,
        },
        mutations,
        performBusinessWrite: async () => {
          value = await write();
        },
        now: () => now,
      });
    } catch (error) {
      // A prepared durable intent may replay even before the business row exists.
      if (overrides.has(FILES_KEY)) throw new ToolsWorkspacePendingFileCaptureError(error);
      throw error;
    }
    return value;
  });
}

export async function reconcileToolsWorkspaceStorageBridge() {
  const filesRaw = await RawAsyncStorage.getItem(FILES_KEY);
  if (filesRaw === null) return;
  await performCapturedChanges(
    [{ kind: 'set', key: FILES_KEY, value: filesRaw }],
    async () => undefined,
    { forceCapture: true },
  );
}

export const toolsWorkspaceStorageBridge = {
  getItem: (key: string) => RawAsyncStorage.getItem(key),
  multiGet: (keys: readonly string[]) => RawAsyncStorage.multiGet([...keys]),
  getAllKeys: () => RawAsyncStorage.getAllKeys(),
  setItem: (key: string, value: string) =>
    performCapturedChanges(
      [{ kind: 'set', key, value }],
      () => RawAsyncStorage.setItem(key, value),
    ),
  removeItem: (key: string) =>
    performCapturedChanges(
      [{ kind: 'remove', key }],
      () => RawAsyncStorage.removeItem(key),
    ),
  multiSet: (entries: readonly (readonly [string, string])[]) =>
    performCapturedChanges(
      entries.map(([key, value]) => ({ kind: 'set' as const, key, value })),
      () => RawAsyncStorage.multiSet(
        entries.map(([key, value]) => [key, value]),
      ),
    ),
  multiRemove: (keys: readonly string[]) =>
    performCapturedChanges(
      keys.map((key) => ({ kind: 'remove' as const, key })),
      () => RawAsyncStorage.multiRemove([...keys]),
    ),
};
