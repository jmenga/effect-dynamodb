/**
 * @internal `BatchGetItem` by key, results in input order — shared by
 * `Batch.get` and the hydration of a stream index that does not project the
 * events it indexes (`EventStore.makeStream({ indexes: { …, projection: "keys" } })`
 * on a GSI, read through `Query`'s `hydration` hook).
 *
 * - Chunks of 100 keys (DynamoDB's `BatchGetItem` limit).
 * - `UnprocessedKeys` are retried with exponential backoff (`baseDelayMs`,
 *   doubling); when `maxRetries` run out the call fails with `DynamoError`
 *   (`operation: "BatchGetItem"`).
 * - `BatchGetItem` does not preserve order, so responses are matched back to
 *   their keys through a `Map` on the key attribute values.
 * - With `rereadMissing`, keys absent from every response are read once more
 *   with `ConsistentRead: true` — an eventually consistent table read can lag
 *   a GSI that already holds the entry.
 *
 * Keys are sent as given. Callers pass keys that are unique within one
 * request — a page of one stream's index never repeats a key — and a repeated
 * key is not de-duplicated: DynamoDB rejects the request ("Provided list of
 * item keys contains duplicates"), and the rejection is diagnosed (#144) as a
 * `DynamoError` naming both positions (`describe`), DynamoDB's error kept as
 * the cause.
 */

import type { AttributeValue, KeysAndAttributes } from "@aws-sdk/client-dynamodb"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect } from "effect"
import type { DynamoClientError, DynamoClientService } from "../DynamoClient.js"
import {
  diagnoseFailure,
  type TransactItemTarget,
  transactItemTarget,
  withCause,
} from "./WriteDiagnosis.js"

/** DynamoDB's limit on the keys of one `BatchGetItem` request. */
export const MAX_BATCH_GET = 100
/** Default retries of `UnprocessedKeys`. */
export const MAX_RETRIES = 5
/** Default first backoff delay, doubled on each retry. */
export const BASE_DELAY_MS = 100

/** One key to fetch: the table and the item's full primary key. */
export interface HydrateRequest {
  readonly tableName: string
  readonly key: Record<string, AttributeValue>
}

export interface HydrateOptions {
  /** A `ProjectionExpression` (and its names) sent for every table. */
  readonly projection?:
    | { readonly expression: string; readonly names: Record<string, string> }
    | undefined
  readonly maxRetries?: number | undefined
  readonly baseDelayMs?: number | undefined
  /** Re-read keys missing from the responses once, strongly consistently. */
  readonly rereadMissing?: boolean | undefined
  /**
   * The entity a request reads and how to name it in an error (`get 2
   * (User)`), for a rejection of a repeated key. Default: `request <i>`.
   */
  readonly describe?:
    | ((position: number) => { readonly entityType: string; readonly source: string })
    | undefined
}

/** A key attribute value, as a string that is equal iff the values are. */
const scalarIdentity = (value: AttributeValue | undefined): string => {
  if (value === undefined) return "-"
  if (value.S !== undefined) return `S${value.S}`
  if (value.N !== undefined) return `N${value.N}`
  if (value.B !== undefined) return `B${Array.from(value.B).join(",")}`
  return `J${JSON.stringify(value)}`
}

const identity = (
  tableName: string,
  names: ReadonlyArray<string>,
  item: Record<string, AttributeValue>,
): string =>
  [tableName, ...names.map((name) => `${name}=${scalarIdentity(item[name])}`)].join("\u0000")

/**
 * Fetch `requests` and return the raw items in input order, `undefined` where
 * an item does not exist.
 */
