import type { PermissionMode } from '../config.js';

// Permission policy. auto (default): routine work runs silently — edits,
// builds, tests, git commits, and READING (files and the public web) — and
// only the consequential escalates to a card on the desktop/phone: installs,
// publishing/pushing, destructive commands, sending data out, remote access,
// system config, and reading credential-like files. strict: every gated
// ACTION asks (reads stay silent unless they touch sensitive data).

interface Escalation {
  pattern: RegExp;
  flag: string;
}

// Paths that look like credentials/secrets: reading them always asks, in
// every mode, whichever tool does the reading.
const SENSITIVE_READ =
  /(\.ssh[\\/]|\.aws[\\/]|\.gnupg|\.credentials|credentials\.json|secrets\.json|(?<![\w.])\.env\b|id_rsa|id_ed25519|\.pem\b|\.kdbx|\.netrc|\.git-credentials|User Data[\\/].+(Cookies|Login Data))/i;

const BASH_ESCALATIONS: Escalation[] = [
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|update|upgrade|dlx|exec)\b/i, flag: 'installs packages' },
  { pattern: /\b(pip3?|pipx|uv|cargo|gem|composer|go)\s+(install|add|get)\b/i, flag: 'installs packages' },
  { pattern: /\b(winget|choco|scoop|apt(-get)?|brew|dnf|pacman)\b/i, flag: 'system package manager' },
  { pattern: /\bgit\s+push\b|\bnpm\s+publish\b|\bgh\s+(pr\s+create|release|repo\s+(create|delete))\b/i, flag: 'publishes / pushes' },
  { pattern: /\brm\s+-\w*[rf]|\bRemove-Item\b|\brmdir\b|\bdel\s+\/|\bgit\s+(reset\s+--hard|clean\s+-\w*f|push\s+--force)\b|Format-|mkfs/i, flag: 'destructive' },
  // Killing processes needs a card — a worker once killed the hub (its own
  // host process) to "restart" it, freezing every task with it.
  { pattern: /\bStop-Process\b|\btaskkill\b|\bkill\s+(-\d+\s+)?\d+|\bpkill\b/i, flag: 'kills processes' },
  // Plain network READS (fetching a page, downloading a reference) are
  // routine research and run silently; what escalates is SENDING data out…
  {
    pattern:
      /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b.*(\s-(d|F|T)\b|--data|--form|--upload-file|-X\s*(POST|PUT|PATCH|DELETE)\b|-Method\s+(Post|Put|Patch|Delete)\b)/i,
    flag: 'sends data out',
  },
  // …or anything that opens remote access.
  { pattern: /\bssh\b|\bscp\b|\bnc\b|\btelnet\b|\bftp\b/i, flag: 'remote access' },
  { pattern: /\breg(\.exe)?\s+(add|delete)\b|\bnetsh\b|\bsc(\.exe)?\s+(start|stop|config|create)\b|\bschtasks\b|\bshutdown\b|Set-ItemProperty/i, flag: 'system configuration' },
  { pattern: SENSITIVE_READ, flag: 'reads sensitive data' },
];

export type PolicyVerdict = { decision: 'allow' } | { decision: 'ask'; flags: string[] };

export function evaluatePermission(toolName: string, command: string, mode: PermissionMode): PolicyVerdict {
  // Reading files is silent in every mode — strict gates actions, not every
  // read a worker needs to think — EXCEPT credential-like paths, which always ask.
  if (toolName === 'Read') {
    return SENSITIVE_READ.test(command)
      ? { decision: 'ask', flags: ['reads sensitive data'] }
      : { decision: 'allow' };
  }
  // Reading the public web is routine (research, docs, references) — allowed
  // in auto mode for every team; Bash that SENDS data still escalates above.
  if (toolName === 'WebFetch' && mode === 'auto') return { decision: 'allow' };

  if (mode === 'strict') return { decision: 'ask', flags: [] };
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') return { decision: 'allow' };
  if (toolName === 'Bash') {
    const flags = [...new Set(BASH_ESCALATIONS.filter((rule) => rule.pattern.test(command)).map((rule) => rule.flag))];
    return flags.length > 0 ? { decision: 'ask', flags } : { decision: 'allow' };
  }
  return { decision: 'ask', flags: [] }; // unknown gated tool — be safe
}
