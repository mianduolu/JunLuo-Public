package com.anonymous.junluo

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal const val GUARDIAN_EVENT_NAME = "junluoBodySignalGuardian"
internal const val GUARDIAN_PREFS = "junluo_body_signal_guardian"

internal enum class GuardianStatus(val wireValue: String) {
    IDLE("idle"), STARTING("starting"), CONNECTING("connecting"),
    DISCOVERING("discovering"), AUTHENTICATING("authenticating"), READY("ready"),
    SAMPLING("sampling"), SUSPENDED("suspended"), STOPPING("stopping"), ERROR("error");

    companion object {
        fun fromWire(value: String?): GuardianStatus = entries.firstOrNull {
            it.wireValue == value
        } ?: IDLE
    }
}

internal enum class GuardianOwner(val wireValue: String) {
    LEGACY_JS("legacy_js"), NATIVE_GUARDIAN("native_guardian");

    companion object {
        fun fromWire(value: String?): GuardianOwner = entries.firstOrNull {
            it.wireValue == value
        } ?: LEGACY_JS
    }
}

internal data class GuardianState(
    val status: GuardianStatus = GuardianStatus.IDLE,
    val owner: GuardianOwner = GuardianOwner.LEGACY_JS,
    val enabled: Boolean = false,
    val paused: Boolean = false,
    val appeared: Boolean = false,
    val deviceProfileId: String? = null,
    val associationId: Int? = null,
    val sessionId: String? = null,
    val samplingEndsAt: Long? = null,
    val samplingMode: GuardianSamplingMode? = null,
    val scheduledSamplingEnabled: Boolean = false,
    val scheduledSamplingPauseUntil: Long? = null,
    val scheduledSamplingStatus: GuardianScheduledSamplingStatus = GuardianScheduledSamplingStatus.DISABLED,
    val nextSamplingDueAt: Long? = null,
    val lastScheduledSamplingStartedAt: Long? = null,
    val lastScheduledSamplingEndedAt: Long? = null,
    val lastScheduledSamplingResult: String? = null,
    val lastScheduledSamplingReason: String? = null,
    val lastScheduledSamplingReadingCount: Int = 0,
    val lastConnectedAt: Long? = null,
    val lastHeartRateAt: Long? = null,
    val retryAttempt: Int = 0,
    val lastErrorCode: String? = null,
    val lastTransitionAt: Long = System.currentTimeMillis(),
) {
    fun withoutLiveSession(now: Long = System.currentTimeMillis()): GuardianState {
        val connectionWasLive = status in setOf(
            GuardianStatus.STARTING, GuardianStatus.CONNECTING, GuardianStatus.DISCOVERING,
            GuardianStatus.AUTHENTICATING, GuardianStatus.READY, GuardianStatus.SAMPLING, GuardianStatus.STOPPING,
        )
        val scheduledWindowInterrupted = samplingMode == GuardianSamplingMode.SCHEDULED_2_MINUTE
            || scheduledSamplingStatus == GuardianScheduledSamplingStatus.EVALUATING
            || scheduledSamplingStatus == GuardianScheduledSamplingStatus.SAMPLING
        return copy(
            status = if (connectionWasLive) {
                if (paused) GuardianStatus.SUSPENDED else GuardianStatus.IDLE
            } else status,
            sessionId = null,
            samplingEndsAt = null,
            samplingMode = null,
            scheduledSamplingStatus = if (scheduledWindowInterrupted) {
                when {
                    !scheduledSamplingEnabled -> GuardianScheduledSamplingStatus.DISABLED
                    scheduledSamplingPauseUntil != null && scheduledSamplingPauseUntil > now -> GuardianScheduledSamplingStatus.PAUSED
                    else -> GuardianScheduledSamplingStatus.WAITING
                }
            } else scheduledSamplingStatus,
            // A lost window must not be replayed immediately; an ordinary idle restart keeps its due time.
            nextSamplingDueAt = if (scheduledWindowInterrupted && scheduledSamplingEnabled) {
                maxOf(nextSamplingDueAt ?: 0L, now + SCHEDULED_SAMPLING_INTERVAL_MS)
            } else nextSamplingDueAt,
        )
    }

    fun canRestoreConnectionAfterRestart(): Boolean = enabled && !paused && appeared
        && owner == GuardianOwner.NATIVE_GUARDIAN && status == GuardianStatus.IDLE
        && deviceProfileId != null && associationId != null

    fun toJson(): JSONObject = JSONObject().apply {
        put("status", status.wireValue)
        put("owner", owner.wireValue)
        put("enabled", enabled)
        put("paused", paused)
        put("appeared", appeared)
        putOpt("deviceProfileId", deviceProfileId)
        associationId?.let { put("associationId", it) }
        putOpt("sessionId", sessionId)
        samplingEndsAt?.let { put("samplingEndsAt", it) }
        samplingMode?.let { put("samplingMode", it.wireValue) }
        put("scheduledSamplingEnabled", scheduledSamplingEnabled)
        scheduledSamplingPauseUntil?.let { put("scheduledSamplingPauseUntil", it) }
        put("scheduledSamplingStatus", scheduledSamplingStatus.wireValue)
        nextSamplingDueAt?.let { put("nextSamplingDueAt", it) }
        lastScheduledSamplingStartedAt?.let { put("lastScheduledSamplingStartedAt", it) }
        lastScheduledSamplingEndedAt?.let { put("lastScheduledSamplingEndedAt", it) }
        putOpt("lastScheduledSamplingResult", lastScheduledSamplingResult)
        putOpt("lastScheduledSamplingReason", lastScheduledSamplingReason)
        put("lastScheduledSamplingReadingCount", lastScheduledSamplingReadingCount)
        lastConnectedAt?.let { put("lastConnectedAt", it) }
        lastHeartRateAt?.let { put("lastHeartRateAt", it) }
        put("retryAttempt", retryAttempt)
        putOpt("lastErrorCode", lastErrorCode)
        put("lastTransitionAt", lastTransitionAt)
    }

    fun toWritableMap(): WritableMap = Arguments.createMap().apply {
        putString("status", status.wireValue)
        putString("owner", owner.wireValue)
        putBoolean("enabled", enabled)
        putBoolean("paused", paused)
        putBoolean("appeared", appeared)
        deviceProfileId?.let { putString("deviceProfileId", it) }
        associationId?.let { putDouble("associationId", it.toDouble()) }
        sessionId?.let { putString("sessionId", it) }
        samplingEndsAt?.let { putDouble("samplingEndsAt", it.toDouble()) }
        samplingMode?.let { putString("samplingMode", it.wireValue) }
        putBoolean("scheduledSamplingEnabled", scheduledSamplingEnabled)
        scheduledSamplingPauseUntil?.let { putDouble("scheduledSamplingPauseUntil", it.toDouble()) }
        putString("scheduledSamplingStatus", scheduledSamplingStatus.wireValue)
        nextSamplingDueAt?.let { putDouble("nextSamplingDueAt", it.toDouble()) }
        lastScheduledSamplingStartedAt?.let { putDouble("lastScheduledSamplingStartedAt", it.toDouble()) }
        lastScheduledSamplingEndedAt?.let { putDouble("lastScheduledSamplingEndedAt", it.toDouble()) }
        lastScheduledSamplingResult?.let { putString("lastScheduledSamplingResult", it) }
        lastScheduledSamplingReason?.let { putString("lastScheduledSamplingReason", it) }
        putInt("lastScheduledSamplingReadingCount", lastScheduledSamplingReadingCount)
        lastConnectedAt?.let { putDouble("lastConnectedAt", it.toDouble()) }
        lastHeartRateAt?.let { putDouble("lastHeartRateAt", it.toDouble()) }
        putInt("retryAttempt", retryAttempt)
        lastErrorCode?.let { putString("lastErrorCode", it) }
        putDouble("lastTransitionAt", lastTransitionAt.toDouble())
    }

    companion object {
        fun fromJson(value: JSONObject): GuardianState = GuardianState(
            status = GuardianStatus.fromWire(value.optString("status")),
            owner = GuardianOwner.fromWire(value.optString("owner")),
            enabled = value.optBoolean("enabled", false),
            paused = value.optBoolean("paused", false),
            appeared = value.optBoolean("appeared", false),
            deviceProfileId = value.optString("deviceProfileId").takeIf { it.isNotBlank() },
            associationId = value.optInt("associationId", -1).takeIf { it >= 0 },
            sessionId = value.optString("sessionId").takeIf { it.isNotBlank() },
            samplingEndsAt = value.optLong("samplingEndsAt", -1L).takeIf { it >= 0L },
            samplingMode = GuardianSamplingMode.fromWire(value.optString("samplingMode")),
            scheduledSamplingEnabled = value.optBoolean("scheduledSamplingEnabled", false),
            scheduledSamplingPauseUntil = value.optLong("scheduledSamplingPauseUntil", -1L).takeIf { it >= 0L },
            scheduledSamplingStatus = GuardianScheduledSamplingStatus.fromWire(
                value.optString("scheduledSamplingStatus"),
            ),
            nextSamplingDueAt = value.optLong("nextSamplingDueAt", -1L).takeIf { it >= 0L },
            lastScheduledSamplingStartedAt = value.optLong(
                "lastScheduledSamplingStartedAt",
                -1L,
            ).takeIf { it >= 0L },
            lastScheduledSamplingEndedAt = value.optLong(
                "lastScheduledSamplingEndedAt",
                -1L,
            ).takeIf { it >= 0L },
            lastScheduledSamplingResult = value.optString("lastScheduledSamplingResult")
                .takeIf { it.isNotBlank() },
            lastScheduledSamplingReason = value.optString("lastScheduledSamplingReason")
                .takeIf { it.isNotBlank() },
            lastScheduledSamplingReadingCount = value.optInt("lastScheduledSamplingReadingCount", 0),
            lastConnectedAt = value.optLong("lastConnectedAt", -1L).takeIf { it >= 0L },
            lastHeartRateAt = value.optLong("lastHeartRateAt", -1L).takeIf { it >= 0L },
            retryAttempt = value.optInt("retryAttempt", 0),
            lastErrorCode = value.optString("lastErrorCode").takeIf { it.isNotBlank() },
            lastTransitionAt = value.optLong("lastTransitionAt", System.currentTimeMillis()),
        )
    }
}

