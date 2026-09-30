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
    // Some engines (Samsung TTS among them) can swallow a QUEUE_ADD right
    // after stop(); the first utterance after a hush uses QUEUE_FLUSH.
    @Volatile private var flushNext = false
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    fun init(context: Context) {
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            VoiceTrace.log("tts init: ${if (ready) "ready" else "FAILED status=$status"}")
        }
    }

    // Markdown reads terribly aloud: bullets/headers become pauses, links
    // become their bare text, whitespace collapses.
    private fun sanitizeForSpeech(text: String): String = text
        .replace(Regex("(?m)^\\s*[-*•#]+\\s*"), "")
        .replace(Regex("[*_`#]"), "")
        .replace(Regex("\\s*\\n+\\s*"), ". ")
        .replace(Regex("\\.\\s*\\."), ".")
        .replace(Regex("\\s+"), " ")
        .trim()

    fun speak(text: String) {
        VoiceSession.jarvis(text)
        val queueMode = if (flushNext) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
        flushNext = false
        val spoken = sanitizeForSpeech(text)
        val result = if (ready) tts?.speak(spoken.take(500), queueMode, null, "hq-${System.nanoTime()}") else null
        VoiceTrace.log(
            "speak(${if (queueMode == TextToSpeech.QUEUE_FLUSH) "flush" else "add"}): \"${spoken.take(40)}\" -> " +
                (if (!ready) "NOT READY" else if (result == TextToSpeech.SUCCESS) "ok" else "FAILED($result)"),
        )
    }

    // Speak only the headline; keep the full text for "read more" / "read all".
    fun speakSummary(full: String, prefix: String = "") {
        val headline = full.trim().substringBefore('\n').trim().take(300)
        val hasMore = full.trim().length > headline.length + 30
        if (hasMore) {
            VoiceSession.pendingLong.value = full
            speak("$prefix$headline — say read more to hear everything.")
        } else {
            speak("$prefix${full.trim()}")
        }
    }

    // Read the pending full text, chunked to respect the TTS input limit.
    fun readPending() {
        val full = VoiceSession.pendingLong.value
        if (full == null) {
            speak("Nothing more to read.")
            return
        }
        VoiceSession.pendingLong.value = null
        VoiceSession.jarvis("(reading the full report)")
        val clean = sanitizeForSpeech(full).take(4000)
        var start = 0
        while (start < clean.length && ready) {
            var end = (start + 380).coerceAtMost(clean.length)
            if (end < clean.length) {
                val cut = clean.lastIndexOf(". ", end)
                if (cut > start + 100) end = cut + 1
            }
            tts?.speak(clean.substring(start, end), TextToSpeech.QUEUE_ADD, null, "hq-long-${System.nanoTime()}")
            start = end
        }
    }

    // Shut up NOW: flush the current + queued utterances and stop following
    // tasks. Used when the overlay is dismissed and before the mic opens, so
    // the recognizer never hears Jarvis's own voice.
    fun hush() {
        try { tts?.stop() } catch (ignored: Exception) {}
        flushNext = true
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
                            speakSummary(task.synopsis ?: "No report was filed.", prefix = "Task complete. ")
                            return@withTimeoutOrNull
                        }
                        "failed" -> {
                            speakSummary(task.synopsis ?: "", prefix = "The task failed. ")
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
                                speak("I need your approval. ${pending.summary ?: "It wants to run: " + pending.command.take(80)}")
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
