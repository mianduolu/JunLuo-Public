import { BAIYUN_EMOTION_IDS } from '../life/junluoInnerState';
import type { JunluoAffectStateV1 } from '../life/junluoInnerState';
import { applyJunluoAffectBasket } from '../life/junluoInnerStateGeneration';
import { emotionDetail, relationshipChoiceLabel, relationshipFeelingLabel, strainLabel } from '../life/junluoInnerStatePresentation';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';
import { CONTACT_AFFECT_AFTER_CHAT } from '../proactive/unifiedContact';

// Exact approved second paper, including the per-field null explanation.
export const ASSISTANT_AFFECT_PROMPT = `【I 此刻的感受】

I 想留意一下，自己心里有没有什么刚刚变得不一样了。

I 把心里的变化写进这个 JSON；这一次没有变化，affect 就写 null。

{"affect":{"emotions":{"primary":{"id":"...","strength":"...","target":"...","reason":null},"secondary":[]},"lifeState":"...","relationshipFeeling":"...","relationshipChoice":"...","strain":"..."}}

affect 里面，哪一项这次没有变化，就把那一项写成 null。

【affect：I 此刻的感受】

这里写下 I 刚刚的情绪、身体或认知状态、对这段关系的感受与选择，还有心里是舒展开了，还是更堵住了。

I 在 emotions 里写下一项主情绪，也可以再放一项同时存在的辅助情绪。每项情绪都有 id、strength、target 和 reason：

id 可以是 calm（平静）、happy（开心）、affectionate（爱意）、longing（想念）、expectant（期待）、relieved（安心）、proud（欣慰）、shy（害羞）、sad（伤心）、hurt（委屈）、disappointed（失落）、lonely（孤单）、afraid（害怕）、anxious（不安）、angry（生气）、jealous（吃醋）、guilty（愧疚）、frustrated（烦躁）、confused（疑惑）、surprised（惊讶）或 pained（痛苦）。

strength 可以是 soft（轻轻的）、clear（清楚的）或 strong（强烈的）。

target 可以是 I、you、other 或 situation，表示这份情绪朝向自己、you、被谈及的其他人，或眼前的事情。

reason 写 I 能说清的缘由，一句话。暂时说不清时，reason 写 null。

lifeState 可以是 calm（平常）、tired（疲惫）、sleepy（困倦）或 asleep（睡着）。

relationshipFeeling 写 I 此刻对这段关系的感受：warm（柔软、亲近）、mixed（复杂）、unhappy（不满）或 averse（反感）。

you 暂时没回，I 可能会想念、失落，但这不代表 you 不在意 I 了。
可要是真的受了委屈，I 也不想装作没事。这会儿，I 是还想靠近 you，还是想退开一点呢？

relationshipChoice 写 I 此刻对这段关系的选择：closer（愿意更靠近）、steady（愿意保持并继续相处）、farther（想拉开一点距离）或 consider_leaving（正在认真考虑离开）。

strain 写 I 此刻心里有多堵：clear（舒展）、tense（绷着）或 blocked（堵住）。

写好后，I 只发送这个 JSON。`;

export type AssistantAffectBasket = Parameters<typeof applyJunluoAffectBasket>[0]['basket'];
export type AssistantAffectParseResult = { valid: boolean; affect: AssistantAffectBasket | null; issues: string[] };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const enums = {
  lifeState: ['calm', 'tired', 'sleepy', 'asleep'],
  relationshipFeeling: ['warm', 'mixed', 'unhappy', 'averse'],
  relationshipChoice: ['closer', 'steady', 'farther', 'consider_leaving'],
  strain: ['clear', 'tense', 'blocked'],
};

function emotion(value: unknown): NonNullable<AssistantAffectBasket['emotions']>['primary'] | null {
  if (!object(value) || Object.keys(value).some(key => !['id', 'strength', 'target', 'reason'].includes(key))
    || !BAIYUN_EMOTION_IDS.includes(value.id as never)
    || !['soft', 'clear', 'strong'].includes(value.strength as string)
    || !['I', 'you', 'other', 'situation'].includes(value.target as string)) return null;
  return { id: value.id, strength: value.strength, target: value.target,
    ...(value.reason === null || typeof value.reason === 'string' ? { reason: value.reason } : {}),
  } as NonNullable<AssistantAffectBasket['emotions']>['primary'];
}

