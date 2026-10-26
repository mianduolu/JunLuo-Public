package com.anonymous.junluo.incomingcall;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

public final class IncomingCallStorage {
  private static final String PREFS = "junluo_incoming_calls";
  private static final String RECORDS = "records";
  private static final String PENDING_ACTION = "pending_action";

  private IncomingCallStorage() {}

  private static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  public static synchronized JSONArray load(Context context) {
    try { return new JSONArray(prefs(context).getString(RECORDS, "[]")); }
    catch (Exception ignored) { return new JSONArray(); }
  }

  public static synchronized JSONObject find(Context context, String invitationId) {
    JSONArray records = load(context);
    for (int index = 0; index < records.length(); index++) {
      JSONObject item = records.optJSONObject(index);
      if (item != null && invitationId.equals(item.optString("invitationId"))) return item;
    }
    return null;
  }

  public static synchronized boolean hasOtherRinging(Context context, String invitationId) {
    JSONArray records = load(context);
    for (int index = 0; index < records.length(); index++) {
      JSONObject item = records.optJSONObject(index);
      if (item == null) continue;
      if (!invitationId.equals(item.optString("invitationId")) && "ringing".equals(item.optString("status"))) {
        return true;
      }
    }
    return false;
  }

  public static synchronized void upsert(Context context, JSONObject record) {
    JSONArray records = load(context);
    JSONArray next = new JSONArray();
    String invitationId = record.optString("invitationId");
    for (int index = 0; index < records.length(); index++) {
      JSONObject item = records.optJSONObject(index);
      if (item != null && !invitationId.equals(item.optString("invitationId"))) next.put(item);
    }
    next.put(record);
    prefs(context).edit().putString(RECORDS, next.toString()).apply();
  }

  public static synchronized JSONObject transition(Context context, String invitationId, String expected, String status) {
    JSONObject current = find(context, invitationId);
    if (current == null || !expected.equals(current.optString("status"))) return null;
    try {
      current.put("status", status);
      current.put("updatedAt", System.currentTimeMillis());
      upsert(context, current);
      return current;
    } catch (Exception ignored) { return null; }
  }

  public static synchronized void setPendingAction(Context context, JSONObject action) {
    prefs(context).edit().putString(PENDING_ACTION, action.toString()).apply();
  }

  public static synchronized JSONObject consumePendingAction(Context context) {
    String raw = prefs(context).getString(PENDING_ACTION, "");
    prefs(context).edit().remove(PENDING_ACTION).apply();
    try { return raw.isEmpty() ? null : new JSONObject(raw); }
    catch (Exception ignored) { return null; }
  }
}
