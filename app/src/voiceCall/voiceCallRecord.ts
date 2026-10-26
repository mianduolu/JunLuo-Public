import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import type { VoiceCallMemoryUsageReceipt } from './voiceCallMemoryUsage';
import { isVoiceCallMemoryUsageReceipt, isVoiceCallMemoryOrganizationState } from './voiceCallRecordFormat';

export type VoiceCallRecordDirection = 'incoming' | 'outgoing' | 'test';
export type VoiceCallEndReason = 'app-left' | 'assistant-ended' | 'duration-limit' | 'line-disconnected' | 'user-hangup';
export type VoiceCallSummaryStatus = 'disabled' | 'failed' | 'pending' | 'ready' | 'skipped';
export type VoiceCallEmotionHint =
  | '暂无明显倾向'
  | '可能脆弱或低落'
  | '可能害怕或紧张'
  | '可能烦躁或抗拒'
  | '可能开心或激动';

export type VoiceCallIDelivery =
  | 'completed'
  | 'display_only'
  | 'failed'
  | 'interrupted'
  | 'queued'
  | 'started';

export type VoiceCallMemoryCandidate = {
  arousal: number;
  atomicKind: 'event' | 'fact' | 'preference' | 'relationship_change' | 'relationship_rule';
  candidateKind: 'emotional_weather' | 'long_term' | 'small_note';
  confidence: number;
  content: string;
  domain: '其他' | '喜好' | '日常' | '称呼' | '约定' | '经历' | '相处' | '边界';
  importance: number;
  recallCues: string[];
  rememberedReason: string;
  semanticType: 'entity' | 'event' | 'other' | 'pattern' | 'preference' | 'profile';
  stability: number;
  suggestedAnchor: boolean;
  suggestedAnchorKind: 'boundary' | 'identity' | 'name' | 'other' | 'preference' | 'promise' | 'relationship_rule';
  tags: string[];
  title: string;
  valence: number;
};

export type VoiceCallYouTurnRecord = {
  at: number;
  confidence?: number;
  durationMs?: number;
  emotion?: {
    confidenceLevel: 'high' | 'low' | 'medium';
    hint: VoiceCallEmotionHint;
    label: string;
    score: number;
  };
  fallback?: boolean;
  language?: string;
  provider?: string;
  role: 'you';
  text: string;
  transcriptStatus: 'ok';
  turnId: string;
};

export type VoiceCallITurnRecord = {
  at: number;
  delivery: VoiceCallIDelivery;
  playbackFailureCode?: 'call_tts_budget_exhausted' | 'daily_tts_budget_exhausted';
  playbackId?: string;
  role: 'I';
  text: string;
  turnId: string;
};

export function getVoiceCallDeliveryLabel(turn: VoiceCallITurnRecord) {
  if (turn.delivery === 'failed') {
    if (turn.playbackFailureCode === 'call_tts_budget_exhausted') return '本通语音次数已用完';
    if (turn.playbackFailureCode === 'daily_tts_budget_exhausted') return '今日语音额度已用完';
    return '这句未播出';
  }
  if (turn.delivery === 'completed') return '已说完';
  if (turn.delivery === 'interrupted') return '被打断';
  if (turn.delivery === 'queued') return '等待播放';
  if (turn.delivery === 'started') return '播放中';
  return '只显示';
}
export type VoiceCallTurnRecord = VoiceCallITurnRecord | VoiceCallYouTurnRecord;

export type VoiceCallRecord = {
  callId: string;
  direction: VoiceCallRecordDirection;
  durationMs: number;
  emotionSummary?: VoiceCallYouTurnRecord['emotion'];
  endedAt: number;
  endReason: VoiceCallEndReason;
  failedTranscriptCount: number;
  failures: string[];
  memoryCandidates: VoiceCallMemoryCandidate[];
  memoryOrganization?: import('./voiceCallMemoryOrganization').VoiceCallMemoryOrganizationState;
  memoryUsageReceipts?: VoiceCallMemoryUsageReceipt[];
  memoryUsageSavedAt?: number;
  rawAudioSaved: false;
  schemaVersion: 1;
  startedAt: number;
  summary: string;
  summaryCompletedAt?: number;
  summaryFailureReason?: string;
  summaryStatus: VoiceCallSummaryStatus;
  turns: VoiceCallTurnRecord[];
  unheardCount: number;
};

export type VoiceCallRecordDraft = {
  dataEpoch?: number | null;
  record: VoiceCallRecord;
  targetSessionId?: string;
  version: 1;
};

type TranscriptInput = {
  callId: string;
  confidence?: number | null;
  durationMs?: number;
  fallback?: boolean;
  isFinal?: boolean;
  language?: string | null;
  provider?: string | null;
  status: 'failed' | 'not_heard' | 'ok';
  text?: string;
  turnId: string;
};

