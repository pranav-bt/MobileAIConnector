package dev.neureal.agenthq.voice

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import dev.neureal.agenthq.net.HubHolder
import java.util.Locale

// Spoken tasks are DRAFTED, never fired straight at the master: the first
// round of speech becomes a draft, then Jarvis asks — "send" submits,
// "cancel" discards, and anything else is appended (so pausing mid-thought
// no longer sends half a sentence). The draft also shows in the in-app
// overlay with Send/Discard buttons, which is the fallback whenever a
// confirm round errors out or times out.
object TaskCapture {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null

    // True while a capture (any entry point) is running. The wake-word loop
    // must release the microphone while this is set: the platform recognizer
    // lives in ANOTHER app's process, and Android silences its audio stream
    // when we hold an AudioRecord — the recognizer then "hears" nothing and
    // errors out, which surfaced as "I didn't catch that" on every attempt.
    @Volatile var captureActive = false
        private set

    private val SEND_WORDS = setOf(
        "send", "send it", "yes", "yeah", "yep", "yes send", "confirm", "go ahead",
        "do it", "ok", "okay", "ok send", "okay send", "submit", "ship it",
    )
    private val CANCEL_WORDS = setOf(
        "cancel", "discard", "no", "nope", "never mind", "nevermind", "forget it",
        "stop", "scrap it", "delete it", "delete",
    )
    private val READ_MORE_WORDS = setOf(
        "read more", "read everything", "read it all", "read all", "read the rest",
        "full version", "hear everything", "read the full report", "more",
    )

    fun submitDraft(context: Context) {
        val text = VoiceSession.draft.value?.trim().orEmpty()
        if (text.isEmpty()) return
        VoiceSession.draft.value = null
        val hub = HubHolder.get(context.applicationContext)
        // Waits for the encrypted session — a raw send would drop silently
        // when the link is down, which reads as "it just did nothing".
        VoiceTrace.log("submitting: \"${text.take(50)}\"")
        hub.submitTask(text) { error ->
            VoiceTrace.log("submit -> ${error ?: "sent"}")
            if (error == null) {
                VoiceFeedback.speak("On it.")
                VoiceFeedback.followTask(hub, text)
            } else {
                VoiceSession.draft.value = text // nothing was sent — keep it
                VoiceFeedback.speak("$error. Your draft is kept — try again once linked.")
            }
        }
    }

    fun discardDraft() {
        VoiceSession.draft.value = null
    }

    // Entry point for both push-to-talk and "hey Jarvis". If a draft is
    // already waiting, this goes straight to a confirm round.
    fun begin(context: Context, onDone: (() -> Unit)? = null) {
        val app = context.applicationContext
        if (!SpeechRecognizer.isRecognitionAvailable(app)) {
            VoiceFeedback.speak("No speech recognizer on this phone.")
            onDone?.invoke()
            return
        }
        VoiceTrace.log("begin: draft=${if (VoiceSession.draft.value == null) "none" else "pending"}")
        captureActive = true // wake loop releases the mic when it sees this
        VoiceFeedback.hush() // never let the recognizer transcribe Jarvis itself
        chirp()
        // Give the wake loop a beat to actually release its AudioRecord
        // before the recognizer opens the mic.
        mainHandler.postDelayed({ round(app, confirm = VoiceSession.draft.value != null, onDone = onDone) }, 300)
    }

