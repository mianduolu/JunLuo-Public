package __PACKAGE_NAME__.camera

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.text.DateFormat
import java.util.Date
import java.util.UUID

class JunLuoCameraDebugActivity : ComponentActivity() {
    private lateinit var cameraCore: JunLuoCameraCore
    private lateinit var previewView: PreviewView
    private lateinit var permissionText: TextView
    private lateinit var stateText: TextView
    private lateinit var detailText: TextView
    private lateinit var receiptText: TextView
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var switchButton: Button
    private lateinit var captureButton: Button
    private lateinit var captureImage: ImageView

    private var currentFacing = JunLuoCameraFacing.FRONT
    private var currentCaptureFile: File? = null
    private var displayedBitmap: Bitmap? = null
    private var latestSnapshot = JunLuoCameraSnapshot(
        state = JunLuoCameraCoreState.STOPPED,
        facing = null,
        previewStreaming = false,
        requestedPreviewFps = null,
        previewWidth = null,
        previewHeight = null,
        captureWidth = null,
        captureHeight = null,
        lastFailureCode = null,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        cameraCore = JunLuoCameraCore(applicationContext)
        setContentView(buildContentView())
        updatePermissionState()
        renderSnapshot(latestSnapshot)
    }

    override fun onStart() {
        super.onStart()
        updatePermissionState()
    }

    override fun onStop() {
        cameraCore.stop("debug_activity_stopped")
        clearCurrentCapture()
        super.onStop()
    }

    override fun onDestroy() {
        clearCurrentCapture()
        cameraCore.release()
        super.onDestroy()
    }

