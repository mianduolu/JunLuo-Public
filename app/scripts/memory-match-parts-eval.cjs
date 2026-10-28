const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'app/node_modules/typescript'));
const candidate = process.argv.includes('--candidate');
const changed = new Set(['memory/memoryDatabaseWrites.ts', 'memory/memoryEmbedding.ts',
  'memory/memoryDebugExplanation.ts', 'chat/chatReplyDiagnosticPresentation.ts']);
function filename(relative) {
  return path.join(candidate && changed.has(relative) ? path.join(__dirname, 'app/src') : path.join(root, 'app/src'), relative);
}
function compile(text, name, requirePort, extra = {}) {
  const m = { exports: {} };
  const output = ts.transpileModule(text, { fileName: name, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }, reportDiagnostics: true });
  assert.equal(output.diagnostics.length, 0);
  vm.runInNewContext('(function(require,module,exports){' + output.outputText + '\n})', {
    Date, Math, Promise, Map, Set, WeakMap, Proxy, Reflect, Object, Array, Number, String, JSON,
    Error, TypeError, SyntaxError, AbortController, setTimeout, clearTimeout, ...extra,
  }, { filename: name })(requirePort, m, m.exports);
  return m.exports;
}
const nativeReads = [], phaseNames = ['memory', 'current_state', 'shiying', 'post'];
const expectedPhases = phaseNames.map(kind => 'vector_match_' + kind);
let mode = 'normal', failingKind;
const sqlKind = sql => sql.includes("'current_state'") ? 'current_state' : sql.includes("'shiying_record'") ? 'shiying'
  : sql.includes("'post_source'") ? 'post' : 'memory';
const database = { async getAllAsync(sql) {
  const kind = sqlKind(sql); nativeReads.push(kind);
  if (kind === failingKind && mode !== 'normal') throw Object.assign(new Error('fictional-' + mode),
    { name: mode === 'cancel' ? 'AbortError' : 'Error' });
  return [];
} };
function extractScore(text) {
  const ast = ts.createSourceFile('memoryEmbedding.ts', text, ts.ScriptTarget.Latest, true);
  return ast.statements.filter(statement => ts.isFunctionDeclaration(statement)
    ? ['scoreMemoryTargets', 'cosineSimilarityValidated'].includes(statement.name?.text)
    : ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === 'emptyTargetScores'))
    .map(statement => statement.getText(ast)).join('\n');
}
const scoreText = fs.readFileSync(filename('memory/memoryEmbedding.ts'), 'utf8');
const ports = { '../shiying/shiyingMemorySource': { loadShiyingMemoryIndexSources: async () => new Map() },
  '../posts/baiyunPostRecallSource': { loadPostSourceIndexSources: async () => new Map() } };
const scorer = compile(extractScore(scoreText), 'actual-scoreMemoryTargets.ts', id => {
  assert.ok(id in ports, 'Unexpected scorer dependency: ' + id); return ports[id];
});
const ram = new Map(), modules = new Map();
const storage = { getItem: async key => ram.get(key) ?? null, setItem: async (key, value) => ram.set(key, value),
  removeItem: async key => ram.delete(key) };
const allowed = new Set([...changed, 'memory/memoryChatPreparation.ts', 'ai/behavior/actionChatSemanticStore.ts',
  'chat/chatReplyFailure.ts', 'chat/chatAuxiliaryDiagnostics.ts']);
