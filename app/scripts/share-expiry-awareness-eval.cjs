'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const project = path.resolve(__dirname, '../..');
const sourceRoot = process.argv[2] ? path.resolve(process.argv[2]) : project;
const ts = require(path.join(project, 'app/node_modules/typescript'));
const read = file => fs.readFileSync(fs.existsSync(path.join(sourceRoot, file))
  ? path.join(sourceRoot, file) : path.join(project, file), 'utf8');
let now = 2_000_000_000;
class Clock extends Date { static now() { return now; } }
let fetchAttempts = 0;
const noFetch = () => { fetchAttempts += 1; throw Error('Unexpected fetch'); };
const results = [];
function transpile(source, file) {
  const result = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } });
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  return result.outputText;
}
function evaluate(source, file, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(source, file), {
    module, exports: module.exports, require: id => {
      if (!(id in dependencies)) throw Error('Unexpected dependency: ' + id);
      return dependencies[id];
    }, Date: Clock, Map, Set, fetch: noFetch, ...globals,
  });
  return module.exports;
}
const load = (file, dependencies = {}) => evaluate(read(file), file, dependencies);
const plain = value => JSON.parse(JSON.stringify(value));
const coreFile = 'app/src/ai/behavior/actionShareResponse.ts';
const storeFile = 'app/src/ai/behavior/actionShareResponseStore.ts';
const chatFile = 'app/src/chat/chatReplyRuntime.ts';
const focusFile = 'app/src/focus/focusChatProtocol.ts';
const dispatchFile = 'app/src/proactive/unifiedContactDispatch.ts';
const materialsFile = 'app/src/proactive/unifiedContactMaterials.ts';
const core = load(coreFile);
const presentation = load('app/src/ai/behavior/actionShareResponsePresentation.ts', { './actionShareResponse': core });
const DAY = core.BAIYUN_SHARE_RESPONSE_WAIT_MS;
function share(id, overrides = {}) {
  return { id, sessionId: 's', origin: 'chat_action', invitationKind: 'self_driven',
    sourceMessageIds: ['I-' + id], responseDriveKeys: [], excerpt: 'fixture-' + id,
    state: 'waiting', createdAt: now - DAY - 100, ...overrides };
}
let stored = [];
let letters = [];
let storageWrites = 0;
let storageReads = 0;
let letterReads = 0;
let letterError = false;
const storage = {
  getItem: async () => { storageReads += 1; return JSON.stringify(stored); },
  setItem: async () => { storageWrites += 1; throw Error('Read path attempted write'); },
};
const store = load(storeFile, {
  '../../sync/syncProactiveLedgerStorageBridge': { proactiveLedgerStorageBridge: storage },
  './actionShareResponse': core, './actionShareResponsePresentation': presentation,
  '../../chat/chatAfterglowProbe': { formatChatAfterglowMessageTime: value => 'T' + value },
  '../../letters/letterStore': { loadLetters: async () => {
    letterReads += 1; if (letterError) throw Error('fixture letter read failed'); return letters;
  } },
});
const materialDependencies = {
  '../ai/assistantNearStatus': { selectNearStatusConversation: messages => messages },
  '../chat/chatAfterglowProbe': { formatChatAfterglowMessageTime: String },
  '../ai/assistantAffectPaper': { formatPreviousAffect: () => 'AFFECT' },
  '../life/junluoDesireMetabolism': { buildJunluoDesirePromptPaper: () => '', DESIRE_LINES: {} },
  '../ai/nearStatusLifeMaterialFormat': { formatNearStatusLifeEntries: items => items.map(x => x.promptLine).join('\n') },
  './unifiedContact': { CONTACT_AFFECT_AFTER_CHAT: 'AFTER', buildUnsentContactMessages: () => '' },
  './contactWaiting': { formatContactWaiting: value => value ? 'WAITING' : '', formatContactWaitingDuration: () => 'IDLE' },
  './proactiveLitePrompt': { formatProactiveIdleDuration: () => '' },
};
const materialApi = load(materialsFile, materialDependencies);
async function test(name, fn) { await fn(); results.push(name); }
function extractFunctionSource(file, name) {
  const parsed = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2023, true);
  const node = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert(node, name + ' function exists');
  return node.getText(parsed);
}
async function main() {
  await test('exact TTL boundary and recent24h cutoff', async () => {
    const row = share('boundary', { createdAt: now - DAY });
    assert.equal(core.getBaiyunExpiredShareAwarenessItems([row], now - 1).length, 0);
    assert.equal(core.getBaiyunExpiredShareAwarenessItems([row], now).length, 1);
    assert.equal(core.getBaiyunExpiredShareAwarenessItems([row], now + DAY - 1).length, 1);
    assert.equal(core.getBaiyunExpiredShareAwarenessItems([row], now + DAY).length, 0);
  });
  await test('letter TTL is3days and legacy mirror exact IDs', async () => {
    const row = share('letter', { origin: 'letter', createdAt: now - 3 * DAY, sourceMessageIds: ['letter-x-original'] });
    const mirror = share('mirror', { createdAt: now - 3 * DAY, sourceMessageIds: ['letter-x-original'] });
    assert.equal(core.getBaiyunExpiredShareAwarenessItems([row], now).length, 1);
    assert.equal(core.getBaiyunExpiredShareAwarenessItems([mirror], now).length, 1);
    assert.equal(core.getBaiyunExpiredShareAwarenessItems([{ ...row, createdAt: now - DAY }], now).length, 0);
  });
  await test('engaged declined and nonTTL unanswered excluded', async () => {
    const rows = [share('engaged', { state: 'engaged', resolvedAt: now - 100 }),
      share('declined', { state: 'declined', resolvedAt: now - 100 }),
      share('not-ttl', { state: 'unanswered', resolvedAt: now - 50 })];
    assert.equal(core.getBaiyunExpiredShareAwarenessItems(rows, now).length, 0);
  });
  await test('already persisted TTL unanswered retained as original deadline', async () => {
    const row = share('ended', { state: 'unanswered', resolvedAt: now - 100 });
    const result = core.getBaiyunExpiredShareAwarenessItems([row], now);
    assert.equal(result.length, 1);
    assert.equal(result[0].deadlineAt, row.resolvedAt);
  });
  await test('only latest4 and original80codepoints', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => share('n' + i,
      { createdAt: now - DAY - i, excerpt: 'a'.repeat(79) + '✨' + 'unused' }));
    const picked = core.getBaiyunExpiredShareAwarenessItems(rows, now);
    assert.deepEqual(plain(picked).map(x => x.id), ['n0', 'n1', 'n2', 'n3']);
    assert.equal(Array.from(picked[0].excerpt).length, 80);
    assert.equal(picked[0].excerpt, 'a'.repeat(79) + '✨');
  });
  await test('approved exact four lines and no mood directive', async () => {
    const text = core.buildBaiyunExpiredShareAwarenessPrompt([{ id: 'x', excerpt: 'fixture',
      sharedAt: 11, deadlineAt: 22 }], String);
    assert.equal(text, '【I 分享过的事】\n分享：fixture\n分享时间：11\n截至 22，I 还没有记到 you 对这件事的回应。');
    assert(!text.includes('放下'));
  });
  await test('deleted letter and confirmed reply excluded before latest4 selection', async () => {
    stored = Array.from({ length: 6 }, (_, i) => share('deleted-' + i, { origin: 'letter',
      sourceMessageIds: ['letter-gone' + i + '-original'], createdAt: now - 3 * DAY - i }));
    stored.push(share('replied', { origin: 'letter', sourceMessageIds: ['letter-replied-original'],
      createdAt: now - 3 * DAY - 10 }));
    stored.push(share('valid', { createdAt: now - DAY - 20 }));
    letters = [{ id: 'replied', kind: 'exchange', replyContent: 'fixture reply' }];
    const snapshot = JSON.stringify(stored);
    const result = await store.loadBaiyunExpiredShareAwareness(now);
    assert.deepEqual(plain(result.expiredShareItems).map(x => x.id), ['valid']);
    assert(!result.expiredShareInstruction.includes('fixture-deleted'));
    assert.equal(JSON.stringify(stored), snapshot);
  });
  await test('unopened future letter omitted and opened exact source accepted', async () => {
    stored = [share('future', { origin: 'letter', sourceMessageIds: ['letter-future-original'],
      createdAt: now - 3 * DAY - 100 })];
    letters = [{ id: 'future', kind: 'future-self' }];
    assert.equal((await store.loadBaiyunExpiredShareAwareness(now)).expiredShareItems.length, 0);
    letters[0].openedAt = now - 50;
    assert.equal((await store.loadBaiyunExpiredShareAwareness(now)).expiredShareItems.length, 1);
    letters[0].openedAt = now + 1;
    assert.equal((await store.loadBaiyunExpiredShareAwareness(now)).expiredShareItems.length, 0);
  });
  await test('letter read failure omits only awareness and preserves waiting ordinals', async () => {
    stored = [share('ended'), share('active', { createdAt: now - 1 })];
    letters = []; letterError = true;
    const result = await store.loadBaiyunPendingSharePromptContext('s', undefined, now);
    assert.equal(result.expiredShareItems.length, 0);
    assert.equal(result.expiredShareInstruction, '');
    assert.equal(result.fixedItems.length, 1);
    assert.equal(result.fixedItems[0].pendingShareId, 'active');
    assert(result.fixedInstruction.includes('"pendingShareId":1'));
    letterError = false;
  });
  await test('store waiting IDs and settlement unaffected by expired awareness', async () => {
    stored = [share('old'), share('active-a', { createdAt: now - 2 }),
      share('active-b', { createdAt: now - 1 })]; letters = [];
    const result = await store.loadBaiyunPendingSharePromptContext('s', undefined, now);
    assert.equal(result.expiredShareItems.length, 1);
    assert.deepEqual(plain(result.fixedItems).map(x => x.pendingShareId), ['active-a', 'active-b']);
    assert.deepEqual(plain(result.settlementItems).map(x => x.pendingShareId), ['active-a', 'active-b']);
    assert(!result.fixedInstruction.includes('old'));
  });
  await test('ordinary chat actual fixed-data block appends awareness after waiting', async () => {
    const source = read(chatFile); const start = source.indexOf('    const fixedResponseDataInstructions = [');
    const end = source.indexOf('\n    ];', start) + '\n    ];'.length;
    const module = evaluate(source.slice(start, end) + '\nexports.result=fixedResponseDataInstructions;', chatFile, {}, {
      wishMode: false, isInteractionReply: false, careItems: [],
      buildChatCareContext: () => 'CARE', buildChatCareGuidance: () => 'CARE_GUIDE',
      CHAT_PRESENCE_GUIDANCE: 'PRESENCE', BAIYUN_CHAT_FIXED_SHARE_RESPONSE_GUIDANCE_PROTOCOL: 'WAIT_GUIDE',
      pendingShareContext: { fixedItems: [{}], fixedInstruction: 'WAIT_ITEMS', expiredShareInstruction: 'EXPIRED' },
    });
    assert.deepEqual(plain(module.result), ['CARE\n\nCARE_GUIDE', 'PRESENCE', 'WAIT_GUIDE\n\nWAIT_ITEMS', 'EXPIRED']);
    const emptyStart = source.indexOf('const EMPTY_BAIYUN_PROMPT_CONTEXT = {');
    const emptyEnd = source.indexOf('\n} as const;', emptyStart) + '\n} as const;'.length;
    const empty = evaluate(source.slice(emptyStart, emptyEnd) + '\nexports.value=EMPTY_BAIYUN_PROMPT_CONTEXT;', chatFile);
    assert.equal(empty.value.expiredShareInstruction, '');
    assert.deepEqual(plain(empty.value.expiredShareItems), []);
  });
  await test('focus actual prepare places awareness after original waiting without new messages', async () => {
    const source = extractFunctionSource(focusFile, 'prepareJunluoFocusChatTurn');
    const api = evaluate(source + '\nexports.prepare=prepareJunluoFocusChatTurn;', focusFile, {}, {
      captureBackupRestoreDataEpoch: () => 1, runChatAuxiliaryOperation: async (_o, work) => ({ ok: true, value: await work() }),
      prepareUnifiedContactChatHandoff: async () => null, isFocusSleepReplyReceipt: () => false,
      isFocusOrganizationLog: () => false, listChatCareMatters: async () => [], listBaiyunContinuityLinks: async () => [],
      selectChatCareItems: () => [], buildChatCareContext: () => 'CARE', buildChatCareGuidance: () => 'CARE_GUIDE',
      BAIYUN_CHAT_FIXED_SHARE_RESPONSE_GUIDANCE_PROTOCOL: 'WAIT_GUIDE',
      loadBaiyunPendingSharePromptContext: async () => ({ fixedItems: [{ pendingShareId: 'active' }],
        fixedInstruction: 'WAIT_ITEMS', expiredShareInstruction: 'EXPIRED' }),
    });
    const message = { id: 'you', role: 'you', content: 'fixture', createdAt: now };
    const result = await api.prepare({ logs: [message], sessionId: 's', youMessage: message });
    assert(result.responseInstruction.indexOf('WAIT_ITEMS') < result.responseInstruction.indexOf('EXPIRED'));
    assert.equal(result.messages.length, 1);
    assert.equal(result.currentMessage.role, 'you');
    assert.equal(result.fixedShareItems[0].pendingShareId, 'active');
  });
  await test('proactive actual facts state follows waiting before original history', async () => {
    const text = materialApi.buildUnifiedContactFacts({ now, lastYouAt: now - 1,
      messages: [{ id: 'you', role: 'you', content: 'CHAT_SENTINEL', createdAt: now - 1 }],
      affect: { updatedAt: now }, desires: {}, motives: [], entries: [], ordinary: true,
      contactWaiting: {}, expiredShareInstruction: 'EXPIRED' });
    assert(text.indexOf('WAITING') < text.indexOf('EXPIRED'));
    assert(text.indexOf('EXPIRED') < text.indexOf('CHAT_SENTINEL'));
    const priority = materialApi.buildUnifiedContactFacts({ now, messages: [], affect: { updatedAt: now },
      desires: {}, motives: [], entries: [], ordinary: false, expiredShareInstruction: 'EXPIRED' });
    assert(!priority.includes('EXPIRED'));
  });
  await test('normal generate reads fresh awareness without changing frozen source refs', async () => {
    const source = read(dispatchFile); const start = source.indexOf('      const waiting = opportunity.materialVersion === 2');
    const end = source.indexOf('      const cameraObservationContext', start);
    assert(start >= 0 && end > start);
    const api = evaluate('async function run(opportunity) {\n' + source.slice(start, end)
      + '\nreturn baseFacts();\n}\nexports.run=run;', dispatchFile, {}, {
      sessionId: 's', latestYou: undefined, messages: [], affect: { updatedAt: now }, desires: {},
      entries: [], important: undefined, handoff: '', selectContactWaiting: () => ({}),
      loadContactWaitingMessages: async () => [], loadBaiyunExpiredShareAwareness: store.loadBaiyunExpiredShareAwareness,
      buildUnifiedContactFacts: materialApi.buildUnifiedContactFacts,
    });
    const op = { materialVersion: 2, important: false, motives: [], sources: [{ kind: 'life', id: 'original', version: 'v' }] };
    const originalRefs = JSON.stringify(op.sources);
    stored = [share('letter', { origin: 'letter', sourceMessageIds: ['letter-fresh-original'],
      createdAt: now - 3 * DAY - 100 })];
    letters = [{ id: 'fresh', kind: 'exchange' }];
    assert((await api.run(op)).includes('【I 分享过的事】'));
    letters[0].replyContent = 'fixture reply';
    assert(!(await api.run(op)).includes('【I 分享过的事】'));
    assert.equal(JSON.stringify(op.sources), originalRefs);
  });
  await test('material selection function and original budget unchanged', async () => {
    const current = fs.readFileSync(path.join(project, materialsFile), 'utf8');
    const functionPart = text => text.slice(text.indexOf('export function selectContactMaterialEntries('),
      text.indexOf('\nexport function buildContactMotivePaper(')).replace(/\r\n/g, '\n');
    assert.equal(functionPart(read(materialsFile)), functionPart(current));
    const selected = materialApi.selectContactMaterialEntries([
      { id: 'a', version: '1', text: 'a'.repeat(900) }, { id: 'b', version: '1', text: 'b'.repeat(900) },
    ], { ordinary: true });
    assert.equal(selected.length, 1);
  });
  await test('current letter resolver canCommit guards preserved in candidate', async () => {
    const source = read(storeFile);
    const begin = source.indexOf('export async function resolveBaiyunPendingShareResponses(');
    const end = source.indexOf('\nexport async function commitBaiyunFixedShareResponseLedger(', begin);
    const current = fs.readFileSync(path.join(project, storeFile), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(source.slice(begin, end), current.slice(current.indexOf('export async function resolveBaiyunPendingShareResponses('),
      current.indexOf('\nexport async function commitBaiyunFixedShareResponseLedger(')));
  });
  assert.equal(storageWrites, 0); assert.equal(fetchAttempts, 0);
  process.stdout.write(JSON.stringify({ passed: results.length, cases: results, fetchAttempts, storageWrites,
    storageReads, letterReads, scope: 'actual source functions with RAM ports and synthetic data; no model/device/real storage' }, null, 2) + '\n');
}
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
