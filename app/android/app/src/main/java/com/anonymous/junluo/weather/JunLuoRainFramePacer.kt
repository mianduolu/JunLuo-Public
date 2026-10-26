package com.anonymous.junluo.weather

internal class JunLuoRainFramePacer(
  internal val targetFps: Long = RAIN_TARGET_FPS,
) {
  init {
    require(targetFps > 0L)
  }

  private var accumulatedNanos = 0L
  private val frameIntervalNanos = 1_000_000_000L / targetFps

  fun consume(deltaNanos: Long): Boolean {
    if (deltaNanos <= 0L) return false
    accumulatedNanos += deltaNanos
    if (accumulatedNanos < frameIntervalNanos) return false
    accumulatedNanos %= frameIntervalNanos
    return true
  }

  fun reset() {
    accumulatedNanos = 0L
  }

  internal companion object {
    const val FOG_TARGET_FPS = 12L
    const val HAIL_TARGET_FPS = 20L
    const val RAIN_TARGET_FPS = 24L
    const val SNOW_TARGET_FPS = 20L
  }
}
