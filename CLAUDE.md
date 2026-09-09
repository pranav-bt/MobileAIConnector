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
- `android/` — Kotlin companion app (not scaffolded yet; see its README).

## Commands

```
npm install            # once, at the repo root
npm run hub            # the hub — REAL Claude agents (default; empty until tasks are submitted)
npm run hub:demo       # scripted showcase scenario (no real agents, no usage) — opt-in only
npm run hub:mock       # orchestrator with deterministic mock engine (offline dev)
npm run desktop        # office UI on http://localhost:5173
npm run smoke          # e2e smokes: demo hub + orchestrator (mock engine, no usage)
npx tsx test/engine.live.ts   # (from packages/hub) LIVE Claude-engine validation — spends usage
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
- Transport policy: loopback clients speak plaintext; anything else must be
  the paired device over the encrypted session (X25519 static+ephemeral →
  HKDF → ChaCha20-Poly1305 frames, `security/session.ts`). Clients speak
  first — the hub classifies a connection by its first frame.
- Exactly one paired device slot; approvals arriving over a device session
  must be Ed25519-signed over `${decision}:${requestId}` — unsigned or
  forged approvals are dropped. Security commands (pairing, revoke, kill)
  are honored only from local clients.
- Teams are config records — creating one must always work as a single
  command (`team.create`), and the office UI renders rooms from the registry.
