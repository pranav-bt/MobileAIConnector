import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSpec, Team, Usage } from '@agent-hq/shared';
import type { LockedDir } from '../orchestrator/util.js';
import { AppServerClient, findCodexBinary, type JsonObject, type Notification } from './codex-rpc.js';
import { DEFAULT_MAX_SUBAGENTS, refusalMessage, refusedWrite, workerInstructions } from './instructions.js';
import type { OrchestratorEngine, WorkerRunCallbacks, WorkerRunResult } from './types.js';

// The Codex engine: workers, leads and one-shot calls on OpenAI Codex models
// through the app-server (see codex-rpc.ts). Same guarantees as the Claude
// engine, verified live (test/codex-spike.live.ts, test/codex-engine.live.ts):
// - approvalPolicy "untrusted": EVERY command and file edit asks us first;
//   commands go through the orchestrator's permission policy (the same one
//   Claude's tools use), file edits through the same write lock.
// - sandbox workspace-write with writable roots = the project + its extra
//   dirs; reads anywhere stay possible, writes elsewhere are blocked.
// - MCP: exactly the team's grants — every server configured on the PC is
//   disabled per thread unless granted; the ChatGPT apps connector is off for
//   the whole process (--disable apps).

// Codex runs commands as `"…\powershell.exe" -Command '<inner>'`; the policy
// judges the inner command, not the wrapper (whose own path once tripped
// "writes outside this project").
export function unwrapShellCommand(raw: string): string {
  const wrapped = /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+(['"])([\s\S]*)\1\s*$/i.exec(raw.trim());
  if (!wrapped) return raw;
  return wrapped[1] === '"' ? wrapped[2]!.replace(/\\"/g, '"') : wrapped[2]!.replace(/''/g, "'");
}

type Item = JsonObject & { type?: string; id?: string };

// One short line for the office/activity feed per Codex item.
function describeItem(item: Item): string | null {
  switch (item.type) {
    case 'commandExecution':
      return unwrapShellCommand(String(item['command'] ?? 'command')).slice(0, 160);
    case 'fileChange': {
      const changes = (item['changes'] as { path: string }[] | undefined) ?? [];
      return `edit ${changes.map((change) => change.path).join(', ') || 'files'}`;
    }
    case 'mcpToolCall':
      return `${String(item['server'])}: ${String(item['tool'])}`;
    case 'webSearch':
      return `web search${typeof item['query'] === 'string' ? `: ${item['query']}` : ''}`;
    case 'agentMessage': {
      const text = String(item['text'] ?? '').trim();
      return text ? text.slice(0, 80) : null;
    }
    default:
      return null;
  }
}

// Claude-SDK-shaped grants ({type:'stdio', command, args, env} / {type:'http',
// url}) as Codex's mcp_servers entries.
function codexServer(config: unknown): JsonObject | null {
  if (typeof config !== 'object' || config === null) return null;
  const entry = config as JsonObject;
  if (typeof entry['url'] === 'string') return { url: entry['url'] };
  if (typeof entry['command'] !== 'string') return null;
  return {
    command: entry['command'],
    ...(Array.isArray(entry['args']) ? { args: entry['args'] } : {}),
    ...(entry['env'] && typeof entry['env'] === 'object' && Object.keys(entry['env']).length > 0 ? { env: entry['env'] } : {}),
  };
}

export interface CodexEngineOptions {
  // How to start the app-server; tests point this at a fake one.
  command?: string;
  args?: string[];
}

export class CodexEngine implements OrchestratorEngine {
  #options: CodexEngineOptions;
  #client: AppServerClient | null = null;
  #starting: Promise<AppServerClient> | null = null;
  #configuredServers: string[] = [];
  #checksDir = join(tmpdir(), 'agent-hq-codex-checks');

  constructor(options: CodexEngineOptions = {}) {
    this.#options = options;
  }

  // Started lazily: nothing runs until a Codex model is actually used.
  get started(): boolean {
    return !!this.#client?.alive;
  }

  async #ready(): Promise<AppServerClient> {
    if (this.#client?.alive) return this.#client;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      const command = this.#options.command ?? findCodexBinary();
      if (!command) throw new Error('Codex is not installed (no VS Code Codex extension found) — pick a Claude model for this seat');
      const client = new AppServerClient(command, this.#options.args ?? ['--disable', 'apps', 'app-server']);
      await client.initialize();
      // Every MCP server configured for Codex on this PC — each is turned off
      // per thread unless the team was granted it.
      try {
        const list = await client.request<{ data: { name: string }[] }>('mcpServerStatus/list', {});
        this.#configuredServers = list.data.map((entry) => entry.name);
      } catch {
        this.#configuredServers = [];
      }
      this.#client = client;
      return client;
    })().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  #mcpConfig(grants: Record<string, unknown> = {}): JsonObject {
    const config: JsonObject = {};
    for (const name of this.#configuredServers) if (!(name in grants)) config[`mcp_servers.${name}.enabled`] = false;
    for (const [name, grant] of Object.entries(grants)) {
      const server = codexServer(grant);
      if (server) config[`mcp_servers.${name}`] = server;
    }
    return config;
  }

  // Runs one turn on a thread and collects what it produced. `onRequest`
  // answers this thread's approvals and questions.
  async #turn(
    client: AppServerClient,
    threadId: string,
    params: JsonObject,
    hooks: {
      onItem?: (item: Item) => void;
      onTokens?: (total: number) => void;
      onRequest?: (method: string, params: JsonObject) => Promise<unknown>;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ status: string; text: string; tokens: number; error: string | null }> {
    let text = '';
    let tokens = 0;
    let turnId: string | null = null;
    const items = new Map<string, Item>();
    let finish: (note: Notification) => void = () => {};
    const finished = new Promise<Notification>((resolve) => (finish = resolve));
    const early: Notification[] = [];
    const offNote = client.onNotification((note) => {
      if (note.params['threadId'] !== threadId) return;
      if (turnId === null) {
        early.push(note); // notifications can beat the turn/start response
        return;
      }
      handle(note);
    });
    const handle = (note: Notification) => {
      if (note.params['turnId'] !== undefined && note.params['turnId'] !== turnId && note.method !== 'turn/completed') return;
      const item = note.params['item'] as Item | undefined;
      if (note.method === 'item/started' && item) {
        if (item.id) items.set(item.id, item);
        hooks.onItem?.(item);
      } else if (note.method === 'item/completed' && item) {
        if (item.id) items.set(item.id, item);
        if (item.type === 'agentMessage') text = String(item['text'] ?? '');
      } else if (note.method === 'thread/tokenUsage/updated') {
        const usage = note.params['tokenUsage'] as { total?: { totalTokens?: number } } | undefined;
        tokens = usage?.total?.totalTokens ?? tokens;
        hooks.onTokens?.(tokens);
      } else if (note.method === 'turn/completed' && (note.params['turn'] as { id?: string } | undefined)?.id === turnId) {
        finish(note);
      }
    };
    const offRequest = client.onServerRequest(async (method, request) => {
      if (request['threadId'] !== threadId) return undefined;
      // File-edit approvals carry only the item id: attach the edit's paths.
      if (method === 'item/fileChange/requestApproval') {
        const item = items.get(String(request['itemId']));
        request = { ...request, changes: item?.['changes'] ?? [] };
      }
      return hooks.onRequest ? hooks.onRequest(method, request) : { decision: 'decline' };
    });
    const onAbort = () => {
      if (turnId) void client.request('turn/interrupt', { threadId, turnId }, 15_000).catch(() => undefined);
    };
    hooks.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const started = await client.request<{ turn: { id: string } }>('turn/start', { threadId, ...params });
      turnId = started.turn.id;
      for (const note of early.splice(0)) handle(note);
      if (hooks.signal?.aborted) onAbort();
      const done = await finished;
      const turn = done.params['turn'] as { status: string; error?: { message?: string } | null };
      return { status: turn.status, text, tokens, error: turn.error?.message ?? null };
    } finally {
      offNote();
      offRequest();
      hooks.signal?.removeEventListener('abort', onAbort);
    }
  }

  // One model call, no tools — routing, lead reviews, quick checks.
  async complete(args: { prompt: string; model: ModelSpec }): Promise<{ text: string; tokens: number }> {
    const client = await this.#ready();
    mkdirSync(this.#checksDir, { recursive: true });
    const { thread } = await client.request<{ thread: { id: string } }>('thread/start', {
      model: args.model.id,
      cwd: this.#checksDir,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      config: this.#mcpConfig(),
      developerInstructions: 'Answer from the text you are given. Do not run commands, read files or edit anything.',
    });
    const result = await this.#turn(client, thread.id, {
      input: [{ type: 'text', text: args.prompt, text_elements: [] }],
      ...(args.model.effort ? { effort: args.model.effort } : {}),
    });
    if (result.status === 'failed') throw new Error(result.error ?? 'Codex call failed');
    return { text: result.text, tokens: result.tokens };
  }

  async runWorker(args: {
    prompt: string;
    team: Team;
    model: ModelSpec;
    cwd: string;
    extraDirs?: string[];
    locked?: LockedDir;
    maxSubagents?: number;
    callbacks: WorkerRunCallbacks;
    signal?: AbortSignal;
    title?: string;
  }): Promise<WorkerRunResult> {
    const { callbacks } = args;
    const client = await this.#ready();
    const extraDirs = args.extraDirs ?? [];
    const { thread } = await client.request<{ thread: { id: string } }>('thread/start', {
      model: args.model.id,
      cwd: args.cwd,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: this.#mcpConfig(args.team.mcpServers),
      developerInstructions: workerInstructions(args.team.charter, args.maxSubagents ?? DEFAULT_MAX_SUBAGENTS),
    });
    // Recognizable in the owner's Codex history (archived when done, so it
    // stays out of the way but can be resumed).
    void client.request('thread/name/set', { threadId: thread.id, name: `Agent HQ · ${(args.title ?? args.team.name).slice(0, 60)}` }).catch(() => undefined);

    const result = await this.#turn(
      client,
      thread.id,
      {
        input: [{ type: 'text', text: args.prompt, text_elements: [] }],
        ...(args.model.effort ? { effort: args.model.effort } : {}),
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [args.cwd, ...extraDirs],
          networkAccess: true, // every command still asks the policy (sending data out raises a card)
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      },
      {
        signal: args.signal,
        onItem: (item) => {
          const line = describeItem(item);
          if (line) callbacks.onActivity(line);
        },
        onTokens: (total) => callbacks.onTokens(total),
        onRequest: async (method, request) => {
          if (method === 'item/commandExecution/requestApproval') {
            const command = unwrapShellCommand(String(request['command'] ?? ''));
            const decision = await callbacks.onPermission({
              toolName: 'Bash',
              command,
              reason: typeof request['reason'] === 'string' && request['reason'] ? String(request['reason']) : `Requested while working in ${args.cwd}`,
            });
            return { decision: decision === 'approve' ? 'accept' : 'decline' };
          }
          if (method === 'item/fileChange/requestApproval') {
            const paths = ((request['changes'] as { path: string }[] | undefined) ?? []).map((change) => change.path);
            if (paths.length === 0) return { decision: 'decline' };
            for (const path of paths) {
              const refused = refusedWrite({ file_path: path }, args.cwd, extraDirs, args.locked);
              if (refused) {
                callbacks.onActivity(refused.config ? `blocked: write into Agent HQ's own data — ${refused.path}` : `blocked: write outside this project — ${refused.path}`);
                return { decision: 'decline' };
              }
            }
            const decision = await callbacks.onPermission({ toolName: 'Edit', command: `Edit ${paths.join(', ')}`, reason: `Requested while working in ${args.cwd}` });
            return { decision: decision === 'approve' ? 'accept' : 'decline' };
          }
          if (method === 'item/permissions/requestApproval') {
            // Extra sandbox permissions are never granted: the project folder
            // (+ inbox/outbox) is the boundary, as for Claude workers.
            callbacks.onActivity('asked for extra sandbox permissions — not granted');
            return { permissions: {}, scope: 'turn' };
          }
          if (method === 'item/tool/requestUserInput') {
            callbacks.onActivity('asked a question mid-task — answered "decide yourself and say so in your report"');
            return { answers: {} };
          }
          return {};
        },
      },
    );
    void client.request('thread/archive', { threadId: thread.id }).catch(() => undefined);
    if (result.status === 'failed') {
      throw new Error(result.error ? `Codex: ${result.error}` : 'Codex turn failed');
    }
    return { synopsis: result.text, tokens: result.tokens, sessionId: thread.id };
  }

  // The ChatGPT plan's limits, for the Resources page (no usage spent).
  async rateLimits(): Promise<NonNullable<Usage['codex']> | null> {
    if (!this.started) return null;
    try {
      const client = await this.#ready();
      const { rateLimits } = await client.request<{
        rateLimits: {
          planType?: string | null;
          primary?: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
          secondary?: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
        };
      }>('account/rateLimits/read', {}, 20_000);
      // Windows by length: up to a day = the short window, longer = weekly.
      const windows = [rateLimits.primary, rateLimits.secondary].filter((window): window is NonNullable<typeof window> => !!window);
      const short = windows.find((window) => (window.windowDurationMins ?? 0) <= 24 * 60);
      const weekly = windows.find((window) => (window.windowDurationMins ?? 0) > 24 * 60);
      // Epoch seconds (or ms, if a version ever switches) → ms.
      const ms = (value: number | null | undefined) => (value ? (value > 1e12 ? value : value * 1000) : null);
      return {
        plan: rateLimits.planType ?? null,
        windowPct: short?.usedPercent ?? null,
        windowResetsAt: ms(short?.resetsAt),
        weeklyPct: weekly?.usedPercent ?? null,
        weeklyResetsAt: ms(weekly?.resetsAt),
      };
    } catch {
      return null;
    }
  }

  close(): void {
    this.#client?.close();
    this.#client = null;
  }
}
