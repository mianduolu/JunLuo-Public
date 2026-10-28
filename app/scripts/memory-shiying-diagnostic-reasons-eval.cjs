// New RAM-only cases for the two existing Shiying diagnostic reason codes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const projectRoot = path.resolve(__dirname, '../..');
const ts = require(path.join(projectRoot, 'app/node_modules/typescript'));
const sourceFlag = process.argv.indexOf('--source-root');
const sourceRoot = sourceFlag < 0 ? projectRoot : path.resolve(process.argv[sourceFlag + 1]);
const read = file => fs.readFileSync(path.join(sourceRoot, file), 'utf8');
const storage = new Map();
const rawStorage = {
  async getItem(key) { return storage.get(key) ?? null; },
  async setItem(key, value) { storage.set(key, value); },
};
const phaseSource = fs.readFileSync(path.join(projectRoot, 'app/src/memory/memoryDatabaseWrites.ts'), 'utf8');
const phaseMatch = phaseSource.match(/export const MEMORY_RECALL_WORK_PHASES = (\[[^;]+\]) as const;/);
assert(phaseMatch, 'actual phase declaration must be found');
const phases = vm.runInNewContext(phaseMatch[1]);
const compile = (source, file) => ts.transpileModule(source, {
  fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;
const storeFile = 'app/src/ai/behavior/actionChatSemanticStore.ts';
const diagnostic = { exports: {} };
const unrelatedUndefined = () => undefined;
const external = {
  '@react-native-async-storage/async-storage': { default: rawStorage },
  '../chatCompletionTransport': {
    normalizeChatProviderHost: unrelatedUndefined, normalizeChatProviderRequestId: unrelatedUndefined,
    normalizeChatTransportErrorCode: unrelatedUndefined, normalizeChatTransportErrorName: unrelatedUndefined,
  },
  '../../memory/memoryChatPreparation': { MEMORY_RECALL_WORK_PHASES: phases },
  '../../chat/chatAuxiliaryDiagnostics': { normalizeChatAuxiliaryFailureDetails: unrelatedUndefined },
  '../../chat/chatReplyFailure': {
    CHAT_REPLY_FAILURE_CODE: {}, isChatReplyFailureCode: () => false,
    isChatReplyFailureStage: () => false, isChatReplyTechnicalReasonCode: () => false,
  },
};
vm.runInNewContext(compile(read(storeFile), storeFile), {
  module: diagnostic, exports: diagnostic.exports,
  require(id) { assert(Object.hasOwn(external, id), `unexpected dependency ${id}`); return external[id]; },
  console, Date, Math, Promise, Map, Set,
}, { filename: storeFile });
const api = diagnostic.exports;
// Execute the actual display functions, without loading unrelated UI/AI imports.
function loadFunctions(file, names, dependencies = {}) {
  const source = read(file);
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = names.map(name => {
    const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert(found, `${file}: missing actual function ${name}`);
    return found.getText(ast).replace(/^export\s+/, '');
  });
  const body = compile(`${declarations.join('\n')}\nmodule.exports = { ${names.join(', ')} };`, file);
  const holder = { exports: {} };
  vm.runInNewContext(body, { module: holder, ...dependencies, Date, Math, Map, Set }, { filename: file });
  return holder.exports;
}
const memoryDisplay = loadFunctions('app/src/memory/memoryDebugExplanation.ts', ['preparationNotes']);
const chatDisplay = loadFunctions('app/src/chat/chatReplyDiagnosticPresentation.ts',
  ['validCount', 'time', 'duration', 'preparationDetails'], {
    normalizeChatMemoryPreparation: api.normalizeChatMemoryPreparation,
    normalizeChatPreparationCheckpoints: api.normalizeChatPreparationCheckpoints,
  });
const fixture = code => ({
  status: 'failed', reason: code, startedAt: 100, finishedAt: 120,
  route: { status: 'ready', startedAt: 100, finishedAt: 103 },
  local: { status: 'failed', reason: code, startedAt: 100, finishedAt: 111 },
  semantic: { status: 'failed', reason: code, startedAt: 111, finishedAt: 120 },
});
const input = (code, ordinal) => ({
  turnAttemptId: `synthetic-shiying-${ordinal}`, attemptedAt: 1000 + ordinal,
  status: 'valid', connectionId: 'synthetic', connectionName: 'synthetic', model: 'synthetic',
  memoryPreparation: fixture(code), modelAttempts: [], replyPersisted: true,
});
let passed = 0, failed = 0;
async function test(name, operation) {
  try { await operation(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`); }
}
(async () => {
  let ordinal = 0;
  for (const [code, label] of [
    ['shiying_source_unavailable', '拾荧来源不可用'],
    ['shiying_read_failed', '拾荧资料读取失败'],
  ]) {
    await test(`${code}: normalize keeps top and both stage reasons`, () => {
      const value = api.normalizeChatMemoryPreparation(fixture(code));
      assert.equal(value.reason, code); assert.equal(value.local.reason, code); assert.equal(value.semantic.reason, code);
    });
    await test(`${code}: public record -> RAM storage -> strict public load`, async () => {
      const record = await api.recordBaiyunChatSemanticDiagnostic(input(code, ++ordinal));
      const raw = JSON.parse([...storage.values()].at(-1)).entries.at(-1);
      const loaded = await api.loadBaiyunChatSemanticDiagnostics({ strict: true });
      assert.equal(record.memoryPreparation.reason, code);
      assert.equal(raw.memoryPreparation.local.reason, code);
      assert.equal(loaded.entries.at(-1).memoryPreparation.semantic.reason, code);
    });
    await test(`${code}: memory panel uses the specific technical label`, () => {
      const lines = memoryDisplay.preparationNotes({ preparation: fixture(code) });
      assert(lines.some(line => line.includes(`深入查找：失败（${label}）`)));
    });
    await test(`${code}: chat diagnostic uses the persisted specific label`, () => {
      const lines = chatDisplay.preparationDetails({ memoryPreparation: fixture(code) });
      assert(lines.some(line => line.includes(`深入查找（含向量）：失败（${label} · ${code}）`)));
    });
  }
  await test('unknown reason is still removed and cannot enter either label map', () => {
    const code = 'synthetic_private_detail';
    const normalized = api.normalizeChatMemoryPreparation(fixture(code));
    assert.equal(normalized.reason, undefined); assert.equal(normalized.local.reason, undefined);
    const memoryLines = memoryDisplay.preparationNotes({ preparation: normalized });
    const chatLines = chatDisplay.preparationDetails({ memoryPreparation: normalized });
    assert(![...memoryLines, ...chatLines].some(line => line.includes(code)));
  });
  await test('existing timeout, phase measurements and missing reason retain their original handling', () => {
    const value = fixture('timeout');
    value.status = value.semantic.status = 'timeout';
    value.local = { status: 'ready' };
    value.semantic.work = { embedding_http: { elapsedMs: 8000, count: 1, active: 1 } };
    const normalized = api.normalizeChatMemoryPreparation(value);
    assert.equal(normalized.reason, 'timeout'); assert.equal(normalized.local.reason, undefined);
    assert.equal(normalized.semantic.work.embedding_http.active, 1);
    assert(memoryDisplay.preparationNotes({ preparation: normalized }).some(line => line.includes('等待超时')));
    assert(chatDisplay.preparationDetails({ memoryPreparation: normalized }).some(line => line.includes('等待超时')));
    assert.equal(api.normalizeChatMemoryPreparation({ ...value, status: 'made_up' }), undefined);
  });
  console.log(JSON.stringify({ sourceRoot, passed, failed, scope: 'RAM diagnostic reasons only; no App, network, model or business store' }));
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
