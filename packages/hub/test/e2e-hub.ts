import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from '../src/index.js';

// Standing hub for the Android JVM E2E test (mock engine, temp data dir).
// Run, leave running, kill when done:  npx tsx test/e2e-hub.ts
const port = Number(process.env.E2E_PORT ?? 4611);
await startHub({
  engine: 'mock',
  port,
  dataDir: mkdtempSync(join(tmpdir(), 'agent-hq-e2e-')),
  workspaceRoots: [{ key: 'tmp', path: tmpdir(), label: 'e2e sandbox' }],
});
console.log(`E2E HUB READY on ${port}`);
