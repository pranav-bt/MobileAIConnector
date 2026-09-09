# Agent HQ

Your AI-agent company, visualized as an office. A master agent routes tasks
to team leads, leads run worker subagents, and anything that needs your
sign-off raises a hand — on your PC, and (soon) on your phone with a
biometric-signed approval and a "Jarvis" wake word.

Concept mockups: https://claude.ai/code/artifact/2ca3a0e6-562e-4184-a465-0eeab90b2d1f

## Quick start

```bash
npm install
npm run hub        # terminal 1 — hub in demo mode (no usage spent)
npm run desktop    # terminal 2 — open http://localhost:5173
```

The demo replays the concept-canvas scenario live: type a task into the
composer, approve the `npm install playwright` request when Worker C-3
raises a hand, and watch it resume.

`npm run hub:engine` swaps the demo for the real Claude Agent SDK engine —
tasks you submit then run actual agents in this repo (and spend usage).

## Structure

| Path | What it is |
|---|---|
| `packages/shared` | Protocol + schemas — the contract everything obeys |
| `packages/hub` | Background service: orchestration, transport, security |
| `packages/desktop` | Office UI (React/Vite; Tauri shell planned) |
| `android/` | Kotlin companion app (planned) |

See `CLAUDE.md` for conventions and the milestone plan.
