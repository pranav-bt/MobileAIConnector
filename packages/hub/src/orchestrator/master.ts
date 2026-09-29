import { resolveModel, type ModelSpec, type ModelTier, type Project, type Team } from '@agent-hq/shared';
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

export type ProjectBasis = 'pinned' | 'named' | 'thread' | 'default';

export interface RoutingDecision {
  teamId: string;
  projectId: string;
  title: string;
  reason: string;
  tokens: number;
  fallback: boolean;
  // Why projectId was chosen: an @project pin, a project named in the text,
  // the owner's current thread, or the default (no thread yet). 'named' is
  // the only basis that can leave the thread, so it is what gets confirmed.
  projectBasis: ProjectBasis;
  // Present when the master decomposed the task into a sequenced multi-team
  // plan (each step gets the previous step's synopsis as a handover).
  steps: PlanStep[] | null;
}

const MASTER_MODEL: ModelTier = 'opus';

// Projects the owner actually named in the text (by id or name, any spacing:
// "castle wars", "CastleWars", "castle-wars"). Only a named project may
// override the thread's project; a bare noun ("the map", "the bases") never
// counts as naming one.
export function namedProjects(projects: Project[], text: string): Project[] {
  const words = (label: string) =>
    label
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return projects.filter((project) =>
    [project.id, project.name].some((label) => {
      const parts = words(label);
      return parts.length > 0 && new RegExp(`\\b${parts.join('[\\s_-]*')}\\b`, 'i').test(text);
    }),
  );
}

