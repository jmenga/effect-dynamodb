/**
 * A model field named like one of the path builder's own members (#238): `at`, `size` and `entry`
 * (methods), `segments`, `_tag`, `pipe`, `then` and `toJSON`. In a path callback `t.<name>` is the
 * member, not the field, as through 1.40.0; this pins that, and the forms that reach the field
 * (named in the changeset): an equality shorthand (`{ eq: { at: 1 } }`, `.filter({ at: 1 })`), a
 * record operation (`.set({ at: 1 })`) and a path operation's segments (`{ segments: ["at"] }`).
 */

import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Expression from "../src/Expression.js"
import { createPathBuilder } from "../src/internal/PathBuilder.js"

const Model = Schema.Struct({
  at: Schema.Number,
  size: Schema.Number,
  entry: Schema.String,
  segments: Schema.String,
})

describe("a model field named like a path builder member", () => {
  it("is the builder's member in a callback, as through 1.40.0", () => {
    const t = createPathBuilder<typeof Model.Type>() as unknown as Record<string, unknown>
    expect(typeof t.at).toBe("function")
    expect(typeof t.size).toBe("function")
    expect(typeof t.entry).toBe("function")
    expect(t.segments).toEqual([])
    expect(t.then).toBeUndefined()
    expect(t.pipe).toBeUndefined()
  })

  it("is reached by an equality shorthand", () => {
    const { expression, names } = Expression.condition({ eq: { at: 1, size: 2 } })
    expect(Object.values(names).sort()).toEqual(["at", "size"])
    expect(expression).toContain("=")
  })
})
