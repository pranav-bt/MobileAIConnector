import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

// Device pairing: exactly one device slot, keys pinned on both sides.
// Built on node:crypto (X25519 for the transport keys, Ed25519 for
// approval signatures) — no native or WASM dependencies.
//
// Implemented now: PC keypair generation/persistence, the one-time pairing
// payload the QR encodes, single-slot registration, revocation (the kill
// switch's core), and approval-signature verification.
//
// Next (security milestone): deriving session keys from the pinned X25519
// keys and wrapping the WebSocket frames, plus mDNS discovery.

interface SecurityStore {
  pcPublicKeyDerB64: string;
  pcPrivateKeyDerB64: string;
  device: {
    publicKeyDerB64: string; // device X25519 key (transport)
    signPublicKeyDerB64: string; // device Ed25519 key (approval signatures)
    name: string;
    pairedAt: number;
  } | null;
}

export class PairingManager {
  #storePath: string;
  #store: SecurityStore | null = null;
  #pendingToken: string | null = null;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.#storePath = join(dataDir, 'security.json');
  }

  async init(): Promise<void> {
    if (existsSync(this.#storePath)) {
      this.#store = JSON.parse(readFileSync(this.#storePath, 'utf8')) as SecurityStore;
      return;
    }
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    this.#store = {
      pcPublicKeyDerB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      pcPrivateKeyDerB64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      device: null,
    };
    this.#save();
  }

  #save(): void {
    if (this.#store) writeFileSync(this.#storePath, JSON.stringify(this.#store, null, 2));
  }

  #required(): SecurityStore {
    if (!this.#store) throw new Error('PairingManager.init() has not been awaited');
    return this.#store;
  }

  get fingerprint(): string {
    const digest = createHash('sha256')
      .update(Buffer.from(this.#required().pcPublicKeyDerB64, 'base64'))
      .digest('hex')
      .slice(0, 24)
      .toUpperCase();
    return digest.replace(/(.{4})/g, '$1 ').trim();
  }

  get pairedDevice(): { name: string; pairedAt: number } | null {
    const device = this.#required().device;
    return device ? { name: device.name, pairedAt: device.pairedAt } : null;
  }

  get pcPublicKeyDerB64(): string {
    return this.#required().pcPublicKeyDerB64;
  }

  get pcPrivateKey(): KeyObject {
    return createPrivateKey({
      key: Buffer.from(this.#required().pcPrivateKeyDerB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  }

  // The paired device's static X25519 key, pinned at pairing time.
  get devicePublicKey(): KeyObject | null {
    const device = this.#required().device;
    if (!device) return null;
    return createPublicKey({ key: Buffer.from(device.publicKeyDerB64, 'base64'), format: 'der', type: 'spki' });
  }

  // The QR on the PC screen encodes exactly this payload.
  createPairingPayload(host: string, port: number): { qrJson: string; token: string } | null {
    if (this.#required().device) return null; // slot in use — revoke first
    this.#pendingToken = randomBytes(16).toString('hex');
    const payload = {
      v: 1,
      host,
      port,
      pcPublicKeyDerB64: this.#required().pcPublicKeyDerB64,
      token: this.#pendingToken,
    };
    return { qrJson: JSON.stringify(payload), token: this.#pendingToken };
  }

  completePairing(args: {
    token: string;
    devicePublicKeyDerB64: string;
    deviceSignPublicKeyDerB64: string;
    name: string;
  }): boolean {
    const store = this.#required();
    if (store.device || !this.#pendingToken || args.token !== this.#pendingToken) return false;
    store.device = {
      publicKeyDerB64: args.devicePublicKeyDerB64,
      signPublicKeyDerB64: args.deviceSignPublicKeyDerB64,
      name: args.name,
      pairedAt: Date.now(),
    };
    this.#pendingToken = null;
    this.#save();
    return true;
  }

  // Kill switch core: after this, nothing can connect until a fresh pairing
  // is performed with physical access to this PC.
  revokeDevice(): void {
    const store = this.#required();
    store.device = null;
    this.#pendingToken = null;
    this.#save();
  }

  // A phone approval is only trusted if signed by the paired device's key.
  verifyApprovalSignature(message: string, signatureB64: string): boolean {
    const device = this.#required().device;
    if (!device) return false;
    try {
      const key = createPublicKey({
        key: Buffer.from(device.signPublicKeyDerB64, 'base64'),
        format: 'der',
        type: 'spki',
      });
      // Ed25519 keys use a null digest algorithm in node:crypto.
      return cryptoVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
    } catch {
      return false;
    }
  }
}
