import type { ModelTier, Team } from '@agent-hq/shared';
import type { OrchestratorEngine } from '../engine/types.js';

// The master agent's intake: one model call that reads the task and picks a
// team by charter. Falls back to a keyword heuristic if the call or the
// parse fails, so a submitted task is never lost.

export interface RoutingDecision {
  teamId: string;
  title: string;
  reason: string;
  tokens: number;
  fallback: boolean;
}

const MASTER_MODEL: ModelTier = 'opus';

function routingPrompt(teams: Team[], text: string): string {
  const teamLines = teams
    .map((team) => `- id: ${team.id}\n  name: ${team.name}\n  charter: ${team.charter}`)
    .join('\n');
  return [
    'You are the master agent of Agent HQ. Route the incoming task to the team whose charter fits best.',
    '',
    'Teams:',
    teamLines,
    '',
    `Task: "${text}"`,
    '',
    'Reply with ONLY a JSON object, no other text:',
    '{"teamId": "<one of the team ids>", "title": "<short imperative title, max 60 chars>", "reason": "<one sentence>"}',
  ].join('\n');
}

function keywordFallback(teams: Team[], text: string): Team {
  const lowered = text.toLowerCase();
  const hit = teams.find(
    (team) => lowered.includes(team.id) || lowered.includes(team.name.toLowerCase().split(' ')[0] ?? ''),
  );
  return hit ?? teams.find((team) => team.id === 'coding') ?? teams[0]!;
}

export async function routeTask(engine: OrchestratorEngine, teams: Team[], text: string): Promise<RoutingDecision> {
  const fallbackTeam = keywordFallback(teams, text);
  const fallbackTitle = text.slice(0, 60);
  try {
    const { text: reply, tokens } = await engine.complete({ prompt: routingPrompt(teams, text), model: MASTER_MODEL });
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in routing reply');
    const parsed = JSON.parse(jsonMatch[0]) as { teamId?: unknown; title?: unknown; reason?: unknown };
    const team = teams.find((candidate) => candidate.id === parsed.teamId);
    if (!team) throw new Error(`routing picked unknown team: ${String(parsed.teamId)}`);
    return {
      teamId: team.id,
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 60) : fallbackTitle,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      tokens,
      fallback: false,
    };
  } catch (error) {
    console.warn('[orchestrator] routing call failed, using keyword fallback:', error);
    return { teamId: fallbackTeam.id, title: fallbackTitle, reason: 'keyword fallback', tokens: 0, fallback: true };
  }
}

export async function reviewWorkerReport(
  engine: OrchestratorEngine,
  team: Team,
  taskTitle: string,
  workerSynopsis: string,
): Promise<{ synopsis: string; tokens: number }> {
  const prompt = [
    `You are the lead of the ${team.name} (charter: ${team.charter}).`,
    'A worker agent finished a task. Review the report and write the synopsis the owner will read.',
    '',
    `Task: ${taskTitle}`,
    `Worker report: ${workerSynopsis || '(the worker returned no report)'}`,
    '',
    'Reply with ONLY the synopsis: 1-3 plain sentences — what was done, and anything the owner should know or double-check.',
  ].join('\n');
  try {
    const { text, tokens } = await engine.complete({ prompt, model: team.leadModel });
    return { synopsis: text.trim() || workerSynopsis, tokens };
  } catch (error) {
    console.warn('[orchestrator] lead review failed, passing worker report through:', error);
    return { synopsis: workerSynopsis, tokens: 0 };
  }
}
