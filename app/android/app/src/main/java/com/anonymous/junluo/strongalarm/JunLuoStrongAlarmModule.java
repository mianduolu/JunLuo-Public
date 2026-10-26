package com.anonymous.junluo.strongalarm;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

public class JunLuoStrongAlarmModule extends ReactContextBaseJavaModule {
  public JunLuoStrongAlarmModule(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @Override
  public String getName() {
    return "JunLuoStrongAlarm";
  }

  private AlarmManager alarmManager() {
    return (AlarmManager) getReactApplicationContext().getSystemService(Context.ALARM_SERVICE);
  }

  private boolean canScheduleExactAlarms() {
    AlarmManager manager = alarmManager();
    if (manager == null) return false;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return manager.canScheduleExactAlarms();
    return true;
  }

  private boolean notificationsEnabled() {
    NotificationManager manager = (NotificationManager) getReactApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager == null) return false;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) return manager.areNotificationsEnabled();
    return true;
  }

  private boolean batteryOptimizationIgnored() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
    PowerManager manager = (PowerManager) getReactApplicationContext().getSystemService(Context.POWER_SERVICE);
    return manager != null && manager.isIgnoringBatteryOptimizations(getReactApplicationContext().getPackageName());
  }

  private PendingIntent pendingIntent(String nativeId) {
    Intent intent = new Intent(getReactApplicationContext(), JunLuoStrongAlarmReceiver.class);
    intent.setAction("com.anonymous.junluo.STRONG_ALARM_TRIGGER");
    intent.putExtra("nativeId", nativeId);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    return PendingIntent.getBroadcast(getReactApplicationContext(), nativeId.hashCode(), intent, flags);
  }

  @ReactMethod
  public void getStatus(Promise promise) {
    try {
      JSONObject result = new JSONObject();
      result.put("available", true);
      result.put("platform", "android");
      result.put("canScheduleExactAlarms", canScheduleExactAlarms());
      result.put("notificationEnabled", notificationsEnabled());
      result.put("batteryOptimizationIgnored", batteryOptimizationIgnored());
      promise.resolve(result.toString());
    } catch (Exception error) {
      promise.reject("STRONG_ALARM_STATUS_FAILED", error);
    }
  }

  @ReactMethod
  public void scheduleAlarm(String payloadJson, Promise promise) {
    try {
      JSONObject input = new JSONObject(payloadJson);
      long triggerAt = input.optLong("triggerAt", 0);
      String title = input.optString("title", "白云小姐强闹钟");
      String message = input.optString("message", title);
      String ringtone = input.optString("ringtone", "default");
      boolean vibrate = input.optBoolean("vibrate", true);
      if (triggerAt <= System.currentTimeMillis() + 1000) {
        promise.reject("STRONG_ALARM_INVALID_TIME", "强闹钟时间必须在未来");
        return;
      }
      if (!canScheduleExactAlarms()) {
        promise.reject("STRONG_ALARM_EXACT_DENIED", "系统没有允许君落安排精确闹钟");
        return;
      }
      String nativeId = "strong-alarm-" + UUID.randomUUID();
      JSONObject record = new JSONObject();
      record.put("nativeId", nativeId);
      record.put("title", title);
      record.put("message", message);
      record.put("triggerAt", triggerAt);
      record.put("status", "pending");
      record.put("ringStatus", "pending");
      record.put("ringtone", ringtone);
      record.put("vibrate", vibrate);
      record.put("exactAlarmAllowed", true);
      record.put("notificationEnabled", notificationsEnabled());
      record.put("batteryOptimizationIgnored", batteryOptimizationIgnored());
      record.put("createdAt", System.currentTimeMillis());
      record.put("updatedAt", System.currentTimeMillis());

      AlarmManager manager = alarmManager();
      if (manager == null) {
        promise.reject("STRONG_ALARM_MANAGER_MISSING", "系统 AlarmManager 不可用");
        return;
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent(nativeId));
      } else {
        manager.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pendingIntent(nativeId));
      }
      StrongAlarmStorage.upsert(getReactApplicationContext(), record);

      JSONObject result = new JSONObject();
      result.put("nativeId", nativeId);
      result.put("scheduledAt", System.currentTimeMillis());
      result.put("exactAlarmAllowed", true);
      result.put("notificationEnabled", notificationsEnabled());
      result.put("batteryOptimizationIgnored", batteryOptimizationIgnored());
      promise.resolve(result.toString());
    } catch (Exception error) {
      promise.reject("STRONG_ALARM_SCHEDULE_FAILED", error);
    }
  }

  @ReactMethod
  public void resetAlarms(Promise promise) {
    try {
      AlarmManager manager = alarmManager();
      if (manager == null) {
        promise.reject("STRONG_ALARM_MANAGER_MISSING", "系统 AlarmManager 不可用");
        return;
      }
      JSONArray records = StrongAlarmStorage.markAllCancelledForRestore(getReactApplicationContext());
      int cancelledCount = 0;
      for (int i = 0; i < records.length(); i++) {
        JSONObject record = records.optJSONObject(i);
        if (record == null) continue;
        String nativeId = record.optString("nativeId");
        if (nativeId.length() == 0) continue;
        manager.cancel(pendingIntent(nativeId));
        cancelledCount += 1;
      }
      getReactApplicationContext().stopService(
        new Intent(getReactApplicationContext(), JunLuoStrongAlarmService.class)
      );
      StrongAlarmStorage.clearRecords(getReactApplicationContext());
      JSONObject result = new JSONObject();
      result.put("ok", true);
      result.put("cancelledCount", cancelledCount);
      promise.resolve(result.toString());
    } catch (Exception error) {
      promise.reject("STRONG_ALARM_RESET_FAILED", error);
    }
  }

  @ReactMethod
  public void cancelAlarm(String nativeId, Promise promise) {
    try {
      AlarmManager manager = alarmManager();
      if (manager != null) manager.cancel(pendingIntent(nativeId));
      JSONObject patch = new JSONObject();
      patch.put("status", "cancelled");
      patch.put("ringStatus", "stopped");
      StrongAlarmStorage.patch(getReactApplicationContext(), nativeId, patch);
      Intent stop = new Intent(getReactApplicationContext(), JunLuoStrongAlarmService.class);
      stop.setAction(JunLuoStrongAlarmService.ACTION_STOP);
      stop.putExtra("nativeId", nativeId);
      getReactApplicationContext().startService(stop);
      JSONObject result = new JSONObject();
      result.put("ok", true);
      promise.resolve(result.toString());
    } catch (Exception error) {
      promise.reject("STRONG_ALARM_CANCEL_FAILED", error);
    }
  }

  @ReactMethod
  public void stopRinging(String nativeId, Promise promise) {
    cancelAlarm(nativeId, promise);
  }

  @ReactMethod
  public void loadRecords(Promise promise) {
    promise.resolve(StrongAlarmStorage.loadRecords(getReactApplicationContext()).toString());
  }
}
