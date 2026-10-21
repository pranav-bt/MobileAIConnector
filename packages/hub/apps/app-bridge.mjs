#!/usr/bin/env node
// Agent HQ's app bridge — an MCP server (stdio) that lets a worker use ONE
// desktop app the owner added in Settings > Apps (data/apps.json):
//   status · open (the app's window, a file) · close · run (the program as a
//   command-line tool, output captured)
// and for Blender, a live session driven through its Python (bpy):
//   python · render (PNG, returned so the model sees it) · scene
// The app opens when a tool first needs it and closes when the worker says
// so, after the owner's idle minutes, or when this server ends (the worker's
// session ended). It only ever closes what it opened itself — never an app
// window the owner opened. No dependencies: plain Node, JSON-RPC over stdio.
//   node app-bridge.mjs --app <id> --apps-file <data/apps.json>
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const appId = arg('app') ?? '';
const appsFile = arg('apps-file') ?? '';
// A reviewer's bridge: look (open a file, render, the scene), never change
// anything — no Python, no command runs.
const readOnly = process.argv.includes('--read-only');
const here = dirname(fileURLToPath(import.meta.url));
const BLENDER_SIDE = join(here, 'blender_bridge.py');

function loadApp() {
  try {
    const apps = JSON.parse(readFileSync(appsFile, 'utf8'));
    return (Array.isArray(apps) ? apps : []).find((app) => app.id === appId) ?? null;
  } catch {
    return null;
  }
}
const app = loadApp();
const isBlender = app?.kind === 'blender';
const outDir = join(tmpdir(), 'claude', 'agent-hq-apps', appId || 'app');

// --- the app process this server opened ------------------------------------
let child = null; // { proc, port, token, startedAt }
let lastUse = Date.now();
let idleTimer = null;
// AGENT_HQ_APP_IDLE_MS: tests shorten the idle close.
const idleMs = () => Number(process.env.AGENT_HQ_APP_IDLE_MS) || Math.max(1, Number(app?.idleMinutes ?? 10)) * 60_000;
const touch = () => {
  lastUse = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  if (child) idleTimer = setTimeout(() => void closeApp('idle'), idleMs());
};
const running = () => !!child && child.proc.exitCode === null && !child.proc.killed;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// One request to the Blender side: newline-delimited JSON over a local
// socket, with this session's token (no other process can drive it).
function blender(op, payload = {}, timeoutMs = 300_000) {
  return new Promise((resolveReply, reject) => {
    if (!child?.port) return reject(new Error('Blender is not open'));
    const socket = createConnection({ host: '127.0.0.1', port: child.port });
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Blender did not answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ token: child.token, op, ...payload })}\n`));
    socket.on('data', (data) => {
      buffer += data.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolveReply(JSON.parse(buffer.slice(0, end)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function openApp({ file, args } = {}) {
  if (!app) throw new Error(`the app "${appId}" was removed from Agent HQ`);
  if (!existsSync(app.exePath)) throw new Error(`${app.name} isn't at ${app.exePath} any more — fix the path in Settings > Apps`);
  if (running()) return `${app.name} is already open (pid ${child.proc.pid}).`;
  const extra = Array.isArray(args) ? args.map(String) : [];
  if (isBlender) {
    const port = await freePort();
    const token = randomBytes(16).toString('hex');
    const blenderArgs = [
      ...(app.args ?? []),
      ...(app.visible ? [] : ['-b']),
      ...(file ? [resolve(String(file))] : []),
      ...extra,
      '--python',
      BLENDER_SIDE,
      '--',
      '--port',
      String(port),
      '--token',
      token,
      '--parent',
      String(process.pid),
    ];
    const proc = spawn(app.exePath, blenderArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: !app.visible });
    let log = '';
    proc.stdout.on('data', (data) => (log = (log + data).slice(-4000)));
    proc.stderr.on('data', (data) => (log = (log + data).slice(-4000)));
    child = { proc, port, token, startedAt: Date.now() };
    // Ready when its side answers a ping.
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (!running()) {
        child = null;
        throw new Error(`Blender exited while starting: ${log.slice(-600) || '(no output)'}`);
      }
      try {
        const pong = await blender('ping', {}, 3000);
        if (pong.ok) {
          touch();
          return `Blender ${pong.version} is open${app.visible ? ' (window shown)' : ' (in the background)'}${file ? ` with ${file}` : ''}.`;
        }
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) {
        await closeApp('start timeout');
        throw new Error('Blender did not come up within 90 s');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const proc = spawn(app.exePath, [...(app.args ?? []), ...(file ? [resolve(String(file))] : []), ...extra], {
    stdio: 'ignore',
    windowsHide: !app.visible,
  });
  child = { proc, port: 0, token: '', startedAt: Date.now() };
  await new Promise((r) => setTimeout(r, 800));
  if (!running()) {
    const code = proc.exitCode;
    child = null;
    return `${app.name} started and exited right away (code ${code}) — it may have handed off to an already open window, or it needs different arguments.`;
  }
  touch();
  return `${app.name} is open (pid ${proc.pid}).`;
}

