const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const app = path.resolve(__dirname, '..');
const NOW = 1800000000000, OLD = NOW - 7200000, AUX = NOW - 3600000;
const files = ['ai/assistantAffectPaper.ts', 'life/junluoInnerState.ts', 'life/junluoInnerStateGeneration.ts',
  'chat/chatReplyRuntime.ts', 'screens/JunluoInnerStateDiaryCard.tsx'];
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX };
const source = file => fs.readFileSync(path.join(app, 'src', file), 'utf8');
const forbidden = () => { throw Error('NETWORK_OR_REAL_STORAGE_FORBIDDEN'); };
function moduleAt(file, dependencies = {}) {
  const module = { exports: {} }, filename = path.join(app, 'src', file);
  const compiled = ts.transpileModule(source(file), { fileName: filename, compilerOptions, reportDiagnostics: true });
  assert.equal(compiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  vm.runInNewContext(`(function(module,exports,require){${compiled.outputText}\n})`, { fetch: forbidden }, { filename })(
    module, module.exports, name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw Error('UNEXPECTED_DEPENDENCY: ' + file + ' -> ' + name);
    });
  return module.exports;
}
function find(file, predicate) {
  const tree = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let result;
  const visit = node => { if (predicate(node, tree)) { assert(!result, 'ambiguous actual source node'); result = node; } ts.forEachChild(node, visit); };
  visit(tree); assert(result, 'actual source node missing: ' + file); return result.getText(tree);
}
function evaluate(code, globals = {}, tail = 'value', filename = 'synthetic.ts') {
  const compiled = ts.transpileModule(code + '\nmodule.exports = ' + tail + ';', { fileName: filename, compilerOptions }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, ...globals, fetch: forbidden,
    require: name => {
      if (name === 'react/jsx-runtime') return { Fragment: 'Fragment', jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }) };
      throw Error('UNEXPECTED_DEPENDENCY: ' + name);
    } }, { filename });
  return module.exports;
}
const json = value => JSON.parse(JSON.stringify(value));
const inner = moduleAt('life/junluoInnerState.ts');
const persistence = moduleAt('life/junluoInnerStatePersistence.ts', { './junluoInnerState': inner });
const generation = moduleAt('life/junluoInnerStateGeneration.ts', { './junluoInnerState': inner,
  './junluoInnerStatePersistence': persistence, './junluoThoughtLifecycle': {} });
const presentation = moduleAt('life/junluoInnerStatePresentation.ts', { './junluoInnerState': inner });
const relationship = moduleAt('life/junluoRelationshipPolicy.ts');
const contact = moduleAt('proactive/unifiedContact.ts', { '../life/junluoRelationshipPolicy': relationship });
const time = evaluate(find('chat/chatAfterglowProbe.ts', node => ts.isFunctionDeclaration(node)
  && node.name?.text === 'formatChatAfterglowMessageTime'), {}, 'formatChatAfterglowMessageTime');
const paper = moduleAt('ai/assistantAffectPaper.ts', {
  '../life/junluoInnerState': inner, '../life/junluoInnerStateGeneration': generation,
  '../life/junluoInnerStatePresentation': presentation, '../chat/chatAfterglowProbe': { formatChatAfterglowMessageTime: time },
  '../proactive/unifiedContact': contact,
});
const emotion = (extra = {}) => ({ emotionId: 'sad', intensity: 0.65, target: 'situation', occurredAt: OLD,
  operationId: 'synthetic:affect:emotion:0', sourceId: 'synthetic', ...extra });
const affect = (primary = emotion(), secondary = []) => ({ ...persistence.createDefaultJunluoAffectState(),
  emotions: { primary, secondary }, emotionsLastOperation: { operationId: 'synthetic:affect', occurredAt: OLD }, updatedAt: NOW });
const basket = (primary, secondary = []) => ({ emotions: { primary, secondary }, lifeState: null,
  relationshipFeeling: null, relationshipChoice: null, strain: null });
