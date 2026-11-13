/**
 * The writes that read a versioned item first and then copy what they read, on entities without a
 * vector index: a soft delete (with a condition and without), a retain update too wide for one
 * expression and one writing only what changed, a retain delete, an index composite's update too
 * wide for one expression, and a unique value's update. With vector indexes these hold the vector
 * attributes as read where they copy them (#240, `VectorWriteRaces.ts`); without, each must send
 * what the published 1.40.0 sent, byte for byte (`fixtures/versioned-copy-requests-1.40.0.json`).
 *
 * No runtime import: the modules come in as arguments, so the generator that wrote the fixture ran
 * this file against the published 1.40.0 and the tests run it against `src/`.
 */

export interface CopiesModules {
  readonly Effect: any
  readonly Schema: any
  readonly DynamoSchema: any
  readonly Entity: any
  readonly Table: any
  readonly DynamoClient: any
}

/** Fields enough to make an update that sets them all too wide for one expression. */
const WIDE_FIELDS = Array.from({ length: 350 }, (_, i) => `f${i}`)

export const copiesWorld = (m: CopiesModules) => {
  const { Schema } = m
  const schema = m.DynamoSchema.make({ name: "copies", version: 1 })
  const model = Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    handle: Schema.optionalKey(Schema.String),
    count: Schema.optionalKey(Schema.Number),
    ...Object.fromEntries(WIDE_FIELDS.map((field) => [field, Schema.optionalKey(Schema.String)])),
  })
  const of = (entityType: string, config: Record<string, unknown>) =>
    m.Entity.make({
      model,
      entityType,
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
      ...config,
    })
  const Softs = of("Soft", { versioned: true, softDelete: true })
  const Kepts = of("Kept", { versioned: { retain: true }, unique: { handle: ["handle"] } })
  const Counts = of("Count", {
    versioned: true,
    indexes: {
      byCount: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["id"] },
        sk: { field: "gsi1sk", composite: ["count"] },
      },
    },
  })
  const Uniques = of("Unique", { versioned: true, unique: { handle: ["handle"] } })
  const entities = { Softs, Kepts, Counts, Uniques }
  const MainTable = m.Table.make({ schema, entities })
  return { MainTable, client: m.DynamoClient.make({ entities, tables: { MainTable } }) }
}

/** Each write, on an item of its own. */
export const copyWrites = (m: CopiesModules, world: ReturnType<typeof copiesWorld>) =>
  m.Effect.gen(function* () {
    const db: any = yield* world.client
    const wide = Object.fromEntries(WIDE_FIELDS.map((field) => [field, "w"]))
    yield* db.entities.Softs.put({ id: "s1", text: "a", handle: "h" }).asEffect()
    yield* db.entities.Softs.delete({ id: "s1" }).asEffect()
    yield* db.entities.Softs.put({ id: "s2", text: "a", handle: "h" }).asEffect()
    yield* db.entities.Softs.delete({ id: "s2" }).condition({ handle: "h" }).asEffect()
    yield* db.entities.Kepts.put({ id: "k", text: "a", handle: "h" }).asEffect()
    yield* db.entities.Kepts.update({ id: "k" }).set(wide).asEffect()
    yield* db.entities.Kepts.update({ id: "k" }).set({ handle: "k2" }).asEffect()
    yield* db.entities.Kepts.delete({ id: "k" }).asEffect()
    yield* db.entities.Counts.put({ id: "c", text: "a", count: 1 }).asEffect()
    yield* db.entities.Counts.update({ id: "c" }).set(wide).add({ count: 1 }).asEffect()
    yield* db.entities.Uniques.put({ id: "u", text: "a", handle: "h" }).asEffect()
    yield* db.entities.Uniques.update({ id: "u" }).set({ handle: "u2" }).asEffect()
  })

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const INSTANT = /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z/gi

/**
 * Requests with what differs between runs in their place: each incarnation token is named by the
 * order it first appears in, and every instant (a tombstone's `deletedAt` and sort key, in either
 * casing) is `<instant>`, since two deletes can share one.
 */
export const normalized = (requests: ReadonlyArray<string>): ReadonlyArray<string> => {
  const tokens = new Map<string, string>()
  const token = (value: string) => {
    const key = value.toLowerCase()
    if (!tokens.has(key)) tokens.set(key, `<token${tokens.size}>`)
    return tokens.get(key)!
  }
  return requests.map((request) =>
    request.replace(UUID, (value) => token(value)).replace(INSTANT, "<instant>"),
  )
}
