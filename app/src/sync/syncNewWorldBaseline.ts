import {
  CURRENT_SNAPSHOT_MODE,
  CURRENT_SNAPSHOT_PLAN,
  indexCurrentSnapshotReaders,
  readCurrentSnapshotPage,
  type CurrentSnapshotRecordV1,
} from './syncCurrentSnapshot';
import {
  getSyncDomainCatalogEntry,
} from './syncDomainCatalog';
import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  assertPlainMutationV1,
  type PlainMutationV1,
} from './syncProtocol';
import type {
  SyncRandomUuidPort,
} from './syncMutationEnvelope';
import type {
  SyncWorldDescriptorV2,
} from './syncWorld';

export type CurrentSnapshotMutationTemplatePageV1 = Readonly<{
  mutations: readonly PlainMutationV1[];
  nextPageToken: string | null;
}>;

export interface CurrentSnapshotMutationSourceV1 {
  readonly adapterId: string;
  readMutationPage(input: {
    mode: typeof CURRENT_SNAPSHOT_MODE;
    pageToken: string | null;
    limit: number;
  }): Promise<CurrentSnapshotMutationTemplatePageV1>;
}

export type CurrentSnapshotRehearsalAdapterReport = Readonly<{
  adapterId: string;
  mutationCount: number;
  pageCount: number;
}>;

export type CurrentSnapshotRehearsalPageReport = Readonly<{
  adapterId: string;
  mutationCount: number;
  pageCount: number;
  hasMore: boolean;
}>;

export type CurrentSnapshotRehearsalReport = Readonly<{
  adapterCount: number;
  mutationCount: number;
  pageCount: number;
  adapters: readonly CurrentSnapshotRehearsalAdapterReport[];
}>;

export const CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS = Object.freeze(
  CURRENT_SNAPSHOT_PLAN
    .filter((entry) => entry.disposition === 'capture-current')
    .map((entry) => entry.adapterId),
);

export type SyncWorldBaselineCheckpointV1 = Readonly<{
  version: 1;
  world: SyncWorldDescriptorV2;
  deviceId: string;
  adapterIndex: number;
  adapterId: string | null;
  pageToken: string | null;
  mutationCount: number;
  state: 'staging' | 'complete';
  updatedAt: number;
}>;

export interface SyncWorldBaselineStoreV1 {
  loadCheckpoint(): Promise<SyncWorldBaselineCheckpointV1 | null>;
  initialize(input: {
    world: SyncWorldDescriptorV2;
    identity: SyncDevicePublicIdentityV1;
    createdAt: number;
  }): Promise<SyncWorldBaselineCheckpointV1>;
  commitPage(input: {
    expected: SyncWorldBaselineCheckpointV1;
    identity: SyncDevicePublicIdentityV1;
    mutations: readonly PlainMutationV1[];
    nextPageToken: string | null;
    nextAdapterIndex: number;
    completed: boolean;
    createdAt: number;
    randomUuid: SyncRandomUuidPort;
  }): Promise<SyncWorldBaselineCheckpointV1>;
}

function parseOffsetToken(token: string | null) {
  if (token === null) return 0;
  if (!/^(0|[1-9]\d{0,8})$/u.test(token)) {
    throw new Error('current snapshot offset token is invalid');
  }
  return Number(token);
}

function mutationOrder(left: PlainMutationV1, right: PlainMutationV1) {
  return left.entity.domain.localeCompare(right.entity.domain)
    || left.entity.type.localeCompare(right.entity.type)
    || left.entity.id.localeCompare(right.entity.id)
    || left.revision.operation.localeCompare(right.revision.operation);
}

