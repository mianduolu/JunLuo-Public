const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const sourceRoot = path.resolve(__dirname, '../..');
const appRequire = createRequire(path.join(sourceRoot, 'app/package.json'));
const ts = appRequire('typescript');
const candidateIndex = process.argv.indexOf('--candidate-root');
const candidateValue = candidateIndex >= 0 ? process.argv[candidateIndex + 1] : undefined;
if (candidateIndex >= 0 && (!candidateValue || candidateValue.startsWith('--'))) {
  throw new Error('--candidate-root requires a directory');
}
const candidateRoot = candidateValue ? path.resolve(candidateValue) : null;
const sourcePath = relative => path.join(candidateRoot && fs.existsSync(path.join(candidateRoot, relative))
  ? candidateRoot : sourceRoot, relative);

function load(relative, mocks = {}, cache = new Map()) {
  if (cache.has(relative)) return cache.get(relative).exports;
  const module = { exports: {} }; cache.set(relative, module);
  const code = ts.transpileModule(fs.readFileSync(sourcePath(relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(relative), name.replace(/\\/g, '/')));
      return load(next.endsWith('.ts') ? next : `${next}.ts`, mocks, cache);
    }
    return appRequire(name);
  }, module, module.exports);
  return module.exports;
}

const operationIdMock = { createSyncExecutionOperationId: value => JSON.stringify(value) };
const sharedCache = new Map();
const backup = load('app/src/backup/backupRestoreCoordinator.ts', {}, sharedCache);
const { createPhonePrimaryInternalExecutor } = load('app/src/runtime/phonePrimaryInternalExecution.ts', {}, sharedCache);
const life = load('app/src/life/lifeTickExecutionOnceCore.ts', { '../sync/syncExecutionOperationId': operationIdMock });
const schedule = load('app/src/schedule/scheduleCompletionOnceCore.ts', { '../sync/syncExecutionOperationId': operationIdMock });
const todo = load('app/src/schedule/todoCompletionOnceCore.ts', { '../sync/syncExecutionOperationId': operationIdMock });
const activation = 1_000;
const counters = () => ({ relay: 0, backend: 0, fences: 0, execute: 0, apply: 0 });
function fixture(mode = 'new-life', fence = null) {
  const counts = counters(); let receipt = null;
  const executeOnce = createPhonePrimaryInternalExecutor({ activatedAt: activation, mode,
    identityScope: 'fixture-phone', dataEpoch: backup.captureBackupRestoreDataEpoch(), isCurrent: async () => true,
    loadFence: async () => { counts.fences++; return fence; }, now: () => 5_000 });
  const input = { operationId: `fixture:${Math.random()}`, category: mode === 'new-life' ? 'life-tick' : 'reminder',
    createdAt: 2_000, reconcile: async () => receipt,
    execute: async () => { counts.execute++; receipt = 'completed'; return receipt; } };
  return { counts, executeOnce, input, setReceipt: value => { receipt = value; } };
}
let passed = 0;
async function check(label, work) { await work(); console.log(`PASS ${++passed} ${label}`); }
async function main() {
  await check('new phone life uses local receipt and never needs relay', async () => {
    const f = fixture(); assert.equal((await f.executeOnce(f.input)).outcome, 'completed');
    assert.equal((await f.executeOnce(f.input)).outcome, 'completed'); assert.equal(f.counts.execute, 1);
  });
  await check('pre-activation life with no local or remote evidence is retained', async () => {
    const f = fixture(); f.input.createdAt = activation - 1;
    assert.equal((await f.executeOnce(f.input)).state, 'reconciliation-required'); assert.equal(f.counts.execute, 0);
  });
  await check('real business receipt can recover old life without finishing relay', async () => {
    const f = fixture('new-life', { protocolVersion: 1, operationId: 'legacy' }); f.input.createdAt = 1; f.setReceipt('completed');
    assert.equal((await f.executeOnce(f.input)).outcome, 'completed'); assert.equal(f.counts.execute, 0);
  });
  for (const state of ['claimed', 'started', 'completion-prepared']) {
    await check(`old ${state} fence with no business proof cannot replay`, async () => {
      const f = fixture('new-life', { protocolVersion: 2, state });
      assert.equal((await f.executeOnce(f.input)).state, 'reconciliation-required'); assert.equal(f.counts.execute, 0);
    });
  }
  await check('terminal V2 receipt is reused without fake relay writes', async () => {
    const f = fixture(); const fence = { protocolVersion: 2, state: 'completed', category: 'life-tick',
      operationId: f.input.operationId, completion: { operationId: f.input.operationId, state: 'completed', outcome: 'failed', completedAt: 3_000 } };
    const executeOnce = createPhonePrimaryInternalExecutor({ activatedAt: activation, mode: 'new-life',
      identityScope: 'fixture-phone', dataEpoch: backup.captureBackupRestoreDataEpoch(), isCurrent: async () => true,
      loadFence: async () => fence, now: () => 5_000 });
    assert.deepEqual(await executeOnce(f.input), { state: 'completed', outcome: 'failed', completedAt: 3_000 });
    assert.equal(f.counts.execute, 0);
  });
  await check('same new operation joins one active execution', async () => {
    const f = fixture(); let release; f.input.execute = async () => { f.counts.execute++; await new Promise(resolve => { release = resolve; }); return 'completed'; };
    const a = f.executeOnce(f.input), b = f.executeOnce(f.input); assert.equal(a, b);
    await new Promise(resolve => setImmediate(resolve)); release(); await Promise.all([a, b]); assert.equal(f.counts.execute, 1);
  });
  await check('identity change during same flight is rejected', async () => {
    const f = fixture(); let release; f.input.execute = () => new Promise(resolve => { release = resolve; });
    const a = f.executeOnce(f.input); assert.throws(() => f.executeOnce({ ...f.input, createdAt: 2_001 }), /identity-changed/);
    await new Promise(resolve => setImmediate(resolve)); release('completed'); await a;
  });
  await check('failure clears flight and does not invent a completed receipt', async () => {
    const f = fixture(); f.input.execute = async () => { f.counts.execute++; throw new Error('synthetic business failure'); };
    await assert.rejects(f.executeOnce(f.input), /synthetic business failure/);
    await assert.rejects(f.executeOnce(f.input), /synthetic business failure/); assert.equal(f.counts.execute, 2);
  });
  await check('not-before remains enforced and external categories are rejected', async () => {
    const f = fixture(); assert.equal((await f.executeOnce({ ...f.input, notBefore: 6_000 })).state, 'deferred');
    assert.throws(() => f.executeOnce({ ...f.input, category: 'wallet-transaction' }), /category-invalid/); assert.equal(f.counts.execute, 0);
  });
  await check('life core optional port does not load backend or relay', async () => {
    const f = fixture(); let receipt = null;
    const result = await life.runLifeTickExecutionOnce({ bucketStartedAt: 2_000 }, {
      syncEnrollmentReady: true, phonePrimaryExecute: f.executeOnce,
      loadRelayBaseUrl: async () => { throw Error('backend must not load'); }, createCoordinator: async () => { throw Error('relay must not load'); },
      reconcileLocally: async () => receipt, executeLocally: async () => { f.counts.execute++; return receipt = 'completed'; },
      applyReceipt: async () => { f.counts.apply++; },
    }); assert.equal(result.executedNow, true); assert.equal(f.counts.execute, 1);
  });
  await check('shared core without new optional port keeps original relay', async () => {
    let backend = 0, relay = 0;
    await life.runLifeTickExecutionOnce({ bucketStartedAt: 2_000 }, {
      syncEnrollmentReady: true, loadRelayBaseUrl: async () => { backend++; return 'synthetic-relay'; },
      createCoordinator: async () => ({ execute: async () => { relay++; return { state: 'completed', outcome: 'completed', completedAt: 5_000 }; } }),
      reconcileLocally: async () => null, executeLocally: async () => { throw Error('unused'); }, applyReceipt: async () => undefined,
    }); assert.equal(backend, 1); assert.equal(relay, 1);
  });
  for (const kind of ['schedule', 'todo']) {
    await check(`${kind} completion uses existing round CAS and one concurrent write`, async () => {
      const f = fixture('local-completion'); let record = { id: kind, itemId: 'item', createdAt: 1, status: 'pending', completionRound: 4 };
      const complete = async (_id, round) => { assert.equal(round, record.completionRound); if (record.status === 'completed') return { changed: false, notificationIds: [] };
        f.counts.execute++; record = { ...record, status: 'completed' }; return { changed: true, notificationIds: ['synthetic-notification'] }; };
      const ports = { syncEnrollmentReady: true, phonePrimaryExecute: f.executeOnce, loadOccurrence: async () => ({ ...record }), loadTodo: async () => ({ ...record }),
        loadItemCreatedAt: async () => 1, completeLocally: complete, applyCompletionReceipt: async () => ({ changed: false, notificationIds: [] }),
        loadRelayBaseUrl: async () => { throw Error('no backend'); }, createCoordinator: async () => { throw Error('no relay'); } };
      const run = () => kind === 'schedule' ? schedule.runScheduleOccurrenceCompletionOnce(kind, ports) : todo.runTodoCompletionOnce(kind, ports);
      await Promise.all([run(), run()]); assert.equal(f.counts.execute, 1); assert.equal(record.status, 'completed');
    });
    await check(`${kind} old unresolved fence prevents side effect`, async () => {
      const f = fixture('local-completion', { protocolVersion: 1 });
      const ports = { syncEnrollmentReady: true, phonePrimaryExecute: f.executeOnce,
        loadOccurrence: async () => ({ id: kind, itemId: 'item', status: 'pending', completionRound: 0 }),
        loadTodo: async () => ({ id: kind, createdAt: 1, status: 'today', completionRound: 0 }), loadItemCreatedAt: async () => 1,
        completeLocally: async () => { throw Error('must not execute'); }, applyCompletionReceipt: async () => { throw Error('must not adopt'); },
        loadRelayBaseUrl: async () => { throw Error('no backend'); }, createCoordinator: async () => { throw Error('no relay'); } };
      await assert.rejects(kind === 'schedule' ? schedule.runScheduleOccurrenceCompletionOnce(kind, ports) : todo.runTodoCompletionOnce(kind, ports), /needs-reconciliation/);
    });
    await check(`${kind} changed completion round still rejects`, async () => {
      const f = fixture('local-completion'); let round = 0;
      const ports = { syncEnrollmentReady: true, phonePrimaryExecute: f.executeOnce,
        loadOccurrence: async () => ({ id: kind, itemId: 'item', status: 'pending', completionRound: round++ }),
        loadTodo: async () => ({ id: kind, createdAt: 1, status: 'today', completionRound: round++ }), loadItemCreatedAt: async () => 1,
        completeLocally: async () => { throw Error('must not execute'); }, applyCompletionReceipt: async () => { throw Error('must not adopt'); },
        loadRelayBaseUrl: async () => { throw Error('no backend'); }, createCoordinator: async () => { throw Error('no relay'); } };
      await assert.rejects(kind === 'schedule' ? schedule.runScheduleOccurrenceCompletionOnce(kind, ports) : todo.runTodoCompletionOnce(kind, ports), /source-changed/);
    });
  }
  for (const kind of ['life', 'schedule', 'todo']) {
    await check(`${kind} actual Android adapter uses activation and fence without loading backend`, async () => {
      let activated = 0, fenceReads = 0, executed = 0, receipt = null;
      let record = { id: kind, itemId: 'item', createdAt: 1, status: 'pending', completionRound: 0 };
      const mocks = {
        '../runtime/phonePrimaryRuntime': { ensurePhonePrimaryActivation: async () => { activated++; return { activatedAt: activation }; },
          loadPhonePrimaryActivation: async () => ({ activatedAt: activation }) },
        '../sync/syncExecutionFenceSqlitePort': { AndroidSyncExecutionFenceV2SqlitePort: class { async load() { fenceReads++; return null; } } },
        '../sync/syncRelayClientExpo': { loadCurrentSyncRelayEnrollment: async () => ({ publicIdentity: { vaultId: 'v', keyId: 'k', deviceId: 'd' } }) },
        '../sync/syncExecutionOnceExpo': { createAndroidSyncExecutionOnceController: async () => { throw Error('must not create relay'); } },
        '../backend/backendClient': { loadBackendSettings: async () => { throw Error('must not read backend'); } },
        '../sync/syncExecutionOperationId': operationIdMock,
        './scheduleStore': { loadScheduleItemById: async () => ({ createdAt: 1 }), loadScheduleOccurrence: async () => ({ ...record }),
          completeOccurrenceOnce: async (_id, _time, round) => { assert.equal(round, 0); executed++; record.status = 'completed'; return { changed: true, notificationIds: [] }; },
          applyOccurrenceCompletionReceipt: async () => { throw Error('unused synthetic receipt'); } },
        './todoStore': { loadTodoItemById: async () => ({ ...record }), completeTodoItem: async (_id, options) => {
          assert.equal(options.expectedCompletionRound, 0); executed++; record.status = 'completed'; return { ...record }; } },
      };
      if (kind === 'life') {
        const adapter = load('app/src/life/lifeTickExecutionOnce.ts', mocks);
        await adapter.executeLifeTickOnce({ bucketStartedAt: 2_000 }, { reconcileLocally: async () => receipt,
          executeLocally: async () => { executed++; return receipt = 'completed'; }, applyReceipt: async () => undefined });
      } else if (kind === 'schedule') {
        await load('app/src/schedule/scheduleCompletionOnce.ts', mocks).completeScheduleOccurrenceOnce(kind);
      } else {
        await load('app/src/schedule/todoCompletionOnce.ts', mocks).completeTodoItemOnce(kind);
      }
      assert.equal(activated, 1); assert.equal(fenceReads, 1); assert.equal(executed, 1);
    });
  }
  await check('actual async restore separates same operation from the old flight before execution', async () => {
    let release, oldExecutions = 0, newExecutions = 0;
    const identity = { operationId: 'async-restore-same-operation', category: 'life-tick', createdAt: 3_000,
      reconcile: async () => null, execute: async () => { oldExecutions++; return 'completed'; } };
    const old = createPhonePrimaryInternalExecutor({ activatedAt: activation, mode: 'new-life', identityScope: 'phone',
      dataEpoch: backup.captureBackupRestoreDataEpoch(), isCurrent: async () => true,
      loadFence: () => new Promise(resolve => { release = resolve; }), now: () => 5_000 });
    const oldPromise = old(identity); await new Promise(resolve => setImmediate(resolve));
    backup.markBackupRestoreRestoring('synthetic restore');
    const blocked = old(identity); assert.notEqual(blocked, oldPromise);
    assert.equal((await blocked).state, 'reconciliation-required');
    backup.markBackupRestoreRuntimeReady();
    const fresh = createPhonePrimaryInternalExecutor({ activatedAt: activation, mode: 'new-life', identityScope: 'phone',
      dataEpoch: backup.captureBackupRestoreDataEpoch(), isCurrent: async () => true,
      loadFence: async () => null, now: () => 5_000 });
    const freshPromise = fresh({ ...identity, execute: async () => { newExecutions++; return 'completed'; } });
    assert.notEqual(freshPromise, oldPromise); assert.equal((await freshPromise).state, 'completed');
    release(null); assert.equal((await oldPromise).state, 'reconciliation-required');
    assert.equal(oldExecutions, 0); assert.equal(newExecutions, 1);
  });
  await check('actual async identity handoff separates scope and activation while old source becomes stale', async () => {
    let currentScope = 'scope-a', release, oldExecutions = 0, newExecutions = 0;
    const identity = { operationId: 'async-scope-same-operation', category: 'life-tick', createdAt: 3_000,
      reconcile: async () => null, execute: async () => { oldExecutions++; return 'completed'; } };
    const old = createPhonePrimaryInternalExecutor({ activatedAt: activation, mode: 'new-life', identityScope: 'scope-a',
      dataEpoch: backup.captureBackupRestoreDataEpoch(), isCurrent: async () => currentScope === 'scope-a',
      loadFence: () => new Promise(resolve => { release = resolve; }), now: () => 5_000 });
    const oldPromise = old(identity); await new Promise(resolve => setImmediate(resolve)); currentScope = 'scope-b';
    const fresh = createPhonePrimaryInternalExecutor({ activatedAt: activation + 1, mode: 'new-life', identityScope: 'scope-b',
      dataEpoch: backup.captureBackupRestoreDataEpoch(), isCurrent: async () => currentScope === 'scope-b',
      loadFence: async () => null, now: () => 5_000 });
    const freshPromise = fresh({ ...identity, execute: async () => { newExecutions++; return 'completed'; } });
    assert.notEqual(freshPromise, oldPromise); assert.equal((await freshPromise).state, 'completed');
    release(null); assert.equal((await oldPromise).state, 'reconciliation-required');
    assert.equal(oldExecutions, 0); assert.equal(newExecutions, 1);
  });
  await check('restore during async reconcile prevents starting the business operation', async () => {
    let release, executions = 0;
    const executeOnce = createPhonePrimaryInternalExecutor({ activatedAt: activation, mode: 'new-life', identityScope: 'phone',
      dataEpoch: backup.captureBackupRestoreDataEpoch(), isCurrent: async () => true, loadFence: async () => null, now: () => 5_000 });
    const result = executeOnce({ operationId: 'restore-during-reconcile', category: 'life-tick', createdAt: 3_000,
      reconcile: () => new Promise(resolve => { release = resolve; }), execute: async () => { executions++; return 'completed'; } });
    await new Promise(resolve => setImmediate(resolve)); backup.markBackupRestoreRestoring('synthetic restore');
    release(null); assert.equal((await result).state, 'reconciliation-required'); assert.equal(executions, 0);
    backup.markBackupRestoreRuntimeReady();
  });
  for (const kind of ['life', 'schedule', 'todo']) {
    await check(`${kind} unavailable handoff retains original reconciliation stop with no relay fallback`, async () => {
      let runs = 0;
      const mocks = {
        '../runtime/phonePrimaryRuntime': { ensurePhonePrimaryActivation: async () => undefined, loadPhonePrimaryActivation: async () => undefined },
        '../sync/syncExecutionFenceSqlitePort': { AndroidSyncExecutionFenceV2SqlitePort: class { async load() { throw Error('no fence read without activation'); } } },
        '../sync/syncRelayClientExpo': { loadCurrentSyncRelayEnrollment: async () => ({ publicIdentity: { vaultId: 'v', keyId: 'k', deviceId: 'd' } }) },
        '../sync/syncExecutionOnceExpo': { createAndroidSyncExecutionOnceController: async () => { throw Error('must not fallback to relay'); } },
        '../backend/backendClient': { loadBackendSettings: async () => { throw Error('must not load backend'); } },
        '../sync/syncExecutionOperationId': operationIdMock,
        './scheduleStore': { loadScheduleItemById: async () => ({ createdAt: 1 }),
          loadScheduleOccurrence: async () => ({ id: kind, itemId: 'item', status: 'pending', completionRound: 0 }),
          completeOccurrenceOnce: async () => { runs++; throw Error('unused'); }, applyOccurrenceCompletionReceipt: async () => { throw Error('unused'); } },
        './todoStore': { loadTodoItemById: async () => ({ id: kind, createdAt: 1, status: 'today', completionRound: 0 }),
          completeTodoItem: async () => { runs++; throw Error('unused'); } },
      };
      const result = kind === 'life' ? load('app/src/life/lifeTickExecutionOnce.ts', mocks).executeLifeTickOnce({ bucketStartedAt: 3_000 }, {
        reconcileLocally: async () => null, executeLocally: async () => { runs++; return 'completed'; }, applyReceipt: async () => undefined })
        : kind === 'schedule' ? load('app/src/schedule/scheduleCompletionOnce.ts', mocks).completeScheduleOccurrenceOnce(kind)
          : load('app/src/schedule/todoCompletionOnce.ts', mocks).completeTodoItemOnce(kind);
      await assert.rejects(result, /needs-reconciliation/); assert.equal(runs, 0);
    });
  }
  console.log(JSON.stringify({ passed, mode: 'RAM source execution', realDevice: false, modelRequests: 0, productionWrites: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
