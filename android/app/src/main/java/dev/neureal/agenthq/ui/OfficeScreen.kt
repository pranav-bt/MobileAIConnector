package dev.neureal.agenthq.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.neureal.agenthq.model.Agent
import dev.neureal.agenthq.model.PermissionRequest
import dev.neureal.agenthq.model.Snapshot
import dev.neureal.agenthq.model.Task
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ---------- shared bits ------------------------------------------------------

private fun ringColor(agent: Agent): Color = when {
    agent.role == "master" -> HQ.accent
    agent.status == "working" -> HQ.green
    agent.status == "waiting_permission" -> HQ.amber
    agent.status == "reporting" -> HQ.violet
    agent.status == "blocked" -> HQ.red
    else -> HQ.ghost
}

private fun initialsOf(agent: Agent): String {
    if (agent.role == "master") return "M"
    val last = agent.name.trim().split(Regex("\\s+")).lastOrNull() ?: ""
    val code = Regex("^([A-Za-z])-?(\\d+)$").find(last)
    if (code != null) return (code.groupValues[1] + code.groupValues[2]).uppercase()
    return agent.name.split(Regex("[\\s-]+")).mapNotNull { it.firstOrNull()?.toString() }
        .joinToString("").uppercase().take(2).ifEmpty { "?" }
}

