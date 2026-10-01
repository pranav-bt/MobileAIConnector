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
  { id: 'qa-testing', name: 'QA & Testing', charter: 'tests things', allowedTools: ['read', 'bash'] },
  { id: 'coding', name: 'Coding', charter: 'builds things', allowedTools: ['read', 'edit', 'bash'] },
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
  project: 'thread',
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
// Other projects are listed for suggestions only — the model can't pick them.
if (!/you may suggest, never pick/.test(prompts.at(-1)!)) fail('the routing prompt does not mark other projects as suggestion-only');
if (!prompts.at(-1)!.includes('build the map and assets')) fail('the routing prompt is missing the recent conversation');
if (inherited.projectBasis !== 'thread') fail(`unnamed ask basis is ${inherited.projectBasis}, not thread`);

// 2. No thread yet → the owner is asked; never a default, never the model's guess.
const fresh = await routeTask(greedy(castleReply), teams, projects, 'mobileaiconnector', ask, null);
if (fresh.projectBasis !== 'ask' || fresh.projectId !== '') fail(`threadless unnamed ask was not asked: ${fresh.projectBasis} ${fresh.projectId}`);
if (!fresh.question) fail('an ask decision carries no question');

// 2b. The ask doesn't fit the thread → asked, with the model's guesses and
// the thread as options — even a greedy CastleWars guess is only an option.
const off = await routeTask(
  greedy({ ...castleReply, project: 'unsure', suggest: ['castlewars', 'NotAThing', 'PancakeStackOld'] }),
  teams,
  projects,
  'mobileaiconnector',
  'plan the guest list for saturday',
  null,
  undefined,
  thread,
  [],
  [{ name: 'PancakeStackOld', path: 'D:\\Work\\Roblox\\PancakeStackOld' }],
);
const offered = (off.question?.options ?? []).map((option) => (option.kind === 'project' ? option.id : `folder:${option.name}`));
if (off.projectBasis !== 'ask') fail(`off-thread ask basis is ${off.projectBasis}, not ask`);
if (offered.join(',') !== 'castlewars,folder:PancakeStackOld,pancakestack') fail(`off-thread options wrong: ${offered.join(',')}`);
if (!/PancakeStack work/.test(off.question?.reason ?? '')) fail(`off-thread reason unclear: ${off.question?.reason}`);

// 2c. A missing verdict is not a licence: asked, not defaulted.
const vague = await routeTask(greedy({ teamId: 'coding', title: 'x' }), teams, projects, 'mobileaiconnector', 'do the thing', null, undefined, thread);
if (vague.projectBasis !== 'ask') fail(`no verdict should ask, got ${vague.projectBasis}`);

// 2d. "General" (about no project) runs in the hub workspace — but only for
// teams that run no commands; shell work is always asked.
const textTeams = [...teams, { id: 'personal-assistant-team', name: 'PA', charter: 'todos', allowedTools: ['read', 'edit'] }] as unknown as Team[];
const general = await routeTask(
  greedy({ teamId: 'personal-assistant-team', project: 'general', title: 'Add eggs to todos' }),
  textTeams,
  projects,
  'mobileaiconnector',
  'add eggs to my todos',
  null,
  undefined,
  thread,
);
if (general.projectBasis !== 'general' || general.projectId !== 'mobileaiconnector') fail(`general ask: ${general.projectBasis} ${general.projectId}`);
const generalShell = await routeTask(
  greedy({ teamId: 'coding', project: 'general', title: 'Clean temp files' }),
  textTeams,
  projects,
  'mobileaiconnector',
  'clean up the temp files',
  null,
  undefined,
  thread,
);
if (generalShell.projectBasis !== 'ask') fail(`a "general" shell task was not asked: ${generalShell.projectBasis}`);

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
// 'named' is the basis the orchestrator gates behind a project-switch card.
if (named.projectBasis !== 'named') fail(`named project basis is ${named.projectBasis}, not named`);
const namedHome = await routeTask(
  greedy({ ...castleReply, projectId: 'pancakestack', title: 'Tune PancakeStack drops' }),
  teams,
  projects,
  'mobileaiconnector',
  'tune the pancakestack drop rate',
  null,
  undefined,
  thread,
);
if (namedHome.projectBasis !== 'thread') fail("naming the thread's own project must not count as leaving it");

// 4. @project always wins, even over a named one.
const pinned = await routeTask(greedy(castleReply), teams, projects, 'mobileaiconnector', 'fix castle wars', 'pancakestack');
if (pinned.projectId !== 'pancakestack') fail(`@project pin lost to the model: ${pinned.projectId}`);
if (pinned.projectBasis !== 'pinned') fail(`pin basis is ${pinned.projectBasis}, not pinned`);

// 5. The routing call failing still inherits, never falls to a guess.
const broken = {
  async complete() {
    throw new Error('offline');
  },
} as unknown as OrchestratorEngine;
const fallback = await routeTask(broken, teams, projects, 'mobileaiconnector', ask, null, undefined, thread);
if (fallback.projectId !== 'pancakestack' || !fallback.fallback) fail('keyword fallback did not inherit the thread project');
if (fallback.projectBasis !== 'thread') fail(`fallback basis is ${fallback.projectBasis}, not thread`);
const lost = await routeTask(broken, teams, projects, 'mobileaiconnector', ask, null);
if (lost.projectBasis !== 'ask') fail(`offline with no thread should ask, got ${lost.projectBasis}`);

// 6. Name matching: spacing-insensitive, but whole words only.
const hits = (text: string) => namedProjects(projects, text).map((p) => p.id);
if (!hits('CastleWars bug').includes('castlewars')) fail('CastleWars not matched');
if (!hits('castle-wars ui').includes('castlewars')) fail('castle-wars not matched');
if (!hits('Stack a pancake — PancakeStack art').includes('pancakestack')) fail('PancakeStack not matched');
if (hits('the map and all the bases').length) fail('topic words matched a project');
if (hits('the castle walls look off').length) fail('"castle" alone matched CastleWars');

console.log('routing ok: unnamed asks inherit the thread project, only named projects can be picked, titles stay clean');
