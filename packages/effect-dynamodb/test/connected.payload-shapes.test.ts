/**
 * A caller's key or payload in every shape JavaScript gives an object, against DynamoDB Local
 * (#239): a plain object, one made by `Object.create`, an instance of a class whose fields are
 * getters, a frozen object, a proxy over an empty target, and a strict proxy (reading a name it
 * doesn't hold throws). Each case runs one shape through
 * every path that reads a key or a payload (`helpers/PayloadShapes.ts`): entity writes, reads,
 * updates and deletes; `Batch`; `Transaction`; index accessors, collections, `.history()`; an event
 * stream's id; and an aggregate's key, root, sub-aggregate, `one` edge and `many` elements, ids to
 * fetch included.
 *
 * Every shape is read as a plain object is: each step returns what it returns for a plain object,
 * sends exactly the requests a plain object sends, and the table holds the same rows. But for the
 * aggregate given by `Object.create`, a class with getters or a proxy: it copies its input as 1.40.0
 * did (`cloneInput`, own enumerable properties alone), so those shapes lose their fields there, and
 * each step does exactly what 1.40.0 did, request for request and row for row.
 *
 * A record argument (a condition, a filter, `.add()`, `.subtract()`, `.append()`, `.within()`'s
 * bounds) in every shape is read by its own entries (`Object.entries`), exactly as 1.40.0 read it:
 * each step does what 1.40.0 did, request for request and row for row, so a shape whose entries
 * aren't its own properties gives none (a condition so given asserts nothing, as on 1.40.0).
 *
 * `fixtures/payload-shapes-1.40.0.json` holds what published 1.40.0 did with each case on Effect
 * 4.1.3 (the same as on 4.1.2: no name here is an `Object.prototype` member). A plain
 * object sends exactly the requests it sent there, and so does a case it handled as it handles a
 * plain object. Up to 1.40.0 only an object's own properties were read on many of these paths, so a
 * key given any other way failed, and a condition, a filter or `.within()`'s bounds read as none: a
 * conditioned write or delete went through unconditionally. It's generated once from the published
 * package: don't regenerate or "fix" it.
 *
 * A key, and a record argument (a condition, a filter, `.add()`, `.subtract()`, `.append()`), given by
 * an object that throws when asked for a name it doesn't hold: a strict proxy is read by the names it
 * holds, as a plain object is. An object whose class claims a name with a getter that throws is read
 * for a key's composites alone, and a record argument by its own entries, as a plain object is, and
 * as 1.40.0 read both. Effect's parser reads a payload's every declared field itself, and the
 * getter's throw is a defect, as it was on 1.40.0.
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
  type Outcome,
  type Position,
} from "./helpers/InheritedNames.js"
import {
  CONTROL_SHAPE,
  controlOf,
  RECORD_POSITIONS,
  SHAPE_POSITIONS,
  SHAPES,
  UNHELD_POSITIONS,
} from "./helpers/PayloadShapes.js"

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
  /** Kept for the cases 1.40.0 handled as it handles a plain object. */
  readonly requests?: Outcome["requests"]
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/payload-shapes-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Readonly<Record<string, Recorded>> }

/**
 * The aggregate given in a shape whose fields aren't its own enumerable properties: its input goes
 * through 1.40.0's copy (`cloneInput`), which keeps those alone.
 */
const COPIED_AS_BEFORE = new Set(
  ["Object.create", "class with getters", "proxy"].map(
    (shape) => `aggregate keys and payloads, ${shape}`,
  ),
)

let tables = 0
const outcomes = new Map<Position, Promise<Outcome>>()
/** Each position runs once: a shape's case and its plain control share the plain run. */
const run = (position: Position): Promise<Outcome> => {
  let outcome = outcomes.get(position)
  if (outcome === undefined) {
    outcome = capture(api, ENDPOINT, `shapes-${Date.now()}-${tables++}`, position, CONTROL)
    outcomes.set(position, outcome)
  }
  return outcome
}

