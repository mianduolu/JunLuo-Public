import {
  buildResearchMaterialUpsertMutation,
  networkResearchMaterialId,
  type NetworkResearchMaterial,
  type ResearchMaterialsMutationEnvelope,
} from './syncResearchMaterials';
import type { PlainMutationV1 } from './syncProtocol';

export const RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX =
  'junluo.lifeResearch.mobileCache.' as const;

export type ResearchMaterialsStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type ResearchMaterialProjection = {
  key: string;
  value: NetworkResearchMaterial;
};

export type ResearchMaterialsEnvelopeFactory = (
  entity: {
    domain: 'research';
    type: 'network-material';
    id: string;
  },
) => Promise<ResearchMaterialsMutationEnvelope>;

type UnknownRecord = Record<string, unknown>;

function parsePage(
  key: string,
  raw: string | null,
): ResearchMaterialProjection | undefined {
  if (
    !key.startsWith(RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX)
    || !raw
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const page = parsed as UnknownRecord;
  if (
    typeof page.cacheId !== 'string'
    || page.cacheId.trim().length < 1
    || page.cacheId.length > 160
    || key
      !== `${RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX}${page.cacheId}`
    || typeof page.url !== 'string'
    || typeof page.title !== 'string'
    || typeof page.excerpt !== 'string'
    || !Number.isSafeInteger(page.fetchedAt)
  ) {
    return undefined;
  }
  const value: NetworkResearchMaterial = {
    materialId: networkResearchMaterialId(page.url),
    sourceCacheId: page.cacheId,
    url: page.url,
    title: page.title,
    excerpt: page.excerpt,
    source: 'mobile',
    fetchMode: page.fetchMode === 'browser' ? 'browser' : 'http',
    fetchedAt: Number(page.fetchedAt),
  };
  try {
    buildResearchMaterialUpsertMutation({
      envelope: {
        mutationId: '40000000-0000-4000-8000-000000000001',
        vaultId: '10000000-0000-4000-8000-000000000001',
        sourceDeviceId: '20000000-0000-4000-8000-000000000002',
        sourceSequence: 1,
        revisionId: '50000000-0000-4000-8000-000000000001',
        parentRevisionIds: [],
        createdAt: value.fetchedAt,
      },
      kind: 'network-material',
      value,
    });
  } catch {
    return undefined;
  }
  return { key, value };
}

export function projectMobileResearchMaterials(
  entries: readonly (readonly [string, string | null])[],
) {
  return entries
    .map(([key, raw]) => parsePage(key, raw))
    .filter(
      (value): value is ResearchMaterialProjection => !!value,
    )
    .sort((left, right) =>
      left.value.materialId.localeCompare(right.value.materialId));
}

function projectionMap(
  values: readonly ResearchMaterialProjection[],
) {
  return new Map(values.map((value) => [
    value.value.materialId,
    value,
  ]));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

export async function deriveMobileResearchMaterialMutations(input: {
  previous: readonly ResearchMaterialProjection[];
  next: readonly ResearchMaterialProjection[];
  capturedAt: number;
  envelopeFactory: ResearchMaterialsEnvelopeFactory;
}) {
  const previous = projectionMap(input.previous);
  const mutations: PlainMutationV1[] = [];
  for (const next of input.next) {
    const before = previous.get(next.value.materialId);
    if (
      before
      && canonicalJson(before.value) === canonicalJson(next.value)
    ) {
      continue;
    }
    const envelope = await input.envelopeFactory({
      domain: 'research',
      type: 'network-material',
      id: next.value.materialId,
    });
    mutations.push(buildResearchMaterialUpsertMutation({
      envelope: { ...envelope, createdAt: input.capturedAt },
      kind: 'network-material',
      value: next.value,
    }));
  }
  return mutations;
}

export function researchMaterialsStorageOverrides(
  changes: readonly ResearchMaterialsStorageChange[],
) {
  return changes.filter((change) =>
    change.kind === 'set'
    && change.key.startsWith(
      RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX,
    ));
}
