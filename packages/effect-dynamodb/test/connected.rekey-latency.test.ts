/**
 * `rekey` on DynamoDB Local with its requests answered at random speeds (#240): every request waits
 * a random 0 to 30 ms before it's sent, a parallel scan segment's up to 90 ms more, and the rows of
 * each scan page come back shuffled. So a run's fibers (its segments, the rows of a page handled at
 * once, the moves a chain needs) interleave differently each time, and its segments finish in
 * another order. The chain scenarios (`helpers/RekeyChains.ts`), in 1 and 4 segments: the dry
 * run reports what the run does, and what both report is what the table held before them, not the
 * order the run met its rows in. `connected.rekey-chains.test.ts` runs the same scenarios with
 * nothing slowed. One stem a scenario here; `RekeyInterleavings.test.ts` runs each scenario's
 * stems, its requests interleaving at random, on a recording table.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Config, Deferred, Duration, Effect, Layer, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { type Around, gatedClient, moveAnswerHeld } from "./helpers/GatedClient.js"
import { seeded } from "./helpers/RandomTables.js"
import * as RekeyChains from "./helpers/RekeyChains.js"
import { rekeyOutcome } from "./helpers/RekeyOutcome.js"

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

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})

/**
 * Each request waits 0 to 30 ms (`seed`'s), a scan segment's up to 90 ms more, and a scan page's
 * rows come back in an order of `seed`'s.
 */
const atRandomSpeeds = (seed: number): Around => {
  const next = seeded(seed)
  return (command, input, send) => {
    const wait = next() * 30 + (input?.Segment === undefined ? 0 : next() * 90)
    const sent = Effect.andThen(Effect.sleep(Duration.millis(wait)), send)
    if (command !== "scan") return sent
    const order = seeded(Math.floor(next() * 1_000_000))
    return Effect.map(sent, (output: any) => {
      const items = [...(output.Items ?? [])]
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(order() * (i + 1))
        ;[items[i], items[j]] = [items[j], items[i]]
      }
      return { ...output, Items: items }
    })
  }
}

let tables = 0

const harnessAt = (seed: number): RekeyChains.Harness => ({
  on: (world, body) => {
    const tableName = `chains-latency-${Date.now()}-${tables++}`
    const slow = Layer.effect(
      DynamoClient,
      Effect.gen(function* () {
        return gatedClient(yield* DynamoClient, atRandomSpeeds(seed))
      }),
    ).pipe(Layer.provide(ClientLayer))
    const create = Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        ...Table.definition(world.MainTable),
      })
    })
    const drop = Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.deleteTable({ TableName: tableName })
    }).pipe(Effect.ignore)
    const table: RekeyChains.StoredRows = {
      seed: (row) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          yield* client.putItem({ TableName: tableName, Item: row })
        }),
      remove: (row) =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          yield* client.deleteItem({ TableName: tableName, Key: { pk: row.pk, sk: row.sk } })
        }),
      rows: () =>
        Effect.gen(function* () {
          const client = yield* DynamoClient
          const rows: Array<Record<string, any>> = []
          let start: Record<string, any> | undefined
          do {
            const page = yield* client.scan({
              TableName: tableName,
              ...(start === undefined ? {} : { ExclusiveStartKey: start }),
            })
            rows.push(...(page.Items ?? []))
            start = page.LastEvaluatedKey
          } while (start !== undefined)
          return rows
        }),
      as: (other, effect) =>
        effect.pipe(Effect.provide(other.MainTable.layer({ name: tableName }))) as never,
    }
    return Effect.acquireUseRelease(
      create,
      () => body(table),
      () => drop,
    ).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(slow, world.MainTable.layer({ name: tableName }))),
    ) as never
  },
})

const STEMS = ["foo"]

describeConnected("#240 rekey with its requests answered at random speeds, on DynamoDB", () => {
  for (const [s, scenario] of RekeyChains.chainScenarios.entries()) {
    describe(scenario.name, () => {
      for (const segments of [1, 4]) {
        it.live(
          `${segments} segment(s)`,
          () =>
            Effect.forEach(STEMS, (stem, n) =>
              scenario.run(
                harnessAt(s * 1000 + segments * 10 + n),
                RekeyChains.chainOf(scenario.escapeKeys, stem),
                segments,
              ),
            ),
          60_000,
        )
      }
    })
  }
})

