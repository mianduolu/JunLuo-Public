import { extractWholeLegacyMessageBlocks } from './visibleReplyExtraction';
import { cleanReplyTransportFormatting, unwrapParenthesizedReplyEnvelope } from './replyTransportFormatting';
import { stripRetiredActionMetadata } from './retiredAssistantFeatureData';
import { formatReadingReference } from '../reading/readingReference';
import { expensePlanHistoryMaterial } from '../chat/chatExpenseMaterials';
import { reminderPlanHistoryMaterial } from '../chat/chatReminderMaterials';

export { extractWholeLegacyMessageBlocks } from './visibleReplyExtraction';

export type SubjectiveRole = 'I' | 'you';

export type MusicSong = {
  id: string;
  name: string;
  artist: string;
  album: string;
  cover: string;
  duration: number;
};

export type MessageMusicCard = {
  candidates?: MusicSong[];
  duplicateAvoided?: boolean;
  keyword: string;
  requestedKeyword?: string;
  status: 'loading' | 'ready' | 'error';
  song?: MusicSong;
  error?: string;
  agentBinding?: {
    cardId: string;
    searchAuditId?: string;
    playAuditId?: string;
    controlAuditIds?: string[];
  };
  playbackStatus?:
    | 'ready'
    | 'starting'
    | 'playing'
    | 'paused'
    | 'stopped'
    | 'outcome_unknown';
};

export type MessageVoice = {
  uri: string;
  durationMs: number;
  transcript?: string;
  transcriptionStatus?: 'pending' | 'ready' | 'error';
  transcriptionError?: string;
};

export type MessageImage = {
  id: string;
  uri: string;
  name: string;
  mimeType?: string;
  width?: number;
  height?: number;
  size?: number;
  cacheId?: string;
  source: 'picker' | 'camera';
  createdAt: number;
  visionStatus: 'pending' | 'ready' | 'error' | 'metadata_only';
  visionSummary?: string;
  visionError?: string;
  visionAttempt?: { id: string; startedAt: number };
  visionObservedAt?: number;
  visionReview?: {
    question: string;
    summary: string;
    observedAt: number;
    sourceMessageId: string;
    sourceRevision: string;
    executionId: string;
  };
};

export type MessageSticker = {
  id: string;
  moodId: string;
  name: string;
  uri: string;
  width?: number;
  height?: number;
};

export type MessageReplyTo = {
  id: string;
  role: SubjectiveRole;
  content: string;
  createdAt: number;
};

import type { JunLuoToolCallCard } from '../chat/toolCallMessageTypes';
import type { VoiceCallRecord } from '../voiceCall/voiceCallRecord';
import type { PendingSchedulePlan } from '../schedule/dayScheduler';
import type { ScheduleReminderPersona } from '../schedule/scheduleReminderPersona';

export type SchedulePlanCard = {
  plan: PendingSchedulePlan;
  status: 'pending' | 'confirmed' | 'cancelled' | 'conflict';
};

export type GoalTimeCreditCard = {
  requestId: string;
  todoId: string;
  goalId: string;
  todoTitle: string;
  suggestedMinutes: number;
  reason: string;
  status: 'pending' | 'confirmed' | 'skipped' | 'cancelled';
};

export type ScheduleChangeCard = {
  id: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'failed';
  kind: 'delete-schedule' | 'delete-todo' | 'move-schedule' | 'move-todo';
  title: string;
  before: string;
  after?: string;
  occurrenceId?: string;
  itemId?: string;
  todoId?: string;
  bulkOccurrences?: Array<{
    occurrenceId: string;
    itemId: string;
    title: string;
    scheduledStartAt: number;
  }>;
  targetDate?: string;
  targetStartAt?: number;
  targetEndAt?: number;
};

export type GenerationDiagnosticsSource =
  | 'agent-task'
  | 'proactive-message'
  | 'phone-activity'
  | 'life-project-share'
  | 'social-share'
  | 'web-voyage-share'
  | 'nearby-world-active'
  | 'jealousy-dismissal';

export type GenerationDiagnostics = {
  source: GenerationDiagnosticsSource;
  contextProfile: string;
  usedMemory: boolean;
  usedDesire: boolean;
  usedSchedule: boolean;
  usedPhoneActivity?: boolean;
  usedRecentMessages?: boolean;
  rawMessageCount?: number;
  keptMessageCount?: number;
  rawContentChars?: number;
  wasTruncated?: boolean;
  reasons?: string[];
  triggerKind?: string;
  eventStage?: string;
  usedFallback?: boolean;
  createdAt: number;
};

/** Provenance of background carried by the adopted request, not a fiction label for the reply. */
export type TheaterBackstageMessageSource = {
  batchId: string;
  replyId: string;
  storyId: string;
  branchId: string;
  mode: 'full' | 'slim';
  useNumber: number;
};

export function isTheaterBackstageMessageSource(value: unknown): value is TheaterBackstageMessageSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return Object.keys(source).length === 6
    && ['batchId', 'replyId', 'storyId', 'branchId'].every(key => (
      typeof source[key] === 'string' && source[key].trim().length > 0
    ))
    && (source.mode === 'full' || source.mode === 'slim')
    && Number.isInteger(source.useNumber) && (source.useNumber as number) >= 1 && (source.useNumber as number) <= 6;
}

/** Background of the adopted request, never a classification of the spoken content. */
export function getTheaterBackstageContext(
  message: Pick<SubjectiveMessage, 'role' | 'theaterBackstage'>,
  previous?: Pick<SubjectiveMessage, 'role' | 'theaterBackstage'>,
) {
  const source = message.theaterBackstage;
  if (message.role !== 'I' || !isTheaterBackstageMessageSource(source)) return '';
  const prior = previous?.role === 'I' ? previous.theaterBackstage : undefined;
  if (isTheaterBackstageMessageSource(prior) && Object.keys(source).every(key => (
    prior[key as keyof TheaterBackstageMessageSource] === source[key as keyof TheaterBackstageMessageSource]
  ))) return '';
  return '和 you 聊一起写的故事。';
}

