package com.anonymous.junluo

import java.util.TimeZone

/** Decisions for this explicit launch path only; no storage, cross-user IDs or side effects. */
object AppLaunchEntryPolicy {
    private const val APP_DETAILS_ACTIVITY = "android.app.AppDetailsActivity"
    data class Identity(val packageName: String, val componentName: String, val profileSerial: String)
    data class Entry(val identity: Identity, val isCurrentProfile: Boolean, val title: String,
                     val profileType: String? = null, val badgeLabel: String? = null, val iconUri: String? = null)
    data class Listing(val entries: List<Entry>, val complete: Boolean)
    data class LaunchCheck(val allowed: Boolean, val reason: String? = null)

    fun validIdentity(value: Identity): Boolean {
        val serial = value.profileSerial.toLongOrNull() ?: return false
        if (serial < 0 || serial.toString() != value.profileSerial || value.packageName.isBlank()) return false
        val parts = value.componentName.split('/')
        if (parts.size != 2 || parts[0] != value.packageName || parts[1].isBlank()) return false
        val activity = if (parts[1].startsWith('.')) parts[0] + parts[1] else parts[1]
        // Android Q+ may synthesize this redirect to app settings, even enabled/exported.
        return activity != APP_DETAILS_ACTIVITY
    }

    fun <P> collect(profiles: List<P>, query: (P) -> List<Entry>): Listing {
        var complete = profiles.isNotEmpty()
        val entries = mutableListOf<Entry>()
        profiles.forEach { profile ->
            try { entries.addAll(query(profile).filter { validIdentity(it.identity) }) }
            catch (_: Exception) { complete = false }
        }
        return Listing(entries.distinctBy { it.identity.profileSerial to it.identity.componentName }
            .sortedWith(compareBy({ it.title }, { it.identity.profileSerial }, { it.identity.componentName })), complete)
    }

    fun exactIdentity(request: Identity, entries: List<Entry>): Identity? =
        if (!validIdentity(request)) null else entries.singleOrNull { it.identity == request }?.identity

    fun badgeLabel(type: String?): String? = when {
        type == "android.os.usertype.profile.CLONE" -> "分身"
        type?.startsWith("android.os.usertype.full.") == true -> "原版"
        // MANAGED may also back OEM dual apps. Neither its name nor another profile proves a variant.
        else -> null
    }

    fun systemTitle(label: CharSequence?): String? = label?.toString()?.takeIf { it.isNotBlank() }

    fun hostBlockReason(foreground: Boolean, interactive: Boolean, locked: Boolean): String? = when {
        !foreground -> "HOST_NOT_FOREGROUND"
        !interactive -> "DEVICE_NOT_INTERACTIVE"
        locked -> "DEVICE_LOCKED"
        else -> null
    }

    data class FocusRead(val ordinaryUsedMs: Long, val dailyUsedMs: Long,
                         val ordinaryLimitMs: Long, val dailyLimitMs: Long, val appLock: Boolean,
                         val returnSameRule: Boolean, val returnAt: Long, val returnWindowMs: Long)
    fun focusBlocked(value: FocusRead, now: Long): Boolean =
        value.dailyUsedMs >= value.dailyLimitMs ||
            PhoneFocusPolicy.returnEligible(value.returnSameRule, value.returnAt, value.returnWindowMs, now) ||
            PhoneFocusPolicy.display(false, 0, value.ordinaryUsedMs >= value.ordinaryLimitMs,
                value.appLock && value.ordinaryUsedMs >= value.ordinaryLimitMs) != null

    data class RestrictionRead(val state: PhoneRestrictionInstances.State,
                               val emergency: PhoneRestrictionPolicy.Emergency? = null,
                               val durationsKnown: Boolean = true, val restoring: Boolean = false,
                               val focus: FocusRead? = null, val appRestrictionExempt: Boolean = false)

    fun restrictionBlockReason(read: () -> RestrictionRead, packageName: String, now: Long,
                               zone: TimeZone): String? = try {
        val value = read()
        if (value.restoring || !value.durationsKnown || !value.state.configurationKnown) "RESTRICTION_UNAVAILABLE"
        else {
            // Same calendar projection as the collector, but never save/reconcile or acknowledge entry.
            val state = PhoneRestrictionPlans.advance(value.state, now, zone)
            val released = state.paused || PhoneRestrictionPolicy.isEmergencyActive(value.emergency, now) ||
                PhoneRestrictionInstances.isAppReleased(state, packageName, now)
            val phoneBlocked = PhoneRestrictionInstances.phoneBlockingRecords(state, packageName, now,
                value.emergency).isNotEmpty()
            val appBlocked = !value.appRestrictionExempt && (
                PhoneRestrictionInstances.appBlockingRecords(state, packageName, now, value.emergency).isNotEmpty() ||
                    (!released && PhoneRestrictionPlans.appTimeBlocked(state, packageName, now, zone)))
            if (phoneBlocked || appBlocked || (!released && value.focus?.let { focusBlocked(it, now) } == true))
                "APP_RESTRICTED" else null
        }
    } catch (_: Exception) { "RESTRICTION_UNAVAILABLE" }
}
