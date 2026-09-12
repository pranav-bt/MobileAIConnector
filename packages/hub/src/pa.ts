import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaState } from '@agent-hq/shared';
import type { HubBus } from './bus.js';

// The PA desk: the deterministic half of the Personal Assistant. Plain-data
// stores (todos, reminders, a custom calendar, shared owner notes) plus a
// clock that fires reminders and event alerts to the phone — ZERO tokens at
// rest. PA workers edit the same files when a task needs judgment; every
// other team is told where the shared notes live.
//
// Reference lists (games to play, movies, books, …) are any other
// data/pa/<name>.json file holding a plain string array — no schema
// registration needed. Drop one in and it appears in the PA tab as its own
// list; PA workers create these directly when the owner asks to track a
// reference list that isn't a to-do.
//
// One switch gates all of it: pa.set / "/pa off". While off, nothing fires
// and nothing is written by the clock; pending items are kept and fire after
// re-enable. The stores stay editable either way.

const CORE_FILES = new Set(['todos.json', 'reminders.json', 'calendar.json']);

interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}
interface Reminder {
  id: string;
  text: string;
  atMs: number;
  firedAt?: number;
}
interface CalEvent {
  id: string;
  title: string;
  startMs: number;
  remindedAt?: number;
}

const EVENT_REMIND_BEFORE_MS = 15 * 60_000;
const KEEP_FIRED_MS = 7 * 24 * 60 * 60_000;

