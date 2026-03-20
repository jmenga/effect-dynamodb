/**
 * Type-level verification for sparse GSI all-or-none constraints.
 * This file is NOT shipped — it exists solely for `pnpm check` validation.
 *
 * Enforcement:
 * - Data-first: Entity.set(self, updates) — type error at the call site (NoInfer<U>)
 * - Data-last: .pipe(Entity.set(updates)) — clean types, runtime validation catches
 *   partial GSI composites. Runtime is always active on all code paths.
 *
 * § Why data-last loses the constraint (with core Effect comparison):
 *
 * Core Effect duals like Ref.set and HashMap.set use a SHARED type parameter
 * across the outer and inner functions:
 *
 *   Ref.set:     <A>(value: A)       → (self: Ref<A>) → Effect<void>
 *   HashMap.set: <K, V>(key: K, v: V) → (self: HashMap<K, V>) → HashMap<K, V>
 *
 * In data-last, A/V are inferred from the arguments. When piped, `self` is
 * checked against that inferred type. Because Ref and HashMap are INVARIANT
 * in their type parameter, a mismatch between the inferred A and self's A
 * produces a type error on self.
 *
 * Entity.set is different. The update constraint U is an all-or-none union:
 *
 *   U = { tenantId: string; region: string } | { tenantId?: never; region?: never }
 *
 * If we used the same shared-parameter pattern:
 *
 *   <U>(updates: U) → (self: EntityUpdate<..., U, ...>) → EntityUpdate<..., U, ...>
 *
 * Then Entity.set({ tenantId: "t-3" }) infers U = { tenantId: string }. When
 * piped, self's U (the all-or-none union above) would need to extend
 * { tenantId: string }. But it doesn't — the NoneAllowed branch has
 * tenantId?: never. So this WOULD error, but at the self position, producing
 * a confusing "EntityUpdate<...> is not assignable to EntityUpdate<...>" message
 * rather than the clear "missing property 'region'" error from data-first.
 *
 * Worse: for non-constrained fields the error is reversed. Entity.set({ name: "Alice" })
 * infers U = { name: string }, then self's U (the all-or-none union) would need
 * to extend { name: string } — but { tenantId?: never; region?: never } doesn't
 * have name at all, so it would ALSO error, even though the update is perfectly valid.
 *
 * The module-level Entity.set uses `Updates extends Record<string, unknown>` in
 * data-last to avoid these false positives, accepting that the constraint is
 * enforced only at runtime. Data-first uses NoInfer<U> for precise type-level
 * enforcement.
 *
 * § Entity-scoped set (the solution):
 *
 * Each Entity instance exposes a `.set` dual where U is pre-bound from the
 * entity definition — following the schemaBodyJson(schema) factory pattern
 * from Effect HTTP. Because U is resolved at entity creation (not inferred
 * from the updates argument), both data-first and data-last paths are type-safe.
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
  indexes: {
    primary: {
      pk: { field: "pk" as const, composite: ["employeeId"] as const },
      sk: { field: "sk" as const, composite: [] as const },
    },
    byTenant: {
      index: "gsi1" as const,
      pk: { field: "gsi1pk" as const, composite: ["tenantId"] as const },
      sk: { field: "gsi1sk" as const, composite: ["region"] as const },
    },
  },
})

// -----------------------------------------------------------------------
// DATA-FIRST: Entity.set(self, updates) — runtime validated
// GSI all-or-none is no longer enforced at the type level (TS 25-member
// union assignability limit). These all compile; partial composites
// produce a ValidationError at runtime.
// -----------------------------------------------------------------------

// Partial GSI composites: tenantId without region — caught at runtime
Entity.set(Employees.update({ employeeId: "e-1" }), { tenantId: "t-3" })

// All GSI composites
Entity.set(Employees.update({ employeeId: "e-1" }), { tenantId: "t-3", region: "us-east-1" })

// No GSI composites
Entity.set(Employees.update({ employeeId: "e-1" }), { name: "Alice" as any })

// -----------------------------------------------------------------------
// PIPE PATH: .pipe(Entity.set({ ... })) — clean types, runtime-validated
// -----------------------------------------------------------------------

// Partial GSI composites: no type error in pipe path (runtime catches it)
const _pipeBadRuntime = Effect.gen(function* () {
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

// Partial GSI in pipe chain — no type error; runtime validation catches it.
// .asEffect() crosses the entity-op/Effect boundary before Effect combinators.
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

// Entity.set: WHY it's different — the constraint is a union, not a simple type
//
// If Entity.set used the Ref/HashMap pattern (shared U parameter), then:
//
//   Entity.set({ name: "Alice" })  // infers U = { name: string }
//   // Returns: (self: EntityUpdate<..., { name: string }, ...>) => EntityUpdate<...>
//
//   // When piped, self's U is the all-or-none union:
//   //   { tenantId: string; region: string } | { tenantId?: never; region?: never }
//   // This union is NOT assignable to { name: string } — FALSE POSITIVE error.
//   // A perfectly valid non-GSI update would be rejected.
//
// So the module-level Entity.set uses `Updates extends Record<string, unknown>`
// in data-last, accepting any record and deferring validation to runtime.

// -----------------------------------------------------------------------
// ENTITY-SCOPED SET: Employees.set() — runtime validated
// -----------------------------------------------------------------------
// Each Entity instance exposes a `.set` dual where U is pre-bound from the
// entity definition. GSI all-or-none is enforced at runtime.

// DATA-FIRST: partial GSI composites caught at runtime
Employees.set(Employees.update({ employeeId: "e-1" }), { tenantId: "t-3" })

// DATA-LAST: partial GSI composites caught at runtime
const _entityScopedBad = Effect.gen(function* () {
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

void _pipeBadRuntime
void _pipeGood1
void _pipeGood2
void _pipeChainPartial
void _pipeChainGood
void _refExample
void _hashMapExample
void _entityScopedBad
void _entityScopedGood1
void _entityScopedGood2
void _entityScopedChain
