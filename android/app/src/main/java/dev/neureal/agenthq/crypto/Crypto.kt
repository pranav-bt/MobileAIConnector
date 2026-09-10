package dev.neureal.agenthq.crypto

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.X25519
import dev.neureal.agenthq.store.KV
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

// Mirrors the hub's session crypto exactly (packages/hub/src/security/):
// X25519 static+ephemeral agreements -> HKDF-SHA256 over (eph || static)
// with info "agent-hq-session-v1" -> two ChaCha20-Poly1305 keys, counter
// nonces (4 zero bytes + u64 BE). Approvals are Ed25519 signatures over
// "<decision>:<requestId>". Keys are software-held v1 (hardware-backed
// Keystore is a later hardening); biometrics gate their use in the UI.

object Spki {
    // SubjectPublicKeyInfo for 32-byte raw keys is a fixed 12-byte prefix.
    private val X25519_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00)
    private val ED25519_PREFIX = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

    fun wrapX25519(raw: ByteArray): ByteArray = X25519_PREFIX + raw
    fun wrapEd25519(raw: ByteArray): ByteArray = ED25519_PREFIX + raw
    fun unwrap(der: ByteArray): ByteArray {
        require(der.size >= 32) { "SPKI too short" }
        return der.copyOfRange(der.size - 32, der.size)
    }
}

// java.util.Base64 exists on Android (API 26+) AND the plain JVM, so the
// crypto layer stays unit-testable against hub-generated vectors.
fun b64(data: ByteArray): String = Base64.getEncoder().encodeToString(data)
fun unb64(text: String): ByteArray = Base64.getDecoder().decode(text.trim())

// Android (Conscrypt) and the JDK name the same AEAD differently.
internal fun chachaCipher(): Cipher = try {
    Cipher.getInstance("ChaCha20/Poly1305/NoPadding")
} catch (error: Exception) {
    Cipher.getInstance("ChaCha20-Poly1305")
}

object Hkdf {
    private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    // RFC 5869, matching Node's hkdfSync('sha256', ikm, salt, info, length).
    fun derive(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmac(salt, ikm)
        val out = ByteArray(length)
        var previous = ByteArray(0)
        var written = 0
        var counter = 1
        while (written < length) {
            previous = hmac(prk, previous + info + byteArrayOf(counter.toByte()))
            val take = minOf(previous.size, length - written)
            previous.copyInto(out, written, 0, take)
            written += take
            counter += 1
        }
        return out
    }
}

class SessionKeys(val clientToServer: ByteArray, val serverToClient: ByteArray)

fun deriveSessionKeys(
    ownStaticPrivate: ByteArray,
    peerStaticPublicRaw: ByteArray,
    ownEphemeralPrivate: ByteArray,
    peerEphemeralPublicRaw: ByteArray,
    salt: ByteArray,
): SessionKeys {
    val staticSecret = X25519.computeSharedSecret(ownStaticPrivate, peerStaticPublicRaw)
    val ephemeralSecret = X25519.computeSharedSecret(ownEphemeralPrivate, peerEphemeralPublicRaw)
    val okm = Hkdf.derive(ephemeralSecret + staticSecret, salt, "agent-hq-session-v1".toByteArray(), 64)
    return SessionKeys(okm.copyOfRange(0, 32), okm.copyOfRange(32, 64))
}

// The phone SENDS with clientToServer and RECEIVES with serverToClient.
class FrameCrypto(private val sendKey: ByteArray, private val recvKey: ByteArray) {
    private var sendCounter = 0L

    fun seal(plaintext: String): Pair<String, String> {
        val nonce = ByteArray(12)
        var value = sendCounter
        for (i in 11 downTo 4) {
            nonce[i] = (value and 0xff).toByte()
            value = value ushr 8
        }
        sendCounter += 1
        val cipher = chachaCipher()
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sendKey, "ChaCha20"), IvParameterSpec(nonce))
        val sealed = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Pair(b64(nonce), b64(sealed))
    }

    fun open(nonceB64: String, ciphertextB64: String): String? {
        return try {
            val cipher = chachaCipher()
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(recvKey, "ChaCha20"), IvParameterSpec(unb64(nonceB64)))
            String(cipher.doFinal(unb64(ciphertextB64)), Charsets.UTF_8)
        } catch (error: Exception) {
            null // tampered or out-of-order frame — drop
        }
    }
}

// Device identity: one X25519 keypair (transport) + one Ed25519 keypair
// (approval signatures), generated at first pairing and pinned by the hub.
class DeviceIdentity private constructor(
    val staticPrivate: ByteArray,
    val staticPublicRaw: ByteArray,
    val signPrivate: ByteArray,
    val signPublicRaw: ByteArray,
) {
    fun staticPublicDerB64(): String = b64(Spki.wrapX25519(staticPublicRaw))
    fun signPublicDerB64(): String = b64(Spki.wrapEd25519(signPublicRaw))

    fun signApproval(decision: String, requestId: String): String {
        val signer = Ed25519Sign(signPrivate)
        return b64(signer.sign("$decision:$requestId".toByteArray(Charsets.UTF_8)))
    }

    companion object {
        fun loadOrCreate(store: KV): DeviceIdentity {
            val existing = store.get("x25519_priv")
            if (existing != null) {
                return DeviceIdentity(
                    unb64(existing),
                    unb64(store.get("x25519_pub")!!),
                    unb64(store.get("ed25519_priv")!!),
                    unb64(store.get("ed25519_pub")!!),
                )
            }
            val staticPrivate = X25519.generatePrivateKey()
            val staticPublic = X25519.publicFromPrivate(staticPrivate)
            val signPair = Ed25519Sign.KeyPair.newKeyPair()
            store.put(
                "x25519_priv" to b64(staticPrivate),
                "x25519_pub" to b64(staticPublic),
                "ed25519_priv" to b64(signPair.privateKey),
                "ed25519_pub" to b64(signPair.publicKey),
            )
            return DeviceIdentity(staticPrivate, staticPublic, signPair.privateKey, signPair.publicKey)
        }
    }
}
