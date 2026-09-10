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

    // Push-to-talk: the platform speech dialog transcribes, the transcript
    // becomes a task for the master. Hands-free "hey Jarvis" (openWakeWord)
    // is the follow-up milestone.
    private val speechLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val spoken = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.trim()
        if (!spoken.isNullOrEmpty()) {
            hub.sendCommand(Commands.submitTask(spoken))
            speak("On it. Sent to the master agent.")
            Toast.makeText(this, "Task sent: $spoken", Toast.LENGTH_SHORT).show()
        }
    }

    private fun speak(text: String) {
        if (ttsReady) tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "hq")
    }

    private fun startVoiceCapture() {
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Give the master agent a task")
        try {
            speechLauncher.launch(intent)
        } catch (error: Exception) {
            Toast.makeText(this, "No speech recognizer available on this device", Toast.LENGTH_SHORT).show()
        }
    }

    private val notifPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) enableBackground() else {
            Toast.makeText(this, "Notifications denied — background alerts stay off", Toast.LENGTH_SHORT).show()
            backgroundState?.invoke(false)
        }
    }

    private fun uiPrefs() = getSharedPreferences("agenthq-ui", MODE_PRIVATE)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        hub = HubHolder.get(applicationContext)
        hub.ensureConnected()
        tts = TextToSpeech(this) { status -> ttsReady = status == TextToSpeech.SUCCESS }
        if (uiPrefs().getBoolean("bgService", false)) {
            ContextCompat.startForegroundService(this, Intent(this, LinkService::class.java))
        }

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
        ContextCompat.startForegroundService(this, Intent(this, LinkService::class.java))
    }

    private fun disableBackground() {
        uiPrefs().edit().putBoolean("bgService", false).apply()
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
