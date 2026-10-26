import {
  createMemoryComment,
  createMemoryRecallFeedback,
  loadMemory,
  loadRecentRecallFeedback,
  setMemoryConfirmationLevel,
  updateMemoryReliabilityState,
  type MemoryCommentKind,
  type MemoryRecallFeedbackKind,
  type MemoryRecallItem,
} from './memoryStore';

export type MemoryCalibrationFeedback = Exclude<MemoryRecallFeedbackKind, 'irrelevant'>;

export type MemoryQualitySignals = {
  confirmedCount: number;
  correctedCount: number;
  lastConfirmedAt?: number;
  lastCorrectedAt?: number;
  lastOutdatedAt?: number;
  outdatedCount: number;
};

const CORRECTED_PATTERN = /(?:不是这个|不是这(?:个|回事|样)|你(?:记错|搞错|弄错|想错)|记得不对|想得不对|不是啦|不对\b)/;
const OUTDATED_PATTERN = /(?:现在不是这样|现在不(?:是|这么)|后来(?:改了|变了)|已经(?:变了|改了)|这个(?:过期|不适用)|以前是这样|那是以前|现在已经不是)/;
const CONFIRMED_PATTERN = /(?:对[，,\s]*(?:就是|是这个|没错)|没错|你记得对|记对了|就是这个|是这样|确实如此|对的\b)/;

function normalizeText(text: string) {
  return text.replace(/\s+/g, '').trim();
}

export function detectMemoryCalibrationFeedback(text: string): MemoryCalibrationFeedback | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (OUTDATED_PATTERN.test(normalized)) return 'outdated';
  if (CORRECTED_PATTERN.test(normalized)) return 'corrected';
  if (CONFIRMED_PATTERN.test(normalized)) return 'confirmed';
  return null;
}

function selectCalibrationTarget(items: MemoryRecallItem[] | null | undefined) {
  if (!items?.length) return null;
  return (
    items.find((item) => item.reason === 'suggested_mention')
    ?? items.find((item) => item.reason === 'quiet_context')
    ?? items[0]
  );
}

function commentKindForFeedback(feedback: MemoryCalibrationFeedback): MemoryCommentKind {
  if (feedback === 'confirmed') return 'confirmation';
  if (feedback === 'outdated') return 'update';
  return 'correction';
}

function commentTextForFeedback(feedback: MemoryCalibrationFeedback, text: string) {
  const excerpt = text.trim().slice(0, 80);
  if (feedback === 'confirmed') return `用户在本轮确认：这条记忆仍然准确。${excerpt ? `（${excerpt}）` : ''}`;
  if (feedback === 'outdated') return `用户在本轮更新：这条记忆更适合作为历史背景，当前状态可能已经变化。${excerpt ? `（${excerpt}）` : ''}`;
  return `用户在本轮纠正：这条记忆在当前语境里可能不准确或不适用。${excerpt ? `（${excerpt}）` : ''}`;
}

export async function applyMemoryCalibrationFeedbackFromUser(
  items: MemoryRecallItem[] | null | undefined,
  text: string,
  options: { query?: string } = {},
) {
  const feedback = detectMemoryCalibrationFeedback(text);
  const target = selectCalibrationTarget(items);
  if (!feedback || !target) return 0;

  const memory = await loadMemory(target.memory.id);
  if (!memory) return 0;

  await createMemoryRecallFeedback({
    kind: feedback,
    memoryId: memory.id,
    query: options.query?.trim() || target.memory.title || text,
    reason: target.reason,
    score: target.score,
    sources: target.sources,
  });

  await createMemoryComment(memory.id, commentTextForFeedback(feedback, text), 'chat', {
    author: '白云小姐',
    kind: commentKindForFeedback(feedback),
    source: 'memory-calibration',
    touch: false,
  });

  if (feedback === 'confirmed') {
    await setMemoryConfirmationLevel(memory.id, 'reviewed');
    const reliableDomain = memory.domain === '喜好' || memory.domain === '边界' || memory.domain === '称呼' || memory.domain === '约定';
    const reliableSemantic = memory.semanticType === 'preference' || memory.semanticType === 'profile' || memory.semanticType === 'entity';
    if (reliableDomain || reliableSemantic) {
      await updateMemoryReliabilityState(memory.id, {
        confidence: Math.min(1, (memory.confidence ?? 0.5) + 0.05),
        stability: Math.min(1, memory.stability + 0.04),
      });
    }
  }

  return 1;
}

export async function getMemoryQualitySignals(memoryId: string): Promise<MemoryQualitySignals> {
  const feedback = await loadRecentRecallFeedback({
    memoryId,
    limit: 80,
    since: Date.now() - 180 * 86400000,
  });
  const signals: MemoryQualitySignals = {
    confirmedCount: 0,
    correctedCount: 0,
    outdatedCount: 0,
  };
  feedback.forEach((item) => {
    if (item.kind === 'confirmed') {
      signals.confirmedCount += 1;
      signals.lastConfirmedAt = Math.max(signals.lastConfirmedAt ?? 0, item.createdAt);
    }
    if (item.kind === 'corrected') {
      signals.correctedCount += 1;
      signals.lastCorrectedAt = Math.max(signals.lastCorrectedAt ?? 0, item.createdAt);
    }
    if (item.kind === 'outdated') {
      signals.outdatedCount += 1;
      signals.lastOutdatedAt = Math.max(signals.lastOutdatedAt ?? 0, item.createdAt);
    }
  });
  return signals;
}
