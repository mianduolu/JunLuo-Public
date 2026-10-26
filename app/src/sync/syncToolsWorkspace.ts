import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const TOOLS_WORKSPACE_ADAPTER_ID = 'tools.workspace' as const;
export const TOOLS_WORKSPACE_SCHEMA_VERSION = 1 as const;
export const TOOLS_WORKSPACE_VISIT_RETENTION_MS =
  3 * 24 * 60 * 60 * 1_000;

export type ToolsWorkspaceRecordKind =
  | 'workflow'
  | 'visit'
  | 'logical-service'
  | 'file-record'
  | 'file-object'
  | 'permission-policy';

export type ToolsWorkspaceWorkflowStep = {
  id: string;
  input: JsonValue;
  name: string;
  onError: 'continue' | 'stop';
  toolId: string;
};

export type ToolsWorkspaceWorkflow = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  requiresDeviceBinding: boolean;
  mode: 'linear';
  steps: ToolsWorkspaceWorkflowStep[];
  templateId?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastRunSummary?: string;
  runCount: number;
  version: 1;
};

export type ToolsWorkspaceVisit = {
  recordId: string;
  url: string;
  title?: string;
  cacheId?: string;
  openedAt?: number;
  readAt?: number;
  fetchMode?: 'http' | 'browser';
  source: 'chat' | 'life_agent' | 'proactive' | 'background' | 'manual';
};

export type ToolsWorkspaceLogicalService =
  | {
      serviceType: 'github';
      serviceId: 'github';
      apiBaseUrl: string;
      updatedAt: number;
    }
  | {
      serviceType: 'mcp';
      serviceId: string;
      name: string;
      endpoint: string;
      enabled: boolean;
      readOnlyOnly: boolean;
      createdAt: number;
      updatedAt: number;
    };

export type ToolsWorkspaceFileRecord = {
  cacheId: string;
  name: string;
  extension: string;
  mimeType?: string;
  kind?: 'text' | 'zip' | 'raw' | 'image';
  width?: number;
  height?: number;
  mediaSource?: 'picker' | 'camera' | 'test' | 'generated';
  size?: number;
  charCount?: number;
  importedAt: number;
  archivedAt?: number;
  movedToCacheId?: string;
  sourceCacheIds?: string[];
  directoryTag?: string;
};

export type ToolsWorkspaceFileObject = {
  cacheId: string;
  objectId: string;
  plaintextBytes: number;
  chunkCount: number;
  updatedAt: number;
};

export type ToolsWorkspacePermissionPolicy =
  | {
      policyType: 'global';
      policyId: 'global';
      permission: 'allow' | 'ask' | 'deny';
    }
  | {
      policyType: 'package' | 'tool';
      policyId: string;
      permission: 'allow' | 'ask' | 'deny';
    }
  | {
      policyType: 'parameter';
      policyId: string;
      toolId: string;
      permission: 'allow' | 'ask' | 'deny';
      inputRules: JsonValue;
      createdAt: number;
      description?: string;
    };

export type ToolsWorkspaceRecordValue =
  | ToolsWorkspaceWorkflow
  | ToolsWorkspaceVisit
  | ToolsWorkspaceLogicalService
  | ToolsWorkspaceFileRecord
  | ToolsWorkspaceFileObject
  | ToolsWorkspacePermissionPolicy;

const RETENTION: Readonly<Record<ToolsWorkspaceRecordKind, string>> = {
  workflow: 'tools-workspace-long-term',
  visit: 'tools-visit-180d',
  'logical-service': 'tools-logical-service-long-term',
  'file-record': 'tools-file-record-long-term',
  'file-object': 'tools-file-object-referenced',
  'permission-policy': 'tools-permission-policy-long-term',
};

type UnknownRecord = Record<string, unknown>;

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function recordOf(value: unknown, label: string): UnknownRecord {
  expect(
    !!value && typeof value === 'object' && !Array.isArray(value),
    `${label} 必须是对象。`,
  );
  return value as UnknownRecord;
}

function assertKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  expect(
    missing.length === 0 && extras.length === 0,
    `${label} 字段集合无效。`,
  );
}

function assertString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
) {
  expect(
    typeof value === 'string'
      && (allowEmpty || value.length > 0)
      && value.length <= maximum
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
    `${label} 无效。`,
  );
}

function assertOptionalString(value: unknown, label: string, maximum: number) {
  if (value !== undefined) assertString(value, label, maximum, true);
}

