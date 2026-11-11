/**
 * `Aggregate.list`'s cursor (#197) uses the codec `Query` uses (`internal/Cursor`): a key `btoa`
 * can carry keeps the bytes it always had, any other key gets a `v2.` cursor, and a cursor that
 * can't be decoded is `[EDD-9094]` on the error channel, with nothing sent.
 */

import type { AttributeValue, QueryCommandInput } from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Option, Schema } from "effect"
import * as Aggregate from "../src/Aggregate.js"
import * as Entity from "../src/Entity.js"
import * as Cursor from "../src/internal/Cursor.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import { makeListings, STORE } from "./helpers/ListingsFixture.js"
import { mockDynamoClientLayer, mockOutput } from "./helpers/MockDynamoClient.js"
import { makePartition, type PartitionOptions, type Row } from "./helpers/PartitionMock.js"

const AppSchema = DynamoSchema.make({ name: "cursorapp", version: 1 })

class Match extends Schema.Class<Match>("Match")({
  matchId: Schema.String,
  tournament: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["open", "done"]),
}) {}

class Anchor extends Schema.Class<Anchor>("Anchor")({ anchorId: Schema.String }) {}

const Anchors = Entity.make({
  model: Anchor,
  entityType: "Anchor",
  primaryKey: { pk: { field: "pk", composite: ["anchorId"] }, sk: { field: "sk", composite: [] } },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Anchors } })

const makeMatches = (cardinality?: number) =>
  Aggregate.make(Match, {
    table: MainTable,
    schema: AppSchema,
    pk: { field: "pk", composite: ["matchId"] },
    collection: { name: "match" },
    list: {
      index: "gsi1",
      name: "matchlist",
      pk: { field: "gsi1pk", composite: ["tournament"] },
      sk: { field: "gsi1sk", composite: ["name"] },
      ...(cardinality === undefined ? {} : { cardinality }),
    },
    root: { entityType: "MatchItem" },
    edges: {},
  })

const Matches = makeMatches()
const ShardedMatches = makeMatches(3)

type Fields = {
  readonly matchId: string
  readonly name: string
  readonly status?: "open" | "done"
  readonly tournament?: string
}

/** A root item as the list index holds it. */
const rowOf = ({ matchId, name, status = "open", tournament = "t1" }: Fields): Row =>
  toAttributeMap({
    pk: `$cursorapp#v1#match#${matchId.toLowerCase()}`,
    sk: "$cursorapp#v1#matchitem",
    gsi1pk: `$cursorapp#v1#matchlist#${tournament.toLowerCase()}`,
    gsi1sk: `$cursorapp#v1#matchlist#${name.toLowerCase()}`,
    __edd_e__: "MatchItem",
    matchId,
    tournament,
    name,
    status,
  })

const KEY_FIELDS = ["gsi1pk", "gsi1sk", "pk", "sk"] as const

/** What a key rebuilt with no `LastEvaluatedKey` to copy names, in that order. */
const REBUILT_KEY_FIELDS = ["pk", "sk", "gsi1pk", "gsi1sk"] as const

/** A row's `LastEvaluatedKey`, its attributes in `fields` order. */
const keyOf = (fields: Fields, order: ReadonlyArray<string> = KEY_FIELDS) => {
  const row = rowOf(fields)
  return Object.fromEntries(order.map((name) => [name, row[name]!]))
}

/**
 * The list index served as DynamoDB serves it (`PartitionMock`, its filter evaluated), with each
 * aggregate's assembly read answered from the same rows.
 */
const serve = (
  matches: ReadonlyArray<Fields>,
  options: Partial<PartitionOptions> = {},
): {
  readonly list: () => ReadonlyArray<QueryCommandInput>
  readonly requests: () => number
  readonly layer: Layer.Layer<any>
} => {
  const rows = matches.map(rowOf)
  const partition = makePartition({
    rows,
    pkField: "gsi1pk",
    skField: "gsi1sk",
    keyFields: KEY_FIELDS,
    evaluateFilter: true,
    ...options,
  })
  let requests = 0
  const client = mockDynamoClientLayer({
    query: (input) => {
      requests++
      return input.IndexName === "gsi1"
        ? partition.query(input)
        : Effect.succeed(
            mockOutput({
              Items: rows.filter(
                (row) => row.pk?.S === input.ExpressionAttributeValues?.[":pk"]?.S,
              ),
            }),
          )
    },
  })
  return {
    list: () => partition.inputs as ReadonlyArray<QueryCommandInput>,
    requests: () => requests,
    layer: Layer.merge(client, MainTable.layer({ name: "test-table" })),
  }
}

