/**
 * A struct with a required property named `__proto__`, in every container a model can hold one in,
 * against DynamoDB Local (#239) (`helpers/ProtoContainers.ts`).
 *
 * Where every write stores the name (every container from the root down required and certain to
 * hold a map), the definition is refused: `EDD-9152` for an entity, `EDD-9153` for an aggregate.
 * Anywhere else (an optional or `optionalKey` field, a nullable one, a union's alternative, a list's
 * or a tuple's rest element, a record's value, an `Option`, an aggregate's optional `one` edge or
 * sub-aggregate) the definition loads, as it did on 1.40.0; a write leaving the container out (or
 * empty) sends exactly the requests 1.40.0 sent and stores the same rows, and a write that gives the
 * name is refused (`EDD-9165`) and writes nothing. On 1.40.0 that write failed at DynamoDB (an
 * entity's, and an aggregate root's) or wrote rows no read could assemble (an aggregate's edge and
 * sub-aggregate).
 *
 * `fixtures/proto-containers-1.40.0.json` holds what published 1.40.0 did with each case on Effect
 * 4.1.3 (the same as on 4.1.2). It's generated once from the published package: don't regenerate or
 * "fix" it.
 *
 * And the property itself of each type a write may leave without a value (`TYPED_POSITIONS`): a
 * definition is refused only where no value of the property's stored form stores nothing (`NullOr`,
 * `OptionFromNullOr`); 1.40.0 failed every write of those at DynamoDB, or stored a row whose read
 * lost the value. Everywhere else it loads: a write storing nothing under the name (`undefined`, a
 * `None` encoded `undefined`, a default omitted on encoding) sends 1.40.0's requests, stores its
 * rows and returns what 1.40.0 returned, as does a read of them, and one storing a value is refused
 * (`EDD-9165`), where 1.40.0 failed at DynamoDB or stored a row whose read lost it.
 * `fixtures/proto-property-types-1.40.0.json` holds what 1.40.0 did.
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
  CONTAINER_POSITIONS,
  CONTAINERS,
  PROPERTY_TYPES,
  TYPED_POSITIONS,
} from "./helpers/ProtoContainers.js"

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

interface Recorded extends Outcome {}

const read = (file: string) =>
  JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as {
    readonly cases: Readonly<Record<string, Recorded>>
  }

const fixture = read("./fixtures/proto-containers-1.40.0.json")
const typedFixture = read("./fixtures/proto-property-types-1.40.0.json")

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

/** The commands that write. */
const WRITES = new Set([
  "PutItem",
  "UpdateItem",
  "DeleteItem",
  "BatchWriteItem",
  "TransactWriteItems",
])

let tables = 0

