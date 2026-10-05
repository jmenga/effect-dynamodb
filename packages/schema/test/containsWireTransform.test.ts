/**
 * `containsWireTransform` — the aggregate's write-side encoder gate (#133).
 *
 * The gate used to look at a field's TOP-LEVEL AST only, and an `Arrays` /
 * `Objects` node never carries an encoding of its own, so containers of
 * transformed values were stored without being encoded. It must see a wire
 * transform at any depth, through every wrapper a model field can carry.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as DynamoModel from "../src/DynamoModel.js"
import { containsWireTransform } from "../src/internal/EntitySchemas.js"

class Player extends Schema.Class<Player>("Player")({
  id: Schema.String,
  dateOfBirth: Schema.DateTimeUtcFromString,
}) {}

class Plain extends Schema.Class<Plain>("Plain")({ id: Schema.String }) {}

describe("containsWireTransform", () => {
  it("is true for leaf transforms, self dates and Redacted", () => {
    expect(containsWireTransform(Schema.DateTimeUtcFromString)).toBe(true)
    expect(containsWireTransform(Schema.BigIntFromString)).toBe(true)
    expect(containsWireTransform(Schema.DateTimeUtc)).toBe(true)
    expect(containsWireTransform(Schema.DateTimeZoned)).toBe(true)
    expect(containsWireTransform(Schema.Date)).toBe(true)
    expect(containsWireTransform(Schema.Redacted(Schema.String))).toBe(true)
  })

  it("sees through arrays, structs, unions and optional wrappers", () => {
    expect(containsWireTransform(Schema.Array(Schema.DateTimeUtcFromString))).toBe(true)
    expect(containsWireTransform(Schema.Array(Schema.Date))).toBe(true)
    expect(containsWireTransform(Schema.Array(Schema.Array(Schema.BigIntFromString)))).toBe(true)
    expect(containsWireTransform(Schema.Struct({ at: Schema.DateTimeUtc }))).toBe(true)
    expect(containsWireTransform(Schema.NullOr(Schema.BigIntFromString))).toBe(true)
    expect(
      containsWireTransform(Schema.optionalKey(Schema.Array(Schema.DateTimeUtcFromString))),
    ).toBe(true)
    expect(containsWireTransform(Schema.optional(Schema.Array(Schema.DateTimeUtcFromString)))).toBe(
      true,
    )
    expect(
      containsWireTransform(
        Schema.DateTimeUtcFromString.pipe(Schema.withDecodingDefault(Effect.succeed("1800-01-01"))),
      ),
    ).toBe(true)
  })

  it("is true for classes — including a DynamoModel.ref-annotated one", () => {
    expect(containsWireTransform(Player)).toBe(true)
    expect(containsWireTransform(Player.pipe(DynamoModel.ref))).toBe(true)
    expect(containsWireTransform(Schema.Array(Player))).toBe(true)
  })

  it("is false where the stored form is the domain form", () => {
    expect(containsWireTransform(Schema.String)).toBe(false)
    expect(containsWireTransform(Schema.Number)).toBe(false)
    expect(containsWireTransform(Schema.Literals(["a", "b"]))).toBe(false)
    expect(containsWireTransform(Schema.Array(Schema.String))).toBe(false)
    expect(containsWireTransform(Schema.optionalKey(Schema.Array(Schema.Number)))).toBe(false)
    expect(containsWireTransform(Schema.Struct({ id: Schema.String }))).toBe(false)
    expect(containsWireTransform(Schema.Record(Schema.String, Schema.Number))).toBe(false)
  })

  it("terminates on recursive schemas", () => {
    interface Node {
      readonly children: ReadonlyArray<Node>
    }
    const Node: Schema.Codec<Node> = Schema.Struct({
      children: Schema.Array(Schema.suspend((): Schema.Codec<Node> => Node)),
    })
    expect(containsWireTransform(Node)).toBe(false)
    // A class is a transform even when its fields are not.
    expect(containsWireTransform(Plain)).toBe(true)
  })
})
