// Pair mode's reviewer verdict — parsed the same way by the hub (to decide
// the next round) and by clients (to show the verdict instead of raw JSON).

export interface PairVerdict {
  agree: boolean;
  blocking: string[];
  minor: string[];
  summary: string;
}

// The reviewer's reply → its verdict: the last JSON object carrying a boolean
// "agree" (prose around it is fine). Null when there is none. "agree" with
// blocking issues listed is not agreement.
export function parseVerdict(text: string): PairVerdict | null {
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
          .map((item) => item.trim().slice(0, 400))
          .slice(0, 8)
      : [];
  // The verdict closes the reply; the tail bounds the (quadratic) scan.
  const raw = jsonObjects(text.slice(-20_000))
    .reverse()
    .find((value): value is Record<string, unknown> => !!value && typeof value === 'object' && typeof (value as { agree?: unknown }).agree === 'boolean');
  if (!raw) return null;
  const blocking = list(raw.blocking);
  const summary = typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 300) : '';
  const agree = raw.agree === true && blocking.length === 0;
  return {
    agree,
    blocking: agree ? [] : blocking.length > 0 ? blocking : [summary || 'The reviewer did not agree but named no specific issue.'],
    minor: list(raw.minor),
    summary: summary || (agree ? 'agreed' : 'not agreed'),
  };
}

// Every balanced {...} in a text that parses as JSON (string-aware), in
// order — a model's reply may wrap its JSON in prose.
export function jsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          found.push(JSON.parse(text.slice(i, j + 1)));
        } catch {
          // not JSON — keep scanning
        }
        break;
      }
    }
  }
  return found;
}
