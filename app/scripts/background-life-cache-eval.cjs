const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const appRoot = path.resolve(__dirname, '..');
const ts = require(path.join(appRoot, 'node_modules/typescript'));
const filename = path.join(appRoot, 'src/ai/assistantLifePromptEnvelope.ts');
const adopted = fs.readFileSync(filename, 'utf8').replaceAll('\r\n', '\n');
function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'candidate anchor must be unique');
  return source.replace(before, after);
}
let original = replaceOnce(adopted,
  "import { applyConnectionPromptCacheToRequestBody } from './promptCacheRequest';\n", '');
original = replaceOnce(original,
  '      body = applyConnectionPromptCacheToRequestBody(body, connection.promptCacheMode);\n', '');
original = replaceOnce(original, '      metric.observeSerializedRequest(body);\n', '');
let candidate = replaceOnce(original,
  "import { recordPromptRuntimeSnapshot } from './promptDiagnostics';",
  "import { recordPromptRuntimeSnapshot } from './promptDiagnostics';\nimport { applyConnectionPromptCacheToRequestBody } from './promptCacheRequest';");
candidate = replaceOnce(candidate,
  '      if (!prepared) await prepareTransport();',
  '      if (!prepared) await prepareTransport();\n      body = applyConnectionPromptCacheToRequestBody(body, connection.promptCacheMode);');
candidate = replaceOnce(candidate,
  '        contextSource: metricContextSource ?? contextSource, stablePrefixText: envelope.stablePrefixText });',
  '        contextSource: metricContextSource ?? contextSource, stablePrefixText: envelope.stablePrefixText });\n      metric.observeSerializedRequest(body);');
