const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod, withMainApplication } = require('@expo/config-plugins');

const MODULE_PACKAGE_SEGMENT = 'strongalarm';
const CHANNEL_ID = 'junluo-strong-alarm';
const ALARM_SOUND_FILES = [
  { source: 'alarm-strong.wav', raw: 'junluo_alarm_strong.wav' },
];

function getAppPackage(config) {
  return config.android?.package || 'com.anonymous.junluo';
}

function ensurePermission(manifest, name) {
  manifest.manifest['uses-permission'] = manifest.manifest['uses-permission'] || [];
  const permissions = manifest.manifest['uses-permission'];
  if (!permissions.some((item) => item.$?.['android:name'] === name)) {
    permissions.push({ $: { 'android:name': name } });
  }
}

function ensureApplicationChild(application, tag, androidName, attrs = {}) {
  application[tag] = application[tag] || [];
  const list = application[tag];
  const existing = list.find((item) => item.$?.['android:name'] === androidName);
  if (existing) {
    existing.$ = { ...existing.$, ...attrs, 'android:name': androidName };
    return;
  }
  list.push({ $: { ...attrs, 'android:name': androidName } });
}

function writeFileOnce(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function copyAlarmSounds(projectRoot) {
  const rawDir = path.join(projectRoot, 'app/src/main/res/raw');
  const sourceDir = path.join(projectRoot, '..', 'assets', 'sounds');
  fs.mkdirSync(rawDir, { recursive: true });
  for (const file of ALARM_SOUND_FILES) {
    const sourcePath = path.join(sourceDir, file.source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing strong alarm sound asset: ${sourcePath}`);
    }
    fs.copyFileSync(sourcePath, path.join(rawDir, file.raw));
  }
}

function storageJava(packageName) {
  return `package ${packageName}.${MODULE_PACKAGE_SEGMENT};

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

public final class StrongAlarmStorage {
  private static final String PREFS = "junluo_strong_alarm_prefs";
  private static final String KEY_RECORDS = "records";
  private static long restoreGeneration = 0;

  public interface TriggeredAction {
    void run(JSONObject record) throws Exception;
  }

  private StrongAlarmStorage() {}

  private static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  public static synchronized JSONArray loadRecords(Context context) {
    try {
      String raw = prefs(context).getString(KEY_RECORDS, "[]");
      return new JSONArray(raw == null ? "[]" : raw);
    } catch (Exception ignored) {
      return new JSONArray();
    }
  }

  public static synchronized void saveRecords(Context context, JSONArray records) {
    prefs(context).edit().putString(KEY_RECORDS, records.toString()).apply();
  }

  private static void saveRecordsSynchronously(Context context, JSONArray records) {
    if (!prefs(context).edit().putString(KEY_RECORDS, records.toString()).commit()) {
      throw new IllegalStateException("Failed to commit strong alarm records");
    }
  }

  public static synchronized void clearRecords(Context context) {
    saveRecordsSynchronously(context, new JSONArray());
  }

  public static synchronized JSONArray markAllCancelledForRestore(Context context) {
    restoreGeneration += 1;
    JSONArray records = loadRecords(context);
    long now = System.currentTimeMillis();
    try {
      for (int i = 0; i < records.length(); i++) {
        JSONObject record = records.optJSONObject(i);
        if (record == null) continue;
        record.put("status", "cancelled");
        record.put("ringStatus", "stopped");
        record.put("updatedAt", now);
      }
      saveRecordsSynchronously(context, records);
      return records;
    } catch (Exception error) {
      throw new IllegalStateException("Failed to mark strong alarms cancelled", error);
    }
  }

  public static synchronized boolean claimTriggered(Context context, String nativeId) {
    JSONArray records = loadRecords(context);
    try {
      for (int i = 0; i < records.length(); i++) {
        JSONObject record = records.optJSONObject(i);
        if (
          record == null ||
          !nativeId.equals(record.optString("nativeId")) ||
          !"pending".equals(record.optString("status"))
        ) {
          continue;
        }
        record.put("status", "triggered");
        record.put("triggeredAt", System.currentTimeMillis());
        record.put("ringStatus", "started");
        record.put("updatedAt", System.currentTimeMillis());
        saveRecordsSynchronously(context, records);
        return true;
      }
      return false;
    } catch (Exception error) {
      return false;
    }
  }

  public static synchronized JSONObject find(Context context, String nativeId) {
    JSONArray records = loadRecords(context);
    for (int i = 0; i < records.length(); i++) {
      JSONObject record = records.optJSONObject(i);
      if (record != null && nativeId.equals(record.optString("nativeId"))) return record;
    }
    return null;
  }

  public static synchronized long currentRestoreGeneration() {
    return restoreGeneration;
  }

  public static synchronized boolean runIfTriggeredAtGeneration(
    Context context,
    String nativeId,
    long expectedGeneration,
    TriggeredAction action
  ) throws Exception {
    if (restoreGeneration != expectedGeneration) return false;
    JSONObject record = find(context, nativeId);
    if (record == null || !"triggered".equals(record.optString("status"))) return false;
    action.run(record);
    return true;
  }

  public static synchronized void upsert(Context context, JSONObject next) {
    JSONArray records = loadRecords(context);
    JSONArray output = new JSONArray();
    boolean replaced = false;
    String nativeId = next.optString("nativeId");
    for (int i = 0; i < records.length(); i++) {
      JSONObject record = records.optJSONObject(i);
      if (record == null) continue;
      if (nativeId.equals(record.optString("nativeId"))) {
        output.put(next);
        replaced = true;
      } else {
        output.put(record);
      }
    }
    if (!replaced) output.put(next);
    saveRecords(context, output);
  }

  public static synchronized void patch(Context context, String nativeId, JSONObject patch) {
    try {
      JSONObject record = find(context, nativeId);
      if (record == null) return;
      JSONArray names = patch.names();
      if (names != null) {
        for (int i = 0; i < names.length(); i++) {
          String key = names.optString(i);
          record.put(key, patch.opt(key));
        }
      }
      record.put("updatedAt", System.currentTimeMillis());
      upsert(context, record);
    } catch (Exception ignored) {
    }
  }
}
`;
}

function packageJava(packageName) {
  return `package ${packageName}.${MODULE_PACKAGE_SEGMENT};

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class JunLuoStrongAlarmPackage implements ReactPackage {
  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
    List<NativeModule> modules = new ArrayList<>();
    modules.add(new JunLuoStrongAlarmModule(reactContext));
    return modules;
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
    return Collections.emptyList();
  }
}
`;
}

function moduleJava(packageName) {
  return `package ${packageName}.${MODULE_PACKAGE_SEGMENT};

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
`;
}

function receiverJava(packageName) {
  return `package ${packageName}.${MODULE_PACKAGE_SEGMENT};

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class JunLuoStrongAlarmReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    String nativeId = intent.getStringExtra("nativeId");
    if (nativeId == null || nativeId.length() == 0) return;
    if (!StrongAlarmStorage.claimTriggered(context, nativeId)) return;
    Intent serviceIntent = new Intent(context, JunLuoStrongAlarmService.class);
    serviceIntent.setAction(JunLuoStrongAlarmService.ACTION_START);
    serviceIntent.putExtra("nativeId", nativeId);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(serviceIntent);
    } else {
      context.startService(serviceIntent);
    }
  }
}
`;
}

function serviceJava(packageName) {
  return `package ${packageName}.${MODULE_PACKAGE_SEGMENT};

