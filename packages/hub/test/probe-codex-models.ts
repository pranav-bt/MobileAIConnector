// Which Codex models does this account offer (model/list — no usage), and
// with --live, does each one actually run a turn (a tiny one, effort low)?
// Feeds CODEX_MODELS in shared/schema.ts.
//   npx tsx test/probe-codex-models.ts [--live]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerClient, findCodexBinary, type Notification } from '../src/engine/codex-rpc.js';

const bin = findCodexBinary();
if (!bin) {
  console.error('no Codex binary found');
  process.exit(1);
}
const live = process.argv.includes('--live');
const client = new AppServerClient(bin, ['--disable', 'apps', 'app-server']);
await client.initialize();
type Model = { id: string; displayName: string; hidden: boolean; supportedReasoningEfforts: { reasoningEffort: string }[]; defaultReasoningEffort: string; description: string };
const { data } = await client.request<{ data: Model[] }>('model/list', { includeHidden: false });
const cwd = mkdtempSync(join(tmpdir(), 'codex-models-'));
for (const model of data) {
  let verdict = '';
  if (live) {
    const thread = await client.request<{ thread: { id: string } }>('thread/start', { model: model.id, cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
    const done = new Promise<Notification>((resolve) => {
      const off = client.onNotification((note) => {
        if (note.method === 'turn/completed' && note.params['threadId'] === thread.thread.id) {
          off();
          resolve(note);
        }
      });
    });
    await client.request('turn/start', { threadId: thread.thread.id, effort: 'low', input: [{ type: 'text', text: 'Reply with the word OK.', text_elements: [] }] });
    const note = await done;
    const turn = note.params['turn'] as { status: string; error?: { message?: string } | null };
    verdict = turn.status === 'completed' ? ' · RUNS' : ` · ${turn.status}: ${turn.error?.message ?? ''}`;
  }
  console.log(
    `${model.id.padEnd(20)} ${model.displayName.padEnd(18)} efforts ${model.supportedReasoningEfforts.map((e) => e.reasoningEffort).join('/')} · default ${model.defaultReasoningEffort}${verdict}\n    ${model.description}`,
  );
}
client.close();
await new Promise((resolve) => setTimeout(resolve, 1500));
rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
