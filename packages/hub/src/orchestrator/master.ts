import type { ModelTier, Project, Team } from '@agent-hq/shared';
import type { OrchestratorEngine } from '../engine/types.js';

// The master agent's intake: one model call that reads the task and picks a
// team (who works) and a project (where they work). Falls back to keyword
// heuristics if the call or the parse fails, so a submitted task is never
// lost.

export interface RoutingDecision {
  teamId: string;
  projectId: string;
  title: string;
  reason: string;
  tokens: number;
  fallback: boolean;
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
    'Reply with ONLY a JSON object, no other text:',
    '{"teamId": "<team id>", "projectId": "<project id>", "title": "<short imperative title, max 60 chars>", "reason": "<one sentence>"}',
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
): Promise<RoutingDecision> {
  const fallbackTeam = keywordFallback(teams, text);
  const fallbackTitle = text.slice(0, 60);
  try {
    const { text: reply, tokens } = await engine.complete({
      prompt: routingPrompt(teams, projects, forcedProjectId ?? defaultProjectId, text),
      model: MASTER_MODEL,
    });
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in routing reply');
    const parsed = JSON.parse(jsonMatch[0]) as {
      teamId?: unknown;
      projectId?: unknown;
      title?: unknown;
      reason?: unknown;
    };
    const team = teams.find((candidate) => candidate.id === parsed.teamId);
    if (!team) throw new Error(`routing picked unknown team: ${String(parsed.teamId)}`);
    const routedProject = projects.find((candidate) => candidate.id === parsed.projectId);
    return {
      teamId: team.id,
      // An explicit @project from the user always beats the model's pick.
      projectId: forcedProjectId ?? routedProject?.id ?? defaultProjectId,
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 60) : fallbackTitle,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      tokens,
      fallback: false,
    };
  } catch (error) {
    console.warn('[orchestrator] routing call failed, using keyword fallback:', error);
    return {
      teamId: fallbackTeam.id,
      projectId: forcedProjectId ?? defaultProjectId,
      title: fallbackTitle,
      reason: 'keyword fallback',
      tokens: 0,
      fallback: true,
    };
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
    'Reply with ONLY a JSON object, no other text:',
    '{"synopsis": "<1-3 plain sentences — what was done, anything the owner should double-check>", "memoryNote": "<one short lesson, or null>"}',
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
