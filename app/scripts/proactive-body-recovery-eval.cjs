const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');

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
    if (name === '../chat/chatExpenseMaterials') return { expensePlanHistoryMaterial() { throw Error('unrelated history port'); } };
    if (name === '../chat/chatReminderMaterials') return { reminderPlanHistoryMaterial() { throw Error('unrelated history port'); } };
    assert.ok(name.startsWith('.'), `unexpected runtime dependency ${name}`);
    return loadTs(path.resolve(path.dirname(absolute), `${name}.ts`));
  }, moduleObject, moduleObject.exports);
  return moduleObject.exports;
}
const parser = loadTs(path.join(appRoot, 'src/proactive/proactiveLitePrompt.ts'));
const visible = loadTs(path.join(appRoot, 'src/ai/visibleReplyExtraction.ts'));
const parse = parser.parseOrdinaryProactiveLiteResponseWithDiagnostics;
let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}
function expectMessages(raw, messages, options) {
  const actual = parse(raw, options);
  const expected = parser.normalizeProactiveLiteMessagesWithDiagnostics(messages, options);
  assert.deepEqual(actual.messages, expected.messages);
  assert.equal(actual.rawMessageCount, expected.diagnostics.rawMessageCount);
  assert.equal(actual.keptMessageCount, expected.diagnostics.keptMessageCount);
  return actual;
}

test('724-character envelope with five complete strings and one trailing backtick', () => {
  const messages = [131, 153, 161, 138, 111].map((length, index) => String.fromCharCode(0x4e00 + index).repeat(length));
  const raw = JSON.stringify({ messages }) + '`';
  assert.equal(raw.length, 724);
  assert.equal(expectMessages(raw, messages).keptMessageCount, 5);
});
test('complete messages survive ordinary and mismatched markdown fences', () => {
  const messages = ['小仓鼠，早上好。', '今天想做些什么？'];
  for (const raw of [
    '```json\n' + JSON.stringify({ messages }) + '\n```',
    '```json\n' + JSON.stringify({ messages }) + '\n`',
    '````json\n' + JSON.stringify({ messages }) + '\n````',
    JSON.stringify(messages) + '`',
  ]) expectMessages(raw, messages);
});
test('complete root messages survive an unfinished optional internal field', () => {
  expectMessages('{"messages":["先把完整的话交给你。"],"innerReaction":"unfinished', ['先把完整的话交给你。']);
});
test('legacy state and messages tags expose only the visible message array', () => {
  expectMessages('<state>{"internal":"synthetic hidden material"}</state><messages>["小仓鼠，来聊一会儿。"]</messages>', ['小仓鼠，来聊一会儿。']);
});
test('existing typography compatibility supplies complete prose', () => {
  expectMessages('{“messages”：[“早上好，小仓鼠。”]}', ['早上好，小仓鼠。']);
});
test('literal code punctuation inside messages remains on the original cleaner', () => {
  const messages = ['示例：`x]}`，路径 C:\\temp，字符串 "a"。', 'const value = `sample`;'];
  expectMessages(JSON.stringify({ messages }) + '`', messages);
  expectMessages('我写了一个 `code`。', ['我写了一个 `code`。']);
  expectMessages('```js\nconst value = `sample`;\n```', ['```js\nconst value = `sample`;\n```']);
});
test('unfinished messages do not invent or extend a bubble', () => {
  for (const raw of ['{"messages":["还没结束', '{"messages":["这一句虽然完整。"']) {
    assert.equal(parse(raw).keptMessageCount, 0);
  }
});
test('tool markup, hidden fields, and nested messages do not become reply text', () => {
  for (const raw of [
    '{"messages":["<tool_call>{}</tool_call>"]}`',
    '{"messages":["<internal>synthetic</internal>"]}`',
    '{"tool_calls":[{"function":{"name":"synthetic.tool","arguments":{"messages":["nested"]}}}]}`',
    '{"internal":{"messages":["nested"]}}`',
  ]) assert.equal(parse(raw).keptMessageCount, 0);
});
test('external-action validation affects its own segment and preserves the other one', () => {
  const messages = ['我刚刚搜到一篇文章。', '小仓鼠，早上好。'];
  const raw = JSON.stringify({ messages }) + '`';
  const result = expectMessages(raw, messages);
  assert.equal(result.rawMessageCount, 2);
  assert.equal(result.keptMessageCount, 1);
  assert.ok(result.reasons.includes('外部动作完成声称'));
  assert.equal(expectMessages(raw, messages, { allowExternalActionClaims: true }).keptMessageCount, 2);
});
test('repeated roots use the same first complete body as the common extractor', () => {
  const raw = '{"messages":["第一份完整正文。"]}{"messages":["第二份正文。"]}';
  const baseline = visible.extractVisibleReplyFromRaw({ raw, allowPlainText: false, expectedStructure: 'single_root_json' });
  assert.equal(baseline.status, 'visible');
  expectMessages(raw, baseline.messages);
});
const dispatchSource = fs.readFileSync(path.join(appRoot, 'src/proactive/unifiedContactDispatch.ts'), 'utf8');
const startMarker = '      if (opportunity.phoneEmergency && turn.silent && !turn.diagnostics.wasTruncated)';
const endMarker = '      return parsed.messages;';
assert.equal(dispatchSource.split(startMarker).length, 2, 'one production ordinary-body selection block');
const start = dispatchSource.indexOf(startMarker);
const end = dispatchSource.indexOf(endMarker, start) + endMarker.length;
assert.ok(end > start);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// Execute the production selection block with RAM-only lifecycle ports.
const selectBody = new AsyncFunction('turn', 'opportunity', 'lastRequestToken', 'epoch', 'sessionId',
  'shareMaterials', 'readUnifiedContactState', 'canCommitBackupRestoreDataEpoch', 'emptyBody',
  'parseOrdinaryProactiveLiteResponseWithDiagnostics', 'recoverCompleteProactiveLiteResponse', 'console',
  dispatchSource.slice(start, end));
