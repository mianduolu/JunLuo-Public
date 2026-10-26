import AsyncStorage from '@react-native-async-storage/async-storage';

const INDEX_KEY = 'junluo.voiceCall.diagnostics.v1.index';
const RECORD_PREFIX = 'junluo.voiceCall.diagnostics.v1.call.';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CALLS = 20;
const MAX_EVENTS = 500;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const NUMBER_KEYS = new Set([
  'latencyMs', 'elapsedMs', 'durationMs', 'textLength', 'textUtf8Bytes', 'bytes',
  'frames', 'micFrames', 'turns', 'rms', 'peak', 'confidence', 'vadVolume', 'score',
  'statusCode', 'sampleRate', 'channels', 'automaticCareAttempt', 'candidateCount',
  'outputFrames', 'callDurationMs', 'startDelayMs', 'startupLatencyMs',
  'pendingPcmBytes',
  'savedCount', 'discardedCount', 'pendingCount',
  'choiceCount', 'completionTokens', 'promptTokens', 'totalTokens',
  'rawContentChars', 'reasoningContentChars', 'cleanedContentChars',
]);
const BOOLEAN_KEYS = new Set([
  'active', 'audioPlaybackAllowed', 'cacheHit', 'changed', 'cognitionDegraded',
  'emotionEnabled', 'fallback', 'localMicEnabled', 'playing',
  'reusedConnectionContext', 'streaming', 'stopped', 'success',
  'wasTruncated', 'outputAccepted',
]);
const CODE_KEYS = new Set([
  'errorCode', 'errorType', 'intent', 'label', 'lastStage', 'provider', 'reason',
  'roomStatus', 'source', 'state', 'status', 'transport', 'uplinkMode', 'turnId',
  'roomState',
  'contentKind', 'finishReason',
  'sourceTurnId', 'playbackId', 'appState', 'identity', 'trackSid',
]);

export type VoiceCallDiagnosticEvent = {
  at: number;
  details: Record<string, string | number | boolean>;
  event: string;
  eventId?: string;
  source: 'app' | 'backend' | 'worker';
};

export type VoiceCallBackendDiagnostics = {
  callId: string;
  eventCount: number;
  events: VoiceCallDiagnosticEvent[];
  lastUpdatedAt: number | null;
  summary: Record<string, unknown>;
  truncated: boolean;
};

export type VoiceCallDiagnosticRecord = {
  id: string;
  callId?: string;
  connectedAt?: number;
  createdAt: number;
  direction: 'incoming' | 'outgoing' | 'test';
  endedAt?: number;
  endReason?: string;
  events: VoiceCallDiagnosticEvent[];
  eventCount: number;
  summaryStatus?: string;
  candidateCount?: number;
  backend?: VoiceCallBackendDiagnostics;
  backendFetchedAt?: number;
  backendFetchError?: string;
  truncated: boolean;
  updatedAt: number;
};

let active: VoiceCallDiagnosticRecord | null = null;
let sequence = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRecord: VoiceCallDiagnosticRecord | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export function filterVoiceCallDiagnosticDetails(details: unknown): Record<string, string | number | boolean> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const filtered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details).slice(0, 40)) {
    if (NUMBER_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)) filtered[key] = value;
    else if (BOOLEAN_KEYS.has(key) && typeof value === 'boolean') filtered[key] = value;
    else if (CODE_KEYS.has(key) && typeof value === 'string' && SAFE_CODE.test(value)) filtered[key] = value;
  }
  return filtered;
}

export function boundVoiceCallDiagnosticEvents(events: VoiceCallDiagnosticEvent[]) {
  return events.length <= MAX_EVENTS ? events : [...events.slice(0, 50), ...events.slice(-450)];
}

function keyFor(id: string) { return RECORD_PREFIX + id; }

async function loadIndex() {
  try {
    const parsed = JSON.parse(await AsyncStorage.getItem(INDEX_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && SAFE_CODE.test(id)) : [];
  } catch { return []; }
}

async function saveRecord(record: VoiceCallDiagnosticRecord) {
  const ids = await loadIndex();
  const currentIds = [record.id, ...ids.filter((id) => id !== record.id)];
  const keep: string[] = [];
  const remove: string[] = [];
  const now = Date.now();
  for (const id of currentIds) {
    const item = id === record.id ? record : await readVoiceCallDiagnostic(id);
    if (!item) continue;
    if (id === active?.id || (now - item.createdAt <= MAX_AGE_MS && keep.length < MAX_CALLS)) keep.push(id);
    else remove.push(id);
  }
  await AsyncStorage.setItem(keyFor(record.id), JSON.stringify(record));
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(keep));
  if (remove.length) await AsyncStorage.multiRemove(remove.map(keyFor));
}

