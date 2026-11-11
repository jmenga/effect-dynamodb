/**
 * Effect's look-alike declarations — a `BigDecimal`, a `Duration`, a zone, a cookie, a URL's params, a
 * version and its range, an address, a DNS record, and a `DateTime` in an `Option` or a `Result` — are
 * stored as the map the marshaller makes of one, and their guards take that map: published 1.39.0 read
 * the map back as the value. Every read now hands back the instance written (`helpers/Lookalikes.ts`
 * has one of each), while every write sends what 1.39.0 sent (`fixtures/lookalike-writes-1.39.0.json`)
 * and a read that fails says what 1.39.0 said, unless a check inspecting a look-alike now says
 * something else of the instance.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { holdsCustomDeclaration } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import { Cause, Duration, Effect, Equal, Exit, type Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import { isInstanceOf, lookalikes } from "./helpers/Lookalikes.js"
import { mockDynamoClientLayer, mockOutput } from "./helpers/MockDynamoClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

type Item = Record<string, AttributeValue>

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/lookalike-writes-1.39.0.json", import.meta.url), "utf8"),
) as {
  readonly writes: Record<
    string,
    {
      readonly entity: ReadonlyArray<unknown>
      readonly aggregate: ReadonlyArray<unknown>
      readonly stream: unknown
      readonly ref: ReadonlyArray<unknown>
    }
  >
  readonly readFailures: Record<string, unknown>
}

/** As the fixture's generator wrote JSON: bytes as their list. */
const asJson = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? { Uint8Array: [...v] } : v)),
  )

const schema = DynamoSchema.make({ name: "look", version: 1 })
const singleKey = (name: string) => ({
  pk: { field: "pk", composite: [name] },
  sk: { field: "sk", composite: [] },
})

const entityOf = (field: Schema.Top) => {
  const Rows = Entity.make({
    model: Schema.Struct({ id: Schema.String, f: field, n: Schema.optional(Schema.Number) }),
    entityType: "Row",
    primaryKey: singleKey("id"),
  } as never) as any
  const Main = Table.make({ schema, entities: { Rows } } as never) as any
  return { Rows, Main }
}

const aggregateOf = (field: Schema.Top) => {
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
  return { Base, Root, Main: { ...Base, aggregates: { Root } } }
}

const streamOf = (field: Schema.Top) => {
  const Base = Table.make({ schema, entities: {} } as never) as any
  const Events = EventStore.makeStream({
    table: Base,
    streamName: "Tally",
    events: [Schema.Struct({ _tag: Schema.tag("Noted"), f: field })],
    streamId: { composite: ["id"] },
  } as never) as any
  return { Base, Events }
}

const refOf = (field: Schema.Top) => {
  class Target extends Schema.Class<Target>("Target")({
    targetId: Schema.String.pipe(DynamoModel.identifier),
    f: field,
  }) {}
  class Holder extends Schema.Class<Holder>("Holder")({
    id: Schema.String,
    target: Target.pipe(DynamoModel.ref),
  }) {}
  const Targets = Entity.make({
    model: Target,
    entityType: "Target",
    primaryKey: singleKey("targetId"),
  } as never) as any
  const Holders = Entity.make({
    model: Holder,
    entityType: "Holder",
    primaryKey: singleKey("id"),
    refs: { target: { entity: Targets } },
  } as never) as any
  const Main = Table.make({ schema, entities: { Targets, Holders } } as never) as any
  return { Targets, Holders, Main }
}

const onTable = <A>(
  layer: Layer.Layer<any, any, any>,
  table: ReturnType<typeof makeRecordingTable>,
  body: Effect.Effect<A, unknown, any>,
) => body.pipe(Effect.provide(layer), Effect.provide(table.layer)) as unknown as Effect.Effect<A>