const accounts = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "inflight", version: 1, escapeKeys })
  const Accounts = Entity.make({
    model: Schema.Struct({ id: Schema.String, email: Schema.String }),
    entityType: "Account",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    unique: { email: ["email"] },
  })
  const MainTable = Table.make({ schema, entities: { Accounts } })
  return {
    schema,
    MainTable,
    client: DynamoClient.make({ entities: { Accounts }, tables: { MainTable } }),
  }
}

const sentinelPk = (world: ReturnType<typeof accounts>, email: string) =>
  DynamoSchema.composeUniqueKey(world.schema, "Account", "email", [
    KeyComposer.keyText(world.schema, email, "lowercase"),
  ]).pk

/**
 * One order random speeds reach only now and then, forced on DynamoDB Local (`moveAnswerHeld`).
 * Off: `foo%20bar`'s sentinel goes where `foo bar`'s is, so `foo%20bar`'s pass moves `foo bar`'s
 * sentinel out of its way, to `foo bar`'s current key. `foo bar`'s own pass reads that key before
 * the move lands and its old key after, with the move's answer not back. Finding the sentinel under
 * neither, the pass reads its current key again and takes the move as its work; without that read
 * it counted its item `unchanged`, which a run meeting the rows in another order doesn't. Each
 * step that never comes is given up after five seconds, so a broken order fails, not hangs.
 */
describeConnected("#240 a sentinel moved to its current key by another pass, on DynamoDB", () => {
  for (const concurrency of [2, 4]) {
    it.live(
      `that move's answer not back: the item's pass takes the move as its work (${concurrency} at once)`,
      () =>
        Effect.gen(function* () {
          const was = accounts(true)
          const now = accounts(false)
          const tableName = `inflight-${Date.now()}-${tables++}`
          const held = yield* moveAnswerHeld(
            { current: sentinelPk(now, "foo bar"), old: sentinelPk(now, "foo%20bar") },
            (deferred) => Deferred.await(deferred).pipe(Effect.timeoutOption(Duration.seconds(5))),
          )
          const gated = Layer.effect(
            DynamoClient,
            Effect.gen(function* () {
              return gatedClient(yield* DynamoClient, held.around)
            }),
          ).pipe(Layer.provide(ClientLayer))
          const run = (options: Table.RekeyOptions) =>
            Effect.gen(function* () {
              const db = yield* now.client
              return yield* db.tables.MainTable.rekey(options)
            })
          const body = Effect.gen(function* () {
            const writer = yield* was.client.pipe(
              Effect.provide(was.MainTable.layer({ name: tableName })),
            )
            yield* writer.entities.Accounts.put({ id: "a", email: "foo%20bar" }).asEffect()
            yield* writer.entities.Accounts.put({ id: "b", email: "foo bar" }).asEffect()
            const dry = yield* run({ concurrency, dryRun: true }).pipe(
              Effect.provide(now.MainTable.layer({ name: tableName })),
            )
            const real = yield* run({ concurrency }).pipe(
              Effect.provide(Layer.merge(gated, now.MainTable.layer({ name: tableName }))),
            )
            return { dry, real }
          })
          const { dry, real } = yield* Effect.acquireUseRelease(
            Effect.gen(function* () {
              const client = yield* DynamoClient
              yield* client.createTable({
                TableName: tableName,
                BillingMode: "PAY_PER_REQUEST",
                ...Table.definition(now.MainTable),
              })
            }),
            () => body,
            () =>
              Effect.gen(function* () {
                const client = yield* DynamoClient
                yield* client.deleteTable({ TableName: tableName })
              }).pipe(Effect.ignore),
          ).pipe(Effect.provide(ClientLayer))
          expect(held.order()).toEqual({ readBefore: true, readAfter: true })
          expect(real.conflicts).toEqual([])
          expect(real.sentinelsMoved).toBe(2)
          expect(real.unchanged).toBe(0)
          expect(rekeyOutcome(dry)).toEqual(rekeyOutcome(real))
        }),
      60_000,
    )
  }
})