function flushPendingRecord() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!pendingRecord) return;
  const snapshot = JSON.parse(JSON.stringify(pendingRecord)) as VoiceCallDiagnosticRecord;
  pendingRecord = null;
  writeQueue = writeQueue.catch(() => undefined).then(() => saveRecord(snapshot));
}

function queueSave(record: VoiceCallDiagnosticRecord, immediate = false) {
  if (pendingRecord && pendingRecord.id !== record.id) flushPendingRecord();
  pendingRecord = record;
  if (flushTimer) clearTimeout(flushTimer);
  if (immediate) flushPendingRecord();
  else flushTimer = setTimeout(flushPendingRecord, 1500);
}

export function beginVoiceCallDiagnostic(direction: VoiceCallDiagnosticRecord['direction'], callId?: string) {
  if (active && !active.endedAt) finishVoiceCallDiagnostic('end_unconfirmed');
  const now = Date.now();
  const id = `attempt-${now}-${++sequence}`;
  active = { id, callId, createdAt: now, updatedAt: now, direction, events: [], eventCount: 0, truncated: false };
  appendVoiceCallDiagnostic('attempt_started', { status: 'started' });
  queueSave(active, true);
  return id;
}

export function getActiveVoiceCallDiagnostic() { return active; }

export function bindVoiceCallDiagnostic(callId: string) {
  if (!active || !SAFE_CODE.test(callId)) return;
  active.callId = callId;
  appendVoiceCallDiagnostic('call_id_received');
}

export function appendVoiceCallDiagnostic(event: string, details: unknown = {}, callId?: string) {
  if (!active || !SAFE_CODE.test(event) || (callId && active.callId !== callId)) return null;
  const at = Date.now();
  const item: VoiceCallDiagnosticEvent = {
    at, details: filterVoiceCallDiagnosticDetails(details), event,
    eventId: `app-${at}-${++sequence}`, source: 'app',
  };
  active.events = boundVoiceCallDiagnosticEvents([...active.events, item]);
  active.eventCount += 1;
  active.truncated = active.eventCount > MAX_EVENTS;
  active.updatedAt = at;
  queueSave(active);
  return item;
}

export function markVoiceCallDiagnosticConnected() {
  if (!active || active.connectedAt) return;
  active.connectedAt = Date.now();
  appendVoiceCallDiagnostic('call_connected', { status: 'connected' });
}

export function finishVoiceCallDiagnostic(reason: string, failureCode?: string) {
  if (!active || active.endedAt) return active?.id;
  appendVoiceCallDiagnostic('call_finished', { reason, errorCode: failureCode });
  active.endedAt = Date.now();
  active.endReason = SAFE_CODE.test(reason) ? reason : 'unknown';
  const id = active.id;
  queueSave(active, true);
  active = null;
  return id;
}

export async function readVoiceCallDiagnostic(id: string): Promise<VoiceCallDiagnosticRecord | null> {
  if (!SAFE_CODE.test(id)) return null;
  try {
    const raw = await AsyncStorage.getItem(keyFor(id));
    if (!raw) return null;
    const value = JSON.parse(raw) as VoiceCallDiagnosticRecord;
    if (value.id !== id || !Array.isArray(value.events) || !Number.isFinite(value.createdAt)) return null;
    return {
      ...value,
      callId: typeof value.callId === 'string' && SAFE_CODE.test(value.callId) ? value.callId : undefined,
      direction: value.direction === 'incoming' || value.direction === 'outgoing' ? value.direction : 'test',
      endReason: typeof value.endReason === 'string' && SAFE_CODE.test(value.endReason) ? value.endReason : undefined,
      summaryStatus: typeof value.summaryStatus === 'string' && SAFE_CODE.test(value.summaryStatus) ? value.summaryStatus : undefined,
      candidateCount: typeof value.candidateCount === 'number' && Number.isFinite(value.candidateCount) ? value.candidateCount : undefined,
      backendFetchError: typeof value.backendFetchError === 'string' && SAFE_CODE.test(value.backendFetchError) ? value.backendFetchError : undefined,
      events: boundVoiceCallDiagnosticEvents(value.events.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || !SAFE_CODE.test(raw.event) || !Number.isFinite(raw.at)) return [];
        return [{
          at: raw.at, event: raw.event,
          eventId: typeof raw.eventId === 'string' && SAFE_CODE.test(raw.eventId) ? raw.eventId : undefined,
          source: raw.source === 'backend' || raw.source === 'worker' ? raw.source : 'app',
          details: filterVoiceCallDiagnosticDetails(raw.details),
        }];
      })),
      backend: value.backend ? sanitizeVoiceCallBackendDiagnostics(value.backend) ?? undefined : undefined,
    };
  } catch { return null; }
}

