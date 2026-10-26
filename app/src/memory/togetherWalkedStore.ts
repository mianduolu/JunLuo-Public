import {
  togetherWalkedStorageBridge as AsyncStorage,
  runTogetherWalkedStorageMutation,
} from '../sync/syncTogetherWalkedLifeStorageBridge';
import * as FileSystem from 'expo-file-system/legacy';

import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { copyFileSafely } from '../storage/safeFileWrite';
import { createMemory, loadTogetherWalkedMemoryLinks, type MemoryEntry } from './memoryStore';
import {
  assertTogetherWalkedMemoryLink, togetherWalkedMaterialVersion,
  type TogetherWalkedMemoryBinding, type TogetherWalkedMemoryLink,
} from './togetherWalkedMemory';
import { parseTogetherWalkedEntriesStorage, parseTogetherWalkedJourneysStorage } from '../sync/syncTogetherWalkedLifeStorageDerivation';
import {
  assignTogetherWalkedEntriesModel,
  deleteTogetherWalkedJourneyModel,
  normalizeTogetherWalkedEntry,
  normalizeTogetherWalkedJourney,
  resolveTogetherWalkedJourneyAssignments,
  sortTogetherWalkedEntries,
  type TogetherWalkedEntry,
  type TogetherWalkedJourney,
  type TogetherWalkedLocation,
} from './togetherWalkedModel';

export type { TogetherWalkedEntry, TogetherWalkedJourney, TogetherWalkedLocation } from './togetherWalkedModel';

export const TOGETHER_WALKED_STORAGE_KEY = 'junluo.togetherWalked.entries.v1';
export const TOGETHER_WALKED_DRAFT_STORAGE_KEY = 'junluo.togetherWalked.draft.v1';
export const TOGETHER_WALKED_JOURNEYS_STORAGE_KEY = 'junluo.togetherWalked.journeys.v1';
export const TOGETHER_WALKED_IMAGE_FOLDER = 'together-walked';

export type CreateTogetherWalkedInput = {
  title: string;
  note: string;
  imageUri?: string;
  location?: TogetherWalkedLocation;
  journeyId?: string;
  occurredAt?: number;
};

export type CreateTogetherWalkedResult = {
  entry: TogetherWalkedEntry;
  imageSaveFailed: boolean;
  memorySyncFailed: boolean;
  memoryResult?: TogetherWalkedMemorySaveResult;
  entrySaveWarning?: boolean;
};

export type TogetherWalkedMemorySaveResult = {
  entry: TogetherWalkedEntry;
  memory: MemoryEntry;
  status: 'saved' | 'link_pending';
};

export type CreateTogetherWalkedJourneyInput = {
  title: string;
  description?: string;
};

type TogetherWalkedMutationOptions = {
  dataEpoch?: number | null;
};

