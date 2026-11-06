/**
 * Values with no stored form. DynamoDB can't store `undefined` or an empty set, so on a field
 * whose stored side includes one the value is an absent attribute, and an absent attribute reads
 * back as that value. These run on a recording table (`Entity.clears.test.ts`) and on DynamoDB
 * Local (`connected.clears.test.ts`), through a {@link Harness}.
 *
 * Also here: what a relative update reports when the row it landed no longer decodes.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { Effect, HashSet, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import {
  type Harness,
  key,
  live,
  type Probe,
  refused,
  type Scenario,
  schema,
  worldOf,
} from "./ClearScenarios.js"

const Strings = Schema.ReadonlySet(Schema.String)
const empty = () => new Set<string>()
const isEmptySet = (value: unknown) => {
  expect(value).toBeInstanceOf(Set)
  expect((value as Set<unknown>).size).toBe(0)
}
const isUndefined = (value: unknown) => expect(value).toBeUndefined()

/** A required field whose stored side includes a value with no stored form. */
interface Kind {
  readonly name: string
  readonly field: Schema.Top
  /** The value with no stored form. */
  readonly none: () => unknown
  readonly isNone: (read: unknown) => void
  /** A value with a stored form, and that form. */
  readonly value: () => unknown
  readonly stored: AttributeValue
  readonly isValue: (read: unknown) => void
}

const KINDS: ReadonlyArray<Kind> = [
  {
    name: "a required set",
    field: Strings,
    none: empty,
    isNone: isEmptySet,
    value: () => new Set(["a", "b"]),
    stored: { SS: ["a", "b"] },
    isValue: (read) => expect(read).toEqual(new Set(["a", "b"])),
  },
  {
    name: "a required number set",
    field: Schema.ReadonlySet(Schema.Number),
    none: () => new Set<number>(),
    isNone: isEmptySet,
    value: () => new Set([1, 2]),
    stored: { NS: ["1", "2"] },
    isValue: (read) => expect(read).toEqual(new Set([1, 2])),
  },
  {
    name: "a required UndefinedOr",
    field: Schema.UndefinedOr(Schema.String),
    none: () => undefined,
    isNone: isUndefined,
    value: () => "x",
    stored: { S: "x" },
    isValue: (read) => expect(read).toBe("x"),
  },
  {
    name: "a required Unknown",
    field: Schema.Unknown,
    none: () => undefined,
    isNone: isUndefined,
    value: () => "x",
    stored: { S: "x" },
    isValue: (read) => expect(read).toBe("x"),
  },
  {
    name: "a required NullOr of a set",
    field: Schema.NullOr(Strings),
    none: empty,
    isNone: isEmptySet,
    value: () => null,
    stored: { NULL: true },
    isValue: (read) => expect(read).toBeNull(),
  },
  {
    name: "a required UndefinedOr of a set, where an absent attribute means undefined",
    field: Schema.UndefinedOr(Strings),
    none: () => undefined,
    isNone: isUndefined,
    value: () => new Set(["a"]),
    stored: { SS: ["a"] },
    isValue: (read) => expect(read).toEqual(new Set(["a"])),
  },
]

const modelOf = (kind: Kind) => Schema.Struct({ id: Schema.String, f: kind.field as never })

const CLEARS: ReadonlyArray<{ readonly name: string; readonly op: (kind: Kind, u: any) => any }> = [
  { name: ".set of the value", op: (kind, u) => u.set({ f: kind.none() }) },
  { name: ".set({ f: undefined })", op: (_kind, u) => u.set({ f: undefined }) },
  { name: ".remove", op: (_kind, u) => u.remove(["f"]) },
  { name: "pathRemove", op: (_kind, u) => u.pathRemove(["f"]) },
  {
    name: "pathSet of the value",
    op: (kind, u) => u.pathSet({ segments: ["f"], value: kind.none(), isPath: false }),
  },
]

const LIFECYCLES: ReadonlyArray<{
  readonly name: string
  readonly options: Record<string, unknown>
}> = [
  { name: "plain", options: {} },
  { name: "versioned", options: { versioned: true } },
  { name: "retained versions", options: { versioned: { retain: true } } },
  { name: "soft delete", options: { versioned: true, softDelete: true } },
]

const kindScenarios: ReadonlyArray<Scenario> = KINDS.flatMap((kind) =>
  LIFECYCLES.flatMap(({ name: lifecycle, options }) => {
    const world = () => worldOf(modelOf(kind), options)
    const on = (h: Harness, body: (db: any, probe: any) => Effect.Effect<void, unknown, any>) =>
      h.on(world(), body)
    const putValue = (db: any) => db.entities.Rows.put({ id: "1", f: kind.value() }).asEffect()
    return [
      {
        name: `${kind.name}, ${lifecycle}: a put stores nothing for it, and every read gives the value`,
        run: (h: Harness) =>
          on(h, (db, probe) =>
            Effect.gen(function* () {
              const put = yield* db.entities.Rows.put({ id: "1", f: kind.none() }).asEffect()
              kind.isNone(put.f)
              expect(live(yield* probe.rows())!.f).toBeUndefined()
              const read = yield* db.entities.Rows.get(key)
              kind.isNone(read.f)
              // The key is there: a required field stays one on the type a reader holds.
              expect("f" in read).toBe(true)
              const scanned = yield* db.entities.Rows.scan().collect()
              expect(scanned).toHaveLength(1)
              kind.isNone(scanned[0].f)
            }),
          ),
      },
      {
        name: `${kind.name}, ${lifecycle}: any other value is stored as it always was`,
        run: (h: Harness) =>
          on(h, (db, probe) =>
            Effect.gen(function* () {
              yield* putValue(db)
              expect(live(yield* probe.rows())!.f).toEqual(kind.stored)
              kind.isValue((yield* db.entities.Rows.get(key)).f)
              yield* db.entities.Rows.update(key).set({ f: kind.none() }).asEffect()
              yield* db.entities.Rows.update(key).set({ f: kind.value() }).asEffect()
              expect(live(yield* probe.rows())!.f).toEqual(kind.stored)
              kind.isValue((yield* db.entities.Rows.get(key)).f)
            }),
          ),
      },
      ...CLEARS.flatMap(({ name, op }) => [
        {
          name: `${kind.name}, ${lifecycle}: ${name} takes the attribute away, and it reads as the value`,
          run: (h: Harness) =>
            on(h, (db, probe) =>
              Effect.gen(function* () {
                yield* putValue(db)
                const returned = yield* op(kind, db.entities.Rows.update(key)).asEffect()
                kind.isNone(returned.f)
                expect(live(yield* probe.rows())!.f).toBeUndefined()
                kind.isNone((yield* db.entities.Rows.get(key)).f)
              }),
            ),
        },
        {
          name: `${kind.name}, ${lifecycle}: ${name} in a transaction`,
          run: (h: Harness) =>
            on(h, (db, probe) =>
              Effect.gen(function* () {
                yield* putValue(db)
                yield* Transaction.transactWrite([op(kind, db.entities.Rows.update(key))])
                expect(live(yield* probe.rows())!.f).toBeUndefined()
                kind.isNone((yield* db.entities.Rows.get(key)).f)
              }),
            ),
        },
      ]),
      {
        name: `${kind.name}, ${lifecycle}: a put in a transaction, read by transactGet`,
        run: (h: Harness) =>
          on(h, (db, probe) =>
            Effect.gen(function* () {
              yield* Transaction.transactWrite([db.entities.Rows.put({ id: "1", f: kind.none() })])
              expect(live(yield* probe.rows())!.f).toBeUndefined()
              const [read] = yield* Transaction.transactGet([db.entities.Rows.get(key)])
              kind.isNone((read as any).f)
            }),
          ),
      },
    ]
  }),
)

/** Reading a row without the field through everything that keeps or returns it. */
const kindLifecycleScenarios: ReadonlyArray<Scenario> = KINDS.flatMap((kind) => [
  {
    name: `${kind.name}: Batch.write and Batch.get`,
    run: (h: Harness) =>
      h.on(worldOf(modelOf(kind)), (db, probe) =>
        Effect.gen(function* () {
          yield* Batch.write([db.entities.Rows.put({ id: "1", f: kind.none() })])
          expect(live(yield* probe.rows())!.f).toBeUndefined()
          const [read] = yield* Batch.get([db.entities.Rows.get(key)])
          kind.isNone((read as any).f)
        }),
      ),
  },
  {
    name: `${kind.name}: a versioned Batch.write`,
    run: (h: Harness) =>
      h.on(worldOf(modelOf(kind), { versioned: true }), (db, probe) =>
        Effect.gen(function* () {
          yield* Batch.write([db.entities.Rows.put({ id: "1", f: kind.none() })])
          expect(live(yield* probe.rows())!.f).toBeUndefined()
          kind.isNone((yield* db.entities.Rows.get(key)).f)
        }),
      ),
  },
  {
    name: `${kind.name}: a retained snapshot holds the row as it was, and reads`,
    run: (h: Harness) =>
      h.on(worldOf(modelOf(kind), { versioned: { retain: true } }), (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", f: kind.none() }).asEffect()
          yield* db.entities.Rows.update(key).set({ f: kind.value() }).asEffect()
          yield* db.entities.Rows.update(key).remove(["f"]).asEffect()
          kind.isNone((yield* db.entities.Rows.getVersion(key, 1)).f)
          kind.isValue((yield* db.entities.Rows.getVersion(key, 2)).f)
          kind.isNone((yield* db.entities.Rows.get(key)).f)
          const versions = yield* db.entities.Rows.versions(key).collect()
          expect(versions.length).toBeGreaterThan(0)
        }),
      ),
  },
  {
    name: `${kind.name}: a soft delete and a restore`,
    run: (h: Harness) =>
      h.on(worldOf(modelOf(kind), { versioned: true, softDelete: true }), (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", f: kind.none() }).asEffect()
          yield* db.entities.Rows.delete(key).asEffect()
          kind.isNone((yield* db.entities.Rows.deleted.get(key)).f)
          yield* db.entities.Rows.restore(key)
          kind.isNone((yield* db.entities.Rows.get(key)).f)
        }),
      ),
  },
  {
    name: `${kind.name}: an upsert replaces what the row holds, and creates without it`,
    run: (h: Harness) =>
      h.on(worldOf(modelOf(kind)), (db, probe) =>
        Effect.gen(function* () {
          const created = yield* db.entities.Rows.upsert({ id: "2", f: kind.none() }).asEffect()
          kind.isNone(created.f)
          expect(live(yield* probe.rows(), "2")!.f).toBeUndefined()
          yield* db.entities.Rows.put({ id: "1", f: kind.value() }).asEffect()
          const replaced = yield* db.entities.Rows.upsert({ id: "1", f: kind.none() }).asEffect()
          kind.isNone(replaced.f)
          expect(live(yield* probe.rows())!.f).toBeUndefined()
          kind.isNone((yield* db.entities.Rows.get(key)).f)
        }),
      ),
  },
  {
    name: `${kind.name}: an update of a missing row creates it, as the put it stands for`,
    run: (h: Harness) =>
      h.on(worldOf(modelOf(kind)), (db, probe) =>
        Effect.gen(function* () {
          const created = yield* db.entities.Rows.update(key)
            .set({ id: "1", f: kind.none() })
            .asEffect()
          kind.isNone(created.f)
          expect(live(yield* probe.rows())!.f).toBeUndefined()
          kind.isNone((yield* db.entities.Rows.get(key)).f)
        }),
      ),
  },
  {
    name: `${kind.name}: an append takes it off the current item, and neither row holds it`,
    run: (h: Harness) => {
      const world = worldOf(
        Schema.Struct({ id: Schema.String, at: Schema.Number, f: kind.field as never }),
        {
          timeSeries: {
            orderBy: "at",
            appendInput: Schema.Struct({
              id: Schema.String,
              at: Schema.Number,
              f: kind.field as never,
            }),
          },
        },
      )
      return h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.append({ id: "1", at: 1, f: kind.value() }).asEffect()
          expect(live(yield* probe.rows())!.f).toEqual(kind.stored)
          const { current } = yield* db.entities.Rows.append({
            id: "1",
            at: 2,
            f: kind.none(),
          }).asEffect()
          kind.isNone(current.f)
          expect(live(yield* probe.rows())!.f).toBeUndefined()
          kind.isNone((yield* db.entities.Rows.get(key)).f)
          const history = yield* db.entities.Rows.history(key).collect()
          const events = [...history].sort((a: any, b: any) => a.at - b.at)
          kind.isValue(events[0].f)
          kind.isNone(events[1].f)
        }),
      )
    },
  },
])

