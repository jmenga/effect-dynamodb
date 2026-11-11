/**
 * A select naming a sparse map beside other paths (#238 section 1, review B2 / B4). Such a select
 * reads whole rows, and each row must come back as a projection of the other paths would return
 * it: every other path kept however it was spelled (the domain name, the stored name, an entry's
 * attribute, a key attribute), and nothing the select doesn't name unpacked, decompressed or
 * checked. The first version of section 1 took the other paths by domain name only, so a stored
 * name came back absent, and handed the whole row to the packed-storage hook, so an unselected
 * field it couldn't read failed the select.
 *
 * `fixtures/select-beside-sparse-maps-1.40.0.json` holds what the published 1.40.0 did, every
 * request whole. The head sends the same requests, less the projection (`ProjectionExpression` and
 * the names only it used) where the select names the map, and returns the
 * same items, each with the map as a read rebuilds it; on a collection, as 1.40.0 did, other paths
 * are taken by domain name only, and a stored name reads as absent. One exception: two selected paths that
 * overlap (`tags[0]` twice). DynamoDB refuses that projection, and does for the head too where no
 * map is selected; where one is, nothing is projected, and the position comes back once.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Schema } from "effect"
import { expect } from "vitest"
import * as Zlib from "../../src/compression/zlib.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Lib from "../../src/index.js"
import { type OpenTable, onTable, recordingRequests } from "./Kept139.js"
import { wholeOf } from "./RenamedSparseMapWrites.js"
import { differingPaths } from "./WholeDiff.js"

interface Captured {
  readonly outcome: { readonly ok?: ReadonlyArray<Record<string, unknown>> }
  readonly sent: ReadonlyArray<Record<string, Record<string, unknown>>>
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/select-beside-sparse-maps-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: Record<string, Captured> }

const key = (composite: string) =>
  ({
    pk: { field: "pk", composite: [composite] },
    sk: { field: "sk", composite: [] },
  }) as const

const Docs = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      note: Schema.String,
      f: Schema.Record(Schema.String, Schema.Number),
      chosen: Schema.Struct({ x: Schema.Number }),
      other: Schema.Struct({ text: Schema.String }),
      tags: Schema.Array(Schema.String),
    }),
    {
      note: { field: "nt" },
      f: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "m" }) },
      chosen: { storedAs: Lib.DynamoModel.Packed({ format: "json" }) },
      other: {
        storedAs: Lib.DynamoModel.Packed({
          format: "json",
          compression: { codec: "gzip", threshold: 0 },
        }),
      },
    },
  ),
  entityType: "Doc",
  primaryKey: key("id"),
} as never) as any

class Target extends Schema.Class<Target>("Target")({
  targetId: Schema.String.pipe(Lib.DynamoModel.identifier),
  label: Schema.String,
}) {}
const Targets = Lib.Entity.make({
  model: Target,
  entityType: "Target",
  primaryKey: key("targetId"),
} as never) as any

/** History rows beside the live one, a hidden field and a ref. */
const Kept = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      note: Schema.String,
      f: Schema.Record(Schema.String, Schema.Number),
      secret: Lib.DynamoModel.Hidden(Schema.String),
      target: Target.pipe(Lib.DynamoModel.ref),
    }),
    { note: { field: "nt" }, f: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "m" }) } },
  ),
  entityType: "Kept",
  primaryKey: key("id"),
  versioned: { retain: true },
  refs: { target: { entity: Targets } },
} as never) as any

const MainTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "sb", version: 1 }),
  entities: { Docs, Targets, Kept },
} as never) as any

const byCat = {
  name: "gsi1",
  pk: { field: "gsi1pk", composite: ["cat"] },
  sk: { field: "gsi1sk", composite: ["id"] },
  collection: "cats",
}
const Mapped = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      cat: Schema.String,
      note: Schema.String,
      f: Schema.Record(Schema.String, Schema.Number),
    }),
    { note: { field: "nt" }, f: { storedAs: Lib.DynamoModel.SparseMap({ prefix: "m" }) } },
  ),
  entityType: "Doc",
  primaryKey: key("id"),
  indexes: { byCat },
} as never) as any
const Notes = Lib.Entity.make({
  model: Lib.DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      cat: Schema.String,
      note: Schema.String,
      label: Schema.String,
    }),
    { label: { field: "lb" } },
  ),
  entityType: "Note",
  primaryKey: key("id"),
  indexes: { byCat },
} as never) as any
const CollectionTable = Lib.Table.make({
  schema: Lib.DynamoSchema.make({ name: "sel", version: 1 }),
  entities: { Docs: Mapped, Notes },
} as never) as any

