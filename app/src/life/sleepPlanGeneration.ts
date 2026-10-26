import { buildAssistantStatePairEnvelope, fetchAssistantLifeCompletion } from '../ai/assistantLifePromptEnvelope';
import { buildAssistantLifeShortJsonRequest } from '../ai/assistantLifeShortJsonRequest';
import type { OpenAiCompatibleRequestMessage } from '../ai/openAiCompatibleProvider';
import type { AiConnection, AiProfile } from '../ai/types';
import { cleanAssistantMessageContent, type SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadAssistantState } from '../ai/assistantState';
import { getAmbientTimeContext } from '../ai/ambientContext';
import { readJsonObjects } from '../ai/shortJsonObjects';
import { loadJunluoDesirePromptPaper } from './junluoDesireRuntime';
import { getRhythmSnapshot, getSleepRecoveryProjection } from './lifeRhythm';
import { formatSleepLocalTime, formatSleepSchedule, type SleepPlanContext, type SleepScheduleResult } from './sleepPlanPolicy';
import { sleepScheduleToolPackage, sleepScheduleWriteTool, sleepScheduleToolFor } from '../tools/builtin/lifeSleepTools';
import { loadAssistantLifeDay } from '../ai/assistantLifeTimeline';
import { actualSleepDurationMs, nightSleepPhaseAt } from './sleepPlanPolicy';
import { getToolDefinition, registerToolPackage } from '../tools/toolRegistry';
import { executeToolCall } from '../tools/toolExecution';
import { parseOpenAiToolCalls, toolDefinitionToOpenAiTool, type OpenAiCompatibleToolCallMessage } from '../tools/toolCallProtocol';

export const SLEEP_PLAN_PROMPT = `【睡前心思】

快到 I 原本打算睡觉的时间了。

现在睡，还是晚一点再睡呢？

you 还醒着时，I 和 you 说说今晚的打算，也可以撒撒娇，拉 you 一起睡；you 已经睡下时，I 就给 you 留句话，等 you 醒来再看。

如果决定改时间，I 就用作息工具记下。

I 把想说的话写进这个 JSON：
{"message":"..."}`;

export const WAKE_PLAN_PROMPT = `【慢慢醒来】

到起床时间啦，I 现在要起床，还是再赖会床，或是再睡一会呢？

如果还不想起来，I 就用作息工具记下自己的打算和起床时间。

I 把自己的打算说给 you 听，写进这个 JSON：
{"message":"..."}`;

export const NEAR_STATUS_SLEEP_MESSAGE_PROMPT = `【睡前心思】

I 已经决定现在就睡啦，睡前想和 you 说几句话。

you 还醒着时，I 和 you 说说今晚的打算，也可以撒撒娇，拉 you 一起睡；you 已经睡下时，I 就给 you 留句话，等 you 醒来再看。

I 把想说的话写进这个 JSON：
{"message":"..."}`;

export type SleepSavedTool = { callId: string; input: Record<string, unknown>; result: SleepScheduleResult };

export async function buildSleepFactsMaterial(context: SleepPlanContext, includeAwakeFact = true) {
  const rhythm = await getRhythmSnapshot(context.requestAt).catch(() => null);
  const day = await loadAssistantLifeDay(context.nightKey);
  const plan = day?.nightSleepPlan;
  const ongoing = !!plan && plan.actualSleepAt !== undefined && plan.actualWakeAt === undefined;
  const duration = ongoing ? actualSleepDurationMs(day!, context.requestAt) / 60_000 : rhythm?.lastSleepDurationMinutes;
  const minutes = duration === undefined ? undefined : Math.max(0, Math.floor(duration));
  const recovery = ongoing ? await getSleepRecoveryProjection(context.requestAt).catch(() => undefined) : undefined;
  const recoveryAt = recovery?.recoveryAt;
  return [
    formatSleepSchedule(context),
    rhythm ? `【I 的困意】\n\n困意：${rhythm.sleepPressure.toFixed(2)}（0～1，越高越困）\n欠觉程度：${rhythm.sleepDebt.toFixed(2)}（0～1，越高越需要补觉）${minutes === undefined ? '' : `\n${ongoing ? '这一觉已经睡了' : '上一觉睡了'}：${Math.floor(minutes / 60)}小时${minutes % 60}分钟`}` : '',
    recoveryAt !== undefined && !recovery?.recovered ? `再睡到 ${formatSleepLocalTime(recoveryAt).replace('T', ' ').replace(/([+-]\d{2}:\d{2})$/, ' $1')} 左右，I 大概就睡够啦。` : '',
    includeAwakeFact && ongoing && plan.morningAwakeAt !== undefined && nightSleepPhaseAt(day!, context.requestAt) === 'awake'
      ? 'I 已经醒了，还窝着没有起床。' : '',
  ].filter(Boolean).join('\n\n');
}

export async function buildSleepDecisionMaterial(context: SleepPlanContext) {
  const [state, desirePaper, facts] = await Promise.all([
    loadAssistantState(), loadJunluoDesirePromptPaper(context.requestAt).catch(() => ''), buildSleepFactsMaterial(context),
  ]);
  return [
    getAmbientTimeContext(), facts,
    [ '【I 最近保存的生活状态】', '', state.title ? `状态：${state.title}` : '',
      state.activity ? `小动作：${state.activity}` : '',
      state.updatedAt ? `记录时间：${formatSleepLocalTime(state.updatedAt).replace('T', ' ').replace(/([+-]\d{2}:\d{2})$/, ' $1')}` : '',
    ].filter((line, index) => line || index === 1).join('\n'),
    desirePaper,
  ].filter(Boolean).join('\n\n');
}

