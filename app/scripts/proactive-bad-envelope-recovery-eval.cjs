const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('../node_modules/typescript');
const root = path.resolve(__dirname, '../..');
const sourcePath = path.join(root, 'app/src/proactive/proactiveBadEnvelopeRecovery.ts');
const virtualPath = path.join(root, 'app/src/proactive/proactiveBadEnvelopeRecovery.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function loadTs(file, mocks, cache = new Map()) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const moduleObject = { exports: {} };
  cache.set(file, moduleObject.exports);
  const current = file === virtualPath ? source : fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(current, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', js)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === '../chat/chatExpenseMaterials') return { expensePlanHistoryMaterial() { throw Error('unrelated history'); } };
    if (name === '../chat/chatReminderMaterials') return { reminderPlanHistoryMaterial() { throw Error('unrelated history'); } };
    assert.ok(name.startsWith('.'), `unexpected dependency ${name}`);
    return loadTs(path.resolve(path.dirname(file), `${name}.ts`), mocks, cache);
  }, moduleObject, moduleObject.exports);
  return moduleObject.exports;
}
function fixture() {
  const snapshot = {
    version: 3, capturedAt: 1000, connectionName: 'synthetic', model: 'synthetic', requestType: 'initial',
    failureSummary: 'synthetic', failureReasons: [],
    basketStatuses: { messages: 'unavailable', careUpdates: 'unavailable', shareResponses: 'unavailable', innerReaction: 'unavailable' },
    semanticPrefixCompletionRequested: false,
    retryOutcome: 'not_attempted', rawDirectContent: '{"messages":["第一段完整的话。","第二段完整的话。","第三段完整的话。","第四段完整的话。","第五段完整的话。"]}`',
    rawDirectContentChars: 0,
    proactiveSource: { opportunityId: 'op-one', sessionId: 'session-one', requestToken: 'request:one', requestNumber: 1, phase: 'initial' },
  };
  snapshot.rawDirectContentChars = snapshot.rawDirectContent.length;
  const state = { snapshot, expected: clone(snapshot), messages: new Map(), reads: [], orderCalls: 0,
    appendCalls: 0, emits: [], epoch: 3, captures: 0, inCallback: false, activeSession: 'session-one',
    beforeQueue: undefined, failAfterWrite: false, failBeforeWrite: false, dropWrite: false };
  const mocks = {
    '../ai/behavior/actionChatBadEnvelopeCache': { loadBaiyunLatestBadEnvelopeSnapshot: async options => {
      assert.deepEqual(options, { strict: true }); assert.equal(state.inCallback, false); return state.snapshot;
    } },
    '../backup/backupRestoreCoordinator': {
      captureBackupRestoreDataEpoch: () => { state.captures += 1; return state.epoch; },
      canCommitBackupRestoreDataEpoch: epoch => epoch === state.epoch,
    },
    '../chat/chatStorage': {
      loadChatSessionMessageOrder: async (sessionId, options) => {
        assert.equal(sessionId, 'session-one'); assert.deepEqual(options, { strict: true });
        assert.equal(state.inCallback, false); state.orderCalls += 1;
        return [...state.messages.keys()].map(id => ({ id }));
      },
      loadChatSessionMessage: async (sessionId, id) => {
        assert.equal(sessionId, 'session-one'); assert.equal(state.inCallback, false, 'public loader inside queue callback would deadlock');
        state.reads.push(id); return state.messages.get(id) ?? null;
      },
      appendMessagesToChatSession: async (sessionId, additions, options) => {
        state.appendCalls += 1; assert.equal(options.requireActiveSession, true);
        if (state.beforeQueue) { const run = state.beforeQueue; state.beforeQueue = undefined; run(); }
        if (state.activeSession !== sessionId || options.dataEpoch !== state.epoch) return { messages: [], session: null };
        state.inCallback = true;
        try { assert.equal(await options.beforeAppend([...state.messages.values()]), true); }
        finally { state.inCallback = false; }
        if (state.failBeforeWrite) throw Error('synthetic write-before failure');
        if (!state.dropWrite) additions.forEach(message => state.messages.set(message.id, clone(message)));
        if (state.failAfterWrite) { state.failAfterWrite = false; throw Error('synthetic unknown acknowledgement'); }
        return { messages: [...state.messages.values()], session: {} };
      },
    },
    '../chat/chatMessageEvents': { emitChatMessagesAppended: event => state.emits.push(clone(event)) },
  };
  state.restore = loadTs(virtualPath, mocks).restoreProactiveBadEnvelope;
  return state;
}
function natural(id, content) { return { id: `op-one:message:${id}`, role: 'I', content, source: 'proactive-message', createdAt: 1200 }; }
let passed = 0, total = 0;
async function test(name, run) {
  total += 1;
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.stack}`); process.exitCode = 1; }
}
(async () => {
  await test('fresh strict snapshot restores five with stable distinct IDs and original timestamp', async () => {
    const f = fixture();
    for (let index = 0; index < 3; index++) { const message = natural(index, `原补试${index}。`); f.messages.set(message.id, message); }
    const unrelated = { id: 'private-other' }; Object.defineProperty(unrelated, 'content', { get() { throw Error('unrelated body read'); } });
    f.messages.set(unrelated.id, unrelated);
    const result = await f.restore(f.expected);
    assert.equal(result.savedCount, 5); assert.equal(result.existingCount, 0); assert.equal(f.captures, 1);
    assert.ok(result.messageIds.every(id => id.startsWith('op-one:bad-envelope-recovery:request%3Aone:message:')));
    assert.ok(result.messageIds.every(id => f.messages.get(id).createdAt === 1000));
    assert.ok(!f.reads.includes('private-other')); assert.equal(f.emits.length, 1);
    assert.equal(f.snapshot.rawDirectContent, f.expected.rawDirectContent);
  });
  await test('repeat restore does not append duplicate IDs and confirms existing content', async () => {
    const f = fixture(); const first = await f.restore(f.expected); const calls = f.appendCalls;
    const second = await f.restore(f.expected);
    assert.deepEqual(second.messageIds, first.messageIds); assert.equal(second.savedCount, 0);
    assert.equal(second.existingCount, 5); assert.equal(f.appendCalls, calls); assert.equal(f.messages.size, 5);
  });
  await test('same-operation exact content deduplicates without a fixed natural count', async () => {
    const f = fixture();
    for (let index = 0; index < 7; index++) { const message = natural(index, index === 6 ? '第二段完整的话。' : `已送达${index}。`); f.messages.set(message.id, message); }
    const result = await f.restore(f.expected);
    assert.equal(result.savedCount, 4); assert.equal(result.existingCount, 1); assert.equal(result.messageIds[1], 'op-one:message:6');
    assert.ok(!f.messages.has('op-one:bad-envelope-recovery:request%3Aone:message:1'));
  });
  await test('changed cache or non-proactive snapshot stops before chat reads', async () => {
    for (const change of [f => f.snapshot.capturedAt++, f => f.snapshot.rawDirectContent += '`', f => delete f.snapshot.proactiveSource]) {
      const f = fixture(); change(f); await assert.rejects(f.restore(f.expected), /SNAPSHOT_CHANGED/);
      assert.equal(f.orderCalls, 0); assert.equal(f.appendCalls, 0);
    }
  });
  await test('same recovery ID with different content rejects without overwriting', async () => {
    const f = fixture(); const id = 'op-one:bad-envelope-recovery:request%3Aone:message:0';
    f.messages.set(id, { id, role: 'I', content: '另一份内容。', createdAt: 1000, source: 'proactive-message' });
    await assert.rejects(f.restore(f.expected), /ID_COLLISION/); assert.equal(f.appendCalls, 0);
    assert.equal(f.messages.get(id).content, '另一份内容。');
  });
  await test('queued ID collision and same-operation content race both stop', async () => {
    for (const collision of [false, true]) {
      const f = fixture(); f.beforeQueue = () => {
        const message = collision
          ? { id: 'op-one:bad-envelope-recovery:request%3Aone:message:0', role: 'I', content: '异文。', createdAt: 1000, source: 'proactive-message' }
          : natural(99, '第一段完整的话。');
        f.messages.set(message.id, message);
      };
      await assert.rejects(f.restore(f.expected), collision ? /ID_COLLISION/ : /SOURCE_CHAT_CHANGED/);
      assert.equal(f.messages.size, 1); assert.equal(f.emits.length, 0);
    }
  });
  await test('epoch change and inactive target cannot report a successful save', async () => {
    for (const mutate of [f => f.epoch++, f => f.activeSession = 'other-session']) {
      const f = fixture(); f.beforeQueue = () => mutate(f);
      await assert.rejects(f.restore(f.expected), /EPOCH_CHANGED|SAVE_UNCONFIRMED/);
      assert.equal(f.messages.size, 0); assert.equal(f.emits.length, 0);
    }
  });
  await test('unknown acknowledgement retry reuses IDs and emits confirmed recovery', async () => {
    const f = fixture(); f.failAfterWrite = true;
    await assert.rejects(f.restore(f.expected), /unknown acknowledgement/);
    assert.equal(f.messages.size, 5); assert.equal(f.emits.length, 0);
    const result = await f.restore(f.expected);
    assert.equal(result.savedCount, 0); assert.equal(result.existingCount, 5); assert.equal(f.messages.size, 5);
    assert.equal(f.emits.length, 1); assert.equal(f.emits[0].messages.length, 5);
  });
  await test('write-before failure and missing persisted result do not emit', async () => {
    for (const field of ['failBeforeWrite', 'dropWrite']) {
      const f = fixture(); f[field] = true;
      await assert.rejects(f.restore(f.expected), /write-before|SAVE_UNCONFIRMED/);
      assert.equal(f.messages.size, 0); assert.equal(f.emits.length, 0);
    }
  });
  await test('unconfirmed or nested-only body cannot be restored', async () => {
    for (const raw of ['{"messages":["残缺', '{"internal":{"messages":["不能当正文"]}}']) {
      const f = fixture(); f.snapshot.rawDirectContent = raw; f.expected = clone(f.snapshot);
      await assert.rejects(f.restore(f.expected), /BODY_UNCONFIRMED/); assert.equal(f.appendCalls, 0);
    }
  });
  await test('historical restore preserves raw phrasing while accepting a normalized natural duplicate', async () => {
    const raw = '嗯啊，小仓鼠，早上好。';
    const proactive = loadTs(path.join(root, 'app/src/proactive/proactiveLitePrompt.ts'), {});
    const normalized = proactive.normalizeProactiveLiteMessages([raw])[0];
    assert.notEqual(raw, normalized, 'synthetic control must really be shortened by the existing cleaner');
    const f = fixture(); f.snapshot.rawDirectContent = JSON.stringify({ messages: [raw] }) + '`'; f.expected = clone(f.snapshot);
    const first = await f.restore(f.expected);
    assert.equal(f.messages.get(first.messageIds[0]).content, raw);
    const g = fixture(); g.snapshot.rawDirectContent = f.snapshot.rawDirectContent; g.expected = clone(g.snapshot);
    const already = natural(17, normalized); g.messages.set(already.id, already);
    const second = await g.restore(g.expected);
    assert.equal(second.savedCount, 0); assert.equal(second.existingCount, 1); assert.equal(second.messageIds[0], already.id);
    assert.equal(g.appendCalls, 0); assert.equal(g.messages.get(already.id).content, normalized);
  });
  await test('a filtered complete segment stops the whole authorized historical restore', async () => {
    const f = fixture(); f.snapshot.rawDirectContent = JSON.stringify({ messages: ['我刚刚搜到一篇文章。', '早上好，小仓鼠。'] }) + '`';
    f.expected = clone(f.snapshot);
    await assert.rejects(f.restore(f.expected), /BODY_FILTERED/); assert.equal(f.appendCalls, 0);
  });
  console.log(`RESULT ${passed}/${total}`);
  console.log(`PRODUCTION_SHA256 ${crypto.createHash('sha256').update(source).digest('hex')}`);
  console.log('BOUNDARY production_service_real_visible_and_normalizer RAM_chat_ports HTTP=0 real_storage=0 private_text=0 production_changes=0 full_typecheck=0');
})().catch(error => { console.error(error); process.exitCode = 1; });
