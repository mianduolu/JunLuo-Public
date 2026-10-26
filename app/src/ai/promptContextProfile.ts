export type PromptContextProfile =
  | 'chat-full'
  | 'chat-fast'
  | 'voice-call'
  | 'sensitive-repair'
  | 'proactive-lite'
  | 'phone-activity'
  | 'schedule-reminder'
  | 'schedule-planner'
  | 'memory-organizer'
  | 'letter'
  | 'assistant-life'
  | 'assistant-state'
  | 'period-care'
  | 'focus-companion'
  | 'tool-task';

export type PromptOutputAudience =
  | 'private_visible_text'
  | 'private_visible_voice'
  | 'public_visible_text'
  | 'internal_structured';

export type PromptContextProfileConfig = {
  allowDesire: boolean;
  allowMemory: boolean;
  allowPhoneActivity: boolean;
  allowSchedule: boolean;
  allowTools: boolean;
  description: string;
  outputShape: 'text' | 'message' | 'messages' | 'json';
  sectionPolicy: PromptContextSectionPolicy;
};

export type PromptPersonaDetail = 'full' | 'companion' | 'identity';

export type PromptContextSectionPolicy = {
  includeAutonomyLayer: boolean;
  includeExpression: boolean;
  includePersonaState: boolean;
  includeRelationshipContext: boolean;
  includeUserProfile: boolean;
  personaDetail: PromptPersonaDetail;
};

const FULL_RELATIONSHIP_SECTIONS: PromptContextSectionPolicy = {
  includeAutonomyLayer: true,
  includeExpression: true,
  includePersonaState: false,
  includeRelationshipContext: true,
  includeUserProfile: true,
  personaDetail: 'full',
};

const PRIVATE_VISIBLE_COMPANION_SECTIONS: PromptContextSectionPolicy = {
  includeAutonomyLayer: true,
  includeExpression: true,
  includePersonaState: false,
  includeRelationshipContext: true,
  includeUserProfile: true,
  personaDetail: 'companion',
};

const LIGHT_COMPANION_SECTIONS: PromptContextSectionPolicy = PRIVATE_VISIBLE_COMPANION_SECTIONS;

const BACKGROUND_TASK_SECTIONS: PromptContextSectionPolicy = {
  includeAutonomyLayer: false,
  includeExpression: false,
  includePersonaState: false,
  includeRelationshipContext: false,
  includeUserProfile: false,
  personaDetail: 'identity',
};

const ASSISTANT_STATE_SECTIONS: PromptContextSectionPolicy = {
  ...FULL_RELATIONSHIP_SECTIONS,
  includePersonaState: false,
};

