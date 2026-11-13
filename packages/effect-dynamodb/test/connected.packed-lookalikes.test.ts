/**
 * Effect's look-alikes in packed storage against DynamoDB Local (#242): the connected twin of
 * `PackedLookalikes.test.ts`, over what published 1.40.0 packed
 * (`fixtures/packed-lookalikes-1.40.0.json`, values and definitions in
 * `helpers/PackedLookalikes.ts`). A real instance is stored as the bytes 1.40.0 stored for the map a
 * native read hands back for it, reads back as the instance, and is written back as the same bytes;
 * what 1.40.0 packed is packed to the same bytes; what JSON can't hold stays refused.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { DynamoDBClient, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import { Cause, Config, Effect, Exit, Option, type Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as EventStore from "../src/EventStore.js"
import { isInstanceOf } from "./helpers/Lookalikes.js"
import {
  definitionsOf,
  fixture,
  inputOf,
  kindOf,
  packedMapText,
  type Row,
} from "./helpers/PackedLookalikes.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const send = <A>(make: () => Promise<A>) =>
  Effect.tryPromise(make).pipe(Effect.orDie) as Effect.Effect<A>

let tables = 0

interface Harness {
  readonly db: any
  readonly stream: any
  readonly row: (id: string) => Effect.Effect<Row | undefined>
  readonly streamRows: (
    sid: string,
  ) => Effect.Effect<{ readonly event?: Row | undefined; readonly snapshot?: Row | undefined }>
}

/** A fresh table of the generator's definitions, a client and a stream on it; dropped after. */
const on = <A>(field: Schema.Top, body: (h: Harness) => Effect.Effect<A, unknown, any>) => {
  const { P, Main, Stream } = definitionsOf(field)
  const TableName = `packed-lookalikes-${Date.now()}-${tables++}`
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({ entities: { P }, tables: { Main } } as never) as any
    yield* db.tables.Main.create()
    const stream = yield* EventStore.bind(Stream as never) as Effect.Effect<any>
    const harness: Harness = {
      db,
      stream,
      row: (id) =>
        Effect.map(
          send(() =>
            raw.send(
              new GetItemCommand({
                TableName,
                Key: { pk: { S: `$pk#v1#p#id_${id}` }, sk: { S: "$pk#v1#p" } },
                ConsistentRead: true,
              }),
            ),
          ),
          (out) => out.Item as Row | undefined,
        ),
      streamRows: (sid) =>
        Effect.map(
          send(() =>
            raw.send(
              new QueryCommand({
                TableName,
                KeyConditionExpression: "pk = :pk",
                ExpressionAttributeValues: { ":pk": { S: `$pk#v1#s#${sid}` } },
                ConsistentRead: true,
              }),
            ),
          ),
          (out) => {
            const items = (out.Items ?? []) as unknown as ReadonlyArray<Row>
            return {
              event: items.find((item) => item.data !== undefined),
              snapshot: items.find((item) => item.state !== undefined),
            }
          },
        ),
    }
    return yield* Effect.ensuring(body(harness), Effect.ignore(db.tables.Main.delete()))
  }).pipe(
    Effect.provide(Main.layer({ name: TableName })),
    Effect.provide(ClientLayer),
  ) as Effect.Effect<A, unknown>
}

const put = (h: Harness, id: string, attribute: "p" | "u", value: unknown) =>
  Effect.exit(h.db.entities.P.put({ id, [attribute]: { v: value } }).asEffect())

const append = (h: Harness, sid: string, value: unknown) =>
  Effect.exit(
    Effect.suspend(() =>
      h.stream.append({ sid }, [{ _tag: "Ev", v: value }], 0, { snapshot: { v: value } }),
    ) as Effect.Effect<unknown, unknown>,
  )

const KINDS = [
  "BigDecimal",
  "Duration nanos",
  "TimeZoneNamed",
  "Cookie",
  "Cookie expires",
  "Cookies",
  "UrlParams",
  "SemVerRange",
  "InetAddressV6",
  "HostPort",
  "DnsSoaRecord",
  "Option(DateTimeZoned)",
  "Result(Number, String)",
]

describeConnected("packed look-alikes on DynamoDB Local", () => {
  describe.each(KINDS)("%s", (name) => {
    const { field, make } = kindOf(name)
    const text = packedMapText(name)!

    it.effect(
      "a real instance: stored as 1.40.0 stored its native map, read and written back",
      () =>
        on(field, (h) =>
          Effect.gen(function* () {
            expect(Exit.isSuccess(yield* put(h, "t", "p", make()))).toBe(true)
            expect(Exit.isSuccess(yield* put(h, "u", "u", make()))).toBe(true)
            expect((yield* h.row("t"))?.p).toEqual({ S: `{"v":${text}}` })
            expect((yield* h.row("u"))?.u).toEqual({ S: `{"v":${text}}` })
            const got = yield* h.db.entities.P.get({ id: "t" })
            expect(isInstanceOf(got.p.v, make(), field)).toBe(true)
            expect(Exit.isSuccess(yield* put(h, "again", "p", got.p.v))).toBe(true)
            expect((yield* h.row("again"))?.p).toEqual({ S: `{"v":${text}}` })

            expect(Exit.isSuccess(yield* append(h, "s", make()))).toBe(true)
            const { event, snapshot } = yield* h.streamRows("s")
            expect(event?.data).toEqual({ S: `{"_tag":"Ev","v":${text}}` })
            expect(snapshot?.state).toEqual({ S: `{"v":${text}}` })
            const [read] = yield* h.stream.read({ sid: "s" })
            expect(isInstanceOf(read.data.v, make(), field)).toBe(true)
            const state = Option.getOrThrow((yield* h.stream.readSnapshot({ sid: "s" })) as any)
            expect(isInstanceOf((state as any).state.v, make(), field)).toBe(true)
          }),
        ),
    )

    it.effect("what 1.40.0 packed, packed to the same bytes", () =>
      on(field, (h) =>
        Effect.gen(function* () {
          for (const [label, captured] of Object.entries(fixture[name]!.cases)) {
            if (captured.outcome !== "ok" || label.startsWith("stream/")) continue
            const attribute = label.startsWith("typed/") ? "p" : "u"
            const id = label.replace("/", "-")
            expect(Exit.isSuccess(yield* put(h, id, attribute, inputOf(name, label)))).toBe(true)
            expect((yield* h.row(id))?.[attribute]).toEqual(captured.stored)
          }
          const plain = fixture[name]!.cases["stream/plain"]
          if (plain?.outcome === "ok") {
            expect(Exit.isSuccess(yield* append(h, "p", inputOf(name, "stream/plain")))).toBe(true)
            const { event, snapshot } = yield* h.streamRows("p")
            expect(event?.data).toEqual(plain.data)
            expect(snapshot?.state).toEqual(plain.state)
          }
        }),
      ),
    )
  })

  it.effect("bytes stay refused, and nothing is written", () => {
    const { field, make } = kindOf("MacAddress")
    return on(field, (h) =>
      Effect.gen(function* () {
        const exit = yield* put(h, "m", "p", make())
        expect(Exit.isFailure(exit)).toBe(true)
        const refused = Cause.squash((exit as Exit.Failure<unknown, unknown>).cause) as any
        expect(refused._tag).toBe("ValidationError")
        expect(String(refused.cause?.message)).toContain("the value at p.v.bytes is binary data")
        expect(yield* h.row("m")).toBeUndefined()
      }),
    )
  })
})
