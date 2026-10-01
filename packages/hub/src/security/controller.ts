import { networkInterfaces } from 'node:os';
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { HubBus } from '../bus.js';
import type { PairingManager } from './pairing.js';
import { createFrameCrypto, deriveSessionKeys, type FrameCrypto } from './session.js';

// Owns the security posture: pairing mode, the single device slot, live
// device sessions, and the kill switch. The server delegates handshake
// frames and security commands here; state reaches clients as
// security.updated events.

const PAIRING_WINDOW_MS = 2 * 60 * 1000;

function lanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

export interface DeviceSessionHooks {
  close(code: number, reason: string): void;
}

export class SecurityController {
  #bus: HubBus;
  #pairing: PairingManager;
  #port: number;
  #pairingQr: string | null = null;
  #pairingTimer: ReturnType<typeof setTimeout> | null = null;
  #sessions = new Set<DeviceSessionHooks>();

  constructor(bus: HubBus, pairing: PairingManager, port: number) {
    this.#bus = bus;
    this.#pairing = pairing;
    this.#port = port;
  }

  publishState(): void {
    this.#bus.publish({
      type: 'security.updated',
      security: {
        fingerprint: this.#pairing.fingerprint,
        pairedDevice: this.#pairing.pairedDevice,
        pairingQr: this.#pairingQr,
        deviceSessions: this.#sessions.size,
      },
    });
  }

  #log(message: string): void {
    this.#bus.publish({
      type: 'activity',
      entry: { agentId: 'master', taskId: null, message, at: Date.now() },
    });
  }

  startPairing(): void {
    const payload = this.#pairing.createPairingPayload(lanAddress(), this.#port);
    if (!payload) {
      this.#log('pairing refused — device slot in use, revoke the paired device first');
      return;
    }
    this.#pairingQr = payload.qrJson;
    if (this.#pairingTimer) clearTimeout(this.#pairingTimer);
    this.#pairingTimer = setTimeout(() => this.cancelPairing(), PAIRING_WINDOW_MS);
    this.#log('pairing mode open for 2 minutes — scan the QR from the phone');
    this.publishState();
  }

  cancelPairing(): void {
    if (this.#pairingTimer) clearTimeout(this.#pairingTimer);
    this.#pairingTimer = null;
    this.#pairingQr = null;
    this.publishState();
  }

  // Kill switch: revoke keys, drop every device session, close pairing.
  revokeDevice(): void {
    this.#pairing.revokeDevice();
    for (const session of this.#sessions) session.close(4401, 'device revoked');
    this.#sessions.clear();
    this.cancelPairing();
    this.#log('kill switch: device keys revoked, sessions torn down — re-pair from this PC to reconnect');
    this.publishState();
  }

  // First frame { t: 'pair', ... } from a connecting device.
  handlePairFrame(frame: Record<string, unknown>): { ok: boolean; reply: string } {
    const token = typeof frame['token'] === 'string' ? frame['token'] : '';
    const devicePublicKeyDerB64 = typeof frame['devicePublicKeyDerB64'] === 'string' ? frame['devicePublicKeyDerB64'] : '';
    const deviceSignPublicKeyDerB64 =
      typeof frame['deviceSignPublicKeyDerB64'] === 'string' ? frame['deviceSignPublicKeyDerB64'] : '';
    const name = typeof frame['name'] === 'string' && frame['name'].trim() ? frame['name'].trim().slice(0, 60) : 'Paired device';

    const ok =
      token.length > 0 &&
      devicePublicKeyDerB64.length > 0 &&
      deviceSignPublicKeyDerB64.length > 0 &&
      this.#pairing.completePairing({ token, devicePublicKeyDerB64, deviceSignPublicKeyDerB64, name });

    if (ok) {
      this.cancelPairing();
      this.#log(`device paired: ${name}`);
      this.publishState();
      return { ok: true, reply: JSON.stringify({ t: 'pair-ack', ok: true, fingerprint: this.#pairing.fingerprint }) };
    }
    return { ok: false, reply: JSON.stringify({ t: 'pair-ack', ok: false }) };
  }

  // First frame { t: 'session', ephPubDerB64 } — returns the ack to send and
  // the frame crypto for everything after, or null to reject.
  createDeviceSession(frame: Record<string, unknown>, hooks: DeviceSessionHooks): { reply: string; crypto: FrameCrypto } | null {
    const devicePublicKey = this.#pairing.devicePublicKey;
    const ephPubDerB64 = typeof frame['ephPubDerB64'] === 'string' ? frame['ephPubDerB64'] : '';
    if (!devicePublicKey || !ephPubDerB64) return null;

    try {
      const clientEphemeralPublic = createPublicKey({
        key: Buffer.from(ephPubDerB64, 'base64'),
        format: 'der',
        type: 'spki',
      });
      const serverEphemeral = generateKeyPairSync('x25519');
      const salt = randomBytes(32);
      const keys = deriveSessionKeys({
        ownStaticPrivate: this.#pairing.pcPrivateKey,
        peerStaticPublic: devicePublicKey,
        ownEphemeralPrivate: serverEphemeral.privateKey,
        peerEphemeralPublic: clientEphemeralPublic,
        salt,
      });
      const crypto = createFrameCrypto(keys.serverToClient, keys.clientToServer);
      const reply = JSON.stringify({
        t: 'session-ack',
        ephPubDerB64: serverEphemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        saltB64: salt.toString('base64'),
      });
      this.#sessions.add(hooks);
      this.publishState();
      return { reply, crypto };
    } catch {
      return null;
    }
  }

  dropSession(hooks: DeviceSessionHooks): void {
    if (this.#sessions.delete(hooks)) this.publishState();
  }

  // Approvals arriving over a device session must be signed by the paired
  // device's Ed25519 key over `${decision}:${requestId}`.
  // The signed message is `${decision}:${requestId}`, plus `#${choice}` for a
  // pick-one card — request ids never contain '#', so a signature for one
  // answer can't be replayed as another.
  verifyApproval(
    requestId: string,
    decision: 'approve' | 'deny',
    signatureB64: string | undefined,
    choice?: number,
  ): boolean {
    if (!signatureB64 || requestId.includes('#')) return false;
    const message = `${decision}:${requestId}${choice === undefined ? '' : `#${choice}`}`;
    return this.#pairing.verifyApprovalSignature(message, signatureB64);
  }

  stop(): void {
    if (this.#pairingTimer) clearTimeout(this.#pairingTimer);
    for (const session of this.#sessions) session.close(1001, 'hub shutting down');
    this.#sessions.clear();
  }
}
