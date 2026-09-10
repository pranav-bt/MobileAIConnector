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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Menu
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
        Text(request.command, color = Color(0xFFF0D9A5), fontSize = 12.5.sp, fontFamily = FontFamily.Monospace)
        Text("$teamName · $agentName", color = HQ.muted, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
        if (request.flags.isNotEmpty()) {
            Text(request.flags.joinToString(" · "), color = HQ.amber, fontSize = 10.sp, fontFamily = FontFamily.Monospace)
        }
        if (request.reason.isNotEmpty()) {
            Text("“${request.reason}”", color = HQ.text2, fontSize = 11.5.sp, lineHeight = 16.sp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onRespond(request, "approve") },
                modifier = Modifier.weight(1f).height(44.dp),
                shape = RoundedCornerShape(8.dp),
                colors = ButtonDefaults.buttonColors(containerColor = HQ.accentSolid, contentColor = HQ.accentInk),
            ) { Text("Approve", fontWeight = FontWeight.Bold, fontSize = 13.sp) }
            OutlinedButton(
                onClick = { onRespond(request, "deny") },
                modifier = Modifier.weight(1f).height(44.dp),
                shape = RoundedCornerShape(8.dp),
            ) { Text("Deny", color = HQ.red, fontSize = 13.sp) }
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
    onRespond: (PermissionRequest, String) -> Unit,
    onSubmitTask: (String) -> Unit,
    onUnpair: () -> Unit,
) {
    var tab by rememberSaveable { mutableStateOf(0) }
    val pending = snapshot.permissions.filter { it.status == "pending" }.sortedBy { it.requestedAt }

    Scaffold(
        containerColor = HQ.bg,
        bottomBar = {
            NavigationBar(containerColor = HQ.panel, contentColor = HQ.muted) {
                val items = listOf(
                    Triple("Office", Icons.Filled.Home, pending.size),
                    Triple("Tasks", Icons.Filled.Menu, 0),
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
                0 -> OfficeTab(snapshot, connected, pending, onRespond)
                1 -> TasksTab(snapshot, connected, onSubmitTask)
                2 -> HistoryTab(snapshot)
                else -> LinkTab(snapshot, connected, pairedHost, backgroundEnabled, onToggleBackground, onUnpair)
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

        item { Spacer(Modifier.height(8.dp)) }
    }
}

@Composable
private fun TasksTab(snapshot: Snapshot, connected: Boolean, onSubmitTask: (String) -> Unit) {
    val active = snapshot.tasks
        .filter { it.status in listOf("routing", "queued", "in_flight", "awaiting_permission", "review") }
        .sortedByDescending { it.updatedAt }
    val parked = snapshot.tasks.filter { it.status == "paused" || it.status == "failed" }.sortedByDescending { it.updatedAt }.take(5)
    var composer by remember { mutableStateOf("") }

    LazyColumn(
        modifier = Modifier.fillMaxSize().background(HQ.bg).padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(4.dp)); Header(connected) }

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
    val done = snapshot.tasks.filter { it.status == "done" }.sortedByDescending { it.updatedAt }

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
    onUnpair: () -> Unit,
) {
    val usage = snapshot.usage
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(HQ.bg).padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { Spacer(Modifier.height(4.dp)); Header(connected) }

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
