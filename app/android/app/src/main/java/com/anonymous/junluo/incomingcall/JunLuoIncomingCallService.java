package com.anonymous.junluo.incomingcall;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import com.anonymous.junluo.R;

public class JunLuoIncomingCallService extends Service {
  private static final String CHANNEL = "junluo_incoming_calls";
  private MediaPlayer player;

  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    String invitationId = intent.getStringExtra("invitationId");
    if (invitationId == null) { stopSelf(); return START_NOT_STICKY; }
    createChannel();
    PendingIntent answer = JunLuoIncomingCallModule.actionPendingIntent(this, invitationId, JunLuoIncomingCallReceiver.ACTION_ANSWER, 1);
    PendingIntent decline = JunLuoIncomingCallModule.actionPendingIntent(this, invitationId, JunLuoIncomingCallReceiver.ACTION_DECLINE, 2);
    Intent screenIntent = createIncomingCallScreenIntent(invitationId);
    int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
    PendingIntent fullScreen = PendingIntent.getActivity(this, invitationId.hashCode(), screenIntent, piFlags);
    Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
      ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
    builder.setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("白云小姐来电")
      .setContentText("君落语音通话")
      .setCategory(Notification.CATEGORY_CALL)
      .setContentIntent(fullScreen)
      .setOngoing(true)
      .setFullScreenIntent(fullScreen, true)
      .setPriority(Notification.PRIORITY_MAX);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setStyle(Notification.CallStyle.forIncomingCall(new Person.Builder().setName("白云小姐").build(), decline, answer));
    } else {
      builder.addAction(new Notification.Action.Builder(0, "挂断", decline).build());
      builder.addAction(new Notification.Action.Builder(0, "接听", answer).build());
    }
    startForeground(7401, builder.build());
    openIncomingCallScreenWhenLocked(invitationId);
    if (player == null) {
      player = MediaPlayer.create(this, R.raw.junluo_incoming_call);
      if (player != null) {
        player.setLooping(true);
        player.start();
      }
    }
    return START_NOT_STICKY;
  }

  private Intent createIncomingCallScreenIntent(String invitationId) {
    Intent screenIntent = new Intent(this, JunLuoIncomingCallActivity.class);
    screenIntent.putExtra("invitationId", invitationId);
    screenIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return screenIntent;
  }

  private void openIncomingCallScreenWhenLocked(String invitationId) {
    KeyguardManager keyguard = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
    PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
    boolean locked = keyguard != null && keyguard.isKeyguardLocked();
    boolean screenOff = power != null && !power.isInteractive();
    if (!locked && !screenOff) return;
    try {
      startActivity(createIncomingCallScreenIntent(invitationId));
    } catch (Exception ignored) {}
  }

  private void createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationChannel channel = new NotificationChannel(CHANNEL, "白云小姐来电", NotificationManager.IMPORTANCE_HIGH);
    channel.setSound(null, null);
    channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(channel);
  }

  @Override public void onDestroy() {
    if (player != null) { player.stop(); player.release(); player = null; }
    stopForeground(true);
    super.onDestroy();
  }
  @Override public IBinder onBind(Intent intent) { return null; }
}
