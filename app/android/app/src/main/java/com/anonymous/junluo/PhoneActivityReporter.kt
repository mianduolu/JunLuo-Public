package com.anonymous.junluo

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

object PhoneActivityReporter {
    private const val TAG = "PhoneActivityReporter"
    private const val DATABASE_NAME = "junluo-phone-activity-native.db"
    private const val DATABASE_VERSION = 1

    data class ReportPayload(
        val device_id: String = "junluo-android",
        val kind: String,
        val source: String,
        val title: String,
        val summary: String = "",
        val started_at: Long? = null,
        val ended_at: Long? = null,
        val duration_ms: Long = 0,
        val sensitive_level: String = "normal"
    )

    private class Store(context: Context) : SQLiteOpenHelper(
        context.applicationContext,
        DATABASE_NAME,
        null,
        DATABASE_VERSION
    ) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """
                CREATE TABLE IF NOT EXISTS phone_activity_logs (
                  id TEXT PRIMARY KEY NOT NULL,
                  device_id TEXT NOT NULL DEFAULT 'junluo-android',
                  kind TEXT NOT NULL,
                  source TEXT NOT NULL DEFAULT '',
                  title TEXT NOT NULL DEFAULT '',
                  summary TEXT NOT NULL DEFAULT '',
                  started_at INTEGER,
                  ended_at INTEGER,
                  duration_ms INTEGER NOT NULL DEFAULT 0,
                  sensitive_level TEXT NOT NULL DEFAULT 'normal',
                  created_at INTEGER NOT NULL
                )
                """.trimIndent()
            )
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_phone_activity_created ON phone_activity_logs(created_at DESC)")
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            onCreate(db)
        }
    }

    @Volatile
    private var store: Store? = null

    @Volatile
    private var quiescedForRestore = false

    private fun getStore(context: Context): Store {
        return store ?: synchronized(this) {
            store ?: Store(context).also { store = it }
        }
    }

    @Synchronized
    fun report(context: Context, payload: ReportPayload): Boolean {
        if (quiescedForRestore) return false
        val now = System.currentTimeMillis()
        val id = "${payload.kind}:${payload.source}:${payload.started_at ?: now}:$now"
        return try {
            val values = ContentValues().apply {
                put("id", id)
                put("device_id", payload.device_id)
                put("kind", payload.kind)
                put("source", payload.source)
                put("title", payload.title)
                put("summary", payload.summary.ifBlank { payload.title })
                if (payload.started_at != null) put("started_at", payload.started_at) else putNull("started_at")
                if (payload.ended_at != null) put("ended_at", payload.ended_at) else putNull("ended_at")
                put("duration_ms", payload.duration_ms)
                put("sensitive_level", payload.sensitive_level)
                put("created_at", now)
            }
            getStore(context).writableDatabase.insertWithOnConflict(
                "phone_activity_logs",
                null,
                values,
                SQLiteDatabase.CONFLICT_REPLACE
            )
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save phone activity: ${e.message}", e)
            false
        }
    }

    @Synchronized
    fun queryLogsJson(context: Context, sinceMs: Long, limit: Int): String {
        if (quiescedForRestore) return "[]"
        val safeLimit = limit.coerceIn(1, 5000)
        val args = mutableListOf<String>()
        val where = if (sinceMs > 0) {
            args.add(sinceMs.toString())
            "created_at >= ?"
        } else {
            null
        }
        val array = JSONArray()
        val cursor = getStore(context).readableDatabase.query(
            "phone_activity_logs",
            arrayOf("id", "device_id", "kind", "source", "title", "summary", "started_at", "ended_at", "duration_ms", "sensitive_level", "created_at"),
            where,
            if (args.isEmpty()) null else args.toTypedArray(),
            null,
            null,
            "created_at DESC",
            safeLimit.toString()
        )
        cursor.use {
            while (it.moveToNext()) {
                val item = JSONObject()
                item.put("id", it.getString(0))
                item.put("device_id", it.getString(1))
                item.put("kind", it.getString(2))
                item.put("source", it.getString(3))
                item.put("title", it.getString(4))
                item.put("summary", it.getString(5))
                if (it.isNull(6)) item.put("started_at", JSONObject.NULL) else item.put("started_at", it.getLong(6))
                if (it.isNull(7)) item.put("ended_at", JSONObject.NULL) else item.put("ended_at", it.getLong(7))
                item.put("duration_ms", it.getLong(8))
                item.put("sensitive_level", it.getString(9))
                item.put("created_at", it.getLong(10))
                array.put(item)
            }
        }
        return array.toString()
    }

    /** Open only an existing database, without SQLiteOpenHelper initialization or upgrade. */
    @Synchronized
    fun queryRestrictionLogsReadOnly(context: Context, sinceMs: Long, limit: Int): String {
        val unknown = JSONObject().put("available", false).put("truncated", JSONObject.NULL).put("logs", JSONObject.NULL)
        if (quiescedForRestore || PhoneFocusRules.restorePaused || sinceMs < 0 ||
            sinceMs > 9_007_199_254_740_991L || limit !in 1..5000) return unknown.toString()
        return try {
            val file = context.getDatabasePath(DATABASE_NAME)
            if (!file.isFile) return unknown.toString()
            val logs = JSONArray()
            var truncated = false
            // The default corruption handler may delete files; this query only reports unavailable.
            SQLiteDatabase.openDatabase(file.absolutePath, null, SQLiteDatabase.OPEN_READONLY,
                android.database.DatabaseErrorHandler { _ -> }).use { database ->
                database.query("phone_activity_logs",
                    arrayOf("id", "device_id", "kind", "source", "title", "summary", "started_at", "ended_at", "duration_ms", "sensitive_level", "created_at"),
                    if (sinceMs > 0) "created_at >= ?" else null,
                    if (sinceMs > 0) arrayOf(sinceMs.toString()) else null,
                    null, null, "created_at DESC", (limit + 1).toString()).use { cursor ->
                    while (cursor.moveToNext()) {
                        if (logs.length() == limit) { truncated = true; break }
                        logs.put(JSONObject().put("id", cursor.getString(0)).put("device_id", cursor.getString(1))
                            .put("kind", cursor.getString(2)).put("source", cursor.getString(3))
                            .put("title", cursor.getString(4)).put("summary", cursor.getString(5))
                            .put("started_at", if (cursor.isNull(6)) JSONObject.NULL else cursor.getLong(6))
                            .put("ended_at", if (cursor.isNull(7)) JSONObject.NULL else cursor.getLong(7))
                            .put("duration_ms", cursor.getLong(8)).put("sensitive_level", cursor.getString(9))
                            .put("created_at", cursor.getLong(10)))
                    }
                }
            }
            if (quiescedForRestore || PhoneFocusRules.restorePaused) unknown.toString()
            else JSONObject().put("available", true).put("truncated", truncated).put("logs", logs).toString()
        } catch (_: Exception) { unknown.toString() }
    }

    @Synchronized
    fun queryRestrictionUsageIntervals(context: Context, from: Long, until: Long): JSONObject {
        check(!quiescedForRestore)
        require(from > 0L && until >= from)
        val intervals = JSONArray()
        var truncated = false
        if (until > from) getStore(context).readableDatabase.query(
            "phone_activity_logs", arrayOf("source", "started_at", "ended_at"),
            "kind = ? AND started_at < ? AND ended_at > ? AND ended_at > started_at",
            arrayOf("foreground_app_duration", until.toString(), from.toString()),
            null, null, "started_at ASC, id ASC", "5001",
        ).use { cursor ->
            while (cursor.moveToNext()) {
                if (intervals.length() == 5000) { truncated = true; break }
                intervals.put(JSONObject().put("packageName", cursor.getString(0))
                    .put("from", cursor.getLong(1)).put("until", cursor.getLong(2)))
            }
        }
        return JSONObject().put("intervals", intervals).put("truncated", truncated)
    }

    @Synchronized
    fun queryLogsPageForRestoreJson(
        context: Context,
        afterCreatedAt: Long,
        afterId: String,
        limit: Int
    ): String {
        check(quiescedForRestore) { "Phone activity collector is not quiesced for restore" }
        val safeLimit = limit.coerceIn(1, 1000)
        val array = JSONArray()
        val cursor = getStore(context).readableDatabase.query(
            "phone_activity_logs",
            arrayOf("id", "device_id", "kind", "source", "title", "summary", "started_at", "ended_at", "duration_ms", "sensitive_level", "created_at"),
            "created_at > ? OR (created_at = ? AND id > ?)",
            arrayOf(afterCreatedAt.toString(), afterCreatedAt.toString(), afterId),
            null,
            null,
            "created_at ASC, id ASC",
            safeLimit.toString()
        )
        cursor.use {
            while (it.moveToNext()) {
                val item = JSONObject()
                item.put("id", it.getString(0))
                item.put("device_id", it.getString(1))
                item.put("kind", it.getString(2))
                item.put("source", it.getString(3))
                item.put("title", it.getString(4))
                item.put("summary", it.getString(5))
                if (it.isNull(6)) item.put("started_at", JSONObject.NULL) else item.put("started_at", it.getLong(6))
                if (it.isNull(7)) item.put("ended_at", JSONObject.NULL) else item.put("ended_at", it.getLong(7))
                item.put("duration_ms", it.getLong(8))
                item.put("sensitive_level", it.getString(9))
                item.put("created_at", it.getLong(10))
                array.put(item)
            }
        }
        return array.toString()
    }

    @Synchronized
    fun quiesceForRestore() {
        quiescedForRestore = true
        store?.close()
        store = null
    }

    @Synchronized
    fun discardForRestore(context: Context): Boolean {
        if (!quiescedForRestore) return false
        store?.close()
        store = null
        val appContext = context.applicationContext
        val databaseFile = appContext.getDatabasePath(DATABASE_NAME)
        if (!databaseFile.exists()) return true
        return appContext.deleteDatabase(DATABASE_NAME) && !databaseFile.exists()
    }

    @Synchronized
    fun resumeAfterRestore() {
        quiescedForRestore = false
    }
}
