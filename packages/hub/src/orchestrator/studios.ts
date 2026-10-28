import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The Roblox Studio windows open on this PC, read straight from Roblox's
// StudioMCP.exe (the program behind the Roblox Studio MCP server): one short
// stdio session per look, cached for a few seconds. The hub needs it to tell
// which window a worker's studio_id is (ids are per-session GUIDs) and to
// offer the owner a list to pick a task's Studio from.

export interface StudioWindow {
  id: string;
  name: string; // "<place name> (placeId: <id>)"
}

export type StudioLister = () => Promise<StudioWindow[]>;

// StudioMCP.exe: %LOCALAPPDATA%\Roblox\mcp.bat names it; else the newest
// Studio version folder has one.
export function findStudioMcp(): string | null {
  const roblox = join(process.env['LOCALAPPDATA'] ?? '', 'Roblox');
  try {
    const bat = readFileSync(join(roblox, 'mcp.bat'), 'utf8');
    const named = bat.match(/"([^"]*StudioMCP\.exe)"/i)?.[1];
    if (named && existsSync(named)) return named;
  } catch {
    // no mcp.bat
  }
  try {
    const versions = join(roblox, 'Versions');
    const found = readdirSync(versions)
      .map((name) => join(versions, name, 'StudioMCP.exe'))
      .filter((path) => existsSync(path))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return found[0] ?? null;
  } catch {
    return null;
  }
}

// One MCP session: initialize, list_roblox_studios, done.
export function listStudios(exe = findStudioMcp(), timeoutMs = 15_000): Promise<StudioWindow[]> {
  if (!exe) return Promise.reject(new Error('Roblox Studio (StudioMCP.exe) is not installed'));
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = '';
    let settled = false;
    const finish = (error: Error | null, studios: StudioWindow[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(studios);
    };
    const timer = setTimeout(() => finish(new Error('Roblox Studio did not answer')), timeoutMs);
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', (error) => finish(error));
    child.on('exit', () => finish(new Error('StudioMCP exited')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: number; result?: { content?: { type: string; text?: string }[] }; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_roblox_studios', arguments: {} } });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message ?? 'list_roblox_studios failed'));
          const text = message.result?.content?.find((part) => part.type === 'text')?.text ?? '';
          try {
            const parsed = JSON.parse(text) as { studios?: StudioWindow[] };
            finish(null, (parsed.studios ?? []).filter((studio) => typeof studio.id === 'string' && typeof studio.name === 'string'));
          } catch {
            finish(new Error(`unexpected answer: ${text.slice(0, 120)}`));
          }
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-hq', version: '1' } },
    });
  });
}

// Cached for a few seconds; concurrent lookups share one session.
export class StudioDirectory {
  #lister: StudioLister;
  #cache: { at: number; studios: StudioWindow[] } | null = null;
  #pending: Promise<StudioWindow[]> | null = null;

  constructor(lister: StudioLister = () => listStudios()) {
    this.#lister = lister;
  }

  async list(maxAgeMs = 10_000): Promise<StudioWindow[]> {
    if (this.#cache && Date.now() - this.#cache.at < maxAgeMs) return this.#cache.studios;
    this.#pending ??= this.#lister()
      .then((studios) => {
        this.#cache = { at: Date.now(), studios };
        return studios;
      })
      .finally(() => {
        this.#pending = null;
      });
    return this.#pending;
  }

  // The window behind a studio_id: cached first, then a fresh look (a
  // window opened since).
  async byId(id: string): Promise<StudioWindow | null> {
    const cached = (await this.list()).find((studio) => studio.id === id);
    if (cached) return cached;
    return (await this.list(0)).find((studio) => studio.id === id) ?? null;
  }
}
