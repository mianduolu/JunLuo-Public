package com.anonymous.junluo;

import com.facebook.react.bridge.BridgeReactContext;
import com.facebook.react.bridge.CatalystInstance;
import com.facebook.react.bridge.UiThreadUtil;
import java.util.concurrent.CountDownLatch;

/** Cleanup for the build-time handler around RN's post-build context initialization. */
public final class ReactContextLoaderCleanup {
  private ReactContextLoaderCleanup() {}

  public static Throwable cleanupFailedContext(
      Throwable failure, BridgeReactContext context, CatalystInstance catalyst) {
    cleanupFailedContextAndReport(failure, context, catalyst);
    return failure;
  }

  public static boolean cleanupFailedContextAndReport(
      Throwable failure, BridgeReactContext context, CatalystInstance catalyst) {
    if (UiThreadUtil.isOnUiThread()) {
      return destroyContext(failure, context, catalyst);
    }

    CountDownLatch completed = new CountDownLatch(1);
    boolean[] cleaned = {false};
    final boolean posted;
    try {
      posted = UiThreadUtil.runOnUiThread(() -> {
        try {
          cleaned[0] = destroyContext(failure, context, catalyst);
        } finally {
          completed.countDown();
        }
      });
    } catch (Throwable postingFailure) {
      suppress(failure, postingFailure);
      return false;
    }
    if (!posted) {
      suppress(failure, new IllegalStateException("Could not post React context cleanup to UI"));
      return false;
    }

    // Only the creation worker waits. Keep its existing busy flag until UI cleanup returns.
    boolean interrupted = false;
    for (;;) {
      try {
        completed.await();
        break;
      } catch (InterruptedException ignored) {
        interrupted = true;
      }
    }
    if (interrupted) Thread.currentThread().interrupt();
    return cleaned[0];
  }

  private static boolean destroyContext(
      Throwable failure, BridgeReactContext context, CatalystInstance catalyst) {
    try {
      boolean contextOwnsCatalyst = context.hasReactInstance();
      context.destroy();
      // initializeWithInstance may have failed before attaching the already-built Catalyst.
      if (!contextOwnsCatalyst) catalyst.destroy();
      return true;
    } catch (Throwable cleanupFailure) {
      suppress(failure, cleanupFailure);
      return false;
    }
  }

  private static void suppress(Throwable failure, Throwable cleanupFailure) {
    if (cleanupFailure != failure) failure.addSuppressed(cleanupFailure);
  }
}
