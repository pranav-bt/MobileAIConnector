// LIVE: the master's check on messages typed in a task's window, against
// the owner's real team roster (data/teams.json, read-only) — classification
// calls only, no work runs. Run it per quick-check model:
//   npx tsx test/message-routing.live.ts [--model claude-haiku-4-5-20251001] [--effort low]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveModel, type Team } from '@agent-hq/shared';
import { ClaudeEngine } from '../src/engine/claude.js';
import { routeThreadMessage } from '../src/orchestrator/master.js';

const modelArg = process.argv.indexOf('--model');
const effortArg = process.argv.indexOf('--effort');
const model = resolveModel('haiku', {
  ...(modelArg > 0 ? { model: process.argv[modelArg + 1]! } : {}),
  ...(effortArg > 0 ? { effort: process.argv[effortArg + 1] as 'low' } : {}),
});
const raw = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'data', 'teams.json'), 'utf8')) as Team[] | { teams: Team[] };
const teams = (Array.isArray(raw) ? raw : raw.teams).map((team) => ({ ...team, mcpServers: team.mcpServers ?? {} }));
const coding = teams.find((team) => team.id === 'coding')!;
const thread = {
  ask: 'Build the shop screen for CastleWars: a grid of items with their prices, and a buy button that checks the player has enough gold.',
  team: coding,
  status: 'done',
  report:
    'Built ShopScreen (src/client/ShopScreen.luau) with a 4-column grid, price labels from ShopPrices, and a Buy button that asks the server; ' +
    'PurchaseService validates gold server-side. 6 tests pass. QA checked it in Studio: purchases work, one layout fix applied.',
  steps: [{ title: '[QA] Build the shop screen for CastleWars', team: 'QA & Testing', status: 'done' }],
  working: null,
};
const teamOf = (name: string) => teams.find((team) => team.name.toLowerCase().startsWith(name))?.id ?? name;
const cases: { message: string; expect: (decision: { route: string; teamId?: string; teamIds?: string[] }) => boolean; want: string }[] = [
  { message: 'Make proper icons for every item in the shop, they are just grey squares right now', want: `team ${teamOf('art')}`, expect: (d) => d.route === 'team' && d.teamId === teamOf('art') },
  { message: 'Why did you put the prices in a separate module instead of on the items?', want: 'same', expect: (d) => d.route === 'same' },
  { message: 'Also add a test for when the player has exactly enough gold', want: 'same', expect: (d) => d.route === 'same' },
  { message: 'The buy button is slightly off-center on small screens, fix that', want: 'same', expect: (d) => d.route === 'same' },
  { message: 'Write the patch notes for this shop update so I can post them', want: 'team docs / release', expect: (d) => d.route === 'team' && [teamOf('docs'), teamOf('release')].includes(d.teamId ?? '') },
  { message: 'Add a satisfying purchase sound when someone buys something', want: `team ${teamOf('audio')}`, expect: (d) => d.route === 'team' && d.teamId === teamOf('audio') },
  { message: 'Do a security review of the purchase flow — can people buy without paying?', want: `team ${teamOf('security')} (or same)`, expect: (d) => (d.route === 'team' && d.teamId === teamOf('security')) || d.route === 'same' },
  { message: 'Thanks, that looks great so far!', want: 'same', expect: (d) => d.route === 'same' },
];

// …and the other way round: an art thread.
const art = teams.find((team) => team.id === teamOf('art'))!;
const artThread = {
  ask: 'Make icons for every item in the CastleWars shop (64x64 PNG, consistent style).',
  team: art,
  status: 'done',
  report: 'Made 18 item icons in assets/icons/shop/ (64x64 PNG, shared palette, transparent background) plus a contact sheet.',
  steps: [],
  working: null,
};
const artCases: typeof cases = [
  { message: 'Now hook these icons up in the shop screen so each item shows its icon', want: 'team coding', expect: (d) => d.route === 'team' && d.teamId === 'coding' },
  { message: 'The sword icon is too dark, make it a bit brighter', want: 'same', expect: (d) => d.route === 'same' },
];

const engine = new ClaudeEngine();
let failures = 0;
let tokens = 0;
const started = Date.now();
console.log(`model ${model.id}${model.effort ? ` · effort ${model.effort}` : ''} · ${teams.length} teams`);
for (const [{ message, expect, want }, onThread] of [...cases.map((c) => [c, thread] as const), ...artCases.map((c) => [c, artThread] as const)]) {
  const { decision, tokens: used } = await routeThreadMessage(engine, teams, onThread, message, model);
  tokens += used;
  const ok = expect(decision);
  if (!ok) failures += 1;
  const got = decision.route === 'team' ? `team ${decision.teamId}` : decision.route === 'ask' ? `ask [${(decision.teamIds ?? []).join(', ')}]` : 'same';
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${want.padEnd(24)} ← ${got.padEnd(18)} "${message.slice(0, 70)}"${decision.instruction ? `\n        → ${decision.instruction.slice(0, 160)}` : ''}`);
}
console.log(`${tokens} tokens · ${((Date.now() - started) / 1000).toFixed(0)} s for ${cases.length + artCases.length} checks`);
console.log(failures === 0 ? `MESSAGE ROUTING LIVE PASS (${cases.length + artCases.length})` : `MESSAGE ROUTING LIVE FAIL (${failures}/${cases.length + artCases.length})`);
process.exit(failures === 0 ? 0 : 1);
