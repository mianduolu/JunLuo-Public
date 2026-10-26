import type {
  FocusSemanticBusinessPort,
} from './syncFocusSemanticApply';
import {
  deleteFocusLogFromActiveStorage,
  focusSemanticAsyncStorageBusinessPort,
  upsertFocusLogIntoActiveStorage,
} from './syncFocusSemanticAsyncStoragePort';
import {
  focusSemanticSqliteBusinessPort,
} from './syncFocusSemanticSqliteApply';

export const focusSemanticBusinessPort:
FocusSemanticBusinessPort = {
  async upsertRecord(input) {
    if (input.kind === 'focus-session') {
      await focusSemanticSqliteBusinessPort.upsertRecord(input);
      return;
    }
    if (input.kind === 'focus-log') {
      await focusSemanticSqliteBusinessPort.upsertRecord(input);
      await upsertFocusLogIntoActiveStorage(input.record);
      return;
    }
    await focusSemanticAsyncStorageBusinessPort.upsertRecord(input);
  },
  async deleteRecord(input) {
    if (input.kind === 'focus-session') {
      await focusSemanticSqliteBusinessPort.deleteRecord(input);
      return;
    }
    if (input.kind === 'focus-log') {
      await focusSemanticSqliteBusinessPort.deleteRecord(input);
      await deleteFocusLogFromActiveStorage(input.entityId);
      return;
    }
    await focusSemanticAsyncStorageBusinessPort.deleteRecord(input);
  },
};
