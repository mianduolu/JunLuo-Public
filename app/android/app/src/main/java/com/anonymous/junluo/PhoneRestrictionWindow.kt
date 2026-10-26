package com.anonymous.junluo

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.View
import android.view.Display
import android.view.WindowManager
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/** One presentation path driven by the existing collector, with the same saved deadlines. */
object PhoneRestrictionWindow {
    private const val PRESENTATION_RETRY_MS = 2_000L
    private val handler = Handler(Looper.getMainLooper())
    private var root: PhoneRestrictionLockView? = null
    private var manager: WindowManager? = null
    private var overlayOwner: Context? = null
    private var activity = WeakReference<PhoneRestrictionActivity>(null)
    private var packageName = ""
    private var lastLaunchedFor = ""
    private var lastActivityAttemptAt = 0L
    private var lastActivityAttemptElapsed = -1L
    private var lastOverlayAttemptElapsed = -1L
    private var lastFailureCode = ""
    private var lastFailureAt = 0L
    private var emergencyPending = false
    private var deadlineScheduled = 0L
    private var appContext: Context? = null
    private val deadlineReached = Runnable {
        deadlineScheduled = 0L
        appContext?.let { update(it, packageName, System.currentTimeMillis()) }
    }

    private fun <T> onMain(work: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return work()
        val task = FutureTask(work)
        handler.post(task)
        return task.get()
    }

    fun createView(context: Context) = PhoneRestrictionLockView(context,
        emergency = { requestEmergency(context) }, openAllowedApp = { openAllowedApp(context, it) })

    fun activityCreated(host: PhoneRestrictionActivity) {
        activity = WeakReference(host)
        val records = PhoneRestrictionRuntime.phoneBlockingRecords(host, host.packageName)
        if (records.isEmpty()) host.finish()
        else {
            host.lockView.render(records.maxOf { it.restriction.endsAt }, System.currentTimeMillis(),
                PhoneRestrictionRuntime.phoneAllowedPackages(host))
            PhoneRestrictionChatSurface.show((root?.takeIf { it.isAttachedToWindow } ?: host.lockView).chatSlot)
        }
    }

    fun activityDestroyed(host: PhoneRestrictionActivity) {
        if (activity.get() === host) activity.clear()
    }

    fun activityHidden(host: PhoneRestrictionActivity) {
        if (activity.get() === host) lastLaunchedFor = ""
    }

    fun accessibilityServiceChanged(context: Context) {
        update(context, packageName, System.currentTimeMillis())
    }

    internal fun canRetryPresentation(lastAttemptElapsed: Long, nowElapsed: Long): Boolean =
        lastAttemptElapsed < 0L || nowElapsed - lastAttemptElapsed >= PRESENTATION_RETRY_MS

    private fun displayFailed(code: String, now: Long) {
        lastFailureCode = code
        lastFailureAt = now
    }

    fun isOverlayWindow(windowId: Int): Boolean = root?.let {
        if (windowId < 0 || !it.isAttachedToWindow) return@let false
        val node = it.createAccessibilityNodeInfo()
        val own = node.windowId == windowId
        node.recycle()
        own
    } == true

