package com.anonymous.junluo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.ContentObserver
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.math.abs
import org.json.JSONObject

/**
 * Foreground service that records countable phone usage rather than treating
 * every foreground package as proof that the user is still present.
 */
class PhoneActivityCollectorService : Service() {

    companion object {
        private const val TAG = "PhoneActivityCollector"
        private const val CHANNEL_ID = "junluo_phone_collector"
        private const val NOTIFICATION_ID = 9247
        private const val POLL_INTERVAL_MS = 500L
        private const val HINT_DEDUP_MS = 250L
        private const val MIN_DURATION_REPORT_MS = 1_000L
        private const val INITIAL_LOOKBACK_MS = 24L * 60L * 60L * 1_000L
        private const val RUNTIME_PREFS = "junluo.phoneActivityTiming.runtime"
        private const val PREF_LAST_CLOSED_AT = "lastClosedAt"
        private const val PREF_LAST_CLOSED_PACKAGE = "lastClosedPackage"

        const val ACTION_START = "com.anonymous.junluo.action.START_COLLECTOR"
        const val ACTION_STOP = "com.anonymous.junluo.action.STOP_COLLECTOR"
        const val ACTION_RESTRICTION_TICK = "com.anonymous.junluo.action.RESTRICTION_TICK"
        const val ACTION_FOREGROUND_HINT = "com.anonymous.junluo.action.FOREGROUND_HINT"
        const val ACTION_USER_INTERACTION = "com.anonymous.junluo.action.USER_INTERACTION"
        private const val EXTRA_FOREGROUND_PACKAGE = "foregroundPackage"
        private const val EXTRA_OCCURRED_AT = "occurredAt"

        @Volatile
        var isRunning = false
            private set

        @Volatile
        private var activeCollector: PhoneActivityCollectorService? = null

        @Volatile private var startRequestedAt = 0L
        @Volatile private var lastStartFailure: String? = null
        @Volatile private var lastObservationAt = 0L
        @Volatile private var lastObservationSource: String? = null

        /** Request acceptance and actual foreground operation are separate facts. */
        fun requestStart(context: Context, intent: Intent): Boolean {
            if (PhoneFocusRules.restorePaused) return false
            if (!isRunning) startRequestedAt = System.currentTimeMillis()
            return try {
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
                true
            } catch (failure: Exception) {
                startRequestedAt = 0L
                lastStartFailure = failure.javaClass.simpleName
                false
            }
        }

        fun executionStatus(): JSONObject = JSONObject().put("running", isRunning)
            .put("starting", !isRunning && startRequestedAt > 0L &&
                System.currentTimeMillis() - startRequestedAt in 0 until 10_000L)
            .put("lastStartFailure", lastStartFailure ?: JSONObject.NULL)
            .put("lastObservationAt", lastObservationAt.takeIf { it > 0L } ?: JSONObject.NULL)
            .put("lastObservationSource", lastObservationSource ?: JSONObject.NULL)
            .put("screenAvailable", activeCollector?.isScreenAvailable() ?: JSONObject.NULL)

        @Volatile
        private var timingDebugStatus = "timingState=inactive"

        @Volatile private var careUsageSnapshot: String? = null
        @Volatile private var restrictionUsageSnapshot: String? = null

        fun getCareUsageSnapshot(): String? =
            if (isRunning && !PhoneFocusRules.restorePaused) careUsageSnapshot else null

        fun getRestrictionUsageSnapshot(): String? =
            if (isRunning && !PhoneFocusRules.restorePaused) restrictionUsageSnapshot else null

        fun getTimingDebugStatus(): String = timingDebugStatus

        fun requestRestrictionRefresh(): Boolean {
            val collector = activeCollector?.takeIf { isRunning } ?: return false
            collector.scope.launch { collector.stateMutex.withLock {
                if (PhoneFocusRules.restorePaused || !isRunning) return@withLock
                try { collector.evaluateCurrentFocusRule(System.currentTimeMillis()) }
                catch (failure: Exception) { Log.w(TAG, "Restriction refresh failed", failure) }
            } }
            return true
        }

        fun notifyForegroundPackage(context: Context, packageName: String, occurredAt: Long = System.currentTimeMillis()) {
            val cleanPackage = packageName.trim()
            if (cleanPackage.isBlank()) return
            activeCollector?.enqueueForegroundHint(cleanPackage, occurredAt)
                ?: startWithPackageAction(context, ACTION_FOREGROUND_HINT, cleanPackage, occurredAt)
        }

        fun notifyUserInteraction(context: Context, packageName: String = "", occurredAt: Long = System.currentTimeMillis()) {
            val cleanPackage = packageName.trim()
            activeCollector?.enqueueUserInteraction(cleanPackage, occurredAt)
                ?: startWithPackageAction(context, ACTION_USER_INTERACTION, cleanPackage, occurredAt)
        }

        private fun startWithPackageAction(context: Context, actionName: String, packageName: String, occurredAt: Long) {
            val intent = Intent(context.applicationContext, PhoneActivityCollectorService::class.java).apply {
                action = actionName
                putExtra(EXTRA_FOREGROUND_PACKAGE, packageName)
                putExtra(EXTRA_OCCURRED_AT, occurredAt)
            }
            requestStart(context.applicationContext, intent)
        }
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val stateMutex = Mutex()
    private val timingPrefs by lazy {
        getSharedPreferences(RUNTIME_PREFS, Context.MODE_PRIVATE)
    }
    private var pollJob: Job? = null
    private var stopJob: Job? = null
    private var lastReportedPackage: String? = null
    private var lastPackageStartedAt: Long = 0L
    private var activeSegmentStartedAt: Long = 0L
    private var lastInteractionAt: Long = 0L
    private var lastClosedAt: Long = 0L
    private var lastClosedPackage: String? = null
    private var lastStopReason = PhoneUsageStopReason.NONE
    private var systemIdleTimeoutMs = PhoneUsageTimingPolicy.DEFAULT_IDLE_TIMEOUT_MS
    private var homePackages: Set<String> = emptySet()
    private var lastUsageQueryAt: Long = 0L
    private var latestForegroundAt = 0L
    private var observationStartedAt = System.currentTimeMillis()
    private var usageCountedUntil = observationStartedAt
    private var videoExempt = false
    private var lastVideoPlaying = false
    private var videoStateChangedAt: Long = 0L
    private var lastFocusRuleId: String? = null
    private var lastFocusStage: Int = 0
    private var activeUsageRuleId: String? = null
    private var activeUsageSampleAt: Long = 0L
    private var lastHintPackage: String? = null
    private var lastHintAt: Long = 0L
    private var thresholdAlarmJob: Job? = null
    private var thresholdAlarmRuleId: String? = null
    private var thresholdAlarmPackage: String? = null
    private var thresholdAlarmAt: Long = 0L
    private var screenReceiverRegistered = false

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val now = System.currentTimeMillis()
            when (intent?.action) {
                Intent.ACTION_SCREEN_OFF -> enqueueForcedStop(PhoneUsageStopReason.SCREEN_OFF, now)
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> enqueueTimingRefresh(now)
            }
        }
    }

    private val screenTimeoutObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
            systemIdleTimeoutMs = PhoneUsageEnvironment.readIdleTimeout(applicationContext)
            enqueueTimingRefresh(System.currentTimeMillis())
        }
    }

    override fun onCreate() {
        super.onCreate()
        activeCollector = this
        lastClosedAt = timingPrefs.getLong(PREF_LAST_CLOSED_AT, 0L)
        lastClosedPackage = timingPrefs.getString(PREF_LAST_CLOSED_PACKAGE, null)
        systemIdleTimeoutMs = PhoneUsageEnvironment.readIdleTimeout(applicationContext)
        homePackages = PhoneUsageEnvironment.resolveHomePackages(applicationContext)
        registerTimingObservers()
        createNotificationChannel()
        updateTimingDebugStatus(System.currentTimeMillis())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != ACTION_STOP && !startCollecting()) {
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_START, ACTION_RESTRICTION_TICK, null -> requestRestrictionRefresh()
            ACTION_STOP -> {
                stopCollecting()
                stopSelf()
            }
            ACTION_FOREGROUND_HINT -> {
                enqueueForegroundHint(
                    intent.getStringExtra(EXTRA_FOREGROUND_PACKAGE).orEmpty(),
                    intent.getLongExtra(EXTRA_OCCURRED_AT, System.currentTimeMillis()),
                )
            }
            ACTION_USER_INTERACTION -> {
                enqueueUserInteraction(
                    intent.getStringExtra(EXTRA_FOREGROUND_PACKAGE).orEmpty(),
                    intent.getLongExtra(EXTRA_OCCURRED_AT, System.currentTimeMillis()),
                )
            }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startCollecting(): Boolean {
        if (PhoneFocusRules.restorePaused) return false
        if (isRunning) return true
        try {
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (failure: Exception) {
            isRunning = false
            startRequestedAt = 0L
            lastStartFailure = failure.javaClass.simpleName
            Log.w(TAG, "Collector foreground start failed", failure)
            return false
        }

        isRunning = true
        startRequestedAt = 0L
        lastStartFailure = null
        lastObservationAt = 0L
        lastObservationSource = null
        observationStartedAt = System.currentTimeMillis()
        usageCountedUntil = maxOf(usageCountedUntil, observationStartedAt)

        Log.i(TAG, "Collector started, polling every ${POLL_INTERVAL_MS}ms")
        val pendingStop = stopJob
        pollJob = scope.launch {
            pendingStop?.join()
            pollAndReport()
            while (isActive) {
                delay(POLL_INTERVAL_MS)
                pollAndReport()
            }
        }
        return true
    }

    private fun stopCollecting(afterStop: () -> Unit = {}) {
        startRequestedAt = 0L
        PhoneFocusCountdown.hide()
        careUsageSnapshot = null
        restrictionUsageSnapshot = null
        if (!isRunning) {
            scope.launch { stopJob?.join(); afterStop() }
            return
        }
        isRunning = false
        val stoppedAt = System.currentTimeMillis()
        val previousStop = stopJob
        val currentPoll = pollJob
        pollJob = null
        currentPoll?.cancel()
        // Never block the main thread while a collector request is awaiting actual overlay creation.
        stopJob = scope.launch {
            previousStop?.join()
            currentPoll?.join()
            stateMutex.withLock {
                restrictionUsageSnapshot = null
                closeForHardBoundary(
                    stoppedAt,
                    PhoneUsageStopReason.COLLECTOR_STOP,
                )
                lastReportedPackage = null
                lastPackageStartedAt = 0L
                lastInteractionAt = 0L
                lastUsageQueryAt = 0L
                updateTimingDebugStatus(System.currentTimeMillis())
            }
            PhoneFocusCountdown.hide()
            afterStop()
        }
        Log.i(TAG, "Collector stopped")
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onDestroy() {
        stopCollecting { scope.cancel() }
        unregisterTimingObservers()
        if (activeCollector === this) activeCollector = null
        super.onDestroy()
    }

    private fun enqueueForegroundHint(packageName: String, now: Long) {
        careUsageSnapshot = null
        val pendingStop = stopJob
        scope.launch {
            pendingStop?.join()
            stateMutex.withLock {
                if (!isRunning) return@withLock
                restrictionUsageSnapshot = null
                handleForegroundHint(packageName, now)
            }
        }
    }

    private fun enqueueUserInteraction(packageName: String, now: Long) {
        val pendingStop = stopJob
        scope.launch {
            pendingStop?.join()
            stateMutex.withLock {
                if (!isRunning) return@withLock
                restrictionUsageSnapshot = null
                handleUserInteraction(packageName, now)
            }
        }
    }

    private fun enqueueForcedStop(reason: PhoneUsageStopReason, now: Long) {
        careUsageSnapshot = null
        val pendingStop = stopJob
        scope.launch {
            pendingStop?.join()
            stateMutex.withLock {
                if (!isRunning) return@withLock
                restrictionUsageSnapshot = null
                closeActiveSegment(now, reason)
                updateTimingDebugStatus(now)
            }
        }
    }

    private fun enqueueTimingRefresh(now: Long) {
        val pendingStop = stopJob
        scope.launch {
            pendingStop?.join()
            stateMutex.withLock {
                if (!isRunning) return@withLock
                restrictionUsageSnapshot = null
                evaluateTimingState(now)
                updateTimingDebugStatus(now)
            }
        }
    }

    private fun handleForegroundHint(packageName: String, now: Long) {
        val cleanPackage = packageName.trim()
        if (cleanPackage.isBlank()) return
        if (!PhoneFocusPolicy.acceptsForeground(now, latestForegroundAt)) return
        lastObservationAt = now
        lastObservationSource = "accessibilityForeground"
        latestForegroundAt = now
        if (cleanPackage == lastHintPackage && now - lastHintAt < HINT_DEDUP_MS) return
        if (cleanPackage != lastReportedPackage) {
            val start = PhoneFocusPolicy.observedStart(now, observationStartedAt, usageCountedUntil)
            transitionToPackage(cleanPackage, start, start)
        }
        evaluateTimingState(now)
        evaluateCurrentFocusRule(now)
        lastHintPackage = cleanPackage
        lastHintAt = now
        updateTimingDebugStatus(now)
    }

    private fun handleUserInteraction(packageName: String, now: Long) {
        val cleanPackage = packageName.trim().ifBlank { lastReportedPackage.orEmpty() }
        if (cleanPackage.isBlank()) return
        if (now < latestForegroundAt) return
        if (cleanPackage != lastReportedPackage) {
            latestForegroundAt = now
            val start = PhoneFocusPolicy.observedStart(now, observationStartedAt, usageCountedUntil)
            transitionToPackage(cleanPackage, start, start)
        } else {
            lastInteractionAt = maxOf(lastInteractionAt, now)
            if (
                activeSegmentStartedAt <= 0L &&
                !isNonCountablePackage(cleanPackage) &&
                isScreenAvailable()
            ) {
                startActiveSegment(cleanPackage, now)
            }
        }
        evaluateTimingState(now)
        evaluateCurrentFocusRule(now)
        updateTimingDebugStatus(now)
    }

    private suspend fun pollAndReport() {
        stateMutex.withLock {
            if (!isRunning) return@withLock
            restrictionUsageSnapshot = null
            try {
                val now = System.currentTimeMillis()
                val usageStatsManager = getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
                    ?: return@withLock
                val queryStart = if (lastUsageQueryAt > 0L) {
                    maxOf(now - INITIAL_LOOKBACK_MS, lastUsageQueryAt - 1_000L)
                } else {
                    now - INITIAL_LOOKBACK_MS
                }
                val events = usageStatsManager.queryEvents(queryStart, now)
                val interactionsByPackage = mutableMapOf<String, Long>()
                var foregroundPackage = lastReportedPackage
                var foregroundStartedAt = lastPackageStartedAt

                val event = UsageEvents.Event()
                while (events.hasNextEvent()) {
                    events.getNextEvent(event)
                    when {
                        isForegroundEvent(event.eventType) && PhoneFocusPolicy.acceptsForeground(event.timeStamp, latestForegroundAt) -> {
                            latestForegroundAt = event.timeStamp
                            foregroundPackage = event.packageName
                            foregroundStartedAt = event.timeStamp
                            interactionsByPackage[event.packageName] = maxOf(
                                interactionsByPackage[event.packageName] ?: 0L,
                                event.timeStamp,
                            )
                        }
                        event.eventType == UsageEvents.Event.USER_INTERACTION -> {
                            interactionsByPackage[event.packageName] = maxOf(
                                interactionsByPackage[event.packageName] ?: 0L,
                                event.timeStamp,
                            )
                        }
                    }
                }
                lastUsageQueryAt = now
                lastObservationAt = now
                lastObservationSource = "usageQuery"

                val cleanPackage = foregroundPackage?.trim().orEmpty()
                if (cleanPackage.isBlank()) {
                    evaluateTimingState(now)
                    evaluateCurrentFocusRule(now)
                    updateTimingDebugStatus(now)
                    updateCareUsageSnapshot(now)
                    return@withLock
                }
                val interactionAt = maxOf(
                    foregroundStartedAt.takeIf { it > 0L } ?: now,
                    interactionsByPackage[cleanPackage] ?: 0L,
                )
                if (cleanPackage != lastReportedPackage) {
                    val start = PhoneFocusPolicy.observedStart(foregroundStartedAt.takeIf { it > 0L } ?: now, observationStartedAt, usageCountedUntil)
                    transitionToPackage(
                        cleanPackage,
                        start,
                        maxOf(start, interactionAt),
                    )
                } else if (interactionAt > lastInteractionAt) {
                    lastInteractionAt = interactionAt
                    if (
                        activeSegmentStartedAt <= 0L &&
                        interactionAt > lastClosedAt &&
                        !isNonCountablePackage(cleanPackage) &&
                        isScreenAvailable()
                    ) {
                        startActiveSegment(cleanPackage, PhoneFocusPolicy.observedStart(interactionAt, observationStartedAt, usageCountedUntil))
                    }
                }

                evaluateTimingState(now)
                evaluateCurrentFocusRule(now)
                updateTimingDebugStatus(now)
                updateCareUsageSnapshot(now)
            } catch (e: Exception) {
                careUsageSnapshot = null
                Log.e(TAG, "Error in pollAndReport: ${e.message}", e)
            }
        }
        if (isRunning) PhoneGuardMessageTaskService.checkCareFollowUp(applicationContext, System.currentTimeMillis())
    }

    private fun updateCareUsageSnapshot(now: Long) {
        val currentPackage = lastReportedPackage.orEmpty()
        val managed = PhoneCareFollowUpPolicy.isManagedUsage(
            isRunning, PhoneFocusRules.restorePaused, isScreenAvailable(), activeSegmentStartedAt > 0L,
            currentPackage == applicationContext.packageName,
            PhoneFocusRules.isCareManagedApp(applicationContext, currentPackage),
        )
        careUsageSnapshot = JSONObject().put("observedAt", now).put("usingManagedApp", managed).toString()
        // Separate technical projection: the existing care/model payload above stays unchanged.
        if (PhoneFocusRules.restorePaused) return
        val ongoing = if (activeSegmentStartedAt in 1 until now &&
            currentPackage.isNotBlank() && !isNonCountablePackage(currentPackage) && isScreenAvailable()) {
            JSONObject().put("packageName", currentPackage).put("from", activeSegmentStartedAt).put("until", now)
        } else JSONObject.NULL
        val rules = PhoneFocusRules.restrictionUsageObservation(applicationContext, now)
        restrictionUsageSnapshot = JSONObject().put("observedAt", now)
            .put("rules", rules.getJSONArray("rules")).put("rulesKnown", rules.getBoolean("rulesKnown"))
            .put("ongoing", ongoing).toString()
    }

    private fun transitionToPackage(packageName: String, transitionAt: Long, interactionAt: Long) {
        val departedRuleId = if (packageName != lastReportedPackage && isScreenAvailable()) {
            PhoneFocusOverlay.departingLegacyRuleId()?.takeIf { shownId ->
                PhoneFocusRules.blacklistRules(applicationContext).any {
                    it.id == shownId && it.source == lastReportedPackage
                }
            }
        } else null
        if (packageName == applicationContext.packageName) {
            val triggerId = PhoneFocusOverlay.activeTriggerId()
            PhoneFocusRules.recordReturned(applicationContext, triggerId, transitionAt)
        }
        PhoneFocusOverlay.dismiss(applicationContext)
        closeForHardBoundary(transitionAt, PhoneUsageStopReason.APP_SWITCH)
        // Settle the departing App's tail before resetting only its ordinary allowance.
        if (departedRuleId != null) {
            PhoneFocusRules.recordOverlayDeparture(applicationContext, departedRuleId, lastPackageStartedAt, transitionAt)
        }
        homePackages = PhoneUsageEnvironment.resolveHomePackages(applicationContext)
        lastReportedPackage = packageName
        lastPackageStartedAt = transitionAt
        lastInteractionAt = maxOf(transitionAt, interactionAt)
        lastFocusRuleId = null
        lastFocusStage = 0
        lastVideoPlaying = false
        videoStateChangedAt = transitionAt
        videoExempt = false

        val nonCountableReason = nonCountableReason(packageName)
        if (nonCountableReason != null) {
            lastStopReason = nonCountableReason
            stopTrackingUsage()
            return
        }
        val alreadyClosed = lastClosedPackage == packageName && lastClosedAt >= lastInteractionAt
        if (!alreadyClosed) {
            val startAt = if (
                lastClosedPackage == packageName &&
                lastClosedAt >= transitionAt
            ) {
                lastInteractionAt
            } else {
                transitionAt
            }
            startActiveSegment(packageName, startAt)
        }
    }

    private fun startActiveSegment(packageName: String, startedAt: Long) {
        if (startedAt <= 0L || isNonCountablePackage(packageName)) return
        activeSegmentStartedAt = startedAt
        videoExempt = false
        reportForegroundApp(packageName, startedAt)
    }

    private fun evaluateTimingState(now: Long) {
        val packageName = lastReportedPackage?.trim().orEmpty()
        if (packageName.isBlank() || activeSegmentStartedAt <= 0L) {
            stopTrackingUsage()
            return
        }
        val screen = PhoneUsageEnvironment.readScreen(applicationContext)
        val videoPlaying = PhoneUsageEnvironment.isForegroundVideoPlaying(
            applicationContext,
            packageName,
        )
        if (videoPlaying != lastVideoPlaying) {
            lastVideoPlaying = videoPlaying
            videoStateChangedAt = now
        }
        val decision = PhoneUsageTimingPolicy.decide(
            PhoneUsageTimingInput(
                foregroundPackage = packageName,
                foregroundStartedAt = activeSegmentStartedAt,
                lastInteractionAt = lastInteractionAt,
                systemIdleTimeoutMs = systemIdleTimeoutMs,
                isInteractive = screen.isInteractive,
                displayState = screen.displayState,
                isHomePackage = nonCountableReason(packageName) == PhoneUsageStopReason.HOME,
                isOwnPackage = packageName == applicationContext.packageName,
                isSystemUiPackage = PhoneUsageEnvironment.isSystemUiPackage(packageName),
                isVideoPlaying = videoPlaying,
                wasVideoExempt = videoExempt,
                videoStateChangedAt = videoStateChangedAt.takeIf { it > 0L },
                lastClosedAt = lastClosedAt,
                lastClosedPackage = lastClosedPackage,
                now = now,
            )
        )
        if (decision.isCounting) {
            videoExempt = decision.videoExempt
            return
        }
        closeActiveSegment(
            decision.segmentEndedAt ?: now,
            decision.stopReason,
        )
    }

    private fun closeForHardBoundary(endedAt: Long, reason: PhoneUsageStopReason) {
        val idleDeadlineAt = idleDeadlineAt()
        if (
            activeSegmentStartedAt > 0L
            && !videoExempt
            && idleDeadlineAt > 0L
            && endedAt >= idleDeadlineAt
        ) {
            closeActiveSegment(idleDeadlineAt, PhoneUsageStopReason.IDLE_TIMEOUT)
            return
        }
        closeActiveSegment(endedAt, reason)
    }

    private fun idleDeadlineAt(): Long {
        if (lastInteractionAt <= 0L) return 0L
        val timeout = PhoneUsageTimingPolicy.normalizeIdleTimeout(systemIdleTimeoutMs)
        return if (lastInteractionAt > Long.MAX_VALUE - timeout) {
            Long.MAX_VALUE
        } else {
            lastInteractionAt + timeout
        }
    }

    private fun closeActiveSegment(endedAt: Long, reason: PhoneUsageStopReason) {
        PhoneFocusOverlay.dismiss(applicationContext)
        lastFocusRuleId = null
        lastFocusStage = 0
        lastStopReason = reason
        val packageName = lastReportedPackage?.trim().orEmpty()
        val startedAt = activeSegmentStartedAt
        if (packageName.isNotBlank() && startedAt > 0L) {
            val safeEnd = endedAt.coerceAtLeast(startedAt)
            reportDurationSegment(packageName, startedAt, safeEnd)
            flushActiveUsage(safeEnd)
            activeSegmentStartedAt = 0L
            lastClosedAt = maxOf(lastClosedAt, safeEnd)
            lastClosedPackage = packageName
            timingPrefs.edit()
                .putLong(PREF_LAST_CLOSED_AT, lastClosedAt)
                .putString(PREF_LAST_CLOSED_PACKAGE, packageName)
                .apply()
        }
        stopTrackingUsage()
        videoExempt = false
        updateTimingDebugStatus(System.currentTimeMillis())
    }

    private fun isScreenAvailable(): Boolean {
        val screen = PhoneUsageEnvironment.readScreen(applicationContext)
        return screen.isInteractive && screen.displayState == PhoneUsageDisplayState.ON
    }

    private fun nonCountableReason(packageName: String): PhoneUsageStopReason? {
        return when {
            packageName == applicationContext.packageName -> PhoneUsageStopReason.OWN_APP
            homePackages.contains(packageName) && (
                isAppRestrictionExempt(packageName) ||
                    PhoneFocusRules.blacklistRules(applicationContext).none { it.source == packageName && it.appLock }
                ) -> PhoneUsageStopReason.HOME
            PhoneUsageEnvironment.isSystemUiPackage(packageName) -> PhoneUsageStopReason.SYSTEM_UI
            else -> null
        }
    }

    private fun isNonCountablePackage(packageName: String): Boolean {
        return nonCountableReason(packageName) != null
    }

    private fun isAppRestrictionExempt(packageName: String): Boolean {
        if (packageName == applicationContext.packageName || PhoneUsageEnvironment.isSystemUiPackage(packageName)) return true
        if (!homePackages.contains(packageName)) return false
        // Settings also owns Android's FallbackHome. That does not make its
        // normal pages a launcher; only new App locks use this narrower gate.
        val home = PhoneUsageEnvironment.resolveDefaultHomePackage(applicationContext)
        return home == null || packageName == home
    }

    private fun isForegroundEvent(eventType: Int): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            eventType == UsageEvents.Event.ACTIVITY_RESUMED
        } else {
            eventType == UsageEvents.Event.MOVE_TO_FOREGROUND
        }
    }

    private fun resolveAppName(packageName: String): String {
        return try {
            val appInfo = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(appInfo).toString()
        } catch (_: Exception) {
            packageName
        }
    }

    private fun reportForegroundApp(packageName: String, startedAt: Long) {
        val appName = resolveAppName(packageName)
        val payload = PhoneActivityReporter.ReportPayload(
            kind = "foreground_app",
            source = packageName,
            title = appName,
            started_at = startedAt,
            duration_ms = 0,
            sensitive_level = "normal",
        )
        if (PhoneActivityReporter.report(applicationContext, payload)) {
            Log.i(TAG, "Recorded: $appName ($packageName)")
        }
    }

    private fun reportDurationSegment(packageName: String?, startedAt: Long, endedAt: Long) {
        val source = packageName?.trim().orEmpty()
        if (
            source.isBlank() ||
            isNonCountablePackage(source) ||
            startedAt <= 0L ||
            endedAt <= startedAt
        ) {
            return
        }
        val durationMs = endedAt - startedAt
        if (durationMs < MIN_DURATION_REPORT_MS) return
        val appName = resolveAppName(source)
        val payload = PhoneActivityReporter.ReportPayload(
            kind = "foreground_app_duration",
            source = source,
            title = appName,
            started_at = startedAt,
            ended_at = endedAt,
            duration_ms = durationMs,
            sensitive_level = "normal",
        )
        if (PhoneActivityReporter.report(applicationContext, payload)) {
            Log.i(TAG, "Duration: $appName ${durationMs}ms reason=${lastStopReason.name}")
        }
    }

    private fun evaluateCurrentFocusRule(now: Long) {
        PhoneRestrictionRuntime.reconcilePlans(applicationContext, now)
        PhoneRestrictionRuntime.observeEmergencyEnd(applicationContext, now)
        PhoneFocusOverlay.dismissForRestriction(applicationContext)
        if (PhoneRestrictionWindow.update(applicationContext, lastReportedPackage.orEmpty(), now)) {
            cancelThresholdAlarm()
            PhoneFocusCountdown.hide()
            PhoneFocusOverlay.dismiss(applicationContext)
            val records = PhoneRestrictionRuntime.phoneBlockingRecords(applicationContext, lastReportedPackage.orEmpty(), now)
            if (PhoneRestrictionWindow.isShowing() && records.any { it.restriction.enteredAt == null }) {
                PhoneRestrictionRuntime.recordPhoneWindowEntry(applicationContext, lastReportedPackage.orEmpty(),
                    records.map { it.restriction.id }.toSet())
            }
            return
        }
        val packageName = lastReportedPackage.orEmpty()
        if (evaluateAppRestriction(packageName, now)) return
        PhoneFocusCountdown.updateRestriction(applicationContext, packageName, now, isScreenAvailable())
        if (activeSegmentStartedAt <= 0L || isNonCountablePackage(packageName)) {
            stopTrackingUsage()
            return
        }
        evaluateFocusRule(packageName, now)
    }

    private fun evaluateAppRestriction(packageName: String, now: Long): Boolean {
        if (!isScreenAvailable() || isAppRestrictionExempt(packageName)) return false
        val records = PhoneRestrictionRuntime.appBlockingRecords(applicationContext, packageName, now)
        if (records.isEmpty() && !PhoneRestrictionRuntime.isAppTimeBlocked(applicationContext, packageName, now)) return false
        // Settle the existing sampled counter before showing; passes never reset daily usage.
        if (activeSegmentStartedAt > 0L) {
            PhoneFocusRules.blacklistRules(applicationContext).firstOrNull { it.source == packageName }
                ?.let { updateAccumulatedUsage(it, now) }
        }
        cancelThresholdAlarm()
        PhoneFocusCountdown.hide()
        val shown = PhoneFocusOverlay.showAppRestriction(applicationContext, packageName)
        if (shown && records.any { it.restriction.enteredAt == null }) {
            PhoneRestrictionRuntime.recordAppOverlayEntry(applicationContext, packageName, records.map { it.restriction.id }.toSet())
        }
        return true
    }

    private fun evaluateFocusRule(packageName: String, now: Long) {
        if (
            activeSegmentStartedAt <= 0L ||
            packageName != lastReportedPackage ||
            isNonCountablePackage(packageName)
        ) {
            stopTrackingUsage()
            return
        }
        val rule = PhoneFocusRules.blacklistRules(applicationContext).firstOrNull { it.source == packageName }
        if (rule == null) {
            stopTrackingUsage()
            return
        }
        val dailyLimitMs = rule.dailyLimitMinutes * 60_000L
        val durationMs = updateAccumulatedUsage(rule, now)
        val dailyUsageMs = PhoneFocusRules.dailyAccumulatedUsage(applicationContext, rule.id, now)
        if (PhoneRestrictionRuntime.isBlockingReleased(applicationContext, packageName, now)) {
            cancelThresholdAlarm()
            PhoneFocusOverlay.dismissForRestriction(applicationContext)
            PhoneFocusCountdown.hideUsage()
            return
        }
        val returnAt = PhoneFocusRules.pendingReturnAt(applicationContext, rule, now)
        if (returnAt != null && lastPackageStartedAt > returnAt) {
            cancelThresholdAlarm()
            if (showFinalFocusOverlay(rule, packageName, 0L, now, "blacklist-return") &&
                PhoneFocusOverlay.isAppRestrictionShowing(rule.id)) {
                PhoneFocusRules.consumeReturnIfEligible(applicationContext, rule, now, returnAt)
            }
            return
        }
        if (dailyUsageMs >= dailyLimitMs) {
            cancelThresholdAlarm()
            showFinalFocusOverlay(rule, packageName, dailyUsageMs, now, triggerKindFor(rule))
            return
        }
        var visible = lastFocusRuleId == rule.id && PhoneFocusOverlay.isShowing(rule.id)
        val thresholdMs = rule.thresholdMinutes * 60_000L
        val dayReleased = if (lastFocusRuleId == rule.id && durationMs < thresholdMs)
            PhoneFocusOverlay.dismissForNewUsageDay(applicationContext, rule.id, now) else null
        if (dayReleased == false) {
            cancelThresholdAlarm()
            PhoneFocusCountdown.hide()
            return
        }
        if (dayReleased == true) {
            visible = false
            lastFocusRuleId = null
            lastFocusStage = 0
        }
        val display = PhoneFocusPolicy.display(visible, lastFocusStage, durationMs >= thresholdMs,
            rule.appLock && durationMs >= thresholdMs)
        if (visible && display == null) {
            PhoneFocusCountdown.hide()
            return
        }
        if (durationMs < thresholdMs) {
            PhoneFocusCountdown.update(applicationContext, thresholdMs - durationMs, dailyLimitMs - dailyUsageMs, packageName)
            scheduleThresholdAlarm(rule, packageName, now, durationMs, thresholdMs)
            return
        }
        cancelThresholdAlarm()
        val stage = display?.stage ?: return
        val shown = if (rule.appLock) PhoneFocusOverlay.showMaxStage(applicationContext, "", "返回君落", rule.id)
            else PhoneFocusOverlay.show(applicationContext, "", stage, "返回君落", rule.id)
        if (!shown) return
        if (display.startsMessage) {
            val payload = PhoneFocusRules.recordPendingTrigger(
                applicationContext,
                rule,
                packageName,
                durationMs,
                stage,
                triggerKindFor(rule),
                now,
            )
            PhoneFocusOverlay.startMessageTask(applicationContext, rule.id, payload)
        }
        lastFocusRuleId = rule.id
        lastFocusStage = stage
    }

    private fun scheduleThresholdAlarm(
        rule: PhoneFocusRules.Rule,
        packageName: String,
        now: Long,
        durationMs: Long,
        thresholdMs: Long,
    ) {
        val remainingMs = thresholdMs - durationMs
        if (remainingMs <= 0L) return
        val alarmAt = now + remainingMs
        val currentJob = thresholdAlarmJob
        if (
            currentJob?.isActive == true &&
            thresholdAlarmRuleId == rule.id &&
            thresholdAlarmPackage == packageName &&
            abs(thresholdAlarmAt - alarmAt) <= HINT_DEDUP_MS
        ) {
            return
        }
        cancelThresholdAlarm()
        thresholdAlarmRuleId = rule.id
        thresholdAlarmPackage = packageName
        thresholdAlarmAt = alarmAt
        thresholdAlarmJob = scope.launch {
            delay((alarmAt - System.currentTimeMillis()).coerceAtLeast(0L))
            thresholdAlarmJob = null
            thresholdAlarmRuleId = null
            thresholdAlarmPackage = null
            thresholdAlarmAt = 0L
            stateMutex.withLock {
                restrictionUsageSnapshot = null
                val currentNow = System.currentTimeMillis()
                evaluateTimingState(currentNow)
                if (lastReportedPackage == packageName && activeSegmentStartedAt > 0L) {
                    evaluateCurrentFocusRule(currentNow)
                }
                updateTimingDebugStatus(currentNow)
            }
        }
    }

    private fun cancelThresholdAlarm() {
        thresholdAlarmJob?.cancel()
        thresholdAlarmJob = null
        thresholdAlarmRuleId = null
        thresholdAlarmPackage = null
        thresholdAlarmAt = 0L
    }

    private fun showFinalFocusOverlay(
        rule: PhoneFocusRules.Rule,
        packageName: String,
        durationMs: Long,
        now: Long,
        triggerKind: String = "blacklist",
    ): Boolean {
        val display = PhoneFocusPolicy.display(
            lastFocusRuleId == rule.id && PhoneFocusOverlay.isShowing(rule.id), lastFocusStage, true, true,
        ) ?: return PhoneFocusOverlay.isShowing(rule.id)
        val shown = PhoneFocusOverlay.showMaxStage(
            applicationContext,
            "",
            "被白云小姐抓回来",
            rule.id,
        )
        if (!shown) return false
        if (!display.startsMessage) { lastFocusStage = display.stage; return true }
        val payload = PhoneFocusRules.recordPendingTrigger(
            applicationContext,
            rule,
            packageName,
            durationMs,
            3,
            triggerKind,
            now,
        )
        PhoneFocusOverlay.startMessageTask(applicationContext, rule.id, payload)
        lastFocusRuleId = rule.id
        lastFocusStage = 3
        return true
    }

    private fun updateAccumulatedUsage(rule: PhoneFocusRules.Rule, now: Long): Long {
        if (activeUsageRuleId != rule.id) {
            activeUsageRuleId = rule.id
            activeUsageSampleAt = maxOf(activeSegmentStartedAt.takeIf { it > 0L } ?: now, usageCountedUntil)
        }
        flushActiveUsage(now)
        return PhoneFocusRules.accumulatedUsage(applicationContext, rule.id, now)
    }

    private fun flushActiveUsage(until: Long) {
        val ruleId = activeUsageRuleId ?: return
        val sampledAt = activeUsageSampleAt
        if (sampledAt <= 0L) return
        val durationMs = (until - sampledAt).coerceAtLeast(0L)
        if (durationMs > 0L) {
            PhoneFocusRules.addAccumulatedUsage(applicationContext, ruleId, durationMs, until)
        }
        activeUsageSampleAt = maxOf(sampledAt, until)
        usageCountedUntil = maxOf(usageCountedUntil, activeUsageSampleAt)
    }

    private fun stopTrackingUsage() {
        PhoneFocusCountdown.hideUsage()
        cancelThresholdAlarm()
        activeUsageRuleId = null
        activeUsageSampleAt = 0L
    }

    private fun triggerKindFor(rule: PhoneFocusRules.Rule): String {
        return if (rule.kind == "jealousy") "jealousy" else "blacklist"
    }

    private fun registerTimingObservers() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(screenReceiver, filter)
        }
        screenReceiverRegistered = true
        contentResolver.registerContentObserver(
            Settings.System.getUriFor(Settings.System.SCREEN_OFF_TIMEOUT),
            false,
            screenTimeoutObserver,
        )
    }

    private fun unregisterTimingObservers() {
        if (screenReceiverRegistered) {
            runCatching { unregisterReceiver(screenReceiver) }
            screenReceiverRegistered = false
        }
        runCatching { contentResolver.unregisterContentObserver(screenTimeoutObserver) }
    }

    private fun updateTimingDebugStatus(now: Long) {
        val idleDeadlineAt = idleDeadlineAt()
        timingDebugStatus = listOf(
            "foregroundPackage=${lastReportedPackage.orEmpty()}",
            "counting=${activeSegmentStartedAt > 0L}",
            "segmentStartedAt=$activeSegmentStartedAt",
            "lastInteractionAt=$lastInteractionAt",
            "idleDeadlineAt=$idleDeadlineAt",
            "systemIdleTimeoutMs=$systemIdleTimeoutMs",
            "videoPlaying=$lastVideoPlaying",
            "videoExempt=$videoExempt",
            "lastClosedAt=$lastClosedAt",
            "lastStopReason=${lastStopReason.name.lowercase()}",
            "debugUpdatedAt=$now",
        ).joinToString("\n")
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.phone_collector_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "君落 前台应用活动采集通知"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val tapIntent = Intent(this, MainActivity::class.java).let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                } else {
                    PendingIntent.FLAG_UPDATE_CURRENT
                },
            )
        }

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle(getString(R.string.phone_collector_notification_title))
                .setContentText(getString(R.string.phone_collector_notification_text))
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setContentIntent(tapIntent)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle(getString(R.string.phone_collector_notification_title))
                .setContentText(getString(R.string.phone_collector_notification_text))
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setContentIntent(tapIntent)
                .setPriority(Notification.PRIORITY_LOW)
                .build()
        }
    }
}
