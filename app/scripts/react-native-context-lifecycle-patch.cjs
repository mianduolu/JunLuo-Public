// Pure source transform for RN 0.81.5, including the installed post-build loader cleanup.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

function patchReactInstanceManager(input) {
  let source = input.replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(source).digest('hex'),
    'd9ccdafeb3a8a5fab6de7bb852cb58f4f1545b4829fad90cca9c17cf96271a08', 'RN 0.81.5 source drift');
  const replace = (before, after) => {
    assert.equal(source.split(before).length, 2, `RN lifecycle anchor drift: ${before}`);
    source = source.replace(before, after);
  };
  replace('  private volatile @Nullable Thread mCreateReactContextThread;',
    '  private volatile @Nullable Thread mCreateReactContextThread;\n' +
    '  private volatile long mReactContextGeneration;\n  private volatile boolean mReactContextCleanupFailed;');
  replace('  private volatile Boolean mHasStartedDestroying = false;',
    '  private volatile Boolean mHasStartedDestroying = false;\n' +
    '  private final Object mReactContextDestroyLock = new Object();');
  replace('synchronized (ReactInstanceManager.this.mHasStartedDestroying)',
    'synchronized (ReactInstanceManager.this.mReactContextDestroyLock)');
  replace('ReactInstanceManager.this.mHasStartedDestroying.wait();',
    'ReactInstanceManager.this.mReactContextDestroyLock.wait();');
  replace('synchronized (mHasStartedDestroying)', 'synchronized (mReactContextDestroyLock)');
  replace('mHasStartedDestroying.notifyAll();', 'mReactContextDestroyLock.notifyAll();');
  replace('    mCreateReactContextThread = null;\n    synchronized (mAttachedReactRoots) {',
    '    mPendingReactContextInitParams = null;\n    synchronized (mAttachedReactRoots) {\n      mReactContextGeneration++;');
  replace('            if (reactRoot.getUIManagerType() == UIManagerType.FABRIC) {\n' +
    '              detachRootViewFromInstance(reactRoot, mCurrentReactContext);\n            }',
    '            if (reactRoot.getUIManagerType() == UIManagerType.FABRIC) {\n' +
    '              detachRootViewFromInstance(reactRoot, mCurrentReactContext);\n' +
    '            } else {\n              clearReactRoot(reactRoot);\n            }');
  replace('    if (mInstanceManagerInvalidated) {\n      if (mInspectorTarget != null) {',
    '    if (mInstanceManagerInvalidated && mCreateReactContextThread == null) {\n      if (mInspectorTarget != null) {');
  replace('      if (mCreateReactContextThread == null && currentContext != null) {',
    '      if (currentContext != null) {');
  replace('    mCreateReactContextThread =\n        new Thread(',
    '    final long creationGeneration = mReactContextGeneration;\n' +
    '    mHasStartedCreatingInitialContext = true;\n' +
    '    mReactContextCleanupFailed = false;\n' +
    '    mCreateReactContextThread =\n        new Thread(');
  replace('              // As destroy() may have run and set this to false, ensure that it is true before we\n' +
    '              // create\n              mHasStartedCreatingInitialContext = true;',
    '              final java.lang.Thread creatingThread = java.lang.Thread.currentThread();\n' +
    '              if (creationGeneration != mReactContextGeneration) {\n' +
    '                UiThreadUtil.runOnUiThread(\n' +
    '                    () -> finishReactContextCreation(creatingThread, creationGeneration, null, false));\n' +
    '                return;\n              }');
  replace('                // Reset state and bail out. This lets us try again later.\n' +
    '                mHasStartedCreatingInitialContext = false;\n' +
    '                mCreateReactContextThread = null;\n' +
    '                mDevSupportManager.handleException(e);\n                return;',
    '                try {\n                  mDevSupportManager.handleException(e);\n' +
    '                } finally {\n                  UiThreadUtil.runOnUiThread(\n' +
    '                      () -> finishReactContextCreation(creatingThread, creationGeneration, null, false));\n' +
    '                }\n                return;');
  replace('              try {\n                mCreateReactContextThread = null;\n' +
    '                ReactMarker.logMarker(PRE_SETUP_REACT_CONTEXT_START);\n' +
    '                final Runnable maybeRecreateReactContextRunnable =\n' +
    '                    () -> {\n                      if (mPendingReactContextInitParams != null) {\n' +
    '                        runCreateReactContextOnNewThread(mPendingReactContextInitParams);\n' +
    '                        mPendingReactContextInitParams = null;\n' +
    '                      }\n                    };',
    '              try {\n                ReactMarker.logMarker(PRE_SETUP_REACT_CONTEXT_START);');
  replace('                    () -> {\n                      try {\n' +
    '                        setupReactContext(reactApplicationContext);\n' +
    '                      } catch (Exception e) {\n' +
    '                        mDevSupportManager.handleException(e);\n                      }',
    '                    () -> {\n                      boolean setupCompleted = false;\n                      try {\n' +
    '                        setupReactContext(reactApplicationContext, creationGeneration, creatingThread);\n' +
    '                        setupCompleted = true;\n' +
    '                      } catch (Exception e) {\n' +
    '                        synchronized (mAttachedReactRoots) {\n' +
    '                          if (creationGeneration == mReactContextGeneration) mReactContextGeneration++;\n' +
    '                        }\n' +
    '                        mDevSupportManager.handleException(e);\n' +
    '                      } finally {\n                        final boolean discardContext = !setupCompleted;\n' +
    '                        UiThreadUtil.runOnUiThread(\n' +
    '                            () -> finishReactContextCreation(creatingThread, creationGeneration,\n' +
    '                                reactApplicationContext, discardContext));\n                      }');
  replace('                UiThreadUtil.runOnUiThread(maybeRecreateReactContextRunnable);\n' +
    '              } catch (Exception e) {\n                mDevSupportManager.handleException(e);\n              }',
    '              } catch (Exception e) {\n                try {\n' +
    '                  mDevSupportManager.handleException(e);\n' +
    '                } finally {\n                  UiThreadUtil.runOnUiThread(\n' +
    '                      () -> finishReactContextCreation(creatingThread, creationGeneration,\n' +
    '                          reactApplicationContext, true));\n                }\n              }');
  replace('  private void setupReactContext(final ReactApplicationContext reactContext) {',
    `  private void finishReactContextCreation(
      java.lang.Thread creatingThread, long creationGeneration,
      @Nullable ReactApplicationContext reactContext, boolean discardContext) {
    UiThreadUtil.assertOnUiThread();
    if (mCreateReactContextThread != creatingThread || mReactContextCleanupFailed) return;
    try {
      synchronized (mAttachedReactRoots) {
        synchronized (mReactContextLock) {
          if (reactContext != null
              && (discardContext || creationGeneration != mReactContextGeneration
                  || mCurrentReactContext != reactContext)) {
            if (mCurrentReactContext == reactContext) {
              tearDownReactContext(reactContext);
              mCurrentReactContext = null;
            } else {
              reactContext.destroy();
            }
          }
        }
      }
      if (mInstanceManagerInvalidated && mInspectorTarget != null) {
        mInspectorTarget.close();
        mInspectorTarget = null;
      }
    } catch (Exception cleanupFailure) {
      // An occupied Inspector must not be reused after unsuccessful cleanup.
      mDevSupportManager.handleException(cleanupFailure);
      return;
    }
    if (mCurrentReactContext == null) {
      mHasStartedCreatingInitialContext = false;
    }
    mCreateReactContextThread = null;
    ReactContextInitParams pending = mPendingReactContextInitParams;
    mPendingReactContextInitParams = null;
    if (!mInstanceManagerInvalidated && pending != null) runCreateReactContextOnNewThread(pending);
  }

  private void setupReactContext(
      final ReactApplicationContext reactContext, final long creationGeneration,
      final java.lang.Thread creatingThread) {`);
  replace('    FLog.d(ReactConstants.TAG, "ReactInstanceManager.setupReactContext()");\n' +
    '    ReactMarker.logMarker(PRE_SETUP_REACT_CONTEXT_END);\n' +
    '    ReactMarker.logMarker(SETUP_REACT_CONTEXT_START);\n' +
    '    Systrace.beginSection(TRACE_TAG_REACT, "setupReactContext");\n', '');
  replace('        mCurrentReactContext = Assertions.assertNotNull(reactContext);',
    '        if (creationGeneration != mReactContextGeneration\n' +
    '            || mCreateReactContextThread != creatingThread || mInstanceManagerInvalidated) return;\n' +
    '        FLog.d(ReactConstants.TAG, "ReactInstanceManager.setupReactContext()");\n' +
    '        ReactMarker.logMarker(PRE_SETUP_REACT_CONTEXT_END);\n' +
    '        ReactMarker.logMarker(SETUP_REACT_CONTEXT_START);\n' +
    '        Systrace.beginSection(TRACE_TAG_REACT, "setupReactContext");\n' +
    '        mCurrentReactContext = Assertions.assertNotNull(reactContext);');
  replace('        () -> {\n          moveReactContextToCurrentLifecycleState();',
    '        () -> {\n          if (creationGeneration != mReactContextGeneration\n' +
    '              || getCurrentReactContext() != reactContext) return;\n' +
    '          moveReactContextToCurrentLifecycleState();');
  replace('    Systrace.beginSection(TRACE_TAG_REACT, "attachRootViewToInstance");',
    '    Systrace.beginSection(TRACE_TAG_REACT, "attachRootViewToInstance");\n' +
    '    final ReactContext rootContext = mCurrentReactContext;\n' +
    '    final long rootGeneration = mReactContextGeneration;');
  replace('UIManagerHelper.getUIManager(mCurrentReactContext, reactRoot.getUIManagerType())',
    'UIManagerHelper.getUIManager(rootContext, reactRoot.getUIManagerType())');
  replace('          reactRoot.onStage(ReactStage.ON_ATTACH_TO_INSTANCE);',
    '          if (rootGeneration != mReactContextGeneration || getCurrentReactContext() != rootContext\n' +
    '              || !mAttachedReactRoots.contains(reactRoot)\n' +
    '              || reactRoot.getState().get() != ReactRoot.STATE_STARTED\n' +
    '              || reactRoot.getRootViewTag() != rootTag) return;\n' +
    '          reactRoot.onStage(ReactStage.ON_ATTACH_TO_INSTANCE);');
  // Keep builder.build/finally outside, matching the already-installed cleanup region.
  replace('    reactContext.initializeWithInstance(catalystInstance);',
    '    try {\n    reactContext.initializeWithInstance(catalystInstance);');
  replace('    return reactContext;\n  }',
    '    return reactContext;\n    } catch (Throwable failure) {\n' +
    '      if (!com.anonymous.junluo.ReactContextLoaderCleanup.cleanupFailedContextAndReport(\n' +
    '          failure, reactContext, catalystInstance)) mReactContextCleanupFailed = true;\n' +
    '      throw failure;\n    }\n  }');
  return source;
}

module.exports = { patchReactInstanceManager };

if (require.main === module) {
  assert.equal(process.argv.length, 4, 'Usage: node react-native-context-lifecycle-patch.cjs <sourceFile> <generatedFile>');
  const fs = require('node:fs');
  const path = require('node:path');
  const generated = patchReactInstanceManager(fs.readFileSync(process.argv[2], 'utf8'));
  fs.mkdirSync(path.dirname(process.argv[3]), { recursive: true });
  fs.writeFileSync(process.argv[3], generated, 'utf8');
}