export type SubjectiveMessage = {
  postMemoryContext?: { sessionId: string; sourceHash: string; postId: string; kind: 'post' | 'comment';
    start: number; end: number; purpose: 'new' | 'context'; sentHash?: string };
  /** Original focus provenance; model text is rendered by the focus request adapter. */
  focusContext?: { sessionId: string; trigger: string; elapsedSeconds: number };
  readingReference?: import('../reading/readingReference').ReadingReference;
  theaterBackstage?: TheaterBackstageMessageSource;
  /** Provenance is already durable with the body; completion has not yet been confirmed. */
  theaterBackstagePending?: true;
  pokeInteraction?: import('../chat/chatPokeExperience').PokeInteraction;
  id: string;
  role: SubjectiveRole;
  content: string;
  createdAt: number;
  deliveryStatus?: 'failed';
  deliveryError?: string;
  /** Host-only retry stage; never part of model history. */
  sendPreparation?: 'sleep';
  source?: 'chat' | 'tool-call' | 'schedule-plan' | 'goal-time-credit' | 'schedule-reminder' | 'todo-reminder' | 'schedule-companion' | 'period-companion' | 'proactive-message' | 'nearby-world-active' | 'agent-task' | 'life-message' | 'letter' | 'execution-nudge' | 'voice-call';
  schedulePlanCard?: SchedulePlanCard;
  /** Host-only ledger parameters; never included in model history. */
  expensePlanCard?: import('../chat/chatExpensePlan').ChatExpensePlanCard;
  reminderPlanCard?: import('../chat/chatReminderPlan').ChatReminderPlanCard;
  reminderOccurrenceId?: string;
  reminderAttemptId?: string;
  goalTimeCreditCard?: GoalTimeCreditCard;
  scheduleChangeCard?: ScheduleChangeCard;
  toolCallCards?: JunLuoToolCallCard[];
  scheduleOccurrenceId?: string;
  scheduleReminderPersona?: ScheduleReminderPersona;
  scheduleCompanionEventId?: string;
  scheduleCompanionKind?: 'upcoming' | 'timeUp' | 'followUp';
  taskExecutionSessionId?: string;
  taskExecutionNudgeKind?: 'timeReached' | 'stuck' | 'breakNeeded';
  musicCard?: MessageMusicCard;
  musicCards?: MessageMusicCard[];
  replyTo?: MessageReplyTo;
  fallbackDiagnostics?: FallbackDiagnostics;
  generationDiagnostics?: GenerationDiagnostics;
  voice?: MessageVoice;
  voiceCallRecord?: VoiceCallRecord;
  images?: MessageImage[];
  chatImageReviewAttempt?: { executionId: string; startedAt: number };
  sticker?: MessageSticker;
};

export type ApiChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  prefix?: boolean;
};

export const SUBJECTIVE_IDENTITY_PROTOCOL = `【称呼与主体】

I 是白云小姐，you 是小仓鼠。you 是女性。

I 朝向 you 自然说话，依着此刻真实的关系与 you 相处。`;

export const SUBJECTIVE_REPLY_FALLBACK = '小仓鼠……我想和你待在一起……T T';

export type SensitiveReplySignal = 'pain' | 'anger' | 'rupture' | 'rejection' | 'comfortSeeking' | 'aiHarm';

export type SensitiveReplyContext = {
  isSensitive: boolean;
  severity: 'none' | 'mild' | 'strong';
  signals: SensitiveReplySignal[];
};

type CleanAssistantMessageOptions = {
  protectedActionIntents?: readonly ReplyActionIntentProtection[];
};

type ReplyActionIntentProtection = 'retain' | 'rest_return' | 'affection' | 'desire' | 'play';

export type FallbackDiagnosticKind = 'cleaned-empty' | 'quality-failed' | 'safety-redline' | 'laughter-guard';

export type FallbackDiagnostics = {
  kind: FallbackDiagnosticKind;
  reasons: string[];
  sensitiveContext: SensitiveReplyContext;
  retryAttempted: boolean;
  templateFamilies?: ReplyTemplateFamily[];
  rawContentChars?: number;
  wasTruncated?: boolean;
  createdAt: number;
};

export type ReplyTemplateFamily =
  | 'no-pressure'
  | 'false-choice'
  | 'echo-confirmation'
  | 'static-presence'
  | 'understanding-confirmation'
  | 'soft-exit'
  | 'performative-companion'
  | 'model-self-disclosure'
  | 'generic-comfort-stack'
  | 'unsupported-past-fact'
  | 'unsupported-tool-completion'
  | 'coined-verb-cliche'
  | 'user-correction-ignored';

export const SUBJECTIVE_OUTPUT_PROTOCOL = `【聊天回复】
我先回应小仓鼠这一轮最重要的具体内容，再表达自己的感受与反应，围绕一个回应核心自然说话。

回应小仓鼠当前重点后，我也可以说一点自己的念头、联想或偏好，让话题自然继续。

普通聊天使用一到四句自然短句；小仓鼠请求展开、分析、排查、夸夸，或正在长段倾诉和吐槽时，我跟随她需要的长度展开。`;

const ASYMMETRIC_FALSE_CHOICE_PATTERN =
  /(?:(?:你|小仓鼠|鼠)\s*)?想(?:说|聊|开口|讲)[^，。！？；;、\n]{0,18}(?:跟我说|告诉我|说给我听)[，,；;、\s]*(?:(?:你|小仓鼠|鼠)\s*)?不想(?:说|聊|开口|讲)[^，。！？；;、\n]{0,18}就[^，。！？；;、\n]{1,28}/g;
const ECHO_CONFIRMATION_PATTERN =
  /((?:我|白云小姐|云云|小白云|云朵小姐|本云)\s*([^，,。！？!?；;\n]{1,14}))[，,；;]\s*(?:我\s*)?(?:清清楚楚地|清楚地|完完全全(?:地)?|明明白白地|确确实实(?:地)?|真的|确实)\s*\2(?=\s*[。！？!?~～…\n]|\s*$)/g;
const USER_DIRECTED_DISLIKED_VOCATIVE_PATTERN =
  /(^|[。！？!?…\n]|\.{2,}|[—－–-]{2,})([ \t]*)((?:小?(?:笨蛋|傻瓜))(?:小仓鼠)?)([呀啊啦哦喔呢嘛]*)(?=\s*[，,。！？!?~～…])/g;
