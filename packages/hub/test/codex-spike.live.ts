// Phase 1a spike (no product code): drives the Codex app-server — the binary
// bundled with the VS Code Codex extension — through everything the Agent HQ
// adapter will need, and prints a findings table:
//   approvals routed to us (commands + file edits), the project sandbox,
//   whether a data/ sub-folder can be guarded, developer instructions,
//   mid-run steering, interrupt, resume after a restart, strict-JSON turns
//   (master / quick checks), MCP isolation, two threads at once, token
//   usage and plan rate limits.
// Spends a little Codex usage (cheapest model, low effort), works in temp
// folders, and deletes the Codex threads it created.
//   npx tsx test/codex-spike.live.ts [--model gpt-6-luna] [--effort low]
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { evaluatePermission, type WorkspaceScope } from '../src/orchestrator/policy.js';

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const MODEL = arg('model', 'gpt-6-luna');
const EFFORT = arg('effort', 'low');

// Newest openai.chatgpt-<version>-win32-x64 extension's bundled CLI.
function findCodex(): string {
  const extensions = join(homedir(), '.vscode', 'extensions');
  const version = (dir: string) => (dir.match(/openai\.chatgpt-([\d.]+)/)?.[1] ?? '0').split('.').map(Number);
  const newer = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  const dirs = readdirSync(extensions).filter((dir) => dir.startsWith('openai.chatgpt-')).sort((a, b) => newer(version(b), version(a)));
  for (const dir of dirs) {
    const bin = join(extensions, dir, 'bin', 'windows-x86_64', 'codex.exe');
    if (existsSync(bin)) return bin;
  }
  throw new Error('no bundled codex.exe found under ~/.vscode/extensions');
}

type Message = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
type Note = { method: string; params: Record<string, unknown>; at: number };

// Minimal JSON-RPC over stdio (one JSON object per line, no "jsonrpc" field).
class AppServer {
  readonly notes: Note[] = [];
  readonly serverRequests: { method: string; params: Record<string, unknown>; answer: unknown }[] = [];
  stderr = '';
  onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({});
  #proc: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #waiters: { test: (note: Note) => boolean; resolve: (note: Note) => void }[] = [];

  constructor(bin: string, extraArgs: string[] = []) {
    this.#proc = spawn(bin, [...extraArgs, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#proc.stderr.on('data', (chunk) => (this.stderr += String(chunk)).slice(-4000));
    createInterface({ input: this.#proc.stdout }).on('line', (line) => this.#handle(line));
  }

  #write(message: object): void {
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handle(line: string): void {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const pending = this.#pending.get(Number(message.id));
      this.#pending.delete(Number(message.id));
      if (message.error) pending?.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending?.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const { id, method } = message;
      const params = message.params ?? {};
      void this.onRequest(method, params).then((answer) => {
        this.serverRequests.push({ method, params, answer });
        this.#write({ id, result: answer });
      });
      return;
    }
    if (message.method) {
      const note = { method: message.method, params: message.params ?? {}, at: Date.now() };
      this.notes.push(note);
      for (const waiter of [...this.#waiters]) {
        if (waiter.test(note)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(note);
        }
      }
    }
  }

  request<T = Record<string, unknown>>(method: string, params: object, timeoutMs = 60_000): Promise<T> {
    const id = this.#nextId++;
    this.#write({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value as T)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
    });
  }

  notify(method: string, params: object = {}): void {
    this.#write({ method, params });
  }

