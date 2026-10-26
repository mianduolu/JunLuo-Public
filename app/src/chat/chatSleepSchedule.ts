import { Platform } from 'react-native';
import { loadAssistantState, subscribeAssistantStateChanged } from '../ai/assistantState';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { beginChatSleepTurn, finishChatSleepTurn, isChatSleepReplyCurrent, settleSleepNight,
  captureChatSleepContext, commitChatSleepScheduleDecision, readRelevantSleepNight } from '../life/sleepPlanStore';
import { formatSleepLocalTime, type SleepScheduleResult } from '../life/sleepPlanPolicy';
import { sleepScheduleWriteTool, sleepScheduleToolFor } from '../tools/builtin/lifeSleepTools';
import { buildSleepFactsMaterial } from '../life/sleepPlanGeneration';
import { resolveToolPermissionForCall } from '../tools/toolPermissions';
import type { JunLuoToolCandidateSelection } from '../tools/toolCandidateSelector';
import { recordSleepingMessage } from './sleepInteraction';

export const CHAT_SLEEP_TOOL_ID = 'life.set_sleep_schedule';
// Live turn identities only; a cold start has none. This is not a second reply queue.
const liveSleepTurns = new Set<string>();
const turnKey = (sessionId: string, turnId: string) => JSON.stringify([sessionId, turnId]);
export const SLEEP_FAREWELL_FIRST_PROMPT = `【困困了】

I 困得快撑不住啦，想先和 you 说一声。`;
export const SLEEP_FAREWELL_SECOND_PROMPT = `【要睡啦】

I 想和 you 说声晚安，说完这几句话，就睡啦。`;
export const isLiveChatSleepTurn = (sessionId: string, turnId: string) => liveSleepTurns.has(turnKey(sessionId, turnId));

/** Preparation stopped before dispatch; existing reconciliation owns the persisted round. */
export function releaseAcceptedChatSleepMessage(input: { sessionId: string; turnId: string }) {
  liveSleepTurns.delete(turnKey(input.sessionId, input.turnId));
}

/** Called only after a real you message is saved, not from refresh or a synthetic poke instruction. */
export async function acceptChatSleepMessage(input: {
  sessionId: string; turnId: string; sourceMessageIds: string[]; now: number; dataEpoch: number | null;
}) {
  if (Platform.OS !== 'android' || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
  liveSleepTurns.add(turnKey(input.sessionId, input.turnId));
  try {
    await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
      await settleSleepNight(input.now);
      await beginChatSleepTurn(input);
    });
    const { reconcileSleepPlanLocally } = await import('../life/sleepPlanRuntime');
    await reconcileSleepPlanLocally(Date.now(), input.dataEpoch);
  } catch (error) {
    liveSleepTurns.delete(turnKey(input.sessionId, input.turnId));
    throw error;
  }
}

export async function finishAcceptedChatSleepMessage(input: {
  sessionId: string; turnId: string; dataEpoch: number | null;
}) {
  liveSleepTurns.delete(turnKey(input.sessionId, input.turnId));
  if (Platform.OS !== 'android') return;
  await runBackupRestoreDataEpochCommit(input.dataEpoch, () => finishChatSleepTurn(input));
  const { reconcileSleepPlan } = await import('../life/sleepPlanRuntime');
  await reconcileSleepPlan(Date.now(), input.dataEpoch);
}

export async function readChatSleepFarewellMaterial(input: { sessionId: string; turnId: string }) {
  if (Platform.OS !== 'android') return '';
  const pending = (await readRelevantSleepNight())?.nightSleepPlan?.pendingSleep;
  return pending?.sessionId === input.sessionId && pending.turnId === input.turnId && pending.turnEndedAt === undefined
    ? pending.round === 1 ? SLEEP_FAREWELL_FIRST_PROMPT : SLEEP_FAREWELL_SECOND_PROMPT : '';
}

