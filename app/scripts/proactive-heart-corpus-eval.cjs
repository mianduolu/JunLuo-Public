const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');

const appRoot = path.resolve(__dirname, '..');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
    esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function load(relative, mocks) {
  const exports = {};
  new Function('require', 'exports', compile(fs.readFileSync(path.join(appRoot, relative), 'utf8')))(name => {
    assert.ok(Object.prototype.hasOwnProperty.call(mocks, name), `unexpected dependency ${name}`);
    return mocks[name];
  }, exports);
  return exports;
}
const corpus = load('src/chat/heartCorpus.ts', {});
const values = new Map();
let failedKey;
let rows = [];
const storage = {
  getItem: async key => values.get(key) ?? null,
  setItem: async (key, value) => { if (key === failedKey) throw Error('synthetic-write-failure'); values.set(key, value); },
};
const chatStorage = {
  findChatSessionContainingMessage: async id => rows.some(row => row.id === id) ? 'synthetic-session' : null,
  loadChatSessionMessages: async () => rows.slice(),
  loadChatSessionMessageOrder: async () => rows.map(({ id, role, createdAt }) => ({ id, role, createdAt })),
  loadChatSessionMessagePage: async (_sessionId, { beforeIndex, limit }) => ({
    messages: rows.slice(Math.max(0, beforeIndex - limit), beforeIndex),
  }),
};
function loadStore() {
  return load('src/chat/heartCorpusStore.ts', {
    '@react-native-async-storage/async-storage': storage,
    '../backup/backupRestoreCoordinator': {
      captureBackupRestoreDataEpoch: () => 7,
      runBackupRestoreDataEpochCommit: async (_epoch, work) => ({ committed: true, value: await work() }),
    },
    '../sync/syncChatRelationshipStorageBridge': { chatRelationshipStorageBridge: storage },
    './chatStorage': chatStorage,
    './heartCorpus': corpus,
  });
}
let store = loadStore();
const message = (id, role, source, createdAt = 100, patch = {}) => ({
  id, role, content: `合成正文 ${id}`, createdAt, ...(source ? { source } : {}), ...patch,
});
const proactive = (id, createdAt = 100, patch = {}) => message(id, 'I', 'proactive-message', createdAt, patch);
const firstBatch = [proactive('synthetic-op:message:0'), proactive('synthetic-op:message:1'), proactive('synthetic-op:message:2')];
let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }
function reset(nextRows = firstBatch) { values.clear(); failedKey = undefined; rows = nextRows.slice(); store = loadStore(); }

