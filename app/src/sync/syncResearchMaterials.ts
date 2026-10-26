import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { bytesToBase64Url } from './syncBase64Url';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const RESEARCH_MATERIALS_ADAPTER_ID =
  'research.materials' as const;
export const RESEARCH_MATERIALS_SCHEMA_VERSION = 1 as const;
export const RESEARCH_MATERIALS_RETENTION_CLASS =
  'research-material-long-term' as const;
export const RESEARCH_MATERIALS_RECORD_KINDS = [
  'network-material',
  'fund-material',
] as const;

export type ResearchMaterialRecordKind =
  typeof RESEARCH_MATERIALS_RECORD_KINDS[number];

export type NetworkResearchMaterial = {
  materialId: string;
  sourceCacheId: string;
  url: string;
  title: string;
  excerpt: string;
  source: 'mobile' | 'backend';
  fetchMode: 'http' | 'browser';
  fetchedAt: number;
};

export type FundResearchMaterial = {
  materialId: string;
  cacheKey: string;
  payload: JsonValue;
  source: string;
  fetchedAt: number;
  expiresAt: number;
  staleAllowed: boolean;
};

export type FundResearchPayloadObjectV1 = {
  objectId: string;
  encoding: 'canonical-json-utf8';
  plaintextBytes: number;
  plaintextSha256: string;
};

export type FundResearchMaterialObjectReference = Omit<
  FundResearchMaterial,
  'payload'
> & {
  payloadObject: FundResearchPayloadObjectV1;
};

export type ResearchMaterialRecordValue =
  | NetworkResearchMaterial
  | FundResearchMaterial;

export type ResearchMaterialMutationValue =
  | ResearchMaterialRecordValue
  | FundResearchMaterialObjectReference;

export type ResearchMaterialsMutationEnvelope = {
  mutationId: string;
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number;
  revisionId: string;
  parentRevisionIds: string[];
  createdAt: number;
};

type UnknownRecord = Record<string, unknown>;

function expect(
  condition: unknown,
  message: string,
): asserts condition {
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
  label: string,
) {
  const allowed = new Set(required);
  expect(
    required.every((key) => key in value)
      && Object.keys(value).every((key) => allowed.has(key)),
    `${label} 字段集合无效。`,
  );
}

function assertText(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  expect(
    typeof value === 'string'
      && value.trim().length > 0
      && value.length <= maximumLength,
    `${label} 无效。`,
  );
}

function assertTimestamp(value: unknown, label: string) {
  expect(
    Number.isSafeInteger(value) && Number(value) >= 0,
    `${label} 无效。`,
  );
}