import ${packageName}.R;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.VibrationEffect;
import android.os.Vibrator;
import org.json.JSONObject;

public class JunLuoStrongAlarmService extends Service {
  public static final String ACTION_START = "com.anonymous.junluo.STRONG_ALARM_START";
  public static final String ACTION_STOP = "com.anonymous.junluo.STRONG_ALARM_STOP";
  private static final int NOTIFICATION_ID = 7316;
  private MediaPlayer player;
  private Vibrator vibrator;
  private String currentNativeId;
  private int currentStartId;

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String action = intent != null ? intent.getAction() : ACTION_START;
    String nativeId = intent != null ? intent.getStringExtra("nativeId") : null;
    if (ACTION_STOP.equals(action)) {
      stopAlarm(nativeId, startId);
      return START_NOT_STICKY;
    }
    startAlarm(nativeId, startId);
    return START_NOT_STICKY;
  }

  private void ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationChannel channel = new NotificationChannel("${CHANNEL_ID}", "白云小姐强闹钟", NotificationManager.IMPORTANCE_HIGH);
    channel.setDescription("君落强闹钟响铃通知");
    channel.setBypassDnd(true);
    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (manager != null) manager.createNotificationChannel(channel);
  }

  private Notification buildNotification(JSONObject record, String nativeId) {
    ensureChannel();
    String title = record != null ? record.optString("title", "白云小姐强闹钟") : "白云小姐强闹钟";
    String message = record != null ? record.optString("message", "到点啦") : "到点啦";
    Intent stopIntent = new Intent(this, JunLuoStrongAlarmService.class);
    stopIntent.setAction(ACTION_STOP);
    stopIntent.putExtra("nativeId", nativeId);
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent stopPending = PendingIntent.getService(this, nativeId.hashCode(), stopIntent, flags);

    Intent activityIntent = new Intent(this, JunLuoStrongAlarmActivity.class);
    activityIntent.putExtra("nativeId", nativeId);
    activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    PendingIntent activityPending = PendingIntent.getActivity(this, nativeId.hashCode() + 1, activityIntent, flags);

    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
      ? new Notification.Builder(this, "${CHANNEL_ID}")
      : new Notification.Builder(this);
    builder
      .setSmallIcon(getApplicationInfo().icon)
      .setContentTitle("强闹钟响啦：" + title)
      .setContentText("点这里打开停止页，或下拉通知按“停止强闹钟”。")
      .setStyle(new Notification.BigTextStyle().bigText(message + "\\n\\n点这里打开停止页，或下拉通知按“停止强闹钟”。"))
      .setContentIntent(activityPending)
      .setFullScreenIntent(activityPending, true)
      .setOngoing(true)
      .setAutoCancel(false)
      .setPriority(Notification.PRIORITY_MAX)
      .setCategory(Notification.CATEGORY_ALARM)
      .addAction(new Notification.Action.Builder(getApplicationInfo().icon, "停止强闹钟", stopPending).build());
    return builder.build();
  }

  private void openStopActivity(String nativeId) {
    try {
      Intent activityIntent = new Intent(this, JunLuoStrongAlarmActivity.class);
      activityIntent.putExtra("nativeId", nativeId);
      activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
      startActivity(activityIntent);
    } catch (Exception ignored) {}
  }

  private int fallbackAlarmResource() {
    return R.raw.junluo_alarm_strong;
  }

  private void prepareAlarmSound(MediaPlayer next, JSONObject record) throws Exception {
    Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
    if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
    if (uri != null) {
      try {
        next.setDataSource(this, uri);
        return;
      } catch (Exception ignored) {}
    }
    AssetFileDescriptor descriptor = getResources().openRawResourceFd(fallbackAlarmResource());
    try {
      next.setDataSource(descriptor.getFileDescriptor(), descriptor.getStartOffset(), descriptor.getLength());
    } finally {
      descriptor.close();
    }
  }

  private void startAlarm(String nativeId, int startId) {
    if (nativeId == null || nativeId.length() == 0) {
      finishRejectedStart(nativeId, startId);
      return;
    }
    long restoreGeneration = StrongAlarmStorage.currentRestoreGeneration();
    JSONObject[] preparedRecord = new JSONObject[1];
    try {
      boolean foregroundStarted = StrongAlarmStorage.runIfTriggeredAtGeneration(
        this,
        nativeId,
        restoreGeneration,
        currentRecord -> {
          preparedRecord[0] = currentRecord;
          startForeground(NOTIFICATION_ID, buildNotification(currentRecord, nativeId));
          openStopActivity(nativeId);
        }
      );
      if (!foregroundStarted) {
        finishRejectedStart(nativeId, startId);
        return;
      }
    } catch (Exception error) {
      markAlarmFailedAtGeneration(nativeId, restoreGeneration, false, error);
      finishRejectedStart(nativeId, startId);
      return;
    }

    MediaPlayer nextPlayer = new MediaPlayer();
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
        nextPlayer.setAudioAttributes(new AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ALARM)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build());
      }
      prepareAlarmSound(nextPlayer, preparedRecord[0]);
      nextPlayer.prepare();
      boolean started = StrongAlarmStorage.runIfTriggeredAtGeneration(
        this,
        nativeId,
        restoreGeneration,
        currentRecord -> {
          releaseCurrentAlarmForReplacement(nativeId);
          currentNativeId = nativeId;
          currentStartId = startId;
          player = nextPlayer;
          player.setLooping(true);
          player.start();
          if (currentRecord.optBoolean("vibrate", true)) {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null) {
              long[] pattern = new long[] { 0, 500, 350, 500 };
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
              } else {
                vibrator.vibrate(pattern, 0);
              }
            }
          }
          JSONObject patch = new JSONObject();
          patch.put("notificationShown", true);
          patch.put("ringStatus", "started");
          StrongAlarmStorage.patch(this, nativeId, patch);
        }
      );
      if (!started) {
        nextPlayer.release();
        finishRejectedStart(nativeId, startId);
        return;
      }
    } catch (Exception error) {
      if (ownsCurrentAlarm(nativeId, startId)) {
        releasePlaybackResources();
        currentNativeId = null;
        currentStartId = 0;
      } else {
        try { nextPlayer.release(); } catch (Exception ignored) {}
      }
      markAlarmFailedAtGeneration(nativeId, restoreGeneration, true, error);
      finishRejectedStart(nativeId, startId);
    }
  }

  private boolean ownsCurrentAlarm(String nativeId, int startId) {
    return nativeId != null && nativeId.equals(currentNativeId) && currentStartId == startId;
  }

  private void releasePlaybackResources() {
    if (player != null) {
      try { player.stop(); } catch (Exception ignored) {}
      try { player.release(); } catch (Exception ignored) {}
      player = null;
    }
    if (vibrator != null) {
      try { vibrator.cancel(); } catch (Exception ignored) {}
      vibrator = null;
    }
  }

  private void releaseCurrentAlarmForReplacement(String nativeId) {
    String previousNativeId = currentNativeId;
    if (previousNativeId == null) return;
    releasePlaybackResources();
    currentNativeId = null;
    currentStartId = 0;
    try {
      JSONObject patch = new JSONObject();
      patch.put("ringStatus", "stopped");
      StrongAlarmStorage.patch(this, previousNativeId, patch);
    } catch (Exception ignored) {}
  }

  private void markAlarmFailedAtGeneration(
    String nativeId,
    long restoreGeneration,
    boolean notificationShown,
    Exception error
  ) {
    try {
      StrongAlarmStorage.runIfTriggeredAtGeneration(
        this,
        nativeId,
        restoreGeneration,
        currentRecord -> {
          JSONObject patch = new JSONObject();
          patch.put("notificationShown", notificationShown);
          patch.put("ringStatus", "failed");
          patch.put("errorMessage", error.getMessage());
          StrongAlarmStorage.patch(this, nativeId, patch);
        }
      );
    } catch (Exception ignored) {}
  }

  private void finishRejectedStart(String nativeId, int startId) {
    if (currentNativeId != null) {
      JSONObject currentRecord = StrongAlarmStorage.find(this, currentNativeId);
      if (currentRecord != null && "triggered".equals(currentRecord.optString("status"))) {
        try {
          startForeground(NOTIFICATION_ID, buildNotification(currentRecord, currentNativeId));
        } catch (Exception ignored) {}
        return;
      }
      releasePlaybackResources();
      currentNativeId = null;
      currentStartId = 0;
    }
    if (stopSelfResult(startId)) stopForeground(true);
  }

  private void stopAlarm(String nativeId, int startId) {
    String id = nativeId != null ? nativeId : currentNativeId;
    if (id != null) {
      try {
        JSONObject patch = new JSONObject();
        patch.put("ringStatus", "stopped");
        StrongAlarmStorage.patch(this, id, patch);
      } catch (Exception ignored) {}
    }
    if (currentNativeId != null && id != null && !currentNativeId.equals(id)) return;
    releasePlaybackResources();
    currentNativeId = null;
    currentStartId = 0;
    if (stopSelfResult(startId)) stopForeground(true);
  }

  @Override
  public void onDestroy() {
    String nativeId = currentNativeId;
    releasePlaybackResources();
    currentNativeId = null;
    currentStartId = 0;
    if (nativeId != null) {
      try {
        JSONObject patch = new JSONObject();
        patch.put("ringStatus", "stopped");
        StrongAlarmStorage.patch(this, nativeId, patch);
      } catch (Exception ignored) {}
    }
    stopForeground(true);
    super.onDestroy();
  }
}
`;
}

function activityJava(packageName) {
  return `package ${packageName}.${MODULE_PACKAGE_SEGMENT};

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class JunLuoStrongAlarmActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true);
      setTurnScreenOn(true);
    } else {
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
    }
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
    String nativeId = getIntent().getStringExtra("nativeId");
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    layout.setGravity(Gravity.CENTER);
    layout.setPadding(48, 64, 48, 64);
    layout.setBackgroundColor(Color.rgb(255, 245, 246));
    TextView title = new TextView(this);
    title.setText("强闹钟响啦");
    title.setTextSize(32);
    title.setTypeface(Typeface.DEFAULT_BOLD);
    title.setGravity(Gravity.CENTER);
    title.setTextColor(Color.rgb(64, 54, 62));
    TextView hint = new TextView(this);
    hint.setText("点下面的大按钮停止响铃");
    hint.setTextSize(18);
    hint.setGravity(Gravity.CENTER);
    hint.setTextColor(Color.rgb(116, 94, 104));
    Button stop = new Button(this);
    stop.setText("停止强闹钟");
    stop.setTextSize(26);
    stop.setAllCaps(false);
    stop.setMinHeight(160);
    stop.setPadding(24, 36, 24, 36);
    stop.setOnClickListener((view) -> {
      Intent intent = new Intent(this, JunLuoStrongAlarmService.class);
      intent.setAction(JunLuoStrongAlarmService.ACTION_STOP);
      intent.putExtra("nativeId", nativeId);
      startService(intent);
      finish();
    });
    LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    layout.addView(title, titleParams);
    LinearLayout.LayoutParams hintParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    hintParams.setMargins(0, 24, 0, 56);
    layout.addView(hint, hintParams);
    LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    layout.addView(stop, buttonParams);
    setContentView(layout);
  }
}
`;
}

function withStrongAlarmManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    ensurePermission(manifest, 'android.permission.SCHEDULE_EXACT_ALARM');
    ensurePermission(manifest, 'android.permission.WAKE_LOCK');
    ensurePermission(manifest, 'android.permission.USE_FULL_SCREEN_INTENT');
    ensurePermission(manifest, 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK');
    ensurePermission(manifest, 'android.permission.POST_NOTIFICATIONS');

    const application = manifest.manifest.application?.[0];
    if (application) {
      ensureApplicationChild(application, 'receiver', `.${MODULE_PACKAGE_SEGMENT}.JunLuoStrongAlarmReceiver`, {
        'android:enabled': 'true',
        'android:exported': 'false',
      });
      ensureApplicationChild(application, 'service', `.${MODULE_PACKAGE_SEGMENT}.JunLuoStrongAlarmService`, {
        'android:enabled': 'true',
        'android:exported': 'false',
        'android:foregroundServiceType': 'mediaPlayback',
      });
      ensureApplicationChild(application, 'activity', `.${MODULE_PACKAGE_SEGMENT}.JunLuoStrongAlarmActivity`, {
        'android:excludeFromRecents': 'true',
        'android:exported': 'false',
        'android:showWhenLocked': 'true',
        'android:turnScreenOn': 'true',
      });
    }
    return config;
  });
}

function withStrongAlarmMainApplication(config) {
  return withMainApplication(config, (config) => {
    const packageName = getAppPackage(config);
    const importLine = `import ${packageName}.${MODULE_PACKAGE_SEGMENT}.JunLuoStrongAlarmPackage`;
    let contents = config.modResults.contents;
    if (!contents.includes('JunLuoStrongAlarmPackage')) {
      if (config.modResults.language === 'kt') {
        contents = contents.replace(/(package [^\n]+\n)/, `$1\n${importLine}\n`);
        if (/PackageList\(this\)\.packages\.apply\s*\{\n/.test(contents)) {
          contents = contents.replace(
            /(PackageList\(this\)\.packages\.apply\s*\{\n)/,
            `$1              add(JunLuoStrongAlarmPackage())\n`,
          );
        } else {
          contents = contents.replace(
            /(val packages = PackageList\(this\)\.packages[^\n]*\n)/,
            `$1      packages.add(JunLuoStrongAlarmPackage())\n`,
          );
        }
      } else {
        contents = contents.replace(/(package [^;]+;\n)/, `$1\n${importLine};\n`);
        contents = contents.replace(
          /(List<ReactPackage> packages = new PackageList\(this\)\.getPackages\(\);\n)/,
          `$1    packages.add(new JunLuoStrongAlarmPackage());\n`,
        );
      }
    }
    config.modResults.contents = contents;
    return config;
  });
}

function withStrongAlarmFiles(config) {
  return withDangerousMod(config, ['android', async (config) => {
    const packageName = getAppPackage(config);
    const projectRoot = config.modRequest.platformProjectRoot;
    const javaRoot = path.join(projectRoot, 'app/src/main/java', ...packageName.split('.'), MODULE_PACKAGE_SEGMENT);
    writeFileOnce(path.join(javaRoot, 'StrongAlarmStorage.java'), storageJava(packageName));
    writeFileOnce(path.join(javaRoot, 'JunLuoStrongAlarmPackage.java'), packageJava(packageName));
    writeFileOnce(path.join(javaRoot, 'JunLuoStrongAlarmModule.java'), moduleJava(packageName));
    writeFileOnce(path.join(javaRoot, 'JunLuoStrongAlarmReceiver.java'), receiverJava(packageName));
    writeFileOnce(path.join(javaRoot, 'JunLuoStrongAlarmService.java'), serviceJava(packageName));
    writeFileOnce(path.join(javaRoot, 'JunLuoStrongAlarmActivity.java'), activityJava(packageName));
    copyAlarmSounds(projectRoot);
    return config;
  }]);
}

module.exports = function withJunLuoStrongAlarm(config) {
  config = withStrongAlarmManifest(config);
  config = withStrongAlarmMainApplication(config);
  config = withStrongAlarmFiles(config);
  return config;
};
