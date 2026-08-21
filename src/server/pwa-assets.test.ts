import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();

async function pngSize(path: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(path);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("PWA assets", () => {
  it("provides a standalone, scoped manifest with installable icons", async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, "public/manifest.webmanifest"), "utf8")) as {
      id?: string;
      scope?: string;
      start_url?: string;
      display?: string;
      background_color?: string;
      theme_color?: string;
      prefer_related_applications?: boolean;
      icons?: Array<{ src: string; sizes: string; purpose?: string }>;
    };
    expect(manifest).toMatchObject({
      id: "/",
      scope: "/",
      start_url: "/",
      display: "standalone",
      background_color: "#000000",
      theme_color: "#000000",
      prefer_related_applications: false,
    });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ sizes: "512x512" }),
    ]));
    for (const icon of manifest.icons ?? []) {
      if (!icon.src.endsWith(".png")) continue;
      await expect(readFile(join(projectRoot, "public", icon.src.replace(/^\//, "")))).resolves.toBeTruthy();
    }
  });

  it("provides Apple standalone metadata and a 180px touch icon", async () => {
    const html = await readFile(join(projectRoot, "index.html"), "utf8");
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="black"');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/prime-mark-180.png"');
    await expect(pngSize(join(projectRoot, "public/prime-mark-180.png"))).resolves.toEqual({ width: 180, height: 180 });
  });

  it("lets the installed viewport size the fixed app shell", async () => {
    const html = await readFile(join(projectRoot, "index.html"), "utf8");
    const styles = await readFile(join(projectRoot, "src/web/styles.css"), "utf8");
    const appShell = styles.match(/\.app-shell\s*\{([^}]*)\}/)?.[1] ?? "";
    const body = styles.match(/body\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).not.toContain("viewport-fit=cover");
    expect(appShell).toContain("position: fixed");
    expect(appShell).toContain("inset: 0");
    expect(appShell).not.toMatch(/100(?:s|d|l)?vh/);
    expect(body).not.toMatch(/100(?:s|d|l)?vh/);
    expect(styles).toContain(".composer { padding-bottom: max(28px, env(safe-area-inset-bottom)); }");
  });

  it("keeps API data out of the offline shell cache", async () => {
    const worker = await readFile(join(projectRoot, "public/sw.js"), "utf8");
    expect(worker).toContain('url.pathname.startsWith("/api/")');
    expect(worker).toContain('url.pathname.startsWith("/ws")');
  });
});