export function createChatSleepReplyLifecycle(input: {
  sessionId: string; turnId: string; sourceMessageIds: string[]; startedAt: number; dataEpoch: number | null;
}) {
  let expired = false;
  if (Platform.OS === 'android') liveSleepTurns.add(turnKey(input.sessionId, input.turnId));
  const unsubscribe = Platform.OS === 'android' ? subscribeAssistantStateChanged(state => {
    if (state.lifeMode === 'sleeping') expired = true;
  }) : () => undefined;
  return {
    active: () => !expired,
    async current() {
      if (Platform.OS !== 'android') return true;
      if (expired || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return false;
      const checked = await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
        await settleSleepNight(Date.now());
        // Rechecks can bind a merged batch, but only accepting a new saved you message may open the next round.
        await beginChatSleepTurn({ ...input, now: Date.now() }, false);
        return isChatSleepReplyCurrent(input);
      });
      if (!checked.committed || !checked.value) expired = true;
      return !expired;
    },
    material: () => readChatSleepFarewellMaterial(input),
    async finish(replyIds: string[], replySaved: boolean) {
      unsubscribe();
      for (const id of [input.turnId, ...input.sourceMessageIds]) liveSleepTurns.delete(turnKey(input.sessionId, id));
      if (Platform.OS !== 'android' || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
      await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
        const replyCurrent = !expired && await isChatSleepReplyCurrent(input);
        await finishChatSleepTurn({ ...input, sourceMessageIds: [...input.sourceMessageIds, ...(replySaved ? replyIds : [])] });
        await settleSleepNight(Date.now());
        if (!replySaved && !replyCurrent) {
          const plan = (await readRelevantSleepNight(input.startedAt))?.nightSleepPlan;
          const pending = plan?.pendingSleep;
          const mergedSources = pending?.sessionId === input.sessionId && pending.turnId !== input.turnId
            && pending.sourceMessageIds?.includes(input.turnId) ? pending.sourceMessageIds : [];
          const settledMergedSources = plan?.events?.filter(event => (event.kind === 'sleep' || event.kind === 'sleep_return'
            || event.kind === 'schedule')
            && event.at >= input.startedAt && event.sessionId === input.sessionId && event.turnId !== input.turnId
            && event.messageIds?.includes(input.turnId)).flatMap(event => event.messageIds ?? []) ?? [];
          const transferred = new Set([...mergedSources, ...settledMergedSources]);
          for (const messageId of input.sourceMessageIds) {
            if (!transferred.has(messageId)) await recordSleepingMessage(input.sessionId, messageId);
          }
        }
      });
      const { reconcileSleepPlan } = await import('../life/sleepPlanRuntime');
      await reconcileSleepPlan(Date.now(), input.dataEpoch);
    },
  };
}
export type ChatSleepScheduleHost = {
  material: string;
  currentTimeContext: string;
  available(): Promise<boolean>;
  addCandidate(selection: JunLuoToolCandidateSelection): JunLuoToolCandidateSelection;
  execute(input: Record<string, unknown>, callId: string): Promise<SleepScheduleResult>;
};