// ---------------------------------------------------------------------------
// Sets, beyond the operations every kind has
// ---------------------------------------------------------------------------

const Tagged = Schema.Struct({ id: Schema.String, tags: Strings })
const seedTags = (db: any, ...tags: ReadonlyArray<string>) =>
  db.entities.Rows.put({ id: "1", tags: new Set(tags) }).asEffect()

const setScenarios: ReadonlyArray<Scenario> = LIFECYCLES.flatMap(({ name, options }) => [
  {
    name: `${name}: deleteFromSet emptying a required set leaves a row that reads`,
    run: (h: Harness) =>
      h.on(worldOf(Tagged, options), (db, probe) =>
        Effect.gen(function* () {
          yield* seedTags(db, "a")
          const returned = yield* db.entities.Rows.update(key)
            .deleteFromSet({ tags: new Set(["a"]) })
            .asEffect()
          isEmptySet(returned.tags)
          expect(live(yield* probe.rows())!.tags).toBeUndefined()
          isEmptySet((yield* db.entities.Rows.get(key)).tags)
        }),
      ),
  },
  {
    name: `${name}: adding to a set a row is without creates it`,
    run: (h: Harness) =>
      h.on(worldOf(Tagged, options), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", tags: empty() }).asEffect()
          yield* db.entities.Rows.update(key)
            .add({ tags: new Set(["a"]) })
            .asEffect()
          expect(live(yield* probe.rows())!.tags).toEqual({ SS: ["a"] })
        }),
      ),
  },
  {
    name: `${name}: adding to a set a row holds is the union, as DynamoDB's ADD is`,
    run: (h: Harness) =>
      h.on(worldOf(Tagged, options), (db, probe) =>
        Effect.gen(function* () {
          yield* seedTags(db, "a")
          const returned = yield* db.entities.Rows.update(key)
            .add({ tags: new Set(["b"]) })
            .asEffect()
          expect(returned.tags).toEqual(new Set(["a", "b"]))
          const stored = live(yield* probe.rows())!.tags as { readonly SS: ReadonlyArray<string> }
          expect([...stored.SS].sort()).toEqual(["a", "b"])
        }),
      ),
  },
  {
    name: `${name}: adding or deleting an empty set is nothing to do, and DynamoDB isn't asked to`,
    run: (h: Harness) =>
      h.on(worldOf(Tagged, options), (db, probe) =>
        Effect.gen(function* () {
          yield* seedTags(db, "a")
          for (const op of [
            (u: any) => u.add({ tags: empty() }),
            (u: any) => u.deleteFromSet({ tags: empty() }),
            (u: any) => u.pathAdd({ segments: ["tags"], value: empty() }),
            (u: any) => u.pathDelete({ segments: ["tags"], value: empty() }),
            (u: any) => u.pathIfNotExists({ segments: ["other"], value: empty() }),
          ]) {
            const returned = yield* op(db.entities.Rows.update(key)).asEffect()
            expect(returned.tags).toEqual(new Set(["a"]))
          }
          expect(live(yield* probe.rows())!.tags).toEqual({ SS: ["a"] })
        }),
      ),
  },
])

const Detailed = (() => {
  const fields = { tags: Strings, note: Schema.UndefinedOr(Schema.String), label: Schema.String }
  class Detail extends Schema.Class<Detail>("NoStoredFormDetail")(fields) {}
  const Plain = Schema.Struct(fields)
  return {
    Detail,
    model: Schema.Struct({
      id: Schema.String,
      detail: Detail,
      plain: Plain,
      list: Schema.Array(Plain),
      maybe: Schema.optional(Plain),
      entries: Schema.Record(Schema.String, Plain),
    }),
    none: { tags: empty(), note: undefined, label: "l" },
    some: { tags: new Set(["a"]), note: "n", label: "l" },
  }
})()

const noneRead = (read: any) => {
  isEmptySet(read.tags)
  expect("note" in read).toBe(true)
  expect(read.note).toBeUndefined()
  expect(read.label).toBe("l")
}
const noneStored = { M: { label: { S: "l" } } }
const someStored = { M: { tags: { SS: ["a"] }, note: { S: "n" }, label: { S: "l" } } }

const nestedInput = (detail: typeof Detailed.none | typeof Detailed.some) => ({
  id: "1",
  detail: new Detailed.Detail(detail as never),
  plain: detail,
  list: [detail],
  maybe: detail,
  entries: { k: detail },
})

const nestedScenarios: ReadonlyArray<Scenario> = [
  {
    name: "nested in a class, a struct, a list, an optional and a record: stored without them, read with them",
    run: (h) =>
      h.on(worldOf(Detailed.model), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(nestedInput(Detailed.none)).asEffect()
          const row = live(yield* probe.rows())!
          expect(row.detail).toEqual(noneStored)
          expect(row.plain).toEqual(noneStored)
          expect(row.list).toEqual({ L: [noneStored] })
          expect(row.maybe).toEqual(noneStored)
          expect(row.entries).toEqual({ M: { k: noneStored } })
          const read = yield* db.entities.Rows.get(key)
          expect(read.detail).toBeInstanceOf(Detailed.Detail)
          noneRead(read.detail)
          noneRead(read.plain)
          noneRead(read.list[0])
          noneRead(read.maybe)
          noneRead(read.entries.k)
        }),
      ),
  },
  {
    name: "nested values with a stored form are stored as they always were",
    run: (h) =>
      h.on(worldOf(Detailed.model), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(nestedInput(Detailed.some)).asEffect()
          const row = live(yield* probe.rows())!
          expect(row.detail).toEqual(someStored)
          expect(row.list).toEqual({ L: [someStored] })
          const read = yield* db.entities.Rows.get(key)
          expect(read.plain.tags).toEqual(new Set(["a"]))
          expect(read.list[0].note).toBe("n")
        }),
      ),
  },
  {
    name: "a nested .set stores the map without them",
    run: (h) =>
      h.on(worldOf(Detailed.model), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(nestedInput(Detailed.some)).asEffect()
          const returned = yield* db.entities.Rows.update(key)
            .set({ plain: Detailed.none })
            .asEffect()
          noneRead(returned.plain)
          expect(live(yield* probe.rows())!.plain).toEqual(noneStored)
        }),
      ),
  },
  ...(
    [
      ["tags", (read: any) => isEmptySet(read.tags)],
      ["note", (read: any) => expect(read.note).toBeUndefined()],
    ] as const
  ).flatMap(([field, check]) => [
    {
      name: `a nested ${field} can be cleared by path: it isn't required`,
      run: (h: Harness) =>
        h.on(worldOf(Detailed.model), (db: any) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put(nestedInput(Detailed.some)).asEffect()
            const returned = yield* db.entities.Rows.update(key)
              .pathRemove(["plain", field])
              .asEffect()
            check(returned.plain)
            check((yield* db.entities.Rows.get(key)).plain)
          }),
        ),
    },
  ]),
  {
    name: "a nested pathSet of an empty set clears the path",
    run: (h) =>
      h.on(worldOf(Detailed.model), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(nestedInput(Detailed.some)).asEffect()
          const returned = yield* db.entities.Rows.update(key)
            .pathSet({ segments: ["plain", "tags"], value: empty(), isPath: false })
            .asEffect()
          isEmptySet(returned.plain.tags)
          expect((live(yield* probe.rows())!.plain as any).M.tags).toBeUndefined()
        }),
      ),
  },
  {
    name: "a nested required field beside them is still refused",
    run: (h) =>
      h.on(worldOf(Detailed.model), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put(nestedInput(Detailed.some)).asEffect()
          yield* refused(
            db,
            probe,
            () => db.entities.Rows.update(key).pathRemove(["plain", "label"]).asEffect(),
            /the model requires it/,
          )
        }),
      ),
  },
]

/** A field left optional stays as it is: absent reads as absent. */
const optionalScenarios: ReadonlyArray<Scenario> = [
  {
    name: "an optional set: a put of an empty one stores nothing and reads as absent",
    run: (h) =>
      h.on(
        worldOf(Schema.Struct({ id: Schema.String, f: Schema.optional(Strings) })),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", f: empty() }).asEffect()
            expect(live(yield* probe.rows())!.f).toBeUndefined()
            expect("f" in (yield* db.entities.Rows.get(key))).toBe(false)
          }),
      ),
  },
  {
    name: "an optional set: .set of an empty one takes the attribute away and reads as absent",
    run: (h) =>
      h.on(
        worldOf(Schema.Struct({ id: Schema.String, f: Schema.optionalKey(Strings) })),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", f: new Set(["a"]) }).asEffect()
            yield* db.entities.Rows.update(key).set({ f: empty() }).asEffect()
            expect(live(yield* probe.rows())!.f).toBeUndefined()
            expect("f" in (yield* db.entities.Rows.get(key))).toBe(false)
          }),
      ),
  },
  {
    name: "an optional field left undefined by an upsert or an append keeps what the row holds",
    run: (h) =>
      h.on(
        worldOf(
          Schema.Struct({
            id: Schema.String,
            at: Schema.Number,
            f: Schema.optional(Schema.String),
          }),
          {
            timeSeries: {
              orderBy: "at",
              appendInput: Schema.Struct({
                id: Schema.String,
                at: Schema.Number,
                f: Schema.optional(Schema.String),
              }),
            },
          },
        ),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.append({ id: "1", at: 1, f: "x" }).asEffect()
            yield* db.entities.Rows.append({ id: "1", at: 2, f: undefined }).asEffect()
            expect(live(yield* probe.rows())!.f).toEqual({ S: "x" })
          }),
      ),
  },
  {
    name: "an optional field left undefined by an upsert keeps what the row holds",
    run: (h) =>
      h.on(
        worldOf(Schema.Struct({ id: Schema.String, f: Schema.optional(Schema.String) })),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", f: "x" }).asEffect()
            yield* db.entities.Rows.upsert({ id: "1", f: undefined }).asEffect()
            expect(live(yield* probe.rows())!.f).toEqual({ S: "x" })
          }),
      ),
  },
  {
    name: "a decoding default stays the default",
    run: (h) =>
      h.on(
        worldOf(
          Schema.Struct({
            id: Schema.String,
            f: Schema.UndefinedOr(Schema.String).pipe(
              Schema.withDecodingDefaultKey(Effect.succeed("d")),
            ),
          }),
        ),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", f: undefined }).asEffect()
            expect(live(yield* probe.rows())!.f).toBeUndefined()
            expect((yield* db.entities.Rows.get(key)).f).toBe("d")
          }),
      ),
  },
]

const NonEmpty = Schema.Struct({
  id: Schema.String,
  tags: Strings.check(Schema.isMinSize(1)),
})

const List = Schema.Struct({ id: Schema.String, lists: Schema.Array(Strings) })

/** Where the rule has no reading: the schema says otherwise, or a list can't lack an element. */
const refusalScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a set that must not be empty: a put of an empty one is refused",
    run: (h) =>
      h.on(worldOf(NonEmpty), (db, probe) =>
        Effect.gen(function* () {
          const sent = probe.sent()
          const error: any = yield* db.entities.Rows.put({ id: "1", tags: empty() })
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect(probe.sent()).toBe(sent)
        }),
      ),
  },
  {
    name: "a set that must not be empty: .set of an empty one is refused by the schema",
    run: (h) =>
      h.on(worldOf(NonEmpty), (db, probe) =>
        Effect.gen(function* () {
          yield* seedTags(db, "a")
          yield* refused(
            db,
            probe,
            () => db.entities.Rows.update(key).set({ tags: empty() }).asEffect(),
            /size of at least 1/,
          )
        }),
      ),
  },
  {
    name: "a set that must not be empty: .remove is refused",
    run: (h) =>
      h.on(worldOf(NonEmpty), (db, probe) =>
        Effect.gen(function* () {
          yield* seedTags(db, "a")
          yield* refused(
            db,
            probe,
            () => db.entities.Rows.update(key).remove(["tags"]).asEffect(),
            /the model requires "tags"/,
          )
        }),
      ),
  },
  {
    name: "a list of sets: an empty element is refused, because leaving it out moves the rest",
    run: (h) =>
      h.on(worldOf(List), (db, probe) =>
        Effect.gen(function* () {
          const sent = probe.sent()
          const error: any = yield* db.entities.Rows.put({
            id: "1",
            lists: [new Set(["a"]), empty()],
          })
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect(String(error.cause)).toMatch(/list element can't be left out/)
          expect(probe.sent()).toBe(sent)
        }),
      ),
  },
  {
    name: "a list of nullable sets: an empty element is refused too, and a null one stored",
    run: (h) =>
      h.on(
        worldOf(Schema.Struct({ id: Schema.String, lists: Schema.Array(Schema.NullOr(Strings)) })),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", lists: [null, new Set(["a"])] }).asEffect()
            expect(live(yield* probe.rows())!.lists).toEqual({
              L: [{ NULL: true }, { SS: ["a"] }],
            })
            const error: any = yield* db.entities.Rows.put({ id: "1", lists: [empty()] })
              .asEffect()
              .pipe(Effect.flip)
            expect(error._tag).toBe("ValidationError")
          }),
      ),
  },
  {
    name: "a list of sets: non-empty elements are stored as they were",
    run: (h) =>
      h.on(worldOf(List), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", lists: [new Set(["a"])] }).asEffect()
          expect(live(yield* probe.rows())!.lists).toEqual({ L: [{ SS: ["a"] }] })
          expect((yield* db.entities.Rows.get(key)).lists).toEqual([new Set(["a"])])
        }),
      ),
  },
  {
    name: "a list of sets: pathSet of an element to an empty set is refused",
    run: (h) =>
      h.on(worldOf(List), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", lists: [new Set(["a"])] }).asEffect()
          yield* refused(
            db,
            probe,
            () =>
              db.entities.Rows.update(key)
                .pathSet({ segments: ["lists", 0], value: empty(), isPath: false })
                .asEffect(),
            /a list element can't be left out/,
          )
        }),
      ),
  },
]

