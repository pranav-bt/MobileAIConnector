import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESOLVED_HEADING, RULES_HEADING, parseRules, type ParsedRules, type Team } from '@agent-hq/shared';

export { parseRules, type ParsedRules };

// Teams are config records, persisted as data/teams.json. Creating a team is
// inserting a record here — the office UI adds the room on the team.updated
// event, nothing else needs to change.

// RULES.md — the owner's standing rules for one team, in every project. The
// owner writes it (desktop Teams page, /rule, or any editor); the hub only
// appends: /rule lines into "## Rules" and conflict answers into
// "## Resolved conflicts". A project's CLAUDE.md adds on top of it.
export const RULES_FILE = 'RULES.md';

function rulesTemplate(teamName: string): string {
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


const DEFAULT_TEAMS: Omit<Team, 'createdAt' | 'memoryDir' | 'mcpServers'>[] = [
  {
    id: 'coding',
    name: 'Coding team',
    charter: 'Builds, tests, and refactors code. Owns repositories, CI, and technical implementation.',
    allowedTools: ['read', 'edit', 'bash', 'git'],
    blockedTools: [],
    leadModel: 'opus',
    workerModel: 'sonnet',
    maxConcurrentWorkers: 2,
    quotaSharePct: 40,
  },
  {
    id: 'design',
    name: 'Design team',
    charter: 'Produces design details, mockups, visual and UX direction, and reviews interfaces. Does not edit application code.',
    allowedTools: ['read', 'browser', 'docs'],
    blockedTools: ['git', 'installs'],
    leadModel: 'opus',
    workerModel: 'sonnet',
    maxConcurrentWorkers: 2,
    quotaSharePct: 25,
  },
  {
    id: 'tools',
    name: 'Tools team',
    charter: 'Handles installs, environment setup, scripts, and system-level chores. The most gated toolset.',
    allowedTools: ['read', 'bash', 'installs'],
    blockedTools: [],
    leadModel: 'opus',
    workerModel: 'haiku',
    maxConcurrentWorkers: 1,
    quotaSharePct: 15,
  },
];

export class TeamRegistry {
  #filePath: string;
  #teamsDir: string;
  #teams = new Map<string, Team>();

  constructor(dataDir: string) {
    this.#filePath = join(dataDir, 'teams.json');
    this.#teamsDir = join(dataDir, 'teams');
    mkdirSync(this.#teamsDir, { recursive: true });
  }

  init(): void {
    if (existsSync(this.#filePath)) {
      const stored = JSON.parse(readFileSync(this.#filePath, 'utf8')) as Team[];
      // Records written before mcpServers existed get the empty default.
      for (const team of stored) this.#teams.set(team.id, { ...team, mcpServers: team.mcpServers ?? {} });
    } else {
      for (const base of DEFAULT_TEAMS) {
        this.#teams.set(base.id, {
          ...base,
          mcpServers: {},
          memoryDir: join(this.#teamsDir, base.id),
          createdAt: Date.now(),
        });
      }
      this.#save();
    }
    for (const team of this.#teams.values()) this.#ensureMemoryDir(team);
  }

  #ensureMemoryDir(team: Team): void {
    mkdirSync(team.memoryDir, { recursive: true });
    const charterPath = join(team.memoryDir, 'charter.md');
    if (!existsSync(charterPath)) {
      writeFileSync(charterPath, `# ${team.name}\n\n${team.charter}\n`);
    }
    // Never overwrite: RULES.md belongs to the owner once it exists.
    const rulesPath = join(team.memoryDir, RULES_FILE);
    if (!existsSync(rulesPath)) writeFileSync(rulesPath, rulesTemplate(team.name));
  }

  rulesPath(teamId: string): string | null {
    const team = this.#teams.get(teamId);
    return team ? join(team.memoryDir, RULES_FILE) : null;
  }

  readRules(teamId: string): string {
    const path = this.rulesPath(teamId);
    if (!path || !existsSync(path)) return '';
    return readFileSync(path, 'utf8');
  }

  // mtime+size, so the watcher spots hand edits without reading the file.
  rulesStamp(teamId: string): string {
    const path = this.rulesPath(teamId);
    if (!path || !existsSync(path)) return '';
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  }

  setRules(teamId: string, markdown: string): boolean {
    const path = this.rulesPath(teamId);
    if (!path) return false;
    writeFileSync(path, markdown.endsWith('\n') ? markdown : markdown + '\n');
    return true;
  }

  // Appends a bullet at the end of a section (created before Resolved
  // conflicts when missing). Everything else in the file is kept verbatim.
  #appendToSection(teamId: string, heading: string, bullet: string): boolean {
    const team = this.#teams.get(teamId);
    if (!team) return false;
    this.#ensureMemoryDir(team);
    const lines = this.readRules(teamId).replace(/\s+$/, '').split(/\r?\n/);
    const target = heading.toLowerCase();
    let inComment = false; // headings inside the guidance comment don't count
    let start = -1;
    let resolvedAt = -1;
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
      if (!match) return;
      const name = match[1]!.trim().toLowerCase();
      if (name === target && start < 0) start = index;
      if (name === RESOLVED_HEADING.toLowerCase() && resolvedAt < 0) resolvedAt = index;
    });
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
    this.setRules(teamId, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
    return true;
  }

  addRule(teamId: string, rule: string): boolean {
    const text = rule.trim().replace(/^[-*]\s+/, '');
    return text.length > 0 && this.#appendToSection(teamId, RULES_HEADING, text);
  }

  recordResolution(teamId: string, line: string): boolean {
    return this.#appendToSection(teamId, RESOLVED_HEADING, line);
  }

  // The record as clients see it: config + the owner's rules file.
  withRules(team: Team): Team {
    return { ...team, rules: this.readRules(team.id) };
  }

  #save(): void {
    // Rules live in RULES.md, never in teams.json.
    const records = [...this.#teams.values()].map(({ rules: _rules, ...team }) => team);
    writeFileSync(this.#filePath, JSON.stringify(records, null, 2));
  }

  all(): Team[] {
    return [...this.#teams.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Team | undefined {
    return this.#teams.get(id);
  }

  update(input: {
    teamId: string;
    maxConcurrentWorkers?: number;
    workerModel?: Team['workerModel'];
    quotaSharePct?: number;
    charter?: string;
    mcpServers?: Record<string, unknown>;
  }): Team | null {
    const current = this.#teams.get(input.teamId);
    if (!current) return null;
    const team: Team = {
      ...current,
      maxConcurrentWorkers: input.maxConcurrentWorkers ?? current.maxConcurrentWorkers,
      workerModel: input.workerModel ?? current.workerModel,
      quotaSharePct: input.quotaSharePct ?? current.quotaSharePct,
      charter: input.charter ?? current.charter,
      mcpServers: input.mcpServers ?? current.mcpServers ?? {},
    };
    this.#teams.set(team.id, team);
    this.#save();
    return team;
  }

  remove(teamId: string): boolean {
    const removed = this.#teams.delete(teamId);
    if (removed) this.#save();
    return removed;
  }

  // Durable lessons per team, appended by leads after reviews.
  appendMemory(teamId: string, note: string): void {
    const team = this.#teams.get(teamId);
    if (!team) return;
    const memoryPath = join(team.memoryDir, 'MEMORY.md');
    const existing = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : `# ${team.name} — notes\n`;
    const lines = existing.split('\n').filter((line) => line.trim().length > 0);
    lines.push(`- ${new Date().toISOString().slice(0, 10)}: ${note.replace(/\s+/g, ' ').trim().slice(0, 240)}`);
    // Header + the most recent 40 notes.
    const header = lines[0]?.startsWith('#') ? [lines[0]] : [`# ${team.name} — notes`];
    const notes = lines.filter((line) => line.startsWith('- ')).slice(-40);
    writeFileSync(memoryPath, [...header, ...notes].join('\n') + '\n');
  }

  readMemory(teamId: string): string {
    const team = this.#teams.get(teamId);
    if (!team) return '';
    const memoryPath = join(team.memoryDir, 'MEMORY.md');
    if (!existsSync(memoryPath)) return '';
    return readFileSync(memoryPath, 'utf8').slice(0, 1500);
  }

  add(input: {
    name: string;
    charter: string;
    allowedTools: string[];
    blockedTools: string[];
    workerModel?: Team['workerModel'];
    quotaSharePct?: number;
    mcpServers?: Record<string, unknown>;
  }): Team {
    const id =
      input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `team-${Date.now()}`;
    const team: Team = {
      id,
      name: input.name,
      charter: input.charter,
      allowedTools: input.allowedTools,
      blockedTools: input.blockedTools,
      leadModel: 'opus',
      workerModel: input.workerModel ?? 'sonnet',
      maxConcurrentWorkers: 2,
      quotaSharePct: input.quotaSharePct ?? 10,
      memoryDir: join(this.#teamsDir, id),
      mcpServers: input.mcpServers ?? {},
      createdAt: Date.now(),
    };
    this.#teams.set(id, team);
    this.#ensureMemoryDir(team);
    this.#save();
    return team;
  }
}
