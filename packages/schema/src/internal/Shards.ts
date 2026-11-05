/**
 * @internal The shard function and marker of a sharded index (#183,
 * `docs/designs/gsi-write-sharding.md` §2–§3).
 *
 * Golden vectors pin both: stored index keys depend on them, so changing either
 * is a breaking change.
 */

import { Data } from "effect"

/** The largest `shards` count (`[EDD-9099]`, design §10.1). */
export const MAX_SHARD_COUNT = 256

/**
 * `[EDD-9100]`: a sharded index's partition key half can't be composed because
 * the shard source is missing. There is no unsharded fallback, so the write is
 * not made.
 */
export class ShardSourceError extends Data.TaggedError("ShardSourceError")<{
  readonly message: string
}> {}

/** Is `u` a {@link ShardSourceError}? By its tag, as `isKeyValueError` is. */
export const isShardSourceError = (u: unknown): u is ShardSourceError =>
  typeof u === "object" && u !== null && (u as { _tag?: unknown })._tag === "ShardSourceError"

const encoder = new TextEncoder()

/**
 * The case fold of a source value's text: every spelling the key text treats as
 * one value, under either casing, folds to the same text (design §3).
 * `toLowerCase` first: `toUpperCase` first maps `ß` to `SS` and `ẞ` to `ẞ`,
 * which lowercase to `ss` and `ß`, though both of them are one key.
 */
export const foldShardText = (text: string): string => text.toLowerCase().toUpperCase()

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193
/** Never occurs in UTF-8, so values can't run into each other. */
const SEPARATOR = 0xff

/**
 * FNV-1a-32 over the source values' folded UTF-8, in source order, each pair
 * separated by byte `0xFF`.
 */
export const shardHash = (texts: ReadonlyArray<string>): number => {
  let hash = FNV_OFFSET
  texts.forEach((text, i) => {
    if (i > 0) {
      hash ^= SEPARATOR
      hash = Math.imul(hash, FNV_PRIME) >>> 0
    }
    for (const byte of encoder.encode(foldShardText(text))) {
      hash ^= byte
      hash = Math.imul(hash, FNV_PRIME) >>> 0
    }
  })
  return hash >>> 0
}

/** The shard `texts` land on, of `count`. */
export const shardOf = (texts: ReadonlyArray<string>, count: number): number =>
  shardHash(texts) % count

/**
 * The marker a sharded partition key carries right after its entity type or
 * collection name: `!<count>.<shard>`, the shard zero-padded to the width of
 * `count - 1`. Before every value, it can't be spelled by one: an unsharded
 * key's fourth segment always holds `<label>_`, and the count in it keeps two
 * layouts' shards apart (design §2.1).
 */
export const shardMarker = (count: number, shard: number): string =>
  `!${count}.${String(shard).padStart(String(count - 1).length, "0")}`
