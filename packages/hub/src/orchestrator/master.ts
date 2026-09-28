import type { ModelTier, Project, Team } from '@agent-hq/shared';
import type { OrchestratorEngine } from '../engine/types.js';

// The master agent's intake: one model call that reads the task and picks a
// team (who works) and a project (where they work). Falls back to keyword
// heuristics if the call or the parse fails, so a submitted task is never
// lost.

export interface PlanStep {
  teamId: string;
  title: string;
  instruction: string;
}

export interface RoutingDecision {
  teamId: string;
  projectId: string;
  title: string;
  reason: string;
  tokens: number;
  fallback: boolean;
  // Present when the master decomposed the task into a sequenced multi-team
  // plan (each step gets the previous step's synopsis as a handover).
  steps: PlanStep[] | null;
}

const MASTER_MODEL: ModelTier = 'opus';

function routingPrompt(teams: Team[], projects: Project[], defaultProjectId: string, text: string): string {
  const teamLines = teams
    .map((team) => `- id: ${team.id}\n  name: ${team.name}\n  charter: ${team.charter}`)
    .join('\n');
  const projectLines = projects
    .map((project) => `* project: ${project.id} | ${project.name} | ${project.description || '(no description)'}`)
    .join('\n');
  return [
    'You are the master agent of Agent HQ. Route the incoming task to the team whose charter fits best,',
    'and to the project it concerns.',
    '',
    'Teams:',
    teamLines,
    '',
    'Projects:',
    projectLines,
    '',
    `If no project clearly matches, use "${defaultProjectId}".`,
    '',
    `Task: "${text}"`,
    '',
    'Reply with ONLY a JSON object, no other text.',
    'Single-team task (the common case):',
    '{"teamId": "<team id>", "projectId": "<project id>", "title": "<short imperative title, max 60 chars>", "reason": "<one sentence>"}',
    '',
    'ONLY if the task genuinely needs teams working in sequence (e.g., design',
    'produces a spec first, then coding implements it), reply instead with a',
    'plan of 2-3 steps — each step runs after the previous one finishes and',
    'receives its report as a handover:',
    '{"projectId": "<project id>", "title": "<overall title>", "reason": "<one sentence>", "plan": [{"teamId": "<team id>", "title": "<step title>", "instruction": "<what this team should do>"}, ...]}',
  ].join('\n');
}

function keywordFallback(teams: Team[], text: string): Team {
  const lowered = text.toLowerCase();
  const hit = teams.find(
    (team) => lowered.includes(team.id) || lowered.includes(team.name.toLowerCase().split(' ')[0] ?? ''),
  );
  return hit ?? teams.find((team) => team.id === 'coding') ?? teams[0]!;
}

export async function routeTask(
  engine: OrchestratorEngine,
  teams: Team[],
  projects: Project[],
  defaultProjectId: string,
  text: string,
  forcedProjectId: string | null,
  model: ModelTier = MASTER_MODEL,
): Promise<RoutingDecision> {
  const fallbackTeam = keywordFallback(teams, text);
  const fallbackTitle = text.slice(0, 60);
  try {
    const { text: reply, tokens } = await engine.complete({
      prompt: routingPrompt(teams, projects, forcedProjectId ?? defaultProjectId, text),
      model,
    });
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in routing reply');
    const parsed = JSON.parse(jsonMatch[0]) as {
      teamId?: unknown;
      projectId?: unknown;
      title?: unknown;
      reason?: unknown;
      plan?: unknown;
    };
    const routedProject = projects.find((candidate) => candidate.id === parsed.projectId);
    // An explicit @project from the user always beats the model's pick.
    const projectId = forcedProjectId ?? routedProject?.id ?? defaultProjectId;
    const title =
      typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 60) : fallbackTitle;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

    if (Array.isArray(parsed.plan) && parsed.plan.length >= 2) {
      const steps: PlanStep[] = [];
      for (const raw of parsed.plan.slice(0, 3)) {
        if (typeof raw !== 'object' || raw === null) continue;
        const step = raw as { teamId?: unknown; title?: unknown; instruction?: unknown };
        const team = teams.find((candidate) => candidate.id === step.teamId);
        if (!team || typeof step.instruction !== 'string' || !step.instruction.trim()) continue;
        steps.push({
          teamId: team.id,
          title: typeof step.title === 'string' && step.title.trim() ? step.title.trim().slice(0, 50) : team.name,
          instruction: step.instruction.trim(),
        });
      }
      if (steps.length >= 2) {
        return { teamId: steps[0]!.teamId, projectId, title, reason, tokens, fallback: false, steps };
      }
    }

    const team = teams.find((candidate) => candidate.id === parsed.teamId);
    if (!team) throw new Error(`routing picked unknown team: ${String(parsed.teamId)}`);
    return { teamId: team.id, projectId, title, reason, tokens, fallback: false, steps: null };
  } catch (error) {
    console.warn('[orchestrator] routing call failed, using keyword fallback:', error);
    return {
      teamId: fallbackTeam.id,
      projectId: forcedProjectId ?? defaultProjectId,
      title: fallbackTitle,
      reason: 'keyword fallback',
      tokens: 0,
      fallback: true,
      steps: null,
    };
  }
}

// Master's coordination pass: after ANY team files a completed-task report,
// the master reads it and decides whether a DIFFERENT team must pick work up
// (a handover, a blocker, a missing piece outside the reporting team's
// charter). This is the general mechanism behind interdisciplinary flow —
// QA remediation is a specialized case with its own loop cap.
export interface FollowUpDispatch {
  teamId: string;
  title: string;
  instruction: string;
}