type EmotionInput = {
  callId: string;
  confidenceLevel?: 'high' | 'low' | 'medium';
  label?: string;
  score?: number;
  status: 'failed' | 'ok' | 'uncertain';
  turnId: string;
};

type PlaybackInput = {
  callId: string;
  playbackId: string;
  sourceTurnId?: string;
  state: 'completed' | 'failed' | 'interrupted' | 'started';
};

const DEFAULT_EMOTION_HINT: VoiceCallEmotionHint = '暂无明显倾向';

export function getVoiceCallRecordEmotionHint(label?: string): VoiceCallEmotionHint {
  if (label === 'sad') return '可能脆弱或低落';
  if (label === 'fearful') return '可能害怕或紧张';
  if (label === 'angry' || label === 'disgusted') return '可能烦躁或抗拒';
  if (label === 'happy' || label === 'surprised') return '可能开心或激动';
  return DEFAULT_EMOTION_HINT;
}

function makeEmotionRecord(event: EmotionInput): NonNullable<VoiceCallYouTurnRecord['emotion']> | undefined {
  if (event.status === 'failed' || !event.label) return undefined;
  const score = clampNumber(event.score, 0, 1, 0);
  return {
    confidenceLevel: event.confidenceLevel ?? (score >= 0.7 ? 'high' : score >= 0.45 ? 'medium' : 'low'),
    hint: getVoiceCallRecordEmotionHint(event.label),
    label: event.label,
    score,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function uniqueStrings(values: string[], limit = 12) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, limit);
}

export class VoiceCallRecordCollector {
  private readonly dataEpoch = captureBackupRestoreDataEpoch();
  private readonly handledTranscriptTurnIds = new Set<string>();
  private readonly pendingEmotions = new Map<string, NonNullable<VoiceCallYouTurnRecord['emotion']>>();
  private record: VoiceCallRecord;
  private targetSessionId?: string;
  private frozen = false;

  constructor(input: {
    callId: string;
    direction: VoiceCallRecordDirection;
    startedAt: number;
    targetSessionId?: string;
  }) {
    this.targetSessionId = input.targetSessionId;
    this.record = {
      callId: input.callId,
      direction: input.direction,
      durationMs: 0,
      endedAt: input.startedAt,
      endReason: 'app-left',
      failedTranscriptCount: 0,
      failures: [],
      memoryCandidates: [],
      rawAudioSaved: false,
      schemaVersion: 1,
      startedAt: input.startedAt,
      summary: '',
      summaryStatus: 'pending',
      turns: [],
      unheardCount: 0,
    };
  }

  setTargetSessionId(sessionId: string | null | undefined) {
    if (this.frozen || !sessionId?.trim()) return;
    this.targetSessionId = sessionId.trim();
  }

  handleTranscript(event: TranscriptInput, at = Date.now()) {
    if (this.frozen || event.callId !== this.record.callId || !event.isFinal || this.handledTranscriptTurnIds.has(event.turnId)) return;
    this.handledTranscriptTurnIds.add(event.turnId);
    if (event.status === 'not_heard') {
      this.record.unheardCount += 1;
      return;
    }
    if (event.status === 'failed') {
      this.record.failedTranscriptCount += 1;
      this.addFailure('transcript_failed');
      return;
    }
    const text = event.text?.replace(/\s+/g, ' ').trim() ?? '';
    if (!text) {
      this.record.unheardCount += 1;
      return;
    }
    this.record.turns.push({
      at,
      confidence: typeof event.confidence === 'number' ? clampNumber(event.confidence, 0, 1, 0) : undefined,
      durationMs: typeof event.durationMs === 'number' ? Math.max(0, event.durationMs) : undefined,
      emotion: this.pendingEmotions.get(event.turnId),
      fallback: event.fallback === true || undefined,
      language: event.language?.trim() || undefined,
      provider: event.provider?.trim() || undefined,
      role: 'you',
      text,
      transcriptStatus: 'ok',
      turnId: event.turnId,
    });
    this.pendingEmotions.delete(event.turnId);
  }

  handleEmotion(event: EmotionInput) {
    if (this.frozen || event.callId !== this.record.callId) return;
    const emotion = makeEmotionRecord(event);
    if (!emotion) {
      if (event.status === 'failed') this.addFailure('emotion_failed');
      return;
    }
    const turn = this.record.turns.find((item): item is VoiceCallYouTurnRecord => item.role === 'you' && item.turnId === event.turnId);
    if (turn) turn.emotion = emotion;
    else this.pendingEmotions.set(event.turnId, emotion);
  }

