// A task's Roblox Studio: the one window its workers may drive. The owner
// names it in the ask ("studio:Pranav2_Workspace", or studio:"My Place" when
// the name has spaces) or picks it in the composer; any other open Studio is
// the owner's own and stays off limits.

const TOKEN = /(^|\s)studio:(?:"([^"]+)"|(\S+))/i;
const PLACE_SUFFIX = /\s*\(placeId:\s*(\d+)\)\s*$/i;

// The studio named in an ask, and the ask without the token.
export function parseStudioToken(text: string): { studio: string | null; text: string } {
  const match = text.match(TOKEN);
  const name = (match?.[2] ?? match?.[3] ?? '').trim();
  if (!match || !name) return { studio: null, text };
  return { studio: name, text: (text.slice(0, match.index) + (match[1] ?? '') + text.slice((match.index ?? 0) + match[0].length)).replace(/\s{2,}/g, ' ').trim() };
}

// StudioMCP lists windows as "<place name> (placeId: <id>)".
export function studioPlace(name: string): { place: string; placeId: string | null } {
  const match = name.match(PLACE_SUFFIX);
  return { place: name.replace(PLACE_SUFFIX, '').trim(), placeId: match?.[1] ?? null };
}

// Which open window the assigned name means: an exact place name (any case),
// the full listed name, or the placeId — else a prefix that fits exactly one
// window. Several fits → 'ambiguous'; none → null.
export function resolveStudio<T extends { name: string }>(assigned: string, studios: T[]): T | 'ambiguous' | null {
  const want = assigned.trim().toLowerCase();
  if (!want) return null;
  const exact = studios.filter((studio) => {
    const { place, placeId } = studioPlace(studio.name);
    return place.toLowerCase() === want || studio.name.trim().toLowerCase() === want || placeId === want;
  });
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return 'ambiguous';
  const prefixed = studios.filter((studio) => studioPlace(studio.name).place.toLowerCase().startsWith(want));
  if (prefixed.length === 1) return prefixed[0]!;
  return prefixed.length > 1 ? 'ambiguous' : null;
}

// Whether a name a command passes (`--studio X`) is the task's Studio, with
// no list at hand: the same place name or placeId, ignoring case and the
// "(placeId: …)" suffix.
export function sameStudio(a: string, b: string): boolean {
  const left = studioPlace(a.trim());
  const right = studioPlace(b.trim());
  if (left.place && left.place.toLowerCase() === right.place.toLowerCase()) return true;
  const idOf = (side: { place: string; placeId: string | null }) => side.placeId ?? (/^\d+$/.test(side.place) ? side.place : null);
  const [ida, idb] = [idOf(left), idOf(right)];
  return !!ida && ida === idb;
}
