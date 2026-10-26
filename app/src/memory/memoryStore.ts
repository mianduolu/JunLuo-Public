import * as SQLite from 'expo-sqlite';
import { createMemoryChatSummaryCorrection, normalizeMemoryChatSummaryCorrection, type MemoryChatSummaryCorrection } from '../chat/chatSummaryCorrection';
import { serializeMemoryDatabaseWrites, withMemoryDatabaseReadContext, type MemoryDatabaseReadContext } from './memoryDatabaseWrites';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { memoryCandidateEditableFields, memoryCandidateEditableHash, type MemoryCandidateReview, type ReadingMemoryReview } from './memoryCandidateReview';
import type { PostMemoryReadOptions } from '../posts/baiyunPostMemorySource';
import { episodeSummaryDraftHash, isEpisodeSummaryReviewCurrent } from './memoryEpisodeSummaryReview';

import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';
import { initializeMemoryDatabase } from './memoryDatabaseSchema';
import { writePostMetadata, type PostMetadata } from '../posts/baiyunPostMetadata';
import { createMemoryMaterialPreparation, currentMemoryComments, isMemoryBeforeUpdateComment, memoryDehydrationSource, type MemoryMaterialPreparation } from './memoryCurrentMaterials';
import { filterCurrentWeeklyMemories, getWeeklyContextStatus, parseWeeklyContextBasis, weeklyBasisMatches, weeklyTargetHash, type WeeklyContextBasis } from './memoryWeeklyBasis';
import { getUnderstandingStatus, isUnderstandingMemory, parseUnderstandingBasis, type UnderstandingBasis, type UnderstandingSubject } from './memoryUnderstanding';
import {
  isRuntimeWorkloadStageEnabled,
  observeRuntimeWorkload,
  runtimeWorkloadDiagnosticsEnabled,
} from '../runtime/runtimeWorkloadDiagnostics';
import {
  observeDatabaseWorkload,
  observeSlowDatabaseWorkload,
  type DatabaseWorkloadStage,
} from '../runtime/databaseWorkloadDiagnostics';

import { loadMemoryRerankerSettings, skipMemoryReranking, rerankMemoryCandidates } from './memoryReranker';
import {
  cjkBigrams,
  countCjkBigramMatches,
  queryTerms,
  rankMemoryEntriesForRecall,
  rankMemoryEntriesForSearch,
  recallQuerySimilarity,
  scoreMemoryForRecall,
  type MemoryRecallSource,
  compareMemoryRecallRanks,
} from './memoryRecallScoring';
import type { MemoryEdgeDiagnostic, MemoryGraphLink } from './memoryGraphMaintenance';
import {
  deriveMemoryExtractionBasis,
  normalizeMemoryAtomicKind,
  normalizeMemoryExtractionBasis,
  normalizeStoredMemoryEventTime,
  type MemoryAtomicKind,
  type MemoryEventTime,
  type MemoryExtractionBasis,
} from './memoryAtomicity';
import {
  buildMemoryDeduplicationVersion,
  canReuseExactMemory,
  isAutomaticMemoryDeduplicationEligible,
  normalizeMemoryExactContent,
  type MemoryDeduplicationOutcome,
} from './memoryDeduplication';
import {
  matchesSavedMemoryCandidateReceipt,
  resolveMemoryIngestionItemsWithDatabase,
  type MemoryIngestionItemRef,
} from './memoryIngestionLedger';
import {
  buildMemoryLifecycleOperationId,
  buildMemoryLifecycleSummary,
  insertMemoryLifecycleEventWithDatabase,
  insertMemoryMergeRecoverySnapshotWithDatabase,
  loadActiveMemoryMergeRecoveryWithDatabase,
  loadMemoryLifecycleEventsWithDatabase,
  type MemoryLifecycleActor,
  type MemoryLifecycleEvent,
  type MemoryLifecycleEventType,
  type MemoryMergeRecoverySnapshot,
} from './memoryLifecycle';
import {
  deleteMemoryProcessingJobsWithDatabase,
  enqueueMemoryCreateJobsWithDatabase,
  enqueueMemoryMergeTargetJobsWithDatabase,
  enqueueMemoryUpdateJobsWithDatabase,
} from './memoryProcessingQueue';
import { notifyMemoryProcessingWorkAvailable } from './memoryProcessingSignals';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import {
  assertTogetherWalkedMemoryLink, resolveTogetherWalkedMemoryLink, togetherWalkedMemorySource,
  type TogetherWalkedMemoryBinding, type TogetherWalkedMemoryLink, type TogetherWalkedMemoryTarget,
} from './togetherWalkedMemory';
export type { TogetherWalkedMemoryLink } from './togetherWalkedMemory';
import {
  limitMemorySourceExcerpts,
  promoteMemoryConfirmation,
  type MemoryConfirmationLevel,
  type MemorySourceRef,
  type MemorySourceRefInput,
  type MemorySourceRelation,
  type MemorySourceTraceMode,
} from './memorySourceRefs';

export type {
  MemoryConfirmationLevel,
  MemorySourceRef,
  MemorySourceRefInput,
  MemorySourceRelation,
  MemorySourceTraceMode,
} from './memorySourceRefs';
export type {
  MemoryAtomicKind,
  MemoryEventTime,
  MemoryEventTimeBasis,
  MemoryEventTimePrecision,
  MemoryExtractionBasis,
} from './memoryAtomicity';
export type { MemoryIngestionItemRef } from './memoryIngestionLedger';
export type {
  MemoryLifecycleActor,
  MemoryLifecycleEvent,
  MemoryLifecycleEventType,
  MemoryMergeRecoverySnapshot,
} from './memoryLifecycle';

export type MemorySourceType = 'manual' | 'message' | 'digest' | 'automatic';
export type MemoryCommentSourceType = 'manual' | 'chat';
export type MemoryCommentKind = 'comment' | 'feel' | 'merge' | 'daily_impression' | 'dehydration' | 'correction' | 'update' | 'confirmation';
export type MemoryDomain = '相处' | '称呼' | '喜好' | '边界' | '经历' | '约定' | '日常' | '其他';
export type MemoryType = 'dynamic' | 'permanent' | 'feel' | 'archived';
export type MemoryTier = 'core' | 'working' | 'peripheral';
export type MemorySemanticType = 'profile' | 'preference' | 'entity' | 'event' | 'case' | 'pattern' | 'other';
export type MemoryAnchorKind = 'name' | 'boundary' | 'relationship_rule' | 'preference' | 'promise' | 'identity' | 'other';
export type MemoryRecallReason = 'pinned' | 'anchor' | 'semantic' | 'text' | 'direct' | 'context' | 'related' | 'random' | 'recent' | 'quiet_context' | 'suggested_mention';
export type MemoryRelationType =
  | 'triggers'
  | 'causes'
  | 'updates'
  | 'contradicts'
  | 'supports'
  | 'promises'
  | 'blocks'
  | 'belongs_to'
  | 'emotional_echo'
  | 'supersedes'
  | 'relates_to';

export const MEMORY_DOMAINS: MemoryDomain[] = ['相处', '称呼', '喜好', '边界', '经历', '约定', '日常', '其他'];
export const MEMORY_ANCHOR_KINDS: MemoryAnchorKind[] = [
  'name',
  'boundary',
  'relationship_rule',
  'preference',
  'promise',
  'identity',
  'other',
];
export const MEMORY_RELATION_TYPES: MemoryRelationType[] = [
  'triggers',
  'causes',
  'updates',
  'contradicts',
  'supports',
  'promises',
  'blocks',
  'belongs_to',
  'emotional_echo',
  'supersedes',
  'relates_to',
];

export type MemoryEntry = {
  chatSummaryCorrection?: MemoryChatSummaryCorrection;
  understandingSubject?: UnderstandingSubject;
  understandingBasis?: UnderstandingBasis;
  weeklyContextBasis?: WeeklyContextBasis;
  id: string;
  title: string;
  content: string;
  domain: MemoryDomain;
  tags: string[];
  recallCues: string[];
  importance: number;
  valence: number;
  arousal: number;
  pinned: boolean;
  anchor: boolean;
  anchorKind?: MemoryAnchorKind;
  type: MemoryType;
  tier: MemoryTier;
  semanticType: MemorySemanticType;
  stability: number;
  resolved: boolean;
  digested: boolean;
  protected: boolean;
  activationCount: number;
  lastActiveAt: number;
  statsSemanticsVersion?: number;
  lastMentionedAt?: number;
  confidence?: number;
  modelValence?: number;
  archivedAt?: number;
  archiveReason?: string;
  atomicKind: MemoryAtomicKind;
  eventAt?: number;
  eventTime?: MemoryEventTime;
  extractionBasis: MemoryExtractionBasis;
  source?: string;
  period?: string;
  date?: string;
  sourceType: MemorySourceType;
  sourceStartAt?: number;
  sourceEndAt?: number;
  confirmationLevel: MemoryConfirmationLevel;
  sourceTraceMode: MemorySourceTraceMode;
  rememberedReason?: string;
  lastSurfacedAt?: number;
  surfaceSuppressedUntil?: number;
  surfaceMutedAt?: number;
  surfaceCount?: number;
  createdAt: number;
  updatedAt: number;
};

export type MemoryDraft = Omit<
  MemoryEntry,
  | 'chatSummaryCorrection'
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'activationCount'
  | 'lastActiveAt'
  | 'tier'
  | 'semanticType'
  | 'stability'
  | 'confirmationLevel'
  | 'sourceTraceMode'
  | 'atomicKind'
  | 'extractionBasis'
> & {
  activationCount?: number;
  atomicKind?: MemoryAtomicKind;
  extractionBasis?: MemoryExtractionBasis;
  lastActiveAt?: number;
  tier?: MemoryTier;
  semanticType?: MemorySemanticType;
  stability?: number;
};

export type MemoryComment = {
  id: string;
  memoryId: string;
  content: string;
  sourceType: MemoryCommentSourceType;
  kind: MemoryCommentKind;
  author: string;
  valence?: number;
  arousal?: number;
  source?: string;
  createdAt: number;
};

export type MemoryEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: MemoryRelationType;
  confidence: number;
  reason: string;
  createdAt: number;
};

export type EventThread = {
  id: string;
  title: string;
  memoryIds: string[];
  firstAt: number;
  lastAt: number;
  eventStartAt?: number;
  eventEndAt?: number;
  savedAt: number;
  updatedAt: number;
  summary: string;
  latestText: string;
  manual?: boolean;
};

export type TimelineThreadOverride = {
  id: string;
  title?: string;
  hidden: boolean;
  manual: boolean;
  createdAt: number;
  updatedAt: number;
};

export type TimelineMemberOverride = {
  threadId: string;
  memoryId: string;
  included: boolean;
  position: number;
};

export type MemoryRecallItem = {
  memory: MemoryEntry;
  reason: MemoryRecallReason;
  latestComment?: MemoryComment;
  commentsChecked?: boolean;
  score?: number;
  baseRankScore?: number;
  relevanceTier?: 'direct' | 'context' | 'semantic' | 'weak';
  modelRanked?: boolean;
  sources?: MemoryRecallSource[];
  recallReasons?: string[];
};

export type MemoryRecallFeedbackKind = 'irrelevant' | 'corrected' | 'outdated' | 'confirmed';

export type MemoryRecallFeedback = {
  id: string;
  memoryId: string;
  query: string;
  kind: MemoryRecallFeedbackKind;
  reason: MemoryRecallReason;
  sources: MemoryRecallSource[];
  score?: number;
  createdAt: number;
};

export type MemoryRecallQualityAdjustments = {
  boosts: Map<string, number>;
  penalties: Map<string, number>;
  tags: Map<string, string[]>;
};

export type MemoryRecallResult = {
  context: string;
  items: MemoryRecallItem[];
  backgroundCandidates?: MemoryRecallItem[];
};

export type MemoryTextCandidateScore = {
  fts: number;
  cjk: number;
  hintFts?: number;
  hintCjk?: number;
};

export type MemoryQuery = {
  currentOnly?: boolean;
  anchorOnly?: boolean;
  archivedOnly?: boolean;
  date?: Date;
  domain?: MemoryDomain;
  includeArchived?: boolean;
  search?: string;
  type?: MemoryType;
  undigestedOnly?: boolean;
};

export type MemoryCreateOptions = {
  confirmedEpisodeSummary?: { content: string; draftHash: string; targetSource?: string };
  togetherWalkedBinding?: TogetherWalkedMemoryBinding;
  readingReview?: ReadingMemoryReview;
  conversationReview?: import('./memoryEpisodeReview').ContinuationReview;
  expectedEditableHash?: string;
  writeIntent?: 'correction' | 'update';
  ingestionExpectedCandidate?: { reviewId: string; editableHash: string };
  beforeUpdateComment?: Pick<MemoryComment, 'content' | 'sourceType' | 'kind' | 'author'> & Pick<Partial<MemoryComment>, 'source'>;
  correctionFeedbackQuery?: string;
  postMetadata?: PostMetadata;
  postExpectedUpdatedAt?: number;
  understandingExpectedTargetHash?: string;
  understandingReviewed?: boolean;
  weeklyExpectedTargetHash?: string;
  continuationAi?: {
    apiKey: string;
    connection: import('../ai/types').AiConnection;
  };
  confirmationLevel?: MemoryConfirmationLevel;
  dataEpoch?: number | null;
  ingestionResolutions?: MemoryIngestionItemRef[];
  requirePendingIngestion?: boolean;
  sourceRefs?: MemorySourceRefInput[];
  sourceTraceMode?: MemorySourceTraceMode;
  lifecycleActor?: MemoryLifecycleActor;
  lifecycleEventType?: Extract<MemoryLifecycleEventType, 'confirmed' | 'corrected' | 'edited' | 'organized' | 'state_changed'>;
  lifecycleOperationId?: string;
  lifecycleReasonCode?: string;
};

export type MemoryArchiveOutcome = 'archived' | 'already_archived' | 'not_found';
export type MemoryRestoreOutcome = 'restored' | 'already_active' | 'not_found';
export type MemoryHardDeleteOutcome = 'deleted' | 'active_memory' | 'not_found';
export type MemoryMergeUndoOutcome =
  | 'restored_both'
  | 'restored_source_preserved_target'
  | 'restored_source_target_missing'
  | 'already_undone'
  | 'not_merge_archive'
  | 'retry_latest';

export type MemoryDeduplicationApplyOptions = {
  actorLevel?: MemoryConfirmationLevel;
  expectedSourceVersion?: string;
  expectedTargetVersion?: string;
  mode: 'merge' | 'update';
  mergedContent?: string;
  reason?: string;
};

export type MemoryDeduplicationApplyResult = {
  outcome: MemoryDeduplicationOutcome;
  sourceId: string;
  targetId: string;
};

type MemoryRow = {
  chat_summary_correction_json?: string | null;
  understanding_subject?: string | null;
  understanding_basis_json?: string | null;
  weekly_context_basis_json?: string | null;
  id: string;
  title: string | null;
  content: string;
  domain: string | null;
  tags_json: string;
  recall_cues_json: string | null;
  importance: number;
  valence: number;
  arousal: number;
  pinned: number;
  anchor: number | null;
  anchor_kind: string | null;
  type: string | null;
  tier: string | null;
  semantic_type: string | null;
  stability: number | null;
  resolved: number | null;
  digested: number | null;
  activation_count: number | null;
  last_active_at: number | null;
  stats_semantics_version?: number | null;
  last_mentioned_at?: number | null;
  confidence: number | null;
  model_valence: number | null;
  protected: number | null;
  archived_at: number | null;
  archive_reason: string | null;
  atomic_kind: string | null;
  event_at: number | null;
  event_start_at: number | null;
  event_end_at: number | null;
  event_time_precision: string | null;
  event_time_basis: string | null;
  event_time_source_message_id: string | null;
  event_time_expression: string | null;
  extraction_basis: string | null;
  source: string | null;
  period: string | null;
  date: string | null;
  source_type: MemorySourceType;
  source_start_at: number | null;
  source_end_at: number | null;
  confirmation_level: string | null;
  source_trace_mode: string | null;
  remembered_reason: string | null;
  last_surfaced_at: number | null;
  surface_suppressed_until: number | null;
  surface_muted_at: number | null;
  surface_count: number | null;
  created_at: number;
  updated_at: number;
};

type SourceRefRow = {
  memory_id: string;
  session_id: string;
  message_id: string;
  role: string;
  message_created_at: number;
  relation: string;
  excerpt: string | null;
  created_at: number;
};

type CommentRow = {
  id: string;
  memory_id: string;
  content: string;
  source_type: MemoryCommentSourceType;
  kind: MemoryCommentKind | null;
  author: string | null;
  valence: number | null;
  arousal: number | null;
  source: string | null;
  created_at: number;
};

type EdgeRow = {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: MemoryRelationType | string;
  confidence: number;
  reason: string | null;
  created_at: number;
};

type RecallFeedbackRow = {
  id: string;
  memory_id: string;
  query: string;
  kind: MemoryRecallFeedbackKind;
  reason: MemoryRecallReason | null;
  sources_json: string | null;
  score: number | null;
  created_at: number;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
let ftsAvailable = false;
let ftsLastError = '';
let lastMaintenanceAt = 0;

export const MEMORY_DATABASE_DIAGNOSTIC_SOURCES = [
  'store',
  'worker',
  'ingestion',
  'sync_capture',
  'continuity',
  'embedding',
  'current_state',
  'style',
  'continuation',
  'topic_profile',
  'voice',
] as const;
export type MemoryDatabaseDiagnosticSource =
  typeof MEMORY_DATABASE_DIAGNOSTIC_SOURCES[number];

const MEMORY_DATABASE_DIAGNOSTIC_STAGES: Record<
  MemoryDatabaseDiagnosticSource,
  DatabaseWorkloadStage
> = {
  store: 'database.memory.store_write',
  worker: 'database.memory.worker_write',
  ingestion: 'database.memory.ingestion_write',
  sync_capture: 'database.memory.sync_capture_write',
  continuity: 'database.memory.continuity_write',
  embedding: 'database.memory.embedding_write',
  current_state: 'database.memory.current_state_write',
  style: 'database.memory.style_write',
  continuation: 'database.memory.continuation_write',
  topic_profile: 'database.memory.topic_profile_write',
  voice: 'database.memory.voice_write',
};
const MEMORY_DATABASE_WRITE_METHODS = new Set<PropertyKey>([
  'execAsync',
  'runAsync',
  'withExclusiveTransactionAsync',
  'withTransactionAsync',
]);
const MEMORY_DATABASE_SLOW_OPERATION_METHODS = new Set<PropertyKey>([
  'execAsync',
  'getAllAsync',
  'getFirstAsync',
  'runAsync',
]);
const MEMORY_DATABASE_SLOW_TRANSACTION_METHODS = new Set<PropertyKey>([
  'withExclusiveTransactionAsync',
  'withTransactionAsync',
]);
const MEMORY_DATABASE_SLOW_STAGES = Object.fromEntries(
  MEMORY_DATABASE_DIAGNOSTIC_SOURCES.map((source) => [source, {
    operation: `database.memory.${source}_operation_slow` as DatabaseWorkloadStage,
    transaction: `database.memory.${source}_transaction_slow` as DatabaseWorkloadStage,
  }]),
) as Record<MemoryDatabaseDiagnosticSource, {
  operation: DatabaseWorkloadStage;
  transaction: DatabaseWorkloadStage;
}>;
const memoryDatabaseDiagnosticViews = new WeakMap<
  SQLite.SQLiteDatabase,
  Map<MemoryDatabaseDiagnosticSource, SQLite.SQLiteDatabase>
>();

function memoryDatabaseDiagnosticView(
  database: SQLite.SQLiteDatabase,
  source: MemoryDatabaseDiagnosticSource,
) {
  if (
    !runtimeWorkloadDiagnosticsEnabled
    || (
      !isRuntimeWorkloadStageEnabled(MEMORY_DATABASE_DIAGNOSTIC_STAGES[source])
      && !isRuntimeWorkloadStageEnabled(MEMORY_DATABASE_SLOW_STAGES[source].operation)
      && !isRuntimeWorkloadStageEnabled(MEMORY_DATABASE_SLOW_STAGES[source].transaction)
    )
  ) return database;
  let views = memoryDatabaseDiagnosticViews.get(database);
  if (!views) {
    views = new Map();
    memoryDatabaseDiagnosticViews.set(database, views);
  }
  const existing = views.get(source);
  if (existing) return existing;
  const methodCache = new Map<PropertyKey, unknown>();
  const view = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const cached = methodCache.get(property);
      if (cached) return cached;
      const writeStageEnabled = MEMORY_DATABASE_WRITE_METHODS.has(property)
        && isRuntimeWorkloadStageEnabled(MEMORY_DATABASE_DIAGNOSTIC_STAGES[source]);
      const slowStage = MEMORY_DATABASE_SLOW_TRANSACTION_METHODS.has(property)
        ? MEMORY_DATABASE_SLOW_STAGES[source].transaction
        : MEMORY_DATABASE_SLOW_OPERATION_METHODS.has(property)
          ? MEMORY_DATABASE_SLOW_STAGES[source].operation
          : null;
      const bound = writeStageEnabled || slowStage
        ? (...args: unknown[]) => {
          const operation = () => value.apply(target, args);
          const observedWrite = () => writeStageEnabled
            ? observeDatabaseWorkload(MEMORY_DATABASE_DIAGNOSTIC_STAGES[source], operation)
            : operation();
          return slowStage && isRuntimeWorkloadStageEnabled(slowStage)
            ? observeSlowDatabaseWorkload(slowStage, observedWrite)
            : observedWrite();
        }
        : value.bind(target);
      methodCache.set(property, bound);
      return bound;
    },
  });
  views.set(source, view);
  return view;
}

