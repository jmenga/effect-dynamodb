/**
 * AST-shape probe tests (#55).
 *
 * The entity/aggregate schema-derivation layer reads a few Effect Schema AST
 * internals via typed accessors (`SchemaAST` guards, `.value`, `.fields`,
 * `.context.isOptional`, `.encoding`). A beta bump that moves any of these
 * silently breaks key derivation — exactly the class of bug that shipped when
 * the array element moved `.schema`→`.value` in beta.71.
 *
 * These tests assert the accessors still have the expected runtime shape, so a
 * future Effect upgrade fails HERE (loudly) instead of mis-deriving keys.
 */

import { describe, expect, it } from "@effect/vitest"
import { Schema, SchemaAST } from "effect"
import { isRecord, isRecordAst, isRecordSchema } from "../src/DynamoModel.js"
import {
  extractArrayElement,
  getSchemaFields,
  isFieldOptional,
} from "../src/internal/AggregateSchemas.js"

class Player extends Schema.Class<Player>("Player")({ id: Schema.String }) {}

describe("AST-shape probes (#55)", () => {
  describe("SchemaAST guards + raw shape", () => {
    it("Schema.Array carries an Arrays AST with the element on .value", () => {
      const arr = Schema.Array(Player)
      expect(SchemaAST.isArrays(arr.ast)).toBe(true)
      expect((arr as unknown as { value: unknown }).value).toBe(Player)
    })

    it("optionalKey marks context.isOptional", () => {
      expect(Schema.optionalKey(Schema.String).ast.context?.isOptional).toBe(true)
      expect(Schema.String.ast.context?.isOptional ?? false).toBe(false)
    })

    it("Schema.Record is an Objects AST with one index signature, no properties", () => {
      const rec = Schema.Record(Schema.String, Schema.Number)
      const ast = rec.ast
      expect(SchemaAST.isObjects(ast)).toBe(true)
      if (SchemaAST.isObjects(ast)) {
        expect(ast.propertySignatures.length).toBe(0)
        expect(ast.indexSignatures.length).toBe(1)
      }
    })

    it("Struct and Class expose typed .fields", () => {
      const struct = Schema.Struct({ a: Schema.String })
      expect(Object.keys(struct.fields)).toContain("a")
      expect(Object.keys(Player.fields)).toContain("id")
    })

    it("encoding leaf is narrowed by isString / isNumber", () => {
      const enc = Schema.DateTimeUtcFromString.ast.encoding
      expect(enc).toBeDefined()
      const leaf = enc![enc!.length - 1]!
      expect(SchemaAST.isString(leaf.to)).toBe(true)
    })
  })

  describe("extractArrayElement across shapes", () => {
    it("Array(T) → T", () => {
      expect(extractArrayElement(Schema.Array(Player))).toBe(Player)
    })
    it("NonEmptyArray(T) → T", () => {
      expect(extractArrayElement(Schema.NonEmptyArray(Player))).toBe(Player)
    })
    it("optionalKey(Array(T)) → T", () => {
      expect(extractArrayElement(Schema.optionalKey(Schema.Array(Player)))).toBe(Player)
    })
    it("optional(Array(T)) → T", () => {
      expect(extractArrayElement(Schema.optional(Schema.Array(Player)))).toBe(Player)
    })
    it("non-array → undefined", () => {
      expect(extractArrayElement(Schema.String)).toBeUndefined()
    })
  })

  describe("isFieldOptional across shapes", () => {
    it("required → false, optionalKey/optional → true", () => {
      expect(isFieldOptional(Schema.String)).toBe(false)
      expect(isFieldOptional(Schema.optionalKey(Schema.String))).toBe(true)
      expect(isFieldOptional(Schema.optional(Schema.String))).toBe(true)
    })
  })

  describe("getSchemaFields", () => {
    it("returns fields for Struct and Class", () => {
      expect(
        Object.keys(getSchemaFields(Schema.Struct({ a: Schema.String, b: Schema.Number })) ?? {}),
      ).toEqual(["a", "b"])
      expect(Object.keys(getSchemaFields(Player) ?? {})).toEqual(["id"])
    })
  })

  describe("DynamoModel record detection", () => {
    it("Record matches, Struct does not", () => {
      expect(isRecord(Schema.Record(Schema.String, Schema.Number))).toBe(true)
      expect(isRecordSchema(Schema.Record(Schema.String, Schema.Number))).toBeDefined()
      expect(isRecord(Schema.Struct({ a: Schema.String }))).toBe(false)
    })

    it("isRecordAst detects a nested Record value AST", () => {
      const nested = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number))
      const outer = isRecordSchema(nested)
      expect(outer).toBeDefined()
      expect(isRecordAst(outer!.valueAst)).toBe(true)
    })
  })
})
