// One-shot roster setup: creates the specialist teams the owner approved
// (2026-09-10) over the hub's normal command channel — each team is exactly
// one team.create — and grants the Roblox Studio MCP connection to the QA
// and Game Engine teams. Idempotent: teams that already exist are skipped.
//
// Usage: node tools/setup-teams.mjs   (hub must be running on 4517)

const HUB = 'ws://127.0.0.1:4517';

// The user's Roblox Studio MCP server, as configured for Claude Code on this
// machine (cmd expands %LOCALAPPDATA% itself).
const ROBLOX_MCP = {
  Roblox_Studio: {
    type: 'stdio',
    command: 'cmd.exe',
    args: ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'],
    env: {},
  },
};

const TEAMS = [
  {
    name: 'Art team',
    charter:
      'Creates and processes 2D game art: UI art, icons, sprites, spritesheets, textures, palettes, and promo images. ' +
      "Uses the ImageMagick CLI ('magick') for conversion, resizing, compositing, palette and spritesheet work. " +
      'Image generation runs through a local ComfyUI/Stable Diffusion instance when one is available — never a paid API. ' +
      "Keeps sources and exports organized inside the project's workspace.",
    allowedTools: ['read', 'edit', 'bash'],
    blockedTools: ['installs'],
  },
  {
    name: 'Game Engine team',
    charter:
      'Engine liaison: establishes and maintains the MCP connections to game engines (Roblox Studio first), diagnoses ' +
      'connection problems, and makes rare direct engine-side edits when another team is blocked. Most in-engine testing ' +
      'belongs to the QA team — this team keeps that path healthy rather than doing the testing itself.',
    allowedTools: ['read', 'edit', 'bash'],
    blockedTools: [],
    mcpServers: ROBLOX_MCP,
  },
  {
    name: 'Audio team',
    charter:
      'Processes game audio with ffmpeg: format conversion, loudness normalization, trims, loops, fades, and batch ' +
      'pipelines for SFX and music. Free tools only — no paid services.',
    allowedTools: ['read', 'bash'],
    blockedTools: ['installs'],
  },
  {
    name: 'Research team',
    charter:
      'Investigates libraries, engines, APIs, competitors, and best practices on the web; produces concise briefs with ' +
      'sources and links. Read-only: never edits code, never installs anything.',
    allowedTools: ['read', 'web'],
    blockedTools: ['git', 'installs'],
  },
  {
    name: 'Security team',
    charter:
      'Audits dependencies (npm audit, cargo audit), scans for leaked secrets (gitleaks), and reviews changes for ' +
      'security risks: injection, unsafe deserialization, permission escalations, exposed endpoints. Reports findings ' +
      'with severity; fixes go back to the owning team.',
    allowedTools: ['read', 'bash', 'git'],
    blockedTools: ['installs'],
  },
  {
    name: 'Release team',
    charter:
      'Owns shipping: version bumps, changelogs, release builds, GitHub releases via the gh CLI, and store uploads ' +
      '(itch.io butler, Steamworks) as they come online. Anything that publishes or pushes goes through an approval card.',
    allowedTools: ['read', 'bash', 'git'],
    blockedTools: [],
  },
  {
    name: 'Docs team',
    charter:
      'Writes and maintains READMEs, design docs, devlogs, store-page copy, and internal guides. Clear, concise, and ' +
      'accurate to the code as it exists.',
    allowedTools: ['read', 'edit'],
    blockedTools: ['git', 'installs'],
  },
  {
    name: 'Personal Assistant team',
    charter:
      'Handles daily and utility tasks: summaries, day planning, checklists, drafting messages and replies, quick ' +
      "lookups, and file organization inside the workspace roots. Sends results to the owner's phone via the outbox " +
      'when useful. Email/calendar connections plug in here once the owner links them.',
    allowedTools: ['read', 'edit', 'web'],
    blockedTools: ['git', 'installs'],
  },
];

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const ws = new WebSocket(HUB);
const send = (command) => ws.send(JSON.stringify(command));

let snapshot = null;
const done = new Set();

ws.addEventListener('open', () => send({ type: 'hello', client: 'cli', name: 'setup-teams' }));

ws.addEventListener('message', (msg) => {
  const envelope = JSON.parse(String(msg.data));
  const event = envelope.event;
  if (!event) return;

  if (event.type === 'snapshot' && !snapshot) {
    snapshot = event.snapshot;
    const existing = new Set(snapshot.teams.map((team) => team.id));

    for (const team of TEAMS) {
      const id = slug(team.name);
      if (existing.has(id)) {
        console.log(`= ${team.name} already exists (${id})`);
        done.add(id);
        continue;
      }
      send({ type: 'team.create', ...team });
    }

    // Grant the QA team its engine connection: the Roblox Studio MCP.
    const qa = snapshot.teams.find((team) => /\bqa\b|test/i.test(team.id) || /\bqa\b|test/i.test(team.name));
    if (qa) {
      send({
        type: 'team.update',
        teamId: qa.id,
        charter:
          qa.charter.includes('Roblox Studio')
            ? qa.charter
            : qa.charter +
              ' For Roblox projects, use the connected Roblox Studio tools to open the place, run the game, and exercise features directly.',
        mcpServers: ROBLOX_MCP,
      });
      console.log(`~ QA team (${qa.id}): Roblox Studio MCP granted`);
    } else {
      console.log('! no QA team found to grant the Roblox MCP to');
    }

    // Give things a moment to echo back, then report and exit.
    setTimeout(() => {
      console.log('timed out waiting for team.updated echoes');
      process.exit(1);
    }, 8000);
    return;
  }

  if (event.type === 'team.updated' && snapshot) {
    const id = event.team.id;
    const wanted = TEAMS.some((team) => slug(team.name) === id);
    if (wanted && !done.has(id)) {
      done.add(id);
      const mcp = Object.keys(event.team.mcpServers ?? {});
      console.log(`+ ${event.team.name} live (${id})${mcp.length ? ` · MCP: ${mcp.join(', ')}` : ''}`);
    }
    if (done.size === TEAMS.length) {
      console.log(`ROSTER READY: ${done.size} teams confirmed`);
      ws.close();
      process.exit(0);
    }
  }
});

ws.addEventListener('error', (error) => {
  console.error('hub connection failed — is the hub running on 4517?', error?.message ?? '');
  process.exit(1);
});
