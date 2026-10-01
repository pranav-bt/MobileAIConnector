import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { PermissionMode } from '../config.js';
import { containsPath, realPath, writableBy, type LockedDir } from './util.js';

// Permission policy. auto (default): routine work runs silently — edits,
// builds, tests, git commits, and READING (files and the public web) — and
// only the consequential escalates to a card on the desktop/phone: installs,
// publishing/pushing, destructive commands, writing outside the worker's own
// project, sending data out, remote access, system config, and reading
// credential-like files. strict: every gated ACTION asks (reads stay silent
// unless they touch sensitive data).

interface Escalation {
  pattern: RegExp;
  flag: string;
}

// Paths that look like credentials/secrets: reading them always asks, in
// every mode, whichever tool does the reading.
const SENSITIVE_READ =
  /(\.ssh[\\/]|\.aws[\\/]|\.gnupg|\.credentials|credentials\.json|secrets\.json|(?<![\w.])\.env\b|id_rsa|id_ed25519|\.pem\b|\.kdbx|\.netrc|\.git-credentials|User Data[\\/].+(Cookies|Login Data))/i;

// git takes its GLOBAL options before the subcommand, so a gate that looks
// for "git push" literally is walked straight past by `git -C ../other push`
// and `git --git-dir=… --work-tree=… push`. Match the option run instead.
const GIT_GLOBAL_OPT = String.raw`(?:-[cC]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path)(?:=\S+|\s+\S+)|--[\w-]+|-[a-zA-Z])`;
const gitDoes = (subcommand: string): RegExp =>
  new RegExp(String.raw`\bgit\s+(?:${GIT_GLOBAL_OPT}\s+)*${subcommand}\b`, 'i');

const BASH_ESCALATIONS: Escalation[] = [
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall|update|upgrade|dlx|exec)\b/i, flag: 'installs packages' },
  { pattern: /\b(pip3?|pipx|uv|cargo|gem|composer|go)\s+(install|add|get)\b/i, flag: 'installs packages' },
  { pattern: /\b(winget|choco|scoop|apt(-get)?|brew|dnf|pacman)\b/i, flag: 'system package manager' },
  { pattern: gitDoes('push'), flag: 'publishes / pushes' },
  { pattern: /\bnpm\s+publish\b|\bgh\s+(pr\s+create|release|repo\s+(create|delete))\b/i, flag: 'publishes / pushes' },
  { pattern: /\brm\s+-\w*[rf]|\bRemove-Item\b|\brmdir\b|\bdel\s+\/|Format-|mkfs/i, flag: 'destructive' },
  { pattern: gitDoes(String.raw`reset\s+--hard`), flag: 'destructive' },
  { pattern: gitDoes(String.raw`clean\s+-\w*f\w*`), flag: 'destructive' },
  { pattern: gitDoes(String.raw`push\s+--force`), flag: 'destructive' },
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

// --- shell writes outside the worker's own project -------------------------
// Write/Edit are refused outright when they leave the workspace, but the
// shell is not confined by the SDK's directory grants: `cp`, `mv`,
// `echo > …`, `sed -i` and `Set-Content` reached straight into sibling
// projects with no card at all. Reads through the shell stay silent (workers
// are told to sweep the drives with it); what escalates is a WRITE whose
// target resolves outside the project.

