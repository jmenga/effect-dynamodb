/**
 * DynamoDB Local tables reused across a connected file's cases. Creating and deleting a table costs
 * DynamoDB Local about 75 ms; emptying one with a few rows costs a few. A case takes an empty table
 * of its definition ({@link TablePool.take}) and gives it back when it's done ({@link
 * TablePool.give}), which empties it; the next case of that definition gets the same table. A table
 * that can't be emptied is deleted instead. The cases of one file run one at a time, so no two
 * hold a table at once; {@link TablePool.drain} deletes every table the pool made.
 */

import {
  type AttributeValue,
  BatchWriteItemCommand,
  CreateTableCommand,
  type CreateTableCommandInput,
  DeleteTableCommand,
  type DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb"
import { Effect } from "effect"

/** What a table is created from, less its name and billing mode (`Table.definition`'s shape). */
export type TableShape = Omit<CreateTableCommandInput, "TableName" | "BillingMode">

export interface TablePool {
  /** An empty table of `shape`: a free one, else a new one. */
  readonly take: (shape: TableShape) => Effect.Effect<string>
  /** `name` emptied and free for the next case of `shape`; deleted if it can't be emptied. */
  readonly give: (name: string, shape: TableShape) => Effect.Effect<void>
  /** Delete every table the pool made. */
  readonly drain: () => Promise<void>
}

const send = <A>(make: () => Promise<A>) => Effect.orDie(Effect.tryPromise(make))

/** Delete every row of `TableName`, a page at a time. */
const empty = async (raw: DynamoDBClient, TableName: string, shape: TableShape) => {
  const keys = (shape.KeySchema ?? []).map((key) => key.AttributeName!)
  const names = Object.fromEntries(keys.map((key, n) => [`#k${n}`, key]))
  let start: Record<string, AttributeValue> | undefined
  do {
    const page = await raw.send(
      new ScanCommand({
        TableName,
        ConsistentRead: true,
        ProjectionExpression: Object.keys(names).join(", "),
        ExpressionAttributeNames: names,
        ...(start !== undefined && { ExclusiveStartKey: start }),
      }),
    )
    const rows = page.Items ?? []
    for (let at = 0; at < rows.length; at += 25) {
      let requests: Array<{ DeleteRequest: { Key: Record<string, AttributeValue> } }> | undefined =
        rows.slice(at, at + 25).map((Key) => ({ DeleteRequest: { Key } }))
      for (let attempt = 0; requests !== undefined && requests.length > 0; attempt++) {
        if (attempt === 8) throw new Error(`could not empty ${TableName}`)
        const out = await raw.send(
          new BatchWriteItemCommand({ RequestItems: { [TableName]: requests } }),
        )
        requests = out.UnprocessedItems?.[TableName] as typeof requests
      }
    }
    start = page.LastEvaluatedKey
  } while (start !== undefined)
}

/** A pool of tables named `<prefix>-…` on the DynamoDB Local `raw` talks to. */
export const makeTablePool = (raw: DynamoDBClient, prefix: string): TablePool => {
  const free = new Map<string, Array<string>>()
  const made = new Set<string>()
  let count = 0
  const keyOf = (shape: TableShape) => JSON.stringify(shape)
  return {
    take: (shape) =>
      Effect.suspend(() => {
        const name = free.get(keyOf(shape))?.pop()
        if (name !== undefined) return Effect.succeed(name)
        const TableName = `${prefix}-${Date.now()}-${count++}`
        return send(() =>
          raw.send(new CreateTableCommand({ TableName, BillingMode: "PAY_PER_REQUEST", ...shape })),
        ).pipe(
          Effect.map(() => {
            made.add(TableName)
            return TableName
          }),
        )
      }),
    give: (name, shape) =>
      send(() =>
        empty(raw, name, shape).then(
          () => {
            const key = keyOf(shape)
            free.set(key, [...(free.get(key) ?? []), name])
          },
          () => {
            made.delete(name)
            return raw.send(new DeleteTableCommand({ TableName: name })).then(
              () => undefined,
              () => undefined,
            )
          },
        ),
      ),
    drain: async () => {
      const names = [...made]
      made.clear()
      free.clear()
      await Promise.all(
        names.map((TableName) =>
          raw.send(new DeleteTableCommand({ TableName })).catch(() => undefined),
        ),
      )
    },
  }
}
