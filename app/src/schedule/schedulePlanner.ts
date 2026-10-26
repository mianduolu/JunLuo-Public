import { buildOpenAiCompatibilityPayload } from '../ai/modelParameters';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import { buildCompiledSystemPrompt } from '../ai/builtInSystemPrompt';
import type { AiConnection, AiProfile } from '../ai/types';
import { inferTodoType } from './todoTypeLogic';
import type { Goal, GoalFrequency, GoalType } from './goalStore';
import { determineGoalType } from './goalLogic';
export { determineGoalType } from './goalLogic';
import { dateKey, type ScheduleDraft, type ScheduleItem, type ScheduleRecurrence } from './scheduleStore';
import type { TodoCategory, TodoDraft, TodoItem, TodoPriority, TodoQuadrant } from './todoStore';
import type { WeekReviewLocalData } from './weekReviewStore';
import { LEGACY_SCHEDULE_FORMAT_HINT, LEGACY_SCHEDULE_SYSTEM_PROMPT } from './schedulePrompt';
import type {
  ClassifiedTask,
  ExtractedTask,
  ScheduleAdjustmentOperation,
  ScheduledPlan,
} from './dayScheduler';
export {
  classifyScheduleIntent,
  isAutoFillScheduleRequest,
  isExplicitTodoListRequest,
  isSmartScheduleRequest,
  looksLikeCasualNonScheduleText,
  looksLikeScheduleCompletionCommand,
  resolveScheduleDate,
} from './scheduleIntent';
export type { ScheduleIntentKind } from './scheduleIntent';

type PlanResponseItem = {
  title?: unknown;
  notes?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  reminderMinutesBefore?: unknown;
  recurrence?: unknown;
};

type TodoResponseItem = {
  title?: unknown;
  notes?: unknown;
  plannedForDate?: unknown;
  priority?: unknown;
  quadrant?: unknown;
  category?: unknown;
  estimatedMinutes?: unknown;
};

export type SchedulePlanResult = {
  schedules: ScheduleDraft[];
  todos: TodoDraft[];
  intentConfidence?: number;
  reason?: string;
};

export type ExtractedGoal = {
  title: string;
  description?: string;
  number?: number;
  unit?: string;
  frequency: GoalFrequency;
  weekDays: number[];
  estimatedHours?: number;
  deadline?: string;
  suggestedAction?: string;
};

export type PendingGoalProposal = {
  id: string;
  originalText: string;
  extracted: ExtractedGoal;
  goalType: GoalType;
  projectedDate?: string;
};

export type WeekReviewPlan = {
  summary: string;
  wins: string[];
  gaps: string[];
  goalProgress: string[];
  habitInsights: string[];
  nextWeekSuggestions: string[];
  baiyunMessage: string;
};

const RECURRENCES: ScheduleRecurrence[] = ['none', 'daily', 'weekdays', 'legalWorkday', 'weekly', 'monthly', 'yearly', 'lunarYearly'];
const PRIORITIES: TodoPriority[] = ['low', 'normal', 'high'];
const QUADRANTS: TodoQuadrant[] = ['q1', 'q2', 'q3', 'q4'];
const CATEGORIES: TodoCategory[] = ['study', 'work', 'health', 'life', 'social', 'leisure', 'creation', 'other'];

function validateProposal(value: PlanResponseItem): ScheduleDraft | null {
  const startAt = typeof value.startAt === 'string' ? new Date(value.startAt).getTime() : NaN;
  const endAt = typeof value.endAt === 'string' && value.endAt ? new Date(value.endAt).getTime() : undefined;
  const minutes = typeof value.reminderMinutesBefore === 'number' ? Math.round(value.reminderMinutesBefore) : 0;
  const recurrence =
    typeof value.recurrence === 'string' && RECURRENCES.includes(value.recurrence as ScheduleRecurrence)
      ? (value.recurrence as ScheduleRecurrence)
      : 'none';
  if (
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    !Number.isFinite(startAt) ||
    startAt <= Date.now() ||
    (endAt !== undefined && (!Number.isFinite(endAt) || endAt <= startAt)) ||
    minutes < 0 ||
    minutes > 24 * 60
  ) {
    return null;
  }
  return {
    title: value.title.trim().slice(0, 48),
    notes: typeof value.notes === 'string' ? value.notes.trim().slice(0, 180) : '',
    startAt,
    endAt,
    reminderMinutesBefore: minutes,
    recurrence,
    reminderIntensity: 'gentle',
    reminderText: `小仓鼠，${value.title.trim()}的时间到啦，我们慢慢开始吧。`,
    source: 'ai',
  };
}