internal object BodySignalGuardianStore {
    private const val STATE_KEY = "state"
    private val lock = Any()

    fun load(context: Context): GuardianState = synchronized(lock) {
        val raw = context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE)
            .getString(STATE_KEY, null)
            ?: return@synchronized GuardianState()
        runCatching { GuardianState.fromJson(JSONObject(raw)) }.getOrDefault(GuardianState())
    }

    fun save(context: Context, state: GuardianState): GuardianState = synchronized(lock) {
        context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE)
            .edit().putString(STATE_KEY, state.toJson().toString()).commit()
        BodySignalGuardianEmitter.emitState(state)
        state
    }

    fun update(context: Context, transform: (GuardianState) -> GuardianState): GuardianState = synchronized(lock) {
        val current = load(context)
        save(context, transform(current).copy(lastTransitionAt = System.currentTimeMillis()))
    }

    fun clearConfiguration(context: Context): GuardianState = save(context, GuardianState())
}

internal data class GuardianLedgerEvent(
    val eventId: String,
    val type: String,
    val observedAt: Long,
    val deviceProfileId: String,
    val bpm: Int? = null,
    val percent: Int? = null,
    val charging: Boolean? = null,
    val status: String? = null,
    val windowId: String? = null,
    val trigger: String? = null,
    val reason: String? = null,
    val result: String? = null,
    val requestedAt: Long? = null,
    val startedAt: Long? = null,
    val endedAt: Long? = null,
    val readingCount: Int? = null,
    val durationMs: Long? = null,
    val activityBatch: MiBand6ActivityBatch? = null,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("eventId", eventId)
        put("type", type)
        put("observedAt", observedAt)
        put("deviceProfileId", deviceProfileId)
        bpm?.let { put("bpm", it) }
        percent?.let { put("percent", it) }
        charging?.let { put("charging", it) }
        status?.let { put("status", it) }
        putOpt("windowId", windowId)
        putOpt("trigger", trigger)
        putOpt("reason", reason)
        putOpt("result", result)
        requestedAt?.let { put("requestedAt", it) }
        startedAt?.let { put("startedAt", it) }
        endedAt?.let { put("endedAt", it) }
        readingCount?.let { put("readingCount", it) }
        durationMs?.let { put("durationMs", it) }
        activityBatch?.let { put("batch", it.toJson()) }
    }

    fun toWritableMap(): WritableMap = Arguments.createMap().apply {
        putString("eventId", eventId)
        putString("type", type)
        putDouble("observedAt", observedAt.toDouble())
        putString("deviceProfileId", deviceProfileId)
        bpm?.let { putInt("bpm", it) }
        percent?.let { putInt("percent", it) }
        charging?.let { putBoolean("charging", it) }
        status?.let { putString("status", it) }
        windowId?.let { putString("windowId", it) }
        trigger?.let { putString("trigger", it) }
        reason?.let { putString("reason", it) }
        result?.let { putString("result", it) }
        requestedAt?.let { putDouble("requestedAt", it.toDouble()) }
        startedAt?.let { putDouble("startedAt", it.toDouble()) }
        endedAt?.let { putDouble("endedAt", it.toDouble()) }
        readingCount?.let { putInt("readingCount", it) }
        durationMs?.let { putDouble("durationMs", it.toDouble()) }
        activityBatch?.let { putMap("batch", it.toWritableMap()) }
    }

    companion object {
        fun fromJson(value: JSONObject): GuardianLedgerEvent? {
            val eventId = value.optString("eventId")
            val type = value.optString("type")
            val profileId = value.optString("deviceProfileId")
            if (eventId.isBlank() || type.isBlank() || profileId.isBlank()) return null
            return GuardianLedgerEvent(
                eventId = eventId,
                type = type,
                observedAt = value.optLong("observedAt"),
                deviceProfileId = profileId,
                bpm = value.optInt("bpm", -1).takeIf { it in 1..300 },
                percent = value.optInt("percent", -1).takeIf { it in 0..100 },
                charging = if (value.has("charging")) value.optBoolean("charging") else null,
                status = value.optString("status").takeIf { it.isNotBlank() },
                windowId = value.optString("windowId").takeIf { it.isNotBlank() },
                trigger = value.optString("trigger").takeIf { it.isNotBlank() },
                reason = value.optString("reason").takeIf { it.isNotBlank() },
                result = value.optString("result").takeIf { it.isNotBlank() },
                requestedAt = value.optLong("requestedAt", -1L).takeIf { it >= 0L },
                startedAt = value.optLong("startedAt", -1L).takeIf { it >= 0L },
                endedAt = value.optLong("endedAt", -1L).takeIf { it >= 0L },
                readingCount = value.optInt("readingCount", -1).takeIf { it >= 0 },
                durationMs = value.optLong("durationMs", -1L).takeIf { it >= 0L },
                activityBatch = value.optJSONObject("batch")?.let { runCatching { activityBatchFromJson(it) }.getOrNull() },
            )
        }
    }
}

