/**
 * The paths beyond an entity's own update and read that write or read an entity whose sparse map a
 * `field:` rename stores whole (`counts`, configured `{ storedAs: SparseMap(), field: "sr" }`), on
 * a row holding the map whole (`sr`), as entries (`counts#a`) or both (an entry beside `sr`) (#238):
 * a time-series `append`, a soft delete and its `restore`, `Batch.get` / `Batch.write`, an
 * aggregate's ref to such an entity, a projection into a read model holding the map, `rekey`, and
 * an `ADD` of an entry.
 *
 * `fixtures/renamed-sparse-map-paths-1.40.0.json` holds what the published 1.40.0 did in each case,
 * every request whole. Every path but the `ADD` is pinned as 1.40.0 left it: the head sends the same
 * requests and leaves the same rows. 1.40.0's `ADD` of an entry, where the update held the row (a
 * transaction's plan, a retained entity's read), added an attribute of its own (`counts#b`) beside
 * `sr`, which a read never sees: the write reported success and the read still said `{ a: 1 }`. The
 * head adds below `sr` (`ADD sr.b`), guarded `attribute_exists(sr)`, so the read sees it; the case
 * differs from 1.40.0 only in the fields `ADDED` names.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Batch from "../../src/Batch.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import { createPathBuilder } from "../../src/internal/PathBuilder.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"
import { outcomeOf, rowsOf } from "./RenamedSparseMap.js"
import { wholeOf } from "./RenamedSparseMapWrites.js"
import { comparedCases, expectDiffersOnly } from "./WholeDiff.js"

interface Captured {
  readonly outcome: any
  readonly sent: ReadonlyArray<any>
  readonly rows: ReadonlyArray<any>
  readonly read: any
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/renamed-sparse-map-paths-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: Record<string, Captured> }
const captures = comparedCases("renamed-sparse-map-paths-1.40.0.json", fixture.cases)

/** A timestamp inside a longer string (a tombstone's sort key) as `<time>`, a write token as `<token>`. */
const EMBEDDED_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g
const settled = (value: unknown): any =>
  JSON.parse(JSON.stringify(value), (_key, held) =>
    typeof held === "string" && /^[0-9a-f]{32}$/.test(held)
      ? "<token>"
      : typeof held === "string"
        ? held.replace(EMBEDDED_ISO, "<time>")
        : held,
  )

/**
 * A read-first delete's guard (`#dg<i> = :dg<i>` per attribute of the row it read, and
 * `attribute_not_exists(#dg<i>)`) numbers the attributes in the order the table returned them,
 * which an in-memory table and DynamoDB Local don't share: renumbered by the attribute each names,
 * the same clauses compare equal whatever that order was.
 */
