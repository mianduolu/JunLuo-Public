package com.anonymous.junluo.externalfiles

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

internal object JunLuoSyncObjectChunkCrypto {
    private const val PART_KEY_INFO = "junluo.sync.v1/object-part-key"
    private const val ROUTING_CONTEXT = "junluo.sync.v1/object-part-routing"
    private const val NONCE_CONTEXT = "junluo.sync.v1/object-part-nonce"
    private const val ENCRYPTION_CONTEXT = "junluo.sync.v1/object-chunk-encryption"
    private const val SIGNATURE_CONTEXT = "junluo.sync.v1/object-chunk-signature"
    private val uuidV4 = Regex(
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    private val base64Url = Regex("^[A-Za-z0-9_-]+$")

    data class Input(
        val vaultId: String,
        val sourceDeviceId: String,
        val objectId: String,
        val chunkIndex: Int,
        val keyId: String,
        val plaintext: ByteArray,
        val expectedPlaintextSha256: String,
        val objectEncryptionKey: ByteArray,
        val signingPrivateKey: ByteArray,
    )

    data class SealedChunk(
        val protocolVersion: Int,
        val vaultId: String,
        val sourceDeviceId: String,
        val objectId: String,
        val chunkIndex: Int,
        val keyId: String,
        val nonce: String,
        val ciphertext: String,
        val ciphertextSha256: String,
        val signature: String,
    )

    fun seal(input: Input): SealedChunk {
        require(uuidV4.matches(input.vaultId)) { "vaultId is invalid" }
        require(uuidV4.matches(input.sourceDeviceId)) { "sourceDeviceId is invalid" }
        require(uuidV4.matches(input.keyId)) { "keyId is invalid" }
        require(input.chunkIndex in 0 until 100_000) { "chunkIndex is invalid" }
        require(base64Url.matches(input.objectId)) { "objectId is invalid" }
        require(decodeBase64Url(input.objectId).size == 32) { "objectId length is invalid" }
        require(input.objectEncryptionKey.size == 32) { "objectEncryptionKey length is invalid" }
        require(input.signingPrivateKey.size == 32) { "signingPrivateKey length is invalid" }
        require(input.plaintext.size <= 4 * 1024 * 1024) { "plaintext chunk is too large" }
        require(
            MessageDigest.isEqual(
                sha256(input.plaintext),
                decodeBase64Url(input.expectedPlaintextSha256),
            )
        ) { "plaintextSha256 does not match" }

        val routing = routingJson(input)
        val salt = sha256(routing.toByteArray(StandardCharsets.UTF_8))
        val key = hkdfSha256(
            inputKeyMaterial = input.objectEncryptionKey,
            salt = salt,
            info = PART_KEY_INFO.toByteArray(StandardCharsets.UTF_8),
        )
        val nonceEnvelope = "{\"context\":\"$NONCE_CONTEXT\",\"routing\":$routing}"
        val nonce = hmacSha256(
            key,
            nonceEnvelope.toByteArray(StandardCharsets.UTF_8),
        ).copyOfRange(0, 24)
        val aad = chunkAadJson(input).toByteArray(StandardCharsets.UTF_8)
        val encrypted = encryptXChaCha20Poly1305(
            plaintext = input.plaintext,
            key = key,
            nonce = nonce,
            associatedData = aad,
        )
        val unsigned = SealedChunk(
            protocolVersion = 1,
            vaultId = input.vaultId,
            sourceDeviceId = input.sourceDeviceId,
            objectId = input.objectId,
            chunkIndex = input.chunkIndex,
            keyId = input.keyId,
            nonce = encodeBase64Url(nonce),
            ciphertext = encodeBase64Url(encrypted),
            ciphertextSha256 = encodeBase64Url(sha256(encrypted)),
            signature = "",
        )
        val signatureMessage = (
            "{\"chunk\":" + unsignedJson(unsigned)
                + ",\"context\":\"$SIGNATURE_CONTEXT\"}"
        ).toByteArray(StandardCharsets.UTF_8)
        return unsigned.copy(
            signature = encodeBase64Url(
                signEd25519(signatureMessage, input.signingPrivateKey)
            )
        )
    }

    private fun routingJson(input: Input): String {
        return "{\"chunkIndex\":${input.chunkIndex}" +
            ",\"context\":\"$ROUTING_CONTEXT\"" +
            ",\"keyId\":\"${input.keyId}\"" +
            ",\"objectId\":\"${input.objectId}\"" +
            ",\"part\":\"chunk\"" +
            ",\"protocolVersion\":1" +
            ",\"vaultId\":\"${input.vaultId}\"}"
    }

    private fun chunkAadJson(input: Input): String {
        return "{\"chunkIndex\":${input.chunkIndex}" +
            ",\"context\":\"$ENCRYPTION_CONTEXT\"" +
            ",\"keyId\":\"${input.keyId}\"" +
            ",\"objectId\":\"${input.objectId}\"" +
            ",\"protocolVersion\":1" +
            ",\"vaultId\":\"${input.vaultId}\"}"
    }

    private fun unsignedJson(chunk: SealedChunk): String {
        return "{\"chunkIndex\":${chunk.chunkIndex}" +
            ",\"ciphertext\":\"${chunk.ciphertext}\"" +
            ",\"ciphertextSha256\":\"${chunk.ciphertextSha256}\"" +
            ",\"keyId\":\"${chunk.keyId}\"" +
            ",\"nonce\":\"${chunk.nonce}\"" +
            ",\"objectId\":\"${chunk.objectId}\"" +
            ",\"protocolVersion\":${chunk.protocolVersion}" +
            ",\"sourceDeviceId\":\"${chunk.sourceDeviceId}\"" +
            ",\"vaultId\":\"${chunk.vaultId}\"}"
    }

    private fun hkdfSha256(
        inputKeyMaterial: ByteArray,
        salt: ByteArray,
        info: ByteArray,
    ): ByteArray {
        val pseudoRandomKey = hmacSha256(salt, inputKeyMaterial)
        return hmacSha256(pseudoRandomKey, info + byteArrayOf(1))
    }

    private fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(message)
    }

