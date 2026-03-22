/**
 * Type-check validation — verify all example files compile under strict TypeScript.
 */

import { execSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const CORE_DIR = resolve(import.meta.dirname, "../../effect-dynamodb")

describe("Example type-checking", () => {
  it("all examples type-check via tsconfig.examples.json", () => {
    try {
      execSync("npx tsc --noEmit -p tsconfig.examples.json", {
        cwd: CORE_DIR,
        timeout: 120_000,
        stdio: "pipe",
      })
    } catch (err: unknown) {
      const error = err as { stdout?: Buffer; stderr?: Buffer }
      const output = [
        error.stdout?.toString() ?? "",
        error.stderr?.toString() ?? "",
      ].join("\n").trim()
      expect.fail(`Type-check failed:\n${output}`)
    }
  })
})
