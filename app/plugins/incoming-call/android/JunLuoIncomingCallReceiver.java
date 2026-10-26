package com.anonymous.junluo.incomingcall;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import org.json.JSONObject;

public class JunLuoIncomingCallReceiver extends BroadcastReceiver {
  public static final String ACTION_RING = "com.anonymous.junluo.INCOMING_CALL_RING";
  public static final String ACTION_ANSWER = "com.anonymous.junluo.INCOMING_CALL_ANSWER";
  public static final String ACTION_DECLINE = "com.anonymous.junluo.INCOMING_CALL_DECLINE";
  public static final String ACTION_TIMEOUT = "com.anonymous.junluo.INCOMING_CALL_TIMEOUT";

  @Override public void onReceive(Context context, Intent intent) {
    String invitationId = intent.getStringExtra("invitationId");
    if (invitationId == null) return;
    String action = intent.getAction();
    if (ACTION_RING.equals(action)) ring(context, invitationId);
    else if (ACTION_ANSWER.equals(action)) settle(context, invitationId, "answered");
    else if (ACTION_DECLINE.equals(action)) settle(context, invitationId, "declined");
    else if (ACTION_TIMEOUT.equals(action)) settle(context, invitationId, "timed_out");
  }

  private static void ring(Context context, String invitationId) {
    if (IncomingCallStorage.hasOtherRinging(context, invitationId)) {
      JSONObject suppressed = IncomingCallStorage.transition(context, invitationId, "scheduled", "suppressed_busy");
      if (suppressed != null) JunLuoIncomingCallModule.emit(context, suppressed, "suppressed_busy");
      return;
    }
    JSONObject record = IncomingCallStorage.transition(context, invitationId, "scheduled", "ringing");
    if (record == null) return;
    JunLuoIncomingCallModule.emit(context, record, "ringing");
    Intent service = new Intent(context, JunLuoIncomingCallService.class).putExtra("invitationId", invitationId);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(service); else context.startService(service);
    AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    if (manager != null) {
      PendingIntent timeout = JunLuoIncomingCallModule.actionPendingIntent(context, invitationId, ACTION_TIMEOUT, 3);
      long at = System.currentTimeMillis() + 60_000;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, timeout);
      else manager.setExact(AlarmManager.RTC_WAKEUP, at, timeout);
    }
  }

  public static void settle(Context context, String invitationId, String status) {
    JSONObject record = IncomingCallStorage.transition(context, invitationId, "ringing", status);
    if (record == null) return;
    AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    if (manager != null) manager.cancel(JunLuoIncomingCallModule.actionPendingIntent(context, invitationId, ACTION_TIMEOUT, 3));
    context.stopService(new Intent(context, JunLuoIncomingCallService.class));
    JunLuoIncomingCallActivity.dismissIfShowing(invitationId);
    if (!"answered".equals(status)) IncomingCallWindowController.setActiveVisible(false);
    JunLuoIncomingCallModule.emit(context, record, status);
    if ("answered".equals(status)) {
      Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
      if (launch != null) {
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launch.putExtra("junluoIncomingCallAction", "answered");
        launch.putExtra("junluoInvitationId", invitationId);
        context.startActivity(launch);
      }
    }
  }
}
