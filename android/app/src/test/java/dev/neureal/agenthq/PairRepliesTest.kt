package dev.neureal.agenthq

import dev.neureal.agenthq.model.PairReplies
import dev.neureal.agenthq.model.PairReply
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The phone reads pair seats' replies the way the hub does
// (packages/shared/src/pair.ts) — same cases as pair.smoke's parser checks.
class PairRepliesTest {
    @Test
    fun readsVerdicts() {
        val prose = PairReplies.parse("coding-r1", """I checked the diff {not json} and: {"agree": true, "blocking": [], "minor": ["x"], "summary": "fine"} done""")
        assertTrue(prose is PairReply.Verdict && prose.agree && prose.minor == listOf("x"))
        val contradiction = PairReplies.parse("coding-r2", """{"agree": true, "blocking": ["tests fail"], "summary": "ok"}""") as PairReply.Verdict
        assertFalse(contradiction.agree)
        assertEquals("tests fail", contradiction.blocking[0])
        val fenced = PairReplies.parse("coding-r3", "Here:\n```json\n{\"agree\": false, \"blocking\": [\"no tests\"], \"summary\": \"s\"}\n```") as PairReply.Verdict
        assertEquals("no tests", fenced.blocking[0])
        assertNull(PairReplies.parse("coding-r4", "looks fine to me"))
        assertNull(PairReplies.parse("coding-w1", """{"agree": true}""")) // a worker's message is just text
    }

    @Test
    fun readsPlansAndExchanges() {
        val plan = PairReplies.parse(
            "coding-p1",
            """Here is my plan.
{"split": true, "contract": "c", "scaffold": "", "parts": [{"title": "A", "owns": ["src/a"], "builder": "you"}, {"title": "B", "owns": ["src/b"], "builder": "partner"}]}""",
        ) as PairReply.Plan
        assertTrue(plan.split)
        assertEquals(listOf(false, true), plan.parts.map { it.partnerBuilds })
        val exchange = PairReplies.parse(
            "design-d3",
            """{"accept": false, "critique": ["c"], "draft": "function f() { return {a: 1}; } // \"quoted\" }"}""",
        ) as PairReply.Exchange
        assertFalse(exchange.accept)
        assertTrue(exchange.draft.contains("return {a: 1}"))
    }

    @Test
    fun hostileReplyStaysFast() {
        val hostile = "{\"x\": ".repeat(8000) + "{".repeat(8000)
        val started = System.currentTimeMillis()
        assertNull(PairReplies.parse("coding-r9", hostile))
        assertTrue("took ${System.currentTimeMillis() - started} ms", System.currentTimeMillis() - started < 2000)
    }
}
