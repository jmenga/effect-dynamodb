/**
 * What an aggregate write sent, in the form fixtures recorded before #168 hold it
 * (`docs/designs/aggregate-concurrency.md`). Those fixtures pin what a published release sent, and
 * #168 changed exactly these things about it, each by design:
 *
 * - `update`'s partition read is strongly consistent on a base-table collection (D11
 *   reversed), and `delete`'s second read is too: `ConsistentRead` is left out of every `Query`.
 * - Every row a write sends is guarded, asking for `ALL_OLD` on a failed condition (§3.2), and a
 *   fenced or versioned write checks its root (§3.4): conditions, `ReturnValuesOnConditionCheckFailure`,
 *   `ConditionCheck`s and a versioned root's `Update` are left out of every transaction.
 * - The groups of a write go in one transaction when they fit (D3), the root's first: consecutive
 *   transactions are joined into one, and its items compared as a set (sorted).
 * - `update` sends only the rows that changed (D2): a `Put` of a row exactly as it was stored before
 *   the write (`stored`) is left out. A row the published release rewrote in a newer stored form
 *   (an rc-era date map, a native value of a field now packed) is not left out: such a test says so.
 * - `update` deletes only the rows it read, each guarded as read (§3.2): a `Delete` of a key no
 *   `stored` row holds is left out.
 * - `delete` reads its partition once more after its batches (§3.8, the sweep): a `Query` straight
 *   after a `BatchWriteItem` is left out when it is consistent (a base-table collection).
 *
 * Applied to both sides of a comparison, so what's left is everything else a request holds.
 */

import type { Outcome, Sent } from "./InheritedNames.js"
import { expectRequestsSince132 } from "./Since132.js"

/** A recorded request: `{ op, input }` (`op` in lower camel case) or `{ command, input }`. */
type Recorded = { readonly op?: string; readonly command?: string; readonly input?: any }

const nameOf = (request: Recorded): string => {
  const name = request.op ?? request.command ?? ""
  return name.charAt(0).toLowerCase() + name.slice(1)
}

/** JSON text with every object's keys sorted: one value, one text. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, held) =>
    held !== null && typeof held === "object" && !Array.isArray(held)
      ? Object.fromEntries(Object.entries(held).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : typeof held === "bigint"
        ? `${held}n`
        : held,
  )

const GUARD_FIELDS = [
  "ConditionExpression",
  "ExpressionAttributeNames",
  "ExpressionAttributeValues",
  "ReturnValuesOnConditionCheckFailure",
] as const

const unguarded = (action: Record<string, unknown>): Record<string, unknown> => {
  const rest: Record<string, unknown> = { ...action }
  for (const field of GUARD_FIELDS) delete rest[field]
  return rest
}

export const asBefore168 = <R extends Recorded>(
  requests: ReadonlyArray<R>,
  options: {
    /** The rows stored before the write: a `Put` of one exactly as stored is left out. */
    readonly stored?: Iterable<unknown> | undefined
    /** What a row is compared as, when a `Put` is matched with `stored` (a stamp left out). */
    readonly same?: ((row: any) => unknown) | undefined
  } = {},
): ReadonlyArray<R> => {
  const same = options.same ?? ((row: unknown) => row)
  const storedRows = [...(options.stored ?? [])] as ReadonlyArray<Record<string, unknown>>
  const stored = new Set(storedRows.map((row) => canonical(same(row))))
  /** Whether a stored row holds the key, when the rows stored are known. */
  const held = (key: Record<string, unknown>): boolean =>
    options.stored === undefined ||
    storedRows.some((row) =>
      Object.entries(key).every(([name, value]) => canonical(row[name]) === canonical(value)),
    )
  const out: Array<R> = []
  let transaction: { request: R; items: Array<Record<string, unknown>> } | undefined
  const close = () => {
    if (transaction === undefined) return
    const items = transaction.items
      .filter(
        (item) =>
          !(item.Put !== undefined && stored.has(canonical(same((item.Put as any).Item)))) &&
          !(item.Delete !== undefined && !held((item.Delete as any).Key)),
      )
      .sort((a, b) => {
        const x = canonical(a)
        const y = canonical(b)
        return x < y ? -1 : x > y ? 1 : 0
      })
    if (items.length > 0) {
      out.push({
        ...transaction.request,
        input: { ...transaction.request.input, TransactItems: items },
      })
    }
    transaction = undefined
  }
  let previous: string | undefined
  for (const request of requests) {
    const name = nameOf(request)
    if (name === "transactWriteItems") {
      const items = ((request.input?.TransactItems ?? []) as Array<Record<string, any>>).flatMap(
        (item): Array<Record<string, unknown>> => {
          if (item.ConditionCheck !== undefined || item.Update !== undefined) return []
          if (item.Put !== undefined) return [{ ...item, Put: unguarded(item.Put) }]
          if (item.Delete !== undefined) return [{ ...item, Delete: unguarded(item.Delete) }]
          return [item]
        },
      )
      if (transaction === undefined) transaction = { request, items }
      else transaction.items.push(...items)
      previous = name
      continue
    }
    close()
    // `delete`'s sweep, consistent on a base-table collection; a `Query` after the batches
    // that isn't is the next step's read.
    if (
      name === "query" &&
      previous === "batchWriteItem" &&
      request.input?.ConsistentRead === true
    ) {
      previous = name
      continue
    }
    if (name === "query" && request.input?.ConsistentRead !== undefined) {
      const { ConsistentRead: _, ...input } = request.input
      out.push({ ...request, input })
    } else {
      out.push(request)
    }
    previous = name
  }
  close()
  return out
}

