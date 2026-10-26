import { dateKey } from './scheduleStore';
import { getTodoDatabase as getDatabase } from './todoDatabase';

export type LifeAreaType = 'health' | 'work' | 'relationships' | 'growth' | 'leisure' | 'creation' | 'other';
export type GoalStatus = 'active' | 'completed' | 'paused';
export type GoalPriority = 'low' | 'normal' | 'high';
export type GoalType = 'countdown' | 'time_based' | 'direction';
export type GoalFrequency = 'daily' | 'weekly' | 'none';

export const LIFE_AREAS: Array<{ type: LifeAreaType; label: string; icon: string; color: string }> = [
  { type: 'health', label: '健康', icon: '❤️', color: '#7BC67E' },
  { type: 'work', label: '工作', icon: '💼', color: '#4ECDC4' },
  { type: 'relationships', label: '关系', icon: '💬', color: '#C9B1FF' },
  { type: 'growth', label: '成长', icon: '🌱', color: '#FFD93D' },
  { type: 'leisure', label: '生活', icon: '☁️', color: '#FF8A80' },
  { type: 'creation', label: '创作', icon: '🎨', color: '#FF9EC7' },
  { type: 'other', label: '其他', icon: '📌', color: '#B0BEC5' },
];

export type FutureSelf = {
  id: string;
  identityStatement: string;
  notes: string;
  updatedAt: number;
};

export type Goal = {
  id: string;
  title: string;
  description: string;
  lifeArea: LifeAreaType;
  status: GoalStatus;
  priority: GoalPriority;
  targetDate?: string;
  progress: number;
  goalType: GoalType;
  targetCount?: number;
  targetUnit?: string;
  estimatedTotalMinutes?: number;
  frequency: GoalFrequency;
  weekDays: number[];
  actionTitle?: string;
  actionAmount: number;
  lastDirectionCheckAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type GoalDraft = {
  title: string;
  description?: string;
  lifeArea?: LifeAreaType;
  status?: GoalStatus;
  priority?: GoalPriority;
  targetDate?: string;
  progress?: number;
  goalType?: GoalType;
  targetCount?: number;
  targetUnit?: string;
  estimatedTotalMinutes?: number;
  frequency?: GoalFrequency;
  weekDays?: number[];
  actionTitle?: string;
  actionAmount?: number;
  lastDirectionCheckAt?: number;
};

type GoalRow = {
  id: string;
  title: string;
  description: string | null;
  life_area: string | null;
  status: string | null;
  priority: string | null;
  target_date: string | null;
  progress: number | null;
  goal_type: string | null;
  target_count: number | null;
  target_unit: string | null;
  estimated_total_minutes: number | null;
  frequency: string | null;
  week_days: string | null;
  action_title: string | null;
  action_amount: number | null;
  last_direction_check_at: number | null;
  created_at: number;
  updated_at: number;
};

type FutureSelfRow = {
  id: string;
  identity_statement: string;
  notes: string | null;
  updated_at: number;
};

const LIFE_AREA_TYPES = LIFE_AREAS.map((area) => area.type);
const GOAL_STATUSES: GoalStatus[] = ['active', 'completed', 'paused'];
const GOAL_PRIORITIES: GoalPriority[] = ['low', 'normal', 'high'];
const GOAL_TYPES: GoalType[] = ['countdown', 'time_based', 'direction'];
const GOAL_FREQUENCIES: GoalFrequency[] = ['daily', 'weekly', 'none'];

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeLifeArea(value?: string | null): LifeAreaType {
  return LIFE_AREA_TYPES.includes(value as LifeAreaType) ? (value as LifeAreaType) : 'growth';
}

function normalizeStatus(value?: string | null): GoalStatus {
  return GOAL_STATUSES.includes(value as GoalStatus) ? (value as GoalStatus) : 'active';
}

function normalizePriority(value?: string | null): GoalPriority {
  return GOAL_PRIORITIES.includes(value as GoalPriority) ? (value as GoalPriority) : 'normal';
}

function normalizeProgress(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return 0;
  return Math.max(0, Math.min(100, Math.round(value ?? 0)));
}

function normalizeGoalType(value?: string | null): GoalType {
  return GOAL_TYPES.includes(value as GoalType) ? value as GoalType : 'direction';
}

function normalizeFrequency(value?: string | null): GoalFrequency {
  return GOAL_FREQUENCIES.includes(value as GoalFrequency) ? value as GoalFrequency : 'none';
}

function normalizePositiveNumber(value?: number | null) {
  return Number.isFinite(value ?? NaN) && (value ?? 0) > 0 ? Math.round(value ?? 0) : undefined;
}

function normalizeWeekDays(value?: string | number[] | null) {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = []; }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(Number).map(Math.round).filter((day) => day >= 1 && day <= 7))].sort((a, b) => a - b);
}

export function normalizeGoalDate(value?: string) {
  if (!value) return undefined;
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isFinite(parsed.getTime()) ? dateKey(parsed) : undefined;
}

function fromGoalRow(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    lifeArea: normalizeLifeArea(row.life_area),
    status: normalizeStatus(row.status),
    priority: normalizePriority(row.priority),
    targetDate: normalizeGoalDate(row.target_date ?? undefined),
    progress: normalizeProgress(row.progress),
    goalType: normalizeGoalType(row.goal_type),
    targetCount: normalizePositiveNumber(row.target_count),
    targetUnit: row.target_unit?.trim() || undefined,
    estimatedTotalMinutes: normalizePositiveNumber(row.estimated_total_minutes),
    frequency: normalizeFrequency(row.frequency),
    weekDays: normalizeWeekDays(row.week_days),
    actionTitle: row.action_title?.trim() || undefined,
    actionAmount: normalizePositiveNumber(row.action_amount) ?? 1,
    lastDirectionCheckAt: row.last_direction_check_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getLifeAreaConfig(lifeArea: LifeAreaType) {
  return LIFE_AREAS.find((area) => area.type === lifeArea) ?? LIFE_AREAS[LIFE_AREAS.length - 1];
}

export async function loadFutureSelf(): Promise<FutureSelf | null> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<FutureSelfRow>('SELECT * FROM future_self WHERE id = ?', 'primary');
  if (!row) return null;
  return {
    id: row.id,
    identityStatement: row.identity_statement,
    notes: row.notes ?? '',
    updatedAt: row.updated_at,
  };
}

