# Agent HQ

PC + Android product that visualizes an AI-agent company as an office
floor plan: a master agent routes tasks to team leads, leads run worker
subagents, permission requests bubble to the desktop and (later) the phone.

Design canvas (source of truth for look & vocabulary):
https://claude.ai/code/artifact/2ca3a0e6-562e-4184-a465-0eeab90b2d1f

## Layout

- `packages/shared` — **the contract.** Zod schemas for entities, `HubEvent`,
  `ClientCommand`, plus the one `applyEvent` reducer used by hub and clients.
  Change behavior here first; everything else follows the schema.
- `packages/hub` — Node background service: event bus (`bus.ts`), WebSocket
  server (`server.ts`), JSONL event log (`persist.ts`), demo driver
  (`demo.ts`), Claude Agent SDK engine (`engine/`), pairing/kill-switch
  crypto (`security/pairing.ts`).
- `packages/desktop` — React + Vite office UI; pure client of the hub. Runs
  in a browser (`npm run desktop`) or in the Tauri shell (`src-tauri/`,
  `npm run shell:dev -w @agent-hq/desktop`) which adds the native window,
  tray (close hides, Quit exits), and the global Ctrl+Shift+K kill hotkey.
  Building the shell needs the Rust toolchain (`~/.cargo/bin`) + MSVC.
- `android/` — Kotlin + Compose companion app: QR pairing, encrypted session
  (crypto interop-tested against hub vectors — regenerate via
  `npx tsx test/gen-session-vectors.ts` in packages/hub), biometric-signed
  approvals, task submission. Build: `cd android && gradlew.bat assembleDebug`
  (JDK 17 at C:\Program Files\Microsoft\jdk-17*, SDK via local.properties).

## Commands

```
npm install            # once, at the repo root
npm run hub            # the hub — REAL Claude agents (default; empty until tasks are submitted)
npm run hub:demo       # scripted showcase scenario (no real agents, no usage) — opt-in only
npm run hub:mock       # orchestrator with deterministic mock engine (offline dev)
npm run desktop        # office UI on http://localhost:5173
"Agent HQ.exe" (Desktop)  # one click: starts hub + UI if down, then opens the app window
                       # source tools/launcher/AgentHqLauncher.cs, rebuild: tools\launcher\build.ps1
npm run smoke          # e2e smokes: demo hub + orchestrator (mock engine, no usage)
npx tsx test/engine.live.ts   # (from packages/hub) LIVE Claude-engine validation — spends usage
npx tsx test/codex-spike.live.ts  # (packages/hub) LIVE Codex app-server checks (approvals, sandbox,
                       # steer/interrupt/resume, strict JSON, MCP isolation) — spends a little Codex usage
npm run build          # build all packages (shared first)
npm run typecheck      # tsc across workspaces
```

## Conventions

- Every state change is a `HubEvent` through `HubBus.publish` — never mutate
  state directly; persistence and clients rely on the event stream.
- The event vocabulary stays provider-agnostic (a Codex adapter must be able
  to emit it). Engine-specific code lives only under `packages/hub/src/engine/`.
- Usage is measured in tokens/percent of subscription limits, never dollars;
  dollars appear only around the overage toggle.
- A token count is everything the model processed: fresh input + cache
  writes + cache reads + output (`usageTokens` in engine/claude.ts; Codex's
  `totalTokens` already counts cached input). Engines also report cache reads
  as they happen (`observeUsage` → `Usage.cachedTokensToday`, shown as a share
  on the Resources page). Counting only fresh input + output showed ~1% of
  what a run pushed through the model. Project quotas default to 250M (old
  untouched 5M defaults are migrated on load; quotas only raise the 75% line).
- Quick checks (`engine.complete`: routing, reviews, card explanations,
  coordination, split/rules/message checks) answer from the prompt alone, so
  they run with `tools: []`, `strictMcpConfig: true` and `settingSources: []`
  — without them each one carried Claude Code's tool definitions, every MCP
  server on the PC (started per call) and the settings + CLAUDE.md: ~39k
  tokens for a ~1k job. Live check: `npx tsx test/probe-quick-check.ts`.
- Transport policy: loopback clients speak plaintext; anything else must be
  the paired device over the encrypted session (X25519 static+ephemeral →
  HKDF → ChaCha20-Poly1305 frames, `security/session.ts`). Clients speak
  first — the hub classifies a connection by its first frame.
- Approval cards speak plain English: every `PermissionRequest` carries a
  `summary` (1-2 sentences: what the agent wants to do and why it needs a
  yes) that every surface shows FIRST — desktop card, phone card, the
  notification, the biometric prompt and Jarvis — with the raw command behind
  "show command". It opens with the rule-based `plainPermissionSummary`
  (instant, no model wait) and is replaced by `explainPermission` (quick-checks
  model) only while still pending. The explainer treats the command as
  untrusted, never calls anything safe or recommends a decision (persuasive
  output is dropped), and the policy's rule-based risk flags always stay on
  the card. Live check: `npx tsx test/permission-explain.live.ts`.
