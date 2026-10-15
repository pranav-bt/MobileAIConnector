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
