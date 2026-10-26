package com.anonymous.junluo

import android.content.Context
import android.Manifest
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import android.content.SharedPreferences
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import org.json.JSONArray
import org.json.JSONObject

internal fun MiBand6ActivityBatch.toJson(): JSONObject = JSONObject().apply {
    put("requestedSinceAt", requestedSinceAt); put("startedAt", startedAt); put("observedAt", observedAt)
    put("reportedSize", reportedSize); put("byteCount", byteCount); put("packetCount", packetCount)
    put("samples", JSONArray().apply { samples.forEach { put(JSONArray().put(it.first).put(it.second)) } })
}

internal fun MiBand6ActivityBatch.toWritableMap(): WritableMap = Arguments.createMap().apply {
    putDouble("requestedSinceAt", requestedSinceAt.toDouble()); putDouble("startedAt", startedAt.toDouble())
    putDouble("observedAt", observedAt.toDouble()); putDouble("reportedSize", reportedSize.toDouble())
    putInt("byteCount", byteCount); putInt("packetCount", packetCount)
    putArray("samples", Arguments.createArray().apply {
        samples.forEach { pair -> pushArray(Arguments.createArray().apply { pushInt(pair.first); pushInt(pair.second) }) }
    })
}

internal fun activityBatchFromJson(value: JSONObject): MiBand6ActivityBatch {
    require(value.toString().toByteArray(Charsets.UTF_8).size <= 256 * 1024) { "activity_normalized_size_exceeded" }
    val array = value.getJSONArray("samples")
    require(array.length() <= MiBand6ActivityProtocol.MAX_RECORDS) { "activity_record_limit" }
    val batch = MiBand6ActivityBatch(value.getLong("requestedSinceAt"), value.getLong("startedAt"),
        value.getLong("observedAt"), (0 until array.length()).map {
            val pair = array.getJSONArray(it)
            require(pair.length() == 2) { "activity_invalid_sample" }
            val steps = pair.getInt(0); val intensity = pair.getInt(1)
            require(steps in 0..255 && intensity in 0..255) { "activity_invalid_sample" }
            steps to intensity
        }, value.getLong("reportedSize"), value.getInt("byteCount"), value.getInt("packetCount"))
    require(batch.requestedSinceAt > 0 && batch.requestedSinceAt <= batch.startedAt
        && batch.requestedSinceAt % 60_000 == 0L && batch.startedAt % 60_000 == 0L
        && batch.startedAt + batch.samples.size * 60_000L <= batch.observedAt
        && batch.observedAt <= System.currentTimeMillis() && batch.reportedSize in 0..MiBand6ActivityProtocol.MAX_RECORDS.toLong()
        && batch.byteCount in batch.samples.size * 8..MiBand6ActivityProtocol.MAX_BYTES
        && batch.byteCount % 8 == 0 && batch.packetCount in 0..MiBand6ActivityProtocol.MAX_PACKETS) { "activity_invalid_batch" }
    val closedCount = minOf(batch.reportedSize, (batch.observedAt - batch.startedAt) / 60_000L)
    require(batch.byteCount.toLong() == batch.reportedSize * 8 && batch.samples.size.toLong() == closedCount
        && (batch.reportedSize == 0L || batch.startedAt + (batch.reportedSize - 1) * 60_000L <= batch.observedAt)) {
        "activity_length_mismatch"
    }
    return batch
}

