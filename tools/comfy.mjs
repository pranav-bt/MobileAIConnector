// On-demand local image generation via ComfyUI (D:\AI\comfyui).
//
// Zero-background contract: ComfyUI is NOT a service and never autostarts.
// It boots only when a generation is requested, a detached watchdog kills it
// after an idle linger (default 2 min, HQ_COMFY_LINGER_MS to tune), and
// process exit releases all VRAM/RAM instantly. At rest the cost is disk.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const COMFY_ROOT = 'D:\\AI\\comfyui';
const APP = join(COMFY_ROOT, 'app');
const PY = join(COMFY_ROOT, 'venv', 'Scripts', 'python.exe');
const BASE = 'http://127.0.0.1:8188';

export function installed() {
  return existsSync(join(APP, 'main.py')) && existsSync(PY);
}

export function modelFile(model) {
  return model === 'sdxl' ? 'sd_xl_base_1.0.safetensors' : 'flux1-schnell-fp8.safetensors';
}

export function modelReady(model) {
  return existsSync(join(COMFY_ROOT, 'models', 'checkpoints', modelFile(model)));
}

// The watchdog reads this: any generation activity refreshes the idle clock.
export function touch() {
  try {
    writeFileSync(join(COMFY_ROOT, '.hq-last-used'), String(Date.now()));
  } catch {}
}

async function up() {
  try {
    const response = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureRunning(log = () => {}) {
  touch();
  if (await up()) return;
  log('booting ComfyUI on demand (cold start ~15-40s)…');
  const child = spawn(PY, [join(APP, 'main.py'), '--port', '8188', '--disable-auto-launch'], {
    cwd: APP,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  const watchdog = spawn(process.execPath, [join(TOOLS_DIR, 'comfy-watchdog.mjs'), String(child.pid)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  watchdog.unref();

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await up()) {
      log('ComfyUI ready');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('ComfyUI did not come up within 120s');
}

// API-format workflow graphs. FLUX uses SD3-style latents; schnell needs
// only 4 steps at cfg 1. SDXL is the sturdy fallback (fits 12GB easily).
function graph(model, prompt, width, height, seed) {
  const flux = model !== 'sdxl';
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: modelFile(model) } },
    '2': flux
      ? { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } }
      : { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['3', 0],
        negative: ['4', 0],
        latent_image: ['2', 0],
        seed,
        steps: flux ? 4 : 25,
        cfg: flux ? 1 : 7,
        sampler_name: 'euler',
        scheduler: flux ? 'simple' : 'normal',
        denoise: 1,
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'agent-hq' } },
  };
}

export async function generateLocal({ prompt, outPath, model = 'flux', width = 1024, height = 1024, log = () => {} }) {
  if (!installed()) throw new Error('ComfyUI is not installed at D:\\AI\\comfyui');
  if (!modelReady(model)) throw new Error(`model ${modelFile(model)} is not downloaded yet`);
  await ensureRunning(log);

  const seed = Math.floor(Math.random() * 1e15);
  const queue = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph(model, prompt, width, height, seed), client_id: 'agent-hq' }),
  });
  const queued = await queue.json().catch(() => ({}));
  if (!queue.ok || !queued.prompt_id) {
    throw new Error(`ComfyUI rejected the job: ${JSON.stringify(queued).slice(0, 300)}`);
  }

  log(`rendering (${modelFile(model)}, seed ${seed})…`);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    touch(); // an active render must never be reaped as idle
    const history = await (await fetch(`${BASE}/history/${queued.prompt_id}`)).json().catch(() => ({}));
    const entry = history[queued.prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      throw new Error(`generation failed: ${JSON.stringify(entry.status.messages ?? '').slice(0, 400)}`);
    }
    for (const node of Object.values(entry.outputs ?? {})) {
      const image = node.images?.[0];
      if (!image) continue;
      const url =
        `${BASE}/view?filename=${encodeURIComponent(image.filename)}` +
        `&subfolder=${encodeURIComponent(image.subfolder ?? '')}&type=${image.type ?? 'output'}`;
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      writeFileSync(outPath, bytes);
      touch();
      return { engine: `ComfyUI ${modelFile(model)}` };
    }
  }
  throw new Error('generation timed out after 10 minutes');
}