async function main() {
  await test('ordinary private reply boundaries remain unchanged', () => {
    const chat = [message('you-1', 'you'), message('you-2', 'you'), message('I-1', 'I'), message('I-2', 'I')];
    const round = corpus.findHeartReplyRound(chat, 'I-2');
    assert.deepEqual(round.youMessages.map(row => row.id), ['you-1', 'you-2']);
    assert.deepEqual(round.iMessages.map(row => row.id), ['I-1', 'I-2']);
    assert.equal(round.firstId, 'I-1');
    assert.equal(corpus.findHeartReplyRound([message('I-alone', 'I')], 'I-alone'), null);
  });
  await test('each proactive bubble has its own heart without inventing a preceding you', () => {
    const chat = [message('unrelated-you', 'you'), message('ordinary-I', 'I'), ...firstBatch];
    for (const anchor of firstBatch) {
      const round = corpus.findHeartReplyRound(chat, anchor.id);
      assert.equal(round.firstId, anchor.id);
      assert.deepEqual(round.youMessages, []);
      assert.deepEqual(round.iMessages, [anchor]);
      assert.equal(round.exportable, true);
    }
  });
  await test('same or different proactive batches and camera responses do not merge', () => {
    const camera = proactive('synthetic-op:camera-response:0');
    const next = proactive('next-op:message:0');
    const chat = [...firstBatch, camera, next];
    assert.deepEqual(corpus.findHeartReplyRound(chat, firstBatch[1].id).iMessages, [firstBatch[1]]);
    assert.deepEqual(corpus.findHeartReplyRound(chat, camera.id).iMessages, [camera]);
    assert.deepEqual(corpus.findHeartReplyRound(chat, next.id).iMessages, [next]);
  });
  await test('recovered and older proactive ids use exactly their original bubble', () => {
    const recovered = [0, 1].map(index => proactive(`synthetic-op:bad-envelope-recovery:token:message:${index}`));
    assert.deepEqual(corpus.findHeartReplyRound([...firstBatch, ...recovered], recovered[1].id).iMessages, [recovered[1]]);
    const old = [proactive('old-one'), proactive('old-two')];
    assert.deepEqual(corpus.findHeartReplyRound(old, 'old-two').iMessages, [old[1]]);
  });
  await test('failed proactive delivery and unrelated message sources stay outside the new path', () => {
    const failed = proactive('failed:message:0', 100, { deliveryStatus: 'failed' });
    assert.equal(corpus.findHeartReplyRound([failed], failed.id), null);
    for (const source of ['letter', 'tool-call', 'schedule-reminder', 'life-message', 'voice-call']) {
      const row = message(`synthetic-${source}`, 'I', source);
      assert.equal(corpus.findHeartReplyRound([row], row.id), null);
    }
    const interrupted = [firstBatch[0], message('new-you', 'you'), firstBatch[1]];
    assert.deepEqual(corpus.findHeartReplyRound(interrupted, firstBatch[0].id).iMessages, [firstBatch[0]]);
  });
  await test('proactive exports preserve only real I text and use real message chronology', () => {
    const round = corpus.findHeartReplyRound(firstBatch, firstBatch[0].id);
    const resolved = { ...round, sessionId: 'synthetic-session',
      entry: corpus.createHeartCorpusEntry({ legacy: false, now: 200, round, sessionId: 'synthetic-session' }) };
    assert.deepEqual(corpus.parseHeartCorpusIndex(JSON.stringify({ schemaVersion: 1, updatedAt: 200,
      entries: [resolved.entry] })).entries[0].youMessageIds, []);
    const markdown = corpus.buildHeartCorpusMarkdown([resolved]);
    assert.ok(!markdown.includes('### 我说'));
    const exported = JSON.parse(corpus.buildHeartCorpusJsonl([resolved]).trim());
    assert.deepEqual(exported.messages.map(row => row.role), ['I']);
    assert.deepEqual(exported.messages.map(row => row.content), [firstBatch[0].content]);
    const older = { ...resolved, youMessages: [message('older-you', 'you', undefined, 50)], replyRoundId: 'older-round' };
    assert.deepEqual(corpus.sortHeartCorpusForExport([resolved, older]).map(row => row.replyRoundId), ['older-round', resolved.replyRoundId]);
  });
  await test('multimodal proactive collections preserve the existing text-only export rule', () => {
    const row = proactive('image:message:0', 100, { images: [{ id: 'synthetic-image' }] });
    assert.equal(corpus.findHeartReplyRound([row], row.id).exportable, false);
  });
  await test('real collection store saves and cancels individual bubbles without duplicates', async () => {
    reset();
    const round = corpus.findHeartReplyRound(rows, firstBatch[0].id);
    const saved = await store.toggleHeartReplyRound({ now: 200, round, sessionId: 'synthetic-session' });
    assert.equal(saved.liked, true);
    assert.deepEqual(saved.activeIds, [firstBatch[0].id]);
    const second = await store.toggleHeartReplyRound({ now: 201,
      round: corpus.findHeartReplyRound(rows, firstBatch[1].id), sessionId: 'synthetic-session' });
    assert.deepEqual(second.activeIds, [firstBatch[0].id, firstBatch[1].id]);
    const cancelled = await store.toggleHeartReplyRound({ now: 202, round, sessionId: 'synthetic-session' });
    assert.equal(cancelled.liked, false);
    assert.deepEqual(await store.loadActiveHeartRoundIds(), [firstBatch[1].id]);
    assert.equal(JSON.parse(values.get(corpus.HEART_CORPUS_INDEX_KEY)).entries.length, 2);
  });
  await test('cold store reload resolves I-only entries into the visible collection list', async () => {
    reset();
    const before = JSON.stringify(rows);
    const round = corpus.findHeartReplyRound(rows, firstBatch[0].id);
    await store.toggleHeartReplyRound({ now: 200, round, sessionId: 'synthetic-session' });
    store = loadStore();
    const resolved = await store.loadResolvedHeartCorpusRounds();
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0].youMessages, []);
    assert.deepEqual(resolved[0].iMessages, [firstBatch[0]]);
    assert.equal(JSON.stringify(rows), before);
    await store.removeHeartCorpusRound(round.replyRoundId);
    assert.deepEqual(await store.loadResolvedHeartCorpusRounds(), []);
    assert.equal(JSON.stringify(rows), before);
  });
  await test('later deliveries in the same proactive batch do not prune an already saved favorite', async () => {
    reset([firstBatch[0]]);
    await store.toggleHeartReplyRound({ now: 200,
      round: corpus.findHeartReplyRound(rows, firstBatch[0].id), sessionId: 'synthetic-session' });
    rows = firstBatch.slice();
    store = loadStore();
    const resolved = await store.loadResolvedHeartCorpusRounds();
    assert.deepEqual(await store.loadActiveHeartRoundIds(), [firstBatch[0].id]);
    assert.equal(resolved.length, 1);
    assert.deepEqual(resolved[0].iMessages, [firstBatch[0]]);
    rows = rows.filter(row => row.id !== firstBatch[1].id);
    assert.equal((await store.loadResolvedHeartCorpusRounds()).length, 1);
  });
  await test('reactivating a proactive favorite preserves its first real heart time', async () => {
    reset();
    const round = corpus.findHeartReplyRound(rows, firstBatch[0].id);
    await store.toggleHeartReplyRound({ now: 200, round, sessionId: 'synthetic-session' });
    await store.toggleHeartReplyRound({ now: 201, round, sessionId: 'synthetic-session' });
    await store.toggleHeartReplyRound({ now: 202, round, sessionId: 'synthetic-session' });
    const [saved] = await store.loadResolvedHeartCorpusRounds();
    assert.equal(saved.entry.firstHeartedAt, 200);
    assert.equal(saved.entry.lastHeartedAt, 202);
  });
  await test('failed active-id persistence does not report a successful favorite', async () => {
    reset();
    failedKey = corpus.LIKED_HEART_ROUND_IDS_KEY;
    await assert.rejects(store.toggleHeartReplyRound({ now: 200,
      round: corpus.findHeartReplyRound(rows, firstBatch[0].id), sessionId: 'synthetic-session' }), /synthetic-write-failure/);
    assert.deepEqual(await store.loadActiveHeartRoundIds(), []);
  });
  await test('deleting the original favored bubble removes only its now-missing favorite', async () => {
    reset();
    await store.toggleHeartReplyRound({ now: 200,
      round: corpus.findHeartReplyRound(rows, firstBatch[0].id), sessionId: 'synthetic-session' });
    rows = rows.filter(row => row.id !== firstBatch[0].id);
    assert.deepEqual(await store.loadResolvedHeartCorpusRounds(), []);
    assert.deepEqual(await store.loadActiveHeartRoundIds(), []);
  });
  await test('the existing controller uses the shared round for the bubble heart entry and save', async () => {
    reset();
    const source = fs.readFileSync(path.join(appRoot, 'src/chat/useChatMessageInteractionController.ts'), 'utf8');
    const ast = ts.createSourceFile('controller.ts', source, ts.ScriptTarget.Latest, true);
    const declarations = [];
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ['getAssistantReplyRound', 'toggleAssistantReplyRoundHeart'].includes(node.name.getText(ast))) {
        declarations.push(`const ${node.getText(ast)};`);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.equal(declarations.length, 2);
    const liked = [];
    const runtime = { messages: { activeSessionId: 'synthetic-session', messagesRef: { current: rows } },
      findHeartReplyRound: corpus.findHeartReplyRound, captureBackupRestoreDataEpoch: () => 7,
      canCommitBackupRestoreDataEpoch: epoch => epoch === 7, ...chatStorage,
      toggleHeartReplyRound: store.toggleHeartReplyRound, setLikedStyleReferenceIds: ids => liked.push(ids),
      showShortMemoryNotice: () => undefined, page: { onError: text => assert.fail(text) } };
    const controller = new Function(...Object.keys(runtime), compile(declarations.join('\n'))
      + '\nreturn {getAssistantReplyRound, toggleAssistantReplyRoundHeart};')(...Object.values(runtime));
    assert.equal(controller.getAssistantReplyRound(firstBatch[0]).firstId, firstBatch[0].id);
    await controller.toggleAssistantReplyRoundHeart(firstBatch[0]);
    assert.deepEqual(liked, [[firstBatch[0].id]]);
    assert.equal((await store.loadResolvedHeartCorpusRounds()).length, 1);
  });
  await test('collection UI omits an empty you section without inventing a replacement message', () => {
    const source = fs.readFileSync(path.join(appRoot, 'src/screens/FavoritesScreen.tsx'), 'utf8');
    assert.ok(source.includes('round.youMessages.length ? <>'));
    assert.ok(source.includes('<RoundMessages messages={round.iMessages} />'));
    const screen = fs.readFileSync(path.join(appRoot, 'src/screens/ChatScreen.tsx'), 'utf8');
    assert.ok(screen.includes('showAssistantRoundLike={isAssistantRoundStart}'));
  });
  console.log(`RESULT ${passed}/15 proactive heart groups; HTTP=0, model=0, business_storage=0`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
