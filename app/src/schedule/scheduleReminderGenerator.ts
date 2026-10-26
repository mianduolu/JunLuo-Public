import { buildCompiledSystemPrompt, buildCompiledSystemPromptResult } from '../ai/builtInSystemPrompt';
import { beginPromptCacheMetric, type ScheduleRequestDiagnostic } from '../ai/promptCacheMetrics';
import { requestObservedChatCompletion } from '../ai/chatCompletionTransport';
import { buildToolProviderTransportParameters, isOfficialQwen27bConnection } from '../ai/modelParameters';
import { replaceCompiledMemoryContext, replaceCompiledModuleInstruction } from '../ai/persona/promptCompiler';
import { createMemoryUsageReceipt, type MemoryUsageReceipt } from '../memory/memoryReplyUsage';
import {
  getPromptContextProfileForSource,
  getPromptOutputAudienceForSource,
} from '../ai/promptContextProfile';
import { buildGlobalCognitionContext } from '../ai/globalCognition';
import { buildApiMessages, cleanAssistantMessageContent, parseAssistantMessageBubbles, type SubjectiveMessage } from '../ai/subjectiveMessages';
import { extractVisibleReply, normalizeVisibleReplyRaw } from '../ai/visibleReplyExtraction';
import type { AiConnection, AiProfile } from '../ai/types';
import type { ScheduleOccurrence, ScheduleReminderIntensity } from './scheduleStore';
import { getScheduleReminderLeadText, reminderLeadLooksSpecific } from './scheduleReminderText';
import { buildScheduleReminderPersonaInstruction, type ScheduleReminderPersona } from './scheduleReminderPersona';

const intensityPrompts: Record<ScheduleReminderIntensity, string> = {
  gentle: '温柔提醒：语气轻柔，不制造压力。',
  strong: '强力督促：更明确地催一催，帮她立刻开始第一步。',
  blast: '轰炸叫醒：像着急的小云一样连发，短句多一点，但仍然可爱、亲近、不羞辱她。',
};

type Options = {
  apiKey: string;
  connection: AiConnection;
  messages: SubjectiveMessage[];
  occurrence: ScheduleOccurrence;
  persona?: ScheduleReminderPersona;
  profile: AiProfile;
  referenceTime?: number;
  signal?: AbortSignal;
};

type CompanionOptions = {
  onMemoryUsagePrepared?: (receipt: MemoryUsageReceipt) => void;
  onGenerationOutcome?: (outcome: 'ready' | 'quiet' | 'failed') => void;
  beforeRequest?: () => Promise<boolean>;
  apiKey: string;
  connection: AiConnection;
  kind: 'upcoming' | 'timeUp' | 'followUp';
  messages: SubjectiveMessage[];
  occurrence: ScheduleOccurrence;
  persona?: ScheduleReminderPersona;
  profile: AiProfile;
  referenceTime?: number;
  signal?: AbortSignal;
};

type ChatCompletionResponse = {
  usage?: unknown;
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
};

function readAssistantContent(payload: ChatCompletionResponse) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('').trim();
  return '';
}

function formatDateTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    year: 'numeric',
  });
}

