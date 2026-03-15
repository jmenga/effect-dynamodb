import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/connected.test.ts"],
    testTimeout: 30000,
  },
})
