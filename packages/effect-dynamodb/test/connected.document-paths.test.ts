/**
 * What DynamoDB does with the update expressions #238 relies on, measured on DynamoDB Local with
 * the SDK alone, so the library's choices rest on what DynamoDB does rather than on a reading of
 * its documentation:
 *
 * - An entry of a sparse map a `field:` rename stores whole (`sr`) is written inside it (`SET
 *   sr.b`, `ADD sr.a`, `REMOVE sr.a`) when the row holds `sr`. On a row without `sr` such a write is
 *   refused as a whole (`ValidationException`), so the library guards it `attribute_exists(sr)`:
 *   the condition is evaluated first, and a row changed since it was read is a conditional failure.
 * - A write of the entries as their own attributes is guarded `attribute_not_exists(sr)`: on a row
 *   holding `sr`, the conditional failure comes first, before a `.subtract()` of an entry that
 *   isn't there is refused for naming no attribute.
 * - `ADD` takes a document path: a number held inside a map is added to, a set unioned, and an
 *   absent entry starts from nothing, as a top-level attribute does.
 * - A list's positions, in one update: `REMOVE` positions are applied after `SET`, each against the
 *   list as it was, and a `SET` past the end appends (`SET t[2] REMOVE t[0]` on `[first, second]`
 *   leaves `[second, third]`); paths that overlap are refused.
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb"
import { Config, Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

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

const client = new DynamoDBClient({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
const TableName = `document-paths-${Date.now()}`
const Key = { pk: { S: "a" } }
const N = (n: number) => ({ N: String(n) })
const S = (s: string) => ({ S: s })

/** Write `item`, send the update, and say what the row holds after it or how it was refused. */
const run = async (
  item: Record<string, any>,
  update: {
    readonly expression: string
    readonly names: Record<string, string>
    readonly values?: Record<string, any>
    readonly condition?: string
    readonly transaction?: boolean
  },
): Promise<{ readonly row?: Record<string, any>; readonly refused?: string }> => {
  await client.send(new PutItemCommand({ TableName, Item: { ...Key, ...item } }))
  const body = {
    TableName,
    Key,
    UpdateExpression: update.expression,
    ExpressionAttributeNames: update.names,
    ...(update.values !== undefined && { ExpressionAttributeValues: update.values }),
    ...(update.condition !== undefined && { ConditionExpression: update.condition }),
  }
  try {
    if (update.transaction) {
      await client.send(new TransactWriteItemsCommand({ TransactItems: [{ Update: body }] }))
    } else {
      await client.send(new UpdateItemCommand(body))
    }
  } catch (error) {
    const e = error as { name: string; CancellationReasons?: ReadonlyArray<{ Code?: string }> }
    return {
      refused:
        e.name === "TransactionCanceledException"
          ? `${e.name}: ${(e.CancellationReasons ?? []).map((r) => r.Code).join(", ")}`
          : e.name,
    }
  }
  const got = await client.send(new GetItemCommand({ TableName, Key, ConsistentRead: true }))
  const { pk: _pk, ...row } = got.Item ?? {}
  return { row }
}

const sr = { sr: { M: { a: N(1) } } }
const entries = { "counts#a": N(1) }

