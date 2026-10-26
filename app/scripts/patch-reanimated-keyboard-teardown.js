const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-reanimated',
  'android',
  'src',
  'main',
  'cpp',
  'reanimated',
  'android',
  'NativeProxy.cpp',
);

const nativeProxyHeaderTarget = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-reanimated',
  'android',
  'src',
  'main',
  'cpp',
  'reanimated',
  'android',
  'NativeProxy.h',
);

const keyboardHookTarget = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-reanimated',
  'src',
  'hook',
  'useAnimatedKeyboard.ts',
);

const reanimatedModuleTarget = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-reanimated',
  'android',
  'src',
  'main',
  'java',
  'com',
  'swmansion',
  'reanimated',
  'ReanimatedModule.java',
);

const reanimatedGradleTarget = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native-reanimated',
  'android',
  'build.gradle',
);

const subscribeBefore = [
  'int NativeProxy::subscribeForKeyboardEvents(',
  '    std::function<void(int, int)> callback,',
  '    bool isStatusBarTranslucent,',
  '    bool isNavigationBarTranslucent) {',
  '  static const auto method =',
  '      getJniMethod<int(KeyboardWorkletWrapper::javaobject, bool, bool)>(',
  '          "subscribeForKeyboardEvents");',
  '  return method(',
  '      javaPart_.get(),',
  '      KeyboardWorkletWrapper::newObjectCxxArgs(std::move(callback)).get(),',
  '      isStatusBarTranslucent,',
  '      isNavigationBarTranslucent);',
  '}',
].join('\n');

const subscribeAfter = [
  'int NativeProxy::subscribeForKeyboardEvents(',
  '    std::function<void(int, int)> callback,',
  '    bool isStatusBarTranslucent,',
  '    bool isNavigationBarTranslucent) {',
  '  // A queued remount can run after the Java side has been invalidated.',
  '  if (!javaPart_) {',
  '    return -1;',
  '  }',
  '',
  '  static const auto method =',
  '      getJniMethod<int(KeyboardWorkletWrapper::javaobject, bool, bool)>(',
  '          "subscribeForKeyboardEvents");',
  '  return method(',
  '      javaPart_.get(),',
  '      KeyboardWorkletWrapper::newObjectCxxArgs(std::move(callback)).get(),',
  '      isStatusBarTranslucent,',
  '      isNavigationBarTranslucent);',
  '}',
].join('\n');

const unsubscribeBefore = [
  'void NativeProxy::unsubscribeFromKeyboardEvents(int listenerId) {',
  '  static const auto method =',
  '      getJniMethod<void(int)>("unsubscribeFromKeyboardEvents");',
  '  method(javaPart_.get(), listenerId);',
  '}',
].join('\n');

const unsubscribeAfter = [
  'void NativeProxy::unsubscribeFromKeyboardEvents(int listenerId) {',
  '  // The queued cleanup can run after the Java side has been invalidated.',
  '  if (!javaPart_) {',
  '    return;',
  '  }',
  '',
  '  static const auto method =',
  '      getJniMethod<void(int)>("unsubscribeFromKeyboardEvents");',
  '  method(javaPart_.get(), listenerId);',
  '}',
].join('\n');

const requestRenderBefore = [
  'void NativeProxy::requestRender(std::function<void(double)> onRender) {',
  '  static const auto method =',
  '      getJniMethod<void(AnimationFrameCallback::javaobject)>("requestRender");',
  '  method(',
  '      javaPart_.get(),',
  '      AnimationFrameCallback::newObjectCxxArgs(std::move(onRender)).get());',
  '}',
].join('\n');

const requestRenderAfter = [
  'void NativeProxy::requestRender(std::function<void(double)> onRender) {',
  '  std::lock_guard<std::mutex> lock(renderLifecycleMutex_);',
  '  // A frame already queued before reload can arrive after teardown starts.',
  '  if (renderInvalidating_ || !javaPart_) {',
  '    return;',
  '  }',
  '',
  '  static const auto method =',
  '      getJniMethod<void(AnimationFrameCallback::javaobject)>("requestRender");',
  '  method(',
  '      javaPart_.get(),',
  '      AnimationFrameCallback::newObjectCxxArgs(std::move(onRender)).get());',
  '}',
].join('\n');

const invalidateCppBefore = [
  'void NativeProxy::invalidateCpp() {',
  '  (*layoutAnimations_)->cthis()->invalidate();',
  '  // cleanup all animated sensors here, since the next line resets',
  '  // the pointer and it will be too late after it',
  '  reanimatedModuleProxy_->cleanupSensors();',
  '  reanimatedModuleProxy_.reset();',
  '  javaPart_ = nullptr;',
  '}',
].join('\n');

