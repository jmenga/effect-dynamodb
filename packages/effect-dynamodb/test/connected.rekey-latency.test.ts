/**
 * `rekey` on DynamoDB Local with its requests answered at random speeds (#240): every request waits
 * a random 0 to 30 ms before it's sent, a parallel scan segment's up to 90 ms more, and the rows of
 * each scan page come back shuffled. So a run's fibers (its segments, the rows of a page handled at
 * once, the moves a chain needs) interleave differently each time, and its segments finish in
 * another order. The chain scenarios (`helpers/RekeyChains.ts`), in 1, 2, 4 and 8 segments: the dry
 * run reports what the run does, and what both report is what the table held before them, not the
 * order the run met its rows in. `connected.rekey-chains.test.ts` runs the same scenarios with
 * nothing slowed.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { it } from "@effect/vitest"
import { Config, Duration, Effect, Layer } from "effect"
import { describe } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Table from "../src/Table.js"
import { type Around, gatedClient } from "./helpers/GatedClient.js"
import { seeded } from "./helpers/RandomTables.js"
import * as RekeyChains from "./helpers/RekeyChains.js"

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

const STEMS = ["foo", "beta", "kappa"]

describeConnected("#240 rekey with its requests answered at random speeds, on DynamoDB", () => {
  for (const [s, scenario] of RekeyChains.chainScenarios.entries()) {
    describe(scenario.name, () => {
      for (const segments of [1, 2, 4, 8]) {
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
