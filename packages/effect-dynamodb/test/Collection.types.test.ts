/**
 * Type tests for a collection query: what each terminal returns (#133).
 */
import type { Effect, Stream } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import type { CollectionQuery, CollectionSelected, CollectionStreamItem } from "../src/index.js"

interface Employee {
  readonly employee: string
  readonly name: string
}
interface Task {
  readonly employee: string
  readonly taskId: string
}
type Grouped = { Employees: Array<Employee>; Tasks: Array<Task> }
// Never executed — the query only feeds `typeof`.
const query = null as unknown as CollectionQuery<Grouped>

describe("CollectionQuery types", () => {
  it("collect and fetch return the grouped result", () => {
    if (query === null) return
    expectTypeOf<Effect.Success<ReturnType<typeof query.collect>>>().toEqualTypeOf<Grouped>()
    expectTypeOf<Effect.Success<ReturnType<typeof query.fetch>>["items"]>().toEqualTypeOf<Grouped>()
  })

  it("paginate streams each item tagged with its member", () => {
    if (query === null) return
    type Streamed = Stream.Success<ReturnType<typeof query.paginate>>
    expectTypeOf<Streamed>().toEqualTypeOf<CollectionStreamItem<Grouped>>()
    expectTypeOf<Streamed>().toEqualTypeOf<
      | { readonly member: "Employees"; readonly item: Employee }
      | { readonly member: "Tasks"; readonly item: Task }
    >()
  })

  it("count returns a number; select groups partial records", () => {
    if (query === null) return
    expectTypeOf<Effect.Success<ReturnType<typeof query.count>>>().toEqualTypeOf<number>()
    const selected = query.select(["name"])
    expectTypeOf<Effect.Success<ReturnType<typeof selected.collect>>>().toEqualTypeOf<{
      readonly Employees: Array<Record<string, unknown>>
      readonly Tasks: Array<Record<string, unknown>>
    }>()
  })

  it("maxPages and consistentRead keep the query's grouping", () => {
    if (query === null) return
    expectTypeOf(query.maxPages(1)).toEqualTypeOf<CollectionQuery<Grouped>>()
    expectTypeOf(query.consistentRead()).toEqualTypeOf<CollectionQuery<Grouped>>()
    expectTypeOf<CollectionSelected<Grouped>>().toEqualTypeOf<{
      readonly Employees: Array<Record<string, unknown>>
      readonly Tasks: Array<Record<string, unknown>>
    }>()
  })
})