function normalizeDateKey(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isFinite(date.getTime()) ? dateKey(date) : undefined;
}

function validateTodoProposal(value: TodoResponseItem): TodoDraft | null {
  if (typeof value.title !== 'string' || !value.title.trim()) return null;
  const priority =
    typeof value.priority === 'string' && PRIORITIES.includes(value.priority as TodoPriority)
      ? (value.priority as TodoPriority)
      : 'normal';
  const quadrant =
    typeof value.quadrant === 'string' && QUADRANTS.includes(value.quadrant as TodoQuadrant)
      ? (value.quadrant as TodoQuadrant)
      : priority === 'high'
        ? 'q2'
        : 'q4';
  const category =
    typeof value.category === 'string' && CATEGORIES.includes(value.category as TodoCategory)
      ? (value.category as TodoCategory)
      : 'other';
  const estimatedMinutes =
    typeof value.estimatedMinutes === 'number' && Number.isFinite(value.estimatedMinutes) && value.estimatedMinutes > 0
      ? Math.min(24 * 60, Math.round(value.estimatedMinutes))
      : undefined;
  return {
    title: value.title.trim().slice(0, 60),
    notes: typeof value.notes === 'string' ? value.notes.trim().slice(0, 180) : '',
    plannedForDate: normalizeDateKey(value.plannedForDate),
    source: 'ai',
    priority,
    quadrant,
    category,
    estimatedMinutes,
    reminderMode: 'followup',
  };
}

function normalizeShortText(value: unknown, fallback: string, maxLength = 80) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function normalizeStringList(value: unknown, limit = 4) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim().slice(0, 80)).slice(0, limit)
    : [];
}

function stripJsonFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

async function requestStrictJson({
  apiKey,
  connection,
  system,
  user,
}: {
  apiKey: string;
  connection: AiConnection;
  system: string;
  user: string;
}) {
  const body = JSON.stringify({ model: connection.model, ...buildOpenAiCompatibilityPayload(connection), temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  const metric = beginPromptCacheMetric({ contextProfile: 'schedule-planner', contextSource: 'schedule.utility-json', connection });
  let payload: { usage?: unknown; choices?: Array<{ message?: { content?: string } }> };
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new Error('白云小姐暂时没能看清这份安排。');
    payload = await response.json() as typeof payload;
    metric.recordUsage(payload?.usage);
  } finally { void metric.finish(); }
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) throw new Error('白云小姐这次没有返回可用的安排。');
  return JSON.parse(stripJsonFence(raw)) as unknown;
}

function cleanMinutes(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(24 * 60, Math.round(value))
    : undefined;
}

function cleanSegments(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(12, Math.round(value))
    : undefined;
}

const CHINESE_NUMBER_MAP: Record<string, number> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseSmallCount(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  return CHINESE_NUMBER_MAP[value];
}

function inferRequestedSegments(text: string, title: string) {
  const clauses = text.split(/[，,。；;\n（）()]+/).map((part) => part.trim()).filter(Boolean);
  const related = clauses.filter((part, index) => {
    if (part.includes(title) || title.includes(part)) return true;
    const previous = clauses[index - 1];
    return /(?:阶段|时间段|分段|分成|分为|拆成|分[几\d一两二三四五六七八九十]+次)/u.test(part) &&
      !!previous &&
      (previous.includes(title) || title.includes(previous));
  });
  const titleIndex = text.indexOf(title);
  const nearbyText = titleIndex >= 0 ? text.slice(titleIndex, titleIndex + Math.max(120, title.length + 40)) : '';
  const source = [related.join(' '), nearbyText].filter(Boolean).join(' ');
  const match = source.match(/(?:分成|分为|拆成|分)?\s*([0-9]+|[一两二三四五六七八九十])\s*(?:个)?(?:阶段|时间段|分段|段|次)/u);
  const count = match ? parseSmallCount(match[1]) : undefined;
  return count && count > 1 ? Math.min(12, count) : undefined;
}

