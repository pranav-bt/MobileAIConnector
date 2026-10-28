import { execFile } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Project, Worktree } from '@agent-hq/shared';
import { containsPath } from './util.js';

// The bots' worktree of a git project: a second checkout on its own branch
// (agent-hq/<base>), cut from the owner's current branch. Workers run there,
// so nothing they do — deleting, resetting, installing — touches the owner's
// folder or branch. The hub commits the worktree after every run and right
// before anything destructive the policy lets through, so all of it reverts.
// In the morning the owner merges it (the owner's latest goes into the
// worktree first, then their branch fast-forwards; the worktree and branch
// are removed) or discards it.

const SMALL_FILE = 1024 * 1024; // ignored files copied into a new worktree: each ≤ 1 MB…
const COPY_BUDGET = 50 * 1024 * 1024; // …and ≤ 50 MB in all
// Ignored folders a build can't do without and nothing else restores
// (Wally packages); node_modules comes back through `npm ci` instead.
const COPIED_FOLDERS = /^(Packages|ServerPackages|DevPackages)$/;

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<GitResult> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => done({ ok: !error, stdout: String(stdout), stderr: String(stderr || (error ? error.message : '')) }),
    );
  });
}

function run(cwd: string, command: string, args: string[], timeoutMs: number): Promise<GitResult> {
  return new Promise((done) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' }, (error, stdout, stderr) =>
      done({ ok: !error, stdout: String(stdout), stderr: String(stderr || (error ? error.message : '')) }),
    );
  });
}

const firstLine = (text: string) => text.trim().split('\n').find((line) => line.trim())?.trim().slice(0, 300) ?? '';

export interface WorktreeHost {
  // Where worktrees are created (one folder per project).
  root(): string;
  get(projectId: string): Worktree | null;
  // Persist + publish the project's record (null = no worktree).
  save(projectId: string, worktree: Worktree | null): void;
  // Never copied into a worktree (Agent HQ's own data: keys, secrets).
  lockedDir: string;
  log(projectId: string, message: string): void;
}

export type MergeOutcome = { ok: true; message: string } | { ok: false; message: string };

export class WorktreeManager {
  #host: WorktreeHost;
  #chains = new Map<string, Promise<unknown>>();

  constructor(host: WorktreeHost) {
    this.#host = host;
  }

