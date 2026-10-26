import type { AiConnection } from '../ai/types';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import {
  captureBackupRestoreDataEpoch,
  canCommitBackupRestoreDataEpoch,
} from '../backup/backupRestoreCoordinator';
import {
  applyMemoryDeduplication,
  createMemoryEdge,
  createMemoryComment,
  deriveMemoryTitle,
  getMemoryDatabase,
  hasMemoryCommentSource,
  isTimelineEligibleMemory,
  isCurrentMemory,
  loadAllMemoryEdges,
  loadMemories,
  loadMemory,
  loadMemorySourceRefs,
  loadActiveMemoriesCoveringDirectSourceRefs,
  loadTimelineOverrides,
  type EventThread,
  type MemoryEntry,
  type MemoryRelationType,
} from './memoryStore';
import { searchSimilarMemoryIds } from './memoryEmbedding';
import {
  buildMemoryDeduplicationVersion,
  canExecuteMemoryDuplicateDecision,
  canReuseExactMemory,
  eventBoundaryKeepsMemoriesSeparate,
  hasLocalMemorySeparationGate,
  isMemoryDeduplicationProtected,
  isStableMemoryReplacementAllowed,
  type MemoryDuplicateDecision,
} from './memoryDeduplication';
import {
  buildMemoryProcessingDesiredHash,
  loadMemoryProcessingSourceWithDatabase,
  type MemoryProcessingJobType,
} from './memoryProcessingQueue';
import {
  judgeDuplicateMemoryWithAi,
  judgeMemoryContinuationWithAi,
  type ContinuationDecision,
} from './memoryOrganizer';
import { runMemoryOrganizerRequestWithDeadline } from './memoryOrganizerRequestLifecycle';
import { weeklyTargetHash } from './memoryWeeklyBasis';
import { getMemoryOccurrenceStart } from './memoryAtomicity';
import {
  runMemoryDuplicateCleanupBusinessWrite,
  runMemoryDuplicateCleanupDataEpochCommit,
} from './memoryDuplicateCleanupState';

const THREAD_RELATIONS = new Set<MemoryRelationType>(['updates']);
const STABLE_FACT_PATTERN =
  /乳糖不耐|过敏|鼻炎|便秘|不爱吃|不喜欢吃|喜欢吃|饮食偏好|忌口|称呼|昵称|边界|习惯|偏好/;

export type MemoryContinuationAi = {
  apiKey: string;
  connection: AiConnection;
};

function similarityThreshold(memory: MemoryEntry) {
  return memory.importance >= 8 || memory.pinned || memory.anchor ? 0.48 : 0.55;
}

function duplicateSimilarityThreshold(memory: MemoryEntry) {
  return memory.importance >= 8 || memory.pinned || memory.anchor ? 0.72 : 0.78;
}

function memorySearchText(memory: MemoryEntry) {
  return `${memory.title}\n${memory.domain}\n${memory.tags.join(' ')}\n${memory.content}`;
}

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function lexicalSimilarity(left: MemoryEntry, right: MemoryEntry) {
  const leftText = normalizeText(`${left.title}${left.content}${left.tags.join('')}`);
  const rightText = normalizeText(`${right.title}${right.content}${right.tags.join('')}`);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText) return 1;
  const shorter = leftText.length <= rightText.length ? leftText : rightText;
  const longer = leftText.length > rightText.length ? leftText : rightText;
  if (longer.includes(shorter) && shorter.length >= 12) return Math.min(0.94, shorter.length / longer.length + 0.22);

  const grams = (value: string) => {
    const set = new Set<string>();
    for (let index = 0; index < value.length - 1; index += 1) set.add(value.slice(index, index + 2));
    return set;
  };
  const leftGrams = grams(leftText);
  const rightGrams = grams(rightText);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let overlap = 0;
  leftGrams.forEach((gram) => {
    if (rightGrams.has(gram)) overlap += 1;
  });
  return overlap / Math.max(leftGrams.size, rightGrams.size);
}

