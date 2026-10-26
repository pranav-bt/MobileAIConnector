import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSpec, Team, Usage } from '@agent-hq/shared';
import type { LockedDir } from '../orchestrator/util.js';
import { AppServerClient, findCodexBinary, type JsonObject, type Notification } from './codex-rpc.js';
import { DEFAULT_MAX_SUBAGENTS, refusalMessage, refusedWrite, workerInstructions } from './instructions.js';
import type { EngineRow, OrchestratorEngine, WorkerInbox, WorkerRunCallbacks, WorkerRunResult } from './types.js';
import { shellWrites } from '../orchestrator/policy.js';

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

// A Codex item as a console row: commands and tool calls start 'running' and
// are replaced with their output; edits are diff rows; the agent's messages
// and reasoning arrive whole when complete.
function itemRow(item: Item, phase: 'running' | 'done'): EngineRow | null {
  const id = item.id ?? '';
  if (!id) return null;
  switch (item.type) {
    case 'commandExecution': {
      const text = unwrapShellCommand(String(item['command'] ?? 'command'));
      if (phase === 'running') return { id, kind: 'tool', tool: 'shell', text, state: 'running' };
      const exit = item['exitCode'];
      const output = typeof item['aggregatedOutput'] === 'string' ? item['aggregatedOutput'] : '';
      return { id, kind: 'tool', tool: 'shell', text, state: typeof exit === 'number' && exit !== 0 ? 'error' : 'ok', ...(output ? { detail: output } : {}) };
    }
    case 'fileChange': {
      const changes = (item['changes'] as { path: string; diff?: string }[] | undefined) ?? [];
      return {
        id,
        kind: 'diff',
        tool: 'edit',
        text: `edit ${changes.map((change) => change.path).join(', ') || 'files'}`,
        detail: changes.map((change) => `${change.path}\n${change.diff ?? ''}`).join('\n\n'),
        state: phase === 'running' ? 'running' : String(item['status'] ?? '').toLowerCase().includes('fail') || String(item['status'] ?? '').toLowerCase().includes('declin') ? 'error' : 'ok',
      };
    }
    case 'mcpToolCall':
      return {
        id,
        kind: 'tool',
        tool: `${String(item['server'])}.${String(item['tool'])}`,
        text: `${String(item['server'])}: ${String(item['tool'])}`,
        state: phase === 'running' ? 'running' : String(item['status'] ?? '').toLowerCase().includes('fail') ? 'error' : 'ok',
      };
    case 'webSearch':
      return { id, kind: 'tool', tool: 'web', text: `web search${typeof item['query'] === 'string' ? `: ${item['query']}` : ''}`, state: phase === 'running' ? 'running' : 'ok' };
    case 'agentMessage': {
      const text = String(item['text'] ?? '').trim();
      return phase === 'done' && text ? { id, kind: 'message', text } : null;
    }
    case 'reasoning': {
      const summary = (item['summary'] as string[] | undefined) ?? [];
      const text = summary.join('\n').trim();
      return phase === 'done' && text ? { id, kind: 'thinking', text } : null;
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
  #onCacheRead: ((tokens: number) => void) | null = null;

  constructor(options: CodexEngineOptions = {}) {
    this.#options = options;
  }

  // Codex's totalTokens already counts cached input; the cached part is
  // reported separately, as for Claude.
  observeUsage(onCacheRead: (tokens: number) => void): void {
    this.#onCacheRead = onCacheRead;
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
      onItemDone?: (item: Item) => void;
      onTokens?: (total: number, last: number) => void;
      onRequest?: (method: string, params: JsonObject) => Promise<unknown>;
      // The owner's messages while this turn runs: steered straight in.
      inbox?: WorkerInbox;
      onSteerFailed?: (text: string) => void;
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
        hooks.onItemDone?.(item);
      } else if (note.method === 'thread/tokenUsage/updated') {
        const usage = note.params['tokenUsage'] as
          | { total?: { totalTokens?: number }; last?: { totalTokens?: number; cachedInputTokens?: number } }
          | undefined;
        tokens = usage?.total?.totalTokens ?? tokens;
        const cached = usage?.last?.cachedInputTokens ?? 0;
        if (cached > 0) this.#onCacheRead?.(cached);
        hooks.onTokens?.(tokens, usage?.last?.totalTokens ?? 0);
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
    let active = false;
    const offInbox = hooks.inbox?.subscribe((message) => {
      if (!active || !turnId) return false; // not running: queue for the next turn
      const expectedTurnId = turnId;
      void client
        .request('turn/steer', { threadId, expectedTurnId, input: [{ type: 'text', text: message, text_elements: [] }] }, 15_000)
        .catch(() => hooks.onSteerFailed?.(message));
      return true;
    });
    try {
      const started = await client.request<{ turn: { id: string } }>('turn/start', { threadId, ...params });
      turnId = started.turn.id;
      active = true;
      for (const note of early.splice(0)) handle(note);
      if (hooks.signal?.aborted) onAbort();
      const done = await finished;
      active = false;
      const turn = done.params['turn'] as { status: string; error?: { message?: string } | null };
      return { status: turn.status, text, tokens, error: turn.error?.message ?? null };
    } finally {
      active = false;
      offInbox?.();
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
    resumeSessionId?: string;
    inbox?: WorkerInbox;
    readOnly?: boolean;
    foreign?: boolean;
  }): Promise<WorkerRunResult> {
    const { callbacks } = args;
    const client = await this.#ready();
    const extraDirs = args.extraDirs ?? [];
    // A foreign thread is the owner's own conversation (a Codex freelancer):
    // their setup stays as it is (no Agent HQ instructions, their MCP
    // servers), it's never archived, and every command/edit still asks.
    const foreign = !!args.foreign;
    const threadSettings = {
      cwd: args.cwd,
      approvalPolicy: 'untrusted',
      sandbox: args.readOnly ? 'read-only' : 'workspace-write',
      ...(foreign
        ? {}
        : {
            config: this.#mcpConfig(args.team.mcpServers),
            developerInstructions: workerInstructions(args.team.charter, args.maxSubagents ?? DEFAULT_MAX_SUBAGENTS),
          }),
    };
    let threadId: string;
    if (args.resumeSessionId) {
      // Continue the same conversation: ours was archived after its last run.
      threadId = args.resumeSessionId;
      if (!foreign) await client.request('thread/unarchive', { threadId }).catch(() => undefined);
      try {
        await client.request('thread/resume', { threadId, ...(foreign ? {} : { model: args.model.id }), excludeTurns: true, ...threadSettings });
      } catch (error) {
        // Codex allows one writer per thread: the owner's own window has it
        // open — continue in a fork (same history), never fight for it.
        if (!foreign || !/active writer/i.test(error instanceof Error ? error.message : String(error))) throw error;
        const { thread } = await client.request<{ thread: { id: string } }>('thread/fork', { threadId, ...threadSettings });
        callbacks.onActivity('the conversation is open in a Codex window — continuing in a fork of it (same history)');
        threadId = thread.id;
      }
    } else {
      const { thread } = await client.request<{ thread: { id: string } }>('thread/start', { model: args.model.id, ...threadSettings });
      threadId = thread.id;
      // Recognizable in the owner's Codex history (archived when done, so it
      // stays out of the way but can be resumed).
      void client.request('thread/name/set', { threadId, name: `Agent HQ · ${(args.title ?? args.team.name).slice(0, 60)}` }).catch(() => undefined);
    }
    callbacks.onSession?.(threadId);

    let filesChanged = false;
    let baseline: number | null = null; // the thread's token total before this run
    let tokens = 0;
    const late: string[] = []; // messages a finished turn couldn't take
    const emit = (row: EngineRow) => callbacks.onTranscript?.(row);
    const hooks = {
      signal: args.signal,
      inbox: args.inbox,
      onSteerFailed: (text: string) => late.push(text),
      onItem: (item: Item) => {
        const line = describeItem(item);
        if (line) callbacks.onActivity(line);
        const row = itemRow(item, 'running');
        if (row) emit(row);
      },
      onItemDone: (item: Item) => {
        if (item.type === 'fileChange') filesChanged = true;
        if (item.type === 'commandExecution' && shellWrites(unwrapShellCommand(String(item['command'] ?? '')))) filesChanged = true;
        const row = itemRow(item, 'done');
        if (row) emit(row);
      },
      // The thread's running total includes earlier runs of a resumed
      // conversation: count from where this run started.
      onTokens: (total: number, last: number) => {
        if (baseline === null) baseline = Math.max(0, total - last);
        tokens = Math.max(0, total - baseline);
        callbacks.onTokens(tokens);
      },
      onRequest: async (method: string, request: JsonObject) => {
        if (method === 'item/commandExecution/requestApproval') {
          const command = unwrapShellCommand(String(request['command'] ?? ''));
          if (args.readOnly && shellWrites(command)) return { decision: 'decline' }; // reviewing: never change files
          const decision = await callbacks.onPermission({
            toolName: 'Bash',
            command,
            reason: typeof request['reason'] === 'string' && request['reason'] ? String(request['reason']) : `Requested while working in ${args.cwd}`,
          });
          return { decision: decision === 'approve' ? 'accept' : 'decline' };
        }
        if (method === 'item/fileChange/requestApproval') {
          if (args.readOnly) return { decision: 'decline' };
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
        if (method === 'mcpServer/elicitation/request') {
          const server = String(request['serverName'] ?? '');
          if ((request['_meta'] as JsonObject | undefined)?.['codex_approval_kind'] === 'mcp_tool_call') {
            // Codex asks before every MCP tool call. A connection the team
            // was granted runs without a card, as Claude workers' MCP tools
            // do (an app's bridge enforces its own read-only mode); any other
            // server (an owner thread's own) goes through the policy.
            if (!foreign && server in (args.team.mcpServers ?? {})) return { action: 'accept', content: {} };
            const decision = await callbacks.onPermission({
              toolName: `mcp__${server}`,
              command: String(request['message'] ?? `${server} tool call`),
              reason: `Requested while working in ${args.cwd}`,
            });
            return decision === 'approve' ? { action: 'accept', content: {} } : { action: 'decline' };
          }
          callbacks.onActivity(`${server} asked for input — declined (a worker can't fill in an MCP server's form)`);
          return { action: 'decline' };
        }
        if (process.env['AGENT_HQ_CODEX_DEBUG']) console.error(`[codex] unanswered ${method}: ${JSON.stringify(request).slice(0, 3000)}`);
        return {};
      },
    };

    let input = args.prompt;
    let result: { status: string; text: string; tokens: number; error: string | null };
    try {
      for (;;) {
        result = await this.#turn(
          client,
          threadId,
          {
            input: [{ type: 'text', text: input, text_elements: [] }],
            ...(args.model.effort && !foreign ? { effort: args.model.effort } : {}),
            sandboxPolicy: args.readOnly
              ? { type: 'readOnly', networkAccess: true }
              : {
                  type: 'workspaceWrite',
                  writableRoots: [args.cwd, ...extraDirs],
                  networkAccess: true, // every command still asks the policy (sending data out raises a card)
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                },
          },
          hooks,
        );
        // Messages that arrived as the turn ended run as one more turn on the
        // same conversation.
        const waiting = [...late.splice(0), ...(args.inbox?.take() ?? [])];
        if (result.status !== 'completed' || waiting.length === 0 || args.signal?.aborted) break;
        input = waiting.join('\n\n');
      }
    } finally {
      if (!foreign) void client.request('thread/archive', { threadId }).catch(() => undefined);
    }
    if (result.status === 'failed') {
      throw new Error(result.error ? `Codex: ${result.error}` : 'Codex turn failed');
    }
    return { synopsis: result.text, tokens: tokens || result.tokens, sessionId: threadId, filesChanged };
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
