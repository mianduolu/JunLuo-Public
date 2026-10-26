package com.anonymous.junluo.strongalarm;

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