function routingPrompt(
  teams: Team[],
  candidates: Project[],
  fallbackProjectId: string,
  projectFixed: boolean,
  recent: string[],
  text: string,
): string {
  const teamLines = teams
    .map((team) => `- id: ${team.id}\n  name: ${team.name}\n  charter: ${team.charter}`)
    .join('\n');
  const projectLines = candidates
    .map((project) => `* project: ${project.id} | ${project.name} | ${project.description || '(no description)'}`)
    .join('\n');
  const projectRule = projectFixed
    ? [
        'Project (fixed — the owner did not name another one, so this task continues the current thread;',
        'do NOT pick, mention or title it after any other project):',
        projectLines,
      ]
    : [
        'Projects (only these may be picked — the owner named them or it is the current thread):',
        projectLines,
        '',
        `If none clearly matches, use "${fallbackProjectId}".`,
      ];
  return [
    'You are the master agent of Agent HQ. Route the incoming task to the team whose charter fits best,',
    'and to the project it concerns.',
    '',
    'Teams:',
    teamLines,
    '',
    ...projectRule,
    '',
    ...(recent.length
      ? [
          'Recent conversation with the owner (oldest first) — the task most likely continues it, so',
          'resolve vague references ("the game", "the map") against these, not against project names:',
          ...recent.map((line) => `- ${line}`),
          '',
        ]
      : []),
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

// Where the owner's conversation currently is: the project to inherit when
// they don't name one, plus a few recent asks so vague references resolve.
export interface RoutingThread {
  projectId: string | null;
  recent: string[];
}

export async function routeTask(
  engine: OrchestratorEngine,
  teams: Team[],
  projects: Project[],
  defaultProjectId: string,
  text: string,
  forcedProjectId: string | null,
  model: ModelSpec = resolveModel(MASTER_MODEL),
  thread: RoutingThread = { projectId: null, recent: [] },
): Promise<RoutingDecision> {
  const fallbackTeam = keywordFallback(teams, text);
  const fallbackTitle = text.slice(0, 60);
  // The model never guesses a project from topic words: an explicit @project
  // wins, then projects named in the text (the model picks among those and
  // the thread's), and otherwise the task stays in the thread's project.
  const liveThreadProject = projects.find((project) => project.id === thread.projectId);
  const threadProject = liveThreadProject ?? projects.find((project) => project.id === defaultProjectId);
  const inheritedProjectId = forcedProjectId ?? threadProject?.id ?? defaultProjectId;
  const inheritedBasis: ProjectBasis = forcedProjectId ? 'pinned' : liveThreadProject ? 'thread' : 'default';
  const named = forcedProjectId ? [] : namedProjects(projects, text);
  const projectFixed = named.length === 0;
  const candidates = projectFixed
    ? projects.filter((project) => project.id === inheritedProjectId)
    : [...new Set([...named, ...(threadProject ? [threadProject] : [])])];
  try {
    const { text: reply, tokens } = await engine.complete({
      prompt: routingPrompt(teams, candidates, inheritedProjectId, projectFixed, thread.recent, text),
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
    const routedProject = projectFixed ? undefined : candidates.find((candidate) => candidate.id === parsed.projectId);
    const projectId = routedProject?.id ?? inheritedProjectId;
    const projectBasis: ProjectBasis =
      routedProject && named.includes(routedProject) && routedProject.id !== inheritedProjectId ? 'named' : inheritedBasis;
    // A model title that drags in a project the owner didn't name would put
    // the wrong game on the task card; the owner's own words replace it.
    const strays = projects.filter((project) => project.id !== projectId && !named.includes(project));
    const cleanTitle = (raw: unknown, max: number, fallback: string): string =>
      typeof raw === 'string' && raw.trim() && namedProjects(strays, raw).length === 0
        ? raw.trim().slice(0, max)
        : fallback;
    const title = cleanTitle(parsed.title, 60, fallbackTitle);
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
          title: cleanTitle(step.title, 50, team.name),
          instruction: step.instruction.trim(),
        });
      }
      if (steps.length >= 2) {
        return { teamId: steps[0]!.teamId, projectId, projectBasis, title, reason, tokens, fallback: false, steps };
      }
    }

    const team = teams.find((candidate) => candidate.id === parsed.teamId);
    if (!team) throw new Error(`routing picked unknown team: ${String(parsed.teamId)}`);
    return { teamId: team.id, projectId, projectBasis, title, reason, tokens, fallback: false, steps: null };
  } catch (error) {
    console.warn('[orchestrator] routing call failed, using keyword fallback:', error);
    return {
      teamId: fallbackTeam.id,
      projectId: inheritedProjectId,
      projectBasis: inheritedBasis,
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
  model: ModelSpec = resolveModel('haiku'),
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

// Lead's split pass for build teams: a big task fans out into parts that
// workers build IN PARALLEL on disjoint files, under one shared contract,
// then a single integration worker merges, builds, tests and commits. The
// lead is the sync point — parts never coordinate with each other directly.
// Parts share one working tree, so a plan is accepted only when every part
// owns a non-empty list of paths and no two parts' paths overlap.
export interface ParallelPart {
  title: string;
  instruction: string;
  owns: string[];
}

export interface ParallelPlan {
  contract: string;
  scaffold: string | null;
  parts: ParallelPart[];
}

function slashPath(raw: string): string {
  return raw.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/\\/g, '/').toLowerCase();
}

// Workspace-relative, forward slashes, lowercase (Windows paths are
// case-insensitive), no leading "/" or "./", no trailing "/", "/*" or "/**".
// Absolute paths (drive or UNC) are made relative when they sit inside
// `workspaceDir`, so "/src/a", "src/a" and "D:/repo/src/a" all compare equal.
// Null for anything ownership can't be reasoned about: empty, the root, "..",
// "~", an absolute path outside the workspace, or a glob anywhere but that
// trailing position.
export function normalizeOwnedPath(raw: string, workspaceDir?: string): string | null {
  let path = slashPath(raw);
  if (/^([a-z]:|\/\/)/.test(path)) {
    const root = workspaceDir ? slashPath(workspaceDir).replace(/\/+$/, '') : '';
    if (!root || !(path === root || path.startsWith(`${root}/`))) return null;
    path = path.slice(root.length);
  }
  path = path.replace(/\/{2,}/g, '/').replace(/^(\.?\/)+/, '').replace(/(\/\*\*?)+$/, '').replace(/\/+$/, '');
  if (!path || path === '.' || path.startsWith('~') || path.includes(':')) return null;
  if (/[*?[\]{}]/.test(path) || path.split('/').includes('..')) return null;
  return path;
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// True when every part owns >=1 valid path and no path of one part equals or
// nests inside a path of another part.
export function ownershipIsDisjoint(ownsLists: string[][], workspaceDir?: string): boolean {
  const normalized: string[][] = [];
  for (const owns of ownsLists) {
    const paths = owns.map((raw) => normalizeOwnedPath(raw, workspaceDir));
    if (paths.length === 0 || paths.some((path) => path === null)) return false;
    normalized.push(paths as string[]);
  }
  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      if (normalized[i]!.some((a) => normalized[j]!.some((b) => pathsOverlap(a, b)))) return false;
    }
  }
  return true;
}

function parseOwns(raw: unknown): string[] {
  const entries = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]+/) : [];
  return entries.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

