/**
 * What geo asks of a caller's object, trap by trap, against published 1.40.0 (#239)
 * (`helpers/ReadParity.ts`): each input to `put`, `enrich` and `enrich` then the entity's put in a
 * transaction, and `nearby`'s options, center, time window and `pkFilter`, is a proxy recording
 * each trap it receives, at the top level and, in the "deep" runs, nested objects too, under
 * ordinary names and under names `Object.prototype` holds given as own properties.
 *
 * Read as 1.40.0 read it: each step asks the same traps, of the same names, as many times, in the
 * same order, returns what it returned, sends the requests it sent, and leaves the rows it left
 * (`fixtures/read-parity-geo-1.40.0.json`, generated once from the published packages: don't
 * regenerate or "fix" it).
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { readFileSync } from "node:fs"
import { Cause, Config, Effect, Exit, Layer, Schema } from "effect"
import * as Lib from "effect-dynamodb"
import { describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import type { GeoApi } from "./helpers/InheritedShapes.js"
import { captureGeoTraps, type GeoTraced, NAME_SETS, VARIANTS } from "./helpers/ReadParity.js"

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

const api: GeoApi = { ...Lib, GeoIndex, Cause, Effect, Exit, Layer, Schema }

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/read-parity-geo-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Readonly<Record<string, GeoTraced>> }

let tables = 0

describeConnected("each geo input read as 1.40.0 read it, trap for trap (#239)", () => {
  const cases = Object.keys(NAME_SETS).flatMap((set) =>
    VARIANTS.map((variant) => ({ key: `${set}, ${variant}`, set, variant })),
  )

  it("covers every case the fixture holds", () => {
    expect(cases.map(({ key }) => key)).toEqual(Object.keys(fixture.cases))
  })

  for (const { key, set, variant } of cases) {
    it(key, { timeout: 60_000 }, async () => {
      const outcome = await captureGeoTraps(
        api,
        ENDPOINT,
        `geo-parity-${Date.now()}-${tables++}`,
        set,
        variant,
      )
      const recorded = fixture.cases[key]!
      for (const [label, traps] of Object.entries(recorded.traces)) {
        expect({ label, traps: outcome.traces[label] }).toEqual({ label, traps })
      }
      expect(outcome.steps).toEqual(recorded.steps)
      expect(outcome.sentBy).toEqual(recorded.sentBy)
      expect(outcome.requests).toEqual(recorded.requests)
      expect(outcome.rows).toEqual(recorded.rows)
    })
  }
})
