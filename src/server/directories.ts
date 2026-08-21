import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { DirectoryEntry } from "../protocol.js";

export const DIRECTORY_LISTING_BOUND = 500;

export interface ListedChild {
  name: string;
  path: string;
  hidden: boolean;
  directory: boolean;
}

export function absoluteDirectoryPath(path: string | undefined, home: string): string {
  const candidate = path && path.trim() ? path : home;
  if (!isAbsolute(candidate)) throw new RangeError("directory-unreadable");
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

export function selectDirectoryEntries(children: ListedChild[]): { entries: DirectoryEntry[]; truncated: boolean } {
  const directories = children
    .filter((child) => child.directory)
    .sort((left, right) => left.name.localeCompare(right.name));
  const bounded = directories.slice(0, DIRECTORY_LISTING_BOUND);
  return {
    entries: bounded.map(({ name, path, hidden }) => ({ name, path, hidden })),
    truncated: directories.length > DIRECTORY_LISTING_BOUND,
  };
}