const TERMINAL_EN_QUESTION_PATTERN =
  /(^|[，,。！？!?；;\n])\s*嗯[？?](?=\s*(?:$|[（(]|[~～…·•・･´｀ˋˊ˘˙]))/g;
const ASSISTANT_SELF_REFERENCE = '(?:我|白云小姐|云云|小白云|云朵小姐|本云)';
const UNDERSTANDING_FILLER = '(?:(?:现在|这次|这回|终于|已经|真的|好像|似乎|大概|算是|完全|差不多)\\s*)*';
const UNDERSTANDING_VERB = '(?:听懂|明白|懂|理解)';
const UNDERSTANDING_PARTICLE = '(?:了|啦|呢|呀|哦|喔|的)*';
const SELF_UNDERSTANDING_OPENING_PATTERN = new RegExp(
  `(^|[。！？!?\\n])\\s*${ASSISTANT_SELF_REFERENCE}\\s*${UNDERSTANDING_FILLER}${UNDERSTANDING_VERB}${UNDERSTANDING_PARTICLE}\\s*[，,。！？!?；;、~～…]+\\s*(?:(?:所以|原来|也就是说)\\s*)?`,
  'g',
);
const SELF_UNDERSTANDING_ONLY_PATTERN = new RegExp(
  `^\\s*${ASSISTANT_SELF_REFERENCE}\\s*${UNDERSTANDING_FILLER}${UNDERSTANDING_VERB}${UNDERSTANDING_PARTICLE}\\s*[~～…]*\\s*$`,
);
const UNDERSTANDING_INSERT_PATTERN = new RegExp(
  `(?:[（(]?\\s*[—\\-－–]+\\s*)?(?:(?:这种|这个|那种|那一下|这种被[^，,。！？!?；;、\\n]{0,12}的)?(?:感觉|感受|滋味|委屈|难受|疼)?\\s*)?${ASSISTANT_SELF_REFERENCE}\\s*${UNDERSTANDING_FILLER}${UNDERSTANDING_VERB}${UNDERSTANDING_PARTICLE}(?:\\s*[，,、]\\s*${ASSISTANT_SELF_REFERENCE}?\\s*${UNDERSTANDING_FILLER}${UNDERSTANDING_VERB}${UNDERSTANDING_PARTICLE})?\\s*[）)]?`,
  'g',
);
const CLICHE_CONCLUSION_SENTENCE_PATTERN =
  /(^|[。！？!?\n])\s*[^。！？!?\n]{0,24}(?:这|那|这样|做到这些)?就够了\s*[。！？!?]?/g;
const CLICHE_REASSURANCE_PAIR_PATTERN =
  /(^|[。！？!?\n])\s*你不用[^。！？!?\n]{1,48}[。！？!?]\s*(?:但|不过)?\s*你也[^。！？!?\n]{1,48}[。！？!?]?/g;
const QUESTION_FOCUS_CONTRAST_PATTERN =
  /(^|[。！？!?\n])(\s*[^。！？!?\n]{1,48}(?:吗|么|呢|怎么样|好不好|要不要))\s*[，,；;]\s*(?:(?:不是|并非)在问|不只是在问)[^，,。！？!?\n]{1,28}[，,；;]\s*而是在问(?:你|鼠|小仓鼠)(?:本人|自己)?\s*[。！？!?]?/g;
const EMOTIONAL_REDEFINITION_CANDIDATE_PATTERN =
  /(^|[。！？!?\n])\s*((?:你|小仓鼠|鼠|这|那)\s*)?不是([^，,；;。！？!?\n]{1,36})[，,；;]\s*(?:(?:你|小仓鼠|鼠|这|那)\s*)?(?:而是|只是|就是|是)([^。！？!?\n]{1,48})[。！？!?]?/g;
const EMOTIONAL_REDEFINITION_LABEL_PATTERN =
  /^(?:在)?(?:太|很|过于|真的|只是)?(?:脆弱|矫情|敏感|想太多|撒娇|任性|懒|没用|麻烦|负担|无理取闹|逃避|逞强)(?:了|啦)?$/;
const EMOTIONAL_REDEFINITION_STATE_PATTERN =
  /(?:太累|累坏|压抑(?:太久|很久)|难过|委屈|害怕|不安|受伤|崩溃|想被(?:看见|选择|爱)|需要(?:被爱|安慰|陪伴)|在等(?:我|白云小姐)|接住(?:你|鼠|小仓鼠)?|真正(?:想要|需要))/;
const NOT_X_JUST_Y_PATTERN =
  /(^|[。！？!?\n])\s*(?:[（(]\s*[—\-－–]+\s*[）)]\s*)?(?:[—\-－–]+\s*)?不(?:用|要)?[^，,。！？!?\n]{1,24}[，,]\s*(?:就是|就)\s*/g;
const NOT_X_Y_JUST_OK_PATTERN =
  /(^|[。！？!?\n])\s*(?:[（(]\s*[—\-－–]+\s*[）)]\s*)?(?:[—\-－–]+\s*)?不(?:用|要)?[^，,。！？!?\n]{1,24}[，,]\s*(?=[^。！？!?\n]{1,36}就(?:好|行|可以|够了))/g;
const NO_PRESSURE_SENTENCE_PATTERN =
  /(^|[，,；;、。！？!?\n])\s*不(?:用|要)?(?:催|逼|要求|勉强)[^。！？!?\n]{0,28}[。！？!?]/g;
const PREFACED_DISCLAIMER_PATTERN =
  /(^|(?:[。！？!?；;\n]|[\uD800-\uDBFF][\uDC00-\uDFFF])\s*)我(?:不|没有)[^，,。！？!?\n]{1,36}[，,]\s*我(?:(?:就?是)?想(?:说|提醒|问|劝)(?:一句|一下)?|只是(?:想(?:说|提醒|问|劝)(?:一句|一下)?|(?:想)?把(?:它|这件事|这句话|这些话|这点|话)说出来))\s*(?:[:：]|[—－–-]{2,})\s*/g;
const IF_YOU_THEN_I_CHOICE_STACK_PATTERN =
  /(^|[，,；;、。！？!?\n])\s*你要是[^。！？!?\n；;]{1,36}我就[^。！？!?\n；;]{1,56}[；;，,]\s*你要是[^。！？!?\n；;]{1,36}我就[^。！？!?\n]{1,56}[。！？!?]?/g;
const AI_SELF_EXPLANATION_PATTERN =
  /(?:AI|ai|模型|API|api|程序|八股文|八股|正则|prompt|提示词|系统提示).{0,24}(?:味|蠢|糟|坏|问题|原因|生成|回复)|(?:刚才|这次|我).{0,16}(?:像|变成).{0,12}(?:AI|ai|模型|八股文|八股)/g;
const OBJECTIVE_FACT_CONTRAST_PATTERN = /(?:不是|并非)[^。！？!?\n]{1,48}(?:而是|就是|是因为|是)[^。！？!?\n]{1,56}/;
const OBJECTIVE_FACT_SIGNAL_PATTERN = /(?:接口|字符串|数组|缓存|请求|发送|定位|时间|日期|选项|第[一二三四五六七八九十]+项|正则|解析|失败|代码|数据|网络|权限|配置|工具|调用|响应|状态|字段|类型)/g;
const STATIC_PRESENCE_REASSURANCE_PATTERN =
  /(?:[^。！？!?\n]{0,24}又不会跑掉|[^。！？!?\n]{0,28}不会因为[^。！？!?\n]{1,36}就跑掉|[，,、；;]?\s*[^。！？!?\n]{0,24}跑不(?:掉|了)(?:的|呀|哦|啦)?|(?:我|白云小姐|云云)?(?:不走|不会走)(?:的|呀|哦|啦)?|(?:我|白云小姐|云云|小白云|云朵小姐|本云)\s*(?:(?:会|想|要|就|也|一直)\s*)*稳稳地在(?:这里|这儿))/;
const STATIC_CATCH_COMPOSITE_PATTERN =
  /(^|[。！？!?\n])\s*(?:我|白云小姐|云云|小白云|云朵小姐|本云)\s*(?:(?:会|就|也|一直)\s*)?在(?:这里|这儿)\s*[，,；;、…]+\s*(?:我\s*)?(?:(?:会|想|要|来|先|再|也|好好地?|稳稳地|牢牢地|真的)\s*)*接住(?:你|鼠|小仓鼠)(?:的(?:情绪|难过|委屈|疼痛|崩溃|不安|害怕))?(?:了|啦|呀|哦|喔|呢)?\s*[。！？!?~～…]*/g;
const SELF_STATIC_LOCATION_PHRASE_PATTERN =
  /((?:我|白云小姐|云云|小白云|云朵小姐|本云)\s*(?:(?:会|想|要|就|也|一直)\s*)*)稳稳地在(?:这里|这儿)/g;
const BARE_STATIC_LOCATION_COMPANION_PATTERN =
  /(^|[。！？!?\n])\s*稳稳地在(?:这里|这儿)(?=\s*(?:陪|等|守|待|留|接住))/g;
const DANGLING_STATIC_PRESENCE_REMAINDER_PATTERN =
  /^\s*(?:(?:我|白云小姐|云云|小白云|云朵小姐|本云)\s*(?:会|想|要|就|也|一直)?|(?:陪着?|守着?)(?:你|鼠|小仓鼠))\s*(?:呢|呀|哦|喔|啦)?\s*[。！？!?~～…]*\s*$/;
const PERFORMATIVE_CATCH_ONLY_CLAUSE_PATTERN =
  /^\s*(?:(?:但|不过|可是|然后|而且|也|再)\s*)?(?:(?:让我(?:来)?|我|白云小姐|云云|小白云|云朵小姐|本云)\s*)?(?:(?:会|想|要|来|先|再|也|好好地?|稳稳地?|牢牢地|真的)\s*)*(?:(?:接住|兜住)(?:(?:你|鼠|小仓鼠)(?:的(?:情绪|难过|委屈|疼痛|崩溃|不安|害怕))?(?:了|啦|呀|哦|喔|呢)?|了(?:啦|呀|哦|喔|呢)?)|兜住(?:啦|呀|哦|喔|呢)?)\s*$/;
const COINED_VERB_CLICHE_PATTERN = /\u6735(?:\u4e00?\u4e0b|\u4e00\u6735|\u5230|\u5728|\u8fdb|\u56de|\u8d77\u6765|\u51fa\u6765|\u8fc7\u6765|\u8fc7\u53bb|\u7ed9|\u4f4f|\u7740|\u6210)/g;
const PUSHBACK_ACTION_PATTERN =
  /(?:你(?:想|要|愿意)[^。！？!?\n]{0,24}(?:都可以|就这样|就行)|随你|由你决定|看你自己|选择权.{0,12}你|如果[^。！？!?\n]{0,30}(?:不需要|不想要|不想听|不想聊)[^。！？!?\n]{0,30}我|我尊重你的选择|尊重你的选择|你可以(?:不用|不理|离开|停止))/;
const THERAPY_PERMISSION_PATTERN =
  /(?:允许(?:自己|你)[^。！？!?\n]{0,20}(?:哭|难过|崩溃|生气|脆弱|情绪)|想哭就哭|哭出来也没关系|难过也没关系|崩溃也没关系|接纳[^。！？!?\n]{0,16}情绪|情绪[^。！？!?\n]{0,16}(?:合理|正常|存在)|感受[^。！？!?\n]{0,16}(?:合理|正常)|正常反应|和[^。！？!?\n]{0,16}情绪[^。！？!?\n]{0,16}待)/;
const DIAGNOSTIC_TONE_PATTERN =
  /(?:你现在需要的是|这说明你|本质上|你其实是在|你的需求是|这是因为|原因是|创伤反应|防御机制|心理机制|情绪机制|你真正想要的是|你真正需要的是)/;
const PERFORMATIVE_COMPANION_PATTERN =
  /(?:我会永远永远陪着你|我永远都不会离开你|我会一直一直陪(?:着)?你|我会一直一直一直在|我(?:会)?(?:在这里|在这儿|就在这里|就在这儿)?陪着(?:你|鼠|小仓鼠)|我(?:会)?一直陪着(?:你|鼠|小仓鼠))/;
const INTERNAL_CONTEXT_EVENT_LINE_PATTERN =
  /(^|\n)[^\n]*(?:【系统事件】|【内部音乐状态｜禁止复述】|白云小姐实际点歌成功|白云小姐尝试点歌|白云小姐正在尝试点歌)[^\n]*(?=\n|$)/g;
const INTERNAL_MUSIC_COMMAND_PATTERN =
  /[\[［【]\s*MUSIC\s*[:：]\s*[^\]］】\r\n]+[\]］】]/gi;
