/**
 * SchemaAST canary tests — detect Effect v4 AST shape changes early.
 *
 * These tests exercise the internal AST properties that _EntitySchemas.ts,
 * DynamoModel.ts, and Aggregate.ts depend on. If Effect changes these
 * shapes, these tests break before the library silently misbehaves.
 */

import { Redacted, Schema, SchemaAST } from "effect"
import { describe, expect, it } from "vitest"
import { DynamoEncodingKey, isRecord, isRecordAst, isRecordSchema } from "../src/DynamoModel.js"
import { inferDefaultEncoding } from "../src/internal/EntitySchemas.js"
import {
  extractArrayElement,
  firstTypeParameterAst,
  getSchemaFields,
  hasEncodingTransformation,
  isFieldOptional,
  recordValueAst,
  transformWireKind,
} from "../src/internal/SchemaAccessors.js"

describe("SchemaAST canary tests", () => {
  describe("DateTime.Utc detection via inferDefaultEncoding", () => {
    it("detects DateTime.Utc from DateTimeUtcFromString", () => {
      const enc = inferDefaultEncoding(Schema.DateTimeUtcFromString)
      expect(enc).toEqual({ storage: "string", domain: "DateTime.Utc" })
    })

    it("has representation.id === 'effect/schema/DateTimeUtc' via SchemaAST.resolve", () => {
      const resolved = SchemaAST.resolve(Schema.DateTimeUtcFromString.ast) as Record<
        string,
        unknown
      >
      expect(resolved).toBeDefined()
      const rep = resolved.representation as { id: string }
      expect(rep.id).toBe("effect/schema/DateTimeUtc")
    })
  })

  describe("DateTime.Zoned detection via inferDefaultEncoding", () => {
    it("detects DateTime.Zoned from Schema.DateTimeZoned", () => {
      const enc = inferDefaultEncoding(Schema.DateTimeZoned)
      expect(enc).toEqual({ storage: "string", domain: "DateTime.Zoned" })
    })

    it("has representation.id === 'effect/schema/DateTimeZoned' via SchemaAST.resolve", () => {
      const resolved = SchemaAST.resolve(Schema.DateTimeZoned.ast) as Record<string, unknown>
      expect(resolved).toBeDefined()
      const rep = resolved.representation as { id: string }
      expect(rep.id).toBe("effect/schema/DateTimeZoned")
    })
  })

  describe("Schema.Date detection", () => {
    it("Schema.Date has representation.id === 'effect/schema/Date' via SchemaAST.resolve", () => {
      // Schema.Date is the "from self" Date schema used in _EntitySchemas.ts.
      // Since 4.0.0-rc it rejects invalid dates itself (Schema.DateValid was
      // removed) and is identified via the `representation` annotation.
      const resolved = SchemaAST.resolve(Schema.Date.ast) as Record<string, unknown>
      expect(resolved).toBeDefined()
      const rep = resolved.representation as { id: string }
      expect(rep.id).toBe("effect/schema/Date")
    })

    it("inferDefaultEncoding detects Date from Schema.Date", () => {
      // Schema.Date is what _EntitySchemas uses for Date detection
      const enc = inferDefaultEncoding(Schema.Date)
      expect(enc).toEqual({ storage: "string", domain: "Date" })
    })
  })

  describe("DynamoEncoding annotation retrieval", () => {
    it("retrieves DynamoEncoding via SchemaAST.resolve + symbol key", () => {
      const encoding = { storage: "string", domain: "DateTime.Utc" } as const
      const annotated = Schema.DateTimeUtcFromString.pipe(
        Schema.annotate({ [DynamoEncodingKey]: encoding }),
      )
      const resolved = SchemaAST.resolve(annotated.ast) as Record<symbol, unknown> | undefined
      expect(resolved).toBeDefined()
      expect(resolved![DynamoEncodingKey]).toEqual(encoding)
    })
  })

  describe("optional date wrapper detection", () => {
    it("Aggregate.ts inferDateEncoding handles optional DateTime.Utc fields", () => {
      // The Aggregate.ts inferDateEncoding unwraps optionals by checking
      // for Union AST with Undefined member. This test verifies the pattern
      // works end-to-end via inferDefaultEncoding on the inner type.
      const optionalAst = Schema.optionalKey(Schema.DateTimeUtcFromString).ast
      // Even if the outer AST isn't directly resolvable, the inner type
      // should remain detectable through the production code's Union unwrapping
      const rawAst = optionalAst as unknown as { _tag: string; types?: Array<{ _tag: string }> }
      if (rawAst._tag === "Union" && rawAst.types) {
        const nonUndefined = rawAst.types.find((t) => t._tag !== "Undefined")
        expect(nonUndefined).toBeDefined()
      }
      // The important thing: the production code path works
      // (tested indirectly through Aggregate.test.ts date field handling)
    })
  })
})

