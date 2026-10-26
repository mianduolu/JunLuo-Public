import type { AiConnection } from '../ai/types';
import { nextLifeSelfOrganizationWork, prepareLifeSelfOrganizationMaterials, restoreLifeSelfOrganizationMaterials,
  loadLifeSelfOrganizationRetry, attachLifeSelfBatch, type LifeSelfOrganizationWork, type LifeSelfWorkSource,
  type PreparedLifeSelfOrganizationMaterial } from './lifeSelfMemoryIngestion';
import { validateLifeSelfBinding } from '../life/lifeSelfMemorySource';
import { nextLetterMaterial, restoreLetterMaterial, validateLetterBinding, isLetterChatCopy, type PreparedLetterMaterial } from './letterMemoryIngestion';
import { nextObservationMaterials, restoreObservationMaterial, validateObservationBinding,
  loadObservationOrganizationRetry, type PreparedObservationMaterial, type ObservationWorkSource } from './memoryObservationIngestion';
import { nextReadingOrganizationWork, prepareReadingOrganizationMaterials, restoreReadingOrganizationMaterial,
  loadReadingOrganizationRetry, type PreparedReadingOrganizationMaterial, type ReadingOrganizationWork,
  type ReadingWorkSource } from '../reading/readingMemoryIngestion';
import { validateReadingOrganizationBinding } from '../reading/readingMemoryOrganizationSource';
import { nextShiyingOrganizationWork, prepareShiyingOrganizationMaterials, restoreShiyingOrganizationMaterial,
  loadShiyingOrganizationRetry, type ShiyingOrganizationWork, type PreparedShiyingOrganizationMaterial,
  type ShiyingWorkSource } from '../shiying/shiyingMemoryIngestion';
import { validateShiyingMemoryBinding, type ShiyingMemoryBinding } from '../shiying/shiyingMemorySource';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { AppState } from 'react-native';
import { enqueueExplicitFactMemory, resumeExplicitFactMemories as resumePendingExplicitFacts } from './explicitFactMemoryRecovery';
import { discardWeeklyRefreshCandidate } from './memoryWeeklyRefresh';
import { saveWeeklyCandidate } from './memoryWeeklyCandidateActions';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import {
  makeMemoryCandidateKey,
  makeMemoryIngestionSourceHash,
  stableMemoryHash,
} from './memoryAtomicity';
import {
  beginMemoryIngestionBatch,
  loadMemoryIngestionBatch,
  loadSelectedMemoryIngestionBatch,
  loadMemoryIngestionCursor,
  loadChatMemoryIngestionProgress,
  filterUnreviewedChatMemoryMessages,
  loadPendingMemoryCandidates,
  markMemoryIngestionBatchFailed,
  registerMemoryIngestionOutcome,
  resolveMemoryIngestionItems,
  seedMemoryIngestionCursor,
  runMemoryCandidateSave,
  retireChangedMemoryExtraction,
} from './memoryIngestionService';
import type { MemoryIngestionItemRef, MemoryIngestionStream } from './memoryIngestionLedger';
import type { MemoryBundleDebug } from './memoryOrchestrator';
import type { MemoryRecallRoute } from './memoryRecallRouter';
import {
  organizeConversationMemories,
  proposeConversationMemory,
} from './memoryOrganizer';
import { classifyMemoryOrganizationFailure, getMemoryOrganizationFailureNotice } from './memoryOrganizationFailure';
import {
  annotateManualMemoryCandidates,
  filterAutomaticMemoryCandidates,
} from './memoryAdmissionControl';
import {
  annotateManualLongMemoryCandidates,
  filterAutomaticLongMemoryCandidates,
} from './memoryImportanceGate';
import { applyMemoryCalibrationFeedbackFromUser } from './memoryCalibration';
import { applyMemorySurfacingFeedbackFromUser } from './memorySurfacing';
import { buildSingleMemorySourceRef } from './memorySourceRefs';
import {
  createMemory,
  createMemoryRecallFeedback,
  loadMemories,
  type MemoryRecallItem,
} from './memoryStore';
import {
  appendMemoryCandidateReviews,
  makeReviewCandidates,
  memoryCandidateEditSession,
  memoryCandidateEditableHash,
  type MemoryCandidateReview,
} from './memoryCandidateReview';
import { hasMemoryOrganizerConfig } from './memoryOrganizerConfigNotice';
import {
  makeCurrentStateCandidatesFromMemoryCandidate,
  type MemoryCurrentStateCandidate,
  type MemoryCurrentStateResolveCandidate,
} from './memoryCurrentStateCandidates';
import { organizeVoiceCallMemoryRecord, recoverVoiceCallMemoryResults, isVoiceCallMemoryOrganizationRunning } from '../voiceCall/voiceCallMemoryOrganizationRuntime';
import { loadVoiceCallMemoryRecord, getVoiceCallMemorySessionId } from '../voiceCall/voiceCallMemorySource';
import { upsertVoiceCallRecord, voiceCallRecordVersion, persistActiveVoiceCallRecordDraft, loadActiveVoiceCallRecordDraft } from '../voiceCall/voiceCallRecordStorage';
import { queueCurrentStateReviews, loadPendingCurrentStateReviews, discardCurrentStateReview } from './memoryCurrentStateRecovery';
import { runMemoryOrganizerRequestWithDeadline } from './memoryOrganizerRequestLifecycle';
import { prepareUnderstandingMaterials, type UnderstandingMaterials } from './memoryUnderstanding';
import { discardUnderstandingCandidate, saveUnderstandingCandidate } from './memoryUnderstandingReview';
import { saveConversationMemoryCandidate } from './memoryEpisodeReview';
import { saveCurrentStateReview, recheckCurrentStateCandidate } from './memoryCurrentStateReview';
import { memoryCandidateTargetKey } from './memoryCandidateReview';
import { loadLatestUnfinishedMemoryIngestionWork, loadMemoryIngestionWork,
  releaseMemoryIngestionBatchWaiting, updateMemoryIngestionBatchWaiting } from './memoryIngestionService';
import type { MemoryIngestionBatchInput } from './memoryIngestionLedger';

const MANUAL_DIGEST_BATCH_SIZE = 30;
const PROACTIVE_DIGEST_BATCH_SIZE = MANUAL_DIGEST_BATCH_SIZE;
const PROACTIVE_MEMORY_SUGGESTION_COOLDOWN_MS = 8 * 60 * 1000;
const EPISODE_MEMORY_MIN_MESSAGES = 12;
const EPISODE_MEMORY_MIN_USER_CHARS = 260;
const FAST_REPLY_PATTERN =
  /^(?:哈[哈啊]*|嗯+|哦+|好(?:的|呀|哒|啦)?|行|可以|收到|谢谢|谢啦|抱抱|在吗|早|早安|午安|晚安|嗨|hi|hello|嘿|诶|欸|？+|！+|[~～…。.，,、]+)$/i;
const EXPLICIT_FACT_MEMORY_PATTERN =
  /(?:我|鼠|小仓鼠).{0,8}(?:喜欢|不喜欢|讨厌|不能接受|偏好|更爱|爱吃|爱听|爱看|叫我|称呼|名字|昵称|有鼻炎|过敏|胃病|头疼|失眠|生病|长期|一直|固定|每周|每天|约定|说好|记住|别忘|不要忘)|(?:喜欢|不喜欢|讨厌|不能接受|偏好|叫我|称呼|昵称|有鼻炎|过敏|长期|固定|每周|每天|约定|说好|记住|别忘|不要忘).{0,10}(?:我|鼠|小仓鼠)|(?:纯音乐|钢琴曲|广播剧|对白类音频|歌单|点歌).{0,12}(?:喜欢|不喜欢|偏好|讨厌|爱听)/;
const PROJECT_FACT_MEMORY_PATTERN =
  /(?:君落|第[一二三四五六七八九十\d]+章|记忆|日程|待办|目标|prompt|正则|兜底|清洗|召回|主动消息|手机活动).{0,40}(?:已落地|审核通过|通过了|测试通过|eval|决定|锁定|改成|修复完成|完成啦|已经完成|保留为|不再)/i;

type ChatMemoryAi = {
  connection?: AiConnection;
  key: string;
};

export type ChatMemoryControllerOptions = {
  activeSessionRef: { current: string | null };
  ai: ChatMemoryAi;
  automaticExplicitFactMemories: boolean;
  getAutomaticExplicitFactMemories?: () => boolean;
  isActive?: () => boolean;
  onOrganizedThroughIdChange: (messageId: string) => void;
  onProactiveReviewedThroughIdChange: (messageId: string) => void;
  proactiveMemorySuggestions: boolean;
  messages: SubjectiveMessage[];
};

type ChatMemoryStateSetter<T> = (value: T | ((current: T) => T)) => void;
type ChatMemoryRef<T> = { current: T };

export type ChatMemoryControllerState = {
  flaggedRecallIds: Set<string>;
  setFlaggedRecallIds: ChatMemoryStateSetter<Set<string>>;
  latestMemoryDebug: MemoryBundleDebug | null;
  setLatestMemoryDebug: ChatMemoryStateSetter<MemoryBundleDebug | null>;
  latestMemoryRecall: MemoryRecallItem[] | null;
  setLatestMemoryRecall: ChatMemoryStateSetter<MemoryRecallItem[] | null>;
  latestMemoryRecallQuery: string;
  setLatestMemoryRecallQuery: ChatMemoryStateSetter<string>;
  memoryCandidates: MemoryCandidateReview[];
  memoryCandidateRemovalRevisionRef: ChatMemoryRef<number>;
  memoryOrganizationRevisionRef: ChatMemoryRef<number>;
  organizationAbortRef?: ChatMemoryRef<AbortController | null>;
  waitingOrganizationRef?: ChatMemoryRef<string | null>;
  setUnfinishedOrganization?: ChatMemoryStateSetter<boolean>;
  setMemoryCandidates: ChatMemoryStateSetter<MemoryCandidateReview[]>;
  currentStateCandidates: MemoryCurrentStateCandidate[];
  setCurrentStateCandidates: ChatMemoryStateSetter<MemoryCurrentStateCandidate[]>;
  currentStateResolveCandidates: MemoryCurrentStateResolveCandidate[];
  setCurrentStateResolveCandidates: ChatMemoryStateSetter<MemoryCurrentStateResolveCandidate[]>;
  memoryNotice: string | null;
  setMemoryNotice: ChatMemoryStateSetter<string | null>;
  organizing: boolean;
  setOrganizing: ChatMemoryStateSetter<boolean>;
  memoryNoticeTimerRef: ChatMemoryRef<ReturnType<typeof setTimeout> | null>;
  proactiveReviewingRef: ChatMemoryRef<boolean>;
  lastProactiveMemorySuggestionAtRef: ChatMemoryRef<number>;
  lastEpisodeMemoryAttemptAtRef: ChatMemoryRef<number>;
  lastEpisodeMemoryThroughIdRef: ChatMemoryRef<string | null>;
  lastWeeklyContextAttemptAtRef: ChatMemoryRef<number>;
  lastWeeklyContextThroughIdRef: ChatMemoryRef<string | null>;
  voiceCallCandidateBatchesSeenRef: ChatMemoryRef<Set<string>>;
  voiceCallOrganizationInFlightRef: ChatMemoryRef<Set<string>>;
};