/** A row without `stamp`, which a write stamps. */
const withoutStamp = (row: Record<string, unknown>, stamp: string): Record<string, unknown> => {
  const { [stamp]: _, ...rest } = row
  return rest
}

/**
 * The rows a published release left after a write, as #168 leaves them: a row it rewrote unchanged
 * but for its `stamp` (#168, D2: such a row isn't sent) holds what `stored` held before the write.
 */
export const keptStamps = <R extends Record<string, any>>(
  rows: ReadonlyArray<R>,
  stored: ReadonlyArray<R>,
  stamp = "updatedAt",
): ReadonlyArray<R> =>
  rows.map(
    (row) =>
      stored.find(
        (was) =>
          canonical(was.pk) === canonical(row.pk) &&
          canonical(was.sk) === canonical(row.sk) &&
          canonical(withoutStamp(was, stamp)) === canonical(withoutStamp(row, stamp)),
      ) ?? row,
  )

/** A table's rows by `pk` / `sk`, as a run of requests leaves them. */
const keyOf = (item: Record<string, unknown>): string =>
  canonical({ pk: item.pk ?? null, sk: item.sk ?? null })

/** {@link asBefore168Run}'s pass over `requests`, with `rows` as the requests before them left them. */
const runFrom = <R extends Recorded>(
  rows: Map<string, Record<string, unknown>>,
  requests: ReadonlyArray<R>,
  same: ((row: any) => unknown) | undefined,
): ReadonlyArray<R> => {
  const out: Array<R> = []
  // One request at a time, against the rows the ones before it left; consecutive transactions are
  // then joined, as `asBefore168` joins them.
  for (const request of requests) {
    const name = nameOf(request)
    out.push(
      ...(name === "transactWriteItems"
        ? asBefore168([request], { stored: [...rows.values()], same })
        : [request]),
    )
    const input = request.input ?? {}
    const put = (item: Record<string, unknown>) => rows.set(keyOf(item), item)
    const remove = (key: Record<string, unknown>) => rows.delete(keyOf(key))
    if (name === "transactWriteItems") {
      for (const item of input.TransactItems ?? []) {
        if (item.Put !== undefined) put(item.Put.Item)
        if (item.Delete !== undefined) remove(item.Delete.Key)
        if (item.Update !== undefined) remove(item.Update.Key)
      }
    } else if (name === "putItem") put(input.Item)
    else if (name === "deleteItem" || name === "updateItem") remove(input.Key)
    else if (name === "batchWriteItem") {
      for (const writes of Object.values(input.RequestItems ?? {}) as Array<Array<any>>) {
        for (const write of writes) {
          if (write.PutRequest !== undefined) put(write.PutRequest.Item)
          if (write.DeleteRequest !== undefined) remove(write.DeleteRequest.Key)
        }
      }
    }
  }
  return asBefore168(out)
}

