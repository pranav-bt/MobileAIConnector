// Team RULES.md, as hub and clients read it. The owner writes the file; the
// hub only appends rules and recorded conflict answers. HTML comments are
// guidance (the template's help text), "## " headings group rules, and
// bullets under "## Resolved conflicts" are the owner's decisions, each
// tagged "[<projectId>] …" for the project it applies to.

export const RESOLVED_HEADING = 'Resolved conflicts';
export const RULES_HEADING = 'Rules';

export interface ParsedRules {
  rules: string[]; // bullets outside Resolved conflicts ("[Heading] rule" when grouped)
  resolutions: string[]; // bullets under Resolved conflicts
}

export function parseRules(markdown: string): ParsedRules {
  const rules: string[] = [];
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
    if (section.toLowerCase() === RESOLVED_HEADING.toLowerCase()) resolutions.push(text);
    else rules.push(section && section !== RULES_HEADING ? `[${section}] ${text}` : text);
  }
  return { rules, resolutions };
}
