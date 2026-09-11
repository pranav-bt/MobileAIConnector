// Watchdog for the on-demand ComfyUI: kills it once idle past the linger
// window (default 2 min; HQ_COMFY_LINGER_MS to tune) and exits. Also exits
// as soon as the process is gone for any other reason. Spawned detached by
// tools/comfy.mjs whenever it boots ComfyUI — the zero-background guarantee.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pid = Number(process.argv[2]);
const ROOT = 'D:\\AI\\comfyui';
const LINGER_MS = Number(process.env.HQ_COMFY_LINGER_MS ?? 120_000);
if (!Number.isFinite(pid) || pid <= 0) process.exit(2);

const alive = (target) => {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
};

setInterval(() => {
  if (!alive(pid)) process.exit(0);
  let lastUsed = 0;
  try {
    lastUsed = Number(readFileSync(join(ROOT, '.hq-last-used'), 'utf8'));
  } catch {}
  if (Date.now() - lastUsed > LINGER_MS) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    process.exit(0);
  }
}, 5000);
