package com.anonymous.junluo

import java.time.DateTimeException
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset

data class MiBand6ActivityBatch(
    val requestedSinceAt: Long,
    val startedAt: Long,
    val observedAt: Long,
    val samples: List<Pair<Int, Int>>,
    val reportedSize: Long,
    val byteCount: Int,
    val packetCount: Int,
)

data class MiBand6ActivityEvidence(
    val metadata: ByteArray,
    val firstRecords: ByteArray,
    val completion: ByteArray,
)

class MiBand6ActivityException(val code: String) : IllegalArgumentException(code)

object MiBand6ActivityProtocol {
    // Protocol study: Gadgetbridge 0a067d7313d0c597f04523593b0c31f18642959a.
    // Complete real stream and both-owner acceptance are recorded in the capability ledger.
    const val PRODUCTION_ENABLED = true
    const val SERVICE_UUID = "0000fee0-0000-1000-8000-00805f9b34fb"
    const val CONTROL_CHARACTERISTIC_UUID = "00000004-0000-3512-2118-0009af100700"
    const val DATA_CHARACTERISTIC_UUID = "00000005-0000-3512-2118-0009af100700"
    const val RECORD_BYTES = 8
    const val MINUTE_MS = 60_000L
    const val MAX_BYTES = 128 * 1024
    const val MAX_PACKETS = 8192
    const val MAX_RECORDS = 16384
    const val NO_PROGRESS_TIMEOUT_MS = 15_000L
    const val TOTAL_TIMEOUT_MS = 90_000L

    fun retainedSince(now: Long, cursor: Long = 0L): Long =
        maxOf((now - 24L * 60L * MINUTE_MS) / MINUTE_MS * MINUTE_MS, cursor)

    // timezoneOffsetMinutes is the actual UTC offset at requestedSinceAt, including DST.
    // Reject fractional minutes instead of silently requesting an earlier range.
    fun buildStartRequest(requestedSinceAt: Long, timezoneOffsetMinutes: Int, nowAt: Long): ByteArray {
        validateRequest(requestedSinceAt, nowAt)
        activityRequire(timezoneOffsetMinutes in -720..840 && timezoneOffsetMinutes % 15 == 0,
            "activity_invalid_timezone")
        val local = Instant.ofEpochMilli(requestedSinceAt)
            .atOffset(ZoneOffset.ofTotalSeconds(timezoneOffsetMinutes * 60))
        activityRequire(local.year in 2000..2099, "activity_invalid_date")
        return byteArrayOf(
            0x01, 0x01, local.year.toByte(), (local.year shr 8).toByte(),
            local.monthValue.toByte(), local.dayOfMonth.toByte(), local.hour.toByte(),
            local.minute.toByte(), 0x00, (timezoneOffsetMinutes / 15).toByte(),
        )
    }

    // The only additional command. No device ACK or Zepp keep-data command is exposed.
    fun buildFetchRequest(): ByteArray = byteArrayOf(0x02)
}

/**
 * One bounded transfer; callers serialize notifications and supply milliseconds since request start.
 * now supplies epoch milliseconds, independently of elapsedMs. No timers, IO, or device writes.
 * A positive-size start returns null (send FETCH). A zero-size start completes immediately.
 * Otherwise only an exact successful end returns a batch. Neither path sends device ACK.
 * packetCount includes control/data notifications and duplicates. byteCount excludes counters,
 * metadata and duplicate payloads. samples contains closed minutes as (steps, intensity).
 * reportedSize is the unsigned raw minute count, before excluding the current open minute.
 */
class MiBand6ActivityAssembler(private val requestedSinceAt: Long, private val now: () -> Long) {
    private var lastNowAt = now()
    private var lastElapsedMs = 0L
    private var lastProgressMs = 0L
    private var failure: String? = null
    private var completed = false
    private var anchor: Long? = null
    private var reportedSize = 0L
    private var packetCount = 0
    private var byteCount = 0
    private var previousPacket: ByteArray? = null
    private val pending = ByteArray(MiBand6ActivityProtocol.RECORD_BYTES)
    private var pendingSize = 0
    private val records = ArrayList<Pair<Int, Int>>()
    private var evidenceMetadata = byteArrayOf()
    private val evidenceRecords = ByteArray(16)
    private var evidenceRecordBytes = 0
    private var evidenceCompletion = byteArrayOf()

