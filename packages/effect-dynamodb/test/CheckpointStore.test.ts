/**
 * The change feed's checkpoint stores (#156): the in-memory store, and the
 * DynamoDB-table store's requests and error mapping against a mocked client
 * (its behaviour against real conditions is in the connected suite).
 */

import type {
  DeleteItemCommandOutput,
  GetItemCommandOutput,
  PutItemCommandInput,
  PutItemCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
} from "@aws-sdk/client-dynamodb"
import { describe, expect, it } from "@effect/vitest"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { CheckpointStore } from "../src/change-feed/index.js"
import { mockDynamoClientLayer, mockOutput } from "./helpers/MockDynamoClient.js"

const feed = { streamArn: "arn:stream", consumer: "app" }

const conditionFailed = (operation: string) =>
  new DynamoError({
    operation,
    cause: Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" }),
  })

describe("CheckpointStore", () => {
  describe("in memory", () => {
    it.effect("keeps checkpoints per feed", () =>
      Effect.gen(function* () {
        const store = CheckpointStore.makeMemory()
        yield* store.commit(feed, "s1", { _tag: "Sequence", sequenceNumber: "1" })
        yield* store.commit(feed, "s1", { _tag: "Sequence", sequenceNumber: "2" })
        yield* store.commit(feed, "s2", { _tag: "Finished" })
        yield* store.commit({ ...feed, consumer: "other" }, "s1", { _tag: "Finished" })
        const loaded = yield* store.load(feed)
        expect([...loaded.entries()]).toEqual([
          ["s1", { _tag: "Sequence", sequenceNumber: "2" }],
          ["s2", { _tag: "Finished" }],
        ])
      }),
    )

    it.effect("leases expire on the clock", () =>
      Effect.gen(function* () {
        const store = CheckpointStore.makeMemory()
        yield* store.acquireLease(feed, "a", Duration.seconds(30))
        // Re-acquiring your own lease extends it.
        yield* store.acquireLease(feed, "a", Duration.seconds(30))
        const held = yield* Effect.flip(store.acquireLease(feed, "b", Duration.seconds(30)))
        expect(held).toMatchObject({ _tag: "ChangeFeedLeaseHeld", owner: "a", expiresAt: 30_000 })
        yield* store.renewLease(feed, "a", Duration.seconds(30))
        yield* TestClock.adjust("31 seconds")
        yield* store.acquireLease(feed, "b", Duration.seconds(30))
        const lost = yield* Effect.flip(store.renewLease(feed, "a", Duration.seconds(30)))
        expect(lost).toMatchObject({ _tag: "ChangeFeedLeaseLost", owner: "a" })
        // Releasing someone else's lease does nothing.
        yield* store.releaseLease(feed, "a")
        yield* Effect.flip(store.acquireLease(feed, "a", Duration.seconds(30)))
        yield* store.releaseLease(feed, "b")
        yield* store.acquireLease(feed, "a", Duration.seconds(30))
      }),
    )
  })

  describe("DynamoDB", () => {
    it("refuses a finishedTtl shorter than 28 hours", () => {
      expect(() =>
        CheckpointStore.makeDynamoDB({ tableName: "t", finishedTtl: "27 hours" }),
      ).toThrow(/\[EDD-9084\].*finishedTtl/)
      expect(() =>
        CheckpointStore.layerDynamoDB({ tableName: "t", finishedTtl: "1 hour" }),
      ).toThrow(/EDD-9084/)
      expect(() =>
        CheckpointStore.makeDynamoDB({ tableName: "t", finishedTtl: "28 hours" }),
      ).not.toThrow()
      expect(() => CheckpointStore.makeDynamoDB({ tableName: "t" })).not.toThrow()
      expect(Duration.toMillis(CheckpointStore.minFinishedTtl)).toBe(28 * 60 * 60 * 1000)
    })

    it("tableDefinition is pk/sk strings, on demand", () => {
      expect(CheckpointStore.tableDefinition("checkpoints")).toEqual({
        TableName: "checkpoints",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      })
    })

    it.effect("commits and loads checkpoints, paginating the partition", () =>
      Effect.gen(function* () {
        const puts: Array<PutItemCommandInput> = []
        const queries: Array<QueryCommandInput> = []
        const layer = mockDynamoClientLayer({
          putItem: (input) => {
            puts.push(input)
            return Effect.succeed(mockOutput<PutItemCommandOutput>({}))
          },
          query: (input) => {
            queries.push(input)
            return Effect.succeed(
              mockOutput<QueryCommandOutput>(
                input.ExclusiveStartKey === undefined
                  ? {
                      Items: [
                        {
                          pk: { S: "app#arn:stream" },
                          sk: { S: "shard#s1" },
                          sequenceNumber: { S: "9" },
                        },
                      ],
                      LastEvaluatedKey: { pk: { S: "app#arn:stream" }, sk: { S: "shard#s1" } },
                    }
                  : {
                      Items: [
                        {
                          pk: { S: "app#arn:stream" },
                          sk: { S: "shard#s2" },
                          finished: { BOOL: true },
                        },
                      ],
                    },
              ),
            )
          },
        })
        const store = yield* CheckpointStore.makeDynamoDB({ tableName: "checkpoints" }).pipe(
          Effect.provide(layer),
        )
        yield* TestClock.setTime(1_000_000)
        yield* store.commit(feed, "s1", { _tag: "Sequence", sequenceNumber: "9" })
        yield* store.commit(feed, "s2", { _tag: "Finished" })
        expect(puts.map((p) => p.Item)).toEqual([
          {
            pk: { S: "app#arn:stream" },
            sk: { S: "shard#s1" },
            updatedAt: { N: "1000000" },
            sequenceNumber: { S: "9" },
          },
          {
            pk: { S: "app#arn:stream" },
            sk: { S: "shard#s2" },
            updatedAt: { N: "1000000" },
            finished: { BOOL: true },
            ttl: { N: String(1000 + 2 * 24 * 60 * 60) },
          },
        ])
        const loaded = yield* store.load(feed)
        expect([...loaded.entries()]).toEqual([
          ["s1", { _tag: "Sequence", sequenceNumber: "9" }],
          ["s2", { _tag: "Finished" }],
        ])
        expect(queries).toHaveLength(2)
        expect(queries[0]?.ConsistentRead).toBe(true)
      }),
    )

    it.effect("a held lease reports its holder; a failed renewal is a lost lease", () =>
      Effect.gen(function* () {
        const layer = mockDynamoClientLayer({
          putItem: () => Effect.fail(conditionFailed("PutItem")),
          getItem: () =>
            Effect.succeed(
              mockOutput<GetItemCommandOutput>({
                Item: { owner: { S: "other" }, expiresAt: { N: "123" } },
              }),
            ),
          updateItem: () => Effect.fail(conditionFailed("UpdateItem")),
          deleteItem: () => Effect.fail(conditionFailed("DeleteItem")),
        })
        const store = yield* CheckpointStore.makeDynamoDB({ tableName: "checkpoints" }).pipe(
          Effect.provide(layer),
        )
        const held = yield* Effect.flip(store.acquireLease(feed, "me", Duration.seconds(30)))
        expect(held).toMatchObject({
          _tag: "ChangeFeedLeaseHeld",
          streamArn: "arn:stream",
          consumer: "app",
          owner: "other",
          expiresAt: 123,
        })
        const lost = yield* Effect.flip(store.renewLease(feed, "me", Duration.seconds(30)))
        expect(lost).toMatchObject({ _tag: "ChangeFeedLeaseLost", owner: "me" })
        // Releasing a lease someone else holds is not an error.
        yield* store.releaseLease(feed, "me")
      }),
    )

    it.effect("other client failures are CheckpointStoreErrors", () =>
      Effect.gen(function* () {
        const boom = new DynamoError({ operation: "X", cause: new Error("boom") })
        const layer = mockDynamoClientLayer({
          putItem: () => Effect.fail(boom),
          query: () => Effect.fail(boom),
          updateItem: () => Effect.fail(boom),
          deleteItem: () => Effect.succeed(mockOutput<DeleteItemCommandOutput>({})),
        })
        const store = yield* CheckpointStore.makeDynamoDB({ tableName: "checkpoints" }).pipe(
          Effect.provide(layer),
        )
        for (const error of [
          yield* Effect.flip(store.commit(feed, "s1", { _tag: "Finished" })),
          yield* Effect.flip(store.load(feed)),
          yield* Effect.flip(store.acquireLease(feed, "me", Duration.seconds(1))),
          yield* Effect.flip(store.renewLease(feed, "me", Duration.seconds(1))),
        ]) {
          expect(error).toMatchObject({ _tag: "CheckpointStoreError", cause: boom })
        }
        yield* store.releaseLease(feed, "me")
      }),
    )
  })
})