    private fun buildContentView(): ScrollView {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(Color.rgb(250, 244, 236))
            isFillViewport = true
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(32))
        }
        scroll.addView(content, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

        content.addView(textView("CameraX 第四章验收", 24f, true).apply {
            gravity = Gravity.CENTER_HORIZONTAL
        })
        content.addView(textView("Debug APK 原生页；进入页面不会申请权限或启动摄像头。", 13f, false))

        permissionText = textView("摄像头权限：检查中", 15f, true)
        stateText = textView("状态：未启动", 16f, true)
        detailText = textView("镜头：前置", 13f, false)
        content.addView(permissionText)
        content.addView(stateText)
        content.addView(detailText)

        previewView = PreviewView(this).apply {
            setBackgroundColor(Color.rgb(16, 18, 20))
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FIT_CENTER
        }
        content.addView(
            previewView,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(340)).apply {
                topMargin = dp(12)
                bottomMargin = dp(12)
            },
        )

        val firstButtons = horizontalRow()
        startButton = actionButton("开始预览") { startPreview() }
        stopButton = actionButton("停止并释放") { stopPreview() }
        firstButtons.addView(startButton, weightedButtonParams())
        firstButtons.addView(stopButton, weightedButtonParams(leftMargin = dp(8)))
        content.addView(firstButtons)

        val secondButtons = horizontalRow()
        switchButton = actionButton("切换为后置") { switchCamera() }
        captureButton = actionButton("单次抓拍") { captureOnce() }
        secondButtons.addView(switchButton, weightedButtonParams())
        secondButtons.addView(captureButton, weightedButtonParams(leftMargin = dp(8)))
        content.addView(secondButtons)

        content.addView(textView("当前抓拍缩略图", 15f, true).apply { setPadding(0, dp(16), 0, dp(8)) })
        captureImage = ImageView(this).apply {
            setBackgroundColor(Color.rgb(230, 224, 216))
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "当前单次抓拍缩略图"
        }
        content.addView(captureImage, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(260)))

        content.addView(textView("技术回执", 15f, true).apply { setPadding(0, dp(16), 0, dp(8)) })
        receiptText = textView("暂无抓拍回执。", 12f, false).apply {
            setTextIsSelectable(true)
            setBackgroundColor(Color.rgb(242, 235, 226))
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }
        content.addView(receiptText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return scroll
    }

    private fun startPreview() {
        updatePermissionState()
        if (!hasCameraPermission()) {
            receiptText.text = "camera_permission_required\n请先返回 App 的“白云的视线”授予摄像头权限。"
            return
        }
        cameraCore.start(
            owner = this,
            targetPreviewView = previewView,
            requestedFacing = currentFacing,
            targetListener = JunLuoCameraCoreListener(::renderSnapshot),
        ) { receipt ->
            receiptText.text = when (receipt) {
                is JunLuoCameraStartReceipt.Success -> buildString {
                    appendLine("startSucceeded=true")
                    appendLine("facing=${receipt.facing.name.lowercase()}")
                    appendLine("preview=${formatSize(receipt.previewWidth, receipt.previewHeight)}")
                    appendLine("capture=${formatSize(receipt.captureWidth, receipt.captureHeight)}")
                    append("requestedFps=${receipt.requestedPreviewFps ?: "device_default"}")
                }
                is JunLuoCameraStartReceipt.Failure -> "startSucceeded=false\nfailureCode=${receipt.failureCode}"
            }
        }
    }

    private fun stopPreview() {
        val receipt = cameraCore.stop("debug_stop_button")
        clearCurrentCapture()
        receiptText.text = "stopped=${receipt.stopped}\nreasonCode=${receipt.reasonCode}"
    }

    private fun switchCamera() {
        val target = if (currentFacing == JunLuoCameraFacing.FRONT) JunLuoCameraFacing.BACK else JunLuoCameraFacing.FRONT
        cameraCore.switchFacing(target) { receipt ->
            receiptText.text = when (receipt) {
                is JunLuoCameraSwitchReceipt.Success -> {
                    currentFacing = receipt.facing
                    "switched=true\nsourceKind=${receipt.sourceKind}\noccurredAt=${formatTime(receipt.occurredAt)}"
                }
                is JunLuoCameraSwitchReceipt.Failure -> "switched=false\nfailureCode=${receipt.failureCode}"
            }
            updateButtons()
        }
    }

    private fun captureOnce() {
        clearCurrentCapture()
        val directory = File(cacheDir, "junluo-camera/chapter4-debug")
        val requestId = UUID.randomUUID().toString()
        val outputFile = File(directory, "$requestId.jpg")
        cameraCore.captureOnce(requestId, outputFile) { result ->
            when (result) {
                is JunLuoCameraCaptureResult.Success -> {
                    currentCaptureFile = outputFile
                    showCaptureThumbnail(result)
                    receiptText.text = buildString {
                        appendLine("captureSucceeded=true")
                        appendLine("requestId=${result.requestId}")
                        appendLine("sourceKind=${result.sourceKind}")
                        appendLine("capturedAt=${formatTime(result.capturedAt)}")
                        appendLine("temporaryPath=${result.temporaryPath}")
                        appendLine("encoded=${result.encodedWidth}x${result.encodedHeight}")
                        appendLine("visible=${result.width}x${result.height}")
                        appendLine("rotation=${result.rotation}")
                        appendLine("mirrored=${result.mirrored}")
                        appendLine("byteLength=${result.byteLength}")
                        append("sha256=${result.sha256}")
                    }
                }
                is JunLuoCameraCaptureResult.Failure -> {
                    outputFile.delete()
                    receiptText.text = "captureSucceeded=false\nrequestId=${result.requestId}\nfailureCode=${result.failureCode}"
                }
            }
        }
    }

    private fun renderSnapshot(snapshot: JunLuoCameraSnapshot) {
        latestSnapshot = snapshot
        snapshot.facing?.let { currentFacing = it }
        stateText.text = "状态：${stateLabel(snapshot.state)}"
        detailText.text = buildString {
            appendLine("镜头：${if (currentFacing == JunLuoCameraFacing.FRONT) "前置" else "后置"}")
            appendLine("预览流：${if (snapshot.previewStreaming) "正在输出" else "未输出"}")
            appendLine("预览尺寸：${formatSize(snapshot.previewWidth, snapshot.previewHeight)}")
            appendLine("抓拍尺寸：${formatSize(snapshot.captureWidth, snapshot.captureHeight)}")
            append("请求帧率：${snapshot.requestedPreviewFps ?: "设备默认"}")
            snapshot.lastFailureCode?.let { append("\n失败码：$it") }
        }
        updateButtons()
    }

    private fun updatePermissionState() {
        val granted = hasCameraPermission()
        permissionText.text = "摄像头权限：${if (granted) "已授权" else "未授权"}"
        updateButtons()
    }

    private fun updateButtons() {
        if (!::startButton.isInitialized) return
        val state = latestSnapshot.state
        val running = state == JunLuoCameraCoreState.RUNNING && latestSnapshot.previewStreaming
        startButton.isEnabled = hasCameraPermission() && (state == JunLuoCameraCoreState.STOPPED || state == JunLuoCameraCoreState.ERROR || state == JunLuoCameraCoreState.BUSY)
        stopButton.isEnabled = state != JunLuoCameraCoreState.STOPPED && state != JunLuoCameraCoreState.RELEASED
        switchButton.isEnabled = running
        captureButton.isEnabled = running
        switchButton.text = if (currentFacing == JunLuoCameraFacing.FRONT) "切换为后置" else "切换为前置"
    }

    private fun showCaptureThumbnail(result: JunLuoCameraCaptureResult.Success) {
        val source = BitmapFactory.decodeFile(result.temporaryPath) ?: return
        val matrix = Matrix().apply {
            if (result.mirrored) postScale(-1f, 1f)
            postRotate(result.rotation.toFloat())
        }
        val transformed = Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
        if (transformed !== source) source.recycle()
        displayedBitmap = transformed
        captureImage.setImageBitmap(transformed)
    }

    private fun clearCurrentCapture() {
        captureImage.setImageDrawable(null)
        displayedBitmap?.let { bitmap -> if (!bitmap.isRecycled) bitmap.recycle() }
        displayedBitmap = null
        currentCaptureFile?.delete()
        currentCaptureFile = null
        File(cacheDir, "junluo-camera/chapter4-debug").listFiles()?.forEach { file ->
            if (file.isFile) file.delete()
        }
    }

    private fun hasCameraPermission(): Boolean = ContextCompat.checkSelfPermission(
        this,
        Manifest.permission.CAMERA,
    ) == PackageManager.PERMISSION_GRANTED

    private fun stateLabel(state: JunLuoCameraCoreState): String = when (state) {
        JunLuoCameraCoreState.STOPPED -> "未启动"
        JunLuoCameraCoreState.STARTING -> "启动中"
        JunLuoCameraCoreState.RUNNING -> "预览中"
        JunLuoCameraCoreState.SWITCHING -> "切换中"
        JunLuoCameraCoreState.BUSY -> "相机占用"
        JunLuoCameraCoreState.ERROR -> "错误"
        JunLuoCameraCoreState.RELEASED -> "已释放"
    }

    private fun formatSize(width: Int?, height: Int?): String =
        if (width == null || height == null) "暂无" else "${width}x$height"

    private fun formatTime(epochMs: Long): String = DateFormat.getDateTimeInstance().format(Date(epochMs))

    private fun horizontalRow() = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun actionButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun weightedButtonParams(leftMargin: Int = 0) = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
        this.leftMargin = leftMargin
    }

    private fun textView(value: String, size: Float, bold: Boolean) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(Color.rgb(56, 47, 42))
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setLineSpacing(0f, 1.15f)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
