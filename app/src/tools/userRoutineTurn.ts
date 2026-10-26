import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadChatSessionMessage } from '../chat/chatStorage';
import { readUserRoutine, readEffectiveUserRoutineRange, saveUserRoutinePatch } from '../schedule/userRoutineStore';
import { parseUserRoutinePatch, isRoutineDate, routineTimestampText, type UserRoutineKind } from '../schedule/userRoutinePolicy';
import { parseOwnDayPlanTime } from '../schedule/ownDayPlanPolicy';
import { loadUserRoutineOverlaps } from '../schedule/userRoutineContext';
import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';

/** Authorization belongs to the real chat turn, never to arguments supplied by the model. */
export function createUserRoutineTurn(input: {
  dataEpoch: number; signal?: AbortSignal; sourceMessageId?: string; sourceSessionId?: string;
  sourceMessage?: { id: string; role: string; content: string; createdAt: number };
  isCurrent?: () => boolean | Promise<boolean>;
}) {
  const versions = new Map<string, string>();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const original = input.sourceMessage;
  const source = original?.role === 'you' && original.id === input.sourceMessageId
    ? fingerprintPromptText(JSON.stringify([original.id, original.role, original.content, original.createdAt])) : undefined;
  const valid = async () => {
    if (input.signal?.aborted || !canCommitBackupRestoreDataEpoch(input.dataEpoch)
      || !source || !input.sourceMessageId || !input.sourceSessionId || input.isCurrent && !await input.isCurrent()) return false;
    const message = await loadChatSessionMessage(input.sourceSessionId, input.sourceMessageId);
    if (!message || message.role !== 'you') return false;
    const revision = fingerprintPromptText(JSON.stringify([message.id, message.role, message.content, message.createdAt]));
    return source === revision;
  };
  return async (call: JunLuoToolCall): Promise<JunLuoToolResult> => {
    if (call.requestedBy !== 'chat' || !await valid().catch(() => false)) return createToolErrorResult(call,
      createToolError('PERMISSION_DENIED', 'routine-chat-source-unavailable'), '');
    const date = call.input.date;
    if (call.toolId === 'schedule.query_routine') {
      if (Object.keys(call.input).some(key => key !== 'date') || date !== undefined &&
        !isRoutineDate(date)) return createToolErrorResult(call,
        createToolError('VALIDATION_FAILED', 'invalid-routine-date'), '');
      try {
        const value = await readUserRoutine(date as string | undefined, timeZone);
        if (value.status === 'unavailable') throw new Error('routine-unavailable');
        versions.set(value.date, value.version);
        const { version: _version, ...data } = value;
        if (typeof date === 'string') {
          const next = new Date(`${date}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
          const records = await readEffectiveUserRoutineRange(parseOwnDayPlanTime(`${date} 00:00`, timeZone),
            parseOwnDayPlanTime(`${next.toISOString().slice(0, 10)} 00:00`, timeZone), timeZone);
          // Key by stable ownership identity: yesterday's sleep and today's sleep are not one item.
          const items = Object.fromEntries([...Object.entries(value.items)
            .filter(([, item]) => !item?.enabled || !item.time)
            .map(([kind, item]) => [`${date}:${kind}`, { ...item, kind, date }]),
          ...records.map(item => [item.id, { kind: item.kind, date: item.dateKey,
            enabled: item.enabled, source: item.source, time: routineTimestampText(item.startAt!, timeZone),
            ...(item.endAt === undefined ? {} : { minutes: (item.endAt - item.startAt!) / 60000 }) }])]);
          const status = Object.keys(items).length ? 'ok' : 'unset';
          return createToolSuccessResult(call, status === 'ok' ? '作息已读取。' : '尚未设置这份作息。', { ...data, status, items });
        }
        return createToolSuccessResult(call, value.status === 'unset' ? '尚未设置这份作息。' : '作息已读取。', data);
      } catch {
        return createToolErrorResult(call, createToolError('EXECUTION_FAILED', 'routine-read-unavailable'), '作息暂时无法读取。');
      }
    }
    if (call.toolId !== 'schedule.save_routine' || typeof date !== 'string') return createToolErrorResult(call,
      createToolError('VALIDATION_FAILED', 'invalid-routine-date'), '');
    let patch;
    try { patch = parseUserRoutinePatch(call.input, timeZone); }
    catch { return createToolErrorResult(call, createToolError('VALIDATION_FAILED', 'invalid-routine-input'),
      '这次还没保存好，作息暂时还是原来的安排。'); }
    try {
      const current = await readUserRoutine(date === 'usual' ? undefined : date, timeZone);
      if (current.status === 'unavailable') throw new Error('routine-read-unavailable');
      const saved = await saveUserRoutinePatch(patch, { operationId: call.callId,
        expectedVersion: versions.get(date) ?? current.version, dataEpoch: input.dataEpoch, call, isCurrent: valid, timeZone,
        source: { sessionId: input.sourceSessionId!, messageId: input.sourceMessageId!, revision: source! } });
      if (saved.status === 'saved') {
        versions.set(date, saved.routine.version);
        const { version: _version, items, ...rest } = saved.routine;
        const start = new Date(`${date === 'usual' ? routineTimestampText(Date.now(), timeZone).slice(0, 10) : date}T00:00:00`);
        const end = new Date(start); end.setDate(end.getDate() + 2);
        const overlaps = await loadUserRoutineOverlaps(start.getTime(), end.getTime()).catch(() => null);
        return createToolSuccessResult(call, '作息已保存。', { ...rest,
          items: Object.fromEntries(Object.entries(items).filter(([kind]) => saved.changedKinds.includes(kind as UserRoutineKind))), overlaps });
      }
      return { ...createToolErrorResult(call, createToolError('EXECUTION_FAILED', `routine-${saved.status}`),
        saved.status === 'unknown' ? '作息保存结果暂时无法确认。' : '这次还没保存好，作息暂时还是原来的安排。'),
        data: { subject: 'you', date, status: saved.status } };
    } catch {
      return createToolErrorResult(call, createToolError('EXECUTION_FAILED', 'routine-save-unavailable'), '作息保存结果暂时无法确认。');
    }
  };
}
