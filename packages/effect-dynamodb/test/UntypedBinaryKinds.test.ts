/**
 * Binary data in an untyped field (#242, `EDD-9161`), kind by kind, against what published 1.40.0 did
 * with each (`fixtures/untyped-binary-kinds-1.40.0.json`, measured on DynamoDB Local with Effect 4.1.2
 * and 4.1.3). A kind 1.40.0 failed to send, or stored as less than it is, is refused, each by its own
 * constructor; every other kind is stored as 1.40.0 stored it, byte for byte, and reads back as it
 * did: a `Float16Array`, a subclass of a typed array, and any kind a later runtime adds.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

interface Measured {
  readonly put: string
  readonly stored: unknown
  readonly read: unknown
  readonly updateSet: string
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/untyped-binary-kinds-1.40.0.json", import.meta.url), "utf8"),
) as { readonly generatedFrom: string; readonly kinds: Readonly<Record<string, Measured>> }

const Float16 = (globalThis as { readonly Float16Array?: new (values: Array<number>) => object })
  .Float16Array

class Int8Sub extends Int8Array {}
class ArrayBufferSub extends ArrayBuffer {}
class Uint8Sub extends Uint8Array {}
// A DataView's constructor is generic, which a class can't extend as it is.
class DataViewSub extends (DataView as new (buffer: ArrayBuffer) => DataView) {}
class BlobSub extends Blob {}
class SharedSub extends SharedArrayBuffer {}
class BigSub extends BigInt64Array {}

/** Bytes 1, 2, 3 in `buffer`. */
const filled = <B extends ArrayBufferLike>(buffer: B): B => {
  new Uint8Array(buffer).set([1, 2, 3])
  return buffer
}

/** Each kind as the fixture's measurement made it, or `undefined` where this runtime hasn't it. */
const KINDS: Readonly<Record<string, () => unknown>> = {
  ArrayBuffer: () => filled(new ArrayBuffer(3)),
  SharedArrayBuffer: () => filled(new SharedArrayBuffer(3)),
  DataView: () => new DataView(filled(new ArrayBuffer(3))),
  Uint8Array: () => new Uint8Array([1, 2, 3]),
  Int8Array: () => new Int8Array([1, 2, 3]),
  Uint8ClampedArray: () => new Uint8ClampedArray([1, 2, 3]),
  Int16Array: () => new Int16Array([1, 2, 3]),
  Uint16Array: () => new Uint16Array([1, 2, 3]),
  Int32Array: () => new Int32Array([1, 2, 3]),
  Uint32Array: () => new Uint32Array([1, 2, 3]),
  Float16Array: () => (Float16 === undefined ? undefined : new Float16([1, 2, 3])),
  Float32Array: () => new Float32Array([1, 2, 3]),
  Float64Array: () => new Float64Array([1, 2, 3]),
  BigInt64Array: () => new BigInt64Array([1n, 2n, 3n]),
  BigUint64Array: () => new BigUint64Array([1n, 2n, 3n]),
  Buffer: () => Buffer.from([1, 2, 3]),
  Blob: () => new Blob([new Uint8Array([1, 2, 3])]),
  File: () => new File([new Uint8Array([1, 2, 3])], "f"),
  "Int8Array subclass": () => new Int8Sub([1, 2, 3]),
  "Float16Array subclass": () => {
    if (Float16 === undefined) return undefined
    class Float16Sub extends (Float16 as unknown as typeof Float32Array) {}
    return new Float16Sub([1, 2, 3])
  },
  "ArrayBuffer subclass": () => filled(new ArrayBufferSub(3)),
  "Uint8Array subclass": () => new Uint8Sub([1, 2, 3]),
  "DataView subclass": () => new DataViewSub(filled(new ArrayBuffer(3))),
  "Blob subclass": () => new BlobSub([new Uint8Array([1, 2, 3])]),
  "SharedArrayBuffer subclass": () => filled(new SharedSub(3)),
  "BigInt64Array subclass": () => new BigSub([1n, 2n, 3n]),
}

