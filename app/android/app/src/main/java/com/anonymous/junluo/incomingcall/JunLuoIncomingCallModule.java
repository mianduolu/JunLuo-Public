package com.anonymous.junluo.incomingcall;

import android.app.AlarmManager;
import android.app.AppOpsManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import org.json.JSONArray;
import org.json.JSONObject;
import java.lang.reflect.Method;

public class JunLuoIncomingCallModule extends ReactContextBaseJavaModule {
  private static final int MIUI_OP_SHOW_WHEN_LOCKED = 10020;
  private static final int MIUI_OP_BACKGROUND_START_ACTIVITY = 10021;
  private static ReactApplicationContext activeContext;

  public JunLuoIncomingCallModule(ReactApplicationContext context) {
    super(context);
    activeContext = context;
  }

  @Override public String getName() { return "JunLuoIncomingCall"; }

  private static WritableMap toMap(JSONObject value) {
    WritableMap map = Arguments.createMap();
    JSONArray names = value.names();
    if (names == null) return map;
    for (int index = 0; index < names.length(); index++) {
      String key = names.optString(index);
      Object item = value.opt(key);
      if (item instanceof Boolean) map.putBoolean(key, (Boolean) item);
      else if (item instanceof Number) map.putDouble(key, ((Number) item).doubleValue());
      else if (item != null && item != JSONObject.NULL) map.putString(key, String.valueOf(item));
    }
    return map;
  }

  public static void emit(Context context, JSONObject record, String action) {
    try {
      JSONObject payload = new JSONObject(record.toString());
      payload.put("action", action);
      IncomingCallStorage.setPendingAction(context, payload);
      if (activeContext != null && activeContext.hasActiveReactInstance()) {
        activeContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
          .emit("junluoIncomingCallAction", toMap(payload));
      }
    } catch (Exception ignored) {}
  }

  public static void emitIncomingCallIntent(Intent intent) {
    if (activeContext == null || intent == null) return;
    String action = intent.getStringExtra("junluoIncomingCallAction");
    String invitationId = intent.getStringExtra("junluoInvitationId");
    if (action == null || invitationId == null) return;
    JSONObject record = IncomingCallStorage.find(activeContext, invitationId);
    if (record != null) emit(activeContext, record, action);
  }

  static PendingIntent actionPendingIntent(Context context, String invitationId, String action, int offset) {
    Intent intent = new Intent(context, JunLuoIncomingCallReceiver.class);
    intent.setAction(action);
    intent.putExtra("invitationId", invitationId);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    return PendingIntent.getBroadcast(context, invitationId.hashCode() + offset, intent, flags);
  }

  static boolean canScheduleExact(Context context) {
    AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    return manager != null && (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms());
  }

  private static boolean isXiaomiDevice() {
    return "xiaomi".equalsIgnoreCase(Build.MANUFACTURER);
  }

  private static boolean isMiuiAppOpAllowed(Context context, int operation) {
    if (!isXiaomiDevice()) return true;
    try {
      AppOpsManager manager = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
      if (manager == null) return false;
      Method check = AppOpsManager.class.getMethod(
        "checkOpNoThrow",
        int.class,
        int.class,
        String.class
      );
      int result = (Integer) check.invoke(manager, operation, android.os.Process.myUid(), context.getPackageName());
      return result == AppOpsManager.MODE_ALLOWED;
    } catch (Exception ignored) {
      return false;
    }
  }

