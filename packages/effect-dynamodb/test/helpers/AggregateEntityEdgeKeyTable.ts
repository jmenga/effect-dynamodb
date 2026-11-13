/**
 * The table of sort key text an `entity:` `many` edge composes, per field type (#241, DESIGN.md §11
 * "An `entity:` edge's sort key", and the changeset's table), measured. For each field type, one
 * element of an edge declaring `entity:` and one of a plain edge, `sk.composite` naming the field
 * (or a path into it), under `escapeKeys` false and true:
 *
 * - `false`: the `entity:` edge stores 1.40.0's text;
 * - `true`: it stores what a plain edge stores;
 * - a plain edge stores 1.40.0's text under either setting;
 * - the text changes from 1.40.0's exactly for the rows the docs list as affected, and only for
 *   composites `Aggregate.entityEdgeEncodedComposites`, the one decision the composer, `update`'s
 *   move and `rekey` read, names.
 *
 * `fixtures/aggregate-entity-edge-key-table-1.40.0.json` holds what published 1.40.0 stored.
 */

import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DateTime, Effect, Schema, SchemaGetter } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import type { Harness } from "./AggregateEntityEdgeKeys.js"

type Row = Record<string, AttributeValue>
type Measured = {
  readonly label: string
  readonly "entity off": string
  readonly "entity on": string
  readonly "plain off": string
  readonly "plain on": string
}
const published = JSON.parse(
  readFileSync(
    new URL("../fixtures/aggregate-entity-edge-key-table-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly generatedFrom: ReadonlyArray<string>; readonly rows: ReadonlyArray<Measured> }

const padded = () =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((text: string) => text.trim()),
      encode: SchemaGetter.transform((text: string) => `${text} `),
    }),
  )
const hex = () =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.String, {
      decode: SchemaGetter.transform((text: string) => Buffer.from(text, "hex").toString("utf8")),
      encode: SchemaGetter.transform((text: string) => Buffer.from(text, "utf8").toString("hex")),
    }),
  )
const whole = () =>
  Schema.Struct({ n: Schema.String }).pipe(
    Schema.decodeTo(Schema.Struct({ n: Schema.Number }), {
      decode: SchemaGetter.transform(({ n }: { readonly n: string }) => ({ n: Number(n) })),
      encode: SchemaGetter.transform(({ n }: { readonly n: number }) => ({ n: String(n) })),
    }),
  )
class Leafed extends Schema.Class<Leafed>("Leafed")({ n: Schema.NumberFromString }) {}
class Plainly extends Schema.Class<Plainly>("Plainly")({ n: Schema.Number }) {}

const instant = () => DateTime.makeUnsafe(Date.UTC(2024, 4, 6, 7, 8, 9))
const zoned = () =>
  DateTime.makeZonedUnsafe(Date.UTC(2024, 4, 6, 7, 8, 9), { timeZone: "Europe/Paris" })

/** The field types, as captured: label, the field's schema, its value, the composite. */
const types: ReadonlyArray<readonly [string, () => Schema.Top, () => unknown, string | undefined]> =
  [
    ["Schema.NumberFromString", () => Schema.NumberFromString, () => 5, "f"],
    ["Schema.BigIntFromString", () => Schema.BigIntFromString, () => 5n, "f"],
    ["DynamoModel.DateEpochMs", () => DynamoModel.DateEpochMs, instant, "f"],
    [
      "storedAs(DynamoModel.DateEpochMs)",
      () => Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs)),
      instant,
      "f",
    ],
    ["DynamoModel.DateEpochSeconds", () => DynamoModel.DateEpochSeconds, instant, "f"],
    ["Schema.DateTimeZonedFromString", () => Schema.DateTimeZonedFromString, zoned, "f"],
    ["codec x stored x+space", padded, () => "x", "f"],
    ["codec A stored 41", hex, () => "A", "f"],
    ["path into a whole-object codec", whole, () => ({ n: 5 }), "f.n"],
    [
      "path into a Schema.Class with a NumberFromString leaf",
      () => Leafed,
      () => new Leafed({ n: 5 }),
      "f.n",
    ],
    ["Schema.DateTimeUtc", () => Schema.DateTimeUtc, instant, "f"],
    ["Schema.DateTimeUtcFromString", () => Schema.DateTimeUtcFromString, instant, "f"],
    ["Schema.Number", () => Schema.Number, () => 5, "f"],
    ["Schema.String", () => Schema.String, () => "A", "f"],
    [
      "path into a struct with a NumberFromString leaf",
      () => Schema.Struct({ n: Schema.NumberFromString }),
      () => ({ n: 5 }),
      "f.n",
    ],
    [
      "path into a Schema.Class with a Number leaf",
      () => Plainly,
      () => new Plainly({ n: 5 }),
      "f.n",
    ],
    [
      "a union of NumberFromString and a literal",
      () => Schema.Union([Schema.NumberFromString, Schema.Literal("none")]),
      () => 5,
      "f",
    ],
    [
      "Schema.NullOr(Schema.NumberFromString)",
      () => Schema.NullOr(Schema.NumberFromString),
      () => 5,
      "f",
    ],
    [
      "Schema.optionalKey(Schema.NumberFromString)",
      () => Schema.optionalKey(Schema.NumberFromString),
      () => 5,
      "f",
    ],
    ["no declared sort key", () => Schema.NumberFromString, () => 5, undefined],
  ]

