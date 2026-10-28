const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'app/node_modules/typescript'));
const app = path.join(root, 'app/src');
const candidate = process.argv.includes('--candidate');
const relative = 'shiying/shiyingMemoryIngestion.ts';
const before = '    if (bodyStart >= snapshot.body.length && imageNoteStart >= (snapshot.imageNote?.body.length ?? 0)) continue;';
const after = '    if (!snapshot.body.slice(bodyStart).trim()\n      && !(snapshot.imageNote?.body ?? \'\').slice(imageNoteStart).trim()) continue;';
const source = fs.readFileSync(path.join(app, relative), 'utf8');
if (candidate) assert.equal(source.split(before).length, 2, 'Candidate must match exactly one original guard');
const modules = new Map(), mocks = new Map();
const mock = (name, value) => mocks.set(path.join(app, name + '.ts'), value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
mock('memory/memoryAtomicity', { stableMemoryHash: hash });
mock('sync/syncBaiyunPostConfirmations', { retainSavedPostConfirmations: async () => undefined });
mock('memory/memoryCandidateReview', { memoryCandidateEditableHash: value => hash(JSON.stringify(value)) });
const allowed = new Set([relative, 'memory/memoryIngestionLedger.ts',
  'shiying/shiyingMemoryOrganizationProtocol.ts', 'reading/readingMemoryOrganizationProtocol.ts']);
function load(file) {
  file = path.resolve(app, file.endsWith('.ts') ? file : file + '.ts');
  if (mocks.has(file)) return mocks.get(file);
  if (modules.has(file)) return modules.get(file).exports;
  const name = path.relative(app, file).replaceAll('\\', '/');
  assert.ok(allowed.has(name), 'Unexpected production dependency: ' + name);
  let text = fs.readFileSync(file, 'utf8');
  if (candidate && name === relative) text = text.replace(before, after);
  const compiled = ts.transpileModule(text, { fileName: file, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true,
  }, reportDiagnostics: true });
  assert.equal(compiled.diagnostics.length, 0);
  const instance = new Module(file, module); instance.filename = file; modules.set(file, instance);
  instance.require = id => { assert.ok(id.startsWith('.')); return load(path.resolve(path.dirname(file), id)); };
  instance._compile(compiled.outputText, file); return instance.exports;
}
const ledger = load('memory/memoryIngestionLedger.ts');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(ledger.MEMORY_INGESTION_SCHEMA_SQL);
sqlite.exec('CREATE TABLE memories(id TEXT PRIMARY KEY,type TEXT); CREATE TABLE memory_source_refs(memory_id TEXT,session_id TEXT,relation TEXT); CREATE TABLE memory_current_states(id TEXT,status TEXT,source_refs_json TEXT);');
const db = {
  getAllAsync: async (sql, ...args) => sqlite.prepare(sql).all(...args),
  getFirstAsync: async (sql, ...args) => sqlite.prepare(sql).get(...args) ?? null,
  runAsync: async (sql, ...args) => sqlite.prepare(sql).run(...args),
  async withExclusiveTransactionAsync(run) { sqlite.exec('BEGIN'); try { const result = await run(db); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
};
let epoch = 1;
mock('backup/backupRestoreCoordinator', { captureBackupRestoreDataEpoch: () => epoch,
  canCommitBackupRestoreDataEpoch: value => value === epoch,
  runBackupRestoreDataEpochCommit: async (value, run) => value === epoch ? { committed: true, value: await run() } : { committed: false } });
mock('memory/memoryStore', { getMemoryDatabase: async () => db });
mock('memory/memoryDuplicateCleanupState', { runMemoryDuplicateCleanupBusinessWrite: run => run() });
let snapshot;
mock('shiying/shiyingMemorySource', { listShiyingMemorySnapshots: async () => [structuredClone(snapshot)],
  loadShiyingMemorySnapshot: async () => structuredClone(snapshot), parseShiyingMemorySource: () => null,
  shiyingMemorySourceSessionId: value => JSON.stringify(value) });
const runtime = load(relative), protocol = load('shiying/shiyingMemoryOrganizationProtocol.ts');
let passed = 0, failed = 0; const results = [];
async function check(name, run) {
  sqlite.exec('DELETE FROM memory_ingestion_items; DELETE FROM memory_ingestion_batches;');
  try { await run(); passed++; results.push({ name, passed: true }); }
  catch (error) { failed++; results.push({ name, passed: false, error: error.message }); }
}
function fresh(body, image = '') {
  snapshot = { recordId: '8c000000-0000-4000-8000-000000000099', recordDate: '2026-10-26',
    body, bodyVersion: 'body-v1', recordContentHash: 'record-v1', materialHash: 'material-v1',
    createdAt: 10, finalizedAt: 20, updatedAt: 20,
    imageNote: image ? { body: image, version: 'image-v1', createdAt: 20 } : null };
}
async function history(parts, status = 'no_value') {
  const bindings = parts.map(([part, end, version]) => ({ recordId: snapshot.recordId, part,
    version: version ?? (part === 'body' ? snapshot.bodyVersion : snapshot.imageNote.version),
    recordContentHash: snapshot.recordContentHash, start: 0, nextOffset: end, range: { start: 0, end } }));
  await ledger.beginMemoryIngestionBatchWithDatabase(db, { id: 'fictional-range', stream: 'proactive',
    scopeKey: 'shiying-record', sessionId: 'fictional-chat', sourceHash: 'fictional', advancesCursor: false,
    workMetadata: { version: 1, workId: 'fictional-range', messageIds: [], shiying: bindings } });
  await db.runAsync('UPDATE memory_ingestion_batches SET status=? WHERE id=?', status, 'fictional-range');
}
async function work() {
  const original = JSON.stringify(snapshot);
  const result = await runtime.nextShiyingOrganizationWork({ sessionId: 'fictional-chat' });
  assert.equal(JSON.stringify(snapshot), original, 'Original text must not be trimmed or rewritten');
  return result;
}
(async () => {
  await check('settled body followed only by 7000 spaces stops occupying work', async () => {
    fresh('已写完。' + ' '.repeat(7000));
    const fragment = protocol.prepareShiyingOrganizationFragment(snapshot, { bodyStart: 0, imageNoteStart: 0, references: { body: 'S1' } });
    assert.equal(fragment.status, 'ready'); assert.equal(fragment.nextBodyOffset, 4);
    await history([['body', fragment.nextBodyOffset]]);
    assert.equal((await work()).pendingSources.length, 0);
    const row = await db.getFirstAsync('SELECT work_metadata_json FROM memory_ingestion_batches WHERE id=?', 'fictional-range');
    assert.equal(JSON.parse(row.work_metadata_json).shiying[0].nextOffset, 4, 'Unsent whitespace is not falsely settled');
  });
  await check('settled image followed by whitespace stops occupying work', async () => {
    fresh('正文。', '图片。' + '\n\t '.repeat(2200)); await history([['body', 3], ['image_note', 3]]);
    assert.equal((await work()).pendingSources.length, 0);
  });
  await check('both settled suffixes are whitespace', async () => {
    fresh('正文。' + ' '.repeat(7000), '图片。' + '\u3000'.repeat(7000)); await history([['body', 3], ['image_note', 3]]);
    assert.equal((await work()).eligibleSources.length, 0);
  });
  await check('whitespace-only text without an available image note is not a logical material', async () => {
    fresh('\n\t '.repeat(2400)); assert.equal((await work()).pendingSources.length, 0);
  });
  await check('real over-budget punctuation-free body remains pending and blocked', async () => {
    fresh('无'.repeat(7000)); const next = await work(); assert.equal(next.eligibleCount, 1);
    assert.equal(protocol.prepareShiyingOrganizationFragment(snapshot, { bodyStart: 0, imageNoteStart: 0, references: { body: 'S1' } }).status, 'blocked');
  });
  await check('whitespace before unread real text remains pending', async () => {
    fresh('已读。' + ' '.repeat(10) + '还有原文。'); await history([['body', 3]]);
    const next = await work(); assert.equal(next.pendingSources.length, 1); assert.equal(next.pendingSources[0].bodyStart, 3);
  });
  await check('finished body does not drop unread image note', async () => {
    fresh('已读。' + ' '.repeat(100), '图片有新内容。'); await history([['body', 3]]);
    const next = await work(); assert.equal(next.pendingSources.length, 1); assert.equal(next.pendingSources[0].imageNoteStart, 0);
  });
  await check('finished image note does not drop unread body', async () => {
    fresh('正文有新内容。', '已读。' + ' '.repeat(100)); await history([['image_note', 3]]);
    assert.equal((await work()).pendingSources.length, 1);
  });
  await check('failed prefix retains retry and never advances', async () => {
    fresh('已写完。' + ' '.repeat(7000)); await history([['body', 4]], 'failed');
    const next = await work(); assert.equal(next.pendingSources[0].bodyStart, 0); assert.ok(next.pendingSources[0].retry);
  });
  await check('waiting candidate remains blocked before suffix check', async () => {
    fresh('已写完。' + ' '.repeat(7000)); await history([['body', 4]], 'waiting');
    assert.deepEqual((await work()).blockedRecords, [snapshot.recordId]);
  });
  await check('old version cannot consume new content', async () => {
    fresh('新原文。' + ' '.repeat(7000)); await history([['body', 4, 'old-version']]);
    const next = await work(); assert.equal(next.pendingSources[0].bodyStart, 0);
  });
  await check('ordinary exact-end completion unchanged', async () => {
    fresh('完整原文。'); await history([['body', snapshot.body.length]]);
    assert.equal((await work()).pendingSources.length, 0);
  });
  sqlite.close();
  console.log(JSON.stringify({ candidate, passed, failed, total: results.length, productionSourceSha256: hash(source),
    candidateSourceSha256: hash(source.replace(before, after)), realDatabase: ':memory:', actualNetworkRequests: 0, results }));
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error.stack); sqlite.close(); process.exitCode = 1; });