  recordIReply(input: { at?: number; text: string; turnId: string }) {
    if (this.frozen) return;
    const text = input.text.replace(/\s+/g, ' ').trim();
    if (!text || !input.turnId) return;
    const existing = this.findITurn(input.turnId);
    if (existing) {
      existing.text = text;
      return;
    }
    this.record.turns.push({
      at: input.at ?? Date.now(),
      delivery: 'display_only',
      role: 'I',
      text,
      turnId: input.turnId,
    });
  }

  recordMemoryUsage(turnId: string, receipt: VoiceCallMemoryUsageReceipt) {
    if (this.frozen || receipt.callId !== this.record.callId || receipt.turnId !== turnId
      || receipt.dataEpoch !== this.dataEpoch || !isVoiceCallMemoryUsageReceipt(receipt)) return;
    const receipts = this.record.memoryUsageReceipts ?? [];
    if (receipts.some(item => item.turnId === turnId)) return;
    this.record.memoryUsageReceipts = [...receipts, JSON.parse(JSON.stringify(receipt)) as VoiceCallMemoryUsageReceipt];
  }

  markPlaybackQueued(input: { playbackId: string; sourceTurnId?: string }) {
    if (this.frozen || !input.sourceTurnId) return;
    const turn = this.findITurn(input.sourceTurnId);
    if (!turn || turn.delivery === 'completed' || turn.delivery === 'interrupted') return;
    turn.delivery = 'queued';
    turn.playbackFailureCode = undefined;
    turn.playbackId = input.playbackId;
  }

  handlePlayback(event: PlaybackInput) {
    if (this.frozen || event.callId !== this.record.callId) return;
    const turn = (event.sourceTurnId ? this.findITurn(event.sourceTurnId) : undefined)
      ?? this.record.turns.find((item): item is VoiceCallITurnRecord => item.role === 'I' && item.playbackId === event.playbackId);
    if (!turn) return;
    turn.playbackId = event.playbackId;
    turn.delivery = event.state;
    turn.playbackFailureCode = undefined;
    if (event.state === 'failed') this.addFailure('playback_failed');
  }

  markPlaybackFailed(sourceTurnId?: string, code?: string) {
    if (this.frozen || !sourceTurnId) return;
    const turn = this.findITurn(sourceTurnId);
    if (turn && turn.delivery !== 'completed' && turn.delivery !== 'interrupted') {
      turn.delivery = 'failed';
      turn.playbackFailureCode = code === 'call_tts_budget_exhausted' || code === 'daily_tts_budget_exhausted'
        ? code
        : undefined;
    }
    this.addFailure('playback_failed');
  }

  addFailure(code: string) {
    if (this.frozen) return;
    this.record.failures = uniqueStrings([...this.record.failures, code]);
  }

  toDraft(now = Date.now()): VoiceCallRecordDraft {
    return {
      dataEpoch: this.dataEpoch,
      record: this.snapshot({ endedAt: now, endReason: 'app-left' }),
      targetSessionId: this.targetSessionId,
      version: 1,
    };
  }

  freeze(endReason: VoiceCallEndReason, endedAt = Date.now()) {
    if (!this.frozen) {
      this.record.turns.forEach((turn) => {
        if (turn.role === 'I' && (turn.delivery === 'queued' || turn.delivery === 'started')) {
          turn.delivery = 'interrupted';
        }
      });
      this.record = this.snapshot({ endedAt, endReason });
      this.frozen = true;
    }
    return {
      dataEpoch: this.dataEpoch,
      record: structuredCloneRecord(this.record),
      targetSessionId: this.targetSessionId,
    };
  }

  private findITurn(turnId: string) {
    return this.record.turns.find((item): item is VoiceCallITurnRecord => item.role === 'I' && item.turnId === turnId);
  }

  private snapshot(input: { endedAt: number; endReason: VoiceCallEndReason }) {
    const turns = this.record.turns
      .map((turn) => ({ ...turn, ...(turn.role === 'you' && turn.emotion ? { emotion: { ...turn.emotion } } : {}) }))
      .sort((left, right) => left.at - right.at);
    const emotionSummary = turns
      .filter((turn): turn is VoiceCallYouTurnRecord => turn.role === 'you' && !!turn.emotion)
      .map((turn) => turn.emotion!)
      .sort((left, right) => right.score - left.score)[0];
    return {
      ...this.record,
      durationMs: Math.max(0, input.endedAt - this.record.startedAt),
      emotionSummary: emotionSummary ? { ...emotionSummary } : undefined,
      endedAt: input.endedAt,
      endReason: input.endReason,
      failures: [...this.record.failures],
      memoryCandidates: this.record.memoryCandidates.map((candidate) => ({
        ...candidate,
        recallCues: [...candidate.recallCues],
        tags: [...candidate.tags],
      })),
      ...(this.record.memoryUsageReceipts ? { memoryUsageReceipts: this.record.memoryUsageReceipts.map(receipt =>
        JSON.parse(JSON.stringify(receipt)) as VoiceCallMemoryUsageReceipt) } : {}),
      turns,
    } satisfies VoiceCallRecord;
  }
}

