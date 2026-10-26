package com.anonymous.junluo

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper
import com.anonymous.junluo.incomingcall.JunLuoIncomingCallModule
import com.anonymous.junluo.incomingcall.IncomingCallWindowController

class MainActivity : ReactActivity() {
  private val theaterKeyboardShortcut = TheaterKeyboardShortcut()

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (theaterKeyboardShortcut.dispatch(event, currentFocus)) return true
    return super.dispatchKeyEvent(event)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    if (!hasFocus) theaterKeyboardShortcut.reset()
    super.onWindowFocusChanged(hasFocus)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
    IncomingCallWindowController.apply(this, intent)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  override fun onNewIntent(intent: Intent) {
      super.onNewIntent(intent)
      setIntent(intent)
      IncomingCallWindowController.apply(this, intent)
      JunLuoPhoneActivityModule.emitPhoneGuardLaunchIntent(intent)
      JunLuoIncomingCallModule.emitIncomingCallIntent(intent)
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){
              override fun getLaunchOptions(): Bundle? {
                  val targetScreen = intent?.getStringExtra("junluoTargetScreen")
                  val initialRoute = intent?.getStringExtra("initialRoute")
                  if (targetScreen != "chat" && initialRoute != "chat") return null
                  return Bundle().apply {
                      putString("initialRoute", "chat")
                      putString("junluoSource", intent?.getStringExtra("junluoSource") ?: "")
                      putString("junluoTriggerId", intent?.getStringExtra("junluoTriggerId") ?: "")
                  }
              }
          })
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