const invalidateCppAfter = [
  'void NativeProxy::invalidateCpp() {',
  '  {',
  '    std::lock_guard<std::mutex> lock(renderLifecycleMutex_);',
  '    renderInvalidating_ = true;',
  '  }',
  '',
  '  (*layoutAnimations_)->cthis()->invalidate();',
  '  // cleanup all animated sensors here, since the next line resets',
  '  // the pointer and it will be too late after it',
  '  reanimatedModuleProxy_->cleanupSensors();',
  '  reanimatedModuleProxy_.reset();',
  '  {',
  '    std::lock_guard<std::mutex> lock(renderLifecycleMutex_);',
  '    javaPart_ = nullptr;',
  '  }',
  '}',
].join('\n');

let source = fs.readFileSync(target, 'utf8');
let changed = false;

function applyGuard(label, before, after) {
  if (source.includes(after)) {
    return;
  }

  const matches = source.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(
      'Expected one Reanimated ' + label + ' block, found ' + matches + '.',
    );
  }

  source = source.replace(before, after);
  changed = true;
}

applyGuard('subscription', subscribeBefore, subscribeAfter);
applyGuard('teardown', unsubscribeBefore, unsubscribeAfter);
applyGuard('render request', requestRenderBefore, requestRenderAfter);
applyGuard('native invalidation', invalidateCppBefore, invalidateCppAfter);

const nativeProxyHeaderIncludeBefore = '#include <memory>\n#include <string>';
const nativeProxyHeaderIncludeAfter =
  '#include <memory>\n#include <mutex>\n#include <string>';
const nativeProxyHeaderLifecycleBefore = [
  '  jni::global_ref<NativeProxy::javaobject> javaPart_;',
  '  jsi::Runtime *rnRuntime_;',
].join('\n');
const nativeProxyHeaderLifecycleAfter = [
  '  jni::global_ref<NativeProxy::javaobject> javaPart_;',
  '  std::mutex renderLifecycleMutex_;',
  '  bool renderInvalidating_{false};',
  '  jsi::Runtime *rnRuntime_;',
].join('\n');

let nativeProxyHeaderSource = fs.readFileSync(nativeProxyHeaderTarget, 'utf8');
let nativeProxyHeaderChanged = false;

function applyNativeProxyHeaderChange(label, before, after) {
  if (nativeProxyHeaderSource.includes(after)) {
    return;
  }

  const matches = nativeProxyHeaderSource.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(
      'Expected one Reanimated native proxy header ' +
        label +
        ' block, found ' +
        matches +
        '.',
    );
  }

  nativeProxyHeaderSource = nativeProxyHeaderSource.replace(before, after);
  nativeProxyHeaderChanged = true;
}

applyNativeProxyHeaderChange(
  'include',
  nativeProxyHeaderIncludeBefore,
  nativeProxyHeaderIncludeAfter,
);
applyNativeProxyHeaderChange(
  'lifecycle',
  nativeProxyHeaderLifecycleBefore,
  nativeProxyHeaderLifecycleAfter,
);

if (nativeProxyHeaderChanged) {
  fs.writeFileSync(nativeProxyHeaderTarget, nativeProxyHeaderSource);
  changed = true;
}

const invalidateBefore = [
  '  public void invalidate() {',
  '    super.invalidate();',
  '',
  '    if (mNodesManager != null) {',
].join('\n');

const invalidateAfter = [
  '  public void invalidate() {',
  '    super.invalidate();',
  '',
  '    // Drain the UI runtime before NativeProxy releases its Java references.',
  '    // React Native does not guarantee module invalidation order during reloads.',
  '    mWorkletsModule.invalidate();',
  '',
  '    if (mNodesManager != null) {',
].join('\n');

let reanimatedModuleSource = fs.readFileSync(reanimatedModuleTarget, 'utf8');
if (!reanimatedModuleSource.includes(invalidateAfter)) {
  const matches = reanimatedModuleSource.split(invalidateBefore).length - 1;
  if (matches !== 1) {
    throw new Error(
      'Expected one Reanimated module invalidation block, found ' + matches + '.',
    );
  }
  reanimatedModuleSource = reanimatedModuleSource.replace(
    invalidateBefore,
    invalidateAfter,
  );
  fs.writeFileSync(reanimatedModuleTarget, reanimatedModuleSource);
  changed = true;
}

const codegenSourceSetBefore = [
  '            if (IS_NEW_ARCHITECTURE_ENABLED) {',
  '                srcDirs += "src/fabric/java"',
  '            } else {',
].join('\n');

const codegenSourceSetAfter = [
  '            if (IS_NEW_ARCHITECTURE_ENABLED) {',
  '                srcDirs += "src/fabric/java"',
  '                srcDirs += "$buildDir/generated/source/codegen/java"',
  '            } else {',
].join('\n');