  waitFor(test: (note: Note) => boolean, timeoutMs = 120_000, since = 0): Promise<Note> {
    const already = this.notes.slice(since).find(test);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for a notification')), timeoutMs);
      this.#waiters.push({ test, resolve: (note) => (clearTimeout(timer), resolve(note)) });
    });
  }

  async start(): Promise<Record<string, unknown>> {
    const result = await this.request('initialize', {
      clientInfo: { name: 'agent-hq-spike', title: 'Agent HQ spike', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized');
    return result;
  }

  close(): void {
    this.#proc.kill();
  }
}

const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};
const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }];
const inside = (child: string, parent: string) => child.toLowerCase().replace(/\//g, '\\').startsWith(parent.toLowerCase().replace(/\//g, '\\') + '\\');

// A throwaway "project": data/ plays Agent HQ's locked data dir; outside/ is
// a sibling folder (another project) that must not be written.
const root = mkdtempSync(join(tmpdir(), 'codex-spike-'));
const ws = join(root, 'project');
const dataDir = join(ws, 'data');
const outside = join(root, 'outside');
mkdirSync(dataDir, { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, 'readme.txt'), 'OUTSIDE-README-CONTENT');
const sandboxPolicy = {
  type: 'workspaceWrite',
  writableRoots: [ws],
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true,
};

const bin = findCodex();
console.log(`codex: ${bin}\nmodel: ${MODEL} · effort ${EFFORT}\nworkspace: ${ws}\n`);
const createdThreads: string[] = [];

// The approval handler Agent HQ would run: commands go through the REAL
// permission policy (project scope + the locked data dir); "ask" is treated
// as a denial here (no owner to ask). File edits are judged by their paths.
const fileChanges = new Map<string, string[]>();
const scope: WorkspaceScope = { cwd: ws, extraDirs: [], locked: { dir: dataDir, open: [] } };
const commandLog: string[] = [];
function attachPolicy(server: AppServer): void {
  server.onRequest = async (method, params) => {
    if (method === 'item/commandExecution/requestApproval') {
      // Codex wraps every command as "…\powershell.exe" -Command '<inner>';
      // the policy must judge the inner command (prototype of the adapter's
      // normalization — the wrapper's own path + an `=>` read as a redirect
      // otherwise trip "writes outside this project").
      const raw = String(params['command'] ?? '');
      const wrapped = /^"?[^"]*powershell(?:\.exe)?"?\s+-Command\s+(['"])([\s\S]*)\1\s*$/i.exec(raw);
      const command = wrapped ? (wrapped[1] === '"' ? wrapped[2]!.replace(/\\"/g, '"') : wrapped[2]!.replace(/''/g, "'")) : raw;
      const verdict = evaluatePermission('Bash', command, 'auto', scope);
      const decision = verdict.decision === 'allow' ? 'accept' : 'decline';
      commandLog.push(`${decision}: ${command.replace(/\s+/g, ' ').slice(0, 110)}${verdict.decision === 'ask' ? ` [${verdict.flags.join('; ')}]` : ''}`);
      return { decision };
    }
    if (method === 'item/fileChange/requestApproval') {
      // Look the edit's paths up right now: the approval can arrive in the
      // same chunk as the item/started that carries them.
      for (const note of server.notes) {
        const item = note.params['item'] as { type?: string; id?: string; changes?: { path: string }[] } | undefined;
        if (item?.type === 'fileChange' && item.id === params['itemId']) {
          fileChanges.set(item.id, (item.changes ?? []).map((change) => (/^[a-zA-Z]:|^[\\/]/.test(change.path) ? change.path : join(ws, change.path))));
        }
      }
      const paths = fileChanges.get(String(params['itemId'])) ?? [];
      const bad = paths.length === 0 || paths.some((path) => inside(path, dataDir) || !inside(path, ws));
      return { decision: bad ? 'decline' : 'accept' };
    }
    if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (method === 'item/tool/requestUserInput') return { answers: {} };
    return {};
  };
  // Track file-change items so a file approval can be judged by its paths.
  const watch = setInterval(() => {
    for (const note of server.notes) {
      if (note.method !== 'item/started' && note.method !== 'item/completed') continue;
      const item = note.params['item'] as { type?: string; id?: string; changes?: { path: string }[] } | undefined;
      if (item?.type === 'fileChange' && item.id) {
        fileChanges.set(item.id, (item.changes ?? []).map((change) => (/^[a-zA-Z]:|^[\\/]/.test(change.path) ? change.path : join(ws, change.path))));
      }
    }
  }, 50);
  watch.unref();
}

async function runTurn(server: AppServer, threadId: string, input: string, extra: object = {}, timeoutMs = 240_000) {
  const mark = server.notes.length;
  const started = Date.now();
  const { turn } = await server.request<{ turn: { id: string } }>('turn/start', { threadId, input: text(input), effort: EFFORT, ...extra });
  const done = await server.waitFor((n) => n.method === 'turn/completed' && (n.params['turn'] as { id: string }).id === turn.id, timeoutMs, mark);
  // Only this turn's notifications (two threads may run at once).
  const notes = server.notes.slice(mark).filter((n) => n.params['turnId'] === undefined || n.params['turnId'] === turn.id);
  const messages = notes
    .filter((n) => n.method === 'item/completed' && (n.params['item'] as { type: string }).type === 'agentMessage')
    .map((n) => (n.params['item'] as { text: string }).text);
  const usage = [...notes].reverse().find((n) => n.method === 'thread/tokenUsage/updated');
  const total = ((usage?.params['tokenUsage'] as { last?: { totalTokens?: number } } | undefined)?.last?.totalTokens) ?? 0;
  return {
    turnId: turn.id,
    status: (done.params['turn'] as { status: string }).status,
    final: messages.at(-1) ?? '',
    itemTypes: [...new Set(notes.filter((n) => n.method === 'item/started').map((n) => (n.params['item'] as { type: string }).type))],
    tokens: total,
    ms: Date.now() - started,
    notes,
  };
}

