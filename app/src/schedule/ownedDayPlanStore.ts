import { isDayPlanSchedulePersisted, prepareDayPlanEntry, saveDayPlanEntries } from './dayPlanStore';
import { ensureScheduleHorizon, loadScheduleItemById, schedulePlanVersion, scheduleOwnersOverlap, loadOwnedScheduleItems } from './scheduleStore';
import type { ScheduleItem, ScheduleReadingChoiceValue } from './scheduleStore';
import { scheduleOccupiedInterval, type ScheduleSaveContext, type ScheduleSaveConflict } from './scheduleDurationPolicy';

import type { OwnedDayPlanOwner, OwnedDayPlanInputEntry, OwnedDayPlanEntry, OwnedDayPlanBatch } from './ownScheduleSaveState';
import { ownScheduleEntryIsFinal } from './ownScheduleSaveState';
export type { OwnedDayPlanOwner, OwnedDayPlanInputEntry, OwnedDayPlanEntry, OwnedDayPlanBatch } from './ownScheduleSaveState';
const savingAdjustments = new Map<string, number>();
export const isOwnScheduleAdjustmentInFlight = (itemId: string) => (savingAdjustments.get(itemId) ?? 0) > 0;

/** A reference is resolved from its durable source, including a cancelled source slot. */
export async function loadOwnReadingChoice(item: ScheduleItem): Promise<{ root: ScheduleItem; choice: ScheduleReadingChoiceValue } | null> {
  if (item.owner !== 'I') return null;
  const sourceId = item.execution?.readingChoice?.sourceId ?? item.id;
  const root = sourceId === item.id ? item : await loadScheduleItemById(sourceId);
  if (!root || root.owner !== 'I') return null;
  const stored = root.execution?.readingChoice;
  if (stored && stored.sourceId !== root.id) return null;
  if (stored && 'version' in stored) return { root, choice: stored };
  return root.readingId ? { root, choice: { sourceId: root.id, version: 0, currentReadingId: root.readingId,
    nextReadingId: null, operationId: `legacy:${root.id}` } } : null;
}