function imageDirectory() {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${TOGETHER_WALKED_IMAGE_FOLDER}/` : undefined;
}

function extensionFromUri(uri: string) {
  const cleanUri = uri.split(/[?#]/)[0] ?? uri;
  const match = cleanUri.match(/\.([a-zA-Z0-9]{1,8})$/);
  return match ? match[1].toLowerCase() : 'jpg';
}

function isManagedTogetherWalkedImage(uri?: string) {
  const directory = imageDirectory();
  if (!uri || !directory || !uri.startsWith(directory)) return false;
  const fileName = uri.slice(directory.length);
  return !!fileName
    && fileName !== '.'
    && fileName !== '..'
    && !fileName.includes('/')
    && !fileName.includes('\\')
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName);
}

function requireTogetherWalkedDataEpoch() {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) throw new Error('backup-restore-not-ready');
  return dataEpoch;
}

function resolveTogetherWalkedDataEpoch(options: TogetherWalkedMutationOptions) {
  const dataEpoch = options.dataEpoch === undefined
    ? requireTogetherWalkedDataEpoch()
    : options.dataEpoch;
  if (dataEpoch === null) throw new Error('backup-restore-not-ready');
  return dataEpoch;
}

async function runTogetherWalkedMutation<T>(dataEpoch: number, work: (storage: typeof AsyncStorage) => Promise<T>) {
  // Acquire the restore lease before the domain queue. Waiting for a restore
  // must not occupy the queue that the restore itself may need.
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => runTogetherWalkedStorageMutation(async storage => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('backup-restore-data-epoch-changed');
    return work(storage);
  }));
  if (!committed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) {
    throw new Error('backup-restore-data-epoch-changed');
  }
  return committed.value;
}

async function saveEntries(entries: TogetherWalkedEntry[], storage: typeof AsyncStorage) {
  await storage.setItem(TOGETHER_WALKED_STORAGE_KEY, JSON.stringify(sortTogetherWalkedEntries(entries)));
}

async function saveJourneys(journeys: TogetherWalkedJourney[], storage: typeof AsyncStorage) {
  await storage.setItem(
    TOGETHER_WALKED_JOURNEYS_STORAGE_KEY,
    JSON.stringify([...journeys].sort((left, right) => right.updatedAt - left.updatedAt)),
  );
}

function touchJourneys(journeys: TogetherWalkedJourney[], journeyIds: Array<string | undefined>, updatedAt: number) {
  const ids = new Set(journeyIds.filter((id): id is string => !!id));
  if (!ids.size) return journeys;
  return journeys.map((journey) => ids.has(journey.id) ? { ...journey, updatedAt } : journey);
}

async function copyImageToAppStorage(sourceUri: string) {
  const directory = imageDirectory();
  if (!directory) throw new Error('document-directory-unavailable');
  const persistentUri = `${directory}together_walked_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extensionFromUri(sourceUri)}`;
  await copyFileSafely({ from: sourceUri, to: persistentUri });
  return persistentUri;
}

function buildMemoryContent(entry: TogetherWalkedEntry) {
  const lines = [
    `一起走过：${entry.title}`,
    entry.note.trim(),
    entry.location?.label ? `地点：${entry.location.label}` : '',
    typeof entry.location?.latitude === 'number' && typeof entry.location.longitude === 'number'
      ? `坐标：${entry.location.latitude.toFixed(5)}, ${entry.location.longitude.toFixed(5)}`
      : '',
    `时间：${new Date(entry.createdAt).toLocaleString('zh-CN')}`,
  ].filter(Boolean);
  return lines.join('\n');
}

async function syncEntryToMemory(entry: TogetherWalkedEntry, dataEpoch: number) {
  const tags = ['一起走过', '出门', entry.location?.label].filter((tag): tag is string => !!tag);
  const recallCues = [entry.title, entry.location?.label, '一起走过'].filter((cue): cue is string => !!cue);
  return createMemory({
    title: entry.title,
    content: buildMemoryContent(entry),
    domain: '经历',
    tags,
    recallCues,
    importance: 6,
    valence: 0.75,
    arousal: 0.35,
    pinned: false,
    anchor: false,
    type: 'dynamic',
    resolved: false,
    digested: false,
    protected: false,
    eventAt: entry.createdAt,
    source: `together-walked:${entry.id}`,
    sourceType: 'manual',
  }, { dataEpoch, returnRecord: true, togetherWalkedBinding: {
    id: entry.id, memoryId: entry.memoryId, materialVersion: togetherWalkedMaterialVersion(entry), dataEpoch,
  } });
}

export async function loadTogetherWalkedEntriesStrict(storage: Pick<typeof AsyncStorage, 'getItem'> = AsyncStorage): Promise<TogetherWalkedEntry[]> {
  return sortTogetherWalkedEntries(parseTogetherWalkedEntriesStorage(await storage.getItem(TOGETHER_WALKED_STORAGE_KEY)));
}

export async function loadTogetherWalkedDataStrict(storage: Pick<typeof AsyncStorage, 'getItem'> = AsyncStorage) {
  const [entries, journeys] = await Promise.all([
    loadTogetherWalkedEntriesStrict(storage),
    storage.getItem(TOGETHER_WALKED_JOURNEYS_STORAGE_KEY).then(parseTogetherWalkedJourneysStorage),
  ]);
  return { entries: resolveTogetherWalkedJourneyAssignments(entries, journeys), journeys };
}

export async function isTogetherWalkedMemoryBindingCurrent(binding: TogetherWalkedMemoryBinding) {
  if (!canCommitBackupRestoreDataEpoch(binding.dataEpoch)) return false;
  const entry = (await loadTogetherWalkedEntriesStrict()).find(item => item.id === binding.id);
  return !!entry && entry.memoryId === binding.memoryId
    && togetherWalkedMaterialVersion(entry) === binding.materialVersion
    && canCommitBackupRestoreDataEpoch(binding.dataEpoch);
}

export async function loadTogetherWalkedEntryMemoryLink(id: string): Promise<TogetherWalkedMemoryLink> {
  const dataEpoch = requireTogetherWalkedDataEpoch();
  const entry = (await loadTogetherWalkedEntriesStrict()).find(item => item.id === id);
  if (!entry) throw new Error('TOGETHER_WALKED_NOT_FOUND');
  const link = (await loadTogetherWalkedMemoryLinks([entry])).get(id)!;
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('backup-restore-data-epoch-changed');
  return link;
}

export async function retryTogetherWalkedMemory(
  id: string, options: TogetherWalkedMutationOptions = {},
): Promise<TogetherWalkedMemorySaveResult> {
  const dataEpoch = resolveTogetherWalkedDataEpoch(options);
  return runTogetherWalkedMutation(dataEpoch, async storage => {
    const entry = (await loadTogetherWalkedEntriesStrict(storage)).find(item => item.id === id);
    if (!entry) throw new Error('TOGETHER_WALKED_NOT_FOUND');
    let memory: MemoryEntry;
    try {
      memory = await syncEntryToMemory(entry, dataEpoch);
    } catch (error) {
      // A store may fail after committing. Re-read the real card, never create again here.
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)
        || error instanceof Error && error.message === 'TOGETHER_WALKED_SOURCE_CHANGED') throw error;
      const link = (await loadTogetherWalkedMemoryLinks([entry])).get(id)!;
      assertTogetherWalkedMemoryLink(link);
      if (!link.memory) throw error;
      return { entry, memory: link.memory, status: 'link_pending' };
    }
    let latestEntries: TogetherWalkedEntry[];
    try { latestEntries = await loadTogetherWalkedEntriesStrict(storage); }
    catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw error;
      return { entry, memory, status: 'link_pending' };
    }
    const latest = latestEntries.find(item => item.id === id);
    if (!latest || togetherWalkedMaterialVersion(latest) !== togetherWalkedMaterialVersion(entry)
      || latest.memoryId !== entry.memoryId || !canCommitBackupRestoreDataEpoch(dataEpoch)) {
      throw new Error('TOGETHER_WALKED_SOURCE_CHANGED');
    }
    const link = (await loadTogetherWalkedMemoryLinks([latest])).get(id)!;
    assertTogetherWalkedMemoryLink(link);
    if (link.memory?.id !== memory.id) throw new Error('TOGETHER_WALKED_SOURCE_CHANGED');
    memory = link.memory;
    if (latest.memoryId === memory.id) return { entry: latest, memory, status: 'saved' };
    const linkedEntry = { ...latest, memoryId: memory.id };
    try {
      await saveEntries(latestEntries.map(item => item.id === id ? linkedEntry : item), storage);
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw error;
      // Sync capture can fail after its business write; report the actual mirror.
      try {
        const stored = (await loadTogetherWalkedEntriesStrict(storage)).find(item => item.id === id);
        if (stored?.memoryId === memory.id && togetherWalkedMaterialVersion(stored) === togetherWalkedMaterialVersion(latest)) {
          return { entry: stored, memory, status: 'saved' };
        }
      } catch { /* The real card is known; only the mirror remains unverified. */ }
      return { entry: latest, memory, status: 'link_pending' };
    }
    return { entry: linkedEntry, memory, status: 'saved' };
  });
}

export async function loadTogetherWalkedEntries() {
  try {
    const raw = await AsyncStorage.getItem(TOGETHER_WALKED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return sortTogetherWalkedEntries(
      parsed.map(normalizeTogetherWalkedEntry).filter((entry): entry is TogetherWalkedEntry => !!entry),
    );
  } catch {
    return [];
  }
}

export async function loadTogetherWalkedJourneys() {
  try {
    const raw = await AsyncStorage.getItem(TOGETHER_WALKED_JOURNEYS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeTogetherWalkedJourney)
      .filter((journey): journey is TogetherWalkedJourney => !!journey)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

export async function loadTogetherWalkedData() {
  const [entries, journeys] = await Promise.all([loadTogetherWalkedEntries(), loadTogetherWalkedJourneys()]);
  return { entries: resolveTogetherWalkedJourneyAssignments(entries, journeys), journeys };
}

export async function createTogetherWalkedEntry(
  input: CreateTogetherWalkedInput,
  options: TogetherWalkedMutationOptions = {},
): Promise<CreateTogetherWalkedResult> {
  const dataEpoch = resolveTogetherWalkedDataEpoch(options);
  const now = Date.now();
  const occurredAt = typeof input.occurredAt === 'number' && Number.isFinite(input.occurredAt) ? input.occurredAt : now;
  let imageUri = input.imageUri;
  let imageSaveFailed = false;

  if (imageUri) {
    try {
      imageUri = await copyImageToAppStorage(imageUri);
    } catch {
      imageUri = undefined;
      imageSaveFailed = true;
    }
  }

  let attemptedEntry: TogetherWalkedEntry | undefined;
  let entrySaveWarning = false;
  let entry: TogetherWalkedEntry;
  try {
    entry = await runTogetherWalkedMutation(dataEpoch, async storage => {
      const data = await loadTogetherWalkedDataStrict(storage);
      const journeyId = input.journeyId && data.journeys.some((journey) => journey.id === input.journeyId)
        ? input.journeyId
        : undefined;
      const nextEntry: TogetherWalkedEntry = {
        id: `together-walked-${now}-${Math.random().toString(36).slice(2, 10)}`,
        title: input.title.trim(),
        note: input.note.trim(),
        imageUri,
        location: input.location,
        journeyId,
        createdAt: occurredAt,
        updatedAt: now,
      };
      attemptedEntry = nextEntry;
      await saveEntries([nextEntry, ...data.entries], storage);
      await saveJourneys(touchJourneys(data.journeys, [journeyId], now), storage);
      return nextEntry;
    });
  } catch (error) {
    if (!attemptedEntry || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw error;
    const stored = (await loadTogetherWalkedEntriesStrict()).find(item => item.id === attemptedEntry!.id);
    if (!stored) throw error;
    entry = stored;
    entrySaveWarning = true;
  }

  let memorySyncFailed = false;
  let memoryResult: TogetherWalkedMemorySaveResult | undefined;
  try {
    memoryResult = await retryTogetherWalkedMemory(entry.id, { dataEpoch });
    entry = memoryResult.entry;
    memorySyncFailed = memoryResult.status !== 'saved';
  } catch (error) {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw error;
    memorySyncFailed = true;
  }

  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) {
    throw new Error('backup-restore-data-epoch-changed');
  }
  return { entry, imageSaveFailed, memorySyncFailed, memoryResult, entrySaveWarning };
}

export async function deleteTogetherWalkedEntry(
  id: string,
  options: TogetherWalkedMutationOptions = {},
) {
  const dataEpoch = resolveTogetherWalkedDataEpoch(options);
  return runTogetherWalkedMutation(dataEpoch, async storage => {
    const data = await loadTogetherWalkedDataStrict(storage);
    const target = data.entries.find((entry) => entry.id === id);
    const now = Date.now();
    await saveEntries(data.entries.filter((entry) => entry.id !== id), storage);
    await saveJourneys(touchJourneys(data.journeys, [target?.journeyId], now), storage);
    if (isManagedTogetherWalkedImage(target?.imageUri)) {
      await FileSystem.deleteAsync(target!.imageUri!, { idempotent: true }).catch(() => undefined);
    }
    return target;
  });
}

export async function createTogetherWalkedJourney(
  input: CreateTogetherWalkedJourneyInput,
  options: TogetherWalkedMutationOptions = {},
) {
  const dataEpoch = resolveTogetherWalkedDataEpoch(options);
  const title = input.title.trim();
  if (!title) throw new Error('journey-title-required');
  const now = Date.now();
  const journey: TogetherWalkedJourney = {
    id: `together-walked-journey-${now}-${Math.random().toString(36).slice(2, 10)}`,
    title,
    description: input.description?.trim() ?? '',
    createdAt: now,
    updatedAt: now,
  };
  return runTogetherWalkedMutation(dataEpoch, async storage => {
    const journeys = (await loadTogetherWalkedDataStrict(storage)).journeys;
    await saveJourneys([journey, ...journeys], storage);
    return journey;
  });
}

export async function updateTogetherWalkedJourney(
  id: string,
  input: CreateTogetherWalkedJourneyInput,
  options: TogetherWalkedMutationOptions = {},
) {
  const dataEpoch = resolveTogetherWalkedDataEpoch(options);
  const title = input.title.trim();
  if (!title) throw new Error('journey-title-required');
  return runTogetherWalkedMutation(dataEpoch, async storage => {
    const journeys = (await loadTogetherWalkedDataStrict(storage)).journeys;
    const current = journeys.find((journey) => journey.id === id);
    if (!current) throw new Error('journey-not-found');
    const next = {
      ...current,
      title,
      description: input.description?.trim() ?? '',
      updatedAt: Date.now(),
    };
    await saveJourneys(journeys.map((journey) => journey.id === id ? next : journey), storage);
    return next;
  });
}

export async function assignTogetherWalkedEntries(
  entryIds: string[],
  journeyId?: string,
  options: TogetherWalkedMutationOptions = {},
) {
  const dataEpoch = resolveTogetherWalkedDataEpoch(options);
  return runTogetherWalkedMutation(dataEpoch, async storage => {
    const data = await loadTogetherWalkedDataStrict(storage);
    if (journeyId && !data.journeys.some((journey) => journey.id === journeyId)) {
      throw new Error('journey-not-found');
    }
    const ids = new Set(entryIds);
    const affectedJourneyIds = data.entries
      .filter((entry) => ids.has(entry.id))
      .map((entry) => entry.journeyId);
    const now = Date.now();
    const entries = assignTogetherWalkedEntriesModel(data.entries, entryIds, journeyId, now);
    const journeys = touchJourneys(data.journeys, [...affectedJourneyIds, journeyId], now);
    await saveEntries(entries, storage);
    await saveJourneys(journeys, storage);
    return { entries, journeys };
  });
}

export async function deleteTogetherWalkedJourney(
  id: string,
  deleteEntries: boolean,
  options: TogetherWalkedMutationOptions = {},
) {
  const dataEpoch = resolveTogetherWalkedDataEpoch(options);
  return runTogetherWalkedMutation(dataEpoch, async storage => {
    const data = await loadTogetherWalkedDataStrict(storage);
    if (!data.journeys.some((journey) => journey.id === id)) throw new Error('journey-not-found');
    const result = deleteTogetherWalkedJourneyModel(data.journeys, data.entries, id, deleteEntries, Date.now());
    await saveEntries(result.entries, storage);
    await saveJourneys(result.journeys, storage);
    await Promise.all(
      result.deletedEntries
        .filter((entry) => isManagedTogetherWalkedImage(entry.imageUri))
        .map((entry) => FileSystem.deleteAsync(entry.imageUri!, { idempotent: true }).catch(() => undefined)),
    );
    return result;
  });
}
