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
import { findUnrunEffects, type Rule } from "./helpers/UnrunEffects.js"

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
it("s", () => Effect.void.pipe(Effect.runSync, () => Effect.void))
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
it("b", () => pipe(program, Effect.provide(Layer.empty)))
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
      const source = `${imports}import { DynamoClient } from "effect-dynamodb"
const check = (n: number) => Effect.sync(() => expect(n).toBe(2))
it.effect("a", () => Effect.gen(function* () {
  const db = yield* DynamoClient.make({ entities: {} })
  Effect.gen(function* () { expect(1).toBe(2) })
  Effect.fail("x")
  void Effect.void
  const program = Effect.void
  program
  program.pipe(Effect.asVoid)
  check(1)
  db.entities.Users.put({ id: "1" })
  items.forEach((n) => Effect.sync(() => n))
  items.map((n) => Effect.sync(() => n))
  const unread = Effect.void
  yield* Effect.void
  ;(Effect.void, undefined)
}))
it("b", async () => { await Effect.void })
`
      expect(findings(source)).toEqual([
        "8 dropped-effect",
        "9 dropped-effect",
        "10 dropped-effect",
        "12 dropped-effect",
        "13 dropped-effect",
        "14 dropped-effect",
        "15 dropped-effect",
        "16 dropped-effect",
        "17 dropped-effect",
        "18 dropped-effect",
        "20 dropped-effect",
        "22 dropped-effect",
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
it("l", () => { Promise.all(items.map(() => Effect.runPromise(Effect.void))) })
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
        "17 unawaited-run",
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

  /**
   * Every false positive and miss the reviews of #243 found, under the review's name for it, with
   * the rules reported now: none for a correct test, and none for an inert form the header of
   * `helpers/UnrunEffects.ts` lists as one a parse can't tell. `second` and `third` are the
   * imports each review's cases were written under.
   */
  describe("the reviews' cases", () => {
    const second = `import { beforeAll, beforeEach, describe, expect, it, layer } from "@effect/vitest"
    import { test } from "vitest"
    import { Effect, Exit, Layer, ManagedRuntime, Option, pipe, Stream } from "effect"
    `
    const third = `import { afterAll, beforeAll, beforeEach, describe, expect, it, layer } from "@effect/vitest"
    import { test, vi } from "vitest"
    import { Effect, Exit, Layer, ManagedRuntime, Option, pipe, Stream } from "effect"
    import { runTest, provideAndRun, Helpers, makeProgram } from "./helpers/Imported.js"
    `
    const cases: ReadonlyArray<{
      readonly name: string
      readonly head?: string
      readonly file?: string
      readonly source: string
      readonly want: ReadonlyArray<Rule>
    }> = [
      {
        name: "M05 helper wrapping it",
        head: second,
        source: `const check = (name: string, f: () => unknown) => it(name, f)
    check("x", () => Effect.succeed(1))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M07 conditional return",
        head: second,
        source: `it("x", () => (cond ? Effect.gen(function* () { expect(1).toBe(2) }) : undefined))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M07b && return",
        head: second,
        source: `it("x", () => cond && Effect.gen(function* () { expect(1).toBe(2) }))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M07c ?? return",
        head: second,
        source: `it("x", () => maybe ?? Effect.gen(function* () { expect(1).toBe(2) }))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M07d comma return",
        head: second,
        source: `it("x", () => (setup(), Effect.gen(function* () { expect(1).toBe(2) })))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M08c await of an Effect",
        head: second,
        source: `it("x", async () => { await Effect.gen(function* () { expect(1).toBe(2) }) })`,
        want: ["dropped-effect"],
      },
      {
        name: "M08d const r = await Effect",
        head: second,
        source: `it("x", async () => { const r = await Effect.succeed(1); expect(r).toBe(1) })`,
        want: ["dropped-effect"],
      },
      {
        name: "M10 Effect.runFork un-awaited (statement)",
        head: second,
        source: `it("x", () => { Effect.runFork(Effect.sleep("1 second").pipe(Effect.andThen(Effect.gen(function* () { expect(1).toBe(2) })))) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M11 void Effect.gen",
        head: second,
        source: `it("x", () => { void Effect.gen(function* () { expect(1).toBe(2) }) })`,
        want: ["dropped-effect"],
      },
      {
        name: "M12 expect(runPromise).resolves not awaited",
        head: second,
        source: `it("x", () => { expect(Effect.runPromise(Effect.succeed(1))).resolves.toBe(2) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M13 runPromise().then not returned",
        head: second,
        source: `it("x", () => { Effect.runPromise(Effect.succeed(1)).then((n) => expect(n).toBe(2)) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M13b runPromise().catch not returned",
        head: second,
        source: `it("x", () => { Effect.runPromise(Effect.gen(function* () { expect(1).toBe(2) })).catch(() => {}) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M13c const p = runPromise, never awaited",
        head: second,
        source: `it("x", () => { const p = Effect.runPromise(Effect.gen(function* () { expect(1).toBe(2) })) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M13d Promise.all([runPromise]) not awaited",
        head: second,
        source: `it("x", () => { Promise.all([Effect.runPromise(Effect.gen(function* () { expect(1).toBe(2) }))]) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M13e forEach((e) => Effect.runPromise(e))",
        head: second,
        source: `it("x", () => { [Effect.gen(function* () { expect(1).toBe(2) })].forEach((e) => Effect.runPromise(e)) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M14b local.pipe(localFn) statement",
        head: second,
        source: `it.effect("x", () => Effect.gen(function* () {
      const e = Effect.gen(function* () { expect(1).toBe(2) })
      e.pipe(withLayer)
    }))`,
        want: [],
      },
      {
        name: "M14c local identifier statement",
        head: second,
        source: `it.effect("x", () => Effect.gen(function* () {
      const e = Effect.gen(function* () { expect(1).toBe(2) })
      e
    }))`,
        want: ["dropped-effect"],
      },
      {
        name: "M14d local Effect returned from plain it",
        head: second,
        source: `const program = Effect.gen(function* () { expect(1).toBe(2) })
    it("x", () => program)`,
        want: ["unrun-test-body"],
      },
      {
        name: "M14f assigned in gen, never yielded",
        head: second,
        source: `it.effect("x", () => Effect.gen(function* () {
      const e = Effect.gen(function* () { expect(1).toBe(2) })
    }))`,
        want: ["dropped-effect"],
      },
      {
        name: "M15c pipe(local, localFn) returned from plain it",
        head: second,
        source: `const program = Effect.gen(function* () { expect(1).toBe(2) })
    it("x", () => pipe(program, withLayer))`,
        want: [],
      },
      {
        name: "M16 local helper call not yielded in it.effect",
        head: second,
        source: `const assertRow = (n: number) => Effect.sync(() => expect(n).toBe(2))
    it.effect("x", () => Effect.gen(function* () {
      assertRow(1)
    }))`,
        want: ["dropped-effect"],
      },
      {
        name: "M16b bound builder not yielded",
        head: second,
        source: `it.effect("x", () => Effect.gen(function* () {
      db.entities.Users.put({ id: "1" })
    }))`,
        want: [],
      },
      {
        name: "M16c bound builder returned from plain it",
        head: second,
        source: `it("x", () => db.entities.Users.get({ id: "1" }))`,
        want: [],
      },
      {
        name: "M17 yield without star",
        head: second,
        source: `it.effect("x", () => Effect.gen(function* () {
      yield Effect.fail("x")
    }))`,
        want: [],
      },
      {
        name: "M18b Effect returned from inside gen (not flattened)",
        head: second,
        source: `it.effect("x", () => Effect.gen(function* () {
      yield* Effect.void
      return Effect.gen(function* () { expect(1).toBe(2) })
    }))`,
        want: [],
      },
      {
        name: "M19b Effect in forEach concise callback",
        head: second,
        source: `it.effect("x", () => Effect.gen(function* () {
      [1].forEach((n) => Effect.sync(() => expect(n).toBe(2)))
    }))`,
        want: ["dropped-effect"],
      },
      {
        name: "M19c [..].map(n => Effect) statement",
        head: second,
        source: `it.effect("x", () => Effect.gen(function* () {
      [1].map((n) => Effect.sync(() => expect(n).toBe(2)))
    }))`,
        want: ["dropped-effect"],
      },
      {
        name: "M20c import * as Fx from effect; Fx.Effect.gen",
        head: `import { it } from "vitest"
    import * as Fx from "effect"
    `,
        source: `it("x", () => Fx.Effect.gen(function* () {}))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M20d import { gen } from effect/Effect",
        head: `import { it } from "vitest"
    import { gen, succeed } from "effect/Effect"
    `,
        source: `it("x", () => gen(function* () {}))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M20e import * as V from vitest; V.it",
        head: `import * as V from "vitest"
    import { Effect } from "effect"
    `,
        source: `V.it("x", () => Effect.gen(function* () {}))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M20f it as a vitest global (no import)",
        head: `import { Effect } from "effect"
    `,
        source: `it("x", () => Effect.gen(function* () {}))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M20g import { it } from effect-dynamodb test helper re-export",
        head: `import { it } from "./helpers/vitest.js"
    import { Effect } from "effect"
    `,
        source: `it("x", () => Effect.gen(function* () {}))`,
        want: [],
      },
      {
        name: "M20h import { Effect } from re-exporting module",
        head: `import { it } from "vitest"
    import { Effect } from "./helpers/prelude.js"
    `,
        source: `it("x", () => Effect.gen(function* () {}))`,
        want: [],
      },
      {
        name: "M22 local run alias not awaited",
        head: second,
        source: `const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e)
    it("x", () => { run(Effect.gen(function* () { expect(1).toBe(2) })) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M22b runtime.runPromise not awaited",
        head: second,
        source: `it("x", () => { runtime.runPromise(Effect.gen(function* () { expect(1).toBe(2) })) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M22c Effect.runPromiseWith(ctx)(e) not awaited",
        head: second,
        source: `it("x", () => { Effect.runPromiseWith(ctx)(Effect.gen(function* () { expect(1).toBe(2) })) })`,
        want: ["unawaited-run"],
      },
      {
        name: "M23 beforeEach returning Effect",
        head: second,
        source: `beforeEach(() => Effect.sync(() => { reset() }))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M23b beforeAll returning Effect",
        head: second,
        source: `beforeAll(() => Effect.gen(function* () { expect(1).toBe(2) }))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M24 it(name, Effect.fn(function*))",
        head: second,
        source: `it("x", Effect.fn(function* () { expect(1).toBe(2) }))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M24b it(name, prebuilt body identifier)",
        head: second,
        source: `const body = () => Effect.gen(function* () { expect(1).toBe(2) })
    it("x", body)`,
        want: ["unrun-test-body"],
      },
      {
        name: "M24c Effect.fn(...)() returned",
        head: second,
        source: `it("x", () => Effect.fn(function* () { expect(1).toBe(2) })())`,
        want: ["unrun-test-body"],
      },
      {
        name: "M28 Effect['gen'] element access",
        head: second,
        source: `it("x", () => Effect["gen"](function* () { expect(1).toBe(2) }))`,
        want: ["unrun-test-body"],
      },
      {
        name: "M30c layer()(.., (t) => t(..) returning Effect) — param not named it",
        head: second,
        source: `layer(Layer.empty)("j", (t) => { t("k", () => Effect.gen(function* () { expect(1).toBe(2) })) })`,
        want: ["unrun-test-body"],
      },
      {
        name: "F12b callback parameter named it (not a registrar)",
        head: second,
        source: `const builders = [(name: string, f: () => unknown) => f]
    builders.forEach((it) => { it("x", () => Effect.void) })`,
        want: [],
      },
      {
        name: "F20 pipe ending in a local run alias (returned)",
        head: second,
        source: `const run = Effect.runPromise
    it("x", () => Effect.void.pipe(Effect.provide(TestLayer), run))`,
        want: [],
      },
      {
        name: "F20b pipe ending in arrow that runs (returned)",
        head: second,
        source: `it("x", () => Effect.void.pipe(Effect.provide(TestLayer), (e) => Effect.runPromise(e)))`,
        want: [],
      },
      {
        name: "F20c pipe ending in runtime.runPromise (returned)",
        head: second,
        source: `it("x", () => Effect.void.pipe(runtime.runPromise))`,
        want: [],
      },
      {
        name: "F20d pipe ending in Effect.runPromiseWith(ctx) (returned)",
        head: second,
        source: `it("x", () => Effect.void.pipe(Effect.runPromiseWith(ctx)))`,
        want: [],
      },
      {
        name: "F20j pipe ending in Effect.runSyncWith(ctx) as a statement",
        head: second,
        source: `it("x", () => { Effect.sync(() => expect(1).toBe(1)).pipe(Effect.runSyncWith(ctx)) })`,
        want: [],
      },
      {
        name: "F20k pipe ending in NodeRuntime.runMain at module scope (script in test dir)",
        head: second,
        source: `program.pipe(Effect.provide(TestLayer), NodeRuntime.runMain)`,
        want: [],
      },
      {
        name: "F23 Effect.isEffect returned (a boolean)",
        head: second,
        source: `it("x", () => Effect.isEffect(value))`,
        want: [],
      },
      {
        name: "F29 types file: concise arrow type-only test returning an Effect",
        head: second,
        file: "sample.types.test.ts",
        source: `it("x", () => Effect.succeed(1).pipe(Effect.map((n) => n)))`,
        want: [],
      },
      {
        name: "F33b conditional alias whose TRUE branch is plain it.skip, false branch it.effect",
        head: second,
        source: `const itMaybe = unavailable ? it.skip : it.effect
    itMaybe("x", () => Effect.void)`,
        want: [],
      },
      {
        name: "F34 a variable holding describe()'s result is not a registrar",
        head: second,
        source: `const handle = describe("x", () => {})
    handle("y", () => Effect.void)`,
        want: [],
      },
      {
        name: "F35 shadowed local named like an alias",
        head: second,
        source: `const run = it.skip
    function other() { const run = (n: string, f: () => unknown) => f; run("x", () => Effect.void) }`,
        want: [],
      },
      {
        name: "F36 Layer statement inside expect().toThrow callback",
        head: second,
        source: `it("x", () => { expect(() => { Layer.succeed(Tag, bad()) }).toThrow() })`,
        want: [],
      },
      {
        name: "F37 Effect built as statement to assert construction throws",
        head: second,
        source: `it("x", () => { expect(() => { Effect.succeed(explode()) }).toThrow() })`,
        want: [],
      },
      {
        name: "C01 pipe through an IMPORTED runner, returned",
        source: `it("x", () => Effect.gen(function* () { expect(1).toBe(2) }).pipe(Effect.provide(Layer.empty), runTest))`,
        want: [],
      },
      {
        name: "C02 pipe through an IMPORTED runner, awaited",
        source: `it("x", async () => { await Effect.gen(function* () { expect(1).toBe(2) }).pipe(provideAndRun) })`,
        want: [],
      },
      {
        name: "C03 pipe through imported namespace member `Helpers.run`",
        source: `it("x", () => Effect.gen(function* () { expect(1).toBe(2) }).pipe(Helpers.run))`,
        want: [],
      },
      {
        name: "C04 local async runner (await inside), piped",
        source: `const run = async <A>(e: Effect.Effect<A>) => await Effect.runPromise(e)
    it("x", () => Effect.gen(function* () { expect(1).toBe(2) }).pipe(run))`,
        want: [],
      },
      {
        name: "C05 local runner returning run(...).then(...), piped",
        source: `const run = <A>(e: Effect.Effect<A>) => Effect.runPromise(e).then((a) => a)
    it("x", () => Effect.gen(function* () { expect(1).toBe(2) }).pipe(run))`,
        want: [],
      },
      {
        name: "C06 local async runner with exit variable, piped + awaited",
        source: `const run = async <A>(e: Effect.Effect<A>) => { const exit = await Effect.runPromiseExit(e); return exit }
    it("x", async () => { const exit = await Effect.gen(function* () { expect(1).toBe(2) }).pipe(run); expect(Exit.isFailure(exit)).toBe(true) })`,
        want: [],
      },
      {
        name: "C07 local async function declaration runner, piped",
        source: `async function run<A>(e: Effect.Effect<A>) { return await Effect.runPromise(e) }
    it("x", () => pipe(Effect.gen(function* () { expect(1).toBe(2) }), run))`,
        want: [],
      },
      {
        name: "C09 x.entities.forEach(...) on a plain object",
        source: `it("x", () => { registry.entities.forEach((e: unknown) => { seen.push(e) }); expect(seen.length).toBe(1) })`,
        want: [],
      },
      {
        name: "C10 x.entities.push / collections.set / aggregates.clear statements",
        source: `it("x", () => { state.entities.push(1); cache.collections.set("a", 1); cache.aggregates.clear(); expect(state.entities.length).toBe(1) })`,
        want: [],
      },
      {
        name: "C11 await other.collections.list() (a real promise)",
        source: `it("x", async () => { const all = await vectorDb.collections.list(); expect(all).toEqual([]) })`,
        want: [],
      },
      {
        name: "C13b pipe(value, Effect.isEffect) returned",
        source: `it("x", () => pipe(value, Effect.isEffect))`,
        want: [],
      },
      {
        name: "C61 `run` property on an object literal",
        source: `const h = { run: <A>(e: Effect.Effect<A>) => Effect.runPromise(e) }
    it("x", () => Effect.gen(function* () { expect(1).toBe(2) }).pipe(h.run))`,
        want: [],
      },
      {
        name: "I04 assigned to let and dropped",
        source: `it("x", () => { let e = Effect.gen(function* () { expect(1).toBe(2) }) })`,
        want: [],
      },
      {
        name: "I06 forEach callback by name (local builder)",
        source: `const check = (n: number) => Effect.sync(() => expect(n).toBe(2))
    it("x", () => { [1].forEach(check) })`,
        want: [],
      },
      {
        name: "I12 passed to a local function that ignores it",
        source: `const ignore = (_e: unknown) => undefined
    it("x", () => { ignore(Effect.gen(function* () { expect(1).toBe(2) })) })`,
        want: [],
      },
      {
        name: "I22 void Effect.runPromise",
        source: `it("x", async () => { void Effect.runPromise(Effect.gen(function* () { expect(1).toBe(2) })) })`,
        want: [],
      },
      {
        name: "I24 Promise.all(xs.map(run)) statement",
        source: `it("x", async () => { Promise.all([1].map(() => Effect.runPromise(Effect.gen(function* () { expect(1).toBe(2) })))) })`,
        want: ["unawaited-run"],
      },
      {
        name: "I32 forEach async callback awaiting a run",
        source: `it("x", () => { [1].forEach(async () => { await Effect.runPromise(Effect.gen(function* () { expect(1).toBe(2) })) }) })`,
        want: [],
      },
      {
        name: "I34 map result kept in unread const",
        source: `it("x", () => { const all = [1].map(() => Effect.gen(function* () { expect(1).toBe(2) })) })`,
        want: [],
      },
      {
        name: "I37 it['skip'] element access",
        source: `it["skip"]("x", () => Effect.gen(function* () { expect(1).toBe(2) }))`,
        want: [],
      },
      {
        name: "I45 wrapper with destructured parameter",
        source: `const check = ({ name, f }: { name: string; f: () => unknown }) => it(name, f)
    check({ name: "x", f: () => Effect.gen(function* () { expect(1).toBe(2) }) })`,
        want: [],
      },
      {
        name: "I46 wrapper of a wrapper",
        source: `const check = (name: string, f: () => unknown) => it(name, f)
    const check2 = (name: string, f: () => unknown) => check(name, f)
    check2("x", () => Effect.gen(function* () { expect(1).toBe(2) }))`,
        want: [],
      },
      {
        name: "I53 destructured entities",
        source: `it("x", () => { const { entities } = db; entities.Users.put({ id: "1" }) })`,
        want: [],
      },
      {
        name: "I58 const { gen } = Effect",
        source: `const { gen } = Effect
    it("x", () => gen(function* () { expect(1).toBe(2) }))`,
        want: [],
      },
      {
        name: "I63 Effect returned with explicit return type via imported helper",
        source: `it("x", (): Effect.Effect<void> => makeProgram())`,
        want: [],
      },
      {
        name: "I64 Promise.resolve().then(() => Effect)",
        source: `it("x", () => Promise.resolve().then(() => Effect.gen(function* () { expect(1).toBe(2) })))`,
        want: [],
      },
      {
        name: "I65 Effect in setTimeout callback",
        source: `it("x", () => { setTimeout(() => Effect.gen(function* () { expect(1).toBe(2) }), 0) })`,
        want: [],
      },
      {
        name: "I66 assignment to outer let, never read",
        source: `let kept: unknown
    it("x", () => { kept = Effect.gen(function* () { expect(1).toBe(2) }) })`,
        want: [],
      },
      {
        name: "blockRunner: a runner with a block body, piped",
        source: `const run = (e) => { Effect.runSync(e) }; it('valid', () => Effect.sync(() => expect(1).toBe(1)).pipe(run))`,
        want: [],
      },
      {
        name: "localNoReturnRunner: a function declaration runner, piped",
        source: `function run(e) { Effect.runSync(e) }; it('valid', () => Effect.sync(() => expect(1).toBe(1)).pipe(run))`,
        want: [],
      },
      {
        name: "predicatePipe: a pipe ending in Effect.isEffect",
        source: `it('valid', () => Effect.void.pipe(Effect.isEffect))`,
        want: [],
      },
      {
        name: "syncCallback: a run in a block body",
        source: `it('valid', () => { Effect.runSync(Effect.gen(function*(){ yield* Effect.sync(() => expect(1).toBe(1)) })) })`,
        want: [],
      },
      {
        name: "postRunnerEffect: an Effect after a runner in a pipe",
        source: `it('inert', () => Effect.void.pipe(Effect.runSync, () => Effect.sync(() => expect(1).toBe(2))))`,
        want: ["unrun-test-body"],
      },
      {
        name: "discardedLeftComma: an Effect on the left of a comma, dropped",
        source: `it('inert', () => { (Effect.sync(() => expect(1).toBe(2)), undefined) })`,
        want: ["dropped-effect"],
      },
      {
        name: "returnedLeftComma: an Effect on the left of a comma, returned",
        source: `it('inert', () => (Effect.sync(() => expect(1).toBe(2)), undefined))`,
        want: ["dropped-effect"],
      },
      {
        name: "voidRun: void on a run",
        source: `it('inert', () => { void Effect.runPromise(Effect.sleep('1 second')) })`,
        want: [],
      },
      {
        name: "ignoredArgument: an Effect passed to a function that ignores it",
        source: `const ignore = (e) => {}; it('inert', () => ignore(Effect.sync(() => expect(1).toBe(2))))`,
        want: [],
      },
      {
        name: "localPromiseCallback: a forEach callback awaiting a run",
        source: `it('inert', () => { [1].forEach(async () => { await Effect.runPromise(Effect.sync(() => expect(1).toBe(2))) }) })`,
        want: [],
      },
      {
        name: "I50 typed client op dropped, no client bound in the file",
        source: `it.effect("x", () => Effect.gen(function* () { db.entities.Users.put({ id: "1" }) }))`,
        want: [],
      },
      {
        name: "I51 typed client chain returned from plain it, no client bound in the file",
        source: `it("x", () => db.entities.Tasks.byProject({ project: "a" }).filter({ a: 1 }).collect())`,
        want: [],
      },
      {
        name: "I52 collections / aggregates op dropped, no client bound in the file",
        source: `it("x", () => { db.collections.assignments({ e: "a" }).collect(); db.aggregates.Order.get({ id: "1" }) })`,
        want: [],
      },
      {
        name: "I50 typed client op dropped, the client bound by yield* DynamoClient.make",
        source: `import { DynamoClient } from "effect-dynamodb"
    it.effect("x", () => Effect.gen(function* () { const db = yield* DynamoClient.make({ entities: {} }); db.entities.Users.put({ id: "1" }) }))`,
        want: ["dropped-effect"],
      },
      {
        name: "I52 collections / aggregates op dropped, the client bound by yield* DynamoClient.make",
        source: `import { DynamoClient } from "effect-dynamodb"
    it.effect("x", () => Effect.gen(function* () { const db = yield* DynamoClient.make({ entities: {} }); db.collections.assignments({ e: "a" }).collect(); db.aggregates.Order.get({ id: "1" }) }))`,
        want: ["dropped-effect", "dropped-effect"],
      },
      {
        name: "R4a registrar chosen by a conditional with a branch that runs the Effect: not reported",
        source: `const t = true ? it : it.effect
    t("x", () => Effect.sync(() => expect(1).toBe(2)))`,
        want: [],
      },
      {
        name: "R4b registrar chosen by a conditional called in place: not reported",
        source: `;(cond ? it : it.skip)("x", () => Effect.sync(() => expect(1).toBe(2)))`,
        want: [],
      },
      {
        name: "R4c a local function running one Effect and returning another: read as a runner",
        source: `const build = (e: Effect.Effect<void>) => { Effect.runSync(e); return Effect.sync(() => expect(1).toBe(2)) }
    it("x", () => Effect.void.pipe(build))`,
        want: [],
      },
      {
        name: "R4d a returned Effect member that isn't an Effect: may be reported",
        source: `it("x", () => Effect.map((n: number) => n + 1))
    it("y", () => Effect.TypeId)`,
        want: ["unrun-test-body", "unrun-test-body"],
      },
    ]
    for (const { name, head = third, file = "sample.test.ts", source, want } of cases) {
      it(name, () => {
        expect(findUnrunEffects(file, `${head}${source}\n`).map((finding) => finding.rule)).toEqual(
          want,
        )
      })
    }
  })
})
