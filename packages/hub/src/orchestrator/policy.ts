import type { PermissionMode } from '../config.js';

// Permission policy. auto (default): routine work runs silently — edits,
// builds, tests, git commits inside the project workspace — and only the
// consequential escalates to a card on the desktop/phone. strict: every
// gated tool asks.

interface Escalation {
  pattern: RegExp;
  flag: string;
}

const BASH_ESCALATIONS: Escalation[] = [
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|update|upgrade|dlx|exec)\b/i, flag: 'installs packages' },
  { pattern: /\b(pip3?|pipx|uv|cargo|gem|composer|go)\s+(install|add|get)\b/i, flag: 'installs packages' },
  { pattern: /\b(winget|choco|scoop|apt(-get)?|brew|dnf|pacman)\b/i, flag: 'system package manager' },
  { pattern: /\bgit\s+push\b|\bnpm\s+publish\b|\bgh\s+(pr\s+create|release|repo\s+(create|delete))\b/i, flag: 'publishes / pushes' },
  { pattern: /\brm\s+-\w*[rf]|\bRemove-Item\b|\brmdir\b|\bdel\s+\/|\bgit\s+(reset\s+--hard|clean\s+-\w*f|push\s+--force)\b|Format-|mkfs/i, flag: 'destructive' },
  { pattern: /\bcurl\b|\bwget\b|Invoke-WebRequest|Invoke-RestMethod|\bssh\b|\bscp\b|\bnc\b|\btelnet\b/i, flag: 'network access' },
  { pattern: /\breg(\.exe)?\s+(add|delete)\b|\bnetsh\b|\bsc(\.exe)?\s+(start|stop|config|create)\b|\bschtasks\b|\bshutdown\b|Set-ItemProperty/i, flag: 'system configuration' },
];

export type PolicyVerdict = { decision: 'allow' } | { decision: 'ask'; flags: string[] };

export function evaluatePermission(toolName: string, command: string, mode: PermissionMode): PolicyVerdict {
  if (mode === 'strict') return { decision: 'ask', flags: [] };
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return { decision: 'allow' };
  if (toolName === 'WebFetch') return { decision: 'ask', flags: ['network access'] };
  if (toolName === 'Bash') {
    const flags = [...new Set(BASH_ESCALATIONS.filter((rule) => rule.pattern.test(command)).map((rule) => rule.flag))];
    return flags.length > 0 ? { decision: 'ask', flags } : { decision: 'allow' };
  }
  return { decision: 'ask', flags: [] }; // unknown gated tool — be safe
}
