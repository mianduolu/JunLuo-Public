import type { AiRuntimeSnapshot } from '../ai/aiRuntimeScheduler';
import type { AssistantLifeGenerationDiagnostic } from '../ai/assistantLifeGenerationDiagnostics';
import type { StoredUnifiedContactState } from '../proactive/unifiedContactStore';

type Tone = 'neutral' | 'busy' | 'warning' | 'error';
type Observation = { domain: string; at: number; text: string; failure?: boolean; success?: boolean };

const lifeLabels = {
  wants: '十维', affect: '感受', 'near-status': '近况', 'sleep-status': '睡眠近况',
};
const failureLabels: Readonly<Record<string, string>> = {
  'auth-or-config': '连接配置异常', 'empty-content': '模型未返回正文',
  'http-transient': '服务临时异常', 'invalid-activity': '近况正文不合格',
  'invalid-json': '正文结构无法解析', 'invalid-mood': '情绪字段不合格',
  'invalid-title': '标题字段不合格', 'rate-limited': '请求过于频繁',
  timeout: '请求超时', 'truncated-output': '模型输出被截断',
  TOOL_AGENT_MODEL_REQUEST_TIMEOUT: '请求超时', UNIFIED_CONTACT_CONTEXT_TOO_LONG: '请求材料过长',
  TOOL_PROVIDER_NATIVE_TOOLS_UNSUPPORTED: '当前连接不支持所需工具',
  TOOL_PROVIDER_THINKING_TOOLS_UNSUPPORTED: '当前连接不支持所需工具模式',
  TOOL_REQUIRED_CHOICE_UNSUPPORTED: '当前连接不支持指定工具',
  CHAT_MODEL_REQUEST_BUDGET_EXHAUSTED: '本轮请求次数已用完',
  transport_http_error: '接口返回错误', transport_network_error: '网络请求失败',
  transport_timeout: '请求超时', ai_authentication: '连接认证失败',
  ai_timeout: '请求超时', ai_network: '网络请求失败', ai_provider_http: '接口返回错误',
  ai_empty_response: '模型未返回正文', empty_body: '没有可用正文',
  body_truncated: '模型输出被截断', body_protocol_failed: '正文结构未通过检查',
  body_parse_empty: '正文结构无法解析', body_cleaned_empty: '没有可显示正文',
  body_action_filtered: '正文未通过动作检查', generation_failed: '生成未完成',
};
const stoppedLabels: Readonly<Record<string, string>> = {
  disabled: '主动功能已关闭', automatic_disabled: '自动 AI 已关闭',
  silent: '本次没有发送正文', aborted: '请求已中止',
  UNIFIED_CONTACT_REQUEST_ABORTED: '请求已中止', transport_aborted: '请求已中止',
  expired: '本次机会已过期', chat: '已交给聊天接续', session_deleted: '原会话已删除',
  stale: '原资料已变化', host_stopped: '原运行已停止',
  shared_request_sealed_for_phone: '旧请求保留原结果，未重新发送',
  shared_reservation_sealed_for_phone: '旧机会已结束，未重新发送',
  control_reservation_ended: '原机会已结束', control_round_ended: '原轮次已结束',
};

