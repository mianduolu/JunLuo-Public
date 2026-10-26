export const CHAT_REPLY_FAILURE_CODES = [
  'model_visible_text_missing',
  'visible_envelope_invalid',
  'action_obligation_missing',
  'action_obligation_uncertain',
  'reply_insert_failed',
  'session_persist_failed',
  'internal_pipeline_failed',
  'stale_data_epoch',
  'tool_grounding_rejected',
  'model_timeout',
  'model_network_failed',
  'model_authentication_failed',
  'model_http_failed',
  'provider_payload_invalid',
  'auxiliary_pipeline_failed',
  'model_cancelled',
  'source_message_persist_failed',
] as const;

export type ChatReplyFailureCode = typeof CHAT_REPLY_FAILURE_CODES[number];

export const CHAT_REPLY_TECHNICAL_REASON_CODES = [
  'CHAT_MODEL_REQUEST_BUDGET_EXHAUSTED', 'CHAT_REPLY_SOURCE_STALE', 'BACKEND_OVERVIEW_STALE',
  'chat_sleep_boundary_reached', 'chat_attachment_source_changed', 'reading-chat-source-changed',
  'chat_post_source_changed', 'FILE_SOURCE_CHANGED', 'MEMORY_MATERIAL_PREPARATION_CANCELLED',
  'CHAT_IMAGE_SOURCE_CHANGED',
] as const;
export type ChatReplyTechnicalReasonCode = typeof CHAT_REPLY_TECHNICAL_REASON_CODES[number];

export function isChatReplyTechnicalReasonCode(value: unknown): value is ChatReplyTechnicalReasonCode {
  return typeof value === 'string' && (CHAT_REPLY_TECHNICAL_REASON_CODES as readonly string[]).includes(value);
}

export const CHAT_REPLY_FAILURE_CODE = {
  modelVisibleTextMissing: CHAT_REPLY_FAILURE_CODES[0],
  visibleEnvelopeInvalid: CHAT_REPLY_FAILURE_CODES[1],
  actionObligationMissing: CHAT_REPLY_FAILURE_CODES[2],
  actionObligationUncertain: CHAT_REPLY_FAILURE_CODES[3],
  replyInsertFailed: CHAT_REPLY_FAILURE_CODES[4],
  sessionPersistFailed: CHAT_REPLY_FAILURE_CODES[5],
  internalPipelineFailed: CHAT_REPLY_FAILURE_CODES[6],
  staleDataEpoch: CHAT_REPLY_FAILURE_CODES[7],
  toolGroundingRejected: CHAT_REPLY_FAILURE_CODES[8],
} as const;

export const CHAT_REPLY_FAILURE_STAGES = {
  providerRequest: 'provider_request',
  visibleEnvelope: 'visible_envelope',
  actionObligation: 'action_obligation',
  replyInsert: 'reply_insert',
  sessionPersist: 'session_persist',
  auxiliaryPipeline: 'auxiliary_pipeline',
  dataEpoch: 'data_epoch',
  internalPipeline: 'internal_pipeline',
  toolGrounding: 'tool_grounding',
} as const;

export type ChatReplyFailureStage =
  typeof CHAT_REPLY_FAILURE_STAGES[keyof typeof CHAT_REPLY_FAILURE_STAGES];

export const CHAT_REPLY_FAILURE_LABELS: Record<ChatReplyFailureCode, string> = {
  model_visible_text_missing: '模型未返回可显示正文',
  visible_envelope_invalid: '正文结构无法解析',
  action_obligation_missing: '本轮行动义务未完成',
  action_obligation_uncertain: '本轮行动义务无法可靠判断',
  reply_insert_failed: '聊天回复没有成功插入',
  session_persist_failed: '聊天回复没有保存成功',
  internal_pipeline_failed: '聊天内部处理失败',
  stale_data_epoch: '数据已经切换，本轮处理已停止',
  tool_grounding_rejected: '正文与真实工具结果不一致',
  model_timeout: '等待模型回复超过 120 秒，本次请求已停止',
  model_network_failed: '连接模型服务失败',
  model_authentication_failed: '模型服务拒绝了身份或权限验证',
  model_http_failed: '模型服务返回错误状态',
  provider_payload_invalid: '模型服务返回的数据无法解析',
  auxiliary_pipeline_failed: '部分附属处理失败',
  model_cancelled: '本次模型请求已取消',
  source_message_persist_failed: '你的消息没有保存成功，本次未请求模型',
};

