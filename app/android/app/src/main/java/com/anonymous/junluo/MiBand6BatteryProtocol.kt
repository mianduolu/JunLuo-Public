package com.anonymous.junluo

internal data class MiBand6BatteryValue(val percent: Int, val charging: Boolean?)

internal object MiBand6BatteryProtocol {
    const val SERVICE_UUID = "0000fee0-0000-1000-8000-00805f9b34fb"
    const val CHARACTERISTIC_UUID = "00000006-0000-3512-2118-0009af100700"
    const val READ_TIMEOUT_MS = 5_000L
    const val MANUAL_INTERVAL_MS = 10_000L
    const val AUTO_INTERVAL_MS = 30L * 60L * 1000L

    fun refreshError(trigger: String, now: Long, lastAttempt: Long, lastAutomatic: Long, lastManualSuccess: Long): String? {
        if (trigger !in setOf("manual", "connected", "foreground", "scheduled_check")) return "battery_unsupported_trigger"
        if (lastAttempt > 0L && now - lastAttempt < MANUAL_INTERVAL_MS) return "battery_cooldown"
        val autoAnchor = maxOf(lastAutomatic, lastManualSuccess)
        if (trigger != "manual" && autoAnchor > 0L && now - autoAnchor < AUTO_INTERVAL_MS) return "battery_cooldown"
        return null
    }

    fun parse(bytes: ByteArray): MiBand6BatteryValue? {
        if (bytes.size < 3) return null
        val percent = bytes[1].toInt() and 0xff
        if (percent > 100) return null
        val charging = when (bytes[2].toInt() and 0xff) {
            0 -> false
            1 -> true
            else -> null
        }
        return MiBand6BatteryValue(percent, charging)
    }
}

/** A timed-out read keeps its wire slot until its callback (or disconnect), without retrying. */
internal class MiBand6BatteryReadSession {
    var token: Long = 0L
        private set
    var pending: Boolean = false
        private set
    var timedOut: Boolean = false
        private set
    private var lastAttemptAt: Long? = null

    fun begin(now: Long): String? {
        if (timedOut) return "battery_connection_blocked"
        if (pending) return "battery_busy"
        if (lastAttemptAt?.let { now - it < MiBand6BatteryProtocol.MANUAL_INTERVAL_MS } == true) {
            return "battery_cooldown"
        }
        lastAttemptAt = now
        token += 1
        pending = true
        return null
    }

    fun expire(requestToken: Long): Boolean {
        if (!pending || token != requestToken || timedOut) return false
        timedOut = true
        return true
    }

    fun complete(requestToken: Long): Boolean {
        if (!pending || token != requestToken) return false
        pending = false
        return !timedOut
    }

    fun reset() {
        token += 1
        pending = false
        timedOut = false
        // Manual cooldown is not bypassed by reconnecting the same client.
    }
}