function assertTimestamp(value: unknown, label: string) {
  expect(
    Number.isSafeInteger(value) && Number(value) >= 0,
    `${label} 必须是非负 Unix 毫秒整数。`,
  );
}

function assertOptionalTimestamp(value: unknown, label: string) {
  if (value !== undefined) assertTimestamp(value, label);
}

function assertPermission(value: unknown, label: string) {
  expect(
    value === 'allow' || value === 'ask' || value === 'deny',
    `${label} 无效。`,
  );
}

function assertObjectId(value: unknown) {
  expect(
    typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value),
    'tools.workspace objectId 无效。',
  );
}

const URL_SECRET_PARAMETER =
  /^(token|access_token|auth|authorization|key|api_key|apikey|secret|password|signature|sig)$/i;

function secretField(key: string) {
  const compact = key.replace(/[_-]/g, '').toLowerCase();
  return /(token|secret|password|passwd|credential|authorization|cookie|privatekey|apikey)$/.test(compact);
}

function privateHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host.endsWith('.local')
    || /^(127\.|10\.|169\.254\.|192\.168\.)/.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
}

function assertPortableJson(value: unknown, label: string, depth = 0) {
  expect(depth <= 12, `${label} 嵌套过深。`);
  if (
    value === null
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === 'string') {
    expect(value.length <= 100_000, `${label} 字符串过长。`);
    expect(
      !/^(file|content):\/\//i.test(value)
        && !/^[a-z]:[\\/]/i.test(value)
        && !/^\\\\/.test(value),
      `${label} 不能携带本机路径。`,
    );
    try {
      const url = new URL(value);
      expect(!privateHost(url.hostname), `${label} 不能携带私网绑定。`);
    } catch (error) {
      if (
        error instanceof Error
        && error.message.includes('不能携带私网绑定')
      ) {
        throw error;
      }
      // Ordinary text is allowed.
    }
    return;
  }
  if (Array.isArray(value)) {
    expect(value.length <= 500, `${label} 数组过长。`);
    value.forEach((entry, index) =>
      assertPortableJson(entry, `${label}[${index}]`, depth + 1));
    return;
  }
  const record = recordOf(value, label);
  expect(Object.keys(record).length <= 200, `${label} 字段过多。`);
  for (const [key, nested] of Object.entries(record)) {
    expect(!secretField(key), `${label} 不能携带 secret 字段。`);
    assertPortableJson(nested, `${label}.${key}`, depth + 1);
  }
}

function assertWorkflow(value: unknown) {
  const record = recordOf(value, 'tools.workspace workflow');
  assertKeys(
    record,
    [
      'id', 'name', 'enabled', 'requiresDeviceBinding', 'mode', 'steps',
      'createdAt', 'updatedAt', 'runCount', 'version',
    ],
    ['description', 'templateId', 'lastRunAt', 'lastRunSummary'],
    'tools.workspace workflow',
  );
  assertString(record.id, 'workflow.id', 256);
  assertString(record.name, 'workflow.name', 512);
  assertOptionalString(record.description, 'workflow.description', 8_000);
  expect(typeof record.enabled === 'boolean', 'workflow.enabled 无效。');
  expect(
    typeof record.requiresDeviceBinding === 'boolean',
    'workflow.requiresDeviceBinding 无效。',
  );
  expect(record.mode === 'linear' && record.version === 1, 'workflow 版本无效。');
  expect(
    Array.isArray(record.steps)
      && record.steps.length >= 1
      && record.steps.length <= 200,
    'workflow.steps 无效。',
  );
  for (const [index, rawStep] of record.steps.entries()) {
    const step = recordOf(rawStep, `workflow.steps[${index}]`);
    assertKeys(
      step,
      ['id', 'input', 'name', 'onError', 'toolId'],
      [],
      `workflow.steps[${index}]`,
    );
    assertString(step.id, 'workflow.step.id', 256);
    assertString(step.name, 'workflow.step.name', 512);
    assertString(step.toolId, 'workflow.step.toolId', 256);
    expect(
      step.onError === 'continue' || step.onError === 'stop',
      'workflow.step.onError 无效。',
    );
    assertPortableJson(step.input, `workflow.steps[${index}].input`);
  }
  assertOptionalString(record.templateId, 'workflow.templateId', 256);
  assertTimestamp(record.createdAt, 'workflow.createdAt');
  assertTimestamp(record.updatedAt, 'workflow.updatedAt');
  assertOptionalTimestamp(record.lastRunAt, 'workflow.lastRunAt');
  assertOptionalString(record.lastRunSummary, 'workflow.lastRunSummary', 8_000);
  expect(
    Number.isSafeInteger(record.runCount) && Number(record.runCount) >= 0,
    'workflow.runCount 无效。',
  );
}