assert.equal(candidate, adopted, 'the evaluated candidate must be the actual adopted source');
const sha = source => crypto.createHash('sha256').update(source).digest('hex');
function compile(source, imports, fetchMock) {
  const compiled = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  }});
  assert.equal((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const moduleObject = { exports: {} };
  new Function('require', 'module', 'exports', 'fetch', compiled.outputText)(name => {
    assert.ok(Object.hasOwn(imports, name), `unexpected runtime import ${name}`);
    return imports[name];
  }, moduleObject, moduleObject.exports, fetchMock);
  return moduleObject.exports;
}
const helper = compile(fs.readFileSync(path.join(appRoot, 'src/ai/promptCacheRequest.ts'), 'utf8'), {}, null);
const identity = 'synthetic I identity';
const envelope = { apiMessages: [{ role: 'system', content: identity }], contextProfile: 'assistant-state',
  stablePrefixText: identity, stableSystemPrompt: identity, taskPromptText: 'synthetic task' };
const connection = { id: 'synthetic', model: 'arbitrary-model', baseUrl: 'https://offline.invalid/v1' };
async function run(source, extra = {}, responseKind = 'ok') {
  const events = [], bodies = [], observations = [], usage = [];
  const controller = new AbortController();
  const metrics = { beginPromptCacheMetric: () => {
    events.push('metric');
    return { observeSerializedRequest: body => { events.push('observe'); observations.push(body); },
      recordUsage: value => usage.push(value), finish: () => events.push('finish') };
  }, extractPromptCacheUsageFromResponseUsage: value => ({ hitTokens: value?.prompt_tokens_details?.cached_tokens }) };
  const imports = { './builtInSystemPrompt': {}, './promptCacheMetrics': metrics,
    './promptDiagnostics': { recordPromptRuntimeSnapshot: () => events.push('snapshot') },
    './subjectiveMessages': {}, './promptContextProfile': {}, './promptCacheRequest': helper };
  const fetchMock = async (_url, options) => {
    events.push('fetch'); bodies.push(options.body);
    if (options.signal.aborted || responseKind === 'abort') { const e = new Error('synthetic'); e.name = 'AbortError'; throw e; }
    if (responseKind === 'network') throw new TypeError('synthetic-network');
    return { ok: responseKind !== '429', status: responseKind === '429' ? 429 : 200, json: async () => {
      if (responseKind === 'invalid-json') throw new SyntaxError('synthetic');
      return { choices: [{ message: { content: '{"synthetic":true}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } } };
    }};
  };
  const entry = compile(source, imports, fetchMock).fetchAssistantLifeCompletion;
  let value, error;
  const options = { apiKey: 'synthetic-key', connection, envelope, userPrompt: 'synthetic current facts',
    contextSource: 'assistant-life.state', signal: controller.signal,
    onTransportAttempt: value => events.push(`transport:${value.outcome}`) };
  const changes = typeof extra === 'function' ? extra({ controller, events }) : extra;
  try { value = await entry({ ...options, ...changes }); }
  catch (caught) { error = { name: caught.name, reason: caught.failureReason, message: caught.message }; }
  return { value, error, events, bodies, observations, usage };
}
let passed = 0;
async function test(name, work) { await work(); passed++; console.log(`PASS ${name}`); }
async function main() {
  for (const mode of [undefined, 'server-default']) {
    await test(`default mode ${String(mode)} remains byte-identical`, async () => {
      const extra = { connection: { ...connection, promptCacheMode: mode }, request: { max_tokens: 37, tools: [{ synthetic: true }] } };
      const before = await run(original, extra), after = await run(candidate, extra);
      assert.deepEqual(after.bodies, before.bodies); assert.deepEqual(after.value, before.value);
      assert.equal(after.observations[0], after.bodies[0]); assert.equal(after.bodies.length, 1);
      assert.deepEqual(after.events.filter(x => x !== 'observe'), before.events);
    });
  }
  await test('explicit wraps only original first System and keeps tool/history/parameters', async () => {
    const extra = { connection: { ...connection, promptCacheMode: 'ephemeral-first-system' },
      apiMessagesOverride: [{ role: 'system', content: identity }, { role: 'assistant', content: 'synthetic I' },
        { role: 'user', content: 'synthetic you' }, { role: 'system', content: 'synthetic changing facts' }],
      request: { temperature: 0.2, tools: [{ synthetic: true }], tool_choice: 'auto' } };
    const before = await run(original, extra), after = await run(candidate, extra);
    const parsed = JSON.parse(after.bodies[0]);
    assert.deepEqual(parsed.messages[0].content, [{ type: 'text', text: identity, cache_control: { type: 'ephemeral' } }]);
    parsed.messages[0].content = parsed.messages[0].content[0].text;
    assert.equal(JSON.stringify(parsed), before.bodies[0]); assert.equal(after.observations[0], after.bodies[0]);
    assert.deepEqual(after.value, before.value);
  });
  await test('cache rule ignores model name', async () => {
    for (const model of ['synthetic-a', 'synthetic-b']) {
      const result = await run(candidate, { connection: { ...connection, model, promptCacheMode: 'ephemeral-first-system' } });
      assert.ok(JSON.parse(result.bodies[0]).messages[0].content[0].cache_control);
    }
  });
  await test('final async refresh precedes wrapper and exact observation', async () => {
    const result = await run(candidate, ({ events }) => ({
      connection: { ...connection, promptCacheMode: 'ephemeral-first-system' },
      refreshMemoryMaterials: async () => { events.push('refresh'); return 'synthetic refreshed facts'; },
      onRequestStart: async prepare => { events.push('admission'); await prepare(); await prepare(); },
    }));
    assert.equal(result.events.filter(x => x === 'refresh').length, 1);
    assert.equal(JSON.parse(result.bodies[0]).messages.at(-1).content, 'synthetic refreshed facts');
    assert.ok(result.events.indexOf('refresh') < result.events.indexOf('observe'));
    assert.equal(result.bodies.length, 1); assert.equal(result.observations[0], result.bodies[0]);
  });
  await test('existing request messages override remains actual transmitted source', async () => {
    const result = await run(candidate, { connection: { ...connection, promptCacheMode: 'ephemeral-first-system' },
      request: { messages: [{ role: 'system', content: 'synthetic override' }] } });
    assert.equal(JSON.parse(result.bodies[0]).messages[0].content[0].text, 'synthetic override');
  });
  await test('already-block content is not nested or replaced', async () => {
    const blocks = [{ type: 'text', text: 'synthetic block' }];
    const extra = { connection: { ...connection, promptCacheMode: 'ephemeral-first-system' },
      apiMessagesOverride: [{ role: 'system', content: blocks }] };
    assert.deepEqual((await run(candidate, extra)).bodies, (await run(original, extra)).bodies);
  });
  await test('pre-admission abort sends nothing and observes nothing', async () => {
    const extra = ({ controller }) => { controller.abort(); return {}; };
    const before = await run(original, extra), after = await run(candidate, extra);
    assert.deepEqual(after.error, before.error); assert.equal(after.bodies.length, 0); assert.equal(after.observations.length, 0);
  });
  await test('admission abort preserves one aborted dispatch and no retry', async () => {
    const extra = ({ controller }) => ({ onRequestStart: async prepare => { await prepare(); controller.abort(); } });
    const before = await run(original, extra), after = await run(candidate, extra);
    assert.deepEqual(after.error, before.error); assert.deepEqual(after.bodies, before.bodies);
    assert.equal(after.bodies.length, 1); assert.equal(after.events.at(-1), 'finish');
  });
  for (const responseKind of ['network', '429', 'invalid-json', 'abort']) {
    await test(`${responseKind} keeps original error and dispatch count`, async () => {
      const before = await run(original, {}, responseKind), after = await run(candidate, {}, responseKind);
      assert.deepEqual(after.error, before.error); assert.deepEqual(after.bodies, before.bodies);
      assert.equal(after.bodies.length, 1); assert.equal(after.events.at(-1), 'finish');
    });
  }
  console.log(JSON.stringify({ passed, actualProductionSourceVerified: true, actualNetworkRequests: 0,
    normalizedBaselineSha256: sha(original), normalizedAdoptedSha256: sha(candidate),
    productionSha256: sha(fs.readFileSync(filename, 'utf8')), syntaxOnlyNotTypecheck: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
