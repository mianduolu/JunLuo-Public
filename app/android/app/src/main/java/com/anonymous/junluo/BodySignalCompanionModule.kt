package com.anonymous.junluo

import android.app.Activity
import android.bluetooth.le.ScanFilter
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.BluetoothLeDeviceFilter
import android.companion.CompanionDeviceManager
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject

private const val COMPANION_EVENT_NAME = "junluoBodySignalCompanionPresence"
private const val COMPANION_PREFS = "junluo_body_signal_companion"
private const val COMPANION_PENDING_EVENTS = "pending_presence_events"
private const val ASSOCIATION_REQUEST_CODE = 19419

object BodySignalCompanionPresenceLedger {
    private const val MAX_PENDING_EVENTS = 20
    private val lock = Any()
    @Volatile private var reactContext: ReactApplicationContext? = null

    fun attach(context: ReactApplicationContext) {
        reactContext = context
    }

    fun detach(context: ReactApplicationContext) {
        if (reactContext === context) reactContext = null
    }

    fun record(context: Context, associationId: Int, type: String) {
        val observedAt = System.currentTimeMillis()
        synchronized(lock) {
            val preferences = context.getSharedPreferences(COMPANION_PREFS, Context.MODE_PRIVATE)
            val events = runCatching {
                JSONArray(preferences.getString(COMPANION_PENDING_EVENTS, "[]"))
            }.getOrDefault(JSONArray())
            events.put(JSONObject().apply {
                put("associationId", associationId)
                put("observedAt", observedAt)
                put("type", type)
            })
            while (events.length() > MAX_PENDING_EVENTS) {
                events.remove(0)
            }
            preferences.edit().putString(COMPANION_PENDING_EVENTS, events.toString()).apply()
        }
        emit(associationId, observedAt, type)
    }

    fun drain(context: Context): WritableArray {
        val result = Arguments.createArray()
        synchronized(lock) {
            val preferences = context.getSharedPreferences(COMPANION_PREFS, Context.MODE_PRIVATE)
            val events = runCatching {
                JSONArray(preferences.getString(COMPANION_PENDING_EVENTS, "[]"))
            }.getOrDefault(JSONArray())
            for (index in 0 until events.length()) {
                val event = events.optJSONObject(index) ?: continue
                result.pushMap(eventMap(
                    event.optInt("associationId", -1),
                    event.optLong("observedAt", 0L),
                    event.optString("type", ""),
                ))
            }
            preferences.edit().remove(COMPANION_PENDING_EVENTS).apply()
        }
        return result
    }

    private fun emit(associationId: Int, observedAt: Long, type: String) {
        val context = reactContext ?: return
        if (!context.hasActiveReactInstance()) return
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(COMPANION_EVENT_NAME, eventMap(associationId, observedAt, type))
    }

    private fun eventMap(associationId: Int, observedAt: Long, type: String): WritableMap {
        return Arguments.createMap().apply {
            putInt("associationId", associationId)
            putDouble("observedAt", observedAt.toDouble())
            putString("type", type)
        }
    }
}

class BodySignalCompanionModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), ActivityEventListener {
    private var pendingAssociationPromise: Promise? = null

    init {
        reactContext.addActivityEventListener(this)
        BodySignalCompanionPresenceLedger.attach(reactContext)
    }

    override fun getName(): String = "JunLuoBodySignalCompanion"

    @ReactMethod
    fun getCompanionSupport(promise: Promise) {
        val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        promise.resolve(Arguments.createMap().apply {
            putBoolean("supported", supported)
            if (!supported) {
                putString("reason", "android_api_below_33")
            } else if (Build.VERSION.SDK_INT >= 36) {
                putString("reason", "api_36_legacy_compat")
            }
        })
    }

