/* New recovered-body boundary only. Actual extraction/inspection/delivery/storage;
 * native storage, sync bridge and event transport are RAM ports. No model or App.
 * Run from app: node scripts/recovered-reply-chat-display-eval.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const fileFor = name => path.join(root, 'src', `${name}.ts`);
const read = name => fs.readFileSync(fileFor(name), 'utf8');
function evaluate(source, imports, filename) {
  const box = { exports: {} };
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
  } }).outputText;
  vm.runInNewContext(js, { exports: box.exports, module: box, console, Date, Math, Promise, Map, Set,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `unexpected dependency ${filename}: ${name}`);
      return imports[name];
    }, fetch() { throw Error('network forbidden'); },
  }, { filename });
  return box.exports;
}
function load(name, imports = {}) { return evaluate(read(name), imports, name); }
const retired = load('ai/retiredAssistantFeatureData');
const transport = load('ai/replyTransportFormatting');
const evidence = load('ai/responseEvidenceWire');
const visible = load('ai/visibleReplyExtraction', {
  './replyTransportFormatting': transport, './responseEvidenceWire': evidence,
});
const reading = load('reading/readingReference');
const subjective = load('ai/subjectiveMessages', {
  './visibleReplyExtraction': visible, './replyTransportFormatting': transport,
  './retiredAssistantFeatureData': retired, '../reading/readingReference': reading,
  '../chat/chatExpenseMaterials': { expensePlanHistoryMaterial() { throw Error('unused history port'); } },
  '../chat/chatReminderMaterials': { reminderPlanHistoryMaterial() { throw Error('unused history port'); } },
});
const inspector = load('ai/behavior/actionChatFixedEnvelope', {
  '../visibleReplyExtraction': visible, '../../wishPool/wishPoolChatContract': load('wishPool/wishPoolChatContract'),
});
const display = load('chat/chatMessageDisplay', { '../ai/replyTransportFormatting': transport });
// Supply its real lexical dependency without loading the HTTP provider module.
const providerAst = ts.createSourceFile('provider', read('ai/openAiCompatibleProvider'), ts.ScriptTarget.Latest, true);
const envelopeNode = providerAst.statements.find(item => ts.isFunctionDeclaration(item)
  && item.name?.text === 'getSemanticEnvelopeForVisibleReply');
const semanticEnvelope = evaluate('const normalizeVisibleReplyRaw = require("visible").normalizeVisibleReplyRaw;\n'
  + envelopeNode.getText(providerAst) + '\nexports.convert = getSemanticEnvelopeForVisibleReply;',
{ visible }, 'provider-envelope-function').convert;
const bubbleSource = fs.readFileSync(path.join(root, 'src/chat/ChatMessageBubble.tsx'), 'utf8');
const bubbleAst = ts.createSourceFile('ChatMessageBubble.tsx', bubbleSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let failureExpression;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(bubbleAst) === 'assistantTechnicalFailure') failureExpression = node.initializer;
  ts.forEachChild(node, visit);
}
visit(bubbleAst);
assert.ok(failureExpression);
const isTechnicalFailure = evaluate(`exports.check = message => (${failureExpression.getText(bubbleAst)});`, {}, 'actual-bubble-failure-expression').check;

async function fixture() {
  const data = new Map(), events = [];
  const raw = {
    async getItem(key) { return data.get(key) ?? null; },
    async multiGet(keys) { return keys.map(key => [key, data.get(key) ?? null]); },
    async getAllKeys() { return [...data.keys()]; },
    async setItem(key, value) { data.set(key, value); },
    async multiSet(rows) { rows.forEach(([key, value]) => data.set(key, value)); },
    async removeItem(key) { data.delete(key); },
    async multiRemove(keys) { keys.forEach(key => data.delete(key)); },
  };
  const epoch = load('backup/backupRestoreCoordinator');
  const primary = load('chat/primaryChat');
  const storage = load('chat/chatStorage', {
    '@react-native-async-storage/async-storage': { default: raw },
    '../runtime/runtimeWorkloadDiagnostics': { observeRuntimeWorkload: (_, work) => work() },
    '../sync/syncChatStorageBridge': { chatStorageSyncBridge: raw, chatStorageSyncReplayBridge: raw },
    '../ai/subjectiveMessages': subjective, '../reading/readingReference': reading,
    './chatExpensePlan': {}, './chatReminderPlan': {}, '../voiceCall/voiceCallRecord': {}, './chatTextFileReference': {},
    '../ai/retiredAssistantFeatureData': retired,
    './serializedMessageRecordCache': load('chat/serializedMessageRecordCache'),
    '../proactive/phoneCareFollowUpStore': { observePhoneCareChatChanges: async () => {}, stopPhoneCareFollowUp: async () => {} },
    './primaryChat': primary,
    './chatDataChanges': { emitChatDataChanged() {}, subscribeChatDataChanges: () => () => {} },
    './chatPersistenceCoordinator': load('chat/chatPersistenceCoordinator'),
    '../backup/backupRestoreCoordinator': epoch,
    './chatImageRecord': load('chat/chatImageRecord'), './chatSummaryCorrection': load('chat/chatSummaryCorrection'),
    './chatReplyDraft': load('chat/chatReplyDraft'), '../life/sleepPlanPolicy': load('life/sleepPlanPolicy'),
    '../proactive/unifiedContactStore': { observeContactYouMessage: async () => {} },
    './chatAuxiliaryDiagnostics': { runChatAuxiliaryOperation: async (_, work) => work() },
    '../life/junluoDesireRuntime': { noteJunluoYouMessage: async () => {} },
  });
  const messageEvents = load('chat/chatMessageEvents', {
    'react-native': { DeviceEventEmitter: { emit: (name, event) => events.push({ name, event: plain(event) }) } },
  });
  const state = await storage.loadChatState();
  const sessionId = state.activeSessionId;
  const messagesRef = { current: [] }, sessionsRef = { current: [{ id: sessionId, messages: [] }] };
  const delivery = load('chat/chatReplyDelivery', {
    '../ai/persona/expressionLibrary': { baiyunExpressionLibrary: [] },
    '../ai/persona/stickerLibrary': { loadStickerLibrary: async () => [], pickRandomSticker: () => null },
    '../ai/subjectiveMessages': subjective, './chatStorage': storage,
    './chatMusicLogic': load('chat/chatMusicLogic', {
      '../music/musicCommands': load('music/musicCommands', { '../ai/visibleReplyExtraction': visible }),
    }),
  }).createChatReplyDelivery({
    activeSessionRef: { current: sessionId }, messagesSessionIdRef: { current: sessionId }, messagesRef, sessionsRef,
    getCurrentMusicCardLimit: () => 0, wait: async () => {},
    commitMessages: messages => { messagesRef.current = messages; return true; },
    commitSessionMessages: (id, messages) => { sessionsRef.current = [{ id, messages }]; },
  });
  return { storage, messageEvents, events, epoch, sessionId, messagesRef, delivery };
}

let passed = 0, total = 0;
async function test(name, run) {
  total += 1;
  try { await run(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL ${name}: ${error.stack}`); }
}
async function throughChat(extracted, expected) {
  assert.equal(extracted.status, 'visible');
  assert.deepEqual(plain(extracted.messages), expected);
  const fixed = inspector.inspectBaiyunFixedChatEnvelope(semanticEnvelope(extracted));
  assert.equal(fixed.fields.messages.status, 'valid');
  for (const field of ['careUpdates', 'shareResponses', 'innerReaction']) {
    assert.notEqual(fixed.fields[field].status, 'valid', `${field} cannot be authorized by body-only recovery`);
  }
  const f = await fixture();
  const messages = await f.delivery.appendAssistantBubbles(fixed.fields.messages.value, {}, [], () => true,
    { targetSessionId: f.sessionId });
  assert.deepEqual(plain(f.messagesRef.current.map(message => message.content)), expected);
  for (const message of messages) {
    assert.equal(message.role, 'I'); assert.equal(message.deliveryStatus, undefined);
    assert.equal(isTechnicalFailure(message), false);
    const text = display.getDisplayedChatMessageContent(message);
    assert.equal(display.hasRenderableChatMessageContent(message, text), true);
    assert.equal(text, message.content);
  }
  const stored = await f.storage.appendMessagesToChatSession(f.sessionId, messages,
    { dataEpoch: f.epoch.captureBackupRestoreDataEpoch(), requireActiveSession: true });
  assert.deepEqual(plain(stored.messages.map(message => message.content)), expected);
  const reread = await Promise.all(messages.map(message => f.storage.loadChatSessionMessage(f.sessionId, message.id)));
  assert.deepEqual(plain(reread), plain(messages));
  f.messageEvents.emitChatMessagesAppended({ sessionId: f.sessionId, messages: reread, source: 'local-eval-only' });
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].name, 'junluoChatMessagesAppended');
  assert.deepEqual(f.events[0].event.messages, plain(messages));
}
(async () => {
  await test('closed direct JSON fence reaches ordinary I bubbles and formal RAM append/event', async () => {
    const messages = ['第一段完整正文。', '第二段完整正文。'];
    const raw = '```json\n' + JSON.stringify({ messages, careUpdates: [{ text: 'synthetic machine' }],
      shareResponses: [], innerReaction: 'synthetic internal' }) + '\n```';
    await throughChat(visible.extractVisibleReplyFromRaw({ raw, allowPlainText: false, expectedStructure: 'single_root_json' }), messages);
  });
  await test('repeated complete reasoning messages reach normal chat while hidden material stays out', async () => {
    const messages = ['这是一句完整的合成正文。'];
    const raw = JSON.stringify({ messages, careUpdates: [{ text: 'synthetic machine A' }] });
    const reasoning = 'synthetic preparation\n' + raw + '\nsynthetic repeated preparation\n'
      + JSON.stringify({ messages, innerReaction: 'synthetic machine B' }) + '\n{"thought":';
    await throughChat(visible.extractVisibleReply({ directContent: '', reasoningContent: reasoning,
      allowReasoningRecovery: true, expectedStructure: 'single_root_json' }), messages);
  });
  await test('complete messages with broken optional tail remain body-only and display normally', async () => {
    const messages = ['尾部字段损坏前，这句正文已经完整。'];
    const raw = '{"messages":' + JSON.stringify(messages) + ',"innerReaction":"unfinished';
    await throughChat(visible.extractVisibleReplyFromRaw({ raw, allowPlainText: false, expectedStructure: 'single_root_json' }), messages);
  });
  await test('incomplete body is not promoted and actual failed-bubble display remains distinct', async () => {
    const extracted = visible.extractVisibleReplyFromRaw({ raw: '{"messages":["unfinished',
      allowPlainText: false, expectedStructure: 'single_root_json' });
    assert.notEqual(extracted.status, 'visible');
    assert.equal(isTechnicalFailure({ role: 'I', deliveryStatus: 'failed', deliveryError: 'synthetic failure' }), true);
  });
  await test('complete legitimate reasoning tail retains the existing fixed-field contract', async () => {
    const messages = ['合法尾根的合成正文。'];
    const raw = JSON.stringify({ messages, innerReaction: 'synthetic valid machine field' });
    const extracted = visible.extractVisibleReply({ directContent: '', reasoningContent: 'synthetic preparation\n' + raw,
      allowReasoningRecovery: true, expectedStructure: 'single_root_json' });
    const fixed = inspector.inspectBaiyunFixedChatEnvelope(semanticEnvelope(extracted));
    assert.equal(fixed.fields.messages.status, 'valid');
    assert.equal(fixed.fields.innerReaction.status, 'valid', 'this pre-existing complete-root path is not body-only recovery');
  });
  console.log(`RESULT ${passed}/${total}`);
  console.log('BOUNDARY actual_modules_and_two_AST_selected_pure_functions RAM_storage_event_UI_ports HTTP=0 real_storage=0 private_text=0 production_changes=0 native_paint=0 full_chat_runtime=0');
})().catch(error => { console.error(error); process.exitCode = 1; });
