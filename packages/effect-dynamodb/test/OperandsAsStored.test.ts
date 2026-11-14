/**
 * A condition's or filter's operand that is one of Effect's instances is sent in the form the
 * attribute it's compared with holds (#242, `operandsAsStored`): what a write of it at that path
 * stores. It was sent as the instance's map, which no row holds where the field stores the value
 * another way: `eq(t.at, at)` on a `Schema.DateTimeZoned` compared the map with the ISO text the
 * row holds, and never matched. Each of Effect's value types (`ValueTypeCells`) in each position: a
 * query filter (callback and shorthand, `eq`, `ne`, `isIn`), an update's and a delete's condition
 * (callback and shorthand), a transaction op's condition, a collection's filter and an aggregate
 * `list` filter. Where 1.40.0 sent the stored form already (a zone, a `Duration`, an `Option`, …),
 * the operand is the same bytes, and a filter on a plain value is the same request. DynamoDB's
 * own verdicts, `between` and `contains` included: `connected.operands-as-stored.test.ts`. A
 * primitive the attribute doesn't hold as given (`5` on a `Schema.NumberFromString`, a ref's id
 * among them) is sent in its stored form too; requests and DynamoDB's verdicts for it:
 * `helpers/EntityRefOperands.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Duration, Effect, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { operandAsStored } from "../src/internal/Expr.js"
import { toAttributeValue } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable, type Request } from "./helpers/RecordingTable.js"
import { KINDS } from "./helpers/ValueTypeCells.js"

const schema = DynamoSchema.make({ name: "os", version: 1 })

/** Each kind a typed field stores and reads back, and three that store a primitive by their schema. */
const kinds: Record<string, { readonly schema: Schema.Top; readonly make: () => unknown }> = {
  ...Object.fromEntries(
    Object.entries(KINDS).filter(
      ([name]) =>
        !["Chunk", "HashSet", "HashMap", "Data class", "Data tagged class"].includes(name),
    ),
  ),
  "DateTimeUtc stored as epoch seconds": {
    schema: Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
    make: () => DateTime.makeUnsafe(0),
  },
  "NullOr DateTimeZoned": {
    schema: Schema.NullOr(Schema.DateTimeZoned),
    make: () => DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" }),
  },
  DurationFromMillis: { schema: Schema.DurationFromMillis, make: () => Duration.millis(1500) },
}

/** Whether 1.40.0 sent the operand as the row holds it: the instance's map is the stored form. */
const storedAsGiven = new Set([
  "TimeZone named",
  "TimeZone named, as 4.1.3 makes it",
  "TimeZone named, made from an alias on 4.1.3",
  "TimeZone offset",
  "Duration",
  "BigDecimal",
  "Option some",
  "Option none",
])

const entityOf = (fieldSchema: Schema.Top) =>
  Entity.make({
    model: Schema.Struct({
      id: Schema.String,
      f: Schema.optional(fieldSchema),
      n: Schema.optional(Schema.String),
    }),
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  } as never) as any

const json = (value: unknown) => JSON.stringify(value)

/** A request, or a transaction's item: its expression, names and values. */
type Sent = {
  readonly ConditionExpression?: string
  readonly FilterExpression?: string
  readonly ExpressionAttributeNames?: Record<string, string>
  readonly ExpressionAttributeValues?: Record<string, unknown>
}

/** The value a request's condition or filter compares the attribute `f` with (`=`, `<>`, `IN`). */
const comparedWithF = (sent: Sent | undefined): unknown => {
  const expression = sent?.ConditionExpression ?? sent?.FilterExpression ?? ""
  const name = Object.entries(sent?.ExpressionAttributeNames ?? {}).find(([, attr]) => attr === "f")
  if (name === undefined) return undefined
  const placeholder =
    new RegExp(`${name[0]} (?:=|<>) (:\\w+)`).exec(expression)?.[1] ??
    new RegExp(`${name[0]} IN \\((:\\w+)\\)`).exec(expression)?.[1]
  return placeholder === undefined ? undefined : sent?.ExpressionAttributeValues?.[placeholder]
}

const inputOf = (request: Request | undefined): Sent | undefined => request?.input

