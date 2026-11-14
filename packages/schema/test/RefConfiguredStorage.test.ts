/**
 * What a ref holds a field in where its entity's `DynamoModel.configure` stores the field as epoch
 * seconds (`DeepSubstitutionOptions.configuredStorage`): a write stores the configured form, and a
 * read takes it and the ISO text the field's own storage writes, which a copy holds where a path
 * write put it there up to 1.41.0, each as the date it is. Through each wrapper `configure` reaches.
 */

import { describe, expect, it } from "@effect/vitest"
import { DateTime, Exit, Schema } from "effect"
import { substituteSchemaDeep } from "../src/internal/EntitySchemas.js"

const epochSeconds = { storage: "epochSeconds", domain: "DateTime.Utc" } as const
const ISO = "2024-01-02T03:04:05.000Z"
const DATE = DateTime.makeUnsafe(ISO)
const SECONDS = Math.floor(DateTime.toEpochMillis(DATE) / 1000)

const FIELDS = {
  plain: Schema.DateTimeUtc,
  optionalKey: Schema.optionalKey(Schema.DateTimeUtc),
  nullOr: Schema.NullOr(Schema.DateTimeUtc),
  undefinedOr: Schema.UndefinedOr(Schema.DateTimeUtc),
  optionalNullOr: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),
  stringFirst: Schema.Union([Schema.String, Schema.DateTimeUtc]),
  dateFirst: Schema.Union([Schema.DateTimeUtc, Schema.String]),
} as const

const derived = (field: Schema.Top, options: object) =>
  substituteSchemaDeep(Schema.Struct({ f: field }), {
    ...options,
    configuredStorage: { f: epochSeconds },
  }) as unknown as Schema.Codec<{ readonly f?: unknown }, unknown>
const read = (field: Schema.Top) => derived(field, { legacyReads: true, absentReads: true })
const write = (field: Schema.Top) => derived(field, { enforceChecks: true })
const decoded = (field: Schema.Top, stored: unknown) => {
  const exit = Schema.decodeUnknownExit(read(field))({ f: stored })
  return Exit.isSuccess(exit) ? exit.value.f : exit
}

describe("a ref field its entity's configure stores as epoch seconds", () => {
  for (const [name, field] of Object.entries(FIELDS)) {
    it(`${name}: is written as seconds, and read from seconds or ISO text`, () => {
      expect(Schema.encodeUnknownSync(write(field))({ f: DATE })).toEqual({ f: SECONDS })
      expect(DateTime.isDateTime(decoded(field, SECONDS))).toBe(true)
      expect(DateTime.formatIso(decoded(field, SECONDS) as DateTime.Utc)).toBe(ISO)
      expect(DateTime.formatIso(decoded(field, ISO) as DateTime.Utc)).toBe(ISO)
    })
  }

  it("leaves what isn't a date to the members that take it", () => {
    expect(decoded(FIELDS.nullOr, null)).toBeNull()
    expect(decoded(FIELDS.stringFirst, "hello")).toBe("hello")
    expect(decoded(FIELDS.dateFirst, "hello")).toBe("hello")
  })
})
