export type ModelPurposeStage = 'stage1' | 'stage2' | 'stage3' | 'future';

export type ModelPurposeId =
  | 'chat'
  | 'vision'
  | 'audioUnderstanding'
  | 'utilityJson'
  | 'memoryOrganizer'
  | 'memoryReranker'
  | 'imageGeneration'
  | 'financeReasoning'
  | 'lifeCreative'
  | 'asr';

export type ModelPurposeDefinition = {
  id: ModelPurposeId;
  label: string;
  stage: ModelPurposeStage;
  description: string;
  selectableInSettings: boolean;
  requiresDedicatedCapability: boolean;
  followsChatByDefault: boolean;
  status: 'implemented' | 'planned' | 'deferred';
};

export const modelPurposeDefinitions: readonly ModelPurposeDefinition[] = [
  {
    id: 'chat',
    label: '聊天模型',
    stage: 'stage1',
    description: '日常陪伴聊天，负责白云小姐主力人格和关系连续性。',
    selectableInSettings: true,
    requiresDedicatedCapability: false,
    followsChatByDefault: false,
    status: 'implemented',
  },
  {
    id: 'vision',
    label: '看图模型',
    stage: 'stage1',
    description: '独立理解图片、截图与摄像头单帧，不回退到聊天模型。',
    selectableInSettings: true,
    requiresDedicatedCapability: true,
    followsChatByDefault: false,
    status: 'implemented',
  },
  {
    id: 'audioUnderstanding',
    label: '声音／音乐理解',
    stage: 'stage3',
    description: '用于声音与音乐理解的独立连接。',
    selectableInSettings: true,
    requiresDedicatedCapability: true,
    followsChatByDefault: false,
    status: 'implemented',
  },
  {
    id: 'utilityJson',
    label: '小任务模型',
    stage: 'stage2',
    description: '处理分类、提取、JSON、日程解析、账单解析等工具型任务。',
    selectableInSettings: false,
    requiresDedicatedCapability: false,
    followsChatByDefault: true,
    status: 'planned',
  },
  {
    id: 'memoryOrganizer',
    label: '记忆整理模型',
    stage: 'stage2',
    description: '把聊天和生活材料整理成候选记忆、阶段记忆和反思材料。',
    selectableInSettings: true,
    requiresDedicatedCapability: false,
    followsChatByDefault: true,
    status: 'implemented',
  },
  {
    id: 'memoryReranker',
    label: '记忆重排模型',
    stage: 'stage2',
    description: '从候选记忆中挑选当前最相关的内容，不负责新建记忆。',
    selectableInSettings: true,
    requiresDedicatedCapability: false,
    followsChatByDefault: true,
    status: 'implemented',
  },
  {
    id: 'imageGeneration',
    label: '生图模型',
    stage: 'stage3',
    description: '生成图片、礼物、头像、背景和视觉素材，未来应走专用图片生成接口。',
    selectableInSettings: false,
    requiresDedicatedCapability: true,
    followsChatByDefault: false,
    status: 'planned',
  },
  {
    id: 'financeReasoning',
    label: '财务分析模型',
    stage: 'stage3',
    description: '基于真实基金、行情和持仓数据做解释与风险提示，不充当行情来源。',
    selectableInSettings: false,
    requiresDedicatedCapability: false,
    followsChatByDefault: true,
    status: 'planned',
  },
  {
    id: 'lifeCreative',
    label: '生活创作模型',
    stage: 'stage3',
    description: '生成白云日记、梦、主动消息、小作文和生活片段等氛围内容。',
    selectableInSettings: true,
    requiresDedicatedCapability: false,
    followsChatByDefault: true,
    status: 'implemented',
  },
  {
    id: 'asr',
    label: '语音转文字模型',
    stage: 'future',
    description: '未来可选的录音转文字槽位；近期优先使用系统键盘或输入法语音输入。',
    selectableInSettings: false,
    requiresDedicatedCapability: true,
    followsChatByDefault: false,
    status: 'deferred',
  },
] as const;

export const modelPurposeIds = modelPurposeDefinitions.map((purpose) => purpose.id);

export const modelPurposeDefinitionById = Object.fromEntries(
  modelPurposeDefinitions.map((purpose) => [purpose.id, purpose]),
) as Record<ModelPurposeId, ModelPurposeDefinition>;

export function getModelPurposeDefinition(id: ModelPurposeId) {
  return modelPurposeDefinitionById[id];
}

export function canPurposeFallbackToChat(id: ModelPurposeId) {
  return modelPurposeDefinitionById[id].followsChatByDefault;
}

export function doesPurposeRequireDedicatedCapability(id: ModelPurposeId) {
  return modelPurposeDefinitionById[id].requiresDedicatedCapability;
}