async function findSimilarCandidates(memory: MemoryEntry, topK: number, threshold: number) {
  const semanticScores = await searchSimilarMemoryIds(memorySearchText(memory), Math.max(8, topK + 3));
  const allMemories = await loadMemories({ includeArchived: false, currentOnly: true });
  return allMemories
    .filter((candidate) => candidate.id !== memory.id && !candidate.understandingSubject && !isBaiyunPostMemory(candidate) && isTimelineEligibleMemory(candidate))
    .map((candidate) => ({ memory: candidate, score: Math.max(semanticScores.get(candidate.id) ?? 0, lexicalSimilarity(memory, candidate)) }))
    .filter((candidate) => candidate.score >= threshold)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

export type MemoryContinuationOptions = {
  dataEpoch?: number | null;
  expectedHash?: string;
  throwOnProviderError?: boolean;
  beforeRemoteRequest?: () => Promise<void>;
};

async function matchesExpectedMemoryHash(
  memoryId: string,
  jobType: MemoryProcessingJobType,
  options: MemoryContinuationOptions,
) {
  const memory = await loadMemory(memoryId);
  if (!memory || memory.understandingSubject || !(await isCurrentMemory(memory))) return false;
  if (!options.expectedHash) return true;
  const database = await getMemoryDatabase();
  const source = await loadMemoryProcessingSourceWithDatabase(database, memoryId);
  return !!source
    && buildMemoryProcessingDesiredHash(source, jobType) === options.expectedHash;
}

function canRunMemoryContinuation(options: MemoryContinuationOptions) {
  return options.dataEpoch === undefined
    || canCommitBackupRestoreDataEpoch(options.dataEpoch);
}

async function runMemoryContinuationCommit<T>(
  options: MemoryContinuationOptions,
  work: () => Promise<T>,
) {
  if (options.dataEpoch === undefined) {
    return {
      committed: true as const,
      value: await runMemoryDuplicateCleanupBusinessWrite(work),
    };
  }
  return runMemoryDuplicateCleanupDataEpochCommit(options.dataEpoch, work);
}

function exactDuplicateDecision(memory: MemoryEntry, target: MemoryEntry): MemoryDuplicateDecision {
  const eventLike = ['event', 'relationship_change'].includes(memory.atomicKind)
    || ['event', 'relationship_change'].includes(target.atomicKind);
  return {
    action: 'merge',
    relationship: eventLike ? 'same_event_restatement' : 'same_stable_memory',
    targetMemoryId: target.id,
    confidence: 1,
    eventBoundary: {
      time: 'same_or_overlapping',
      scene: 'same',
      keyAction: 'same_or_restatement',
      closure: 'same_event_restatement',
    },
    reason: '正文完全一致',
  };
}

async function findExactContentCandidate(memory: MemoryEntry) {
  const refs = await loadMemorySourceRefs(memory.id);
  const coveredIds = new Set((await loadActiveMemoriesCoveringDirectSourceRefs(refs)).map((item) => item.id));
  const memories = await loadMemories({ includeArchived: false, currentOnly: true });
  return memories
    .filter((candidate) => (
      candidate.id !== memory.id
      && !candidate.understandingSubject
      && !isBaiyunPostMemory(candidate)
      && isTimelineEligibleMemory(candidate)
      && canReuseExactMemory(memory, candidate, coveredIds.has(candidate.id))
    ))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0] ?? null;
}

function isSemanticallyExecutableDecision(
  decision: MemoryDuplicateDecision,
  source: MemoryEntry,
  target: MemoryEntry,
) {
  if (
    decision.action === 'create'
    || decision.confidence < 0.9
    || hasLocalMemorySeparationGate(source, target)
    || eventBoundaryKeepsMemoriesSeparate(decision.eventBoundary)
  ) return false;
  if (decision.action === 'merge') {
    return decision.relationship === 'same_stable_memory'
      || decision.relationship === 'same_event_restatement';
  }
  return decision.relationship === 'stable_replacement'
    && isStableMemoryReplacementAllowed(source, target);
}

