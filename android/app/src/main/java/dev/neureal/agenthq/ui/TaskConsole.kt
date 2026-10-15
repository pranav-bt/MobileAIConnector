package dev.neureal.agenthq.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.neureal.agenthq.model.PermissionRequest
import dev.neureal.agenthq.model.Snapshot
import dev.neureal.agenthq.model.TranscriptEntry
import dev.neureal.agenthq.net.HubHolder
import kotlinx.coroutines.flow.MutableStateFlow

// Which task console is open (null = none). Any task card can open one; a
// link row inside a console switches to the linked task.
object ConsoleNav {
    val open = MutableStateFlow<String?>(null)
}

private val RUNNING = setOf("in_flight", "awaiting_permission", "review")
private val STOPPABLE = setOf("routing", "queued", "in_flight", "awaiting_permission", "review")

// A task's console on the phone: the whole story (your ask, routing, the
// worker's messages and every command/edit, cards inline, the lead's review)
// plus a message box — into the running conversation while it works, or
// continuing the same conversation after it finished or was stopped.
@Composable
fun TaskConsoleScreen(snapshot: Snapshot, taskId: String, onRespond: (PermissionRequest, String, Int?) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val hub = HubHolder.get(context.applicationContext)
    DisposableEffect(taskId) {
        hub.watchTask(taskId)
        onDispose { hub.unwatchTask(taskId) }
    }
    BackHandler { onClose() }
    val all by hub.transcripts.collectAsState()
    val more by hub.transcriptMore.collectAsState()
    val rows = all[taskId].orEmpty()
    val task = snapshot.tasks.firstOrNull { it.id == taskId }
    var draft by remember(taskId) { mutableStateOf("") }
    val listState = rememberLazyListState()
    LaunchedEffect(rows.size, rows.lastOrNull()?.state) {
        if (rows.isNotEmpty()) listState.animateScrollToItem(rows.size)
    }

    Column(Modifier.fillMaxSize().background(HQ.bg).imePadding()) {
        Row(
            Modifier.fillMaxWidth().background(HQ.panel).padding(horizontal = 6.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = onClose) { Text("‹", color = HQ.accent, fontSize = 22.sp) }
            Column(Modifier.weight(1f)) {
                Text(task?.title ?: "Task", color = HQ.text, fontSize = 13.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Text(
                    listOfNotNull(task?.status?.replace('_', ' '), task?.teamId, task?.projectId).joinToString(" · "),
                    color = HQ.muted, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                )
                task?.pair?.let { pair ->
                    val state = when (pair.state) {
                        "reviewing" -> "reviewer checking"
                        "agreed" -> "agreed"
                        "disagreed" -> "went with it — still disagreed"
                        else -> "author working"
                    }
                    Text(
                        "Pair · round ${pair.round}/${pair.maxRounds} · ${pair.reviewerModel ?: "other engine"} reviews · $state",
                        color = if (pair.state == "agreed") HQ.green else HQ.accent, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    )
                }
            }
            if (task != null && task.status in STOPPABLE) {
                OutlinedButton(onClick = { hub.sendCommand(dev.neureal.agenthq.model.Commands.stopTask(taskId)) }, shape = RoundedCornerShape(8.dp)) {
                    Text("Stop", color = HQ.red, fontSize = 12.sp)
                }
            }
        }

        LazyColumn(state = listState, modifier = Modifier.weight(1f).padding(horizontal = 12.dp)) {
            if (more[taskId] == true) {
                item {
                    TextButton(onClick = { hub.loadEarlier(taskId) }, modifier = Modifier.fillMaxWidth()) {
                        Text("Load earlier", color = HQ.accent, fontSize = 12.sp)
                    }
                }
            }
            if (rows.isEmpty()) {
                item { Text("No console history yet for this task.", color = HQ.ghost, fontSize = 11.sp, modifier = Modifier.padding(vertical = 12.dp)) }
            }
            items(rows, key = { it.id }) { row -> ConsoleRow(row, snapshot, onRespond) }
            item {
                val worker = snapshot.agents.firstOrNull { it.taskId == taskId && it.role == "worker" }
                if (task != null && task.status in RUNNING && worker != null) {
                    Text("${worker.name} · ${worker.activity}", color = HQ.accent, fontSize = 10.5.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.padding(vertical = 8.dp))
                }
            }
        }

        val canSend = task?.teamId != null
        Row(
            Modifier.fillMaxWidth().background(HQ.panel).padding(10.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                enabled = canSend,
                modifier = Modifier.weight(1f).heightIn(max = 160.dp),
                placeholder = {
                    Text(
                        when {
                            !canSend -> "This task never reached a team"
                            task!!.status in RUNNING -> "Message the worker…"
                            task.status in setOf("done", "failed", "paused") -> "Continue this task…"
                            else -> "Add to the brief…"
                        },
                        color = HQ.faint, fontSize = 12.sp,
                    )
                },
                textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 13.sp),
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = HQ.accent, unfocusedBorderColor = HQ.line, cursorColor = HQ.accent),
            )
            Button(
                onClick = {
                    val text = draft.trim()
                    if (text.isNotEmpty()) {
                        hub.messageTask(taskId, text)
                        draft = ""
                    }
                },
                enabled = canSend && draft.isNotBlank(),
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = HQ.accentSolid, contentColor = HQ.accentInk),
                modifier = Modifier.height(52.dp),
            ) { Text("Send", fontWeight = FontWeight.Bold, fontSize = 13.sp) }
        }
    }
}