@Composable
private fun SectionLabel(text: String, color: Color = HQ.faint) {
    Text(text.uppercase(), color = color, fontSize = 9.5.sp, letterSpacing = 1.3.sp, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().background(HQ.panel, RoundedCornerShape(11.dp)).border(1.dp, HQ.line, RoundedCornerShape(11.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) { content() }
}

@Composable
private fun AgentChip(agent: Agent) {
    Row(
        modifier = Modifier.fillMaxWidth()
            .background(HQ.panel2, RoundedCornerShape(8.dp))
            .border(1.dp, if (agent.status == "waiting_permission") HQ.amber.copy(alpha = 0.55f) else HQ.line, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(26.dp).border(2.dp, ringColor(agent), CircleShape).background(Color(0xFF1C2432), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(initialsOf(agent), color = Color(0xFFC9D2E0), fontSize = 8.5.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace)
        }
        Spacer(Modifier.width(9.dp))
        Column {
            Text(agent.name, color = HQ.text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            Text(
                agent.activity.ifEmpty { agent.status },
                color = if (agent.status == "waiting_permission") HQ.amber else HQ.muted,
                fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1,
            )
        }
    }
}

@Composable
private fun ApprovalCard(request: PermissionRequest, snapshot: Snapshot, onRespond: (PermissionRequest, String) -> Unit) {
    val agentName = snapshot.agents.firstOrNull { it.id == request.agentId }?.name ?: request.agentId
    val teamName = snapshot.teams.firstOrNull { it.id == request.teamId }?.name ?: (request.teamId ?: "")
    Column(
        modifier = Modifier.fillMaxWidth()
            .background(HQ.amberBg, RoundedCornerShape(11.dp))
            .border(1.dp, HQ.amber.copy(alpha = 0.5f), RoundedCornerShape(11.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Plain words first; the rule-based risk tags stay visible, and the
        // exact command is one tap away.
        var showCommand by remember(request.id) { mutableStateOf(false) }
        Text(request.summary ?: request.command, color = HQ.text, fontSize = 13.sp, lineHeight = 18.sp)
        if (request.flags.isNotEmpty()) {
            Text(request.flags.joinToString(" · "), color = HQ.amber, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("$teamName · $agentName", color = HQ.muted, fontSize = 10.sp, fontFamily = FontFamily.Monospace, modifier = Modifier.weight(1f))
            Text(
                if (showCommand) "hide command" else "show command",
                color = HQ.accent, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.clickable { showCommand = !showCommand }.padding(4.dp),
            )
        }
        if (showCommand) {
            Text(
                request.command,
                color = Color(0xFFF0D9A5), fontSize = 11.5.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier.fillMaxWidth().background(HQ.panel2, RoundedCornerShape(6.dp)).padding(8.dp),
            )
            if (request.reason.isNotEmpty()) {
                Text(request.reason, color = HQ.text2, fontSize = 11.sp, lineHeight = 15.sp)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onRespond(request, "approve") },
                modifier = Modifier.weight(1f).height(44.dp),
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = HQ.accentSolid, contentColor = HQ.accentInk),
            ) { Text(request.choices?.getOrNull(0) ?: "Approve", fontWeight = FontWeight.Bold, fontSize = 13.sp, maxLines = 1) }
            OutlinedButton(
                onClick = { onRespond(request, "deny") },
                modifier = Modifier.weight(1f).height(44.dp),
                shape = RoundedCornerShape(8.dp),
            ) { Text(request.choices?.getOrNull(1) ?: "Deny", color = HQ.red, fontSize = 13.sp, maxLines = 1) }
        }
    }
}

@Composable
private fun TaskCard(task: Task, showProgress: Boolean) {
    Card {
        Text(task.title, color = HQ.text, fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
        Text(
            "${task.teamId ?: "routing"} · ${task.status.replace('_', ' ')}",
            color = HQ.muted, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
        )
        if (showProgress) {
            Box(Modifier.fillMaxWidth().height(4.dp).background(Color(0xFF1A212E), RoundedCornerShape(2.dp))) {
                Box(
                    Modifier.fillMaxWidth(fraction = (task.progressPct / 100.0).toFloat().coerceIn(0f, 1f))
                        .height(4.dp).background(HQ.accentSolid, RoundedCornerShape(2.dp)),
                )
            }
        }
        if (task.synopsis != null && !showProgress) {
            Text(task.synopsis, color = HQ.muted, fontSize = 11.sp, lineHeight = 15.sp)
        }
    }
}

// ---------- tabs -------------------------------------------------------------

@Composable
fun MainScreen(
    snapshot: Snapshot,
    connected: Boolean,
    pairedHost: String?,
    backgroundEnabled: Boolean,
    onToggleBackground: (Boolean) -> Unit,
    jarvisEnabled: Boolean,
    onToggleJarvis: (Boolean) -> Unit,
    onRespond: (PermissionRequest, String) -> Unit,
    onSubmitTask: (String) -> Unit,
    onVoice: () -> Unit,
    onSendFile: () -> Unit,
    onFreelancerSend: (String, String) -> Unit,
    onUnpair: () -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(0) }
    val pending = snapshot.permissions.filter { it.status == "pending" }.sortedBy { it.requestedAt }

    Scaffold(
        containerColor = HQ.bg,
        floatingActionButton = {
            androidx.compose.material3.FloatingActionButton(
                onClick = onVoice,
                containerColor = HQ.accentSolid,
                contentColor = HQ.accentInk,
            ) {
                Icon(
                    androidx.compose.ui.res.painterResource(dev.neureal.agenthq.R.drawable.ic_mic),
                    contentDescription = "Speak a task",
                    tint = Color.Unspecified,
                )
            }
        },
        bottomBar = {
            NavigationBar(containerColor = HQ.panel, contentColor = HQ.muted) {
                val items = listOf(
                    Triple("Office", Icons.Filled.Home, pending.size),
                    Triple("Tasks", Icons.Filled.Menu, 0),
                    Triple("PA", Icons.Filled.Person, 0),
                    Triple("History", Icons.Filled.DateRange, 0),
                    Triple("Link", Icons.Filled.Settings, 0),
                )
                items.forEachIndexed { index, (label, icon, badge) ->
                    NavigationBarItem(
                        selected = tab == index,
                        onClick = { tab = index },
                        icon = {
                            if (badge > 0) {
                                BadgedBox(badge = { Badge(containerColor = HQ.amber) { Text("$badge", color = HQ.bg, fontSize = 9.sp) } }) {
                                    Icon(icon, contentDescription = label)
                                }
                            } else {
                                Icon(icon, contentDescription = label)
                            }
                        },
                        label = { Text(label, fontSize = 10.sp) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = HQ.accent,
                            selectedTextColor = HQ.accent,
                            unselectedIconColor = HQ.faint,
                            unselectedTextColor = HQ.faint,
                            indicatorColor = HQ.panel2,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (tab) {
                0 -> OfficeTab(snapshot, connected, pending, onRespond, onFreelancerSend)
                1 -> TasksTab(snapshot, connected, onSubmitTask)
                2 -> PaTab(snapshot, connected)
                3 -> HistoryTab(snapshot)
                else -> LinkTab(snapshot, connected, pairedHost, backgroundEnabled, onToggleBackground, jarvisEnabled, onToggleJarvis, onSendFile, onUnpair)
            }
            VoiceOverlay(Modifier.align(Alignment.BottomCenter))
        }
    }
}

private fun saveToDownloads(context: android.content.Context, name: String, mimeType: String, bytes: ByteArray): Boolean {
    return try {
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Downloads.DISPLAY_NAME, name)
                put(android.provider.MediaStore.Downloads.MIME_TYPE, mimeType)
            }
            val uri = context.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: return false
            context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: return false
        } else {
            val dir = context.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS) ?: return false
            java.io.File(dir, name).writeBytes(bytes)
        }
        true
    } catch (error: Exception) {
        false
    }
}

// The visible half of a Jarvis exchange: what was heard, what Jarvis said
// (routing, approvals needed, and the synopsis when the task completes).
@Composable
private fun VoiceOverlay(modifier: Modifier) {
    val listening by dev.neureal.agenthq.voice.VoiceSession.listening.collectAsState()
    val lines by dev.neureal.agenthq.voice.VoiceSession.lines.collectAsState()
    val draft by dev.neureal.agenthq.voice.VoiceSession.draft.collectAsState()
    val pendingLong by dev.neureal.agenthq.voice.VoiceSession.pendingLong.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current
    if (!listening && lines.isEmpty() && draft == null) return

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .background(HQ.panel2, RoundedCornerShape(14.dp))
            .border(1.dp, HQ.accent.copy(alpha = 0.45f), RoundedCornerShape(14.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(7.dp).background(if (listening) HQ.accent else HQ.ghost, CircleShape))
            Spacer(Modifier.width(7.dp))
            Text(
                if (listening) "JARVIS — LISTENING" else "JARVIS",
                color = HQ.accent, fontSize = 10.sp, letterSpacing = 1.5.sp,
                fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            if (pendingLong != null) {
                Text(
                    "read all",
                    color = HQ.accent, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .clickable { dev.neureal.agenthq.voice.VoiceFeedback.readPending() }
                        .padding(4.dp),
                )
            }
            Text(
                "dismiss",
                color = HQ.faint, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                modifier = Modifier
                    .clickable {
                        // Dismiss silences Jarvis too — mid-sentence included.
                        dev.neureal.agenthq.voice.VoiceFeedback.hush()
                        dev.neureal.agenthq.voice.VoiceSession.clear()
                    }
                    .padding(4.dp),
            )
        }
        lines.takeLast(4).forEach { line ->
            Text(
                (if (line.fromYou) "you: " else "jarvis: ") + line.text,
                color = if (line.fromYou) HQ.text else HQ.text2,
                fontSize = 12.sp, lineHeight = 16.sp,
                maxLines = 4,
            )
        }
        // A drafted task waits here until confirmed — by voice ("send") or tap.
        if (draft != null) {
            Column(
                modifier = Modifier.fillMaxWidth()
                    .background(HQ.panel, RoundedCornerShape(9.dp))
                    .border(1.dp, HQ.amber.copy(alpha = 0.5f), RoundedCornerShape(9.dp))
                    .padding(9.dp),
                verticalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Text("draft — not sent yet", color = HQ.amber, fontSize = 9.sp, letterSpacing = 1.2.sp, fontFamily = FontFamily.Monospace)
                Text(draft ?: "", color = HQ.text, fontSize = 12.sp, lineHeight = 16.sp, maxLines = 6)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { dev.neureal.agenthq.voice.TaskCapture.submitDraft(context) },
                        modifier = Modifier.weight(1f).height(36.dp),
                        shape = RoundedCornerShape(9.dp),
                    ) { Text("Send", color = HQ.accent, fontSize = 12.sp) }
                    OutlinedButton(
                        onClick = { dev.neureal.agenthq.voice.TaskCapture.discardDraft() },
                        modifier = Modifier.weight(1f).height(36.dp),
                        shape = RoundedCornerShape(9.dp),
                    ) { Text("Discard", color = HQ.muted, fontSize = 12.sp) }
                }
            }
        }
    }
}

@Composable
private fun Header(connected: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier.size(24.dp).border(1.5.dp, HQ.accent, RoundedCornerShape(7.dp)),
            contentAlignment = Alignment.Center,
        ) { Text("HQ", color = HQ.accent, fontSize = 9.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace) }
        Spacer(Modifier.width(9.dp))
        Text("AGENT HQ", color = HQ.text, fontSize = 13.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.2.sp, modifier = Modifier.weight(1f))
        Row(
            modifier = Modifier.border(1.dp, HQ.line, RoundedCornerShape(20.dp)).padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(6.dp).background(if (connected) HQ.green else HQ.amber, CircleShape))
            Spacer(Modifier.width(6.dp))
            Text(if (connected) "E2E LINKED" else "RECONNECTING", color = HQ.muted, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
        }
    }
}

@Composable
private fun OfficeTab(
    snapshot: Snapshot,
    connected: Boolean,
    pending: List<PermissionRequest>,
    onRespond: (PermissionRequest, String) -> Unit,
    onFreelancerSend: (String, String) -> Unit,
) {
    val master = snapshot.agents.firstOrNull { it.role == "master" }
    val teams = snapshot.teams.sortedBy { it.createdAt }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(HQ.bg).padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(4.dp)); Header(connected) }

        if (pending.isNotEmpty()) {
            item { SectionLabel("Awaiting you · ${pending.size}", HQ.amber) }
            items(pending, key = { it.id }) { request -> ApprovalCard(request, snapshot, onRespond) }
        }

        item { SectionLabel("The office") }

        if (master != null) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth()
                        .background(HQ.panel, RoundedCornerShape(11.dp))
                        .border(1.dp, HQ.accent.copy(alpha = 0.35f), RoundedCornerShape(11.dp))
                        .padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier.size(32.dp).border(2.dp, HQ.accent, CircleShape).background(Color(0xFF1C2432), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { Text("M", color = Color(0xFFC9D2E0), fontSize = 10.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace) }
                    Spacer(Modifier.width(10.dp))
                    Column {
                        Text("MASTER", color = HQ.text, fontSize = 12.5.sp, fontWeight = FontWeight.Bold)
                        Text(master.activity.ifEmpty { master.status }, color = HQ.accent, fontSize = 10.sp, fontFamily = FontFamily.Monospace, maxLines = 1)
                    }
                }
            }
        }

        items(teams, key = { it.id }) { team ->
            val members = snapshot.agents.filter { it.teamId == team.id }
                .sortedWith(compareBy({ it.role != "lead" }, { it.name }))
            val activeCount = members.count { it.status in listOf("working", "waiting_permission", "reporting") }
            Card {
                Row {
                    SectionLabel(team.name)
                    Spacer(Modifier.weight(1f))
                    SectionLabel(if (activeCount > 0) "$activeCount active" else "standby", if (activeCount > 0) HQ.green else HQ.faint)
                }
                if (members.isEmpty()) {
                    Text("room being furnished…", color = HQ.ghost, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                }
                members.forEach { AgentChip(it) }
            }
        }

        // Terminal Claude Code sessions on the PC — visible and messageable.
        val freelancers = snapshot.agents.filter { it.role == "freelancer" }.sortedBy { it.name }
        if (freelancers.isNotEmpty()) {
            item {
                var messageTarget by remember { mutableStateOf<String?>(null) }
                var messageText by remember { mutableStateOf("") }
                Card {
                    Row {
                        SectionLabel("Freelancers")
                        Spacer(Modifier.weight(1f))
                        SectionLabel("terminal sessions", HQ.faint)
                    }
                    freelancers.forEach { agent ->
                        AgentChip(agent)
                        Text(
                            if (messageTarget == agent.id) "close" else "message ${agent.name}",
                            color = HQ.accent, fontSize = 10.5.sp, fontFamily = FontFamily.Monospace,
                            modifier = Modifier
                                .clickable {
                                    messageTarget = if (messageTarget == agent.id) null else agent.id
                                    messageText = ""
                                }
                                .padding(horizontal = 4.dp, vertical = 2.dp),
                        )
                        if (messageTarget == agent.id) {
                            OutlinedTextField(
                                value = messageText,
                                onValueChange = { messageText = it },
                                modifier = Modifier.fillMaxWidth(),
                                placeholder = { Text("Instruction for this session…", color = HQ.faint, fontSize = 11.sp) },
                                textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 12.sp),
                                minLines = 2,
                            )
                            Button(
                                onClick = {
                                    if (messageText.isNotBlank()) {
                                        onFreelancerSend(agent.id, messageText.trim())
                                        messageTarget = null
                                        messageText = ""
                                    }
                                },
                                modifier = Modifier.fillMaxWidth().height(38.dp),
                                shape = RoundedCornerShape(9.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = HQ.accentSolid, contentColor = HQ.accentInk),
                            ) { Text("Send instruction", fontSize = 12.sp, fontWeight = FontWeight.SemiBold) }
                        }
                    }
                }
            }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
}

