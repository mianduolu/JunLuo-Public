import { memoryExperienceStorageBridge as AsyncStorage } from '../sync/syncMemoryExperienceStorageBridge';
import { checkAutomaticRequestCost, isAiCostDeferred, type AiRequestAdmission } from '../ai/aiCallBudget';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';

import { buildAssistantLifePromptEnvelope, fetchAssistantLifeCompletion } from '../ai/assistantLifePromptEnvelope';
import { loadBaiyunContinuityEventsWithoutAdvancing } from '../ai/behavior/continuityLedgerAdapter';
import { defaultAiProfile, type AiConnection, type AiProfile } from '../ai/types';
import { createMemoryMaterialPreparation } from '../memory/memoryCurrentMaterials';
import { createMemoryUsageReceipt, settleSavedMemoryUsage, type MemoryUsageReceipt } from '../memory/memoryReplyUsage';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import {
  createMemory,
  isTimelineEligibleMemory,
  loadMemories,
  loadWhisperMemories,
  type MemoryDraft,
  type MemoryEntry,
} from '../memory/memoryStore';
import {
  type JunluoInnerThoughtV2,
  type JunluoThoughtStateV2,
} from './junluoInnerState';
import {
  JUNLUO_DREAM_TASK_PROMPT,
  buildDreamMaterialPrompt,
  buildDreamStatePaper,
  createDreamId,
  createDreamThoughtId,
  parseDreamGenerationResponse,
  type DreamGenerationThought,
  type ParsedDreamGeneration,
} from './dreamGenerationContract';
import {
  buildJunluoDesirePromptPaper,
  calculateJunluoDesireSnapshot,
} from './junluoDesireMetabolism';
import { mergeJunluoProcessedOperations } from './junluoInnerStatePersistence';
import {
  loadJunluoAffectState,
  loadJunluoDesireState,
  loadJunluoThoughtState,
  updateJunluoThoughtState,
} from './junluoInnerStateStore';
import { loadJunluoRemindYouValue } from './junluoReminderDesire';
import {
  advanceJunluoThoughtLifecycle,
  recordJunluoThoughtAttempt,
} from './junluoThoughtLifecycle';
import type { RhythmSnapshot } from './lifeRhythm';
import {
  calculateDreamChance,
  getEligibleDreamSleepEpisode,
  shouldAttemptDreamEpisode,
} from './dreamSleepPolicy';

export {
  calculateDreamChance,
  getEligibleDreamSleepEpisode,
  shouldAttemptDreamEpisode,
} from './dreamSleepPolicy';

export type DreamEntry = {
  arousal: number;
  content: string;
  createdAt: number;
  id: string;
  memoryId?: string;
  recallCues: string[];
  surfacedAt?: number;
  thoughtId?: string;
  title?: string;
  valence: number;
};

export type DreamSurfacePreparation = {
  dreamId: string;
  instruction: string;
  thoughtId?: string;
};

const PENDING_DREAMS_KEY = 'junluo.life.dreamEngine.pendingDreams';
const DREAM_STATE_KEY = 'junluo.life.dreamEngine.state';
const DAY_MS = 24 * 60 * 60 * 1000;


type DreamEngineState = {
  lastAttemptEpisodeId?: string;
};

