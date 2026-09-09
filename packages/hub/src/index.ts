import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HUB_PORT } from '@agent-hq/shared';
import { HubBus } from './bus.js';
import { startEventLog } from './persist.js';
import { startServer, type HubServer } from './server.js';
import { startDemo } from './demo.js';
import { ClaudeEngine } from './engine/claude.js';
import { MockEngine } from './engine/mock.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { TeamRegistry } from './orchestrator/teams.js';
import { PairingManager } from './security/pairing.js';
import { SecurityController } from './security/controller.js';
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

export async function startHub(options: HubOptions = {}): Promise<RunningHub> {
  const port = options.port ?? DEFAULT_HUB_PORT;
  const dataDir = options.dataDir ?? resolve('data');
  const cwd = options.cwd ?? process.cwd();

  const bus = new HubBus();
  const stopLog = startEventLog(bus, dataDir);

  const pairing = new PairingManager(dataDir);
  await pairing.init();

  let handlers: CommandHandlers;
  let stopDemo: (() => void) | null = null;

  if (options.engine === 'claude' || options.engine === 'mock') {
    const engine = options.engine === 'claude' ? new ClaudeEngine() : new MockEngine();
    const registry = new TeamRegistry(dataDir);
    registry.init();
    const orchestrator = new Orchestrator(bus, engine, registry, cwd);
    orchestrator.init();
    handlers = orchestrator;
    console.log(
      options.engine === 'claude'
        ? '[hub] engine mode: claude — tasks you submit will run real agents'
        : '[hub] engine mode: mock — deterministic fake engine (tests/offline dev)',
    );
  } else {
    const demo = startDemo(bus, { fast: options.demoFast });
    handlers = demo.handlers;
    stopDemo = demo.stop;
    console.log('[hub] demo mode: replaying the mockup scenario, no usage spent');
  }

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
  void startHub({
    demo: args.includes('--demo') || engineFlag === -1,
    engine: engineFlag !== -1 ? (args[engineFlag + 1] as 'claude' | 'mock') : null,
    port: portFlag !== -1 ? Number(args[portFlag + 1]) : undefined,
  });
}
