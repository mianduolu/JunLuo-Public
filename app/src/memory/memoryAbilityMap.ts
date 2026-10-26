import { getMemorySpeechPolicy, type MemorySpeechPolicyKey } from './memorySpeechPolicy';

export type MemoryAbilityAction = 'anchors' | 'heart' | 'star';

export type MemoryAbilityLayer = {
  action?: MemoryAbilityAction;
  actionLabel?: string;
  canSpeak: string;
  guardrail: string;
  id: string;
  owns: string;
  speechPolicyKey: MemorySpeechPolicyKey;
  subtitle: string;
  title: string;
};

export const MEMORY_ABILITY_LAYERS: MemoryAbilityLayer[] = [
  {
    canSpeak: getMemorySpeechPolicy('shortMemory').canSpeak,
    guardrail: getMemorySpeechPolicy('shortMemory').rule,
    id: 'facts',
    owns: '普通短记忆',
    speechPolicyKey: 'shortMemory',
    subtitle: '明确事实、喜好、边界、称呼、长期约定。',
    title: '事实层',
  },
  {
    canSpeak: getMemorySpeechPolicy('episodeMemory').canSpeak,
    guardrail: getMemorySpeechPolicy('episodeMemory').rule,
    id: 'episode',
    owns: '阶段记忆、周脉络',
    speechPolicyKey: 'episodeMemory',
    subtitle: '一段时间发生了什么，事情怎样推进和转弯。',
    title: '经历层',
  },
  {
    action: 'anchors',
    actionLabel: '查看长期坐标',
    canSpeak: getMemorySpeechPolicy('anchor').canSpeak,
    guardrail: getMemorySpeechPolicy('anchor').rule,
    id: 'anchor',
    owns: '长期坐标',
    speechPolicyKey: 'anchor',
    subtitle: '称呼、边界、偏好、关系准则这些稳定地图钉。',
    title: '坐标层',
  },
  {
    canSpeak: getMemorySpeechPolicy('carePool').canSpeak,
    guardrail: getMemorySpeechPolicy('carePool').rule,
    id: 'care',
    owns: '主动浮现、惦记池、本轮主动递出',
    speechPolicyKey: 'carePool',
    subtitle: '白云这轮心里惦记的几张小纸条。',
    title: '惦记层',
  },
  {
    action: 'heart',
    actionLabel: '查看白云动态',
    canSpeak: getMemorySpeechPolicy('reflection').canSpeak,
    guardrail: getMemorySpeechPolicy('reflection').rule,
    id: 'heart',
    owns: '白云动态',
    speechPolicyKey: 'reflection',
    subtitle: '白云发过的动态，以及下面的讨论。',
    title: '动态层',
  },
  {
    canSpeak: getMemorySpeechPolicy('sourceTrace').canSpeak,
    guardrail: getMemorySpeechPolicy('sourceTrace').rule,
    id: 'source',
    owns: 'sourceStartAt/sourceEndAt、原文追溯',
    speechPolicyKey: 'sourceTrace',
    subtitle: '摘要不够时，回到当时对话找书页。',
    title: '证据层',
  },
  {
    action: 'star',
    actionLabel: '打开关系概览',
    canSpeak: getMemorySpeechPolicy('debugOnly').canSpeak,
    guardrail: getMemorySpeechPolicy('debugOnly').rule,
    id: 'debug',
    owns: '召回 trace、记忆体检、关系图谱、星图',
    speechPolicyKey: 'debugOnly',
    subtitle: '看懂为什么想起、没说、没找到、关系哪里可疑。',
    title: '解释层',
  },
];