    @ReactMethod
    fun beginPrimaryDeviceAssociation(deviceProfileId: String, deviceAddress: String, promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            promise.reject("COMPANION_UNSUPPORTED", "Android 13 or newer is required for wearable presence observation.")
            return
        }
        if (pendingAssociationPromise != null) {
            promise.reject("COMPANION_ASSOCIATION_IN_PROGRESS", "A companion device selection is already open.")
            return
        }
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("COMPANION_ACTIVITY_UNAVAILABLE", "The Android device chooser needs an active screen.")
            return
        }
        pendingAssociationPromise = promise
        val existingAssociation = associationForAddress(deviceAddress)
        if (existingAssociation != null) {
            runCatching {
                val address = consolidateAssociation(existingAssociation.id)
                companionManager().startObservingDevicePresence(address)
            }.onSuccess {
                resolvePending(existingAssociation.id, deviceProfileId, true)
            }.onFailure {
                rejectPending("COMPANION_OBSERVATION_FAILED", it.message, it)
            }
            return
        }
        val scanFilter = ScanFilter.Builder().setDeviceAddress(deviceAddress).build()
        val filter = BluetoothLeDeviceFilter.Builder().setScanFilter(scanFilter).build()
        val request = AssociationRequest.Builder()
            .addDeviceFilter(filter)
            .setSingleDevice(true)
            .build()
        companionManager().associate(request, object : CompanionDeviceManager.Callback() {
            override fun onAssociationPending(intentSender: IntentSender) {
                runCatching {
                    activity.startIntentSenderForResult(intentSender, ASSOCIATION_REQUEST_CODE, null, 0, 0, 0)
                }.onFailure { rejectPending("COMPANION_CHOOSER_FAILED", it.message, it) }
            }

            override fun onAssociationCreated(associationInfo: AssociationInfo) {
                val address = associationInfo.deviceMacAddress?.toString()
                if (address.isNullOrBlank()) {
                    rejectPending("COMPANION_ADDRESS_UNAVAILABLE", "Android did not provide the selected wearable address.", null)
                    return
                }
                runCatching {
                    val consolidatedAddress = consolidateAssociation(associationInfo.id)
                    companionManager().startObservingDevicePresence(consolidatedAddress)
                }
                    .onSuccess { resolvePending(associationInfo.id, deviceProfileId, true) }
                    .onFailure { rejectPending("COMPANION_OBSERVATION_FAILED", it.message, it) }
            }

            override fun onFailure(error: CharSequence?) {
                rejectPending("COMPANION_ASSOCIATION_FAILED", error.toString(), null)
            }
        }, Handler(Looper.getMainLooper()))
    }

    @ReactMethod
    fun pausePrimaryDeviceObservation(associationId: Double, promise: Promise) {
        changeObservation(associationId.toInt(), false, promise) {
            BodySignalGuardianController.stopForObservationPause(reactApplicationContext)
        }
    }

    @ReactMethod
    fun resumePrimaryDeviceObservation(associationId: Double, promise: Promise) {
        changeObservation(associationId.toInt(), true, promise) {
            BodySignalGuardianController.resumeAfterObservation(reactApplicationContext)
        }
    }

    @ReactMethod
    fun repairPrimaryDeviceAssociation(associationId: Double, promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            promise.reject("COMPANION_UNSUPPORTED", "Android 13 or newer is required.")
            return
        }
        runCatching {
            val address = consolidateAssociation(associationId.toInt())
            companionManager().startObservingDevicePresence(address)
        }.onSuccess { promise.resolve(true) }
            .onFailure { promise.reject("COMPANION_REPAIR_FAILED", it.message, it) }
    }

    @ReactMethod
    fun revokePrimaryDeviceAssociation(associationId: Double, promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            promise.reject("COMPANION_UNSUPPORTED", "Android 13 or newer is required.")
            return
        }
        val id = associationId.toInt()
        runCatching {
            consolidateAssociation(id)
            companionManager().disassociate(id)
        }.onSuccess {
            BodySignalGuardianController.disableForRevocation(reactApplicationContext, id)
            promise.resolve(true)
        }
            .onFailure { promise.reject("COMPANION_REVOKE_FAILED", it.message, it) }
    }

    @ReactMethod
    fun drainCompanionPresenceEvents(promise: Promise) {
        promise.resolve(BodySignalCompanionPresenceLedger.drain(reactApplicationContext.applicationContext))
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required by NativeEventEmitter.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required by NativeEventEmitter.
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == ASSOCIATION_REQUEST_CODE && resultCode != Activity.RESULT_OK) {
            rejectPending("COMPANION_ASSOCIATION_CANCELLED", "Android device association was cancelled.", null)
        }
    }

    override fun onNewIntent(intent: Intent) = Unit

    override fun invalidate() {
        BodySignalCompanionPresenceLedger.detach(reactApplicationContext)
        super.invalidate()
    }

    private fun changeObservation(
        associationId: Int,
        enabled: Boolean,
        promise: Promise,
        onSuccess: () -> Unit,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            promise.reject("COMPANION_UNSUPPORTED", "Android 13 or newer is required.")
            return
        }
        runCatching {
            val address = consolidateAssociation(associationId)
            if (enabled) companionManager().startObservingDevicePresence(address)
        }.onSuccess {
            onSuccess()
            promise.resolve(true)
        }
            .onFailure { promise.reject("COMPANION_OBSERVATION_CHANGE_FAILED", it.message, it) }
    }

    private fun associationForAddress(deviceAddress: String): AssociationInfo? {
        return companionManager().myAssociations
            .filter { association -> association.deviceMacAddress?.toString()?.equals(deviceAddress, ignoreCase = true) == true }
            .minByOrNull { association -> association.id }
    }

    private fun consolidateAssociation(associationId: Int): String {
        val manager = companionManager()
        val association = manager.myAssociations.firstOrNull { candidate -> candidate.id == associationId }
            ?: throw IllegalStateException("Android no longer has this wearable association.")
        val address = association.deviceMacAddress?.toString()
            ?: throw IllegalStateException("Android did not provide the associated wearable address.")

        runCatching { manager.stopObservingDevicePresence(address) }
        manager.myAssociations
            .filter { candidate ->
                candidate.id != associationId
                    && candidate.deviceMacAddress?.toString()?.equals(address, ignoreCase = true) == true
            }
            .forEach { duplicate -> manager.disassociate(duplicate.id) }
        return address
    }

    private fun associatedAddress(associationId: Int): String? {
        return companionManager().myAssociations
            .firstOrNull { association -> association.id == associationId }
            ?.deviceMacAddress
            ?.toString()
    }

    private fun companionManager(): CompanionDeviceManager {
        return reactApplicationContext.getSystemService(CompanionDeviceManager::class.java)
    }

    private fun resolvePending(associationId: Int, deviceProfileId: String, observationEnabled: Boolean) {
        val promise = pendingAssociationPromise ?: return
        pendingAssociationPromise = null
        promise.resolve(Arguments.createMap().apply {
            putDouble("associationId", associationId.toDouble())
            putString("deviceProfileId", deviceProfileId)
            putBoolean("observationEnabled", observationEnabled)
            putString("status", "active")
        })
    }

    private fun rejectPending(code: String, message: String?, throwable: Throwable?) {
        val promise = pendingAssociationPromise ?: return
        pendingAssociationPromise = null
        if (throwable == null) promise.reject(code, message) else promise.reject(code, message, throwable)
    }
}