// Same deterministic <when> grammar as the desktop composer.
private fun parseWhen(raw: String): Long? {
    val text = raw.trim().lowercase()
    val now = java.util.Calendar.getInstance()
    Regex("^in\\s+(\\d+)\\s*(m|min|minutes?|h|hours?|d|days?)$").find(text)?.let { m ->
        val n = m.groupValues[1].toLong()
        val unit = m.groupValues[2].first()
        val ms = when (unit) { 'm' -> 60_000L; 'h' -> 3_600_000L; else -> 86_400_000L }
        return now.timeInMillis + n * ms
    }
    Regex("^(\\d{4})-(\\d{2})-(\\d{2})\\s+(\\d{1,2}):(\\d{2})$").find(text)?.let { m ->
        val c = java.util.Calendar.getInstance()
        c.set(m.groupValues[1].toInt(), m.groupValues[2].toInt() - 1, m.groupValues[3].toInt(), m.groupValues[4].toInt(), m.groupValues[5].toInt(), 0)
        c.set(java.util.Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }
    Regex("^(tomorrow\\s+)?(\\d{1,2}):(\\d{2})$").find(text)?.let { m ->
        val c = java.util.Calendar.getInstance()
        c.set(java.util.Calendar.HOUR_OF_DAY, m.groupValues[2].toInt())
        c.set(java.util.Calendar.MINUTE, m.groupValues[3].toInt())
        c.set(java.util.Calendar.SECOND, 0)
        c.set(java.util.Calendar.MILLISECOND, 0)
        if (m.groupValues[1].isNotEmpty() || c.timeInMillis <= now.timeInMillis) c.add(java.util.Calendar.DAY_OF_YEAR, 1)
        return c.timeInMillis
    }
    return null
}

private fun timeChip(atMs: Double): String {
    val at = java.util.Calendar.getInstance().apply { timeInMillis = atMs.toLong() }
    val now = java.util.Calendar.getInstance()
    val time = String.format(java.util.Locale.US, "%02d:%02d", at.get(java.util.Calendar.HOUR_OF_DAY), at.get(java.util.Calendar.MINUTE))
    val sameDay = at.get(java.util.Calendar.DAY_OF_YEAR) == now.get(java.util.Calendar.DAY_OF_YEAR) &&
        at.get(java.util.Calendar.YEAR) == now.get(java.util.Calendar.YEAR)
    if (sameDay) return "today $time"
    now.add(java.util.Calendar.DAY_OF_YEAR, 1)
    val tomorrow = at.get(java.util.Calendar.DAY_OF_YEAR) == now.get(java.util.Calendar.DAY_OF_YEAR) &&
        at.get(java.util.Calendar.YEAR) == now.get(java.util.Calendar.YEAR)
    if (tomorrow) return "tmrw $time"
    return "${at.get(java.util.Calendar.DAY_OF_MONTH)}/${at.get(java.util.Calendar.MONTH) + 1} $time"
}

private const val DAY_MS = 24L * 60 * 60 * 1000
private fun dayStartMs(ms: Long): Long {
    val c = java.util.Calendar.getInstance().apply { timeInMillis = ms }
    c.set(java.util.Calendar.HOUR_OF_DAY, 0); c.set(java.util.Calendar.MINUTE, 0)
    c.set(java.util.Calendar.SECOND, 0); c.set(java.util.Calendar.MILLISECOND, 0)
    return c.timeInMillis
}
private fun covers(event: dev.neureal.agenthq.model.PaEvent, day: Long): Boolean =
    event.startMs < (day + DAY_MS) && (event.endMs ?: event.startMs) >= day

// Compact month grid (Monday-first): dots for events, teal shading for trip
// spans; tapping a day shows its agenda below — itinerary-friendly.
@Composable
private fun PaCalendarCard(pa: dev.neureal.agenthq.model.PaState, hub: dev.neureal.agenthq.net.HubClient) {
    val today = dayStartMs(System.currentTimeMillis())
    var monthAnchor by remember { mutableStateOf(dayStartMs(System.currentTimeMillis()).let { ms ->
        val c = java.util.Calendar.getInstance().apply { timeInMillis = ms; set(java.util.Calendar.DAY_OF_MONTH, 1) }
        c.timeInMillis
    }) }
    var selected by remember { mutableStateOf(today) }

    val anchorCal = java.util.Calendar.getInstance().apply { timeInMillis = monthAnchor }
    val monthLabel = java.text.SimpleDateFormat("MMMM yyyy", java.util.Locale.UK).format(java.util.Date(monthAnchor))
    val firstWeekday = ((java.util.Calendar.getInstance().apply { timeInMillis = monthAnchor }.get(java.util.Calendar.DAY_OF_WEEK) + 5) % 7)
    val firstCell = monthAnchor - firstWeekday * DAY_MS
    val cells = (0 until 42).map { dayStartMs(firstCell + it * DAY_MS) }
    val hhmm = java.text.SimpleDateFormat("HH:mm", java.util.Locale.UK)

    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Calendar")
            Spacer(Modifier.weight(1f))
            Text("‹", color = HQ.muted, fontSize = 16.sp, modifier = Modifier.clickable {
                val c = java.util.Calendar.getInstance().apply { timeInMillis = monthAnchor; add(java.util.Calendar.MONTH, -1) }
                monthAnchor = c.timeInMillis
            }.padding(horizontal = 8.dp))
            Text(monthLabel, color = HQ.text, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold)
            Text("›", color = HQ.muted, fontSize = 16.sp, modifier = Modifier.clickable {
                val c = java.util.Calendar.getInstance().apply { timeInMillis = monthAnchor; add(java.util.Calendar.MONTH, 1) }
                monthAnchor = c.timeInMillis
            }.padding(horizontal = 8.dp))
        }
        Row(Modifier.fillMaxWidth()) {
            listOf("M", "T", "W", "T", "F", "S", "S").forEach { d ->
                Text(d, color = HQ.faint, fontSize = 9.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.weight(1f))
            }
        }
        cells.chunked(7).forEach { week ->
            Row(Modifier.fillMaxWidth().padding(vertical = 1.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                week.forEach { day ->
                    val inMonth = java.util.Calendar.getInstance().apply { timeInMillis = day }.get(java.util.Calendar.MONTH) == anchorCal.get(java.util.Calendar.MONTH)
                    val events = pa.events.filter { covers(it, day) }
                    val hasSpan = events.any { it.endMs != null }
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier
                            .weight(1f)
                            .background(
                                if (hasSpan) HQ.accentSolid.copy(alpha = 0.13f) else HQ.panel2,
                                RoundedCornerShape(6.dp),
                            )
                            .border(
                                1.dp,
                                when {
                                    day == selected -> HQ.accent
                                    day == today -> HQ.accent.copy(alpha = 0.4f)
                                    else -> HQ.line
                                },
                                RoundedCornerShape(6.dp),
                            )
                            .clickable { selected = day }
                            .padding(vertical = 4.dp)
                            .let { if (inMonth) it else it },
                    ) {
                        Text(
                            "${java.util.Calendar.getInstance().apply { timeInMillis = day }.get(java.util.Calendar.DAY_OF_MONTH)}",
                            color = if (day == today) HQ.accent else if (inMonth) HQ.text2 else HQ.ghost,
                            fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            if (events.isNotEmpty()) Box(Modifier.size(4.dp).background(HQ.accent, CircleShape))
                            if (pa.reminders.any { it.firedAt == null && it.atMs >= day && it.atMs < day + DAY_MS }) {
                                Box(Modifier.size(4.dp).background(HQ.amber, CircleShape))
                            }
                        }
                    }
                }
            }
        }

        // Selected-day agenda: a trip day reads like an itinerary.
        val dayEvents = pa.events.filter { covers(it, selected) }
            .sortedWith(compareByDescending<dev.neureal.agenthq.model.PaEvent> { it.endMs != null }.thenBy { it.startMs })
        val dayReminders = pa.reminders.filter { it.firedAt == null && it.atMs >= selected && it.atMs < selected + DAY_MS }.sortedBy { it.atMs }
        Text(
            java.text.SimpleDateFormat("EEEE d MMMM", java.util.Locale.UK).format(java.util.Date(selected)),
            color = HQ.text, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold,
        )
        if (dayEvents.isEmpty() && dayReminders.isEmpty()) {
            Text("nothing this day", color = HQ.ghost, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
        }
        dayEvents.forEach { event ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().background(HQ.panel2, RoundedCornerShape(8.dp)).padding(horizontal = 9.dp, vertical = 6.dp)) {
                val chip = if (event.endMs != null) {
                    val dayIndex = ((selected - dayStartMs(event.startMs.toLong())) / DAY_MS) + 1
                    val total = ((dayStartMs(event.endMs.toLong()) - dayStartMs(event.startMs.toLong())) / DAY_MS) + 1
                    "day $dayIndex/$total"
                } else hhmm.format(java.util.Date(event.startMs.toLong()))
                Text(chip, color = HQ.accent, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                Spacer(Modifier.width(8.dp))
                Text(event.title, color = HQ.text, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 2)
                Text("✕", color = HQ.faint, fontSize = 12.sp, modifier = Modifier.clickable {
                    hub.sendCommand(dev.neureal.agenthq.model.Commands.paRemove("event", event.id))
                }.padding(4.dp))
            }
            Spacer(Modifier.height(4.dp))
        }
        dayReminders.forEach { reminder ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().background(HQ.panel2, RoundedCornerShape(8.dp)).padding(horizontal = 9.dp, vertical = 6.dp)) {
                Text("${hhmm.format(java.util.Date(reminder.atMs.toLong()))} ⏰", color = HQ.amber, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                Spacer(Modifier.width(8.dp))
                Text(reminder.text, color = HQ.text, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 2)
            }
            Spacer(Modifier.height(4.dp))
        }
    }
}

