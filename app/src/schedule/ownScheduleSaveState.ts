import type { DayPlanEntry } from './dayPlan';
import type { ScheduleReadingChoice, ScheduleReadingChoiceValue } from './scheduleStore';
export type ScheduleDurationIntent = { minutes?: number; changeStart: boolean; planningStartAt?: number; planningEndAt?: number };
export type ScheduleSaveConflict = { startAt: number; endAt: number; title: string; conflictStartAt: number; conflictEndAt: number; kind?: 'sleep' };

function normalizeScheduleDurationIntent(raw: unknown): ScheduleDurationIntent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const v = raw as ScheduleDurationIntent;
  if (Object.keys(v).some(k => !['minutes', 'changeStart', 'planningStartAt', 'planningEndAt'].includes(k))
    || typeof v.changeStart !== 'boolean' || v.minutes !== undefined && (!Number.isSafeInteger(v.minutes) || v.minutes <= 0)
    || [v.planningStartAt, v.planningEndAt].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > 8.64e15))) return;
  return { ...v };
}

export type OwnedDayPlanOwner = 'I' | 'I 和 you';
export type OwnedDayPlanInputEntry = {
  id: string | null; title: string; startAt?: number; endAt?: number; minutes?: number; owner: OwnedDayPlanOwner;
  readingId?: string | null; habitId?: string | null;
  localId?: string; continueFrom?: string; nextReadingId?: string | null;
};
export type OwnedDayPlanEntry = DayPlanEntry & {
  owned: true; owner: OwnedDayPlanOwner; readingId: string | null; habitId?: string | null;
  preparationError?: string; sourcePlanVersion?: number;
  duration?: ScheduleDurationIntent;
  conflict?: ScheduleSaveConflict;
  readingChoice?: ScheduleReadingChoice;
  choiceUpdate?: ScheduleReadingChoiceValue;
  choiceExpectedVersion?: number;
  choiceSourcePlanVersion?: number;
  choiceDependencyIds?: string[];
  choiceError?: string;
};
export type OwnedDayPlanBatch = { opId: string; allowedOwners: OwnedDayPlanOwner[]; entries: OwnedDayPlanEntry[]; readingLabels?: Record<string, string> };
export function ownScheduleEntryIsFinal(entry: OwnedDayPlanEntry) {
  return !!entry.preparationError || ['schedule-duration-ended', 'schedule-duration-cancelled',
    'schedule-time-conflict', 'day-plan-outside-range', 'schedule-source-changed', 'schedule-owner-forbidden',
    'invalid-day-plan-time', 'schedule-target-changed', 'reading-choice-source-changed', 'reading-choice-dependency-failed'].includes(entry.error ?? '');
}
export type OwnScheduleSave = {
  version: 1; dataEpoch: number; batch: OwnedDayPlanBatch; attempts: number;
  stage: 'pending' | 'complete' | 'failed' | 'unknown'; updatedAt: number;
  source?: { sessionId: string; messageId: string; revision: string;
    readingSources?: Array<{ messageId: string; readingId: string; revision: string }> };
};

