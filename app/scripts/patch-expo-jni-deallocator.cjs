const fs = require('node:fs');
const path = require('node:path');

// Backport Expo #42441 to 3.0.30 without upgrading the SDK or its C++ runtime.
const app = path.resolve(__dirname, '..');
const root = 'node_modules/expo-modules-core/android/src/main/java/expo/modules/kotlin/jni';
const wrappers = ['JavaCallback.kt', 'JavaScriptFunction.kt', 'JavaScriptModuleObject.kt',
  'JavaScriptObject.kt', 'JavaScriptValue.kt', 'JavaScriptWeakObject.kt',
  'decorators/JSDecoratorsBridgingObject.kt', 'JSIContext.kt'];
const files = ['JNIDeallocator.kt', ...wrappers];

function replaceOnce(source, before, after) {
  if (source.includes(after)) {
    if (source.split(after).length !== 2) throw new Error('Duplicate Expo JNI patch block.');
    return source;
  }
  if (source.split(before).length !== 2) throw new Error('Expo JNI source changed; review the patch.');
  return source.replace(before, after);
}

function patchSource(file, source) {
  source = source.replace(/\r\n/g, '\n');
  if (file !== 'JNIDeallocator.kt') {
    if (!wrappers.includes(file)) throw new Error('Unknown Expo JNI wrapper.');
    // Keep the existing public deallocate method for SDK 54 callers and finalizers.
    return replaceOnce(source,
      '  override fun deallocate() {\n    mHybridData.resetNative()\n  }',
      '  override fun getHybridDataForJNIDeallocator(): HybridData = mHybridData\n\n'
        + '  fun deallocate() {\n    mHybridData.resetNative()\n  }');
  }
  const replacements = [
    ['import java.lang.ref.WeakReference', 'import com.facebook.jni.HybridData'],
    ['interface Destructible {\n  fun deallocate()\n}',
      'interface Destructible {\n  fun getHybridDataForJNIDeallocator(): HybridData\n}'],
    ['  private val destructorMap = mutableMapOf<PhantomReference<Destructible>, WeakReference<Destructible>>()',
      '  private val destructorMap = mutableMapOf<PhantomReference<Destructible>, HybridData>()\n'
        + '  private var wasDeallocated = false'],
    ['    val weakRef = WeakReference(destructible)\n    val phantomRef = PhantomReference(destructible, referenceQueue)\n    destructorMap[phantomRef] = weakRef',
      '    val hybridData = destructible.getHybridDataForJNIDeallocator()\n'
        + '    if (wasDeallocated) {\n      hybridData.resetNative()\n      return\n    }\n'
        + '    val phantomRef = PhantomReference(destructible, referenceQueue)\n'
        + '    destructorMap[phantomRef] = hybridData'],
    ['  internal fun deallocate() = synchronized(this) {\n    destructorMap.values.forEach {\n      it.get()?.deallocate()\n    }',
      '  internal fun deallocate() = synchronized(this) {\n    wasDeallocated = true\n'
        + '    destructorMap.values.forEach {\n      it.resetNative()\n    }'],
    ['    destructorMap.values.mapNotNull { it.get() }',
      '    destructorMap.values.filter { synchronized(it) { it.isValid } }'],
    ['        // Referent of PhantomReference were garbage collected so we can remove it from our registry.\n'
        + '        // Note that we don\'t have to call `deallocate` method - it was called [com.facebook.jni.HybridData].\n'
        + '        val current = referenceQueue.remove()\n        synchronized(this@JNIDeallocator) {\n'
        + '          destructorMap.remove(current)\n        }',
      '        val current = referenceQueue.remove()\n        synchronized(this@JNIDeallocator) {\n'
        + '          // Finish release under the teardown monitor, even after the wrapper is gone.\n'
        + '          destructorMap.remove(current)?.resetNative()\n        }'],
  ];
  for (const [before, after] of replacements) source = replaceOnce(source, before, after);
  return source;
}

function applyPatch() {
  const version = JSON.parse(fs.readFileSync(path.join(app, 'node_modules/expo-modules-core/package.json'), 'utf8')).version;
  if (version !== '3.0.30') throw new Error(`Review Expo JNI patch for version ${version}.`);
  const edits = files.map(file => {
    const target = path.join(app, root, file);
    const original = fs.readFileSync(target, 'utf8');
    return { target, original, next: patchSource(file, original) };
  });
  let changed = 0;
  for (const { target, original, next } of edits) {
    if (original !== next) { fs.writeFileSync(target, next); changed++; }
  }
  console.log(`Expo JNI deallocator patch: ${changed} files updated.`);
}

module.exports = { root, files, patchSource, applyPatch };
if (require.main === module) applyPatch();
