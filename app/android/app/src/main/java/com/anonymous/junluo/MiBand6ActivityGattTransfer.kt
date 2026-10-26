package com.anonymous.junluo

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import java.util.ArrayDeque
import java.util.TimeZone
import java.util.UUID

/** Owns only the two activity characteristics, on the guardian's existing connection. */
@SuppressLint("MissingPermission")
internal class MiBand6ActivityGattTransfer(
    private val gatt: BluetoothGatt,
    private val handler: Handler,
    private val since: Long,
    private val current: () -> Boolean,
    private val unsafeCleanup: () -> Unit,
    private val completion: (MiBand6ActivityBatch?, String?) -> Unit,
    private val sleepCapture: MiBand6SleepCapture? = null,
) {
    companion object {
        fun selectControlWriteType(properties: Int): Int? = when {
            properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0 -> BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0 -> BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            else -> null
        }
    }

    private val controlUuid = UUID.fromString(MiBand6ActivityProtocol.CONTROL_CHARACTERISTIC_UUID)
    private val dataUuid = UUID.fromString(MiBand6ActivityProtocol.DATA_CHARACTERISTIC_UUID)
    private val cccd = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private val started = SystemClock.elapsedRealtime()
    private val parser = MiBand6ActivityAssembler(since, System::currentTimeMillis)
    private var control: BluetoothGattCharacteristic? = null
    private var data: BluetoothGattCharacteristic? = null
    private val subscriptions = ArrayDeque<BluetoothGattCharacteristic>()
    private val writes = ArrayDeque<ByteArray>()
    private var descriptorPending: BluetoothGattDescriptor? = null
    private var writePending = false
    private var controlWriteType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
    private var closing = false
    private var closed = false
    private var result: MiBand6ActivityBatch? = null
    private var error: String? = null
    private val cancelWaiters = mutableListOf<(String?) -> Unit>()
    private val deadline = Runnable { finish(null, "activity_timeout") }
    private val idleDeadline = Runnable { finish(null, "activity_idle_timeout") }
    private val cleanupDeadline = Runnable { cleanupFailed() }
    fun evidence(): MiBand6ActivityEvidence = parser.getEvidence()
    fun rejectPacket() { finish(null, "activity_invalid_packet") }

    fun start() {
        try {
            if (!current()) return finish(null, "activity_not_ready")
            val service = gatt.getService(UUID.fromString(MiBand6ActivityProtocol.SERVICE_UUID))
            control = service?.getCharacteristic(controlUuid)
            data = service?.getCharacteristic(dataUuid)
            val c = control ?: return finish(null, "activity_unsupported")
            val d = data ?: return finish(null, "activity_unsupported")
            controlWriteType = selectControlWriteType(c.properties) ?: return finish(null, "activity_unsupported")
            if (listOf(c, d).any { it.properties and (BluetoothGattCharacteristic.PROPERTY_NOTIFY or
                    BluetoothGattCharacteristic.PROPERTY_INDICATE) == 0 || it.getDescriptor(cccd) == null }) {
                return finish(null, "activity_unsupported")
            }
            handler.postDelayed(deadline, MiBand6ActivityProtocol.TOTAL_TIMEOUT_MS)
            progress()
            setSubscription(c, true)
        } catch (_: Exception) { finish(null, "activity_transfer_failed") }
    }

    fun onDescriptor(descriptor: BluetoothGattDescriptor, status: Int): Boolean {
        if (descriptor.characteristic.uuid != controlUuid && descriptor.characteristic.uuid != dataUuid) return false
        if (closed) return true
        if (descriptor !== descriptorPending || !current()) return true
        descriptorPending = null
        if (status != BluetoothGatt.GATT_SUCCESS) { cleanupFailed(); return true }
        if (closing) { drain(); return true }
        try {
            if (descriptor.characteristic.uuid == controlUuid) setSubscription(data!!, true)
            else {
                writes.add(MiBand6ActivityProtocol.buildStartRequest(since, TimeZone.getDefault().getOffset(since) / 60_000,
                    System.currentTimeMillis()))
                drain()
            }
        } catch (_: Exception) { finish(null, "activity_invalid_time") }
        return true
    }

    fun onWrite(characteristic: BluetoothGattCharacteristic, status: Int): Boolean {
        if (characteristic.uuid != controlUuid) return false
        if (closed || !current() || !writePending) return true
        writePending = false
        if (status != BluetoothGatt.GATT_SUCCESS) finish(null, "activity_write_failed") else drain()
        return true
    }

    fun onChanged(characteristic: BluetoothGattCharacteristic, bytes: ByteArray): Boolean {
        if (characteristic.uuid != controlUuid && characteristic.uuid != dataUuid) return false
        if (closed || closing || !current()) return true
        try {
            val elapsed = SystemClock.elapsedRealtime() - started
            sleepCapture?.observe(if (characteristic.uuid == dataUuid) "data" else "control", bytes,
                System.currentTimeMillis(), elapsed)
            if (characteristic.uuid == dataUuid) {
                if (parser.onDataNotification(bytes, elapsed)) progress()
            } else {
                val batch = parser.onControlNotification(bytes, elapsed)
                if (batch != null) finish(batch, null)
                else { progress(); writes.add(MiBand6ActivityProtocol.buildFetchRequest()); drain() }
            }
        } catch (failure: MiBand6ActivityException) { finish(null, failure.code) }
        catch (_: Exception) { finish(null, "activity_invalid_packet") }
        return true
    }

    fun cancel(done: (String?) -> Unit) {
        if (closed) { done(null); return }
        cancelWaiters.add(done)
        finish(null, "activity_cancelled")
    }

    fun disconnected() {
        if (closed) return
        result = null
        error = "activity_disconnected"
        deliver()
    }

    private fun progress() {
        handler.removeCallbacks(idleDeadline)
        handler.postDelayed(idleDeadline, MiBand6ActivityProtocol.NO_PROGRESS_TIMEOUT_MS)
    }

    private fun finish(batch: MiBand6ActivityBatch?, failure: String?) {
        if (closing || closed) return
        closing = true
        result = batch
        error = failure
        writes.clear()
        handler.removeCallbacks(deadline)
        handler.removeCallbacks(idleDeadline)
        handler.postDelayed(cleanupDeadline, 5_000L)
        drain()
    }

    private fun drain() {
        if (closed || descriptorPending != null || writePending) return
        if (!current()) { disconnected(); return }
        if (closing) {
            if (subscriptions.isEmpty()) deliver() else setSubscription(subscriptions.removeFirst(), false)
            return
        }
        val bytes = writes.pollFirst() ?: return
        val characteristic = control ?: return finish(null, "activity_unsupported")
        writePending = true
        val accepted = runCatching {
            if (Build.VERSION.SDK_INT >= 33) gatt.writeCharacteristic(characteristic, bytes,
                controlWriteType) == 0
            else {
                @Suppress("DEPRECATION")
                characteristic.run { writeType = controlWriteType; value = bytes; gatt.writeCharacteristic(this) }
            }
        }.getOrDefault(false)
        if (!accepted) { writePending = false; finish(null, "activity_write_failed") }
    }

    private fun setSubscription(characteristic: BluetoothGattCharacteristic, enabled: Boolean) {
        if (enabled) subscriptions.add(characteristic)
        val descriptor = characteristic.getDescriptor(cccd) ?: return cleanupFailed()
        if (!runCatching { gatt.setCharacteristicNotification(characteristic, enabled) }.getOrDefault(false)) return cleanupFailed()
        descriptorPending = descriptor
        val bytes = if (!enabled) BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            else if (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0)
                BluetoothGattDescriptor.ENABLE_INDICATION_VALUE else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        val accepted = runCatching {
            if (Build.VERSION.SDK_INT >= 33) gatt.writeDescriptor(descriptor, bytes) == 0
            else {
                @Suppress("DEPRECATION")
                descriptor.run { value = bytes; gatt.writeDescriptor(this) }
            }
        }.getOrDefault(false)
        if (!accepted) { descriptorPending = null; cleanupFailed() }
    }

    private fun cleanupFailed() {
        if (closed) return
        result = null
        error = "activity_cleanup_failed"
        // Deliver only after ownership has been released. Avoid reconnecting just to retry history.
        closing = true
        closed = true
        unsafeCleanup()
        closed = false
        deliver()
    }

    private fun deliver() {
        if (closed) return
        closed = true
        handler.removeCallbacks(deadline)
        handler.removeCallbacks(idleDeadline)
        handler.removeCallbacks(cleanupDeadline)
        completion(result, error)
        cancelWaiters.toList().forEach { it(if (error == "activity_cleanup_failed" || error == "activity_disconnected") error else null) }
        cancelWaiters.clear()
    }
}
