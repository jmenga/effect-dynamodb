/**
 * CheckpointStore — where a change feed keeps its per-shard checkpoints and
 * its lease. Two implementations: in memory, and a DynamoDB table.
 *
 * @module
 */

import type { AttributeValue, CreateTableCommandInput } from "@aws-sdk/client-dynamodb"
import { isAwsConditionalCheckFailed } from "@effect-dynamodb/schema/Errors.js"
import { Clock, Context, Duration, Effect, Layer, Option } from "effect"
import { DynamoClient, type DynamoClientError } from "../DynamoClient.js"
import { ChangeFeedLeaseHeld, ChangeFeedLeaseLost, CheckpointStoreError } from "./Errors.js"

/**
 * One consumer of one stream: the unit a checkpoint and a lease belong to.
 * `consumer` names the application, so several applications can consume one
 * stream with one checkpoint table.
 */
export interface FeedId {
  readonly streamArn: string
  readonly consumer: string
}

/**
 * A shard's checkpoint: the last sequence number whose record was
 * acknowledged, or `Finished` once the shard closed and every record was
 * acknowledged (or, at a fresh `LATEST` start, when it was closed already).
 */
export type ShardCheckpoint =
  | { readonly _tag: "Sequence"; readonly sequenceNumber: string }
  | { readonly _tag: "Finished" }

/** The operations a change feed needs from its checkpoint store. */
export interface CheckpointStoreService {
  /** Every shard checkpoint of the feed, by shard id. */
  readonly load: (
    feed: FeedId,
  ) => Effect.Effect<ReadonlyMap<string, ShardCheckpoint>, CheckpointStoreError>
  /** Record a shard's checkpoint. */
  readonly commit: (
    feed: FeedId,
    shardId: string,
    checkpoint: ShardCheckpoint,
  ) => Effect.Effect<void, CheckpointStoreError>
  /**
   * Take the feed's lease for `duration` — when there is none, it expired, or
   * `owner` holds it already.
   */
  readonly acquireLease: (
    feed: FeedId,
    owner: string,
    duration: Duration.Duration,
  ) => Effect.Effect<void, ChangeFeedLeaseHeld | CheckpointStoreError>
  /** Extend `owner`'s lease by `duration` from now; fails when another owner holds it. */
  readonly renewLease: (
    feed: FeedId,
    owner: string,
    duration: Duration.Duration,
  ) => Effect.Effect<void, ChangeFeedLeaseLost | CheckpointStoreError>
  /** Give up `owner`'s lease (nothing when another owner holds it). */
  readonly releaseLease: (feed: FeedId, owner: string) => Effect.Effect<void, CheckpointStoreError>
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

/** A checkpoint store held in memory — for tests and single-process feeds that may start over. */
export const makeMemory = (): CheckpointStoreService => {
  const checkpoints = new Map<string, Map<string, ShardCheckpoint>>()
  const leases = new Map<string, { owner: string; expiresAt: number }>()
  const keyOf = (feed: FeedId) => `${feed.consumer}#${feed.streamArn}`
  return {
    load: (feed) =>
      Effect.sync(
        () => new Map(checkpoints.get(keyOf(feed)) ?? new Map<string, ShardCheckpoint>()),
      ),
    commit: (feed, shardId, checkpoint) =>
      Effect.sync(() => {
        const key = keyOf(feed)
        const shards = checkpoints.get(key) ?? new Map<string, ShardCheckpoint>()
        shards.set(shardId, checkpoint)
        checkpoints.set(key, shards)
      }),
    acquireLease: (feed, owner, duration) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const held = leases.get(keyOf(feed))
        if (held !== undefined && held.owner !== owner && held.expiresAt > now) {
          return yield* new ChangeFeedLeaseHeld({
            streamArn: feed.streamArn,
            consumer: feed.consumer,
            owner: held.owner,
            expiresAt: held.expiresAt,
          })
        }
        leases.set(keyOf(feed), { owner, expiresAt: now + Duration.toMillis(duration) })
      }),
    renewLease: (feed, owner, duration) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const held = leases.get(keyOf(feed))
        if (held === undefined || held.owner !== owner) {
          return yield* new ChangeFeedLeaseLost({
            streamArn: feed.streamArn,
            consumer: feed.consumer,
            owner,
          })
        }
        leases.set(keyOf(feed), { owner, expiresAt: now + Duration.toMillis(duration) })
      }),
    releaseLease: (feed, owner) =>
      Effect.sync(() => {
        if (leases.get(keyOf(feed))?.owner === owner) leases.delete(keyOf(feed))
      }),
  }
}

