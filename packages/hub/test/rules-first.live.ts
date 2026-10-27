// LIVE: real workers end their reports with the fixed lines, and the hub
// decides from them. A temp hub (own port, temp data) runs:
//  1. a Coding task that changes a file → STATUS read (review skipped if the
//     report is short), QA by the default rule, QA's VERDICT read from its
//     report, HAND-OFFS: none → no coordination call (fresh master rules);
//  2. a Design task (no shell) → no QA pass;
//  3. a Coding task that only reads → "nothing was changed", no QA.
//   npx tsx test/rules-first.live.ts [--model gpt-6.1-sol]   (workers on that model)
// Spends a little usage.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, parseReportLines, type ClientCommand, type HubEvent, type TranscriptEntry } from '@agent-hq/shared';
import { startHub } from '../src/index.js';

const PORT = 4660;
const modelArg = process.argv.indexOf('--model');
const workerModel = modelArg > 0 ? process.argv[modelArg + 1] : undefined;
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${check} — ${detail}`);
};

const sandbox = mkdtempSync(join(tmpdir(), 'agent-hq-rules-live-'));
const project = join(sandbox, 'Ruleslive');
mkdirSync(project, { recursive: true });
writeFileSync(join(project, 'greet.js'), "export function greet(name) {\n  return 'Hello ' + name;\n}\n");
writeFileSync(join(project, 'greet.test.mjs'), "import { greet } from './greet.js';\nif (greet('Ana') !== 'Hello Ana') throw new Error('greet');\nconsole.log('tests pass');\n");
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'ruleslive', type: 'module', scripts: { test: 'node greet.test.mjs' } }, null, 2));

const hub = await startHub({
  engine: 'claude',
  port: PORT,
  dataDir: join(sandbox, 'data'),
  generalDir: join(sandbox, 'general'),
  claudeProjectsDir: mkdtempSync(join(tmpdir(), 'agent-hq-rules-live-claude-')),
  claudeConfigPath: join(sandbox, 'no-claude.json'),
  accessGrants: [],
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'test sandbox' }],
  detectApps: () => [],
});
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const events: HubEvent[] = [];
const waiters: { test: (e: HubEvent) => boolean; resolve: (e: HubEvent) => void }[] = [];
const send = (command: ClientCommand) => ws.send(encodeCommand(command));
ws.on('message', (raw) => {
  const event = decodeEvent(raw.toString());
  if (!event) return;
  events.push(event);
  // Approve any card a worker raises (a temp project; nothing outside it).
  if (event.type === 'permission.updated' && event.request.status === 'pending' && event.request.agentId !== 'master') {
    send({ type: 'permission.respond', requestId: event.request.id, decision: 'approve', scope: 'once' });
  }
  for (const waiter of [...waiters]) if (waiter.test(event)) (waiters.splice(waiters.indexOf(waiter), 1), waiter.resolve(event));
});
const waitFor = (label: string, test: (e: HubEvent) => boolean, timeoutMs = 900_000, from = 0): Promise<HubEvent> => {
  const already = events.slice(from).find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (e) => (clearTimeout(timer), resolve(e)) });
  });
};
const rows = (taskId: string) => {
  const byId = new Map<string, TranscriptEntry>();
  for (const e of events) if (e.type === 'task.transcript' && e.taskId === taskId) for (const entry of e.entries) byId.set(entry.id, entry);
  return [...byId.values()];
};
const lastReport = (taskId: string, stepId?: string) =>
  rows(taskId)
    .filter((row) => row.role === 'worker' && row.kind === 'message' && (stepId ? row.stepTaskId === stepId : !row.stepTaskId))
    .map((row) => row.text)
    .at(-1) ?? '';
const run = async (text: string, marker: string, extraWait?: (id: string, from: number) => Promise<unknown>) => {
  const from = events.length;
  send({ type: 'task.submit', text });
  const created = await waitFor(`created ${marker}`, (e) => e.type === 'task.updated' && e.task.detail.includes(marker) && !e.task.rootTaskId, 120_000, from);
  const id = created.type === 'task.updated' ? created.task.id : '';
  send({ type: 'task.watch', taskId: id });
  await waitFor(`${marker} finished`, (e) => e.type === 'task.updated' && e.task.id === id && ['done', 'failed', 'paused'].includes(e.task.status), 900_000, from);
  if (extraWait) await extraWait(id, from);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return { id, from, said: (pattern: RegExp) => rows(id).some((row) => pattern.test(row.text)) };
};

try {
  await new Promise<void>((resolve) => ws.on('open', () => resolve()));
  send({ type: 'hello', client: 'cli', name: 'rules-first-live' });
  await waitFor('snapshot', (e) => e.type === 'snapshot');
  send({ type: 'project.register', name: 'Ruleslive', workspaceDir: project });
  await waitFor('project', (e) => e.type === 'project.updated' && e.project.workspaceDir === project);
  if (workerModel) {
    send({ type: 'models.set', overrides: { worker: { model: workerModel }, teams: {} } });
    await waitFor('model', (e) => e.type === 'hub.updated' && e.info.modelOverrides.worker?.model === workerModel);
  }

  // 1. Coding, changes a file → QA by the default rule; both reports carry the lines.
  let qaId = '';
  const coding = await run(
    '@ruleslive coding: rules-live-1 make greet() trim the name before greeting (greet("  Ana ") returns "Hello Ana") and add that case to greet.test.mjs',
    'rules-live-1',
    async (_id, from) => {
      const qa = await waitFor('QA queued', (e) => e.type === 'task.updated' && e.task.title.startsWith('[QA]') && e.task.detail.includes('rules-live-1'), 120_000, from);
      qaId = qa.type === 'task.updated' ? qa.task.id : '';
      await waitFor('QA verdict', (e) => e.type === 'activity' && e.entry.message.startsWith('QA verdict:'), 900_000, from);
    },
  );
  const report = parseReportLines(lastReport(coding.id));
  record('coding report ends with STATUS', report.status === 'done', `status ${report.status} · body ${report.body.length} chars`);
  record('coding report lists HAND-OFFS', report.handoffs !== null, JSON.stringify(report.handoffs));
  record('coding report has a LEARNED line', report.learned !== null, JSON.stringify(report.learned));
  record(
    'lead review: skipped when short, reviewed when long',
    coding.said(/report taken as written/) === (report.body.length <= 900 && report.body.split('\n').length <= 12 && !/\bconflict/i.test(report.body)),
    coding.said(/report taken as written/) ? 'taken as written' : 'reviewed by the lead',
  );
  record('QA by the default rule', events.slice(coding.from).some((e) => e.type === 'activity' && /QA follow-up queued for: .*\(your QA rules\)/.test(e.entry.message)), qaId);
  const qaReport = parseReportLines(lastReport(coding.id, qaId));
  record('QA report ends with VERDICT', qaReport.verdict !== null, `verdict ${qaReport.verdict}${qaReport.issues ? ` — ${qaReport.issues.slice(0, 80)}` : ''}`);
  record('QA verdict read from the report', coding.said(/QA verdict read from the report/), coding.said(/QA verdict read from the report/) ? 'no evaluation call' : 'went to the model');
  record(
    'no coordination call on HAND-OFFS: none',
    report.handoffs?.length === 0 ? coding.said(/no hand-offs listed — no coordination call/) : true,
    report.handoffs?.length === 0 ? 'skipped' : 'hand-offs listed: coordination ran',
  );

  // 2. Design (no shell) → no QA.
  const design = await run('@ruleslive design: rules-live-2 suggest three friendlier greeting phrases for greet()', 'rules-live-2');
  record('design: no QA pass', design.said(/no QA pass — /), `${rows(design.id).find((row) => /no QA pass/.test(row.text))?.text ?? '(none)'} · ${parseReportLines(lastReport(design.id)).status ?? 'no STATUS'}`);

  // 3. Coding that only reads → nothing changed, no QA.
  const reading = await run('@ruleslive coding: rules-live-3 read greet.js and tell me in one sentence what it does — do not change any file', 'rules-live-3');
  record('read-only coding: no QA pass', reading.said(/no QA pass — nothing was changed/), parseReportLines(lastReport(reading.id)).status ?? 'no STATUS');
  console.log(`worker model: ${workerModel ?? 'team default'}`);
} catch (error) {
  record('run', false, error instanceof Error ? error.message : String(error));
} finally {
  ws.close();
  await hub.close();
}
const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? `RULES FIRST LIVE PASS (${results.length} checks)` : `RULES FIRST LIVE FAIL: ${failed.map((f) => f.check).join('; ')}`);
process.exit(failed.length === 0 ? 0 : 1);