async function preserveMemoryDeduplicationSuggestion(
  memory: MemoryEntry,
  decision: MemoryDuplicateDecision,
  target: MemoryEntry,
) {
  const commentSource = `dedup-suggestion:${target.id}`;
  if (!(await hasMemoryCommentSource(memory.id, commentSource))) {
    await createMemoryComment(
      memory.id,
      `相似建议：后台发现它可能和「${target.title}」相似；确认、手动、固定、保护、锚点或核心记忆会分别保留，等待小仓鼠决定。${decision.reason ? `\n依据：${decision.reason}` : ''}`,
      'manual',
      {
        author: '记忆系统',
        kind: 'merge',
        source: commentSource,
        touch: false,
      },
    );
  }
  const database = await getMemoryDatabase();
  await database.runAsync(
    `INSERT OR IGNORE INTO memory_edges (
      id, source_id, target_id, relation_type, confidence, reason, created_at
    ) VALUES (?, ?, ?, 'relates_to', ?, ?, ?)`,
    `edge-dedup-suggestion-${memory.id}-${target.id}`,
    memory.id,
    target.id,
    Math.min(Math.max(decision.confidence, 0), 0.92),
    `相似建议：${decision.reason || '分别保留，等待确认'}`,
    Date.now(),
  );
  return {
    handled: false,
    merged: false,
    outcome: 'suggested' as const,
    preserved: true,
    decision,
  };
}
export async function analyzeMemoryAfterSave(
  memoryId: string,
  ai?: MemoryContinuationAi,
  options: MemoryContinuationOptions = {},
) {
  if (!canRunMemoryContinuation(options)) {
    return { duplicate: null, continuation: null };
  }
  const duplicate = await analyzeDuplicateMemory(memoryId, ai, options);
  if (duplicate?.handled || !canRunMemoryContinuation(options)) {
    return { duplicate, continuation: null };
  }
  const continuation = await analyzeMemoryContinuation(memoryId, ai, options);
  return { duplicate, continuation };
}

