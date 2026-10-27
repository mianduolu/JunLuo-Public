import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { ensurePhonePrimaryActivation, loadPhonePrimaryActivation } from '../runtime/phonePrimaryRuntime';
import { createPhonePrimaryInternalExecutor, phonePrimaryExecutionScope } from '../runtime/phonePrimaryInternalExecution';
import { AndroidSyncExecutionFenceV2SqlitePort } from '../sync/syncExecutionFenceSqlitePort';
import { loadBackendSettings } from '../backend/backendClient';
import { createAndroidSyncExecutionOnceController } from '../sync/syncExecutionOnceExpo';
import { loadCurrentSyncRelayEnrollment } from '../sync/syncRelayClientExpo';
import { runTodoCompletionOnce } from './todoCompletionOnceCore';
import { completeTodoItem, loadTodoItemById } from './todoStore';

export async function completeTodoItemOnce(todoId: string, options?: Parameters<typeof completeTodoItem>[1], isCurrent?: () => boolean | Promise<boolean>) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const enrollment = await loadCurrentSyncRelayEnrollment();
  const activation = await ensurePhonePrimaryActivation();
  const identityScope = phonePrimaryExecutionScope(enrollment);
  const fence = enrollment ? new AndroidSyncExecutionFenceV2SqlitePort() : null;
  return runTodoCompletionOnce(todoId, {
    syncEnrollmentReady: enrollment !== null,
    phonePrimaryExecute: activation ? createPhonePrimaryInternalExecutor({
      activatedAt: activation.activatedAt,
      identityScope,
      dataEpoch,
      isCurrent: async () => {
        const current = await loadPhonePrimaryActivation();
        return current?.activatedAt === activation.activatedAt
          && phonePrimaryExecutionScope(await loadCurrentSyncRelayEnrollment()) === identityScope;
      },
      mode: 'local-completion',
      loadFence: (operationId) => fence?.load(operationId) ?? Promise.resolve(null),
    }) : async (input) => ({ state: 'reconciliation-required', operationId: input.operationId }),
    loadTodo: loadTodoItemById,
    completeLocally: async (id, round) => {
      if (isCurrent && !await isCurrent()) throw new Error('todo-completion-source-changed');
      return completeTodoItem(id, { ...options, expectedCompletionRound: round });
    },
    loadRelayBaseUrl: async () => (await loadBackendSettings()).baseUrl,
    createCoordinator: async (baseUrl) => (
      await createAndroidSyncExecutionOnceController({ baseUrl })
    ).coordinator,
  });
}