- Exactly one paired device slot; approvals arriving over a device session
  must be Ed25519-signed over `${decision}:${requestId}` — unsigned or
  forged approvals are dropped. Security commands (pairing, revoke, kill)
  are honored only from local clients.
- Teams are config records — creating one must always work as a single
  command (`team.create`), and the office UI renders rooms from the registry.
  A team record may carry per-team MCP server grants (`mcpServers`): its
  workers get exactly those connections (e.g. Roblox Studio for QA and the
  Game Engine team) — enforced by `strictMcpConfig`, without which every
  worker also inherited the PC's user-scope servers (`test/probe-mcp-scope.ts`).
  Grants are picked by name from the servers configured for Claude Code on
  this PC (`engine/mcp-catalog.ts` reads ~/.claude.json; `HubInfo.mcpCatalog`),
  via `team.mcp.set` — local clients only, and raw `mcpServers` in
  team.create/update from a device session are dropped (a connection is a
  program the hub starts). Teams chartered for web work (`web` in allowedTools)
  browse without permission cards in auto mode. Roster setup lives in
  `tools/setup-teams.mjs` (idempotent, talks to the running hub).
- Apps (Settings > Apps; `data/apps.json`, `AppRegistry` in apps.ts) are
  desktop programs the owner adds (`app.add`/`app.update`/`app.remove`,
  local clients only — an app is a program the hub starts) and grants to
  teams like an MCP server: the app id is in `HubInfo.mcpCatalog`
  (`team.mcp.set`), records on `HubInfo.apps`, detected Blender installs on
  `appSuggestions` (Blender's id is always `blender`, so its tools read
  `mcp__blender__…`). A grant runs Agent HQ's app bridge
  (`packages/hub/apps/app-bridge.mjs`, a dependency-free MCP stdio server)
  that reads the app's record when it starts — `#withApps` rebuilds every app
  grant from the registry per run (edits need no re-grant; removed apps
  drop; removing an app strips it from teams). Tools: status / open (a file)
  / close / run (CLI mode, output captured); Blender adds python (bpy,
  variables persist), render (PNG returned as an image; a temporary
  camera/light when the scene has none, all restored) and scene, through
  `apps/blender_bridge.py` inside Blender (127.0.0.1 socket + per-session
  token; with a window a timer drains requests on the main thread, `-b` runs
  a loop; it quits when the bridge's process dies — never `os.kill(pid, 0)`
  on Windows). The app opens on first need and closes on `close`, after
  `idleMinutes`, or when the worker's session ends — only what the bridge
  opened. Reviewer seats get `--read-only` (no python, no run, no open
  args). Workers are told their apps in the brief (`#appsNote`). App tools
  run without cards like any MCP tool (the Settings card says so: grant
  them to teams you'd trust with a shell). Codex asks before EVERY MCP tool
  call (`mcpServer/elicitation/request`, `codex_approval_kind:
  mcp_tool_call`): a granted server's call is accepted, any other server's
  goes through the policy, a server's own form is declined. Tests:
  `apps.smoke` (in `npm run smoke`), `blender-app.live.ts [--visible]` (real
  Blender, no model), `apps-worker.live.ts [--model gpt-6.1-sol]` (a real Art
  worker with no shell models, renders, saves and closes Blender),
  `probe-codex-mcp-approval.ts`, UI driver `tools/drive-apps.mjs`.
- Interdisciplinary flow is master-driven: after every completed report the
  master runs a coordination pass (haiku) and may dispatch follow-up tasks to
  other teams (leads huddle in the Meeting room); QA reports get a verdict
  instead — real issues send the SAME task back to its worker's own
  conversation with QA's findings (`#qaFindings`; the run's prompt says it's
  QA, no coordination pass after it; re-QA'd when files changed), capped at
  two rounds (`#qaFixRounds`) before escalating to the owner (a freelancer's
  fix is still a `[fix]` task on its same session). Both are depth-capped so
  follow-ups can't cascade.
- Rules first, the model as the backup: the hub decides from fixed rules
  where they clearly apply and leaves everything else to the model exactly as
  before, so no work stops for want of a rule.
  - Report lines: every worker (not split parts) ends its report with
    `STATUS: done | blocked — why`, `HAND-OFFS: none | <team>: …; …` and, for
    QA, `VERDICT: pass | issues — …` (`reportLinesInstruction` in master.ts;
    `parseReportLines` in shared). A short report (≤900 chars, ≤12 lines, no
    rule conflict, no pair note) with a STATUS line skips the lead review
    (`reportAsWritten`; blocked → stuck as before); the QA verdict comes from
    VERDICT; `HAND-OFFS: none` skips the coordination pass only when the
    master has no general or handover rules (only the model can apply those).
    A missing line → the model, as before.
  - Routing (`routeByRules`): a `team:` prefix or a "## Routing" table line
    `keywords → Team [@project]` (`parseRoutingTable`; other bullets stay
    guidance for the model) fixes the team when exactly one team matches. If
    the project is certain too (@pin, the rule's @project, one named project)
    the ask routes with no model call; otherwise the master still judges the
    project with a smaller prompt (`fixedTeam`: no roster, no plans) — the
    thread is never assumed. Several teams, no match, or "## Pairing" rules to
    apply (passed only when the owner didn't pick /pair or /solo) → the
    master as before. The routed line says which rule decided.
    `rules.suggest` (Teams page button, `/routing suggest`) is the one-time
    tool: the master drafts table lines from the asks it routed and a
    `rules-suggest-…` card adds them under "## Routing".
  - QA (`#qaWanted`): `/qa` on the ask (`Task.qa`, `qa` on task.submit) > the
    run changed nothing (`filesChanged`; any non-read MCP call counts as a
    change, `mcpMayChange`) → no QA > a team named under "## QA" in the
    master's rules (default `- Coding team`, appended to older rules files;
    an emptied section = no automatic QA; the freelance desk can be named) >
    a QA rule in words → the checks model (`checkQaRules`; an unreadable
    answer runs QA). Every skip says why in the task's console.
  Tests: `rules-first.smoke` (in `npm run smoke`), `rules-first.live.ts
  [--model gpt-6.1-sol]` (real workers write the lines; Claude and Codex),
  the `team:` cases in `routing-ask.live.ts`.
- Team notes (`data/teams/<id>/MEMORY.md`): what a worker had to work out
  the hard way goes to its team so the next one doesn't solve it again.
  Every worker — split parts too (`learnedLineInstruction`) — ends with
  `LEARNED: none | <problem> → <what worked>` (one line each, ≤3 kept;
  tool/app quirks and workarounds, not this project's facts, never keys);
  `#saveLessons` appends them (`appendMemory`: dated, `cleanNote` = one line
  ≤400 chars with key-like runs redacted, repeats skipped, the owner's own
  lines kept, oldest dated bullets dropped past 60) and says "noted for the
  team" in the console; a part's lessons are stripped from its report to
  the integrator. The lead review's `memoryNote` is only the backup when the
  report has no LEARNED line. Briefs carry the owner's non-bullet lines +
  the newest notes within 6000 chars (`readMemory`), framed as background,
  not instructions. Team records carry the file as `notes` (like `rules`;
  the same 3 s watcher via `recordStamp`); the Teams page "Team notes" card
  lists them newest first with × to remove and "Edit as text" (MEMORY.md),
  `team.notes.set`. Tests: `team-notes.smoke` (in `npm run smoke`), UI
  driver `tools/drive-team-notes.mjs` (with `test/ui-mock-hub.ts 4665`).
  With a 'full' folder granted (Bots), each team also has a kit,
  `<full>\kit\<team id>` (`#kitDir`): the LEARNED instruction tells a worker
  to save a reusable script/file behind a lesson there and name it in the
  line, and the brief lists the kit's newest 25 file names (`#kitNote`,
  names only). Tested in `bots-folder.smoke`.
- One window per ask: QA passes, handovers to other teams, recovery moves,
  later plan steps and split pieces carry `Task.rootTaskId` = the owner's ask.
  `#row` mirrors every step row into the ask's transcript (id
  `<step>~<row>`, `stepTaskId`), so the ask's console is the whole story; a
  message to the ask goes to a step that's working (else continues the ask);
  stopping the ask stops its live steps. Clients fold steps with `foldAsks`
  (shared/threads.ts; Android `model/Asks.kt`): one card per ask, live with
  the working step ("now: QA team — QA check"), a trail when done, tokens
  summed — Today, Tasks, History, and the phone. Tests: `one-window.smoke`
  (in `npm run smoke`), `tools/drive-one-window.mjs`, `AsksTest`.
- A message typed in a task's window skips the master's routing, so the
  master checks who it's for (`routeThreadMessage` in master.ts, the quick-
  checks model, with the thread: first ask, latest report, steps, who's
  working): "same" (follow-ups, questions, corrections, more of the same
  kind of work — the default) → delivered as before (`#deliverMessage`: the
  working step, the task's worker, a pair's chair, or a continuation);
  "team" (new work whose DELIVERABLE is another team's craft — art, sound,
  docs, a security review… — judged by what's produced, not the feature) →
  `#handOffMessage`: a new step of the ask on that team, same project and
  window, its brief carrying the thread; the thread's own team while a
  step of another team works → the task itself (`skipSteps`); "ask" → a
  `msg-<ask>-…` pick-one card (Keep it here / teams; None holds it; the
  task's status is untouched). Short nudges (≤3 words) skip the check; a
  failed check delivers as before; one task's messages are routed in order
  (`#messageChains`). Freelancer and mid-debate messages are unchanged.
  Tests: `message-routing.smoke` (in `npm run smoke`),
  `message-routing.live.ts [--model …]` (classification only, real roster).
- Folder access (Settings > Hub, `access.set`, local clients only — a device's
  is dropped; `data/config.json` `accessGrants`, default: `%TEMP%\claude`,
  Claude Code's scratch folder, read & write): 'write' folders join every
  worker's writable scope (`#extraDirs` → Claude's directory grants, the shell
  policy, Codex's writableRoots); 'read' ones are named to workers. Each
  worker also gets its project's own Claude Code folder
  (`<claudeProjectsDir>/<cwd slug>` — memory, tool results), as Claude Code
  in VS Code has it. Refused: relative paths, missing folders, a whole drive
  for writing, Agent HQ's data dir. The shell policy no longer reads
  `/dev/null`, regexes (`\s*`, `\n`), awk programs or a bare `/` as write
  targets (they were most of the false "writes outside this project" cards).
  Workers already load the project's CLAUDE.md and `.claude/settings*.json`
  (settingSources default = all).
  A 'full' grant (the owner's `D:\Work\Bots`) is a scratch + hand-over
  space: writable like 'write', AND deletes there need no card
  (`deletesOnlyInFreeDirs` in policy.ts, scope `freeDirs`) — only when every
  target is plainly inside it (a full path, or a plain name after a `cd`
  into it in the same command; piped deletes need a source there; git needs
  `-C` there or a cd in). A `..`, a variable, a bare name with no cd, a
  junction out, the folder itself, a shell-in-a-shell or any other
  destructive command alongside still asks. Refused for full: a project, a
  folder holding one, a workspace root. Granted folders are never offered as
  projects (`ProjectRegistry.hideFolders`). The brief names it and tells
  workers to judge up front whether work is destructive/churny and do that
  part in `<full>\<team>\<task>`, hand-overs in `<full>\shared`, only
  finished results into the project (`#accessNote`). The shell policy also
  no longer reads the program a command RUNS (`"C:\…\python.exe" x.py >
  out`) or a heredoc's script body (unless fed to a shell) as write targets,
  and `Format-Table` is no longer "destructive" (`Format-Volume` is). Tests:
  `bots-folder.smoke` (in `npm run smoke`).
- Project MCP: besides its team's grants, a worker gets the MCP servers set
  up for its project folder, as Claude Code opened there loads them
  (`projectMcpServers` in engine/mcp-catalog.ts): the folder's own servers
  (`claude mcp add` there → ~/.claude.json `projects`, any path casing) and the
  project's `.mcp.json` servers the owner APPROVED (enableAllProjectMcpServers
  / enabledMcpjsonServers in ~/.claude.json or the project's
  `.claude/settings(.local).json`; disabledMcpjsonServers wins; `${VAR}`
  expanded). An unapproved one never starts (a program from the repo) and
  the task says so. Merged in `#workerTeam` for authors and side seats (both
  engines take it via `team.mcpServers`); the team's grant wins a name clash.
  User-scope servers still reach workers only as team grants. Tests:
  `project-mcp.smoke` (in `npm run smoke`), `roblox-mcp.live.ts` (real workers
  reach Roblox Studio via a project's .mcp.json and via a team grant; neither
  → no tool).
- Stuck tasks get one recovery pass (`planRecovery`, quick check): a task is
  stuck when its run fails, when the lead review returns `stuck` (the worker
  did not achieve the main goal — the task is marked failed "Stuck — …", no
  QA, no coordination), or when QA still fails after two fix rounds (no plain
  retry then). The master proposes ONE move — retry / handover / split (2-3
  sequential steps via `#runChain`) / ask — from charters, team tools and the
  master rules, and raises a `stuck-<taskId>` card (Do it / Leave it) unless
  a master rule explicitly allows acting alone (`auto`, only honored when
  master rules exist). Account-wide failures (usage/rate limits, sign-in,
  network) are "ask" without a model call. Work a recovery spawned — and its
  QA/fix/handover descendants (`#recoveryRound`) — is never auto-recovered
  again; it escalates. Live check: `npx tsx test/stuck.live.ts`.
- Big build tasks fan out (lead split pass, `planParallelSplit` in
  master.ts): before a bash-capable team runs a task, its lead may split it
  into a shared contract + optional `[scaffold]` + 2..min(4, worker cap)
  `[part k/n]` tasks with disjoint file ownership. Parts run on parallel
  workers (no git, no repo-wide tests/builds, no sub-agents, no lead review,
  no QA of their own); then ONE integration worker runs the original task
  with every part's raw report, builds, tests, commits, and gets the normal
  review/QA/coordination. Pieces carry `parentTaskId`: they show while
  running but are hidden from finished lists and project history, and their
  tokens roll up into the parent. Stopping the parent stops its parts; a
  global pause holds the integration until resume. Workers outside a split
  may use at most 3 sub-agents (`maxSubagents` on `runWorker`). A team with a
  worker cap of 1 never splits. The split check is a quick check (haiku
  default) and is skipped for short asks and `[QA]`/`[fix…]`/piece titles
  (`splitWorthChecking`). A plan is refused (task runs unsplit) unless every
  part owns a non-empty path list and no path equals/nests in another part's
  (`ownershipIsDisjoint`; paths are normalized against the project
  workspace, so "/src/a", "src/a" and "D:/repo/src/a" collide, and absolute
  paths outside it are refused). Split pieces never queue behind later tasks: the
  planning slot travels scaffold -> part 1 -> integration, and waiting parts
  sit in a priority line `#drainQueue` serves first. Live check:
  `npx tsx test/split.live.ts` (packages/hub; separate hub on 4609).
- Projects are config records too (`data/projects.json`): a workspace dir +
  token ledger. Workers run inside their task's project workspace and see
  only that project's files, that project's recent synopses, and their
  team's MEMORY.md — never another project's context. The hub workspace is
  always registered as the default project. Isolation is enforced twice:
  Write/Edit outside the workspace are REFUSED by the engine, and because the
  shell is not confined by the SDK's directory grants, `evaluatePermission`
  path-checks Bash too — a shell WRITE (cp/mv/redirect/`sed -i`/`Set-Content`,
  or a `git -C`/`--git-dir` aimed at another repo) whose target resolves
  outside the workspace raises a card even in auto mode, while shell READS
  across the drives stay silent. Containment goes through `realPath`, so a
  junction can't tunnel out. Workers are told the same: READ/SEARCH anywhere
  under the workspace roots, WRITE only in their project (+ the phone
  inbox/outbox; the PA team also gets its desk, `data/pa`, from any project).
- The master never guesses a project and never falls back to a default.
  `routeTask` resolves it deterministically: `@project` pin > projects the
  owner named in the text (`namedProjects`, spacing-insensitive whole words;
  the model may pick only among those + the thread's) > the thread's project
  (latest non-stopped task carrying `ownerAsk`) when the model's verdict is
  `"project": "thread"` (follow-ups and vague references are the thread) >
  `"general"` (about no project — errands, questions, setup/admin work the
  owner says isn't for a project; ANY team, shell work included) runs in the
  built-in **General** project: its own folder outside every repo
  (`~/AgentHQ/General`, `generalDir` option; `GENERAL_ID` in projects.ts,
  never removed, never the thread, and the word "general" never names it —
  only `@general`) > otherwise ASK: a `project-<taskId>` pick-one card
  (`PermissionRequest.options`, answer = approve + `choice`, phone-signed over
  `approve:<id>#<choice>`) offering the model's suggestions + the thread's
  project + always General last, so it's never empty. Suggestions may be unregistered
  folders under the workspace roots (`ProjectRegistry.discoverFolders`;
  picking one registers it), and an @pin to such a folder offers the same.
  "None of these" runs nothing (paused, leaves the thread). Other projects
  appear in the prompt as suggestion-only; a model title naming a project
  the task isn't in is replaced by the owner's words. Live check:
  `npx tsx test/routing-ask.live.ts`. Leaving
  the thread's project because a name was mentioned takes a master card
  (`route-<taskId>`; deny keeps it in the thread, an @pin skips it). An
  @pin that matches neither a project nor a folder fails the task loudly and
  runs nothing.
  Only an ask the owner stopped leaves the thread; KILL ALL and a restart
  keep it (`stoppedBy` on the task), and every routed line says why it went
  where it did. Regression: `test/routing.smoke.ts` + `test/thread.smoke.ts`
  (both part of `npm run smoke`).
- Rules are layered: every team has `data/teams/<id>/RULES.md` (the
  owner's, created from a template and never overwritten; `parseRules` in
  shared reads it — "- " bullets, free "## " groups, HTML comments are help
  text) and a project's own `CLAUDE.md` (loaded by the SDK for the worker)
  adds on top. Team records carry the file as `rules` for clients (never
  stored in teams.json; a 3 s stat watcher republishes hand edits). Before a
  worker starts, `detectRuleConflicts` (quick check) compares the two — only
  when the team has rules AND the project has a CLAUDE.md, once per version
  of both — and each genuine contradiction becomes a master card
  (`rules-…`, `choices` = custom button labels; approve = project wins, deny
  = team wins, so phone signatures are unchanged). The answer is appended
  under "## Resolved conflicts" as `[<projectId>] …`; workers see only their
  project's decisions. A stopped card records nothing. Edit via the desktop
  Teams page, `team.rules.set`/`team.rules.add` (optional `section`), or
  `/rule <team>[/<section>]: <text>`. Live check:
  `npx tsx test/rules-conflict.live.ts`. Bullets under "## Tools" are the
  team's tools (what to use for which job): workers get them as a list,
  routing/handover/recovery prompts see their names — guidance only, every
  command still goes through `evaluatePermission`. The master has its own
  `data/master/RULES.md` (teamId "master"; on `HubInfo.masterRules`):
  "## Rules" applies everywhere, "## Routing" / "## Handover" /
  "## Splitting" / "## When a task is stuck" feed only that pass ("## QA"
  and the "## Routing" table are read by the hub itself, see Rules first)
  (`rulesFor`). Master rules never move a task's project. Rules files live in
  the hub's data dir, which workers can't write (below).
- Agent HQ's own data dir (pairing keys, secrets, config, every RULES.md) is
  locked for workers even in the hub project, where it sits inside the
  workspace: `LockedDir` (util.ts) — Write/Edit refused by the engine
  (`refusedWrite`), shell writes raise a card ("writes Agent HQ's own data").
  Open: `data/art`, inbox/outbox, and `data/pa` for the PA team.
- Composer slash-commands (parsed client-side, deterministic): /pair <task> ·
  /pair split <task> · /pair debate <task> · /solo <task> (also read by the
  hub, so the phone just prefixes) · /team add
  <name>: <charter> · /team workers <team> <n> · /team remove <team> ·
  /rule <team>[/<section>]: <rule> (team "master" = the master's rules) ·
  /project add <name> <path> [description] · /project remove <project>.
  Prefixing a task with @<project> pins it to that project.
- Model choices (Settings > Models, `models.set`) are an override LAYER in
  `data/config.json` (`modelOverrides`) over the built-in defaults (master
  opus, quick checks haiku) and each team record's `leadModel`/`workerModel`.
  Tiers map to ids in `MODEL_IDS`: opus = Opus 5.5, haiku = Haiku 5.5 (both
  checked on the decision live tests — routing-ask, message-routing,
  permission-explain, rules-conflict, stuck — before becoming defaults;
  `--model`/`--effort` on routing-ask and message-routing compare models),
  sonnet = Sonnet 5.
  Never write overrides into team records — keeping them untouched is what
  makes "Reset all to defaults" exact. Each choice sets `model` (a catalog
  id) and `effort` independently; precedence per field: per-team >
  all-leads/all-workers > default, via `resolveModel` in shared. The engine
  runs a `ModelSpec` (exact id + optional effort; no effort = the model's own
  default). `MODEL_CATALOG` (shared/schema.ts) lists only ids verified live
  — after an Agent SDK update re-run `test/probe-models.ts --live` and
  `test/probe-effort-defaults.ts` (packages/hub) and refresh ids/defaults.
  Opus 5.5 needs Agent SDK >= 0.3.280.
- Task Console (desktop drawer / pop-out window, phone full screen): a task's
  whole story + a message box. Engines report `EngineRow`s (messages,
  thinking, tool rows that go running → ok/error with output, edits as diff
  rows) via `onTranscript`; the orchestrator adds the owner's ask, non-worker
  activity as status rows, every card (live buttons, by `requestId`), the
  lead's review, and link rows to QA/fix/handover/recovery tasks. Rows live
  in `data/transcripts/<taskId>.jsonl` (`TranscriptStore`: append-only, rows
  upserted by id, output capped) — NEVER in the global event log; only
  clients that sent `task.watch` get `task.transcript` frames (per
  connection in server.ts; backfill pages via `before`). Every task keeps
  its worker's conversation (`Task.session`, reported early via
  `onSession`). `task.message`: running → the run's `MessageInbox` (Claude:
  streaming input, a mid-turn message folds into the turn — verified by
  `test/probe-claude-steer.ts`; Codex: `turn/steer`, or one more turn if it
  just ended); waiting → added to the brief; finished/failed/stopped →
  `#continueTask` resumes the SAME session (same engine; otherwise a fresh
  run with the history), the lead re-reviews, and QA re-runs only if the run
  reported `filesChanged`. Stop keeps the session. Tests: `console.smoke`
  (in `npm run smoke`), `console.live.ts [--model gpt-6.1-sol]`, the phone
  path in `pairing.smoke`, UI driver `tools/drive-console.mjs` (with
  `test/ui-mock-hub.ts`). The Tauri shell's permissions live in
  `src-tauri/capabilities/default.json` (console windows are `console-*`).
- Two engines, any seat: catalog entries carry `engine` ('claude' | 'codex'),
  `resolveModel` returns it in the `ModelSpec`, and `EngineRouter`
  (engine/router.ts) sends each call to `ClaudeEngine` or `CodexEngine`
  (mock mode: `MockEngine` stands in for both and logs `mock: engine <id>`).
  Codex = OpenAI models on the owner's ChatGPT plan, driven through the VS
  Code extension's bundled CLI as `codex app-server` (JSON-RPC over stdio,
  engine/codex-rpc.ts; binary found by `findCodexBinary`, override
  `AGENT_HQ_CODEX`); started lazily, one process, `--disable apps`. Workers:
  approvalPolicy "untrusted" so EVERY command and file edit asks — commands
  are unwrapped from Codex's PowerShell wrapper (`unwrapShellCommand`) and go
  through the same `onPermission` → `evaluatePermission` as Claude's tools;
  file edits through the same `refusedWrite` lock (+ data/ lock); sandbox
  workspace-write with writable roots = project + extraDirs; MCP = exactly the
  team's grants (every PC-configured server disabled per thread unless
  granted); charter/rules as developerInstructions; threads labelled
  "Agent HQ · <task>" and archived after the run (resumable; id returned as
  `sessionId`). One-shot calls (`complete`) are read-only ephemeral threads.
  Codex workers do NOT run in Agent HQ's own project yet (owner's decision):
  that seat falls back to the team's Claude model with an activity line.
  Codex plan limits are read (free) while Codex runs → `Usage.codex`;
  `ModelTier` gains 'codex' for meters/chips; agents carry `modelId`.
  Effort 'ultra' exists only on some Codex models. Tests: `codex-engine.smoke`
  (fake app-server, in `npm run smoke`), `codex-spike.live`,
  `probe-codex-models.ts --live` (refresh the catalog after a Codex update),
  `mixed-seats.live` (master Fable, lead Opus 5.5, workers GPT-6.1-Sol), and
  the decision tests take `--model gpt-6.1-sol`.
- Pair mode v1 (second opinion), OFF by default: per task via the composer's
  Pair button / `task.submit` `pair` flag / `/pair <task>` (`/solo` forces
  one worker), or per team via `pairByDefault` in `modelOverrides.teams`.
  The worker seat is the AUTHOR; a REVIEWER seat (`reviewer` in model
  overrides, all + per team; default = the other engine's flagship from the
  author's: Claude author → GPT-6.1-Sol, Codex author → Opus 5.5) runs
  read-only (`runWorker({ readOnly })`: Claude loses the write tools and shell
  writes are denied; Codex gets a read-only sandbox and declines edits) and
  replies with a JSON verdict (`parseVerdict` in shared: the last object with
  a boolean `agree`; agree + blocking ≠ agreement). Blocking issues go back
  to the author's SAME conversation; the reviewer keeps its own
  (`pair.reviewerSession`). Agreement names a version (`workVersion`: git
  diff + untracked files hash). After `PAIR_ROUNDS` (3) a `pair-<task>-<n>`
  pick-one card asks: Go with it / Two more rounds / None (= left for you,
  paused, out of the thread). An unreadable verdict is asked again once, then
  goes straight to the card. The lead CHAIRS: its review gets the second
  opinion folded in, and a message to a finished pair task goes through
  `#chairReply` — a question is answered, a change goes to the author and is
  re-reviewed (fresh 3-round budget). Review pairs never split. Codex may
  review in Agent HQ's own project (read-only). Tests: `pair.smoke` (in
  `npm run smoke`), `pair.live.ts` (Claude⇄Codex both ways, code + doc).
- Pair split (`pair.mode: 'split'`; Pair button clicked twice, `/pair split
  <task>`, `pairMode` on task.submit) = plan together, then split. The author
  (worker seat) drafts a split plan from the real project as a read-only
  "Planner" seat — the lead split's JSON plus `"builder": "you" | "partner"`
  per part (`parseParallelPlan` + `SPLIT_RULES` in master.ts, same ownership
  validation) — and the partner (the reviewer seat) reviews it as a verdict.
  Invalid plans go straight back to the author; rounds repeat until the
  partner agrees; the cap card offers Go with this plan / Two more rounds /
  Skip the split (`pair-<task>-plan<n>`). Then `#runSplit` runs with seats:
  scaffold on the author, each part on its builder (`Task.seat`, a
  ModelChoice `#runTask` honors) with `pair.reviewer` = the OTHER model, so
  every part gets a cross-review (part reviewers check only the part's owned
  files); the author integrates and the partner reviews the integrated whole
  in its plan conversation. The plan lives on `pair.plan` (parts link to
  their task ids; the console gets link rows to every part of any split).
  Falls back to a second opinion — with a line saying why — when the author
  says it's not worth splitting, the team has no shell or a cap < 2, or it's
  Agent HQ's own project with a Codex builder. Tests: `pair-split.smoke` (in
  `npm run smoke`), `pair-split.live.ts` (a real two-module build).