  // One git operation at a time per project (commits, merges and refreshes
  // share the repo's index and refs).
  #serial<T>(projectId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(job, job);
    this.#chains.set(projectId, next.catch(() => undefined));
    return next;
  }

  // The repo the project's folder belongs to, and the project's path inside it.
  async #repo(project: Project): Promise<{ top: string; prefix: string } | null> {
    if (!project.workspaceDir || !existsSync(project.workspaceDir)) return null;
    const top = await git(project.workspaceDir, ['rev-parse', '--show-toplevel']);
    if (!top.ok || !top.stdout.trim()) return null;
    const root = resolve(top.stdout.trim());
    const prefix = relative(root, resolve(project.workspaceDir));
    if (prefix.startsWith('..')) return null;
    return { top: root, prefix };
  }

  // The folder a worker runs in: the project's worktree (made on first
  // need), or null when the project isn't a git repo / the worktree can't be
  // made (the worker then runs in the project folder under the normal rules).
  async ensure(project: Project): Promise<string | null> {
    return this.#serial(project.id, async () => {
      const repo = await this.#repo(project);
      if (!repo) return null;
      const existing = this.#host.get(project.id);
      if (existing && existsSync(existing.root)) {
        const head = await git(existing.root, ['symbolic-ref', '--short', 'HEAD']);
        if (head.ok && head.stdout.trim() === existing.branch) return existing.dir;
        this.#host.log(project.id, `the bots' worktree (${existing.root}) is no longer on ${existing.branch} — working in your project folder until it's merged or discarded`);
        return null;
      }
      if (existing) await git(repo.top, ['worktree', 'prune']); // its folder is gone
      const head = await git(repo.top, ['symbolic-ref', '--short', 'HEAD']);
      if (!head.ok) {
        this.#host.log(project.id, `${project.name} is on a detached HEAD — the bots work in the project folder itself until it's on a branch`);
        return null;
      }
      const base = head.stdout.trim();
      if (base.startsWith('agent-hq/')) {
        this.#host.log(project.id, `${project.name} has the bots' branch ${base} checked out — the bots work in the project folder itself`);
        return null;
      }
      const branch = `agent-hq/${base}`;
      let root = join(this.#host.root(), project.id);
      for (let n = 2; existsSync(root) && readdirSync(root).length > 0; n++) root = join(this.#host.root(), `${project.id}-${n}`);
      mkdirSync(dirname(root), { recursive: true });
      const branchExists = (await git(repo.top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
      const added = await git(repo.top, branchExists ? ['worktree', 'add', root, branch] : ['worktree', 'add', '-b', branch, root, base]);
      if (!added.ok) {
        this.#host.log(project.id, `couldn't make the bots' worktree — ${firstLine(added.stderr)}; working in the project folder`);
        return null;
      }
      const dir = repo.prefix ? join(root, repo.prefix) : root;
      const at = Date.now();
      this.#host.save(project.id, { root, dir, branch, base, ahead: 0, behind: 0, changedFiles: 0, dirty: false, commits: [], note: null, createdAt: at, updatedAt: at });
      const setup = await this.#setUp(repo.top, root);
      this.#host.log(project.id, `bots' worktree ready: ${root} on ${branch} (from your ${base})${setup ? ` — ${setup}` : ''}`);
      await this.#refresh(project.id);
      return dir;
    });
  }

  // What a fresh checkout lacks: the ignored files the project needs to run
  // (secrets.env, local settings — small ones), Wally packages, node_modules.
  async #setUp(top: string, root: string): Promise<string> {
    const done: string[] = [];
    const listed = await git(top, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
    let budget = COPY_BUDGET;
    let copied = 0;
    let needsNpm = false;
    for (const entry of listed.stdout.split('\0').filter(Boolean)) {
      const from = join(top, entry);
      if (containsPath(resolve(this.#host.lockedDir), resolve(from)) || /(^|\/)\.git(\/|$)|(^|\/)\.claude\/worktrees(\/|$)/.test(entry)) continue;
      const to = join(root, entry);
      try {
        if (entry.endsWith('/')) {
          const name = entry.replace(/\/$/, '').split('/').pop() ?? '';
          if (entry === 'node_modules/') needsNpm = true;
          else if (COPIED_FOLDERS.test(name)) {
            cpSync(from, to, { recursive: true });
            copied++;
          }
          continue;
        }
        const size = statSync(from).size;
        if (size > SMALL_FILE || size > budget) continue;
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        budget -= size;
        copied++;
      } catch {
        // unreadable / vanished: skipped
      }
    }
    if (copied) done.push(`copied ${copied} ignored file${copied === 1 ? '' : 's'}/folder${copied === 1 ? '' : 's'} (secrets, local settings, packages)`);
    if (needsNpm && existsSync(join(root, 'package-lock.json'))) {
      const npm = await run(root, 'npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], 15 * 60_000);
      done.push(npm.ok ? 'ran npm ci' : `npm ci failed (${firstLine(npm.stderr)}) — a worker can run it`);
    }
    return done.join(', ');
  }

  // Commit whatever the worktree holds now. Returns whether it committed.
  async checkpoint(projectId: string, label: string): Promise<boolean> {
    const worktree = this.#host.get(projectId);
    if (!worktree || !existsSync(worktree.root)) return false;
    return this.#serial(projectId, async () => {
      const committed = await this.#commit(worktree, label);
      await this.#refresh(projectId);
      return committed;
    });
  }

  async #commit(worktree: Worktree, label: string): Promise<boolean> {
    const status = await git(worktree.root, ['status', '--porcelain']);
    if (!status.ok || !status.stdout.trim()) return false;
    // The repo's own identity when it has one; Agent HQ's otherwise.
    const named = (await git(worktree.root, ['config', 'user.email'])).stdout.trim();
    const identity = named ? [] : ['-c', 'user.name=Agent HQ', '-c', 'user.email=agent-hq@localhost'];
    for (let attempt = 0; attempt < 4; attempt++) {
      const added = await git(worktree.root, ['add', '-A']);
      // The hub's own snapshot: the project's hooks (lint, tests) must not
      // stop it — the owner reviews the branch before it goes anywhere.
      const commit = added.ok
        ? await git(worktree.root, [...identity, 'commit', '-q', '--no-verify', '-m', `agent-hq: ${label.replace(/\s+/g, ' ').slice(0, 120)}`])
        : added;
      if (commit.ok) return true;
      if (!/index\.lock|unable to create|another git process/i.test(commit.stderr)) return false;
      await new Promise((wait) => setTimeout(wait, 400 * (attempt + 1)));
    }
    return false;
  }

  // Before a run starts (nobody else working there): the owner's newer
  // commits go into the worktree when they merge cleanly; a conflict leaves
  // it as it is, with a note.
  async catchUp(projectId: string): Promise<string | null> {
    const worktree = this.#host.get(projectId);
    if (!worktree || !existsSync(worktree.root)) return null;
    return this.#serial(projectId, async () => {
      const behind = await this.#behind(worktree);
      if (behind === 0) return null;
      await this.#commit(worktree, 'before taking in your latest');
      const merged = await this.#mergeBase(worktree);
      await this.#refresh(projectId, merged.ok ? null : merged.message);
      return merged.ok ? `took in your ${behind} newer commit${behind === 1 ? '' : 's'} on ${worktree.base}` : merged.message;
    });
  }

  async #behind(worktree: Worktree): Promise<number> {
    const counted = await git(worktree.root, ['rev-list', '--count', `${worktree.branch}..${worktree.base}`]);
    return counted.ok ? Number(counted.stdout.trim()) || 0 : 0;
  }

  async #mergeBase(worktree: Worktree): Promise<MergeOutcome> {
    const named = (await git(worktree.root, ['config', 'user.email'])).stdout.trim();
    const identity = named ? [] : ['-c', 'user.name=Agent HQ', '-c', 'user.email=agent-hq@localhost'];
    const merged = await git(worktree.root, [...identity, 'merge', '--no-edit', '--no-verify', worktree.base]);
    if (merged.ok) return { ok: true, message: '' };
    const conflicts = (await git(worktree.root, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean);
    await git(worktree.root, ['merge', '--abort']);
    return {
      ok: false,
      message: conflicts.length
        ? `your ${worktree.base} and the bots' work both changed ${conflicts.slice(0, 6).join(', ')}${conflicts.length > 6 ? ` and ${conflicts.length - 6} more` : ''} — not merged`
        : `couldn't take in ${worktree.base}: ${firstLine(merged.stderr)}`,
    };
  }

  // The owner's call: the bots' work goes onto their branch, then the
  // worktree and its branch are removed.
  async merge(project: Project): Promise<MergeOutcome> {
    const worktree = this.#host.get(project.id);
    if (!worktree) return { ok: false, message: 'no bots worktree to merge' };
    return this.#serial(project.id, async () => {
      const repo = await this.#repo(project);
      if (!repo) return { ok: false, message: `${project.workspaceDir} isn't a git repo any more` };
      if (existsSync(worktree.root)) {
        await this.#commit(worktree, 'final state before merging');
        const merged = await this.#mergeBase(worktree);
        if (!merged.ok) {
          await this.#refresh(project.id, merged.message);
          return { ok: false, message: `${merged.message}. Ask a team to merge ${worktree.base} into the worktree, or resolve it there yourself, then merge again.` };
        }
      }
      const tip = (await git(repo.top, ['rev-parse', worktree.branch])).stdout.trim();
      const baseTip = (await git(repo.top, ['rev-parse', worktree.base])).stdout.trim();
      if (!tip || !baseTip) return { ok: false, message: `couldn't read ${worktree.branch} / ${worktree.base}` };
      let moved = 0;
      if (tip !== baseTip) {
        moved = Number((await git(repo.top, ['rev-list', '--count', `${worktree.base}..${worktree.branch}`])).stdout.trim()) || 0;
        const current = (await git(repo.top, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim();
        if (current === worktree.base) {
          // The owner's folder is on that branch: a fast-forward updates it,
          // and git refuses if it would overwrite their uncommitted changes.
          const ff = await git(repo.top, ['merge', '--ff-only', worktree.branch]);
          if (!ff.ok) {
            const message = `couldn't fast-forward your ${worktree.base}: ${firstLine(ff.stderr)} — commit or stash your changes there, then merge again`;
            await this.#refresh(project.id, message);
            return { ok: false, message };
          }
        } else {
          const ancestor = await git(repo.top, ['merge-base', '--is-ancestor', worktree.base, worktree.branch]);
          if (!ancestor.ok) return { ok: false, message: `${worktree.base} moved on since — merge again` };
          const updated = await git(repo.top, ['update-ref', `refs/heads/${worktree.base}`, tip, baseTip]);
          if (!updated.ok) return { ok: false, message: `couldn't update ${worktree.base}: ${firstLine(updated.stderr)}` };
        }
      }
      const removed = await this.#remove(project.id, repo.top, worktree);
      const what = moved ? `merged ${moved} commit${moved === 1 ? '' : 's'} from the bots into your ${worktree.base}` : `nothing new from the bots — ${worktree.base} unchanged`;
      return { ok: true, message: `${what}; ${removed ? 'worktree removed' : `couldn't remove the worktree folder (${worktree.root}) — delete it by hand`}` };
    });
  }

  // Throw the bots' work away: worktree and branch.
  async discard(project: Project): Promise<MergeOutcome> {
    const worktree = this.#host.get(project.id);
    if (!worktree) return { ok: false, message: 'no bots worktree to discard' };
    return this.#serial(project.id, async () => {
      const repo = await this.#repo(project);
      if (!repo) {
        this.#host.save(project.id, null);
        return { ok: true, message: 'forgot the worktree (the project is no longer a git repo)' };
      }
      const removed = await this.#remove(project.id, repo.top, worktree);
      return { ok: true, message: `discarded the bots' work on ${worktree.branch}${removed ? '' : " (couldn't remove the folder — delete it by hand)"}` };
    });
  }

  async #remove(projectId: string, top: string, worktree: Worktree): Promise<boolean> {
    if (existsSync(worktree.root)) await git(top, ['worktree', 'remove', '--force', worktree.root]);
    await git(top, ['worktree', 'prune']);
    await git(top, ['branch', '-D', worktree.branch]);
    this.#host.save(projectId, null);
    return !existsSync(worktree.root);
  }

  // Refresh the counts the owner sees (ahead/behind, commits, files).
  async refresh(projectId: string): Promise<void> {
    await this.#serial(projectId, () => this.#refresh(projectId));
  }

  async #refresh(projectId: string, note?: string | null): Promise<void> {
    const worktree = this.#host.get(projectId);
    if (!worktree || !existsSync(worktree.root)) return;
    const range = `${worktree.base}..${worktree.branch}`;
    const [counts, log, files, status] = await Promise.all([
      git(worktree.root, ['rev-list', '--left-right', '--count', `${worktree.base}...${worktree.branch}`]),
      git(worktree.root, ['log', '--format=%h%x1f%s%x1f%ct', '-n', '20', range]),
      git(worktree.root, ['diff', '--name-only', `${worktree.base}...${worktree.branch}`]),
      git(worktree.root, ['status', '--porcelain']),
    ]);
    const [behind = 0, ahead = 0] = counts.stdout.trim().split(/\s+/).map((value) => Number(value) || 0);
    const commits = log.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', subject = '', at = '0'] = line.split('\x1f');
        return { sha, subject, at: Number(at) * 1000 };
      });
    this.#host.save(projectId, {
      ...worktree,
      ahead,
      behind,
      commits,
      changedFiles: files.stdout.split('\n').filter(Boolean).length,
      dirty: !!status.stdout.trim(),
      note: note === undefined ? worktree.note ?? null : note,
      updatedAt: Date.now(),
    });
  }
}