internal object MiBand6ActivitySyncStore {
    const val COOLDOWN_MS = 30L * 60L * 1000L
    val triggers = setOf("manual", "connected", "foreground", "guardian_wakeup", "sampling_finished")
    private fun prefs(context: Context) = context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE)
    private fun key(profileId: String) = "activity_sync:$profileId"
    private fun load(context: Context, profileId: String) = runCatching {
        JSONObject(prefs(context).getString(key(profileId), "{}") ?: "{}")
    }.getOrDefault(JSONObject())

    fun initialSince(now: Long): Long = MiBand6ActivityProtocol.retainedSince(now)

    fun state(context: Context, profileId: String): JSONObject = synchronized(BodySignalGuardianLedger.lock) {
        load(context, profileId).put("deviceProfileId", profileId)
            .put("formallyVerified", MiBand6ActivityProtocol.PRODUCTION_ENABLED)
    }

    fun automaticReason(context: Context, profileId: String, now: Long): String? {
        val state = BodySignalGuardianStore.load(context)
        val native = state.owner == GuardianOwner.NATIVE_GUARDIAN
        if (state.paused || (state.scheduledSamplingPauseUntil ?: 0) > now) return "activity_paused"
        if (native && state.scheduledSamplingEnabled && (state.nextSamplingDueAt ?: now) <= now + 95_000L) return "activity_heart_rate_due"
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val power = context.getSystemService(PowerManager::class.java)
        val wearable = MiBand6BatteryStore.trusted(context, profileId)
        val permissions = (Build.VERSION.SDK_INT < 31 || ContextCompat.checkSelfPermission(context,
            Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) && (!native || Build.VERSION.SDK_INT < 33
            || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        val decision = BodySignalScheduledSamplingPolicy.decide(ScheduledSamplingDecisionInput(
            now = now, enabled = true, pauseUntil = null, nextDueAt = now, supportedDevice = true,
            manualSessionActive = false, permissionsGranted = permissions,
            appeared = !native || state.appeared, guardianReady = !native || (state.enabled && state.status == GuardianStatus.READY),
            phoneBatteryPercent = if (level >= 0 && scale > 0) (level * 100 / scale).coerceIn(0, 100) else null,
            phoneCharging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL,
            wearableBatteryPercent = wearable?.first, wearableBatteryMeasuredAt = wearable?.second,
            powerSaveMode = power.isPowerSaveMode, thermalSevere = Build.VERSION.SDK_INT >= 29
                && power.currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE))
        return if (decision == ScheduledSamplingReason.DUE) null else "activity_${decision.wireValue}"
    }

    fun claim(context: Context, profileId: String, trigger: String, diagnostic: Boolean, now: Long): Long =
        synchronized(BodySignalGuardianLedger.lock) {
            require(profileId.isNotBlank()) { "activity_profile_missing" }
            require(trigger in triggers && (!diagnostic || trigger == "manual")) { "activity_invalid_trigger" }
            require(diagnostic || MiBand6ActivityProtocol.PRODUCTION_ENABLED) { "activity_evidence_required" }
            if (trigger != "manual") automaticReason(context, profileId, now)?.let { throw IllegalStateException(it) }
            val previous = load(context, profileId)
            require(now - previous.optLong("lastAttemptAt") >= 10_000L) { "activity_cooldown" }
            require(previous.optLong("inFlightUntil") <= now) { "activity_busy" }
            if (trigger != "manual") require(now - previous.optLong("cooldownFrom") >= COOLDOWN_MS) { "activity_cooldown" }
            require(BodySignalGuardianLedger.canAppendActivity(context)) { "activity_queue_full" }
            previous.put("lastAttemptAt", now).put("trigger", trigger).put("status", "syncing")
                .put("inFlightUntil", now + 95_000L).remove("lastErrorCode")
            if (trigger != "manual") previous.put("cooldownFrom", now + 95_000L)
            require(prefs(context).edit().putString(key(profileId), previous.toString()).commit()) { "activity_save_failed" }
            if (diagnostic) initialSince(now) else MiBand6ActivityProtocol.retainedSince(now, previous.optLong("syncedThroughAt"))
        }

    fun finish(context: Context, profileId: String, trigger: String, batch: MiBand6ActivityBatch?, error: String?, diagnostic: Boolean) =
        synchronized(BodySignalGuardianLedger.lock) {
            val record = load(context, profileId)
            val now = System.currentTimeMillis()
            record.put("inFlightUntil", 0).put("status", if (error != null) "error" else if (diagnostic) "candidate" else "pending_save")
            if (!diagnostic && error == null && batch != null && record.optLong("lastSuccessAt") >= batch.observedAt) {
                record.put("status", "completed")
            }
            if (error != null) record.put("lastErrorCode", error) else record.remove("lastErrorCode")
            if (trigger != "manual" || batch != null) record.put("cooldownFrom", now)
            if (batch != null) {
                record.put("lastReceivedAt", batch.observedAt).put("receivedCount", batch.samples.size)
                    .put("rangeStartedAt", batch.startedAt).put("rangeEndedAt", batch.startedAt + batch.samples.size * 60_000L)
                    .put("gap", batch.startedAt > batch.requestedSinceAt)
            }
            prefs(context).edit().putString(key(profileId), record.toString()).commit()
        }

    fun restoreCursor(context: Context, profileId: String, cursor: Long): Boolean = synchronized(BodySignalGuardianLedger.lock) {
        if (cursor <= 0 || cursor > System.currentTimeMillis() || cursor % 60_000 != 0L) return@synchronized false
        val record = load(context, profileId)
        record.put("syncedThroughAt", maxOf(record.optLong("syncedThroughAt"), cursor))
        prefs(context).edit().putString(key(profileId), record.toString()).commit()
    }

    // Called with the ledger lock; cursor and removal use the SAME SharedPreferences commit.
    fun acknowledgeInto(context: Context, editor: SharedPreferences.Editor, event: GuardianLedgerEvent) {
        val batch = event.activityBatch ?: return
        val record = load(context, event.deviceProfileId)
        if (batch.samples.isNotEmpty()) record.put("syncedThroughAt", maxOf(record.optLong("syncedThroughAt"),
            batch.startedAt + batch.samples.size * 60_000L))
        record.put("lastSuccessAt", maxOf(record.optLong("lastSuccessAt"), batch.observedAt)).put("status", "completed")
        editor.putString(key(event.deviceProfileId), record.toString())
    }
}
