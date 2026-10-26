import { loadBackendSettings } from '../backend/backendClient';
import { getVoiceCallApiToken, loadVoiceCallSettings } from './voiceCallSettings';
import { sanitizeVoiceCallBackendDiagnostics, type VoiceCallBackendDiagnostics } from './voiceCallDiagnostics';

export type VoiceCallTokenRole = 'user';
export type VoiceCallDirection = 'incoming' | 'outgoing' | 'test';
export type VoiceCallUplinkMode = 'auto' | 'livekit' | 'native';

export type VoiceCallTokenResponse = {
  callId: string;
  direction: VoiceCallDirection;
  expiresAt: number;
  livekitUrl: string;
  participantIdentity: string;
  participantRole: VoiceCallTokenRole;
  roomName: string;
  roomReady: boolean;
  sessionTicket: string;
  token: string;
  uplinkMode: Exclude<VoiceCallUplinkMode, 'auto'>;
  emotion2vecEnabled: boolean;
};

export type VoiceCallTokenRequest = {
  callId?: string;
  direction?: VoiceCallDirection;
  uplinkMode?: VoiceCallUplinkMode;
  emotion2vecEnabled?: boolean;
};

export type VoiceCallLineTestResult =
  | { ok: true; baseUrl: string; data: VoiceCallTokenResponse; message: string; testedAt: number }
  | { ok: false; baseUrl?: string; message: string; status?: number; testedAt: number };

export type VoiceCallBackendReadiness = {
  budget?: VoiceCallBudgetSnapshot | null;
  budgetAvailable: boolean;
  livekitReady: boolean;
  message: string;
  ok: boolean;
  ttsProvider?: string | null;
  ttsReady: boolean;
  workerReady: boolean;
};

export type VoiceCallBudgetSnapshot = {
  date: string;
  daily_limit_utf8_bytes: number;
  used_utf8_bytes: number;
  reserved_utf8_bytes: number;
  remaining_utf8_bytes: number;
  completed_count: number;
  failed_count: number;
  interrupted_count: number;
  cache_hit_count: number;
  call_id?: string | null;
  per_call_new_synthesis_limit?: number | null;
  call_new_synthesis_count: number;
};

export type VoiceCallTtsIntent = 'opening_auto' | 'care_auto' | 'manual';

export type VoiceCallPlaybackState =
  | 'queued'
  | 'started'
  | 'completed'
  | 'interrupted'
  | 'failed';

export type VoiceCallPlaybackEvent = {
  type: 'voice_call_playback';
  at: number;
  callId: string;
  playbackId: string;
  reason?: 'user_started_speaking' | 'call_ended' | 'worker_failed';
  sourceTurnId?: string;
  state: Exclude<VoiceCallPlaybackState, 'queued'>;
};

export type VoiceCallTestSpeechResponse = {
  budget?: VoiceCallBudgetSnapshot | null;
  cacheHit: boolean;
  callId: string;
  message: string;
  ok: boolean;
  playbackId: string;
  playbackState: 'queued';
  provider: string;
  roomName?: string;
  sourceTurnId?: string;
};

export type VoiceCallSpeechStandbyResponse = {
  standbyRevision?: number | null;
  callId: string;
  message: string;
  ok: boolean;
  provider?: string;
  roomName?: string;
};

export type VoiceCallVADStatus = {
  active: boolean;
  callId: string;
  lastStartedAt?: number | null;
  lastStoppedAt?: number | null;
  message: string;
  state: string;
  turns: number;
  updatedAt?: number | null;
  micFrames?: number;
  lastMicAt?: number | null;
  micSampleRate?: number | null;
  micChannels?: number | null;
  lastMicBytes?: number | null;
  lastRms?: number | null;
  lastPeak?: number | null;
  lastConfidence?: number | null;
  lastVadVolume?: number | null;
};

export type VoiceCallSTTState =
  | 'disabled'
  | 'unavailable'
  | 'loading'
  | 'ready'
  | 'transcribing'
  | 'failed';

export type VoiceCallSTTStatus = {
  type: 'stt_status';
  state: VoiceCallSTTState;
  message: string;
  provider: 'funasr-local';
  model: string;
  device: string;
  dependenciesReady: boolean;
  modelReady: boolean;
  turnId?: string;
};

export type VoiceCallTranscriptStatus = 'ok' | 'not_heard' | 'failed';

