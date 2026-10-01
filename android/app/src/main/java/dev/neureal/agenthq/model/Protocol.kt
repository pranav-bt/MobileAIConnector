package dev.neureal.agenthq.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

// Kotlin mirror of @agent-hq/shared — never hand-drift; the hub's zod
// schema is the source of truth. Unknown fields/events are ignored so the
// app tolerates additive protocol growth.

val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

@Serializable
data class Agent(
    val id: String,
    val name: String,
    val role: String,
    val teamId: String? = null,
    val status: String,
    val activity: String = "",
    val model: String = "sonnet",
    val taskId: String? = null,
    val tokensUsed: Double = 0.0,
    val updatedAt: Double = 0.0,
)

@Serializable
data class Team(
    val id: String,
    val name: String,
    val charter: String = "",
    val maxConcurrentWorkers: Int = 2,
    val createdAt: Double = 0.0,
)

@Serializable
data class Task(
    val id: String,
    val title: String,
    val detail: String = "",
    val projectId: String? = null,
    val teamId: String? = null,
    val status: String,
    val progressPct: Double = 0.0,
    val agentIds: List<String> = emptyList(),
    val synopsis: String? = null,
    val tokensUsed: Double = 0.0,
    val createdAt: Double = 0.0,
    val updatedAt: Double = 0.0,
    // Set on internal split pieces; finished lists hide them (the parent reports).
    val parentTaskId: String? = null,
)

@Serializable
data class PermissionRequest(
    val id: String,
    val taskId: String,
    val agentId: String,
    val teamId: String? = null,
    val command: String,
    // Plain-English "what it wants to do"; the raw command stays one tap away.
    val summary: String? = null,
    // Custom [approve, deny] labels when the card is a question (e.g. which rule wins).
    val choices: List<String>? = null,
    // A pick-one question: one button per option (approve + its index), plus "None of these".
    val options: List<String>? = null,
    val flags: List<String> = emptyList(),
    val reason: String = "",
    val status: String,
    val scope: String = "once",
    val requestedAt: Double = 0.0,
    val resolvedAt: Double? = null,
)

@Serializable
data class Project(
    val id: String,
    val name: String,
    val description: String = "",
    val workspaceDir: String = "",
    val quotaTokens: Double = 0.0,
    val usedTokens: Double = 0.0,
    val alerted75: Boolean = false,
)

@Serializable
data class ModelMix(val opus: Double = 0.0, val sonnet: Double = 0.0, val haiku: Double = 0.0)

@Serializable
data class Usage(
    val windowPct: Double = 0.0,
    val windowResetsAt: Double = 0.0,
    val weeklyPct: Double = 0.0,
    val weeklyResetsAt: Double = 0.0,
    val tokensToday: Double = 0.0,
    val modelMixPct: ModelMix = ModelMix(),
    val overageEnabled: Boolean = false,
)

@Serializable
data class PaTodo(val id: String, val text: String, val done: Boolean = false, val createdAt: Double = 0.0)

@Serializable
data class PaReminder(val id: String, val text: String, val atMs: Double, val firedAt: Double? = null)

@Serializable
data class PaEvent(
    val id: String,
    val title: String,
    val startMs: Double,
    val endMs: Double? = null, // spans days (a trip)
    val remindedAt: Double? = null,
)

@Serializable
data class PaState(
    val enabled: Boolean = true,
    val todos: List<PaTodo> = emptyList(),
    val reminders: List<PaReminder> = emptyList(),
    val events: List<PaEvent> = emptyList(),
    val notes: String = "",
    // Reference lists (games to play, movies, books, …) — one per
    // data/pa/<name>.json file, keyed by name.
    val lists: Map<String, List<String>> = emptyMap(),
)

@Serializable
data class Snapshot(
    val agents: List<Agent> = emptyList(),
    val teams: List<Team> = emptyList(),
    val tasks: List<Task> = emptyList(),
    val permissions: List<PermissionRequest> = emptyList(),
    val projects: List<Project> = emptyList(),
    val usage: Usage = Usage(),
    val pa: PaState = PaState(),
)

@Serializable
data class SharedFile(
    val id: String,
    val name: String,
    val mimeType: String = "application/octet-stream",
    val bytesB64: String,
    val from: String = "desktop",
    val taskId: String? = null,
    val at: Double = 0.0,
)

// One reducer-friendly event decoded from the envelope.
sealed interface HubEvent {
    data class SnapshotEvent(val snapshot: Snapshot) : HubEvent
    data class AgentUpdated(val agent: Agent) : HubEvent
    data class AgentRemoved(val agentId: String) : HubEvent
    data class TeamUpdated(val team: Team) : HubEvent
    data class TeamRemoved(val teamId: String) : HubEvent
    data class TaskUpdated(val task: Task) : HubEvent
    data class PermissionUpdated(val request: PermissionRequest) : HubEvent
    data class ProjectUpdated(val project: Project) : HubEvent
    data class ProjectRemoved(val projectId: String) : HubEvent
    data class UsageUpdated(val usage: Usage) : HubEvent
    data class PaUpdated(val pa: PaState) : HubEvent
    data class FileShared(val file: SharedFile) : HubEvent
    data object Ignored : HubEvent
}

