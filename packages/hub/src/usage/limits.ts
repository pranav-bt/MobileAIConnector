import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HubBus } from '../bus.js';

// Real subscription limits — the same numbers Claude Code's /usage shows,
// covering ALL account usage (chat sessions included), not just Agent HQ's
// agents. Read via the OAuth usage endpoint with the token Claude Code
// already stores locally. The token never leaves this machine except to
// api.anthropic.com, which is what it exists for.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_MS = 5 * 60_000;

interface Limits {
  windowPct: number;
  windowResetsAt: number;
  weeklyPct: number;
  weeklyResetsAt: number;
  overageEnabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readAccessToken(): string | null {
  try {
    const credentialsPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credentialsPath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed['claudeAiOauth'])) return null;
    const token = parsed['claudeAiOauth']['accessToken'];
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function parseBucket(bucket: unknown): { pct: number; resetsAt: number } | null {
  if (!isRecord(bucket)) return null;
  const utilization = bucket['utilization'];
  const resetsAt = bucket['resets_at'];
  if (typeof utilization !== 'number') return null;
  const resetMs = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN;
  return { pct: Math.max(0, Math.min(100, utilization)), resetsAt: Number.isFinite(resetMs) ? resetMs : 0 };
}

export async function fetchLimits(): Promise<Limits | null> {
  const token = readAccessToken();
  if (!token) return null;
  try {
    const response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body)) return null;
    const fiveHour = parseBucket(body['five_hour']);
    const sevenDay = parseBucket(body['seven_day']);
    if (!fiveHour && !sevenDay) return null;
    const extra = body['extra_usage'];
    return {
      windowPct: fiveHour?.pct ?? 0,
      windowResetsAt: fiveHour?.resetsAt ?? 0,
      weeklyPct: sevenDay?.pct ?? 0,
      weeklyResetsAt: sevenDay?.resetsAt ?? 0,
      overageEnabled: isRecord(extra) && extra['is_enabled'] === true,
    };
  } catch {
    return null;
  }
}

// Polls every 5 minutes and merges into usage state (HQ's own token tally
// and model mix stay intact). Silent when offline or logged out — the UI
// shows "unavailable" from the zeroed reset timestamps.
export function startLimitsPoller(bus: HubBus): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    const limits = await fetchLimits();
    if (stopped || !limits) return;
    bus.publish({ type: 'usage.updated', usage: { ...bus.state.usage, ...limits } });
  };
  void tick();
  const interval = setInterval(() => void tick(), POLL_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
