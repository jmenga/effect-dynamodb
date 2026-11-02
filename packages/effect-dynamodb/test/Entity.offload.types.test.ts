/**
 * The offload type parameter on entities (#179, design §9.1, §9.3): `Entity`
 * and the schema package's `EntityDefinition` carry `TOffload` (inferred from
 * the configured model), `BoundEntity` and `TypedClient` pass it on, every
 * write adds `WriteBlobErrors<TOffload>` — `BlobStoreError` for a member that
 * offloads anything, nothing for one that does not — and an External field's
 * paths are `PackedPath`s, as a packed field's are.
 *
 * Compile-time only; checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as SchemaEntity from "@effect-dynamodb/schema/Entity.js"
import type { BlobStoreError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { NoOffload } from "../src/Offload.js"
import * as Table from "../src/Table.js"
import { withOffloadGate } from "./helpers/OffloadGate.js"

class Doc extends Schema.Class<Doc>("Doc")({
  docId: Schema.String,
  title: Schema.String,
  body: Schema.Struct({ text: Schema.String }),
  scan: Schema.optional(Schema.Uint8Array),
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["docId"] },
  sk: { field: "sk", composite: [] },
} as const

const offloaded = DynamoModel.configure(Doc, {
  body: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 1_024 } }) },
  scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
})

const Docs = withOffloadGate(() =>
  Entity.make({ model: offloaded, entityType: "Doc", primaryKey, versioned: { retain: true } }),
)

/** Binary only: its writes still reach the store. */
const Scans = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Doc, { scan: { storedAs: DynamoModel.External() } }),
    entityType: "Scan",
    primaryKey,
  }),
)

const Plain = Entity.make({ model: Doc, entityType: "PlainDoc", primaryKey })

/** {@link Docs} with its fields inline: what offloading must not change. */
const InlineDocs = Entity.make({
  model: DynamoModel.configure(Doc, {
    body: { storedAs: DynamoModel.Packed({ format: "json" }) },
  }),
  entityType: "InlineDoc",
  primaryKey,
  versioned: { retain: true },
})

/** A pure definition, from the AWS-free package. */
const PureDocs = withOffloadGate(() =>
  SchemaEntity.make({ model: offloaded, entityType: "PureDoc", primaryKey }),
)

class Reading extends Schema.Class<Reading>("Reading")({
  sensorId: Schema.String,
  at: Schema.Number,
  raw: Schema.optional(Schema.Uint8Array),
}) {}

const Readings = withOffloadGate(() =>
  Entity.make({
    model: DynamoModel.configure(Reading, { raw: { storedAs: DynamoModel.External() } }),
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["sensorId"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: {
      orderBy: "at",
      appendInput: Schema.Struct({
        sensorId: Schema.String,
        at: Schema.Number,
        raw: Schema.optional(Schema.Uint8Array),
      }),
    },
  }),
)

const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "types", version: 1, escapeKeys: true }),
  entities: { Docs, Scans, Plain, PureDocs, Readings },
})

type ErrorOf<T> = T extends { readonly asEffect: () => Effect.Effect<any, infer E, any> }
  ? E
  : T extends Effect.Effect<any, infer E, any>
    ? E
    : never
type Blob<T> = Extract<ErrorOf<T>, BlobStoreError>

const key = { docId: "d-1" }
const doc = { docId: "d-1", title: "t", body: { text: "b" } }

// The functions below are type-checked, never executed.
const typeOnly = (_: () => unknown) => undefined