function assertVisit(value: unknown) {
  const record = recordOf(value, 'tools.workspace visit');
  assertKeys(
    record,
    ['recordId', 'url', 'source'],
    ['title', 'cacheId', 'openedAt', 'readAt', 'fetchMode'],
    'tools.workspace visit',
  );
  assertString(record.recordId, 'visit.recordId', 256);
  assertString(record.url, 'visit.url', 2_000);
  const url = new URL(String(record.url));
  expect(
    url.protocol === 'https:' || url.protocol === 'http:',
    'visit.url 只允许 http(s)。',
  );
  expect(
    !url.username
      && !url.password
      && !privateHost(url.hostname)
      && [...url.searchParams.keys()].every(
        (key) => !URL_SECRET_PARAMETER.test(key),
      ),
    'visit.url 不能携带凭据、私网绑定或 secret query。',
  );
  assertOptionalString(record.title, 'visit.title', 512);
  assertOptionalString(record.cacheId, 'visit.cacheId', 256);
  assertOptionalTimestamp(record.openedAt, 'visit.openedAt');
  assertOptionalTimestamp(record.readAt, 'visit.readAt');
  if (record.fetchMode !== undefined) {
    expect(
      record.fetchMode === 'http' || record.fetchMode === 'browser',
      'visit.fetchMode 无效。',
    );
  }
  expect(
    ['chat', 'life_agent', 'proactive', 'background', 'manual']
      .includes(String(record.source)),
    'visit.source 无效。',
  );
}

function assertPublicHttps(value: unknown, label: string) {
  assertString(value, label, 2_000);
  const url = new URL(String(value));
  expect(url.protocol === 'https:', `${label} 必须是 HTTPS。`);
  const host = url.hostname.toLowerCase();
  expect(
    host && !privateHost(host),
    `${label} 不能指向本机或私有网络。`,
  );
  expect(!url.username && !url.password, `${label} 不能携带凭据。`);
}

function assertLogicalService(value: unknown) {
  const record = recordOf(value, 'tools.workspace logical-service');
  if (record.serviceType === 'github') {
    assertKeys(
      record,
      ['serviceType', 'serviceId', 'apiBaseUrl', 'updatedAt'],
      [],
      'GitHub logical-service',
    );
    expect(record.serviceId === 'github', 'GitHub serviceId 无效。');
    assertPublicHttps(record.apiBaseUrl, 'GitHub apiBaseUrl');
    assertTimestamp(record.updatedAt, 'GitHub updatedAt');
    return;
  }
  assertKeys(
    record,
    [
      'serviceType',
      'serviceId',
      'name',
      'endpoint',
      'enabled',
      'readOnlyOnly',
      'createdAt',
      'updatedAt',
    ],
    [],
    'MCP logical-service',
  );
  expect(record.serviceType === 'mcp', 'logical-service 类型无效。');
  assertString(record.serviceId, 'MCP serviceId', 128);
  assertString(record.name, 'MCP name', 512);
  assertPublicHttps(record.endpoint, 'MCP endpoint');
  expect(
    typeof record.enabled === 'boolean'
      && typeof record.readOnlyOnly === 'boolean',
    'MCP 开关无效。',
  );
  assertTimestamp(record.createdAt, 'MCP createdAt');
  assertTimestamp(record.updatedAt, 'MCP updatedAt');
}

