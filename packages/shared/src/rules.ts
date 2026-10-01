// RULES.md files, as hub and clients read them — one per team, plus the
// master's. The owner writes them; the hub only appends rules and recorded
// conflict answers. HTML comments are guidance (the template's help text),
// "## " headings group rules, bullets under "## Tools" are the team's tools
// (what to use for which job), and bullets under "## Resolved conflicts" are
// the owner's decisions, each tagged "[<projectId>] …" for its project.

export const RESOLVED_HEADING = 'Resolved conflicts';
export const RULES_HEADING = 'Rules';
export const TOOLS_HEADING = 'Tools';

export interface ParsedRules {
  rules: string[]; // bullets outside Tools/Resolved conflicts ("[Heading] rule" when grouped)
  tools: string[]; // bullets under Tools ("magick: resize and convert images")
  resolutions: string[]; // bullets under Resolved conflicts
}

export function parseRules(markdown: string): ParsedRules {
  const rules: string[] = [];
  const tools: string[] = [];
  const resolutions: string[] = [];
  let section = '';
  for (const raw of markdown.replace(/<!--[\s\S]*?(-->|$)/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{2,6}\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1]!.trim();
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const text = bullet[1]!.trim();
    const key = section.toLowerCase();
    if (key === RESOLVED_HEADING.toLowerCase()) resolutions.push(text);
    else if (key === TOOLS_HEADING.toLowerCase()) tools.push(text);
    else rules.push(section && section !== RULES_HEADING ? `[${section}] ${text}` : text);
  }
  return { rules, tools, resolutions };
}

// The rules that apply to one kind of decision: ungrouped ones plus those
// under a heading containing any of the given words ("stuck" matches
// "## When a task is stuck"). Tags are kept so the reader sees the group.
export function rulesFor(parsed: ParsedRules, sections: string[]): string[] {
  const wanted = sections.map((section) => section.toLowerCase());
  return parsed.rules.filter((rule) => {
    const tag = /^\[([^\]]+)\]/.exec(rule)?.[1]?.toLowerCase();
    return !tag || wanted.some((word) => tag.includes(word));
  });
}

// "magick (ImageMagick CLI): resize…" -> "magick (ImageMagick CLI)".
export function toolName(tool: string): string {
  return (tool.split(/:|\s[—–-]\s/)[0] ?? tool).trim().slice(0, 40);
}