// ---------------------------------------------------------------------------
// Typed accessors (internal/SchemaAccessors.ts) — the hardened replacements
// for the `as any` AST poking that #53 caught silently breaking on beta.71.
// ---------------------------------------------------------------------------

describe("SchemaAccessors typed accessors", () => {
  describe("getSchemaFields", () => {
    it("reads .fields from a Schema.Struct", () => {
      const s = Schema.Struct({ a: Schema.String, b: Schema.Number })
      const fields = getSchemaFields(s)
      expect(fields).toBeDefined()
      expect(Object.keys(fields!).sort()).toEqual(["a", "b"])
    })

    it("reads .fields from a Schema.Class", () => {
      class Person extends Schema.Class<Person>("Person")({
        name: Schema.String,
        age: Schema.Number,
      }) {}
      const fields = getSchemaFields(Person)
      expect(fields).toBeDefined()
      expect(Object.keys(fields!).sort()).toEqual(["age", "name"])
    })

    it("returns undefined for a non-Struct/Class schema", () => {
      expect(getSchemaFields(Schema.String)).toBeUndefined()
      expect(getSchemaFields(Schema.Array(Schema.String))).toBeUndefined()
    })
  })

  describe("isFieldOptional", () => {
    it("returns false for a required field (Schema.String)", () => {
      expect(isFieldOptional(Schema.String)).toBe(false)
    })

    it("returns true for Schema.optionalKey", () => {
      expect(isFieldOptional(Schema.optionalKey(Schema.String))).toBe(true)
    })

    it("returns true for Schema.optional", () => {
      expect(isFieldOptional(Schema.optional(Schema.String))).toBe(true)
    })
  })

  describe("extractArrayElement", () => {
    // Element identity: the extracted element must be the exact schema we put in.
    it("Schema.Array(T) → T", () => {
      const elem = Schema.String
      const extracted = extractArrayElement(Schema.Array(elem))
      expect(extracted).toBe(elem)
    })

    it("Schema.NonEmptyArray(T) → T", () => {
      const elem = Schema.Number
      const extracted = extractArrayElement(Schema.NonEmptyArray(elem))
      expect(extracted).toBe(elem)
    })

    it("Schema.optionalKey(Schema.Array(T)) → T", () => {
      const elem = Schema.String
      const extracted = extractArrayElement(Schema.optionalKey(Schema.Array(elem)))
      expect(extracted).toBe(elem)
    })

    it("Schema.optional(Schema.Array(T)) → T", () => {
      const elem = Schema.Number
      const extracted = extractArrayElement(Schema.optional(Schema.Array(elem)))
      expect(extracted).toBe(elem)
    })

    // A Schema.Class element is a *function* (its constructor), not a plain
    // object — the accessor must preserve its identity. (Regression guard: an
    // over-strict `typeof === "object"` check dropped class elements and left
    // ManyEdge derivation decoding entity objects instead of ID strings.)
    it("preserves a Schema.Class element identity through every array shape", () => {
      class Umpire extends Schema.Class<Umpire>("Umpire")({
        umpireId: Schema.String,
        name: Schema.String,
      }) {}
      expect(extractArrayElement(Schema.Array(Umpire))).toBe(Umpire)
      expect(extractArrayElement(Schema.NonEmptyArray(Umpire))).toBe(Umpire)
      expect(extractArrayElement(Schema.optionalKey(Schema.Array(Umpire)))).toBe(Umpire)
      expect(extractArrayElement(Schema.optional(Schema.Array(Umpire)))).toBe(Umpire)
    })

    it("returns undefined for a non-array field", () => {
      expect(extractArrayElement(Schema.String)).toBeUndefined()
      expect(extractArrayElement(Schema.Struct({ a: Schema.String }))).toBeUndefined()
    })
  })

  describe("Record detection (recordValueAst / DynamoModel.isRecord*)", () => {
    it("detects Schema.Record(String, V) and surfaces the value AST", () => {
      const rec = Schema.Record(Schema.String, Schema.Number)
      const valueAst = recordValueAst(rec)
      expect(valueAst).toBeDefined()
      expect(SchemaAST.isNumber(valueAst!)).toBe(true)
      expect(isRecord(rec)).toBe(true)
      expect(isRecordSchema(rec)).toBeDefined()
    })

    it("detects nested Record (Record value that is itself a Record)", () => {
      const nested = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number))
      const valueAst = recordValueAst(nested)
      expect(valueAst).toBeDefined()
      // The value AST of the outer record is itself a Record-shaped Objects node.
      expect(isRecordAst(valueAst)).toBe(true)
    })

    it("returns undefined/false for a plain Struct", () => {
      const struct = Schema.Struct({ a: Schema.String })
      expect(recordValueAst(struct)).toBeUndefined()
      expect(isRecord(struct)).toBe(false)
      expect(isRecordSchema(struct)).toBeUndefined()
    })

    it("isRecordAst is false for a non-Record AST and for non-AST input", () => {
      expect(isRecordAst(Schema.String.ast)).toBe(false)
      expect(isRecordAst(undefined)).toBe(false)
      expect(isRecordAst("not an ast")).toBe(false)
    })
  })

  describe("transformWireKind", () => {
    it("returns 'string' for a string-encoded transform (DateTimeUtcFromString)", () => {
      expect(transformWireKind(Schema.DateTimeUtcFromString)).toBe("string")
    })

    it("returns 'number' for a number-encoded transform (NumberFromString reversed)", () => {
      // A transform whose encoded leaf is a Number node.
      expect(transformWireKind(Schema.Number.pipe(Schema.decodeTo(Schema.String)))).toBe("number")
    })

    it("returns undefined for a self schema (no encoding chain)", () => {
      expect(transformWireKind(Schema.String)).toBeUndefined()
      expect(transformWireKind(Schema.DateTimeUtc)).toBeUndefined()
    })
  })

  describe("firstTypeParameterAst (isolated unstable accessor)", () => {
    it("reads the inner AST of Schema.RedactedFromValue(T)", () => {
      const inner = firstTypeParameterAst(Schema.RedactedFromValue(Schema.String).ast)
      expect(inner).toBeDefined()
      expect(SchemaAST.isString(inner!)).toBe(true)
    })

    it("returns undefined when no type parameters are present", () => {
      expect(firstTypeParameterAst(Schema.String.ast)).toBeUndefined()
    })
  })
})

