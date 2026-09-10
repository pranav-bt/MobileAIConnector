package dev.neureal.agenthq

import dev.neureal.agenthq.model.Commands
import dev.neureal.agenthq.net.HubClient
import dev.neureal.agenthq.net.LinkState
import dev.neureal.agenthq.store.MemoryKV
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue

// The phone's ENTIRE link stack (pairing -> authenticated session -> sealed
// frames -> snapshot -> signed approval) against a live hub — the exact code
// the app ships, minus the UI. Opt-in: gradlew :app:testDebugUnitTest -PhubE2e=1
// with `npx tsx test/e2e-hub.ts` (packages/hub) already running.
class HubLinkE2eTest {

    private fun <T> await(label: String, timeoutMs: Long = 15000, probe: () -> T?): T {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            probe()?.let { return it }
            Thread.sleep(150)
        }
        throw AssertionError("timed out waiting for: $label")
    }

    @Test
    fun `pair, encrypted session, snapshot, signed approval round-trip`() {
        assumeTrue(System.getProperty("hubE2e") == "1")
        val port = System.getProperty("hubE2ePort")?.toIntOrNull() ?: 4611

        // Plaintext local control client: opens the pairing window like the
        // desktop app would, and reads the QR payload from security.updated.
        val control = OkHttpClient()
        val frames = ConcurrentLinkedQueue<String>()
        val controlSocket = control.newWebSocket(
            Request.Builder().url("ws://127.0.0.1:$port").build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""{"type":"hello","client":"cli","name":"e2e-control"}""")
                    webSocket.send("""{"type":"pairing.start"}""")
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    frames.add(text)
                }
            },
        )

        val qrJson = await("pairing QR") {
            frames.mapNotNull { raw ->
                val event = JSONObject(raw).optJSONObject("event") ?: return@mapNotNull null
                if (event.optString("type") != "security.updated") return@mapNotNull null
                event.optJSONObject("security")?.optString("pairingQr", "")?.takeIf { it.isNotEmpty() }
            }.firstOrNull()
        }

        // The app's own client takes over from here.
        val hub = HubClient(MemoryKV(), "JvmTestPhone")
        var pairError: String? = "pending"
        hub.pair(qrJson) { error -> pairError = error }
        await("pairing completes") { if (pairError == null) true else null }
        await("encrypted session up") { if (hub.linkState.value is LinkState.Connected) true else null }
        val teams = await("snapshot over sealed channel") {
            hub.snapshotFlow.value.teams.takeIf { it.size >= 3 }
        }
        assertTrue(teams.any { it.id == "coding" })

        // Gated task -> pending card -> signed approval -> done.
        hub.sendCommand(Commands.submitTask("coding: install the e2e tooling"))
        val pending = await("permission request") {
            hub.snapshotFlow.value.permissions.firstOrNull { it.status == "pending" }
        }
        hub.respondPermission(pending.id, "approve")
        val task = await("task done after signed approval") {
            hub.snapshotFlow.value.tasks.firstOrNull { it.id == pending.taskId && it.status == "done" }
        }
        assertEquals("done", task.status)

        controlSocket.close(1000, null)
    }
}
