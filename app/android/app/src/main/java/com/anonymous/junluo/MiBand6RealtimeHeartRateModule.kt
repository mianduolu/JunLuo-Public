package com.anonymous.junluo

import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class MiBand6RealtimeHeartRateModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext), MiBand6RealtimeHeartRateService.Listener {

    companion object {
        const val EVENT_SAMPLE_TICK = "junluoMiBand6HeartRateSampleTick"
        const val EVENT_STOP_REQUESTED = "junluoMiBand6HeartRateStopRequested"
        const val EVENT_STOPPED = "junluoMiBand6HeartRateStopped"
    }

    init {
        MiBand6RealtimeHeartRateService.setListener(this)
    }

    override fun getName(): String = "JunLuoMiBand6RealtimeHeartRate"

    @ReactMethod
    fun start(durationMs: Double, promise: Promise) {
        val context = reactApplicationContext.applicationContext
        val intent = Intent(context, MiBand6RealtimeHeartRateService::class.java).apply {
            action = MiBand6RealtimeHeartRateService.ACTION_START
            putExtra(MiBand6RealtimeHeartRateService.EXTRA_DURATION_MS, durationMs.toLong())
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(context, intent)
            } else {
                context.startService(intent)
            }
            promise.resolve(true)
        } catch (error: Exception) {
            promise.reject("MI_BAND_6_FGS_START_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun finish(reason: String, promise: Promise) {
        val context = reactApplicationContext.applicationContext
        val intent = Intent(context, MiBand6RealtimeHeartRateService::class.java).apply {
            action = MiBand6RealtimeHeartRateService.ACTION_FINISH
            putExtra(MiBand6RealtimeHeartRateService.EXTRA_REASON, reason)
        }
        runCatching { context.startService(intent) }
            .onSuccess { promise.resolve(true) }
            .onFailure { promise.reject("MI_BAND_6_FGS_FINISH_FAILED", it.message, it) }
    }

    @ReactMethod
    fun acknowledgeSampleTick(tickId: Double, promise: Promise) {
        val context = reactApplicationContext.applicationContext
        val intent = Intent(context, MiBand6RealtimeHeartRateService::class.java).apply {
            action = MiBand6RealtimeHeartRateService.ACTION_ACK_SAMPLE_TICK
            putExtra(MiBand6RealtimeHeartRateService.EXTRA_TICK_ID, tickId.toInt())
        }
        runCatching { context.startService(intent) }
            .onSuccess { promise.resolve(true) }
            .onFailure {
                promise.reject("MI_BAND_6_SAMPLE_ACK_FAILED", it.message, it)
            }
    }

    @ReactMethod
    fun getState(promise: Promise) {
        promise.resolve(Arguments.createMap().apply {
            putBoolean("isRunning", MiBand6RealtimeHeartRateService.isRunning)
            putDouble("endsAt", MiBand6RealtimeHeartRateService.endsAt.toDouble())
        })
    }

    @ReactMethod
    fun addListener(eventName: String) {
        // Required by NativeEventEmitter.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // Required by NativeEventEmitter.
    }

    override fun invalidate() {
        MiBand6RealtimeHeartRateService.setListener(null)
        super.invalidate()
    }

    override fun onSampleTick(tickId: Int) {
        emit(EVENT_SAMPLE_TICK, Arguments.createMap().apply {
            putInt("tickId", tickId)
        })
    }

    override fun onStopRequested(reason: String) {
        emit(EVENT_STOP_REQUESTED, Arguments.createMap().apply {
            putString("reason", reason)
        })
    }

    override fun onStopped(reason: String) {
        emit(EVENT_STOPPED, Arguments.createMap().apply {
            putString("reason", reason)
        })
    }

    private fun emit(eventName: String, payload: Any) {
        if (!reactApplicationContext.hasActiveReactInstance()) return
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, payload)
    }
}