describe("each look-alike reads back as the instance written", () => {
  for (const { name, field, make } of lookalikes) {
    it.effect(`${name}: an entity's get, query, scan and batch get`, () => {
      const { Rows, Main } = entityOf(field)
      const table = makeRecordingTable()
      return onTable(
        Main.layer({ name: "t" }),
        table,
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Rows },
            tables: { Main },
          } as never)
          yield* db.entities.Rows.put({ id: "a", f: make() }).asEffect()
          const got = yield* db.entities.Rows.get({ id: "a" })
          expect(isInstanceOf(got.f, make(), field)).toBe(true)
          const scanned = yield* db.entities.Rows.scan().collect()
          expect(isInstanceOf(scanned[0].f, make(), field)).toBe(true)
          const [batched] = yield* Batch.get([db.entities.Rows.get({ id: "a" })])
          expect(isInstanceOf((batched as any).f, make(), field)).toBe(true)
        }),
      )
    })

    it.effect(`${name}: an aggregate's get`, () => {
      const { Base, Root, Main } = aggregateOf(field)
      const table = makeRecordingTable()
      return onTable(
        Base.layer({ name: "t" }),
        table,
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: {},
            aggregates: { Root },
            tables: { Main },
          } as never)
          yield* db.aggregates.Root.create({ id: "a", f: make() })
          const got = yield* db.aggregates.Root.get({ id: "a" })
          expect(isInstanceOf(got.f, make(), field)).toBe(true)
        }),
      )
    })

    it.effect(`${name}: a stream's read`, () => {
      const { Base, Events } = streamOf(field)
      const table = makeRecordingTable()
      return onTable(
        Base.layer({ name: "t" }),
        table,
        Effect.gen(function* () {
          yield* Events.append({ id: "a" }, [{ _tag: "Noted", f: make() }], 0)
          const [event] = yield* Events.read({ id: "a" })
          expect(isInstanceOf(event.data.f, make(), field)).toBe(true)
        }),
      )
    })

    it.effect(`${name}: a ref field's target, read with the row holding it`, () => {
      const { Targets, Holders, Main } = refOf(field)
      const table = makeRecordingTable()
      return onTable(
        Main.layer({ name: "t" }),
        table,
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Targets, Holders },
            tables: { Main },
          } as never)
          yield* db.entities.Targets.put({ targetId: "t1", f: make() }).asEffect()
          yield* db.entities.Holders.put({ id: "h1", targetId: "t1" }).asEffect()
          const holder = yield* db.entities.Holders.get({ id: "h1" })
          expect(isInstanceOf(holder.target.f, make(), field)).toBe(true)
        }),
      )
    })
  }
})

describe("an aggregate's update after reading the instance", () => {
  for (const { name, field, make } of lookalikes) {
    it.effect(
      `${name}: rewrites the value as stored, and writes nothing when nothing changed`,
      () => {
        const { Base, Root, Main } = aggregateOf(field)
        const table = makeRecordingTable()
        const storedF = () => asJson([...table.items.values()].map((item) => item.f))
        return onTable(
          Base.layer({ name: "t" }),
          table,
          Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: {},
              aggregates: { Root },
              tables: { Main },
            } as never)
            yield* db.aggregates.Root.create({ id: "a", f: make() })
            const created = storedF()
            table.take()
            yield* db.aggregates.Root.update({ id: "a" }, ({ state }: any) => state)
            expect(table.take().map(({ command }) => command)).not.toContain("TransactWriteItems")
            yield* db.aggregates.Root.update({ id: "a" }, ({ state }: any) => ({
              ...state,
              note: "n",
            }))
            expect(table.take().map(({ command }) => command)).toContain("TransactWriteItems")
            expect(storedF()).toEqual(created)
            const got = yield* db.aggregates.Root.get({ id: "a" })
            expect(isInstanceOf(got.f, make(), field)).toBe(true)
          }),
        )
      },
    )
  }

  it.effect("a checked field 1.39.0 couldn't read back reads the instance", () => {
    const realOnly = Schema.makeFilter((d: unknown) => Equal.isEqual(d) || "a real Duration")
    const { Base, Root, Main } = aggregateOf(Schema.Duration.check(realOnly))
    const table = makeRecordingTable()
    return onTable(
      Base.layer({ name: "t" }),
      table,
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: {},
          aggregates: { Root },
          tables: { Main },
        } as never)
        yield* db.aggregates.Root.create({ id: "a", f: Duration.millis(5) })
        const got = yield* db.aggregates.Root.get({ id: "a" })
        expect(isInstanceOf(got.f, Duration.millis(5), Schema.Duration)).toBe(true)
      }),
    )
  })
})

/**
 * The requests a fixture's case sends, as its generator pinned them, on a client that answers as
 * the generator's did: a get finds what was put, everything else answers nothing.
 */
