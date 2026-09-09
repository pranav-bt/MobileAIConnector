import { useSyncExternalStore } from 'react';
import {
  DEFAULT_HUB_PORT,
  applyEvent,
  decodeEvent,
  emptyState,
  encodeCommand,
  type ClientCommand,
  type HubState,
} from '@agent-hq/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

interface HubSnapshot {
  state: HubState;
  status: ConnectionStatus;
}

// Thin replica of the hub: applies the same events through the same shared
// reducer the hub uses, so what this renders is what the hub knows.
class HubClient {
  #snapshot: HubSnapshot = { state: emptyState(), status: 'connecting' };
  #listeners = new Set<() => void>();
  #ws: WebSocket | null = null;
  #url: string;

  constructor(url: string) {
    this.#url = url;
    this.#connect();
  }

  #connect(): void {
    this.#setStatus('connecting');
    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.onopen = () => {
      this.#setStatus('open');
      this.send({ type: 'hello', client: 'desktop', name: 'Agent HQ desktop' });
    };
    ws.onmessage = (message) => {
      const event = decodeEvent(String(message.data));
      if (!event) return;
      this.#snapshot = { ...this.#snapshot, state: applyEvent(this.#snapshot.state, event) };
      this.#notify();
    };
    ws.onclose = () => {
      this.#setStatus('closed');
      setTimeout(() => this.#connect(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  #setStatus(status: ConnectionStatus): void {
    this.#snapshot = { ...this.#snapshot, status };
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  send(command: ClientCommand): void {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(encodeCommand(command));
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): HubSnapshot => this.#snapshot;
}

export const hubClient = new HubClient(`ws://127.0.0.1:${DEFAULT_HUB_PORT}`);

export function useHub(): HubSnapshot & { send: (command: ClientCommand) => void } {
  const snapshot = useSyncExternalStore(hubClient.subscribe, hubClient.getSnapshot);
  return { ...snapshot, send: (command) => hubClient.send(command) };
}