const run = <A>(
  entities: Record<string, unknown>,
  table: ReturnType<typeof makeRecordingTable>,
  body: (db: any) => Effect.Effect<A, unknown, unknown>,
  aggregates: Record<string, unknown> = {},
  Main: any = Table.make({ schema, entities } as never),
) => {
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities, aggregates, tables: { Main } } as never)
    return yield* body(db)
  }).pipe(Effect.provide(Main.layer({ name: "os" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

describe("an operand that is one of Effect's instances is sent as the attribute holds it", () => {
  for (const [name, kind] of Object.entries(kinds)) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const E = entityOf(kind.schema)
        const table = makeRecordingTable()
        yield* run({ E }, table, (db) =>
          Effect.gen(function* () {
            yield* db.entities.E.put({ id: "a", f: kind.make() }).asEffect()
            const stored = table.items.get("$os#v1#e#id_a|$os#v1#e")!.f
            if (storedAsGiven.has(name))
              expect(json(toAttributeValue(kind.make()))).toBe(json(stored))
            else expect(json(toAttributeValue(kind.make()))).not.toBe(json(stored))
            table.take()

            const filtered = (filter: (query: any) => any) =>
              Effect.gen(function* () {
                const items = yield* filter(db.entities.E.scan()).collect()
                const [request] = table.take()
                return { found: items.length, request }
              })
            // A filter, callback and shorthand.
            for (const query of [
              (q: any) => q.filter((t: any, { eq }: any) => eq(t.f, kind.make())),
              (q: any) => q.filter({ f: kind.make() }),
            ]) {
              const { found, request } = yield* filtered(query)
              expect(json(comparedWithF(inputOf(request)))).toBe(json(stored))
              expect(found).toBe(1)
            }
            const { found: unequal, request: neRequest } = yield* filtered((q) =>
              q.filter((t: any, { ne }: any) => ne(t.f, kind.make())),
            )
            expect(json(comparedWithF(inputOf(neRequest)))).toBe(json(stored))
            expect(unequal).toBe(0)
            const { found: among, request: inRequest } = yield* filtered((q) =>
              q.filter((t: any, { isIn }: any) => isIn(t.f, [kind.make()])),
            )
            expect(json(comparedWithF(inputOf(inRequest)))).toBe(json(stored))
            expect(among).toBe(1)

            // An update's condition, callback and shorthand.
            for (const condition of [
              (t: any, { eq }: any) => eq(t.f, kind.make()),
              { f: kind.make() },
            ]) {
              yield* db.entities.E.update({ id: "a" })
                .set({ n: "x" })
                .condition(condition)
                .asEffect()
              const request = table.take().find((sent) => sent.command === "UpdateItem")
              expect(json(comparedWithF(inputOf(request)))).toBe(json(stored))
            }

            // A transaction op's condition, then a delete's.
            yield* Transaction.transactWrite([
              db.entities.E.update({ id: "a" }).set({ n: "y" }).condition({ f: kind.make() }),
            ])
            const txn = table.take().find((sent) => sent.command === "TransactWriteItems")
            expect(json(comparedWithF(txn?.input.TransactItems?.[0]?.Update))).toBe(json(stored))
            yield* db.entities.E.delete({ id: "a" }).condition({ f: kind.make() }).asEffect()
            const deleted = table.take().find((sent) => sent.command === "DeleteItem")
            expect(json(comparedWithF(inputOf(deleted)))).toBe(json(stored))
            expect(table.items.size).toBe(0)
          }),
        )
      }),
    )
  }
})