export function normalizeMemoryDomain(value: unknown): MemoryDomain {
  return typeof value === 'string' && MEMORY_DOMAINS.includes(value as MemoryDomain)
    ? (value as MemoryDomain)
    : '其他';
}

export function normalizeMemoryAnchorKind(value: unknown): MemoryAnchorKind {
  return typeof value === 'string' && MEMORY_ANCHOR_KINDS.includes(value as MemoryAnchorKind)
    ? (value as MemoryAnchorKind)
    : 'other';
}

export function normalizeMemoryType(value: unknown): MemoryType {
  return value === 'permanent' || value === 'feel' || value === 'archived' ? value : 'dynamic';
}

export function normalizeMemoryConfirmationLevel(value: unknown): MemoryConfirmationLevel {
  return value === 'reviewed' || value === 'manual' ? value : 'automatic';
}

export function normalizeMemorySourceTraceMode(value: unknown): MemorySourceTraceMode {
  return value === 'exact' || value === 'none' ? value : 'legacy_range';
}

export function promoteMemoryConfirmationLevel(
  current: MemoryConfirmationLevel,
  requested: MemoryConfirmationLevel,
) {
  return promoteMemoryConfirmation(current, requested);
}

export function normalizeMemoryTier(value: unknown): MemoryTier {
  return value === 'core' || value === 'peripheral' ? value : 'working';
}

export function normalizeMemorySemanticType(value: unknown): MemorySemanticType {
  return value === 'profile'
    || value === 'preference'
    || value === 'entity'
    || value === 'event'
    || value === 'case'
    || value === 'pattern'
    ? value
    : 'other';
}

function inferSemanticType(domain: MemoryDomain): MemorySemanticType {
  if (domain === '喜好' || domain === '边界' || domain === '称呼') return 'preference';
  if (domain === '经历' || domain === '日常') return 'event';
  if (domain === '约定') return 'pattern';
  if (domain === '相处') return 'profile';
  return 'other';
}

function inferTier(memory: {
  pinned?: boolean;
  protected?: boolean;
  anchor?: boolean;
  importance?: number;
  domain?: MemoryDomain;
}): MemoryTier {
  if (
    memory.pinned
    || memory.protected
    || memory.anchor
    || (memory.importance ?? 0) >= 8
    || memory.domain === '边界'
    || memory.domain === '称呼'
    || memory.domain === '约定'
  ) return 'core';
  return 'working';
}

export function normalizeRelationType(value: unknown): MemoryRelationType {
  return typeof value === 'string' && MEMORY_RELATION_TYPES.includes(value as MemoryRelationType)
    ? (value as MemoryRelationType)
    : 'relates_to';
}

export function normalizeRecallFeedbackKind(value: unknown): MemoryRecallFeedbackKind {
  return value === 'corrected' || value === 'outdated' || value === 'confirmed' ? value : 'irrelevant';
}

export function deriveMemoryTitle(content: string) {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.slice(0, 24) || '未命名记忆';
}

export function isWhisperMemory(memory: Pick<MemoryEntry, 'period' | 'source' | 'tags'>) {
  return (
    memory.period === 'whisper'
    || memory.source === 'assistant-life-state'
    || memory.tags.some((tag) => tag.toLowerCase() === 'whisper' || tag === '碎碎念' || tag === '白云动态')
  );
}

export function isDailyImpressionMemory(memory: Pick<MemoryEntry, 'type' | 'period'>) {
  return memory.type === 'feel' && memory.period === 'daily';
}

export function isTimelineEligibleMemory(memory: MemoryEntry) {
  return !isUnderstandingMemory(memory) && memory.type !== 'archived' && memory.type !== 'feel' && !isWhisperMemory(memory) && !isDailyImpressionMemory(memory);
}

export function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function parseStringArray(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function getMemoryDatabase(
  diagnosticSource: MemoryDatabaseDiagnosticSource = 'store',
) {
  if (!databasePromise) {
    let openedDatabase: SQLite.SQLiteDatabase | undefined;
    const openingDatabasePromise = observeDatabaseWorkload(
      'database.memory.open',
      () => SQLite.openDatabaseAsync('junluo-memory.db', {
        // Every statement owned by this store is finalized explicitly. Avoid
        // expo-sqlite 16.0.x's native close-time statement sweep, which can
        // crash when the database contains FTS tables.
        finalizeUnusedStatementsBeforeClosing: false,
      }).then(async (database) => {
      openedDatabase = database;
      await initializeMemoryDatabase(database, (state) => {
        ftsAvailable = state.available;
        ftsLastError = state.error;
      });
      return serializeMemoryDatabaseWrites(database);
      }),
    );
    const retryableDatabasePromise = openingDatabasePromise.catch(async (error) => {
      if (openedDatabase) {
        await openedDatabase.closeAsync().catch(() => undefined);
      }
      if (databasePromise === retryableDatabasePromise) {
        databasePromise = undefined;
      }
      throw error;
    });
    databasePromise = retryableDatabasePromise;
  }
  const database = await databasePromise;
  return memoryDatabaseDiagnosticView(database, diagnosticSource);
}

export async function exportMemoryDatabase() {
  const database = await getMemoryDatabase();
  return database.serializeAsync();
}

export async function importMemoryDatabase(source: DatabaseImportSource) {
  if (databasePromise) {
    const currentDatabase = await databasePromise;
    await currentDatabase.closeAsync();
    databasePromise = undefined;
  }

  const sourceDatabase = await openDatabaseImportSource(source);
  const destinationDatabase = await SQLite.openDatabaseAsync('junluo-memory.db');
  try {
    await SQLite.backupDatabaseAsync({ sourceDatabase, destDatabase: destinationDatabase });
  } finally {
    await sourceDatabase.closeAsync();
    await destinationDatabase.closeAsync();
  }
  databasePromise = undefined;
  await getMemoryDatabase();
}

export async function closeMemoryDatabaseForMaintenance() {
  if (!databasePromise) return;
  const currentDatabase = await databasePromise;
  await currentDatabase.closeAsync();
  databasePromise = undefined;
}

export async function compactMemoryDatabaseForMaintenance() {
  await closeMemoryDatabaseForMaintenance();
  const database = await SQLite.openDatabaseAsync(
    'junluo-memory.db',
    {
      useNewConnection: true,
      finalizeUnusedStatementsBeforeClosing: false,
    },
  );
  try {
    await database.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
    await database.execAsync('VACUUM;');
    const check = await database.getFirstAsync<{ quick_check?: string }>(
      'PRAGMA quick_check;',
    );
    if (check?.quick_check !== 'ok') {
      throw new Error('记忆数据库 quick_check 未通过。');
    }
  } finally {
    await database.closeAsync();
  }
  databasePromise = undefined;
  await getMemoryDatabase();
}

function readStoredChatSummaryCorrection(value: string | null | undefined) {
  try { return value ? normalizeMemoryChatSummaryCorrection(JSON.parse(value)) ?? undefined : undefined; }
  catch { return undefined; } // The summary reader independently rejects malformed raw metadata; ordinary cards remain readable.
}

export function memoryFromRow(row: MemoryRow): MemoryEntry {
  const pinned = row.pinned === 1;
  const protectedMemory = row.protected === 1;
  const storedType = normalizeMemoryType(row.type);
  const type = storedType === 'archived'
    ? 'archived'
    : pinned || protectedMemory
      ? 'permanent'
      : storedType === 'permanent' ? 'dynamic' : storedType;
  return {
    chatSummaryCorrection: readStoredChatSummaryCorrection(row.chat_summary_correction_json),
    weeklyContextBasis: parseWeeklyContextBasis(row.weekly_context_basis_json),
    understandingSubject: row.understanding_subject === 'I' || row.understanding_subject === 'you' ? row.understanding_subject : undefined,
    understandingBasis: parseUnderstandingBasis(row.understanding_basis_json),
    id: row.id,
    title: row.title?.trim() || deriveMemoryTitle(row.content),
    content: row.content,
    domain: normalizeMemoryDomain(row.domain),
    tags: parseStringArray(row.tags_json),
    recallCues: parseStringArray(row.recall_cues_json),
    importance: pinned || protectedMemory ? 10 : row.importance,
    valence: row.valence,
    arousal: row.arousal,
    pinned,
    anchor: row.anchor === 1,
    anchorKind: row.anchor === 1 ? normalizeMemoryAnchorKind(row.anchor_kind) : undefined,
    type,
    tier: normalizeMemoryTier(row.tier),
    semanticType: normalizeMemorySemanticType(row.semantic_type),
    stability: clampNumber(row.stability, 0, 1, 0.5),
    resolved: row.resolved === 1,
    digested: row.digested === 1,
    protected: protectedMemory,
    activationCount: row.stats_semantics_version === 1 ? Number(row.activation_count ?? 0) : 0,
    lastActiveAt: row.stats_semantics_version === 1 ? row.last_active_at ?? 0 : 0,
    statsSemanticsVersion: Number(row.stats_semantics_version ?? 0),
    lastMentionedAt: row.stats_semantics_version === 1 ? row.last_mentioned_at ?? undefined : undefined,
    confidence: row.confidence ?? undefined,
    modelValence: row.model_valence ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    archiveReason: row.archive_reason ?? undefined,
    atomicKind: normalizeMemoryAtomicKind(row.atomic_kind),
    eventAt: row.event_at ?? undefined,
    eventTime: normalizeStoredMemoryEventTime({
      basis: row.event_time_basis,
      endAt: row.event_end_at,
      precision: row.event_time_precision,
      startAt: row.event_start_at,
      timeExpression: row.event_time_expression,
      timeSourceMessageId: row.event_time_source_message_id,
    }),
    extractionBasis: normalizeMemoryExtractionBasis(row.extraction_basis),
    source: row.source ?? undefined,
    period: row.period ?? undefined,
    date: row.date ?? undefined,
    sourceType: row.source_type,
    sourceStartAt: row.source_start_at ?? undefined,
    sourceEndAt: row.source_end_at ?? undefined,
    confirmationLevel: normalizeMemoryConfirmationLevel(row.confirmation_level),
    sourceTraceMode: normalizeMemorySourceTraceMode(row.source_trace_mode),
    rememberedReason: row.remembered_reason?.trim() || undefined,
    lastSurfacedAt: row.last_surfaced_at ?? undefined,
    surfaceSuppressedUntil: row.surface_suppressed_until ?? undefined,
    surfaceMutedAt: row.surface_muted_at ?? undefined,
    surfaceCount: row.stats_semantics_version === 1 ? Number(row.surface_count ?? 0) : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sourceRefFromRow(row: SourceRefRow): MemorySourceRef {
  return {
    memoryId: row.memory_id,
    sessionId: row.session_id,
    messageId: row.message_id,
    role: row.role === 'I' ? 'I' : 'you',
    messageCreatedAt: row.message_created_at,
    relation: row.relation === 'derived' ? 'derived' : 'direct',
    excerpt: row.excerpt?.trim() || undefined,
    createdAt: row.created_at,
  };
}

export function commentFromRow(row: CommentRow): MemoryComment {
  return {
    id: row.id,
    memoryId: row.memory_id,
    content: row.content,
    sourceType: row.source_type,
    kind: row.kind ?? 'comment',
    author: row.author ?? '白云小姐',
    valence: row.valence ?? undefined,
    arousal: row.arousal ?? undefined,
    source: row.source ?? undefined,
    createdAt: row.created_at,
  };
}

function edgeFromRow(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relationType: normalizeRelationType(row.relation_type),
    confidence: clampNumber(row.confidence, 0, 1, 0.5),
    reason: row.reason ?? '',
    createdAt: row.created_at,
  };
}

function recallFeedbackFromRow(row: RecallFeedbackRow): MemoryRecallFeedback {
  return {
    id: row.id,
    memoryId: row.memory_id,
    query: row.query,
    kind: normalizeRecallFeedbackKind(row.kind),
    reason: row.reason ?? 'text',
    sources: parseStringArray(row.sources_json).filter((source): source is MemoryRecallSource =>
      ['vector', 'fts', 'cjk', 'bridge', 'pinned', 'related', 'reranker'].includes(source),
    ),
    score: row.score ?? undefined,
    createdAt: row.created_at,
  };
}

export async function loadMemories(query: MemoryQuery = {}, readContext?: MemoryDatabaseReadContext) {
  const database = withMemoryDatabaseReadContext(await getMemoryDatabase(), readContext);
  const rows = await database.getAllAsync<MemoryRow>(
    'SELECT * FROM memories ORDER BY pinned DESC, anchor DESC, importance DESC, updated_at DESC',
  );
  const search = query.search?.trim().toLowerCase();
  const dateStart = query.date ? new Date(query.date.getFullYear(), query.date.getMonth(), query.date.getDate()).getTime() : 0;
  const dateEnd = query.date ? new Date(query.date.getFullYear(), query.date.getMonth(), query.date.getDate() + 1).getTime() : 0;
  const memories = rows.map(memoryFromRow).filter((memory) => {
    if (!query.includeArchived && !query.archivedOnly && memory.type === 'archived') return false;
    if (query.archivedOnly && memory.type !== 'archived') return false;
    if (query.type && memory.type !== query.type) return false;
    if (query.undigestedOnly && memory.digested) return false;
    if (query.anchorOnly && !memory.pinned && !memory.anchor) return false;
    if (query.domain && memory.domain !== query.domain) return false;
    if (query.date && (memory.createdAt < dateStart || memory.createdAt >= dateEnd)) return false;
    if (search) {
      const searchable = `${memory.title} ${memory.content} ${memory.domain} ${memory.tags.join(' ')} ${memory.recallCues.join(' ')}`.toLowerCase();
      if (!searchable.includes(search)) return false;
    }
    return true;
  });
  if (!query.currentOnly) return memories;
  const finish = readContext?.reporter?.start('basis_check');
  try { return await filterCurrentMemories(database, memories, { signal: readContext?.signal }); }
  finally { finish?.(); }
}

export async function filterCurrentMemories(database: Pick<SQLite.SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>, memories: readonly MemoryEntry[],
  postOptions: PostMemoryReadOptions = {}) {
  const { inspectPostDerivedTargets } = await import('../posts/baiyunPostMemoryBasis');
  const postStatuses = await inspectPostDerivedTargets(database, memories.map(memory => ({ kind: 'memory' as const, id: memory.id })), postOptions);
  const weekly = await filterCurrentWeeklyMemories(database, memories.filter((_, index) => postStatuses[index].status === 'current'), postOptions);
  const reading = await (await import('../reading/readingMemoryOrganizationSource')).currentReadingOrganizationMemoryIds(database, weekly);
  const statuses = await Promise.all(weekly.map(memory => isCurrentUnderstandingSnapshot(database, memory, postOptions)));
  return weekly.filter((memory, index) => statuses[index] && reading.has(memory.id));
}

async function isCurrentUnderstandingSnapshot(database: Pick<SQLite.SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>, memory: MemoryEntry,
  postOptions: PostMemoryReadOptions = {}) {
  if (!isUnderstandingMemory(memory)) return true;
  if (await getUnderstandingStatus(database, memory, postOptions) !== 'current') return false;
  const row = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', memory.id);
  return !!row && weeklyTargetHash(memoryFromRow(row)) === weeklyTargetHash(memory);
}

export async function isCurrentMemory(memory: MemoryEntry, reader?: Pick<SQLite.SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>,
  postOptions: import('../posts/baiyunPostMemorySource').PostMemoryReadOptions = {}) {
  const database = reader ?? await getMemoryDatabase();
  const row = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', memory.id);
  if (!row) return false;
  const current = memoryFromRow(row);
  return weeklyTargetHash(current) === weeklyTargetHash(memory)
    && await (await import('../reading/readingMemoryOrganizationSource')).isReadingOrganizationMemoryCurrent(database, current.id)
    && (await (await import('../posts/baiyunPostMemoryBasis')).getPostDerivedStatus(database, 'memory', current.id, undefined, postOptions)).status === 'current'
    && await getWeeklyContextStatus(database, current, postOptions) === 'current'
    && await getUnderstandingStatus(database, current, postOptions) === 'current';
}

function escapeFtsTerm(term: string) {
  return `"${term.replace(/"/g, '""')}"`;
}

export async function searchMemoryTextCandidates(
  query: string,
  limit = 30,
  scope: 'active' | 'archived' | 'all' = 'active',
  memoriesSnapshot?: readonly MemoryEntry[],
  materialPreparation?: MemoryMaterialPreparation,
  readContext?: MemoryDatabaseReadContext,
) {
  const database = withMemoryDatabaseReadContext(await getMemoryDatabase(), readContext);
  const candidates = memoriesSnapshot ?? await loadMemories({ includeArchived: true }, readContext);
  const currentIds = new Set((await (materialPreparation?.hasCandidateSnapshot()
    ? materialPreparation.filterCandidateSnapshots(candidates)
    : filterCurrentMemories(database, candidates))).map(memory => memory.id));
  const terms = queryTerms(query);
  const scores = new Map<string, { fts: number; cjk: number }>();
  const typeClause = scope === 'archived'
    ? "memory.type = 'archived'"
    : scope === 'all' ? '1 = 1' : "memory.type != 'archived'";

  if (ftsAvailable && terms.length) {
    try {
      const expression = terms.map(escapeFtsTerm).join(' OR ');
      const rows = await database.getAllAsync<{ memory_id: string; rank: number }>(
        `SELECT memory_fts.memory_id, bm25(memory_fts, 0.0, 5.0, 2.0, 2.5, 2.0, 2.5) AS rank
         FROM memory_fts
         JOIN memories memory ON memory.id = memory_fts.memory_id
         WHERE memory_fts MATCH ? AND ${typeClause}
         ORDER BY rank
         LIMIT ?`,
        expression,
        limit,
      );
      const best = Math.max(1, rows.length);
      rows.forEach((row, index) => {
        scores.set(row.memory_id, { fts: 1 - index / (best + 1), cjk: 0 });
      });
    } catch (error) {
      if (readContext?.signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error;
      ftsAvailable = false;
      ftsLastError = error instanceof Error ? error.message : String(error);
    }
  }

  const queryGrams = cjkBigrams(query);
  if (queryGrams.size) {
    const memories = memoriesSnapshot
      ? memoriesSnapshot.filter((memory) => (
        scope === 'archived' ? memory.type === 'archived' : scope === 'all' || memory.type !== 'archived'
      ))
      : await loadMemories(scope === 'archived'
        ? { archivedOnly: true }
        : scope === 'all' ? { includeArchived: true } : {}, readContext);
    memories.forEach((memory) => {
      const searchable = `${memory.title} ${memory.content} ${memory.domain} ${memory.tags.join(' ')} ${memory.recallCues.join(' ')}`;
      const overlap = countCjkBigramMatches(searchable, queryGrams);
      const cjk = overlap / queryGrams.size;
      if (cjk >= 0.18) {
        const current = scores.get(memory.id) ?? { fts: 0, cjk: 0 };
        scores.set(memory.id, { ...current, cjk });
      }
    });
  }

  return new Map(
    Array.from(scores.entries())
      .filter(([id]) => currentIds.has(id))
      .sort((left, right) => Math.max(right[1].fts, right[1].cjk) - Math.max(left[1].fts, left[1].cjk))
      .slice(0, limit),
  );
}

export async function getMemoryRetrievalDiagnostics() {
  const database = await getMemoryDatabase();
  const { hasCurrentEmbedding, isEmbeddingEligible, loadEmbeddingSettingsSnapshot } = await import('./memoryEmbedding');
  const [settings, memories] = await Promise.all([loadEmbeddingSettingsSnapshot(), loadMemories({ currentOnly: true })]);
  const rows = await database.getAllAsync<{ memory_id: string; model: string; content_hash: string; embedding_json: string }>(
    "SELECT memory_id, model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'memory' AND model = ?", settings.model,
  );
  const indexed = new Map(rows.map(row => [row.memory_id, row]));
  const eligible = memories.filter(isEmbeddingEligible);
  return {
    ftsAvailable,
    ftsError: ftsLastError,
    memoryCount: eligible.length,
    vectorIndexedCount: eligible.filter(memory => hasCurrentEmbedding(memory, indexed.get(memory.id), settings)).length,
    candidatePoolSize: 30,
  };
}

export async function loadMemory(id: string, readContext?: MemoryDatabaseReadContext) {
  const database = withMemoryDatabaseReadContext(await getMemoryDatabase(), readContext);
  const row = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
  return row ? memoryFromRow(row) : null;
}

/** Fresh selected material reads, not a persistent cache or a cross-store transaction. */
export async function loadMemoryMaterialBatch(memoryIds: readonly string[], readContext?: MemoryDatabaseReadContext) {
  const database = withMemoryDatabaseReadContext(await getMemoryDatabase(), readContext);
  const ids = [...new Set(memoryIds)];
  const result = new Map<string, { memory: MemoryEntry; comments: MemoryComment[]; refs: MemorySourceRef[] }>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const group = ids.slice(offset, offset + 100);
    const parameters = group.map(() => '?').join(',');
    const rows = await database.getAllAsync<MemoryRow>(`SELECT * FROM memories WHERE id IN (${parameters})`, ...group);
    const comments = await database.getAllAsync<CommentRow>(
      `SELECT * FROM memory_comments WHERE memory_id IN (${parameters}) ORDER BY created_at DESC`, ...group);
    const refs = await database.getAllAsync<SourceRefRow>(
      `SELECT * FROM memory_source_refs WHERE memory_id IN (${parameters}) ORDER BY message_created_at ASC, message_id ASC`, ...group);
    for (const row of rows) result.set(row.id, { memory: memoryFromRow(row), comments: [], refs: [] });
    for (const row of comments) result.get(row.memory_id)?.comments.push(commentFromRow(row));
    for (const row of refs) result.get(row.memory_id)?.refs.push(sourceRefFromRow(row));
  }
  return result;
}

export async function loadMemoryBySource(source: string) {
  const normalized = source.trim();
  if (!normalized) return null;
  const database = await getMemoryDatabase();
  const row = await database.getFirstAsync<MemoryRow>(
    'SELECT * FROM memories WHERE source = ? ORDER BY created_at ASC LIMIT 1',
    normalized,
  );
  return row ? memoryFromRow(row) : null;
}

export async function loadTogetherWalkedMemoryLinks(
  entries: readonly TogetherWalkedMemoryTarget[],
  reader?: Pick<SQLite.SQLiteDatabase, 'getAllAsync'>,
): Promise<Map<string, TogetherWalkedMemoryLink>> {
  const result = new Map<string, TogetherWalkedMemoryLink>();
  if (!entries.length) return result;
  const database = reader ?? await getMemoryDatabase();
  for (let start = 0; start < entries.length; start += 200) {
    const group = entries.slice(start, start + 200);
    const sources = [...new Set(group.map(entry => togetherWalkedMemorySource(entry.id)))];
    const ids = [...new Set(group.flatMap(entry => entry.memoryId ? [entry.memoryId] : []))];
    const rows = await database.getAllAsync<MemoryRow>(
      `SELECT * FROM memories WHERE source IN (${sources.map(() => '?').join(',')})${ids.length ? ` OR id IN (${ids.map(() => '?').join(',')})` : ''}`,
      ...sources, ...ids,
    );
    const records = rows.map(memoryFromRow);
    for (const entry of group) result.set(entry.id, resolveTogetherWalkedMemoryLink(entry, records));
  }
  return result;
}

export async function loadMemorySourceRefs(memoryId: string, reader?: Pick<SQLite.SQLiteDatabase, 'getAllAsync'>) {
  const database = reader ?? await getMemoryDatabase();
  const rows = await database.getAllAsync<SourceRefRow>(
    `SELECT * FROM memory_source_refs
     WHERE memory_id = ?
     ORDER BY message_created_at ASC, message_id ASC`,
    memoryId,
  );
  return rows.map(sourceRefFromRow);
}

export async function loadMemorySourcePage(source: string, activatedAt: number,
  after?: { id: string; createdAt: number }, limit = 30) {
  const database = await getMemoryDatabase();
  const rows = await database.getAllAsync<MemoryRow>(
    `SELECT * FROM memories WHERE source = ? AND created_at > ?
     AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at ASC, id ASC LIMIT ?`,
    source, activatedAt, after?.createdAt ?? activatedAt, after?.createdAt ?? activatedAt,
    after?.id ?? '', Math.max(1, Math.min(100, Math.floor(limit))),
  );
  return rows.map(memoryFromRow);
}

export async function loadActiveMemoriesCoveringDirectSourceRefs(
  sourceRefs: MemorySourceRefInput[], database?: SQLite.SQLiteDatabase,
) {
  // A whole letter can contain separate events and multiple independently reviewed ranges.
  // Its fixed part ID alone is not proof that a candidate is already covered.
  if (sourceRefs.some(ref => ref.relation === 'direct' && ref.sessionId.startsWith('letter:'))) return [];
  const refs = Array.from(new Map(
    sourceRefs
      .filter((ref) => ref.relation === 'direct' && ref.sessionId.trim() && ref.messageId.trim())
      .map((ref) => [`${ref.sessionId}\u0000${ref.messageId}`, ref]),
  ).values()).slice(0, 80);
  if (!refs.length) return [];
  database ??= await getMemoryDatabase();
  const clauses = refs.map(() => '(memory_source_refs.session_id = ? AND memory_source_refs.message_id = ?)').join(' OR ');
  const rows = await database.getAllAsync<MemoryRow>(
    `SELECT memories.*
     FROM memories
     INNER JOIN memory_source_refs ON memory_source_refs.memory_id = memories.id
     WHERE memories.type != 'archived'
       AND memory_source_refs.relation = 'direct'
       AND (${clauses})
     GROUP BY memories.id
     HAVING COUNT(*) = ?`,
    ...refs.flatMap((ref) => [ref.sessionId, ref.messageId]),
    refs.length,
  );
  return rows.map(memoryFromRow);
}

export async function loadDerivedMemorySourceRefs(memoryIds: string[]) {
  const uniqueIds = Array.from(new Set(memoryIds.filter(Boolean))).slice(0, 80);
  if (!uniqueIds.length) return [];
  const database = await getMemoryDatabase();
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = await database.getAllAsync<SourceRefRow>(
    `SELECT * FROM memory_source_refs
     WHERE memory_id IN (${placeholders})
     ORDER BY message_created_at ASC`,
    ...uniqueIds,
  );
  const deduped = new Map<string, MemorySourceRefInput>();
  for (const row of rows) {
    const ref = sourceRefFromRow(row);
    const key = `${ref.sessionId}\u0000${ref.messageId}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        sessionId: ref.sessionId,
        messageId: ref.messageId,
        role: ref.role,
        messageCreatedAt: ref.messageCreatedAt,
        relation: 'derived',
      });
    }
    if (deduped.size >= 80) break;
  }
  return Array.from(deduped.values());
}

export async function replaceMemorySourceRefs(memoryId: string, sourceRefs: MemorySourceRefInput[]) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const memory = await loadMemory(memoryId);
  if (!memory) throw new Error('memory-not-found');
  const confirmationLevel = promoteMemoryConfirmationLevel(memory.confirmationLevel, 'reviewed');
  const refs = normalizeSourceRefs(sourceRefs, normalizeDraft(memory), confirmationLevel);
  if (!refs.length) throw new Error('memory-source-required');
  const range = sourceRange(refs);
  const now = Date.now();
  const operationId = buildMemoryLifecycleOperationId('source-rebound', now);
  await database.withExclusiveTransactionAsync(async (database) => {
    await database.runAsync('DELETE FROM memory_source_refs WHERE memory_id = ?', memoryId);
    await insertSourceRefs(database, memoryId, refs, now);
    await database.runAsync(
      `UPDATE memories
       SET source_start_at = ?, source_end_at = ?, source_trace_mode = 'exact',
           confirmation_level = ?, updated_at = ?
       WHERE id = ?`,
      range.startAt ?? null,
      range.endAt ?? null,
      confirmationLevel,
      now,
      memoryId,
    );
    await insertMemoryLifecycleEventWithDatabase(database, {
      actor: 'manual',
      changedFields: ['confirmationLevel', 'sourceRefs', 'sourceStartAt', 'sourceEndAt', 'sourceTraceMode'],
      eventType: 'source_rebound',
      memoryId,
      operationId,
      previousType: memory.type,
      nextType: memory.type,
      previousResolved: memory.resolved,
      nextResolved: memory.resolved,
    });
    await enqueueMemoryUpdateJobsWithDatabase(database, memoryId, now);
  });
  notifyMemoryProcessingWorkAvailable('memory_changed');
  });
}

export async function setMemoryConfirmationLevel(memoryId: string, requested: MemoryConfirmationLevel) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const memory = await loadMemory(memoryId);
  if (!memory) return;
  const next = promoteMemoryConfirmationLevel(memory.confirmationLevel, requested);
  if (next === memory.confirmationLevel) return;
  const database = await getMemoryDatabase();
  const now = Date.now();
  const operationId = buildMemoryLifecycleOperationId('confirm', now);
  await database.withExclusiveTransactionAsync(async (database) => {
    await database.runAsync(
      'UPDATE memories SET confirmation_level = ?, updated_at = ? WHERE id = ?',
      next,
      now,
      memoryId,
    );
    await insertMemoryLifecycleEventWithDatabase(database, {
      actor: 'manual',
      changedFields: ['confirmationLevel'],
      eventType: 'confirmed',
      memoryId,
      operationId,
      previousType: memory.type,
      nextType: memory.type,
      previousResolved: memory.resolved,
      nextResolved: memory.resolved,
    });
    await enqueueMemoryUpdateJobsWithDatabase(database, memoryId, now);
  });
  notifyMemoryProcessingWorkAvailable('memory_changed');
  });
}

function normalizeDraft(draft: MemoryDraft) {
  const pinned = draft.pinned || draft.protected;
  const anchor = draft.anchor === true;
  const draftType = normalizeMemoryType(draft.type);
  const type = draftType === 'archived'
    ? 'archived'
    : pinned ? 'permanent'
      : draftType === 'permanent' ? 'dynamic' : draftType;
  const domain = normalizeMemoryDomain(draft.domain);
  return {
    ...draft,
    title: draft.title.trim() || deriveMemoryTitle(draft.content),
    content: draft.content.trim(),
    domain,
    tags: draft.tags.filter(Boolean),
    recallCues: draft.recallCues.filter(Boolean),
    importance: pinned ? 10 : Math.round(clampNumber(draft.importance, 1, 10, 5)),
    valence: clampNumber(draft.valence, 0, 1, 0.5),
    arousal: clampNumber(draft.arousal, 0, 1, 0.3),
    anchor,
    anchorKind: anchor ? normalizeMemoryAnchorKind(draft.anchorKind) : undefined,
    type,
    tier: pinned ? 'core' : normalizeMemoryTier(draft.tier ?? inferTier({ ...draft, domain })),
    semanticType: normalizeMemorySemanticType(draft.semanticType ?? inferSemanticType(domain)),
    stability: clampNumber(draft.stability, 0, 1, pinned ? 1 : 0.5),
    resolved: draft.resolved === true,
    digested: draft.digested === true,
    protected: draft.protected === true,
    atomicKind: normalizeMemoryAtomicKind(draft.atomicKind),
    eventTime: normalizeStoredMemoryEventTime(draft.eventTime ?? {
      basis: 'unknown',
      precision: typeof draft.eventAt === 'number' ? 'instant' : 'unknown',
      startAt: draft.eventAt,
    }),
    extractionBasis: normalizeMemoryExtractionBasis(draft.extractionBasis),
    rememberedReason: isUnderstandingMemory(draft) ? draft.rememberedReason?.trim() : draft.rememberedReason?.trim().slice(0, 80) || undefined,
  };
}

function shouldKeepSourceExcerpt(
  draft: ReturnType<typeof normalizeDraft>,
  confirmationLevel: MemoryConfirmationLevel,
) {
  return confirmationLevel !== 'automatic' && (
    draft.pinned
    || draft.protected
    || draft.anchor
    || draft.tier === 'core'
    || draft.importance >= 8
    || draft.domain === '边界'
    || draft.domain === '称呼'
    || draft.domain === '约定'
  );
}

function normalizeSourceRefs(
  refs: MemorySourceRefInput[] | undefined,
  draft: ReturnType<typeof normalizeDraft>,
  confirmationLevel: MemoryConfirmationLevel,
  limit = 80,
) {
  const keepExcerpt = shouldKeepSourceExcerpt(draft, confirmationLevel);
  const deduped = new Map<string, MemorySourceRefInput>();
  for (const ref of refs ?? []) {
    const sessionId = ref.sessionId?.trim();
    const messageId = ref.messageId?.trim();
    if (!sessionId || !messageId || (ref.role !== 'I' && ref.role !== 'you')) continue;
    if (!Number.isFinite(ref.messageCreatedAt)) continue;
    const relation: MemorySourceRelation = ref.relation === 'derived' ? 'derived' : 'direct';
    const key = `${sessionId}\u0000${messageId}\u0000${relation}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        sessionId,
        messageId,
        role: ref.role,
        messageCreatedAt: ref.messageCreatedAt,
        relation,
        excerpt: ref.excerpt,
      });
    }
    if (deduped.size >= limit) break;
  }
  return limitMemorySourceExcerpts(Array.from(deduped.values()), keepExcerpt);
}

