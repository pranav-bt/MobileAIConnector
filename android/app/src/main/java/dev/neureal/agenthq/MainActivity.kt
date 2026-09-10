package dev.neureal.agenthq

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.widget.Toast
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
                onUnpair = {
                    disableBackground()
                    hub.unpair()
                },
            )
        }
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
