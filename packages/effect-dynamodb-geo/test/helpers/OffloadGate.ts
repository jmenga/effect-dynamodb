/**
 * Test-only: define members that offload, lifting the "not yet supported"
 * refusal through the library's internal gate (`@effect-dynamodb/schema`'s
 * `internal/OffloadGate.ts`, design §21). This package sees effect-dynamodb
 * through its public entry point only, so the gate is read by its key.
 * Deleted with the gate.
 */
import { Context, Effect } from "effect"

/** `@effect-dynamodb/schema`'s test-only `internal/OffloadGate.ts`, by its key. */
export const OffloadGate = Context.Reference<boolean>("@effect-dynamodb/internal/OffloadGate", {
  defaultValue: () => false,
})

/** Run a synchronous definition with the offload gate open. */
export const withOffloadGate = <A>(define: () => A): A =>
  Effect.runSync(Effect.sync(define).pipe(Effect.provideService(OffloadGate, true)))