// ---------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------

/** Options of {@link makeDynamoDB}. */
export interface DynamoDBCheckpointStoreOptions {
  /** The checkpoint table — see {@link tableDefinition} for its key schema. */
  readonly tableName: string
  /**
   * How long a `Finished` checkpoint is kept (its `ttl` attribute, honoured
   * when TTL is enabled on the table). A closed shard leaves the stream 24
   * hours after it closes. Default: 2 days.
   */
  readonly finishedTtl?: Duration.Input | undefined
}

const SHARD_PREFIX = "shard#"
const LEASE_SK = "lease"

/**
 * The checkpoint table's `CreateTable` input: `pk` (S, HASH) + `sk` (S, RANGE),
 * on-demand billing. A shard checkpoint is `{ pk: "<consumer>#<streamArn>",
 * sk: "shard#<shardId>", sequenceNumber | finished, updatedAt, ttl? }`; the
 * lease is `{ pk, sk: "lease", owner, expiresAt }`. Enable TTL on `ttl` to
 * expire `Finished` checkpoints.
 */
export const tableDefinition = (
  tableName: string,
): CreateTableCommandInput & { readonly TableName: string } => ({
  TableName: tableName,
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

const storeError =
  (operation: string) =>
  (cause: DynamoClientError): CheckpointStoreError =>
    new CheckpointStoreError({ operation, cause })

const isConditionFailed = (error: DynamoClientError): boolean =>
  isAwsConditionalCheckFailed(error.cause)

/** A checkpoint store on a DynamoDB table, through `DynamoClient`. */
export const makeDynamoDB = (
  options: DynamoDBCheckpointStoreOptions,
): Effect.Effect<CheckpointStoreService, never, DynamoClient> =>
  Effect.gen(function* () {
    const client = yield* DynamoClient
    const TableName = options.tableName
    const finishedTtlSeconds = Math.ceil(
      Duration.toMillis(Duration.fromInputUnsafe(options.finishedTtl ?? "2 days")) / 1000,
    )
    const pkOf = (feed: FeedId): AttributeValue => ({ S: `${feed.consumer}#${feed.streamArn}` })
    const leaseKey = (feed: FeedId) => ({ pk: pkOf(feed), sk: { S: LEASE_SK } })

    const load = (feed: FeedId) =>
      Effect.gen(function* () {
        const shards = new Map<string, ShardCheckpoint>()
        let ExclusiveStartKey: Record<string, AttributeValue> | undefined
        do {
          const page = yield* client
            .query({
              TableName,
              KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
              ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
              ExpressionAttributeValues: { ":pk": pkOf(feed), ":prefix": { S: SHARD_PREFIX } },
              ConsistentRead: true,
              ...(ExclusiveStartKey === undefined ? {} : { ExclusiveStartKey }),
            })
            .pipe(Effect.mapError(storeError("CheckpointStore.load")))
          for (const item of page.Items ?? []) {
            const shardId = item.sk?.S?.slice(SHARD_PREFIX.length)
            if (shardId === undefined) continue
            if (item.finished?.BOOL === true) shards.set(shardId, { _tag: "Finished" })
            else if (item.sequenceNumber?.S !== undefined) {
              shards.set(shardId, { _tag: "Sequence", sequenceNumber: item.sequenceNumber.S })
            }
          }
          ExclusiveStartKey = page.LastEvaluatedKey
        } while (ExclusiveStartKey !== undefined)
        return shards as ReadonlyMap<string, ShardCheckpoint>
      })

    const commit = (feed: FeedId, shardId: string, checkpoint: ShardCheckpoint) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const Item: Record<string, AttributeValue> = {
          pk: pkOf(feed),
          sk: { S: `${SHARD_PREFIX}${shardId}` },
          updatedAt: { N: String(now) },
          ...(checkpoint._tag === "Finished"
            ? {
                finished: { BOOL: true },
                ttl: { N: String(Math.floor(now / 1000) + finishedTtlSeconds) },
              }
            : { sequenceNumber: { S: checkpoint.sequenceNumber } }),
        }
        yield* client
          .putItem({ TableName, Item })
          .pipe(Effect.mapError(storeError("CheckpointStore.commit")))
      })

    const readLease = (feed: FeedId) =>
      client.getItem({ TableName, Key: leaseKey(feed), ConsistentRead: true }).pipe(
        Effect.map((result) =>
          Option.fromNullishOr(result.Item).pipe(
            Option.map((item) => ({
              owner: item.owner?.S,
              expiresAt: item.expiresAt?.N === undefined ? undefined : Number(item.expiresAt.N),
            })),
          ),
        ),
        Effect.mapError(storeError("CheckpointStore.acquireLease")),
      )

    const acquireLease = (feed: FeedId, owner: string, duration: Duration.Duration) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const result = yield* client
          .putItem({
            TableName,
            Item: {
              ...leaseKey(feed),
              owner: { S: owner },
              expiresAt: { N: String(now + Duration.toMillis(duration)) },
            },
            ConditionExpression:
              "attribute_not_exists(#pk) OR #owner = :owner OR #expiresAt < :now",
            ExpressionAttributeNames: { "#pk": "pk", "#owner": "owner", "#expiresAt": "expiresAt" },
            ExpressionAttributeValues: { ":owner": { S: owner }, ":now": { N: String(now) } },
          })
          .pipe(Effect.result)
        if (result._tag === "Success") return
        if (!isConditionFailed(result.failure)) {
          return yield* storeError("CheckpointStore.acquireLease")(result.failure)
        }
        const held = yield* readLease(feed)
        return yield* new ChangeFeedLeaseHeld({
          streamArn: feed.streamArn,
          consumer: feed.consumer,
          owner: Option.isSome(held) ? held.value.owner : undefined,
          expiresAt: Option.isSome(held) ? held.value.expiresAt : undefined,
        })
      })

    const renewLease = (feed: FeedId, owner: string, duration: Duration.Duration) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const result = yield* client
          .updateItem({
            TableName,
            Key: leaseKey(feed),
            UpdateExpression: "SET #expiresAt = :expiresAt",
            ConditionExpression: "#owner = :owner",
            ExpressionAttributeNames: { "#owner": "owner", "#expiresAt": "expiresAt" },
            ExpressionAttributeValues: {
              ":owner": { S: owner },
              ":expiresAt": { N: String(now + Duration.toMillis(duration)) },
            },
          })
          .pipe(Effect.result)
        if (result._tag === "Success") return
        if (isConditionFailed(result.failure)) {
          return yield* new ChangeFeedLeaseLost({
            streamArn: feed.streamArn,
            consumer: feed.consumer,
            owner,
          })
        }
        return yield* storeError("CheckpointStore.renewLease")(result.failure)
      })

    const releaseLease = (feed: FeedId, owner: string) =>
      client
        .deleteItem({
          TableName,
          Key: leaseKey(feed),
          ConditionExpression: "#owner = :owner",
          ExpressionAttributeNames: { "#owner": "owner" },
          ExpressionAttributeValues: { ":owner": { S: owner } },
        })
        .pipe(
          Effect.asVoid,
          Effect.catchIf(isConditionFailed, () => Effect.void),
          Effect.mapError(storeError("CheckpointStore.releaseLease")),
        )

    return { load, commit, acquireLease, renewLease, releaseLease } satisfies CheckpointStoreService
  })