const guardInNameOrder = (request: any): any => {
  const names: Record<string, string> | undefined = request.ExpressionAttributeNames
  const condition: string | undefined = request.ConditionExpression
  if (names === undefined || condition === undefined || !condition.includes("#dg")) return request
  const old = Object.keys(names)
    .filter((name) => /^#dg\d+$/.test(name))
    .map((name) => Number(name.slice(3)))
  const sorted = [...old].sort((a, b) =>
    names[`#dg${a}`]! < names[`#dg${b}`]! ? -1 : names[`#dg${a}`]! > names[`#dg${b}`]! ? 1 : 0,
  )
  const renumbered = new Map(sorted.map((was, now) => [was, now]))
  const parts = condition.split(" AND ")
  const guarded = parts
    .filter((part) => part.includes("#dg"))
    .map((part) =>
      part.replace(/([#:])dg(\d+)/g, (_m, sigil, i) => `${sigil}dg${renumbered.get(Number(i))}`),
    )
    .sort((a, b) => Number(/dg(\d+)/.exec(a)![1]) - Number(/dg(\d+)/.exec(b)![1]))
  let next = 0
  const values: Record<string, unknown> | undefined = request.ExpressionAttributeValues
  return {
    ...request,
    ConditionExpression: parts
      .map((part) => (part.includes("#dg") ? guarded[next++]! : part))
      .join(" AND "),
    ExpressionAttributeNames: Object.fromEntries(
      Object.entries(names).map(([name, held]) =>
        /^#dg\d+$/.test(name)
          ? [`#dg${renumbered.get(Number(name.slice(3)))}`, held]
          : [name, held],
      ),
    ),
    ...(values === undefined
      ? {}
      : {
          ExpressionAttributeValues: Object.fromEntries(
            Object.entries(values).map(([name, held]) =>
              /^:dg\d+$/.test(name)
                ? [`:dg${renumbered.get(Number(name.slice(3)))}`, held]
                : [name, held],
            ),
          ),
        }),
  }
}

/**
 * A case as compared: every guard in name order, and of a `rekey` report's capacity the number of
 * requests (the units are the table's to report: an in-memory one reports none). A `rekey`
 * report is compared without the fields it gained after 1.40.0 (`guardGaps`, `journal`,
 * `reservations`, each member's too: #252; `ambiguous`, `zonesRewritten`, each member's too, and
 * `skipped.ambiguousOwner`), which `rekey`'s own suites pin.
 */
const comparable = (captured: Captured): Captured => {
  const walk = (value: any): any =>
    Array.isArray(value)
      ? value.map(walk)
      : value !== null && typeof value === "object"
        ? guardInNameOrder(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)])))
        : value
  const since140 = (counts: any) => {
    const {
      guardGaps: _gaps,
      journal: _journal,
      reservations: _reservations,
      ambiguous: _ambiguous,
      zonesRewritten: _zones,
      ...rest
    } = counts
    if (rest.skipped === undefined) return rest
    const { ambiguousOwner: _owner, ...skipped } = rest.skipped
    return { ...rest, skipped }
  }
  const report = captured.outcome.ok
  return walk({
    ...captured,
    outcome:
      report?.capacity === undefined
        ? captured.outcome
        : {
            ok: {
              ...since140(report),
              ...(report.byMember === undefined
                ? {}
                : {
                    byMember: Object.fromEntries(
                      Object.entries(report.byMember).map(([name, counts]) => [
                        name,
                        since140(counts),
                      ]),
                    ),
                  }),
              capacity: { requests: report.capacity.requests },
            },
          },
  })
}

const definitions = () => {
  const counts = Schema.Record(Schema.String, Schema.Number)
  const renamed = { counts: { storedAs: DynamoModel.SparseMap(), field: "sr" } }
  const primaryKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
  const schema = DynamoSchema.make({ name: "rp", version: 1, escapeKeys: true })
  const configured = (fields: Record<string, Schema.Top>, extra: object = {}) =>
    DynamoModel.configure(Schema.Struct(fields), { ...renamed, ...extra } as never)
  const Line = Schema.Struct({ lineId: Schema.String, counts })
  const Lines = Entity.make({
    model: DynamoModel.configure(Line, { ...renamed, lineId: { identifier: true } } as never),
    entityType: "Line",
    primaryKey: {
      pk: { field: "pk", composite: ["lineId"] },
      sk: { field: "sk", composite: [] },
    },
  } as never)
  const Tallies = Entity.make({
    model: configured({ id: Schema.String, counts, version: Schema.Number }),
    entityType: "Tally",
    primaryKey,
  } as never)
  const entities: Record<string, any> = {
    Plain: Entity.make({
      model: configured({ id: Schema.String, counts }),
      entityType: "Plain",
      primaryKey,
    } as never),
    Retained: Entity.make({
      model: configured({ id: Schema.String, counts }),
      entityType: "Retained",
      primaryKey,
      versioned: { retain: true },
    } as never),
    Series: Entity.make({
      model: configured({ id: Schema.String, at: Schema.Number, counts }),
      entityType: "Series",
      primaryKey,
      timeSeries: {
        orderBy: "at",
        appendInput: Schema.Struct({ id: Schema.String, at: Schema.Number, counts }),
      },
    } as never),
    Deleted: Entity.make({
      model: configured({ id: Schema.String, counts }),
      entityType: "Deleted",
      primaryKey,
      softDelete: true,
    } as never),
    Keyed: Entity.make({
      model: configured({ id: Schema.String, name: Schema.String, counts }),
      entityType: "Keyed",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: ["name"] },
      },
    } as never),
    Lines,
    Tallies,
  }
  const MainTable = Table.make({ schema, entities } as never)
  const Sheets = Aggregate.make(Schema.Struct({ id: Schema.String, line: Line }), {
    table: MainTable,
    schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "sheet" },
    root: { entityType: "Sheet" },
    edges: { line: Aggregate.ref(Lines as never) },
  } as never)
  class Counted extends Schema.TaggedClass<Counted>()("Counted", {
    key: Schema.String,
    by: Schema.Number,
  }) {}
  const Counts = EventStore.makeStream({
    table: MainTable,
    streamName: "Count",
    events: [Counted],
    streamId: { composite: ["id"] },
  } as never) as any
  const Projection = EventStore.projection({
    stream: Counts,
    readModel: Tallies,
    key: (id: any) => ({ id: id.id }),
    initial: (id: any) => ({ id: id.id, counts: {}, version: 0 }),
    evolve: (state: any, event: any) =>
      Effect.succeed({
        ...state,
        counts: {
          ...state.counts,
          [event.data.key]: (state.counts[event.data.key] ?? 0) + event.data.by,
        },
      }),
    checkpoint: "version",
  } as never) as any
  return { entities, MainTable, Sheets, Counted, Counts, Projection }
}

