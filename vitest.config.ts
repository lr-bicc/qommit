import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { TZ: "UTC" },
    globals: true,
    include: ["tests/**/*.test.{ts,tsx}"],
  },
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
});
