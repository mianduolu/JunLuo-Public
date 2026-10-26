package com.anonymous.junluo

import android.Manifest
import android.companion.CompanionDeviceManager
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray

class BodySignalGuardianModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    init {
        BodySignalGuardianEmitter.attach(reactContext)
    }

    override fun getName(): String = "JunLuoBodySignalGuardian"

    @ReactMethod
    fun getGuardianSupport(promise: Promise) {
        val apiSupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        val notificationGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(
                reactApplicationContext,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        val connectedDeviceGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || ContextCompat.checkSelfPermission(
                reactApplicationContext,
                Manifest.permission.BLUETOOTH_CONNECT,
            ) == PackageManager.PERMISSION_GRANTED
        promise.resolve(Arguments.createMap().apply {
            putBoolean("supported", apiSupported)
            putBoolean("notificationPermissionGranted", notificationGranted)
            putBoolean("bluetoothConnectPermissionGranted", connectedDeviceGranted)
            if (!apiSupported) putString("reason", "android_api_below_33")
        })
    }

    @ReactMethod
    fun provisionPrimaryDevice(
        deviceProfileId: String,
        associationId: Double,
        authKeyHex: String,
        appeared: Boolean,
        promise: Promise,
    ) {
        val id = associationId.toInt()
        runCatching {
            require(deviceProfileId.isNotBlank()) { "Primary device profile is required" }
            require(associationExists(id)) { "Android companion association is unavailable" }
            val authKey = parseAuthKey(authKeyHex)
            try {
                BodySignalGuardianVault.provision(reactApplicationContext, authKey)
            } finally {
                authKey.fill(0)
            }
            if (BodySignalGuardianStore.load(reactApplicationContext).deviceProfileId != deviceProfileId) {
                MiBand6BatteryStore.clearCache(reactApplicationContext)
            }
            val state = BodySignalGuardianStore.save(
                reactApplicationContext,
                GuardianState(
                    status = GuardianStatus.IDLE,
                    owner = GuardianOwner.LEGACY_JS,
                    enabled = false,
                    paused = false,
                    appeared = appeared,
                    deviceProfileId = deviceProfileId,
                    associationId = id,
                ),
            )
            BodySignalGuardianLedger.recordState(reactApplicationContext, state)
            state.toWritableMap()
        }.onSuccess(promise::resolve)
            .onFailure { promise.reject("GUARDIAN_PROVISION_FAILED", it.message, it) }
    }

    @ReactMethod
    fun enableGuardian(promise: Promise) {
        runCatching {
            val current = requireProvisionedState()
            val state = BodySignalGuardianStore.save(
                reactApplicationContext,
                current.copy(enabled = true, paused = false, lastErrorCode = null),
            )
            BodySignalGuardianLedger.recordState(reactApplicationContext, state)
            BodySignalGuardianController.start(reactApplicationContext, BodySignalGuardianController.ACTION_START)
            state.toWritableMap()
        }.onSuccess(promise::resolve)
            .onFailure { promise.reject("GUARDIAN_ENABLE_FAILED", it.message, it) }
    }

    @ReactMethod
    fun disableGuardian(promise: Promise) {
        BodySignalGuardianController.start(reactApplicationContext, BodySignalGuardianController.ACTION_DISABLE)
        promise.resolve(true)
    }

    @ReactMethod
    fun pauseGuardian(promise: Promise) {
        BodySignalGuardianController.start(reactApplicationContext, BodySignalGuardianController.ACTION_PAUSE)
        promise.resolve(true)
    }

    @ReactMethod
    fun resumeGuardian(promise: Promise) {
        BodySignalGuardianController.start(reactApplicationContext, BodySignalGuardianController.ACTION_RESUME)
        promise.resolve(true)
    }

    @ReactMethod
    fun retryGuardianNow(promise: Promise) {
        BodySignalGuardianController.start(reactApplicationContext, BodySignalGuardianController.ACTION_RETRY)
        promise.resolve(true)
    }

    @ReactMethod
    fun releaseGuardianForForegroundScan(promise: Promise) {
        val state = BodySignalGuardianStore.load(reactApplicationContext)
        if (state.enabled) {
            BodySignalGuardianController.start(reactApplicationContext, BodySignalGuardianController.ACTION_RELEASE)
        }
        promise.resolve(true)
    }

    @ReactMethod
    fun startGuardianFiveMinuteHeartRate(promise: Promise) {
        BodySignalGuardianService.startManualHeartRate(reactApplicationContext) { error ->
            if (error == null) promise.resolve(true)
            else promise.reject(error, error)
        }
    }

    @ReactMethod
    fun syncGuardianTime(promise: Promise) {
        BodySignalGuardianService.syncCurrentTime { error ->
            if (error == null) promise.resolve(System.currentTimeMillis().toDouble())
            else promise.reject(error, error)
        }
    }

    @ReactMethod
    fun readGuardianBatteryReading(deviceProfileId: String, trigger: String, promise: Promise) {
        BodySignalGuardianService.readBattery(deviceProfileId, trigger) { event, error ->
            if (error != null || event == null) promise.reject(error ?: "battery_save_failed", error ?: "battery_save_failed")
            else promise.resolve(event.toWritableMap())
        }
    }

    @ReactMethod
    fun beginLegacyMiBand6BatteryRead(deviceProfileId: String, trigger: String, promise: Promise) {
        if (BodySignalGuardianStore.load(reactApplicationContext).owner != GuardianOwner.LEGACY_JS) {
            promise.reject("battery_disconnected", "battery_disconnected"); return
        }
        val now = System.currentTimeMillis()
        val error = MiBand6BatteryStore.claim(reactApplicationContext, deviceProfileId, trigger, now)
        if (error != null) promise.reject(error, error) else promise.resolve(now.toDouble())
    }

    @ReactMethod
    fun restoreSavedGuardianBattery(deviceProfileId: String, percent: Double, measuredAt: Double, promise: Promise) {
        promise.resolve(percent.isFinite() && percent == percent.toInt().toDouble() && measuredAt.isFinite()
            && MiBand6BatteryStore.restoreSaved(reactApplicationContext, deviceProfileId, percent.toInt(), measuredAt.toLong()))
    }

    @ReactMethod
    fun completeLegacyMiBand6BatteryRead(deviceProfileId: String, trigger: String, attemptedAt: Double,
        percent: Double, charging: Boolean?, measuredAt: Double, promise: Promise) {
        val error = when {
            BodySignalGuardianStore.load(reactApplicationContext).owner != GuardianOwner.LEGACY_JS -> "battery_disconnected"
            !percent.isFinite() || percent != percent.toInt().toDouble() || percent !in 0.0..100.0
                || !measuredAt.isFinite() || measuredAt < attemptedAt -> "battery_invalid_packet"
            !MiBand6BatteryStore.matchesAttempt(reactApplicationContext, deviceProfileId, trigger, attemptedAt.toLong()) -> "battery_disconnected"
            else -> null
        }
        if (error != null) { promise.reject(error, error); return }
        val event = MiBand6BatteryStore.complete(reactApplicationContext, deviceProfileId, trigger,
            MiBand6BatteryValue(percent.toInt(), charging), measuredAt.toLong())
        if (event == null) promise.reject("battery_save_failed", "battery_save_failed") else promise.resolve(event.toWritableMap())
    }

    @ReactMethod
    fun stopGuardianHeartRate(promise: Promise) {
        BodySignalGuardianController.start(reactApplicationContext, BodySignalGuardianController.ACTION_SAMPLE_STOP)
        promise.resolve(true)
    }

    @ReactMethod
    fun configureScheduledSampling(enabled: Boolean, pauseUntil: Double?, promise: Promise) {
        runCatching {
            if (enabled) require(BodySignalGuardianStore.load(reactApplicationContext).enabled) {
                "Guardian must be enabled before scheduled sampling"
            }
            BodySignalGuardianController.start(
                reactApplicationContext,
                BodySignalGuardianController.ACTION_SCHEDULE_CONFIGURE,
            ) {
                putExtra(BodySignalGuardianController.EXTRA_SAMPLING_ENABLED, enabled)
                pauseUntil?.takeIf { it > 0 }?.let {
                    putExtra(BodySignalGuardianController.EXTRA_SAMPLING_PAUSE_UNTIL, it.toLong())
                }
            }
            true
        }.onSuccess(promise::resolve)
            .onFailure { promise.reject("GUARDIAN_SAMPLING_CONFIG_FAILED", it.message, it) }
    }

    @ReactMethod
    fun evaluateScheduledSampling(trigger: String, promise: Promise) {
        runCatching {
            require(ScheduledSamplingTrigger.entries.any { it.wireValue == trigger }) {
                "Unsupported scheduled sampling trigger"
            }
            BodySignalGuardianController.start(
                reactApplicationContext,
                BodySignalGuardianController.ACTION_SCHEDULE_EVALUATE,
            ) {
                putExtra(BodySignalGuardianController.EXTRA_SAMPLING_TRIGGER, trigger)
            }
            true
        }.onSuccess(promise::resolve)
            .onFailure { promise.reject("GUARDIAN_SAMPLING_EVALUATE_FAILED", it.message, it) }
    }

    @ReactMethod
    fun cancelScheduledSampling(promise: Promise) {
        BodySignalGuardianController.start(
            reactApplicationContext,
            BodySignalGuardianController.ACTION_SCHEDULE_CANCEL,
        )
        promise.resolve(true)
    }

    @ReactMethod
    fun getGuardianState(promise: Promise) {
        reactApplicationContext.runOnUiQueueThread {
            promise.resolve(BodySignalGuardianService.currentState(reactApplicationContext).toWritableMap())
        }
    }

    @ReactMethod
    fun getBodySignalCareState(promise: Promise) {
        promise.resolve(BodySignalCareStore.get(reactApplicationContext))
    }

    @ReactMethod
    fun compareAndSetBodySignalCareState(expectedRevision: Double, valueJson: String, promise: Promise) {
        val saved = BodySignalCareStore.compareAndSet(reactApplicationContext, expectedRevision.toLong(), valueJson)
        if (saved) BodySignalGuardianService.refreshCareWake(reactApplicationContext)
        promise.resolve(saved)
    }

    @ReactMethod
    fun releaseBodySignalCareDispatch(promise: Promise) {
        PhoneGuardMessageTaskService.releaseBodyCareDispatch()
        BodySignalGuardianService.refreshCareWake(reactApplicationContext)
        promise.resolve(true)
    }

    @ReactMethod
    fun resetBodySignalCareForRestore(promise: Promise) {
        val saved = BodySignalCareStore.resetForRestore(reactApplicationContext)
        BodySignalGuardianService.refreshCareWake(reactApplicationContext)
        promise.resolve(saved)
    }

    @ReactMethod
    fun getPendingGuardianEvents(promise: Promise) {
        promise.resolve(BodySignalGuardianLedger.peekWritable(reactApplicationContext))
    }

    @ReactMethod
    fun inspectMiBand6SleepHistory(deviceProfileId: String, window: String, promise: Promise) {
        BodySignalGuardianService.inspectMiBand6SleepHistory(deviceProfileId, window) { result, error ->
            if (error != null) promise.reject(error, error) else promise.resolve(result)
        }
    }

    @ReactMethod
    fun beginLegacyMiBand6SleepInspection(deviceProfileId: String, window: String, promise: Promise) {
        reactApplicationContext.runOnUiQueueThread {
            try {
                val now = System.currentTimeMillis()
                val lease = MiBand6SleepInspection.leases.claim(deviceProfileId, window,
                    BodySignalGuardianStore.load(reactApplicationContext), GuardianOwner.LEGACY_JS, now,
                    MiBand6ActivitySyncStore.state(reactApplicationContext, deviceProfileId).optLong("inFlightUntil"))
                promise.resolve(Arguments.createMap().apply {
                    putDouble("since", lease.since.toDouble()); putDouble("requestedAt", lease.requestedAt.toDouble())
                    putString("token", lease.token)
                })
            } catch (error: Exception) { promise.reject(error.message ?: "sleep_inspection_not_ready", error.message) }
        }
    }

    @ReactMethod
    fun finishLegacyMiBand6SleepInspection(token: String, promise: Promise) {
        reactApplicationContext.runOnUiQueueThread {
            val lease = MiBand6SleepInspection.leases.current(System.currentTimeMillis())
            promise.resolve(lease?.owner == GuardianOwner.LEGACY_JS && MiBand6SleepInspection.leases.release(token))
        }
    }

    @ReactMethod
    fun cancelMiBand6SleepInspection(deviceProfileId: String, promise: Promise) {
        // Legacy JS releases its token only after its own GATT subscription cleanup.
        BodySignalGuardianService.cancelMiBand6SleepInspection(deviceProfileId, promise::resolve)
    }

    @ReactMethod
    fun readGuardianActivity(deviceProfileId: String, trigger: String, diagnostic: Boolean, promise: Promise) {
        if (diagnostic) { promise.reject("activity_update_required", "activity_update_required"); return }
        BodySignalGuardianService.readActivity(deviceProfileId, trigger, diagnostic) { result, error ->
            if (error != null && (!diagnostic || result == null)) promise.reject(error, error) else promise.resolve(result)
        }
    }

    @ReactMethod
    fun getMiBand6ActivitySyncState(deviceProfileId: String, promise: Promise) {
        reactApplicationContext.runOnUiQueueThread {
            val state = MiBand6ActivitySyncStore.state(reactApplicationContext, deviceProfileId)
            promise.resolve(state.toString())
        }
    }

    @ReactMethod
    fun restoreMiBand6ActivityCursor(deviceProfileId: String, cursor: Double, promise: Promise) {
        promise.resolve(MiBand6ActivitySyncStore.restoreCursor(reactApplicationContext, deviceProfileId, cursor.toLong()))
    }

    @ReactMethod
    fun beginLegacyMiBand6Activity(deviceProfileId: String, trigger: String, diagnostic: Boolean, promise: Promise) {
        if (diagnostic) { promise.reject("activity_update_required", "activity_update_required"); return }
        reactApplicationContext.runOnUiQueueThread {
            try {
                require(BodySignalGuardianStore.load(reactApplicationContext).owner == GuardianOwner.LEGACY_JS) { "activity_busy" }
                val now = System.currentTimeMillis()
                require(MiBand6SleepInspection.leases.current(now) == null) { "activity_busy" }
                val since = MiBand6ActivitySyncStore.claim(reactApplicationContext, deviceProfileId, trigger, diagnostic, now)
                promise.resolve(Arguments.createMap().apply { putDouble("since", since.toDouble()); putDouble("attemptedAt", now.toDouble()) })
            } catch (error: Exception) { promise.reject(error.message ?: "activity_failed", error.message) }
        }
    }

    @ReactMethod
    fun finishLegacyMiBand6Activity(deviceProfileId: String, trigger: String, attemptedAt: Double,
        batchJson: String?, errorCode: String?, diagnostic: Boolean, promise: Promise) {
        if (diagnostic) { promise.reject("activity_update_required", "activity_update_required"); return }
        reactApplicationContext.runOnUiQueueThread {
            try {
                val previous = MiBand6ActivitySyncStore.state(reactApplicationContext, deviceProfileId)
                require(previous.optLong("lastAttemptAt") == attemptedAt.toLong() && previous.optString("trigger") == trigger) { "activity_disconnected" }
                require(diagnostic || MiBand6ActivityProtocol.PRODUCTION_ENABLED) { "activity_evidence_required" }
                val batch = batchJson?.let { activityBatchFromJson(org.json.JSONObject(it)) }
                var error = errorCode ?: if (BodySignalGuardianStore.load(reactApplicationContext).owner != GuardianOwner.LEGACY_JS)
                    "activity_disconnected" else null
                var event: GuardianLedgerEvent? = null
                if (error == null && batch != null && !diagnostic) {
                    event = BodySignalGuardianLedger.recordActivity(reactApplicationContext, deviceProfileId, batch)
                    if (event == null) error = "activity_queue_full"
                }
                if (!MiBand6ActivitySyncStore.finish(reactApplicationContext, deviceProfileId, trigger, batch, error, diagnostic)) error = "activity_save_failed"
                if (error != null) promise.reject(error, error) else promise.resolve(event?.toWritableMap() ?: batch?.toWritableMap())
            } catch (error: Exception) { promise.reject(error.message ?: "activity_failed", error.message) }
        }
    }

    @ReactMethod
    fun acknowledgeGuardianEvents(eventIds: ReadableArray, promise: Promise) {
        val ids = buildSet {
            for (index in 0 until eventIds.size()) {
                eventIds.getString(index)?.takeIf { it.isNotBlank() }?.let(::add)
            }
        }
        if (BodySignalGuardianLedger.acknowledge(reactApplicationContext, ids)) promise.resolve(true)
        else promise.reject("guardian_ack_failed", "guardian_ack_failed")
    }

    @ReactMethod fun addListener(eventName: String) = Unit
    @ReactMethod fun removeListeners(count: Int) = Unit

    override fun invalidate() {
        BodySignalGuardianEmitter.detach(reactApplicationContext)
        super.invalidate()
    }

    private fun requireProvisionedState(): GuardianState {
        val state = BodySignalGuardianStore.load(reactApplicationContext)
        require(state.deviceProfileId != null && state.associationId != null) {
            "Guardian has not been provisioned for a primary wearable"
        }
        require(BodySignalGuardianVault.load(reactApplicationContext)?.also { it.fill(0) } != null) {
            "Guardian auth key is unavailable"
        }
        require(associationExists(state.associationId)) { "Android companion association is unavailable" }
        return state
    }

    private fun associationExists(associationId: Int): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        return reactApplicationContext.getSystemService(CompanionDeviceManager::class.java)
            .myAssociations.any { it.id == associationId }
    }

    private fun parseAuthKey(value: String): ByteArray {
        val normalized = value.trim().replace(" ", "").lowercase()
        require(normalized.matches(Regex("[0-9a-f]{32}"))) { "Mi Band 6 auth key must be 32 hex characters" }
        return ByteArray(16) { index -> normalized.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    }
}