function time(at: number) {
  if (!Number.isFinite(at) || at <= 0) return '时间未记录';
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '时间未记录';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Only fixed technical enums are displayed. Arbitrary exception messages never enter the UI.
function failureLabel(reason?: string): string | undefined {
  if (!reason) return undefined;
  const code = reason.split('|', 1)[0].split(':', 1)[0];
  const label = failureLabels[code];
  return typeof label === 'string' ? label : undefined;
}

function isStopped(reason?: string) {
  return !!reason && typeof stoppedLabels[reason.split(':', 1)[0]] === 'string';
}

function lifeObservation(item: AssistantLifeGenerationDiagnostic): Observation {
  const label = item.flow ? lifeLabels[item.flow] : '生活状态';
  const internalState = item.flow === 'wants' || item.flow === 'affect';
  const at = item.status === 'budget-skipped' ? item.lastOccurredAt ?? item.attemptedAt : item.attemptedAt;
  const base = { domain: `life:${item.contextSource}:${item.flow ?? 'legacy'}`, at };
  const describe = (text: string, result: Partial<Observation> = {}): Observation => ({
    ...base, text: `${time(at)}｜上次${label}：${text}`, ...result,
  });
  if (item.visibleTextSaved === true) return describe(`首页文字已保存${item.persistenceStatus === 'pending'
    ? '；仍有其他内容待保存' : item.persistenceStatus === 'interrupted' ? '；其余保存已中断' : ''}`, { success: true });
  if (item.persistenceStatus === 'pending') return describe('结果仍有内容待保存');
  if (item.persistenceStatus === 'interrupted') return describe(internalState
    ? '本地保存已中断' : '本地保存已中断，首页文字保存尚无确认');
  const attempts = item.requests?.filter(request => request.status !== 'not-started') ?? [];
  const last = attempts.at(-1);
  const transport = last?.transport;
  if (transport?.outcome === 'started' && transport.finishedAt === undefined) return describe('请求未记录结束');
  if (item.status === 'budget-skipped') return describe('未发起请求，调用名额暂不可用');
  if (item.failureReason === 'aborted' || transport?.outcome === 'aborted') return describe('请求已中止');
  if (item.requests?.length && !attempts.length) return describe('未发起模型请求');
  if (item.interruptionReason === 'automatic-calls-disabled') return describe('自动 AI 已关闭，本次已中止');
  if (item.interruptionReason === 'chat-started') return describe('聊天开始，本次已中断');
  const reason = failureLabel(item.failureReason);
  if (reason) return describe(`未完成，${reason}`, { failure: true });
  if (transport && ['http-error', 'network-error', 'timeout'].includes(transport.outcome)) {
    const text = transport.outcome === 'timeout' ? '请求超时'
      : transport.outcome === 'network-error' ? '网络请求失败' : '接口返回错误';
    return describe(`未完成，${text}`, { failure: true });
  }
  if (item.status === 'failure' && (last?.status === 'failure' || !item.requests)) {
    return describe('未完成，具体原因未记录', { failure: true });
  }
  if (item.persistenceStatus === 'saved') return describe(internalState
    ? '处理结果已保存' : '已保存处理结果；首页文字保存尚无确认', {
    success: internalState,
  });
  if (item.savedParts?.length) return describe(internalState
    ? '部分内容已保存' : '部分内容已保存；首页文字保存尚无确认');
  if (transport?.outcome === 'response' || item.status === 'success') {
    return describe(internalState ? '已收到处理结果；保存尚无确认' : '已收到结果；首页文字保存尚无确认', {
      success: item.status === 'success' && internalState,
    });
  }
  return describe('处理结果尚无确认');
}

function contactObservations(contact: StoredUnifiedContactState): Observation[] {
  const observations: Observation[] = [];
  const describe = (stage: string, reason: string | undefined, at: number, savedIds: readonly string[], retryAt?: number | null) => {
    const saved = new Set(savedIds).size;
    let text: string;
    let failure = false, success = false;
    if (stage === 'requesting') text = '请求阶段未记录结束';
    else if (stage === 'waiting_retry') text = `等待原流程重试${retryAt ? `，登记时间 ${time(retryAt)}` : ''}`;
    else if (stage === 'saving') text = `正文待保存${saved ? `，已保存 ${saved} 条` : ''}`;
    else if (stage === 'handoff') text = '已交给聊天接续';
    else if (stage === 'ready') text = '等待处理';
    else if (stage === 'finished') {
      if (reason === 'delivered' || reason === 'chat_handoff_delivered') {
        text = saved ? `正文已保存 ${saved} 条` : '本次已结束，正文保存数量尚无确认';
        success = saved > 0;
      } else if (reason && typeof stoppedLabels[reason] === 'string') text = stoppedLabels[reason];
      else if (isStopped(reason)) text = '请求已中止';
      else { const label = failureLabel(reason); text = label ? `未完成，${label}` : '本次已结束，具体结果未记录'; failure = !!label; }
    } else text = '处理状态未确认';
    const label = failureLabel(reason);
    if (stage === 'waiting_retry' && label && !isStopped(reason)) {
      text += `；上次未完成，${label}`; failure = true;
    }
    observations.push({ domain: 'contact', at, text: `${time(at)}｜上次主动消息：${text}`, failure, success });
  };
  for (const item of contact.diagnostics ?? []) describe(item.stage, item.reason, item.at, item.savedMessageIds, item.retryAt);
  const current = contact.current;
  if (current) describe(current.status, current.reason,
    current.endedAt ?? current.failedAt ?? (current.requestStartedAt || current.createdAt),
    current.savedMessageIds, current.retryAt);
  return observations;
}

/** Read-only presentation. A scheduler return or HTTP 200 is not a business-save receipt. */
export function presentHomeBackgroundAi(input: {
  enabled: boolean;
  now: number;
  runtime: AiRuntimeSnapshot;
  lifeDiagnostics: readonly AssistantLifeGenerationDiagnostic[];
  contact: StoredUnifiedContactState;
}): { tone: Tone; title: string; detail: string; lastFailure?: string; historyDetail?: string } {
  const observations = input.lifeDiagnostics.map(lifeObservation);
  observations.push(...contactObservations(input.contact));
  for (const record of input.runtime.records) {
    // Normal/critical calls include manual chat, vision and gift actions. They do not
    // establish an automatic background run; proactive also has an urgent path.
    if (record.priority !== 'background' && record.priority !== 'night' && record.kind !== 'proactive') continue;
    const at = record.endedAt ?? record.startedAt;
    const reason = failureLabel(record.reason);
    const failure = record.status === 'failed' && !isStopped(record.reason);
    const text = record.status === 'skipped' ? '未执行'
      : record.status === 'aborted' || isStopped(record.reason) ? '已中止或按设置结束'
        : record.status === 'failed' ? `未完成，${reason ?? '具体原因未记录'}`
          : record.status === 'running' ? '未记录结束' : '处理已返回；此记录不确认业务内容已保存';
    observations.push({ domain: `runtime:${record.kind}`, at, text: `${time(at)}｜上次 AI 任务：${text}`,
      failure, success: record.status === 'success' });
  }
  const latest = new Map<string, Observation>();
  const failures = new Map<string, Observation>();
  for (const observation of [...observations].sort((a, b) => a.at - b.at)) {
    latest.set(observation.domain, observation);
    if (observation.success) failures.delete(observation.domain);
    else if (observation.failure) failures.set(observation.domain, observation);
  }
  const lastFailure = [...failures.values()].sort((a, b) => b.at - a.at)[0]?.text;
  const current = input.runtime.current;
  const currentLabel = current?.kind === 'chatReply' ? '正在处理聊天回复'
    : current?.kind === 'voiceCallReply' ? '正在处理通话回复'
      : current?.priority === 'normal' || current?.priority === 'critical' ? '正在处理手动 AI 任务' : '正在处理 AI 任务';
  const heading = current ? `${time(current.startedAt)}｜${currentLabel}`
    : '当前没有正在执行的任务。尚不能从现有记录确认下一次运行时间。';
  const recent = [...latest.values()].filter(item => !item.domain.startsWith('runtime:'))
    .sort((a, b) => b.at - a.at)[0];
  const details = [heading, ...(!input.enabled ? ['自动 AI 已关闭。已有任务按原流程收尾。'] : [])];
  if (recent && recent.text !== lastFailure) details.push(`最近处理\n${recent.text}`);
  if (lastFailure) details.push(`最近问题\n${lastFailure}`);
  if (!recent && !lastFailure) details.push(observations.length
    ? '暂未记录生活状态或主动消息的处理结果。'
    : '暂无后台处理记录，不能据此判断模型成功或失败。');
  // Keep all retained technical observations available on demand, without
  // letting generic scheduler callbacks crowd the default summary.
  const historyDetail = [...observations].sort((a, b) => b.at - a.at).map(item => item.text).join('\n\n');
  return {
    tone: current ? 'busy' : lastFailure ? 'warning' : 'neutral',
    title: current ? input.enabled ? currentLabel : `自动 AI 已关闭，${currentLabel}`
      : input.enabled ? '当前没有正在执行的任务' : '自动 AI 已关闭',
    detail: details.join('\n\n'),
    ...(lastFailure ? { lastFailure } : {}),
    ...(historyDetail ? { historyDetail } : {}),
  };
}