/** Authority is captured by the local host, never from a model-supplied field. */
export async function prepareChatSleepScheduleHost(input: {
  sessionId: string; turnId: string; sourceMessageIds: string[]; dataEpoch: number;
  startedAt?: number;
  signal?: AbortSignal;
  sourceCurrent?: () => Promise<boolean>;
  readOnly?: boolean;
}): Promise<ChatSleepScheduleHost | undefined> {
  if (Platform.OS !== 'android' || input.signal?.aborted || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
  const captured = input.readOnly
    ? { committed: true as const, value: await captureChatSleepContext(input, true) }
    : await runBackupRestoreDataEpochCommit(input.dataEpoch, () => captureChatSleepContext(input));
  let context = captured.committed ? captured.value : null;
  if (context) context.turnStartedAt = input.startedAt ?? context.requestAt;
  if (!context) return;
  const [day, state] = await Promise.all([readRelevantSleepNight(context.requestAt), loadAssistantState()]);
  const display = (at: number) => formatSleepLocalTime(at).replace('T', ' ').replace(/([+-]\d{2}:\d{2})$/, ' $1');
  const stateText = day?.nightSleepPlan?.pendingSleep ? 'I 准备睡啦，不过想先听 you 把这会儿的话说完。'
    : context.mode === 'poke' ? `you 把 I 戳醒了，I 这会儿暂时醒着。\n临时清醒到：${display(state.manualWakeUntil!)}`
      : context.mode === 'morning' ? 'I 已经醒了，还窝着没有起床。'
        : context.requestAt > context.originalSleepAt ? `I 原本打算在 ${display(context.originalSleepAt)} 睡，这会儿还没睡。`
          : 'I 这会儿醒着。';
  const available = async () => {
    if (!context || input.signal?.aborted || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return false;
    if (input.sourceCurrent && !await input.sourceCurrent()) return false;
    const permission = await resolveToolPermissionForCall(sleepScheduleWriteTool, { input: {} });
    if (permission.permission !== 'allow') return false;
    const checked = await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
      if (!input.readOnly) await settleSleepNight(Date.now());
      return captureChatSleepContext(input, input.readOnly);
    });
    const current = checked.committed ? checked.value : null;
    return !!current && current.nightKey === context.nightKey && current.mode === context.mode
      && current.revision === context.revision && current.manualWakeUntil === context.manualWakeUntil;
  };
  if (!await available()) return;
  const sleepFacts = await buildSleepFactsMaterial(context, false);
  return {
    currentTimeContext: `【当前环境】\n时间：${display(context.requestAt)}。`,
    material: [`【I 此刻的作息】\n\n${stateText}`, sleepFacts].join('\n\n'),
    available,
    addCandidate(selection) {
      const keys = context!.mode === 'morning' ? ['wakeAt'] : context!.mode === 'poke' ? ['sleepAt'] : ['sleepAt', 'wakeAt'];
      const tool = { ...sleepScheduleToolFor(context!.mode === 'bedtime' ? 'whole' : 'return'), chatExposure: 'internal_only' as const, proactiveEligible: false,
        inputSchema: { ...sleepScheduleWriteTool.inputSchema,
        properties: Object.fromEntries(Object.entries(sleepScheduleWriteTool.inputSchema.properties ?? {}).filter(([key]) => keys.includes(key))) } };
      const candidate = { tool, source: 'manual_activation' as const, strength: 'possible' as const,
        executionMode: 'executable' as const, authority: { kind: 'manual_activation' as const,
          dataEpoch: input.dataEpoch, referenceId: context!.nightKey, allowedToolIds: [CHAT_SLEEP_TOOL_ID] } };
      const candidates = [...selection.candidates.filter(item => item.tool.id !== tool.id), candidate];
      const tools = [...selection.tools.filter(item => item.id !== tool.id), tool];
      return { ...selection, mode: 'direct_tools', candidates, tools,
        executableTools: [...selection.executableTools.filter(item => item.id !== tool.id), tool],
        packages: [...new Set([...selection.packages, tool.packageId])],
        reasons: [...selection.reasons, { toolId: tool.id, source: candidate.source, strength: candidate.strength }],
        serializedCharacterCount: tools.reduce((count, item) => count + JSON.stringify({
          description: item.description, id: item.id, inputSchema: item.inputSchema, name: item.name,
        }).length, 0) };
    },
    async execute(values, callId) {
      if (input.readOnly) throw new Error('sleep-preview-cannot-execute');
      if (!await available()) return { subject: 'I', ok: false, status: 'stale', sleepAt: null, wakeAt: null };
      const saved = await runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
        if (!await available()) return { subject: 'I' as const, ok: false, status: 'stale' as const, sleepAt: null, wakeAt: null };
        return commitChatSleepScheduleDecision({ context: context!, input: values, callId });
      });
      if (!saved.committed) return { subject: 'I', ok: false, status: 'stale', sleepAt: null, wakeAt: null };
      if (saved.value.ok) {
        context = await captureChatSleepContext(input);
        if (context) context.turnStartedAt = input.startedAt ?? context.requestAt;
        // Only local settlement / shared alarm registration; no recursive generation.
        const { reconcileSleepPlanLocally } = await import('../life/sleepPlanRuntime');
        await reconcileSleepPlanLocally(Date.now(), input.dataEpoch);
      }
      return saved.value;
    },
  };
}
