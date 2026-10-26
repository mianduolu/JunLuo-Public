import type { MemoryBundle } from './memoryOrchestrator';
import type { MemoryRecallRoute, MemoryRecallRouteResult } from './memoryRecallRouter';
import { isMemoryDatabaseBusy, MEMORY_RECALL_WORK_PHASES, type MemoryRecallWorkPhase,
  type MemoryRecallWorkDiagnostic, type MemoryRecallWorkReporter } from './memoryDatabaseWrites';
export { MEMORY_RECALL_WORK_PHASES, type MemoryRecallWorkPhase,
  type MemoryRecallWorkDiagnostic, type MemoryRecallWorkReporter } from './memoryDatabaseWrites';

export const CHAT_MEMORY_PREPARATION_TIMEOUT_MS = { total: 20_000, fallbackTotal: 20_000, route: 8_000, local: 10_000, semantic: 10_000 } as const;
export type MemoryRecallStageDiagnostic = {
  status: 'ready' | 'not_started' | 'failed' | 'timeout' | 'cancelled';
  reason?: string;
  startedAt?: number;
  finishedAt?: number;
  work?: Partial<Record<MemoryRecallWorkPhase, MemoryRecallWorkDiagnostic>>;
};
export type MemoryRecallPreparationDiagnostic = {
  status: 'ready' | 'not_started' | 'failed' | 'timeout';
  reason?: string;
  startedAt: number;
  finishedAt: number;
  route: MemoryRecallStageDiagnostic;
  local: MemoryRecallStageDiagnostic;
  semantic: MemoryRecallStageDiagnostic;
};

// Only fixed technical codes enter diagnostics, never raw exception messages.
function failureReason(error: unknown) {
  if (isMemoryDatabaseBusy(error)) return 'database_busy';
  const message = error instanceof Error ? error.message : '';
  if (message === 'embedding-disabled' || message === 'embedding-not-configured') return 'configuration_missing';
  if (message === 'embedding-index-unavailable') return 'index_unavailable';
  if (message === 'embedding-configuration-changed') return 'configuration_changed';
  if (message === 'embedding-timeout') return 'timeout';
  if (message.startsWith('embedding-http-')) return 'http_error';
  if (error instanceof SyntaxError || message === 'embedding-invalid-vector-response' || message === 'embedding-empty-response') return 'parse_error';
  if (error instanceof TypeError) return 'network_error';
  return 'read_failed';
}

function cancelled() { return Object.assign(new Error('memory-preparation-cancelled'), { name: 'AbortError' }); }

function collectWork() {
  const phases = new Map<MemoryRecallWorkPhase, { elapsedMs: number; count: number; active: Set<{ startedAt: number }> }>();
  let finished = false;
  const reporter: MemoryRecallWorkReporter = {
    start(phase) {
      if (finished || !MEMORY_RECALL_WORK_PHASES.includes(phase)) return () => {};
      const state = phases.get(phase) ?? { elapsedMs: 0, count: 0, active: new Set<{ startedAt: number }>() };
      phases.set(phase, state);
      const operation = { startedAt: Date.now() };
      state.count++; state.active.add(operation);
      return () => {
        if (!finished && state.active.delete(operation)) state.elapsedMs += Math.max(0, Date.now() - operation.startedAt);
      };
    },
  };
  return { reporter, finish() {
    finished = true;
    if (!phases.size) return undefined;
    const now = Date.now();
    return Object.fromEntries([...phases].map(([phase, state]) => [phase, {
      elapsedMs: state.elapsedMs + [...state.active].reduce((total, item) => total + Math.max(0, now - item.startedAt), 0),
      count: state.count, active: state.active.size,
    }])) as MemoryRecallStageDiagnostic['work'];
  } };
}

