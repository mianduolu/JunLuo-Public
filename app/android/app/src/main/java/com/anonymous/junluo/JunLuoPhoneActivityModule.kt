package com.anonymous.junluo

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.provider.Settings
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject

/**
 * React Native bridge module — exposes phone activity collection to JavaScript.
 *
 * Matches the interface expected by phoneActivityNative.ts:
 *   NativeModules.JunLuoPhoneActivity.startCollector(...) etc.
 */
class JunLuoPhoneActivityModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private var collectorWasRunningBeforeRestore = false

    init {
        activeReactContext = reactContext
    }

    override fun getName(): String = "JunLuoPhoneActivity"

    @ReactMethod
    fun getPhoneLockChatVisibility(promise: Promise) { promise.resolve(PhoneRestrictionChatSurface.isVisible()) }

    @ReactMethod
    fun setPhoneLockChatOwnerReady(ready: Boolean) { PhoneRestrictionChatSurface.ownerReady(ready) }

    override fun getConstants(): MutableMap<String, Any> {
        return hashMapOf(
            // Do not consume the persisted phone-guard launch request while the
            // Headless JS message task is booting. Only foreground JS should
            // consume it through consumePhoneGuardLaunchRequest().
            "initialLaunchRequest" to ""
        )
    }

    companion object {
        fun emitPhoneLockChatVisibility(visible: Boolean) {
            activeReactContext?.let { context -> runCatching {
                context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("junluoPhoneLockChatVisibility", visible)
            } }
        }
        private const val EVENT_PHONE_GUARD_LAUNCH = "junluoPhoneGuardLaunch"

        @Volatile
        private var activeReactContext: ReactApplicationContext? = null

        fun emitPhoneGuardLaunchIntent(intent: Intent?) {
            val targetScreen = intent?.getStringExtra("junluoTargetScreen")
            val initialRoute = intent?.getStringExtra("initialRoute")
            if (targetScreen != "chat" && initialRoute != "chat") return
            val context = activeReactContext ?: return
            val payload = Arguments.createMap().apply {
                putString("targetScreen", "chat")
                putString("source", intent.getStringExtra("junluoSource") ?: "phone-guard")
                putString("ruleId", intent.getStringExtra("junluoRuleId") ?: "")
                putString("triggerId", intent.getStringExtra("junluoTriggerId") ?: "")
                putDouble("createdAt", System.currentTimeMillis().toDouble())
            }
            runCatching {
                context
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(EVENT_PHONE_GUARD_LAUNCH, payload)
            }
        }
    }

    // ── getPermissionStatus ────────────────────────────────────────────

    @ReactMethod
    fun getPermissionStatus(promise: Promise) {
        try {
            val status = Arguments.createMap().apply {
                putBoolean("usageAccess", safePermissionCheck { hasUsageAccessPermission() })
                putBoolean("notificationListener", safePermissionCheck { hasNotificationListenerPermission() })
                putBoolean("accessibility", safePermissionCheck { hasAccessibilityPermission() })
                putBoolean("overlay", safePermissionCheck {
                    android.provider.Settings.canDrawOverlays(reactApplicationContext)
                })
                putBoolean("collectorRunning", PhoneActivityCollectorService.isRunning)
                putBoolean("windowSummaryEnabled", safePermissionCheck {
                    JunLuoAccessibilityService.isActive()
                })
                putDouble("pausedUntil", 0.0)
            }
            promise.resolve(status)
        } catch (e: Exception) {
            promise.reject("PERMISSION_STATUS_ERROR", e.message, e)
        }
    }

    /** Local technical status only; keep the legacy model-facing boolean API unchanged. */
    @ReactMethod
    fun getRestrictionExecutionStatus(promise: Promise) {
        try {
            val context = reactApplicationContext
            val permissions = JSONObject()
                .put("usageAccess", permissionRead { hasUsageAccessPermission() })
                .put("notificationListener", permissionRead { hasNotificationListenerPermission() })
                .put("accessibility", permissionRead { hasAccessibilityPermission() })
                .put("overlay", permissionRead { Settings.canDrawOverlays(context) })
            promise.resolve(JSONObject()
                .put("schemaVersion", 1)
                .put("checkedAt", System.currentTimeMillis())
                .put("restorePaused", PhoneFocusRules.restorePaused)
                .put("needs", PhoneRestrictionScheduler.executionNeeds(context))
                .put("permissions", permissions)
                .put("accessibilityConnected", JunLuoAccessibilityService.isActive())
                .put("collector", PhoneActivityCollectorService.executionStatus())
                .put("window", PhoneRestrictionWindow.executionStatus())
                .toString())
        } catch (e: Exception) {
            promise.reject("RESTRICTION_EXECUTION_STATUS_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun refreshRestrictionExecution(promise: Promise) {
        try {
            PhoneRestrictionScheduler.recover(reactApplicationContext)
            promise.resolve(PhoneActivityCollectorService.isRunning)
        } catch (e: Exception) {
            promise.reject("RESTRICTION_EXECUTION_REFRESH_ERROR", e.message, e)
        }
    }

    // ── Settings launchers ─────────────────────────────────────────────

    @ReactMethod
    fun openUsageAccessSettings() {
        val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivitySafe(intent)
    }

    @ReactMethod
    fun openAccessibilitySettings() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivitySafe(intent)
    }

    @ReactMethod
    fun openOverlaySettings() {
        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            android.net.Uri.parse("package:${reactApplicationContext.packageName}")
        ).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        startActivitySafe(intent)
    }

    @ReactMethod
    fun openNotificationListenerSettings() {
        val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivitySafe(intent)
    }

    // ── Collector control ──────────────────────────────────────────────

    @ReactMethod
    fun startCollector(promise: Promise) {
        try {
            if (!hasUsageAccessPermission()) {
                promise.reject("NO_PERMISSION", "PACKAGE_USAGE_STATS permission not granted")
                return
            }
            val intent = Intent(reactApplicationContext, PhoneActivityCollectorService::class.java).apply {
                action = PhoneActivityCollectorService.ACTION_START
            }
            promise.resolve(PhoneActivityCollectorService.requestStart(reactApplicationContext, intent))
        } catch (e: Exception) {
            promise.reject("START_COLLECTOR_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun quiesceCollectorForRestore(promise: Promise) {
        try {
            collectorWasRunningBeforeRestore = PhoneActivityCollectorService.isRunning
            PhoneRestrictionRuntime.freezeForRestore(reactApplicationContext)
            if (!PhoneFocusRules.clearCareFollowUpForRestore(reactApplicationContext)) {
                throw IllegalStateException("Phone care follow-up restore reset failed")
            }
            if (!BodySignalCareStore.resetForRestore(reactApplicationContext)) {
                throw IllegalStateException("Body signal care restore reset failed")
            }
            BodySignalGuardianService.refreshCareWake(reactApplicationContext)
            PhoneFocusOverlay.dismiss(reactApplicationContext)
            PhoneActivityReporter.quiesceForRestore()
            reactApplicationContext.stopService(
                Intent(reactApplicationContext, PhoneActivityCollectorService::class.java)
            )
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("QUIESCE_COLLECTOR_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun discardPhoneActivityLogsForRestore(promise: Promise) {
        try {
            val restrictionsDiscarded = PhoneRestrictionRuntime.discardForRestore(reactApplicationContext)
            promise.resolve(restrictionsDiscarded && PhoneActivityReporter.discardForRestore(reactApplicationContext))
        } catch (e: Exception) {
            promise.reject("DISCARD_PHONE_ACTIVITY_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun resumeCollectorAfterRestore(promise: Promise) {
        try {
            PhoneActivityReporter.resumeAfterRestore()
            PhoneFocusRules.setRestorePaused(false)
            PhoneRestrictionRuntime.reconcilePlans(reactApplicationContext)
            if (collectorWasRunningBeforeRestore) {
                val intent = Intent(reactApplicationContext, PhoneActivityCollectorService::class.java).apply {
                    action = PhoneActivityCollectorService.ACTION_START
                }
                if (!PhoneActivityCollectorService.requestStart(reactApplicationContext, intent)) {
                    throw IllegalStateException("Collector restart request failed")
                }
            }
            PhoneRestrictionScheduler.recover(reactApplicationContext)
            collectorWasRunningBeforeRestore = false
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("RESUME_COLLECTOR_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopCollector(promise: Promise) {
        try {
            val intent = Intent(reactApplicationContext, PhoneActivityCollectorService::class.java).apply {
                action = PhoneActivityCollectorService.ACTION_STOP
            }
            reactApplicationContext.startService(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("STOP_COLLECTOR_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun reconcileCollectorRequirement(promise: Promise) {
        try { promise.resolve(PhoneRestrictionScheduler.reconcileCollectorRequirement(reactApplicationContext)) }
        catch (failure: Exception) { promise.reject("COLLECTOR_RECONCILE_ERROR", failure.message, failure) }
    }

    // ── Debug ──────────────────────────────────────────────────────────

    @ReactMethod
    fun getFocusDebugStatus(promise: Promise) {
        val lines = mutableListOf<String>()
        lines.add("JunLuoPhoneActivity local-first")
        lines.add("collectorRunning=${PhoneActivityCollectorService.isRunning}")
        lines.add("usageAccess=${hasUsageAccessPermission()}")
        lines.add("notificationListener=${hasNotificationListenerPermission()}")
        lines.add("accessibility=${hasAccessibilityPermission()}")
        lines.add("accessibilityActive=${JunLuoAccessibilityService.isActive()}")
        lines.add("overlay=${Settings.canDrawOverlays(reactApplicationContext)}")
        lines.add("sdkInt=${Build.VERSION.SDK_INT}")
        lines.add(PhoneActivityCollectorService.getTimingDebugStatus())
        promise.resolve(lines.joinToString("\n"))
    }

    @ReactMethod
    fun getPhoneActivityLogs(sinceMs: Double, limit: Int, promise: Promise) {
        try {
            promise.resolve(
                PhoneActivityReporter.queryLogsJson(
                    reactApplicationContext,
                    sinceMs.toLong(),
                    limit
                )
            )
        } catch (e: Exception) {
            promise.reject("READ_PHONE_ACTIVITY_ERROR", e.message, e)
        }
    }

    /** System event reconstruction is only for the local statistics display, not the focus rules. */
    @ReactMethod
    fun getOwnAppUsageStats(days: Int, promise: Promise) {
        val context = reactApplicationContext
        val result = JSONObject().put("available", false).put("source", context.packageName)
            .put("title", "君落").put("days", JSONArray())
        try {
            if (!hasUsageAccessPermission()) {
                promise.resolve(result.put("reason", "USAGE_ACCESS_REQUIRED").toString())
                return
            }
            val manager = context.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
                ?: throw IllegalStateException("USAGE_STATS_UNAVAILABLE")
            val now = System.currentTimeMillis()
            val count = days.coerceIn(1, 14)
            val since = PhoneOwnUsageSummary.previousDay(now, count)
            val queried = manager.queryEvents(since, now)
                ?: throw IllegalStateException("SYSTEM_HISTORY_UNAVAILABLE")
            val events = mutableListOf<PhoneOwnUsageEvent>()
            val event = UsageEvents.Event()
            while (queried.hasNextEvent()) {
                queried.getNextEvent(event)
                val kind = when (event.eventType) {
                    15 -> PhoneOwnUsageEventKind.SCREEN_ON
                    16 -> PhoneOwnUsageEventKind.SCREEN_OFF
                    26 -> PhoneOwnUsageEventKind.SHUTDOWN
                    27 -> PhoneOwnUsageEventKind.STARTUP
                    else -> if (event.packageName != context.packageName) null else when (event.eventType) {
                        1 -> PhoneOwnUsageEventKind.RESUME
                        2 -> PhoneOwnUsageEventKind.PAUSE
                        23 -> PhoneOwnUsageEventKind.STOPPED
                        else -> null
                    }
                }
                if (kind != null) events.add(PhoneOwnUsageEvent(event.timeStamp, kind, event.className.orEmpty()))
            }
            val summary = PhoneOwnUsageSummary.summarize(events, count, now)
            val output = JSONArray()
            summary.days.forEach { output.put(JSONObject().put("dateKey", it.dateKey).put("durationMs", it.durationMs)) }
            result.put("available", summary.days.isNotEmpty()).put("days", output)
                .put("title", context.packageManager.getApplicationLabel(context.applicationInfo).toString())
            summary.reason?.let { result.put("reason", it) }
            promise.resolve(result.toString())
        } catch (failure: Exception) {
            promise.resolve(result.put("available", false).put("days", JSONArray())
                .put("reason", "SYSTEM_USAGE_READ_FAILED").toString())
        }
    }

    @ReactMethod
    fun getPhoneActivityLogsPageForRestore(
        afterCreatedAt: Double,
        afterId: String,
        limit: Int,
        promise: Promise
    ) {
        try {
            promise.resolve(
                PhoneActivityReporter.queryLogsPageForRestoreJson(
                    reactApplicationContext,
                    afterCreatedAt.toLong(),
                    afterId,
                    limit
                )
            )
        } catch (e: Exception) {
            promise.reject("READ_PHONE_ACTIVITY_RESTORE_PAGE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getAccessibilitySnapshot(maxNodes: Int, promise: Promise) {
        promise.resolve(JunLuoAccessibilityService.snapshot(maxNodes))
    }

    @ReactMethod
    fun clickAccessibilityText(text: String, promise: Promise) {
        promise.resolve(JunLuoAccessibilityService.clickText(text))
    }

    @ReactMethod
    fun inputAccessibilityText(text: String, promise: Promise) {
        promise.resolve(JunLuoAccessibilityService.input(text))
    }

    @ReactMethod
    fun scrollAccessibilityWindow(direction: String, promise: Promise) {
        promise.resolve(JunLuoAccessibilityService.scroll(direction))
    }

    @ReactMethod
    fun performAccessibilityBack(promise: Promise) {
        promise.resolve(JunLuoAccessibilityService.back())
    }

    @ReactMethod
    fun tapAccessibilityPoint(x: Int, y: Int, promise: Promise) {
        promise.resolve(JunLuoAccessibilityService.tap(x, y))
    }

    @ReactMethod
    fun swipeAccessibilityPoint(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Int, promise: Promise) {
        promise.resolve(JunLuoAccessibilityService.swipe(startX, startY, endX, endY, durationMs.toLong()))
    }

    @ReactMethod
    fun getLaunchableAppEntries(promise: Promise) {
        promise.resolve(AppLaunchEntries.list(reactApplicationContext))
    }

    @ReactMethod
    fun queryDialerContacts(name: String, promise: Promise) {
        promise.resolve(DialerContacts.query(reactApplicationContext, name))
    }

    @ReactMethod
    fun openDialer(number: String, binding: ReadableMap?, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            promise.resolve(DialerContacts.open(reactApplicationContext, reactApplicationContext.currentActivity, number, binding))
        }
    }

    @ReactMethod
    fun launchAppEntry(input: ReadableMap, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            promise.resolve(AppLaunchEntries.launch(reactApplicationContext, reactApplicationContext.currentActivity, input))
        }
    }

    @ReactMethod
    fun launchInstalledApp(packageName: String, promise: Promise) {
        try {
            val intent = reactApplicationContext.packageManager.getLaunchIntentForPackage(packageName)
            if (intent == null) {
                promise.resolve(JSONObject().put("ok", false).put("reason", "APP_NOT_FOUND").toString())
                return
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactApplicationContext.startActivity(intent)
            promise.resolve(JSONObject().put("ok", true).put("reason", "LAUNCHED").toString())
        } catch (e: Exception) {
            promise.resolve(JSONObject().put("ok", false).put("reason", e.message ?: "LAUNCH_FAILED").toString())
        }
    }

    @ReactMethod
    fun runXiaohongshuBrowseAutomation(packageName: String, promise: Promise) {
        Thread {
            try {
                val launch = launchPackageForAutomation(packageName)
                if (!launch.optBoolean("ok")) {
                    promise.resolve(launch.toString())
                    return@Thread
                }

                var snapshot = waitForPackage(packageName, 9000L)
                if (!snapshot.optBoolean("ok") && !isExpectedPackage(snapshot.optString("packageName"), packageName)) {
                    promise.resolve(
                        JSONObject()
                            .put("ok", false)
                            .put("reason", "FOREGROUND_TIMEOUT")
                            .put("packageName", snapshot.optString("packageName", "unknown"))
                            .put("snapshot", snapshot)
                            .toString()
                    )
                    return@Thread
                }

                val adResult = passLaunchAdGuard(packageName)
                snapshot = waitForPackage(packageName, 2500L)
                val pageBefore = classifyXiaohongshuPage(snapshot)
                val pageReady = if (pageBefore == "HOME_FEED" || pageBefore == "NOTE_DETAIL") {
                    JSONObject().put("ok", true).put("page", pageBefore).put("reason", "PAGE_READY")
                } else {
                    navigateToHomeFeed(packageName)
                }
                snapshot = JSONObject(JunLuoAccessibilityService.snapshot(140))
                val pageForAction = classifyXiaohongshuPage(snapshot)
                var movedCount = 0
                var openResult = if (pageForAction == "NOTE_DETAIL") {
                    JSONObject().put("opened", true).put("reason", "ALREADY_IN_NOTE_DETAIL")
                } else if (pageForAction == "HOME_FEED") {
                    openFirstVisibleNote(packageName)
                } else {
                    JSONObject().put("opened", false).put("reason", "PAGE_NOT_BROWSABLE_$pageForAction")
                }
                if (!openResult.optBoolean("opened") && pageForAction == "HOME_FEED") {
                    for (index in 0 until 2) {
                        if (performVisibleScroll(packageName)) movedCount += 1
                        sleepQuietly(if (index == 0) 1050L else 1200L)
                        openResult = openFirstVisibleNote(packageName)
                        if (openResult.optBoolean("opened")) break
                    }
                }
                var readSnapshot = JSONObject(JunLuoAccessibilityService.snapshot(150))
                if (openResult.optBoolean("opened")) {
                    sleepQuietly(850L)
                    readSnapshot = JSONObject(JunLuoAccessibilityService.snapshot(150))
                    repeat(3) { index ->
                        if (performVisibleScroll(packageName)) movedCount += 1
                        sleepQuietly(if (index == 0) 1750L else 1850L)
                    }
                    readSnapshot = JSONObject(JunLuoAccessibilityService.snapshot(150))
                    val pageBeforeReturn = classifyXiaohongshuPage(readSnapshot)
                    if (pageBeforeReturn == "NOTE_DETAIL") {
                        JunLuoAccessibilityService.back()
                        sleepQuietly(900L)
                    }
                } else {
                    repeat(3) { index ->
                        if (performVisibleScroll(packageName)) movedCount += 1
                        sleepQuietly(if (index == 0) 1650L else 1750L)
                    }
                    readSnapshot = JSONObject(JunLuoAccessibilityService.snapshot(150))
                }
                snapshot = JSONObject(JunLuoAccessibilityService.snapshot(130))
                val pageAfter = classifyXiaohongshuPage(snapshot)
                val returnedHome = pageAfter == "HOME_FEED"
                val ok = movedCount > 0
                val returnResult = launchPackageForAutomation(reactApplicationContext.packageName)
                promise.resolve(
                    JSONObject()
                        .put("ok", ok)
                        .put("reason", if (ok) "BROWSE_DONE" else "GESTURE_NOT_DISPATCHED")
                        .put("packageName", snapshot.optString("packageName", "unknown"))
                        .put("movedCount", movedCount)
                        .put("adSkipped", adResult.optBoolean("skipped"))
                        .put("openedNote", openResult.optBoolean("opened"))
                        .put("openReason", openResult.optString("reason"))
                        .put("pageBefore", pageBefore)
                        .put("pageReady", pageReady)
                        .put("pageForAction", pageForAction)
                        .put("pageAfter", pageAfter)
                        .put("readSnapshot", readSnapshot)
                        .put("returnedToJunLuo", returnResult.optBoolean("ok"))
                        .put("returnedHome", returnedHome)
                        .put("snapshot", snapshot)
                        .toString()
                )
            } catch (e: Exception) {
                promise.resolve(JSONObject().put("ok", false).put("reason", e.message ?: "NATIVE_BROWSE_FAILED").toString())
            }
        }.start()
    }

    // ── Stub methods — return safe defaults so TS doesn't crash ───────

    @ReactMethod
    fun canDrawOverlays(promise: Promise) {
        promise.resolve(android.provider.Settings.canDrawOverlays(reactApplicationContext))
    }

    @ReactMethod
    fun consumeLastFocusOverlayExit(promise: Promise) {
        val exit = PhoneFocusRules.consumeOverlayExit(reactApplicationContext)
        if (exit == null) {
            promise.resolve(null)
            return
        }
        promise.resolve(Arguments.createMap().apply {
            putString("ruleId", exit.optString("ruleId"))
            putDouble("exitedAt", exit.optLong("exitedAt").toDouble())
        })
    }

    @ReactMethod
    fun consumePendingFocusTrigger(promise: Promise) {
        promise.resolve(PhoneFocusRules.consumePendingTrigger(reactApplicationContext))
    }

    @ReactMethod
    fun peekPendingFocusTrigger(promise: Promise) {
        promise.resolve(PhoneFocusRules.peekPendingTrigger(reactApplicationContext))
    }

    @ReactMethod
    fun clearPendingFocusTrigger(triggerId: String, promise: Promise) {
        promise.resolve(PhoneFocusRules.clearPendingTrigger(reactApplicationContext, triggerId))
    }

    @ReactMethod
    fun getFocusTriggerState(triggerId: String, promise: Promise) {
        promise.resolve(PhoneFocusRules.getTriggerState(reactApplicationContext, triggerId))
    }

    @ReactMethod
    fun getPhoneCareFollowUp(promise: Promise) {
        promise.resolve(PhoneFocusRules.getCareFollowUp(reactApplicationContext))
    }

    @ReactMethod
    fun compareAndSetPhoneCareFollowUp(expectedRevision: Double, valueJson: String, promise: Promise) {
        if (!expectedRevision.isFinite() || expectedRevision != expectedRevision.toLong().toDouble()) {
            promise.resolve(false)
            return
        }
        promise.resolve(PhoneFocusRules.compareAndSetCareFollowUp(reactApplicationContext, expectedRevision.toLong(), valueJson))
    }

    @ReactMethod
    fun releasePhoneCareFollowUpDispatch(promise: Promise) {
        promise.resolve(PhoneGuardMessageTaskService.releaseCareDispatch())
    }

    @ReactMethod
    fun getPhoneCareUsageSnapshot(promise: Promise) {
        promise.resolve(PhoneActivityCollectorService.getCareUsageSnapshot())
    }

    @ReactMethod
    fun claimFocusTriggerAttempt(triggerId: String, promise: Promise) {
        promise.resolve(PhoneFocusRules.claimTriggerAttempt(reactApplicationContext, triggerId))
    }

    @ReactMethod
    fun finishFocusTrigger(triggerId: String, status: String, promise: Promise) {
        promise.resolve(PhoneFocusRules.finishTrigger(reactApplicationContext, triggerId, status))
    }

    @ReactMethod
    fun updateFocusOverlayMessageForTrigger(ruleId: String, triggerId: String, message: String, promise: Promise) {
        promise.resolve(PhoneFocusOverlay.updateMessageForTrigger(reactApplicationContext, ruleId, triggerId, message))
    }

    @ReactMethod
    fun consumePhoneGuardLaunchRequest(promise: Promise) {
        promise.resolve(PhoneFocusRules.consumeLaunchRequest(reactApplicationContext))
    }

    @ReactMethod
    fun getInstalledApps(promise: Promise) {
        try {
            val launchIntent = Intent(Intent.ACTION_MAIN, null).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            val apps = reactApplicationContext.packageManager.queryIntentActivities(launchIntent, 0)
                .mapNotNull { info ->
                    val packageName = info.activityInfo?.packageName ?: return@mapNotNull null
                    val title = info.loadLabel(reactApplicationContext.packageManager)?.toString() ?: packageName
                    packageName to title
                }
                .distinctBy { it.first }
                .sortedBy { it.second }
            val array = Arguments.createArray()
            apps.forEach { (source, title) ->
                array.pushMap(Arguments.createMap().apply {
                    putString("source", source)
                    putString("title", title)
                })
            }
            promise.resolve(array)
        } catch (e: Exception) {
            promise.reject("GET_INSTALLED_APPS_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun setFocusRules(settingsJson: String, promise: Promise) {
        promise.resolve(PhoneFocusRules.saveSettings(reactApplicationContext, settingsJson))
    }

    @ReactMethod
    fun setPausedUntil(pausedUntil: Double, promise: Promise) {
        promise.resolve(true)
    }

    @ReactMethod
    fun getPhoneRestrictionState(promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.snapshot(reactApplicationContext)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_READ_FAILED", e.message, e) }
    }

    @ReactMethod
    fun getPhoneRestrictionUsage(promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.usageSnapshot(reactApplicationContext)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_USAGE", e.message, e) }
    }

    @ReactMethod
    fun getPhoneRestrictionQuery(promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.query(reactApplicationContext)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_QUERY", e.message, e) }
    }

    @ReactMethod
    fun getPhoneRestrictionUsageLogs(sinceMs: Double, limit: Int, promise: Promise) {
        val since = if (sinceMs.isFinite() && sinceMs % 1.0 == 0.0 && sinceMs in 0.0..9_007_199_254_740_991.0)
            sinceMs.toLong() else -1L
        try { promise.resolve(PhoneActivityReporter.queryRestrictionLogsReadOnly(reactApplicationContext, since, limit)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_LOGS", e.message, e) }
    }

    @ReactMethod
    fun setPhoneRestrictionDurations(durationsJson: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.configureDurations(reactApplicationContext, durationsJson)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_SAVE_FAILED", e.message, e) }
    }

    @ReactMethod
    fun setPhoneRestrictionConfiguration(json: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.configure(reactApplicationContext, json)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_CONFIGURATION_FAILED", e.message, e) }
    }

    @ReactMethod
    fun putPhoneRestrictionPlan(json: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.putPlan(reactApplicationContext, json)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_PLAN_SAVE_FAILED", e.message, e) }
    }

    @ReactMethod
    fun deletePhoneRestrictionPlan(json: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.deletePlan(reactApplicationContext, json)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_PLAN_DELETE_FAILED", e.message, e) }
    }

    @ReactMethod
    fun setPhoneRestrictionPlanEnabled(id: String, enabled: Boolean, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.setPlanEnabled(reactApplicationContext, id, enabled)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_PLAN_TOGGLE_FAILED", e.message, e) }
    }

    @ReactMethod
    fun setPhoneRestrictionPaused(paused: Boolean, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.setPaused(reactApplicationContext, paused)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_PAUSE_FAILED", e.message, e) }
    }

    @ReactMethod
    fun setPhoneRestrictionAppTimeRules(json: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.setAppTimeRules(reactApplicationContext, json)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_APP_TIMES_FAILED", e.message, e) }
    }

    @ReactMethod
    fun startPhoneRestrictionInstance(json: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.start(reactApplicationContext, json)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_START_FAILED", e.message, e) }
    }

    @ReactMethod
    fun shortenPhoneRestrictionInstance(json: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.shorten(reactApplicationContext, json)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_SHORTEN_FAILED", e.message, e) }
    }

    @ReactMethod
    fun endPhoneRestrictionInstance(json: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.end(reactApplicationContext, json)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_END_FAILED", e.message, e) }
    }

    @ReactMethod
    fun releasePhoneRestrictionApp(json: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.releaseApp(reactApplicationContext, json)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_RELEASE_FAILED", e.message, e) }
    }

    @ReactMethod
    fun startPhoneRestrictionInstanceForI(json: String, promise: Promise) {
        promise.resolve(PhoneRestrictionRuntime.startForI(reactApplicationContext, json))
    }

    @ReactMethod
    fun shortenPhoneRestrictionInstanceForI(json: String, promise: Promise) {
        promise.resolve(PhoneRestrictionRuntime.shortenForI(reactApplicationContext, json))
    }

    @ReactMethod
    fun endPhoneRestrictionInstanceForI(json: String, promise: Promise) {
        promise.resolve(PhoneRestrictionRuntime.endForI(reactApplicationContext, json))
    }

    @ReactMethod
    fun releasePhoneRestrictionAppForI(json: String, promise: Promise) {
        promise.resolve(PhoneRestrictionRuntime.releaseAppForI(reactApplicationContext, json))
    }

    @ReactMethod
    fun validatePhoneRestrictionPlanForI(json: String, promise: Promise) {
        promise.resolve(PhoneRestrictionRuntime.validatePlanForI(reactApplicationContext, json))
    }

    @ReactMethod
    fun putPhoneRestrictionPlanForI(json: String, promise: Promise) {
        promise.resolve(PhoneRestrictionRuntime.putPlanForI(reactApplicationContext, json))
    }

    @ReactMethod
    fun startPhoneRestrictionEmergency(operationId: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.emergency(reactApplicationContext, operationId)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_EMERGENCY_FAILED", e.message, e) }
    }

    @ReactMethod
    fun extendPhoneRestrictionEmergency(emergencyId: String, operationId: String, promise: Promise) {
        try { promise.resolve(PhoneRestrictionRuntime.emergency(reactApplicationContext, operationId, emergencyId)) }
        catch (e: Exception) { promise.reject("PHONE_RESTRICTION_EXTENSION_FAILED", e.message, e) }
    }

    @ReactMethod
    fun setWindowSummaryEnabled(enabled: Boolean, promise: Promise) {
        promise.resolve(true)
    }

    @ReactMethod
    fun showFocusOverlay(
        resourceName: String,
        stage: Int,
        message: String,
        ruleId: String,
        promise: Promise
    ) {
        promise.resolve(PhoneFocusOverlay.show(reactApplicationContext, resourceName, stage, message, ruleId))
    }

    @ReactMethod
    fun updateFocusOverlayMessage(ruleId: String, message: String, promise: Promise) {
        promise.resolve(PhoneFocusOverlay.updateMessage(reactApplicationContext, ruleId, message))
    }

    @ReactMethod
    fun startPhoneGuardMessageTask(payloadJson: String, promise: Promise) {
        try {
            val ruleId = JSONObject(payloadJson).optString("ruleId")
            promise.resolve(PhoneFocusOverlay.startMessageTask(reactApplicationContext, ruleId, payloadJson))
        } catch (e: Exception) {
            promise.reject("PHONE_GUARD_TASK_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun dismissFocusOverlay(promise: Promise) {
        PhoneFocusOverlay.dismiss(reactApplicationContext)
        promise.resolve(true)
    }

    // ── Helpers ────────────────────────────────────────────────────────

    private inline fun safePermissionCheck(check: () -> Boolean): Boolean {
        return runCatching(check).getOrDefault(false)
    }

    private inline fun permissionRead(check: () -> Boolean): Any =
        runCatching(check).getOrNull() ?: JSONObject.NULL

    private fun hasUsageAccessPermission(): Boolean {
        val appOps = reactApplicationContext.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager
            ?: throw IllegalStateException("APP_OPS_UNAVAILABLE")
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                reactApplicationContext.packageName
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                reactApplicationContext.packageName
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun hasNotificationListenerPermission(): Boolean {
        val enabled = Settings.Secure.getString(
            reactApplicationContext.contentResolver,
            "enabled_notification_listeners"
        ) ?: return false
        val expected = ComponentName(
            reactApplicationContext,
            JunLuoNotificationListenerService::class.java
        )
        return enabled.split(':')
            .mapNotNull(ComponentName::unflattenFromString)
            .any { it == expected }
    }

    private fun hasAccessibilityPermission(): Boolean {
        val enabled = Settings.Secure.getInt(
            reactApplicationContext.contentResolver,
            Settings.Secure.ACCESSIBILITY_ENABLED,
            0
        ) == 1
        if (!enabled) return false
        val services = Settings.Secure.getString(
            reactApplicationContext.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val expected = ComponentName(reactApplicationContext, JunLuoAccessibilityService::class.java)
        return services.split(':')
            .mapNotNull(ComponentName::unflattenFromString)
            .any { it == expected }
    }

    private fun startActivitySafe(intent: Intent) {
        val activity = reactApplicationContext.currentActivity
        if (activity != null) {
            activity.startActivity(intent)
        } else {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactApplicationContext.startActivity(intent)
        }
    }

    private fun launchPackageForAutomation(packageName: String): JSONObject {
        return try {
            val intent = reactApplicationContext.packageManager.getLaunchIntentForPackage(packageName)
                ?: return JSONObject().put("ok", false).put("reason", "APP_NOT_FOUND")
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactApplicationContext.startActivity(intent)
            JSONObject().put("ok", true).put("reason", "LAUNCHED")
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("reason", e.message ?: "LAUNCH_FAILED")
        }
    }

    private fun waitForPackage(packageName: String, timeoutMs: Long): JSONObject {
        val startedAt = System.currentTimeMillis()
        var last = JSONObject().put("ok", false).put("reason", "NO_SNAPSHOT")
        while (System.currentTimeMillis() - startedAt < timeoutMs) {
            sleepQuietly(450L)
            last = JSONObject(JunLuoAccessibilityService.snapshot(80))
            if (last.optBoolean("ok") && isExpectedPackage(last.optString("packageName"), packageName)) return last
            if (isForegroundPackage(packageName)) {
                return last
                    .put("ok", true)
                    .put("reason", "FOREGROUND_BY_USAGE_STATS")
                    .put("packageName", packageName)
            }
        }
        if (isForegroundPackage(packageName)) {
            return last
                .put("ok", true)
                .put("reason", "FOREGROUND_BY_USAGE_STATS")
                .put("packageName", packageName)
        }
        return last
    }

    private fun passLaunchAdGuard(packageName: String): JSONObject {
        val startedAt = System.currentTimeMillis()
        var skipped = false
        var coordinateTried = false
        val skipLabels = listOf("跳过", "跳过广告", "关闭广告", "关闭", "Skip", "×")
        while (System.currentTimeMillis() - startedAt < 6500L) {
            val snapshot = JSONObject(JunLuoAccessibilityService.snapshot(90))
            if (!snapshot.optBoolean("ok") || !isExpectedPackage(snapshot.optString("packageName"), packageName)) {
                sleepQuietly(450L)
                continue
            }
            val text = snapshotText(snapshot)
            val page = classifyXiaohongshuPage(snapshot)
            if (Regex("跳过|广告|赞助|推广|Skip", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
                skipLabels.any { label ->
                    val result = JSONObject(JunLuoAccessibilityService.clickText(label))
                    skipped = result.optBoolean("ok")
                    skipped
                }
            } else if (!coordinateTried &&
                System.currentTimeMillis() - startedAt > 5200L &&
                text.length < 40 &&
                page !in listOf("HOME_FEED", "NOTE_DETAIL", "SEARCH", "PROFILE", "MESSAGE", "COMPOSER")
            ) {
                coordinateTried = true
                val result = JSONObject(JunLuoAccessibilityService.tap(1006, 126))
                skipped = result.optBoolean("ok")
            }
            sleepQuietly(if (skipped) 900L else 600L)
        }
        return JSONObject().put("skipped", skipped)
    }

    private fun openFirstVisibleNote(packageName: String): JSONObject {
        val before = JSONObject(JunLuoAccessibilityService.snapshot(80))
        if ((!before.optBoolean("ok") || !isExpectedPackage(before.optString("packageName"), packageName)) && !isForegroundPackage(packageName)) {
            return JSONObject().put("opened", false).put("reason", "NOT_IN_APP")
        }

        val nodeClick = JSONObject(JunLuoAccessibilityService.clickFeedCard())
        if (nodeClick.optBoolean("ok")) {
            sleepQuietly(1700L)
            var after = JSONObject(JunLuoAccessibilityService.snapshot(120))
            var page = classifyXiaohongshuPage(after)
            if (page == "NOTE_DETAIL") {
                return JSONObject().put("opened", true).put("reason", "OPENED_BY_FEED_NODE")
            }
            if (after.optBoolean("ok") && isExpectedPackage(after.optString("packageName"), packageName) && canSafelyBackFrom(page)) {
                JunLuoAccessibilityService.back()
                sleepQuietly(650L)
            }
        }

        val tapCandidates = listOf(
            Triple(225, 720, "LEFT_CARD_IMAGE"),
            Triple(675, 720, "RIGHT_CARD_IMAGE"),
            Triple(225, 900, "LEFT_CARD_TITLE"),
            Triple(675, 900, "RIGHT_CARD_TITLE"),
            Triple(225, 1180, "LEFT_SECOND_IMAGE"),
            Triple(675, 1180, "RIGHT_SECOND_IMAGE"),
            Triple(225, 1450, "LEFT_SECOND_TITLE"),
            Triple(675, 1450, "RIGHT_SECOND_TITLE"),
            Triple(225, 520, "LEFT_TOP_IMAGE"),
            Triple(675, 520, "RIGHT_TOP_IMAGE")
        )
        for ((x, y, label) in tapCandidates) {
            JunLuoAccessibilityService.tap(x, y)
            sleepQuietly(1700L)
            val after = JSONObject(JunLuoAccessibilityService.snapshot(120))
            val page = classifyXiaohongshuPage(after)
            if (page == "NOTE_DETAIL") return JSONObject().put("opened", true).put("reason", "OPENED_$label")
            if (after.optBoolean("ok") && isExpectedPackage(after.optString("packageName"), packageName) && canSafelyBackFrom(page)) {
                JunLuoAccessibilityService.back()
                sleepQuietly(650L)
            }
        }

        return JSONObject()
            .put("opened", false)
            .put("reason", "DETAIL_NOT_DETECTED")
            .put("nodeClick", nodeClick.optString("reason"))
    }

    private fun navigateToHomeFeed(packageName: String): JSONObject {
        var snapshot = JSONObject(JunLuoAccessibilityService.snapshot(120))
        var page = classifyXiaohongshuPage(snapshot)
        if (page == "HOME_FEED") return JSONObject().put("ok", true).put("page", page).put("reason", "ALREADY_HOME")

        val homeClick = JSONObject(JunLuoAccessibilityService.clickText("首页"))
        sleepQuietly(900L)
        snapshot = JSONObject(JunLuoAccessibilityService.snapshot(120))
        page = classifyXiaohongshuPage(snapshot)
        if (page == "HOME_FEED") {
            return JSONObject().put("ok", true).put("page", page).put("reason", "CLICKED_HOME_TAB")
        }

        repeat(2) {
            if (canSafelyBackFrom(page) && !hasHomeFeedChrome(snapshot)) {
                JunLuoAccessibilityService.back()
                sleepQuietly(850L)
                snapshot = JSONObject(JunLuoAccessibilityService.snapshot(120))
                page = classifyXiaohongshuPage(snapshot)
            }
        }
        return JSONObject()
            .put("ok", page == "HOME_FEED")
            .put("page", page)
            .put("reason", if (page == "HOME_FEED") "BACK_TO_HOME" else "HOME_NOT_FOUND")
            .put("homeClick", homeClick.optString("reason"))
            .put("packageName", snapshot.optString("packageName", packageName))
    }

    private fun performVisibleScroll(packageName: String): Boolean {
        val before = JSONObject(JunLuoAccessibilityService.snapshot(80))
        val page = classifyXiaohongshuPage(before)
        if (!before.optBoolean("ok") || !isExpectedPackage(before.optString("packageName"), packageName) || page in listOf("OTHER_APP", "UNAVAILABLE")) {
            return false
        }
        val scroll = JSONObject(JunLuoAccessibilityService.scroll("forward"))
        if (scroll.optBoolean("ok")) return true
        sleepQuietly(220L)
        val firstSwipe = JSONObject(JunLuoAccessibilityService.swipe(540, 2050, 540, 280, 1150))
        sleepQuietly(180L)
        val secondSwipe = JSONObject(JunLuoAccessibilityService.swipe(540, 1840, 540, 420, 980))
        return firstSwipe.optBoolean("ok") || secondSwipe.optBoolean("ok")
    }

    private fun looksLikeNoteDetail(snapshot: JSONObject): Boolean {
        if (!snapshot.optBoolean("ok")) return false
        return classifyXiaohongshuPage(snapshot) == "NOTE_DETAIL"
    }

    private fun looksLikeHomeFeed(snapshot: JSONObject): Boolean {
        if (!snapshot.optBoolean("ok")) return false
        return classifyXiaohongshuPage(snapshot) == "HOME_FEED"
    }

    private fun canSafelyBackFrom(page: String): Boolean {
        return page in listOf("NOTE_DETAIL", "SEARCH", "PROFILE", "MESSAGE")
    }

    private fun hasHomeFeedChrome(snapshot: JSONObject): Boolean {
        if (!snapshot.optBoolean("ok")) return false
        val text = snapshotText(snapshot)
        val hasBottomTabs = Regex("首页|市集|消息|我").containsMatchIn(text)
        val hasTopFeedTabs = Regex("关注|发现|同城").containsMatchIn(text)
        return hasBottomTabs && hasTopFeedTabs
    }

    private fun classifyXiaohongshuPage(snapshot: JSONObject): String {
        if (!snapshot.optBoolean("ok")) return "UNAVAILABLE"
        val text = snapshotText(snapshot)
        val compact = text.replace("\\s+".toRegex(), "")
        val hasBottomTabs = Regex("首页|市集|消息|我").containsMatchIn(text)
        val hasTopFeedTabs = Regex("关注|发现|同城").containsMatchIn(text)
        val hasFeedContent = Regex("推荐|笔记|直播|赞").containsMatchIn(text)
        if (Regex("发布笔记|添加标题|这一刻的想法|下一步|存草稿|谁可以看", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
            return "COMPOSER"
        }
        if ((hasBottomTabs && hasTopFeedTabs) || (hasTopFeedTabs && hasFeedContent)) {
            return "HOME_FEED"
        }
        if (Regex("搜索小红书|猜你想搜|历史记录|综合|最热|最新|筛选", RegexOption.IGNORE_CASE).containsMatchIn(text)
            && !hasBottomTabs
            && !hasTopFeedTabs
        ) {
            return "SEARCH"
        }
        val detailMarkerCount = listOf("评论", "说点什么", "收藏", "分享", "展开", "作者").count { marker -> text.contains(marker, ignoreCase = true) }
        val hasHomeChrome = Regex("首页|市集|消息|发现|同城|推荐").containsMatchIn(text)
        if (detailMarkerCount >= 2
            && !hasHomeChrome
            && !Regex("首页市集|发现同城|首页|市集|消息").containsMatchIn(compact)
        ) {
            return "NOTE_DETAIL"
        }
        if (Regex("编辑资料|获赞与收藏|关注|粉丝|小红书号", RegexOption.IGNORE_CASE).containsMatchIn(text)
            && Regex("笔记|收藏|赞过", RegexOption.IGNORE_CASE).containsMatchIn(text)
        ) {
            return "PROFILE"
        }
        if (Regex("消息|赞和收藏|评论和@", RegexOption.IGNORE_CASE).containsMatchIn(text)
            && Regex("新增关注|聊天|通知", RegexOption.IGNORE_CASE).containsMatchIn(text)
        ) {
            return "MESSAGE"
        }
        return if (isExpectedPackage(snapshot.optString("packageName"), "com.xingin.xhs") && text.isNotBlank()) "UNKNOWN" else "OTHER_APP"
    }

    private fun snapshotText(snapshot: JSONObject): String {
        val nodes = snapshot.optJSONArray("nodes") ?: JSONArray()
        val parts = mutableListOf<String>()
        for (index in 0 until nodes.length()) {
            val node = nodes.optJSONObject(index) ?: continue
            val text = node.optString("text")
            val desc = node.optString("description")
            if (text.isNotBlank()) parts.add(text)
            if (desc.isNotBlank()) parts.add(desc)
        }
        return parts.joinToString(" ")
    }

    private fun isExpectedPackage(actual: String?, expected: String): Boolean {
        if (actual.isNullOrBlank()) return false
        return actual == expected || actual.contains("xingin", ignoreCase = true) || actual.contains("xhs", ignoreCase = true)
    }

    private fun isForegroundPackage(packageName: String): Boolean {
        val current = currentForegroundPackageName() ?: return false
        return isExpectedPackage(current, packageName)
    }

    private fun currentForegroundPackageName(): String? {
        val usageStats = reactApplicationContext.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: return null
        val now = System.currentTimeMillis()
        val events = usageStats.queryEvents(now - 12000L, now)
        val event = android.app.usage.UsageEvents.Event()
        var current: String? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.eventType == android.app.usage.UsageEvents.Event.ACTIVITY_RESUMED ||
                event.eventType == android.app.usage.UsageEvents.Event.MOVE_TO_FOREGROUND
            ) {
                current = event.packageName
            }
        }
        return current
    }

    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }
}
