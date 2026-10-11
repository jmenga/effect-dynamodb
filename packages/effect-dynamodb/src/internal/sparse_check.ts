/**
 * Type-level verification of `Entity.set` and the entity-scoped `.set`.
 * This file is NOT shipped — it exists solely for `pnpm check` validation.
 *
 * A partial update of a GSI's composites is valid: GSI keys are recomposed
 * per half (`DESIGN.md` §7). A half whose composites the update gives is
 * recomposed (truncated to the leading composites given, where it can be); a
 * half it does not touch is left as stored; a half it touches but cannot
 * compose follows the index's policy (`'sparse'` removes the key, `'preserve'`
 * leaves it). So the update payload `U` is a plain partial of the model minus
 * its primary-key composites, and no combination of GSI composites is a type
 * or runtime error. (Until the per-half policy, a GSI's composites had to be
 * updated all together or not at all; that rule is gone.)
 *
 * Typing:
 * - Data-first: `Entity.set(self, updates)` checks `updates` against the
 *   update's `U` (`NoInfer<U>`).
 * - Data-last: `.pipe(Entity.set(updates))` takes any record
 *   (`Updates extends Record<string, unknown>`); the module-level dual cannot
 *   see `U` before `self` is known (see the Ref / HashMap comparison below).
 * - Entity-scoped: `Employees.set(...)` pre-binds `U` from the entity
 *   definition, so both forms are checked.
 */
import { Effect, HashMap, pipe, Ref, Schema } from "effect"
import * as Entity from "../Entity.js"

class Employee extends Schema.Class<Employee>("Employee")({
  employeeId: Schema.String,
  name: Schema.NonEmptyString,
  tenantId: Schema.String,
  region: Schema.String,
}) {}

const Employees = Entity.make({
  model: Employee,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk" as const, composite: ["employeeId"] as const },
    sk: { field: "sk" as const, composite: [] as const },
  },
  indexes: {
    byTenant: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["tenantId"] },
      sk: { field: "gsi1sk", composite: ["region"] },
    },
  },
})

// -----------------------------------------------------------------------
// DATA-FIRST: Entity.set(self, updates)
// Any subset of a GSI's composites is a valid update: each GSI half is
// recomposed from what is given (per-half policy, DESIGN.md §7).
// -----------------------------------------------------------------------

// Partial GSI composites: tenantId without region — recomposes gsi1pk only
Entity.set(Employees.update({ employeeId: "e-1" }), { tenantId: "t-3" })

// All GSI composites
Entity.set(Employees.update({ employeeId: "e-1" }), { tenantId: "t-3", region: "us-east-1" })

// No GSI composites
Entity.set(Employees.update({ employeeId: "e-1" }), { name: "Alice" as any })

// -----------------------------------------------------------------------
// PIPE PATH: .pipe(Entity.set({ ... }))
// -----------------------------------------------------------------------

// Partial GSI composites: recomposes the gsi1pk half; gsi1sk is untouched
const _pipePartial = Effect.gen(function* () {
  yield* Employees.update({ employeeId: "e-1" }).pipe(
    Entity.set({ tenantId: "t-3" }),
    Entity.asModel,
  )
})

// GOOD: all GSI composites in pipe
const _pipeGood1 = Effect.gen(function* () {
  yield* Employees.update({ employeeId: "e-1" }).pipe(
    Entity.set({ tenantId: "t-3", region: "us-east-1" }),
    Entity.asModel,
  )
})

// GOOD: no GSI composites in pipe
const _pipeGood2 = Effect.gen(function* () {
  yield* Employees.update({ employeeId: "e-1" }).pipe(Entity.set({ name: "Alice" }), Entity.asModel)
})

// -----------------------------------------------------------------------
// PIPE CHAIN: Entity.set → Effect.map → Effect.catchTag composes cleanly
// -----------------------------------------------------------------------

// Partial GSI in a pipe chain — valid; ValidationError stays in the union
// (decode / encode), so catchTag on it compiles. .asEffect() crosses the
// entity-op/Effect boundary before Effect combinators.
const _pipeChainPartial = Effect.gen(function* () {
  const result: string = yield* Employees.update({ employeeId: "e-1" }).pipe(
    Entity.set({ tenantId: "t-3" }),
    (op) => op.asEffect(),
    Effect.map(() => "unexpected success"),
    Effect.catchTag("ValidationError", (e) => Effect.succeed(`Caught ValidationError: ${e.cause}`)),
  )
  return result
})

