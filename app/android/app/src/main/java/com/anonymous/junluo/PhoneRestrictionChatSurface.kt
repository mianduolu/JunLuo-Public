package com.anonymous.junluo

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.ViewGroup
import com.facebook.react.ReactApplication
import com.facebook.react.ReactRootView
import com.facebook.react.interfaces.fabric.ReactSurface

/** One display-only React surface. The existing main App owns every chat action. */
object PhoneRestrictionChatSurface {
    private var surface: ReactSurface? = null
    private var legacyRoot: ReactRootView? = null
    private val view get() = legacyRoot ?: surface?.view
    private var container: ViewGroup? = null
    private var lastOwnerAttempt = -1L
    @Volatile private var visible = false
    @Volatile private var ownerReady = false

    fun isVisible(): Boolean = visible
    fun ownerReady(ready: Boolean) { ownerReady = ready }

    fun show(slot: ViewGroup) {
        if (!visible) {
            visible = true
            JunLuoPhoneActivityModule.emitPhoneLockChatVisibility(true)
        }
        if (container !== slot) {
            val existing = view
            (existing?.parent as? ViewGroup)?.removeView(existing)
            container = slot
            slot.removeAllViews()
            if (existing != null) slot.addView(existing, ViewGroup.LayoutParams(-1, -1))
        }
        if (surface == null && legacyRoot == null) {
            runCatching {
                val application = slot.context.applicationContext as ReactApplication
                slot.removeAllViews()
                if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
                    val next = application.reactHost!!.createSurface(slot.context, "JunLuoPhoneLockChat", Bundle())
                    next.view?.let { slot.addView(it, ViewGroup.LayoutParams(-1, -1)) }
                    surface = next
                    next.start()
                } else {
                    val next = ReactRootView(slot.context)
                    legacyRoot = next
                    slot.addView(next, ViewGroup.LayoutParams(-1, -1))
                    next.startReactApplication(application.reactNativeHost.reactInstanceManager, "JunLuoPhoneLockChat", Bundle())
                }
            }.onFailure { surface = null; legacyRoot = null }
        }
        ensureMainOwner(slot.context)
    }

    private fun ensureMainOwner(context: Context) {
        if (ownerReady) return
        val now = SystemClock.elapsedRealtime()
        if (lastOwnerAttempt >= 0 && now - lastOwnerAttempt < 5_000) return
        lastOwnerAttempt = now
        // Reuse the sole main App underneath the native restriction.
        runCatching { context.startActivity(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
    }

    fun hide() {
        if (!visible && surface == null && legacyRoot == null) return
        visible = false
        ownerReady = false
        lastOwnerAttempt = -1L
        JunLuoPhoneActivityModule.emitPhoneLockChatVisibility(false)
        val old = surface
        val oldLegacy = legacyRoot
        val oldView = view
        surface = null
        legacyRoot = null
        (oldView?.parent as? ViewGroup)?.removeView(oldView)
        oldLegacy?.unmountReactApplication()
        old?.stop()
        container = null
    }
}