const recorded = <A>(layer: Layer.Layer<any, any, any>, body: Effect.Effect<A, unknown, any>) => {
  const sent: Array<{ readonly op: string; readonly input: any }> = []
  const items = new Map<string, Item>()
  const keyOf = (item: any) => `${item.pk?.S}|${item.sk?.S}`
  const record =
    (op: string) =>
    (input: any): Effect.Effect<any> =>
      Effect.sync(() => {
        sent.push({ op, input: structuredClone(input) })
        if (op === "putItem") items.set(keyOf(input.Item), input.Item)
        if (op === "getItem") {
          const item = items.get(keyOf(input.Key))
          return mockOutput(item === undefined ? {} : { Item: item })
        }
        return mockOutput({})
      })
  return body.pipe(
    Effect.ignore,
    Effect.provide(layer),
    Effect.provide(
      mockDynamoClientLayer({
        putItem: record("putItem") as never,
        getItem: record("getItem") as never,
        updateItem: record("updateItem") as never,
        transactWriteItems: record("transactWriteItems") as never,
      }),
    ),
    Effect.as(sent),
  ) as unknown as Effect.Effect<ReadonlyArray<{ readonly op: string; readonly input: any }>>
}

describe("each look-alike is written as 1.39.0 wrote it", () => {
  for (const { name, field, make } of lookalikes) {
    const expected = fixture.writes[name]!

    it.effect(`${name}: an entity's put, conditioned put and update`, () => {
      const { Rows, Main } = entityOf(field)
      return Effect.gen(function* () {
        const sent = yield* recorded(
          Main.layer({ name: "t" }),
          Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: { Rows },
              tables: { Main },
            } as never)
            yield* db.entities.Rows.put({ id: "a", f: make() }).asEffect()
            yield* db.entities.Rows.put({ id: "a", f: make() })
              .condition((t: any, { eq }: any) => eq(t.f, make()))
              .asEffect()
              .pipe(Effect.ignore)
            yield* db.entities.Rows.update({ id: "a" })
              .set({ f: make(), n: 1 })
              .asEffect()
              .pipe(Effect.ignore)
          }),
        )
        const pinned = sent.map(({ op, input }) =>
          Object.fromEntries(
            Object.entries({
              op,
              f: input.Item?.f,
              ExpressionAttributeValues: input.ExpressionAttributeValues,
              ConditionExpression: input.ConditionExpression,
              UpdateExpression: input.UpdateExpression,
            }).filter(([, v]) => v !== undefined),
          ),
        )
        expect(asJson(pinned)).toEqual(expected.entity)
      })
    })

    it.effect(`${name}: an aggregate's create`, () => {
      const { Base, Root, Main } = aggregateOf(field)
      return Effect.gen(function* () {
        const sent = yield* recorded(
          Base.layer({ name: "t" }),
          Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: {},
              aggregates: { Root },
              tables: { Main },
            } as never)
            yield* db.aggregates.Root.create({ id: "a", f: make() })
          }),
        )
        const items = sent[0]!.input.TransactItems.map((t: any) => t.Put.Item.f)
        expect(asJson(items)).toEqual(expected.aggregate)
      })
    })

    it.effect(`${name}: a stream's append`, () => {
      const { Base, Events } = streamOf(field)
      return Effect.gen(function* () {
        const sent = yield* recorded(
          Base.layer({ name: "t" }),
          Events.append({ id: "a" }, [{ _tag: "Noted", f: make() }], 0),
        )
        expect(asJson(sent[0]!.input.Item.data)).toEqual(expected.stream)
      })
    })

    it.effect(`${name}: the row a ref field's target is spliced into`, () => {
      const { Targets, Holders, Main } = refOf(field)
      return Effect.gen(function* () {
        const sent = yield* recorded(
          Main.layer({ name: "t" }),
          Effect.gen(function* () {
            const db: any = yield* DynamoClient.make({
              entities: { Targets, Holders },
              tables: { Main },
            } as never)
            yield* db.entities.Targets.put({ targetId: "t1", f: make() }).asEffect()
            yield* db.entities.Holders.put({ id: "h1", targetId: "t1" }).asEffect()
          }),
        )
        const targets = sent
          .filter(({ op, input }) => op === "putItem" && input.Item.target !== undefined)
          .map(({ input }) => input.Item.target)
        expect(asJson(targets)).toEqual(expected.ref)
      })
    })
  }
})

