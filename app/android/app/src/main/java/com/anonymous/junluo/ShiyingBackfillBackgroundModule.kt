package com.anonymous.junluo

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.common.LifecycleState
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.ViewManager

class ShiyingBackfillBackgroundPackage : ReactPackage {
    @Suppress("OVERRIDE_DEPRECATION")
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(ShiyingBackfillBackgroundModule(reactContext))
    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class ShiyingBackfillBackgroundModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
    private val awaitingHosts = mutableMapOf<String, String>()
    private var ownedHost: Pair<String, String>? = null
    override fun getName() = "JunLuoShiyingBackfillBackground"

    @ReactMethod
    fun start(taskId: String, hostToken: String, completedDays: Int, totalDays: Int, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            if (!valid(taskId, hostToken, completedDays, totalDays) ||
                !reactApplicationContext.hasActiveReactInstance() ||
                reactApplicationContext.lifecycleState != LifecycleState.RESUMED) {
                promise.resolve(false)
                return@runOnUiThread
            }
            val handler = Handler(Looper.getMainLooper())
            val timeout = Runnable {
                ShiyingBackfillBackgroundService.settleStart(hostToken, false)
                ShiyingBackfillBackgroundService.stop(taskId, hostToken)
            }
            awaitingHosts[hostToken] = taskId
            ShiyingBackfillBackgroundService.awaitStart(hostToken) { started ->
                handler.removeCallbacks(timeout)
                awaitingHosts.remove(hostToken)
                if (started) ownedHost = taskId to hostToken
                promise.resolve(started)
            }
            handler.postDelayed(timeout, 10_000L)
            try {
                ContextCompat.startForegroundService(reactApplicationContext,
                    Intent(reactApplicationContext, ShiyingBackfillBackgroundService::class.java)
                        .putExtra("taskId", taskId).putExtra("hostToken", hostToken)
                        .putExtra("completedDays", completedDays).putExtra("totalDays", totalDays))
            } catch (_: Exception) {
                ShiyingBackfillBackgroundService.settleStart(hostToken, false)
            }
        }
    }

    @ReactMethod
    fun update(taskId: String, hostToken: String, completedDays: Int, totalDays: Int, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            promise.resolve(valid(taskId, hostToken, completedDays, totalDays) &&
                ShiyingBackfillBackgroundService.update(taskId, hostToken, completedDays, totalDays))
        }
    }

    @ReactMethod
    fun stop(taskId: String, hostToken: String, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            val handler = Handler(Looper.getMainLooper())
            val timeout = Runnable { ShiyingBackfillBackgroundService.settleStop(hostToken, false) }
            ShiyingBackfillBackgroundService.awaitStop(hostToken) { stopped ->
                handler.removeCallbacks(timeout)
                if (ownedHost == taskId to hostToken) ownedHost = null
                promise.resolve(stopped)
            }
            handler.postDelayed(timeout, 5_000L)
            if (!ShiyingBackfillBackgroundService.stop(taskId, hostToken)) {
                ShiyingBackfillBackgroundService.settleStop(hostToken, false)
            }
        }
    }

    @ReactMethod fun addListener(eventName: String) = Unit
    @ReactMethod fun removeListeners(count: Int) = Unit

    override fun invalidate() {
        UiThreadUtil.runOnUiThread {
            // A hot reload loses RAM results/authorization. Release only tokens
            // owned by this module, never a new module's later resumed host.
            val expired = awaitingHosts.map { (token, id) -> id to token } + listOfNotNull(ownedHost)
            awaitingHosts.clear()
            ownedHost = null
            expired.forEach { (id, token) ->
                ShiyingBackfillBackgroundService.settleStart(token, false)
                ShiyingBackfillBackgroundService.stop(id, token)
            }
        }
        super.invalidate()
    }

    private fun valid(id: String, token: String, completed: Int, total: Int) =
        id.isNotBlank() && id.length <= 96 && token.isNotBlank() && token.length <= 192 &&
            total in 1..31 && completed in 0..total
}
