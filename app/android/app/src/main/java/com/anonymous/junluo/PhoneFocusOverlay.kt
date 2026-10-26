package com.anonymous.junluo

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt
import kotlin.math.roundToInt
import kotlin.random.Random
import java.util.Calendar
import java.util.concurrent.FutureTask

object PhoneFocusOverlay {
    private const val FRAME_MS = 42L
    private const val STAGE_MS = 5_000L
    private const val DEFAULT_OVERLAY_MESSAGE = "消息生成中"

    private var windowManager: WindowManager? = null
    @Volatile private var rootView: FrameLayout? = null
    private var messageView: TextView? = null
    private var buttonView: TextView? = null
    private var appContext: Context? = null
    @Volatile private var currentRuleId = ""
    @Volatile private var currentTriggerId = ""
    private var restrictionUsageRuleId: String? = null
    private var currentMessage = "返回君落"
    private var currentOverlayMessage = ""
    private var currentStage = 0
    private var overlayUsageDay = ""
    private val startedMessageTaskIds = mutableSetOf<String>()
    private val stickers = mutableListOf<Sticker>()
    private val handler = Handler(Looper.getMainLooper())
    private var frameRunning = false
    private var tiltX = 0f
    private var tiltY = 9.8f
    private var sensorManager: SensorManager? = null
    private var accelerometer: Sensor? = null