function clamp(value: number, min = 0, max = 1, fallback = 0.5) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function cleanText(value: unknown, limit: number) {
  return typeof value === 'string'
    ? value.replace(/\bI\b/g, '我').replace(/\s+/g, ' ').trim().slice(0, limit)
    : '';
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function loadDreamState(): Promise<DreamEngineState> {
  const raw = await AsyncStorage.getItem(DREAM_STATE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as DreamEngineState;
    return {
      lastAttemptEpisodeId: typeof parsed.lastAttemptEpisodeId === 'string'
        ? parsed.lastAttemptEpisodeId
        : undefined,
    };
  } catch {
    return {};
  }
}

async function saveDreamState(state: DreamEngineState) {
  await AsyncStorage.setItem(DREAM_STATE_KEY, JSON.stringify(state));
}

async function loadPendingDreams(): Promise<DreamEntry[]> {
  const raw = await AsyncStorage.getItem(PENDING_DREAMS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as DreamEntry[];
    return Array.isArray(parsed)
      ? parsed
        .filter((dream) => typeof dream?.id === 'string' && typeof dream?.content === 'string')
        .map((dream) => ({
          ...dream,
          arousal: clamp(Number(dream.arousal), 0, 1, 0.35),
          content: cleanText(dream.content, 240),
          createdAt: Number.isFinite(dream.createdAt) ? dream.createdAt : 0,
          recallCues: Array.isArray(dream.recallCues)
            ? dream.recallCues.map((cue) => cleanText(cue, 18)).filter(Boolean).slice(0, 5)
            : [],
          thoughtId: typeof dream.thoughtId === 'string' ? dream.thoughtId : undefined,
          title: typeof dream.title === 'string' ? cleanText(dream.title, 20) : undefined,
          valence: clamp(Number(dream.valence), 0, 1, 0.55),
        }))
        .filter((dream) => dream.content.length > 0)
      : [];
  } catch {
    return [];
  }
}

async function savePendingDreams(dreams: DreamEntry[]) {
  await AsyncStorage.setItem(PENDING_DREAMS_KEY, JSON.stringify(dreams.slice(-5)));
}

function belongsToRecent(memory: MemoryEntry, now: number) {
  return now - Math.max(memory.updatedAt, memory.createdAt, memory.lastActiveAt) <= 48 * 60 * 60 * 1000;
}

function belongsToOldEcho(memory: MemoryEntry, now: number) {
  return now - Math.max(memory.updatedAt, memory.createdAt, memory.lastActiveAt) >= 3 * DAY_MS;
}

async function gatherDreamMaterials(now: number) {
  const preparation = createMemoryMaterialPreparation();
  const [allMemories, whispers] = await Promise.all([
    loadMemories({ includeArchived: false, currentOnly: true }),
    loadWhisperMemories(8),
  ]);
  let recent = allMemories
    .filter((memory) => (isTimelineEligibleMemory(memory) || memory.period === 'whisper') && belongsToRecent(memory, now))
    .sort((left, right) => right.importance - left.importance || right.updatedAt - left.updatedAt)
    .slice(0, 12);
  let oldEcho: MemoryEntry | undefined = allMemories
    .filter((memory) => isTimelineEligibleMemory(memory) && belongsToOldEcho(memory, now))
    .sort((left, right) => left.lastActiveAt - right.lastActiveAt)[0];
  recent = [...recent, ...whispers].slice(0, 16);
  const whisperIds = new Set(whispers.map(memory => memory.id));
  const format = () => buildDreamMaterialPrompt({ oldEcho, recentMemories: recent });
  const refresh = async () => {
    const selected = [...recent, ...(oldEcho ? [oldEcho] : [])];
    const refreshed = new Map((await preparation.refresh(selected, memory => memory.type !== 'archived'))
      .map(memory => [memory.id, memory]));
    recent = recent.flatMap(memory => {
      const next = refreshed.get(memory.id);
      return next && (whisperIds.has(next.id)
        ? next.period === 'whisper'
        : (isTimelineEligibleMemory(next) || next.period === 'whisper') && belongsToRecent(next, now)) ? [next] : [];
    });
    oldEcho = oldEcho ? refreshed.get(oldEcho.id) : undefined;
    if (oldEcho && (!isTimelineEligibleMemory(oldEcho) || !belongsToOldEcho(oldEcho, now))) oldEcho = undefined;
    return format();
  };
  await refresh();
  return {
    material: format(),
    usageReferences: () => preparation.usageReferences([...recent, ...(oldEcho ? [oldEcho] : [])]),
    refresh: async () => {
      await refresh();
      return refresh();
    },
  };
}

async function buildDreamDynamicState(now: number, rhythmSnapshot: RhythmSnapshot) {
  const [affect, desire, thoughts, remindYouValue, continuityEvents] = await Promise.all([
    loadJunluoAffectState(),
    loadJunluoDesireState(),
    loadJunluoThoughtState(),
    loadJunluoRemindYouValue(now).catch(() => 0),
    loadBaiyunContinuityEventsWithoutAdvancing().catch(() => []),
  ]);
  const desireSnapshot = calculateJunluoDesireSnapshot({
    now,
    state: desire,
    structural: {
      remindYouValue,
      sleepDebt: rhythmSnapshot.sleepDebt,
      sleepPressure: rhythmSnapshot.sleepPressure,
    },
  });
  const lifeState = rhythmSnapshot.phase === 'sleeping'
    ? 'asleep'
    : affect.lifeState?.stateId ?? 'calm';
  return [
    buildDreamStatePaper({
      lifeState,
      primaryEmotion: affect.emotions.primary?.emotionId ?? 'calm',
      secondaryEmotion: affect.emotions.secondary[0]?.emotionId ?? null,
    }),
    buildJunluoDesirePromptPaper(desireSnapshot),
  ].filter(Boolean).join('\n\n');
}

async function generateDreamWithAi({
  apiKey,
  connection,
  dynamicState,
  materials,
  profile,
  onRequestStart,
}: {
  apiKey: string;
  connection: AiConnection;
  dynamicState: string;
  materials: Awaited<ReturnType<typeof gatherDreamMaterials>>;
  profile: AiProfile;
  onRequestStart: (assertTransportReady?: () => void | Promise<void>) => Promise<void>;
}) {
  const promptEnvelope = await buildAssistantLifePromptEnvelope({
    contextSource: 'assistant-life.dream',
    dynamicSystemPrompt: dynamicState,
    taskPrompt: JUNLUO_DREAM_TASK_PROMPT,
    profile,
  });
  const { content } = await fetchAssistantLifeCompletion({
    apiKey,
    connection,
    contextSource: 'assistant-life.dream',
    envelope: promptEnvelope,
    request: { temperature: 0.72 },
    userPrompt: materials.material,
    refreshMemoryMaterials: materials.refresh,
    onRequestStart,
  });
  return content ? parseDreamGenerationResponse(content) : null;
}

function createDreamThoughtState(input: {
  dreamId: string;
  now: number;
  state: JunluoThoughtStateV2;
  thought: DreamGenerationThought;
  retainedThoughtIds?: ReadonlySet<string>;
}) {
  const thoughtId = createDreamThoughtId(input.dreamId);
  const operation = {
    occurredAt: input.now,
    operationId: `${input.dreamId}:thought:create`,
  };
  if (
    input.state.recentProcessedOperations.some((entry) => entry.operationId === operation.operationId)
    || input.state.thoughts.some((entry) => entry.thoughtId === thoughtId)
  ) return input.state;
  const thought: JunluoInnerThoughtV2 = {
    attemptCount: 0,
    content: input.thought.content,
    createdAt: input.now,
    desireId: input.thought.desireId,
    lastAttempt: null,
    lastChosenAt: null,
    lastOutcome: null,
    lastTransition: operation,
    missedReviewCount: 0,
    nextReviewAt: null,
    reviewStage: 0,
    sourceId: input.dreamId,
    sourceKind: 'dream',
    state: 'flit',
    thoughtId,
    updatedAt: input.now,
  };
  const withThought: JunluoThoughtStateV2 = {
    ...input.state,
    recentProcessedOperations: mergeJunluoProcessedOperations(
      input.state.recentProcessedOperations,
      [operation],
    ),
    thoughts: [...input.state.thoughts, thought],
    updatedAt: Math.max(input.state.updatedAt, input.now),
  };
  return advanceJunluoThoughtLifecycle({
    retainedThoughtIds: input.retainedThoughtIds,
    now: input.now,
    operationId: `${input.dreamId}:thought:lifecycle`,
    state: withThought,
  });
}

async function storeDream(input: {
  dream: NonNullable<ParsedDreamGeneration['dream']>;
  dreamId: string;
  now: number;
  thought: DreamGenerationThought | null;
  dataEpoch: number | null;
  receipt?: MemoryUsageReceipt;
}) {
  const existing = (await loadPendingDreams()).find((entry) => entry.id === input.dreamId);
  if (existing) return existing;
  const draft: MemoryDraft = {
    anchor: false,
    arousal: input.dream.arousal,
    content: input.dream.content,
    date: localDateKey(new Date(input.now)),
    digested: true,
    domain: '日常',
    importance: 5,
    pinned: false,
    protected: false,
    recallCues: ['夜梦', ...input.dream.recallCues],
    resolved: false,
    source: 'night-dream',
    sourceType: 'automatic',
    tags: ['dream', '夜梦'],
    title: input.dream.title,
    type: 'feel',
    valence: input.dream.valence,
    period: 'dream',
  };
  const committed = await runBackupRestoreDataEpochCommit(input.dataEpoch, () => createMemory(draft));
  if (!committed.committed) return null;
  const memoryId = committed.value;
  await settleSavedMemoryUsage({ receipt: input.receipt, dataEpoch: input.dataEpoch, savedAt: Date.now() });
  let thoughtId: string | undefined;
  if (input.thought && canCommitBackupRestoreDataEpoch(input.dataEpoch)) {
    const saved = await (async () => {
      const nextThoughtState = await runBackupRestoreDataEpochCommit(input.dataEpoch, () => updateJunluoThoughtState((state, retainedThoughtIds) => createDreamThoughtState({
        retainedThoughtIds,
        dreamId: input.dreamId,
        now: input.now,
        state,
        thought: input.thought as DreamGenerationThought,
      })));
      return nextThoughtState.committed && nextThoughtState.value !== null;
    })().catch(() => false);
    if (saved) thoughtId = createDreamThoughtId(input.dreamId);
  }
  const entry: DreamEntry = {
    arousal: input.dream.arousal,
    content: input.dream.content,
    createdAt: input.now,
    id: input.dreamId,
    memoryId,
    recallCues: input.dream.recallCues,
    thoughtId,
    title: input.dream.title,
    valence: input.dream.valence,
  };
  await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
    const pending = await loadPendingDreams();
    await savePendingDreams([...pending, entry]);
  }).catch(() => undefined);
  return entry;
}

