// How does the Agent SDK treat a user message streamed in mid-turn
// (priority 'next')? Folded into the running turn, or a new turn with its
// own result? Decides when the Claude engine may end a run.
// Spends a little usage.   npx tsx test/probe-claude-steer.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const cwd = mkdtempSync(join(tmpdir(), 'steer-probe-'));
let release: () => void = () => {};
const gate = new Promise<void>((resolve) => (release = resolve));
let ended = false;
const user = (text: string, priority?: 'next'): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  ...(priority ? { priority } : {}),
});
async function* input(): AsyncGenerator<SDKUserMessage> {
  yield user('Use the Bash tool to run: node -e "setTimeout(()=>console.log(\'slow done\'),5000)" — then reply in one short sentence.');
  await gate; // released once the slow command has started
  yield user('Also: end your reply with the word BANANA.', 'next');
  while (!ended) await new Promise((resolve) => setTimeout(resolve, 200));
}

const started = Date.now();
const results: string[] = [];
const stream = query({
  prompt: input(),
  options: { model: 'claude-haiku-4-5-20251001', cwd, canUseTool: async (_tool, toolInput) => ({ behavior: 'allow', updatedInput: toolInput }) },
});
const watchdog = setTimeout(() => {
  ended = true;
}, 90_000);
for await (const message of stream) {
  const m = message as unknown as Record<string, unknown>;
  const t = ((Date.now() - started) / 1000).toFixed(1);
  if (m['type'] === 'assistant') {
    const blocks = ((m['message'] as { content?: { type: string; name?: string; text?: string }[] })?.content ?? []);
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        console.log(`${t}s tool_use ${block.name}`);
        setTimeout(() => release(), 1000);
      }
      if (block.type === 'text') console.log(`${t}s text: ${block.text?.slice(0, 100)}`);
    }
  } else if (m['type'] === 'user' && (m as { priority?: string })['priority']) {
    console.log(`${t}s user echo (priority ${String(m['priority'])})`);
  } else if (m['type'] === 'result') {
    results.push(String(m['result'] ?? ''));
    console.log(`${t}s RESULT #${results.length}: ${String(m['result'] ?? '').slice(0, 120)}`);
    if (results.length >= 1 && results.some((r) => /BANANA/i.test(r))) ended = true;
    if (results.length >= 3) ended = true;
  }
}
clearTimeout(watchdog);
console.log(`\nresults: ${results.length} · BANANA in result #${results.findIndex((r) => /BANANA/i.test(r)) + 1}`);
process.exit(0);
