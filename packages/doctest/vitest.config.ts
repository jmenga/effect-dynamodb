import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/runtime.test.ts"],
    testTimeout: 120_000,
  },
})
