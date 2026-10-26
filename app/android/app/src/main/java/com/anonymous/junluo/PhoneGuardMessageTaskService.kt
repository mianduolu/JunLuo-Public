package com.anonymous.junluo

import android.content.Intent
import android.content.Context
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

internal fun startBodySignalCareDispatch(
    start: () -> Boolean,
    acquireWakeLock: () -> Unit,
    release: () -> Unit,
) {
    if (!runCatching(start).getOrDefault(false)) {
        release()
        return
    }
    // Starting succeeded: a missing wake lock does not cancel or unlock that task.
    runCatching(acquireWakeLock)
}

class PhoneGuardMessageTaskService : HeadlessJsTaskService() {
    companion object {
        private val careDispatchRunning = AtomicBoolean(false)
        private val bodyCareDispatchRunning = AtomicBoolean(false)

        fun checkEmergencyContact(context: Context) {
            if (PhoneFocusRules.restorePaused) return
            runCatching {
                val intent = Intent(context, PhoneGuardMessageTaskService::class.java)
                    .putExtra("payloadJson", "{\"phase\":\"phone_emergency_contact\"}")
                if (context.startService(intent) != null) HeadlessJsTaskService.acquireWakeLockNow(context)
            }
        }

        fun isBodyCareDispatchRunning(): Boolean = bodyCareDispatchRunning.get()

        fun releaseBodyCareDispatch(): Boolean {
            bodyCareDispatchRunning.set(false)
            return true
        }

        fun checkBodySignalCare(context: Context, now: Long, newReading: Boolean = false) {
            if (PhoneFocusRules.restorePaused) return
            if (!newReading && (BodySignalCareStore.nextCheckAt(context)?.let { it <= now } != true)) return
            if (!bodyCareDispatchRunning.compareAndSet(false, true)) return
            startBodySignalCareDispatch(
                start = {
                    val intent = Intent(context, PhoneGuardMessageTaskService::class.java)
                        .putExtra("payloadJson", "{\"phase\":\"body_signal_care\"}")
                    context.startService(intent) != null
                },
                acquireWakeLock = { HeadlessJsTaskService.acquireWakeLockNow(context) },
                release = { releaseBodyCareDispatch() },
            )
        }

        fun releaseCareDispatch(): Boolean {
            careDispatchRunning.set(false)
            return true
        }

        fun checkCareFollowUp(context: Context, now: Long) {
            val raw = PhoneFocusRules.getCareFollowUp(context) ?: return
            val slot = try { JSONObject(raw) } catch (_: Exception) { return }
            if (!PhoneCareFollowUpPolicy.isDue(slot.optString("status"), slot.optLong("nextCheckAt"),
                    now, PhoneFocusRules.restorePaused) || !careDispatchRunning.compareAndSet(false, true)) return
            try {
                val intent = Intent(context, PhoneGuardMessageTaskService::class.java)
                    .putExtra("payloadJson", "{\"phase\":\"phone_care_follow_up\"}")
                if (context.startService(intent) == null) releaseCareDispatch()
                else HeadlessJsTaskService.acquireWakeLockNow(context)
            } catch (_: Exception) {
                releaseCareDispatch()
            }
        }
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val payloadJson = intent?.getStringExtra("payloadJson") ?: return null
        return HeadlessJsTaskConfig(
            "PhoneGuardTriggerTask",
            Arguments.createMap().apply {
                putString("payloadJson", payloadJson)
            },
            90_000L,
            true,
        )
    }

    override fun onDestroy() {
        releaseCareDispatch()
        releaseBodyCareDispatch()
        super.onDestroy()
    }
}
