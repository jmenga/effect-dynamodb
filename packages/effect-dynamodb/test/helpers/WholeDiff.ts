/**
 * Where a case does what 1.40.0 did but for some fields: the paths at which two captures differ,
 * so a test names each field the head changes and holds every other one equal (#238).
 */

import { expect } from "vitest"

/**
 * The paths at which `was` and `got` differ, as `sent[0].updateItem.ConditionExpression`: a value
 * one side lacks, or of another kind, is named where it begins; equal subtrees are left out.
 */
export const differingPaths = (was: unknown, got: unknown): ReadonlyArray<string> => {
  const out: Array<string> = []
  const walk = (a: unknown, b: unknown, path: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return
    if (
      a !== null &&
      b !== null &&
      typeof a === "object" &&
      typeof b === "object" &&
      Array.isArray(a) === Array.isArray(b)
    ) {
      const names = new Set([...Object.keys(a), ...Object.keys(b)])
      for (const name of names) {
        const at = Array.isArray(a) ? `${path}[${name}]` : path === "" ? name : `${path}.${name}`
        walk((a as Record<string, unknown>)[name], (b as Record<string, unknown>)[name], at)
      }
      return
    }
    out.push(path)
  }
  walk(was, got, "")
  return out
}

/** `got` is `was` but for exactly the fields `named`. */
export const expectDiffersOnly = (was: unknown, got: unknown, named: ReadonlyArray<string>) => {
  expect([...differingPaths(was, got)].sort()).toEqual([...named].sort())
}
