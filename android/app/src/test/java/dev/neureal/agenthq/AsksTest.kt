package dev.neureal.agenthq

import dev.neureal.agenthq.model.Asks
import dev.neureal.agenthq.model.Task
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// One card per ask on the phone, the way the desktop folds them
// (packages/shared/src/threads.ts).
class AsksTest {
    private fun task(id: String, status: String, root: String? = null, title: String = id, team: String = "coding", tokens: Double = 10.0, created: Double = 0.0) =
        Task(id = id, title = title, status = status, teamId = team, rootTaskId = root, tokensUsed = tokens, createdAt = created, updatedAt = created)

    @Test
    fun stepsFoldIntoTheirAsk() {
        val asks = Asks.fold(
            listOf(
                task("ask", "done", tokens = 100.0),
                task("qa1", "done", root = "ask", title = "[QA] ask", team = "qa", created = 1.0),
                task("qa2", "in_flight", root = "ask", title = "[QA] ask", team = "qa", created = 2.0),
                task("other", "done"),
            ),
        ) { id -> if (id == "qa") "QA & Testing" else id ?: "step" }
        assertEquals(listOf("ask", "other"), asks.map { it.task.id })
        val ask = asks.first()
        assertEquals("in_flight", ask.task.status) // live while its QA step works
        assertEquals("qa", ask.task.teamId)
        assertEquals(120.0, ask.task.tokensUsed, 0.0)
        assertEquals("now: QA & Testing — QA check", ask.stepLine)
        assertNull(asks[1].stepLine)
    }

    @Test
    fun finishedStepsShowAsATrail() {
        val asks = Asks.fold(
            listOf(
                task("ask", "done"),
                task("qa1", "done", root = "ask", title = "[QA] ask", created = 1.0),
                task("hand", "failed", root = "ask", title = "Produce the icons", team = "design", created = 2.0),
            ),
        )
        assertEquals("done", asks.single().task.status)
        assertEquals("QA check ✓ · Produce the icons ✗", asks.single().stepLine)
    }

    @Test
    fun orphanStepsStandAlone() {
        val asks = Asks.fold(listOf(task("qa", "done", root = "gone", title = "[QA] old")))
        assertEquals("qa", asks.single().task.id)
    }
}