export async function analyzeDuplicateMemory(
  memoryId: string,
  ai?: MemoryContinuationAi,
  options: MemoryContinuationOptions = {},
) {
  if (!canRunMemoryContinuation(options)) return null;
  const memory = await loadMemory(memoryId);
  if (!memory || memory.understandingSubject || isBaiyunPostMemory(memory) || !isTimelineEligibleMemory(memory) || !(await isCurrentMemory(memory))) return null;
  if (!(await matchesExpectedMemoryHash(memoryId, 'duplicate_analysis', options))) return null;

  const exactTarget = await findExactContentCandidate(memory);
  if (exactTarget) {
    const decision = exactDuplicateDecision(memory, exactTarget);
    const sourceVersion = buildMemoryDeduplicationVersion(memory);
    const targetVersion = buildMemoryDeduplicationVersion(exactTarget);
    const applied = await runMemoryContinuationCommit(options, async () => {
      if (!(await matchesExpectedMemoryHash(memoryId, 'duplicate_analysis', options))) {
        return {
          handled: false,
          merged: false,
          outcome: 'retry_latest' as const,
          decision,
        };
      }
      const currentMemory = await loadMemory(memory.id);
      const currentTarget = await loadMemory(exactTarget.id);
      if (!currentMemory || !currentTarget) {
        return { handled: false, merged: false, outcome: 'retry_latest' as const, decision };
      }
      if (
        buildMemoryDeduplicationVersion(currentMemory) !== sourceVersion
        || buildMemoryDeduplicationVersion(currentTarget) !== targetVersion
      ) {
        return { handled: false, merged: false, outcome: 'retry_latest' as const, decision };
      }
      if (
        isMemoryDeduplicationProtected(currentMemory)
        || isMemoryDeduplicationProtected(currentTarget)
      ) {
        return preserveMemoryDeduplicationSuggestion(currentMemory, decision, currentTarget);
      }
      const result = await applyMemoryDeduplication(currentTarget.id, currentMemory.id, {
        actorLevel: 'automatic',
        expectedSourceVersion: sourceVersion,
        expectedTargetVersion: targetVersion,
        mode: 'merge',
        reason: '正文完全一致',
      });
      return {
        handled: result.outcome === 'merged_archived',
        merged: result.outcome === 'merged_archived',
        outcome: result.outcome,
        decision,
      };
    });
    return applied.committed ? applied.value : null;
  }

  if (!ai?.apiKey.trim() || !ai.connection) return null;
  const candidates = (await findSimilarCandidates(memory, 6, duplicateSimilarityThreshold(memory)))
    .filter(({ memory: candidate }) => !hasLocalMemorySeparationGate(memory, candidate))
    .slice(0, 4);
  if (!candidates.length) return null;
  const candidateVersions = new Map(
    candidates.map(({ memory: candidate }) => [
      candidate.id,
      buildMemoryDeduplicationVersion(candidate),
    ]),
  );
  const sourceVersion = buildMemoryDeduplicationVersion(memory);

  let decision: MemoryDuplicateDecision | null = null;
  try {
    await options.beforeRemoteRequest?.();
    decision = await runMemoryOrganizerRequestWithDeadline((signal) => (
      judgeDuplicateMemoryWithAi({
        apiKey: ai.apiKey,
        connection: ai.connection,
        newMemory: memory,
        candidates,
        signal,
      })
    ));
  } catch (error) {
    if (options.throwOnProviderError) throw error;
    return null;
  }
  if (!canRunMemoryContinuation(options)) return null;
  if (!(await matchesExpectedMemoryHash(memoryId, 'duplicate_analysis', options))) {
    return {
      handled: false,
      merged: false,
      outcome: 'retry_latest' as const,
      decision,
    };
  }
  if (!decision || decision.action === 'create' || !decision.targetMemoryId) {
    return decision
      ? { handled: false, merged: false, outcome: 'kept_separate' as const, decision }
      : null;
  }
  const targetSnapshot = candidates.find(({ memory: candidate }) => candidate.id === decision?.targetMemoryId)?.memory;
  if (!targetSnapshot || !isSemanticallyExecutableDecision(decision, memory, targetSnapshot)) {
    return { handled: false, merged: false, outcome: 'kept_separate' as const, decision };
  }
  const executionMode: 'merge' | 'update' = decision.action === 'update' ? 'update' : 'merge';

  const applied = await runMemoryContinuationCommit(options, async () => {
    if (!(await matchesExpectedMemoryHash(memoryId, 'duplicate_analysis', options))) {
      return { handled: false, merged: false, outcome: 'retry_latest' as const, decision };
    }
    const currentMemory = await loadMemory(memory.id);
    const currentTarget = await loadMemory(targetSnapshot.id);
    if (!currentMemory || !currentTarget) {
      return { handled: false, merged: false, outcome: 'retry_latest' as const, decision };
    }
    if (
      buildMemoryDeduplicationVersion(currentMemory) !== sourceVersion
      || buildMemoryDeduplicationVersion(currentTarget) !== candidateVersions.get(currentTarget.id)
    ) {
      return { handled: false, merged: false, outcome: 'retry_latest' as const, decision };
    }
    if (
      isMemoryDeduplicationProtected(currentMemory)
      || isMemoryDeduplicationProtected(currentTarget)
    ) {
      return preserveMemoryDeduplicationSuggestion(currentMemory, decision, currentTarget);
    }
    if (!canExecuteMemoryDuplicateDecision(decision, currentMemory, currentTarget)) {
      return { handled: false, merged: false, outcome: 'kept_separate' as const, decision };
    }
    const result = await applyMemoryDeduplication(currentTarget.id, currentMemory.id, {
      actorLevel: 'automatic',
      expectedSourceVersion: sourceVersion,
      expectedTargetVersion: candidateVersions.get(currentTarget.id),
      mode: executionMode,
      mergedContent: decision.relationship === 'same_event_restatement' ? decision.mergedContent : undefined,
      reason: `AI 自动去重：${decision.reason || '高置信相似记忆'}`,
    });
    return {
      handled: result.outcome === 'merged_archived' || result.outcome === 'updated_archived',
      merged: result.outcome === 'merged_archived',
      updated: result.outcome === 'updated_archived',
      outcome: result.outcome,
      decision,
    };
  });
  return applied.committed ? applied.value : null;
}
export async function analyzeMemoryContinuation(
  memoryId: string,
  ai?: MemoryContinuationAi,
  options: MemoryContinuationOptions = {},
) {
  if (!canRunMemoryContinuation(options) || !ai?.apiKey.trim() || !ai.connection) return null;
  const dataEpoch = options.dataEpoch ?? captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return null;
  options = { ...options, dataEpoch };
  const memory = await loadMemory(memoryId);
  if (!memory || memory.understandingSubject || isBaiyunPostMemory(memory) || !isTimelineEligibleMemory(memory) || !(await isCurrentMemory(memory))) return null;
  if (!(await matchesExpectedMemoryHash(memoryId, 'continuation_analysis', options))) return null;
  if (!isProgressEventMemory(memory)) return null;

  const candidates = await findSimilarCandidates(memory, 8, similarityThreshold(memory));
  const eventCandidates = candidates.filter(({ memory: candidate }) => isProgressEventMemory(candidate));

  if (!eventCandidates.length) return null;
  const sourceHash = weeklyTargetHash(memory);
  const targetHashes = new Map(eventCandidates.map(({ memory: candidate }) => [candidate.id, weeklyTargetHash(candidate)]));

  let decision: ContinuationDecision | null = null;
  try {
    await options.beforeRemoteRequest?.();
    decision = await runMemoryOrganizerRequestWithDeadline((signal) => (
      judgeMemoryContinuationWithAi({
        apiKey: ai.apiKey,
        connection: ai.connection,
        newMemory: memory,
        candidates: eventCandidates,
        signal,
      })
    ));
  } catch (error) {
    if (options.throwOnProviderError) throw error;
    return null;
  }
  if (!canRunMemoryContinuation(options)) return null;
  if (!(await matchesExpectedMemoryHash(memoryId, 'continuation_analysis', options))) return null;
  if (!decision?.shouldLink || !decision.targetMemoryId || decision.confidence < 0.6) return decision;
  const targetHash = targetHashes.get(decision.targetMemoryId);
  if (!targetHash) return decision;

  const relationType = normalizeContinuationRelation(decision.relationType);
  const linked = await runMemoryContinuationCommit(options, async () => {
    if (!(await matchesExpectedMemoryHash(memoryId, 'continuation_analysis', options))) return decision;
    await createMemoryEdge({
      sourceId: memory.id,
      targetId: decision.targetMemoryId!,
      relationType,
      confidence: decision.confidence,
      reason: decision.reason,
      expectedCurrentMaterials: {
        sourceHash,
        targetHash,
        dataEpoch,
      },
    });
    return decision;
  });
  return linked.committed ? linked.value : null;
}

