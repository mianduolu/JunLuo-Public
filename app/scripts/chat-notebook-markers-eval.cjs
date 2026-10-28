const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function load(file, mocks) {
  const exports = {};
  new Function('require', 'exports', compile(file))(name => {
    assert(name in mocks, `Unexpected dependency ${name}`);
    return mocks[name];
  }, exports);
  return exports;
}
const values = new Map();
let failWrite = false;
const storage = {
  getItem: async key => values.get(key) ?? null,
  setItem: async (key, value) => { if (failWrite) throw Error('disk-full'); values.set(key, value); },
  removeItem: async key => values.delete(key),
};
const notebook = load('src/chat/notebookStore.ts', {
  '../sync/syncChatRelationshipStorageBridge': { chatRelationshipStorageBridge: storage },
  './keywordCounterStore': { loadKeywordCounterSnapshot: async () => ({ tasks: [] }) },
});
const { getNotebookMarkedMessageIds: marked } = load('src/chat/useChatNotebookMarkers.ts', {
  react: {}, './notebookStore': notebook,
  './chatMessageDisplay': {
    getDisplayedChatMessageContent: message => message.content,
    hasRenderableChatMessageContent: (message, text) => message.source !== 'letter' && !!text,
  },
});
const message = (id, role, patch = {}) => ({ id, role, content: id, createdAt: 1, ...patch });
const chat = [message('you-1', 'you'), message('I-1', 'I'), message('I-2', 'I'),
  message('you-2', 'you'), message('I-3', 'I')];
const note = (sourceMessageId, sourceType = 'assistant_inner_reaction') => ({ sourceMessageId, sourceType });
async function main() {
  assert.deepEqual([...marked(chat, [])], []);
  assert.deepEqual([...marked(chat, [note('you-1')])], ['I-1']);
  assert.deepEqual([...marked(chat, [note('you-1'), note('you-1')])], ['I-1']);
  assert.deepEqual([...marked(chat, [note('I-2')])], ['I-2']);
  assert.deepEqual([...marked(chat, [note('absent')])], []);
  assert.deepEqual([...marked(chat, [note('you-1', 'manual'), note('you-2', 'keyword_counter')])], []);
  assert.deepEqual([...marked(chat, [note('you-2', 'assistant_hidden_request')])], ['I-3']);
  assert.deepEqual([...marked([message('you-1', 'you'), message('you-2', 'you'), message('I-3', 'I')], [note('you-1')])], []);
  assert.deepEqual([...marked([chat[0], message('failed', 'I', { deliveryStatus: 'failed' }),
    message('letter-original', 'I', { source: 'letter' }), chat[1]], [note('you-1')])], ['I-1']);
  assert.deepEqual([...marked(chat.slice(1), [note('you-1')])], []);
  let notified = 0;
  let latest = [];
  const unsubscribe = notebook.subscribeNotebookChanged(snapshot => { notified++; latest = snapshot.entries; });
  failWrite = true;
  await assert.rejects(notebook.createNotebookEntry({ content: 'A saved moment', sourceMessageId: 'you-1', sourceType: 'assistant_inner_reaction' }));
  assert.equal(notified, 0);
  assert.deepEqual([...marked(chat, latest)], []);
  failWrite = false;
  const saved = await notebook.createNotebookEntry({ content: 'A saved moment', sourceMessageId: 'you-1', sourceType: 'assistant_inner_reaction' });
  assert(saved);
  assert.equal(notified, 1);
  assert.deepEqual([...marked(chat, latest)], ['I-1']);
  assert.deepEqual([...marked(chat, (await notebook.loadNotebookSnapshot()).entries)], ['I-1']);
  await notebook.deleteNotebookEntry(saved.id);
  assert.equal(notified, 2);
  assert.deepEqual([...marked(chat, latest)], []);
  unsubscribe();
  const badListener = notebook.subscribeNotebookChanged(() => { throw Error('view-unmounted'); });
  assert(await notebook.createNotebookEntry({ content: 'Still saved', sourceMessageId: 'you-2', sourceType: 'assistant_inner_reaction' }));
  badListener();
  assert.equal(notified, 2);
  console.log('chat-notebook-markers: 15/15 passed (RAM only)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
