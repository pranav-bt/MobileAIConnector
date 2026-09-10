package dev.neureal.agenthq.voice

import android.content.Context
import android.speech.tts.TextToSpeech
import dev.neureal.agenthq.net.HubClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

// One TTS voice for the whole app (activity + service), plus the follow-up
// watcher that makes Jarvis conversational: it announces where the master
// routed a spoken task and reads the lead's synopsis aloud when it's done.
object VoiceFeedback {
    private var tts: TextToSpeech? = null
    private var ready = false
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    fun init(context: Context) {
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext) { status -> ready = status == TextToSpeech.SUCCESS }
    }

    fun speak(text: String) {
        VoiceSession.jarvis(text)
        if (ready) tts?.speak(text.take(500), TextToSpeech.QUEUE_ADD, null, "hq-${System.nanoTime()}")
    }

    // Shut up NOW: flush the current + queued utterances and stop following
    // tasks. Used when the overlay is dismissed and before the mic opens, so
    // the recognizer never hears Jarvis's own voice.
    fun hush() {
        try { tts?.stop() } catch (ignored: Exception) {}
        scope.coroutineContext.cancelChildren()
    }

    fun isSpeaking(): Boolean = try { tts?.isSpeaking == true } catch (ignored: Exception) { false }

    // Follows a just-submitted task: announce routing, then read the synopsis.
    fun followTask(hub: HubClient, submittedText: String) {
        scope.launch {
            // Correlate by task detail (the hub stores the submitted text verbatim,
            // minus a leading @project pin).
            val stripped = submittedText.replace(Regex("^@\\S+\\s+"), "")
            val taskId = withTimeoutOrNull(20_000) {
                while (true) {
                    val task = hub.snapshotFlow.value.tasks
                        .filter { it.detail == stripped || it.detail == submittedText }
                        .maxByOrNull { it.createdAt }
                    if (task != null) return@withTimeoutOrNull task.id
                    delay(400)
                }
                @Suppress("UNREACHABLE_CODE") null
            } ?: return@launch

            var announcedRouting = false
            withTimeoutOrNull(45 * 60_000) {
                while (true) {
                    val snapshot = hub.snapshotFlow.value
                    val task = snapshot.tasks.firstOrNull { it.id == taskId } ?: return@withTimeoutOrNull
                    if (!announcedRouting && task.teamId != null) {
                        announcedRouting = true
                        val team = snapshot.teams.firstOrNull { it.id == task.teamId }?.name ?: task.teamId
                        val project = snapshot.projects.firstOrNull { it.id == task.projectId }?.name
                        speak("Routed to $team${if (project != null) ", project $project" else ""}.")
                    }
                    when (task.status) {
                        "done" -> {
                            speak("Task complete. ${task.synopsis ?: "No report was filed."}")
                            return@withTimeoutOrNull
                        }
                        "failed" -> {
                            speak("The task failed. ${task.synopsis ?: ""}")
                            return@withTimeoutOrNull
                        }
                        "paused" -> {
                            speak("The task was stopped.")
                            return@withTimeoutOrNull
                        }
                        "awaiting_permission" -> {
                            // Announce once per pending request tied to this task.
                            val pending = snapshot.permissions.firstOrNull { it.taskId == taskId && it.status == "pending" }
                            if (pending != null && !announcedPermissions.contains(pending.id)) {
                                announcedPermissions.add(pending.id)
                                speak("I need your approval to run: ${pending.command.take(80)}")
                            }
                        }
                    }
                    delay(1_000)
                }
            }
        }
    }

    private val announcedPermissions = HashSet<String>()
}