function sourceRange(refs: MemorySourceRefInput[]) {
  if (!refs.length) return { startAt: undefined, endAt: undefined };
  const times = refs.map((ref) => ref.messageCreatedAt);
  return { startAt: Math.min(...times), endAt: Math.max(...times) };
}

async function insertSourceRefs(
  database: SQLite.SQLiteDatabase,
  memoryId: string,
  refs: MemorySourceRefInput[],
  createdAt: number,
) {
  for (const ref of refs) {
    await database.runAsync(
      `INSERT OR IGNORE INTO memory_source_refs (
        memory_id, session_id, message_id, role, message_created_at, relation, excerpt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      memoryId,
      ref.sessionId,
      ref.messageId,
      ref.role,
      ref.messageCreatedAt,
      ref.relation,
      ref.excerpt ?? null,
      createdAt,
    );
  }
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectMemoryLifecycleChangedFields(
  existing: MemoryEntry,
  next: ReturnType<typeof normalizeDraft>,
  options: { confirmationLevel: MemoryConfirmationLevel; replacingRefs: boolean },
) {
  const changed: string[] = [];
  const compare = (field: string, left: unknown, right: unknown) => {
    if (!sameJson(left, right)) changed.push(field);
  };
  compare('title', existing.title, next.title);
  compare('content', existing.content, next.content);
  compare('domain', existing.domain, next.domain);
  compare('tags', existing.tags, next.tags);
  compare('recallCues', existing.recallCues, next.recallCues);
  compare('importance', existing.importance, next.importance);
  compare('valence', existing.valence, next.valence);
  compare('arousal', existing.arousal, next.arousal);
  compare('pinned', existing.pinned, next.pinned);
  compare('anchor', existing.anchor, next.anchor);
  compare('anchorKind', existing.anchorKind, next.anchorKind);
  compare('type', existing.type, next.type);
  compare('tier', existing.tier, next.tier);
  compare('semanticType', existing.semanticType, next.semanticType);
  compare('resolved', existing.resolved, next.resolved);
  compare('digested', existing.digested, next.digested);
  compare('protected', existing.protected, next.protected);
  compare('atomicKind', existing.atomicKind, next.atomicKind);
  compare('eventTime', existing.eventTime, next.eventTime);
  compare('extractionBasis', existing.extractionBasis, next.extractionBasis);
  compare('rememberedReason', existing.rememberedReason, next.rememberedReason);
  compare('surfaceMutedAt', existing.surfaceMutedAt, next.surfaceMutedAt);
  if (options.confirmationLevel !== existing.confirmationLevel) changed.push('confirmationLevel');
  if (options.replacingRefs) changed.push('sourceRefs');
  return Array.from(new Set(changed));
}

function inferMemoryLifecycleActor(
  requestedLevel: MemoryConfirmationLevel,
  override?: MemoryLifecycleActor,
): MemoryLifecycleActor {
  if (override) return override;
  return requestedLevel === 'automatic' ? 'automatic' : 'manual';
}

function inferMemoryUpdateLifecycleType(
  changedFields: string[],
  requested?: MemoryCreateOptions['lifecycleEventType'],
): MemoryLifecycleEventType {
  if (requested) return requested;
  if (changedFields.length === 1 && changedFields[0] === 'confirmationLevel') return 'confirmed';
  if (changedFields.includes('sourceRefs')) return 'source_rebound';
  const stateFields = new Set([
    'pinned', 'anchor', 'anchorKind', 'type', 'tier', 'resolved', 'digested',
    'protected', 'rememberedReason', 'surfaceMutedAt',
  ]);
  return changedFields.every((field) => stateFields.has(field)) ? 'state_changed' : 'edited';
}

export async function loadMemoryLifecycleEvents(memoryId: string, limit = 100) {
  const database = await getMemoryDatabase();
  return loadMemoryLifecycleEventsWithDatabase(database, memoryId, limit);
}

export { buildMemoryLifecycleSummary };

async function replaceUnderstandingSupports(database: SQLite.SQLiteDatabase, id: string, basis: UnderstandingBasis, now: number) {
  await database.runAsync("DELETE FROM memory_edges WHERE target_id = ? AND relation_type = 'supports'", id);
  for (const evidence of basis.evidence) {
    if (evidence.kind !== 'memory') continue;
    await database.runAsync(
      `INSERT INTO memory_edges (id, source_id, target_id, relation_type, confidence, reason, created_at) VALUES (?, ?, ?, 'supports', 1, '', ?)`,
      `understanding-${id}-${evidence.memoryId}`, evidence.memoryId, id, now);
  }
}

async function assertCandidateDraftCurrent(database: SQLite.SQLiteDatabase, options: MemoryCreateOptions,
  postOptions: PostMemoryReadOptions = {}) {
  if (!options.ingestionExpectedCandidate) {
    if (options.readingReview) throw new Error('MEMORY_CANDIDATE_CHANGED');
    return;
  }
  if (!options.ingestionResolutions?.length) throw new Error('MEMORY_CANDIDATE_CHANGED');
  let readingBinding: MemoryCandidateReview['readingBinding'];
  const readingBindings: NonNullable<MemoryCandidateReview['readingBindings']> = [];
  const shiyingBindings: NonNullable<MemoryCandidateReview['shiyingBindings']> = [];
  const lifeSelfBindings: NonNullable<MemoryCandidateReview['lifeSelfBindings']> = [];
  for (const ref of options.ingestionResolutions) {
    const row = await database.getFirstAsync<{ candidate_json: string | null; status: string }>(
      'SELECT candidate_json, status FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ?', ref.batchId, ref.itemKey);
    let candidate: MemoryCandidateReview | null = null;
    try { candidate = row?.candidate_json ? JSON.parse(row.candidate_json) : null; } catch { /* Invalid drafts cannot be committed. */ }
    if (row?.status !== 'pending' || candidate?.reviewId !== options.ingestionExpectedCandidate.reviewId
      || memoryCandidateEditableHash(candidate) !== options.ingestionExpectedCandidate.editableHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
    if (options.confirmedEpisodeSummary && (!candidate || !isEpisodeSummaryReviewCurrent(candidate)
      || candidate.episodeSummary?.trim() !== options.confirmedEpisodeSummary.content.trim()
      || candidate.episodeSummaryReview?.draftHash !== options.confirmedEpisodeSummary.draftHash
      || candidate.episodeSummaryReview?.targetSource !== options.confirmedEpisodeSummary.targetSource)) {
      throw new Error('MEMORY_EPISODE_SUMMARY_STALE');
    }
    if (candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('gift-source:'))
      && !(await (await import('../gifts/giftMemorySource')).validateGiftCandidateSources(candidate, { database }))) throw new Error('MEMORY_SOURCE_CHANGED');
    if (!(await (await import('../focus/focusMemorySource')).validateFocusCandidateSources(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
    if ((candidate.lifeSelfBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('life-self-v1:')))
      && !(await (await import('./lifeSelfMemoryIngestion')).validateLifeSelfCandidateSources(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
    lifeSelfBindings.push(...candidate.lifeSelfBindings ?? []);
    if ((candidate.shiyingBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('shiying-source-v1:')))
      && !(await (await import('../shiying/shiyingMemorySource')).validateShiyingMemoryCandidate(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
    if (candidate.shiyingBindings?.length) {
      shiyingBindings.push(...candidate.shiyingBindings);
      if (!!(candidate.shiyingCorrection || candidate.readingCorrection || candidate.postCorrection) !== (options.writeIntent === 'correction')) throw new Error('MEMORY_CANDIDATE_CHANGED');
    }
    if ((candidate.readingBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('reading-auto-v1:')))
      && !(await (await import('../reading/readingMemoryOrganizationSource')).validateReadingOrganizationCandidate(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
    if (candidate.readingBindings?.length) {
      readingBindings.push(...candidate.readingBindings);
      if (!!(candidate.readingCorrection || candidate.shiyingCorrection) !== (options.writeIntent === 'correction')) throw new Error('MEMORY_CANDIDATE_CHANGED');
      const expectedTarget = candidate.readingReview?.targetMemoryId ?? candidate.understandingReview?.targetMemoryId ?? candidate.continuationReview?.targetMemoryId;
      const module = await import('../reading/readingMemoryOrganizationSource');
      for (const binding of candidate.readingBindings) {
        const targets = await module.readingOrganizationTargetIds(database, binding);
        if (targets.some(id => id !== expectedTarget)) throw new Error('MEMORY_EDIT_CONFLICT');
      }
    }
    if ((candidate.observationBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('observation-source:')))
      && !(await (await import('./memoryUnderstanding')).validateObservationCandidateSources(candidate))) throw new Error('MEMORY_SOURCE_CHANGED');
    for (const binding of candidate.letterBindings ?? []) {
      if (!(await (await import('./letterMemoryIngestion')).validateLetterBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
    }
    if ((candidate.origin === 'post' || candidate.postBindings?.length || candidate.sourceRefs?.some(ref => ref.sessionId.startsWith('post-source:')))
      && !(await (await import('../posts/baiyunPostMemorySource')).validatePostCandidateSources(candidate, { ...postOptions, database }))) throw new Error('MEMORY_SOURCE_CHANGED');
    if (candidate.origin === 'voice_call' && !candidate.voiceBindings?.length) throw new Error('MEMORY_SOURCE_CHANGED');
    if (candidate.readingBinding && (!canCommitBackupRestoreDataEpoch(candidate.readingBinding.dataEpoch)
      || !(await (await import('../reading/readingMemorySource')).validateReadingMemoryBinding(candidate.readingBinding)))) {
      throw new Error('MEMORY_SOURCE_CHANGED');
    }
    if (candidate.readingBinding) {
      readingBinding = candidate.readingBinding;
      if (JSON.stringify(candidate.readingReview) !== JSON.stringify(options.readingReview)
        || JSON.stringify(candidate.sourceRefs) !== JSON.stringify(options.sourceRefs)) throw new Error('MEMORY_CANDIDATE_CHANGED');
      const checked = await (await import('./memoryCandidatePersistence')).getMemoryCandidateReviewStatus(database, candidate, postOptions);
      if (checked.status !== 'current') throw new Error(checked.status === 'basis_changed' ? 'MEMORY_SOURCE_CHANGED' : 'MEMORY_EDIT_CONFLICT');
    } else if (options.readingReview) throw new Error('MEMORY_CANDIDATE_CHANGED');
    for (const binding of candidate.voiceBindings ?? []) {
      if (!(await (await import('../voiceCall/voiceCallMemorySource')).validateVoiceCallMaterialBinding(binding, undefined,
        { waitForPendingWrites: false }))) throw new Error('MEMORY_SOURCE_CHANGED');
    }
  }
  return { manual: readingBinding, automatic: readingBindings, shiying: shiyingBindings, lifeSelf: lifeSelfBindings };
}

async function assertReadingCandidateCommit(bindings: Awaited<ReturnType<typeof assertCandidateDraftCurrent>>, dataEpoch: number | null) {
  if (!bindings) return;
  for (const binding of bindings.lifeSelf) {
    if (!(await (await import('../life/lifeSelfMemorySource')).validateLifeSelfBinding(binding))
      || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_SOURCE_CHANGED');
  }
  for (const binding of bindings.shiying) {
    if (!(await (await import('../shiying/shiyingMemorySource')).validateShiyingMemoryBinding(binding))
      || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_SOURCE_CHANGED');
  }
  for (const binding of bindings.automatic) {
    if (!(await (await import('../reading/readingMemoryOrganizationSource')).validateReadingOrganizationBinding(binding))
      || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_SOURCE_CHANGED');
  }
  const binding = bindings.manual;
  if (!binding) return;
  // Reading and memory use separate stores. Check after the last SQLite write,
  // and keep the usual later source checks; this is not a cross-store transaction.
  const valid = await (await import('../reading/readingMemorySource')).validateReadingMemoryBinding(binding);
  if (!valid || !canCommitBackupRestoreDataEpoch(binding.dataEpoch)
    || !canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_SOURCE_CHANGED');
}

async function assertTogetherWalkedCommit(binding: TogetherWalkedMemoryBinding | undefined) {
  if (!binding) return;
  if (!canCommitBackupRestoreDataEpoch(binding.dataEpoch)
    || !(await (await import('./togetherWalkedStore')).isTogetherWalkedMemoryBindingCurrent(binding))) {
    throw new Error('TOGETHER_WALKED_SOURCE_CHANGED');
  }
}

async function assertEpisodeSummaryCommit(database: SQLite.SQLiteDatabase, draft: MemoryDraft,
  options: MemoryCreateOptions, target?: MemoryEntry) {
  const summary = options.confirmedEpisodeSummary;
  if (!summary) return;
  if (!options.ingestionExpectedCandidate || !summary.content.trim() || summary.content.trim().length > 120
    || episodeSummaryDraftHash(draft, summary.content, summary.targetSource) !== summary.draftHash) {
    throw new Error('MEMORY_EPISODE_SUMMARY_STALE');
  }
  const comments = target ? (await database.getAllAsync<CommentRow>('SELECT * FROM memory_comments WHERE memory_id = ?', target.id)).map(commentFromRow) : [];
  if ((target ? memoryDehydrationSource(target, comments) : undefined) !== summary.targetSource) {
    throw new Error('MEMORY_EPISODE_SUMMARY_STALE');
  }
}

async function storeConfirmedEpisodeSummary(database: SQLite.SQLiteDatabase, id: string, options: MemoryCreateOptions, now: number) {
  const summary = options.confirmedEpisodeSummary;
  if (!summary) return;
  const row = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
  if (!row) throw new Error('MEMORY_NOT_FOUND');
  const memory = memoryFromRow(row);
  const comments = (await database.getAllAsync<CommentRow>('SELECT * FROM memory_comments WHERE memory_id = ?', id)).map(commentFromRow);
  const source = memoryDehydrationSource(memory, comments);
  for (const comment of comments) {
    if (comment.kind === 'dehydration' && comment.source?.startsWith('memory-dehydration:v1:')
      && ['I', '白云小姐', '记忆系统'].includes(comment.author)) {
      await database.runAsync('DELETE FROM memory_comments WHERE memory_id = ? AND id = ?', id, comment.id);
    }
  }
  await database.runAsync('INSERT INTO memory_comments (id, memory_id, content, source_type, kind, author, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `comment-${now}-${Math.random().toString(36).slice(2, 10)}`, id, summary.content.trim(), 'digest', 'dehydration', '白云小姐', source, now);
}

async function assertCandidateCommitBoundary(database: SQLite.SQLiteDatabase, options: MemoryCreateOptions, dataEpoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_DATA_CHANGED');
  if (!options.ingestionExpectedCandidate) return;
  for (const ref of options.ingestionResolutions ?? []) {
    const row = await database.getFirstAsync<{ status: string; candidate_json: string | null }>(
      'SELECT status, candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ?', ref.batchId, ref.itemKey);
    let candidate: MemoryCandidateReview | null = null;
    try { candidate = row?.candidate_json ? JSON.parse(row.candidate_json) : null; } catch { /* Reject malformed staging. */ }
    if (row?.status !== 'pending' || candidate?.reviewId !== options.ingestionExpectedCandidate.reviewId
      || memoryCandidateEditableHash(candidate) !== options.ingestionExpectedCandidate.editableHash) throw new Error('MEMORY_CANDIDATE_CHANGED');
  }
}

export function createMemory(draft: MemoryDraft, options: MemoryCreateOptions & { returnRecord: true }): Promise<MemoryEntry>;
export function createMemory(draft: MemoryDraft, options?: MemoryCreateOptions): Promise<string>;
export async function createMemory(draft: MemoryDraft, options: MemoryCreateOptions & { returnRecord?: boolean } = {}): Promise<string | MemoryEntry> {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const now = Date.now();
  const normalized = normalizeDraft(draft);
  if (options.ingestionExpectedCandidate) normalized.rememberedReason = draft.rememberedReason?.trim() || undefined;
  const confirmationLevel = normalizeMemoryConfirmationLevel(options.confirmationLevel);
  const refs = normalizeSourceRefs(options.sourceRefs, normalized, confirmationLevel);
  const range = sourceRange(refs);
  const extractionBasis = deriveMemoryExtractionBasis({
    existing: normalized.extractionBasis,
    origin: normalized.source,
    sourceRefCount: refs.length,
    sourceType: normalized.sourceType,
  });
  const eventTime = normalized.eventTime;
  const sourceTraceMode = refs.length
    ? 'exact'
    : options.sourceTraceMode === 'legacy_range' ? 'legacy_range' : 'none';
  const id = `memory-${now}-${Math.random().toString(36).slice(2, 10)}`;
  let savedRecord: MemoryEntry | undefined;
    const operationId = options.lifecycleOperationId
    ?? buildMemoryLifecycleOperationId('memory-created', now);
  const initialPostOptions: PostMemoryReadOptions = options.sourceRefs?.some(ref => ref.sessionId.startsWith('post-source:'))
    || normalized.understandingBasis?.evidence.some(item => item.kind === 'message' && item.sessionId.startsWith('post-source:'))
    ? { knowledge: await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database) } : {};
  const postOptions = await (await import('../posts/baiyunPostMemoryBasis')).preloadPostDerivedReadOptions(database,
    (normalized.weeklyContextBasis?.materials ?? []).map(material => ({ kind: 'memory', id: material.memoryId })), initialPostOptions);
  let storedId = id;
  await database.withExclusiveTransactionAsync(async (database) => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_DATA_CHANGED');
    if (options.togetherWalkedBinding) {
      const binding = options.togetherWalkedBinding;
      if (binding.dataEpoch !== dataEpoch || normalized.source !== togetherWalkedMemorySource(binding.id)) {
        throw new Error('TOGETHER_WALKED_SOURCE_CHANGED');
      }
      await assertTogetherWalkedCommit(binding);
      const link = (await loadTogetherWalkedMemoryLinks([binding], database)).get(binding.id)!;
      assertTogetherWalkedMemoryLink(link);
      if (link.memory) {
        storedId = link.memory.id;
        if (options.returnRecord) savedRecord = link.memory;
        await assertTogetherWalkedCommit(binding);
        return;
      }
    }
    const ingestionItems: Array<{ status: string; memory_id: string | null; candidate_json: string | null }> = [];
    for (const ref of options.ingestionResolutions ?? []) {
      const item = await database.getFirstAsync<{ status: string; memory_id: string | null; candidate_json: string | null }>(
        `SELECT status, memory_id, candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ?`,
        ref.batchId, ref.itemKey,
      );
      if (!item) throw new Error('memory-ingestion-no-longer-pending');
      ingestionItems.push(item);
    }
    if (options.requirePendingIngestion && !ingestionItems.length) {
      throw new Error('memory-ingestion-no-longer-pending');
    }
    if (ingestionItems.length && ingestionItems.every((item) => (
      item.status === 'saved' && item.memory_id && item.memory_id === ingestionItems[0].memory_id
    ))) {
      if (options.ingestionExpectedCandidate && !ingestionItems.every(item => matchesSavedMemoryCandidateReceipt(item.candidate_json, options.ingestionExpectedCandidate!))) {
        throw new Error('MEMORY_CANDIDATE_CHANGED');
      }
      storedId = ingestionItems[0].memory_id!;
      if (!(await database.getFirstAsync('SELECT 1 FROM memories WHERE id = ?', storedId))) {
        throw new Error('memory-ingestion-no-longer-pending');
      }
      if (options.returnRecord) savedRecord = memoryFromRow((await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', storedId))!);
      return;
    }
    if (ingestionItems.some((item) => item.status !== 'pending')) {
      throw new Error('memory-ingestion-no-longer-pending');
    }
    if (isUnderstandingMemory(normalized) && (!options.understandingReviewed
      || await getUnderstandingStatus(database, normalized, postOptions) !== 'current')) throw new Error('MEMORY_UNDERSTANDING_STALE');
    if (normalized.weeklyContextBasis && !(await weeklyBasisMatches(database, normalized.weeklyContextBasis, postOptions))) {
      throw new Error('MEMORY_WEEKLY_STALE');
    }
    if (normalized.source === 'weekly-context' && options.ingestionExpectedCandidate
      && await database.getFirstAsync("SELECT 1 FROM memories WHERE source = 'weekly-context' AND date = ? LIMIT 1", normalized.date ?? null)) {
      throw new Error('MEMORY_WEEKLY_TARGET_CHANGED');
    }
    const readingBinding = await assertCandidateDraftCurrent(database, options, postOptions);
    await assertEpisodeSummaryCommit(database, normalized as MemoryDraft, options);
    if (options.readingReview) throw new Error('MEMORY_EDIT_CONFLICT');
    if (options.conversationReview && !(await (await import('./memoryEpisodeReview')).isConversationMemoryCandidateCurrent(database,
      { continuationReview: options.conversationReview }, postOptions))) throw new Error('MEMORY_CONTINUATION_STALE');
    const canReuseExact = !options.togetherWalkedBinding && normalized.source !== 'weekly-context' && !isUnderstandingMemory(normalized) && !isBaiyunPostMemory(normalized) && confirmationLevel === 'automatic'
      && normalized.type !== 'archived'
      && !normalized.pinned
      && !normalized.protected
      && !normalized.anchor
      && normalized.tier !== 'core';
    if (canReuseExact) {
      const coveredIds = new Set((await loadActiveMemoriesCoveringDirectSourceRefs(refs, database)).map((item) => item.id));
      const rows = await database.getAllAsync<MemoryRow>(
        `SELECT * FROM memories
         WHERE type != 'archived'
         ORDER BY created_at ASC, id ASC`,
      );
      const canonical = rows
        .map(memoryFromRow)
        .find((candidate) => (
          isAutomaticMemoryDeduplicationEligible(candidate)
          && canReuseExactMemory(normalized, candidate, coveredIds.has(candidate.id))
        ));
      if (canonical) {
        storedId = canonical.id;
        await insertSourceRefs(database, canonical.id, refs, now);
        await database.runAsync(
          `UPDATE memories
           SET source_trace_mode = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM memory_source_refs WHERE memory_id = ?
                 ) THEN 'exact'
                 ELSE source_trace_mode
               END,
               source_start_at = COALESCE(
                 (SELECT MIN(message_created_at) FROM memory_source_refs WHERE memory_id = ?),
                 source_start_at
               ),
               source_end_at = COALESCE(
                 (SELECT MAX(message_created_at) FROM memory_source_refs WHERE memory_id = ?),
                 source_end_at
               ),
               updated_at = ?
           WHERE id = ?`,
          canonical.id,
          canonical.id,
          canonical.id,
          now,
          canonical.id,
        );
        if (options.ingestionResolutions?.length) {
          await resolveMemoryIngestionItemsWithDatabase(
            database,
            options.ingestionResolutions,
            'saved',
            { memoryId: canonical.id, now },
          );
        }
        await enqueueMemoryMergeTargetJobsWithDatabase(database, canonical.id, now);
        if (options.returnRecord) savedRecord = memoryFromRow((await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', canonical.id))!);
        await assertReadingCandidateCommit(readingBinding, dataEpoch);
        return;
      }
    }
    await database.runAsync(
      `INSERT INTO memories (
        id, title, content, domain, tags_json, recall_cues_json, importance, valence, arousal, pinned, anchor, anchor_kind,
        type, tier, semantic_type, stability, resolved, digested, activation_count, last_active_at, confidence, model_valence, protected,
        archived_at, archive_reason, event_at, source, period, date, source_type, source_start_at, source_end_at,
        confirmation_level, source_trace_mode, remembered_reason, surface_muted_at, created_at, updated_at, stats_semantics_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      id,
      normalized.title,
      normalized.content,
      normalized.domain,
      JSON.stringify(normalized.tags),
      JSON.stringify(normalized.recallCues),
      normalized.importance,
      normalized.valence,
      normalized.arousal,
      normalized.pinned ? 1 : 0,
      normalized.anchor ? 1 : 0,
      normalized.anchorKind ?? null,
      normalized.type,
      normalized.tier,
      normalized.semanticType,
      normalized.stability,
      normalized.resolved ? 1 : 0,
      normalized.digested ? 1 : 0,
      0,
      0,
      normalized.confidence ?? null,
      normalized.modelValence ?? null,
      normalized.protected ? 1 : 0,
      normalized.archivedAt ?? null,
      normalized.archiveReason ?? null,
      eventTime?.startAt ?? null,
      normalized.source ?? null,
      normalized.period ?? null,
      normalized.date ?? null,
      normalized.sourceType,
      range.startAt ?? normalized.sourceStartAt ?? null,
      range.endAt ?? normalized.sourceEndAt ?? null,
      confirmationLevel,
      sourceTraceMode,
      normalized.rememberedReason ?? null,
      normalized.surfaceMutedAt ?? null,
      now,
      now,
    );
    await database.runAsync(
      `UPDATE memories
       SET atomic_kind = ?, event_start_at = ?, event_end_at = ?,
           event_time_precision = ?, event_time_basis = ?,
           event_time_source_message_id = ?, event_time_expression = ?, extraction_basis = ?, weekly_context_basis_json = ?, understanding_subject = ?, understanding_basis_json = ?
       WHERE id = ?`,
      normalized.atomicKind,
      eventTime?.startAt ?? null,
      eventTime?.endAt ?? null,
      eventTime?.precision ?? 'unknown',
      eventTime?.basis ?? 'unknown',
      eventTime?.timeSourceMessageId ?? null,
      eventTime?.timeExpression ?? null,
      extractionBasis,
      normalized.weeklyContextBasis ? JSON.stringify(normalized.weeklyContextBasis) : null,
      normalized.understandingSubject ?? null,
      normalized.understandingBasis ? JSON.stringify(normalized.understandingBasis) : null,
      id,
    );
    if (options.postMetadata) await writePostMetadata(database, id, options.postMetadata, true);
    // Publish the joined final body after author/title metadata, including legacy I posts.
    await database.runAsync('UPDATE baiyun_post_metadata SET author = author WHERE post_id = ?', id);
    await insertSourceRefs(database, id, refs, now);
    await storeConfirmedEpisodeSummary(database, id, options, now);
    if (isUnderstandingMemory(normalized)) await replaceUnderstandingSupports(database, id, normalized.understandingBasis!, now);
    await assertCandidateCommitBoundary(database, options, dataEpoch);
    if (options.ingestionResolutions?.length) {
      const weeklyRow = normalized.source === 'weekly-context' ? await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id) : null;
      await resolveMemoryIngestionItemsWithDatabase(
        database,
        options.ingestionResolutions,
        'saved',
        { memoryId: id, now, ...(weeklyRow ? { savedWeeklyVersion: weeklyTargetHash(memoryFromRow(weeklyRow)) } : {}) },
      );
    }
    await enqueueMemoryCreateJobsWithDatabase(database, id, now);
    await insertMemoryLifecycleEventWithDatabase(database, {
      actor: inferMemoryLifecycleActor(confirmationLevel, options.lifecycleActor),
      changedFields: [],
      eventType: 'created',
      memoryId: id,
      operationId,
      reasonCode: confirmationLevel === 'manual'
        ? 'manual_created'
        : confirmationLevel === 'reviewed' ? 'reviewed_created' : 'automatic_created',
      nextType: normalized.type,
      nextResolved: normalized.resolved,
      createdAt: now,
    });
    if (options.returnRecord) savedRecord = memoryFromRow((await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id))!);
    await assertReadingCandidateCommit(readingBinding, dataEpoch);
    await assertTogetherWalkedCommit(options.togetherWalkedBinding);
  });
  if (!options.togetherWalkedBinding || storedId === id) notifyMemoryProcessingWorkAvailable('memory_changed');
  return options.returnRecord ? savedRecord! : storedId;
  });
}

