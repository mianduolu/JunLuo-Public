import type { ModelPurposeId } from './modelPurposeRegistry';

export type ModelCallCurrentSource =
  | 'chatConnection'
  | 'visionConnection'
  | 'audioUnderstandingConnection'
  | 'utilityJsonConnection'
  | 'financeReasoningConnection'
  | 'lifeCreativeConnection'
  | 'memoryOrganizerConnection'
  | 'memoryRerankerConnection'
  | 'embedding'
  | 'none';

export type ModelCallInventoryItem = {
  id: string;
  label: string;
  currentSource: ModelCallCurrentSource;
  currentPurpose: string;
  futurePurpose: ModelPurposeId | 'embedding';
  files: readonly string[];
  migrationChapter: string;
  note: string;
};

export const modelCallInventory: readonly ModelCallInventoryItem[] = [
  {
    id: 'gift-creation', label: '私下准备与赠送礼物', currentSource: 'lifeCreativeConnection',
    currentPurpose: '在既有生活机会里选择是否准备礼物，原生工具保存真实作品或安排送出。',
    futurePurpose: 'lifeCreative', files: ['app/src/gifts/giftCreativeRuntime.ts', 'app/src/gifts/giftCreativeModel.ts', 'app/src/ai/giftCreationRequest.ts'],
    migrationChapter: '礼物柜第 7 章', note: '第七章全文逐字通过；同一准备机会独立预算、保密草稿和实际回执，不新增轮询。',
  },
  {
    id: 'gift-reception', label: '礼物自主接收', currentSource: 'chatConnection',
    currentPurpose: '只根据包装、现役人格与关系决定打开、稍后或拒收；实际提供封面时由所选看图连接完成同次选择。',
    futurePurpose: 'chat', files: ['app/src/gifts/giftReceptionDecision.ts', 'app/src/gifts/giftReceptionRuntime.ts'],
    migrationChapter: '礼物柜第 5 章', note: '正文已逐字审核；清醒、自动开关、预算及在线认领沿现役手机执行链。',
  },
  {
    id: 'gift-original-audio',
    label: '礼物原音理解与首次表达',
    currentSource: 'audioUnderstandingConnection',
    currentPurpose: '原录音与现役人格、关系和本机相关记忆在同一请求中形成表达。',
    futurePurpose: 'audioUnderstanding',
    files: ['app/src/gifts/giftUnderstanding.ts', 'app/src/ai/giftOriginalUnderstandingRequest.ts'],
    migrationChapter: '礼物柜第 4 章',
    note: '独立选择兼容原音输入的连接，不回退聊天或转写；第5章接自主打开后的调用，第6章接回音保存。',
  },
  {
    id: 'gift-original-image',
    label: '礼物原图理解与首次表达',
    currentSource: 'visionConnection',
    currentPurpose: '复用现役看图连接读取单件原图并形成表达。',
    futurePurpose: 'vision',
    files: ['app/src/gifts/giftUnderstanding.ts', 'app/src/ai/giftOriginalUnderstandingRequest.ts'],
    migrationChapter: '礼物柜第 4 章',
    note: '保留组合内的真实位置与本次处理范围，不读取未拆原件。',
  },
  {
    id: 'chat-main-reply',
    label: '主聊天回复',
    currentSource: 'chatConnection',
    currentPurpose: '日常聊天、工具调用、白云主力人格回复。',
    futurePurpose: 'chat',
    files: ['app/src/ai/openAiCompatibleProvider.ts', 'app/src/screens/ChatScreen.tsx'],
    migrationChapter: '第 3 章',
    note: '继续作为聊天模型主槽位；第 3 章只会围绕聊天、看图、写作补槽，不替换主聊天行为。',
  },
  {
    id: 'chat-quality-repair',
    label: '主聊天质量修复',
    currentSource: 'chatConnection',
    currentPurpose: '在主回复需要强制修正时复用聊天模型。',
    futurePurpose: 'chat',
    files: ['app/src/ai/openAiCompatibleProvider.ts', 'app/src/screens/ChatScreen.tsx'],
    migrationChapter: '第 3 章',
    note: '属于白云人格稳定性链路，近期继续跟随聊天模型。',
  },
  {
    id: 'context-compression',
    label: '聊天上下文压缩',
    currentSource: 'memoryOrganizerConnection',
    currentPurpose: '优先使用记忆整理连接压缩上下文，缺失时回退聊天模型。',
    futurePurpose: 'memoryOrganizer',
    files: ['app/src/chat/contextCompression.ts', 'app/src/screens/ChatScreen.tsx'],
    migrationChapter: '第 7 章',
    note: '第 7 章已纳入记忆模型分工：上下文压缩属于整理模型职责，缺失时仍可按现有逻辑回退聊天模型。',
  },
  {
    id: 'memory-organizer',
    label: '记忆整理与反思生成',
    currentSource: 'memoryOrganizerConnection',
    currentPurpose: '提取候选记忆、阶段记忆、反思、行动建议、导入历史整理等。',
    futurePurpose: 'memoryOrganizer',
    files: ['app/src/memory/memoryOrganizer.ts', 'app/src/memory/useChatMemoryController.ts', 'app/src/screens/MemoryScreen.tsx'],
    migrationChapter: '第 7 章',
    note: '第 7 章已明确为记忆整理模型职责：新建/整理/导入/反思/行动候选，不负责召回重排和 embedding。',
  },
  {
    id: 'memory-reranker',
    label: '记忆重排',
    currentSource: 'memoryRerankerConnection',
    currentPurpose: '从召回候选里挑选当前最相关的记忆。',
    futurePurpose: 'memoryReranker',
    files: ['app/src/memory/memoryReranker.ts', 'app/src/memory/memoryStore.ts'],
    migrationChapter: '第 7 章',
    note: '第 7 章已明确为记忆重排模型职责：只从候选记忆中挑 ID，可关闭，失败时回退本地排序；第 12 章已为 Ollama 本地模型关闭推理输出，避免思考过程挤占严格 JSON。',
  },
  {
    id: 'memory-embedding',
    label: '记忆语义向量',
    currentSource: 'embedding',
    currentPurpose: '用专用 embedding 接口生成和检索记忆向量。',
    futurePurpose: 'embedding',
    files: ['app/src/memory/memoryEmbedding.ts'],
    migrationChapter: '第 7 章',
    note: '第 7 章已明确为专用 embeddings 接口：只生成向量，不生成自然语言，不并入 chat completions 槽位。',
  },
  {
    id: 'schedule-planner',
    label: '日程与待办解析',
    currentSource: 'utilityJsonConnection',
    currentPurpose: '待办拆分、任务分类、目标提取和提醒回应分类已走小任务模型；日程生成、周复盘和提醒补充文案仍按后续章节治理。',
    futurePurpose: 'utilityJson',
    files: ['app/src/schedule/schedulePlanner.ts', 'app/src/schedule/scheduleReminderGenerator.ts', 'app/src/screens/ChatScreen.tsx'],
    migrationChapter: '第 6 章',
    note: '第 6 章已迁移 ChatScreen 中第一批 JSON/分类/提取调用；未配置小任务模型时仍回退聊天模型。第 12 章已支持 Ollama 本地连接，并验证 Qwen3.5 9B 可返回严格 JSON。',
  },
  {
    id: 'expense-wallet',
    label: '账单与小金库解析',
    currentSource: 'financeReasoningConnection',
    currentPurpose: '聊天账单由原普通回复理解并提出卡片，不再追加独立记账提取请求；小金库决定卡解释仍使用原财务分析模型。',
    futurePurpose: 'financeReasoning',
    files: ['app/src/expense/walletDecisionGenerator.ts', 'app/src/expense/walletFundDecisionPipeline.ts'],
    migrationChapter: '第 10 章',
    note: '2026-10-02记账候选退役独立提取请求；第10章基金/小金库决定卡解释及真实数据源、风险规则保持原样。',
  },
  {
    id: 'period-companion',
    label: '经期陪伴与提醒',
    currentSource: 'lifeCreativeConnection',
    currentPurpose: '经期陪伴文案、周期记忆和提醒话术优先使用生活创作模型；未选择专用连接时跟随聊天模型。',
    futurePurpose: 'lifeCreative',
    files: ['app/src/period/periodCycleMemory.ts'],
    migrationChapter: '第 11 章',
    note: '第 11 章已迁移模型选择，不改变身体记录、提醒规则和本地兜底。',
  },
  {
    id: 'focus-companion',
    label: '专注陪伴',
    currentSource: 'lifeCreativeConnection',
    currentPurpose: '专注开始、回应、完成记录和邀请文案优先使用生活创作模型；未选择时跟随聊天模型。',
    futurePurpose: 'lifeCreative',
    files: ['app/src/focus/focusCompanion.ts', 'app/src/screens/FocusScreen.tsx'],
    migrationChapter: '第 11 章',
    note: '第 11 章已迁移模型选择，不改变专注计时、状态和记录逻辑。',
  },
  {
    id: 'proactive-messages',
    label: '主动消息',
    currentSource: 'lifeCreativeConnection',
    currentPurpose: '统一主动联系（想念、生活分享、碎碎念与身体关心）使用同一机会；手机活动及吃醋反应沿用各自入口。',
    futurePurpose: 'lifeCreative',
    files: ['app/src/proactive/unifiedContactDispatch.ts', 'app/src/proactive/proactiveMessages.ts', 'app/src/proactive/phoneActivityRules.ts'],
    migrationChapter: '第 11 章',
    note: '统一主动每天最多十二次机会；工具往返与一次五分钟补试分别记真实请求，不按气泡计费。抓鼠、自主来电和明确约定仍独立。',
  },
  {
    id: 'assistant-life',
    label: '白云生活状态、梦与爱意总结',
    currentSource: 'lifeCreativeConnection',
    currentPurpose: '白云状态、生活片段和梦优先使用生活创作模型；未选择时跟随聊天模型。',
    futurePurpose: 'lifeCreative',
    files: ['app/src/ai/assistantLife.ts', 'app/src/life/dreamEngine.ts'],
    migrationChapter: '第 11 章',
    note: '第 11 章已迁移前后台入口，继续保留来源标记、关系连续性、事实边界和现有生成兜底。',
  },
  {
    id: 'reading-ai',
    label: '阅读陪伴',
    currentSource: 'chatConnection',
    currentPurpose: '生成读书相关解释、陪读回应和书架上下文回复。',
    futurePurpose: 'chat',
    files: ['app/src/reading/readingAi.ts', 'app/src/reading/hooks/useReadingAiActions.ts'],
    migrationChapter: '第 3 章',
    note: '继续跟随聊天模型；独立写作模型用途已退场。',
  },
  {
    id: 'web-social-agent',
    label: '网页与社交草稿',
    currentSource: 'lifeCreativeConnection',
    currentPurpose: '网页远游搜索念头和社交草稿优先使用生活创作模型；真实材料与发布授权仍由原系统控制。',
    futurePurpose: 'lifeCreative',
    files: ['app/src/life/webVoyage.ts', 'app/src/life/webVoyageDecision.ts', 'app/src/life/socialAgent.ts'],
    migrationChapter: '第 11 章',
    note: '第 11 章已迁移模型选择，不扩大社交平台读取、草稿或发布权限。',
  },
  {
    id: 'phone-usage-comment',
    label: '手机使用点评',
    currentSource: 'lifeCreativeConnection',
    currentPurpose: '根据真实手机使用汇总生成短点评，优先使用生活创作模型。',
    futurePurpose: 'lifeCreative',
    files: ['app/src/screens/AiSettingsScreen.tsx'],
    migrationChapter: '第 11 章',
    note: '第 11 章已完成分流；无可用模型时保留现有本地点评。',
  },
  {
    id: 'vision-input',
    label: '图片理解',
    currentSource: 'visionConnection',
    currentPurpose: '摄像头单帧与设置页选图测试使用严格结构化视觉链；聊天发图与媒体工具继续使用既有自由文本视觉链。',
    futurePurpose: 'vision',
    files: ['app/src/camera/cameraVisionStructured.ts', 'app/src/camera/cameraManualActionsRuntime.ts', 'app/src/screens/AiSettingsScreen.tsx'],
    migrationChapter: '摄像头第 10 章',
    note: 'vision 是独立用途，不回退聊天模型；本章结构化结果只在当前页面临时展示，不形成观察记录或白云回应。',
  },
  {
    id: 'image-generation',
    label: '图片生成',
    currentSource: 'none',
    currentPurpose: '当前未接入生图模型。',
    futurePurpose: 'imageGeneration',
    files: ['app/src/ai/imageGenerationBoundary.ts', 'app/src/ai/AiConfigPreferences.tsx', 'app/src/screens/AiSettingsScreen.tsx'],
    migrationChapter: '第 9 章',
    note: '第 9 章只完成生图槽位和结果元数据边界预留；仍未接入真实生图 API，也不会回退聊天模型假装生图。',
  },
  {
    id: 'asr',
    label: '语音转文字',
    currentSource: 'none',
    currentPurpose: '当前不自建 ASR，优先使用系统键盘或输入法语音输入。',
    futurePurpose: 'asr',
    files: [],
    migrationChapter: '未来可选',
    note: '继续暂缓，不进入近期迁移范围。',
  },
];
