// LIVE: the app bridge driving the real Blender on this PC — no model, no
// usage. Opens Blender through the MCP server a worker would get, models a
// cube with a material in Python, renders it (image comes back), reads the
// scene, saves a .blend, closes it and checks the process is gone; then
// kills the bridge mid-session and checks Blender quits by itself.
//   npx tsx test/blender-app.live.ts [--visible]   (--visible = with its window)
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { detectBlender } from '../src/apps.js';

const visible = process.argv.includes('--visible');
const exePath = detectBlender()[0];
if (!exePath) {
  console.log('SKIP: no Blender found');
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'agent-hq-blender-'));
const appsFile = join(dir, 'apps.json');
writeFileSync(appsFile, JSON.stringify([{ id: 'blender', name: 'Blender', exePath, args: [], kind: 'blender', visible, idleMinutes: 10, notes: 'Units are metres.' }]));
const bridge = join(import.meta.dirname, '..', 'apps', 'app-bridge.mjs');

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
};

type Content = { type: string; text?: string; data?: string; mimeType?: string };
function client(proc: ChildProcess) {
  let next = 1;
  const waiting = new Map<number, (message: { result?: { content?: Content[]; isError?: boolean; tools?: { name: string }[] }; error?: unknown }) => void>();
  createInterface({ input: proc.stdout! }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const request = (method: string, params: unknown = {}) =>
    new Promise<Parameters<typeof waiting.get>[0] extends never ? never : any>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await request('tools/call', { name, arguments: args });
    const content: Content[] = reply.result?.content ?? [];
    return { content, text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!reply.result?.isError };
  };
  return { request, call };
}

const blenderPids = (): number[] => {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq blender.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    return [...out.matchAll(/"blender\.exe","(\d+)"/g)].map((m) => Number(m[1]));
  } catch {
    return [];
  }
};
const before = new Set(blenderPids());
const ours = () => blenderPids().filter((pid) => !before.has(pid));
const waitFor = async (test: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
  return test();
};

console.log(`Blender at ${exePath} · ${visible ? 'with its window' : 'in the background'}`);
const proc = spawn(process.execPath, [bridge, '--app', 'blender', '--apps-file', appsFile], { stdio: ['pipe', 'pipe', 'inherit'] });
const mcp = client(proc);
const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live', version: '1' } });
check(init.result?.protocolVersion === '2025-06-18', 'initialize echoes the protocol version');
const listed = await mcp.request('tools/list');
const names = (listed.result?.tools ?? []).map((tool: { name: string }) => tool.name);
check(['status', 'open', 'close', 'run', 'python', 'render', 'scene'].every((n) => names.includes(n)), 'Blender tools listed', names.join(', '));

const started = Date.now();
const opened = await mcp.call('open');
check(!opened.isError && /Blender .* is open/.test(opened.text), 'open', `${opened.text} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
check(ours().length === 1, 'one Blender process started', String(ours()));

const made = await mcp.call('python', {
  code: [
    "for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)",
    "bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))",
    "cube = bpy.context.active_object",
    "cube.name = 'AgentCube'",
    "material = bpy.data.materials.new('AgentRed')",
    "material.diffuse_color = (0.9, 0.1, 0.1, 1)",
    "cube.data.materials.append(material)",
    "cube.keyframe_insert('location', frame=1)",
    "cube.location.z = 3",
    "cube.keyframe_insert('location', frame=24)",
    "print('made', cube.name)",
    "result = {'objects': len(bpy.data.objects)}",
  ].join('\n'),
});
check(!made.isError && made.text.includes('made AgentCube') && made.text.includes('"objects":1'), 'python: modelled + animated a cube', made.text.replace(/\n/g, ' | '));
const kept = await mcp.call('python', { code: "result = cube.location.z" });
check(kept.text.includes('result: 3'), 'python: variables persist between calls', kept.text);
const broken = await mcp.call('python', { code: 'raise ValueError("on purpose")' });
check(broken.isError && broken.text.includes('on purpose'), 'python: errors come back as errors');

const renderPath = join(dir, 'cube.png');
const rendered = await mcp.call('render', { path: renderPath, width: 320, height: 240, frame: 1 });
const image = rendered.content.find((c) => c.type === 'image');
check(!rendered.isError && existsSync(renderPath), 'render: PNG written', rendered.text);
check(!!image && image.mimeType === 'image/png' && Buffer.from(image.data!, 'base64').subarray(1, 4).toString() === 'PNG', 'render: image returned to the model');
const eevee = await mcp.call('render', { path: join(dir, 'cube-eevee.png'), engine: 'eevee', width: 160, height: 120 });
check(!eevee.isError, 'render: eevee', eevee.text.split('\n')[0]);
const scene = await mcp.call('scene');
const summary = JSON.parse(scene.text);
const cube = summary.objects.find((o: { name: string }) => o.name === 'AgentCube');
check(!!cube && cube.materials.includes('AgentRed') && !!cube.animation && summary.camera === null, 'scene: cube, material, animation; the preview camera was removed', JSON.stringify(cube));
const blend = join(dir, 'cube.blend');
const saved = await mcp.call('python', { code: `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})` });
check(!saved.isError && existsSync(blend), 'python: saved a .blend');

const closed = await mcp.call('close');
check(closed.text.includes('closed'), 'close', closed.text);
check(await waitFor(() => ours().length === 0, 15_000), 'Blender process gone after close');
const status = await mcp.call('status');
check(status.text.includes("isn't open"), 'status after close', status.text);

// The bridge dies without a goodbye (the hub was killed): Blender quits on its own.
const reopened = await mcp.call('open', { file: blend });
check(!reopened.isError && reopened.text.includes('cube.blend'), 'open with the saved file', reopened.text);
const again = await mcp.call('scene');
check(again.text.includes('AgentCube'), 'the saved file has the cube');
proc.kill('SIGKILL');
check(await waitFor(() => ours().length === 0, 30_000), 'Blender quits by itself when the bridge is killed');

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? 'BLENDER APP LIVE PASS' : `BLENDER APP LIVE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
