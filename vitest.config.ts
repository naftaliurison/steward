import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@steward/core/testing": path.resolve(__dirname, "packages/core/src/testing.ts"),
      "@steward/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@steward/availability": path.resolve(__dirname, "packages/availability/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