export const batchGetRaw = (
  client: DynamoClientService,
  requests: ReadonlyArray<HydrateRequest>,
  options: HydrateOptions = {},
): Effect.Effect<Array<Record<string, AttributeValue> | undefined>, DynamoClientError> =>
  Effect.gen(function* () {
    const results: Array<Record<string, AttributeValue> | undefined> = new Array(
      requests.length,
    ).fill(undefined)
    if (requests.length === 0) return results

    const maxRetries = options.maxRetries ?? MAX_RETRIES
    const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS

    /** The sorted key attribute names of each request, and its identity. */
    const keyNames = requests.map((request) => Object.keys(request.key).sort())
    const identities = requests.map((request, i) =>
      identity(request.tableName, keyNames[i]!, request.key),
    )

    /**
     * The item each key of a sent request reads, in request order, named by
     * its position (a repeated key's occurrences by successive positions).
     */
    const repeatTargets = (
      sentItems: Record<string, KeysAndAttributes>,
    ): ReadonlyArray<TransactItemTarget> => {
      const seen = new Map<string, number>()
      return Object.entries(sentItems).flatMap(([tableName, entry]) =>
        (entry.Keys ?? []).map((key) => {
          const names = Object.keys(key).sort()
          const id = identity(tableName, names, key)
          const occurrence = seen.get(id) ?? 0
          seen.set(id, occurrence + 1)
          const positions = identities.flatMap((candidate, i) => (candidate === id ? [i] : []))
          const position = positions[Math.min(occurrence, positions.length - 1)]
          const described =
            position === undefined
              ? { entityType: "unknown", source: "a request" }
              : (options.describe?.(position) ?? {
                  entityType: "unknown",
                  source: `request ${position}`,
                })
          return transactItemTarget(
            { Get: { TableName: tableName, Key: key } },
            tableName,
            names,
            described.entityType,
            described.source,
          )
        }),
      )
    }

    /** Fetch the requests at `positions`, filling `results`. */
    const fetch = (positions: ReadonlyArray<number>, consistentRead: boolean) =>
      Effect.gen(function* () {
        for (let start = 0; start < positions.length; start += MAX_BATCH_GET) {
          const chunk = positions.slice(start, start + MAX_BATCH_GET)
          const pending = new Map<string, Array<number>>()
          /** Per table: the distinct key-name lists its keys use. */
          const tableKeyNames = new Map<string, Map<string, ReadonlyArray<string>>>()
          let requestItems: Record<string, KeysAndAttributes> = {}
          for (const position of chunk) {
            const request = requests[position]!
            const id = identities[position]!
            // A repeated key is still sent: DynamoDB rejects a request whose
            // keys repeat ("Provided list of item keys contains duplicates"),
            // and that rejection passes through — the helper does not quietly
            // de-duplicate. The positions are grouped only for matching.
            const waiting = pending.get(id)
            if (waiting !== undefined) waiting.push(position)
            else pending.set(id, [position])
            const names = keyNames[position]!
            let lists = tableKeyNames.get(request.tableName)
            if (lists === undefined) {
              lists = new Map()
              tableKeyNames.set(request.tableName, lists)
            }
            lists.set(names.join("\u0000"), names)
            let entry = requestItems[request.tableName]
            if (entry === undefined) {
              entry = {
                Keys: [],
                ...(consistentRead ? { ConsistentRead: true } : {}),
                ...(options.projection === undefined
                  ? {}
                  : {
                      ProjectionExpression: options.projection.expression,
                      ExpressionAttributeNames: options.projection.names,
                    }),
              }
              requestItems[request.tableName] = entry
            }
            entry.Keys!.push(request.key)
          }

          let retries = 0
          while (Object.keys(requestItems).length > 0) {
            const sentItems = requestItems
            const response = yield* client.batchGetItem({ RequestItems: sentItems }).pipe(
              // A key repeated in one request (#144): DynamoDB's rejection,
              // confirmed and named by the positions that read it.
              diagnoseFailure({
                sent: () => ({ _tag: "BatchGet", targets: () => repeatTargets(sentItems) }),
                only: ["RepeatedItem"],
                rewrite: (diagnosis, original) =>
                  diagnosis._tag !== "RepeatedItem"
                    ? (original as DynamoClientError)
                    : new DynamoError({
                        operation: "BatchGetItem",
                        cause: withCause(
                          `BatchGetItem reads one item more than once — ` +
                            `${diagnosis.first.source} and ${diagnosis.second.source} both ` +
                            `read the item at ${diagnosis.second.key}. DynamoDB allows each key ` +
                            "once in a request, and rejected it. Read the item once.",
                          original,
                        ),
                      }),
              }),
            )

            for (const [tableName, items] of Object.entries(response.Responses ?? {})) {
              const lists = tableKeyNames.get(tableName)
              if (lists === undefined) continue
              for (const item of items) {
                for (const names of lists.values()) {
                  const matched = pending.get(identity(tableName, names, item))
                  if (matched === undefined) continue
                  for (const position of matched) results[position] = item
                  break
                }
              }
            }

            const unprocessed: Record<string, KeysAndAttributes> = {}
            for (const [tableName, entry] of Object.entries(response.UnprocessedKeys ?? {})) {
              if (entry.Keys !== undefined && entry.Keys.length > 0) {
                // Keep what the original request asked for (consistency,
                // projection) — only the keys change.
                unprocessed[tableName] = { ...requestItems[tableName], Keys: entry.Keys }
              }
            }
            if (Object.keys(unprocessed).length === 0) break

            retries++
            if (retries > maxRetries) {
              return yield* new DynamoError({
                operation: "BatchGetItem",
                cause: new Error(`Unprocessed keys remain after ${maxRetries} retries`),
              })
            }
            yield* Effect.sleep(`${baseDelayMs * 2 ** (retries - 1)} millis`)
            requestItems = unprocessed
          }
        }
      })

    yield* fetch(
      requests.map((_, i) => i),
      false,
    )
    if (options.rereadMissing === true) {
      const missing: Array<number> = []
      for (let i = 0; i < results.length; i++) if (results[i] === undefined) missing.push(i)
      if (missing.length > 0) yield* fetch(missing, true)
    }
    return results
  })
