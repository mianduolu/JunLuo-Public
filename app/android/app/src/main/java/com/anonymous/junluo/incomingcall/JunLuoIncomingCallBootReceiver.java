package com.anonymous.junluo.incomingcall;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONArray;
import org.json.JSONObject;

public class JunLuoIncomingCallBootReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
    long now = System.currentTimeMillis();
    JSONArray records = IncomingCallStorage.load(context);
    for (int index = 0; index < records.length(); index++) {
      JSONObject item = records.optJSONObject(index);
      if (item == null || !"scheduled".equals(item.optString("status"))) continue;
      String invitationId = item.optString("invitationId");
      long scheduledAt = item.optLong("scheduledAt");
      if (!invitationId.isEmpty() && scheduledAt > now) {
        JunLuoIncomingCallModule.scheduleRing(context, invitationId, scheduledAt);
      }
    }
  }
}