async function isAutomaticDreamRequestAllowed() {
  try { return isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy({ strict: true })); }
  catch { return false; }
}

export async function tryGenerateDream({
  apiKey,
  connection,
  force,
  now = Date.now(),
  profile = defaultAiProfile,
  rhythmSnapshot,
  admission,
}: {
  apiKey?: string;
  connection?: AiConnection;
  force?: boolean;
  now?: number;
  profile?: AiProfile;
  rhythmSnapshot?: RhythmSnapshot | null;
  admission?: AiRequestAdmission;
}) {
  if (!apiKey?.trim() || !connection || !rhythmSnapshot) return null;
  if (!await isAutomaticDreamRequestAllowed()) return null;
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return null;
  try { await checkAutomaticRequestCost({ connection, purpose: 'dream' }); }
  catch (error) { if (isAiCostDeferred(error)) return null; throw error; }
  const episode = getEligibleDreamSleepEpisode(rhythmSnapshot, now);
  if (!episode) return null;
  const state = await loadDreamState();
  if (!shouldAttemptDreamEpisode(state.lastAttemptEpisodeId, episode)) return null;
  const dreamChance = calculateDreamChance({ episode, rhythmSnapshot });
  if (!force && Math.random() >= dreamChance) {
    await saveDreamState({ ...state, lastAttemptEpisodeId: episode.id });
    return null;
  }
  const [materials, dynamicState] = await Promise.all([
    gatherDreamMaterials(now),
    buildDreamDynamicState(now, rhythmSnapshot),
  ]);
  const generated = await generateDreamWithAi({
    apiKey: apiKey.trim(),
    connection,
    dynamicState,
    materials,
    profile,
    onRequestStart: async assertTransportReady => {
      const begin = async () => {
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('dream-data-restored');
        // Do not move an expired sleep opportunity into a later cheap window.
        if (getEligibleDreamSleepEpisode(rhythmSnapshot, Date.now())?.id !== episode.id) throw new Error('dream-opportunity-expired');
        const latest = await loadDreamState();
        if (!shouldAttemptDreamEpisode(latest.lastAttemptEpisodeId, episode)) throw new Error('dream-already-attempted');
        if (!await isAutomaticDreamRequestAllowed()) throw new Error('dream-automatic-disabled');
        await saveDreamState({ ...latest, lastAttemptEpisodeId: episode.id });
      };
      const prepareAndCheck = async () => {
        await assertTransportReady?.();
        if (!await isAutomaticDreamRequestAllowed()) throw new Error('dream-automatic-disabled');
      };
      if (admission) await admission.beforeTransport(begin, prepareAndCheck);
      else { await checkAutomaticRequestCost({ connection, purpose: 'dream' }); await begin(); await prepareAndCheck(); }
      if (!await isAutomaticDreamRequestAllowed()) throw new Error('dream-automatic-disabled');
    },
  }).catch(() => null);
  if (!generated?.dream) return null;
  return storeDream({
    dream: generated.dream,
    dreamId: createDreamId(episode.id),
    now,
    thought: generated.thought,
    dataEpoch,
    receipt: createMemoryUsageReceipt(createDreamId(episode.id), materials.usageReferences()),
  }).catch(() => null);
}

