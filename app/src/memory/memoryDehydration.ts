import type { AiConnection } from '../ai/types';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { generateMemoryDehydrationWithAi } from './memoryOrganizer';
import { currentMemoryComments, memoryDehydrationComments, memoryDehydrationSource } from './memoryCurrentMaterials';
import {
  createMemoryComment,
  isDailyImpressionMemory,
  isTimelineEligibleMemory,
  isWhisperMemory,
  isCurrentMemory,
  loadMemories,
  loadMemory,
  loadMemoryComments,
  type MemoryEntry,
} from './memoryStore';

const DAY_MS = 86400000;
const DEFAULT_LIMIT = 5;
const MIN_INACTIVE_DAYS = 30;
const MIN_CONTENT_LENGTH = 180;
const RECENT_DEHYDRATION_DAYS = 30;

export type MemoryDehydrationAi = {
  apiKey: string;
  connection: AiConnection;
};

export type MemoryDehydrationBlockReason =
  | 'not_timeline_eligible'
  | 'pinned_or_protected'
  | 'anchor'
  | 'permanent'
  | 'archived'
  | 'feel'
  | 'whisper'
  | 'daily_impression'
  | 'too_short'
  | 'too_recent'
  | 'recent_dehydration_exists';

export type MemoryDehydrationDiagnostic = {
  eligible: boolean;
  reasons: MemoryDehydrationBlockReason[];
  contentLength: number;
  inactiveDays: number;
  minContentLength: number;
  minInactiveDays: number;
  latestDehydrationAt?: number;
};

function clampLimit(limit?: number) {
  return Math.max(1, Math.min(DEFAULT_LIMIT, Math.round(limit ?? DEFAULT_LIMIT)));
}

function hasRecentDehydrationComment(memory: MemoryEntry, comments: Awaited<ReturnType<typeof loadMemoryComments>>, now: number) {
  return currentMemoryComments(memory, comments).some((comment) => (
    comment.kind === 'dehydration'
    && now - comment.createdAt < RECENT_DEHYDRATION_DAYS * DAY_MS
  ));
}

function latestDehydrationAt(comments: Awaited<ReturnType<typeof loadMemoryComments>>) {
  return comments
    .filter((comment) => comment.kind === 'dehydration')
    .reduce<number | undefined>((latest, comment) => (
      latest === undefined || comment.createdAt > latest ? comment.createdAt : latest
    ), undefined);
}

function getDehydrationBlockReasons(memory: MemoryEntry, now: number) {
  const reasons: MemoryDehydrationBlockReason[] = [];
  if (isBaiyunPostMemory(memory) || !memory.understandingSubject && !isTimelineEligibleMemory(memory)) reasons.push('not_timeline_eligible');
  if (memory.pinned || memory.protected) reasons.push('pinned_or_protected');
  if (memory.anchor) reasons.push('anchor');
  if (memory.type === 'permanent') reasons.push('permanent');
  if (memory.type === 'archived') reasons.push('archived');
  if (memory.type === 'feel') reasons.push('feel');
  if (isWhisperMemory(memory)) reasons.push('whisper');
  if (isDailyImpressionMemory(memory)) reasons.push('daily_impression');
  if (memory.content.trim().length < MIN_CONTENT_LENGTH) reasons.push('too_short');
  if (memory.activationCount <= 0 || memory.lastActiveAt <= 0 || now - memory.lastActiveAt < MIN_INACTIVE_DAYS * DAY_MS) reasons.push('too_recent');
  return reasons;
}

function isDehydrationCandidate(memory: MemoryEntry, now: number) {
  return getDehydrationBlockReasons(memory, now).length === 0;
}

export async function explainMemoryDehydrationEligibility(
  memoryOrId: MemoryEntry | string,
  options: { now?: number } = {},
): Promise<MemoryDehydrationDiagnostic | null> {
  const now = options.now ?? Date.now();
  const memory = typeof memoryOrId === 'string' ? await loadMemory(memoryOrId) : memoryOrId;
  if (!memory) return null;

  const comments = await loadMemoryComments(memory.id);
  const reasons = getDehydrationBlockReasons(memory, now);
  if (!(await isCurrentMemory(memory))) reasons.push('not_timeline_eligible');
  const latestDehydration = latestDehydrationAt(currentMemoryComments(memory, comments));
  if (latestDehydration !== undefined && now - latestDehydration < RECENT_DEHYDRATION_DAYS * DAY_MS) {
    reasons.push('recent_dehydration_exists');
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    contentLength: memory.content.trim().length,
    inactiveDays: memory.activationCount > 0 && memory.lastActiveAt > 0 ? Math.max(0, Math.floor((now - memory.lastActiveAt) / DAY_MS)) : 0,
    minContentLength: MIN_CONTENT_LENGTH,
    minInactiveDays: MIN_INACTIVE_DAYS,
    latestDehydrationAt: latestDehydration,
  };
}

