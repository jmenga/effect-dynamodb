/**
 * The paths that hand Effect's parser a copy of a caller's object, against DynamoDB Local (#239,
 * `helpers/CopyPaths.ts`): a write filling a decoding default an index key needs, an aggregate's
 * stamps, and an aggregate's `create` fetching what ids name, its lists given under their
 * `inputField` two sub-aggregates down, required and optional. Every object a step gives, at every
 * depth, is a probe's: counting getters (an undeclared one counted, and throwing), getters that
 * throw on their second read, a proxy recording each trap in order, a proxy whose `has` trap
 * throws, and an object inheriting each name the library fills from a getter that throws.
 *
 * Each case is compared with what published 1.40.0 did on Effect 4.1.3
 * (`fixtures/copy-paths-1.40.0.json`): what each step returned or how it failed, what its probe saw
 * (each read counted, each trap in order), every request and the rows. Each copy is 1.40.0's.
 *
 * One outcome reads otherwise: where the missing-value check reads a name the object answers by
 * inheritance and the getter throws, 1.40.0 died; the step now fails with a `ValidationError` saying
 * so, as reading such a name fails on every other path, having read and sent the same.
 *
 * Two known differences, each a change made since (`KNOWN`). An aggregate's `create` reads the
 * input again to judge `EDD-9159` (#241): more reads only a getter or a proxy sees (a proxy's
 * other traps all reads, `get` or `has`, the rest in 1.40.0's order), every step returning,
 * sending and leaving what it did. And with ids to fetch, an object inheriting `line`, which the
 * library fills from the entity fetched, from a getter that throws: 1.40.0 created the aggregate
 * without reading it; the `create` now reads it there and fails with that `ValidationError`,
 * writing nothing, so a `get` of the aggregate finds none.
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
import { COPY_PATH_POSITIONS, PATHS, PROBES } from "./helpers/CopyPaths.js"
import {
  type Api,
  capture,
  type Outcome,
  requestsByStep,
  trapsBeside,
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
  readFileSync(new URL("./fixtures/copy-paths-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Readonly<Record<string, Outcome>> }

/** The refusal of a name the object answers by inheritance, its getter throwing. */
const UNREADABLE =
  /^ValidationError: Reading "([^"]+)" from the object given threw: (.*)\. The object doesn't hold "\1" itself but answers for it by inheritance/

/**
 * A step's outcome, a failure reading an inherited name written as 1.40.0's death reading it, where
 * 1.40.0 died there: what it saw is unchanged.
 */
const asRecorded = (
  step: Outcome["steps"][string],
  recorded: Outcome["steps"][string] | undefined,
): Outcome["steps"][string] => {
  if (step.value === undefined || recorded?.value === undefined) return step
  const mine = JSON.parse(step.value) as { failed?: string }
  const theirs = JSON.parse(recorded.value) as { failed?: string }
  const unreadable = UNREADABLE.exec(mine.failed ?? "")
  if (unreadable === null || theirs.failed !== `defect: ${unreadable[2]}`) return step
  return { ...step, value: JSON.stringify({ ...mine, failed: theirs.failed }) }
}

/** The cases a change made since 1.40.0 reads otherwise, by what changed (see above). */
const KNOWN: Readonly<Record<string, "more reads" | "line read">> = {
  "an aggregate's stamps, counting getters": "more reads",
  "an aggregate's stamps, counting getters, an undeclared one throwing": "more reads",
  "an aggregate's stamps, getters that throw on their second read": "more reads",
  "an aggregate's stamps, a proxy recording each trap": "more reads",
  "an aggregate's fetched ids, the lists required, counting getters": "more reads",
  "an aggregate's fetched ids, the lists required, a proxy recording each trap": "more reads",
  "an aggregate's fetched ids, the lists required, each name the library fills inherited from a throwing getter":
    "line read",
  "an aggregate's fetched ids, the lists optional, counting getters": "more reads",
  "an aggregate's fetched ids, the lists optional, a proxy recording each trap": "more reads",
  "an aggregate's fetched ids, the lists optional, each name the library fills inherited from a throwing getter":
    "line read",
}

/** A proxy's traps as a step's probe saw them, in order. */
const trapsOf = (step: Outcome["steps"][string] | undefined): ReadonlyArray<string> => {
  const seen = (JSON.parse(step?.value ?? "{}") as { seen?: string }).seen ?? ""
  return seen === "" ? [] : seen.split(", ")
}

let tables = 0

describeConnected("the copies made of a caller's object, as 1.40.0 made them (#239)", () => {
  it("covers every path under every probe", () => {
    expect(COPY_PATH_POSITIONS).toHaveLength(PATHS.length * Object.keys(PROBES).length)
    expect(Object.keys(fixture.cases)).toEqual(COPY_PATH_POSITIONS.map((position) => position.key))
  })

  for (const position of COPY_PATH_POSITIONS) {
    it(position.key, { timeout: 120_000 }, async () => {
      const recorded = fixture.cases[position.key]!
      expect(recorded).toBeDefined()
      const outcome = await capture(
        api,
        ENDPOINT,
        `copies-${Date.now()}-${tables++}`,
        position,
        "label",
      )
      expect(outcome.refused).toEqual(recorded.refused)
      expect(Object.keys(outcome.steps)).toEqual(Object.keys(recorded.steps))
      const known = KNOWN[position.key]
      if (known === "line read") {
        const sent = requestsByStep(outcome)
        const wasSent = requestsByStep(recorded)
        const notMade = new Set<string>()
        for (const [label, step] of Object.entries(outcome.steps)) {
          const was = recorded.steps[label]!
          const failed = (JSON.parse(step.value ?? "{}") as { failed?: string }).failed ?? ""
          if (UNREADABLE.exec(failed)?.[1] === "line") {
            const made = JSON.parse((JSON.parse(was.value!) as { value: string }).value)
            notMade.add(`get ${(made as { id: string }).id}`)
            expect(sent[label]!.map((request) => request.command)).not.toContain(
              "TransactWriteItems",
            )
          } else if (notMade.has(label)) {
            expect(failed).toMatch(/^AggregateAssemblyError/)
          } else {
            expect({ label, step: asRecorded(step, was), sent: sent[label] }).toEqual({
              label,
              step: was,
              sent: wasSent[label],
            })
          }
        }
        expect(notMade.size).toBeGreaterThan(0)
        expect(recorded.rows).toEqual(expect.arrayContaining([...outcome.rows]))
        return
      }
      for (const [label, step] of Object.entries(outcome.steps)) {
        if (known === "more reads") {
          expect({ label, step: withoutReads(asRecorded(step, recorded.steps[label])) }).toEqual({
            label,
            step: withoutReads(recorded.steps[label]),
          })
          if (position.key.endsWith("a proxy recording each trap")) {
            const beside = trapsBeside(trapsOf(step), trapsOf(recorded.steps[label]))
            expect({ label, beside: beside?.filter((trap) => !/ (get|has) /.test(trap)) }).toEqual({
              label,
              beside: [],
            })
          }
          continue
        }
        expect({ label, ...asRecorded(step, recorded.steps[label]) }).toEqual({
          label,
          ...recorded.steps[label],
        })
      }
      expect(outcome.sentBy).toEqual(recorded.sentBy)
      expect(outcome.requests).toEqual(recorded.requests)
      expect(outcome.rows).toEqual(recorded.rows)
    })
  }
})
