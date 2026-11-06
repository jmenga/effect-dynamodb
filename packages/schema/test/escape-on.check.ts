/** Only the `test:escape-on` runs include this: it fails if their plugin didn't reach the composer. */
import { expect, it } from "vitest"
import * as DynamoSchema from "../src/DynamoSchema.js"

it("`test:escape-on` turns escapeKeys on for a schema that doesn't set it", () => {
  expect(DynamoSchema.make({ name: "x", version: 1 }).escapeKeys).toBe(true)
  expect(DynamoSchema.make({ name: "x", version: 1, escapeKeys: false }).escapeKeys).toBeUndefined()
})
