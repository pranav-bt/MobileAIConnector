import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import WebSocket from 'ws';
import { decodeEvent, encodeCommand, type HubEvent } from '@agent-hq/shared';
import { startHub } from '../src/index.js';
import { createFrameCrypto, deriveSessionKeys, type FrameCrypto } from '../src/security/session.js';

// Simulated-phone test of the whole security path: pairing via the QR
// payload, the encrypted session handshake, snapshot over the sealed
// channel, signature-gated approvals, and the kill switch.

const PORT = 4605;

function fail(message: string): never {
  console.error(`PAIRING SMOKE FAIL: ${message}`);
  process.exit(1);
}

const hub = await startHub({ engine: 'mock', port: PORT, dataDir: mkdtempSync(join(tmpdir(), 'agent-hq-sec-')), generalDir: mkdtempSync(join(tmpdir(), 'agent-hq-sec-general-')) });

// --- local desktop-style client -----------------------------------------
const local = new WebSocket(`ws://127.0.0.1:${PORT}`);
const events: HubEvent[] = [];
const waiters: { test: (e: HubEvent) => boolean; resolve: (e: HubEvent) => void }[] = [];
local.on('message', (raw) => {
  const event = decodeEvent(raw.toString());
  if (!event) return;
  events.push(event);
  for (const waiter of [...waiters]) {
    if (waiter.test(event)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  }
});
function waitFor(label: string, test: (e: HubEvent) => boolean, timeoutMs = 8000): Promise<HubEvent> {
  const already = events.find(test);
  if (already) return Promise.resolve(already);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), timeoutMs);
    waiters.push({ test, resolve: (event) => { clearTimeout(timer); resolve(event); } });
  });
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the "phone" ---------------------------------------------------------
const deviceStatic = generateKeyPairSync('x25519');
const deviceSign = generateKeyPairSync('ed25519');

