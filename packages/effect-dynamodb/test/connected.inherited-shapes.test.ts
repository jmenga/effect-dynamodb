/**
 * Every member of `Object.prototype` a payload gives as a field (`constructor`, `toString`,
 * `valueOf`, …; `__proto__` is refused, see `connected.inherited-names.test.ts`), given by every
 * shape a payload takes, through every write path, against DynamoDB Local (#239)
 * (`helpers/InheritedShapes.ts`), each case compared with what published 1.40.0 did on Effect 4.1.3
 * (`fixtures/inherited-shapes-1.40.0.json`): what each step returned or how it failed, the commands
 * each step sent, every request and the rows.
 *
 * - Effect's parser reads a field whose name `Object.prototype` holds too only as the payload's own
 *   property. Given by `Object.create`, a class's getter or a proxy without own-key traps, it isn't
 *   read: an optional field is left out, a required one fails `Missing key`. The parser decides
 *   there, and every step, request and row is 1.40.0's.
 * - Given as the payload's own property, the parser reads it as it reads an ordinary name. Each step
 *   does what 1.40.0 did, but where 1.40.0 did otherwise than with the ordinary name (it misread
 *   the name in its own reads, or did with it what followed from that): the step does what it does
 *   with the ordinary name, in the same shape, and the case's requests and rows are that case's.
 * - A strict proxy is compared with what 1.40.0 did given it as the parser sees it (a plain object
 *   holding what the parser reads of it): given the proxy, 1.40.0's update and patch died reading a
 *   name the proxy doesn't hold.
 *
 * `fixtures/inherited-shapes-effect-4.1.2.json` records what 1.40.0 did on Effect 4.1.2, run in a
 * process of its own, with three names given by each of those three shapes: the parser read them
 * as it reads an ordinary name. It is the record of the change.
 *
 * Both are generated once from the published package: don't regenerate or "fix" them.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { Cause, Clock, Config, Effect, Exit, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Zlib from "../src/compression/zlib.js"
import * as Lib from "../src/index.js"
import {
  type Api,
  asControl,
  CONTROL,
  capture,
  caseKey,
  type Outcome,
  type Position,
} from "./helpers/InheritedNames.js"
import {
  CROSSED_NAMES,
  CROSSED_POSITIONS,
  CROSSED_SHAPES,
  parserReads,
} from "./helpers/InheritedShapes.js"

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

type StepOutcome = Outcome["steps"][string]

interface Recorded {
  readonly refused?: string
  readonly steps: Outcome["steps"]
  readonly sentBy: NonNullable<Outcome["sentBy"]>
  /** A SHA-256 of every request, keys sorted: {@link digest}. */
  readonly requests: string
  readonly rows: Outcome["rows"]
}

const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"))

const fixture = read("./fixtures/inherited-shapes-1.40.0.json") as {
  readonly cases: Readonly<Record<string, Recorded>>
  /** What 1.40.0 did with a strict proxy given as the parser sees it. */
  readonly seen: Readonly<Record<string, Recorded>>
}

const onEffect412 = read("./fixtures/inherited-shapes-effect-4.1.2.json") as {
  readonly cases: Readonly<Record<string, Readonly<Record<string, StepOutcome>>>>
}

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
        )
      : value

