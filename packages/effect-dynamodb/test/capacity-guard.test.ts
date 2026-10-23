/**
 * Static guard for consumed-capacity reporting (#174, design §4.1).
 *
 * Every library request must go through the instrumented client
 * (`Capacity.client`), or its capacity is never asked for nor summed. This
 * test fails when a `src/` file of `effect-dynamodb` or `effect-dynamodb-geo`
 * resolves the raw `DynamoClient` service as a value outside the allowlist:
 * `yield* DynamoClient`, `DynamoClient.asEffect()` / `.use(…)` / `.pipe(…)`,
 * `Effect.service(DynamoClient)`, `Effect.serviceOption(DynamoClient)`,
 * `Effect.map` / `flatMap` / `andThen` / `tap` over it, and
 * `Context.get(ctx, DynamoClient)` and friends. Type positions, imports,
 * comments and static members (`DynamoClient.make`, `DynamoClient.layer`)
 * are fine.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"

const packages = fileURLToPath(new URL("../../", import.meta.url))

const roots = [
  join(packages, "effect-dynamodb", "src"),
  join(packages, "effect-dynamodb-geo", "src"),
]

/** The files that may resolve the raw client (design §4.1). */
const allowlist = new Set([
  "effect-dynamodb/src/internal/Capacity.ts",
  "effect-dynamodb/src/DynamoClient.ts",
  "effect-dynamodb/src/internal/TransactPlan.ts",
  "effect-dynamodb/src/VectorSearchEmulation.ts",
])

const valueUses: ReadonlyArray<RegExp> = [
  /yield\*\s*DynamoClient\b(?!\s*\.)/,
  /\bDynamoClient\s*\.\s*(asEffect|use|pipe)\b/,
  /\bEffect\.(service|serviceOption|map|flatMap|andThen|tap|zip)\(\s*DynamoClient\b/,
  /\bContext\.(get|getOption|getOrUndefined|getUnsafe|unsafeGet)\([^,()]+,\s*DynamoClient\b/,
]

/** Strip comments and string / template contents, keeping line structure. */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, (template) => template.replace(/[^\n]/g, " "))

const offenders = (source: string): Array<{ line: number; text: string }> => {
  const lines = code(source).split("\n")
  const found: Array<{ line: number; text: string }> = []
  lines.forEach((text, index) => {
    if (valueUses.some((pattern) => pattern.test(text))) found.push({ line: index + 1, text })
  })
  return found
}

const files = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : []
  })

describe("consumed-capacity static guard", () => {
  it("recognises every form of a raw client resolution", () => {
    const forms = [
      "const client = yield* DynamoClient",
      "const client = yield* DynamoClient.asEffect()",
      "DynamoClient.use((client) => client.getItem(input))",
      "Effect.service(DynamoClient)",
      "Effect.serviceOption(DynamoClient)",
      "Effect.map(DynamoClient, (client) => client)",
      "Effect.flatMap(DynamoClient, (client) => client.query(input))",
      "Effect.andThen(DynamoClient, (client) => client)",
      "Context.get(ctx, DynamoClient)",
    ]
    for (const form of forms) expect([form, offenders(form).length]).toEqual([form, 1])
    const fine = [
      'import { DynamoClient } from "./DynamoClient.js"',
      "Effect.Effect<A, E, DynamoClient | TableConfig>",
      "const db = yield* DynamoClient.make({ entities })",
      "Layer.provide(DynamoClient.layer({ region }))",
      "// yield* DynamoClient in a comment",
      '"yield* DynamoClient" in a string',
      "const client = yield* Capacity.client",
    ]
    for (const form of fine) expect([form, offenders(form).length]).toEqual([form, 0])
  })

  it("every allowlisted file exists", () => {
    for (const file of allowlist) expect(statSync(join(packages, file)).isFile()).toBe(true)
  })

  it("no src file outside the allowlist resolves the raw DynamoClient", () => {
    const found: Array<string> = []
    let scanned = 0
    for (const root of roots) {
      for (const file of files(root)) {
        scanned++
        const name = relative(packages, file).split("\\").join("/")
        if (allowlist.has(name)) continue
        for (const { line, text } of offenders(readFileSync(file, "utf8"))) {
          found.push(`${name}:${line}: ${text.trim()}`)
        }
      }
    }
    expect(scanned).toBeGreaterThan(30)
    expect(found).toEqual([])
  })
})
