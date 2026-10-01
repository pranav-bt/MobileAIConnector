// Which MCP servers does a worker session actually get? Reads the SDK's init
// message and aborts before any model turn (no usage).
//   npx tsx test/probe-mcp-scope.ts
import { query } from '@anthropic-ai/claude-agent-sdk';

for (const label of ['no team grant', 'team grant', 'strict, no grant', 'strict + grant']) {
  const abortController = new AbortController();
  const stream = query({
    prompt: 'ping',
    options: {
      abortController,
      cwd: process.cwd(),
      maxTurns: 1,
      ...(label.startsWith('strict') ? { strictMcpConfig: true } : {}),
      ...(label.endsWith('grant') && !label.includes('no ')
        ? { mcpServers: { Granted_Probe: { type: 'stdio' as const, command: 'cmd.exe', args: ['/c', 'exit'] } } }
        : {}),
    },
  });
  try {
    for await (const message of stream) {
      const m = message as unknown as Record<string, unknown>;
      if (m['type'] === 'system' && m['subtype'] === 'init') {
        const servers = (m['mcp_servers'] as { name: string; status: string }[] | undefined) ?? [];
        console.log(`${label}: ${servers.map((s) => `${s.name}(${s.status})`).join(', ') || 'none'}`);
        abortController.abort();
      }
    }
  } catch {
    // aborted on purpose
  }
}
