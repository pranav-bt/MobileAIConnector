// Measures what the freelancer observer costs the hub's event loop against
// the REAL ~/.claude/projects (read-only; no usage). Before the incremental
// scan, one tick blocked the loop ~0.5 s every 5 s once transcripts piled up.
//   npx tsx test/freelancer-scan.bench.ts
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { FreelancerManager } from '../src/freelancers.js';

const published: string[] = [];
const bus = {
  publish(event: { type: string; agent?: { name: string } }) {
    if (event.type === 'agent.updated' && event.agent) published.push(event.agent.name);
  },
  state: { agents: {} },
} as unknown as ConstructorParameters<typeof FreelancerManager>[0];

const manager = new FreelancerManager(bus, { outboxDir: '' });
const loop = monitorEventLoopDelay({ resolution: 5 });
loop.enable();

const window = async (label: string, ms: number) => {
  loop.reset();
  await new Promise((resolve) => setTimeout(resolve, ms));
  console.log(`${label}: event loop blocked at most ${(loop.max / 1e6).toFixed(0)} ms (p99 ${(loop.percentile(99) / 1e6).toFixed(0)} ms)`);
};

manager.start(); // first scan: reads every transcript once, asynchronously
await window('first scan (cold cache)', 6_000);
await window('steady state, 2 ticks', 10_500);
manager.stop();
console.log(`freelancers published: ${[...new Set(published)].join(', ') || '(none)'}`);
process.exit(0);
