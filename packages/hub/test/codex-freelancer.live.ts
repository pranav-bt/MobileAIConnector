// LIVE Codex freelancers, product code only:
//   1. the session reader on the owner's REAL ~/.codex — read-only, prints
//      counts only (never names or content);
//   2. the engine on THROWAWAY threads (never the owner's): a thread another
//      Codex process holds open is continued in a fork (same history), and
//      once it's free, in place; neither is archived. Then the throwaway
//      rollouts are deleted.
//   npx tsx test/codex-freelancer.live.ts     Spends a little Codex usage.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveModel, type Team } from '@agent-hq/shared';
import { codexRollouts, codexSessionFacts, heldCodexThreads } from '../src/codex-sessions.js';
import { CodexEngine } from '../src/engine/codex.js';
import { AppServerClient, findCodexBinary } from '../src/engine/codex-rpc.js';
import { openSync, readSync, closeSync, statSync } from 'node:fs';

const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};
const bin = findCodexBinary();
if (!bin) {
  console.log('no codex binary — skipping');
  process.exit(0);
}
const codexHome = join(homedir(), '.codex');

// 1. The reader on the real ~/.codex (counts only).
{
  const started = Date.now();
  const files = await codexRollouts(codexHome, Date.now(), 30 * 24 * 60 * 60_000);
  const held = await heldCodexThreads(codexHome);
  let owner = 0;
  let skipped = 0;
  for (const path of files) {
    const size = statSync(path).size;
    const fd = openSync(path, 'r');
    const head = Buffer.alloc(Math.min(8192, size));
    readSync(fd, head, 0, head.length, 0);
    const tailLength = Math.min(65536, size);
    const tail = Buffer.alloc(tailLength);
    readSync(fd, tail, 0, tailLength, size - tailLength);
    closeSync(fd);
    if (codexSessionFacts(basename(path), head.toString('utf8'), tail.toString('utf8'))) owner += 1;
    else skipped += 1;
  }
  record(
    'reader on the real ~/.codex',
    Date.now() - started < 5000,
    `${files.length} rollouts in 30 days: ${owner} of the owner's sessions, ${skipped} skipped (ours / exec / sub-agents); ${held.size} held open right now; ${Date.now() - started} ms`,
  );
}

// 2. The engine on throwaway threads.
const cwd = mkdtempSync(join(tmpdir(), 'agent-hq-codexfl-live-'));
const created: string[] = [];
const team = { id: 'freelance', name: 'Freelance desk', charter: 'x', allowedTools: ['read', 'edit', 'bash'], blockedTools: [], leadModel: 'opus', workerModel: 'codex', maxConcurrentWorkers: 1, quotaSharePct: 0, memoryDir: '', mcpServers: {}, createdAt: 0 } as Team;
const engine = new CodexEngine();
const model = resolveModel('codex', { model: 'gpt-6-luna', effort: 'low' });
const activity: string[] = [];
const callbacks = { onActivity: (line: string) => activity.push(line), onTokens: () => {}, onPermission: async () => 'approve' as const };
try {
  // The "owner's window": another app-server holding a thread it started.
  const window = new AppServerClient(bin, ['--disable', 'apps', 'app-server']);
  await window.initialize();
  const { thread } = await window.request<{ thread: { id: string } }>('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-luna' });
  created.push(thread.id);
  await window.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Remember the word OSPREY. Reply with OK.' }], effort: 'low' });
  await new Promise<void>((resolve) => {
    const off = window.onNotification((note) => {
      if (note.method === 'turn/completed') {
        off();
        resolve();
      }
    });
  });

  const forked = await engine.runWorker({ prompt: 'What word did I ask you to remember? One word.', team, model, cwd, resumeSessionId: thread.id, foreign: true, callbacks });
  if (forked.sessionId) created.push(forked.sessionId);
  record(
    'held open → continued in a fork, same history',
    !!forked.sessionId && forked.sessionId !== thread.id && /OSPREY/i.test(forked.synopsis) && activity.some((line) => line.startsWith('the conversation is open in a Codex window')),
    `fork ${forked.sessionId?.slice(0, 13)}…; reply ${JSON.stringify(forked.synopsis.slice(0, 40))}`,
  );
  window.close();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const inPlace = await engine.runWorker({ prompt: 'And the word again? One word.', team, model, cwd, resumeSessionId: thread.id, foreign: true, callbacks });
  record('free → continued in place', inPlace.sessionId === thread.id && /OSPREY/i.test(inPlace.synopsis), `reply ${JSON.stringify(inPlace.synopsis.slice(0, 40))}`);
  const archived = existsSync(join(codexHome, 'archived_sessions')) && readdirSync(join(codexHome, 'archived_sessions')).some((file) => file.includes(thread.id));
  record('never archived', !archived, archived ? 'the thread was archived' : 'left where it was');
} catch (error) {
  record('engine', false, error instanceof Error ? error.message : String(error));
} finally {
  engine.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const walk = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])) : [];
  const all = [...walk(join(codexHome, 'sessions')), ...walk(join(codexHome, 'archived_sessions'))];
  for (const id of created) {
    for (const path of all.filter((file) => file.includes(id))) rmSync(path, { force: true });
    rmSync(join(codexHome, 'thread-writer-locks', `${id}.lock`), { force: true });
  }
  rmSync(cwd, { recursive: true, force: true });
  console.log(`cleaned up ${created.length} throwaway thread(s)`);
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? `CODEX FREELANCER LIVE PASS (${results.length} checks)` : `CODEX FREELANCER LIVE FAIL: ${failed.map((f) => f.check).join('; ')}`);
process.exit(failed.length === 0 ? 0 : 1);