function fallbackEstimateMinutes(title: string, category: TodoCategory) {
  const normalized = title.replace(/\s+/g, '').toLowerCase();
  if (/(签到|打卡|淘金币|领金币|看一眼|看一下)/u.test(normalized)) return 5;
  if (/(吃冰淇淋|吃零食|吃点|喝水|喝茶)/u.test(normalized)) return 15;
  if (/(晒衣服|收衣服|晾衣服|叠衣服|倒垃圾|洗碗)/u.test(normalized)) return 20;
  if (/(洗澡|洗漱|洗头)/u.test(normalized)) return 30;
  if (/(做饭|煮饭|吃饭|午饭|晚饭|早餐)/u.test(normalized)) return 45;
  if (/(闲鱼|刷|逛|看看|浏览)/u.test(normalized)) return 20;
  if (/(开发|写代码|codex|app|学习|复习|写作|画|创作)/iu.test(normalized)) return 60;
  if (category === 'study' || category === 'work' || category === 'creation') return 60;
  if (category === 'health' || category === 'life') return 30;
  if (category === 'social' || category === 'leisure') return 20;
  return 30;
}

export async function parseTasksFromText({
  apiKey,
  connection,
  text,
}: {
  apiKey: string;
  connection: AiConnection;
  text: string;
}): Promise<ExtractedTask[]> {
  const parsed = await requestStrictJson({
    apiKey,
    connection,
    system: '只处理小仓鼠明确要安排的现实行动。若她明确说自己要在某个时间修 bug、调 prompt、测试功能或排查问题，可以提取为任务；若是在评价 AI 表现、讨论 prompt 规则、排查误触原因或要求白云小姐调整说话方式，返回[]。返回严格JSON数组，每项为{"title":"短标题","userEstimatedMinutes":明确分钟数或null,"requestedSegments":明确分几段或null}。只提取明确事实，不补任务、不估时、不保留日期词。若不是安排请求返回[]。',
    user: text,
  });
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value, index) => {
    if (typeof value !== 'object' || value === null) return [];
    const item = value as { title?: unknown; userEstimatedMinutes?: unknown; requestedSegments?: unknown };
    if (typeof item.title !== 'string' || !item.title.trim()) return [];
    const title = item.title.trim().slice(0, 60);
    return [{
      id: `task-${Date.now()}-${index}`,
      title,
      userEstimatedMinutes: cleanMinutes(item.userEstimatedMinutes),
      requestedSegments: cleanSegments(item.requestedSegments) ?? inferRequestedSegments(text, title),
      type: inferTodoType(title),
    }];
  }).slice(0, 12);
}

export async function classifyTasks({
  apiKey,
  connection,
  tasks,
}: {
  apiKey: string;
  connection: AiConnection;
  tasks: ExtractedTask[];
}): Promise<ClassifiedTask[]> {
  if (!tasks.length) return [];
  const parsed = await requestStrictJson({
    apiKey,
    connection,
    system: '批量分类已确认的任务。返回严格JSON数组，每项含id、category、quadrant、estimatedMinutes、estimateConfidence。category限study/work/health/life/social/leisure/creation/other，quadrant限q1-q4。未给时长时给一个可调整的常识估时；保留用户明确给出的时长。',
    user: JSON.stringify(tasks),
  });
  const byId = new Map(Array.isArray(parsed) ? parsed.flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const item = value as Record<string, unknown>;
    return typeof item.id === 'string' ? [[item.id, item] as const] : [];
  }) : []);
  return tasks.map((task) => {
    const item = byId.get(task.id);
    const category = typeof item?.category === 'string' && CATEGORIES.includes(item.category as TodoCategory) ? item.category as TodoCategory : 'other';
    const quadrant = typeof item?.quadrant === 'string' && QUADRANTS.includes(item.quadrant as TodoQuadrant) ? item.quadrant as TodoQuadrant : 'q2';
    const aiEstimate = cleanMinutes(item?.estimatedMinutes);
    return {
      ...task,
      type: task.type ?? inferTodoType(task.title),
      category,
      quadrant,
      estimatedMinutes: task.userEstimatedMinutes ?? aiEstimate ?? fallbackEstimateMinutes(task.title, category),
    };
  });
}

