/**
 * The fixture of published 1.39.0's rows under look-alike key composites
 * (`fixtures/lookalike-keys-1.39.0.json`), its definitions, and the generator's steps, for
 * `LookalikeKeys.test.ts` and its connected twin.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Option, Schema } from "effect"
import * as Cookies from "effect/http/Cookies"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import { lookalikes } from "./Lookalikes.js"

export type Row = Record<string, AttributeValue>
export type Stage = "put" | "softDeleted" | "restored" | "updated"

export interface Captured {
  readonly results: Record<string, unknown>
  readonly stages: Record<Stage, ReadonlyArray<Row>>
}

/** The fixture, its bytes (stored as `{ "B": [...] }`) as bytes again. */
export const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/lookalike-keys-1.39.0.json", import.meta.url), "utf8"),
  (_key, value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Array.isArray(value.B)
      ? new Uint8Array(value.B)
      : value,
).types as Record<string, Captured>

/** Each type the fixture holds, with a fresh value of the one its generator wrote. */
export const kinds = new Map<string, { readonly field: Schema.Top; readonly make: () => unknown }>([
  ...lookalikes.map((kind) => [kind.name, kind] as const),
  [
    "Cookie expires",
    {
      field: Schema.Cookie,
      make: () =>
        Cookies.makeCookieUnsafe("a", "b", { expires: new Date("2025-01-01T00:00:00.000Z") }),
    },
  ],
  [
    "Option none(DateTimeUtc)",
    { field: Schema.Option(Schema.DateTimeUtc), make: () => Option.none() },
  ],
])
export const kindOf = (name: string) => {
  const kind = kinds.get(name)
  if (kind === undefined) throw new Error(`no value for ${name}`)
  return kind
}

/** The fixture's definitions: they must stay what its generator declared. */
export const definitionsOf = (field: Schema.Top) => {
  const model = Schema.Struct({ id: Schema.String, f: field, note: Schema.optional(Schema.String) })
  const keyed = (sk: ReadonlyArray<string>) => ({
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: sk },
  })
  const Soft = Entity.make({
    model,
    entityType: "Soft",
    primaryKey: keyed(["f"]),
    softDelete: true,
  } as never) as any
  const Unique = Entity.make({
    model,
    entityType: "Unique",
    primaryKey: keyed([]),
    unique: { byF: ["f"] },
  } as never) as any
  const Indexed = Entity.make({
    model,
    entityType: "Indexed",
    primaryKey: keyed([]),
    indexes: {
      byF: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["f"] },
        sk: { field: "gsi1sk", composite: [] },
      },
    },
  } as never) as any
  const Retained = Entity.make({
    model,
    entityType: "Retained",
    primaryKey: keyed(["f"]),
    versioned: { retain: true },
  } as never) as any
  const schema = DynamoSchema.make({ name: "keys", version: 1, escapeKeys: false })
  const Base = Table.make({ schema, entities: { Soft, Unique, Indexed, Retained } } as never) as any
  const Roots = Aggregate.make(
    Schema.Struct({ id: Schema.String, f: field, note: Schema.String }),
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: ["id", "f"] },
      collection: { name: "roots" },
      root: { entityType: "Root" },
      edges: {},
    } as never,
  ) as any
  return { Soft, Unique, Indexed, Retained, Roots, Base, Main: { ...Base, aggregates: { Roots } } }
}

/** The rows as compared: the random incarnation token left out, each timestamp the same text. */
export const comparable = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  rows
    .map((row) => {
      const { __edd_i__: _token, ...rest } = row
      return JSON.parse(
        JSON.stringify(rest, (_key, value) =>
          value instanceof Uint8Array
            ? { bytes: [...value] }
            : typeof value === "string"
              ? value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<at>")
              : value,
        ),
      ) as Row
    })
    .sort((a, b) =>
      `${a.pk?.S}|${a.sk?.S}|${a.__edd_e__?.S}`.localeCompare(
        `${b.pk?.S}|${b.sk?.S}|${b.__edd_e__?.S}`,
      ),
    )

export const keysOf = (rows: ReadonlyArray<Row>) =>
  rows.map((row) => `${row.pk?.S}|${row.sk?.S}`).sort()

export const typed = (rows: ReadonlyArray<Row>, prefix: string) =>
  rows.filter((row) => row.__edd_e__?.S?.startsWith(prefix))

/** The generator's `put` stage. */
export const putAll = (db: any, make: () => unknown) =>
  Effect.gen(function* () {
    yield* db.entities.Soft.put({ id: "a", f: make() }).asEffect()
    yield* db.entities.Unique.put({ id: "b", f: make() }).asEffect()
    yield* db.entities.Indexed.put({ id: "c", f: make() }).asEffect()
    yield* db.entities.Retained.put({ id: "d", f: make() }).asEffect()
    yield* db.aggregates.Roots.create({ id: "e", f: make(), note: "one" })
  })

/** The generator's steps after `put`, each stage's rows when it is done. */
export const restoreAndUpdate = (db: any, rows: () => ReadonlyArray<Row>, make: () => unknown) =>
  Effect.gen(function* () {
    const stages: Partial<Record<Stage, ReadonlyArray<Row>>> = {}
    yield* db.entities.Soft.delete({ id: "a", f: make() }).asEffect()
    stages.softDeleted = rows()
    yield* db.entities.Soft.restore({ id: "a", f: make() })
    stages.restored = rows()
    yield* db.entities.Unique.delete({ id: "b" }).asEffect()
    yield* db.entities.Retained.update({ id: "d", f: make() }).set({ note: "x" }).asEffect()
    yield* db.entities.Indexed.update({ id: "c" }).set({ note: "x" }).asEffect()
    yield* db.aggregates.Roots.update({ id: "e", f: make() }, ({ state }: any) => ({
      ...state,
      note: "two",
    }))
    expect((yield* db.aggregates.Roots.get({ id: "e", f: make() })).note).toBe("two")
    stages.updated = rows()
    return stages as Record<Exclude<Stage, "put">, ReadonlyArray<Row>>
  })

/**
 * 1.39.0's stage as the head leaves it: the item `restore` put under `[object object]` is under the
 * key `put` wrote, the sentinel a delete left is released, and an aggregate update 1.39.0 refused
 * (`Expected Option`) is written.
 */
export const asHeadLeavesIt = (
  captured: Captured,
  stage: Exclude<Stage, "put">,
): ReadonlyArray<Row> => {
  const putSk = typed(captured.stages.put, "Soft")[0]!.sk!
  return captured.stages[stage]
    .filter((row) => stage !== "updated" || !row.__edd_e__?.S?.startsWith("Unique._unique."))
    .map((row) => {
      if (row.__edd_e__?.S === "Soft" && row.sk?.S?.endsWith("#f_[object object]")) {
        return { ...row, sk: putSk }
      }
      if (
        row.__edd_e__?.S === "Root" &&
        stage === "updated" &&
        captured.results.aggregateUpdate !== "ok"
      ) {
        return { ...row, note: { S: "two" } }
      }
      return row
    })
}

export const isCookie = (name: string) =>
  name === "Cookie" || name === "Cookie expires" || name === "Cookies"
export const written = Object.entries(fixture).filter(
  ([name, captured]) => captured.stages.put.length > 0 && !isCookie(name),
)
