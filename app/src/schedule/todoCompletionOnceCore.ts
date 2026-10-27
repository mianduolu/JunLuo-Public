import type { PhonePrimaryInternalExecutor } from '../runtime/phonePrimaryInternalExecution';
import {
  createSyncExecutionOperationId,
} from '../sync/syncExecutionOperationId';
import type { SyncExecutionOnceCoordinatorV2 } from '../sync/syncExecutionOnceV2Controller';

type TodoCompletionState = {
  id: string;
  createdAt: number;
  completionRound?: number;
  status: 'inbox' | 'today' | 'scheduled' | 'completed' | 'cancelled' | 'expired';
};

export type TodoCompletionOncePorts<T extends TodoCompletionState> = {
  syncEnrollmentReady: boolean;
  phonePrimaryExecute?: PhonePrimaryInternalExecutor;
  loadTodo(todoId: string): Promise<T | null>;
  completeLocally(todoId: string, expectedRound: number): Promise<T | null>;
  loadRelayBaseUrl(): Promise<string>;
  createCoordinator(baseUrl: string): Promise<Pick<SyncExecutionOnceCoordinatorV2, 'execute'>>;
};

export async function runTodoCompletionOnce<T extends TodoCompletionState>(
  todoId: string,
  ports: TodoCompletionOncePorts<T>,
) {
  const todo = await ports.loadTodo(todoId);
  if (!todo) return null;
  if (todo.status === 'completed') return todo;
  if (todo.status === 'cancelled' || todo.status === 'expired') {
    throw new Error('todo-not-completable');
  }
  const round = todo.completionRound ?? 0;
  const loadCurrent = async () => {
    const current = await ports.loadTodo(todoId);
    if (!current || (current.completionRound ?? 0) !== round) {
      throw new Error('todo-completion-source-changed');
    }
    return current;
  };
  if (!ports.syncEnrollmentReady && !ports.phonePrimaryExecute) {
    await ports.completeLocally(todoId, round);
    const current = await loadCurrent();
    if (current.status !== 'completed') throw new Error('todo-completion-needs-reconciliation');
    return current;
  }
  const executeOnce = ports.phonePrimaryExecute ?? (async (input) => {
    const baseUrl = (await ports.loadRelayBaseUrl()).trim();
    if (!baseUrl) throw new Error('sync-relay-not-configured');
    return (await ports.createCoordinator(baseUrl)).execute(input);
  });
  const result = await executeOnce({
    operationId: createSyncExecutionOperationId({
      category: 'reminder',
      scope: 'todo.item',
      entityId: todoId,
      action: `complete:v2:${round}`,
    }),
    category: 'reminder',
    createdAt: todo.createdAt,
    reconcile: async () => {
      const current = await loadCurrent();
      if (current.status === 'completed') return 'completed';
      if (current.status === 'cancelled' || current.status === 'expired') return 'cancelled';
      return null;
    },
    execute: async () => {
      const current = await loadCurrent();
      if (current.status === 'cancelled' || current.status === 'expired') return 'cancelled';
      await ports.completeLocally(todoId, round);
      return (await loadCurrent()).status === 'completed'
        ? 'completed'
        : 'failed';
    },
  });
  const current = await loadCurrent();
  if (result.state === 'deferred') throw new Error('todo-completion-owned-by-another-device');
  if (result.state === 'reconciliation-required') throw new Error('todo-completion-needs-reconciliation');
  if (result.outcome !== 'completed') throw new Error('todo-completion-failed');
  if (current.status !== 'completed') throw new Error('todo-completion-needs-reconciliation');
  return current;
}
