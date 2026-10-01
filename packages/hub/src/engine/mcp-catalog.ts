import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The MCP servers configured for Claude Code on this PC (~/.claude.json:
// user scope first, then any project's) — the catalog a team's connections
// are granted from, by name. Workers never inherit these on their own
// (strictMcpConfig); a team gets exactly the ones granted to it.
// ~/.claude.json can be megabytes of history, so it is parsed only when its
// mtime/size changes.

let cache: { path: string; stamp: string; servers: Record<string, unknown> } | null = null;

export function defaultClaudeConfigPath(): string {
  return join(homedir(), '.claude.json');
}

export function readMcpCatalog(path = defaultClaudeConfigPath()): Record<string, unknown> {
  let stamp = '';
  try {
    const stat = statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return {};
  }
  if (cache && cache.path === path && cache.stamp === stamp) return cache.servers;
  const servers: Record<string, unknown> = {};
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    for (const [name, server] of Object.entries(config.mcpServers ?? {})) servers[name] = server;
    for (const project of Object.values(config.projects ?? {})) {
      for (const [name, server] of Object.entries(project?.mcpServers ?? {})) {
        if (!(name in servers)) servers[name] = server;
      }
    }
  } catch {
    // unreadable or mid-write: keep the previous catalog if there was one
    return cache?.path === path ? cache.servers : {};
  }
  cache = { path, stamp, servers };
  return servers;
}
