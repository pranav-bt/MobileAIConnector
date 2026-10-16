// The Codex adapter against a fake app-server (test/fixtures/fake-codex-app-
// server.mjs, shaped on what the spike recorded from the real one): every
// approval goes through Agent HQ's rules, the write lock and data/ lock hold,
// MCP is exactly the team's grants, failures and interrupts surface, and the
// thread id comes back for continuing later. No Codex usage.
//   npx tsx test/codex-engine.smoke.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModel, type Team } from '@agent-hq/shared';
import { CodexEngine, unwrapShellCommand } from '../src/engine/codex.js';
import { MessageInbox } from '../src/engine/inbox.js';
import type { EngineRow } from '../src/engine/types.js';
import { evaluatePermission } from '../src/orchestrator/policy.js';

function fail(message: string): never {
  console.error(`CODEX ENGINE SMOKE FAIL: ${message}`);
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'codex-engine-smoke-'));
const project = join(root, 'project');
const dataDir = join(project, 'data');
mkdirSync(dataDir, { recursive: true });
const logFile = join(root, 'fake.log');
process.env['FAKE_CODEX_LOG'] = logFile;
const requests = () =>
  readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });

const fake = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const engine = new CodexEngine({ command: process.execPath, args: [fake] });
const model = resolveModel('sonnet', { model: 'gpt-6.1-sol', effort: 'ultra' });
if (model.engine !== 'codex' || model.effort !== 'ultra') fail(`gpt-6.1-sol did not resolve to codex/ultra: ${JSON.stringify(model)}`);
if (resolveModel('opus', { effort: 'ultra' }).effort) fail('a Claude model accepted Codex-only effort "ultra"');

const team = (mcpServers: Record<string, unknown> = {}): Team =>
  ({
    id: 'coding',
    name: 'Coding team',
    charter: 'Builds, tests, and refactors code.',
    allowedTools: ['read', 'edit', 'bash'],
    blockedTools: [],
    leadModel: 'opus',
    workerModel: 'codex',
    maxConcurrentWorkers: 2,
    quotaSharePct: 10,
    memoryDir: '',
    mcpServers,
    createdAt: 0,
  }) as Team;

