import { join } from 'node:path';
import type { ModelSpec, Team } from '@agent-hq/shared';
import type { OrchestratorEngine, WorkerInbox, WorkerRunCallbacks, WorkerRunResult } from './types.js';
import type { LockedDir } from '../orchestrator/util.js';

// Deterministic engine for tests and offline development: routes by team-id
// keyword, "installs" trigger a permission request, everything resolves fast.
export class MockEngine implements OrchestratorEngine {
  async complete(args: { prompt: string; model: ModelSpec }): Promise<{ text: string; tokens: number }> {
    // A pair task's chair: a question ("…?") is answered, anything else is
    // handed to the author as work.
    if (args.prompt.includes('You chair a pair task')) {
      const said = args.prompt.match(/The owner now says: "([\s\S]*?)"\n/)?.[1] ?? '';
      const reply = said.trim().endsWith('?')
        ? { action: 'answer', reply: `Mock chair: both models looked at it — answering "${said.slice(0, 60)}".` }
        : { action: 'work', instruction: `Mock chair relays: ${said}` };
      return { text: JSON.stringify(reply), tokens: 4 };
    }
    // Stuck-task recovery: "split-me" in the task proposes a 2-step split,
    // anything else a handover to the design team; "MOCK-AUTO" in the
    // owner's master rules lets the master act without asking.
    if (args.prompt.includes('{"action"')) {
      const auto = args.prompt.includes('MOCK-AUTO');
      const plan = args.prompt.includes('split-me')
        ? {
            action: 'split',
            steps: [
              { teamId: 'design', title: 'Spec the piece', instruction: 'Mock: write the spec.' },
              { teamId: 'coding', title: 'Build the piece', instruction: 'Mock: build it from the spec.' },
            ],
            why: 'Mock: smaller steps get past the blocker.',
            auto,
          }
        : { action: 'handover', teamId: 'design', instruction: 'Mock: take this over.', why: 'Mock: design has what it needs.', auto };
      return { text: JSON.stringify(plan), tokens: 6 };
    }
    // Rule-conflict check: a team rule tagged MOCK-CONFLICT contradicts the
    // project's CLAUDE.md on indentation, until the owner has resolved it.
    if (args.prompt.includes('{"conflicts"')) {
      const [, resolved = ''] = args.prompt.split('ALREADY RESOLVED');
      const conflicts =
        args.prompt.includes('MOCK-CONFLICT') && !resolved.toLowerCase().includes('indentation')
          ? [{ topic: 'indentation', teamRule: 'Always indent with tabs', projectRule: 'Indent with 2 spaces' }]
          : [];
      return { text: JSON.stringify({ conflicts }), tokens: 5 };
    }
    if (args.prompt.includes('{"explanation"')) {
      return {
        text: JSON.stringify({ explanation: 'Mock explanation: the worker wants to install a software package for its task.' }),
        tokens: 5,
      };
    }
    // Lead split-pass prompts expect {"split": ...}; "parallel-test" in the
    // task exercises the scaffold -> parallel parts -> integration path,
    // "parallel-overlap" a plan whose parts share files (must be rejected),
    // "parallel-wide" a 3-way split with no scaffold.
    if (args.prompt.includes('"split"')) {
      const taskLine = args.prompt.match(/^Task: (.*)$/m)?.[1] ?? '';
      const overlap = taskLine.includes('parallel-overlap');
      if (taskLine.includes('parallel-wide')) {
        return {
          text: JSON.stringify({
            split: true,
            contract: 'src/a, src/b, src/c each export start().',
            scaffold: '',
            parts: ['a', 'b', 'c'].map((name) => ({ title: `Module ${name}`, instruction: `build module ${name}`, owns: [`src/${name}`] })),
          }),
          tokens: 11,
        };
      }
      if (!taskLine.includes('parallel-test') && !overlap) return { text: JSON.stringify({ split: false }), tokens: 5 };
      return {
        text: JSON.stringify({
          split: true,
          contract: 'src/a and src/b export start(); src/index calls both.',
          scaffold: overlap ? '' : 'create src/index with the folder layout',
          parts: [
            { title: 'Module A', instruction: 'build module A', owns: ['src/a/'] },
            { title: 'Module B', instruction: 'build module B', owns: overlap ? ['src/a/b.ts'] : ['src/b'] },
          ],
        }),
        tokens: 11,
      };
    }
    // Coordination prompts expect {"dispatch": [...]} — checked before the
    // routing branch because their format line also mentions "teamId".
    if (args.prompt.includes('"dispatch"')) {
      if (args.prompt.includes('handoff-test')) {
        return {
          text: JSON.stringify({
            dispatch: [
              {
                teamId: 'design',
                title: 'Produce the icon set',
                instruction: 'Produce the icon set the coding team still needs.',
              },
            ],
          }),
          tokens: 7,
        };
      }
      return { text: JSON.stringify({ dispatch: [] }), tokens: 7 };
    }
    if (args.prompt.includes('"teamId"')) {
      const teamIds = [...args.prompt.matchAll(/^- id: ([a-z0-9-]+)/gm)].map((match) => match[1] ?? '');
      const projectIds = [...args.prompt.matchAll(/^\* project: ([a-z0-9-]+)/gm)].map((match) => match[1] ?? '');
      const taskMatch = args.prompt.match(/Task: "([\s\S]*?)"\n/);
      const text = (taskMatch?.[1] ?? '').toLowerCase();
      const projectId = projectIds.find((id) => id && text.includes(id)) ?? projectIds[0] ?? '';
      // "multi-step" exercises the sequenced multi-team plan path.
      if (text.includes('multi-step')) {
        return {
          text: JSON.stringify({
            projectId,
            project: 'thread',
            title: 'Multi-step feature',
            reason: 'mock plan',
            plan: [
              { teamId: 'design', title: 'Design pass', instruction: 'design the feature' },
              { teamId: 'coding', title: 'Build pass', instruction: 'implement the design' },
            ],
          }),
          tokens: 15,
        };
      }
      const teamId = teamIds.find((id) => id && text.includes(id)) ?? teamIds[0] ?? 'coding';
      // Unnamed asks: "unsure-test" doesn't fit the thread (suggesting any
      // listed project id or folder named in the ask), "general-test" is
      // about no project; everything else continues the thread.
      const folders = [...args.prompt.matchAll(/^\* folder: ([^|]+?) \|/gm)].map((match) => match[1] ?? '');
      const project = text.includes('unsure-test') ? 'unsure' : text.includes('general-test') ? 'general' : 'thread';
      // (the first listed project is the thread's; the rest are suggestions)
      const words = new Set(text.split(/[^a-z0-9-]+/));
      const mentioned = [...projectIds, ...folders].filter((ref) => ref && words.has(ref.toLowerCase()));
      const noThread = args.prompt.includes('The owner has no current thread yet.');
      const suggest = mentioned.length > 0 ? mentioned : projectIds.slice(noThread ? 0 : 1, 4);
      return {
        text: JSON.stringify({
          teamId,
          projectId,
          project,
          suggest,
          title: (taskMatch?.[1] ?? 'task').slice(0, 60),
          reason: 'mock routing by keyword',
        }),
        tokens: 12,
      };
    }
    // QA-verdict prompts expect JSON {verdict, summary}. "remediate-me" in
    // the QA report marks it as a real failure.
    if (args.prompt.includes('"verdict"')) {
      const failed = args.prompt.includes('remediate-me') || args.prompt.includes('ISSUES');
      return {
        text: JSON.stringify(
          failed
            ? { verdict: 'issues', summary: 'Mock QA issues: the remediate-me bug is real, fix it.' }
            : { verdict: 'pass', summary: '' },
        ),
        tokens: 6,
      };
    }
    // Lead-review prompts expect JSON {synopsis, memoryNote}.
    if (args.prompt.includes('"synopsis"')) {
      const memoryNote = args.prompt.toLowerCase().includes('remember') ? 'Mock lesson: remember this.' : null;
      // Carry the remediation marker through the review so a [QA] task's
      // synopsis can trip the verdict step — but only on its first QA round
      // ([fix] work reviews clean, ending the loop). "handoff-test" reviews
      // into a report that explicitly hands work to the design team.
      const synopsis =
        args.prompt.includes('remediate-me') && args.prompt.includes('[QA]') && !args.prompt.includes('[fix')
          ? 'ISSUES: QA found the remediate-me bug in the feature.'
          : args.prompt.includes('qa-stuck-test') && args.prompt.includes('[QA]')
            ? 'ISSUES: the qa-stuck-test bug is still there.'
            : args.prompt.includes('handoff-test') && !args.prompt.includes('[QA]')
              ? 'Done, but the icon set still needs the design team (handoff-test).'
              : args.prompt.includes('Second opinion:')
                ? 'Mock lead review: work checked, looks complete (with the second opinion).'
                : 'Mock lead review: work checked, looks complete.';
      // A worker report that says it could not finish reviews as stuck.
      const stuck = args.prompt.includes('Could not finish') ? 'the worker has no Roblox Studio connection' : null;
      return {
        text: JSON.stringify({ synopsis, memoryNote, stuck }),
        tokens: 9,
      };
    }
    return { text: 'Mock lead review: work checked, looks complete.', tokens: 9 };
  }

