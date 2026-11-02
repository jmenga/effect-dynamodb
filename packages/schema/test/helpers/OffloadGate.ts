/**
 * Test-only: define members that offload, lifting the "not yet supported"
 * refusal through the internal gate (`src/internal/OffloadGate.ts`, design
 * §21). Deleted with the gate.
 */
import { Effect } from "effect"
import { OffloadGate } from "../../src/internal/OffloadGate.js"

/** Run a synchronous definition with the offload gate open. */
export const withOffloadGate = <A>(define: () => A): A =>
  Effect.runSync(Effect.sync(define).pipe(Effect.provideService(OffloadGate, true)))
