/* Real letter context, letter store, share resolver and epoch coordinator in RAM. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ts = require('../node_modules/typescript');
const candidate = path.resolve(process.argv[2] || path.join(__dirname, '../src'));
const production = path.resolve(__dirname, '../src');
const ttlCandidate = path.resolve(__dirname, '../src');
const AT = 1_793_181_600_000;
const results = [], loadedFiles = new Set();
let networkRequests = 0;
const letter = (id = 'one', changes = {}) => ({ id, kind: 'exchange', direction: 'ai-to-you',
  status: 'completed', title: 'synthetic title', content: 'synthetic I original', replyContent: 'synthetic you reply',
  createdAt: AT, deliveredAt: AT + 10, completedAt: AT + 100, ...changes });
const share = (id, changes = {}) => ({ id, sessionId: 'chat-main-v1', origin: 'letter', invitationKind: 'self_driven',
  sourceMessageIds: ['letter-one-original'], responseDriveKeys: ['reflection', 'social'], excerpt: 'synthetic original',
  createdAt: AT + 20, state: 'waiting', ...changes });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('RAM operation did not settle')), 1500); })]); }
  finally { clearTimeout(timer); }
}
function fixture(letters = [letter()], shares = [share('pending')]) {
  const cache = new Map();
  let lettersJson = JSON.stringify(letters), sharesJson = JSON.stringify(shares), shareReads = 0, letterReads = 0;
  let shareWrites = 0, letterWrites = 0, registrations = 0;
  let now = AT + 500;
  class ClockDate extends Date { static now() { return now; } }
  const hooks = {};
  const letterBridge = { getItem: async () => { letterReads++; await hooks.letterRead?.(letterReads); return lettersJson; },
    setItem: async (_key, value) => { letterWrites++; lettersJson = value; } };
  const shareBridge = { getItem: async () => { shareReads++; await hooks.shareRead?.(shareReads); return sharesJson; },
    setItem: async (_key, value) => { shareWrites++; sharesJson = value; } };
  function sourceFile(relative) {
    const own = path.join(candidate, relative);
    if (fs.existsSync(own)) return own;
    if (!process.argv[2] && relative === 'ai/behavior/actionShareResponse.ts') {
      const ttl = path.join(ttlCandidate, relative);
      if (fs.existsSync(ttl)) return ttl;
    }
    return path.join(production, relative);
  }
  function load(relative) {
    relative = path.posix.normalize(relative.replaceAll('\\', '/'));
    if (cache.has(relative)) return cache.get(relative).exports;
    const file = sourceFile(relative), module = { exports: {} }; cache.set(relative, module); loadedFiles.add(file);
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
    });
    assert.deepEqual(compiled.diagnostics, []);
    new Function('require', 'module', 'exports', 'fetch', 'Date', compiled.outputText)(name => {
      if (name.endsWith('/syncLettersLifeStorageBridge')) return { lettersLifeStorageBridge: letterBridge };
      if (name.endsWith('/syncProactiveLedgerStorageBridge')) return { proactiveLedgerStorageBridge: shareBridge };
      if (name.endsWith('/letterMemoryIngestion')) return { registerLetterMemoryParts: async (saved, epoch) => {
        registrations++; await hooks.memoryRegistration?.(saved, epoch);
      } };
      if (name.endsWith('/junluoDesireRuntime')) return { noteJunluoYouMessage: async () => undefined };
      assert(name.startsWith('.'), `Unexpected external dependency: ${name}`);
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${name}.ts`)));
    }, module, module.exports, () => { networkRequests++; throw Error('Unexpected network'); }, ClockDate);
    return module.exports;
  }
  return { hooks, context: load('letters/letterContext.ts'), lettersApi: load('letters/letterStore.ts'),
    parts: load('letters/letterMemorySource.ts'), sharesApi: load('ai/behavior/actionShareResponseStore.ts'),
    epoch: load('backup/backupRestoreCoordinator.ts'),
    get shareReads() { return shareReads; }, get letterReads() { return letterReads; },
    get shareWrites() { return shareWrites; }, get letterWrites() { return letterWrites; },
    get registrations() { return registrations; }, letters: () => JSON.parse(lettersJson), shares: () => JSON.parse(sharesJson),
    setLetters(value) { lettersJson = JSON.stringify(value); }, setShares(value) { sharesJson = JSON.stringify(value); },
    time(value) { now = value; } };
}
async function test(name, run) {
  try { await bounded(run()); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, error: String(error.stack) }); }
}
async function main() {
  await test('saved you reply closes only exact original-source waiting shares with the real reply ID and time', async () => {
    const saved = letter(), records = [share('exact'), share('legacy', { origin: 'chat_action' }),
      share('other', { sourceMessageIds: ['letter-other-original'] }),
      share('group', { sourceMessageIds: ['letter-one-original', 'letter-other-original'] }),
      share('web', { origin: 'web_voyage' }), share('reply-source', { sourceMessageIds: ['letter-one-reply'] })];
    const f = fixture([saved], records); await f.context.persistDeliveredLetterContext(saved);
    assert.deepEqual(f.shares().map(r => [r.id, r.state]).sort(), records.map(r => [r.id, ['exact', 'legacy'].includes(r.id) ? 'engaged' : 'waiting']).sort());
    const exact = f.shares().find(r => r.id === 'exact');
    assert.equal(exact.responseMessageId, 'letter-one-reply'); assert.equal(exact.resolvedAt, saved.completedAt);
    assert.equal(f.shareWrites, 1); assert.equal(f.letterWrites, 0); assert.deepEqual(f.letters(), [saved]);
  });
  await test('real replyToAiLetter save precedes context settlement and preserves the original sending time on edits', async () => {
    const incoming = letter('one', { replyContent: undefined, completedAt: undefined, status: 'waiting_user' });
    const f = fixture([incoming]), completed = await f.lettersApi.replyToAiLetter('one', 'synthetic saved you reply');
    assert(completed?.replyContent); assert.equal(f.shareWrites, 0); assert.equal(f.letterWrites, 1);
    await f.context.persistDeliveredLetterContext(completed);
    assert.equal(f.shares()[0].state, 'engaged'); assert.equal(f.shares()[0].resolvedAt, completed.completedAt);
    assert.equal(f.shares()[0].responseMessageId, f.parts.getLetterContextMessageId('one', 'reply'));
    const edited = await f.lettersApi.replyToAiLetter('one', 'synthetic edited you reply');
    assert.equal(edited.completedAt, completed.completedAt);
    await f.context.persistDeliveredLetterContext(edited); assert.equal(f.shareWrites, 1);
  });
  await test('you original and I reply never close an I share by inverse-role confusion', async () => {
    const saved = letter('one', { direction: 'you-to-ai' }), f = fixture([saved]);
    await f.context.persistDeliveredLetterContext(saved);
    assert.equal(f.shareWrites, 0); assert.equal(f.shareReads, 0); assert.equal(f.shares()[0].state, 'waiting');
    assert.deepEqual(f.parts.getLetterMemoryParts(saved).map(p => p.role), ['you', 'I']);
  });
  await test('no reply or unknown reply timestamp cannot manufacture a reply receipt', async () => {
    for (const changes of [{ replyContent: undefined }, { replyContent: '   ' }, { completedAt: undefined }]) {
      const saved = letter('one', changes), f = fixture([saved]); await f.context.persistDeliveredLetterContext(saved);
      assert.equal(f.shares()[0].state, 'waiting');
      assert.equal(f.shares()[0].responseMessageId, undefined);
    }
  });
  await test('future sealed and opened letters keep original behavior and never treat fields as a you reply', async () => {
    for (const openedAt of [undefined, AT + 50]) {
      const saved = letter('one', { kind: 'future-self', direction: 'ai-to-future-you', openedAt, status: openedAt ? 'completed' : 'sealed' });
      const f = fixture([saved]); await f.context.persistOpenedFutureLetterContext(saved);
      assert.equal(f.shareWrites, 0); assert.equal(f.shares()[0].state, 'waiting');
    }
  });
  await test('an opened future original still registers its original share without creating a reply', async () => {
    const saved = letter('one', { kind: 'future-self', direction: 'ai-to-future-you', openedAt: AT + 50,
      status: 'completed', replyContent: undefined, completedAt: undefined }), f = fixture([saved], []);
    await f.context.persistOpenedFutureLetterContext(saved);
    assert.equal(f.shareWrites, 1); assert.equal(f.shares().length, 1);
    assert.equal(f.shares()[0].state, 'waiting'); assert.deepEqual(f.shares()[0].sourceMessageIds, ['letter-one-original']);
    assert.equal(f.shares()[0].responseMessageId, undefined);
  });
  await test('existing terminal states and their original response receipt are never reopened or re-signed', async () => {
    for (const state of ['engaged', 'declined', 'unanswered']) {
      const record = share('ended', { state, resolvedAt: AT + 5, responseMessageId: 'old-you' }), f = fixture([letter()], [record]);
      await f.context.persistDeliveredLetterContext(letter());
      assert.equal(f.shareWrites, 0); assert.deepEqual(f.shares(), [record]);
    }
  });
  await test('deleted or unsaved caller payload cannot settle or restore the original letter', async () => {
    const f = fixture([]); await f.context.persistDeliveredLetterContext(letter());
    assert.equal(f.shareWrites, 0); assert.equal(f.registrations, 0); assert.deepEqual(f.letters(), []);
  });
  await test('matching source IDs work across old session names without touching unrelated shares', async () => {
    const records = [share('exact-old-session', { sessionId: 'old-source-session' }), share('unrelated', { sessionId: 'other', sourceMessageIds: ['real-other'] })];
    const f = fixture([letter()], records); await f.context.persistDeliveredLetterContext(letter());
    assert.equal(f.shares().find(r => r.id === 'exact-old-session').state, 'engaged');
    assert.equal(f.shares().find(r => r.id === 'unrelated').state, 'waiting');
  });
  await test('epoch invalid before entry or during memory registration never settles the ledger', async () => {
    const first = fixture(); first.epoch.markBackupRestoreRestoring('synthetic');
    assert.equal(await first.context.persistDeliveredLetterContext(letter()), null); assert.equal(first.shareWrites, 0);
    const second = fixture(); second.hooks.memoryRegistration = async () => second.epoch.markBackupRestoreRestoring('synthetic');
    await assert.rejects(second.context.persistDeliveredLetterContext(letter()), /restore-changed/); assert.equal(second.shareWrites, 0);
  });
  await test('original or reply edits and deletion during share lookup refuse the stale settlement', async () => {
    for (const replace of [() => [], () => [letter('one', { content: 'edited original' })], () => [letter('one', { replyContent: 'edited reply' })],
      () => [letter('one', { completedAt: AT + 999 })], () => [letter('one', { direction: 'you-to-ai' })]]) {
      const f = fixture(); f.hooks.shareRead = async count => { if (count === 1) f.setLetters(replace()); };
      await f.context.persistDeliveredLetterContext(letter()); assert.equal(f.shareWrites, 0); assert.equal(f.shares()[0].state, 'waiting');
    }
  });
  await test('resolver checks a queued source again after an earlier share mutation releases', async () => {
    const f = fixture(), headEntered = deferred(), releaseHead = deferred(), queryRead = deferred();
    f.hooks.shareRead = async count => { if (count === 1) { headEntered.resolve(); await releaseHead.promise; }
      if (count === 2) queryRead.resolve(); };
    const earlier = f.sharesApi.registerBaiyunPendingShareExchange({ sessionId: 's', origin: 'social_share',
      invitationKind: 'you_invited', sourceMessageIds: ['independent-source'], responseDriveKeys: [], excerpt: 'synthetic' });
    await headEntered.promise;
    const context = f.context.persistDeliveredLetterContext(letter()); await queryRead.promise;
    f.setLetters([]); releaseHead.resolve(); await earlier; await context;
    assert.equal(f.shareWrites, 1); assert.equal(f.shares().find(r => r.id === 'pending').state, 'waiting');
  });
  await test('resolver write-side source guard refuses changes during its own raw ledger read', async () => {
    const f = fixture(); f.hooks.shareRead = async count => { if (count === 2) f.setLetters([letter('one', { replyContent: 'changed during resolver read' })]); };
    await f.context.persistDeliveredLetterContext(letter());
    assert.equal(f.shareWrites, 0); assert.equal(f.shares()[0].state, 'waiting');
  });
  await test('epoch changes while share work waits do not leak through the optional commit callback', async () => {
    const f = fixture(); f.hooks.shareRead = async count => { if (count === 2) f.epoch.markBackupRestoreRestoring('synthetic'); };
    await f.context.persistDeliveredLetterContext(letter()); assert.equal(f.shareWrites, 0); assert.equal(f.shares()[0].state, 'waiting');
  });
  await test('nested original epoch leases and same-letter retries settle without self-wait or duplicate writes', async () => {
    const f = fixture(), epoch = f.epoch.captureBackupRestoreDataEpoch();
    const result = await f.epoch.runBackupRestoreDataEpochCommit(epoch, () => Promise.all([
      f.context.persistDeliveredLetterContext(letter(), { dataEpoch: epoch }),
      f.context.persistDeliveredLetterContext(letter(), { dataEpoch: epoch }),
    ]));
    assert.equal(result.committed, true); assert.equal(f.shareWrites, 1); assert.equal(f.shares()[0].state, 'engaged');
    await f.context.persistDeliveredLetterContext(letter(), { dataEpoch: epoch }); assert.equal(f.shareWrites, 1);
  });
  await test('independent memory registration failure does not erase the saved reply or duplicate later settlement', async () => {
    const f = fixture(); f.hooks.memoryRegistration = async () => { throw Error('synthetic registration failure'); };
    await assert.rejects(f.context.persistDeliveredLetterContext(letter()), /synthetic registration failure/);
    assert.equal(f.shares()[0].state, 'engaged'); assert.deepEqual(f.letters(), [letter()]);
    f.hooks.memoryRegistration = undefined; await f.context.persistDeliveredLetterContext(letter()); assert.equal(f.shareWrites, 1);
  });
  await test('old waiting resolved from a real earlier saved reply uses that earlier time, not recovery time', async () => {
    const saved = letter('one', { completedAt: AT + 200 }), f = fixture([saved]);
    f.time(AT + 9 * 86_400_000);
    await f.context.recoverLetterContexts(f.epoch.captureBackupRestoreDataEpoch());
    assert.equal(f.shares()[0].resolvedAt, AT + 200); assert.equal(f.shares()[0].responseMessageId, 'letter-one-reply');
  });
  await test('resolver callers without the optional source guard keep original successful behavior', async () => {
    const f = fixture(); const resolved = await f.sharesApi.resolveBaiyunPendingShareResponses({
      responses: [{ pendingShareId: 'pending', state: 'engaged' }], responseMessageId: 'real-you', sessionId: 'chat-main-v1', now: AT + 100 });
    assert.equal(resolved.length, 1); assert.equal(f.shareWrites, 1);
  });
  await test('an optional guard refusing at queue entry does not read or write the share ledger', async () => {
    const f = fixture(); const result = await f.sharesApi.resolveBaiyunPendingShareResponses({
      responses: [{ pendingShareId: 'pending', state: 'engaged' }], responseMessageId: 'you', sessionId: 's', canCommit: async () => false });
    assert.deepEqual(result, []); assert.equal(f.shareReads, 0); assert.equal(f.shareWrites, 0);
  });
  assert.equal(networkRequests, 0);
  const failed = results.filter(row => !row.pass);
  console.log(JSON.stringify({ passed: results.length - failed.length, total: results.length, results,
    loadedFiles: [...loadedFiles], networkRequests, modelRequests: 0, deviceOperations: 0, realStorageWrites: 0 }, null, 2));
  if (failed.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
