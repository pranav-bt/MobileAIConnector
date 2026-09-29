// Routing must never pin a project the owner didn't name. Replays the ask
// that got misrouted to CastleWars ("…the complete map and all the bases
// setup…") against a master that always tries to pick castlewars, and checks
// the hub keeps the task in the thread's project with a clean title.
//
// Usage: npx tsx test/routing.smoke.ts   (no hub, no usage)

import type { Project, Team } from '@agent-hq/shared';
import { namedProjects, routeTask } from '../src/orchestrator/master.js';
import type { OrchestratorEngine } from '../src/engine/types.js';

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const project = (id: string, name: string, description = ''): Project =>
  ({ id, name, description, workspaceDir: '', tokensUsed: 0 }) as unknown as Project;
const projects = [
  project('mobileaiconnector', 'MobileAIConnector', "Default project — the hub's own workspace."),
  project('castlewars', 'CastleWars', 'Roblox PvP base-destruction game'),
  project('pancakestack', 'PancakeStack'),
];
const teams = [
  { id: 'qa-testing', name: 'QA & Testing', charter: 'tests things' },
  { id: 'coding', name: 'Coding', charter: 'builds things' },
] as unknown as Team[];

// A master that always wants CastleWars, in both the project and the title.
const prompts: string[] = [];
const greedy = (reply: object): OrchestratorEngine =>
  ({
    async complete({ prompt }: { prompt: string }) {
      prompts.push(prompt);
      return { text: JSON.stringify(reply), tokens: 10 };
    },
  }) as unknown as OrchestratorEngine;
const castleReply = {
  teamId: 'qa-testing',
  projectId: 'castlewars',
  title: 'Audit CastleWars for a fully playable, publishable build',
  reason: 'mentions bases',
};

const ask =
  'Have you completed the game implementation fully with the complete map and all the bases setup ? ' +
  'Also is the coding part done fully? I expect a FULLY FUNCTIONING PUBLISHABLE GAME?';
const thread = { projectId: 'pancakestack', recent: ['"build the map and assets" → Build PancakeStack map'] };

// 1. Unnamed ask inherits the thread's project; the stray title is dropped.
const inherited = await routeTask(greedy(castleReply), teams, projects, 'mobileaiconnector', ask, null, undefined, thread);
if (inherited.projectId !== 'pancakestack') fail(`unnamed ask went to ${inherited.projectId}, not the thread's project`);
if (/castle/i.test(inherited.title)) fail(`title still names CastleWars: ${inherited.title}`);
if (/castlewars/i.test(prompts.at(-1)!)) fail('the routing prompt offered CastleWars for an ask that never named it');
if (!prompts.at(-1)!.includes('build the map and assets')) fail('the routing prompt is missing the recent conversation');

// 2. No thread yet → the default project, never the model's guess.
const fresh = await routeTask(greedy(castleReply), teams, projects, 'mobileaiconnector', ask, null);
if (fresh.projectId !== 'mobileaiconnector') fail(`threadless unnamed ask went to ${fresh.projectId}`);

// 3. Naming the project (any spacing) lets the model pick it.
const named = await routeTask(
  greedy(castleReply),
  teams,
  projects,
  'mobileaiconnector',
  'check the balance in castle wars',
  null,
  undefined,
  thread,
);
if (named.projectId !== 'castlewars') fail(`named project not honored: ${named.projectId}`);
if (!/castlewars/i.test(named.title)) fail('a title for a named project should survive');

// 4. @project always wins, even over a named one.
const pinned = await routeTask(greedy(castleReply), teams, projects, 'mobileaiconnector', 'fix castle wars', 'pancakestack');
if (pinned.projectId !== 'pancakestack') fail(`@project pin lost to the model: ${pinned.projectId}`);

// 5. The routing call failing still inherits, never falls to a guess.
const broken = {
  async complete() {
    throw new Error('offline');
  },
} as unknown as OrchestratorEngine;
const fallback = await routeTask(broken, teams, projects, 'mobileaiconnector', ask, null, undefined, thread);
if (fallback.projectId !== 'pancakestack' || !fallback.fallback) fail('keyword fallback did not inherit the thread project');

// 6. Name matching: spacing-insensitive, but whole words only.
const hits = (text: string) => namedProjects(projects, text).map((p) => p.id);
if (!hits('CastleWars bug').includes('castlewars')) fail('CastleWars not matched');
if (!hits('castle-wars ui').includes('castlewars')) fail('castle-wars not matched');
if (!hits('Stack a pancake — PancakeStack art').includes('pancakestack')) fail('PancakeStack not matched');
if (hits('the map and all the bases').length) fail('topic words matched a project');
if (hits('the castle walls look off').length) fail('"castle" alone matched CastleWars');

console.log('routing ok: unnamed asks inherit the thread project, only named projects can be picked, titles stay clean');
