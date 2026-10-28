const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');

const filename = path.resolve(__dirname, '../src/runtime/homeBackgroundAiPresentation.ts');
const source = fs.readFileSync(filename, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.deepEqual((compiled.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
const moduleObject = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputText)(name => {
  throw Error(`pure presentation unexpectedly loaded ${name}`);
}, moduleObject, moduleObject.exports);
const { presentHomeBackgroundAi: present } = moduleObject.exports;
const start = new Date(2026, 9, 28, 12, 0).getTime();
let passed = 0;
function test(name, work) { work(); passed++; console.log(`PASS ${name}`); }
function input(patch = {}) {
  return { enabled: true, now: start + 3600000,
    runtime: { current: null, records: [], updatedAt: start, version: 1 },
    lifeDiagnostics: [], contact: { version: 1, initializedAt: start, day: '2026-10-28',
      used: 0, lastEndedAt: start, lastOrdinaryReplyAt: 0, current: null }, ...patch };
}
function life(patch = {}) {
  return { flow: 'near-status', contextSource: 'state', attemptedAt: start,
    generationKey: 'fixture-near', model: 'synthetic', responseFormatRequested: false,
    status: 'failure', failureReason: 'timeout', ...patch };
}
function transport(outcome, patch = {}) {
  return { startedAt: start, ...(outcome === 'started' ? {} : { finishedAt: start + 1000 }), outcome, ...patch };
}
function request(outcome, patch = {}) {
  return { paper: 'visible', outputChars: 0, status: outcome === 'response' ? 'success' : 'failure',
    transport: transport(outcome), ...patch };
}
function opportunity(patch = {}) {
  return { id: 'synthetic-op', sessionId: 'synthetic-session', createdAt: start,
    expiresAt: start + 900000, motives: [], sources: [], important: false, epoch: 1,
    latestYouId: null, sourceMessages: [], requests: 1, requestStartedAt: start,
    retryStarted: false, failedAt: null, retryAt: null, status: 'requesting', messages: [],
    savedMessageIds: [], endedAt: null, ...patch };
}
function withContact(op, patch = {}) {
  const value = input(); value.contact = { ...value.contact, current: opportunity(op), ...patch }; return value;
}
function contains(result, value) {
  assert.ok(`${result.title}\n${result.detail}\n${result.lastFailure ?? ''}\n${result.historyDetail ?? ''}`.includes(value), value);
}

test('no evidence reports idle and an unknown next time, not an inferred schedule', () => {
  const result = present(input());
  assert.equal(result.tone, 'neutral'); assert.equal(result.title, '当前没有正在执行的任务');
  contains(result, '不能从现有记录确认下一次运行时间');
  assert.equal(result.lastFailure, undefined);
  assert.doesNotMatch(result.detail, /未到时间|没有新材料|模型失败/);
});
test('transport started placeholder is not a completed failure or a current task', () => {
  const result = present(input({ lifeDiagnostics: [life({ failureReason: undefined, requests: [request('started')] })] }));
  contains(result, '请求未记录结束'); assert.equal(result.lastFailure, undefined);
  assert.equal(result.title, '当前没有正在执行的任务');
});
test('RAM current takes priority and can retain a separate older confirmed failure', () => {
  const value = input({ lifeDiagnostics: [life()] });
  value.runtime.current = { kind: 'chatReply', priority: 'critical', startedAt: start + 60000, status: 'running' };
  const result = present(value); assert.equal(result.tone, 'busy'); contains(result, '正在处理聊天回复');
  assert.match(result.lastFailure, /上次近况.*请求超时/);
});
test('closing automatic AI does not mislabel an existing in-flight task as stopped', () => {
  const value = input({ enabled: false });
  value.runtime.current = { kind: 'background-fixture', priority: 'background', startedAt: start, status: 'running' };
  const result = present(value); assert.equal(result.title, '自动 AI 已关闭，正在处理 AI 任务');
  assert.equal(result.tone, 'busy'); contains(result, '已有任务按原流程收尾');
});
test('disabled and idle remains explicitly disabled', () => {
  const result = present(input({ enabled: false })); assert.equal(result.title, '自动 AI 已关闭');
  contains(result, '当前没有正在执行的任务');
});
test('a later saved near-status clears only its own older failure', () => {
  const result = present(input({ lifeDiagnostics: [life(), life({ attemptedAt: start + 10000,
    generationKey: 'next', visibleTextSaved: true, status: 'success', failureReason: undefined })] }));
  assert.equal(result.lastFailure, undefined); contains(result, '首页文字已保存');
});
test('successful affect and wants do not clear near-status failure', () => {
  const result = present(input({ lifeDiagnostics: [life(), ...['wants', 'affect'].map(flow => life({
    flow, attemptedAt: start + 10000, status: 'success', failureReason: undefined, persistenceStatus: 'saved',
  }))] }));
  assert.match(result.lastFailure, /上次近况.*请求超时/);
});
test('same request local save confirmation supersedes its earlier failure', () => {
  const result = present(input({ lifeDiagnostics: [life(), life({ visibleTextSaved: true,
    persistenceStatus: 'saved', status: 'success', failureReason: undefined })] }));
  assert.equal(result.lastFailure, undefined); contains(result, '首页文字已保存');
});
test('HTTP 200 does not confirm homepage persistence or erase an earlier unsaved failure', () => {
  const result = present(input({ lifeDiagnostics: [life(), life({ attemptedAt: start + 10000,
    status: 'success', failureReason: undefined, requests: [request('response', { transport: transport('response', { httpStatus: 200 }) })] })] }));
  contains(result, '首页文字保存尚无确认'); assert.match(result.lastFailure, /请求超时/);
  assert.doesNotMatch(result.detail, /首页文字已保存/);
});
test('thought-only partial save does not become a homepage update', () => {
  const result = present(input({ lifeDiagnostics: [life({ status: 'success', failureReason: undefined,
    savedParts: ['thoughtNew'], persistenceStatus: 'pending' })] }));
  contains(result, '仍有内容待保存'); assert.doesNotMatch(result.detail, /首页文字已保存/);
});
test('interrupted persistence differs from a model failure', () => {
  const result = present(input({ lifeDiagnostics: [life({ status: 'failure', failureReason: undefined,
    persistenceStatus: 'interrupted', savedParts: ['thoughtNew'] })] }));
  contains(result, '本地保存已中断'); assert.equal(result.lastFailure, undefined);
});
test('positive visible text save remains confirmed even if another part is pending', () => {
  const result = present(input({ lifeDiagnostics: [life({ status: 'success', failureReason: undefined,
    persistenceStatus: 'pending', visibleTextSaved: true, savedParts: ['nearStatus'] })] }));
  contains(result, '首页文字已保存'); contains(result, '仍有其他内容待保存'); assert.equal(result.lastFailure, undefined);
});
test('budget skip and all not-started requests are not model failures', () => {
  for (const item of [life({ status: 'budget-skipped', failureReason: undefined }),
    life({ requests: [{ paper: 'visible', status: 'not-started', outputChars: 0 }] })]) {
    assert.equal(present(input({ lifeDiagnostics: [item] })).lastFailure, undefined);
  }
});

test('coalesced budget skip uses its most recent occurrence, without reordering delayed saves', () => {
  const result = present(input({ lifeDiagnostics: [
    life({ status: 'budget-skipped', failureReason: undefined, lastOccurredAt: start + 3600000 }),
    life({ attemptedAt: start + 1800000, lastOccurredAt: start + 7200000,
      status: 'success', failureReason: undefined, visibleTextSaved: true }),
  ] }));
  contains(result, '2026-10-28 13:00｜上次近况：未发起请求');
  assert.doesNotMatch(result.detail, /14:00|首页文字已保存/);
});

test('manual runtime history does not become background activity or a background failure', () => {
  const value = input(); value.runtime.records = [
    { kind: 'chatReply', priority: 'critical', startedAt: start, status: 'success' },
    { kind: 'chatVision', priority: 'normal', startedAt: start, status: 'failed', reason: 'timeout' },
    { kind: 'voiceCallReply', priority: 'urgent', startedAt: start, status: 'failed', reason: 'timeout' },
  ];
  const result = present(value); contains(result, '暂无后台处理记录');
  assert.equal(result.lastFailure, undefined);
  value.runtime.current = { kind: 'chatReply', priority: 'critical', startedAt: start, status: 'running' };
  assert.equal(present(value).title, '正在处理聊天回复');
  value.enabled = false;
  assert.equal(present(value).title, '自动 AI 已关闭，正在处理聊天回复');
});

test('urgent proactive task remains a background observation', () => {
  const value = input(); value.runtime.records = [
    { kind: 'proactive', priority: 'urgent', startedAt: start, status: 'failed', reason: 'timeout' },
  ]; assert.match(present(value).lastFailure, /请求超时/);
});
test('old started runtime record with no current is explicitly historical', () => {
  const value = input(); value.runtime.records = [{ kind: 'fixture', priority: 'background', startedAt: start, status: 'running' }];
  const result = present(value); contains(result, '上次 AI 任务：未记录结束');
  assert.equal(result.title, '当前没有正在执行的任务'); assert.equal(result.lastFailure, undefined);
});
test('scheduler skipped is not failure and scheduler success is not business persistence', () => {
  const value = input(); value.runtime.records = [
    { kind: 'fixture-a', priority: 'background', startedAt: start, status: 'skipped', reason: 'synthetic-private-text' },
    { kind: 'fixture-b', priority: 'background', startedAt: start + 1000, status: 'success' },
  ]; const result = present(value); contains(result, '此记录不确认业务内容已保存');
  assert.equal(result.lastFailure, undefined); assert.doesNotMatch(result.detail, /synthetic-private-text/);
});
test('contact retry explains registered retry time and safe technical cause', () => {
  const result = present(withContact({ status: 'waiting_retry', failedAt: start, retryAt: start + 300000,
    reason: 'TOOL_AGENT_MODEL_REQUEST_TIMEOUT:ai_timeout' }));
  contains(result, '等待原流程重试'); contains(result, '登记时间'); assert.match(result.lastFailure, /请求超时/);
  assert.equal(result.title, '当前没有正在执行的任务');
});
test('contact saving and handoff are not claimed as a live model request', () => {
  for (const [status, expected] of [['saving', '正文待保存'], ['handoff', '已交给聊天接续']]) {
    const result = present(withContact({ status })); contains(result, expected);
    assert.equal(result.title, '当前没有正在执行的任务'); assert.equal(result.lastFailure, undefined);
  }
});
test('contact disabled, silent and aborted completion are not model failures', () => {
  for (const reason of ['disabled', 'automatic_disabled', 'silent', 'aborted', 'transport_aborted']) {
    const result = present(withContact({ status: 'finished', endedAt: start + 10000, reason }));
    assert.equal(result.lastFailure, undefined, reason); assert.doesNotMatch(result.detail, /模型失败/);
  }
});
test('contact delivery counts distinct saved IDs without claiming notification or reading', () => {
  const result = present(withContact({ status: 'finished', endedAt: start + 10000,
    reason: 'delivered', savedMessageIds: ['one', 'one', 'two'] }));
  contains(result, '正文已保存 2 条'); assert.doesNotMatch(result.detail, /推送成功|已读|已收到通知/);
});
test('contact body failure is historical, timestamped and retains no diagnostic payload', () => {
  const result = present(withContact({ status: 'finished', endedAt: start + 10000,
    reason: 'body_protocol_failed:INVALID_REPLY_FORMAT|body1:synthetic-private-content' }));
  assert.match(result.lastFailure, /2026-10-28 12:00.*正文结构未通过检查/);
  assert.doesNotMatch(result.detail, /synthetic-private-content|INVALID_REPLY_FORMAT/);
});
test('unknown exceptions and runtime kind never leak into visible labels', () => {
  const value = withContact({ status: 'finished', endedAt: start + 10000, reason: 'synthetic-private-content' });
  value.lifeDiagnostics = [life({ failureReason: 'synthetic-private-content' })];
  value.runtime.records = [{ kind: 'synthetic-private-kind', priority: 'background', startedAt: start,
    status: 'failed', reason: 'synthetic-private-content' }];
  const result = present(value); assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  contains(result, '具体原因未记录');
});
test('prototype property names are not accepted as technical enum labels', () => {
  for (const reason of ['constructor', '__proto__', 'toString']) {
    const result = present(withContact({ status: 'finished', endedAt: start + 10000, reason }));
    assert.equal(result.lastFailure, undefined); assert.doesNotMatch(result.detail, /function|\[object Object\]/);
  }
});
test('later delivered contact clears only previous contact failure', () => {
  const value = withContact({ status: 'finished', endedAt: start + 60000, reason: 'delivered', savedMessageIds: ['one'] }, {
    diagnostics: [{ id: 'old-op', at: start, stage: 'finished', requests: 1, savedMessageIds: [],
      sourceIds: [], toolResultIds: [], reason: 'transport_timeout' }],
  }); assert.equal(present(value).lastFailure, undefined);
  value.lifeDiagnostics = [life()]; assert.match(present(value).lastFailure, /近况/);
});
test('historical failure keeps its actual date without TTL or claims that the current model is broken', () => {
  const result = present(input({ now: start + 45 * 86400000, lifeDiagnostics: [life()] }));
  assert.match(result.lastFailure, /2026-10-28 12:00.*上次近况/);
  assert.equal(result.title, '当前没有正在执行的任务');
});
test('projection is pure and does not mutate source arrays or records', () => {
  const value = input({ lifeDiagnostics: [life()] });
  const original = JSON.stringify(value); const result = present(value);
  assert.equal(JSON.stringify(value), original); assert.deepEqual(result, present(value));
});

test('many scheduler returns stay in optional history while a real saved result stays in the summary', () => {
  const value = input({ lifeDiagnostics: [life({ status: 'success', failureReason: undefined, visibleTextSaved: true })] });
  value.runtime.records = Array.from({ length: 80 }, (_, index) => ({ kind: `fixture-${index}`,
    priority: 'background', startedAt: start + index + 1, status: 'success' }));
  const before = JSON.stringify(value);
  const result = present(value);
  assert.match(result.detail, /最近处理\n.*首页文字已保存/);
  assert.doesNotMatch(result.detail, /上次 AI 任务|处理已返回/);
  assert.equal((result.historyDetail.match(/处理已返回/g) ?? []).length, 80);
  assert.match(result.historyDetail, /首页文字已保存/);
  assert.equal(JSON.stringify(value), before);
});

test('summary keeps only the latest meaningful result and an independent outstanding problem', () => {
  const result = present(input({ lifeDiagnostics: [life(),
    life({ flow: 'wants', attemptedAt: start + 1000, status: 'success', failureReason: undefined, persistenceStatus: 'saved' }),
    life({ flow: 'affect', attemptedAt: start + 2000, status: 'success', failureReason: undefined, persistenceStatus: 'saved' }),
  ] }));
  assert.match(result.detail, /最近处理\n.*上次感受/);
  assert.match(result.detail, /最近问题\n.*上次近况.*请求超时/);
  assert.doesNotMatch(result.detail, /上次十维/);
  assert.match(result.historyDetail, /上次十维/);
});

test('a latest failure appears once in the default detail, and scheduler failures are not hidden', () => {
  const result = present(input({ lifeDiagnostics: [life()] }));
  assert.equal((result.detail.match(/请求超时/g) ?? []).length, 1);
  assert.doesNotMatch(result.detail, /最近处理/);
  const value = input(); value.runtime.records = [{ kind: 'fixture', priority: 'background',
    startedAt: start, status: 'failed', reason: 'timeout' }];
  assert.match(present(value).detail, /最近问题\n.*请求超时/);
});

test('cleared problems remain historical without reappearing as an outstanding problem', () => {
  const result = present(input({ lifeDiagnostics: [life(), life({ attemptedAt: start + 1000,
    status: 'success', failureReason: undefined, visibleTextSaved: true })] }));
  assert.equal(result.lastFailure, undefined);
  assert.doesNotMatch(result.detail, /请求超时|最近问题/);
  assert.match(result.historyDetail, /请求超时/);
});

test('generic callback-only evidence remains uncertain and no evidence has no history', () => {
  const value = input(); value.runtime.records = [{ kind: 'fixture', priority: 'background',
    startedAt: start, status: 'success' }];
  const result = present(value);
  assert.match(result.detail, /暂未记录生活状态或主动消息的处理结果/);
  assert.doesNotMatch(result.detail, /已保存/);
  assert.match(result.historyDetail, /不确认业务内容已保存/);
  assert.equal(present(input()).historyDetail, undefined);
});

test('wants and affect describe their own save target without promising homepage prose', () => {
  for (const flow of ['wants', 'affect']) {
    for (const [persistenceStatus, expected] of [['saved', '处理结果已保存'],
      ['pending', '结果仍有内容待保存'], ['interrupted', '本地保存已中断'],
      [undefined, '已收到处理结果；保存尚无确认']]) {
      const result = present(input({ lifeDiagnostics: [life({ flow, status: 'success', failureReason: undefined,
        persistenceStatus, requests: [request('response')] })] }));
      assert.ok(result.detail.includes(expected));
      assert.doesNotMatch(`${result.detail}\n${result.historyDetail}`, /首页文字/);
      assert.equal(result.lastFailure, undefined);
    }
  }
});

test('internal save labels keep the same own-domain success clearing and unrelated problem', () => {
  for (const flow of ['wants', 'affect']) {
    const result = present(input({ lifeDiagnostics: [life(), life({ flow }),
      life({ flow, attemptedAt: start + 1000, status: 'success', failureReason: undefined, persistenceStatus: 'saved' }),
    ] }));
    assert.match(result.lastFailure, /上次近况.*请求超时/);
    assert.match(result.detail, /处理结果已保存/);
    assert.doesNotMatch(result.lastFailure, /十维|感受/);
  }
});

test('near-status and sleep-status still require positive visible-text save confirmation', () => {
  for (const flow of ['near-status', 'sleep-status']) {
    const result = present(input({ lifeDiagnostics: [life({ flow }), life({ flow, attemptedAt: start + 1000,
      status: 'success', failureReason: undefined, persistenceStatus: 'saved' })] }));
    assert.match(result.detail, /首页文字保存尚无确认/);
    assert.match(result.lastFailure, /请求超时/);
    const confirmed = present(input({ lifeDiagnostics: [life({ flow }), life({ flow, attemptedAt: start + 1000,
      status: 'success', failureReason: undefined, persistenceStatus: 'pending', visibleTextSaved: true })] }));
    assert.match(confirmed.detail, /首页文字已保存；仍有其他内容待保存/);
    assert.equal(confirmed.lastFailure, undefined);
  }
});

const componentSource = fs.readFileSync(path.resolve(__dirname, '../src/components/HomeBackgroundAiStatus.tsx'), 'utf8');
const componentJs = ts.transpileModule(componentSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function component(snapshot, readFailed = false) {
  const alerts = [], exports = {};
  const element = (type, props) => ({ type, props });
  const mocks = {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Alert: { alert: (...args) => alerts.push(args) }, Pressable: 'Pressable', View: 'View',
      StyleSheet: { hairlineWidth: 1, create: value => value } },
    './AppText': { AppText: 'Text' },
    '../runtime/useHomeBackgroundAiStatus': { useHomeBackgroundAiStatus: () => ({ snapshot, readFailed }) },
  };
  new Function('require', 'exports', componentJs)(name => {
    assert.ok(Object.hasOwn(mocks, name), `unexpected UI dependency ${name}`); return mocks[name];
  }, exports);
  const tree = exports.HomeBackgroundAiStatus({ active: true });
  tree.props.onPress();
  return alerts;
}

test('actual component opens the compact summary first and history only through its separate button', () => {
  const value = input({ lifeDiagnostics: [life()] });
  value.runtime.records = [{ kind: 'fixture', priority: 'background', startedAt: start + 1000, status: 'success' }];
  const view = present(value), alerts = component({ checkedAt: start, view });
  assert.equal(alerts.length, 1);
  assert.equal((alerts[0][1].match(/请求超时/g) ?? []).length, 1);
  assert.doesNotMatch(alerts[0][1], /处理已返回/);
  assert.match(alerts[0][1], /状态检查时间/);
  const buttons = alerts[0][2];
  assert.ok(buttons.some(button => button.text === '关闭' && button.style === 'cancel'));
  buttons.find(button => button.text === '更多记录').onPress();
  assert.equal(alerts.length, 2); assert.equal(alerts[1][0], '更多后台记录');
  assert.match(alerts[1][1], /处理已返回/); assert.match(alerts[1][1], /请求超时/);
});

test('read failures and loading do not offer stale or nonexistent history', () => {
  const stale = component({ checkedAt: start, view: present(input({ lifeDiagnostics: [life()] })) }, true)[0];
  assert.match(stale[1], /后台状态读取失败/);
  assert.doesNotMatch(stale[1], /请求超时/);
  assert.deepEqual(stale[2].map(button => button.text), ['关闭']);
  const loading = component(null)[0];
  assert.match(loading[1], /正在读取后台状态/);
  assert.deepEqual(loading[2].map(button => button.text), ['关闭']);
});
console.log(`home background AI presentation eval passed (${passed} cases)`);
