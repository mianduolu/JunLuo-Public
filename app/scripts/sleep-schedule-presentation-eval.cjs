const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Only the actual pure presentation and sleep policy run. No storage, native API or network.
const cache = new Map();
function load(name) {
  const file = path.resolve(__dirname, '../src/life', name + '.ts');
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, Date, Map,
    require: dependency => {
      assert.equal(dependency, './sleepPlanPolicy');
      return load('sleepPlanPolicy');
    },
  }, { filename: file });
  return module.exports;
}
const { presentTodaySleep, sleepDisplayTime, sleepBriefTime } = load('sleepSchedulePresentation');
const at = value => new Date(value).getTime();
const now = at('2026-10-28T12:00:00');
const previous = {
  dateKey: '2026-10-27', sleepTargetAt: at('2026-10-27T22:30:00'),
  nightSleepPlan: {
    originalSleepAt: at('2026-10-27T22:30:00'), originalWakeAt: at('2026-10-28T07:00:00'), revision: 1,
    actualSleepAt: at('2026-10-27T23:00:00'), morningAwakeAt: at('2026-10-28T06:45:00'),
    actualWakeAt: at('2026-10-28T07:40:00'), events: [
      { id: 'a', kind: 'poke_awake', at: at('2026-10-28T01:00:00'), until: at('2026-10-28T01:15:00') },
      { id: 'b', kind: 'sleep_return', at: at('2026-10-28T01:25:00') },
      { id: 'c', kind: 'poke_awake', at: at('2026-10-27T23:30:00') },
    ],
  },
};
const today = {
  dateKey: '2026-10-28', wakeTargetAt: at('2026-10-28T07:00:00'), sleepTargetAt: at('2026-10-28T22:30:00'),
  nightSleepPlan: { originalSleepAt: at('2026-10-28T22:30:00'), originalWakeAt: at('2026-10-29T07:00:00'), revision: 0 },
};
const input = { now, today, previous, relevant: today, rhythmRaw: null };
const row = (rows, label) => rows.find(entry => entry.label === label)?.value;
let count = 0;
function test(name, work) { work(); count++; console.log('PASS ' + name); }
test('missing records never invent plans or pressure seeds', () => {
  const value = presentTodaySleep({ now, today: null, previous: null, relevant: null, rhythmRaw: null });
  assert.equal(value.wake.planned, '未定'); assert.equal(value.sleep.planned, '未定');
  assert.equal(value.metrics.length, 0); assert.equal(value.timeline.length, 0);
});
test('morning adjusted plan differs from waking and getting up', () => {
  const value = presentTodaySleep(input);
  assert.equal(value.wake.planned, '07:30');
  assert.equal(row(value.wake.actual, '醒来'), '06:45');
  assert.equal(row(value.wake.actual, '实际起床'), '07:40');
});
test('next night selection keeps previous actual sleep and next date explicit', () => {
  const value = presentTodaySleep(input);
  assert.equal(row(value.wake.actual, '实际起床'), '07:40');
  assert.equal(row(value.sleep.actual, '实际入睡'), '未记录');
  assert.equal(value.nextWake, '明天 07:00');
});
test('today events come from last night; temporary cutoff is not actual return', () => {
  const value = presentTodaySleep({ ...input, relevant: previous });
  assert.equal(row(value.timeline, '睡回'), '01:25');
  assert.equal(row(value.timeline, '临时醒来'), '01:00');
  assert.equal(value.timeline.find(entry => entry.label === '临时醒来').note, '原临时醒截止 01:15');
  assert.equal(value.timeline.filter(entry => entry.label === '临时醒来').length, 1);
});
test('explicit wake overrides automatic late-sleep shift', () => {
  const value = presentTodaySleep({ ...input, previous: { ...previous,
    nightSleepPlan: { ...previous.nightSleepPlan, explicitWakeAt: at('2026-10-28T08:10:00') } } });
  assert.equal(value.wake.planned, '08:10');
});
test('an elapsed same-day wake is never called the next wake', () => {
  const value = presentTodaySleep({ ...input, today: { ...today,
    nightSleepPlan: { ...today.nightSleepPlan, explicitWakeAt: at('2026-10-28T09:00:00') } } });
  assert.equal(value.nextWake, '尚无后续计划');
});
test('future events and future actual records are not announced as happened', () => {
  const value = presentTodaySleep({ ...input, now: at('2026-10-28T01:10:00') });
  assert.equal(value.timeline.length, 1);
  assert.equal(row(value.wake.actual, '醒来'), '未记录');
  assert.equal(row(value.wake.actual, '实际起床'), '未记录');
});
test('bad JSON, array, missing time and future time do not become real metrics', () => {
  for (const rhythmRaw of ['{', '[]', '{"sleepPressure":0.4}', JSON.stringify({ sleepPressure: .4, updatedAt: now + 1 })]) {
    assert.equal(presentTodaySleep({ ...input, rhythmRaw }).metrics.length, 0);
  }
});
test('saved numeric zero stays zero; invalid range stays missing with original timestamp', () => {
  const value = presentTodaySleep({ ...input, rhythmRaw: JSON.stringify({
    updatedAt: now - 60_000, sleepPressure: 0, wakePressure: .81, sleepDebt: 1.2, alertness: .32,
  }) });
  assert.equal(row(value.metrics, '困意'), '0 / 100');
  assert.equal(row(value.metrics, '醒意'), '81 / 100');
  assert.equal(row(value.metrics, '欠觉'), '未记录');
  assert.equal(value.rhythmRecordedAt, '11:59');
});
test('invalid dates are not shown as a time', () => {
  for (const value of [undefined, null, NaN, Infinity, 9e30]) assert.equal(sleepDisplayTime(value), '未记录');
});
test('tonight sleep keeps this morning wake visible', () => {
  const value = presentTodaySleep({ ...input, now: at('2026-10-28T23:00:00'), today: {
    ...today, nightSleepPlan: { ...today.nightSleepPlan, actualSleepAt: at('2026-10-28T22:35:00') },
  } });
  assert.equal(row(value.wake.actual, '实际起床'), '07:40');
  assert.equal(row(value.sleep.actual, '实际入睡'), '22:35');
});
test('previous night sleep after midnight does not fulfill tonight sleep plan', () => {
  const value = presentTodaySleep({ ...input, previous: { ...previous,
    nightSleepPlan: { ...previous.nightSleepPlan, actualSleepAt: at('2026-10-28T01:00:00') } } });
  assert.equal(row(value.sleep.actual, '实际入睡'), '未记录');
  assert.equal(row(value.timeline, '入睡'), '01:00');
});
test('unchanged schedules have no duplicate original/current rows', () => {
  assert.equal(presentTodaySleep(input).changes.length, 0);
});
test('short dates distinguish today, tomorrow and a different year', () => {
  assert.equal(sleepBriefTime(at('2026-10-28T09:00:00'), now), '09:00');
  assert.equal(sleepBriefTime(at('2026-10-29T07:00:00'), now), '明天 07:00');
  assert.equal(sleepBriefTime(at('2027-01-01T07:00:00'), now), '2027/01/01 07:00');
});
test('after midnight the unfinished previous night owns the earliest next wake', () => {
  const value = presentTodaySleep({ ...input, now: at('2026-10-28T00:10:00'), relevant: previous });
  assert.equal(value.nextWake, '07:30');
  assert.equal(value.wake.planned, value.nextWake);
  assert.equal(value.previousSleep, '昨天 23:00');
});
console.log(JSON.stringify({ passed: count, networkRequests: 0, storageWrites: 0 }));
