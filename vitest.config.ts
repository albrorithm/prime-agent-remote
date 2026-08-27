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
    coverage: {
      reporter: ["text", "html"],
      // Ratchet against silent coverage decay, not an aspiration: set ~5%
      // below what the suite actually clears (measured via `npx vitest run
      // --coverage` at statements 81%, branches 72%, functions 87%, lines
      // 85%), so normal run-to-run noise doesn't trip CI.
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 80,
        lines: 78,
      },
    },
  },
});
