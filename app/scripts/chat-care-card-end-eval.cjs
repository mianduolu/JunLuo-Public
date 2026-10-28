const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { DatabaseSync } = require('node:sqlite');
let root = path.resolve(__dirname, '../..');
while (!fs.existsSync(path.join(root, 'app/node_modules/typescript'))) {
  const parent = path.dirname(root); if (parent === root) throw new Error('App TypeScript dependency not installed');
  root = parent;
}
const sourceRoot = path.resolve(process.argv[2] ?? root);
const originalFetch = globalThis.fetch, hadFetch = Object.hasOwn(globalThis, 'fetch');
let externalRequests = 0;
globalThis.fetch = async () => { externalRequests++; throw new Error('External transport forbidden in RAM care evaluation'); };
const requireApp = createRequire(path.join(root, 'app/package.json'));
const ts = requireApp('typescript');
const cases = [];
const loaded = new Map();
const hash = text => createHash('sha256').update(text).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const sourcePaths = ['app/src/ai/behavior/chatCareUpdates.ts', 'app/src/ai/behavior/continuityLedger.ts'];

function fixture() {
  const db = new DatabaseSync(':memory:');
  const sqlSource = fs.readFileSync(path.join(root, 'app/src/sync/syncMemoryRecordsSql.ts'), 'utf8');
  for (const table of ['continuity_events', 'continuity_event_transitions', 'continuity_event_links', 'continuity_event_candidates']) {
    const ddl = sqlSource.match(new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\([\\s\\S]*?\\n\\);'));
    assert.ok(ddl, table); db.exec(ddl[0]);
  }
  // Empty capture metadata ports: no sync/network or disk-backed business database.
  db.exec('CREATE TABLE memory_sync_entity_heads(entity_type TEXT,entity_id TEXT,revision_id TEXT); CREATE TABLE memory_sync_domain_outbox(revision_id TEXT,operation TEXT); CREATE TABLE memory_sync_revision_log(revision_id TEXT,operation TEXT);');
  const storage = new Map(), journalWrites = [], rejected = [], cache = new Map();
  const port = {
    getFirstAsync: async (sql, ...args) => db.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql, ...args) => db.prepare(sql).all(...args),
    runAsync: async (sql, ...args) => db.prepare(sql).run(...args),
    withExclusiveTransactionAsync: async work => {
      db.exec('BEGIN'); try { const result = await work(port); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const stubs = {
    'app/src/memory/memoryStore.ts': { getMemoryDatabase: async () => port },
    'app/src/ai/behavior/chatCareCleanup.ts': { ensureChatCareCleanup: async () => {} },
    'app/src/backup/backupRestoreCoordinator.ts': { captureBackupRestoreDataEpoch: () => 1,
      canCommitBackupRestoreDataEpoch: epoch => epoch === 1,
      runBackupRestoreDataEpochCommit: async (epoch, work) => ({ committed: epoch === 1, value: epoch === 1 ? await work() : undefined }) },
    'app/src/chat/chatAuxiliaryDiagnostics.ts': { recordChatCareRejection: code => rejected.push(code),
      runChatAuxiliaryOperation: async (_meta, work) => ({ ok: true, value: await work() }) },
    'app/src/sync/syncMemoryRecordsSqlitePort.ts': { runWithMemoryRecordsCaptureSuppressed: work => work(port) },
    'app/src/bodySignal/bodySignalCareStore.ts': { loadBodySignalCareEvidence: async () => [] },
    'app/src/proactive/unifiedContactHandoff.ts': { prepareUnifiedContactChatHandoff: async () => null,
      commitUnifiedContactChatHandoff: async () => { throw new Error('unexpected handoff'); } },
    'app/src/proactive/unifiedContactStore.ts': { noteOrdinaryContactReply: async () => {} },
    'app/src/ai/behavior/actionShareResponseStore.ts': { loadBaiyunPendingSharePromptContext: async () => ({ fixedItems: [], fixedInstruction: '' }),
      commitBaiyunFixedShareResponseLedger: async () => { throw new Error('unexpected share write'); } },
    'app/src/chat/notebookActionPlanner.ts': { prepareNotebookAction: async () => null,
      commitPreparedNotebookAction: async () => { throw new Error('unexpected notebook'); } },
  };
  function load(rel) {
    rel = rel.replaceAll('\\', '/');
    if (stubs[rel]) return stubs[rel];
    if (cache.has(rel)) return cache.get(rel).exports;
    assert.ok(rel.startsWith('app/src/') && !rel.includes('../'), 'source-only loader');
    const overlay = path.join(sourceRoot, rel);
    const file = fs.existsSync(overlay) ? overlay : path.join(root, rel);
    const source = fs.readFileSync(file, 'utf8'); loaded.set(file.replaceAll('\\', '/'), hash(source));
    const module = { exports: {} }; cache.set(rel, module);
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const requireLocal = id => {
      if (id === '@react-native-async-storage/async-storage') return {
        getItem: async key => storage.get(key) ?? null,
        setItem: async (key, value) => { storage.set(key, value); journalWrites.push(JSON.parse(value)); },
        removeItem: async key => { storage.delete(key); },
      };
      if (id.startsWith('@noble/hashes/')) return requireApp(id);
      if (!id.startsWith('.')) throw new Error('Blocked external port: ' + id);
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), id)) + '.ts');
    };
    vm.runInThisContext('(function(require,module,exports){' + code + '\n})', { filename: file })(requireLocal, module, module.exports);
    return module.exports;
  }
  const parser = load(sourcePaths[0]), ledger = load(sourcePaths[1]);
  const apply = (updates, sessionId = 'synthetic-current-session', extra = {}) => ledger.applyBaiyunCareMatterUpdates({
    updates, sessionId, now: 1000, allowNew: true, onRejected: code => rejected.push(code), ...extra,
  });
  const seed = async (id = 'old-you') => (await apply([{ quote: '合成旧片段甲', state: '继续', sourceMessageId: id, occurredAt: 10 }], 'synthetic-origin-session'))[0];
  return { db, port, load, parser, ledger, apply, seed, storage, journalWrites, rejected, close: () => db.close() };
}

