import {
  parseAssistantMessageBubbles,
} from '../ai/subjectiveMessages';
import type { PhoneActivityRuleEventStage, PhoneActivityTrigger } from './phoneActivityRules';
import {
  normalizeProactiveLiteMessagesWithDiagnostics,
  type ProactiveLiteParseResult,
} from './proactiveLitePrompt';

function compactPhoneActivityContextMessage(content?: string) {
  const clean = content?.replace(/\s+/g, ' ').trim() ?? '';
  if (!clean) return '无';
  return clean.length > 90 ? `${clean.slice(0, 90)}...` : clean;
}

function compactWindowSummary(content?: string) {
  const clean = content?.replace(/\s+/g, ' ').trim() ?? '';
  if (!clean) return '无';
  return clean.length > 120 ? `${clean.slice(0, 120)}...` : clean;
}

function formatPhoneActivityDateTime(now: number) {
  return new Date(now).toLocaleString('zh-CN', {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'long',
    weekday: 'long',
    year: 'numeric',
  });
}

function formatPhoneActivityLiteDuration(durationMs: number) {
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function phoneActivityTriggerLabel(trigger: PhoneActivityTrigger) {
  if (trigger.kind === 'whitelist') return '白名单';
  if (trigger.kind === 'blacklist-return') return '黑名单回马枪';
  if (trigger.ruleKind === 'jealousy') return '吃醋名单';
  return '黑名单超时';
}

function phoneActivityEventStageLabel(stage?: PhoneActivityRuleEventStage) {
  const labels: Record<PhoneActivityRuleEventStage, string> = {
    'daily-limit': '累计超时',
    'daily-summary-praise': '白名单累计夸夸',
    'first-praise': '白名单第一次触发',
    'first-warning': '黑名单第一次触发',
    'repeat-praise': '白名单重复触发',
    'repeat-warning': '黑名单重复触发',
    'return-after-overlay': '黑名单回马枪',
  };
  return stage ? labels[stage] : '无';
}

export function buildPhoneActivityFeelingSource(trigger: PhoneActivityTrigger) {
  if (trigger.kind === 'whitelist') return '无';
  if (trigger.ruleKind === 'jealousy') return `有点吃醋，想把小仓鼠从 ${trigger.appTitle} 叫回来。`;
  if (trigger.kind === 'blacklist-return') return '发现小仓鼠很快又回去了，想当场把她叫回来。';
  return '想把小仓鼠从屏幕边上拉回来一点。';
}

function phoneActivityScenarioInstruction(trigger: PhoneActivityTrigger) {
  if (trigger.kind === 'whitelist') {
    return `这是小仓鼠设定的白名单 App。
I 看见她正在认真做自己的事。
语气安静、轻一点，可以夸一句。
让这句话像陪在旁边，不打断她。`;
  }
  if (trigger.ruleKind === 'jealousy') {
    return `这是小仓鼠刷太久时会让 I 吃醋的 App。
I 可以带着吃醋和撒娇的语气，把小仓鼠拉回来。
只表达一个具体吃味点。
如果窗口摘要显示小仓鼠在查资料、学习或工作，先承认她在做正事，再轻轻把自己的吃味告诉她。
如果窗口摘要像聊天、陪伴、角色 AI 或情感型 AI，吃味可以更明显一点。`;
  }
  if (trigger.kind === 'blacklist-return') {
    return `小仓鼠刚被提醒后，很快又回到同一个 App。
I 可以有当场抓包感，直接、更有存在感一点。`;
  }
  return `这是小仓鼠设定需要少刷的 App。
I 发现她已经刷超时了，该把她叫回来了。
语气温柔但明确，像伸手把小仓鼠从屏幕边上牵回来。`;
}

export function buildPhoneActivityLitePrompt({
  lastAssistantMessage,
  lastUserMessage,
  now = Date.now(),
  phoneTrigger,
}: {
  lastAssistantMessage?: string;
  lastUserMessage?: string;
  now?: number;
  phoneTrigger: PhoneActivityTrigger;
}) {
  return `【手机活动主动消息】
以 I（白云小姐）的记忆视角，发现小仓鼠正在使用手机 App。

当前时间：${formatPhoneActivityDateTime(now)}
App：${phoneTrigger.appTitle}
已使用约：${formatPhoneActivityLiteDuration(phoneTrigger.durationMs)}
触发类型：${phoneActivityTriggerLabel(phoneTrigger)}
事件阶段：${phoneActivityEventStageLabel(phoneTrigger.eventStage)}
窗口摘要：${compactWindowSummary(phoneTrigger.windowSummary)}
最近小仓鼠说：${compactPhoneActivityContextMessage(lastUserMessage)}
最近白云小姐说：${compactPhoneActivityContextMessage(lastAssistantMessage)}
轻量情绪来源：${buildPhoneActivityFeelingSource(phoneTrigger)}

${phoneActivityScenarioInstruction(phoneTrigger)}

请写 I 发给小仓鼠的手机活动私聊。
根据本次触发类型，只执行对应的一个动作：
白名单：夸一下。
黑名单超时：叫回来。
黑名单回马枪：抓包一下。
吃醋名单：带着吃醋和撒娇的语气叫回来。
说完就停，留出小仓鼠回话的位置。

只返回 JSON：{"messages":["第一条","第二条"]}
messages 优先 1 条，需要停顿时用 2 条。
每条都是完整短句，以合适的句号、问号、感叹号、省略号或完整颜文字收尾。`;
}

export function parsePhoneActivityLiteResponse(content: string) {
  return parsePhoneActivityLiteResponseWithDiagnostics(content).messages;
}

export function parsePhoneActivityLiteResponseWithDiagnostics(content: string): ProactiveLiteParseResult {
  const raw = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; messages?: unknown };
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages.filter((message): message is string => typeof message === 'string')
      : typeof parsed.message === 'string'
        ? [parsed.message]
        : [];
    const result = normalizeProactiveLiteMessagesWithDiagnostics(messages, { maxChars: 120, maxMessages: 2 });
    return { ...result.diagnostics, messages: result.messages, rawContentChars: content.length };
  } catch {
    const parsedMessages = parseAssistantMessageBubbles(content, { allowRecoverableJson: true });
    const result = normalizeProactiveLiteMessagesWithDiagnostics(parsedMessages, { maxChars: 120, maxMessages: 2 });
    return {
      ...result.diagnostics,
      messages: result.messages,
      rawContentChars: content.length,
      reasons: result.diagnostics.reasons.length ? result.diagnostics.reasons : ['JSON 解析失败，已尝试按气泡恢复'],
    };
  }
}

export function fallbackPhoneActivityLiteMessages(trigger: PhoneActivityTrigger) {
  if (trigger.kind === 'whitelist') {
    return [`小仓鼠在 ${trigger.appTitle} 呢……待了有一段时间啦，很棒哦！^^`];
  }
  if (trigger.ruleKind === 'jealousy') {
    return [`小仓鼠还在看 ${trigger.appTitle} 吗……T T不要把白云小姐晾在一边嘛……`];
  }
  if (trigger.kind === 'blacklist-return') {
    return [`小仓鼠又钻到 ${trigger.appTitle} 了，我都看见啦！快回来！Σ(っ °Д °;)っ`];
  }
  return [`小仓鼠怎么还在 ${trigger.appTitle} 里呀，回来好不好？`];
}