export async function prepareOwnedDayPlanBatch(input: {
  opId: string;
  entries: OwnedDayPlanInputEntry[];
  cancelIds: string[];
  allowedOwners: OwnedDayPlanOwner[];
  expectedVersions: Record<string, number>;
  readingLabels?: Record<string, string>;
  expectedChoiceVersions?: Record<string, number>;
  readingAvailability?: Record<string, { ready: boolean; title: string; reachedEnd?: boolean }>;
  planningStartAt?: number; planningEndAt?: number;
}): Promise<OwnedDayPlanBatch> {
  if (!input.opId || input.opId.length > 120) throw new Error('invalid-day-plan-operation');
  await ensureScheduleHorizon();
  const entries: OwnedDayPlanEntry[] = [];
  const seen = new Set<string>();
  const inputs = [
    ...input.entries.map((entry) => ({ entry, cancel: false })),
    ...input.cancelIds.map((id) => ({ entry: { id } as OwnedDayPlanInputEntry, cancel: true })),
  ];
  for (const [index, { entry, cancel }] of inputs.entries()) {
    const targetScheduleId = entry.id ?? `owned-${input.opId}-${index}`;
    let prepared: OwnedDayPlanEntry = {
      id: `${input.opId}:${index}`, action: cancel ? 'cancel' : 'schedule', title: entry.title ?? '', notes: '',
      startAt: entry.startAt, endAt: entry.endAt, startSuggested: false, endSuggested: false,
      reminderMinutesBefore: 0, companionEnabled: false, targetScheduleId, targetTodoId: targetScheduleId,
      // A rejected cancellation still needs a valid request-scope receipt. It never
      // grants ownership: the loaded target is checked below before any write.
      owned: true, owner: cancel ? input.allowedOwners[0] : entry.owner, readingId: entry.readingId ?? null,
    };
    try {
      if (seen.has(targetScheduleId)) throw new Error('duplicate-schedule-target');
      seen.add(targetScheduleId);
      const item = entry.id ? await loadScheduleItemById(entry.id) : null;
      if (entry.id && !item) throw new Error('schedule-target-unavailable');
      if (item) prepared = { ...prepared, sourcePlanVersion: schedulePlanVersion(item),
        ...(cancel ? { title: item.title, startAt: item.startAt, endAt: item.endAt, readingId: item.readingId ?? null } : {}) };
      const minuteInput = !cancel && entry.endAt === undefined;
      if (minuteInput && item?.status === 'cancelled') throw new Error('schedule-duration-cancelled');
      if (minuteInput && (item?.status === 'completed' || item?.execution?.status === 'completed'
        || item?.execution?.status === 'ended' && (entry.minutes !== undefined || entry.startAt === undefined || entry.startAt === item.startAt))) throw new Error('schedule-duration-ended');
      const owner = cancel ? item?.owner : entry.owner;
      if ((owner !== 'I' && owner !== 'I 和 you') || !input.allowedOwners.includes(owner)
        || (item && (item.owner ?? 'you') !== owner)) throw new Error('schedule-owner-forbidden');
      if (item && (item.recurrence !== 'none' || item.status !== 'pending'
        || (input.expectedVersions[item.id] !== item.updatedAt
          && input.expectedVersions[item.id] !== schedulePlanVersion(item)))) throw new Error('schedule-target-changed');
      if (!cancel && entry.readingId !== undefined && entry.readingId !== null && (typeof entry.readingId !== 'string' || !entry.readingId || entry.readingId.length > 256)) throw new Error('invalid-reading-reference');
      if (entry.habitId !== undefined && entry.habitId !== null
        && (typeof entry.habitId !== 'string' || !entry.habitId || entry.habitId.length > 256)) throw new Error('invalid-habit-reference');
      const startAt = entry.startAt ?? item?.startAt;
      const remainder = item ? Math.max(0, (item.execution?.totalPlannedMs ?? ((item.endAt ?? item.startAt) - item.startAt)) - (item.execution?.elapsedMs ?? 0)) : 0;
      const endAt = minuteInput ? item?.endAt ?? (startAt ?? 0) + (entry.minutes ?? 0) * 60_000 : entry.endAt;
      if (!cancel && (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt)
        || startAt! < 0 || endAt! <= startAt! && !minuteInput || typeof entry.title !== 'string' || !entry.title.trim()
        || minuteInput && (!item && (entry.startAt === undefined || entry.minutes === undefined)
          || entry.minutes !== undefined && (!Number.isSafeInteger(entry.minutes) || entry.minutes <= 0)
          || entry.minutes === undefined && remainder <= 0))) {
        throw new Error('invalid-day-plan-time');
      }
      const base = await prepareDayPlanEntry({
        owned: true, owner,
        id: prepared.id, action: prepared.action, occurrenceId: item ? `${item.id}:${item.startAt}` : undefined,
        title: cancel ? item!.title : entry.title, notes: item?.notes ?? '',
        startAt: cancel ? item!.startAt : startAt, endAt: cancel ? item!.endAt : minuteInput && endAt! <= startAt! ? startAt! + (entry.minutes === undefined ? remainder : entry.minutes * 60_000) : endAt,
        reminderMinutesBefore: item?.reminderMinutesBefore ?? 0, companionEnabled: false,
      });
      if (item && base.sourceUpdatedAt !== item.updatedAt) throw new Error('schedule-target-changed');
      prepared = { ...base, targetScheduleId, targetTodoId: targetScheduleId, owned: true, owner,
        ...(item ? { sourcePlanVersion: schedulePlanVersion(item) } : {}),
        ...(minuteInput ? { duration: { changeStart: !item || entry.startAt !== undefined && entry.startAt !== item.startAt,
          ...(entry.minutes === undefined ? {} : { minutes: entry.minutes }),
          ...(input.planningStartAt === undefined ? {} : { planningStartAt: input.planningStartAt }),
          ...(input.planningEndAt === undefined ? {} : { planningEndAt: input.planningEndAt }) } } : {}),
        readingId: cancel ? item?.readingId ?? null : entry.readingId === undefined ? item?.readingId ?? null : entry.readingId,
        habitId: entry.habitId === undefined ? item?.habitId : entry.habitId };
    } catch (error) {
      prepared.error = prepared.preparationError = error instanceof Error ? error.message : 'day-plan-prepare-failed';
    }
    entries.push(prepared);
  }
  const labels: Record<string, string> = { ...input.readingLabels };
  const duplicateLabels = new Set<string>();
  for (const [index, entry] of input.entries.entries()) if (entry.localId !== undefined) {
    if (!/^r[1-9]\d*$/.test(entry.localId)) entries[index].preparationError = entries[index].error = 'invalid-reading-label';
    else if (labels[entry.localId]) duplicateLabels.add(entry.localId);
    else labels[entry.localId] = entries[index].targetScheduleId;
  }
  const resolving = new Set<string>();
  const resolved = new Map<string, ScheduleReadingChoiceValue>();
  const rootWriters = new Map<string, string>();
  const fail = (entry: OwnedDayPlanEntry, error: string) => { entry.preparationError = entry.error = error; };
  const ready = (id: string) => input.readingAvailability?.[id]?.ready === true;
  const continuationReading = (choice: ScheduleReadingChoiceValue) => choice.currentReadingId && ready(choice.currentReadingId)
    ? choice.currentReadingId : choice.currentReadingId && input.readingAvailability?.[choice.currentReadingId]?.reachedEnd === true
      && choice.nextReadingId && ready(choice.nextReadingId) ? choice.nextReadingId : null;
  const unavailable = (id: string) => `《${input.readingAvailability?.[id]?.title ?? id}》的阅读材料尚未备好，这次接续还没保存。`;
  const resolve = async (targetId: string): Promise<ScheduleReadingChoiceValue> => {
    const cached = resolved.get(targetId);
    if (cached) return cached;
    if (resolving.has(targetId)) throw new Error('reading-choice-cycle');
    const index = entries.findIndex(e => e.targetScheduleId === targetId);
    const entry = index >= 0 ? entries[index] : undefined;
    const original = index >= 0 ? input.entries[index] : undefined;
    if (entry?.preparationError) throw new Error(entry.preparationError);
    const item = await loadScheduleItemById(targetId);
    const prior = item ? await loadOwnReadingChoice(item) : null;
    if (!entry || entry.action === 'cancel') {
      if (!prior || !continuationReading(prior.choice)) throw new Error('invalid-reading-reference');
      if (input.expectedChoiceVersions?.[prior.root.id] !== undefined
        && input.expectedChoiceVersions[prior.root.id] !== prior.choice.version) throw new Error('reading-choice-source-changed');
      resolved.set(targetId, prior.choice); return prior.choice;
    }
    if (entry.owner !== 'I') throw new Error('schedule-owner-forbidden');
    resolving.add(targetId);
    try {
      if (original?.localId && duplicateLabels.has(original.localId)) throw new Error(`标签 ${original.localId} 对应了不止一项安排，无法确定要接着哪项做，这次接续还没保存。`);
      if (original?.continueFrom !== undefined) {
        if (original.readingId !== undefined || original.nextReadingId !== undefined) throw new Error('接着已有安排做和重新选择内容，只能填写一种。这次接续还没保存。');
        const label = original.continueFrom;
        if (duplicateLabels.has(label)) throw new Error(`标签 ${label} 对应了不止一项安排，无法确定要接着哪项做，这次接续还没保存。`);
        if (!labels[label]) throw new Error(`找不到标签 ${label} 对应的安排，这次接续还没保存。`);
        if (labels[label] === targetId) throw new Error('reading-choice-cycle');
        const choice = await resolve(labels[label]);
        const readingId = continuationReading(choice);
        if (!readingId) throw new Error('invalid-reading-reference');
        const sourceEntry = entries.find(e => e.targetScheduleId === labels[label]);
        entry.readingId = readingId;
        entry.readingChoice = { sourceId: choice.sourceId };
        entry.choiceExpectedVersion = choice.version;
        const writer = rootWriters.get(choice.sourceId);
        const dependencies = [...new Set([sourceEntry?.id, writer].filter((id): id is string => !!id && id !== entry.id))];
        if (dependencies.length) entry.choiceDependencyIds = dependencies;
        if (choice.version === 0) {
          const root = await loadScheduleItemById(choice.sourceId);
          if (!root) throw new Error('reading-choice-source-changed');
          entry.choiceUpdate = { ...choice, version: 1, operationId: entry.id };
          entry.choiceSourcePlanVersion = schedulePlanVersion(root);
          resolved.set(choice.sourceId, entry.choiceUpdate);
          rootWriters.set(choice.sourceId, entry.id);
        }
        resolved.set(targetId, entry.choiceUpdate ?? choice);
        return entry.choiceUpdate ?? choice;
      }
      const currentReadingId = original?.readingId === undefined ? prior?.choice.currentReadingId ?? entry.readingId : original.readingId;
      if (!currentReadingId) throw new Error('invalid-reading-reference');
      if (prior && input.expectedChoiceVersions?.[prior.root.id] !== undefined
        && input.expectedChoiceVersions[prior.root.id] !== prior.choice.version) throw new Error('reading-choice-source-changed');
      let nextReadingId = original?.nextReadingId === undefined ? prior?.choice.nextReadingId ?? null : original.nextReadingId;
      if (nextReadingId !== null && !ready(nextReadingId)) {
        entry.choiceError = unavailable(nextReadingId);
        nextReadingId = prior?.choice.nextReadingId ?? null;
      }
      if (nextReadingId === currentReadingId) nextReadingId = null;
      const sourceId = prior?.root.id ?? targetId;
      const previousVersion = prior?.choice.version ?? 0;
      const choice = { sourceId, version: previousVersion + 1, currentReadingId, nextReadingId, operationId: entry.id };
      const writer = rootWriters.get(sourceId);
      if (writer && writer !== entry.id) throw new Error('duplicate-reading-choice-target');
      rootWriters.set(sourceId, entry.id);
      entry.choiceExpectedVersion = previousVersion;
      entry.choiceSourcePlanVersion = prior ? schedulePlanVersion(prior.root) : undefined;
      entry.readingId = currentReadingId;
      entry.readingChoice = sourceId === targetId ? choice : { sourceId };
      if (sourceId !== targetId) entry.choiceUpdate = choice;
      resolved.set(targetId, choice); return choice;
    } finally { resolving.delete(targetId); }
  };
  for (const [index, original] of input.entries.entries()) {
    const entry = entries[index];
    if (entry.preparationError) continue;
    const item = original.id ? await loadScheduleItemById(original.id) : null;
    if (original.localId === undefined && original.continueFrom === undefined && original.nextReadingId === undefined
      && !item?.execution?.readingChoice) continue; // Already-parsed legacy batches keep their contract.
    try { await resolve(entry.targetScheduleId); } catch (error) { fail(entry, error instanceof Error ? error.message : 'day-plan-prepare-failed'); }
    if (entry.readingChoice && item && entry.duration && !entry.duration.changeStart && entry.duration.minutes === undefined) {
      delete entry.duration; // Selection-only saves do not settle/regrant the running duration.
      entry.startAt = item.startAt; entry.endAt = item.endAt;
    }
  }
  return { opId: input.opId, allowedOwners: [...input.allowedOwners], entries,
    ...(Object.keys(labels).length ? { readingLabels: labels } : {}) };
}