type Defined = ReturnType<typeof definitions>

/** Key of `entity`'s row `a` (Lines: `l`), as the library composes it. */
const keyOf = (entity: string) =>
  entity === "Lines"
    ? { pk: { S: "$rp#v1#line#lineid_l" }, sk: { S: "$rp#v1#line" } }
    : {
        pk: { S: `$rp#v1#${entity === "Tallies" ? "tally" : entity.toLowerCase()}#id_a` },
        sk: { S: `$rp#v1#${entity === "Tallies" ? "tally" : entity.toLowerCase()}` },
      }

/** The row's map moved from `sr` to its entries (`counts#a` = 1), or an entry `counts#a` = 7 beside `sr`. */
const reform = (entity: string, tableName: string, form: string) =>
  Effect.gen(function* () {
    if (form === "whole") return
    const raw = yield* DynamoClient
    yield* raw.updateItem({
      TableName: tableName,
      Key: keyOf(entity),
      UpdateExpression: form === "entries" ? "SET #e = :v REMOVE #w" : "SET #e = :v",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#e": "counts#a", ...(form === "entries" ? { "#w": "sr" } : {}) },
      ExpressionAttributeValues: { ":v": { N: form === "entries" ? "1" : "7" } },
    })
  })

const seedAs =
  (entity: string, input: object, form: string) =>
  (db: any, tableName: string): Effect.Effect<unknown, unknown, any> =>
    Effect.gen(function* () {
      yield* db.entities[entity].put(input).asEffect()
      yield* reform(entity, tableName, form)
    })

interface Case {
  readonly name: string
  readonly seed: (db: any, tableName: string) => Effect.Effect<unknown, unknown, any>
  readonly body: (db: any, defined: Defined) => Effect.Effect<unknown, unknown, any>
  readonly read: (db: any) => Effect.Effect<unknown, unknown, any>
}

const FORMS = ["whole", "entries", "both"] as const
const entryOf = (key: string) =>
  (createPathBuilder([], undefined, { counts: { prefix: "counts" } }) as any).counts.entry(key)
    .segments as ReadonlyArray<string>

