package com.anonymous.junluo.strongalarm;

import com.anonymous.junluo.R;
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
    NotificationChannel channel = new NotificationChannel("junluo-strong-alarm", "白云小姐强闹钟", NotificationManager.IMPORTANCE_HIGH);
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
      ? new Notification.Builder(this, "junluo-strong-alarm")
      : new Notification.Builder(this);
    builder
      .setSmallIcon(getApplicationInfo().icon)
      .setContentTitle("强闹钟响啦：" + title)
      .setContentText("点这里打开停止页，或下拉通知按“停止强闹钟”。")
      .setStyle(new Notification.BigTextStyle().bigText(message + "\n\n点这里打开停止页，或下拉通知按“停止强闹钟”。"))
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