export async function persistOwnedDayPlanBatch(batch: OwnedDayPlanBatch, context?: ScheduleSaveContext): Promise<OwnedDayPlanBatch> {
  const candidates = batch.entries.filter((entry) => !ownScheduleEntryIsFinal(entry) && batch.allowedOwners.includes(entry.owner));
  const ids = [...new Set(candidates.filter(entry => entry.occurrenceId).map(entry => entry.targetScheduleId))];
  ids.forEach(id => savingAdjustments.set(id, (savingAdjustments.get(id) ?? 0) + 1));
  let saved: OwnedDayPlanEntry[];
  try {
    if (!context && candidates.some(e => (e.duration || e.readingChoice) && !e.saved)) {
      const items = (await Promise.all(ids.map(loadScheduleItemById))).filter((v): v is NonNullable<typeof v> => !!v);
      if (candidates.some(e => e.duration && !e.saved) || items.some(item => item.execution && item.execution.status !== 'planned'
        && item.execution.status !== 'ended' && item.execution.status !== 'completed')) {
        context = await (await import('./ownScheduleExecution')).readOwnScheduleSaveContext(items);
      }
    }
    const rejected = new Set(batch.entries.filter(e => !!e.choiceError || ownScheduleEntryIsFinal(e)).map(e => e.id));
    for (let pass = 0; pass < batch.entries.length; pass += 1) for (const entry of candidates) {
      if ((entry.choiceDependencyIds ?? []).some(id => rejected.has(id) || !batch.entries.some(source => source.id === id))) rejected.add(entry.id);
    }
    const blocked = candidates.filter(e => !e.saved && (e.choiceDependencyIds ?? []).some(id => rejected.has(id)));
    saved = await saveDayPlanEntries(candidates.filter(e => !blocked.includes(e)), context);
    saved.push(...blocked.map(e => ({ ...e, error: 'reading-choice-dependency-failed' })));
  }
  finally { ids.forEach(id => {
    const left = (savingAdjustments.get(id) ?? 1) - 1;
    if (left) savingAdjustments.set(id, left); else savingAdjustments.delete(id);
  }); }
  const byId = new Map(saved.map((entry) => [entry.id, entry]));
  return { ...batch, entries: batch.entries.map((entry) => byId.get(entry.id) ?? (ownScheduleEntryIsFinal(entry) ? entry : {
    ...entry, error: entry.preparationError ?? 'schedule-owner-forbidden',
  })) };
}

