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

    private val SEND_WORDS = setOf(
        "send", "send it", "yes", "yeah", "yep", "yes send", "confirm", "go ahead",
        "do it", "ok", "okay", "ok send", "okay send", "submit", "ship it",
    )
    private val CANCEL_WORDS = setOf(
        "cancel", "discard", "no", "nope", "never mind", "nevermind", "forget it",
        "stop", "scrap it", "delete it", "delete",
    )

    fun submitDraft(context: Context) {
        val text = VoiceSession.draft.value?.trim().orEmpty()
        if (text.isEmpty()) return
        VoiceSession.draft.value = null
        val hub = HubHolder.get(context.applicationContext)
        // Waits for the encrypted session — a raw send would drop silently
        // when the link is down, which reads as "it just did nothing".
        hub.submitTask(text) { error ->
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
        VoiceFeedback.hush() // never let the recognizer transcribe Jarvis itself
        chirp()
        round(app, confirm = VoiceSession.draft.value != null, onDone = onDone)
    }

    private fun round(app: Context, confirm: Boolean, onDone: (() -> Unit)?, retriesLeft: Int = 1) {
        mainHandler.post {
            VoiceSession.listening.value = true
            recognizer?.destroy()
            val rec = SpeechRecognizer.createSpeechRecognizer(app)
            recognizer = rec
            rec.setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle) {
                    rec.destroy()
                    recognizer = null
                    VoiceSession.listening.value = false
                    val text = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull()?.trim()
                    if (text.isNullOrEmpty()) {
                        finish(onDone)
                        return
                    }
                    if (!confirm) {
                        VoiceSession.draft.value = text
                        VoiceSession.you(text)
                        VoiceFeedback.speak("Say send, or keep talking to add more.")
                        afterTts { round(app, confirm = true, onDone = onDone) }
                        return
                    }
                    when (classify(text)) {
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
                    // Samsung's recognizer is touchy about back-to-back
                    // sessions — retry a confirm round once before giving up.
                    if (confirm && retriesLeft > 0) {
                        mainHandler.postDelayed({ round(app, confirm = true, onDone = onDone, retriesLeft = retriesLeft - 1) }, 500)
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
                override fun onPartialResults(partialResults: Bundle?) {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            rec.startListening(
                Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
                    // A thinking pause should not end the capture prematurely.
                    .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2000)
                    .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000),
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
