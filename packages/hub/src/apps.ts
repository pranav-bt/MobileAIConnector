import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App, AppSuggestion, ClientCommand } from '@agent-hq/shared';
import { isInside } from './orchestrator/util.js';

// Desktop apps the owner added in Settings > Apps (data/apps.json). Each is a
// connection teams can be granted like an MCP server: the grant runs Agent
// HQ's app bridge (apps/app-bridge.mjs), which reads the app's record from
// this file when it starts — so editing an app never needs a re-grant, and
// workers (who can't write the data dir) can't repoint one.

export const APP_BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'app-bridge.mjs');

type AddApp = Extract<ClientCommand, { type: 'app.add' }>;
type UpdateApp = Extract<ClientCommand, { type: 'app.update' }>;

// A grant's config that runs the bridge (any copy of Agent HQ's).
export function isAppBridge(config: unknown): boolean {
  const args = (config as { args?: unknown } | null)?.args;
  return Array.isArray(args) && typeof args[0] === 'string' && /app-bridge\.mjs$/i.test(args[0]);
}

export const appKind = (exePath: string): App['kind'] => (/^blender(\.exe)?$/i.test(basename(exePath)) ? 'blender' : 'generic');

// Blender installs on this PC, newest first: the Blender Foundation folders,
// Steam's copy, and the usual places elsewhere.
export function detectBlender(): string[] {
  const found: string[] = [];
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles'] ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)']) {
      const foundation = join(base, 'Blender Foundation');
      let versions: string[] = [];
      try {
        versions = readdirSync(foundation);
      } catch {
        continue;
      }
      const byVersion = (name: string) => (name.match(/\d+/g) ?? []).map(Number);
      versions.sort((a, b) => {
        const [x, y] = [byVersion(a), byVersion(b)];
        for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
        return 0;
      });
      for (const version of versions) found.push(join(foundation, version, 'blender.exe'));
    }
    found.push(join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe'));
  } else {
    found.push('/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  }
  return found.filter((path) => existsSync(path));
}

export class AppRegistry {
  readonly filePath: string;
  #apps: App[] = [];
  #dataDir: string;
  #detect: () => string[];
  // Install scans are cached: hub info is rebuilt on every settings change.
  #detected: { at: number; paths: string[] } | null = null;

  constructor(dataDir: string, detect: () => string[] = detectBlender) {
    this.#dataDir = dataDir;
    this.filePath = join(dataDir, 'apps.json');
    this.#detect = detect;
    try {
      const stored = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(stored)) this.#apps = stored as App[];
    } catch {
      // no apps yet
    }
  }

  list(): App[] {
    return this.#apps;
  }

  get(id: string): App | undefined {
    return this.#apps.find((app) => app.id === id);
  }

  // By id or name (case-insensitive) — commands and /team speak names.
  find(ref: string): App | undefined {
    const wanted = ref.trim().toLowerCase();
    return this.#apps.find((app) => app.id === wanted || app.name.toLowerCase() === wanted);
  }

  // Detected installs not added yet.
  suggestions(): AppSuggestion[] {
    const added = new Set(this.#apps.map((app) => resolve(app.exePath).toLowerCase()));
    if (!this.#detected || Date.now() - this.#detected.at > 60_000) this.#detected = { at: Date.now(), paths: this.#detect() };
    return this.#detected.paths
      .filter((path) => !added.has(resolve(path).toLowerCase()))
      .map((exePath) => ({ name: blenderName(exePath), exePath, kind: appKind(exePath) }));
  }

  // The MCP config a grant runs: the bridge, told which app and where the
  // records live. Keyed by app id — the connection name.
  catalog(): Record<string, unknown> {
    return Object.fromEntries(this.#apps.map((app) => [app.id, this.serverConfig(app.id)]));
  }

  serverConfig(id: string, readOnly = false): Record<string, unknown> {
    return {
      type: 'stdio',
      command: process.execPath,
      args: [APP_BRIDGE, '--app', id, '--apps-file', this.filePath, ...(readOnly ? ['--read-only'] : [])],
    };
  }

  // Throws a plain-English reason when the app can't be added as asked.
  add(command: Omit<AddApp, 'type'>, taken: (id: string) => boolean): App {
    const exePath = this.#checkExe(command.exePath);
    const name = command.name.trim();
    if (!name) throw new Error('give the app a name');
    if (this.#apps.some((app) => app.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already an app called ${name}`);
    // Blender's tools read mcp__blender__… whatever the version in its name.
    const base = appKind(exePath) === 'blender' ? 'blender' : slug(name) || 'app';
    let id = base;
    for (let n = 2; this.get(id) || taken(id); n++) id = `${base}-${n}`;
    const app: App = {
      id,
      name,
      exePath,
      args: command.args ?? [],
      kind: appKind(exePath),
      visible: command.visible ?? true,
      idleMinutes: command.idleMinutes ?? 10,
      notes: command.notes?.trim() ?? '',
      createdAt: Date.now(),
    };
    this.#apps = [...this.#apps, app];
    this.#save();
    return app;
  }

  update(command: Omit<UpdateApp, 'type'>): App {
    const current = this.find(command.appId);
    if (!current) throw new Error(`no app called "${command.appId}"`);
    const name = command.name?.trim() ?? current.name;
    if (this.#apps.some((app) => app.id !== current.id && app.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already an app called ${name}`);
    const exePath = command.exePath !== undefined ? this.#checkExe(command.exePath) : current.exePath;
    const updated: App = {
      ...current,
      name,
      exePath,
      kind: appKind(exePath),
      ...(command.args !== undefined ? { args: command.args } : {}),
      ...(command.visible !== undefined ? { visible: command.visible } : {}),
      ...(command.idleMinutes !== undefined ? { idleMinutes: command.idleMinutes } : {}),
      ...(command.notes !== undefined ? { notes: command.notes.trim() } : {}),
    };
    this.#apps = this.#apps.map((app) => (app.id === current.id ? updated : app));
    this.#save();
    return updated;
  }

  remove(ref: string): App | null {
    const app = this.find(ref);
    if (!app) return null;
    this.#apps = this.#apps.filter((other) => other.id !== app.id);
    this.#save();
    return app;
  }

  #checkExe(raw: string): string {
    const path = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(path)) throw new Error(`use the program's full path (${path} is relative)`);
    const exePath = resolve(path);
    let file = false;
    try {
      file = statSync(exePath).isFile();
    } catch {
      throw new Error(`nothing at ${exePath}`);
    }
    if (!file) throw new Error(`${exePath} is a folder — pick the program file`);
    // Node can't start .bat/.cmd without a shell; an app is a real program.
    if (process.platform === 'win32' && !['.exe', '.com'].includes(extname(exePath).toLowerCase())) {
      throw new Error(`${basename(exePath)} isn't a program (.exe)`);
    }
    if (isInside(exePath, this.#dataDir)) throw new Error("an app can't live in Agent HQ's own data folder");
    return exePath;
  }

  #save(): void {
    writeFileSync(this.filePath, `${JSON.stringify(this.#apps, null, 2)}\n`);
  }
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

// "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" → "Blender 5.2"
function blenderName(exePath: string): string {
  const folder = basename(dirname(exePath));
  return /^blender\b/i.test(folder) && /\d/.test(folder) ? folder : 'Blender';
}
