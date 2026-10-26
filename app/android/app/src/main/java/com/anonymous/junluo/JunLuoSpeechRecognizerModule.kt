package com.anonymous.junluo

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

class JunLuoSpeechRecognizerModule(
    private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
    private val handler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var stopPromise: Promise? = null
    private var stopTimeoutRunnable: Runnable? = null
    private var lastPartialText: String = ""
    private var lastFinalText: String = ""
    private var listening = false

    override fun getName(): String = "JunLuoSpeechRecognizer"

    @ReactMethod
    fun isAvailable(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            promise.resolve(SpeechRecognizer.isRecognitionAvailable(reactContext))
        }
    }

    @ReactMethod
    fun start(languageTag: String, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            if (ContextCompat.checkSelfPermission(reactContext, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                promise.reject("NO_PERMISSION", "Missing RECORD_AUDIO permission")
                return@runOnUiThread
            }
            if (!SpeechRecognizer.isRecognitionAvailable(reactContext)) {
                promise.reject("UNAVAILABLE", "SpeechRecognizer is not available on this device")
                return@runOnUiThread
            }
            if (listening) {
                promise.resolve(true)
                return@runOnUiThread
            }

            lastPartialText = ""
            lastFinalText = ""
            recognizer?.destroy()
            recognizer = SpeechRecognizer.createSpeechRecognizer(reactContext).apply {
                setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) = Unit
                    override fun onBeginningOfSpeech() = Unit
                    override fun onRmsChanged(rmsdB: Float) = Unit
                    override fun onBufferReceived(buffer: ByteArray?) = Unit
                    override fun onEndOfSpeech() = Unit
                    override fun onEvent(eventType: Int, params: Bundle?) = Unit

                    override fun onPartialResults(partialResults: Bundle?) {
                        lastPartialText = readBestResult(partialResults)
                    }

                    override fun onResults(results: Bundle?) {
                        listening = false
                        lastFinalText = readBestResult(results)
                        resolveStop()
                    }

                    override fun onError(error: Int) {
                        listening = false
                        resolveStop()
                    }
                })
            }

            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag.ifBlank { "zh-CN" })
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            }

            try {
                recognizer?.startListening(intent)
                listening = true
                promise.resolve(true)
            } catch (error: Exception) {
                listening = false
                promise.reject("START_FAILED", error.message, error)
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            if (!listening) {
                promise.resolve(bestText())
                return@runOnUiThread
            }
            stopPromise = promise
            scheduleStopTimeout()
            try {
                recognizer?.stopListening()
            } catch (error: Exception) {
                clearStopTimeout()
                listening = false
                stopPromise = null
                promise.reject("STOP_FAILED", error.message, error)
            }
        }
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                clearStopTimeout()
                stopPromise?.resolve("")
                stopPromise = null
                recognizer?.cancel()
                recognizer?.destroy()
                recognizer = null
                listening = false
                lastPartialText = ""
                lastFinalText = ""
                promise.resolve(true)
            } catch (error: Exception) {
                promise.reject("CANCEL_FAILED", error.message, error)
            }
        }
    }

    private fun readBestResult(bundle: Bundle?): String {
        val matches = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        return matches?.firstOrNull()?.trim().orEmpty()
    }

    private fun bestText(): String = (lastFinalText.ifBlank { lastPartialText }).trim()

    private fun clearStopTimeout() {
        stopTimeoutRunnable?.let { handler.removeCallbacks(it) }
        stopTimeoutRunnable = null
    }

    private fun scheduleStopTimeout() {
        clearStopTimeout()
        stopTimeoutRunnable = Runnable {
            listening = false
            try {
                recognizer?.cancel()
                recognizer?.destroy()
            } catch (_: Exception) {
            }
            recognizer = null
            resolveStop()
        }
        handler.postDelayed(stopTimeoutRunnable!!, 1800)
    }

    private fun resolveStop() {
        clearStopTimeout()
        stopPromise?.resolve(bestText())
        stopPromise = null
    }

    override fun invalidate() {
        super.invalidate()
        UiThreadUtil.runOnUiThread {
            try {
                recognizer?.cancel()
                recognizer?.destroy()
            } catch (_: Exception) {
            }
            recognizer = null
            clearStopTimeout()
            stopPromise = null
            listening = false
        }
    }
}