export type VoiceCallTranscriptEvent = {
  type: 'transcript';
  callId: string;
  turnId: string;
  status: VoiceCallTranscriptStatus;
  text: string;
  language: string | null;
  latencyMs: number;
  durationMs: number;
  provider: 'funasr-local';
  confidence: number | null;
  fallback: false;
  isFinal: true;
  errorCode?: string | null;
};

export type VoiceCallEmotionState =
  | 'disabled'
  | 'unavailable'
  | 'loading'
  | 'ready'
  | 'analyzing'
  | 'failed';

export type VoiceCallEmotionConfidenceLevel = 'low' | 'medium' | 'high';

export type VoiceCallEmotionStatus = {
  type: 'emotion_status';
  state: VoiceCallEmotionState;
  message: string;
  provider: 'emotion2vec-local';
  model: string;
  device: string;
  dependenciesReady: boolean;
  modelReady: boolean;
  markerExists: boolean;
  turnId?: string;
};

export type VoiceCallEmotionSignalEvent = {
  type: 'emotion_signal';
  callId: string;
  turnId: string;
  status: 'ok' | 'uncertain' | 'failed';
  label: 'angry' | 'disgusted' | 'fearful' | 'happy' | 'neutral' | 'other' | 'sad' | 'surprised' | 'unknown';
  score: number;
  topK: Array<{ label: string; score: number }>;
  durationMs: number;
  latencyMs: number;
  confidenceLevel: VoiceCallEmotionConfidenceLevel;
  internalHint: string;
  provider: 'emotion2vec-local';
  errorCode?: string | null;
};

export class VoiceCallTokenError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly baseUrl?: string,
    readonly code?: string,
    readonly budget?: VoiceCallBudgetSnapshot | null,
  ) {
    super(message);
    this.name = 'VoiceCallTokenError';
  }
}

type VoiceCallRequestContext = {
  baseUrl: string;
  callId: string;
  voiceCallApiToken: string;
};

let recentVoiceCallRequestContext: VoiceCallRequestContext | null = null;

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, '');
}

function compactErrorMessage(status: number) {
  if (status === 401) return '电话线令牌不一致：请在电脑小管家重新复制，并在 App 语音通话设置里保存。';
  if (status === 502) return '电话线没接上：LiveKit dev server 可能还没启动。';
  if (status === 503) return '电话线还没配置：后端没有读到 LiveKit URL/key/secret，或 Pipecat worker 还没装好。';
  if (status === 404) return '还没有放入白云测试音频。';
  if (status === 400) return '电话线请求参数不对，或测试音频不是 16kHz 单声道 PCM16 wav。';
  return `电话线测试失败：HTTP ${status}`;
}

async function makeVoiceCallResponseError(response: Response, baseUrl: string) {
  let code: string | undefined;
  let budget: VoiceCallBudgetSnapshot | null | undefined;
  let message = compactErrorMessage(response.status);
  try {
    const payload = await response.json() as {
      detail?: string | { budget?: VoiceCallBudgetSnapshot | null; code?: string; message?: string };
    };
    if (typeof payload.detail === 'string' && payload.detail.trim()) {
      message = payload.detail;
    } else if (payload.detail && typeof payload.detail === 'object') {
      code = payload.detail.code;
      budget = payload.detail.budget;
      if (payload.detail.message?.trim()) message = payload.detail.message;
    }
  } catch {
    // Keep the compact local status when the backend did not return JSON.
  }
  return new VoiceCallTokenError(message, response.status, baseUrl, code, budget);
}

function compactVadStatusErrorMessage(status: number) {
  if (status === 404) return 'VAD 状态接口没有接上：后端可能还没重启到最新代码。';
  if (status === 500) return 'VAD 状态接口报错了。';
  return compactErrorMessage(status);
}

