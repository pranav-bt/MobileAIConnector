# Agent HQ — Android companion (not scaffolded yet)

Kotlin + Jetpack Compose app. Scaffolded in the mobile milestone (needs
Android Studio / the Android SDK on this machine).

Planned modules:

| Module | Responsibility |
|---|---|
| `app` | Compose UI: office view, task list, approval screen, security screen |
| `transport` | WebSocket client to the hub, mDNS/NSD discovery, reconnect + Doze handling |
| `crypto` | Pairing (QR scan), key pinning, approval signing with a hardware-backed Keystore key behind `BiometricPrompt` |
| `voice` | Porcupine "Jarvis" wake-word foreground service, `SpeechRecognizer` STT, `TextToSpeech` replies |

Contract: the app speaks exactly the `@agent-hq/shared` protocol
(`EventEnvelope` in, `ClientCommand` out). Kotlin data models are generated
from that schema — never hand-drift them.
