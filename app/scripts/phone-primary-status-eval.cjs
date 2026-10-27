const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const src = path.resolve(__dirname, '../src');
function compile(file, dependencies) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(src, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('module', 'exports', 'require', code)(module, module.exports, id => {
    if (!Object.hasOwn(dependencies, id)) throw Error(`Unexpected dependency: ${id}`);
    return dependencies[id];
  });
  return module.exports;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function scenario({ os = 'android', activation, local, shared, fail = false }) {
  const updates = []; let effect, poll, cleanup, reads = 0;
  const originalSetInterval = global.setInterval, originalClearInterval = global.clearInterval;
  global.setInterval = (fn, ms) => { assert.equal(ms, 5000); poll = fn; return 17; };
  global.clearInterval = id => assert.equal(id, 17);
  try {
    const { useProactiveControlStatus } = compile('proactive/useProactiveControlStatus.ts', {
      react: { useState: initial => [typeof initial === 'function' ? initial() : initial, value => updates.push(value)],
        useEffect: fn => { effect = fn; } },
      'react-native': { Platform: { OS: os } },
      './proactiveDeviceControl': { getProactiveDeviceControl: () => shared ? { snapshot: () => shared } : undefined },
      '../runtime/phonePrimaryRuntime': { loadPhonePrimaryActivation: async () => {
        reads++; if (fail) throw Error('unreadable'); return activation;
      } },
      './unifiedContactStore': { readUnifiedContactState: async () => local },
      './unifiedContact': { contactLocalDay: () => '2026-10-27' },
    });
    useProactiveControlStatus(); cleanup = effect();
    await flush();
    poll(); await flush();
    return { updates, reads };
  } finally {
    cleanup?.(); global.setInterval = originalSetInterval; global.clearInterval = originalClearInterval;
  }
}
(async () => {
  const presentation = compile('proactive/proactiveControlPresentation.ts', {});
  const ready = (await scenario({ activation: { activatedAt: 1 }, local: { day: '2026-10-27', used: 9 } })).updates.at(-1);
  assert.equal(ready.used, 9);
  assert.equal(presentation.proactiveContactDeviceLabel(ready), '手机（独立运行）');
  assert.equal(presentation.proactiveContactSourceLabel(ready), '本机执行，无需两端操作信号');
  const nextDay = (await scenario({ activation: { activatedAt: 1 }, local: { day: '2026-10-26', used: 12 } })).updates.at(-1);
  assert.equal(nextDay.used, 0, 'Yesterday count is projected for display only, never written');
  const pending = (await scenario({})).updates.at(-1);
  assert.equal(pending.used, null);
  assert.equal(pending.waitReason, 'phone-primary-handover-pending');
  assert.equal((await scenario({ fail: true })).updates.at(-1), null);
  const shared = { day: '2026-10-27', used: 4, routeDeviceId: 'pc', waitReason: null,
    participants: [{ deviceId: 'pc', platform: 'windows', fresh: true, sampleStatus: 'ready' }] };
  const windows = await scenario({ os: 'windows', shared });
  assert.equal(windows.reads, 0);
  assert.equal(windows.updates.at(-1).used, 4);
  assert.equal(presentation.proactiveContactDeviceLabel(windows.updates.at(-1)), '电脑');
  const mobile = { waitReason: 'phone-primary-on-mobile', used: null, participants: [], contactDeviceId: null, day: null };
  assert.equal(presentation.proactiveContactWaitLabel(mobile), '电脑保留手动功能与同步');
  assert.equal(presentation.proactiveContactSourceLabel(mobile), '自动生活和主动由手机处理');
  console.log('phone-primary-status: 6 groups passed; real hook/presentation, RAM ports only, no activation/write/model');
})().catch(error => { console.error(error); process.exitCode = 1; });