export async function fetchVoiceCallToken(request: VoiceCallTokenRequest = {}, signal?: AbortSignal) {
  const settings = await loadBackendSettings();
  const voiceCallApiToken = await getVoiceCallApiToken();
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  if (!baseUrl) {
    throw new VoiceCallTokenError('还没有填写电脑后端地址。');
  }
  if (!voiceCallApiToken) {
    throw new VoiceCallTokenError('还没有填写本地语音后端访问令牌。请在电脑小管家复制后，粘贴到语音通话设置并保存。', undefined, baseUrl);
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/voice-call/token`, {
      body: JSON.stringify({
        direction: request.direction ?? 'test',
        uplinkMode: request.uplinkMode ?? 'auto',
        emotion2vecEnabled: request.emotion2vecEnabled === true,
        ...(request.callId ? { callId: request.callId } : {}),
      }),
      headers: { Authorization: `Bearer ${voiceCallApiToken}`, 'Content-Type': 'application/json' },
      method: 'POST',
      signal,
    });
  } catch {
    throw new VoiceCallTokenError('连不上电脑后端。检查后端地址、WiFi、防火墙和 USB/局域网连接。', undefined, baseUrl);
  }
  if (!response.ok) {
    throw new VoiceCallTokenError(compactErrorMessage(response.status), response.status, baseUrl);
  }
  const data = (await response.json()) as VoiceCallTokenResponse;
  recentVoiceCallRequestContext = {
    baseUrl,
    callId: data.callId,
    voiceCallApiToken,
  };
  return { baseUrl, data };
}

export async function testVoiceCallLine(): Promise<VoiceCallLineTestResult> {
  const testedAt = Date.now();
  try {
    const result = await fetchVoiceCallToken({ direction: 'test' });
    return {
      ok: true,
      baseUrl: result.baseUrl,
      data: result.data,
      message: result.data.roomReady ? '电话线已经能创建 LiveKit 房间。' : '后端返回了 token，但房间状态还没确认。',
      testedAt,
    };
  } catch (caught) {
    if (caught instanceof VoiceCallTokenError) {
      return { ok: false, baseUrl: caught.baseUrl, message: caught.message, status: caught.status, testedAt };
    }
    return { ok: false, message: '电话线测试失败，请稍后再试。', testedAt };
  }
}

export async function fetchVoiceCallReadiness(signal?: AbortSignal) {
  const [settings, voiceCallConfig] = await Promise.all([
    loadBackendSettings(),
    loadVoiceCallSettings(),
  ]);
  const voiceCallApiToken = await getVoiceCallApiToken();
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  if (!baseUrl) throw new VoiceCallTokenError('还没有填写电脑后端地址。');
  if (!voiceCallApiToken) throw new VoiceCallTokenError('还没有填写本地语音后端访问令牌。', undefined, baseUrl);
  let response: Response;
  try {
    const dailyLimitUtf8Bytes = voiceCallConfig.settings.dailyCharacterLimit * 3;
    response = await fetch(`${baseUrl}/api/voice-call/readiness?dailyLimitUtf8Bytes=${dailyLimitUtf8Bytes}`, {
      headers: { Authorization: `Bearer ${voiceCallApiToken}` },
      signal,
    });
  } catch {
    throw new VoiceCallTokenError('连不上电脑后端。', undefined, baseUrl);
  }
  if (!response.ok) throw new VoiceCallTokenError(compactErrorMessage(response.status), response.status, baseUrl);
  return { baseUrl, data: (await response.json()) as VoiceCallBackendReadiness };
}

async function withSpeechStandbyTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new VoiceCallTokenError('电话线请求超时，请检查网络后重试。'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestVoiceCallSpeechStandby(
  callId: string,
  action: 'start' | 'stop',
  uplinkMode: VoiceCallUplinkMode,
  ownership: StandbyRequestOwnership,
  deliver: (send: () => Promise<VoiceCallSpeechStandbyResult>) => Promise<VoiceCallSpeechStandbyResult> = send => send(),
) {
  const { settings, voiceCallApiToken } = await withSpeechStandbyTimeout(async () => {
    const settings = await loadBackendSettings();
    return { settings, voiceCallApiToken: await getVoiceCallApiToken() };
  }, 5000);
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  if (!baseUrl || !voiceCallApiToken) return null;
  const endpoint = action === 'start' ? 'speech-standby' : 'speech-standby/stop';
  return deliver(() => withSpeechStandbyTimeout(async signal => {
    const response = await fetch(`${baseUrl}/api/voice-call/${endpoint}`, {
      body: JSON.stringify({ callId, uplinkMode, ...ownership }),
      headers: { Authorization: `Bearer ${voiceCallApiToken}`, 'Content-Type': 'application/json' },
      method: 'POST',
      signal,
    });
    if (!response.ok) {
      throw new VoiceCallTokenError(compactErrorMessage(response.status), response.status, baseUrl);
    }
    const data = (await response.json()) as VoiceCallSpeechStandbyResponse;
    if (data.standbyRevision !== ownership.standbyRevision) {
      throw new VoiceCallTokenError('电话线后端需要更新后重试。', undefined, baseUrl);
    }
    return { baseUrl, data };
  }, action === 'start' ? 15000 : 5000));
}

type VoiceCallSpeechStandbyResult = { baseUrl: string; data: VoiceCallSpeechStandbyResponse } | null;
type StandbyRequestOwnership = { standbyRevision: number; validUntilMs: number };
let lastStandbyRevision = 0;
function nextStandbyOwnership(): StandbyRequestOwnership {
  lastStandbyRevision = Math.max(Date.now(), lastStandbyRevision + 1);
  return { standbyRevision: lastStandbyRevision, validUntilMs: lastStandbyRevision + 60000 };
}
type StandbyStartFlight = { uplinkMode: VoiceCallUplinkMode; cancelled: boolean; sent: boolean;
  promise: Promise<VoiceCallSpeechStandbyResult> };
type StandbyCallFlight = { starts: Set<StandbyStartFlight>; tail: Promise<unknown>;
  stop?: Promise<VoiceCallSpeechStandbyResult> };
const standbyCallFlights = new Map<string, StandbyCallFlight>();
function standbyCallFlight(callId: string) {
  let state = standbyCallFlights.get(callId);
  if (!state) { state = { starts: new Set(), tail: Promise.resolve() }; standbyCallFlights.set(callId, state); }
  return state;
}
function releaseStandbyCallFlight(callId: string, state: StandbyCallFlight) {
  if (!state.starts.size && !state.stop && standbyCallFlights.get(callId) === state) standbyCallFlights.delete(callId);
}

export function prewarmVoiceCallSpeech(callId: string, uplinkMode: VoiceCallUplinkMode = 'auto') {
  const state = standbyCallFlight(callId);
  const existing = [...state.starts].find(value => !value.cancelled && value.uplinkMode === uplinkMode);
  if (existing) return existing.promise;
  let flight: StandbyStartFlight;
  const promise = requestVoiceCallSpeechStandby(callId, 'start', uplinkMode, nextStandbyOwnership(), send => {
    if (flight.cancelled) return Promise.resolve(null);
    const sending = state.tail.catch(() => undefined).then(() => {
      if (flight.cancelled) return null;
      flight.sent = true;
      return send();
    });
    state.tail = sending;
    return sending;
  }).finally(() => { state.starts.delete(flight); releaseStandbyCallFlight(callId, state); });
  flight = { uplinkMode, cancelled: false, sent: false, promise };
  state.starts.add(flight);
  return promise;
}

export function stopPrewarmedVoiceCallSpeech(callId: string) {
  const state = standbyCallFlight(callId);
  let sent = false;
  for (const flight of state.starts) { flight.cancelled = true; sent ||= flight.sent; }
  if (state.stop) return state.stop;
  const ownership = nextStandbyOwnership();
  // Both stop attempts belong to this stop, even if their responses arrive late.
  const early = sent ? requestVoiceCallSpeechStandby(callId, 'stop', 'auto', ownership).catch(() => null) : undefined;
  const stopping = Promise.all([state.tail.catch(() => undefined), early])
    .then(() => requestVoiceCallSpeechStandby(callId, 'stop', 'auto', ownership))
    .finally(() => { if (state.stop === stopping) state.stop = undefined; releaseStandbyCallFlight(callId, state); });
  state.stop = stopping;
  state.tail = stopping;
  return stopping;
}

export async function requestVoiceCallTestSpeech(
  callId: string,
  text = '小仓鼠，能听见我吗？',
  uplinkMode: Exclude<VoiceCallUplinkMode, 'auto'> = 'livekit',
  sourceTurnId?: string,
  limits: {
    dailyLimitUtf8Bytes: number;
    intent: VoiceCallTtsIntent;
    perCallNewSynthesisLimit: number;
  } = {
    dailyLimitUtf8Bytes: 9000,
    intent: 'manual',
    perCallNewSynthesisLimit: 4,
  },
) {
  const cachedContext = recentVoiceCallRequestContext?.callId === callId
    ? recentVoiceCallRequestContext
    : null;
  const settings = cachedContext ? null : await loadBackendSettings();
  const voiceCallApiToken = cachedContext?.voiceCallApiToken ?? await getVoiceCallApiToken();
  const baseUrl = cachedContext?.baseUrl ?? normalizeBaseUrl(settings?.baseUrl ?? '');
  if (!baseUrl) {
    throw new VoiceCallTokenError('还没有填写电脑后端地址。');
  }
  if (!voiceCallApiToken) {
    throw new VoiceCallTokenError('还没有填写本地语音后端访问令牌。请在电脑小管家复制后，粘贴到语音通话设置并保存。', undefined, baseUrl);
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/voice-call/test-speech`, {
      body: JSON.stringify({ callId, text, uplinkMode, sourceTurnId, ...limits }),
      headers: { Authorization: `Bearer ${voiceCallApiToken}`, 'Content-Type': 'application/json' },
      method: 'POST',
    });
  } catch {
    throw new VoiceCallTokenError('连不上电脑后端。检查后端地址、WiFi、防火墙和 USB/局域网连接。', undefined, baseUrl);
  }
  if (!response.ok) {
    throw await makeVoiceCallResponseError(response, baseUrl);
  }
  if (recentVoiceCallRequestContext?.callId === callId) {
    recentVoiceCallRequestContext = null;
  }
  return {
    baseUrl,
    data: (await response.json()) as VoiceCallTestSpeechResponse,
    reusedConnectionContext: cachedContext !== null,
  };
}

