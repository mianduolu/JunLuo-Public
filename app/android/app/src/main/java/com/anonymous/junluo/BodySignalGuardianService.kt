package com.anonymous.junluo

import android.annotation.SuppressLint
import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.companion.CompanionDeviceManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.Locale
import java.util.UUID

// Temporary DEBUG timing for the foreground-service startup timeout investigation.
private fun guardianLifecycle(stage: String, service: Service? = null, startId: Int? = null, action: String? = null) {
    if (!BuildConfig.DEBUG) return
    val actionCode = when (action) {
        BodySignalGuardianController.ACTION_START -> "START"
        BodySignalGuardianController.ACTION_RETRY -> "RETRY"
        BodySignalGuardianController.ACTION_PAUSE -> "PAUSE"
        BodySignalGuardianController.ACTION_RESUME -> "RESUME"
        BodySignalGuardianController.ACTION_DISABLE -> "DISABLE"
        BodySignalGuardianController.ACTION_RELEASE -> "RELEASE"
        BodySignalGuardianController.ACTION_PRESENCE -> "PRESENCE"
        BodySignalGuardianController.ACTION_SAMPLE_START -> "SAMPLE_START"
        BodySignalGuardianController.ACTION_SAMPLE_STOP -> "SAMPLE_STOP"
        BodySignalGuardianController.ACTION_SCHEDULE_CONFIGURE -> "SCHEDULE_CONFIGURE"
        BodySignalGuardianController.ACTION_SCHEDULE_EVALUATE -> "SCHEDULE_EVALUATE"
        BodySignalGuardianController.ACTION_SCHEDULE_CANCEL -> "SCHEDULE_CANCEL"
        null -> "NONE"
        else -> "OTHER"
    }
    Log.i("JunLuoGuardianLife", "t=${SystemClock.elapsedRealtime()} pid=${android.os.Process.myPid()} " +
        "instance=${System.identityHashCode(service)} startId=${startId ?: 0} action=$actionCode stage=$stage")
}

internal object BodySignalGuardianController {
    const val ACTION_START = "com.anonymous.junluo.guardian.START"
    const val ACTION_RETRY = "com.anonymous.junluo.guardian.RETRY"
    const val ACTION_PAUSE = "com.anonymous.junluo.guardian.PAUSE"
    const val ACTION_RESUME = "com.anonymous.junluo.guardian.RESUME"
    const val ACTION_DISABLE = "com.anonymous.junluo.guardian.DISABLE"
    const val ACTION_RELEASE = "com.anonymous.junluo.guardian.RELEASE"
    const val ACTION_PRESENCE = "com.anonymous.junluo.guardian.PRESENCE"
    const val ACTION_SAMPLE_START = "com.anonymous.junluo.guardian.SAMPLE_START"
    const val ACTION_SAMPLE_STOP = "com.anonymous.junluo.guardian.SAMPLE_STOP"
    const val ACTION_SCHEDULE_CONFIGURE = "com.anonymous.junluo.guardian.SCHEDULE_CONFIGURE"
    const val ACTION_SCHEDULE_EVALUATE = "com.anonymous.junluo.guardian.SCHEDULE_EVALUATE"
    const val ACTION_SCHEDULE_CANCEL = "com.anonymous.junluo.guardian.SCHEDULE_CANCEL"
    const val EXTRA_APPEARED = "appeared"
    const val EXTRA_ASSOCIATION_ID = "associationId"
    const val EXTRA_SAMPLING_ENABLED = "samplingEnabled"
    const val EXTRA_SAMPLING_PAUSE_UNTIL = "samplingPauseUntil"
    const val EXTRA_SAMPLING_TRIGGER = "samplingTrigger"

    fun start(context: Context, action: String, configure: (Intent.() -> Unit)? = null) {
        val intent = Intent(context, BodySignalGuardianService::class.java).setAction(action)
        configure?.invoke(intent)
        guardianLifecycle("launch_before", action = intent.action)
        ContextCompat.startForegroundService(context, intent)
        guardianLifecycle("launch_returned", action = intent.action)
    }

    fun onPresence(context: Context, associationId: Int, appeared: Boolean) {
        val state = BodySignalGuardianStore.load(context)
        if (state.associationId != associationId) return
        val next = BodySignalGuardianStore.save(context, state.copy(
            appeared = appeared,
            lastTransitionAt = System.currentTimeMillis(),
        ))
        BodySignalGuardianLedger.recordState(context, next)
        if (!next.enabled || next.paused) return
        start(context, ACTION_PRESENCE) {
            putExtra(EXTRA_ASSOCIATION_ID, associationId)
            putExtra(EXTRA_APPEARED, appeared)
        }
    }

    fun stopForObservationPause(context: Context) {
        val state = BodySignalGuardianStore.load(context)
        if (state.enabled) start(context, ACTION_PAUSE)
    }

    fun resumeAfterObservation(context: Context) {
        val state = BodySignalGuardianStore.load(context)
        if (state.enabled) start(context, ACTION_RESUME)
    }

    fun disableForRevocation(context: Context, associationId: Int) {
        val state = BodySignalGuardianStore.load(context)
        if (state.associationId == associationId) start(context, ACTION_DISABLE)
    }
}

