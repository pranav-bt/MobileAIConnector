import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HUB_PORT } from '@agent-hq/shared';
import { HubBus } from './bus.js';
import { loadPriorState, startEventLog, startSnapshotWriter } from './persist.js';
import { startServer, type HubServer } from './server.js';
import { startDemo } from './demo.js';
import { ClaudeEngine } from './engine/claude.js';
import { MockEngine } from './engine/mock.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { TeamRegistry } from './orchestrator/teams.js';
import { ProjectRegistry } from './orchestrator/projects.js';
import { PairingManager } from './security/pairing.js';
import { SecurityController } from './security/controller.js';
import { startLimitsPoller } from './usage/limits.js';
import type { CommandHandlers } from './commands.js';

export interface HubOptions {
  port?: number;
  demo?: boolean;
  demoFast?: boolean;
  engine?: 'claude' | 'mock' | null;
  dataDir?: string;
  cwd?: string;
}

export interface RunningHub {
  port: number;
  bus: HubBus;
  pairing: PairingManager;
  security: SecurityController;
  close(): Promise<void>;
}

// npm runs workspace scripts with cwd = packages/hub; anchor the hub's data
// and default workspace at the repo root instead.
function findRepoRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export async function startHub(options: HubOptions = {}): Promise<RunningHub> {
  const port = options.port ?? DEFAULT_HUB_PORT;
  const cwd = options.cwd ?? findRepoRoot(process.cwd());
  const dataDir = options.dataDir ?? resolve(cwd, 'data');

  const bus = new HubBus();
  const stopLog = startEventLog(bus, dataDir);

  const pairing = new PairingManager(dataDir);
  await pairing.init();

  let handlers: CommandHandlers;
  let stopDemo: (() => void) | null = null;
  let stopSnapshots: (() => void) | null = null;
  const mode: 'demo' | 'claude' | 'mock' =
    options.engine === 'claude' || options.engine === 'mock' ? options.engine : 'demo';

  if (mode === 'claude' || mode === 'mock') {
    const engine = mode === 'claude' ? new ClaudeEngine() : new MockEngine();
    const registry = new TeamRegistry(dataDir);
    registry.init();
    const projects = new ProjectRegistry(dataDir);
    projects.init(cwd);
    const orchestrator = new Orchestrator(bus, engine, registry, projects, cwd);
    orchestrator.init();

    // Task history and usage survive restarts; anything mid-flight when the
    // hub died comes back as paused.
    const prior = loadPriorState(dataDir);
    if (prior) {
      for (const task of prior.tasks) bus.publish({ type: 'task.updated', task });
      orchestrator.seedUsage(prior.usage);
      bus.publish({ type: 'usage.updated', usage: prior.usage });
    }
    stopSnapshots = startSnapshotWriter(bus, dataDir);

    handlers = orchestrator;
    console.log(
      mode === 'claude'
        ? '[hub] engine mode: claude — tasks you submit will run real agents'
        : '[hub] engine mode: mock — deterministic fake engine (tests/offline dev)',
    );
  } else {
    const demo = startDemo(bus, { fast: options.demoFast });
    handlers = demo.handlers;
    stopDemo = demo.stop;
    console.log('[hub] demo mode: replaying the mockup scenario, no usage spent');
  }

  bus.publish({ type: 'hub.updated', info: { mode, workspaceDir: cwd, dataDir, version: '0.1.0' } });

  // Real subscription meters (5h window / weekly, incl. chat usage) — only
  // when running real agents; demo seeds fake meters and mock stays offline.
  const stopLimits = mode === 'claude' ? startLimitsPoller(bus) : null;

  const securityController = new SecurityController(bus, pairing, port);
  const server: HubServer = await startServer(bus, handlers, securityController, port);
  securityController.publishState();
  console.log(`[hub] listening on ws://0.0.0.0:${port} (plaintext for loopback, encrypted sessions for the paired device)`);
  console.log(`[hub] pc key fingerprint: ${pairing.fingerprint}`);

  return {
    port,
    bus,
    pairing,
    security: securityController,
    close: async () => {
      stopDemo?.();
      stopLimits?.();
      stopSnapshots?.();
      securityController.stop();
      stopLog();
      await server.close();
    },
  };
}

// --- CLI ---------------------------------------------------------------
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const portFlag = args.indexOf('--port');
  const engineFlag = args.indexOf('--engine');
  const demo = args.includes('--demo');
  void startHub({
    demo,
    // Real agents are the default; the scripted demo is strictly opt-in.
    engine: demo ? null : engineFlag !== -1 ? (args[engineFlag + 1] as 'claude' | 'mock') : 'claude',
    port: portFlag !== -1 ? Number(args[portFlag + 1]) : undefined,
  });
}
