import type { ChatCoreMutationEnvelope } from './syncChatCore';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';
import {
  buildToolsWorkspaceDeleteMutation,
  buildToolsWorkspaceUpsertMutation,
  TOOLS_WORKSPACE_VISIT_RETENTION_MS,
  toolsWorkspaceEntityId,
  type ToolsWorkspaceFileObject,
  type ToolsWorkspaceFileRecord,
  type ToolsWorkspaceLogicalService,
  type ToolsWorkspacePermissionPolicy,
  type ToolsWorkspaceRecordKind,
  type ToolsWorkspaceRecordValue,
  type ToolsWorkspaceVisit,
  type ToolsWorkspaceWorkflow,
} from './syncToolsWorkspace';

export const TOOLS_WORKSPACE_WORKFLOWS_KEY =
  'junluo.tool.workflows.v1' as const;
export const TOOLS_WORKSPACE_BROWSER_KEY =
  'junluo.tools.browser.records.v1' as const;
export const TOOLS_WORKSPACE_MCP_KEY =
  'junluo.tool.mcp.servers.v1' as const;
export const TOOLS_WORKSPACE_GITHUB_KEY =
  'junluo.tools.github.settings.v1' as const;
export const TOOLS_WORKSPACE_FILES_KEY =
  'junluo.tools.files.imports.v1' as const;
export const TOOLS_WORKSPACE_PERMISSIONS_KEY =
  'junluo.tools.permissions.v1' as const;
export const TOOLS_WORKSPACE_FILE_INDEX_KEY =
  'junluo.sync.tools.workspace.files.v1' as const;
export const TOOLS_WORKSPACE_FILE_INDEX_VERSION = 1 as const;
export const TOOLS_WORKSPACE_GLOBAL_KEYS = [
  TOOLS_WORKSPACE_WORKFLOWS_KEY,
  TOOLS_WORKSPACE_BROWSER_KEY,
  TOOLS_WORKSPACE_MCP_KEY,
  TOOLS_WORKSPACE_GITHUB_KEY,
  TOOLS_WORKSPACE_FILES_KEY,
  TOOLS_WORKSPACE_PERMISSIONS_KEY,
] as const;

export type ToolsWorkspaceStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type ToolsWorkspaceStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type ToolsWorkspaceEnvelopeFactory = (
  entity: {
    domain: 'tools';
    type: ToolsWorkspaceRecordKind;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type ToolsWorkspaceProjection = {
  kind: ToolsWorkspaceRecordKind;
  localId: string;
  entityId: string;
  value: ToolsWorkspaceRecordValue;
};

export type ToolsWorkspaceFileLocalEntry = {
  cacheId: string;
  metadata?: ToolsWorkspaceFileRecord;
  object?: ToolsWorkspaceFileObject;
  keyId?: string;
  localUri?: string;
};

export type ToolsWorkspaceFileLocalIndex = {
  version: typeof TOOLS_WORKSPACE_FILE_INDEX_VERSION;
  records: ToolsWorkspaceFileLocalEntry[];
  updatedAt: number;
};

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function text(value: unknown, maximum: number) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, maximum)
    : '';
}

function timestamp(value: unknown, fallback = 0) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
}

