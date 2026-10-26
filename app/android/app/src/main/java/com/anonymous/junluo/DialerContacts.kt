package com.anonymous.junluo

import android.Manifest
import android.app.Activity
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Looper
import android.os.PowerManager
import android.provider.ContactsContract.Contacts as Contacts
import android.provider.ContactsContract.CommonDataKinds.Phone as Phones
import android.telecom.TelecomManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.facebook.react.common.LifecycleState

/** Contacts and identities live only in the current bridge result; dispatch uses ACTION_DIAL. */
object DialerContacts {

    private fun hasPermission(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

    private fun names(context: Context, name: String, exact: Boolean): List<DialerContactPolicy.ContactName> {
        // SQLite NOCASE folds ASCII English only. The wildcard characters in names are literals.
        val display = "TRIM(${Contacts.DISPLAY_NAME_PRIMARY}, ?)"
        val selection = if (exact) "$display = ? COLLATE NOCASE" else "$display LIKE ? ESCAPE '\\'"
        val value = if (exact) name else DialerContactPolicy.literalSubstringPattern(name)
        return checkNotNull(context.contentResolver.query(Contacts.CONTENT_URI,
            arrayOf(Contacts._ID, Contacts.DISPLAY_NAME_PRIMARY), selection, arrayOf(DialerContactPolicy.TRIM_CHARACTERS, value),
            "${Contacts._ID} ASC")).use { cursor ->
            val id = cursor.getColumnIndexOrThrow(Contacts._ID)
            val displayName = cursor.getColumnIndexOrThrow(Contacts.DISPLAY_NAME_PRIMARY)
            buildList { while (cursor.moveToNext()) add(DialerContactPolicy.ContactName(
                cursor.getString(id), checkNotNull(cursor.getString(displayName)))) }
        }
    }

    private fun numbers(context: Context, contactId: String): List<DialerContactPolicy.PhoneRow> =
        checkNotNull(context.contentResolver.query(Phones.CONTENT_URI,
            arrayOf(Phones._ID, Phones.CONTACT_ID, Phones.NUMBER), "${Phones.CONTACT_ID} = ?", arrayOf(contactId),
            "${Phones._ID} ASC")).use { cursor ->
            val id = cursor.getColumnIndexOrThrow(Phones._ID)
            val contact = cursor.getColumnIndexOrThrow(Phones.CONTACT_ID)
            val number = cursor.getColumnIndexOrThrow(Phones.NUMBER)
            buildList { while (cursor.moveToNext()) add(DialerContactPolicy.PhoneRow(
                cursor.getString(id), cursor.getString(contact), cursor.getString(number).orEmpty())) }
        }

    fun query(context: Context, name: String): WritableMap {
        if (!hasPermission(context)) return listing(DialerContactPolicy.Listing(false, "CONTACT_PERMISSION_MISSING"))
        val result = DialerContactPolicy.query(name, { value, exact -> names(context, value, exact) },
            { id -> numbers(context, id) })
        // A permission revoked during a read is distinct from a provider failure.
        return listing(if (hasPermission(context)) result else DialerContactPolicy.Listing(false, "CONTACT_PERMISSION_MISSING"))
    }

    private fun listing(result: DialerContactPolicy.Listing): WritableMap = Arguments.createMap().apply {
        putBoolean("available", true)
        putBoolean("complete", result.complete)
        result.reason?.let { putString("reason", it) }
        result.match?.let { putString("match", it) }
        putInt("matchedContactCount", result.matchedContactCount)
        putArray("entries", Arguments.createArray().apply {
            result.entries.forEach { entry -> pushMap(Arguments.createMap().apply {
                putString("contactId", entry.contactId)
                putString("phoneRowId", entry.phoneRowId)
                putString("displayName", entry.displayName)
                putString("phoneNumber", entry.phoneNumber)
            }) }
        })
    }

    private fun opened(opened: Boolean, reason: String? = null): WritableMap = Arguments.createMap().apply {
        putBoolean("available", true)
        putBoolean("opened", opened)
        reason?.let { putString("reason", it) }
    }

    private fun binding(input: ReadableMap): DialerContactPolicy.Entry? = try {
        fun text(key: String): String {
            require(input.hasKey(key) && !input.isNull(key) && input.getType(key) == ReadableType.String)
            return checkNotNull(input.getString(key))
        }
        DialerContactPolicy.Entry(text("contactId"), text("phoneRowId"), text("displayName"), text("phoneNumber"))
            .takeIf { DialerContactPolicy.validEntry(it) }
    } catch (_: Exception) { null }

    private fun bindingBlockReason(context: Context, request: DialerContactPolicy.Entry): String? {
        if (!hasPermission(context)) return "CONTACT_PERMISSION_MISSING"
        return try {
            val contact = checkNotNull(context.contentResolver.query(Contacts.CONTENT_URI,
                arrayOf(Contacts._ID, Contacts.DISPLAY_NAME_PRIMARY), "${Contacts._ID} = ?",
                arrayOf(request.contactId), null)).use { cursor ->
                if (!cursor.moveToNext()) null else DialerContactPolicy.ContactName(
                    cursor.getString(cursor.getColumnIndexOrThrow(Contacts._ID)),
                    checkNotNull(cursor.getString(cursor.getColumnIndexOrThrow(Contacts.DISPLAY_NAME_PRIMARY))))
            }
            val row = checkNotNull(context.contentResolver.query(Phones.CONTENT_URI,
                arrayOf(Phones._ID, Phones.CONTACT_ID, Phones.NUMBER),
                "${Phones._ID} = ? AND ${Phones.CONTACT_ID} = ?", arrayOf(request.phoneRowId, request.contactId), null)).use { cursor ->
                if (!cursor.moveToNext()) null else DialerContactPolicy.PhoneRow(
                    cursor.getString(cursor.getColumnIndexOrThrow(Phones._ID)),
                    cursor.getString(cursor.getColumnIndexOrThrow(Phones.CONTACT_ID)),
                    cursor.getString(cursor.getColumnIndexOrThrow(Phones.NUMBER)).orEmpty())
            }
            if (!hasPermission(context)) "CONTACT_PERMISSION_MISSING"
            else if (DialerContactPolicy.bindingMatches(request, contact, row)) null else "CONTACT_CHANGED"
        } catch (_: Exception) {
            if (hasPermission(context)) "CONTACT_READ_FAILED" else "CONTACT_PERMISSION_MISSING"
        }
    }

    private fun hostBlockReason(context: ReactApplicationContext, activity: Activity?): String? = try {
        val power = checkNotNull(context.getSystemService(Context.POWER_SERVICE) as? PowerManager)
        val keyguard = checkNotNull(context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)
        AppLaunchEntryPolicy.hostBlockReason(context.lifecycleState == LifecycleState.RESUMED && activity != null &&
            !activity.isFinishing && !activity.isDestroyed, power.isInteractive,
            keyguard.isKeyguardLocked || keyguard.isDeviceLocked)
    } catch (_: Exception) { "HOST_STATE_UNAVAILABLE" }

    private fun component(context: Context, info: ResolveInfo?): DialerContactPolicy.DialComponent? = info?.activityInfo?.let {
        DialerContactPolicy.DialComponent(it.packageName, it.name, it.enabled && it.applicationInfo.enabled,
            it.exported, it.permission.isNullOrBlank() || context.checkSelfPermission(it.permission) == PackageManager.PERMISSION_GRANTED)
    }

    private fun defaultComponent(context: Context, number: String): DialerContactPolicy.DialComponent? {
        val telecom = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return null
        val defaultPackage = telecom.defaultDialerPackage ?: return null
        val intent = Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)).setPackage(defaultPackage)
        val manager = context.packageManager
        val resolved = component(context, manager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY))
        val candidates = manager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY).mapNotNull { component(context, it) }
        return DialerContactPolicy.confirmDialComponent(defaultPackage, resolved, candidates)
    }

    fun open(context: ReactApplicationContext, activity: Activity?, number: String, input: ReadableMap?): WritableMap {
        if (Looper.myLooper() != Looper.getMainLooper()) return opened(false, "HOST_STATE_UNAVAILABLE")
        if (DialerContactPolicy.normalizePhoneNumber(number) != number) return opened(false, "INVALID_PHONE_NUMBER")
        val request = if (input == null) null else binding(input) ?: return opened(false, "INVALID_CONTACT_BINDING")
        if (request != null && request.phoneNumber != number) return opened(false, "INVALID_CONTACT_BINDING")
        hostBlockReason(context, activity)?.let { return opened(false, it) }
        request?.let { bindingBlockReason(context, it)?.let { reason -> return opened(false, reason) } }
        val selected = try { defaultComponent(context, number) } catch (_: Exception) { null }
            ?: return opened(false, "DEFAULT_DIALER_UNAVAILABLE")
        request?.let { bindingBlockReason(context, it)?.let { reason -> return opened(false, reason) } }
        val current = try { defaultComponent(context, number) } catch (_: Exception) { null }
        if (current != selected) return opened(false, "DEFAULT_DIALER_CHANGED")
        hostBlockReason(context, activity)?.let { return opened(false, it) }
        val restriction = PhoneRestrictionRuntime.canLaunchApp(context, selected.packageName)
        if (!restriction.allowed) return opened(false, restriction.reason ?: "RESTRICTION_UNAVAILABLE")
        val intent = Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)).apply {
            component = ComponentName(selected.packageName, selected.className)
        }
        return try {
            checkNotNull(activity).startActivity(intent)
            // Android accepting the request is not proof of the screen or of a call being placed.
            opened(true)
        } catch (_: Exception) { opened(false, "DIAL_OUTCOME_UNKNOWN") }
    }
}