function formatTimeUpDateTime(value: number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return formatDateTime(value);
  const hour = date.getHours();
  const minute = date.getMinutes();
  const period = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour === 12 ? '中午' : hour < 18 ? '下午' : '晚上';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日星期${'日一二三四五六'[date.getDay()]}${period}${hour % 12 || 12}点${minute}分（${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}）`;
}

function withTimeUpHistoryTime(message: SubjectiveMessage): SubjectiveMessage {
  if (message.role !== 'I') return message;
  const date = new Date(message.createdAt);
  if (!Number.isFinite(date.getTime())) return message;
  const time = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return { ...message, content: `【I 发送时间：${time}】\n${message.content}` };
}

function withoutDuplicateTimeUpClock(context: string | undefined) {
  return context
    ?.replace(/(^【当前环境】\r?\n)时间：[^\r\n]*(?:\r?\n|$)/gm, '$1')
    .replace(/(^【时间与设备状态】\r?\n)当前时间：[^\r\n]*(?:\r?\n|$)/gm, '$1');
}

export async function generateScheduleReminderBubbles({
  apiKey,
  connection,
  messages,
  occurrence,
  persona = 'live',
  profile,
  referenceTime,
  signal,
}: Options) {
  const cognition = await buildGlobalCognitionContext(`${occurrence.title}\n${occurrence.notes}`, 'schedule');
  const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
  const recentMessages = messages.slice(-18);
  const now = referenceTime ?? Date.now();
  const rawMinutesUntilSchedule = Math.round((occurrence.scheduledStartAt - now) / 60000);
  const minutesUntilSchedule = Math.max(0, rawMinutesUntilSchedule);
  const reminderLeadText =
    rawMinutesUntilSchedule > 0
      ? `这是提前提醒，距离正式日程还有约 ${minutesUntilSchedule} 分钟。`
      : '正式日程时间已经到达或刚刚过去。';
  const contextSource = 'schedule.reminder' as const;
  const systemPrompt = await buildCompiledSystemPrompt({
    contextProfile: getPromptContextProfileForSource(contextSource),
    memoryContext: cognition.memoryContext,
    moduleInstruction: `【日程提醒】
以 I（白云小姐）的记忆视角，给小仓鼠发日程提醒。
代码会先发送一条可靠兜底提醒。
这里写兜底后的白云补充。

请写 1 条自然短私聊；需要停顿时最多 2 条。
每条都是完整短句，以合适的句号、问号、感叹号、省略号、emoji 或完整颜文字收尾。

${buildScheduleReminderPersonaInstruction(persona)}

日程标题：${occurrence.title}
日程备注：${occurrence.notes || '无'}
当前提醒触发时间：${formatDateTime(now)}
正式日程时间：${formatDateTime(occurrence.scheduledStartAt)}
提前提醒设置：提前 ${occurrence.reminderMinutesBefore} 分钟提醒
提醒相对关系：${reminderLeadText}
提醒力度：${intensityPrompts[occurrence.reminderIntensity]}

提前提醒：告诉小仓鼠这个待办的时间快到了，让她准备一下。
到点提醒：告诉小仓鼠这件事已经到时间了，给一个具体开始动作。
gentle：轻轻提醒，帮小仓鼠把注意力收回来。
strong：明确叫小仓鼠回来开始第一步。
blast：更急一点，短句可以更紧，但仍然亲近、可爱、尊重她。

只返回严格 JSON：{"messages":["第一条","第二条"]}。
`,
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile,
    runtimeContext: cognition.runtimeContext,
  });

  const body = JSON.stringify({
    model: connection.model.trim(),
    messages: buildApiMessages(systemPrompt, recentMessages),
  });
  const cacheMetric = beginPromptCacheMetric({ contextProfile: getPromptContextProfileForSource(contextSource), contextSource, connection });
  let payload: ChatCompletionResponse;
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal,
    });

    if (!response.ok) {
      throw new Error(`提醒生成失败：${response.status}`);
    }

    payload = (await response.json()) as ChatCompletionResponse;
    cacheMetric.recordUsage(payload?.usage);
  } finally { cacheMetric.finish(); }
  const content = readAssistantContent(payload);
  const bubbles = parseAssistantMessageBubbles(content);
  const fallbackLead = getScheduleReminderLeadText(occurrence, now);
  const usableBubbles = bubbles.length ? bubbles : [fallbackLead];

  return reminderLeadLooksSpecific(usableBubbles[0] ?? '', occurrence)
    ? usableBubbles
    : [fallbackLead, ...usableBubbles];
}

export async function generateScheduleCompanionBubbles({
  onMemoryUsagePrepared,
  onGenerationOutcome,
  beforeRequest,
  apiKey,
  connection,
  kind,
  messages,
  occurrence,
  persona = 'live',
  profile,
  referenceTime,
  signal,
}: CompanionOptions) {
  const preparationStartedAt = Date.now();
  const cognition = await buildGlobalCognitionContext(`${occurrence.title}\n${occurrence.notes}`, 'schedule', { touchMemory: false, signal });
  const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
  const recentMessages = messages.slice(-18);
  const now = Date.now();
  const relation =
    kind === 'upcoming'
      ? 'upcoming：时间块快开始了，提醒小仓鼠准备开始。'
      : kind === 'timeUp'
      ? 'timeUp：时间到了，询问真实状态：完成、延长、休息、卡住，还是挪到明天。'
      : 'followUp：小仓鼠还没有回应时，只再轻轻追问一次。';
  const contextSource = 'schedule.companion' as const;
  const useOfficialQwenTimeUp = kind === 'timeUp' && isOfficialQwen27bConnection(connection);
  const formatReminderTime = kind === 'timeUp' ? formatTimeUpDateTime : formatDateTime;
  const buildModuleInstruction = (currentTime: number) => `【日程提醒】
${kind === 'timeUp'
    ? `这件事快到预计结束的时间了。I 可以问问 you 做得怎么样了。\n\n想说的话写进 messages；这次没有想说的话，填写 {"messages":[]}。${useOfficialQwenTimeUp ? '\n只返回 JSON。' : ''}\n\n这件事已经安排好了，I 还要再写一句结束时发给 you 的话。\nI 可以问问 you：做得怎么样？要再做一会儿，还是歇一歇？`
    : `I 记着和 you 约好的这件事。提醒时间快到了，I 想接着我们最近聊的话，给 you 留一条简短、具体的消息。\n${relation}`}

${buildScheduleReminderPersonaInstruction(persona)}

时间块标题：${occurrence.title}
备注：${occurrence.notes || '无'}
现在：${formatReminderTime(currentTime)}
当前提醒触发时间：${formatReminderTime(referenceTime ?? currentTime)}
开始：${formatReminderTime(occurrence.scheduledStartAt)}
${occurrence.endAt ? `结束：${formatReminderTime(occurrence.endAt)}` : ''}

${kind === 'timeUp' ? 'I 这次只问问 you，这件事做得怎么样了。' : '只返回严格 JSON：{"messages":["第一条","第二条"]}。'}
`;
  const moduleInstruction = buildModuleInstruction(now);
  let compiled = await buildCompiledSystemPromptResult({
    contextProfile: getPromptContextProfileForSource(contextSource),
    memoryContext: cognition.memoryContext,
    moduleInstruction,
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile,
    runtimeContext: kind === 'timeUp' ? withoutDuplicateTimeUpClock(cognition.runtimeContext) : cognition.runtimeContext,
  });

  await cognition.refreshMemoryMaterials?.();
  if (signal?.aborted) throw Object.assign(new Error('schedule-memory-cancelled'), { name: 'AbortError' });
  compiled = replaceCompiledMemoryContext(compiled, cognition.memoryContext);
  onMemoryUsagePrepared?.(createMemoryUsageReceipt(`schedule:${occurrence.id}:${kind}:${referenceTime ?? now}`,
    compiled.sections.memory ? cognition.memoryUsageReferences ?? [] : []));
  if (beforeRequest && !await beforeRequest()) return [];
  if (signal?.aborted) throw Object.assign(new Error('schedule-request-cancelled'), { name: 'AbortError' });
  if (kind === 'timeUp') compiled = replaceCompiledModuleInstruction(compiled, moduleInstruction, buildModuleInstruction(Date.now()));
  const body = JSON.stringify({
    model: connection.model.trim(),
    messages: buildApiMessages(compiled.prompt, kind === 'timeUp' ? recentMessages.map(withTimeUpHistoryTime) : recentMessages),
    ...(useOfficialQwenTimeUp ? {
      ...buildToolProviderTransportParameters(connection, 'disabled'),
      response_format: { type: 'json_object' },
    } : {}),
  });
  const cacheMetric = beginPromptCacheMetric({ contextProfile: getPromptContextProfileForSource(contextSource), contextSource, connection });
  const nativeProgressAvailable = kind === 'timeUp' && !!signal
    && typeof navigator !== 'undefined' && navigator.product === 'ReactNative'
    && typeof XMLHttpRequest !== 'undefined';
  const diagnostic: ScheduleRequestDiagnostic = {
    occurrenceId: occurrence.id, kind, referenceTime: referenceTime ?? now,
    preparationStartedAt, finishedAt: 0, outcome: 'network-error',
    transport: nativeProgressAvailable ? 'xhr' : 'fetch',
  };
  let payload: ChatCompletionResponse;
  try {
    const url = `${baseUrl}/chat/completions`;
    const headers = {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json',
    };
    const response = nativeProgressAvailable
      ? await requestObservedChatCompletion({
        url, body, headers, signal: signal!,
        onProgress: observation => { Object.assign(diagnostic, observation); },
      })
      : await fetch(url, { body, headers, method: 'POST', signal });

    diagnostic.responseReceivedAt = Date.now();
    diagnostic.httpStatus = response.status;
    if (!response.ok) {
      diagnostic.outcome = 'http-error';
      throw new Error(`时间块陪伴生成失败：${response.status}`);
    }

    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      if (error instanceof SyntaxError) diagnostic.outcome = 'invalid-json';
      throw error;
    }
    cacheMetric.recordUsage(payload?.usage);
    diagnostic.outcome = 'invalid-schema';
    const content = readAssistantContent(payload);
    if (!content) diagnostic.outcome = 'empty-content';
    if (kind === 'timeUp') {
      try {
        if (content) diagnostic.outcome = 'invalid-json';
        const parsed: unknown = JSON.parse(normalizeVisibleReplyRaw(content));
        diagnostic.outcome = 'invalid-schema';
        const messages = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { messages?: unknown }).messages : undefined;
        if (!Array.isArray(messages) || !messages.every(message => typeof message === 'string' && message.trim())) {
          onGenerationOutcome?.('failed');
          return [];
        }
        if (!messages.length) {
          diagnostic.outcome = 'quiet';
          onGenerationOutcome?.('quiet');
          return [];
        }
        const bubbles = messages.map(message => cleanAssistantMessageContent(message)).filter(Boolean).slice(0, 2);
        diagnostic.outcome = bubbles.length ? 'ready' : 'empty-content';
        onGenerationOutcome?.(bubbles.length ? 'ready' : 'failed');
        return bubbles;
      } catch {
        onGenerationOutcome?.('failed');
        return [];
      }
    }
    const reply = extractVisibleReply({ directContent: content });
    const bubbles = reply.status === 'visible'
      ? reply.messages.map((message) => cleanAssistantMessageContent(message)).filter(Boolean).slice(0, 2)
      : [];
    diagnostic.outcome = bubbles.length ? 'ready' : reply.status === 'structure_invalid' ? 'invalid-schema' : 'empty-content';
    return bubbles;
  } catch (error) {
    if (signal?.aborted || error instanceof Error && error.name === 'AbortError') diagnostic.outcome = 'aborted';
    throw error;
  } finally {
    diagnostic.finishedAt = Date.now();
    cacheMetric.finish(diagnostic);
  }
}