// The PA tab: everything the desk maintains — Up next (reminders + custom
// calendar), Todos (tick/untick), and the shared owner Notes. Live state,
// zero tokens; interactions are hub commands.
@Composable
private fun PaTab(snapshot: Snapshot, connected: Boolean) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val hub = dev.neureal.agenthq.net.HubHolder.get(context.applicationContext)
    val pa = snapshot.pa
    var todoText by remember { mutableStateOf("") }
    var noteText by remember { mutableStateOf("") }
    var whenText by remember { mutableStateOf("") }
    var upcomingText by remember { mutableStateOf("") }
    var whenError by remember { mutableStateOf(false) }

    val upcoming = (
        pa.reminders.filter { it.firedAt == null }.map { Triple(it.id, "reminder", it.text) to it.atMs } +
            pa.events.map { Triple(it.id, "event", it.title) to it.startMs }
        ).sortedBy { it.second }
    val openTodos = pa.todos.filter { !it.done }.sortedByDescending { it.createdAt }
    val doneTodos = pa.todos.filter { it.done }.takeLast(6).reversed()
    val noteLines = pa.notes.split('\n').filter { it.isNotBlank() && !it.startsWith("#") }
    val lists = pa.lists.entries.sortedBy { it.key }
    var newListName by remember { mutableStateOf("") }
    var newListItem by remember { mutableStateOf("") }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(HQ.bg).padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(4.dp)); Header(connected) }

        item {
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        SectionLabel("PA desk")
                        Text(
                            "todos · reminders · calendar · shared notes",
                            color = HQ.muted, fontSize = 10.5.sp,
                        )
                    }
                    Switch(
                        checked = pa.enabled,
                        onCheckedChange = { hub.sendCommand(dev.neureal.agenthq.model.Commands.paSet(it)) },
                        colors = SwitchDefaults.colors(checkedTrackColor = HQ.accentSolid),
                    )
                }
                if (!pa.enabled) {
                    Text("switched off — nothing fires or notifies until re-enabled", color = HQ.amber, fontSize = 10.sp)
                }
            }
        }

        item { PaCalendarCard(pa, hub) }

        item {
            Card {
                SectionLabel("Up next — reminders & calendar")
                if (upcoming.isEmpty()) Text("nothing scheduled", color = HQ.ghost, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                upcoming.forEach { (meta, atMs) ->
                    val (id, kind, label) = meta
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().background(HQ.panel2, RoundedCornerShape(8.dp)).padding(horizontal = 9.dp, vertical = 7.dp)) {
                        Text(timeChip(atMs), color = if (kind == "event") HQ.accent else HQ.amber, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                        Spacer(Modifier.width(8.dp))
                        Text(label, color = HQ.text, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 2)
                        Text(
                            "✕", color = HQ.faint, fontSize = 12.sp,
                            modifier = Modifier.clickable { hub.sendCommand(dev.neureal.agenthq.model.Commands.paRemove(kind, id)) }.padding(4.dp),
                        )
                    }
                    Spacer(Modifier.height(5.dp))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = whenText, onValueChange = { whenText = it; whenError = false },
                        modifier = Modifier.width(120.dp),
                        placeholder = { Text("in 20m", color = HQ.faint, fontSize = 11.sp) },
                        textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 12.sp),
                        singleLine = true,
                    )
                    Spacer(Modifier.width(6.dp))
                    OutlinedTextField(
                        value = upcomingText, onValueChange = { upcomingText = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("what…", color = HQ.faint, fontSize = 11.sp) },
                        textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 12.sp),
                        singleLine = true,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = {
                            val atMs = parseWhen(whenText)
                            if (atMs == null || upcomingText.isBlank()) { whenError = true } else {
                                hub.sendCommand(dev.neureal.agenthq.model.Commands.paAdd("reminder", upcomingText.trim(), atMs.toDouble()))
                                whenText = ""; upcomingText = ""
                            }
                        },
                        modifier = Modifier.weight(1f).height(36.dp), shape = RoundedCornerShape(9.dp),
                    ) { Text("Remind", color = HQ.accent, fontSize = 11.5.sp) }
                    OutlinedButton(
                        onClick = {
                            // "X to Y" in the time field makes a multi-day event.
                            val span = Regex("^(.+?)\\s+to\\s+(.+)$", RegexOption.IGNORE_CASE).find(whenText.trim())
                            val atMs = parseWhen(span?.groupValues?.get(1) ?: whenText)
                            val endMs = span?.let { parseWhen(it.groupValues[2]) }
                            if (atMs == null || upcomingText.isBlank() || (span != null && (endMs == null || endMs <= atMs))) {
                                whenError = true
                            } else {
                                hub.sendCommand(dev.neureal.agenthq.model.Commands.paAdd("event", upcomingText.trim(), atMs.toDouble(), endMs?.toDouble()))
                                whenText = ""; upcomingText = ""
                            }
                        },
                        modifier = Modifier.weight(1f).height(36.dp), shape = RoundedCornerShape(9.dp),
                    ) { Text("Event", color = HQ.accent, fontSize = 11.5.sp) }
                }
                if (whenError) {
                    Text("time formats: in 20m/2h/3d · 17:30 · tomorrow 09:00 · 2026-09-14 18:00 · trips: \"<when> to <when>\" (events)", color = HQ.amber, fontSize = 9.5.sp)
                }
            }
        }

        item {
            Card {
                SectionLabel("Todos")
                if (openTodos.isEmpty() && doneTodos.isEmpty()) Text("nothing open", color = HQ.ghost, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                (openTodos + doneTodos).forEach { todo ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                        Text(
                            if (todo.done) "☑" else "☐",
                            color = if (todo.done) HQ.green else HQ.faint, fontSize = 15.sp,
                            modifier = Modifier.clickable { hub.sendCommand(dev.neureal.agenthq.model.Commands.paToggle(todo.id)) }.padding(4.dp),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            todo.text,
                            color = if (todo.done) HQ.faint else HQ.text, fontSize = 12.sp,
                            modifier = Modifier.weight(1f), maxLines = 2,
                        )
                        Text(
                            "✕", color = HQ.faint, fontSize = 12.sp,
                            modifier = Modifier.clickable { hub.sendCommand(dev.neureal.agenthq.model.Commands.paRemove("todo", todo.id)) }.padding(4.dp),
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = todoText, onValueChange = { todoText = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("add a todo…", color = HQ.faint, fontSize = 11.sp) },
                        textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 12.sp),
                        singleLine = true,
                    )
                    Spacer(Modifier.width(6.dp))
                    OutlinedButton(
                        onClick = {
                            if (todoText.isNotBlank()) {
                                hub.sendCommand(dev.neureal.agenthq.model.Commands.paAdd("todo", todoText.trim()))
                                todoText = ""
                            }
                        },
                        modifier = Modifier.height(36.dp), shape = RoundedCornerShape(9.dp),
                    ) { Text("Add", color = HQ.accent, fontSize = 11.5.sp) }
                }
            }
        }

        item {
            Card {
                SectionLabel("Notes — shared with every team")
                if (noteLines.isEmpty()) Text("no notes yet — facts here reach every worker", color = HQ.ghost, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                noteLines.forEach { line ->
                    Text("• " + line.removePrefix("- ").trim(), color = HQ.text2, fontSize = 11.5.sp, lineHeight = 16.sp)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = noteText, onValueChange = { noteText = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("add a note…", color = HQ.faint, fontSize = 11.sp) },
                        textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 12.sp),
                        singleLine = true,
                    )
                    Spacer(Modifier.width(6.dp))
                    OutlinedButton(
                        onClick = {
                            if (noteText.isNotBlank()) {
                                hub.sendCommand(dev.neureal.agenthq.model.Commands.paAdd("note", noteText.trim()))
                                noteText = ""
                            }
                        },
                        modifier = Modifier.height(36.dp), shape = RoundedCornerShape(9.dp),
                    ) { Text("Add", color = HQ.accent, fontSize = 11.5.sp) }
                }
            }
        }

        item {
            Card {
                SectionLabel("Lists — reference, not to-dos")
                if (lists.isEmpty()) Text("no reference lists yet", color = HQ.ghost, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
                lists.forEach { (name, items) -> PaListCard(name, items, hub) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = newListName, onValueChange = { newListName = it },
                        modifier = Modifier.width(120.dp),
                        placeholder = { Text("list name…", color = HQ.faint, fontSize = 11.sp) },
                        textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 12.sp),
                        singleLine = true,
                    )
                    Spacer(Modifier.width(6.dp))
                    OutlinedTextField(
                        value = newListItem, onValueChange = { newListItem = it },
                        modifier = Modifier.weight(1f),
                        placeholder = { Text("first item…", color = HQ.faint, fontSize = 11.sp) },
                        textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 12.sp),
                        singleLine = true,
                    )
                }
                OutlinedButton(
                    onClick = {
                        if (newListName.isNotBlank() && newListItem.isNotBlank()) {
                            hub.sendCommand(dev.neureal.agenthq.model.Commands.paListAdd(newListName.trim(), newListItem.trim()))
                            newListName = ""; newListItem = ""
                        }
                    },
                    modifier = Modifier.fillMaxWidth().height(36.dp), shape = RoundedCornerShape(9.dp),
                ) { Text("Create list", color = HQ.accent, fontSize = 11.5.sp) }
            }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
}