    fun update(context: Context, foregroundPackage: String, now: Long): Boolean = onMain {
        packageName = foregroundPackage
        appContext = context.applicationContext
        PhoneRestrictionEmergencyNotification.update(context, now)
        val records = PhoneRestrictionRuntime.phoneBlockingRecords(context, foregroundPackage, now)
        if (records.isEmpty()) {
            removeWindows()
            lastLaunchedFor = ""
            lastActivityAttemptElapsed = -1L
            lastOverlayAttemptElapsed = -1L
            lastFailureCode = ""
            lastFailureAt = 0L
            return@onMain false
        }
        val elapsedNow = SystemClock.elapsedRealtime()
        val deadline = records.maxOf { it.restriction.endsAt }
        val nextChange = records.minOf { it.restriction.endsAt }
        if (deadlineScheduled != nextChange) {
            handler.removeCallbacks(deadlineReached)
            deadlineScheduled = nextChange
            // A one-shot expiry still works if sampling stops; no duration is restarted.
            handler.postDelayed(deadlineReached, (nextChange - now).coerceAtLeast(1))
        }
        val allowed = PhoneRestrictionRuntime.phoneAllowedPackages(context, now)
        val host = activity.get()?.takeUnless { it.isFinishing || it.isDestroyed }
        host?.lockView?.render(deadline, now, allowed)
        // The service WindowManager supplies its accessibility token. Application context cannot.
        val accessibility = JunLuoAccessibilityService.restrictionOverlayContext()
        val layerContext = accessibility ?: context.applicationContext
        if (root != null && (overlayOwner !== layerContext || root?.isAttachedToWindow == false)) removeOverlay()
        val overlayAllowed = accessibility != null || runCatching { Settings.canDrawOverlays(context) }.getOrElse {
            displayFailed("OVERLAY_PERMISSION_UNREADABLE", now)
            false
        }
        if (root == null && overlayAllowed && canRetryPresentation(lastOverlayAttemptElapsed, elapsedNow)) {
            lastOverlayAttemptElapsed = elapsedNow
            runCatching {
                val view = createView(layerContext)
                val wm = layerContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                // Without accessibility the old layer remains a degraded cover, not strict system interception.
                val type = if (accessibility != null) WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                    else WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                val params = WindowManager.LayoutParams(-1, -1, type,
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                        WindowManager.LayoutParams.FLAG_FULLSCREEN,
                    PixelFormat.OPAQUE).apply {
                        setTitle("君落手机限制")
                        softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
                        if (Build.VERSION.SDK_INT >= 30) {
                            setFitInsetsTypes(0)
                            setFitInsetsIgnoringVisibility(true)
                        }
                        if (Build.VERSION.SDK_INT >= 30) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                        else if (Build.VERSION.SDK_INT >= 28) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
                    }
                view.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                wm.addView(view, params)
                root = view; manager = wm; overlayOwner = layerContext; view.requestFocus()
            }.onFailure { displayFailed("OVERLAY_ADD_FAILED", now) }
        }
        root?.render(deadline, now, allowed)
        (root?.takeIf { it.isAttachedToWindow } ?: host?.lockView)?.let { PhoneRestrictionChatSurface.show(it.chatSlot) }
        // Activity supplies keyguard hosting; ordinary overlays have different platform scope.
        val activityMissing = host == null || !host.lockView.isAttachedToWindow || host.lockView.windowVisibility != View.VISIBLE
        val screenInteractive = (context.getSystemService(Context.POWER_SERVICE) as? PowerManager)?.isInteractive != false
        if (activityMissing && screenInteractive && canRetryPresentation(lastActivityAttemptElapsed, elapsedNow)) {
            if (lastLaunchedFor == foregroundPackage && lastActivityAttemptAt > 0L) {
                // A background launch may be declined without throwing; a request is not display evidence.
                displayFailed("ACTIVITY_NOT_ATTACHED", now)
            }
            lastActivityAttemptAt = now
            lastActivityAttemptElapsed = elapsedNow
            runCatching { context.startActivity(Intent(context, PhoneRestrictionActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
                .onSuccess { lastLaunchedFor = foregroundPackage }
                .onFailure {
                    lastLaunchedFor = ""
                    displayFailed("ACTIVITY_START_FAILED", now)
                }
        }
        if (isShowing()) {
            lastFailureCode = ""
            lastFailureAt = 0L
        }
        true
    }

    fun isShowing(): Boolean = onMain {
        root?.let { it.isAttachedToWindow && it.isShown && it.hasWindowFocus() } == true || activity.get()?.let {
            !it.isFinishing && !it.isDestroyed && it.lockView.isAttachedToWindow && it.hasWindowFocus()
        } == true
    }

    /** Fresh physical sample only. No policy read, refresh, launch or attached-reference cleanup. */
    fun queryDisplay(context: Context, legacyLockIds: Set<String>?): JSONObject? {
        fun sample(): JSONObject {
            val screen = runCatching {
                val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return@runCatching null
                val displays = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager ?: return@runCatching null
                val display = displays.getDisplay(Display.DEFAULT_DISPLAY) ?: return@runCatching null
                when {
                    !power.isInteractive || display.state == Display.STATE_OFF -> false
                    display.state == Display.STATE_ON || display.state == Display.STATE_VR -> true
                    else -> null
                }
            }.getOrNull()
            val phone = runCatching {
                root?.let { it.isAttachedToWindow && it.isShown && it.hasWindowFocus() } == true ||
                    activity.get()?.let { !it.isFinishing && !it.isDestroyed && it.lockView.isAttachedToWindow &&
                        it.lockView.isShown && it.hasWindowFocus() } == true
            }.getOrNull()
            val app = runCatching { PhoneFocusOverlay.queryAppLockShown(legacyLockIds) }.getOrNull()
            return PhoneRestrictionQuery.display(System.currentTimeMillis(), screen, phone, app)
        }
        if (Looper.myLooper() == Looper.getMainLooper()) return runCatching { sample() }.getOrNull()
        val task = FutureTask { sample() }
        if (!handler.post(task)) return null
        return runCatching { task.get(5, TimeUnit.SECONDS) }.getOrNull()
    }

    /** A read has no refresh, launch or accounting side effect. Null required means no observation yet. */
    fun executionStatus(): JSONObject = onMain {
        val host = activity.get()?.takeUnless { it.isFinishing || it.isDestroyed }
        val required = appContext?.let { PhoneRestrictionRuntime.phoneBlockingRecords(it, packageName).isNotEmpty() }
        JSONObject()
            .put("required", required ?: JSONObject.NULL)
            .put("phoneOverlayAttached", root?.isAttachedToWindow == true)
            .put("phoneActivityAttached", host?.lockView?.isAttachedToWindow == true)
            .put("phoneWindowShowing", isShowing())
            .put("appOverlayShowing", PhoneFocusOverlay.isAppOverlayShowing())
            .put("legacyOverlayAttached", PhoneFocusOverlay.isLegacyOverlayAttached())
            .put("countdownAttached", PhoneFocusCountdown.isWindowAttached())
            .put("lastFailureCode", lastFailureCode.ifEmpty { null } ?: JSONObject.NULL)
            .put("lastFailureAt", lastFailureAt)
            .put("lastActivityAttemptAt", lastActivityAttemptAt)
    }

    fun dismissForRestriction(context: Context): Boolean = onMain {
        if (PhoneRestrictionRuntime.phoneBlockingRecords(context, packageName).isNotEmpty()) return@onMain false
        removeWindows()
    }

    fun dismissForRestore() = onMain { removeWindows() }

    private fun removeWindows(): Boolean {
        PhoneRestrictionChatSurface.hide()
        handler.removeCallbacks(deadlineReached)
        deadlineScheduled = 0L
        removeOverlay()
        val host = activity.get()
        if (host != null && !host.isFinishing) host.finish()
        // Finishing an Activity is asynchronous. Never acknowledge its attached window as gone.
        return root == null && (host == null || !host.lockView.isAttachedToWindow)
    }

    private fun removeOverlay() {
        root?.let { view ->
            runCatching { manager?.removeViewImmediate(view) }
            if (!view.isAttachedToWindow && view.parent == null) {
                root = null; manager = null; overlayOwner = null
            }
        }
    }

    private fun requestEmergency(context: Context) {
        if (emergencyPending || PhoneFocusRules.restorePaused) return
        emergencyPending = true
        val operationId = "local-emergency:" + UUID.randomUUID()
        Thread {
            val result = runCatching { PhoneRestrictionRuntime.emergency(context.applicationContext, operationId) }
            handler.post {
                emergencyPending = false
                if (result.isFailure) {
                    root?.status("应急操作失败，请重试")
                    activity.get()?.lockView?.status("应急操作失败，请重试")
                }
                PhoneRestrictionEmergencyNotification.update(context.applicationContext, System.currentTimeMillis())
            }
        }.start()
    }

    private fun openAllowedApp(context: Context, target: String) {
        if (PhoneFocusRules.restorePaused || target !in PhoneRestrictionRuntime.phoneAllowedPackages(context)) return
        if (PhoneRestrictionRuntime.phoneBlockingRecords(context, target).isNotEmpty()) return
        val intent = context.packageManager.getLaunchIntentForPackage(target) ?: return
        runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.onFailure {
            root?.status("应用未能打开")
            activity.get()?.lockView?.status("应用未能打开")
        }
        // Remain covered until the collector actually observes the allowed package.
    }
}
