package dev.neureal.agenthq.net

import dev.neureal.agenthq.crypto.DeviceIdentity
import dev.neureal.agenthq.store.KV
import dev.neureal.agenthq.crypto.FrameCrypto
import dev.neureal.agenthq.crypto.Spki
import dev.neureal.agenthq.crypto.b64
import dev.neureal.agenthq.crypto.deriveSessionKeys
import dev.neureal.agenthq.crypto.unb64
import dev.neureal.agenthq.model.HubEvent
import dev.neureal.agenthq.model.PairingPayload
import dev.neureal.agenthq.model.SharedFile
import dev.neureal.agenthq.model.Snapshot
import dev.neureal.agenthq.model.decodeEnvelope
import dev.neureal.agenthq.model.json
import com.google.crypto.tink.subtle.X25519
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

// Connection lifecycle:
//   pair(payload)  — one-shot socket: {t:'pair', token, device keys} -> ack,
//                    hub pins our keys, we store host/port/pc key.
//   connect()      — session socket: {t:'session', eph pub} -> ack(eph, salt)
//                    -> derive keys; everything after is sealed frames.
// The first sealed inbound frame is the full snapshot.

sealed interface LinkState {
    data object Unpaired : LinkState
    data object PairingInFlight : LinkState
    data object Idle : LinkState // paired, no session attempt yet
    data object Connecting : LinkState
    data object Connected : LinkState
    data class Failed(val message: String) : LinkState
}

class HubClient(private val store: KV, private val deviceName: String) {
    private val identity = DeviceIdentity.loadOrCreate(store)
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val linkState = MutableStateFlow<LinkState>(if (isPaired()) LinkState.Idle else LinkState.Unpaired)
    val snapshotFlow: StateFlow<Snapshot> get() = stateFlow
    private val stateFlow = MutableStateFlow(Snapshot())
    // Files pushed from the PC (screenshots, worker outputs) — last few kept.
    val filesFlow = MutableStateFlow<List<SharedFile>>(emptyList())

    private var socket: WebSocket? = null
    private var crypto: FrameCrypto? = null
    private var shouldReconnect = true

    fun isPaired(): Boolean = store.get("host") != null

    fun pairedHost(): String? = store.get("host")

    // Safe to call from every activity (re)creation: only opens a session
    // when paired and none is live or already being established.
    fun ensureConnected() {
        if (!isPaired()) return
        when (linkState.value) {
            is LinkState.Idle, is LinkState.Failed -> connect()
            else -> return
        }
    }

    // --- pairing ------------------------------------------------------------