/**
 * {@link asBefore168} over a whole run of steps on one `pk` / `sk` table, from an empty table: the
 * rows each request finds stored are those the requests before it left (each `Put`, `Delete`,
 * `PutItem`, `DeleteItem` and `BatchWriteItem` applied in order; a row an `UpdateItem` touched is
 * taken as unknown, so a later `Put` of it is never left out). For a recorded run that holds every
 * request made on its table, where no rows are known beside it.
 */
export const asBefore168Run = <R extends Recorded>(
  requests: ReadonlyArray<R>,
  options: { readonly same?: ((row: any) => unknown) | undefined } = {},
): ReadonlyArray<R> => runFrom(new Map(), requests, options.same)

/**
 * A recorded run (`{ requests, sentBy }`: every request, and the commands each step sent) as
 * {@link asBefore168Run} has it, step by step: each step's requests joined only among themselves.
 */
export const runAsBefore168 = <
  O extends {
    readonly requests: ReadonlyArray<Recorded>
    readonly sentBy?: Readonly<Record<string, ReadonlyArray<string>>> | undefined
  },
>(
  outcome: O,
  options: { readonly same?: ((row: any) => unknown) | undefined } = {},
): O => {
  if (outcome.sentBy === undefined) {
    return { ...outcome, requests: asBefore168Run(outcome.requests, options) }
  }
  const rows = new Map<string, Record<string, unknown>>()
  const requests: Array<Recorded> = []
  const sentBy: Record<string, ReadonlyArray<string>> = {}
  let at = 0
  for (const [label, commands] of Object.entries(outcome.sentBy)) {
    const step = runFrom(rows, outcome.requests.slice(at, at + commands.length), options.same)
    at += commands.length
    requests.push(...step)
    sentBy[label] = step.map((request) => request.command ?? request.op ?? "")
  }
  return { ...outcome, requests, sentBy }
}

/**
 * Two recorded runs of one case (this release's, a published one's), each as
 * {@link runAsBefore168} has it: step by step when both say what each step sent, else each whole
 * (a `Query` after `delete`'s batches is then its sweep when it's consistent).
 */
type Run = {
  readonly requests: ReadonlyArray<Recorded>
  readonly sentBy?: Readonly<Record<string, ReadonlyArray<string>>> | undefined
}

export const runsAsBefore168 = <N extends Run, W extends Run>(now: N, was: W): readonly [N, W] =>
  now.sentBy !== undefined && was.sentBy !== undefined
    ? [runAsBefore168(now), runAsBefore168(was)]
    : [wholeAsBefore168(now), wholeAsBefore168(was)]

/**
 * A run as {@link asBefore168Run} has it whole, its `sentBy` (where it says what each step sent)
 * kept in step with its requests: each step holds what the run up to its end gives past what the
 * run up to the step before gave (a transaction joined across a step boundary is the earlier step's).
 */
const wholeAsBefore168 = <R extends Run>(run: R): R => {
  const requests = asBefore168Run(run.requests)
  if (run.sentBy === undefined) return { ...run, requests }
  const sentBy: Record<string, ReadonlyArray<string>> = {}
  let end = 0
  let given = 0
  for (const [label, commands] of Object.entries(run.sentBy)) {
    end += commands.length
    const upTo = asBefore168Run(run.requests.slice(0, end)).length
    sentBy[label] = requests
      .slice(given, upTo)
      .map((request) => request.command ?? request.op ?? "")
    given = upTo
  }
  return { ...run, requests, sentBy }
}

/**
 * Assert what a run sent is what a published release recorded, but for #132's changes
 * (`expectRequestsSince132`) and #168's (`runsAsBefore168`): #168's are taken out of both sides
 * first, then #132's are compared as `expectRequestsSince132` compares them.
 */
export const expectRequestsSince168 = (
  received: Outcome,
  recorded: {
    readonly requests?: ReadonlyArray<Sent> | undefined
    readonly sentBy?: Run["sentBy"]
  },
): void => {
  const [now, was] = runsAsBefore168(received, {
    requests: recorded.requests ?? [],
    sentBy: recorded.sentBy,
  })
  expectRequestsSince132(now, was)
}
