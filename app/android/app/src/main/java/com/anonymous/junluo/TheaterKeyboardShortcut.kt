package com.anonymous.junluo

import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import com.facebook.react.views.textinput.ReactEditText

internal class TheaterKeyboardShortcut {
  private val press = TheaterKeyboardPress()

  fun reset() = press.reset()

  fun dispatch(event: KeyEvent, focused: View?): Boolean {
    val key = TheaterKeyboardPress.Key(event.deviceId, event.keyCode, event.downTime)
    if (event.action == KeyEvent.ACTION_UP) {
      return press.up(key) == TheaterKeyboardPress.Result.CONSUME
    }
    if (event.action != KeyEvent.ACTION_DOWN) return false
    val input = focused as? ReactEditText
    val identity = input?.getTag(com.facebook.react.R.id.view_tag_native_id) as? String ?: ""
    val enabled = identity.startsWith(ENABLED)
    val isTheater = input?.getTag(com.facebook.react.R.id.react_test_id) == INPUT_ID &&
      (enabled || identity.startsWith(DISABLED))
    val composing = input?.text?.let {
      BaseInputConnection.getComposingSpanStart(it) >= 0 || BaseInputConnection.getComposingSpanEnd(it) >= 0
    } ?: false
    val eligible = isTheater && input?.isFocused == true && input.isShown && input.hasWindowFocus() &&
      input.isEnabled && event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed &&
      !event.isShiftPressed && !event.isCanceled && !composing &&
      event.flags and KeyEvent.FLAG_SOFT_KEYBOARD == 0 &&
      (event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER)
    val result = press.down(key, event.repeatCount, eligible, enabled)
    if (result == TheaterKeyboardPress.Result.SUBMIT && input != null) {
      val context = UIManagerHelper.getReactContext(input)
      val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, input.id)
      dispatcher?.dispatchEvent(TheaterSubmitEvent(
        UIManagerHelper.getSurfaceId(input), input.id, input.text?.toString() ?: "",
        identity.removePrefix(ENABLED),
      ))
    }
    return result != TheaterKeyboardPress.Result.PASS
  }

  companion object {
    const val INPUT_ID = "junluo-theater-draft-input"
    const val ENABLED = "junluo-theater-submit:"
    const val DISABLED = "junluo-theater-no-submit:"
  }
}

// Reuse TextInput's registered submit event, not a global emitter or a new native module.
private class TheaterSubmitEvent(
  surface: Int, target: Int, private val text: String, private val binding: String,
) : Event<TheaterSubmitEvent>(surface, target) {
  override fun getEventName() = "topSubmitEditing"
  override fun canCoalesce() = false
  override fun getEventData(): WritableMap = Arguments.createMap().apply {
    putInt("target", viewTag)
    putString("text", text)
    putBoolean("theaterShortcut", true)
    putString("theaterBinding", binding)
  }
}