function assertFileRecord(value: unknown) {
  const record = recordOf(value, 'tools.workspace file-record');
  assertKeys(
    record,
    ['cacheId', 'name', 'extension', 'importedAt'],
    [
      'mimeType', 'kind', 'width', 'height', 'mediaSource', 'size',
      'charCount', 'archivedAt', 'movedToCacheId', 'sourceCacheIds',
      'directoryTag',
    ],
    'tools.workspace file-record',
  );
  assertString(record.cacheId, 'file.cacheId', 256);
  assertString(record.name, 'file.name', 512);
  assertString(record.extension, 'file.extension', 32, true);
  assertOptionalString(record.mimeType, 'file.mimeType', 256);
  if (record.kind !== undefined) {
    expect(
      ['text', 'zip', 'raw', 'image'].includes(String(record.kind)),
      'file.kind 无效。',
    );
  }
  for (const key of [
    'width',
    'height',
    'size',
    'charCount',
  ] as const) {
    if (record[key] !== undefined) {
      expect(
        Number.isFinite(record[key]) && Number(record[key]) >= 0,
        `file.${key} 无效。`,
      );
    }
  }
  if (record.mediaSource !== undefined) {
    expect(
      ['picker', 'camera', 'test', 'generated']
        .includes(String(record.mediaSource)),
      'file.mediaSource 无效。',
    );
  }
  assertTimestamp(record.importedAt, 'file.importedAt');
  assertOptionalTimestamp(record.archivedAt, 'file.archivedAt');
  assertOptionalString(record.movedToCacheId, 'file.movedToCacheId', 256);
  assertOptionalString(record.directoryTag, 'file.directoryTag', 256);
  if (record.sourceCacheIds !== undefined) {
    expect(
      Array.isArray(record.sourceCacheIds)
        && record.sourceCacheIds.length <= 200,
      'file.sourceCacheIds 无效。',
    );
    record.sourceCacheIds.forEach((id) =>
      assertString(id, 'file.sourceCacheId', 256));
  }
}

function assertFileObject(value: unknown) {
  const record = recordOf(value, 'tools.workspace file-object');
  assertKeys(
    record,
    ['cacheId', 'objectId', 'plaintextBytes', 'chunkCount', 'updatedAt'],
    [],
    'tools.workspace file-object',
  );
  assertString(record.cacheId, 'file-object.cacheId', 256);
  assertObjectId(record.objectId);
  expect(
    Number.isSafeInteger(record.plaintextBytes)
      && Number(record.plaintextBytes) >= 0,
    'file-object plaintextBytes 无效。',
  );
  expect(
    Number.isSafeInteger(record.chunkCount)
      && Number(record.chunkCount) >= 1
      && Number(record.chunkCount) <= 100_000,
    'file-object chunkCount 无效。',
  );
  assertTimestamp(record.updatedAt, 'file-object.updatedAt');
}

function assertPermissionPolicy(value: unknown) {
  const record = recordOf(value, 'tools.workspace permission-policy');
  expect(
    record.policyType === 'global'
      || record.policyType === 'package'
      || record.policyType === 'tool'
      || record.policyType === 'parameter',
    'permission-policy policyType 无效。',
  );
  if (record.policyType === 'parameter') {
    assertKeys(
      record,
      [
        'policyType', 'policyId', 'toolId', 'permission', 'inputRules',
        'createdAt',
      ],
      ['description'],
      'parameter permission-policy',
    );
  } else {
    assertKeys(
      record,
      ['policyType', 'policyId', 'permission'],
      [],
      'permission-policy',
    );
  }
  assertString(record.policyId, 'permission-policy policyId', 512);
  assertPermission(record.permission, 'permission-policy permission');
  if (record.policyType === 'global') {
    expect(record.policyId === 'global', 'global policyId 无效。');
  }
  if (record.policyType === 'parameter') {
    assertString(record.toolId, 'parameter policy toolId', 256);
    assertPortableJson(record.inputRules, 'parameter policy inputRules');
    assertTimestamp(record.createdAt, 'parameter policy createdAt');
    assertOptionalString(
      record.description,
      'parameter policy description',
      2_000,
    );
  }
}