const newId = () => `pa-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

export class PaDesk {
  #bus: HubBus;
  #dir: string;
  #outboxDir: string;
  #enabled: boolean;
  #persistEnabled: (enabled: boolean) => void;
  #intervalMs: number;
  #interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    bus: HubBus,
    dataDir: string,
    outboxDir: string,
    options: { enabled: boolean; persistEnabled: (enabled: boolean) => void; intervalMs?: number },
  ) {
    this.#bus = bus;
    this.#dir = join(dataDir, 'pa');
    this.#outboxDir = outboxDir;
    this.#enabled = options.enabled;
    this.#persistEnabled = options.persistEnabled;
    this.#intervalMs = options.intervalMs ?? 30_000;
    mkdirSync(this.#dir, { recursive: true });
    for (const file of ['todos.json', 'reminders.json', 'calendar.json']) {
      const path = join(this.#dir, file);
      if (!existsSync(path)) writeFileSync(path, '[]\n');
    }
    const notes = join(this.#dir, 'notes.md');
    if (!existsSync(notes)) writeFileSync(notes, '# Owner notes — shared facts & preferences\n');
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get paths(): { dir: string; todos: string; reminders: string; calendar: string; notes: string } {
    return {
      dir: this.#dir,
      todos: join(this.#dir, 'todos.json'),
      reminders: join(this.#dir, 'reminders.json'),
      calendar: join(this.#dir, 'calendar.json'),
      notes: join(this.#dir, 'notes.md'),
    };
  }

  #lastPublished = '';

  // Mirror the stores into client state (both apps render the PA tab from
  // this). Published on every change — including PA-worker file edits, which
  // the clock notices within one tick.
  #publishState(): void {
    const pa: PaState = {
      enabled: this.#enabled,
      todos: this.#read('todos.json', []),
      reminders: this.#read('reminders.json', []),
      events: this.#read('calendar.json', []),
      notes: (() => {
        try {
          return readFileSync(join(this.#dir, 'notes.md'), 'utf8').slice(0, 8000);
        } catch {
          return '';
        }
      })(),
      lists: Object.fromEntries(this.#listNames().map((name) => [name, this.#readList(name)])),
    };
    const serialized = JSON.stringify(pa);
    if (serialized === this.#lastPublished) return;
    this.#lastPublished = serialized;
    this.#bus.publish({ type: 'pa.updated', pa });
  }

  start(): void {
    this.#publishState();
    this.#interval = setInterval(() => this.#tick(), this.#intervalMs);
  }

  stop(): void {
    if (this.#interval) clearInterval(this.#interval);
  }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    this.#persistEnabled(enabled);
    this.#activity(
      enabled
        ? 'PA desk switched ON — reminders and event alerts will fire (missed ones fire now)'
        : 'PA desk switched OFF — nothing will fire or notify until "/pa on"',
    );
    this.#publishState();
  }

  toggleTodo(id: string): void {
    const todos = this.#read<Todo[]>('todos.json', []);
    const todo = todos.find((t) => t.id === id);
    if (!todo) return;
    todo.done = !todo.done;
    this.#write('todos.json', todos);
    this.#activity(`todo ${todo.done ? 'done' : 'reopened'}: ${todo.text.slice(0, 50)}`);
    this.#publishState();
  }

  remove(kind: 'todo' | 'reminder' | 'event', id: string): void {
    const file = kind === 'todo' ? 'todos.json' : kind === 'reminder' ? 'reminders.json' : 'calendar.json';
    const items = this.#read<{ id: string; text?: string; title?: string }[]>(file, []);
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    this.#write(file, items.filter((entry) => entry.id !== id));
    this.#activity(`${kind} removed: ${(item.text ?? item.title ?? '').slice(0, 50)}`);
    this.#publishState();
  }

  add(kind: 'todo' | 'reminder' | 'event' | 'note', text: string, atMs?: number): void {
    const clean = text.trim();
    if (!clean) return;
    if (kind === 'todo') {
      const todos = this.#read<Todo[]>('todos.json', []);
      todos.push({ id: newId(), text: clean, done: false, createdAt: Date.now() });
      this.#write('todos.json', todos);
      this.#activity(`todo added: ${clean.slice(0, 60)}`);
      this.#publishState();
      return;
    }
    if (kind === 'note') {
      appendFileSync(join(this.#dir, 'notes.md'), `- ${new Date().toISOString().slice(0, 10)}: ${clean}\n`);
      this.#activity(`noted: ${clean.slice(0, 60)}`);
      this.#publishState();
      return;
    }
    if (!atMs || !Number.isFinite(atMs) || atMs < Date.now() - 60_000) {
      this.#activity(`${kind} needs a valid future time — nothing was saved`);
      return;
    }
    const when = new Date(atMs).toLocaleString('en-GB', { hour12: false }).slice(0, 17);
    if (kind === 'reminder') {
      const reminders = this.#read<Reminder[]>('reminders.json', []);
      reminders.push({ id: newId(), text: clean, atMs });
      this.#write('reminders.json', reminders);
      this.#activity(`reminder set for ${when}: ${clean.slice(0, 50)}`);
    } else {
      const events = this.#read<CalEvent[]>('calendar.json', []);
      events.push({ id: newId(), title: clean, startMs: atMs });
      this.#write('calendar.json', events);
      this.#activity(`event added ${when}: ${clean.slice(0, 50)}`);
    }
    this.#publishState();
  }

  listAdd(list: string, text: string): void {
    const name = this.#sanitizeListName(list);
    const clean = text.trim();
    if (!name || !clean) return;
    const items = this.#readList(name);
    items.push(clean);
    this.#write(`${name}.json`, items);
    this.#activity(`${name} list: added "${clean.slice(0, 50)}"`);
    this.#publishState();
  }

  listRemove(list: string, index: number): void {
    const name = this.#sanitizeListName(list);
    if (!name) return;
    const items = this.#readList(name);
    if (index < 0 || index >= items.length) return;
    const [removed] = items.splice(index, 1);
    this.#write(`${name}.json`, items);
    this.#activity(`${name} list: removed "${(removed ?? '').slice(0, 50)}"`);
    this.#publishState();
  }

  #tick(): void {
    if (!this.#enabled) return;
    try {
      const now = Date.now();

      const reminders = this.#read<Reminder[]>('reminders.json', []);
      let dirty = false;
      for (const reminder of reminders) {
        if (reminder.firedAt || reminder.atMs > now) continue;
        reminder.firedAt = now;
        dirty = true;
        this.#notify('Reminder', reminder.text);
      }
      const keptReminders = reminders.filter((r) => !r.firedAt || now - r.firedAt < KEEP_FIRED_MS);
      if (dirty || keptReminders.length !== reminders.length) this.#write('reminders.json', keptReminders);

      const events = this.#read<CalEvent[]>('calendar.json', []);
      let eventsDirty = false;
      for (const event of events) {
        if (event.remindedAt || now < event.startMs - EVENT_REMIND_BEFORE_MS) continue;
        event.remindedAt = now;
        eventsDirty = true;
        const minutes = Math.max(0, Math.round((event.startMs - now) / 60_000));
        this.#notify(minutes > 0 ? `In ${minutes} min` : 'Now', event.title);
      }
      const keptEvents = events.filter((e) => !e.remindedAt || now - e.startMs < KEEP_FIRED_MS);
      if (eventsDirty || keptEvents.length !== events.length) this.#write('calendar.json', keptEvents);

      // Catches PA-worker edits to the files too (change-detected inside).
      this.#publishState();
    } catch {
      /* a bad tick never kills the clock; next one retries */
    }
  }

  // A notice = activity line (desktop Today feed) + a small file through the
  // outbox, which reaches the phone as a real notification and is readable
  // in place. No model call anywhere on this path.
  #notify(title: string, body: string): void {
    this.#activity(`${title}: ${body}`);
    try {
      const slug = body.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'notice';
      writeFileSync(
        join(this.#outboxDir, `PA ${title} - ${slug}.md`),
        `# ${title}\n\n${body}\n\n_${new Date().toLocaleString('en-GB', { hour12: false })}_\n`,
      );
    } catch {
      /* phone push is best-effort; the activity line stands */
    }
  }

  #activity(message: string): void {
    const paLead = this.#bus.state.agents['personal-assistant-team-lead'] ? 'personal-assistant-team-lead' : 'master';
    this.#bus.publish({ type: 'activity', entry: { agentId: paLead, taskId: null, message, at: Date.now() } });
  }

  #read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.#dir, file), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  #write(file: string, value: unknown): void {
    writeFileSync(join(this.#dir, file), JSON.stringify(value, null, 2) + '\n');
  }

  // Every *.json file in the PA dir besides the three core stores is a
  // reference list, named by its filename.
  #listNames(): string[] {
    try {
      return readdirSync(this.#dir)
        .filter((f) => f.endsWith('.json') && !CORE_FILES.has(f))
        .map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  #readList(name: string): string[] {
    const raw = this.#read<unknown>(`${name}.json`, []);
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
  }

  // Filesystem-safe slug so a list name can never escape the PA dir.
  #sanitizeListName(name: string): string | null {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return slug && !CORE_FILES.has(`${slug}.json`) ? slug : null;
  }
}
