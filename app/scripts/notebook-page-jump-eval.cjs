const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../node_modules/typescript');

const appRoot = path.resolve(__dirname, '..');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023,
    jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true,
});
const paginationModule = { exports: {} };
new Function('module', 'exports', compile(fs.readFileSync(
  path.join(appRoot, 'src/letters/notebookPagination.ts'), 'utf8')).outputText)(
  paginationModule, paginationModule.exports,
);
const { paginateNotebook, notebookPageIndexFromInput } = paginationModule.exports;
const source = fs.readFileSync(path.join(appRoot, 'src/screens/LetterScreen.tsx'), 'utf8');
const ast = ts.createSourceFile('LetterScreen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map();
let syncPageEffect;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['turnNotebookPage', 'jumpToNotebookPage', 'toggleNotebookExpanded'].includes(node.name.getText(ast))) {
    handlers.set(node.name.getText(ast), `const ${node.getText(ast)};`);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes('setNotebookPageInput')) {
    assert.equal(syncPageEffect, undefined, 'one page/input synchronization effect');
    syncPageEffect = node.arguments[0].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(handlers.size, 3);
assert.ok(syncPageEffect);
let passed = 0;
function test(name, run) {
  run();
  passed += 1;
  console.log(`PASS ${name}`);
}
function entries(count) { return Array.from({ length: count }, (_, index) => ({ id: `synthetic-${index}` })); }
function harness(rows, input, pageIndex = 0, expanded = false) {
  const calls = [];
  const runtime = {
    notebookEntries: rows,
    notebookPage: paginateNotebook(rows, pageIndex),
    notebookExpanded: expanded,
    notebookJumpIndex: notebookPageIndexFromInput(input, paginateNotebook(rows, pageIndex).pageCount),
    paginateNotebook,
    setNotebookPageIndex: value => calls.push(['page', value]),
    setNotebookPageInput: value => calls.push(['input', value]),
    setNotebookExpanded: value => calls.push(['expanded', value]),
    markNotebookPageRead: page => calls.push(['read', page.map(entry => entry.id)]),
    correspondenceScroll: { current: { scrollTo: options => calls.push(['scroll', options]) } },
    Keyboard: { dismiss: () => calls.push(['dismiss']) },
  };
  const js = compile([...handlers.values()].join('\n') + '\nconst syncPage = ' + syncPageEffect + ';').outputText;
  const actual = new Function(...Object.keys(runtime), js
    + '\nreturn {turnNotebookPage, jumpToNotebookPage, toggleNotebookExpanded, syncPage};')(...Object.values(runtime));
  return { ...actual, calls, page: runtime.notebookPage };
}

test('one-based page input reaches distant pages rather than advancing one page', () => {
  assert.equal(notebookPageIndexFromInput('12', 13), 11);
  assert.equal(notebookPageIndexFromInput(' 13 ', 13), 12);
  assert.equal(notebookPageIndexFromInput('001', 13), 0);
});
test('empty fractional signed nonnumeric and out-of-range input cannot select a page', () => {
  for (const input of ['', ' ', '0', '-1', '+2', '1.5', '2e0', 'NaN', 'Infinity', '页12', '14', '9007199254740993']) {
    assert.equal(notebookPageIndexFromInput(input, 13), undefined, input);
  }
  for (const pageCount of [0, -1, NaN, Infinity, 1.5]) {
    assert.equal(notebookPageIndexFromInput('1', pageCount), undefined);
  }
});
test('existing slices retain input order and do not mutate notebook contents', () => {
  const rows = entries(97);
  const before = JSON.stringify(rows);
  const page = paginateNotebook(rows, notebookPageIndexFromInput('12', 13));
  assert.equal(page.pageCount, 13);
  assert.deepEqual(page.entries.map(entry => entry.id), entries(8).map((_, index) => `synthetic-${88 + index}`));
  assert.equal(JSON.stringify(rows), before);
});
test('a last page with one entry and an empty notebook preserve existing pagination', () => {
  assert.deepEqual(paginateNotebook(entries(97), 12).entries.map(entry => entry.id), ['synthetic-96']);
  assert.deepEqual(paginateNotebook([], 12), { pageIndex: 0, pageCount: 1, entries: [] });
});
test('the production jump handler selects page twelve and marks only that displayed slice', () => {
  const actual = harness(entries(97), '12');
  actual.jumpToNotebookPage();
  assert.deepEqual(actual.calls, [
    ['dismiss'], ['page', 11], ['read', entries(8).map((_, index) => `synthetic-${88 + index}`)],
    ['scroll', { y: 0, animated: false }],
  ]);
});
test('an invalid production jump does not move scroll or mark another page read', () => {
  for (const input of ['', '0', '14', 'bad']) {
    const actual = harness(entries(97), input, 4);
    actual.jumpToNotebookPage();
    assert.deepEqual(actual.calls, []);
  }
});
test('existing previous and next handlers still use the original clamped page selection', () => {
  const actual = harness(entries(97), '6', 5);
  actual.turnNotebookPage(actual.page.pageIndex + 1);
  assert.deepEqual(actual.calls[0], ['page', 6]);
  assert.deepEqual(actual.calls[1], ['read', entries(8).map((_, index) => `synthetic-${48 + index}`)]);
  const previous = harness(entries(97), '1');
  previous.turnNotebookPage(-1);
  assert.deepEqual(previous.calls[0], ['page', 0]);
});
test('opening the original flip control reveals the selected page without resetting it', () => {
  const actual = harness(entries(97), '12', 11);
  actual.toggleNotebookExpanded();
  assert.deepEqual(actual.calls, [
    ['expanded', true], ['read', entries(8).map((_, index) => `synthetic-${88 + index}`)],
  ]);
  const close = harness(entries(97), '12', 11, true);
  close.toggleNotebookExpanded();
  assert.deepEqual(close.calls, [['expanded', false]]);
});
test('the production effect updates page input after navigation', () => {
  const actual = harness(entries(97), '12', 11);
  actual.syncPage();
  assert.deepEqual(actual.calls, [['page', 11], ['input', '12']]);
});
test('removing the final row clamps the existing last page and synchronizes the input', () => {
  const actual = harness(entries(96), '13', 12);
  actual.syncPage();
  assert.deepEqual(actual.calls, [['page', 11], ['input', '12']]);
  assert.equal(notebookPageIndexFromInput('13', actual.page.pageCount), undefined);
});
test('page input and submit button are above the notebook entries and share the production handler', () => {
  const input = source.indexOf('accessibilityLabel="小本本跳转页码"');
  const firstEntry = source.indexOf('notebookPage.entries.map');
  const jump = source.indexOf('accessibilityLabel="跳转到小本本指定页"');
  assert.ok(input > 0 && input < firstEntry && jump > input && jump < firstEntry);
  assert.ok(source.slice(input, jump).includes('onSubmitEditing={jumpToNotebookPage}'));
  assert.ok(source.slice(input, jump).includes('onChangeText={setNotebookPageInput}'));
  assert.ok(source.slice(jump, firstEntry).includes('onPress={jumpToNotebookPage}'));
  assert.ok(source.slice(jump, firstEntry).includes('disabled={notebookJumpIndex === undefined}'));
});
test('the notebook delete and open interactions remain attached to the original entry', () => {
  assert.ok(source.includes('onPress={() => void openNotebookEntryInChat(entry)}'));
  assert.ok(source.includes('event.stopPropagation();\n                          confirmDeleteNotebookEntry(entry);')
    || source.includes('event.stopPropagation();\r\n                          confirmDeleteNotebookEntry(entry);'));
  assert.ok(source.includes('turnNotebookPage(notebookPage.pageIndex + 1)'));
  assert.ok(source.includes('turnNotebookPage(notebookPage.pageIndex - 1)'));
});
test('the changed screen and pure helper transpile without syntax diagnostics', () => {
  for (const text of [source, fs.readFileSync(path.join(appRoot, 'src/letters/notebookPagination.ts'), 'utf8')]) {
    assert.deepEqual(compile(text).diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), []);
  }
});
console.log(`RESULT ${passed}/13 notebook navigation groups; HTTP=0, model=0, business_storage=0`);
