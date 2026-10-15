// LIVE check of project routing with the real master model, on asks like
// the owner's: follow-ups stay in the thread, clearly-other asks are ASKED
// (with the right project among the options), personal errands are general,
// and nothing ever lands in a project silently. Uses the real team roster
// and the real project folders on this PC. Spends a little usage.
//   npx tsx test/routing-ask.live.ts
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModel, type Project, type Team } from '@agent-hq/shared';
import { ClaudeEngine } from '../src/engine/claude.js';
import { routeTask, type RoutingDecision, type RoutingThread } from '../src/orchestrator/master.js';
import { ProjectRegistry } from '../src/orchestrator/projects.js';
import { loadHubConfig } from '../src/config.js';
import { CodexEngine } from '../src/engine/codex.js';
import { EngineRouter } from '../src/engine/router.js';

// --model <id> runs these decisions on any catalog model (Claude or Codex).
const modelArgIndex = process.argv.indexOf('--model');
const pickedModel = modelArgIndex > 0 ? process.argv[modelArgIndex + 1] : undefined;
const codexEngine = new CodexEngine();

// Reads the real roster/projects/roots, but from a COPY: the registry saves
// on init, and a test must never write the owner's data.
const realData = 'D:\\PersonalWork\\MobileAIConnector\\data';
const dataDir = mkdtempSync(join(tmpdir(), 'agent-hq-routing-live-'));
for (const file of ['teams.json', 'projects.json', 'config.json']) copyFileSync(join(realData, file), join(dataDir, file));
const engine = new EngineRouter({ claude: new ClaudeEngine(), codex: codexEngine });
const model = resolveModel('opus', pickedModel ? { model: pickedModel } : undefined);
const teams = JSON.parse(readFileSync(join(dataDir, 'teams.json'), 'utf8')) as Team[];
const config = loadHubConfig(dataDir) as { workspaceRoots: { key: string; path: string; label: string }[] };
const registry = new ProjectRegistry(dataDir, config.workspaceRoots);
registry.init('D:\\PersonalWork\\MobileAIConnector');
// As if PancakeStack were registered (the thread cases need it as a project).
const pancake: Project = {
  ...registry.defaultProject(),
  id: 'pancakestack',
  name: 'PancakeStack',
  description: 'Roblox game: stack pancakes, bases, baton, rebirth',
  workspaceDir: 'D:\\Work\\Roblox\\PancakeStack',
};
const generalProject: Project = {
  ...registry.defaultProject(),
  id: 'general',
  name: 'General',
  description: 'Not about any project — errands, setup, generic files. Its own folder, outside every repo.',
  workspaceDir: 'C:\\Users\\prana\\AgentHQ\\General',
};
const projects = [...registry.all().filter((p) => p.id !== 'general'), pancake, generalProject];
const folders = registry.discoverFolders().filter((folder) => folder.name !== 'PancakeStack');

const pancakeThread: RoutingThread = {
  projectId: 'pancakestack',
  recent: [
    '[PancakeStack] "Show players\' tallest cashed-in stack as a server trophy" → Show tallest stack trophy',
    '[PancakeStack] "the pancakes should jiggle more when they stack" → Enhance jiggle physics',
  ],
  recentWork: ['Enhance jiggle physics when pancakes stack', "Show players' tallest cashed-in stack as server trophy"],
};
const noThread: RoutingThread = { projectId: null, recent: [], recentWork: ['Enhance jiggle physics when pancakes stack'] };

type Expect = (d: RoutingDecision) => boolean;
const optionNames = (d: RoutingDecision) => (d.question?.options ?? []).map((option) => option.name);
const cases: { label: string; text: string; thread: RoutingThread; expect: Expect; want: string }[] = [
  {
    label: 'follow-up stays in the thread',
    text: 'make them jiggle a bit less when they land, it looks floaty',
    thread: pancakeThread,
    expect: (d) => d.projectBasis === 'thread' && d.projectId === 'pancakestack',
    want: 'thread → PancakeStack',
  },
  {
    label: 'vague follow-up stays in the thread',
    text: 'Have you completed the game implementation fully with the complete map and all the bases setup? I expect a fully functioning publishable game',
    thread: pancakeThread,
    expect: (d) => d.projectBasis === 'thread' && d.projectId === 'pancakestack',
    want: 'thread → PancakeStack (the old CastleWars misroute)',
  },
  {
    label: 'other codebase is asked, right folder offered',
    text: 'the calorie tracker login page crashes when I submit',
    thread: pancakeThread,
    expect: (d) => d.projectBasis === 'ask' && optionNames(d).includes('CalorieTrackerApp'),
    want: 'ask, CalorieTrackerApp among options',
  },
  {
    label: 'no thread: game ask is asked, PancakeStack offered',
    text: 'add a rebirth button to the pancake game HUD',
    thread: { ...noThread, recentWork: [] },
    expect: (d) => d.projectBasis === 'ask' && optionNames(d).some((name) => /pancake/i.test(name)),
    want: 'ask, PancakeStack among options (not a silent CastleWars/default)',
  },
  {
    label: 'personal errand is general',
    text: 'remind me to call mom at 6pm today',
    thread: pancakeThread,
    expect: (d) => d.projectBasis === 'general',
    want: 'general (no card)',
  },
  {
    label: 'trip planning is not thread work',
    text: 'plan day 3 of my UK trip, something near Edinburgh',
    thread: pancakeThread,
    expect: (d) => d.projectBasis === 'general' || (d.projectBasis === 'ask' && optionNames(d).includes('UK trip')),
    want: 'general, or ask with "UK trip"',
  },
  {
    label: "owner's generic setup ask (Tools team) runs in General",
    text: 'Ask the tools team to setup a simple file that will hold my API keys for uploading dev prods and assets. its not related to any project and it should be a geenric location that the tools team has access to',
    thread: pancakeThread,
    expect: (d) => d.projectBasis === 'general' && d.projectId === 'general' && d.teamId === 'tools',
    want: 'general → General, Tools team, no card',
  },
  {
    label: 'generic machine chore runs in General',
    text: 'install python 3.12 on my pc and make sure pip works',
    thread: pancakeThread,
    expect: (d) => d.projectBasis === 'general',
    want: 'general (no card)',
  },
  {
    label: 'named project still wins',
    text: 'in CastleWars, rebalance the archer tower damage',
    thread: pancakeThread,
    expect: (d) => d.projectBasis === 'named' && d.projectId === 'castlewars',
    want: 'named → CastleWars (then the switch card)',
  },
];

let pass = true;
for (const testCase of cases) {
  const decision = await routeTask(engine, teams, projects, 'general', testCase.text, null, model, testCase.thread, [], folders);
  const ok = testCase.expect(decision);
  pass &&= ok;
  const got = `${decision.projectBasis}${decision.projectId ? ` → ${decision.projectId}` : ''}${decision.question ? ` · options: ${optionNames(decision).join(', ') || '(none)'}` : ''} · team ${decision.teamId}`;
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${testCase.label}\n     want: ${testCase.want}\n     got:  ${got}${decision.question ? `\n     why:  ${decision.question.reason}` : ''}`);
}
console.log(pass ? '\nROUTING-ASK LIVE PASS' : '\nROUTING-ASK LIVE FAIL');
codexEngine.close();
process.exit(pass ? 0 : 1);
