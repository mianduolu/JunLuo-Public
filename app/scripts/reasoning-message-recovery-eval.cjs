const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');

// Load the actual pure extractor, without a device, provider, or business store.
const appRoot = path.resolve(__dirname, '..');
const cache = new Map();
function loadTs(filename) {
  const absolute = path.resolve(filename);
  if (cache.has(absolute)) return cache.get(absolute);
  const moduleObject = { exports: {} };
  cache.set(absolute, moduleObject.exports);
  const js = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', js)(name => {
    assert.ok(name.startsWith('.'), `unexpected runtime dependency ${name}`);
    return loadTs(path.resolve(path.dirname(absolute), `${name}.ts`));
  }, moduleObject, moduleObject.exports);
  return moduleObject.exports;
}
const { extractVisibleReply, extractVisibleReplyFromRaw } = loadTs(
  path.join(appRoot, 'src/ai/visibleReplyExtraction.ts'),
);
const { inspectBaiyunFixedChatEnvelope } = loadTs(
  path.join(appRoot, 'src/ai/behavior/actionChatFixedEnvelope.ts'),
);
const modes = ['default', 'single_root_json'];
const root = messages => JSON.stringify({ messages });
let passed = 0;
const failures = [];
function test(name, run) {
  try {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.stack}`);
  }
}
function fromReasoning(raw, expectedStructure = 'single_root_json') {
  return extractVisibleReply({ directContent: '', reasoningContent: raw,
    allowReasoningRecovery: true, expectedStructure });
}
function expectOnlyMessages(actual, messages) {
  assert.equal(actual.status, 'visible');
  assert.deepEqual(actual.messages, messages);
  assert.equal(actual.source, 'reasoning_marked_visible');
  assert.deepEqual(JSON.parse(actual.raw), { messages });
  assert.equal(actual.hiddenPayload, undefined);
  assert.equal(actual.responseEvidenceCandidates, undefined);
}
function expectRejected(actual) {
  assert.notEqual(actual.status, 'visible');
  assert.deepEqual(actual.messages, []);
}

test('closed direct fence reconstructs the 232/220/94 shape with synthetic content', () => {
  const messages = [`合成${'正'.repeat(90)}文。`];
  assert.equal(messages[0].length, 94);
  const payload = { messages, careUpdates: [], shareResponses: [], innerReaction: '' };
  const padding = 220 - JSON.stringify(payload).length;
  assert.ok(padding >= 0);
  payload.innerReaction = '隐'.repeat(padding);
  const json = JSON.stringify(payload);
  const raw = '```json\n' + json + '\n```';
  assert.equal(json.length, 220);
  assert.equal(raw.length, 232);
  const actual = extractVisibleReplyFromRaw({ raw, expectedStructure: 'single_root_json' });
  assert.equal(actual.status, 'visible');
  assert.deepEqual(actual.messages, messages);
  assert.equal(actual.raw, raw, 'the transport wrapper must not be rewritten as a valid machine envelope');
  assert.equal(actual.hadOutsideText, true);
  assert.throws(() => JSON.parse(actual.raw));
  const inspection = inspectBaiyunFixedChatEnvelope(actual.raw);
  assert.equal(inspection.rootStatus, 'malformed');
  assert.deepEqual(inspection.fields.messages, { status: 'valid', value: messages });
  for (const field of ['careUpdates', 'shareResponses', 'innerReaction']) {
    assert.equal(inspection.fields[field].status, 'unavailable');
  }
  assert.equal(inspection.fields.memoryMentions, undefined);
});

test('ordinary complete direct JSON keeps its existing envelope', () => {
  const raw = JSON.stringify({ messages: ['合成直接正文。'], innerReaction: '合成内部字段' });
  const actual = extractVisibleReplyFromRaw({ raw, expectedStructure: 'single_root_json' });
  assert.equal(actual.status, 'visible');
  assert.deepEqual(actual.messages, ['合成直接正文。']);
  assert.equal(actual.raw, raw);
});

test('a normally readable single reasoning envelope keeps its original optional fields', () => {
  const raw = JSON.stringify({ messages: ['原路径完整正文。'], eventUpdates: [], sleepAt: null });
  for (const mode of modes) {
    const actual = fromReasoning(raw, mode);
    assert.equal(actual.status, 'visible');
    assert.deepEqual(actual.messages, ['原路径完整正文。']);
    assert.equal(actual.raw, raw);
  }
});

test('a complete root followed by thinking recovers only its message array', () => {
  for (const mode of modes) {
    expectOnlyMessages(fromReasoning('合成前置分析\n' + root(['完整的一句。', '完整的第二句。'])
      + '\n合成后置分析', mode), ['完整的一句。', '完整的第二句。']);
  }
});

test('thinking mixed into direct content preserves the complete body and leaves machine fields unavailable', () => {
  const messages = ['只保留明确正文。'];
  const raw = '合成分析\n' + JSON.stringify({ messages, innerReaction: '不能当聊天', careUpdates: [{ synthetic: true }] })
    + '\n继续合成分析';
  const actual = extractVisibleReplyFromRaw({ raw, expectedStructure: 'single_root_json' });
  assert.equal(actual.status, 'visible');
  assert.equal(actual.source, 'direct_content');
  assert.equal(actual.raw, raw);
  assert.deepEqual(actual.messages, messages);
  const inspection = inspectBaiyunFixedChatEnvelope(actual.raw);
  assert.deepEqual(inspection.fields.messages, { status: 'valid', value: messages });
  assert.equal(inspection.fields.innerReaction.status, 'unavailable');
  assert.equal(inspection.fields.careUpdates.status, 'unavailable');
});

test('identical direct candidates surrounded by analysis appear once', () => {
  const json = root(['同一份完整正文。']);
  const actual = extractVisibleReplyFromRaw({ raw: '分析\n' + json + '\n分析\n' + json + '\n分析',
    expectedStructure: 'single_root_json' });
  assert.deepEqual(actual.messages, ['同一份完整正文。']);
});

test('different direct candidates surrounded by analysis are not chosen for the model', () => {
  expectRejected(extractVisibleReplyFromRaw({ raw: '分析\n' + root(['甲。']) + '\n分析\n' + root(['乙。']) + '\n分析',
    expectedStructure: 'single_root_json' }));
});

test('an unreadable reply root is not silently skipped in favor of a different later root', () => {
  const raw = '{"messages":["第一份完整数组。"]","innerReaction":null}' + root(['第二份正文。']);
  expectRejected(extractVisibleReplyFromRaw({ raw, expectedStructure: 'single_root_json' }));
});

test('unrelated optional fields do not erase an explicit complete reasoning body', () => {
  expectOnlyMessages(fromReasoning('分析\n' + JSON.stringify({ messages: ['完整正文。'], extraField: 123 })
    + '\n继续分析'), ['完整正文。']);
});

test('identical roots separated by thinking yield one unchanged sequence', () => {
  for (const mode of modes) {
    const json = root(['同一稿。', '同一稿第二句。']);
    expectOnlyMessages(fromReasoning(`分析一\n${json}\n分析二\n${json}\n继续分析`, mode),
      ['同一稿。', '同一稿第二句。']);
  }
});

test('adjacent identical roots with a thinking tail terminate and deduplicate', () => {
  for (const mode of modes) {
    const json = root(['相邻的同一稿。']);
    expectOnlyMessages(fromReasoning(`分析\n${json}${json}${json}\n尾分析`, mode), ['相邻的同一稿。']);
  }
});

test('different complete candidates are rejected even when the last candidate ends the response', () => {
  for (const mode of modes) {
    for (const raw of [
      `分析\n${root(['稿甲。'])}\n再分析\n${root(['稿乙。'])}`,
      `分析\n${root(['稿甲。'])}\n再分析\n${root(['稿乙。'])}\n尾分析`,
      `${root(['稿甲。'])}${root(['稿乙。'])}`,
      `分析\n${root(['甲。', '乙。'])}\n再分析\n${root(['乙。', '甲。'])}`,
    ]) expectRejected(fromReasoning(raw, mode));
  }
});

test('messages nested in a complete outer object are not a reply root', () => {
  for (const mode of modes) {
    expectRejected(fromReasoning('分析\n{\n"semantic": {\n"messages":["内层状态。"]\n}\n}\n继续分析', mode));
  }
});

test('messages nested in a complete outer array are not a reply root', () => {
  for (const mode of modes) {
    expectRejected(fromReasoning('分析\n[\n' + root(['数组内资料。']) + '\n]\n继续分析', mode));
  }
});

test('an outer container starting after prose still protects its nested objects', () => {
  for (const mode of modes) {
    for (const raw of [
      '分析 {"semantic":\n ' + root(['内层状态。']) + '\n}\n继续分析',
      '分析 [\n ' + root(['数组内资料。']) + '\n]\n继续分析',
      '分析 {"arguments":\n ' + root(['内层参数。']) + '\n}\n继续分析',
    ]) expectRejected(fromReasoning(raw, mode));
  }
});

test('textual tools and tool arguments never become a visible reply', () => {
  for (const mode of modes) {
    for (const raw of [
      '分析\n' + JSON.stringify({ tool_calls: [{ function: { name: 'synthetic.tool', arguments: root(['参数。']) } }] }) + '\n尾分析',
      '分析\n' + JSON.stringify({ messages: ['<tool_call>{}</tool_call>'] }) + '\n尾分析',
      '分析\n' + JSON.stringify({ messages: ['正文。'], tool_calls: [] }) + '\n尾分析',
    ]) expectRejected(fromReasoning(raw, mode));
  }
});

test('hidden-only fields cannot fill a missing messages array', () => {
  for (const mode of modes) {
    for (const payload of [{ semantic: { action: 'synthetic' } }, { innerReaction: '只有内部字段。' },
      { notebookAction: { messages: ['嵌套记录。'] } }]) {
      expectRejected(fromReasoning('分析\n' + JSON.stringify(payload) + '\n继续分析', mode));
    }
  }
});

test('unfinished containers and partial messages are not repaired or appended', () => {
  for (const mode of modes) {
    for (const raw of [
      '分析\n{"messages":["未写完',
      '分析\n{"messages":["字符串完整但根未闭合。"]',
      '分析\n[\n' + root(['未闭合外层数组内的资料。']) + '\n继续分析',
    ]) expectRejected(fromReasoning(raw, mode));
  }
});

test('a later unfinished fragment does not erase or extend the only complete answer', () => {
  for (const mode of modes) {
    expectOnlyMessages(fromReasoning(`分析\n${root(['完整的一稿。'])}\n{"messages":["后续未写完`, mode),
      ['完整的一稿。']);
  }
});