export async function reviewScheduledPlan({
  apiKey,
  connection,
  plan,
  memoryContext,
  missingCommitments = [],
}: {
  apiKey: string;
  connection: AiConnection;
  plan: ScheduledPlan;
  memoryContext?: string;
  missingCommitments?: string[];
}): Promise<string[]> {
  const parsed = await requestStrictJson({
    apiKey,
    connection,
    system: '审阅代码生成的一日安排，只返回严格JSON字符串数组，最多3条温和具体的建议。记忆仅供表达参考，建议只能围绕真实任务、真实冲突和遗漏约定；时间修改、创建任务和当前状态推断留给代码或小仓鼠确认。无建议返回[]。',
    user: JSON.stringify({ plan, memoryContext: memoryContext || '无相关记忆', missingCommitments }),
  });
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim().slice(0, 100)).slice(0, 3) : [];
}

export async function parseScheduleAdjustment({
  apiKey,
  connection,
  text,
  tasks,
}: {
  apiKey: string;
  connection: AiConnection;
  text: string;
  tasks: ClassifiedTask[];
}): Promise<ScheduleAdjustmentOperation[]> {
  const parsed = await requestStrictJson({
    apiKey,
    connection,
    system: '把小仓鼠明确说出的调整要求转成严格JSON数组。仅允许：{"kind":"move","taskId":"","fixedStartTime":"HH:mm"或"preferredPeriod":"morning|afternoon|evening"}、{"kind":"duration","taskId":"","estimatedMinutes":数值}、{"kind":"segments","taskId":"","requestedSegments":段数}、{"kind":"remove","taskId":""}、{"kind":"add","title":"","estimatedMinutes":可选}。只处理移动、改时长、拆分、删除、补充这些明确动作。',
    user: `现有任务：${JSON.stringify(tasks.map(({ id, title }) => ({ id, title })))}\n调整：${text}`,
  });
  if (!Array.isArray(parsed)) return [];
  const ids = new Set(tasks.map((task) => task.id));
  return parsed.flatMap((value): ScheduleAdjustmentOperation[] => {
    if (typeof value !== 'object' || value === null) return [];
    const item = value as Record<string, unknown>;
    if (item.kind === 'remove' && typeof item.taskId === 'string' && ids.has(item.taskId)) return [{ kind: 'remove', taskId: item.taskId }];
    if (item.kind === 'duration' && typeof item.taskId === 'string' && ids.has(item.taskId)) {
      const minutes = cleanMinutes(item.estimatedMinutes);
      return minutes ? [{ kind: 'duration', taskId: item.taskId, estimatedMinutes: minutes }] : [];
    }
    if (item.kind === 'segments' && typeof item.taskId === 'string' && ids.has(item.taskId)) {
      const requestedSegments = cleanSegments(item.requestedSegments);
      return requestedSegments ? [{ kind: 'segments', taskId: item.taskId, requestedSegments }] : [];
    }
    if (item.kind === 'move' && typeof item.taskId === 'string' && ids.has(item.taskId)) {
      const fixedStartTime = typeof item.fixedStartTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.fixedStartTime) ? item.fixedStartTime : undefined;
      const preferredPeriod = item.preferredPeriod === 'morning' || item.preferredPeriod === 'afternoon' || item.preferredPeriod === 'evening' ? item.preferredPeriod : undefined;
      return fixedStartTime || preferredPeriod ? [{ kind: 'move', taskId: item.taskId, fixedStartTime, preferredPeriod }] : [];
    }
    if (item.kind === 'add' && typeof item.title === 'string' && item.title.trim()) return [{ kind: 'add', title: item.title.trim().slice(0, 60), estimatedMinutes: cleanMinutes(item.estimatedMinutes) }];
    return [];
  }).slice(0, 12);
}