const immutableScenarios: ReadonlyArray<Scenario> = [
  {
    name: "an immutable set: an upsert of an empty one leaves what the row holds",
    run: (h) =>
      h.on(worldOf(DynamoModel.configure(Tagged, { tags: { immutable: true } })), (db, probe) =>
        Effect.gen(function* () {
          yield* seedTags(db, "a")
          yield* db.entities.Rows.upsert({ id: "1", tags: empty() }).asEffect()
          expect(live(yield* probe.rows())!.tags).toEqual({ SS: ["a"] })
        }),
      ),
  },
  {
    name: "an append's empty set is refused on a model field that must not be empty",
    run: (h) => {
      const world = worldOf(
        Schema.Struct({
          id: Schema.String,
          at: Schema.Number,
          held: Strings.check(Schema.isMinSize(1)),
        }),
        {
          timeSeries: {
            orderBy: "at",
            appendInput: Schema.Struct({ id: Schema.String, at: Schema.Number, held: Strings }),
          },
        },
      )
      return h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.append({ id: "1", at: 1, held: new Set(["a"]) }).asEffect()
          yield* refused(
            db,
            probe,
            () => db.entities.Rows.append({ id: "1", at: 2, held: empty() }).asEffect(),
            /the model requires "held"/,
          )
        }),
      )
    },
  },
]

const DecodeSorted = SchemaGetter.transform((set: ReadonlySet<string>) => [...set].sort())
const EncodeSet = SchemaGetter.transform((list: ReadonlyArray<string>) => new Set(list))
const ToSet = EncodeSet
const ToArray = SchemaGetter.transform((set: ReadonlySet<string>) => [...set])

const shapeScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a value a transform encodes to an empty set but won't decode back is refused, nothing sent",
    run: (h) => {
      const Joined = Strings.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transformEffect((set: ReadonlySet<string>) =>
            set.size === 0
              ? Effect.fail(new SchemaIssue.InvalidValue({ message: "empty" }, set))
              : Effect.succeed([...set].join(",")),
          ),
          encode: SchemaGetter.transform(
            (joined: string) => new Set(joined === "" ? [] : joined.split(",")),
          ),
        }),
      )
      return h.on(worldOf(Schema.Struct({ id: Schema.String, joined: Joined })), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", joined: "a,b" }).asEffect()
          yield* refused(
            db,
            probe,
            () => db.entities.Rows.update(key).set({ joined: "" }).asEffect(),
            /the model requires "joined"/,
          )
        }),
      )
    },
  },
  {
    name: "a required set in a union: a row of a later member stays that member's",
    run: (h) => {
      const A = Schema.Struct({ tags: Strings })
      const B = Schema.Struct({ b: Schema.Number })
      return h.on(
        worldOf(Schema.Struct({ id: Schema.String, u: Schema.Union([A, B]) })),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", u: { b: 1 } }).asEffect()
            expect((yield* db.entities.Rows.get(key)).u).toEqual({ b: 1 })
            yield* db.entities.Rows.put({ id: "1", u: { tags: empty() } }).asEffect()
            expect((live(yield* probe.rows())!.u as any).M).toEqual({})
            isEmptySet((yield* db.entities.Rows.get(key)).u.tags)
          }),
      )
    },
  },
  {
    name: "a required set in a oneOf union stays as declared: two members can't both take a row",
    run: (h) => {
      const A = Schema.Struct({ tags: Strings })
      const B = Schema.Struct({ b: Schema.Number })
      return h.on(
        worldOf(Schema.Struct({ id: Schema.String, u: Schema.Union([A, B], { mode: "oneOf" }) })),
        (db) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", u: { b: 1 } }).asEffect()
            expect((yield* db.entities.Rows.get(key)).u).toEqual({ b: 1 })
            yield* db.entities.Rows.put({ id: "1", u: { tags: new Set(["a"]) } }).asEffect()
            expect((yield* db.entities.Rows.get(key)).u.tags).toEqual(new Set(["a"]))
          }),
      )
    },
  },
  {
    name: "a stored set behind a transformation: the domain value it encodes from is what reads back",
    run: (h) => {
      return h.on(
        worldOf(
          Schema.Struct({
            id: Schema.String,
            f: Strings.pipe(
              Schema.decodeTo(Schema.Array(Schema.String), {
                decode: DecodeSorted,
                encode: EncodeSet,
              } as never),
            ),
          }),
        ),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", f: ["b", "a"] }).asEffect()
            const stored = live(yield* probe.rows())!.f as { readonly SS: ReadonlyArray<string> }
            expect([...stored.SS].sort()).toEqual(["a", "b"])
            expect((yield* db.entities.Rows.get(key)).f).toEqual(["a", "b"])
            yield* db.entities.Rows.update(key).set({ f: [] }).asEffect()
            expect(live(yield* probe.rows())!.f).toBeUndefined()
            expect((yield* db.entities.Rows.get(key)).f).toEqual([])
          }),
      )
    },
  },
  {
    name: "a domain set stored as a list: an empty one is an empty list, and can be stored",
    run: (h) =>
      h.on(
        worldOf(
          Schema.Struct({
            id: Schema.String,
            f: Schema.Array(Schema.String).pipe(
              Schema.decodeTo(Strings, { decode: ToSet, encode: ToArray } as never),
            ),
          }),
        ),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", f: new Set(["a"]) }).asEffect()
            yield* db.entities.Rows.update(key).set({ f: empty() }).asEffect()
            expect(live(yield* probe.rows())!.f).toEqual({ L: [] })
            yield* refused(
              db,
              probe,
              () => db.entities.Rows.update(key).remove(["f"]).asEffect(),
              /the model requires "f"/,
            )
          }),
      ),
  },
  {
    name: "a record of sets: an entry holding an empty one isn't stored, and reads as no entry",
    run: (h) =>
      h.on(
        worldOf(Schema.Struct({ id: Schema.String, r: Schema.Record(Schema.String, Strings) })),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({
              id: "1",
              r: { a: empty(), b: new Set(["x"]) },
            }).asEffect()
            expect(live(yield* probe.rows())!.r).toEqual({ M: { b: { SS: ["x"] } } })
            expect((yield* db.entities.Rows.get(key)).r).toEqual({ b: new Set(["x"]) })
          }),
      ),
  },
  {
    name: "a sparse map of sets: an entry set to an empty one is taken away",
    run: (h) =>
      h.on(
        worldOf(
          DynamoModel.configure(
            Schema.Struct({ id: Schema.String, r: Schema.Record(Schema.String, Strings) }),
            { r: { storedAs: DynamoModel.SparseMap() } },
          ),
        ),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({
              id: "1",
              r: { a: new Set(["x"]), b: new Set(["y"]), c: empty() },
            }).asEffect()
            let row = live(yield* probe.rows())!
            expect(row["r#a"]).toEqual({ SS: ["x"] })
            expect(row["r#c"]).toBeUndefined()
            yield* db.entities.Rows.update(key)
              .set({ r: { a: empty() } })
              .asEffect()
            row = live(yield* probe.rows())!
            expect(row["r#a"]).toBeUndefined()
            expect(row["r#b"]).toEqual({ SS: ["y"] })
            yield* db.entities.Rows.upsert({ id: "1", r: { b: empty() } }).asEffect()
            expect(live(yield* probe.rows())!["r#b"]).toBeUndefined()
          }),
      ),
  },
  {
    name: "a renamed field: the stored name is what's left out and what's taken away",
    run: (h) =>
      h.on(
        worldOf(
          DynamoModel.configure(Tagged, {
            tags: { field: "t" },
          }),
        ),
        (db, probe) =>
          Effect.gen(function* () {
            yield* seedTags(db, "a")
            expect(live(yield* probe.rows())!.t).toEqual({ SS: ["a"] })
            yield* db.entities.Rows.update(key).remove(["tags"]).asEffect()
            expect(live(yield* probe.rows())!.t).toBeUndefined()
            isEmptySet((yield* db.entities.Rows.get(key)).tags)
          }),
      ),
  },
  {
    name: "a Schema.Class model: its instance holds them",
    run: (h) => {
      class Row extends Schema.Class<Row>("NoStoredFormRow")({
        id: Schema.String,
        tags: Strings,
        note: Schema.UndefinedOr(Schema.String),
      }) {}
      return h.on(worldOf(Row), (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", tags: empty(), note: undefined }).asEffect()
          const read = yield* db.entities.Rows.get(key)
          expect(read).toBeInstanceOf(Row)
          isEmptySet(read.tags)
          expect("note" in read).toBe(true)
        }),
      )
    },
  },
]

const Note = Schema.UndefinedOr(Schema.Struct({ a: Schema.String }))
const Packed = DynamoModel.Packed({ format: "json" })

const packedScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a packed UndefinedOr: stored as no attribute, read as undefined, cleared like any other",
    run: (h) =>
      h.on(
        worldOf(
          DynamoModel.configure(Schema.Struct({ id: Schema.String, f: Note }), {
            f: { storedAs: Packed },
          }),
        ),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", f: undefined }).asEffect()
            expect(live(yield* probe.rows())!.f).toBeUndefined()
            expect((yield* db.entities.Rows.get(key)).f).toBeUndefined()
            yield* db.entities.Rows.put({ id: "1", f: { a: "x" } }).asEffect()
            expect(live(yield* probe.rows())!.f).toEqual({ S: '{"a":"x"}' })
            yield* db.entities.Rows.update(key).remove(["f"]).asEffect()
            expect(live(yield* probe.rows())!.f).toBeUndefined()
            expect((yield* db.entities.Rows.get(key)).f).toBeUndefined()
          }),
      ),
  },
  {
    name: "a required UndefinedOr inside a packed field: left out of the JSON, read as undefined",
    run: (h) =>
      h.on(
        worldOf(
          DynamoModel.configure(
            Schema.Struct({
              id: Schema.String,
              f: Schema.Struct({ a: Schema.String, note: Schema.UndefinedOr(Schema.String) }),
            }),
            { f: { storedAs: Packed } },
          ),
        ),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", f: { a: "x", note: undefined } }).asEffect()
            expect(live(yield* probe.rows())!.f).toEqual({ S: '{"a":"x"}' })
            const read = yield* db.entities.Rows.get(key)
            expect(read.f.a).toBe("x")
            expect("note" in read.f).toBe(true)
          }),
      ),
  },
  {
    name: "a set inside a packed field is refused, empty or not: packed storage holds JSON",
    run: (h) =>
      h.on(
        worldOf(
          DynamoModel.configure(
            Schema.Struct({ id: Schema.String, f: Schema.Struct({ s: Strings }) }),
            {
              f: { storedAs: Packed },
            },
          ),
        ),
        (db) =>
          Effect.gen(function* () {
            for (const s of [empty(), new Set(["a"])]) {
              const error: any = yield* db.entities.Rows.put({ id: "1", f: { s } })
                .asEffect()
                .pipe(Effect.flip)
              expect(error._tag).toBe("ValidationError")
              expect(String(error.cause)).toMatch(/a Set/)
            }
          }),
      ),
  },
]

