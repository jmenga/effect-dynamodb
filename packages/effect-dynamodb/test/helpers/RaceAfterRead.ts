/**
 * The window between an op's read and its write, opened against a real client (#132): `body`
 * runs on a client that, straight after the read of the chosen kind returns, runs `concurrent`
 * (on the undecorated client, as another process would) before the op continues. The op's read
 * is then the stale one.
 */

import { Effect } from "effect"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"
import type * as Table from "../../src/Table.js"

/** The reads a race can follow: a `GetItem`, or a `Query` (purge and cascade read with one). */
export type RaceRead = "getItem" | "query"

type Context = DynamoClient | Table.TableConfig

/**
 * Run `body` with `concurrent` landing after its first read of kind `on` (default `getItem`).
 * With `every`, `concurrent` runs after every such read, given how many ran before it: an op
 * that retries from a fresh read loses each attempt.
 */
export const raceAfterRead = <A, E>(
  concurrent:
    | Effect.Effect<unknown, unknown, Context>
    | ((n: number) => Effect.Effect<unknown, unknown, Context>),
  body: Effect.Effect<A, E, Context>,
  options: { readonly on?: RaceRead; readonly every?: boolean } = {},
): Effect.Effect<A, E, Context> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Context>()
    const real = yield* DynamoClient
    const on = options.on ?? "getItem"
    let fired = 0
    const after = <B, F>(read: Effect.Effect<B, F>): Effect.Effect<B, F> =>
      read.pipe(
        Effect.tap(() => {
          if (fired > 0 && options.every !== true) return Effect.void
          const n = fired++
          const write = typeof concurrent === "function" ? concurrent(n) : concurrent
          return write.pipe(Effect.provide(context), Effect.orDie)
        }),
      )
    const racing: DynamoClientService =
      on === "getItem"
        ? { ...real, getItem: (...args) => after(real.getItem(...args)) }
        : { ...real, query: (...args) => after(real.query(...args)) }
    return yield* body.pipe(Effect.provideService(DynamoClient, racing))
  })

/** {@link raceAfterRead} after the first `GetItem`: the window a plan's read opens. */
export const raceAfterFirstRead = <A, E>(
  concurrent: Effect.Effect<unknown, unknown, Context>,
  body: Effect.Effect<A, E, Context>,
): Effect.Effect<A, E, Context> => raceAfterRead(concurrent, body)
