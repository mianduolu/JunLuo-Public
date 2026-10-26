package com.anonymous.junluo

import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import java.util.Calendar
import kotlin.math.PI
import kotlin.math.pow
import kotlin.math.sin

/** Native counterpart of WeatherOverlay's current CanvasDrivenStarLayer, without a React host. */
internal class PhoneRestrictionNightStars(seed: Int) {
    data class Star(val x: Double, val y: Double, val size: Double, val opacity: Double,
                    val pulseSpeed: Double, val phase: Double) {
        fun twinkle(time: Long): Double {
            val period = 3000 + (pulseSpeed - 260) / (680 - 260) * (5000 - 3000)
            return ((sin(time / (period / (PI * 2)) + phase) + 1) / 2).pow(2.4)
        }
    }
    private var randomState = seed.toLong()
    private fun random(): Double {
        randomState = (randomState * 1664525 + 1013904223) and 0xffffffffL
        return randomState / 4294967296.0
    }
    val stars = List(66) {
        Star(0.04 + random() * 0.92, 0.02 + random() * 0.93,
            0.7 + random() * (2.05 - 0.7), 0.34 + random() * (0.8 - 0.34),
            260 + random() * (680 - 260), random() * PI * 2)
    }
    companion object {
        fun seedAt(now: Long): Int {
            val night = Calendar.getInstance().apply { timeInMillis = now }
            if (night.get(Calendar.HOUR_OF_DAY) < 5) night.add(Calendar.DAY_OF_MONTH, -1)
            return night.get(Calendar.YEAR) * 10000 + (night.get(Calendar.MONTH) + 1) * 100 + night.get(Calendar.DAY_OF_MONTH)
        }
    }
}

internal class PhoneRestrictionSkyBackground(private val density: Float) : Drawable() {
    private val gradient = GradientDrawable()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = android.graphics.Color.WHITE
        maskFilter = BlurMaskFilter(0.5f * density, BlurMaskFilter.Blur.NORMAL)
    }
    private val startedAt = System.currentTimeMillis()
    private var frameTime = startedAt
    private var seed = 0
    private var stars = emptyList<PhoneRestrictionNightStars.Star>()
    private var colors = emptyList<Int>()
    var isNight = false
        private set

    fun update(now: Long, palette: List<Int>, night: Boolean) {
        if (colors != palette) {
            colors = palette
            gradient.orientation = GradientDrawable.Orientation.TOP_BOTTOM
            gradient.colors = palette.toIntArray()
        }
        isNight = night
        val currentSeed = PhoneRestrictionNightStars.seedAt(now)
        if (seed != currentSeed) {
            seed = currentSeed
            stars = PhoneRestrictionNightStars(seed).stars
        }
        tick(now)
    }
    fun tick(now: Long) {
        frameTime = startedAt + ((now - startedAt) / 360) * 360
        invalidateSelf()
    }
    override fun onBoundsChange(bounds: Rect) { gradient.bounds = bounds }
    override fun draw(canvas: Canvas) {
        gradient.draw(canvas)
        if (!isNight) return
        stars.forEach { star ->
            val twinkle = star.twinkle(frameTime)
            paint.alpha = (255 * star.opacity * (0.05 + twinkle * 0.95)).toInt()
            canvas.drawCircle(bounds.left + (star.x * bounds.width()).toFloat(),
                bounds.top + (star.y * bounds.height()).toFloat(),
                (star.size * (0.92 + twinkle * 0.14) * density).toFloat(), paint)
        }
    }
    override fun setAlpha(alpha: Int) { gradient.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { gradient.colorFilter = colorFilter }
    @Deprecated("Drawable opacity")
    override fun getOpacity() = PixelFormat.OPAQUE
}
