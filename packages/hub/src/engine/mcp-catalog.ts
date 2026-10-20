import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The MCP servers configured for Claude Code on this PC (~/.claude.json:
// user scope first, then any project's) — the catalog a team's connections
// are granted from, by name. Workers never inherit the user-scope ones on
// their own (strictMcpConfig); a team gets exactly the ones granted to it,
// plus the servers set up for the project folder it works in
// (projectMcpServers), as Claude Code opened in that folder would load them.
// ~/.claude.json can be megabytes of history, so it is parsed only when its
// mtime/size changes.

interface ProjectEntry {
  mcpServers?: Record<string, unknown>;
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: unknown;
  disabledMcpjsonServers?: unknown;
}
interface ClaudeConfig {
  servers: Record<string, unknown>; // the catalog
  projects: Record<string, ProjectEntry>; // by normalized folder
}

let cache: { path: string; stamp: string; config: ClaudeConfig } | null = null;

export function defaultClaudeConfigPath(): string {
  return join(homedir(), '.claude.json');
}

// "D:\Work\Roblox\CastleWars", "d:/Work/Roblox/CastleWars/" → one key
// (~/.claude.json keeps a folder under whatever casing it was opened with).
const folderKey = (dir: string): string => resolve(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function readClaudeConfig(path: string): ClaudeConfig {
  let stamp = '';
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return { servers: {}, projects: {} };
  }
  if (cache && cache.path === path && cache.stamp === stamp) return cache.config;
  const config: ClaudeConfig = { servers: {}, projects: {} };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown>; projects?: Record<string, ProjectEntry> };
    for (const [name, server] of Object.entries(raw.mcpServers ?? {})) config.servers[name] = server;
    for (const [dir, project] of Object.entries(raw.projects ?? {})) {
      for (const [name, server] of Object.entries(project?.mcpServers ?? {})) {
        if (!(name in config.servers)) config.servers[name] = server;
      }
      // Two casings of one folder: their settings merge.
      const key = folderKey(dir);
      const seen = config.projects[key];
      config.projects[key] = seen
        ? {
            mcpServers: { ...(project?.mcpServers ?? {}), ...(seen.mcpServers ?? {}) },
            enableAllProjectMcpServers: seen.enableAllProjectMcpServers === true || project?.enableAllProjectMcpServers === true,
            enabledMcpjsonServers: [...names(seen.enabledMcpjsonServers), ...names(project?.enabledMcpjsonServers)],
            disabledMcpjsonServers: [...names(seen.disabledMcpjsonServers), ...names(project?.disabledMcpjsonServers)],
          }
        : (project ?? {});
    }
  } catch {
    // unreadable or mid-write: keep the previous one if there was one
    return cache?.path === path ? cache.config : { servers: {}, projects: {} };
  }
  cache = { path, stamp, config };
  return config;
}

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

export function readMcpCatalog(path = defaultClaudeConfigPath()): Record<string, unknown> {
  return readClaudeConfig(path).servers;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Claude Code expands ${VAR} and ${VAR:-default} in .mcp.json.
function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => process.env[name] ?? fallback ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, expandEnv(inner)]));
  return value;
}

// The MCP servers set up for one project folder, the way Claude Code opened
// there loads them: the folder's own (`claude mcp add` in it, kept in
// ~/.claude.json) and the project's .mcp.json servers the owner APPROVED
// (enableAllProjectMcpServers / enabledMcpjsonServers in ~/.claude.json or
// the project's .claude/settings(.local).json; disabledMcpjsonServers wins).
// An unapproved .mcp.json server never starts — it is a program from the
// repo — and is reported in `unapproved`.
export function projectMcpServers(
  cwd: string,
  configPath = defaultClaudeConfigPath(),
): { servers: Record<string, unknown>; unapproved: string[] } {
  const own = readClaudeConfig(configPath).projects[folderKey(cwd)] ?? {};
  const servers: Record<string, unknown> = { ...(own.mcpServers ?? {}) };
  const unapproved: string[] = [];
  const declared = readJson(join(cwd, '.mcp.json'))?.['mcpServers'];
  if (declared && typeof declared === 'object') {
    const approvals: ProjectEntry[] = [
      own,
      ...['settings.json', 'settings.local.json'].map((file) => (readJson(join(cwd, '.claude', file)) ?? {}) as ProjectEntry),
    ];
    const enableAll = approvals.some((source) => source.enableAllProjectMcpServers === true);
    const enabled = new Set(approvals.flatMap((source) => names(source.enabledMcpjsonServers)));
    const disabled = new Set(approvals.flatMap((source) => names(source.disabledMcpjsonServers)));
    for (const [name, server] of Object.entries(declared as Record<string, unknown>)) {
      if (disabled.has(name)) continue;
      if (!enableAll && !enabled.has(name)) {
        if (!(name in servers)) unapproved.push(name);
        continue;
      }
      if (!(name in servers)) servers[name] = expandEnv(server);
    }
  }
  return { servers, unapproved };
}