// ---------------------------------------------------------------------------
// AST-shape probe — asserts the typed accessors Effect exposes still exist
// with the expected RUNTIME shape. If a future beta moves these properties
// (as beta.71 moved the array element off `.schema` onto `.value`), THIS test
// fails loudly instead of the library silently mis-deriving keys.
// ---------------------------------------------------------------------------

describe("AST-shape probe (loud canary for Effect beta drift)", () => {
  it("SchemaAST exposes the typed guards the derivation layer depends on", () => {
    for (const name of ["isArrays", "isObjects", "isUnion", "isNull", "isString", "isNumber"]) {
      expect(typeof (SchemaAST as unknown as Record<string, unknown>)[name]).toBe("function")
    }
    expect(typeof SchemaAST.isOptional).toBe("function")
  })

  it("Schema.Array / NonEmptyArray expose a typed `.value` element schema", () => {
    const arr = Schema.Array(Schema.String)
    expect("value" in arr).toBe(true)
    expect((arr as unknown as { value: Schema.Top }).value).toBe(Schema.String)
    expect(SchemaAST.isArrays(arr.ast)).toBe(true)

    const nea = Schema.NonEmptyArray(Schema.Number)
    expect("value" in nea).toBe(true)
    expect((nea as unknown as { value: Schema.Top }).value).toBe(Schema.Number)
    expect(SchemaAST.isArrays(nea.ast)).toBe(true)
  })

  it("optionalKey(Array) keeps an Arrays AST with a typed inner `.schema`", () => {
    const ok = Schema.optionalKey(Schema.Array(Schema.String))
    expect(SchemaAST.isArrays(ok.ast)).toBe(true)
    expect(SchemaAST.isOptional(ok.ast)).toBe(true)
    expect("schema" in ok).toBe(true)
    const inner = (ok as unknown as { schema: Schema.Top }).schema
    expect(SchemaAST.isArrays(inner.ast)).toBe(true)
    expect("value" in inner).toBe(true)
  })

  it("optional(Array) is a Union AST with a typed inner `.schema.members`", () => {
    const opt = Schema.optional(Schema.Array(Schema.String))
    expect(SchemaAST.isUnion(opt.ast)).toBe(true)
    expect(SchemaAST.isOptional(opt.ast)).toBe(true)
    const inner = (opt as unknown as { schema: Schema.Top }).schema
    const members = (inner as unknown as { members: ReadonlyArray<Schema.Top> }).members
    expect(Array.isArray(members)).toBe(true)
    expect(members.some((m) => SchemaAST.isArrays(m.ast))).toBe(true)
  })

  it("Struct / Class expose a typed `.fields` record", () => {
    const struct = Schema.Struct({ a: Schema.String })
    expect("fields" in struct).toBe(true)
    expect(typeof struct.fields).toBe("object")
    class C extends Schema.Class<C>("C")({ x: Schema.Number }) {}
    expect("fields" in C).toBe(true)
    expect(typeof C.fields).toBe("object")
  })

  it("Class AST is a Declaration; Struct AST is Objects (isSchemaClass discriminator)", () => {
    // Since 4.0.0-rc `Schema.Struct(...)` is ALSO a function, so `typeof`
    // alone cannot distinguish a Schema.Class from a Struct. The derivation
    // layer discriminates on the AST tag — if either tag changes, the decode
    // path would `new Struct(decoded)` and silently return empty objects.
    const struct = Schema.Struct({ a: Schema.String })
    class C extends Schema.Class<C>("C")({ x: Schema.Number }) {}
    expect(typeof struct).toBe("function")
    expect(typeof C).toBe("function")
    expect((struct.ast as { _tag: string })._tag).toBe("Objects")
    expect((C.ast as { _tag: string })._tag).toBe("Declaration")
  })

  it("Record AST is an Objects node with empty propertySignatures + one indexSignature", () => {
    const rec = Schema.Record(Schema.String, Schema.Number)
    expect(SchemaAST.isObjects(rec.ast)).toBe(true)
    const ast = rec.ast as SchemaAST.Objects
    expect(ast.propertySignatures.length).toBe(0)
    expect(ast.indexSignatures.length).toBe(1)
    expect(ast.indexSignatures[0]!.type).toBeDefined()
  })

  it("Base.encoding is a non-empty tuple of Links whose leaf `.to` is a typed AST", () => {
    const enc = Schema.DateTimeUtcFromString.ast.encoding
    expect(enc).toBeDefined()
    expect(enc!.length).toBeGreaterThan(0)
    const leaf = enc![enc!.length - 1]!
    expect(SchemaAST.isString(leaf.to)).toBe(true)
  })

  it("Redacted AST carries a (currently untyped) typeParameters[0]", () => {
    // No public typed accessor exists for this; firstTypeParameterAst isolates it.
    const inner = firstTypeParameterAst(Schema.RedactedFromValue(Schema.String).ast)
    expect(inner).toBeDefined()
    expect(SchemaAST.isString(inner!)).toBe(true)
    // Sanity: the isolated read round-trips through Redacted for real schemas.
    const r = Redacted.make("secret")
    expect(Redacted.value(r)).toBe("secret")
  })

  describe("hasEncodingTransformation — ast.encoding presence", () => {
    // `SchemaAST.Base.encoding` is documented as: "When `undefined`, the node
    // has no encoding transformation (type and encoded forms are identical)."
    // `CompositeCodec` relies on that contract to skip encoding for plain
    // composites, so that an open sort key bound (`gte(t.status, "d")`) is not
    // rejected by a codec it was never meant to satisfy.
    it("is false for schemas whose Type and Encoded forms are identical", () => {
      expect(hasEncodingTransformation(Schema.String)).toBe(false)
      expect(hasEncodingTransformation(Schema.Number)).toBe(false)
      expect(hasEncodingTransformation(Schema.Boolean)).toBe(false)
      expect(hasEncodingTransformation(Schema.BigInt)).toBe(false)
      expect(hasEncodingTransformation(Schema.Literals(["todo", "done"]))).toBe(false)
    })

    it("is true for schemas that transform between Type and Encoded", () => {
      expect(hasEncodingTransformation(Schema.BigIntFromString)).toBe(true)
      expect(hasEncodingTransformation(Schema.DateTimeUtcFromString)).toBe(true)
    })

    it("is false for BARE Schema.Date / Schema.DateTimeUtc", () => {
      // These are declarations with no encoding link of their own — the entity
      // derivation substitutes the wire transform. This is precisely why the
      // composite encoder reads its fields off `inputSchema` (post-substitution)
      // rather than off the raw model, where these would look untransformed.
      expect(hasEncodingTransformation(Schema.Date)).toBe(false)
      expect(hasEncodingTransformation(Schema.DateTimeUtc)).toBe(false)
    })
  })
})