function fixture(overrides = {}) {
  const opportunity = { id: 'synthetic-op', sources: [], phoneEmergency: false };
  Object.assign(opportunity, overrides.opportunity);
  const active = { id: opportunity.id, epoch: 7, sessionId: 'synthetic-session', status: 'requesting',
    requestToken: 'synthetic-token', expiresAt: Date.now() + 60_000 };
  const turn = { assistantText: '', results: [], state: { status: 'failed' },
    protocolFailure: { code: 'INVALID_REPLY_FORMAT' }, diagnostics: { responseObserved: true, wasTruncated: false } };
  Object.assign(turn, overrides.turn);
  Object.assign(active, overrides.active);
  if (overrides.direct !== undefined) Object.defineProperty(turn.diagnostics, 'fixedEnvelopeRawDirect', { value: overrides.direct });
  return selectBody(turn, opportunity, 'synthetic-token', 7, 'synthetic-session', [], async () => ({ current: active }),
    epoch => epoch === 7 && overrides.epochCurrent !== false,
    async reason => Object.assign(Error(reason), { code: reason }), parse, parser.recoverCompleteProactiveLiteResponse,
    { info() {} });
}
async function dispatchTests() {
  const full = '{"messages":["这句已经写完整了。"]}';
  async function check(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }
  await check('truncated transport preserves a complete structured body', async () => {
    assert.deepEqual(await fixture({ turn: { assistantText: full, protocolFailure: undefined,
      diagnostics: { wasTruncated: true } } }), ['这句已经写完整了。']);
  });
  await check('truncated transport also preserves complete messages before a broken optional field', async () => {
    assert.deepEqual(await fixture({ turn: { assistantText: '{"messages":["这句完整了。"],"internal":"unfinished',
      protocolFailure: undefined, diagnostics: { wasTruncated: true } } }), ['这句完整了。']);
  });
  await check('truncated plain prose and unfinished arrays remain rejected', async () => {
    for (const assistantText of ['小仓鼠，我正想说', '{"messages":["还没有写完']) {
      await assert.rejects(fixture({ turn: { assistantText, protocolFailure: undefined,
        diagnostics: { wasTruncated: true } } }), error => error.code === 'body_truncated');
    }
  });
  await check('observed current-format failure may preserve its own complete direct body', async () => {
    assert.deepEqual(await fixture({ direct: full + '`' }), ['这句已经写完整了。']);
  });
  await check('a rejected separate tool field cannot detain prose or become an executed tool', async () => {
    assert.deepEqual(await fixture({ direct: '{"messages":["这句已经写完整了。"],"tool_calls":[{"name":"synthetic.not_executed"}]}',
      turn: { protocolFailure: { code: 'INVALID_REPLY_FORMAT', replyFormatReason: 'textual_tool_protocol', rawToolCallCount: 0 } } }),
    ['这句已经写完整了。']);
  });
  await check('cancelled and unobserved completions cannot recover a direct body', async () => {
    for (const turn of [{ state: { status: 'cancelled' } }, { state: { status: 'failed', cancellation: { reason: 'synthetic' } } },
      { diagnostics: { responseObserved: false, wasTruncated: false } }]) {
      await assert.rejects(fixture({ direct: full, turn }), error => error.code === 'body_protocol_failed');
    }
  });
  await check('stale token, opportunity, session, and data epoch cannot recover a body', async () => {
    for (const active of [{ requestToken: 'replacement' }, { id: 'replacement' }, { sessionId: 'replacement' }, { epoch: 8 }, { status: 'finished' },
      { expiresAt: Date.now() - 1 }]) {
      await assert.rejects(fixture({ direct: full, active }), error => error.code === 'body_protocol_failed');
    }
    await assert.rejects(fixture({ direct: full, epochCurrent: false }), error => error.code === 'body_protocol_failed');
  });
  await check('other tool failures and request limits do not reuse the diagnostic direct', async () => {
    for (const code of ['MODEL_REQUEST_LIMIT', 'TOOL_NOT_ALLOWED', 'INVALID_TOOL_CALL_BATCH']) {
      await assert.rejects(fixture({ direct: full, turn: { protocolFailure: { code } } }), error => error.code === 'body_protocol_failed');
    }
  });
  await check('empty or tool-marked direct responses do not create a reply', async () => {
    for (const direct of ['{"messages":[]}', '{"messages":["<tool_call>{}</tool_call>"]}']) {
      await assert.rejects(fixture({ direct }), error => error.code === 'body_protocol_failed');
    }
  });
  await check('recovery retains per-segment external-action validation', async () => {
    assert.deepEqual(await fixture({ direct: '{"messages":["我刚刚搜到一篇文章。","这句已经写完整了。"]}' }), ['这句已经写完整了。']);
  });
  await check('ordinary plain replies and nontruncated emergency silence preserve their routes', async () => {
    assert.deepEqual(await fixture({ turn: { assistantText: '小仓鼠，早上好。', protocolFailure: undefined,
      state: { status: 'completed' }, diagnostics: { wasTruncated: false } } }), ['小仓鼠，早上好。']);
    assert.deepEqual(await fixture({ opportunity: { phoneEmergency: true }, turn: { silent: true,
      protocolFailure: undefined, diagnostics: { wasTruncated: false } } }), { kind: 'silent' });
    await assert.rejects(fixture({ opportunity: { phoneEmergency: true }, turn: { silent: true,
      protocolFailure: undefined, diagnostics: { wasTruncated: true } } }), error => error.code === 'body_truncated');
  });
  console.log(`RESULT ${passed}/21 actual-source cases; HTTP=0, business_storage=0, model=0`);
}
dispatchTests().catch(error => { console.error(error); process.exitCode = 1; });
