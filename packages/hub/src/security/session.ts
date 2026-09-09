import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';

// Device-session crypto. Handshake (Noise-KK-shaped):
//
//   phone -> { t: 'session', ephPubDerB64 }
//   hub   -> { t: 'session-ack', ephPubDerB64, saltB64 }
//
// Both sides then compute two X25519 agreements — static/static (this is the
// authentication: only the pinned keys can compute it) and
// ephemeral/ephemeral (this is the forward secrecy) — and HKDF them into one
// key per direction. Frames are ChaCha20-Poly1305 with counter nonces:
//
//   { t: 'enc', n: <base64 12-byte nonce>, c: <base64 ciphertext+tag> }

const HKDF_INFO = 'agent-hq-session-v1';
const TAG_LENGTH = 16;

export interface SessionKeys {
  clientToServer: Buffer;
  serverToClient: Buffer;
}

export function deriveSessionKeys(args: {
  ownStaticPrivate: KeyObject;
  peerStaticPublic: KeyObject;
  ownEphemeralPrivate: KeyObject;
  peerEphemeralPublic: KeyObject;
  salt: Buffer;
}): SessionKeys {
  const staticSecret = diffieHellman({ privateKey: args.ownStaticPrivate, publicKey: args.peerStaticPublic });
  const ephemeralSecret = diffieHellman({
    privateKey: args.ownEphemeralPrivate,
    publicKey: args.peerEphemeralPublic,
  });
  const okm = Buffer.from(
    hkdfSync('sha256', Buffer.concat([ephemeralSecret, staticSecret]), args.salt, HKDF_INFO, 64),
  );
  return { clientToServer: okm.subarray(0, 32), serverToClient: okm.subarray(32) };
}

export interface FrameCrypto {
  seal(plaintext: string): string;
  open(frame: unknown): string | null;
}

// sendKey/recvKey differ per side, so nonce counters never collide across
// directions. Nonces are 12 bytes: 4 zero + 8-byte big-endian counter.
export function createFrameCrypto(sendKey: Buffer, recvKey: Buffer): FrameCrypto {
  let sendCounter = 0n;

  return {
    seal(plaintext: string): string {
      const nonce = Buffer.alloc(12);
      nonce.writeBigUInt64BE(sendCounter, 4);
      sendCounter += 1n;
      const cipher = createCipheriv('chacha20-poly1305', sendKey, nonce, { authTagLength: TAG_LENGTH });
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return JSON.stringify({ t: 'enc', n: nonce.toString('base64'), c: ciphertext.toString('base64') });
    },

    open(frame: unknown): string | null {
      if (typeof frame !== 'object' || frame === null) return null;
      const { t, n, c } = frame as { t?: unknown; n?: unknown; c?: unknown };
      if (t !== 'enc' || typeof n !== 'string' || typeof c !== 'string') return null;
      try {
        const nonce = Buffer.from(n, 'base64');
        const payload = Buffer.from(c, 'base64');
        if (nonce.length !== 12 || payload.length < TAG_LENGTH) return null;
        const ciphertext = payload.subarray(0, payload.length - TAG_LENGTH);
        const tag = payload.subarray(payload.length - TAG_LENGTH);
        const decipher = createDecipheriv('chacha20-poly1305', recvKey, nonce, { authTagLength: TAG_LENGTH });
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        return null; // tampered or replayed frame — drop silently
      }
    },
  };
}