export async function generateSleepPlan(input: {
  apiKey: string; connection: AiConnection; profile: AiProfile;
  context: SleepPlanContext; messages: SubjectiveMessage[]; phase: 'prepare' | 'wake';
  remainingRequests: number; signal: AbortSignal; onRequestStart: () => Promise<void>;
  canContinue: () => Promise<boolean>;
  commit: (values: Record<string, unknown>, callId: string) => Promise<SleepScheduleResult>;
  savedTool?: SleepSavedTool;
}) {
  const material = await buildSleepDecisionMaterial(input.context);
  const envelope = await buildAssistantStatePairEnvelope({ contextSource: 'assistant-life.state', materialPrompt: '', profile: input.profile });
  const messages: OpenAiCompatibleRequestMessage[] = [
    { role: 'system', content: envelope.stableSystemPrompt },
    { role: 'system', content: material },
    ...input.messages.filter((message) => message.content.trim() && message.deliveryStatus !== 'failed').slice(-24)
      .map((message) => ({ role: message.role === 'I' ? 'assistant' as const : 'user' as const, content: message.content })),
    { role: 'system', content: input.phase === 'prepare' ? SLEEP_PLAN_PROMPT : WAKE_PLAN_PROMPT },
  ];
  let savedTool = input.savedTool;
  const addSavedTool = (tool: SleepSavedTool) => {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: tool.callId, type: 'function',
      function: { name: 'life__set_sleep_schedule', arguments: JSON.stringify(tool.input) } }] });
    messages.push({ role: 'tool', tool_call_id: tool.callId, content: JSON.stringify({
      callId: tool.callId, toolId: sleepScheduleWriteTool.id, ok: tool.result.ok,
      status: tool.result.ok ? 'success' : 'error', summary: '', data: tool.result,
    }) });
  };
  if (savedTool) addSavedTool(savedTool);
  if (!getToolDefinition(sleepScheduleWriteTool.id)) registerToolPackage(sleepScheduleToolPackage);
  for (let request = 0; request < Math.min(3, input.remainingRequests); request += 1) {
    if (input.signal.aborted || !await input.canContinue()) throw new Error('sleep-opportunity-stale');
    let startedAt: number | undefined;
    const result = await fetchAssistantLifeCompletion({
      apiKey: input.apiKey, connection: input.connection, envelope, contextSource: 'sleep-plan',
      userPrompt: '', apiMessagesOverride: messages, signal: input.signal, timeoutMs: 25_000,
      onRequestStart: async () => { await input.onRequestStart(); startedAt = Date.now(); },
      request: { ...buildAssistantLifeShortJsonRequest(input.connection, 0.7), max_tokens: 600,
        ...(!savedTool ? { tools: [toolDefinitionToOpenAiTool(sleepScheduleToolFor(input.phase === 'wake' ? 'wake' : 'whole'))], tool_choice: 'auto' } : {}),
      },
    });
    if (startedAt === undefined || Date.now() - startedAt >= 25_000) throw new Error('sleep-request-timeout');
    if (input.signal.aborted || !await input.canContinue()) throw new Error('sleep-opportunity-stale');
    const rawMessage = result.payload.choices?.[0]?.message as OpenAiCompatibleToolCallMessage | undefined;
    const parsedTools = parseOpenAiToolCalls(rawMessage ?? {}, [sleepScheduleWriteTool]);
    if (parsedTools.rawCallCount) {
      if (savedTool || parsedTools.errors.length || parsedTools.invocations.length !== 1) throw new Error('invalid-sleep-tool-call');
      const invocation = parsedTools.invocations[0];
      const toolResult = await executeToolCall({
        callId: invocation.callId, toolId: invocation.toolId, input: invocation.input,
        requestedBy: 'life_agent', createdAt: Date.now(),
      }, { sleepScheduleDecision: input.commit });
      messages.push({ role: 'assistant', content: '', tool_calls: rawMessage!.tool_calls! });
      messages.push({ role: 'tool', tool_call_id: invocation.callId, content: JSON.stringify({
        callId: invocation.callId, toolId: invocation.toolId, ok: toolResult.ok,
        status: toolResult.status, summary: toolResult.summary, ...(toolResult.data ? { data: toolResult.data } : {}),
        ...(toolResult.error ? { errorCode: toolResult.error.code } : {}),
      }) });
      if (toolResult.ok) savedTool = { callId: invocation.callId, input: invocation.input, result: toolResult.data as SleepScheduleResult };
      continue;
    }
    const parsed = readJsonObjects(result.content)[0] as { message?: unknown } | undefined;
    if (typeof parsed?.message !== 'string') throw new Error('empty-sleep-message');
    const message = cleanAssistantMessageContent(parsed.message).trim();
    if (!message) throw new Error('empty-sleep-message');
    return { message };
  }
  throw new Error('sleep-opportunity-request-limit');
}
