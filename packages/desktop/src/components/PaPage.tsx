import { useState } from 'react';
import type { ClientCommand, HubState } from '@agent-hq/shared';
import { parseWhen, WHEN_HELP } from './TopBar';

// The PA tab: everything the desk maintains, readable and editable in place —
// Up next (reminders + custom calendar), Todos, and the shared owner Notes.
// All zero-token: rows come from live pa state; interactions are commands.

const inputStyle: React.CSSProperties = {
  background: 'var(--panel-2)',
  border: '1px solid var(--line-chip)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 12,
  padding: '7px 9px',
  outline: 'none',
};

const smallBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--line-chip)',
  borderRadius: 8,
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: 11,
  padding: '6px 10px',
};

function timeChip(atMs: number): string {
  const at = new Date(atMs);
  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) return `tmrw ${time}`;
  return `${at.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${time}`;
}

function ListCard(props: {
  name: string;
  items: string[];
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const { name, items, send } = props;
  const [text, setText] = useState('');
  const addItem = () => {
    if (!text.trim()) return;
    send({ type: 'pa.list.add', list: name, text: text.trim() });
    setText('');
  };
  return (
    <div className="room">
      <div className="lbl" style={{ textTransform: 'capitalize' }}>{name}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, maxHeight: 260, overflowY: 'auto' }}>
        {items.length === 0 && <span className="empty-note">empty</span>}
        {items.map((item, index) => (
          <div key={index} className="chip" style={{ width: '100%' }}>
            <div className="nm" style={{ flexGrow: 1, minWidth: 0, fontWeight: 500 }}>{item}</div>
            <span
              className="act"
              style={{ cursor: 'pointer', color: 'var(--faint)' }}
              onClick={() => send({ type: 'pa.list.remove', list: name, index })}
            >
              ✕
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <input
          style={{ ...inputStyle, flexGrow: 1 }}
          placeholder="add an item… (Enter)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addItem();
          }}
        />
      </div>
    </div>
  );
}

const dayMs = 24 * 60 * 60 * 1000;
const dayStart = (ms: number): number => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();
const covers = (event: { startMs: number; endMs?: number }, day: number): boolean =>
  event.startMs < day + dayMs && (event.endMs ?? event.startMs) >= day;

