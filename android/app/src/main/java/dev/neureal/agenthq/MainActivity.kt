package dev.neureal.agenthq

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.widget.Toast
import java.util.Locale
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import dev.neureal.agenthq.model.Commands
import dev.neureal.agenthq.model.PermissionRequest
import dev.neureal.agenthq.net.HubClient
import dev.neureal.agenthq.net.HubHolder
import dev.neureal.agenthq.net.LinkService
import dev.neureal.agenthq.net.LinkState
import dev.neureal.agenthq.ui.AgentHqTheme
import dev.neureal.agenthq.ui.MainScreen
import dev.neureal.agenthq.ui.PairScreen

// FragmentActivity (not ComponentActivity) so BiometricPrompt works.
class MainActivity : FragmentActivity() {

    private lateinit var hub: HubClient
    private var backgroundState: ((Boolean) -> Unit)? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    // Push-to-talk uses the service-based SpeechRecognizer (what Samsung and
    // Google actually implement) rather than the optional dialog activity.
    private var activeRecognizer: android.speech.SpeechRecognizer? = null

    private val voiceMicPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) listenForTask()
        else Toast.makeText(this, "Microphone denied — voice input unavailable", Toast.LENGTH_SHORT).show()
    }

    private fun speak(text: String) {
        if (ttsReady) tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "hq")
    }

    private fun startVoiceCapture() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) listenForTask() else voiceMicPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    private fun listenForTask() {
        if (!android.speech.SpeechRecognizer.isRecognitionAvailable(this)) {
            Toast.makeText(this, "No speech recognition service on this device", Toast.LENGTH_SHORT).show()
            return
        }
        try {
            android.media.ToneGenerator(android.media.AudioManager.STREAM_NOTIFICATION, 80)
                .startTone(android.media.ToneGenerator.TONE_PROP_ACK, 120)
        } catch (ignored: Exception) {}
        Toast.makeText(this, "Listening…", Toast.LENGTH_SHORT).show()

        activeRecognizer?.destroy()
        val recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(this)
        activeRecognizer = recognizer
        recognizer.setRecognitionListener(object : android.speech.RecognitionListener {
            override fun onResults(results: Bundle) {
                val spoken = results.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()?.trim()
                recognizer.destroy()
                activeRecognizer = null
                if (!spoken.isNullOrEmpty()) {
                    hub.sendCommand(Commands.submitTask(spoken))
                    speak("On it. Sent to the master agent.")
                    Toast.makeText(this@MainActivity, "Task sent: $spoken", Toast.LENGTH_SHORT).show()
                }
            }

            override fun onError(error: Int) {
                recognizer.destroy()
                activeRecognizer = null
                if (error != android.speech.SpeechRecognizer.ERROR_CLIENT) {
                    Toast.makeText(this@MainActivity, "Didn't catch that (code $error) — try again", Toast.LENGTH_SHORT).show()
                }
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        recognizer.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault()),
        )
    }

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) enableBackground() else {
            Toast.makeText(this, "Notifications denied — background alerts stay off", Toast.LENGTH_SHORT).show()
            backgroundState?.invoke(false)
        }
    }

    private var jarvisState: ((Boolean) -> Unit)? = null

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) enableJarvis() else {
            Toast.makeText(this, "Microphone denied — hands-free stays off", Toast.LENGTH_SHORT).show()
            jarvisState?.invoke(false)
        }
    }

    private fun enableJarvis() {
        uiPrefs().edit().putBoolean("jarvis", true).putBoolean("bgService", true).apply()
        jarvisState?.invoke(true)
        backgroundState?.invoke(true)
        // (Re)start so the service picks up the microphone foreground type.
        startLinkService()
    }

    private fun disableJarvis() {
        uiPrefs().edit().putBoolean("jarvis", false).apply()
        jarvisState?.invoke(false)
        if (uiPrefs().getBoolean("bgService", false)) startLinkService()
    }

    private fun uiPrefs() = getSharedPreferences("agenthq-ui", MODE_PRIVATE)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        hub = HubHolder.get(applicationContext)
        hub.ensureConnected()
        tts = TextToSpeech(this) { status -> ttsReady = status == TextToSpeech.SUCCESS }
        if (uiPrefs().getBoolean("bgService", false)) startLinkService()

        // Debug convenience: adb shell am start ... -e payload_b64 <base64 of QR json>
        val prefill = intent.getStringExtra("payload_b64")?.let {
            try { String(Base64.decode(it, Base64.DEFAULT)) } catch (e: Exception) { "" }
        } ?: ""

        setContent {
            AgentHqTheme { Root(prefill) }
        }
    }

    @Composable
    private fun Root(prefill: String) {
        val link by hub.linkState.collectAsState()
        val snapshot by hub.snapshotFlow.collectAsState()
        var pairError by remember { mutableStateOf<String?>(null) }
        var backgroundEnabled by remember { mutableStateOf(uiPrefs().getBoolean("bgService", false)) }
        backgroundState = { value -> backgroundEnabled = value }
        var jarvisEnabled by remember { mutableStateOf(uiPrefs().getBoolean("jarvis", false)) }
        jarvisState = { value -> jarvisEnabled = value }

        when (link) {
            is LinkState.Unpaired, is LinkState.PairingInFlight -> PairScreen(
                initialPayload = prefill,
                busy = link is LinkState.PairingInFlight,
                error = pairError,
                onScan = {
                    try {
                        val options = GmsBarcodeScannerOptions.Builder()
                            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                            .build()
                        GmsBarcodeScanning.getClient(this@MainActivity, options)
                            .startScan()
                            .addOnSuccessListener { barcode ->
                                val payload = barcode.rawValue
                                if (payload != null) hub.pair(payload) { error -> pairError = error }
                            }
                            .addOnFailureListener { error ->
                                pairError = "Scanner unavailable (${error.message ?: "unknown"}) — paste the code below instead."
                            }
                    } catch (error: Exception) {
                        pairError = "Scanner failed to start — paste the code below instead."
                    }
                },
                onPair = { payload -> hub.pair(payload) { error -> pairError = error } },
            )

            else -> MainScreen(
                snapshot = snapshot,
                connected = link is LinkState.Connected,
                pairedHost = hub.pairedHost(),
                backgroundEnabled = backgroundEnabled,
                onToggleBackground = { enabled ->
                    backgroundEnabled = enabled
                    if (enabled) requestBackgroundOrEnable() else disableBackground()
                },
                jarvisEnabled = jarvisEnabled,
                onToggleJarvis = { enabled ->
                    jarvisEnabled = enabled
                    if (enabled) {
                        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
                            PackageManager.PERMISSION_GRANTED
                        if (granted) enableJarvis() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    } else {
                        disableJarvis()
                    }
                },
                onRespond = { request, decision -> respondWithBiometric(request, decision) },
                onSubmitTask = { text -> hub.sendCommand(Commands.submitTask(text)) },
                onVoice = { startVoiceCapture() },
                onUnpair = {
                    disableBackground()
                    hub.unpair()
                },
            )
        }
    }

    override fun onDestroy() {
        activeRecognizer?.destroy()
        tts?.shutdown()
        super.onDestroy()
    }

    private fun requestBackgroundOrEnable() {
        val needsPermission = Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        if (needsPermission) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS) else enableBackground()
    }

    private fun enableBackground() {
        uiPrefs().edit().putBoolean("bgService", true).apply()
        backgroundState?.invoke(true)
        startLinkService()
    }

    private fun startLinkService() {
        try {
            ContextCompat.startForegroundService(this, Intent(this, LinkService::class.java))
        } catch (error: Exception) {
            Toast.makeText(this, "Background service refused: ${error.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun disableBackground() {
        uiPrefs().edit().putBoolean("bgService", false).putBoolean("jarvis", false).apply()
        jarvisState?.invoke(false)
        stopService(Intent(this, LinkService::class.java))
    }

    // Approvals sit behind biometrics when the device has them; the Ed25519
    // signature is what the hub actually verifies either way.
    private fun respondWithBiometric(request: PermissionRequest, decision: String) {
        val canBiometric = BiometricManager.from(this)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS
        if (!canBiometric || decision == "deny") {
            hub.respondPermission(request.id, decision)
            return
        }
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    hub.respondPermission(request.id, decision)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    Toast.makeText(this@MainActivity, "Approval cancelled", Toast.LENGTH_SHORT).show()
                }
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("Approve: ${request.command.take(40)}")
                .setSubtitle("Signed with this device's key")
                .setNegativeButtonText("Cancel")
                .build(),
        )
    }
}
