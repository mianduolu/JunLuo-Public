package com.anonymous.junluo

import android.content.Context
import android.graphics.Canvas
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.os.Build
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.TouchDelegate
import android.view.View
import android.view.WindowInsets
import android.widget.FrameLayout
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale
import org.json.JSONObject

/** Presentation only. The saved native deadline and collector own the clock. */
class PhoneRestrictionLockView(context: Context, private val emergency: () -> Unit,
                               private val openAllowedApp: (String) -> Unit) : FrameLayout(context) {
    private val ink = Color.rgb(56, 64, 82)
    private val muted = Color.rgb(111, 145, 165)
    private val appearance = PhoneRestrictionAppearance(JSONObject(context.assets.open("home-and-chat.json").bufferedReader().use { it.readText() }))
    private var skyColors = emptyList<Int>()
    private val skyBackground = PhoneRestrictionSkyBackground(resources.displayMetrics.density)
    private var skyAnimating = false
    private val animateSky = object : Runnable {
        override fun run() {
            if (!isAttachedToWindow || windowVisibility != View.VISIBLE || !isShown || !skyBackground.isNight) {
                skyAnimating = false
                return
            }
            skyBackground.tick(System.currentTimeMillis())
            postDelayed(this, 360)
        }
    }
    private var headerInk = ink
    private val remainingLabel = label("还有", 20f, ink).apply { includeFontPadding = false }
    private val remainingAccent = RemainingAccentView(context)
    private val unlockLabel = label("解锁", 20f, muted).apply { gravity = Gravity.CENTER; letterSpacing = 0.16f }
    private val guideLines = mutableListOf<UnlockGuideView>()
    private val bell = BellView(context)
    private val countdown = label("", 104f, ink).apply {
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        letterSpacing = -0.035f
        fontFeatureSettings = "tnum"
        includeFontPadding = false
        gravity = Gravity.CENTER
    }
    private val message = label("", 13f, muted).apply { gravity = Gravity.CENTER }
    private val allowedApps = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val allowedPanel = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(8), dp(16), dp(12))
        background = GradientDrawable().apply {
            setColor(Color.WHITE); cornerRadius = dp(20).toFloat()
            setStroke(dp(1), Color.rgb(215, 231, 239))
        }
        elevation = dp(6).toFloat()
    }
    private val necessaryApps = Button(context).apply {
        text = "放行应用  ›"; textSize = 20f; setTextColor(muted)
        background = null; isAllCaps = false; stateListAnimator = null
        gravity = Gravity.CENTER
        visibility = View.GONE
        contentDescription = "打开允许使用的应用"
        setOnClickListener { openAllowedPanel() }
    }
    private val allowedScroll = ScrollView(context)
    private var allowedPackages = emptySet<String>()
    private var countdownText = ""
    private var keyboardVisible = false
    private lateinit var hero: LinearLayout
    private lateinit var heroParams: LinearLayout.LayoutParams
    val chatSlot = FrameLayout(context) // Chapter 7 replaces the empty visual outlines with the same real chat.

    init {
        background = skyBackground
        isFocusableInTouchMode = true
        val content = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; clipChildren = false }
        addView(content, LayoutParams(-1, -1))
        val header = FrameLayout(context).apply { clipChildren = false }
        header.addView(remainingLabel, LayoutParams(-2, -2, Gravity.START or Gravity.BOTTOM).apply { marginStart = dp(28); bottomMargin = dp(6) })
        header.addView(remainingAccent, LayoutParams(dp(46), dp(14)))
        header.addView(bell, LayoutParams(dp(72), dp(72), Gravity.END or Gravity.CENTER_VERTICAL).apply { marginEnd = dp(16) })
        bell.translationY = dp(12).toFloat()
        header.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            val textBounds = Rect()
            remainingLabel.paint.getTextBounds("还有", 0, 2, textBounds)
            remainingLabel.translationY = (bell.bottom + dp(24) - remainingLabel.top - remainingLabel.baseline - textBounds.bottom).toFloat()
            remainingAccent.x = (remainingLabel.right + dp(10)).toFloat()
            remainingAccent.y = remainingLabel.top + remainingLabel.translationY + remainingLabel.baseline +
                (textBounds.top + textBounds.bottom) / 2f - remainingAccent.height / 2f
            val bellTop = header.top + bell.top + bell.translationY.toInt()
            content.touchDelegate = TouchDelegate(Rect(header.left + bell.left, bellTop,
                header.left + bell.right, bellTop + bell.height), bell)
        }
        content.addView(header, LinearLayout.LayoutParams(-1, dp(84)))
        hero = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
        }
        hero.addView(countdown, LinearLayout.LayoutParams(-1, -2))
        val unlockCaption = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        fun guideLine(starAtStart: Boolean) = UnlockGuideView(context, starAtStart).apply { guideLines.add(this) }
        unlockCaption.addView(guideLine(true), LinearLayout.LayoutParams(dp(46), dp(14)))
        unlockCaption.addView(unlockLabel, LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(12); marginEnd = dp(12) })
        unlockCaption.addView(guideLine(false), LinearLayout.LayoutParams(dp(46), dp(14)))
        hero.addView(unlockCaption, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(14) })
        heroParams = LinearLayout.LayoutParams(-1, 0, 0.85f)
        content.addView(hero, heroParams)
        val chatPreview = ChatPreview(context).apply {
            contentDescription = "聊天布局占位，真实聊天尚未接入"
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        chatSlot.addView(chatPreview, LayoutParams(-1, -1))
        content.addView(chatSlot, LinearLayout.LayoutParams(-1, 0, 1.15f))
        content.addView(necessaryApps, LinearLayout.LayoutParams(-1, dp(48)))
        content.addView(message, LinearLayout.LayoutParams(-1, dp(26)))
        val allowedHeader = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        allowedHeader.addView(label("允许使用", 18f, ink), LinearLayout.LayoutParams(0, dp(48), 1f))
        allowedHeader.addView(label("收起", 14f, muted).apply {
            gravity = Gravity.CENTER
            contentDescription = "收起允许使用的应用"
            setOnClickListener { closeAllowedPanel() }
        }, LinearLayout.LayoutParams(dp(64), dp(48)))
        allowedPanel.addView(allowedHeader)
        allowedScroll.addView(allowedApps)
        allowedPanel.addView(allowedScroll, LinearLayout.LayoutParams(-1, dp(52)))
        setPadding(dp(28), dp(32), dp(28), dp(24))
        setOnApplyWindowInsetsListener { _, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val safe = insets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val ime = insets.getInsets(WindowInsets.Type.ime()).bottom
                keyboardVisible = insets.isVisible(WindowInsets.Type.ime()) && ime > 0
                setPadding(dp(28) + safe.left, dp(20) + safe.top, dp(28) + safe.right,
                    if (keyboardVisible) ime + dp(10) else dp(16) + safe.bottom)
                heroParams.height = if (keyboardVisible) dp(134) else 0
                heroParams.weight = if (keyboardVisible) 0f else 0.85f
                hero.layoutParams = heroParams
                countdown.textSize = if (keyboardVisible || countdownText.count { it == ':' } > 1) 72f else 104f
                message.visibility = if (keyboardVisible && message.text.isEmpty()) View.GONE else View.VISIBLE
            } else {
                setPadding(dp(28) + insets.systemWindowInsetLeft, dp(20) + insets.systemWindowInsetTop,
                    dp(28) + insets.systemWindowInsetRight, dp(16) + insets.systemWindowInsetBottom)
            }
            insets
        }
        bell.contentDescription = "应急解锁，长按两秒"
        bell.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> { bell.beginHold(); true }
                MotionEvent.ACTION_MOVE -> {
                    if (event.x !in 0f..bell.width.toFloat() || event.y !in 0f..bell.height.toFloat()) bell.cancelHold()
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { bell.cancelHold(); true }
                else -> true
            }
        }
        applySky(System.currentTimeMillis())
    }

    fun render(until: Long, now: Long, packages: Set<String>) {
        applySky(now)
        val seconds = ((until - now).coerceAtLeast(0) + 999) / 1000
        val text = if (seconds >= 3600) String.format(Locale.ROOT, "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
            else String.format(Locale.ROOT, "%02d:%02d", seconds / 60, seconds % 60)
        if (text != countdownText) {
            countdownText = text
            countdown.text = text
            countdown.contentDescription = "剩余${seconds / 60}分${seconds % 60}秒"
            countdown.textSize = if (keyboardVisible || seconds >= 3600) 72f else 104f
        }
        if (packages == allowedPackages) return
        allowedPackages = packages
        closeAllowedPanel()
        allowedApps.removeAllViews()
        packages.sorted().forEach { packageName ->
            val launch = context.packageManager.getLaunchIntentForPackage(packageName) ?: return@forEach
            val info = runCatching { context.packageManager.getApplicationInfo(packageName, 0) }.getOrNull() ?: return@forEach
            val entry = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                contentDescription = context.packageManager.getApplicationLabel(info).toString()
                addView(ImageView(context).apply { setImageDrawable(context.packageManager.getApplicationIcon(info)) },
                    LinearLayout.LayoutParams(dp(30), dp(30)))
                addView(label(contentDescription.toString(), 16f, ink).apply { maxLines = 1 },
                    LinearLayout.LayoutParams(-1, -2).apply { marginStart = dp(14) })
                setOnClickListener {
                    closeAllowedPanel()
                    openAllowedApp(launch.`package` ?: packageName)
                }
            }
            allowedApps.addView(entry, LinearLayout.LayoutParams(-1, dp(52)))
        }
        necessaryApps.visibility = if (allowedApps.childCount == 0) View.GONE else View.VISIBLE
        allowedScroll.layoutParams = LinearLayout.LayoutParams(-1, dp(minOf(allowedApps.childCount * 52, 208)))
    }

    fun status(text: String) { message.text = text }
    private fun applySky(now: Long) {
        val colors = appearance.colorsAt(now)
        skyBackground.update(now, colors, appearance.isNightAt(now))
        syncSkyAnimation()
        if (colors == skyColors) return
        skyColors = colors
        headerInk = appearance.inkForSky(colors)
        fun tone(view: TextView, color: Int) {
            view.setTextColor(color)
            val shadow = if (color == ink) Color.argb(71, 255, 255, 255) else Color.argb(77, 20, 23, 47)
            view.setShadowLayer(dp(3).toFloat(), 0f, dp(1).toFloat(), shadow)
        }
        tone(remainingLabel, headerInk)
        remainingAccent.invalidate()
        tone(countdown, headerInk); tone(unlockLabel, headerInk)
        tone(necessaryApps, headerInk); tone(message, headerInk)
        guideLines.forEach { it.inkColor = headerInk }
        bell.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setStroke(dp(1), (headerInk and 0x00ffffff) or (100 shl 24))
        }
        bell.invalidate()
    }
    private fun syncSkyAnimation() {
        val active = isAttachedToWindow && windowVisibility == View.VISIBLE && isShown && skyBackground.isNight
        if (active && !skyAnimating) {
            skyAnimating = true
            post(animateSky)
        } else if (!active) {
            removeCallbacks(animateSky)
            skyAnimating = false
        }
    }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); syncSkyAnimation() }
    override fun onDetachedFromWindow() {
        removeCallbacks(animateSky); skyAnimating = false
        super.onDetachedFromWindow()
    }
    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        syncSkyAnimation()
    }
    private fun openAllowedPanel() {
        if (allowedPanel.parent == null)
            addView(allowedPanel, LayoutParams(-1, -2, Gravity.BOTTOM).apply { bottomMargin = dp(82) })
    }
    private fun closeAllowedPanel() {
        removeView(allowedPanel)
        necessaryApps.isPressed = false
        post { necessaryApps.invalidate(); invalidate() }
        postInvalidateDelayed(500)
    }
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode != KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_UP) closeAllowedPanel()
        return true
    }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun label(text: String, size: Float, color: Int) = TextView(context).apply {
        this.text = text; textSize = size; setTextColor(color)
    }

    private inner class ChatPreview(context: Context) : FrameLayout(context) {
        private val avatarStyle = appearance.chat.getJSONObject("messageAvatar")
        private fun avatar(asset: String) = ImageView(context).apply {
            context.assets.open(asset).use { setImageBitmap(BitmapFactory.decodeStream(it)) }
            scaleType = ImageView.ScaleType.FIT_CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        private val iAvatar = avatar("you-portrait-neutral.png")
        private val youAvatar = avatar("me-portrait-default.png")
        init {
            addView(ChatOutlineView(context), LayoutParams(-1, -1))
            val avatarWidth = dp(avatarStyle.getInt("width")); val avatarHeight = dp(avatarStyle.getInt("height"))
            val offset = dp(avatarStyle.getInt("marginTop"))
            addView(iAvatar, LayoutParams(avatarWidth, avatarHeight, Gravity.START).apply { topMargin = dp(48) + offset })
            addView(youAvatar, LayoutParams(avatarWidth, avatarHeight, Gravity.END).apply { topMargin = dp(152) + offset })
        }
        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
            super.onSizeChanged(w, h, oldw, oldh)
            val avatarWidth = dp(avatarStyle.getInt("width")); val avatarHeight = dp(avatarStyle.getInt("height"))
            val offset = dp(avatarStyle.getInt("marginTop"))
            iAvatar.layoutParams = LayoutParams(avatarWidth, avatarHeight, Gravity.START).apply { topMargin = dp(48) + offset }
            youAvatar.layoutParams = LayoutParams(avatarWidth, avatarHeight, Gravity.END).apply { topMargin = minOf(dp(152), h - dp(154)) + offset }
        }
    }

    /** Empty outlines only: no fabricated dialogue, draft, send action or model call. */
    private inner class ChatOutlineView(context: Context) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        init { setLayerType(View.LAYER_TYPE_SOFTWARE, null) }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val w = width.toFloat(); val h = height.toFloat()
            fun d(value: Int) = dp(value).toFloat()
            fun rounded(left: Float, top: Float, right: Float, bottom: Float, fill: Int, stroke: Int, radius: Float = d(19)) {
                paint.style = Paint.Style.FILL; paint.color = fill
                canvas.drawRoundRect(left, top, right, bottom, radius, radius, paint)
                paint.style = Paint.Style.STROKE; paint.color = stroke; paint.strokeWidth = d(1)
                canvas.drawRoundRect(left, top, right, bottom, radius, radius, paint)
            }
            fun lines(x: Float, y: Float, length: Float, color: Int) {
                paint.style = Paint.Style.STROKE; paint.color = color; paint.strokeWidth = d(3)
                paint.strokeCap = Paint.Cap.ROUND
                canvas.drawLine(x, y, x + length, y, paint)
                canvas.drawLine(x, y + d(14), x + length * 0.58f, y + d(14), paint)
                paint.strokeCap = Paint.Cap.BUTT
            }
            fun bubble(left: Float, top: Float, right: Float, styleName: String) {
                val style = appearance.chat.getJSONObject(styleName)
                val radius = d(style.getInt("borderRadius"))
                val small = d(style.getInt(if (styleName == "iBubble") "borderTopLeftRadius" else "borderTopRightRadius"))
                val path = Path().apply {
                    val leftRadius = if (styleName == "iBubble") small else radius
                    val rightRadius = if (styleName == "youBubble") small else radius
                    addRoundRect(RectF(left, top, right, top + d(70)), floatArrayOf(leftRadius, leftRadius, rightRadius, rightRadius, radius, radius, radius, radius), Path.Direction.CW)
                }
                val shadow = style.getJSONObject("shadowOffset")
                val shadowColor = (appearance.chatColor(styleName, "shadowColor") and 0x00ffffff) or ((style.getDouble("shadowOpacity") * 255).toInt() shl 24)
                paint.setShadowLayer(d(style.getInt("shadowRadius")), d(shadow.getInt("width")), d(shadow.getInt("height")), shadowColor)
                paint.style = Paint.Style.FILL; paint.color = appearance.chatColor(styleName, "backgroundColor"); canvas.drawPath(path, paint)
                paint.clearShadowLayer()
                paint.style = Paint.Style.STROKE; paint.color = appearance.chatColor(styleName, "borderColor"); paint.strokeWidth = d(style.getInt("borderWidth"))
                canvas.drawPath(path, paint)
            }
            val left = d(45); val firstTop = d(48); val firstRight = w - d(30)
            bubble(left, firstTop, firstRight, "iBubble")
            lines(left + d(13), firstTop + d(27), (firstRight - left) * 0.64f, Color.argb(40, 56, 64, 82))
            val secondTop = minOf(d(152), h - d(154)); val secondRight = w - d(45); val secondLeft = w * 0.12f
            bubble(secondLeft, secondTop, secondRight, "youBubble")
            lines(secondLeft + d(13), secondTop + d(27), (secondRight - secondLeft) * 0.60f, Color.argb(40, 56, 64, 82))
            val bottom = h - d(14); val top = bottom - d(56)
            rounded(d(1), top, w - d(66), bottom, Color.argb(245, 255, 247, 241), Color.argb(230, 240, 220, 210))
            paint.style = Paint.Style.FILL; paint.color = Color.rgb(255, 144, 116)
            canvas.drawCircle(w - d(27), top + d(28), d(27), paint)
            paint.style = Paint.Style.STROKE; paint.color = Color.WHITE; paint.strokeWidth = d(2); paint.strokeCap = Paint.Cap.ROUND; paint.strokeJoin = Paint.Join.ROUND
            val x = w - d(27); val y = top + d(28)
            val arrow = Path().apply {
                moveTo(x - d(10), y + d(7)); lineTo(x + d(10), y - d(10)); lineTo(x + d(4), y + d(11))
                lineTo(x - d(1), y + d(2)); close(); moveTo(x - d(1), y + d(2)); lineTo(x + d(10), y - d(10))
            }
            canvas.drawPath(arrow, paint)
        }
    }

    private inner class UnlockGuideView(context: Context, private val starAtStart: Boolean) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        var inkColor = muted
            set(value) { field = value; invalidate() }
        init { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val y = height / 2f
            val x = if (starAtStart) dp(4).toFloat() else width - dp(4).toFloat()
            paint.color = (inkColor and 0x00ffffff) or (128 shl 24)
            paint.strokeWidth = 1.5f * resources.displayMetrics.density
            canvas.drawLine(if (starAtStart) dp(12).toFloat() else 0f, y,
                if (starAtStart) width.toFloat() else width - dp(12).toFloat(), y, paint)
            val tip = dp(4).toFloat(); val waist = dp(1).toFloat()
            val star = Path().apply {
                moveTo(x, y - tip); lineTo(x + waist, y - waist); lineTo(x + tip, y)
                lineTo(x + waist, y + waist); lineTo(x, y + tip)
                lineTo(x - waist, y + waist); lineTo(x - tip, y); lineTo(x - waist, y - waist); close()
            }
            paint.color = (inkColor and 0x00ffffff) or (190 shl 24)
            canvas.drawPath(star, paint)
        }
    }

    private inner class RemainingAccentView(context: Context) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        init { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val y = height / 2f; val x = width - dp(4).toFloat()
            paint.color = (headerInk and 0x00ffffff) or (130 shl 24)
            paint.strokeWidth = 1.5f * resources.displayMetrics.density; paint.strokeCap = Paint.Cap.ROUND
            canvas.drawLine(0f, y, width - dp(12).toFloat(), y, paint)
            val tip = dp(4).toFloat(); val waist = dp(1).toFloat()
            val star = Path().apply {
                moveTo(x, y - tip); lineTo(x + waist, y - waist); lineTo(x + tip, y)
                lineTo(x + waist, y + waist); lineTo(x, y + tip)
                lineTo(x - waist, y + waist); lineTo(x - tip, y); lineTo(x - waist, y - waist); close()
            }
            paint.color = (headerInk and 0x00ffffff) or (190 shl 24)
            canvas.drawPath(star, paint)
        }
    }

    private inner class BellView(context: Context) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ink; strokeWidth = dp(2).toFloat(); style = Paint.Style.STROKE }
        private var holdStarted = 0L
        private val holdDone = Runnable {
            if (holdStarted > 0 && SystemClock.uptimeMillis() - holdStarted >= 2000) {
                cancelHold(); emergency()
            }
        }
        init {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setStroke(dp(1), Color.rgb(204, 224, 233)) }
        }
        fun beginHold() {
            cancelHold(); holdStarted = SystemClock.uptimeMillis(); postDelayed(holdDone, 2000)
            status("长按 2 秒应急解锁"); invalidate()
        }
        fun cancelHold() { removeCallbacks(holdDone); holdStarted = 0; status(""); invalidate() }
        override fun onDetachedFromWindow() { cancelHold(); super.onDetachedFromWindow() }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val scale = width / 52f
            canvas.save(); canvas.scale(scale, scale)
            paint.strokeWidth = 1.8f; paint.color = headerInk; paint.strokeCap = Paint.Cap.ROUND
            val path = Path().apply {
                moveTo(16f, 33f); lineTo(36f, 33f); lineTo(33f, 29f); lineTo(33f, 23f)
                cubicTo(33f, 13f, 19f, 13f, 19f, 23f); lineTo(19f, 29f); close()
            }
            canvas.drawPath(path, paint)
            canvas.drawLine(26f, 13f, 26f, 15f, paint)
            canvas.drawArc(23f, 34f, 29f, 39f, 0f, 180f, false, paint)
            if (holdStarted > 0) {
                val fraction = ((SystemClock.uptimeMillis() - holdStarted) / 2000f).coerceIn(0f, 1f)
                canvas.drawArc(2f, 2f, 50f, 50f, -90f, 360f * fraction, false, paint)
                postInvalidateOnAnimation()
            }
            canvas.restore()
        }
    }
}
