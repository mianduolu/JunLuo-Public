/** Explicit chat check only. Ports must be read-only; no normalizing settings readers. */
export const BACKEND_OVERVIEW_SERVICE_ID = 'junluo_backend.overview';
export const BACKEND_OVERVIEW_DEADLINE_MS = 12_000;

export type BackendOverviewConnection = {
  baseUrl: string;
  enabled: boolean;
  voiceToken: string;
};
export type BackendOverviewLocalInfo = {
  kind: 'embedding' | 'reranker' | 'sync';
  state?: 'reranked' | 'fallback' | 'skipped' | 'missingConnection'
    | 'disabled' | 'idle' | 'checking' | 'syncing' | 'waiting-relay'
    | 'waiting-large-file-conditions' | 'attention-required';
  configured?: boolean;
  at?: number;
};
export type BackendOverviewResult = { ok: boolean; text: string };
export type BackendOverviewPorts = {
  readConnection: () => Promise<BackendOverviewConnection | null>;
  readLocalInfo: () => Promise<BackendOverviewLocalInfo[]>;
  isCurrent: (connection?: BackendOverviewConnection | null) => Promise<boolean>;
  fetch: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  /** Test clock only; production always uses twelve seconds. */
  deadlineMs?: number;
};

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null => value && typeof value === 'object'
  && !Array.isArray(value) ? value as ObjectValue : null;
const timestamp = (value: unknown, now: number) => typeof value === 'number'
  && Number.isSafeInteger(value) && value > 0 && value <= now ? value : undefined;
const dateText = (value: number) => new Date(value).toLocaleString();
const localNames = { embedding: '记忆向量检索', reranker: '记忆重排', sync: '数据同步' };
const localStates: Record<NonNullable<BackendOverviewLocalInfo['state']>, string> = {
  reranked: '最近一次重排已完成', fallback: '最近一次重排未完成，采用原结果',
  skipped: '最近一次未执行重排', missingConnection: '最近一次缺少重排连接',
  disabled: '自动同步已关闭', idle: '等待下一次同步', checking: '正在检查同步', syncing: '正在同步',
  'waiting-relay': '等待同步中继', 'waiting-large-file-conditions': '等待文件同步条件',
  'attention-required': '已有同步问题需要处理',
};

export function parseBackendOverviewConnection(raw: string | null, voiceToken: string | null): BackendOverviewConnection | null {
  if (raw === null) return null;
  const saved = object(JSON.parse(raw));
  if (!saved || typeof saved.enabled !== 'boolean' || typeof saved.baseUrl !== 'string') {
    throw new Error('invalid backend settings');
  }
  const baseUrl = saved.baseUrl.trim().replace(/\/+$/, '');
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid backend address');
    }
  }
  return { enabled: saved.enabled, baseUrl, voiceToken: voiceToken?.trim() ?? '' };
}

export function sameBackendOverviewConnection(a: BackendOverviewConnection | null, b: BackendOverviewConnection | null) {
  return a?.baseUrl === b?.baseUrl && a?.enabled === b?.enabled && a?.voiceToken === b?.voiceToken;
}

function feature(name: string, state?: string, configured?: boolean) {
  return state ? `${name}：${state}` : configured
    ? `${name}：仅取得连接设置，尚未确认运行状态。`
    : `${name}：本次没有取得状态。`;
}

function modelState(value: unknown) {
  const status = object(value);
  if (!status || typeof status.state !== 'string') return undefined;
  if (status.state === 'disabled') return '已关闭';
  if (status.state === 'failed' || status.state === 'error') return '已有失败状态';
  if (status.state === 'loading') return '正在加载';
  if (status.modelReady === true) return '模型已加载，尚未验证本次执行';
  if (status.dependenciesReady === true) return '依赖已准备，模型尚未加载';
  if (status.dependenciesReady === false) return '依赖尚未准备齐全';
  return undefined;
}

/** Only bounded technical categories enter model material, never raw exception text. */
function recordedError(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const http = value.match(/(?:HTTP|status(?: code)?)[\s:=]*(\d{3})\b/i);
  if (http && Number(http[1]) >= 400 && Number(http[1]) <= 599) return `网页查询返回错误，状态码：${http[1]}`;
  if (/timeout|timed out|超时/i.test(value)) return '网页查询超时';
  return '网页查询已有错误记录';
}

