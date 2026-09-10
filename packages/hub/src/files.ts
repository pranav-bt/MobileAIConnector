import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SHARED_FILE_BYTES, type SharedFile } from '@agent-hq/shared';
import type { HubBus } from './bus.js';

// The file channel to the phone:
//  - shareFile() broadcasts one file as a transient file.shared event
//  - the OUTBOX (data/outbox/) — anything a worker (or you) drops there is
//    pushed to the phone and removed; workers are told the path
//  - capturePcScreen() grabs the PC screen via PowerShell for the phone's
//    "what does it look like right now" button.

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  log: 'text/plain',
  html: 'text/html',
  csv: 'text/csv',
  zip: 'application/zip',
};

export function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function shareFile(
  bus: HubBus,
  args: { name: string; bytes: Buffer; mimeType?: string; from: SharedFile['from']; taskId?: string | null },
): boolean {
  if (args.bytes.length === 0 || args.bytes.length > MAX_SHARED_FILE_BYTES) {
    bus.publish({
      type: 'activity',
      entry: {
        agentId: 'master',
        taskId: args.taskId ?? null,
        message: `file "${args.name}" not sent — ${args.bytes.length === 0 ? 'empty' : 'larger than 6MB'}`,
        at: Date.now(),
      },
    });
    return false;
  }
  bus.publish({
    type: 'file.shared',
    file: {
      id: `f-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
      name: args.name,
      mimeType: args.mimeType ?? mimeFor(args.name),
      bytesB64: args.bytes.toString('base64'),
      from: args.from,
      taskId: args.taskId ?? null,
      at: Date.now(),
    },
  });
  return true;
}

// Polling watcher (fs.watch is unreliable on Windows): a file is shared once
// its size is stable across two ticks, then deleted from the outbox.
export function startOutboxWatcher(bus: HubBus, dataDir: string): { outboxDir: string; stop: () => void } {
  const outboxDir = join(dataDir, 'outbox');
  mkdirSync(outboxDir, { recursive: true });
  const lastSizes = new Map<string, number>();

  const interval = setInterval(() => {
    try {
      for (const name of readdirSync(outboxDir)) {
        const path = join(outboxDir, name);
        const size = statSync(path).size;
        const previous = lastSizes.get(name);
        if (previous === size && size > 0) {
          lastSizes.delete(name);
          const bytes = readFileSync(path);
          unlinkSync(path);
          shareFile(bus, { name, bytes, from: 'worker' });
        } else {
          lastSizes.set(name, size);
        }
      }
    } catch {
      /* transient fs races are fine; next tick retries */
    }
  }, 2500);

  return { outboxDir, stop: () => clearInterval(interval) };
}

export async function capturePcScreen(bus: HubBus): Promise<void> {
  const outPath = join(tmpdir(), `agenthq-screen-${Date.now()}.png`);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;',
    '$g=[System.Drawing.Graphics]::FromImage($bmp);',
    '$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size);',
    `$bmp.Save('${outPath.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png);`,
    '$g.Dispose();$bmp.Dispose();',
  ].join(' ');

  await new Promise<void>((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 }, () => resolve());
  });

  if (existsSync(outPath)) {
    const bytes = readFileSync(outPath);
    unlinkSync(outPath);
    shareFile(bus, { name: `pc-screen-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`, bytes, from: 'pc-screen' });
  } else {
    bus.publish({
      type: 'activity',
      entry: { agentId: 'master', taskId: null, message: 'screen capture failed on the PC', at: Date.now() },
    });
  }
}
