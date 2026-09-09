import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import {
  decodeCommand,
  encodeEvent,
  toSnapshot,
  type ClientCommand,
  type HubEvent,
} from '@agent-hq/shared';
import type { HubBus } from './bus.js';
import { dispatchCommand, type CommandHandlers } from './commands.js';
import type { SecurityController } from './security/controller.js';
import type { FrameCrypto } from './security/session.js';

export interface HubServer {
  port: number;
  clientCount(): number;
  close(): Promise<void>;
}

// Transport policy:
// - Loopback clients (the desktop app, CLIs on this PC) speak plaintext JSON.
// - Anything else must be the paired device and must complete the encrypted
//   handshake ({t:'pair'} while pairing mode is open, then {t:'session'});
//   every subsequent frame is ChaCha20-Poly1305 sealed.
// - Security commands are honored only from loopback clients.

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function startServer(
  bus: HubBus,
  handlers: CommandHandlers,
  security: SecurityController,
  port: number,
): Promise<HubServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, host: '0.0.0.0' });
    wss.on('error', reject);

    // Every identified client gets a send wrapper; device clients seal frames.
    const clients = new Set<{ send(frame: string): void }>();

    wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      const local = isLoopback(request);
      let mode: 'new' | 'plain' | 'device' = 'new';
      let crypto: FrameCrypto | null = null;
      const client = {
        send(frame: string): void {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(mode === 'device' && crypto ? crypto.seal(frame) : frame);
        },
      };
      const hooks = { close: (code: number, reason: string) => socket.close(code, reason) };

      const handleCommand = (command: ClientCommand): void => {
        switch (command.type) {
          case 'pairing.start':
          case 'pairing.cancel':
          case 'device.revoke':
          case 'connection.kill':
            // The kill switch and pairing live on the PC, never on the device.
            if (mode !== 'plain' || !local) return;
            if (command.type === 'pairing.start') security.startPairing();
            else if (command.type === 'pairing.cancel') security.cancelPairing();
            else security.revokeDevice();
            return;
          case 'permission.respond':
            if (mode === 'device' && !security.verifyApproval(command.requestId, command.decision, command.signatureB64)) {
              console.warn('[hub] rejected device approval with missing/invalid signature');
              return;
            }
            break;
          default:
            break;
        }
        dispatchCommand(handlers, command);
      };

      socket.on('message', (raw) => {
        const text = raw.toString();

        if (mode === 'new') {
          const frame = parseJson(text);
          if (frame && frame['t'] === 'pair') {
            const { reply } = security.handlePairFrame(frame);
            socket.send(reply);
            socket.close(1000, 'pairing complete — reconnect with a session');
            return;
          }
          if (frame && frame['t'] === 'session') {
            const session = security.createDeviceSession(frame, hooks);
            if (!session) {
              socket.close(4401, 'no paired device or bad handshake');
              return;
            }
            mode = 'device';
            crypto = session.crypto;
            socket.send(session.reply);
            client.send(encodeEvent({ type: 'snapshot', snapshot: toSnapshot(bus.state) }));
            clients.add(client);
            socket.on('close', () => {
              clients.delete(client);
              security.dropSession(hooks);
            });
            return;
          }
          // Not a handshake: plaintext is only for local clients.
          if (!local) {
            socket.close(4403, 'encrypted session required');
            return;
          }
          mode = 'plain';
          client.send(encodeEvent({ type: 'snapshot', snapshot: toSnapshot(bus.state) }));
          clients.add(client);
          socket.on('close', () => clients.delete(client));
          const command = decodeCommand(text);
          if (command) handleCommand(command);
          return;
        }

        if (mode === 'device') {
          if (!crypto) return;
          const opened = crypto.open(parseJson(text));
          if (opened === null) {
            console.warn('[hub] dropped undecryptable device frame');
            return;
          }
          const command = decodeCommand(opened);
          if (command) handleCommand(command);
          return;
        }

        const command = decodeCommand(text);
        if (!command) {
          console.warn('[hub] dropped malformed command frame');
          return;
        }
        handleCommand(command);
      });
    });

    const unsubscribe = bus.onEvent((event: HubEvent) => {
      const frame = encodeEvent(event);
      for (const client of clients) client.send(frame);
    });

    wss.on('listening', () => {
      resolve({
        port,
        clientCount: () => clients.size,
        close: () =>
          new Promise<void>((done) => {
            unsubscribe();
            for (const socket of wss.clients) socket.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
