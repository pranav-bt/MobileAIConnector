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

// Mirrors the hub's MAX_SHARED_FILE_BYTES cap on the file channel.
private const val MAX_SEND_BYTES = 6 * 1024 * 1024

// FragmentActivity (not ComponentActivity) so BiometricPrompt works.
class MainActivity : FragmentActivity() {

    private lateinit var hub: HubClient
    private var backgroundState: ((Boolean) -> Unit)? = null

    private val voiceMicPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) listenForTask()
        else Toast.makeText(this, "Microphone denied — voice input unavailable", Toast.LENGTH_SHORT).show()
    }

    private fun startVoiceCapture() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) listenForTask() else voiceMicPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    private fun listenForTask() {
        // Capture goes through the draft-and-confirm flow: nothing is sent to
        // the master until the user says "send" (or taps Send in the overlay).
        dev.neureal.agenthq.voice.TaskCapture.begin(this)
    }

    // --- phone -> PC file channel -------------------------------------------

    private val filePicker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) sendUriToPc(uri)
    }

    // Share sheet ("share to Agent HQ" from Gallery, Gemini, anywhere) and the
    // in-app picker both end here: read, shrink oversized images, send.
    private fun handleShareIntent(intent: Intent?) {
        if (intent == null || (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE)) return
        val uris: List<android.net.Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(
                if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, android.net.Uri::class.java)
                else @Suppress("DEPRECATION") (intent.getParcelableExtra(Intent.EXTRA_STREAM) as? android.net.Uri),
            )
            else -> (
                if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, android.net.Uri::class.java)
                else @Suppress("DEPRECATION") intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
                )?.filterNotNull() ?: emptyList()
        }
        val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
        intent.action = Intent.ACTION_MAIN // consumed — never re-send on recreation

        if (uris.isEmpty() && !sharedText.isNullOrBlank()) {
            // Text shares (an answer, a link) become a note in the inbox.
            hub.sendFile("note-${System.currentTimeMillis().toString(36)}.txt", "text/plain", sharedText.toByteArray()) { error ->
                runOnUiThread { Toast.makeText(this, error ?: "Note sent to the PC inbox", Toast.LENGTH_LONG).show() }
            }
            return
        }
        if (uris.size > 8) Toast.makeText(this, "Sending the first 8 files", Toast.LENGTH_SHORT).show()
        uris.take(8).forEach { sendUriToPc(it) }
    }

    private fun sendUriToPc(uri: android.net.Uri) {
        Thread {
            try {
                val resolver = contentResolver
                val mime = resolver.getType(uri) ?: "application/octet-stream"
                var name = "shared-${System.currentTimeMillis().toString(36)}"
                resolver.query(uri, null, null, null, null)?.use { cursor ->
                    val column = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                    if (column >= 0 && cursor.moveToFirst()) cursor.getString(column)?.let { name = it }
                }
                var bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0)
                var outMime = mime
                var outName = name
                // The link caps files at 6MB; oversized images are recompressed.
                if (bytes.size > MAX_SEND_BYTES && mime.startsWith("image/")) {
                    val shrunk = shrinkImage(bytes)
                    if (shrunk != null) {
                        bytes = shrunk
                        outMime = "image/jpeg"
                        outName = (name.substringBeforeLast('.', name)) + ".jpg"
                    }
                }
                if (bytes.isEmpty() || bytes.size > MAX_SEND_BYTES) {
                    runOnUiThread {
                        Toast.makeText(
                            this,
                            if (bytes.isEmpty()) "Couldn't read that file" else "Too large — the link caps files at 6MB",
                            Toast.LENGTH_LONG,
                        ).show()
                    }
                    return@Thread
                }
                hub.sendFile(outName, outMime, bytes) { error ->
                    runOnUiThread { Toast.makeText(this, error ?: "Sent to the PC inbox: $outName", Toast.LENGTH_LONG).show() }
                }
            } catch (error: Exception) {
                runOnUiThread { Toast.makeText(this, "Send failed: ${error.message}", Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    // Downsample to <=2048px on the long side, then walk JPEG quality down
    // until the image fits under the link's 6MB cap.
    private fun shrinkImage(bytes: ByteArray): ByteArray? = try {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
        val opts = android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        if (bitmap == null) null
        else {
            var quality = 90
            var out: ByteArray
            do {
                val stream = java.io.ByteArrayOutputStream()
                bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality, stream)
                out = stream.toByteArray()
                quality -= 15
            } while (out.size > MAX_SEND_BYTES && quality >= 30)
            if (out.size > MAX_SEND_BYTES) null else out
        }
    } catch (error: Exception) {
        null
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
        // With the overlay grant, "hey Jarvis" can bring the app up from the
        // background; without it, voice still works headless.
        if (!android.provider.Settings.canDrawOverlays(this)) {
            Toast.makeText(this, "Allow 'display over other apps' so Jarvis can open the app when called", Toast.LENGTH_LONG).show()
            try {
                startActivity(
                    Intent(
                        android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        android.net.Uri.parse("package:$packageName"),
                    ),
                )
            } catch (ignored: Exception) {}
        }
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
        dev.neureal.agenthq.voice.VoiceFeedback.init(this)
        if (uiPrefs().getBoolean("bgService", false)) startLinkService()

        // Debug convenience: adb shell am start ... -e payload_b64 <base64 of QR json>
        val prefill = intent.getStringExtra("payload_b64")?.let {
            try { String(Base64.decode(it, Base64.DEFAULT)) } catch (e: Exception) { "" }
        } ?: ""

        handleShareIntent(intent)

        setContent {
            AgentHqTheme { Root(prefill) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
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
                onSendFile = { filePicker.launch("*/*") },
                onUnpair = {
                    disableBackground()
                    hub.unpair()
                },
            )
        }
    }

    override fun onDestroy() {
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
