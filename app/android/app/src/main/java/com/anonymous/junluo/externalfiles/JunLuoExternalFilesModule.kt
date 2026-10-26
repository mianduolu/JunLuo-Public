package com.anonymous.junluo.externalfiles

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.URLConnection
import java.security.MessageDigest
import java.util.Locale
import kotlin.concurrent.thread

class JunLuoExternalFilesModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "JunLuoExternalFiles"

    private val supportedImportExtensions = setOf("txt", "md", "markdown", "json", "csv", "zip", "epub")
    private val knownDocumentExtensions = supportedImportExtensions + setOf("pdf", "docx")

    @ReactMethod
    fun getStatus(promise: Promise) {
        try {
            promise.resolve(statusJson().toString())
        } catch (error: Exception) {
            promise.reject("EXTERNAL_FILES_STATUS_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun openAccessSettings(promise: Promise) {
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:${reactContext.packageName}")
                )
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${reactContext.packageName}"))
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (error: Exception) {
            try {
                val fallback = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactContext.startActivity(fallback)
                promise.resolve(true)
            } catch (fallbackError: Exception) {
                promise.reject("EXTERNAL_FILES_SETTINGS_FAILED", fallbackError.message, fallbackError)
            }
        }
    }

    @ReactMethod
    fun scanFiles(optionsJson: String, promise: Promise) {
        thread {
            try {
                if (!hasExternalAccess()) {
                    promise.resolve(errorJson("NO_EXTERNAL_ACCESS", "君落还没有全部文件访问权限").toString())
                    return@thread
                }
                val options = parseOptions(optionsJson)
                val startedAt = System.currentTimeMillis()
                val roots = getScanRoots()
                val files = JSONArray()
                val diagnostics = JSONArray()
                val visited = HashSet<String>()
                for ((tag, root) in roots) {
                    if (files.length() >= options.limit) break
                    if (!root.exists() || !root.canRead()) {
                        diagnostics.put(JSONObject().put("directoryTag", tag).put("path", root.absolutePath).put("status", "unavailable"))
                        continue
                    }
                    scanDirectory(root, tag, 0, options, files, diagnostics, visited, startedAt)
                }
                promise.resolve(
                    JSONObject()
                        .put("ok", true)
                        .put("files", files)
                        .put("diagnostics", diagnostics)
                        .put("scannedAt", System.currentTimeMillis())
                        .put("limit", options.limit)
                        .toString()
                )
            } catch (error: Exception) {
                promise.resolve(errorJson("SCAN_FAILED", error.message ?: "扫描外部文件失败").toString())
            }
        }
    }

    @ReactMethod
    fun getFileInfo(externalFileId: String, promise: Promise) {
        try {
            val file = fileFromId(externalFileId)
            if (!isReadableFile(file)) {
                promise.resolve(errorJson("FILE_NOT_FOUND", "没有找到这个外部文件").toString())
                return
            }
            promise.resolve(JSONObject().put("ok", true).put("file", summarizeFile(file, inferDirectoryTag(file))).toString())
        } catch (error: Exception) {
            promise.resolve(errorJson("FILE_INFO_FAILED", error.message ?: "读取外部文件信息失败").toString())
        }
    }

    @ReactMethod
    fun copyFileToCache(externalFileId: String, promise: Promise) {
        thread {
            try {
                val source = fileFromId(externalFileId)
                if (!isReadableFile(source)) {
                    promise.resolve(errorJson("FILE_NOT_FOUND", "没有找到这个外部文件").toString())
                    return@thread
                }
                val targetDir = File(reactContext.cacheDir, "external-file-imports")
                targetDir.mkdirs()
                val target = uniqueFile(targetDir, source.name)
                FileInputStream(source).use { input ->
                    FileOutputStream(target).use { output -> input.copyTo(output) }
                }
                promise.resolve(
                    JSONObject()
                        .put("ok", true)
                        .put("source", summarizeFile(source, inferDirectoryTag(source)))
                        .put("cacheUri", Uri.fromFile(target).toString())
                        .put("cachePath", target.absolutePath)
                        .put("copiedAt", System.currentTimeMillis())
                        .toString()
                )
            } catch (error: Exception) {
                promise.resolve(errorJson("COPY_FAILED", error.message ?: "复制外部文件失败").toString())
            }
        }
    }

    @ReactMethod
    fun scanManagedSyncContent(
        fileUri: String,
        maximumChunkBytes: Double,
        promise: Promise,
    ) {
        thread {
            try {
                val chunkBytes = maximumChunkBytes.toInt()
                if (
                    maximumChunkBytes != chunkBytes.toDouble()
                    || chunkBytes != 4 * 1024 * 1024
                ) {
                    throw IllegalArgumentException("sync object chunk size is invalid")
                }
                val file = managedSyncFileFromUri(fileUri)
                if (!isReadableFile(file)) {
                    throw IllegalArgumentException("sync object file is not readable")
                }
                val expectedBytes = file.length()
                val wholeDigest = MessageDigest.getInstance("SHA-256")
                val chunks = JSONArray()
                val buffer = ByteArray(chunkBytes)
                var plaintextBytes = 0L
                FileInputStream(file).use { input ->
                    while (true) {
                        var filled = 0
                        while (filled < buffer.size) {
                            val read = input.read(
                                buffer,
                                filled,
                                buffer.size - filled,
                            )
                            if (read < 0) break
                            if (read == 0) continue
                            filled += read
                        }
                        if (filled == 0) break
                        wholeDigest.update(buffer, 0, filled)
                        val chunkDigest = MessageDigest.getInstance("SHA-256")
                        chunkDigest.update(buffer, 0, filled)
                        chunks.put(
                            JSONObject()
                                .put("chunkIndex", chunks.length())
                                .put("plaintextBytes", filled)
                                .put(
                                    "plaintextSha256",
                                    base64Url(chunkDigest.digest()),
                                )
                        )
                        plaintextBytes += filled.toLong()
                    }
                }
                if (plaintextBytes != expectedBytes || file.length() != expectedBytes) {
                    throw IllegalStateException("sync object changed while scanning")
                }
                if (chunks.length() == 0) {
                    chunks.put(
                        JSONObject()
                            .put("chunkIndex", 0)
                            .put("plaintextBytes", 0)
                            .put(
                                "plaintextSha256",
                                base64Url(
                                    MessageDigest.getInstance("SHA-256")
                                        .digest(),
                                ),
                            )
                    )
                }
                promise.resolve(
                    JSONObject()
                        .put("ok", true)
                        .put("plaintextBytes", plaintextBytes)
                        .put(
                            "plaintextSha256",
                            base64Url(wholeDigest.digest()),
                        )
                        .put("chunks", chunks)
                        .toString()
                )
            } catch (error: Exception) {
                promise.resolve(
                    errorJson(
                        "SYNC_OBJECT_SCAN_FAILED",
                        error.message ?: "sync object scan failed",
                    ).toString()
                )
            }
        }
    }

    @ReactMethod
    fun sealManagedSyncChunk(optionsJson: String, promise: Promise) {
        thread {
            try {
                val options = JSONObject(optionsJson)
                val file = managedSyncFileFromUri(options.getString("fileUri"))
                if (!isReadableFile(file)) {
                    throw IllegalArgumentException("sync object file is not readable")
                }
                val objectId = options.getString("objectId")
                if (file.name != objectId) {
                    throw SecurityException("sync object route does not match managed file")
                }
                val chunkIndex = options.getInt("chunkIndex")
                val chunkBytes = options.getInt("chunkBytes")
                val plaintextBytes = options.getInt("plaintextBytes")
                if (chunkBytes != 4 * 1024 * 1024) {
                    throw IllegalArgumentException("sync object chunk size is invalid")
                }
                if (chunkIndex !in 0 until 100_000) {
                    throw IllegalArgumentException("sync object chunkIndex is invalid")
                }
                if (plaintextBytes !in 0..chunkBytes) {
                    throw IllegalArgumentException("sync object plaintextBytes is invalid")
                }
                val expectedFileBytes = file.length()
                val offset = Math.multiplyExact(chunkIndex.toLong(), chunkBytes.toLong())
                val end = Math.addExact(offset, plaintextBytes.toLong())
                if (
                    end > expectedFileBytes
                    || (plaintextBytes != chunkBytes && end != expectedFileBytes)
                ) {
                    throw IllegalArgumentException("sync object chunk range is invalid")
                }
                val plaintext = ByteArray(plaintextBytes)
                RandomAccessFile(file, "r").use { input ->
                    input.seek(offset)
                    input.readFully(plaintext)
                }
                if (file.length() != expectedFileBytes) {
                    throw IllegalStateException("sync object changed while sealing")
                }
                val sealed = JunLuoSyncObjectChunkCrypto.seal(
                    JunLuoSyncObjectChunkCrypto.Input(
                        vaultId = options.getString("vaultId"),
                        sourceDeviceId = options.getString("sourceDeviceId"),
                        objectId = objectId,
                        chunkIndex = chunkIndex,
                        keyId = options.getString("keyId"),
                        plaintext = plaintext,
                        expectedPlaintextSha256 = options.getString("plaintextSha256"),
                        objectEncryptionKey = decodeBase64UrlExact(
                            options.getString("objectEncryptionKey"), 32, "objectEncryptionKey"
                        ),
                        signingPrivateKey = decodeBase64UrlExact(
                            options.getString("signingPrivateKey"), 32, "signingPrivateKey"
                        ),
                    )
                )
                promise.resolve(
                    JSONObject()
                        .put("ok", true)
                        .put("protocolVersion", sealed.protocolVersion)
                        .put("vaultId", sealed.vaultId)
                        .put("sourceDeviceId", sealed.sourceDeviceId)
                        .put("objectId", sealed.objectId)
                        .put("chunkIndex", sealed.chunkIndex)
                        .put("keyId", sealed.keyId)
                        .put("nonce", sealed.nonce)
                        .put("ciphertext", sealed.ciphertext)
                        .put("ciphertextSha256", sealed.ciphertextSha256)
                        .put("signature", sealed.signature)
                        .toString()
                )
            } catch (error: Exception) {
                promise.resolve(
                    errorJson(
                        "SYNC_OBJECT_SEAL_FAILED",
                        error.message ?: "sync object seal failed",
                    ).toString()
                )
            }
        }
    }

    @ReactMethod
    fun openFile(externalFileId: String, promise: Promise) {
        try {
            val file = fileFromId(externalFileId)
            if (!isReadableFile(file)) {
                promise.resolve(errorJson("FILE_NOT_FOUND", "没有找到这个外部文件").toString())
                return
            }
            val uri = contentUriFor(file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mimeType(file))
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            reactContext.startActivity(Intent.createChooser(intent, "打开文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            promise.resolve(JSONObject().put("ok", true).put("file", summarizeFile(file, inferDirectoryTag(file))).toString())
        } catch (error: Exception) {
            promise.resolve(errorJson("OPEN_FAILED", error.message ?: "打开外部文件失败").toString())
        }
    }

    @ReactMethod
    fun shareFile(externalFileId: String, promise: Promise) {
        try {
            val file = fileFromId(externalFileId)
            if (!isReadableFile(file)) {
                promise.resolve(errorJson("FILE_NOT_FOUND", "没有找到这个外部文件").toString())
                return
            }
            val uri = contentUriFor(file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mimeType(file)
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            reactContext.startActivity(Intent.createChooser(intent, "分享文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            promise.resolve(JSONObject().put("ok", true).put("file", summarizeFile(file, inferDirectoryTag(file))).toString())
        } catch (error: Exception) {
            promise.resolve(errorJson("SHARE_FAILED", error.message ?: "分享外部文件失败").toString())
        }
    }

    @ReactMethod
    fun deleteFile(externalFileId: String, promise: Promise) {
        try {
            val file = fileFromId(externalFileId)
            if (!isReadableFile(file)) {
                promise.resolve(errorJson("FILE_NOT_FOUND", "没有找到这个外部文件").toString())
                return
            }
            val summary = summarizeFile(file, inferDirectoryTag(file))
            val deleted = file.delete()
            promise.resolve(JSONObject().put("ok", deleted).put("file", summary).put("deletedAt", System.currentTimeMillis()).toString())
        } catch (error: Exception) {
            promise.resolve(errorJson("DELETE_FAILED", error.message ?: "删除外部文件失败").toString())
        }
    }

    @ReactMethod
    fun overwriteFile(externalFileId: String, sourceCacheUri: String, promise: Promise) {
        thread {
            try {
                val target = fileFromId(externalFileId)
                val source = File(Uri.parse(sourceCacheUri).path ?: sourceCacheUri)
                if (!target.exists() || !target.canWrite()) {
                    promise.resolve(errorJson("FILE_NOT_WRITABLE", "外部文件不可写").toString())
                    return@thread
                }
                if (!source.exists() || !source.canRead()) {
                    promise.resolve(errorJson("SOURCE_NOT_FOUND", "没有找到用于覆盖的缓存文件").toString())
                    return@thread
                }
                FileInputStream(source).use { input -> FileOutputStream(target, false).use { output -> input.copyTo(output) } }
                promise.resolve(JSONObject().put("ok", true).put("file", summarizeFile(target, inferDirectoryTag(target))).put("overwrittenAt", System.currentTimeMillis()).toString())
            } catch (error: Exception) {
                promise.resolve(errorJson("OVERWRITE_FAILED", error.message ?: "覆盖外部文件失败").toString())
            }
        }
    }

    @ReactMethod
    fun moveFile(externalFileId: String, targetDirectoryTag: String, promise: Promise) {
        try {
            val source = fileFromId(externalFileId)
            val targetRoot = getScanRoots().firstOrNull { it.first == targetDirectoryTag }?.second
            if (!isReadableFile(source) || targetRoot == null || !targetRoot.exists()) {
                promise.resolve(errorJson("MOVE_TARGET_INVALID", "外部文件或目标目录不可用").toString())
                return
            }
            val target = uniqueFile(targetRoot, source.name)
            val moved = source.renameTo(target)
            promise.resolve(JSONObject().put("ok", moved).put("source", summarizeFile(source, inferDirectoryTag(source))).put("file", summarizeFile(target, targetDirectoryTag)).put("movedAt", System.currentTimeMillis()).toString())
        } catch (error: Exception) {
            promise.resolve(errorJson("MOVE_FAILED", error.message ?: "移动外部文件失败").toString())
        }
    }

    private fun parseOptions(raw: String): ScanOptions {
        val json = try { JSONObject(raw.ifBlank { "{}" }) } catch (_: Exception) { JSONObject() }
        val extensions = json.optJSONArray("extensions")?.let { array ->
            (0 until array.length()).mapNotNull { array.optString(it).lowercase(Locale.ROOT).trim('.').takeIf(String::isNotBlank) }.toSet()
        } ?: knownDocumentExtensions
        return ScanOptions(
            query = json.optString("query", "").lowercase(Locale.ROOT).trim(),
            extensions = extensions,
            limit = json.optInt("limit", 60).coerceIn(1, 200),
            maxDepth = json.optInt("maxDepth", 5).coerceIn(1, 8),
            maxFileSize = json.optLong("maxFileSize", 200L * 1024L * 1024L),
            timeoutMs = json.optLong("timeoutMs", 8000L).coerceIn(1000L, 30000L),
        )
    }

    private fun statusJson(): JSONObject {
        return JSONObject()
            .put("available", true)
            .put("platform", "android")
            .put("hasAllFilesAccess", hasExternalAccess())
            .put("sdkInt", Build.VERSION.SDK_INT)
            .put("scanRoots", JSONArray(getScanRoots().map { JSONObject().put("directoryTag", it.first).put("path", it.second.absolutePath).put("exists", it.second.exists()).put("canRead", it.second.canRead()) }))
    }

    private fun hasExternalAccess(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            reactContext.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun getScanRoots(): List<Pair<String, File>> {
        val external = Environment.getExternalStorageDirectory()
        return listOf(
            "download" to Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
            "documents" to Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
            "dcim" to Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM),
            "pictures" to Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
            "movies" to Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES),
            "music" to Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC),
            "qq_files" to File(external, "Tencent/QQfile_recv"),
            "qq_android_media" to File(external, "Android/media/com.tencent.mobileqq/Tencent/QQfile_recv"),
            "wechat_files" to File(external, "Tencent/MicroMsg/Download"),
            "wechat_android_media" to File(external, "Android/media/com.tencent.mm/MicroMsg/Download"),
        ).distinctBy { it.second.absolutePath }
    }

    private fun scanDirectory(
        directory: File,
        tag: String,
        depth: Int,
        options: ScanOptions,
        files: JSONArray,
        diagnostics: JSONArray,
        visited: MutableSet<String>,
        startedAt: Long,
    ) {
        if (files.length() >= options.limit) return
        if (depth > options.maxDepth) return
        if (System.currentTimeMillis() - startedAt > options.timeoutMs) {
            diagnostics.put(JSONObject().put("directoryTag", tag).put("path", directory.absolutePath).put("status", "timeout"))
            return
        }
        val canonical = try { directory.canonicalPath } catch (_: Exception) { directory.absolutePath }
        if (!visited.add(canonical)) return
        val children = directory.listFiles() ?: run {
            diagnostics.put(JSONObject().put("directoryTag", tag).put("path", directory.absolutePath).put("status", "unreadable"))
            return
        }
        for (child in children.sortedWith(compareBy<File> { !it.isDirectory }.thenByDescending { it.lastModified() })) {
            if (files.length() >= options.limit) return
            if (child.isDirectory) {
                if (!child.name.startsWith(".")) scanDirectory(child, tag, depth + 1, options, files, diagnostics, visited, startedAt)
                continue
            }
            if (!child.isFile || !child.canRead()) continue
            if (child.length() > options.maxFileSize) continue
            val extension = extensionOf(child.name)
            if (options.extensions.isNotEmpty() && extension !in options.extensions) continue
            val haystack = "${child.name} ${child.absolutePath}".lowercase(Locale.ROOT)
            if (options.query.isNotBlank() && !haystack.contains(options.query)) continue
            files.put(summarizeFile(child, tag))
        }
    }

    private fun summarizeFile(file: File, directoryTag: String): JSONObject {
        val extension = extensionOf(file.name)
        return JSONObject()
            .put("externalFileId", idForFile(file))
            .put("name", file.name)
            .put("extension", extension)
            .put("path", file.absolutePath)
            .put("directoryTag", directoryTag)
            .put("size", file.length())
            .put("modifiedAt", file.lastModified())
            .put("mimeType", mimeType(file))
            .put("importKind", when (extension) {
                "txt", "md", "markdown", "json", "csv" -> "text"
                "zip" -> "zip"
                "epub" -> "epub"
                "pdf", "docx" -> "raw"
                else -> "unsupported"
            })
    }

    private fun isReadableFile(file: File) = file.exists() && file.isFile && file.canRead()

    private fun inferDirectoryTag(file: File): String {
        val path = file.absolutePath
        return getScanRoots().firstOrNull { path.startsWith(it.second.absolutePath) }?.first ?: "external"
    }

    private fun mimeType(file: File): String {
        return URLConnection.guessContentTypeFromName(file.name) ?: when (extensionOf(file.name)) {
            "md", "markdown" -> "text/markdown"
            "json" -> "application/json"
            "csv" -> "text/csv"
            "epub" -> "application/epub+zip"
            "zip" -> "application/zip"
            "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            else -> "application/octet-stream"
        }
    }

    private fun extensionOf(name: String) = name.substringAfterLast('.', "").lowercase(Locale.ROOT)

    private fun idForFile(file: File): String {
        return android.util.Base64.encodeToString(file.absolutePath.toByteArray(Charsets.UTF_8), android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP)
    }

    private fun fileFromId(id: String): File {
        val decoded = String(android.util.Base64.decode(id, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP), Charsets.UTF_8)
        val file = File(decoded).canonicalFile
        if (getScanRoots().none { (_, root) -> isWithinRoot(file, root) }) {
            throw SecurityException("externalFileId is outside allowed roots")
        }
        return file
    }

    private fun managedSyncFileFromUri(fileUri: String): File {
        val uri = Uri.parse(fileUri)
        if (uri.scheme != "file") {
            throw SecurityException("sync object URI must use file scheme")
        }
        val file = File(
            uri.path ?: throw IllegalArgumentException("sync object URI has no path")
        ).canonicalFile
        val root = File(
            reactContext.filesDir,
            "junluo-sync-objects-v1",
        ).canonicalFile
        if (!isWithinRoot(file, root)) {
            throw SecurityException("sync object is outside the managed root")
        }
        return file
    }

    private fun base64Url(value: ByteArray): String {
        return android.util.Base64.encodeToString(
            value,
            android.util.Base64.URL_SAFE
                or android.util.Base64.NO_WRAP
                or android.util.Base64.NO_PADDING,
        )
    }

    private fun decodeBase64UrlExact(
        value: String,
        expectedBytes: Int,
        label: String,
    ): ByteArray {
        if (!Regex("^[A-Za-z0-9_-]+$").matches(value)) {
            throw IllegalArgumentException("$label is not base64url")
        }
        val decoded = android.util.Base64.decode(
            value,
            android.util.Base64.URL_SAFE
                or android.util.Base64.NO_WRAP
                or android.util.Base64.NO_PADDING,
        )
        if (decoded.size != expectedBytes) {
            throw IllegalArgumentException("$label length is invalid")
        }
        return decoded
    }

    private fun isWithinRoot(file: File, root: File): Boolean {
        val rootPath = root.canonicalFile.path.trimEnd(File.separatorChar)
        val filePath = file.path
        return filePath == rootPath || filePath.startsWith("$rootPath${File.separator}")
    }

    private fun contentUriFor(file: File): Uri {
        return FileProvider.getUriForFile(reactContext, "${reactContext.packageName}.fileprovider", file)
    }

    private fun uniqueFile(directory: File, name: String): File {
        val cleanName = name.replace(Regex("[<>:\"/\\\\|?*\\u0000-\\u001F]"), "_").ifBlank { "file" }
        val stem = cleanName.substringBeforeLast('.', cleanName)
        val extension = cleanName.substringAfterLast('.', "")
        var candidate = File(directory, cleanName)
        var index = 1
        while (candidate.exists()) {
            candidate = File(directory, if (extension.isBlank()) "${stem}_${index}" else "${stem}_${index}.${extension}")
            index += 1
        }
        return candidate
    }

    private fun errorJson(code: String, message: String): JSONObject {
        return JSONObject().put("ok", false).put("code", code).put("message", message)
    }

    private data class ScanOptions(
        val query: String,
        val extensions: Set<String>,
        val limit: Int,
        val maxDepth: Int,
        val maxFileSize: Long,
        val timeoutMs: Long,
    )
}
