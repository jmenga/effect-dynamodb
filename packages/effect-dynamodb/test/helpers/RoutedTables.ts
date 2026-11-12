/**
 * Several tables in memory behind one client, a `RecordingTable` per physical table name: each
 * request goes to the table it names. A transaction spanning tables is one transaction, as on
 * DynamoDB: every table's part is applied or none is, and a cancellation reports each entry's
 * reason at its position in the request (#237). A projection's row and its outbox items are one
 * transaction across two tables when its outbox is on another table, and the library reads the
 * reasons by position.
 */

import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer } from "effect"
import { DynamoClient } from "../../src/DynamoClient.js"
import { makeRecordingTable } from "./RecordingTable.js"

type RecordingTable = ReturnType<typeof makeRecordingTable>
type Entry = Record<string, { readonly TableName?: string }>

/** The table an entry of a transaction names. */
const tableOfEntry = (entry: Entry): string => String(Object.values(entry)[0]?.TableName)

/**
 * Tables made on first use, each with `options` (its keys and secondary indexes), or the options
 * `options` gives its name; `first` answers a request naming no table.
 */
export const makeRoutedTables = (
  options?:
    | Parameters<typeof makeRecordingTable>[0]
    | ((name: string) => Parameters<typeof makeRecordingTable>[0]),
  first = "t",
) => {
  const byName = new Map<string, RecordingTable>()
  const named = (name: string): RecordingTable => {
    const known = byName.get(name)
    if (known !== undefined) return known
    const made = makeRecordingTable(typeof options === "function" ? options(name) : options)
    byName.set(name, made)
    return made
  }
  const base = named(first)
  /**
   * Every request, in the order sent, each once and whole: a transaction spanning tables is one
   * request, however many tables' parts it was answered by.
   */
  const sent: Array<{ readonly command: string; readonly input: any }> = []
  const record = (command: string, input: unknown) =>
    sent.push({ command, input: structuredClone(input) })
  /** `operation`'s command name, as `RecordingTable` records it: `getItem` → `GetItem`. */
  const commandOf = (operation: string) => operation.charAt(0).toUpperCase() + operation.slice(1)

  /** `input`'s entries by table, each with its position in the request. */
  const groupsOf = (input: { readonly TransactItems?: ReadonlyArray<Entry> }) => {
    const groups = new Map<string, Array<readonly [position: number, entry: Entry]>>()
    for (const [position, entry] of (input.TransactItems ?? []).entries()) {
      const name = tableOfEntry(entry)
      groups.set(name, [...(groups.get(name) ?? []), [position, entry] as const])
    }
    return groups
  }

  const transactWriteItems = (input: any) =>
    Effect.suspend(() => {
      const groups = groupsOf(input)
      const before = new Map([...groups.keys()].map((name) => [name, new Map(named(name).items)]))
      const restore = () => {
        for (const [name, items] of before) {
          const table = named(name)
          table.items.clear()
          for (const [key, item] of items) table.items.set(key, item)
        }
      }
      return Effect.forEach([...groups], ([name, entries]) =>
        Effect.mapError(
          (named(name).client as any).transactWriteItems({
            ...input,
            TransactItems: entries.map(([, entry]) => entry),
          }) as Effect.Effect<unknown, unknown>,
          (error) => ({ error, entries }),
        ),
      ).pipe(
        Effect.as({}),
        Effect.catch(({ error, entries }) => {
          restore()
          const cause = (error as { readonly cause?: { readonly name?: string } })?.cause
          const reasons = (cause as { readonly CancellationReasons?: ReadonlyArray<unknown> })
            ?.CancellationReasons
          if (cause?.name !== "TransactionCanceledException" || reasons === undefined) {
            return Effect.fail(error)
          }
          // Each entry's reason at its position in the whole request.
          const whole: Array<unknown> = (input.TransactItems ?? []).map(() => ({ Code: "None" }))
          for (const [i, [position]] of entries.entries()) whole[position] = reasons[i]
          return Effect.fail(
            new DynamoError({
              operation: "TransactWriteItems",
              cause: Object.assign(new Error("Transaction cancelled"), {
                name: "TransactionCanceledException",
                CancellationReasons: whole,
              }),
            }),
          )
        }),
      )
    })

  const transactGetItems = (input: any) =>
    Effect.gen(function* () {
      const responses: Array<unknown> = (input.TransactItems ?? []).map(() => ({}))
      for (const [name, entries] of groupsOf(input)) {
        const answer = (yield* (named(name).client as any).transactGetItems({
          ...input,
          TransactItems: entries.map(([, entry]) => entry),
        })) as { readonly Responses?: ReadonlyArray<unknown> }
        for (const [i, [position]] of entries.entries()) {
          responses[position] = answer.Responses?.[i] ?? {}
        }
      }
      return { Responses: responses }
    })

  const client = new Proxy(base.client, {
    get: (target, operation) => {
      const value = (target as any)[operation]
      if (typeof value !== "function") return value
      if (operation === "transactWriteItems") {
        return (input: any) => {
          record("TransactWriteItems", input)
          return transactWriteItems(input)
        }
      }
      if (operation === "transactGetItems") {
        return (input: any) => {
          record("TransactGetItems", input)
          return transactGetItems(input)
        }
      }
      return (input: any) => {
        record(commandOf(String(operation)), input)
        const name = input.TableName ?? Object.keys(input.RequestItems ?? {})[0] ?? first
        return (named(String(name)).client as any)[operation](input)
      }
    },
  })

  return {
    client,
    layer: Layer.succeed(DynamoClient, client),
    /** The recording table named `name`. */
    table: named,
    /**
     * The requests sent to any table since the last call, in order, a transaction once however
     * many tables it spans, and forget them (each table's own record too).
     */
    take: () => {
      for (const table of byName.values()) table.take()
      return sent.splice(0, sent.length)
    },
    /** Every table's items, by table. */
    snapshot: () =>
      new Map([...byName].map(([name, table]) => [name, new Map(table.items)] as const)),
  }
}
