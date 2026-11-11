/**
 * A look-alike read back as its instance writes back what was stored.
 *
 * An instance can hold more than its type's fields (`Object.assign(duration, { source })`), and the
 * marshaller stores every enumerable property it has, so published 1.39.0, which read the stored
 * map back as it was, wrote that map again on the next write of the row. The instance read back now
 * carries every stored property its rebuild made no use of, as its own. Where an instance still
 * wouldn't write what was stored (something extra inside the map), the value isn't rebuilt: it stays
 * the map it was.
 */
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { readingInstances } from "@effect-dynamodb/schema/internal/InstanceReads.js"
import { BigDecimal, Duration, Effect, Schema } from "effect"
import * as Cookies from "effect/http/Cookies"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import { asRead } from "../src/internal/RoundTrip.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { isInstanceOf, lookalikes } from "./helpers/Lookalikes.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** A copy of an instance holding one more property: a shared one (`Duration.infinity`) is left alone. */
const withSource = <A>(instance: A): A =>
  Object.assign(
    Object.create(
      Object.getPrototypeOf(instance),
      Object.getOwnPropertyDescriptors(instance),
    ) as object,
    { source: "invoice" },
  ) as A

const read = (field: Schema.Top, stored: unknown): unknown =>
  Schema.decodeUnknownSync(readingInstances(field) as Schema.Codec<unknown, unknown>)(stored)

/** A `DateTime`'s rebuild predates this, and writes a date its own way: nothing is carried on one. */
const carries = lookalikes.filter(({ name }) => !name.includes("DateTime"))

describe("a look-alike read back carries what was stored with it", () => {
  it("covers every look-alike but the dates", () => {
    expect(carries.length).toBeGreaterThan(40)
    expect(lookalikes.length - carries.length).toBeLessThan(8)
  })

  for (const { name, field, make } of carries) {
    it(`${name}: the instance, its extra property, and the bytes stored`, () => {
      const written = withSource(make())
      const stored = asRead(written)
      expect(stored).toMatchObject({ source: "invoice" })

      const back = read(field, stored) as { readonly source?: unknown }
      // The instance written, extra property and all: one without it isn't equal to it.
      expect(isInstanceOf(back, written, field)).toBe(true)
      expect(Object.getOwnPropertyDescriptor(back, "source")).toEqual({
        value: "invoice",
        enumerable: true,
        writable: true,
        configurable: true,
      })
      expect(toAttributeMap({ f: back })).toEqual(toAttributeMap({ f: written }))

      // With nothing extra stored, the instance is the one rebuilt, untouched.
      const plain = read(field, asRead(make()))
      expect(isInstanceOf(plain, make(), field)).toBe(true)
      expect(Object.hasOwn(plain as object, "source")).toBe(false)
      expect(toAttributeMap({ f: plain })).toEqual(toAttributeMap({ f: make() }))
    })
  }

  it("a shared instance is never given a stored property", () => {
    const stored = asRead(withSource(Duration.infinity))
    const back = read(Schema.Duration, stored)
    expect(back).not.toBe(Duration.infinity)
    expect(Duration.isDuration(back)).toBe(true)
    expect(Object.hasOwn(Duration.infinity, "source")).toBe(false)
  })

  it("a property named for one the prototype has is carried as the instance's own", () => {
    const stored = { ...(asRead(Duration.millis(5)) as object), ["__proto__"]: "x" }
    Object.defineProperty(stored, "__proto__", { value: "x", enumerable: true })
    const back = read(Schema.Duration, stored)
    expect(Duration.isDuration(back)).toBe(true)
    expect(Object.getPrototypeOf(back)).toBe(Object.getPrototypeOf(Duration.millis(5)))
    expect(Object.getOwnPropertyDescriptor(back, "__proto__")?.value).toBe("x")
  })

  it("something extra inside the stored map leaves the value the map it was", () => {
    const duration = asRead(Duration.millis(5)) as { value: object }
    const stored = { ...duration, value: { ...duration.value, extra: 1 } }
    expect(read(Schema.Duration, stored)).toEqual(stored)
    expect(Object.getPrototypeOf(read(Schema.Duration, stored))).toBe(Object.prototype)

    const decimal = asRead(BigDecimal.fromStringUnsafe("1.50")) as object
    const cached = { ...decimal, normalized: decimal }
    expect(Object.getPrototypeOf(read(Schema.BigDecimal, cached))).toBe(Object.prototype)
  })
})

describe("an aggregate's update writes back what its row held", () => {
  const schema = DynamoSchema.make({ name: "look", version: 1 })
  const CASES: ReadonlyArray<readonly [string, Schema.Top, () => unknown]> = [
    ["Duration", Schema.Duration, () => Duration.millis(5)],
    ["BigDecimal", Schema.BigDecimal, () => BigDecimal.fromStringUnsafe("1.50")],
    [
      "Cookie",
      Schema.Cookie,
      () => Cookies.makeCookieUnsafe("a", "b c", { path: "/", maxAge: Duration.seconds(5) }),
    ],
  ]

  for (const [name, field, make] of CASES) {
    it.effect(
      `${name}: unchanged, nothing is written; changed elsewhere, the property stays`,
      () => {
        const Base = Table.make({ schema, entities: {} } as never) as any
        const Root = Aggregate.make(
          Schema.Struct({ id: Schema.String, f: field, note: Schema.optional(Schema.String) }),
          {
            table: Base,
            schema,
            pk: { field: "pk", composite: ["id"] },
            collection: { name: "root" },
            root: { entityType: "Root" },
            edges: {},
          } as never,
        ) as any
        const table = makeRecordingTable()
        const rowOf = () => [...table.items.values()][0]!
        return Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: {},
            aggregates: { Root },
            tables: { Main: { ...Base, aggregates: { Root } } },
          } as never)
          yield* db.aggregates.Root.create({ id: "a", f: withSource(make()) })
          const created = rowOf().f
          expect(created).toMatchObject({ M: { source: { S: "invoice" } } })

          const got = yield* db.aggregates.Root.get({ id: "a" })
          expect(isInstanceOf(got.f, withSource(make()), field)).toBe(true)
          expect(got.f.source).toBe("invoice")

          table.take()
          yield* db.aggregates.Root.update({ id: "a" }, ({ state }: any) => state)
          expect(table.take().map(({ command }) => command)).not.toContain("TransactWriteItems")

          yield* db.aggregates.Root.update({ id: "a" }, ({ state }: any) => ({
            ...state,
            note: "changed",
          }))
          expect(table.take().map(({ command }) => command)).toContain("TransactWriteItems")
          expect(rowOf().note).toEqual({ S: "changed" })
          expect(rowOf().f).toEqual(created)
        }).pipe(
          Effect.provide(Base.layer({ name: "t" })),
          Effect.provide(table.layer),
        ) as Effect.Effect<void>
      },
    )
  }
})
