package com.anonymous.junluo

import org.bouncycastle.asn1.x9.X9ECParameters
import org.bouncycastle.crypto.ec.CustomNamedCurves
import org.bouncycastle.math.ec.ECPoint
import java.math.BigInteger
import java.security.SecureRandom
import java.util.zip.CRC32
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

internal const val HUAMI_AUTH_ENDPOINT = 0x0082
internal const val HUAMI_SERVICES_ENDPOINT = 0x0000
internal const val HUAMI_HEART_RATE_ENDPOINT = 0x001d
internal val HUAMI_SERVICES_REQUEST = byteArrayOf(0x03)
internal val HUAMI_HEART_RATE_START = byteArrayOf(0x04, 0x01)
internal val HUAMI_HEART_RATE_CONTINUE = byteArrayOf(0x04, 0x02)
internal val HUAMI_HEART_RATE_STOP = byteArrayOf(0x04, 0x00)
internal val MI_BAND_6_HEART_RATE_START_MANUAL = byteArrayOf(0x15, 0x02, 0x01)
internal val MI_BAND_6_HEART_RATE_STOP_MANUAL = byteArrayOf(0x15, 0x02, 0x00)
internal val MI_BAND_6_HEART_RATE_START_CONTINUOUS = byteArrayOf(0x15, 0x01, 0x01)
internal val MI_BAND_6_HEART_RATE_STOP_CONTINUOUS = byteArrayOf(0x15, 0x01, 0x00)

internal data class GuardianChallengeResponse(
    val sequenceNumber: Long,
    val payload: ByteArray,
    val sessionKey: ByteArray,
)

internal data class GuardianDecodedPayload(
    val count: Int,
    val encrypted: Boolean,
    val endpoint: Int,
    val handle: Int,
    val needsAck: Boolean,
    val payload: ByteArray,
)

internal data class GuardianServiceEntry(val endpoint: Int, val encrypted: Boolean)

internal object MiBand6GuardianProtocol {
    private const val PRIVATE_KEY_LENGTH = 24
    private const val PUBLIC_KEY_LENGTH = 48
    private val curve: X9ECParameters = CustomNamedCurves.getByName("sect163r2")
        ?: error("BouncyCastle sect163r2 is unavailable")
    private val scalarMask = BigInteger.ONE.shiftLeft(162).subtract(BigInteger.ONE)

    fun generatePrivateKey(random: SecureRandom = SecureRandom()): ByteArray {
        repeat(8) {
            val candidate = ByteArray(PRIVATE_KEY_LENGTH).also(random::nextBytes)
            if (privateScalar(candidate) != BigInteger.ZERO) return candidate
        }
        error("Unable to generate Mi Band 6 B-163 private key")
    }

    fun generatePublicKey(privateKey: ByteArray): ByteArray = encodePoint(
        curve.g.multiply(privateScalar(privateKey)).normalize(),
    )

    fun generateSharedSecret(privateKey: ByteArray, remotePublicKey: ByteArray): ByteArray = encodePoint(
        decodePoint(remotePublicKey).multiply(privateScalar(privateKey)).normalize(),
    )

    fun publicKeyAuthPayload(publicKey: ByteArray): ByteArray {
        require(publicKey.size == PUBLIC_KEY_LENGTH)
        return byteArrayOf(0x04, 0x02, 0x00, 0x02) + publicKey
    }

    fun challengeResponse(
        privateKey: ByteArray,
        authKey: ByteArray,
        remotePayload: ByteArray,
    ): GuardianChallengeResponse {
        require(authKey.size == 16)
        require(remotePayload.size == 67 && remotePayload[0] == 0x10.toByte()
            && remotePayload[1] == 0x04.toByte() && remotePayload[2] == 0x01.toByte())
        val remoteRandom = remotePayload.copyOfRange(3, 19)
        val remotePublic = remotePayload.copyOfRange(19, 67)
        val sharedSecret = generateSharedSecret(privateKey, remotePublic)
        val sequence = readUInt32LE(sharedSecret, 0)
        val sessionKey = ByteArray(16) { index ->
            (sharedSecret[index + 8].toInt() xor authKey[index].toInt()).toByte()
        }
        return GuardianChallengeResponse(
            sequenceNumber = sequence,
            payload = byteArrayOf(0x05) + aesEcb(authKey, remoteRandom, Cipher.ENCRYPT_MODE)
                + aesEcb(sessionKey, remoteRandom, Cipher.ENCRYPT_MODE),
            sessionKey = sessionKey,
        )
    }

