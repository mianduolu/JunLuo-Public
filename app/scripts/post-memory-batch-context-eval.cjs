const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../..'), app = path.join(root, 'app/src');
const ts = require(path.join(root, 'app/node_modules/typescript'));
const useCandidate = process.argv.includes('--candidate');
const relative = 'posts/baiyunPostRecallSource.ts';
const activeFile = useCandidate ? path.join(__dirname, 'app/src', relative) : path.join(app, relative);
function selected(file, names) {
  const text = fs.readFileSync(path.join(app, file), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return ast.statements.filter(node => ts.isFunctionDeclaration(node) ? names.includes(node.name?.text)
    : ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.includes(item.name.getText(ast))))
    .map(node => node.getText(ast).startsWith('export ') ? node.getText(ast) : 'export ' + node.getText(ast)).join('\n');
}
function compile(text, file, ports = {}, globals = {}) {
  const m = { exports: {} }, output = ts.transpileModule(text, { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, reportDiagnostics: true });
  assert.equal(output.diagnostics.length, 0);
  vm.runInNewContext('(function(require,module,exports){' + output.outputText + '\n})', {
    Date, Number, String, Object, Array, Map, Set, Math, JSON, Error, Promise, AbortController, ...globals,
  }, { filename: file })(id => { assert.ok(id in ports, 'Unexpected dependency: ' + id); return ports[id]; }, m, m.exports);
  return m.exports;
}
const data = compile(fs.readFileSync(path.join(app, 'posts/baiyunPostData.ts'), 'utf8'), 'actual-post-data');
const reading = compile(fs.readFileSync(path.join(app, 'posts/baiyunPostReading.ts'), 'utf8'), 'actual-post-reading', { './baiyunPostData': data });
const image = compile(selected('posts/baiyunPostImageData.ts', ['postImageOwnerKey', 'postImageGroupKey']), 'actual-image-keys');
const atomic = compile(selected('memory/memoryAtomicity.ts', ['stableMemoryHash']), 'actual-hash');
const reply = compile(selected('posts/baiyunPostReplyState.ts', ['emptyPostReplyState', 'initializePostReading']), 'actual-reading-init', {}, { ...data, ...reading });
const scoreCode = selected('memory/memoryEmbedding.ts', ['emptyTargetScores', 'scoreMemoryTargets', 'cosineSimilarityValidated',
  'readEmbeddingChunks', 'isValidEmbeddingVector', 'splitEmbeddingText', 'hashText', 'embeddingConnectionIdentity',
  'getMemoryEmbeddingHash', 'getPostSourceEmbeddingHash', 'postSourceEmbeddingRanges']);
