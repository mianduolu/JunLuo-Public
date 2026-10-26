package com.anonymous.junluo

import org.json.JSONObject
import java.util.Calendar
import kotlin.math.pow
import kotlin.math.roundToInt

/** Reads the same asset as the home sky and existing chat styles. No restriction state or timer. */
class PhoneRestrictionAppearance(private val definition: JSONObject) {
    val chat: JSONObject = definition.getJSONObject("chat")
    private val sky = definition.getJSONObject("sky")
    private val windows = sky.getJSONArray("windows")
    private fun palette(key: String): List<Int> {
        val colors = sky.getJSONObject("themes").getJSONObject(key).getJSONArray("colors")
        return (0 until colors.length()).map { colors.getString(it).removePrefix("#").toInt(16) or (0xff shl 24) }
    }

    fun colorsAt(now: Long): List<Int> {
        val date = Calendar.getInstance().apply { timeInMillis = now }
        return colorsAtMinute(date.get(Calendar.HOUR_OF_DAY) * 60 + date.get(Calendar.MINUTE) + date.get(Calendar.SECOND) / 60.0)
    }

    fun isNightAt(now: Long): Boolean {
        val date = Calendar.getInstance().apply { timeInMillis = now }
        val minute = date.get(Calendar.HOUR_OF_DAY) * 60 + date.get(Calendar.MINUTE)
        val window = (0 until windows.length()).map { windows.getJSONObject(it) }
            .first { minute >= it.getInt("startMinute") && minute < it.getInt("endMinute") }
        return window.getString("key") in listOf("night", "midnight")
    }

    fun colorsAtMinute(minute: Double): List<Int> {
        val index = (0 until windows.length()).firstOrNull {
            val window = windows.getJSONObject(it)
            minute >= window.getInt("startMinute") && minute < window.getInt("endMinute")
        } ?: 0
        val window = windows.getJSONObject(index)
        val from = palette(window.getString("key"))
        val remaining = window.getInt("endMinute") - minute
        val transition = sky.getInt("transitionMinutes")
        if (remaining > transition || remaining < 0) return from
        val to = palette(windows.getJSONObject((index + 1) % windows.length()).getString("key"))
        val progress = 1 - remaining / transition
        return (0 until maxOf(from.size, to.size)).map { i ->
            val a = from[minOf(i, from.lastIndex)]; val b = to[minOf(i, to.lastIndex)]
            var color = 0xff shl 24
            for (shift in listOf(16, 8, 0)) {
                val start = (a shr shift) and 255; val end = (b shr shift) and 255
                color = color or ((start + (end - start) * progress).roundToInt() shl shift)
            }
            color
        }
    }

    /** One tone for the lock page, sampled between the sky's upper two gradient stops. */
    fun inkForSky(palette: List<Int>): Int {
        val top = palette.first(); val middle = palette[minOf(1, palette.lastIndex)]
        var background = 0xff shl 24
        for (shift in listOf(16, 8, 0)) {
            val channel = ((((top shr shift) and 255) + ((middle shr shift) and 255)) / 2.0).roundToInt()
            background = background or (channel shl shift)
        }
        return inkFor(background)
    }

    /** Identical sRGB threshold and foreground colors to homeReadability.ts. */
    fun inkFor(background: Int): Int {
        fun channel(shift: Int): Double {
            val value = ((background shr shift) and 255) / 255.0
            return if (value <= 0.03928) value / 12.92 else ((value + 0.055) / 1.055).pow(2.4)
        }
        val luminance = channel(16) * 0.2126 + channel(8) * 0.7152 + channel(0) * 0.0722
        return if (luminance > 0.46) 0xff384052.toInt() else 0xffffffff.toInt()
    }

    fun chatColor(style: String, key: String): Int {
        val value = chat.getJSONObject(style).getString(key)
        if (value.startsWith("#")) return value.removePrefix("#").toInt(16) or (0xff shl 24)
        val rgba = value.removePrefix("rgba(").removeSuffix(")").split(',').map { it.trim().toDouble() }
        return ((rgba[3] * 255).roundToInt() shl 24) or (rgba[0].toInt() shl 16) or (rgba[1].toInt() shl 8) or rgba[2].toInt()
    }
}
