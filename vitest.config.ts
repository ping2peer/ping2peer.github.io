import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: [fileURLToPath(new URL("./tests/setup.ts", import.meta.url))],
    globals: true
  }
});
