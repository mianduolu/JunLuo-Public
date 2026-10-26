import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  AndroidSyncObjectMetadata,
} from './syncAndroidObjectManagementCore';

const STORAGE_KEY = '@junluo/sync/object-metadata-cache:v1';

type StoredMetadata = AndroidSyncObjectMetadata & {
  updatedAt: number;
};

let writeQueue: Promise<void> = Promise.resolve();

function valid(entry: unknown): entry is StoredMetadata {
  if (!entry || typeof entry !== 'object') return false;
  const value = entry as Record<string, unknown>;
  return typeof value.objectId === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(value.objectId)
    && Number.isSafeInteger(value.ciphertextBytes)
    && Number(value.ciphertextBytes) >= 0
    && Number.isSafeInteger(value.updatedAt)
    && Number(value.updatedAt) >= 0
    && (
      value.domain === undefined
      || value.domain === null
      || (
        typeof value.domain === 'string'
        && /^[a-z0-9][a-z0-9._-]*$/.test(value.domain)
      )
    );
}

async function read(): Promise<StoredMetadata[]> {
  try {
    const serialized = await AsyncStorage.getItem(STORAGE_KEY);
    if (!serialized) return [];
    const parsed = JSON.parse(serialized) as {
      version?: unknown;
      records?: unknown;
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return [];
    return parsed.records.filter(valid);
  } catch {
    return [];
  }
}

export const syncAndroidObjectMetadataStore = {
  async list(): Promise<AndroidSyncObjectMetadata[]> {
    await writeQueue;
    return (await read()).map(({ objectId, ciphertextBytes, domain }) => ({
      objectId,
      ciphertextBytes,
      domain: domain ?? null,
    }));
  },

  record(input: StoredMetadata) {
    if (!valid(input)) {
      return Promise.reject(new Error('Android object metadata 无效。'));
    }
    const operation = writeQueue.then(async () => {
      const byId = new Map(
        (await read()).map((entry) => [entry.objectId, entry]),
      );
      byId.set(input.objectId, input);
      const records = [...byId.values()]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 256);
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, records }),
      );
    });
    writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  },
};
