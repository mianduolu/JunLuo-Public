import RawAsyncStorage from '@react-native-async-storage/async-storage';

import type {
  JunLuoToolParameterPermissionGrant,
  JunLuoToolPermissionSettings,
} from '../tools/toolPermissionStore';
import {
  assertToolsWorkspaceRecord,
  TOOLS_WORKSPACE_VISIT_RETENTION_MS,
  toolsWorkspaceEntityId,
  type ToolsWorkspaceFileObject,
  type ToolsWorkspaceFileRecord,
  type ToolsWorkspaceLogicalService,
  type ToolsWorkspacePermissionPolicy,
  type ToolsWorkspaceRecordKind,
  type ToolsWorkspaceVisit,
  type ToolsWorkspaceWorkflow,
} from './syncToolsWorkspace';
import type {
  ToolsWorkspaceBusinessPort,
} from './syncToolsWorkspaceApply';
import {
  parseToolsWorkspaceFileIndex,
  projectToolsWorkspaceFileRecords,
  serializeToolsWorkspaceFileIndex,
  TOOLS_WORKSPACE_BROWSER_KEY,
  TOOLS_WORKSPACE_FILES_KEY,
  TOOLS_WORKSPACE_FILE_INDEX_KEY,
  TOOLS_WORKSPACE_GITHUB_KEY,
  TOOLS_WORKSPACE_MCP_KEY,
  TOOLS_WORKSPACE_PERMISSIONS_KEY,
  TOOLS_WORKSPACE_WORKFLOWS_KEY,
  type ToolsWorkspaceFileLocalEntry,
} from './syncToolsWorkspaceStorageDerivation';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  loadSyncObjectJob,
  scheduleSyncObjectDownload,
} from './syncObjectJobStore';
import { materializeToolsWorkspaceFile } from './syncToolsWorkspaceMaterialization';
import { runToolsWorkspaceFileRecordsExclusive } from './syncToolsWorkspaceStorageBridge';

type UnknownRecord = Record<string, unknown>;

let toolsWorkspaceApplyQueue = Promise.resolve();

function enqueueToolsWorkspaceApply<T>(callback: () => Promise<T>) {
  const current = toolsWorkspaceApplyQueue
    .catch(() => undefined)
    .then(callback);
  toolsWorkspaceApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function parseArray(raw: string | null) {
  if (!raw) return [] as UnknownRecord[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is UnknownRecord =>
            !!value && typeof value === 'object' && !Array.isArray(value),
        )
      : [];
  } catch {
    return [];
  }
}

function parseObject(raw: string | null) {
  if (!raw) return {} as UnknownRecord;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as UnknownRecord
      : {};
  } catch {
    return {};
  }
}

function workflowLocalValue(value: ToolsWorkspaceWorkflow) {
  const {
    requiresDeviceBinding,
    ...portable
  } = value;
  return {
    ...portable,
    enabled: requiresDeviceBinding ? false : portable.enabled,
  };
}

async function upsertWorkflow(value: ToolsWorkspaceWorkflow) {
  const current = parseArray(
    await RawAsyncStorage.getItem(TOOLS_WORKSPACE_WORKFLOWS_KEY),
  );
  const next = current.filter((record) => record.id !== value.id);
  next.push(workflowLocalValue(value));
  await RawAsyncStorage.setItem(
    TOOLS_WORKSPACE_WORKFLOWS_KEY,
    JSON.stringify(next.slice(-80)),
  );
}

async function upsertVisit(value: ToolsWorkspaceVisit) {
  const now = Date.now();
  const cutoff = now - TOOLS_WORKSPACE_VISIT_RETENTION_MS;
  const current = parseArray(
    await RawAsyncStorage.getItem(TOOLS_WORKSPACE_BROWSER_KEY),
  );
  const next = [
    value,
    ...current.filter((record) => (
      record.recordId !== value.recordId
      && Number(record.readAt ?? record.openedAt ?? now) >= cutoff
    )),
  ].slice(0, 50);
  await RawAsyncStorage.setItem(
    TOOLS_WORKSPACE_BROWSER_KEY,
    JSON.stringify(next),
  );
}