let reanimatedGradleSource = fs.readFileSync(reanimatedGradleTarget, 'utf8');
if (!reanimatedGradleSource.includes(codegenSourceSetAfter)) {
  const matches = reanimatedGradleSource.split(codegenSourceSetBefore).length - 1;
  if (matches !== 1) {
    throw new Error(
      'Expected one Reanimated new architecture source set block, found ' +
        matches +
        '.',
    );
  }
  reanimatedGradleSource = reanimatedGradleSource.replace(
    codegenSourceSetBefore,
    codegenSourceSetAfter,
  );
  fs.writeFileSync(reanimatedGradleTarget, reanimatedGradleSource);
  changed = true;
}

const keyboardHookInitializationBefore = [
  '  if (ref.current === null) {',
  '    const keyboardEventData: AnimatedKeyboardInfo = {',
  '      state: makeMutable<KeyboardState>(KeyboardState.UNKNOWN),',
  '      height: makeMutable(0),',
  '    };',
  '    listenerId.current = subscribeForKeyboardEvents((state, height) => {',
  "      'worklet';",
  '      keyboardEventData.state.value = state;',
  '      keyboardEventData.height.value = height;',
  '    }, options);',
  '    ref.current = keyboardEventData;',
  '    isSubscribed.current = true;',
  '  }',
].join('\n');

const keyboardHookInitializationAfter = [
  '  if (ref.current === null) {',
  '    ref.current = {',
  '      state: makeMutable<KeyboardState>(KeyboardState.UNKNOWN),',
  '      height: makeMutable(0),',
  '    };',
  '  }',
].join('\n');

const keyboardHookEffectBefore = [
  '  useEffect(() => {',
  '    if (isSubscribed.current === false && ref.current !== null) {',
  '      const keyboardEventData = ref.current;',
  '      // subscribe again after Fast Refresh',
  '      listenerId.current = subscribeForKeyboardEvents((state, height) => {',
  "        'worklet';",
  '        keyboardEventData.state.value = state;',
  '        keyboardEventData.height.value = height;',
  '      }, options);',
  '      isSubscribed.current = true;',
  '    }',
  '    return () => {',
  '      unsubscribeFromKeyboardEvents(listenerId.current);',
  '      isSubscribed.current = false;',
  '    };',
  '  }, []);',
].join('\n');

const keyboardHookEffectAfter = [
  '  useEffect(() => {',
  '    let retryTimer: ReturnType<typeof setTimeout> | null = null;',
  '    let retryAttempts = 0;',
  '',
  '    const subscribe = () => {',
  '      if (isSubscribed.current || ref.current === null) return;',
  '      const keyboardEventData = ref.current;',
  '      listenerId.current = subscribeForKeyboardEvents((state, height) => {',
  "        'worklet';",
  '        keyboardEventData.state.value = state;',
  '        keyboardEventData.height.value = height;',
  '      }, options);',
  '      isSubscribed.current = listenerId.current >= 0;',
  '      if (!isSubscribed.current && retryAttempts < 40) {',
  '        retryAttempts += 1;',
  '        retryTimer = setTimeout(subscribe, 50);',
  '      }',
  '    };',
  '',
  '    subscribe();',
  '    return () => {',
  '      if (retryTimer !== null) {',
  '        clearTimeout(retryTimer);',
  '      }',
  '      if (listenerId.current >= 0) {',
  '        unsubscribeFromKeyboardEvents(listenerId.current);',
  '      }',
  '      listenerId.current = -1;',
  '      isSubscribed.current = false;',
  '    };',
  '  }, []);',
].join('\n');

let keyboardHookSource = fs.readFileSync(keyboardHookTarget, 'utf8');
let keyboardHookChanged = false;

function applyKeyboardHookChange(label, before, after) {
  if (keyboardHookSource.includes(after)) {
    return;
  }

  const matches = keyboardHookSource.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(
      'Expected one Reanimated keyboard hook ' + label + ' block, found ' + matches + '.',
    );
  }

  keyboardHookSource = keyboardHookSource.replace(before, after);
  keyboardHookChanged = true;
}

applyKeyboardHookChange(
  'initialization',
  keyboardHookInitializationBefore,
  keyboardHookInitializationAfter,
);
applyKeyboardHookChange('effect', keyboardHookEffectBefore, keyboardHookEffectAfter);

if (keyboardHookChanged) {
  fs.writeFileSync(keyboardHookTarget, keyboardHookSource);
  changed = true;
}

if (!changed) {
  console.log('Reanimated reload lifecycle guards are already applied.');
  process.exit(0);
}

fs.writeFileSync(target, source);
console.log('Applied Reanimated reload lifecycle guards.');
