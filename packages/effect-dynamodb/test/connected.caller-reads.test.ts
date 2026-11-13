/**
 * What the library reads of a caller's object, and what it makes of an argument that is no object,
 * against DynamoDB Local (#239, `helpers/CallerReads.ts`), each case compared with what published
 * 1.40.0 did on Effect 4.1.3 (`fixtures/caller-reads-1.40.0.json`): what each step returned or how
 * it failed, every request, and the rows.
 *
 * - Every key and payload an object of counting getters, beside an undeclared getter (counted, and
 *   throwing), through every entity, aggregate and event-stream path: each step reads each name as
 *   many times as 1.40.0 read it, and does what it did. An aggregate's `create` with ids to fetch
 *   copies the whole input as 1.40.0 did, reading every own enumerable property of every object once:
 *   where an undeclared getter throws, it dies there as 1.40.0 died.
 * - A symbol-keyed field the model declares, through each write, a condition, a filter and
 *   `StorageEncoding.valueBytes`.
 * - `undefined`, `null`, a string, a number and an array, given to every combinator and accessor
 *   that takes a record, a key or a callback, and returned by a callback.
 * - A stored map that looks like the library's own error (`{ _tag: "UnreadableName", … }`),
 *   compared in a condition, a filter and a transaction: a value like any other.
 *
 * Two known differences, each a change made since (`KNOWN`): an aggregate's `create` reads the
 * input again to judge `EDD-9159` (#241), more reads only a getter or a proxy sees, every step
 * returning, sending and leaving what it did; and `pathRemove` given a string or a number for its
 * path (#244) fails by another error, a string sent as a path first and refused, nothing written.
 *
 * It's generated once from the published package: don't regenerate or "fix" it.
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
import { CALLER_READ_POSITIONS } from "./helpers/CallerReads.js"
import {
  type Api,
  CONTROL,
  capture,
  caseKey,
  type Outcome,
  type Position,
  requestsByStep,
  withoutReads,
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

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/caller-reads-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Readonly<Record<string, Outcome>> }

/** The cases a change made since 1.40.0 reads otherwise, by what changed (see above). */
const KNOWN: Readonly<Record<string, "more reads" | "path not a list">> = {
  "aggregate keys and payloads, counting getters": "more reads",
  "aggregate keys and payloads, counting getters, an undeclared one throwing": "more reads",
  "an argument that is no object: a string": "path not a list",
  "an argument that is no object: a number": "path not a list",
}

const stepsWithoutReads = (steps: Outcome["steps"]) =>
  Object.fromEntries(Object.entries(steps).map(([label, step]) => [label, withoutReads(step)]))

let tables = 0
const outcomes = new Map<string, Promise<Outcome>>()
const run = (position: Position): Promise<Outcome> => {
  const key = caseKey(position, CONTROL)
  let outcome = outcomes.get(key)
  if (outcome === undefined) {
    outcome = capture(api, ENDPOINT, `reads-${Date.now()}-${tables++}`, position, CONTROL)
    outcomes.set(key, outcome)
  }
  return outcome
}

describeConnected("what the library reads of a caller's object (#239)", () => {
  for (const position of CALLER_READ_POSITIONS) {
    const key = caseKey(position, CONTROL)
    it(position.key, { timeout: 120_000 }, async () => {
      const recorded = fixture.cases[key]
      expect(recorded).toBeDefined()
      const outcome = await run(position)
      expect(outcome.refused).toEqual(recorded!.refused)
      const known = KNOWN[position.key]
      if (known === "path not a list") {
        const { pathRemove, ...steps } = outcome.steps
        const { pathRemove: _was, ...recordedSteps } = recorded!.steps
        expect(steps).toEqual(recordedSteps)
        expect(JSON.parse(pathRemove!.value!)).toHaveProperty("failed")
        expect({ ...requestsByStep(outcome), pathRemove: [] }).toEqual({
          ...requestsByStep(recorded!),
          pathRemove: [],
        })
        expect(outcome.rows).toEqual(recorded!.rows)
        return
      }
      if (known === "more reads") {
        expect(stepsWithoutReads(outcome.steps)).toEqual(stepsWithoutReads(recorded!.steps))
      } else {
        expect(outcome.steps).toEqual(recorded!.steps)
      }
      expect(outcome.sentBy).toEqual(recorded!.sentBy)
      expect(outcome.requests).toEqual(recorded!.requests)
      expect(outcome.rows).toEqual(recorded!.rows)
    })
  }
})