function backendFeatures(main: ObjectValue | null, voice: ObjectValue | null, now: number) {
  const lines: string[] = [];
  const web = object(main?.web);
  const providers = Array.isArray(web?.providers) ? web.providers.map(object).filter((item): item is ObjectValue => item !== null) : [];
  const knownProviders = providers.filter(item => typeof item.status === 'string');
  const ready = knownProviders.some(item => item.status === 'ready');
  lines.push(feature('网页检索', ready ? '连接设置已准备，尚未验证本次查询'
    : knownProviders.length && knownProviders.every(item => item.status === 'unconfigured') ? '尚未配置' : undefined));
  const funds = object(main?.funds);
  const fetchedAt = timestamp(funds?.fetchedAt, now);
  const fundState = funds?.state === 'empty' ? '暂无已保存缓存'
    : fetchedAt && funds?.state === 'fresh' ? `已有未过期缓存；获取时间：${dateText(fetchedAt)}`
      : fetchedAt && funds?.state === 'stale' ? `已有过期缓存；获取时间：${dateText(fetchedAt)}` : undefined;
  if (fetchedAt && fundState) lines.push('以下是已有记录，不代表本次实测结果。');
  lines.push(feature('基金缓存', fundState));
  lines.push(feature('通话线路', voice?.livekitReady === true ? '轻量连接检查通过'
    : voice?.livekitReady === false ? '本次连接检查未通过' : undefined));
  lines.push(feature('语音准备', voice?.workerReady === true && voice?.ttsReady === true
    ? '依赖与连接设置已准备，尚未验证实际通话'
    : voice?.workerReady === false || voice?.ttsReady === false ? '尚未准备齐全' : undefined));
  lines.push(feature('声音转文字', modelState(voice?.stt)));
  lines.push(feature('语音情绪识别', modelState(voice?.emotion)));
  const errors = providers.map(provider => ({ text: recordedError(provider.lastFailure), at: timestamp(provider.lastFailureAt, now) }))
    .filter(error => error.text).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  if (errors.length) {
    const error = errors[0];
    lines.push('以下是已有记录，不代表本次实测结果。', `最近错误：${error.text}`,
      error.at ? `错误时间：${dateText(error.at)}` : '错误时间：未记录。');
  } else lines.push('本次未取得近期错误记录。');
  return lines;
}

class OverviewInterrupted extends Error {
  constructor(readonly reason: 'timeout' | 'cancelled' | 'stale') { super(reason); }
}
class OverviewHttpError extends Error {
  constructor(readonly status: number) { super('http error'); }
}
class OverviewResponseError extends Error {}

