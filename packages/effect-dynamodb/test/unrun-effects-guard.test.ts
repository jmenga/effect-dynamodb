/**
 * Static guard: every test runs the Effect it builds (#243).
 *
 * vitest runs what a test callback returns only when it is a promise. A plain
 * `it("…", () => Effect.gen(…))` returns a lazy Effect that nothing runs, so
 * its assertions never execute and the test always passes. The same holds for
 * an Effect built and dropped, and an `Effect.runPromise` nobody awaits ends
 * after the test does.
 *
 * This test fails when a file under any package's `test` directory
 * (`packages/*\/test`, helpers and fixtures included) does one of those, in a
 * form `helpers/UnrunEffects.ts` recognises; its header lists the forms, and the
 * ones a parse cannot tell. Not scanned: `packages/docs/e2e` (Playwright, no
 * Effect), each package's `examples/` and `bench/`. A `*.types.test.ts` file
 * may build Effects without running them, since it only type-checks them.
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

const imports = `import { beforeEach, describe, expect, it, layer } from "@effect/vitest"
import { test } from "vitest"
import { Effect, Layer, pipe, Stream } from "effect"
`

describe("unrun-effects guard", () => {
  // About 10 MB of test source to parse and resolve: some 4 s alone, more alongside the rest of
  // the suite.
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
it("m", () => (cond ? Effect.void : undefined))
it("n", () => cond && Effect.void)
it("o", () => maybe ?? Effect.void)
it("p", () => (setup(), Effect.void))
it("q", Effect.fn(function* () {}))
it("r", () => Effect.fn(function* () {})())
it("s", () => db.entities.Users.get({ id: "1" }))
it("t", () => Effect["gen"](function* () {}))
beforeEach(() => Effect.sync(() => reset()))
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
        "15 unrun-test-body",
        "16 unrun-test-body",
        "17 unrun-test-body",
        "18 unrun-test-body",
        "19 unrun-test-body",
        "20 unrun-test-body",
        "21 unrun-test-body",
        "22 unrun-test-body",
        "23 unrun-test-body",
      ])
    })

    it("follows local Effects, functions returning one, and functions registering a test", () => {
      const source = `${imports}
const program = Effect.gen(function* () {})
const body = () => Effect.void
const check = (name: string, f: () => unknown) => it(name, f)
it("a", () => program)
it("b", () => pipe(program, withLayer))
it("c", body)
check("d", () => Effect.void)
layer(Layer.empty)("e", (t) => { t("f", () => Effect.void) })
`
      expect(findings(source)).toEqual([
        "8 unrun-test-body",
        "9 unrun-test-body",
        "10 unrun-test-body",
        "11 unrun-test-body",
        "12 unrun-test-body",
      ])
    })

    it("follows imports, aliases, namespace imports and globals", () => {
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
      const namespaces = `import * as Fx from "effect"
import { gen } from "effect/Effect"
import * as V from "vitest"
V.it("a", () => Fx.Effect.gen(function* () {}))
V.test("b", () => gen(function* () {}))
it("c", () => Fx.Stream.make(1))
`
      expect(findings(namespaces)).toEqual([
        "4 unrun-test-body",
        "5 unrun-test-body",
        "6 unrun-test-body",
      ])
    })

    it("finds an Effect built and dropped", () => {
      const source = `${imports}
const check = (n: number) => Effect.sync(() => expect(n).toBe(2))
it.effect("a", () => Effect.gen(function* () {
  Effect.gen(function* () { expect(1).toBe(2) })
  Effect.fail("x")
  void Effect.void
  const program = Effect.void
  program
  program.pipe(withLayer)
  check(1)
  db.entities.Users.put({ id: "1" })
  items.forEach((n) => Effect.sync(() => n))
  items.map((n) => Effect.sync(() => n))
  const unread = Effect.void
  yield* Effect.void
}))
it("b", async () => { await Effect.void })
`
      expect(findings(source)).toEqual([
        "7 dropped-effect",
        "8 dropped-effect",
        "9 dropped-effect",
        "11 dropped-effect",
        "12 dropped-effect",
        "13 dropped-effect",
        "14 dropped-effect",
        "15 dropped-effect",
        "16 dropped-effect",
        "17 dropped-effect",
        "20 dropped-effect",
      ])
    })

    it("finds a run nobody awaits", () => {
      const source = `${imports}
const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)
it("a", () => { Effect.runPromise(Effect.void) })
it("b", () => { Effect.void.pipe(Effect.runPromise) })
it("c", () => { Effect.runPromise(Effect.void).then(() => {}) })
it("d", () => { expect(Effect.runPromise(Effect.void)).resolves.toBe(undefined) })
it("e", () => { Promise.all([Effect.runPromise(Effect.void)]) })
it("f", () => { items.forEach((e) => Effect.runPromise(e)) })
it("g", () => { runtime.runPromise(Effect.void) })
it("h", () => { Effect.runPromiseWith(context)(Effect.void) })
it("i", () => { run(Effect.void) })
it("j", () => { const p = Effect.runPromise(Effect.void) })
it("k", () => { Effect.runFork(Effect.sleep("1 second")) })
`
      expect(findings(source)).toEqual([
        "6 unawaited-run",
        "7 unawaited-run",
        "8 unawaited-run",
        "9 unawaited-run",
        "10 unawaited-run",
        "11 unawaited-run",
        "12 unawaited-run",
        "13 unawaited-run",
        "14 unawaited-run",
        "15 unawaited-run",
        "16 unawaited-run",
      ])
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
it("n", () => Effect.void.pipe(Effect.runSync, () => undefined))
const run = Effect.runPromise
it("o", () => Effect.void.pipe(Effect.provide(Layer.empty), run))
it("p", () => Effect.void.pipe((e) => Effect.runPromise(e)))
it("q", () => Effect.void.pipe(runtime.runPromise))
it("r", () => Effect.void.pipe(Effect.runPromiseWith(context)))
it("s", () => { Effect.void.pipe(Effect.runSyncWith(context)) })
Effect.void.pipe(NodeRuntime.runMain)
it("t", () => Effect.isEffect(value))
const itMaybe = unavailable ? it.skip : it.effect
itMaybe("u", () => Effect.void)
const handle = describe("v", () => {})
handle("w", () => Effect.void)
builders.forEach((it) => { it("x", () => Effect.void) })
function shadowed() { const it = (n: string, f: () => unknown) => f; it("y", () => Effect.void) }
it("z", () => { expect(() => { Effect.succeed(explode()) }).toThrow() })
it("aa", async () => { const fiber = Effect.runFork(Effect.never); Effect.runFork(Effect.void); await Effect.runPromise(Fiber.interrupt(fiber)) })
it.effect("ab", () => Effect.gen(function* () { yield Effect.void }))
it.effect("ac", () => it.flakyTest(Effect.void, "1 second"))
`
      expect(findings(source)).toEqual([])
    })

    it("lets a type-only test build Effects it never runs, unless they assert", () => {
      const source = `${imports}
it("a", () => { Effect.fail("only type-checked") })
it("b", () => Effect.succeed(1).pipe(Effect.map((n) => n)))
it("c", () => Effect.gen(function* () { expect(1).toBe(2) }))
`
      expect(findings(source, "sample.types.test.ts")).toEqual(["7 unrun-test-body"])
      expect(findings(source)).toEqual([
        "5 dropped-effect",
        "6 unrun-test-body",
        "7 unrun-test-body",
      ])
    })
  })
})