export async function listVoiceCallDiagnostics() {
  flushPendingRecord();
  await writeQueue.catch(() => undefined);
  const ids = await loadIndex();
  const values = await Promise.all(ids.map(readVoiceCallDiagnostic));
  const now = Date.now();
  const recent = values.filter((item): item is VoiceCallDiagnosticRecord => (
    !!item && (item.id === active?.id || now - item.createdAt <= MAX_AGE_MS)
  )).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_CALLS);
  if (recent.length !== ids.length) {
    const keepIds = new Set(recent.map((item) => item.id));
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(recent.map((item) => item.id)));
    await AsyncStorage.multiRemove(ids.filter((id) => !keepIds.has(id)).map(keyFor));
  }
  return recent;
}

export async function updateVoiceCallDiagnostic(id: string, patch: Partial<Pick<VoiceCallDiagnosticRecord,
  'backend' | 'backendFetchedAt' | 'backendFetchError' | 'summaryStatus' | 'candidateCount'>>) {
  flushPendingRecord();
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const item = active?.id === id ? active : await readVoiceCallDiagnostic(id);
    if (!item) return;
    Object.assign(item, patch, { updatedAt: Date.now() });
    await saveRecord(JSON.parse(JSON.stringify(item)) as VoiceCallDiagnosticRecord);
  });
  await writeQueue;
}

export async function appendVoiceCallDiagnosticToRecord(id: string, event: string, details: unknown = {}) {
  if (!SAFE_CODE.test(id) || !SAFE_CODE.test(event)) return;
  flushPendingRecord();
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const item = await readVoiceCallDiagnostic(id);
    if (!item) return;
    const at = Date.now();
    item.events = boundVoiceCallDiagnosticEvents([...item.events, {
      at, details: filterVoiceCallDiagnosticDetails(details), event,
      eventId: `app-${at}-${++sequence}`, source: 'app',
    }]);
    item.eventCount += 1;
    item.truncated = item.eventCount > MAX_EVENTS;
    item.updatedAt = at;
    await saveRecord(item);
  });
  await writeQueue;
}

export function sanitizeVoiceCallBackendDiagnostics(value: unknown): VoiceCallBackendDiagnostics | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.callId !== 'string' || !SAFE_CODE.test(input.callId) || !Array.isArray(input.events)) return null;
  const events = input.events.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.event !== 'string' || !SAFE_CODE.test(item.event) || typeof item.at !== 'number' || !Number.isFinite(item.at)) return [];
    return [{
      at: item.at,
      details: filterVoiceCallDiagnosticDetails(item.details),
      event: item.event,
      eventId: typeof item.eventId === 'string' && SAFE_CODE.test(item.eventId) ? item.eventId : undefined,
      source: item.source === 'app' || item.source === 'worker' ? item.source : 'backend',
    } as VoiceCallDiagnosticEvent];
  });
  return {
    callId: input.callId,
    eventCount: typeof input.eventCount === 'number' ? input.eventCount : events.length,
    events: boundVoiceCallDiagnosticEvents(events),
    lastUpdatedAt: typeof input.lastUpdatedAt === 'number' ? input.lastUpdatedAt : null,
    summary: input.summary && typeof input.summary === 'object' && !Array.isArray(input.summary)
      ? Object.fromEntries(Object.entries(input.summary).flatMap(([key, raw]) => {
        if (['vadTurns', 'interruptions', 'careTriggers', 'sttAttempts', 'ttsAttempts'].includes(key)
          && typeof raw === 'number' && Number.isFinite(raw)) return [[key, raw]];
        return [];
      })) : {},
    truncated: input.truncated === true,
  };
}

export function formatVoiceCallDiagnosticCopy(record: VoiceCallDiagnosticRecord) {
  const serverIds = new Set(record.backend?.events.map((event) => event.eventId).filter(Boolean));
  const events = [...record.events.filter((event) => !serverIds.has(event.eventId)), ...(record.backend?.events ?? [])]
    .sort((a, b) => a.at - b.at);
  const lines = [
    `通话诊断 ${new Date(record.createdAt).toLocaleString('zh-CN')}`,
    `方向：${record.direction}；接通：${record.connectedAt ? '是' : '否'}；结束：${record.endReason ?? '未确认'}`,
    `通话编号：${record.callId ?? '接线前失败'}`,
    `小记：${record.summaryStatus ?? '未记录'}；记忆候选：${record.candidateCount ?? '未记录'}`,
    `后端：${record.backend ? `已获取，${new Date(record.backendFetchedAt ?? 0).toLocaleString('zh-CN')}` : '未取得'}`,
    ...(record.backend ? [`统计：${JSON.stringify(record.backend.summary)}`] : []),
    ...(record.truncated || record.backend?.truncated ? ['明细已截短'] : []),
  ];
  for (const item of events) lines.push(`${new Date(item.at).toLocaleString('zh-CN')} [${item.source}] ${item.event} ${JSON.stringify(item.details)}`);
  return lines.join('\n');
}
