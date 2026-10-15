import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// The Codex app-server: the binary the VS Code Codex extension ships, run as
// `codex app-server` and spoken to with JSON-RPC over stdio (one JSON object
// per line, no "jsonrpc" field). Everything Codex-specific lives under
// engine/ — the rest of the hub only sees the OrchestratorEngine boundary.
// Protocol facts were verified live by test/codex-spike.live.ts.

export type JsonObject = Record<string, unknown>;
export interface Notification {
  method: string;
  params: JsonObject;
}
export type ServerRequestHandler = (method: string, params: JsonObject) => Promise<unknown>;

// Newest openai.chatgpt-<version> extension's bundled CLI (its path changes
// with every extension update), unless AGENT_HQ_CODEX points at one.
export function findCodexBinary(): string | null {
  const override = process.env['AGENT_HQ_CODEX'];
  if (override) return existsSync(override) ? override : null;
  const extensions = join(homedir(), '.vscode', 'extensions');
  let dirs: string[];
  try {
    dirs = readdirSync(extensions).filter((dir) => dir.startsWith('openai.chatgpt-'));
  } catch {
    return null;
  }
  const version = (dir: string) => (/openai\.chatgpt-([\d.]+)/.exec(dir)?.[1] ?? '0').split('.').map(Number);
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  for (const dir of dirs.sort((a, b) => compare(version(b), version(a)))) {
    const bin = join(extensions, dir, 'bin', process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64', process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(bin)) return bin;
  }
  return null;
}

export class AppServerClient {
  #proc: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #listeners = new Set<(note: Notification) => void>();
  #requestHandlers = new Set<ServerRequestHandler>();
  #stderr = '';
  #dead: Error | null = null;

  // `command` + `args` — tests point this at a fake app-server.
  constructor(command: string, args: string[]) {
    this.#proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#proc.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + String(chunk)).slice(-4000);
    });
    this.#proc.on('error', (error) => this.#die(error));
    this.#proc.on('exit', (code) => this.#die(new Error(`codex app-server exited (${code ?? 'signal'})${this.#stderr ? `: ${this.#stderr.slice(-300)}` : ''}`)));
    createInterface({ input: this.#proc.stdout }).on('line', (line) => this.#handle(line));
  }

  get alive(): boolean {
    return this.#dead === null;
  }

  #die(error: Error): void {
    if (this.#dead) return;
    this.#dead = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #write(message: object): void {
    if (this.#dead) return;
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handle(line: string): void {
    let message: { id?: number | string; method?: string; params?: JsonObject; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // not protocol (stray log line)
    }
    // Response to one of our requests.
    if (message.id !== undefined && !message.method) {
      const pending = this.#pending.get(Number(message.id));
      this.#pending.delete(Number(message.id));
      if (message.error) pending?.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending?.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    // A request from Codex (approvals, questions): the first handler that
    // answers (non-undefined) wins; otherwise an empty result.
    if (message.id !== undefined && message.method) {
      const { id, method } = message;
      void (async () => {
        let answer: unknown = {};
        for (const handler of this.#requestHandlers) {
          try {
            const result = await handler(method, params);
            if (result !== undefined) {
              answer = result;
              break;
            }
          } catch {
            // a failing handler must not leave Codex waiting
          }
        }
        this.#write({ id, result: answer });
      })();
      return;
    }
    if (message.method) for (const listener of this.#listeners) listener({ method: message.method, params });
  }

  request<T = JsonObject>(method: string, params: object, timeoutMs = 120_000): Promise<T> {
    if (this.#dead) return Promise.reject(this.#dead);
    const id = this.#nextId++;
    this.#write({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`codex ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  notify(method: string, params: object = {}): void {
    this.#write({ method, params });
  }

  // Returns an unsubscribe function.
  onNotification(listener: (note: Notification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.#requestHandlers.add(handler);
    return () => this.#requestHandlers.delete(handler);
  }

  async initialize(): Promise<JsonObject> {
    const result = await this.request<JsonObject>('initialize', {
      clientInfo: { name: 'agent-hq', title: 'Agent HQ', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized');
    return result;
  }

  close(): void {
    this.#die(new Error('closed'));
    this.#proc.kill();
  }
}