- Pair debate (`pair.mode: 'debate'`; Pair button three clicks, `/pair
  debate <task>`) = both draft, then converge. Round 1: author and partner
  draft independently and in parallel as read-only "Debater" seats (`-d<n>`;
  text teams draft the deliverable, code teams the exact approach). Each
  later round each reads the other's latest draft and replies
  `{accept, critique, draft}` (`parseExchange` in shared); the first side to
  accept the other's draft decides it (both = the author's revision). The
  owner's messages mid-debate (`#debating`) reach BOTH sides next round. Cap
  (round 4, i.e. 3 exchanges): Go with A's / Go with B's / Two more rounds;
  None leaves it for you. Then: text work — the accepted draft IS the report
  (`RunOptions.agreed`: no writing run; the chair's review folds in the debate
  note); code — the author implements the agreed approach (brief via
  `#integrationBriefs`) and the partner reviews it in its debate conversation
  (`pair.reviewerSession`). State on `pair.debate` (drafts, last exchange,
  winner). All structured pair replies are parsed by `lastJsonObject`
  (fast paths for pure/fenced JSON, then ≤400 candidate starts from the end
  — bounded on long, brace-heavy replies). Tests: `pair-debate.smoke` (in
  `npm run smoke`), `pair-debate.live.ts` (a steered text debate + a real
  bug fix), `tools/drive-pair.mjs` (all three modes in Edge).
