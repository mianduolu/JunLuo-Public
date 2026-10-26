package com.anonymous.junluo.chat

import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.ViewManager

class JunLuoChatReplyBackgroundPackage : ReactPackage {
    override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> =
        listOf(JunLuoChatReplyBackgroundModule(context))
    override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class JunLuoChatReplyBackgroundModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    override fun getName() = "JunLuoChatReplyBackground"

    @ReactMethod
    fun begin(token: String, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            // Start during the user send, or join its already running host.
            // Never start a new runtime/reply from a background trigger.
            if (token.isBlank() || token.length > 96 || !reactApplicationContext.hasActiveReactInstance()) {
                promise.resolve(false)
                return@runOnUiThread
            }
            try {
                // Android decides foreground-start eligibility. Do not reject a
                // user send merely because onPause raced this bridge callback.
                ContextCompat.startForegroundService(reactApplicationContext,
                    Intent(reactApplicationContext, JunLuoChatReplyBackgroundService::class.java)
                        .putExtra("token", token))
                promise.resolve(true)
            } catch (_: Exception) {
                promise.resolve(false)
            }
        }
    }
}
