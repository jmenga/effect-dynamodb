/**
 * A `DynamoClient` over another one whose requests a test can hold: `around` sees every request
 * before it is sent and decides when it is sent and when its answer comes back. With `Deferred`s it
 * forces an interleaving of concurrent fibers — one visit's write landing between another's read and
 * its write, a scan segment answered after a move — so a test of one interleaving runs it every time,
 * where a real table meets it only now and then.
 */

import { Deferred, Effect, Layer } from "effect"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"

/** One request: its operation (`getItem`, `transactWriteItems`, …), its input, and the call. */
export type Around = (
  command: keyof DynamoClientService,
  input: any,
  send: Effect.Effect<any, any>,
) => Effect.Effect<any, any>

export const gatedClient = (inner: DynamoClientService, around: Around): DynamoClientService => {
  const gated: Record<string, unknown> = {}
  for (const [name, call] of Object.entries(inner)) {
    gated[name] = (input: unknown, ...rest: ReadonlyArray<unknown>) =>
      around(
        name as keyof DynamoClientService,
        input,
        (call as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>)(
          input,
          ...rest,
        ),
      )
  }
  // Every operation of `inner`, each wrapped: the same service.
  return gated as unknown as DynamoClientService
}

export const gatedLayer = (inner: DynamoClientService, around: Around): Layer.Layer<DynamoClient> =>
  Layer.succeed(DynamoClient, gatedClient(inner, around))

/** The keys a transaction's items write: `pk|sk` of each Put, Delete and Update. */
export const transactKeys = (input: any): ReadonlyArray<string> =>
  (input?.TransactItems ?? []).flatMap((op: any) => {
    const key = op.Put?.Item ?? op.Delete?.Key ?? op.Update?.Key
    return key === undefined ? [] : [`${key.pk?.S}|${key.sk?.S}`]
  })

/** Whether a transaction puts a row at `pk` (and `sk`, when given). */
export const putsAt = (input: any, pk: string, sk?: string): boolean =>
  (input?.TransactItems ?? []).some(
    (op: any) => op.Put?.Item?.pk?.S === pk && (sk === undefined || op.Put?.Item?.sk?.S === sk),
  )

/** Whether a transaction deletes the row at `pk` (and `sk`, when given). */
export const deletesAt = (input: any, pk: string, sk?: string): boolean =>
  (input?.TransactItems ?? []).some(
    (op: any) => op.Delete?.Key?.pk?.S === pk && (sk === undefined || op.Delete?.Key?.sk?.S === sk),
  )

/**
 * One order, forced (#240): a pass reads a sentinel's current key before another pass's move puts
 * the sentinel there, and its old key after the move landed, while the move's answer is held. The
 * holder's pass is the fiber whose first read of either key is `current` (the moving pass reads
 * `old`, its own current key, first). The move (the first transaction putting at `current`) waits
 * until that pass has read `current`; the pass's read of `old` waits until the move has landed; the
 * move's answer waits until the pass has read `current` again. `wait` gives up on a step that never
 * comes (yields on the test clock, a timeout on DynamoDB Local), so a broken order fails the test's
 * assertions rather than hanging it. `order` says whether the pass's reads fell either side.
 */
export const moveAnswerHeld = (
  keys: { readonly current: string; readonly old: string },
  wait: (deferred: Deferred.Deferred<void>) => Effect.Effect<unknown>,
): Effect.Effect<{
  readonly around: Around
  readonly order: () => { readonly readBefore: boolean; readonly readAfter: boolean }
}> =>
  Effect.gen(function* () {
    const firstRead = new Map<number, string>()
    const holderRead = yield* Deferred.make<void>()
    const landed = yield* Deferred.make<void>()
    const readAgain = yield* Deferred.make<void>()
    let readBefore = false
    let readAfter = false
    let moved = false
    const around: Around = (command, input, send) => {
      if (command === "getItem") {
        const pk = input?.Key?.pk?.S
        if (pk !== keys.current && pk !== keys.old) return send
        return Effect.flatMap(Effect.fiberId, (fiber) => {
          if (!firstRead.has(fiber)) firstRead.set(fiber, pk)
          if (firstRead.get(fiber) !== keys.current) return send
          if (pk === keys.current) {
            return Effect.tap(send, () => {
              if (Deferred.isDoneUnsafe(landed)) return Deferred.succeed(readAgain, undefined)
              readBefore = true
              return Deferred.succeed(holderRead, undefined)
            })
          }
          return wait(landed).pipe(
            Effect.andThen(
              Effect.sync(() => {
                readAfter = Deferred.isDoneUnsafe(landed)
              }),
            ),
            Effect.andThen(send),
          )
        })
      }
      if (command !== "transactWriteItems" || moved || !putsAt(input, keys.current)) return send
      moved = true
      return wait(holderRead).pipe(
        Effect.andThen(send),
        Effect.tap(() => Deferred.succeed(landed, undefined)),
        Effect.tap(() => wait(readAgain)),
      )
    }
    return { around, order: () => ({ readBefore, readAfter }) }
  })