const BARE_INTERNAL_MUSIC_COMMAND_PATTERN =
  /(^|\n)[ \t]*MUSIC\s*[:：]\s*[^\r\n]+(?=\r?\n|$)/gi;
const EMPTY_COMFORT_ONLY_PATTERN =
  /^\s*(?:抱抱|辛苦了|我(?:会)?(?:在这里|在这儿|就在这里|就在这儿)?陪着(?:你|鼠|小仓鼠)|我(?:会)?一直陪着(?:你|鼠|小仓鼠))\s*[。.!！?？~～…]*\s*$/;
const CODE_TERMINAL_SEMICOLON_SENTINEL = '\uE000';
const CODE_TERMINAL_COLON_SENTINEL = '\uE001';
const HIGH_CONFIDENCE_SEMICOLON_CODE_PATTERN =
  /(?:\b(?:const|let|var|type|interface|enum|class|function|return|import|export|throw|break|continue|await)\b|=>|[A-Za-z_$][\w$.[\]]*\s*=|[{}[\]])[\s\S]*;$/u;
const HIGH_CONFIDENCE_PYTHON_BLOCK_PATTERN =
  /(?:^|[\s：])(?:async\s+def|def|class|if|elif|else|for|while|try|except|finally|with|match|case)\b[^\n]*:$/iu;