async function test(name, work) {
  await work(); cases.push({ name, passed: true }); console.log('PASS ' + name);
}
const message = { id: 'current-you', role: 'you', text: '合成本轮片段乙', sentAt: 20 };
const input = (item, value, extra = {}) => ({ items: [item], messages: [message], newMessages: [message], value, ...extra });
const end = quote => ({ item: 1, from: null, quote, state: '结束' });

(async () => {
  await test('card-reference-accepts-exact-origin-with-original-provenance', async () => {
    const f = fixture(); try {
      const event = await f.seed(), item = f.parser.toChatCareItem(event), call = input(item, [end(event.careEvidence.origin.quote)]);
      const parsed = f.parser.parseChatCareUpdates(call); assert.equal(parsed.updates.length, 1);
      assert.deepEqual(plain(parsed.updates[0]), { eventId: event.id, expectedRevision: event.revision,
        quote: event.careEvidence.origin.quote, state: '结束', sourceMessageId: 'old-you', occurredAt: 10, sourceSessionId: 'synthetic-origin-session' });
      assert.ok(f.parser.CHAT_CARE_GUIDANCE.includes('from：填本轮 you 消息的序号；结束已有事项时，也可以填 null。\nquote：摘出这条消息里的原话；from 填 null 时，照抄该事项里列出的 you 原话。'));
    } finally { f.close(); }
  });
  await test('numbered-current-substring-still-accepted-and-historical-number-still-rejected', async () => {
    const f = fixture(); try {
      const event = await f.seed(), item = f.parser.toChatCareItem(event);
      for (const raw of [{ item: null, from: 1, quote: '本轮片段', state: '继续' }, { item: 1, from: 1, quote: '本轮片段', state: '结束' }]) {
        const result = f.parser.parseChatCareUpdates(input(item, [raw]));
        assert.equal(result.status, 'valid');
        assert.deepEqual(plain(result.updates[0]), { ...(raw.item ? { eventId: item.id, expectedRevision: item.revision } : {}),
          quote: raw.quote, state: raw.state, sourceMessageId: message.id, occurredAt: message.sentAt });
      }
      const historical = { id: 'old-you', role: 'you', text: event.careEvidence.origin.quote, sentAt: 10 };
      assert.equal(f.parser.parseChatCareUpdates(input(item, [{ ...end(historical.text), from: 1 }], { messages: [historical, message] })).updates.length, 0);
    } finally { f.close(); }
  });
  await test('null-rejects-new-continue-partial-quote-foreign-card-and-device-only', async () => {
    const f = fixture(); try {
      const item = f.parser.toChatCareItem(await f.seed());
      for (const value of [{ ...end('合成旧片段甲'), item: null }, { ...end('合成旧片段甲'), state: '继续' }, end('旧片段'), end('另一事项的原话')])
        assert.equal(f.parser.parseChatCareUpdates(input(item, [value])).updates.length, 0);
      assert.equal(f.parser.parseChatCareUpdates(input({ ...item, evidence: undefined, deviceRecord: '合成设备数值' }, [end('合成设备数值')])).updates.length, 0);
    } finally { f.close(); }
  });
  await test('device-card-only-exposes-latest-or-origin-fallback-not-hidden-origin', async () => {
    const f = fixture(); try {
      const item = f.parser.toChatCareItem(await f.seed());
      item.deviceRecord = '合成设备数值'; item.evidence.latest = { ...item.evidence.origin, messageId: 'later-you', quote: '合成后续片段丙', sentAt: 12 };
      assert.equal(f.parser.buildChatCareContext([item]).includes(item.evidence.origin.quote), false);
      assert.equal(f.parser.parseChatCareUpdates(input(item, [end(item.evidence.origin.quote)])).updates.length, 0);
      assert.equal(f.parser.parseChatCareUpdates(input(item, [end(item.evidence.latest.quote)])).updates[0].sourceMessageId, 'later-you');
      delete item.evidence.latest;
      assert.equal(f.parser.parseChatCareUpdates(input(item, [end(item.evidence.origin.quote)])).updates.length, 1);
    } finally { f.close(); }
  });
  await test('same-quote-prefers-latest-provenance-and-three-item-limit-unchanged', async () => {
    const f = fixture(); try {
      const item = f.parser.toChatCareItem(await f.seed());
      item.evidence.latest = { ...item.evidence.origin, messageId: 'latest-you', sentAt: 12 };
      const items = [0, 1, 2, 3].map(i => ({ ...item, id: 'synthetic-card-' + i }));
      const result = f.parser.parseChatCareUpdates({ ...input(item, items.map((_, i) => ({ ...end(item.evidence.origin.quote), item: i + 1 }))), items });
      assert.equal(result.updates.length, 3); assert.ok(result.updates.every(update => update.sourceMessageId === 'latest-you'));
      assert.ok(result.diagnostic.rejectionCodes.includes('care_update_limit'));
      const duplicate = f.parser.parseChatCareUpdates(input(item, [end(item.evidence.origin.quote), end(item.evidence.origin.quote)]));
      assert.equal(duplicate.updates.length, 1); assert.ok(duplicate.diagnostic.rejectionCodes.includes('care_item_duplicate'));
    } finally { f.close(); }
  });
  await test('actual-envelope-inspector-keeps-null-reference-for-domain-parser', async () => {
    const f = fixture(); try {
      const envelope = f.load('app/src/ai/behavior/actionChatFixedEnvelope.ts').inspectBaiyunFixedChatEnvelope(
        JSON.stringify({ messages: ['合成可见回复'], careUpdates: [end('合成旧片段甲')], shareResponses: [], innerReaction: null }));
      assert.equal(envelope.rootStatus, 'valid'); assert.equal(envelope.fields.messages.status, 'valid');
      assert.equal(envelope.fields.careUpdates.status, 'valid'); assert.equal(envelope.fields.careUpdates.value[0].from, null);
    } finally { f.close(); }
  });
  await test('real-ledger-same-source-continue-then-end-and-end-replay', async () => {
    const f = fixture(); try {
      const first = await f.seed();
      const update = { eventId: first.id, expectedRevision: first.revision, quote: '合成后续片段丙', state: '继续', sourceMessageId: 'progress-you', occurredAt: 15 };
      const [next] = await f.apply([update]);
      const continueId = f.journalWrites.at(-1).operationId;
      assert.equal(continueId, 'care-update-v3:' + hash(JSON.stringify(['synthetic-current-session', 'progress-you', first.id, update.quote])));
      await f.apply([{ ...update, expectedRevision: next.revision, state: '结束' }]);
      const still = await f.ledger.getBaiyunContinuityEvent(first.id);
      assert.equal(still, null); assert.notEqual(f.journalWrites.at(-1).operationId, continueId);
      await f.apply([{ ...update, expectedRevision: next.revision, state: '结束' }]);
      assert.equal(await f.ledger.getBaiyunContinuityEvent(first.id), null);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM continuity_event_links WHERE event_id=?').get(first.id).n, 0);
      assert.equal(f.storage.size, 0);
    } finally { f.close(); }
  });
  await test('card-provenance-persisted-in-original-session-and-old-strict-journal-shape', async () => {
    const f = fixture(); try {
      const event = await f.seed(), item = f.parser.toChatCareItem(event);
      const parsed = f.parser.parseChatCareUpdates(input(item, [end(item.evidence.origin.quote)]));
      await f.apply(parsed.updates, 'synthetic-focus-session');
      const operation = f.journalWrites.at(-1).logicalMutation;
      assert.equal(operation.sessionId, 'synthetic-origin-session'); assert.equal(operation.update.sourceMessageId, 'old-you');
      assert.equal(operation.update.occurredAt, 10); assert.equal('sourceSessionId' in operation.update, false);
      const journal = f.load('app/src/sync/syncContinuityPendingOperation.ts');
      assert.doesNotThrow(() => journal.parseContinuityPendingOperationJournal(JSON.stringify(f.journalWrites.at(-1))));
      assert.equal(await f.ledger.getBaiyunContinuityEvent(event.id), null);
    } finally { f.close(); }
  });
  await test('real-ledger-retains-revision-and-cancel-guards', async () => {
    const f = fixture(); try {
      const event = await f.seed(), item = f.parser.toChatCareItem(event);
      const parsed = f.parser.parseChatCareUpdates(input(item, [end(item.evidence.origin.quote)]));
      await f.apply([{ eventId: event.id, expectedRevision: event.revision, quote: '合成新修订', state: '继续', sourceMessageId: 'edited-you', occurredAt: 16 }]);
      await f.apply(parsed.updates); assert.ok(await f.ledger.getBaiyunContinuityEvent(event.id));
      assert.ok(f.rejected.includes('care_matter_revision_conflict'));
      const latest = await f.ledger.getBaiyunContinuityEvent(event.id);
      await f.apply(f.parser.parseChatCareUpdates(input(f.parser.toChatCareItem(latest), [end(latest.careEvidence.latest.quote)])).updates, 'synthetic-focus-session', { canCommit: () => false });
      assert.equal((await f.ledger.getBaiyunContinuityEvent(event.id)).revision, latest.revision);
    } finally { f.close(); }
  });
  await test('actual-heart-end-keeps-terminal-identity-and-replay-idempotent', async () => {
    const f = fixture(); try {
      const initial = await f.seed(); const id = 'body-care:synthetic-device';
      f.db.prepare('UPDATE continuity_events SET id=?,schema_version=2,source_id=?,coalescing_key=?,completion_rule_json=? WHERE id=?')
        .run(id, 'synthetic-device', 'heart-care:synthetic', JSON.stringify({ allOf: [], anyOf: ['you_confirmed_care_complete'] }), initial.id);
      for (const table of ['continuity_event_links', 'continuity_event_transitions']) f.db.prepare('UPDATE ' + table + ' SET event_id=? WHERE event_id=?').run(id, initial.id);
      const event = await f.ledger.getBaiyunContinuityEvent(id), item = f.parser.toChatCareItem({ ...event, deviceRecord: '合成设备数值' });
      const updates = f.parser.parseChatCareUpdates(input(item, [end(item.evidence.origin.quote)])).updates;
      await f.apply(updates, 'synthetic-focus-session'); const done = await f.ledger.getBaiyunContinuityEvent(id);
      assert.equal(done.status, 'completed'); assert.equal(done.careEvidence.latest.sessionId, 'synthetic-origin-session');
      const transitions = f.db.prepare('SELECT COUNT(*) n FROM continuity_event_transitions WHERE event_id=?').get(id).n;
      await f.apply(updates, 'synthetic-focus-session');
      assert.equal((await f.ledger.getBaiyunContinuityEvent(id)).revision, done.revision);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM continuity_event_transitions WHERE event_id=?').get(id).n, transitions);
    } finally { f.close(); }
  });
  await test('actual-focus-prepare-numbering-commit-card-end-without-private-history', async () => {
    const f = fixture(); try {
      const event = await f.seed(); const focus = f.load('app/src/focus/focusChatProtocol.ts');
      const logs = [{ id: 'technical', role: 'system', content: '合成技术状态', createdAt: 19, trigger: 'start' },
        { id: message.id, role: message.role, content: message.text, createdAt: message.sentAt, trigger: 'chat' }];
      const prepared = await focus.prepareJunluoFocusChatTurn({ logs, sessionId: 'synthetic-focus-session', youMessage: logs[1] });
      assert.deepEqual(plain(focus.buildFocusCareRequestMessages(logs).map(value => value.content)),
        plain(f.parser.numberCareMessages(prepared.messages).map(value => value.content)));
      assert.ok(prepared.responseInstruction.includes(event.careEvidence.origin.quote));
      const rawEnvelope = JSON.stringify({ messages: ['合成回复'], careUpdates: [end(event.careEvidence.origin.quote)], shareResponses: [], innerReaction: null });
      await focus.commitJunluoFocusChatTurn({ prepared, rawEnvelope, assistantLogs: [{ id: 'synthetic-I', role: 'I', content: '合成回复', createdAt: 30, trigger: 'chat' }] });
      assert.equal(await f.ledger.getBaiyunContinuityEvent(event.id), null);
      assert.equal(f.journalWrites.at(-1).logicalMutation.sessionId, 'synthetic-origin-session');
    } finally { f.close(); }
  });
  assert.equal(externalRequests, 0, 'no transport attempt');
  const result = { status: 'passed', groups: cases.length, expectedGroups: 11, cases,
    sourceModules: Object.fromEntries(loaded), productionWrites: 0, externalRequests,
    scope: 'Actual two-source modules, original fixed-envelope/focus/journal code, real in-memory SQLite; storage/epoch/cleanup and unrelated auxiliary ports are synthetic. No provider or model execution. Only two approved guidance lines changed.' };
  assert.equal(cases.length, result.expectedGroups);
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, groups: result.groups, productionWrites: 0, externalRequests }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (hadFetch) globalThis.fetch = originalFetch; else delete globalThis.fetch;
});
