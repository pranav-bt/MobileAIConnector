# Agent HQ

Your AI-agent company, visualized as an office. A master agent routes tasks
to team leads, leads run worker subagents, and anything that needs your
sign-off raises a hand — on your PC, and (soon) on your phone with a
biometric-signed approval and a "Jarvis" wake word.

Concept mockups: https://claude.ai/code/artifact/2ca3a0e6-562e-4184-a465-0eeab90b2d1f

## Quick start

```bash
npm install
npm run hub        # terminal 1 — the hub, running REAL agents (empty until you submit work)
npm run desktop    # terminal 2 — open http://localhost:5173 (or `npm run shell` for the native window)
```

The office starts empty except for the master and the team leads standing
by. Type a task into the composer: the master routes it to a team, a worker
runs it (permission requests raise a hand for your approval), and the
lead's reviewed synopsis lands in History. Nothing spends usage until you
submit a task.

`npm run hub:demo` runs a scripted showcase scenario instead (no real
agents, no usage) — useful for a tour of the UI, never the default.

## Structure

| Path | What it is |
|---|---|
| `packages/shared` | Protocol + schemas — the contract everything obeys |
| `packages/hub` | Background service: orchestration, transport, security |
| `packages/desktop` | Office UI (React/Vite; Tauri shell planned) |
| `android/` | Kotlin companion app (planned) |

See `CLAUDE.md` for conventions and the milestone plan.
