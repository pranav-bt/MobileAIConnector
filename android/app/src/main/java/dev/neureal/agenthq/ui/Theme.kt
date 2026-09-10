package dev.neureal.agenthq.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Night-ops palette from the desktop app / design canvas.
object HQ {
    val bg = Color(0xFF0B0E14)
    val panel = Color(0xFF10151E)
    val panel2 = Color(0xFF151B26)
    val line = Color(0xFF212A38)
    val text = Color(0xFFE8ECF4)
    val text2 = Color(0xFFA7B0C0)
    val muted = Color(0xFF8B95A7)
    val faint = Color(0xFF5C6678)
    val ghost = Color(0xFF454F60)
    val accent = Color(0xFF4FD8C4)
    val accentSolid = Color(0xFF3ECFB9)
    val accentInk = Color(0xFF05201B)
    val green = Color(0xFF46C08A)
    val amber = Color(0xFFE8B44A)
    val amberBg = Color(0xFF151109)
    val red = Color(0xFFE5685C)
    val violet = Color(0xFF9D8CFF)
}

private val scheme = darkColorScheme(
    primary = HQ.accent,
    onPrimary = HQ.accentInk,
    background = HQ.bg,
    onBackground = HQ.text,
    surface = HQ.panel,
    onSurface = HQ.text,
    surfaceVariant = HQ.panel2,
    outline = HQ.line,
    error = HQ.red,
)

@Composable
fun AgentHqTheme(content: @Composable () -> Unit) {
    isSystemInDarkTheme() // the app commits to the dark look regardless
    MaterialTheme(colorScheme = scheme, content = content)
}