export function toolsWorkspaceEntityId(
  kind: ToolsWorkspaceRecordKind,
  localId: string,
) {
  return Buffer.from(sha256(new TextEncoder().encode(
    `junluo:tools-workspace:v1:${kind}:${localId}`,
  ))).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function assertToolsWorkspaceRecord(
  kind: ToolsWorkspaceRecordKind,
  value: unknown,
): asserts value is ToolsWorkspaceRecordValue {
  if (kind === 'workflow') assertWorkflow(value);
  else if (kind === 'visit') assertVisit(value);
  else if (kind === 'logical-service') assertLogicalService(value);
  else if (kind === 'file-record') assertFileRecord(value);
  else if (kind === 'file-object') assertFileObject(value);
  else assertPermissionPolicy(value);
  assertJsonValue(value);
}

function localIdForRecord(
  kind: ToolsWorkspaceRecordKind,
  value: ToolsWorkspaceRecordValue,
) {
  const record = value as UnknownRecord;
  if (kind === 'workflow') return String(record.id);
  if (kind === 'visit') return String(record.recordId);
  if (kind === 'logical-service') return String(record.serviceId);
  if (kind === 'file-record' || kind === 'file-object') {
    return String(record.cacheId);
  }
  return `${record.policyType}:${record.policyId}`;
}

export function assertToolsWorkspaceMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(
    value.entity.domain === 'tools'
      && [
        'workflow',
        'visit',
        'logical-service',
        'file-record',
        'file-object',
        'permission-policy',
      ].includes(value.entity.type),
    'tools.workspace mutation entity 无效。',
  );
  expect(
    value.revision.schemaVersion === TOOLS_WORKSPACE_SCHEMA_VERSION
      && value.sensitivity === 'highest',
    'tools.workspace protocol metadata 无效。',
  );
  const kind = value.entity.type as ToolsWorkspaceRecordKind;
  expect(
    value.retentionClass === RETENTION[kind],
    'tools.workspace retentionClass 无效。',
  );
  const payload = recordOf(value.payload, 'tools.workspace payload');
  assertKeys(
    payload,
    value.revision.operation === 'delete'
      ? ['schemaVersion', 'kind', 'deletedAt']
      : ['schemaVersion', 'kind', 'value'],
    [],
    'tools.workspace payload',
  );
  expect(
    payload.schemaVersion === TOOLS_WORKSPACE_SCHEMA_VERSION
      && payload.kind === kind,
    'tools.workspace payload metadata 无效。',
  );
  if (value.revision.operation === 'delete') {
    assertTimestamp(payload.deletedAt, 'tools.workspace deletedAt');
    expect(value.objectRefs.length === 0, '墓碑不能引用对象。');
    return;
  }
  expect(
    value.revision.operation === 'upsert'
      || value.revision.operation === 'restore',
    'tools.workspace 只允许 upsert、restore 或 delete。',
  );
  assertToolsWorkspaceRecord(kind, payload.value);
  const record = payload.value as ToolsWorkspaceRecordValue;
  expect(
    value.entity.id === toolsWorkspaceEntityId(
      kind,
      localIdForRecord(kind, record),
    ),
    'tools.workspace entity id 与记录不一致。',
  );
  if (kind === 'file-object') {
    const objectId = (record as ToolsWorkspaceFileObject).objectId;
    expect(
      value.objectRefs.length === 1 && value.objectRefs[0] === objectId,
      'file-object 必须且只能引用自身 objectId。',
    );
  } else {
    expect(value.objectRefs.length === 0, '非文件对象不能携带 objectRefs。');
  }
}

export function toolsWorkspaceMutationValue(mutation: PlainMutationV1) {
  assertToolsWorkspaceMutationV1(mutation);
  const payload = mutation.payload as UnknownRecord;
  return {
    kind: payload.kind as ToolsWorkspaceRecordKind,
    value: payload.value as ToolsWorkspaceRecordValue | undefined,
    deletedAt: payload.deletedAt as number | undefined,
  };
}

export function buildToolsWorkspaceUpsertMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  kind: ToolsWorkspaceRecordKind;
  value: ToolsWorkspaceRecordValue;
}) {
  assertToolsWorkspaceRecord(input.kind, input.value);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'tools',
      type: input.kind,
      id: toolsWorkspaceEntityId(
        input.kind,
        localIdForRecord(input.kind, input.value),
      ),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'upsert',
      schemaVersion: TOOLS_WORKSPACE_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: {
      schemaVersion: TOOLS_WORKSPACE_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value as JsonValue,
    },
    objectRefs: input.kind === 'file-object'
      ? [(input.value as ToolsWorkspaceFileObject).objectId]
      : [],
    retentionClass: RETENTION[input.kind],
  };
  assertToolsWorkspaceMutationV1(mutation);
  return mutation;
}

export function buildToolsWorkspaceDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  kind: ToolsWorkspaceRecordKind;
  localId: string;
  deletedAt: number;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'tools',
      type: input.kind,
      id: toolsWorkspaceEntityId(input.kind, input.localId),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: TOOLS_WORKSPACE_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: {
      schemaVersion: TOOLS_WORKSPACE_SCHEMA_VERSION,
      kind: input.kind,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: RETENTION[input.kind],
  };
  assertToolsWorkspaceMutationV1(mutation);
  return mutation;
}