describeConnected(
  "the update expressions a renamed sparse map's entries and list positions use",
  () => {
    beforeAll(async () => {
      await client.send(
        new CreateTableCommand({
          TableName,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        }),
      )
    })
    afterAll(async () => {
      await client.send(new DeleteTableCommand({ TableName }))
    })

    it("SET sr.b on a row holding sr writes the entry inside it", async () => {
      expect(
        await run(sr, {
          expression: "SET #sr.#b = :v",
          names: { "#sr": "sr", "#b": "b" },
          values: { ":v": N(2) },
          condition: "attribute_exists(#sr)",
        }),
      ).toEqual({ row: { sr: { M: { a: N(1), b: N(2) } } } })
    })

    it("SET sr.b on a row without sr is refused whole; guarded, it is a conditional failure", async () => {
      const set = {
        expression: "SET #sr.#b = :v",
        names: { "#sr": "sr", "#b": "b" },
        values: { ":v": N(2) },
      }
      expect(await run(entries, set)).toEqual({ refused: "ValidationException" })
      expect(await run(entries, { ...set, condition: "attribute_exists(#sr)" })).toEqual({
        refused: "ConditionalCheckFailedException",
      })
      expect(
        await run(entries, { ...set, condition: "attribute_exists(#sr)", transaction: true }),
      ).toEqual({ refused: "TransactionCanceledException: ConditionalCheckFailed" })
    })

    it("REMOVE sr.a needs sr; an entry sr doesn't hold is removed quietly", async () => {
      const remove = { expression: "REMOVE #sr.#a", names: { "#sr": "sr", "#a": "a" } }
      expect(await run(entries, remove)).toEqual({ refused: "ValidationException" })
      expect(await run(sr, { ...remove, names: { "#sr": "sr", "#a": "z" } })).toEqual({ row: sr })
      expect(await run(sr, remove)).toEqual({ row: { sr: { M: {} } } })
    })

    it("a .subtract() of an entry on a row holding sr: the guard fails first", async () => {
      const subtract = {
        expression: "SET #c = #c - :v",
        names: { "#c": "counts#a" },
        values: { ":v": N(1) },
      }
      expect(await run(sr, subtract)).toEqual({ refused: "ValidationException" })
      expect(
        await run(sr, {
          ...subtract,
          names: { ...subtract.names, "#sr": "sr" },
          condition: "attribute_not_exists(#sr)",
        }),
      ).toEqual({ refused: "ConditionalCheckFailedException" })
      // Inside sr, as the head writes it on a row it read holding sr.
      expect(
        await run(sr, {
          expression: "SET #sr.#a = #sr.#a - :v",
          names: { "#sr": "sr", "#a": "a" },
          values: { ":v": N(1) },
        }),
      ).toEqual({ row: { sr: { M: { a: N(0) } } } })
    })

    it("ADD takes a document path: a number inside a map adds, an absent entry starts from nothing, a set unions", async () => {
      const add = (key: string, value: unknown) => ({
        expression: "ADD #sr.#k :v",
        names: { "#sr": "sr", "#k": key },
        values: { ":v": value },
      })
      expect(await run(sr, add("a", N(1)))).toEqual({ row: { sr: { M: { a: N(2) } } } })
      expect(await run(sr, add("b", N(1)))).toEqual({ row: { sr: { M: { a: N(1), b: N(1) } } } })
      expect(await run({ sr: { M: { s: { SS: ["x"] } } } }, add("s", { SS: ["y"] }))).toEqual({
        row: { sr: { M: { s: { SS: ["x", "y"] } } } },
      })
    })

    it("a list's positions: REMOVE applies after SET, against the list as it was; overlaps are refused", async () => {
      const list = (...items: ReadonlyArray<string>) => ({ t: { L: items.map(S) } })
      const names = { "#t": "t" }
      expect(
        await run(list("first", "second"), {
          expression: "SET #t[2] = :z REMOVE #t[0]",
          names,
          values: { ":z": S("third") },
        }),
      ).toEqual({ row: list("second", "third") })
      expect(
        await run(
          { t: { L: [S("first"), N(1)] } },
          { expression: "SET #t[1] = :z REMOVE #t[0]", names, values: { ":z": S("z") } },
        ),
      ).toEqual({ row: list("z") })
      expect(
        await run(list("first", "second"), { expression: "REMOVE #t[0], #t[1]", names }),
      ).toEqual({ row: { t: { L: [] } } })
      expect(
        await run(list("first", "second"), {
          expression: "SET #t[0] = :z REMOVE #t[0]",
          names,
          values: { ":z": S("z") },
        }),
      ).toEqual({ refused: "ValidationException" })
      expect(
        await run(
          { f: { M: { x: N(1) } } },
          {
            expression: "SET #f = :v REMOVE #f.#x",
            names: { "#f": "f", "#x": "x" },
            values: { ":v": { M: {} } },
          },
        ),
      ).toEqual({ refused: "ValidationException" })
      expect(
        await run(
          { t: { L: [S("first"), { M: {} }] } },
          {
            expression: "SET #t[1].#z = :z REMOVE #t[0]",
            names: { "#t": "t", "#z": "z" },
            values: { ":z": S("z") },
          },
        ),
      ).toEqual({ row: { t: { L: [{ M: { z: S("z") } }] } } })
    })
  },
)