/** Reads that don't go through a primary-key accessor. */
const readScenarios: ReadonlyArray<Scenario> = [
  {
    name: "an index query reads an absent attribute as the value",
    run: (h) =>
      h.on(
        worldOf(Schema.Struct({ id: Schema.String, region: Schema.String, tags: Strings }), {
          indexes: {
            byRegion: {
              name: "gsi1",
              pk: { field: "gsi1pk", composite: ["region"] },
              sk: { field: "gsi1sk", composite: ["id"] },
            },
          },
        }),
        (db) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", region: "west", tags: empty() }).asEffect()
            const found = yield* db.entities.Rows.byRegion({ region: "west" }).collect()
            expect(found).toHaveLength(1)
            isEmptySet(found[0].tags)
          }),
      ),
  },
  {
    name: "a collection reads an absent attribute as the value, member by member",
    run: (h) => {
      const index = {
        name: "gsi1",
        collection: "held",
        pk: { field: "gsi1pk", composite: ["group"] },
        sk: { field: "gsi1sk", composite: ["id"] },
      }
      const Rows = Entity.make({
        model: Schema.Struct({ id: Schema.String, group: Schema.String, tags: Strings }),
        entityType: "Row",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: { byGroup: index },
      } as never) as any
      const Others = Entity.make({
        model: Schema.Struct({
          id: Schema.String,
          group: Schema.String,
          note: Schema.UndefinedOr(Schema.String),
        }),
        entityType: "Other",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: { byGroup: index },
      } as never) as any
      const MainTable = Table.make({ schema, entities: { Rows, Others } })
      return h.on({ Rows, MainTable }, () =>
        Effect.gen(function* () {
          const db = (yield* DynamoClient.make({
            entities: { Rows, Others },
            tables: { MainTable },
          } as never)) as any
          yield* db.entities.Rows.put({ id: "1", group: "g", tags: empty() }).asEffect()
          yield* db.entities.Others.put({ id: "2", group: "g", note: undefined }).asEffect()
          const held = yield* db.collections.held({ group: "g" }).collect()
          isEmptySet(held.Rows[0].tags)
          expect("note" in held.Others[0]).toBe(true)
        }),
      )
    },
  },
  {
    name: "a reference holds a target without them, and reads with them",
    run: (h) => {
      class Target extends Schema.Class<Target>("NoStoredFormRefTarget")({
        targetId: Schema.String.pipe(DynamoModel.identifier),
        tags: Strings,
        note: Schema.UndefinedOr(Schema.String),
      }) {}
      class Holder extends Schema.Class<Holder>("NoStoredFormRefHolder")({
        id: Schema.String,
        target: Target.pipe(DynamoModel.ref),
      }) {}
      const Targets = Entity.make({
        model: Target,
        entityType: "Target",
        primaryKey: {
          pk: { field: "pk", composite: ["targetId"] },
          sk: { field: "sk", composite: [] },
        },
      } as never) as any
      const Rows = Entity.make({
        model: Holder,
        entityType: "Row",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        refs: { target: { entity: Targets } },
      } as never) as any
      const MainTable = Table.make({ schema, entities: { Rows, Targets } })
      return h.on({ Rows, MainTable }, (_db, probe) =>
        Effect.gen(function* () {
          const db = (yield* DynamoClient.make({
            entities: { Rows, Targets },
            tables: { MainTable },
          } as never)) as any
          yield* db.entities.Targets.put({
            targetId: "t",
            tags: empty(),
            note: undefined,
          }).asEffect()
          yield* db.entities.Rows.put({ id: "1", targetId: "t" }).asEffect()
          const stored = (live(yield* probe.rows())!.target as any).M
          expect(stored.tags).toBeUndefined()
          expect(stored.note).toBeUndefined()
          const read = yield* db.entities.Rows.get(key)
          expect(read.target).toBeInstanceOf(Target)
          isEmptySet(read.target.tags)
          expect("note" in read.target).toBe(true)
        }),
      )
    },
  },
]

const expressionScenarios: ReadonlyArray<Scenario> = [
  {
    name: "a filter comparing with an empty set asks whether the attribute is there",
    run: (h) =>
      h.on(worldOf(Tagged), (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", tags: empty() }).asEffect()
          yield* db.entities.Rows.put({ id: "2", tags: new Set(["a"]) }).asEffect()
          const emptyOnes = yield* db.entities.Rows.scan().filter({ tags: empty() }).collect()
          expect(emptyOnes.map((row: any) => row.id)).toEqual(["1"])
          const others = yield* db.entities.Rows.scan()
            .filter((t: any, { ne }: any) => ne(t.tags, empty()))
            .collect()
          expect(others.map((row: any) => row.id)).toEqual(["2"])
          const emptyOnLeft = yield* db.entities.Rows.scan()
            .filter((t: any, { eq }: any) => eq(empty(), t.tags))
            .collect()
          expect(emptyOnLeft.map((row: any) => row.id)).toEqual(["1"])
        }),
      ),
  },
  {
    name: "a condition comparing with an empty set asks the same",
    run: (h) =>
      h.on(worldOf(Tagged), (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", tags: new Set(["a"]) }).asEffect()
          const error: any = yield* db.entities.Rows.update(key)
            .add({ tags: new Set(["b"]) })
            .condition({ tags: empty() })
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag).toBe("ConditionalCheckFailed")
          yield* db.entities.Rows.update(key).remove(["tags"]).asEffect()
          yield* db.entities.Rows.update(key)
            .add({ tags: new Set(["b"]) })
            .condition({ tags: empty() })
            .asEffect()
          expect((yield* db.entities.Rows.get(key)).tags).toEqual(new Set(["b"]))
        }),
      ),
  },
  ...(
    [
      ["gt", (t: any, { gt }: any) => gt(t.tags, empty())],
      ["between", (t: any, { between }: any) => between(t.tags, empty(), empty())],
      ["isIn", (t: any, { isIn }: any) => isIn(t.tags, [empty()])],
      ["contains", (t: any, { contains }: any) => contains(t.tags, empty())],
      ["beginsWith", (t: any, { beginsWith }: any) => beginsWith(t.tags, empty())],
      ["lte", (t: any, { lte }: any) => lte(t.tags, empty())],
    ] as const
  ).map(([name, condition]) => ({
    name: `${name} of an empty set is refused: only eq and ne have a reading`,
    run: (h: Harness) =>
      h.on(worldOf(Tagged), (db, probe) =>
        Effect.gen(function* () {
          yield* seedTags(db, "a")
          yield* refused(
            db,
            probe,
            () =>
              db.entities.Rows.update(key)
                .add({ tags: new Set(["b"]) })
                .condition(condition)
                .asEffect(),
            /Only eq\(\) and ne\(\) can compare/,
          )
        }),
      ),
  })),
]

// ---------------------------------------------------------------------------
// Aggregates: they compose their own rows
// ---------------------------------------------------------------------------

class Part extends Schema.Class<Part>("NoStoredFormPart")({
  partId: Schema.String,
  tags: Strings,
  note: Schema.UndefinedOr(Schema.String),
}) {}

class Header extends Schema.Class<Header>("NoStoredFormHeader")({
  tags: Strings,
  note: Schema.UndefinedOr(Schema.String),
}) {}

class Assembly extends Schema.Class<Assembly>("NoStoredFormAssembly")({
  id: Schema.String,
  tags: Strings,
  note: Schema.UndefinedOr(Schema.String),
  header: Header,
  parts: Schema.Array(Part),
}) {}

const aggregateWorld = () => {
  const world = worldOf(Tagged)
  const Assemblies = Aggregate.make(Assembly, {
    table: world.MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "assembly" },
    root: { entityType: "AssemblyRoot" },
    edges: {
      header: Aggregate.one({ entityType: "AssemblyHeader" }),
      parts: Aggregate.many({
        entityType: "AssemblyPart",
        sk: { composite: ["partId"] },
      }),
    },
  } as never) as any
  return { world, Assemblies }
}

const assemblyRows = (rows: ReadonlyArray<Record<string, AttributeValue>>, entityType: string) =>
  rows.filter((row) => row.__edd_e__?.S === entityType)

const assemblyInput = (tags: Set<string>, note: string | undefined) => ({
  id: "1",
  tags,
  note,
  header: { tags, note },
  parts: [{ partId: "p", tags, note }],
})

const aggregateScenarios: ReadonlyArray<Scenario> = [
  {
    name: "an aggregate's rows are stored without them, and it assembles with them",
    run: (h) => {
      const { world, Assemblies } = aggregateWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          const created = yield* Assemblies.create(assemblyInput(empty(), undefined))
          isEmptySet(created.tags)
          const rows = yield* probe.rows()
          for (const entityType of ["AssemblyRoot", "AssemblyHeader", "AssemblyPart"]) {
            const [row] = assemblyRows(rows, entityType)
            expect(row!.tags).toBeUndefined()
            expect(row!.note).toBeUndefined()
          }
          const read = yield* Assemblies.get({ id: "1" })
          expect(read).toBeInstanceOf(Assembly)
          for (const node of [read, read.header, read.parts[0]]) {
            isEmptySet(node.tags)
            expect("note" in node).toBe(true)
            expect(node.note).toBeUndefined()
          }
        }),
      )
    },
  },
  {
    name: "an aggregate with values stores them as it always did",
    run: (h) => {
      const { world, Assemblies } = aggregateWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          yield* Assemblies.create(assemblyInput(new Set(["a"]), "n"))
          const rows = yield* probe.rows()
          for (const entityType of ["AssemblyRoot", "AssemblyHeader", "AssemblyPart"]) {
            const [row] = assemblyRows(rows, entityType)
            expect(row!.tags).toEqual({ SS: ["a"] })
            expect(row!.note).toEqual({ S: "n" })
          }
        }),
      )
    },
  },
  {
    name: "an aggregate update of a set alone is written: two sets aren't equal for having no keys",
    run: (h) => {
      const { world, Assemblies } = aggregateWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          yield* Assemblies.create(assemblyInput(new Set(["a"]), "n"))
          const updated = yield* Assemblies.update({ id: "1" }, ({ current }: any) => ({
            ...current,
            tags: new Set(["a", "b"]),
          }))
          expect(updated.tags).toEqual(new Set(["a", "b"]))
          const rows = yield* probe.rows()
          const stored = assemblyRows(rows, "AssemblyRoot")[0]!.tags as {
            readonly SS: ReadonlyArray<string>
          }
          expect([...stored.SS].sort()).toEqual(["a", "b"])
          expect((yield* Assemblies.get({ id: "1" })).tags).toEqual(new Set(["a", "b"]))
          // The same size, with other members, is a change too.
          yield* Assemblies.update({ id: "1" }, ({ current }: any) => ({
            ...current,
            tags: new Set(["c", "d"]),
          }))
          expect((yield* Assemblies.get({ id: "1" })).tags).toEqual(new Set(["c", "d"]))
        }),
      )
    },
  },
  {
    name: "an aggregate update can hand back the plain state, which holds a set as a list",
    run: (h) => {
      const { world, Assemblies } = aggregateWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          yield* Assemblies.create(assemblyInput(new Set(["a"]), "n"))
          const sent = probe.sent()
          const same = yield* Assemblies.update({ id: "1" }, ({ state }: any) => state)
          expect(same.tags).toEqual(new Set(["a"]))
          expect(same.parts[0].tags).toEqual(new Set(["a"]))
          expect(probe.sent() - sent).toBe(1)
          const added = yield* Assemblies.update({ id: "1" }, ({ state }: any) => ({
            ...state,
            tags: [...state.tags, "b"],
          }))
          expect(added.tags).toEqual(new Set(["a", "b"]))
          const emptied = yield* Assemblies.update({ id: "1" }, ({ state }: any) => ({
            ...state,
            tags: [],
          }))
          isEmptySet(emptied.tags)
          expect(assemblyRows(yield* probe.rows(), "AssemblyRoot")[0]!.tags).toBeUndefined()
        }),
      )
    },
  },
  {
    name: "an aggregate update changing nothing writes nothing, sets included",
    run: (h) => {
      const { world, Assemblies } = aggregateWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          yield* Assemblies.create(assemblyInput(new Set(["a", "b"]), undefined))
          const sent = probe.sent()
          yield* Assemblies.update({ id: "1" }, ({ current }: any) => ({
            ...current,
            tags: new Set(["b", "a"]),
          }))
          // The partition read, and no write.
          expect(probe.sent() - sent).toBe(1)
        }),
      )
    },
  },
  {
    name: "an aggregate update to no value takes it off the rows, and reads back",
    run: (h) => {
      const { world, Assemblies } = aggregateWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          yield* Assemblies.create(assemblyInput(new Set(["a"]), "n"))
          const updated = yield* Assemblies.update({ id: "1" }, ({ state }: any) => ({
            ...state,
            tags: empty(),
            note: undefined,
            header: { ...state.header, tags: empty() },
          }))
          isEmptySet(updated.tags)
          expect(updated.note).toBeUndefined()
          const rows = yield* probe.rows()
          expect(assemblyRows(rows, "AssemblyRoot")[0]!.tags).toBeUndefined()
          expect(assemblyRows(rows, "AssemblyRoot")[0]!.note).toBeUndefined()
          expect(assemblyRows(rows, "AssemblyHeader")[0]!.tags).toBeUndefined()
          expect(assemblyRows(rows, "AssemblyPart")[0]!.tags).toEqual({ SS: ["a"] })
          const read = yield* Assemblies.get({ id: "1" })
          isEmptySet(read.header.tags)
          expect(read.parts[0].tags).toEqual(new Set(["a"]))
        }),
      )
    },
  },
]

