import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  assertResearchMaterialRecord,
  type FundResearchMaterial,
  type NetworkResearchMaterial,
} from './syncResearchMaterials';
import type {
  ResearchMaterialsBusinessPort,
} from './syncResearchMaterialsApply';
import {
  RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX,
  projectMobileResearchMaterials,
} from './syncResearchMaterialsStorageDerivation';

export const RESEARCH_MATERIALS_FUND_MIRROR_PREFIX =
  'junluo.research.fundMaterial.' as const;

type ResearchMaterialsStoragePort = {
  getItem(key: string): Promise<string | null>;
  getAllKeys(): Promise<readonly string[]>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

let applyQueue = Promise.resolve();

function enqueueApply<T>(callback: () => Promise<T>) {
  const current = applyQueue.catch(() => undefined).then(callback);
  applyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function networkKey(value: NetworkResearchMaterial) {
  return `${RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX}`
    + value.sourceCacheId;
}

function fundKey(value: FundResearchMaterial) {
  return `${RESEARCH_MATERIALS_FUND_MIRROR_PREFIX}`
    + value.materialId;
}

function serializeNetwork(value: NetworkResearchMaterial) {
  return JSON.stringify({
    cacheId: value.sourceCacheId,
    excerpt: value.excerpt,
    fetchMode: value.fetchMode,
    fetchedAt: value.fetchedAt,
    title: value.title,
    url: value.url,
  });
}

export function createResearchMaterialsBusinessPort(input: {
  storage: ResearchMaterialsStoragePort;
}): ResearchMaterialsBusinessPort {
  return {
    upsert: (change) => enqueueApply(async () => {
      assertResearchMaterialRecord(change.kind, change.value);
      if (change.kind === 'fund-material') {
        const value = change.value as FundResearchMaterial;
        await input.storage.setItem(
          fundKey(value),
          JSON.stringify(value),
        );
        return;
      }
      const value = change.value as NetworkResearchMaterial;
      const key = networkKey(value);
      const current = projectMobileResearchMaterials([[
        key,
        await input.storage.getItem(key),
      ]])[0]?.value;
      if (
        current
        && (
          current.fetchedAt > value.fetchedAt
          || (
            current.fetchedAt === value.fetchedAt
            && current.materialId >= value.materialId
          )
        )
      ) {
        return;
      }
      await input.storage.setItem(key, serializeNetwork(value));
    }),
    tombstone: (change) => enqueueApply(async () => {
      if (change.kind === 'fund-material') {
        await input.storage.removeItem(
          `${RESEARCH_MATERIALS_FUND_MIRROR_PREFIX}`
            + change.materialId,
        );
        return;
      }
      const keys = await input.storage.getAllKeys();
      const candidates = keys.filter((key) => key.startsWith(
        RESEARCH_MATERIALS_MOBILE_CACHE_PREFIX,
      ));
      const entries = await Promise.all(candidates.map(
        async (key) => [key, await input.storage.getItem(key)] as const,
      ));
      const target = projectMobileResearchMaterials(entries)
        .find((entry) =>
          entry.value.materialId === change.materialId);
      if (target) await input.storage.removeItem(target.key);
    }),
  };
}

export const researchMaterialsAsyncStorageBusinessPort =
  createResearchMaterialsBusinessPort({
    storage: RawAsyncStorage,
  });
