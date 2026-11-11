/**
 * Each of Effect's value types in each position the library stores or compares one, on Effect 4.1.2 and
 * 4.1.3 alike (#242): what encoding a typed field stores natively, what an untyped field stores, what
 * a packed field stores, the key text an index composes, and what an aggregate update setting an equal
 * value sends. 4.1.3 changed only a named zone, which the library stores as 4.1.2 held it; every other
 * value type is stored by modules 4.1.3 left as they were. Measured on both versions and asserted
 * literally, so a later Effect that stores any of them differently fails here. A zone "as 4.1.3 makes
 * it" is built on the installed Effect's own prototype, so it is one on either version.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { type Cell, cellsOf, KINDS } from "./helpers/ValueTypeCells.js"

const TABLE: Readonly<Record<string, Readonly<Record<string, Cell>>>> = {
  DateTimeUtc: {
    typed: '{"S":"1970-01-01T00:00:00.000Z"}',
    loose:
      '{"M":{"epochMilliseconds":{"N":"0"},"~effect/DateTime":{"S":"~effect/DateTime"},"_tag":{"S":"Utc"}}}',
    packed:
      '{"S":"{\\"epochMilliseconds\\":0,\\"~effect/DateTime\\":\\"~effect/DateTime\\",\\"_tag\\":\\"Utc\\"}"}',
    key: '{"S":"1970-01-01T00:00:00.000Z"}',
    keyText: '{"S":"$vt#v1#v#key_1970-01-01t00:00:00.000z"}',
    aggregateUpdate: "Query",
  },
  "DateTimeZoned named": {
    typed: '{"S":"1970-01-01T01:00:00.000+01:00[Europe/London]"}',
    loose:
      '{"M":{"epochMilliseconds":{"N":"0"},"zone":{"M":{"id":{"S":"Europe/London"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}},"~effect/DateTime":{"S":"~effect/DateTime"},"_tag":{"S":"Zoned"}}}',
    packed:
      '{"S":"{\\"~effect/DateTime\\":\\"~effect/DateTime\\",\\"epochMilliseconds\\":0,\\"zone\\":{\\"format\\":{},\\"id\\":\\"Europe/London\\",\\"~effect/DateTime/TimeZone\\":\\"~effect/DateTime/TimeZone\\",\\"_tag\\":\\"Named\\"},\\"_tag\\":\\"Zoned\\"}"}',
    key: '{"S":"1970-01-01T01:00:00.000+01:00[Europe/London]"}',
    keyText: '{"S":"$vt#v1#v#key_1970-01-01t01:00:00.000+01:00[europe/london]"}',
    aggregateUpdate: "Query",
  },
  "DateTimeZoned named, made from an alias on 4.1.3": {
    typed: '{"S":"1970-01-01T00:00:00.000+00:00[UTC]"}',
    loose:
      '{"M":{"epochMilliseconds":{"N":"0"},"zone":{"M":{"id":{"S":"UTC"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}},"~effect/DateTime":{"S":"~effect/DateTime"},"_tag":{"S":"Zoned"}}}',
    packed:
      '{"S":"{\\"~effect/DateTime\\":\\"~effect/DateTime\\",\\"epochMilliseconds\\":0,\\"zone\\":{\\"format\\":{},\\"id\\":\\"UTC\\",\\"~effect/DateTime/TimeZone\\":\\"~effect/DateTime/TimeZone\\",\\"_tag\\":\\"Named\\"},\\"_tag\\":\\"Zoned\\"}"}',
    key: '{"S":"1970-01-01T00:00:00.000+00:00[UTC]"}',
    keyText: '{"S":"$vt#v1#v#key_1970-01-01t00:00:00.000+00:00[utc]"}',
    aggregateUpdate: "Query",
  },
  "DateTimeZoned offset": {
    typed: '{"S":"1970-01-01T01:00:00.000+01:00"}',
    loose:
      '{"M":{"epochMilliseconds":{"N":"0"},"zone":{"M":{"offset":{"N":"3600000"},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Offset"}}},"~effect/DateTime":{"S":"~effect/DateTime"},"_tag":{"S":"Zoned"}}}',
    packed:
      '{"S":"{\\"~effect/DateTime\\":\\"~effect/DateTime\\",\\"epochMilliseconds\\":0,\\"zone\\":{\\"offset\\":3600000,\\"~effect/DateTime/TimeZone\\":\\"~effect/DateTime/TimeZone\\",\\"_tag\\":\\"Offset\\"},\\"_tag\\":\\"Zoned\\"}"}',
    key: '{"S":"1970-01-01T01:00:00.000+01:00"}',
    keyText: '{"S":"$vt#v1#v#key_1970-01-01t01:00:00.000+01:00"}',
    aggregateUpdate: "Query",
  },
  "TimeZone named": {
    typed:
      '{"M":{"id":{"S":"Europe/London"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}}',
    loose:
      '{"M":{"id":{"S":"Europe/London"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}}',
    packed:
      '{"S":"{\\"format\\":{},\\"id\\":\\"Europe/London\\",\\"~effect/DateTime/TimeZone\\":\\"~effect/DateTime/TimeZone\\",\\"_tag\\":\\"Named\\"}"}',
    key: '{"M":{"id":{"S":"Europe/London"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}}',
    keyText: '{"S":"$vt#v1#v#key_timezone.named(europe/london)"}',
    aggregateUpdate: "Query",
  },
  "TimeZone named, as 4.1.3 makes it": {
    typed:
      '{"M":{"id":{"S":"Europe/London"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}}',
    loose:
      '{"M":{"id":{"S":"Europe/London"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}}',
    packed:
      '{"S":"{\\"format\\":{},\\"id\\":\\"Europe/London\\",\\"~effect/DateTime/TimeZone\\":\\"~effect/DateTime/TimeZone\\",\\"_tag\\":\\"Named\\"}"}',
    key: '{"M":{"id":{"S":"Europe/London"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}}',
    keyText: '{"S":"$vt#v1#v#key_timezone.named(europe/london)"}',
    aggregateUpdate: "Query",
  },
  "TimeZone named, made from an alias on 4.1.3": {
    typed:
      '{"M":{"id":{"S":"UTC"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}}',
    loose:
      '{"M":{"id":{"S":"UTC"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}}',
    packed:
      '{"S":"{\\"format\\":{},\\"id\\":\\"UTC\\",\\"~effect/DateTime/TimeZone\\":\\"~effect/DateTime/TimeZone\\",\\"_tag\\":\\"Named\\"}"}',
    key: '{"M":{"id":{"S":"UTC"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}}',
    keyText: '{"S":"$vt#v1#v#key_timezone.named(utc)"}',
    aggregateUpdate: "Query",
  },
  "TimeZone offset": {
    typed:
      '{"M":{"offset":{"N":"3600000"},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Offset"}}}',
    loose:
      '{"M":{"offset":{"N":"3600000"},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Offset"}}}',
    packed:
      '{"S":"{\\"offset\\":3600000,\\"~effect/DateTime/TimeZone\\":\\"~effect/DateTime/TimeZone\\",\\"_tag\\":\\"Offset\\"}"}',
    key: '{"M":{"offset":{"N":"3600000"},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Offset"}}}',
    keyText: '{"S":"$vt#v1#v#key_timezone.offset(+01:00)"}',
    aggregateUpdate: "Query",
  },
  Duration: {
    typed:
      '{"M":{"value":{"M":{"_tag":{"S":"Millis"},"millis":{"N":"1500"}}},"~effect/Duration":{"S":"~effect/Duration"}}}',
    loose:
      '{"M":{"value":{"M":{"_tag":{"S":"Millis"},"millis":{"N":"1500"}}},"~effect/Duration":{"S":"~effect/Duration"}}}',
    packed:
      '{"S":"{\\"~effect/Duration\\":\\"~effect/Duration\\",\\"value\\":{\\"millis\\":1500,\\"_tag\\":\\"Millis\\"}}"}',
    key: '{"M":{"value":{"M":{"_tag":{"S":"Millis"},"millis":{"N":"1500"}}},"~effect/Duration":{"S":"~effect/Duration"}}}',
    keyText: '{"S":"$vt#v1#v#key_1500 millis"}',
    aggregateUpdate: "Query",
  },
  BigDecimal: {
    typed:
      '{"M":{"value":{"N":"150"},"scale":{"N":"2"},"~effect/BigDecimal":{"S":"~effect/BigDecimal"}}}',
    loose:
      '{"M":{"value":{"N":"150"},"scale":{"N":"2"},"~effect/BigDecimal":{"S":"~effect/BigDecimal"}}}',
    packed:
      '{"S":"{\\"value\\":150,\\"scale\\":2,\\"~effect/BigDecimal\\":\\"~effect/BigDecimal\\"}"}',
    key: '{"M":{"value":{"N":"150"},"scale":{"N":"2"},"~effect/BigDecimal":{"S":"~effect/BigDecimal"}}}',
    keyText: '{"S":"$vt#v1#v#key_bigdecimal(1.5)"}',
    aggregateUpdate: "Query",
  },
  "Option some": {
    typed:
      '{"M":{"value":{"N":"1"},"_tag":{"S":"Some"},"_op":{"S":"Some"},"~effect/Option":{"M":{}}}}',
    loose:
      '{"M":{"value":{"N":"1"},"_tag":{"S":"Some"},"_op":{"S":"Some"},"~effect/Option":{"M":{}}}}',
    packed:
      '{"S":"{\\"_op\\":\\"Some\\",\\"~effect/Option\\":{},\\"value\\":1,\\"_tag\\":\\"Some\\"}"}',
    key: '{"M":{"value":{"N":"1"},"_tag":{"S":"Some"},"_op":{"S":"Some"},"~effect/Option":{"M":{}}}}',
    keyText: '{"S":"$vt#v1#v#key_some(1)"}',
    aggregateUpdate: "Query",
  },
  "Option none": {
    typed: '{"M":{"_tag":{"S":"None"},"_op":{"S":"None"},"~effect/Option":{"M":{}}}}',
    loose: '{"M":{"_tag":{"S":"None"},"_op":{"S":"None"},"~effect/Option":{"M":{}}}}',
    packed: '{"S":"{\\"_op\\":\\"None\\",\\"~effect/Option\\":{},\\"_tag\\":\\"None\\"}"}',
    key: '{"M":{"_tag":{"S":"None"},"_op":{"S":"None"},"~effect/Option":{"M":{}}}}',
    keyText: '{"S":"$vt#v1#v#key_none()"}',
    aggregateUpdate: "Query",
  },
  Redacted: {
    typed: '{"S":"s"}',
    loose: '{"M":{"~effect/Redacted":{"M":{}}}}',
    packed: "refused: ValidationError",
    key: '{"S":"s"}',
    keyText: '{"S":"$vt#v1#v#key_s"}',
    aggregateUpdate: "Query",
  },
  Chunk: {
    typed: "definition refused: EDD-9125",
    loose: "refused: defect",
    packed: "refused: ValidationError",
    key: "definition refused: EDD-9125",
    keyText: "definition refused: EDD-9125",
    aggregateUpdate: "definition refused: EDD-9125",
  },
  HashSet: {
    typed: "refused: ValidationError EDD-9124",
    loose: "refused: ValidationError EDD-9124",
    packed: "refused: ValidationError",
    key: "refused: ValidationError EDD-9124",
    keyText: "refused: ValidationError EDD-9124",
    aggregateUpdate: "create refused: ValidationError EDD-9124",
  },
  HashMap: {
    typed: "definition refused: EDD-9125",
    loose: "refused: ValidationError EDD-9124",
    packed: "refused: ValidationError",
    key: "definition refused: EDD-9125",
    keyText: "definition refused: EDD-9125",
    aggregateUpdate: "definition refused: EDD-9125",
  },
  "Data class": {
    typed: '{"M":{"x":{"N":"1"},"y":{"N":"2"}}}',
    loose: '{"M":{"x":{"N":"1"},"y":{"N":"2"}}}',
    packed: "refused: ValidationError",
    key: '{"M":{"x":{"N":"1"},"y":{"N":"2"}}}',
    keyText: '{"S":"$vt#v1#v#key_[object object]"}',
    aggregateUpdate: "Query",
  },
  "Data tagged class": {
    typed: '{"M":{"by":{"N":"1"},"_tag":{"S":"Moved"}}}',
    loose: '{"M":{"by":{"N":"1"},"_tag":{"S":"Moved"}}}',
    packed: "refused: ValidationError",
    key: '{"M":{"by":{"N":"1"},"_tag":{"S":"Moved"}}}',
    keyText: '{"S":"$vt#v1#v#key_[object object]"}',
    aggregateUpdate: "Query",
  },
}

describe("each value type, in each position, on every Effect version", () => {
  it("covers every kind", () => {
    expect(Object.keys(TABLE)).toEqual(Object.keys(KINDS))
  })
  for (const name of Object.keys(KINDS)) {
    it.effect(name, () =>
      Effect.gen(function* () {
        expect(yield* cellsOf(name)).toEqual(TABLE[name])
      }),
    )
  }
})