export async function findMemoryDehydrationCandidates(options: { limit?: number; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const limit = clampLimit(options.limit);
  const memories = await loadMemories({ currentOnly: true });
  const preliminaries = memories
    .filter((memory) => isDehydrationCandidate(memory, now))
    .sort((left, right) => (
      left.lastActiveAt - right.lastActiveAt
      || right.content.length - left.content.length
      || right.importance - left.importance
    ));

  const candidates: MemoryEntry[] = [];
  for (const memory of preliminaries) {
    const comments = await loadMemoryComments(memory.id);
    if (hasRecentDehydrationComment(memory, comments, now)) continue;
    candidates.push(memory);
    if (candidates.length >= limit) break;
  }
  return candidates;
}

export async function dehydrateMemory(
  memoryId: string,
  ai: MemoryDehydrationAi,
  options: { dataEpoch?: number | null } = {},
) {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const snapshot = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const memory = await loadMemory(memoryId);
    const now = Date.now();
    if (!memory) return { kind: 'blocked' as const, reason: 'not_found' };
    if (!(await isCurrentMemory(memory))) return { kind: 'blocked' as const, reason: 'not_candidate' };
    if (!isDehydrationCandidate(memory, now)) return { kind: 'blocked' as const, reason: 'not_candidate' };
    const comments = await loadMemoryComments(memory.id);
    if (hasRecentDehydrationComment(memory, comments, now)) {
      return { kind: 'blocked' as const, reason: 'recent_dehydration_exists' };
    }
    return { comments, kind: 'ready' as const, memory };
  });
  if (!snapshot.committed) return { ok: false, reason: 'stale_epoch' };
  if (snapshot.value.kind === 'blocked') return { ok: false, reason: snapshot.value.reason };
  const { comments, memory } = snapshot.value;
  const source = memoryDehydrationSource(memory, comments);

  const summary = await generateMemoryDehydrationWithAi({
    ...ai,
    memory,
    comments: memoryDehydrationComments(comments).map((comment) => comment.content),
  });
  if (!summary.trim()) return { ok: false, reason: 'empty_summary' };
  if (summary.trim() === memory.content.trim()) return { ok: false, reason: 'unchanged_summary' };
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return { ok: false, reason: 'stale_epoch' };

  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    const current = await loadMemory(memory.id);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.content !== memory.content) return { ok: false, reason: 'memory_changed' };
    const now = Date.now();
    if (!isDehydrationCandidate(current, now)) return { ok: false, reason: 'not_candidate' };
    const currentComments = await loadMemoryComments(memory.id);
    if (memoryDehydrationSource(current, currentComments) !== source) return { ok: false, reason: 'memory_changed' };
    if (hasRecentDehydrationComment(current, currentComments, now)) {
      return { ok: false, reason: 'recent_dehydration_exists' };
    }
    try {
      await createMemoryComment(memory.id, summary, 'chat', {
        author: '白云小姐', kind: 'dehydration', source,
        expectedDehydrationSource: source, touch: false,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'MEMORY_DEHYDRATION_STALE') return { ok: false, reason: 'memory_changed' };
      throw error;
    }
    return { ok: true };
  });
  return committed.committed ? committed.value : { ok: false, reason: 'stale_epoch' };
}

export async function runMemoryDehydrationBatch(
  ai: MemoryDehydrationAi,
  options: { dataEpoch?: number | null; limit?: number } = {},
) {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const snapshot = await runBackupRestoreDataEpochCommit(
    dataEpoch,
    () => findMemoryDehydrationCandidates({ limit: options.limit }),
  );
  if (!snapshot.committed) return { checked: 0, dehydrated: 0, skipped: 0 };
  const candidates = snapshot.value;
  let dehydrated = 0;
  let skipped = 0;

  for (const memory of candidates) {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) break;
    try {
      const result = await dehydrateMemory(memory.id, ai, { dataEpoch });
      if (result.ok) dehydrated += 1;
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  return {
    checked: candidates.length,
    dehydrated,
    skipped,
  };
}