describeConnected("a required __proto__ in every container (#239)", () => {
  it("covers every container, for an entity and an aggregate", () => {
    expect(CONTAINER_POSITIONS).toHaveLength(CONTAINERS.length * 2 + 2)
  })

  for (const { position, refusedAt } of CONTAINER_POSITIONS) {
    it(position.key, { timeout: 60_000 }, async () => {
      const outcome = await capture(
        api,
        ENDPOINT,
        `containers-${Date.now()}-${tables++}`,
        position,
        "__proto__",
      )
      const recorded = fixture.cases[position.key]
      expect(recorded).toBeDefined()
      // 1.40.0 took every definition.
      expect(recorded!.refused).toBeUndefined()
      if (refusedAt !== undefined) {
        expect(outcome.refused).toMatch(new RegExp(`^\\[${refusedAt}\\] `))
        expect(outcome.requests).toEqual([])
        return
      }
      expect(outcome.refused).toBeUndefined()
      const labels = Object.keys(outcome.steps)
      expect(labels).toEqual(Object.keys(recorded!.steps))
      let sent = 0
      let sentBefore = 0
      for (const label of labels) {
        const step = outcome.steps[label]!
        const commands = outcome.sentBy![label]!
        if (label.endsWith("without it")) {
          // Left out: as on 1.40.0, request for request.
          expect({ label, ...step }).toEqual({ label, ...recorded!.steps[label] })
          expect({ label, ...step }).toEqual({ label, ok: true, value: expect.any(String) })
          expect(outcome.requests.slice(sent, sent + commands.length)).toEqual(
            recorded!.requests.slice(sentBefore, sentBefore + recorded!.sentBy![label]!.length),
          )
        } else if (label.startsWith("get")) {
          // Nothing was written.
          expect({ label, ok: step.ok }).toEqual({ label, ok: false })
          expect(step.error).toMatch(/^(ItemNotFound|AggregateAssemblyError): /)
        } else {
          expect({ label, ...step }).toEqual({
            label,
            ok: false,
            error: expect.stringMatching(/^ValidationError: .*"__proto__".*\[EDD-9165\]/),
          })
          expect({ label, writes: commands.filter((command) => WRITES.has(command)) }).toEqual({
            label,
            writes: [],
          })
        }
        sent += commands.length
        sentBefore += recorded!.sentBy![label]!.length
      }
      // The rows the writes leaving the name out stored (item `a`), and nothing else (item `b`).
      const left = (rows: ReadonlyArray<string>) => rows.filter((row) => !/[#_]b"/.test(row))
      expect(outcome.rows).toEqual(left(outcome.rows))
      expect(outcome.rows).toEqual(left(recorded!.rows))
    })
  }
})

describeConnected(
  "a required __proto__ property of each type a write may leave empty (#239)",
  () => {
    it("covers every type, for an entity and an aggregate", () => {
      expect(TYPED_POSITIONS).toHaveLength(PROPERTY_TYPES.length * 2)
      expect(Object.keys(typedFixture.cases)).toEqual(
        TYPED_POSITIONS.map(({ position }) => position.key),
      )
    })

    for (const { position, refusedAt } of TYPED_POSITIONS) {
      it(position.key, { timeout: 60_000 }, async () => {
        const outcome = await capture(
          api,
          ENDPOINT,
          `typed-${Date.now()}-${tables++}`,
          position,
          "__proto__",
        )
        const recorded = typedFixture.cases[position.key]!
        expect(recorded).toBeDefined()
        expect(recorded.refused).toBeUndefined()
        const labels = Object.keys(recorded.steps)
        const writes = labels.filter((label) => !label.startsWith("get, "))
        const getOf = (write: string) => `get, ${write.slice(write.indexOf(", ") + 2)}`
        // A read of what 1.40.0 stored lost the property's value: it held no such property.
        const lost = (write: string) => {
          const got = recorded.steps[getOf(write)]!
          return !recorded.steps[write]!.ok || !got.ok || !got.value!.includes('"label":')
        }
        if (refusedAt !== undefined) {
          expect(outcome.refused).toMatch(new RegExp(`^\\[${refusedAt}\\] `))
          expect(outcome.requests).toEqual([])
          // 1.40.0 failed each write, or stored a row whose read lost the value.
          for (const write of writes)
            expect({ write, lost: lost(write) }).toEqual({ write, lost: true })
          return
        }
        expect(outcome.refused).toBeUndefined()
        expect(Object.keys(outcome.steps)).toEqual(labels)
        const sent = requestsByStep(outcome)
        const recordedSent = requestsByStep(recorded)
        const written: Array<string> = []
        for (const write of writes) {
          const step = outcome.steps[write]!
          const get = getOf(write)
          // Refused as it's sent (`"data.__proto__": …`), or where the payload is read, as 1.40.0's
          // struct, which didn't hold the property, read it (`… at ["data"]["__proto__"]`).
          const refused =
            /^ValidationError: (?:"data\.__proto__".*\[EDD-9165\]|.*\[EDD-9165\]\s+at \["data"\]\["__proto__"\])/s.test(
              step.error ?? "",
            )
          if (refused) {
            // Refused, nothing sent: 1.40.0 failed it, or stored a row whose read lost the value.
            expect({ write, sent: sent[write] }).toEqual({ write, sent: [] })
            expect({ write, lost: lost(write) }).toEqual({ write, lost: true })
            expect(outcome.steps[get]!.ok).toBe(false)
            continue
          }
          // Otherwise as 1.40.0 did it, request for request, and what it and the read return.
          expect({ write, requests: sent[write] }).toEqual({ write, requests: recordedSent[write] })
          for (const label of [write, get])
            expect({ label, ...outcome.steps[label] }).toEqual({ label, ...recorded.steps[label] })
          if (step.ok) written.push(write)
        }
        // The rows of the writes it sent, as 1.40.0 stored them.
        const ids = written.map((write) => `w${writes.indexOf(write)}`)
        const of = (rows: ReadonlyArray<string>) =>
          rows.filter((row) => ids.some((id) => row.includes(`_${id}"`) || row.includes(`#${id}"`)))
        expect(outcome.rows).toEqual(of(outcome.rows))
        expect(outcome.rows).toEqual(of(recorded.rows))
      })
    }
  },
)