// The fixture generator's checks, as it declared them.
const realOnly = Schema.makeFilter((d: unknown) => Equal.isEqual(d) || "a real Duration")
const overTen = Schema.makeFilter(
  (d: any) =>
    (Equal.isEqual(d) && Duration.toMillis(d as Duration.Duration) > 10_000) || "over ten seconds",
)

/** What an entity's get of a row holding `value` under `field` fails with, or `ok`. */
const readOutcome = (field: Schema.Top, value: unknown) => {
  const Rows = Entity.make({
    model: Schema.Struct({ id: Schema.String, f: Schema.Unknown }),
    entityType: "Row",
    primaryKey: singleKey("id"),
  } as never) as any
  const Strict = Entity.make({
    model: Schema.Struct({ id: Schema.String, f: field }),
    entityType: "Row",
    primaryKey: singleKey("id"),
  } as never) as any
  const Main = Table.make({ schema, entities: { Rows, Strict } } as never) as any
  const table = makeRecordingTable()
  return onTable(
    Main.layer({ name: "t" }),
    table,
    Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({
        entities: { Rows, Strict },
        tables: { Main },
      } as never)
      yield* db.entities.Rows.put({ id: "a", f: value }).asEffect()
      const exit = yield* Effect.exit(db.entities.Strict.get({ id: "a" }))
      if (Exit.isSuccess(exit)) return { ok: (exit.value as any).f }
      const error: any = Cause.squash(exit.cause)
      return { tag: error._tag, operation: error.operation, cause: String(error.cause) }
    }),
  )
}

describe("a read that fails", () => {
  it.effect("checked Duration: its checks see the instance, and report what they say of it", () =>
    Effect.gen(function* () {
      const field = Schema.Duration.check(realOnly, overTen)
      // 1.39.0's `realOnly` refused the map; the instance passes it, and isn't over ten seconds.
      expect(fixture.readFailures["checked Duration"]).toEqual({
        tag: "ValidationError",
        operation: "decode",
        cause: 'SchemaError(a real Duration\n  at ["f"])',
      })
      expect(yield* readOutcome(field, Duration.millis(1500))).toEqual({
        tag: "ValidationError",
        operation: "decode",
        cause: 'SchemaError(over ten seconds\n  at ["f"])',
      })
    }),
  )

  const cases: Record<string, readonly [Schema.Top, unknown]> = {
    "union of a checked Duration and a struct": [
      Schema.Union([Schema.Duration.check(overTen), Schema.Struct({ other: Schema.String })]),
      Duration.millis(1500),
    ],
    "checked struct": [
      Schema.Struct({ d: Schema.Duration, n: Schema.Number }).check(
        Schema.makeFilter((s: any) => (Equal.isEqual(s.d) && s.n > 1) || "a real d and n over 1"),
      ),
      { d: Duration.millis(1500), n: 1 },
    ],
  }
  for (const [label, [field, value]] of Object.entries(cases)) {
    it.effect(`${label}: fails as 1.39.0's did, with its issue`, () =>
      Effect.gen(function* () {
        expect(yield* readOutcome(field, value)).toEqual(fixture.readFailures[label])
      }),
    )
  }

  it.effect("a check 1.39.0's map failed, which the instance passes, reads the instance", () =>
    Effect.gen(function* () {
      const field = Schema.Struct({ d: Schema.Duration.check(realOnly), n: Schema.Number })
      // 1.39.0 failed this read.
      expect(fixture.readFailures["struct with a bad sibling"]).toMatchObject({
        tag: "ValidationError",
      })
      const outcome = (yield* readOutcome(field, { d: Duration.millis(1500), n: 1 })) as any
      expect(isInstanceOf(outcome.ok.d, Duration.millis(1500), Schema.Duration)).toBe(true)
    }),
  )
})

