const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');
const appRoot = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(appRoot, relative), 'utf8');
const source = read('src/ai/assistantStateGenerator.ts').replaceAll('\r\n', '\n');
const baseline = source.replace('  parseIssues?: string[];\n', '').replace(
  "      : { status: 'failure', reason: output ? 'invalid-json' : 'empty-content', parseIssues: value.issues,\n        diagnostics: completedDiagnostics, lookAtPost };",
  "      : { status: 'failure', reason: output ? 'invalid-json' : 'empty-content', diagnostics: completedDiagnostics, lookAtPost };");
assert.notEqual(source, baseline);
function compile(text, imports) {
  const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const moduleObject = { exports: {} };
  new Function('require', 'module', 'exports', output.outputText)(name => {
    assert.ok(Object.hasOwn(imports, name), `unexpected runtime dependency ${name}`);
    return imports[name];
  }, moduleObject, moduleObject.exports);
  return moduleObject.exports;
}
const parser = compile(read('src/life/junluoWantsGeneration.ts'), {
  './junluoInnerState': { JUNLUO_DESIRE_IDS: ['rest', 'miss_you', 'remind_you'] },
});
const normalizeDiagnostic = compile(read('src/ai/assistantLifeGenerationDiagnostics.ts'), {
  '@react-native-async-storage/async-storage': { default: {} },
}).normalizeAssistantLifeGenerationDiagnostic;
async function generate(text, contents) {
  const calls = [];
  const imports = {
    './assistantLifePromptEnvelope': {
      buildAssistantStatePairEnvelope: async () => ({ stableSystemPrompt: 'synthetic I identity', stablePrefixText: 'synthetic I identity' }),
      fetchAssistantLifeCompletion: async options => {
        calls.push(JSON.stringify({ request: options.request, messages: options.apiMessagesOverride }));
        return { content: contents, usage: { promptTokens: 100, cachedPromptTokens: 0, completionTokens: 10 }, finishReason: 'stop' };
      },
      AssistantLifeRequestError: class extends Error {},
    },
    '../life/junluoWantsGeneration': parser,
    '../life/junluoInnerStateStore': { loadJunluoDesireState: async () => ({ desires: { rest: { currentValue: 1 } } }) },
    './assistantLifeShortJsonRequest': { ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS: 120000,
      buildAssistantLifeShortJsonRequest: () => ({ temperature: 0.2 }) },
    './types': { defaultAiProfile: {} },
    '../chat/contextCompression': { estimateApiMessagesTokens: () => 100 },
    '../music/musicPlaybackMaterial': { formatMusicPlaybackMaterial: () => '' },
    '../posts/baiyunPostReplyMaterials': { buildPostLookPrompt: prompt => prompt },
  };
  const generator = compile(text, imports);
  const prepared = await generator.prepareAssistantWants({ apiKey: 'synthetic-key',
    connection: { model: 'synthetic-model', contextWindowTokens: 65536 }, currentState: { lifeMode: 'available' },
    source: 'life', now: 1000, materialForRounds: () => ({ text: '' }), onRequestStart: async () => {} });
  return { result: await prepared.execute(), calls };
}
function diagnosticArgument(relative, match) {
  const code = read(relative);
  const ast = ts.createSourceFile(relative, code, ts.ScriptTarget.Latest, true);
  const matches = [];
  const walk = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'appendAssistantLifeGenerationDiagnostic'
      && node.arguments.length && match(node.arguments[0].getText(ast))) matches.push(node.arguments[0].getText(ast));
    ts.forEachChild(node, walk);
  };
  walk(ast); assert.equal(matches.length, 1, relative);
  return matches[0];
}
const ordinaryArgument = diagnosticArgument('src/ai/assistantInnerStateRuntime.ts', text => text.includes("stage: 'request'") && text.includes('...inner.diagnostics'));
const sharedArgument = diagnosticArgument('src/ai/assistantSharedExperienceRuntime.ts', text => text.includes('...result.diagnostics') && text.includes("stage: 'request'"));
const fixed = { startedAt: 1000, requestId: 'synthetic-request', attemptOrdinal: 1, source: 'life', generationKey: 'synthetic-generation',
  materialKey: 'synthetic-fingerprint', input: { connection: { model: 'synthetic-model' }, currentState: {} },
  started: { wants: 1000, affect: 1000 }, activeBatch: { generationKey: 'synthetic-generation', wants: { attempts: 1 }, affect: { attempts: 1 } },
  operationId: () => 'synthetic-operation' };