    fun authSucceeded(payload: ByteArray): Boolean = payload.size >= 3
        && payload[0] == 0x10.toByte() && payload[1] == 0x05.toByte()
        && payload[2] == 0x01.toByte()

    fun authRejected(payload: ByteArray): Boolean = payload.size >= 3
        && payload[0] == 0x10.toByte() && payload[1] == 0x05.toByte()
        && payload[2] == 0x25.toByte()

    fun encodeAuth(endpoint: Int, handle: Int, mtu: Int, payload: ByteArray): List<ByteArray> {
        require(endpoint == HUAMI_AUTH_ENDPOINT)
        require((payload.size == 52 && payload[0] == 0x04.toByte())
            || (payload.size == 33 && payload[0] == 0x05.toByte()))
        return encodeChunks(endpoint, handle, mtu, payload, payload.size, false)
    }

    fun encodeMessage(
        endpoint: Int,
        handle: Int,
        mtu: Int,
        payload: ByteArray,
        sessionKey: ByteArray? = null,
        sequenceNumber: Long = 0,
    ): List<ByteArray> {
        assertSafeCommand(endpoint, payload)
        val wire = if (sessionKey == null) payload else encryptMessage(
            payload, sessionKey, handle, sequenceNumber,
        )
        return encodeChunks(endpoint, handle, mtu, wire, payload.size, sessionKey != null)
    }

    fun chunkAck(handle: Int, count: Int): ByteArray = byteArrayOf(
        0x04, 0x00, (handle and 0xff).toByte(), 0x01, (count and 0xff).toByte(),
    )

    fun assertSafeCommand(endpoint: Int, payload: ByteArray) {
        val allowed = when (endpoint) {
            HUAMI_SERVICES_ENDPOINT -> payload.contentEquals(HUAMI_SERVICES_REQUEST)
            HUAMI_HEART_RATE_ENDPOINT -> payload.contentEquals(HUAMI_HEART_RATE_START)
                || payload.contentEquals(HUAMI_HEART_RATE_CONTINUE)
                || payload.contentEquals(HUAMI_HEART_RATE_STOP)
            else -> false
        }
        require(allowed) { "Guardian rejected a non-whitelisted Huami command" }
    }

    fun assertSafeHeartRateControlPointCommand(payload: ByteArray) {
        val allowed = payload.contentEquals(MI_BAND_6_HEART_RATE_START_MANUAL)
            || payload.contentEquals(MI_BAND_6_HEART_RATE_STOP_MANUAL)
            || payload.contentEquals(MI_BAND_6_HEART_RATE_START_CONTINUOUS)
            || payload.contentEquals(MI_BAND_6_HEART_RATE_STOP_CONTINUOUS)
        require(allowed) { "Guardian rejected a non-whitelisted heart-rate control-point command" }
    }

    fun parseServiceList(payload: ByteArray): List<GuardianServiceEntry> {
        require(payload.size >= 3 && payload[0] == 0x04.toByte())
        val count = (payload[1].toInt() and 0xff) or ((payload[2].toInt() and 0xff) shl 8)
        require(payload.size == 3 + count * 3)
        val entries = mutableListOf<GuardianServiceEntry>()
        var offset = 3
        repeat(count) {
            val endpoint = (payload[offset].toInt() and 0xff) +
                ((payload[offset + 1].toInt() and 0xff) shl 8)
            val encrypted = payload[offset + 2].toInt() and 0xff
            require(encrypted == 0 || encrypted == 1)
            entries += GuardianServiceEntry(endpoint, encrypted == 1)
            offset += 3
        }
        return entries
    }

    fun parseStandardHeartRate(bytes: ByteArray): Int? {
        if (bytes.size < 2) return null
        val flags = bytes[0].toInt() and 0xff
        val value = if ((flags and 0x01) == 0) {
            bytes[1].toInt() and 0xff
        } else {
            if (bytes.size < 3) return null
            (bytes[1].toInt() and 0xff) or ((bytes[2].toInt() and 0xff) shl 8)
        }
        return value.takeIf { it in 1..300 }
    }

