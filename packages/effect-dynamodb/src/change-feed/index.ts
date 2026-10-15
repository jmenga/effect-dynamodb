/**
 * `effect-dynamodb/change-feed` — a polled change feed over DynamoDB Streams,
 * for consumers outside Lambda and EventBridge Pipes: a long-running service,
 * a container, an edge device running DynamoDB Local.
 *
 * Needs `@aws-sdk/client-dynamodb-streams` (an optional peer dependency); the
 * main `effect-dynamodb` entry never imports it.
 *
 * @example
 * ```typescript
 * import { DynamoClient, EventStore } from "effect-dynamodb"
 * import {
 *   CheckpointStore,
 *   changeFeed,
 *   DynamoStreamsClient,
 *   runChangeFeed,
 * } from "effect-dynamodb/change-feed"
 *
 * const program = runChangeFeed(changeFeed({ streamArn }), {
 *   projections: { summaries: OrderSummaryProjection },
 * })
 *
 * program.pipe(
 *   Effect.provide(CheckpointStore.layerDynamoDB({ tableName: "checkpoints" })),
 *   Effect.provide(DynamoStreamsClient.layer({ region: "us-east-1" })),
 *   Effect.provide(DynamoClient.layer({ region: "us-east-1" })),
 * )
 * ```
 *
 * @module
 */

export {
  type ChangeFeedBatch,
  type ChangeFeedError,
  type ChangeFeedLeaseOptions,
  type ChangeFeedOptions,
  type ChangeFeedRecord,
  changeFeed,
  type RunChangeFeedOptions,
  runChangeFeed,
  type StartingPosition,
} from "./ChangeFeed.js"
export {
  CheckpointStore,
  type CheckpointStoreService,
  type DynamoDBCheckpointStoreOptions,
  type FeedId,
  type ShardCheckpoint,
} from "./CheckpointStore.js"
export {
  DynamoStreamsClient,
  type DynamoStreamsClientConfig,
  type DynamoStreamsClientConfigFromConfig,
  type DynamoStreamsClientError,
  type DynamoStreamsClientService,
} from "./DynamoStreamsClient.js"
export {
  ChangeFeedLeaseHeld,
  ChangeFeedLeaseLost,
  ChangeFeedTrimmed,
  CheckpointStoreError,
  ShardIteratorExpired,
  StreamDataTrimmed,
} from "./Errors.js"