export async function prepareDreamSurfaceInstruction(
  _userMessage: string,
): Promise<DreamSurfacePreparation | null> {
  const dreams = await loadPendingDreams();
  const matched = dreams[0];
  if (!matched) return null;
  return {
    dreamId: matched.id,
    instruction: `【夜梦浮现】
I 刚刚想起了这个梦：
${cleanText(matched.content, 240)}

这段梦与小仓鼠当前的话自然相连时，I 会在回应她时提起它。`,
    thoughtId: matched.thoughtId,
  };
}

export async function completeDreamSpeakThought(input: {
  dreamId: string;
  now?: number;
  thoughtId?: string;
}) {
  if (!input.thoughtId) return false;
  const occurredAt = input.now ?? Date.now();
  let found = false;
  const saved = await updateJunluoThoughtState((state, retainedThoughtIds) => {
    const thought = state.thoughts.find((entry) => (
      entry.thoughtId === input.thoughtId
      && entry.sourceKind === 'dream'
      && entry.sourceId === input.dreamId
      && entry.desireId === 'speak_to_you'
    ));
    if (!thought) return state;
    found = true;
    return recordJunluoThoughtAttempt({
      retainedThoughtIds,
      occurredAt, operationId: `${input.dreamId}:surface:speak-thought`, outcome: 'success',
      sourceId: input.dreamId, sourceKind: 'dream', state, thoughtId: input.thoughtId!,
    });
  });
  return saved !== null && found;
}

export async function commitDreamSurface(
  preparation: DreamSurfacePreparation,
  now = Date.now(),
) {
  const dreams = await loadPendingDreams();
  const matched = dreams.find((dream) => dream.id === preparation.dreamId);
  if (!matched) return false;
  if (matched.thoughtId) {
    await completeDreamSpeakThought({
      dreamId: matched.id,
      now,
      thoughtId: matched.thoughtId,
    });
  }
  await savePendingDreams(dreams.filter((dream) => dream.id !== preparation.dreamId));
  return true;
}
