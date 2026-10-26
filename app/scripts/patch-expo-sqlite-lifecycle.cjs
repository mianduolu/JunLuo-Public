const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Pinned Android-only ownership fix. This does not change SQLite data or JS APIs.
const originalHashes = {
  SQLiteModule: 'd4197a3729f96c0550698f15b12508dc4b9f83704a59be1ccb965579b8d64b4b',
  NativeDatabase: 'c8b6cfb05ce487bc3e873084ffd36f3410423cbc00a4c41ba8516ec87af96917',
  NativeStatement: 'fcc068f284672d9d9dd0829443dba077f4d19cc6e80ce6f2bcdc4a80d3f47cf0',
  NativeSession: '37f9cf047577e41aee258e6bedb2d407f0df2e5775f31c30621c718a8071d8b9',
};
const legacySQLiteModuleHash = '533eb9f33c4726a81920760ed90fbb53a97e9c456d70b47582ae5436b0548a3d';
const patchedHashes = {
  SQLiteModule: '315a5cf198de737ed8e14570cda6e4adb59a6f820dcbe08e98f2f81ffb92021a',
  NativeDatabase: '79bae94b92f77c3238a12364d714e5f7e9a1895822eca463d82b9221dd143040',
  NativeStatement: '052a18b94ea675318714da8cdf5830e37c1ff48ff14f88cc996be0ff55fce6ac',
  NativeSession: '189eafcbdb484afa47ad607c1a7d44489304f41d9bcd9844300eaaea06b38e11',
};
const hash = source => createHash('sha256').update(source).digest('hex');
function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('expo-sqlite patch anchor changed: ' + before.slice(0, 90));
  return source.replace(before, after);
}
function allowConcurrentEmptyStatementConstruction(source) {
  // No database or owner exists yet; prepare still registers it exclusively.
  const before = '    Class(NativeStatement::class) {\n      Constructor {\n        withExclusiveLifecycle {';
  return once(source, before, before.replace('withExclusiveLifecycle', 'withOpenLifecycle'));
}
function transform(name, source) {
  if (name === 'NativeDatabase') {
    source = once(source, '  var isClosed = false', `  var isClosed = false
  val statements = mutableSetOf<NativeStatement>()
  val sessions = mutableSetOf<NativeSession>()`);
    return once(source, '    this.ref.close()', `    // The module cache owns this connection. A released JS wrapper can have
    // live siblings; explicit final close or module teardown releases the JNI ref.`);
  }
  if (name === 'NativeStatement' || name === 'NativeSession') {
    const statement = name === 'NativeStatement';
    source = once(source, 'import expo.modules.kotlin.sharedobjects.SharedRef', `import expo.modules.kotlin.sharedobjects.SharedRef
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.write`);
    source = once(source, `internal class ${name} :`, `internal class ${name}(private val lifecycleLock: ReentrantReadWriteLock) :`);
    const fields = `
  var owner: NativeDatabase? = null
${statement ? '' : '  var isClosed = false\n'}
  // Called with the owning module's exclusive lifecycle lock held.
  fun ${statement ? 'finalizeNative(): Int' : 'closeNative()'} {
${statement ? `    val result = ref.sqlite3_finalize()
    // sqlite3_finalize destroys the statement even when it returns an earlier
    // evaluation error. Never expose the freed pointer for a second finalize.
    isFinalized = true
    owner?.statements?.remove(this)
    owner = null
    return result` : `    ref.sqlite3session_delete()
    isClosed = true
    owner?.sessions?.remove(this)
    owner = null`}
  }
`;
    source = once(source, '\n  override fun sharedObjectDidRelease()', fields + '\n  override fun sharedObjectDidRelease()');
    return once(source, '    this.ref.close()', `    lifecycleLock.write {
      if (owner != null && !${statement ? 'isFinalized' : 'isClosed'}) {
        ${statement ? 'finalizeNative()' : 'closeNative()'}
      }
      ${statement ? 'isFinalized' : 'isClosed'} = true
      ref.close()
    }`);
  }
  source = once(source, 'import android.content.Context', `import android.content.Context
import android.util.Log
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write`);
  source = once(source, '  private var hasListeners = false', `  private var hasListeners = false
  private val lifecycleLock = ReentrantReadWriteLock(true)
  private var isDestroyed = false

  private inline fun <T> withOpenLifecycle(action: () -> T): T = lifecycleLock.read {
    if (isDestroyed) throw AccessClosedResourceException()
    action()
  }

  private inline fun <T> withExclusiveLifecycle(action: () -> T): T = lifecycleLock.write {
    if (isDestroyed) throw AccessClosedResourceException()
    action()
  }`);
  source = once(source, `    OnDestroy {
      try {
        removeAllCachedDatabases().forEach {
          closeDatabase(it)
        }
      } catch (_: Throwable) {}
    }`, `    OnDestroy {
      lifecycleLock.write {
        isDestroyed = true
        removeAllCachedDatabases().forEach { database ->
          try {
            closeDatabase(database, forceFinalize = true)
          } catch (error: Exception) {
            // One bad handle must not prevent other files from releasing locks.
            Log.w(TAG, "Database teardown failed: " + error.message)
            addCachedDatabase(database)
          }
        }
      }
    }`);
  source = source.replaceAll('NativeStatement()', 'NativeStatement(lifecycleLock)')
    .replaceAll('NativeSession()', 'NativeSession(lifecycleLock)');
  const closeBody = `        if (db != null) {
          closeDatabase(db)
        }`;
  if (source.split(closeBody).length !== 3) throw Error('close entry points changed');
  source = source.replaceAll(closeBody, `        if (db != null) {
          try {
            closeDatabase(db)
          } catch (error: Exception) {
            // SQLITE_BUSY leaves the handle open. Preserve ownership for retry.
            db.addRef()
            addCachedDatabase(db)
            throw error
          }
        }`);
  source = once(source, '    val databases = cachedDatabases\n', '    val databases = cachedDatabases.toList()\n');
  source = once(source, `  private fun closeDatabase(database: NativeDatabase) {
    maybeFinalizeAllStatements(database)`, `  private fun closeDatabase(database: NativeDatabase, forceFinalize: Boolean = false) {
    maybeFinalizeAllStatements(database, forceFinalize)
    database.sessions.toList().forEach { it.closeNative() }`);
  source = once(source, '    database.isClosed = true\n', '    database.isClosed = true\n    database.ref.close()\n');
  source = once(source, `  private fun maybeFinalizeAllStatements(database: NativeDatabase) {
    if (!database.openOptions.finalizeUnusedStatementsBeforeClosing) {
      return
    }
    database.ref.sqlite3_finalize_all_statement()
  }`, `  private fun maybeFinalizeAllStatements(database: NativeDatabase, forceFinalize: Boolean = false) {
    if (!forceFinalize && !database.openOptions.finalizeUnusedStatementsBeforeClosing) {
      return
    }
    // sqlite3_next_stmt also returns FTS's private statements: never sweep those.
    database.statements.toList().forEach { statement ->
      val result = statement.finalizeNative()
      if (result != NativeDatabaseBinding.SQLITE_OK) {
        Log.w(TAG, "Statement teardown returned SQLite error " + result)
      }
    }
  }`);
  source = once(source, `    if (database.ref.sqlite3_prepare_v2(source, statement.ref) != NativeDatabaseBinding.SQLITE_OK) {
      throw SQLiteErrorException(database.ref.convertSqlLiteErrorToString())
    }`, `    if (statement.owner != null) throw InvalidArgumentsException("Statement already prepared")
    if (database.ref.sqlite3_prepare_v2(source, statement.ref) != NativeDatabaseBinding.SQLITE_OK) {
      throw SQLiteErrorException(database.ref.convertSqlLiteErrorToString())
    }
    statement.owner = database
    database.statements.add(statement)`);
  source = once(source, '    if (statement.ref.sqlite3_finalize() != NativeDatabaseBinding.SQLITE_OK) {',
    '    if (statement.finalizeNative() != NativeDatabaseBinding.SQLITE_OK) {');
  source = once(source, '    statement.isFinalized = true\n', '');
  source = once(source, `    if (session.ref.sqlite3session_create(database.ref, dbName) != NativeDatabaseBinding.SQLITE_OK) {
      throw SQLiteErrorException(database.ref.convertSqlLiteErrorToString())
    }`, `    maybeThrowForClosedSession(session)
    if (session.owner != null) throw InvalidArgumentsException("Session already created")
    if (session.ref.sqlite3session_create(database.ref, dbName) != NativeDatabaseBinding.SQLITE_OK) {
      throw SQLiteErrorException(database.ref.convertSqlLiteErrorToString())
    }
    session.owner = database
    database.sessions.add(session)`);
  source = once(source, '    session.ref.sqlite3session_delete()', '    session.closeNative()');
  // Every session operation, including close, rejects a previously freed handle.
  source = source.replace(/(  private fun session(?!Create\()[^(]+\([^\n]+\{\n    maybeThrowForClosedDatabase\(database\)\n)/g,
    '$1    maybeThrowForClosedSession(session)\n');
  source = once(source, '  // region Session Extension', `  private fun maybeThrowForClosedSession(session: NativeSession) {
    if (session.isClosed) throw AccessClosedResourceException()
  }

  // region Session Extension`);
  // Keep ordinary calls concurrent, but exclude close/finalize/GC/teardown while
  // any JNI call is running. Constructors/cache ownership changes are exclusive.
  let entryCount = 0;
  source = source.replace(/^( +)((?:AsyncFunction|Function)\("([^"]+)"\)|Constructor) \{([^\n]*)([\s\S]*?)^\1\}/gm,
    (_, indent, dsl, operation, args, body) => {
      entryCount++;
      const exclusive = !operation || /^(close|finalize|prepare|createSession|deleteDatabase|importAssetDatabase)/.test(operation);
      const gate = exclusive ? 'withExclusiveLifecycle' : 'withOpenLifecycle';
      return `${indent}${dsl} {${args}\n${indent}  ${gate} {${body.replace(/\n(?!\n|$)/g, '\n  ')}${indent}  }\n${indent}}`;
    });
  if (entryCount !== 53) throw Error('Unexpected SQLite entry point count: ' + entryCount);
  return allowConcurrentEmptyStatementConstruction(source);
}
function patchSource(name, input) {
  const source = input.replace(/\r\n/g, '\n');
  const current = hash(source);
  if (current === patchedHashes[name]) return source;
  if (name === 'SQLiteModule' && current === legacySQLiteModuleHash) return allowConcurrentEmptyStatementConstruction(source);
  if (current !== originalHashes[name]) throw Error('Unexpected expo-sqlite 16.0.10 source: ' + name);
  return transform(name, source);
}

function main() {
  const app = path.resolve(__dirname, '..');
  const root = path.join(app, 'node_modules/expo-sqlite');
  // Candidates can share node_modules with the running app. Never patch across
  // such a junction: validate transformations in memory via the offline eval.
  if (!fs.realpathSync(root).toLowerCase().startsWith(fs.realpathSync(app).toLowerCase() + path.sep)) {
    throw Error('Refusing to patch dependencies outside this app (shared node_modules)');
  }
  if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== '16.0.10') {
    throw Error('expo-sqlite version changed; lifecycle patch needs review');
  }
  const directory = path.join(root, 'android/src/main/java/expo/modules/sqlite');
  // Validate all targets before the first write.
  const changes = Object.keys(originalHashes).map(name => {
    const file = path.join(directory, name + '.kt');
    const original = fs.readFileSync(file, 'utf8');
    return { file, original, updated: patchSource(name, original) };
  });
  for (const { file, original, updated } of changes) {
    if (original.replace(/\r\n/g, '\n') !== updated) fs.writeFileSync(file, updated);
  }
  console.log('expo-sqlite Android lifecycle patch verified');
}
module.exports = { patchSource };
if (require.main === module) main();