function isProgressEventMemory(memory: MemoryEntry) {
  if (memory.understandingSubject) return false;
  const stableText = `${memory.title} ${memory.content} ${memory.tags.join(' ')}`;
  const relationalDomain = memory.domain === '喜好' || memory.domain === '称呼' || memory.domain === '边界' || memory.domain === '约定';
  const relationalSemantic = memory.semanticType === 'preference' || memory.semanticType === 'profile' || memory.semanticType === 'entity';
  if (STABLE_FACT_PATTERN.test(stableText) && !relationalDomain) return false;
  return memory.semanticType === 'event'
    || memory.semanticType === 'case'
    || memory.semanticType === 'pattern'
    || relationalSemantic
    || relationalDomain
    || memory.domain === '经历'
    || typeof memory.eventAt === 'number'
    || typeof memory.sourceStartAt === 'number';
}

function normalizeContinuationRelation(value: ContinuationDecision['relationType']): MemoryRelationType {
  if (value === 'updates' || value === 'belongs_to' || value === 'causes' || value === 'triggers' || value === 'supports') {
    return value;
  }
  return 'updates';
}

function unionInto(groups: Map<string, Set<string>>, left: string, right: string) {
  let leftGroup = groups.get(left);
  let rightGroup = groups.get(right);
  if (!leftGroup && !rightGroup) {
    const group = new Set([left, right]);
    groups.set(left, group);
    groups.set(right, group);
    return;
  }
  if (!leftGroup) {
    rightGroup!.add(left);
    groups.set(left, rightGroup!);
    return;
  }
  if (!rightGroup) {
    leftGroup.add(right);
    groups.set(right, leftGroup);
    return;
  }
  if (leftGroup === rightGroup) return;
  for (const id of rightGroup) {
    leftGroup.add(id);
    groups.set(id, leftGroup);
  }
}

