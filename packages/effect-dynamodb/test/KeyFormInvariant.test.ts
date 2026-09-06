/**
 * Key-form invariant — a structural guard, not a convention.
 *
 * Every record handed to `KeyComposer` must first go through the composite
 * key-form rule (`internal/CompositeCodec.ts`), so that the write path, the
 * update path, the lifecycle paths and the read path cannot disagree about how
 * a composite is spelled in a key.
 *
 * Skipping ONE site corrupts data already written. `composeAllKeys` (put)
 * normalised while `composeGsiKeysForUpdatePolicyAware` (update) did not, so an
 * `update()` rewrote a padded `gsi1pk` back to its unpadded form and evicted
 * the row from its own GSI — a put-then-update sequence silently lost the row
 * from every query on that index.
 *
 * A comment would not have caught that. This test reads the source and fails if
 * a `KeyComposer` call takes a record argument that did not come through
 * `keyForm(...)` / `keyFormFor(...)`.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"

/**
 * Every module that hands a record to `KeyComposer`. Adding a file here is the
 * one-line cost of making it safe; leaving it out is how a bypass survives.
 *
 * The multi-item write helpers, `Aggregate.ts` and geo's `GeoSearch.ts` were
 * added after #111 found live bypasses across all of them — a transact `put`
 * composing an unpadded key, `composePrimaryKey` taking the caller's raw key,
 * and `Aggregate.list` re-deriving a key from a stored row.
 */
const SOURCES = [
  "../src/Entity.ts",
  "../src/Aggregate.ts",
  "../src/Batch.ts",
  "../src/Transaction.ts",
  "../src/Collection.ts",
  "../src/DynamoClient.ts",
  "../src/internal/TransactableOps.ts",
  "../src/internal/TransactWriteOps.ts",
  "../src/internal/BoundVectorQuery.ts",
  "../../effect-dynamodb-geo/src/GeoSearch.ts",
].map((rel) => ({ rel, path: fileURLToPath(new URL(rel, import.meta.url)) }))

const ENTITY_SRC = fileURLToPath(new URL("../src/Entity.ts", import.meta.url))

/**
 * `KeyComposer` functions whose LAST argument is a domain/wire record and which
 * therefore must receive a normalised one. Functions taking an already-composed
 * key string (`composeEventSk`, `composeEventSkPrefix`) are not listed.
 */
const RECORD_TAKING = [
  "composePk",
  "composeSk",
  "composeAllKeys",
  "composeIndexKeys",
  "tryComposeIndexKeys",
  "composeSortKeyPrefix",
  "composeSortKeyBeginsWith",
  "composeGsiKeysForUpdatePolicyAware",
  "composeVectorPartition",
  "tryComposeVectorPartition",
  "extractComposites",
  "tryExtractComposites",
] as const

/**
 * Accepted spellings for an already-normalised record. `_keyForm(` is the
 * Entity's exposed normaliser — the handle the modules that compose keys
 * OUTSIDE `makeImpl` (transact/batch, geo search) must use.
 */
const NORMALISED = /keyForm\(|keyFormFor\(|KeyForm\b|\bkeyRecord\(|_keyForm\(/

describe.each(SOURCES)("key-form invariant — $rel", ({ path }) => {
  const src = readFileSync(path, "utf8")

  for (const fn of RECORD_TAKING) {
    it(`every KeyComposer.${fn} call takes a normalised record`, () => {
      const offenders: Array<string> = []
      const needle = `KeyComposer.${fn}(`
      let from = 0
      for (;;) {
        const at = src.indexOf(needle, from)
        if (at === -1) break
        from = at + needle.length

        // Walk to the matching close paren to capture the whole call.
        let depth = 1
        let i = from
        while (i < src.length && depth > 0) {
          if (src[i] === "(") depth++
          else if (src[i] === ")") depth--
          i++
        }
        const call = src.slice(at, i)

        // The record is the last argument, except for the policy-aware GSI
        // composer (updatePayload + keyRecord, then an options object) — for
        // that one, EVERY record-shaped argument must be normalised, so simply
        // require the marker to appear as often as the call has record args.
        const required = fn === "composeGsiKeysForUpdatePolicyAware" ? 2 : 1
        const found = call.match(new RegExp(NORMALISED.source, "g"))?.length ?? 0
        if (found < required) {
          offenders.push(call.split("\n").slice(0, 3).join(" ").replace(/\s+/g, " "))
        }
      }

      expect(
        offenders,
        `KeyComposer.${fn} called with a record that did not go through keyForm(). ` +
          `Wrap it — see the composite key-form rule in DESIGN.md §7.`,
      ).toEqual([])
    })
  }
})

describe("key-form invariant — Entity.ts normaliser shape", () => {
  const src = readFileSync(ENTITY_SRC, "utf8")

  it("the normaliser itself is defined exactly once per scope", () => {
    // `keyForm` inside `makeImpl`, `keyFormFor` for cross-entity / `bind` use.
    expect(src.match(/const keyForm = \(/g)?.length ?? 0).toBe(1)
    expect(src.match(/const keyFormFor = \(/g)?.length ?? 0).toBe(1)
  })

  it("no call site reaches for the raw composite codec directly", () => {
    // `makeCompositeKeyForm` / `toCompositeKeyRecord` are plumbing for the two
    // normalisers above; using them anywhere else re-opens the bypass.
    expect(src.match(/makeCompositeKeyForm\(/g)?.length ?? 0).toBeLessThanOrEqual(2)
    expect(src.match(/toCompositeKeyRecord\(/g)?.length ?? 0).toBeLessThanOrEqual(2)
  })
})