export async function updateMemory(id: string, draft: MemoryDraft, options: MemoryCreateOptions & { correctionExpectedUpdatedAt?: number } = {}) {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const initialPostOptions: PostMemoryReadOptions = options.sourceRefs?.some(ref => ref.sessionId.startsWith('post-source:'))
    || draft.understandingBasis?.evidence.some(item => item.kind === 'message' && item.sessionId.startsWith('post-source:'))
    || options.conversationReview?.evidence.some(item => item.kind === 'message' && item.sessionId.startsWith('post-source:'))
    ? { knowledge: await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database) } : {};
  const postOptions = await (await import('../posts/baiyunPostMemoryBasis')).preloadPostDerivedReadOptions(database,
    (draft.weeklyContextBasis?.materials ?? []).map(material => ({ kind: 'memory', id: material.memoryId })), initialPostOptions);
  let saved: MemoryEntry | undefined;
  await database.withExclusiveTransactionAsync(async (database) => {
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_DATA_CHANGED');
  const existingRow = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
  const existing = existingRow ? memoryFromRow(existingRow) : null;
  if (!existing) {
    if (options.correctionExpectedUpdatedAt !== undefined) throw new Error('MEMORY_CORRECTION_STALE');
    if (options.postExpectedUpdatedAt !== undefined) throw new Error('baiyun-post-stale');
    throw new Error('MEMORY_NOT_FOUND');
  }
  const items = await Promise.all((options.ingestionResolutions ?? []).map(ref => database.getFirstAsync<{ status: string; memory_id: string | null; candidate_json: string | null }>(
    'SELECT status, memory_id, candidate_json FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ?', ref.batchId, ref.itemKey)));
  if (items.length && items.every(item => item?.status === 'saved' && item.memory_id === id)) {
    if (options.ingestionExpectedCandidate && !items.every(item => matchesSavedMemoryCandidateReceipt(item!.candidate_json, options.ingestionExpectedCandidate!))) {
      throw new Error('MEMORY_CANDIDATE_CHANGED');
    }
    saved = existing; return;
  }
  if (options.expectedEditableHash !== undefined) {
    if (existing.type === 'archived') throw new Error('MEMORY_ARCHIVED');
    if (weeklyTargetHash(existing) !== options.expectedEditableHash) throw new Error('MEMORY_EDIT_CONFLICT');
  }
  const readingBinding = await assertCandidateDraftCurrent(database, options, postOptions);
  if (options.readingReview && (options.readingReview.targetMemoryId !== id
    || options.expectedEditableHash !== options.readingReview.targetHash
    || existing.type === 'archived' || weeklyTargetHash(existing) !== options.readingReview.targetHash)) {
    throw new Error('MEMORY_EDIT_CONFLICT');
  }
  if (options.conversationReview) {
    if (options.conversationReview.targetMemoryId !== id || !items.length || items.some(item => item?.status !== 'pending')
      || !(await (await import('./memoryEpisodeReview')).isConversationMemoryCandidateCurrent(database,
        { continuationReview: options.conversationReview }, postOptions))) throw new Error('MEMORY_CONTINUATION_STALE');
  }
  const requestedLevel = normalizeMemoryConfirmationLevel(options.confirmationLevel);
  const confirmationLevel = promoteMemoryConfirmationLevel(existing.confirmationLevel, requestedLevel);
  const editableDraft = options.readingReview ? { ...existing, ...memoryCandidateEditableFields(draft as MemoryCandidateReview) } : draft;
  const normalizedDraft = normalizeDraft({ ...editableDraft, weeklyContextBasis: editableDraft.weeklyContextBasis ?? existing.weeklyContextBasis,
    understandingSubject: existing.understandingSubject,
    understandingBasis: options.understandingReviewed ? draft.understandingBasis : existing.understandingBasis });
  if (options.correctionExpectedUpdatedAt !== undefined || options.writeIntent === 'correction' || options.ingestionExpectedCandidate) {
    // The correction card has already shown this complete value for confirmation.
    normalizedDraft.rememberedReason = draft.rememberedReason?.trim() || undefined;
  }
  const normalized = existing.confirmationLevel !== 'automatic' && requestedLevel === 'automatic'
    ? { ...normalizedDraft, title: existing.title, content: existing.content }
    : normalizedDraft;
  await assertEpisodeSummaryCommit(database, normalized as MemoryDraft, options, existing);
  const replacingRefs = options.sourceRefs !== undefined;
  // Corrections append a real source to existing references; keep both even at the extraction limit.
  const refs = replacingRefs ? normalizeSourceRefs(options.sourceRefs, normalized, confirmationLevel,
    options.correctionExpectedUpdatedAt !== undefined || options.writeIntent === 'correction' || options.conversationReview ? options.sourceRefs!.length : 80) : [];
  const range = sourceRange(refs);
  const sourceTraceMode = replacingRefs
    ? refs.length ? 'exact' : options.sourceTraceMode === 'legacy_range' ? 'legacy_range' : 'none'
    : options.sourceTraceMode ?? existing.sourceTraceMode;
  const sourceStartAt = replacingRefs ? range.startAt : normalized.sourceStartAt;
  const sourceEndAt = replacingRefs ? range.endAt : normalized.sourceEndAt;
  const sourceRefCount = replacingRefs
    ? refs.length
    : (await database.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM memory_source_refs WHERE memory_id = ?',
      id,
    ))?.count ?? 0;
  const eventTime = normalized.eventTime;
  const extractionBasis = deriveMemoryExtractionBasis({
    existing: normalized.extractionBasis,
    origin: normalized.source,
    sourceRefCount,
    sourceType: normalized.sourceType,
  });
  const now = Date.now();
  const postUpdatedAt = options.postMetadata ? Math.max(now, existing.updatedAt + 1) : now;
  const changedFields = collectMemoryLifecycleChangedFields(existing, normalized, {
    confirmationLevel,
    replacingRefs,
  });
  const operationId = options.lifecycleOperationId
    ?? buildMemoryLifecycleOperationId('memory-updated', now);
  const summaryFactFields = new Set(['title', 'content', 'domain', 'tags', 'recallCues', 'rememberedReason', 'eventAt', 'eventTime']);
  const confirmedCorrection = (options.writeIntent === 'correction' || options.correctionExpectedUpdatedAt !== undefined
    || options.lifecycleEventType === 'corrected') && confirmationLevel !== 'automatic'
    && changedFields.some(field => summaryFactFields.has(field));
  const previousSummaryRefs = confirmedCorrection ? await loadMemorySourceRefs(id, database) : [];
  const toSummaryRef = (ref: MemorySourceRefInput) => ({ sessionId: ref.sessionId, messageId: ref.messageId, createdAt: ref.messageCreatedAt });
  const chatSummaryCorrection = confirmedCorrection ? createMemoryChatSummaryCorrection({
    id: operationId, beforeRefs: previousSummaryRefs.map(toSummaryRef),
    afterRefs: (replacingRefs ? refs : previousSummaryRefs).map(toSummaryRef), previous: existing.chatSummaryCorrection,
    unknownSource: !previousSummaryRefs.some(ref => ref.sessionId === 'chat-main-v1'),
  }) : existing.chatSummaryCorrection;
    if (options.postExpectedUpdatedAt !== undefined) {
      const current = await database.getFirstAsync<{ updated_at: number; type: string }>(
        'SELECT updated_at, type FROM memories WHERE id = ?', id);
      if (!current || current.type === 'archived' || current.updated_at !== options.postExpectedUpdatedAt) {
        throw new Error('baiyun-post-stale');
      }
    }
    if (options.understandingReviewed) {
      // Repeated confirmation resolves to the already saved card, without another history entry.
      const row = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
      if (!items.length || items.some(item => item?.status !== 'pending') || !row || row.type === 'archived'
        || weeklyTargetHash(memoryFromRow(row)) !== options.understandingExpectedTargetHash
        || normalized.understandingSubject !== row.understanding_subject
        || await getUnderstandingStatus(database, normalized, postOptions) !== 'current') throw new Error('MEMORY_UNDERSTANDING_STALE');
      if (options.writeIntent !== 'correction') {
      const previousRefs = await database.getAllAsync('SELECT * FROM memory_source_refs WHERE memory_id = ?', id);
      await database.runAsync(
        `INSERT INTO memory_comments (id, memory_id, content, source_type, kind, author, created_at) VALUES (?, ?, ?, 'manual', 'update', '记忆系统', ?)`,
        `comment-${now}-${Math.random().toString(36).slice(2, 10)}`, id,
        `更新前正文：${row.content}\n${JSON.stringify({ ...memoryFromRow(row), sourceRefs: previousRefs })}`, now);
      }
    }
    if (options.conversationReview && options.writeIntent !== 'correction') {
      const previousRefs = await database.getAllAsync('SELECT * FROM memory_source_refs WHERE memory_id = ?', id);
      await database.runAsync(
        `INSERT INTO memory_comments (id, memory_id, content, source_type, kind, author, created_at) VALUES (?, ?, ?, 'manual', 'update', '记忆系统', ?)`,
        `comment-${now}-${Math.random().toString(36).slice(2, 10)}`, id,
        `更新前正文：${existing.content}\n${JSON.stringify({ ...existing, sourceRefs: previousRefs })}`, now);
    }
    if (options.weeklyExpectedTargetHash !== undefined) {
      const row = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
      if (!row || weeklyTargetHash(memoryFromRow(row)) !== options.weeklyExpectedTargetHash
        || row.type === 'archived' || !normalized.weeklyContextBasis
        || !(await weeklyBasisMatches(database, normalized.weeklyContextBasis, postOptions))) throw new Error('MEMORY_WEEKLY_STALE');
      for (const ref of options.ingestionResolutions ?? []) {
        const item = await database.getFirstAsync<{ status: string }>(
          'SELECT status FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ?', ref.batchId, ref.itemKey);
        if (item?.status !== 'pending') throw new Error('MEMORY_WEEKLY_STALE');
      }
      if (options.writeIntent !== 'correction') {
      const previousRefs = await database.getAllAsync('SELECT * FROM memory_source_refs WHERE memory_id = ?', id);
      await database.runAsync(
        `INSERT INTO memory_comments (id, memory_id, content, source_type, kind, author, created_at)
         VALUES (?, ?, ?, 'automatic', 'update', '记忆系统', ?)`,
        `comment-${now}-${Math.random().toString(36).slice(2, 10)}`, id,
        `更新前正文：${existing.content}\n${JSON.stringify({ ...memoryFromRow(row), sourceRefs: previousRefs })}`, now,
      );
      }
    }
    if (options.correctionExpectedUpdatedAt !== undefined) {
      const current = await database.getFirstAsync<{ updated_at: number; type: string }>(
        'SELECT updated_at, type FROM memories WHERE id = ?', id,
      );
      if (!current || current.updated_at !== options.correctionExpectedUpdatedAt || current.type === 'archived') {
        throw new Error('MEMORY_CORRECTION_STALE');
      }
    }
    if (options.beforeUpdateComment && options.writeIntent !== 'correction' && !options.readingReview) {
      const comment = options.beforeUpdateComment;
      await database.runAsync('INSERT INTO memory_comments (id, memory_id, content, source_type, kind, author, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        `comment-${now}-${Math.random().toString(36).slice(2, 10)}`, id, comment.content, comment.sourceType, comment.kind, comment.author, comment.source ?? null, now);
    }
    await database.runAsync(
      `UPDATE memories SET title = ?, content = ?, domain = ?, tags_json = ?, recall_cues_json = ?, importance = ?, valence = ?, arousal = ?,
        pinned = ?, anchor = ?, anchor_kind = ?, type = ?, tier = ?, semantic_type = ?, stability = ?, resolved = ?, digested = ?, confidence = ?, model_valence = ?, protected = ?,
        archived_at = ?, archive_reason = ?, atomic_kind = ?, event_at = ?, event_start_at = ?, event_end_at = ?,
        event_time_precision = ?, event_time_basis = ?, event_time_source_message_id = ?, event_time_expression = ?,
        extraction_basis = ?, source = ?, period = ?, date = ?, source_type = ?, source_start_at = ?,
        source_end_at = ?, confirmation_level = ?, source_trace_mode = ?, remembered_reason = ?, surface_muted_at = ?, weekly_context_basis_json = ?, understanding_subject = ?, understanding_basis_json = ?, chat_summary_correction_json = ?, updated_at = ? WHERE id = ?`,
    normalized.title,
    normalized.content,
    normalized.domain,
    JSON.stringify(normalized.tags),
    JSON.stringify(normalized.recallCues),
    normalized.importance,
    normalized.valence,
    normalized.arousal,
    normalized.pinned ? 1 : 0,
    normalized.anchor ? 1 : 0,
    normalized.anchorKind ?? null,
    normalized.type,
    normalized.tier,
    normalized.semanticType,
    normalized.stability,
    normalized.resolved ? 1 : 0,
    normalized.digested ? 1 : 0,
    normalized.confidence ?? null,
    normalized.modelValence ?? null,
    normalized.protected ? 1 : 0,
    normalized.archivedAt ?? null,
    normalized.archiveReason ?? null,
    normalized.atomicKind,
    eventTime?.startAt ?? null,
    eventTime?.startAt ?? null,
    eventTime?.endAt ?? null,
    eventTime?.precision ?? 'unknown',
    eventTime?.basis ?? 'unknown',
    eventTime?.timeSourceMessageId ?? null,
    eventTime?.timeExpression ?? null,
    extractionBasis,
    normalized.source ?? null,
    normalized.period ?? null,
    normalized.date ?? null,
    normalized.sourceType,
    sourceStartAt ?? null,
    sourceEndAt ?? null,
    confirmationLevel,
    sourceTraceMode,
    normalized.rememberedReason ?? null,
    normalized.surfaceMutedAt ?? null,
    normalized.weeklyContextBasis ? JSON.stringify(normalized.weeklyContextBasis) : null,
    normalized.understandingSubject ?? null,
    normalized.understandingBasis ? JSON.stringify(normalized.understandingBasis) : null,
    chatSummaryCorrection ? JSON.stringify(chatSummaryCorrection) : null,
    postUpdatedAt,
    id,
    );
    if (options.postMetadata) await writePostMetadata(database, id, options.postMetadata);
    await database.runAsync('UPDATE baiyun_post_metadata SET author = author WHERE post_id = ?', id);
    if (replacingRefs) {
      await database.runAsync('DELETE FROM memory_source_refs WHERE memory_id = ?', id);
      await insertSourceRefs(database, id, refs, now);
    }
    if (options.readingReview || options.writeIntent === 'correction' && (readingBinding?.automatic.length || readingBinding?.shiying.length)) {
      const current = memoryFromRow((await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id))!);
      const comments = (await database.getAllAsync<CommentRow>('SELECT * FROM memory_comments WHERE memory_id = ?', id)).map(commentFromRow);
      const source = memoryDehydrationSource(current, comments);
      for (const comment of comments) {
        if (isMemoryBeforeUpdateComment(comment) || comment.kind === 'dehydration' && comment.source !== source) {
          await database.runAsync('DELETE FROM memory_comments WHERE memory_id = ? AND id = ?', id, comment.id);
        }
      }
    }
    if (options.understandingReviewed) await replaceUnderstandingSupports(database, id, normalized.understandingBasis!, now);
    await storeConfirmedEpisodeSummary(database, id, options, now);
    await assertCandidateCommitBoundary(database, options, dataEpoch);
    if (options.ingestionResolutions?.length) {
      const weeklyRow = normalized.source === 'weekly-context' ? await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id) : null;
      await resolveMemoryIngestionItemsWithDatabase(database, options.ingestionResolutions, 'saved', {
        memoryId: id, now, ...(weeklyRow ? { savedWeeklyVersion: weeklyTargetHash(memoryFromRow(weeklyRow)) } : {}),
      });
    }
    if (options.correctionFeedbackQuery !== undefined) {
      await database.runAsync(`INSERT INTO memory_recall_feedback (id, memory_id, query, kind, reason, sources_json, score, created_at)
        VALUES (?, ?, ?, 'corrected', 'direct', '[]', NULL, ?)`,
        `recall-feedback-${now}-${Math.random().toString(36).slice(2, 10)}`, id, options.correctionFeedbackQuery.trim(), now);
    }
    await enqueueMemoryUpdateJobsWithDatabase(database, id, now);
    if (changedFields.length) {
      await insertMemoryLifecycleEventWithDatabase(database, {
        actor: inferMemoryLifecycleActor(requestedLevel, options.lifecycleActor),
        changedFields,
        eventType: options.writeIntent === 'correction' ? 'corrected' : inferMemoryUpdateLifecycleType(changedFields, options.lifecycleEventType),
        memoryId: id,
        operationId,
        reasonCode: options.lifecycleReasonCode,
        previousType: existing.type,
        nextType: normalized.type,
        previousResolved: existing.resolved,
        nextResolved: normalized.resolved,
        createdAt: now,
      });
    }
    saved = memoryFromRow((await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id))!);
    await assertReadingCandidateCommit(readingBinding, dataEpoch);
  });
  notifyMemoryProcessingWorkAvailable('memory_changed');
  return saved!;
  });
}