  // Conversations by session id — what each was told, so a resumed one can
  // "remember" (console follow-ups are tested against this).
  #sessions = new Map<string, string[]>();
  #sessionCounter = 0;

  async runWorker(args: {
    prompt: string;
    team: Team;
    model: ModelSpec;
    cwd: string;
    extraDirs?: string[];
    locked?: LockedDir;
    maxSubagents?: number;
    callbacks: WorkerRunCallbacks;
    signal?: AbortSignal;
    title?: string;
    resumeSessionId?: string;
    inbox?: WorkerInbox;
    readOnly?: boolean;
  }): Promise<WorkerRunResult> {
    const { callbacks } = args;
    const sessionId =
      args.resumeSessionId && this.#sessions.has(args.resumeSessionId) ? args.resumeSessionId : `mock-session-${++this.#sessionCounter}`;
    const memory = this.#sessions.get(sessionId) ?? [];
    this.#sessions.set(sessionId, memory);
    callbacks.onSession?.(sessionId);
    if (args.resumeSessionId) callbacks.onActivity(`mock: resumed ${sessionId}`);
    const taskText = (args.prompt.split('\n---\n')[0] ?? args.prompt).toLowerCase();
    const firstLine = (args.prompt.split('\n')[0] ?? '').slice(0, 200);
    // A pair-mode reviewer: answers with a verdict. "pair-never-agree" never
    // agrees, "pair-disagree-once" agrees from its second review on,
    // "pair-garbled" never gives a readable verdict. The mode is remembered
    // by the reviewer's conversation (later rounds don't repeat the task).
    if (args.readOnly) {
      callbacks.onActivity(`mock: read-only review · engine ${args.model.engine}${args.resumeSessionId ? ' · resumed' : ''}`);
      const reviewsBefore = memory.filter((line) => line === 'REVIEW').length;
      memory.push('REVIEW');
      const lower = args.prompt.toLowerCase();
      const known = memory.find((line) => line.startsWith('MODE:'))?.slice(5);
      const mode =
        known ??
        (lower.includes('pair-never-agree') ? 'never' : lower.includes('pair-disagree-once') ? 'once' : lower.includes('pair-garbled') ? 'garbled' : 'agree');
      if (!known) memory.push(`MODE:${mode}`);
      const agree = mode === 'agree' || (mode === 'once' && reviewsBefore >= 1);
      const verdict = {
        agree,
        blocking: agree ? [] : ['the loader has no tests yet'],
        minor: ['a name or two could be clearer'],
        summary: agree ? 'Checked the actual change — it does what was asked.' : 'Not yet: the change has no tests.',
      };
      const text = mode === 'garbled' ? 'I looked it over and it seems mostly fine.' : `Looked at the diff. ${JSON.stringify(verdict)}`;
      callbacks.onTranscript?.({ id: `mock-review-${sessionId}-${reviewsBefore}`, kind: 'message', text });
      return { synopsis: text, tokens: 15, sessionId, filesChanged: false };
    }
    const rowId = `mock-${sessionId}-${memory.length}`;
    callbacks.onTranscript?.({ id: `${rowId}-hello`, kind: 'message', text: `Mock worker on it: ${firstLine}` });
    callbacks.onTranscript?.({ id: `${rowId}-tool`, kind: 'tool', tool: 'Bash', text: 'echo mock', state: 'running' });
    // "console-slow" stays busy until the owner sends a message (≤4 s).
    const heard: string[] = [];
    if (taskText.includes('console-slow') && args.inbox) {
      const next = await Promise.race([args.inbox.next(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))]);
      if (next) heard.push(next);
    }
    // "recall-test" answers from what this conversation was told before.
    const recall = taskText.includes('recall-test') ? memory.join(' | ') : '';
    memory.push(firstLine);
    const result = await this.#work(args);
    callbacks.onTranscript?.({ id: `${rowId}-tool`, kind: 'tool', tool: 'Bash', text: 'echo mock', state: 'ok', detail: 'mock' });
    const synopsis = [result.synopsis, heard.length ? `heard: ${heard.join(' / ')}` : '', recall ? `remembered: ${recall}` : '']
      .filter(Boolean)
      .join(' · ');
    callbacks.onTranscript?.({ id: `${rowId}-done`, kind: 'message', text: synopsis });
    return { ...result, synopsis, sessionId, filesChanged: /edit-test|writes-files|install/.test(taskText) };
  }

  async #work(args: {
    prompt: string;
    team: Team;
    model: ModelSpec;
    cwd: string;
    extraDirs?: string[];
    locked?: LockedDir;
    maxSubagents?: number;
    callbacks: WorkerRunCallbacks;
    signal?: AbortSignal;
  }): Promise<WorkerRunResult> {
    const { callbacks, signal } = args;
    // Keyword triggers must fire on the task itself, not on the appended
    // background-context section (project history can mention "install").
    const taskText = (args.prompt.split('\n---\n')[0] ?? args.prompt).toLowerCase();
    callbacks.onActivity(`mock: model ${args.model.id} · effort ${args.model.effort ?? 'default'}`);
    callbacks.onActivity(`mock: engine ${args.model.engine}`);
    // Makes the worker's file scope observable, so the smoke can prove a
    // worker is handed its own project workspace and nothing else.
    callbacks.onActivity(`mock: workspace ${args.cwd} · extra [${(args.extraDirs ?? []).join('|')}]`);
    // Makes the team-rules layer observable: rule count and decided conflicts.
    const bullets = (block: string | undefined): number =>
      (block?.split('\n\n')[0] ?? '').split('\n').filter((line) => line.startsWith('- ')).length;
    const rulesBlock = args.prompt.split('Team rules from the owner')[1];
    if (rulesBlock !== undefined) {
      const decided = bullets(args.prompt.split('Conflicts the owner already decided')[1]);
      callbacks.onActivity(`mock: team rules ${bullets(rulesBlock)} · decided ${decided}`);
    }
    const toolsBlock = args.prompt.split('Tools your team has')[1];
    if (toolsBlock !== undefined) callbacks.onActivity(`mock: team tools ${bullets(toolsBlock)}`);
    callbacks.onActivity(`mock: mcp [${Object.keys(args.team.mcpServers ?? {}).join('|')}]`);
    // A first attempt at "crash-test" fails outright; "blocked-test" reports
    // it could not finish. Work a recovery spawned carries the stuck context
    // and goes through, so the recovered task completes.
    const recovered = taskText.includes('this continues a stuck task');
    if (taskText.includes('crash-test') && !recovered) throw new Error('mock crash: the build tool is missing');
    // "denystuck-test": asks to install something, and if the owner says no,
    // reports it could not finish (stuck by the owner's own decision).
    if (taskText.includes('denystuck-test')) {
      const decision = await callbacks.onPermission({ toolName: 'Bash', command: 'npm install denystuck-pkg', reason: 'needs the package' });
      if (decision === 'deny') return { synopsis: 'Could not finish: the install was denied.', tokens: 20 };
    }
    // "rerun-stuck" stays blocked even after a recovery (no second pass).
    if (taskText.includes('blocked-test') && (!recovered || taskText.includes('rerun-stuck'))) {
      return { synopsis: 'Could not finish: blocked-test needs a Roblox Studio connection this team lacks.', tokens: 30 };
    }
    if (args.maxSubagents !== undefined) callbacks.onActivity(`mock: subagents capped at ${args.maxSubagents}`);
    callbacks.onActivity('mock: examining the task');
    // "edit-test" exercises the Edit permission path (auto-allowed by policy).
    if (taskText.includes('edit-test')) {
      const decision = await callbacks.onPermission({
        toolName: 'Edit',
        command: 'Edit mock-file.ts',
        reason: 'mock worker wants to edit a file',
      });
      callbacks.onActivity(decision === 'approve' ? 'mock: file edited' : 'mock: edit denied');
    }
    // "webfetch-test" exercises the read-the-web path (auto-allowed for all).
    if (taskText.includes('webfetch-test')) {
      const decision = await callbacks.onPermission({
        toolName: 'WebFetch',
        command: 'WebFetch https://example.com/reference',
        reason: 'mock research fetch',
      });
      callbacks.onActivity(decision === 'approve' ? 'mock: page read' : 'mock: fetch denied');
    }
    // "sensitive-test" exercises the credentials-read gate.
    if (taskText.includes('sensitive-test')) {
      const decision = await callbacks.onPermission({
        toolName: 'Read',
        command: 'Read C:\\Users\\prana\\.ssh\\id_rsa',
        reason: 'mock sensitive read',
      });
      callbacks.onActivity(decision === 'approve' ? 'mock: secret read' : 'mock: sensitive read denied');
    }
    // "shellwrite-test" exercises the shell path gate: a copy into a SIBLING
    // project, which the file tools refuse outright but the shell can reach.
    if (taskText.includes('shellwrite-test')) {
      const decision = await callbacks.onPermission({
        toolName: 'Bash',
        command: `cp Art.luau ${join(args.cwd, '..', 'SomeOtherProject')}/Art.luau`,
        reason: 'mock worker wants to copy a file next door',
      });
      callbacks.onActivity(decision === 'approve' ? 'mock: copied next door' : 'mock: cross-project copy denied');
    }
    // …while the same shape of command inside the project stays silent.
    if (taskText.includes('shellinside-test')) {
      const decision = await callbacks.onPermission({
        toolName: 'Bash',
        command: `cp Art.luau ${join(args.cwd, 'build')}/Art.luau`,
        reason: 'mock worker wants to copy a file in its own project',
      });
      callbacks.onActivity(decision === 'approve' ? 'mock: copied in place' : 'mock: in-project copy denied');
    }
    if (taskText.includes('install')) {
      const decision = await callbacks.onPermission({
        toolName: 'Bash',
        command: 'npm install mock-package',
        reason: 'mock worker wants to install a package',
      });
      if (signal?.aborted) throw new Error('aborted');
      callbacks.onActivity(decision === 'approve' ? 'mock: package installed' : 'mock: denied — working around it');
    }
    // "slow-test" keeps the worker busy long enough for queues to build up.
    if (taskText.includes('slow-test')) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (signal?.aborted) throw new Error('aborted');
    callbacks.onTokens(42);
    // "report-test" produces a long text deliverable (exercises the
    // full-report delivery path for no-bash teams).
    if (taskText.includes('report-test')) {
      return {
        synopsis:
          'Mock findings: ' +
          'the papaya market is growing steadily and the best export cultivar is Red Lady. '.repeat(6),
        tokens: 42,
      };
    }
    return { synopsis: 'Mock worker: completed the task as described.', tokens: 42 };
  }
}