/** One check, one deadline including body reads. No retries or old status fallbacks. */
export async function checkBackendOverview(ports: BackendOverviewPorts): Promise<BackendOverviewResult> {
  const now = ports.now ?? Date.now;
  const startedAt = now();
  const deadlineMs = ports.deadlineMs ?? BACKEND_OVERVIEW_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const controller = new AbortController();
  let interrupted: OverviewInterrupted | undefined;
  let rejectInterrupted!: (error: OverviewInterrupted) => void;
  const interruption = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const stop = (reason: OverviewInterrupted['reason']) => {
    if (interrupted) return;
    interrupted = new OverviewInterrupted(reason);
    controller.abort();
    rejectInterrupted(interrupted);
  };
  const cancel = () => stop('cancelled');
  ports.signal?.addEventListener('abort', cancel);
  // Leave a small part of the same deadline for the final read-only source check.
  const timer = setTimeout(() => stop('timeout'), deadlineMs - Math.min(100, deadlineMs / 4));
  // Attach immediately even if an already-aborted source stops before the first read.
  interruption.catch(() => undefined);
  const wait = <T>(work: Promise<T>) => Promise.race([work, interruption]);
  let connection: BackendOverviewConnection | null | undefined;
  const current = async () => {
    if (ports.signal?.aborted) stop('cancelled');
    if (interrupted) throw interrupted;
    if (!await wait(ports.isCurrent(connection))) throw new OverviewInterrupted('stale');
  };
  const request = async (path: string, token?: string): Promise<ObjectValue> => {
    await current();
    const response = await wait(ports.fetch(`${connection!.baseUrl}${path}`, {
      method: 'GET', signal: controller.signal, redirect: 'error',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }));
    if (!response.ok) throw new OverviewHttpError(response.status);
    const text = await wait(response.text());
    if (text.length > 65_536) throw new OverviewResponseError('response too large');
    let data: ObjectValue | null;
    try { data = object(JSON.parse(text)); }
    catch { throw new OverviewResponseError('invalid response'); }
    if (!data) throw new OverviewResponseError('invalid response');
    await current();
    return data;
  };
  let connectionText = '';
  let identified = false;
  let main: ObjectValue | null = null;
  let voice: ObjectValue | null = null;
  let local: BackendOverviewLocalInfo[] = [];
  const partialHttpErrors = new Set<number>();
  try {
    await current();
    try { connection = await wait(ports.readConnection()); }
    catch (error) {
      if (error instanceof OverviewInterrupted) throw error;
      connectionText = '这次没能读取后端连接设置。';
    }
    // Local old records are independent of backend connectivity, never online tests.
    try { local = await wait(ports.readLocalInfo()); }
    catch (error) { if (error instanceof OverviewInterrupted) throw error; }
    if (!connectionText && !connection?.baseUrl) connectionText = '还没有配置君落后端地址。';
    if (!connectionText) {
      try {
        const health = await request('/health');
        identified = health.status === 'ok' && health.service === 'junluo-backend';
        connectionText = identified ? '连接结果：君落后端已回应。'
          : '这个地址有回应，但没能确认连到的是君落后端。';
      } catch (error) {
        if (error instanceof OverviewInterrupted) throw error;
        connectionText = error instanceof OverviewHttpError ? `后端返回错误，状态码：${error.status}。`
          : error instanceof OverviewResponseError ? '这个地址有回应，但没能确认连到的是君落后端。'
          : '这次没能连接君落后端。';
      }
    }
    if (identified) {
      for (const [path, token] of [
        ['/api/status/read-only', undefined],
        ['/api/voice-call/status/read-only', connection!.voiceToken || undefined],
      ] as const) {
        try {
          const result = await request(path, token);
          if (result.status === 'ok' && result.service === 'junluo-backend') {
            if (path === '/api/status/read-only') main = result; else voice = result;
          }
        } catch (error) {
          if (error instanceof OverviewInterrupted) throw error;
          if (error instanceof OverviewHttpError) partialHttpErrors.add(error.status);
        }
      }
      if (!main && !voice) connectionText += '\n君落后端已回应，但这次没有取得运行信息。';
    }
    await current();
  } catch (error) {
    if (error instanceof OverviewInterrupted && error.reason === 'timeout') {
      connectionText = identified ? `${connectionText}\n这次连接君落后端超时。` : '这次连接君落后端超时。';
    } else {
      // Cancellation/source changes use the host's existing technical cancellation state.
      throw error;
    }
  } finally {
    clearTimeout(timer);
    ports.signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
  // A hanging final settings read cannot extend the overall check indefinitely.
  const remaining = deadlineAt - Date.now();
  let finalTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (ports.signal?.aborted) throw new OverviewInterrupted('cancelled');
    if (remaining <= 0) return { ok: false, text: '这次连接君落后端超时。' };
    const valid = await Promise.race([
      ports.isCurrent(connection),
      new Promise<never>((_resolve, reject) => {
        finalTimer = setTimeout(() => reject(new OverviewInterrupted('timeout')), remaining);
      }),
    ]);
    if (!valid || ports.signal?.aborted) throw new OverviewInterrupted('stale');
  } catch (error) {
    if (error instanceof OverviewInterrupted && error.reason === 'timeout') {
      if (ports.signal?.aborted) throw new OverviewInterrupted('cancelled');
      return { ok: false, text: '这次连接君落后端超时。' };
    }
    throw error;
  } finally { if (finalTimer !== undefined) clearTimeout(finalTimer); }
  const lines = [`检查时间：${dateText(startedAt)}`, connectionText];
  for (const status of partialHttpErrors) lines.push(`后端返回错误，状态码：${status}。`);
  if (identified) lines.push(...backendFeatures(main, voice, now()));
  for (const info of local) {
    if (!Object.prototype.hasOwnProperty.call(localNames, info.kind)) continue;
    const at = timestamp(info.at, now());
    const state = info.state && Object.prototype.hasOwnProperty.call(localStates, info.state) ? localStates[info.state] : undefined;
    if (state && at) lines.push('以下是已有记录，不代表本次实测结果。', feature(localNames[info.kind], `${state}；记录时间：${dateText(at)}`));
    else lines.push(feature(localNames[info.kind], undefined, info.configured));
  }
  return { ok: identified, text: lines.join('\n') };
}
