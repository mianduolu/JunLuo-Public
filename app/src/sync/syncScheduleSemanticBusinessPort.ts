import type {
  ScheduleSemanticBusinessPort,
} from './syncScheduleSemanticApply';
import { requestScheduleNotificationRefresh } from '../schedule/scheduleNotificationRefresh';
import {
  scheduleSemanticAsyncStorageBusinessPort,
} from './syncScheduleSemanticAsyncStoragePort';
import type {
  ScheduleSemanticRecordKind,
} from './syncScheduleSemantic';
import {
  scheduleSemanticSqliteBusinessPort,
} from './syncScheduleSemanticSqliteApply';

const SQLITE_KINDS = new Set<ScheduleSemanticRecordKind>([
  'schedule-item',
  'schedule-occurrence',
  'day-template-instance',
  'schedule-occurrence-delivery',
  'schedule-companion-delivery',
]);

function portFor(kind: ScheduleSemanticRecordKind) {
  return SQLITE_KINDS.has(kind)
    ? scheduleSemanticSqliteBusinessPort
    : scheduleSemanticAsyncStorageBusinessPort;
}

export const scheduleSemanticBusinessPort:
ScheduleSemanticBusinessPort = {
  upsertRecord: async (input) => {
    const result = await portFor(input.kind).upsertRecord(input);
    requestScheduleNotificationRefresh();
    return result;
  },
  deleteRecord: async (input) => {
    const result = await portFor(input.kind).deleteRecord(input);
    requestScheduleNotificationRefresh();
    return result;
  },
};
