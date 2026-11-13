/**
 * A function a caller gives as a value, its object's own property, on every path that reads a
 * caller's record, against DynamoDB Local (#239, `helpers/OwnFunctions.ts`), compared with what
 * published 1.40.0 did on Effect 4.1.3 (`fixtures/own-functions-1.40.0.json`): what each step
 * returned or how it failed, every request and the rows.
 *
 * Only a function inherited from `Object.prototype` is no value given. A function the object holds
 * itself is given, and each path does with it what 1.40.0 did: an index accessor's sort composite
 * and a collection's partition composite are composed from it as 1.40.0 composed them (and find
 * nothing), a key schema refuses it, a condition, a filter and an update's record operation send
 * what 1.40.0 sent (and DynamoDB refuses it), `.within()` refuses it, an aggregate's id and an
 * event's `_tag` fail as they did.
 *
 * One request reads otherwise: a condition on a field named like an `Object.prototype` member
 * (`toString`). 1.40.0 left the field's name out of the request, misreading it in its own map of
 * names, so DynamoDB refused the name; the request now names it, as it names an ordinary field, and
 * DynamoDB refuses the value, as it does on the ordinary field's condition.
 *
 * Run with `escapeKeys` on (`test:connected:escape-on`), a key composed from the function's text
 * escapes its spaces and line breaks, and 1.40.0's key text is escaped the same way before it's
 * compared; nothing else of the fixture changes.
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
import { type Api, CONTROL, capture, type Outcome } from "./helpers/InheritedNames.js"
import { FUNCTION_TEXT, OWN_FUNCTION_POSITION } from "./helpers/OwnFunctions.js"

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

const recordedFixture = JSON.parse(
  readFileSync(new URL("./fixtures/own-functions-1.40.0.json", import.meta.url), "utf8"),
) as { readonly cases: Readonly<Record<string, Outcome>> }

/**
 * Whether this run has `escapeKeys` on (`test:connected:escape-on`). The function's text holds
 * spaces and line breaks, which an escaping schema writes as `%20` and `%0a` in a key composed from
 * it; 1.40.0 ran with it off.
 */
const ESCAPE_ON = Lib.DynamoSchema.make({ name: "x", version: 1 }).escapeKeys === true

/**
 * What 1.40.0 did, its key text as this run composes it: unchanged, or with `escapeKeys` on, the
 * function's source escaped in each key text that holds it (a string starting with the schema's
 * `$`), in the requests and the rows. A value stored or sent as given (an event's `streamId`) and
 * what each step returned or how it failed are 1.40.0's as they are.
 */
const fixture = ((): typeof recordedFixture => {
  if (!ESCAPE_ON) return recordedFixture
  const inJson = (text: string) => JSON.stringify(text).slice(1, -1)
  const from = inJson(FUNCTION_TEXT)
  const to = inJson(Lib.KeyComposer.escapeKeyText(FUNCTION_TEXT, "lowercase"))
  /** `json` with the source escaped inside each JSON string literal holding key text. */
  const inKeys = (json: string) =>
    json.replace(/"\$(?:[^"\\]|\\.)*"/g, (literal) => literal.replaceAll(from, to))
  return {
    cases: Object.fromEntries(
      Object.entries(recordedFixture.cases).map(([key, outcome]) => [
        key,
        {
          ...outcome,
          requests: JSON.parse(inKeys(JSON.stringify(outcome.requests))),
          rows: outcome.rows.map(inKeys),
        },
      ]),
    ),
  }
})()

/** The requests each step sent, by its label. */
const requestsByStep = (outcome: Outcome): Record<string, ReadonlyArray<any>> => {
  const by: Record<string, ReadonlyArray<any>> = {}
  let at = 0
  for (const [label, commands] of Object.entries(outcome.sentBy ?? {})) {
    by[label] = outcome.requests.slice(at, at + commands.length)
    at += commands.length
  }
  return by
}

const MEMBER = "condition, a field named like a member of Object.prototype"
const ORDINARY = "condition, a record"

describeConnected("a function given as a value, its object's own property (#239)", () => {
  it(OWN_FUNCTION_POSITION.key, { timeout: 120_000 }, async () => {
    const recorded = fixture.cases[OWN_FUNCTION_POSITION.key]!
    expect(recorded).toBeDefined()
    const outcome = await capture(
      api,
      ENDPOINT,
      `functions-${Date.now()}`,
      OWN_FUNCTION_POSITION,
      CONTROL,
    )
    expect(outcome.refused).toEqual(recorded.refused)
    expect(Object.keys(outcome.steps)).toEqual(Object.keys(recorded.steps))
    const sent = requestsByStep(outcome)
    const recordedSent = requestsByStep(recorded)
    for (const [label, step] of Object.entries(outcome.steps)) {
      if (label === MEMBER) continue
      expect({ label, ...step }).toEqual({ label, ...recorded.steps[label] })
      expect({ label, requests: sent[label] }).toEqual({ label, requests: recordedSent[label] })
    }
    // 1.40.0 left the member's name out, and DynamoDB refused that; it's named now, and DynamoDB
    // refuses the value, as on the ordinary field's condition.
    expect(recorded.steps[MEMBER]!.error).toMatch(/attribute name used in the document path/)
    expect(outcome.steps[MEMBER]).toEqual(outcome.steps[ORDINARY])
    const [request] = recordedSent[MEMBER]!
    expect(sent[MEMBER]).toEqual([
      {
        ...request,
        input: {
          ...request.input,
          ExpressionAttributeNames: {
            ...request.input.ExpressionAttributeNames,
            "#e0": "toString",
          },
        },
      },
    ])
    expect(outcome.sentBy).toEqual(recorded.sentBy)
    expect(outcome.rows).toEqual(recorded.rows)
  })
})
