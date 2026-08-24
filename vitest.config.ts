import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/web/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
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