describe("a primitive is sent as the attribute holds it, where it doesn't hold it as given", () => {
  class Team extends Schema.Class<Team>("OsTeam")({ id: Schema.String, name: Schema.String }) {}
  class Player extends Schema.Class<Player>("OsPlayer")({
    id: Schema.NumberFromString,
    name: Schema.String,
    shirt: Schema.NumberFromString,
  }) {}
  class Selection extends Schema.Class<Selection>("OsSelection")({
    id: Schema.String,
    season: Schema.String,
    n: Schema.Number,
    picks: Schema.NumberFromString,
    big: Schema.BigIntFromString,
    ranks: Schema.Array(Schema.NumberFromString),
    listed: Schema.DateTimeUtc,
    team: Team,
    player: Player,
  }) {}
  const byId = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  } as const
  const Teams = Entity.make({
    model: DynamoModel.configure(Team, { id: { identifier: true } }),
    entityType: "Team",
    primaryKey: byId,
  })
  const Players = Entity.make({
    model: DynamoModel.configure(Player, { id: { identifier: true } }),
    entityType: "Player",
    primaryKey: byId,
  })
  const Selections = Entity.make({
    model: DynamoModel.configure(Selection, {
      id: { identifier: true },
      team: { ref: true },
      player: { ref: true },
    }),
    entityType: "Selection",
    primaryKey: byId,
    refs: { team: { entity: Teams }, player: { entity: Players } },
  } as never) as any
  const at = (
    segments: ReadonlyArray<string>,
    value: unknown,
    kind: "value" | "contained" = "value",
  ) => operandAsStored(Selections._storedFormAt, segments, value, kind)

  it("into a ref, through the referenced entity's fields, and on the entity's own", () => {
    expect(at(["player", "id"], 5)).toBe("5")
    expect(at(["player", "shirt"], 9)).toBe("9")
    expect(at(["picks"], 3)).toBe("3")
    expect(at(["big"], 5n)).toBe("5")
    expect(at(["ranks"], 5, "contained")).toBe("5")
    // A number where the date is stored as text: the text a write of that date stores.
    expect(at(["listed"], 0)).toBe("1970-01-01T00:00:00.000Z")
  })

  it("as given where the attribute holds it so", () => {
    const asGiven: ReadonlyArray<readonly [ReadonlyArray<string>, unknown]> = [
      [["player", "id"], "5"],
      [["player", "name"], "P5"],
      [["team", "id"], "t1"],
      [["season"], "2025"],
      [["n"], 1],
      [["picks"], "3"],
      [["listed"], "2026-01"],
    ]
    for (const [segments, value] of asGiven) expect(at(segments, value)).toBe(value)
    expect(at(["ranks"], "5", "contained")).toBe("5")
  })

  it.effect("text where text is stored, a transform's included, as 1.41.0 sent it", () =>
    Effect.gen(function* () {
      // `"hello"` is stored as `"aGVsbG8="`, the set's member too. A text operand could be that
      // text, a substring of it or a prefix, so it's sent as given and matches as on 1.41.0.
      const E = Entity.make({
        model: Schema.Struct({
          id: Schema.String,
          body: Schema.StringFromBase64,
          tags: Schema.ReadonlySet(Schema.StringFromBase64),
        }),
        entityType: "E",
        primaryKey: byId,
      } as never) as any
      const table = makeRecordingTable()
      yield* run({ E }, table, (db) =>
        Effect.gen(function* () {
          yield* db.entities.E.put({ id: "a", body: "hello", tags: new Set(["hello"]) }).asEffect()
          const stored = table.items.get("$os#v1#e#id_a|$os#v1#e")!
          expect([stored.body, stored.tags]).toEqual([{ S: "aGVsbG8=" }, { SS: ["aGVsbG8="] }])
          table.take()
          const sent: Array<unknown> = []
          const found: Array<number> = []
          for (const filter of [
            (t: any, { contains }: any) => contains(t.tags, "aGVsbG8="),
            (t: any, { contains }: any) => contains(t.body, "bG"),
            (t: any, { beginsWith }: any) => beginsWith(t.body, "aGV"),
          ]) {
            found.push((yield* db.entities.E.scan().filter(filter).collect()).length)
            sent.push(table.take()[0]?.input.ExpressionAttributeValues?.[":e1"])
          }
          expect(sent).toEqual([{ S: "aGVsbG8=" }, { S: "bG" }, { S: "aGV" }])
          expect(found).toEqual([1, 1, 1])
        }),
      )
    }),
  )

  it("on a field named like a member every object inherits", () => {
    const E = Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        toString: Schema.String,
        constructor: Schema.NumberFromString,
      }),
      entityType: "E",
      primaryKey: byId,
    } as never) as any
    expect(operandAsStored(E._storedFormAt, ["toString"], "x", "value")).toBe("x")
    expect(operandAsStored(E._storedFormAt, ["constructor"], 5, "value")).toBe("5")
  })
})

