import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RESOLVED_HEADING, RULES_HEADING, TOOLS_HEADING } from '@agent-hq/shared';

// RULES.md files: one per team (data/teams/<id>/RULES.md) plus the master's
// (data/master/RULES.md). The owner writes them — desktop Teams page, /rule,
// or any editor; the hub only appends bullets into a section. Templates are
// written once and never overwritten.

export const RULES_FILE = 'RULES.md';

export function teamRulesTemplate(teamName: string): string {
  return [
    `# ${teamName} — rules`,
    '',
    '<!--',
    `Your standing rules for every ${teamName} worker, in every project.`,
    '- One rule per line, starting with "- ".',
    '- Group rules under any "## " heading you like (Code style, Git, Testing, Tone...).',
    '- "## Tools" lists the tools this team has and what each is for, e.g.',
    '  - magick (ImageMagick CLI): resize, convert and composite images',
    '  Workers use them for those jobs; every command still goes through the',
    '  normal permission checks. MCP connections are granted on the Teams page.',
    "- A project's own CLAUDE.md adds on top of these. When the two disagree,",
    '  Agent HQ asks you which one wins and records your answer under',
    '  "Resolved conflicts". Delete a line there to be asked again.',
    'Example:',
    '## Git',
    '- Never force-push.',
    '-->',
    '',
    `## ${RULES_HEADING}`,
    '',
    `## ${TOOLS_HEADING}`,
    '',
    `## ${RESOLVED_HEADING}`,
    '',
  ].join('\n');
}

// The first team template (before "## Tools"); an untouched copy of it is
// upgraded in place — anything the owner edited is left alone.
function legacyTeamTemplate(teamName: string): string {
  return [
    `# ${teamName} — rules`,
    '',
    '<!--',
    `Your standing rules for every ${teamName} worker, in every project.`,
    '- One rule per line, starting with "- ".',
    '- Group rules under any "## " heading you like (Code style, Git, Testing, Tone...).',
    "- A project's own CLAUDE.md adds on top of these. When the two disagree,",
    '  Agent HQ asks you which one wins and records your answer under',
    '  "Resolved conflicts". Delete a line there to be asked again.',
    'Example:',
    '## Git',
    '- Never force-push.',
    '-->',
    '',
    `## ${RULES_HEADING}`,
    '',
    `## ${RESOLVED_HEADING}`,
    '',
  ].join('\n');
}

export const MASTER_SECTIONS = {
  routing: 'Routing',
  handover: 'Handover',
  splitting: 'Splitting',
  stuck: 'When a task is stuck',
} as const;

export function masterRulesTemplate(): string {
  return [
    '# Master — rules',
    '',
    '<!--',
    'Your rules for the master: how it picks teams, hands work between them,',
    'splits big tasks, and what it does when a task gets stuck.',
    '- One rule per line, starting with "- ". Rules under "## Rules" apply to',
    '  every decision; the others only to their kind of decision.',
    '- A task is stuck when its run fails, when the lead says the worker',
    '  could not finish it, or when QA still fails after two fix rounds. The',
    '  master then proposes a retry, a handover or a split and ASKS you —',
    '  unless a rule under "When a task is stuck" lets it act on its own.',
    '- These never override the project rules: a task stays in the project',
    '  you named or the one your conversation is in.',
    'Examples:',
    '## Handover',
    '- Anything that needs Roblox Studio goes to the Game Engine team.',
    '## When a task is stuck',
    '- Retry once on the same team without asking; ask me after that.',
    '-->',
    '',
    `## ${RULES_HEADING}`,
    '',
    `## ${MASTER_SECTIONS.routing}`,
    '',
    `## ${MASTER_SECTIONS.handover}`,
    '',
    `## ${MASTER_SECTIONS.splitting}`,
    '',
    `## ${MASTER_SECTIONS.stuck}`,
    '',
  ].join('\n');
}

export function readRulesFile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

// mtime+size, so a watcher spots hand edits without reading the file.
export function rulesFileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

export function writeRulesFile(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown.endsWith('\n') ? markdown : markdown + '\n');
}

// Writes the template when the file is missing, or upgrades an untouched
// legacy template. Never touches a file the owner has edited.
export function ensureRulesFile(path: string, template: string, legacy?: string): void {
  const current = readRulesFile(path);
  if (!existsSync(path) || (legacy !== undefined && current === legacy)) writeRulesFile(path, template);
}

export function ensureTeamRules(path: string, teamName: string): void {
  ensureRulesFile(path, teamRulesTemplate(teamName), legacyTeamTemplate(teamName));
}

// "## " headings outside the guidance comment, with their line numbers.
function headings(lines: string[]): { name: string; index: number }[] {
  const found: { name: string; index: number }[] = [];
  let inComment = false;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      return;
    }
    if (line.startsWith('<!--')) {
      inComment = !line.includes('-->');
      return;
    }
    const match = /^#{2,6}\s+(.+)$/.exec(line);
    if (match) found.push({ name: match[1]!.trim(), index });
  });
  return found;
}

// The heading a short section word names: an exact match, else the first
// heading containing it ("stuck" -> "When a task is stuck"), else the word
// itself as a new heading.
export function resolveSection(markdown: string, word: string): string {
  const key = word.trim().toLowerCase();
  const names = headings(markdown.split(/\r?\n/)).map((heading) => heading.name);
  return (
    names.find((name) => name.toLowerCase() === key) ??
    names.find((name) => name.toLowerCase().includes(key)) ??
    word.trim().replace(/^\w/, (first) => first.toUpperCase())
  );
}

// Appends a bullet at the end of a section (created before Resolved
// conflicts when missing). Everything else in the file is kept verbatim.
export function appendToSection(path: string, heading: string, bullet: string): void {
  const lines = readRulesFile(path).replace(/\s+$/, '').split(/\r?\n/);
  const target = heading.toLowerCase();
  const found = headings(lines);
  const start = found.find((entry) => entry.name.toLowerCase() === target)?.index ?? -1;
  const resolvedAt = found.find((entry) => entry.name.toLowerCase() === RESOLVED_HEADING.toLowerCase())?.index ?? -1;
  const entry = `- ${bullet.replace(/\s+/g, ' ').trim()}`;
  if (start < 0) {
    const at = resolvedAt >= 0 && target !== RESOLVED_HEADING.toLowerCase() ? resolvedAt : lines.length;
    lines.splice(at, 0, ...(at > 0 && lines[at - 1]?.trim() ? [''] : []), `## ${heading}`, entry, '');
  } else {
    let end = start + 1;
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end]!.trim())) end++;
    let insertAt = end;
    while (insertAt > start + 1 && !lines[insertAt - 1]!.trim()) insertAt--;
    lines.splice(insertAt, 0, entry);
    if (insertAt === start + 1 && lines[start + 2]?.trim()) lines.splice(start + 2, 0, '');
  }
  writeRulesFile(path, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
}
