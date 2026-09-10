package dev.neureal.agenthq.voice

import kotlinx.coroutines.flow.MutableStateFlow

// Shared conversational state between the wake service and the UI, so a
// "hey Jarvis" exchange is visible in the app, not just audible.
object VoiceSession {
    data class Line(val fromYou: Boolean, val text: String, val at: Long = System.currentTimeMillis())

    val listening = MutableStateFlow(false)
    val lines = MutableStateFlow<List<Line>>(emptyList())
    // A spoken task waiting for confirmation ("send") — shown in the overlay
    // with Send/Discard buttons; never submitted without a confirm.
    val draft = MutableStateFlow<String?>(null)

    fun you(text: String) = add(Line(fromYou = true, text = text))
    fun jarvis(text: String) = add(Line(fromYou = false, text = text))

    private fun add(line: Line) {
        lines.value = (lines.value + line).takeLast(8)
    }

    fun clear() {
        lines.value = emptyList()
        listening.value = false
        draft.value = null // dismissing the overlay discards a pending draft
    }
}
