import { resolve as resolvePath } from 'node:path';
import { realPath, writableBy, type LockedDir } from '../orchestrator/util.js';

// What every worker is told about its role, whichever engine runs it
// (Claude: appended to the system prompt; Codex: developer instructions).
export const DEFAULT_MAX_SUBAGENTS = 3;

export function workerInstructions(charter: string, maxSubagents: number): string {
  return (
    `You are a worker agent on a team with this charter: ${charter}. Stay within that charter for HOW you work. ` +
    'A task the master routed to your team is always in scope, whatever its topic — including personal or everyday requests from the owner. ' +
    'Never refuse a task over its topic; if it seems like a mismatch for your team, do it anyway and note the mismatch in your report.' +
    (maxSubagents > 0
      ? ' Only when your task has substantial independent pieces (separate modules, separate searches or investigations), ' +
        `run them concurrently in parallel subagents — at most ${maxSubagents} at a time, and none for small or sequential work — ` +
        'then integrate and verify their results yourself. Subagents never spawn subagents of their own.'
      : ' Do not use sub-agents for this task.')
  );
}

// The path a file write would refuse to touch, or null. realPath on both
// sides (inside writableBy): a junction planted in the workspace must not
// read as "inside" while pointing at a sibling project. `config` = inside
// the roots but Agent HQ's own data (the locked dir).
export function refusedWrite(
  input: Record<string, unknown>,
  cwd: string,
  extraDirs: string[],
  locked?: LockedDir,
): { path: string; config: boolean } | null {
  const target = input['file_path'] ?? input['notebook_path'];
  if (typeof target !== 'string' || !target.trim()) return null;
  const full = realPath(resolvePath(cwd, target));
  if (writableBy(full, [cwd, ...extraDirs], locked)) return null;
  return { path: full, config: writableBy(full, [cwd, ...extraDirs]) };
}

// The refusal message a worker gets back, either engine.
export function refusalMessage(refused: { path: string; config: boolean }, cwd: string): string {
  return refused.config
    ? `Refused: ${refused.path} is Agent HQ's own configuration (rules, keys, settings), which agents never edit. ` +
        'If it needs changing, say so in your report and the owner will change it.'
    : `Refused: ${refused.path} is outside this task's project workspace (${cwd}). ` +
        'Work only inside your own workspace; if the task needs another folder, say so in your report and ask the owner to register it as a project.';
}
