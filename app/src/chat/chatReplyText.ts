import {
  cleanAssistantMessageContent,
  type FallbackDiagnosticKind,
  type FallbackDiagnostics,
  type GenerationDiagnostics,
  type SubjectiveMessage,
} from '../ai/subjectiveMessages';

const FAST_REPLY_PATTERN =
  /^(?:哈[哈啊]*|嗯+|哦+|好(?:的|呀|哒|啦)?|行|可以|收到|谢谢|谢啦|抱抱|在吗|早|早安|午安|晚安|嗨|hi|hello|嘿|诶|欸|？+|！+|[~～…。.，,、]+)$/i;
const CONTINUOUS_CHAT_WINDOW_MS = 2 * 60 * 1000;

export function shouldUseFastReplyPath(text: string, lastReplyAt: number) {
  const normalized = text.trim();
  if (!normalized) return true;
  if (FAST_REPLY_PATTERN.test(normalized)) return true;
  return normalized.length <= 8 && Date.now() - lastReplyAt < CONTINUOUS_CHAT_WINDOW_MS;
}

export const BAIYUN_RETRY_DRAFT_MAX_CHARS = 800;

export type BaiyunSubjectiveRetryInstructionOptions = {
  cleanedDraft: readonly string[];
  completedActionLabels?: readonly string[];
  existingInstruction?: string;
  missingItems?: readonly string[];
};

function truncateRetryDraft(text: string) {
  return Array.from(text).slice(0, BAIYUN_RETRY_DRAFT_MAX_CHARS).join('');
}

function escapeRetryDraftBoundary(text: string) {
  return text.replaceAll('<', '＜').replaceAll('>', '＞');
}

export function buildBaiyunSubjectiveRetryInstruction(
  options: BaiyunSubjectiveRetryInstructionOptions,
) {
  const draft = escapeRetryDraftBoundary(
    truncateRetryDraft(options.cleanedDraft.join('\n').trim()),
  );
  const completedActionLabels = [...new Set(
    (options.completedActionLabels ?? []).map((label) => label.trim()).filter(Boolean),
  )];
  const missingItems = [
    ...(options.missingItems ?? []).map((item) => item.trim()).filter(Boolean),
    options.existingInstruction?.trim() ?? '',
  ].filter(Boolean);
  return [
    ['【I 刚才想说的话】', '<draft>', draft, '</draft>'].join('\n'),
    completedActionLabels.length
      ? `【I 已经做到的】\n${completedActionLabels
        .map((label) => `${label}已经做到，可以保留。`)
        .join('\n')}`
      : '',
    `【I 还需要做好的】\n${missingItems.join('\n')}`,
    'I 保留其中自然、具体、亲近并且符合事实的部分，只把没做好的地方补好，再完整回应 you 这一轮。事实有误时直接改正；只有 I 确实做错或漏掉了什么时才道歉。',
    '正文只留下 I 真正想对 you 说的话。所有气泡连成同一次回应，后面的气泡延续前一句。',
  ].filter(Boolean).join('\n\n');
}

export function createFallbackDiagnostics(options: {
  kind: FallbackDiagnosticKind;
  reasons: string[];
  retryAttempted: boolean;
  templateFamilies?: FallbackDiagnostics['templateFamilies'];
  rawContentChars?: number;
  userTurnText: string;
  wasTruncated?: boolean;
}): FallbackDiagnostics {
  return {
    kind: options.kind,
    reasons: options.reasons.length ? options.reasons : ['未记录具体原因'],
    sensitiveContext: { isSensitive: false, severity: 'none', signals: [] },
    retryAttempted: options.retryAttempted,
    templateFamilies: options.templateFamilies?.length ? options.templateFamilies : undefined,
    rawContentChars: options.rawContentChars,
    wasTruncated: options.wasTruncated,
    createdAt: Date.now(),
  };
}

function describeFallbackKind(kind: FallbackDiagnosticKind) {
  if (kind === 'cleaned-empty') return '清洗后没有可发送内容';
  if (kind === 'quality-failed') return '普通质量失败';
  if (kind === 'safety-redline') return '安全红线';
  return '嘲笑保护';
}

function describeTemplateFamily(family: NonNullable<FallbackDiagnostics['templateFamilies']>[number]) {
  const labels: Record<NonNullable<FallbackDiagnostics['templateFamilies']>[number], string> = {
    'false-choice': '假性选择',
    'echo-confirmation': '回声式确认',
    'generic-comfort-stack': '泛化安慰堆叠',
    'model-self-disclosure': '模型自白',
    'no-pressure': '前置免责',
    'soft-exit': '关系撤退/柔性退场',
    'performative-companion': '口号式陪伴',
    'static-presence': '静态存在',
    'understanding-confirmation': '自我理解确认',
    'unsupported-past-fact': '事实声称红线',
    'unsupported-tool-completion': '无工具回执完成声明',
    'coined-verb-cliche': '生造动词/怪口癖',
    'user-correction-ignored': '未遵守用户纠正',
  };
  return labels[family] ?? family;
}

