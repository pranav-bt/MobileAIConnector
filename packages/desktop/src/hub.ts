import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  DEFAULT_HUB_PORT,
  applyEvent,
  decodeEvent,
  emptyState,
  encodeCommand,
  type ClientCommand,
  type HubState,
  type TranscriptEntry,
} from '@agent-hq/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

interface HubSnapshot {
  state: HubState;
  status: ConnectionStatus;
}

// One open task console: its rows (upserted by id, each keeping its first
// timestamp so it stays in place), and whether older rows can be paged in.
export interface TranscriptView {
  entries: TranscriptEntry[];
  more: boolean;
  loaded: boolean;
}
const EMPTY_VIEW: TranscriptView = { entries: [], more: false, loaded: false };

// Thin replica of the hub: applies the same events through the same shared
// reducer the hub uses, so what this renders is what the hub knows.
class HubClient {
  #snapshot: HubSnapshot = { state: emptyState(), status: 'connecting' };
  #listeners = new Set<() => void>();
  #ws: WebSocket | null = null;
  #url: string;
  // Task consoles (outside the shared state: rows reach watchers only).
  #views = new Map<string, TranscriptView>();
  #watchers = new Map<string, number>();
  #viewListeners = new Map<string, Set<() => void>>();

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
      // Reopen the consoles that were open before a reconnect.
      for (const taskId of this.#watchers.keys()) this.send({ type: 'task.watch', taskId });
    };
    ws.onmessage = (message) => {
      const event = decodeEvent(String(message.data));
      if (!event) return;
      if (event.type === 'task.transcript') {
        this.#mergeTranscript(event.taskId, event.entries, event.backfill === true, event.more === true);
        return;
      }
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

  // --- task consoles ---

  #mergeTranscript(taskId: string, entries: TranscriptEntry[], backfill: boolean, more: boolean): void {
    const view = this.#views.get(taskId) ?? EMPTY_VIEW;
    const byId = new Map(view.entries.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      const first = byId.get(entry.id);
      byId.set(entry.id, first ? { ...entry, at: first.at } : entry);
    }
    const merged = [...byId.values()].sort((a, b) => a.at - b.at);
    // The first page, or an older page, says whether anything older remains;
    // live rows and a reconnect's repeat of the latest page don't change it.
    const olderPage = view.loaded && entries.length > 0 && entries[0]!.at < (view.entries[0]?.at ?? Infinity);
    this.#views.set(taskId, {
      entries: merged,
      more: backfill && (!view.loaded || olderPage) ? more : view.more,
      loaded: view.loaded || backfill,
    });
    for (const listener of this.#viewListeners.get(taskId) ?? []) listener();
  }

  watchTask(taskId: string): () => void {
    const count = this.#watchers.get(taskId) ?? 0;
    this.#watchers.set(taskId, count + 1);
    if (count === 0) this.send({ type: 'task.watch', taskId });
    return () => {
      const left = (this.#watchers.get(taskId) ?? 1) - 1;
      if (left > 0) {
        this.#watchers.set(taskId, left);
        return;
      }
      this.#watchers.delete(taskId);
      this.send({ type: 'task.unwatch', taskId });
      this.#views.delete(taskId);
    };
  }

  loadEarlier(taskId: string): void {
    const first = this.#views.get(taskId)?.entries[0];
    if (first) this.send({ type: 'task.watch', taskId, before: first.at });
  }

  subscribeTask = (taskId: string, listener: () => void): (() => void) => {
    let set = this.#viewListeners.get(taskId);
    if (!set) {
      set = new Set();
      this.#viewListeners.set(taskId, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  };

  getTaskView = (taskId: string): TranscriptView => this.#views.get(taskId) ?? EMPTY_VIEW;
}

export const HUB_URL_STORAGE_KEY = 'hq.hubUrl';

export function currentHubUrl(): string {
  try {
    const stored = localStorage.getItem(HUB_URL_STORAGE_KEY);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    /* storage unavailable — use the default */
  }
  return `ws://127.0.0.1:${DEFAULT_HUB_PORT}`;
}

export const hubClient = new HubClient(currentHubUrl());

// A task console's rows; opening subscribes (task.watch), unmounting closes.
export function useTranscript(taskId: string): TranscriptView & { loadEarlier: () => void } {
  useEffect(() => hubClient.watchTask(taskId), [taskId]);
  const view = useSyncExternalStore(
    useCallback((listener: () => void) => hubClient.subscribeTask(taskId, listener), [taskId]),
    () => hubClient.getTaskView(taskId),
  );
  return { ...view, loadEarlier: () => hubClient.loadEarlier(taskId) };
}

export function useHub(): HubSnapshot & { send: (command: ClientCommand) => void } {
  const snapshot = useSyncExternalStore(hubClient.subscribe, hubClient.getSnapshot);
  return { ...snapshot, send: (command) => hubClient.send(command) };
}
