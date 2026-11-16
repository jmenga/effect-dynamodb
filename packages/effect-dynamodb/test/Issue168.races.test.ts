/**
 * Issue #168's reproductions (`helpers/AggregateRaces.ts`) over a recording in-memory table:
 * every interleaving forced by `gatedClient`. `connected.aggregate-concurrency.test.ts` runs the
 * same suite against DynamoDB Local.
 */

import { Effect, Layer } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import { Main, racesSuite } from "./helpers/AggregateRaces.js"
import { gatedClient } from "./helpers/GatedClient.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const TABLE = "t168"

racesSuite(async (aggregate) => {
  const table = makeRecordingTable()
  return {
    tableName: TABLE,
    client: table.client,
    run: (body, around) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const db: any = yield* DynamoClient.make({
            entities: {},
            aggregates: { Matches: aggregate },
            tables: { Main },
          } as never)
          return yield* body(db)
        }).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(
                DynamoClient,
                around === undefined ? table.client : gatedClient(table.client, around),
              ),
              Main.layer({ name: TABLE }),
            ) as never,
          ),
          Effect.exit,
        ) as never,
      ),
    rows: async () =>
      [...table.items.values()].sort((a, b) =>
        `${a.pk?.S}|${a.sk?.S}`.localeCompare(`${b.pk?.S}|${b.sk?.S}`),
      ),
  }
})