export async function saveFutureSelf(identityStatement: string, notes = '') {
  const database = await getDatabase();
  const now = Date.now();
  await database.runAsync(
    `INSERT INTO future_self (id, identity_statement, notes, updated_at)
     VALUES ('primary', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       identity_statement = excluded.identity_statement,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
    identityStatement.trim().slice(0, 120),
    notes.trim().slice(0, 600),
    now,
  );
}

export async function createGoal(draft: GoalDraft) {
  const database = await getDatabase();
  const now = Date.now();
  const goal: Goal = {
    id: makeId('goal'),
    title: draft.title.trim().slice(0, 80),
    description: (draft.description ?? '').trim().slice(0, 600),
    lifeArea: normalizeLifeArea(draft.lifeArea),
    status: normalizeStatus(draft.status),
    priority: normalizePriority(draft.priority),
    targetDate: normalizeGoalDate(draft.targetDate),
    progress: normalizeProgress(draft.progress),
    goalType: normalizeGoalType(draft.goalType),
    targetCount: normalizePositiveNumber(draft.targetCount),
    targetUnit: draft.targetUnit?.trim().slice(0, 20) || undefined,
    estimatedTotalMinutes: normalizePositiveNumber(draft.estimatedTotalMinutes),
    frequency: normalizeFrequency(draft.frequency),
    weekDays: normalizeWeekDays(draft.weekDays),
    actionTitle: draft.actionTitle?.trim().slice(0, 80) || undefined,
    actionAmount: normalizePositiveNumber(draft.actionAmount) ?? 1,
    lastDirectionCheckAt: draft.lastDirectionCheckAt,
    createdAt: now,
    updatedAt: now,
  };
  await database.runAsync(
    `INSERT INTO goal_items
      (id, title, description, life_area, status, priority, target_date, progress, goal_type, target_count, target_unit, estimated_total_minutes, frequency, week_days, action_title, action_amount, last_direction_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    goal.id,
    goal.title,
    goal.description,
    goal.lifeArea,
    goal.status,
    goal.priority,
    goal.targetDate ?? null,
    goal.progress,
    goal.goalType,
    goal.targetCount ?? null,
    goal.targetUnit ?? null,
    goal.estimatedTotalMinutes ?? null,
    goal.frequency,
    JSON.stringify(goal.weekDays),
    goal.actionTitle ?? null,
    goal.actionAmount,
    goal.lastDirectionCheckAt ?? null,
    goal.createdAt,
    goal.updatedAt,
  );
  return goal;
}

export async function updateGoal(goalId: string, patch: Partial<GoalDraft>) {
  const database = await getDatabase();
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null) => {
    updates.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.title !== undefined) add('title', patch.title.trim().slice(0, 80));
  if (patch.description !== undefined) add('description', patch.description.trim().slice(0, 600));
  if (patch.lifeArea !== undefined) add('life_area', normalizeLifeArea(patch.lifeArea));
  if (patch.status !== undefined) add('status', normalizeStatus(patch.status));
  if (patch.priority !== undefined) add('priority', normalizePriority(patch.priority));
  if (patch.targetDate !== undefined) add('target_date', normalizeGoalDate(patch.targetDate) ?? null);
  if (patch.progress !== undefined) add('progress', normalizeProgress(patch.progress));
  if (patch.goalType !== undefined) add('goal_type', normalizeGoalType(patch.goalType));
  if (patch.targetCount !== undefined) add('target_count', normalizePositiveNumber(patch.targetCount) ?? null);
  if (patch.targetUnit !== undefined) add('target_unit', patch.targetUnit.trim().slice(0, 20) || null);
  if (patch.estimatedTotalMinutes !== undefined) add('estimated_total_minutes', normalizePositiveNumber(patch.estimatedTotalMinutes) ?? null);
  if (patch.frequency !== undefined) add('frequency', normalizeFrequency(patch.frequency));
  if (patch.weekDays !== undefined) add('week_days', JSON.stringify(normalizeWeekDays(patch.weekDays)));
  if (patch.actionTitle !== undefined) add('action_title', patch.actionTitle.trim().slice(0, 80) || null);
  if (patch.actionAmount !== undefined) add('action_amount', normalizePositiveNumber(patch.actionAmount) ?? 1);
  if (patch.lastDirectionCheckAt !== undefined) add('last_direction_check_at', patch.lastDirectionCheckAt || null);
  if (!updates.length) return;

  add('updated_at', Date.now());
  await database.runAsync(`UPDATE goal_items SET ${updates.join(', ')} WHERE id = ?`, ...values, goalId);
}

export async function loadGoals(includeArchived = false) {
  const database = await getDatabase();
  const statusClause = includeArchived ? "status IN ('active', 'paused', 'completed')" : "status IN ('active', 'paused')";
  const rows = await database.getAllAsync<GoalRow>(
    `SELECT * FROM goal_items
     WHERE ${statusClause}
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
       CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
       updated_at DESC`,
  );
  return rows.map(fromGoalRow);
}

export async function loadGoal(goalId: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<GoalRow>('SELECT * FROM goal_items WHERE id = ?', goalId);
  return row ? fromGoalRow(row) : null;
}