    init {
        validateRequest(requestedSinceAt, lastNowAt)
    }

    // Volatile diagnostic snapshot only, never part of the formal batch or persistence.
    fun getEvidence(): MiBand6ActivityEvidence = MiBand6ActivityEvidence(
        evidenceMetadata.copyOf(), evidenceRecords.copyOf(evidenceRecordBytes),
        evidenceCompletion.copyOf(),
    )

    // Poll this even when no notification arrives; polling itself is never progress.
    fun checkElapsed(elapsedMs: Long) {
        failure?.let { throw MiBand6ActivityException(it) }
        ensure(!completed, "activity_closed")
        ensure(elapsedMs >= 0 && elapsedMs >= lastElapsedMs, "activity_invalid_elapsed")
        ensure(elapsedMs < MiBand6ActivityProtocol.TOTAL_TIMEOUT_MS, "activity_total_timeout")
        ensure(elapsedMs - lastProgressMs < MiBand6ActivityProtocol.NO_PROGRESS_TIMEOUT_MS,
            "activity_no_progress_timeout")
        lastElapsedMs = elapsedMs
    }

    fun onControlNotification(bytes: ByteArray, elapsedMs: Long): MiBand6ActivityBatch? {
        val observedAt = enterNotification(elapsedMs)
        if (bytes.size >= 2 && u8(bytes[0]) == 0x10) {
            if (u8(bytes[1]) == 0x01 && bytes.size == 15 && evidenceMetadata.isEmpty()) {
                evidenceMetadata = bytes.copyOf()
            } else if (u8(bytes[1]) == 0x02 && bytes.size <= 7) {
                // Keep unsupported CRC endings available to diagnostics, without accepting them.
                evidenceCompletion = bytes.copyOf()
            }
        }
        ensure(bytes.size >= 3 && u8(bytes[0]) == 0x10, "activity_control_response")
        when (u8(bytes[1])) {
            0x01 -> {
                ensure(anchor == null, "activity_duplicate_start")
                ensure(bytes.size == 15, "activity_start_length")
                ensure(u8(bytes[2]) == 0x01, "activity_start_failed")
                val startedAt = try {
                    decodeAnchor(bytes)
                } catch (error: MiBand6ActivityException) {
                    fail(error.code)
                }
                ensure(startedAt >= requestedSinceAt, "activity_anchor_before_request")
                ensure(startedAt <= observedAt, "activity_anchor_future")
                anchor = startedAt
                reportedSize = (3..6).fold(0L) { size, index ->
                    size or (u8(bytes[index]).toLong() shl ((index - 3) * 8))
                }
                ensure(reportedSize <= MiBand6ActivityProtocol.MAX_RECORDS, "activity_record_limit")
                lastProgressMs = elapsedMs
                return if (reportedSize == 0L) complete(observedAt) else null
            }
            0x02 -> {
                val startedAt = anchor ?: fail("activity_end_before_metadata")
                ensure(bytes.size != 7, "activity_crc_unsupported")
                ensure(bytes.size == 3, "activity_end_length")
                ensure(u8(bytes[2]) == 0x01, "activity_end_failed")
                ensure(pendingSize == 0, "activity_truncated")
                ensure(byteCount > 0, "activity_empty_data")
                validateLastSample(startedAt, records.size, observedAt)
                return complete(observedAt)
            }
            else -> fail("activity_control_response")
        }
    }

    private fun complete(observedAt: Long): MiBand6ActivityBatch {
        val startedAt = anchor ?: fail("activity_end_before_metadata")
        ensure(records.size.toLong() == reportedSize, "activity_length_mismatch")
        val closedCount = minOf(records.size.toLong(),
            (observedAt - startedAt) / MiBand6ActivityProtocol.MINUTE_MS).toInt()
        completed = true
        return MiBand6ActivityBatch(
            requestedSinceAt, startedAt, observedAt, records.take(closedCount),
            reportedSize, byteCount, packetCount,
        )
    }