export function createCollectedCurrentSnapshotMutationSource(input: {
  adapterId: string;
  collect(): Promise<readonly PlainMutationV1[]>;
}): CurrentSnapshotMutationSourceV1 {
  let collectedMutations: Promise<readonly PlainMutationV1[]> | null = null;
  const loadCollectedMutations = () => {
    if (!collectedMutations) {
      const collecting = input.collect().then((mutations) => (
        Object.freeze([...mutations].sort(mutationOrder))
      ));
      const retryable = collecting.catch((error) => {
        if (collectedMutations === retryable) collectedMutations = null;
        throw error;
      });
      collectedMutations = retryable;
    }
    return collectedMutations;
  };
  return Object.freeze({
    adapterId: input.adapterId,
    readMutationPage: async ({ mode, pageToken, limit }: {
      mode: typeof CURRENT_SNAPSHOT_MODE;
      pageToken: string | null;
      limit: number;
    }) => {
      if (mode !== CURRENT_SNAPSHOT_MODE) {
        throw new Error('current snapshot source received an unknown mode');
      }
      const offset = parseOffsetToken(pageToken);
      const mutations = await loadCollectedMutations();
      const page = mutations.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const nextPageToken = nextOffset < mutations.length
        ? String(nextOffset)
        : null;
      if (nextPageToken === null) collectedMutations = null;
      return Object.freeze({
        mutations: Object.freeze(page),
        nextPageToken,
      });
    },
  });
}

export function currentSnapshotRecordFromMutation(
  mutation: PlainMutationV1,
): CurrentSnapshotRecordV1 {
  assertPlainMutationV1(mutation);
  if (
    mutation.revision.operation !== 'upsert'
    && mutation.revision.operation !== 'append'
  ) {
    throw new Error(
      'current snapshot mutation must describe present state, not deletion history',
    );
  }
  return Object.freeze({
    recordVersion: 1,
    entityType: mutation.entity.type,
    entityId: mutation.entity.id,
    operation: mutation.revision.operation,
    schemaVersion: mutation.revision.schemaVersion,
    payload: mutation.payload,
    objectRefs: Object.freeze([...mutation.objectRefs]),
  });
}

export function indexCurrentSnapshotMutationSources(
  sources: readonly CurrentSnapshotMutationSourceV1[],
) {
  const readers = sources.map((source) => ({
    adapterId: source.adapterId,
    readPage: async (input: {
      mode: typeof CURRENT_SNAPSHOT_MODE;
      pageToken: string | null;
      limit: number;
    }) => {
      const page = await source.readMutationPage(input);
      return {
        records: page.mutations.map(currentSnapshotRecordFromMutation),
        nextPageToken: page.nextPageToken,
      };
    },
  }));
  indexCurrentSnapshotReaders(readers);
  return new Map(sources.map((source) => [source.adapterId, source]));
}

export async function readValidatedCurrentSnapshotMutationPage(input: {
  source: CurrentSnapshotMutationSourceV1;
  pageToken?: string | null;
  limit?: number;
}) {
  const catalog = getSyncDomainCatalogEntry(input.source.adapterId);
  if (!catalog) {
    throw new Error(`unknown current snapshot source: ${input.source.adapterId}`);
  }
  const pageToken = input.pageToken ?? null;
  const limit = input.limit ?? 50;
  const sourcePage = await input.source.readMutationPage({
    mode: CURRENT_SNAPSHOT_MODE,
    pageToken,
    limit,
  });
  const validatedPage = await readCurrentSnapshotPage({
    reader: {
      adapterId: input.source.adapterId,
      readPage: async () => ({
        records: sourcePage.mutations.map(currentSnapshotRecordFromMutation),
        nextPageToken: sourcePage.nextPageToken,
      }),
    },
    pageToken,
    limit,
  });
  for (const mutation of sourcePage.mutations) {
    if (mutation.entity.domain !== catalog.domain) {
      throw new Error(
        `${input.source.adapterId} emitted domain ${mutation.entity.domain}`,
      );
    }
    if (mutation.revision.parents.length > 0) {
      throw new Error(
        `${input.source.adapterId} current snapshot inherited revision parents`,
      );
    }
  }
  return Object.freeze({
    mutations: Object.freeze([...sourcePage.mutations]),
    records: validatedPage.records,
    nextPageToken: validatedPage.nextPageToken,
  });
}

