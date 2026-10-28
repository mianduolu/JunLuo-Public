const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync('src/runtime/useHomeBackgroundAiStatus.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let n = 0; n < 25; n++) await Promise.resolve(); };
function harness(initialState = 'active') {
  const states = [], effects = [], intervals = new Set(), changes = new Set(), updates = new Set(), appChanges = new Set();
  let cursor = 0, effectIndex = 0, epoch = 1, active = true, readCount = 0, policyRead;
  const exports = {};
  const mocks = {
    react: {
      useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
      useEffect(work, deps) { const index = effectIndex++, old = effects[index]; if (old && deps.length === old.deps.length && deps.every((d, i) => d === old.deps[i])) return; old?.cleanup?.(); effects[index] = { deps, cleanup: work() }; },
    },
    'react-native': { AppState: { currentState: initialState, addEventListener: (_, listener) => { appChanges.add(listener); return { remove: () => appChanges.delete(listener) }; } } },
    '../ai/aiRuntimeScheduler': { loadAiRuntimeSnapshot: async () => ({ current: null, records: [] }) },
    '../ai/assistantLifeGenerationDiagnostics': { loadAssistantLifeGenerationDiagnostics: async () => [] },
    '../proactive/unifiedContactStore': { readUnifiedContactState: async () => ({ current: null }) },
    '../ai/assistantState': {
      subscribeAssistantStateChanged: listener => { changes.add(listener); return () => changes.delete(listener); },
      subscribeNearStatusUpdating: listener => { updates.add(listener); return () => updates.delete(listener); },
    },
    '../backup/backupRestoreCoordinator': { captureBackupRestoreDataEpoch: () => epoch, canCommitBackupRestoreDataEpoch: captured => captured !== null && captured === epoch },
    './automaticRemoteAiPolicy': { loadAutomaticRemoteAiPolicy: options => { assert.equal(options.strict, true); readCount++; return policyRead?.() ?? Promise.resolve({ enabled: true }); } },
    './homeBackgroundAiPresentation': { presentHomeBackgroundAi: input => ({ tone: 'neutral', title: String(input.enabled), detail: 'synthetic technical view' }) },
  };
  new Function('require', 'exports', 'setInterval', 'clearInterval', js)(name => { assert(name in mocks, `Forbidden dependency ${name}`); return mocks[name]; }, exports,
    (work, ms) => { assert.equal(ms, 15000); intervals.add(work); return work; }, work => intervals.delete(work));
  return {
    render(nextActive = active) { active = nextActive; cursor = 0; effectIndex = 0; return exports.useHomeBackgroundAiStatus(active); },
    read: () => exports.readHomeBackgroundAiStatus(),
    setPolicyRead: work => { policyRead = work; },
    tick: () => [...intervals].forEach(work => work()),
    changed: () => [...changes].forEach(work => work()),
    updating: () => [...updates].forEach(work => work()),
    app: state => [...appChanges].forEach(work => work(state)),
    changeEpoch: () => { epoch++; },
    unmount: () => effects.forEach(item => item.cleanup?.()),
    get reads() { return readCount; }, get timers() { return intervals.size; },
    get subscriptions() { return changes.size + updates.size + appChanges.size; },
  };
}
(async () => {
  const hidden = harness(); hidden.render(false); await settle(); assert.equal(hidden.reads, 0); assert.equal(hidden.timers, 0); hidden.unmount();
  const background = harness('background'); background.render(); await settle(); assert.equal(background.reads, 0); background.app('active'); background.render(); await settle(); assert.equal(background.reads, 1); background.unmount();
  const live = harness(); live.render(); await settle(); assert.equal(live.render().snapshot.view.title, 'true'); assert.equal(live.timers, 1); live.tick(); await settle(); assert.equal(live.reads, 2); live.unmount(); assert.equal(live.subscriptions, 0); assert.equal(live.timers, 0);
  const racing = harness(), first = defer(), second = defer(); let reads = 0;
  racing.setPolicyRead(() => ++reads === 1 ? first.promise : second.promise); racing.render(); racing.updating(); racing.tick(); assert.equal(racing.reads, 1);
  first.resolve({ enabled: true }); await settle(); assert.equal(racing.reads, 2); assert.equal(racing.render().snapshot, null);
  second.resolve({ enabled: false }); await settle(); assert.equal(racing.render().snapshot.view.title, 'false'); racing.unmount();
  const leaving = harness(), old = defer(); leaving.setPolicyRead(() => old.promise); leaving.render(); leaving.app('background'); leaving.render(); old.resolve({ enabled: true }); await settle(); assert.equal(leaving.render().snapshot, null); assert.equal(leaving.timers, 0); leaving.unmount();
  const failed = harness(); failed.setPolicyRead(() => Promise.reject(Error('synthetic private failure'))); failed.render(); await settle(); assert.equal(failed.render().readFailed, true); failed.setPolicyRead(() => Promise.resolve({ enabled: true })); failed.changed(); await settle(); assert.equal(failed.render().readFailed, false); failed.unmount();
  const restored = harness(), stale = defer(); restored.setPolicyRead(() => stale.promise); restored.render(); restored.changeEpoch(); stale.resolve({ enabled: true }); await settle(); assert.equal(restored.render().snapshot, null); assert.equal(restored.render().readFailed, true); restored.unmount();
  console.log('home-background-ai-status-read: 7/7 groups passed; readonly RAM ports, model=0, writes=0');
})().catch(error => { console.error(error); process.exitCode = 1; });
