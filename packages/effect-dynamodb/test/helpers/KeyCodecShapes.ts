/**
 * Entities whose key composites are a codec `encode` takes on its own output (`"Mi X"` stored
 * `"x:Mi X"`), and the rows published 1.39.0 wrote for them under `escapeKeys` off and on
 * (`fixtures/key-codec-1.39.0.json`, written by `put`, `delete`, `update`, `append` and `reembed` on
 * DynamoDB Local). Every codec value holds a space, which `escapeKeys: true` escapes.
 *
 * 1.39.0 keyed such a composite by its stored text encoded once more (`docid_x:x:mi x`): its
 * input's encode, then the composite key form's. A key now holds the stored text once
 * (`docid_x:mi x`), so 1.39.0's rows are found by key only once `rekey` has moved them: their live
 * keys, index keys, Z-order prefix segments, snapshot and tombstone item segments, vector
 * partitions, a time series' event keys (with `escapeKeys` on) and the unique sentinels' pointers to
 * them. `KeyCodecPaths.test.ts` (a recording table) and `connected.key-codec-paths.test.ts`
 * (DynamoDB Local) run `rekey` over them, then the reads.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema, SchemaGetter } from "effect"
import * as Collection from "../../src/Collection.js"
import * as Entity from "../../src/Entity.js"
import * as Query from "../../src/Query.js"
import * as Table from "../../src/Table.js"

/** A codec whose `encode` takes its own output: `"Mi X"` is stored `"x:Mi X"`. */
export const Prefixed = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => s.slice(2)),
    encode: SchemaGetter.transform((s: string) => `x:${s}`),
  }),
)

export type Setting = "off" | "on"

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Prefixed,
  part: Prefixed,
  code: Prefixed,
  n: Schema.Number,
}) {}
class Note extends Schema.Class<Note>("Note")({
  noteId: Schema.String,
  code: Prefixed,
  part: Prefixed,
}) {}
class Card extends Schema.Class<Card>("Card")({
  cardId: Prefixed,
  part: Prefixed,
  n: Schema.Number,
}) {}
class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Prefixed,
  at: Prefixed,
  n: Schema.Number,
}) {}
class Zone extends Schema.Class<Zone>("Zone")({
  zoneId: Schema.String,
  region: Prefixed,
  agency: Prefixed,
  price: Schema.Number,
}) {}
class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  tenantId: Prefixed,
  name: Schema.String,
}) {}
/** An index whose second sort key composite is the codec, for `.within()`'s row checks. */
class Tag extends Schema.Class<Tag>("Tag")({
  tagId: Schema.String,
  owner: Schema.String,
  kind: Prefixed,
  part: Prefixed,
}) {}
/** A unique constraint on the codec: its sentinel holds the stored text, and names the item. */
class Member extends Schema.Class<Member>("Member")({
  memberId: Prefixed,
  email: Prefixed,
  n: Schema.Number,
}) {}

