import type { ModelTier, Team } from '@agent-hq/shared';
import type { OrchestratorEngine, WorkerRunCallbacks, WorkerRunResult } from './types.js';

// Deterministic engine for tests and offline development: routes by team-id
// keyword, "installs" trigger a permission request, everything resolves fast.
export class MockEngine implements OrchestratorEngine {
  async complete(args: { prompt: string; model: ModelTier }): Promise<{ text: string; tokens: number }> {
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
      return {
        text: JSON.stringify({
          teamId,
          projectId,
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
          : args.prompt.includes('handoff-test') && !args.prompt.includes('[QA]')
            ? 'Done, but the icon set still needs the design team (handoff-test).'
            : 'Mock lead review: work checked, looks complete.';
      return {
        text: JSON.stringify({ synopsis, memoryNote }),
        tokens: 9,
      };
    }
    return { text: 'Mock lead review: work checked, looks complete.', tokens: 9 };
  }

  async runWorker(args: {
    prompt: string;
    team: Team;
    model: ModelTier;
    cwd: string;
    extraDirs?: string[];
    callbacks: WorkerRunCallbacks;
    signal?: AbortSignal;
  }): Promise<WorkerRunResult> {
    const { callbacks, signal } = args;
    // Keyword triggers must fire on the task itself, not on the appended
    // background-context section (project history can mention "install").
    const taskText = (args.prompt.split('\n---\n')[0] ?? args.prompt).toLowerCase();
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
    return { synopsis: 'Mock worker: completed the task as described.', tokens: 42 };
  }
}
