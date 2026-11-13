/**
 * What the library asks of a caller's object, trap by trap, against published 1.40.0 (#239).
 *
 * Every key, payload and record a caller hands in is a proxy recording each trap it receives
 * (`helpers/ReadParity.ts`), at the top level and, in the "deep" runs, in every nested object and
 * list too, across every entry point: keys for `get`, `update`, `delete`, index accessors,
 * `.within()`, collections, `.history()`, versions, soft-deleted items, `Batch` and `Transaction`;
 * each record combinator; conditions, filters and selects; `put`, `create` and `upsert` inputs; an
 * aggregate's inputs and key; an event stream's id, events and metadata.
 *
 * Read as 1.40.0 read it: each step asks the same traps, of the same names, as many times, in the
 * same order. Under ordinary names each step returns what it returned, sends the requests it sent,
 * and leaves the rows it left. A payload holding names `Object.prototype` holds (`toString`,
 * `constructor`) as its own properties is read the same way, and is written and read back as one
 * holding ordinary names is, name for name; 1.40.0 failed, or wrote the inherited member, on many
 * of those steps (the fixture holds what it did).
 *
 * One known difference, a change made since (`MORE_READS`): an aggregate's `create` reads the input
 * again to judge `EDD-9159` (#241). Its other traps are all reads, and the rest are 1.40.0's, in
 * its order; the step returns, sends and leaves what it did.
 *
 * `fixtures/read-parity-1.40.0.json` holds what published 1.40.0 did with each case, on Effect
 * 4.1.3. It's generated once from the published package: don't regenerate or "fix" it.
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
import { type Api, CONTROL, capture, type Outcome, trapsBeside } from "./helpers/InheritedNames.js"
import { NAME_SETS, type Names, parityPositions } from "./helpers/ReadParity.js"

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

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/read-parity-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Readonly<Record<string, Outcome>> }

const ORDINARY = "ordinary"
const positions = parityPositions()

/** The steps of an aggregate's positions that read more than 1.40.0 did (see above). */
const MORE_READS = new Set(["create by ids", "create whole"])
/** A trap that reads a name: `get`, or `has`. */
const READ = / (get|has) /

let tables = 0
const outcomes = new Map<string, Promise<Outcome>>()
const run = (key: string): Promise<Outcome> => {
  let outcome = outcomes.get(key)
  if (outcome === undefined) {
    const { position, trace } = positions.find((each) => each.position.key === key)!
    outcome = capture(api, ENDPOINT, `parity-${Date.now()}-${tables++}`, position, CONTROL, trace)
    outcomes.set(key, outcome)
  }
  return outcome
}

/** `value` with each of `from`'s names written as `to`'s. */
const renamed = <A>(value: A, from: Names, to: Names): A =>
  JSON.parse(JSON.stringify(value).split(from.a).join(to.a).split(from.b).join(to.b)) as A

describeConnected("each caller's object read as 1.40.0 read it, trap for trap (#239)", () => {
  it("covers every position the fixture holds", () => {
    expect(positions.map(({ position }) => position.key)).toEqual(Object.keys(fixture.cases))
  })

  for (const { position } of positions) {
    const [, set] = position.key.split(", ")
    it(position.key, { timeout: 60_000 }, async () => {
      const outcome = await run(position.key)
      const recorded = fixture.cases[position.key]!
      expect(outcome.refused).toBeUndefined()
      expect(Object.keys(outcome.steps)).toEqual(Object.keys(recorded.steps))

      // The same traps, of the same names, as many times, in the same order, step by step.
      for (const [label, traps] of Object.entries(recorded.traces!)) {
        if (position.key.startsWith("aggregates, ") && MORE_READS.has(label)) {
          const beside = trapsBeside(outcome.traces![label]!, traps)
          expect({ label, beside: beside?.filter((trap) => !READ.test(trap)) }).toEqual({
            label,
            beside: [],
          })
          continue
        }
        expect({ label, traps: outcome.traces![label] }).toEqual({ label, traps })
      }

      if (set === ORDINARY) {
        // Each step returns, sends and leaves what it did on 1.40.0.
        expect(outcome.steps).toEqual(recorded.steps)
        expect(outcome.requests).toEqual(recorded.requests)
        expect(outcome.rows).toEqual(recorded.rows)
        return
      }
      // Written and read back as ordinary names are, name for name.
      const ordinary = await run(position.key.replace(set!, ORDINARY))
      const as = (value: unknown) => renamed(value, NAME_SETS[ORDINARY]!, NAME_SETS[set!]!)
      expect(outcome.steps).toEqual(as(ordinary.steps))
      expect(outcome.requests).toEqual(as(ordinary.requests))
      expect(outcome.rows).toEqual(as(ordinary.rows))
      // Where 1.40.0 wrote or read otherwise, it failed or kept the inherited member instead.
      expect(recorded.steps).not.toEqual(outcome.steps)
    })
  }
})
