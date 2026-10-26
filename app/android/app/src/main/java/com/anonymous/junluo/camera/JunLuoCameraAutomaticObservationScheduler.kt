package com.anonymous.junluo.camera

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Handler

/** Session monitor only. Model-selected requests are claimed by the bridge, never dispatched here. */
internal class JunLuoCameraAutomaticObservationScheduler(
    private val context: Context,
    private val handler: Handler,
    private val onStateChanged: () -> Unit,
    private val onPersistenceFailure: () -> Unit,
) {
    private var watchdog: Runnable? = null
    private var watchdogKey: String? = null

    fun start() {
        cancelAlarm(context)
        tick()
    }

    fun stop() {
        watchdog?.let(handler::removeCallbacks)
        watchdog = null
        watchdogKey = null
        cancelAlarm(context)
    }

    fun prerequisiteMayHaveRecovered() = tick()

    fun tick() {
        try {
            // Retire already registered Chapter 12 alarms as well as their dispatch path.
            cancelAlarm(context)
            val updated = JunLuoCameraServiceStore.update(context) { snapshot ->
                snapshot.copy(
                    hardDeadlineAt = null,
                    automaticObservation = recomputeAutomaticObservationState(
                        snapshot.automaticObservation,
                        junLuoCameraAutomaticNow(),
                        snapshot.status == JunLuoCameraServiceStatus.RUNNING && snapshot.sessionId != null,
                    ),
                )
            }
            onStateChanged()
            if (updated.automaticObservation.phase == JunLuoCameraAutomaticPhase.EXECUTING) {
                scheduleWatchdog(updated)
            } else {
                watchdog?.let(handler::removeCallbacks)
                watchdog = null
                watchdogKey = null
            }
        } catch (_: JunLuoCameraStatePersistException) {
            onPersistenceFailure()
        }
    }

    private fun scheduleWatchdog(snapshot: JunLuoCameraServiceSnapshot) {
        val state = snapshot.automaticObservation
        val sessionId = snapshot.sessionId ?: return
        val attemptId = state.activeAttemptId ?: return
        val requestId = state.activeRequestId ?: return
        val key = "$sessionId:$attemptId:$requestId:${state.scheduleGeneration}"
        if (watchdog != null && watchdogKey == key) return
        watchdog?.let(handler::removeCallbacks)
        watchdogKey = key
        val remaining = ((state.lastAttemptAt ?: junLuoCameraAutomaticNow()) +
            JUNLUO_CAMERA_AUTOMATIC_WATCHDOG_MS - junLuoCameraAutomaticNow()).coerceAtLeast(0L)
        watchdog = Runnable {
            try {
                JunLuoCameraServiceStore.update(context) { current ->
                    if (current.sessionId != sessionId) current else {
                        val settled = completeAutomaticObservationAttempt(
                            current.automaticObservation,
                            JunLuoCameraAutomaticCompletionRequest(
                                sessionId, attemptId, requestId, state.scheduleGeneration,
                                "failure", "camera_automatic_watchdog_timeout", null, null,
                            ),
                            junLuoCameraAutomaticNow(),
                        )
                        if (settled == null) current else current.copy(automaticObservation = settled)
                    }
                }
                onStateChanged()
            } catch (_: JunLuoCameraStatePersistException) {
                onPersistenceFailure()
            }
            watchdog = null
            watchdogKey = null
        }.also { handler.postDelayed(it, remaining) }
    }

    companion object {
        private const val ALARM_REQUEST_CODE = 73053

        fun cancelAlarm(context: Context) {
            val pending = PendingIntent.getBroadcast(
                context, ALARM_REQUEST_CODE,
                Intent(context, JunLuoCameraAutomaticObservationAlarmReceiver::class.java).apply {
                    action = JunLuoCameraAutomaticObservationAlarmReceiver.ACTION
                },
                PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
            ) ?: return
            context.getSystemService(AlarmManager::class.java).cancel(pending)
            pending.cancel()
        }

        fun networkAvailable(context: Context): Boolean = runCatching {
            val manager = context.getSystemService(ConnectivityManager::class.java)
            val network = manager.activeNetwork ?: return@runCatching false
            val capabilities = manager.getNetworkCapabilities(network) ?: return@runCatching false
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        }.getOrDefault(false)

        fun prerequisiteFailure(
            context: Context,
            snapshot: JunLuoCameraServiceSnapshot,
            allowExistingFrame: Boolean = false,
        ): String? {
            JunLuoCameraRuntimeConditions.read(context).captureFailure(
                automatic = true, allowExistingFrame = allowExistingFrame,
            )?.let { return it }
            if (!networkAvailable(context)) return JunLuoCameraServiceErrorCodes.NETWORK_UNAVAILABLE
            if (snapshot.activeCaptureRequestId != null ||
                snapshot.cameraState == JunLuoCameraServiceCameraState.OPENING ||
                snapshot.cameraState == JunLuoCameraServiceCameraState.CAPTURING ||
                (snapshot.cameraResourceOwner != null &&
                    snapshot.cameraResourceOwner != JunLuoCameraResourceOwner.OBSERVATION_PREVIEW)
            ) return JunLuoCameraServiceErrorCodes.RESOURCE_BUSY
            val privacy = JunLuoCameraTemporaryFileManager.snapshot(context)
            if (privacy.lastCleanupState == JunLuoCameraFrameCleanupState.FAILED) {
                return JunLuoCameraServiceErrorCodes.FRAME_CLEANUP_FAILED
            }
            if (privacy.retryingFrameCount > 0 || privacy.orphanFrameCount > 0 ||
                (!allowExistingFrame && !privacy.cacheEmpty)) {
                return JunLuoCameraServiceErrorCodes.FRAME_CLEANUP_RETRYING
            }
            return null
        }
    }
}