function assertPublicHttpUrl(value: unknown, label: string) {
  assertText(value, label, 4096);
  let parsed: URL;
  try {
    parsed = new URL(value as string);
  } catch {
    throw new Error(`${label} 无效。`);
  }
  expect(
    (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !!parsed.hostname
      && !parsed.username
      && !parsed.password,
    `${label} 必须是无内嵌凭据的 HTTP(S) URL。`,
  );
}

function stableId(kind: ResearchMaterialRecordKind, identity: string) {
  return bytesToBase64Url(sha256(utf8ToBytes(
    `${RESEARCH_MATERIALS_ADAPTER_ID}\u0000${kind}\u0000${identity}`,
  )));
}

export function networkResearchMaterialId(url: string) {
  assertPublicHttpUrl(url, 'network material url');
  return stableId('network-material', new URL(url).toString());
}

export function fundResearchMaterialId(cacheKey: string) {
  assertText(cacheKey, 'fund material cacheKey', 300);
  return stableId('fund-material', cacheKey);
}

export function assertResearchMaterialRecord(
  kind: ResearchMaterialRecordKind,
  value: unknown,
  options: { allowLargeFundPayload?: boolean } = {},
): asserts value is ResearchMaterialRecordValue {
  const record = recordOf(value, kind);
  if (kind === 'network-material') {
    assertKeys(record, [
      'materialId',
      'sourceCacheId',
      'url',
      'title',
      'excerpt',
      'source',
      'fetchMode',
      'fetchedAt',
    ], kind);
    expect(
      typeof record.materialId === 'string'
        && record.materialId === networkResearchMaterialId(
          String(record.url),
        ),
      'network material materialId 与 URL 不一致。',
    );
    assertText(record.sourceCacheId, 'sourceCacheId', 160);
    assertPublicHttpUrl(record.url, 'network material url');
    assertText(record.title, 'network material title', 180);
    assertText(record.excerpt, 'network material excerpt', 2400);
    expect(
      record.source === 'mobile' || record.source === 'backend',
      'network material source 无效。',
    );
    expect(
      record.fetchMode === 'http' || record.fetchMode === 'browser',
      'network material fetchMode 无效。',
    );
    assertTimestamp(record.fetchedAt, 'network material fetchedAt');
    return;
  }

  assertKeys(record, [
    'materialId',
    'cacheKey',
    'payload',
    'source',
    'fetchedAt',
    'expiresAt',
    'staleAllowed',
  ], kind);
  expect(
    typeof record.materialId === 'string'
      && record.materialId === fundResearchMaterialId(
        String(record.cacheKey),
      ),
    'fund material materialId 与 cacheKey 不一致。',
  );
  assertText(record.cacheKey, 'fund material cacheKey', 300);
  assertJsonValue(record.payload);
  expect(
    options.allowLargeFundPayload
      || JSON.stringify(record.payload).length <= 2_000_000,
    'fund material payload 超过 2MB 协议上限。',
  );
  assertText(record.source, 'fund material source', 80);
  assertTimestamp(record.fetchedAt, 'fund material fetchedAt');
  assertTimestamp(record.expiresAt, 'fund material expiresAt');
  expect(
    Number(record.expiresAt) >= Number(record.fetchedAt),
    'fund material 过期时间早于抓取时间。',
  );
  expect(
    typeof record.staleAllowed === 'boolean',
    'fund material staleAllowed 无效。',
  );
}

function assertFundResearchMaterialMetadata(
  record: UnknownRecord,
) {
  expect(
    typeof record.materialId === 'string'
      && record.materialId === fundResearchMaterialId(
        String(record.cacheKey),
      ),
    'fund material materialId 与 cacheKey 不一致。',
  );
  assertText(record.cacheKey, 'fund material cacheKey', 300);
  assertText(record.source, 'fund material source', 80);
  assertTimestamp(record.fetchedAt, 'fund material fetchedAt');
  assertTimestamp(record.expiresAt, 'fund material expiresAt');
  expect(
    Number(record.expiresAt) >= Number(record.fetchedAt),
    'fund material 过期时间早于抓取时间。',
  );
  expect(
    typeof record.staleAllowed === 'boolean',
    'fund material staleAllowed 无效。',
  );
}

export function assertFundResearchMaterialObjectReference(
  value: unknown,
): asserts value is FundResearchMaterialObjectReference {
  const record = recordOf(value, 'fund material object reference');
  assertKeys(record, [
    'materialId',
    'cacheKey',
    'payloadObject',
    'source',
    'fetchedAt',
    'expiresAt',
    'staleAllowed',
  ], 'fund material object reference');
  assertFundResearchMaterialMetadata(record);
  const object = recordOf(
    record.payloadObject,
    'fund material payloadObject',
  );
  assertKeys(object, [
    'objectId',
    'encoding',
    'plaintextBytes',
    'plaintextSha256',
  ], 'fund material payloadObject');
  expect(
    typeof object.objectId === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(object.objectId)
      && object.encoding === 'canonical-json-utf8'
      && Number.isSafeInteger(object.plaintextBytes)
      && Number(object.plaintextBytes) >= 1
      && typeof object.plaintextSha256 === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(object.plaintextSha256),
    'fund material payloadObject 无效。',
  );
}

export function isFundResearchMaterialObjectReference(
  value: ResearchMaterialMutationValue,
): value is FundResearchMaterialObjectReference {
  return 'payloadObject' in value;
}

export function assertResearchMaterialBusinessRecord(
  kind: ResearchMaterialRecordKind,
  value: unknown,
): asserts value is ResearchMaterialRecordValue {
  assertResearchMaterialRecord(kind, value, {
    allowLargeFundPayload: true,
  });
}

export function assertResearchMaterialsMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(
    value.entity.domain === 'research'
      && (
        RESEARCH_MATERIALS_RECORD_KINDS as readonly string[]
      ).includes(value.entity.type)
      && /^[A-Za-z0-9_-]{43}$/.test(value.entity.id),
    'research.materials mutation entity 无效。',
  );
  expect(
    value.revision.schemaVersion
      === RESEARCH_MATERIALS_SCHEMA_VERSION
      && ['upsert', 'restore', 'delete'].includes(
        value.revision.operation,
      )
      && value.sensitivity === 'high'
      && value.retentionClass
        === RESEARCH_MATERIALS_RETENTION_CLASS,
    'research.materials protocol metadata 无效。',
  );
  const payload = recordOf(
    value.payload,
    'research.materials payload',
  );
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['schemaVersion', 'kind', 'deletedAt'],
      'research.materials delete payload',
    );
    expect(
      payload.schemaVersion === RESEARCH_MATERIALS_SCHEMA_VERSION
        && payload.kind === value.entity.type,
      'research.materials delete payload metadata 无效。',
    );
    assertTimestamp(payload.deletedAt, 'research material deletedAt');
    expect(
      value.objectRefs.length === 0,
      'research.materials delete 不能携带 objectRefs。',
    );
  } else {
    assertKeys(
      payload,
      ['schemaVersion', 'kind', 'value'],
      'research.materials upsert payload',
    );
    expect(
      payload.schemaVersion === RESEARCH_MATERIALS_SCHEMA_VERSION
        && payload.kind === value.entity.type,
      'research.materials upsert payload metadata 无效。',
    );
    const kind = value.entity.type as ResearchMaterialRecordKind;
    if (
      kind === 'fund-material'
      && recordOf(payload.value, kind).payloadObject !== undefined
    ) {
      assertFundResearchMaterialObjectReference(payload.value);
      expect(
        value.objectRefs.length === 1
          && value.objectRefs[0]
            === payload.value.payloadObject.objectId,
        'research.materials 对象引用与 objectRefs 不一致。',
      );
    } else {
      assertResearchMaterialRecord(kind, payload.value);
      expect(
        value.objectRefs.length === 0,
        'research.materials 内联记录不能携带 objectRefs。',
      );
    }
    expect(
      (payload.value as ResearchMaterialMutationValue).materialId
        === value.entity.id,
      'research.materials entityId 与材料身份不一致。',
    );
  }
  assertJsonValue(payload);
}