// ---------------------------------------------------------------------------
// Event streams: an event that can't be read would stop the stream
// ---------------------------------------------------------------------------

class Tallied extends Schema.TaggedClass<Tallied>()("NoStoredFormTallied", {
  tags: Strings,
  note: Schema.UndefinedOr(Schema.String),
  nested: Schema.Struct({ tags: Strings }),
}) {}

class Other extends Schema.TaggedClass<Other>()("NoStoredFormOther", { n: Schema.Number }) {}

const eventWorld = (options: Record<string, unknown> = {}) => {
  const world = worldOf(Tagged)
  const Stream = EventStore.makeStream({
    table: world.MainTable,
    streamName: "Tallies",
    events: [Tallied, Other],
    streamId: { composite: ["tallyId"] },
    metadata: Schema.Struct({ by: Schema.UndefinedOr(Schema.String), tags: Strings }),
    ...options,
  } as never) as any
  return { world, Stream }
}

const eventScenarios: ReadonlyArray<Scenario> = [
  {
    name: "an event is stored without them, and the stream reads",
    run: (h) => {
      const { world, Stream } = eventWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          yield* Stream.append(
            { tallyId: "t" },
            [
              new Tallied({ tags: empty(), note: undefined, nested: { tags: empty() } }),
              new Other({ n: 1 }),
              new Tallied({ tags: new Set(["a"]), note: "n", nested: { tags: new Set(["b"]) } }),
            ],
            0,
            { metadata: { by: undefined, tags: empty() } },
          )
          const events = (yield* probe.rows())
            .filter((row) => row.data !== undefined)
            .sort((a, b) => Number(a.version?.N) - Number(b.version?.N))
          expect(events[0]!.data).toEqual({
            M: { _tag: { S: "NoStoredFormTallied" }, nested: { M: {} } },
          })
          expect((events[2]!.data as any).M.tags).toEqual({ SS: ["a"] })
          const read: ReadonlyArray<any> = yield* Stream.read({ tallyId: "t" })
          expect(read).toHaveLength(3)
          expect(read[0].data).toBeInstanceOf(Tallied)
          isEmptySet(read[0].data.tags)
          expect("note" in read[0].data).toBe(true)
          isEmptySet(read[0].data.nested.tags)
          isEmptySet(read[0].metadata.tags)
          expect(read[1].data).toBeInstanceOf(Other)
          expect(read[1].data.n).toBe(1)
          expect(read[2].data.tags).toEqual(new Set(["a"]))
        }),
      )
    },
  },
  {
    name: "a snapshot state is stored without them, and reads",
    run: (h) => {
      const State = Schema.Struct({ tags: Strings, note: Schema.UndefinedOr(Schema.String) })
      const { world, Stream } = eventWorld({
        snapshot: { schema: State, every: 1 },
      })
      return h.on(world, () =>
        Effect.gen(function* () {
          yield* Stream.writeSnapshot({ tallyId: "t" }, { tags: empty(), note: undefined }, 0)
          const snapshot = yield* Stream.readSnapshot({ tallyId: "t" })
          const state = (snapshot as any).value?.state ?? (snapshot as any).state
          isEmptySet(state.tags)
          expect("note" in state).toBe(true)
        }),
      )
    },
  },
]

// ---------------------------------------------------------------------------
// A relative update that breaks the model: the write landed, and the error says so
// ---------------------------------------------------------------------------

const Stock = Schema.Struct({
  id: Schema.String,
  stock: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  items: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  scores: Schema.optional(Schema.Array(Schema.Number).check(Schema.isMaxLength(1))),
})
const seedStock = (db: any) =>
  db.entities.Rows.put({ id: "1", stock: 1, items: ["a"], scores: [1] })

const applied = (field: string) => (error: any) => {
  expect(error._tag).toBe("ValidationError")
  expect(error.operation).toBe("update")
  const message = String(error.cause)
  expect(message).toMatch(/^The update WAS applied, and the stored row no longer matches the model/)
  expect(message).toContain(`"${field}"`)
  expect(message).toMatch(/Guard it with \.condition\(\)/)
}

const RELATIVE: ReadonlyArray<{
  readonly name: string
  readonly op: (u: any) => any
  readonly field: string
  readonly stored: (row: Record<string, AttributeValue>) => void
}> = [
  {
    name: ".subtract",
    op: (u) => u.subtract({ stock: 3 }),
    field: "stock",
    stored: (row) => expect(row.stock).toEqual({ N: "-2" }),
  },
  {
    name: ".add",
    op: (u) => u.add({ stock: -3 }),
    field: "stock",
    stored: (row) => expect(row.stock).toEqual({ N: "-2" }),
  },
  {
    name: ".append",
    op: (u) => u.append({ scores: [2] }),
    field: "scores",
    stored: (row) => expect((row.scores as any).L).toHaveLength(2),
  },
  {
    name: "pathRemove",
    op: (u) => u.pathRemove(["items", 0]),
    field: "items",
    stored: (row) => expect(row.items).toEqual({ L: [] }),
  },
  {
    name: "pathSubtract",
    op: (u) => u.pathSubtract({ segments: ["stock"], value: 3, isPath: false }),
    field: "stock",
    stored: (row) => expect(row.stock).toEqual({ N: "-2" }),
  },
  {
    name: "pathAdd",
    op: (u) => u.pathAdd({ segments: ["stock"], value: -3 }),
    field: "stock",
    stored: (row) => expect(row.stock).toEqual({ N: "-2" }),
  },
  {
    name: "pathAppend",
    op: (u) => u.pathAppend({ segments: ["scores"], value: [2], isPath: false }),
    field: "scores",
    stored: (row) => expect((row.scores as any).L).toHaveLength(2),
  },
  {
    name: "pathPrepend",
    op: (u) => u.pathPrepend({ segments: ["scores"], value: [2], isPath: false }),
    field: "scores",
    stored: (row) => expect((row.scores as any).L).toHaveLength(2),
  },
  {
    // Each value is one the element takes: only the list it joins is over its limit.
    name: "pathSet of an element past the end",
    op: (u) => u.pathSet({ segments: ["scores", 1], value: 2, isPath: false }),
    field: "scores",
    stored: (row) => expect((row.scores as any).L).toHaveLength(2),
  },
]

const honestScenarios: ReadonlyArray<Scenario> = [
  ...[
    { name: "standalone", options: {} },
    { name: "versioned", options: { versioned: true } },
    { name: "retained", options: { versioned: { retain: true } } },
  ].flatMap(({ name: lifecycle, options }) =>
    RELATIVE.map(({ name, op, field, stored }) => ({
      name: `${lifecycle}: ${name} that breaks a .check() says it was applied, and names the field`,
      run: (h: Harness) =>
        h.on(worldOf(Stock, options), (db, probe) =>
          Effect.gen(function* () {
            yield* seedStock(db).asEffect()
            const error = yield* op(db.entities.Rows.update(key)).asEffect().pipe(Effect.flip)
            applied(field)(error)
            stored(live(yield* probe.rows())!)
          }),
        ),
    })),
  ),
  {
    name: "deleteFromSet emptying a set that must not be empty says it was applied",
    run: (h) =>
      h.on(
        worldOf(Schema.Struct({ id: Schema.String, held: Strings.check(Schema.isMinSize(1)) })),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", held: new Set(["x"]) }).asEffect()
            const error: any = yield* db.entities.Rows.update(key)
              .deleteFromSet({ held: new Set(["x"]) })
              .asEffect()
              .pipe(Effect.flip)
            expect(error._tag).toBe("ValidationError")
            expect(String(error.cause)).toMatch(/^The update WAS applied/)
            expect(live(yield* probe.rows())!.held).toBeUndefined()
          }),
      ),
  },
  {
    name: "returning only what was written: the same report",
    run: (h) =>
      h.on(worldOf(Stock), (db) =>
        Effect.gen(function* () {
          yield* seedStock(db).asEffect()
          const error = yield* db.entities.Rows.update(key)
            .subtract({ stock: 3 })
            .returnValues("updatedNew")
            .asEffect()
            .pipe(Effect.flip)
          applied("stock")(error)
        }),
      ),
  },
  {
    name: "returning nothing decodes nothing, so nothing fails",
    run: (h) =>
      h.on(worldOf(Stock), (db, probe) =>
        Effect.gen(function* () {
          yield* seedStock(db).asEffect()
          yield* db.entities.Rows.update(key).subtract({ stock: 3 }).returnValues("none").asEffect()
          expect(live(yield* probe.rows())!.stock).toEqual({ N: "-2" })
        }),
      ),
  },
  {
    name: "returning the old row, when that's what doesn't decode, says which row it was",
    run: (h) =>
      h.on(worldOf(Stock), (db) =>
        Effect.gen(function* () {
          yield* seedStock(db).asEffect()
          yield* db.entities.Rows.update(key).subtract({ stock: 3 }).returnValues("none").asEffect()
          const error: any = yield* db.entities.Rows.update(key)
            .add({ stock: 5 })
            .returnValues("allOld")
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect(String(error.cause)).toMatch(
            /^The update WAS applied, but the row it replaced doesn't match the model: "stock"/,
          )
        }),
      ),
  },
  {
    name: "returning the old attributes, when those don't decode, says which row it was",
    run: (h) =>
      h.on(worldOf(Stock), (db) =>
        Effect.gen(function* () {
          yield* seedStock(db).asEffect()
          yield* db.entities.Rows.update(key).subtract({ stock: 3 }).returnValues("none").asEffect()
          const error: any = yield* db.entities.Rows.update(key)
            .add({ stock: 5 })
            .returnValues("updatedOld")
            .asEffect()
            .pipe(Effect.flip)
          expect(String(error.cause)).toMatch(
            /^The update WAS applied, but the row it replaced doesn't match the model: "stock"/,
          )
        }),
      ),
  },
  ...RELATIVE.filter(({ field }) => field === "stock").map(({ name, op }) => ({
    name: `a .condition() guarding ${name} refuses cleanly, with nothing written`,
    run: (h: Harness) =>
      h.on(worldOf(Stock), (db, probe) =>
        Effect.gen(function* () {
          yield* seedStock(db).asEffect()
          const before = yield* probe.rows()
          const error: any = yield* op(db.entities.Rows.update(key))
            .condition((t: any, { gte }: any) => gte(t.stock, 3))
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag).toBe("ConditionalCheckFailed")
          expect(yield* probe.rows()).toEqual(before)
          expect((yield* db.entities.Rows.get(key)).stock).toBe(1)
        }),
      ),
  })),
  {
    name: "pathSet of a value the field refuses is refused before it's sent, and doesn't claim to be applied",
    run: (h) =>
      h.on(worldOf(Stock), (db, probe) =>
        Effect.gen(function* () {
          yield* seedStock(db).asEffect()
          const sent = probe.sent()
          const error: any = yield* db.entities.Rows.update(key)
            .pathSet({ segments: ["stock"], value: -1, isPath: false })
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect(String(error.cause)).not.toMatch(/WAS applied/)
          expect(probe.sent()).toBe(sent)
        }),
      ),
  },
  ...[
    { name: "standalone", options: {} },
    { name: "retained", options: { versioned: { retain: true } } },
  ].map(({ name, options }) => ({
    name: `${name}: a cascade reads the row back, and says the same when it won't decode`,
    run: (h: Harness) => {
      class Source extends Schema.Class<Source>("NoStoredFormCascadeSource")({
        id: Schema.String.pipe(DynamoModel.identifier),
        stock: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
      }) {}
      class Holder extends Schema.Class<Holder>("NoStoredFormCascadeHolder")({
        holderId: Schema.String,
        source: Source.pipe(DynamoModel.ref),
      }) {}
      const world = worldOf(Source, options)
      const Holders = Entity.make({
        model: Holder,
        entityType: "NoStoredFormCascadeHolder",
        primaryKey: {
          pk: { field: "pk", composite: ["holderId"] },
          sk: { field: "sk", composite: [] },
        },
        refs: {
          source: {
            entity: world.Rows,
            cascade: { index: "gsi2", pk: { field: "gsi2pk" }, sk: { field: "gsi2sk" } },
          },
        },
      } as never) as any
      return h.on(world, (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", stock: 1 }).asEffect()
          const error = yield* db.entities.Rows.update(key)
            .subtract({ stock: 3 })
            .cascade({ targets: [Holders] })
            .asEffect()
            .pipe(Effect.flip)
          applied("stock")(error)
          expect(live(yield* probe.rows())!.stock).toEqual({ N: "-2" })
        }),
      )
    },
  })),
  {
    name: "a guarded update that holds goes through",
    run: (h) =>
      h.on(worldOf(Stock), (db) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", stock: 5, items: ["a"] }).asEffect()
          const returned = yield* db.entities.Rows.update(key)
            .subtract({ stock: 3 })
            .condition((t: any, { gte }: any) => gte(t.stock, 3))
            .asEffect()
          expect(returned.stock).toBe(2)
        }),
      ),
  },
  {
    name: "a value the schema can judge before sending is refused, and doesn't claim to be applied",
    run: (h) =>
      h.on(worldOf(Stock), (db, probe) =>
        Effect.gen(function* () {
          yield* seedStock(db).asEffect()
          const sent = probe.sent()
          const error: any = yield* db.entities.Rows.update(key)
            .set({ stock: -1 })
            .asEffect()
            .pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect(String(error.cause)).not.toMatch(/WAS applied/)
          expect(probe.sent()).toBe(sent)
        }),
      ),
  },
  {
    name: "a read of the row afterwards reports the decode failure, not an update",
    run: (h) =>
      h.on(worldOf(Stock), (db) =>
        Effect.gen(function* () {
          yield* seedStock(db).asEffect()
          yield* db.entities.Rows.update(key).subtract({ stock: 3 }).returnValues("none").asEffect()
          const error: any = yield* db.entities.Rows.get(key).pipe(Effect.flip)
          expect(error._tag).toBe("ValidationError")
          expect(error.operation).toBe("decode")
        }),
      ),
  },
  {
    name: "in a transaction the update is committed by the caller's write, with no row returned to decode",
    run: (h) =>
      h.on(worldOf(Stock), (db, probe) =>
        Effect.gen(function* () {
          yield* seedStock(db).asEffect()
          yield* Transaction.transactWrite([db.entities.Rows.update(key).subtract({ stock: 3 })])
          expect(live(yield* probe.rows())!.stock).toEqual({ N: "-2" })
        }),
      ),
  },
]

