/* Run from the repository root. Actual three-source candidate, RAM ports only; no legacy suite. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = process.cwd();
const flag = process.argv.indexOf('--source-root');
const selected = flag < 0 ? root : path.resolve(process.argv[flag + 1]);
const appRequire = createRequire(path.join(root, 'app/package.json'));
const originalFs = fs;
const changed = ['life/sleepPlanStore.ts', 'life/sleepPlanRuntime.ts', 'proactive/unifiedContactDispatch.ts'];
const fsPort = { ...fs, readFileSync(file, ...args) {
  const relative = path.relative(path.join(root, 'app/src'), String(file)).replaceAll('\\', '/');
  return originalFs.readFileSync(changed.includes(relative) ? path.join(selected, 'app/src', relative) : file, ...args);
} };
const oldHarness = fs.readFileSync(path.join(root, 'app/scripts/sleep-greeting-shared-contact-eval.cjs'), 'utf8');
const end = oldHarness.indexOf('async function suite()');
assert.ok(end > 0);
const { harness, AT, MIN } = new Function('require', '__dirname', oldHarness.slice(0, end)
  + '\ntestedModules.add("ai/aiRuntimeScheduler"); testedModules.add("backup/backupRestoreCoordinator"); return {harness,AT,MIN};')(
  name => name === 'node:fs' ? fsPort : appRequire(name), path.join(root, 'app/scripts'));
const results = [];
async function test(name, work) {
  let timer;
  try { await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('fixture deadline: ' + name)), 5000);
  })]); results.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { results.push({ name, passed: false }); console.error('FAIL ' + name, error); }
  finally { clearTimeout(timer); }
}
const drain = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };
function gate() { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; }
function early() {
  const h = harness(), d = h.night();
  d.sleepTargetAt = AT - 8 * 60 * MIN;
  d.wakeTargetAt = AT + 60 * MIN;
  Object.assign(d.nightSleepPlan, { originalSleepAt: d.sleepTargetAt, actualSleepAt: d.sleepTargetAt,
    originalWakeAt: d.wakeTargetAt, events: [{ id: 'slept', kind: 'sleep', at: d.sleepTargetAt }],
    recovery: { eligible: true, estimatedAt: AT - 1000, sleepStartedAt: d.sleepTargetAt, checkedAt: AT - MIN } });
  h.writeNight(d); Object.assign(h.state, { lifeMode: 'sleeping', wakeSource: undefined,
    manualWakeUntil: undefined, manualSleepUntil: undefined });
  h.stubs['life/lifeRhythm'].getSleepRecoveryProjection = async () => ({ reliable: true, recovered: true });
  h.enableDispatch();
  return h;
}
function holdNear(h, outcome = 'null') {
  const entered = gate(), release = gate(), old = h.stubs['ai/assistantState'].loadAssistantState;
  let first = true;
  h.stubs['ai/assistantState'].loadAssistantState = async () => {
    if (first) { first = false; entered.open(); await release.promise;
      if (outcome === 'error') throw Error('synthetic-near-read');
      return { ...(await old()), lifeMode: 'sleeping' }; }
    return old();
  };
  const runtime = h.load('life/sleepPlanRuntime');
  const work = runtime.createNearStatusSleepOpportunity({ operationId: 'synthetic', epoch: h.epoch(), signal: new AbortController().signal });
  work.catch(() => undefined);
  return { entered: entered.promise, release: release.open, work, runtime };
}
function assertDelivered(h) {
  assert.equal(h.requests.length, 1);
  assert.equal(h.night().nightSleepPlan.wake?.status, 'complete');
  assert.equal(h.messages.filter(message => message.id === 'sleep-plan:2026-10-27:wake').length, 1);
}

(async () => {
  await test('writer returns only a newly saved recoveredEarly fact; loaded morning cannot recreate it', async () => {
    const h = early(), s = h.load('life/sleepPlanStore');
    const fact = await s.settleSleepNight(AT);
    assert.ok(fact, 'the successful new early-wake write must return its fact');
    assert.deepEqual(JSON.parse(JSON.stringify(fact)), { nightKey: '2026-10-27', revision: 0,
      actualSleepAt: AT - 8 * 60 * MIN, morningAwakeAt: AT, formalWakeAt: AT + 60 * MIN });
    assert.equal(await s.settleSleepNight(AT), undefined);
    assert.equal(h.requests.length, 0);
  });
  await test('first fresh tick and its detached handoff have exactly one admission, never skipped', async () => {
    const h = early(); await h.load('life/sleepPlanRuntime').runSleepPlanTick(); await drain(); assertDelivered(h);
    await h.load('life/sleepPlanRuntime').runSleepPlanTick(); await drain(); assert.equal(h.requests.length, 1);
  });
  await test('two simultaneous public ticks race with the handoff but admit exactly one original D', async () => {
    const h = early(), runtime = h.load('life/sleepPlanRuntime');
    await Promise.all([runtime.runSleepPlanTick(), runtime.runSleepPlanTick()]); await drain(); assertDelivered(h);
  });
  await test('outer reconcile life refresh commit must release before the fresh admission', async () => {
    const h = early(), entered = gate(), release = gate(); let first = true, exclusiveEntered = false;
    delete h.stubs['backup/backupRestoreCoordinator'];
    const coordinator = h.load('backup/backupRestoreCoordinator');
    h.stubs['ai/assistantLife'].refreshAssistantLifeState = async () => {
      if (first) { first = false; entered.open(); await release.promise; }
      return { ...h.state };
    };
    const work = h.load('life/sleepPlanRuntime').runSleepPlanTick(); await entered.promise; await drain();
    const exclusive = coordinator.runBackupRestoreExclusive(async () => { exclusiveEntered = true; });
    await drain(); assert.equal(exclusiveEntered, false); assert.equal(h.requests.length, 0);
    release.open(); await work; await exclusive; await drain(); assertDelivered(h); assert.equal(exclusiveEntered, true);
  });
  await test('sleep_status creates fresh wake, old wake payload is still rejected, one D is delivered', async () => {
    const h = early(), runtime = h.load('life/sleepPlanRuntime');
    const status = { id: 'synthetic-status', nightKey: '2026-10-27', phase: 'sleep_status', at: AT };
    h.stubs['life/sleepNearStatusRuntime'].getSleepNearStatusWakeTasks = () => [status];
    h.stubs['life/sleepNearStatusRuntime'].runSleepNearStatusUpdate = async () => false;
    await runtime.handleSleepPlanTask(status);
    await runtime.handleSleepPlanTask({ id: '2026-10-27:wake', nightKey: '2026-10-27', phase: 'wake', at: AT - 1000 });
    await drain(); assertDelivered(h);
  });
  for (const outcome of ['null', 'error']) await test('captured near preflight ' + outcome + ' releases exactly one fresh handoff', async () => {
    const h = early(), near = holdNear(h, outcome); await near.entered;
    await near.runtime.runSleepPlanTick(); await drain(); assert.equal(h.requests.length, 0);
    near.release(); await near.work.catch(() => undefined); await drain(); assertDelivered(h);
  });
  for (const outcome of ['no-session', 'dispose']) await test('captured near ' + outcome + ' exit releases its completion notification', async () => {
    const h = early(), runtime = h.load('life/sleepPlanRuntime'), entered = gate(), release = gate();
    const chat = h.stubs['chat/chatStorage'], old = chat.loadChatStateFast; let first = true;
    chat.loadChatStateFast = async options => {
      if (first && options.activeMessageLimit === 25) {
        first = false; entered.open(); await release.promise;
        if (outcome === 'no-session') return { activeSessionId: 'session', sessions: [] };
      }
      return old(options);
    };
    const work = runtime.createNearStatusSleepOpportunity({ operationId: 'restored-preflight', epoch: h.epoch(),
      signal: new AbortController().signal, resume: { context: h.load('life/sleepPlanStore').sleepContext(h.night(), AT),
        expectedRevision: 0, sessionId: 'session', activeSessionId: 'session', messageKey: 'synthetic', handoff: null } });
    await entered.promise; await runtime.runSleepPlanTick(); assert.equal(h.requests.length, 0);
    release.open(); const opportunity = await work;
    if (outcome === 'dispose') { assert.ok(opportunity); await drain(); assert.equal(h.requests.length, 0); await opportunity.dispose(); }
    else assert.equal(opportunity, null);
    await drain(); assertDelivered(h);
  });
  await test('a different new owner is refused rather than followed after captured near owner completes', async () => {
    const h = early(), first = holdNear(h); await first.entered; await first.runtime.runSleepPlanTick();
    first.release(); await first.work;
    const store = h.load('life/sleepPlanStore'), capture = store.captureNearStatusSleepContext;
    const entered = gate(), release = gate();
    // Gate this actual public preflight only; a generic state-read gate could instead intercept the handoff validator.
    store.captureNearStatusSleepContext = async (...args) => { entered.open(); await release.promise; return capture(...args); };
    const second = first.runtime.createNearStatusSleepOpportunity({ operationId: 'new-owner', epoch: h.epoch(), signal: new AbortController().signal });
    await entered.promise; await drain(); assert.equal(h.requests.length, 0);
    release.open(); await second; await drain(); assert.equal(h.requests.length, 0);
  });
  await test('old tick paused in chat read receives new writer fact without marking it skipped', async () => {
    const h = early(), runtime = h.load('life/sleepPlanRuntime'), entered = gate(), release = gate();
    let recovered = false;
    h.stubs['life/lifeRhythm'].getSleepRecoveryProjection = async () => ({ reliable: true, recovered, recoveryAt: AT });
    const chat = h.stubs['chat/chatStorage'], old = chat.loadChatStateFast; let held = false;
    chat.loadChatStateFast = async options => {
      const value = await old(options);
      if (!held && options.activeMessageLimit === 24) { held = true; entered.open(); await release.promise; }
      return value;
    };
    const first = runtime.runSleepPlanTick(); await entered.promise; recovered = true;
    const next = runtime.runSleepPlanTick(); await drain(); assert.equal(h.requests.length, 0);
    release.open(); await Promise.all([first, next]); await drain(); assertDelivered(h);
  });
  await test('newly saved fact survives a later native replacement failure without hiding the original error', async () => {
    const h = early(), error = Error('synthetic-native-replace'); let first = true;
    h.stubs['life/sleepNativeWake'].replaceSleepNativeWakeTasks = async () => { if (first) { first = false; throw error; } };
    await assert.rejects(h.load('life/sleepPlanRuntime').reconcileSleepPlanLocally(AT, h.epoch(), true), actual => actual === error);
    await drain(); assertDelivered(h);
  });
  await test('captured unified running releases before the fresh writer admission', async () => {
    const h = early(), entered = gate(), release = gate(); let first = true;
    h.stubs['proactive/proactiveDeviceControlAndroid'].ensureAndroidProactiveDeviceControl = async () => {
      if (first) { first = false; entered.open(); await release.promise; }
    };
    const dispatch = h.load('proactive/unifiedContactDispatch');
    const work = dispatch.checkUnifiedContact(); await entered.promise;
    await h.load('life/sleepPlanRuntime').reconcileSleepPlanLocally(AT, h.epoch(), true); await drain();
    assert.equal(h.requests.length, 0); release.open(); await work; await drain(); assertDelivered(h);
  });
  await test('sleepOnly preflight false then writer fresh makes dispatch reject; original tail still delivers once', async () => {
    const h = early(), entered = gate(), release = gate(), chat = h.stubs['chat/chatStorage'];
    const old = chat.loadChatStateFast; let first = true;
    chat.loadChatStateFast = async options => {
      if (first && options.activeMessageLimit === 1) { first = false; entered.open(); await release.promise; }
      return old(options);
    };
    const work = h.load('proactive/unifiedContactDispatch').checkUnifiedContact({ scheduledWakeNight: '2026-10-27' });
    await entered.promise; await h.load('life/sleepPlanRuntime').reconcileSleepPlanLocally(AT, h.epoch(), true);
    assert.equal(h.requests.length, 0); release.open(); await work; await drain(); assertDelivered(h);
  });
  await test('actual schedulerHeld urgent owner including finally-created fresh is not followed or bypassed', async () => {
    const h = early(); delete h.stubs['ai/aiRuntimeScheduler'];
    const scheduler = h.load('ai/aiRuntimeScheduler');
    h.stubs['ai/aiCallBudget'].runBudgetedAiCall = (kind, priority, work) => scheduler.runScheduledAiCall(kind, priority, work);
    const storage = h.stubs['@react-native-async-storage/async-storage'].default;
    const old = storage.setItem, recorded = gate(), release = gate(); let held = false;
    storage.setItem = async (key, value) => {
      if (!held && key === 'junluo.aiRuntimeScheduler.v1' && JSON.parse(value).records?.some(item => item.kind === 'fixture-urgent')) {
        held = true; recorded.open(); await release.promise;
      }
      return old(key, value);
    };
    const dispatch = h.load('proactive/unifiedContactDispatch');
    const work = scheduler.runScheduledAiCall('fixture-urgent', 'urgent', () => dispatch.runUnifiedContact({
      apiKey: 'synthetic', connection: { model: 'fixture' }, profile: {}, schedulerHeld: true,
    }));
    await recorded.promise; await drain();
    assert.equal(h.night().nightSleepPlan.morningAwakeAt, AT);
    assert.equal((await scheduler.loadAiRuntimeSnapshot()).current.kind, 'fixture-urgent');
    assert.equal(h.requests.length, 0);
    release.open(); await work; await drain(); assert.equal(h.requests.length, 0);
    assert.equal((await scheduler.loadAiRuntimeSnapshot()).current, null);
    assert.equal(h.night().nightSleepPlan.wake, undefined);
  });
  await test('ordinary admission keeps its original finally release and an older completion cannot clear a new owner', async () => {
    const h = early(), tailEntered = gate(), tailRelease = gate(), nextEntered = gate(), nextRelease = gate();
    h.stubs['life/lifeRhythm'].getSleepRecoveryProjection = async () => ({ reliable: true, recovered: false, recoveryAt: AT });
    const runtime = h.load('life/sleepPlanRuntime'), reconcile = runtime.reconcileSleepPlanLocally;
    let tails = 0, starts = 0;
    runtime.reconcileSleepPlanLocally = async (...args) => {
      if (++tails === 1) { tailEntered.open(); await tailRelease.promise; }
      return reconcile(...args);
    };
    h.stubs['proactive/proactiveDeviceControlAndroid'].ensureAndroidProactiveDeviceControl = async () => {
      if (++starts === 2) { nextEntered.open(); await nextRelease.promise; }
    };
    const dispatch = h.load('proactive/unifiedContactDispatch');
    const first = dispatch.checkUnifiedContact(); await tailEntered.promise;
    const second = dispatch.checkUnifiedContact(); await nextEntered.promise;
    const nextOwner = dispatch.captureUnifiedContactRun(); assert.ok(nextOwner);
    tailRelease.open(); await first;
    assert.equal(dispatch.captureUnifiedContactRun(), nextOwner);
    nextRelease.open(); await second; assert.equal(dispatch.captureUnifiedContactRun(), undefined);
    assert.equal(starts, 2); assert.equal(h.requests.length, 0);
  });
  for (const invalid of ['off', 'epoch', 'formal', 'reschedule', 'poke', 'return', 'terminal', 'unknown', 'actual-wake', 'chat']) {
    await test('captured fresh handoff is rejected after ' + invalid, async () => {
      const h = early(), near = holdNear(h); await near.entered; await near.runtime.runSleepPlanTick();
      const d = h.night();
      if (invalid === 'off') h.auto(false);
      if (invalid === 'epoch') h.restore();
      if (invalid === 'formal') h.time(AT + 60 * MIN);
      if (invalid === 'reschedule') { d.nightSleepPlan.originalWakeAt += MIN; d.nightSleepPlan.revision++; }
      if (invalid === 'poke') d.nightSleepPlan.events.push({ id: 'new-poke', kind: 'poke_awake', at: AT + 1, until: AT + 15 * MIN });
      if (invalid === 'return') d.nightSleepPlan.events.push({ id: 'new-return', kind: 'sleep_return', at: AT + 1 });
      if (invalid === 'terminal') d.nightSleepPlan.wake = { status: 'skipped', requestCount: 0 };
      if (invalid === 'unknown') d.nightSleepPlan.wake = { status: 'requesting', requestCount: 1 };
      if (invalid === 'actual-wake') d.nightSleepPlan.actualWakeAt = AT;
      if (invalid === 'chat') h.busy(true);
      h.writeNight(d); near.release(); await near.work; await drain(); assert.equal(h.requests.length, 0);
    });
  }
  await test('allowRequest false preserves the old local-only path and never hands off', async () => {
    const h = early(); await h.load('life/sleepPlanRuntime').runSleepPlanTick({ allowRequest: false }); await drain();
    assert.equal(h.requests.length, 0);
  });
  await test('allowRequest false also governs a new fact first written by the third settle in its tail', async () => {
    const h = early(); let projections = 0;
    h.stubs['life/lifeRhythm'].getSleepRecoveryProjection = async () => ({ reliable: true,
      recovered: ++projections > 2, recoveryAt: AT });
    assert.equal(await h.load('life/sleepPlanRuntime').runSleepPlanTick({ allowRequest: false }), false);
    await drain(); assert.ok(projections >= 3); assert.equal(h.night().nightSleepPlan.morningAwakeAt, AT);
    assert.equal(h.requests.length, 0); assert.equal(h.night().nightSleepPlan.wake, undefined);
  });
  await test('public maintenance reconcile defaults to local settlement without creating a request', async () => {
    for (const method of ['reconcileSleepPlan', 'reconcileSleepPlanLocally']) {
      const h = early(); await h.load('life/sleepPlanRuntime')[method](); await drain();
      assert.equal(h.night().nightSleepPlan.morningAwakeAt, AT);
      assert.equal(h.requests.length, 0, method); assert.equal(h.night().nightSleepPlan.wake, undefined, method);
    }
  });
  await test('local-only tick followed by the original no-option maintenance tail cannot acquire a fresh request', async () => {
    const h = early(), runtime = h.load('life/sleepPlanRuntime'); let recovered = false;
    h.stubs['life/lifeRhythm'].getSleepRecoveryProjection = async () => ({ reliable: true, recovered, recoveryAt: AT });
    await runtime.runSleepPlanTick({ allowRequest: false }); recovered = true;
    await runtime.reconcileSleepPlanLocally(); await drain();
    assert.equal(h.night().nightSleepPlan.morningAwakeAt, AT);
    assert.equal(h.requests.length, 0); assert.equal(h.night().nightSleepPlan.wake, undefined);
  });
  await test('unrelated scheduler busy remains skipped and is not retried when that lane ends', async () => {
    const h = early(); await h.withLane(async () => {
      await h.load('life/sleepPlanRuntime').reconcileSleepPlanLocally(AT, h.epoch(), true); await drain();
      assert.equal(h.requests.length, 0); assert.equal(h.night().nightSleepPlan.wake.status, 'skipped');
    }); await drain(); assert.equal(h.requests.length, 0); assert.equal((await h.ledger()).used, 0);
  });
  await test('formal wake produces no early fact and the fresh D preserves the original one-slot accounting', async () => {
    const h = early(); h.time(AT + 60 * MIN);
    assert.equal(await h.load('life/sleepPlanStore').settleSleepNight(h.now()), undefined);
    const normal = early(); await normal.load('life/sleepPlanRuntime').runSleepPlanTick(); await drain();
    assertDelivered(normal); assert.equal((await normal.ledger()).used, 1);
    assert.equal(normal.night().nightSleepPlan.wake.requestCount, 1);
  });
  await test('failed writer, less than seven hours and cold stored morning never produce a handoff', async () => {
    for (const mode of ['write-failed', 'short-sleep', 'stored']) {
      const h = early(), d = h.night();
      if (mode === 'write-failed') h.stubs['@react-native-async-storage/async-storage'].default.multiSet = async () => { throw Error('synthetic-write'); };
      if (mode === 'short-sleep') {
        d.sleepTargetAt = AT - 6 * 60 * MIN; d.nightSleepPlan.actualSleepAt = d.sleepTargetAt;
        d.nightSleepPlan.originalSleepAt = d.sleepTargetAt; d.nightSleepPlan.events = [{ id: 'sleep', kind: 'sleep', at: d.sleepTargetAt }];
        d.nightSleepPlan.recovery.sleepStartedAt = d.sleepTargetAt; h.writeNight(d);
      }
      if (mode === 'stored') { await h.load('life/sleepPlanStore').settleSleepNight(AT); h.cold(); }
      await h.load('life/sleepPlanRuntime').reconcileSleepPlanLocally(AT, h.epoch(), true).catch(() => undefined); await drain();
      assert.equal(h.requests.length, 0, mode);
      if (mode !== 'stored') assert.equal(h.night().nightSleepPlan.morningAwakeAt, undefined, mode);
    }
  });
  const failed = results.filter(result => !result.passed);
  assert.equal(results.length, 33, 'every declared group must finish');
  console.log(JSON.stringify({ sourceRoot: selected, passed: results.length - failed.length, failed: failed.length }));
  if (failed.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