// One reference list (games to play, movies, books, …): a plain string
// array under data/pa/<name>.json, shown and edited in place.
@Composable
private fun PaListCard(name: String, items: List<String>, hub: dev.neureal.agenthq.net.HubClient) {
    var text by remember(name) { mutableStateOf("") }
    Column(Modifier.padding(vertical = 6.dp)) {
        Text(name.replaceFirstChar { it.uppercase() }, color = HQ.text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(4.dp))
        if (items.isEmpty()) Text("empty", color = HQ.ghost, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
        items.forEachIndexed { index, item ->
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                Text(item, color = HQ.text2, fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 2)
                Text(
                    "✕", color = HQ.faint, fontSize = 12.sp,
                    modifier = Modifier.clickable { hub.sendCommand(dev.neureal.agenthq.model.Commands.paListRemove(name, index)) }.padding(4.dp),
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = text, onValueChange = { text = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("add an item…", color = HQ.faint, fontSize = 11.sp) },
                textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 12.sp),
                singleLine = true,
            )
            Spacer(Modifier.width(6.dp))
            OutlinedButton(
                onClick = {
                    if (text.isNotBlank()) {
                        hub.sendCommand(dev.neureal.agenthq.model.Commands.paListAdd(name, text.trim()))
                        text = ""
                    }
                },
                modifier = Modifier.height(36.dp), shape = RoundedCornerShape(9.dp),
            ) { Text("Add", color = HQ.accent, fontSize = 11.5.sp) }
        }
    }
}

