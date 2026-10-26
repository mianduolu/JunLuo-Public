package com.anonymous.junluo.camera

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.text.DateFormat
import java.util.Date
import java.util.UUID

class JunLuoCameraServiceDebugActivity : ComponentActivity() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var permissionText: TextView
    private lateinit var snapshotText: TextView
    private lateinit var receiptText: TextView
    private lateinit var startFrontButton: Button
    private lateinit var startBackButton: Button
    private lateinit var stopButton: Button
    private lateinit var captureButton: Button
    private lateinit var backgroundCaptureButton: Button
    private lateinit var notificationButton: Button
    private var delayedReceipt = "暂无"

    private val refreshRunnable = object : Runnable {
        override fun run() {
            refreshState()
            mainHandler.postDelayed(this, 1_000L)
        }
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        refreshState()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildContent())
        refreshState()
    }

    override fun onResume() {
        super.onResume()
        mainHandler.removeCallbacks(refreshRunnable)
        mainHandler.post(refreshRunnable)
    }

    override fun onPause() {
        mainHandler.removeCallbacks(refreshRunnable)
        super.onPause()
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun buildContent(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 56, 40, 56)
            setBackgroundColor(Color.rgb(255, 248, 244))
        }
        content.addView(text("Camera FGS 第五章验收", 30f, true).apply { gravity = Gravity.CENTER })
        content.addView(text("Debug APK 原生页；进入页面不会申请权限、启动观察会话或打开摄像头。", 16f, false))
        permissionText = text("", 17f, false)
        snapshotText = text("", 17f, false)
        receiptText = text("技术回执：暂无", 15f, false)
        content.addView(permissionText)
        content.addView(snapshotText)

        val startRow = horizontalRow()
        startFrontButton = button("开始前置会话") { startSession(JunLuoCameraFacing.FRONT) }
        startBackButton = button("开始后置会话") { startSession(JunLuoCameraFacing.BACK) }
        startRow.addView(startFrontButton, weightedParams())
        startRow.addView(startBackButton, weightedParams())
        content.addView(startRow)

        val controlRow = horizontalRow()
        stopButton = button("立即停止") {
            JunLuoCameraSessionServiceController.stop(this, "debug_stop")
            delayedReceipt = "已发送停止命令"
            refreshState()
        }
        controlRow.addView(stopButton, weightedParams())
        controlRow.addView(button("刷新状态") { refreshState() }, weightedParams())
        content.addView(controlRow)

        val captureRow = horizontalRow()
        captureButton = button("按需抓拍一次") { runOnDemandCaptureTest(0L, false) }
        backgroundCaptureButton = button("后台延迟按需抓拍") {
            runOnDemandCaptureTest(5_000L, true)
        }
        captureRow.addView(captureButton, weightedParams())
        captureRow.addView(backgroundCaptureButton, weightedParams())
        content.addView(captureRow)

        notificationButton = button("授予通知权限／打开通知设置") { handleNotificationAction() }
        content.addView(notificationButton, fullWidthParams())
        content.addView(button("延迟后台启动测试") { runDelayedBackgroundStartTest() }, fullWidthParams())
        content.addView(receiptText)

        return ScrollView(this).apply { addView(content) }
    }

    private fun startSession(facing: JunLuoCameraFacing) {
        val now = System.currentTimeMillis()
        val receipt = JunLuoCameraSessionServiceController.startFromVisibleActivity(
            this,
            JunLuoCameraServiceStartRequest(
                sessionId = "chapter5-${UUID.randomUUID()}",
                facing = facing,
                requestedAt = now,
                hardDeadlineAt = now + 2 * 60 * 60 * 1_000L,
                lastSuccessfulObservationAt = null,
            ),
        )
        delayedReceipt = formatReceipt(receipt)
        refreshState()
    }

    private fun runDelayedBackgroundStartTest() {
        val now = System.currentTimeMillis()
        val request = JunLuoCameraServiceStartRequest(
            sessionId = "chapter5-background-${UUID.randomUUID()}",
            facing = JunLuoCameraFacing.FRONT,
            requestedAt = now,
            hardDeadlineAt = null,
            lastSuccessfulObservationAt = null,
        )
        delayedReceipt = "等待 Activity 进入后台后执行…"
        refreshState()
        moveTaskToBack(true)
        mainHandler.postDelayed({
            delayedReceipt = formatReceipt(
                JunLuoCameraSessionServiceController.startFromVisibleActivity(this, request),
            )
        }, 1_500L)
    }

    private fun runOnDemandCaptureTest(delayMs: Long, moveToBackground: Boolean) {
        val snapshot = JunLuoCameraSessionServiceController.readSnapshot(this)
        val sessionId = snapshot.sessionId ?: run {
            delayedReceipt = "accepted=false, failureCode=${JunLuoCameraErrorCodes.NOT_RUNNING}"
            refreshState()
            return
        }
        val receipt = JunLuoCameraSessionServiceController.captureOnceForDebug(
            this,
            JunLuoCameraServiceCaptureRequest(
                sessionId = sessionId,
                requestId = "chapter5-capture-${UUID.randomUUID()}",
                requestedAt = System.currentTimeMillis(),
            ),
            delayMs,
        )
        delayedReceipt = formatReceipt(receipt)
        refreshState()
        if (moveToBackground && receipt is JunLuoCameraServiceCommandReceipt.Accepted) {
            moveTaskToBack(true)
        }
    }

    private fun handleNotificationAction() {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        startActivity(JunLuoCameraServiceNotifications.openSettingsIntent(this))
    }

    private fun refreshState() {
        JunLuoCameraServiceNotifications.ensureChannel(this)
        val cameraGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.CAMERA,
        ) == PackageManager.PERMISSION_GRANTED
        val notificationGranted = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        val notificationFailure = JunLuoCameraServiceNotifications.visibilityFailure(this)
        permissionText.text = buildString {
            append("\nCAMERA：")
            append(if (cameraGranted) "已授权" else "未授权（请先到 App 的“白云的视线”授权）")
            append("\n通知权限：")
            append(if (notificationGranted) "已授权" else "未授权")
            append("\n通知渠道：")
            append(if (notificationFailure == null) "可见" else notificationFailure)
        }

        val snapshot = JunLuoCameraSessionServiceController.readSnapshot(this)
        snapshotText.text = buildString {
            append("\nsessionId：${snapshot.sessionId ?: "暂无"}")
            append("\nrevision：${snapshot.revision}")
            append("\n状态：${snapshot.status}")
            append("\n镜头：${snapshot.sourceKind ?: "暂无"}")
            append("\n相机占用状态：${snapshot.cameraState}")
            append("\ncameraReady（仅实际打开时为 true）：${snapshot.cameraReady}")
            append("\n当前抓拍请求：${snapshot.activeCaptureRequestId ?: "暂无"}")
            append("\n上次抓拍请求：${snapshot.lastCaptureRequestId ?: "暂无"}")
            append("\n上次抓拍完成：${formatTime(snapshot.lastCaptureCompletedAt)}")
            append("\n上次抓拍成功：${snapshot.lastCaptureSucceeded ?: "暂无"}")
            append("\n上次抓拍字节数：${snapshot.lastCaptureByteLength ?: "暂无"}")
            append("\n上次抓拍失败码：${snapshot.lastCaptureFailureCode ?: "暂无"}")
            append("\n通知可见：${snapshot.persistentNotificationVisible}")
            append("\nstartedAt：${formatTime(snapshot.startedAt)}")
            append("\nheartbeat：${formatTime(snapshot.lastHeartbeatAt)}")
            append("\nhard deadline：${formatTime(snapshot.hardDeadlineAt)}")
            append("\n最近成功时间：${formatTime(snapshot.lastSuccessfulObservationAt)}")
            append("\n失败码：${snapshot.lastFailureCode ?: "暂无"}")
            append("\n停止原因：${snapshot.stopReasonCode ?: "暂无"}")
        }
        receiptText.text = "\n技术回执：$delayedReceipt"

        val active = isActiveCameraServiceStatus(snapshot.status)
        startFrontButton.isEnabled = cameraGranted && notificationFailure == null && !active
        startBackButton.isEnabled = cameraGranted && notificationFailure == null && !active
        stopButton.isEnabled = active
        val canCapture = snapshot.status == JunLuoCameraServiceStatus.RUNNING &&
            snapshot.cameraState == JunLuoCameraServiceCameraState.IDLE &&
            snapshot.activeCaptureRequestId == null
        captureButton.isEnabled = cameraGranted && notificationFailure == null && canCapture
        backgroundCaptureButton.isEnabled = cameraGranted && notificationFailure == null && canCapture
        notificationButton.text = if (!notificationGranted) {
            "授予通知权限"
        } else {
            "打开通知设置"
        }
    }

    private fun formatReceipt(receipt: JunLuoCameraServiceCommandReceipt): String = when (receipt) {
        is JunLuoCameraServiceCommandReceipt.Accepted ->
            "accepted=true, sessionId=${receipt.sessionId}, status=${receipt.status}, revision=${receipt.revision}"
        is JunLuoCameraServiceCommandReceipt.Rejected ->
            "accepted=false, failureCode=${receipt.failureCode}"
    }

    private fun formatTime(value: Long?): String = value?.let {
        DateFormat.getDateTimeInstance().format(Date(it))
    } ?: "暂无"

    private fun text(value: String, size: Float, bold: Boolean) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(Color.rgb(48, 48, 48))
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(0, 12, 0, 12)
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun horizontalRow() = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(0, 12, 0, 0)
    }

    private fun weightedParams() = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
        marginEnd = 10
    }

    private fun fullWidthParams() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT,
    ).apply { topMargin = 12 }
}