// ---------------------------------------------------------------------------
// A value DynamoDB can't store, with no attribute to leave out: a caller's value is
// a ValidationError naming the field, on every path, never a defect
// ---------------------------------------------------------------------------

const Holding = Schema.Struct({
  id: Schema.String,
  /** Set when a row is seeded, so the operand-taking operations have something to act on. */
  lists: Schema.optional(Schema.Array(Strings)),
  pair: Schema.optional(Schema.Tuple([Schema.String, Strings])),
  anything: Schema.optional(Schema.Unknown),
  n: Schema.optional(Schema.Number),
})

const expectNothingWritten = (
  probe: Probe,
  failing: () => Effect.Effect<unknown, unknown, any>,
  says: RegExp,
  options: { readonly reads?: boolean } = {},
) =>
  Effect.gen(function* () {
    const before = yield* probe.rows()
    const sent = probe.sent()
    const error: any = yield* failing().pipe(Effect.flip)
    expect(error._tag).toBe("ValidationError")
    expect(String(error.cause)).toMatch(says)
    if (options.reads !== true) expect(probe.sent()).toBe(sent)
    expect(yield* probe.rows()).toEqual(before)
  })

/** The configurations that send a request before their write, and the one that doesn't. */
const WRITE_PATHS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ["plain", {}],
  ["versioned", { versioned: true }],
  ["retained", { versioned: { retain: true } }],
  ["unique", { unique: { byN: ["n"] } }],
]

const OPERANDS: ReadonlyArray<readonly [string, (update: any) => any, RegExp]> = [
  [
    ".set of a tuple",
    (u) => u.set({ pair: ["a", empty()] }),
    /\.set\(\) of "pair\[1\]": .*no empty set/,
  ],
  [
    ".set of a list",
    (u) => u.set({ lists: [empty()] }),
    /\.set\(\) of "lists\[0\]": .*no empty set/,
  ],
  [
    ".set of an unknown value",
    (u) => u.set({ anything: { deep: [{ more: [empty()] }] } }),
    /\.set\(\) of "anything\.deep\[0\]\.more\[0\]": .*no empty set/,
  ],
  [
    ".append",
    (u) => u.append({ lists: [empty()] }),
    /\.append\(\) of "lists\[0\]": .*no empty set/,
  ],
  [
    "pathSet",
    (u) => u.pathSet({ segments: ["pair"], value: ["a", empty()], isPath: false }),
    /pathSet of "pair\[1\]": .*no empty set/,
  ],
  [
    "pathAppend",
    (u) => u.pathAppend({ segments: ["lists"], value: [empty()], isPath: false }),
    /pathAppend of "lists\[0\]": .*no empty set/,
  ],
  [
    "pathPrepend",
    (u) => u.pathPrepend({ segments: ["lists"], value: [empty()], isPath: false }),
    /pathPrepend of "lists\[0\]": .*no empty set/,
  ],
  [
    "pathIfNotExists",
    (u) => u.pathIfNotExists({ segments: ["lists"], value: [empty()], isPath: false }),
    /pathIfNotExists of "lists\[0\]": .*no empty set/,
  ],
  [
    "pathAdd",
    (u) => u.pathAdd({ segments: ["anything"], value: Number.NaN, isPath: false }),
    /pathAdd of "anything": .*NaN/,
  ],
  [
    "pathSubtract",
    (u) => u.pathSubtract({ segments: ["n"], value: Number.NaN, isPath: false }),
    /(pathSubtract|\.subtract\(\)) of "n": .*NaN/,
  ],
  [
    "pathDelete",
    (u) => u.pathDelete({ segments: ["anything"], value: new Set<unknown>([{}]), isPath: false }),
    /pathDelete of "anything": .*Set/,
  ],
  [".add", (u) => u.add({ n: Number.NaN }), /\.add\(\) of "n": .*NaN/],
  [".subtract", (u) => u.subtract({ n: Number.NaN }), /\.subtract\(\) of "n": .*NaN/],
  [
    ".deleteFromSet",
    (u) => u.deleteFromSet({ anything: new Set<unknown>([{}]) }),
    /\.deleteFromSet\(\) of "anything": .*Set/,
  ],
  [".set of NaN", (u) => u.set({ n: Number.NaN }), /\.set\(\) of "n": .*NaN/],
  [
    ".set past the safe integers",
    (u) => u.set({ n: 2 ** 60 }),
    /\.set\(\) of "n": .*MAX_SAFE_INTEGER/,
  ],
  [
    ".cascade filter",
    (u) => u.set({ id: "1" } as never).cascade({ targets: [], filter: { kind: [empty()] } }),
    /\.cascade\(\) filter on "kind\[0\]": .*no empty set/,
  ],
  [
    ".cascade filter of an empty set",
    (u) => u.set({ id: "1" } as never).cascade({ targets: [], filter: { kind: empty() } }),
    /\.cascade\(\) filter on "kind": .*no empty set/,
  ],
]

class Moved extends Schema.TaggedClass<Moved>()("NoStoredFormMoved", {
  pair: Schema.Tuple([Schema.String, Strings]),
  lists: Schema.Array(Strings),
  anything: Schema.optional(Schema.Unknown),
  gap: Schema.optional(
    Schema.Tuple([Schema.String, Schema.UndefinedOr(Schema.String), Schema.String]),
  ),
}) {}

const movedOf = (fields: Partial<Record<keyof Moved, unknown>>) =>
  new Moved(
    { pair: ["a", new Set(["b"])], lists: [new Set(["c"])], ...fields } as never,
    { disableChecks: true } as never,
  )

const movedWorld = (options: Record<string, unknown> = {}) => {
  const world = worldOf(Holding)
  const Stream = EventStore.makeStream({
    table: world.MainTable,
    streamName: "Moves",
    events: [Moved],
    streamId: { composite: ["moveId"] },
    metadata: Schema.Struct({
      lists: Schema.optional(Schema.Array(Strings)),
      gap: Schema.optional(
        Schema.Tuple([Schema.String, Schema.UndefinedOr(Schema.String), Schema.String]),
      ),
    }),
    ...options,
  } as never) as any
  return { world, Stream }
}

class HoldingPart extends Schema.Class<HoldingPart>("NoStoredFormHoldingPart")({
  partId: Schema.String,
  pair: Schema.Tuple([Schema.String, Strings]),
}) {}

class HoldingHeader extends Schema.Class<HoldingHeader>("NoStoredFormHoldingHeader")({
  lists: Schema.Array(Strings),
  gap: Schema.optional(
    Schema.Tuple([Schema.String, Schema.UndefinedOr(Schema.String), Schema.String]),
  ),
}) {}

class HoldingAssembly extends Schema.Class<HoldingAssembly>("NoStoredFormHoldingAssembly")({
  id: Schema.String,
  anything: Schema.optional(Schema.Unknown),
  header: HoldingHeader,
  parts: Schema.Array(HoldingPart),
}) {}

const holdingAggregateWorld = () => {
  const world = worldOf(Holding)
  const Assemblies = Aggregate.make(HoldingAssembly, {
    table: world.MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "assembly" },
    root: { entityType: "HoldingRoot" },
    edges: {
      header: Aggregate.one({ entityType: "HoldingHeader" }),
      parts: Aggregate.many({ entityType: "HoldingPart", sk: { composite: ["partId"] } }),
    },
  } as never) as any
  return { world, Assemblies }
}

const holdingInput = () => ({
  id: "1",
  header: { lists: [new Set(["a"])] },
  parts: [{ partId: "p", pair: ["a", new Set(["b"])] }],
})