// Full pipe chain with all GSI composites — .asEffect() at the boundary
const _pipeChainGood = Effect.gen(function* () {
  const result: string = yield* Employees.update({ employeeId: "e-1" }).pipe(
    Entity.set({ tenantId: "t-3", region: "us-east-1" }),
    Entity.expectedVersion(1),
    (op) => op.asEffect(),
    Effect.map(() => "success"),
    Effect.catchTag("OptimisticLockError", () => Effect.succeed("lock failed")),
  )
  return result
})

// -----------------------------------------------------------------------
// CORE EFFECT COMPARISON — why Ref.set / HashMap.set catch data-last
// mismatches but Entity.set cannot
// -----------------------------------------------------------------------

// Ref.set: shared type parameter A — invariant container catches mismatches
const _refExample = Effect.gen(function* () {
  const ref = yield* Ref.make<"red" | "blue">("red")

  // Data-first: TYPE ERROR — "green" not in "red" | "blue"
  // @ts-expect-error
  yield* Ref.set(ref, "green")

  // Data-last: ALSO TYPE ERROR — Ref<"red"|"blue"> not assignable to Ref<"green">
  // The shared A is inferred as "green" from the argument, then self (Ref<"red"|"blue">)
  // is checked — Ref is invariant, so the mismatch is caught.
  // @ts-expect-error
  yield* pipe(ref, Ref.set("green"))
})

// HashMap.set: shared type parameters K, V — invariant container catches mismatches
const _hashMapExample = Effect.gen(function* () {
  const map = HashMap.make(["a", 1], ["b", 2]) // HashMap<string, number>

  // Data-first: TYPE ERROR — "hello" is not number
  // @ts-expect-error
  HashMap.set(map, "c", "hello")

  // Data-last: ALSO TYPE ERROR — HashMap<string, number> not assignable to HashMap<string, string>
  // V is inferred as string from "hello", then self (HashMap<string, number>) is checked.
  // @ts-expect-error
  pipe(map, HashMap.set("c", "hello"))
})

// Entity.set: WHY it's different — U is a partial, and it is phantom
//
// If Entity.set used the Ref/HashMap pattern (shared U parameter), then
// Entity.set({ name: "Alice" }) would infer U = { name: string }, and the
// piped self's U (every optional field of the model) would have to match it
// exactly — a false positive for every update that sets fewer fields than the
// model has. So the module-level Entity.set takes
// `Updates extends Record<string, unknown>` in data-last; the entity-scoped
// `.set` below is the checked form.

// -----------------------------------------------------------------------
// ENTITY-SCOPED SET: Employees.set()
// -----------------------------------------------------------------------
// Each Entity instance exposes a `.set` dual where U is pre-bound from the
// entity definition, so data-first and data-last are both checked.

// DATA-FIRST: partial GSI composites — valid, recomposed per half
Employees.set(Employees.update({ employeeId: "e-1" }), { tenantId: "t-3" })

// DATA-LAST: partial GSI composites — valid, recomposed per half
const _entityScopedPartial = Effect.gen(function* () {
  yield* Employees.update({ employeeId: "e-1" }).pipe(
    Employees.set({ tenantId: "t-3" }),
    Entity.asModel,
  )
})

// GOOD: all GSI composites in entity-scoped pipe
const _entityScopedGood1 = Effect.gen(function* () {
  yield* Employees.update({ employeeId: "e-1" }).pipe(
    Employees.set({ tenantId: "t-3", region: "us-east-1" }),
    Entity.asModel,
  )
})

// GOOD: no GSI composites in entity-scoped pipe
const _entityScopedGood2 = Effect.gen(function* () {
  yield* Employees.update({ employeeId: "e-1" }).pipe(
    Employees.set({ name: "Alice" }),
    Entity.asModel,
  )
})

// PIPE CHAIN: Entity-scoped set composes with Effect.map/catchTag
const _entityScopedChain = Effect.gen(function* () {
  const result: string = yield* Employees.update({ employeeId: "e-1" }).pipe(
    Employees.set({ tenantId: "t-3", region: "us-east-1" }),
    Employees.expectedVersion(1),
    (op) => op.asEffect(),
    Effect.map(() => "success"),
    Effect.catchTag("OptimisticLockError", () => Effect.succeed("lock failed")),
  )
  return result
})

void _pipePartial
void _pipeGood1
void _pipeGood2
void _pipeChainPartial
void _pipeChainGood
void _refExample
void _hashMapExample
void _entityScopedPartial
void _entityScopedGood1
void _entityScopedGood2
void _entityScopedChain
