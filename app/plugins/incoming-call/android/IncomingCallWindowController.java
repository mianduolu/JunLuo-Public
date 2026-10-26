package com.anonymous.junluo.incomingcall;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.view.WindowManager;
import java.lang.ref.WeakReference;

public final class IncomingCallWindowController {
  private static WeakReference<Activity> activeActivity = new WeakReference<>(null);

  private IncomingCallWindowController() {}

  public static void apply(Activity activity, Intent intent) {
    activeActivity = new WeakReference<>(activity);
    String action = intent == null ? null : intent.getStringExtra("junluoIncomingCallAction");
    setVisible(activity, "ringing".equals(action) || "answered".equals(action));
  }

  public static void setActiveVisible(boolean visible) {
    Activity activity = activeActivity.get();
    if (activity == null) return;
    activity.runOnUiThread(() -> setVisible(activity, visible));
  }

  public static void setVisible(Activity activity, boolean visible) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(visible);
      activity.setTurnScreenOn(visible);
    }
    int legacyFlags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
      | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
    int callFlags = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD;
    if (visible) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O_MR1) {
        activity.getWindow().addFlags(legacyFlags);
      }
      activity.getWindow().addFlags(callFlags);
    } else {
      activity.getWindow().clearFlags(legacyFlags | callFlags);
    }
  }
}
