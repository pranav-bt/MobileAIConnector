// Probe for Codex freelancers (no product code), on THROWAWAY threads only —
// never the owner's: how does Codex mark a thread that a process has open
// (thread-writer-locks), what does Agent HQ's own rollout say about itself
// (originator/source, to skip our own threads), and what happens when a
// SECOND process resumes / continues / forks a thread the first one holds
// (the VS Code extension holding the owner's thread, in real life)?
// Cheapest model, tiny turns; deletes the rollouts it created.
//   npx tsx test/probe-codex-freelancer.ts
import { existsSync, mkdtempSync, openSync, closeSync, readdirSync, rmSync, statSync, readSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient, findCodexBinary } from '../src/engine/codex-rpc.js';

const bin = findCodexBinary();
if (!bin) {
  console.log('no codex binary — nothing to probe');
  process.exit(0);
}
const codexHome = join(homedir(), '.codex');
const cwd = mkdtempSync(join(tmpdir(), 'agent-hq-fl-probe-'));
const findings: [string, string][] = [];
const note = (what: string, detail: string) => {
  findings.push([what, detail]);
  console.log(`· ${what}: ${detail}`);
};

function rolloutOf(threadId: string): string | null {
  const walk = (dir: string): string | null => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(path);
        if (found) return found;
      } else if (entry.name.includes(threadId)) return path;
    }
    return null;
  };
  for (const root of ['sessions', 'archived_sessions']) {
    const dir = join(codexHome, root);
    if (existsSync(dir)) {
      const found = walk(dir);
      if (found) return found;
    }
  }
  return null;
}

function firstLine(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(64 * 1024, statSync(path).size));
    readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8').split('\n')[0] ?? '';
  } finally {
    closeSync(fd);
  }
}

// "busy" = another process holds the lock (Windows refuses even a read open).
function lockState(threadId: string): string {
  const path = join(codexHome, 'thread-writer-locks', `${threadId}.lock`);
  if (!existsSync(path)) return 'no lock file';
  try {
    closeSync(openSync(path, 'r'));
    return 'lock file, free';
  } catch (error) {
    return `lock file, held (${(error as NodeJS.ErrnoException).code})`;
  }
}

const start = async (label: string) => {
  const client = new AppServerClient(bin, ['--disable', 'apps', 'app-server']);
  await client.initialize();
  void label;
  return client;
};
const turn = async (client: AppServerClient, threadId: string, text: string): Promise<string> => {
  let reply = '';
  const done = new Promise<void>((resolve) => {
    const off = client.onNotification((n) => {
      if (n.method === 'item/completed' && (n.params['item'] as { type?: string; text?: string })?.type === 'agentMessage') {
        reply = String((n.params['item'] as { text?: string }).text ?? '');
      }
      if (n.method === 'turn/completed') {
        off();
        resolve();
      }
    });
  });
  await client.request('turn/start', { threadId, input: [{ type: 'text', text }], effort: 'low' });
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 120_000))]);
  return reply;
};
const settings = { cwd, approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-6-luna' };
const created: string[] = [];

try {
  const a = await start('A');
  const { thread } = await a.request<{ thread: { id: string } }>('thread/start', settings);
  created.push(thread.id);
  note('A started thread', thread.id);
  note('lock before any turn', lockState(thread.id));
  note('A turn', JSON.stringify((await turn(a, thread.id, 'Reply with exactly: OK-A')).slice(0, 40)));
  note('lock while A holds it', lockState(thread.id));
  const rollout = rolloutOf(thread.id);
  if (rollout) {
    const meta = JSON.parse(firstLine(rollout)) as { type?: string; payload?: Record<string, unknown> };
    note('our rollout meta', JSON.stringify({ type: meta.type, originator: meta.payload?.['originator'], source: meta.payload?.['source'] }));
  } else note('our rollout', 'not found');

  const b = await start('B');
  try {
    await b.request('thread/resume', { threadId: thread.id, ...settings, excludeTurns: true }, 30_000);
    note('B resume while A holds it', 'ok');
    try {
      note('B turn while A holds it', JSON.stringify((await turn(b, thread.id, 'Reply with exactly: OK-B')).slice(0, 40)));
    } catch (error) {
      note('B turn while A holds it', `error: ${(error as Error).message.slice(0, 160)}`);
    }
  } catch (error) {
    note('B resume while A holds it', `error: ${(error as Error).message.slice(0, 160)}`);
  }
  try {
    const forked = await b.request<{ thread: { id: string } }>('thread/fork', { threadId: thread.id, ...settings }, 30_000);
    created.push(forked.thread.id);
    note('B fork while A holds it', `ok → ${forked.thread.id}`);
    note('B turn on the fork', JSON.stringify((await turn(b, forked.thread.id, 'What did you reply last time? One line.')).slice(0, 80)));
  } catch (error) {
    note('B fork while A holds it', `error: ${(error as Error).message.slice(0, 160)}`);
  }
  // A still works after B touched it?
  try {
    note('A turn after B', JSON.stringify((await turn(a, thread.id, 'Reply with exactly: OK-A2')).slice(0, 40)));
  } catch (error) {
    note('A turn after B', `error: ${(error as Error).message.slice(0, 160)}`);
  }
  a.close();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  note('lock after A closed', lockState(thread.id));
  b.close();
} catch (error) {
  note('probe', `error: ${(error as Error).message}`);
} finally {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const id of created) {
    const path = rolloutOf(id);
    if (path) rmSync(path, { force: true });
    rmSync(join(codexHome, 'thread-writer-locks', `${id}.lock`), { force: true });
  }
  rmSync(cwd, { recursive: true, force: true });
  console.log(`\ncleaned up ${created.length} probe thread(s)`);
}
process.exit(0);