export const PROMPT_CONTEXT_PROFILES: Record<PromptContextProfile, PromptContextProfileConfig> = {
  'assistant-state': {
    allowDesire: false,
    allowMemory: false,
    allowPhoneActivity: false,
    allowSchedule: false,
    allowTools: false,
    description: '首页状态与对话余韵的完整白云前缀。',
    outputShape: 'json',
    sectionPolicy: ASSISTANT_STATE_SECTIONS,
  },
  'assistant-life': {
    allowDesire: true,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: false,
    allowTools: false,
    description: '白云自己的状态、日记、梦和内部生活材料。',
    outputShape: 'json',
    sectionPolicy: BACKGROUND_TASK_SECTIONS,
  },
  'chat-fast': {
    allowDesire: true,
    allowMemory: false,
    allowPhoneActivity: false,
    allowSchedule: false,
    allowTools: true,
    description: '轻量聊天或快速接话，少取长期材料。',
    outputShape: 'text',
    sectionPolicy: {
      ...LIGHT_COMPANION_SECTIONS,
      includeExpression: true,
      includePersonaState: false,
    },
  },
  'chat-full': {
    allowDesire: true,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: true,
    allowTools: true,
    description: '普通聊天主链路，可以使用完整关系和必要上下文。',
    outputShape: 'messages',
    sectionPolicy: {
      ...FULL_RELATIONSHIP_SECTIONS,
      includePersonaState: false,
    },
  },
  'voice-call': {
    allowDesire: true,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: true,
    allowTools: false,
    description: '实时语音通话里的短口语回复。',
    outputShape: 'text',
    sectionPolicy: {
      ...FULL_RELATIONSHIP_SECTIONS,
      includeExpression: false,
    },
  },
  'focus-companion': {
    allowDesire: false,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: false,
    allowTools: false,
    description: '专注陪伴短日志和短回复。',
    outputShape: 'text',
    sectionPolicy: LIGHT_COMPANION_SECTIONS,
  },
  letter: {
    allowDesire: true,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: true,
    allowTools: false,
    description: '信件、短笺和允许较长表达的异步内容。',
    outputShape: 'json',
    sectionPolicy: FULL_RELATIONSHIP_SECTIONS,
  },
  'memory-organizer': {
    allowDesire: false,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: true,
    allowTools: false,
    description: '后台记忆整理、召回、反思和结构化记忆任务。',
    outputShape: 'json',
    sectionPolicy: BACKGROUND_TASK_SECTIONS,
  },
  'period-care': {
    allowDesire: false,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: false,
    allowTools: false,
    description: '经期记录、提醒和照护消息。',
    outputShape: 'messages',
    sectionPolicy: LIGHT_COMPANION_SECTIONS,
  },
  'phone-activity': {
    allowDesire: true,
    allowMemory: true,
    allowPhoneActivity: true,
    allowSchedule: false,
    allowTools: false,
    description: '手机活动触发的主动消息，只围绕当前 App 与触发原因。',
    outputShape: 'messages',
    sectionPolicy: {
      ...LIGHT_COMPANION_SECTIONS,
      includeExpression: true,
      includePersonaState: false,
    },
  },
  'proactive-lite': {
    allowDesire: true,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: true,
    allowTools: false,
    description: '普通主动探头和生活片段分享，材料应轻量。',
    outputShape: 'messages',
    sectionPolicy: {
      ...LIGHT_COMPANION_SECTIONS,
      includeExpression: true,
      includePersonaState: false,
    },
  },
  'schedule-reminder': {
    allowDesire: false,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: true,
    allowTools: false,
    description: '日程提醒、时间块陪伴和计划相关短消息。',
    outputShape: 'messages',
    sectionPolicy: LIGHT_COMPANION_SECTIONS,
  },
  'schedule-planner': {
    allowDesire: false,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: true,
    allowTools: false,
    description: '日程、待办、目标和习惯的结构化解析或计划生成。',
    outputShape: 'json',
    sectionPolicy: BACKGROUND_TASK_SECTIONS,
  },
  'sensitive-repair': {
    allowDesire: true,
    allowMemory: true,
    allowPhoneActivity: false,
    allowSchedule: false,
    allowTools: false,
    description: '回复质量修复、关系受伤或兜底后的谨慎重试。',
    outputShape: 'messages',
    sectionPolicy: {
      ...PRIVATE_VISIBLE_COMPANION_SECTIONS,
      includePersonaState: false,
    },
  },
  'tool-task': {
    allowDesire: false,
    allowMemory: false,
    allowPhoneActivity: false,
    allowSchedule: false,
    allowTools: true,
    description: '工具型结构化任务，例如消费解析、连接测试或外部能力胶水。',
    outputShape: 'json',
    sectionPolicy: BACKGROUND_TASK_SECTIONS,
  },
};

export function getPromptContextProfileConfig(profile: PromptContextProfile) {
  return PROMPT_CONTEXT_PROFILES[profile];
}

export function getEffectivePromptContextSectionPolicy(
  profile: PromptContextProfile,
  promptMode: 'conversation' | 'identityOnly' = 'conversation',
  outputAudience?: PromptOutputAudience,
) {
  if (outputAudience === 'internal_structured') return BACKGROUND_TASK_SECTIONS;
  if (outputAudience === 'public_visible_text') {
    return {
      ...PRIVATE_VISIBLE_COMPANION_SECTIONS,
      includeRelationshipContext: false,
      includeUserProfile: false,
    };
  }
  if (outputAudience === 'private_visible_voice') {
    return {
      ...(PROMPT_CONTEXT_PROFILES[profile].sectionPolicy.personaDetail === 'full'
        ? PROMPT_CONTEXT_PROFILES[profile].sectionPolicy
        : PRIVATE_VISIBLE_COMPANION_SECTIONS),
      includeExpression: false,
    };
  }
  if (outputAudience === 'private_visible_text') {
    if (profile === 'sensitive-repair') {
      return PROMPT_CONTEXT_PROFILES[profile].sectionPolicy;
    }
    return PROMPT_CONTEXT_PROFILES[profile].sectionPolicy.personaDetail === 'full'
      ? PROMPT_CONTEXT_PROFILES[profile].sectionPolicy
      : PRIVATE_VISIBLE_COMPANION_SECTIONS;
  }
  if (promptMode === 'identityOnly') return BACKGROUND_TASK_SECTIONS;
  return PROMPT_CONTEXT_PROFILES[profile].sectionPolicy;
}

