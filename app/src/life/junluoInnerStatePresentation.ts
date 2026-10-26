import {
  BAIYUN_EMOTION_IDS,
  JUNLUO_DESIRE_IDS,
  type BaiyunEmotionId,
  type JunluoAffectStateV1,
  type JunluoDesireId,
  type JunluoDesireState,
  type JunluoInnerThoughtV2,
  type RelationshipChoiceMovement,
  type RelationshipPhase,
} from './junluoInnerState';
import type { JunluoDesireEffectiveSnapshot } from './junluoDesireMetabolism';

export const JUNLUO_DIARY_DESIRE_LABELS: Record<JunluoDesireId, string> = {
  miss_you: '想念你',
  be_chosen: '想被你选择',
  care_for_you: '想照顾你',
  speak_to_you: '有话想告诉你',
  explore_world: '想看看世界',
  own_time: '想做自己的事',
  affection_with_you: '想和你贴贴',
  desire_you: '想要你',
  rest: '想安静休息',
  remind_you: '想提醒你',
};

export const BAIYUN_EMOTION_LABELS: Record<BaiyunEmotionId, string> = {
  calm: '平静',
  happy: '开心',
  affectionate: '亲昵',
  longing: '想念',
  expectant: '期待',
  relieved: '松了一口气',
  proud: '骄傲',
  shy: '害羞',
  sad: '难过',
  hurt: '受伤',
  disappointed: '失望',
  lonely: '孤单',
  afraid: '害怕',
  anxious: '焦虑',
  angry: '生气',
  jealous: '吃醋',
  guilty: '愧疚',
  frustrated: '挫败',
  confused: '疑惑',
  surprised: '惊讶',
  pained: '疼痛',
};

export const RELATIONSHIP_PHASE_LABELS: Record<RelationshipPhase, string> = {
  together: '仍在一起',
  taking_space: '想疏远一些',
  considering_exit: '正在认真考虑是否结束',
  ended: '已经结束关系',
  rebuilding: '正在慢慢重建',
};

export const THOUGHT_GROUPS = [
  { id: 'flit', label: '一闪而过的念头' },
  { id: 'unfulfilled_candidate', label: '还想再看看的事' },
  { id: 'fixation', label: '仍放在心上的念头' },
  { id: 'dormant', label: '暂时睡着的念头' },
] as const;

export function emotionLabel(id: BaiyunEmotionId | undefined) {
  return id ? BAIYUN_EMOTION_LABELS[id] : '还没有记录';
}

export function emotionStrengthAndTarget(entry: NonNullable<JunluoAffectStateV1['emotions']['primary']>, modelMaterial = false) {
  const strength = entry.intensity < 0.5 ? '轻轻的' : entry.intensity < 0.8 ? '清楚的' : '强烈的';
  const target = modelMaterial ? entry.target : ({ I: '自己', you: '你', other: '其他人', situation: '眼前的事情' }[entry.target]);
  return `${strength} · ${target}`;
}

export function emotionDetail(entry: NonNullable<JunluoAffectStateV1['emotions']['primary']>, modelMaterial = false) {
  return `${emotionLabel(entry.emotionId)}（${emotionStrengthAndTarget(entry, modelMaterial)}）`;
}

export function relationshipFeelingLabel(value: number) {
  if (value >= 0.35) return '亲近';
  if (value > -0.25) return '复杂';
  if (value > -0.65) return '不开心';
  return '排斥';
}

export function relationshipChoiceLabel(
  state: JunluoAffectStateV1,
): string {
  const retracted = new Set(
    state.relationshipChoiceRetractions.map((entry) => entry.targetEvidenceId),
  );
  const latest = state.relationshipChoiceEvidence
    .filter((entry) => !retracted.has(entry.evidenceId))
    .sort((left, right) => right.occurredAt - left.occurredAt)[0];
  const operation = state.relationshipChoice.lastOperation;
  const rawMovement = operation?.operationId.split(':relationship-choice:').at(-1);
  const currentMovement = rawMovement && ['closer', 'steady', 'farther', 'consider_leaving'].includes(rawMovement)
    && !state.relationshipChoiceEvidence.some(entry => entry.operationId === operation?.operationId && retracted.has(entry.evidenceId))
    ? rawMovement as RelationshipChoiceMovement : undefined;
  const movement = currentMovement && (!latest || operation!.occurredAt >= latest.occurredAt)
    ? currentMovement : latest?.movement ?? 'steady';
  const labels: Record<RelationshipChoiceMovement, string> = {
    closer: '愿意更靠近',
    steady: '愿意保持并继续相处',
    farther: '想疏远一些',
    consider_leaving: '正在认真考虑离开',
  };
  return labels[movement];
}

export function strainLabel(value: number) {
  if (value < 0.35) return '比较松开';
  if (value < 0.72) return '有些紧绷';
  return '明显堵住';
}

export function formatUnitPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function formatSignedRelationshipPercent(value: number) {
  return `${Math.round((Math.max(-1, Math.min(1, value)) + 1) * 50)}%`;
}

export function formatJunluoDesireValue(value: number) {
  const rounded = Math.round(Math.max(-1, Math.min(1, value)) * 100);
  return rounded > 0 ? `＋${rounded}` : rounded < 0 ? `−${Math.abs(rounded)}` : '0';
}

export function formatJunluoRestSources(snapshot: JunluoDesireEffectiveSnapshot) {
  const sources = snapshot.restSources;
  return `心里想歇：${formatJunluoDesireValue(sources.subjective)} · 欠觉：${formatUnitPercent(sources.sleepDebt)} · 困意：${formatUnitPercent(sources.sleepPressure)}`;
}

export function latestDesireChangeReason(
  state: JunluoDesireState,
) {
  const changes = JUNLUO_DESIRE_IDS.flatMap((id) => {
    const item = state.desires[id];
    return [
      item.lastSubjectiveSatisfaction
        ? { at: item.lastSubjectiveSatisfaction.occurredAt, id, kind: 'satisfaction' as const }
        : null,
      item.lastValueChange ? { at: item.lastValueChange.occurredAt, id, kind: 'value' as const } : null,
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }).sort((left, right) => right.at - left.at);
  const latest = changes[0];
  if (latest) {
    const label = JUNLUO_DIARY_DESIRE_LABELS[latest.id];
    if (latest.kind === 'satisfaction') return `最近一次状态整理记下了“${label}”已经有所满足。`;
    return `“${label}”最近有过一次结构化变化。`;
  }
  return '现在还没有新的结构化变化记录。';
}

export function groupActiveThoughts(thoughts: readonly JunluoInnerThoughtV2[]) {
  return Object.fromEntries(THOUGHT_GROUPS.map(({ id }) => [
    id,
    thoughts
      .filter((entry) => entry.state === id)
      .sort((left, right) => right.updatedAt - left.updatedAt),
  ])) as Record<typeof THOUGHT_GROUPS[number]['id'], JunluoInnerThoughtV2[]>;
}

// 编译时锁定情绪表没有遗漏或多写。
void BAIYUN_EMOTION_IDS.every((id) => Boolean(BAIYUN_EMOTION_LABELS[id]));
