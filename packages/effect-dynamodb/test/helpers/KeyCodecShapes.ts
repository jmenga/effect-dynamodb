/**
 * Entities whose key composites are a codec `encode` takes on its own output (`"MiX"` stored
 * `"x:MiX"`), and the rows published 1.39.0 wrote for them (`fixtures/key-codec-1.39.0.json`,
 * written by `put`, `delete`, `update`, `append` and `reembed` on DynamoDB Local).
 *
 * `put` encodes such a composite twice in a key (`docid_x:x:mix`): its input's encode, then the
 * composite key form's. The reads below compose a key from values a caller gives. Up to 1.39.0 they
 * encoded them once and found none of these rows (the fixture's `reads`), and `reembed` rewrote a
 * vector partition to the once-encoded text, out of the partition `put` wrote. Each read now composes
 * the key `put` wrote; `KeyCodecPaths.test.ts` (requests, on a recording table) and
 * `connected.key-codec-paths.test.ts` (DynamoDB Local) run them over the seeded rows.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema, SchemaGetter } from "effect"
import * as Collection from "../../src/Collection.js"
import * as Entity from "../../src/Entity.js"
import * as Query from "../../src/Query.js"
import * as Table from "../../src/Table.js"

/** A codec whose `encode` takes its own output: `"MiX"` is stored `"x:MiX"`. */
export const Prefixed = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((s: string) => s.slice(2)),
    encode: SchemaGetter.transform((s: string) => `x:${s}`),
  }),
)