    fun crc32(bytes: ByteArray): Long = CRC32().let { crc ->
        crc.update(bytes)
        crc.value and 0xffffffffL
    }

    private fun privateScalar(privateKey: ByteArray): BigInteger {
        require(privateKey.size == PRIVATE_KEY_LENGTH)
        val raw = BigInteger(1, privateKey.reversedArray())
        require(raw.bitLength() >= 81)
        return raw.and(scalarMask).also { require(it != BigInteger.ZERO) }
    }

    private fun decodePoint(publicKey: ByteArray): ECPoint {
        require(publicKey.size == PUBLIC_KEY_LENGTH)
        val x = BigInteger(1, publicKey.copyOfRange(0, PRIVATE_KEY_LENGTH).reversedArray())
        val y = BigInteger(1, publicKey.copyOfRange(PRIVATE_KEY_LENGTH, PUBLIC_KEY_LENGTH).reversedArray())
        return curve.curve.createPoint(x, y).normalize().also { require(it.isValid) }
    }

    private fun encodePoint(point: ECPoint): ByteArray = fixedLittleEndian(
        point.affineXCoord.toBigInteger(), PRIVATE_KEY_LENGTH,
    ) + fixedLittleEndian(point.affineYCoord.toBigInteger(), PRIVATE_KEY_LENGTH)

    private fun fixedLittleEndian(value: BigInteger, length: Int): ByteArray {
        val bigEndian = value.toByteArray().let { raw ->
            if (raw.size > 1 && raw[0] == 0.toByte()) raw.copyOfRange(1, raw.size) else raw
        }
        require(bigEndian.size <= length)
        return ByteArray(length).also { output ->
            bigEndian.indices.forEach { index -> output[index] = bigEndian[bigEndian.lastIndex - index] }
        }
    }

    private fun aesEcb(key: ByteArray, input: ByteArray, mode: Int): ByteArray {
        require(key.size == 16 && input.isNotEmpty() && input.size % 16 == 0)
        return Cipher.getInstance("AES/ECB/NoPadding").run {
            init(mode, SecretKeySpec(key, "AES"))
            doFinal(input)
        }
    }

    private fun messageKey(sessionKey: ByteArray, handle: Int): ByteArray {
        require(sessionKey.size == 16)
        return ByteArray(16) { index ->
            (sessionKey[index].toInt() xor (handle and 0xff)).toByte()
        }
    }

    private fun encryptMessage(
        payload: ByteArray,
        sessionKey: ByteArray,
        handle: Int,
        sequenceNumber: Long,
    ): ByteArray {
        val sequence = uint32LE(sequenceNumber)
        val crc = uint32LE(crc32(payload + sequence))
        val plainLength = payload.size + 8
        val padded = ByteArray(((plainLength + 15) / 16) * 16)
        payload.copyInto(padded)
        sequence.copyInto(padded, payload.size)
        crc.copyInto(padded, payload.size + 4)
        return aesEcb(messageKey(sessionKey, handle), padded, Cipher.ENCRYPT_MODE)
    }

    private fun encodeChunks(
        endpoint: Int,
        handle: Int,
        mtuValue: Int,
        wirePayload: ByteArray,
        declaredLength: Int,
        encrypted: Boolean,
    ): List<ByteArray> {
        val mtu = maxOf(23, mtuValue)
        val chunks = mutableListOf<ByteArray>()
        var offset = 0
        var count = 0
        while (offset < wirePayload.size) {
            val first = offset == 0
            val headerLength = if (first) 11 else 5
            val copyLength = minOf(wirePayload.size - offset, mtu - 3 - headerLength)
            require(copyLength > 0)
            val last = offset + copyLength >= wirePayload.size
            val chunk = ByteArray(headerLength + copyLength)
            chunk[0] = 0x03
            chunk[1] = ((if (first) 0x01 else 0x00)
                or (if (last) 0x06 else 0x00)
                or (if (encrypted) 0x08 else 0x00)).toByte()
            chunk[3] = (handle and 0xff).toByte()
            chunk[4] = (count and 0xff).toByte()
            if (first) {
                uint32LE(declaredLength.toLong()).copyInto(chunk, 5)
                chunk[9] = (endpoint and 0xff).toByte()
                chunk[10] = ((endpoint shr 8) and 0xff).toByte()
            }
            wirePayload.copyInto(chunk, headerLength, offset, offset + copyLength)
            chunks += chunk
            offset += copyLength
            count += 1
        }
        return chunks
    }

