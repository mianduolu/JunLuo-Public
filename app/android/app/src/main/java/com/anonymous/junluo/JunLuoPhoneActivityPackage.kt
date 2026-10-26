package com.anonymous.junluo

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers JunLuoPhoneActivityModule so it appears as
 * NativeModules.JunLuoPhoneActivity in JavaScript.
 */
class JunLuoPhoneActivityPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(
            JunLuoPhoneActivityModule(reactContext),
            JunLuoSpeechRecognizerModule(reactContext)
        )
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