const cases: Array<Case> = []
for (const form of FORMS) {
  cases.push({
    name: `timeSeries, the map ${form}: append({ at: 2, counts: { b: 2 } })`,
    seed: seedAs("Series", { id: "a", at: 1, counts: { a: 1 } }, form),
    body: (db) => db.entities.Series.append({ id: "a", at: 2, counts: { b: 2 } }).asEffect(),
    read: (db) =>
      Effect.all({
        get: db.entities.Series.get({ id: "a" }),
        history: db.entities.Series.history({ id: "a" }).collect(),
      }),
  })
}
for (const form of FORMS) {
  cases.push({
    name: `softDelete, the map ${form}: delete, deleted.get, restore`,
    seed: seedAs("Deleted", { id: "a", counts: { a: 1 } }, form),
    body: (db) =>
      Effect.gen(function* () {
        yield* db.entities.Deleted.delete({ id: "a" }).asEffect()
        const tombstone = yield* db.entities.Deleted.deleted.get({ id: "a" })
        const restored = yield* db.entities.Deleted.restore({ id: "a" })
        return { tombstone, restored }
      }),
    read: (db) => db.entities.Deleted.get({ id: "a" }),
  })
}
for (const form of FORMS) {
  const seed = seedAs("Plain", { id: "a", counts: { a: 1 } }, form)
  const read = (db: any) => db.entities.Plain.get({ id: "a" })
  cases.push(
    {
      name: `Batch.get, the map ${form}`,
      seed,
      body: (db) => Batch.get([db.entities.Plain.get({ id: "a" })] as never),
      read,
    },
    {
      name: `Batch.write put({ counts: { b: 2 } }), the map ${form}`,
      seed,
      body: (db) => Batch.write([db.entities.Plain.put({ id: "a", counts: { b: 2 } })] as never),
      read,
    },
    {
      name: `Batch.write delete, the map ${form}`,
      seed,
      body: (db) => Batch.write([db.entities.Plain.delete({ id: "a" })] as never),
      read,
    },
  )
}
for (const form of FORMS) {
  cases.push({
    name: `aggregate ref, the map ${form}: create`,
    seed: seedAs("Lines", { lineId: "l", counts: { a: 1 } }, form),
    body: (db) => db.aggregates.Sheets.create({ id: "s", lineId: "l" }),
    read: (db) => db.aggregates.Sheets.get({ id: "s" }),
  })
}
for (const form of FORMS) {
  cases.push({
    name: `projection, the map ${form}: applyBatch`,
    seed: seedAs("Tallies", { id: "a", counts: { a: 1 }, version: 1 }, form),
    body: (_db, { Counted, Counts, Projection }) =>
      Effect.gen(function* () {
        yield* Counts.append({ id: "a" }, [new Counted({ key: "z", by: 1 })], 0)
        yield* Counts.append({ id: "a" }, [new Counted({ key: "b", by: 2 })], 1)
        const events = yield* Counts.read({ id: "a" })
        return yield* Projection.applyBatch(events)
      }),
    read: (db) => db.entities.Tallies.get({ id: "a" }),
  })
}
// rekey: a row whose sort key 1.36 composed unescaped (`x y`), moved to the key the head composes.
for (const form of FORMS) {
  cases.push({
    name: `rekey, the map ${form}`,
    seed: (db, tableName) =>
      Effect.gen(function* () {
        yield* db.entities.Keyed.put({ id: "a", name: "x y", counts: { a: 1 } }).asEffect()
        const raw = yield* DynamoClient
        const scanned = yield* raw.scan({ TableName: tableName, ConsistentRead: true })
        const row = scanned.Items![0]!
        yield* raw.deleteItem({ TableName: tableName, Key: { pk: row.pk!, sk: row.sk! } })
        const legacy: Record<string, any> = {
          ...row,
          sk: { S: row.sk!.S!.replaceAll("%20", " ") },
        }
        if (form === "entries") {
          delete legacy.sr
          legacy["counts#a"] = { N: "1" }
        }
        if (form === "both") legacy["counts#a"] = { N: "7" }
        yield* raw.putItem({ TableName: tableName, Item: legacy })
      }),
    body: (db) => db.tables.MainTable.rekey(),
    read: (db) => db.entities.Keyed.get({ id: "a", name: "x y" }),
  })
}

/** An `ADD` of an entry, on a row holding the map whole: as 1.40.0 did, or into `sr` (`ADDED`). */
const adds: ReadonlyArray<readonly [label: string, op: (u: any) => any]> = [
  [".add({ 'counts#b': 1 })", (u) => u.add({ "counts#b": 1 })],
  [".add({ 'counts#a': 1 })", (u) => u.add({ "counts#a": 1 })],
  ["pathAdd of counts.entry('b'), 1", (u) => u.pathAdd({ segments: entryOf("b"), value: 1 })],
]
for (const [label, op] of adds) {
  for (const entity of ["Plain", "Retained"]) {
    for (const inTransaction of entity === "Plain" ? [true] : [false, true]) {
      cases.push({
        name: `${entity}, the map whole: ${label}${inTransaction ? ", in a transaction" : ""}`,
        seed: seedAs(entity, { id: "a", counts: { a: 1 } }, "whole"),
        body: (db) => {
          const update = op(db.entities[entity].update({ id: "a" }))
          return inTransaction ? Transaction.transactWrite([update]) : update.asEffect()
        },
        read: (db) => db.entities[entity].get({ id: "a" }),
      })
    }
  }
}

/** The update the case's transaction sent, as `sent[1]` names it. */
const UPDATE = "sent[1].transactWriteItems.TransactItems[0].Update"
const fieldsOf = (names: ReadonlyArray<string>, values: ReadonlyArray<string>) => [
  `${UPDATE}.UpdateExpression`,
  `${UPDATE}.ConditionExpression`,
  ...names.map((name) => `${UPDATE}.ExpressionAttributeNames.${name}`),
  ...values.map((value) => `${UPDATE}.ExpressionAttributeValues.${value}`),
]

