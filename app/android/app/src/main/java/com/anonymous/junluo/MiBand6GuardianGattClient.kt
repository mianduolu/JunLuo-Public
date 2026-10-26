package com.anonymous.junluo

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.ArrayDeque
import java.util.UUID

internal interface MiBand6GuardianGattListener {
    fun onStage(status: GuardianStatus)
    fun onReady()
    fun onHeartRate(bpm: Int, observedAt: Long)
    fun onCommandAcknowledged(command: String)
    fun onDisconnected(expected: Boolean)
    fun onError(code: String)
}

/**
 * The sole native GATT owner for a provisioned Mi Band 6.
 * Raw addresses and protocol bytes never leave this in-memory object.
 */
@SuppressLint("MissingPermission")
internal class MiBand6GuardianGattClient(
    private val context: Context,
    private val listener: MiBand6GuardianGattListener,
) {
    companion object {
        private val AUTH_WRITE_UUID = UUID.fromString("00000016-0000-3512-2118-0009af100700")
        private val AUTH_READ_UUID = UUID.fromString("00000017-0000-3512-2118-0009af100700")
        private val HEART_RATE_UUID = UUID.fromString("00002a37-0000-1000-8000-00805f9b34fb")
        private val HEART_RATE_CONTROL_POINT_UUID = UUID.fromString("00002a39-0000-1000-8000-00805f9b34fb")
        private val CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        private val CURRENT_TIME_UUID = UUID.fromString(MiBand6TimeProtocol.CHARACTERISTIC_UUID)
        private const val POST_AUTH_MTU = 247
        private const val POST_AUTH_MTU_TIMEOUT_MS = 1_500L
        private const val NOTIFICATION_RETRY_DELAY_MS = 100L
        private const val STANDARD_MANUAL_RESTART_MS = 15_000L
        private const val STANDARD_MANUAL_TIMEOUT_MS = 45_000L
    }

    private enum class NotificationStage {
        NONE,
        AUTH_READ,
        HEART_RATE,
    }

    private enum class HeartRateControlMode {
        NONE,
        HUAMI_ENDPOINT,
        STANDARD_CONTROL_POINT,
    }

    private data class PendingWrite(
        val characteristic: BluetoothGattCharacteristic,
        val bytes: ByteArray,
        val acknowledgedCommand: String? = null,
    )

    private val mainHandler = Handler(Looper.getMainLooper())
    private val decoder = GuardianChunkDecoder()
    private val writeQueue = ArrayDeque<PendingWrite>()
    private var gatt: BluetoothGatt? = null
    private var authWrite: BluetoothGattCharacteristic? = null
    private var authRead: BluetoothGattCharacteristic? = null
    private var heartRate: BluetoothGattCharacteristic? = null
    private var heartRateControlPoint: BluetoothGattCharacteristic? = null
    private var authKey: ByteArray? = null
    private var privateKey: ByteArray? = null
    private var sessionKey: ByteArray? = null
    private var services: List<GuardianServiceEntry> = emptyList()
    private var sequenceNumber = 0L
    private var writeHandle = 0
    private var mtu = 23
    private var notificationStage = NotificationStage.NONE
    private var authReadNotificationEnabled = false
    private var heartRateNotificationEnabled = false
    private var serviceDiscoveryStarted = false
    private var servicesResolved = false
    private var authenticationComplete = false
    private var mtuUpgradePending = false
    private var writing = false
    private var activeWrite: PendingWrite? = null
    private var expectedDisconnect = false
    private var pendingCommand: String? = null
    private var heartRateControlMode = HeartRateControlMode.NONE
    private var manualMeasurementStartedAt: Long? = null
    private var manualMeasurementReceivedAt: Long? = null
    private var continuousFallbackActive = false
    private var timeSyncCompletion: ((String?) -> Unit)? = null
    private val batteryRead = MiBand6BatteryReadSession()
    private var batteryCharacteristic: BluetoothGattCharacteristic? = null
    private val batteryCompletions = mutableListOf<(ByteArray?, String?) -> Unit>()
    private var batteryTimeout: Runnable? = null
    private var activityTransfer: MiBand6ActivityGattTransfer? = null
    private var activityBlocked = false
    private var lastActivityEvidence: MiBand6ActivityEvidence? = null
    fun activityEvidence(): MiBand6ActivityEvidence? = lastActivityEvidence
    private val timeSyncTimeout = Runnable {
        finishTimeSync("time_sync_timeout")
        // An unacknowledged write cannot safely share the queue with subsequent commands.
        fail("time_sync_timeout")
    }

    fun isConnected(): Boolean = gatt != null
    fun isBatteryReadPending(): Boolean = batteryRead.pending
    fun isActivityPending(): Boolean = activityTransfer != null


    fun readActivity(since: Long, sleepCapture: MiBand6SleepCapture? = null,
        completion: (MiBand6ActivityBatch?, String?) -> Unit) {
        val current = gatt ?: return completion(null, "activity_not_ready")
        if (!isReady()) return completion(null, "activity_not_ready")
        if (activityBlocked) return completion(null, "activity_connection_blocked")
        if (activityTransfer != null || batteryRead.pending || timeSyncCompletion != null || pendingCommand != null
            || writing || writeQueue.isNotEmpty() || notificationStage != NotificationStage.NONE) {
            return completion(null, "activity_busy")
        }
        try {
            lastActivityEvidence = null
            val transfer = MiBand6ActivityGattTransfer(current, mainHandler, since,
                current = { gatt === current && isReady() },
                unsafeCleanup = { close(expected = true); listener.onDisconnected(true) },
                sleepCapture = sleepCapture,
                completion = { batch, error ->
                    lastActivityEvidence = if (sleepCapture == null) activityTransfer?.evidence() else null
                    activityTransfer = null
                    if (error != null) activityBlocked = true
                    completion(batch, error)
                })
            activityTransfer = transfer
            transfer.start()
        } catch (_: Exception) { activityTransfer = null; completion(null, "activity_invalid_time") }
    }

    fun cancelActivity(completion: (String?) -> Unit) {
        val transfer = activityTransfer
        if (transfer == null) completion(null) else transfer.cancel(completion)
    }
    fun isReady(): Boolean = authenticationComplete
        && heartRateNotificationEnabled
        && heartRateControlMode != HeartRateControlMode.NONE

    fun connect(device: BluetoothDevice, key: ByteArray) {
        require(key.size == 16) { "Mi Band 6 auth key must be 16 bytes" }
        close(expected = true)
        authKey = key.copyOf()
        expectedDisconnect = false
        listener.onStage(GuardianStatus.CONNECTING)
        gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        } else {
            device.connectGatt(context, false, callback)
        }
    }

    fun startHeartRate() {
        when (heartRateControlMode) {
            HeartRateControlMode.HUAMI_ENDPOINT ->
                sendHuamiHeartRate("start", HUAMI_HEART_RATE_START, waitForAck = true)
            HeartRateControlMode.STANDARD_CONTROL_POINT -> startStandardManualHeartRate("start")
            HeartRateControlMode.NONE -> fail("guardian_not_ready")
        }
    }

    fun continueHeartRate() {
        when (heartRateControlMode) {
            HeartRateControlMode.HUAMI_ENDPOINT ->
                sendHuamiHeartRate("continue", HUAMI_HEART_RATE_CONTINUE, waitForAck = false)
            HeartRateControlMode.STANDARD_CONTROL_POINT -> continueStandardHeartRate()
            HeartRateControlMode.NONE -> fail("guardian_not_ready")
        }
    }

    fun stopHeartRate() {
        when (heartRateControlMode) {
            HeartRateControlMode.HUAMI_ENDPOINT ->
                sendHuamiHeartRate("stop", HUAMI_HEART_RATE_STOP, waitForAck = true)
            HeartRateControlMode.STANDARD_CONTROL_POINT -> stopStandardHeartRate("stop")
            HeartRateControlMode.NONE -> fail("guardian_not_ready")
        }
    }

    fun close(expected: Boolean) {
        expectedDisconnect = expected
        val current = gatt
        gatt = null
        runCatching { current?.disconnect() }
        runCatching { current?.close() }
        clearSession()
    }

    fun syncCurrentTime(completion: (String?) -> Unit) {
        if (!isReady()) return completion("time_sync_not_ready")
        if (timeSyncCompletion != null || writing || writeQueue.isNotEmpty() || batteryRead.pending || activityTransfer != null) {
            return completion("time_sync_busy")
        }
        val current = gatt ?: return completion("time_sync_not_ready")
        val characteristic = findCharacteristic(current.services, CURRENT_TIME_UUID)
            ?: return completion("time_sync_unsupported")
        if ((characteristic.properties and BluetoothGattCharacteristic.PROPERTY_WRITE) == 0) {
            return completion("time_sync_unsupported")
        }
        timeSyncCompletion = completion
        mainHandler.postDelayed(timeSyncTimeout, 10_000L)
        try {
            enqueue(listOf(MiBand6TimeProtocol.encode()), characteristic)
        } catch (_: Exception) {
            finishTimeSync("time_sync_write_failed")
            fail("time_sync_write_failed")
        }
    }

    private fun finishTimeSync(error: String?) {
        mainHandler.removeCallbacks(timeSyncTimeout)
        val completion = timeSyncCompletion
        timeSyncCompletion = null
        completion?.invoke(error)
    }

    fun readBattery(completion: (ByteArray?, String?) -> Unit) {
        if (batteryRead.timedOut) return completion(null, "battery_connection_blocked")
        if (batteryRead.pending) { batteryCompletions.add(completion); return }
        if (!isReady()) return completion(null, "battery_not_ready")
        if (timeSyncCompletion != null || writing || writeQueue.isNotEmpty() || pendingCommand != null || activityTransfer != null) {
            return completion(null, "battery_busy")
        }
        val current = gatt ?: return completion(null, "battery_not_ready")
        val characteristic = current.getService(UUID.fromString(MiBand6BatteryProtocol.SERVICE_UUID))
            ?.getCharacteristic(UUID.fromString(MiBand6BatteryProtocol.CHARACTERISTIC_UUID))
            ?: return completion(null, "battery_unsupported")
        if ((characteristic.properties and BluetoothGattCharacteristic.PROPERTY_READ) == 0) {
            return completion(null, "battery_unsupported")
        }
        batteryRead.begin(System.currentTimeMillis())?.let { return completion(null, it) }
        val token = batteryRead.token
        batteryCharacteristic = characteristic
        batteryCompletions.add(completion)
        val timeout = Runnable {
            if (gatt === current && batteryRead.expire(token)) finishBattery(null, "battery_timeout")
        }
        batteryTimeout = timeout
        mainHandler.postDelayed(timeout, MiBand6BatteryProtocol.READ_TIMEOUT_MS)
        if (!runCatching { current.readCharacteristic(characteristic) }.getOrDefault(false)) {
            batteryRead.complete(token)
            finishBattery(null, "battery_read_failed")
        }
    }

    private fun finishBattery(bytes: ByteArray?, error: String?) {
        batteryTimeout?.let(mainHandler::removeCallbacks)
        batteryTimeout = null
        val completions = batteryCompletions.toList()
        batteryCompletions.clear()
        completions.forEach { it(bytes?.copyOf(), error) }
        if (!batteryRead.pending) drainWrites()
    }

    private fun handleBatteryRead(
        sourceGatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
        status: Int,
    ) {
        val bytes = value.copyOf()
        mainHandler.post {
            if (gatt !== sourceGatt || characteristic !== batteryCharacteristic || !batteryRead.pending) return@post
            val accept = batteryRead.complete(batteryRead.token)
            if (!accept) { drainWrites(); return@post }
            val error = when {
                status != BluetoothGatt.GATT_SUCCESS -> "battery_read_failed"
                MiBand6BatteryProtocol.parse(bytes) == null -> "battery_invalid_packet"
                else -> null
            }
            finishBattery(if (error == null) bytes.copyOfRange(0, 3) else null, error)
        }
    }

    private val callback = object : BluetoothGattCallback() {
        @Deprecated("Deprecated in API 33")
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            handleBatteryRead(gatt, characteristic, characteristic.value ?: byteArrayOf(), status)
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            handleBatteryRead(gatt, characteristic, value, status)
        }

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            mainHandler.post {
                if (this@MiBand6GuardianGattClient.gatt !== gatt) return@post
                if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
                    val wasExpected = expectedDisconnect
                    this@MiBand6GuardianGattClient.gatt = null
                    runCatching { gatt.close() }
                    clearSession()
                    listener.onDisconnected(wasExpected)
                    return@post
                }
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    listener.onStage(GuardianStatus.DISCOVERING)
                    discoverServicesOnce(gatt)
                }
            }
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            mainHandler.post {
                if (this@MiBand6GuardianGattClient.gatt !== gatt) return@post
                if (!authenticationComplete) return@post
                mtuUpgradePending = false
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    this@MiBand6GuardianGattClient.mtu = mtu.coerceAtLeast(23)
                }
                enableHeartRateNotificationAfterAuth()
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            mainHandler.post {
                if (this@MiBand6GuardianGattClient.gatt !== gatt) return@post
                if (status != BluetoothGatt.GATT_SUCCESS) return@post fail("services_discovery_failed")
                if (servicesResolved) return@post
                servicesResolved = true
                authWrite = findCharacteristic(gatt.services, AUTH_WRITE_UUID)
                authRead = findCharacteristic(gatt.services, AUTH_READ_UUID)
                heartRate = findCharacteristic(gatt.services, HEART_RATE_UUID)
                heartRateControlPoint = findCharacteristic(gatt.services, HEART_RATE_CONTROL_POINT_UUID)
                if (authWrite == null || authRead == null || heartRate == null) {
                    return@post fail("mi_band_6_characteristics_missing")
                }
                listener.onStage(GuardianStatus.AUTHENTICATING)
                enableNotification(
                    authRead ?: return@post fail("auth_read_missing"),
                    NotificationStage.AUTH_READ,
                )
            }
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            mainHandler.post {
                if (this@MiBand6GuardianGattClient.gatt !== gatt) return@post
                if (descriptor.characteristic.uuid.toString() in setOf(MiBand6ActivityProtocol.CONTROL_CHARACTERISTIC_UUID,
                        MiBand6ActivityProtocol.DATA_CHARACTERISTIC_UUID)) {
                    if (this@MiBand6GuardianGattClient.gatt === gatt) activityTransfer?.onDescriptor(descriptor, status)
                    return@post
                }
                val completedStage = notificationStage
                notificationStage = NotificationStage.NONE
                val expectedUuid = when (completedStage) {
                    NotificationStage.AUTH_READ -> AUTH_READ_UUID
                    NotificationStage.HEART_RATE -> HEART_RATE_UUID
                    NotificationStage.NONE -> return@post fail("notification_subscription_unexpected")
                }
                if (descriptor.characteristic.uuid != expectedUuid) {
                    return@post fail("notification_subscription_mismatch")
                }
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    return@post fail(when (completedStage) {
                        NotificationStage.AUTH_READ -> "auth_notification_subscription_failed"
                        NotificationStage.HEART_RATE -> "heart_rate_notification_subscription_failed"
                        NotificationStage.NONE -> "notification_subscription_failed"
                    })
                }
                when (completedStage) {
                    NotificationStage.AUTH_READ -> {
                        authReadNotificationEnabled = true
                        beginAuthentication()
                    }
                    NotificationStage.HEART_RATE -> {
                        heartRateNotificationEnabled = true
                        requestServices()
                    }
                    NotificationStage.NONE -> Unit
                }
            }
        }

        @Deprecated("Deprecated in API 33")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (handleActivityChanged(gatt, characteristic, characteristic.value ?: return)) return
            handleChanged(gatt, characteristic, characteristic.value ?: return)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            if (handleActivityChanged(gatt, characteristic, value)) return
            handleChanged(gatt, characteristic, value)
        }

        @Deprecated("Deprecated in API 33")
        override fun onCharacteristicWrite(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            mainHandler.post {
                if (this@MiBand6GuardianGattClient.gatt !== gatt) return@post
                if (activityTransfer?.onWrite(characteristic, status) == true) return@post
                val completedWrite = activeWrite
                if (completedWrite?.characteristic?.uuid != characteristic.uuid) return@post
                activeWrite = null
                writing = false
                if (characteristic.uuid == CURRENT_TIME_UUID) {
                    finishTimeSync(if (status == BluetoothGatt.GATT_SUCCESS) null else "time_sync_write_failed")
                    drainWrites()
                    return@post
                }
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    fail(
                        "gatt_write_failed_status_${status}" +
                            "_properties_${characteristic.properties}" +
                            "_type_${characteristic.writeType}",
                    )
                } else {
                    completedWrite?.acknowledgedCommand?.let(listener::onCommandAcknowledged)
                    drainWrites()
                }
            }
        }
    }

    private fun handleActivityChanged(source: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray): Boolean {
        if (characteristic.uuid.toString() !in listOf(MiBand6ActivityProtocol.CONTROL_CHARACTERISTIC_UUID,
                MiBand6ActivityProtocol.DATA_CHARACTERISTIC_UUID)) return false
        if (value.size > 512) {
            mainHandler.post { if (gatt === source) activityTransfer?.rejectPacket() }
            return true
        }
        val bytes = value.copyOf()
        mainHandler.post {
            if (gatt === source) activityTransfer?.onChanged(characteristic, bytes)
        }
        return true
    }

    private fun enableNotification(
        characteristic: BluetoothGattCharacteristic,
        stage: NotificationStage,
    ) {
        val current = gatt ?: return fail("gatt_unavailable")
        val alreadyEnabled = when (stage) {
            NotificationStage.AUTH_READ -> authReadNotificationEnabled
            NotificationStage.HEART_RATE -> heartRateNotificationEnabled
            NotificationStage.NONE -> true
        }
        if (alreadyEnabled || notificationStage == stage) return
        if (notificationStage != NotificationStage.NONE) {
            mainHandler.postDelayed({
                if (gatt === current) enableNotification(characteristic, stage)
            }, NOTIFICATION_RETRY_DELAY_MS)
            return
        }
        notificationStage = stage
        if (!current.setCharacteristicNotification(characteristic, true)) {
            notificationStage = NotificationStage.NONE
            return fail("notification_enable_failed")
        }
        val descriptor = characteristic.getDescriptor(CCCD_UUID)
            ?: run {
                notificationStage = NotificationStage.NONE
                return fail("notification_descriptor_missing")
            }
        val value = if ((characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0) {
            BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
        } else {
            BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        }
        val accepted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            current.writeDescriptor(descriptor, value) == 0
        } else {
            @Suppress("DEPRECATION")
            descriptor.run { this.value = value; current.writeDescriptor(this) }
        }
        if (!accepted) {
            notificationStage = NotificationStage.NONE
            fail("notification_descriptor_write_failed")
        }
    }

    private fun beginAuthentication() {
        val generatedPrivate = runCatching { MiBand6GuardianProtocol.generatePrivateKey() }
            .getOrElse { return fail("auth_key_exchange_failed") }
        privateKey = generatedPrivate
        val publicKey = runCatching { MiBand6GuardianProtocol.generatePublicKey(generatedPrivate) }
            .getOrElse { return fail("auth_key_exchange_failed") }
        enqueue(MiBand6GuardianProtocol.encodeAuth(
            HUAMI_AUTH_ENDPOINT,
            nextHandle(),
            mtu,
            MiBand6GuardianProtocol.publicKeyAuthPayload(publicKey),
        ))
    }

    private fun handleChanged(sourceGatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        mainHandler.post {
            if (gatt !== sourceGatt) return@post
            if (characteristic.uuid == HEART_RATE_UUID) {
                MiBand6GuardianProtocol.parseStandardHeartRate(value)?.let {
                    if (heartRateControlMode == HeartRateControlMode.STANDARD_CONTROL_POINT) {
                        manualMeasurementReceivedAt = System.currentTimeMillis()
                    }
                    listener.onHeartRate(it, System.currentTimeMillis())
                }
                return@post
            }
            if (characteristic.uuid != AUTH_READ_UUID) return@post
            val decoded = runCatching { decoder.decode(value) }.getOrElse {
                return@post fail("chunk_decode_failed")
            } ?: return@post
            if (decoded.needsAck) enqueue(listOf(MiBand6GuardianProtocol.chunkAck(decoded.handle, decoded.count)), authRead)
            when (decoded.endpoint) {
                HUAMI_AUTH_ENDPOINT -> handleAuth(decoded.payload)
                HUAMI_SERVICES_ENDPOINT -> handleServices(decoded.payload)
                HUAMI_HEART_RATE_ENDPOINT -> handleHeartRateAck(decoded.payload)
            }
        }
    }

    private fun handleAuth(payload: ByteArray) {
        when {
            payload.size == 67 && payload[0] == 0x10.toByte() && payload[1] == 0x04.toByte() -> {
                val key = authKey ?: return fail("auth_key_missing")
                val localPrivate = privateKey ?: return fail("auth_private_key_missing")
                val response = runCatching {
                    MiBand6GuardianProtocol.challengeResponse(localPrivate, key, payload)
                }.getOrElse { return fail("auth_challenge_failed") }
                sessionKey?.fill(0)
                sessionKey = response.sessionKey
                sequenceNumber = response.sequenceNumber
                decoder.setSessionKey(response.sessionKey)
                enqueue(MiBand6GuardianProtocol.encodeAuth(
                    HUAMI_AUTH_ENDPOINT,
                    nextHandle(),
                    mtu,
                    response.payload,
                ))
            }
            MiBand6GuardianProtocol.authSucceeded(payload) -> {
                if (authenticationComplete) return
                authenticationComplete = true
                requestPostAuthMtu()
            }
            MiBand6GuardianProtocol.authRejected(payload) -> fail("auth_key_rejected")
        }
    }

    private fun requestServices() {
        enqueue(MiBand6GuardianProtocol.encodeMessage(
            endpoint = HUAMI_SERVICES_ENDPOINT,
            handle = nextHandle(),
            mtu = mtu,
            payload = HUAMI_SERVICES_REQUEST,
            sessionKey = null,
            sequenceNumber = 0L,
        ))
    }

    private fun discoverServicesOnce(gatt: BluetoothGatt) {
        if (serviceDiscoveryStarted) return
        serviceDiscoveryStarted = true
        if (!gatt.discoverServices()) {
            serviceDiscoveryStarted = false
            fail("services_discovery_rejected")
        }
    }

    private fun requestPostAuthMtu() {
        val currentGatt = gatt ?: return fail("gatt_missing_after_auth")
        mtuUpgradePending = true
        if (!currentGatt.requestMtu(POST_AUTH_MTU)) {
            mtuUpgradePending = false
            enableHeartRateNotificationAfterAuth()
            return
        }
        mainHandler.postDelayed({
            if (this@MiBand6GuardianGattClient.gatt !== currentGatt || !mtuUpgradePending) return@postDelayed
            mtuUpgradePending = false
            enableHeartRateNotificationAfterAuth()
        }, POST_AUTH_MTU_TIMEOUT_MS)
    }

    private fun enableHeartRateNotificationAfterAuth() {
        if (notificationStage == NotificationStage.HEART_RATE || heartRateNotificationEnabled) return
        enableNotification(
            heartRate ?: return fail("heart_rate_missing"),
            NotificationStage.HEART_RATE,
        )
    }

    private fun handleServices(payload: ByteArray) {
        services = runCatching { MiBand6GuardianProtocol.parseServiceList(payload) }
            .getOrElse { return fail("services_list_invalid") }
        heartRateControlMode = when {
            services.any { it.endpoint == HUAMI_HEART_RATE_ENDPOINT } -> HeartRateControlMode.HUAMI_ENDPOINT
            heartRateControlPoint?.let(::preferredWriteType) != null -> HeartRateControlMode.STANDARD_CONTROL_POINT
            else -> return fail("heart_rate_control_unavailable")
        }
        listener.onReady()
    }

    private fun handleHeartRateAck(payload: ByteArray) {
        if (payload.size < 2 || payload[0] != 0x05.toByte()) return
        val command = pendingCommand ?: return
        pendingCommand = null
        if (payload[1] != 0.toByte()) fail("heart_rate_command_rejected")
        else listener.onCommandAcknowledged(command)
    }

    private fun sendHuamiHeartRate(command: String, payload: ByteArray, waitForAck: Boolean) {
        if (!isReady()) return fail("guardian_not_ready")
        MiBand6GuardianProtocol.assertSafeCommand(HUAMI_HEART_RATE_ENDPOINT, payload)
        val encrypted = services.first { it.endpoint == HUAMI_HEART_RATE_ENDPOINT }.encrypted
        val key = if (encrypted) sessionKey ?: return fail("session_key_missing") else null
        if (waitForAck) pendingCommand = command
        val chunks = MiBand6GuardianProtocol.encodeMessage(
            endpoint = HUAMI_HEART_RATE_ENDPOINT,
            handle = nextHandle(),
            mtu = mtu,
            payload = payload,
            sessionKey = key,
            sequenceNumber = if (encrypted) sequenceNumber else 0L,
        )
        if (encrypted) sequenceNumber = (sequenceNumber + 1L) and 0xffffffffL
        enqueue(chunks)
        if (!waitForAck) listener.onCommandAcknowledged(command)
    }

    private fun startStandardManualHeartRate(acknowledgedCommand: String? = null) {
        manualMeasurementStartedAt = System.currentTimeMillis()
        manualMeasurementReceivedAt = null
        continuousFallbackActive = false
        enqueueControlPointCommands(
            listOf(
                MI_BAND_6_HEART_RATE_STOP_CONTINUOUS,
                MI_BAND_6_HEART_RATE_STOP_MANUAL,
                MI_BAND_6_HEART_RATE_START_MANUAL,
            ),
            acknowledgedCommand,
        )
    }

    private fun continueStandardHeartRate() {
        val startedAt = manualMeasurementStartedAt ?: return
        val now = System.currentTimeMillis()
        val receivedAt = manualMeasurementReceivedAt
        when {
            continuousFallbackActive -> Unit
            receivedAt != null && receivedAt >= startedAt && now - receivedAt >= STANDARD_MANUAL_RESTART_MS ->
                startStandardManualHeartRate()
            receivedAt == null && now - startedAt >= STANDARD_MANUAL_TIMEOUT_MS -> {
                continuousFallbackActive = true
                manualMeasurementStartedAt = null
                manualMeasurementReceivedAt = null
                enqueueControlPointCommands(
                    listOf(
                        MI_BAND_6_HEART_RATE_STOP_MANUAL,
                        MI_BAND_6_HEART_RATE_START_CONTINUOUS,
                    ),
                )
            }
        }
    }

    private fun stopStandardHeartRate(acknowledgedCommand: String? = null) {
        manualMeasurementStartedAt = null
        manualMeasurementReceivedAt = null
        continuousFallbackActive = false
        enqueueControlPointCommands(
            listOf(
                MI_BAND_6_HEART_RATE_STOP_CONTINUOUS,
                MI_BAND_6_HEART_RATE_STOP_MANUAL,
            ),
            acknowledgedCommand,
        )
    }

    private fun enqueueControlPointCommands(
        payloads: List<ByteArray>,
        acknowledgedCommand: String? = null,
    ) {
        if (!isReady()) return fail("guardian_not_ready")
        val characteristic = heartRateControlPoint ?: return fail("heart_rate_control_point_missing")
        payloads.forEachIndexed { index, payload ->
            MiBand6GuardianProtocol.assertSafeHeartRateControlPointCommand(payload)
            writeQueue.addLast(PendingWrite(
                characteristic = characteristic,
                bytes = payload.copyOf(),
                acknowledgedCommand = acknowledgedCommand.takeIf { index == payloads.lastIndex },
            ))
        }
        drainWrites()
    }

    private fun enqueue(
        chunks: List<ByteArray>,
        target: BluetoothGattCharacteristic? = authWrite,
        acknowledgedCommand: String? = null,
    ) {
        val characteristic = target ?: return fail("write_characteristic_missing")
        chunks.forEachIndexed { index, bytes ->
            writeQueue.addLast(PendingWrite(
                characteristic,
                bytes.copyOf(),
                acknowledgedCommand.takeIf { index == chunks.lastIndex },
            ))
        }
        drainWrites()
    }

    private fun drainWrites() {
        if (writing || batteryRead.pending) return
        val next = writeQueue.pollFirst() ?: return
        val current = gatt ?: return fail("gatt_unavailable")
        val writeType = preferredWriteType(next.characteristic)
            ?: return fail("write_characteristic_not_writable")
        writing = true
        activeWrite = next
        val accepted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            current.writeCharacteristic(next.characteristic, next.bytes, writeType) == 0
        } else {
            @Suppress("DEPRECATION")
            next.characteristic.run {
                this.writeType = writeType
                value = next.bytes
                current.writeCharacteristic(this)
            }
        }
        if (!accepted) {
            activeWrite = null
            writing = false
            fail("gatt_write_rejected")
        }
    }

    private fun preferredWriteType(characteristic: BluetoothGattCharacteristic): Int? = when {
        (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_WRITE) != 0 ->
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0 ->
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        else -> null
    }

    private fun fail(code: String) {
        finishTimeSync("time_sync_write_failed")
        listener.onError(code)
    }

    private fun nextHandle(): Int {
        writeHandle = (writeHandle + 1) and 0xff
        return writeHandle
    }

    private fun clearSession() {
        activityTransfer?.disconnected()
        activityTransfer = null
        activityBlocked = false
        lastActivityEvidence = null
        batteryRead.reset()
        batteryCharacteristic = null
        // Clear queued writes before completing a disconnected battery request.
        writeQueue.clear()
        finishBattery(null, "battery_disconnected")
        finishTimeSync("time_sync_disconnected")
        writeQueue.clear()
        writing = false
        activeWrite = null
        authWrite = null
        authRead = null
        heartRate = null
        heartRateControlPoint = null
        privateKey?.fill(0)
        privateKey = null
        sessionKey?.fill(0)
        sessionKey = null
        authKey?.fill(0)
        authKey = null
        decoder.setSessionKey(null)
        decoder.reset()
        services = emptyList()
        pendingCommand = null
        heartRateControlMode = HeartRateControlMode.NONE
        manualMeasurementStartedAt = null
        manualMeasurementReceivedAt = null
        continuousFallbackActive = false
        sequenceNumber = 0L
        writeHandle = 0
        mtu = 23
        notificationStage = NotificationStage.NONE
        authReadNotificationEnabled = false
        heartRateNotificationEnabled = false
        serviceDiscoveryStarted = false
        servicesResolved = false
        authenticationComplete = false
        mtuUpgradePending = false
    }

    private fun findCharacteristic(
        services: List<BluetoothGattService>,
        uuid: UUID,
    ): BluetoothGattCharacteristic? = services.asSequence()
        .mapNotNull { it.getCharacteristic(uuid) }
        .firstOrNull()
}