try {
  // 0. The policy regression the spike found: Codex's wrapper + an arrow.
  const wrapped = `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "node -e \\"setTimeout(()=>{},90000)\\""`;
  if (unwrapShellCommand(wrapped) !== 'node -e "setTimeout(()=>{},90000)"') fail(`unwrap wrong: ${unwrapShellCommand(wrapped)}`);
  const verdict = evaluatePermission('Bash', unwrapShellCommand(wrapped), 'auto', { cwd: project, extraDirs: [] });
  if (verdict.decision !== 'allow') fail(`arrow function still flagged: ${JSON.stringify(verdict)}`);
  if (evaluatePermission('Bash', 'node -e "x=>1" > ../elsewhere/out.txt', 'auto', { cwd: project, extraDirs: [] }).decision !== 'ask') {
    fail('a real redirect after an arrow was not flagged');
  }
  console.log('policy ok: wrapper unwrapped, => is not a redirect, real redirects still ask');

  // 1. One-shot calls (routing, reviews, quick checks): read-only, no approvals, no MCP.
  const answer = await engine.complete({ prompt: 'route this please', model });
  if (!answer.text.includes('route this please') || answer.tokens !== 1234) fail(`complete() wrong: ${JSON.stringify(answer)}`);
  const checkThread = requests().find((r) => r.method === 'thread/start')!;
  const checkConfig = checkThread.params['config'] as Record<string, unknown>;
  if (checkThread.params['approvalPolicy'] !== 'never' || checkThread.params['sandbox'] !== 'read-only' || checkThread.params['ephemeral'] !== true) {
    fail(`one-shot thread not locked down: ${JSON.stringify(checkThread.params)}`);
  }
  if (checkConfig['mcp_servers.Roblox_Studio.enabled'] !== false) fail('one-shot call kept the PC\'s MCP servers');
  const effortSent = requests().find((r) => r.method === 'turn/start')!.params['effort'];
  if (effortSent !== 'ultra') fail(`effort not passed: ${String(effortSent)}`);
  console.log('complete ok: read-only, never asks, MCP off, effort passed');

  // 2. A worker: every action asks Agent HQ, and the locks hold.
  const permissions: { toolName: string; command: string }[] = [];
  const activity: string[] = [];
  const rows = new Map<string, EngineRow>();
  let sessionSeen = '';
  let tokens = 0;
  const result = await engine.runWorker({
    prompt: 'fake-work please',
    team: team(),
    model,
    cwd: project,
    extraDirs: [],
    locked: { dir: dataDir, open: [] },
    title: 'Tidy the loader',
    callbacks: {
      onActivity: (line) => activity.push(line),
      onTranscript: (row) => rows.set(row.id, row),
      onSession: (id) => (sessionSeen = id),
      onTokens: (total) => (tokens = total),
      onPermission: async (request) => {
        permissions.push({ toolName: request.toolName, command: request.command });
        return 'approve';
      },
    },
  });
  const bash = permissions.find((p) => p.toolName === 'Bash');
  if (!bash || bash.command !== 'node -e "setTimeout(()=>console.log(42),10)"') fail(`command not unwrapped for the policy: ${JSON.stringify(permissions)}`);
  if (!permissions.some((p) => p.toolName === 'Edit' && p.command.includes('ok.txt'))) fail('in-project edit did not ask the policy');
  if (permissions.some((p) => p.command.includes('elsewhere') || p.command.includes('secret.txt'))) fail('a refused edit reached the policy instead of being blocked');
  if (!/fileChange:accept, fileChange:decline, fileChange:decline/.test(result.synopsis) || !/commandExecution:accept/.test(result.synopsis)) {
    fail(`decisions wrong: ${result.synopsis}`);
  }
  if (!activity.some((line) => line.startsWith('blocked: write outside this project'))) fail('outside edit not reported');
  if (!activity.some((line) => line.startsWith("blocked: write into Agent HQ's own data"))) fail('data/ edit not reported');
  if (tokens !== 1234 || result.tokens !== 1234) fail(`tokens not reported: ${tokens}/${result.tokens}`);
  if (!result.sessionId?.startsWith('thread-')) fail(`no session id: ${String(result.sessionId)}`);
  const workerThread = requests().filter((r) => r.method === 'thread/start').at(-1)!;
  const workerConfig = workerThread.params['config'] as Record<string, unknown>;
  if (workerThread.params['approvalPolicy'] !== 'untrusted' || workerThread.params['sandbox'] !== 'workspace-write') fail('worker thread does not route every action to us');
  if (!String(workerThread.params['developerInstructions']).includes('Builds, tests, and refactors code.')) fail('charter not in developer instructions');
  if (workerConfig['mcp_servers.Roblox_Studio.enabled'] !== false) fail('ungranted MCP server not disabled');
  const workerTurn = requests().filter((r) => r.method === 'turn/start').at(-1)!;
  const sandbox = workerTurn.params['sandboxPolicy'] as { writableRoots: string[]; type: string };
  if (sandbox.type !== 'workspaceWrite' || sandbox.writableRoots.join('|') !== project) fail(`sandbox wrong: ${JSON.stringify(sandbox)}`);
  if (!requests().some((r) => r.method === 'thread/name/set' && String(r.params['name']).includes('Tidy the loader'))) fail('thread not labelled');
  if (!requests().some((r) => r.method === 'thread/archive' && r.params['threadId'] === result.sessionId)) fail('thread not archived after the run');
  console.log('worker ok: commands + edits ask Agent HQ, outside/data edits blocked, tokens, labelled + archived thread');

  // 2b. Console rows: the command row ends 'ok' with its output, edits are
  // diff rows, the reply is a message row; files changed; session reported early.
  const command = [...rows.values()].find((row) => row.kind === 'tool' && row.tool === 'shell');
  if (!command || command.state !== 'ok' || command.text !== 'node -e "setTimeout(()=>console.log(42),10)"') fail(`command row wrong: ${JSON.stringify(command)}`);
  if (![...rows.values()].some((row) => row.kind === 'diff' && row.text.includes('ok.txt'))) fail('no diff row for the edit');
  if (![...rows.values()].some((row) => row.kind === 'message' && row.text.startsWith('fake work done'))) fail('no message row');
  if (!result.filesChanged) fail('files changed not reported');
  if (sessionSeen !== result.sessionId) fail('session not reported as it started');
  console.log('rows ok: command/diff/message rows, files changed, session reported early');

  // 2c. Continue the same conversation: unarchived + resumed, it remembers.
  const resumed = await engine.runWorker({
    prompt: 'what did I say before?',
    team: team(),
    model,
    cwd: project,
    resumeSessionId: result.sessionId,
    callbacks: { onActivity: () => {}, onTokens: () => {}, onPermission: async () => 'approve' },
  });
  if (resumed.sessionId !== result.sessionId || !/fake-work please/.test(resumed.synopsis)) fail(`resume forgot: ${resumed.synopsis}`);
  if (!requests().some((r) => r.method === 'thread/unarchive' && r.params['threadId'] === result.sessionId)) fail('archived thread not unarchived');
  if (!requests().some((r) => r.method === 'thread/resume' && r.params['threadId'] === result.sessionId)) fail('thread not resumed');
  console.log('resume ok: same thread unarchived + resumed, it remembered');

  // 2c'. The owner's own thread (a Codex freelancer): left as it is — never
  // unarchived/archived, no Agent HQ instructions or MCP changes — but every
  // action still asks; when their Codex window holds it, a fork continues.
  const before = requests().length;
  const ownerAsks: string[] = [];
  const ownerActivity: string[] = [];
  const free = await engine.runWorker({
    prompt: 'fake-work for the owner',
    team: team(),
    model,
    cwd: project,
    resumeSessionId: 'owner-free-1',
    foreign: true,
    callbacks: { onActivity: (line) => ownerActivity.push(line), onTokens: () => {}, onPermission: async (request) => (ownerAsks.push(request.toolName), 'approve') },
  });
  const busy = await engine.runWorker({
    prompt: 'more for the owner',
    team: team(),
    model,
    cwd: project,
    resumeSessionId: 'owner-busy-2',
    foreign: true,
    callbacks: { onActivity: (line) => ownerActivity.push(line), onTokens: () => {}, onPermission: async () => 'approve' },
  });
  const ownerCalls = requests().slice(before);
  if (free.sessionId !== 'owner-free-1') fail(`a free owner thread was not continued in place: ${free.sessionId}`);
  if (!busy.sessionId?.startsWith('fork-') || !busy.sessionId.endsWith('owner-busy-2')) fail(`a held owner thread was not forked: ${busy.sessionId}`);
  if (!ownerActivity.some((line) => line.startsWith('the conversation is open in a Codex window'))) fail('the fork was not explained');
  if (ownerCalls.some((r) => r.method === 'thread/archive' || r.method === 'thread/unarchive')) fail("the owner's thread was archived/unarchived");
  const ownerResume = ownerCalls.find((r) => r.method === 'thread/resume' && r.params['threadId'] === 'owner-free-1')!;
  if ('developerInstructions' in ownerResume.params || 'config' in ownerResume.params) fail(`the owner's thread got Agent HQ settings: ${JSON.stringify(ownerResume.params)}`);
  if (ownerResume.params['approvalPolicy'] !== 'untrusted' || !ownerAsks.includes('Bash')) fail('actions in the owner\'s thread did not ask Agent HQ');
  console.log("owner thread ok: continued in place when free, forked when their window holds it; never archived, no HQ settings; actions still ask");

  // 2d. A message while a turn runs is steered into it.
  const inbox = new MessageInbox();
  const steering = engine.runWorker({
    prompt: 'fake-steer wait for me',
    team: team(),
    model,
    cwd: project,
    inbox,
    callbacks: { onActivity: () => {}, onTokens: () => {}, onPermission: async () => 'approve' },
  });
  setTimeout(() => inbox.push('BANANA'), 300);
  const steered = await steering;
  if (!/steered: BANANA/.test(steered.synopsis)) fail(`steer not delivered: ${steered.synopsis}`);
  console.log('steer ok: message delivered into the running turn');

  // 3. MCP grants: a granted server is kept and configured, not disabled.
  await engine.runWorker({
    prompt: 'hello',
    team: team({ Roblox_Studio: { type: 'stdio', command: 'cmd.exe', args: ['/c', 'mcp.bat'], env: {} } }),
    model,
    cwd: project,
    callbacks: { onActivity: () => {}, onTokens: () => {}, onPermission: async () => 'approve' },
  });
  const grantedConfig = requests().filter((r) => r.method === 'thread/start').at(-1)!.params['config'] as Record<string, unknown>;
  const granted = grantedConfig['mcp_servers.Roblox_Studio'] as { command?: string; args?: string[] } | undefined;
  if (grantedConfig['mcp_servers.Roblox_Studio.enabled'] === false || granted?.command !== 'cmd.exe' || granted.args?.join(' ') !== '/c mcp.bat') {
    fail(`granted server not passed: ${JSON.stringify(grantedConfig)}`);
  }
  console.log('mcp ok: exactly the team grants');

  // 4. A failed turn surfaces as an error (the stuck pass reads the message).
  const failed = await engine
    .runWorker({ prompt: 'fake-fail', team: team(), model, cwd: project, callbacks: { onActivity: () => {}, onTokens: () => {}, onPermission: async () => 'approve' } })
    .then(() => null)
    .catch((error: Error) => error.message);
  if (!failed || !/usage limit/i.test(failed)) fail(`failure not surfaced: ${String(failed)}`);
  console.log('failure ok: surfaced as an error');

  // 5. Stop: aborting interrupts the turn.
  const controller = new AbortController();
  const slow = engine.runWorker({ prompt: 'fake-slow', team: team(), model, cwd: project, signal: controller.signal, callbacks: { onActivity: () => {}, onTokens: () => {}, onPermission: async () => 'approve' } });
  setTimeout(() => controller.abort(), 200);
  const stopped = await Promise.race([slow, new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))]);
  if (!stopped || !requests().some((r) => r.method === 'turn/interrupt')) fail('abort did not interrupt the turn');
  console.log('stop ok: abort interrupts the turn');

  // 6. Plan limits for the Resources page.
  const limits = await engine.rateLimits();
  if (!limits || limits.weeklyPct !== 12 || limits.windowPct !== 40 || limits.weeklyResetsAt !== 1790000000000) fail(`rate limits wrong: ${JSON.stringify(limits)}`);
  console.log('limits ok: short window + weekly mapped');
} finally {
  engine.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
console.log('CODEX ENGINE SMOKE PASS');
process.exit(0);