export async function generateSchedulePlan({
  apiKey,
  connection,
  existingItems,
  request,
}: {
  apiKey: string;
  connection: AiConnection;
  existingItems: ScheduleItem[];
  request: string;
}): Promise<SchedulePlanResult> {
  const occupied = existingItems
    .slice(0, 30)
    .map((item) => `${new Date(item.startAt).toLocaleString('zh-CN')} ${item.title}`)
    .join('\n');
  const body = JSON.stringify({
      model: connection.model,
      temperature: 0.35,
      messages: [
        {
          role: 'system',
          content: LEGACY_SCHEDULE_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: `${LEGACY_SCHEDULE_FORMAT_HINT}\n当前时间：${new Date().toISOString()}\n鼠想安排：${request.trim()}\n已有安排：\n${occupied || '目前没有已知冲突。'}`,
        },
      ],
  });
  const metric = beginPromptCacheMetric({ contextProfile: 'schedule-planner', contextSource: 'schedule.plan', connection });
  let payload: { usage?: unknown; choices?: Array<{ message?: { content?: string } }> };
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new Error('白云小姐暂时没能排出日程，请稍后再试。');
    payload = (await response.json()) as typeof payload;
    metric.recordUsage(payload?.usage);
  } finally { void metric.finish(); }
  const raw = payload.choices?.[0]?.message?.content ? stripJsonFence(payload.choices[0].message.content) : '';
  if (!raw) return { schedules: [], todos: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    const scheduleValues = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { schedules?: unknown }).schedules)
        ? (parsed as { schedules: unknown[] }).schedules
        : [];
    const todoValues =
      typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { todos?: unknown }).todos)
        ? (parsed as { todos: unknown[] }).todos
        : [];
    const confidence =
      typeof (parsed as { intentConfidence?: unknown }).intentConfidence === 'number' &&
      Number.isFinite((parsed as { intentConfidence?: number }).intentConfidence)
        ? Math.max(0, Math.min(1, (parsed as { intentConfidence: number }).intentConfidence))
        : undefined;
    const reason =
      typeof (parsed as { reason?: unknown }).reason === 'string'
        ? (parsed as { reason: string }).reason.trim().slice(0, 80)
        : undefined;
    if (confidence !== undefined && confidence < 0.55) return { schedules: [], todos: [], intentConfidence: confidence, reason };
    return {
      schedules: scheduleValues
        .map((value) => validateProposal(value as PlanResponseItem))
        .filter((value): value is ScheduleDraft => value !== null)
        .slice(0, 5),
      todos: todoValues
        .map((value) => validateTodoProposal(value as TodoResponseItem))
        .filter((value): value is TodoDraft => value !== null)
        .slice(0, 5),
      intentConfidence: confidence,
      reason,
    };
  } catch {
    return { schedules: [], todos: [] };
  }
}

