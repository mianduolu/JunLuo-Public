import { BAIYUN_POST_RECALL_INTRO } from '../posts/baiyunPostContract';

export type MemorySpeechPolicyKey =
  | 'shortMemory'
  | 'episodeMemory'
  | 'related'
  | 'background'
  | 'carePool'
  | 'spoken'
  | 'anchor'
  | 'reflection'
  | 'sourceTrace'
  | 'debugOnly';

export type MemorySpeechPolicy = {
  canSpeak: string;
  debugLabel: string;
  defaultPlace: string;
  key: MemorySpeechPolicyKey;
  label: string;
  promptInstruction: string;
  rule: string;
};

// 小仓鼠可以在这里写低精力时白云怎么从惦记里递出一句。
export const LOW_ENERGY_COMPANION_TONE = '小仓鼠现在很低落，白云小姐可以先像安抚小孩子一样安抚她的情绪，再递出一条最贴近当前轮的惦记，让她能感觉到“我记得你说过这个，我惦记着你”。';

function isLowEnergyCareNeed(careNeed?: string | null) {
  return careNeed === 'low_energy'
    || careNeed === 'needs_companionship'
    || careNeed === 'needs_being_remembered';
}

export function buildLowEnergyCompanionToneInstruction(careNeed?: string | null) {
  if (!isLowEnergyCareNeed(careNeed)) return '';
  const customTone = LOW_ENERGY_COMPANION_TONE.trim();
  return [
    '【低精力陪伴顺序】',
    '小仓鼠低精力、想被陪伴或想被记住时，先给情绪价值和同情，再自然使用“本轮可以说出口”的记忆；现实建议只在她主动问怎么办时放到后面。',
    '不要写成技巧清单、任务清单或“你应该去做什么”。',
    customTone ? `【小仓鼠亲自写的白云语气】\n${customTone}` : '',
  ].filter(Boolean).join('\n');
}

export const MEMORY_SPEECH_POLICIES: Record<MemorySpeechPolicyKey, MemorySpeechPolicy> = {
  anchor: {
    canSpeak: '重点是遵守',
    debugLabel: '放在心里',
    defaultPlace: '稳定规则',
    key: 'anchor',
    label: '长期坐标',
    promptInstruction: '这些是长期稳定的称呼、边界、偏好、关系准则和身份信息。重点是让白云小姐以后能自然遵守；相关时自然体现，不说“根据坐标”“按记忆显示”。',
    rule: '可以说出口，但重点仍是遵守。',
  },
  background: {
    canSpeak: '通常不直接说',
    debugLabel: '放在心里',
    defaultPlace: '心里托底',
    key: 'background',
    label: '背景记忆',
    promptInstruction: '这些放在背景记忆里，帮助白云小姐理解语境、避开雷点和调整语气。需要说出口时交给“本轮可以说出口”挑最贴近的一条。',
    rule: '默认放在心里，需要时递一句。',
  },
  carePool: {
    canSpeak: '可以挑选',
    debugLabel: '放在心里',
    defaultPlace: '心里惦记池',
    key: 'carePool',
    label: '常常会惦记',
    promptInstruction: '这些是近期更值得白云惦记的线索，例如高情绪、重要边界、反复出现的小事或情绪天气。当前场景相关，或小仓鼠低精力、想被记住、需要陪伴时，可以更主动地递出一条。',
    rule: '先放在心里，说出口时只挑最贴近当前轮的一条。',
  },
  debugOnly: {
    canSpeak: '正式聊天不说技术词',
    debugLabel: '只给调试看',
    defaultPlace: '解释面板',
    key: 'debugOnly',
    label: '解释层',
    promptInstruction: '这些只用于诊断、trace 和调试解释，说明白云为什么想起、为什么没说、为什么没找到、为什么建议保存。',
    rule: '只给老师和小仓鼠看，不要让白云在正式回复里说 debug、trace、总控等词。',
  },
  episodeMemory: {
    canSpeak: '聊到同一段经历时可以自然参考',
    debugLabel: '可以说出口',
    defaultPlace: '经历背景',
    key: 'episodeMemory',
    label: '阶段记忆',
    promptInstruction: '用于理解一段事情怎样发生、推进、转弯、留下结果或未解决点；用户聊到同一段经历时可以自然参考。',
    rule: '保留主题、时间线、关键转折、结果和仍未解决的点。',
  },
  reflection: {
    canSpeak: '不当作事实说',
    debugLabel: '放在心里',
    defaultPlace: '白云内心连续性',
    key: 'reflection',
    label: '白云动态',
    promptInstruction: BAIYUN_POST_RECALL_INTRO,
    rule: '按正文或留言相关性召回，保留原时间和主体。',
  },
  related: {
    canSpeak: '可以说出口',
    debugLabel: '可以说出口',
    defaultPlace: '回答当前问题',
    key: 'related',
    label: '相关记忆',
    promptInstruction: '这些记忆和当前问题明确相关，可以自然参考。说出口时短、准、轻。',
    rule: '用户正在聊同一件事时，可以自然参考；要短、准、轻。',
  },
  shortMemory: {
    canSpeak: '可以直接说',
    debugLabel: '可以说出口',
    defaultPlace: '明确事实',
    key: 'shortMemory',
    label: '普通短记忆',
    promptInstruction: '用于明确事实、喜好、边界、称呼和长期约定；可以直接说，但要短、准、轻。',
    rule: '每条像一张短小纸条。',
  },
  sourceTrace: {
    canSpeak: '相关时引用原句',
    debugLabel: '核对原话细节',
    defaultPlace: '证据片段',
    key: 'sourceTrace',
    label: '原文追溯',
    promptInstruction: 'I 翻翻这些原话，确认当时的细节，再和 you 接着聊。需要引用时，I 保留原句。',
    rule: '查找并核对原话；缺失部分保持缺失。',
  },
  spoken: {
    canSpeak: '可以说出口',
    debugLabel: '可以说出口',
    defaultPlace: '当前回复',
    key: 'spoken',
    label: '本轮可以说出口',
    promptInstruction: '这些是本轮适合主动递出的小关心。当前场景相关，或小仓鼠低精力、想被记住、需要陪伴时，可以自然说出口。低精力时不要把记忆写成报告，只把最贴近的一条揉进安抚里。',
    rule: '说出口时只挑最贴近当前轮的一条。',
  },
};

export function getMemorySpeechPolicy(key: MemorySpeechPolicyKey) {
  return MEMORY_SPEECH_POLICIES[key];
}