function load(relative) {
  if (modules.has(relative)) return modules.get(relative);
  assert.ok(allowed.has(relative), 'Unexpected module: ' + relative);
  const result = compile(fs.readFileSync(filename(relative), 'utf8'), relative, id => {
    if (id === '@react-native-async-storage/async-storage') return storage;
    if (id.endsWith('chatCompletionTransport')) return { normalizeChatProviderHost: x => x, normalizeChatProviderRequestId: x => x,
      normalizeChatTransportErrorCode: x => x, normalizeChatTransportErrorName: x => x };
    if (id === './memorySpeechPolicy') return { getMemorySpeechPolicy: () => ({}) };
    assert.ok(id.startsWith('.')); return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), id)) + '.ts');
  });
  modules.set(relative, result); return result;
}
const preparation = load('memory/memoryChatPreparation.ts');
const store = load('ai/behavior/actionChatSemanticStore.ts');
const debug = load('memory/memoryDebugExplanation.ts');
const presentation = load('chat/chatReplyDiagnosticPresentation.ts');
function options(only, events = []) {
  return { eligibleMemoryIds: new Set(!only || only === 'memory' ? ['memory1'] : []),
    eligibleCurrentStateIds: new Set(!only || only === 'current_state' ? ['state1'] : []),
    eligibleShiyingRecordIds: new Set(!only || only === 'shiying' ? ['paper1'] : []),
    eligiblePostSourceIds: new Set(!only || only === 'post' ? ['post1'] : []),
    reporter: { start(phase) { events.push(phase + ':start'); return () => events.push(phase + ':end'); } } };
}
const settings = { model: 'fictional' }, groups = [[[1, 0]]];
const runScore = opts => scorer.scoreMemoryTargets(database, groups, settings, opts, 40, false);
let passed = 0, failed = 0; const results = [];
async function check(name, run) {
  mode = 'normal'; failingKind = undefined; nativeReads.length = 0;
  try { await run(); passed++; results.push({ name, passed: true }); }
  catch (error) { failed++; results.push({ name, passed: false, error: error.message }); }
}
const same = value => JSON.parse(JSON.stringify(value));
(async () => {
  await check('four existing branches report start/end in original sequence', async () => {
    const events = []; await runScore(options(undefined, events));
    assert.deepEqual(events, expectedPhases.flatMap(phase => [phase + ':start', phase + ':end']));
    assert.deepEqual(nativeReads, phaseNames);
  });
  await check('explicitly skipped targets emit no fictitious phase or query', async () => {
    const events = []; await runScore(options('none', events)); assert.deepEqual(events, []); assert.deepEqual(nativeReads, []);
  });
  for (const kind of phaseNames) await check(kind + ' failure ends its phase without starting later branches', async () => {
    const events = []; mode = 'failure'; failingKind = kind;
    await assert.rejects(runScore(options(kind, events)), /fictional-failure/);
    assert.deepEqual(events, ['vector_match_' + kind + ':start', 'vector_match_' + kind + ':end']);
    assert.deepEqual(nativeReads, [kind]);
  });
  for (const kind of phaseNames) await check(kind + ' cancellation ends its phase and preserves AbortError', async () => {
    const events = []; mode = 'cancel'; failingKind = kind;
    await assert.rejects(runScore(options(kind, events)), error => error.name === 'AbortError');
    assert.deepEqual(events, ['vector_match_' + kind + ':start', 'vector_match_' + kind + ':end']);
  });
  await check('missing reporter preserves results and reads with no added async work', async () => {
    const plain = options(); delete plain.reporter; const result = await runScore(plain);
    assert.equal(result.comparableCount, 0); assert.equal(result.results.length, 1);
    assert.equal(result.results[0].memories.size, 0); assert.deepEqual(nativeReads, phaseNames);
  });
  await check('actual preparation collector admits four finished parts', async () => {
    const bundle = { debug: { counts: {}, dropped: [] } };
    const result = await preparation.prepareChatMemoryRecall({ route: async () => ({ status: 'ready', route: { mode: 'recall' }, startedAt: Date.now(), finishedAt: Date.now() }),
      local: async () => bundle, semantic: async (_route, _signal, reporter) => { await runScore({ ...options(), reporter }); return bundle; } });
    for (const phase of expectedPhases) {
      assert.equal(result.diagnostic.semantic.work?.[phase]?.count, 1, phase);
      assert.equal(result.diagnostic.semantic.work?.[phase]?.active, 0, phase);
    }
  });
  await check('public diagnostic persistence and both technical presentations retain new parts', async () => {
    const work = Object.fromEntries(expectedPhases.map((phase, index) => [phase, { elapsedMs: index + 10, count: 1, active: index === 3 ? 1 : 0 }]));
    const diagnostic = { status: 'timeout', reason: 'timeout', startedAt: 100, finishedAt: 200,
      route: { status: 'ready' }, local: { status: 'ready' }, semantic: { status: 'timeout', reason: 'timeout', startedAt: 110, finishedAt: 200, work } };
    await store.recordBaiyunChatSemanticDiagnostic({ attemptedAt: 200, status: 'valid', connectionId: 'fake', connectionName: 'fake', model: 'fake', memoryPreparation: diagnostic });
    const entry = (await store.loadBaiyunChatSemanticDiagnostics({ strict: true })).entries.at(-1);
    assert.ok(entry.memoryPreparation.semantic.work, 'New match-part measurements must survive strict reload');
    assert.deepEqual(same(entry.memoryPreparation.semantic.work), same(work));
    const memoryText = JSON.stringify(debug.buildMemoryDebugExplanation({ preparation: diagnostic, counts: {}, dropped: [] }, []));
    const chatText = JSON.stringify(presentation.buildChatReplyDiagnosticPresentation(entry));
    for (const label of ['正式记忆匹配', '近况匹配', '拾荧匹配', '动态匹配']) {
      assert.ok(memoryText.includes(label), label); assert.ok(chatText.includes(label), label);
    }
    assert.ok(chatText.includes('结束时仍有 1 项未完成'));
  });
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  console.log(JSON.stringify({ candidate, passed, failed, total: results.length, results,
    sources: [...changed].map(file => ({ path: 'app/src/' + file, sha256: hash(fs.readFileSync(filename(file))) })),
    actualNetworkRequests: 0, actualDeviceOrBusinessDatabaseCalls: 0, storage: 'RAM Map; controlled scorer read ports' }));
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