export function researchMaterialMutationValue(
  mutation: PlainMutationV1,
) {
  assertResearchMaterialsMutationV1(mutation);
  const payload = mutation.payload as UnknownRecord;
  return {
    kind: mutation.entity.type as ResearchMaterialRecordKind,
    value: payload.value as ResearchMaterialMutationValue | undefined,
    deletedAt: payload.deletedAt as number | undefined,
  };
}

export function buildResearchMaterialUpsertMutation(input: {
  envelope: ResearchMaterialsMutationEnvelope;
  kind: ResearchMaterialRecordKind;
  value: ResearchMaterialMutationValue;
  operation?: 'upsert' | 'restore';
}) {
  if (
    input.kind === 'fund-material'
    && isFundResearchMaterialObjectReference(input.value)
  ) {
    assertFundResearchMaterialObjectReference(input.value);
  } else {
    assertResearchMaterialRecord(input.kind, input.value);
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'research',
      type: input.kind,
      id: input.value.materialId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: RESEARCH_MATERIALS_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: RESEARCH_MATERIALS_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value as unknown as JsonValue,
    },
    objectRefs: isFundResearchMaterialObjectReference(input.value)
      ? [input.value.payloadObject.objectId]
      : [],
    retentionClass: RESEARCH_MATERIALS_RETENTION_CLASS,
  };
  assertResearchMaterialsMutationV1(mutation);
  return mutation;
}

export function buildResearchMaterialDeleteMutation(input: {
  envelope: ResearchMaterialsMutationEnvelope;
  kind: ResearchMaterialRecordKind;
  materialId: string;
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
      domain: 'research',
      type: input.kind,
      id: input.materialId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: RESEARCH_MATERIALS_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: RESEARCH_MATERIALS_SCHEMA_VERSION,
      kind: input.kind,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: RESEARCH_MATERIALS_RETENTION_CLASS,
  };
  assertResearchMaterialsMutationV1(mutation);
  return mutation;
}
