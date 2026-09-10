# Agent HQ — Android companion

Kotlin + Jetpack Compose app: pair with the hub via QR, watch the live
office, approve permission requests with a fingerprint-backed signature,
submit tasks to the master from your phone.

## Build

Requires JDK 17 and the Android SDK (platform 36). `local.properties` points
at the SDK; the Gradle wrapper handles the rest:

```
cd android
gradlew.bat assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
gradlew.bat :app:testDebugUnitTest   # includes hub-interop crypto tests
```

Install on the phone (USB debugging on): `adb install app-debug.apk`.

## Pairing flow

1. PC: Agent HQ → Security → **Pair a device** (2-minute window).
2. Phone: **Scan pairing QR** (or paste the code). The QR carries the hub's
   LAN address, its public key, and a one-time token; both sides pin keys.
3. The app opens the encrypted session automatically from then on. The PC's
   kill switch revokes the keys — the app drops back to the pairing screen.

## Security model (v1)

- Transport: `ws://` carrier only — every frame after the handshake is
  ChaCha20-Poly1305 sealed with keys from an authenticated X25519 exchange
  (static keys pinned at pairing + ephemeral keys for forward secrecy).
  The math is verified against hub-generated vectors in
  `app/src/test/.../SessionInteropTest.kt` (regenerate with
  `npx tsx test/gen-session-vectors.ts` from `packages/hub`).
- Approvals: Ed25519 signature over `<decision>:<requestId>`, gated by
  BiometricPrompt when the device has biometrics enrolled. The hub drops
  unsigned/forged approvals.
- Keys are software-held (app-private storage) in v1; moving them into the
  hardware Keystore is a planned hardening, as is sealing the pairing frame
  to the PC's public key.

## Not yet

Background service + notifications when the app is closed, mDNS discovery,
and the "Jarvis" wake word — those ride the voice milestone.
