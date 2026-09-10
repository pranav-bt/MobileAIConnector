import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Project } from '@agent-hq/shared';

// Projects are config records (data/projects.json): a workspace directory a
// worker runs inside plus a token ledger. The hub's own workspace is always
// registered as the default project, so single-project use needs no setup.

const DEFAULT_QUOTA_TOKENS = 5_000_000;

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export class ProjectRegistry {
  #filePath: string;
  #projects = new Map<string, Project>();
  #defaultId = '';

  constructor(dataDir: string) {
    this.#filePath = join(dataDir, 'projects.json');
  }

  init(defaultWorkspaceDir: string): void {
    if (existsSync(this.#filePath)) {
      const stored = JSON.parse(readFileSync(this.#filePath, 'utf8')) as Project[];
      for (const project of stored) this.#projects.set(project.id, project);
    }
    // The hub's workspace is always a project; re-register if missing.
    const existing = [...this.#projects.values()].find((project) => project.workspaceDir === defaultWorkspaceDir);
    if (existing) {
      this.#defaultId = existing.id;
    } else {
      const name = basename(defaultWorkspaceDir) || 'workspace';
      const project = this.#build({ name, workspaceDir: defaultWorkspaceDir, description: 'Default project — the hub\'s own workspace.' });
      this.#projects.set(project.id, project);
      this.#defaultId = project.id;
      this.#save();
    }
  }

  #build(input: { name: string; workspaceDir: string; description?: string; quotaTokens?: number }): Project {
    let id = slugify(input.name) || `project-${Date.now()}`;
    while (this.#projects.has(id)) id = `${id}-2`;
    return {
      id,
      name: input.name,
      description: input.description ?? '',
      workspaceDir: input.workspaceDir,
      quotaTokens: input.quotaTokens ?? DEFAULT_QUOTA_TOKENS,
      usedTokens: 0,
      alerted75: false,
    };
  }

  #save(): void {
    writeFileSync(this.#filePath, JSON.stringify([...this.#projects.values()], null, 2));
  }

  all(): Project[] {
    return [...this.#projects.values()];
  }

  get(id: string): Project | undefined {
    return this.#projects.get(id);
  }

  // Accepts an id, a name, or a slug of the name (what "@beatbox" resolves).
  find(ref: string): Project | undefined {
    const needle = slugify(ref);
    return (
      this.#projects.get(ref) ??
      this.#projects.get(needle) ??
      [...this.#projects.values()].find((project) => slugify(project.name) === needle)
    );
  }

  defaultProject(): Project {
    const project = this.#projects.get(this.#defaultId) ?? [...this.#projects.values()][0];
    if (!project) throw new Error('project registry is empty');
    return project;
  }

  register(input: { name: string; workspaceDir: string; description?: string; quotaTokens?: number }): Project {
    mkdirSync(input.workspaceDir, { recursive: true });
    const project = this.#build(input);
    this.#projects.set(project.id, project);
    this.#save();
    return project;
  }

  remove(id: string): boolean {
    if (id === this.#defaultId) return false; // the hub workspace stays
    const removed = this.#projects.delete(id);
    if (removed) this.#save();
    return removed;
  }

  // Returns the updated project, plus whether it just crossed 75% of quota.
  addTokens(id: string, tokens: number): { project: Project; crossed75: boolean } | null {
    const current = this.#projects.get(id);
    if (!current || tokens <= 0) return null;
    const usedTokens = current.usedTokens + tokens;
    const crossed75 = !current.alerted75 && usedTokens >= current.quotaTokens * 0.75;
    const project: Project = { ...current, usedTokens, alerted75: current.alerted75 || crossed75 };
    this.#projects.set(id, project);
    this.#save();
    return { project, crossed75 };
  }
}
