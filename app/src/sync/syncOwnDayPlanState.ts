// Shape validation only; neither endpoint starts model work while receiving this record.
type Row = Record<string, any>;
const statuses = ['ready', 'requesting', 'waiting', 'saving', 'complete', 'failed'];
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-own-day-plan-object');
  return value as Row;
}
function keys(value: Row, required: string[], optional: string[] = []) {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('invalid-own-day-plan-fields');
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error('invalid-own-day-plan-number');
}
function text(value: unknown, max = 12000) {
  if (typeof value !== 'string' || value.length > max) throw new Error('invalid-own-day-plan-text');
}
function ids(value: unknown) {
  if (!Array.isArray(value) || new Set(value).size !== value.length) throw new Error('invalid-own-day-plan-ids');
  value.forEach(id => text(id, 512));
}
function readingLabels(value: unknown) {
  for (const [label, id] of Object.entries(row(value))) {
    if (!/^r[1-9]\d*$/.test(label)) throw new Error('invalid-own-day-plan-reading-label');
    text(id, 512); if (!id) throw new Error('invalid-own-day-plan-reading-label');
  }
}
function readingChoice(value: unknown, full = false) {
  const choice = row(value);
  keys(choice, ['sourceId', ...(full || 'version' in choice ? ['version', 'currentReadingId', 'nextReadingId', 'operationId'] : [])]);
  text(choice.sourceId, 512); if (!choice.sourceId) throw new Error('invalid-own-day-plan-reading-choice');
  if ('version' in choice) {
    number(choice.version); text(choice.operationId, 512);
    for (const key of ['currentReadingId', 'nextReadingId']) if (choice[key] !== null) { text(choice[key], 256); if (!choice[key]) throw new Error('invalid-own-day-plan-reading-choice'); }
  }
}
function tool(value: unknown, receipt: boolean) {
  const record = row(value);
  keys(record, ['callId', 'toolId', 'input', ...(receipt ? ['result'] : ['createdAt'])], receipt ? ['createdAt', 'requestedBy'] : ['requestedBy']);
  text(record.callId, 256);
  if (!['reading.list', 'schedule.save_own_habits'].includes(record.toolId)) throw new Error('invalid-own-day-plan-tool');
  const input = row(record.input);
  if (record.toolId === 'reading.list') { keys(input, [], ['cursor']); if (input.cursor !== undefined) text(input.cursor, 256); }
  else {
    keys(input, ['entries', 'stopIds']); ids(input.stopIds);
    if (!Array.isArray(input.entries)) throw new Error('invalid-own-day-plan-habits');
    for (const raw of input.entries) {
      const entry = row(raw); keys(entry, ['id', 'title', 'frequency', 'count', 'weekDays', 'minutes']);
      if (entry.id !== null) text(entry.id, 512); text(entry.title);
      if (!['daily', 'weekly', 'weekdays'].includes(entry.frequency)) throw new Error('invalid-own-day-plan-frequency');
      number(entry.count); if (entry.minutes !== null) number(entry.minutes);
      if (!Array.isArray(entry.weekDays) || entry.weekDays.some((day: unknown) => !Number.isInteger(day) || Number(day) < 1 || Number(day) > 7)) throw new Error('invalid-own-day-plan-weekdays');
    }
  }
  if (record.createdAt !== undefined) number(record.createdAt);
  if (receipt) {
    const result = row(record.result);
    keys(result, ['callId', 'toolId', 'ok', 'status', 'summary', 'startedAt', 'finishedAt'], ['data', 'error']);
    if (result.callId !== record.callId || result.toolId !== record.toolId || typeof result.ok !== 'boolean') throw new Error('invalid-own-day-plan-receipt');
    if (!['success', 'error', 'permission_denied', 'cancelled'].includes(result.status)) throw new Error('invalid-own-day-plan-tool-status');
    text(result.summary); number(result.startedAt); number(result.finishedAt);
  }
}
export function assertOwnDayPlanNight(value: unknown) {
  const state = row(value); keys(state, [], ['prepare', 'wake', 'restoredAt']);
  if (state.restoredAt !== undefined) number(state.restoredAt);
  for (const phase of ['prepare', 'wake']) {
    if (state[phase] === undefined) continue;
    const run = row(state[phase]);
    keys(run, ['id', 'status', 'createdAt', 'updatedAt', 'bounds', 'requestCount', 'saveAttempts', 'scheduleVersions', 'habitVersions', 'readingVersions', 'sleepRevision'],
      ['requestId', 'retryAt', 'reason', 'tools', 'pendingTool', 'requests', 'batch', 'prepareIds', 'readingLabels', 'expectedChoiceVersions', 'errorDiagnostic', 'paperCorrection']);
    if (run.errorDiagnostic !== undefined) {
      const diagnostic = row(run.errorDiagnostic);
      keys(diagnostic, ['stage', 'errorName', 'code'], ['httpStatus', 'transportOutcome']);
      for (const key of ['stage', 'errorName', 'code', 'transportOutcome']) if (diagnostic[key] !== undefined) text(diagnostic[key], 160);
      if (diagnostic.httpStatus !== undefined) number(diagnostic.httpStatus, 599);
    }
    if (run.readingLabels !== undefined) readingLabels(run.readingLabels);
    if (run.expectedChoiceVersions !== undefined) for (const [id, version] of Object.entries(row(run.expectedChoiceVersions))) { text(id, 512); number(version); }
    text(run.id, 256); if (!statuses.includes(run.status)) throw new Error('invalid-own-day-plan-status');
    number(run.requestCount, 4); number(run.saveAttempts, 4);
    for (const key of ['createdAt', 'updatedAt', 'sleepRevision', 'retryAt']) if (run[key] !== undefined) number(run[key]);
    for (const key of ['requestId', 'reason']) if (run[key] !== undefined) text(run[key], 512);
    const bounds = row(run.bounds); keys(bounds, ['startAt', 'endAt', 'timeZone']);
    number(bounds.startAt); number(bounds.endAt); text(bounds.timeZone, 100);
    if (bounds.endAt - bounds.startAt !== 86400000) throw new Error('invalid-own-day-plan-range');
    for (const key of ['scheduleVersions', 'habitVersions', 'readingVersions']) {
      for (const [id, version] of Object.entries(row(run[key]))) { text(id, 512); number(version); }
    }
    if (run.tools !== undefined) {
      if (!Array.isArray(run.tools) || run.tools.length > 4) throw new Error('invalid-own-day-plan-tools');
      run.tools.forEach((receipt: unknown) => tool(receipt, true));
    }
    if (run.pendingTool !== undefined) tool(run.pendingTool, false);
    if (run.prepareIds !== undefined) ids(run.prepareIds);
    if (run.requests !== undefined) {
      if (!Array.isArray(run.requests) || run.requests.length > 4
        || run.requests.filter((request: Row) => request.outcome !== 'not-started').length !== run.requestCount) throw new Error('invalid-own-day-plan-requests');
      for (const raw of run.requests) {
        const request = row(raw); keys(request, ['id', 'startedAt', 'outcome'], ['endedAt', 'promptTokens', 'completionTokens']);
        text(request.id, 256); text(request.outcome, 80);
        for (const key of ['startedAt', 'endedAt', 'promptTokens', 'completionTokens']) if (request[key] !== undefined) number(request[key]);
      }
    }
    const invalidPapers = (run.requests ?? []).filter((request: Row) => request.outcome === 'invalid-paper');
    if (invalidPapers.length > 1 || ((run.requestCount > 3 || (run.requests?.length ?? 0) > 3)
      && invalidPapers.length !== 1)) throw new Error('invalid-own-day-plan-requests');
    if (run.paperCorrection !== undefined) {
      const correction = row(run.paperCorrection);
      keys(correction, ['content', 'checks', 'requestId', 'attempted']);
      text(correction.content, 32000); text(correction.requestId, 256);
      if (!['ready', 'waiting', 'requesting'].includes(run.status) || typeof correction.attempted !== 'boolean'
        || !invalidPapers.some((request: Row) => request.id === correction.requestId)) throw new Error('invalid-own-day-plan-correction');
      if (!Array.isArray(correction.checks) || correction.checks.length < 1 || correction.checks.length > 16) throw new Error('invalid-own-day-plan-correction');
      for (const raw of correction.checks) {
        const check = row(raw); keys(check, ['path', 'code']); text(check.path, 160); text(check.code, 160);
      }
    }
    if (run.batch !== undefined) {
      const batch = row(run.batch); keys(batch, ['opId', 'allowedOwners', 'entries'], ['readingLabels']);
      if (batch.readingLabels !== undefined) readingLabels(batch.readingLabels);
      if (batch.opId !== run.id || !Array.isArray(batch.allowedOwners) || batch.allowedOwners.some((owner: unknown) => owner !== 'I')
        || !Array.isArray(batch.entries)) throw new Error('invalid-own-day-plan-batch');
      for (const raw of batch.entries) {
        const entry = row(raw);
        keys(entry, ['id', 'action', 'title', 'notes', 'startSuggested', 'endSuggested', 'reminderMinutesBefore', 'companionEnabled',
          'targetScheduleId', 'targetTodoId', 'owned', 'owner', 'readingId'],
        ['occurrenceId', 'todoId', 'startAt', 'endAt', 'sourceUpdatedAt', 'sourceTodoUpdatedAt', 'saved', 'scheduleSaved', 'error', 'preparationError', 'habitId', 'sourcePlanVersion', 'duration', 'conflict',
          'readingChoice', 'choiceUpdate', 'choiceExpectedVersion', 'choiceSourcePlanVersion', 'choiceDependencyIds', 'choiceError']);
        if (entry.readingChoice !== undefined) readingChoice(entry.readingChoice);
        if (entry.choiceUpdate !== undefined) readingChoice(entry.choiceUpdate, true);
        if (entry.choiceDependencyIds !== undefined) ids(entry.choiceDependencyIds);
        if (entry.choiceError !== undefined) text(entry.choiceError);
        for (const key of ['choiceExpectedVersion', 'choiceSourcePlanVersion']) if (entry[key] !== undefined) number(entry[key]);
        if (entry.owner !== 'I' || entry.owned !== true || !['schedule', 'cancel'].includes(entry.action)) throw new Error('invalid-own-day-plan-owner');
        for (const key of ['id', 'title', 'notes', 'targetScheduleId', 'targetTodoId', 'occurrenceId', 'todoId', 'error', 'preparationError']) if (entry[key] !== undefined) text(entry[key]);
        for (const key of ['startAt', 'endAt', 'sourceUpdatedAt', 'sourceTodoUpdatedAt', 'sourcePlanVersion', 'reminderMinutesBefore']) if (entry[key] !== undefined) number(entry[key]);
        if (entry.duration !== undefined) {
          const duration = row(entry.duration);
          keys(duration, ['changeStart'], ['minutes', 'planningStartAt', 'planningEndAt']);
          if (typeof duration.changeStart !== 'boolean') throw new Error('invalid-own-day-plan-duration');
          for (const key of ['minutes', 'planningStartAt', 'planningEndAt']) if (duration[key] !== undefined) number(duration[key]);
          if (duration.minutes === 0) throw new Error('invalid-own-day-plan-duration');
        }
        if (entry.conflict !== undefined) {
          const conflict = row(entry.conflict); keys(conflict, ['startAt', 'endAt', 'title', 'conflictStartAt', 'conflictEndAt'], ['kind']);
          if (conflict.kind !== undefined && conflict.kind !== 'sleep') throw new Error('invalid-own-day-plan-conflict');
          text(conflict.title); for (const key of ['startAt', 'endAt', 'conflictStartAt', 'conflictEndAt']) number(conflict[key]);
        }
        for (const key of ['readingId', 'habitId']) if (entry[key] != null) text(entry[key], 512);
        for (const key of ['startSuggested', 'endSuggested', 'companionEnabled', 'saved', 'scheduleSaved']) if (entry[key] !== undefined && typeof entry[key] !== 'boolean') throw new Error('invalid-own-day-plan-boolean');
      }
    }
  }
}