const DOC_KEY = { pk: { S: "$sb#v1#doc#id_a" }, sk: { S: "$sb#v1#doc" } }

type Select = (query: any) => any

const docSelects: Record<string, Select> = {
  "select(['nt'])": (q) => q.select(["nt"]),
  "select(['f', 'nt'])": (q) => q.select(["f", "nt"]),
  "select(['m#k'])": (q) => q.select(["m#k"]),
  "select(['f', 'm#k'])": (q) => q.select(["f", "m#k"]),
  "select(['f', 'note'])": (q) => q.select(["f", "note"]),
  "select(['f', 'pk', '__edd_e__'])": (q) => q.select(["f", "pk", "__edd_e__"]),
  "select(['chosen'])": (q) => q.select(["chosen"]),
  "select(['f', 'chosen'])": (q) => q.select(["f", "chosen"]),
  "select(['f', 'other'])": (q) => q.select(["f", "other"]),
  "select((t) => [t.tags.at(2), t.tags.at(0)])": (q) =>
    q.select((t: any) => [t.tags.at(2), t.tags.at(0)]),
  "select((t) => [t.f, t.tags.at(2), t.tags.at(0)])": (q) =>
    q.select((t: any) => [t.f, t.tags.at(2), t.tags.at(0)]),
  "select((t) => [t.tags.at(0), t.tags.at(0)])": (q) =>
    q.select((t: any) => [t.tags.at(0), t.tags.at(0)]),
  "select((t) => [t.f, t.tags.at(0), t.tags.at(0)])": (q) =>
    q.select((t: any) => [t.f, t.tags.at(0), t.tags.at(0)]),
}

/**
 * What the unselected `other` holds when it's read: as written (compressed past what the reader
 * takes), not JSON, or compressed by a codec the reader hasn't registered.
 */
const others: Record<string, unknown> = {
  "past the reader's maxOutputLength": undefined,
  "not JSON": { S: "{not json" },
  "an unregistered codec": { B: Uint8Array.from([0x23, 1, 2, 3]) },
}

const keptSelects: Record<string, Select> = {
  "select(['f', 'note'])": (q) => q.select(["f", "note"]),
  "select(['note'])": (q) => q.select(["note"]),
  "select(['f', 'secret'])": (q) => q.select(["f", "secret"]),
  "select(['secret'])": (q) => q.select(["secret"]),
  "select(['f', 'target'])": (q) => q.select(["f", "target"]),
  "select(['target'])": (q) => q.select(["target"]),
  "select(['f', 'version'])": (q) => q.select(["f", "version"]),
  "select(['version'])": (q) => q.select(["version"]),
}

const collectionSelects: Record<string, Select> = {
  "select(['nt'])": (q) => q.select(["nt"]),
  "select(['f', 'nt'])": (q) => q.select(["f", "nt"]),
  "select(['note'])": (q) => q.select(["note"]),
  "select(['f', 'note'])": (q) => q.select(["f", "note"]),
  "select(['lb'])": (q) => q.select(["lb"]),
  "select(['f', 'lb'])": (q) => q.select(["f", "lb"]),
  "select(['m#k'])": (q) => q.select(["m#k"]),
  "select(['f', 'm#k'])": (q) => q.select(["f", "m#k"]),
  "select(['f', 'gsi1pk'])": (q) => q.select(["f", "gsi1pk"]),
}

type Scenario = (db: {
  readonly raw: any
  readonly table: string
}) => Effect.Effect<() => Effect.Effect<unknown, unknown>, any, any>

const scenarios: Record<
  string,
  readonly [select: string, run: Scenario, table?: typeof CollectionTable]