@Composable
private fun ConsoleRow(row: TranscriptEntry, snapshot: Snapshot, onRespond: (PermissionRequest, String, Int?) -> Unit) {
    val who = when (row.role) {
        "owner" -> "You"
        "master" -> "Master"
        "lead" -> snapshot.agents.firstOrNull { it.id == row.agentId }?.name ?: "Lead"
        "worker" -> snapshot.agents.firstOrNull { it.id == row.agentId }?.name ?: "Worker"
        else -> "Agent HQ"
    }
    when (row.kind) {
        "tool", "diff" -> ToolLine(row)
        "card" -> {
            val request = snapshot.permissions.firstOrNull { it.id == row.requestId }
            if (request != null && request.status == "pending") {
                Box(Modifier.padding(vertical = 6.dp)) { ApprovalCard(request, snapshot, onRespond) }
            } else {
                Text("card ${request?.status ?: "answered"} · ${row.text}", color = HQ.faint, fontSize = 10.5.sp, modifier = Modifier.padding(vertical = 4.dp))
            }
        }
        "status" -> Row(Modifier.padding(vertical = 3.dp)) {
            Text(
                "$who  ${row.text}",
                color = HQ.faint, fontSize = 10.5.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.weight(1f, fill = false),
            )
            val link = row.linkTaskId
            if (link != null) {
                Text("  open ›", color = HQ.accent, fontSize = 10.5.sp, modifier = Modifier.clickable { ConsoleNav.open.value = link })
            }
        }
        "thinking" -> {
            var open by remember(row.id) { mutableStateOf(false) }
            Text(
                if (open) row.text else "thinking… ▸",
                color = HQ.ghost, fontSize = 10.5.sp, fontStyle = FontStyle.Italic,
                modifier = Modifier.padding(vertical = 3.dp).clickable { open = !open },
            )
        }
        else -> {
            val mine = row.role == "owner"
            Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
                Column(
                    Modifier
                        .widthIn(max = 320.dp)
                        .background(if (mine) Color(0x144FD8C4) else HQ.panel2, RoundedCornerShape(10.dp))
                        .border(1.dp, if (mine) Color(0x594FD8C4) else if (row.role == "lead") Color(0x599D8CFF) else HQ.line, RoundedCornerShape(10.dp))
                        .padding(horizontal = 11.dp, vertical = 8.dp),
                ) {
                    Text(if (row.role == "lead") "$who · review" else who, color = if (row.role == "lead") HQ.violet else HQ.faint, fontSize = 10.sp)
                    SelectionContainer { Text(row.text, color = HQ.text, fontSize = 12.5.sp, lineHeight = 17.sp) }
                }
            }
        }
    }
}

@Composable
private fun ToolLine(row: TranscriptEntry) {
    var open by remember(row.id) { mutableStateOf(false) }
    val (mark, color) = when (row.state) {
        "running" -> "●" to HQ.amber
        "error" -> "✗" to HQ.red
        else -> "✓" to HQ.green
    }
    Column(Modifier.padding(vertical = 2.dp).clickable(enabled = row.detail != null) { open = !open }) {
        Row {
            Text("$mark ", color = color, fontSize = 11.sp, fontFamily = FontFamily.Monospace)
            Text(
                "${if (row.kind == "diff") "edit" else row.tool ?: "tool"}  ${row.text}",
                color = HQ.text2, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                maxLines = if (open) 20 else 1,
            )
        }
        if (open && row.detail != null) {
            SelectionContainer {
                Text(
                    row.detail.take(4000),
                    color = HQ.text2, fontSize = 10.5.sp, fontFamily = FontFamily.Monospace, lineHeight = 14.sp,
                    modifier = Modifier.fillMaxWidth().padding(start = 16.dp, top = 4.dp, bottom = 6.dp)
                        .background(HQ.panel2, RoundedCornerShape(6.dp)).padding(8.dp),
                )
            }
        }
    }
}
