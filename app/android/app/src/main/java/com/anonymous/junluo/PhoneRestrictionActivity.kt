package com.anonymous.junluo

import androidx.appcompat.app.AppCompatActivity
import android.os.Bundle
import android.os.Build
import android.view.View
import android.view.WindowManager
import com.facebook.react.ReactApplication
import com.facebook.react.modules.core.DefaultHardwareBackBtnHandler

/** A native host above keyguard; display alone is not proof of navigation enforcement. */
class PhoneRestrictionActivity : AppCompatActivity(), DefaultHardwareBackBtnHandler {
    private val reactApplication get() = application as ReactApplication
    lateinit var lockView: PhoneRestrictionLockView
        private set
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 27) setShowWhenLocked(true)
        else window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false)
        window.addFlags(WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_FULLSCREEN)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
        if (Build.VERSION.SDK_INT >= 30) window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        }
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        lockView = PhoneRestrictionWindow.createView(this)
        setContentView(lockView)
        PhoneRestrictionWindow.activityCreated(this)
    }
    @Deprecated("Back remains inside an active restriction")
    override fun onBackPressed() {
        if (PhoneRestrictionRuntime.phoneBlockingRecords(this, packageName).isEmpty()) finish()
    }
    override fun onResume() {
        super.onResume()
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) reactApplication.reactHost?.onHostResume(this, this)
        else reactApplication.reactNativeHost.reactInstanceManager.onHostResume(this, this)
    }
    override fun onPause() {
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            reactApplication.reactHost?.let { if (it.currentReactContext?.currentActivity === this) it.onHostPause(this) }
        } else if (reactApplication.reactNativeHost.hasInstance()) {
            val manager = reactApplication.reactNativeHost.reactInstanceManager
            if (manager.currentReactContext?.currentActivity === this) manager.onHostPause(this)
        }
        super.onPause()
    }
    override fun invokeDefaultOnBackPressed() { onBackPressed() }
    override fun onDestroy() {
        PhoneRestrictionWindow.activityDestroyed(this)
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            reactApplication.reactHost?.onHostDestroy(this)
        } else if (reactApplication.reactNativeHost.hasInstance()) {
            reactApplication.reactNativeHost.reactInstanceManager.onHostDestroy(this)
        }
        super.onDestroy()
    }
    override fun onStop() {
        PhoneRestrictionWindow.activityHidden(this)
        super.onStop()
    }
}
