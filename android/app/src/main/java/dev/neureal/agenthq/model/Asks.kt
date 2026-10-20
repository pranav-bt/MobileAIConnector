package dev.neureal.agenthq.model

// One card per ask (mirrors foldAsks in packages/shared/src/threads.ts): a QA
// pass, a handover to another team, a recovery move, a part of a split are
// STEPS of the owner's ask (Task.rootTaskId), folded into its card — live
// with whatever step is working, tokens summed. The ask's console carries
// every step's rows.
data class AskCard(val task: Task, val stepLine: String?)

object Asks {
    private val live = setOf("intake", "routing", "queued", "in_flight", "awaiting_permission", "review")
    private val rank = mapOf("awaiting_permission" to 5, "in_flight" to 4, "review" to 4, "queued" to 2, "routing" to 1, "intake" to 1)

    fun isLive(status: String): Boolean = status in live

    // "QA check", "part 1/2", "handover", or the step's own title.
    fun stepKind(step: Task): String {
        val tag = Regex("^\\[([^\\]]+)\\]").find(step.title)?.groupValues?.get(1) ?: return step.title.take(50)
        return when {
            tag.equals("QA", ignoreCase = true) -> "QA check"
            Regex("^fix\\d*$", RegexOption.IGNORE_CASE).matches(tag) -> "fix"
            else -> tag.lowercase()
        }
    }

    fun fold(tasks: List<Task>, teamName: (String?) -> String = { it ?: "step" }): List<AskCard> {
        val ids = tasks.map { it.id }.toSet()
        fun isStep(task: Task) = task.rootTaskId != null && task.rootTaskId != task.id && task.rootTaskId in ids
        val steps = tasks.filter(::isStep).groupBy { it.rootTaskId!! }
        return tasks.filterNot(::isStep).map { root ->
            val own = steps[root.id].orEmpty().sortedBy { it.createdAt }
            if (own.isEmpty()) return@map AskCard(root, null)
            val working = (listOf(root) + own).filter { isLive(it.status) }.sortedByDescending { rank[it.status] ?: 0 }
            val lead = working.firstOrNull()
            val current = lead?.takeIf { it.id != root.id }
            val folded = root.copy(
                status = lead?.status ?: root.status,
                teamId = current?.teamId ?: root.teamId,
                progressPct = current?.progressPct ?: root.progressPct,
                tokensUsed = root.tokensUsed + own.sumOf { it.tokensUsed },
                updatedAt = maxOf(root.updatedAt, own.maxOf { it.updatedAt }),
            )
            val line = if (current != null) {
                val more = own.count { isLive(it.status) } - 1
                "now: ${teamName(current.teamId)} — ${stepKind(current)}" + if (more > 0) " (+$more more)" else ""
            } else {
                own.takeLast(3).joinToString(" · ") { step ->
                    "${stepKind(step)} " + when (step.status) { "done" -> "✓"; "failed" -> "✗"; "paused" -> "■"; else -> "…" }
                }
            }
            AskCard(folded, line)
        }
    }
}