async function upsertService(value: ToolsWorkspaceLogicalService) {
  if (value.serviceType === 'github') {
    await RawAsyncStorage.setItem(
      TOOLS_WORKSPACE_GITHUB_KEY,
      JSON.stringify({ apiBaseUrl: value.apiBaseUrl }),
    );
    return;
  }
  const current = parseArray(
    await RawAsyncStorage.getItem(TOOLS_WORKSPACE_MCP_KEY),
  );
  const existing = current.find((record) =>
    record.serverId === value.serviceId);
  const nextValue = {
    ...(existing ?? {}),
    serverId: value.serviceId,
    name: value.name,
    endpoint: value.endpoint,
    enabled: value.enabled,
    readOnlyOnly: value.readOnlyOnly,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  const next = current.filter((record) =>
    record.serverId !== value.serviceId);
  next.push(nextValue);
  await RawAsyncStorage.setItem(
    TOOLS_WORKSPACE_MCP_KEY,
    JSON.stringify(next),
  );
}

function normalizePermissionSettings(value: UnknownRecord):
JunLuoToolPermissionSettings {
  return {
    version: 2,
    globalDefault: value.globalDefault === 'allow'
      || value.globalDefault === 'deny'
      ? value.globalDefault
      : 'ask',
    packageOverrides: value.packageOverrides
      && typeof value.packageOverrides === 'object'
      && !Array.isArray(value.packageOverrides)
      ? value.packageOverrides as JunLuoToolPermissionSettings['packageOverrides']
      : {},
    toolOverrides: value.toolOverrides
      && typeof value.toolOverrides === 'object'
      && !Array.isArray(value.toolOverrides)
      ? value.toolOverrides as JunLuoToolPermissionSettings['toolOverrides']
      : {},
    temporaryGrants: Array.isArray(value.temporaryGrants)
      ? value.temporaryGrants as JunLuoToolPermissionSettings['temporaryGrants']
      : [],
    parameterGrants: Array.isArray(value.parameterGrants)
      ? value.parameterGrants as JunLuoToolPermissionSettings['parameterGrants']
      : [],
  };
}

async function upsertPermission(value: ToolsWorkspacePermissionPolicy) {
  const current = normalizePermissionSettings(parseObject(
    await RawAsyncStorage.getItem(TOOLS_WORKSPACE_PERMISSIONS_KEY),
  ));
  if (value.policyType === 'global') {
    current.globalDefault = value.permission;
  } else if (value.policyType === 'package') {
    current.packageOverrides[value.policyId] = value.permission;
  } else if (value.policyType === 'tool') {
    current.toolOverrides[value.policyId] = value.permission;
  } else {
    const parameter = value as Extract<
      ToolsWorkspacePermissionPolicy,
      { policyType: 'parameter' }
    >;
    const persistent: JunLuoToolParameterPermissionGrant = {
      id: parameter.policyId,
      toolId: parameter.toolId,
      permission: parameter.permission,
      inputRules: parameter.inputRules as JunLuoToolParameterPermissionGrant['inputRules'],
      createdAt: parameter.createdAt,
      ...(parameter.description
        ? { description: parameter.description }
        : {}),
    };
    current.parameterGrants = [
      ...current.parameterGrants.filter(
        (grant) => grant.id !== parameter.policyId,
      ),
      persistent,
    ];
  }
  await RawAsyncStorage.setItem(
    TOOLS_WORKSPACE_PERMISSIONS_KEY,
    JSON.stringify(current),
  );
}

async function saveFileIndex(records: ToolsWorkspaceFileLocalEntry[]) {
  await RawAsyncStorage.setItem(
    TOOLS_WORKSPACE_FILE_INDEX_KEY,
    serializeToolsWorkspaceFileIndex({
      version: 1,
      records,
      updatedAt: Date.now(),
    }),
  );
}

async function addMaterializedFileRecord(
  metadata: ToolsWorkspaceFileRecord,
  uri: string,
) {
  const currentRaw = await RawAsyncStorage.getItem(
    TOOLS_WORKSPACE_FILES_KEY,
  );
  projectToolsWorkspaceFileRecords(currentRaw);
  const current = parseArray(currentRaw);
  const existing = current.find((record) =>
    record.cacheId === metadata.cacheId);
  const next = [
    {
      ...(existing ?? {}),
      ...metadata,
      uri,
    },
    ...current.filter((record) => record.cacheId !== metadata.cacheId),
  ]
    .sort((left, right) =>
      Number(right.importedAt ?? 0) - Number(left.importedAt ?? 0));
  await RawAsyncStorage.setItem(
    TOOLS_WORKSPACE_FILES_KEY,
    JSON.stringify(next),
  );
}

async function tryMaterializeEntry(
  entry: ToolsWorkspaceFileLocalEntry,
) {
  if (!entry.metadata || !entry.object) return entry;
  if (entry.localUri) {
    await addMaterializedFileRecord(entry.metadata, entry.localUri);
    return entry;
  }
  const job = await loadSyncObjectJob(entry.object.objectId);
  if (
    job?.state === 'verified'
    && job.localUri
    && /^file:\/\//.test(job.localUri)
  ) {
    const localUri = await materializeToolsWorkspaceFile({
      sourceUri: job.localUri,
      record: entry.metadata,
    });
    await addMaterializedFileRecord(entry.metadata, localUri);
    return { ...entry, localUri };
  }
  const currentDevice = await loadCurrentSyncDevice();
  if (currentDevice) {
    await scheduleSyncObjectDownload({
      objectId: entry.object.objectId,
      keyId: currentDevice.identity.keyId,
      totalChunks: entry.object.chunkCount,
      now: Date.now(),
    });
  }
  return entry;
}

async function upsertFileRecord(value: ToolsWorkspaceFileRecord) {
  const index = parseToolsWorkspaceFileIndex(
    await RawAsyncStorage.getItem(TOOLS_WORKSPACE_FILE_INDEX_KEY),
  );
  const existing = index.records.find((record) =>
    record.cacheId === value.cacheId);
  const entry = await tryMaterializeEntry({
    ...(existing ?? { cacheId: value.cacheId }),
    metadata: value,
  });
  await saveFileIndex([
    ...index.records.filter((record) => record.cacheId !== value.cacheId),
    entry,
  ]);
}

async function upsertFileObject(value: ToolsWorkspaceFileObject) {
  const index = parseToolsWorkspaceFileIndex(
    await RawAsyncStorage.getItem(TOOLS_WORKSPACE_FILE_INDEX_KEY),
  );
  const existing = index.records.find((record) =>
    record.cacheId === value.cacheId);
  const keepLocalUri = existing?.object?.objectId === value.objectId
    ? existing.localUri
    : undefined;
  const entry = await tryMaterializeEntry({
    ...(existing ?? { cacheId: value.cacheId }),
    object: value,
    ...(keepLocalUri ? { localUri: keepLocalUri } : { localUri: undefined }),
  });
  await saveFileIndex([
    ...index.records.filter((record) => record.cacheId !== value.cacheId),
    entry,
  ]);
}

async function removeByEntityId(
  kind: ToolsWorkspaceRecordKind,
  entityId: string,
) {
  if (kind === 'workflow') {
    const current = parseArray(await RawAsyncStorage.getItem(
      TOOLS_WORKSPACE_WORKFLOWS_KEY,
    ));
    await RawAsyncStorage.setItem(
      TOOLS_WORKSPACE_WORKFLOWS_KEY,
      JSON.stringify(current.filter((record) =>
        toolsWorkspaceEntityId(kind, String(record.id ?? '')) !== entityId)),
    );
    return;
  }
  if (kind === 'visit') {
    const current = parseArray(await RawAsyncStorage.getItem(
      TOOLS_WORKSPACE_BROWSER_KEY,
    ));
    await RawAsyncStorage.setItem(
      TOOLS_WORKSPACE_BROWSER_KEY,
      JSON.stringify(current.filter((record) =>
        toolsWorkspaceEntityId(kind, String(record.recordId ?? '')) !== entityId)),
    );
    return;
  }
  if (kind === 'logical-service') {
    if (toolsWorkspaceEntityId(kind, 'github') === entityId) {
      await RawAsyncStorage.removeItem(TOOLS_WORKSPACE_GITHUB_KEY);
    }
    const current = parseArray(await RawAsyncStorage.getItem(
      TOOLS_WORKSPACE_MCP_KEY,
    ));
    await RawAsyncStorage.setItem(
      TOOLS_WORKSPACE_MCP_KEY,
      JSON.stringify(current.filter((record) =>
        toolsWorkspaceEntityId(kind, String(record.serverId ?? '')) !== entityId)),
    );
    return;
  }
  if (kind === 'file-record' || kind === 'file-object') {
    const index = parseToolsWorkspaceFileIndex(
      await RawAsyncStorage.getItem(TOOLS_WORKSPACE_FILE_INDEX_KEY),
    );
    const target = index.records.find((record) =>
      toolsWorkspaceEntityId(kind, record.cacheId) === entityId);
    if (!target) return;
    const records = index.records.flatMap((record) => {
      if (record.cacheId !== target.cacheId) return [record];
      const next = {
        ...record,
        ...(kind === 'file-record'
          ? { metadata: undefined }
          : { object: undefined, localUri: undefined }),
      };
      return next.metadata || next.object ? [next] : [];
    });
    await saveFileIndex(records);
    if (kind === 'file-record') {
      const currentRaw = await RawAsyncStorage.getItem(
        TOOLS_WORKSPACE_FILES_KEY,
      );
      projectToolsWorkspaceFileRecords(currentRaw);
      const current = parseArray(currentRaw);
      await RawAsyncStorage.setItem(
        TOOLS_WORKSPACE_FILES_KEY,
        JSON.stringify(current.filter((record) =>
          record.cacheId !== target.cacheId)),
      );
    }
    return;
  }
  const settings = normalizePermissionSettings(parseObject(
    await RawAsyncStorage.getItem(TOOLS_WORKSPACE_PERMISSIONS_KEY),
  ));
  if (toolsWorkspaceEntityId(kind, 'global:global') === entityId) {
    settings.globalDefault = 'ask';
  }
  for (const [policyType, map] of [
    ['package', settings.packageOverrides],
    ['tool', settings.toolOverrides],
  ] as const) {
    for (const policyId of Object.keys(map)) {
      if (
        toolsWorkspaceEntityId(kind, `${policyType}:${policyId}`) === entityId
      ) {
        delete map[policyId];
      }
    }
  }
  settings.parameterGrants = settings.parameterGrants.filter((grant) =>
    toolsWorkspaceEntityId(
      kind,
      `parameter:${grant.id}`,
    ) !== entityId);
  await RawAsyncStorage.setItem(
    TOOLS_WORKSPACE_PERMISSIONS_KEY,
    JSON.stringify(settings),
  );
}

export const toolsWorkspaceAsyncStorageBusinessPort:
ToolsWorkspaceBusinessPort = {
  upsert: (input) => enqueueToolsWorkspaceApply(async () => {
    assertToolsWorkspaceRecord(input.kind, input.value);
    if (input.kind === 'workflow') {
      await upsertWorkflow(input.value as ToolsWorkspaceWorkflow);
    } else if (input.kind === 'visit') {
      await upsertVisit(input.value as ToolsWorkspaceVisit);
    } else if (input.kind === 'logical-service') {
      await upsertService(input.value as ToolsWorkspaceLogicalService);
    } else if (input.kind === 'file-record') {
      await runToolsWorkspaceFileRecordsExclusive(() => upsertFileRecord(input.value as ToolsWorkspaceFileRecord));
    } else if (input.kind === 'file-object') {
      await runToolsWorkspaceFileRecordsExclusive(() => upsertFileObject(input.value as ToolsWorkspaceFileObject));
    } else {
      await upsertPermission(input.value as ToolsWorkspacePermissionPolicy);
    }
  }),
  tombstone: (input) => enqueueToolsWorkspaceApply(
    () => input.kind === 'file-record' || input.kind === 'file-object'
      ? runToolsWorkspaceFileRecordsExclusive(() => removeByEntityId(input.kind, input.entityId))
      : removeByEntityId(input.kind, input.entityId),
  ),
};

export async function materializeToolsWorkspaceFileObject(input: {
  objectId: string;
  localUri: string;
}) {
  return enqueueToolsWorkspaceApply(() => runToolsWorkspaceFileRecordsExclusive(async () => {
    const index = parseToolsWorkspaceFileIndex(
      await RawAsyncStorage.getItem(TOOLS_WORKSPACE_FILE_INDEX_KEY),
    );
    let changed = false;
    let matched = false;
    const records: ToolsWorkspaceFileLocalEntry[] = [];
    for (const entry of index.records) {
      if (
        entry.object?.objectId !== input.objectId
        || !entry.metadata
      ) {
        records.push(entry);
        continue;
      }
      matched = true;
      const localUri = await materializeToolsWorkspaceFile({
        sourceUri: input.localUri,
        record: entry.metadata,
      });
      await addMaterializedFileRecord(entry.metadata, localUri);
      records.push({ ...entry, localUri });
      changed = true;
    }
    if (changed) await saveFileIndex(records);
    return {
      handled: matched,
      pending: !matched,
      changed,
    };
  }));
}

export async function listPortableToolsWorkspaceFiles() {
  return projectToolsWorkspaceFileRecords(
    await RawAsyncStorage.getItem(TOOLS_WORKSPACE_FILES_KEY),
  );
}
