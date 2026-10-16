// Pair mode's structured replies (reviewer verdicts, debate exchanges, split
// plans) — parsed the same way by the hub (to decide the next round) and by
// clients (to show them readably instead of raw JSON).

export interface PairVerdict {
  agree: boolean;
  blocking: string[];
  minor: string[];
  summary: string;
}

const strings = (value: unknown, max = 8): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim().slice(0, 400))
        .slice(0, max)
    : [];

// The reviewer's reply → its verdict: the last JSON object carrying a boolean
// "agree" (prose around it is fine). Null when there is none. "agree" with
// blocking issues listed is not agreement.
export function parseVerdict(text: string): PairVerdict | null {
  const raw = lastJsonObject(text, (value) => typeof value['agree'] === 'boolean');
  if (!raw) return null;
  const blocking = strings(raw['blocking']);
  const summary = typeof raw['summary'] === 'string' ? raw['summary'].trim().slice(0, 300) : '';
  const agree = raw['agree'] === true && blocking.length === 0;
  return {
    agree,
    blocking: agree ? [] : blocking.length > 0 ? blocking : [summary || 'The reviewer did not agree but named no specific issue.'],
    minor: strings(raw['minor']),
    summary: summary || (agree ? 'agreed' : 'not agreed'),
  };
}

// A debate exchange: does this side accept the other's draft, what's wrong
// with it, and its own revised draft. Null when the reply has no such JSON.
export interface DebateExchange {
  accept: boolean;
  critique: string[];
  draft: string;
}

export function parseExchange(text: string): DebateExchange | null {
  const raw = lastJsonObject(text, (value) => typeof value['accept'] === 'boolean');
  if (!raw) return null;
  return { accept: raw['accept'] === true, critique: strings(raw['critique']), draft: typeof raw['draft'] === 'string' ? raw['draft'].trim() : '' };
}

// The last JSON object in a model's reply that passes `accept` — the reply
// may wrap it in prose or a code fence. Fast paths first (the whole reply,
// the last fenced block), then candidate "{" positions from the end, at most
// MAX_STARTS of them, so a long reply full of braces stays cheap.
const MAX_STARTS = 400;
export function lastJsonObject(text: string, accept: (value: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  const isWanted = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value) && accept(value as Record<string, unknown>);
  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(candidate);
      return isWanted(value) ? value : null;
    } catch {
      return null;
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const whole = tryParse(trimmed);
    if (whole) return whole;
  }
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const fenced = tryParse((fences[i]![1] ?? '').trim());
    if (fenced) return fenced;
  }
  let starts = 0;
  for (let i = text.lastIndexOf('{'); i !== -1 && starts < MAX_STARTS; i = i > 0 ? text.lastIndexOf('{', i - 1) : -1, starts++) {
    const end = closingBrace(text, i);
    if (end === -1) continue;
    const found = tryParse(text.slice(i, end + 1));
    if (found) return found;
  }
  return null;
}

// Index of the "}" that balances the "{" at `start` (string-aware), or -1.
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return -1;
}