const inputEmotion = (extra = {}) => ({ id: 'sad', strength: 'clear', target: 'situation', ...extra });
const parse = (primary, secondary = []) => paper.parseAssistantAffect(JSON.stringify({ affect: basket(primary, secondary) }));
const apply = (state, value, key = 'synthetic-new', now = NOW) => generation.applyJunluoAffectBasket({
  state, basket: value, generationKey: key, now, sleeping: false });
const results = [];
async function check(name, work) { await work(); results.push(name); }
const declaration = find('chat/chatReplyRuntime.ts', node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => ts.isArrayBindingPattern(item.name)
    && item.name.elements.some(element => ts.isBindingElement(element) && element.name.getText() === 'previousAffect')));
async function readMaterial(options = {}) {
  const calls = [];
  const run = evaluate('const value = async () => {' + declaration + '\nreturn previousAffect;};', {
    wishMode: false, readOnly: false, isInteractionReply: false, useStoredRequestHistory: options.ordinary !== false,
    sessionId: 'synthetic-session', latestYouMessage: {}, EMPTY_BAIYUN_PROMPT_CONTEXT: {},
    retryTransientDatabaseLock: work => work(), loadChatContinuityPlanningContext: async () => ({}),
    loadJunluoDesirePromptPaper: async () => '', loadBaiyunIntimacySafetySettings: async () => ({}),
    loadBaiyunPendingSharePromptContext: async () => ({}), recordChatAuxiliaryDiagnostic: forbidden,
    loadJunluoAffectState: async readOnly => { calls.push(readOnly); if (options.fail) throw Error('SYNTHETIC_READ_FAILURE'); return options.state; },
  });
  return { value: await run(), calls };
}
const instructionsText = find('chat/chatReplyRuntime.ts', node => ts.isVariableDeclaration(node)
  && node.name.getText() === 'visibleOnlyResponseInstructions');