export async function updateMemoryState(
  id: string,
  patch: Partial<Pick<MemoryEntry, 'resolved' | 'digested' | 'pinned' | 'anchor' | 'anchorKind' | 'protected' | 'type' | 'tier' | 'archivedAt' | 'archiveReason' | 'surfaceMutedAt'>>,
) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  let saved: MemoryEntry | undefined;
  await database.withExclusiveTransactionAsync(async transaction => {
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_DATA_CHANGED');
  const row = await transaction.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
  if (!row) throw new Error('MEMORY_NOT_FOUND');
  const memory = memoryFromRow(row);
  const nextPinned = patch.pinned ?? memory.pinned;
  const nextProtected = patch.protected ?? memory.protected;
  const requestedType = patch.type ?? memory.type;
  const nextType = requestedType === 'archived'
    ? 'archived'
    : nextPinned || nextProtected ? 'permanent' : requestedType;
  const normalized = normalizeDraft({
    ...memory,
    ...patch,
    type: nextType,
  });
  const now = Date.now();
  await transaction.runAsync(`UPDATE memories SET resolved = ?, digested = ?, pinned = ?, anchor = ?, anchor_kind = ?, protected = ?,
    type = ?, tier = ?, archived_at = ?, archive_reason = ?, surface_muted_at = ?, importance = ?, updated_at = ? WHERE id = ?`,
    normalized.resolved ? 1 : 0, normalized.digested ? 1 : 0, normalized.pinned ? 1 : 0, normalized.anchor ? 1 : 0,
    normalized.anchorKind ?? null, normalized.protected ? 1 : 0, normalized.type, normalized.tier,
    normalized.archivedAt ?? null, normalized.archiveReason ?? null, normalized.surfaceMutedAt ?? null, normalized.importance, now, id);
  const changedFields = collectMemoryLifecycleChangedFields(memory, normalized, { confirmationLevel: memory.confirmationLevel, replacingRefs: false });
  if (changedFields.length) await insertMemoryLifecycleEventWithDatabase(transaction, {
    actor: 'manual', eventType: 'state_changed', changedFields, memoryId: id,
    operationId: buildMemoryLifecycleOperationId('memory-state', now), previousType: memory.type, nextType: normalized.type,
    previousResolved: memory.resolved, nextResolved: normalized.resolved, createdAt: now,
  });
  await enqueueMemoryUpdateJobsWithDatabase(transaction, id, now);
  saved = memoryFromRow((await transaction.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id))!);
  });
  notifyMemoryProcessingWorkAvailable('memory_changed');
  return saved!;
  });
}

export async function archiveMemory(
  id: string,
  reason?: string,
  actor: MemoryLifecycleActor = 'manual',
): Promise<MemoryArchiveOutcome> {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const now = Date.now();
  const operationId = buildMemoryLifecycleOperationId('memory-archive', now);
  let outcome: MemoryArchiveOutcome = 'not_found';
  await database.withExclusiveTransactionAsync(async (database) => {
    const row = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
    if (!row) return;
    const memory = memoryFromRow(row);
    if (memory.type === 'archived') {
      outcome = 'already_archived';
      return;
    }
    await database.runAsync(
      `UPDATE memories
       SET type = 'archived', archived_at = ?, archive_reason = ?, resolved = 1, updated_at = ?
       WHERE id = ?`,
      now,
      reason?.trim() || null,
      now,
      id,
    );
    await insertMemoryLifecycleEventWithDatabase(database, {
      actor,
      changedFields: ['archiveReason', 'archivedAt', 'resolved', 'type'],
      eventType: 'archived',
      memoryId: id,
      operationId,
      previousType: memory.type,
      nextType: 'archived',
      previousResolved: memory.resolved,
      nextResolved: true,
      reasonCode: reason?.trim() ? 'explicit_archive' : 'manual_archive',
      createdAt: now,
    });
    await deleteMemoryProcessingJobsWithDatabase(database, id);
    await database.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?", id);
    outcome = 'archived';
  });
  return outcome;
  });
}

export async function restoreMemory(id: string): Promise<MemoryRestoreOutcome> {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const now = Date.now();
  const operationId = buildMemoryLifecycleOperationId('memory-restore', now);
  let outcome: MemoryRestoreOutcome = 'not_found';
  await database.withExclusiveTransactionAsync(async (database) => {
    const row = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
    if (!row) return;
    const memory = memoryFromRow(row);
    if (memory.type !== 'archived') {
      outcome = 'already_active';
      return;
    }
    const archiveEvent = await database.getFirstAsync<{
      previous_resolved: number | null;
      previous_type: string | null;
    }>(
      `SELECT previous_type, previous_resolved
       FROM memory_lifecycle_events
       WHERE memory_id = ? AND event_type = 'archived'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      id,
    );
    const hasRecordedType = archiveEvent?.previous_type === 'dynamic'
      || archiveEvent?.previous_type === 'permanent'
      || archiveEvent?.previous_type === 'feel';
    const restoredType: MemoryType = hasRecordedType
      ? archiveEvent!.previous_type as MemoryType
      : memory.pinned || memory.protected ? 'permanent' : 'dynamic';
    const restoredResolved = archiveEvent?.previous_resolved === null
      || archiveEvent?.previous_resolved === undefined
      ? false
      : archiveEvent.previous_resolved === 1;
    await database.runAsync(
      `UPDATE memories
       SET type = ?, resolved = ?, archived_at = NULL, archive_reason = NULL, updated_at = ?
       WHERE id = ?`,
      restoredType,
      restoredResolved ? 1 : 0,
      now,
      id,
    );
    await insertMemoryLifecycleEventWithDatabase(database, {
      actor: 'manual',
      changedFields: ['archiveReason', 'archivedAt', 'resolved', 'type'],
      eventType: 'restored',
      memoryId: id,
      operationId,
      previousType: 'archived',
      nextType: restoredType,
      previousResolved: memory.resolved,
      nextResolved: restoredResolved,
      reasonCode: hasRecordedType ? 'recorded_archive_state' : 'legacy_type_fallback',
      createdAt: now,
    });
    await enqueueMemoryUpdateJobsWithDatabase(database, id, now);
    outcome = 'restored';
  });
  if ((outcome as MemoryRestoreOutcome) === 'restored') {
    notifyMemoryProcessingWorkAvailable('memory_changed');
  }
  return outcome;
  });
}

export async function updateMemorySurfacingState(
  id: string,
  patch: Partial<Pick<MemoryEntry, 'lastSurfacedAt' | 'surfaceSuppressedUntil'>>,
) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const now = Date.now();
  await database.withExclusiveTransactionAsync(async transaction => {
    const fields: string[] = [];
    const values: Array<number | null> = [];
    if (patch.lastSurfacedAt !== undefined) {
      fields.push('last_surfaced_at = MAX(COALESCE(last_surfaced_at, 0), ?)');
      values.push(patch.lastSurfacedAt);
    }
    if (patch.surfaceSuppressedUntil !== undefined) {
      fields.push('surface_suppressed_until = ?');
      values.push(patch.surfaceSuppressedUntil);
    }
    if (!fields.length) return;
    await transaction.runAsync(`UPDATE memories SET ${fields.join(', ')}, updated_at = MAX(updated_at, ?) WHERE id = ?`, ...values, now, id);
  });
  });
}

export async function updateMemoryReliabilityState(
  id: string,
  patch: Partial<Pick<MemoryEntry, 'confidence' | 'stability'>>,
) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const memory = await loadMemory(id);
  if (!memory) return;
  const database = await getMemoryDatabase();
  await database.runAsync(
    `UPDATE memories
     SET stability = ?,
         confidence = ?,
         updated_at = ?
     WHERE id = ?`,
    patch.stability === undefined ? memory.stability : clampNumber(patch.stability, 0, 1, memory.stability),
    patch.confidence === undefined ? memory.confidence ?? null : clampNumber(patch.confidence, 0, 1, memory.confidence ?? 0.5),
    Date.now(),
    id,
  );
  });
}

export async function hardDeleteMemory(id: string): Promise<MemoryHardDeleteOutcome> {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const database = await getMemoryDatabase();
  const memory = await loadMemory(id);
  if (!memory) return 'not_found';
  if (memory.type !== 'archived') return 'active_memory';
  if (memory.chatSummaryCorrection) {
    await (await import('../chat/chatSummaryCorrectionStore')).pauseChatSummaryForDeletedCorrection(id, memory.chatSummaryCorrection);
  }
  await database.withExclusiveTransactionAsync(async (database) => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('MEMORY_DATA_CHANGED');
    const current = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
    const currentCorrection = current?.chat_summary_correction_json
      ? normalizeMemoryChatSummaryCorrection(JSON.parse(current.chat_summary_correction_json)) : undefined;
    if (JSON.stringify(currentCorrection ?? null) !== JSON.stringify(memory.chatSummaryCorrection ?? null)) {
      throw new Error('MEMORY_EDIT_CONFLICT');
    }
    await database.runAsync(
      `UPDATE memory_current_states
       SET source_type = 'manual', source_memory_id = NULL, source_title = NULL
       WHERE source_memory_id = ?`,
      id,
    );
    await database.runAsync('UPDATE memory_ingestion_items SET memory_id = NULL WHERE memory_id = ?', id);
    await database.runAsync('DELETE FROM memory_timeline_members WHERE memory_id = ?', id);
    await database.runAsync('DELETE FROM memory_recall_feedback WHERE memory_id = ?', id);
    await database.runAsync('DELETE FROM memory_comments WHERE source = ?', id);
    await database.runAsync('DELETE FROM memory_comments WHERE memory_id = ?', id);
    await database.runAsync('DELETE FROM memory_edges WHERE source_id = ? OR target_id = ?', id, id);
    await database.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?", id);
    await database.runAsync('DELETE FROM memory_source_refs WHERE memory_id = ?', id);
    await database.runAsync('DELETE FROM memory_lifecycle_events WHERE memory_id = ? OR related_memory_id = ?', id, id);
    await database.runAsync(
      'DELETE FROM memory_merge_recovery_snapshots WHERE source_memory_id = ? OR target_memory_id = ?',
      id,
      id,
    );
    await database.runAsync(
      `DELETE FROM continuity_event_links
       WHERE relation = 'memory' AND target_kind = 'memory' AND target_id = ?`,
      id,
    );
    await deleteMemoryProcessingJobsWithDatabase(database, id);
    await database.runAsync('DELETE FROM memories WHERE id = ?', id);
  });
  return 'deleted';
  });
}

/** @deprecated UI callers must archive first, then use hardDeleteMemory from the archive detail. */
export const deleteMemory = hardDeleteMemory;

export async function deleteGeneratedMemoriesForSourceRange(startAt: number, endAt: number) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const rows = await database.getAllAsync<{ id: string }>(
    `SELECT id FROM memories
      WHERE pinned = 0
        AND protected = 0
        AND confirmation_level = 'automatic'
        AND source_type IN ('message', 'digest', 'automatic')
        AND source_start_at IS NOT NULL
        AND source_end_at IS NOT NULL
        AND source_start_at <= ?
        AND source_end_at >= ?`,
    endAt,
    startAt,
  );
  const ids = rows.map((row) => row.id);
  if (!ids.length) return 0;
  await database.withExclusiveTransactionAsync(async (database) => {
    for (let index = 0; index < ids.length; index += 80) {
      const chunk = ids.slice(index, index + 80);
      const placeholders = chunk.map(() => '?').join(',');
      await database.runAsync(
        `UPDATE memory_current_states
         SET source_type = 'manual', source_memory_id = NULL, source_title = NULL
         WHERE source_memory_id IN (${placeholders})`,
        ...chunk,
      );
      await database.runAsync(
        `UPDATE memory_ingestion_items SET memory_id = NULL WHERE memory_id IN (${placeholders})`,
        ...chunk,
      );
      await database.runAsync(`DELETE FROM memory_timeline_members WHERE memory_id IN (${placeholders})`, ...chunk);
      await database.runAsync(`DELETE FROM memory_recall_feedback WHERE memory_id IN (${placeholders})`, ...chunk);
      await database.runAsync(`DELETE FROM memory_comments WHERE source IN (${placeholders})`, ...chunk);
      await database.runAsync(`DELETE FROM memory_comments WHERE memory_id IN (${placeholders})`, ...chunk);
      await database.runAsync(
        `DELETE FROM memory_edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
        ...chunk,
        ...chunk,
      );
      await database.runAsync(`DELETE FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id IN (${placeholders})`, ...chunk);
      await database.runAsync(`DELETE FROM memory_source_refs WHERE memory_id IN (${placeholders})`, ...chunk);
      await database.runAsync(`DELETE FROM memory_processing_jobs WHERE target_kind = 'memory' AND memory_id IN (${placeholders})`, ...chunk);
      await database.runAsync(
        `DELETE FROM memory_lifecycle_events
         WHERE memory_id IN (${placeholders}) OR related_memory_id IN (${placeholders})`,
        ...chunk,
        ...chunk,
      );
      await database.runAsync(
        `DELETE FROM memory_merge_recovery_snapshots
         WHERE source_memory_id IN (${placeholders}) OR target_memory_id IN (${placeholders})`,
        ...chunk,
        ...chunk,
      );
      await database.runAsync(`DELETE FROM memories WHERE id IN (${placeholders})`, ...chunk);
    }
  });
  return ids.length;
  });
}