export type PromptContextSource =
  | 'chat.main'
  | 'chat.quality-retry'
  | 'voice.call'
  | 'proactive.ordinary'
  | 'proactive.phone-activity'
  | 'proactive.social-share'
  | 'proactive.jealousy-dismissal'
  | 'proactive.web-voyage-share'
  | 'proactive.github-voyage-share'
  | 'proactive.nearby-world'
  | 'reading.companion'
  | 'schedule.reminder'
  | 'schedule.companion'
  | 'schedule.planner'
  | 'social.public-post'
  | 'memory.organizer'
  | 'memory.recall'
  | 'letter.delivery'
  | 'letter.reply'
  | 'assistant-life.state'
  | 'assistant-life.post'
  | 'assistant-life.post-reply'
  | 'assistant-life.daily-summary'
  | 'assistant-life.afterglow'
  | 'assistant-life.dream'
  | 'period.care'
  | 'period.memory'
  | 'focus.companion'
  | 'expense.parser';

export type PromptContextSourcePolicy = {
  contextProfile: PromptContextProfile;
  outputAudience: PromptOutputAudience;
};

export const PROMPT_CONTEXT_SOURCE_POLICIES: Record<PromptContextSource, PromptContextSourcePolicy> = {
  'assistant-life.dream': { contextProfile: 'assistant-life', outputAudience: 'private_visible_text' },
  'assistant-life.daily-summary': { contextProfile: 'assistant-life', outputAudience: 'private_visible_text' },
  'assistant-life.afterglow': { contextProfile: 'assistant-state', outputAudience: 'private_visible_text' },
  'assistant-life.state': { contextProfile: 'assistant-state', outputAudience: 'private_visible_text' },
  'assistant-life.post': { contextProfile: 'assistant-state', outputAudience: 'private_visible_text' },
  'assistant-life.post-reply': { contextProfile: 'assistant-state', outputAudience: 'private_visible_text' },
  'chat.main': { contextProfile: 'chat-full', outputAudience: 'private_visible_text' },
  'chat.quality-retry': { contextProfile: 'sensitive-repair', outputAudience: 'private_visible_text' },
  'voice.call': { contextProfile: 'voice-call', outputAudience: 'private_visible_voice' },
  'expense.parser': { contextProfile: 'tool-task', outputAudience: 'internal_structured' },
  'focus.companion': { contextProfile: 'focus-companion', outputAudience: 'private_visible_text' },
  'letter.delivery': { contextProfile: 'letter', outputAudience: 'private_visible_text' },
  'letter.reply': { contextProfile: 'letter', outputAudience: 'private_visible_text' },
  'memory.organizer': { contextProfile: 'memory-organizer', outputAudience: 'internal_structured' },
  'memory.recall': { contextProfile: 'memory-organizer', outputAudience: 'internal_structured' },
  'period.care': { contextProfile: 'period-care', outputAudience: 'private_visible_text' },
  'period.memory': { contextProfile: 'period-care', outputAudience: 'internal_structured' },
  'proactive.ordinary': { contextProfile: 'proactive-lite', outputAudience: 'private_visible_text' },
  'proactive.github-voyage-share': { contextProfile: 'proactive-lite', outputAudience: 'private_visible_text' },
  'proactive.jealousy-dismissal': { contextProfile: 'proactive-lite', outputAudience: 'private_visible_text' },
  'proactive.nearby-world': { contextProfile: 'proactive-lite', outputAudience: 'private_visible_text' },
  'proactive.phone-activity': { contextProfile: 'phone-activity', outputAudience: 'private_visible_text' },
  'proactive.social-share': { contextProfile: 'proactive-lite', outputAudience: 'private_visible_text' },
  'proactive.web-voyage-share': { contextProfile: 'proactive-lite', outputAudience: 'private_visible_text' },
  'reading.companion': { contextProfile: 'chat-fast', outputAudience: 'private_visible_text' },
  'schedule.companion': { contextProfile: 'schedule-reminder', outputAudience: 'private_visible_text' },
  'schedule.planner': { contextProfile: 'schedule-planner', outputAudience: 'internal_structured' },
  'schedule.reminder': { contextProfile: 'schedule-reminder', outputAudience: 'private_visible_text' },
  'social.public-post': { contextProfile: 'proactive-lite', outputAudience: 'public_visible_text' },
};

export function getPromptContextProfileForSource(source: PromptContextSource) {
  return PROMPT_CONTEXT_SOURCE_POLICIES[source].contextProfile;
}

export function getPromptOutputAudienceForSource(source: PromptContextSource) {
  return PROMPT_CONTEXT_SOURCE_POLICIES[source].outputAudience;
}

export function isPromptContextSource(value: string): value is PromptContextSource {
  return Object.prototype.hasOwnProperty.call(PROMPT_CONTEXT_SOURCE_POLICIES, value);
}
