/**
 * PathBuilder typing of top and opaque field types (#147 regression).
 *
 * Packed fields (`storedAs: DynamoModel.Packed`) are typed as `PackedPath` via
 * a `PackedValue` marker. The marker check must not distribute over `any` (nor
 * match `never`): a `Schema.Any` field became `PackedPath | ArrayPath | …`, so
 * `eq(t.anyField, 1)` failed to compile even on an entity with no packed field.
 *
 * Every non-packed field must map exactly as in 1.25.0 — `PathBuilder125`
 * below is the 1.25.0 mapping, verbatim — whether or not the entity has other,
 * packed fields.
 *
 * Compile-time only; checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Entity from "../src/Entity.js"
import type {
  ArrayPath,
  PackedPath,
  Path,
  PathBuilder,
  PathKeys,
  PathModel,
  SparsePath,
} from "../src/internal/PathBuilder.js"

/** The 1.25.0 `PathBuilder` mapping, verbatim. */
type PathBuilder125<Root, Model, Keys extends ReadonlyArray<string | number> = []> = {
  readonly [K in keyof Model]-?: NonNullable<Model[K]> extends ReadonlyArray<infer E>
    ? ArrayPath<Root, E, [...Keys, K & string]>
    : NonNullable<Model[K]> extends globalThis.Record<infer KK, infer V>
      ? string extends KK
        ? SparsePath<Root, V, [...Keys, K & string]>
        : PathBuilder125<Root, NonNullable<Model[K]>, [...Keys, K & string]> &
            Path<Root, NonNullable<Model[K]>, [...Keys, K & string]>
      : Path<Root, NonNullable<Model[K]>, [...Keys, K & string]>
}

/** The 1.25.0 `PathKeys`, verbatim. */
type PathKeys125<P> = P extends Path<any, any, infer K> ? K : never

const Opaque = Schema.Struct({
  id: Schema.String,
  anyField: Schema.Any,
  unknownField: Schema.Unknown,
  objectField: Schema.ObjectKeyword,
  optionalAny: Schema.optional(Schema.Any),
  nullableUnknown: Schema.NullOr(Schema.Unknown),
  union: Schema.Union([Schema.String, Schema.Array(Schema.Number)]),
  lines: Schema.Array(Schema.Struct({ sku: Schema.String })),
})
type Opaque = typeof Opaque.Type

interface WithNever {
  readonly id: string
  readonly nothing: never
}

describe("PathBuilder — top and opaque types map as in 1.25.0", () => {
  it("with no packed field, every field maps exactly as in 1.25.0", () => {
    type Now = PathBuilder<Opaque, Opaque>
    type Was = PathBuilder125<Opaque, Opaque>
    expectTypeOf<Now["anyField"]>().toEqualTypeOf<Was["anyField"]>()
    expectTypeOf<Now["unknownField"]>().toEqualTypeOf<Was["unknownField"]>()
    expectTypeOf<Now["objectField"]>().toEqualTypeOf<Was["objectField"]>()
    expectTypeOf<Now["optionalAny"]>().toEqualTypeOf<Was["optionalAny"]>()
    expectTypeOf<Now["nullableUnknown"]>().toEqualTypeOf<Was["nullableUnknown"]>()
    expectTypeOf<Now["union"]>().toEqualTypeOf<Was["union"]>()
    expectTypeOf<Now["lines"]>().toEqualTypeOf<Was["lines"]>()
    expectTypeOf<PathBuilder<WithNever, WithNever>["nothing"]>().toEqualTypeOf<
      PathBuilder125<WithNever, WithNever>["nothing"]
    >()
    expectTypeOf<PathBuilder<any, any>>().toEqualTypeOf<PathBuilder125<any, any>>()
  })

  it("with other fields packed, the non-packed fields still map as in 1.25.0", () => {
    type M = PathModel<Opaque, "lines">
    type Now = PathBuilder<M, M>
    type Was = PathBuilder125<M, M>
    expectTypeOf<Now["anyField"]>().toEqualTypeOf<Was["anyField"]>()
    expectTypeOf<Now["unknownField"]>().toEqualTypeOf<Was["unknownField"]>()
    expectTypeOf<Now["objectField"]>().toEqualTypeOf<Was["objectField"]>()
    expectTypeOf<Now["optionalAny"]>().toEqualTypeOf<Was["optionalAny"]>()
    expectTypeOf<Now["nullableUnknown"]>().toEqualTypeOf<Was["nullableUnknown"]>()
    expectTypeOf<Now["union"]>().toEqualTypeOf<Was["union"]>()
    expectTypeOf<Now["lines"]>().toEqualTypeOf<
      PackedPath<M, ReadonlyArray<{ readonly sku: string }>, ["lines"]>
    >()
  })

  it("PathKeys of a non-packed path is unchanged", () => {
    type P = Path<Opaque, string, ["id"]>
    expectTypeOf<PathKeys<P>>().toEqualTypeOf<PathKeys125<P>>()
    expectTypeOf<PathKeys<any>>().toEqualTypeOf<PathKeys125<any>>()
    expectTypeOf<PathKeys<unknown>>().toEqualTypeOf<PathKeys125<unknown>>()
    expectTypeOf<PathKeys<never>>().toEqualTypeOf<PathKeys125<never>>()
    expectTypeOf<PathKeys<PackedPath<Opaque, unknown, ["lines"]>>>().toEqualTypeOf<["lines"]>()
  })

  it("a packed opaque field is a PackedPath, not swallowed by any", () => {
    type M = PathModel<Opaque, "anyField" | "unknownField">
    expectTypeOf<PathBuilder<M, M>["anyField"]>().toEqualTypeOf<PackedPath<M, any, ["anyField"]>>()
    expectTypeOf<PathBuilder<M, M>["unknownField"]>().toEqualTypeOf<
      PackedPath<M, {}, ["unknownField"]>
    >()
  })

  const Plain = Entity.make({
    model: Opaque,
    entityType: "Opaque",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })

  const Packed = Entity.make({
    model: DynamoModel.configure(Opaque, {
      lines: { storedAs: DynamoModel.Packed({ format: "json" }) },
    }),
    entityType: "OpaquePacked",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
  })

  it("conditions and filters on any / unknown fields compile, packed or not", () => {
    Plain.condition((t, { eq, and, exists, gt }) =>
      and(eq(t.anyField, 1), exists(t.unknownField), gt(t.anyField, 0), eq(t.optionalAny, "x")),
    )
    Plain.filter((t, { and, eq, ne }) => and(ne(t.unknownField, 1), eq(t.objectField, {})))
    Plain.select((t) => [t.anyField, t.unknownField])
    Packed.condition((t, { eq, and, exists, gt }) =>
      and(eq(t.anyField, 1), exists(t.unknownField), gt(t.anyField, 0), eq(t.optionalAny, "x")),
    )
    Packed.filter((t, { and, eq, ne }) => and(ne(t.unknownField, 1), eq(t.objectField, {})))
    Packed.select((t) => [t.anyField, t.unknownField, t.lines])
    expect(true).toBe(true)
  })
})
