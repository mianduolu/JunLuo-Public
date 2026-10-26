package com.anonymous.junluo

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Rect
import android.graphics.Path
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject

class JunLuoAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        activeService = this
        PhoneRestrictionWindow.accessibilityServiceChanged(applicationContext)
        runCatching { PhoneRestrictionScheduler.recover(applicationContext) }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        activeService = this
        if (event == null) return
        val sourcePackage = event.packageName?.toString().orEmpty()
        if (sourcePackage == applicationContext.packageName && PhoneRestrictionWindow.isOverlayWindow(event.windowId)) return
        val sourceWindow = windows.firstOrNull { it.id == event.windowId }
        if (PhoneFocusPolicy.ignoreOwnWindow(
                sourcePackage == applicationContext.packageName,
                sourceWindow?.type?.let { it == AccessibilityWindowInfo.TYPE_APPLICATION },
                PhoneFocusOverlay.isOwnOverlayEvent(event.className?.toString().orEmpty()),
            )) return
        val occurredAt = System.currentTimeMillis() - (SystemClock.uptimeMillis() - event.eventTime).coerceAtLeast(0)
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                val packageName = event.packageName?.toString().orEmpty()
                PhoneActivityCollectorService.notifyForegroundPackage(applicationContext, packageName, occurredAt)
                PhoneActivityCollectorService.notifyUserInteraction(applicationContext, packageName, occurredAt)
            }
            AccessibilityEvent.TYPE_TOUCH_INTERACTION_START -> {
                PhoneActivityCollectorService.notifyUserInteraction(
                    applicationContext,
                    event.packageName?.toString().orEmpty(),
                    occurredAt,
                )
            }
        }
    }

    override fun onInterrupt() = Unit

    override fun onUnbind(intent: Intent?): Boolean {
        disconnectRestrictionWindow()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        disconnectRestrictionWindow()
        super.onDestroy()
    }

    private fun disconnectRestrictionWindow() {
        if (activeService !== this) return
        activeService = null
        PhoneRestrictionWindow.accessibilityServiceChanged(applicationContext)
    }

    fun snapshotJson(maxNodes: Int = 80): String {
        val root = rootInActiveWindow ?: return resultJson(false, "NO_ACTIVE_WINDOW")
        val nodes = JSONArray()
        collectNodes(root, nodes, maxNodes.coerceIn(10, 220))
        return JSONObject()
            .put("ok", true)
            .put("packageName", root.packageName?.toString().orEmpty())
            .put("className", root.className?.toString().orEmpty())
            .put("nodes", nodes)
            .toString()
    }

    fun clickByText(target: String): String {
        val cleanTarget = target.trim()
        if (cleanTarget.isBlank()) return resultJson(false, "EMPTY_TEXT")
        val root = rootInActiveWindow ?: return resultJson(false, "NO_ACTIVE_WINDOW")
        val node = findNode(root) { info ->
            val text = info.text?.toString().orEmpty()
            val desc = info.contentDescription?.toString().orEmpty()
            text.contains(cleanTarget, ignoreCase = true) || desc.contains(cleanTarget, ignoreCase = true)
        } ?: return resultJson(false, "TEXT_NOT_FOUND")
        val clickable = climbToActionable(node, AccessibilityNodeInfo.ACTION_CLICK)
            ?: return resultJson(false, "NOT_CLICKABLE")
        return resultJson(clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK), "CLICK")
    }

    fun inputText(text: String): String {
        val root = rootInActiveWindow ?: return resultJson(false, "NO_ACTIVE_WINDOW")
        val node = findNode(root) { info ->
            info.isEditable || info.className?.toString()?.contains("EditText", ignoreCase = true) == true
        } ?: return resultJson(false, "EDIT_TEXT_NOT_FOUND")
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return resultJson(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args), "INPUT")
    }

    fun scroll(direction: String): String {
        val root = rootInActiveWindow ?: return resultJson(false, "NO_ACTIVE_WINDOW")
        val action = if (direction == "backward" || direction == "up") {
            AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        } else {
            AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        }
        return resultJson(performScrollDeep(root, action), "SCROLL")
    }

    fun back(): String {
        return resultJson(performGlobalAction(GLOBAL_ACTION_BACK), "BACK")
    }

    fun tap(x: Int, y: Int): String {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 80))
            .build()
        val ok = dispatchGesture(gesture, null, null)
        return resultJson(ok, "TAP")
    }

    fun clickFirstFeedCard(): String {
        val root = rootInActiveWindow ?: return resultJson(false, "NO_ACTIVE_WINDOW")
        val node = findBestFeedCardText(root) ?: return resultJson(false, "FEED_CARD_NOT_FOUND")
        val clickable = climbToActionable(node, AccessibilityNodeInfo.ACTION_CLICK)
            ?: return resultJson(false, "FEED_CARD_NOT_CLICKABLE")
        val ok = clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        return JSONObject()
            .put("ok", ok)
            .put("reason", "CLICK_FEED_CARD")
            .put("text", node.text?.toString()?.take(80).orEmpty())
            .put("description", node.contentDescription?.toString()?.take(80).orEmpty())
            .toString()
    }

    fun swipe(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Long): String {
        val path = Path().apply {
            moveTo(startX.toFloat(), startY.toFloat())
            lineTo(endX.toFloat(), endY.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(120, 1400)))
            .build()
        val ok = dispatchGesture(gesture, null, null)
        return resultJson(ok, "SWIPE")
    }

    private fun collectNodes(node: AccessibilityNodeInfo, nodes: JSONArray, maxNodes: Int) {
        if (nodes.length() >= maxNodes) return
        val text = node.text?.toString()?.replace("\\s+".toRegex(), " ")?.trim().orEmpty()
        val desc = node.contentDescription?.toString()?.replace("\\s+".toRegex(), " ")?.trim().orEmpty()
        if (text.isNotBlank() || desc.isNotBlank() || node.isClickable || node.isEditable || node.isScrollable) {
            nodes.put(JSONObject().apply {
                put("text", text.take(160))
                put("description", desc.take(160))
                put("className", node.className?.toString().orEmpty())
                put("viewId", node.viewIdResourceName.orEmpty())
                put("clickable", node.isClickable)
                put("editable", node.isEditable)
                put("scrollable", node.isScrollable)
            })
        }
        for (index in 0 until node.childCount) {
            node.getChild(index)?.let { child -> collectNodes(child, nodes, maxNodes) }
            if (nodes.length() >= maxNodes) return
        }
    }

    private fun findNode(
        node: AccessibilityNodeInfo,
        predicate: (AccessibilityNodeInfo) -> Boolean
    ): AccessibilityNodeInfo? {
        if (predicate(node)) return node
        for (index in 0 until node.childCount) {
            val found = node.getChild(index)?.let { findNode(it, predicate) }
            if (found != null) return found
        }
        return null
    }

    private fun climbToActionable(node: AccessibilityNodeInfo, action: Int): AccessibilityNodeInfo? {
        var current: AccessibilityNodeInfo? = node
        while (current != null) {
            if (current.actionList?.any { it.id == action } == true || (action == AccessibilityNodeInfo.ACTION_CLICK && current.isClickable)) {
                return current
            }
            current = current.parent
        }
        return null
    }

    private fun performScrollDeep(node: AccessibilityNodeInfo, action: Int): Boolean {
        for (index in node.childCount - 1 downTo 0) {
            val child = node.getChild(index) ?: continue
            if (performScrollDeep(child, action)) return true
        }
        val canScroll = node.actionList?.any { it.id == action } == true || node.isScrollable
        return canScroll && node.performAction(action)
    }

    private fun findBestFeedCardText(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val candidates = mutableListOf<Pair<Int, AccessibilityNodeInfo>>()
        collectFeedCardCandidates(root, candidates)
        return candidates.maxByOrNull { it.first }?.second
    }

    private fun collectFeedCardCandidates(node: AccessibilityNodeInfo, candidates: MutableList<Pair<Int, AccessibilityNodeInfo>>) {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val text = node.text?.toString()?.replace("\\s+".toRegex(), " ")?.trim().orEmpty()
        val desc = node.contentDescription?.toString()?.replace("\\s+".toRegex(), " ")?.trim().orEmpty()
        val label = listOf(text, desc).firstOrNull { it.isNotBlank() }.orEmpty()
        val centerY = bounds.centerY()
        val centerX = bounds.centerX()
        val skip = Regex("^(首页|市集|消息|我|关注|发现|同城|推荐|搜索|RED|直播|赞|笔记|动漫|美食|穿搭|游戏|短剧)$|说点什么|评论|私信|发布|扫一扫|设置|通知", RegexOption.IGNORE_CASE)
        val inFeedArea = centerY in 300..1850 && centerX in 24..1056
        val usefulText = label.length >= 2 && !skip.containsMatchIn(label)
        if (inFeedArea && usefulText && climbToActionable(node, AccessibilityNodeInfo.ACTION_CLICK) != null) {
            var score = label.length.coerceAtMost(30)
            if (bounds.height() in 20..220) score += 8
            if (centerY in 520..1450) score += 10
            if (Regex("[\\u4e00-\\u9fa5A-Za-z0-9]").containsMatchIn(label)) score += 6
            candidates.add(score to node)
        }
        for (index in 0 until node.childCount) {
            node.getChild(index)?.let { child -> collectFeedCardCandidates(child, candidates) }
        }
    }

    private fun resultJson(ok: Boolean, reason: String): String {
        return JSONObject().put("ok", ok).put("reason", reason).toString()
    }

    companion object {
        @Volatile
        private var activeService: JunLuoAccessibilityService? = null

        fun isActive(): Boolean = activeService != null
        fun restrictionOverlayContext(): JunLuoAccessibilityService? = activeService
        fun snapshot(maxNodes: Int = 80): String = activeService?.snapshotJson(maxNodes) ?: JSONObject().put("ok", false).put("reason", "ACCESSIBILITY_NOT_RUNNING").toString()
        fun clickText(text: String): String = activeService?.clickByText(text) ?: JSONObject().put("ok", false).put("reason", "ACCESSIBILITY_NOT_RUNNING").toString()
        fun input(text: String): String = activeService?.inputText(text) ?: JSONObject().put("ok", false).put("reason", "ACCESSIBILITY_NOT_RUNNING").toString()
        fun scroll(direction: String): String = activeService?.scroll(direction) ?: JSONObject().put("ok", false).put("reason", "ACCESSIBILITY_NOT_RUNNING").toString()
        fun back(): String = activeService?.back() ?: JSONObject().put("ok", false).put("reason", "ACCESSIBILITY_NOT_RUNNING").toString()
        fun tap(x: Int, y: Int): String = activeService?.tap(x, y) ?: JSONObject().put("ok", false).put("reason", "ACCESSIBILITY_NOT_RUNNING").toString()
        fun clickFeedCard(): String = activeService?.clickFirstFeedCard() ?: JSONObject().put("ok", false).put("reason", "ACCESSIBILITY_NOT_RUNNING").toString()
        fun swipe(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Long): String =
            activeService?.swipe(startX, startY, endX, endY, durationMs) ?: JSONObject().put("ok", false).put("reason", "ACCESSIBILITY_NOT_RUNNING").toString()
    }
}
