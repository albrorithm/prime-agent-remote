import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Store isolation first: it must be in place before any test file runs.
    setupFiles: ["./src/test/isolate-stores.ts", "./src/web/test/setup.ts"],
    // `scripts/` is included because it holds build steps that can fail
    // silently and ship the result: hash-sw.mjs pins the service worker's
    // BUILD_ID, and when its entry-point check misfired it exited 0 having
    // patched nothing, freezing every installed PWA on its first cached shell.
    // A test file there was previously collected by nothing.
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
});