export async function buildMemoryThreads(options: { minConfidence?: number } = {}) {
  const [memories, edges, overrides] = await Promise.all([
    loadMemories({ includeArchived: false, currentOnly: true }),
    loadAllMemoryEdges(options.minConfidence ?? 0.72),
    loadTimelineOverrides(),
  ]);
  const memoryById = new Map(memories.filter(memory => isTimelineEligibleMemory(memory)
    && memory.source !== 'weekly-context' && !memory.tags.includes('周脉络'))
    .map((memory) => [memory.id, memory]));
  const overrideById = new Map(overrides.threads.map((thread) => [thread.id, thread]));
  const membersByThread = new Map<string, typeof overrides.members>();
  overrides.members.forEach((member) => {
    membersByThread.set(member.threadId, [...(membersByThread.get(member.threadId) ?? []), member]);
  });
  const manualOwned = new Set(overrides.members.filter(member => member.included && overrideById.get(member.threadId)?.manual)
    .map(member => member.memoryId));
  const hiddenEpisodes = new Set([...memoryById.keys()].filter(id => overrideById.get(`episode-${id}`)?.hidden
    || membersByThread.get(`episode-${id}`)?.some(member => member.memoryId === id && !member.included)));
  const groups = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!THREAD_RELATIONS.has(edge.relationType)) continue;
    if (!memoryById.has(edge.sourceId) || !memoryById.has(edge.targetId)) continue;
    if (!isProgressEventMemory(memoryById.get(edge.sourceId)!) || !isProgressEventMemory(memoryById.get(edge.targetId)!)) continue;
    unionInto(groups, edge.sourceId, edge.targetId);
  }

  const uniqueGroups = Array.from(new Set(groups.values())).filter((group) => group.size >= 2);
  const autoThreads = uniqueGroups
    .map((group): EventThread | null => {
      const baseMemories = Array.from(group)
        .map((id) => memoryById.get(id))
        .filter((memory): memory is MemoryEntry => !!memory)
        .sort((left, right) => left.createdAt - right.createdAt);
      if (baseMemories.length < 2) return null;
      const threadId = `thread-${baseMemories[0].id}`;
      const override = overrideById.get(threadId);
      if (override?.hidden) return null;
      const memberOverrides = membersByThread.get(threadId) ?? [];
      const excludedIds = new Set(memberOverrides.filter((member) => !member.included).map((member) => member.memoryId));
      const includedIds = memberOverrides.filter((member) => member.included).map((member) => member.memoryId);
      const threadMemories = arrangeTimelineMembers(Array.from(new Set([
        ...baseMemories.map((memory) => memory.id),
        ...includedIds,
      ]))
        .filter((id) => !excludedIds.has(id) && !manualOwned.has(id) && !hiddenEpisodes.has(id))
        .map((id) => memoryById.get(id))
        .filter((memory): memory is MemoryEntry => !!memory)
        .sort(compareTimelineEventTime), memberOverrides);
      if (!threadMemories.length) return null;
      const latest = threadMemories[threadMemories.length - 1];
      const titleSource = threadMemories.find((memory) => memory.importance >= 7) ?? threadMemories[0];
      return {
        id: threadId,
        title: override?.title || deriveMemoryTitle(titleSource.title || titleSource.content),
        memoryIds: threadMemories.map((memory) => memory.id),
        ...timelineDates(threadMemories),
        summary: `${threadMemories[0].title} -> ${latest.title}`,
        latestText: latest.content,
        manual: false,
      };
    })
    .filter((thread): thread is EventThread => !!thread);

  const manualThreads = overrides.threads
    .filter((override) => override.manual && !override.hidden)
    .map((override): EventThread | null => {
      const threadMemories = (membersByThread.get(override.id) ?? [])
        .filter((member) => member.included)
        .sort((left, right) => left.position - right.position)
        .map((member) => memoryById.get(member.memoryId))
        .filter((memory): memory is MemoryEntry => !!memory);
      if (!threadMemories.length) return null;
      const latest = threadMemories[threadMemories.length - 1];
      return {
        id: override.id,
        title: override.title || deriveMemoryTitle(threadMemories[0].title),
        memoryIds: threadMemories.map((memory) => memory.id),
        ...timelineDates(threadMemories),
        summary: threadMemories.length === 1
          ? threadMemories[0].title
          : `${threadMemories[0].title} -> ${latest.title}`,
        latestText: latest.content,
        manual: true,
      };
    })
    .filter((thread): thread is EventThread => !!thread);

  // Explicit groups, including hidden/excluded members, retain ownership.
  const explicitOwners = new Map<string, Set<string>>();
  for (const member of overrides.members.filter(member => member.threadId !== `episode-${member.memoryId}`)) {
    const owners = explicitOwners.get(member.memoryId) ?? new Set<string>();
    owners.add(member.threadId); explicitOwners.set(member.memoryId, owners);
  }
  const covered = new Set([...groups.keys(), ...explicitOwners.keys(),
    ...manualThreads.flatMap(thread => thread.memoryIds)]);
  const singleThreads = [...memoryById.values()]
    .filter(memory => !covered.has(memory.id)
      && (memory.source === 'episode-memory' || memory.atomicKind === 'stage_conclusion'))
    .flatMap(memory => {
      const id = `episode-${memory.id}`;
      const override = overrideById.get(id);
      if (override?.hidden) return [];
      const members = membersByThread.get(id) ?? [];
      const excluded = new Set(members.filter(member => !member.included).map(member => member.memoryId));
      const selected = arrangeTimelineMembers([...new Set([memory.id, ...members.filter(member => member.included).map(member => member.memoryId)])]
        .filter(memberId => !excluded.has(memberId) && !manualOwned.has(memberId) && !hiddenEpisodes.has(memberId)
          && (memberId === memory.id || (!groups.has(memberId)
            && ![...(explicitOwners.get(memberId) ?? [])].some(owner => owner !== id)))).map(memberId => memoryById.get(memberId))
        .filter((item): item is MemoryEntry => !!item).sort(compareTimelineEventTime), members);
      if (!selected.length) return [];
      return [{ id, title: override?.title || memory.title, memoryIds: selected.map(item => item.id),
        ...timelineDates(selected), summary: memory.title, latestText: selected.at(-1)!.content, manual: false }];
    });
  return [...autoThreads, ...manualThreads, ...singleThreads]
    .sort((left, right) => right.lastAt - left.lastAt);
}