// Commands whose job is to put bytes somewhere.
const SHELL_WRITE_VERBS =
  /(?:^|[\s;|&(`])(?:cp|copy|xcopy|robocopy|mv|move|ren|rename|rm|rmdir|del|erase|mkdir|md|touch|tee|ln|rsync|dd|truncate|unzip|tar|7z|Copy-Item|Move-Item|Remove-Item|Rename-Item|New-Item|Set-Content|Add-Content|Clear-Content|Out-File|Export-Csv|Export-Clixml)\b/i;
// …and the ones that carry their destination as a flag or an in-place switch.
const SHELL_WRITE_FLAGS =
  /\b(?:sed|perl|ruby|gawk|awk)\b[^;|&]*\s-i\b|\b(?:curl|Invoke-WebRequest|iwr)\b[^;|&]*\s(?:-o|-O|--output|-OutFile)\b|\bwget\b[^;|&]*\s(?:-O|-P|--output-document|--directory-prefix)\b|\bgit\s+clone\b|\bgit\s+(?:init|worktree\s+add)\b/i;
// Output redirection. `2>&1`, `>&2`, `>$null`, `>/dev/null` and `>NUL`
// discard rather than write, so they are not targets.
const SHELL_REDIRECT = />>?\s*(?!&|\$null\b|\/dev\/null\b|NUL\b)/i;

// git's global options name the repo a command acts on, so `git -C <path>`
// and `git --git-dir=<path>` are how a worker reaches another project's repo
// without a single out-of-project token anywhere else in the line.
// Case-sensitive on purpose: `-c` sets a config value, `-C` changes directory.
const GIT_REPO_ARG = /(?:^|\s)(?:-C\s+|--git-dir[=\s]+|--work-tree[=\s]+)("[^"]*"|'[^']*'|[^\s;|&]+)/g;
// Quoted runs first so a path with spaces stays one token; `<`/`>` end a bare
// token so `>out.txt` yields `out.txt`.
const SHELL_TOKEN = /"([^"]*)"|'([^']*)'|([^\s;|&<>()]+)/g;

const unquote = (token: string): string => token.replace(/^["']|["']$/g, '');

// A shell token as a filesystem path, or null when it plainly cannot leave
// the project. Relative names without a `..` resolve inside the workspace by
// construction, so only absolute forms, `~` and upward-relative paths are
// worth resolving — everything else is a flag, a URL or an argument.
function asPath(token: string): string | null {
  const raw = unquote(token.replace(/^[<>]+/, '')).trim();
  if (!raw || raw.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;
  if (/^~($|[\\/])/.test(raw)) return join(homedir(), raw.slice(1));
  // A single short all-letter segment after a slash is a Windows switch
  // (`cmd /c`, `xcopy /E`, `robocopy /MIR`), not a path. The POSIX roots this
  // also skips (/tmp, /etc, /usr) are system dirs, never a sibling project —
  // anything under them (/tmp/x) has a second segment and is still checked.
  if (/^\/[A-Za-z?]{1,6}$/.test(raw)) return null;
  // Git Bash / MSYS drive form: /d/PersonalWork/… is D:\PersonalWork\…
  const msys = /^\/([A-Za-z])(\/.*)$/.exec(raw);
  if (msys) return `${msys[1]!.toUpperCase()}:${msys[2]!.replace(/\//g, sep)}`;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw; // C:\… or C:/…
  if (/^(\\\\|\/\/)[^\\/]/.test(raw)) return raw; // UNC share
  if (raw.startsWith('/') || raw.startsWith('\\')) return raw; // POSIX / drive-relative absolute
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) return raw; // climbs out of the cwd
  return null;
}

export interface WorkspaceScope {
  /** The task's project workspace — the worker's cwd. */
  cwd: string;
  /** Everything else it may touch (the hub's phone inbox/outbox). */
  extraDirs: string[];
  /** Agent HQ's own data dir — off limits apart from its open folders. */
  locked?: LockedDir;
}

// The first path a shell command would write to that is out of the
// project (or into Agent HQ's own data), or null.
export function strayShellTarget(command: string, scope: WorkspaceScope): string | null {
  const roots = [scope.cwd, ...scope.extraDirs].filter(Boolean);
  if (roots.length === 0) return null;
  const outside = (candidate: string): string | null => {
    const full = realPath(resolve(scope.cwd, candidate));
    return writableBy(full, roots, scope.locked) ? null : full;
  };

  // A git command pointed at another repo writes there whatever it does.
  if (/\bgit\b/i.test(command)) {
    for (const match of command.matchAll(GIT_REPO_ARG)) {
      const path = asPath(match[1] ?? '') ?? unquote(match[1] ?? '');
      const stray = path ? outside(path) : null;
      if (stray) return stray;
    }
  }

  const writes = SHELL_WRITE_VERBS.test(command) || SHELL_WRITE_FLAGS.test(command) || SHELL_REDIRECT.test(command);
  if (!writes) return null;
  for (const match of command.matchAll(SHELL_TOKEN)) {
    const path = asPath(match[1] ?? match[2] ?? match[3] ?? '');
    const stray = path ? outside(path) : null;
    if (stray) return stray;
  }
  return null;
}

export type PolicyVerdict = { decision: 'allow' } | { decision: 'ask'; flags: string[] };

export function evaluatePermission(
  toolName: string,
  command: string,
  mode: PermissionMode,
  scope?: WorkspaceScope,
): PolicyVerdict {
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
    const stray = scope ? strayShellTarget(command, scope) : null;
    if (stray) {
      const config = scope?.locked && writableBy(stray, [scope.cwd, ...scope.extraDirs]);
      flags.push(config ? `writes Agent HQ's own data (${stray})` : `writes outside this project (${stray})`);
    }
    return flags.length > 0 ? { decision: 'ask', flags } : { decision: 'allow' };
  }
  return { decision: 'ask', flags: [] }; // unknown gated tool — be safe
}
