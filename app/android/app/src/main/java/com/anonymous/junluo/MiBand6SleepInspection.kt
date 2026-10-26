package com.anonymous.junluo

import java.util.Base64
import java.util.UUID

/** Chapter 27A evidence only. Never persists samples, cursor, or production cooldown. */
internal class MiBand6SleepCapture(val since: Long, val requestedAt: Long) {
    companion object { const val MAX_SERIALIZED_BYTES = 256 * 1024 }
    private val prefix = "{\"schema\":1,\"requestedSinceAt\":$since,\"requestedAt\":$requestedAt,\"packets\":["
    private val suffix = "],\"complete\":true}"
    private val packets = StringBuilder()
    private var count = 0
    private var failed = false

    fun observe(kind: String, bytes: ByteArray, observedAt: Long, elapsedMs: Long) {
        if (failed) throw MiBand6ActivityException("sleep_capture_size_exceeded")
        require(kind == "control" || kind == "data")
        val packet = "${if (count > 0) "," else ""}{\"kind\":\"$kind\",\"data\":\"${Base64.getEncoder().encodeToString(bytes)}\",\"observedAt\":$observedAt,\"elapsedMs\":$elapsedMs}"
        // JSON is ASCII only: its character count is exactly its UTF-8 byte count.
        if (count >= MiBand6ActivityProtocol.MAX_PACKETS || prefix.length + packets.length + packet.length + suffix.length > MAX_SERIALIZED_BYTES) {
            failed = true
            packets.setLength(0)
            throw MiBand6ActivityException("sleep_capture_size_exceeded")
        }
        packets.append(packet)
        count += 1
    }

    /** Call only after the production assembler validated the end and GATT cleanup completed. */
    fun complete(): String {
        check(!failed) { "sleep_capture_size_exceeded" }
        return prefix + packets.toString() + suffix
    }
}

internal data class MiBand6SleepLease(val profileId: String, val owner: GuardianOwner, val token: String,
    val since: Long, val requestedAt: Long)

internal class MiBand6SleepInspectionLease {
    private var active: MiBand6SleepLease? = null
    private val attemptedAt = mutableMapOf<String, Long>()

    @Synchronized fun current(now: Long): MiBand6SleepLease? {
        // A lost JS runtime cannot leave an in-memory lease behind indefinitely.
        if (active?.let { now - it.requestedAt >= 100_000L } == true) active = null
        return active
    }

    @Synchronized fun claim(profileId: String, window: String, state: GuardianState, owner: GuardianOwner,
        now: Long, formalInFlightUntil: Long): MiBand6SleepLease {
        require(profileId.isNotBlank() && state.deviceProfileId == profileId && state.owner == owner) { "sleep_inspection_not_ready" }
        val minutes = when (window) {
            "recent24h" -> 1_440L
            "recent7days" -> 10_080L
            else -> throw IllegalArgumentException("sleep_inspection_invalid_window")
        }
        require(!state.paused && (state.scheduledSamplingPauseUntil ?: 0L) <= now) { "sleep_inspection_paused" }
        require(state.samplingMode == null && current(now) == null && formalInFlightUntil <= now) { "sleep_inspection_busy" }
        require(!state.scheduledSamplingEnabled || (state.nextSamplingDueAt ?: now) > now + 95_000L) { "sleep_inspection_heart_rate_due" }
        require(attemptedAt[profileId]?.let { now - it >= 10_000L } != false) { "sleep_inspection_cooldown" }
        val lease = MiBand6SleepLease(profileId, owner, UUID.randomUUID().toString(),
            now / 60_000L * 60_000L - minutes * 60_000L, now)
        attemptedAt[profileId] = now
        active = lease
        return lease
    }

    @Synchronized fun release(token: String): Boolean {
        if (active?.token != token) return false
        active = null
        return true
    }
}

internal object MiBand6SleepInspection { val leases = MiBand6SleepInspectionLease() }
