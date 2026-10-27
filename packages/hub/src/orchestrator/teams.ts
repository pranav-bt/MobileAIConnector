import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESOLVED_HEADING, RULES_HEADING, parseRules, type ParsedRules, type Team } from '@agent-hq/shared';
import {
  RULES_FILE,
  appendToSection,
  ensureRulesFile,
  ensureTeamRules,
  masterRulesTemplate,
  legacyMasterTemplates,
  hasSection,
  MASTER_SECTIONS,
  DEFAULT_QA_RULE,
  readRulesFile,
  resolveSection,
  rulesFileStamp,
  writeRulesFile,
} from './rules-file.js';

export { parseRules, type ParsedRules };

// Team notes: dated bullets kept in MEMORY.md, and how much of them goes into
// a worker's brief (~1.5k tokens).
const NOTES_KEPT = 60;
const NOTES_BRIEF_CHARS = 6000;
const NOTE_MAX_CHARS = 400;
const isNote = (line: string) => /^\s*[-*]\s/.test(line);
const noteKey = (text: string) =>
  text
    .replace(/^\s*[-*]\s+(\d{4}-\d\d-\d\d:\s*)?/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

// One line, capped at a word, with anything key-like (a long run mixing
// letters AND digits) blanked out — notes reach every later worker on the team.
export function cleanNote(note: string): string {
  let text = note
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/[A-Za-z0-9_-]{32,}/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? '[redacted]' : run));
  if (text.length > NOTE_MAX_CHARS) text = `${text.slice(0, NOTE_MAX_CHARS).replace(/\s+\S*$/, '')}…`;
  return text.length >= 12 ? text : '';
}

// The same lesson again: equal, or one holds the other (letters and digits only).
function sameNote(line: string, note: string): boolean {
  const a = noteKey(line);
  const b = noteKey(note);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 40 && (a.includes(b) || b.includes(a)));
}

