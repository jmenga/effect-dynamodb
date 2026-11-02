/**
 * Test-only: define members that offload, lifting the "not yet supported"
 * refusal through the internal gate (`@effect-dynamodb/schema`'s
 * `internal/OffloadGate.ts`, design §21). Deleted with the gate.
 */
import { OffloadGate } from "@effect-dynamodb/schema/internal/OffloadGate.js"
import { Effect } from "effect"

/** Run a synchronous definition with the offload gate open. */
export const withOffloadGate = <A>(define: () => A): A =>
  Effect.runSync(Effect.sync(define).pipe(Effect.provideService(OffloadGate, true)))