export const CHAT_REPLY_FAILURE_STAGE_LABELS: Record<ChatReplyFailureStage, string> = {
  provider_request: '模型请求',
  visible_envelope: '正文结构',
  action_obligation: '行动义务',
  reply_insert: '回复插入',
  session_persist: '会话保存',
  auxiliary_pipeline: '附属处理',
  data_epoch: '数据时代',
  internal_pipeline: '内部处理',
  tool_grounding: '工具结果核对',
};

export type ChatReplyFailureClassification = {
  code: ChatReplyFailureCode;
  stage: ChatReplyFailureStage;
  secondaryStages?: ChatReplyFailureStage[];
  technicalReasonCode?: ChatReplyTechnicalReasonCode;
};

const FAILURE_CODE_SET = new Set<string>(CHAT_REPLY_FAILURE_CODES);
const FAILURE_STAGE_SET = new Set<string>(Object.values(CHAT_REPLY_FAILURE_STAGES));

export function isChatReplyFailureCode(value: unknown): value is ChatReplyFailureCode {
  return typeof value === 'string' && FAILURE_CODE_SET.has(value);
}

export function isChatReplyFailureStage(value: unknown): value is ChatReplyFailureStage {
  return typeof value === 'string' && FAILURE_STAGE_SET.has(value);
}

export class ChatReplyFailure extends Error {
  readonly code: ChatReplyFailureCode;
  readonly stage: ChatReplyFailureStage;
  readonly secondaryStages?: ChatReplyFailureStage[];
  readonly originalCause?: unknown;

  constructor(
    code: ChatReplyFailureCode,
    stage: ChatReplyFailureStage,
    originalCause?: unknown,
    secondaryStages?: ChatReplyFailureStage[],
  ) {
    super(CHAT_REPLY_FAILURE_LABELS[code]);
    this.name = 'ChatReplyFailure';
    this.code = code;
    this.stage = stage;
    this.originalCause = originalCause;
    this.secondaryStages = secondaryStages?.filter((candidate) => candidate !== stage);
  }
}

export function createChatReplyFailure(
  code: ChatReplyFailureCode,
  stage: ChatReplyFailureStage,
  originalCause?: unknown,
  secondaryStages?: ChatReplyFailureStage[],
) {
  return new ChatReplyFailure(code, stage, originalCause, secondaryStages);
}

function isTypedChatReplyFailure(error: unknown): error is ChatReplyFailure {
  if (error instanceof ChatReplyFailure) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Partial<ChatReplyFailure>;
  return candidate.name === 'ChatReplyFailure'
    && isChatReplyFailureCode(candidate.code)
    && isChatReplyFailureStage(candidate.stage);
}

function failureCodeForStage(stage: ChatReplyFailureStage): ChatReplyFailureCode {
  if (stage === CHAT_REPLY_FAILURE_STAGES.visibleEnvelope) return 'visible_envelope_invalid';
  if (stage === CHAT_REPLY_FAILURE_STAGES.actionObligation) return 'action_obligation_missing';
  if (stage === CHAT_REPLY_FAILURE_STAGES.replyInsert) return 'reply_insert_failed';
  if (stage === CHAT_REPLY_FAILURE_STAGES.sessionPersist) return 'session_persist_failed';
  if (stage === CHAT_REPLY_FAILURE_STAGES.dataEpoch) return 'stale_data_epoch';
  if (stage === CHAT_REPLY_FAILURE_STAGES.toolGrounding) return 'tool_grounding_rejected';
  if (stage === CHAT_REPLY_FAILURE_STAGES.auxiliaryPipeline) return 'auxiliary_pipeline_failed';
  return 'internal_pipeline_failed';
}