internal object BodySignalGuardianLedger {
    private const val EVENTS_KEY = "pending_events"
    private const val MAX_EVENTS = 512
    private const val HEART_RATE_INTERVAL_MS = 15_000L
    internal val lock = Any()

    fun canAppendActivity(context: Context): Boolean = synchronized(lock) {
        val events = load(context)
        events.size < MAX_EVENTS && events.none { it.type == "activity_batch" }
    }

    fun recordActivity(context: Context, profileId: String, batch: MiBand6ActivityBatch): GuardianLedgerEvent? = synchronized(lock) {
        if (!MiBand6ActivityProtocol.PRODUCTION_ENABLED || !canAppendActivity(context)) return@synchronized null
        if (batch.toJson().toString().toByteArray(Charsets.UTF_8).size > 256 * 1024) return@synchronized null
        val event = GuardianLedgerEvent(UUID.randomUUID().toString(), "activity_batch", batch.observedAt, profileId,
            activityBatch = batch)
        // Activity never uses FIFO eviction to obtain space reserved for pending readings.
        if (!save(context, load(context) + event)) return@synchronized null
        BodySignalGuardianEmitter.emitEvent(event)
        event
    }

    fun recordBattery(context: Context, profileId: String, value: MiBand6BatteryValue, measuredAt: Long): GuardianLedgerEvent? {
        val event = GuardianLedgerEvent(
            eventId = UUID.randomUUID().toString(), type = "battery", observedAt = measuredAt,
            deviceProfileId = profileId, percent = value.percent, charging = value.charging,
        )
        return if (append(context, event)) event else null
    }

