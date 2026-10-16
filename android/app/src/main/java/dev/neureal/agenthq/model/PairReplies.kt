package dev.neureal.agenthq.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

// Pair mode's structured replies, read the same way the hub and the desktop
// read them (packages/shared/src/pair.ts): a reviewer's verdict, a planner's
// split plan, a debater's exchange. Picked by the seat's agent id suffix.
sealed interface PairReply {
    data class Verdict(val agree: Boolean, val blocking: List<String>, val minor: List<String>, val summary: String) : PairReply
    data class Plan(val split: Boolean, val why: String, val contract: String, val parts: List<PlanPart>) : PairReply
    data class Exchange(val accept: Boolean, val critique: List<String>, val draft: String) : PairReply
}

data class PlanPart(val title: String, val owns: List<String>, val partnerBuilds: Boolean)

object PairReplies {
    private val reviewer = Regex("-r\\d+$")
    private val planner = Regex("-p\\d+$")
    private val debater = Regex("-d\\d+$")

    fun seatKind(agentId: String?): String? = when {
        agentId == null -> null
        reviewer.containsMatchIn(agentId) -> "Reviewer"
        planner.containsMatchIn(agentId) -> "Planner"
        debater.containsMatchIn(agentId) -> "Debater"
        else -> null
    }

    fun parse(agentId: String?, text: String): PairReply? = when (seatKind(agentId)) {
        "Reviewer" -> lastObject(text) { (it["agree"] as? JsonPrimitive)?.booleanOrNull != null }?.let(::verdict)
        "Planner" -> lastObject(text) { "split" in it }?.let(::plan)
        "Debater" -> lastObject(text) { (it["accept"] as? JsonPrimitive)?.booleanOrNull != null }?.let(::exchange)
        else -> null
    }

    private fun strings(element: JsonElement?, max: Int = 8): List<String> =
        (element as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)?.take(400) }
            ?.take(max)
            .orEmpty()

    private fun text(element: JsonElement?): String = (element as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()

    // "agree" with blocking issues listed is not agreement (same as the hub).
    private fun verdict(raw: JsonObject): PairReply.Verdict {
        val blocking = strings(raw["blocking"])
        val summary = text(raw["summary"]).take(300)
        val agree = (raw["agree"] as JsonPrimitive).booleanOrNull == true && blocking.isEmpty()
        return PairReply.Verdict(
            agree = agree,
            blocking = if (agree) emptyList() else blocking.ifEmpty { listOf(summary.ifEmpty { "The reviewer did not agree but named no specific issue." }) },
            minor = strings(raw["minor"]),
            summary = summary.ifEmpty { if (agree) "agreed" else "not agreed" },
        )
    }

    private fun plan(raw: JsonObject): PairReply.Plan = PairReply.Plan(
        split = (raw["split"] as? JsonPrimitive)?.booleanOrNull == true,
        why = text(raw["why"]),
        contract = text(raw["contract"]),
        parts = (raw["parts"] as? JsonArray).orEmpty().mapIndexedNotNull { index, element ->
            val part = element as? JsonObject ?: return@mapIndexedNotNull null
            PlanPart(
                title = text(part["title"]).ifEmpty { "Part ${index + 1}" },
                owns = strings(part["owns"], 20),
                partnerBuilds = text(part["builder"]) == "partner",
            )
        },
    )

    private fun exchange(raw: JsonObject): PairReply.Exchange = PairReply.Exchange(
        accept = (raw["accept"] as JsonPrimitive).booleanOrNull == true,
        critique = strings(raw["critique"]),
        draft = text(raw["draft"]),
    )

    // The last JSON object in a reply that passes `accept`: the whole reply,
    // the last fenced block, then at most MAX_STARTS "{" positions from the
    // end — bounded on long, brace-heavy replies.
    private const val MAX_STARTS = 400
    private val fence = Regex("```(?:json)?\\s*([\\s\\S]*?)```")

    fun lastObject(text: String, accept: (JsonObject) -> Boolean): JsonObject? {
        fun tryParse(candidate: String): JsonObject? = try {
            (json.parseToJsonElement(candidate) as? JsonObject)?.takeIf(accept)
        } catch (_: Exception) {
            null
        }
        val trimmed = text.trim()
        if (trimmed.startsWith("{")) tryParse(trimmed)?.let { return it }
        for (match in fence.findAll(trimmed).toList().asReversed()) tryParse(match.groupValues[1].trim())?.let { return it }
        var start = text.lastIndexOf('{')
        var tried = 0
        while (start != -1 && tried < MAX_STARTS) {
            val end = closingBrace(text, start)
            if (end != -1) tryParse(text.substring(start, end + 1))?.let { return it }
            start = if (start > 0) text.lastIndexOf('{', start - 1) else -1
            tried++
        }
        return null
    }

    private fun closingBrace(text: String, start: Int): Int {
        var depth = 0
        var inString = false
        var escaped = false
        for (j in start until text.length) {
            val c = text[j]
            if (inString) {
                if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') inString = false
            } else if (c == '"') {
                inString = true
            } else if (c == '{') {
                depth++
            } else if (c == '}') {
                depth--
                if (depth == 0) return j
            }
        }
        return -1
    }
}
