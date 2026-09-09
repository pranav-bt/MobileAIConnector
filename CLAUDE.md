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
- `packages/desktop` — React + Vite office UI (Tauri shell comes later; it
  runs in a browser today). Pure client of the hub.
- `android/` — Kotlin companion app (not scaffolded yet; see its README).

## Commands

```
npm install            # once, at the repo root
npm run hub            # hub in demo mode (mockup scenario, no usage spent)
npm run hub:engine     # hub running REAL Claude agents (spends usage)
npm run desktop        # office UI on http://localhost:5173
npm run smoke          # end-to-end smoke test against a demo hub
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
- Exactly one paired device slot; approvals from the phone must carry a
  signature the hub verifies (`PairingManager.verifyApprovalSignature`).
- Teams are config records — creating one must always work as a single
  command (`team.create`), and the office UI renders rooms from the registry.