export async function runCurrentSnapshotReadOnlyRehearsal(input: {
  sources: readonly CurrentSnapshotMutationSourceV1[];
  pageLimit?: number;
  onAdapterComplete?: (
    report: CurrentSnapshotRehearsalAdapterReport,
  ) => void;
  onPageComplete?: (
    report: CurrentSnapshotRehearsalPageReport,
  ) => void;
}) {
  const indexed = indexCurrentSnapshotMutationSources(input.sources);
  const orderedAdapterIds = CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS;
  const pageLimit = input.pageLimit ?? 50;
  const reports: CurrentSnapshotRehearsalAdapterReport[] = [];
  let mutationCount = 0;
  let pageCount = 0;
  for (const adapterId of orderedAdapterIds) {
    const source = indexed.get(adapterId);
    if (!source) throw new Error(`missing current snapshot source: ${adapterId}`);
    let pageToken: string | null = null;
    let adapterMutationCount = 0;
    let adapterPageCount = 0;
    do {
      const page = await readValidatedCurrentSnapshotMutationPage({
        source,
        pageToken,
        limit: pageLimit,
      });
      adapterMutationCount += page.mutations.length;
      adapterPageCount += 1;
      pageToken = page.nextPageToken;
      input.onPageComplete?.(Object.freeze({
        adapterId,
        mutationCount: adapterMutationCount,
        pageCount: adapterPageCount,
        hasMore: pageToken !== null,
      }));
    } while (pageToken !== null);
    const report = Object.freeze({
      adapterId,
      mutationCount: adapterMutationCount,
      pageCount: adapterPageCount,
    });
    reports.push(report);
    input.onAdapterComplete?.(report);
    mutationCount += adapterMutationCount;
    pageCount += adapterPageCount;
  }
  return Object.freeze({
    adapterCount: reports.length,
    mutationCount,
    pageCount,
    adapters: Object.freeze(reports),
  }) satisfies CurrentSnapshotRehearsalReport;
}

function assertCheckpointMatches(input: {
  checkpoint: SyncWorldBaselineCheckpointV1;
  identity: SyncDevicePublicIdentityV1;
}) {
  if (
    input.checkpoint.world.vaultId !== input.identity.vaultId
    || input.checkpoint.world.keyId !== input.identity.keyId
    || input.checkpoint.deviceId !== input.identity.deviceId
  ) {
    throw new Error('new-world baseline checkpoint identity does not match');
  }
}

export async function runNextSyncWorldBaselineBatch(input: {
  sources: readonly CurrentSnapshotMutationSourceV1[];
  store: SyncWorldBaselineStoreV1;
  identity: SyncDevicePublicIdentityV1;
  randomUuid: SyncRandomUuidPort;
  pageLimit?: number;
  now?: () => number;
}) {
  const indexed = indexCurrentSnapshotMutationSources(input.sources);
  const orderedAdapterIds = CURRENT_SNAPSHOT_CAPTURE_ADAPTER_IDS;
  const checkpoint = await input.store.loadCheckpoint();
  if (!checkpoint) {
    throw new Error('new-world baseline database has not been initialized');
  }
  assertCheckpointMatches({ checkpoint, identity: input.identity });
  if (checkpoint.state === 'complete') return checkpoint;
  const adapterId = orderedAdapterIds[checkpoint.adapterIndex];
  if (!adapterId || checkpoint.adapterId !== adapterId) {
    throw new Error('new-world baseline checkpoint adapter is invalid');
  }
  const source = indexed.get(adapterId);
  if (!source) throw new Error(`missing current snapshot source: ${adapterId}`);
  const page = await readValidatedCurrentSnapshotMutationPage({
    source,
    pageToken: checkpoint.pageToken,
    limit: input.pageLimit ?? 50,
  });
  const completedAdapter = page.nextPageToken === null;
  const nextAdapterIndex = completedAdapter
    ? checkpoint.adapterIndex + 1
    : checkpoint.adapterIndex;
  return input.store.commitPage({
    expected: checkpoint,
    identity: input.identity,
    mutations: page.mutations,
    nextPageToken: completedAdapter ? null : page.nextPageToken,
    nextAdapterIndex,
    completed: nextAdapterIndex === orderedAdapterIds.length,
    createdAt: (input.now ?? Date.now)(),
    randomUuid: input.randomUuid,
  });
}
