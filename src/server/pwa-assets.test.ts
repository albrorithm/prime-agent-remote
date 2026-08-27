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

  it("uses the Prime butterfly for the app and install icons", async () => {
    const html = await readFile(join(projectRoot, "index.html"), "utf8");
    const logo = await readFile(join(projectRoot, "public/prime-mark.svg"), "utf8");
    const agentsPanel = await readFile(join(projectRoot, "src/web/components/AgentsPanel.tsx"), "utf8");

    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/prime-mark-180.png"');
    expect(logo).toContain('viewBox="0 0 178 178"');
    expect(logo.match(/fill="#ffffff"/g)).toHaveLength(2);
    expect(agentsPanel).toContain('<img src="/prime-mark.svg" alt="" />');
    await expect(pngSize(join(projectRoot, "public/prime-mark-180.png"))).resolves.toEqual({ width: 180, height: 180 });
    await expect(pngSize(join(projectRoot, "public/prime-mark-192.png"))).resolves.toEqual({ width: 192, height: 192 });
    await expect(pngSize(join(projectRoot, "public/prime-mark-512.png"))).resolves.toEqual({ width: 512, height: 512 });
  });

  // The status-bar style meta is read once at launch, so only theme-color can
  // follow a theme change — both stampers have to keep it current.
  it("keeps the iOS status bar on the active theme", async () => {
    const html = await readFile(join(projectRoot, "index.html"), "utf8");
    const themeInit = await readFile(join(projectRoot, "public/theme-init.js"), "utf8");
    const settings = await readFile(join(projectRoot, "src/web/settings.tsx"), "utf8");

    expect(html).toContain('name="theme-color" content="#000000"');
    expect(themeInit).toContain('meta[name="theme-color"]');
    expect(settings).toContain('meta[name="theme-color"]');
    expect(themeInit).toContain('"#fdfcfa"');
    expect(settings).toContain('light: "#fdfcfa"');
  });

  it("lets the installed viewport size the fixed app shell", async () => {
    const html = await readFile(join(projectRoot, "index.html"), "utf8");
    const styles = await readFile(join(projectRoot, "src/web/styles.css"), "utf8");
    const appShell = styles.match(/\.app-shell\s*\{([^}]*)\}/)?.[1] ?? "";
    const body = styles.match(/body\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).not.toContain("viewport-fit=cover");
    /* Absolute rather than fixed, deliberately and load-bearingly: iOS suspends
       `position: fixed` while the keyboard is up, which dragged the whole shell
       down for a beat on every focus. See the comment on `body` in styles.css.
       `inset: 0` on both still makes this the screen. */
    expect(appShell).toContain("position: absolute");
    expect(appShell).toContain("inset: 0");
    expect(body).toContain("position: absolute");
    expect(body).toContain("inset: 0");
    expect(appShell).not.toMatch(/100(?:s|d|l)?vh/);
    expect(body).not.toMatch(/100(?:s|d|l)?vh/);
    // No viewport-fit=cover above means env(safe-area-inset-bottom) is 0 in an
    // installed iOS PWA, so this 28px literal is the whole home-indicator
    // clearance — and --composer-safe-bottom is what is left of it once the
    // keyboard has covered part of the strip.
    expect(styles).toContain(":root { --composer-rest-bottom: max(28px, env(safe-area-inset-bottom, 0px)); }");
    expect(styles).toContain("--composer-safe-bottom: max(0px, calc(var(--composer-rest-bottom) - var(--keyboard-height, 0px)));");
    expect(styles).toContain("padding: 9px 10px max(9px, var(--composer-safe-bottom))");
  });

  it("precaches the built Vite shell without touching unrelated or private caches", async () => {
    const worker = await readFile(join(projectRoot, "public/sw.js"), "utf8");
    expect(worker).toContain('url.pathname.startsWith("/api/")');
    expect(worker).toContain('url.pathname.startsWith("/ws")');
    expect(worker).toContain("matchAll");
    expect(worker).toContain("builtAssets");
    expect(worker).toContain('key.startsWith(CACHE_PREFIX)');
    expect(worker).toContain('caches.match("/")');
    expect(worker).not.toContain("keys.filter((key) => key !== CACHE_NAME)");
  });
});