/**
 * Effect `Context.Service` for the change feed's checkpoint store.
 *
 * @example
 * ```typescript
 * import { CheckpointStore } from "effect-dynamodb/change-feed"
 *
 * // In memory (tests, or a feed that may start over)
 * const Memory = CheckpointStore.layerMemory
 * // In a DynamoDB table (needs DynamoClient)
 * const Durable = CheckpointStore.layerDynamoDB({ tableName: "change-feed-checkpoints" })
 * ```
 */
export class CheckpointStore extends Context.Service<CheckpointStore, CheckpointStoreService>()(
  "@effect-dynamodb/CheckpointStore",
) {
  /** A fresh in-memory store per layer build; its lease is process-local. */
  static readonly layerMemory: Layer.Layer<CheckpointStore> = Layer.sync(
    CheckpointStore,
    makeMemory,
  )

  /** A store on a DynamoDB table — see {@link tableDefinition}. */
  static readonly layerDynamoDB = (
    options: DynamoDBCheckpointStoreOptions,
  ): Layer.Layer<CheckpointStore, never, DynamoClient> =>
    Layer.effect(CheckpointStore, makeDynamoDB(options))

  /** {@link tableDefinition}: the checkpoint table's `CreateTable` input. */
  static readonly tableDefinition = tableDefinition

  /** {@link makeMemory}: an in-memory store, as a value. */
  static readonly makeMemory = makeMemory

  /** {@link makeDynamoDB}: a DynamoDB-table store, as a value. */
  static readonly makeDynamoDB = makeDynamoDB
}