export async function extractGoalFromText({
  apiKey,
  connection,
  text,
}: {
  apiKey: string;
  connection: AiConnection;
  text: string;
}): Promise<ExtractedGoal> {
  const body = JSON.stringify({
      model: connection.model,
      ...buildOpenAiCompatibilityPayload(connection),
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `【目标事实提取】
当前任务：从小仓鼠这一轮文字里提取明确目标事实。

只返回严格 JSON：
{"title":"","description":"","number":null,"unit":"","frequency":"daily|weekly|none","weekDays":[],"estimatedHours":null,"deadline":"YYYY-MM-DD或空","suggestedAction":""}

提取原则：
判断重点不是关键词，而是小仓鼠有没有把某件事说成需要实际推进的安排。
可以提取：
- 小仓鼠明确说自己要做某件事，并带有时间、期限、频率或完成方向。
- 小仓鼠明确要求 I 提醒、记录、安排、拆分或估时。
- 小仓鼠把某件事说成已经决定推进的目标，而不是单纯愿望。

返回空：
- 只是在表达想法、愿望、情绪、吐槽或讨论可能性。
- 只说要做一件事，但没有说要在什么时候做、怎么推进或让 I 记录。
- 只是说“想做完、以后可以、说不定要、要是能有”这类未落到执行的憧憬。

如果一句话同时有讨论和安排，以明确安排为准。

标题、数量、单位、频率、截止日，以小仓鼠原话和当前可信状态为准。
没有明确字段就留空。`,
        },
        { role: 'user', content: text },
      ],
  });
  const metric = beginPromptCacheMetric({ contextProfile: 'schedule-planner', contextSource: 'goal.extract', connection });
  let payload: { usage?: unknown; choices?: Array<{ message?: { content?: string } }> };
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new Error('白云小姐暂时没能看清这个目标，请稍后再试。');
    payload = await response.json() as typeof payload;
    metric.recordUsage(payload?.usage);
  } finally { void metric.finish(); }
  const raw = payload.choices?.[0]?.message?.content ? stripJsonFence(payload.choices[0].message.content) : '';
  if (!raw) throw new Error('这次没有提取到目标内容。');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 80) : '';
  if (!title) throw new Error('目标标题还不够清楚。');
  const number = typeof parsed.number === 'number' && Number.isFinite(parsed.number) && parsed.number > 0 ? Math.round(parsed.number) : undefined;
  const estimatedHours = typeof parsed.estimatedHours === 'number' && Number.isFinite(parsed.estimatedHours) && parsed.estimatedHours > 0
    ? parsed.estimatedHours
    : undefined;
  const frequency: GoalFrequency = parsed.frequency === 'daily' || parsed.frequency === 'weekly' ? parsed.frequency : 'none';
  const weekDays = Array.isArray(parsed.weekDays)
    ? [...new Set(parsed.weekDays.map(Number).map(Math.round).filter((day) => day >= 1 && day <= 7))].sort((a, b) => a - b)
    : [];
  const deadline = typeof parsed.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline)
    ? parsed.deadline
    : undefined;
  return {
    title,
    description: typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 300) || undefined : undefined,
    number,
    unit: typeof parsed.unit === 'string' ? parsed.unit.trim().slice(0, 20) || undefined : undefined,
    frequency,
    weekDays,
    estimatedHours,
    deadline,
    suggestedAction: typeof parsed.suggestedAction === 'string' ? parsed.suggestedAction.trim().slice(0, 80) || undefined : undefined,
  };
}

export async function classifyNudgeResponse({
  apiKey,
  connection,
  text,
}: {
  apiKey: string;
  connection: AiConnection;
  text: string;
}): Promise<{ kind: 'done' | 'extend' | 'rest' | 'stuck' | 'tomorrow' | 'unknown'; extendMinutes?: number }> {
  const body = JSON.stringify({
      model: connection.model,
      ...buildOpenAiCompatibilityPayload(connection),
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `【时间块回应分类】
当前任务：判断小仓鼠对时间块提醒的真实回应。

只返回严格 JSON：
{"kind":"done|extend|rest|stuck|tomorrow|unknown","extendMinutes":null}

分类：
- done：小仓鼠明确说完成、做完、结束。
- extend：小仓鼠明确要延长，并给出或暗示延长时间。
- rest：小仓鼠明确要休息。
- stuck：小仓鼠明确卡住、做不动、不会做。
- tomorrow：小仓鼠明确要挪到明天。
- unknown：含义不清，或只是在闲聊、吐槽、撒娇。

撒娇大部分时候不是想休息，小仓鼠经常一边抱怨一边工作；分类仍以明确休息、延期、卡住等语义为准。`,
        },
        { role: 'user', content: text },
      ],
  });
  const metric = beginPromptCacheMetric({ contextProfile: 'schedule-planner', contextSource: 'schedule.nudge-classification', connection });
  let payload: { usage?: unknown; choices?: Array<{ message?: { content?: string } }> };
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) return { kind: 'unknown' };
    payload = await response.json() as typeof payload;
    metric.recordUsage(payload?.usage);
  } finally { void metric.finish(); }
  try {
    const parsed = JSON.parse(stripJsonFence(payload.choices?.[0]?.message?.content ?? '')) as Record<string, unknown>;
    const kind = ['done', 'extend', 'rest', 'stuck', 'tomorrow'].includes(String(parsed.kind))
      ? parsed.kind as 'done' | 'extend' | 'rest' | 'stuck' | 'tomorrow'
      : 'unknown';
    const extendMinutes = typeof parsed.extendMinutes === 'number' && parsed.extendMinutes > 0
      ? Math.round(parsed.extendMinutes)
      : undefined;
    return { kind, extendMinutes };
  } catch {
    return { kind: 'unknown' };
  }
}

