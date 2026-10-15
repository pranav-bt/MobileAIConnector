import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ModelSpec } from '@agent-hq/shared';
import type { LockedDir } from '../orchestrator/util.js';
import { DEFAULT_MAX_SUBAGENTS, refusalMessage, refusedWrite, workerInstructions } from './instructions.js';

export { refusedWrite };
import type { EngineRow, OrchestratorEngine, WorkerInbox, WorkerRunCallbacks, WorkerRunResult } from './types.js';
import { shellWrites } from '../orchestrator/policy.js';

// Tools whose use flows through the policy (which instantly allows the
// routine and raises a card for the consequential). Read is included ONLY so
// the policy can catch credential-like paths — normal reads pass silently.
const GATED_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'Read']);

// File-writing tools: their target must sit inside the worker's own project
// workspace. The SDK's allowed directories already say so; this is the
// second lock, so a mis-scoped grant can't silently cross into a sibling
// project the way one once wrote into a project it was never routed to.
const WRITING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const SUBAGENT_TOOLS = ['Agent', 'Task']; // current name + legacy alias

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
        ...(args.model.effort && args.model.effort !== 'ultra' ? { effort: args.model.effort } : {}),
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
    locked?: LockedDir;
    maxSubagents?: number;
    callbacks: WorkerRunCallbacks;
    signal?: AbortSignal;
    resumeSessionId?: string;
    inbox?: WorkerInbox;
    readOnly?: boolean;
  }): Promise<WorkerRunResult> {
    const { callbacks } = args;
    const maxSubagents = args.maxSubagents ?? DEFAULT_MAX_SUBAGENTS;
    let tokens = 0;
    let synopsis = '';
    let sessionId: string | undefined;
    let filesChanged = false;
    const inbox = args.inbox;

    // Bridge the orchestrator's stop signal into the SDK's abort mechanism.
    const abortController = new AbortController();
    const onAbort = () => {
      abortController.abort();
      inbox?.close();
    };
    if (args.signal) {
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener('abort', onAbort, { once: true });
    }

    // The team's MCP grants (e.g. Roblox Studio for QA/Game Engine teams)
    // become the worker session's MCP servers — exactly these, nothing more.
    type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>;
    const mcpServers =
      args.team.mcpServers && Object.keys(args.team.mcpServers).length > 0
        ? (args.team.mcpServers as QueryOptions['mcpServers'])
        : undefined;

    // With an inbox the prompt is a stream: the first message, then whatever
    // the owner sends from the task console while the worker is running
    // (queued for the next step, 'next'). The stream ends when a turn
    // finishes with nothing waiting — that ends the run.
    const userMessage = (text: string, priority?: 'next'): SDKUserMessage => ({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...(priority ? { priority } : {}),
    });
    async function* conversation(): AsyncGenerator<SDKUserMessage> {
      yield userMessage(args.prompt);
      if (!inbox) return;
      for (;;) {
        const next = await inbox.next();
        if (next === null) return;
        yield userMessage(next, 'next');
      }
    }

    // Console rows: a tool row starts 'running' and is replaced with its
    // output when the tool result comes back.
    const toolRows = new Map<string, EngineRow>();
    const emit = (row: EngineRow) => callbacks.onTranscript?.(row);

    const stream = query({
      prompt: inbox ? conversation() : args.prompt,
      options: {
        abortController,
        model: args.model.id,
        ...(args.model.effort && args.model.effort !== 'ultra' ? { effort: args.model.effort } : {}),
        ...(args.resumeSessionId ? { resume: args.resumeSessionId } : {}),
        cwd: args.cwd,
        additionalDirectories: args.extraDirs ?? [],
        ...(mcpServers ? { mcpServers } : {}),
        // Exactly the team's grants: without this every worker also gets the
        // PC's user-scope servers (verified: test/probe-mcp-scope.ts).
        strictMcpConfig: true,
        // No sub-agents at all: the tool is removed, not just discouraged.
        // A reviewer can't write at all: the file tools are removed outright.
        ...(maxSubagents === 0 || args.readOnly
          ? { disallowedTools: [...(maxSubagents === 0 ? SUBAGENT_TOOLS : []), ...(args.readOnly ? [...WRITING_TOOLS] : [])] }
          : {}),
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: workerInstructions(args.team.charter, maxSubagents),
        },
        canUseTool: async (toolName, input) => {
          if (args.readOnly && (WRITING_TOOLS.has(toolName) || (toolName === 'Bash' && typeof input['command'] === 'string' && shellWrites(input['command'])))) {
            return { behavior: 'deny', message: 'You are reviewing — read and run checks only; never change files.' };
          }
          const stray = WRITING_TOOLS.has(toolName) ? refusedWrite(input, args.cwd, args.extraDirs ?? [], args.locked) : null;
          if (stray) {
            callbacks.onActivity(stray.config ? `blocked: write into Agent HQ's own data — ${stray.path}` : `blocked: write outside this project — ${stray.path}`);
            return { behavior: 'deny', message: refusalMessage(stray, args.cwd) };
          }
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

    try {
      for await (const message of stream) {
        const m = message as unknown as Record<string, unknown>;
        if (!sessionId && typeof m['session_id'] === 'string' && m['session_id']) {
          sessionId = m['session_id'];
          callbacks.onSession?.(sessionId);
        }
        if (m['type'] === 'assistant') {
          const activity = describeAssistantMessage(m);
          if (activity) callbacks.onActivity(activity);
          const inner = m['message'];
          const blocks = isRecord(inner) && Array.isArray(inner['content']) ? inner['content'] : [];
          const messageId = isRecord(inner) && typeof inner['id'] === 'string' ? inner['id'] : `m${Date.now().toString(36)}`;
          blocks.forEach((block: unknown, index: number) => {
            if (!isRecord(block)) return;
            if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
              emit({ id: `${messageId}-${index}`, kind: 'message', text: block['text'] });
            } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string' && block['thinking'].trim()) {
              emit({ id: `${messageId}-${index}`, kind: 'thinking', text: block['thinking'] });
            } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string' && typeof block['id'] === 'string') {
              const input = isRecord(block['input']) ? block['input'] : {};
              const name = block['name'];
              if (WRITING_TOOLS.has(name) || (name === 'Bash' && typeof input['command'] === 'string' && shellWrites(input['command']))) {
                filesChanged = true;
              }
              const row: EngineRow = WRITING_TOOLS.has(name)
                ? { id: block['id'], kind: 'diff', tool: name, text: summarizeToolCall(name, input), detail: editPreview(name, input), state: 'running' }
                : { id: block['id'], kind: 'tool', tool: name, text: summarizeToolCall(name, input), state: 'running' };
              toolRows.set(block['id'], row);
              emit(row);
            }
          });
        } else if (m['type'] === 'user') {
          // Tool results come back as user messages.
          const inner = m['message'];
          const blocks = isRecord(inner) && Array.isArray(inner['content']) ? inner['content'] : [];
          for (const block of blocks) {
            if (!isRecord(block) || block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue;
            const row = toolRows.get(block['tool_use_id']);
            if (!row) continue;
            const output = toolResultText(block['content']);
            const done: EngineRow = {
              ...row,
              state: block['is_error'] === true ? 'error' : 'ok',
              ...(row.kind === 'diff' ? {} : output ? { detail: output } : {}),
            };
            toolRows.set(row.id, done);
            emit(done);
          }
        } else if (m['type'] === 'result') {
          if (typeof m['result'] === 'string') synopsis = m['result'];
          const usage = m['usage'];
          if (isRecord(usage)) {
            const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0;
            const outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0;
            tokens += inputTokens + outputTokens;
            callbacks.onTokens(tokens);
          }
          // A turn finished. Messages already streamed in mid-turn were folded
          // into it (verified: test/probe-claude-steer.ts); with nothing
          // still waiting the run is done — closing the inbox ends the input
          // stream, then the query. Later messages continue the task instead.
          if (inbox && inbox.pending() === 0) inbox.close();
        }
      }
    } finally {
      args.signal?.removeEventListener('abort', onAbort);
    }

    return { synopsis, tokens, ...(sessionId ? { sessionId } : {}), filesChanged };
  }
}

// What a Write/Edit is about to change, for the console's diff row.
function editPreview(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'Write' && typeof input['content'] === 'string') return input['content'];
  if (typeof input['old_string'] === 'string' && typeof input['new_string'] === 'string') {
    const minus = input['old_string'].split('\n').map((line) => `- ${line}`);
    const plus = input['new_string'].split('\n').map((line) => `+ ${line}`);
    return [...minus, ...plus].join('\n');
  }
  return undefined;
}

// A tool_result's content as text (string, or text blocks).
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
    .filter(Boolean)
    .join('\n');
}
