package dev.neureal.agenthq

import dev.neureal.agenthq.model.Commands
import dev.neureal.agenthq.model.HubEvent
import dev.neureal.agenthq.model.Task
import dev.neureal.agenthq.model.decodeEnvelope
import dev.neureal.agenthq.model.json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The phone's side of the task console protocol: transcript frames from the
// hub decode (incl. rows with optional fields and unknown future fields), a
// task's saved session parses, and the console commands encode as the hub
// expects (shared/protocol.ts).
class ConsoleProtocolTest {
    @Test
    fun decodesTranscriptFrames() {
        val frame = """
            {"seq":7,"at":1,"event":{"type":"task.transcript","taskId":"t-1","backfill":true,"more":false,"entries":[
              {"id":"ask","taskId":"t-1","at":10,"role":"owner","kind":"message","text":"do it"},
              {"id":"tool-1","taskId":"t-1","at":11,"role":"worker","agentId":"coding-w1","kind":"tool","text":"npm test","tool":"Bash","state":"ok","detail":"passed"},
              {"id":"card-p1","taskId":"t-1","at":12,"role":"worker","kind":"card","text":"wants to install","requestId":"perm-1","state":"running","futureField":42},
              {"id":"qa","taskId":"t-1","at":13,"role":"master","kind":"status","text":"QA follow-up","linkTaskId":"t-2"}
            ]}}
        """.trimIndent()
        val event = decodeEnvelope(frame)
        assertTrue("expected a transcript event, got $event", event is HubEvent.TaskTranscript)
        val transcript = event as HubEvent.TaskTranscript
        assertEquals("t-1", transcript.taskId)
        assertTrue(transcript.backfill)
        assertEquals(false, transcript.more)
        assertEquals(4, transcript.entries.size)
        assertEquals("passed", transcript.entries[1].detail)
        assertEquals("perm-1", transcript.entries[2].requestId)
        assertEquals("t-2", transcript.entries[3].linkTaskId)
    }

    @Test
    fun parsesTaskSession() {
        val task = json.decodeFromString<Task>("""{"id":"t-1","title":"x","status":"done","session":{"engine":"codex","id":"thread-9"}}""")
        assertEquals("codex", task.session?.engine)
        assertEquals("thread-9", task.session?.id)
        val old = json.decodeFromString<Task>("""{"id":"t-0","title":"y","status":"done"}""")
        assertEquals(null, old.session)
        assertEquals(null, old.pair)
    }

    @Test
    fun parsesTaskPair() {
        val task = json.decodeFromString<Task>(
            """{"id":"t-3","title":"z","status":"in_flight","pair":{"mode":"review","maxRounds":5,"round":2,"state":"reviewing",""" +
                """"rounds":[{"round":1,"author":"a","agree":false,"blocking":["b"],"minor":[],"summary":"s","version":"abcd1234"}],""" +
                """"reviewerSession":{"engine":"codex","id":"th"},"reviewerModel":"gpt-6.1-sol"}}""",
        )
        assertEquals(2, task.pair?.round)
        assertEquals(5, task.pair?.maxRounds)
        assertEquals("reviewing", task.pair?.state)
        assertEquals("gpt-6.1-sol", task.pair?.reviewerModel)
        assertEquals("review", task.pair?.mode)
        val split = json.decodeFromString<Task>(
            """{"id":"t-4","title":"s","status":"done","pair":{"mode":"split","maxRounds":3,"round":1,"rounds":[],""" +
                """"plan":{"rounds":2,"agreed":true,"contract":"c","scaffold":null,"parts":[""" +
                """{"title":"A","owns":["src/a"],"builder":"author","taskId":"t-5"},{"title":"B","owns":["src/b"],"builder":"partner"}]}}}""",
        )
        assertEquals("split", split.pair?.mode)
        assertEquals(2, split.pair?.plan?.rounds)
        assertEquals("partner", split.pair?.plan?.parts?.get(1)?.builder)
        assertEquals("t-5", split.pair?.plan?.parts?.get(0)?.taskId)
        val debate = json.decodeFromString<Task>(
            """{"id":"t-6","title":"d","status":"done","pair":{"mode":"debate","maxRounds":3,"round":0,"rounds":[],""" +
                """"debate":{"rounds":2,"drafts":{"author":"a","partner":"b"},"accepted":"partner","last":null}}}""",
        )
        assertEquals("debate", debate.pair?.mode)
        assertEquals("partner", debate.pair?.debate?.accepted)
        assertEquals(2, debate.pair?.debate?.rounds)
    }

    @Test
    fun encodesConsoleCommands() {
        assertEquals("""{"type":"task.watch","taskId":"t-1"}""", Commands.watchTask("t-1").toString())
        assertEquals("""{"type":"task.watch","taskId":"t-1","before":12.5}""", Commands.watchTask("t-1", 12.5).toString())
        assertEquals("""{"type":"task.unwatch","taskId":"t-1"}""", Commands.unwatchTask("t-1").toString())
        assertEquals("""{"type":"task.message","taskId":"t-1","text":"hi"}""", Commands.messageTask("t-1", "hi").toString())
        assertEquals("""{"type":"task.stop","taskId":"t-1"}""", Commands.stopTask("t-1").toString())
    }
}