// Teams are config records, persisted as data/teams.json. Creating a team is
// inserting a record here — the office UI adds the room on the team.updated
// event, nothing else needs to change. Each team also has the owner's
// RULES.md (rules, tools, resolved conflicts) next to its MEMORY.md; the
// master's own RULES.md lives in data/master/.

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
  #masterRulesPath: string;
  #teams = new Map<string, Team>();
  readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.#filePath = join(dataDir, 'teams.json');
    this.#teamsDir = join(dataDir, 'teams');
    this.#masterRulesPath = join(dataDir, 'master', RULES_FILE);
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
    ensureRulesFile(this.#masterRulesPath, masterRulesTemplate(), legacyMasterTemplates());
    // QA by default for the Coding team only: an older rules file without a
    // "## QA" section gets one (an empty section the owner keeps = no QA).
    if (!hasSection(this.#masterRulesPath, MASTER_SECTIONS.qa)) appendToSection(this.#masterRulesPath, MASTER_SECTIONS.qa, DEFAULT_QA_RULE);
  }

  #ensureMemoryDir(team: Team): void {
    mkdirSync(team.memoryDir, { recursive: true });
    const charterPath = join(team.memoryDir, 'charter.md');
    if (!existsSync(charterPath)) {
      writeFileSync(charterPath, `# ${team.name}\n\n${team.charter}\n`);
    }
    // Never overwrite: RULES.md belongs to the owner once it exists.
    ensureTeamRules(join(team.memoryDir, RULES_FILE), team.name);
  }

  // "master" names the master's own rules file; anything else is a team id.
  rulesPath(teamId: string): string | null {
    if (teamId === 'master') return this.#masterRulesPath;
    const team = this.#teams.get(teamId);
    return team ? join(team.memoryDir, RULES_FILE) : null;
  }

  readRules(teamId: string): string {
    const path = this.rulesPath(teamId);
    return path ? readRulesFile(path) : '';
  }

  // Changes when the record clients see changes: RULES.md, and a team's notes.
  recordStamp(teamId: string): string {
    const path = this.rulesPath(teamId);
    if (!path) return '';
    const team = this.#teams.get(teamId);
    return team ? `${rulesFileStamp(path)}|${rulesFileStamp(this.#notesPath(team))}` : rulesFileStamp(path);
  }

  setRules(teamId: string, markdown: string): boolean {
    const path = this.rulesPath(teamId);
    if (!path) return false;
    writeRulesFile(path, markdown);
    return true;
  }

  // One bullet into a section ("tools", "stuck", … — matched against the
  // file's headings; default "## Rules").
  addRule(teamId: string, rule: string, section?: string): boolean {
    const path = this.rulesPath(teamId);
    const text = rule.trim().replace(/^[-*]\s+/, '');
    if (!path || !text) return false;
    const team = this.#teams.get(teamId);
    if (team) this.#ensureMemoryDir(team);
    else ensureRulesFile(path, masterRulesTemplate(), legacyMasterTemplates());
    appendToSection(path, section ? resolveSection(readRulesFile(path), section) : RULES_HEADING, text);
    return true;
  }

  recordResolution(teamId: string, line: string): boolean {
    const path = this.rulesPath(teamId);
    if (!path) return false;
    appendToSection(path, RESOLVED_HEADING, line);
    return true;
  }

  // The record as clients see it: config + the owner's rules file + the
  // team's notes.
  withRules(team: Team): Team {
    return { ...team, rules: this.readRules(team.id), notes: this.readNotes(team.id) };
  }

  #save(): void {
    // Rules and notes live in their files, never in teams.json.
    const records = [...this.#teams.values()].map(({ rules: _rules, notes: _notes, ...team }) => team);
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

  #notesPath(team: Team): string {
    return join(team.memoryDir, 'MEMORY.md');
  }

  // Team notes (MEMORY.md): lessons workers wrote down (their LEARNED lines)
  // or the lead took from a report. The owner reads and edits the same file.
  readNotes(teamId: string): string {
    const team = this.#teams.get(teamId);
    if (!team) return '';
    const path = this.#notesPath(team);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  setNotes(teamId: string, markdown: string): boolean {
    const team = this.#teams.get(teamId);
    if (!team) return false;
    mkdirSync(team.memoryDir, { recursive: true });
    writeFileSync(this.#notesPath(team), markdown.replace(/\r\n/g, '\n').trimEnd() + '\n');
    return true;
  }

  // One lesson, dated, at the end of the notes. Returns the note as saved,
  // or null when the team already has it (or there's nothing to save). Past
  // NOTES_KEPT the oldest dated bullets go; anything else the owner wrote stays.
  appendMemory(teamId: string, note: string): string | null {
    const team = this.#teams.get(teamId);
    const clean = cleanNote(note);
    if (!team || !clean) return null;
    const existing = this.readNotes(teamId) || `# ${team.name} — notes`;
    const lines = existing.replace(/\r\n/g, '\n').trimEnd().split('\n');
    if (lines.some((line) => isNote(line) && sameNote(line, clean))) return null;
    lines.push(`- ${new Date().toISOString().slice(0, 10)}: ${clean}`);
    let excess = lines.filter(isNote).length - NOTES_KEPT;
    const kept = lines.filter((line) => !(/^- \d{4}-\d\d-\d\d: /.test(line) && excess-- > 0));
    this.setNotes(teamId, kept.join('\n'));
    return clean;
  }

  // What a worker's brief carries: the owner's own lines, then the newest
  // notes that fit NOTES_BRIEF_CHARS (kept in file order), so the brief stays
  // the same size however long the notes grow.
  readMemory(teamId: string): string {
    const lines = this.readNotes(teamId)
      .replace(/<!--[\s\S]*?-->/g, '')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'));
    let budget = NOTES_BRIEF_CHARS;
    const fits = (line: string) => (line.length < budget ? ((budget -= line.length + 1), true) : false);
    const prose = lines.filter((line) => !isNote(line)).filter(fits);
    const notes = lines.filter(isNote).reverse().filter(fits).reverse();
    return [...prose, ...notes].join('\n');
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
