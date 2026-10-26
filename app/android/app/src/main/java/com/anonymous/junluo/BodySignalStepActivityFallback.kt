package com.anonymous.junluo

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.util.Log

object BodySignalStepActivityFallback : SensorEventListener {
    private val handler = Handler(Looper.getMainLooper())
    private var appContext: Context? = null
    private var lastStepAt = 0L
    private var registered = false
    private var walking = false

    private val settleRunnable = object : Runnable {
        override fun run() {
            val context = appContext ?: return
            val remaining = WALKING_SETTLE_MS - (System.currentTimeMillis() - lastStepAt)
            if (remaining > 0L) {
                handler.postDelayed(this, remaining)
                return
            }
            if (!walking) return
            walking = false
            BodySignalActivityContextReceiver().recordStepActivity(
                context,
                activity = "still",
                observedAt = System.currentTimeMillis(),
            )
        }
    }

    fun enable(context: Context): Boolean {
        if (registered) return true
        val applicationContext = context.applicationContext
        val sensorManager = applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            ?: return false
        val sensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR, false) ?: return false
        registered = sensorManager.registerListener(
            this,
            sensor,
            SensorManager.SENSOR_DELAY_NORMAL,
            MAX_REPORT_LATENCY_US,
        )
        if (registered) {
            appContext = applicationContext
            Log.i(TAG, "Low-power step activity fallback registered")
        }
        return registered
    }

    fun disable(context: Context) {
        val sensorManager = context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        sensorManager?.unregisterListener(this)
        handler.removeCallbacks(settleRunnable)
        appContext = null
        lastStepAt = 0L
        registered = false
        walking = false
    }

    fun isAvailable(context: Context): Boolean {
        val sensorManager = context.applicationContext.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            ?: return false
        return sensorManager.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR, false) != null
    }

    fun isEnabled(): Boolean = registered

    fun hasRecentStep(now: Long): Boolean = lastStepAt > 0L && now - lastStepAt < WALKING_SETTLE_MS

    override fun onSensorChanged(event: SensorEvent?) {
        if (event?.sensor?.type != Sensor.TYPE_STEP_DETECTOR) return
        val context = appContext ?: return
        lastStepAt = System.currentTimeMillis()
        if (!walking) {
            walking = true
            BodySignalActivityContextReceiver().recordStepActivity(
                context,
                activity = "walking",
                observedAt = lastStepAt,
            )
        }
        if (!handler.hasCallbacks(settleRunnable)) {
            handler.postDelayed(settleRunnable, WALKING_SETTLE_MS)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private const val MAX_REPORT_LATENCY_US = 60_000_000
    private const val TAG = "BodySignalActivity"
    private const val WALKING_SETTLE_MS = 2 * 60_000L
}
