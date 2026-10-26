import {
  SYNC_DOMAIN_CATALOG,
} from './syncDomainCatalog';
import {
  assertJsonValue,
  type JsonValue,
} from './syncProtocol';

export type CurrentSnapshotMode = Readonly<{
  version: 1;
  kind: 'current-business-state';
  businessWriteAllowed: false;
  normalizationWriteAllowed: false;
  retentionCleanupAllowed: false;
  indexWriteAllowed: false;
  promotionAllowed: false;
  syncHistoryReadAllowed: false;
}>;

export const CURRENT_SNAPSHOT_MODE: CurrentSnapshotMode = Object.freeze({
  version: 1,
  kind: 'current-business-state',
  businessWriteAllowed: false,
  normalizationWriteAllowed: false,
  retentionCleanupAllowed: false,
  indexWriteAllowed: false,
  promotionAllowed: false,
  syncHistoryReadAllowed: false,
});

export type CurrentSnapshotDisposition =
  | 'capture-current'
  | 'covered-by-parent'
  | 'skip-local-journal'
  | 'defer-to-windows'
  | 'exclude-from-ordinary-sync';

export type CurrentSnapshotPlanEntry = Readonly<{
  adapterId: string;
  sourceRefs: readonly string[];
  entityTypes: readonly string[];
  disposition: CurrentSnapshotDisposition;
  ownerAdapterId: string | null;
  coveredAdapterIds: readonly string[];
  reason: string;
}>;

function dispositionFor(adapterId: string): Pick<
CurrentSnapshotPlanEntry,
'disposition' | 'ownerAdapterId' | 'coveredAdapterIds' | 'reason'
> {
  if (adapterId === 'chat.objects') {
    return {
      disposition: 'covered-by-parent',
      ownerAdapterId: 'chat.core',
      coveredAdapterIds: [],
      reason: 'message object references stay with the chat.core snapshot',
    };
  }
  if (adapterId === 'continuity.pending-operation') {
    return {
      disposition: 'skip-local-journal',
      ownerAdapterId: null,
      coveredAdapterIds: [],
      reason: 'local crash-recovery journal is not shared business state',
    };
  }
  if (adapterId === 'desktop.preferences') {
    return {
      disposition: 'defer-to-windows',
      ownerAdapterId: null,
      coveredAdapterIds: [],
      reason: 'Windows publishes fresh local preferences after joining',
    };
  }
  if (
    adapterId === 'vault.shared-secrets'
    || adapterId === 'vault.exportable-sessions'
  ) {
    return {
      disposition: 'exclude-from-ordinary-sync',
      ownerAdapterId: null,
      coveredAdapterIds: [],
      reason: 'shared secrets move through the separate secret package',
    };
  }
  return {
    disposition: 'capture-current',
    ownerAdapterId: null,
    coveredAdapterIds: adapterId === 'chat.core' ? ['chat.objects'] : [],
    reason: 'read current Android business state through the domain reader',
  };
}

export const CURRENT_SNAPSHOT_PLAN: readonly CurrentSnapshotPlanEntry[] =
  Object.freeze(SYNC_DOMAIN_CATALOG.map((entry) => Object.freeze({
    adapterId: entry.adapterId,
    sourceRefs: Object.freeze([...entry.sourceRefs]),
    entityTypes: Object.freeze([...entry.entityTypes]),
    ...dispositionFor(entry.adapterId),
  })));

if (CURRENT_SNAPSHOT_PLAN.length !== 41) {
  throw new Error('current snapshot plan must cover exactly 41 adapters');
}

export function resolveCurrentSnapshotPlan(adapterId: string) {
  const entry = CURRENT_SNAPSHOT_PLAN.find(
    (candidate) => candidate.adapterId === adapterId,
  );
  if (!entry) {
    throw new Error(`unknown current snapshot adapter: ${adapterId}`);
  }
  return entry;
}

export type CurrentSnapshotRecordV1 = Readonly<{
  recordVersion: 1;
  entityType: string;
  entityId: string;
  operation: 'upsert' | 'append';
  schemaVersion: number;
  payload: JsonValue;
  objectRefs: readonly string[];
}>;

export type CurrentSnapshotPageV1 = Readonly<{
  records: readonly CurrentSnapshotRecordV1[];
  nextPageToken: string | null;
}>;

export interface CurrentSnapshotReaderV1 {
  readonly adapterId: string;
  readPage(input: {
    mode: CurrentSnapshotMode;
    pageToken: string | null;
    limit: number;
  }): Promise<CurrentSnapshotPageV1>;
}

