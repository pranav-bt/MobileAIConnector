package dev.neureal.agenthq.voice

import kotlinx.coroutines.flow.MutableStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// Breadcrumbs for every stage of a voice capture, shown on the Link tab —
// the same trick as the crash card: one screenshot from the phone says
// exactly which stage went quiet, instead of guessing.
object VoiceTrace {
    val lines = MutableStateFlow<List<String>>(emptyList())

    fun log(message: String) {
        android.util.Log.i("AgentHQ-voice", message)
        val stamp = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        lines.value = (lines.value + "$stamp $message").takeLast(30)
    }

    fun clear() {
        lines.value = emptyList()
    }

    fun errorName(code: Int): String = when (code) {
        1 -> "NETWORK_TIMEOUT"
        2 -> "NETWORK"
        3 -> "AUDIO"
        4 -> "SERVER"
        5 -> "CLIENT"
        6 -> "SPEECH_TIMEOUT"
        7 -> "NO_MATCH"
        8 -> "RECOGNIZER_BUSY"
        9 -> "INSUFFICIENT_PERMISSIONS"
        else -> "ERR_$code"
    }
}
