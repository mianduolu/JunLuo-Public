import type {
  BaiyunChatModelAttemptDiagnostic,
  BaiyunChatReplyFailureDiagnosticEntry,
  BaiyunChatSemanticDiagnosticEntry,
} from '../ai/behavior/actionChatSemanticStore';
import { CHAT_REPLY_FAILURE_LABELS, CHAT_REPLY_FAILURE_STAGE_LABELS } from './chatReplyFailure';
import { normalizeChatMemoryPreparation, normalizeChatPreparationCheckpoints, normalizeChatToolProtocolFailure } from '../ai/behavior/actionChatSemanticStore';
import type { MemoryRecallWorkPhase } from '../memory/memoryChatPreparation';
import { CHAT_AUXILIARY_PHASE_LABELS, CHAT_AUXILIARY_STAGE_LABELS, getChatAuxiliaryStepLabel, describeChatAuxiliaryFailure,
  type ChatAuxiliaryPhase, type ChatAuxiliaryStage } from './chatAuxiliaryDiagnostics';

export type ChatReplyDiagnosticEntry = BaiyunChatReplyFailureDiagnosticEntry | BaiyunChatSemanticDiagnosticEntry;

function validCount(value: number | undefined): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function count(value: number | undefined) { return validCount(value) ? String(value) : '未记录'; }
function time(value: number | undefined) {
  return !validCount(value) ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function duration(from: number | undefined, to: number | undefined): string {
  return validCount(from) && validCount(to) && to >= from ? `${(to - from) / 1000} 秒` : '未记录';
}

function preparationDetails(entry: ChatReplyDiagnosticEntry): string[] {
  const firstRequest = entry.modelAttempts?.[0];
  const lastRequest = entry.modelAttempts?.at(-1);
  const checkpoints = normalizeChatPreparationCheckpoints(entry.preparationCheckpoints);
  const preparation = normalizeChatMemoryPreparation(entry.memoryPreparation);
  const statusLabels = { ready: '完成', not_started: '未启动', failed: '失败', timeout: '超时', cancelled: '已取消' };
  const reasons: Record<string, string> = { empty_query: '没有查找内容', configuration_missing: '配置缺失',
    cancelled: '已取消', timeout: '等待超时', http_error: '服务请求失败', parse_error: '返回内容解析失败',
    network_error: '网络连接失败', index_unavailable: '当前向量索引不可用', configuration_changed: '配置已变化',
    read_failed: '读取失败', deadline_exceeded: '本轮查找时间已用完', background_only: '本轮仅准备背景记忆',
    route_unavailable: '回想判断未完成', database_busy: '数据库正忙或被锁住',
    route_fallback: '判断未完成，已按当前聊天查找',
    response_payload_invalid: '服务返回结构不符合接口格式', response_empty: '模型没有返回正文',
    response_reasoning_only: '模型只返回推理内容，没有正文', response_truncated: '返回内容达到输出上限，未得到完整判断',
    route_json_missing: '模型正文中没有完整判断 JSON', route_json_invalid: '判断 JSON 格式错误',
    route_shape_invalid: '判断字段不符合约定', post_database_busy: '附带动态读取遇到数据库繁忙',
    post_read_failed: '附带动态读取失败', focus_database_busy: '专注补充资料读取遇到数据库繁忙',
    focus_read_failed: '专注补充资料读取失败' };
  const reason = (code?: string) => code ? `（${reasons[code] ?? code} · ${code}）` : '';
  const details = [
    `发送动作开始：${time(entry.sendStartedAt)}`,
    `首次模型请求前准备：${duration(entry.sendStartedAt, firstRequest?.startedAt)}`,
    `发送到本机保存：${duration(entry.sendStartedAt, checkpoints?.youPersistedAt)}`,
    `本机保存到睡眠接入：${duration(checkpoints?.youPersistedAt, checkpoints?.sleepAcceptedAt)}`,
    `睡眠接入到回复排队：${duration(checkpoints?.sleepAcceptedAt, checkpoints?.replyQueuedAt)}`,
    `回复排队到执行入口：${duration(checkpoints?.replyQueuedAt, checkpoints?.runReplyEnteredAt)}`,
    `执行入口到本轮采集：${duration(checkpoints?.runReplyEnteredAt, entry.startedAt)}`,
    `本轮开始到源确认：${duration(entry.startedAt, checkpoints?.sourceReadyAt)}`,
    `源确认到材料开始：${duration(checkpoints?.sourceReadyAt, checkpoints?.contextStartedAt)}`,
    `材料准备总计：${duration(checkpoints?.contextStartedAt, checkpoints?.contextReadyAt)}`,
    `材料结束到首次网络：${duration(checkpoints?.contextReadyAt, firstRequest?.startedAt)}`,
    `材料结束到provider入口：${duration(checkpoints?.contextReadyAt, checkpoints?.providerEnteredAt)}`,
    `provider入口到请求组装：${duration(checkpoints?.providerEnteredAt, checkpoints?.envelopeReadyAt)}`,
    `请求组装到发送前复核完成：${duration(checkpoints?.envelopeReadyAt, checkpoints?.preflightReadyAt)}`,
    `发送前复核完成到首次网络：${duration(checkpoints?.preflightReadyAt, firstRequest?.startedAt)}`,
    '各检查点只记录本轮首次到达；回复排队包含原闲置等待，旧记录缺失时不推算。',
    `最后网络结束到正文递送准备：${duration(lastRequest?.finishedAt, checkpoints?.replyReadyAt)}`,
    `正文递送准备到首列表提交：${duration(checkpoints?.replyReadyAt, entry.firstBubbleCommittedAt)}`,
    `正文递送准备开始：${time(checkpoints?.replyReadyAt)}（不代表正文已保存）`,
    `首次模型请求：${time(firstRequest?.startedAt)} · 首次响应接收完成：${time(firstRequest?.responseCompletedAt)}`,
    `首气泡提交列表：${time(entry.firstBubbleCommittedAt)} · 从发送到提交：${duration(entry.sendStartedAt, entry.firstBubbleCommittedAt)}`,
    '首气泡时间记录的是列表提交，不是屏幕实际绘制；保存等后续处理不计作首气泡等待。',
  ];
  if (!preparation) return [...details, '记忆准备：未记录'];
  details.push(`记忆准备：${statusLabels[preparation.status]}${reason(preparation.reason)} · ${duration(preparation.startedAt, preparation.finishedAt)}`);
  for (const [label, stage] of [['回想判断', preparation.route], ['本地查找', preparation.local], ['深入查找（含向量）', preparation.semantic]] as const) {
    details.push(`${label}：${statusLabels[stage.status]}${reason(stage.reason)} · ${duration(stage.startedAt, stage.finishedAt)}\n开始：${time(stage.startedAt)} · 结束：${time(stage.finishedAt)}`);
    const workLabels: Record<MemoryRecallWorkPhase, string> = { candidate_read: '候选读取', basis_check: '依据核对',
      source_read: '来源读取', vector_search: '向量查找', database_queue: '数据库排队', database_read: '数据库实际读取' };
    for (const [phase, title] of Object.entries(workLabels)) {
      const measurement = stage.work?.[phase as MemoryRecallWorkPhase];
      if (measurement) details.push(`${title}：${Math.round(measurement.elapsedMs)} 毫秒 / ${measurement.count} 次${measurement.active ? `，结束时仍有 ${measurement.active} 项未完成` : ''}`);
    }
  }
  details.push('准备中的阶段可能并行，细分耗时含嵌套等待，各段不能相加作为总等待。');
  return details;
}

function describeFreeTierOnlyFailure(code: BaiyunChatModelAttemptDiagnostic['failureCode'], attempt?: BaiyunChatModelAttemptDiagnostic) {
  if ((code === 'model_http_failed' || code === 'model_authentication_failed')
    && attempt?.httpStatus === 403 && attempt.providerErrorCode === 'AllocationQuota.FreeTierOnly'
    && attempt.transportOutcome !== 'timeout' && attempt.transportOutcome !== 'aborted'
    && attempt.stopCause !== 'timeout' && attempt.stopCause !== 'aborted') {
    return '当前模型的免费额度已用尽，服务已按“免费额度用完即停”设置停止。';
  }
  return undefined;
}

export function describeChatReplyFailure(entry: BaiyunChatReplyFailureDiagnosticEntry): string {
  const last = entry.modelAttempts?.at(-1);
  if (entry.code === 'model_timeout' || (entry.stage === 'provider_request' && last?.transportOutcome === 'timeout')) {
    return '等待模型回复超过 120 秒，本次请求已停止。';
  }
  const freeTierFailure = describeFreeTierOnlyFailure(entry.code, last);
  if (freeTierFailure) return freeTierFailure;
  if (entry.code === 'model_http_failed') {
    const explanation = ({ 400: '请求格式被服务拒绝', 402: '服务要求检查账户额度或付费状态',
      404: '请求地址或模型未找到', 422: '请求参数被服务拒绝', 429: '请求过于频繁或达到服务限制',
      500: '模型服务内部错误', 502: '模型服务网关错误', 503: '模型服务暂时不可用', 504: '模型服务网关等待超时',
    } as Record<number, string>)[last?.httpStatus ?? 0];
    return `${explanation ?? '模型服务返回错误状态'}${last?.httpStatus ? `（HTTP ${last.httpStatus}）` : ''}。`;
  }
  return CHAT_REPLY_FAILURE_LABELS[entry.code];
}

export function describeChatModelRequest(attempt: BaiyunChatModelAttemptDiagnostic): string {
  const kind = attempt.requestType === 'retry' ? '失败后重试'
    : attempt.requestType === 'continuation' ? '工具后续答'
      : attempt.requestType === 'initial' ? '首次请求' : '请求原因未记录';
  const reason = attempt.retryReason === 'empty_response' ? '上次没有可用正文'
    : attempt.retryReason === 'visible_envelope_invalid' ? '上次正文格式不合要求'
      : attempt.retryReason === 'tool_fact_correction' || attempt.retryKind === 'tool_fact_correction' ? '正文与工具结果不一致'
        : attempt.retryReason === 'protocol_correction' || attempt.retryKind === 'protocol_correction' ? '修正工具调用格式'
          : attempt.requestType === 'retry' ? '具体原因未记录' : '';
  const purpose = attempt.requestPurpose === 'package_discovery' ? '选择工具包'
    : attempt.requestPurpose === 'concrete_tools' ? '可选择具体工具'
      : attempt.requestPurpose === 'final' ? '生成最终答复' : '';
  return [kind, reason, purpose].filter(Boolean).join(' · ');
}

export function describeChatResponseProgress(attempt: BaiyunChatModelAttemptDiagnostic): string {
  if (attempt.responseCompletedAt !== undefined) return '响应已接收完成';
  if (attempt.firstContentAt !== undefined || (attempt.responseChars ?? 0) > 0) return '已收到部分响应，但未接收完成';
  if (attempt.headersReceivedAt !== undefined) return '已观察到服务响应，尚未观察到响应内容';
  if (attempt.responseAvailableAt !== undefined) return '接口已返回响应，完整内容尚未读取完成';
  if (attempt.startedAt !== undefined) return '尚未观察到服务响应';
  return '旧记录未记录接收进度';
}

function observedCount(attempt: BaiyunChatModelAttemptDiagnostic, value: number | undefined): string {
  // Old failed requests stored default zeros even when nothing was measured.
  if (attempt.bodyParseFailure && value === 0) return '未知';
  if (attempt.responseObserved !== true && attempt.transportOutcome !== 'response_received' && value === 0) return '未知';
  return count(value);
}

function attemptUsage(attempt: BaiyunChatModelAttemptDiagnostic): string {
  const usage = attempt.usage;
  if (!usage) return attempt.usagePresent === true ? '收到用量记录，具体数量未记录' : '用量未知';
  return [
    `输入 ${count(usage.promptTokens)}`, `输出 ${count(usage.completionTokens)}`,
    `总计 ${count(usage.totalTokens)}`, `缓存输入 ${count(usage.cachedPromptTokens)}`,
  ].join(' · ') + ' token';
}

export function buildChatReplyDiagnosticPresentation(entry: ChatReplyDiagnosticEntry) {
  const protocolFailure = normalizeChatToolProtocolFailure(entry.toolProtocolFailure);
  const attempts = entry.modelAttempts ?? [];
  const requestCount = entry.modelRequestCount ?? (entry.modelAttempts ? attempts.length : undefined);
  const failed = 'code' in entry;
  const retried = attempts.some((attempt) => attempt.requestType === 'retry');
  const last = attempts.at(-1);
  const focusedFailure = failed && entry.replyPersisted === false
    && (entry.code === 'model_timeout' || (entry.stage === 'provider_request' && last?.transportOutcome === 'timeout'));
  const title = focusedFailure ? last?.requestPurpose === 'final' ? '最终回复等待超时' : '模型回复等待超时'
    : entry.replyPersisted === true
    ? entry.deliveryKind === 'tool_card' ? '工具卡已保存，没有另发聊天正文'
      : failed || entry.auxiliaryFailures?.length || attempts.at(-1)?.failureCode ? '正文已保存，后续处理有失败' : retried ? '重试后，回复已保存' : '回复已保存'
    : entry.replyPersisted === false ? '这次回复没有保存' : '回复保存结果未记录';
  const reasonCounts = new Map<string, number>();
  attempts.forEach((attempt) => {
    const reason = attempt.requestType === 'retry' ? '失败后重试' : attempt.requestType === 'continuation' ? '工具后续答'
      : attempt.requestType === 'initial' ? '首次请求' : '原因未记录';
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  });
  const knownUsage = attempts.filter((attempt) => attempt.usage && Object.values(attempt.usage).some(validCount)).length;
  const usage = requestCount === 0 ? '本次未发起主聊天模型请求。'
    : !knownUsage ? '用量未知，无法确认是否扣费。'
      : knownUsage === requestCount ? `${knownUsage} 次请求均有用量数值，字段缺失见经过；无法据此确认扣费。`
        : `仅 ${knownUsage}／${count(requestCount)} 次请求有用量数值，部分已知；其余是否扣费未知。`;
  const executions = entry.toolEvents?.filter((event) => event.kind === 'execution' && event.status !== 'skipped');
  const skipped = entry.toolEvents?.filter((event) => event.kind === 'execution' && event.status === 'skipped');
  const packages = entry.toolEvents?.filter((event) => event.kind === 'package');
  const toolSummary = executions === undefined ? '工具执行：旧记录未记录'
    : !executions.length ? '工具执行：没有'
      : `工具执行：${executions.length} 次，${executions.filter((event) => event.status === 'success' || event.status === 'succeeded').length} 次成功；展开查看结果`;
  const technicalSummary = [
    ...(failed ? [describeChatReplyFailure(entry)] : []),
    ...(!failed && entry.auxiliaryFailures?.length ? ['部分附属处理失败，正文已保存；展开查看具体步骤'] : []),
    ...(entry.auxiliaryFailures?.length ? [...new Set(entry.auxiliaryFailures.map(event =>
      `${getChatAuxiliaryStepLabel(event.step)}：${describeChatAuxiliaryFailure(event)}`))] : []),
    `本次主聊天模型请求：${count(requestCount)} 次`,
    [...reasonCounts].map(([reason, total]) => `${reason} ${total} 次`).join(' · ') || '请求经过未记录',
    toolSummary,
    ...(protocolFailure ? [`工具协议错误：${protocolFailure.code} · finish：${protocolFailure.finishReason ?? '未记录'} · 原生调用：${protocolFailure.rawToolCallCount}`,
      ...protocolFailure.callErrors.map(error => `调用错误码：${error.errorCode}`)] : []),
    ...(skipped?.length ? [`另有 ${skipped.length} 个工具被跳过，没有执行`] : []),
    ...(packages?.length ? [`工具包开启记录：${packages.length} 次，${packages.filter((event) => event.status === 'success').length} 次成功（不算工具执行）`] : []),
    `用量：${usage}`,
  ];
  const previousResponses = attempts.slice(0, -1).filter((attempt) => attempt.transportOutcome === 'response_received').length;
  const waitSeconds = validCount(last?.startedAt) && validCount(last?.finishedAt) && last.finishedAt >= last.startedAt
    ? Math.round((last.finishedAt - last.startedAt) / 1000) : undefined;
  const summary = focusedFailure ? [
    last?.stopCause === 'timeout'
      ? `${validCount(waitSeconds) ? `等待约 ${waitSeconds} 秒后，` : ''}君落停止了${last ? `第 ${last.attemptOrdinal} 次` : '这次'}请求。`
      : describeChatReplyFailure(entry),
    last ? `接收情况：${describeChatResponseProgress(last)}。` : '接收情况：旧记录未记录。',
    `${previousResponses ? `前面已有 ${previousResponses} 次请求收到响应；` : ''}${toolSummary}`,
    last?.providerErrorCode ? `服务错误代码：${last.providerErrorCode}${last.httpStatus ? `（HTTP ${last.httpStatus}）` : ''}。`
      : last?.httpStatus !== undefined && last.httpStatus >= 400 ? `模型服务返回错误状态（HTTP ${last.httpStatus}）。`
        : last?.bodyParseFailure ? last.bodyParseFailure === 'body_read_failed' ? '服务响应的内容读取失败。' : '服务返回的数据无法解析或结构异常。'
      : '具体原因尚不明确，当前记录无法区分服务端等待、网络或手机接收延迟。',
  ] : technicalSummary;
  const events: Array<{ at?: number; order: number; text: string }> = attempts.map((attempt, index) => ({
    at: attempt.startedAt,
    order: index,
    text: [
      `请求 ${attempt.attemptOrdinal}：${describeChatModelRequest(attempt)}`,
      `结果：${attempt.transportOutcome ? ({ started: '结果未记录', response_received: '收到响应', http_error: '服务拒绝请求', network_error: '连接失败', timeout: '等待超时', aborted: '已取消' })[attempt.transportOutcome] : '未记录'}`,
      describeChatResponseProgress(attempt),
      attempt.httpStatus === undefined ? '' : `HTTP ${attempt.httpStatus}`,
      attempt.providerErrorCode ? `服务错误代码：${attempt.providerErrorCode}` : '',
      attempt.providerRequestId ? `平台请求编号：${attempt.providerRequestId}` : '',
      `传输方式：${attempt.transportKind ?? '未记录'} · 本次超时上限：${validCount(attempt.timeoutMs) ? `${attempt.timeoutMs / 1000} 秒` : '未记录'}`,
      `底层错误类型：${attempt.errorName ?? '未记录'} · 错误码：${attempt.errorCode ?? '未记录'} · 原因码：${attempt.causeCode ?? '未记录'}`,
      `外部取消信号：${attempt.externalAborted === undefined ? '未记录' : attempt.externalAborted ? '已触发' : '未触发'}`,
      attempt.bodyParseFailure ? `服务响应读取：${attempt.bodyParseFailure === 'body_read_failed' ? '响应内容读取失败' : '返回数据无法解析或结构异常'}` : '',
      attempt.failureCode ? `处理结果：${describeFreeTierOnlyFailure(attempt.failureCode, attempt) ?? CHAT_REPLY_FAILURE_LABELS[attempt.failureCode]}` : '',
      `请求格式：${attempt.mode === 'full' ? '正文与附属字段' : '仅正文'}（不代表实际收到完整答卷）`,
      `正文字符：${observedCount(attempt, attempt.directContentChars)} · 推理字符：${observedCount(attempt, attempt.reasoningContentChars)}`,
      `请求提供工具：${count(attempt.offeredToolCount)}（不代表模型选择或实际执行）`,
      `工具能力来源：${attempt.toolCapabilitySource ? ({ official_profile: '官方能力资料', verified_probe: '本连接探针验证', disabled_default: '旧版默认禁用', protocol_default: '通用协议默认（未实测）' })[attempt.toolCapabilitySource] : '未记录'}`,
      `模型提出工具调用：${observedCount(attempt, attempt.toolCallCount)}（不代表实际执行）`,
      `结束原因：${attempt.finishReason ?? '未提供'} · ${attemptUsage(attempt)}`,
      `开始：${time(attempt.startedAt)} · 首次内容：${time(attempt.firstContentAt)} · 停止：${time(attempt.finishedAt)}`,
      `响应状态：${time(attempt.headersReceivedAt)} · 接收完成：${time(attempt.responseCompletedAt)}`,
      `接口返回响应：${time(attempt.responseAvailableAt)} · 完整内容读取或解析开始：${time(attempt.bodyReadStartedAt)}`,
      `等待接口返回：${duration(attempt.startedAt, attempt.responseAvailableAt)} · 读取或解析完整内容：${attempt.transportKind === 'xhr' ? '原生接收先于解析完成，不计算该段耗时' : duration(attempt.bodyReadStartedAt, attempt.responseCompletedAt)}`,
      `已观察到响应字符：${count(attempt.responseChars)}`,
      attempt.startedAt !== undefined && attempt.finishedAt !== undefined ? `耗时：${Math.max(0, attempt.finishedAt - attempt.startedAt) / 1000} 秒` : '耗时未记录',
    ].filter(Boolean).join('\n'),
  }));
  entry.toolEvents?.forEach((event, index) => events.push({ at: event.at, order: attempts.length + index,
    text: `${event.kind === 'package' ? '工具包' : '工具执行'}：${event.name} · ${({ success: '成功', succeeded: '成功', failed: '失败', error: '失败', cancelled: '已取消', denied: '未获允许', skipped: '未执行', unknown: '结果未知' } as Record<string, string>)[event.status] ?? '结果未知'}${event.modelAttemptOrdinal ? ` · 接在请求 ${event.modelAttemptOrdinal} 后` : ''}\n${time(event.at)}` }));
  entry.auxiliaryFailures?.forEach((event, index) => events.push({ at: event.at,
    order: attempts.length + (entry.toolEvents?.length ?? 0) + index,
    text: `附属处理失败：${CHAT_AUXILIARY_STAGE_LABELS[event.stage as ChatAuxiliaryStage] ?? '未记录模块'} · ${CHAT_AUXILIARY_PHASE_LABELS[event.phase as ChatAuxiliaryPhase] ?? '未记录阶段'} · ${getChatAuxiliaryStepLabel(event.step)}\n原因：${describeChatAuxiliaryFailure(event)}\n${event.retryAttempted === undefined ? '本地重试情况未记录' : event.retryAttempted ? '已尝试本地重试（不增加模型请求）' : '未进行本地重试'}\n${time(event.at)}`,
  }));
  events.sort((a, b) => a.at !== undefined && b.at !== undefined ? a.at - b.at || a.order - b.order : a.order - b.order);
  const details = [
    `记录：${entry.id}${entry.turnAttemptId ? ` · 本轮：${entry.turnAttemptId}` : ''}`,
    `来源消息：${entry.sourceMessageId ?? '未记录'} · 本轮任务：${entry.replyPurpose === 'day_plan_adjustment' ? '调整日程草稿' : entry.replyPurpose === 'day_plan_receipt' ? '保存日程后回话' : entry.replyPurpose === 'ordinary' ? '聊天或首次工具任务' : '旧记录未记录'}`,
    `聊天：${entry.sessionId ?? '未记录'} · 来源消息：${entry.sourceMessageId ?? '未记录'}`,
    `时间：${time(entry.startedAt ?? entry.attemptedAt)} · 结束：${time(entry.finishedAt)}`,
    `连接：${entry.connectionName ?? '未记录'} · 模型：${entry.model ?? '未记录'}`,
    ...(focusedFailure ? technicalSummary : []),
    ...preparationDetails(entry),
    ...(failed ? [`失败阶段：${CHAT_REPLY_FAILURE_STAGE_LABELS[entry.stage]} · 代码：${entry.code}`] : []),
    ...(failed && entry.secondaryStages?.length ? [`其它失败阶段：${entry.secondaryStages.map((stage) => CHAT_REPLY_FAILURE_STAGE_LABELS[stage]).join('、')}`] : []),
    ...(!failed ? [
      `答卷处理：${entry.status} · 正文状态：${entry.visibleReplyStatus ?? '未记录'} · 正文来源：${entry.visibleReplySource ?? '未记录'}`,
      ...(entry.basketStatuses ? [`字段结果：${Object.entries(entry.basketStatuses).map(([field, status]) => `${field}=${status}`).join(' · ')}`] : []),
    ] : []),
    ...events.map((event) => event.text),
    `本地保存尝试：${count(entry.replyPersistAttempts)} 次`,
    '计数仅覆盖本次主聊天模型请求，不代表工具内部其它模型调用或账户账单。',
  ];
  return { title, summary, details, focusedFailure };
}

export function copyChatReplyDiagnosticText(entry: ChatReplyDiagnosticEntry): string {
  const { title, summary, details } = buildChatReplyDiagnosticPresentation(entry);
  // Deliberately use only the displayed metadata, never serialize the whole entry.
  return [title, ...summary, '', '经过与技术记录', ...details].join('\n');
}

export function isChatReplyDiagnosticForSession(entry: BaiyunChatReplyFailureDiagnosticEntry | null, sessionId: string | null): boolean {
  return !!entry?.sessionId && entry.sessionId === sessionId;
}