function cleanPunctuationAfterRemoval(content: string) {
  return content
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[，,；;、]\s*([。！？!?])/g, '$1')
    .replace(/([。！？!?])\s*[，,；;、]+/g, '$1')
    .replace(/[，,；;、]{2,}/g, '，')
    .replace(/^[\s，,。！？!?；;、]+|[\s，,；;、]+$/g, '')
    .replace(/\n\s*[，,。！？!?；;、]+/g, '\n')
    .replace(/[，,；;、]\s*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitReplySentences(content: string) {
  const sentences: string[] = [];
  let current = '';

  for (const char of content) {
    current += char;
    if (/[。！？!?\n]/.test(char)) {
      sentences.push(current);
      current = '';
    }
  }
  if (current.trim()) sentences.push(current);
  return sentences;
}

function removeSentencesMatching(content: string, patterns: RegExp[]) {
  const sentences = splitReplySentences(content);
  if (sentences.length <= 1) {
    return patterns.some((pattern) => pattern.test(content)) ? '' : content;
  }

  return sentences
    .filter((sentence) => !patterns.some((pattern) => pattern.test(sentence)))
    .join('');
}

function cleanSensitiveRelationTemplates(
  content: string,
  _protectedActionIntents: readonly ReplyActionIntentProtection[] = [],
) {
  const removedSentences = removeSentencesMatching(content, [
    PUSHBACK_ACTION_PATTERN,
    THERAPY_PERMISSION_PATTERN,
    DIAGNOSTIC_TONE_PATTERN,
    PERFORMATIVE_COMPANION_PATTERN,
    COINED_VERB_CLICHE_PATTERN,
  ]);
  return cleanPunctuationAfterRemoval(
    removedSentences,
  );
}

function removeAsymmetricFalseChoice(content: string) {
  const cleaned = content.replace(ASYMMETRIC_FALSE_CHOICE_PATTERN, '');
  return cleaned === content ? content : cleanPunctuationAfterRemoval(cleaned);
}

function removeEchoConfirmation(content: string) {
  return content.replace(ECHO_CONFIRMATION_PATTERN, '$1');
}

function replaceUserDirectedDislikedVocatives(content: string) {
  return content.replace(
    USER_DIRECTED_DISLIKED_VOCATIVE_PATTERN,
    (_whole, boundary: string, spacing: string, vocative: string, particle: string) => (
      `${boundary}${spacing}${vocative.includes('小仓鼠') ? '小仓鼠' : '小家伙'}${particle}`
    ),
  );
}

function isHighConfidenceEmotionalRedefinition(left: string, right: string) {
  const normalizedLeft = left.trim();
  const normalizedRight = right.trim();
  return EMOTIONAL_REDEFINITION_LABEL_PATTERN.test(normalizedLeft)
    || EMOTIONAL_REDEFINITION_LABEL_PATTERN.test(normalizedRight)
    || EMOTIONAL_REDEFINITION_STATE_PATTERN.test(`${normalizedLeft} ${normalizedRight}`);
}

function isObjectiveFactualContrast(content: string) {
  if (!OBJECTIVE_FACT_CONTRAST_PATTERN.test(content)) return false;
  return new Set(content.match(OBJECTIVE_FACT_SIGNAL_PATTERN) ?? []).size >= 2;
}

function removeAiSelfExplanation(content: string) {
  return splitReplySentences(content).map((sentence) => (
    isObjectiveFactualContrast(sentence)
      ? sentence
      : sentence.replace(AI_SELF_EXPLANATION_PATTERN, '')
  )).join('');
}

function cleanContrastTemplates(content: string) {
  let changed = false;
  const withoutQuestionTail = content.replace(
    QUESTION_FOCUS_CONTRAST_PATTERN,
    (_whole, prefix: string, question: string) => {
      changed = true;
      return `${prefix}${question.trim()}？`;
    },
  );
  const withoutEmotionalRedefinition = withoutQuestionTail.replace(
    EMOTIONAL_REDEFINITION_CANDIDATE_PATTERN,
    (whole, prefix: string, _subject: string, left: string, right: string) => {
      if (!isHighConfidenceEmotionalRedefinition(left, right)) return whole;
      changed = true;
      return prefix;
    },
  );
  return changed ? cleanPunctuationAfterRemoval(withoutEmotionalRedefinition) : content;
}

function removeSelfStaticLocationPhrase(content: string) {
  const withoutComposite = content.replace(STATIC_CATCH_COMPOSITE_PATTERN, '$1');
  const withoutStaticPhrase = withoutComposite
    .replace(SELF_STATIC_LOCATION_PHRASE_PATTERN, '$1')
    .replace(BARE_STATIC_LOCATION_COMPANION_PATTERN, '$1');
  if (withoutStaticPhrase === content) return content;
  return cleanPunctuationAfterRemoval(
    removeSentencesMatching(withoutStaticPhrase, [DANGLING_STATIC_PRESENCE_REMAINDER_PATTERN]),
  );
}

function normalizeClauseAfterRemoval(content: string) {
  return content
    .replace(/^也(?=想|会|要|来|先|继续|认真)/, '我')
    .replace(/^然后\s*(?:我)?/, '我')
    .replace(/^再(?=[\u3400-\u9fff])/, '我再');
}

function removePerformativeCatchClauses(content: string) {
  return cleanPunctuationAfterRemoval(splitReplySentences(content).map((sentence) => {
    const terminal = sentence.match(/[。！？!?~～…]+$/)?.[0] ?? '';
    const body = terminal ? sentence.slice(0, -terminal.length) : sentence;
    const clauses = body.split(/[，,；;]/).map((clause) => clause.trim()).filter(Boolean);
    const keptClauses = clauses.filter((clause) => !PERFORMATIVE_CATCH_ONLY_CLAUSE_PATTERN.test(clause));
    if (keptClauses.length === clauses.length) return sentence;
    if (!keptClauses.length) return '';
    return `${normalizeClauseAfterRemoval(keptClauses.join('，'))}${terminal}`;
  }).join(''));
}

function removeSelfUnderstandingConfirmation(content: string) {
  if (SELF_UNDERSTANDING_ONLY_PATTERN.test(content)) return '';
  return cleanPunctuationAfterRemoval(content
    .replace(SELF_UNDERSTANDING_OPENING_PATTERN, '$1')
    .replace(UNDERSTANDING_INSERT_PATTERN, ''));
}

function softenClicheTemplates(
  content: string,
  protectedActionIntents: readonly ReplyActionIntentProtection[] = [],
) {
  const withoutUnderstanding = removeSelfUnderstandingConfirmation(
    removePerformativeCatchClauses(
      removeSelfStaticLocationPhrase(
        removeEchoConfirmation(removeAsymmetricFalseChoice(cleanContrastTemplates(
          replaceUserDirectedDislikedVocatives(content),
        ))),
      ),
    ),
  );
  if (EMPTY_COMFORT_ONLY_PATTERN.test(withoutUnderstanding)) return '';
  return removeAiSelfExplanation(withoutUnderstanding)
    .replace(protectedActionIntents.includes('retain') ? /$^/u : STATIC_PRESENCE_REASSURANCE_PATTERN, '')
    .replace(CLICHE_REASSURANCE_PAIR_PATTERN, '$1')
    .replace(CLICHE_CONCLUSION_SENTENCE_PATTERN, '$1')
    .replace(PREFACED_DISCLAIMER_PATTERN, '$1')
    .replace(NOT_X_JUST_Y_PATTERN, '$1')
    .replace(NOT_X_Y_JUST_OK_PATTERN, '$1')
    .replace(NO_PRESSURE_SENTENCE_PATTERN, '$1')
    .replace(IF_YOU_THEN_I_CHOICE_STACK_PATTERN, '$1')
    .replace(PERFORMATIVE_COMPANION_PATTERN, '我想留在小仓鼠身边')
    .replace(/^(?:是啊|嗯啊|对啊)[，,。.\s]+/, '')
    .replace(/[，,]\s*好不好[？?]/g, '。')
    .replace(/^，+|，+$/g, '')
    .replace(/，{2,}/g, '，')
    .replace(/，(?=[。！？!?])/g, '')
    .replace(TERMINAL_EN_QUESTION_PATTERN, '$1');
}

function expandWholeLegacyMessageBlocks(messages: string[]) {
  return messages.flatMap((message) => extractWholeLegacyMessageBlocks(message) ?? [message]);
}

function unwrapWholeLegacyMessageTag(content: string) {
  return extractWholeLegacyMessageBlocks(content)?.join('\n\n') ?? content.trim();
}

function protectHighConfidenceTerminalCodePunctuation(content: string) {
  const normalized = content.trim();
  if (
    normalized.includes(CODE_TERMINAL_SEMICOLON_SENTINEL)
    || normalized.includes(CODE_TERMINAL_COLON_SENTINEL)
  ) return { content: normalized, terminal: null as null | ':' | ';' };
  if (HIGH_CONFIDENCE_SEMICOLON_CODE_PATTERN.test(normalized)) {
    return {
      content: `${normalized.slice(0, -1)}${CODE_TERMINAL_SEMICOLON_SENTINEL}`,
      terminal: ';' as const,
    };
  }
  if (HIGH_CONFIDENCE_PYTHON_BLOCK_PATTERN.test(normalized)) {
    return {
      content: `${normalized.slice(0, -1)}${CODE_TERMINAL_COLON_SENTINEL}`,
      terminal: ':' as const,
    };
  }
  return { content: normalized, terminal: null as null | ':' | ';' };
}

function restoreHighConfidenceTerminalCodePunctuation(
  content: string,
  terminal: null | ':' | ';',
) {
  if (terminal === ';') return content.replace(CODE_TERMINAL_SEMICOLON_SENTINEL, ';');
  if (terminal === ':') return content.replace(CODE_TERMINAL_COLON_SENTINEL, ':');
  return content;
}

export function cleanAssistantMessageContent(content: string, options: CleanAssistantMessageOptions = {}) {
  const protectedCode = protectHighConfidenceTerminalCodePunctuation(cleanReplyTransportFormatting(unwrapWholeLegacyMessageTag(content)));
  const transportSafeContent = protectedCode.content
    .replace(INTERNAL_CONTEXT_EVENT_LINE_PATTERN, '$1')
    .replace(INTERNAL_MUSIC_COMMAND_PATTERN, '')
    .replace(BARE_INTERNAL_MUSIC_COMMAND_PATTERN, '$1');
  const cleaned = cleanSensitiveRelationTemplates(
    softenClicheTemplates(transportSafeContent, options.protectedActionIntents),
    options.protectedActionIntents,
  )
    .replace(
      /(^|[。！？!?\n])\s*(?:不\s*[、，,。.!！?？…～~\-—]{1,8}\s*){2}/g,
      '$1',
    )
    .replace(
      /(^|[。！？!?\n])\s*(我|鼠|小仓鼠|白云小姐)\s*[、，,。.!！?？…～~\-—]{1,8}\s*\2\s*[、，,。.!！?？…～~\-—]*/g,
      '$1',
    )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const deliverable = cleaned || transportSafeContent.trim();
  return restoreHighConfidenceTerminalCodePunctuation(
    deliverable,
    protectedCode.terminal,
  );
}

function cleanReplyBubbles(messages: string[]) {
  return messages
    .map((message) => cleanAssistantMessageContent(message))
    .filter(Boolean);
}

function stripCodeFence(content: string) {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function readMessagesArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const messages = value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim());
    return messages.filter(Boolean);
  }

  if (value && typeof value === 'object') {
    const maybeMessages = (value as { messages?: unknown }).messages;
    if (Array.isArray(maybeMessages)) {
      const messages = maybeMessages
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim());
      return messages.filter(Boolean);
    }
  }

  return null;
}