/** Resume checks only current occupancy; it never changes the reading clock. */
export async function canResumeOwnSchedule(itemId: string, remainingMs: number, now: number): Promise<{ ok: boolean; reason?: string; conflict?: ScheduleSaveConflict }> {
  const item = await loadScheduleItemById(itemId);
  if (item?.status === 'cancelled') return { ok: false, reason: 'schedule-duration-cancelled' };
  if (item?.status === 'completed' || item?.execution?.status === 'ended' || item?.execution?.status === 'completed') return { ok: false, reason: 'schedule-duration-ended' };
  if (!item || item.status !== 'pending') return { ok: false, reason: 'schedule-target-changed' };
  const end = now + remainingMs;
  if (!Number.isSafeInteger(end) || end > 8.64e15 || remainingMs <= 0) return { ok: false, reason: 'invalid-day-plan-time' };
  const context = await (await import('./ownScheduleExecution')).readOwnScheduleSaveContext([item], now);
  const sleep = context.sleepIntervals.find(v => v.start < end && now < v.end);
  if (sleep) return { ok: false, reason: 'schedule-time-conflict', conflict: { kind: 'sleep', startAt: now, endAt: end,
    title: sleep.title ?? '', conflictStartAt: sleep.start, conflictEndAt: sleep.end } };
  const others = await loadOwnedScheduleItems(now, end);
  const other = others.find(v => { const occupied = scheduleOccupiedInterval(v, now);
    return v.id !== item.id && v.status === 'pending' && scheduleOwnersOverlap(v.owner, item.owner)
      && occupied && occupied.start < end && now < occupied.end; });
  const occupied = other ? scheduleOccupiedInterval(other, now)! : null;
  return other ? { ok: false, reason: 'schedule-time-conflict', conflict: { startAt: now, endAt: end, title: other.title,
    conflictStartAt: occupied!.start, conflictEndAt: occupied!.end } } : { ok: true };
}

export async function reconcileOwnedDayPlanBatch(batch: OwnedDayPlanBatch): Promise<OwnedDayPlanBatch> {
  const entries = await Promise.all(batch.entries.map(async (entry) => {
    if (entry.saved) return entry;
    if (ownScheduleEntryIsFinal(entry)) return entry;
    const saved = !entry.preparationError && batch.allowedOwners.includes(entry.owner)
      && (entry.owner === 'I' || entry.owner === 'I 和 you') && await isDayPlanSchedulePersisted(entry);
    const actual = saved && entry.duration ? await loadScheduleItemById(entry.targetScheduleId) : null;
    return { ...entry, ...(actual?.execution?.durationChange?.operationId === entry.id ? { startAt: actual.startAt, endAt: actual.endAt } : {}),
      saved, scheduleSaved: saved, ...(saved ? { error: undefined } : {}) };
  }));
  return { ...batch, entries };
}
