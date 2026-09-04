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
      /* Read this before trusting it: nothing runs it. No script passes
         --coverage, CI does not either, and no coverage provider is installed,
         so these thresholds have never failed a build and cannot. They are a
         record of what the suite cleared when they were written (statements
         81%, branches 72%, functions 87%, lines 85%, each set ~5% below to
         absorb run-to-run noise), not a gate.

         Making it a gate needs three things, none of them free: add
         @vitest/coverage-v8, add a script that passes --coverage, and add a CI
         step that runs it. Worth doing deliberately or not at all — a
         threshold block that looks like a ratchet and is not is worse than no
         block, because it is read as one. */
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 80,
        lines: 78,
      },
    },
  },
});
