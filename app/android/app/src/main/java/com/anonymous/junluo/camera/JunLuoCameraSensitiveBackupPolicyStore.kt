package com.anonymous.junluo.camera

import android.content.Context

internal data class JunLuoCameraSensitiveBackupPolicy(
    val schemaVersion: Int = 1,
    val consentGranted: Boolean,
    val updatedAt: Long?,
)

internal object JunLuoCameraSensitiveBackupPolicyStore {
    const val PREFERENCES_NAME = "junluo_camera_sensitive_backup_policy_v1"
    private const val KEY_CONSENT = "consent_granted"
    private const val KEY_UPDATED_AT = "updated_at"

    fun get(context: Context): JunLuoCameraSensitiveBackupPolicy {
        val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
        return JunLuoCameraSensitiveBackupPolicy(
            consentGranted = preferences.getBoolean(KEY_CONSENT, false),
            updatedAt = preferences.getLong(KEY_UPDATED_AT, 0L).takeIf { it > 0L },
        )
    }

    fun set(context: Context, consentGranted: Boolean, requestedAt: Long): Result<JunLuoCameraSensitiveBackupPolicy> {
        if (requestedAt <= 0L) return Result.failure(
            IllegalArgumentException(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD),
        )
        val committed = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_CONSENT, consentGranted).putLong(KEY_UPDATED_AT, requestedAt).commit()
        if (!committed) return Result.failure(
            IllegalStateException(JunLuoCameraServiceErrorCodes.SENSITIVE_BACKUP_POLICY_PERSIST_FAILED),
        )
        return Result.success(JunLuoCameraSensitiveBackupPolicy(consentGranted = consentGranted, updatedAt = requestedAt))
    }
}
