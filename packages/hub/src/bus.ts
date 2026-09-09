import { EventEmitter } from 'node:events';
import {
  applyEvent,
  emptyState,
  type HubEvent,
  type HubState,
} from '@agent-hq/shared';

// The hub's single source of truth. Every mutation flows through publish()
// as a HubEvent, so persistence, connected clients, and in-memory state can
// never disagree about what happened.
export class HubBus {
  #emitter = new EventEmitter();
  #state: HubState = emptyState();

  get state(): HubState {
    return this.#state;
  }

  publish(event: HubEvent): void {
    this.#state = applyEvent(this.#state, event);
    this.#emitter.emit('event', event);
  }

  onEvent(listener: (event: HubEvent) => void): () => void {
    this.#emitter.on('event', listener);
    return () => this.#emitter.off('event', listener);
  }
}