function findMemoryCursorIndex(
  messages: SubjectiveMessage[],
  cursor: { throughCreatedAt: number; throughMessageId: string } | null,
) {
  if (!cursor) return -1;
  const exactIndex = messages.findIndex((message) => message.id === cursor.throughMessageId);
  if (exactIndex >= 0) return exactIndex;
  let index = -1;
  messages.forEach((message, messageIndex) => {
    if (message.createdAt <= cursor.throughCreatedAt) index = messageIndex;
  });
  return index;
}

function makeIngestionBatchInput(
  stream: MemoryIngestionStream,
  scopeKey: string,
  messages: SubjectiveMessage[],
  understandingMaterials?: UnderstandingMaterials,
) {
  const first = messages[0];
  const last = messages[messages.length - 1];
  const chatHash = makeMemoryIngestionSourceHash(messages);
  const sourceHash = understandingMaterials ? stableMemoryHash(JSON.stringify([chatHash, understandingMaterials.text,
    understandingMaterials.targets.map(memory => [memory.id, memory.understandingBasis]),
    understandingMaterials.memories.map(material => material.hash)])) : chatHash;
  return {
    advancesCursor: true,
    id: `memory-ingestion-${stream}-${stableMemoryHash(`${scopeKey}\u0000${sourceHash}`)}`,
    scopeKey,
    sessionId: scopeKey,
    sourceFirstAt: first?.createdAt,
    sourceFirstMessageId: first?.id,
    sourceHash,
    sourceLastAt: last?.createdAt,
    sourceLastMessageId: last?.id,
    stream,
  };
}

function selectMixedSourceBatch(chat: SubjectiveMessage[],
  source: Awaited<ReturnType<typeof nextObservationMaterials>>, reading: ReadingOrganizationWork, capacity: number,
  shiying?: ShiyingOrganizationWork, lifeSelf?: LifeSelfOrganizationWork) {
  const selected = [...chat.map(message => ({ time: message.createdAt, id: message.id, message })),
    ...source.eligibleSources.map(observation => ({ time: observation.capturedAt, id: observation.observationId, observation })),
    ...reading.eligibleSources.map(activity => ({ time: activity.availableAt, id: activity.activityId, activity })),
    ...(shiying?.eligibleSources ?? []).map(paper => ({ time: paper.availableAt, id: paper.recordId, paper })),
    ...(lifeSelf?.eligibleSources ?? []).map(self => ({ time: self.availableAt, id: self.id, self }))]
    .sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)).slice(0, capacity);
  const messages = selected.flatMap(value => 'message' in value ? [value.message] : []);
  const work = source.work ?? selected.flatMap(value => 'observation' in value
    ? [{ observationId: value.observation.observationId, sourceHash: value.observation.sourceHash }] : []);
  const ids = new Set(work.map(value => value.observationId));
  return { messages, observations: source.materials.filter(value => ids.has(value.binding.observationId)), work,
    readingWork: selected.flatMap(value => 'activity' in value ? [value.activity] : []),
    shiyingWork: selected.flatMap(value => 'paper' in value ? [value.paper] : []),
    lifeSelfWork: selected.flatMap(value => 'self' in value ? [value.self] : []) };
}

async function prepareMixedSourceBatch(chat: SubjectiveMessage[],
  observations: Awaited<ReturnType<typeof nextObservationMaterials>>, reading: ReadingOrganizationWork, capacity: number,
  shiying?: ShiyingOrganizationWork, lifeSelf?: LifeSelfOrganizationWork, sessionId = '') {
  const initial = selectMixedSourceBatch(chat, observations, reading, capacity, shiying, lifeSelf);
  const selfMaterials = lifeSelf ? await prepareLifeSelfOrganizationMaterials(lifeSelf,
    initial.lifeSelfWork.map(value => value.id), sessionId, initial.messages.map(message => message.content).join('\n')) : [];
  const prepared = await prepareReadingOrganizationMaterials(reading, initial.readingWork.map(value => value.activityId));
  const paper = shiying ? await prepareShiyingOrganizationMaterials(shiying, initial.shiyingWork.map(value => value.recordId)) : { materials: [] as PreparedShiyingOrganizationMaterial[], blockedSources: [] };
  const availableIds = new Set(prepared.materials.map(value => value.binding.activityId));
  // A blocked reading must not consume a slot or cause 29 actual units to be sent as 30.
  const selected = selectMixedSourceBatch(chat, observations, { ...reading,
    eligibleSources: reading.eligibleSources.filter(value => availableIds.has(value.activityId)) }, capacity,
    shiying ? { ...shiying, eligibleSources: shiying.eligibleSources.filter(value => paper.materials.some(material => material.snapshot.recordId === value.recordId)) } : undefined,
    lifeSelf ? { ...lifeSelf, eligibleSources: lifeSelf.eligibleSources.filter(value => selfMaterials.some(material => material.source.kind === 'exploration' && material.source.id === value.id)) } : undefined);
  const selectedIds = new Set(selected.readingWork.map(value => value.activityId));
  return { ...selected, readings: prepared.materials.filter(value => selectedIds.has(value.binding.activityId)),
    lifeSelf: selfMaterials.filter(material => material.source.kind === 'wish' || selected.lifeSelfWork.some(value => value.id === material.source.id)),
    lifeSelfDeferredCount: selfMaterials.some(material => material.source.kind === 'exploration')
      ? initial.lifeSelfWork.filter(value => value.countAsNew).length - selected.lifeSelfWork.filter(value => value.countAsNew).length : 0,
    shiying: paper.materials.filter(material => selected.shiyingWork.some(value => value.recordId === material.snapshot.recordId)),
    readingNotice: prepared.blockedSources.length ? '阅读材料过长且没有可用分界，暂未整理，原文和进度保留。'
      : reading.unavailableSources.length ? '阅读原件或对应原卡需要核对，未处理的材料仍保留。'
        : reading.blockedActivities.length ? '这场阅读还有待确认稿，后续材料已保留。'
          : paper.blockedSources.length ? '拾荧纸条材料过长且没有可用分界，暂未整理，原文和进度保留。'
            : shiying?.unavailableSources.length ? '拾荧原件或对应原卡需要核对，未处理的材料仍保留。'
              : shiying?.blockedRecords.length ? '这张拾荧纸条还有待确认稿，后续材料已保留。' : undefined };
}

async function restoreShiyingMaterials(bindings: readonly ShiyingMemoryBinding[], sessionId: string) {
  const records = [...new Set(bindings.map(binding => binding.recordId))];
  return Promise.all(records.map(id => restoreShiyingOrganizationMaterial(bindings.filter(binding => binding.recordId === id), sessionId)));
}
function attachShiyingBatch(base: MemoryIngestionBatchInput, materials: PreparedShiyingOrganizationMaterial[], work: ShiyingWorkSource[]) {
  if (!materials.length) return base;
  return { ...base, advancesCursor: !!base.sourceLastMessageId,
    id: `${base.id}-${stableMemoryHash(JSON.stringify(materials.map(material => material.batch.id)))}`,
    workMetadata: { ...(base.workMetadata ?? { version: 1 as const, workId: base.id, messageIds: [] }),
      shiying: materials.flatMap(material => material.bindings), shiyingWork: work } };
}

function attachObservationBatch(base: MemoryIngestionBatchInput, observations: PreparedObservationMaterial[],
  work: ObservationWorkSource[]) {
  if (!observations.length) return base;
  return { ...base, advancesCursor: !!base.sourceLastMessageId,
    id: `${base.id}-${stableMemoryHash(JSON.stringify(observations.map(value => value.batch.id)))}`,
    workMetadata: { ...(base.workMetadata ?? { version: 1 as const, workId: base.id, messageIds: [] }),
      observations: observations.map(value => value.binding), observationWork: work } };
}

function attachReadingBatch(base: MemoryIngestionBatchInput, readings: PreparedReadingOrganizationMaterial[],
  work: ReadingWorkSource[]) {
  if (!readings.length) return base;
  return { ...base, advancesCursor: !!base.sourceLastMessageId,
    id: `${base.id}-${stableMemoryHash(JSON.stringify(readings.map(value => value.batch.id)))}`,
    workMetadata: { ...(base.workMetadata ?? { version: 1 as const, workId: base.id, messageIds: [] }),
      readings: readings.map(value => value.binding), readingWork: work } };
}