    fun recordState(context: Context, state: GuardianState) {
        val profileId = state.deviceProfileId ?: return
        append(context, GuardianLedgerEvent(
            eventId = UUID.randomUUID().toString(),
            type = "state",
            observedAt = state.lastTransitionAt,
            deviceProfileId = profileId,
            status = state.status.wireValue,
        ))
    }

    fun recordHeartRate(context: Context, deviceProfileId: String, bpm: Int, observedAt: Long): Boolean {
        if (bpm !in 1..300) return false
        synchronized(lock) {
            val events = load(context)
            val latest = events.asSequence()
                .filter { it.type == "heart_rate" && it.deviceProfileId == deviceProfileId }
                .maxByOrNull { it.observedAt }
            if (latest != null && observedAt - latest.observedAt < HEART_RATE_INTERVAL_MS) return false
            return appendLocked(context, events, GuardianLedgerEvent(
                eventId = UUID.randomUUID().toString(),
                type = "heart_rate",
                observedAt = observedAt,
                deviceProfileId = deviceProfileId,
                bpm = bpm,
            ))
        }
    }

    fun recordSamplingWindow(
        context: Context,
        deviceProfileId: String,
        windowId: String,
        trigger: ScheduledSamplingTrigger,
        reason: ScheduledSamplingReason,
        result: ScheduledSamplingResult,
        requestedAt: Long,
        startedAt: Long?,
        endedAt: Long,
        readingCount: Int,
    ) {
        append(context, GuardianLedgerEvent(
            eventId = "sampling-window:$windowId",
            type = "sampling_window",
            observedAt = endedAt,
            deviceProfileId = deviceProfileId,
            windowId = windowId,
            trigger = trigger.wireValue,
            reason = reason.wireValue,
            result = result.wireValue,
            requestedAt = requestedAt,
            startedAt = startedAt,
            endedAt = endedAt,
            readingCount = readingCount,
            durationMs = ((startedAt ?: endedAt).let { endedAt - it }).coerceAtLeast(0L),
        ))
    }

