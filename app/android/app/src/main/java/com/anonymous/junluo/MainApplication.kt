package com.anonymous.junluo

import com.anonymous.junluo.recentuse.JunLuoRecentDeviceUsePackage

import com.anonymous.junluo.camera.JunLuoCameraReactPackage
import com.anonymous.junluo.portrait.JunLuoPortraitSurfacePackage
import com.anonymous.junluo.weather.JunLuoRainViewPackage
import com.anonymous.junluo.backup.JunLuoBackupArchiveModule
import com.anonymous.junluo.backup.JunLuoBackupArchivePackage
import com.anonymous.junluo.externalfiles.JunLuoExternalFilesPackage
import com.anonymous.junluo.strongalarm.JunLuoStrongAlarmPackage
import com.anonymous.junluo.incomingcall.JunLuoIncomingCallPackage
import com.anonymous.junluo.schedule.JunLuoScheduleReminderPackage
import com.anonymous.junluo.sleep.JunLuoSleepSchedulePackage
import com.anonymous.junluo.chat.JunLuoChatReplyBackgroundPackage

import android.app.Application
import android.content.Context
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper
import kotlin.concurrent.thread

class MainApplication : Application(), ReactApplication {

  private val startupCheckProcess = JunLuoStartupDiagnostics.isCheckProcess()
  // Preserve eager host construction in the normal process, before attach/providers.
  private val mainHost: ReactNativeHost? = if (startupCheckProcess) null else createMainHost()

  override val reactNativeHost: ReactNativeHost
    get() = checkNotNull(mainHost) { "React Native is unavailable in the startup check process" }

  private fun createMainHost(): ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              add(JunLuoRecentDeviceUsePackage())
              add(JunLuoCameraReactPackage())
              add(JunLuoPortraitSurfacePackage())
              add(JunLuoRainViewPackage())
              // Packages that cannot be autolinked yet can be added manually here, for example:
              add(BodySignalCompanionPackage())
              add(BodySignalActivityContextPackage())
              add(BodySignalGuardianPackage())
              add(JunLuoPhoneActivityPackage())
              add(JunLuoVoiceAudioPackage())
              add(JunLuoBackupArchivePackage())
              add(JunLuoExternalFilesPackage())
              add(JunLuoNetworkStatusPackage())
              add(MiBand6RealtimeHeartRatePackage())
              add(JunLuoStrongAlarmPackage())
              add(JunLuoIncomingCallPackage())
              add(JunLuoScheduleReminderPackage())
              add(JunLuoSleepSchedulePackage())
              add(JunLuoChatReplyBackgroundPackage())
              add(ShiyingBackfillBackgroundPackage())
            }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun attachBaseContext(base: Context) {
    super.attachBaseContext(base)
    if (!startupCheckProcess) JunLuoStartupDiagnostics.install(this)
  }

  override fun onCreate() {
    super.onCreate()
    if (startupCheckProcess) return
    JunLuoStartupDiagnostics.stage("application_create")
    thread(name = "JunLuoBackupCleanup", isDaemon = true) {
      runCatching { JunLuoBackupArchiveModule.cleanupStaleBackupCache(cacheDir) }
    }
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    JunLuoStartupDiagnostics.stage("rn_load_begin")
    loadReactNative(this)
    JunLuoStartupDiagnostics.stage("expo_lifecycle_begin")
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
    JunLuoStartupDiagnostics.stage("expo_lifecycle_end")
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (!startupCheckProcess) ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
