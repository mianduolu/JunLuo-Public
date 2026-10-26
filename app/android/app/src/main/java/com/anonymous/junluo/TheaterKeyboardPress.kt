package com.anonymous.junluo

// One physical press, including repeats and key-up. No timer or persistent state.
internal class TheaterKeyboardPress {
  data class Key(val device: Int, val code: Int, val downTime: Long)
  enum class Result { PASS, CONSUME, SUBMIT }
  private var held: Key? = null

  fun down(key: Key, repeat: Int, eligible: Boolean, canSubmit: Boolean): Result {
    if (held == key) return Result.CONSUME
    // Never start midway through a held key, e.g. after changing focus or finishing composition.
    if (repeat != 0 || !eligible) return Result.PASS
    held = key
    return if (canSubmit) Result.SUBMIT else Result.CONSUME
  }

  fun up(key: Key): Result {
    if (held != key) return Result.PASS
    held = null
    return Result.CONSUME
  }

  fun reset() { held = null }
}
