package dev.neureal.agenthq.voice

import kotlinx.coroutines.flow.MutableStateFlow

// Shared conversational state between the wake service and the UI, so a
// "hey Jarvis" exchange is visible in the app, not just audible.
object VoiceSession {
    data class Line(val fromYou: Boolean, val text: String, val at: Long = System.currentTimeMillis())

    val listening = MutableStateFlow(false)
    val lines = MutableStateFlow<List<Line>>(emptyList())

    fun you(text: String) = add(Line(fromYou = true, text = text))
    fun jarvis(text: String) = add(Line(fromYou = false, text = text))

    private fun add(line: Line) {
        lines.value = (lines.value + line).takeLast(8)
    }

    fun clear() {
        lines.value = emptyList()
        listening.value = false
    }
}
