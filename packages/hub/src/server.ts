import { WebSocketServer, WebSocket } from 'ws';
import {
  decodeCommand,
  encodeEvent,
  toSnapshot,
  type HubEvent,
} from '@agent-hq/shared';
import type { HubBus } from './bus.js';
import { dispatchCommand, type CommandHandlers } from './commands.js';

export interface HubServer {
  port: number;
  clientCount(): number;
  close(): Promise<void>;
}

// v1 transport: plaintext WebSocket bound to localhost/LAN. The pairing +
// session-encryption layer (security/pairing.ts) wraps this in the security
// milestone; the framing (one JSON envelope per event) stays identical.
export function startServer(bus: HubBus, handlers: CommandHandlers, port: number): Promise<HubServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port });

    wss.on('error', reject);

    wss.on('connection', (socket: WebSocket) => {
      socket.send(encodeEvent({ type: 'snapshot', snapshot: toSnapshot(bus.state) }));

      socket.on('message', (raw) => {
        const command = decodeCommand(raw.toString());
        if (!command) {
          console.warn('[hub] dropped malformed command frame');
          return;
        }
        dispatchCommand(handlers, command);
      });
    });

    const unsubscribe = bus.onEvent((event: HubEvent) => {
      const frame = encodeEvent(event);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(frame);
      }
    });

    wss.on('listening', () => {
      resolve({
        port,
        clientCount: () => wss.clients.size,
        close: () =>
          new Promise<void>((done) => {
            unsubscribe();
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