function killTree(pid, force) {
  return new Promise((done) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // already gone
      }
      return done();
    }
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
    killer.on('exit', () => done());
    killer.on('error', () => done());
  });
}

async function closeApp(why = 'asked') {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!child) return `${app?.name ?? 'The app'} isn't open (nothing this session opened).`;
  const { proc } = child;
  if (running()) {
    if (isBlender) {
      try {
        await blender('quit', {}, 5000);
      } catch {
        // fall through to the kill
      }
    } else {
      // A window gets asked to close (it may save); a hidden app has none.
      await killTree(proc.pid, !app?.visible);
    }
    const gone = await new Promise((done) => {
      if (!running()) return done(true);
      const timer = setTimeout(() => done(false), 8000);
      proc.once('exit', () => {
        clearTimeout(timer);
        done(true);
      });
    });
    if (!gone) await killTree(proc.pid, true);
  }
  child = null;
  return `${app?.name ?? 'The app'} closed (${why}).`;
}

function runCli({ args, timeoutSec }) {
  if (!app) throw new Error(`the app "${appId}" was removed from Agent HQ`);
  const argv = [...(app.args ?? []), ...(Array.isArray(args) ? args.map(String) : [])];
  const limit = Math.min(Math.max(Number(timeoutSec) || 120, 5), 1800) * 1000;
  return new Promise((resolveRun) => {
    const proc = spawn(app.exePath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const keep = (data) => (out = (out + data).slice(-20_000));
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    const timer = setTimeout(() => void killTree(proc.pid, true), limit);
    proc.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ code: -1, out: String(error) });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolveRun({ code, out });
    });
  });
}

// --- tools -----------------------------------------------------------------
const notes = app?.notes ? ` The owner's notes: ${app.notes}` : '';
const lifecycle = `It closes after ${Math.max(1, Math.round(idleMs() / 60_000))} idle minutes or when your session ends`;
const noInput = { type: 'object', properties: {} };
const statusTool = { name: 'status', description: `Is ${app?.name ?? 'the app'} open (opened by this session)? Its pid and how long until it closes when idle.`, inputSchema: noInput };
const openTool = {
  name: 'open',
  description:
    `Open ${app?.name ?? 'the app'}${app?.visible ? " (its window shows on the owner's screen)" : ' (in the background)'}, optionally with a file. ` +
    `${lifecycle}${isBlender && !readOnly ? ' — save your .blend to keep work' : ''}.${notes}`,
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'A file to open with it' },
      ...(readOnly ? {} : { args: { type: 'array', items: { type: 'string' }, description: 'Extra command-line arguments' } }),
    },
  },
};
const closeTool = { name: 'close', description: `Close ${app?.name ?? 'the app'} if this session opened it (never touches a window the owner opened).`, inputSchema: noInput };
const runTool = {
  name: 'run',
  description:
    `Run ${app?.name ?? 'the app'}'s program as a command-line tool (${app ? basename(app.exePath) : 'exe'} <args>) and get its output — for apps ` +
    `with CLI modes (exports, conversions, batch jobs${isBlender ? ', e.g. ["-b", "file.blend", "--python", "script.py"]' : ''}).${notes}`,
  inputSchema: {
    type: 'object',
    properties: { args: { type: 'array', items: { type: 'string' } }, timeoutSec: { type: 'number', description: 'Default 120, max 1800' } },
    required: ['args'],
  },
};
const pythonTool = {
  name: 'python',
  description:
    'Run Blender Python (bpy) in the open Blender session (opens it if needed) — modelling, materials, rigging, animation, ' +
    'saving (bpy.ops.wm.save_as_mainfile(filepath=...)) and exporting (bpy.ops.export_scene.gltf / fbx). Variables persist between ' +
    'calls; print() output comes back; set `result` to return a value. Use absolute paths for files.',
  inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
};
const renderTool = {
  name: 'render',
  description:
    'Render the current scene to a PNG and get the image back to look at. Uses the scene camera, or frames everything ' +
    'from a temporary camera when there is none. engine: "workbench" (fast preview, default), "eevee" or "cycles". ' +
    'Default size: the scene resolution, at most 1280 px on the long side.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Where to save the PNG (absolute; default: a temp folder)' },
      engine: { type: 'string', enum: ['workbench', 'eevee', 'cycles'] },
      width: { type: 'number' },
      height: { type: 'number' },
      frame: { type: 'number', description: 'Animation frame to render' },
    },
  },
};
const sceneTool = {
  name: 'scene',
  description: 'What is in the open Blender file: objects (type, location, size, materials, animation), frame range, the file path.',
  inputSchema: noInput,
};
const tools = [
  statusTool,
  openTool,
  closeTool,
  ...(readOnly ? [] : [runTool]),
  ...(isBlender ? [...(readOnly ? [] : [pythonTool]), renderTool, sceneTool] : []),
];
const offered = new Set(tools.map((tool) => tool.name));

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });
const failure = (message) => ({ content: [{ type: 'text', text: String(message) }], isError: true });

