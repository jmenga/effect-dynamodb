/**
 * A `BigDecimal` that `Equal.equals`, `Hash.hash` or `BigDecimal.normalize` has run on caches its
 * normalized form, a decimal that holds itself, and marshalling it recursed until the stack ran out:
 * every write of one died. Each decimal on such a cycle is now written without its cache, so as the
 * map a fresh one of the same value and scale is, byte for byte what published 1.39.0 sent for that
 * fresh one
 * (`fixtures/bigdecimal-requests-1.39.0.json`): at the top level, nested, in a list, inside an
 * `Option`, as a condition operand and in an update's `set`.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { BigDecimal, Effect, Equal, Hash, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { isUnstorableValue, toAttributeMap, toAttributeValue } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer, mockOutput } from "./helpers/MockDynamoClient.js"

type Sent = {
  readonly op: string
  readonly Item?: Record<string, AttributeValue> | undefined
  readonly ExpressionAttributeValues?: Record<string, AttributeValue> | undefined
  readonly ConditionExpression?: string | undefined
  readonly UpdateExpression?: string | undefined
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/bigdecimal-requests-1.39.0.json", import.meta.url), "utf8"),
) as { readonly requests: Record<string, ReadonlyArray<Sent>> }

const d = (text: string) => BigDecimal.fromStringUnsafe(text)

/** A decimal ordinary use has cached a normalized form on, as 1.39.0 couldn't write. */
const touched = (decimal: BigDecimal.BigDecimal): BigDecimal.BigDecimal => {
  Hash.hash(decimal)
  expect("normalized" in decimal).toBe(true)
  return decimal
}

/** The fixture's shapes: the field and the value its generator wrote, fresh. */
const shapes: Record<string, readonly [Schema.Top, () => unknown]> = {
  top: [Schema.BigDecimal, () => touched(d("1.50"))],
  nested: [Schema.Struct({ a: Schema.BigDecimal }), () => ({ a: touched(d("1.50")) })],
  list: [Schema.Array(Schema.BigDecimal), () => [touched(d("1.50")), touched(d("-12.345"))]],
  option: [Schema.Option(Schema.BigDecimal), () => Option.some(touched(d("1.50")))],
}

