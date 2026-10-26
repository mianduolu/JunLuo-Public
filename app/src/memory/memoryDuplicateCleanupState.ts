import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import type {
  MemoryDuplicateCleanupPauseReason,
  MemoryDuplicateCleanupResumePhase,
} from './memoryDuplicateCleanupCore';

export const MEMORY_DUPLICATE_CLEANUP_STORAGE_KEY =
  'junluo.sync.memoryDuplicateCleanup.journal.v1' as const;

export type MemoryDuplicateCleanupPhase =
  | 'backing-up'
  | 'cleaning'
  | 'paused'
  | 'compacting'
  | 'verifying'
  | 'publishing'
  | 'waiting-windows'
  | 'complete'
  | 'failed-restored'
  | 'recovery-blocked';

export type MemoryDuplicateCleanupJournalV1 = {
  version: 1;
  phase: MemoryDuplicateCleanupPhase;
  totalCandidates: number;
  processedCandidates: number;
  deletedLifecycleEvents: number;
  skippedCandidates: number;
  publishedThroughCursor: number | null;
  waitingDeviceCount: number;
  startedAt: number;
  updatedAt: number;
  lastErrorCode: string | null;
  resumePhase?: MemoryDuplicateCleanupResumePhase | null;
  pauseReason?: MemoryDuplicateCleanupPauseReason | null;
};

type Listener = (journal: MemoryDuplicateCleanupJournalV1 | null) => void;

const listeners = new Set<Listener>();
let writeQueue: Promise<void> = Promise.resolve();

function finiteCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function parseJournal(raw: string | null): MemoryDuplicateCleanupJournalV1 | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MemoryDuplicateCleanupJournalV1>;
    const phases: MemoryDuplicateCleanupPhase[] = [
      'backing-up',
      'cleaning',
      'paused',
      'compacting',
      'verifying',
      'publishing',
      'waiting-windows',
      'complete',
      'failed-restored',
      'recovery-blocked',
    ];
    if (value.version !== 1 || !phases.includes(value.phase as MemoryDuplicateCleanupPhase)) {
      return null;
    }
    const resumePhases: MemoryDuplicateCleanupResumePhase[] = [
      'backing-up',
      'cleaning',
      'compacting',
      'verifying',
    ];
    const pauseReasons: MemoryDuplicateCleanupPauseReason[] = [
      'manual',
      'checkpoint',
      'restart',
      'before-compaction',
    ];
    return {
      version: 1,
      phase: value.phase as MemoryDuplicateCleanupPhase,
      totalCandidates: finiteCount(value.totalCandidates),
      processedCandidates: finiteCount(value.processedCandidates),
      deletedLifecycleEvents: finiteCount(value.deletedLifecycleEvents),
      skippedCandidates: finiteCount(value.skippedCandidates),
      publishedThroughCursor: value.publishedThroughCursor === null
        || value.publishedThroughCursor === undefined
        ? null
        : finiteCount(value.publishedThroughCursor),
      waitingDeviceCount: finiteCount(value.waitingDeviceCount),
      startedAt: finiteCount(value.startedAt),
      updatedAt: finiteCount(value.updatedAt),
      lastErrorCode: typeof value.lastErrorCode === 'string'
        ? value.lastErrorCode.slice(0, 120)
        : null,
      resumePhase: resumePhases.includes(value.resumePhase as MemoryDuplicateCleanupResumePhase)
        ? value.resumePhase as MemoryDuplicateCleanupResumePhase
        : null,
      pauseReason: pauseReasons.includes(value.pauseReason as MemoryDuplicateCleanupPauseReason)
        ? value.pauseReason as MemoryDuplicateCleanupPauseReason
        : null,
    };
  } catch {
    return null;
  }
}

function publish(journal: MemoryDuplicateCleanupJournalV1 | null) {
  for (const listener of listeners) listener(journal);
}

export async function loadMemoryDuplicateCleanupJournal() {
  return parseJournal(await AsyncStorage.getItem(MEMORY_DUPLICATE_CLEANUP_STORAGE_KEY));
}

export async function saveMemoryDuplicateCleanupJournal(
  journal: MemoryDuplicateCleanupJournalV1,
) {
  const operation = writeQueue.then(() => AsyncStorage.setItem(
    MEMORY_DUPLICATE_CLEANUP_STORAGE_KEY,
    JSON.stringify(journal),
  ));
  writeQueue = operation.then(() => undefined, () => undefined);
  await operation;
  publish(journal);
}

export async function clearMemoryDuplicateCleanupJournal() {
  const operation = writeQueue.then(() => AsyncStorage.removeItem(
    MEMORY_DUPLICATE_CLEANUP_STORAGE_KEY,
  ));
  writeQueue = operation.then(() => undefined, () => undefined);
  await operation;
  publish(null);
}

export function subscribeMemoryDuplicateCleanupJournal(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function memoryDuplicateCleanupBlocksBusinessWrites(
  journal: MemoryDuplicateCleanupJournalV1 | null,
) {
  return journal !== null && [
    'backing-up',
    'cleaning',
    'paused',
    'compacting',
    'verifying',
    'recovery-blocked',
  ].includes(journal.phase);
}

export async function assertMemoryDuplicateCleanupAllowsBusinessWrites() {
  if (memoryDuplicateCleanupBlocksBusinessWrites(
    await loadMemoryDuplicateCleanupJournal(),
  )) {
    throw new Error('记忆大扫除正在安全整理本机数据，请完成或继续后再写入记忆。');
  }
}

export async function runMemoryDuplicateCleanupDataEpochCommit<T>(
  dataEpoch: number | null,
  work: () => Promise<T>,
) {
  return runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    await assertMemoryDuplicateCleanupAllowsBusinessWrites();
    return work();
  });
}

export async function runMemoryDuplicateCleanupBusinessWrite<T>(
  work: () => Promise<T>,
) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const committed = await runMemoryDuplicateCleanupDataEpochCommit(dataEpoch, work);
  if (!committed.committed) {
    throw new Error('记忆写入遇到数据维护切换，请稍后重试。');
  }
  return committed.value;
}

export async function assertMemoryDuplicateCleanupAllowsSync() {
  if (memoryDuplicateCleanupBlocksBusinessWrites(
    await loadMemoryDuplicateCleanupJournal(),
  )) {
    throw new Error('记忆大扫除尚未完成，本轮同步已暂停。');
  }
}

export function memoryDuplicateCleanupNeedsOneTimeDrain(
  journal: MemoryDuplicateCleanupJournalV1 | null,
) {
  return journal?.phase === 'publishing' || journal?.phase === 'waiting-windows';
}
