import { join } from 'node:path';
import type { ModelSpec, Team } from '@agent-hq/shared';
import type { OrchestratorEngine, WorkerInbox, WorkerRunCallbacks, WorkerRunResult } from './types.js';
import type { LockedDir } from '../orchestrator/util.js';
import { isAppBridge } from '../apps.js';

// Deterministic engine for tests and offline development: routes by team-id
// keyword, "installs" trigger a permission request, everything resolves fast.
export class MockEngine implements OrchestratorEngine {
  async complete(args: { prompt: string; model: ModelSpec }): Promise<{ text: string; tokens: number }> {
    // The master's check on a message in a task's window: "<team>-request"
    // is new work for that team, "unclear-request" asks which team,
    // "classify-fail" makes the check fail; anything else is "same".
    if (args.prompt.includes('talking in the window of one task')) {
      const said = args.prompt.match(/The owner now says: "([\s\S]*?)"\n/)?.[1] ?? '';
      if (said.includes('classify-fail')) throw new Error('mock: the routing check failed');
      const teamIds = [...args.prompt.matchAll(/^- id: ([a-z0-9-]+)/gm)].map((match) => match[1] ?? '');
      if (said.includes('unclear-request')) return { text: JSON.stringify({ route: 'ask', teamIds: teamIds.slice(1, 3), why: 'mock: could be either' }), tokens: 3 };
      const wanted = said.match(/\b([a-z]+)-request\b/)?.[1];
      if (wanted && teamIds.includes(wanted)) {
        return { text: JSON.stringify({ route: 'team', teamId: wanted, title: `Mock: ${said.slice(0, 40)}`, instruction: `Do what the owner asked: ${said}`, why: `mock: it's ${wanted} work` }), tokens: 3 };
      }
      return { text: JSON.stringify({ route: 'same' }), tokens: 3 };
    }
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
    if (args.prompt.includes('{"split": false}')) {
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
      // With pairing rules in the prompt: "pairrule-<mode>" in the ask picks that mode.
      const pairRules = args.prompt.includes('rules for pair mode');
      const pair = pairRules ? (text.match(/pairrule-(review|split|debate)/)?.[1] ?? 'none') : undefined;
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
          ...(pair ? { pair } : {}),
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
        args.prompt.includes('remediate-me') && args.prompt.includes('[QA]') && !args.prompt.includes('[fix') && !args.prompt.includes('fixed-after-qa')
          ? 'ISSUES: QA found the remediate-me bug in the feature.'
          : args.prompt.includes('qa-stuck-test') && args.prompt.includes('[QA]')
            ? 'ISSUES: the qa-stuck-test bug is still there.'
            : args.prompt.includes('handoff-test') && !args.prompt.includes('[QA]')
              ? 'Done, but the icon set still needs the design team (handoff-test).'
              : args.prompt.includes('Second opinion:')
                ? 'Mock lead review: work checked, looks complete (with the second opinion).'
                : args.prompt.includes('Debate: ')
                  ? 'Mock lead review: work checked, looks complete (with the debate).'
                  : args.prompt.includes('fixed-after-qa')
                    ? 'Mock lead review: work checked, looks complete (fixed-after-qa).'
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

  // Makes app grants observable: which run the app bridge, and read-only ones.
  #appsLine(args: { team: Team; prompt: string; callbacks: WorkerRunCallbacks }): void {
    const bridges = Object.entries(args.team.mcpServers ?? {}).filter(([, config]) => isAppBridge(config));
    if (bridges.length === 0) return;
    args.callbacks.onActivity(
      `mock: apps [${bridges.map(([name, config]) => `${name}${(config as { args: string[] }).args.includes('--read-only') ? ' read-only' : ''}`).join('|')}]` +
        (args.prompt.includes('Desktop apps you can use') ? ' · told' : ''),
    );
  }

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
    // A debate: an independent draft ("debate-slow" takes ~1.5 s, so the
    // owner can steer mid-debate), then exchanges. Who yields: by engine —
    // "debate-codex-yields" (the default) / "debate-claude-yields"; "debate-
    // never" never converges. A draft repeats what the owner said.
    if (args.readOnly && args.prompt.includes('will each draft this independently')) {
      callbacks.onActivity(`mock: debate draft · engine ${args.model.engine}`);
      memory.push(`DEBATEMODE:${/debate-never/i.test(args.prompt) ? 'never' : /debate-claude-yields/i.test(args.prompt) ? 'claude' : 'codex'}`);
      if (/debate-slow/i.test(args.prompt)) await new Promise((resolve) => setTimeout(resolve, 1500));
      const text = `Mock draft (${args.model.engine}): first take on the task.`;
      callbacks.onTranscript?.({ id: `mock-draft-${sessionId}`, kind: 'message', text });
      return { synopsis: text, tokens: 10, sessionId, filesChanged: false };
    }
    if (args.readOnly && args.prompt.includes('Compare it with yours')) {
      callbacks.onActivity(`mock: debate exchange · engine ${args.model.engine}${args.resumeSessionId ? ' · resumed' : ''}`);
      const exchanges = memory.filter((line) => line === 'EXCHANGE').length;
      memory.push('EXCHANGE');
      const mode = memory.find((line) => line.startsWith('DEBATEMODE:'))?.slice(11) ?? 'codex';
      const heard = args.prompt.match(/The owner says \(both of you get this\): ([^\n]+)/)?.[1];
      const accept = mode !== 'never' && mode === args.model.engine;
      const text = JSON.stringify({
        accept,
        critique: accept ? [] : [`${args.model.engine} thinks the other draft misses the edge cases`],
        draft: `Mock draft (${args.model.engine}) revised ${exchanges + 1}x.${heard ? ` heard: ${heard}` : ''}`,
      });
      callbacks.onTranscript?.({ id: `mock-exchange-${sessionId}-${exchanges}`, kind: 'message', text });
      return { synopsis: text, tokens: 11, sessionId, filesChanged: false };
    }
    // A pair split's partner reviewing the plan: "plan-never-agree" never
    // agrees, "plan-disagree-once" agrees from its second look on.
    if (args.readOnly && /proposed this split plan|revised the plan:/.test(args.prompt)) {
      callbacks.onActivity(`mock: plan review · engine ${args.model.engine}${args.resumeSessionId ? ' · resumed' : ''}`);
      const looks = memory.filter((line) => line === 'PLANREVIEW').length;
      memory.push('PLANREVIEW');
      const lower = args.prompt.toLowerCase();
      const known = memory.find((line) => line.startsWith('PLANMODE:'))?.slice(9);
      const mode = known ?? (lower.includes('plan-never-agree') ? 'never' : lower.includes('plan-disagree-once') ? 'once' : 'agree');
      if (!known) memory.push(`PLANMODE:${mode}`);
      const agree = mode === 'agree' || (mode === 'once' && looks >= 1);
      const text = JSON.stringify({
        agree,
        blocking: agree ? [] : ['module B needs its own config file in its part'],
        minor: [],
        summary: agree ? 'The split is clean and the contract is enough.' : 'Not yet: module B is missing its config.',
      });
      callbacks.onTranscript?.({ id: `mock-planreview-${sessionId}-${looks}`, kind: 'message', text });
      return { synopsis: text, tokens: 12, sessionId, filesChanged: false };
    }
    // A pair split's planner: "pairsplit-solo" says it isn't worth splitting,
    // "pairsplit-invalid-once" first proposes overlapping parts; otherwise
    // module A for the author and module B for the partner.
    if (args.readOnly && args.prompt.includes('"builder": "you" | "partner"')) {
      callbacks.onActivity(`mock: plan draft · engine ${args.model.engine}${args.resumeSessionId ? ' · resumed' : ''}`);
      const drafts = memory.filter((line) => line === 'DRAFT').length;
      memory.push('DRAFT');
      const lower = args.prompt.toLowerCase();
      const known = memory.find((line) => line.startsWith('DRAFTMODE:'))?.slice(10);
      const mode = known ?? (lower.includes('pairsplit-solo') ? 'solo' : lower.includes('pairsplit-invalid-once') ? 'invalid' : 'plan');
      if (!known) memory.push(`DRAFTMODE:${mode}`);
      const plan =
        mode === 'solo'
          ? { split: false, why: 'mock: one small change, nothing to split' }
          : {
              split: true,
              contract: 'src/a and src/b each export start(); src/index calls both.',
              scaffold: lower.includes('pairsplit-scaffold') ? 'create src/index with the folder layout' : '',
              parts: [
                { title: 'Module A', instruction: 'build module A', owns: ['src/a'], builder: 'you' },
                { title: 'Module B', instruction: 'build module B', owns: mode === 'invalid' && drafts === 0 ? ['src/a/b'] : ['src/b'], builder: 'partner' },
              ],
            };
      const text = `Here is my plan.\n${JSON.stringify(plan)}`;
      callbacks.onTranscript?.({ id: `mock-plan-${sessionId}-${drafts}`, kind: 'message', text });
      return { synopsis: text, tokens: 14, sessionId, filesChanged: false };
    }
    if (args.readOnly) {
      callbacks.onActivity(`mock: read-only review · engine ${args.model.engine}${args.resumeSessionId ? ' · resumed' : ''}`);
      this.#appsLine(args);
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
    // A fix round on QA's findings says so — and a re-check of fixed work sees it.
    const fixed = /qa team checked this work|fixed-after-qa/.test(taskText) ? 'fixed-after-qa' : '';
    const synopsis = [result.synopsis, heard.length ? `heard: ${heard.join(' / ')}` : '', recall ? `remembered: ${recall}` : '', fixed]
      .filter(Boolean)
      .join(' · ');
    callbacks.onTranscript?.({ id: `${rowId}-done`, kind: 'message', text: synopsis });
    return { ...result, synopsis, sessionId, filesChanged: /edit-test|writes-files|install|qa team checked this work/.test(taskText) };
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
    this.#appsLine(args);
    // Makes the folders the owner opened (Settings > Hub) observable.
    if (args.prompt.includes('Folders the owner opened to you')) {
      callbacks.onActivity(`mock: opened folders ${(args.prompt.match(/^- (read & write|read only): /gm) ?? []).length}`);
    }
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
