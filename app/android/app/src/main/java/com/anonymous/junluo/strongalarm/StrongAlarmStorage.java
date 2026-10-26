package com.anonymous.junluo.strongalarm;

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
