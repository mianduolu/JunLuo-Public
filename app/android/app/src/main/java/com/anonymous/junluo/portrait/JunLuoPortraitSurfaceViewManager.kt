package com.anonymous.junluo.portrait

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

internal class JunLuoPortraitSurfaceViewManager : SimpleViewManager<JunLuoPortraitSurfaceView>() {
  override fun getName(): String = "JunLuoPortraitSurface"

  override fun createViewInstance(reactContext: ThemedReactContext): JunLuoPortraitSurfaceView =
    JunLuoPortraitSurfaceView(reactContext)

  @ReactProp(name = "sourceName")
  fun setSourceName(view: JunLuoPortraitSurfaceView, sourceName: String?) {
    view.setSourceName(sourceName)
  }

  @ReactProp(name = "active", defaultBoolean = true)
  fun setActive(view: JunLuoPortraitSurfaceView, active: Boolean) {
    view.setActive(active)
  }

  override fun onDropViewInstance(view: JunLuoPortraitSurfaceView) {
    view.dispose()
    super.onDropViewInstance(view)
  }
}