export function normalizeOwnScheduleSave(raw: unknown): OwnScheduleSave | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as OwnScheduleSave;
  const only = (record: object, keys: string[]) => Object.keys(record).every(key => keys.includes(key));
  const timestamp = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  const entryKeys = ['id', 'action', 'title', 'notes', 'occurrenceId', 'todoId', 'startAt', 'endAt',
    'startSuggested', 'endSuggested', 'reminderMinutesBefore', 'companionEnabled', 'sourceUpdatedAt',
    'sourceTodoUpdatedAt', 'targetScheduleId', 'targetTodoId', 'saved', 'scheduleSaved', 'error',
    'owned', 'owner', 'readingId', 'habitId', 'preparationError', 'sourcePlanVersion', 'duration', 'conflict',
    'readingChoice', 'choiceUpdate', 'choiceExpectedVersion', 'choiceSourcePlanVersion', 'choiceDependencyIds', 'choiceError'];
  if (value.version !== 1 || !Number.isSafeInteger(value.dataEpoch) || value.dataEpoch < 0
    || !Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > 4
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || !['pending', 'complete', 'failed', 'unknown'].includes(value.stage)
    || !only(value, ['version', 'dataEpoch', 'batch', 'attempts', 'stage', 'updatedAt', 'source'])
    || value.source !== undefined && (!value.source || !only(value.source, ['sessionId', 'messageId', 'revision', 'readingSources'])
      || [value.source.sessionId, value.source.messageId, value.source.revision].some(v => typeof v !== 'string' || !v || v.length > 512)
      || value.source.readingSources !== undefined && (!Array.isArray(value.source.readingSources)
        || value.source.readingSources.some(ref => !ref || typeof ref !== 'object' || Array.isArray(ref)
          || !only(ref, ['messageId', 'readingId', 'revision'])
          || [ref.messageId, ref.readingId, ref.revision].some(v => typeof v !== 'string' || !v || v.length > 512))
        || new Set(value.source.readingSources.map(ref => ref.messageId)).size !== value.source.readingSources.length))
    || !value.batch || !only(value.batch, ['opId', 'allowedOwners', 'entries', 'readingLabels'])
    || value.batch.readingLabels !== undefined && (!value.batch.readingLabels || typeof value.batch.readingLabels !== 'object'
      || Array.isArray(value.batch.readingLabels) || Object.entries(value.batch.readingLabels).some(([key, id]) => !/^r[1-9]\d*$/.test(key) || typeof id !== 'string' || !id))
    || typeof value.batch.opId !== 'string' || !value.batch.opId || value.batch.opId.length > 120
    || !Array.isArray(value.batch.allowedOwners) || value.batch.allowedOwners.some(owner => owner !== 'I' && owner !== 'I 和 you')
    || !Array.isArray(value.batch.entries)
    || value.batch.entries.some(entry => !entry || !only(entry, entryKeys) || entry.owned !== true || typeof entry.id !== 'string' || !entry.id
      || typeof entry.targetScheduleId !== 'string' || !entry.targetScheduleId || typeof entry.targetTodoId !== 'string'
      || typeof entry.title !== 'string' || typeof entry.notes !== 'string' || !['schedule', 'cancel'].includes(entry.action)
      || ['startSuggested', 'endSuggested', 'companionEnabled'].some(key => typeof entry[key as keyof OwnedDayPlanEntry] !== 'boolean')
      || ['startAt', 'endAt', 'sourceUpdatedAt', 'sourceTodoUpdatedAt', 'sourcePlanVersion'].some(key => entry[key as keyof OwnedDayPlanEntry] !== undefined && !timestamp(entry[key as keyof OwnedDayPlanEntry]))
      || !Number.isFinite(entry.reminderMinutesBefore) || entry.reminderMinutesBefore < 0
      || entry.duration !== undefined && !normalizeScheduleDurationIntent(entry.duration)
      || entry.readingChoice !== undefined && !validReadingChoice(entry.readingChoice)
      || entry.choiceUpdate !== undefined && (!validReadingChoice(entry.choiceUpdate) || !('version' in entry.choiceUpdate))
      || [entry.choiceExpectedVersion, entry.choiceSourcePlanVersion].some(n => n !== undefined && !timestamp(n))
      || entry.choiceDependencyIds !== undefined && (!Array.isArray(entry.choiceDependencyIds) || entry.choiceDependencyIds.some(id => typeof id !== 'string' || !id))
      || entry.choiceError !== undefined && typeof entry.choiceError !== 'string'
      || entry.conflict !== undefined && (!entry.conflict || typeof entry.conflict !== 'object' || Array.isArray(entry.conflict)
        || !only(entry.conflict, ['startAt', 'endAt', 'title', 'conflictStartAt', 'conflictEndAt', 'kind'])
        || entry.conflict.kind !== undefined && entry.conflict.kind !== 'sleep'
        || typeof entry.conflict.title !== 'string' || [entry.conflict.startAt, entry.conflict.endAt, entry.conflict.conflictStartAt, entry.conflict.conflictEndAt].some(n => !timestamp(n) || n > 8.64e15))
      || !entry.preparationError && entry.readingId !== null && typeof entry.readingId !== 'string'
      || !value.batch.allowedOwners.includes(entry.owner))) return;
  return JSON.parse(JSON.stringify(value)) as OwnScheduleSave;
}