export function indexCurrentSnapshotReaders(
  readers: readonly CurrentSnapshotReaderV1[],
) {
  const expectedAdapterIds = CURRENT_SNAPSHOT_PLAN
    .filter((entry) => entry.disposition === 'capture-current')
    .map((entry) => entry.adapterId);
  const indexed = new Map<string, CurrentSnapshotReaderV1>();
  for (const reader of readers) {
    const plan = resolveCurrentSnapshotPlan(reader.adapterId);
    if (plan.disposition !== 'capture-current') {
      throw new Error(
        `${plan.adapterId} does not accept a current snapshot reader`,
      );
    }
    if (indexed.has(reader.adapterId)) {
      throw new Error(
        `duplicate current snapshot reader: ${reader.adapterId}`,
      );
    }
    indexed.set(reader.adapterId, reader);
  }
  const missing = expectedAdapterIds.filter(
    (adapterId) => !indexed.has(adapterId),
  );
  if (missing.length > 0 || indexed.size !== expectedAdapterIds.length) {
    throw new Error(
      `current snapshot readers are incomplete: ${missing.join(', ')}`,
    );
  }
  return indexed as ReadonlyMap<string, CurrentSnapshotReaderV1>;
}

function recordOf(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
}

export function assertCurrentSnapshotRecordV1(
  value: unknown,
): asserts value is CurrentSnapshotRecordV1 {
  const record = recordOf(value, 'current snapshot record');
  const expected = [
    'recordVersion',
    'entityType',
    'entityId',
    'operation',
    'schemaVersion',
    'payload',
    'objectRefs',
  ];
  if (
    Object.keys(record).some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error('current snapshot record fields do not match v1');
  }
  if (record.recordVersion !== 1) {
    throw new Error('current snapshot record version is not supported');
  }
  assertBoundedString(record.entityType, 'snapshot entityType', 160);
  assertBoundedString(record.entityId, 'snapshot entityId', 512);
  if (record.operation !== 'upsert' && record.operation !== 'append') {
    throw new Error('current snapshot operation must be upsert or append');
  }
  if (
    !Number.isSafeInteger(record.schemaVersion)
    || (record.schemaVersion as number) < 1
  ) {
    throw new Error('current snapshot schemaVersion must be positive');
  }
  assertJsonValue(record.payload, 'current snapshot payload');
  if (!Array.isArray(record.objectRefs) || record.objectRefs.length > 256) {
    throw new Error('current snapshot objectRefs must be a bounded array');
  }
  const objectRefs = new Set<string>();
  for (const objectRef of record.objectRefs) {
    assertBoundedString(objectRef, 'current snapshot objectRef', 512);
    if (objectRefs.has(objectRef)) {
      throw new Error('current snapshot objectRefs must be unique');
    }
    objectRefs.add(objectRef);
  }
}

function assertPageToken(value: unknown, label: string) {
  if (
    value !== null
    && (
      typeof value !== 'string'
      || value.length < 1
      || value.length > 2_048
    )
  ) {
    throw new Error(`${label} must be null or a bounded string`);
  }
}

export async function readCurrentSnapshotPage(input: {
  reader: CurrentSnapshotReaderV1;
  pageToken?: string | null;
  limit?: number;
}): Promise<CurrentSnapshotPageV1> {
  const plan = resolveCurrentSnapshotPlan(input.reader.adapterId);
  if (plan.disposition !== 'capture-current') {
    throw new Error(
      `${plan.adapterId} current snapshot disposition is ${plan.disposition}`,
    );
  }
  const pageToken = input.pageToken ?? null;
  const limit = input.limit ?? 100;
  assertPageToken(pageToken, 'current snapshot pageToken');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('current snapshot page limit must be between 1 and 100');
  }
  const page = await input.reader.readPage({
    mode: CURRENT_SNAPSHOT_MODE,
    pageToken,
    limit,
  });
  const pageRecord = recordOf(page, 'current snapshot page');
  if (
    Object.keys(pageRecord).some(
      (key) => key !== 'records' && key !== 'nextPageToken',
    )
    || !('records' in pageRecord)
    || !('nextPageToken' in pageRecord)
  ) {
    throw new Error('current snapshot page fields do not match v1');
  }
  if (!Array.isArray(page.records) || page.records.length > limit) {
    throw new Error('current snapshot page exceeds its bounded limit');
  }
  const entityKeys = new Set<string>();
  for (const record of page.records) {
    assertCurrentSnapshotRecordV1(record);
    if (!plan.entityTypes.includes(record.entityType)) {
      throw new Error(
        `${plan.adapterId} cannot snapshot entity type ${record.entityType}`,
      );
    }
    const key = `${record.entityType}\u0000${record.entityId}`;
    if (entityKeys.has(key)) {
      throw new Error('current snapshot page contains duplicate entities');
    }
    entityKeys.add(key);
  }
  assertPageToken(page.nextPageToken, 'current snapshot nextPageToken');
  if (
    page.nextPageToken !== null
    && page.nextPageToken === pageToken
  ) {
    throw new Error('current snapshot reader did not advance its page token');
  }
  return Object.freeze({
    records: Object.freeze([...page.records]),
    nextPageToken: page.nextPageToken,
  });
}
