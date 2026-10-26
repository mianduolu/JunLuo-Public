package com.anonymous.junluo

import java.util.Calendar

internal object MiBand6TimeProtocol {
    const val CHARACTERISTIC_UUID = "00002a2b-0000-1000-8000-00805f9b34fb"

    // HuamiSupport.getTimeBytes(SECONDS): local time, zero fractions/reason, DST-inclusive offset.
    fun encode(now: Calendar = Calendar.getInstance()): ByteArray {
        val year = now.get(Calendar.YEAR)
        val offset = now.timeZone.getOffset(now.timeInMillis) / (15 * 60 * 1000)
        require(year in 1582..9999 && offset in -48..56)
        val weekday = (now.get(Calendar.DAY_OF_WEEK) + 5) % 7 + 1
        return byteArrayOf(
            year.toByte(), (year shr 8).toByte(), (now.get(Calendar.MONTH) + 1).toByte(),
            now.get(Calendar.DAY_OF_MONTH).toByte(), now.get(Calendar.HOUR_OF_DAY).toByte(),
            now.get(Calendar.MINUTE).toByte(), now.get(Calendar.SECOND).toByte(),
            weekday.toByte(), 0, 0, offset.toByte(),
        )
    }
}
