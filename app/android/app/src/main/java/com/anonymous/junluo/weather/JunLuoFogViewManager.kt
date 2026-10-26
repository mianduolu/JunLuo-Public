package com.anonymous.junluo.weather

import com.facebook.react.bridge.ReadableArray
import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

internal class JunLuoFogViewManager : SimpleViewManager<JunLuoFogView>() {
  override fun getName(): String = "JunLuoFogView"

  override fun createViewInstance(reactContext: ThemedReactContext): JunLuoFogView =
    JunLuoFogView(reactContext)

  @ReactProp(name = "active", defaultBoolean = false)
  fun setActive(view: JunLuoFogView, value: Boolean) = view.setActive(value)

  @ReactProp(name = "animated", defaultBoolean = false)
  fun setAnimated(view: JunLuoFogView, value: Boolean) = view.setAnimated(value)

  @ReactProp(name = "diagnosticTimeMs", defaultDouble = 0.0)
  fun setDiagnosticTimeMs(view: JunLuoFogView, value: Double) = view.setDiagnosticTimeMs(value)

  @ReactProp(name = "diagnosticsEnabled", defaultBoolean = false)
  fun setDiagnosticsEnabled(view: JunLuoFogView, value: Boolean) = view.setDiagnosticsEnabled(value)

  @ReactProp(name = "effectKind")
  fun setEffectKind(view: JunLuoFogView, value: String?) = view.setEffectKind(value)

  @ReactProp(name = "enabled", defaultBoolean = false)
  fun setEnabled(view: JunLuoFogView, value: Boolean) = view.setRenderEnabled(value)

  @ReactProp(name = "exitingAtMs", defaultDouble = -1.0)
  fun setExitingAtMs(view: JunLuoFogView, value: Double) = view.setExitingAtMs(value)

  @ReactProp(name = "generation", defaultDouble = 0.0)
  fun setGeneration(view: JunLuoFogView, value: Double) = view.setGeneration(value.toInt())

  @ReactProp(name = "layerOpacity", defaultDouble = 1.0)
  fun setLayerOpacity(view: JunLuoFogView, value: Double) = view.setLayerOpacity(value)

  @ReactProp(name = "logicalHeight", defaultDouble = 0.0)
  fun setLogicalHeight(view: JunLuoFogView, value: Double) = view.setLogicalHeight(value)

  @ReactProp(name = "logicalWidth", defaultDouble = 0.0)
  fun setLogicalWidth(view: JunLuoFogView, value: Double) = view.setLogicalWidth(value)

  @ReactProp(name = "opacityBoost", defaultDouble = 1.0)
  fun setOpacityBoost(view: JunLuoFogView, value: Double) = view.setOpacityBoost(value)

  @ReactProp(name = "particles")
  fun setParticles(view: JunLuoFogView, values: ReadableArray?) {
    view.setParticles(values?.toArrayList()?.mapNotNull { (it as? Number)?.toDouble() } ?: emptyList())
  }

  @ReactProp(name = "startedAtMs", defaultDouble = 0.0)
  fun setStartedAtMs(view: JunLuoFogView, value: Double) = view.setStartedAtMs(value)

  @ReactProp(name = "transitionDurationMs", defaultDouble = 1000.0)
  fun setTransitionDurationMs(view: JunLuoFogView, value: Double) = view.setTransitionDurationMs(value)

  override fun onDropViewInstance(view: JunLuoFogView) {
    view.dispose()
    super.onDropViewInstance(view)
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
    MapBuilder.of("topRendererStateChange", MapBuilder.of("registrationName", "onRendererStateChange"))
}