describe("a row holding no look-alike reads as 1.39.0 read it", () => {
  /** An entity's get of a row holding `id` and `n` only, read through a model with `extra` too. */
  const getThrough = (extra: Schema.Struct.Fields) =>
    Effect.gen(function* () {
      const calls = { check: 0, defaulted: 0 }
      const Raw = Entity.make({
        model: Schema.Struct({ id: Schema.String, n: Schema.Number }),
        entityType: "Row",
        primaryKey: singleKey("id"),
      } as never) as any
      const Read = Entity.make({
        model: Schema.Struct({
          id: Schema.String,
          n: Schema.Number.check(
            Schema.makeFilter(() => {
              calls.check++
              return true
            }),
          ),
          p: Schema.String.pipe(
            Schema.withDecodingDefaultKey(
              Effect.sync(() => {
                calls.defaulted++
                return "default"
              }),
            ),
          ),
          ...extra,
        }),
        entityType: "Row",
        primaryKey: singleKey("id"),
      } as never) as any
      const Main = Table.make({ schema, entities: { Raw, Read } } as never) as any
      const table = makeRecordingTable()
      const got = yield* onTable(
        Main.layer({ name: "t" }),
        table,
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: { Raw, Read },
            tables: { Main },
          } as never)
          yield* db.entities.Raw.put({ id: "a", n: 1 }).asEffect()
          table.take()
          // What the get runs, alone: defining the entity already ran its default once.
          calls.check = calls.defaulted = 0
          return yield* db.entities.Read.get({ id: "a" })
        }),
      )
      return { got, calls, requests: table.take() }
    })

  it.effect("by the same requests, to the same result, with each check and default run once", () =>
    Effect.gen(function* () {
      const plain = yield* getThrough({})
      const holding = yield* getThrough({
        d: Schema.optionalKey(Schema.Duration),
        list: Schema.optionalKey(Schema.Array(Schema.BigDecimal)),
      })
      expect(asJson(holding.requests)).toEqual(asJson(plain.requests))
      expect(holding.got).toEqual(plain.got)
      expect(holding.got).toEqual({ id: "a", n: 1, p: "default" })
      expect(holding.calls).toEqual(plain.calls)
      expect(holding.calls).toEqual({ check: 1, defaulted: 1 })
    }),
  )
})

describe("Effect's declarations are told apart by their parser, never by a name", () => {
  /** A declaration of one's own, named as Effect's is, whose guard takes the stored map. */
  const lookalikeDuration = Schema.declare((u: unknown): u is Duration.Duration =>
    Duration.isDuration(u),
  ).annotate({ identifier: "Duration" })
  /** One whose guard doesn't, named as Effect's address is. */
  const strictAddress = Schema.declare(
    (u: unknown): u is { readonly _tag: "Ipv4Address" } =>
      typeof u === "object" && u !== null && Object.getPrototypeOf(u) !== Object.prototype,
  ).annotate({ identifier: "Ipv4Address" })

  it("an Effect address is no custom declaration; one named as it is, still is", () => {
    expect(holdsCustomDeclaration(Schema.Ipv4Address.ast)).toBe(false)
    expect(holdsCustomDeclaration(Schema.Ipv4PrivateAddress.ast)).toBe(false)
    expect(holdsCustomDeclaration(Schema.DnsSoaRecord.ast)).toBe(false)
    expect(holdsCustomDeclaration(strictAddress.ast)).toBe(true)
    expect(holdsCustomDeclaration(lookalikeDuration.ast)).toBe(true)
  })

  it.effect("a write of one named as Effect's address is still refused (EDD-9126)", () => {
    const { Rows, Main } = entityOf(strictAddress)
    const table = makeRecordingTable()
    const address = lookalikes.find(({ name }) => name === "Ipv4Address")!.make()
    return onTable(
      Main.layer({ name: "t" }),
      table,
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { Main } } as never)
        const exit = yield* Effect.exit(db.entities.Rows.put({ id: "a", f: address }).asEffect())
        expect(Exit.isFailure(exit)).toBe(true)
        expect(String((Cause.squash((exit as any).cause) as any).cause)).toContain("EDD-9126")
        expect(table.items.size).toBe(0)
      }),
    )
  })

  it.effect("one named as Effect's Duration reads back the map, as on 1.39.0", () => {
    const { Rows, Main } = entityOf(lookalikeDuration)
    const table = makeRecordingTable()
    return onTable(
      Main.layer({ name: "t" }),
      table,
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({ entities: { Rows }, tables: { Main } } as never)
        yield* db.entities.Rows.put({ id: "a", f: Duration.millis(1500) }).asEffect()
        const got = yield* db.entities.Rows.get({ id: "a" })
        expect(Object.getPrototypeOf(got.f)).toBe(Object.prototype)
        expect(got.f).toEqual({
          value: { _tag: "Millis", millis: 1500 },
          "~effect/Duration": "~effect/Duration",
        })
      }),
    )
  })
})