export async function coordinateFollowUp(
  engine: OrchestratorEngine,
  teams: Team[],
  sourceTeam: Team,
  taskTitle: string,
  synopsis: string,
  model: ModelTier = 'haiku',
): Promise<{ dispatch: FollowUpDispatch[]; tokens: number }> {
  const teamLines = teams
    .filter((team) => team.id !== sourceTeam.id)
    .map((team) => `- ${team.id}: ${team.name} — ${team.charter}`)
    .join('\n');
  const prompt = [
    'You are the master agent of Agent HQ, coordinating specialist teams.',
    '',
    'Other teams available:',
    teamLines,
    '',
    `The ${sourceTeam.name} just completed the task "${taskTitle}". Their final report:`,
    `"${synopsis}"`,
    '',
    'If — and ONLY if — the report explicitly states that work remains which a',
    "DIFFERENT team must do (a handover, a blocker, a missing piece outside the reporting team's",
    'charter), dispatch it to that team. Normal completions, notes, and suggestions dispatch',
    'nothing — that is the common case. A report that ANSWERS the task (research findings, a',
    'brief, a comparison) is COMPLETE: the answer reaches the owner directly — never dispatch',
    'another team to re-package, document, or verify it. Never dispatch more than 2 items.',
    '',
    'Reply with ONLY JSON:',
    '{"dispatch": [{"teamId": "<team id>", "title": "<imperative title, max 60 chars>", "instruction": "<what that team must do, with the context they need>"}]}',
    'Use {"dispatch": []} when nothing is needed.',
  ].join('\n');
  try {
    const { text, tokens } = await engine.complete({ prompt, model });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { dispatch: [], tokens };
    const parsed = JSON.parse(jsonMatch[0]) as { dispatch?: unknown };
    if (!Array.isArray(parsed.dispatch)) return { dispatch: [], tokens };
    const dispatch: FollowUpDispatch[] = [];
    for (const raw of parsed.dispatch.slice(0, 2)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = raw as { teamId?: unknown; title?: unknown; instruction?: unknown };
      const team = teams.find((candidate) => candidate.id === item.teamId);
      if (!team || team.id === sourceTeam.id) continue;
      if (typeof item.instruction !== 'string' || !item.instruction.trim()) continue;
      dispatch.push({
        teamId: team.id,
        title:
          typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 60) : `Follow up: ${taskTitle}`.slice(0, 60),
        instruction: item.instruction.trim(),
      });
    }
    return { dispatch, tokens };
  } catch {
    return { dispatch: [], tokens: 0 }; // coordination is best-effort, never fatal
  }
}

// Master's read of a QA report: does it need a remediation round?
export async function evaluateQaReport(
  engine: OrchestratorEngine,
  qaSynopsis: string,
  model: ModelTier = 'haiku',
): Promise<{ verdict: 'pass' | 'issues'; summary: string; tokens: number }> {
  const prompt = [
    'You are the master agent. A QA report on completed work just came in.',
    `QA report: "${qaSynopsis}"`,
    '',
    'Does it indicate REAL issues that the original team must fix (bugs, failures,',
    'meaningful performance problems)? Nitpicks and pass-with-notes count as "pass".',
    'Reply with ONLY JSON: {"verdict": "pass" | "issues", "summary": "<the concrete issues to fix, or empty>"}',
  ].join('\n');
  try {
    const { text, tokens } = await engine.complete({ prompt, model });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { verdict?: unknown; summary?: unknown };
      return {
        verdict: parsed.verdict === 'issues' ? 'issues' : 'pass',
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        tokens,
      };
    }
    return { verdict: 'pass', summary: '', tokens };
  } catch {
    return { verdict: 'pass', summary: '', tokens: 0 };
  }
}

export async function reviewWorkerReport(
  engine: OrchestratorEngine,
  team: Team,
  taskTitle: string,
  workerSynopsis: string,
): Promise<{ synopsis: string; memoryNote: string | null; tokens: number }> {
  const prompt = [
    `You are the lead of the ${team.name} (charter: ${team.charter}).`,
    'A worker agent finished a task. Review the report, write the synopsis the owner will read,',
    'and optionally record one durable lesson for the team memory (only if genuinely reusable on future tasks;',
    'most tasks produce none).',
    '',
    `Task: ${taskTitle}`,
    `Worker report: ${workerSynopsis || '(the worker returned no report)'}`,
    '',
    'How to write the synopsis — it is read on a phone and its FIRST LINE is spoken aloud:',
    'Line 1: a single-sentence headline of the outcome (no markdown, no colon-label).',
    'Then, when there are details or findings, short "- " bullet points (3-8), one idea each,',
    'links on their own bullet. If the deliverable is work done elsewhere (code, files, a build),',
    'the headline plus 1-3 bullets is enough. If the deliverable IS information (research, an',
    'answer, a comparison, a plan), the bullets carry the actual findings — key facts, numbers,',
    'links, and the recommendation. Never reduce findings to "research was completed".',
    '',
    'Reply with ONLY a JSON object, no other text:',
    '{"synopsis": "<see above>", "memoryNote": "<one short lesson, or null>"}',
  ].join('\n');
  try {
    const { text, tokens } = await engine.complete({ prompt, model: team.leadModel });
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { synopsis?: unknown; memoryNote?: unknown };
      return {
        synopsis: typeof parsed.synopsis === 'string' && parsed.synopsis.trim() ? parsed.synopsis.trim() : workerSynopsis,
        memoryNote: typeof parsed.memoryNote === 'string' && parsed.memoryNote.trim() ? parsed.memoryNote.trim() : null,
        tokens,
      };
    }
    return { synopsis: text.trim() || workerSynopsis, memoryNote: null, tokens };
  } catch (error) {
    console.warn('[orchestrator] lead review failed, passing worker report through:', error);
    return { synopsis: workerSynopsis, memoryNote: null, tokens: 0 };
  }
}
