import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessGrantSchema, ModelOverridesSchema, type AccessGrant, type ModelOverrides } from '@agent-hq/shared';

// Hub-level configuration (data/config.json). Workspace roots are the ONLY
// places projects and files may live; project registration outside them is
// refused and workers are told the policy.

export interface WorkspaceRoot {
  key: string; // short handle used in commands: /project new <name> <key>
  path: string;
  label: string;
}

export type PermissionMode = 'auto' | 'strict';

export interface HubConfig {
  workspaceRoots: WorkspaceRoot[];
  permissionMode: PermissionMode;
  paEnabled: boolean; // the PA desk master switch (/pa on|off)
  modelOverrides: ModelOverrides; // owner model choices over the defaults
  accessGrants: AccessGrant[]; // folders every worker may read / write (Settings > Hub)
  // Away: cards left unanswered this long get their safe answer.
  away: AwayState;
}

export interface AwayState {
  on: boolean;
  since: number | null;
  minutes: number;
}
export const DEFAULT_AWAY_MINUTES = 15;

// Claude Code's scratch folder (…\Temp\claude\<project>\<session>\scratchpad):
// workers use it the way Claude Code does in VS Code, so it's open by default.
export const DEFAULT_ACCESS_GRANTS: AccessGrant[] = [{ path: join(tmpdir(), 'claude'), access: 'write' }];

const DEFAULT_CONFIG: HubConfig = {
  workspaceRoots: [
    { key: 'personal', path: 'D:\\PersonalWork', label: 'Personal projects' },
    { key: 'work', path: 'D:\\Work', label: 'Work projects' },
    { key: 'ai', path: 'D:\\AI', label: 'Misc — tools, temp projects, anything else (subdirs ok)' },
  ],
  permissionMode: 'auto',
  paEnabled: true,
  modelOverrides: { teams: {} },
  accessGrants: DEFAULT_ACCESS_GRANTS,
  away: { on: false, since: null, minutes: DEFAULT_AWAY_MINUTES },
};

export function loadHubConfig(dataDir: string): HubConfig {
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<HubConfig>;
      return {
        workspaceRoots:
          Array.isArray(parsed.workspaceRoots) && parsed.workspaceRoots.length > 0
            ? parsed.workspaceRoots
            : DEFAULT_CONFIG.workspaceRoots,
        permissionMode: parsed.permissionMode === 'strict' ? 'strict' : 'auto',
        paEnabled: parsed.paEnabled !== false,
        modelOverrides: (() => {
          const result = ModelOverridesSchema.safeParse(parsed.modelOverrides ?? {});
          return result.success ? result.data : { teams: {} };
        })(),
        // Missing = the defaults; an edited list (even empty) is the owner's.
        accessGrants: Array.isArray(parsed.accessGrants)
          ? parsed.accessGrants.flatMap((grant) => {
              const result = AccessGrantSchema.safeParse(grant);
              return result.success ? [result.data] : [];
            })
          : DEFAULT_ACCESS_GRANTS,
        away: {
          on: parsed.away?.on === true,
          since: parsed.away?.on === true && typeof parsed.away.since === 'number' ? parsed.away.since : null,
          minutes: typeof parsed.away?.minutes === 'number' && parsed.away.minutes >= 1 ? parsed.away.minutes : DEFAULT_AWAY_MINUTES,
        },
      };
    } catch {
      /* unreadable — fall through to defaults */
    }
  }
  writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
  return DEFAULT_CONFIG;
}

export function savePermissionMode(dataDir: string, mode: PermissionMode): void {
  const configPath = join(dataDir, 'config.json');
  const config = loadHubConfig(dataDir);
  writeFileSync(configPath, JSON.stringify({ ...config, permissionMode: mode }, null, 2));
}

export function savePaEnabled(dataDir: string, enabled: boolean): void {
  const configPath = join(dataDir, 'config.json');
  const config = loadHubConfig(dataDir);
  writeFileSync(configPath, JSON.stringify({ ...config, paEnabled: enabled }, null, 2));
}

export function saveModelOverrides(dataDir: string, overrides: ModelOverrides): void {
  const configPath = join(dataDir, 'config.json');
  const config = loadHubConfig(dataDir);
  writeFileSync(configPath, JSON.stringify({ ...config, modelOverrides: overrides }, null, 2));
}

export function saveAccessGrants(dataDir: string, grants: AccessGrant[]): void {
  const configPath = join(dataDir, 'config.json');
  const config = loadHubConfig(dataDir);
  writeFileSync(configPath, JSON.stringify({ ...config, accessGrants: grants }, null, 2));
}

export function saveAway(dataDir: string, away: AwayState): void {
  const configPath = join(dataDir, 'config.json');
  const config = loadHubConfig(dataDir);
  writeFileSync(configPath, JSON.stringify({ ...config, away }, null, 2));
}
