import { loadDayTemplate, runUserRoutineWrite, type DayTemplate } from './dayTemplate';
import { getScheduleDatabase } from './scheduleDatabase';
import { runScheduleSemanticCaptureExclusive } from '../sync/syncScheduleSemanticCaptureQueue';
import { USER_ROUTINE_KINDS, USER_ROUTINE_TITLES, routineTimeAt, usualRoutineItems, type UserRoutineKind } from './userRoutinePolicy';

export type DayTemplateInstanceKind = UserRoutineKind;
export type DayTemplateInstanceStatus = 'pending' | 'completed';
export type DayTemplateInstance = {
  id: string; dateKey: string; kind: DayTemplateInstanceKind; title: string;
  startAt?: number; endAt?: number; status: DayTemplateInstanceStatus; completedAt?: number;
  templateHash: string; source: 'usual' | 'day'; enabled: boolean; operationId?: string;
  createdAt: number; updatedAt: number;
};
export type DayTemplateInstanceRow = {
  id: string; date_key: string; kind: DayTemplateInstanceKind; title: string; start_at: number | null; end_at: number | null;
  status: DayTemplateInstanceStatus; completed_at: number | null; template_hash: string;
  source?: 'usual' | 'day'; enabled?: number; operation_id?: string | null; created_at: number; updated_at: number;
};
export function dayTemplateInstanceFromRow(row: DayTemplateInstanceRow): DayTemplateInstance {
  return { id: row.id, dateKey: row.date_key, kind: row.kind, title: row.title,
    ...(row.start_at != null ? { startAt: row.start_at } : {}), ...(row.end_at != null ? { endAt: row.end_at } : {}),
    status: row.status, ...(row.completed_at != null ? { completedAt: row.completed_at } : {}), templateHash: row.template_hash,
    source: row.source ?? 'usual', enabled: row.enabled !== 0, ...(row.operation_id ? { operationId: row.operation_id } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export function buildDayTemplateInstances(day: string, template: DayTemplate, now = Date.now(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): DayTemplateInstance[] {
  if (!template.enabled) return [];
  const items = usualRoutineItems(template);
  return USER_ROUTINE_KINDS.flatMap(kind => {
    const item = items[kind];
    if (!item?.enabled || !item.time) return [];
    const startAt = routineTimeAt(day, item.time, timeZone,
      kind === 'sleep' && !!template.wakeTime && item.time <= template.wakeTime);
    return [{ id: `${day}:${kind}`, dateKey: day, kind, title: USER_ROUTINE_TITLES[kind], startAt,
      ...(item.minutes ? { endAt: startAt + item.minutes * 60000 } : {}), status: 'pending' as const,
      templateHash: JSON.stringify(template), source: 'usual' as const, enabled: true,
      ...(template.operationId ? { operationId: template.operationId } : {}), createdAt: now, updatedAt: now }];
  });
}

export async function loadStoredDayTemplateInstances(day: string): Promise<DayTemplateInstance[]> {
  const database = await getScheduleDatabase();
  return (await database.getAllAsync<DayTemplateInstanceRow>('SELECT * FROM day_template_instances WHERE date_key = ? ORDER BY start_at ASC', day)).map(dayTemplateInstanceFromRow);
}

/** Explicit page materialization only; model query paths never call this. */
export async function ensureDayTemplateInstances(day: string) {
  return runUserRoutineWrite(async () => {
    const database = await getScheduleDatabase(), template = await loadDayTemplate(), now = Date.now();
    const definitions = buildDayTemplateInstances(day, template, now);
    // Expo opens a separate connection here; serialize with occurrence materialization.
    await runScheduleSemanticCaptureExclusive(() => database.withExclusiveTransactionAsync(async transaction => {
      const rows = (await transaction.getAllAsync<DayTemplateInstanceRow>('SELECT * FROM day_template_instances WHERE date_key = ?', day)).map(dayTemplateInstanceFromRow);
      for (const item of definitions) {
        const previous = rows.find(row => row.kind === item.kind);
        if (previous && (previous.source === 'day' || previous.status === 'completed' || (previous.startAt ?? Infinity) < now)) continue;
        if (previous?.enabled && previous.templateHash === item.templateHash && previous.startAt === item.startAt && previous.endAt === item.endAt) continue;
        if (item.startAt! < now) continue;
        await transaction.runAsync(`INSERT INTO day_template_instances
          (id,date_key,kind,title,start_at,end_at,status,template_hash,source,enabled,operation_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'pending',?,'usual',1,?,?,?)
          ON CONFLICT(date_key,kind) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,
            template_hash=excluded.template_hash,enabled=1,operation_id=excluded.operation_id,updated_at=excluded.updated_at`,
        item.id, day, item.kind, item.title, item.startAt!, item.endAt ?? null, item.templateHash, item.operationId ?? null, previous?.createdAt ?? now, now);
      }
      for (const row of rows) {
        if (row.source === 'usual' && row.enabled && row.status === 'pending' && (row.startAt ?? Infinity) >= now && !definitions.some(item => item.kind === row.kind)) {
          await transaction.runAsync('UPDATE day_template_instances SET enabled=0, updated_at=? WHERE id=?', now, row.id);
        }
      }
    }));
    return loadStoredDayTemplateInstances(day);
  });
}

export async function loadDayTemplateInstances(day: string, ensure = true): Promise<DayTemplateInstance[]> {
  if (ensure) {
    const previous = new Date(`${day}T12:00:00`); previous.setDate(previous.getDate() - 1);
    const previousDay = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-${String(previous.getDate()).padStart(2, '0')}`;
    await ensureDayTemplateInstances(previousDay);
    await ensureDayTemplateInstances(day);
  }
  const template = await loadDayTemplate(), now = Date.now();
  const start = new Date(`${day}T00:00:00`), end = new Date(start); end.setDate(end.getDate() + 1);
  const database = await getScheduleDatabase();
  const rows = await database.getAllAsync<DayTemplateInstanceRow>('SELECT * FROM day_template_instances WHERE start_at >= ? AND start_at < ? ORDER BY start_at ASC', start.getTime(), end.getTime());
  return rows.map(dayTemplateInstanceFromRow).filter(item => item.status === 'completed'
    || item.startAt !== undefined && item.startAt < now
    || item.enabled && (item.source === 'day' || template.enabled));
}

export async function toggleDayTemplateInstance(instanceId: string) {
  return runUserRoutineWrite(async () => {
    const database = await getScheduleDatabase();
    const row = await database.getFirstAsync<DayTemplateInstanceRow>('SELECT * FROM day_template_instances WHERE id = ?', instanceId);
    if (!row) return null;
    const complete = row.status !== 'completed', now = Date.now();
    await database.runAsync('UPDATE day_template_instances SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?', complete ? 'completed' : 'pending', complete ? now : null, now, instanceId);
    return { ...dayTemplateInstanceFromRow(row), status: complete ? 'completed' as const : 'pending' as const, completedAt: complete ? now : undefined, updatedAt: now };
  });
}

export async function loadDayTemplateCompletionsForDate(day: string) {
  const database = await getScheduleDatabase();
  const start = new Date(`${day}T00:00:00`), end = new Date(start); end.setDate(end.getDate() + 1);
  return (await database.getAllAsync<DayTemplateInstanceRow>('SELECT * FROM day_template_instances WHERE completed_at >= ? AND completed_at < ? ORDER BY completed_at ASC', start.getTime(), end.getTime())).map(dayTemplateInstanceFromRow);
}

/** Only explicit data-reset callers; disabling the template never invokes this. */
export async function clearDayTemplateInstances() {
  await runUserRoutineWrite(async () => { await (await getScheduleDatabase()).runAsync('DELETE FROM day_template_instances'); });
}