function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as UnknownRecord)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`;
}

function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host.endsWith('.local')
    || /^(127\.|10\.|169\.254\.|192\.168\.)/.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function portablePublicHttps(value: unknown) {
  const candidate = text(value, 2_000);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== 'https:'
      || isPrivateHost(url.hostname)
      || url.username
      || url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

const URL_SECRET_PARAMETER =
  /^(token|access_token|auth|authorization|key|api_key|apikey|secret|password|signature|sig)$/i;

function secretField(key: string) {
  const compact = key.replace(/[_-]/g, '').toLowerCase();
  return /(token|secret|password|passwd|credential|authorization|cookie|privatekey|apikey)$/.test(compact);
}

function localBindingString(value: string) {
  if (/^(file|content):\/\//i.test(value)) return true;
  if (/^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value)) return true;
  try {
    const url = new URL(value);
    return isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

function portableJson(
  value: unknown,
  depth = 0,
): { value: JsonValue; stripped: boolean } {
  if (depth > 12) return { value: null, stripped: true };
  if (
    value === null
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return { value: value as JsonValue, stripped: false };
  }
  if (typeof value === 'string') {
    if (localBindingString(value)) return { value: '', stripped: true };
    return { value: value.slice(0, 100_000), stripped: value.length > 100_000 };
  }
  if (Array.isArray(value)) {
    let stripped = value.length > 500;
    const projected = value.slice(0, 500).map((entry) => {
      const nested = portableJson(entry, depth + 1);
      stripped ||= nested.stripped;
      return nested.value;
    });
    return { value: projected, stripped };
  }
  const record = recordOf(value);
  if (!record) return { value: null, stripped: true };
  let stripped = Object.keys(record).length > 200;
  const projected: Record<string, JsonValue> = {};
  for (const [key, nestedValue] of Object.entries(record).slice(0, 200)) {
    if (secretField(key)) {
      stripped = true;
      continue;
    }
    const nested = portableJson(nestedValue, depth + 1);
    projected[key.slice(0, 256)] = nested.value;
    stripped ||= nested.stripped;
  }
  return { value: projected, stripped };
}

function sanitizeUrl(value: unknown) {
  const candidate = text(value, 2_000);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || isPrivateHost(url.hostname)
    ) {
      return null;
    }
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (URL_SECRET_PARAMETER.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function projectToolsWorkspaceWorkflows(
  raw: string | null,
): ToolsWorkspaceProjection[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(-80).flatMap((entry) => {
    const record = recordOf(entry);
    const id = text(record?.id, 256);
    const name = text(record?.name, 512);
    if (!record || !id || !name || !Array.isArray(record.steps)) return [];
    let requiresDeviceBinding = false;
    const steps = record.steps.slice(0, 200).flatMap((rawStep, index) => {
      const step = recordOf(rawStep);
      const toolId = text(step?.toolId, 256);
      const stepName = text(step?.name, 512) || toolId;
      if (!step || !toolId || !stepName) return [];
      const portable = portableJson(recordOf(step.input) ?? {});
      requiresDeviceBinding ||= portable.stripped;
      return [{
        id: text(step.id, 256) || `step-${index}`,
        input: portable.value,
        name: stepName,
        onError: step.onError === 'continue' ? 'continue' as const : 'stop' as const,
        toolId,
      }];
    });
    if (!steps.length) return [];
    const value: ToolsWorkspaceWorkflow = {
      id,
      name,
      ...(typeof record.description === 'string'
        ? { description: record.description.slice(0, 8_000) }
        : {}),
      enabled: record.enabled !== false,
      requiresDeviceBinding,
      mode: 'linear',
      steps,
      ...(text(record.templateId, 256)
        ? { templateId: text(record.templateId, 256) }
        : {}),
      createdAt: timestamp(record.createdAt),
      updatedAt: timestamp(record.updatedAt, timestamp(record.createdAt)),
      ...(timestamp(record.lastRunAt) > 0
        ? { lastRunAt: timestamp(record.lastRunAt) }
        : {}),
      ...(typeof record.lastRunSummary === 'string'
        ? { lastRunSummary: record.lastRunSummary.slice(0, 8_000) }
        : {}),
      runCount: Math.max(0, Math.round(finite(record.runCount) ?? 0)),
      version: 1,
    };
    return [projection('workflow', id, value)];
  });
}

export function projectToolsWorkspaceVisits(
  raw: string | null,
  capturedAt: number,
): ToolsWorkspaceProjection[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  const cutoff = Math.max(0, capturedAt - TOOLS_WORKSPACE_VISIT_RETENTION_MS);
  return parsed.slice(0, 50).flatMap((entry) => {
    const record = recordOf(entry);
    const recordId = text(record?.recordId, 256);
    const url = sanitizeUrl(record?.url);
    const eventAt = timestamp(record?.readAt, timestamp(record?.openedAt));
    if (!record || !recordId || !url || (eventAt > 0 && eventAt < cutoff)) {
      return [];
    }
    const source = ['chat', 'life_agent', 'proactive', 'background', 'manual']
      .includes(String(record.source))
      ? record.source as ToolsWorkspaceVisit['source']
      : 'manual';
    const value: ToolsWorkspaceVisit = {
      recordId,
      url,
      ...(text(record.title, 512) ? { title: text(record.title, 512) } : {}),
      ...(text(record.cacheId, 256) ? { cacheId: text(record.cacheId, 256) } : {}),
      ...(timestamp(record.openedAt) > 0
        ? { openedAt: timestamp(record.openedAt) }
        : {}),
      ...(timestamp(record.readAt) > 0 ? { readAt: timestamp(record.readAt) } : {}),
      ...(record.fetchMode === 'http' || record.fetchMode === 'browser'
        ? { fetchMode: record.fetchMode }
        : {}),
      source,
    };
    return [projection('visit', recordId, value)];
  });
}

export function projectToolsWorkspaceServices(input: {
  mcpRaw: string | null;
  githubRaw: string | null;
  capturedAt: number;
}) {
  const result: ToolsWorkspaceProjection[] = [];
  const mcp = parseJson(input.mcpRaw);
  if (Array.isArray(mcp)) {
    for (const entry of mcp) {
      const record = recordOf(entry);
      const serviceId = text(record?.serverId, 128);
      const endpoint = portablePublicHttps(record?.endpoint);
      if (!record || !serviceId || !endpoint) continue;
      const value: ToolsWorkspaceLogicalService = {
        serviceType: 'mcp',
        serviceId,
        name: text(record.name, 512) || serviceId,
        endpoint,
        enabled: record.enabled === true,
        readOnlyOnly: record.readOnlyOnly !== false,
        createdAt: timestamp(record.createdAt, input.capturedAt),
        updatedAt: timestamp(record.updatedAt, input.capturedAt),
      };
      result.push(projection('logical-service', serviceId, value));
    }
  }
  const github = recordOf(parseJson(input.githubRaw));
  const apiBaseUrl = portablePublicHttps(github?.apiBaseUrl);
  if (apiBaseUrl) {
    const value: ToolsWorkspaceLogicalService = {
      serviceType: 'github',
      serviceId: 'github',
      apiBaseUrl,
      updatedAt: input.capturedAt,
    };
    result.push(projection('logical-service', 'github', value));
  }
  return result;
}

export function projectToolsWorkspaceFileRecords(raw: string | null) {
  if (raw === null) return [] as ToolsWorkspaceFileRecord[];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('文件登记记录损坏');
  return parsed.flatMap((entry) => {
    const record = recordOf(entry);
    const cacheId = text(record?.cacheId, 256);
    const name = text(record?.name, 512);
    if (!record || !cacheId || !name) throw new Error('文件登记记录损坏');
    const value: ToolsWorkspaceFileRecord = {
      cacheId,
      name,
      extension: text(record.extension, 32),
      ...(text(record.mimeType, 256)
        ? { mimeType: text(record.mimeType, 256) }
        : {}),
      ...(['text', 'zip', 'raw', 'image'].includes(String(record.kind))
        ? { kind: record.kind as ToolsWorkspaceFileRecord['kind'] }
        : {}),
      ...(finite(record.width) !== undefined ? { width: finite(record.width) } : {}),
      ...(finite(record.height) !== undefined ? { height: finite(record.height) } : {}),
      ...(['picker', 'camera', 'test', 'generated'].includes(String(record.mediaSource))
        ? { mediaSource: record.mediaSource as ToolsWorkspaceFileRecord['mediaSource'] }
        : {}),
      ...(finite(record.size) !== undefined ? { size: finite(record.size) } : {}),
      ...(finite(record.charCount) !== undefined
        ? { charCount: finite(record.charCount) }
        : {}),
      importedAt: timestamp(record.importedAt),
      ...(timestamp(record.archivedAt) > 0
        ? { archivedAt: timestamp(record.archivedAt) }
        : {}),
      ...(text(record.movedToCacheId, 256)
        ? { movedToCacheId: text(record.movedToCacheId, 256) }
        : {}),
      ...(Array.isArray(record.sourceCacheIds)
        ? {
            sourceCacheIds: record.sourceCacheIds
              .map((id) => text(id, 256))
              .filter(Boolean)
              .slice(0, 200),
          }
        : {}),
      ...(text(record.directoryTag, 256)
        ? { directoryTag: text(record.directoryTag, 256) }
        : {}),
    };
    return [value];
  });
}

export function projectToolsWorkspacePermissions(raw: string | null) {
  const settings = recordOf(parseJson(raw));
  const result: ToolsWorkspaceProjection[] = [];
  const globalValue: ToolsWorkspacePermissionPolicy = {
    policyType: 'global',
    policyId: 'global',
    permission: permission(settings?.globalDefault),
  };
  result.push(projection('permission-policy', 'global:global', globalValue));
  for (const [policyType, rawMap] of [
    ['package', settings?.packageOverrides],
    ['tool', settings?.toolOverrides],
  ] as const) {
    const map = recordOf(rawMap);
    if (!map) continue;
    for (const [policyId, rawPermission] of Object.entries(map)) {
      if (!policyId.trim()) continue;
      const value: ToolsWorkspacePermissionPolicy = {
        policyType,
        policyId: policyId.slice(0, 512),
        permission: permission(rawPermission),
      };
      result.push(projection(
        'permission-policy',
        `${policyType}:${value.policyId}`,
        value,
      ));
    }
  }
  if (Array.isArray(settings?.parameterGrants)) {
    for (const rawGrant of settings.parameterGrants) {
      const grant = recordOf(rawGrant);
      const policyId = text(grant?.id, 512);
      const toolId = text(grant?.toolId, 256);
      if (!grant || !policyId || !toolId || grant.expiresAt !== undefined) continue;
      const portableRules = portableJson(recordOf(grant.inputRules) ?? {});
      if (portableRules.stripped) continue;
      const value: ToolsWorkspacePermissionPolicy = {
        policyType: 'parameter',
        policyId,
        toolId,
        permission: permission(grant.permission),
        inputRules: portableRules.value,
        createdAt: timestamp(grant.createdAt),
        ...(text(grant.description, 2_000)
          ? { description: text(grant.description, 2_000) }
          : {}),
      };
      result.push(projection(
        'permission-policy',
        `parameter:${policyId}`,
        value,
      ));
    }
  }
  return result;
}

function permission(value: unknown): 'allow' | 'ask' | 'deny' {
  return value === 'allow' || value === 'deny' ? value : 'ask';
}

function projection(
  kind: ToolsWorkspaceRecordKind,
  localId: string,
  value: ToolsWorkspaceRecordValue,
): ToolsWorkspaceProjection {
  return {
    kind,
    localId,
    entityId: toolsWorkspaceEntityId(kind, localId),
    value,
  };
}

export function emptyToolsWorkspaceFileIndex(
  updatedAt = 0,
): ToolsWorkspaceFileLocalIndex {
  return {
    version: TOOLS_WORKSPACE_FILE_INDEX_VERSION,
    records: [],
    updatedAt,
  };
}

export function parseToolsWorkspaceFileIndex(
  raw: string | null,
): ToolsWorkspaceFileLocalIndex {
  if (raw === null) return emptyToolsWorkspaceFileIndex();
  const parsed = recordOf(JSON.parse(raw) as unknown);
  if (
    !parsed
    || parsed.version !== TOOLS_WORKSPACE_FILE_INDEX_VERSION
    || !Array.isArray(parsed.records)
  ) {
    throw new Error('文件同步登记记录损坏或版本不受支持');
  }
  const records = parsed.records.flatMap((entry) => {
    const record = recordOf(entry);
    const cacheId = text(record?.cacheId, 256);
    if (!record || !cacheId) throw new Error('文件同步登记记录损坏');
    const metadata = projectToolsWorkspaceFileRecords(
      record.metadata ? JSON.stringify([record.metadata]) : null,
    )[0];
    const objectRecord = recordOf(record.object);
    const object = objectRecord
      && typeof objectRecord.objectId === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(objectRecord.objectId)
      ? {
          cacheId,
          objectId: objectRecord.objectId,
          plaintextBytes: timestamp(objectRecord.plaintextBytes),
          chunkCount: Math.max(1, timestamp(objectRecord.chunkCount, 1)),
          updatedAt: timestamp(objectRecord.updatedAt),
        } satisfies ToolsWorkspaceFileObject
      : undefined;
    const localUri = typeof record.localUri === 'string'
      && /^file:\/\//.test(record.localUri)
      ? record.localUri
      : undefined;
    const keyId = typeof record.keyId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.keyId)
      ? record.keyId
      : undefined;
    return [{
      cacheId,
      ...(metadata ? { metadata } : {}),
      ...(object ? { object } : {}),
      ...(keyId ? { keyId } : {}),
      ...(localUri ? { localUri } : {}),
    }];
  });
  return {
    version: TOOLS_WORKSPACE_FILE_INDEX_VERSION,
    records,
    updatedAt: timestamp(parsed.updatedAt),
  };
}

export function serializeToolsWorkspaceFileIndex(
  index: ToolsWorkspaceFileLocalIndex,
) {
  return JSON.stringify({
    version: TOOLS_WORKSPACE_FILE_INDEX_VERSION,
    records: [...index.records].sort((left, right) =>
      left.cacheId.localeCompare(right.cacheId)),
    updatedAt: index.updatedAt,
  });
}

function fileProjections(
  raw: string | null,
  index: ToolsWorkspaceFileLocalIndex,
) {
  const metadata = projectToolsWorkspaceFileRecords(raw);
  const metadataIds = new Set(metadata.map((record) => record.cacheId));
  const projections = metadata.map((record) =>
    projection('file-record', record.cacheId, record));
  for (const entry of index.records) {
    if (metadataIds.has(entry.cacheId) && entry.object) {
      projections.push(projection(
        'file-object',
        entry.cacheId,
        entry.object,
      ));
    }
  }
  return projections;
}

export async function readToolsWorkspaceProjection(input: {
  reader: ToolsWorkspaceStorageReadPort;
  capturedAt: number;
  fileIndex?: ToolsWorkspaceFileLocalIndex;
  overrides?: ReadonlyMap<string, string | null>;
}) {
  const get = async (key: string) => input.overrides?.has(key)
    ? input.overrides.get(key) ?? null
    : input.reader.getItem(key);
  const [
    workflows,
    visits,
    mcp,
    github,
    files,
    permissions,
    fileIndexRaw,
  ] = await Promise.all([
    get(TOOLS_WORKSPACE_WORKFLOWS_KEY),
    get(TOOLS_WORKSPACE_BROWSER_KEY),
    get(TOOLS_WORKSPACE_MCP_KEY),
    get(TOOLS_WORKSPACE_GITHUB_KEY),
    get(TOOLS_WORKSPACE_FILES_KEY),
    get(TOOLS_WORKSPACE_PERMISSIONS_KEY),
    input.fileIndex
      ? Promise.resolve(null)
      : input.reader.getItem(TOOLS_WORKSPACE_FILE_INDEX_KEY),
  ]);
  const fileIndex = input.fileIndex
    ?? parseToolsWorkspaceFileIndex(fileIndexRaw);
  return [
    ...projectToolsWorkspaceWorkflows(workflows),
    ...projectToolsWorkspaceVisits(visits, input.capturedAt),
    ...projectToolsWorkspaceServices({
      mcpRaw: mcp,
      githubRaw: github,
      capturedAt: input.capturedAt,
    }),
    ...fileProjections(files, fileIndex),
    ...projectToolsWorkspacePermissions(permissions),
  ];
}

function projectionKey(value: ToolsWorkspaceProjection) {
  return `${value.kind}\u0000${value.entityId}`;
}

export async function deriveToolsWorkspaceMutations(input: {
  previous: readonly ToolsWorkspaceProjection[];
  next: readonly ToolsWorkspaceProjection[];
  capturedAt: number;
  envelopeFactory: ToolsWorkspaceEnvelopeFactory;
}) {
  const previous = new Map(
    input.previous.map((record) => [projectionKey(record), record]),
  );
  const next = new Map(
    input.next.map((record) => [projectionKey(record), record]),
  );
  const keys = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const mutations: PlainMutationV1[] = [];
  for (const key of keys) {
    const before = previous.get(key);
    const after = next.get(key);
    if (
      before
      && after
      && canonicalJson(before.value) === canonicalJson(after.value)
    ) {
      continue;
    }
    const identity = after ?? before;
    if (!identity) continue;
    const envelope = await input.envelopeFactory({
      domain: 'tools',
      type: identity.kind,
      id: identity.entityId,
    });
    if (after) {
      mutations.push(buildToolsWorkspaceUpsertMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: after.kind,
        value: after.value,
      }));
    } else {
      mutations.push(buildToolsWorkspaceDeleteMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: before!.kind,
        localId: before!.localId,
        deletedAt: input.capturedAt,
      }));
    }
  }
  return mutations;
}

export function isToolsWorkspaceGlobalStorageKey(key: string) {
  return (TOOLS_WORKSPACE_GLOBAL_KEYS as readonly string[]).includes(key);
}

export function storageOverridesForChanges(
  changes: readonly ToolsWorkspaceStorageChange[],
) {
  const overrides = new Map<string, string | null>();
  for (const change of changes) {
    if (!isToolsWorkspaceGlobalStorageKey(change.key)) continue;
    overrides.set(change.key, change.kind === 'set' ? change.value : null);
  }
  return overrides;
}