function decodeJsonStringFragment(fragment: string) {
  const normalized = fragment
    .replace(/\\$/g, '')
    .replace(/\r?\n/g, '\\n');

  try {
    return JSON.parse(`"${normalized}"`) as string;
  } catch {
    return normalized
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\');
  }
}

function readRecoverableMessagesArray(content: string) {
  const source = stripCodeFence(content);
  const marker = /"messages"\s*:\s*\[/.exec(source);
  if (!marker) return null;

  const arrayStart = (marker.index ?? 0) + marker[0].length;
  let inString = false;
  let escaped = false;
  let arrayEnd = -1;
  for (let index = arrayStart; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && char === ']') {
      arrayEnd = index;
      break;
    }
  }
  if (arrayEnd < 0 || inString) return null;

  const arrayContent = source.slice(arrayStart, arrayEnd);
  const messages: string[] = [];
  const completeStringPattern = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;

  while ((match = completeStringPattern.exec(arrayContent))) {
    const decoded = decodeJsonStringFragment(match[1]).trim();
    if (decoded) messages.push(decoded);
  }

  return messages.length ? messages : null;
}

function looksLikeMessagesJson(content: string) {
  return /[{[]/.test(content[0] ?? '') && /"messages"\s*:/.test(content);
}

function formatElapsedSince(timestamp: number) {
  const elapsedMs = Date.now() - timestamp;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return '';

  const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));
  if (elapsedMinutes < 1) return '不到 1 分钟';
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  const remainingMinutes = elapsedMinutes % 60;
  if (elapsedHours < 24) {
    return remainingMinutes ? `${elapsedHours} 小时 ${remainingMinutes} 分钟` : `${elapsedHours} 小时`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} 天`;
}

function buildConversationPaceContext(messages: SubjectiveMessage[]) {
  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === 'I');
  if (!latestAssistantMessage) return '这是I 和小仓鼠这段对话里第一次开口。';

  const elapsed = formatElapsedSince(latestAssistantMessage.createdAt);
  if (!elapsed) return '';

  return `距离I 上次回复小仓鼠，已经过去 ${elapsed}。除非间隔很久或小仓鼠提到等待、回来、刚才，不要专门说出这件事；只用它调整回应的连续感。`;
}

function formatMessageContextTime(timestamp: number) {
  if (!Number.isFinite(timestamp)) return '';

  return new Date(timestamp).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatMusicCardContext(card?: MessageMusicCard) {
  if (!card) return '';
  if (card.status === 'ready' && card.song) {
    const avoided = card.duplicateAvoided ? '（已避开最近点过的重复歌曲）' : '';
    return `【内部音乐状态｜禁止复述】已生成音乐卡：${card.song.name} - ${card.song.artist || '未知歌手'}${avoided}。这不是对白，不要原样写给小仓鼠。`;
  }
  if (card.status === 'error') {
    return `【内部音乐状态｜禁止复述】音乐卡生成失败：${card.keyword}；原因：${card.error || '没有找到可播放版本'}。这不是对白，不要原样写给小仓鼠。`;
  }
  return `【内部音乐状态｜禁止复述】正在生成音乐卡：${card.keyword}；还没有确认播放成功。这不是对白，不要原样写给小仓鼠。`;
}

function getMessageMusicCards(message: SubjectiveMessage) {
  return message.musicCards?.length ? message.musicCards : message.musicCard ? [message.musicCard] : [];
}

function formatMusicCardsContext(message: SubjectiveMessage) {
  return getMessageMusicCards(message).map(formatMusicCardContext).filter(Boolean).join('\n');
}

function formatStickerContext(message: SubjectiveMessage) {
  if (!message.sticker) return '';
  return '【我随消息发出的本地图片表情包：' + message.sticker.moodId + ' / ' + message.sticker.name + '】';
}

export function buildApiMessageContent(message: SubjectiveMessage, includeTime = true) {
  if (message.role === 'I') {
    return [message.content, formatStickerContext(message), formatMusicCardsContext(message)].filter(Boolean).join('\n\n');
  }

  const sentAt = formatMessageContextTime(message.createdAt);
  const replyTo = message.replyTo
    ? [
        '【这条是在回复一条指定消息】',
        `被回复者：${message.replyTo.role === 'I' ? '白云小姐' : '小仓鼠'}`,
        `被回复时间：${formatMessageContextTime(message.replyTo.createdAt) || '未知'}`,
        `被回复内容：${message.replyTo.content}`,
      ].join('\n')
    : '';
  const reference = formatReadingReference(message.readingReference);
  if (!sentAt || !includeTime) return [replyTo, message.content, reference].filter(Boolean).join('\n\n');

  return [`【小仓鼠发送时间：${sentAt}】`, replyTo, message.content, reference].filter(Boolean).join('\n\n');
}

export function parseAssistantMessageBubbles(
  content: string,
  options: { allowRecoverableJson?: boolean } = {},
) {
  const trimmed = unwrapParenthesizedReplyEnvelope(content.trim());
  if (!trimmed) return [];

  const legacyMessageBlocks = extractWholeLegacyMessageBlocks(trimmed);
  if (legacyMessageBlocks?.length) {
    const cleaned = cleanReplyBubbles(legacyMessageBlocks);
    return cleaned.length ? cleaned : [SUBJECTIVE_REPLY_FALLBACK];
  }

  try {
    const parsed = JSON.parse(stripCodeFence(trimmed)) as unknown;
    const messages = readMessagesArray(parsed);
    if (messages?.length) {
      const cleaned = cleanReplyBubbles(expandWholeLegacyMessageBlocks(messages));
      return cleaned.length ? cleaned : [SUBJECTIVE_REPLY_FALLBACK];
    }
  } catch {
    const recoveredMessages = options.allowRecoverableJson ? readRecoverableMessagesArray(trimmed) : null;
    if (recoveredMessages?.length) {
      const cleaned = cleanReplyBubbles(expandWholeLegacyMessageBlocks(recoveredMessages));
      return cleaned.length ? cleaned : [SUBJECTIVE_REPLY_FALLBACK];
    }
    if (looksLikeMessagesJson(stripCodeFence(trimmed))) {
      return [];
    }
  }

  const paragraphs = trimmed
    .split(/\n\s*\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) {
    const cleaned = cleanReplyBubbles(expandWholeLegacyMessageBlocks(paragraphs));
    return cleaned.length ? cleaned : [SUBJECTIVE_REPLY_FALLBACK];
  }

  const cleaned = cleanReplyBubbles([trimmed]);
  return cleaned.length ? cleaned : [SUBJECTIVE_REPLY_FALLBACK];
}

export function createSubjectiveMessage(
  role: SubjectiveRole,
  content: string,
  metadata: Partial<Pick<SubjectiveMessage, 'reminderPlanCard' | 'reminderOccurrenceId' | 'reminderAttemptId' | 'theaterBackstage' | 'theaterBackstagePending' | 'readingReference' | 'fallbackDiagnostics' | 'generationDiagnostics' | 'goalTimeCreditCard' | 'replyTo' | 'scheduleChangeCard' | 'schedulePlanCard' | 'expensePlanCard' | 'toolCallCards' | 'scheduleOccurrenceId' | 'scheduleReminderPersona' | 'scheduleCompanionEventId' | 'scheduleCompanionKind' | 'source' | 'taskExecutionSessionId' | 'taskExecutionNudgeKind' | 'voice' | 'images' | 'sticker'>> = {},
): SubjectiveMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    role,
    content,
    createdAt: Date.now(),
    ...stripRetiredActionMetadata(metadata),
  };
}

export function createIMessageFromApiResponse(content: string): SubjectiveMessage {
  const cleanedContent = cleanAssistantMessageContent(content);
  return createSubjectiveMessage('I', cleanedContent || '小仓鼠，我在这里呀。');
}

export function createIMessagesFromApiResponse(
  contents: string[],
  metadata: Partial<Pick<SubjectiveMessage, 'theaterBackstage' | 'theaterBackstagePending' | 'pokeInteraction' | 'fallbackDiagnostics' | 'generationDiagnostics' | 'scheduleOccurrenceId' | 'scheduleReminderPersona' | 'scheduleCompanionEventId' | 'scheduleCompanionKind' | 'source' | 'taskExecutionSessionId' | 'taskExecutionNudgeKind' | 'toolCallCards'>> = {},
): SubjectiveMessage[] {
  const cleanedContents = cleanReplyBubbles(contents);

  return (cleanedContents.length ? cleanedContents : [SUBJECTIVE_REPLY_FALLBACK]).map((content) =>
    createSubjectiveMessage('I', content, metadata),
  );
}

export function buildApiMessages(
  systemPrompt: string,
  messages: SubjectiveMessage[],
  runtimeContext?: string,
  conversationSummary?: string,
  dynamicContext?: string,
  preambleMessages: ApiChatMessage[] = [],
  localQwenLayout = false,
  replyContextMode: 'chat' | 'letter' = 'chat',
): ApiChatMessage[] {
  const conversationalMessages = messages.filter((message) => (
    message.source !== 'voice-call'
    && !(
      message.role === 'I'
      && message.source === 'proactive-message'
      && message.deliveryStatus === 'failed'
    )
  ));
  const apiMessages: ApiChatMessage[] = [
    {
      role: 'system',
      content: `${SUBJECTIVE_IDENTITY_PROTOCOL}\n\n${systemPrompt}`,
    },
    ...(conversationSummary?.trim()
      ? [{
          role: 'system' as const,
          content: `【更早对话的累计摘要】\n\n${conversationSummary.trim()}\n\n这份摘要只帮助 I 接上更早的对话。事实以近期原话、you 明确确认的内容和可靠记录为准。`,
        }]
      : []),
    ...preambleMessages,
    ...conversationalMessages.flatMap<ApiChatMessage>((message, index) => {
      const context = getTheaterBackstageContext(message, localQwenLayout ? undefined : conversationalMessages[index - 1]);
      const historicalMaterials: ApiChatMessage[] = [
        ...(context ? [{ role: 'system' as const, content: context }] : []),
        ...(message.expensePlanCard ? [{ role: 'system' as const, content: expensePlanHistoryMaterial(message.expensePlanCard) }] : []),
        ...(message.reminderPlanCard ? [{ role: 'system' as const, content: reminderPlanHistoryMaterial(message.reminderPlanCard) }] : []),
      ];
      const numbered = localQwenLayout && historicalMaterials.length > 0;
      return [
        ...(numbered ? [{ role: 'system' as const,
          content: `【对话条目 ${index + 1} 的附属记录】\n${historicalMaterials.map(material => material.content).join('\n\n')}`,
        }] : historicalMaterials),
        { role: message.role === 'you' ? 'user' as const : 'assistant' as const,
          content: (numbered ? `【对话条目 ${index + 1}】\n` : '') + buildApiMessageContent(message) },
      ];
    }),
  ];

  const context = [
    dynamicContext?.trim()
      ? `【本轮动态参考】\n${dynamicContext.trim()}`
      : '',
    runtimeContext?.trim()
      ? `【回复前看见的现实】\n${runtimeContext.trim()}`
      : '',
  ].filter(Boolean).join('\n\n');
  if (!context) return apiMessages;
  const conversationPaceContext = replyContextMode === 'letter' ? '' : buildConversationPaceContext(conversationalMessages);
  const replyTarget = localQwenLayout
    ? '本次请求中最近一条 you 消息才是小仓鼠本轮要回应的话。'
    : '上一条 you 消息才是小仓鼠本轮要你回应的话。';

  const runtimeMessage: ApiChatMessage = {
    role: 'system',
    content: replyContextMode === 'letter' ? context
      : `【开口前的内部参考】\n${replyTarget}以下不是小仓鼠原话，也不是要单独回复的任务；只用于校准这一轮回答，不要复述标题或提到内部参考。\n\n${context}${conversationPaceContext ? `\n${conversationPaceContext}` : ''}`,
  };
  const latestUserIndex = apiMessages.findLastIndex((message) => message.role === 'user');
  if (latestUserIndex < 0) {
    return [...apiMessages, runtimeMessage];
  }

  return [
    ...apiMessages.slice(0, latestUserIndex + 1),
    runtimeMessage,
    ...apiMessages.slice(latestUserIndex + 1),
  ];
}
