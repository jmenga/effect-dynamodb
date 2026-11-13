/**
 * The guard on the form a row holds a renamed sparse map in, and the one question every write
 * carrying it asks of a refusal (#238).
 *
 * A sparse map a `field:` rename stores whole (`{ storedAs: SparseMap(), field: "sr" }`) is held by
 * a row either whole, in its attribute (`sr`), or as entries (`counts#a`, …). A write of an entry
 * writes it where the row holds the map, and carries a guard that the row still holds it that way:
 * `attribute_exists(sr)` for an entry written inside the map, `attribute_not_exists(sr)` for one
 * written as its own attribute. The guard sits beside the write's own condition (the caller's
 * `.condition()`, the version, an upsert's key guards, …), and DynamoDB refuses the write with one
 * verdict for all of them.
 *
 * {@link rejectedBy} tells them apart, from the stored item the refusal returned (`ALL_OLD`). Where
 * the form guard holds on that item, or something else in the condition is false on it (the caller's
 * condition, the version), the refusal is the write's own, answered as 1.40.0 answered it: a guard
 * 1.40.0 didn't send never takes a verdict it gave. Where the form guard fails and the rest holds,
 * it's the form's (`known`); where the rest is one the evaluator can't tell (a `size()` it can't
 * count), it may be either (`known: false`). Every write that sends the guard asks this one
 * function: an update read or not, a retained update, an upsert, and a transaction's plan (DESIGN.md
 * §7 "Which verdict a refused write gets").
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { conditionHolds } from "./ConditionHolds.js"

/** The placeholder naming the attribute of the `i`th renamed map a write guards. */
export const formGuardName = (i: number): string => `#fm${i}`

/**
 * The guard that the row holds the map named by {@link formGuardName}(`i`) in `form`: whole (its
 * attribute exists) or as entries (it doesn't).
 */
export const formGuard = (i: number, form: "whole" | "entries"): string =>
  form === "whole"
    ? `attribute_exists(${formGuardName(i)})`
    : `attribute_not_exists(${formGuardName(i)})`

const FORM_GUARD = /^attribute_(not_)?exists\((#fm\d+)\)$/

/** The parts of an expression joined by `AND` outside any parentheses. */
const conjuncts = (expression: string): Array<string> => {
  const parts: Array<string> = []
  let depth = 0
  let start = 0
  for (let at = 0; at < expression.length; at++) {
    const char = expression[at]
    if (char === "(") depth++
    else if (char === ")") depth--
    else if (depth === 0 && expression.startsWith(" AND ", at)) {
      parts.push(expression.slice(start, at))
      start = at + 5
      at += 4
    }
  }
  parts.push(expression.slice(start))
  return parts
}

/**
 * What refused a write: the rest of its condition (`"Rest"`), answered as the write answered it
 * before it carried the guard; or its form guard on a map's `attribute` (`"Form"`), alone (`known`)
 * or beside a rest the evaluator can't tell, which may also have refused it.
 */
export type Rejection =
  | { readonly _tag: "Rest" }
  | { readonly _tag: "Form"; readonly attribute: string; readonly known: boolean }

const REST: Rejection = { _tag: "Rest" }

/**
 * Which part of a refused write's condition refused it, judged on `stored`, the item the refusal
 * returned (`undefined`: no row). `"Form"` only where a form guard fails on it and the rest of the
 * condition isn't false on it (a `BETWEEN … AND …` split here is joined back as it was).
 */
export const rejectedBy = (
  condition: {
    readonly expression: string | undefined
    readonly names: Readonly<Record<string, string>> | undefined
    readonly values: Readonly<Record<string, AttributeValue>> | undefined
  },
  stored: Readonly<Record<string, unknown>> | undefined,
): Rejection => {
  if (stored === undefined || condition.expression === undefined) return REST
  const names = condition.names ?? {}
  const rest: Array<string> = []
  let refused: string | undefined
  for (const part of conjuncts(condition.expression)) {
    const guard = FORM_GUARD.exec(part)
    const attribute = guard === null ? undefined : names[guard[2]!]
    if (guard === null || attribute === undefined || !Object.hasOwn(names, guard[2]!)) {
      rest.push(part)
      continue
    }
    const holds = Object.hasOwn(stored, attribute) === (guard[1] === undefined)
    if (!holds) refused ??= attribute
  }
  if (refused === undefined) return REST
  const others =
    rest.length === 0
      ? true
      : conditionHolds(
          rest.join(" AND "),
          stored as Readonly<Record<string, AttributeValue>>,
          names,
          condition.values ?? {},
        )
  return others === false ? REST : { _tag: "Form", attribute: refused, known: others === true }
}