@Composable
private fun TasksTab(snapshot: Snapshot, connected: Boolean, onSubmitTask: (String) -> Unit) {
    val active = snapshot.tasks
        .filter { it.status in listOf("routing", "queued", "in_flight", "awaiting_permission", "review") }
        .sortedByDescending { it.updatedAt }
    val parked = snapshot.tasks.filter { (it.status == "paused" || it.status == "failed") && it.parentTaskId == null }.sortedByDescending { it.updatedAt }.take(5)
    var composer by remember { mutableStateOf("") }

    val context = androidx.compose.ui.platform.LocalContext.current
    val hub = dev.neureal.agenthq.net.HubHolder.get(context.applicationContext)

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(HQ.bg).padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(4.dp)); Header(connected) }

        // Global task controls: pause holds new work, resume drains queues,
        // kill stops everything running and clears the queues.
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { hub.sendCommand(dev.neureal.agenthq.model.Commands.tasksControl("pause")) },
                    modifier = Modifier.weight(1f).height(36.dp), shape = RoundedCornerShape(9.dp),
                ) { Text("⏸ Pause", color = HQ.muted, fontSize = 11.sp) }
                OutlinedButton(
                    onClick = { hub.sendCommand(dev.neureal.agenthq.model.Commands.tasksControl("resume")) },
                    modifier = Modifier.weight(1f).height(36.dp), shape = RoundedCornerShape(9.dp),
                ) { Text("▶ Resume", color = HQ.accent, fontSize = 11.sp) }
                OutlinedButton(
                    onClick = { hub.sendCommand(dev.neureal.agenthq.model.Commands.tasksControl("killall")) },
                    modifier = Modifier.weight(1f).height(36.dp), shape = RoundedCornerShape(9.dp),
                ) { Text("■ Kill all", color = HQ.red, fontSize = 11.sp) }
            }
        }

        item {
            SectionLabel("New task")
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = composer,
                onValueChange = { composer = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Give the master agent a task… (@project pins it)", color = HQ.faint, fontSize = 12.sp) },
                textStyle = androidx.compose.ui.text.TextStyle(color = HQ.text, fontSize = 13.sp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = HQ.accent, unfocusedBorderColor = HQ.line, cursorColor = HQ.accent,
                ),
            )
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = {
                    if (composer.isNotBlank()) {
                        onSubmitTask(composer.trim())
                        composer = ""
                    }
                },
                enabled = connected && composer.isNotBlank(),
                modifier = Modifier.fillMaxWidth().height(46.dp),
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(containerColor = HQ.accentSolid, contentColor = HQ.accentInk),
            ) { Text("Send to master", fontSize = 13.5.sp, fontWeight = FontWeight.Bold) }
        }

        item { SectionLabel(if (active.isEmpty()) "Nothing in flight" else "In flight · ${active.size}") }
        items(active, key = { it.id }) { task -> TaskCard(task, showProgress = true) }

        if (parked.isNotEmpty()) {
            item { SectionLabel("Paused / failed") }
            items(parked, key = { it.id }) { task -> TaskCard(task, showProgress = false) }
        }

        item { Spacer(Modifier.height(8.dp)) }
    }
}

