import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Team } from '@agent-hq/shared';

// Teams are config records, persisted as data/teams.json. Creating a team is
// inserting a record here — the office UI adds the room on the team.updated
// event, nothing else needs to change.

const DEFAULT_TEAMS: Omit<Team, 'createdAt' | 'memoryDir'>[] = [
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
      for (const team of stored) this.#teams.set(team.id, team);
    } else {
      for (const base of DEFAULT_TEAMS) {
        this.#teams.set(base.id, { ...base, memoryDir: join(this.#teamsDir, base.id), createdAt: Date.now() });
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
  }

  #save(): void {
    writeFileSync(this.#filePath, JSON.stringify([...this.#teams.values()], null, 2));
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
  }): Team | null {
    const current = this.#teams.get(input.teamId);
    if (!current) return null;
    const team: Team = {
      ...current,
      maxConcurrentWorkers: input.maxConcurrentWorkers ?? current.maxConcurrentWorkers,
      workerModel: input.workerModel ?? current.workerModel,
      quotaSharePct: input.quotaSharePct ?? current.quotaSharePct,
      charter: input.charter ?? current.charter,
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
      createdAt: Date.now(),
    };
    this.#teams.set(id, team);
    this.#ensureMemoryDir(team);
    this.#save();
    return team;
  }
}