    private fun onMain(block: () -> Boolean): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val task = FutureTask { block() }
        if (!handler.post(task)) return false
        return runCatching { task.get() }.getOrDefault(false)
    }

    fun isShowing(ruleId: String): Boolean = onMain { rootView != null && currentRuleId == ruleId }

    private fun usageDayKey(now: Long): String {
        val calendar = Calendar.getInstance().apply { timeInMillis = now }
        return "${calendar.get(Calendar.YEAR)}-${calendar.get(Calendar.DAY_OF_YEAR)}"
    }

    fun activeTriggerId(): String = currentTriggerId

    /** A real legacy portrait was visible before its target App lost foreground. */
    fun departingLegacyRuleId(): String? {
        var ruleId: String? = null
        onMain {
            if (currentRuleId.isNotBlank() && PhoneRestrictionRuntime.appOverlayPackage(currentRuleId) == null &&
                rootView?.isAttachedToWindow == true && rootView?.isShown == true) {
                ruleId = currentRuleId
            }
            true
        }
        return ruleId
    }

    fun isAppRestrictionShowing(ruleId: String): Boolean = onMain {
        val root = rootView
        val flags = (root?.layoutParams as? WindowManager.LayoutParams)?.flags
        currentRuleId == ruleId && currentStage == 3 && root?.isAttachedToWindow == true &&
            buttonView?.isAttachedToWindow == true && flags != null &&
            flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE == 0
    }

    /** Physical display evidence for local technical UI, without changing legacy rule checks. */
    fun isAppOverlayShowing(): Boolean = onMain {
        PhoneRestrictionRuntime.appOverlayPackage(currentRuleId) != null &&
            isAppRestrictionShowing(currentRuleId) && rootView?.isShown == true && buttonView?.isShown == true
    }

    /** Called only inside the query's main-thread sample; never consumes a legacy rule. */
    fun queryAppLockShown(legacyLockIds: Set<String>?): Boolean? {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (!isAppRestrictionShowing(currentRuleId) || rootView?.isShown != true || buttonView?.isShown != true) return false
        if (PhoneRestrictionRuntime.appOverlayPackage(currentRuleId) != null) return true
        return legacyLockIds?.contains(currentRuleId)
    }

    fun isLegacyOverlayAttached(): Boolean = onMain {
        PhoneRestrictionRuntime.appOverlayPackage(currentRuleId) == null &&
            (rootView?.isAttachedToWindow == true || messageView?.isAttachedToWindow == true ||
                buttonView?.isAttachedToWindow == true)
    }

    /** Same approved animation; temporary restriction evidence has no model consumer yet. */
    fun showAppRestriction(context: Context, packageName: String): Boolean = onMain {
        val ruleId = PhoneRestrictionRuntime.appOverlayRuleId(packageName)
        if (!PhoneRestrictionRuntime.hasAppBlocking(context, packageName)) return@onMain false
        // addView attaches on the next main-loop traversal. Keep that same window
        // until the collector's next observation instead of rebuilding it here.
        if (currentRuleId == ruleId && rootView != null) return@onMain isAppRestrictionShowing(ruleId)
        if (!showMaxStage(context, "", "返回君落", ruleId)) {
            dismissForRestriction(context, ruleId)
            return@onMain false
        }
        if (buttonView == null) {
            dismissForRestriction(context, ruleId)
            return@onMain false
        }
        restrictionUsageRuleId = PhoneFocusRules.blacklistRules(context).firstOrNull { it.source == packageName }?.id.orEmpty()
        updateMessage(context, ruleId, "App 暂时受限")
        isAppRestrictionShowing(ruleId)
    }

    fun isOwnOverlayEvent(className: String): Boolean =
        (rootView != null || messageView != null || buttonView != null || PhoneFocusCountdown.isShowing()) &&
            className in setOf(FrameLayout::class.java.name, TextView::class.java.name, ImageView::class.java.name, LinearLayout::class.java.name)

    private val sensorListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            tiltX = (-event.values[0]).coerceIn(-9.8f, 9.8f)
            tiltY = event.values[1].coerceIn(-9.8f, 9.8f)
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    }

    private val frameTick = object : Runnable {
        override fun run() {
            stepPhysics()
            if (frameRunning) handler.postDelayed(this, FRAME_MS)
        }
    }

    private val stageTick = object : Runnable {
        override fun run() {
            val context = appContext ?: return
            if (rootView == null || currentStage >= 3 || currentRuleId.isBlank()) return
            val nextStage = currentStage + 1
            show(context, "", nextStage, if (nextStage >= 3) "被白云小姐抓回来" else currentMessage, currentRuleId)
        }
    }

    fun show(context: Context, resourceName: String, stage: Int, message: String, ruleId: String): Boolean {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            return onMain { show(context, resourceName, stage, message, ruleId) }
        }
        if (PhoneRestrictionRuntime.isRuleReleased(context, ruleId)) {
            dismissForRestriction(context)
            return false
        }
        if (rootView != null && currentRuleId != ruleId) dismiss(context)
        PhoneFocusCountdown.hide()
        val contextApp = context.applicationContext
        if (PhoneFocusRules.restorePaused) return false
        if (!Settings.canDrawOverlays(contextApp)) return false
        appContext = contextApp
        val manager = contextApp.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val nextStage = stage.coerceIn(1, 3)
        val root = rootView ?: FrameLayout(contextApp).also {
            rootView = it
            windowManager = manager
            try {
                manager.addView(it, overlayParams(nextStage))
                overlayUsageDay = usageDayKey(System.currentTimeMillis())
            } catch (_: Exception) {
                rootView = null
                windowManager = null
                return false
            }
            startSensors(contextApp)
            startFrameLoop()
        }
        currentRuleId = ruleId
        currentMessage = message.ifBlank { if (nextStage >= 3) "被白云小姐抓回来" else "返回君落" }
        if (nextStage > currentStage) {
            for (missingStage in PhoneFocusPolicy.stagesToAdd(currentStage, nextStage)) {
                dropPortraitBatch(contextApp, root, resourceName, missingStage)
            }
            currentStage = nextStage
            updateTouchable(nextStage)
            scheduleStageTick()
        }
        if (currentStage >= 3) {
            val overlayMessage = currentOverlayMessage.ifBlank { DEFAULT_OVERLAY_MESSAGE }
            currentOverlayMessage = overlayMessage
            ensureMessage(contextApp, manager, overlayMessage)
        }
        ensureButton(contextApp, manager, currentMessage)
        return true
    }

    fun showMaxStage(context: Context, resourceName: String, message: String, ruleId: String): Boolean {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            return onMain { showMaxStage(context, resourceName, message, ruleId) }
        }
        return show(context, resourceName, 1, message, ruleId) &&
            show(context, "", 2, message, ruleId) &&
            show(context, "", 3, message, ruleId)
    }

    fun updateMessage(context: Context, ruleId: String, message: String): Boolean {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            return onMain { updateMessage(context, ruleId, message) }
        }
        if (ruleId.isBlank() || ruleId != currentRuleId || rootView == null) return false
        val clean = message.trim().take(120)
        if (clean.isBlank()) return false
        currentOverlayMessage = clean
        if (currentStage < 3) return true
        val manager = windowManager ?: context.applicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        ensureMessage(context.applicationContext, manager, clean)
        return true
    }

    fun setTriggerId(ruleId: String, triggerId: String) {
        onMain { if (ruleId == currentRuleId) currentTriggerId = triggerId; true }
    }

    fun updateMessageForTrigger(context: Context, ruleId: String, triggerId: String, message: String): Boolean = onMain {
        triggerId.isNotBlank() && triggerId == currentTriggerId && updateMessage(context, ruleId, message)
    }

    fun startMessageTask(context: Context, ruleId: String, payloadJson: String): Boolean {
        if (Looper.myLooper() != Looper.getMainLooper()) return onMain { startMessageTask(context, ruleId, payloadJson) }
        if (ruleId.isBlank() || payloadJson.isBlank()) return false
        val triggerId = runCatching { org.json.JSONObject(payloadJson).optString("triggerId") }.getOrDefault("")
        val taskKey = triggerId.ifBlank { payloadJson }
        if (startedMessageTaskIds.contains(taskKey)) return false
        val saved = PhoneFocusRules.getTriggerState(context, triggerId)?.let { org.json.JSONObject(it) } ?: return false
        if (saved.optString("status", "pending") != "pending") return false
        setTriggerId(ruleId, triggerId)
        updateMessageForTrigger(context, ruleId, triggerId, DEFAULT_OVERLAY_MESSAGE)
        val intent = Intent(context.applicationContext, PhoneGuardMessageTaskService::class.java).apply {
            putExtra("payloadJson", payloadJson)
        }
        val started = runCatching {
            context.applicationContext.startService(intent)
            true
        }.getOrDefault(false)
        if (started) {
            if (startedMessageTaskIds.size > 40) startedMessageTaskIds.clear()
            startedMessageTaskIds.add(taskKey)
        } else {
            updateMessageForTrigger(context, ruleId, triggerId, "消息生成失败")
        }
        return started
    }

    /** Released-App/emergency acknowledgement; preserve attached references if removal fails. */
    fun dismissForRestriction(context: Context, failedAppRuleId: String? = null): Boolean = onMain {
        if (rootView == null && messageView == null && buttonView == null) return@onMain true
        val failedApp = failedAppRuleId != null && failedAppRuleId == currentRuleId &&
            PhoneRestrictionRuntime.appOverlayPackage(currentRuleId) != null
        if (!failedApp && !PhoneRestrictionRuntime.isRuleReleased(context, currentRuleId)) return@onMain false
        removeAttachedOverlay(context)
    }

    /** A new usage day releases only this legacy layer, after current limits were checked. */
    fun dismissForNewUsageDay(context: Context, ruleId: String, now: Long): Boolean? {
        var released: Boolean? = null
        val checked = onMain {
            if (currentRuleId == ruleId && PhoneRestrictionRuntime.appOverlayPackage(ruleId) == null &&
                overlayUsageDay.isNotBlank() && overlayUsageDay != usageDayKey(now))
                released = removeAttachedOverlay(context)
            true
        }
        return if (checked) released else false
    }

    private fun removeAttachedOverlay(context: Context): Boolean {
        handler.removeCallbacks(stageTick)
        stopFrameLoop()
        stopSensors()
        val manager = windowManager ?: context.applicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        fun remove(view: android.view.View?): Boolean {
            if (view == null) return true
            // A registered view may not have completed its first traversal yet.
            // It still needs removal; dropping its reference leaks the window.
            runCatching { manager.removeViewImmediate(view) }
            return !view.isAttachedToWindow && view.parent == null
        }
        if (remove(rootView)) rootView = null
        if (remove(messageView)) messageView = null
        if (remove(buttonView)) buttonView = null
        val released = rootView == null && messageView == null && buttonView == null
        if (released) dismiss(context)
        return released
    }

    fun dismiss(context: Context) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            handler.post { dismiss(context) }
            return
        }
        PhoneFocusCountdown.hide()
        handler.removeCallbacks(stageTick)
        stopFrameLoop()
        stopSensors()
        val manager = windowManager ?: context.applicationContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        rootView?.let { runCatching { manager.removeView(it) } }
        messageView?.let { runCatching { manager.removeView(it) } }
        buttonView?.let { runCatching { manager.removeView(it) } }
        stickers.clear()
        rootView = null
        messageView = null
        buttonView = null
        windowManager = null
        appContext = null
        currentRuleId = ""
        currentTriggerId = ""
        restrictionUsageRuleId = null
        currentMessage = "返回君落"
        currentOverlayMessage = ""
        currentStage = 0
        overlayUsageDay = ""
    }

    private fun dropPortraitBatch(context: Context, root: FrameLayout, resourceName: String, stage: Int) {
        val batch = when (stage) {
            1 -> DropBatch(
                anchors = listOf(
                    DropAnchor(0.10f, 0.2754f),
                    DropAnchor(0.30f, 0.2916f),
                    DropAnchor(0.50f, 0.2754f),
                    DropAnchor(0.70f, 0.2916f),
                    DropAnchor(0.90f, 0.2754f),
                ),
                alpha = 0.96f,
            )
            2 -> DropBatch(
                anchors = listOf(
                    DropAnchor(0.13f, 0.4554f),
                    DropAnchor(0.38f, 0.4752f),
                    DropAnchor(0.63f, 0.4356f),
                    DropAnchor(0.87f, 0.4554f),
                ),
                alpha = 0.98f,
            )
            else -> DropBatch(
                anchors = listOf(
                    DropAnchor(0.28f, 0.8976f),
                    DropAnchor(0.72f, 0.9240f),
                ),
                alpha = 1f,
            )
        }
        batch.anchors.forEachIndexed { index, anchor ->
            addSticker(context, root, resourceName, stage, batch, anchor, index)
        }
    }

    private fun addSticker(context: Context, root: FrameLayout, resourceName: String, stage: Int, batch: DropBatch, anchor: DropAnchor, index: Int) {
        val selectedName = if (index == 0 && resourceName in portraitResourceNames) resourceName else randomPortraitResourceName()
        val fallback = context.resources.getIdentifier("baiyun_guard_calm", "drawable", context.packageName)
        val resId = context.resources.getIdentifier(selectedName, "drawable", context.packageName).takeIf { it != 0 } ?: fallback
        if (resId == 0) return
        val display = context.resources.displayMetrics
        val base = min(display.widthPixels, display.heightPixels)
        val size = (base * anchor.scale).roundToInt()
        val targetX = (display.widthPixels * anchor.centerX - size * 0.5f)
            .coerceIn(0f, max(0, display.widthPixels - size).toFloat())
        val startLeft = (targetX + Random.nextInt(-24, 25) * display.density).roundToInt()
            .coerceIn(0, max(0, display.widthPixels - size))
        val image = ImageView(context).apply {
            setImageResource(resId)
            alpha = batch.alpha
            rotation = Random.nextInt(-18, 19).toFloat()
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        val params = FrameLayout.LayoutParams(size, size).apply {
            leftMargin = startLeft
            topMargin = -size - (stage * 44f * display.density).roundToInt() - index * (18f * display.density).roundToInt()
        }
        root.addView(image, params)
        stickers.add(
            Sticker(
                view = image,
                params = params,
                stage = stage,
                size = size.toFloat(),
                x = params.leftMargin.toFloat(),
                y = params.topMargin.toFloat(),
                vx = Random.nextInt(-80, 81).toFloat(),
                vy = 0f,
                rotation = image.rotation,
                spin = Random.nextInt(-10, 11).toFloat(),
            ),
        )
    }

    private fun stepPhysics() {
        val context = appContext ?: return
        if (rootView == null) return
        val display = context.resources.displayMetrics
        val width = display.widthPixels.toFloat()
        val height = display.heightPixels.toFloat()
        val dt = FRAME_MS / 1000f
        val gravity = 4600f
        val buttonHeight = 68f * display.density
        val buttonBottomInset = 18f * display.density
        val floorGap = 0f
        val floorY = height - buttonBottomInset - buttonHeight - floorGap
        val sensorForce = 170f * display.density

        stickers.forEach { sticker ->
            sticker.age += dt
            if (sticker.hasLanded) {
                sticker.vx += tiltX * sensorForce * dt
                sticker.vy += tiltY * sensorForce * dt
            } else {
                sticker.vy += gravity * dt
            }
            sticker.vx *= if (sticker.hasLanded) 0.94f else 0.995f
            sticker.vy *= if (sticker.hasLanded) 0.985f else 1f
            sticker.x += sticker.vx * dt
            sticker.y += sticker.vy * dt
            sticker.rotation += sticker.spin * dt
            sticker.spin *= 0.992f

            val minX = 0f
            val maxX = max(0f, width - sticker.size)
            if (sticker.x < minX) {
                sticker.x = minX
                sticker.vx = -sticker.vx * 0.28f
            } else if (sticker.x > maxX) {
                sticker.x = maxX
                sticker.vx = -sticker.vx * 0.28f
            }

            constrainVerticalBounds(sticker, floorY)
        }

        repeat(7) {
            for (firstIndex in 0 until stickers.lastIndex) {
                for (secondIndex in firstIndex + 1 until stickers.size) {
                    resolveStickerCollision(stickers[firstIndex], stickers[secondIndex])
                }
            }
            stickers.forEach { sticker ->
                sticker.x = sticker.x.coerceIn(0f, max(0f, width - sticker.size))
                constrainVerticalBounds(sticker, floorY)
            }
        }

        stickers.sortedByDescending { it.size }.forEach { it.view.bringToFront() }
        stickers.forEach { sticker ->
            if (sticker.hasLanded) {
                sticker.rotation += (sticker.vx * 0.0022f - sticker.rotation * 0.018f)
                sticker.rotation = sticker.rotation.coerceIn(-24f, 24f)
            }
            sticker.params.leftMargin = sticker.x.roundToInt()
            sticker.params.topMargin = sticker.y.roundToInt()
            sticker.view.rotation = sticker.rotation
            sticker.view.layoutParams = sticker.params
        }
    }

    private fun constrainVerticalBounds(sticker: Sticker, floor: Float) {
        if (sticker.hasLanded && sticker.y < 0f) {
            sticker.y = 0f
            sticker.vy = -sticker.vy * 0.28f
            sticker.spin *= 0.86f
            return
        }
        val floorY = floor - sticker.size
        if (sticker.y < floorY) return
        sticker.y = floorY
        if (sticker.vy > 150f && !sticker.hasLanded) {
            sticker.vy = -min(sticker.vy * 0.16f, 300f)
        } else {
            sticker.vy = 0f
        }
        sticker.vx *= 0.91f
        sticker.spin *= 0.82f
        sticker.hasLanded = true
    }

    private fun resolveStickerCollision(first: Sticker, second: Sticker) {
        val firstRadius = first.size * if (first.stage == 3) 0.26f else 0.40f
        val secondRadius = second.size * if (second.stage == 3) 0.26f else 0.40f
        val firstCenterX = first.x + first.size * 0.5f
        val firstCenterY = first.y + first.size * 0.5f
        val secondCenterX = second.x + second.size * 0.5f
        val secondCenterY = second.y + second.size * 0.5f
        var dx = secondCenterX - firstCenterX
        var dy = secondCenterY - firstCenterY
        val minimumDistance = firstRadius + secondRadius
        val distanceSquared = dx * dx + dy * dy
        if (distanceSquared >= minimumDistance * minimumDistance) return

        var distance = sqrt(max(0.0001f, distanceSquared))
        if (distance < 1f) {
            dx = if (firstCenterX <= secondCenterX) 1f else -1f
            dy = -0.25f
            distance = sqrt(dx * dx + dy * dy)
        }
        val normalX = dx / distance
        val normalY = dy / distance
        val overlap = minimumDistance - distance
        val firstMass = first.size * first.size
        val secondMass = second.size * second.size
        val totalMass = firstMass + secondMass
        val firstShare = secondMass / totalMass
        val secondShare = firstMass / totalMass

        first.x -= normalX * overlap * firstShare
        first.y -= normalY * overlap * firstShare
        second.x += normalX * overlap * secondShare
        second.y += normalY * overlap * secondShare

        val relativeVelocity = (second.vx - first.vx) * normalX + (second.vy - first.vy) * normalY
        if (relativeVelocity < 0f) {
            val impulse = -relativeVelocity * 0.34f
            first.vx -= impulse * normalX * firstShare
            first.vy -= impulse * normalY * firstShare
            second.vx += impulse * normalX * secondShare
            second.vy += impulse * normalY * secondShare
        }
        if (normalY > 0.18f) {
            first.hasLanded = true
            first.vx *= 0.96f
        } else if (normalY < -0.18f) {
            second.hasLanded = true
            second.vx *= 0.96f
        }
    }

    private fun ensureMessage(context: Context, manager: WindowManager, message: String) {
        messageView?.let {
            it.text = message
            return
        }
        val view = TextView(context).apply {
            text = message
            textSize = 16f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(116, 69, 92))
            val paddingHorizontal = (16f * context.resources.displayMetrics.density).roundToInt()
            val paddingVertical = (10f * context.resources.displayMetrics.density).roundToInt()
            setPadding(paddingHorizontal, paddingVertical, paddingHorizontal, paddingVertical)
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(Color.rgb(255, 246, 250))
                setStroke((1.5f * context.resources.displayMetrics.density).roundToInt(), Color.rgb(248, 185, 196))
                cornerRadius = 18f * context.resources.displayMetrics.density
            }
            elevation = 9f * context.resources.displayMetrics.density
            maxLines = 3
        }
        messageView = view
        try {
            manager.addView(view, messageParams(context))
        } catch (_: Exception) {
            messageView = null
        }
    }

    private fun ensureButton(context: Context, manager: WindowManager, message: String) {
        buttonView?.let {
            it.text = message
            return
        }
        val button = TextView(context).apply {
            text = message
            textSize = 18f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(86, 117, 139))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(Color.rgb(178, 217, 255))
                cornerRadius = 22f * context.resources.displayMetrics.density
            }
            elevation = 8f * context.resources.displayMetrics.density
            setOnClickListener {
                val clickedRoot = rootView
                val clickedTriggerId = currentTriggerId
                if (currentRuleId.isNotBlank()) PhoneFocusRules.recordLaunchRequest(context, currentRuleId, currentTriggerId, System.currentTimeMillis())
                val launchIntent = Intent(context, MainActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                    putExtra("junluoTargetScreen", "chat")
                    putExtra("initialRoute", "chat")
                    putExtra("junluoSource", "phone-guard")
                    putExtra("junluoRuleId", currentRuleId)
                    putExtra("junluoTriggerId", currentTriggerId)
                }
                context.startActivity(launchIntent)
                val usageRuleId = restrictionUsageRuleId ?: currentRuleId
                if (usageRuleId.isNotBlank()) PhoneFocusRules.recordOverlayExit(context, usageRuleId, System.currentTimeMillis())
                handler.postDelayed({
                    if (rootView === clickedRoot && currentTriggerId == clickedTriggerId) dismiss(context)
                }, 700L)
            }
        }
        buttonView = button
        try {
            manager.addView(button, buttonParams(context))
        } catch (_: Exception) {
            buttonView = null
        }
    }

    private fun updateTouchable(stage: Int) {
        val manager = windowManager ?: return
        val root = rootView ?: return
        runCatching { manager.updateViewLayout(root, overlayParams(stage)) }
    }

    private fun overlayParams(stage: Int): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        val baseFlags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        val flags = if (stage < 3) baseFlags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else baseFlags
        return WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            type,
            flags,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
        }
    }

    private fun buttonParams(context: Context): WindowManager.LayoutParams {
        val display = context.resources.displayMetrics
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        return WindowManager.LayoutParams(
            (display.widthPixels - 64f * display.density).roundToInt(),
            (68f * display.density).roundToInt(),
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = (18f * display.density).roundToInt()
        }
    }

    private fun messageParams(context: Context): WindowManager.LayoutParams {
        val display = context.resources.displayMetrics
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        return WindowManager.LayoutParams(
            (display.widthPixels - 48f * display.density).roundToInt(),
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = (32f * display.density).roundToInt()
        }
    }

    private fun scheduleStageTick() {
        handler.removeCallbacks(stageTick)
        if (currentStage < 3) handler.postDelayed(stageTick, STAGE_MS)
    }

    private fun startFrameLoop() {
        if (frameRunning) return
        frameRunning = true
        handler.post(frameTick)
    }

    private fun stopFrameLoop() {
        frameRunning = false
        handler.removeCallbacks(frameTick)
    }

    private fun startSensors(context: Context) {
        val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
        sensorManager = manager
        accelerometer = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        accelerometer?.let { manager.registerListener(sensorListener, it, SensorManager.SENSOR_DELAY_GAME) }
    }

    private fun stopSensors() {
        sensorManager?.unregisterListener(sensorListener)
        sensorManager = null
        accelerometer = null
        tiltX = 0f
        tiltY = 9.8f
    }

    private val portraitResourceNames = listOf(
        "baiyun_guard_affectionate",
        "baiyun_guard_afraid",
        "baiyun_guard_angry",
        "baiyun_guard_anxious",
        "baiyun_guard_asleep",
        "baiyun_guard_calm",
        "baiyun_guard_confused",
        "baiyun_guard_disappointed",
        "baiyun_guard_expectant",
        "baiyun_guard_frustrated",
        "baiyun_guard_guilty",
        "baiyun_guard_happy",
        "baiyun_guard_hurt",
        "baiyun_guard_jealous",
        "baiyun_guard_lonely",
        "baiyun_guard_longing",
        "baiyun_guard_pained",
        "baiyun_guard_proud",
        "baiyun_guard_relieved",
        "baiyun_guard_sad",
        "baiyun_guard_shy",
        "baiyun_guard_sleepy",
        "baiyun_guard_surprised",
        "baiyun_guard_tired",
    )

    private fun randomPortraitResourceName(): String = portraitResourceNames.random()

    private data class DropBatch(
        val anchors: List<DropAnchor>,
        val alpha: Float,
    )

    private data class DropAnchor(
        val centerX: Float,
        val scale: Float,
    )

    private data class Sticker(
        val view: ImageView,
        val params: FrameLayout.LayoutParams,
        val stage: Int,
        val size: Float,
        var x: Float,
        var y: Float,
        var vx: Float,
        var vy: Float,
        var rotation: Float,
        var spin: Float,
        var age: Float = 0f,
        var hasLanded: Boolean = false,
    )
}