    fun pair(payloadJson: String, onResult: (String?) -> Unit) {
        val payload = try {
            json.decodeFromString(PairingPayload.serializer(), payloadJson.trim())
        } catch (error: Exception) {
            onResult("That doesn't look like an Agent HQ pairing code.")
            return
        }
        linkState.value = LinkState.PairingInFlight
        val request = Request.Builder().url("ws://${payload.host}:${payload.port}").build()
        http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val frame = buildString {
                    append("{\"t\":\"pair\",\"token\":\"").append(payload.token).append('"')
                    append(",\"devicePublicKeyDerB64\":\"").append(identity.staticPublicDerB64()).append('"')
                    append(",\"deviceSignPublicKeyDerB64\":\"").append(identity.signPublicDerB64()).append('"')
                    append(",\"name\":\"").append(deviceName.take(40)).append("\"}")
                }
                webSocket.send(frame)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val reply = try { json.parseToJsonElement(text).jsonObject } catch (e: Exception) { null }
                val ok = reply?.get("ok")?.jsonPrimitive?.content == "true"
                if (ok) {
                    store.put(
                        "host" to payload.host,
                        "port" to payload.port.toString(),
                        "pcPublicKeyDerB64" to payload.pcPublicKeyDerB64,
                    )
                    onResult(null)
                    connect()
                } else {
                    linkState.value = LinkState.Unpaired
                    onResult("The hub refused pairing — is the pairing window still open on the PC?")
                }
                webSocket.close(1000, null)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                linkState.value = LinkState.Unpaired
                onResult("Couldn't reach the hub at ${payload.host}:${payload.port} — same Wi-Fi as the PC?")
            }
        })
    }

    fun unpair() {
        shouldReconnect = false
        socket?.close(1000, null)
        store.clear() // link + identity keys — a re-pair mints a fresh identity
        stateFlow.value = Snapshot()
        linkState.value = LinkState.Unpaired
    }

    // --- encrypted session ----------------------------------------------------

    fun connect() {
        val host = store.get("host") ?: return
        val port = store.get("port")?.toIntOrNull() ?: 4517
        val pcStaticRaw = Spki.unwrap(unb64(store.get("pcPublicKeyDerB64") ?: return))
        shouldReconnect = true
        linkState.value = LinkState.Connecting

        val ephemeralPrivate = X25519.generatePrivateKey()
        val ephemeralPublic = X25519.publicFromPrivate(ephemeralPrivate)
        var established = false

        val request = Request.Builder().url("ws://$host:$port").build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("{\"t\":\"session\",\"ephPubDerB64\":\"${b64(Spki.wrapX25519(ephemeralPublic))}\"}")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = try { json.parseToJsonElement(text).jsonObject } catch (e: Exception) { return }
                if (!established) {
                    if (frame["t"]?.jsonPrimitive?.content != "session-ack") return
                    val serverEphRaw = Spki.unwrap(unb64(frame["ephPubDerB64"]!!.jsonPrimitive.content))
                    val salt = unb64(frame["saltB64"]!!.jsonPrimitive.content)
                    val keys = deriveSessionKeys(identity.staticPrivate, pcStaticRaw, ephemeralPrivate, serverEphRaw, salt)
                    crypto = FrameCrypto(keys.clientToServer, keys.serverToClient)
                    established = true
                    linkState.value = LinkState.Connected
                    sendCommand(dev.neureal.agenthq.model.Commands.hello(deviceName))
                    return
                }
                val opened = crypto?.open(
                    frame["n"]?.jsonPrimitive?.content ?: return,
                    frame["c"]?.jsonPrimitive?.content ?: return,
                ) ?: return
                when (val event = decodeEnvelope(opened)) {
                    is HubEvent.SnapshotEvent -> stateFlow.value = event.snapshot
                    is HubEvent.AgentUpdated -> stateFlow.value = stateFlow.value.let { s ->
                        s.copy(agents = s.agents.filter { it.id != event.agent.id } + event.agent)
                    }
                    is HubEvent.AgentRemoved -> stateFlow.value = stateFlow.value.let { s ->
                        s.copy(agents = s.agents.filter { it.id != event.agentId })
                    }
                    is HubEvent.TeamUpdated -> stateFlow.value = stateFlow.value.let { s ->
                        s.copy(teams = s.teams.filter { it.id != event.team.id } + event.team)
                    }
                    is HubEvent.TeamRemoved -> stateFlow.value = stateFlow.value.let { s ->
                        s.copy(teams = s.teams.filter { it.id != event.teamId })
                    }
                    is HubEvent.TaskUpdated -> stateFlow.value = stateFlow.value.let { s ->
                        s.copy(tasks = s.tasks.filter { it.id != event.task.id } + event.task)
                    }
                    is HubEvent.PermissionUpdated -> stateFlow.value = stateFlow.value.let { s ->
                        s.copy(permissions = s.permissions.filter { it.id != event.request.id } + event.request)
                    }
                    is HubEvent.ProjectUpdated -> stateFlow.value = stateFlow.value.let { s ->
                        s.copy(projects = s.projects.filter { it.id != event.project.id } + event.project)
                    }
                    is HubEvent.ProjectRemoved -> stateFlow.value = stateFlow.value.let { s ->
                        s.copy(projects = s.projects.filter { it.id != event.projectId })
                    }
                    is HubEvent.UsageUpdated -> stateFlow.value = stateFlow.value.copy(usage = event.usage)
                    is HubEvent.FileShared -> filesFlow.value = (filesFlow.value + event.file).takeLast(6)
                    else -> {}
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handleDrop(code == 4401)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                handleDrop(false)
            }
        })
    }

    private fun handleDrop(revoked: Boolean) {
        crypto = null
        if (revoked) {
            // Kill switch on the PC: our keys are gone; require a fresh pairing.
            store.clear()
            linkState.value = LinkState.Unpaired
            return
        }
        if (!shouldReconnect) return
        linkState.value = LinkState.Connecting
        scope.launch {
            delay(2000)
            if (shouldReconnect && isPaired()) connect()
        }
    }

    fun sendCommand(command: JsonObject) {
        val sealedCrypto = crypto ?: return
        val (nonce, ciphertext) = sealedCrypto.seal(command.toString())
        socket?.send("{\"t\":\"enc\",\"n\":\"$nonce\",\"c\":\"$ciphertext\"}")
    }

    fun respondPermission(requestId: String, decision: String) {
        val signature = identity.signApproval(decision, requestId)
        sendCommand(dev.neureal.agenthq.model.Commands.respondPermission(requestId, decision, signature))
    }
}

// One HubClient per process: activity recreation (folding a flip phone,
// rotation, theme changes) must never tear down or duplicate the session.
object HubHolder {
    @Volatile private var instance: HubClient? = null

    fun get(context: android.content.Context): HubClient {
        return instance ?: synchronized(this) {
            instance ?: run {
                val manufacturer = android.os.Build.MANUFACTURER ?: ""
                val model = android.os.Build.MODEL ?: "Android phone"
                val name = (if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model")
                    .trim()
                    .replaceFirstChar { it.uppercaseChar() }
                HubClient(dev.neureal.agenthq.store.PrefsKV(context, "agenthq"), name).also { instance = it }
            }
        }
    }
}