function validReadingChoice(raw: unknown): raw is ScheduleReadingChoice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const v = raw as ScheduleReadingChoiceValue;
  if (typeof v.sourceId !== 'string' || !v.sourceId || v.sourceId.length > 512) return false;
  if (!('version' in v)) return Object.keys(v).length === 1;
  return Object.keys(v).every(k => ['sourceId', 'version', 'currentReadingId', 'nextReadingId', 'operationId'].includes(k))
    && Number.isSafeInteger(v.version) && v.version >= 0 && typeof v.operationId === 'string' && !!v.operationId
    && [v.currentReadingId, v.nextReadingId].every(id => id === null || typeof id === 'string' && !!id && id.length <= 256);
}

export function mergeOwnScheduleSaves(left: OwnScheduleSave | undefined, right: OwnScheduleSave | undefined): OwnScheduleSave | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.batch.opId !== right.batch.opId || left.dataEpoch !== right.dataEpoch) throw new Error('schedule-save-source-changed');
  if (left.source && right.source && (left.source.sessionId !== right.source.sessionId
    || left.source.messageId !== right.source.messageId || left.source.revision !== right.source.revision)) {
    throw new Error('schedule-save-source-changed');
  }
  const selected = left.updatedAt > right.updatedAt ? left : right;
  const source = left.source ?? right.source;
  const aSources = left.source?.readingSources, bSources = right.source?.readingSources;
  const sourceKey = (refs: NonNullable<OwnScheduleSave['source']>['readingSources']) =>
    JSON.stringify(refs?.map(ref => [ref.messageId, ref.readingId, ref.revision]).sort((a, b) => a[0].localeCompare(b[0])));
  if (aSources && bSources && sourceKey(aSources) !== sourceKey(bSources)) throw new Error('schedule-save-source-changed');
  const mergedSource = source && { ...source, ...(aSources || bSources ? { readingSources: aSources ?? bSources } : {}) };
  const entries = selected.batch.entries.map(entry => {
    const a = left.batch.entries.find(value => value.id === entry.id);
    const b = right.batch.entries.find(value => value.id === entry.id);
    const saved = a?.saved || b?.saved;
    const savedDuration = a?.saved && a.duration ? a : b?.saved && b.duration ? b : undefined;
    const choiceFields: Partial<OwnedDayPlanEntry> = {};
    for (const key of ['readingChoice', 'choiceUpdate', 'choiceExpectedVersion', 'choiceSourcePlanVersion', 'choiceDependencyIds', 'choiceError'] as const) {
      const value = entry[key] ?? a?.[key] ?? b?.[key];
      if (value !== undefined) Object.assign(choiceFields, { [key]: value });
    }
    return { ...entry, ...choiceFields, ...(savedDuration ?? {}), ...(a?.duration || b?.duration ? { duration: entry.duration ?? a?.duration ?? b?.duration } : {}),
      ...(saved ? { saved: true, scheduleSaved: true, error: undefined } : {}) };
  });
  const complete = entries.every(entry => entry.saved);
  return { ...selected, ...(mergedSource ? { source: mergedSource } : {}), attempts: Math.max(left.attempts, right.attempts),
    stage: complete ? 'complete' : left.stage === 'failed' || right.stage === 'failed' ? 'failed' : selected.stage,
    batch: { ...selected.batch, ...(left.batch.readingLabels || right.batch.readingLabels
      ? { readingLabels: selected.batch.readingLabels ?? left.batch.readingLabels ?? right.batch.readingLabels } : {}), entries } };
}
