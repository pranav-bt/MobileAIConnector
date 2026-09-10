package dev.neureal.agenthq.voice

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import dev.neureal.agenthq.model.Commands
import dev.neureal.agenthq.net.HubClient
import java.util.Locale

// Hands-free "hey Jarvis": a continuous 16kHz mic loop feeds the
// openWakeWord engine; on detection the mic is handed to the platform
// SpeechRecognizer, the transcript goes to the master as a task, and TTS
// confirms. Everything is on-device; nothing leaves the phone except the
// sealed task command to your own hub.
class VoiceCommander(
    private val context: Context,
    private val hub: HubClient,
) {
    @Volatile private var running = false
    @Volatile private var capturing = false
    private var thread: Thread? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var engine: WakeWordEngine? = null

    fun start() {
        if (running) return
        running = true
        VoiceFeedback.init(context)
        thread = Thread {
            try {
                val assets = context.assets
                engine = WakeWordEngine.fromStreams(
                    assets.open("oww/melspectrogram.onnx"),
                    assets.open("oww/embedding_model.onnx"),
                    assets.open("oww/hey_jarvis_v0.1.onnx"),
                )
                wakeLoop()
            } catch (error: Exception) {
                running = false
            }
        }.apply { name = "hq-wake"; start() }
    }

    fun stop() {
        running = false
    }

    @SuppressLint("MissingPermission") // RECORD_AUDIO is granted before start()
    private fun wakeLoop() {
        val wakeEngine = engine ?: return
        while (running) {
            if (capturing) {
                Thread.sleep(100)
                continue
            }
            val minBuffer = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val record = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                16000,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                maxOf(minBuffer, WakeWordEngine.CHUNK_SAMPLES * 4),
            )
            try {
                record.startRecording()
                val chunk = ShortArray(WakeWordEngine.CHUNK_SAMPLES)
                while (running && !capturing) {
                    var filled = 0
                    while (filled < chunk.size && running && !capturing) {
                        val n = record.read(chunk, filled, chunk.size - filled)
                        if (n <= 0) break
                        filled += n
                    }
                    if (filled < chunk.size) continue
                    val score = wakeEngine.processChunk(chunk)
                    if (wakeEngine.isWake(score)) {
                        capturing = true
                        mainHandler.post { onWake() }
                    }
                }
            } catch (error: Exception) {
                Thread.sleep(1000) // mic contention (a call, another app) — retry
            } finally {
                try { record.stop() } catch (ignored: Exception) {}
                record.release()
            }
        }
    }

    // Main thread: chirp, bring the app up (if allowed), hand the mic to the
    // platform recognizer, and follow the task so Jarvis talks back.
    private fun onWake() {
        try {
            ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80).startTone(ToneGenerator.TONE_PROP_ACK, 120)
        } catch (ignored: Exception) {}

        VoiceSession.listening.value = true

        // Opening an activity from the background needs the overlay grant;
        // headless voice still works without it.
        try {
            if (Settings.canDrawOverlays(context)) {
                context.startActivity(
                    Intent(context, Class.forName("dev.neureal.agenthq.MainActivity"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                )
            }
        } catch (ignored: Exception) {}

        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            VoiceFeedback.speak("No speech recognizer on this phone.")
            VoiceSession.listening.value = false
            capturing = false
            return
        }

        mainHandler.postDelayed({
            val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
            recognizer.setRecognitionListener(object : RecognitionListener {
                override fun onResults(results: Bundle) {
                    val text = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()
                    recognizer.destroy()
                    VoiceSession.listening.value = false
                    if (!text.isNullOrEmpty()) {
                        VoiceSession.you(text)
                        hub.sendCommand(Commands.submitTask(text))
                        VoiceFeedback.speak("On it.")
                        VoiceFeedback.followTask(hub, text)
                    }
                    capturing = false
                }

                override fun onError(error: Int) {
                    recognizer.destroy()
                    VoiceSession.listening.value = false
                    capturing = false
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
        }, 250)
    }
}