test('empty mixed-type or non-array messages cannot recover inner prose', () => {
  for (const mode of modes) {
    for (const messages of [[], [''], ['一条正文。', 7], '不是数组', [{ text: '对象不是正文字符串' }]]) {
      expectRejected(fromReasoning('分析\n' + JSON.stringify({ messages, innerReaction: '不能补正文。' })
        + '\n继续分析', mode));
    }
  }
});

test('plain thinking without an explicit complete messages root stays invisible', () => {
  for (const mode of modes) expectRejected(fromReasoning('合成分析，只有普通文字，没有答卷容器。', mode));
});

test('valid direct content wins over different or repeated reasoning candidates', () => {
  const actual = extractVisibleReply({ directContent: root(['直接正文。']),
    reasoningContent: `分析\n${root(['思考稿甲。'])}\n${root(['思考稿乙。'])}\n分析`,
    allowReasoningRecovery: true, expectedStructure: 'single_root_json' });
  assert.equal(actual.status, 'visible');
  assert.equal(actual.source, 'direct_content');
  assert.deepEqual(actual.messages, ['直接正文。']);
});

test('disabled reasoning recovery never recovers a complete reasoning answer', () => {
  expectRejected(extractVisibleReply({ directContent: '', reasoningContent: '分析\n' + root(['不应救回。'])
    + '\n继续分析', allowReasoningRecovery: false, expectedStructure: 'single_root_json' }));
});

test('quoted braces brackets escaped quotes and line escapes remain literal message text', () => {
  const messages = ['代码 { x: [1, 2] }，引号 "x"，路径 C:\\synthetic。', '字面字符 \\n 和 \\t。'];
  for (const mode of modes) expectOnlyMessages(fromReasoning('分析\n' + root(messages) + '\n尾分析', mode), messages);
});

test('recovery projects only messages and never adopts complete machine siblings', () => {
  const messages = ['只恢复这句正文。'];
  const payload = { messages, careUpdates: [{ item: 1, state: 'synthetic' }], shareResponses: [],
    innerReaction: '合成心声不得外露', memoryMentions: [], presenceUpdate: { state: 'synthetic' },
    semantic: { action: 'synthetic' }, notebookAction: { action: 'synthetic' }, continuityResolutions: [] };
  for (const mode of modes) {
    expectOnlyMessages(fromReasoning('分析\n' + JSON.stringify(payload) + '\n尾分析', mode), messages);
  }
});

console.log(`RESULT ${passed}/25 actual-extractor groups; HTTP=0, model=0, business_storage=0`);
if (failures.length) {
  console.error(`FAILED_GROUPS ${JSON.stringify(failures)}`);
  process.exitCode = 1;
}