export async function fetchVoiceCallDiagnostics(callId: string): Promise<VoiceCallBackendDiagnostics> {
  const settings = await loadBackendSettings();
  const token = await getVoiceCallApiToken();
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  if (!baseUrl || !token) throw new VoiceCallTokenError('电话线后端尚未配置。');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${baseUrl}/api/voice-call/diagnostics/${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const result = sanitizeVoiceCallBackendDiagnostics(await response.json());
    if (!result || result.callId !== callId) throw new Error('invalid_diagnostics');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchVoiceCallBudget(callId?: string, signal?: AbortSignal) {
  const [backendSettings, voiceCallConfig] = await Promise.all([
    loadBackendSettings(),
    loadVoiceCallSettings(),
  ]);
  const voiceCallApiToken = voiceCallConfig.secrets.voiceCallApiToken;
  const baseUrl = normalizeBaseUrl(backendSettings.baseUrl);
  if (!baseUrl) throw new VoiceCallTokenError('还没有填写电脑后端地址。');
  if (!voiceCallApiToken) throw new VoiceCallTokenError('还没有填写本地语音后端访问令牌。', undefined, baseUrl);
  const query = new URLSearchParams({
    dailyLimitUtf8Bytes: String(voiceCallConfig.settings.dailyCharacterLimit * 3),
    perCallNewSynthesisLimit: String(voiceCallConfig.settings.maxNewSynthesesPerCall),
  });
  if (callId) query.set('callId', callId);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/voice-call/budget?${query.toString()}`, {
      headers: { Authorization: `Bearer ${voiceCallApiToken}` },
      signal,
    });
  } catch {
    throw new VoiceCallTokenError('连不上电脑后端。', undefined, baseUrl);
  }
  if (!response.ok) throw await makeVoiceCallResponseError(response, baseUrl);
  const payload = await response.json() as { budget: VoiceCallBudgetSnapshot; ok: boolean };
  return { baseUrl, data: payload.budget };
}

export async function requestVoiceCallVadStatus(callId: string, signal?: AbortSignal) {
  const settings = await loadBackendSettings();
  const voiceCallApiToken = await getVoiceCallApiToken();
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  if (!baseUrl) {
    throw new VoiceCallTokenError('还没有填写电脑后端地址。');
  }
  if (!voiceCallApiToken) {
    throw new VoiceCallTokenError('还没有填写本地语音后端访问令牌。请在电脑小管家复制后，粘贴到语音通话设置并保存。', undefined, baseUrl);
  }
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/voice-call/vad-status?callId=${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${voiceCallApiToken}` },
      signal,
    });
  } catch {
    throw new VoiceCallTokenError('连不上电脑后端。检查后端地址、WiFi、防火墙和 USB/局域网连接。', undefined, baseUrl);
  }
  if (!response.ok) {
    throw new VoiceCallTokenError(compactVadStatusErrorMessage(response.status), response.status, baseUrl);
  }
  return { baseUrl, data: (await response.json()) as VoiceCallVADStatus };
}