    fun peek(context: Context): List<GuardianLedgerEvent> = synchronized(lock) { load(context) }

    fun peekWritable(context: Context): WritableArray = Arguments.createArray().apply {
        peek(context).forEach { pushMap(it.toWritableMap()) }
    }

    fun acknowledge(context: Context, eventIds: Set<String>): Boolean = synchronized(lock) {
        if (eventIds.isEmpty()) return@synchronized true
        val events = load(context)
        val editor = context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE).edit()
        events.filter { it.eventId in eventIds && it.type == "activity_batch" }.forEach {
            MiBand6ActivitySyncStore.acknowledgeInto(context, editor, it)
        }
        val remaining = JSONArray().apply { events.filterNot { it.eventId in eventIds }.forEach { put(it.toJson()) } }
        editor.putString(EVENTS_KEY, remaining.toString()).commit()
    }

    private fun append(context: Context, event: GuardianLedgerEvent) = synchronized(lock) {
        appendLocked(context, load(context), event)
    }

    private fun appendLocked(context: Context, current: List<GuardianLedgerEvent>, event: GuardianLedgerEvent): Boolean {
        val next = if (current.none { it.type == "activity_batch" }) (current + event).takeLast(MAX_EVENTS)
        else (current + event).toMutableList().apply {
            while (size > MAX_EVENTS) {
                val disposable = indexOfFirst { it.type != "activity_batch" }
                if (disposable < 0) return false
                removeAt(disposable)
            }
        }
        if (!save(context, next)) return false
        BodySignalGuardianEmitter.emitEvent(event)
        return true
    }

    private fun load(context: Context): List<GuardianLedgerEvent> {
        val raw = context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE)
            .getString(EVENTS_KEY, "[]") ?: "[]"
        val array = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        return buildList {
            for (index in 0 until array.length()) {
                GuardianLedgerEvent.fromJson(array.optJSONObject(index) ?: continue)?.let(::add)
            }
        }
    }

    private fun save(context: Context, events: List<GuardianLedgerEvent>): Boolean {
        val array = JSONArray()
        events.forEach { array.put(it.toJson()) }
        return context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE)
            .edit().putString(EVENTS_KEY, array.toString()).commit()
    }
}