internal class BodySignalGuardianService : Service(), MiBand6GuardianGattListener {
    companion object {
        private const val CHANNEL_ID = "junluo_body_signal_guardian"
        private const val NOTIFICATION_ID = 9327
        private const val LEAVE_GRACE_MS = 30_000L
        private const val SAMPLE_DURATION_MS = 5L * 60L * 1000L
        private const val CONTINUE_INTERVAL_MS = 1_000L
        private val RETRY_DELAYS_MS = longArrayOf(5_000L, 15_000L, 30_000L, 60_000L, 60_000L)
        @Volatile private var activeService: BodySignalGuardianService? = null

        fun currentState(context: Context): GuardianState {
            val state = BodySignalGuardianStore.load(context)
            return if (activeService == null) state.withoutLiveSession() else state
        }

        fun readBattery(deviceProfileId: String, trigger: String, completion: (GuardianLedgerEvent?, String?) -> Unit) {
            Handler(Looper.getMainLooper()).post {
                val service = activeService
                if (service == null) {
                    completion(null, "battery_not_ready")
                    return@post
                }
                service.refreshBattery(deviceProfileId, trigger, completion)
            }
        }

        fun readActivity(deviceProfileId: String, trigger: String, diagnostic: Boolean,
            completion: (com.facebook.react.bridge.WritableMap?, String?) -> Unit) {
            Handler(Looper.getMainLooper()).post {
                val service = activeService
                if (service == null) completion(null, "activity_not_ready")
                else service.syncActivity(deviceProfileId, trigger, diagnostic, completion)
            }
        }

        fun inspectMiBand6SleepHistory(profileId: String, window: String, completion: (String?, String?) -> Unit) {
            Handler(Looper.getMainLooper()).post {
                val service = activeService
                if (service == null) completion(null, "sleep_inspection_not_ready")
                else service.inspectSleepHistory(profileId, window, completion)
            }
        }

        fun cancelMiBand6SleepInspection(profileId: String, completion: (Boolean) -> Unit) {
            Handler(Looper.getMainLooper()).post {
                val lease = MiBand6SleepInspection.leases.current(System.currentTimeMillis())
                val service = activeService
                if (lease?.profileId != profileId || lease.owner != GuardianOwner.NATIVE_GUARDIAN
                    || service?.sleepInspectionToken != lease.token) completion(false)
                else service.client?.cancelActivity { completion(true) } ?: run {
                    MiBand6SleepInspection.leases.release(lease.token)
                    service.sleepInspectionToken = null
                    completion(true)
                }
            }
        }


        fun startManualHeartRate(context: Context, completion: (String?) -> Unit) {
            Handler(Looper.getMainLooper()).post {
                val service = activeService
                if (service?.client?.isBatteryReadPending() == true) {
                    completion("battery_busy")
                } else {
                    val error = runCatching {
                        if (service == null) BodySignalGuardianController.start(context, BodySignalGuardianController.ACTION_SAMPLE_START)
                        else service.startSampling()
                    }.exceptionOrNull()
                    completion(if (error == null) null else "guardian_not_ready")
                }
            }
        }

        fun syncCurrentTime(completion: (String?) -> Unit) {
            Handler(Looper.getMainLooper()).post {
                val service = activeService
                val client = service?.client
                if (service == null || client == null) {
                    completion("time_sync_not_ready")
                    return@post
                }
                val state = BodySignalGuardianStore.load(service)
                if (service.activeSamplingMode != null || service.pendingSamplingMode != null) {
                    completion("time_sync_measuring")
                } else if (!state.enabled || state.paused || state.status != GuardianStatus.READY) {
                    completion("time_sync_not_ready")
                } else {
                    client.syncCurrentTime(completion)
                }
            }
        }

        fun refreshCareWake(context: Context) {
            val service = activeService
            if (service != null) service.handler.post { service.scheduleNextEvaluation() }
            else {
                val state = BodySignalGuardianStore.load(context)
                val samplingAt = state.nextSamplingDueAt.takeIf { state.scheduledSamplingEnabled }
                val next = BodySignalCarePolicy.earliest(samplingAt, BodySignalCareStore.nextCheckAt(context))
                if (next == null || PhoneFocusRules.restorePaused) BodySignalGuardianSamplingAlarm.cancel(context)
                else BodySignalGuardianSamplingAlarm.schedule(context, next)
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var client: MiBand6GuardianGattClient? = null
    private val batteryWaiters = mutableListOf<(GuardianLedgerEvent?, String?) -> Unit>()
    private var batteryEvaluationPending = false
    private var activityYieldPending = false
    private var sleepInspectionToken: String? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var sampleStartedAt = 0L
    private var stopAfterAck = false
    private var foregroundStarted = false
    private var lastDeliveredStartId = 0
    private var manualPresenceOverride = false
    private var pendingSamplingMode: GuardianSamplingMode? = null
    private var activeSamplingMode: GuardianSamplingMode? = null
    private var samplingStopReason: String? = null
    private var samplingReadingCount = 0
    private var scheduledFirstReadingAt: Long? = null
    private var scheduledWindowId: String? = null
    private var scheduledWindowTrigger = ScheduledSamplingTrigger.NATIVE_TIMER
    private var scheduledWindowReason = ScheduledSamplingReason.DUE
    private var scheduledWindowRequestedAt = 0L
    private var scheduledEvaluationDueAt: Long? = null
    private val scheduledEvaluationRunnable = Runnable {
        val now = System.currentTimeMillis()
        PhoneGuardMessageTaskService.checkBodySignalCare(this, now)
        if (BodySignalCarePolicy.samplingDue(scheduledEvaluationDueAt, now)) {
            scheduledEvaluationDueAt = null
            evaluateScheduledSampling(ScheduledSamplingTrigger.NATIVE_TIMER)
        }
        scheduleNextEvaluation()
    }

    private val leaveRunnable = Runnable { handleConfirmedDeparture() }
    private val retryRunnable = Runnable { connectIfEligible(resetRetry = false) }
    private val sampleTimeoutRunnable = Runnable { stopSampling("timeout") }
    private val continueRunnable = object : Runnable {
        override fun run() {
            if (BodySignalGuardianStore.load(this@BodySignalGuardianService).status != GuardianStatus.SAMPLING) return
            client?.continueHeartRate()
            handler.postDelayed(this, CONTINUE_INTERVAL_MS)
        }
    }

    override fun onCreate() {
        guardianLifecycle("create_enter", this)
        super.onCreate()
        val state = BodySignalGuardianStore.update(this) { it.withoutLiveSession() }
        guardianLifecycle("create_state_ready", this)
        activeService = this
        scheduledEvaluationDueAt = state.nextSamplingDueAt.takeIf { state.scheduledSamplingEnabled }
        createNotificationChannel()
        guardianLifecycle("create_channel_ready", this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastDeliveredStartId = startId
        guardianLifecycle("start_enter", this, startId, intent?.action)
        ensureForeground()
        when (intent?.action) {
            BodySignalGuardianController.ACTION_START -> connectIfEligible(resetRetry = true)
            BodySignalGuardianController.ACTION_RETRY -> connectIfEligible(
                resetRetry = true,
                allowMissingPresence = true,
            )
            BodySignalGuardianController.ACTION_RESUME -> resumeGuardian()
            BodySignalGuardianController.ACTION_PAUSE -> pauseGuardian()
            BodySignalGuardianController.ACTION_DISABLE -> disableGuardian()
            BodySignalGuardianController.ACTION_RELEASE -> releaseForForegroundScan()
            BodySignalGuardianController.ACTION_PRESENCE -> handlePresence(
                intent.getBooleanExtra(BodySignalGuardianController.EXTRA_APPEARED, false),
            )
            BodySignalGuardianController.ACTION_SAMPLE_START -> startSampling()
            BodySignalGuardianController.ACTION_SAMPLE_STOP -> stopSampling("manual")
            BodySignalGuardianController.ACTION_SCHEDULE_CONFIGURE -> configureScheduledSampling(
                intent.getBooleanExtra(BodySignalGuardianController.EXTRA_SAMPLING_ENABLED, false),
                intent.getLongExtra(
                    BodySignalGuardianController.EXTRA_SAMPLING_PAUSE_UNTIL,
                    -1L,
                ).takeIf { it >= 0L },
            )
            BodySignalGuardianController.ACTION_SCHEDULE_EVALUATE -> evaluateScheduledSampling(
                ScheduledSamplingTrigger.fromWire(
                    intent.getStringExtra(BodySignalGuardianController.EXTRA_SAMPLING_TRIGGER),
                ),
            )
            BodySignalGuardianController.ACTION_SCHEDULE_CANCEL -> configureScheduledSampling(false, null)
            null -> connectIfEligible(resetRetry = false)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        guardianLifecycle("destroy_enter", this)
        abortScheduledWindowIfActive(ScheduledSamplingResult.DISCONNECTED, "guardian_not_ready")
        handler.removeCallbacksAndMessages(null)
        closeGatt(expected = true)
        releaseWakeLock()
        if (activeService === this) activeService = null
        super.onDestroy()
        guardianLifecycle("destroy_returned", this)
    }

    override fun onStage(status: GuardianStatus) {
        transition(status, clearError = true)
    }

    override fun onReady() {
        val now = System.currentTimeMillis()
        manualPresenceOverride = false
        transition(GuardianStatus.READY) { state ->
            state.copy(
                appeared = true,
                owner = GuardianOwner.NATIVE_GUARDIAN,
                sessionId = UUID.randomUUID().toString(),
                lastConnectedAt = now,
                retryAttempt = 0,
                lastErrorCode = null,
                samplingEndsAt = null,
                samplingMode = null,
            )
        }
        handler.post { evaluateScheduledSampling(ScheduledSamplingTrigger.DEVICE_READY) }
        handler.post {
            BodySignalGuardianStore.load(this).deviceProfileId?.let { refreshBattery(it, "connected") { _, _ ->
                tryAutomaticActivity("connected")
            } }
        }
    }

    private fun inspectSleepHistory(profileId: String, window: String, completion: (String?, String?) -> Unit) {
        val state = BodySignalGuardianStore.load(this)
        val currentClient = client
        if (!state.enabled || state.status != GuardianStatus.READY || currentClient?.isReady() != true) {
            completion(null, "sleep_inspection_not_ready"); return
        }
        if (activeSamplingMode != null || pendingSamplingMode != null || currentClient.isActivityPending()
            || currentClient.isBatteryReadPending() || batteryEvaluationPending || activityYieldPending) {
            completion(null, "sleep_inspection_busy"); return
        }
        val now = System.currentTimeMillis()
        val lease = try {
            MiBand6SleepInspection.leases.claim(profileId, window, state, GuardianOwner.NATIVE_GUARDIAN, now,
                MiBand6ActivitySyncStore.state(this, profileId).optLong("inFlightUntil"))
        } catch (error: Exception) { completion(null, error.message ?: "sleep_inspection_not_ready"); return }
        sleepInspectionToken = lease.token
        val capture = MiBand6SleepCapture(lease.since, lease.requestedAt)
        acquireWakeLock(95_000L)
        currentClient.readActivity(lease.since, capture) { batch, transferError ->
            releaseWakeLock()
            MiBand6SleepInspection.leases.release(lease.token)
            if (sleepInspectionToken == lease.token) sleepInspectionToken = null
            val after = BodySignalGuardianStore.load(this)
            val error = transferError ?: if (batch == null || client !== currentClient || after.sessionId != state.sessionId
                || after.owner != GuardianOwner.NATIVE_GUARDIAN || after.deviceProfileId != profileId
                || after.paused || !after.enabled) "activity_disconnected" else null
            if (transferError == "activity_cleanup_failed") {
                // Match existing connection teardown; evidence, cursor and production cooldown stay untouched.
                stopServiceCleanly(keepConfiguration = true)
                BodySignalGuardianStore.update(this) { it.copy(lastErrorCode = "activity_cleanup_failed") }
            }
            // readActivity has already completed subscription cleanup; no production store receives this batch.
            if (error != null) completion(null, error)
            else completion(capture.complete(), null)
        }
    }

    private fun syncActivity(profileId: String, trigger: String, diagnostic: Boolean,
        completion: (com.facebook.react.bridge.WritableMap?, String?) -> Unit) {
        val state = BodySignalGuardianStore.load(this)
        val currentClient = client
        if (!state.enabled || state.paused || state.owner != GuardianOwner.NATIVE_GUARDIAN
            || state.deviceProfileId != profileId || state.status != GuardianStatus.READY || currentClient?.isReady() != true) {
            completion(null, "activity_not_ready"); return
        }
        if (MiBand6SleepInspection.leases.current(System.currentTimeMillis()) != null
            || activeSamplingMode != null || pendingSamplingMode != null || currentClient.isActivityPending()
            || currentClient.isBatteryReadPending() || batteryEvaluationPending || activityYieldPending) {
            completion(null, "activity_busy"); return
        }
        val since = try { MiBand6ActivitySyncStore.claim(this, profileId, trigger, diagnostic, System.currentTimeMillis()) }
            catch (error: Exception) { completion(null, error.message ?: "activity_cooldown"); return }
        acquireWakeLock(95_000L)
        currentClient.readActivity(since) { batch, transferError ->
            releaseWakeLock()
            val after = BodySignalGuardianStore.load(this)
            var error = transferError ?: if (client !== currentClient || after.sessionId != state.sessionId
                || after.owner != GuardianOwner.NATIVE_GUARDIAN || after.deviceProfileId != profileId) "activity_disconnected" else null
            var event: GuardianLedgerEvent? = null
            if (error == null && batch != null && !diagnostic) {
                event = BodySignalGuardianLedger.recordActivity(this, profileId, batch)
                if (event == null) error = "activity_queue_full"
            }
            if (!MiBand6ActivitySyncStore.finish(this, profileId, trigger, batch, error, diagnostic)) error = "activity_save_failed"
            if (transferError == "activity_cleanup_failed") {
                stopServiceCleanly(keepConfiguration = true)
                BodySignalGuardianStore.update(this) { it.copy(lastErrorCode = "activity_cleanup_failed") }
            }
            val candidate = (batch?.toWritableMap() ?: if (diagnostic) com.facebook.react.bridge.Arguments.createMap() else null)?.apply {
                if (diagnostic && error != null) putString("diagnosticError", error)
                if (diagnostic) currentClient.activityEvidence()?.let { evidence ->
                    putMap("evidence", com.facebook.react.bridge.Arguments.createMap().apply {
                        fun bytes(value: ByteArray) = com.facebook.react.bridge.Arguments.createArray().apply {
                            value.forEach { pushInt(it.toInt() and 255) }
                        }
                        putArray("metadata", bytes(evidence.metadata)); putArray("firstRecords", bytes(evidence.firstRecords))
                        putArray("completion", bytes(evidence.completion))
                    })
                }
            }
            completion(if (error == null) event?.toWritableMap() ?: candidate else if (diagnostic) candidate else null, error)
        }
    }

    private fun tryAutomaticActivity(trigger: String) {
        if (!MiBand6ActivityProtocol.PRODUCTION_ENABLED) return
        val state = BodySignalGuardianStore.load(this)
        if (!state.enabled || state.paused || state.owner != GuardianOwner.NATIVE_GUARDIAN || !state.appeared
            || state.status != GuardianStatus.READY || activeSamplingMode != null || pendingSamplingMode != null
            || client?.isActivityPending() == true || client?.isBatteryReadPending() == true || batteryEvaluationPending) return
        val now = System.currentTimeMillis()
        if (state.scheduledSamplingEnabled && (state.nextSamplingDueAt ?: now) <= now + 95_000L) return
        val battery = readPhoneBattery()
        val power = getSystemService(PowerManager::class.java)
        val wearable = MiBand6BatteryStore.trusted(this, state.deviceProfileId)
        val permitted = BodySignalScheduledSamplingPolicy.decide(ScheduledSamplingDecisionInput(
            now = now, enabled = true, pauseUntil = null, nextDueAt = now, supportedDevice = true,
            manualSessionActive = false, permissionsGranted = guardianPermissionsGranted(), appeared = state.appeared,
            guardianReady = true, phoneBatteryPercent = battery?.first, phoneCharging = battery?.second == true,
            wearableBatteryPercent = wearable?.first, wearableBatteryMeasuredAt = wearable?.second,
            powerSaveMode = power.isPowerSaveMode, thermalSevere = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && power.currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE,
        )) == ScheduledSamplingReason.DUE
        if (permitted) state.deviceProfileId?.let { syncActivity(it, trigger, false) { _, _ -> } }
    }

    private fun refreshBattery(profileId: String, trigger: String, completion: (GuardianLedgerEvent?, String?) -> Unit) {
        val state = BodySignalGuardianStore.load(this)
        val currentClient = client
        val error = when {
            state.deviceProfileId != profileId || state.owner != GuardianOwner.NATIVE_GUARDIAN -> "battery_disconnected"
            activeSamplingMode != null || pendingSamplingMode != null -> "battery_busy"
            !state.enabled || state.paused || state.status != GuardianStatus.READY || currentClient?.isReady() != true -> "battery_not_ready"
            else -> null
        }
        if (error != null || currentClient == null) { completion(null, error ?: "battery_not_ready"); return }
        if (batteryWaiters.isNotEmpty()) { batteryWaiters.add(completion); return }
        val now = System.currentTimeMillis()
        MiBand6BatteryStore.claim(this, profileId, trigger, now)?.let { completion(null, it); return }
        batteryWaiters.add(completion)
        currentClient.readBattery { bytes, readError ->
            val current = BodySignalGuardianStore.load(this)
            val parsed = bytes?.let(MiBand6BatteryProtocol::parse)
            val failure = readError ?: when {
                client !== currentClient || current.sessionId != state.sessionId
                    || current.deviceProfileId != profileId || current.owner != GuardianOwner.NATIVE_GUARDIAN -> "battery_disconnected"
                parsed == null -> "battery_invalid_packet"
                else -> null
            }
            val event = if (failure == null && parsed != null)
                MiBand6BatteryStore.complete(this, profileId, trigger, parsed, System.currentTimeMillis()) else null
            val waiters = batteryWaiters.toList()
            batteryWaiters.clear()
            waiters.forEach { it(event, failure ?: if (event == null) "battery_save_failed" else null) }
        }
    }

    override fun onHeartRate(bpm: Int, observedAt: Long) {
        val state = BodySignalGuardianStore.update(this) { current -> current.copy(lastHeartRateAt = observedAt) }
        state.deviceProfileId?.let { profileId ->
            if (BodySignalGuardianLedger.recordHeartRate(this, profileId, bpm, observedAt)) {
                PhoneGuardMessageTaskService.checkBodySignalCare(this, System.currentTimeMillis(), newReading = true)
                scheduleNextEvaluation()
            }
        }
        if (activeSamplingMode != null) samplingReadingCount += 1
        if (activeSamplingMode == GuardianSamplingMode.SCHEDULED_2_MINUTE) {
            if (scheduledFirstReadingAt == null) scheduledFirstReadingAt = observedAt
            else if (BodySignalScheduledSamplingPolicy.hasSecondSeparatedReading(
                    scheduledFirstReadingAt,
                    observedAt,
                )) {
                stopSampling("two_readings")
            }
        }
        updateNotification(state)
    }

    override fun onCommandAcknowledged(command: String) {
        when (command) {
            "start" -> pendingSamplingMode?.let(::beginSamplingLoop)
            "stop" -> if (stopAfterAck) finishSampling()
        }
    }

    override fun onDisconnected(expected: Boolean) {
        if (expected) return
        abortScheduledWindowIfActive(ScheduledSamplingResult.DISCONNECTED, "guardian_not_ready")
        val state = BodySignalGuardianStore.load(this)
        if (manualPresenceOverride && !state.appeared) {
            failManualRetry("gatt_disconnected")
            return
        }
        if (!state.enabled || state.paused || !state.appeared) {
            stopServiceCleanly(keepConfiguration = true)
            return
        }
        scheduleRetry("gatt_disconnected")
    }

    override fun onError(code: String) {
        abortScheduledWindowIfActive(ScheduledSamplingResult.WRITE_FAILED, "guardian_not_ready")
        closeGatt(expected = true)
        val state = BodySignalGuardianStore.load(this)
        if (manualPresenceOverride && !state.appeared) {
            failManualRetry(code)
            return
        }
        if (state.enabled && !state.paused && state.appeared) scheduleRetry(code)
        else transition(GuardianStatus.ERROR) { it.copy(lastErrorCode = code) }
    }

    private fun handlePresence(appeared: Boolean) {
        handler.removeCallbacks(leaveRunnable)
        if (appeared) connectIfEligible(resetRetry = true)
        else handler.postDelayed(leaveRunnable, LEAVE_GRACE_MS)
    }

    private fun handleConfirmedDeparture() {
        val state = BodySignalGuardianStore.load(this)
        if (state.appeared) return
        abortScheduledWindowIfActive(ScheduledSamplingResult.DISCONNECTED, "device_absent")
        stopSampling("disconnect")
        cancelScheduledEvaluation()
        closeGatt(expected = true)
        transition(GuardianStatus.IDLE) {
            it.copy(
                owner = GuardianOwner.LEGACY_JS,
                sessionId = null,
                samplingEndsAt = null,
                samplingMode = null,
            )
        }
        stopForegroundAndSelf()
    }

    @SuppressLint("MissingPermission")
    private fun connectIfEligible(
        resetRetry: Boolean,
        allowMissingPresence: Boolean = false,
    ) {
        handler.removeCallbacks(retryRunnable)
        val state = BodySignalGuardianStore.load(this)
        if (!state.enabled || state.paused || (!state.appeared && !allowMissingPresence)) {
            stopServiceCleanly(keepConfiguration = true)
            return
        }
        if (client?.isConnected() == true) {
            if (allowMissingPresence && !state.appeared) {
                BodySignalGuardianStore.update(this) { it.copy(appeared = true) }
            }
            return
        }
        manualPresenceOverride = allowMissingPresence && !state.appeared
        val associationId = state.associationId ?: return failCurrentAttempt("association_missing")
        val authKey = BodySignalGuardianVault.load(this) ?: return failCurrentAttempt("guardian_auth_key_missing")
        if (resetRetry) {
            BodySignalGuardianStore.save(this, state.copy(retryAttempt = 0, lastErrorCode = null))
        }
        val (device, resolutionError) = associatedBluetoothDevice(associationId)
        if (device == null) {
            authKey.fill(0)
            val code = resolutionError ?: "bluetooth_device_unavailable"
            if (manualPresenceOverride) return failManualRetry(code)
            return scheduleRetry(code)
        }
        transition(GuardianStatus.STARTING) {
            it.copy(owner = GuardianOwner.NATIVE_GUARDIAN, lastErrorCode = null)
        }
        client = MiBand6GuardianGattClient(this, this).also { it.connect(device, authKey) }
        authKey.fill(0)
    }

    private fun scheduleRetry(errorCode: String) {
        handler.removeCallbacks(retryRunnable)
        val current = BodySignalGuardianStore.load(this)
        val attempt = current.retryAttempt + 1
        if (attempt > RETRY_DELAYS_MS.size) {
            transition(GuardianStatus.SUSPENDED) {
                it.copy(retryAttempt = RETRY_DELAYS_MS.size, lastErrorCode = errorCode)
            }
            return
        }
        transition(GuardianStatus.ERROR) { it.copy(retryAttempt = attempt, lastErrorCode = errorCode) }
        handler.postDelayed(retryRunnable, RETRY_DELAYS_MS[attempt - 1])
    }

    private fun failTerminal(code: String) {
        transition(GuardianStatus.SUSPENDED) { it.copy(lastErrorCode = code) }
    }

    private fun failCurrentAttempt(code: String) {
        if (manualPresenceOverride) failManualRetry(code) else failTerminal(code)
    }

    private fun failManualRetry(code: String) {
        manualPresenceOverride = false
        closeGatt(expected = true)
        releaseWakeLock()
        transition(GuardianStatus.ERROR) {
            it.copy(
                owner = GuardianOwner.LEGACY_JS,
                sessionId = null,
                samplingEndsAt = null,
                lastErrorCode = code,
            )
        }
        stopForegroundAndSelf()
    }

    private fun startSampling() {
        startSampling(GuardianSamplingMode.MANUAL_5_MINUTE)
    }

    private fun startSampling(
        mode: GuardianSamplingMode,
        trigger: ScheduledSamplingTrigger = ScheduledSamplingTrigger.NATIVE_TIMER,
        requestedAt: Long = System.currentTimeMillis(),
    ) {
        if (client?.isActivityPending() == true) {
            if (activityYieldPending) return
            activityYieldPending = true
            client?.cancelActivity { error ->
                activityYieldPending = false
                if (error == null) handler.post { startSampling(mode, trigger, requestedAt) }
            }
            return
        }
        val state = BodySignalGuardianStore.load(this)
        if (client?.isBatteryReadPending() == true) return
        if (activeSamplingMode != null || pendingSamplingMode != null || state.status == GuardianStatus.SAMPLING) return
        if (state.status != GuardianStatus.READY || client?.isReady() != true) {
            if (mode == GuardianSamplingMode.SCHEDULED_2_MINUTE) {
                recordSkippedScheduledWindow(
                    trigger,
                    ScheduledSamplingReason.GUARDIAN_NOT_READY,
                    requestedAt,
                    scheduleNext = false,
                )
            } else transition(GuardianStatus.ERROR) { it.copy(lastErrorCode = "guardian_not_ready") }
            return
        }
        pendingSamplingMode = mode
        samplingReadingCount = 0
        scheduledFirstReadingAt = null
        samplingStopReason = null
        if (mode == GuardianSamplingMode.SCHEDULED_2_MINUTE) {
            scheduledWindowId = UUID.randomUUID().toString()
            scheduledWindowTrigger = trigger
            scheduledWindowReason = ScheduledSamplingReason.DUE
            scheduledWindowRequestedAt = requestedAt
            BodySignalGuardianStore.update(this) {
                it.copy(scheduledSamplingStatus = GuardianScheduledSamplingStatus.EVALUATING)
            }
        }
        stopAfterAck = false
        client?.startHeartRate()
    }

    private fun beginSamplingLoop(mode: GuardianSamplingMode) {
        val now = System.currentTimeMillis()
        sampleStartedAt = now
        activeSamplingMode = mode
        pendingSamplingMode = null
        val durationMs = if (mode == GuardianSamplingMode.SCHEDULED_2_MINUTE) {
            SCHEDULED_SAMPLING_MAX_WINDOW_MS
        } else SAMPLE_DURATION_MS
        acquireWakeLock(durationMs + 5_000L)
        transition(GuardianStatus.SAMPLING) {
            it.copy(
                samplingEndsAt = now + durationMs,
                samplingMode = mode,
                scheduledSamplingStatus = if (mode == GuardianSamplingMode.SCHEDULED_2_MINUTE) {
                    GuardianScheduledSamplingStatus.SAMPLING
                } else it.scheduledSamplingStatus,
                lastScheduledSamplingStartedAt = if (mode == GuardianSamplingMode.SCHEDULED_2_MINUTE) {
                    now
                } else it.lastScheduledSamplingStartedAt,
                lastErrorCode = null,
            )
        }
        handler.removeCallbacks(sampleTimeoutRunnable)
        handler.removeCallbacks(continueRunnable)
        handler.postDelayed(continueRunnable, CONTINUE_INTERVAL_MS)
        handler.postDelayed(sampleTimeoutRunnable, durationMs)
    }

    private fun stopSampling(reason: String) {
        val state = BodySignalGuardianStore.load(this)
        if (state.status != GuardianStatus.SAMPLING && state.status != GuardianStatus.STOPPING) return
        samplingStopReason = reason
        handler.removeCallbacks(sampleTimeoutRunnable)
        handler.removeCallbacks(continueRunnable)
        transition(GuardianStatus.STOPPING)
        stopAfterAck = true
        client?.stopHeartRate()
        handler.postDelayed({ if (stopAfterAck) finishSampling() }, 2_000L)
    }

    private fun finishSampling() {
        val completedMode = activeSamplingMode ?: pendingSamplingMode
        val endedAt = System.currentTimeMillis()
        stopAfterAck = false
        handler.removeCallbacks(sampleTimeoutRunnable)
        handler.removeCallbacks(continueRunnable)
        releaseWakeLock()
        transition(if (client?.isReady() == true) GuardianStatus.READY else GuardianStatus.IDLE) {
            it.copy(samplingEndsAt = null, samplingMode = null)
        }
        if (completedMode == GuardianSamplingMode.SCHEDULED_2_MINUTE) {
            val result = when (samplingStopReason) {
                "two_readings" -> ScheduledSamplingResult.COMPLETED
                "disconnect" -> ScheduledSamplingResult.DISCONNECTED
                "write_failed" -> ScheduledSamplingResult.WRITE_FAILED
                "manual", "disabled" -> ScheduledSamplingResult.STOPPED
                else -> if (samplingReadingCount == 0) {
                    ScheduledSamplingResult.NO_DATA
                } else ScheduledSamplingResult.COMPLETED
            }
            finishScheduledWindow(result, endedAt)
        } else if (
            completedMode == GuardianSamplingMode.MANUAL_5_MINUTE
            && samplingReadingCount > 0
        ) {
            deferScheduledSamplingAfterManual(endedAt)
        }
        activeSamplingMode = null
        pendingSamplingMode = null
        samplingStopReason = null
        samplingReadingCount = 0
        scheduledFirstReadingAt = null
        handler.post { tryAutomaticActivity("sampling_finished") }
    }

    private fun configureScheduledSampling(enabled: Boolean, pauseUntil: Long?) {
        val now = System.currentTimeMillis()
        val current = BodySignalGuardianStore.load(this)
        if (!enabled) {
            cancelScheduledEvaluation()
            BodySignalGuardianStore.update(this) {
                it.copy(
                    scheduledSamplingEnabled = false,
                    scheduledSamplingPauseUntil = null,
                    scheduledSamplingStatus = GuardianScheduledSamplingStatus.DISABLED,
                    nextSamplingDueAt = null,
                )
            }
            when {
                activeSamplingMode == GuardianSamplingMode.SCHEDULED_2_MINUTE -> stopSampling("disabled")
                pendingSamplingMode == GuardianSamplingMode.SCHEDULED_2_MINUTE -> {
                    runCatching { client?.stopHeartRate() }
                    abortScheduledWindowIfActive(ScheduledSamplingResult.STOPPED, "disabled")
                }
            }
            return
        }
        restoreConnectionForScheduledWake()
        val normalizedPause = pauseUntil?.takeIf { it > now }
        val nextDue = when {
            normalizedPause != null -> normalizedPause
            !current.scheduledSamplingEnabled -> now
            else -> current.nextSamplingDueAt ?: now
        }
        BodySignalGuardianStore.update(this) {
            it.copy(
                scheduledSamplingEnabled = true,
                scheduledSamplingPauseUntil = normalizedPause,
                scheduledSamplingStatus = if (normalizedPause != null) {
                    GuardianScheduledSamplingStatus.PAUSED
                } else GuardianScheduledSamplingStatus.WAITING,
                nextSamplingDueAt = nextDue,
            )
        }
        if (normalizedPause != null) scheduleScheduledEvaluationAt(normalizedPause)
        else evaluateScheduledSampling(ScheduledSamplingTrigger.ENABLED)
    }

    private fun restoreConnectionForScheduledWake() {
        if (client == null && BodySignalGuardianStore.load(this).canRestoreConnectionAfterRestart()) {
            connectIfEligible(resetRetry = false)
        }
    }

    private fun evaluateScheduledSampling(trigger: ScheduledSamplingTrigger, batteryChecked: Boolean = false) {
        if (batteryEvaluationPending) return
        restoreConnectionForScheduledWake()
        val now = System.currentTimeMillis()
        val state = BodySignalGuardianStore.load(this)
        if (client?.isActivityPending() == true && state.scheduledSamplingEnabled
            && (state.nextSamplingDueAt ?: now) <= now) {
            if (activityYieldPending) return
            activityYieldPending = true
            client?.cancelActivity { error ->
                activityYieldPending = false
                if (error == null) handler.post { evaluateScheduledSampling(trigger, batteryChecked) }
            }
            return
        }
        if (
            activeSamplingMode == GuardianSamplingMode.SCHEDULED_2_MINUTE
            || pendingSamplingMode == GuardianSamplingMode.SCHEDULED_2_MINUTE
        ) return
        val battery = readPhoneBattery()
        val power = getSystemService(PowerManager::class.java)
        val wearableBattery = MiBand6BatteryStore.trusted(this, state.deviceProfileId)
        val decision = BodySignalScheduledSamplingPolicy.decide(
            ScheduledSamplingDecisionInput(
                now = now,
                enabled = state.scheduledSamplingEnabled,
                pauseUntil = state.scheduledSamplingPauseUntil,
                nextDueAt = state.nextSamplingDueAt,
                supportedDevice = state.deviceProfileId != null && state.associationId != null,
                manualSessionActive = state.status == GuardianStatus.SAMPLING
                    && state.samplingMode == GuardianSamplingMode.MANUAL_5_MINUTE,
                permissionsGranted = guardianPermissionsGranted(),
                appeared = state.appeared,
                guardianReady = state.status == GuardianStatus.READY && client?.isReady() == true
                    && (client?.isBatteryReadPending() != true || (!batteryChecked && batteryWaiters.isNotEmpty())),
                phoneBatteryPercent = battery?.first,
                phoneCharging = battery?.second == true,
                wearableBatteryPercent = wearableBattery?.first,
                wearableBatteryMeasuredAt = wearableBattery?.second,
                powerSaveMode = power.isPowerSaveMode,
                thermalSevere = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    && power.currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE,
            ),
        )
        // Refresh a stale low value too: charging recovery must not be locked out by the old reading.
        if (!batteryChecked && state.deviceProfileId != null
            && (decision == ScheduledSamplingReason.DUE || decision == ScheduledSamplingReason.LOW_WEARABLE_BATTERY)) {
            batteryEvaluationPending = true
            refreshBattery(state.deviceProfileId, "scheduled_check") { _, _ ->
                batteryEvaluationPending = false
                handler.post {
                    val current = BodySignalGuardianStore.load(this)
                    if (activeService === this && current.enabled && !current.paused && current.owner == GuardianOwner.NATIVE_GUARDIAN) {
                        evaluateScheduledSampling(trigger, batteryChecked = true)
                    }
                }
            }
            return
        }
        when (decision) {
            ScheduledSamplingReason.DUE -> {
                cancelScheduledEvaluation()
                startSampling(GuardianSamplingMode.SCHEDULED_2_MINUTE, trigger, now)
            }
            ScheduledSamplingReason.DISABLED -> {
                cancelScheduledEvaluation()
                BodySignalGuardianStore.update(this) {
                    it.copy(scheduledSamplingStatus = GuardianScheduledSamplingStatus.DISABLED)
                }
            }
            ScheduledSamplingReason.COOLDOWN -> {
                val dueAt = state.nextSamplingDueAt ?: now + SCHEDULED_SAMPLING_INTERVAL_MS
                BodySignalGuardianStore.update(this) {
                    it.copy(scheduledSamplingStatus = GuardianScheduledSamplingStatus.WAITING)
                }
                scheduleScheduledEvaluationAt(dueAt)
            }
            ScheduledSamplingReason.PAUSED -> {
                BodySignalGuardianStore.update(this) {
                    it.copy(scheduledSamplingStatus = GuardianScheduledSamplingStatus.PAUSED)
                }
                state.scheduledSamplingPauseUntil?.let(::scheduleScheduledEvaluationAt)
            }
            ScheduledSamplingReason.DEVICE_ABSENT -> {
                recordSkippedScheduledWindow(
                    trigger,
                    decision,
                    now,
                    scheduleNext = false,
                )
                if (!state.appeared && client == null) {
                    stopServiceCleanly(keepConfiguration = true)
                }
            }
            ScheduledSamplingReason.GUARDIAN_NOT_READY -> recordSkippedScheduledWindow(
                trigger,
                decision,
                now,
                scheduleNext = batteryChecked,
            )
            else -> recordSkippedScheduledWindow(trigger, decision, now, scheduleNext = true)
        }
        handler.post { tryAutomaticActivity("guardian_wakeup") }
    }

    private fun recordSkippedScheduledWindow(
        trigger: ScheduledSamplingTrigger,
        reason: ScheduledSamplingReason,
        requestedAt: Long,
        scheduleNext: Boolean,
    ) {
        val endedAt = System.currentTimeMillis()
        val current = BodySignalGuardianStore.load(this)
        val nextDue = if (scheduleNext) endedAt + SCHEDULED_SAMPLING_INTERVAL_MS else current.nextSamplingDueAt
        current.deviceProfileId?.let { profileId ->
            BodySignalGuardianLedger.recordSamplingWindow(
                this,
                profileId,
                UUID.randomUUID().toString(),
                trigger,
                reason,
                ScheduledSamplingResult.SKIPPED,
                requestedAt,
                null,
                endedAt,
                0,
            )
        }
        BodySignalGuardianStore.update(this) {
            it.copy(
                scheduledSamplingStatus = GuardianScheduledSamplingStatus.SKIPPED,
                nextSamplingDueAt = nextDue,
                lastScheduledSamplingEndedAt = endedAt,
                lastScheduledSamplingResult = ScheduledSamplingResult.SKIPPED.wireValue,
                lastScheduledSamplingReason = reason.wireValue,
                lastScheduledSamplingReadingCount = 0,
            )
        }
        if (scheduleNext && nextDue != null) scheduleScheduledEvaluationAt(nextDue)
        else cancelScheduledEvaluation()
    }

    private fun finishScheduledWindow(result: ScheduledSamplingResult, endedAt: Long) {
        val current = BodySignalGuardianStore.load(this)
        val profileId = current.deviceProfileId
        val windowId = scheduledWindowId
        if (profileId != null && windowId != null) {
            BodySignalGuardianLedger.recordSamplingWindow(
                this,
                profileId,
                windowId,
                scheduledWindowTrigger,
                scheduledWindowReason,
                result,
                scheduledWindowRequestedAt,
                sampleStartedAt.takeIf { it > 0L },
                endedAt,
                samplingReadingCount,
            )
        }
        val enabled = current.scheduledSamplingEnabled
        val nextDue = if (enabled) endedAt + SCHEDULED_SAMPLING_INTERVAL_MS else null
        BodySignalGuardianStore.update(this) {
            it.copy(
                scheduledSamplingStatus = if (enabled) {
                    GuardianScheduledSamplingStatus.WAITING
                } else GuardianScheduledSamplingStatus.DISABLED,
                nextSamplingDueAt = nextDue,
                lastScheduledSamplingEndedAt = endedAt,
                lastScheduledSamplingResult = result.wireValue,
                lastScheduledSamplingReason = scheduledWindowReason.wireValue,
                lastScheduledSamplingReadingCount = samplingReadingCount,
            )
        }
        scheduledWindowId = null
        sampleStartedAt = 0L
        if (nextDue != null) scheduleScheduledEvaluationAt(nextDue) else cancelScheduledEvaluation()
    }

    private fun abortScheduledWindowIfActive(result: ScheduledSamplingResult, reason: String) {
        if (
            activeSamplingMode != GuardianSamplingMode.SCHEDULED_2_MINUTE
            && pendingSamplingMode != GuardianSamplingMode.SCHEDULED_2_MINUTE
        ) return
        samplingStopReason = reason
        handler.removeCallbacks(sampleTimeoutRunnable)
        handler.removeCallbacks(continueRunnable)
        releaseWakeLock()
        finishScheduledWindow(result, System.currentTimeMillis())
        BodySignalGuardianStore.update(this) {
            it.copy(samplingEndsAt = null, samplingMode = null)
        }
        activeSamplingMode = null
        pendingSamplingMode = null
        samplingReadingCount = 0
        scheduledFirstReadingAt = null
    }

    private fun deferScheduledSamplingAfterManual(endedAt: Long) {
        val current = BodySignalGuardianStore.load(this)
        if (!current.scheduledSamplingEnabled) return
        val nextDue = endedAt + SCHEDULED_SAMPLING_INTERVAL_MS
        BodySignalGuardianStore.update(this) {
            it.copy(
                scheduledSamplingStatus = GuardianScheduledSamplingStatus.WAITING,
                nextSamplingDueAt = nextDue,
            )
        }
        scheduleScheduledEvaluationAt(nextDue)
    }

    private fun scheduleScheduledEvaluationAt(dueAt: Long) {
        scheduledEvaluationDueAt = dueAt
        scheduleNextEvaluation()
    }

    private fun scheduleNextEvaluation() {
        handler.removeCallbacks(scheduledEvaluationRunnable)
        val dueAt = BodySignalCarePolicy.earliest(scheduledEvaluationDueAt, BodySignalCareStore.nextCheckAt(this))
        if (dueAt == null || PhoneFocusRules.restorePaused) {
            BodySignalGuardianSamplingAlarm.cancel(this)
            return
        }
        val delay = (dueAt - System.currentTimeMillis()).coerceAtLeast(1_000L)
        handler.postDelayed(scheduledEvaluationRunnable, delay)
        BodySignalGuardianSamplingAlarm.schedule(this, dueAt)
    }

    private fun cancelScheduledEvaluation() {
        scheduledEvaluationDueAt = null
        scheduleNextEvaluation()
    }

    private fun guardianPermissionsGranted(): Boolean {
        val bluetoothGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            || ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.BLUETOOTH_CONNECT,
            ) == PackageManager.PERMISSION_GRANTED
        val notificationGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        return bluetoothGranted && notificationGranted
    }

    private fun readPhoneBattery(): Pair<Int, Boolean>? {
        val batteryIntent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val level = batteryIntent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = batteryIntent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (level < 0 || scale <= 0) return null
        val status = batteryIntent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING
            || status == BatteryManager.BATTERY_STATUS_FULL
        return ((level * 100) / scale).coerceIn(0, 100) to charging
    }

    private fun pauseGuardian() {
        BodySignalGuardianStore.update(this) { it.copy(paused = true) }
        stopServiceCleanly(keepConfiguration = true)
    }

    private fun resumeGuardian() {
        BodySignalGuardianStore.update(this) { it.copy(paused = false) }
        connectIfEligible(resetRetry = true)
    }

    private fun disableGuardian() {
        cancelScheduledEvaluation()
        abortScheduledWindowIfActive(ScheduledSamplingResult.STOPPED, "disabled")
        BodySignalGuardianVault.clear(this)
        stopServiceCleanly(keepConfiguration = false)
    }

    private fun releaseForForegroundScan() {
        abortScheduledWindowIfActive(ScheduledSamplingResult.STOPPED, "guardian_not_ready")
        cancelScheduledEvaluation()
        stopSampling("manual")
        closeGatt(expected = true)
        transition(GuardianStatus.IDLE) {
            it.copy(
                owner = GuardianOwner.LEGACY_JS,
                sessionId = null,
                samplingEndsAt = null,
                samplingMode = null,
            )
        }
        stopForegroundAndSelf()
    }

    private fun stopServiceCleanly(keepConfiguration: Boolean) {
        abortScheduledWindowIfActive(ScheduledSamplingResult.STOPPED, "guardian_not_ready")
        cancelScheduledEvaluation()
        handler.removeCallbacksAndMessages(null)
        manualPresenceOverride = false
        runCatching { if (client?.isReady() == true) client?.stopHeartRate() }
        closeGatt(expected = true)
        releaseWakeLock()
        val current = BodySignalGuardianStore.load(this)
        val next = if (keepConfiguration) current.copy(
            status = if (current.paused) GuardianStatus.SUSPENDED else GuardianStatus.IDLE,
            owner = GuardianOwner.LEGACY_JS,
            sessionId = null,
            samplingEndsAt = null,
            samplingMode = null,
            lastTransitionAt = System.currentTimeMillis(),
        ) else GuardianState()
        BodySignalGuardianStore.save(this, next)
        if (!keepConfiguration) MiBand6BatteryStore.clearCache(this)
        BodySignalGuardianLedger.recordState(this, next)
        stopForegroundAndSelf()
    }

    private fun closeGatt(expected: Boolean) {
        client?.close(expected)
        client = null
    }

    private fun transition(
        status: GuardianStatus,
        clearError: Boolean = false,
        transform: ((GuardianState) -> GuardianState)? = null,
    ) {
        val state = BodySignalGuardianStore.update(this) { current ->
            val base = transform?.invoke(current) ?: current
            base.copy(status = status, lastErrorCode = if (clearError) null else base.lastErrorCode)
        }
        BodySignalGuardianLedger.recordState(this, state)
        updateNotification(state)
    }

    private fun ensureForeground() {
        if (foregroundStarted) {
            guardianLifecycle("ensure_skipped", this)
            return
        }
        val notification = buildNotification(BodySignalGuardianStore.load(this))
        guardianLifecycle("foreground_before", this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            )
        } else startForeground(NOTIFICATION_ID, notification)
        foregroundStarted = true
        guardianLifecycle("foreground_returned", this)
    }

    private fun updateNotification(state: GuardianState) {
        if (!foregroundStarted) return
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(state))
    }

    private fun buildNotification(state: GuardianState): Notification {
        val pauseIntent = PendingIntent.getService(
            this,
            9327,
            Intent(this, BodySignalGuardianService::class.java).setAction(BodySignalGuardianController.ACTION_PAUSE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val openIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 9328, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val text = if (state.status == GuardianStatus.SAMPLING) {
            if (state.samplingMode == GuardianSamplingMode.SCHEDULED_2_MINUTE) {
                getString(R.string.body_signal_guardian_notification_scheduled_sampling)
            } else getString(R.string.body_signal_guardian_notification_sampling)
        } else getString(R.string.body_signal_guardian_notification_ready)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.body_signal_guardian_notification_title))
            .setContentText(text)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, getString(R.string.body_signal_guardian_notification_pause), pauseIntent)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.body_signal_guardian_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.body_signal_guardian_channel_description)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun stopForegroundAndSelf() {
        guardianLifecycle("stop_enter", this)
        foregroundStarted = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelfResult(lastDeliveredStartId)
        guardianLifecycle("stop_returned", this)
    }

    private fun acquireWakeLock(timeoutMs: Long) {
        releaseWakeLock()
        val power = getSystemService(PowerManager::class.java)
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "JunLuo:BodySignalGuardian")
            .apply { setReferenceCounted(false); acquire(timeoutMs) }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun associatedBluetoothDevice(associationId: Int): Pair<BluetoothDevice?, String?> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return null to "companion_api_unavailable"
        }
        val association = runCatching {
            getSystemService(CompanionDeviceManager::class.java)
                ?.myAssociations
                ?.firstOrNull { it.id == associationId }
        }.getOrNull() ?: return null to "association_unavailable"

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            runCatching { association.associatedDevice?.bleDevice?.device }
                .getOrNull()
                ?.let { return it to null }
            runCatching { association.associatedDevice?.bluetoothDevice }
                .getOrNull()
                ?.let { return it to null }
        }

        val address = association.deviceMacAddress?.toString()?.uppercase(Locale.ROOT)
            ?: return null to "association_address_unavailable"
        if (!BluetoothAdapter.checkBluetoothAddress(address)) {
            return null to "association_address_invalid"
        }
        val manager = getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter ?: BluetoothAdapter.getDefaultAdapter()
            ?: return null to "bluetooth_adapter_unavailable"
        if (!adapter.isEnabled) return null to "bluetooth_disabled"
        return try {
            adapter.getRemoteDevice(address) to null
        } catch (_: SecurityException) {
            null to "bluetooth_connect_permission_missing"
        } catch (_: IllegalArgumentException) {
            null to "association_address_invalid"
        }
    }
}