type MemoryMergeTargetBefore = {
  atomicKind?: MemoryAtomicKind;
  confirmationLevel: MemoryConfirmationLevel;
  confidence?: number;
  content?: string;
  domain?: MemoryDomain;
  eventAt?: number;
  eventTime?: MemoryEventTime;
  importance: number;
  recallCues: string[];
  stability: number;
  tags: string[];
  title?: string;
};

function memorySourceRefRecoveryKey(ref: Pick<MemorySourceRef, 'messageId' | 'relation' | 'sessionId'>) {
  return `${ref.sessionId}\u0000${ref.messageId}\u0000${ref.relation}`;
}

function hashLifecycleVersion(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function buildMemoryMergeTargetVersionWithDatabase(
  database: SQLite.SQLiteDatabase,
  memory: MemoryEntry,
) {
  const refRows = await database.getAllAsync<SourceRefRow>(
    `SELECT * FROM memory_source_refs
     WHERE memory_id = ?
     ORDER BY session_id ASC, message_id ASC, relation ASC`,
    memory.id,
  );
  const refs = refRows.map(sourceRefFromRow).map(memorySourceRefRecoveryKey);
  return hashLifecycleVersion(JSON.stringify({
    atomicKind: memory.atomicKind,
    confirmationLevel: memory.confirmationLevel,
    confidence: memory.confidence ?? null,
    content: memory.content,
    domain: memory.domain,
    eventAt: memory.eventAt ?? null,
    eventTime: memory.eventTime ?? null,
    importance: memory.importance,
    recallCues: memory.recallCues,
    refs,
    stability: memory.stability,
    tags: memory.tags,
    title: memory.title,
  }));
}

function parseMergeTargetBefore(value: string | undefined): MemoryMergeTargetBefore | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as MemoryMergeTargetBefore;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseIntroducedSourceRefKeys(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function applyMemoryDeduplication(
  targetId: string,
  sourceId: string,
  options: MemoryDeduplicationApplyOptions,
): Promise<MemoryDeduplicationApplyResult> {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const keptSeparate = (): MemoryDeduplicationApplyResult => ({
    outcome: 'kept_separate',
    sourceId,
    targetId,
  });
  if (targetId === sourceId) return keptSeparate();
  const database = await getMemoryDatabase();
  const actorLevel = normalizeMemoryConfirmationLevel(options.actorLevel);
  const mergedContent = actorLevel === 'automatic' && options.mode === 'merge'
    && typeof options.mergedContent === 'string' ? options.mergedContent.trim() : '';
  const { getPostDerivedStatus, preloadPostDerivedReadOptions } = await import('../posts/baiyunPostMemoryBasis');
  const postOptions = actorLevel === 'automatic'
    ? await preloadPostDerivedReadOptions(database, [{ kind: 'memory', id: targetId }, { kind: 'memory', id: sourceId }]) : {};
  let result = keptSeparate();
  await database.withExclusiveTransactionAsync(async (database) => {
    const targetRow = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', targetId);
    const sourceRow = await database.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', sourceId);
    if (!targetRow || !sourceRow) return;
    const target = memoryFromRow(targetRow);
    const source = memoryFromRow(sourceRow);
    if (isUnderstandingMemory(source) || isUnderstandingMemory(target)) return;
    if (actorLevel === 'automatic' && ((await getPostDerivedStatus(database, 'memory', targetId, undefined, postOptions)).status !== 'current'
      || (await getPostDerivedStatus(database, 'memory', sourceId, undefined, postOptions)).status !== 'current')) return;
    const archivedOutcome: MemoryDeduplicationOutcome = options.mode === 'update'
      ? 'updated_archived'
      : 'merged_archived';
    if (source.type === 'archived') {
      const existingEdge = await database.getFirstAsync<{ id: string }>(
        `SELECT id FROM memory_edges
         WHERE source_id = ? AND target_id = ? AND relation_type = 'supersedes'
         LIMIT 1`,
        targetId,
        sourceId,
      );
      if (existingEdge) result = { outcome: archivedOutcome, sourceId, targetId };
      return;
    }
    if (
      target.type === 'archived'
      || (options.expectedTargetVersion
        && buildMemoryDeduplicationVersion(target) !== options.expectedTargetVersion)
      || (options.expectedSourceVersion
        && buildMemoryDeduplicationVersion(source) !== options.expectedSourceVersion)
    ) {
      result = { outcome: 'retry_latest', sourceId, targetId };
      return;
    }
    if (
      actorLevel === 'automatic'
      && (
        !isAutomaticMemoryDeduplicationEligible(source)
        || !isAutomaticMemoryDeduplicationEligible(target)
        // Differing event bodies can be archived only with their combined body saved below.
        || (options.mode === 'merge'
          && (['event', 'relationship_change'].includes(source.atomicKind)
            || ['event', 'relationship_change'].includes(target.atomicKind))
          && normalizeMemoryExactContent(source.content) !== normalizeMemoryExactContent(target.content)
          && !mergedContent)
      )
    ) return;

    const now = Date.now();
    const operationId = buildMemoryLifecycleOperationId(`memory-${options.mode}`, now);
    const tags = Array.from(new Set([...target.tags, ...source.tags]));
    const recallCues = Array.from(new Set([...target.recallCues, ...source.recallCues]));
    const targetConfirmation = promoteMemoryConfirmationLevel(target.confirmationLevel, actorLevel);
    const targetBefore: MemoryMergeTargetBefore = {
      confirmationLevel: target.confirmationLevel,
      confidence: target.confidence,
      importance: target.importance,
      recallCues: target.recallCues,
      stability: target.stability,
      tags: target.tags,
      ...(mergedContent ? { content: target.content } : {}),
      ...(options.mode === 'update' ? {
        atomicKind: target.atomicKind,
        content: target.content,
        domain: target.domain,
        eventAt: target.eventAt,
        eventTime: target.eventTime,
        title: target.title,
      } : {}),
    };
    const targetRefRowsBefore = await database.getAllAsync<SourceRefRow>(
      'SELECT * FROM memory_source_refs WHERE memory_id = ?',
      targetId,
    );
    const existingTargetRefKeys = new Set(
      targetRefRowsBefore.map(sourceRefFromRow).map(memorySourceRefRecoveryKey),
    );
    const sourceRefRows = await database.getAllAsync<SourceRefRow>(
      'SELECT * FROM memory_source_refs WHERE memory_id = ?',
      sourceId,
    );
    const introducedSourceRefs = sourceRefRows
      .map(sourceRefFromRow)
      .map((ref) => memorySourceRefRecoveryKey({ ...ref, relation: 'derived' }))
      .filter((key) => !existingTargetRefKeys.has(key));
    await database.runAsync(
      `UPDATE memories
       SET tags_json = ?, recall_cues_json = ?, importance = ?, stability = ?,
           confidence = ?, confirmation_level = ?, updated_at = ?
       WHERE id = ?`,
      JSON.stringify(tags),
      JSON.stringify(recallCues),
      Math.max(target.importance, source.importance),
      Math.max(target.stability, source.stability),
      Math.max(target.confidence ?? 0.5, source.confidence ?? 0.5),
      targetConfirmation,
      now,
      targetId,
    );
    if (options.mode === 'update') {
      await database.runAsync(
        `UPDATE memories
         SET title = ?, content = ?, domain = ?, atomic_kind = ?,
             event_at = ?, event_start_at = ?, event_end_at = ?,
             event_time_precision = ?, event_time_basis = ?,
             event_time_source_message_id = ?, event_time_expression = ?,
             updated_at = ?
         WHERE id = ?`,
        source.title,
        source.content,
        source.domain,
        source.atomicKind,
        source.eventTime?.startAt ?? source.eventAt ?? null,
        source.eventTime?.startAt ?? null,
        source.eventTime?.endAt ?? null,
        source.eventTime?.precision ?? 'unknown',
        source.eventTime?.basis ?? 'unknown',
        source.eventTime?.timeSourceMessageId ?? null,
        source.eventTime?.timeExpression ?? null,
        now,
        targetId,
      );
    } else if (mergedContent) {
      await database.runAsync(
        'UPDATE memories SET content = ?, updated_at = ? WHERE id = ?',
        mergedContent,
        now,
        targetId,
      );
    }

    const commentId = `comment-${operationId}`;
    const commentContent = options.mode === 'update'
      ? `更新前正文：${target.content}`
      : `${options.reason ? `${options.reason}\n` : ''}从「${source.title}」归档合并而来；原页保留在归档中。`;
    await database.runAsync(
      `INSERT OR IGNORE INTO memory_comments (
        id, memory_id, content, source_type, kind, author, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      commentId,
      targetId,
      commentContent,
      'manual',
      options.mode === 'update' ? 'update' : 'merge',
      '记忆系统',
      sourceId,
      now,
    );
    await database.runAsync(
      `INSERT OR IGNORE INTO memory_source_refs (
        memory_id, session_id, message_id, role, message_created_at, relation, excerpt, created_at
      )
      SELECT ?, session_id, message_id, role, message_created_at, 'derived', NULL, ?
      FROM memory_source_refs WHERE memory_id = ?`,
      targetId,
      now,
      sourceId,
    );
    await database.runAsync(
      `UPDATE memories
       SET source_trace_mode = CASE
         WHEN EXISTS (SELECT 1 FROM memory_source_refs WHERE memory_id = ?) THEN 'exact'
         ELSE source_trace_mode
       END,
       source_start_at = COALESCE(
         (SELECT MIN(message_created_at) FROM memory_source_refs WHERE memory_id = ?),
         source_start_at
       ),
       source_end_at = COALESCE(
         (SELECT MAX(message_created_at) FROM memory_source_refs WHERE memory_id = ?),
         source_end_at
       )
       WHERE id = ?`,
      targetId,
      targetId,
      targetId,
      targetId,
    );
    await database.runAsync(
      `UPDATE memories
       SET type = 'archived', archived_at = ?, archive_reason = ?,
           resolved = 1, updated_at = ?
       WHERE id = ?`,
      now,
      '被另一条记忆替代',
      now,
      sourceId,
    );
    const edgeId = `edge-supersedes-${targetId}-${sourceId}`;
    await database.runAsync(
      `INSERT OR IGNORE INTO memory_edges (
        id, source_id, target_id, relation_type, confidence, reason, created_at
      ) VALUES (?, ?, ?, 'supersedes', ?, ?, ?)`,
      edgeId,
      targetId,
      sourceId,
      1,
      options.reason?.trim().slice(0, 120) || '记忆归档替代',
      now,
    );
    await database.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?", sourceId);
    await deleteMemoryProcessingJobsWithDatabase(database, sourceId);
    await enqueueMemoryMergeTargetJobsWithDatabase(database, targetId, now);
    const targetAfterRow = await database.getFirstAsync<MemoryRow>(
      'SELECT * FROM memories WHERE id = ?',
      targetId,
    );
    if (!targetAfterRow) {
      result = { outcome: 'retry_latest', sourceId, targetId };
      throw new Error('memory-merge-target-missing-after-update');
    }
    const targetVersionAfter = await buildMemoryMergeTargetVersionWithDatabase(
      database,
      memoryFromRow(targetAfterRow),
    );
    await insertMemoryMergeRecoverySnapshotWithDatabase(database, {
      operationId,
      sourceMemoryId: sourceId,
      targetMemoryId: targetId,
      mode: options.mode,
      targetBeforeJson: JSON.stringify(targetBefore),
      targetVersionAfter,
      introducedSourceRefsJson: JSON.stringify(introducedSourceRefs),
      sourcePreviousType: source.type,
      sourcePreviousResolved: source.resolved,
      legacy: false,
      createdAt: now,
    });
    await insertMemoryLifecycleEventWithDatabase(database, {
      actor: actorLevel === 'automatic' ? 'automatic' : 'manual',
      changedFields: ['archiveReason', 'archivedAt', 'resolved', 'type'],
      commentId,
      eventType: 'merged_into',
      memoryId: sourceId,
      operationId,
      relatedMemoryId: targetId,
      reasonCode: options.mode,
      previousType: source.type,
      nextType: 'archived',
      previousResolved: source.resolved,
      nextResolved: true,
      createdAt: now,
    });
    await insertMemoryLifecycleEventWithDatabase(database, {
      actor: actorLevel === 'automatic' ? 'automatic' : 'manual',
      changedFields: options.mode === 'update'
        ? ['atomicKind', 'confirmationLevel', 'content', 'domain', 'eventTime', 'importance', 'recallCues', 'stability', 'tags', 'title']
        : [...(mergedContent ? ['content'] : []), 'confirmationLevel', 'importance', 'recallCues', 'stability', 'tags'],
      commentId,
      eventType: 'absorbed_merge',
      memoryId: targetId,
      operationId,
      relatedMemoryId: sourceId,
      reasonCode: options.mode,
      previousType: target.type,
      nextType: target.type,
      previousResolved: target.resolved,
      nextResolved: target.resolved,
      createdAt: now,
    });
    result = { outcome: archivedOutcome, sourceId, targetId };
  });
  if (result.outcome === 'merged_archived' || result.outcome === 'updated_archived') {
    notifyMemoryProcessingWorkAvailable('memory_changed');
  }
  return result;
  });
}

export async function mergeMemoryInto(
  targetId: string,
  sourceId: string,
  options: { confirmationLevel?: MemoryConfirmationLevel; dataEpoch?: number | null; reason?: string } = {},
) {
  if (targetId === sourceId) return false;
  const target = await loadMemory(targetId);
  const source = await loadMemory(sourceId);
  if (!target || !source) return false;
  const result = await applyMemoryDeduplication(targetId, sourceId, {
    actorLevel: options.confirmationLevel,
    expectedSourceVersion: buildMemoryDeduplicationVersion(source),
    expectedTargetVersion: buildMemoryDeduplicationVersion(target),
    mode: 'merge',
    reason: options.reason,
  });
  return result.outcome === 'merged_archived';
}

export async function loadActiveMemoryMergeRecovery(sourceMemoryId: string) {
  const database = await getMemoryDatabase();
  return loadActiveMemoryMergeRecoveryWithDatabase(database, sourceMemoryId);
}

export async function undoMemoryMerge(sourceMemoryId: string): Promise<MemoryMergeUndoOutcome> {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  let outcome: MemoryMergeUndoOutcome = 'not_merge_archive';
  await database.withExclusiveTransactionAsync(async (database) => {
    const sourceRow = await database.getFirstAsync<MemoryRow>(
      'SELECT * FROM memories WHERE id = ?',
      sourceMemoryId,
    );
    if (!sourceRow) return;
    const source = memoryFromRow(sourceRow);
    const snapshot = await loadActiveMemoryMergeRecoveryWithDatabase(database, sourceMemoryId);
    if (!snapshot) {
      const undone = await database.getFirstAsync<{ id: string }>(
        `SELECT id FROM memory_lifecycle_events
         WHERE memory_id = ? AND event_type = 'merge_undone'
         ORDER BY created_at DESC LIMIT 1`,
        sourceMemoryId,
      );
      outcome = undone || source.type !== 'archived' ? 'already_undone' : 'not_merge_archive';
      return;
    }
    const supersedes = await database.getFirstAsync<{ id: string }>(
      `SELECT id FROM memory_edges
       WHERE source_id = ? AND target_id = ? AND relation_type = 'supersedes'
       LIMIT 1`,
      snapshot.targetMemoryId,
      sourceMemoryId,
    );
    if (!supersedes && source.type === 'archived') return;

    const targetRow = await database.getFirstAsync<MemoryRow>(
      'SELECT * FROM memories WHERE id = ?',
      snapshot.targetMemoryId,
    );
    const target = targetRow ? memoryFromRow(targetRow) : null;
    const targetBefore = parseMergeTargetBefore(snapshot.targetBeforeJson);
    const targetUnchanged = !!target
      && !snapshot.legacy
      && !!targetBefore
      && await buildMemoryMergeTargetVersionWithDatabase(database, target) === snapshot.targetVersionAfter;
    const now = Date.now();

    if (targetUnchanged && target && targetBefore) {
      await database.runAsync(
        `UPDATE memories
         SET tags_json = ?, recall_cues_json = ?, importance = ?, stability = ?,
             confidence = ?, confirmation_level = ?, updated_at = ?
         WHERE id = ?`,
        JSON.stringify(targetBefore.tags),
        JSON.stringify(targetBefore.recallCues),
        targetBefore.importance,
        targetBefore.stability,
        targetBefore.confidence ?? null,
        targetBefore.confirmationLevel,
        now,
        target.id,
      );
      if (snapshot.mode === 'update') {
        await database.runAsync(
          `UPDATE memories
           SET title = ?, content = ?, domain = ?, atomic_kind = ?, event_at = ?,
               event_start_at = ?, event_end_at = ?, event_time_precision = ?,
               event_time_basis = ?, event_time_source_message_id = ?,
               event_time_expression = ?, updated_at = ?
           WHERE id = ?`,
          targetBefore.title ?? target.title,
          targetBefore.content ?? target.content,
          targetBefore.domain ?? target.domain,
          targetBefore.atomicKind ?? target.atomicKind,
          targetBefore.eventTime?.startAt ?? targetBefore.eventAt ?? null,
          targetBefore.eventTime?.startAt ?? null,
          targetBefore.eventTime?.endAt ?? null,
          targetBefore.eventTime?.precision ?? 'unknown',
          targetBefore.eventTime?.basis ?? 'unknown',
          targetBefore.eventTime?.timeSourceMessageId ?? null,
          targetBefore.eventTime?.timeExpression ?? null,
          now,
          target.id,
        );
      } else if (typeof targetBefore.content === 'string') {
        await database.runAsync(
          'UPDATE memories SET content = ?, updated_at = ? WHERE id = ?',
          targetBefore.content,
          now,
          target.id,
        );
      }
      for (const key of parseIntroducedSourceRefKeys(snapshot.introducedSourceRefsJson)) {
        const [sessionId, messageId, relation] = key.split('\u0000');
        if (!sessionId || !messageId || relation !== 'derived') continue;
        await database.runAsync(
          `DELETE FROM memory_source_refs
           WHERE memory_id = ? AND session_id = ? AND message_id = ? AND relation = 'derived'`,
          target.id,
          sessionId,
          messageId,
        );
      }
      await database.runAsync('DELETE FROM memory_comments WHERE id = ?', `comment-${snapshot.operationId}`);
    }

    const restoredType: MemoryType = snapshot.sourcePreviousType === 'dynamic'
      || snapshot.sourcePreviousType === 'permanent'
      || snapshot.sourcePreviousType === 'feel'
      ? snapshot.sourcePreviousType
      : source.pinned || source.protected ? 'permanent' : 'dynamic';
    const restoredResolved = snapshot.sourcePreviousResolved ?? false;
    await database.runAsync(
      `UPDATE memories
       SET type = ?, resolved = ?, archived_at = NULL, archive_reason = NULL, updated_at = ?
       WHERE id = ?`,
      restoredType,
      restoredResolved ? 1 : 0,
      now,
      sourceMemoryId,
    );
    await database.runAsync(
      `DELETE FROM memory_edges
       WHERE source_id = ? AND target_id = ? AND relation_type = 'supersedes'`,
      snapshot.targetMemoryId,
      sourceMemoryId,
    );
    await insertMemoryLifecycleEventWithDatabase(database, {
      actor: 'manual',
      changedFields: ['archiveReason', 'archivedAt', 'resolved', 'type'],
      eventType: 'merge_undone',
      memoryId: sourceMemoryId,
      operationId: snapshot.operationId,
      relatedMemoryId: snapshot.targetMemoryId,
      reasonCode: targetUnchanged ? 'restored_both' : target ? 'preserved_changed_target' : 'target_missing',
      previousType: source.type,
      nextType: restoredType,
      previousResolved: source.resolved,
      nextResolved: restoredResolved,
      createdAt: now,
    });
    if (target) {
      await insertMemoryLifecycleEventWithDatabase(database, {
        actor: 'manual',
        changedFields: targetUnchanged ? ['mergeRecovery'] : [],
        eventType: 'merge_undone',
        memoryId: target.id,
        operationId: snapshot.operationId,
        relatedMemoryId: sourceMemoryId,
        reasonCode: targetUnchanged ? 'restored_both' : 'preserved_changed_target',
        previousType: target.type,
        nextType: target.type,
        previousResolved: target.resolved,
        nextResolved: target.resolved,
        createdAt: now,
      });
      await enqueueMemoryUpdateJobsWithDatabase(database, target.id, now);
    }
    await enqueueMemoryUpdateJobsWithDatabase(database, sourceMemoryId, now);
    outcome = targetUnchanged
      ? 'restored_both'
      : target ? 'restored_source_preserved_target' : 'restored_source_target_missing';
  });
  if (outcome.startsWith('restored_')) notifyMemoryProcessingWorkAvailable('memory_changed');
  return outcome;
  });
}

export async function loadMemoryComments(memoryId: string) {
  const database = await getMemoryDatabase();
  const rows = await database.getAllAsync<CommentRow>(
    'SELECT * FROM memory_comments WHERE memory_id = ? ORDER BY created_at DESC',
    memoryId,
  );
  return rows.map(commentFromRow);
}

export async function hasMemoryCommentSource(memoryId: string, source: string) {
  const database = await getMemoryDatabase();
  const row = await database.getFirstAsync<{ id: string }>(
    'SELECT id FROM memory_comments WHERE memory_id = ? AND source = ? LIMIT 1',
    memoryId,
    source,
  );
  return !!row;
}

export async function createMemoryComment(
  memoryId: string,
  content: string,
  sourceType: MemoryCommentSourceType = 'manual',
  options: Partial<Pick<MemoryComment, 'kind' | 'author' | 'valence' | 'arousal' | 'source'>> & {
    touch?: boolean; expectedDehydrationSource?: string;
  } = {},
) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const now = Date.now();
  const id = `comment-${now}-${Math.random().toString(36).slice(2, 10)}`;
  const kind = options.kind ?? 'comment';
  const postValidation = options.expectedDehydrationSource !== undefined
    ? await import('../posts/baiyunPostMemoryBasis') : undefined;
  const postOptions = options.expectedDehydrationSource !== undefined
    ? await postValidation!.preloadPostDerivedReadOptions(database, [{ kind: 'memory', id: memoryId }]) : {};
  const lifecycleType: MemoryLifecycleEventType | null = kind === 'correction'
    ? 'corrected'
    : kind === 'update' ? 'edited' : kind === 'dehydration' ? 'organized' : null;
  const insertComment = async (transaction: SQLite.SQLiteDatabase) => {
    if (options.expectedDehydrationSource !== undefined) {
      const row = await transaction.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', memoryId);
      const comments = await transaction.getAllAsync<CommentRow>('SELECT * FROM memory_comments WHERE memory_id = ?', memoryId);
      if (!row || memoryDehydrationSource(memoryFromRow(row), comments.map(commentFromRow)) !== options.expectedDehydrationSource
        || (await postValidation!.getPostDerivedStatus(transaction, 'memory', memoryId, undefined, postOptions)).status !== 'current'
        || await getWeeklyContextStatus(transaction, memoryFromRow(row), postOptions) !== 'current'
        || await getUnderstandingStatus(transaction, memoryFromRow(row), postOptions) !== 'current') {
        throw new Error('MEMORY_DEHYDRATION_STALE');
      }
    }
    await transaction.runAsync(
      `INSERT INTO memory_comments (id, memory_id, content, source_type, kind, author, valence, arousal, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      memoryId,
      content.trim(),
      sourceType,
      kind,
      options.author ?? '白云小姐',
      options.valence ?? null,
      options.arousal ?? null,
      options.source ?? null,
      now,
    );
    if (lifecycleType) {
      const operationId = buildMemoryLifecycleOperationId(`memory-comment-${kind}`, now);
      await insertMemoryLifecycleEventWithDatabase(transaction, {
        actor: 'manual',
        changedFields: [],
        commentId: id,
        eventType: lifecycleType,
        memoryId,
        operationId,
        reasonCode: kind,
        createdAt: now,
      });
    }
  };
  await database.withExclusiveTransactionAsync(insertComment);
  notifyMemoryProcessingWorkAvailable('memory_changed');
  return id;
  });
}

export async function deleteMemoryComment(id: string) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const database = await getMemoryDatabase();
    await database.runAsync('DELETE FROM memory_comments WHERE id = ?', id);
    notifyMemoryProcessingWorkAvailable('memory_changed');
  });
}