function structuredCloneRecord(record: VoiceCallRecord): VoiceCallRecord {
  return JSON.parse(JSON.stringify(record)) as VoiceCallRecord;
}

export function hasReliableVoiceCallText(record: VoiceCallRecord) {
  return record.turns.some((turn) => turn.role === 'you' && !!turn.text.trim());
}

export function isVoiceCallRecord(value: unknown): value is VoiceCallRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<VoiceCallRecord>;
  return item.schemaVersion === 1
    && typeof item.callId === 'string'
    && ['incoming', 'outgoing', 'test'].includes(item.direction ?? '')
    && typeof item.startedAt === 'number'
    && typeof item.endedAt === 'number'
    && typeof item.durationMs === 'number'
    && ['app-left', 'assistant-ended', 'duration-limit', 'line-disconnected', 'user-hangup'].includes(item.endReason ?? '')
    && typeof item.unheardCount === 'number'
    && typeof item.failedTranscriptCount === 'number'
    && Array.isArray(item.failures) && item.failures.every((entry) => typeof entry === 'string')
    && item.rawAudioSaved === false
    && ['disabled', 'failed', 'pending', 'ready', 'skipped'].includes(item.summaryStatus ?? '')
    && typeof item.summary === 'string'
    && (item.summaryCompletedAt == null || typeof item.summaryCompletedAt === 'number')
    && (item.summaryFailureReason == null || typeof item.summaryFailureReason === 'string')
    && Array.isArray(item.memoryCandidates) && item.memoryCandidates.every(isVoiceCallMemoryCandidate)
    && (item.memoryOrganization === undefined || isVoiceCallMemoryOrganizationState(item.memoryOrganization))
    && (item.memoryUsageSavedAt === undefined || typeof item.memoryUsageSavedAt === 'number' && Number.isFinite(item.memoryUsageSavedAt) && item.memoryUsageSavedAt > 0)
    && (item.memoryUsageReceipts === undefined || Array.isArray(item.memoryUsageReceipts)
      && item.memoryUsageReceipts.every(receipt => isVoiceCallMemoryUsageReceipt(receipt) && receipt.callId === item.callId))
    && Array.isArray(item.turns)
    && item.turns.every((turn) => isVoiceCallTurnRecord(turn));
}

function isVoiceCallMemoryCandidate(value: unknown): value is VoiceCallMemoryCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<VoiceCallMemoryCandidate>;
  return typeof item.title === 'string'
    && typeof item.content === 'string'
    && ['相处', '称呼', '喜好', '边界', '经历', '约定', '日常', '其他'].includes(item.domain ?? '')
    && Array.isArray(item.tags) && item.tags.every((entry) => typeof entry === 'string')
    && Array.isArray(item.recallCues) && item.recallCues.every((entry) => typeof entry === 'string')
    && typeof item.importance === 'number'
    && typeof item.valence === 'number'
    && typeof item.arousal === 'number'
    && typeof item.suggestedAnchor === 'boolean'
    && ['name', 'boundary', 'relationship_rule', 'preference', 'promise', 'identity', 'other'].includes(item.suggestedAnchorKind ?? '')
    && ['profile', 'preference', 'entity', 'event', 'pattern', 'other'].includes(item.semanticType ?? '')
    && typeof item.stability === 'number'
    && typeof item.confidence === 'number'
    && ['fact', 'preference', 'event', 'relationship_rule', 'relationship_change'].includes(item.atomicKind ?? '')
    && ['long_term', 'small_note', 'emotional_weather'].includes(item.candidateKind ?? '')
    && typeof item.rememberedReason === 'string';
}

function isVoiceCallTurnRecord(value: unknown): value is VoiceCallTurnRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<VoiceCallTurnRecord>;
  if (typeof item.turnId !== 'string' || typeof item.at !== 'number' || typeof item.text !== 'string') return false;
  if (item.role === 'you') {
    return item.transcriptStatus === 'ok'
      && (item.fallback == null || typeof item.fallback === 'boolean');
  }
  return item.role === 'I'
    && ['completed', 'display_only', 'failed', 'interrupted', 'queued', 'started'].includes(item.delivery ?? '')
    && (item.playbackFailureCode == null || [
      'call_tts_budget_exhausted',
      'daily_tts_budget_exhausted',
    ].includes(item.playbackFailureCode));
}