> = {}
for (const [otherName, stored] of Object.entries(others)) {
  for (const [name, select] of Object.entries(docSelects)) {
    if (otherName !== "past the reader's maxOutputLength" && !name.includes("chosen")) continue
    scenarios[`${name}, other ${otherName}`] = [
      name,
      ({ raw, table }) =>
        Effect.gen(function* () {
          const writer = yield* DynamoClient.make({
            entities: { Docs },
            tables: { MainTable },
            compressors: [Zlib.gzip()],
          } as never) as Effect.Effect<any>
          yield* writer.entities.Docs.put({
            id: "a",
            note: "n1",
            f: { k: 1, j: 2 },
            chosen: { x: 2 },
            other: { text: "a".repeat(500) },
            tags: ["t0", "t1", "t2"],
          }).asEffect()
          if (stored !== undefined) {
            yield* raw.updateItem({
              TableName: table,
              Key: DOC_KEY,
              UpdateExpression: "SET #o = :o",
              ExpressionAttributeNames: { "#o": "other" },
              ExpressionAttributeValues: { ":o": stored },
            })
          }
          const reader = yield* DynamoClient.make({
            entities: { Docs },
            tables: { MainTable },
            compressors: [Zlib.gzip({ maxOutputLength: 128 })],
          } as never) as Effect.Effect<any>
          return () => select(reader.entities.Docs.scan()).collect()
        }),
    ]
  }
}
for (const [name, select] of Object.entries(keptSelects)) {
  scenarios[`Kept: ${name}`] = [
    name,
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Targets, Kept },
          tables: { MainTable },
        } as never) as Effect.Effect<any>
        yield* db.entities.Targets.put({ targetId: "t1", label: "L" }).asEffect()
        yield* db.entities.Kept.put({
          id: "a",
          note: "n1",
          f: { k: 1, j: 2 },
          secret: "s",
          targetId: "t1",
        }).asEffect()
        yield* db.entities.Kept.update({ id: "a" })
          .set({ note: "n2", f: { k: 3 } })
          .asEffect()
        return () => select(db.entities.Kept.scan()).collect()
      }),
  ]
}

for (const [name, select] of Object.entries(collectionSelects)) {
  scenarios[`collection, ${name}`] = [
    name,
    () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Docs: Mapped, Notes },
          tables: { MainTable: CollectionTable },
        } as never) as Effect.Effect<any>
        yield* db.entities.Docs.put({ id: "a", cat: "c", note: "n", f: { k: 1, j: 2 } }).asEffect()
        yield* db.entities.Notes.put({ id: "b", cat: "c", note: "p", label: "q" }).asEffect()
        return () => select(db.collections.cats({ cat: "c" })).collect()
      }),
    CollectionTable,
  ]
}

/** 1.40.0's request, without its projection: what a select naming a sparse map sends now. */
const withoutProjection = (sent: Captured["sent"]): Captured["sent"] =>
  sent.map((request) =>
    Object.fromEntries(
      Object.entries(request).map(([operation, input]) => {
        const { ProjectionExpression, ExpressionAttributeNames, ...rest } = input as {
          readonly ProjectionExpression?: string
          readonly ExpressionAttributeNames: Record<string, string>
        }
        const projected = new Set(
          String(ProjectionExpression ?? "")
            .split(/[,.\s[\]]+/)
            .filter((part) => part.startsWith("#")),
        )
        return [
          operation,
          {
            ...rest,
            ExpressionAttributeNames: Object.fromEntries(
              Object.entries(ExpressionAttributeNames).filter(([name]) => !projected.has(name)),
            ),
          },
        ]
      }),
    ),
  )

/** Where each request names its projection: the expression and each name only it used. */
const projectionPaths = (sent: Captured["sent"]): ReadonlyArray<string> =>
  sent.flatMap((request, at) =>
    Object.entries(request).flatMap(([operation, input]) => {
      const kept = withoutProjection([{ [operation]: input }])[0]![operation]!
      const names = Object.keys(input.ExpressionAttributeNames as object).filter(
        (name) => !Object.hasOwn(kept.ExpressionAttributeNames as object, name),
      )
      return [
        `[${at}].${operation}.ProjectionExpression`,
        ...names.map((name) => `[${at}].${operation}.ExpressionAttributeNames.${name}`),
      ]
    }),
  )