function arrangeTimelineMembers(memories: MemoryEntry[], overrides: Awaited<ReturnType<typeof loadTimelineOverrides>>['members']) {
  const manual = overrides.filter(member => member.included).sort((left, right) => left.position - right.position || left.memoryId.localeCompare(right.memoryId));
  const byId = new Map(memories.map(memory => [memory.id, memory]));
  const fixedIds = new Set(manual.map(member => member.memoryId));
  const result = memories.filter(memory => !fixedIds.has(memory.id));
  for (const member of manual) {
    const memory = byId.get(member.memoryId);
    if (memory) result.splice(Math.max(0, Math.min(result.length, member.position)), 0, memory);
  }
  return result;
}

export function compareTimelineEventTime(left: MemoryEntry, right: MemoryEntry) {
  const leftAt = getMemoryOccurrenceStart(left.eventTime);
  const rightAt = getMemoryOccurrenceStart(right.eventTime);
  if (leftAt !== undefined && rightAt !== undefined) return leftAt - rightAt || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
  if (leftAt !== undefined) return -1;
  if (rightAt !== undefined) return 1;
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function timelineDates(memories: readonly MemoryEntry[]) {
  const dates = memories.map(memory => getMemoryOccurrenceStart(memory.eventTime)).filter((at): at is number => at !== undefined);
  const savedAt = Math.min(...memories.map(memory => memory.createdAt));
  const updatedAt = Math.max(...memories.map(memory => memory.updatedAt));
  return { firstAt: savedAt, lastAt: updatedAt, savedAt, updatedAt,
    eventStartAt: dates.length ? Math.min(...dates) : undefined,
    eventEndAt: dates.length ? Math.max(...dates) : undefined };
}

export async function loadMemoryThread(threadId: string) {
  const threads = await buildMemoryThreads();
  const thread = threads.find((item) => item.id === threadId);
  if (!thread) return null;
  const [memories, edges] = await Promise.all([
    Promise.all(thread.memoryIds.map((id) => loadMemory(id))),
    loadAllMemoryEdges(0.55),
  ]);
  return {
    thread,
    memories: memories.filter((memory): memory is MemoryEntry => !!memory),
    edges: edges.filter((edge) => thread.memoryIds.includes(edge.sourceId) && thread.memoryIds.includes(edge.targetId)),
  };
}