/** What a read of the bytes 1, 2, 3 hands back when they're kept: the bytes, or their numbers. */
const KEPT_READS = [{ bytes: [1, 2, 3] }, { "0": 1, "1": 2, "2": 3 }]

/** Whether 1.40.0 failed the write, or read back something holding none of the three bytes. */
const lostOn140 = (measured: Measured): boolean =>
  measured.put !== "ok" ||
  !KEPT_READS.some((kept) => JSON.stringify(kept) === JSON.stringify(measured.read))

/** A stored or read value as the fixture writes it: bytes (a `Buffer`'s too) as `{ bytes }`. */
const jsonOf = (value: unknown): unknown =>
  value instanceof Uint8Array
    ? { bytes: [...value] }
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.entries(value).map(([key, part]) => [key, jsonOf(part)]))
      : value

const schema = DynamoSchema.make({ name: "bin", version: 1 })
const U = Entity.make({
  model: Schema.Struct({ id: Schema.String, u: Schema.optional(Schema.Unknown) }),
  entityType: "U",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})
const Main = Table.make({ schema, entities: { U } })

const failureOf = (exit: Exit.Exit<unknown, unknown>): any =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined

describe("binary data in an untyped field, kind by kind, as 1.40.0 measured it", () => {
  it("the fixture is published 1.40.0's, and every kind it measured is here", () => {
    expect(fixture.generatedFrom).toBe("effect-dynamodb@1.40.0")
    expect(Object.keys(KINDS)).toEqual(Object.keys(fixture.kinds))
  })

  it("refuses exactly the kinds 1.40.0 failed to send or lost", () => {
    const lost = Object.entries(fixture.kinds)
      .filter(([, measured]) => lostOn140(measured))
      .map(([name]) => name)
    expect(lost).toEqual([
      "ArrayBuffer",
      "SharedArrayBuffer",
      "DataView",
      "Int8Array",
      "Uint8ClampedArray",
      "Int16Array",
      "Uint16Array",
      "Int32Array",
      "Uint32Array",
      "Float32Array",
      "Float64Array",
      "BigInt64Array",
      "BigUint64Array",
      "Blob",
      "File",
      "ArrayBuffer subclass",
      "DataView subclass",
      "Blob subclass",
      "SharedArrayBuffer subclass",
    ])
  })

  for (const [name, make] of Object.entries(KINDS)) {
    const measured = fixture.kinds[name]!
    it.effect(name, () => {
      if (make() === undefined) return Effect.void
      const table = makeRecordingTable()
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { U }, tables: { Main } })
        const put = yield* Effect.exit(db.entities.U.put({ id: "p", u: make() }).asEffect())
        yield* db.entities.U.put({ id: "s" }).asEffect()
        const set = yield* Effect.exit(
          db.entities.U.update({ id: "s" }).set({ u: make() }).asEffect(),
        )
        const row = (id: string) => [...table.items.values()].find((item) => item.id?.S === id)?.u
        if (lostOn140(measured)) {
          for (const exit of [put, set]) {
            const error = failureOf(exit)
            expect(error).toBeInstanceOf(ValidationError)
            expect(String(error.cause)).toContain(`is binary data (`)
            expect(String(error.cause)).toContain("[EDD-9161]")
          }
          expect(row("p")).toBeUndefined()
          expect(row("s")).toBeUndefined()
          return
        }
        expect(Exit.isSuccess(put) && Exit.isSuccess(set)).toBe(true)
        expect(jsonOf(row("p"))).toEqual(measured.stored)
        expect(jsonOf(row("s"))).toEqual(measured.stored)
        const got = yield* db.entities.U.get({ id: "p" })
        expect(jsonOf(got.u)).toEqual(measured.read)
      }).pipe(Effect.provide(Main.layer({ name: "bin" })), Effect.provide(table.layer))
    })
  }
})
