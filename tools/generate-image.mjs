// Art-team image generation via the Gemini API (nano banana models).
//
//   node tools/generate-image.mjs "<prompt>" <out.png> [--in <image.png>] [--model <name>] [--list-models]
//
// --in <image>   edit/restyle an existing image instead of generating from scratch
// --model <name> pin a specific model (otherwise tries MODELS in order)
// --list-models  print the image-capable models this API key can see, then exit
//
// Key: GEMINI_API_KEY env var, or data/secrets.json {"geminiApiKey": "..."} at
// the repo root (data/ is gitignored). Free-tier keys work; when the daily
// quota is hit the API returns 429 and this script says so plainly.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const args = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--in' || args[i] === '--model') flags.set(args[i], args[++i]);
  else if (args[i] === '--list-models') flags.set(args[i], true);
  else positional.push(args[i]);
}

const key = apiKey();

if (flags.has('--list-models')) {
  const response = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const body = await response.json();
  if (!response.ok) {
    console.error(`model listing failed (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }
  const names = (body.models ?? [])
    .map((model) => model.name?.replace(/^models\//, ''))
    .filter((name) => /image|imagen/i.test(name ?? ''));
  console.log(names.length ? names.join('\n') : '(no image-capable models visible to this key)');
  process.exit(0);
}

const [prompt, outPath] = positional;
if (!prompt || !outPath) {
  console.error('usage: node tools/generate-image.mjs "<prompt>" <out.png> [--in <image.png>] [--model <name>]');
  process.exit(2);
}

const parts = [{ text: prompt }];
if (flags.has('--in')) {
  const inputPath = flags.get('--in');
  const ext = inputPath.toLowerCase().split('.').pop();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  parts.push({ inlineData: { mimeType: mime, data: readFileSync(inputPath).toString('base64') } });
}

async function generate(model, withModalities) {
  const body = { contents: [{ parts }] };
  if (withModalities) body.generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  const response = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

const tried = [];
const modelList = flags.has('--model') ? [flags.get('--model')] : MODELS;
for (const model of modelList) {
  for (const withModalities of [false, true]) {
    const { status, json } = await generate(model, withModalities);
    if (status === 404) {
      tried.push(`${model}: not available to this key`);
      break; // no point retrying the same missing model with a config tweak
    }
    if (status === 429) {
      console.error(`quota exhausted on ${model} (free-tier daily/minute limit) — try again later.`);
      process.exit(4);
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
    process.exit(0);
  }
}

console.error('image generation failed on every model tried:');
for (const line of tried) console.error(`  - ${line}`);
console.error('run with --list-models to see what this key can access.');
process.exit(1);
