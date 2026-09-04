import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { DirectoryEntry } from "../protocol.js";

export const DIRECTORY_LISTING_BOUND = 500;
// Filesystem adapters should stop after this many directory entries and pass
// scanTruncated=true to selectDirectoryEntries. The extra bound also keeps
// filtering and sorting bounded if an adapter supplies an unexpectedly large array.
export const DIRECTORY_SCAN_BOUND = 2_000;

export interface ListedChild {
  name: string;
  path: string;
  hidden: boolean;
  directory: boolean;
}

/** A directory path the listing refuses to resolve: relative, so it would need a base the browser never gets to pick. */
export class DirectoryPathError extends Error {}

export function absoluteDirectoryPath(path: string | undefined, home: string): string {
  const candidate = path && path.trim() ? path : home;
  if (!isAbsolute(candidate)) throw new DirectoryPathError("Directory path must be absolute");
  return resolve(candidate);
}

export function directoryCrumbs(target: string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = [];
  let current = resolve(target);
  for (;;) {
    const parent = dirname(current);
    crumbs.unshift({
      name: parent === current ? current : basename(current),
      path: current,
      hidden: false,
    });
    if (parent === current) return crumbs;
    current = parent;
  }
}

export function selectDirectoryEntries(
  children: ListedChild[],
  scanTruncated = false,
): { entries: DirectoryEntry[]; truncated: boolean } {
  const boundedChildren = children.slice(0, DIRECTORY_SCAN_BOUND);
  const directories = boundedChildren
    .filter((child) => child.directory)
    .sort((left, right) => left.name.localeCompare(right.name));
  const bounded = directories.slice(0, DIRECTORY_LISTING_BOUND);
  return {
    entries: bounded.map(({ name, path, hidden }) => ({ name, path, hidden })),
    truncated: scanTruncated
      || children.length > DIRECTORY_SCAN_BOUND
      || directories.length > DIRECTORY_LISTING_BOUND,
  };
}