fun decodeEnvelope(raw: String): HubEvent? {
    return try {
        val envelope = json.parseToJsonElement(raw).jsonObject
        val event = envelope["event"]?.jsonObject ?: return null
        when (event["type"]?.jsonPrimitive?.content) {
            "snapshot" -> HubEvent.SnapshotEvent(json.decodeFromJsonElement(event["snapshot"]!!))
            "agent.updated" -> HubEvent.AgentUpdated(json.decodeFromJsonElement(event["agent"]!!))
            "agent.removed" -> HubEvent.AgentRemoved(event["agentId"]!!.jsonPrimitive.content)
            "team.updated" -> HubEvent.TeamUpdated(json.decodeFromJsonElement(event["team"]!!))
            "team.removed" -> HubEvent.TeamRemoved(event["teamId"]!!.jsonPrimitive.content)
            "task.updated" -> HubEvent.TaskUpdated(json.decodeFromJsonElement(event["task"]!!))
            "permission.updated" -> HubEvent.PermissionUpdated(json.decodeFromJsonElement(event["request"]!!))
            "project.updated" -> HubEvent.ProjectUpdated(json.decodeFromJsonElement(event["project"]!!))
            "project.removed" -> HubEvent.ProjectRemoved(event["projectId"]!!.jsonPrimitive.content)
            "usage.updated" -> HubEvent.UsageUpdated(json.decodeFromJsonElement(event["usage"]!!))
            "pa.updated" -> HubEvent.PaUpdated(json.decodeFromJsonElement(event["pa"]!!))
            "file.shared" -> HubEvent.FileShared(json.decodeFromJsonElement(event["file"]!!))
            else -> HubEvent.Ignored
        }
    } catch (error: Exception) {
        null
    }
}

// Client -> hub commands (plain JSON; the transport layer seals them).
object Commands {
    fun hello(name: String): JsonObject = buildJsonObject {
        put("type", "hello")
        put("client", "mobile")
        put("name", name)
    }

    fun submitTask(text: String): JsonObject = buildJsonObject {
        put("type", "task.submit")
        put("text", text)
    }

    fun captureScreen(): JsonObject = buildJsonObject {
        put("type", "screen.capture")
    }

    // Message a freelancer (terminal session): the hub resumes its
    // conversation headlessly and pushes the reply back.
    fun freelancerSend(agentId: String, text: String): JsonObject = buildJsonObject {
        put("type", "freelancer.send")
        put("agentId", agentId)
        put("text", text)
    }

    // PA desk: master switch + capture + tab interactions.
    fun paSet(enabled: Boolean): JsonObject = buildJsonObject {
        put("type", "pa.set")
        put("enabled", enabled)
    }

    fun paAdd(kind: String, text: String, atMs: Double? = null, endMs: Double? = null): JsonObject = buildJsonObject {
        put("type", "pa.add")
        put("kind", kind)
        put("text", text)
        if (atMs != null) put("atMs", atMs)
        if (endMs != null) put("endMs", endMs)
    }

    fun paToggle(id: String): JsonObject = buildJsonObject {
        put("type", "pa.toggle")
        put("id", id)
    }

    fun paRemove(kind: String, id: String): JsonObject = buildJsonObject {
        put("type", "pa.remove")
        put("kind", kind)
        put("id", id)
    }

    fun tasksControl(action: String): JsonObject = buildJsonObject {
        put("type", "tasks.control")
        put("action", action)
    }

    fun paListAdd(list: String, text: String): JsonObject = buildJsonObject {
        put("type", "pa.list.add")
        put("list", list)
        put("text", text)
    }

    fun paListRemove(list: String, index: Int): JsonObject = buildJsonObject {
        put("type", "pa.list.remove")
        put("list", list)
        put("index", index)
    }

    // Phone -> PC: the hub lands this in its data/inbox for the teams.
    fun sendFile(name: String, mimeType: String, bytesB64: String): JsonObject = buildJsonObject {
        put("type", "file.send")
        put("name", name)
        put("mimeType", mimeType)
        put("bytesB64", bytesB64)
        put("from", "phone")
    }

    fun respondPermission(requestId: String, decision: String, signatureB64: String, choice: Int? = null): JsonObject = buildJsonObject {
        put("type", "permission.respond")
        put("requestId", requestId)
        put("decision", decision)
        put("scope", "once")
        put("signatureB64", signatureB64)
        if (choice != null) put("choice", choice)
    }
}

// The QR payload shown on the PC during pairing.
@Serializable
data class PairingPayload(
    val v: Int = 1,
    val host: String,
    val port: Int,
    val pcPublicKeyDerB64: String,
    val token: String,
)
