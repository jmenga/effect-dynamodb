/**
 * Runtime integration tests — execute example files against DynamoDB Local.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   pnpm --filter @effect-dynamodb/doctest test:connected
 */

import { execSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, it } from "vitest"

const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000"
const EXAMPLES_DIR = resolve(import.meta.dirname, "../../effect-dynamodb/examples")

// Skip all tests if DynamoDB Local is not available
let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}

const describeConnected = dynamoAvailable ? describe : describe.skip

// Discover all example files (exclude _walkthrough.ts which has different structure)
const exampleFiles = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
  .sort()

describeConnected("Example runtime execution", () => {
  for (const file of exampleFiles) {
    it(`examples/${file} runs successfully`, () => {
      const filePath = join(EXAMPLES_DIR, file)
      execSync(`npx tsx ${filePath}`, {
        timeout: 30_000,
        cwd: resolve(EXAMPLES_DIR, ".."),
        stdio: "pipe",
        env: {
          ...process.env,
          DYNAMODB_ENDPOINT: ENDPOINT,
        },
      })
    })
  }
})