const unstorableScenarios: ReadonlyArray<Scenario> = [
  ...WRITE_PATHS.flatMap(([path, options]) => [
    {
      name: `${path}: a put holding a value DynamoDB can't store sends nothing`,
      run: (h: Harness) =>
        h.on(worldOf(Holding, options), (db, probe) =>
          Effect.gen(function* () {
            for (const [input, says] of [
              [{ pair: ["a", empty()] }, /"pair\[1\]": .*no empty set/],
              [{ lists: [new Set(["a"]), empty()] }, /"lists\[1\]": .*no empty set/],
              [{ anything: { deep: [empty()] } }, /"anything\.deep\[0\]": .*no empty set/],
              [{ n: Number.NaN }, /"n": .*NaN|EDD-9096/],
              [{ n: 2 ** 60 }, /"n": .*MAX_SAFE_INTEGER/],
            ] as const) {
              yield* expectNothingWritten(
                probe,
                () => db.entities.Rows.put({ id: "1", ...input }).asEffect(),
                says,
              )
              yield* expectNothingWritten(
                probe,
                () => db.entities.Rows.create({ id: "1", ...input }).asEffect(),
                says,
              )
              yield* expectNothingWritten(
                probe,
                () => db.entities.Rows.upsert({ id: "1", ...input }).asEffect(),
                says,
              )
            }
          }),
        ),
    },
    ...OPERANDS.map(([operation, apply, says]) => ({
      name: `${path}: ${operation} holding one sends nothing`,
      run: (h: Harness) =>
        h.on(worldOf(Holding, options), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({
              id: "1",
              lists: [new Set(["a"])],
              anything: new Set(["a"]),
              n: 1,
            }).asEffect()
            yield* expectNothingWritten(
              probe,
              () => apply(db.entities.Rows.update(key)).asEffect(),
              says,
            )
          }),
        ),
    })),
  ]),
  {
    name: "a renamed field is named by its model field, on the path that marshals last",
    run: (h) =>
      h.on(worldOf(DynamoModel.configure(Holding, { pair: { field: "p" } })), (db, probe) =>
        expectNothingWritten(
          probe,
          () => db.entities.Rows.put({ id: "1", pair: ["a", empty()] }).asEffect(),
          /"pair\[1\]": /,
        ),
      ),
  },
  {
    name: "a renamed field is named by its model field, in a transaction",
    run: (h) =>
      h.on(worldOf(DynamoModel.configure(Holding, { pair: { field: "p" } })), (db, probe) =>
        expectNothingWritten(
          probe,
          () =>
            Transaction.transactWrite([
              db.entities.Rows.put({ id: "1", pair: ["a", empty()] }),
            ] as never),
          /"pair\[1\]": /,
        ),
      ),
  },
  ...(
    [
      ["plain", {}],
      ["versioned", { versioned: true }],
      ["retained", { versioned: { retain: true } }],
      ["unique", { unique: { byOther: ["other"] } }],
    ] as const
  ).map(([path, options]) => ({
    name: `${path}: a NaN on a composite of a half nothing composes is refused too`,
    run: (h: Harness) =>
      h.on(
        worldOf(
          Schema.Struct({
            id: Schema.String,
            n: Schema.optional(Schema.Number),
            m: Schema.optional(Schema.Number),
            other: Schema.optional(Schema.String),
          }),
          {
            ...options,
            indexes: {
              byPair: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["id"] },
                sk: { field: "gsi1sk", composite: ["n", "m"] },
              },
            },
          },
        ),
        (db, probe) =>
          Effect.gen(function* () {
            const NaN = Number.NaN
            for (const write of [
              () => db.entities.Rows.put({ id: "1", n: NaN }).asEffect(),
              () => db.entities.Rows.upsert({ id: "1", n: NaN }).asEffect(),
              () => db.entities.Rows.update(key).set({ n: NaN }).asEffect(),
            ]) {
              yield* expectNothingWritten(probe, write, /"n": .*NaN|EDD-9096/)
            }
            // A half it composes: key text refuses it with `escapeKeys`, and has text for it
            // without.
            yield* expectNothingWritten(
              probe,
              () => db.entities.Rows.update(key).set({ n: NaN, m: 1 }).asEffect(),
              /"n": .*NaN|EDD-9096/,
            )
          }),
      ),
  })),
  {
    name: "a time-series append of a NaN on an index composite sends nothing",
    run: (h) =>
      h.on(
        worldOf(
          Schema.Struct({
            id: Schema.String,
            at: Schema.Number,
            n: Schema.optional(Schema.Number),
            m: Schema.optional(Schema.Number),
          }),
          {
            timeSeries: {
              orderBy: "at",
              appendInput: Schema.Struct({
                id: Schema.String,
                at: Schema.Number,
                n: Schema.optional(Schema.Number),
                m: Schema.optional(Schema.Number),
              }),
            },
            indexes: {
              byPair: {
                name: "gsi1",
                pk: { field: "gsi1pk", composite: ["id"] },
                sk: { field: "gsi1sk", composite: ["n", "m"] },
              },
            },
          },
        ),
        (db, probe) =>
          Effect.gen(function* () {
            for (const input of [
              { id: "1", at: 1, n: Number.NaN },
              { id: "1", at: 1, n: Number.NaN, m: 2 },
            ]) {
              yield* expectNothingWritten(
                probe,
                () => db.entities.Rows.append(input).asEffect(),
                /"n": .*NaN|EDD-9096/,
              )
            }
          }),
      ),
  },
  {
    name: "a put hydrating a ref refuses the value before it reads the target",
    run: (h) => {
      class Target extends Schema.Class<Target>("NoStoredFormRefusedTarget")({
        targetId: Schema.String.pipe(DynamoModel.identifier),
      }) {}
      class Holder extends Schema.Class<Holder>("NoStoredFormRefusedHolder")({
        id: Schema.String,
        target: Target.pipe(DynamoModel.ref),
        n: Schema.optional(Schema.Number),
      }) {}
      const Targets = Entity.make({
        model: Target,
        entityType: "Target",
        primaryKey: {
          pk: { field: "pk", composite: ["targetId"] },
          sk: { field: "sk", composite: [] },
        },
      } as never) as any
      const Rows = Entity.make({
        model: Holder,
        entityType: "Row",
        primaryKey: {
          pk: { field: "pk", composite: ["id"] },
          sk: { field: "sk", composite: [] },
        },
        refs: { target: { entity: Targets } },
      } as never) as any
      const MainTable = Table.make({ schema, entities: { Rows, Targets } })
      return h.on({ Rows, MainTable }, (_db, probe) =>
        Effect.gen(function* () {
          const db = (yield* DynamoClient.make({
            entities: { Rows, Targets },
            tables: { MainTable },
          } as never)) as any
          yield* db.entities.Targets.put({ targetId: "t" }).asEffect()
          yield* expectNothingWritten(
            probe,
            () => db.entities.Rows.put({ id: "1", targetId: "t", n: 2 ** 60 }).asEffect(),
            /"n": .*MAX_SAFE_INTEGER/,
          )
        }),
      )
    },
  },
  {
    name: "an .append operand is judged in the form it would be stored",
    run: (h) => {
      const Joined = Strings.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((set: ReadonlySet<string>) => [...set].join(",")),
          encode: SchemaGetter.transform(
            (joined: string) => new Set(joined === "" ? [] : joined.split(",")),
          ),
        }),
      )
      return h.on(
        worldOf(Schema.Struct({ id: Schema.String, parts: Schema.Array(Joined) })),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", parts: ["a"] }).asEffect()
            yield* expectNothingWritten(
              probe,
              () =>
                db.entities.Rows.update(key)
                  .append({ parts: [""] })
                  .asEffect(),
              /\.append\(\) of "parts\[0\]": .*no empty set/,
            )
          }),
      )
    },
  },
  {
    name: "a renamed field is named as the model names it, on every path",
    run: (h) =>
      h.on(worldOf(DynamoModel.configure(Holding, { pair: { field: "stored" } })), (db, probe) =>
        Effect.gen(function* () {
          const input = { id: "1", pair: ["a", empty()] }
          for (const write of [
            () => db.entities.Rows.put(input).asEffect(),
            () => db.entities.Rows.upsert(input).asEffect(),
            () => Transaction.transactWrite([db.entities.Rows.put(input)] as never),
            () => Batch.write([db.entities.Rows.put(input)] as never),
          ]) {
            yield* expectNothingWritten(probe, write, /"pair\[1\]": .*no empty set/)
          }
        }),
      ),
  },
  {
    name: "a field whose encoded form the marshaller won't take is refused, naming it",
    run: (h) =>
      h.on(
        worldOf(Schema.Struct({ id: Schema.String, h: Schema.HashSet(Schema.String) })),
        (db, probe) =>
          Effect.gen(function* () {
            yield* expectNothingWritten(
              probe,
              () => db.entities.Rows.put({ id: "1", h: HashSet.make("a") }).asEffect(),
              /"h\./,
            )
            // A limit, as it always was: an empty one marshals as a map of its internals.
            yield* db.entities.Rows.put({ id: "1", h: HashSet.empty<string>() }).asEffect()
            expect(live(yield* probe.rows())!.h?.M).toBeDefined()
            const read = yield* db.entities.Rows.get(key)
            expect(HashSet.size(read.h)).toBe(0)
          }),
      ),
  },
  {
    name: "a packed field isn't judged as if it were stored natively",
    run: (h) => {
      const Boxed = Schema.Struct({ id: Schema.String, box: Schema.Struct({ x: Schema.Number }) })
      return h.on(
        worldOf(
          DynamoModel.configure(Boxed, {
            box: { storedAs: DynamoModel.Packed({ format: "json" }) as never },
          }),
          { versioned: true },
        ),
        (db, probe) =>
          Effect.gen(function* () {
            // Past `MAX_SAFE_INTEGER`, which a native number refuses and JSON holds.
            const huge = 2 ** 60
            yield* db.entities.Rows.put({ id: "1", box: { x: huge } }).asEffect()
            expect(live(yield* probe.rows())!.box).toEqual({ S: `{"x":${huge}}` })
            yield* db.entities.Rows.update(key)
              .set({ box: { x: huge * 2 } })
              .asEffect()
            expect(live(yield* probe.rows())!.box).toEqual({ S: `{"x":${huge * 2}}` })
            expect(Number(live(yield* probe.rows())!.version?.N)).toBe(2)
          }),
      )
    },
  },
  {
    name: "an immutable field holding one is refused on an update",
    run: (h) =>
      h.on(worldOf(DynamoModel.configure(Holding, { pair: { immutable: true } })), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", pair: ["a", new Set(["b"])] }).asEffect()
          yield* expectNothingWritten(
            probe,
            () =>
              db.entities.Rows.update(key)
                .set({ pair: ["a", empty()] })
                .asEffect(),
            /\.set\(\): "pair\[1\]": .*no empty set/,
          )
        }),
      ),
  },
  {
    name: "upsert holding one sends nothing",
    run: (h) =>
      h.on(worldOf(Holding), (db, probe) =>
        expectNothingWritten(
          probe,
          () => db.entities.Rows.upsert({ id: "1", pair: ["a", empty()] }).asEffect(),
          /"pair\[1\]": .*no empty set/,
        ),
      ),
  },
  {
    name: "a time-series append holding one sends nothing",
    run: (h) => {
      const Reading = Schema.Struct({
        id: Schema.String,
        at: Schema.Number,
        pair: Schema.Tuple([Schema.String, Strings]),
      })
      return h.on(
        worldOf(Reading, { timeSeries: { orderBy: "at", appendInput: Reading } }),
        (db, probe) =>
          expectNothingWritten(
            probe,
            () => db.entities.Rows.append({ id: "1", at: 1, pair: ["a", empty()] }).asEffect(),
            /"pair\[1\]": .*no empty set/,
          ),
      )
    },
  },
  {
    name: "Transaction and Batch holding one send nothing",
    run: (h) =>
      h.on(worldOf(Holding), (db, probe) =>
        Effect.gen(function* () {
          const put = () => db.entities.Rows.put({ id: "1", pair: ["a", empty()] })
          yield* expectNothingWritten(
            probe,
            () => Transaction.transactWrite([put()] as never),
            /"pair\[1\]": .*no empty set/,
          )
          yield* expectNothingWritten(
            probe,
            () => Batch.write([put()] as never),
            /"pair\[1\]": .*no empty set/,
          )
        }),
      ),
  },
  {
    name: "a condition or filter comparing with one is refused, naming the field",
    run: (h) =>
      h.on(worldOf(Holding), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", n: 1 }).asEffect()
          yield* expectNothingWritten(
            probe,
            () =>
              db.entities.Rows.update(key)
                .set({ n: 2 })
                .condition((t: any, { eq }: any) => eq(t.lists, [empty()]))
                .asEffect(),
            /"lists".*"\[0\]"|"lists".*\[0\]/,
          )
          for (const filter of [
            (t: any, { eq }: any) => eq(t.lists, [empty()]),
            (t: any, { ne }: any) => ne(t.lists, [empty()]),
            (t: any, { contains }: any) => contains(t.lists, [empty()]),
            (t: any, { gt }: any) => gt(t.n, Number.NaN),
            (t: any, { between }: any) => between(t.n, 1, Number.NaN),
            (t: any, { isIn }: any) => isIn(t.n, [1, Number.NaN]),
          ]) {
            yield* expectNothingWritten(
              probe,
              () => db.entities.Rows.scan().filter(filter).collect(),
              /Comparing "(lists|n)" with a value DynamoDB can't store/,
            )
          }
          yield* expectNothingWritten(
            probe,
            () =>
              db.entities.Rows.scan()
                .filter({ lists: [empty()] })
                .collect(),
            /Comparing "lists" with a value DynamoDB can't store/,
          )
        }),
      ),
  },
  {
    name: "a condition with no path to name still says what it refuses",
    run: (h) =>
      h.on(worldOf(Holding), (db, probe) =>
        expectNothingWritten(
          probe,
          () =>
            db.entities.Rows.scan()
              .filter((_t: any, { eq }: any) => eq(1, [empty()]))
              .collect(),
          /Comparing a value with a value DynamoDB can't store/,
        ),
      ),
  },
  {
    name: "an aggregate holding one, in a tuple, a list or an unknown field, writes nothing",
    run: (h) => {
      const { world, Assemblies } = holdingAggregateWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          for (const [change, says] of [
            [{ anything: [empty()] }, /"anything\[0\]": .*no empty set/],
            [{ header: { lists: [empty()] } }, /"lists\[0\]": .*no empty set/],
            [{ parts: [{ partId: "p", pair: ["a", empty()] }] }, /"pair\[1\]": .*no empty set/],
          ] as const) {
            yield* expectNothingWritten(
              probe,
              () => Assemblies.create({ ...holdingInput(), ...change }),
              says,
            )
          }
        }),
      )
    },
  },
  {
    name: "an aggregate update to one reads, and writes nothing",
    run: (h) => {
      const { world, Assemblies } = holdingAggregateWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          yield* Assemblies.create(holdingInput())
          yield* expectNothingWritten(
            probe,
            () =>
              Assemblies.update({ id: "1" }, ({ state }: any) => ({
                ...state,
                anything: [empty()],
              })),
            /"anything\[0\]": .*no empty set/,
            { reads: true },
          )
        }),
      )
    },
  },
  {
    name: "an event holding one writes nothing, in a tuple, a list or an unknown field",
    run: (h) => {
      const { world, Stream } = movedWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          for (const [fields, says] of [
            [{ pair: ["a", empty()] }, /"data\.pair\[1\]": .*no empty set/],
            [{ lists: [empty()] }, /"data\.lists\[0\]": .*no empty set/],
            [{ anything: { deep: [empty()] } }, /"data\.anything\.deep\[0\]": .*no empty set/],
          ] as const) {
            yield* expectNothingWritten(
              probe,
              () => Stream.append({ moveId: "m" }, [movedOf(fields)], 0),
              says,
            )
          }
        }),
      )
    },
  },
  {
    name: "metadata holding one writes nothing, shared or per event",
    run: (h) => {
      const { world, Stream } = movedWorld()
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          yield* expectNothingWritten(
            probe,
            () =>
              Stream.append({ moveId: "m" }, [movedOf({})], 0, {
                metadata: { lists: [empty()] },
              }),
            /"metadata\.lists\[0\]": .*no empty set/,
          )
          yield* expectNothingWritten(
            probe,
            () =>
              Stream.append({ moveId: "m" }, [movedOf({})], 0, {
                eventMetadata: [{ lists: [empty()] }],
              }),
            /"metadata\.lists\[0\]": .*no empty set/,
          )
        }),
      )
    },
  },
  {
    name: "a snapshot state holding one writes nothing, inline or on its own",
    run: (h) => {
      const State = Schema.Struct({ lists: Schema.Array(Strings) })
      const { world, Stream } = movedWorld({
        snapshot: { schema: State, mode: "inline" },
      })
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          yield* expectNothingWritten(
            probe,
            () =>
              Stream.append({ moveId: "m" }, [movedOf({})], 0, {
                snapshot: { lists: [empty()] },
              }),
            /"state\.lists\[0\]": .*no empty set/,
          )
          yield* Stream.append({ moveId: "m" }, [movedOf({})], 0, {
            snapshot: { lists: [new Set(["a"])] },
          })
          yield* expectNothingWritten(
            probe,
            () => Stream.writeSnapshot({ moveId: "m" }, { lists: [empty()] }, 1),
            /"state\.lists\[0\]": .*no empty set/,
          )
        }),
      )
    },
  },
  {
    name: "a command deciding an event holding one reads, and writes nothing",
    run: (h) => {
      const { world, Stream } = movedWorld()
      const handle = EventStore.commandHandler(
        {
          initialState: { count: 0 },
          decide: () => Effect.succeed([movedOf({ lists: [empty()] })]),
          evolve: (state: any) => state,
        } as never,
        Stream,
      ) as any
      return h.on(world, (_db, probe) =>
        expectNothingWritten(
          probe,
          () => handle({ moveId: "m" }, {}),
          /"data\.lists\[0\]": .*no empty set/,
          { reads: true },
        ),
      )
    },
  },
  {
    name: "an event beside one holding one in another stream's appendOp writes nothing",
    run: (h) => {
      const { world, Stream } = movedWorld()
      const { Stream: Other } = (() => {
        const made = EventStore.makeStream({
          table: world.MainTable,
          streamName: "OtherMoves",
          events: [Moved],
          streamId: { composite: ["moveId"] },
        } as never) as any
        return { Stream: made }
      })()
      return h.on(world, (_db, probe) =>
        expectNothingWritten(
          probe,
          () =>
            Stream.append({ moveId: "m" }, [movedOf({})], 0, {
              additionalItems: [
                Other.appendOp({ moveId: "n" }, [movedOf({ lists: [empty()] })], 0),
              ],
            }),
          /"data\.lists\[0\]": .*no empty set/,
        ),
      )
    },
  },
]

