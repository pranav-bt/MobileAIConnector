import { realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The REAL location of a path, with symlinks and Windows junctions followed —
// otherwise a link planted inside a project workspace reads as "inside" while
// pointing at a sibling project, which is exactly the escape the isolation
// check exists to stop. Parts that don't exist yet (the file a worker is about
// to create) keep their literal names on top of the deepest real ancestor.
export function realPath(path: string): string {
  const full = resolve(path);
  let current = full;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return full; // nothing along the path exists
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

// Containment for two paths that are ALREADY real (see realPath) —
// Windows-friendly: case-insensitive and separator-aware, so "…\CastleWars"
// never counts as inside "…\Castle". A directory contains itself.
export function containsPath(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const p = parent.toLowerCase();
  const c = child.toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

// Path containment — the check behind project isolation. Resolve both sides
// through realPath so a junction can't tunnel out of the workspace.
export function isInside(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  return containsPath(realPath(parent), realPath(child));
}