try {
  await new Promise<void>((resolve, reject) => {
    local.on('open', () => resolve());
    local.on('error', reject);
  });
  local.send(encodeCommand({ type: 'hello', client: 'cli', name: 'pairing-smoke' }));

  // 1. Open pairing mode, read the QR payload.
  local.send(encodeCommand({ type: 'pairing.start' }));
  const pairingOpen = await waitFor(
    'pairing QR published',
    (e) => e.type === 'security.updated' && e.security.pairingQr !== null,
  );
  if (pairingOpen.type !== 'security.updated' || !pairingOpen.security.pairingQr) fail('unreachable');
  const qr = JSON.parse(pairingOpen.security.pairingQr) as { port: number; pcPublicKeyDerB64: string; token: string };
  console.log('pairing mode open, QR payload read');

  // 2. Pair: the phone presents the one-time token plus its public keys.
  await new Promise<void>((resolve, reject) => {
    const pairSocket = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => reject(new Error('pair-ack timeout')), 5000);
    pairSocket.on('open', () => {
      pairSocket.send(
        JSON.stringify({
          t: 'pair',
          token: qr.token,
          devicePublicKeyDerB64: deviceStatic.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          deviceSignPublicKeyDerB64: deviceSign.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          name: 'Test Phone',
        }),
      );
    });
    pairSocket.on('message', (raw) => {
      const reply = JSON.parse(raw.toString()) as { t: string; ok: boolean };
      clearTimeout(timer);
      if (reply.t === 'pair-ack' && reply.ok) resolve();
      else reject(new Error('pairing rejected'));
    });
    pairSocket.on('error', reject);
  });
  await waitFor(
    'device pinned',
    (e) => e.type === 'security.updated' && e.security.pairedDevice?.name === 'Test Phone',
  );
  console.log('paired: keys pinned on both sides');

  // 3. Encrypted session: handshake, then the snapshot must arrive sealed.
  // Messages are queued from the moment the socket opens — the ack and the
  // sealed snapshot can arrive back-to-back in the same tick.
  const phone = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const phoneEphemeral = generateKeyPairSync('x25519');
  const phoneClosed = new Promise<void>((resolve) => phone.on('close', () => resolve()));
  const phoneMessages: string[] = [];
  const phoneWaiters: ((message: string) => void)[] = [];
  phone.on('message', (raw) => {
    const text = raw.toString();
    const waiter = phoneWaiters.shift();
    if (waiter) waiter(text);
    else phoneMessages.push(text);
  });
  const nextPhoneMessage = (timeoutMs = 5000): Promise<string> => {
    const queued = phoneMessages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('phone message timeout')), timeoutMs);
      phoneWaiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };

  await new Promise<void>((resolve, reject) => {
    phone.on('open', () => resolve());
    phone.on('error', reject);
  });
  phone.send(
    JSON.stringify({
      t: 'session',
      ephPubDerB64: phoneEphemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    }),
  );
  const ack = JSON.parse(await nextPhoneMessage()) as { t: string; ephPubDerB64: string; saltB64: string };
  if (ack.t !== 'session-ack') fail(`expected session-ack, got ${ack.t}`);
  const keys = deriveSessionKeys({
    ownStaticPrivate: deviceStatic.privateKey,
    peerStaticPublic: createPublicKey({ key: Buffer.from(qr.pcPublicKeyDerB64, 'base64'), format: 'der', type: 'spki' }),
    ownEphemeralPrivate: phoneEphemeral.privateKey,
    peerEphemeralPublic: createPublicKey({ key: Buffer.from(ack.ephPubDerB64, 'base64'), format: 'der', type: 'spki' }),
    salt: Buffer.from(ack.saltB64, 'base64'),
  });
  const sealed: FrameCrypto = createFrameCrypto(keys.clientToServer, keys.serverToClient);

  const opened = sealed.open(JSON.parse(await nextPhoneMessage()));
  const phoneSnapshot = opened ? decodeEvent(opened) : null;
  if (!phoneSnapshot || phoneSnapshot.type !== 'snapshot') fail('phone did not receive an encrypted snapshot');
  console.log('encrypted session up: snapshot decrypted on the phone');

  // 4. Signature-gated approvals.
  local.send(encodeCommand({ type: 'task.submit', text: 'Please install the coding test tooling' }));

  // 4-pre. No thread yet, so the master asks which project — a pick-one
  // card. The phone's answer must be signed over "approve:<id>#<choice>":
  // a signature over the plain "approve:<id>" (or another index) is refused.
  const question = await waitFor(
    'which-project card',
    (e) => e.type === 'permission.updated' && e.request.status === 'pending' && e.request.id.startsWith('project-'),
  );
  if (question.type !== 'permission.updated' || !question.request.options?.length) fail('no pick-one card');
  const questionId = question.request.id;
  const signOver = (message: string) => cryptoSign(null, Buffer.from(message, 'utf8'), deviceSign.privateKey).toString('base64');
  const answer = (signatureB64: string, choice?: number) =>
    phone.send(
      sealed.seal(
        encodeCommand({ type: 'permission.respond', requestId: questionId, decision: 'approve', scope: 'once', signatureB64, ...(choice === undefined ? {} : { choice }) }),
      ),
    );
  answer(signOver(`approve:${questionId}`), 0); // signed without the choice
  answer(signOver(`approve:${questionId}#1`), 0); // signed for another option
  answer(signOver(`approve:${questionId}#0`)); // choice missing
  await sleep(700);
  if (events.some((e) => e.type === 'permission.updated' && e.request.id === questionId && e.request.status === 'approved')) {
    fail('a pick-one answer was accepted without a signature over its choice');
  }
  answer(signOver(`approve:${questionId}#0`), 0);
  await waitFor('signed pick accepted', (e) => e.type === 'permission.updated' && e.request.id === questionId && e.request.status === 'approved');
  console.log('pick-one answers: signature must cover the choice');

  const pending = await waitFor(
    'permission request',
    (e) => e.type === 'permission.updated' && e.request.status === 'pending' && !e.request.id.startsWith('project-'),
  );
  if (pending.type !== 'permission.updated') fail('unreachable');
  const requestId = pending.request.id;

  // 4a. Unsigned and badly-signed approvals must be ignored.
  phone.send(sealed.seal(encodeCommand({ type: 'permission.respond', requestId, decision: 'approve', scope: 'once' })));
  phone.send(
    sealed.seal(
      encodeCommand({
        type: 'permission.respond',
        requestId,
        decision: 'approve',
        scope: 'once',
        signatureB64: randomBytes(64).toString('base64'),
      }),
    ),
  );
  await sleep(700);
  if (events.some((e) => e.type === 'permission.updated' && e.request.id === requestId && e.request.status === 'approved')) {
    fail('an unsigned/badly-signed approval was accepted');
  }
  console.log('unsigned + forged approvals rejected');

  // 4b. A properly signed approval goes through.
  const signature = cryptoSign(null, Buffer.from(`approve:${requestId}`, 'utf8'), deviceSign.privateKey).toString('base64');
  phone.send(
    sealed.seal(
      encodeCommand({ type: 'permission.respond', requestId, decision: 'approve', scope: 'once', signatureB64: signature }),
    ),
  );
  await waitFor(
    'signed approval accepted',
    (e) => e.type === 'permission.updated' && e.request.id === requestId && e.request.status === 'approved',
  );
  console.log('signed approval accepted, task resumed');

  // 4c. The task console works over the encrypted phone session: the phone
  // opens a task's console and gets its rows sealed, like every frame.
  phone.send(sealed.seal(encodeCommand({ type: 'task.watch', taskId: pending.request.taskId })));
  let consoleRows: { taskId: string; entries: unknown[] } | null = null;
  for (let attempt = 0; attempt < 200 && !consoleRows; attempt++) {
    const frame = JSON.parse(await nextPhoneMessage(10000)) as Record<string, unknown>;
    if (frame['t'] !== 'enc') fail('phone got an unsealed frame');
    const openedFrame = sealed.open(frame);
    const event = openedFrame ? decodeEvent(openedFrame) : null;
    if (event?.type === 'task.transcript' && event.backfill) consoleRows = { taskId: event.taskId, entries: event.entries };
  }
  if (!consoleRows || consoleRows.taskId !== pending.request.taskId || consoleRows.entries.length === 0) fail('phone did not get the task console over the sealed session');
  console.log(`phone console ok: ${consoleRows.entries.length} rows arrived sealed`);

  // 4d. Opening folders to every worker is the PC owner's call: a device's
  // access.set is dropped, whatever it asks for.
  const updatesBefore = events.filter((e) => e.type === 'hub.updated').length;
  phone.send(sealed.seal(encodeCommand({ type: 'access.set', grants: [{ path: 'C:\\Windows\\Temp', access: 'write' }] })));
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (events.filter((e) => e.type === 'hub.updated').slice(updatesBefore).some((e) => e.type === 'hub.updated' && e.info.accessGrants?.some((grant) => /windows/i.test(grant.path)))) {
    fail('a paired device opened a folder to the workers');
  }
  console.log('device folder access refused: only the PC can open folders to workers');

  // 4e. Same for apps: a device can't add a program for the hub to start.
  const appUpdatesBefore = events.filter((e) => e.type === 'hub.updated').length;
  phone.send(sealed.seal(encodeCommand({ type: 'app.add', name: 'Phone app', exePath: process.execPath })));
  phone.send(sealed.seal(encodeCommand({ type: 'app.remove', appId: 'anything' })));
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (events.filter((e) => e.type === 'hub.updated').slice(appUpdatesBefore).some((e) => e.type === 'hub.updated' && (e.info.apps?.length ?? 0) > 0)) {
    fail('a paired device added an app');
  }
  console.log('device apps refused: only the PC can add apps for workers');

  // 5. Kill switch: session drops, device unpinned, reconnect refused.
  local.send(encodeCommand({ type: 'device.revoke' }));
  await phoneClosed;
  await waitFor(
    'device revoked',
    (e) => e.type === 'security.updated' && e.security.pairedDevice === null && e.security.deviceSessions === 0,
  );
  const retry = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const retryClosed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    retry.on('open', () => {
      retry.send(
        JSON.stringify({
          t: 'session',
          ephPubDerB64: generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        }),
      );
    });
    retry.on('close', () => { clearTimeout(timer); resolve(true); });
    retry.on('error', () => { clearTimeout(timer); resolve(true); });
  });
  if (!retryClosed) fail('revoked device could still open a session');
  console.log('kill switch: session torn down, re-connection refused');

  console.log('PAIRING SMOKE PASS');
  local.close();
  await hub.close();
  process.exit(0);
} catch (error) {
  console.error(error);
  local.close();
  await hub.close();
  process.exit(1);
}
