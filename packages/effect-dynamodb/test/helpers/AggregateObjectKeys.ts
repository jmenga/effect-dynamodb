/**
 * The aggregates of `AggregateObjectKeys.test.ts` and its connected twin (#242, `EDD-9162`): each
 * keyed partly by an object field, as the generator of `fixtures/aggregate-object-keys-1.40.0.json`
 * defined them on published 1.40.0.
 */
import { readFileSync } from "node:fs"
import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Exit, Schema } from "effect"
import * as Aggregate from "../../src/Aggregate.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"

export type Row = Record<string, AttributeValue>

export const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/aggregate-object-keys-1.40.0.json", import.meta.url), "utf8"),
) as {
  readonly generatedFrom: string
  readonly shapes: Record<
    Shape,
    { readonly results: Record<string, unknown>; readonly rows: ReadonlyArray<Row> }
  >
}

export type Shape =
  | "partitionKey"
  | "listSortKey"
  | "listPartitionKey"
  | "collectionSortKey"
  | "discriminator"

export const SHAPES: ReadonlyArray<Shape> = [
  "partitionKey",
  "listSortKey",
  "listPartitionKey",
  "collectionSortKey",
  "discriminator",
]

/** Where each shape composes `f`, as the refusal names it. */
export const INTO: Record<Shape, string> = {
  partitionKey: 'Field "f" of "Root" is composed into its partition key',
  listSortKey: 'Field "f" of "Root" is composed into its list sort key',
  listPartitionKey: 'Field "f" of "Root" is composed into its list partition key',
  collectionSortKey: 'Field "f" of "Root" is composed into its collection sort key',
  discriminator: 'Discriminator "side" of "side" is composed into its sort key',
}

export const Side = Aggregate.make(Schema.Struct({ s: Schema.String }), {
  root: { entityType: "Side" },
  edges: {},
})

/**
 * The aggregate the fixture's generator defined for `shape`, `f` a `Schema.Unknown` (text, for
 * the discriminator), with `escapeKeys` off as 1.40.0 composed. `field` and `discriminator` swap in
 * another field or discriminator value for the controls.
 */
export const define = (
  shape: Shape,
  options: { readonly field?: Schema.Top; readonly discriminator?: unknown } = {},
) => {
  const schema = DynamoSchema.make({ name: "ao", version: 1, escapeKeys: false })
  const Dummy = Entity.make({
    model: Schema.Struct({ id: Schema.String }),
    entityType: "Dummy",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })
  const Base = Table.make({ schema, entities: { Dummy } })
  const disc = shape === "discriminator"
  const Roots = Aggregate.make(
    Schema.Struct({
      id: Schema.String,
      f: options.field ?? (disc ? Schema.String : Schema.Unknown),
      note: Schema.String,
      ...(disc ? { side: Schema.Struct({ s: Schema.String }) } : {}),
    }),
    {
      table: Base,
      schema,
      pk: { field: "pk", composite: shape === "partitionKey" ? ["f"] : ["id"] },
      collection:
        shape === "collectionSortKey"
          ? { index: "lsi1", name: "roots", sk: { field: "lsi1sk", composite: ["f"] } }
          : { name: "roots" },
      ...(shape === "listSortKey" || shape === "listPartitionKey"
        ? {
            list: {
              index: "gsi1",
              name: "rl",
              pk: { field: "gsi1pk", composite: shape === "listPartitionKey" ? ["f"] : [] },
              sk: { field: "gsi1sk", composite: shape === "listPartitionKey" ? [] : ["f"] },
            },
          }
        : {}),
      root: { entityType: "Root" },
      edges: disc
        ? { side: Side.with({ discriminator: { side: options.discriminator ?? { a: 1 } } }) }
        : {},
    } as never,
  )
  return { Base, Roots, Main: { ...Base, aggregates: { Roots } } }
}

export const fOf = (shape: Shape, id: "a" | "b" | "c") =>
  shape === "discriminator" ? id : { a: id === "a" ? 1 : id === "b" ? 2 : 3 }
export const valueOf = (shape: Shape, id: "a" | "b" | "c") => ({
  id,
  f: fOf(shape, id),
  note: "one",
  ...(shape === "discriminator" ? { side: { s: "s" } } : {}),
})
export const keyOf = (shape: Shape, id: "a" | "b") =>
  shape === "partitionKey" ? { f: fOf(shape, id) } : { id }

/** What an exit answered, as the fixture's `results` record it. */
export const outcome = (exit: Exit.Exit<any, unknown>) =>
  Exit.isSuccess(exit) ? "ok" : ((Cause.squash(exit.cause) as { _tag?: string })._tag ?? "defect")
