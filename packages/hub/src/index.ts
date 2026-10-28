import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HUB_PORT, type AccessGrant } from '@agent-hq/shared';
import { HubBus } from './bus.js';
import { loadPriorState, startEventLog, startSnapshotWriter } from './persist.js';
import { ensureInboxDir, startOutboxWatcher } from './files.js';
import { FreelancerManager } from './freelancers.js';
import { PaDesk } from './pa.js';
import { startServer, type HubServer } from './server.js';
import { startDemo } from './demo.js';
import { ClaudeEngine } from './engine/claude.js';
import { MockEngine } from './engine/mock.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { StudioDirectory, type StudioLister } from './orchestrator/studios.js';
import { TeamRegistry } from './orchestrator/teams.js';
import { ProjectRegistry } from './orchestrator/projects.js';
import { PairingManager } from './security/pairing.js';
import { SecurityController } from './security/controller.js';
import { startLimitsPoller } from './usage/limits.js';
import { loadHubConfig, saveModelOverrides, savePaEnabled, saveAccessGrants, savePermissionMode, saveAway, type AwayState, type PermissionMode, type WorkspaceRoot } from './config.js';
import type { CommandHandlers } from './commands.js';
import { projectMcpServers, readMcpCatalog } from './engine/mcp-catalog.js';
import { CodexEngine } from './engine/codex.js';
import { findCodexBinary } from './engine/codex-rpc.js';
import { EngineRouter } from './engine/router.js';
import { TranscriptStore } from './transcripts.js';
import { AppRegistry } from './apps.js';

export interface HubOptions {
  port?: number;
  demo?: boolean;
  demoFast?: boolean;
  engine?: 'claude' | 'mock' | null;
  dataDir?: string;
  cwd?: string;
  workspaceRoots?: WorkspaceRoot[]; // tests override; defaults from data/config.json
  accessGrants?: AccessGrant[]; // tests override; defaults from data/config.json
  claudeProjectsDir?: string; // tests override; defaults to ~/.claude/projects
  // Where the owner's Codex sessions live (~/.codex). A hub whose Claude dir
  // is overridden (every test) doesn't look at Codex unless given one too.
  codexHome?: string | null;
  freelancerOpenSessions?: () => number; // tests override the process scan
  freelancerRunner?: (sessionId: string, cwd: string, text: string) => Promise<string>; // tests override the sidecar
  paTickMs?: number; // tests speed up the PA desk clock
  claudeConfigPath?: string; // tests override ~/.claude.json (the MCP catalog)
  generalDir?: string; // tests override ~/AgentHQ/General (the General workspace)
  detectApps?: () => string[]; // tests override the Blender install scan
  // Where the bots' worktrees go when no full-access folder is granted (with
  // one — D:\Work\Bots — they go in its worktrees\). null = off: workers run
  // in the project folder. Default: ~/AgentHQ/worktrees for real agents, off
  // in mock mode.
  worktreesDir?: string | null;
  studios?: StudioLister; // tests override the Roblox Studio window list
  // Tests: Away's wait (minutes; fractions ok) and how often it checks.
  awayMinutes?: number;
  awaySweepMs?: number;
}

export interface RunningHub {
  port: number;
  bus: HubBus;
  pairing: PairingManager;
  security: SecurityController;
  close(): Promise<void>;
}

function getHubVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
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

  const config = loadHubConfig(dataDir);
  const workspaceRoots = options.workspaceRoots ?? config.workspaceRoots;
  const permissionPolicy: { mode: PermissionMode } = { mode: config.permissionMode };
  let modelOverrides = config.modelOverrides;
  let accessGrants = options.accessGrants ?? config.accessGrants;

  const bus = new HubBus();
  const stopLog = startEventLog(bus, dataDir);
  const outbox = startOutboxWatcher(bus, dataDir);
  const inboxDir = ensureInboxDir(dataDir);

  // The PA desk: deterministic assistant stores + clock (zero tokens at
  // rest); "/pa off" gates all of it, persisted in config.
  const paDesk = new PaDesk(bus, dataDir, outbox.outboxDir, {
    enabled: config.paEnabled,
    persistEnabled: (enabled) => savePaEnabled(dataDir, enabled),
    ...(options.paTickMs ? { intervalMs: options.paTickMs } : {}),
  });
  paDesk.start();

  const pairing = new PairingManager(dataDir);
  await pairing.init();

  let handlers: CommandHandlers;
  let stopDemo: (() => void) | null = null;
  let stopSnapshots: (() => void) | null = null;
  let stopRules: (() => void) | null = null;
  let codexEngine: CodexEngine | null = null;
  // Task consoles' transcripts (data/transcripts/) — orchestrator modes only.
  let transcripts: TranscriptStore | null = null;
  let masterRules = (): string => '';
  let mcpCatalog = (): string[] => [];
  let studioNames = (): { name: string; placeId: string | null }[] => [];
  let awayState = (): AwayState | null => null;
  let apps: AppRegistry | null = null;
  let workerCwds: () => string[] = () => [];
  let attachFreelancers: (manager: FreelancerManager) => void = () => {};
  const mode: 'demo' | 'claude' | 'mock' =
    options.engine === 'claude' || options.engine === 'mock' ? options.engine : 'demo';

  if (mode === 'claude' || mode === 'mock') {
    // Any seat, any model: the router sends each call to Claude or Codex by
    // the model's engine. The mock engine stands in for both offline.
    const mock = mode === 'mock' ? new MockEngine() : null;
    codexEngine = mode === 'claude' ? new CodexEngine() : null;
    const engine = new EngineRouter(
      mock ? { claude: mock, codex: mock } : { claude: new ClaudeEngine(), codex: codexEngine! },
      mock ? {} : { codex: findCodexBinary() !== null },
    );
    const registry = new TeamRegistry(dataDir);
    registry.init();
    const projects = new ProjectRegistry(dataDir, workspaceRoots);
    // General work (about no project) runs in its own folder outside every repo.
    projects.init(cwd, options.generalDir ?? join(homedir(), 'AgentHQ', 'General'));
    const orchestrator = new Orchestrator(
      bus,
      engine,
      registry,
      projects,
      cwd,
      permissionPolicy,
      (mode) => {
        savePermissionMode(dataDir, mode);
        bus.publish({ type: 'hub.updated', info: makeInfo() });
      },
      outbox.outboxDir,
      inboxDir,
    );
    orchestrator.configureModels(modelOverrides, (overrides) => {
      modelOverrides = overrides;
      saveModelOverrides(dataDir, overrides);
      bus.publish({ type: 'hub.updated', info: makeInfo() });
    });
    orchestrator.configureMcpCatalog(
      () => readMcpCatalog(options.claudeConfigPath),
      (cwd) => projectMcpServers(cwd, options.claudeConfigPath),
    );
    apps = new AppRegistry(dataDir, options.detectApps);
    orchestrator.configureApps(apps, () => bus.publish({ type: 'hub.updated', info: makeInfo() }));
    orchestrator.configureAccess(
      accessGrants,
      (grants) => {
        accessGrants = grants;
        saveAccessGrants(dataDir, grants);
        bus.publish({ type: 'hub.updated', info: makeInfo() });
      },
      options.claudeProjectsDir,
    );
    orchestrator.configureWorktrees(
      options.worktreesDir !== undefined ? options.worktreesDir : mode === 'claude' ? join(homedir(), 'AgentHQ', 'worktrees') : null,
    );
    if (options.studios) orchestrator.configureStudios(new StudioDirectory(options.studios));
    orchestrator.configureAway(
      { ...config.away, ...(options.awayMinutes ? { minutes: options.awayMinutes } : {}) },
      (away) => {
        saveAway(dataDir, away);
        bus.publish({ type: 'hub.updated', info: makeInfo() });
      },
      options.awaySweepMs,
    );
    awayState = () => orchestrator.awayState();
    studioNames = () => orchestrator.studioNames();
    orchestrator.onInfoChange(() => bus.publish({ type: 'hub.updated', info: makeInfo() }));
    masterRules = () => orchestrator.masterRulesText();
    mcpCatalog = () => orchestrator.mcpCatalogNames();
    transcripts = new TranscriptStore(dataDir);
    orchestrator.attachTranscripts(transcripts);
    orchestrator.init();
    workerCwds = () => orchestrator.activeWorkerCwds();
    attachFreelancers = (manager) => orchestrator.attachFreelancers(manager);
    orchestrator.attachPa(paDesk);

    // Task history and usage survive restarts; anything mid-flight when the
    // hub died comes back as paused.
    const prior = loadPriorState(dataDir);
    if (prior) {
      for (const task of prior.tasks) bus.publish({ type: 'task.updated', task });
      orchestrator.seedUsage(prior.usage);
      bus.publish({ type: 'usage.updated', usage: prior.usage });
    }
    stopSnapshots = startSnapshotWriter(bus, dataDir);
    stopRules = () => orchestrator.stopRulesWatch();

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

  const makeInfo = () => ({
    mode,
    workspaceDir: cwd,
    dataDir,
    version: getHubVersion(),
    workspaceRoots,
    permissionMode: permissionPolicy.mode,
    modelOverrides,
    masterRules: masterRules(),
    mcpCatalog: mcpCatalog(),
    accessGrants,
    ...(apps ? { apps: apps.list(), appSuggestions: apps.suggestions() } : {}),
    studios: studioNames(),
    ...(awayState() ? { away: awayState()! } : {}),
  });
  bus.publish({ type: 'hub.updated', info: makeInfo() });

  // Real subscription meters (5h window / weekly, incl. chat usage) — only
  // when running real agents; demo seeds fake meters and mock stays offline.
  const stopLimits = mode === 'claude' ? startLimitsPoller(bus) : null;
  // The Codex plan's limits — read (free) only while Codex is actually running.
  const codexLimits = codexEngine
    ? setInterval(() => {
        void codexEngine?.rateLimits().then((codex) => {
          if (codex) bus.publish({ type: 'usage.updated', usage: { ...bus.state.usage, codex } });
        });
      }, 60_000)
    : null;
  codexLimits?.unref();

  // Terminal Claude Code sessions on this machine show up as Freelancers —
  // and can be messaged (the hub resumes their conversation headlessly).
  const freelancers = new FreelancerManager(bus, {
    ...(options.claudeProjectsDir ? { projectsDir: options.claudeProjectsDir } : {}),
    codexHome: options.codexHome !== undefined ? options.codexHome : options.claudeProjectsDir ? null : undefined,
    ...(options.freelancerOpenSessions ? { openSessions: options.freelancerOpenSessions } : {}),
    ...(options.freelancerRunner ? { runner: options.freelancerRunner } : {}),
    outboxDir: outbox.outboxDir,
    activeCwds: () => workerCwds(),
  });
  freelancers.start();
  attachFreelancers(freelancers);

  const securityController = new SecurityController(bus, pairing, port);
  const server: HubServer = await startServer(bus, handlers, securityController, port, transcripts);
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
      if (codexLimits) clearInterval(codexLimits);
      codexEngine?.close();
      stopSnapshots?.();
      stopRules?.();
      freelancers.stop();
      paDesk.stop();
      outbox.stop();
      securityController.stop();
      stopLog();
      await transcripts?.flush();
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
  if (args.includes('--version') || args.includes('-v')) {
    console.log(getHubVersion());
    process.exit(0);
  }
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
