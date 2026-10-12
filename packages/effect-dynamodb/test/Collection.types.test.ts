/**
 * Type tests for a collection query: what each terminal returns (#133).
 */
import type { ValidationError } from "@effect-dynamodb/schema/Errors.js"
import type { Effect, Stream } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import type {
  CollectionQuery,
  CollectionSelected,
  CollectionStreamItem,
  DynamoClientError,
} from "../src/index.js"

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

  it("every terminal's error channel is unchanged by packed storage (#147)", () => {
    if (query === null) return
    // A member's packed field compressed with a codec this process has not
    // registered fails with a ValidationError (cause: CompressorNotRegistered).
    type Errors = DynamoClientError | ValidationError
    expectTypeOf<Effect.Error<ReturnType<typeof query.collect>>>().toEqualTypeOf<Errors>()
    expectTypeOf<Effect.Error<ReturnType<typeof query.fetch>>>().toEqualTypeOf<Errors>()
    expectTypeOf<Stream.Error<ReturnType<typeof query.paginate>>>().toEqualTypeOf<Errors>()
    expectTypeOf<Effect.Error<ReturnType<typeof query.count>>>().toEqualTypeOf<Errors>()
    const selected = query.select(["name"])
    expectTypeOf<Effect.Error<ReturnType<typeof selected.collect>>>().toEqualTypeOf<Errors>()
  })
})