/** A list index whose first page ends on `lastKey`, whatever that holds, and whose next is empty. */
const serveLastKey = (lastKey: Record<string, AttributeValue>) => {
  const inputs: Array<QueryCommandInput> = []
  const row = rowOf({ matchId: "m1", name: "Alpha" })
  const layer = Layer.merge(
    mockDynamoClientLayer({
      query: (input) => {
        if (input.IndexName === "gsi1") inputs.push(input)
        return Effect.succeed(
          mockOutput(
            input.IndexName === "gsi1" && inputs.length === 1
              ? { Items: [row], LastEvaluatedKey: lastKey }
              : { Items: input.IndexName === "gsi1" ? [] : [row] },
          ),
        )
      },
    }),
    MainTable.layer({ name: "test-table" }),
  )
  return { inputs, layer }
}

/** Every page of a list: what it returned, and each cursor it handed back. */
const walk = (options: Aggregate.ListOptions<Match>, tournament = "t1") =>
  Effect.gen(function* () {
    const ids: Array<string> = []
    const cursors: Array<string> = []
    let cursor: string | undefined
    for (let page = 0; page < 30; page++) {
      const result: Aggregate.ListResult<Match> = yield* Matches.list(
        { tournament },
        cursor === undefined ? options : { ...options, cursor },
      )
      ids.push(...result.data.map((match) => match.matchId))
      if (Option.isNone(result.cursor)) return { cursors, ids }
      cursor = result.cursor.value
      cursors.push(cursor)
    }
    return yield* Effect.die("the list never ended")
  })

/** A `v2.` cursor around `text`, which needn't be an envelope. */
const v2Of = (text: string) => `v2.${Cursor.toBase64Url(new TextEncoder().encode(text))}`

const V2_CURSOR = /^v2\.[A-Za-z0-9_-]+$/

type Page = { readonly cursor: Option.Option<string> }

const THREE: ReadonlyArray<Fields> = [
  { matchId: "m1", name: "Alpha" },
  { matchId: "m2", name: "Men\u2019s Final" },
  { matchId: "m3", name: "Zulu" },
]

/** Open rows between the done ones, so that a filter over-reads. */
const FILTERED: ReadonlyArray<Fields> = [
  { matchId: "m1", name: "Alpha" },
  { matchId: "m2", name: "Men\u2019s Final", status: "done" },
  { matchId: "m3", name: "Mixed" },
  { matchId: "m4", name: "Women\u2019s Final", status: "done" },
  { matchId: "m5", name: "Zulu", status: "done" },
]