/** 1.39.0's default (`escapeKeys` off): the rows these tests seed were written under it. */
export const schema = DynamoSchema.make({ name: "kc", version: 1, escapeKeys: false })

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Prefixed,
  part: Prefixed,
  code: Prefixed,
  n: Schema.Number,
}) {}
export const Docs = Entity.make({
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

class Note extends Schema.Class<Note>("Note")({
  noteId: Schema.String,
  code: Prefixed,
  part: Prefixed,
}) {}
export const Notes = Entity.make({
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

class Card extends Schema.Class<Card>("Card")({
  cardId: Prefixed,
  part: Prefixed,
  n: Schema.Number,
}) {}
export const Cards = Entity.make({
  model: Card,
  entityType: "Card",
  primaryKey: {
    pk: { field: "pk", composite: ["cardId"] },
    sk: { field: "sk", composite: ["part"] },
  },
  softDelete: true,
})
export const Revs = Entity.make({
  model: Card,
  entityType: "Rev",
  primaryKey: {
    pk: { field: "pk", composite: ["cardId"] },
    sk: { field: "sk", composite: ["part"] },
  },
  versioned: { retain: true },
})

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Prefixed,
  at: Prefixed,
  n: Schema.Number,
}) {}
export const Readings = Entity.make({
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

class Zone extends Schema.Class<Zone>("Zone")({
  zoneId: Schema.String,
  region: Prefixed,
  agency: Prefixed,
  price: Schema.Number,
}) {}
export const Zones = Entity.make({
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
      sk: { field: "gsi2sk", prefix: ["agency"], zorder: [{ field: "price", min: 0, max: 1000 }] },
    },
  },
})

class Product extends Schema.Class<Product>("Product")({
  productId: Schema.String,
  tenantId: Prefixed,
  name: Schema.String,
}) {}
export const Products = Entity.make({
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

/** An index whose second sort key composite is the codec, for `.within()`'s row checks. */
class Tag extends Schema.Class<Tag>("Tag")({
  tagId: Schema.String,
  owner: Schema.String,
  kind: Prefixed,
  part: Prefixed,
}) {}
export const Tags = Entity.make({
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

export const entities = { Docs, Notes, Cards, Revs, Readings, Zones, Products, Tags }
export const Base = Table.make({ schema, entities })

export type Row = Record<string, AttributeValue>

/** A stored `B` is bytes, which JSON has no form for. */
const bytesIn = (_: string, v: any) =>
  v && typeof v.__bytes === "string" ? new Uint8Array(Buffer.from(v.__bytes, "base64")) : v

export const fixture: {
  readonly writtenBy: Record<string, string>
  /** Every row the table held after 1.39.0's writes. */
  readonly rows: ReadonlyArray<Row>
  /** What each read of those rows returned on 1.39.0. */
  readonly reads: Record<string, unknown>
  /** The rows after 1.39.0's `reembed()`, which moved the product out of its partition. */
  readonly rowsAfterReembed: ReadonlyArray<Row>
} = JSON.parse(
  readFileSync(new URL("../fixtures/key-codec-1.39.0.json", import.meta.url), "utf8"),
  bytesIn,
)

/** The row `put` wrote for `entityType` whose sort key starts so. */
export const seededRow = (entityType: string, skPrefix = ""): Row => {
  const row = fixture.rows.find(
    (r) => r.__edd_e__?.S === entityType && (r.sk?.S ?? "").startsWith(skPrefix),
  )
  if (row === undefined) throw new Error(`no seeded ${entityType} row under ${skPrefix}`)
  return row
}

/** `rows` with each ISO timestamp in a key replaced, so two runs' keys compare. */
export const keysOf = (rows: ReadonlyArray<Row>) =>
  rows
    .map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([attr]) => /^(pk|sk|gsi\dpk|gsi\dsk|__edd_vp_\w+__|__edd_e__)$/.test(attr))
          .map(([attr, value]) => [
            attr,
            value.B !== undefined
              ? Buffer.from(value.B).toString("hex")
              : (value.S ?? "").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<ts>"),
          ]),
      ),
    )
    .sort((a, b) => `${a.pk}|${a.sk}`.localeCompare(`${b.pk}|${b.sk}`))

const count = <A, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  Effect.map(effect, (items) => items.length)

/**
 * Each read that composes a key from values a caller gives, and what it now returns over the
 * seeded rows. 1.39.0 returned none of them (`fixture.reads`), except where `on139` says: a
 * `.within()` read whose bound is checked on each row of a range its key condition doesn't narrow.
 */
export const reads: ReadonlyArray<{
  readonly label: string
  readonly run: (db: any) => Effect.Effect<unknown, unknown, any>
  readonly expected: unknown
  readonly on139?: unknown
}> = [
  {
    label: "Docs.byCode({ code })",
    run: (db) => count(db.entities.Docs.byCode({ code: "C1" }).collect()),
    expected: 2,
  },
  {
    label: "Docs.byCode({ code, part })",
    run: (db) => count(db.entities.Docs.byCode({ code: "C1", part: "P1" }).collect()),
    expected: 1,
  },
  {
    label: "Docs.byCode({ code }).where(eq part)",
    run: (db) =>
      count(
        db.entities.Docs.byCode({ code: "C1" })
          .where((t: any, { eq }: any) => eq(t.part, "P1"))
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Docs.byCode({ code }).where(beginsWith part)",
    run: (db) =>
      count(
        db.entities.Docs.byCode({ code: "C1" })
          .where((t: any, { beginsWith }: any) => beginsWith(t.part, "P"))
          .collect(),
      ),
    expected: 2,
  },
  {
    label: "Docs.byCode({ code }).within(part eq)",
    run: (db) =>
      count(
        db.entities.Docs.byCode({ code: "C1" })
          .within({ part: { eq: "P1" } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Docs.byCode({ code }).within(part between)",
    run: (db) =>
      count(
        db.entities.Docs.byCode({ code: "C1" })
          .within({ part: { between: ["P2", "P3"] } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Docs.query.byCode({ code })",
    run: () => count(Query.collect(Docs.query.byCode!({ code: "C1" }))),
    expected: 2,
  },
  {
    label: "collections.coded({ code })",
    run: (db) =>
      Effect.map(db.collections.coded({ code: "C1" }).collect(), (grouped: any) => ({
        Docs: grouped.Docs.length,
        Notes: grouped.Notes.length,
      })),
    expected: { Docs: 2, Notes: 1 },
  },
  {
    label: "Collection.make(coded).Docs({ code })",
    run: () =>
      count(Query.collect(Collection.make("coded", { Docs, Notes }).Docs({ code: "C1" }) as any)),
    expected: 2,
  },
  {
    label: "Cards.deleted.list",
    run: (db) => count(db.entities.Cards.deleted.list({ cardId: "MiX", part: "P1" }).collect()),
    expected: 1,
  },
  {
    label: "Revs.versions",
    run: (db) => count(db.entities.Revs.versions({ cardId: "MiX", part: "P1" }).collect()),
    expected: 1,
  },
  {
    label: "Readings.history",
    run: (db) => count(db.entities.Readings.history({ sensorId: "MiX" }).collect()),
    expected: 2,
  },
  {
    label: "Readings.history.where(eq at)",
    run: (db) =>
      count(
        db.entities.Readings.history({ sensorId: "MiX" })
          .where((t: any, { eq }: any) => eq(t.at, "T1"))
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Zones.byFacets.within(agency, price)",
    run: (db) =>
      count(
        db.entities.Zones.byFacets({ region: "North" })
          .within({ agency: "AgA", price: { between: [0, 1000] } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Tags.byOwner.within(part eq), skip-scan",
    run: (db) =>
      count(
        db.entities.Tags.byOwner({ owner: "o1" })
          .within({ part: { eq: "P1" } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Tags.byOwner.within(part eq), filter",
    run: (db) =>
      count(
        db.entities.Tags.byOwner({ owner: "o1" })
          .within({ part: { eq: "P1" } }, { maxSkips: 0 })
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
          .within({ kind: { eq: "K2" }, part: { gte: "P1" } })
          .collect(),
      ),
    expected: 1,
  },
  {
    label: "Products.byName.partition({ tenantId })",
    run: (db) =>
      count(db.entities.Products.byName("lamp").partition({ tenantId: "Acme" }).collect()),
    expected: 1,
  },
]
