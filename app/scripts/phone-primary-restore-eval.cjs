const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(name, ports) {
  const module = { exports: {} };
  const text = fs.readFileSync(path.resolve(__dirname, '../src', name), 'utf8');
  const code = ts.transpileModule(text, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  new Function('module', 'exports', 'require', code)(module, module.exports, id => {
    assert(Object.hasOwn(ports, id), `Unexpected dependency: ${id}`); return ports[id];
  });
  return module.exports;
}
(async () => {
  const policy = load('backup/ordinaryBackupPolicy.ts', {
    '../theater/theaterLocalState': { isTheaterLocalStorageKey: () => false },
    '../chat/chatReplyDraft': { CHAT_REPLY_DRAFT_KEY: 'synthetic-draft' },
    '../life/sleepPlanPolicy': { SLEEP_REPLY_DRAFT_KEY: 'synthetic-sleep-draft' },
  });
  const key = 'junluo.runtime.phonePrimaryActivation.v1';
  assert.equal(policy.isOrdinaryBackupStorageKey(key), false);
  assert.deepEqual(policy.sanitizeOrdinaryBackupStorage({ [key]: 'local-only', 'junluo.example': 'real-record' }), {
    'junluo.example': 'real-record',
  });
  let cleared = 0;
  const state = load('backup/restoreNotificationState.ts', {
    '../runtime/phonePrimaryRuntime': { clearPhonePrimaryActivation: async () => { cleared++; throw Error('synthetic-remove-failure'); } },
  });
  await assert.rejects(state.reconcileRestoredNotificationState(), /synthetic-remove-failure/);
  assert.equal(cleared, 1, 'Restore invalidates the device marker before continuing other recovery');
  console.log('phone-primary-restore: backup excludes only local activation; restore invalidation failure stops continuation');
})().catch(error => { console.error(error); process.exitCode = 1; });
