import type { WorkerInbox } from './types.js';

// The owner's messages for one running worker. Live subscribers (Codex
// steering a turn) get first refusal; otherwise messages queue for next()
// (Claude's input stream) or take() (between Codex turns).
export class MessageInbox implements WorkerInbox {
  #queue: string[] = [];
  #waiters: ((text: string | null) => void)[] = [];
  #subscribers = new Set<(text: string) => boolean>();
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  // False once the run has finished (the caller then continues the task).
  push(text: string): boolean {
    if (this.#closed) return false;
    for (const subscriber of this.#subscribers) if (subscriber(text)) return true;
    const waiter = this.#waiters.shift();
    if (waiter) waiter(text);
    else this.#queue.push(text);
    return true;
  }

  next(): Promise<string | null> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  take(): string[] {
    return this.#queue.splice(0);
  }

  subscribe(handler: (text: string) => boolean): () => void {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  pending(): number {
    return this.#queue.length;
  }

  // Closes for good; returns messages that were never delivered.
  close(): string[] {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(null);
    this.#subscribers.clear();
    return this.#queue.splice(0);
  }
}
