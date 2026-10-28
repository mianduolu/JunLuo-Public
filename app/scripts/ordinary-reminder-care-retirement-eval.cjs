'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const projectRoot = path.resolve(__dirname, '../..');
const sourceRoot = process.argv[2] ? path.resolve(process.argv[2]) : projectRoot;
const ts = require(path.join(projectRoot, 'app/node_modules/typescript'));
const read = file => fs.readFileSync(fs.existsSync(path.join(sourceRoot, file))
  ? path.join(sourceRoot, file) : path.join(projectRoot, file), 'utf8');
const cases = [];
let externalRequestAttempts = 0;
let fixtureMutationCalls = 0;
const rejectNetwork = () => { externalRequestAttempts += 1; throw Error('Unexpected network request'); };
function compiled(source, file) {
  const result = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}
function load(file, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(compiled(read(file), file), {
    module, exports: module.exports, require: id => {
      if (!(id in dependencies)) throw Error('Unexpected dependency: ' + id);
      return dependencies[id];
    }, console: { warn() {}, log() {} }, Date, Map, Set, fetch: rejectNetwork,
  });
  return module.exports;
}
function extractFunction(file, name, globals) {
  const source = read(file);
  const pattern = new RegExp('(?:export )?async function ' + name + '\\(');
  const at = source.search(pattern);
  assert(at >= 0, name + ' found');
  const end = source.indexOf('\n}', at) + 2;
  assert(end > at, name + ' closed');
  const module = { exports: {} };
  vm.runInNewContext(compiled(source.slice(at, end) + '\nexports.' + name + ' = ' + name + ';', file), {
    module, exports: module.exports, ...globals, Date, Map, Set, fetch: rejectNetwork,
  });
  return module.exports[name];
}
const eventFile = 'app/src/ai/behavior/continuityEvent.ts';
const ledgerFile = 'app/src/ai/behavior/continuityLedger.ts';
const actionFile = 'app/src/ai/behavior/actionExecutionRuntime.ts';
const dispatchFile = 'app/src/proactive/unifiedContactDispatch.ts';
const wantsFile = 'app/src/ai/assistantWantsMaterial.ts';
const api = load(eventFile, {});
const heart = load('app/src/ai/behavior/heartCareMatter.ts', {});
function event(id, sourceId = 'actual-care:' + id, extra = {}) {
  return {
    id, kind: 'care_process', schemaVersion: 2, subject: 'you', status: 'open',
    stage: 'signal_seen', itemName: 'fixture-' + id, source: { kind: 'real_care', sourceId },
    occurredAt: 1, updatedAt: 1, revision: 1, ...extra,
  };
}
function ordinary(count) {
  const prefixes = ['schedule-reminder:', 'schedule-companion:', 'todo-reminder:'];
  return Array.from({ length: count }, (_, i) => event('old-' + i, prefixes[i % 3] + i));
}
function paged(rows, calls = []) {
  return async query => {
    calls.push({ ...query });
    const filtered = rows.filter(item => !query.statuses || query.statuses.includes(item.status))
      .filter(item => !query.kinds || query.kinds.includes(item.kind));
    return filtered.slice(query.offset || 0, (query.offset || 0) + (query.limit || 200));
  };
}
async function test(name, work) {
  await work(); cases.push(name);
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

async function main() {
  for (const prefix of ['schedule-reminder:', 'schedule-companion:', 'todo-reminder:']) {
    await test('exact source ' + prefix, async () => {
      assert.equal(api.isOrdinaryReminderCareSource(prefix + 'id'), true);
      assert.equal(api.isOrdinaryReminderCareEvent(event('target', prefix + 'id')), true);
      assert.equal(api.isOrdinaryReminderCareSource(prefix.slice(0, -1)), false);
      assert.equal(api.isOrdinaryReminderCareSource('other:' + prefix + 'id'), false);
      assert.equal(api.isOrdinaryReminderCareSource(prefix.toUpperCase() + 'id'), false);
    });
  }
  await test('schema 1 retained', async () => {
    assert.equal(api.isOrdinaryReminderCareEvent(event('old', 'schedule-reminder:a', { schemaVersion: 1 })), false);
  });
  await test('schema 3 retained even with matching source', async () => {
    assert.equal(api.isOrdinaryReminderCareEvent(event('chat', 'schedule-reminder:a', { schemaVersion: 3,
      careEvidence: { origin: { sessionId: 's', messageId: 'you', sentAt: 1, quote: 'fixture' } } })), false);
  });
  await test('other kind and source retained', async () => {
    assert.equal(api.isOrdinaryReminderCareEvent(event('kind', 'todo-reminder:a', { kind: 'shared_task' })), false);
    assert.equal(api.isOrdinaryReminderCareEvent(event('tool', 'todo-reminder:a',
      { source: { kind: 'real_tool_execution', sourceId: 'todo-reminder:a' } })), false);
  });
  await test('heart care retained', async () => {
    const e = event('body-care:h', 'h', { coalescingKey: 'heart-care:h' });
    assert.equal(heart.isHeartCareMatter(e), true);
    assert.equal(api.isOrdinaryReminderCareEvent(e), false);
  });
  let writes = [];
  const action = load(actionFile, {
    './actionBehaviorStore': { getBaiyunLocalDateKey: () => 'fixture-date' },
    './continuityEvent': api,
    './continuityLedger': {
      createBaiyunContinuityEvent: async input => {
        fixtureMutationCalls += 1;
        writes.push({ kind: 'create', input });
        return event('created', input.source.sourceId);
      },
      recordBaiyunContinuityEvidence: async input => {
        fixtureMutationCalls += 1;
        writes.push({ kind: 'evidence', input });
        return event('created', 'actual-care:created');
      },
    },
  });
  for (const prefix of ['schedule-reminder:', 'schedule-companion:', 'todo-reminder:']) {
    await test('producer retired ' + prefix, async () => {
      writes = [];
      const result = await action.recordBaiyunCareDelivery({
        sourceId: prefix + 'id', itemName: 'fixture', messageIds: ['saved-message'],
        uiReceiptId: 'ui', notificationReceiptId: 'notification',
        links: [{ relation: 'task', targetKind: 'schedule_occurrence', targetId: 'occurrence' }],
      });
      assert.equal(result, undefined);
      assert.equal(writes.length, 0);
    });
  }
  await test('non-reminder real care delivery unchanged', async () => {
    writes = [];
    await action.recordBaiyunCareDelivery({ sourceId: 'actual-care:source', itemName: 'fixture',
      messageIds: ['message'], uiReceiptId: 'ui', notificationReceiptId: 'notification' });
    assert.equal(writes.filter(x => x.kind === 'create').length, 1);
    assert.deepEqual(writes.filter(x => x.kind === 'evidence').map(x => x.input.evidence.sourceId),
      ['message', 'notification', 'ui']);
  });
  await test('empty ordinary and other-care receipts do not write', async () => {
    writes = [];
    await action.recordBaiyunCareDelivery({ sourceId: 'actual-care:source', itemName: 'fixture' });
    await action.recordBaiyunCareDelivery({ sourceId: 'schedule-reminder:source', itemName: 'fixture' });
    assert.equal(writes.length, 0);
  });
  await test('open view fills 200 valid after 401 old cards', async () => {
    const kept = Array.from({ length: 205 }, (_, i) => event('kept-' + i));
    const rows = [...ordinary(401), ...kept];
    const before = JSON.stringify(rows);
    const calls = [];
    const fn = extractFunction(ledgerFile, 'listOpenBaiyunContinuityEvents', {
      listBaiyunContinuityEvents: paged(rows, calls), isOrdinaryReminderCareEvent: api.isOrdinaryReminderCareEvent,
    });
    const result = await fn();
    assert.deepEqual(plain(result).map(e => e.id), kept.slice(0, 200).map(e => e.id));
    assert.deepEqual(calls.map(c => c.offset), [0, 200, 400, 600]);
    assert.deepEqual(calls.map(c => c.readOnly), [false, true, true, true], 'recover only on the original first page');
    assert.equal(JSON.stringify(rows), before, 'read-time filtering never mutates old rows');
  });
  await test('open view source exhausted after a full old page', async () => {
    const rows = [...ordinary(200), event('chat', 'schedule-reminder:x', { schemaVersion: 3 }), event('keep')];
    const calls = [];
    const fn = extractFunction(ledgerFile, 'listOpenBaiyunContinuityEvents', {
      listBaiyunContinuityEvents: paged(rows, calls), isOrdinaryReminderCareEvent: api.isOrdinaryReminderCareEvent,
    });
    assert.deepEqual(plain(await fn()).map(e => e.id), ['chat', 'keep']);
    assert.deepEqual(calls.map(c => c.offset), [0, 200]);
  });
  await test('open empty result stops after source exhausted', async () => {
    const calls = [];
    const fn = extractFunction(ledgerFile, 'listOpenBaiyunContinuityEvents', {
      listBaiyunContinuityEvents: paged(ordinary(400), calls), isOrdinaryReminderCareEvent: api.isOrdinaryReminderCareEvent,
    });
    assert.equal((await fn()).length, 0);
    assert.deepEqual(calls.map(c => c.offset), [0, 200, 400]);
  });
  await test('contact fills through old pages before material budget', async () => {
    const live = event('active');
    const chat = event('chat', 'you-message', { schemaVersion: 3,
      careEvidence: { origin: { sessionId: 's', messageId: 'you-message', sentAt: 1, quote: 'fixture' } } });
    const device = event('body-care:heart', 'heart', { coalescingKey: 'heart-care:heart', deviceRecord: 'fixture' });
    const rows = [...ordinary(400), live, chat, device];
    const calls = [];
    const fn = extractFunction(dispatchFile, 'contactCareEntries', {
      listBaiyunContinuityEvents: paged(rows, calls), listChatCareMatters: async () => [chat, device],
      listBaiyunContinuityLinks: async () => [], isHeartCareMatter: heart.isHeartCareMatter,
      isOrdinaryReminderCareEvent: api.isOrdinaryReminderCareEvent,
      buildChatCareContext: () => 'fixture-chat-care', toChatCareItem: e => e,
      formatCareLocalTime: String, formatChatAfterglowMessageTime: String,
      contactCareSelection: () => ({ priority: false }),
    });
    const ordinaryResult = plain(await fn([], 10, true));
    assert.deepEqual(new Set(ordinaryResult.map(x => x.id)), new Set(['active', 'chat', 'body-care:heart']));
    assert.deepEqual(calls.map(c => c.offset), [0, 200, 400]);
    assert(calls.every(c => c.readOnly === true));
    assert(ordinaryResult.every(x => !x.id.startsWith('old-')));
    const importantResult = plain(await fn([], 10, false));
    assert.equal(importantResult.length, 3);
    assert(importantResult.every(x => !x.id.startsWith('old-')));
  });
  await test('inner material filters old reminders before selecting 3', async () => {
    const live = event('active-inner');
    const rows = [...ordinary(401), live];
    const before = JSON.stringify(rows);
    const calls = [];
    const wants = load(wantsFile, {
      '../chat/chatAfterglowState': { innerMaterialKey: value => JSON.stringify(value) },
      '../chat/chatAfterglowProbe': { formatChatAfterglowMessageTime: String },
      '../chat/heartCorpusStore': { loadHeartFeedbackCandidates: async () => [] },
      '../memory/memoryStore': { loadMemorySourcePage: async () => [], loadMemory: async () => null },
      './behavior/continuityLedger': {
        listBaiyunContinuityEvents: paged(rows, calls), listChatCareMatters: async () => [],
        listBaiyunContinuityLinks: async () => [],
      },
      './behavior/continuityEvent': api,
      './behavior/chatCareUpdates': { formatCareLocalTime: String },
      './behavior/heartCareMatter': heart,
      './lifeMaterialHub': { buildNearStatusLifeMaterialSnapshot: async () => ({ items: [] }) },
      './nearStatusLifeMaterialFormat': { selectNearStatusLifeEntries: () => [] },
      '../camera/cameraModelObservationInnerMaterial': { loadCameraModelObservationInnerMaterials: async () => [] },
    });
    const render = await wants.prepareWantsMaterial({
      state: { materials: { activatedAt: 0, care: {}, life: {}, hearts: [] } }, now: 10,
    });
    const result = render(0);
    assert.deepEqual(plain(result.refs).filter(r => r.kind === 'care').map(r => r.id), ['active-inner']);
    assert(!result.text.includes('fixture-old-'));
    assert.equal(JSON.stringify(rows), before);
    assert.deepEqual(calls.map(c => c.offset), [0, 200, 400]);
    assert(calls.every(c => c.readOnly === true));
  });
  for (const file of [eventFile, actionFile, ledgerFile, dispatchFile, wantsFile]) compiled(read(file), file);
  assert.equal(externalRequestAttempts, 0);
  process.stdout.write(JSON.stringify({ passed: cases.length, cases, sourceRoot, externalRequestAttempts,
    fixtureMutationCalls, boundary: 'actual source functions with synthetic ledger/material ports; no device or model' }, null, 2) + '\n');
}
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