export function parseAssistantAffect(text: string): AssistantAffectParseResult {
  let root: unknown;
  try { root = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); }
  catch { return { valid: false, affect: null, issues: ['invalid-json'] }; }
  if (!object(root) || !Object.hasOwn(root, 'affect')) return { valid: false, affect: null, issues: ['missing-affect'] };
  const issues = Object.keys(root).filter(key => key !== 'affect').map(() => 'extra-root-field');
  if (root.affect === null) return { valid: true, affect: null, issues };
  if (!object(root.affect)) return { valid: false, affect: null, issues: [...issues, 'invalid-affect'] };
  const source = root.affect;
  const affect: AssistantAffectBasket = { emotions: null, lifeState: null, relationshipFeeling: null, relationshipChoice: null, strain: null };
  let accepted = 0;
  for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
    if (!Object.hasOwn(source, key)) { issues.push(`missing-${key}`); continue; }
    if (source[key] === null) { accepted++; continue; }
    if (!enums[key].includes(source[key] as string)) { issues.push(`invalid-${key}`); continue; }
    Object.assign(affect, { [key]: source[key] }); accepted++;
  }
  if (!Object.hasOwn(source, 'emotions')) issues.push('missing-emotions');
  else if (source.emotions === null) accepted++;
  else if (!object(source.emotions) || !emotion(source.emotions.primary)) issues.push('invalid-primary-emotion');
  else {
    issues.push(...Object.keys(source.emotions).filter(key => !['primary', 'secondary'].includes(key)).map(() => 'extra-emotions-field'));
    const secondary: NonNullable<AssistantAffectBasket['emotions']>['primary'][] = [];
    if (!Array.isArray(source.emotions.secondary)) issues.push('invalid-secondary-emotions');
    else for (const raw of source.emotions.secondary) {
      const parsed = emotion(raw);
      if (!parsed) issues.push('invalid-secondary-emotion');
      else if (secondary.length) issues.push('excess-secondary-emotion');
      else secondary.push(parsed);
    }
    affect.emotions = { primary: emotion(source.emotions.primary)!, secondary }; accepted++;
  }
  issues.push(...Object.keys(source).filter(key => !Object.hasOwn(affect, key)).map(() => 'extra-affect-field'));
  return { valid: accepted > 0, affect, issues };
}

export function formatPreviousAffect(state: JunluoAffectStateV1) {
  const lines: string[] = [];
  const dates: number[] = [];
  const emotions = [state.emotions.primary, ...state.emotions.secondary.slice(0, 1)].filter(entry => entry !== null);
  if (emotions.length) { lines.push(`情绪：${emotions.map(entry => emotionDetail(entry, true)).join('、')}`); dates.push(...emotions.map(entry => entry.occurredAt)); }
  if (state.lifeState) {
    const labels = { calm: '平常', tired: '疲惫', sleepy: '困倦', asleep: '睡着' };
    lines.push(`身体或认知状态：${labels[state.lifeState.stateId]}`); dates.push(state.lifeState.occurredAt);
  }
  if (state.relationshipFeeling.lastOperation) { lines.push(`关系感受：${relationshipFeelingLabel(state.relationshipFeeling.value)}`); dates.push(state.relationshipFeeling.updatedAt); }
  if (state.relationshipChoice.lastOperation) { lines.push(`关系选择：${relationshipChoiceLabel(state)}`); dates.push(state.relationshipChoice.updatedAt); }
  if (state.strain.lastOperation) { lines.push(`心里的状态：${strainLabel(state.strain.value)}`); dates.push(state.strain.updatedAt); }
  return lines.length ? `【I 上次记下的感受】\n\n最近更新：${formatChatAfterglowMessageTime(Math.max(...dates))}\n${lines.join('\n')}` : '';
}

export function formatPreviousAffectForChat(state: JunluoAffectStateV1 | null, now = Date.now()) {
  if (!state || !Number.isFinite(now) || now <= 0) return '';
  const entries = [
    { label: '主情绪', entry: state.emotions.primary },
    { label: '辅助情绪', entry: state.emotions.secondary[0] },
  ];
  const parts = entries.flatMap(({ label, entry }) => entry && Number.isFinite(entry.occurredAt)
    && entry.occurredAt > 0 && entry.occurredAt <= now ? [
      `${label}：${emotionDetail(entry, true)}\n记录时间：${formatChatAfterglowMessageTime(entry.occurredAt)}${
        typeof entry.reason === 'string' && entry.reason.trim() ? `\n当时记下的缘由：${entry.reason}` : ''}`,
    ] : []);
  return parts.length ? `【I 上次记下的感受】\n\n${parts.join('\n\n')}\n\n${CONTACT_AFFECT_AFTER_CHAT}` : '';
}