@Composable
private fun HistoryTab(snapshot: Snapshot) {
    val done = snapshot.tasks.filter { it.status == "done" && it.parentTaskId == null }.sortedByDescending { it.updatedAt }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(HQ.bg).padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(4.dp)); SectionLabel("Done · ${done.size}") }
        if (done.isEmpty()) {
            item { Text("nothing finished yet — synopses land here", color = HQ.ghost, fontSize = 11.sp, fontFamily = FontFamily.Monospace) }
        }
        items(done, key = { it.id }) { task -> TaskCard(task, showProgress = false) }
        item { Spacer(Modifier.height(8.dp)) }
    }
}

@Composable
private fun LinkTab(
    snapshot: Snapshot,
    connected: Boolean,
    pairedHost: String?,
    backgroundEnabled: Boolean,
    onToggleBackground: (Boolean) -> Unit,
    jarvisEnabled: Boolean,
    onToggleJarvis: (Boolean) -> Unit,
    onSendFile: () -> Unit,
    onUnpair: () -> Unit,
) {
    val usage = snapshot.usage
    val context = androidx.compose.ui.platform.LocalContext.current
    var crash by remember { mutableStateOf(dev.neureal.agenthq.App.lastCrash(context)) }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(HQ.bg).padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(4.dp)); Header(connected) }

        if (crash != null) {
            item {
                Column(
                    modifier = Modifier.fillMaxWidth()
                        .background(HQ.panel, RoundedCornerShape(11.dp))
                        .border(1.dp, HQ.red.copy(alpha = 0.5f), RoundedCornerShape(11.dp))
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    SectionLabel("Last crash — screenshot this for the developer", HQ.red)
                    Text(crash ?: "", color = HQ.text2, fontSize = 9.sp, lineHeight = 12.sp, fontFamily = FontFamily.Monospace, maxLines = 24)
                    OutlinedButton(onClick = {
                        dev.neureal.agenthq.App.clearCrash(context)
                        crash = null
                    }) { Text("Dismiss", color = HQ.muted, fontSize = 12.sp) }
                }
            }
        }

        item {
            Card {
                SectionLabel("Connection")
                Text(
                    if (connected) "linked to ${pairedHost ?: "?"} · end-to-end encrypted, keys pinned" else "reconnecting to ${pairedHost ?: "?"}…",
                    color = HQ.text2, fontSize = 12.sp, lineHeight = 17.sp,
                )
            }
        }

        item {
            Card {
                SectionLabel("Send to the PC")
                Text(
                    "images and files land in the hub's inbox for the teams to use — or share to Agent HQ from any app's share sheet",
                    color = HQ.text2, fontSize = 11.sp, lineHeight = 15.sp,
                )
                OutlinedButton(
                    onClick = onSendFile,
                    enabled = connected,
                    modifier = Modifier.fillMaxWidth().height(40.dp),
                    shape = RoundedCornerShape(10.dp),
                ) { Text("Choose a file…", color = if (connected) HQ.accent else HQ.ghost, fontSize = 12.sp) }
            }
        }

        item {
            // Voice breadcrumbs — screenshot this card when Jarvis misbehaves.
            val traceLines by dev.neureal.agenthq.voice.VoiceTrace.lines.collectAsState()
            if (traceLines.isNotEmpty()) {
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        SectionLabel("Voice trace — screenshot this if Jarvis misbehaves")
                        Spacer(Modifier.weight(1f))
                        Text(
                            "clear",
                            color = HQ.muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                            modifier = Modifier.clickable { dev.neureal.agenthq.voice.VoiceTrace.clear() }.padding(4.dp),
                        )
                    }
                    traceLines.takeLast(14).forEach { line ->
                        Text(line, color = HQ.text2, fontSize = 9.5.sp, lineHeight = 13.sp, fontFamily = FontFamily.Monospace, maxLines = 2)
                    }
                }
            }
        }

        item {
            val hub = dev.neureal.agenthq.net.HubHolder.get(context.applicationContext)
            val files by hub.filesFlow.collectAsState()
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SectionLabel("Files from the PC")
                    Spacer(Modifier.weight(1f))
                    Text(
                        "request PC screenshot",
                        color = HQ.accent, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                        modifier = Modifier
                            .clickable(enabled = connected) {
                                hub.sendCommand(dev.neureal.agenthq.model.Commands.captureScreen())
                                android.widget.Toast.makeText(context, "Asking the PC for a screenshot…", android.widget.Toast.LENGTH_SHORT).show()
                            }
                            .padding(4.dp),
                    )
                }
                if (files.isEmpty()) {
                    Text(
                        "screenshots, reports, and files sent by the PC appear here — read them in place and dismiss; nothing is stored unless you save",
                        color = HQ.ghost, fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                    )
                }
                // Which file is open for in-place reading (text reports etc.).
                var openFileId by remember { mutableStateOf<String?>(null) }
                files.reversed().forEach { file ->
                    val bytes = remember(file.id) { try { dev.neureal.agenthq.crypto.unb64(file.bytesB64) } catch (e: Exception) { ByteArray(0) } }
                    val isText = file.mimeType.startsWith("text/") ||
                        file.mimeType == "application/json" ||
                        listOf(".md", ".txt", ".json", ".log", ".csv").any { file.name.lowercase().endsWith(it) }
                    Column(
                        modifier = Modifier.fillMaxWidth().background(HQ.panel2, RoundedCornerShape(8.dp)).padding(9.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (file.mimeType.startsWith("image/") && bytes.isNotEmpty()) {
                            val bitmap = remember(file.id) {
                                try { android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size) } catch (e: Exception) { null }
                            }
                            if (bitmap != null) {
                                androidx.compose.foundation.Image(
                                    bitmap = bitmap.asImageBitmap(),
                                    contentDescription = file.name,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(file.name, color = HQ.text, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                                Text("${file.from} · ${bytes.size / 1024} KB", color = HQ.muted, fontSize = 9.5.sp, fontFamily = FontFamily.Monospace)
                            }
                            if (isText && bytes.isNotEmpty()) {
                                Text(
                                    if (openFileId == file.id) "close" else "read",
                                    color = HQ.accent, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                                    modifier = Modifier
                                        .clickable { openFileId = if (openFileId == file.id) null else file.id }
                                        .padding(6.dp),
                                )
                            }
                            Text(
                                "save",
                                color = HQ.muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                                modifier = Modifier
                                    .clickable {
                                        val saved = saveToDownloads(context, file.name, file.mimeType, bytes)
                                        android.widget.Toast.makeText(context, if (saved) "Saved to Downloads" else "Save failed", android.widget.Toast.LENGTH_SHORT).show()
                                    }
                                    .padding(6.dp),
                            )
                            Text(
                                "dismiss",
                                color = HQ.muted, fontSize = 11.sp, fontFamily = FontFamily.Monospace,
                                modifier = Modifier
                                    .clickable {
                                        if (openFileId == file.id) openFileId = null
                                        hub.dismissFile(file.id) // memory only — gone for good
                                    }
                                    .padding(6.dp),
                            )
                        }
                        // In-place reader: the whole report, scrollable and
                        // copyable, straight from memory — no download needed.
                        if (openFileId == file.id && isText) {
                            val text = remember(file.id) { try { String(bytes, Charsets.UTF_8) } catch (e: Exception) { "(couldn't decode)" } }
                            SelectionContainer {
                                Text(
                                    text,
                                    color = HQ.text2, fontSize = 11.5.sp, lineHeight = 16.sp,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .heightIn(max = 420.dp)
                                        .background(HQ.bg, RoundedCornerShape(7.dp))
                                        .padding(9.dp)
                                        .verticalScroll(rememberScrollState()),
                                )
                            }
                        }
                    }
                }
            }
        }

        item {
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Notify in background", color = HQ.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            "stay linked when the app is closed and buzz when an agent needs your approval",
                            color = HQ.muted, fontSize = 10.5.sp, lineHeight = 14.sp,
                        )
                    }
                    Switch(
                        checked = backgroundEnabled,
                        onCheckedChange = onToggleBackground,
                        colors = SwitchDefaults.colors(checkedTrackColor = HQ.accentSolid, checkedThumbColor = HQ.accentInk),
                    )
                }
            }
        }

        item {
            Card {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("\"Hey Jarvis\" (hands-free)", color = HQ.text, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            "on-device wake word (openWakeWord) — say it, then speak the task; keeps background mode on",
                            color = HQ.muted, fontSize = 10.5.sp, lineHeight = 14.sp,
                        )
                    }
                    Switch(
                        checked = jarvisEnabled,
                        onCheckedChange = onToggleJarvis,
                        colors = SwitchDefaults.colors(checkedTrackColor = HQ.accentSolid, checkedThumbColor = HQ.accentInk),
                    )
                }
            }
        }

        if (usage.windowResetsAt > 0 || usage.weeklyResetsAt > 0) {
            item {
                val fmt = SimpleDateFormat("EEE h:mm a", Locale.getDefault())
                Card {
                    SectionLabel("Usage — whole account")
                    Text(
                        "session ${usage.windowPct.toInt()}% · resets ${fmt.format(Date(usage.windowResetsAt.toLong()))}",
                        color = HQ.muted, fontSize = 10.5.sp, fontFamily = FontFamily.Monospace,
                    )
                    Text(
                        "weekly ${usage.weeklyPct.toInt()}% · resets ${fmt.format(Date(usage.weeklyResetsAt.toLong()))}",
                        color = HQ.muted, fontSize = 10.5.sp, fontFamily = FontFamily.Monospace,
                    )
                }
            }
        }

        item {
            OutlinedButton(onClick = onUnpair, modifier = Modifier.fillMaxWidth().height(44.dp), shape = RoundedCornerShape(10.dp)) {
                Text("Unpair this phone", color = HQ.red, fontSize = 12.5.sp)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