export async function createMemoryRecallFeedback(feedback: {
  kind?: MemoryRecallFeedbackKind;
  memoryId: string;
  query: string;
  reason: MemoryRecallReason;
  score?: number;
  sources?: MemoryRecallSource[];
}) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const now = Date.now();
  const id = `recall-feedback-${now}-${Math.random().toString(36).slice(2, 10)}`;
  await database.runAsync(
    `INSERT INTO memory_recall_feedback (id, memory_id, query, kind, reason, sources_json, score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    feedback.memoryId,
    feedback.query.trim(),
    feedback.kind ?? 'irrelevant',
    feedback.reason,
    JSON.stringify(feedback.sources ?? []),
    typeof feedback.score === 'number' ? feedback.score : null,
    now,
  );
  return {
    id,
    memoryId: feedback.memoryId,
    query: feedback.query.trim(),
    kind: feedback.kind ?? 'irrelevant',
    reason: feedback.reason,
    sources: feedback.sources ?? [],
    score: feedback.score,
    createdAt: now,
  } satisfies MemoryRecallFeedback;
  });
}

export async function loadRecentRecallFeedback(options: { kinds?: MemoryRecallFeedbackKind[]; limit?: number; memoryId?: string; since?: number } = {},
  readContext?: MemoryDatabaseReadContext) {
  const database = withMemoryDatabaseReadContext(await getMemoryDatabase(), readContext);
  const limit = Math.max(1, Math.min(500, Math.round(options.limit ?? 200)));
  const since = options.since ?? Date.now() - 120 * 86400000;
  const kinds = options.kinds?.length ? options.kinds.map(normalizeRecallFeedbackKind) : undefined;
  const clauses = ['created_at >= ?'];
  const params: Array<number | string> = [since];
  if (options.memoryId) {
    clauses.push('memory_id = ?');
    params.push(options.memoryId);
  }
  if (kinds?.length) {
    clauses.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
    params.push(...kinds);
  }
  const rows = await database.getAllAsync<RecallFeedbackRow>(
    `SELECT * FROM memory_recall_feedback
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ?`,
    ...params,
    limit,
  );
  return rows.map(recallFeedbackFromRow);
}

export async function getRecallFeedbackPenaltyMap(query: string, options: { now?: number } = {}) {
  return (await getRecallQualityAdjustmentMap(query, options)).penalties;
}

export async function getRecallQualityAdjustmentMap(query: string, options: { now?: number } = {},
  readContext?: MemoryDatabaseReadContext): Promise<MemoryRecallQualityAdjustments> {
  const now = options.now ?? Date.now();
  const feedback = await loadRecentRecallFeedback({ limit: 320, since: now - 120 * 86400000 }, readContext);
  const boosts = new Map<string, number>();
  const penalties = new Map<string, number>();
  const tags = new Map<string, string[]>();
  const addTag = (memoryId: string, tag: string) => {
    const current = tags.get(memoryId) ?? [];
    if (!current.includes(tag)) tags.set(memoryId, [...current, tag]);
  };
  feedback.forEach((item) => {
    const similarity = recallQuerySimilarity(query, item.query);
    if (similarity < 0.35) return;
    const ageDays = Math.max(0, (now - item.createdAt) / 86400000);
    const decay = Math.exp(-ageDays / 45);
    if (item.kind === 'confirmed') {
      const boost = Math.min(0.08, similarity * decay * 0.045);
      boosts.set(item.memoryId, Math.min(0.12, (boosts.get(item.memoryId) ?? 0) + boost));
      addTag(item.memoryId, 'quality_confirmed');
      return;
    }

    const multiplier = item.kind === 'corrected' ? 1.7 : item.kind === 'outdated' ? 1.45 : 1;
    const cap = item.kind === 'irrelevant' ? 0.25 : 0.34;
    const penalty = Math.min(cap, similarity * decay * 0.18 * multiplier);
    penalties.set(item.memoryId, Math.min(0.55, (penalties.get(item.memoryId) ?? 0) + penalty));
    addTag(
      item.memoryId,
      item.kind === 'corrected' ? 'quality_corrected' : item.kind === 'outdated' ? 'quality_outdated' : 'quality_irrelevant',
    );
  });
  return { boosts, penalties, tags };
}

export async function createMemoryEdge(edge: {
  sourceId: string;
  targetId: string;
  relationType?: MemoryRelationType;
  confidence?: number;
  reason?: string;
  expectedCurrentMaterials?: { sourceHash: string; targetHash: string; dataEpoch?: number };
}) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const sourceId = edge.sourceId.trim();
  const targetId = edge.targetId.trim();
  if (!sourceId || !targetId || sourceId === targetId) return null;
  const database = await getMemoryDatabase();
  const relationType = normalizeRelationType(edge.relationType);
  const confidence = clampNumber(edge.confidence, 0, 1, 0.5);
  const writeEdge = async (database: SQLite.SQLiteDatabase) => {
  const existing = await database.getFirstAsync<EdgeRow>(
    'SELECT * FROM memory_edges WHERE source_id = ? AND target_id = ? AND relation_type = ?',
    sourceId,
    targetId,
    relationType,
  );
  const now = Date.now();
  if (existing) {
    if (existing.confidence <= confidence) {
      await database.runAsync(
        'UPDATE memory_edges SET confidence = ?, reason = ?, created_at = ? WHERE id = ?',
        confidence,
        (edge.reason ?? '').slice(0, 240),
        now,
        existing.id,
      );
    }
    return edgeFromRow({ ...existing, confidence, reason: edge.reason ?? existing.reason, created_at: now });
  }

  const id = `edge-${now}-${Math.random().toString(36).slice(2, 10)}`;
  await database.runAsync(
    'INSERT INTO memory_edges (id, source_id, target_id, relation_type, confidence, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    sourceId,
    targetId,
    relationType,
    confidence,
    (edge.reason ?? '').slice(0, 240),
    now,
  );
  return { id, sourceId, targetId, relationType, confidence, reason: edge.reason ?? '', createdAt: now };
  };
  const expected = edge.expectedCurrentMaterials;
  if (!expected) return writeEdge(database);
  const dataEpoch = expected.dataEpoch ?? captureBackupRestoreDataEpoch();
  let stored: Awaited<ReturnType<typeof writeEdge>> | null = null;
  await database.withExclusiveTransactionAsync(async transaction => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-edge-material-changed');
    for (const [id, hash] of [[sourceId, expected.sourceHash], [targetId, expected.targetHash]]) {
      const row = await transaction.getFirstAsync<MemoryRow>('SELECT * FROM memories WHERE id = ?', id);
      const memory = row ? memoryFromRow(row) : null;
      if (!memory || weeklyTargetHash(memory) !== hash || !isTimelineEligibleMemory(memory)
        || isBaiyunPostMemory(memory) || !(await isCurrentMemory(memory, transaction))) throw new Error('memory-edge-material-changed');
    }
    stored = await writeEdge(transaction);
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('memory-edge-material-changed');
  });
  return stored;
  });
}

export async function reverseMemoryEdge(edgeId: string) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const id = edgeId.trim();
  if (!id) return null;
  const database = await getMemoryDatabase();
  const existing = await database.getFirstAsync<EdgeRow>('SELECT * FROM memory_edges WHERE id = ?', id);
  if (!existing) return null;
  await database.runAsync(
    'UPDATE memory_edges SET source_id = ?, target_id = ?, created_at = ? WHERE id = ?',
    existing.target_id,
    existing.source_id,
    Date.now(),
    id,
  );
  return edgeFromRow({
    ...existing,
    source_id: existing.target_id,
    target_id: existing.source_id,
    created_at: Date.now(),
  });
  });
}

export async function updateMemoryEdge(edgeId: string, updates: { relationType?: MemoryRelationType; reason?: string }) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const id = edgeId.trim();
  if (!id) return null;
  const database = await getMemoryDatabase();
  const existing = await database.getFirstAsync<EdgeRow>('SELECT * FROM memory_edges WHERE id = ?', id);
  if (!existing) return null;
  const relationType = updates.relationType ? normalizeRelationType(updates.relationType) : normalizeRelationType(existing.relation_type);
  const reason = typeof updates.reason === 'string' ? updates.reason.slice(0, 240) : existing.reason;
  const now = Date.now();
  await database.runAsync(
    'UPDATE memory_edges SET relation_type = ?, reason = ?, created_at = ? WHERE id = ?',
    relationType,
    reason,
    now,
    id,
  );
  return edgeFromRow({ ...existing, relation_type: relationType, reason, created_at: now });
  });
}

export async function deleteMemoryEdge(edgeId: string) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const id = edgeId.trim();
    if (!id) return;
    const database = await getMemoryDatabase();
    await database.runAsync('DELETE FROM memory_edges WHERE id = ?', id);
  });
}

export async function loadAllMemoryEdges(minConfidence = 0.55) {
  const database = await getMemoryDatabase();
  const rows = await database.getAllAsync<EdgeRow>('SELECT * FROM memory_edges WHERE confidence >= ? ORDER BY created_at ASC', minConfidence);
  return rows.map(edgeFromRow);
}

export async function loadTimelineOverrides() {
  const database = await getMemoryDatabase();
  const [threadRows, memberRows] = await Promise.all([
    database.getAllAsync<{
      id: string;
      title: string | null;
      hidden: number;
      manual: number;
      created_at: number;
      updated_at: number;
    }>('SELECT * FROM memory_timeline_threads ORDER BY created_at ASC'),
    database.getAllAsync<{
      thread_id: string;
      memory_id: string;
      included: number;
      position: number;
    }>('SELECT * FROM memory_timeline_members ORDER BY position ASC, created_at ASC'),
  ]);
  return {
    threads: threadRows.map((row): TimelineThreadOverride => ({
      id: row.id,
      title: row.title ?? undefined,
      hidden: row.hidden === 1,
      manual: row.manual === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    members: memberRows.map((row): TimelineMemberOverride => ({
      threadId: row.thread_id,
      memoryId: row.memory_id,
      included: row.included === 1,
      position: row.position,
    })),
  };
}

export async function createManualTimeline(title: string, memoryIds: string[]) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const now = Date.now();
  const id = `timeline-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const uniqueIds = Array.from(new Set(memoryIds.filter(Boolean)));
  await database.withExclusiveTransactionAsync(async (database) => {
    await database.runAsync(
      'INSERT INTO memory_timeline_threads (id, title, hidden, manual, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)',
      id,
      title.trim() || '未命名事件',
      now,
      now,
    );
    for (let index = 0; index < uniqueIds.length; index += 1) {
      await database.runAsync(
        'INSERT INTO memory_timeline_members (thread_id, memory_id, included, position, created_at) VALUES (?, ?, 1, ?, ?)',
        id,
        uniqueIds[index],
        index,
        now,
      );
    }
  });
  return id;
  });
}

export async function updateTimelineTitle(threadId: string, title: string, manual = false) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const now = Date.now();
  await database.runAsync(
    `INSERT INTO memory_timeline_threads (id, title, hidden, manual, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, hidden = 0, updated_at = excluded.updated_at`,
    threadId,
    title.trim() || null,
    manual ? 1 : 0,
    now,
    now,
  );
  });
}

export async function setTimelineHidden(threadId: string, hidden: boolean, manual = false) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  const now = Date.now();
  await database.runAsync(
    `INSERT INTO memory_timeline_threads (id, hidden, manual, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET hidden = excluded.hidden, updated_at = excluded.updated_at`,
    threadId,
    hidden ? 1 : 0,
    manual ? 1 : 0,
    now,
    now,
  );
  });
}

export async function setTimelineMemoryIncluded(
  threadId: string,
  memoryId: string,
  included: boolean,
  position = Date.now(),
) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
  const database = await getMemoryDatabase();
  await database.runAsync(
    `INSERT INTO memory_timeline_members (thread_id, memory_id, included, position, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, memory_id) DO UPDATE SET included = excluded.included, position = excluded.position`,
    threadId,
    memoryId,
    included ? 1 : 0,
    position,
    Date.now(),
  );
  });
}

export async function loadRelatedMemoryEdges(memoryIds: string[], minConfidence = 0.55, limitPerSource = 1,
  readContext?: MemoryDatabaseReadContext) {
  const ids = Array.from(new Set(memoryIds.filter(Boolean)));
  if (!ids.length) return [];
  const database = withMemoryDatabaseReadContext(await getMemoryDatabase(), readContext);
  const rows = await database.getAllAsync<EdgeRow>('SELECT * FROM memory_edges WHERE confidence >= ? ORDER BY confidence DESC', minConfidence);
  const grouped = new Map<string, MemoryEdge[]>();
  for (const row of rows.map(edgeFromRow)) {
    if (ids.includes(row.sourceId)) {
      grouped.set(row.sourceId, [...(grouped.get(row.sourceId) ?? []), row]);
    } else if (ids.includes(row.targetId)) {
      grouped.set(row.targetId, [
        ...(grouped.get(row.targetId) ?? []),
        { ...row, sourceId: row.targetId, targetId: row.sourceId },
      ]);
    }
  }
  return Array.from(grouped.values())
    .flatMap((edges) => edges.sort((left, right) => right.confidence - left.confidence).slice(0, Math.max(1, limitPerSource)))
    .sort((left, right) => right.confidence - left.confidence);
}

export async function loadMemoryGraphLinks(memoryId: string, options: { limit?: number; minConfidence?: number; currentOnly?: boolean } = {}): Promise<MemoryGraphLink[]> {
  const { diagnoseMemoryEdge } = await import('./memoryGraphMaintenance');
  const limit = Math.max(1, Math.min(20, Math.round(options.limit ?? 5)));
  const edges = (await loadAllMemoryEdges(options.minConfidence ?? 0))
    .filter((edge) => edge.sourceId === memoryId || edge.targetId === memoryId)
    .sort((left, right) => right.confidence - left.confidence || right.createdAt - left.createdAt);
  const links = await Promise.all(edges.map(async (edge): Promise<MemoryGraphLink | null> => {
    const direction = edge.sourceId === memoryId ? 'outgoing' as const : 'incoming' as const;
    const [sourceMemory, targetMemory] = await Promise.all([loadMemory(edge.sourceId), loadMemory(edge.targetId)]);
    const otherMemory = direction === 'outgoing' ? targetMemory : sourceMemory;
    if (!otherMemory) return null;
    if (options.currentOnly && (!(await isCurrentMemory(otherMemory))
      || (sourceMemory && !(await isCurrentMemory(sourceMemory)))
      || (targetMemory && !(await isCurrentMemory(targetMemory))))) return null;
    return {
      diagnostic: diagnoseMemoryEdge(edge, sourceMemory, targetMemory),
      direction,
      edge,
      memory: otherMemory,
    };
  }));
  return links.filter((link): link is MemoryGraphLink => !!link).slice(0, limit);
}

