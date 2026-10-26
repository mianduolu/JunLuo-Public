import type { SQLiteDatabase } from 'expo-sqlite';
export const MEMORY_RECALL_WORK_PHASES = ['candidate_read', 'basis_check', 'source_read', 'vector_search', 'database_queue', 'database_read'] as const;
export type MemoryRecallWorkPhase = typeof MEMORY_RECALL_WORK_PHASES[number];
export type MemoryRecallWorkDiagnostic = { elapsedMs: number; count: number; active: number };
export type MemoryRecallWorkReporter = { start: (phase: MemoryRecallWorkPhase) => () => void };

export type MemoryDatabaseReadContext = { signal?: AbortSignal; reporter?: MemoryRecallWorkReporter };
const readWithContext = Symbol('memory-database-read-context');
type ReadMethod = 'getAllAsync' | 'getFirstAsync';
type ContextReader = (method: ReadMethod, args: unknown[], context: MemoryDatabaseReadContext) => Promise<unknown>;
function cancelledRead() { return Object.assign(new Error('memory-database-read-cancelled'), { name: 'AbortError' }); }

/** A view of the same connection/order. Read cancellation never interrupts native SQLite. */
export function withMemoryDatabaseReadContext(database: SQLiteDatabase, context?: MemoryDatabaseReadContext): SQLiteDatabase {
  if (!context?.signal && !context?.reporter) return database;
  const reader = Reflect.get(database, readWithContext) as ContextReader | undefined;
  return new Proxy(database, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'getAllAsync' || key === 'getFirstAsync') return (...args: unknown[]) => {
        if (reader) return reader(key, args, context);
        // Transaction/test connections are already scoped by their owner.
        if (context.signal?.aborted) return Promise.reject(cancelledRead());
        const finish = context.reporter?.start('database_read');
        return Promise.resolve().then(() => {
          if (context.signal?.aborted) throw cancelledRead();
          return value.apply(target, args);
        }).then(result => {
          if (context.signal?.aborted) throw cancelledRead();
          return result;
        }).finally(() => finish?.());
      };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** One write order for the memory database, shared by every diagnostic view.
 * Transactions use Expo's separate connection; callers must use its argument.
 * Main-connection reads also finish/finalize before the next transaction,
 * so their cursors cannot block its COMMIT in SQLite's rollback journal mode.
 */
export function serializeMemoryDatabaseWrites(database: SQLiteDatabase): SQLiteDatabase {
  let writes: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = writes.then(work);
    writes = result.catch(() => undefined);
    return result;
  };
  const contextualRead: ContextReader = (method, args, context) => {
    if (context.signal?.aborted) return Promise.reject(cancelledRead());
    const finishQueue = context.reporter?.start('database_queue');
    let started = false;
    let finishRead: (() => void) | undefined;
    let rejectCancelled!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    const onAbort = () => {
      if (started) return; // The native cursor must finish before the next queued write.
      finishQueue?.();
      rejectCancelled(cancelledRead());
    };
    context.signal?.addEventListener('abort', onAbort, { once: true });
    const pending = enqueue(async () => {
      finishQueue?.();
      if (context.signal?.aborted) throw cancelledRead();
      started = true;
      finishRead = context.reporter?.start('database_read');
      try {
        const nativeRead = Reflect.get(database, method, database) as (...parameters: unknown[]) => Promise<unknown>;
        const result = await nativeRead.apply(database, args);
        if (context.signal?.aborted) throw cancelledRead();
        return result;
      } finally { finishRead?.(); }
    });
    return Promise.race([pending, aborted]).finally(() => context.signal?.removeEventListener('abort', onAbort));
  };
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(database, {
    set(target, key, value) {
      // Keep method overrides on this view, rather than rewriting the native
      // connection behind wrappers that have already captured its methods.
      if (typeof Reflect.get(target, key, target) === 'function' && typeof value === 'function') {
        methods.set(key, value);
        return true;
      }
      return Reflect.set(target, key, value, target);
    },
    get(target, key) {
      if (key === readWithContext) return contextualRead;
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (methods.has(key)) return methods.get(key);
      const method = key === 'withTransactionAsync'
        ? async () => { throw new Error('memory-database-requires-scoped-transaction'); }
        : key === 'withExclusiveTransactionAsync' || key === 'runAsync' || key === 'execAsync'
          || key === 'getFirstAsync' || key === 'getAllAsync' || key === 'closeAsync'
          ? (...args: unknown[]) => enqueue(() => value.apply(target, args))
          : value.bind(target);
      methods.set(key, method);
      return method;
    },
  });
}

export function isMemoryDatabaseBusy(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /\bSQLITE_(?:BUSY|LOCKED)\b|database (?:table |schema )?is locked/i.test(message);
}