- The master picks a pair mode ONLY from rules under "## Pairing" in its
  RULES.md (`MASTER_SECTIONS.pairing`; `/rule master/pairing: …`; an
  untouched old template is upgraded via `legacyMasterTemplate`): routing then
  asks for `"pair": review|split|debate|none` and `RoutingDecision.pair`
  carries it. Precedence: the owner's explicit choice (/pair, /solo, the
  button, `pair` on task.submit) > the master's rule-based pick > the team's
  pairByDefault ("none" falls through to it). The routed line ends "— your
  pairing rule". Live check: `test/pair-routing.live.ts` (tasks paused:
  routing only).
- Failover (opt-in, `modelOverrides.failover`, Settings > Models): a seat
  whose plan is at >= 90% of its 5-hour or weekly window (`Usage` /
  `Usage.codex`) runs on the other engine's flagship (`PAIR_REVIEWER_DEFAULT`)
  — master, quick checks, leads, workers, split parts, reviewers all go
  through `#failover`; announced once per seat; unchanged when both plans are
  nearly out or the other engine isn't installed (`EngineRouter.available`);
  Agent HQ's own project still keeps Claude workers.
- Codex freelancers: the owner's own Codex sessions (VS Code panel / codex
  CLI) join the Freelancers strip as `fx-<thread id>` agents (model 'codex').
  `codex-sessions.ts` reads `~/.codex/sessions/**/rollout-*.jsonl` by byte
  ranges only (rollouts reach hundreds of MB): session_meta's originator/
  source skip Agent HQ's own threads ("agent-hq"), `codex exec` runs and
  sub-agents; names from `session_index.jsonl`; open = the thread's writer
  lock is held (`thread-writer-locks/<id>.lock` reads fail with EBUSY) or
  written in the last 2 min. An instruction becomes a normal freelancer task;
  the orchestrator's runner continues the thread with `runWorker({ foreign:
  true })` — the owner's setup untouched (no HQ instructions, their MCP,
  model and effort, never archived) but every command/edit through the
  policy and cards; Codex allows one writer, so a thread their window holds
  continues in a FORK (later instructions continue the fork). Tests with a
  redirected Claude dir skip Codex unless given `codexHome`. Tests:
  `codex-freelancers.smoke` (fake ~/.codex, in `npm run smoke`),
  fake-app-server owner-thread cases in `codex-engine.smoke`,
  `codex-freelancer.live.ts` (real reader, counts only; fork + in-place on
  throwaway threads), `probe-codex-freelancer.ts` (the writer-lock facts).
- The phone renders pair seats' replies like the desktop (verdict / plan /
  exchange, raw one tap away): `model/PairReplies.kt` mirrors the shared
  parser (unit test `PairRepliesTest`).
- Image generation (`tools/generate-image.mjs`) is LOCAL FIRST: on-demand
  ComfyUI at D:\AI\comfyui (boots per job, watchdog kills it after ~2 min
  idle — zero background footprint; models: FLUX schnell fp8 default, SDXL
  via --model sdxl). The Gemini API is the fallback and the only path for
  --in image editing (key in data/secrets.json; free tier has zero image
  quota). Never wire paid or web-scraped generation.
