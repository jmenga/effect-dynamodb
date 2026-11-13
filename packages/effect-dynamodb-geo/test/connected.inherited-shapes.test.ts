/**
 * Every member of `Object.prototype` a geo input gives as a field (`__proto__` aside, refused where
 * it would be written), in every shape an input takes, through geo's write paths, against DynamoDB
 * Local (#239) (`helpers/InheritedShapes.ts`): `GeoIndex.put`, and `enrich` with the entity's put
 * in a transaction, read back by `nearby`. Each case is compared with what published 1.40.0 did on
 * Effect 4.1.3 (`fixtures/inherited-shapes-geo-1.40.0.json`): what each step returned or how it
 * failed, the commands each step sent, every request and the rows.
 *
 * Every step, request and row is 1.40.0's, in every shape, under every name. An input given by
 * `Object.create`, a class with getters or a proxy reaches `enrich`'s copy, a spread as 1.40.0 made
 * it, which copies its own properties alone: its put and its enrich fail `Missing key` at
 * `vehicleId`, as on 1.40.0.
 *
 * And what geo reads of a caller's objects (`fixtures/caller-reads-geo-1.40.0.json`): an input to
 * `put` and `enrich`, and `nearby`'s options, center, time window and `pkFilter`, each an object of
 * counting getters beside an undeclared one (counted, and throwing): each step reads each name as
 * many times as 1.40.0 did, and does what it did.
 *
 * And the copy `enrich` makes (`fixtures/copy-paths-geo-1.40.0.json`): an input to `put`, to
 * `enrich` and to `enrich` then the entity's put in a transaction, every object in it at every depth
 * a probe's (counting getters, an undeclared one counted and throwing; getters that throw on their
 * second read; a proxy recording each trap in order; a proxy whose `has` trap throws; an object
 * inheriting each name geo fills from a getter that throws): each step does what 1.40.0 did, its
 * probe seeing what 1.40.0's saw, with the same requests and rows.
 *
 * All are generated once from the published packages: don't regenerate or "fix" them.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { Cause, Config, Effect, Exit, Layer, Schema } from "effect"
import * as Lib from "effect-dynamodb"
import { describe, expect, it } from "vitest"
import * as GeoIndex from "../src/GeoIndex.js"
import {
  captureGeo,
  captureGeoCopies,
  captureGeoReads,
  type GeoApi,
  type GeoOutcome,
  NAMES,
  PROBES,
  SHAPES,
  UNDECLARED,
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

const api: GeoApi = { ...Lib, GeoIndex, Cause, Effect, Exit, Layer, Schema }

interface Recorded {
  readonly steps: GeoOutcome["steps"]
  readonly sentBy: GeoOutcome["sentBy"]
  /** A SHA-256 of every request, keys sorted: {@link digest}. */
  readonly requests: string
  readonly rows: GeoOutcome["rows"]
}

const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"))

const fixture = read("./fixtures/inherited-shapes-geo-1.40.0.json") as {
  readonly cases: Readonly<Record<string, Recorded>>
}

const copiesFixture = read("./fixtures/copy-paths-geo-1.40.0.json") as {
  readonly cases: Readonly<Record<string, Recorded>>
}

const readsFixture = read("./fixtures/caller-reads-geo-1.40.0.json") as {
  readonly cases: Readonly<Record<string, Pick<GeoOutcome, "steps" | "rows">>>
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
const asRecorded = (outcome: GeoOutcome): Recorded => ({
  steps: outcome.steps,
  sentBy: outcome.sentBy,
  requests: digest(outcome.requests),
  rows: outcome.rows,
})

let tables = 0

describeConnected("a name every object inherits, in every shape, on geo's writes (#239)", () => {
  it("crosses every shape with every name", () => {
    expect(Object.keys(fixture.cases)).toEqual(
      Object.keys(SHAPES).flatMap((shape) => NAMES.map((name) => `${shape}: ${name}`)),
    )
  })

  for (const [shape, as] of Object.entries(SHAPES)) {
    describe(shape, () => {
      for (const name of NAMES) {
        it(name, { timeout: 60_000 }, async () => {
          const key = `${shape}: ${name}`
          const recorded = fixture.cases[key]!
          expect(recorded).toBeDefined()
          const outcome = await captureGeo(
            api,
            ENDPOINT,
            `geo-shapes-${Date.now()}-${tables++}`,
            as,
            name,
          )
          expect(asRecorded(outcome)).toEqual(recorded)
        })
      }
    })
  }

  it("probes every object of an input under every probe", () => {
    expect(Object.keys(copiesFixture.cases)).toEqual(Object.keys(PROBES))
  })

  for (const [probe, made] of Object.entries(PROBES)) {
    it(`the copy enrich makes, ${probe}`, { timeout: 60_000 }, async () => {
      const outcome = await captureGeoCopies(
        api,
        ENDPOINT,
        `geo-copies-${Date.now()}-${tables++}`,
        made,
      )
      expect(asRecorded(outcome)).toEqual(copiesFixture.cases[probe])
    })
  }

  for (const undeclared of UNDECLARED) {
    it(
      `what geo reads of a caller's objects, the undeclared getter ${undeclared}`,
      {
        timeout: 60_000,
      },
      async () => {
        const outcome = await captureGeoReads(
          api,
          ENDPOINT,
          `geo-reads-${Date.now()}-${tables++}`,
          undeclared,
        )
        const recorded = readsFixture.cases[undeclared]!
        expect(outcome.steps).toEqual(recorded.steps)
        expect(outcome.rows).toEqual(recorded.rows)
      },
    )
  }
})
