// Is the running hub busy? Lists active tasks and pending cards — check this
// before restarting the hub.   node tools/hub-status.mjs [port]
const port = Number(process.argv[2] ?? 4517);
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const timer = setTimeout(() => {
  console.log('no snapshot (is the hub running?)');
  process.exit(2);
}, 5000);
ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', client: 'cli', name: 'hub-status' })));
ws.addEventListener('error', () => {
  console.log(`hub not reachable on ${port}`);
  process.exit(2);
});
ws.addEventListener('message', (message) => {
  const frame = JSON.parse(String(message.data));
  const event = frame.event ?? frame;
  if (event.type !== 'snapshot') return;
  clearTimeout(timer);
  const active = event.snapshot.tasks.filter((task) => !['done', 'failed', 'paused'].includes(task.status));
  const pending = event.snapshot.permissions.filter((request) => request.status === 'pending');
  console.log(`active=${active.length} pending=${pending.length}`);
  for (const task of active) console.log(`  task ${task.id} [${task.status}] ${task.title}`);
  for (const request of pending) console.log(`  card ${request.id}: ${(request.summary ?? request.command).slice(0, 100)}`);
  process.exit(active.length || pending.length ? 1 : 0);
});
