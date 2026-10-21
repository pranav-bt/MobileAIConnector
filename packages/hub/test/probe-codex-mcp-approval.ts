// PROBE: what Codex's app-server asks before a worker calls an MCP tool
// (approvalPolicy "untrusted"), using the app bridge with Node as the app.
// Prints every request the engine doesn't answer.   Spends a little Codex usage.
//   AGENT_HQ_CODEX_DEBUG=1 npx tsx test/probe-codex-mcp-approval.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModel } from '@agent-hq/shared';
import { CodexEngine } from '../src/engine/codex.js';
import { APP_BRIDGE } from '../src/apps.js';

const dir = mkdtempSync(join(tmpdir(), 'agent-hq-codex-mcp-'));
const appsFile = join(dir, 'apps.json');
writeFileSync(appsFile, JSON.stringify([{ id: 'nodeapp', name: 'Node', exePath: process.execPath, args: [], kind: 'generic', visible: false, idleMinutes: 10, notes: '', createdAt: 1 }]));
const engine = new CodexEngine();
const result = await engine.runWorker({
  prompt: 'Call the nodeapp MCP tool "status" exactly once and report what it said. Do nothing else.',
  title: 'probe mcp approval',
  team: { blockedTools: [], charter: 'Probe.', mcpServers: { nodeapp: { type: 'stdio', command: process.execPath, args: [APP_BRIDGE, '--app', 'nodeapp', '--apps-file', appsFile] } } },
  model: resolveModel('sonnet', { model: 'gpt-6.1-sol' }),
  cwd: dir,
  callbacks: {
    onActivity: (message) => console.log(`activity: ${message}`),
    onTokens: () => {},
    onPermission: async (request) => (console.log(`permission: ${JSON.stringify(request)}`), 'deny'),
    onTranscript: (row) => row.kind === 'tool' && console.log(`tool row: ${row.tool} ${row.state} ${(row.detail ?? '').slice(0, 200)}`),
  },
});
console.log(`synopsis: ${result.synopsis.slice(0, 300)}`);
engine.close();
process.exit(0);
