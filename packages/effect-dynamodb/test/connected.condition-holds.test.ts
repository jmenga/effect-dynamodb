/**
 * What DynamoDB answers for each condition in `helpers/ConditionCases.ts` (#238): the answers
 * `ConditionHolds.test.ts` holds the evaluator to are DynamoDB's own. Each condition is asked as a
 * `ConditionCheck` against one stored item, so nothing is written.
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb"
import { Config, Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { conditionHolds } from "../src/internal/ConditionHolds.js"
import { cases, item, names, values } from "./helpers/ConditionCases.js"

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
const TableName = `condition-holds-${Date.now()}`

/** The names and values an expression uses: DynamoDB refuses any it is sent but doesn't use. */
const used = <A>(expression: string, all: Record<string, A>) =>
  Object.fromEntries(
    Object.entries(all).filter(([token]) =>
      new RegExp(`${token}(?![A-Za-z0-9_])`).test(expression),
    ),
  )

const ask = async (expression: string): Promise<boolean | "invalid"> => {
  const usedValues = used(expression, values)
  try {
    await client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName,
              Key: { pk: item.pk! },
              ConditionExpression: expression,
              ExpressionAttributeNames: used(expression, names),
              ...(Object.keys(usedValues).length > 0 && { ExpressionAttributeValues: usedValues }),
            },
          },
        ],
      }),
    )
    return true
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === "TransactionCanceledException") return false
    if (name === "ValidationException") return "invalid"
    throw error
  }
}

describeConnected("a condition on a stored item, as DynamoDB answers it", () => {
  beforeAll(async () => {
    await client.send(
      new CreateTableCommand({
        TableName,
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
      }),
    )
    await client.send(new PutItemCommand({ TableName, Item: item }))
  })
  afterAll(async () => {
    await client.send(new DeleteTableCommand({ TableName }))
  })

  for (const { expression, holds, unsure } of cases) {
    it(expression, async () => {
      expect(await ask(expression)).toBe(holds)
      expect(conditionHolds(expression, item, names, values)).toBe(
        holds === "invalid" || unsure ? undefined : holds,
      )
    })
  }
})