export function mergeOwnDayPlanState(left: unknown, right: unknown): Row | undefined {
  if (!left || !right) return (left ?? right) as Row | undefined;
  const a = row(left), b = row(right), result: Row = {};
  if (a.restoredAt || b.restoredAt) result.restoredAt = Math.max(a.restoredAt ?? 0, b.restoredAt ?? 0);
  for (const phase of ['prepare', 'wake']) {
    if (!a[phase] || !b[phase]) { if (a[phase] || b[phase]) result[phase] = a[phase] ?? b[phase]; continue; }
    const x = row(a[phase]), y = row(b[phase]);
    const terminal = (value: Row) => value.status === 'complete' || value.status === 'failed';
    const selected = x.status === 'complete' ? x : y.status === 'complete' ? y
      : terminal(x) !== terminal(y) ? terminal(x) ? x : y : x.updatedAt >= y.updatedAt ? x : y;
    const requests = new Map<string, Row>();
    for (const request of [...(x.requests ?? []), ...(y.requests ?? [])]) {
      const old = requests.get(request.id);
      if (!old || (request.endedAt ?? 0) >= (old.endedAt ?? 0)) requests.set(request.id, request);
    }
    result[phase] = { ...selected,
      ...(x.requests || y.requests ? { requests: [...requests.values()] } : {}),
      requestCount: x.requests || y.requests ? [...requests.values()].filter(request => request.outcome !== 'not-started').length : Math.max(x.requestCount, y.requestCount),
      saveAttempts: Math.max(x.saveAttempts, y.saveAttempts) };
    for (const key of ['readingLabels', 'expectedChoiceVersions']) if (result[phase][key] === undefined && (x[key] !== undefined || y[key] !== undefined)) result[phase][key] = x[key] ?? y[key];
    if (x.batch && y.batch && x.batch.opId === y.batch.opId) {
      result[phase].batch = { ...selected.batch,
        ...(x.batch.readingLabels || y.batch.readingLabels ? { readingLabels: selected.batch.readingLabels ?? x.batch.readingLabels ?? y.batch.readingLabels } : {}),
        entries: selected.batch.entries.map((entry: Row) => {
        const other = (selected === x ? y : x).batch.entries.find((value: Row) => value.id === entry.id);
        const savedDuration = entry.saved && entry.duration ? entry : other?.saved && other.duration ? other : undefined;
        const merged: Row = { ...entry, ...(savedDuration ?? {}), ...(other?.duration && !entry.duration ? { duration: other.duration } : {}),
          ...(other?.sourcePlanVersion !== undefined && entry.sourcePlanVersion === undefined ? { sourcePlanVersion: other.sourcePlanVersion } : {}),
          ...(other?.saved ? { saved: true, scheduleSaved: true } : {}) };
        for (const key of ['readingChoice', 'choiceUpdate', 'choiceExpectedVersion', 'choiceSourcePlanVersion', 'choiceDependencyIds', 'choiceError']) {
          if (merged[key] === undefined && other?.[key] !== undefined) merged[key] = other[key];
        }
        if (merged.saved) delete merged.error;
        return merged;
      }) };
    }
  }
  return result;
}
