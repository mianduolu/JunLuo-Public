package com.anonymous.junluo.weather

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

internal class JunLuoRainViewManager : SimpleViewManager<JunLuoRainView>() {
  override fun getName(): String = "JunLuoRainView"

  override fun createViewInstance(reactContext: ThemedReactContext): JunLuoRainView =
    JunLuoRainView(reactContext)

  @ReactProp(name = "active", defaultBoolean = false)
  fun setActive(view: JunLuoRainView, value: Boolean) = view.setActive(value)

  @ReactProp(name = "animated", defaultBoolean = false)
  fun setAnimated(view: JunLuoRainView, value: Boolean) = view.setAnimated(value)

  @ReactProp(name = "diagnosticTimeMs", defaultDouble = 0.0)
  fun setDiagnosticTimeMs(view: JunLuoRainView, value: Double) = view.setDiagnosticTimeMs(value)

  @ReactProp(name = "diagnosticsEnabled", defaultBoolean = false)
  fun setDiagnosticsEnabled(view: JunLuoRainView, value: Boolean) = view.setDiagnosticsEnabled(value)

  @ReactProp(name = "enabled", defaultBoolean = false)
  fun setEnabled(view: JunLuoRainView, value: Boolean) = view.setRenderEnabled(value)

  @ReactProp(name = "effectKind")
  fun setEffectKind(view: JunLuoRainView, value: String?) = view.setEffectKind(value)

  @ReactProp(name = "exitingAtMs", defaultDouble = -1.0)
  fun setExitingAtMs(view: JunLuoRainView, value: Double) = view.setExitingAtMs(value)

  @ReactProp(name = "generation", defaultDouble = 0.0)
  fun setGeneration(view: JunLuoRainView, value: Double) = view.setGeneration(value.toInt())

  @ReactProp(name = "layerOpacity", defaultDouble = 1.0)
  fun setLayerOpacity(view: JunLuoRainView, value: Double) = view.setLayerOpacity(value)

  @ReactProp(name = "logicalHeight", defaultDouble = 0.0)
  fun setLogicalHeight(view: JunLuoRainView, value: Double) = view.setLogicalHeight(value)

  @ReactProp(name = "logicalWidth", defaultDouble = 0.0)
  fun setLogicalWidth(view: JunLuoRainView, value: Double) = view.setLogicalWidth(value)

  @ReactProp(name = "particles")
  fun setParticles(view: JunLuoRainView, values: ReadableArray?) {
    view.setParticles(values?.toArrayList()?.mapNotNull { (it as? Number)?.toDouble() } ?: emptyList())
  }

  @ReactProp(name = "startedAtMs", defaultDouble = 0.0)
  fun setStartedAtMs(view: JunLuoRainView, value: Double) = view.setStartedAtMs(value)

  @ReactProp(name = "transitionDurationMs", defaultDouble = 1000.0)
  fun setTransitionDurationMs(view: JunLuoRainView, value: Double) = view.setTransitionDurationMs(value)

  override fun onDropViewInstance(view: JunLuoRainView) {
    view.dispose()
    super.onDropViewInstance(view)
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
    MapBuilder.of("topRendererStateChange", MapBuilder.of("registrationName", "onRendererStateChange"))
}
