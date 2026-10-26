package com.anonymous.junluo

import android.content.Context
import android.graphics.Color
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.roundToInt

/** Display only: receives the collector's actual counters, never runs a second clock. */
object PhoneFocusCountdown {
    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var card: LinearLayout? = null
    private var manager: WindowManager? = null
    private var remaining: TextView? = null
    private var daily: TextView? = null
    private var title: TextView? = null
    private var dailyRow: LinearLayout? = null
    @Volatile private var arrow: ImageView? = null
    // View rebuilding, package switches and deadline updates must not reopen the card.
    private var collapsed = false
    private var restrictionCountdown = false
    private var layoutKey = ""
    private var displayedPackageName = ""

    fun isShowing(): Boolean = card != null || arrow != null

    /** Read on the main thread by PhoneRestrictionWindow.executionStatus. */
    fun isWindowAttached(): Boolean = card?.isAttachedToWindow == true || arrow?.isAttachedToWindow == true

    private fun onMain(work: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) work() else handler.post { work() }
    }

    fun hide() = onMain {
        card?.let { runCatching { manager?.removeView(it) } }
        arrow?.let { runCatching { manager?.removeView(it) } }
        card = null
        remaining = null
        daily = null
        title = null
        dailyRow = null
        arrow = null
        restrictionCountdown = false
        manager = null
        layoutKey = ""
        displayedPackageName = ""
    }

    fun hideUsage() = onMain { if (!restrictionCountdown) hide() }

    fun hideIfReleased(context: Context) = onMain {
        if (PhoneRestrictionRuntime.isBlockingReleased(context, displayedPackageName)) hide()
    }

    fun update(context: Context, ordinaryRemainingMs: Long, dailyRemainingMs: Long, packageName: String = "") = onMain {
        if (PhoneFocusRules.restorePaused || !Settings.canDrawOverlays(context)) { hide(); return@onMain }
        if (PhoneRestrictionRuntime.isBlockingReleased(context, packageName)) { hideUsage(); return@onMain }
        if (restrictionCountdown) return@onMain
        val state = PhoneFocusPolicy.countdown(ordinaryRemainingMs, dailyRemainingMs)
        if (state.untilOverlayMs <= 0L) { hide(); return@onMain }
        if (!ensureView(context)) return@onMain
        title?.text = "倒计时"
        dailyRow?.visibility = View.VISIBLE
        displayedPackageName = packageName
        val primary = PhoneFocusPolicy.countdownText(state.untilOverlayMs)
        val secondary = PhoneFocusPolicy.countdownText(state.dailyRemainingMs)
        if (remaining?.text?.toString() != primary) remaining?.text = primary
        if (daily?.text?.toString() != secondary) daily?.text = secondary
        card?.contentDescription = "距离遮挡 $primary，今日还可使用 $secondary"
    }

    fun updateRestriction(context: Context, packageName: String, now: Long, screenAvailable: Boolean) = onMain {
        if (PhoneFocusRules.restorePaused || !screenAvailable || !Settings.canDrawOverlays(context)) {
            hide(); return@onMain
        }
        val emergency = PhoneRestrictionRuntime.emergencyDisplay(context)?.takeIf { now < it.until }
        val warning = if (emergency == null) PhoneRestrictionRuntime.warningDisplay(context, packageName, now) else null
        if (emergency == null && warning == null) {
            if (restrictionCountdown) hide()
            return@onMain
        }
        if (!ensureView(context)) return@onMain
        restrictionCountdown = true
        displayedPackageName = packageName
        val heading = if (emergency != null) "应急使用"
            else if (warning?.restriction?.scope == "phone") "即将锁机" else "即将遮挡"
        val until = emergency?.until ?: warning!!.restriction.warningUntil
        val primary = PhoneFocusPolicy.countdownText(until - now)
        title?.text = heading
        dailyRow?.visibility = View.GONE
        if (remaining?.text?.toString() != primary) remaining?.text = primary
        card?.contentDescription = "$heading $primary"
    }

    private fun ensureView(context: Context): Boolean {
        val app = context.applicationContext
        val display = app.resources.displayMetrics
        val key = "${display.widthPixels}:${display.heightPixels}:${app.resources.configuration.fontScale}"
        if (card != null && key != layoutKey) hide()
        if (card == null && !create(app)) return false
        layoutKey = key
        return true
    }

    private fun applyCollapsed() {
        card?.visibility = if (collapsed) View.GONE else View.VISIBLE
        arrow?.contentDescription = if (collapsed) "展开倒计时" else "收起倒计时"
        arrow?.drawable?.invalidateSelf()
    }

    private fun create(context: Context): Boolean {
        val display = context.resources.displayMetrics
        fun dp(value: Int) = (value * display.density).roundToInt()
        val width = dp((124 * context.resources.configuration.fontScale.coerceIn(1f, 1.15f)).roundToInt())
            .coerceAtMost((display.widthPixels * 0.32f).roundToInt().coerceAtLeast(1))
        fun unit(value: Int) = (value * width / 124f).roundToInt()
        val ink = Color.rgb(56, 64, 82)
        val muted = Color.rgb(105, 113, 132)
        fun label(text: String, size: Float, color: Int) = TextView(context).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_PX, size * width / 124f)
            gravity = Gravity.CENTER
            maxLines = 1
            setTextColor(color)
            includeFontPadding = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        val root = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(unit(4), unit(4), unit(4), unit(4))
            background = GradientDrawable().apply {
                setColor(Color.rgb(238, 247, 255)) // Very pale blue, matching the countdown card's blue accents.
                cornerRadius = unit(12).toFloat()
                setStroke(dp(1), Color.rgb(178, 217, 255)) // colors.secondary
            }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_NONE
        }
        title = label("倒计时", 11f, muted)
        root.addView(title, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = unit(2) })
        val top = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        top.addView(ImageView(context).apply {
            setImageResource(R.drawable.baiyun_guard_calm)
            scaleType = ImageView.ScaleType.FIT_CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(unit(50), unit(50)).apply { marginEnd = unit(2) })
        // The approved preview fits 22dp text to the space beside the 50dp portrait.
        val numberSize = minOf(22f, (124f - 8f - 2f - 50f - 2f) / 3.2f)
        remaining = label("", numberSize, ink).apply {
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            fontFeatureSettings = "tnum"
        }
        top.addView(remaining, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(top)
        val bottom = LinearLayout(context).apply {
            gravity = Gravity.CENTER
            setPadding(unit(4), unit(2), unit(4), unit(2))
            background = GradientDrawable().apply {
                setColor(Color.rgb(214, 237, 255))
                cornerRadius = unit(6).toFloat()
            }
        }
        bottom.addView(label("今日剩余", 9f, muted), LinearLayout.LayoutParams(0, -2, 1f))
        daily = label("", 11f, ink).apply { fontFeatureSettings = "tnum" }
        bottom.addView(daily)
        root.addView(bottom, LinearLayout.LayoutParams(-1, -2).apply { topMargin = unit(2) })
        dailyRow = bottom
        val handle = ImageView(context).apply {
            setPadding(dp(10), dp(15), dp(10), dp(15))
            background = GradientDrawable().apply {
                setColor(Color.rgb(238, 247, 255))
                cornerRadius = dp(12).toFloat()
                setStroke(dp(1), Color.rgb(178, 217, 255))
            }
            setImageDrawable(object : Drawable() {
                private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = ink; style = Paint.Style.STROKE; strokeWidth = dp(2).toFloat()
                    strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
                }
                override fun draw(canvas: Canvas) {
                    val tip = if (collapsed) 0.25f else 0.75f
                    val tail = 1f - tip
                    canvas.drawPath(Path().apply {
                        moveTo(bounds.left + bounds.width() * tail, bounds.top + bounds.height() * 0.2f)
                        lineTo(bounds.left + bounds.width() * tip, bounds.exactCenterY())
                        lineTo(bounds.left + bounds.width() * tail, bounds.top + bounds.height() * 0.8f)
                    }, paint)
                }
                override fun setAlpha(alpha: Int) { paint.alpha = alpha }
                override fun setColorFilter(filter: android.graphics.ColorFilter?) { paint.colorFilter = filter }
                @Deprecated("Deprecated in Android")
                override fun getOpacity() = PixelFormat.TRANSLUCENT
            })
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            setOnClickListener { collapsed = !collapsed; applyCollapsed() }
        }
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val params = WindowManager.LayoutParams(
            width, WindowManager.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = dp(36) // Leave a 4dp gap beside the fixed 32dp edge-arrow window.
            y = dp(12) // No LAYOUT_IN_SCREEN: the platform already keeps this below system bars.
            alpha = 0.75f // Below Android's obscuring-opacity limit, allowing touches through.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                setFitInsetsTypes(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                setFitInsetsIgnoringVisibility(true)
            }
            setTitle("君落使用时间")
        }
        val edgeParams = WindowManager.LayoutParams(
            dp(32), dp(48), params.type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = 0; y = dp(36); alpha = 0.75f
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                setFitInsetsTypes(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                setFitInsetsIgnoringVisibility(true)
            }
            setTitle("君落倒计时收展")
        }
        root.addOnLayoutChangeListener { _, _, topY, _, bottomY, _, _, _, _ ->
            if (!collapsed && bottomY > topY) {
                edgeParams.y = params.y + ((bottomY - topY - edgeParams.height) / 2).coerceAtLeast(0)
                if (handle.isAttachedToWindow) runCatching { wm.updateViewLayout(handle, edgeParams) }
            }
        }
        manager = wm
        card = root // Own-window events must be recognized even during addView.
        arrow = handle
        return try {
            wm.addView(root, params)
            wm.addView(handle, edgeParams)
            applyCollapsed()
            true
        } catch (_: Exception) { hide(); false }
    }
}