    private fun sha256(value: ByteArray): ByteArray {
        return MessageDigest.getInstance("SHA-256").digest(value)
    }

    private fun encryptXChaCha20Poly1305(
        plaintext: ByteArray,
        key: ByteArray,
        nonce: ByteArray,
        associatedData: ByteArray,
    ): ByteArray {
        require(key.size == 32) { "XChaCha20 key length is invalid" }
        require(nonce.size == 24) { "XChaCha20 nonce length is invalid" }
        val subKey = hChaCha20(key, nonce.copyOfRange(0, 16))
        val ietfNonce = ByteArray(12)
        nonce.copyInto(ietfNonce, destinationOffset = 4, startIndex = 16)
        val cipher = Cipher.getInstance("ChaCha20-Poly1305")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(subKey, "ChaCha20"),
            IvParameterSpec(ietfNonce),
        )
        cipher.updateAAD(associatedData)
        return cipher.doFinal(plaintext)
    }

    private fun hChaCha20(key: ByteArray, nonce: ByteArray): ByteArray {
        require(key.size == 32) { "HChaCha20 key length is invalid" }
        require(nonce.size == 16) { "HChaCha20 nonce length is invalid" }
        val state = intArrayOf(
            0x61707865,
            0x3320646e,
            0x79622d32,
            0x6b206574,
            littleEndianInt(key, 0),
            littleEndianInt(key, 4),
            littleEndianInt(key, 8),
            littleEndianInt(key, 12),
            littleEndianInt(key, 16),
            littleEndianInt(key, 20),
            littleEndianInt(key, 24),
            littleEndianInt(key, 28),
            littleEndianInt(nonce, 0),
            littleEndianInt(nonce, 4),
            littleEndianInt(nonce, 8),
            littleEndianInt(nonce, 12),
        )
        repeat(10) {
            quarterRound(state, 0, 4, 8, 12)
            quarterRound(state, 1, 5, 9, 13)
            quarterRound(state, 2, 6, 10, 14)
            quarterRound(state, 3, 7, 11, 15)
            quarterRound(state, 0, 5, 10, 15)
            quarterRound(state, 1, 6, 11, 12)
            quarterRound(state, 2, 7, 8, 13)
            quarterRound(state, 3, 4, 9, 14)
        }
        val output = ByteArray(32)
        intToLittleEndian(state[0], output, 0)
        intToLittleEndian(state[1], output, 4)
        intToLittleEndian(state[2], output, 8)
        intToLittleEndian(state[3], output, 12)
        intToLittleEndian(state[12], output, 16)
        intToLittleEndian(state[13], output, 20)
        intToLittleEndian(state[14], output, 24)
        intToLittleEndian(state[15], output, 28)
        return output
    }

    private fun quarterRound(
        state: IntArray,
        a: Int,
        b: Int,
        c: Int,
        d: Int,
    ) {
        state[a] += state[b]
        state[d] = Integer.rotateLeft(state[d] xor state[a], 16)
        state[c] += state[d]
        state[b] = Integer.rotateLeft(state[b] xor state[c], 12)
        state[a] += state[b]
        state[d] = Integer.rotateLeft(state[d] xor state[a], 8)
        state[c] += state[d]
        state[b] = Integer.rotateLeft(state[b] xor state[c], 7)
    }

    private fun littleEndianInt(value: ByteArray, offset: Int): Int {
        return (value[offset].toInt() and 0xff) or
            ((value[offset + 1].toInt() and 0xff) shl 8) or
            ((value[offset + 2].toInt() and 0xff) shl 16) or
            ((value[offset + 3].toInt() and 0xff) shl 24)
    }

    private fun intToLittleEndian(value: Int, output: ByteArray, offset: Int) {
        output[offset] = value.toByte()
        output[offset + 1] = (value ushr 8).toByte()
        output[offset + 2] = (value ushr 16).toByte()
        output[offset + 3] = (value ushr 24).toByte()
    }

    private fun signEd25519(message: ByteArray, privateSeed: ByteArray): ByteArray {
        val signer = Ed25519Signer()
        signer.init(true, Ed25519PrivateKeyParameters(privateSeed, 0))
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    private fun encodeBase64Url(value: ByteArray): String {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value)
    }

    private fun decodeBase64Url(value: String): ByteArray {
        require(base64Url.matches(value)) { "base64url value is invalid" }
        return Base64.getUrlDecoder().decode(value)
    }

}