export function formatFallbackDiagnostics(diagnostics: FallbackDiagnostics) {
  return [
    `类型：${describeFallbackKind(diagnostics.kind)}`,
    `原因：${diagnostics.reasons.join('；')}`,
    diagnostics.templateFamilies?.length
      ? `模板族：${diagnostics.templateFamilies.map(describeTemplateFamily).join('、')}`
      : '',
    `敏感信号：${diagnostics.sensitiveContext.signals.length ? diagnostics.sensitiveContext.signals.join('、') : '无'}（${diagnostics.sensitiveContext.severity}）`,
    `是否重试：${diagnostics.retryAttempted ? '是' : '否'}`,
    `是否截断：${diagnostics.wasTruncated ? '是' : '否'}`,
    typeof diagnostics.rawContentChars === 'number' ? `原始长度：${diagnostics.rawContentChars} 字` : '',
  ].filter(Boolean).join('\n');
}

function describeGenerationSource(source: GenerationDiagnostics['source']) {
  const labels: Record<GenerationDiagnostics['source'], string> = {
    'agent-task': '一次性主动消息',
    'jealousy-dismissal': '吃醋关闭反应',
    'life-project-share': '生活片段',
    'nearby-world-active': '附近世界主动消息',
    'phone-activity': '手机活动',
    'proactive-message': '普通主动探头',
    'social-share': '社交分享返回',
    'web-voyage-share': '网页远游返回',
  };
  return labels[source] ?? source;
}

export function formatGenerationDiagnostics(diagnostics: GenerationDiagnostics) {
  const materials = [
    diagnostics.usedMemory ? '记忆' : '',
    diagnostics.usedDesire ? '欲望' : '',
    diagnostics.usedSchedule ? '日程/环境' : '',
    diagnostics.usedPhoneActivity ? '手机活动' : '',
    diagnostics.usedRecentMessages ? '最近消息' : '',
  ].filter(Boolean);
  return [
    `来源：${describeGenerationSource(diagnostics.source)}`,
    `生成模式：${diagnostics.contextProfile}`,
    `使用材料：${materials.length ? materials.join('、') : '轻量材料'}`,
    typeof diagnostics.rawMessageCount === 'number' ? `原始条数：${diagnostics.rawMessageCount}` : '',
    typeof diagnostics.keptMessageCount === 'number' ? `保留条数：${diagnostics.keptMessageCount}` : '',
    diagnostics.triggerKind ? `触发类型：${diagnostics.triggerKind}` : '',
    diagnostics.eventStage ? `事件阶段：${diagnostics.eventStage}` : '',
    `是否兜底：${diagnostics.usedFallback ? '是' : '否'}`,
    `是否截断：${diagnostics.wasTruncated ? '是' : '否'}`,
    typeof diagnostics.rawContentChars === 'number' ? `原始长度：${diagnostics.rawContentChars} 字` : '',
    `原因：${diagnostics.reasons?.length ? diagnostics.reasons.join('；') : '无'}`,
    `生成时间：${new Date(diagnostics.createdAt).toLocaleString('zh-CN')}`,
  ].filter(Boolean).join('\n');
}

function cleanStreamingPreviewContent(content: string) {
  // This only cleans UI preview text; committed assistant replies still wait for grounding guards.
  return cleanAssistantMessageContent(
    content
      .replace(/\[\[COUNTER_REQUEST:[\s\S]*?\]\]/g, '')
      .replace(/\[\[COUNTER_REQUEST:[\s\S]*$/g, '')
      .replace(/\[\[NOTEBOOK_ENTRY:[\s\S]*?\]\]/g, '')
      .replace(/\[\[NOTEBOOK_ENTRY:[\s\S]*$/g, ''),
  );
}

function stripStreamingJsonFence(content: string) {
  return content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function decodeStreamingJsonFragment(fragment: string) {
  try {
    return JSON.parse(`"${fragment.replace(/\r?\n/g, '\\n')}"`) as string;
  } catch {
    return fragment
      .replace(/\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\');
  }
}

function readStreamingJsonStringPreviews(arrayContent: string) {
  const completed: string[] = [];
  let current = '';
  let escaping = false;
  let inString = false;

  for (const char of arrayContent) {
    if (!inString) {
      if (char === '"') {
        inString = true;
        current = '';
      }
      continue;
    }

    if (escaping) {
      current += `\\${char}`;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (char === '"') {
      const decoded = cleanStreamingPreviewContent(decodeStreamingJsonFragment(current));
      if (decoded) completed.push(decoded);
      current = '';
      inString = false;
      continue;
    }

    current += char;
  }

  const partial = inString ? cleanStreamingPreviewContent(decodeStreamingJsonFragment(current)) : '';
  return partial ? [...completed, partial] : completed;
}

function extractStreamingMessagePreviews(content: string) {
  const source = stripStreamingJsonFence(content);
  const looksLikeBubbleJson = /^\s*\{/.test(source) || /"messages"\s*:/.test(source);
  if (!looksLikeBubbleJson) {
    const cleaned = cleanStreamingPreviewContent(content);
    return cleaned ? [cleaned] : [];
  }

  try {
    const parsed = JSON.parse(source) as { messages?: unknown };
    if (Array.isArray(parsed.messages)) {
      return parsed.messages
        .filter((entry): entry is string => typeof entry === 'string')
        .map(cleanStreamingPreviewContent)
        .filter(Boolean);
    }
  } catch {
    const marker = /"messages"\s*:\s*\[/.exec(source);
    if (!marker) return [];
    const arrayContent = source.slice((marker.index ?? 0) + marker[0].length);
    return readStreamingJsonStringPreviews(arrayContent);
  }

  return [];
}

export function getCurrentYouTurn(messages: SubjectiveMessage[]) {
  const turn: string[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'you') {
      break;
    }

    turn.unshift(messages[index].content);
  }

  return turn.join('\n');
}
