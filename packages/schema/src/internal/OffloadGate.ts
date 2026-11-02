/**
 * @internal TEST-ONLY. The "not yet supported" gate of offloaded storage
 * (#179, `docs/designs/blob-offload.md` §21).
 *
 * Offloaded storage is built over several commits, and no intermediate one may
 * write a value it cannot read or settle. So until the commit that wires the
 * last write path, a member configured with `DynamoModel.Packed({ external })`
 * or `DynamoModel.External(...)` is refused where it is defined —
 * `Entity.make` and `EventStore.makeStream` — after every configuration guard
 * has run. The tests of the commits in between lift the refusal by defining
 * such members with {@link OffloadGate} set to `true` in the fiber that runs
 * the definition:
 *
 * ```ts
 * const Documents = Effect.runSync(
 *   Effect.sync(() => Entity.make({ ... })).pipe(Effect.provideService(OffloadGate, true)),
 * )
 * ```
 *
 * The gate is a `Context.Reference` (default `false`) read synchronously from
 * the current fiber, since the definitions it guards are synchronous. It is
 * not exported from any entry point, and the commit that wires the last write
 * path deletes it together with the refusal.
 */

import { Context, Fiber } from "effect"

/** `true` lifts the refusal for definitions run in this fiber (tests only). */
export const OffloadGate: Context.Reference<boolean> = Context.Reference<boolean>(
  "@effect-dynamodb/internal/OffloadGate",
  { defaultValue: () => false },
)

/** Whether the definition running now may declare offloaded storage. */
const offloadAllowed = (): boolean => Fiber.getCurrent()?.getRef(OffloadGate) ?? false

/**
 * Refuse a member that declares offloaded storage, unless {@link OffloadGate}
 * is set in the current fiber. `fields` names what the member offloads.
 */
export const refuseUnsupportedOffload = (member: string, fields: ReadonlyArray<string>): void => {
  if (fields.length === 0 || offloadAllowed()) return
  throw new Error(
    `${member}: offloaded storage (DynamoModel.Packed({ external }) / DynamoModel.External) ` +
      `is not yet supported by this version of effect-dynamodb — offloaded: ${fields.join(", ")}.`,
  )
}