// ---------------------------------------------------------------------------
// `undefined` in a list: marshalling drops it, closing the list up
// ---------------------------------------------------------------------------

const S_ = Schema.String
const U_ = Schema.UndefinedOr(Schema.String)
const O_ = Schema.optional(Schema.String)

const withField = (field: Schema.Top) =>
  Schema.Struct({ id: Schema.String, t: Schema.optional(field) })

const positionScenarios: ReadonlyArray<Scenario> = [
  ...(
    [
      ["a gap before a required position", Schema.Tuple([S_, U_, S_]), ["a", undefined, "b"], 1],
      ["a gap at the start", Schema.Tuple([U_, S_]), [undefined, "b"], 0],
      ["an empty required last position", Schema.Tuple([S_, U_]), ["a", undefined], 1],
      ["a gap before an optional position", Schema.Tuple([S_, U_, O_]), ["a", undefined, "c"], 1],
      ["a gap in optional positions", Schema.Tuple([S_, O_, O_]), ["a", undefined, "c"], 1],
    ] as const
  ).flatMap(([name, tuple, value, position]) => [
    {
      name: `a tuple, ${name}: a put is refused, naming the field and the position`,
      run: (h: Harness) =>
        h.on(worldOf(withField(tuple)), (db, probe) =>
          expectNothingWritten(
            probe,
            () => db.entities.Rows.put({ id: "1", t: value }).asEffect(),
            new RegExp(`Position ${position} holds undefined`),
          ),
        ),
    },
    {
      name: `a tuple, ${name}: .set and pathSet are refused`,
      run: (h: Harness) =>
        h.on(worldOf(withField(tuple)), (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1" }).asEffect()
            yield* expectNothingWritten(
              probe,
              () => db.entities.Rows.update(key).set({ t: value }).asEffect(),
              /holds undefined/,
            )
            yield* expectNothingWritten(
              probe,
              () =>
                db.entities.Rows.update(key)
                  .pathSet({ segments: ["t"], value, isPath: false })
                  .asEffect(),
              /holds undefined/,
            )
          }),
        ),
    },
  ]),
  {
    name: "a tuple: a last optional position holding undefined goes, and the row reads",
    run: (h) =>
      h.on(worldOf(withField(Schema.Tuple([S_, O_]))), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", t: ["a", undefined] }).asEffect()
          expect(live(yield* probe.rows())!.t).toEqual({ L: [{ S: "a" }] })
          expect((yield* db.entities.Rows.get(key)).t).toEqual(["a"])
          yield* db.entities.Rows.put({ id: "1", t: ["a"] }).asEffect()
          expect((yield* db.entities.Rows.get(key)).t).toEqual(["a"])
        }),
      ),
  },
  {
    name: "a tuple with every position holding a value stores the same bytes",
    run: (h) =>
      h.on(worldOf(withField(Schema.Tuple([S_, U_, S_]))), (db, probe) =>
        Effect.gen(function* () {
          yield* db.entities.Rows.put({ id: "1", t: ["a", "b", "c"] }).asEffect()
          expect(live(yield* probe.rows())!.t).toEqual({
            L: [{ S: "a" }, { S: "b" }, { S: "c" }],
          })
          expect((yield* db.entities.Rows.get(key)).t).toEqual(["a", "b", "c"])
        }),
      ),
  },
  {
    name: "a tuple nested in a struct, a list, a union and a class is refused the same",
    run: (h) => {
      class Boxed extends Schema.Class<Boxed>("NoStoredFormBoxed")({
        t: Schema.Tuple([S_, U_, S_]),
      }) {}
      const gap = ["a", undefined, "b"]
      const model = Schema.Struct({
        id: Schema.String,
        inStruct: Schema.optional(Schema.Struct({ t: Schema.Tuple([S_, U_, S_]) })),
        inList: Schema.optional(Schema.Array(Schema.Tuple([S_, U_, S_]))),
        inUnion: Schema.optional(Schema.Union([Schema.Number, Schema.Tuple([S_, U_, S_])])),
        inClass: Schema.optional(Boxed),
      })
      return h.on(worldOf(model), (db, probe) =>
        Effect.gen(function* () {
          for (const input of [
            { inStruct: { t: gap } },
            { inList: [gap] },
            { inUnion: gap },
            { inClass: { t: gap } },
          ]) {
            const sent = probe.sent()
            const exit = yield* db.entities.Rows.put({ id: "1", ...input })
              .asEffect()
              .pipe(Effect.flip)
            expect((exit as any)._tag).toBe("ValidationError")
            expect(probe.sent()).toBe(sent)
          }
        }),
      )
    },
  },
  {
    name: "an event, metadata, snapshot state and aggregate holding such a tuple write nothing",
    run: (h) => {
      const gap = ["a", undefined, "b"]
      const State = Schema.Struct({
        gap: Schema.Tuple([Schema.String, Schema.UndefinedOr(Schema.String), Schema.String]),
      })
      const { world, Stream } = movedWorld({ snapshot: { schema: State, mode: "inline" } })
      const Assemblies = Aggregate.make(HoldingAssembly, {
        table: world.MainTable,
        schema,
        pk: { field: "pk", composite: ["id"] },
        collection: { name: "assembly" },
        root: { entityType: "HoldingRoot" },
        edges: {
          header: Aggregate.one({ entityType: "HoldingHeader" }),
          parts: Aggregate.many({ entityType: "HoldingPart", sk: { composite: ["partId"] } }),
        },
      } as never) as any
      return h.on(world, (_db, probe) =>
        Effect.gen(function* () {
          const held = /holds undefined/
          yield* expectNothingWritten(
            probe,
            () => Stream.append({ moveId: "m" }, [movedOf({ gap })], 0),
            /holds undefined/,
          )
          yield* expectNothingWritten(
            probe,
            () => Stream.append({ moveId: "m" }, [movedOf({})], 0, { metadata: { gap } }),
            held,
          )
          yield* expectNothingWritten(
            probe,
            () => Stream.append({ moveId: "m" }, [movedOf({})], 0, { snapshot: { gap } }),
            held,
          )
          yield* expectNothingWritten(
            probe,
            () =>
              Assemblies.create({
                ...holdingInput(),
                header: { lists: [new Set(["a"])], gap },
              }),
            held,
          )
        }),
      )
    },
  },
  {
    // A limit: the check sees the domain value, and `Option.none()` isn't `undefined` until it's
    // encoded. Documented, and pinned so it's seen if it changes.
    name: "a tuple position that only encodes to undefined isn't seen",
    run: (h) =>
      h.on(
        worldOf(withField(Schema.Tuple([S_, Schema.OptionFromUndefinedOr(Schema.String), S_]))),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({ id: "1", t: ["a", Option.none(), "b"] }).asEffect()
            expect(live(yield* probe.rows())!.t).toEqual({ L: [{ S: "a" }, { S: "b" }] })
          }),
      ),
  },
  {
    // Not refused, deliberately: a put and a read of these both work today, and a caller
    // can rely on the list closing up. It's a documented limit, and the owner's to change.
    name: "a list holding undefined still closes up: stored and read back without it",
    run: (h) =>
      h.on(
        worldOf(
          Schema.Struct({
            id: Schema.String,
            list: Schema.Array(U_),
            anything: Schema.Unknown,
          }),
        ),
        (db, probe) =>
          Effect.gen(function* () {
            yield* db.entities.Rows.put({
              id: "1",
              list: ["a", undefined, "b"],
              anything: ["a", undefined, "b"],
            }).asEffect()
            const row = live(yield* probe.rows())!
            expect(row.list).toEqual({ L: [{ S: "a" }, { S: "b" }] })
            expect(row.anything).toEqual({ L: [{ S: "a" }, { S: "b" }] })
            const read = yield* db.entities.Rows.get(key)
            expect(read.list).toEqual(["a", "b"])
            expect(read.anything).toEqual(["a", "b"])
          }),
      ),
  },
]

export const allScenarios = {
  noStoredForm: kindScenarios,
  noStoredFormLifecycle: kindLifecycleScenarios,
  noStoredFormSets: setScenarios,
  noStoredFormNested: nestedScenarios,
  noStoredFormOptional: optionalScenarios,
  noStoredFormRefusals: refusalScenarios,
  noStoredFormShapes: shapeScenarios,
  noStoredFormImmutable: immutableScenarios,
  noStoredFormPacked: packedScenarios,
  noStoredFormReads: readScenarios,
  noStoredFormExpressions: expressionScenarios,
  noStoredFormAggregates: aggregateScenarios,
  noStoredFormEvents: eventScenarios,
  relativeUpdates: honestScenarios,
  noStoredFormUnstorable: unstorableScenarios,
  noStoredFormPositions: positionScenarios,
}
