package com.anonymous.junluo

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityRecognitionClient
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import org.json.JSONArray
import java.util.concurrent.atomic.AtomicBoolean

class BodySignalActivityContextModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = NAME

    @ReactMethod
    fun getActivityContextSupport(promise: Promise) {
        val prefs = preferences()
        val map = Arguments.createMap()
        val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && googlePlayAvailable()
        map.putBoolean("supported", supported)
        map.putBoolean("permissionGranted", hasPermission())
        map.putBoolean("enabled", prefs.getBoolean(ENABLED, false))
        map.putString("bootSessionId", "boot:${currentBootCount()}")
        map.putInt("pendingEventCount", pendingEventCount(prefs))
        putPositiveTimestamp(map, "lastReceiverAt", prefs.getLong(BodySignalActivityContextReceiver.LAST_RECEIVER_AT, 0L))
        putPositiveTimestamp(map, "lastNativeEventAt", prefs.getLong(BodySignalActivityContextReceiver.LAST_EVENT_AT, 0L))
        putPositiveTimestamp(map, "lastNativeObservationAt", prefs.getLong(BodySignalActivityContextReceiver.LAST_OBSERVATION_AT, 0L))
        putPositiveTimestamp(map, "lastRegistrationAt", prefs.getLong(LAST_REGISTRATION_AT, 0L))
        val lastConfidence = prefs.getInt(BodySignalActivityContextReceiver.LAST_CONFIDENCE, -1)
        if (lastConfidence >= 0) map.putInt("lastNativeConfidence", lastConfidence)
        map.putBoolean("fallbackEnabled", prefs.getBoolean(FALLBACK_ENABLED, false))
        map.putBoolean("stepFallbackAvailable", BodySignalStepActivityFallback.isAvailable(reactContext))
        map.putBoolean("stepFallbackEnabled", BodySignalStepActivityFallback.isEnabled())
        val navigationEvidenceAvailable = BodySignalNavigationNotificationEvidence.isListenerEnabled(reactContext)
        map.putBoolean("navigationEvidenceAvailable", navigationEvidenceAvailable)
        map.putBoolean("navigationEvidenceActive", navigationEvidenceAvailable && BodySignalNavigationNotificationEvidence.isActive(reactContext))
        putPositiveTimestamp(map, "lastNavigationObservedAt", BodySignalNavigationNotificationEvidence.lastObservedAt(reactContext))
        prefs.getString(BodySignalActivityContextReceiver.LAST_ACTIVITY, null)?.let { map.putString("lastNativeActivity", it) }
        prefs.getString(BodySignalActivityContextReceiver.LAST_TRANSITION, null)?.let { map.putString("lastNativeTransition", it) }
        prefs.getString(BodySignalActivityContextReceiver.LAST_ERROR_CODE, null)?.let { map.putString("lastNativeErrorCode", it) }
        prefs.getString(LAST_REGISTRATION_ERROR_CODE, null)?.let { map.putString("lastRegistrationErrorCode", it) }
        if (!supported) map.putString("reason", "unsupported")
        promise.resolve(map)
    }

    @ReactMethod
    fun requestActivityRecognitionPermission(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || hasPermission()) {
            promise.resolve(hasPermission())
            return
        }
        val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
        if (activity == null) {
            promise.resolve(false)
            return
        }
        val settled = AtomicBoolean(false)
        activity.requestPermissions(
            arrayOf(Manifest.permission.ACTIVITY_RECOGNITION),
            REQUEST_CODE,
            PermissionListener { requestCode, _, grantResults ->
                if (requestCode != REQUEST_CODE) return@PermissionListener false
                if (settled.compareAndSet(false, true)) {
                    promise.resolve(grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED)
                }
                true
            },
        )
    }

    @ReactMethod
    fun enableActivityTransitions(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !googlePlayAvailable()) {
            promise.resolve(false)
            return
        }
        if (!hasPermission()) {
            promise.resolve(false)
            return
        }
        registerActivityTransitions(promise, resetExisting = true)
    }

    @ReactMethod
    fun refreshActivityTransitionsIfStale(promise: Promise) {
        val prefs = preferences()
        if (
            Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || !googlePlayAvailable()
            || !hasPermission()
            || !prefs.getBoolean(ENABLED, false)
        ) {
            promise.resolve(false)
            return
        }
        val stepFallbackWasEnabled = BodySignalStepActivityFallback.isEnabled()
        val stepFallbackEnabled = BodySignalStepActivityFallback.enable(reactContext)
        prefs.edit().putBoolean(STEP_FALLBACK_ENABLED, stepFallbackEnabled).apply()
        val now = System.currentTimeMillis()
        val lastReceiverAt = prefs.getLong(BodySignalActivityContextReceiver.LAST_RECEIVER_AT, 0L)
        val lastRegistrationAt = prefs.getLong(LAST_REGISTRATION_AT, 0L)
        val lastProofOfLifeAt = maxOf(lastReceiverAt, lastRegistrationAt)
        if (
            (lastProofOfLifeAt > 0L && now - lastProofOfLifeAt < DELIVERY_STALE_MS)
            || (lastRegistrationAt > 0L && now - lastRegistrationAt < REGISTRATION_RETRY_COOLDOWN_MS)
        ) {
            promise.resolve(!stepFallbackWasEnabled && stepFallbackEnabled)
            return
        }
        Log.w(TAG, "Activity delivery is stale; resetting registrations")
        registerActivityTransitions(promise, resetExisting = true)
    }

    private fun registerActivityTransitions(promise: Promise, resetExisting: Boolean) {
        val client = ActivityRecognition.getClient(reactContext)
        val register: () -> Unit = {
            client.requestActivityTransitionUpdates(buildRequest(), transitionPendingIntent())
            .addOnSuccessListener {
                Log.i(TAG, "Activity transition updates registered")
                client.requestActivityUpdates(FALLBACK_INTERVAL_MS, fallbackPendingIntent())
                    .addOnCompleteListener { fallbackTask ->
                        val stepFallbackEnabled = BodySignalStepActivityFallback.enable(reactContext)
                        preferences().edit()
                            .putBoolean(ENABLED, true)
                            .putBoolean(FALLBACK_ENABLED, fallbackTask.isSuccessful)
                            .putBoolean(STEP_FALLBACK_ENABLED, stepFallbackEnabled)
                            .putLong(LAST_REGISTRATION_AT, System.currentTimeMillis())
                            .apply {
                                if (fallbackTask.isSuccessful) remove(LAST_REGISTRATION_ERROR_CODE)
                                else putString(
                                    LAST_REGISTRATION_ERROR_CODE,
                                    "fallback:${fallbackTask.exception?.javaClass?.simpleName ?: "unknown"}",
                                )
                            }
                            .apply()
                        if (fallbackTask.isSuccessful) {
                            Log.i(TAG, "Low-frequency activity fallback registered")
                        } else {
                            Log.w(TAG, "Low-frequency activity fallback registration failed", fallbackTask.exception)
                        }
                        promise.resolve(true)
                    }
            }
            .addOnFailureListener { error ->
                preferences().edit()
                    .putString(LAST_REGISTRATION_ERROR_CODE, error.javaClass.simpleName)
                    .apply()
                Log.w(TAG, "Activity transition registration failed", error)
                promise.resolve(false)
            }
            Unit
        }
        if (!resetExisting) {
            register()
            return
        }
        removeRegisteredActivityUpdates(client, register)
    }

    @ReactMethod
    fun disableActivityTransitions(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !googlePlayAvailable()) {
            BodySignalStepActivityFallback.disable(reactContext)
            preferences().edit().putBoolean(ENABLED, false).apply()
            promise.resolve(true)
            return
        }
        val client = ActivityRecognition.getClient(reactContext)
        removeRegisteredActivityUpdates(client) {
            BodySignalStepActivityFallback.disable(reactContext)
            preferences().edit()
                .putBoolean(ENABLED, false)
                .putBoolean(FALLBACK_ENABLED, false)
                .putBoolean(STEP_FALLBACK_ENABLED, false)
                .apply()
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun drainActivityContextEvents(promise: Promise) {
        val prefs = preferences()
        val result = pendingEventsArray(prefs)
        prefs.edit().putString(BodySignalActivityContextReceiver.LEDGER, "[]").commit()
        promise.resolve(result)
    }

    @ReactMethod
    fun getPendingActivityContextEvents(promise: Promise) {
        promise.resolve(pendingEventsArray(preferences()))
    }

    @ReactMethod
    fun acknowledgeActivityContextEvents(eventIds: ReadableArray, promise: Promise) {
        val prefs = preferences()
        val source = runCatching { JSONArray(prefs.getString(BodySignalActivityContextReceiver.LEDGER, "[]")) }
            .getOrElse { JSONArray() }
        val acknowledged = buildSet {
            for (index in 0 until eventIds.size()) {
                eventIds.getString(index)?.takeIf { it.isNotBlank() }?.let(::add)
            }
        }
        val remaining = JSONArray()
        for (index in 0 until source.length()) {
            val item = source.optJSONObject(index) ?: continue
            if (!acknowledged.contains(item.optString("eventId"))) remaining.put(item)
        }
        prefs.edit().putString(BodySignalActivityContextReceiver.LEDGER, remaining.toString()).commit()
        promise.resolve(true)
    }

    @ReactMethod fun addListener(eventName: String) = Unit
    @ReactMethod fun removeListeners(count: Int) = Unit

    private fun buildRequest(): ActivityTransitionRequest {
        val transitions = mutableListOf<ActivityTransition>()
        val activities = listOf(
            DetectedActivity.STILL,
            DetectedActivity.WALKING,
            DetectedActivity.RUNNING,
            DetectedActivity.ON_BICYCLE,
            DetectedActivity.IN_VEHICLE,
        )
        activities.forEach { activity ->
            transitions += ActivityTransition.Builder()
                .setActivityType(activity)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_ENTER)
                .build()
            transitions += ActivityTransition.Builder()
                .setActivityType(activity)
                .setActivityTransition(ActivityTransition.ACTIVITY_TRANSITION_EXIT)
                .build()
        }
        return ActivityTransitionRequest(transitions)
    }

    private fun pendingEventsArray(prefs: android.content.SharedPreferences) = Arguments.createArray().apply {
        val source = runCatching { JSONArray(prefs.getString(BodySignalActivityContextReceiver.LEDGER, "[]")) }
            .getOrElse { JSONArray() }
        val currentBoot = currentBootCount()
        for (index in 0 until source.length()) {
            val item = source.optJSONObject(index) ?: continue
            if (item.optInt("bootCount", Int.MIN_VALUE) != currentBoot) continue
            pushMap(Arguments.createMap().apply {
                putString("eventId", item.optString("eventId"))
                putString("activity", item.optString("activity"))
                putString("bootSessionId", "boot:$currentBoot")
                putString("transition", item.optString("transition"))
                putDouble("observedAt", item.optLong("observedAt").toDouble())
            })
        }
    }

    private fun pendingEventCount(prefs: android.content.SharedPreferences): Int {
        val source = runCatching { JSONArray(prefs.getString(BodySignalActivityContextReceiver.LEDGER, "[]")) }
            .getOrElse { JSONArray() }
        val currentBoot = currentBootCount()
        var count = 0
        for (index in 0 until source.length()) {
            if (source.optJSONObject(index)?.optInt("bootCount", Int.MIN_VALUE) == currentBoot) count += 1
        }
        return count
    }

    private fun putPositiveTimestamp(map: com.facebook.react.bridge.WritableMap, key: String, value: Long) {
        if (value > 0L) map.putDouble(key, value.toDouble())
    }

    private fun transitionPendingIntent(): PendingIntent {
        val mutabilityFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_MUTABLE
        } else {
            0
        }
        return PendingIntent.getService(
            reactContext,
            2201,
            Intent(reactContext, BodySignalActivityContextService::class.java).setAction(
                BodySignalActivityContextReceiver.ACTION,
            ),
            PendingIntent.FLAG_UPDATE_CURRENT or mutabilityFlag,
        )
    }

    private fun fallbackPendingIntent(): PendingIntent {
        val mutabilityFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_MUTABLE
        } else {
            0
        }
        return PendingIntent.getService(
            reactContext,
            2202,
            Intent(reactContext, BodySignalActivityContextService::class.java).setAction(
                BodySignalActivityContextReceiver.FALLBACK_ACTION,
            ),
            PendingIntent.FLAG_UPDATE_CURRENT or mutabilityFlag,
        )
    }

    private fun removeRegisteredActivityUpdates(
        client: ActivityRecognitionClient,
        onComplete: () -> Unit,
    ) {
        client.removeActivityTransitionUpdates(transitionPendingIntent()).addOnCompleteListener {
            client.removeActivityUpdates(fallbackPendingIntent()).addOnCompleteListener {
                client.removeActivityTransitionUpdates(packageTransitionPendingIntent()).addOnCompleteListener {
                    client.removeActivityUpdates(packageFallbackPendingIntent()).addOnCompleteListener {
                        client.removeActivityTransitionUpdates(legacyTransitionPendingIntent()).addOnCompleteListener {
                            client.removeActivityUpdates(legacyFallbackPendingIntent()).addOnCompleteListener {
                                packageTransitionPendingIntent().cancel()
                                packageFallbackPendingIntent().cancel()
                                legacyTransitionPendingIntent().cancel()
                                legacyFallbackPendingIntent().cancel()
                                onComplete()
                            }
                        }
                    }
                }
            }
        }
    }

    private fun packageTransitionPendingIntent(): PendingIntent = PendingIntent.getBroadcast(
        reactContext,
        2201,
        Intent(BodySignalActivityContextReceiver.ACTION).setPackage(reactContext.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or mutablePendingIntentFlag(),
    )

    private fun packageFallbackPendingIntent(): PendingIntent = PendingIntent.getBroadcast(
        reactContext,
        2202,
        Intent(BodySignalActivityContextReceiver.FALLBACK_ACTION).setPackage(reactContext.packageName),
        PendingIntent.FLAG_UPDATE_CURRENT or mutablePendingIntentFlag(),
    )

    private fun legacyTransitionPendingIntent(): PendingIntent = PendingIntent.getBroadcast(
        reactContext,
        2201,
        Intent(reactContext, BodySignalActivityContextReceiver::class.java).setAction(
            BodySignalActivityContextReceiver.ACTION,
        ),
        PendingIntent.FLAG_UPDATE_CURRENT or mutablePendingIntentFlag(),
    )

    private fun legacyFallbackPendingIntent(): PendingIntent = PendingIntent.getBroadcast(
        reactContext,
        2202,
        Intent(reactContext, BodySignalActivityContextReceiver::class.java).setAction(
            BodySignalActivityContextReceiver.FALLBACK_ACTION,
        ),
        PendingIntent.FLAG_UPDATE_CURRENT or mutablePendingIntentFlag(),
    )

    private fun mutablePendingIntentFlag(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        PendingIntent.FLAG_MUTABLE
    } else {
        0
    }

    private fun currentBootCount(): Int = runCatching {
        Settings.Global.getInt(reactContext.contentResolver, Settings.Global.BOOT_COUNT)
    }.getOrDefault(-1)

    private fun googlePlayAvailable(): Boolean = GoogleApiAvailability.getInstance()
        .isGooglePlayServicesAvailable(reactContext) == ConnectionResult.SUCCESS

    private fun hasPermission(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
        || ContextCompat.checkSelfPermission(
            reactContext,
            Manifest.permission.ACTIVITY_RECOGNITION,
        ) == PackageManager.PERMISSION_GRANTED

    private fun preferences() = reactContext.getSharedPreferences(
        BodySignalActivityContextReceiver.PREFS,
        Context.MODE_PRIVATE,
    )

    companion object {
        private const val ENABLED = "enabled"
        private const val DELIVERY_STALE_MS = 2 * 60 * 60_000L
        private const val EVENT = "bodySignalActivityContext"
        private const val FALLBACK_ENABLED = "fallback_enabled"
        private const val FALLBACK_INTERVAL_MS = 60_000L
        private const val LAST_REGISTRATION_AT = "last_registration_at"
        private const val LAST_REGISTRATION_ERROR_CODE = "last_registration_error_code"
        private const val NAME = "BodySignalActivityContext"
        private const val REGISTRATION_RETRY_COOLDOWN_MS = 30 * 60_000L
        private const val REQUEST_CODE = 2201
        private const val STEP_FALLBACK_ENABLED = "step_fallback_enabled"
        private const val TAG = "BodySignalActivity"
        @Volatile private var activeContext: ReactApplicationContext? = null

        fun emitLedgerChanged(context: Context) {
            val react = activeContext ?: return
            if (!react.hasActiveReactInstance()) return
            react.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT, null)
        }
    }

    init {
        activeContext = reactContext
    }
}