/** A SHA-256 of `requests`, each object's keys sorted. */
const digest = (requests: unknown) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(sorted(requests)))
    .digest("hex")}`

/** An outcome as the fixture holds it. */
const asRecorded = (outcome: Outcome): Recorded => ({
  ...(outcome.refused === undefined ? {} : { refused: outcome.refused }),
  steps: outcome.steps,
  sentBy: outcome.sentBy ?? {},
  requests: digest(outcome.requests),
  rows: outcome.rows,
})

let tables = 0
const outcomes = new Map<string, Promise<Outcome>>()
/** Each case runs once: a case's ordinary name serves every name in its shape. */
const run = (position: Position, name: string): Promise<Outcome> => {
  const key = caseKey(position, name)
  let outcome = outcomes.get(key)
  if (outcome === undefined) {
    outcome = capture(api, ENDPOINT, `crossed-${Date.now()}-${tables++}`, position, name)
    outcomes.set(key, outcome)
  }
  return outcome
}

const STRICT = "strict proxy"
/** The defect 1.40.0's own reads died with, given a strict proxy. */
const STRICT_DIED = "strict proxy: no "

describeConnected("a name every object inherits, in every shape, on every write (#239)", () => {
  it("crosses every shape with every name", () => {
    expect(CROSSED_POSITIONS.map(({ shape }) => shape)).toEqual(Object.keys(CROSSED_SHAPES))
    expect(CROSSED_NAMES).toEqual(
      [CONTROL, ...Object.getOwnPropertyNames(Object.prototype)].filter(
        (name) => name !== "__proto__",
      ),
    )
    expect(Object.keys(fixture.cases)).toEqual(
      CROSSED_POSITIONS.flatMap(({ position }) =>
        CROSSED_NAMES.map((name) => caseKey(position, name)),
      ),
    )
  })

  for (const { shape, as, position } of CROSSED_POSITIONS) {
    describe(shape, () => {
      for (const name of CROSSED_NAMES) {
        it(name, { timeout: 60_000 }, async () => {
          const key = caseKey(position, name)
          const recorded = fixture.cases[key]!
          expect(recorded).toBeDefined()
          const outcome = await run(position, name)
          expect(JSON.stringify(outcome)).not.toContain("[native code]")
          if (!parserReads(as, name)) {
            // The parser doesn't read the name: every step, request and row is 1.40.0's.
            expect(asRecorded(outcome)).toEqual(recorded)
            return
          }
          const ordinaryKey = caseKey(position, CONTROL)
          const base = shape === STRICT ? fixture.seen[key]! : recorded
          const baseOrdinary =
            shape === STRICT ? fixture.seen[ordinaryKey]! : fixture.cases[ordinaryKey]!
          if (shape === STRICT) {
            // Given the proxy, 1.40.0 did what it did given it as the parser sees it, until its own
            // reads died on a name the proxy doesn't hold.
            expect(recorded.steps.update!.error).toContain(STRICT_DIED)
            let died = false
            for (const [label, step] of Object.entries(recorded.steps)) {
              died ||= step.error?.includes(STRICT_DIED) === true
              if (!died) expect({ label, ...step }).toEqual({ label, ...base.steps[label] })
            }
          }
          // The steps where 1.40.0 did otherwise than with the ordinary name: none for the ordinary
          // name, and some for every other the parser reads.
          const misread = Object.keys(base.steps).filter(
            (label) =>
              JSON.stringify(base.steps[label]) !== JSON.stringify(baseOrdinary.steps[label]),
          )
          expect(misread.length > 0).toBe(name !== CONTROL)
          const ordinary = await run(position, CONTROL)
          for (const [label, step] of Object.entries(base.steps)) {
            const expected = misread.includes(label) ? ordinary.steps[label] : step
            expect({ label, ...outcome.steps[label] }).toEqual({ label, ...expected })
          }
          expect(Object.keys(outcome.steps)).toEqual(Object.keys(base.steps))
          expect(outcome.refused).toEqual(base.refused)
          if (misread.length === 0) {
            expect(asRecorded(outcome)).toEqual(base)
          } else {
            expect(outcome.sentBy).toEqual(ordinary.sentBy)
            expect(JSON.parse(asControl(JSON.stringify(outcome.requests), name))).toEqual(
              ordinary.requests,
            )
            expect(outcome.rows).toEqual(ordinary.rows)
          }
        })
      }
    })
  }

  it(
    "on Effect 4.1.2 the parser read such a name given any other way: the record of the change",
    {
      timeout: 120_000,
    },
    async () => {
      expect(Object.keys(onEffect412.cases).length).toBe(9)
      for (const [held, steps] of Object.entries(onEffect412.cases)) {
        const [shape, name] = held.split(": ") as [string, string]
        const { as, position } = CROSSED_POSITIONS.find((each) => each.shape === shape)!
        expect({ held, read: parserReads(as, name) }).toEqual({ held, read: false })
        const outcome = await run(position, name)
        const ordinary = await run(position, CONTROL)
        const recorded = fixture.cases[caseKey(position, name)]!
        for (const [label, step] of Object.entries(steps)) {
          // Effect 4.1.2 read it as it reads the ordinary name; under 4.1.3 it isn't read, as it
          // wasn't by 1.40.0 there.
          expect({ held, label, ...step }).toEqual({ held, label, ...ordinary.steps[label] })
          expect({ held, label, ...outcome.steps[label] }).toEqual({
            held,
            label,
            ...recorded.steps[label],
          })
          expect(outcome.steps[label]).not.toEqual(step)
        }
        expect(outcome.steps.put!.error).toContain(`Missing key\n  at ["inner"]["${name}"]`)
      }
    },
  )
})
