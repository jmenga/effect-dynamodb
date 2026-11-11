/**
 * Static guard: every test runs the Effect it builds (#243).
 *
 * vitest runs what a test callback returns only when it is a promise. A plain
 * `it("…", () => Effect.gen(…))` returns a lazy Effect that nothing runs, so
 * its assertions never execute and the test always passes. The same holds for
 * an Effect built as a statement and never yielded, and an `Effect.runPromise`
 * nobody awaits ends after the test does.
 *
 * This test fails when a test file anywhere in the workspace (`packages/*\/test`,
 * helpers and fixtures included) does one of those. The check parses each file
 * (`helpers/UnrunEffects.ts`); a `*.types.test.ts` file may build Effects
 * without running them, since it only type-checks them.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { findUnrunEffects } from "./helpers/UnrunEffects.js"

const packages = fileURLToPath(new URL("../../", import.meta.url))

const testFiles = (): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name)) found.push(path)
    }
  }
  for (const pkg of readdirSync(packages)) {
    const dir = join(packages, pkg, "test")
    try {
      if (statSync(dir).isDirectory()) walk(dir)
    } catch {
      // a package without tests
    }
  }
  return found
}

const findings = (source: string, fileName = "sample.test.ts") =>
  findUnrunEffects(fileName, source).map((finding) => `${finding.line} ${finding.rule}`)

const imports = `import { describe, expect, it, layer } from "@effect/vitest"
import { test } from "vitest"
import { Effect, Layer, pipe, Stream } from "effect"
`

describe("unrun-effects guard", () => {
  // About 10 MB of test source to parse: some 2 s alone, more alongside the rest of the suite.
  it("no test in the workspace builds an Effect it never runs", { timeout: 60_000 }, () => {
    const files = testFiles()
    // Each package's tests are scanned, this one's included.
    expect(files.some((file) => file.endsWith("unrun-effects-guard.test.ts"))).toBe(true)
    expect(files.some((file) => file.includes(join("schema", "test")))).toBe(true)
    const offenders = files.flatMap((file) =>
      findUnrunEffects(file, readFileSync(file, "utf8")).map(
        (finding) =>
          `${relative(packages, file)}:${finding.line} ${finding.rule} in ${finding.test}: ${finding.text}`,
      ),
    )
    expect(offenders).toEqual([])
  })

  describe("the check", () => {
    it("finds an Effect a plain test callback returns", () => {
      const source = `${imports}
it("a", () => Effect.gen(function* () { expect(1).toBe(2) }))
it("b", () => { return Effect.succeed(1).pipe(Effect.map((n) => n)) })
test("c", () => pipe(Effect.succeed(1), Effect.map((n) => n)))
it.each([1])("d %s", (n) => Effect.sync(() => n))
describe.each([1])("e %s", () => { it("f", () => Stream.make(1)) })
it("g", () => Layer.empty)
it("h", () => Effect.void)
it.skip("i", () => Effect.void)
layer(Layer.empty)("j", (it) => { it("k", () => Effect.void) })
it("l", () => entity.put(input).asEffect())
`
      expect(findings(source)).toEqual([
        "5 unrun-test-body",
        "6 unrun-test-body",
        "7 unrun-test-body",
        "8 unrun-test-body",
        "9 unrun-test-body",
        "10 unrun-test-body",
        "11 unrun-test-body",
        "12 unrun-test-body",
        "13 unrun-test-body",
        "14 unrun-test-body",
      ])
    })

    it("follows imports, aliases and namespace imports", () => {
      const source = `import { describe, it as vit } from "vitest"
import * as Fx from "effect/Effect"
vit("a", () => Fx.gen(function* () {}))
const describeConnected = available ? describe : describe.skip
describeConnected("b", () => Fx.void)
const itConnected = available ? vit : vit.skip
itConnected("c", () => Fx.void)
const itLive = vit.live
itLive("d", () => Fx.void)
`
      expect(findings(source)).toEqual([
        "3 unrun-test-body",
        "5 unrun-test-body",
        "7 unrun-test-body",
      ])
    })

    it("finds an Effect built as a statement and never yielded", () => {
      const source = `${imports}
it.effect("a", () => Effect.gen(function* () {
  Effect.gen(function* () { expect(1).toBe(2) })
  Effect.fail("x")
  yield* Effect.void
}))
`
      expect(findings(source)).toEqual(["6 dropped-effect", "7 dropped-effect"])
    })

    it("finds an Effect.runPromise nobody awaits", () => {
      const source = `${imports}
it("a", () => { Effect.runPromise(Effect.void) })
it("b", () => { Effect.void.pipe(Effect.runPromise) })
`
      expect(findings(source)).toEqual(["5 unawaited-run", "6 unawaited-run"])
    })

    it("leaves Effects that run, and the code that only names one", () => {
      const source = `${imports}
it.effect("a", () => Effect.gen(function* () { yield* Effect.void }))
it.scoped("b", () => Effect.void)
it.live("c", () => Effect.void)
it.effect.each([1])("d %s", () => Effect.void)
it("e", async () => { await Effect.runPromise(Effect.void) })
it("f", () => Effect.runPromise(Effect.void))
it("g", () => Effect.void.pipe(Effect.runPromise))
it("h", () => { void Effect.runPromise(Effect.void) })
it("i", () => { const built = Effect.void; expect(Effect.isEffect(built)).toBe(true) })
it("j", () => Effect.runSync(Effect.succeed(1)))
layer(Layer.empty)("k", (it) => { it.effect("l", () => Effect.void) })
const local = (name: string, body: () => unknown) => body
local("m", () => Effect.void)
`
      expect(findings(source)).toEqual([])
    })

    it("lets a type-only test build Effects it never runs", () => {
      const source = `${imports}
it("a", () => { Effect.fail("only type-checked") })
`
      expect(findings(source, "sample.types.test.ts")).toEqual([])
      expect(findings(source)).toEqual(["5 dropped-effect"])
    })
  })
})
