import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { Project, WorkspaceRoot } from '@agent-hq/shared';

// A folder under the workspace roots that could be registered as a project.
export interface ProjectFolder {
  name: string;
  path: string;
  mtimeMs: number;
}

// What makes a folder a project rather than a folder of projects.
const PROJECT_MARKER =
  /^(\.git|\.claude|CLAUDE\.md|README(\.md)?|package\.json|requirements\.txt|default\.project\.json|Cargo\.toml|pyproject\.toml|go\.mod|.+\.sln|.+\.rbxlx?|src)$/i;
const SKIP_FOLDER = /^(\.|node_modules$|venv$|backups?$|temp$|tmp$|libraries$)/i;

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
  #roots: WorkspaceRoot[];
  #folderCache: { at: number; folders: ProjectFolder[] } | null = null;

  constructor(dataDir: string, workspaceRoots: WorkspaceRoot[]) {
    this.#filePath = join(dataDir, 'projects.json');
    this.#roots = workspaceRoots;
  }

  get roots(): WorkspaceRoot[] {
    return this.#roots;
  }

  // Windows-friendly containment check: the dir must sit inside one of the
  // configured roots. Only user registrations are checked; the hub's own
  // workspace (the default project) is exempt.
  isAllowed(dir: string): boolean {
    if (this.#roots.length === 0) return true;
    const resolved = resolve(dir).toLowerCase();
    return this.#roots.some((root) => {
      const rootResolved = resolve(root.path).toLowerCase();
      return resolved === rootResolved || resolved.startsWith(rootResolved + sep);
    });
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

  // Project folders under the workspace roots that aren't registered yet
  // (e.g. D:\Work\Roblox\PancakeStack) — offered when the master has to ask
  // which project an ask is for; picking one registers it. A folder with
  // project markers is a project; one without is a container (D:\Work\Roblox)
  // and is looked into once. Bounded (readdir budget, newest first, 30 max)
  // and cached for a minute: routing calls this on every ask.
  discoverFolders(): ProjectFolder[] {
    if (this.#folderCache && Date.now() - this.#folderCache.at < 60_000) return this.#folderCache.folders;
    const registered = new Set([...this.#projects.values()].map((project) => resolve(project.workspaceDir).toLowerCase()));
    const found: ProjectFolder[] = [];
    let budget = 80; // readdir calls per scan
    const list = (dir: string): Dirent[] => {
      if (budget-- <= 0) return [];
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    };
    const usable = (entry: Dirent) => entry.isDirectory() && !SKIP_FOLDER.test(entry.name);
    const add = (path: string, name: string) => {
      if (registered.has(resolve(path).toLowerCase())) return;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        return;
      }
      found.push({ name, path, mtimeMs });
    };
    for (const root of this.#roots) {
      for (const entry of list(root.path).filter(usable)) {
        const path = join(root.path, entry.name);
        const inside = list(path);
        const subfolders = inside.filter(usable);
        // A container (D:\Work\Roblox): no project markers and several
        // sub-folders — those are the projects. Anything else is a project
        // itself, code or not (a trip folder of documents counts).
        if (inside.some((child) => PROJECT_MARKER.test(child.name)) || subfolders.length < 3) {
          add(path, entry.name);
          continue;
        }
        for (const child of subfolders) add(join(path, child.name), child.name);
      }
    }
    const folders = found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 30);
    this.#folderCache = { at: Date.now(), folders };
    return folders;
  }

  defaultProject(): Project {
    const project = this.#projects.get(this.#defaultId) ?? [...this.#projects.values()][0];
    if (!project) throw new Error('project registry is empty');
    return project;
  }

  register(input: { name: string; workspaceDir: string; description?: string; quotaTokens?: number }): Project {
    if (!this.isAllowed(input.workspaceDir)) {
      const allowed = this.#roots.map((root) => `${root.path} (${root.label})`).join(' · ');
      throw new Error(`refused: "${input.workspaceDir}" is outside the allowed workspace roots — ${allowed}`);
    }
    mkdirSync(input.workspaceDir, { recursive: true });
    const project = this.#build(input);
    this.#projects.set(project.id, project);
    this.#save();
    this.#folderCache = null;
    return project;
  }

  remove(id: string): boolean {
    if (id === this.#defaultId) return false; // the hub workspace stays
    const removed = this.#projects.delete(id);
    if (removed) this.#save();
    this.#folderCache = null;
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