function harness() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE baiyun_post_metadata(post_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL);
    CREATE TABLE baiyun_post_comment_metadata(post_id TEXT,source TEXT,payload_json TEXT NOT NULL,PRIMARY KEY(post_id,source));
    CREATE TABLE baiyun_post_image_vision(post_id TEXT,owner_key TEXT,group_key TEXT,description TEXT);
    CREATE TABLE baiyun_post_tags(id TEXT,name TEXT,merged_into_id TEXT);`);
  const h = { raw, runtime: { replies: { posts: {}, papers: {}, reading: { activatedAt: 0, rounds: [] } } },
    runtimeReads: 0, runtimeWrites: 0, visionReads: 0, tagReads: 0, postReads: [], commentReads: [], onPost: async () => {}, failTags: false };
  const clone = value => structuredClone(value);
  const db = h.db = {
    getAllAsync: async (sql, ...args) => { if (sql.includes('FROM baiyun_post_image_vision')) h.visionReads++;
      if (sql.includes('FROM baiyun_post_tags')) { h.tagReads++; if (h.failTags) throw Error('fixture-tag-read-failed'); }
      return raw.prepare(sql).all(...args); },
    getFirstAsync: async (sql, ...args) => raw.prepare(sql).get(...args) ?? null,
  };
  const stores = {
    loadBaiyunPostRuntime: async () => { h.runtimeReads++; return clone(h.runtime); },
    updateBaiyunPostRuntime: async transform => { h.runtimeWrites++; h.runtime = transform(clone(h.runtime)); return clone(h.runtime); },
    loadLocalBaiyunPost: async id => { h.postReads.push(id); await h.onPost(id);
      const row = await db.getFirstAsync('SELECT payload_json FROM baiyun_post_metadata WHERE post_id=?', id); return row ? JSON.parse(row.payload_json) : null; },
    loadLocalBaiyunPostComments: async id => { h.commentReads.push(id);
      return (await db.getAllAsync('SELECT payload_json FROM baiyun_post_comment_metadata WHERE post_id=?', id)).map(row => JSON.parse(row.payload_json)); },
    loadLocalBaiyunPostPage: async () => ({ posts: raw.prepare('SELECT payload_json FROM baiyun_post_metadata').all().map(row => JSON.parse(row.payload_json)),
      comments: raw.prepare('SELECT payload_json FROM baiyun_post_comment_metadata').all().map(row => JSON.parse(row.payload_json)) }),
  };
  const known = compile(selected('posts/baiyunPostKnown.ts', ['selectKnownPostMaterial', 'ensurePostReadingStarted']), 'actual-known', {},
    { ...stores, ...reading, ...image, ...reply, captureBackupRestoreDataEpoch: () => 1 });
  const memorySource = compile(fs.readFileSync(path.join(app, 'posts/baiyunPostMemorySource.ts'), 'utf8'), 'actual-post-memory-source', {
    '../memory/memoryAtomicity': atomic, '../backup/backupRestoreCoordinator': { canCommitBackupRestoreDataEpoch: () => true },
    './baiyunPostData': data, './baiyunPostKnown': known, './baiyunPostReading': reading,
    '../memory/memoryStore': { getMemoryDatabase: async () => db }, './baiyunPostStore': stores,
  });
  const ports = { '../memory/memoryAtomicity': atomic, '../memory/memoryStore': { getMemoryDatabase: async () => db },
    './baiyunPostData': data, './baiyunPostKnown': known, './baiyunPostMemorySource': memorySource,
    './baiyunPostReading': reading, './baiyunPostStore': stores };
  const api = h.api = compile(fs.readFileSync(activeFile, 'utf8'), relative, ports);
  h.add = (id, author = 'I', content = '虚构动态原文。') => {
    const post = { id, author, title: '虚构标题', content, tagIds: [], imageGroup: null, createdAt: 10, updatedAt: 10, contentVersion: 1 };
    h.save(post); return post;
  };
  h.save = post => raw.prepare('INSERT OR REPLACE INTO baiyun_post_metadata VALUES (?,?)').run(post.id, JSON.stringify(post));
  h.comment = (postId, source, author = 'I') => {
    const item = { postId, source, author, content: '虚构留言。', storageId: source, imageGroup: null, createdAt: 11, updatedAt: 11, deleted: false };
    raw.prepare('INSERT INTO baiyun_post_comment_metadata VALUES (?,?,?)').run(postId, source, JSON.stringify(item)); return item;
  };
  h.mark = (post, comments = [], images = {}) => { h.runtime.replies.reading = reading.recordPostReading(h.runtime.replies.reading,
    { postId: post.id, source: 'seen-' + h.runtime.replies.reading.rounds.length, at: 20,
      refs: [reading.postReadRef(post, images), ...comments.map(item => reading.postReadRef(item, images))] }); };
  h.resetCounts = () => { h.runtimeReads = h.runtimeWrites = h.visionReads = h.tagReads = 0; h.postReads = []; h.commentReads = []; };
  h.score = async (ids, between = async () => {}) => {
    const settings = { model: 'fixture', baseUrl: 'https://invalid.local' }, initial = await api.loadPostSourceIndexSources(ids);
    let pass = 0;
    const score = compile(scoreCode, 'actual-score', { '../posts/baiyunPostRecallSource': {
      loadPostSourceIndexSources: async keys => { if (++pass === 2) await between(); return api.loadPostSourceIndexSources(keys); },
    } });
    const rows = [...initial.values()].map(value => ({ memory_id: value.id, model: settings.model,
      embedding_json: '[1,0]', content_hash: score.getPostSourceEmbeddingHash(value, settings) }));
    const result = await score.scoreMemoryTargets({ getAllAsync: async () => rows }, [[[1, 0]]], settings,
      { eligibleMemoryIds: new Set(), eligibleCurrentStateIds: new Set(), eligibleShiyingRecordIds: new Set(), eligiblePostSourceIds: new Set(ids) }, 40, false);
    assert.equal(pass, 2, 'Original scorer must still perform two independent source reads');
    return result.results[0].postSources;
  };
  return h;
}
let passed = 0, failed = 0; const results = [];
const plain = value => JSON.parse(JSON.stringify([...value]));
async function check(name, run) { const h = harness(); try { await run(h); passed++; results.push({ name, passed: true }); }
  catch (error) { failed++; results.push({ name, passed: false, error: error.message }); } finally { h.raw.close(); } }
(async () => {
  await check('sixteen parents share one knowledge vision and tag snapshot per batch', async h => {
    const ids = Array.from({ length: 16 }, (_, i) => 'post:' + h.add('parent-' + i).id);
    const result = await h.api.loadPostSourceIndexSources(ids); assert.equal(result.size, 16);
    assert.equal(h.runtimeReads, 1); assert.equal(h.visionReads, 1); assert.equal(h.tagReads, 1);
    assert.equal(h.postReads.length, 16); assert.equal(h.commentReads.length, 16);
  });
  await check('second batch takes another fresh context rather than reusing previous', async h => {
    const ids = ['post:' + h.add('a').id, 'post:' + h.add('b').id];
    await h.api.loadPostSourceIndexSources(ids); await h.api.loadPostSourceIndexSources(ids);
    assert.equal(h.runtimeReads, 2); assert.equal(h.visionReads, 2); assert.equal(h.tagReads, 2);
  });
  await check('batch values hashes and ordering match public single-parent reads', async h => {
    h.add('one'); const you = h.add('two', 'you'); const c = h.comment('two', 'source:with:colons', 'you'); h.mark(you, [c]);
    const ids = ['post:one', 'comment:two:source:with:colons', 'post:two'];
    const singles = new Map();
    for (const postId of ['one', 'two']) {
      for (const source of await h.api.listPostSourceIndexSourcesForPost(postId)) {
        if (ids.includes(source.id)) singles.set(source.id, source);
      }
    }
    assert.deepEqual(plain(await h.api.loadPostSourceIndexSources(ids)), plain(singles));
  });
  await check('empty and unknown identities do not initialize reading or load context', async h => {
    h.runtime.replies.reading = undefined;
    assert.equal((await h.api.loadPostSourceIndexSources([])).size, 0);
    assert.equal((await h.api.loadPostSourceIndexSources(['not-present'])).size, 0);
    assert.equal(h.runtimeReads, 0); assert.equal(h.runtimeWrites, 0); assert.equal(h.tagReads, 0);
  });
  await check('duplicate and same-parent identities read parent once and return only requested sources', async h => {
    h.add('one'); h.comment('one', 'a'); h.comment('one', 'unrequested');
    const result = await h.api.loadPostSourceIndexSources(['post:one', 'comment:one:a', 'post:one']);
    assert.equal(result.size, 2); assert.deepEqual(h.postReads, ['one']); assert.ok(!result.has('comment:one:unrequested'));
  });
  await check('unread you parent and unread you comment remain unavailable', async h => {
    h.add('unread', 'you'); h.add('own'); h.comment('own', 'unread-comment', 'you');
    const result = await h.api.loadPostSourceIndexSources(['post:unread', 'comment:own:unread-comment']); assert.equal(result.size, 0);
  });
  await check('source edit between original scorer passes rejects old vector', async h => {
    const post = h.add('edit'); const result = await h.score(['post:edit'], async () => { h.save({ ...post, content: '改好的原文。', updatedAt: 30, contentVersion: 2 }); });
    assert.equal(result.size, 0);
  });
  await check('source deletion between original scorer passes rejects old vector', async h => {
    h.add('delete'); const result = await h.score(['post:delete'], async () => h.raw.prepare('DELETE FROM baiyun_post_metadata WHERE post_id=?').run('delete'));
    assert.equal(result.size, 0);
  });
  await check('reading qualification change between original scorer passes rejects source', async h => {
    const post = h.add('reading', 'you'); h.mark(post);
    const result = await h.score(['post:reading'], async () => { h.runtime.replies.reading.rounds = []; }); assert.equal(result.size, 0);
  });
  await check('pre-read knowledge rechecks current SQL images once for exact parents', async h => {
    const a = h.add('a'), b = h.add('b');
    const knowledge = { reading: structuredClone(h.runtime.replies.reading), vision: [{ owner_key: 'stale', group_key: 'stale', description: '旧图记。' }] };
    h.resetCounts(); const result = await h.api.loadPostSourceIndexSources(['post:' + a.id, 'post:' + b.id], { database: h.db, knowledge });
    assert.equal(result.size, 2); assert.equal(h.runtimeReads, 0); assert.equal(h.visionReads, 1); assert.equal(h.tagReads, 1);
  });
  await check('pre-read knowledge cannot certify a changed unviewed picture', async h => {
    const post = h.add('image'); post.imageGroup = { id: 'group', version: 1, imageIds: ['image1'] }; h.save(post);
    const old = '旧图片记录。', owner = image.postImageOwnerKey({ postId: post.id, commentSource: null }), group = image.postImageGroupKey(post.imageGroup);
    h.raw.prepare('INSERT INTO baiyun_post_image_vision VALUES (?,?,?,?)').run(post.id, owner, group, old); h.mark(post, [], { group: old });
    const knowledge = { reading: structuredClone(h.runtime.replies.reading), vision: [{ owner_key: owner, group_key: group, description: old }] };
    const before = await h.api.loadPostSourceIndexSources(['post:image'], { database: h.db, knowledge });
    h.raw.prepare('UPDATE baiyun_post_image_vision SET description=?').run('新图记还没读过。');
    const after = await h.api.loadPostSourceIndexSources(['post:image'], { database: h.db, knowledge });
    assert.ok(before.get('post:image').content.includes(old)); assert.ok(!after.get('post:image').content.includes(old));
    assert.notEqual(after.get('post:image').sourceHash, before.get('post:image').sourceHash);
  });
  await check('context read failure is preserved rather than an empty result', async h => {
    h.add('a'); h.failTags = true; await assert.rejects(h.api.loadPostSourceIndexSources(['post:a']), /fixture-tag-read-failed/);
  });
  await check('already-cancelled read never starts a parent', async h => {
    h.add('a'); const controller = new AbortController(); controller.abort();
    await assert.rejects(h.api.loadPostSourceIndexSources(['post:a'], { signal: controller.signal }), error => error.name === 'AbortError'); assert.deepEqual(h.postReads, []);
  });
  await check('cancellation stops before starting next parent', async h => {
    h.add('a'); h.add('b'); const controller = new AbortController(); h.onPost = async id => { if (id === 'a') controller.abort(); };
    await assert.rejects(h.api.loadPostSourceIndexSources(['post:a', 'post:b'], { signal: controller.signal }), error => error.name === 'AbortError'); assert.deepEqual(h.postReads, ['a']);
  });
  await check('readOnly initialization keeps missing reading snapshot in RAM only', async h => {
    h.add('a'); h.add('b'); h.runtime.replies.reading = undefined;
    assert.equal((await h.api.loadPostSourceIndexSources(['post:a', 'post:b'], { readOnly: true })).size, 2);
    assert.equal(h.runtimeWrites, 0); assert.equal(h.runtime.replies.reading, undefined);
  });
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  console.log(JSON.stringify({ useCandidate, passed, failed, total: results.length, results,
    source: { path: 'app/src/' + relative, sha256: hash(fs.readFileSync(activeFile)) },
    actualNetworkRequests: 0, realDatabase: ':memory:', rawApplicationStorageOrDeviceCalls: 0 }));
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