/** The rows the docs' table lists as changing under `escapeKeys: true`. */
const AFFECTED = [
  "Schema.NumberFromString",
  "Schema.BigIntFromString",
  "DynamoModel.DateEpochMs",
  "storedAs(DynamoModel.DateEpochMs)",
  "DynamoModel.DateEpochSeconds",
  "Schema.DateTimeZonedFromString",
  "codec x stored x+space",
  "codec A stored 41",
  "path into a whole-object codec",
  "path into a Schema.Class with a NumberFromString leaf",
  "Schema.optionalKey(Schema.NumberFromString)",
]

const defined = (
  field: () => Schema.Top,
  path: string | undefined,
  escapeKeys: boolean,
  entity: boolean,
) => {
  const Line = Schema.Struct({ id: Schema.String, f: field() as any })
  const Lines = Entity.make({
    model: DynamoModel.configure(Line, { id: { identifier: true } } as never),
    entityType: "Line",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  } as never) as any
  const schema = DynamoSchema.make({ name: "table", version: 1, escapeKeys })
  const Main = Table.make({ schema, entities: { Lines } })
  const Agg = (Aggregate.make as any)(
    Schema.Struct({ id: Schema.String, lines: Schema.Array(Line) }),
    {
      table: Main,
      schema,
      pk: { field: "pk", composite: ["id"] },
      collection: { name: "agg" },
      root: { entityType: "Root" },
      edges: {
        lines: (Aggregate.many as any)({
          ...(entity ? { entity: Lines } : {}),
          entityType: "Entry",
          ...(path === undefined ? {} : { sk: { composite: [path] } }),
        }),
      },
    },
  )
  return { Lines, Main, Agg }
}

export const keyTableSuite = (
  harness: Harness,
  describeIt: (name: string, body: () => void) => void = describe,
) =>
  describeIt("an entity: edge's sort key text, per field type, measured (#241)", () => {
    it("the fixture is published 1.40.0's, one row per field type the suite defines", () => {
      expect(published.generatedFrom).toEqual(["effect-dynamodb@1.40.0"])
      expect(published.rows.map((row) => row.label)).toEqual(types.map(([label]) => label))
    })

    it.effect(
      "each row: off stores 1.40.0's text, on a plain edge's, and only the listed rows change",
      () =>
        Effect.gen(function* () {
          const now: Array<Measured> = []
          for (const [label, field, value, path] of types) {
            const measured: Record<string, string> = { label }
            for (const escapeKeys of [false, true]) {
              for (const entity of [true, false]) {
                const defs = defined(field, path, escapeKeys, entity)
                const sk = yield* harness.onTable((tableName) =>
                  Effect.gen(function* () {
                    const db = yield* DynamoClient.make({
                      entities: { Lines: defs.Lines },
                      aggregates: { Agg: defs.Agg },
                      tables: { Main: defs.Main },
                    })
                    yield* db.aggregates.Agg.create({ id: "a", lines: [{ id: "l1", f: value() }] })
                    const rows: ReadonlyArray<Row> = yield* harness.rows(tableName)
                    return rows
                      .filter((row) => row.__edd_e__?.S === "Entry")
                      .map((row) => row.sk!.S!)
                  }).pipe(Effect.provide(defs.Main.layer({ name: tableName }))),
                )
                expect({ label, escapeKeys, entity, rows: sk.length }).toEqual({
                  label,
                  escapeKeys,
                  entity,
                  rows: 1,
                })
                measured[`${entity ? "entity" : "plain"} ${escapeKeys ? "on" : "off"}`] = sk[0]!
              }
            }
            now.push(measured as Measured)
          }
          for (const [i, row] of now.entries()) {
            const then = published.rows[i]!
            const [label, field, , path] = types[i]!
            // Off: 1.40.0's text. A plain edge: 1.40.0's under either setting.
            expect({ label, off: row["entity off"] }).toEqual({ label, off: then["entity off"] })
            expect({ label, plain: [row["plain off"], row["plain on"]] }).toEqual({
              label,
              plain: [then["plain off"], then["plain on"]],
            })
            // On: a plain edge's text.
            expect({ label, on: row["entity on"] }).toEqual({ label, on: row["plain on"] })
            // Changed from 1.40.0's exactly where the docs say, and only where the decision names
            // the composite.
            const changed = row["entity on"] !== then["entity on"]
            expect({ label, changed }).toEqual({ label, changed: AFFECTED.includes(label) })
            const named =
              Aggregate.entityEdgeEncodedComposites(
                defined(field, path, true, true).Lines.model,
                path === undefined ? undefined : [path],
              ).length > 0
            if (changed) expect({ label, named }).toEqual({ label, named: true })
          }
        }),
    )
  })
