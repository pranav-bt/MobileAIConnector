import { resolve, sep } from 'node:path';

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Path containment, Windows-friendly (case-insensitive, separator-aware) —
// the check behind project isolation, so "…\CastleWars" never counts as
// inside "…\Castle". A directory is inside itself.
export function isInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const c = resolve(child).toLowerCase();
  const p = resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}
