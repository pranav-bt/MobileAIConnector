package dev.neureal.agenthq.net

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dev.neureal.agenthq.MainActivity
import dev.neureal.agenthq.R
import dev.neureal.agenthq.voice.VoiceCommander
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

// Keeps the encrypted hub link alive while the app is closed and raises a
// high-priority notification the moment an agent needs an approval. Tapping
// a notification opens the app (approvals stay biometric-gated in-app).
class LinkService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val seen = HashSet<String>()
    private var voice: VoiceCommander? = null
    private var collecting = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_LINK, "Hub link", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Keeps the connection to your PC alive"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "An agent is waiting on your approval"
            },
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val jarvisWanted = getSharedPreferences("agenthq-ui", MODE_PRIVATE).getBoolean("jarvis", false)
        val micGranted = ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        val jarvisOn = jarvisWanted && micGranted

        // Foreground-service types keep tightening across Android versions;
        // try the precise declaration first and degrade gracefully.
        val notification = persistentNotification(jarvisOn)
        val attempts = buildList {
            if (Build.VERSION.SDK_INT >= 34) {
                var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                if (jarvisOn) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                add(types)
            }
            if (Build.VERSION.SDK_INT >= 30 && jarvisOn) add(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            if (Build.VERSION.SDK_INT >= 30) add(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        }
        var started = false
        for (types in attempts) {
            try {
                ServiceCompat.startForeground(this, 1, notification, types)
                started = true
                break
            } catch (error: Exception) {
                android.util.Log.w("AgentHQ", "startForeground type=$types failed: $error")
            }
        }
        if (!started) {
            try {
                startForeground(1, notification)
            } catch (error: Exception) {
                android.util.Log.e("AgentHQ", "startForeground failed entirely: $error")
                stopSelf()
                return START_NOT_STICKY
            }
        }

        val hub = HubHolder.get(applicationContext)
        hub.ensureConnected()

        if (jarvisOn && voice == null) {
            voice = VoiceCommander(applicationContext, hub).also { it.start() }
        } else if (!jarvisOn && voice != null) {
            voice?.stop()
            voice = null
        }

        if (collecting) return START_STICKY
        collecting = true

        // Buzz when the PC pushes a file (screenshot, worker output).
        scope.launch {
            var seenFiles = hub.filesFlow.value.map { it.id }.toSet()
            hub.filesFlow.collect { files ->
                val manager = getSystemService(NotificationManager::class.java)
                for (file in files) {
                    if (file.id in seenFiles) continue
                    manager.notify(
                        file.id.hashCode(),
                        NotificationCompat.Builder(this@LinkService, CHANNEL_APPROVALS)
                            .setSmallIcon(R.drawable.ic_launcher_foreground)
                            .setContentTitle("File from HQ: ${file.name}")
                            .setContentText(if (file.from == "pc-screen") "PC screenshot" else "sent by ${file.from}")
                            .setAutoCancel(true)
                            .setContentIntent(openAppIntent())
                            .build(),
                    )
                }
                seenFiles = files.map { it.id }.toSet()
            }
        }

        scope.launch {
            hub.snapshotFlow.collect { snapshot ->
                val pending = snapshot.permissions.filter { it.status == "pending" }
                val manager = getSystemService(NotificationManager::class.java)
                for (request in pending) {
                    if (!seen.add(request.id)) continue
                    val agent = snapshot.agents.firstOrNull { it.id == request.agentId }?.name ?: request.agentId
                    manager.notify(
                        request.id.hashCode(),
                        NotificationCompat.Builder(this@LinkService, CHANNEL_APPROVALS)
                            .setSmallIcon(R.drawable.ic_launcher_foreground)
                            .setContentTitle("Approval needed: ${request.command.take(40)}")
                            .setContentText("$agent · ${request.flags.joinToString(", ").ifEmpty { "gated action" }}")
                            .setPriority(NotificationCompat.PRIORITY_HIGH)
                            .setAutoCancel(true)
                            .setContentIntent(openAppIntent())
                            .build(),
                    )
                }
                // Clear notifications for requests that were resolved elsewhere.
                val pendingIds = pending.map { it.id }.toSet()
                for (id in seen.filter { it !in pendingIds }) {
                    manager.cancel(id.hashCode())
                    seen.remove(id)
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        voice?.stop()
        voice = null
        scope.cancel()
        super.onDestroy()
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun persistentNotification(jarvis: Boolean): Notification =
        NotificationCompat.Builder(this, CHANNEL_LINK)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(if (jarvis) "Agent HQ linked · \"hey Jarvis\" armed" else "Agent HQ linked")
            .setContentText(if (jarvis) "Listening on-device · watching for approvals" else "Watching for approvals from your agents")
            .setOngoing(true)
            .setContentIntent(openAppIntent())
            .build()

    companion object {
        private const val CHANNEL_LINK = "link"
        private const val CHANNEL_APPROVALS = "approvals"
    }
}
