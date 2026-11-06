/** Only the `test:escape-on` runs include this: it fails if their plugin didn't reach the composer. */
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { expect, it } from "vitest"

it("`test:escape-on` turns escapeKeys on for a schema that doesn't set it", () => {
  expect(DynamoSchema.make({ name: "x", version: 1 }).escapeKeys).toBe(true)
  expect(DynamoSchema.make({ name: "x", version: 1, escapeKeys: false }).escapeKeys).toBeUndefined()
})