// `rejected` is set when the lead asked for a split but the plan failed
// validation (the task then runs as one worker).
export async function planParallelSplit(
  engine: OrchestratorEngine,
  team: Team,
  taskTitle: string,
  taskDetail: string,
  maxParts: number,
  model: ModelSpec,
  workspaceDir?: string,
): Promise<{ plan: ParallelPlan | null; tokens: number; rejected: string | null }> {
  const prompt = [
    `You are the lead of the ${team.name} (charter: ${team.charter}).`,
    `You can run up to ${maxParts} workers at the same time. Decide whether this task should be split`,
    'across parallel workers.',
    '',
    `Task: ${taskTitle}`,
    `Details: ${taskDetail.slice(0, 4000)}`,
    '',
    'Split ONLY when the task is big and has 2 or more substantial parts that can be built at the SAME',
    'time in DISJOINT files or directories (e.g. separate subsystems or modules). Do NOT split small',
    'tasks, bug fixes, investigations, single-file changes, or work whose parts must happen in order.',
    'All parts edit the SAME working tree at once, so each part must own an explicit list of',
    'workspace-relative files/directories (no globs), and no path may equal or sit inside another',
    "part's path. Shared files (package manifests, shared types, entry points) belong to the scaffold",
    'or the integration step, never to a part.',
    'When you split, you are the sync point: write the shared contract every part codes against',
    '(folder layout, module names, public interfaces, data shapes, event names). If the parts need a',
    'common skeleton first (repo init, folder structure, shared types), describe it as the scaffold —',
    'one worker builds it before the parts start. An integration worker merges, tests and commits after.',
    '',
    'Reply with ONLY JSON. Not worth splitting: {"split": false}',
    `Otherwise: {"split": true, "contract": "<shared contract>", "scaffold": "<skeleton to build first, or empty>", "parts": [{"title": "<short title>", "instruction": "<what to build>", "owns": ["<file or dir>", "..."]}]} with 2-${maxParts} parts.`,
  ].join('\n');
  let tokens = 0;
  try {
    const result = await engine.complete({ prompt, model });
    tokens = result.tokens;
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { plan: null, tokens, rejected: null };
    const parsed = JSON.parse(jsonMatch[0]) as { split?: unknown; contract?: unknown; scaffold?: unknown; parts?: unknown };
    if (parsed.split !== true) return { plan: null, tokens, rejected: null };
    // The lead asked for a split: any malformed part rejects the whole plan
    // (dropping one would silently lose its work).
    if (!Array.isArray(parsed.parts) || parsed.parts.length < 2 || parsed.parts.length > maxParts) {
      return { plan: null, tokens, rejected: `a split needs 2-${maxParts} parts` };
    }
    const parts: ParallelPart[] = [];
    for (const raw of parsed.parts) {
      const part = (typeof raw === 'object' && raw !== null ? raw : {}) as { title?: unknown; instruction?: unknown; owns?: unknown };
      if (typeof part.instruction !== 'string' || !part.instruction.trim()) {
        return { plan: null, tokens, rejected: 'a part had no instruction' };
      }
      parts.push({
        title: typeof part.title === 'string' && part.title.trim() ? part.title.trim().slice(0, 40) : `Part ${parts.length + 1}`,
        instruction: part.instruction.trim(),
        owns: parseOwns(part.owns),
      });
    }
    if (!ownershipIsDisjoint(parts.map((part) => part.owns), workspaceDir)) {
      return { plan: null, tokens, rejected: 'parts did not own non-empty, disjoint file sets' };
    }
    return {
      plan: {
        contract: typeof parsed.contract === 'string' ? parsed.contract.trim() : '',
        scaffold: typeof parsed.scaffold === 'string' && parsed.scaffold.trim() ? parsed.scaffold.trim() : null,
        parts,
      },
      tokens,
      rejected: null,
    };
  } catch {
    return { plan: null, tokens, rejected: null }; // splitting is an optimization — on any doubt, run as one worker
  }
}

// Master's read of a QA report: does it need a remediation round?
export async function evaluateQaReport(
  engine: OrchestratorEngine,
  qaSynopsis: string,
  model: ModelSpec = resolveModel('haiku'),
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
  model: ModelSpec = resolveModel(team.leadModel),
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
    const { text, tokens } = await engine.complete({ prompt, model });
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