/**
 * Each `ADD` the head sends into `sr` (`ADD sr.b`, guarded `attribute_exists(sr)` as `#fm0`): the
 * fields that differ from 1.40.0's, which added `counts#b` beside it, and what the read then sees.
 */
const ADDED: Record<string, { readonly fields: ReadonlyArray<string>; readonly counts: object }> = {
  "Plain, the map whole: .add({ 'counts#b': 1 }), in a transaction": {
    fields: [
      ...fieldsOf(["#a0", "#m0", "#m1", "#fm0"], []),
      "rows[0].counts#b",
      "rows[0].sr.M.b",
      "read.ok.counts.b",
    ],
    counts: { a: 1, b: 1 },
  },
  "Plain, the map whole: .add({ 'counts#a': 1 }), in a transaction": {
    fields: [
      ...fieldsOf(["#a0", "#m0", "#m1", "#fm0"], []),
      "rows[0].counts#a",
      "rows[0].sr.M.a.N",
      "read.ok.counts.a",
    ],
    counts: { a: 2 },
  },
  "Plain, the map whole: pathAdd of counts.entry('b'), 1, in a transaction": {
    fields: [
      ...fieldsOf(["#pad0", "#pad1", "#fm0"], [":pad1", ":pad2"]),
      "rows[0].counts#b",
      "rows[0].sr.M.b",
      "read.ok.counts.b",
    ],
    counts: { a: 1, b: 1 },
  },
  "Retained, the map whole: pathAdd of counts.entry('b'), 1": {
    fields: [
      "outcome.ok.counts.b",
      ...fieldsOf(["#pad0", "#pad1", "#fm0"], [":pad1", ":pad2"]),
      "rows[0].counts#b",
      "rows[0].sr.M.b",
      "read.ok.counts.b",
    ],
    counts: { a: 1, b: 1 },
  },
  "Retained, the map whole: pathAdd of counts.entry('b'), 1, in a transaction": {
    fields: [
      ...fieldsOf(["#pad0", "#pad1", "#fm0"], [":pad1", ":pad2"]),
      "rows[0].counts#b",
      "rows[0].sr.M.b",
      "read.ok.counts.b",
    ],
    counts: { a: 1, b: 1 },
  },
}

/** One case on a table of its own, every request it sent kept whole. */
const runCase = (open: OpenTable, one: Case) =>
  Effect.gen(function* () {
    const defined = definitions()
    const log: Array<unknown> = []
    return yield* onTable(
      recordingRequests(open, log),
      0,
      defined.MainTable,
      { entities: defined.entities, aggregates: { Sheets: defined.Sheets } },
      (db, table) =>
        Effect.gen(function* () {
          yield* one.seed(db, table.name)
          log.length = 0
          const exit = yield* Effect.exit(Effect.suspend(() => one.body(db, defined)))
          const sent = log.map((request) => wholeOf(request, table.name))
          const rows = rowsOf(yield* table.rows)
          const read = yield* Effect.exit(one.read(db))
          return settled({
            outcome: outcomeOf(exit),
            sent,
            rows,
            read: outcomeOf(read),
          }) as Captured
        }),
    )
  })

export const renamedSparseMapPathsSuite = (open: OpenTable) => {
  for (const one of cases) {
    const was = comparable(captures.compared(one.name))
    const added = ADDED[one.name]
    it.effect(
      added === undefined
        ? `${one.name}: as 1.40.0`
        : `${one.name}: adds into sr, where 1.40.0 added an attribute a read never sees`,
      () =>
        Effect.gen(function* () {
          const got = comparable(yield* runCase(open, one))
          if (added === undefined) {
            expect(got).toEqual(was)
            return
          }
          expectDiffersOnly(was, got, added.fields)
          expect(was.read.ok.counts).toEqual({ a: 1 })
          expect(got.read.ok.counts).toEqual(added.counts)
          expect(got.rows[0].sr).toEqual({
            M: Object.fromEntries(
              Object.entries(added.counts).map(([key, n]) => [key, { N: String(n) }]),
            ),
          })
          expect(Object.keys(got.rows[0]).filter((name) => name.startsWith("counts#"))).toEqual([])
          const update = got.sent[1].transactWriteItems.TransactItems[0].Update
          expect(update.UpdateExpression).toMatch(/ADD #\w+\.#\w+ :\w+$/)
          expect(update.ConditionExpression).toContain("attribute_exists(#fm0)")
          expect(update.ExpressionAttributeNames["#fm0"]).toBe("sr")
        }),
    )
  }
  captures.everyCaseCompared()
}
