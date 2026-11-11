/**
 * A `DynamoClient` over another one whose requests a test can hold: `around` sees every request
 * before it is sent and decides when it is sent and when its answer comes back. With `Deferred`s it
 * forces an interleaving of concurrent fibers — one visit's write landing between another's read and
 * its write, a scan segment answered after a move — so a test of one interleaving runs it every time,
 * where a real table meets it only now and then.
 */

import { type Effect, Layer } from "effect"
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