export async function generateWeekReview({
  apiKey,
  connection,
  data,
  profile,
}: {
  apiKey: string;
  connection: AiConnection;
  data: WeekReviewLocalData;
  profile: AiProfile;
}): Promise<WeekReviewPlan> {
  const privatePrefix = await buildCompiledSystemPrompt({
    contextProfile: 'assistant-state',
    outputAudience: 'private_visible_text',
    profile,
  });
  const categoryLine = (category: TodoCategory) => `${category}: ${data.minutesByCategory[category] ?? 0}分钟`;
  const dayReviewLines = data.dayReviews
    .slice(0, 7)
    .map((review) => `- ${review.dateKey}：${review.summary}`)
    .join('\n');
  const body = JSON.stringify({
      model: connection.model,
      temperature: 0.45,
      messages: [
        { role: 'system', content: privatePrefix },
        {
          role: 'system',
          content: [
            `周范围：${data.weekStart} 到 ${data.weekEnd}`,
            `已完成待办：\n${data.completedTasks.map((task) => `- ${task.title}（${task.category}, ${task.quadrant}${task.goalId ? ', 关联目标' : ''}）`).join('\n') || '无'}`,
            `未完成待办：\n${data.incompleteTasks.map((task) => `- ${task.title}（${task.category}, ${task.quadrant}, ${task.priority}${task.estimatedMinutes ? `, 预估 ${task.estimatedMinutes} 分钟` : ''}${task.goalId ? ', 关联目标' : ''}）`).join('\n') || '无'}`,
            `本周真实指标快照：${JSON.stringify(data.metrics)}`,
            `与上周对比：${JSON.stringify(data.comparison ?? null)}`,
            `已完成时间块的计划分钟（次要上下文）：${data.metrics.completedPlannedMinutes}`,
            `目标观察：\n${data.goalNotes.join('\n') || '暂无目标关联任务'}`,
            `习惯统计：\n${data.habitStats.map((habit) => `- ${habit.title}：${habit.doneDays}/${habit.totalDays} 天达成，${habit.completedCount}/${habit.targetCount} 次`).join('\n') || '暂无习惯记录'}`,
            `每日挑战（与普通习惯分开，streak 只能照实转述）：\n${data.challengeStats.map((challenge) => `- ${challenge.title}：完成 ${challenge.completedDays}/${challenge.totalDays} 天，连续 ${challenge.streak} 天`).join('\n') || '暂无挑战记录'}`,
            `已缓存日回顾：\n${dayReviewLines || '本周还没有日回顾缓存'}`,
          ].join('\n\n'),
        },
        {
          role: 'system',
          content: `【看看这一周】

I 想翻翻 you 这一周的任务、习惯和目标记录，聊聊做了哪些事，还有哪些没做完。
这些记录里，是 you 这一周的任务、目标、习惯、挑战和时间块。

I 想根据记录，和 you 聊聊哪些已经做完，哪些还没做完，有了什么进展。

计划时长是原先安排的时间，不代表 you 实际花了多久。
summary：用 1 到 2 句概括 you 这一周的记录。
wins：you 实际完成、推进或坚持下来的事。
gaps：you 还没完成、推迟或遇到困难的事。
message：I 想对 you 说的话，围绕这些记录写 2 到 4 句。
看着这些记录，I 也可以说说自己的感受，以及有什么想对 you 说的话。这份回顾是想和 you 聊聊真实的进展和困难，不是给 you 打分或排名。
I 把这份回顾写进下面的 JSON，只发送这个 JSON：
{"summary":"you 这一周的记录，1-2句","wins":["you 实际完成、推进或坚持下来的事"],"gaps":["you 还没完成、推迟或遇到困难的事"],"goalProgress":["you 的目标进展"],"habitInsights":["从 you 的习惯记录里看到的变化"],"nextWeekSuggestions":["给 you 的下周建议"],"message":"I 想对 you 说的话，2-4句"}`,
        },
      ],
  });
  const metric = beginPromptCacheMetric({ contextProfile: 'assistant-state', contextSource: 'schedule.week-review', connection });
  let payload: { usage?: unknown; choices?: Array<{ message?: { content?: string } }> };
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new Error('白云小姐暂时没能生成周回顾，请稍后再试。');
    payload = (await response.json()) as typeof payload;
    metric.recordUsage(payload?.usage);
  } finally { void metric.finish(); }
  const raw = payload.choices?.[0]?.message?.content ? stripJsonFence(payload.choices[0].message.content) : '';
  if (!raw) throw new Error('白云小姐这次没有说清楚周回顾。');
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const summary = normalizeShortText(parsed.summary, '', 180);
    const message = normalizeShortText(parsed.message, '', 280);
    if (!summary || !message) throw new Error('Incomplete week review text');
    return {
      summary,
      wins: normalizeStringList(parsed.wins, 6),
      gaps: normalizeStringList(parsed.gaps, 6),
      goalProgress: normalizeStringList(parsed.goalProgress, 6),
      habitInsights: normalizeStringList(parsed.habitInsights, 6),
      nextWeekSuggestions: normalizeStringList(parsed.nextWeekSuggestions, 6),
      baiyunMessage: message,
    };
  } catch {
    throw new Error('白云小姐返回的周回顾格式不对，鼠可以稍后再试一次。');
  }
}