/** Where each item gains the map: `ok[i].f`, or a collection's `ok.Docs[i].f`. */
const mapPaths = (outcome: Captured["outcome"]): ReadonlyArray<string> => {
  const items = outcome.ok as any
  if (items === undefined) return []
  return Array.isArray(items)
    ? items.map((_: unknown, at: number) => `ok[${at}].f`)
    : items.Docs.map((_: unknown, at: number) => `ok.Docs[${at}].f`)
}

/** The map each select of `f` adds: the row's entries, as a read rebuilds them. */
const mapOf = (name: string) => (name.startsWith("Kept: ") ? { k: 3, j: 2 } : { k: 1, j: 2 })

/** Whether the select names the sparse map whole. */
const namesMap = (select: string) => select.includes("'f'") || select.includes("t.f,")

/** What the head returns: 1.40.0's outcome, each item with the map, but for overlapping paths. */
const expected = (name: string, select: string): Captured => {
  const was = fixture.cases[name]!
  if (!namesMap(select)) return was
  const sent = withoutProjection(was.sent)
  // DynamoDB refused the overlapping projection; with nothing projected, the position comes once.
  if (select === "select((t) => [t.f, t.tags.at(0), t.tags.at(0)])") {
    return { outcome: { ok: [{ f: mapOf(name), tags: ["t0"] }] }, sent }
  }
  const items = was.outcome.ok as any
  if (items === undefined) return { outcome: was.outcome, sent }
  // A collection's Doc items gain the map; its Notes hold none.
  if (name.startsWith("collection, ")) {
    return {
      outcome: {
        ok: {
          ...items,
          Docs: items.Docs.map((item: object) => ({ f: mapOf(name), ...item })),
        } as never,
      },
      sent,
    }
  }
  return { outcome: { ok: items.map((item: object) => ({ f: mapOf(name), ...item })) }, sent }
}

const outcomeOf = (exit: Exit.Exit<unknown, unknown>): Captured["outcome"] => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value ?? null)) }
  const squashed = Cause.squash(exit.cause) as any
  return {
    [Cause.hasFails(exit.cause) ? "fail" : "die"]: String(squashed?._tag ?? squashed?.name),
    says: String(squashed?.message ?? "")
      .split("\n")[0]!
      .slice(0, 200),
  } as Captured["outcome"]
}

/**
 * Each select on a table of its own. `dynamodb`: whether the table is DynamoDB Local, which
 * applies a projection; on the recording table, which doesn't, results are compared only where
 * no projection is sent.
 */
export const selectBesideSparseMapsSuite = (
  open: OpenTable,
  options: { readonly dynamodb: boolean },
) => {
  for (const [name, [select, run, table = MainTable]] of Object.entries(scenarios)) {
    const want = expected(name, select)
    it.effect(
      namesMap(select)
        ? `${name}: 1.40.0's items with the map, with no projection sent`
        : `${name}: does what 1.40.0 did`,
      () =>
        Effect.gen(function* () {
          const log: Array<unknown> = []
          const got = yield* onTable(
            recordingRequests(open, log),
            0,
            table,
            { entities: {} },
            (_db, table) =>
              Effect.gen(function* () {
                const raw = yield* DynamoClient
                const query = yield* run({ raw, table: table.name })
                log.length = 0
                const exit = yield* Effect.exit(Effect.suspend(() => query()))
                return {
                  outcome: outcomeOf(exit),
                  sent: log.map((request) => wholeOf(request, table.name)) as Captured["sent"],
                }
              }),
          )
          expect(got.sent).toEqual(want.sent)
          if (options.dynamodb || namesMap(select)) expect(got.outcome).toEqual(want.outcome)
          // The fields the head changes, named: the projection, and each item's map.
          const was = fixture.cases[name]!
          const changed = differingPaths(was.sent, got.sent)
          expect(changed).toEqual(namesMap(select) ? projectionPaths(was.sent) : [])
          if (options.dynamodb || namesMap(select)) {
            expect(differingPaths(was.outcome, got.outcome)).toEqual(
              !namesMap(select)
                ? []
                : select === "select((t) => [t.f, t.tags.at(0), t.tags.at(0)])"
                  ? ["fail", "says", "ok"]
                  : mapPaths(was.outcome),
            )
          }
        }),
    )
  }
}