    private fun uint32LE(value: Long): ByteArray = byteArrayOf(
        (value and 0xff).toByte(),
        ((value shr 8) and 0xff).toByte(),
        ((value shr 16) and 0xff).toByte(),
        ((value shr 24) and 0xff).toByte(),
    )

    private fun readUInt32LE(bytes: ByteArray, offset: Int): Long =
        (bytes[offset].toLong() and 0xff) or
            ((bytes[offset + 1].toLong() and 0xff) shl 8) or
            ((bytes[offset + 2].toLong() and 0xff) shl 16) or
            ((bytes[offset + 3].toLong() and 0xff) shl 24)
}

internal class GuardianChunkDecoder {
    private var expectedLength = 0
    private var endpoint = 0
    private var handle: Int? = null
    private var encrypted = false
    private var parts = mutableListOf<ByteArray>()
    private var sessionKey: ByteArray? = null

    fun setSessionKey(value: ByteArray?) {
        sessionKey?.fill(0)
        sessionKey = value?.copyOf()
    }

    fun reset() {
        expectedLength = 0
        endpoint = 0
        handle = null
        encrypted = false
        parts.clear()
    }

    fun decode(data: ByteArray): GuardianDecodedPayload? {
        if (data.size < 5 || data[0] != 0x03.toByte()) return null
        val flags = data[1].toInt() and 0xff
        val first = flags and 0x01 != 0
        val last = flags and 0x02 != 0
        val needsAck = flags and 0x04 != 0
        val incomingEncrypted = flags and 0x08 != 0
        val incomingHandle = data[3].toInt() and 0xff
        val count = data[4].toInt() and 0xff
        var offset = 5
        if (first) {
            require(data.size >= 11)
            expectedLength = (data[5].toInt() and 0xff) +
                ((data[6].toInt() and 0xff) shl 8) +
                ((data[7].toInt() and 0xff) shl 16) +
                ((data[8].toInt() and 0xff) shl 24)
            endpoint = (data[9].toInt() and 0xff) or ((data[10].toInt() and 0xff) shl 8)
            encrypted = incomingEncrypted
            handle = incomingHandle
            parts.clear()
            offset = 11
        } else if (handle != incomingHandle || encrypted != incomingEncrypted) {
            return null
        }
        parts += data.copyOfRange(offset, data.size)
        if (!last) return null
        val wire = parts.fold(ByteArray(0)) { acc, item -> acc + item }
        val payload = if (!encrypted) {
            require(wire.size >= expectedLength)
            wire.copyOf(expectedLength)
        } else {
            val key = sessionKey ?: error("Encrypted guardian packet arrived without a session key")
            require(wire.isNotEmpty() && wire.size % 16 == 0)
            val decrypted = Cipher.getInstance("AES/ECB/NoPadding").run {
                val messageKey = ByteArray(16) { index ->
                    (key[index].toInt() xor incomingHandle).toByte()
                }
                init(Cipher.DECRYPT_MODE, SecretKeySpec(messageKey, "AES"))
                doFinal(wire)
            }
            require(expectedLength + 8 <= decrypted.size)
            val output = decrypted.copyOf(expectedLength)
            val sequence = decrypted.copyOfRange(expectedLength, expectedLength + 4)
            val expectedCrc = decrypted.copyOfRange(expectedLength + 4, expectedLength + 8)
            val actualCrc = MiBand6GuardianProtocol.crc32(output + sequence)
            val actualCrcBytes = byteArrayOf(
                (actualCrc and 0xff).toByte(), ((actualCrc shr 8) and 0xff).toByte(),
                ((actualCrc shr 16) and 0xff).toByte(), ((actualCrc shr 24) and 0xff).toByte(),
            )
            require(expectedCrc.contentEquals(actualCrcBytes))
            output
        }
        val result = GuardianDecodedPayload(
            count = count,
            encrypted = encrypted,
            endpoint = endpoint,
            handle = incomingHandle,
            needsAck = needsAck,
            payload = payload,
        )
        reset()
        return result
    }
}
