/**
 * A name every object inherits (`constructor`, `toString`, `valueOf`, `hasOwnProperty`,
 * `__proto__`, and the rest of `Object.prototype`'s members) in every position a definition or a
 * payload gives one, against DynamoDB Local (#239): a model field, the attribute a field is stored
 * under and a renamed field, a sparse map's entry key (given and left out), a path segment, a
 * record's entry key (on an item, in a time-series append, packed and in an aggregate), the
 * timestamps, the version field, a key composite, an optional index sort key composite, an index's
 * key attribute, a unique constraint's field, a ref field, a time-series `orderBy`, a Z-order
 * dimension, a projection's checkpoint, revision, checkpoint map and instance field, an aggregate's
 * root field, context field and every kind of edge, the field a `many` element holds its entity
 * in, and a field left out at every depth of a stored value.
 *
 * Each case defines the position under the name and runs its steps (put, get, update, query, as
 * the position has them). Under every name the case does what it does under an ordinary name: every
 * step returns what it returns there and the table holds the same rows, the name standing in for
 * the ordinary one. Under `__proto__`, where every row written would hold the name as an attribute
 * (or a property of one), the definition is refused instead (`EDD-9152` for an entity or a
 * projection, `EDD-9153` for an aggregate): a JavaScript object can't take that name by assignment,
 * and the AWS SDK's marshaller drops an attribute so named. Where a row may be without it (an
 * optional field, an index key a row may be without, a map entry's key: a record's, or a path's
 * through a stored map), each write holding it is refused (`EDD-9165`) and writes nothing; a sparse
 * map's entry is its own attribute, and a packed record is JSON text, so either works as under any
 * name. Nothing ever sends or stores a function's text, and no sentinel is reserved for a unique
 * field a row doesn't hold.
 *
 * `fixtures/inherited-names-1.40.0.json` holds what published 1.40.0 did with each case on Effect
 * 4.1.3. A case it handled as it handles the ordinary name sends exactly the requests it sent, stores
 * the same rows and returns the same results. (On Effect 4.1.2, Effect's parser read a field left out
 * of a payload as the `Object.prototype` member of its name, so fewer cases were.) It's generated
 * once from the published package: don't regenerate or "fix" it.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { Cause, Clock, Config, Effect, Exit, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Zlib from "../src/compression/zlib.js"
import * as Lib from "../src/index.js"
import {
  type Api,
  CONTROL,
  capture,
  caseKey,
  NAMES,
  type Outcome,
  POSITIONS,
  type Position,
} from "./helpers/InheritedNames.js"

const ENDPOINT = Effect.runSync(
  Config.String("DYNAMODB_ENDPOINT").pipe(Config.withDefault("http://localhost:8000")),
)

let dynamoAvailable = false
try {
  const res = await fetch(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(1000) }).catch(
    () => null,
  )
  dynamoAvailable = res !== null
} catch {
  dynamoAvailable = false
}
const describeConnected = dynamoAvailable ? describe : describe.skip

const api: Api = { ...Lib, Zlib, Cause, Clock, Effect, Exit, Layer, Option, Schema }

interface Recorded {
  readonly refused?: string
  readonly steps: Outcome["steps"]
  readonly rows: Outcome["rows"]
  /** Kept for the cases 1.40.0 handled as it handles the ordinary name. */
  readonly requests?: Outcome["requests"]
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/inherited-names-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Readonly<Record<string, Recorded>> }

/** Whether `outcome` is what `control` (the ordinary name's) is: same results, same rows. */
const asOrdinary = (outcome: Recorded, control: Recorded) =>
  outcome.refused === undefined &&
  Object.values(outcome.steps).every((step) => step.ok) &&
  !JSON.stringify(outcome).includes("[native code]") &&
  JSON.stringify(outcome.steps) === JSON.stringify(control.steps) &&
  JSON.stringify(outcome.rows) === JSON.stringify(control.rows)

/** The commands that write. */
const WRITES = new Set([
  "PutItem",
  "UpdateItem",
  "DeleteItem",
  "BatchWriteItem",
  "TransactWriteItems",
])

let tables = 0
const run = (position: Position, name: string) =>
  capture(api, ENDPOINT, `inherited-${Date.now()}-${tables++}`, position, name)

describeConnected("names every object inherits (#239)", () => {
  it("covers every member of Object.prototype", () => {
    expect([...NAMES].filter((name) => name !== CONTROL).sort()).toEqual(
      Object.getOwnPropertyNames(Object.prototype).sort(),
    )
  })

  for (const position of POSITIONS) {
    describe(position.key, () => {
      let control: Promise<Outcome> | undefined
      const ordinary = () => {
        control ??= run(position, CONTROL)
        return control
      }

      for (const name of NAMES) {
        it(name, { timeout: 60_000 }, async () => {
          const outcome = name === CONTROL ? await ordinary() : await run(position, name)
          expect(JSON.stringify(outcome)).not.toContain("[native code]")

          const proto = name === "__proto__" ? position.proto : undefined
          if (proto?.refusedAt !== undefined) {
            expect(outcome.refused).toMatch(new RegExp(`^\\[${proto.refusedAt}\\] `))
            expect(outcome.requests).toEqual([])
          } else {
            expect(outcome.refused).toBeUndefined()
            // An attribute or a map entry named `__proto__` is refused (`EDD-9165`), writing
            // nothing; what reads or updates the row it would have written differs for that alone.
            const refused = new Set(proto?.refused ?? [])
            const differ = proto?.differ ?? {}
            for (const [label, step] of Object.entries(outcome.steps)) {
              if (refused.has(label)) {
                expect({ label, ...step }).toEqual({
                  label,
                  ok: false,
                  error: expect.stringMatching(/^ValidationError: .*"__proto__".*\[EDD-9165\]/),
                })
                const writes = (outcome.sentBy?.[label] ?? []).filter((command) =>
                  WRITES.has(command),
                )
                expect({ label, writes }).toEqual({ label, writes: [] })
              } else if (Object.hasOwn(differ, label)) {
                const want = differ[label]!
                expect({ label, ...step }).toEqual(
                  want.startsWith("ok: ")
                    ? { label, ok: true, value: want.slice(4) }
                    : { label, ok: false, error: expect.stringMatching(`^${want}: `) },
                )
              } else {
                expect({ label, ...step }).toEqual({ label, ok: true, value: expect.any(String) })
              }
            }
            const expected = await ordinary()
            const unaffected = (steps: Outcome["steps"]) =>
              Object.fromEntries(
                Object.entries(steps).filter(
                  ([label]) => !refused.has(label) && !Object.hasOwn(differ, label),
                ),
              )
            expect(Object.keys(outcome.steps)).toEqual(Object.keys(expected.steps))
            expect(unaffected(outcome.steps)).toEqual(unaffected(expected.steps))
            expect(outcome.rows).toEqual(proto?.rows ?? expected.rows)
          }

          // What 1.40.0 handled as it handles the ordinary name stays exactly as it was.
          const recorded = fixture.cases[caseKey(position, name)]
          const recordedControl = fixture.cases[caseKey(position, CONTROL)]
          expect(recorded).toBeDefined()
          expect(recordedControl).toBeDefined()
          if (asOrdinary(recorded!, recordedControl!)) {
            expect(recorded!.requests).toBeDefined()
            expect(outcome.requests).toEqual(recorded!.requests)
            expect(outcome.rows).toEqual(recorded!.rows)
            expect(outcome.steps).toEqual(recorded!.steps)
          }
        })
      }
    })
  }
})