internal object BodySignalGuardianEmitter {
    @Volatile private var reactContext: ReactApplicationContext? = null

    fun attach(context: ReactApplicationContext) { reactContext = context }
    fun detach(context: ReactApplicationContext) { if (reactContext === context) reactContext = null }

    fun emitState(state: GuardianState) = emit(Arguments.createMap().apply {
        putString("type", "state")
        putMap("state", state.toWritableMap())
    })

    fun emitEvent(event: GuardianLedgerEvent) = emit(Arguments.createMap().apply {
        putString("type", "event")
        putMap("event", event.toWritableMap())
    })

    private fun emit(payload: WritableMap) {
        val context = reactContext ?: return
        if (!context.hasActiveReactInstance()) return
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(GUARDIAN_EVENT_NAME, payload)
    }
}

internal object BodySignalGuardianVault {
    private const val KEY_ALIAS = "junluo_body_signal_guardian_auth_v1"
    private const val CIPHER_TEXT_KEY = "vault_ciphertext"
    private const val IV_KEY = "vault_iv"

    fun provision(context: Context, authKey: ByteArray) {
        require(authKey.size == 16) { "Mi Band 6 guardian auth key must be 16 bytes." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(authKey)
        context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE).edit()
            .putString(CIPHER_TEXT_KEY, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .putString(IV_KEY, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .commit()
    }

    fun load(context: Context): ByteArray? {
        val preferences = context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE)
        val ciphertext = preferences.getString(CIPHER_TEXT_KEY, null) ?: return null
        val iv = preferences.getString(IV_KEY, null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP))
        }.getOrNull()?.takeIf { it.size == 16 }
    }

    fun clear(context: Context) {
        context.getSharedPreferences(GUARDIAN_PREFS, Context.MODE_PRIVATE).edit()
            .remove(CIPHER_TEXT_KEY).remove(IV_KEY).commit()
        runCatching {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS)
        }
    }

    private fun getOrCreateKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build())
        return generator.generateKey()
    }
}
