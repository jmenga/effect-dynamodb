/**
 * Type tests for the resume cursors handed to callers (#171): an
 * `Option<string>` on every page and report; a plain string going back in.
 */
import type { Effect, Option } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import type * as Aggregate from "../src/Aggregate.js"
import type { CollectionQuery } from "../src/index.js"
import type * as BoundQuery from "../src/internal/BoundQuery.js"
import type * as Query from "../src/Query.js"
import type * as Table from "../src/Table.js"

interface Task {
  readonly taskId: string
}
type Grouped = { Tasks: Array<Task> }
// Never executed — the queries only feed `typeof`.
const collection = null as unknown as CollectionQuery<Grouped>
const bound = null as unknown as BoundQuery.BoundQuery<Task, never, Task>

describe("page cursors are Option<string>", () => {
  it("Query.Page, a bound query's fetch and a collection's fetch", () => {
    if (collection === null || bound === null) return
    expectTypeOf<Query.Page<Task>["cursor"]>().toEqualTypeOf<Option.Option<string>>()
    expectTypeOf<Effect.Success<ReturnType<typeof bound.fetch>>["cursor"]>().toEqualTypeOf<
      Option.Option<string>
    >()
    expectTypeOf<Effect.Success<ReturnType<typeof collection.fetch>>["cursor"]>().toEqualTypeOf<
      Option.Option<string>
    >()
  })

  it("an aggregate list result and a rekey report", () => {
    expectTypeOf<Aggregate.ListResult<Task>["cursor"]>().toEqualTypeOf<Option.Option<string>>()
    expectTypeOf<Table.RekeyReport["resume"]>().toEqualTypeOf<Option.Option<string>>()
  })

  it("the inputs still take the string", () => {
    if (collection === null || bound === null) return
    const cursor = null as unknown as Option.Option<string>
    bound.startFrom("text")
    collection.startFrom("text")
    // @ts-expect-error — `.startFrom()` takes the string inside the Option.
    bound.startFrom(cursor)
    // @ts-expect-error — so does a collection's.
    collection.startFrom(cursor)
    expectTypeOf<NonNullable<Aggregate.ListOptions<Task>["cursor"]>>().toEqualTypeOf<string>()
    expectTypeOf<NonNullable<Table.RekeyOptions["resume"]>>().toEqualTypeOf<string>()
  })
})