describe("the offload type parameter (#179)", () => {
  it("is inferred from the configured model, on runtime and pure definitions alike", () => {
    type Fields = { readonly overflow: "body"; readonly binary: "scan" }
    expectTypeOf<NonNullable<(typeof Docs)["_offloadFields"]>>().toEqualTypeOf<Fields>()
    expectTypeOf<NonNullable<(typeof PureDocs)["_offloadFields"]>>().toEqualTypeOf<Fields>()
    expectTypeOf<NonNullable<(typeof Scans)["_offloadFields"]>>().toEqualTypeOf<{
      readonly overflow: never
      readonly binary: "scan"
    }>()
    expectTypeOf<NonNullable<(typeof Plain)["_offloadFields"]>>().toEqualTypeOf<NoOffload>()
    // A binary field is opaque to expressions: one of the entity's packed fields.
    expectTypeOf<(typeof Docs)["_packedFields"][number]>().toEqualTypeOf<"body" | "scan">()
    expectTypeOf<(typeof PureDocs)["_packedFields"][number]>().toEqualTypeOf<"body" | "scan">()
    expectTypeOf<(typeof Plain)["_packedFields"][number]>().toBeNever()
  })

  it("adds BlobStoreError to every unbound write of a member that offloads", () => {
    typeOnly(() => {
      expectTypeOf<Blob<ReturnType<typeof Docs.put>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.create>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.upsert>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.update>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.patch>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.delete>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.deleteIfExists>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.restore>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Docs.purge>>>().toEqualTypeOf<BlobStoreError>()
      expectTypeOf<Blob<ReturnType<typeof Scans.put>>>().toEqualTypeOf<BlobStoreError>()
      const appended = Readings.append({ sensorId: "s", at: 1 })
      expectTypeOf<Blob<typeof appended>>().toEqualTypeOf<BlobStoreError>()
      const fired = Readings.append({ sensorId: "s", at: 1 }, undefined, true)
      expectTypeOf<Blob<typeof fired>>().toEqualTypeOf<BlobStoreError>()
      // A member that offloads nothing: exactly today's unions.
      expectTypeOf<Blob<ReturnType<typeof Plain.put>>>().toBeNever()
      expectTypeOf<Blob<ReturnType<typeof Plain.update>>>().toBeNever()
      expectTypeOf<Blob<ReturnType<typeof Plain.delete>>>().toBeNever()
      expectTypeOf<Blob<ReturnType<typeof Plain.purge>>>().toBeNever()
    })
    expect(true).toBe(true)
  })

  it("reaches the bound client, for runtime and pure definitions alike", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Docs, Scans, Plain, PureDocs, Readings },
          tables: { MainTable },
        })
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.put>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.update>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.delete>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.restore>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Docs.purge>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.PureDocs.put>>
        >().toEqualTypeOf<BlobStoreError>()
        expectTypeOf<
          Blob<ReturnType<typeof db.entities.Scans.upsert>>
        >().toEqualTypeOf<BlobStoreError>()
        const appended = db.entities.Readings.append({ sensorId: "s", at: 1 })
        expectTypeOf<Blob<typeof appended>>().toEqualTypeOf<BlobStoreError>()
        const fired = db.entities.Readings.append({ sensorId: "s", at: 1 }).skipFollowUp()
        expectTypeOf<Blob<typeof fired>>().toEqualTypeOf<BlobStoreError>()
        // The builders keep it through their combinators.
        const updated = db.entities.Docs.update(key).set({ title: "t2" }).expectedVersion(1)
        expectTypeOf<Blob<typeof updated>>().toEqualTypeOf<BlobStoreError>()
        const put = db.entities.Docs.put(doc).condition({ title: "t" })
        expectTypeOf<Blob<typeof put>>().toEqualTypeOf<BlobStoreError>()
        // A member that offloads nothing: exactly today's unions.
        expectTypeOf<Blob<ReturnType<typeof db.entities.Plain.put>>>().toBeNever()
        expectTypeOf<Blob<ReturnType<typeof db.entities.Plain.update>>>().toBeNever()
        expectTypeOf<Blob<ReturnType<typeof db.entities.Plain.delete>>>().toBeNever()
      }),
    )
    expect(true).toBe(true)
  })

  it("types an External field's paths as PackedPaths: exists / notExists only", () => {
    typeOnly(() =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Docs }, tables: { MainTable } })
        db.entities.Docs.update(key)
          .set({ title: "t2" })
          .condition((t, { exists }) => exists(t.scan))
        db.entities.Docs.put(doc).condition((t, { notExists }) => notExists(t.scan))
        db.entities.Docs.put(doc).condition((t, { eq }) =>
          // @ts-expect-error — an External field's path is not a comparable Path
          eq(t.scan, new Uint8Array(1)),
        )
        db.entities.Docs.delete(key).condition((t, { gt }) =>
          // @ts-expect-error — no size() on an External field
          gt(t.scan.size(), 1),
        )
        Docs.condition((t, { eq }) =>
          // @ts-expect-error — the unbound combinator types it the same way
          eq(t.scan, new Uint8Array(1)),
        )
      }),
    )
    expect(true).toBe(true)
  })

  it("keeps the ref-aware input helpers for a member that offloads", () => {
    expectTypeOf<Entity.Input<typeof Docs>>().toEqualTypeOf<Entity.Input<typeof InlineDocs>>()
    expectTypeOf<Entity.Update<typeof Docs>>().toEqualTypeOf<Entity.Update<typeof InlineDocs>>()
    expectTypeOf<Entity.Create<typeof Docs>>().toEqualTypeOf<Entity.Create<typeof InlineDocs>>()
  })
})
