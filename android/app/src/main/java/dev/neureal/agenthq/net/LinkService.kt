package dev.neureal.agenthq.net

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import dev.neureal.agenthq.MainActivity
import dev.neureal.agenthq.R
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
        startForeground(1, persistentNotification())
        val hub = HubHolder.get(applicationContext)
        hub.ensureConnected()

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
        scope.cancel()
        super.onDestroy()
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun persistentNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_LINK)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("Agent HQ linked")
            .setContentText("Watching for approvals from your agents")
            .setOngoing(true)
            .setContentIntent(openAppIntent())
            .build()

    companion object {
        private const val CHANNEL_LINK = "link"
        private const val CHANNEL_APPROVALS = "approvals"
    }
}
