package __PACKAGE_NAME__.camera

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest

internal data class JunLuoCameraManualSaveDestination(
    val configured: Boolean,
    val available: Boolean,
    val displayName: String?,
    val selectedAt: Long?,
)

internal sealed class JunLuoCameraManualSaveResult {
    data class Success(
        val fileName: String,
        val directoryDisplayName: String,
        val savedAt: Long,
        val byteLength: Long,
        val sha256: String,
    ) : JunLuoCameraManualSaveResult()

    data class Failure(val failureCode: String) : JunLuoCameraManualSaveResult()
}

internal object JunLuoCameraManualSaveStore {
    private const val STORE_NAME = "junluo_camera_manual_save_destination_v1"
    private const val KEY_TREE_URI = "tree_uri"
    private const val KEY_DISPLAY_NAME = "display_name"
    private const val KEY_SELECTED_AT = "selected_at"
    private val fileNamePattern = Regex("JunLuo-camera-[A-Za-z0-9._-]{1,150}\\.jpg")

    @Synchronized
    fun get(context: Context): JunLuoCameraManualSaveDestination {
        val preferences = context.getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE)
        val rawUri = preferences.getString(KEY_TREE_URI, null)
            ?: return JunLuoCameraManualSaveDestination(false, false, null, null)
        val uri = runCatching { Uri.parse(rawUri) }.getOrNull()
        if (uri == null || !hasPersistedWritePermission(context, uri) || !isTreeDocumentAvailable(context, uri)) {
            preferences.edit().clear().commit()
            return JunLuoCameraManualSaveDestination(false, false, null, null)
        }
        val displayName = preferences.getString(KEY_DISPLAY_NAME, null)
            ?.takeIf { it.isNotBlank() }
            ?: resolveDisplayName(context, uri)
        return JunLuoCameraManualSaveDestination(
            configured = true,
            available = true,
            displayName = displayName,
            selectedAt = preferences.getLong(KEY_SELECTED_AT, 0L).takeIf { it > 0L },
        )
    }

    @Synchronized
    fun set(context: Context, rawUri: String, selectedAt: Long): Result<JunLuoCameraManualSaveDestination> {
        val uri = runCatching { Uri.parse(rawUri) }.getOrNull()
            ?.takeIf { it.scheme == "content" }
            ?: return Result.failure(IllegalArgumentException(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD))
        if (!hasPersistedWritePermission(context, uri) || !isTreeDocumentAvailable(context, uri)) {
            return Result.failure(IllegalStateException(JunLuoCameraServiceErrorCodes.MANUAL_SAVE_PERMISSION_LOST))
        }
        val displayName = resolveDisplayName(context, uri)
        val committed = context.getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_TREE_URI, uri.toString())
            .putString(KEY_DISPLAY_NAME, displayName)
            .putLong(KEY_SELECTED_AT, selectedAt)
            .commit()
        if (!committed) {
            return Result.failure(IllegalStateException(JunLuoCameraServiceErrorCodes.STATE_PERSIST_FAILED))
        }
        return Result.success(JunLuoCameraManualSaveDestination(true, true, displayName, selectedAt))
    }

    @Synchronized
    fun clear(context: Context): Boolean =
        context.getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE).edit().clear().commit()

    fun save(
        context: Context,
        handle: JunLuoCameraBridgeFrameHandle,
        fileName: String,
        expectedByteLength: Long,
        expectedSha256: String,
        isCancelled: () -> Boolean,
    ): JunLuoCameraManualSaveResult {
        if (!fileNamePattern.matches(fileName) || expectedByteLength <= 0L || !expectedSha256.matches(Regex("[a-f0-9]{64}"))) {
            return JunLuoCameraManualSaveResult.Failure(JunLuoCameraServiceErrorCodes.INVALID_BRIDGE_PAYLOAD)
        }
        val preferences = context.getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE)
        val hadStoredDestination = preferences.contains(KEY_TREE_URI)
        val destination = get(context)
        if (!destination.configured) {
            val code = if (hadStoredDestination) {
                JunLuoCameraServiceErrorCodes.MANUAL_SAVE_PERMISSION_LOST
            } else {
                JunLuoCameraServiceErrorCodes.MANUAL_SAVE_DESTINATION_REQUIRED
            }
            return JunLuoCameraManualSaveResult.Failure(code)
        }
        val treeUri = preferences.getString(KEY_TREE_URI, null)?.let(Uri::parse)
            ?: return JunLuoCameraManualSaveResult.Failure(JunLuoCameraServiceErrorCodes.MANUAL_SAVE_DESTINATION_REQUIRED)
        if (!hasPersistedWritePermission(context, treeUri)) {
            clear(context)
            return JunLuoCameraManualSaveResult.Failure(JunLuoCameraServiceErrorCodes.MANUAL_SAVE_PERMISSION_LOST)
        }
        if (isCancelled()) {
            return JunLuoCameraManualSaveResult.Failure(JunLuoCameraServiceErrorCodes.MANUAL_SAVE_CANCELLED)
        }

        val resolver = context.contentResolver
        val parentUri = runCatching {
            DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri))
        }.getOrNull() ?: return JunLuoCameraManualSaveResult.Failure(JunLuoCameraServiceErrorCodes.MANUAL_SAVE_PERMISSION_LOST)
        val outputUri = runCatching {
            DocumentsContract.createDocument(resolver, parentUri, "image/jpeg", fileName)
        }.getOrNull() ?: return JunLuoCameraManualSaveResult.Failure(JunLuoCameraServiceErrorCodes.MANUAL_SAVE_CREATE_FAILED)

        try {
            val descriptor = resolver.openFileDescriptor(outputUri, "w")
                ?: return failAndDelete(context, outputUri, JunLuoCameraServiceErrorCodes.MANUAL_SAVE_WRITE_FAILED)
            descriptor.use { parcel ->
                FileInputStream(handle.file).use { input ->
                    FileOutputStream(parcel.fileDescriptor).use { output ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        while (true) {
                            if (isCancelled()) throw ManualSaveCancelledException()
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                        }
                        output.flush()
                        parcel.fileDescriptor.sync()
                    }
                }
            }
        } catch (_: ManualSaveCancelledException) {
            return failAndDelete(context, outputUri, JunLuoCameraServiceErrorCodes.MANUAL_SAVE_CANCELLED)
        } catch (_: Throwable) {
            return failAndDelete(context, outputUri, JunLuoCameraServiceErrorCodes.MANUAL_SAVE_WRITE_FAILED)
        }

        val verification = runCatching {
            val digest = MessageDigest.getInstance("SHA-256")
            var length = 0L
            resolver.openInputStream(outputUri)?.use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    if (isCancelled()) throw ManualSaveCancelledException()
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                    length += read
                }
            } ?: error("destination_unreadable")
            length to digest.digest().joinToString("") { "%02x".format(it) }
        }.getOrElse {
            val code = if (it is ManualSaveCancelledException) {
                JunLuoCameraServiceErrorCodes.MANUAL_SAVE_CANCELLED
            } else {
                JunLuoCameraServiceErrorCodes.MANUAL_SAVE_VERIFICATION_FAILED
            }
            return failAndDelete(context, outputUri, code)
        }
        if (verification.first != expectedByteLength || verification.second != expectedSha256) {
            return failAndDelete(context, outputUri, JunLuoCameraServiceErrorCodes.MANUAL_SAVE_VERIFICATION_FAILED)
        }
        return JunLuoCameraManualSaveResult.Success(
            fileName = fileName,
            directoryDisplayName = destination.displayName ?: "已选择的文件夹",
            savedAt = System.currentTimeMillis(),
            byteLength = verification.first,
            sha256 = verification.second,
        )
    }

    private fun hasPersistedWritePermission(context: Context, uri: Uri): Boolean =
        context.contentResolver.persistedUriPermissions.any { permission ->
            permission.uri == uri && permission.isReadPermission && permission.isWritePermission
        }

    private fun isTreeDocumentAvailable(context: Context, treeUri: Uri): Boolean {
        val documentUri = runCatching {
            DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri))
        }.getOrNull() ?: return false
        return runCatching {
            context.contentResolver.query(
                documentUri,
                arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID),
                null,
                null,
                null,
            )?.use { cursor ->
                cursor.moveToFirst() && !cursor.getString(0).isNullOrBlank()
            } == true
        }.getOrDefault(false)
    }

    private fun resolveDisplayName(context: Context, treeUri: Uri): String {
        val documentUri = runCatching {
            DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri))
        }.getOrNull()
        val queried = documentUri?.let { uri ->
            runCatching {
                context.contentResolver.query(
                    uri,
                    arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                    null,
                    null,
                    null,
                )?.use { cursor ->
                    if (cursor.moveToFirst()) cursor.getString(0)?.trim()?.takeIf { it.isNotBlank() } else null
                }
            }.getOrNull()
        }
        return queried ?: "已选择的文件夹"
    }

    private fun failAndDelete(context: Context, uri: Uri, code: String): JunLuoCameraManualSaveResult.Failure {
        runCatching { DocumentsContract.deleteDocument(context.contentResolver, uri) }
        return JunLuoCameraManualSaveResult.Failure(code)
    }

    private class ManualSaveCancelledException : RuntimeException()
}
