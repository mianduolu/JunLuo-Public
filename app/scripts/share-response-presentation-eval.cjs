const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');
const src = path.resolve(__dirname, '../src');
const cache = new Map();
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const module = { exports: {} }; cache.set(relative, module.exports);
  const code = ts.transpileModule(fs.readFileSync(path.join(src, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert(name.startsWith('.'), `Unexpected external dependency: ${name}`);
    return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${name}.ts`)));
  }, module, module.exports);
  return module.exports;
}
const { projectBaiyunShareResponsePresentation: project } = load('ai/behavior/actionShareResponsePresentation.ts');
const share = (id, overrides = {}) => ({ id, sessionId: 'chat-one', origin: 'letter', invitationKind: 'self_driven',
  sourceMessageIds: [`letter-${id}-original`], responseDriveKeys: ['reflection'], excerpt: `synthetic ${id}`,
  state: 'waiting', createdAt: 1_000, ...overrides });
let passed = 0;
async function check(name, run) { await run(); console.log(`PASS ${++passed} ${name}`); }
const ids = records => records.map(record => record.id);

(async () => {
  await check('deleting a saved letter removes its active projection while preserving the original ledger', () => {
    const record = share('one'), records = [record], before = structuredClone(records);
    assert.deepEqual(ids(project(records, [{ id: 'one' }]).active), ['one']);
    assert.deepEqual(project(records, []), { active: [], recentEnded: [] });
    assert.deepEqual(records, before); assert.equal(records[0], record);
  });
  await check('deleted letters are hidden from all recent terminal states too', () => {
    const records = ['engaged', 'declined', 'unanswered'].map((state, index) => share(String(index), { state, resolvedAt: 2_000 + index }));
    assert.equal(project(records, []).recentEnded.length, 0);
    assert.deepEqual(ids(project(records, [{ id: '1' }]).recentEnded), ['1']);
  });
  await check('existing letter sources do not require copied chat messages', () => {
    const original = share('one'), reply = share('reply', { sourceMessageIds: ['letter-one-reply'] });
    assert.deepEqual(ids(project([original, reply], [{ id: 'one' }]).active), ['one', 'reply']);
  });
  await check('existing legacy source IDs are recognized without modifying letters', () => {
    const record = share('legacy', { sourceMessageIds: ['old-saved-message'] });
    const letter = Object.freeze({ id: 'one', chatMessageIds: Object.freeze(['old-saved-message']) });
    assert.deepEqual(ids(project([record], [letter]).active), ['legacy']);
    assert.equal(project([record], []).active.length, 0);
  });
  await check('confirmed legacy chat-action letter projections follow source existence', () => {
    const record = share('one', { origin: 'chat_action' });
    assert.equal(project([record], []).active.length, 0);
    assert.deepEqual(ids(project([record], [{ id: 'one' }]).active), ['one']);
  });
  await check('mixed chat sources and ordinary non-letter shares remain unchanged', () => {
    const records = [share('mixed', { origin: 'chat_action', sourceMessageIds: ['letter-gone-original', 'real-chat-source'] }),
      ...['chat_action', 'web_voyage', 'social_share', 'life_project_share'].map(origin => share(origin, { origin, sourceMessageIds: ['real-source'] }))];
    assert.deepEqual(project(records, []).active, records);
  });
  await check('one remaining original supports a share with several letter sources', () => {
    const record = share('group', { sourceMessageIds: ['letter-gone-original', 'letter-two-original'] });
    assert.deepEqual(ids(project([record], [{ id: 'two' }]).active), ['group']);
  });
  await check('source filtering happens before the four recent results are selected', () => {
    const gone = Array.from({ length: 4 }, (_, index) => share(`gone-${index}`, { state: 'engaged', resolvedAt: 10_000 + index }));
    const kept = Array.from({ length: 5 }, (_, index) => share(`kept-${index}`, { origin: 'web_voyage', state: 'engaged', resolvedAt: 1_000 + index }));
    assert.deepEqual(ids(project([...gone, ...kept], []).recentEnded), ['kept-4', 'kept-3', 'kept-2', 'kept-1']);
  });
  await check('session selection and active ordering retain the original presentation rules', () => {
    const records = [share('late', { origin: 'chat_action', sourceMessageIds: ['chat-late'], createdAt: 3 }),
      share('early', { origin: 'chat_action', sourceMessageIds: ['chat-early'], createdAt: 1 }),
      share('other', { origin: 'web_voyage', sessionId: 'chat-two', state: 'engaged', resolvedAt: 5 })];
    assert.deepEqual(ids(project(records, [], 'chat-one').active), ['early', 'late']);
    assert.equal(project(records, [], 'chat-one').recentEnded.length, 0);
  });
  await check('the actual diary loader refreshes the projection from current letters without writes or generation', async () => {
    const file = path.join(src, 'screens/AssistantDiaryScreen.tsx'), text = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let arrow;
    const visit = node => {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'loadLocalDiary') arrow = node.initializer.arguments[0];
      ts.forEachChild(node, visit);
    };
    visit(ast); assert(arrow);
    const compiled = ts.transpileModule(`const actual = ${arrow.getText(ast)};`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let letters = [{ id: 'one' }], shown, reads = 0;
    const noop = () => undefined, empty = async () => null;
    const scope = { diaryDateKey: 'synthetic-day', loadAssistantLifeDay: empty, loadJunluoThoughtState: empty,
      loadWebVoyageLog: empty, buildLifeMaterialSnapshot: empty, loadAssistantLifeGenerationDiagnostics: empty,
      loadAssistantStatePersistenceDiagnostic: empty, loadBaiyunPendingShareExchanges: async () => [share('one')],
      loadLetters: async () => { reads++; return letters; }, projectBaiyunShareResponsePresentation: project,
      setDay: noop, setThoughtState: noop, setWebVoyageLog: noop, setLifeMaterialSnapshot: noop,
      setGenerationDiagnostics: noop, setPersistenceDiagnostic: noop, setShareExchanges: value => { shown = value; },
      setInnerStateRefreshVersion: noop, refreshContinuityEvents: async () => undefined };
    const run = new Function(...Object.keys(scope), `${compiled}; return actual;`)(...Object.values(scope));
    await run(); assert.deepEqual(ids(shown.active), ['one']);
    letters = []; await run(); assert.equal(shown.active.length, 0); assert.equal(reads, 2);
  });
  console.log(JSON.stringify({ passed, realDevice: false, modelRequests: 0, realStorageWrites: 0, networkRequests: 0 }));
})().catch(error => { console.error(error); process.exitCode = 1; });