function instructions(state) {
  return evaluate('const ' + instructionsText + ';', {
    trustedLifeStateInstruction: 'ORIGINAL_LIFE', previousAffect: state, replyTiming: { startedAt: NOW },
    formatPreviousAffectForChat: paper.formatPreviousAffectForChat,
    unifiedContactHandoff: { material: 'ORIGINAL_HANDOFF' }, webShareHandoff: { instruction: 'ORIGINAL_WEB' },
    desirePaper: 'ORIGINAL_DESIRE', bodySignalCareDoorbell: { instruction: 'ORIGINAL_BODY' },
    keywordCounterInsight: 'ORIGINAL_KEYWORD', dreamInstruction: 'ORIGINAL_DREAM', recentMusicHistoryContext: 'ORIGINAL_MUSIC',
    wishTurn: { material: 'ORIGINAL_WISH' },
  }, 'visibleOnlyResponseInstructions');
}
function flatten(node) {
  if (node == null || node === false) return '';
  if (Array.isArray(node)) return node.map(flatten).join('');
  if (typeof node === 'object') return flatten(node.props?.children);
  return String(node);
}
async function main() {
  await check('approved prompt changes and exact existing after-chat text only', () => {
    assert.equal(paper.ASSISTANT_AFFECT_PROMPT.split('reason 写 I 能说清的缘由，一句话。暂时说不清时，reason 写 null。').length, 2);
    assert(paper.ASSISTANT_AFFECT_PROMPT.includes('每项情绪都有 id、strength、target 和 reason：'));
    const shape = JSON.parse(paper.ASSISTANT_AFFECT_PROMPT.split('\n').find(line => line.startsWith('{"affect":')));
    assert.equal(shape.affect.emotions.primary.reason, null);
    assert(paper.ASSISTANT_AFFECT_PROMPT.indexOf('target 可以是') < paper.ASSISTANT_AFFECT_PROMPT.indexOf('reason 写 I'));
    assert(paper.ASSISTANT_AFFECT_PROMPT.indexOf('reason 写 I') < paper.ASSISTANT_AFFECT_PROMPT.indexOf('lifeState 可以是'));
    assert.equal(contact.CONTACT_AFFECT_AFTER_CHAT, '这是 I 那时记下的感受。和 you 聊过后，这会儿心里还是这样，还是已经有些不一样了呢？');
  });
  await check('actual parser accepts legacy, full string and null reasons on both emotions', () => {
    for (const extra of [{}, { reason: 'Synthetic reason\nFull original text' }, { reason: null }, { reason: '' }]) {
      const parsed = parse(inputEmotion(extra), [inputEmotion({ id: 'hurt', target: 'you', ...extra })]);
      assert(parsed.valid); assert.equal(parsed.issues.length, 0);
      for (const item of [parsed.affect.emotions.primary, parsed.affect.emotions.secondary[0]]) {
        assert.equal(item.reason, extra.reason); assert.equal(Object.hasOwn(item, 'reason'), Object.hasOwn(extra, 'reason'));
      }
    }
  });
  await check('invalid optional reason is omitted without losing otherwise valid emotion', () => {
    for (const reason of [42, false, {}, [], ['synthetic']]) {
      const parsed = parse(inputEmotion({ reason }), [inputEmotion({ id: 'hurt', reason })]);
      assert(parsed.valid); assert.equal(parsed.affect.emotions.primary.id, 'sad');
      assert.equal(parsed.affect.emotions.secondary[0].id, 'hurt');
      assert(!Object.hasOwn(parsed.affect.emotions.primary, 'reason'));
      assert(!Object.hasOwn(parsed.affect.emotions.secondary[0], 'reason'));
    }
    for (const extra of [{ id: 'synthetic-invalid' }, { strength: 'synthetic-invalid' }, { target: 'synthetic-invalid' }, { unexpected: 'synthetic' }]) {
      assert.equal(parse(inputEmotion(extra)).affect.emotions, null);
    }
  });
  await check('current state V2 validates old missing and new reason, strict stored bad types remain invalid', () => {
    for (const extra of [{}, { reason: 'Synthetic reason' }, { reason: null }, { reason: '' }]) {
      const value = affect(emotion(extra)); assert(inner.isJunluoAffectStateV1(value));
      assert.equal(persistence.upgradeJunluoAffectState(value), value); assert.equal(value.schemaVersion, 2);
    }
    for (const reason of [5, false, {}, [], undefined]) assert.equal(inner.isJunluoAffectStateV1(affect(emotion({ reason }))), false);
    assert.equal(inner.isJunluoAffectStateV1(affect(emotion({ unexpected: 'synthetic' }))), false);
  });
  await check('actual apply saves each new reason with original timestamp, IDs and strength conversion', () => {
    const value = apply(affect(), parse(inputEmotion({ reason: 'Primary original' }),
      [inputEmotion({ id: 'hurt', target: 'you', strength: 'soft', reason: null })]).affect);
    assert(inner.isJunluoAffectStateV1(value)); assert.equal(value.emotions.primary.reason, 'Primary original');
    assert.equal(value.emotions.primary.occurredAt, NOW); assert.equal(value.emotions.primary.sourceId, 'synthetic-new');
    assert.equal(value.emotions.primary.intensity, 0.65); assert.equal(value.emotions.secondary[0].intensity, 0.35);
    assert.equal(value.emotions.secondary[0].reason, null); assert.equal(value.emotions.secondary[0].target, 'you');
    assert.equal(apply(value, parse(inputEmotion({ reason: 'Must not replay' })).affect), value);
  });
  await check('emotions null retains old whole items and their individual timestamps and reasons', () => {
    const state = affect(emotion({ reason: 'Old primary' }), [emotion({ emotionId: 'hurt', occurredAt: AUX, reason: 'Old auxiliary' })]);
    const value = apply(state, { ...basket(null), emotions: null, lifeState: 'tired', relationshipFeeling: 'mixed' });
    assert.equal(value.emotions, state.emotions); assert.equal(value.emotionsLastOperation, state.emotionsLastOperation);
    assert.equal(value.emotions.primary.occurredAt, OLD); assert.equal(value.emotions.secondary[0].occurredAt, AUX);
    assert.equal(value.emotions.primary.reason, 'Old primary'); assert.equal(value.updatedAt, NOW);
  });
  await check('new emotion never inherits an old reason; formulas and existing fields are unchanged', () => {
    const state = affect(emotion({ reason: 'Old reason' }));
    const legacy = apply(state, parse(inputEmotion()).affect), current = apply(state, parse(inputEmotion({ reason: 'New reason' })).affect);
    assert(!Object.hasOwn(legacy.emotions.primary, 'reason'));
    const copy = json(current); delete copy.emotions.primary.reason;
    assert.deepEqual(copy, json(legacy));
  });
  await check('existing merge takes the whole winning emotion and its reason without mutating either side', () => {
    const older = affect(emotion({ reason: 'Old reason' }));
    const newer = apply(older, parse(inputEmotion({ reason: 'New reason' })).affect);
    const before = JSON.stringify([older, newer]);
    const merged = persistence.mergeJunluoAffectStates(older, newer);
    assert.equal(merged.emotions.primary.reason, 'New reason'); assert.equal(merged.emotions, newer.emotions);
    assert.equal(JSON.stringify([older, newer]), before);
  });
  await check('chat formatter uses each original time, complete reason, and I/you target labels', () => {
    const full = 'Synthetic original reason\n' + 'Complete synthetic reason. '.repeat(100);
    const value = affect(emotion({ reason: full, target: 'I' }), [emotion({ emotionId: 'hurt', occurredAt: AUX, target: 'you', reason: 'Auxiliary reason' })]);
    const text = paper.formatPreviousAffectForChat(value, NOW);
    assert(text.startsWith('【I 上次记下的感受】')); assert(text.includes(full));
    assert(text.includes(time(OLD)) && text.includes(time(AUX))); assert(!text.includes(time(value.updatedAt)));
    assert(text.includes('清楚的 · I') && text.includes('清楚的 · you'));
    assert.equal(text.split(contact.CONTACT_AFFECT_AFTER_CHAT).length, 2);
  });
  await check('chat formatter omits unknown reason and unconfirmed/future times without manufacturing a mood', () => {
    assert.equal(paper.formatPreviousAffectForChat(null, NOW), '');
    assert.equal(paper.formatPreviousAffectForChat(affect(null), NOW), '');
    for (const occurredAt of [0, -1, NOW + 1, NaN, Infinity]) assert.equal(paper.formatPreviousAffectForChat(affect(emotion({ occurredAt })), NOW), '');
    for (const extra of [{}, { reason: null }, { reason: '' }, { reason: '   ' }]) {
      const text = paper.formatPreviousAffectForChat(affect(emotion(extra)), NOW);
      assert(text.includes('主情绪：难过')); assert(!text.includes('缘由：'));
    }
    const text = paper.formatPreviousAffectForChat(affect(emotion({ occurredAt: 0 }), [emotion({ occurredAt: AUX })]), NOW);
    assert(!text.includes('主情绪：')); assert(text.includes('辅助情绪：'));
  });
  await check('other callers retain exact previous-affect formatting and do not receive reasons or the new instruction', () => {
    const value = affect(emotion({ reason: 'SYNTHETIC_REASON_NOT_FOR_OLD_CALLERS' }));
    const old = affect(emotion());
    assert.equal(paper.formatPreviousAffect(value), paper.formatPreviousAffect(old));
    assert(!paper.formatPreviousAffect(value).includes(value.emotions.primary.reason));
    assert(!paper.formatPreviousAffect(value).includes(contact.CONTACT_AFFECT_AFTER_CHAT));
  });
  await check('actual ordinary preparation adds one public read-only read and omits read failures/special entries', async () => {
    const value = affect(emotion({ reason: 'Synthetic reason' }));
    const good = await readMaterial({ state: value }); assert.equal(good.value, value); assert.deepEqual(good.calls, [true]);
    const bad = await readMaterial({ state: value, fail: true }); assert.equal(bad.value, null); assert.deepEqual(bad.calls, [true]);
    const other = await readMaterial({ state: value, ordinary: false }); assert.equal(other.value, null); assert.equal(other.calls.length, 0);
  });
  await check('actual instruction array puts affect immediately after life and keeps every other material in order', () => {
    const value = affect(emotion({ reason: 'Synthetic reason' }));
    const without = json(instructions(null)), withAffect = json(instructions(value));
    assert.equal(withAffect[0], 'ORIGINAL_LIFE'); assert.equal(withAffect[1], paper.formatPreviousAffectForChat(value, NOW));
    assert.deepEqual([withAffect[0], ...withAffect.slice(2)], without);
  });
  await check('actual API assembly keeps real history and adds the new packet as system reference after latest you', () => {
    const fn = find('ai/subjectiveMessages.ts', node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildApiMessages');
    const build = evaluate(fn, { SUBJECTIVE_IDENTITY_PROTOCOL: 'ORIGINAL_IDENTITY',
      getTheaterBackstageContext: () => '', buildApiMessageContent: message => message.content,
      buildConversationPaceContext: () => '', expensePlanHistoryMaterial: forbidden, reminderPlanHistoryMaterial: forbidden }, 'buildApiMessages');
    const messages = [{ role: 'you', content: 'Synthetic earlier you' }, { role: 'I', content: 'Synthetic earlier I' },
      { role: 'you', content: 'Synthetic current you' }];
    const value = affect(emotion({ reason: 'Synthetic self-reported reason' }));
    const output = build('ORIGINAL_PERSONA', messages, 'ORIGINAL_REALITY', 'ORIGINAL_SUMMARY', instructions(value).join('\n\n'));
    assert.deepEqual(json(output.filter(item => ['user', 'assistant'].includes(item.role)).map(item => item.content)), messages.map(item => item.content));
    assert.equal(output.at(-1).role, 'system'); assert.equal(output.at(-2).content, 'Synthetic current you');
    assert(output.at(-1).content.includes(paper.formatPreviousAffectForChat(value, NOW)));
    assert.equal(output.filter(item => item.content.includes('当时记下的缘由：')).length, 1);
  });
  await check('actual emotion UI shows original time and reason, with technical unknown label for old records', () => {
    const fn = find('screens/JunluoInnerStateDiaryCard.tsx', node => ts.isFunctionDeclaration(node) && node.name?.text === 'EmotionRecord');
    const render = evaluate(fn, { Text: 'Text', styles: { restSources: {} }, emotionStrengthAndTarget: presentation.emotionStrengthAndTarget,
      Date: class extends Date { static now() { return NOW; } } },
      'EmotionRecord', 'synthetic.tsx');
    const full = 'Synthetic untruncated UI reason\n' + 'full '.repeat(100);
    const known = flatten(render({ entry: emotion({ reason: full }) }));
    assert(known.includes('记录时间：' + new Date(OLD).toLocaleString('zh-CN'))); assert(known.includes('当时记下的缘由：' + full));
    for (const extra of [{}, { reason: null }, { reason: '' }]) assert(flatten(render({ entry: emotion(extra) })).includes('尚未记下具体缘由'));
    const ui = source('screens/JunluoInnerStateDiaryCard.tsx');
    assert(ui.includes('<EmotionRecord entry={affect.emotions.primary} />')); assert(ui.includes('<EmotionRecord entry={secondaryEmotion} />'));
  });
  await check('only the new source syntax is transpiled, with no emitted files', () => {
    for (const file of files) {
      const compiled = ts.transpileModule(source(file), { fileName: file, compilerOptions, reportDiagnostics: true });
      assert.equal(compiled.diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
    }
  });
  console.log(JSON.stringify({ passed: results.length, results, models: 0, network: 0, realStorage: 0, sync: 0, devices: 0,
    limitation: 'Pure production functions and AST preparation/API/UI seams; full App types and sync mirror compatibility are owned by root.' }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
