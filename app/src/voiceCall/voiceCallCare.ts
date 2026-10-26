import { interpretBaiyunSituation } from '../ai/behavior/actionSituation';
import type {
  VoiceCallEmotionSignalEvent,
  VoiceCallPlaybackEvent,
  VoiceCallTranscriptEvent,
} from './voiceCallRoomClient';

export type VoiceCallCareReason =
  | 'explicit_distress'
  | 'initial_silence'
  | 'non_text_distress'
  | 'silence_after_care';

export type VoiceCallCareTrigger = {
  emotion?: VoiceCallEmotionSignalEvent;
  reason: Exclude<VoiceCallCareReason, 'explicit_distress'>;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type VoiceCallCarePolicyOptions = {
  canTrigger: () => boolean;
  clearTimer?: (timer: TimerHandle) => void;
  now?: () => number;
  onTrigger: (trigger: VoiceCallCareTrigger) => void;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
};

type PendingNonTextTurn = {
  emotion?: VoiceCallEmotionSignalEvent;
  transcript?: VoiceCallTranscriptEvent;
};

const FIRST_SILENCE_MS = 6_000;
const SECOND_SILENCE_MS = 8_000;
const NON_TEXT_EVIDENCE_WINDOW_MS = 60_000;
const MAX_AUTOMATIC_CARE_ATTEMPTS = 2;

const HISTORICAL_OR_REPORTED_SCOPE = /(?:昨天|前天|以前|曾经|当时|上次|梦见|梦到|梦里|歌词|小说|故事|别人说|她说|他说|她问|他问)/u;
const HYPOTHETICAL_SCOPE = /(?:如果|假如|要是|万一|假设|会不会有一天)/u;
const NEGATED_DISTRESS = /(?:不|没|没有|并不|并没有).{0,5}(?:难受|哭|害怕|委屈|闪回|撑不住|伤心)/u;
const CURRENT_EXPLICIT_DISTRESS = /(?:我(?:现在|此刻|这会儿|刚刚)?(?:真的|很|好|特别|非常)?(?:难受|害怕|恐慌|委屈|伤心)|我(?:现在|此刻|这会儿)?(?:撑不住|受不了)(?:了)?|我(?:正在|又)?哭(?:了|着)?)/u;

export function detectExplicitVoiceCallDistress(text: string, messageId: string, sentAt: number) {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (!normalized || HISTORICAL_OR_REPORTED_SCOPE.test(normalized)
    || HYPOTHETICAL_SCOPE.test(normalized) || NEGATED_DISTRESS.test(normalized)) {
    return false;
  }
  if (CURRENT_EXPLICIT_DISTRESS.test(normalized)) return true;
  const interpretation = interpretBaiyunSituation({
    currentMessage: {
      id: messageId,
      role: 'you',
      sentAt,
      text: normalized,
    },
  });
  return interpretation.confidence === 'high'
    && !interpretation.requiresSemanticReview
    && interpretation.blockers.length === 0
    && interpretation.candidates.some((candidate) => (
      candidate.intentId === 'soothe'
      && candidate.score >= 0.9
      && candidate.sourceMessageIds.includes(messageId)
    ));
}

function isDistressEmotion(event: VoiceCallEmotionSignalEvent) {
  return event.status === 'ok'
    && event.confidenceLevel !== 'low'
    && (event.label === 'sad' || event.label === 'fearful');
}

export class VoiceCallCarePolicy {
  private automaticAttempts = 0;
  private readonly careSourceTurnIds = new Set<string>();
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly completedNonTextTurnIds = new Set<string>();
  private distressEvidence: Array<{ at: number; emotion: VoiceCallEmotionSignalEvent }> = [];
  private readonly now: () => number;
  private readonly options: VoiceCallCarePolicyOptions;
  private readonly pendingNonTextTurns = new Map<string, PendingNonTextTurn>();
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private stopped = false;
  private timer: TimerHandle | null = null;

  constructor(options: VoiceCallCarePolicyOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  start() {
    if (this.stopped) return;
    this.armSilenceTimer('initial_silence', FIRST_SILENCE_MS);
  }

  stop() {
    this.stopped = true;
    this.cancelSilenceTimer();
    this.pendingNonTextTurns.clear();
    this.completedNonTextTurnIds.clear();
    this.distressEvidence = [];
    this.careSourceTurnIds.clear();
  }

  handleVoiceActivity(active: boolean) {
    if (active) this.cancelSilenceTimer();
  }

  handleTranscript(event: VoiceCallTranscriptEvent) {
    if (this.stopped || !event.isFinal) return;
    this.cancelSilenceTimer();
    if (event.status === 'ok' && event.text.trim()) {
      this.resetNonTextEvidence();
      return;
    }
    if (event.status !== 'not_heard') {
      this.resetNonTextEvidence();
      return;
    }
    const pending = this.pendingNonTextTurns.get(event.turnId) ?? {};
    pending.transcript = event;
    this.pendingNonTextTurns.set(event.turnId, pending);
    this.completeNonTextTurn(event.turnId);
  }

  handleEmotion(event: VoiceCallEmotionSignalEvent) {
    if (this.stopped || this.completedNonTextTurnIds.has(event.turnId)) return;
    const pending = this.pendingNonTextTurns.get(event.turnId) ?? {};
    pending.emotion = event;
    this.pendingNonTextTurns.set(event.turnId, pending);
    this.completeNonTextTurn(event.turnId);
  }

  handlePlaybackEvent(event: VoiceCallPlaybackEvent) {
    if (this.stopped) return;
    if (event.state !== 'completed') {
      this.cancelSilenceTimer();
      return;
    }
    if (event.sourceTurnId && this.careSourceTurnIds.has(event.sourceTurnId)) {
      this.armSilenceTimer('silence_after_care', SECOND_SILENCE_MS);
      return;
    }
    this.armSilenceTimer('initial_silence', FIRST_SILENCE_MS);
  }

  claimAutomaticCare(reason: VoiceCallCareReason, allowWhileBusy = false) {
    if (this.stopped || this.automaticAttempts >= MAX_AUTOMATIC_CARE_ATTEMPTS) return false;
    if (!allowWhileBusy && !this.options.canTrigger()) return false;
    this.cancelSilenceTimer();
    this.automaticAttempts += 1;
    return true;
  }

  registerCareSourceTurn(sourceTurnId: string) {
    this.careSourceTurnIds.add(sourceTurnId);
  }

  getAutomaticAttempts() {
    return this.automaticAttempts;
  }

  private armSilenceTimer(
    reason: Extract<VoiceCallCareReason, 'initial_silence' | 'silence_after_care'>,
    delayMs: number,
  ) {
    this.cancelSilenceTimer();
    if (this.stopped || this.automaticAttempts >= MAX_AUTOMATIC_CARE_ATTEMPTS) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.claimAutomaticCare(reason)) return;
      this.options.onTrigger({ reason });
    }, delayMs);
  }

  private cancelSilenceTimer() {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private completeNonTextTurn(turnId: string) {
    const pending = this.pendingNonTextTurns.get(turnId);
    if (!pending?.transcript || !pending.emotion) return;
    this.pendingNonTextTurns.delete(turnId);
    this.completedNonTextTurnIds.add(turnId);
    const now = this.now();
    this.distressEvidence = this.distressEvidence.filter(
      (entry) => now - entry.at <= NON_TEXT_EVIDENCE_WINDOW_MS,
    );
    if (!isDistressEmotion(pending.emotion)) {
      this.distressEvidence = [];
      return;
    }
    this.distressEvidence.push({ at: now, emotion: pending.emotion });
    if (this.distressEvidence.length < 2) return;
    const emotion = this.distressEvidence.at(-1)?.emotion;
    this.distressEvidence = [];
    if (!this.claimAutomaticCare('non_text_distress')) return;
    this.options.onTrigger({ emotion, reason: 'non_text_distress' });
  }

  private resetNonTextEvidence() {
    this.pendingNonTextTurns.clear();
    this.distressEvidence = [];
  }
}

export const voiceCallCareTiming = {
  firstSilenceMs: FIRST_SILENCE_MS,
  maximumAutomaticAttempts: MAX_AUTOMATIC_CARE_ATTEMPTS,
  nonTextEvidenceWindowMs: NON_TEXT_EVIDENCE_WINDOW_MS,
  secondSilenceMs: SECOND_SILENCE_MS,
} as const;