export function createChatMemoryController({
  activeSessionRef,
  ai,
  automaticExplicitFactMemories,
  getAutomaticExplicitFactMemories,
  isActive,
  onOrganizedThroughIdChange,
  onProactiveReviewedThroughIdChange,
  proactiveMemorySuggestions,
  messages,
}: ChatMemoryControllerOptions, runtimeState: ChatMemoryControllerState) {
  const {
    flaggedRecallIds, setFlaggedRecallIds,
    latestMemoryDebug, setLatestMemoryDebug,
    latestMemoryRecall, setLatestMemoryRecall,
    latestMemoryRecallQuery, setLatestMemoryRecallQuery,
    memoryCandidates, setMemoryCandidates,
    currentStateCandidates, setCurrentStateCandidates,
    currentStateResolveCandidates, setCurrentStateResolveCandidates,
    memoryNotice, setMemoryNotice,
    organizing, setOrganizing,
    memoryNoticeTimerRef,
    proactiveReviewingRef,
    lastProactiveMemorySuggestionAtRef,
    lastEpisodeMemoryAttemptAtRef,
    lastEpisodeMemoryThroughIdRef,
    lastWeeklyContextAttemptAtRef,
    lastWeeklyContextThroughIdRef,
    voiceCallCandidateBatchesSeenRef,
    voiceCallOrganizationInFlightRef,
  } = runtimeState;

  const organizerReady = hasMemoryOrganizerConfig(ai);
  const candidateUiRevision = () => runtimeState.memoryCandidateRemovalRevisionRef.current;
  const candidateUiIsCurrent = (sessionId: string | null, revision: number) =>
    activeSessionRef.current === sessionId && candidateUiRevision() === revision;
  const organizationIsCurrent = (sessionId: string, revision: number) =>
    activeSessionRef.current === sessionId && runtimeState.memoryOrganizationRevisionRef.current === revision;
  const sourceMessagesAreCurrent = async (sessionId: string, sourceMessages: SubjectiveMessage[]) => {
    const { hasChatSessionMessage, loadChatSessionMessage } = await import('../chat/chatStorage');
    const current = await Promise.all(sourceMessages.map(async message =>
      await hasChatSessionMessage(sessionId, message.id) ? loadChatSessionMessage(sessionId, message.id) : null));
    return current.every(Boolean) && makeMemoryIngestionSourceHash(current.map(item => item!))
      === makeMemoryIngestionSourceHash(sourceMessages);
  };

  const showTransientMemoryNotice = (message: string, duration = 1500) => {
    setMemoryNotice(message);
    if (memoryNoticeTimerRef.current) clearTimeout(memoryNoticeTimerRef.current);
    memoryNoticeTimerRef.current = setTimeout(() => setMemoryNotice(null), duration);
  };

  const syncIngestionCursorMirror = async (batchId: string) => {
    const batch = await loadMemoryIngestionBatch(batchId);
    if (!batch || !['ready', 'resolved', 'no_value', 'stale'].includes(batch.status)) return;
    const cursor = await loadMemoryIngestionCursor(batch.scopeKey, batch.stream);
    if (!cursor) return;
    if (batch.stream === 'manual_digest' || batch.stream === 'proactive') {
      const manualCursor = await loadMemoryIngestionCursor(batch.scopeKey, 'manual_digest');
      if (manualCursor) onOrganizedThroughIdChange(manualCursor.throughMessageId);
      const proactiveCursor = await loadMemoryIngestionCursor(batch.scopeKey, 'proactive');
      if (proactiveCursor) onProactiveReviewedThroughIdChange(proactiveCursor.throughMessageId);
    }
    if (batch.stream === 'proactive') onProactiveReviewedThroughIdChange(cursor.throughMessageId);
    if (batch.stream === 'episode') lastEpisodeMemoryThroughIdRef.current = cursor.throughMessageId;
    if (batch.stream === 'weekly') lastWeeklyContextThroughIdRef.current = cursor.throughMessageId;
  };

  const seedLegacyIngestionCursor = async (
    scopeKey: string,
    stream: MemoryIngestionStream,
    legacy: { createdAt: number; id: string } | null,
  ) => {
    const existing = await loadMemoryIngestionCursor(scopeKey, stream);
    if (existing || !legacy) return existing;
    return seedMemoryIngestionCursor({
      scopeKey,
      stream,
      throughCreatedAt: legacy.createdAt,
      throughMessageId: legacy.id,
    });
  };

  const registerCandidateBatch = async (
    batchIds: string | string[],
    allCandidates: MemoryCandidateReview[],
    acceptedCandidates: MemoryCandidateReview[],
    canCommit?: () => boolean,
  ) => {
    const ids = Array.from(new Set(Array.isArray(batchIds) ? batchIds : [batchIds]));
    const acceptedKeys = new Set(acceptedCandidates.map(makeMemoryCandidateKey));
    const allKeys = allCandidates.map(makeMemoryCandidateKey);
    const sourceBatches = new Map((await Promise.all(ids.map(loadMemoryIngestionBatch))).filter((batch): batch is NonNullable<typeof batch> => !!batch).map(batch => [batch.id, batch]));
    const queued = acceptedCandidates.map((candidate) => ({
      ...candidate,
      ingestionRefs: [
        ...(candidate.ingestionRefs ?? []),
        ...ids.filter(batchId => sourceBatches.get(batchId)?.scopeKey !== 'shiying-record'
          || candidate.shiyingBindings?.some(binding => sourceBatches.get(batchId)?.workMetadata?.shiying?.some(source =>
            source.sessionId === binding.sessionId && source.messageId === binding.messageId && source.sentHash === binding.sentHash)))
          .map((batchId) => ({ batchId, itemKey: makeMemoryCandidateKey(candidate) })),
      ] satisfies MemoryIngestionItemRef[],
    }));
    for (const batchId of ids.slice(0, 1)) {
      const outcome = await registerMemoryIngestionOutcome({
        batchId,
        additionalBatchIds: ids.slice(1),
        canCommit,
        pendingItemKeys: Array.from(acceptedKeys),
        suppressedItemKeys: allKeys.filter((key) => !acceptedKeys.has(key)),
        pendingCandidates: queued.map((candidate) => ({
          itemKey: makeMemoryCandidateKey(candidate), candidateJson: JSON.stringify(candidate),
        })),
      });
      if (!outcome || outcome.status === 'stale') throw new Error('MEMORY_SOURCE_CHANGED');
    }
    const pending = await loadPendingMemoryCandidates({ batchIds: ids });
    return pending;
  };

  const appendCandidates = (candidates: MemoryCandidateReview[]) => {
    setMemoryCandidates((current) => appendMemoryCandidateReviews(current, candidates));
  };

  const appendCurrentStateCandidates = async (candidates: MemoryCurrentStateCandidate[]) => {
    const sessionId = activeSessionRef.current;
    if (!sessionId || !candidates.length) return;
    const revision = candidateUiRevision();
    const epoch = captureBackupRestoreDataEpoch();
    await queueCurrentStateReviews(sessionId, candidates);
    const pending = await loadPendingCurrentStateReviews(sessionId);
    if (candidateUiIsCurrent(sessionId, revision) && canCommitBackupRestoreDataEpoch(epoch)) {
      setCurrentStateCandidates(pending.currentStateCandidates);
    }
  };

  const processVoiceCallMemoryCandidates = () => {
    const sessionId = activeSessionRef.current;
    if (!sessionId) return;
    const revision = candidateUiRevision();
    const epoch = captureBackupRestoreDataEpoch();
    messages.forEach(message => {
      const record = message.voiceCallRecord;
      if (!record?.memoryOrganization?.segments.some(segment => segment.candidateStatus === 'cached')
        || isVoiceCallMemoryOrganizationRunning(record.callId)) return;
      const key = stableMemoryHash(JSON.stringify(record.memoryOrganization));
      if (voiceCallCandidateBatchesSeenRef.current.has(key)) return;
      voiceCallCandidateBatchesSeenRef.current.add(key);
      let expectedRecordHash = voiceCallRecordVersion(record);
      void recoverVoiceCallMemoryResults(record, { dataEpoch: epoch, saveRecord: async next => {
        const saved = await upsertVoiceCallRecord(next, sessionId, { dataEpoch: epoch, expectedRecordHash });
        if (saved) expectedRecordHash = voiceCallRecordVersion(next);
        return !!saved;
      } }).then(async () => {
        const pending = await loadPendingMemoryCandidates({ sessionId });
        if (candidateUiIsCurrent(sessionId, revision) && canCommitBackupRestoreDataEpoch(epoch)) appendCandidates(pending.filter(item => item.origin === 'voice_call'));
      }).catch(() => { voiceCallCandidateBatchesSeenRef.current.delete(key); });
    });
    void loadPendingMemoryCandidates({ sessionId }).then(pending => {
      if (candidateUiIsCurrent(sessionId, revision) && canCommitBackupRestoreDataEpoch(epoch)) {
        appendCandidates(pending.filter(candidate => candidate.origin === 'voice_call'));
      }
    }).catch(() => undefined);
  };

  const clearSessionMemoryState = () => {
    if (runtimeState.waitingOrganizationRef) runtimeState.waitingOrganizationRef.current = null;
    runtimeState.organizationAbortRef?.current?.abort();
    if (runtimeState.organizationAbortRef) runtimeState.organizationAbortRef.current = null;
    proactiveReviewingRef.current = false;
    setOrganizing(false);
    runtimeState.memoryOrganizationRevisionRef.current += 1;
    setMemoryCandidates([]);
    setCurrentStateCandidates([]);
    setCurrentStateResolveCandidates([]);
    setLatestMemoryRecall(null);
    setLatestMemoryRecallQuery('');
    setLatestMemoryDebug(null);
    setFlaggedRecallIds(new Set());
    setMemoryNotice(null);
  };

  const setLatestRecallFromCognition = ({
    debug,
    items,
    query,
  }: {
    debug?: MemoryBundleDebug | null;
    items: MemoryRecallItem[];
    query: string;
  }) => {
    setLatestMemoryRecall(items);
    setLatestMemoryRecallQuery(query);
    setLatestMemoryDebug(debug ?? null);
    setFlaggedRecallIds(new Set());
  };

  const applyFeedbackFromUser = async (text: string) => {
    await Promise.allSettled([
      applyMemorySurfacingFeedbackFromUser(latestMemoryRecall, text),
      applyMemoryCalibrationFeedbackFromUser(latestMemoryRecall, text, { query: latestMemoryRecallQuery }),
    ]);
  };

  const flagRecallAsIrrelevant = async (item: MemoryRecallItem) => {
    if (!latestMemoryRecallQuery.trim()) {
      showTransientMemoryNotice('这一轮没有可记录的召回语境。', 1800);
      return;
    }
    try {
      await createMemoryRecallFeedback({
        kind: 'irrelevant',
        memoryId: item.memory.id,
        query: latestMemoryRecallQuery,
        reason: item.reason,
        score: item.score,
        sources: item.sources,
      });
      setFlaggedRecallIds((current) => {
        const next = new Set(current);
        next.add(item.memory.id);
        return next;
      });
      showTransientMemoryNotice('已经记下：这条在相似语境里会少想起。', 2200);
    } catch {
      showTransientMemoryNotice('这次纠偏没有保存成功。', 2200);
    }
  };

  const saveCandidate = async (candidate: MemoryCandidateReview, _index: number) => {
    if (candidate.currentStateReview) {
      await saveCurrentStateReview(candidate);
      setMemoryCandidates(current => current.filter(item => item.reviewId !== candidate.reviewId));
      await Promise.allSettled([...new Set((candidate.ingestionRefs ?? []).map(ref => ref.batchId))].map(syncIngestionCursorMirror));
      return;
    }
    if (candidate.continuationReview) {
      await saveConversationMemoryCandidate(candidate);
      setMemoryCandidates(current => current.filter(item => item.reviewId !== candidate.reviewId));
      await Promise.allSettled([...new Set((candidate.ingestionRefs ?? []).map(ref => ref.batchId))].map(syncIngestionCursorMirror));
      return;
    }
    if (candidate.understandingSubject) {
      await saveUnderstandingCandidate(candidate);
      setMemoryCandidates(current => current.filter(item => item.reviewId !== candidate.reviewId));
      showTransientMemoryNotice(`认识已保存：${candidate.title}。可在记忆「全部」中查看。`, 4200);
      await Promise.allSettled(Array.from(new Set((candidate.ingestionRefs ?? []).map(ref => ref.batchId))).map(syncIngestionCursorMirror));
      return;
    }
    if (candidate.source === 'weekly-context') {
      await saveWeeklyCandidate(candidate);
      setMemoryCandidates(current => current.filter(item => item.reviewId !== candidate.reviewId));
      return;
    }
    await runMemoryCandidateSave(candidate, (stored, dataEpoch) => createMemory({ ...stored }, {
      confirmationLevel: 'reviewed',
      continuationAi: organizerReady
        ? { apiKey: ai.key, connection: ai.connection! }
        : undefined,
      ingestionResolutions: stored.ingestionRefs, requirePendingIngestion: !!stored.ingestionRefs?.length, dataEpoch,
      ingestionExpectedCandidate: { reviewId: stored.reviewId, editableHash: memoryCandidateEditableHash(stored) },
      sourceRefs: stored.sourceRefs,
      sourceTraceMode: stored.sourceRefs?.length ? 'exact' : 'none',
    }));
    setMemoryCandidates((current) => current.filter((item) => item.reviewId !== candidate.reviewId));
    await Promise.allSettled(Array.from(new Set((candidate.ingestionRefs ?? []).map((ref) => ref.batchId)))
      .map(syncIngestionCursorMirror));
  };

  const discardCandidate = async (reviewId: string) => {
    const candidate = memoryCandidates.find((item) => item.reviewId === reviewId);
    if (!candidate) return;
    if (candidate.understandingSubject) {
      await discardUnderstandingCandidate(candidate);
      setMemoryCandidates(current => current.filter(item => item.reviewId !== reviewId));
      await Promise.all(Array.from(new Set((candidate.ingestionRefs ?? []).map(ref => ref.batchId))).map(syncIngestionCursorMirror));
      return;
    }
    if (candidate.source === 'weekly-context') {
      await discardWeeklyRefreshCandidate(candidate);
      setMemoryCandidates(current => current.filter(item => item.reviewId !== reviewId));
      return;
    }
    if (candidate.ingestionRefs?.length) {
      await resolveMemoryIngestionItems(candidate.ingestionRefs, 'discarded', {
        expectedCandidate: { reviewId: candidate.reviewId,
          editableHash: candidate[memoryCandidateEditSession]?.hash ?? memoryCandidateEditableHash(candidate) },
      });
    }
    setMemoryCandidates((current) => current.filter((item) => item.reviewId !== reviewId));
    await Promise.all(Array.from(new Set((candidate.ingestionRefs ?? []).map((ref) => ref.batchId)))
      .map(syncIngestionCursorMirror));
  };

  const saveCurrentStateCandidate = async (candidate: MemoryCurrentStateCandidate) => {
    const sessionId = activeSessionRef.current;
    const revision = candidateUiRevision();
    try {
      const checked = await recheckCurrentStateCandidate(candidate);
      if (!sessionId || !candidateUiIsCurrent(sessionId, revision)) return;
      runtimeState.memoryCandidateRemovalRevisionRef.current += 1;
      setCurrentStateCandidates((current) => current.filter((item) => item.reviewId !== candidate.reviewId));
      appendCandidates([checked]);
      showTransientMemoryNotice('近况已重新核对，请查看新的待确认稿。', 2200);
    } catch (error) { if (sessionId && candidateUiIsCurrent(sessionId, revision)) showTransientMemoryNotice(error instanceof Error ? error.message : '近况未能重新核对，草稿已保留。', 3200); }
  };

  const discardCurrentStateCandidate = async (reviewId: string) => {
    const candidate = currentStateCandidates.find((item) => item.reviewId === reviewId);
    if (!candidate) return;
    try {
      await discardCurrentStateReview(candidate);
      runtimeState.memoryCandidateRemovalRevisionRef.current += 1;
      setCurrentStateCandidates((current) => current.filter((item) => item.reviewId !== reviewId));
    } catch { showTransientMemoryNotice('状态小卡暂未舍弃，请稍后重试。', 2400); }
  };

  const saveCurrentStateResolveCandidate = async (candidate: MemoryCurrentStateResolveCandidate) => {
    const sessionId = activeSessionRef.current;
    const revision = candidateUiRevision();
    try {
      const checked = await recheckCurrentStateCandidate(candidate);
      if (!sessionId || !candidateUiIsCurrent(sessionId, revision)) return;
      runtimeState.memoryCandidateRemovalRevisionRef.current += 1;
      setCurrentStateResolveCandidates((current) => current.filter((item) => item.reviewId !== candidate.reviewId));
      appendCandidates([checked]);
      showTransientMemoryNotice('近况已重新核对，请查看新的待确认稿。', 2200);
    } catch (error) { if (sessionId && candidateUiIsCurrent(sessionId, revision)) showTransientMemoryNotice(error instanceof Error ? error.message : '近况未能重新核对，草稿已保留。', 3200); }
  };

  const discardCurrentStateResolveCandidate = async (reviewId: string) => {
    const candidate = currentStateResolveCandidates.find((item) => item.reviewId === reviewId);
    if (!candidate) return;
    try {
      await discardCurrentStateReview(candidate);
      runtimeState.memoryCandidateRemovalRevisionRef.current += 1;
      setCurrentStateResolveCandidates((current) => current.filter((item) => item.reviewId !== reviewId));
    } catch { showTransientMemoryNotice('状态结束建议暂未舍弃，请稍后重试。', 2400); }
  };

  const organizeMessageBatch = async (
    newMessages: SubjectiveMessage[],
    mode: 'new' | 'selected',
    legacyCursor: { createdAt: number; id: string } | null = null,
    work?: { batch: MemoryIngestionBatchInput; owner: AbortController },
  ) => {
    if (organizing || !organizerReady || proactiveReviewingRef.current
      || (!work && runtimeState.organizationAbortRef?.current)) return { status: 'skipped' as const };
    const sourceSessionId = activeSessionRef.current;
    if (!sourceSessionId) return { status: 'skipped' as const };
    const dataEpoch = captureBackupRestoreDataEpoch();
    const uiRevision = runtimeState.memoryOrganizationRevisionRef.current;
    const owner = work?.owner ?? new AbortController();
    const requestRef = runtimeState.organizationAbortRef ??= { current: null };
    requestRef.current = owner;
    proactiveReviewingRef.current = true;
    setOrganizing(true);
    let batchId: string | null = null;
    let committed = false;
    const timingStartedAt = Date.now();
    try {
      newMessages = newMessages.filter(message => !isLetterChatCopy(message) && !message.voiceCallRecord);
      let letter: PreparedLetterMaterial | undefined;
      let observations: PreparedObservationMaterial[] = [];
      let observationWork: ObservationWorkSource[] = [];
      let readings: PreparedReadingOrganizationMaterial[] = [];
      let readingWork: ReadingWorkSource[] = [];
      let shiying: PreparedShiyingOrganizationMaterial[] = [];
      let shiyingWork: ShiyingWorkSource[] = [];
      let lifeSelf: PreparedLifeSelfOrganizationMaterial[] = [];
      let lifeSelfWork: LifeSelfWorkSource[] = [];
      let readingNotice: string | undefined;
      let sourceMessages = newMessages.slice(0, MANUAL_DIGEST_BATCH_SIZE);
      let retry: Awaited<ReturnType<typeof loadChatMemoryIngestionProgress>>['retry'] = null;
      if (mode === 'new') {
        const progressCommit = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          await seedLegacyIngestionCursor(sourceSessionId, 'manual_digest', legacyCursor);
          return loadChatMemoryIngestionProgress(sourceSessionId);
        });
        if (!progressCommit.committed) return { status: 'skipped' as const };
        const progress = progressCommit.value;
        const cursor = progress.cursor;
        retry = progress.retry ?? await loadObservationOrganizationRetry(sourceSessionId)
          ?? await loadReadingOrganizationRetry(sourceSessionId) ?? await loadShiyingOrganizationRetry(sourceSessionId)
          ?? await loadLifeSelfOrganizationRetry(sourceSessionId);
        if (retry?.workMetadata?.lifeSelfBindings?.length && !retry.itemCount
          && !(await Promise.all(retry.workMetadata.lifeSelfBindings.map(binding => validateLifeSelfBinding(binding)))).every(Boolean)) {
          await runBackupRestoreDataEpochCommit(dataEpoch, () => retireChangedMemoryExtraction(retry!.id)); retry = null;
        }
        if (retry?.workMetadata?.letter && !(await validateLetterBinding(retry.workMetadata.letter)) && !retry.itemCount) {
          const { retireChangedLetterExtraction } = await import('./memoryIngestionService');
          await runBackupRestoreDataEpochCommit(dataEpoch, () => retireChangedLetterExtraction(retry!.id));
          retry = null;
        }
        if (retry?.workMetadata?.readings?.length && !retry.itemCount
          && !(await Promise.all(retry.workMetadata.readings.map(binding => validateReadingOrganizationBinding(binding)))).every(Boolean)) {
          await runBackupRestoreDataEpochCommit(dataEpoch, () => retireChangedMemoryExtraction(retry!.id));
          retry = null;
        }
        if (retry?.workMetadata?.shiying?.length && !retry.itemCount
          && !(await Promise.all(retry.workMetadata.shiying.map(binding => validateShiyingMemoryBinding(binding)))).every(Boolean)) {
          await runBackupRestoreDataEpochCommit(dataEpoch, () => retireChangedMemoryExtraction(retry!.id)); retry = null;
        }
        if (retry?.workMetadata?.letter) letter = await restoreLetterMaterial(retry.workMetadata.letter, sourceSessionId);
        else if (!retry) {
          const next = await nextLetterMaterial(sourceSessionId); letter = next.material;
          if (next.blockedSentence) showTransientMemoryNotice('信件单句过长，暂未整理', 4200);
        }
        const cursorIndex = findMemoryCursorIndex(newMessages, cursor);
        sourceMessages = newMessages.slice(cursorIndex + 1, cursorIndex + 1 + MANUAL_DIGEST_BATCH_SIZE - (letter ? 1 : 0));
        if (retry) {
          if (retry.workMetadata?.messageIds) {
            const { loadChatSessionMessage } = await import('../chat/chatStorage');
            const originals = await Promise.all(retry.workMetadata.messageIds.map(id => loadChatSessionMessage(sourceSessionId, id)));
            if (originals.some(value => !value)) throw new Error('MEMORY_SOURCE_CHANGED');
            sourceMessages = originals as SubjectiveMessage[];
          } else {
            const end = sourceMessages.findIndex(message => message.id === retry!.sourceLastMessageId);
            if (end >= 0) sourceMessages = sourceMessages.slice(0, end + 1);
          }
          observations = await Promise.all((retry.workMetadata?.observations ?? []).map(binding => restoreObservationMaterial(binding, sourceSessionId)));
          observationWork = retry.workMetadata?.observationWork ?? observations.map(value => value.binding);
          readings = await Promise.all((retry.workMetadata?.readings ?? []).map(binding => restoreReadingOrganizationMaterial(binding, sourceSessionId)));
          readingWork = retry.workMetadata?.readingWork ?? [];
          shiying = await restoreShiyingMaterials(retry.workMetadata?.shiying ?? [], sourceSessionId);
          shiyingWork = retry.workMetadata?.shiyingWork ?? [];
          lifeSelf = await restoreLifeSelfOrganizationMaterials(retry.workMetadata?.lifeSelfBindings ?? [], sourceSessionId);
          lifeSelfWork = retry.workMetadata?.lifeSelfWork ?? [];
        } else {
          const prepared = await nextObservationMaterials({ sessionId: sourceSessionId, limit: MANUAL_DIGEST_BATCH_SIZE - (letter ? 1 : 0) });
          const reading = await nextReadingOrganizationWork({ sessionId: sourceSessionId });
          const paper = await nextShiyingOrganizationWork({ sessionId: sourceSessionId });
          const self = await nextLifeSelfOrganizationWork();
          const selected = await prepareMixedSourceBatch(newMessages.slice(cursorIndex + 1), prepared, reading,
            MANUAL_DIGEST_BATCH_SIZE - (letter ? 1 : 0), paper, self, sourceSessionId);
          sourceMessages = selected.messages;
          observations = selected.observations;
          observationWork = selected.work;
          readings = selected.readings;
          readingWork = selected.readingWork;
          shiying = selected.shiying; shiyingWork = selected.shiyingWork;
          lifeSelf = selected.lifeSelf; lifeSelfWork = selected.lifeSelfWork;
          readingNotice = selected.readingNotice;
        }
      }
      if (mode === 'selected' && work?.batch.workMetadata?.letter) letter = await restoreLetterMaterial(work.batch.workMetadata.letter, sourceSessionId);
      if (!sourceMessages.length && !letter && !observations.length && !readings.length && !shiying.length && !lifeSelf.length) {
        const removalRevision = candidateUiRevision();
        const pending = await loadPendingMemoryCandidates({ sessionId: sourceSessionId });
        if (!organizationIsCurrent(sourceSessionId, uiRevision) || !candidateUiIsCurrent(sourceSessionId, removalRevision)
          || !canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'skipped' as const };
        appendCandidates(pending);
        if (readingNotice) showTransientMemoryNotice(readingNotice, 4200);
        return { generated: pending.length, remaining: 0, status: readingNotice ? 'waiting' as const : 'done' as const };
      }
      const lastOrganizedMessage = sourceMessages[sourceMessages.length - 1];
      const chatMaterials = mode === 'selected' ? sourceMessages
        : await filterUnreviewedChatMemoryMessages(sourceSessionId, sourceMessages);
      const materialMessages = [...chatMaterials, ...(letter ? [letter.message] : []), ...readings.map(value => value.message), ...shiying.flatMap(value => value.messages), ...lifeSelf.map(value => value.message)];
      if (!(await Promise.all(readings.map(value => validateReadingOrganizationBinding(value.binding, value.message)))).every(Boolean)) {
        throw new Error('MEMORY_SOURCE_CHANGED');
      }
      if (letter) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(letter!.batch));
      for (const observation of observations) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(observation.batch));
      for (const reading of readings) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(reading.batch));
      for (const paper of shiying) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(paper.batch));
      for (const material of lifeSelf) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(material.batch));
      if (!organizationIsCurrent(sourceSessionId, uiRevision) || !canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'skipped' as const };
      {
        const sourceBase = makeIngestionBatchInput('manual_digest', sourceSessionId, sourceMessages);
        const base = sourceBase;
        const matchingRetry = !!retry && retry.sourceFirstMessageId === sourceMessages[0]?.id
          && retry?.sourceLastMessageId === lastOrganizedMessage?.id;
        const input = work?.batch ?? (matchingRetry ? retry! : !sourceMessages.length && letter && !observations.length && !readings.length && !shiying.length && !lifeSelf.length ? letter.batch : attachLifeSelfBatch(attachShiyingBatch(attachReadingBatch(attachObservationBatch({ ...base,
          id: letter ? `${base.id}-${letter.batch.id}` : base.id,
          workMetadata: { version: 1 as const, workId: base.id, messageIds: sourceMessages.map(message => message.id), ...(letter ? { letter: letter.binding } : {}) } }, observations, observationWork), readings, readingWork), shiying, shiyingWork), lifeSelf, lifeSelfWork));
        if (work && input.sourceHash !== sourceBase.sourceHash) throw new Error('MEMORY_SOURCE_CHANGED');
        batchId = input.id;
        const batchCommit = await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(input));
        if (!batchCommit.committed) return { status: 'skipped' as const };
        let existing = batchCommit.value;
        if (existing?.status === 'waiting') existing = await releaseMemoryIngestionBatchWaiting(input.id);
        if (existing?.status === 'waiting') {
          const waitingCandidates = await loadPendingMemoryCandidates({ batchIds: [input.id] });
          if (!organizationIsCurrent(sourceSessionId, uiRevision) || owner.signal.aborted
            || !canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'stopped' as const };
          appendCandidates(waitingCandidates);
          showTransientMemoryNotice('这一批正在等原稿处理或重新核对，后续原话尚未结清。', 4200);
          return { status: 'waiting' as const };
        }
        if (existing?.status === 'resolved' || existing?.status === 'no_value') {
          await syncIngestionCursorMirror(input.id).catch(() => undefined);
          return {
            generated: 0,
            remaining: Math.max(0, newMessages.length - sourceMessages.length),
            status: 'done' as const,
          };
        }
        const removalRevision = candidateUiRevision();
        const pending = await loadPendingMemoryCandidates({ batchIds: [input.id] });
        if (pending.length) {
          if (!organizationIsCurrent(sourceSessionId, uiRevision) || !candidateUiIsCurrent(sourceSessionId, removalRevision)
            || !canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'skipped' as const };
          appendCandidates(pending);
          return { generated: pending.length, remaining: mode === 'new'
            ? Math.max(0, newMessages.length - sourceMessages.length) : 0, status: 'done' as const };
        }
      }
      if (!organizationIsCurrent(sourceSessionId, uiRevision) || !canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'skipped' as const };
      const sourceIndex = messages.findIndex(message => message.id === materialMessages[0]?.id);
      const understandingMaterials = await prepareUnderstandingMaterials({ sessionId: sourceSessionId,
        messages: materialMessages, recalledIds: latestMemoryRecall?.map(item => item.memory.id),
        letterBindings: letter ? [letter.binding] : undefined,
        observationMaterials: observations,
        readingMaterials: mode === 'new' ? readings : undefined,
        shiyingMaterials: mode === 'new' ? shiying : undefined,
        lifeSelfMaterials: mode === 'new' ? lifeSelf : undefined,
        readingCorrectionTargetIds: readings.flatMap(value => value.correctionTargetIds),
        continuationEnabled: true, signal: owner.signal,
        contextMessages: sourceIndex > 0 ? messages.slice(Math.max(0, sourceIndex - 2), sourceIndex) : [] });
      const pendingTargets = await loadPendingMemoryCandidates({ sessionId: sourceSessionId });
      if (!organizationIsCurrent(sourceSessionId, uiRevision) || owner.signal.aborted
        || !canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'stopped' as const };
      const targetIds = new Set([...(understandingMaterials.episodeTargetIds ?? []), ...understandingMaterials.targets.map(item => item.id),
        ...(understandingMaterials.currentStates ?? []).map(item => `current_state:${item.id}`),
        ...readings.flatMap(value => value.correctionTargetIds)]);
      const blockers = [...new Set(pendingTargets.map(memoryCandidateTargetKey)
        .filter((id): id is string => !!id && targetIds.has(id)))];
      if (blockers.length && batchId) {
        const waiting = await runBackupRestoreDataEpochCommit(dataEpoch, async () =>
          organizationIsCurrent(sourceSessionId, uiRevision) && !owner.signal.aborted
            ? updateMemoryIngestionBatchWaiting(batchId!, { reason: 'pending_target', targetMemoryIds: blockers }) : undefined);
        if (!waiting.committed || owner.signal.aborted || !organizationIsCurrent(sourceSessionId, uiRevision)) return { status: 'stopped' as const };
        showTransientMemoryNotice('相关旧稿还没处理，这一批和后续原话先留下。', 4200);
        return { status: 'waiting' as const };
      }
      const modelStartedAt = Date.now();
      const candidates = materialMessages.length || observations.length ? await runMemoryOrganizerRequestWithDeadline(signal => organizeConversationMemories({
        apiKey: ai.key,
        connection: ai.connection!,
        messages: materialMessages,
        understandingMaterials,
        episodeSummaryEnabled: true,
        chatFactualityEnabled: true,
        signal,
      }), { signal: owner.signal, timeoutMs: 60_000 }) : [];
      const modelCompletedAt = Date.now();
      if (!organizationIsCurrent(sourceSessionId, uiRevision) || !canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'skipped' as const };
      const reviewCandidates = makeReviewCandidates(candidates, 'digest', {
        messages: materialMessages,
        sessionId: sourceSessionId,
        sourceStartAt: sourceMessages[0]?.createdAt,
        sourceEndAt: lastOrganizedMessage?.createdAt,
      });
      const memoryLoadStartedAt = Date.now();
      const existingMemories = await loadMemories({ includeArchived: false, currentOnly: true }).catch(() => []);
      const memoryLoadedAt = Date.now();
      const direct = (candidate: MemoryCandidateReview) => !!candidate.currentStateReview || (!!candidate.continuationReview && (candidate.atomicKind === 'stage_conclusion' || !!candidate.continuationReview.targetMemoryId));
      const admitted = await annotateManualMemoryCandidates(reviewCandidates.filter(candidate => !candidate.understandingSubject && !direct(candidate)), { existingMemories });
      const ordinary = await annotateManualLongMemoryCandidates(admitted, { existingMemories });
      const annotated = reviewCandidates.flatMap(candidate => candidate.understandingSubject || direct(candidate) ? [candidate]
        : ordinary.filter(item => item.reviewId === candidate.reviewId));
      const admissionCompletedAt = Date.now();
      if (!organizationIsCurrent(sourceSessionId, uiRevision)) return { status: 'skipped' as const };
      const registration = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        if (!(await sourceMessagesAreCurrent(sourceSessionId, sourceMessages))
          || (letter && !(await validateLetterBinding(letter.binding)))
          || !(await Promise.all(observations.map(value => validateObservationBinding(value.binding)))).every(Boolean)
          || !(await Promise.all(readings.map(value => validateReadingOrganizationBinding(value.binding, value.message)))).every(Boolean)
          || !(await Promise.all(shiying.flatMap(value => value.bindings).map(binding => validateShiyingMemoryBinding(binding)))).every(Boolean)
          || !(await Promise.all(lifeSelf.map(value => validateLifeSelfBinding(value.binding, value.message)))).every(Boolean)
          || !organizationIsCurrent(sourceSessionId, uiRevision)) throw new Error('MEMORY_SOURCE_CHANGED');
        return batchId ? registerCandidateBatch([batchId, ...(letter ? [letter.batch.id] : []), ...observations.map(value => value.batch.id),
          ...readings.map(value => value.batch.id), ...shiying.map(value => value.batch.id), ...lifeSelf.map(value => value.batch.id)], annotated, annotated,
          () => organizationIsCurrent(sourceSessionId, uiRevision) && !owner.signal.aborted && canCommitBackupRestoreDataEpoch(dataEpoch)) : annotated;
      });
      if (!registration.committed) return { status: 'skipped' as const };
      const savedBatch = batchId ? await loadMemoryIngestionBatch(batchId) : null;
      committed = !!savedBatch && ['ready', 'resolved', 'no_value'].includes(savedBatch.status);
      const queued = registration.value;
      if (!organizationIsCurrent(sourceSessionId, uiRevision)) return { status: 'skipped' as const };
      if (batchId && !committed && savedBatch?.status !== 'waiting') throw new Error('MEMORY_SOURCE_CHANGED');
      appendCandidates(queued);
      if (savedBatch?.status === 'waiting') return { status: 'waiting' as const };
      if (batchId) await syncIngestionCursorMirror(batchId).catch(() => undefined);
      const completedAt = Date.now();
      console.info('[memory-organize-timing]', {
        admissionMs: admissionCompletedAt - memoryLoadedAt,
        candidateCount: candidates.length,
        ledgerAndUiMs: completedAt - admissionCompletedAt,
        memoryLoadMs: memoryLoadedAt - memoryLoadStartedAt,
        messageCount: sourceMessages.length,
        mode,
        modelMs: modelCompletedAt - modelStartedAt,
        setupMs: modelStartedAt - timingStartedAt,
        totalMs: completedAt - timingStartedAt,
      });
      const remaining = mode === 'new'
        ? Math.max(0, newMessages.length - sourceMessages.length)
        : 0;
      if (remaining > 0) showTransientMemoryNotice(`这一批整理了 ${sourceMessages.length} 条，还有 ${remaining} 条可继续整理。`, 3200);
      return { generated: queued.length, remaining, status: 'done' as const };
    } catch (error) {
      if (batchId && !committed) await runBackupRestoreDataEpochCommit(dataEpoch,
        () => markMemoryIngestionBatchFailed(batchId!)).catch(() => undefined);
      if (owner.signal.aborted) return { status: 'stopped' as const };
      const failure = classifyMemoryOrganizationFailure(error);
      console.warn('[memory-organize]', failure.technicalCode);
      return { failure, status: 'failed' as const };
    } finally {
      if (requestRef.current === owner) {
        setOrganizing(false);
        proactiveReviewingRef.current = false;
        if (!work) requestRef.current = null;
      }
    }
  };

  const stopOrganization = () => {
    if (runtimeState.waitingOrganizationRef) runtimeState.waitingOrganizationRef.current = null;
    runtimeState.memoryOrganizationRevisionRef.current += 1;
    runtimeState.organizationAbortRef?.current?.abort();
    if (runtimeState.organizationAbortRef) runtimeState.organizationAbortRef.current = null;
    proactiveReviewingRef.current = false;
    setOrganizing(false);
    showTransientMemoryNotice('整理已停止，已完成的小卡保留；未完成的部分可以继续。', 4200);
  };

  const runSelectedOrganization = async (selection?: SubjectiveMessage[], resumeWorkId?: string) => {
    if (organizing || proactiveReviewingRef.current || runtimeState.organizationAbortRef?.current) return { status: 'skipped' as const };
    if (!organizerReady) {
      showTransientMemoryNotice('还没有配置记忆整理模型。', 3000);
      return { status: 'skipped' as const };
    }
    const sessionId = activeSessionRef.current;
    if (!sessionId) return { status: 'skipped' as const };
    const requestRef = runtimeState.organizationAbortRef ??= { current: null };
    const owner = new AbortController();
    requestRef.current = owner;
    const epoch = captureBackupRestoreDataEpoch();
    let workId: string | undefined;
    let generated = 0;
    try {
      const restored = selection ? null : resumeWorkId ? await loadMemoryIngestionWork(sessionId, resumeWorkId)
        : await loadLatestUnfinishedMemoryIngestionWork(sessionId);
      const waitingRef = runtimeState.waitingOrganizationRef ??= { current: null };
      waitingRef.current = null;
      const ids = selection ? [...new Set(selection.filter(message => !isLetterChatCopy(message) && !message.voiceCallRecord).map(message => message.id))] : restored?.selectedMessageIds ?? [];
      workId = restored?.workId ?? `selected-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      if (!ids.length) return { status: 'done' as const, generated: 0, remaining: 0 };
      while (!owner.signal.aborted && activeSessionRef.current === sessionId && canCommitBackupRestoreDataEpoch(epoch)) {
        const current = await loadMemoryIngestionWork(sessionId, workId);
        const remaining = current?.remainingMessageIds ?? ids;
        if (!remaining.length) return { status: 'done' as const, generated, remaining: 0 };
        let next = current?.batches.find(batch => ['pending', 'failed', 'waiting'].includes(batch.status));
        if (next?.workMetadata?.letter && !next.itemCount && !(await validateLetterBinding(next.workMetadata.letter))) {
          const retired = await runBackupRestoreDataEpochCommit(epoch, () => retireChangedMemoryExtraction(next!.id));
          if (!retired.committed || owner.signal.aborted) return { status: 'stopped' as const };
          if (!retired.value) throw new Error('MEMORY_SOURCE_CHANGED');
          next = undefined;
        }
        const letter = next?.workMetadata?.letter ? await restoreLetterMaterial(next.workMetadata.letter, sessionId)
          : !next ? (await nextLetterMaterial(sessionId)).material : undefined;
        const batchIds = next?.workMetadata?.messageIds ?? remaining.slice(0, letter ? 29 : 30);
        const { loadChatSessionMessage } = await import('../chat/chatStorage');
        const source = await Promise.all(batchIds.map(id => loadChatSessionMessage(sessionId, id)));
        if (owner.signal.aborted || activeSessionRef.current !== sessionId || !canCommitBackupRestoreDataEpoch(epoch)) return { status: 'stopped' as const };
        if (source.some(message => !message)) throw new Error('MEMORY_SOURCE_CHANGED');
        const batchMessages = source as SubjectiveMessage[];
        const base = makeIngestionBatchInput('manual_digest', sessionId, batchMessages);
        if (next && !next.itemCount && next.sourceHash !== base.sourceHash) {
          const retired = await runBackupRestoreDataEpochCommit(epoch, () => retireChangedMemoryExtraction(next!.id));
          if (!retired.committed || owner.signal.aborted) return { status: 'stopped' as const };
          if (!retired.value) throw new Error('MEMORY_SOURCE_CHANGED');
          next = undefined;
        }
        const baseBatchId = `${workId}-${ids.indexOf(batchIds[0])}-${stableMemoryHash(JSON.stringify([base.sourceHash, letter?.binding]))}`;
        // Returning to an earlier wording must not reuse its retired extraction.
        const freshBatchId = current?.batches.some(batch => batch.id === baseBatchId)
          ? `${baseBatchId}-replacement-${current.batches.length}` : baseBatchId;
        const batch: MemoryIngestionBatchInput = next ?? { ...base,
          id: freshBatchId,
          advancesCursor: false, workMetadata: { version: 1, workId, messageIds: batchIds,
            ...(letter ? { letter: letter.binding } : {}), ...(!current ? { selectedMessageIds: ids } : {}) } };
        const begun = await runBackupRestoreDataEpochCommit(epoch, () => beginMemoryIngestionBatch(batch));
        if (!begun.committed || owner.signal.aborted) return { status: 'stopped' as const };
        runtimeState.setUnfinishedOrganization?.(true);
        showTransientMemoryNotice(`已处理 ${ids.length - remaining.length}/${ids.length} 条，正在整理下一批。`, 4000);
        const result = await organizeMessageBatch(batchMessages, 'selected', null, { batch, owner });
        if (result.status !== 'done') {
          if (result.status === 'waiting' && !owner.signal.aborted) waitingRef.current = workId;
          return result;
        }
        generated += result.generated;
      }
      return { status: 'stopped' as const };
    } catch (error) {
      return { status: 'failed' as const, failure: classifyMemoryOrganizationFailure(error) };
    } finally {
      if (requestRef.current === owner) {
        requestRef.current = null;
        setOrganizing(false);
        proactiveReviewingRef.current = false;
      }
      if (activeSessionRef.current === sessionId && canCommitBackupRestoreDataEpoch(epoch)) {
        const unfinished = await loadLatestUnfinishedMemoryIngestionWork(sessionId).catch(() => null);
        runtimeState.setUnfinishedOrganization?.(!!unfinished);
      }
    }
  };
  const organizeMessages = async (newMessages: SubjectiveMessage[], mode: 'new' | 'selected',
    legacyCursor: { createdAt: number; id: string } | null = null) => {
    let generated = 0;
    if (mode === 'selected') {
      const workId = `selected-voice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      for (const message of newMessages.filter(message => !!message.voiceCallRecord)) {
        const result = await organizeVoiceCallRecord(message, workId);
        if (result.status !== 'done') return { status: 'failed' as const, failure: classifyMemoryOrganizationFailure(new Error('voice-memory-incomplete')) };
        generated += result.generated;
      }
    }
    const chat = newMessages.filter(message => !message.voiceCallRecord);
    if (mode === 'selected' && !chat.length) return { status: 'done' as const, generated, remaining: 0 };
    const result = mode === 'selected' && chat.some(message => !isLetterChatCopy(message))
      ? await runSelectedOrganization(chat) : await organizeMessageBatch(chat, 'new', legacyCursor);
    return result.status === 'done' ? { ...result, generated: result.generated + generated } : result;
  };
  const continueSelectedOrganization = () => runSelectedOrganization();
  const resumeWaitingOrganization = async () => {
    const result = runtimeState.waitingOrganizationRef?.current
      ? await runSelectedOrganization(undefined, runtimeState.waitingOrganizationRef.current) : { status: 'skipped' as const };
    if (result.status === 'failed') showTransientMemoryNotice(getMemoryOrganizationFailureNotice(result.failure), 4200);
    return result;
  };

  const organizeVoiceCallRecord = async (message: SubjectiveMessage, selectionWorkId?: string) => {
    const record = message.voiceCallRecord;
    const sessionId = activeSessionRef.current;
    const revision = candidateUiRevision();
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (!record || !sessionId || organizing) return { status: 'skipped' as const };
    if (!organizerReady) {
      showTransientMemoryNotice('还没有配置记忆整理模型。', 2400);
      return { status: 'config_missing' as const };
    }
    setOrganizing(true);
    const requestRef = runtimeState.organizationAbortRef ??= { current: null };
    const owner = new AbortController();
    requestRef.current = owner;
    try {
      const current = await loadVoiceCallMemoryRecord(getVoiceCallMemorySessionId(record.callId));
      if (!current || !canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'skipped' as const };
      let expectedRecordHash = voiceCallRecordVersion(current);
      const saveRecord = async (next: typeof current) => {
        if (owner.signal.aborted || !candidateUiIsCurrent(sessionId, revision) || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
        const saved = await upsertVoiceCallRecord(next, sessionId, { dataEpoch, expectedRecordHash });
        if (saved) expectedRecordHash = voiceCallRecordVersion(next);
        return !!saved;
      };
      const result = await organizeVoiceCallMemoryRecord({ record: current, apiKey: ai.key,
        connection: ai.connection!, mode: 'manual', dataEpoch, saveRecord, signal: owner.signal, selectionWorkId,
        canCommit: () => candidateUiIsCurrent(sessionId, revision) && !owner.signal.aborted });
      if (!candidateUiIsCurrent(sessionId, revision) || !canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'skipped' as const };
      const actual = await loadVoiceCallMemoryRecord(getVoiceCallMemorySessionId(record.callId));
      const needsCache = result.memoryOrganization?.segments.some(segment => segment.candidateStatus === 'cached')
        || result.memoryOrganization?.segments.some(segment => segment.summaryValid) && (!actual || voiceCallRecordVersion(actual) !== voiceCallRecordVersion(result));
      if (!owner.signal.aborted && needsCache) {
        const activeDraft = await loadActiveVoiceCallRecordDraft();
        await persistActiveVoiceCallRecordDraft({ version: 1, record: result, targetSessionId: sessionId, dataEpoch },
          activeDraft?.record.callId === record.callId ? { callId: record.callId, recordHash: voiceCallRecordVersion(activeDraft.record) } : null);
      }
      const pending = await loadPendingMemoryCandidates({ sessionId });
      appendCandidates(pending.filter(candidate => candidate.origin === 'voice_call'));
      return { generated: pending.filter(candidate => candidate.origin === 'voice_call').length,
        status: result.memoryOrganization?.status === 'failed' || result.memoryOrganization?.status === 'waiting'
          ? 'failed' as const : 'done' as const };
    } catch (error) {
      console.warn('[voice-call-memory-organize]', classifyMemoryOrganizationFailure(error).technicalCode);
      showTransientMemoryNotice('这次没有整理成功。', 2400);
      return { status: 'failed' as const };
    } finally { if (requestRef.current === owner) { requestRef.current = null; setOrganizing(false); } }
  };

  const proposeMemoryAfterReply = async ({
    currentMessages,
    dataEpoch,
    memoryRoute,
    proactiveReviewedThroughId,
    recallItems,
    sessionId,
    observationOpportunity = false,
  }: {
    currentMessages: SubjectiveMessage[];
    dataEpoch: number | null;
    memoryRoute?: MemoryRecallRoute | null;
    proactiveReviewedThroughId: string | null;
    recallItems: MemoryRecallItem[] | null;
    sessionId: string | null;
    observationOpportunity?: boolean;
  }) => {
    const uiRevision = runtimeState.memoryOrganizationRevisionRef.current;
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (!sessionId || !proactiveMemorySuggestions || !organizerReady || proactiveReviewingRef.current || runtimeState.organizationAbortRef?.current) return;
    const owner = new AbortController();
    const requestRef = runtimeState.organizationAbortRef ??= { current: null };
    requestRef.current = owner;
    proactiveReviewingRef.current = true;
    let attemptedBatchId: string | null = null;
    let committed = false;
    try {
      const legacyMessage = proactiveReviewedThroughId
        ? currentMessages.find((message) => message.id === proactiveReviewedThroughId) ?? null
        : null;
      const cursorCommit = await runBackupRestoreDataEpochCommit(
        dataEpoch,
        async () => {
          await seedLegacyIngestionCursor(sessionId, 'proactive', legacyMessage);
          return loadChatMemoryIngestionProgress(sessionId);
        },
      );
      if (!cursorCommit.committed) return;
      const reviewedIndex = findMemoryCursorIndex(currentMessages, cursorCommit.value.cursor);
      const newMessages = currentMessages.slice(reviewedIndex + 1).filter(message => !isLetterChatCopy(message) && !message.voiceCallRecord);
      if (Date.now() - lastProactiveMemorySuggestionAtRef.current < PROACTIVE_MEMORY_SUGGESTION_COOLDOWN_MS) return;
      const preparedObservations = await nextObservationMaterials({ sessionId, limit: PROACTIVE_DIGEST_BATCH_SIZE });
      const preparedReadings = await nextReadingOrganizationWork({ sessionId });
      const preparedShiying = await nextShiyingOrganizationWork({ sessionId });
      const preparedLifeSelf = await nextLifeSelfOrganizationWork();
      let retry = cursorCommit.value.retry ?? await loadObservationOrganizationRetry(sessionId)
        ?? await loadReadingOrganizationRetry(sessionId) ?? await loadShiyingOrganizationRetry(sessionId)
        ?? await loadLifeSelfOrganizationRetry(sessionId);
      if (observationOpportunity && !retry && !preparedObservations.eligibleCount && !preparedObservations.work?.length
        && !preparedReadings.eligibleSources.length && !preparedShiying.eligibleCount && !preparedLifeSelf.eligibleSources.length) return;
      const assistantMessageCount = newMessages.filter((message) => message.role === 'I').length;
      const carriedObservations = !!preparedObservations.work?.length;
      const carriedReadings = preparedReadings.eligibleSources.some(value => value.carry);
      const carriedLifeSelf = preparedLifeSelf.eligibleSources.some(value => value.carry);
      if (!retry && !carriedObservations && !carriedReadings && !carriedLifeSelf
        && newMessages.length + preparedObservations.eligibleCount + preparedReadings.eligibleCount + preparedShiying.eligibleCount
          + preparedLifeSelf.eligibleSources.filter(value => value.countAsNew).length < PROACTIVE_DIGEST_BATCH_SIZE) return;
      if (!retry && !preparedObservations.eligibleCount && !carriedObservations
        && !preparedReadings.eligibleSources.length && !preparedShiying.eligibleCount && !preparedLifeSelf.eligibleSources.length && assistantMessageCount < 3) return;

      if (retry?.workMetadata?.lifeSelfBindings?.length && !retry.itemCount
        && !(await Promise.all(retry.workMetadata.lifeSelfBindings.map(binding => validateLifeSelfBinding(binding)))).every(Boolean)) {
        await runBackupRestoreDataEpochCommit(dataEpoch, () => retireChangedMemoryExtraction(retry!.id)); retry = null;
      }

      if (!organizationIsCurrent(sessionId, uiRevision)
        || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      if (retry?.workMetadata?.letter && !(await validateLetterBinding(retry.workMetadata.letter)) && !retry.itemCount) {
        const { retireChangedLetterExtraction } = await import('./memoryIngestionService');
        await runBackupRestoreDataEpochCommit(dataEpoch, () => retireChangedLetterExtraction(retry!.id));
        retry = null;
      }
      if (retry?.workMetadata?.readings?.length && !retry.itemCount
        && !(await Promise.all(retry.workMetadata.readings.map(binding => validateReadingOrganizationBinding(binding)))).every(Boolean)) {
        await runBackupRestoreDataEpochCommit(dataEpoch, () => retireChangedMemoryExtraction(retry!.id));
        retry = null;
      }
      if (retry?.workMetadata?.shiying?.length && !retry.itemCount
        && !(await Promise.all(retry.workMetadata.shiying.map(binding => validateShiyingMemoryBinding(binding)))).every(Boolean)) {
        await runBackupRestoreDataEpochCommit(dataEpoch, () => retireChangedMemoryExtraction(retry!.id)); retry = null;
      }
      const nextLetter = retry?.workMetadata?.letter ? { material: await restoreLetterMaterial(retry.workMetadata.letter, sessionId), blockedSentence: false }
        : retry ? { material: undefined, blockedSentence: false } : await nextLetterMaterial(sessionId);
      const letter = nextLetter.material;
      if (nextLetter.blockedSentence) showTransientMemoryNotice('信件单句过长，暂未整理', 4200);
      const selected = await prepareMixedSourceBatch(newMessages, preparedObservations, preparedReadings,
        PROACTIVE_DIGEST_BATCH_SIZE - (letter ? 1 : 0), preparedShiying, preparedLifeSelf, sessionId);
      if (selected.readingNotice) showTransientMemoryNotice(selected.readingNotice, 4200);
      let reviewedMessages = selected.messages;
      let observations = selected.observations;
      let observationWork = selected.work;
      let readings = selected.readings;
      let readingWork = selected.readingWork;
      let shiying = selected.shiying;
      let shiyingWork = selected.shiyingWork;
      let lifeSelf = selected.lifeSelf;
      let lifeSelfWork = selected.lifeSelfWork;
      if (retry) {
        if (retry.workMetadata?.messageIds) {
          const { loadChatSessionMessage } = await import('../chat/chatStorage');
          const originals = await Promise.all(retry.workMetadata.messageIds.map(id => loadChatSessionMessage(sessionId, id)));
          if (originals.some(value => !value)) throw new Error('MEMORY_SOURCE_CHANGED');
          reviewedMessages = originals as SubjectiveMessage[];
        } else {
          const end = reviewedMessages.findIndex(message => message.id === retry!.sourceLastMessageId);
          if (end >= 0) reviewedMessages = reviewedMessages.slice(0, end + 1);
        }
        observations = await Promise.all((retry.workMetadata?.observations ?? []).map(binding => restoreObservationMaterial(binding, sessionId)));
        observationWork = retry.workMetadata?.observationWork ?? observations.map(value => value.binding);
        readings = await Promise.all((retry.workMetadata?.readings ?? []).map(binding => restoreReadingOrganizationMaterial(binding, sessionId)));
        readingWork = retry.workMetadata?.readingWork ?? [];
        shiying = await restoreShiyingMaterials(retry.workMetadata?.shiying ?? [], sessionId);
        shiyingWork = retry.workMetadata?.shiyingWork ?? [];
        lifeSelf = await restoreLifeSelfOrganizationMaterials(retry.workMetadata?.lifeSelfBindings ?? [], sessionId);
        lifeSelfWork = retry.workMetadata?.lifeSelfWork ?? [];
      }
      if (!reviewedMessages.length && !letter && !observations.length && !readings.length && !shiying.length && !lifeSelf.length) return;
      if (!retry && !carriedObservations && !readingWork.some(value => value.carry) && !lifeSelfWork.some(value => value.carry)
        && reviewedMessages.length + observations.length + readingWork.filter(value => value.countAsNew).length + shiyingWork.filter(value => value.countAsNew).length
          + lifeSelfWork.filter(value => value.countAsNew).length + selected.lifeSelfDeferredCount < PROACTIVE_DIGEST_BATCH_SIZE
        && !(shiyingWork.some(value => value.carry)
          && newMessages.length + preparedObservations.eligibleCount + preparedReadings.eligibleCount + shiyingWork.filter(value => value.countAsNew).length >= PROACTIVE_DIGEST_BATCH_SIZE)) return;
      lastProactiveMemorySuggestionAtRef.current = Date.now();
      setOrganizing(true);
      const lastReviewedMessage = reviewedMessages[reviewedMessages.length - 1];
      const matchingRetry = !!retry && retry.sourceFirstMessageId === reviewedMessages[0]?.id
        && retry?.sourceLastMessageId === lastReviewedMessage?.id;
      const baseInput = makeIngestionBatchInput('proactive', sessionId, reviewedMessages);
      const batchInput = matchingRetry ? retry! : attachLifeSelfBatch(attachShiyingBatch(attachReadingBatch(attachObservationBatch({ ...baseInput,
        id: letter ? `${baseInput.id}-${letter.batch.id}` : baseInput.id,
        workMetadata: { version: 1 as const, workId: baseInput.id, messageIds: reviewedMessages.map(message => message.id), ...(letter ? { letter: letter.binding } : {}) } }, observations, observationWork), readings, readingWork), shiying, shiyingWork), lifeSelf, lifeSelfWork);
      attemptedBatchId = batchInput.id;
      const chatMaterials = await filterUnreviewedChatMemoryMessages(sessionId, reviewedMessages);
      const materialMessages = [...chatMaterials, ...(letter ? [letter.message] : []), ...readings.map(value => value.message), ...shiying.flatMap(value => value.messages), ...lifeSelf.map(value => value.message)];
      if (!(await Promise.all(readings.map(value => validateReadingOrganizationBinding(value.binding, value.message)))).every(Boolean)) {
        throw new Error('MEMORY_SOURCE_CHANGED');
      }
      if (letter) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(letter.batch));
      for (const observation of observations) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(observation.batch));
      for (const reading of readings) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(reading.batch));
      for (const paper of shiying) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(paper.batch));
      for (const material of lifeSelf) await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch(material.batch));
      if (!organizationIsCurrent(sessionId, uiRevision) || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const batchCommit = await runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => beginMemoryIngestionBatch(batchInput),
      );
      if (!batchCommit.committed) return;
      let existingBatch = batchCommit.value;
      if (existingBatch?.status === 'waiting') existingBatch = await releaseMemoryIngestionBatchWaiting(batchInput.id);
      if (existingBatch?.status === 'waiting') {
        const waitingCandidates = await loadPendingMemoryCandidates({ batchIds: [batchInput.id] });
        if (!organizationIsCurrent(sessionId, uiRevision) || owner.signal.aborted || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        appendCandidates(waitingCandidates);
        return;
      }
      const removalRevision = candidateUiRevision();
      const pending = await loadPendingMemoryCandidates({ batchIds: [batchInput.id] });
      if (!canCommitBackupRestoreDataEpoch(dataEpoch) || !organizationIsCurrent(sessionId, uiRevision)) return;
      if (pending.length && candidateUiIsCurrent(sessionId, removalRevision)) appendCandidates(pending);
      const alreadyVisible = memoryCandidates.some((candidate) =>
        candidate.ingestionRefs?.some((ref) => ref.batchId === batchInput.id)) || pending.length > 0;
      committed = !!existingBatch && ['ready', 'resolved', 'no_value'].includes(existingBatch.status);
      if (existingBatch?.status === 'resolved' || existingBatch?.status === 'no_value') {
        const synced = await runBackupRestoreDataEpochCommit(
          dataEpoch,
          () => syncIngestionCursorMirror(batchInput.id),
        );
        if (!synced.committed) return;
      } else if (!alreadyVisible) {
        const understandingMaterials = await prepareUnderstandingMaterials({ sessionId, messages: materialMessages,
          letterBindings: letter ? [letter.binding] : undefined,
          observationMaterials: observations,
          readingMaterials: readings,
          shiyingMaterials: shiying,
          lifeSelfMaterials: lifeSelf,
          readingCorrectionTargetIds: readings.flatMap(value => value.correctionTargetIds),
          recalledIds: recallItems?.map(item => item.memory.id), continuationEnabled: true, signal: owner.signal, background: true,
          contextMessages: currentMessages.slice(Math.max(0, reviewedIndex - 1), reviewedIndex + 1) });
        const candidatesPending = await loadPendingMemoryCandidates({ sessionId });
        if (!organizationIsCurrent(sessionId, uiRevision) || owner.signal.aborted || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        const targets = new Set([...(understandingMaterials.episodeTargetIds ?? []), ...understandingMaterials.targets.map(item => item.id),
          ...(understandingMaterials.currentStates ?? []).map(item => `current_state:${item.id}`),
          ...readings.flatMap(value => value.correctionTargetIds)]);
        const blockers = [...new Set(candidatesPending.map(memoryCandidateTargetKey)
          .filter((id): id is string => !!id && targets.has(id)))];
        if (blockers.length) {
          await runBackupRestoreDataEpochCommit(dataEpoch, async () =>
            organizationIsCurrent(sessionId, uiRevision) && !owner.signal.aborted
              ? updateMemoryIngestionBatchWaiting(batchInput.id, { reason: 'pending_target', targetMemoryIds: blockers }) : undefined);
          return;
        }
        const proposals = materialMessages.length || observations.length ? await runMemoryOrganizerRequestWithDeadline(signal => proposeConversationMemory({
          apiKey: ai.key,
          connection: ai.connection!,
          messages: materialMessages,
          understandingMaterials,
          episodeSummaryEnabled: true,
          chatFactualityEnabled: true,
          signal,
        }), { signal: owner.signal, timeoutMs: 60_000 }) : [];
        if (!canCommitBackupRestoreDataEpoch(dataEpoch) || !organizationIsCurrent(sessionId, uiRevision)) return;
        const range = {
          messages: materialMessages,
          sessionId,
          sourceStartAt: reviewedMessages[0]?.createdAt,
          sourceEndAt: lastReviewedMessage?.createdAt,
        };
        const allCandidates = makeReviewCandidates(proposals, 'proposal', range);
        const direct = (candidate: MemoryCandidateReview) => !!candidate.currentStateReview || (!!candidate.continuationReview && (candidate.atomicKind === 'stage_conclusion' || !!candidate.continuationReview.targetMemoryId));
        const ordinary = await filterAutomaticMemoryCandidates(allCandidates.filter(candidate => !candidate.understandingSubject && !direct(candidate)));
        const accepted = allCandidates.filter(candidate => candidate.understandingSubject || direct(candidate) || ordinary.some(item => item.reviewId === candidate.reviewId));
        if (!canCommitBackupRestoreDataEpoch(dataEpoch) || !organizationIsCurrent(sessionId, uiRevision)) return;
        const registeredCommit = await runBackupRestoreDataEpochCommit(
          dataEpoch,
          async () => {
            if (!(await sourceMessagesAreCurrent(sessionId, reviewedMessages))
              || (letter && !(await validateLetterBinding(letter.binding)))
              || !(await Promise.all(observations.map(value => validateObservationBinding(value.binding)))).every(Boolean)
              || !(await Promise.all(readings.map(value => validateReadingOrganizationBinding(value.binding, value.message)))).every(Boolean)
              || !(await Promise.all(shiying.flatMap(value => value.bindings).map(binding => validateShiyingMemoryBinding(binding)))).every(Boolean)
              || !(await Promise.all(lifeSelf.map(value => validateLifeSelfBinding(value.binding, value.message)))).every(Boolean)
              || !organizationIsCurrent(sessionId, uiRevision)) throw new Error('MEMORY_SOURCE_CHANGED');
            return registerCandidateBatch([batchInput.id, ...(letter ? [letter.batch.id] : []), ...observations.map(value => value.batch.id),
              ...readings.map(value => value.batch.id), ...shiying.map(value => value.batch.id), ...lifeSelf.map(value => value.batch.id)], allCandidates, accepted,
              () => organizationIsCurrent(sessionId, uiRevision) && !owner.signal.aborted && canCommitBackupRestoreDataEpoch(dataEpoch));
          },
        );
        if (!registeredCommit.committed || !organizationIsCurrent(sessionId, uiRevision)) return;
        const savedBatch = await loadMemoryIngestionBatch(batchInput.id);
        committed = !!savedBatch && ['ready', 'resolved', 'no_value'].includes(savedBatch.status);
        if (!committed && savedBatch?.status !== 'waiting') throw new Error('MEMORY_SOURCE_CHANGED');
        const registered = registeredCommit.value;
        if (registered.length) {
          appendCandidates(registered);
        }
        if (savedBatch?.status === 'waiting') return;
        const synced = await runBackupRestoreDataEpochCommit(
          dataEpoch,
          () => syncIngestionCursorMirror(batchInput.id).catch(() => undefined),
        );
        if (!synced.committed) return;
      }

    } catch {
      if (attemptedBatchId && !committed) await runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => markMemoryIngestionBatchFailed(attemptedBatchId!),
      ).catch(() => undefined);
    } finally {
      if (requestRef.current === owner) { requestRef.current = null; proactiveReviewingRef.current = false; setOrganizing(false); }
    }
  };

  const resumeObservationOrganization = async () => {
    if (AppState.currentState !== 'active' || !(isActive?.() ?? true)) return;
    await proposeMemoryAfterReply({ currentMessages: messages, dataEpoch: captureBackupRestoreDataEpoch(),
      proactiveReviewedThroughId: null, recallItems: latestMemoryRecall, sessionId: activeSessionRef.current,
      observationOpportunity: true });
  };

  const resumeExplicitFactMemories = async (afterReply = false) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    const saved = await resumePendingExplicitFacts({
      ai, automaticEnabled: automaticExplicitFactMemories, afterReply,
      getAutomaticEnabled: getAutomaticExplicitFactMemories,
      canRun: () => AppState.currentState === 'active' && (isActive?.() ?? true),
    });
    if (saved && canCommitBackupRestoreDataEpoch(dataEpoch) && activeSessionRef.current === saved.sessionId) {
      showTransientMemoryNotice(`白云小姐记下了：${saved.title}`, 4200);
    }
  };

  const captureExplicitFactAfterReply = async ({
    dataEpoch,
    force,
    message,
    sessionId,
  }: {
    dataEpoch: number | null;
    force: boolean;
    message: SubjectiveMessage;
    sessionId: string | null;
  }) => {
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (!sessionId || activeSessionRef.current !== sessionId) return;
    if (!shouldAttemptExplicitFactMemory(message.content, force)) return;
    if (!automaticExplicitFactMemories && !force) return;

    await enqueueExplicitFactMemory({ dataEpoch, force, message, sessionId });
    if (canCommitBackupRestoreDataEpoch(dataEpoch)) await resumeExplicitFactMemories(true);
  };



  return {
    appendCandidates,
    applyFeedbackFromUser,
    captureExplicitFactAfterReply,
    resumeExplicitFactMemories,
    resumeObservationOrganization,
    clearSessionMemoryState,
    flagRecallAsIrrelevant,
    flaggedRecallIds,
    latestMemoryDebug,
    latestMemoryRecall,
    latestMemoryRecallQuery,
    currentStateCandidates,
    currentStateResolveCandidates,
    memoryCandidates,
    memoryNotice,
    organizeMessages,
    stopOrganization,
    continueSelectedOrganization,
    resumeWaitingOrganization,
    organizeVoiceCallRecord,
    organizing,
    proposeMemoryAfterReply,
    saveCandidate,
    saveCurrentStateCandidate,
    discardCandidate,
    discardCurrentStateCandidate,
    saveCurrentStateResolveCandidate,
    discardCurrentStateResolveCandidate,
    setLatestMemoryDebug,
    setLatestMemoryRecall,
    setLatestMemoryRecallQuery,
    setMemoryCandidates,
    setMemoryNotice,
    setOrganizing,
    setLatestRecallFromCognition,
    showTransientMemoryNotice,
    processVoiceCallMemoryCandidates,
  };
}

