import { loadBackendSettings } from '../backend/backendClient';
import { createAndroidSyncExecutionOnceController } from '../sync/syncExecutionOnceExpo';
import { loadCurrentSyncRelayEnrollment } from '../sync/syncRelayClientExpo';
import { runTodoCompletionOnce } from './todoCompletionOnceCore';
import { completeTodoItem, loadTodoItemById } from './todoStore';

export async function completeTodoItemOnce(todoId: string, options?: Parameters<typeof completeTodoItem>[1], isCurrent?: () => boolean | Promise<boolean>) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  return runTodoCompletionOnce(todoId, {
    syncEnrollmentReady: enrollment !== null,
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
