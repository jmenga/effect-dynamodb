/**
 * A field named `__proto__` a write leaves out, or gives a value that stores nothing, and an event
 * naming no event type, against DynamoDB Local (#239) (`helpers/ProtoLeftOut.ts`).
 *
 * A write leaving the field out, or giving `undefined`, a `None` encoded `undefined` or an empty
 * set, sends exactly the requests 1.40.0 sent, stores its rows and reads back its values. A value
 * that stores something is refused (`EDD-9165`) and nothing is written: 1.40.0 lost it. One case is
 * named rather than restored: an aggregate's field whose `None` is encoded `null`, left out of an
 * `update`, is refused (`EDD-9165`), where 1.40.0 completed (`NULL_NONE_UPDATE`).
 * `fixtures/proto-left-out-1.40.0.json` holds what published 1.40.0 did on Effect 4.1.3; never
 * regenerate it.
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
import { type Api, capture, type Outcome } from "./helpers/InheritedNames.js"
import {
  kindOf,
  LEFT_OUT_POSITIONS,
  NULL_NONE_UPDATE,
  UNTYPED_EVENT,
} from "./helpers/ProtoLeftOut.js"

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
  readFileSync(new URL("./fixtures/proto-left-out-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Readonly<Record<string, Outcome>> }

/** The requests each step sent, by its label. */
const requestsByStep = (outcome: Outcome): Record<string, ReadonlyArray<unknown>> => {
  const by: Record<string, ReadonlyArray<unknown>> = {}
  let at = 0
  for (const [label, commands] of Object.entries(outcome.sentBy ?? {})) {
    by[label] = outcome.requests.slice(at, at + commands.length)
    at += commands.length
  }
  return by
}

const WRITES = new Set(["PutItem", "UpdateItem", "BatchWriteItem", "TransactWriteItems"])

let tables = 0

describeConnected("a __proto__ field left out, or storing nothing (#239)", () => {
  it("covers every case 1.40.0 was run with", () => {
    expect(Object.keys(fixture.cases)).toEqual(
      [...LEFT_OUT_POSITIONS, NULL_NONE_UPDATE].map((position) => position.key),
    )
  })

  for (const position of LEFT_OUT_POSITIONS) {
    it(position.key, { timeout: 60_000 }, async () => {
      const outcome = await capture(
        api,
        ENDPOINT,
        `left-out-${Date.now()}-${tables++}`,
        position,
        "__proto__",
      )
      const recorded = fixture.cases[position.key]!
      expect(outcome.refused).toBeUndefined()
      expect(Object.keys(outcome.steps)).toEqual(Object.keys(recorded.steps))
      const sent = requestsByStep(outcome)
      const recordedSent = requestsByStep(recorded)
      const refusedItems: Array<string> = []
      let write: string | undefined
      for (const label of Object.keys(recorded.steps)) {
        const kind = kindOf(label)
        if (kind !== undefined) write = label
        const ofWrite = kindOf(write ?? "")
        if (ofWrite === "value") {
          if (kind === undefined) continue
          // Refused, nothing written; 1.40.0 wrote the item and lost the value.
          expect({ label, ...outcome.steps[label] }).toEqual({
            label,
            ok: false,
            error: expect.stringMatching(/^ValidationError: .*"__proto__".*\[EDD-9165\]/s),
          })
          expect({ label, writes: outcome.sentBy![label]!.filter((c) => WRITES.has(c)) }).toEqual({
            label,
            writes: [],
          })
          expect(recorded.steps[`${label}: read back`]!.value).not.toMatch(/"label":/)
          refusedItems.push(label)
          continue
        }
        // Left out, or storing nothing: as 1.40.0 did it, request for request.
        expect({ label, ...outcome.steps[label] }).toEqual({ label, ...recorded.steps[label] })
        expect({ label, requests: sent[label] }).toEqual({ label, requests: recordedSent[label] })
      }
      expect(refusedItems.length).toBeGreaterThan(0)
      // The same rows, but for the items given a value (each position's third value: `p2`, `u2`,
      // …), which 1.40.0 wrote losing the value and which are refused here.
      const others = (rows: ReadonlyArray<string>) =>
        rows.filter((row) => !/"id":\{"S":"[a-z]2"\}/.test(row))
      expect(others(outcome.rows)).toEqual(others(recorded.rows))
    })
  }
})

describeConnected("named: an aggregate's field whose None is encoded null (#239)", () => {
  it("an update leaving it out is refused, where 1.40.0 completed", async () => {
    const outcome = await capture(
      api,
      ENDPOINT,
      `named-${Date.now()}`,
      NULL_NONE_UPDATE,
      "__proto__",
    )
    const recorded = fixture.cases[NULL_NONE_UPDATE.key]!
    expect(outcome.steps.create).toEqual(recorded.steps.create)
    expect(recorded.steps.update).toEqual({ ok: true, value: '{"id":"a","x":2}' })
    expect(outcome.steps.update).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^ValidationError: "__proto__".*\[EDD-9165\] Nothing was written/s,
      ),
    })
    expect(outcome.sentBy!.update).toEqual(["Query"])
    expect(outcome.steps.get).toEqual({ ok: true, value: '{"id":"a","label":{},"x":1}' })
  })
})

describeConnected("an event naming no event type (#239)", () => {
  it("is refused before anything is sent, and the stream reads as before", async () => {
    const outcome = await capture(api, ENDPOINT, `untyped-${Date.now()}`, UNTYPED_EVENT, "label")
    expect(outcome.steps["append a plain object"]!.ok).toBe(true)
    // 1.40.0 died here (`Cannot read properties of undefined (reading 'identifier')`).
    expect(outcome.steps["append an object without a prototype"]).toEqual({
      ok: false,
      error: expect.stringMatching(/^ValidationError: events\[0\] names no event type/),
    })
    expect(outcome.sentBy!["append an object without a prototype"]).toEqual([])
    expect(outcome.steps.read).toEqual({
      ok: true,
      value: expect.stringMatching(
        /^\[\{"data":\{"kind":"noted","note":"first"\}.*"version":1\}\]$/,
      ),
    })
    expect(outcome.steps.currentVersion).toEqual({ ok: true, value: "1" })
    expect(outcome.rows).toHaveLength(1)
  })
})