function ordinary(result) {
  const values = { ...fixed, inner: result };
  const evaluator = compile('exports.evaluate = function(' + Object.keys(values).join(',') + '){return (' + ordinaryArgument + ');};', {}).evaluate;
  return normalizeDiagnostic(evaluator(...Object.values(values)));
}
function shared(result, paper) {
  const values = { ...fixed, result, paper };
  const evaluator = compile('exports.evaluate = function(' + Object.keys(values).join(',') + '){return (' + sharedArgument + ');};', {}).evaluate;
  return normalizeDiagnostic(evaluator(...Object.values(values)));
}
const cases = [
  ['invalid-json', 'not-json', 'invalid-json'],
  ['missing-wants', '{}', 'missing-wants'],
  ['invalid-wants', '{"wants":{}}', 'invalid-wants'],
  ['invalid-id', '{"wants":[{"id":"SENSITIVE_SENTINEL","change":"更想一点"}]}', 'invalid-item'],
  ['invalid-change', '{"wants":[{"id":"rest","change":"SENSITIVE_SENTINEL"}]}', 'invalid-item'],
  ['retired-reminder', '{"wants":[{"id":"remind_you","change":"更想一点"}]}', 'invalid-item'],
  ['empty-content', '', 'invalid-json'],
];
async function main() {
  let passed = 0;
  for (const [name, contents, code] of cases) {
    const before = await generate(baseline, contents), after = await generate(source, contents);
    const result = after.result;
    assert.equal(result.status, 'failure'); assert.equal(result.value, undefined);
    assert.deepEqual(result.parseIssues, [code]); assert.deepEqual(after.calls, before.calls);
    const { parseIssues, ...unchanged } = result; assert.deepEqual(unchanged, before.result);
    const first = ordinary(result), pair = shared(result, 'wants');
    assert.deepEqual(first.extraFields, [code]); assert.deepEqual(pair.extraFields, [code]);
    assert.deepEqual(first.operationIds, []); assert.equal(first.persistenceStatus, 'interrupted');
    assert.equal(pair.persistenceStatus, 'interrupted');
    assert.ok(!JSON.stringify({ first, pair }).includes('SENSITIVE_SENTINEL'));
    console.log(`PASS ${name}: fixed issue survives both existing diagnostic paths`); passed++;
  }
  for (const contents of ['{"wants":null}', '{"wants":[{"id":"rest","change":"更想一点"}]}',
    '{"wants":[{"id":"rest","change":"更想一点"},{"id":"wrong","change":"wrong"}]}']) {
    const before = await generate(baseline, contents), after = await generate(source, contents);
    assert.deepEqual(after, before); assert.equal(after.result.status, 'success');
    assert.deepEqual(ordinary(after.result).extraFields, after.result.value.issues);
    console.log('PASS valid/partly valid wants behavior and original issues unchanged'); passed++;
  }
  const affect = { status: 'failure', reason: 'invalid-json', parseIssues: ['synthetic-wants-only'],
    diagnostics: { outputChars: 0, recoveredFromReasoning: false, responseFormatRequested: false } };
  assert.equal(shared(affect, 'affect').extraFields, undefined);
  console.log('PASS shared affect path gets no new wants diagnostics'); passed++;
  console.log(JSON.stringify({ passed, realNetworkRequests: 0, businessWrites: 0, actualGeneratorParserAndDiagnosticArguments: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
