import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelSpec } from '@agent-hq/shared';
import type { OrchestratorEngine, WorkerRunCallbacks, WorkerRunResult } from './types.js';

// Tools whose use flows through the policy (which instantly allows the
// routine and raises a card for the consequential). Read is included ONLY so
// the policy can catch credential-like paths — normal reads pass silently.
const GATED_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'Read']);

function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input['command'] === 'string') return String(input['command']);
  if (typeof input['file_path'] === 'string') return `${toolName} ${input['file_path']}`;
  if (typeof input['url'] === 'string') return `${toolName} ${input['url']}`;
  return toolName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Reads SDK stream messages structurally so minor shape evolution between
// SDK versions degrades activity detail instead of crashing the hub.
function describeAssistantMessage(message: Record<string, unknown>): string | null {
  const inner = message['message'];
  if (!isRecord(inner) || !Array.isArray(inner['content'])) return null;
  for (const block of inner['content']) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
      const input = isRecord(block['input']) ? block['input'] : {};
      return summarizeToolCall(block['name'], input);
    }
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
      return block['text'].trim().slice(0, 80);
    }
  }
  return null;
}

export class ClaudeEngine implements OrchestratorEngine {
  async complete(args: { prompt: string; model: ModelSpec }): Promise<{ text: string; tokens: number }> {
    let text = '';
    let tokens = 0;
    const stream = query({
      prompt: args.prompt,
      options: {
        model: args.model.id,
        ...(args.model.effort ? { effort: args.model.effort } : {}),
        maxTurns: 1,
        allowedTools: [],
      },
    });
    for await (const message of stream) {
      const m = message as unknown as Record<string, unknown>;
      if (m['type'] === 'result') {
        if (typeof m['result'] === 'string') text = m['result'];
        const usage = m['usage'];
        if (isRecord(usage)) {
          const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
          const outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
          tokens = inputTokens + outputTokens;
        }
      }
    }
    return { text, tokens };
  }

  async runWorker(args: {
    prompt: string;
    team: { blockedTools: string[]; charter: string; mcpServers?: Record<string, unknown> };
    model: ModelSpec;
    cwd: string;
    extraDirs?: string[];
    callbacks: WorkerRunCallbacks;
    signal?: AbortSignal;
  }): Promise<WorkerRunResult> {
    const { callbacks } = args;
    let tokens = 0;
    let synopsis = '';

    // Bridge the orchestrator's stop signal into the SDK's abort mechanism.
    const abortController = new AbortController();
    if (args.signal) {
      if (args.signal.aborted) abortController.abort();
      else args.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    // The team's MCP grants (e.g. Roblox Studio for QA/Game Engine teams)
    // become the worker session's MCP servers — exactly these, nothing more.
    type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>;
    const mcpServers =
      args.team.mcpServers && Object.keys(args.team.mcpServers).length > 0
        ? (args.team.mcpServers as QueryOptions['mcpServers'])
        : undefined;

    const stream = query({
      prompt: args.prompt,
      options: {
        abortController,
        model: args.model.id,
        ...(args.model.effort ? { effort: args.model.effort } : {}),
        cwd: args.cwd,
        additionalDirectories: args.extraDirs ?? [],
        ...(mcpServers ? { mcpServers } : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append:
            `You are a worker agent on a team with this charter: ${args.team.charter}. Stay within that charter for HOW you work. ` +
            'A task the master routed to your team is always in scope, whatever its topic — including personal or everyday requests from the owner. ' +
            'Never refuse a task over its topic; if it seems like a mismatch for your team, do it anyway and note the mismatch in your report.',
        },
        canUseTool: async (toolName, input) => {
          if (!GATED_TOOLS.has(toolName)) {
            return { behavior: 'allow', updatedInput: input };
          }
          const decision = await callbacks.onPermission({
            toolName,
            command: summarizeToolCall(toolName, input),
            reason: `Requested while working in ${args.cwd}`,
          });
          if (decision === 'approve') {
            return { behavior: 'allow', updatedInput: input };
          }
          return { behavior: 'deny', message: 'Denied by the user from Agent HQ.' };
        },
      },
    });

    for await (const message of stream) {
      const m = message as unknown as Record<string, unknown>;
      if (m['type'] === 'assistant') {
        const activity = describeAssistantMessage(m);
        if (activity) callbacks.onActivity(activity);
      } else if (m['type'] === 'result') {
        if (typeof m['result'] === 'string') synopsis = m['result'];
        const usage = m['usage'];
        if (isRecord(usage)) {
          const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
          const outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
          tokens = inputTokens + outputTokens;
          callbacks.onTokens(tokens);
        }
      }
    }

    return { synopsis, tokens };
  }
}
