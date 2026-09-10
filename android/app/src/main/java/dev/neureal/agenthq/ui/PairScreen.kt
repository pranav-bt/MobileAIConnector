package dev.neureal.agenthq.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun PairScreen(
    initialPayload: String,
    busy: Boolean,
    error: String?,
    onScan: () -> Unit,
    onPair: (String) -> Unit,
) {
    var payload by remember(initialPayload) { mutableStateOf(initialPayload) }

    Column(
        modifier = Modifier.fillMaxSize().background(HQ.bg).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier.size(34.dp).border(1.5.dp, HQ.accent, RoundedCornerShape(9.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text("HQ", color = HQ.accent, fontSize = 12.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
            }
            Spacer(Modifier.size(12.dp))
            Text("AGENT HQ", color = HQ.text, fontSize = 18.sp, fontWeight = FontWeight.Bold, letterSpacing = 3.sp)
        }
        Spacer(Modifier.height(10.dp))
        Text(
            "Pair with your PC: open Security → Pair a device in the desktop app, then scan the QR. Keys are pinned on both sides — only this phone will ever connect.",
            color = HQ.muted, fontSize = 13.sp, lineHeight = 19.sp,
        )
        Spacer(Modifier.height(24.dp))

        Button(
            onClick = onScan,
            enabled = !busy,
            modifier = Modifier.fillMaxWidth().height(52.dp),
            shape = RoundedCornerShape(11.dp),
            colors = ButtonDefaults.buttonColors(containerColor = HQ.accentSolid, contentColor = HQ.accentInk),
        ) {
            Text(if (busy) "Pairing…" else "Scan pairing QR", fontSize = 15.sp, fontWeight = FontWeight.Bold)
        }

        Spacer(Modifier.height(18.dp))
        Text("or paste the pairing code", color = HQ.faint, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = payload,
            onValueChange = { payload = it },
            modifier = Modifier.fillMaxWidth(),
            minLines = 3,
            maxLines = 5,
            textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text2, fontSize = 11.sp, fontFamily = FontFamily.Monospace),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = HQ.accent,
                unfocusedBorderColor = HQ.line,
                cursorColor = HQ.accent,
            ),
        )
        Spacer(Modifier.height(10.dp))
        OutlinedButton(
            onClick = { onPair(payload) },
            enabled = !busy && payload.isNotBlank(),
            modifier = Modifier.fillMaxWidth().height(46.dp),
            shape = RoundedCornerShape(10.dp),
        ) {
            Text("Pair with pasted code", color = HQ.text2, fontSize = 13.sp)
        }

        if (error != null) {
            Spacer(Modifier.height(14.dp))
            Text(error, color = HQ.red, fontSize = 12.5.sp, lineHeight = 18.sp)
        }
    }
}