    private fun round(app: Context, confirm: Boolean, onDone: (() -> Unit)?, retriesLeft: Int = 1) {
        mainHandler.post {
            VoiceSession.listening.value = true
            recognizer?.destroy()
            val rec = SpeechRecognizer.createSpeechRecognizer(app)
            recognizer = rec
            // Some recognizer versions deliver the transcript ONLY through
            // partial results and hand onResults an empty list (seen live on
            // the Flip 5) — keep the latest partial as the fallback.
            var lastPartial: String? = null
            rec.setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle) {
                    rec.destroy()
                    recognizer = null
                    VoiceSession.listening.value = false
                    val finalText = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()?.trim()
                    val text = if (finalText.isNullOrEmpty()) lastPartial?.trim() else finalText
                    VoiceTrace.log(
                        "heard(${if (confirm) "confirm" else "capture"}): \"${text?.take(60) ?: "(empty)"}\"" +
                            if (finalText.isNullOrEmpty() && !text.isNullOrEmpty()) " [from partials]" else "",
                    )
                    if (text.isNullOrEmpty()) {
                        VoiceFeedback.speak("I heard nothing.")
                        finish(onDone)
                        return
                    }
                    if (!confirm) {
                        // "hey Jarvis, read more" — replay the full text behind
                        // the last spoken summary instead of drafting a task.
                        if (normalize(text) in READ_MORE_WORDS) {
                            VoiceSession.you(text)
                            VoiceFeedback.readPending()
                            finish(onDone)
                            return
                        }
                        VoiceSession.draft.value = text
                        VoiceSession.you(text)
                        VoiceFeedback.speak("Say send, or keep talking to add more.")
                        afterTts { round(app, confirm = true, onDone = onDone) }
                        return
                    }
                    val verdict = classify(text)
                    VoiceTrace.log("verdict: $verdict")
                    when (verdict) {
                        Verdict.SEND -> {
                            submitDraft(app)
                            finish(onDone)
                        }
                        Verdict.CANCEL -> {
                            discardDraft()
                            VoiceFeedback.speak("Discarded.")
                            finish(onDone)
                        }
                        Verdict.APPEND -> {
                            VoiceSession.draft.value = ((VoiceSession.draft.value ?: "") + " " + text).trim()
                            VoiceSession.you(text)
                            VoiceFeedback.speak("Added. Say send when ready.")
                            afterTts { round(app, confirm = true, onDone = onDone) }
                        }
                    }
                }

                override fun onError(error: Int) {
                    rec.destroy()
                    recognizer = null
                    VoiceSession.listening.value = false
                    VoiceTrace.log("recognizer error: ${VoiceTrace.errorName(error)} (retriesLeft=$retriesLeft, confirm=$confirm)")
                    // Samsung's recognizer is touchy about back-to-back
                    // sessions and mic handoffs — retry once before giving up.
                    if (retriesLeft > 0) {
                        mainHandler.postDelayed({ round(app, confirm = confirm, onDone = onDone, retriesLeft = retriesLeft - 1) }, 500)
                        return
                    }
                    // Never end silently: say what state things are in.
                    if (VoiceSession.draft.value != null) {
                        VoiceFeedback.speak("Your draft is waiting. Say hey Jarvis, then send — or tap send in the app.")
                    } else if (!confirm) {
                        VoiceFeedback.speak("I didn't catch that.")
                    }
                    finish(onDone)
                }

                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onPartialResults(partialResults: Bundle?) {
                    val partial = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()?.trim()
                    if (!partial.isNullOrEmpty()) lastPartial = partial
                }
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            // NOTE: deliberately NO silence-length extras — they push the
            // recognizer down a path that returns EMPTY final results (the
            // trace showed 19s captures ending in nothing). This is the exact
            // intent configuration of the build that worked; mid-thought
            // pauses are handled by the draft+append confirm flow instead.
            rec.startListening(
                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
                    .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true),
            )
        }
    }

    private enum class Verdict { SEND, CANCEL, APPEND }

    // Forgiving match: exact phrases, or a short utterance containing an
    // unambiguous verb ("please send it", "yeah send", "no cancel that").
    private fun classify(raw: String): Verdict {
        val text = normalize(raw)
        if (text in SEND_WORDS) return Verdict.SEND
        if (text in CANCEL_WORDS) return Verdict.CANCEL
        val words = text.split(' ').filter { it.isNotBlank() }
        if (words.size <= 4 && words.any { it in setOf("send", "submit", "ship") }) return Verdict.SEND
        if (words.size <= 4 && words.any { it in setOf("cancel", "discard", "scrap") }) return Verdict.CANCEL
        return Verdict.APPEND
    }

    private fun normalize(text: String): String =
        text.lowercase(Locale.ROOT).trim().trimEnd('.', '!', ',', '?')

    private fun finish(onDone: (() -> Unit)?) {
        captureActive = false // hand the mic back to the wake loop
        onDone?.invoke()
    }

    // Wait for Jarvis to finish talking before the mic reopens, so the
    // confirm round never transcribes the prompt itself. TTS has startup
    // latency, so first wait for it to START (up to 2s), then to end —
    // opening the mic during the prompt would append Jarvis's own words
    // to the draft.
    private fun afterTts(block: () -> Unit) {
        mainHandler.postDelayed(object : Runnable {
            private var waited = 0
            private var started = false
            override fun run() {
                if (VoiceFeedback.isSpeaking()) started = true
                val ttsDone = started && !VoiceFeedback.isSpeaking()
                val neverStarted = !started && waited >= 2000
                if (ttsDone || neverStarted || waited > 12000) {
                    VoiceTrace.log("mic reopening (ttsStarted=$started, waited=${waited}ms)")
                    chirp()
                    block()
                } else {
                    waited += 150
                    mainHandler.postDelayed(this, 150)
                }
            }
        }, 150)
    }

    private fun chirp() {
        try {
            ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80).startTone(ToneGenerator.TONE_PROP_ACK, 120)
        } catch (ignored: Exception) {}
    }
}