export function getChatReplyFailureStage(
  code: ChatReplyFailureCode,
): ChatReplyFailureStage {
  if (['model_timeout', 'model_network_failed', 'model_authentication_failed', 'model_http_failed',
    'provider_payload_invalid', 'model_cancelled'].includes(code)) return CHAT_REPLY_FAILURE_STAGES.providerRequest;
  if (code === 'auxiliary_pipeline_failed') return CHAT_REPLY_FAILURE_STAGES.auxiliaryPipeline;
  if (code === 'source_message_persist_failed') return CHAT_REPLY_FAILURE_STAGES.sessionPersist;
  if (code === CHAT_REPLY_FAILURE_CODE.modelVisibleTextMissing) {
    return CHAT_REPLY_FAILURE_STAGES.providerRequest;
  }
  if (code === CHAT_REPLY_FAILURE_CODE.visibleEnvelopeInvalid) {
    return CHAT_REPLY_FAILURE_STAGES.visibleEnvelope;
  }
  if (
    code === CHAT_REPLY_FAILURE_CODE.actionObligationMissing
    || code === CHAT_REPLY_FAILURE_CODE.actionObligationUncertain
  ) {
    return CHAT_REPLY_FAILURE_STAGES.actionObligation;
  }
  if (code === CHAT_REPLY_FAILURE_CODE.replyInsertFailed) {
    return CHAT_REPLY_FAILURE_STAGES.replyInsert;
  }
  if (code === CHAT_REPLY_FAILURE_CODE.sessionPersistFailed) {
    return CHAT_REPLY_FAILURE_STAGES.sessionPersist;
  }
  if (code === CHAT_REPLY_FAILURE_CODE.staleDataEpoch) {
    return CHAT_REPLY_FAILURE_STAGES.dataEpoch;
  }
  if (code === CHAT_REPLY_FAILURE_CODE.toolGroundingRejected) return CHAT_REPLY_FAILURE_STAGES.toolGrounding;
  return CHAT_REPLY_FAILURE_STAGES.internalPipeline;
}

export function classifyChatReplyFailure(input: {
  dataEpochCurrent: boolean;
  error: unknown;
  stage?: ChatReplyFailureStage;
}): ChatReplyFailureClassification {
  const fallbackStage = input.stage ?? CHAT_REPLY_FAILURE_STAGES.internalPipeline;
  if (!input.dataEpochCurrent) {
    return {
      code: 'stale_data_epoch',
      stage: CHAT_REPLY_FAILURE_STAGES.dataEpoch,
      secondaryStages: fallbackStage === CHAT_REPLY_FAILURE_STAGES.dataEpoch
        ? undefined
        : [fallbackStage],
    };
  }
  if (isTypedChatReplyFailure(input.error)) {
    return {
      code: input.error.code,
      stage: input.error.stage,
      secondaryStages: input.error.secondaryStages,
    };
  }
  if (input.error && typeof input.error === 'object') {
    const error = input.error as { name?: string; kind?: string; bodyParseFailure?: string; stopCause?: string };
    if (error.stopCause === 'timeout') return { code: 'model_timeout', stage: CHAT_REPLY_FAILURE_STAGES.providerRequest };
    if (error.stopCause === 'aborted') return { code: 'model_cancelled', stage: CHAT_REPLY_FAILURE_STAGES.providerRequest };
    if (error.bodyParseFailure && error.name !== 'AiRequestError') {
      return { code: 'provider_payload_invalid', stage: CHAT_REPLY_FAILURE_STAGES.providerRequest };
    }
    if (error.name === 'AbortError') return { code: 'model_cancelled', stage: fallbackStage };
    if (error.name === 'AiRequestError') {
      const codes: Record<string, ChatReplyFailureCode> = {
        timeout: 'model_timeout', network: 'model_network_failed',
        authentication: 'model_authentication_failed', provider_http: 'model_http_failed',
        empty_response: error.bodyParseFailure ? 'provider_payload_invalid' : 'model_visible_text_missing',
      };
      const code = codes[error.kind ?? ''];
      if (code) return { code, stage: CHAT_REPLY_FAILURE_STAGES.providerRequest };
    }
  }
  return {
    code: failureCodeForStage(fallbackStage),
    stage: fallbackStage,
    ...(input.error instanceof Error && isChatReplyTechnicalReasonCode(input.error.message)
      ? { technicalReasonCode: input.error.message } : {}),
  };
}
