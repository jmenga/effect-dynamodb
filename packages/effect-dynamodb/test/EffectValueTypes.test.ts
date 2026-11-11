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
import { DateTime, Effect } from "effect"
import {
  type Cell,
  CODECS,
  cellsOf,
  codecCellsOf,
  KINDS,
  UNTYPED,
  untypedCellsOf,
} from "./helpers/ValueTypeCells.js"

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
    loose: "refused: ValidationError EDD-9161",
    packed: "refused: ValidationError EDD-9161",
    key: '{"S":"s"}',
    keyText: '{"S":"$vt#v1#v#key_s"}',
    aggregateUpdate: "Query",
  },
  Chunk: {
    typed: "definition refused: EDD-9125",
    loose: "refused: ValidationError EDD-9124",
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

/** Whether the installed Effect is 4.1.3 or later: it gives a named zone a `resolvedId`. */
const EFFECT_413 = Object.hasOwn(DateTime.zoneMakeNamedUnsafe("Etc/UTC"), "resolvedId")

/**
 * Effect's own string codecs for a zone and a zoned date, given a zone made fresh on the installed
 * Effect from an alias or a renamed zone. The attribute is the codec's text, which Effect 4.1.3 writes
 * with the name the zone was made from and 4.1.2 with the one `Intl` resolves it to: Effect's, and
 * left as Effect writes it (reads take both). Every key composed from it, the primary sort key, an
 * index's sort key, a unique sentinel and a time-series event's sort key, is the same on both, and a
 * `history().where()` bound on it names the event's key.
 */
const CODEC_TABLE: Readonly<
  Record<string, Readonly<{ typed: { "4.1.2": Cell; "4.1.3": Cell } } & Record<string, unknown>>>
> = {
  "TimeZoneNamedFromString, Etc/UTC": {
    typed: { "4.1.2": '{"S":"UTC"}', "4.1.3": '{"S":"Etc/UTC"}' },
    sk: "$vt#v1#c#k_utc",
    keyText: "$vt#v1#c#k_utc",
    sentinel: "$vt#v1#c.u#utc",
    event: "$vt#v1#s#e#utc",
    historyEq: "1 event",
  },
  "TimeZoneNamedFromString, Asia/Kolkata": {
    typed: { "4.1.2": '{"S":"Asia/Calcutta"}', "4.1.3": '{"S":"Asia/Kolkata"}' },
    sk: "$vt#v1#c#k_asia/calcutta",
    keyText: "$vt#v1#c#k_asia/calcutta",
    sentinel: "$vt#v1#c.u#asia/calcutta",
    event: "$vt#v1#s#e#asia/calcutta",
    historyEq: "1 event",
  },
  "TimeZoneFromString, Etc/UTC": {
    typed: { "4.1.2": '{"S":"UTC"}', "4.1.3": '{"S":"Etc/UTC"}' },
    sk: "$vt#v1#c#k_utc",
    keyText: "$vt#v1#c#k_utc",
    sentinel: "$vt#v1#c.u#utc",
    event: "$vt#v1#s#e#utc",
    historyEq: "1 event",
  },
  "TimeZoneFromString, Asia/Kolkata": {
    typed: { "4.1.2": '{"S":"Asia/Calcutta"}', "4.1.3": '{"S":"Asia/Kolkata"}' },
    sk: "$vt#v1#c#k_asia/calcutta",
    keyText: "$vt#v1#c#k_asia/calcutta",
    sentinel: "$vt#v1#c.u#asia/calcutta",
    event: "$vt#v1#s#e#asia/calcutta",
    historyEq: "1 event",
  },
  "DateTimeZonedFromString, Etc/UTC": {
    typed: {
      "4.1.2": '{"S":"1970-01-01T00:00:00.000+00:00[UTC]"}',
      "4.1.3": '{"S":"1970-01-01T00:00:00.000+00:00[Etc/UTC]"}',
    },
    sk: "$vt#v1#c#k_1970-01-01t00:00:00.000+00:00[utc]",
    keyText: "$vt#v1#c#k_1970-01-01t00:00:00.000+00:00[utc]",
    sentinel: "$vt#v1#c.u#1970-01-01t00:00:00.000+00:00[utc]",
    event: "$vt#v1#s#e#1970-01-01t00:00:00.000+00:00[utc]",
    historyEq: "1 event",
  },
  "DateTimeZonedFromString, Asia/Kolkata": {
    typed: {
      "4.1.2": '{"S":"1970-01-01T05:30:00.000+05:30[Asia/Calcutta]"}',
      "4.1.3": '{"S":"1970-01-01T05:30:00.000+05:30[Asia/Kolkata]"}',
    },
    sk: "$vt#v1#c#k_1970-01-01t05:30:00.000+05:30[asia/calcutta]",
    keyText: "$vt#v1#c#k_1970-01-01t05:30:00.000+05:30[asia/calcutta]",
    sentinel: "$vt#v1#c.u#1970-01-01t05:30:00.000+05:30[asia/calcutta]",
    event: "$vt#v1#s#e#1970-01-01t05:30:00.000+05:30[asia/calcutta]",
    historyEq: "1 event",
  },
}

describe("Effect's zone string codecs, given an alias zone, on every Effect version", () => {
  it("covers every codec and zone", () => {
    expect(Object.keys(CODEC_TABLE)).toEqual(Object.keys(CODECS))
  })
  for (const name of Object.keys(CODECS)) {
    it.effect(name, () =>
      Effect.gen(function* () {
        const { typed, ...keys } = CODEC_TABLE[name]!
        expect(yield* codecCellsOf(name)).toEqual({
          typed: typed[EFFECT_413 ? "4.1.3" : "4.1.2"],
          ...keys,
        })
      }),
    )
  }
})

/**
 * Every Effect collection and data type handed to a field no schema types (`Schema.Unknown`), stored
 * natively and packed, on every Effect version: each is refused with a `ValidationError`, or stored
 * whole and read back. A read of an untyped field hands back the map stored, the value's every
 * enumerable property, which is all it holds once nothing in it is lost (`EDD-9161`): written again,
 * it stores the same bytes. An instance comes back only where a schema declares it. None dies or
 * overflows: a `Chunk`, whose empty end holds itself, was a stack overflow natively and is the
 * `EDD-9124` refusal a `HashSet` gets. Effect 4.1 has no `List`, `SortedSet`, `SortedMap` or
 * `Either`.
 */
const UNTYPED_TABLE: Readonly<Record<string, Readonly<Record<string, Cell>>>> = {
  Chunk: {
    loose: "refused: ValidationError EDD-9124",
    packed: "refused: ValidationError",
  },
  "Chunk, empty": {
    loose: "refused: ValidationError EDD-9124",
    packed: "refused: ValidationError",
  },
  HashSet: {
    loose: "refused: ValidationError EDD-9124",
    packed: "refused: ValidationError",
  },
  HashMap: {
    loose: "refused: ValidationError EDD-9124",
    packed: "refused: ValidationError",
  },
  "MutableHashMap, string keys": {
    loose:
      '{"M":{"backing":{"M":{"a":{"N":"1"}}},"buckets":{"M":{}},"~effect/MutableHashMap":{"S":"~effect/MutableHashMap"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  "MutableHashMap, an object key": {
    loose: "refused: ValidationError EDD-9161",
    packed: "refused: ValidationError",
  },
  "MutableHashSet, numbers": {
    loose: "refused: ValidationError EDD-9161",
    packed: "refused: ValidationError",
  },
  "MutableHashSet, strings": {
    loose:
      '{"M":{"keyMap":{"M":{"backing":{"M":{"a":{"BOOL":true}}},"buckets":{"M":{}},"~effect/MutableHashMap":{"S":"~effect/MutableHashMap"}}},"~effect/MutableHashSet":{"S":"~effect/MutableHashSet"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  MutableList: {
    loose:
      '{"M":{"head":{"M":{"array":{"L":[{"N":"1"}]},"mutable":{"BOOL":true},"offset":{"N":"0"}}},"tail":{"M":{"array":{"L":[{"N":"1"}]},"mutable":{"BOOL":true},"offset":{"N":"0"}}},"length":{"N":"1"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed:
      '{"S":"{\\"head\\":{\\"array\\":[1],\\"mutable\\":true,\\"offset\\":0},\\"tail\\":{\\"array\\":[1],\\"mutable\\":true,\\"offset\\":0},\\"length\\":1}"}',
    packedRead: "the map stored, writing the same bytes",
  },
  MutableRef: {
    loose: '{"M":{"current":{"N":"1"},"~effect/MutableRef":{"S":"~effect/MutableRef"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  Trie: {
    loose:
      '{"M":{"_root":{"M":{"key":{"S":"a"},"count":{"N":"1"},"value":{"M":{"value":{"N":"1"}}}}},"_count":{"N":"1"},"~effect/Trie":{"M":{}}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  Graph: {
    loose: "refused: ValidationError EDD-9161",
    packed: "refused: ValidationError",
  },
  "Option some": {
    loose:
      '{"M":{"value":{"N":"1"},"_tag":{"S":"Some"},"_op":{"S":"Some"},"~effect/Option":{"M":{}}}}',
    looseRead: "the map stored, writing the same bytes",
    packed:
      '{"S":"{\\"_op\\":\\"Some\\",\\"~effect/Option\\":{},\\"value\\":1,\\"_tag\\":\\"Some\\"}"}',
    packedRead: "the map stored, writing the same bytes",
  },
  "Option none": {
    loose: '{"M":{"_tag":{"S":"None"},"_op":{"S":"None"},"~effect/Option":{"M":{}}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: '{"S":"{\\"_op\\":\\"None\\",\\"~effect/Option\\":{},\\"_tag\\":\\"None\\"}"}',
    packedRead: "the map stored, writing the same bytes",
  },
  "Result success": {
    loose:
      '{"M":{"success":{"N":"1"},"_tag":{"S":"Success"},"_op":{"S":"Success"},"~effect/Result":{"M":{}}}}',
    looseRead: "the map stored, writing the same bytes",
    packed:
      '{"S":"{\\"_op\\":\\"Success\\",\\"success\\":1,\\"_tag\\":\\"Success\\",\\"~effect/Result\\":{}}"}',
    packedRead: "the map stored, writing the same bytes",
  },
  "Result failure": {
    loose:
      '{"M":{"failure":{"S":"e"},"_tag":{"S":"Failure"},"_op":{"S":"Failure"},"~effect/Result":{"M":{}}}}',
    looseRead: "the map stored, writing the same bytes",
    packed:
      '{"S":"{\\"_op\\":\\"Failure\\",\\"failure\\":\\"e\\",\\"_tag\\":\\"Failure\\",\\"~effect/Result\\":{}}"}',
    packedRead: "the map stored, writing the same bytes",
  },
  "Exit success": {
    loose:
      '{"M":{"~effect/Effect/args":{"N":"1"},"~effect/Exit":{"S":"~effect/Exit"},"_tag":{"S":"Success"},"value":{"N":"1"},"~effect/Effect":{"M":{}},"~effect/Effect/identifier":{"S":"Success"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  "Exit failure": {
    loose:
      '{"M":{"~effect/Effect/args":{"M":{"~effect/Cause":{"S":"~effect/Cause"},"reasons":{"L":[{"M":{"~effect/Cause/Reason":{"S":"~effect/Cause/Reason"},"annotations":{"M":{}},"_tag":{"S":"Fail"},"error":{"S":"e"}}}]}}},"~effect/Exit":{"S":"~effect/Exit"},"_tag":{"S":"Failure"},"cause":{"M":{"~effect/Cause":{"S":"~effect/Cause"},"reasons":{"L":[{"M":{"~effect/Cause/Reason":{"S":"~effect/Cause/Reason"},"annotations":{"M":{}},"_tag":{"S":"Fail"},"error":{"S":"e"}}}]}}},"~effect/Effect":{"M":{}},"~effect/Effect/identifier":{"S":"Failure"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  "Exit, dying of an Error": {
    loose: "refused: ValidationError EDD-9161",
    packed: "refused: ValidationError",
  },
  "Cause, a failure": {
    loose:
      '{"M":{"~effect/Cause":{"S":"~effect/Cause"},"reasons":{"L":[{"M":{"~effect/Cause/Reason":{"S":"~effect/Cause/Reason"},"annotations":{"M":{}},"_tag":{"S":"Fail"},"error":{"S":"e"}}}]}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  "Cause, dying of an Error": {
    loose: "refused: ValidationError EDD-9161",
    packed: "refused: ValidationError",
  },
  Duration: {
    loose:
      '{"M":{"value":{"M":{"_tag":{"S":"Millis"},"millis":{"N":"1500"}}},"~effect/Duration":{"S":"~effect/Duration"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed:
      '{"S":"{\\"~effect/Duration\\":\\"~effect/Duration\\",\\"value\\":{\\"millis\\":1500,\\"_tag\\":\\"Millis\\"}}"}',
    packedRead: "the map stored, writing the same bytes",
  },
  BigDecimal: {
    loose:
      '{"M":{"value":{"N":"15"},"scale":{"N":"1"},"~effect/BigDecimal":{"S":"~effect/BigDecimal"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed:
      '{"S":"{\\"value\\":15,\\"scale\\":1,\\"~effect/BigDecimal\\":\\"~effect/BigDecimal\\"}"}',
    packedRead: "the map stored, writing the same bytes",
  },
  DateTimeUtc: {
    loose:
      '{"M":{"epochMilliseconds":{"N":"0"},"~effect/DateTime":{"S":"~effect/DateTime"},"_tag":{"S":"Utc"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed:
      '{"S":"{\\"epochMilliseconds\\":0,\\"~effect/DateTime\\":\\"~effect/DateTime\\",\\"_tag\\":\\"Utc\\"}"}',
    packedRead: "the map stored, writing the same bytes",
  },
  "DateTimeZoned named": {
    loose:
      '{"M":{"epochMilliseconds":{"N":"0"},"zone":{"M":{"id":{"S":"Europe/London"},"format":{"M":{}},"~effect/DateTime/TimeZone":{"S":"~effect/DateTime/TimeZone"},"_tag":{"S":"Named"}}},"~effect/DateTime":{"S":"~effect/DateTime"},"_tag":{"S":"Zoned"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed:
      '{"S":"{\\"~effect/DateTime\\":\\"~effect/DateTime\\",\\"epochMilliseconds\\":0,\\"zone\\":{\\"format\\":{},\\"id\\":\\"Europe/London\\",\\"~effect/DateTime/TimeZone\\":\\"~effect/DateTime/TimeZone\\",\\"_tag\\":\\"Named\\"},\\"_tag\\":\\"Zoned\\"}"}',
    packedRead: "the map stored, writing the same bytes",
  },
  Redacted: {
    loose: "refused: ValidationError EDD-9161",
    packed: "refused: ValidationError EDD-9161",
  },
  "Data class": {
    loose: '{"M":{"x":{"N":"1"},"y":{"N":"2"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  "Data tagged class": {
    loose: '{"M":{"by":{"N":"1"},"_tag":{"S":"Moved"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  "Data tagged error": {
    loose:
      '{"M":{"code":{"N":"1"},"_tag":{"S":"Failed"},"name":{"S":"Failed"},"~effect/Effect":{"M":{}},"~effect/Effect/identifier":{"S":"YieldableError"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
  "Schema class": {
    loose: '{"M":{"name":{"S":"a"}}}',
    looseRead: "the map stored, writing the same bytes",
    packed: "refused: ValidationError",
  },
}

describe("each Effect type in an untyped field, natively and packed, on every Effect version", () => {
  it("covers every type", () => {
    expect(Object.keys(UNTYPED_TABLE)).toEqual(Object.keys(UNTYPED))
  })
  for (const name of Object.keys(UNTYPED)) {
    it.effect(name, () =>
      Effect.gen(function* () {
        expect(yield* untypedCellsOf(name)).toEqual(UNTYPED_TABLE[name])
      }),
    )
  }
})
