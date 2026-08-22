import { describe, expect, it } from "vitest";
import {
  absoluteDirectoryPath,
  DIRECTORY_SCAN_BOUND,
  directoryCrumbs,
  selectDirectoryEntries,
  type ListedChild,
} from "./directories.js";

describe("absoluteDirectoryPath", () => {
  it("accepts absolute paths and defaults to home", () => {
    expect(absoluteDirectoryPath("/projects", "/home/dev")).toBe("/projects");
    expect(absoluteDirectoryPath(undefined, "/home/dev")).toBe("/home/dev");
    expect(absoluteDirectoryPath("   ", "/home/dev")).toBe("/home/dev");
  });

  it("rejects relative paths rather than resolving against any base", () => {
    expect(() => absoluteDirectoryPath("projects", "/home/dev")).toThrow(RangeError);
    expect(() => absoluteDirectoryPath("../etc", "/home/dev")).toThrow(RangeError);
  });
});

describe("directoryCrumbs", () => {
  it("builds a root-to-target ancestry chain", () => {
    const crumbs = directoryCrumbs("/home/dev/projects");
    expect(crumbs.map((crumb) => crumb.path)).toEqual(["/", "/home", "/home/dev", "/home/dev/projects"]);
    expect(crumbs[0].name).toBe("/");
    expect(crumbs.at(-1)?.name).toBe("projects");
  });
});

describe("selectDirectoryEntries", () => {
  const children: ListedChild[] = [
    { name: "b", path: "/b", hidden: false, directory: true },
    { name: "a", path: "/a", hidden: false, directory: true },
    { name: ".hidden", path: "/.hidden", hidden: true, directory: true },
    { name: "file.txt", path: "/file.txt", hidden: false, directory: false },
  ];

  it("keeps only directories, name-sorted", () => {
    const { entries } = selectDirectoryEntries(children);
    expect(entries.map((entry) => entry.name)).toEqual([".hidden", "a", "b"]);
  });

  it("reports truncation against the bound", () => {
    const many = Array.from({ length: 600 }, (_, index) => ({
      name: `dir-${String(index).padStart(4, "0")}`,
      path: `/dir-${index}`,
      hidden: false,
      directory: true,
    }));
    const result = selectDirectoryEntries(many);
    expect(result.entries).toHaveLength(500);
    expect(result.truncated).toBe(true);
    expect(result.entries[0].name).toBe("dir-0000");
  });

  it("bounds selection work and carries an adapter scan-truncation signal", () => {
    const many = Array.from({ length: DIRECTORY_SCAN_BOUND + 100 }, (_, index) => ({
      name: `dir-${String(index).padStart(5, "0")}`,
      path: `/dir-${index}`,
      hidden: false,
      directory: index === DIRECTORY_SCAN_BOUND + 99,
    }));
    const result = selectDirectoryEntries(many);
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(selectDirectoryEntries(children, true).truncated).toBe(true);
  });
});
