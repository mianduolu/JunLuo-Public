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

// Real TypeScript modules, isolated RAM ports. Unexpected native or network imports fail closed.
function load(relative, mocks = {}, cache = new Map()) {
  if (cache.has(relative)) return cache.get(relative).exports;
  const module = { exports: {} }; cache.set(relative, module);
  const code = ts.transpileModule(fs.readFileSync(sourcePath(relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (!name.startsWith('.')) throw new Error(`Unmocked platform import: ${name}`);
    const next = path.posix.normalize(path.posix.join(path.posix.dirname(relative), name.replace(/\\/g, '/')));
    return load(next.endsWith('.ts') ? next : `${next}.ts`, mocks, cache);
  }, module, module.exports);
  return module.exports;
}

const backup = load('app/src/backup/backupRestoreCoordinator.ts');
const backupMocks = { '../backup/backupRestoreCoordinator': backup };
const executorPath = 'app/src/runtime/phonePrimaryInternalExecution.ts';
const internal = load(executorPath, backupMocks);
const operationIdMock = { createSyncExecutionOperationId: value => JSON.stringify(value) };
const coreMocks = { '../sync/syncExecutionOperationId': operationIdMock };
const alarmCore = load('app/src/schedule/alarmExecutionOnceCore.ts', coreMocks);
const toolCore = load('app/src/tools/toolCallExecutionOnceCore.ts', coreMocks);
let sequence = 0;
const activation = 1_000;
const settle = () => new Promise(resolve => setImmediate(resolve));

function memoryStorage() {
  const data = new Map();
  const counts = { get: 0, set: 0 };
  const storage = {
    async getItem(key) { counts.get++; return data.get(key) ?? null; },
    async setItem(key, value) { counts.set++; data.set(key, value); },
  };
  return { data, counts, storage };
}

function fixture(options = {}) {
  const memory = options.memory ?? memoryStorage();
  const counts = { execute: 0, fence: 0 };
  let businessReceipt = options.receipt ?? null;
  let current = true;
  const create = (overrides = {}, freshModule = false) => (
    freshModule ? load(executorPath, backupMocks) : internal
  ).createPhonePrimaryInternalExecutor({
    mode: 'new-side-effect', activatedAt: activation, identityScope: 'synthetic-phone',
    dataEpoch: backup.captureBackupRestoreDataEpoch(), isCurrent: async () => current,
    loadFence: async () => { counts.fence++; return options.fence ?? null; },
    sideEffectStorage: memory.storage, now: () => 5_000, ...overrides,
  });
  const input = {
    operationId: `side-effect-fixture-${++sequence}`, category: options.category ?? 'tool-call', createdAt: 3_000,
    reconcile: async () => businessReceipt,
    execute: async () => { counts.execute++; return options.outcome ?? 'completed'; },
  };
  return { memory, counts, create, input, setReceipt: value => { businessReceipt = value; },
    setCurrent: value => { current = value; } };
}

function adapterFixture(kind, { paired = true, platform = 'android', outcome = 'completed', fence = null,
  memory = memoryStorage(), handoff = true, activatedAt = activation } = {}) {
  const counts = { execute: 0, backend: 0, relay: 0, ensure: 0, fence: 0, apply: 0 };
  const id = `adapter-${kind}-${++sequence}`;
  let receipt = null;
  let record = { id, createdAt: 3_000, updatedAt: 3_000, status: 'pending', soundMode: 'music', musicPlayStatus: 'pending' };
  const enrollment = paired ? { publicIdentity: { vaultId: 'v', keyId: 'k', deviceId: 'd' } } : null;
  const mocks = {
    ...backupMocks,
    'react-native': { Platform: { OS: platform } },
    '@react-native-async-storage/async-storage': { __esModule: true, default: memory.storage },
    '../runtime/phonePrimaryRuntime': {
      ensurePhonePrimaryActivation: async () => { counts.ensure++; return handoff ? { activatedAt } : undefined; },
      loadPhonePrimaryActivation: async () => handoff ? { activatedAt } : undefined,
    },
    '../sync/syncExecutionFenceSqlitePort': { AndroidSyncExecutionFenceV2SqlitePort: class {
      async load() { counts.fence++; return fence; }
    } },
    '../sync/syncRelayClientExpo': { loadCurrentSyncRelayEnrollment: async () => enrollment },
    '../backend/backendClient': { loadBackendSettings: async () => { counts.backend++; throw Error('synthetic backend offline'); } },
    '../sync/syncExecutionOnceExpo': { createAndroidSyncExecutionOnceController: async () => {
      counts.relay++; throw Error('synthetic relay offline');
    } },
    '../sync/syncExecutionOperationId': operationIdMock,
    './alarmStore': {
      loadAlarmRecordById: async () => ({ ...record }),
      applyAlarmExecutionReceipt: async (_id, value, at) => {
        counts.apply++;
        record = { ...record, status: value === 'cancelled' ? 'cancelled' : 'delivered',
          musicPlayStatus: value === 'failed' ? 'failed' : 'played', updatedAt: at };
      },
      cancelAlarmRecord: async () => { counts.execute++; record = { ...record, status: 'cancelled' }; return record; },
    },
  };
  const callbacks = {
    reconcileLocally: async () => receipt,
    executeLocally: async () => { counts.execute++; return outcome; },
    applyReceipt: async () => { counts.apply++; },
  };
  const identity = { callId: id, createdAt: 3_000, toolId: 'browser.open' };
  const source = kind === 'alarm' ? 'app/src/schedule/alarmExecutionOnce.ts' : 'app/src/tools/toolCallExecutionOnce.ts';
  const open = () => {
    const adapter = load(source, mocks);
    return () => kind === 'alarm'
      ? adapter.executeAlarmHandlingOnce(id, callbacks.executeLocally)
      : adapter.executeToolCallOnce(identity, callbacks);
  };
  return { counts, memory, mocks, callbacks, identity, open,
    setReceipt: value => { receipt = value; },
    clearAlarmReceipt: () => { record = { ...record, status: 'pending', musicPlayStatus: 'pending' }; } };
}

let passed = 0;
async function check(label, work) { await work(); console.log(`PASS ${++passed} ${label}`); }

async function main() {
  for (const kind of ['alarm', 'tool']) {
    for (const paired of [false, true]) {
      await check(`${kind} Android ${paired ? 'paired' : 'unpaired'} executes once without backend`, async () => {
        const f = adapterFixture(kind, { paired }); const run = f.open();
        assert.equal((await run()).outcome, 'completed');
        assert.equal((await run()).outcome, 'completed');
        assert.equal(f.counts.execute, 1); assert.equal(f.counts.backend, 0); assert.equal(f.counts.relay, 0);
        assert.equal(f.counts.ensure, 2); assert.ok(f.memory.counts.set >= 2);
      });
    }
    for (const outcome of ['completed', 'failed', 'cancelled']) {
      await check(`${kind} persisted ${outcome} survives fresh adapter without business receipt`, async () => {
        const f = adapterFixture(kind, { outcome });
        assert.equal((await f.open()()).outcome, outcome); f.clearAlarmReceipt();
        assert.equal((await f.open()()).outcome, outcome); assert.equal(f.counts.execute, 1);
        assert.equal(f.counts.backend, 0); assert.equal(f.counts.relay, 0);
      });
    }
    await check(`${kind} missing phone handoff stops instead of falling through to relay`, async () => {
      const f = adapterFixture(kind, { handoff: false });
      await assert.rejects(f.open()(), /needs-reconciliation/);
      assert.equal(f.counts.execute, 0); assert.equal(f.counts.backend, 0); assert.equal(f.counts.relay, 0);
    });
    await check(`${kind} unpaired adapter still rejects a source older than actual activation`, async () => {
      const f = adapterFixture(kind, { paired: false, activatedAt: 4_000 });
      await assert.rejects(f.open()(), /needs-reconciliation/);
      assert.equal(f.counts.execute, 0); assert.equal(f.counts.fence, 1);
      assert.equal(f.counts.backend, 0); assert.equal(f.counts.relay, 0); assert.equal(f.memory.counts.set, 0);
    });
    await check(`${kind} unpaired adapter still reads and preserves an old started fence`, async () => {
      const f = adapterFixture(kind, { paired: false, fence: { protocolVersion: 2, state: 'started' } });
      await assert.rejects(f.open()(), /needs-reconciliation/);
      assert.equal(f.counts.execute, 0); assert.equal(f.counts.fence, 1);
      assert.equal(f.counts.backend, 0); assert.equal(f.counts.relay, 0); assert.equal(f.memory.counts.set, 0);
    });
  }

  for (const category of ['alarm', 'tool-call']) {
    await check(`${category} unknown side effect after exception cannot replay after RAM restart`, async () => {
      const f = fixture({ category });
      f.input.execute = async () => { f.counts.execute++; throw Error('synthetic action outcome unknown'); };
      await assert.rejects(f.create()(f.input), /synthetic action outcome unknown/);
      assert.equal((await f.create({}, true)(f.input)).state, 'reconciliation-required');
      assert.equal(f.counts.execute, 1);
    });
    await check(`${category} outcome write failure preserves started marker across RAM restart`, async () => {
      const f = fixture({ category }); const originalSet = f.memory.storage.setItem;
      let writes = 0;
      f.memory.storage.setItem = async (key, value) => {
        if (++writes === 2) throw Error('synthetic outcome storage failed');
        return originalSet(key, value);
      };
      await assert.rejects(f.create()(f.input), /synthetic outcome storage failed/);
      f.memory.storage.setItem = originalSet;
      assert.equal((await f.create({}, true)(f.input)).state, 'reconciliation-required');
      assert.equal(f.counts.execute, 1);
    });
  }
  await check('failure to store started prevents the external action entirely', async () => {
    const f = fixture(); f.memory.storage.setItem = async () => { throw Error('synthetic started storage failed'); };
    await assert.rejects(f.create()(f.input), /synthetic started storage failed/); assert.equal(f.counts.execute, 0);
  });
  await check('unreadable side effect marker prevents starting the external action', async () => {
    const f = fixture(); f.memory.storage.getItem = async () => { throw Error('synthetic marker read failed'); };
    await assert.rejects(f.create()(f.input), /synthetic marker read failed/); assert.equal(f.counts.execute, 0);
  });
  await check('corrupt persisted marker never becomes absence or a completed receipt', async () => {
    const f = fixture(); await f.create()(f.input);
    for (const key of f.memory.data.keys()) f.memory.data.set(key, '{');
    await assert.rejects(f.create({}, true)(f.input)); assert.equal(f.counts.execute, 1);
  });

  for (const fence of [
    { protocolVersion: 1 },
    ...['claimed', 'started', 'completion-prepared'].map(state => ({ protocolVersion: 2, state })),
  ]) {
    await check(`old ${fence.state ?? 'legacy'} fence cannot authorize a new side effect`, async () => {
      const f = fixture({ fence });
      assert.equal((await f.create()(f.input)).state, 'reconciliation-required');
      assert.equal(f.counts.execute, 0); assert.equal(f.memory.counts.set, 0);
    });
  }
  await check('pre-activation source without proof cannot be replayed', async () => {
    const f = fixture(); f.input.createdAt = activation - 1;
    assert.equal((await f.create()(f.input)).state, 'reconciliation-required'); assert.equal(f.counts.execute, 0);
  });
  await check('a real local business receipt reconciles an old started action without replay', async () => {
    const f = fixture({ fence: { protocolVersion: 2, state: 'started' }, receipt: 'completed' });
    f.input.createdAt = activation - 1;
    assert.equal((await f.create()(f.input)).outcome, 'completed'); assert.equal(f.counts.execute, 0);
  });
  await check('a persisted unknown action may be reconciled only by a real business receipt', async () => {
    const f = fixture(); f.input.execute = async () => { f.counts.execute++; throw Error('synthetic unknown'); };
    await assert.rejects(f.create()(f.input), /synthetic unknown/); f.setReceipt('failed');
    assert.equal((await f.create({}, true)(f.input)).outcome, 'failed'); assert.equal(f.counts.execute, 1);
  });
  await check('started marker survives activation change for the same identity scope', async () => {
    const f = fixture(); f.input.execute = async () => { f.counts.execute++; throw Error('synthetic unknown'); };
    await assert.rejects(f.create()(f.input), /synthetic unknown/);
    assert.equal((await f.create({ activatedAt: 2_000 }, true)(f.input)).state, 'reconciliation-required');
    assert.equal(f.counts.execute, 1);
  });
  await check('different identity scopes do not share another world receipt', async () => {
    const f = fixture(); assert.equal((await f.create()(f.input)).outcome, 'completed');
    assert.equal((await f.create({ identityScope: 'another-synthetic-world' }, true)(f.input)).outcome, 'completed');
    assert.equal(f.counts.execute, 2);
  });
  await check('changed source identity for one persisted operation is rejected', async () => {
    const f = fixture(); await f.create()(f.input);
    await assert.rejects(f.create({}, true)({ ...f.input, createdAt: 3_001 })); assert.equal(f.counts.execute, 1);
  });
  await check('same operation concurrent callers share a single side effect', async () => {
    const f = fixture(); let release;
    f.input.execute = async () => { f.counts.execute++; await new Promise(resolve => { release = resolve; }); return 'completed'; };
    const run = f.create(), a = run(f.input), b = run(f.input); assert.equal(a, b);
    await settle(); release(); await Promise.all([a, b]); assert.equal(f.counts.execute, 1);
  });
  await check('new activation cannot duplicate an already started same-scope operation', async () => {
    const f = fixture(); let release;
    f.input.execute = async () => { f.counts.execute++; await new Promise(resolve => { release = resolve; }); return 'completed'; };
    const original = f.create()(f.input); await settle();
    assert.equal((await f.create({ activatedAt: 2_000 })(f.input)).state, 'reconciliation-required');
    release(); await original; assert.equal(f.counts.execute, 1);
  });
  await check('future not-before and stale epoch never start a side effect', async () => {
    const f = fixture(); assert.equal((await f.create()({ ...f.input, notBefore: 6_000 })).state, 'deferred');
    const run = f.create(); backup.markBackupRestoreRestoring('synthetic restore');
    try { assert.equal((await run(f.input)).state, 'reconciliation-required'); }
    finally { backup.markBackupRestoreRuntimeReady(); }
    assert.equal(f.counts.execute, 0); assert.equal(f.memory.counts.set, 0);
  });
  await check('scope invalidation after async fence read cannot start the action', async () => {
    const f = fixture(); let release;
    const run = f.create({ loadFence: () => new Promise(resolve => { release = resolve; }) });
    const result = run(f.input); await settle(); f.setCurrent(false); release(null);
    assert.equal((await result).state, 'reconciliation-required'); assert.equal(f.counts.execute, 0);
  });
  await check('scope invalidation during async started write prevents the action and preserves unknown state', async () => {
    const f = fixture(); const originalSet = f.memory.storage.setItem; let release;
    f.memory.storage.setItem = async (key, value) => {
      await originalSet(key, value);
      await new Promise(resolve => { release = resolve; });
    };
    const result = f.create()(f.input); await settle(); assert.equal(typeof release, 'function');
    f.setCurrent(false); release();
    assert.equal((await result).state, 'reconciliation-required'); assert.equal(f.counts.execute, 0);
    assert.equal(f.memory.data.size, 1);
    assert.equal(JSON.parse([...f.memory.data.values()][0]).state, 'started');
    f.memory.storage.setItem = originalSet; f.setCurrent(true);
    assert.equal((await f.create({}, true)(f.input)).state, 'reconciliation-required'); assert.equal(f.counts.execute, 0);
  });
  await check('epoch invalidation during async started write prevents the action after restore too', async () => {
    const f = fixture(); const originalSet = f.memory.storage.setItem; let release;
    f.memory.storage.setItem = async (key, value) => {
      await originalSet(key, value);
      await new Promise(resolve => { release = resolve; });
    };
    const result = f.create()(f.input); await settle(); assert.equal(typeof release, 'function');
    try {
      backup.markBackupRestoreRestoring('synthetic restore during started write');
      release();
      assert.equal((await result).state, 'reconciliation-required'); assert.equal(f.counts.execute, 0);
      assert.equal(f.memory.data.size, 1);
      assert.equal(JSON.parse([...f.memory.data.values()][0]).state, 'started');
    } finally {
      release(); backup.markBackupRestoreRuntimeReady();
    }
    f.memory.storage.setItem = originalSet;
    assert.equal((await f.create({}, true)(f.input)).state, 'reconciliation-required'); assert.equal(f.counts.execute, 0);
  });
  await check('new side-effect mode rejects wallet and life categories', async () => {
    const f = fixture(), run = f.create();
    for (const category of ['wallet-transaction', 'life-tick', 'reminder']) {
      assert.throws(() => run({ ...f.input, category }), /category-invalid/);
    }
    assert.equal(f.counts.execute, 0);
  });

  for (const kind of ['alarm', 'tool']) {
    await check(`${kind} core without phone port keeps original paired relay route`, async () => {
      let backend = 0, relay = 0;
      const ports = {
        syncEnrollmentReady: true, loadRelayBaseUrl: async () => { backend++; return 'synthetic-relay'; },
        createCoordinator: async () => ({ execute: async () => { relay++; return { state: 'completed', outcome: 'completed', completedAt: 5_000 }; } }),
        executeLocally: async () => { throw Error('must not execute locally'); },
        loadAlarm: async () => ({ id: 'pc-alarm', createdAt: 3_000, updatedAt: 3_000, status: 'pending', soundMode: 'music' }),
        reconcileLocally: async () => null, applyReceipt: async () => undefined,
      };
      const result = kind === 'alarm' ? await alarmCore.runAlarmHandlingOnce('pc-alarm', ports)
        : await toolCore.runToolCallExecutionOnce({ callId: 'pc-call', createdAt: 3_000, toolId: 'browser.open' }, ports);
      assert.equal(result.outcome, 'completed'); assert.equal(backend, 1); assert.equal(relay, 1);
    });
    await check(`${kind} non-Android adapter does not activate phone ownership`, async () => {
      const f = adapterFixture(kind, { platform: 'windows' });
      await assert.rejects(f.open()(), /synthetic backend offline/);
      assert.equal(f.counts.ensure, 0); assert.equal(f.counts.backend, 1); assert.equal(f.counts.execute, 0);
    });
  }
  await check('tool unresolved attempt guard runs before phone executor', async () => {
    let entered = 0;
    await assert.rejects(toolCore.runToolCallExecutionOnce({ callId: 'blocked', createdAt: 3_000, toolId: 'browser.open' }, {
      syncEnrollmentReady: true, hasUnresolvedAttempt: async () => true,
      phonePrimaryExecute: async () => { entered++; throw Error('must not enter'); },
      executeLocally: async () => { throw Error('must not execute'); }, reconcileLocally: async () => null,
      applyReceipt: async () => undefined, loadRelayBaseUrl: async () => { throw Error('must not load backend'); },
      createCoordinator: async () => { throw Error('must not use relay'); },
    }), /tool-call-needs-reconciliation/);
    assert.equal(entered, 0);
  });
  console.log(JSON.stringify({ passed, mode: 'RAM real TypeScript execution', realDevice: false,
    modelRequests: 0, networkRequests: 0, realSync: 0, productionBusinessWrites: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
