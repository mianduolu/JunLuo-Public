package com.anonymous.junluo.camera

import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

internal class JunLuoCameraPreviewViewManager : SimpleViewManager<JunLuoCameraPreviewView>() {
    override fun getName(): String = "JunLuoCameraPreview"
    override fun createViewInstance(reactContext: ThemedReactContext) = JunLuoCameraPreviewView(reactContext)

    @ReactProp(name = "previewId") fun setPreviewId(view: JunLuoCameraPreviewView, value: String?) = view.setPreviewId(value)
    @ReactProp(name = "sessionId") fun setSessionId(view: JunLuoCameraPreviewView, value: String?) = view.setSessionId(value)
    @ReactProp(name = "requestedFacing") fun setRequestedFacing(view: JunLuoCameraPreviewView, value: String?) = view.setRequestedFacing(value)
    @ReactProp(name = "active", defaultBoolean = false) fun setActive(view: JunLuoCameraPreviewView, value: Boolean) = view.setActive(value)
    @ReactProp(name = "generation", defaultDouble = 0.0) fun setGeneration(view: JunLuoCameraPreviewView, value: Double) = view.setGeneration(value)

    override fun onDropViewInstance(view: JunLuoCameraPreviewView) {
        view.dispose()
        super.onDropViewInstance(view)
    }

    override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
        MapBuilder.of("topPreviewStateChanged", MapBuilder.of("registrationName", "onPreviewStateChanged"))
}