  static boolean scheduleRing(Context context, String invitationId, long scheduledAt) {
    AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    if (manager == null || !canScheduleExact(context)) return false;
    PendingIntent pending = actionPendingIntent(context, invitationId, JunLuoIncomingCallReceiver.ACTION_RING, 0);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, scheduledAt, pending);
    else manager.setExact(AlarmManager.RTC_WAKEUP, scheduledAt, pending);
    return true;
  }

  @ReactMethod public void getCapabilityStatus(Promise promise) {
    Context context = getReactApplicationContext();
    NotificationManager notifications = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    boolean notificationAllowed = notifications != null && (Build.VERSION.SDK_INT < Build.VERSION_CODES.N || notifications.areNotificationsEnabled());
    boolean fullScreen = true;
    if (Build.VERSION.SDK_INT >= 34 && notifications != null) fullScreen = notifications.canUseFullScreenIntent();
    WritableMap map = Arguments.createMap();
    map.putBoolean("available", true);
    map.putBoolean("exactAlarmAllowed", canScheduleExact(context));
    map.putBoolean("notificationsAllowed", notificationAllowed);
    map.putBoolean("fullScreenIntentAllowed", fullScreen);
    map.putBoolean("xiaomiPermissionRequired", isXiaomiDevice());
    map.putBoolean("showOnLockScreenAllowed", isMiuiAppOpAllowed(context, MIUI_OP_SHOW_WHEN_LOCKED));
    map.putBoolean("backgroundStartAllowed", isMiuiAppOpAllowed(context, MIUI_OP_BACKGROUND_START_ACTIVITY));
    promise.resolve(map);
  }

  @ReactMethod public void scheduleCall(String payloadJson, Promise promise) {
    try {
      Context context = getReactApplicationContext();
      JSONObject record = new JSONObject(payloadJson);
      String invitationId = record.optString("invitationId");
      long scheduledAt = record.optLong("scheduledAt");
      if (invitationId.isEmpty() || scheduledAt <= System.currentTimeMillis()) {
        promise.reject("INCOMING_CALL_INVALID", "来电时间必须在未来"); return;
      }
      if (!canScheduleExact(context)) {
        promise.reject("INCOMING_CALL_EXACT_DENIED", "系统没有允许精确来电时间"); return;
      }
      record.put("status", "scheduled");
      record.put("updatedAt", System.currentTimeMillis());
      IncomingCallStorage.upsert(context, record);
      if (!scheduleRing(context, invitationId, scheduledAt)) {
        promise.reject("INCOMING_CALL_SCHEDULE_FAILED", "系统暂时不能安排来电"); return;
      }
      WritableMap result = Arguments.createMap();
      result.putString("nativeTaskId", invitationId);
      promise.resolve(result);
    } catch (Exception error) { promise.reject("INCOMING_CALL_SCHEDULE_FAILED", error); }
  }

  @ReactMethod public void cancelCall(String invitationId, Promise promise) {
    Context context = getReactApplicationContext();
    AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    if (manager != null) manager.cancel(actionPendingIntent(context, invitationId, JunLuoIncomingCallReceiver.ACTION_RING, 0));
    IncomingCallStorage.transition(context, invitationId, "scheduled", "cancelled");
    promise.resolve(true);
  }

  @ReactMethod public void answerCall(String invitationId, Promise promise) {
    JunLuoIncomingCallReceiver.settle(getReactApplicationContext(), invitationId, "answered");
    promise.resolve(true);
  }

  @ReactMethod public void declineCall(String invitationId, Promise promise) {
    JunLuoIncomingCallReceiver.settle(getReactApplicationContext(), invitationId, "declined");
    promise.resolve(true);
  }

  @ReactMethod public void suppressCall(String invitationId, Promise promise) {
    JunLuoIncomingCallReceiver.settle(getReactApplicationContext(), invitationId, "suppressed_busy");
    promise.resolve(true);
  }

  @ReactMethod public void setCallUiVisible(boolean visible, Promise promise) {
    IncomingCallWindowController.setActiveVisible(visible);
    promise.resolve(true);
  }

  @ReactMethod public void consumePendingAction(Promise promise) {
    JSONObject action = IncomingCallStorage.consumePendingAction(getReactApplicationContext());
    promise.resolve(action == null ? null : toMap(action));
  }

  @ReactMethod public void getRecords(Promise promise) {
    JSONArray records = IncomingCallStorage.load(getReactApplicationContext());
    WritableArray array = Arguments.createArray();
    for (int index = 0; index < records.length(); index++) {
      JSONObject item = records.optJSONObject(index);
      if (item != null) array.pushMap(toMap(item));
    }
    promise.resolve(array);
  }

  @ReactMethod public void openFullScreenIntentSettings(Promise promise) {
    if (Build.VERSION.SDK_INT < 34) { promise.resolve(true); return; }
    try {
      Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getReactApplicationContext().getPackageName()));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getReactApplicationContext().startActivity(intent);
      promise.resolve(true);
    } catch (Exception error) { promise.resolve(false); }
  }

  @ReactMethod public void openXiaomiIncomingCallSettings(Promise promise) {
    Context context = getReactApplicationContext();
    try {
      Intent intent = new Intent("miui.intent.action.APP_PERM_EDITOR");
      intent.setClassName(
        "com.miui.securitycenter",
        "com.miui.permcenter.permissions.PermissionsEditorActivity"
      );
      intent.putExtra("extra_package_uid", android.os.Process.myUid());
      intent.putExtra("extra_pkgname", context.getPackageName());
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      context.startActivity(intent);
      promise.resolve(true);
    } catch (Exception error) {
      try {
        Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(fallback);
        promise.resolve(true);
      } catch (Exception ignored) { promise.resolve(false); }
    }
  }

  @ReactMethod public void openExactAlarmSettings(Promise promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) { promise.resolve(true); return; }
    Context context = getReactApplicationContext();
    try {
      Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + context.getPackageName()));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      context.startActivity(intent);
      promise.resolve(true);
    } catch (Exception error) {
      try {
        Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(fallback);
        promise.resolve(true);
      } catch (Exception ignored) { promise.resolve(false); }
    }
  }

  @ReactMethod public void addListener(String eventName) {}
  @ReactMethod public void removeListeners(double count) {}
}