describe("what isn't one of Effect's instances is sent as given where the field holds it so", () => {
  it.effect("a string, a number, a Date, a plain map and a path are the same request", () =>
    Effect.gen(function* () {
      const E = entityOf(Schema.Unknown)
      const table = makeRecordingTable()
      yield* run({ E }, table, (db) =>
        Effect.gen(function* () {
          const date = new Date(0)
          const map = { epochMilliseconds: 0, "~effect/DateTime": "~effect/DateTime", _tag: "Utc" }
          for (const value of ["x", 5, date, map]) {
            yield* db.entities.E.scan()
              .filter((t: any, { eq }: any) => eq(t.f, value))
              .collect()
            const [request] = table.take()
            expect(json(request?.input.ExpressionAttributeValues?.[":e1"])).toBe(
              json(toAttributeValue(value)),
            )
          }
          yield* db.entities.E.scan()
            .filter((t: any, { eq }: any) => eq(t.f, t.n))
            .collect()
          const [request] = table.take()
          expect(request?.input.FilterExpression).toBe("#eddE IN (:et0) AND (#e0 = #e1)")
        }),
      )
    }),
  )

  it.effect("a value type in an untyped field is the map it stores, as 1.40.0 sent it", () =>
    Effect.gen(function* () {
      const E = entityOf(Schema.Unknown)
      const table = makeRecordingTable()
      const at = () => DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" })
      yield* run({ E }, table, (db) =>
        Effect.gen(function* () {
          yield* db.entities.E.put({ id: "a", f: at() }).asEffect()
          const stored = table.items.get("$os#v1#e#id_a|$os#v1#e")!.f
          expect(json(stored)).toBe(json(toAttributeValue(at())))
          table.take()
          const items = yield* db.entities.E.scan().filter({ f: at() }).collect()
          expect(items).toHaveLength(1)
          const [request] = table.take()
          expect(json(request?.input.ExpressionAttributeValues?.[":e1"])).toBe(json(stored))
        }),
      )
    }),
  )

  it.effect("a value the field's schema doesn't take is sent as given", () =>
    Effect.gen(function* () {
      const E = entityOf(Schema.String)
      const table = makeRecordingTable()
      yield* run({ E }, table, (db) =>
        Effect.gen(function* () {
          const d = Duration.millis(1500)
          yield* db.entities.E.scan().filter({ f: d }).collect()
          const [request] = table.take()
          expect(json(request?.input.ExpressionAttributeValues?.[":e1"])).toBe(
            json(toAttributeValue(d)),
          )
        }),
      )
    }),
  )
})

describe("a collection's filter", () => {
  const member = (entityType: string, at: Schema.Top) =>
    Entity.make({
      model: Schema.Struct({ owner: Schema.String, id: Schema.String, at }),
      entityType,
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      indexes: {
        byOwner: {
          name: "gsi1",
          collection: "owned",
          pk: { field: "gsi1pk", composite: ["owner"] },
          sk: { field: "gsi1sk", composite: [] },
        },
      },
    } as never) as any
  const at = () => DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" })
  const iso = { S: "1970-01-01T01:00:00.000+01:00[Europe/London]" }

  it.effect("is one expression when every member holds the operand alike", () =>
    Effect.gen(function* () {
      const A = member("A", Schema.DateTimeZoned)
      const B = member("B", Schema.DateTimeZoned)
      const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      yield* run({ A, B }, table, (db) =>
        Effect.gen(function* () {
          yield* db.entities.A.put({ owner: "o", id: "a", at: at() }).asEffect()
          yield* db.entities.B.put({ owner: "o", id: "b", at: at() }).asEffect()
          table.take()
          const found = yield* db.collections.owned({ owner: "o" }).filter({ at: at() }).collect()
          expect([found.A.length, found.B.length]).toEqual([1, 1])
          const [request] = table.take()
          expect(request?.input.FilterExpression).not.toContain("OR")
          expect(json(request?.input.ExpressionAttributeValues?.[":e1"])).toBe(json(iso))
        }),
      )
    }),
  )

  it.effect("judges each member's rows by its own form when they differ", () =>
    Effect.gen(function* () {
      const A = member("A", Schema.DateTimeZoned)
      const B = member("B", Schema.Unknown)
      const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      yield* run({ A, B }, table, (db) =>
        Effect.gen(function* () {
          yield* db.entities.A.put({ owner: "o", id: "a", at: at() }).asEffect()
          yield* db.entities.B.put({ owner: "o", id: "b", at: at() }).asEffect()
          table.take()
          const found = yield* db.collections.owned({ owner: "o" }).filter({ at: at() }).collect()
          expect([found.A.length, found.B.length]).toEqual([1, 1])
          const [request] = table.take()
          expect(request?.input.FilterExpression).toContain("OR")
          const values = Object.values(request?.input.ExpressionAttributeValues ?? {}).map(json)
          expect(values).toContain(json(iso))
          expect(values).toContain(json(toAttributeValue(at())))
        }),
      )
    }),
  )

  it.effect("on a plain value is the one expression it was", () =>
    Effect.gen(function* () {
      const A = member("A", Schema.DateTimeZoned)
      const B = member("B", Schema.Unknown)
      const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      yield* run({ A, B }, table, (db) =>
        Effect.gen(function* () {
          yield* db.collections.owned({ owner: "o" }).filter({ id: "a" }).collect()
          const [request] = table.take()
          expect(request?.input.FilterExpression).toBe("#eddE IN (:et0, :et1) AND (#e0 = :e1)")
        }),
      )
    }),
  )
})

