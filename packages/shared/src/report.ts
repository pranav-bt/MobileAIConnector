// The fixed lines a worker ends its report with, so the hub can read the
// outcome without a model call:
//   STATUS: done            |  STATUS: blocked — <what stopped it>
//   HAND-OFFS: none         |  HAND-OFFS: <team>: <what they must do>; …
//   VERDICT: pass           |  VERDICT: issues — <what must be fixed>   (QA reports)
//   LEARNED: none           |  LEARNED: <problem> → <what worked>   (one line per lesson)
// A missing or unreadable line is simply null: the model decides, as before.

export interface ReportLines {
  status: 'done' | 'blocked' | null;
  blocked: string; // why, when blocked
  handoffs: string[] | null; // [] = "none"; null = no line
  verdict: 'pass' | 'issues' | null;
  issues: string; // what QA wants fixed, when the verdict is issues
  learned: string[] | null; // lessons for the team notes; [] = "none"; null = no line
  body: string; // the report without these lines
}

// "STATUS: done", "**Status:** done", "- `VERDICT: pass`", "> Hand-offs: none"
const LINE = /^\s*(?:[-*>]\s+)?[*_`]*\s*(status|hand-?offs?|verdict|learned)\s*[*_`]*\s*:\s*[*_`]*\s*(.*?)\s*[*_`]*\s*$/i;
const DASH = /^[\s—–:-]+/;
const NONE = /^(none|no|nothing|n\/a|-)\.?$/i;

export function parseReportLines(report: string): ReportLines {
  const result: ReportLines = { status: null, blocked: '', handoffs: null, verdict: null, issues: '', learned: null, body: '' };
  const kept: string[] = [];
  for (const line of report.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === 'status') {
      const blocked = /^blocked\b(.*)$/i.exec(value);
      if (/^done\b/i.test(value)) {
        result.status = 'done';
        result.blocked = '';
      } else if (blocked) {
        result.status = 'blocked';
        result.blocked = blocked[1]!.replace(DASH, '').trim() || 'the worker could not finish it';
      } else {
        kept.push(line); // not one of ours
      }
    } else if (key === 'verdict') {
      const issues = /^(?:issues?|fail(?:ed|s|ing)?)\b(.*)$/i.exec(value);
      if (/^pass(?:ed|es)?\b/i.test(value)) {
        result.verdict = 'pass';
        result.issues = '';
      } else if (issues) {
        result.verdict = 'issues';
        result.issues = issues[1]!.replace(DASH, '').trim();
      } else {
        kept.push(line);
      }
    } else if (key === 'learned') {
      // Every LEARNED line adds one lesson; "none" only says there was none.
      result.learned ??= [];
      if (!NONE.test(value) && value) result.learned.push(value);
    } else {
      result.handoffs = NONE.test(value)
        ? []
        : value
            .split(';')
            .map((item) => item.trim())
            .filter(Boolean);
    }
  }
  result.body = kept.join('\n').trim();
  return result;
}
