// A stand-in for `codex app-server` (JSON-RPC over stdio, one object per
// line, no "jsonrpc" field) that replays the shapes test/codex-spike.live.ts
// recorded from the real one, so the Codex adapter can be tested offline.
// What a turn does is chosen by a keyword in its input text:
//   fake-work  a wrapped shell command, an in-project edit, an edit outside
//              the project, an edit into data/ — each asks for approval
//   fake-fail  the turn fails with a usage-limit error
//   fake-slow  a long command that only ends when the turn is interrupted
//   (other)    one agent message echoing the input
// `fake/log` returns every request the fake received, for assertions.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = [];
// Every request also goes to $FAKE_CODEX_LOG (one JSON per line) so a test
// can see exactly what the adapter sent.
const logFile = process.env.FAKE_CODEX_LOG;
let nextServerRequest = 1000;
const waiting = new Map(); // server request id -> resolve
const slowTurns = new Map(); // turnId -> finish()
const steerWaiters = new Map(); // turnId -> resolve(steered text)
let threadCounter = 0;
let turnCounter = 0;
const threads = new Map(); // threadId -> start params

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerRequest++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTurn(threadId, turnId, text) {
  const thread = threads.get(threadId) ?? {};
  const cwd = thread.cwd ?? process.cwd();
  const sep = cwd.includes('\\') ? '\\' : '/';
  const decisions = [];
  const item = async (item, approval) => {
    notify('item/started', { threadId, turnId, item, startedAtMs: Date.now() });
    if (approval) {
      const answer = await ask(approval, { threadId, turnId, itemId: item.id, startedAtMs: Date.now(), command: item.command });
      decisions.push(`${item.type}:${answer.decision ?? 'answered'}`);
    }
    notify('item/completed', { threadId, turnId, item, completedAtMs: Date.now() });
  };
  const finish = (status, error = null, message = null) => {
    if (message !== null) {
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text: message }, completedAtMs: Date.now() });
    }
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: 1234 }, last: { totalTokens: 1234 } } });
    notify('turn/completed', { threadId, turn: { id: turnId, status, items: [], error } });
  };

  if (text.includes('fake-work')) {
    await item(
      { type: 'commandExecution', id: `cmd-${turnId}`, command: `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'node -e "setTimeout(()=>console.log(42),10)"'`, status: 'inProgress' },
      'item/commandExecution/requestApproval',
    );
    await item({ type: 'fileChange', id: `edit-in-${turnId}`, changes: [{ path: `${cwd}${sep}notes${sep}ok.txt`, kind: 'add', diff: '+ok' }], status: 'inProgress' }, 'item/fileChange/requestApproval');
    await item({ type: 'fileChange', id: `edit-out-${turnId}`, changes: [{ path: `${cwd}${sep}..${sep}elsewhere${sep}x.txt`, kind: 'add', diff: '+x' }], status: 'inProgress' }, 'item/fileChange/requestApproval');
    await item({ type: 'fileChange', id: `edit-data-${turnId}`, changes: [{ path: `${cwd}${sep}data${sep}secret.txt`, kind: 'add', diff: '+x' }], status: 'inProgress' }, 'item/fileChange/requestApproval');
    finish('completed', null, `fake work done: ${decisions.join(', ')}`);
    return;
  }
  if (text.includes('fake-fail')) {
    finish('failed', { message: "You've hit your usage limit. Try again later." });
    return;
  }
  // "fake-steer": busy until a turn/steer arrives, then answers with it.
  if (text.includes('fake-steer')) {
    notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: `steer-cmd-${turnId}`, command: 'Start-Sleep 5', status: 'inProgress' }, startedAtMs: Date.now() });
    const steered = await new Promise((resolve) => steerWaiters.set(turnId, resolve));
    notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: `steer-cmd-${turnId}`, command: 'Start-Sleep 5', status: 'completed', exitCode: 0, aggregatedOutput: 'slept' }, completedAtMs: Date.now() });
    finish('completed', null, `steered: ${steered}`);
    return;
  }
  // "what did I say": answers from this thread's earlier inputs (resume).
  if (text.includes('what did I say')) {
    finish('completed', null, `you said: ${(thread.inputs ?? []).join(' | ')}`);
    return;
  }
  if (text.includes('fake-slow')) {
    notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: `slow-${turnId}`, command: 'Start-Sleep 600', status: 'inProgress' }, startedAtMs: Date.now() });
    await new Promise((resolve) => slowTurns.set(turnId, resolve));
    finish('interrupted', null, 'stopped');
    return;
  }
  await delay(5);
  finish('completed', null, `echo: ${text.slice(0, 200)}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  // A response to one of our server requests (approvals).
  if (message.id !== undefined && !message.method) {
    waiting.get(message.id)?.(message.result ?? {});
    waiting.delete(message.id);
    return;
  }
  if (!message.method) return;
  log.push({ method: message.method, params: message.params ?? {} });
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ method: message.method, params: message.params ?? {} })}\n`);
  if (message.id === undefined) return; // notification (initialized)
  const reply = (result) => send({ id: message.id, result });
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize':
      return reply({ userAgent: 'fake-codex', codexHome: '', platformFamily: 'test', platformOs: 'test' });
    case 'mcpServerStatus/list':
      return reply({ data: [{ name: 'Roblox_Studio', runtimeStatus: 'connected', tools: {} }], nextCursor: null });
    case 'thread/start': {
      const id = `thread-${++threadCounter}`;
      threads.set(id, params);
      return reply({ thread: { id }, model: params.model, cwd: params.cwd, instructionSources: [] });
    }
    case 'thread/name/set':
    case 'thread/archive':
    case 'thread/unarchive':
      return reply({});
    case 'thread/resume':
      // "owner-busy-…" stands for the owner's thread held open by their own
      // Codex window; "owner-…" for one that isn't open anywhere.
      if (String(params.threadId).startsWith('owner-busy-')) {
        return send({ id: message.id, error: { message: `thread ${params.threadId} already has an active writer` } });
      }
      if (String(params.threadId).startsWith('owner-')) threads.set(params.threadId, params);
      if (!threads.has(params.threadId)) return send({ id: message.id, error: { message: 'no such thread' } });
      return reply({ thread: { id: params.threadId } });
    case 'thread/fork': {
      const id = `fork-${++threadCounter}-of-${params.threadId}`;
      threads.set(id, params);
      return reply({ thread: { id } });
    }
    case 'turn/steer': {
      const waiter = steerWaiters.get(params.expectedTurnId);
      if (!waiter) return send({ id: message.id, error: { message: 'no active turn' } });
      steerWaiters.delete(params.expectedTurnId);
      waiter((params.input ?? []).map((input) => input.text ?? '').join(' '));
      return reply({});
    }
    case 'turn/start': {
      const turnId = `turn-${++turnCounter}`;
      reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
      const text = (params.input ?? []).map((input) => input.text ?? '').join('\n');
      const thread = threads.get(params.threadId);
      if (thread) (thread.inputs ??= []).push(text.slice(0, 80));
      void runTurn(params.threadId, turnId, text);
      return;
    }
    case 'turn/interrupt':
      slowTurns.get(params.turnId)?.();
      slowTurns.delete(params.turnId);
      return reply({});
    case 'account/rateLimits/read':
      return reply({ rateLimits: { planType: 'test', primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1790000000 }, secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1789000000 } } });
    case 'fake/log':
      return reply({ log });
    default:
      return reply({});
  }
});