export async function prepareChatMemoryRecall(input: {
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: MemoryRecallPreparationDiagnostic) => void;
  route: (signal: AbortSignal, timeoutMs: number) => Promise<MemoryRecallRouteResult>;
  local: (signal: AbortSignal, reporter?: MemoryRecallWorkReporter) => Promise<MemoryBundle>;
  semantic: (route: MemoryRecallRoute, signal: AbortSignal, reporter?: MemoryRecallWorkReporter) => Promise<MemoryBundle>;
  fallbackRoute?: MemoryRecallRoute;
}): Promise<{ bundle: MemoryBundle | null; route: MemoryRecallRoute | null; diagnostic: MemoryRecallPreparationDiagnostic }> {
  if (input.signal?.aborted) throw cancelled();
  const startedAt = Date.now();
  let deadline = startedAt + CHAT_MEMORY_PREPARATION_TIMEOUT_MS.total;
  const diagnostic: MemoryRecallPreparationDiagnostic = {
    status: 'not_started', startedAt, finishedAt: startedAt,
    route: { status: 'not_started' }, local: { status: 'not_started' }, semantic: { status: 'not_started' },
  };
  const notify = () => {
    try { input.onDiagnostic?.({ ...diagnostic, route: { ...diagnostic.route }, local: { ...diagnostic.local }, semantic: { ...diagnostic.semantic } }); }
    catch { /* Diagnostics cannot fail a reply. */ }
  };
  notify();

  async function stage<T>(name: 'route' | 'local' | 'semantic', operation: (signal: AbortSignal, budget: number, reporter: MemoryRecallWorkReporter) => Promise<T>): Promise<T | null> {
    const budget = Math.min(CHAT_MEMORY_PREPARATION_TIMEOUT_MS[name], deadline - Date.now());
    const state = diagnostic[name];
    if (input.signal?.aborted) throw cancelled();
    if (budget <= 0) {
      Object.assign(state, { status: 'timeout', reason: 'deadline_exceeded', finishedAt: Date.now() });
      return null;
    }
    const controller = new AbortController();
    const work = collectWork();
    state.startedAt = Date.now();
    notify();
    let stop!: (reason: 'timeout' | 'cancelled') => void;
    let stopped: 'timeout' | 'cancelled' | undefined;
    const stoppedPromise = new Promise<null>((resolve) => {
      stop = reason => { stopped = reason; resolve(null); controller.abort(); };
    });
    const abort = () => stop('cancelled');
    input.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), budget);
    try {
      const value = await Promise.race([stoppedPromise, Promise.resolve().then(() => operation(controller.signal, budget, work.reporter))]);
      if (stopped === 'cancelled' || input.signal?.aborted) throw cancelled();
      if (stopped || Date.now() >= state.startedAt + budget) {
        state.status = 'timeout'; state.reason = 'timeout';
        controller.abort();
        return null;
      }
      state.status = 'ready';
      return value;
    } catch (error) {
      // A failed branch can leave parallel readers running; stop this stage only.
      // Successful bundles retain their signal for later material refreshes.
      controller.abort();
      if (input.signal?.aborted || stopped === 'cancelled') { state.status = 'cancelled'; state.reason = 'cancelled'; throw cancelled(); }
      state.reason = failureReason(error);
      state.status = state.reason === 'timeout' ? 'timeout' : 'failed';
      return null;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      state.finishedAt = Date.now();
      state.work = work.finish();
      notify();
    }
  }

  const localPromise = stage('local', (signal, _budget, reporter) => input.local(signal, reporter));
  const routePromise = stage('route', (signal, budget) => input.route(signal, budget));
  const semanticPromise = routePromise.then(async result => {
    if (result) diagnostic.route = { status: result.status, reason: result.reason, startedAt: result.startedAt, finishedAt: result.finishedAt };
    const failedRoute = diagnostic.route.status === 'failed' || diagnostic.route.status === 'timeout';
    const route = result?.status === 'ready' ? result.route : failedRoute ? input.fallbackRoute : null;
    if (!route || route.mode === 'background_only') {
      diagnostic.semantic.reason = result?.route?.mode === 'background_only' ? 'background_only' : 'route_unavailable';
      return { bundle: null, route: result?.route ?? null };
    }
    if (failedRoute) deadline = startedAt + CHAT_MEMORY_PREPARATION_TIMEOUT_MS.fallbackTotal;
    // Both bundles share one material revision allowance. Finish/stop local writes
    // before enhanced preparation, rather than racing two writers to that state.
    await localPromise;
    if (failedRoute) diagnostic.semantic.reason = 'route_fallback';
    return { bundle: await stage('semantic', (signal, _budget, reporter) => input.semantic(route, signal, reporter)), route };
  });
  let local: MemoryBundle | null;
  let semantic: { bundle: MemoryBundle | null; route: MemoryRecallRoute | null };
  try { [local, semantic] = await Promise.all([localPromise, semanticPromise]); }
  catch (error) {
    diagnostic.status = 'failed'; diagnostic.reason = 'cancelled'; diagnostic.finishedAt = Date.now(); notify();
    throw error;
  }
  if (input.signal?.aborted) throw cancelled();
  const route = semantic.route;
  for (const [name, bundle] of [['local', local], ['semantic', semantic.bundle]] as const) {
    const reason = bundle?.debug.auxiliaryFailures?.[0];
    if (reason) { diagnostic[name].status = 'failed'; diagnostic[name].reason = reason; }
  }
  const failure = [diagnostic.route, diagnostic.semantic, diagnostic.local].find(item => item.status === 'failed' || item.status === 'timeout');
  if (diagnostic.semantic.status === 'ready') diagnostic.status = 'ready';
  else if (failure) { diagnostic.status = failure.status as 'failed' | 'timeout'; diagnostic.reason = failure.reason; }
  else { diagnostic.status = 'not_started'; diagnostic.reason = diagnostic.route.reason ?? 'background_only'; }
  diagnostic.finishedAt = Date.now();
  notify();
  return { bundle: semantic.bundle ?? local, route, diagnostic };
}