    // false is an exact, immediate duplicate. Even a one-byte new payload is progress.
    fun onDataNotification(bytes: ByteArray, elapsedMs: Long): Boolean {
        val observedAt = enterNotification(elapsedMs)
        val startedAt = anchor ?: fail("activity_data_before_metadata")
        ensure(bytes.size >= 2, "activity_empty_packet")
        val counter = u8(bytes[0])
        val previous = previousPacket
        if (previous != null && counter == u8(previous[0])) {
            ensure(bytes.contentEquals(previous), "activity_duplicate_mismatch")
            return false
        }
        val expected = if (previous == null) 0 else (u8(previous[0]) + 1) and 0xff
        ensure(counter == expected, "activity_sequence")
        // Long arithmetic avoids overflow before checking adversarial input sizes.
        val nextBytes = byteCount.toLong() + bytes.size - 1L
        val nextRecords = nextBytes / MiBand6ActivityProtocol.RECORD_BYTES
        ensure(nextRecords <= MiBand6ActivityProtocol.MAX_RECORDS, "activity_record_limit")
        ensure(nextBytes <= MiBand6ActivityProtocol.MAX_BYTES, "activity_byte_limit")
        validateLastSample(startedAt, nextRecords.toInt(), observedAt)
        for (index in 1 until bytes.size) {
            if (evidenceRecordBytes < evidenceRecords.size) {
                evidenceRecords[evidenceRecordBytes++] = bytes[index]
            }
            pending[pendingSize++] = bytes[index]
            if (pendingSize == pending.size) {
                records.add(u8(pending[2]) to u8(pending[1]))
                pendingSize = 0
            }
        }
        byteCount = nextBytes.toInt()
        previousPacket = bytes.copyOf()
        lastProgressMs = elapsedMs
        return true
    }

    private fun enterNotification(elapsedMs: Long): Long {
        checkElapsed(elapsedMs)
        val observedAt = now()
        try {
            validateEpoch(observedAt, "activity_invalid_clock")
        } catch (error: MiBand6ActivityException) {
            fail(error.code)
        }
        ensure(observedAt >= lastNowAt, "activity_clock_reversed")
        lastNowAt = observedAt
        ensure(packetCount < MiBand6ActivityProtocol.MAX_PACKETS, "activity_packet_limit")
        packetCount++
        return observedAt
    }

    private fun validateLastSample(startedAt: Long, count: Int, observedAt: Long) {
        if (count == 0) return
        val lastAt = try {
            Math.addExact(startedAt, (count - 1L) * MiBand6ActivityProtocol.MINUTE_MS)
        } catch (_: ArithmeticException) {
            fail("activity_timestamp_overflow")
        }
        ensure(lastAt <= observedAt, "activity_sample_future")
    }

    private fun ensure(valid: Boolean, code: String) {
        if (!valid) fail(code)
    }

    private fun fail(code: String): Nothing {
        failure = code
        throw MiBand6ActivityException(code)
    }
}

private fun u8(value: Byte): Int = value.toInt() and 0xff

private fun activityRequire(valid: Boolean, code: String) {
    if (!valid) throw MiBand6ActivityException(code)
}

private fun validateEpoch(value: Long, code: String) {
    val year = Instant.ofEpochMilli(value).atOffset(ZoneOffset.UTC).year
    activityRequire(year in 2000..2099, code)
}

private fun validateRequest(requestedSinceAt: Long, nowAt: Long) {
    validateEpoch(nowAt, "activity_invalid_clock")
    validateEpoch(requestedSinceAt, "activity_invalid_request")
    activityRequire(requestedSinceAt % MiBand6ActivityProtocol.MINUTE_MS == 0L,
        "activity_request_not_minute")
    activityRequire(requestedSinceAt <= nowAt, "activity_request_future")
}

private fun decodeAnchor(bytes: ByteArray): Long {
    val year = u8(bytes[7]) or (u8(bytes[8]) shl 8)
    val offset = bytes[14].toInt()
    activityRequire(year in 2000..2099, "activity_invalid_date")
    activityRequire(offset in -48..56, "activity_invalid_timezone")
    val local = try {
        LocalDateTime.of(year, u8(bytes[9]), u8(bytes[10]), u8(bytes[11]),
            u8(bytes[12]), u8(bytes[13]))
    } catch (_: DateTimeException) {
        throw MiBand6ActivityException("activity_invalid_date")
    }
    activityRequire(local.second == 0, "activity_anchor_not_minute")
    return local.toInstant(ZoneOffset.ofTotalSeconds(offset * 15 * 60)).toEpochMilli()
}