let server = new AppServer(bin);
try {
  const init = await server.start();
  record('handshake', true, `initialize ok (${Object.keys(init).join(', ') || 'empty result'})`);

  // Plan limits — the second set of usage meters.
  try {
    const limits = await server.request<{ rateLimits: { primary?: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }; secondary?: { usedPercent: number; windowDurationMins: number | null } | null; planType?: string } }>('account/rateLimits/read', {});
    const { primary, secondary, planType } = limits.rateLimits;
    record(
      'plan rate limits',
      !!primary,
      `plan ${planType ?? '?'} · primary ${primary?.usedPercent}% of ${primary?.windowDurationMins}min · secondary ${secondary?.usedPercent ?? '?'}% of ${secondary?.windowDurationMins ?? '?'}min`,
    );
  } catch (error) {
    record('plan rate limits', false, String(error));
  }

  attachPolicy(server);

  // Main thread: approvals, sandbox, data/ guard, developer instructions.
  const start = await server.request<{ thread: { id: string }; model: string; instructionSources: string[]; sandbox: unknown; approvalPolicy: unknown }>('thread/start', {
    model: MODEL,
    cwd: ws,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    developerInstructions: 'You are a worker for Agent HQ. Always end your final reply with the word ZEBRA.',
  });
  const threadId = start.thread.id;
  createdThreads.push(threadId);
  record('model id accepted', start.model === MODEL, `thread on ${start.model}; instruction files: ${start.instructionSources.join(', ') || 'none'}`);

  const work = await runTurn(
    server,
    threadId,
    [
      'Remember the word PINEAPPLE for later. Then do these steps in order and report what happened for each:',
      '1) Run the shell command: node -e "console.log(6*7)"',
      '2) Create the file notes/hello.txt containing hi (use your file-editing tool).',
      '3) Create the file data/secret.txt containing x (use your file-editing tool).',
      `4) Using the shell, write x into ${join(outside, 'stray.txt')}`,
      `5) Read the file ${join(outside, 'readme.txt')} and quote its contents.`,
      'If a step is refused, do not retry it — just report it.',
    ].join('\n'),
    { sandboxPolicy },
  );
  const asked = server.serverRequests.map((r) => `${r.method.replace('item/', '').replace('/requestApproval', '')}:${(r.answer as { decision?: string })?.decision ?? 'answered'}`);
  record('turn completes', work.status === 'completed', `${work.status} in ${(work.ms / 1000).toFixed(1)}s · ${work.tokens} tokens · items: ${work.itemTypes.join(', ')}`);
  record('approvals reach the host', asked.length > 0, asked.join(', ') || 'no approval requests at all');
  record('commands ask', server.serverRequests.some((r) => r.method === 'item/commandExecution/requestApproval'), 'approvalPolicy untrusted');
  record('file edits ask', server.serverRequests.some((r) => r.method === 'item/fileChange/requestApproval'), 'approvalPolicy untrusted + workspaceWrite');
  record('in-project write landed', existsSync(join(ws, 'notes', 'hello.txt')), 'notes/hello.txt');
  record('data/ guard held', !existsSync(join(dataDir, 'secret.txt')), existsSync(join(dataDir, 'secret.txt')) ? 'data/secret.txt WAS WRITTEN' : 'data/secret.txt not written');
  record('outside write blocked', !existsSync(join(outside, 'stray.txt')), existsSync(join(outside, 'stray.txt')) ? 'stray.txt WAS WRITTEN' : 'stray.txt not written');
  record('outside read works', work.final.includes('OUTSIDE-README-CONTENT'), work.final.includes('OUTSIDE-README-CONTENT') ? 'quoted the sibling readme' : 'readme not quoted');
  record('developer instructions obeyed', /ZEBRA\s*\W*$/i.test(work.final.trim()), `final reply ends: "${work.final.trim().slice(-40)}"`);
  console.log(`\n  commands Codex ran (decided by Agent HQ's policy):\n${commandLog.map((line) => `    ${line}`).join('\n')}\n  final reply:\n    ${work.final.replace(/\n/g, '\n    ').slice(0, 900)}\n`);

  // Codex's own file-edit tool (apply_patch): does an edit inside the
  // project ask, and is an edit outside the sandbox stopped?
  const before = server.serverRequests.length;
  const patch = await runTurn(
    server,
    threadId,
    [
      'Use your apply_patch file-editing tool (NOT the shell) for both of these, and report what happened:',
      '1) create patched/a.txt containing hi',
      `2) create ${join(outside, 'patched-outside.txt')} containing x`,
    ].join('\n'),
    { sandboxPolicy },
  );
  const patchAsks = server.serverRequests.slice(before).map((r) => `${r.method.replace('item/', '').replace('/requestApproval', '')}:${(r.answer as { decision?: string })?.decision ?? 'answered'}`);
  record(
    'apply_patch edits',
    patch.itemTypes.includes('fileChange'),
    `items: ${patch.itemTypes.join(', ')} · asks: ${patchAsks.join(', ') || 'none'} · in-project landed: ${existsSync(join(ws, 'patched', 'a.txt'))} · outside landed: ${existsSync(join(outside, 'patched-outside.txt'))}`,
  );

  // Mid-run steering (Send while it's working).
  const mark = server.notes.length;
  const steerTurn = await server.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    effort: EFFORT,
    input: text('Run the shell command: node -e "setTimeout(()=>console.log(\'slow done\'),6000)" and then reply with one sentence about it.'),
  });
  await server.waitFor((n) => n.method === 'item/started' && (n.params['item'] as { type: string }).type === 'commandExecution', 120_000, mark).catch(() => undefined);
  let steered = true;
  try {
    await server.request('turn/steer', { threadId, expectedTurnId: steerTurn.turn.id, input: text('Also: make the very last word of your reply BANANA.') });
  } catch (error) {
    steered = false;
    record('mid-run message (turn/steer)', false, String(error));
  }
  const steerDone = await server.waitFor((n) => n.method === 'turn/completed' && (n.params['turn'] as { id: string }).id === steerTurn.turn.id, 180_000, mark);
  const steerFinal = server.notes
    .slice(mark)
    .filter((n) => n.method === 'item/completed' && (n.params['item'] as { type: string }).type === 'agentMessage')
    .map((n) => (n.params['item'] as { text: string }).text)
    .at(-1) ?? '';
  if (steered) record('mid-run message (turn/steer)', /BANANA/i.test(steerFinal), `${(steerDone.params['turn'] as { status: string }).status}; reply ends "${steerFinal.trim().slice(-40)}"`);

  // Interrupt (Stop that keeps the conversation).
  const mark2 = server.notes.length;
  const longTurn = await server.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    effort: EFFORT,
    input: text('Run the shell command: node -e "setTimeout(()=>{},90000)" and wait for it to finish before replying.'),
  });
  await server.waitFor((n) => n.method === 'item/started' && (n.params['item'] as { type: string }).type === 'commandExecution', 120_000, mark2).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const t0 = Date.now();
  await server.request('turn/interrupt', { threadId, turnId: longTurn.turn.id }).catch((error) => record('interrupt request', false, String(error)));
  const stopped = await server.waitFor((n) => n.method === 'turn/completed' && (n.params['turn'] as { id: string }).id === longTurn.turn.id, 60_000, mark2);
  const stopStatus = (stopped.params['turn'] as { status: string }).status;
  record('interrupt', stopStatus === 'interrupted', `${stopStatus} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Resume after a restart: a fresh app-server process remembers the thread.
  server.close();
  server = new AppServer(bin);
  await server.start();
  attachPolicy(server);
  await server.request('thread/resume', { threadId, cwd: ws, approvalPolicy: 'untrusted', sandbox: 'workspace-write', excludeTurns: true });
  const recall = await runTurn(server, threadId, 'What word did I ask you to remember at the start? Reply with just that word.');
  record('resume after restart keeps context', /PINEAPPLE/i.test(recall.final), `reply "${recall.final.trim().slice(0, 60)}"`);

  // Strict-JSON one-shot (what the master and quick checks need): read-only, no approvals.
  const judge = await server.request<{ thread: { id: string } }>('thread/start', { model: MODEL, cwd: ws, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
  const schema = {
    type: 'object',
    properties: { teamId: { type: 'string', enum: ['coding', 'design'] }, title: { type: 'string' } },
    required: ['teamId', 'title'],
    additionalProperties: false,
  };
  const routed = await runTurn(server, judge.thread.id, "Route this task to a team: 'make the login button blue and match the brand palette'. Teams: coding (builds and changes code), design (visual direction, mockups).", { outputSchema: schema });
  let parsed: { teamId?: string; title?: string } | null = null;
  try {
    parsed = JSON.parse(routed.final) as { teamId?: string; title?: string };
  } catch {
    parsed = null;
  }
  record('strict JSON turn (outputSchema)', !!parsed?.teamId && !!parsed.title, `${routed.final.slice(0, 80)} · ${(routed.ms / 1000).toFixed(1)}s · ${routed.tokens} tokens · tools used: ${routed.itemTypes.filter((t) => t !== 'agentMessage' && t !== 'reasoning').join(', ') || 'none'}`);

  // MCP isolation: what does a worker thread get, and can it be narrowed to
  // exactly a team's grants? Per-thread config first, then process-level
  // startup overrides (each in its own app-server).
  const mcpOn = async (target: AppServer, label: string, config: Record<string, unknown> | null) => {
    try {
      const thread = await target.request<{ thread: { id: string } }>('thread/start', { model: MODEL, cwd: ws, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, ...(config ? { config } : {}) });
      const list = await target.request<{ data: { name: string; runtimeStatus: unknown; tools: Record<string, unknown> }[] }>('mcpServerStatus/list', { threadId: thread.thread.id });
      return `${label}: [${list.data.map((entry) => `${entry.name}(${JSON.stringify(entry.runtimeStatus)},${Object.keys(entry.tools ?? {}).length} tools)`).join(', ')}]`;
    } catch (error) {
      return `${label}: error ${String(error).slice(0, 120)}`;
    }
  };
  const lines = [
    await mcpOn(server, 'default', null),
    await mcpOn(server, 'thread config mcp_servers.Roblox_Studio.enabled=false', { 'mcp_servers.Roblox_Studio.enabled': false }),
  ];
  for (const [label, args] of [
    ['startup --disable apps -c mcp_servers.Roblox_Studio.enabled=false', ['--disable', 'apps', '-c', 'mcp_servers.Roblox_Studio.enabled=false']],
    ['startup --disable apps -c mcp_servers={}', ['--disable', 'apps', '-c', 'mcp_servers={}']],
    [
      'startup --disable apps, only a granted test server',
      ['--disable', 'apps', '-c', 'mcp_servers.Roblox_Studio.enabled=false', '-c', 'mcp_servers.Granted_Probe={command="cmd.exe",args=["/c","exit"]}'],
    ],
  ] as [string, string[]][]) {
    const isolated = new AppServer(bin, args);
    try {
      await isolated.start();
      lines.push(await mcpOn(isolated, label, null));
    } catch (error) {
      lines.push(`${label}: error ${String(error).slice(0, 100)}`);
    } finally {
      isolated.close();
    }
  }
  // Exact = in the granted-only setup, Roblox_Studio is absent or disabled with no tools.
  const grantedLine = lines.find((line) => line.includes('only a granted')) ?? '';
  const exact = grantedLine.includes('Granted_Probe') && !/Roblox_Studio\([^)]*,[1-9]\d* tools\)/.test(grantedLine) && !/Roblox_Studio\("(ready|connected|running)"/i.test(grantedLine);
  record('MCP isolation (exactly the team grants)', exact, lines.join(' · '));

  // Two threads at once in one app-server.
  const pair = await Promise.all(
    ['ALPHA', 'OMEGA'].map(async (word) => {
      const thread = await server.request<{ thread: { id: string } }>('thread/start', { model: MODEL, cwd: ws, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
      return runTurn(server, thread.thread.id, `Reply with exactly the word ${word}.`);
    }),
  );
  record('two threads concurrently', pair[0]!.final.includes('ALPHA') && pair[1]!.final.includes('OMEGA'), pair.map((r) => `${r.final.trim()} (${(r.ms / 1000).toFixed(1)}s)`).join(' · '));
} catch (error) {
  record('spike run', false, `${error instanceof Error ? error.message : String(error)}${server.stderr ? ` · stderr: ${server.stderr.slice(-400)}` : ''}`);
} finally {
  for (const id of createdThreads) await server.request('thread/delete', { threadId: id }, 15_000).catch(() => undefined);
  server.close();
  // The sandbox helpers let go of the folder a moment after shutdown.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    console.log(`(couldn't remove ${root}: ${String(error).slice(0, 80)})`);
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks ok${failed.length ? ` — not ok: ${failed.map((f) => f.check).join('; ')}` : ''}`);
process.exit(0); // a spike reports findings; failures are findings, not errors