describe("an aggregate list filter", () => {
  it.effect("compares a root field's value as the root row holds it", () =>
    Effect.gen(function* () {
      const Root = Schema.Struct({
        id: Schema.String,
        tournament: Schema.String,
        at: Schema.DateTimeZoned,
        d: Schema.DurationFromMillis,
      })
      const Anchors = Entity.make({
        model: Schema.Struct({ anchorId: Schema.String }),
        entityType: "Anchor",
        primaryKey: {
          pk: { field: "pk", composite: ["anchorId"] },
          sk: { field: "sk", composite: [] },
        },
      })
      const Main = Table.make({ schema, entities: { Anchors } })
      const Matches = Aggregate.make(Root, {
        table: Main,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "match" },
        list: {
          index: "gsi1",
          name: "matchlist",
          pk: { field: "gsi1pk", composite: ["tournament"] },
          sk: { field: "gsi1sk", composite: ["id"] },
        },
        root: { entityType: "MatchItem" },
        edges: {},
      } as never) as any
      const at = () => DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" })
      const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      yield* run(
        { Anchors },
        table,
        (db) =>
          Effect.gen(function* () {
            yield* db.aggregates.Matches.create({
              id: "m",
              tournament: "t",
              at: at(),
              d: Duration.millis(1500),
            })
            table.take()
            for (const filter of [{ at: at() }, { d: Duration.millis(1500) }]) {
              const listed = yield* db.aggregates.Matches.list({ tournament: "t" }, { filter })
              expect(listed.data).toHaveLength(1)
              const request = table.take().find((sent) => sent.input.FilterExpression !== undefined)
              const sent = Object.values(request?.input.ExpressionAttributeValues ?? {}).map(json)
              expect(sent).toContain(
                json(
                  "at" in filter
                    ? { S: "1970-01-01T01:00:00.000+01:00[Europe/London]" }
                    : { N: "1500" },
                ),
              )
            }
            const missed = yield* db.aggregates.Matches.list(
              { tournament: "t" },
              { filter: { at: DateTime.makeZonedUnsafe(1, { timeZone: "Europe/London" }) } },
            )
            expect(missed.data).toEqual([])
          }),
        { Matches },
        Main,
      )
    }),
  )
})

describe("a `.where()` bound composes key text through the key form, as it did", () => {
  it.effect("eq and between on a zoned sort key composite", () =>
    Effect.gen(function* () {
      const E = Entity.make({
        model: Schema.Struct({ id: Schema.String, at: Schema.DateTimeZoned }),
        entityType: "E",
        primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
        indexes: {
          byAt: {
            name: "gsi1",
            pk: { field: "gsi1pk", composite: ["id"] },
            sk: { field: "gsi1sk", composite: ["at"] },
          },
        },
      } as never) as any
      const at = DateTime.makeZonedUnsafe(0, { timeZone: "Europe/London" })
      const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
      yield* run({ E }, table, (db) =>
        Effect.gen(function* () {
          yield* db.entities.E.put({ id: "a", at }).asEffect()
          const equal = yield* db.entities.E.byAt({ id: "a" })
            .where((t: any, { eq }: any) => eq(t.at, at))
            .collect()
          const within = yield* db.entities.E.byAt({ id: "a" })
            .where((t: any, { between }: any) =>
              between(t.at, DateTime.subtract(at, { hours: 1 }), DateTime.add(at, { hours: 1 })),
            )
            .collect()
          expect([equal.length, within.length]).toEqual([1, 1])
        }),
      )
    }),
  )
})