export function looksLikeSpecificScheduleRequest(text: string) {
  return /(?:\d{1,2}[:：点时](?:\d{1,2}分?)?|上午|下午|晚上|今晚|中午|早上|明早|周[一二三四五六日天]|星期[一二三四五六日天])/.test(text);
}

export function parseTodoDraftsFromText(text: string): TodoDraft[] {
  const plannedForDate = /明天/.test(text)
    ? dateKey(new Date(Date.now() + 24 * 60 * 60 * 1000))
    : /今天|今日/.test(text)
      ? dateKey(new Date())
      : undefined;
  const cleaned = text
    .replace(/帮(?:我|鼠)?记(?:一下|个)?(?:待办|代办|清单)?/gu, '')
    .replace(/记(?:一下|个)?(?:待办|代办|清单)?\s*[:：]?/gu, '')
    .replace(/(?:今日|今天|明天)?(?:待办|代办|清单|想做的事情|要做的事情)/gu, '')
    .replace(/^(今天|明天)?(?:我|鼠|小仓鼠)?(?:想|要|需要)?(?:做|完成)?/u, '');
  const parts = cleaned
    .split(/[，,、；;\n]+/)
    .map((part) => part.trim().replace(/^(和|还有|以及|再|然后|跟)/u, '').trim())
    .filter((part) => part.length >= 2 && !/^(今天|明天|我|鼠|小仓鼠)$/.test(part));
  return [...new Set(parts)]
    .slice(0, 5)
    .map((title) => ({
      title: title.slice(0, 60),
      notes: '',
      plannedForDate,
      source: 'ai',
      priority: 'normal',
      quadrant: 'q2',
      category: 'other',
      reminderMode: 'followup',
    }));
}