async function callTool(name, input = {}) {
  if (!offered.has(name)) return failure(readOnly && ['run', 'python'].includes(name) ? `${name} isn't available while reviewing (read-only)` : `unknown tool ${name}`);
  touch();
  try {
    switch (name) {
      case 'status':
        return text(
          running()
            ? `${app.name} is open (pid ${child.proc.pid}, opened ${Math.round((Date.now() - child.startedAt) / 1000)} s ago); it closes after ${Math.round(idleMs() / 60_000)} idle minutes.`
            : `${app?.name ?? 'The app'} isn't open (from this session).`,
        );
      case 'open':
        return text(await openApp(readOnly ? { file: input.file } : input));
      case 'close':
        return text(await closeApp('asked'));
      case 'run': {
        const { code, out } = await runCli(input);
        return { content: [{ type: 'text', text: `exit code ${code}\n${out || '(no output)'}` }], isError: code !== 0 };
      }
      case 'python': {
        if (!isBlender) return failure('python is a Blender tool');
        if (!running()) await openApp();
        const reply = await blender('exec', { code: String(input.code ?? '') });
        touch();
        const body = [reply.output?.trimEnd(), reply.result !== undefined && reply.result !== null ? `result: ${JSON.stringify(reply.result)}` : '', reply.error ?? '']
          .filter(Boolean)
          .join('\n');
        return { content: [{ type: 'text', text: body || '(no output)' }], isError: !reply.ok };
      }
      case 'render': {
        if (!isBlender) return failure('render is a Blender tool');
        if (!running()) await openApp();
        mkdirSync(outDir, { recursive: true });
        const path = input.path ? resolve(String(input.path)) : join(outDir, `render-${Date.now()}.png`);
        const reply = await blender('render', { path, engine: input.engine ?? 'workbench', width: input.width, height: input.height, frame: input.frame });
        touch();
        if (!reply.ok) return failure(reply.error ?? 'render failed');
        const saved = reply.path ?? path;
        const content = [{ type: 'text', text: `rendered ${reply.engine} ${reply.width}x${reply.height}${reply.camera ? ` from ${reply.camera}` : ''} in ${reply.seconds} s → ${saved}` }];
        try {
          const data = readFileSync(saved);
          if (data.length < 4_000_000) content.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/png' });
        } catch {
          // the path is in the text either way
        }
        return { content };
      }
      case 'scene': {
        if (!isBlender) return failure('scene is a Blender tool');
        if (!running()) await openApp();
        const reply = await blender('scene');
        touch();
        return reply.ok ? text(JSON.stringify(reply.scene, null, 2)) : failure(reply.error ?? 'scene failed');
      }
      default:
        return failure(`unknown tool ${name}`);
    }
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

// --- MCP over stdio ----------------------------------------------------------
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications (initialized, cancelled)
  if (method === 'initialize') {
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: `agent-hq-app-${appId}`, version: '1.0.0' },
        instructions: app ? `${app.name}, added by the owner in Agent HQ.${notes}` : `The app "${appId}" was removed.`,
      },
    });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools } });
  if (method === 'tools/call') return send({ id, result: await callTool(params?.name, params?.arguments ?? {}) });
  return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
});

// The worker's session ended: close what this session opened.
let ending = false;
const end = async () => {
  if (ending) return;
  ending = true;
  try {
    await closeApp('session ended');
  } finally {
    process.exit(0);
  }
};
lines.on('close', () => void end());
process.on('SIGTERM', () => void end());
process.on('SIGINT', () => void end());
if (process.argv.includes('--self-check')) {
  // node app-bridge.mjs --self-check: prints the tools it would offer.
  console.log(JSON.stringify({ app: app?.name ?? null, tools: tools.map((tool) => tool.name), isAbsolute: isAbsolute(appsFile) }));
  process.exit(0);
}