const requestsFor = (field: Schema.Top, value: () => unknown) => {
  const sent: Array<Sent> = []
  const record =
    (op: string) =>
    (input: Sent): Effect.Effect<any> =>
      Effect.sync(() => {
        sent.push({
          op,
          Item: input.Item,
          ExpressionAttributeValues: input.ExpressionAttributeValues,
          ConditionExpression: input.ConditionExpression,
          UpdateExpression: input.UpdateExpression,
        })
        return mockOutput({})
      })
  const Rows = Entity.make({
    model: Schema.Struct({ id: Schema.String, f: field }),
    entityType: "Row",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any
  const Main = Table.make({
    schema: DynamoSchema.make({ name: "bd", version: 1 }),
    entities: { Rows },
  } as never) as any
  return Effect.gen(function* () {
    const db = (yield* DynamoClient.make({
      entities: { Rows },
      tables: { Main },
    } as never)) as any
    yield* db.entities.Rows.put({ id: "a", f: value() }).asEffect()
    yield* db.entities.Rows.put({ id: "a", f: value() })
      .condition((t: any, { eq }: any) => eq(t.f, value()))
      .asEffect()
      .pipe(Effect.ignore)
    yield* db.entities.Rows.update({ id: "a" }).set({ f: value() }).asEffect().pipe(Effect.ignore)
    return sent
  }).pipe(
    Effect.provide(Main.layer({ name: "bd-table" })),
    Effect.provide(
      mockDynamoClientLayer({
        putItem: record("putItem") as never,
        updateItem: record("updateItem") as never,
      }),
    ),
  ) as unknown as Effect.Effect<ReadonlyArray<Sent>>
}

/** What the fixture pins of a request: the decimal's attribute and the expressions' values. */
const pinned = (request: Sent) => ({
  op: request.op,
  f: request.Item?.f,
  ExpressionAttributeValues: request.ExpressionAttributeValues,
  ConditionExpression: request.ConditionExpression,
  UpdateExpression: request.UpdateExpression,
})

describe("a BigDecimal holding its cached normalized form", () => {
  for (const [label, [field, value]] of Object.entries(shapes)) {
    it.effect(`${label}: writes what 1.39.0 wrote for a fresh one`, () =>
      Effect.gen(function* () {
        const sent = yield* requestsFor(field, value)
        expect(sent.map(pinned)).toEqual(fixture.requests[label]!.map(pinned))
      }),
    )
  }

  it("marshals each way a decimal gets its cache as a fresh one of its value and scale", () => {
    const fresh = toAttributeMap({ f: d("1.50") })
    const afterEquals = d("1.50")
    expect(Equal.equals(afterEquals, d("1.5"))).toBe(true)
    expect(toAttributeMap({ f: afterEquals })).toEqual(fresh)
    expect(toAttributeMap({ f: touched(d("1.50")) })).toEqual(fresh)
    // `normalize` returns the normalized decimal itself, which holds itself.
    expect(toAttributeMap({ f: BigDecimal.normalize(d("1.50")) })).toEqual(
      toAttributeMap({ f: d("1.5") }),
    )
    expect(toAttributeValue(touched(d("1.50")))).toEqual(fresh.f)
  })

  it("writes the decimal and the normalized one it caches, which holds itself, as fresh ones", () => {
    const cacheOf = (value: BigDecimal.BigDecimal) =>
      (value as unknown as { readonly normalized?: unknown }).normalized
    const decimal = d("1.50")
    const normalized = BigDecimal.normalize(decimal)
    expect(cacheOf(decimal)).toBe(normalized)
    expect(cacheOf(normalized)).toBe(normalized)
    expect(toAttributeMap({ decimal, normalized })).toEqual(
      toAttributeMap({ decimal: d("1.50"), normalized: d("1.5") }),
    )
    // Written, not changed: each keeps its cache.
    expect(cacheOf(decimal)).toBe(normalized)
  })

  it("keeps every other enumerable property of a decimal it writes without its cache", () => {
    const cached = Object.assign(touched(d("1.50")), { source: "feed" })
    const fresh = Object.assign(d("1.50"), { source: "feed" })
    expect(toAttributeMap({ f: cached })).toEqual(toAttributeMap({ f: fresh }))
    expect(toAttributeMap({ f: cached }).f).toMatchObject({ M: { source: { S: "feed" } } })
  })

  it("leaves a decimal with no cache as it is, an empty set alongside or not", () => {
    // The base left the empty set out and wrote the decimal as it is, `source` and all.
    const decimal = Object.assign(d("1.50"), { source: "feed" })
    const stored = toAttributeMap({ f: decimal, tags: new Set<string>() })
    expect(stored).toEqual(toAttributeMap({ f: decimal }))
    expect(stored.f).toMatchObject({ M: { source: { S: "feed" } } })
    // Still refused as the base refused it, with nothing to leave out.
    const refused = (() => {
      try {
        toAttributeMap({ f: decimal, list: [new Set<string>()] })
        return undefined
      } catch (error) {
        return error
      }
    })()
    expect(isUnstorableValue(refused)).toBe(true)
    expect((refused as { readonly path: ReadonlyArray<unknown> }).path).toEqual(["list", 0])
  })

  it("swaps the decimal before the empty sets are left out, which walked into the cycle", () => {
    const item = { f: touched(d("1.50")), tags: new Set<string>(), g: { h: touched(d("2")) } }
    expect(toAttributeMap(item)).toEqual({
      f: toAttributeMap({ f: d("1.50") }).f,
      g: { M: { h: toAttributeMap({ h: d("2") }).h } },
    })
  })

  it("calls no getter to look for a cached decimal: an item holding none is written as before", () => {
    // With an empty set to leave out, 1.39.0 read each property twice: once marshalling, once
    // leaving the set out. Looking for a decimal reads no getter, so it's still twice, and the
    // value stored is still the second read's.
    let calls = 0
    const item = {
      get n() {
        return ++calls
      },
      empty: new Set<string>(),
    }
    expect(toAttributeMap(item)).toEqual({ n: { N: "2" } })
    expect(calls).toBe(2)

    // A getter on a class, which marshalling reads through the prototype, after the instance's
    // own empty set has stopped it: read once, leaving the set out, as on 1.39.0.
    let read = 0
    class Counted {
      empty = new Set<string>()
      get n() {
        return ++read
      }
    }
    Object.defineProperty(Counted.prototype, "n", { enumerable: true })
    expect(toAttributeMap({ c: new Counted() })).toEqual({ c: { M: { n: { N: "1" } } } })
    expect(read).toBe(1)
  })

  it("finds a cached decimal through data alone, on a prototype too, and not behind a getter", () => {
    const held = Object.create({ inherited: touched(d("1.50")) }) as Record<string, unknown>
    expect(toAttributeMap({ held })).toEqual({
      held: { M: { inherited: toAttributeMap({ f: d("1.50") }).f! } },
    })
    // Behind a getter it isn't looked for, and marshalling refuses it as it did.
    const hidden = {
      get f() {
        return touched(d("1.50"))
      },
    }
    expect(() => toAttributeMap(hidden)).toThrow()
  })
})
