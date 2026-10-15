/**
 * Errors of the `effect-dynamodb/change-feed` subpath.
 *
 * They are raised only by this subpath, so they live beside it rather than in
 * the AWS-free `@effect-dynamodb/schema` package.
 *
 * @module
 */

import { Data } from "effect"

/**
 * `GetRecords` was given a shard iterator older than 15 minutes
 * (`ExpiredIteratorException`). The change feed re-acquires one from the
 * shard's position; a direct caller of {@link DynamoStreamsClient} sees it.
 */
export class ShardIteratorExpired extends Data.TaggedError("ShardIteratorExpired")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/**
 * The requested position is older than the stream's 24-hour retention
 * (`TrimmedDataAccessException`): records between it and the trim horizon were
 * lost. The change feed raises it as {@link ChangeFeedTrimmed}.
 */
export class StreamDataTrimmed extends Data.TaggedError("StreamDataTrimmed")<{
  readonly operation: string
  readonly cause: unknown
}> {}

/**
 * A shard's position is past the stream's retention: the records between the
 * checkpoint and the trim horizon were lost. Rebuild what the feed maintains,
 * then clear the consumer's checkpoints to start over.
 */
export class ChangeFeedTrimmed extends Data.TaggedError("ChangeFeedTrimmed")<{
  readonly streamArn: string
  readonly shardId: string
  /** The last acknowledged sequence number — `undefined` before any. */
  readonly sequenceNumber: string | undefined
  readonly cause: unknown
}> {}

/** Another process holds the feed's lease. */
export class ChangeFeedLeaseHeld extends Data.TaggedError("ChangeFeedLeaseHeld")<{
  readonly streamArn: string
  readonly consumer: string
  /** The holder's owner id — `undefined` when it could not be read. */
  readonly owner: string | undefined
  /** When the holder's lease expires (epoch ms) — `undefined` when unknown. */
  readonly expiresAt: number | undefined
}> {}

/** The feed's lease was taken over by another process while this one ran. */
export class ChangeFeedLeaseLost extends Data.TaggedError("ChangeFeedLeaseLost")<{
  readonly streamArn: string
  readonly consumer: string
  readonly owner: string
}> {}

/** A checkpoint store operation failed. */
export class CheckpointStoreError extends Data.TaggedError("CheckpointStoreError")<{
  readonly operation: string
  readonly cause: unknown
}> {}
