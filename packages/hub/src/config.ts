import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
}

const DEFAULT_CONFIG: HubConfig = {
  workspaceRoots: [
    { key: 'personal', path: 'D:\\PersonalWork', label: 'Personal projects' },
    { key: 'work', path: 'D:\\Work', label: 'Work projects' },
    { key: 'ai', path: 'D:\\AI', label: 'Misc — tools, temp projects, anything else (subdirs ok)' },
  ],
  permissionMode: 'auto',
  paEnabled: true,
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