describeConnected("a key or a payload in every shape (#239)", () => {
  it("covers every shape", () => {
    expect(Object.keys(SHAPES)).toEqual([
      "plain",
      "Object.create",
      "class with getters",
      "frozen",
      "proxy",
      "strict proxy",
    ])
  })

  for (const { shape, position } of SHAPE_POSITIONS) {
    it(position.key, { timeout: 60_000 }, async () => {
      const outcome = await run(position)
      const control = await run(controlOf(position))
      const recorded = fixture.cases[position.key]
      expect(recorded).toBeDefined()
      expect(outcome.refused).toBeUndefined()
      expect(JSON.stringify(outcome)).not.toContain("[native code]")
      if (COPIED_AS_BEFORE.has(position.key)) {
        // The aggregate copies its input as 1.40.0 did, its own enumerable properties alone, so
        // this shape loses its fields there: exactly 1.40.0's results, requests and rows.
        expect(recorded!.requests).toBeDefined()
        expect(outcome.steps).not.toEqual(control.steps)
        expect(outcome.steps).toEqual(recorded!.steps)
        expect(outcome.requests).toEqual(recorded!.requests)
        expect(outcome.rows).toEqual(recorded!.rows)
        return
      }
      // Read as a plain object is: the same results, the same requests, the same rows.
      expect(outcome.steps).toEqual(control.steps)
      expect(outcome.requests).toEqual(control.requests)
      expect(outcome.rows).toEqual(control.rows)

      // What 1.40.0 handled as it handles a plain object stays exactly as it was.
      if (shape === CONTROL_SHAPE) expect(recorded!.requests).toBeDefined()
      if (recorded!.requests !== undefined) {
        expect(outcome.requests).toEqual(recorded!.requests)
        expect(outcome.steps).toEqual(recorded!.steps)
        expect(outcome.rows).toEqual(recorded!.rows)
      }
    })
  }
})

describeConnected("a record argument in every shape, read as 1.40.0 read it (#239)", () => {
  for (const { position } of RECORD_POSITIONS) {
    it(position.key, { timeout: 60_000 }, async () => {
      const outcome = await run(position)
      const recorded = fixture.cases[position.key]
      expect(recorded).toBeDefined()
      expect(recorded!.requests).toBeDefined()
      expect(outcome.refused).toBeUndefined()
      // Its own entries, as 1.40.0 read them: exactly 1.40.0's results, requests and rows.
      expect(outcome.steps).toEqual(recorded!.steps)
      expect(outcome.requests).toEqual(recorded!.requests)
      expect(outcome.rows).toEqual(recorded!.rows)
    })
  }
})

describeConnected(
  "a key or a record given by an object throwing for a name it doesn't hold (#239)",
  () => {
    const plain = UNHELD_POSITIONS.find(({ shape }) => shape === CONTROL_SHAPE)!.position

    for (const { shape, position } of UNHELD_POSITIONS) {
      it(position.key, { timeout: 60_000 }, async () => {
        const outcome = await run(position)
        const control = await run(plain)
        const recorded = fixture.cases[position.key]
        expect(recorded).toBeDefined()
        expect(outcome.refused).toBeUndefined()
        expect(Object.keys(outcome.steps)).toEqual(Object.keys(control.steps))
        for (const [label, step] of Object.entries(outcome.steps)) {
          const sent = outcome.sentBy![label]
          if (shape === "throwing getter" && label.includes("the parser reading")) {
            // Effect's parser reads the field itself: its throw is a defect, as on 1.40.0.
            expect({ label, ...step }).toEqual({ label, ...recorded!.steps[label] })
            expect(step.error).toBe("defect: note is not loaded")
          } else {
            // A key is read for its composites, a record by its own entries, and a strict proxy by
            // the names it holds.
            expect({ label, ...step, sent }).toEqual({
              label,
              ...control.steps[label],
              sent: control.sentBy![label],
            })
          }
        }
        expect(outcome.rows).toEqual(control.rows)
        if (shape !== "throwing getter") expect(outcome.requests).toEqual(control.requests)
        // An object throwing from a getter it inherits is read as 1.40.0 read it, step for step.
        if (shape === "throwing getter") expect(outcome.steps).toEqual(recorded!.steps)
        if (recorded!.requests !== undefined) expect(outcome.requests).toEqual(recorded!.requests)
        if (shape === CONTROL_SHAPE) expect(recorded!.requests).toBeDefined()
      })
    }
  },
)