/** The entities, on a table whose schema has `escapeKeys` as `setting` says. */
export const world = (setting: Setting) => {
  const schema = DynamoSchema.make({ name: "kc", version: 1, escapeKeys: setting === "on" })
  const Docs = Entity.make({
    model: Doc,
    entityType: "Doc",
    primaryKey: {
      pk: { field: "pk", composite: ["docId"] },
      sk: { field: "sk", composite: ["part"] },
    },
    indexes: {
      byCode: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["code"] },
        sk: { field: "gsi1sk", composite: ["part"] },
        collection: "coded",
      },
    },
  })
  const Notes = Entity.make({
    model: Note,
    entityType: "Note",
    primaryKey: {
      pk: { field: "pk", composite: ["noteId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byCode: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["code"] },
        sk: { field: "gsi1sk", composite: ["part"] },
        collection: "coded",
      },
    },
  })
  const Cards = Entity.make({
    model: Card,
    entityType: "Card",
    primaryKey: {
      pk: { field: "pk", composite: ["cardId"] },
      sk: { field: "sk", composite: ["part"] },
    },
    softDelete: true,
  })
  const Revs = Entity.make({
    model: Card,
    entityType: "Rev",
    primaryKey: {
      pk: { field: "pk", composite: ["cardId"] },
      sk: { field: "sk", composite: ["part"] },
    },
    versioned: { retain: true },
  })
  const Readings = Entity.make({
    model: Reading,
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["sensorId"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({ sensorId: Prefixed, at: Prefixed, n: Schema.Number }),
    },
  })
  const Zones = Entity.make({
    model: Zone,
    entityType: "Zone",
    primaryKey: {
      pk: { field: "pk", composite: ["zoneId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byFacets: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["region"] },
        sk: {
          field: "gsi2sk",
          prefix: ["agency"],
          zorder: [{ field: "price", min: 0, max: 1000 }],
        },
      },
    },
  })
  const Products = Entity.make({
    model: Product,
    entityType: "Product",
    primaryKey: {
      pk: { field: "pk", composite: ["productId"] },
      sk: { field: "sk", composite: [] },
    },
    vectorIndexes: {
      byName: {
        name: "vec1",
        dimensions: 8,
        distance: "cosine",
        source: { fields: ["name"] },
        partition: ["tenantId"],
      },
    },
  })
  const Tags = Entity.make({
    model: Tag,
    entityType: "Tag",
    primaryKey: {
      pk: { field: "pk", composite: ["tagId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byOwner: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["owner"] },
        sk: { field: "gsi1sk", composite: ["kind", "part"] },
      },
    },
  })
  const Members = Entity.make({
    model: Member,
    entityType: "Member",
    primaryKey: {
      pk: { field: "pk", composite: ["memberId"] },
      sk: { field: "sk", composite: [] },
    },
    unique: { email: ["email"] },
  })
  const entities = { Docs, Notes, Cards, Revs, Readings, Zones, Products, Tags, Members }
  return { schema, entities, Base: Table.make({ schema, entities }) }
}
export type World = ReturnType<typeof world>

export type Row = Record<string, AttributeValue>

/** A stored `B` is bytes, which JSON has no form for. */
const bytesIn = (_: string, v: any) =>
  v && typeof v.__bytes === "string" ? new Uint8Array(Buffer.from(v.__bytes, "base64")) : v

type Written = {
  /** Every row the table held after 1.39.0's writes. */
  readonly rows: ReadonlyArray<Row>
  /** What each read of those rows returned on 1.39.0. */
  readonly reads: Record<string, unknown>
  /** The rows after 1.39.0's `reembed()`, which moved the product's partition to the text a read composed. */
  readonly rowsAfterReembed: ReadonlyArray<Row>
}

export const fixture: {
  readonly writtenBy: Record<string, string>
  readonly off: Written
  readonly on: Written
} = JSON.parse(
  readFileSync(new URL("../fixtures/key-codec-1.39.0.json", import.meta.url), "utf8"),
  bytesIn,
)

/** The secondary indexes a recording table serves for {@link world}'s entities. */
export const indexes = {
  gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
  gsi2: { pk: "gsi2pk", sk: "gsi2sk" },
} as const

/** The writes 1.39.0 made for the fixture, made now. */
export const writeAll = (db: any): Effect.Effect<void, unknown, any> =>
  Effect.gen(function* () {
    const e = db.entities
    yield* e.Docs.put({ docId: "Mi X", part: "P 1", code: "C 1", n: 1 }).asEffect()
    yield* e.Docs.put({ docId: "Mi X", part: "P 2", code: "C 1", n: 2 }).asEffect()
    yield* e.Notes.put({ noteId: "n1", code: "C 1", part: "P 9" }).asEffect()
    yield* e.Cards.put({ cardId: "Mi X", part: "P 1", n: 1 }).asEffect()
    yield* e.Cards.put({ cardId: "Mi X", part: "P 2", n: 2 }).asEffect()
    yield* e.Cards.delete({ cardId: "Mi X", part: "P 2" }).asEffect()
    yield* e.Revs.put({ cardId: "Mi X", part: "P 1", n: 1 }).asEffect()
    yield* e.Revs.update({ cardId: "Mi X", part: "P 1" }).set({ n: 2 }).asEffect()
    yield* e.Readings.append({ sensorId: "Mi X", at: "T 1", n: 1 }).asEffect()
    yield* e.Readings.append({ sensorId: "Mi X", at: "T 2", n: 2 }).asEffect()
    yield* e.Zones.put({ zoneId: "z1", region: "No rth", agency: "Ag A", price: 500 }).asEffect()
    yield* e.Tags.put({ tagId: "t1", owner: "o1", kind: "K 1", part: "P 1" }).asEffect()
    yield* e.Tags.put({ tagId: "t2", owner: "o1", kind: "K 2", part: "P 2" }).asEffect()
    yield* e.Products.put({ productId: "p1", tenantId: "Ac me", name: "lamp" }).asEffect()
    yield* e.Members.put({ memberId: "Mi X", email: "a b@x", n: 1 }).asEffect()
  })

/** What `rekey` moves of the fixture's rows, by kind: every row whose key held a codec value. */
export const MOVED = {
  // Two documents, a card, a retained card, a time series' current item, a member.
  item: 6,
  // The retained card's version snapshot, and the soft-deleted card's tombstone.
  snapshot: 1,
  tombstone: 1,
  outbox: 0,
  // Both events of the time series.
  event: 2,
  aggregate: 0,
  stream: 0,
}

/** Rows whose table key holds no codec value, but whose index keys or partition do. */
export const REWRITTEN = 5 // the note, two tags, the zone, the product

/** An ISO timestamp, anywhere in a value. */
const ISO = /\d{4}-\d\d-\d\dT[\d:.]+Z/g

/**
 * `rows`, each with every ISO timestamp replaced, and sorted: two runs at other times compare.
 * A `B` value compares as hex.
 */
export const comparable = (rows: Iterable<Row>) =>
  [...rows]
    .map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .map(([attr, value]): [string, unknown] => [
            attr,
            value.B !== undefined
              ? { B: Buffer.from(value.B).toString("hex") }
              : attr === "__edd_i__"
                ? { S: "<incarnation>" }
                : value.S !== undefined
                  ? { S: value.S.replace(ISO, "<ts>") }
                  : value,
          ])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .sort((a: any, b: any) => `${a.pk?.S}|${a.sk?.S}`.localeCompare(`${b.pk?.S}|${b.sk?.S}`))

const count = <A, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  Effect.map(effect, (items) => items.length)

/**
 * Each read of the rows, and what it returns once `rekey` has moved them. 1.39.0 returned none of
 * the reads that compose a key from a caller's values (`fixture.<setting>.reads`), except where
 * `on139` says: the entity's own `get`, and a `.within()` read whose bound is checked on each row of
 * a range its key condition doesn't narrow.
 */
export const reads: ReadonlyArray<{
  readonly label: string
  readonly run: (db: any, w: World) => Effect.Effect<unknown, unknown, any>
  readonly expected: unknown
  readonly on139?: unknown
}> = [
  {
    label: "Docs.get",
    run: (db) =>
      Effect.map(db.entities.Docs.get({ docId: "Mi X", part: "P 1" }), (doc: any) => doc.n),
    expected: 1,
    on139: 1,
  },
  {
    label: "Members.get",
    run: (db) => Effect.map(db.entities.Members.get({ memberId: "Mi X" }), (m: any) => m.n),
    expected: 1,
    on139: 1,
  },
  {
    label: "Docs.byCode({ code })",
    run: (db) => count(db.entities.Docs.byCode({ code: "C 1" }).collect()),
    expected: 2,
  },
  {
    label: "Docs.byCode({ code, part })",
    run: (db) => count(db.entities.Docs.byCode({ code: "C 1", part: "P 1" }).collect()),
    expected: 1,
  },
  {
    label: "Docs.byCode({ code }).where(eq part)",
    run: (db) =>
      count(
        db.entities.Docs.byCode({ code: "C 1" })
          .where((t: any, { eq }: any) => eq(t.part, "P 1"))
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Docs.byCode({ code }).where(beginsWith part)",
    run: (db) =>
      count(
        db.entities.Docs.byCode({ code: "C 1" })
          .where((t: any, { beginsWith }: any) => beginsWith(t.part, "P"))
          .collect(),
      ),
    expected: 2,
  },
  {
    label: "Docs.byCode({ code }).within(part eq)",
    run: (db) =>
      count(
        db.entities.Docs.byCode({ code: "C 1" })
          .within({ part: { eq: "P 1" } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Docs.byCode({ code }).within(part between)",
    run: (db) =>
      count(
        db.entities.Docs.byCode({ code: "C 1" })
          .within({ part: { between: ["P 2", "P 3"] } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Docs.query.byCode({ code })",
    run: (_db, w) => count(Query.collect(w.entities.Docs.query.byCode!({ code: "C 1" }))),
    expected: 2,
  },
  {
    label: "collections.coded({ code })",
    run: (db) =>
      Effect.map(db.collections.coded({ code: "C 1" }).collect(), (grouped: any) => ({
        Docs: grouped.Docs.length,
        Notes: grouped.Notes.length,
      })),
    expected: { Docs: 2, Notes: 1 },
  },
  {
    label: "Collection.make(coded).Docs({ code })",
    run: (_db, w) =>
      count(
        Query.collect(
          Collection.make("coded", { Docs: w.entities.Docs, Notes: w.entities.Notes }).Docs({
            code: "C 1",
          }) as any,
        ),
      ),
    expected: 2,
  },
  {
    label: "Cards.deleted.list",
    run: (db) => count(db.entities.Cards.deleted.list({ cardId: "Mi X", part: "P 1" }).collect()),
    expected: 1,
  },
  {
    label: "Revs.versions",
    run: (db) => count(db.entities.Revs.versions({ cardId: "Mi X", part: "P 1" }).collect()),
    expected: 1,
  },
  {
    label: "Readings.history",
    run: (db) => count(db.entities.Readings.history({ sensorId: "Mi X" }).collect()),
    expected: 2,
  },
  {
    label: "Readings.history.where(eq at)",
    run: (db) =>
      count(
        db.entities.Readings.history({ sensorId: "Mi X" })
          .where((t: any, { eq }: any) => eq(t.at, "T 1"))
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Zones.byFacets.within(agency, price)",
    run: (db) =>
      count(
        db.entities.Zones.byFacets({ region: "No rth" })
          .within({ agency: "Ag A", price: { between: [0, 1000] } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Tags.byOwner.within(part eq), skip-scan",
    run: (db) =>
      count(
        db.entities.Tags.byOwner({ owner: "o1" })
          .within({ part: { eq: "P 1" } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Tags.byOwner.within(part eq), filter",
    run: (db) =>
      count(
        db.entities.Tags.byOwner({ owner: "o1" })
          .within({ part: { eq: "P 1" } }, { maxSkips: 0 })
          .collect(),
      ),
    expected: 1,
    on139: 1,
  },
  {
    label: "Tags.byOwner.within(kind eq, part gte)",
    run: (db) =>
      count(
        db.entities.Tags.byOwner({ owner: "o1" })
          .within({ kind: { eq: "K 2" }, part: { gte: "P 1" } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Products.byName.partition({ tenantId })",
    run: (db) =>
      count(db.entities.Products.byName("lamp").partition({ tenantId: "Ac me" }).collect()),
    expected: 1,
  },
]