// Month grid (Monday-first) + a day panel: spanning events (trips) shade
// every day they cover; clicking a day shows its full agenda.
function MonthCalendar(props: {
  events: { id: string; title: string; startMs: number; endMs?: number }[];
  reminders: { id: string; text: string; atMs: number; firedAt?: number }[];
  send: (command: ClientCommand) => void;
  onPrefill: (isoDay: string) => void;
}): JSX.Element {
  const today = dayStart(Date.now());
  const [monthAnchor, setMonthAnchor] = useState(() => new Date(new Date().setDate(1)).setHours(0, 0, 0, 0));
  const [selected, setSelected] = useState(today);

  const anchor = new Date(monthAnchor);
  const monthLabel = anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const firstCell = (() => {
    const first = new Date(anchor);
    const weekday = (first.getDay() + 6) % 7; // Monday = 0
    return dayStart(first.getTime() - weekday * dayMs);
  })();
  const cells = Array.from({ length: 42 }, (_, index) => dayStart(firstCell + index * dayMs));

  const dayEvents = (day: number) => props.events.filter((event) => covers(event, day));
  const dayReminders = (day: number) => props.reminders.filter((r) => !r.firedAt && r.atMs >= day && r.atMs < day + dayMs);
  const selectedEvents = dayEvents(selected).sort((a, b) => (b.endMs ? 1 : 0) - (a.endMs ? 1 : 0) || a.startMs - b.startMs);
  const selectedReminders = dayReminders(selected).sort((a, b) => a.atMs - b.atMs);
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const shiftMonth = (delta: number) => {
    const next = new Date(monthAnchor);
    next.setMonth(next.getMonth() + delta);
    setMonthAnchor(next.getTime());
  };

  return (
    <div className="room">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="lbl">Calendar</div>
        <div style={{ flexGrow: 1 }} />
        <span style={{ ...smallBtn, padding: '3px 9px' }} onClick={() => shiftMonth(-1)}>‹</span>
        <span className="nm" style={{ fontSize: 12, minWidth: 120, textAlign: 'center' }}>{monthLabel}</span>
        <span style={{ ...smallBtn, padding: '3px 9px' }} onClick={() => shiftMonth(1)}>›</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginTop: 10, alignItems: 'start' }}>
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
              <div key={label} className="act" style={{ color: 'var(--faint)', textAlign: 'center', fontSize: 10 }}>{label}</div>
            ))}
            {cells.map((day) => {
              const inMonth = new Date(day).getMonth() === anchor.getMonth();
              const events = dayEvents(day);
              const spanning = events.filter((e) => e.endMs);
              const isToday = day === today;
              const isSelected = day === selected;
              return (
                <div
                  key={day}
                  onClick={() => setSelected(day)}
                  style={{
                    minHeight: 58,
                    background: spanning.length > 0 ? 'rgba(79,216,196,0.07)' : 'var(--panel-2)',
                    border: `1px solid ${isSelected ? 'var(--accent)' : isToday ? 'rgba(79,216,196,0.45)' : 'var(--line-chip)'}`,
                    borderRadius: 8,
                    padding: '4px 6px',
                    cursor: 'pointer',
                    opacity: inMonth ? 1 : 0.38,
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ display: 'flex', gap: 4, alignItems: 'baseline' }}>
                    <span className="act" style={{ color: isToday ? 'var(--accent)' : 'var(--muted)', fontSize: 10.5, fontWeight: 600 }}>
                      {new Date(day).getDate()}
                    </span>
                    {dayReminders(day).length > 0 && <span style={{ color: 'var(--amber)', fontSize: 9 }}>⏰</span>}
                  </div>
                  {events.slice(0, 2).map((event) => (
                    <div
                      key={event.id}
                      className="act"
                      style={{
                        color: event.endMs ? 'var(--accent)' : 'var(--text-2)',
                        fontSize: 9.5,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {event.endMs ? '↔ ' : ''}{event.title}
                    </div>
                  ))}
                  {events.length > 2 && <div className="act" style={{ color: 'var(--faint)', fontSize: 9 }}>+{events.length - 2} more</div>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Selected-day agenda — where a trip day reads like an itinerary. */}
        <div>
          <div className="nm" style={{ fontSize: 12.5 }}>
            {new Date(selected).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>
            {selectedEvents.length === 0 && selectedReminders.length === 0 && (
              <span className="empty-note">nothing this day</span>
            )}
            {selectedEvents.map((event) => (
              <div key={event.id} className="chip" style={{ width: '100%' }}>
                <span className="tag" style={{ color: 'var(--accent)', whiteSpace: 'nowrap' }}>
                  {event.endMs
                    ? `day ${Math.floor((selected - dayStart(event.startMs)) / dayMs) + 1}/${Math.floor((dayStart(event.endMs) - dayStart(event.startMs)) / dayMs) + 1}`
                    : hhmm(event.startMs)}
                </span>
                <div className="nm" style={{ flexGrow: 1, minWidth: 0, fontWeight: 500 }}>{event.title}</div>
                <span
                  className="act"
                  style={{ cursor: 'pointer', color: 'var(--faint)' }}
                  onClick={() => props.send({ type: 'pa.remove', kind: 'event', id: event.id })}
                >
                  ✕
                </span>
              </div>
            ))}
            {selectedReminders.map((reminder) => (
              <div key={reminder.id} className="chip" style={{ width: '100%' }}>
                <span className="tag" style={{ color: 'var(--amber)' }}>{hhmm(reminder.atMs)} ⏰</span>
                <div className="nm" style={{ flexGrow: 1, minWidth: 0, fontWeight: 500 }}>{reminder.text}</div>
              </div>
            ))}
          </div>
          <button
            style={{ ...smallBtn, marginTop: 8 }}
            onClick={() => props.onPrefill(`${new Date(selected).getFullYear()}-${String(new Date(selected).getMonth() + 1).padStart(2, '0')}-${String(new Date(selected).getDate()).padStart(2, '0')} 09:00`)}
          >
            + add on this day
          </button>
        </div>
      </div>
    </div>
  );
}

export function PaPage(props: { state: HubState; send: (command: ClientCommand) => void }): JSX.Element {
  const { state, send } = props;
  const pa = state.pa;
  const [todoText, setTodoText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [whenText, setWhenText] = useState('');
  const [upcomingText, setUpcomingText] = useState('');
  const [whenError, setWhenError] = useState<string | null>(null);
  const [newListName, setNewListName] = useState('');
  const [newListItem, setNewListItem] = useState('');

  const upcoming = [
    ...pa.reminders.filter((r) => !r.firedAt).map((r) => ({ id: r.id, kind: 'reminder' as const, text: r.text, atMs: r.atMs })),
    ...pa.events.map((e) => ({ id: e.id, kind: 'event' as const, text: e.title, atMs: e.startMs })),
  ].sort((a, b) => a.atMs - b.atMs);
  const fired = pa.reminders.filter((r) => r.firedAt).sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0)).slice(0, 6);
  const openTodos = pa.todos.filter((t) => !t.done).sort((a, b) => b.createdAt - a.createdAt);
  const doneTodos = pa.todos.filter((t) => t.done).slice(-8).reverse();
  const noteLines = pa.notes.split('\n').filter((line) => line.trim() && !line.startsWith('#'));

  const lists = Object.entries(pa.lists).sort(([a], [b]) => a.localeCompare(b));

  const createList = () => {
    if (!newListName.trim() || !newListItem.trim()) return;
    send({ type: 'pa.list.add', list: newListName.trim(), text: newListItem.trim() });
    setNewListName('');
    setNewListItem('');
  };

  const addTimed = (kind: 'reminder' | 'event') => {
    // "2026-09-20 09:00 to 2026-09-27 18:00" makes a multi-day event (a trip).
    const spanMatch = whenText.match(/^(.+?)\s+to\s+(.+)$/i);
    const atMs = parseWhen(spanMatch ? spanMatch[1]! : whenText);
    const endMs = spanMatch ? parseWhen(spanMatch[2]!) : null;
    if (atMs === null || !upcomingText.trim() || (spanMatch && (endMs === null || endMs <= atMs))) {
      setWhenError(`${WHEN_HELP} — a span: "<when> to <when>" (events only)`);
      return;
    }
    setWhenError(null);
    send({ type: 'pa.add', kind, text: upcomingText.trim(), atMs, ...(kind === 'event' && endMs ? { endMs } : {}) });
    setUpcomingText('');
    setWhenText('');
  };

  return (
    <div style={{ padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header: what this is + the master switch */}
      <div className="room" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ flexGrow: 1 }}>
          <div className="lbl">PA Desk</div>
          <div className="act" style={{ color: 'var(--faint)', marginTop: 3 }}>
            todos · reminders · calendar · shared notes — kept as plain files, fired by the hub clock, zero tokens at rest
          </div>
        </div>
        <button
          style={{
            ...smallBtn,
            borderColor: pa.enabled ? 'rgba(79,216,196,0.5)' : 'rgba(232,90,90,0.5)',
            color: pa.enabled ? 'var(--accent)' : 'var(--red)',
            fontWeight: 600,
          }}
          onClick={() => send({ type: 'pa.set', enabled: !pa.enabled })}
          title="The single switch: off = nothing fires or notifies; items hold and fire on re-enable"
        >
          {pa.enabled ? 'ON — click to switch off' : 'OFF — click to switch on'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr 1fr', gap: 14, alignItems: 'start' }}>
        {/* Up next: reminders + custom calendar, merged chronologically */}
        <div className="room">
          <div className="lbl">Up next — reminders & calendar</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, maxHeight: 380, overflowY: 'auto' }}>
            {upcoming.length === 0 && <span className="empty-note">nothing scheduled</span>}
            {upcoming.map((item) => (
              <div key={item.id} className="chip" style={{ width: '100%' }}>
                <span
                  className="tag"
                  style={{ color: item.kind === 'event' ? 'var(--accent)' : 'var(--amber)', whiteSpace: 'nowrap' }}
                >
                  {timeChip(item.atMs)}
                </span>
                <div className="nm" style={{ flexGrow: 1, minWidth: 0, fontWeight: 500 }}>{item.text}</div>
                <span
                  className="act"
                  style={{ cursor: 'pointer', color: 'var(--faint)' }}
                  onClick={() => send({ type: 'pa.remove', kind: item.kind, id: item.id })}
                >
                  ✕
                </span>
              </div>
            ))}
            {fired.length > 0 && (
              <>
                <div className="act" style={{ color: 'var(--faint)', marginTop: 6 }}>recently fired</div>
                {fired.map((reminder) => (
                  <div key={reminder.id} className="chip dim" style={{ width: '100%' }}>
                    <span className="tag">{timeChip(reminder.atMs)}</span>
                    <div className="act" style={{ flexGrow: 1 }}>{reminder.text}</div>
                    <span
                      className="act"
                      style={{ cursor: 'pointer', color: 'var(--faint)' }}
                      onClick={() => send({ type: 'pa.remove', kind: 'reminder', id: reminder.id })}
                    >
                      ✕
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <input
              style={{ ...inputStyle, width: 130 }}
              placeholder="in 20m · 17:30"
              value={whenText}
              onChange={(e) => setWhenText(e.target.value)}
            />
            <input
              style={{ ...inputStyle, flexGrow: 1 }}
              placeholder="what…"
              value={upcomingText}
              onChange={(e) => setUpcomingText(e.target.value)}
            />
            <button style={smallBtn} onClick={() => addTimed('reminder')}>remind</button>
            <button style={smallBtn} onClick={() => addTimed('event')}>event</button>
          </div>
          {whenError && <div className="act" style={{ color: 'var(--amber)', marginTop: 5 }}>{whenError}</div>}
        </div>

        {/* Todos */}
        <div className="room">
          <div className="lbl">Todos</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, maxHeight: 400, overflowY: 'auto' }}>
            {openTodos.length === 0 && <span className="empty-note">nothing open</span>}
            {[...openTodos, ...doneTodos].map((todo) => (
              <div key={todo.id} className={`chip${todo.done ? ' dim' : ''}`} style={{ width: '100%' }}>
                <span
                  style={{ cursor: 'pointer', fontSize: 14, color: todo.done ? 'var(--green)' : 'var(--faint)' }}
                  title={todo.done ? 'reopen' : 'mark done'}
                  onClick={() => send({ type: 'pa.toggle', id: todo.id })}
                >
                  {todo.done ? '☑' : '☐'}
                </span>
                <div
                  className="nm"
                  style={{ flexGrow: 1, minWidth: 0, fontWeight: 500, textDecoration: todo.done ? 'line-through' : 'none' }}
                >
                  {todo.text}
                </div>
                <span
                  className="act"
                  style={{ cursor: 'pointer', color: 'var(--faint)' }}
                  onClick={() => send({ type: 'pa.remove', kind: 'todo', id: todo.id })}
                >
                  ✕
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <input
              style={{ ...inputStyle, flexGrow: 1 }}
              placeholder="add a todo…"
              value={todoText}
              onChange={(e) => setTodoText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && todoText.trim()) {
                  send({ type: 'pa.add', kind: 'todo', text: todoText.trim() });
                  setTodoText('');
                }
              }}
            />
          </div>
        </div>

        {/* Shared notes */}
        <div className="room">
          <div className="lbl">Notes — shared with every team</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10, maxHeight: 400, overflowY: 'auto' }}>
            {noteLines.length === 0 && <span className="empty-note">no notes yet — facts here reach every worker</span>}
            {noteLines.map((line, index) => (
              <div key={index} className="act" style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
                {line.replace(/^\s*-\s*/, '• ')}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <input
              style={{ ...inputStyle, flexGrow: 1 }}
              placeholder="add a note… (Enter)"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && noteText.trim()) {
                  send({ type: 'pa.add', kind: 'note', text: noteText.trim() });
                  setNoteText('');
                }
              }}
            />
          </div>
        </div>
      </div>

      <MonthCalendar
        events={pa.events}
        reminders={pa.reminders}
        send={send}
        onPrefill={(isoDay) => {
          setWhenText(isoDay);
          setWhenError(null);
        }}
      />

      {/* Reference lists: any data/pa/<name>.json array-of-strings file — games, movies, books, etc. */}
      <div className="room">
        <div className="lbl">Lists — reference, not to-dos</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14, marginTop: 10 }}>
          {lists.length === 0 && <span className="empty-note">no reference lists yet</span>}
          {lists.map(([name, items]) => (
            <ListCard key={name} name={name} items={items} send={send} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <input
            style={{ ...inputStyle, width: 160 }}
            placeholder="new list name…"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createList();
            }}
          />
          <input
            style={{ ...inputStyle, flexGrow: 1 }}
            placeholder="first item…"
            value={newListItem}
            onChange={(e) => setNewListItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createList();
            }}
          />
          <button style={smallBtn} onClick={createList}>create</button>
        </div>
      </div>
    </div>
  );
}
