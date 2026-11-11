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
 * `keyForm(...)` / `keyFormFor(...)`. The same holds for `KeyText136` (#171),
 * which composes the key text 1.36 wrote from the same key-form record.
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
  "composeZOrderSk",
  "composeSkValue",
  "composeAllKeys",
  "composeIndexKeys",
  "tryComposeIndexKeys",
  "composeSortKeyPrefix",
  "composeSortKeyBeginsWith",
  "composeSortKeyCondition",
  "tryComposeStructuralKeys",
  "composeGsiKeysForUpdatePolicyAware",
  "composeVectorPartition",
  "tryComposeVectorPartition",
  "judgeIndexHalf",
  "extractComposites",
  "tryExtractComposites",
  "composeReadPartitions",
  "composeStoredPk",
  "composeKnownHalves",
  "composeSkPrefixUpTo",
] as const

/** The `KeyText136` function taking a record: `rekey` composing a key at another text. */
const RECORD_TAKING_136 = ["composeAt"] as const

const CALLS = [
  ...RECORD_TAKING.map((fn) => ({ module: "KeyComposer", fn })),
  ...RECORD_TAKING_136.map((fn) => ({ module: "KeyText136", fn })),
]

/**
 * Accepted spellings for an already-normalised record. `_keyForm(` is the
 * Entity's exposed normaliser — the handle the modules that compose keys
 * OUTSIDE `makeImpl` (transact/batch, geo search) must use.
 */
const NORMALISED = /keyForm\(|keyFormFor\(|KeyForm\b|\bkeyRecord\(|_keyForm\(/

describe.each(SOURCES)("key-form invariant — $rel", ({ path }) => {
  const src = readFileSync(path, "utf8")

  for (const { module, fn } of CALLS) {
    it(`every ${module}.${fn} call takes a normalised record`, () => {
      const offenders: Array<string> = []
      const needle = `${module}.${fn}(`
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
        `${module}.${fn} called with a record that did not go through keyForm(). ` +
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
    // normalisers above, and for `keyForm139`, the key form 1.39.0 composed,
    // which only `rekey` composes; using them anywhere else re-opens the bypass.
    expect(src.match(/makeCompositeKeyForm\(/g)?.length ?? 0).toBeLessThanOrEqual(3)
    expect(src.match(/toCompositeKeyRecord\(/g)?.length ?? 0).toBeLessThanOrEqual(3)
    expect(src.match(/text139: true/g)?.length ?? 0).toBe(1)
  })

  it("only rekey composes 1.39.0's key form, to find the rows it stored", () => {
    expect(src.match(/keyForm139\(/g)?.length ?? 0).toBe(1)
    const rowKeyForms = src.slice(src.indexOf("const rowKeyForms = ("))
    expect(rowKeyForms.slice(0, rowKeyForms.indexOf("\n  }\n"))).toMatch(/keyForm139\(/)
  })
})

/**
 * A key composed from values a CALLER gives (an accessor's composites, a `.where()` / `.within()`
 * bound, a collection's, vector index's or geo search's partition, a multi-item op's key, a query
 * builder's key) is the key `put` wrote for them: the key form of the value `put` stores
 * (`makeCompositeDomainKeyForm`, `Entity._domainKeyForm`). The plain key form takes a value as it is
 * stored; given a domain value whose codec `encode` takes its own output, it composes a key no `put`
 * writes, and up to 1.39.0 every one of these paths did, finding nothing.
 */
describe("key-form invariant — a caller's values compose the key put wrote", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")

  it("collections compose through the domain key form", () => {
    const src = read("../src/Collection.ts")
    expect(src).not.toMatch(/makeCompositeKeyForm\(/)
    expect(src).toMatch(/makeCompositeDomainKeyForm\(/)
  })

  it("accessors, bounds, collections and vector partitions compose through the domain key form", () => {
    const src = read("../src/DynamoClient.ts")
    // The accessor's plain form reads stored values (row checks, a dimension's filter) only.
    expect(src.match(/makeCompositeKeyForm\(/g)?.length ?? 0).toBe(1)
    expect(src).not.toMatch(/toCompositeKeyRecord\(compositeKeyForm/)
    expect(src).not.toMatch(/mapBound\([^)]*compositeKeyForm\(/)
    expect(src).toMatch(/toCompositeKeyRecord\(domainKeyForm, rawComposites\)/)
  })

  it("geo search composes through the domain key form", () => {
    expect(read("../../effect-dynamodb-geo/src/GeoSearch.ts")).not.toMatch(/\._keyForm\(/)
  })

  it("a multi-item op's key composes through the domain key form", () => {
    const src = read("../src/internal/TransactableOps.ts")
    const body = src.slice(src.indexOf("export const composePrimaryKeyOrFail"))
    expect(body.slice(0, body.indexOf("\n}\n"))).toMatch(/_domainKeyForm\(/)
  })

  it("a projection keys its row, tombstone and outbox items as the read model's put keys the row", () => {
    const ops = read("../src/internal/TransactableOps.ts")
    const body = ops.slice(ops.indexOf("export const composePrimaryKey ="))
    expect(body.slice(0, body.indexOf("\n\n"))).toMatch(/_domainKeyForm\(/)
    const src = read("../src/internal/ProjectionEngine.ts")
    expect(src).not.toMatch(/_keyForm\(/)
    const entity = read("../src/Entity.ts")
    const mark = entity.slice(entity.indexOf("    _keyTextMark: ("))
    expect(mark.slice(0, mark.indexOf("\n    ),\n"))).toMatch(/domainKeyForm\(key\)/)
  })

  it("the entity's query builders compose a caller's key through the domain key form", () => {
    const src = read("../src/Entity.ts")
    expect(src).not.toMatch(/keyFormFor\(entityInternals, key/)
    // A history `.where()` bound on the orderBy: encoded as `append` encodes it (`encodeOrderBy`),
    // then put into key form, as `append` composes the event's key from what it stores.
    expect(src).toMatch(/entity\._keyForm\(\{ \[orderBy\]: encodeOrderBy\(v\) \}\)/)
    expect(src).toMatch(/const encoded = encodeOrderBy\(v\)/)
    expect(src).toMatch(/entity\._keyForm\(\{ \[orderBy\]: encoded \}\)/)
  })
})

/**
 * An aggregate's keys are its own: `create`, `get`, `list` and `rekey` compose them all through one
 * key form, from domain values, so no other path missed what it wrote on 1.39.0. It keeps 1.39.0's
 * form, a codec `encode` takes on its own output encoded once, and every byte with it.
 */
describe("key-form invariant — an aggregate keys as 1.39.0 did", () => {
  it("its one key form is 1.39.0's", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/Aggregate.ts", import.meta.url)), "utf8")
    expect(src.match(/makeCompositeKeyForm\(/g)?.length ?? 0).toBe(1)
    expect(src).not.toMatch(/makeCompositeDomainKeyForm\(/)
    const form = src.slice(src.indexOf("const compositeKeyForm = makeCompositeKeyForm("))
    expect(form.slice(0, form.indexOf("\n  )\n"))).toMatch(/\{ text139: true \}/)
  })
})
