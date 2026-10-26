package com.anonymous.junluo.backup

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import kotlin.concurrent.thread

class JunLuoBackupArchiveModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "JunLuoBackupArchive"

    @ReactMethod
    fun createArchive(sourceDirectoryUri: String, targetArchiveUri: String, promise: Promise) {
        thread {
            try {
                val source = fileFromUri(sourceDirectoryUri).canonicalFile
                val target = fileFromUri(targetArchiveUri).canonicalFile
                if (!source.isDirectory) throw BackupArchiveException("BACKUP_FORMAT", "备份暂存目录不存在。")
                target.parentFile?.mkdirs()
                val temporary = File(target.parentFile, ".${target.name}.${System.nanoTime()}.tmp")
                var entries = 0
                var totalBytes = 0L
                try {
                    ZipOutputStream(BufferedOutputStream(FileOutputStream(temporary), BUFFER_SIZE)).use { output ->
                        output.setLevel(6)
                        val budget = ArchiveBudget()
                        source.listFiles()?.sortedBy { it.name }?.forEach { child ->
                            addToArchive(output, child, child.name, budget)
                        }
                        entries = budget.entryCount
                        totalBytes = budget.totalBytes
                    }
                    if (target.exists() && !target.delete()) {
                        throw BackupArchiveException("BACKUP_WRITE_FAILED", "无法替换旧的备份文件。")
                    }
                    if (!temporary.renameTo(target)) {
                        FileInputStream(temporary).use { input ->
                            FileOutputStream(target).use { output -> input.copyTo(output, BUFFER_SIZE) }
                        }
                        temporary.delete()
                    }
                    promise.resolve(
                        JSONObject()
                            .put("entryCount", entries)
                            .put("sourceBytes", totalBytes)
                            .put("archiveBytes", target.length())
                            .toString()
                    )
                } finally {
                    temporary.delete()
                }
            } catch (error: BackupArchiveException) {
                promise.reject(error.code, error.message, error)
            } catch (error: Exception) {
                promise.reject("BACKUP_CREATE_FAILED", error.message, error)
            }
        }
    }

    @ReactMethod
    fun extractArchive(sourceArchiveUri: String, targetDirectoryUri: String, promise: Promise) {
        thread {
            val target = try {
                fileFromUri(targetDirectoryUri).canonicalFile
            } catch (error: Exception) {
                promise.reject("BACKUP_FORMAT", error.message, error)
                return@thread
            }
            try {
                ensurePrivateCacheTarget(target)
                if (target.exists()) target.deleteRecursively()
                if (!target.mkdirs()) throw BackupArchiveException("BACKUP_WRITE_FAILED", "无法建立备份验货目录。")

                var entries = 0
                var totalBytes = 0L
                openInput(sourceArchiveUri).use { rawInput ->
                    ZipInputStream(BufferedInputStream(rawInput, BUFFER_SIZE)).use { input ->
                        var entry = input.nextEntry
                        while (entry != null) {
                            entries += 1
                            if (entries > MAX_ENTRY_COUNT) {
                                throw BackupArchiveException("BACKUP_FORMAT", "备份包里的文件数量异常，已经停止解压。")
                            }
                            val outputFile = safeOutputFile(target, entry)
                            if (entry.isDirectory) {
                                if (!outputFile.exists() && !outputFile.mkdirs()) {
                                    throw BackupArchiveException("BACKUP_WRITE_FAILED", "无法建立备份目录。")
                                }
                            } else {
                                outputFile.parentFile?.mkdirs()
                                var fileBytes = 0L
                                FileOutputStream(outputFile).use { output ->
                                    val buffer = ByteArray(BUFFER_SIZE)
                                    while (true) {
                                        val read = input.read(buffer)
                                        if (read < 0) break
                                        fileBytes += read
                                        totalBytes += read
                                        if (fileBytes > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
                                            throw BackupArchiveException("BACKUP_FORMAT", "备份包解压后的体积异常，已经停止解压。")
                                        }
                                        if (target.usableSpace < read + MIN_FREE_BYTES) {
                                            throw BackupArchiveException("BACKUP_DISK_SPACE", "手机可用空间不足，已经在覆盖数据前停止。")
                                        }
                                        output.write(buffer, 0, read)
                                    }
                                }
                            }
                            input.closeEntry()
                            entry = input.nextEntry
                        }
                    }
                }
                promise.resolve(
                    JSONObject()
                        .put("entryCount", entries)
                        .put("totalBytes", totalBytes)
                        .toString()
                )
            } catch (error: BackupArchiveException) {
                target.deleteRecursively()
                promise.reject(error.code, error.message, error)
            } catch (error: Exception) {
                target.deleteRecursively()
                promise.reject("BACKUP_EXTRACT_FAILED", error.message, error)
            }
        }
    }

    @ReactMethod
    fun validateDatabase(sourceDatabaseUri: String, promise: Promise) {
        thread {
            try {
                val source = fileFromUri(sourceDatabaseUri).canonicalFile
                ensurePrivateCacheFile(source)
                if (!source.isFile) {
                    throw BackupArchiveException("BACKUP_DATABASE_INVALID", "数据库文件不存在。")
                }
                val result = SQLiteDatabase.openDatabase(
                    source.absolutePath,
                    null,
                    SQLiteDatabase.OPEN_READONLY
                ).use { database ->
                    database.rawQuery("PRAGMA quick_check", null).use { cursor ->
                        if (cursor.moveToFirst()) cursor.getString(0) else ""
                    }
                }
                if (result != "ok") {
                    throw BackupArchiveException("BACKUP_DATABASE_INVALID", result.ifBlank { "quick_check did not return ok" })
                }
                promise.resolve(result)
            } catch (error: BackupArchiveException) {
                promise.reject(error.code, error.message, error)
            } catch (error: Exception) {
                promise.reject("BACKUP_DATABASE_INVALID", error.message, error)
            }
        }
    }

    @ReactMethod
    fun cleanupTemporaryFiles(promise: Promise) {
        thread {
            try {
                promise.resolve(cleanupStaleBackupCache(reactContext.cacheDir))
            } catch (error: Exception) {
                promise.reject("BACKUP_CLEANUP_FAILED", error.message, error)
            }
        }
    }
    @ReactMethod
    fun reloadApplication(promise: Promise) {
        reactContext.runOnUiQueueThread {
            try {
                val launchIntent = reactContext.packageManager
                    .getLaunchIntentForPackage(reactContext.packageName)
                    ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                    ?: throw IllegalStateException("无法找到君落启动入口。")
                val pendingIntent = PendingIntent.getActivity(
                    reactContext,
                    RESTART_REQUEST_CODE,
                    launchIntent,
                    PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val alarmManager = reactContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                alarmManager.set(
                    AlarmManager.ELAPSED_REALTIME,
                    SystemClock.elapsedRealtime() + RESTART_DELAY_MS,
                    pendingIntent,
                )
                promise.resolve(true)
                Handler(Looper.getMainLooper()).postDelayed(
                    { Process.killProcess(Process.myPid()) },
                    PROCESS_EXIT_DELAY_MS,
                )
            } catch (error: Exception) {
                promise.reject("BACKUP_RELOAD_FAILED", error.message, error)
            }
        }
    }

    private data class ArchiveBudget(var entryCount: Int = 0, var totalBytes: Long = 0L)

    private fun reserveArchiveEntry(budget: ArchiveBudget, fileBytes: Long) {
        if (budget.entryCount >= MAX_ENTRY_COUNT) {
            throw BackupArchiveException("BACKUP_CREATE_FAILED", "当前数据文件数量过多，无法生成可还原的君落备份。")
        }
        if (fileBytes < 0L || fileBytes > MAX_FILE_BYTES) {
            throw BackupArchiveException("BACKUP_CREATE_FAILED", "当前数据中有单个文件过大，无法生成可还原的君落备份。")
        }
        if (budget.totalBytes > MAX_TOTAL_BYTES - fileBytes) {
            throw BackupArchiveException("BACKUP_CREATE_FAILED", "当前数据总体积过大，无法生成可还原的君落备份。")
        }
        budget.entryCount += 1
        budget.totalBytes += fileBytes
    }

    private fun addToArchive(
        output: ZipOutputStream,
        file: File,
        archivePath: String,
        budget: ArchiveBudget
    ) {
        if (file.isDirectory) {
            val directoryPath = archivePath.trimEnd('/') + "/"
            reserveArchiveEntry(budget, 0L)
            output.putNextEntry(ZipEntry(directoryPath))
            output.closeEntry()
            file.listFiles()?.sortedBy { it.name }?.forEach { child ->
                addToArchive(output, child, "$directoryPath${child.name}", budget)
            }
            return
        }
        if (!file.isFile) return
        val fileBytes = file.length()
        reserveArchiveEntry(budget, fileBytes)
        output.putNextEntry(ZipEntry(archivePath))
        FileInputStream(file).use { input -> input.copyTo(output, BUFFER_SIZE) }
        output.closeEntry()
    }

    private fun safeOutputFile(target: File, entry: ZipEntry): File {
        val name = entry.name
        if (name.isBlank() || name.startsWith('/') || name.contains('\\') || name.indexOf('\u0000') >= 0) {
            throw BackupArchiveException("BACKUP_FORMAT", "备份包包含不安全的文件路径。")
        }
        val parts = name.split('/').filter { it.isNotEmpty() }
        if (parts.isEmpty() || parts.any { it == "." || it == ".." }) {
            throw BackupArchiveException("BACKUP_FORMAT", "备份包包含不安全的文件路径。")
        }
        val output = File(target, parts.joinToString(File.separator)).canonicalFile
        val rootPath = target.canonicalPath + File.separator
        if (!output.canonicalPath.startsWith(rootPath)) {
            throw BackupArchiveException("BACKUP_FORMAT", "备份包试图写出君落的验货目录。")
        }
        return output
    }

    private fun ensurePrivateCacheTarget(target: File) {
        val cacheRoot = reactContext.cacheDir.canonicalPath + File.separator
        if (!target.canonicalPath.startsWith(cacheRoot)) {
            throw BackupArchiveException("BACKUP_WRITE_FAILED", "备份只能解压到君落的私有缓存目录。")
        }
    }

    private fun ensurePrivateCacheFile(file: File) {
        val cacheRoot = reactContext.cacheDir.canonicalPath + File.separator
        if (!file.canonicalPath.startsWith(cacheRoot)) {
            throw BackupArchiveException("BACKUP_FORMAT", "数据库验货只能读取君落的私有缓存目录。")
        }
    }

    private fun openInput(uriValue: String): InputStream {
        val uri = Uri.parse(uriValue)
        return if (uri.scheme == "content") {
            reactContext.contentResolver.openInputStream(uri)
                ?: throw BackupArchiveException("BACKUP_FORMAT", "无法读取选择的备份文件。")
        } else {
            FileInputStream(fileFromUri(uriValue))
        }
    }

    private fun fileFromUri(uriValue: String): File {
        val uri = Uri.parse(uriValue)
        return when (uri.scheme) {
            null, "" -> File(uriValue)
            "file" -> File(uri.path ?: throw BackupArchiveException("BACKUP_FORMAT", "文件路径无效。"))
            else -> throw BackupArchiveException("BACKUP_FORMAT", "这个位置不能作为君落的私有文件目录。")
        }
    }

    private class BackupArchiveException(val code: String, message: String) : Exception(message)

    companion object {
        fun cleanupStaleBackupCache(cacheDirectory: File): Int {
            val cacheRoot = cacheDirectory.canonicalFile
            var deletedCount = 0
            cacheRoot.listFiles()?.forEach { candidate ->
                val canonical = candidate.canonicalFile
                val name = candidate.name
                val isOperationDirectory = candidate.isDirectory &&
                    (name.startsWith("junluo-backup-export-") || name.startsWith("junluo-backup-restore-"))
                val isCachedArchive = candidate.isFile &&
                    name.startsWith("JunLuo-backup-") && name.endsWith(".zip", ignoreCase = true)
                if (canonical.parentFile == cacheRoot && (isOperationDirectory || isCachedArchive)) {
                    val deleted = if (candidate.isDirectory) candidate.deleteRecursively() else candidate.delete()
                    if (deleted) deletedCount += 1
                }
            }

            val pickerDirectory = File(cacheRoot, "DocumentPicker").canonicalFile
            if (pickerDirectory.parentFile == cacheRoot && pickerDirectory.isDirectory) {
                pickerDirectory.listFiles()?.forEach { candidate ->
                    val canonical = candidate.canonicalFile
                    if (candidate.isFile && canonical.parentFile == pickerDirectory &&
                        candidate.name.endsWith(".zip", ignoreCase = true)
                    ) {
                        if (candidate.delete()) deletedCount += 1
                    }
                }
            }
            return deletedCount
        }

        private const val BUFFER_SIZE = 64 * 1024
        private const val RESTART_REQUEST_CODE = 17020
        private const val RESTART_DELAY_MS = 600L
        private const val PROCESS_EXIT_DELAY_MS = 150L
        private const val MAX_ENTRY_COUNT = 20_000
        private const val MAX_FILE_BYTES = 1024L * 1024L * 1024L
        private const val MAX_TOTAL_BYTES = 2L * 1024L * 1024L * 1024L
        private const val MIN_FREE_BYTES = 32L * 1024L * 1024L
    }
}
