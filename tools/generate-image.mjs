// Art-team image generation. LOCAL FIRST: text-to-image runs on the machine's
// own GPU via on-demand ComfyUI (boots for the job, auto-exits after ~2 min
// idle — zero background footprint); the Gemini API is the fallback and the
// only path for editing an existing image (--in).
//
//   node tools/generate-image.mjs "<prompt>" <out.png> [--in <image.png>] [--model flux|sdxl|<gemini model>] [--list-models]
//
// --in <image>   edit/restyle an existing image (Gemini path; needs API quota)
// --model flux   local FLUX.1 schnell (default; Apache-2.0, best quality)
// --model sdxl   local SDXL (faster, lighter)
// --model gemini force the Gemini API (or pass an exact Gemini model name)
// --list-models  print the image-capable Gemini models this API key can see
//
// Gemini key: GEMINI_API_KEY env var, or data/secrets.json {"geminiApiKey"}.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLocal, installed as comfyInstalled, modelReady } from './comfy.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Newest first; older names kept as fallbacks (2.5-flash-image retires 2026-10).
const MODELS = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-2.0-flash-preview-image-generation'];

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const secretsPath = join(REPO_ROOT, 'data', 'secrets.json');
  if (existsSync(secretsPath)) {
    try {
      const key = JSON.parse(readFileSync(secretsPath, 'utf8')).geminiApiKey;
      if (key) return key;
    } catch {}
  }
  console.error(
    'No Gemini API key found. Put it in data/secrets.json as {"geminiApiKey": "..."} ' +
      '(create the key at aistudio.google.com) or set GEMINI_API_KEY.',
  );
  process.exit(3);
}

const LOCAL_MODELS = new Set(['flux', 'sdxl']);

const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--in' || args[i] === '--model') flags.set(args[i], args[++i]);
  else if (args[i] === '--list-models') flags.set(args[i], true);
  else positional.push(args[i]);
}

// NOTE: after a fetch, exit via process.exitCode + return — process.exit()
// trips a libuv assertion on Windows while the socket is still closing.
if (flags.has('--list-models')) {
  const key = apiKey();
  const response = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const body = await response.json();
  if (!response.ok) {
    console.error(`model listing failed (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
    process.exitCode = 1;
  } else {
    const names = (body.models ?? [])
      .map((model) => model.name?.replace(/^models\//, ''))
      .filter((name) => /image|imagen/i.test(name ?? ''));
    console.log(names.length ? names.join('\n') : '(no image-capable models visible to this key)');
  }
} else {

  const [prompt, outPath] = positional;
  if (!prompt || !outPath) {
    console.error('usage: node tools/generate-image.mjs "<prompt>" <out.png> [--in <image.png>] [--model flux|sdxl|gemini]');
    process.exit(2);
  }

  // Local first: free, unlimited, on the machine's own GPU. Editing (--in)
  // and an explicit gemini model go straight to the API.
  const requested = flags.get('--model');
  const wantsGemini = flags.has('--in') || requested === 'gemini' || (requested && !LOCAL_MODELS.has(requested));
  let doneLocally = false;
  if (!wantsGemini) {
    const localModel = requested === 'sdxl' ? 'sdxl' : 'flux';
    if (comfyInstalled() && modelReady(localModel)) {
      try {
        const result = await generateLocal({ prompt, outPath, model: localModel, log: (line) => console.error(line) });
        console.log(`saved ${outPath} (local: ${result.engine})`);
        doneLocally = true;
        process.exitCode = 0;
      } catch (error) {
        console.error(`local generation failed (${error.message}) — falling back to the Gemini API`);
      }
    } else {
      console.error('local ComfyUI/model not available — falling back to the Gemini API');
    }
  }

  if (!doneLocally) {
  const key = apiKey();
  const parts = [{ text: prompt }];
  if (flags.has('--in')) {
    const inputPath = flags.get('--in');
    const ext = inputPath.toLowerCase().split('.').pop();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    parts.push({ inlineData: { mimeType: mime, data: readFileSync(inputPath).toString('base64') } });
  }

  const generate = async (model, withModalities) => {
    const body = { contents: [{ parts }] };
    if (withModalities) body.generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
    const response = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  };

  const run = async () => {
    const tried = [];
    let sawQuota = false;
    let zeroQuota = false;
    // Only a real Gemini model name pins the list — 'flux'/'sdxl'/'gemini'
    // arriving here means the local path fell through; use the defaults.
    const modelList =
      requested && requested !== 'gemini' && !LOCAL_MODELS.has(requested) ? [requested] : MODELS;
    for (const model of modelList) {
      for (const withModalities of [false, true]) {
        const { status, json } = await generate(model, withModalities);
        if (status === 404) {
          tried.push(`${model}: not available to this key`);
          break; // no point retrying the same missing model with a config tweak
        }
        if (status === 429) {
          sawQuota = true;
          // "limit: 0" means the key's tier includes NO image generation at
          // all (free tier, verified 2026-09) — not that usage ran out.
          if ((json.error?.message ?? '').includes('limit: 0')) zeroQuota = true;
          tried.push(`${model}: 429 quota`);
          break; // maybe another model still has quota
        }
        if (status !== 200) {
          tried.push(`${model}${withModalities ? ' (+modalities)' : ''}: HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`);
          continue;
        }
        const responseParts = json.candidates?.[0]?.content?.parts ?? [];
        const image = responseParts.find((part) => part.inlineData?.data);
        if (!image) {
          tried.push(`${model}${withModalities ? ' (+modalities)' : ''}: 200 but no image in response`);
          continue;
        }
        writeFileSync(outPath, Buffer.from(image.inlineData.data, 'base64'));
        const text = responseParts.find((part) => part.text)?.text?.trim();
        console.log(`saved ${outPath} (model: ${model})${text ? `\nmodel note: ${text.slice(0, 200)}` : ''}`);
        return 0;
      }
    }
    console.error('image generation failed on every model tried:');
    for (const line of tried) console.error(`  - ${line}`);
    if (zeroQuota) {
      console.error(
        'This API key has ZERO image-generation quota: the Gemini free tier does not include image ' +
          'models. The owner must enable billing on the key (pay-per-image) or set up local generation. ' +
          'Report this — do not retry.',
      );
    } else if (sawQuota) {
      console.error('quota exhausted (daily/minute limit) — try again later.');
    } else {
      console.error('run with --list-models to see what this key can access.');
    }
    return sawQuota ? 4 : 1;
  };

  process.exitCode = await run();
  }
}