describe("Aggregate.list cursor (#197)", () => {
  describe("text a legacy cursor can't carry", () => {
    it.effect("a last key holding U+2019 pages through to the end", () => {
      const { layer, list } = serve(THREE)
      return Effect.gen(function* () {
        const { cursors, ids } = yield* walk({ limit: 1 })

        expect(ids).toEqual(["m1", "m2", "m3"])
        expect(cursors[1]).toMatch(V2_CURSOR)
        // The next request starts exactly where the page with U+2019 ended.
        expect(list()[2]?.ExclusiveStartKey).toEqual(keyOf(THREE[1]!))
      }).pipe(Effect.provide(layer))
    })

    it.effect("its cursor is the one the Query codec writes for that key", () => {
      const { layer } = serve(THREE)
      return Effect.gen(function* () {
        const { cursors } = yield* walk({ limit: 1 })

        expect(cursors[1]).toBe(Cursor.encodeKeyCursor(keyOf(THREE[1]!)))
        expect(Cursor.decode(cursors[1]!)).toEqual({ v: 2, k: keyOf(THREE[1]!) })
      }).pipe(Effect.provide(layer))
    })

    for (const [label, text] of [
      ["U+0101, which default casing makes of U+0100", "\u0101"],
      ["U+2019", "\u2019"],
      ["U+FFFD", "\uFFFD"],
      ["U+1F3CF, outside the BMP", "\u{1F3CF}"],
    ] as const) {
      const name = `b${text}`

      it.effect(`${label} in the list sort key`, () => {
        const matches = [
          { matchId: "m1", name: "a" },
          { matchId: "m2", name },
          { matchId: "m3", name: "c" },
        ]
        const { layer, list } = serve(matches)
        return Effect.gen(function* () {
          const { cursors, ids } = yield* walk({ limit: 1 })

          expect(ids).toEqual(["m1", "m2", "m3"])
          expect(cursors[1]).toMatch(V2_CURSOR)
          expect(list()[2]?.ExclusiveStartKey).toEqual(keyOf(matches[1]!))
        }).pipe(Effect.provide(layer))
      })

      it.effect(`${label} in the table key`, () => {
        const matches = [
          { matchId: "m1", name: "a" },
          { matchId: name, name: "b" },
          { matchId: "m3", name: "c" },
        ]
        const { layer, list } = serve(matches)
        return Effect.gen(function* () {
          const { cursors, ids } = yield* walk({ limit: 1 })

          expect(ids).toEqual(["m1", name, "m3"])
          expect(cursors[1]).toMatch(V2_CURSOR)
          expect(list()[2]?.ExclusiveStartKey).toEqual(keyOf(matches[1]!))
        }).pipe(Effect.provide(layer))
      })

      it.effect(`${label} in the list partition key`, () => {
        const tournament = `t${text}`
        const matches = [
          { matchId: "m1", name: "a", tournament },
          { matchId: "m2", name: "b", tournament },
        ]
        const { layer, list } = serve(matches)
        return Effect.gen(function* () {
          const { cursors, ids } = yield* walk({ limit: 1 }, tournament)

          expect(ids).toEqual(["m1", "m2"])
          // Every key of this list holds it, so no page has a legacy cursor.
          for (const cursor of cursors) expect(cursor).toMatch(V2_CURSOR)
          expect(list()[1]?.ExclusiveStartKey).toEqual(keyOf(matches[0]!))
        }).pipe(Effect.provide(layer))
      })
    }
  })

  describe("a key btoa can carry", () => {
    it.effect("its cursor is the bytes it always was", () => {
      const { layer } = serve(THREE)
      return Effect.gen(function* () {
        const { cursors } = yield* walk({ limit: 1 })

        // Written out, so that the expectation can't drift with the code.
        expect(cursors[0]).toBe(
          "eyJnc2kxcGsiOnsiUyI6IiRjdXJzb3JhcHAjdjEjbWF0Y2hsaXN0I3QxIn0sImdzaTFzayI6eyJTIjoiJGN1cnNvcmFwcCN2MSNtYXRjaGxpc3QjYWxwaGEifSwicGsiOnsiUyI6IiRjdXJzb3JhcHAjdjEjbWF0Y2gjbTEifSwic2siOnsiUyI6IiRjdXJzb3JhcHAjdjEjbWF0Y2hpdGVtIn19",
        )
        expect(cursors[0]).toBe(btoa(JSON.stringify(keyOf(THREE[0]!))))
      }).pipe(Effect.provide(layer))
    })

    for (const [label, name] of [
      ["ASCII", "Plain"],
      ["U+00E9", "Caf\u00E9"],
      ["U+00FF, the last code point btoa takes", "\u00FF"],
    ] as const) {
      it.effect(`${label} keeps the legacy bytes, and resumes`, () => {
        const matches = [
          { matchId: "m1", name },
          { matchId: "m2", name: `${name}z` },
        ]
        const { layer, list } = serve(matches)
        return Effect.gen(function* () {
          const { cursors, ids } = yield* walk({ limit: 1 })

          expect(ids).toEqual(["m1", "m2"])
          expect(cursors[0]).toBe(btoa(JSON.stringify(keyOf(matches[0]!))))
          expect(list()[1]?.ExclusiveStartKey).toEqual(keyOf(matches[0]!))
        }).pipe(Effect.provide(layer))
      })
    }

    it.effect("the key's own attribute order is kept", () => {
      const order = REBUILT_KEY_FIELDS
      const { layer } = serve(THREE, { keyFields: order })
      return Effect.gen(function* () {
        const { cursors } = yield* walk({ limit: 1 })

        expect(cursors[0]).toBe(btoa(JSON.stringify(keyOf(THREE[0]!, order))))
      }).pipe(Effect.provide(layer))
    })
  })

  describe("a cursor from the old form", () => {
    it.effect("resumes, from text written out", () => {
      const { layer, list } = serve(THREE)
      return Effect.gen(function* () {
        const result = yield* Matches.list(
          { tournament: "t1" },
          {
            cursor:
              "eyJnc2kxcGsiOnsiUyI6IiRjdXJzb3JhcHAjdjEjbWF0Y2hsaXN0I3QxIn0sImdzaTFzayI6eyJTIjoiJGN1cnNvcmFwcCN2MSNtYXRjaGxpc3QjYWxwaGEifSwicGsiOnsiUyI6IiRjdXJzb3JhcHAjdjEjbWF0Y2gjbTEifSwic2siOnsiUyI6IiRjdXJzb3JhcHAjdjEjbWF0Y2hpdGVtIn19",
          },
        )

        expect(result.data.map((match) => match.matchId)).toEqual(["m2", "m3"])
        expect(list()[0]?.ExclusiveStartKey).toEqual(keyOf(THREE[0]!))
        expect(result.cursor).toEqual(Option.none())
      }).pipe(Effect.provide(layer))
    })

    it.effect("resumes when it holds text in Latin-1", () => {
      const matches = [
        { matchId: "m1", name: "Caf\u00E9" },
        { matchId: "m2", name: "Zulu" },
      ]
      const { layer, list } = serve(matches)
      return Effect.gen(function* () {
        const result = yield* Matches.list(
          { tournament: "t1" },
          { cursor: btoa(JSON.stringify(keyOf(matches[0]!))) },
        )

        expect(result.data.map((match) => match.matchId)).toEqual(["m2"])
        expect(list()[0]?.ExclusiveStartKey).toEqual(keyOf(matches[0]!))
      }).pipe(Effect.provide(layer))
    })
  })

  describe("a cursor it can't decode", () => {
    const key = { pk: { S: "p" } }

    for (const [label, cursor] of [
      ["malformed base64", "%%% not base64 %%%"],
      ["text above U+00FF", "men\u2019s final"],
      ["an empty string", ""],
      ["base64 of something that isn't JSON", btoa("not json")],
      ["base64 of nothing", btoa("")],
      ["JSON: an array", btoa("[1,2]")],
      ["JSON: a string", btoa('"text"')],
      ["JSON: a number", btoa("42")],
      ["JSON: null", btoa("null")],
      ["JSON: an object with no attributes", btoa("{}")],
      ["JSON: an attribute that isn't an attribute value", btoa('{"pk":"x"}')],
      ["JSON: an S that isn't a string", btoa('{"pk":{"S":1}}')],
      ["JSON: two types on one attribute", btoa('{"pk":{"S":"a","N":"1"}}')],
      ["JSON: a type no key has", btoa('{"pk":{"BOOL":true}}')],
      ["JSON: a B as the legacy form wrote one", btoa('{"pk":{"B":{"0":1}}}')],
      ["v2 of nothing", "v2."],
      ["v2 of malformed base64url", "v2.%%%"],
      ["v2 of something that isn't JSON", v2Of("not json")],
      ["v2 of bytes that aren't UTF-8", `v2.${Cursor.toBase64Url(new Uint8Array([0xff, 0xfe]))}`],
      ["v2 of an array", v2Of("[1,2]")],
      ["v2 of another version", v2Of(JSON.stringify({ v: 3, k: key }))],
      ["v2 with no position", v2Of(JSON.stringify({ v: 2 }))],
      ["v2 with an empty key", v2Of(JSON.stringify({ v: 2, k: {} }))],
      ["v2 with a key of the wrong shape", v2Of(JSON.stringify({ v: 2, k: { pk: "x" } }))],
      ["v2 with an unknown field", v2Of(JSON.stringify({ v: 2, k: key, x: 1 }))],
      ["v2 of a .within() query", v2Of(JSON.stringify({ v: 2, f: "abc", s: "key", k: key }))],
      ["v2 of a skip-scan's tuple", v2Of(JSON.stringify({ v: 2, t: { S: "a" }, k: key }))],
      ["v2 of a position with no key", v2Of(JSON.stringify({ v: 2, f: "abc", a: { S: "a" } }))],
      ["v2 of a finished tuple", v2Of(JSON.stringify({ v: 2, d: 1 }))],
      ["v2 of a sharded query", v2Of(JSON.stringify({ v: 2, f: "abc", z: [0, 1], c: "abc" }))],
      ["v2 of a key with a checksum", v2Of(JSON.stringify({ v: 2, k: key, c: "abc" }))],
    ] as const) {
      it.effect(`${label} is a ValidationError carrying EDD-9094, with nothing sent`, () => {
        const { layer, requests } = serve(THREE)
        return Effect.gen(function* () {
          const error: any = yield* Effect.flip(Matches.list({ tournament: "t1" }, { cursor }))

          expect(error._tag).toBe("ValidationError")
          expect(error.entityType).toBe("MatchItem")
          expect(error.operation).toBe("list")
          expect(String(error.cause)).toContain("[EDD-9094]")
          expect(requests()).toBe(0)
        }).pipe(Effect.provide(layer))
      })
    }

    it.effect("a real .within() query's cursor is refused, though it holds a key", () => {
      const fixture = makeListings()
      const queried = fixture.serve(
        [10, 40, 70].map((price, p) => ({
          storeId: STORE,
          listingId: `l-${p}`,
          status: "active",
          price,
        })),
      )
      const { layer, requests } = serve(THREE)
      return Effect.gen(function* () {
        const page: Page = yield* Effect.flatMap(fixture.listings, (listings) =>
          listings
            .byStore({ storeId: STORE })
            .within({ price: { gte: 0 } })
            .limit(1)
            .fetch(),
        ).pipe(Effect.provide(queried.layer)) as Effect.Effect<Page>
        const cursor = Option.getOrThrow(page.cursor)
        expect(Cursor.decode(cursor)?.f).toBeDefined()

        const error: any = yield* Effect.flip(Matches.list({ tournament: "t1" }, { cursor }))

        expect(error.operation).toBe("list")
        expect(String(error.cause)).toContain("[EDD-9094]")
        expect(requests()).toBe(0)
      }).pipe(Effect.provide(layer))
    })

    it.effect("is refused on a list that would read nothing", () => {
      const { layer } = serve(THREE)
      return Effect.gen(function* () {
        const error: any = yield* Effect.flip(
          Matches.list({ tournament: "t1" }, { cursor: "%%%", limit: 0 }),
        )

        expect(String(error.cause)).toContain("[EDD-9094]")
      }).pipe(Effect.provide(layer))
    })

    it.effect("a well-formed key isn't checked here: it goes to DynamoDB as it came", () => {
      const { layer, list } = serve(THREE)
      return Effect.gen(function* () {
        const foreign = { gsi1sk: { S: "$cursorapp#v1#matchlist#alpha" }, pk: { S: "p" } }

        yield* Matches.list({ tournament: "t1" }, { cursor: btoa(JSON.stringify(foreign)) })

        expect(list()[0]?.ExclusiveStartKey).toEqual(foreign)
      }).pipe(Effect.provide(layer))
    })
  })

  describe("a filtered list", () => {
    it.effect("an over-read page's cursor is rebuilt from the last item returned", () => {
      const { layer, list } = serve(FILTERED)
      return Effect.gen(function* () {
        const { cursors, ids } = yield* walk({ filter: { status: "done" }, limit: 1 })

        expect(ids).toEqual(["m2", "m4", "m5"])
        // No `LastEvaluatedKey` on these requests: the range ended, and the surplus was dropped.
        expect(cursors[0]).toMatch(V2_CURSOR)
        expect(Cursor.decode(cursors[0]!)?.k).toEqual(keyOf(FILTERED[1]!, REBUILT_KEY_FIELDS))
        expect(list()[1]?.ExclusiveStartKey).toEqual(keyOf(FILTERED[1]!))
        expect(list()[2]?.ExclusiveStartKey).toEqual(keyOf(FILTERED[3]!))
      }).pipe(Effect.provide(layer))
    })

    it.effect(
      "over-reading beside a LastEvaluatedKey, rebuilt from the attributes it names",
      () => {
        const { layer, list } = serve(FILTERED)
        return Effect.gen(function* () {
          // Two rows a request, so `m2` comes back with `m1` under a key that isn't its own.
          const { cursors, ids } = yield* walk({
            filter: { status: "done" },
            limit: 1,
            pageSize: 4,
          })

          expect(ids).toEqual(["m2", "m4", "m5"])
          expect(Cursor.decode(cursors[0]!)?.k).toEqual(keyOf(FILTERED[1]!))
          expect(list()[1]?.ExclusiveStartKey).toEqual(keyOf(FILTERED[1]!))
        }).pipe(Effect.provide(layer))
      },
    )

    it.effect("a page filling on a LastEvaluatedKey that holds U+2019", () => {
      const { layer, list } = serve(FILTERED)
      return Effect.gen(function* () {
        // One row a request: the page fills on `m2`, and its key is the `LastEvaluatedKey`.
        const { cursors, ids } = yield* walk({
          filter: { status: "done" },
          limit: 1,
          pageSize: 1,
        })

        expect(ids).toEqual(["m2", "m4", "m5"])
        expect(cursors[0]).toBe(Cursor.encodeKeyCursor(keyOf(FILTERED[1]!)))
        expect(list()[2]?.ExclusiveStartKey).toEqual(keyOf(FILTERED[1]!))
      }).pipe(Effect.provide(layer))
    })

    it.effect("a client-side predicate's cursor lands on the last row accepted", () => {
      const { layer, list } = serve(FILTERED)
      return Effect.gen(function* () {
        const { cursors, ids } = yield* walk({
          filterBy: (root) => root.status === "done",
          limit: 1,
        })

        expect(ids).toEqual(["m2", "m4", "m5"])
        expect(cursors[0]).toMatch(V2_CURSOR)
        expect(list()[1]?.ExclusiveStartKey).toEqual(keyOf(FILTERED[1]!))
      }).pipe(Effect.provide(layer))
    })

    it.effect("takes a key in Latin-1 in the legacy form when rebuilt", () => {
      const matches: ReadonlyArray<Fields> = [
        { matchId: "m1", name: "Caf\u00E9", status: "done" },
        { matchId: "m2", name: "Zulu", status: "done" },
      ]
      const { layer } = serve(matches)
      return Effect.gen(function* () {
        const { cursors, ids } = yield* walk({ filter: { status: "done" }, limit: 1 })

        expect(ids).toEqual(["m1", "m2"])
        // A rebuilt key names `keyFields`, in that order.
        expect(cursors[0]).toBe(btoa(JSON.stringify(keyOf(matches[0]!, REBUILT_KEY_FIELDS))))
      }).pipe(Effect.provide(layer))
    })
  })

  describe("reverse", () => {
    it.effect("pages down through a key holding U+2019", () => {
      const { layer, list } = serve(THREE)
      return Effect.gen(function* () {
        const { cursors, ids } = yield* walk({ limit: 1, reverse: true })

        expect(ids).toEqual(["m3", "m2", "m1"])
        expect(cursors[1]).toMatch(V2_CURSOR)
        expect(list()[2]?.ExclusiveStartKey).toEqual(keyOf(THREE[1]!))
        for (const input of list()) expect(input.ScanIndexForward).toBe(false)
      }).pipe(Effect.provide(layer))
    })

    it.effect("pages down under a filter, its cursor rebuilt", () => {
      const { layer, list } = serve(FILTERED)
      return Effect.gen(function* () {
        const { cursors, ids } = yield* walk({
          filter: { status: "done" },
          limit: 1,
          reverse: true,
        })

        expect(ids).toEqual(["m5", "m4", "m2"])
        expect(cursors[1]).toMatch(V2_CURSOR)
        expect(list()[2]?.ExclusiveStartKey).toEqual(keyOf(FILTERED[3]!))
        for (const input of list()) expect(input.ScanIndexForward).toBe(false)
      }).pipe(Effect.provide(layer))
    })
  })

  describe("a sharded list", () => {
    for (const [label, cursor] of [
      ["malformed base64", "%%% not base64 %%%"],
      ["an empty string", ""],
      ["a legacy cursor", btoa(JSON.stringify(keyOf(THREE[0]!)))],
      ["a v2 cursor", Cursor.encodeKeyCursor(keyOf(THREE[1]!))],
    ] as const) {
      it.effect(`${label} is still refused with EDD-9051, not EDD-9094`, () => {
        const { layer, requests } = serve(THREE)
        return Effect.gen(function* () {
          const error: any = yield* Effect.flip(
            ShardedMatches.list({ tournament: "t1" }, { cursor }),
          )

          expect(error._tag).toBe("ValidationError")
          expect(String(error.cause)).toContain("[EDD-9051]")
          expect(String(error.cause)).not.toContain("EDD-9094")
          expect(requests()).toBe(0)
        }).pipe(Effect.provide(layer))
      })
    }

    it.effect("a page holding U+2019 still has no cursor", () => {
      const { layer } = serve(THREE)
      return Effect.gen(function* () {
        const page = yield* ShardedMatches.list({ tournament: "t1" }, { limit: 1 })

        expect(page.cursor).toEqual(Option.none())
      }).pipe(Effect.provide(layer))
    })
  })

  describe("the last key as given, no casing applied", () => {
    it.effect("U+00FF, the last code point btoa takes, keeps the legacy bytes", () => {
      const lastKey = { pk: { S: "p\u00FF" } }
      const { inputs, layer } = serveLastKey(lastKey)
      return Effect.gen(function* () {
        const first = yield* Matches.list({ tournament: "t1" }, { limit: 1 })
        const cursor = Option.getOrThrow(first.cursor)
        expect(cursor).toBe(btoa(JSON.stringify(lastKey)))

        yield* Matches.list({ tournament: "t1" }, { cursor, limit: 1 })

        expect(inputs[1]?.ExclusiveStartKey).toEqual(lastKey)
      }).pipe(Effect.provide(layer))
    })

    it.effect("U+0100, the first code point btoa refuses, gets a v2 cursor", () => {
      const lastKey = { pk: { S: "p\u0100" } }
      const { inputs, layer } = serveLastKey(lastKey)
      return Effect.gen(function* () {
        const first = yield* Matches.list({ tournament: "t1" }, { limit: 1 })
        const cursor = Option.getOrThrow(first.cursor)
        expect(cursor).toMatch(V2_CURSOR)

        yield* Matches.list({ tournament: "t1" }, { cursor, limit: 1 })

        expect(inputs[1]?.ExclusiveStartKey).toEqual(lastKey)
      }).pipe(Effect.provide(layer))
    })

    it.effect("a binary key attribute survives the round trip", () => {
      const lastKey = { pk: { S: "p" }, blob: { B: new Uint8Array([0, 255, 128, 7]) } }
      const { inputs, layer } = serveLastKey(lastKey)
      return Effect.gen(function* () {
        const first = yield* Matches.list({ tournament: "t1" }, { limit: 1 })
        const cursor = Option.getOrThrow(first.cursor)
        expect(cursor).toMatch(V2_CURSOR)

        yield* Matches.list({ tournament: "t1" }, { cursor, limit: 1 })

        expect(inputs[1]?.ExclusiveStartKey).toEqual(lastKey)
      }).pipe(Effect.provide(layer))
    })
  })
})