export async function loadRelatedMemories(memoryIds: string[], options: { minConfidence?: number; limitPerSource?: number } = {}) {
  const edges = await loadRelatedMemoryEdges(memoryIds, options.minConfidence, options.limitPerSource);
  const memories = await Promise.all(edges.map((edge) => loadMemory(edge.targetId)));
  return filterCurrentMemories(await getMemoryDatabase(), memories.filter((memory): memory is MemoryEntry => memory !== null && (isUnderstandingMemory(memory) || isTimelineEligibleMemory(memory))));
}

export async function loadRelatedMemoryMatches(memoryIds: string[], options: { minConfidence?: number; limitPerSource?: number } = {},
  readContext?: MemoryDatabaseReadContext) {
  const { diagnoseMemoryEdge, shouldUseEdgeForRelatedRecall } = await import('./memoryGraphMaintenance');
  const edges = await loadRelatedMemoryEdges(memoryIds, options.minConfidence, options.limitPerSource, readContext);
  const reader = readContext ? withMemoryDatabaseReadContext(await getMemoryDatabase(), readContext) : undefined;
  const matches = await Promise.all(edges.map(async (edge) => {
    const [sourceMemory, targetMemory] = await Promise.all([loadMemory(edge.sourceId, readContext), loadMemory(edge.targetId, readContext)]);
    const diagnostic = diagnoseMemoryEdge(edge, sourceMemory, targetMemory);
    if (!shouldUseEdgeForRelatedRecall(edge, diagnostic)) return null;
    return targetMemory && (isUnderstandingMemory(targetMemory) || isTimelineEligibleMemory(targetMemory)) && await isCurrentMemory(targetMemory, reader, { signal: readContext?.signal })
      && (!sourceMemory || await isCurrentMemory(sourceMemory, reader, { signal: readContext?.signal })) ? { diagnostic, edge, memory: targetMemory } : null;
  }));
  return matches.filter((match): match is { diagnostic: MemoryEdgeDiagnostic; edge: MemoryEdge; memory: MemoryEntry } => match !== null);
}

/** @deprecated Preparation is not usage. Settlement requires a saved model body. */
export async function touchMemory(_id: string, _options: { ripple?: boolean } = {}) {}

async function performMemoryMaintenance() {
  const memories = await loadMemories();
  const now = Date.now();
  for (const memory of memories) {
    if (
      memory.type !== 'dynamic'
      || memory.pinned
      || memory.protected
      || memory.anchor
      || memory.importance >= 8
      || memory.domain === '边界'
      || memory.domain === '称呼'
      || memory.domain === '约定'
      || memory.activationCount <= 0
      || memory.lastActiveAt <= 0
    ) continue;
    const daysSince = Math.max(0, (now - memory.lastActiveAt) / 86400000);
    const score = calculateDecayScore(memory, now);
    let nextTier: MemoryTier = memory.tier;
    if (memory.tier === 'core' && daysSince > 180 && score < 0.5) nextTier = 'working';
    else if (memory.activationCount >= 8 || (memory.activationCount >= 4 && score >= 4)) nextTier = 'core';
    else if (memory.activationCount >= 2 || score >= 1.5) nextTier = 'working';
    else if (daysSince > 45 && score < 1) nextTier = 'peripheral';
    if (nextTier !== memory.tier) {
      await updateMemoryState(memory.id, { tier: nextTier });
    }
  }
  return { checked: memories.length, autoResolved: 0, archived: 0 };
}

export async function runMemoryMaintenance(diagnosticParentToken?: number) {
  return observeRuntimeWorkload(
    'memory.maintenance_actual',
    () => performMemoryMaintenance(),
    (value) => ({ memoryCount: value.checked }),
    { parentToken: diagnosticParentToken },
  );
}

export function calculateDecayScore(memory: MemoryEntry, now = Date.now()) {
  if (memory.pinned || memory.protected || memory.type === 'permanent') return 999;
  if (memory.type === 'feel') return 50;
  if (memory.activationCount <= 0 || memory.lastActiveAt <= 0) return 0;
  const daysSince = Math.max(0, (now - memory.lastActiveAt) / 86400000);
  const hours = daysSince * 24;
  const timeWeight = 1 + Math.exp(-hours / 36);
  const emotionWeight = 1 + memory.arousal * 0.8;
  const combinedWeight = daysSince <= 3 ? timeWeight * 0.7 + emotionWeight * 0.3 : emotionWeight * 0.7 + timeWeight * 0.3;
  const emotionalHalfLife = memory.arousal >= 0.7
    ? 0.032
    : memory.arousal < 0.3 && memory.importance <= 4 && memory.tier === 'peripheral'
      ? 0.075
      : 0.05;
  const baseScore = memory.importance * Math.max(1, memory.activationCount) ** 0.3 * Math.exp(-emotionalHalfLife * daysSince) * combinedWeight;
  const urgencyBoost = memory.arousal > 0.7 ? 1.5 : 1;
  return Number((baseScore * urgencyBoost).toFixed(4));
}

const CORE_TEXT_EVIDENCE_THRESHOLD = 0.12;
const STRONG_RELATED_EDGE_TYPES: MemoryRelationType[] = ['promises', 'contradicts', 'updates', 'causes', 'blocks'];

function recallReasonsForItem(item: Pick<MemoryRecallItem, 'memory' | 'reason' | 'sources'>) {
  const reasons = new Set<string>();
  if (item.reason === 'quiet_context') reasons.add('quiet_context');
  if (item.reason === 'suggested_mention') reasons.add('suggested_mention');
  if (item.reason === 'related') reasons.add('related_edge');
  if (item.reason === 'pinned' || item.memory.pinned || item.memory.protected) reasons.add('pinned');
  if (item.memory.anchor) reasons.add('anchor_coordinate');
  item.sources?.forEach((source) => {
    if (source === 'vector') reasons.add('vector_match');
    if (source === 'fts' || source === 'cjk') reasons.add('keyword_match');
    if (source === 'bridge') reasons.add('bridge_match');
    if (source === 'related') reasons.add('related_edge');
  });
  if (item.memory.arousal >= 0.7) reasons.add('high_arousal');
  if (item.memory.activationCount > 0 && item.memory.lastActiveAt > 0
    && Date.now() - item.memory.lastActiveAt > 14 * 86400000) reasons.add('stale_but_important');
  if (item.memory.surfaceMutedAt) reasons.add('surface_muted');
  return Array.from(reasons);
}

export async function searchMemoryScreenEntries(
  query: string,
  options: { semanticScores: Map<string, number>; textScores?: Map<string, MemoryTextCandidateScore>; archivedOnly?: boolean },
) {
  const memories = await loadMemories({ currentOnly: true,
    archivedOnly: options.archivedOnly, includeArchived: options.archivedOnly });
  return rankMemoryEntriesForSearch(memories.filter(memory => memory.type !== 'feel'
    && !isWhisperMemory(memory) && !isBaiyunPostMemory(memory)), query, options);
}

export async function searchMemories(
  query: string,
  options: {
    materialPreparation?: MemoryMaterialPreparation;
    feedbackBoosts?: Map<string, number>;
    feedbackPenalties?: Map<string, number>;
    limit?: number;
    includeArchived?: boolean;
    archivedOnly?: boolean;
    semanticScores?: Map<string, number>;
    textScores?: Map<string, MemoryTextCandidateScore>;
    memories?: readonly MemoryEntry[];
  } = {},
) {
  const memories = options.memories
    ? options.memories.filter((memory) => (
      options.archivedOnly ? memory.type === 'archived' : options.includeArchived || memory.type !== 'archived'
    ))
    : await loadMemories({
      archivedOnly: options.archivedOnly,
      includeArchived: options.includeArchived,
    });
  const scored = rankMemoryEntriesForRecall(
    (options.materialPreparation ? await options.materialPreparation.filterCandidateSnapshots(memories)
      : await filterCurrentMemories(await getMemoryDatabase(), memories)).filter((memory) => memory.type !== 'feel'),
    query,
    {
      feedbackBoosts: options.feedbackBoosts,
      feedbackPenalties: options.feedbackPenalties,
      limit: options.limit ?? 30,
      semanticScores: options.semanticScores,
      textScores: options.textScores,
    },
  );

  return scored.map((item) => ({
    memory: item.memory,
    reason: item.tier === 'direct'
      ? 'direct' as const
      : item.tier === 'context'
        ? 'context' as const
        : item.tier === 'semantic'
          ? 'semantic' as const
          : 'text' as const,
    score: item.score,
    baseRankScore: item.baseRankScore,
    relevanceTier: item.tier,
    sources: item.sources,
  }));
}

async function withLatestComments(items: MemoryRecallItem[]) {
  return Promise.all(
    items.map(async (item) => {
      const comments = currentMemoryComments(item.memory, await loadMemoryComments(item.memory.id));
      const latestComment = comments.find((comment) => comment.kind === 'dehydration') ?? comments[0];
      return { ...item, latestComment, commentsChecked: true };
    }),
  );
}

function formatMemoryRecallContent(memory: MemoryEntry, latestComment?: MemoryComment) {
  if (latestComment?.kind !== 'dehydration') {
    return memory.content;
  }
  return `压缩年轮（旧记忆核心，不是新事件）：${latestComment.content}\n  原始记忆仍保留，以上摘要只用于帮助回想重点。`;
}

function formatMemoryRecallComment(latestComment?: MemoryComment) {
  if (!latestComment || latestComment.kind === 'dehydration') return '';
  return `\n  后来补记：${latestComment.content}`;
}

export function formatMemoryRecallItemsContext(items: readonly MemoryRecallItem[]) {
  return items.map(({ memory, latestComment, reason }) => (
    `- [${reason}] ${formatMemoryRecallContent(memory, latestComment)}${memory.tags.length ? ` [标签: ${memory.tags.join('、')}]` : ''}`
    + formatMemoryRecallComment(latestComment)
  )).join('\n');
}

function memoryDiversitySimilarity(leftTerms: ReadonlySet<string>, rightTerms: ReadonlySet<string>) {
  if (!leftTerms.size || !rightTerms.size) return 0;
  let overlap = 0;
  leftTerms.forEach((term) => {
    if (rightTerms.has(term)) overlap += 1;
  });
  return overlap / Math.min(leftTerms.size, rightTerms.size);
}

function diversifyRecall(items: MemoryRecallItem[], limit: number) {
  const terms = new Map<MemoryEntry, Set<string>>();
  const termsFor = (memory: MemoryEntry) => {
    let value = terms.get(memory);
    if (!value) {
      value = cjkBigrams(`${memory.title}${memory.content}${memory.tags.join('')}${memory.recallCues.join('')}`);
      terms.set(memory, value);
    }
    return value;
  };
  const selected: MemoryRecallItem[] = [];
  const deferred: MemoryRecallItem[] = [];
  items.forEach((item) => {
    const duplicate = selected.some((existing) => memoryDiversitySimilarity(termsFor(existing.memory), termsFor(item.memory)) >= 0.82);
    (duplicate ? deferred : selected).push(item);
  });
  return [...selected, ...deferred].slice(0, limit);
}

export function isMemoryRecallEligible(memory: MemoryEntry) {
  return memory.type !== 'archived' && memory.type !== 'feel';
}

export async function refreshMemoryRecallItems(items: readonly MemoryRecallItem[], query: string,
  preparation: MemoryMaterialPreparation) {
  const current = await preparation.refresh(items.map(item => item.memory), isMemoryRecallEligible);
  return selectRefreshedMemoryRecallItems(items, query, preparation, current);
}

/** Score the batch just read by the caller without starting a second storage pass. */
export function selectRefreshedMemoryRecallItems(items: readonly MemoryRecallItem[], query: string,
  preparation: MemoryMaterialPreparation, current: readonly MemoryEntry[], options: { requireRelevant?: boolean } = {}) {
  const originals = new Map(items.map(item => [item.memory.id, item]));
  const result = current.flatMap(memory => {
    const old = originals.get(memory.id);
    if (!old) return [];
    // A mute-only change doesn't invalidate already-admitted text/vector evidence.
    // Empty/background-only admission still passes the local mute gate.
    const keepEvidence = preparation.wasOnlySurfaceMuteRefreshed?.(memory.id)
      && !!query.trim() && old.relevanceTier !== undefined && old.relevanceTier !== 'weak';
    const local = preparation.wasRefreshed(memory.id) && !keepEvidence ? scoreMemoryForRecall(memory, query, {}, Date.now()) : undefined;
    if (local && !local.admitted) return [];
    if (options.requireRelevant && (local ? local.tier === 'weak' : old.relevanceTier === undefined || old.relevanceTier === 'weak')) return [];
    const comments = preparation.commentsFor(memory.id);
    return [{ ...old, memory, commentsChecked: true,
      latestComment: comments.find(comment => comment.kind === 'dehydration') ?? comments[0],
      ...(local ? { score: local.score, baseRankScore: local.baseRankScore, relevanceTier: local.tier, sources: local.sources, reason: 'text' as const,
        recallReasons: undefined } : {}),
    }];
  });
  return !items.some(item => item.modelRanked) && result.some(item => preparation.wasRefreshed(item.memory.id))
    ? result.sort(compareMemoryRecallRanks) : result;
}

export async function buildMemoryRecall(
  currentMessage: string,
  options: {
    allowRerank?: boolean;
    diagnosticParentToken?: number;
    semanticScores?: Map<string, number>;
    textScores?: Map<string, MemoryTextCandidateScore>;
    maxResults?: number;
    touch?: boolean;
    memories?: readonly MemoryEntry[];
    signal?: AbortSignal;
    materialPreparation?: MemoryMaterialPreparation;
    collectBackgroundCandidates?: boolean;
  } = {},
): Promise<MemoryRecallResult> {
  const preparation = options.materialPreparation ?? createMemoryMaterialPreparation({ signal: options.signal });
  const readContext = { signal: options.signal };
  preparation.assertCurrent(options.signal);
  const sourceMemories = options.memories
    ? options.memories.filter((memory) => memory.type !== 'archived')
    : await loadMemories({}, readContext);
  const memories = await preparation.filterCandidateSnapshots(sourceMemories);
  preparation.assertCurrent(options.signal);
  const selectedIds = new Set<string>();
  const now = Date.now();
  const qualityAdjustments = await getRecallQualityAdjustmentMap(currentMessage, { now }, readContext);
  preparation.assertCurrent(options.signal);
  const pinned = memories
    .filter((memory) => memory.pinned || memory.protected)
    .map((memory) => scoreMemoryForRecall(memory, currentMessage, {
      ...options,
      feedbackBoosts: qualityAdjustments.boosts,
      feedbackPenalties: qualityAdjustments.penalties,
    }, now))
    .filter((item) => item.admitted)
    .sort(compareMemoryRecallRanks)
    .slice(0, 2)
    .map(({ memory, score, baseRankScore, tier, sources }) => ({
      memory,
      reason: 'pinned' as const,
      score,
      baseRankScore,
      relevanceTier: tier,
      sources: sources.includes('pinned') ? sources : [...sources, 'pinned' as const],
    }));
  pinned.forEach(({ memory }) => selectedIds.add(memory.id));

  const searched = await searchMemories(currentMessage, {
    materialPreparation: preparation,
    feedbackBoosts: qualityAdjustments.boosts,
    feedbackPenalties: qualityAdjustments.penalties,
    limit: 30,
    semanticScores: options.semanticScores,
    textScores: options.textScores,
    memories,
  });
  const dynamic = searched
    .filter(({ memory }) => !selectedIds.has(memory.id))
    .slice(0, 20);
  dynamic.forEach(({ memory }) => selectedIds.add(memory.id));

  preparation.assertCurrent(options.signal);
  const related = (await loadRelatedMemoryMatches(dynamic.slice(0, 10).map(({ memory }) => memory.id), { minConfidence: 0.58, limitPerSource: 1 }, readContext))
    .filter(({ memory }) => !selectedIds.has(memory.id))
    .map(({ edge, memory }) => ({
      edge,
      scored: scoreMemoryForRecall(memory, currentMessage, {
        ...options,
        feedbackBoosts: qualityAdjustments.boosts,
        feedbackPenalties: qualityAdjustments.penalties,
        related: true,
      }, now),
    }))
    .filter(({ edge, scored }) => {
      const strongEdge = STRONG_RELATED_EDGE_TYPES.includes(edge.relationType) && edge.confidence >= 0.65;
      return scored.admitted && (strongEdge || scored.evidenceScore >= CORE_TEXT_EVIDENCE_THRESHOLD);
    })
    .sort((left, right) => compareMemoryRecallRanks(left.scored, right.scored))
    .slice(0, 3)
    .map(({ scored: { memory, score, baseRankScore, tier, sources } }) => ({
      memory,
      reason: 'related' as const,
      score,
      baseRankScore,
      relevanceTier: tier,
      sources: sources.includes('related') ? sources : [...sources, 'related' as const],
    }));
  related.forEach(({ memory }) => selectedIds.add(memory.id));
  preparation.assertCurrent(options.signal);

  const maxResults = Math.max(4, Math.min(8, options.maxResults ?? 6));
  const candidateLimit = Math.max(maxResults, 12);
  const rerankerSettings = options.allowRerank === false ? undefined : await loadMemoryRerankerSettings();
  if (options.signal?.aborted) throw Object.assign(new Error('memory-recall-cancelled'), { name: 'AbortError' });
  const localCandidates = await refreshMemoryRecallItems(diversifyRecall([...pinned, ...dynamic, ...related].sort(compareMemoryRecallRanks), candidateLimit), currentMessage, preparation);
  if (options.signal?.aborted) throw Object.assign(new Error('memory-recall-cancelled'), { name: 'AbortError' });
  const synchronousSkip = options.allowRerank === false || skipMemoryReranking(rerankerSettings!, localCandidates.length);
  const reranked = synchronousSkip
    ? { items: localCandidates, used: false }
    : await rerankMemoryCandidates(currentMessage, localCandidates, maxResults, options.signal, rerankerSettings);
  if (reranked.used) reranked.items = reranked.items.map(item => ({ ...item, modelRanked: true }));
  if (options.signal?.aborted) throw Object.assign(new Error('memory-recall-cancelled'), { name: 'AbortError' });
  // Read settings before the candidate check, so a skipped rerank stays synchronous.
  // An awaited rerank still needs a reread after it returns (including fallback).
  const reuseCandidates = preparation.hasCandidateSnapshot();
  if (!synchronousSkip || !reuseCandidates) {
    reranked.items = await refreshMemoryRecallItems(reranked.items, currentMessage, preparation);
  }
  const selected = reranked.used ? reranked.items : diversifyRecall(reranked.items, maxResults);
  const recalled = (reuseCandidates ? selected
    : await refreshMemoryRecallItems(selected, currentMessage, preparation)).map((item) => ({
    ...item,
    recallReasons: Array.from(new Set([
      ...(item.recallReasons ?? recallReasonsForItem(item)),
      ...(qualityAdjustments.tags.get(item.memory.id) ?? []),
    ])),
  }));
  if (options.signal?.aborted) throw Object.assign(new Error('memory-recall-cancelled'), { name: 'AbortError' });
  if (options.touch !== false) {
    if (Date.now() - lastMaintenanceAt > 24 * 60 * 60 * 1000) {
      lastMaintenanceAt = Date.now();
      void runMemoryMaintenance(options.diagnosticParentToken).catch(() => {
        lastMaintenanceAt = 0;
      });
    }
  }

  return {
    context: formatMemoryRecallItemsContext(recalled),
    items: recalled,
    ...(options.collectBackgroundCandidates ? { backgroundCandidates: localCandidates.filter(item => item.relevanceTier !== undefined && item.relevanceTier !== 'weak') } : {}),
  };
}

export async function buildMemoryContext(currentMessage: string) {
  return (await buildMemoryRecall(currentMessage)).context;
}

export async function buildMemoryIntrospection() {
  const memories = await loadMemories({ currentOnly: true });
  const recent = memories
    .filter((memory) => isTimelineEligibleMemory(memory))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 10);
  const undigested = recent.filter((memory) => !memory.digested).slice(0, 5);
  const oldEcho = memories
    .filter((memory) => isTimelineEligibleMemory(memory) && !memory.surfaceMutedAt)
    .sort((left, right) => left.lastActiveAt - right.lastActiveAt)[0];
  return {
    recent,
    undigested,
    oldEcho,
    prompt: [
      '最近可以回看的记忆：',
      ...recent.map((memory) => `- ${memory.title}: ${memory.content}`),
      undigested.length ? '\n还没有消化的记忆：' : '',
      ...undigested.map((memory) => `- ${memory.title}`),
      oldEcho ? `\n旧回声：${oldEcho.title}: ${oldEcho.content}` : '',
    ].filter(Boolean).join('\n'),
  };
}

export async function createWhisperMemory(
  {
    content,
    source = 'assistant-life',
    valence = 0.5,
    arousal = 0.3,
  }: {
    content: string;
    source?: string;
    valence?: number;
    arousal?: number;
  },
  options: Pick<MemoryCreateOptions, 'dataEpoch'> = {},
) {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return createMemory({
    title: deriveMemoryTitle(trimmed),
    content: trimmed,
    domain: '相处',
    tags: ['whisper', '碎碎念', '白云动态'],
    recallCues: ['小仓鼠', '近况', '白云小姐想起'],
    importance: 5,
    valence,
    arousal,
    pinned: false,
    anchor: false,
    type: 'feel',
    resolved: false,
    digested: true,
    protected: false,
    sourceType: 'automatic',
    source,
    period: 'whisper',
  }, options);
}

export async function loadWhisperMemories(limit = 8) {
  const memories = await loadMemories({ includeArchived: false, type: 'feel' });
  return memories
    .filter(isWhisperMemory)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit);
}