export function shouldAttemptEpisodeMemoryForMessages(messages: SubjectiveMessage[]) {
  if (messages.length < EPISODE_MEMORY_MIN_MESSAGES) return false;
  const userMessages = messages
    .filter((message) => message.role === 'you')
    .filter((message) => message.content.replace(/\s+/g, '').length >= 12);
  const userText = userMessages
    .map((message) => message.content)
    .join('\n');
  const compactLength = userText.replace(/\s+/g, '').length;
  if (compactLength < EPISODE_MEMORY_MIN_USER_CHARS) return false;
  if (userMessages.length < 3 && compactLength < 600) return false;

  const topicPattern = /项目|功能|排查|调试|修复|优化|关系|约定|边界|身体|情绪|焦虑|失眠|疼|难受|创伤|校园|欺负|霸凌|生病|复盘/;
  const processTerms = userText.match(/阶段|计划|继续|进展|后来|然后|接着|结果|最终|原因|解决|没解决|卡住|反复|一直|逐步|这几天|最近|之前|上次|过程|变化|转折|影响|形成|希望|尝试|发现|排查|修复|优化/g) ?? [];
  const strongProcessPattern = /后来|然后|接着|结果|最终|转折|反复|逐步|过程|变化|进展|解决|没解决|卡住|影响|形成|尝试|发现|排查|修复|优化/;

  return topicPattern.test(userText)
    && strongProcessPattern.test(userText)
    && new Set(processTerms).size >= 3;
}

function shouldAttemptExplicitFactMemory(text: string, force: boolean) {
  const normalized = text.trim();
  if (force) return true;
  if (!normalized || FAST_REPLY_PATTERN.test(normalized)) return false;
  return EXPLICIT_FACT_MEMORY_PATTERN.test(normalized) || PROJECT_FACT_MEMORY_PATTERN.test(normalized);
}
