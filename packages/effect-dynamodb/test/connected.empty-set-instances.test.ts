/**
 * An empty set inside what the marshaller stores as a class instance, against DynamoDB Local: an
 * `Option`, a `Result`, an `Exit`, a `Cause`, a `Schema.Class`, a `Schema.TaggedClass`, and lists and
 * records of them. DynamoDB has no empty set, so it's an absent attribute, and everything else about
 * the value is stored as it always is and reads back as it was written.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import { type AttributeValue, DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Config, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

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

const credentials = { accessKeyId: "local", secretAccessKey: "local" }
const raw = new DynamoDBClient({ region: "us-east-1", endpoint: ENDPOINT, credentials })
const ClientLayer = DynamoClient.layer({ region: "us-east-1", endpoint: ENDPOINT, credentials })

const Keys = {
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" as const },
    { AttributeName: "sk", KeyType: "RANGE" as const },
  ],
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" as const },
    { AttributeName: "sk", AttributeType: "S" as const },
  ],
}

type Row = Record<string, AttributeValue>

let tables = 0
const onTable = <A, E>(Base: any, body: (tableName: string) => Effect.Effect<A, E, any>) => {
  const tableName = `empty-sets-${Date.now()}-${tables++}`
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({ TableName: tableName, BillingMode: "PAY_PER_REQUEST", ...Keys })
    }),
    () => body(tableName),
    () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        yield* client.deleteTable({ TableName: tableName })
      }).pipe(Effect.ignore),
  ).pipe(
    Effect.provide(Layer.merge(ClientLayer, Base.layer({ name: tableName }) as Layer.Layer<never>)),
  ) as Effect.Effect<A, unknown>
}

const rowsOf = (tableName: string) =>
  Effect.promise(async () => {
    const { Items = [] } = await raw.send(
      new ScanCommand({ TableName: tableName, ConsistentRead: true }),
    )
    return Items as ReadonlyArray<Row>
  })

const Tags = Schema.ReadonlySet(Schema.String)
const Inner = Schema.Struct({ s: Tags, n: Schema.optional(Schema.String) })
class Cls extends Schema.Class<Cls>("Cls")({ s: Tags, n: Schema.String }) {}
class Tagged extends Schema.TaggedClass<Tagged>("Tagged")("Tagged", {
  s: Tags,
  n: Schema.String,
}) {}
const u = Schema.Unknown

const Fields = {
  cls: Cls,
  tagged: Tagged,
  option: Schema.Option(Inner),
  optionOfOption: Schema.Option(Schema.Option(Inner)),
  optionOfClass: Schema.Option(Cls),
  optionOfTagged: Schema.Option(Tagged),
  optionOfSet: Schema.Option(Tags),
  success: Schema.Result(Inner, Schema.String),
  failure: Schema.Result(Schema.String, Inner),
  successOfSet: Schema.Result(Tags, Schema.String),
  exit: Schema.Exit(Inner, Schema.String, u),
  exitFailure: Schema.Exit(Schema.String, Inner, u),
  exitOfSet: Schema.Exit(Tags, Schema.String, u),
  exitOfClass: Schema.Exit(Cls, Schema.String, u),
  cause: Schema.Cause(Inner, u),
  causeOfSet: Schema.Cause(Tags, u),
  causeOfClass: Schema.Cause(Cls, u),
  listOfStruct: Schema.Array(Inner),
  listOfClass: Schema.Array(Cls),
  listOfOption: Schema.Array(Schema.Option(Inner)),
  listOfExit: Schema.Array(Schema.Exit(Inner, Schema.String, u)),
  listOfCause: Schema.Array(Schema.Cause(Inner, u)),
  recordOfClass: Schema.Record(Schema.String, Cls),
  recordOfOption: Schema.Record(Schema.String, Schema.Option(Inner)),
  recordOfExit: Schema.Record(Schema.String, Schema.Exit(Inner, Schema.String, u)),
  recordOfCause: Schema.Record(Schema.String, Schema.Cause(Inner, u)),
  tuple: Schema.Tuple([Schema.Option(Inner), Schema.String]),
  nullable: Schema.NullOr(Schema.Option(Inner)),
  suspended: Schema.suspend(() => Inner),
  optionOfSuspended: Schema.Option(Schema.suspend(() => Inner)),
}

const valuesOf = (tags: () => ReadonlySet<string>) => {
  const inner = () => ({ s: tags(), n: "x" })
  return {
    cls: new Cls(inner()),
    tagged: new Tagged(inner()),
    option: Option.some(inner()),
    optionOfOption: Option.some(Option.some(inner())),
    optionOfClass: Option.some(new Cls(inner())),
    optionOfTagged: Option.some(new Tagged(inner())),
    optionOfSet: Option.some(tags()),
    success: Result.succeed(inner()),
    failure: Result.fail(inner()),
    successOfSet: Result.succeed(tags()),
    exit: Exit.succeed(inner()),
    exitFailure: Exit.fail(inner()),
    exitOfSet: Exit.succeed(tags()),
    exitOfClass: Exit.succeed(new Cls(inner())),
    cause: Cause.fail(inner()),
    causeOfSet: Cause.fail(tags()),
    causeOfClass: Cause.fail(new Cls(inner())),
    listOfStruct: [inner(), inner()],
    listOfClass: [new Cls(inner())],
    listOfOption: [Option.some(inner()), Option.none()],
    listOfExit: [Exit.succeed(inner())],
    listOfCause: [Cause.fail(inner())],
    recordOfClass: { k: new Cls(inner()) },
    recordOfOption: { k: Option.some(inner()) },
    recordOfExit: { k: Exit.succeed(inner()) },
    recordOfCause: { k: Cause.fail(inner()) },
    tuple: [Option.some(inner()), "a"],
    nullable: Option.some(inner()),
    suspended: inner(),
    optionOfSuspended: Option.some(inner()),
  }
}
const empty = () => valuesOf(() => new Set())
const full = () => valuesOf(() => new Set(["a"]))

type FieldName = keyof typeof Fields
const FIELD_NAMES = Object.keys(Fields) as ReadonlyArray<FieldName>

const expectAsWritten = (
  read: any,
  written: Record<string, unknown>,
  names: ReadonlyArray<FieldName> = FIELD_NAMES,
) => {
  for (const name of names) {
    const same = Schema.toEquivalence(Fields[name] as never) as (a: unknown, b: unknown) => boolean
    expect([name, same(read[name], written[name])]).toEqual([name, true])
  }
}

/** The attribute without the sets in it, which is what an empty set leaves behind. */
const withoutSets = (attribute: AttributeValue): AttributeValue => {
  if (attribute.L !== undefined) return { L: attribute.L.map(withoutSets) }
  if (attribute.M === undefined) return attribute
  return {
    M: Object.fromEntries(
      Object.entries(attribute.M)
        .filter(([, part]) => part.SS === undefined)
        .map(([key, part]) => [key, withoutSets(part)]),
    ),
  }
}

/** Each field of a row holding empty sets is what the row holding full ones stores, without them. */
const expectStoredWithoutSets = (
  emptyRow: Row,
  fullRow: Row,
  names: ReadonlyArray<FieldName> = FIELD_NAMES,
) => {
  for (const name of names) {
    expect([name, emptyRow[name]]).toEqual([name, withoutSets(fullRow[name] as AttributeValue)])
  }
}

const Rows = Entity.make({
  model: Schema.Struct({ id: Schema.String, note: Schema.optional(Schema.String), ...Fields }),
  entityType: "Row",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
} as never) as any
const OptionalRows = Entity.make({
  model: Schema.Struct({
    id: Schema.String,
    ...Object.fromEntries(FIELD_NAMES.map((name) => [name, Schema.optional(Fields[name])])),
  }),
  entityType: "OptionalRow",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
} as never) as any
const Lists = Entity.make({
  model: Schema.Struct({ id: Schema.String, sets: Schema.Array(Tags) }),
  entityType: "List",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
} as never) as any
const AppSchema = DynamoSchema.make({ name: "sets", version: 1 })
const Base = Table.make({ schema: AppSchema, entities: { Rows, OptionalRows, Lists } })

// A mutation holds a set as a list, and a read back of that under a `Schema.suspend` is refused, with
// or without anything in the set, so an aggregate's update can't be measured on `suspended` here.
const { suspended: _suspended, ...AggregateFields } = Fields
const AGGREGATE_NAMES = Object.keys(AggregateFields) as ReadonlyArray<FieldName>

const Holders = (Aggregate.make as any)(
  Schema.Struct({
    id: Schema.String,
    note: Schema.optional(Schema.String),
    ...AggregateFields,
    only: Schema.Struct(AggregateFields),
    lines: Schema.Array(Schema.Struct({ sku: Schema.String, ...AggregateFields })),
  }),
  {
    table: Base,
    schema: Base.schema,
    pk: { field: "pk", composite: ["id"] },
    collection: { name: "holders" },
    root: { entityType: "Holder" },
    edges: {
      only: Aggregate.one("only", { entityType: "Only" } as never),
      lines: Aggregate.many({ entityType: "Line", sk: { composite: ["sku"] } } as never),
    },
  },
)
const MainTable = { ...Base, aggregates: { Holders } }
const client = DynamoClient.make({
  entities: { Rows, OptionalRows, Lists },
  aggregates: { Holders },
  tables: { MainTable },
} as never) as Effect.Effect<any, never, any>

const Noted = Schema.Struct({ _tag: Schema.tag("Noted"), ...Fields })
const Notes = EventStore.makeStream({
  table: Base,
  streamName: "Notes",
  events: [Noted],
  streamId: { composite: ["id"] },
  metadata: Schema.Struct({ m: Schema.Option(Inner) }),
  snapshot: { schema: Schema.Struct(Fields) },
} as never) as any

describeConnected("an empty set in a class instance", () => {
  it.effect("put stores everything else, and get reads it back as it was written", () =>
    onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Rows.put({ id: "empty", ...empty() })
        yield* db.entities.Rows.put({ id: "full", ...full() })

        expectAsWritten(yield* db.entities.Rows.get({ id: "empty" }), empty())
        expectAsWritten(yield* db.entities.Rows.get({ id: "full" }), full())
        const rows = yield* rowsOf(tableName)
        expectStoredWithoutSets(
          rows.find((row) => row.id?.S === "empty") as Row,
          rows.find((row) => row.id?.S === "full") as Row,
        )
        const scanned: ReadonlyArray<any> = yield* db.entities.Rows.scan().collect()
        for (const read of scanned) expectAsWritten(read, read.id === "full" ? full() : empty())
      }),
    ),
  )

  it.effect("create, upsert, a batch and a transaction store the same", () =>
    onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* client
        yield* db.entities.Rows.put({ id: "put", ...empty() })
        yield* db.entities.Rows.create({ id: "create", ...empty() })
        yield* db.entities.Rows.upsert({ id: "upsert", ...empty() })
        yield* Batch.write([db.entities.Rows.put({ id: "batch", ...empty() })] as never)
        yield* Transaction.transactWrite([
          db.entities.Rows.put({ id: "transaction", ...empty() }),
        ] as never)

        const rows = yield* rowsOf(tableName)
        const putRow = rows.find((row) => row.id?.S === "put") as Row
        for (const id of ["create", "upsert", "batch", "transaction"]) {
          expectAsWritten(yield* db.entities.Rows.get({ id }), empty())
          const row = rows.find((candidate) => candidate.id?.S === id) as Row
          for (const name of FIELD_NAMES) expect(row[name]).toEqual(putRow[name])
        }
      }),
    ),
  )

  it.effect(
    "an update setting one stores what a put stores, and an update elsewhere keeps it",
    () =>
      onTable(Base, (tableName) =>
        Effect.gen(function* () {
          const db = yield* client
          yield* db.entities.Rows.put({ id: "put", ...empty() })
          yield* db.entities.OptionalRows.put({ id: "updated" })
          const updated = yield* db.entities.OptionalRows.update({ id: "updated" }).set(empty())
          expectAsWritten(updated, empty())
          expectAsWritten(yield* db.entities.OptionalRows.get({ id: "updated" }), empty())

          const before = yield* rowsOf(tableName)
          const noted = yield* db.entities.Rows.update({ id: "put" }).set({ note: "n" })
          expectAsWritten(noted, empty())
          const after = yield* rowsOf(tableName)
          for (const name of FIELD_NAMES) {
            expect(after.find((row) => row.id?.S === "put")?.[name]).toEqual(
              before.find((row) => row.id?.S === "put")?.[name],
            )
            expect(before.find((row) => row.id?.S === "updated")?.[name]).toEqual(
              before.find((row) => row.id?.S === "put")?.[name],
            )
          }
        }),
      ),
  )

  it.effect("an aggregate stores and reads one on its root and on its edges", () =>
    onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* client
        const ofAggregate = (values: Record<string, unknown>) =>
          Object.fromEntries(AGGREGATE_NAMES.map((name) => [name, values[name]]))
        const holder = (id: string, values: () => Record<string, unknown>) => ({
          id,
          ...ofAggregate(values()),
          only: ofAggregate(values()),
          lines: [{ sku: "a", ...ofAggregate(values()) }],
        })
        const expectHolder = (read: any, values: () => Record<string, unknown>) => {
          expectAsWritten(read, values(), AGGREGATE_NAMES)
          expectAsWritten(read.only, values(), AGGREGATE_NAMES)
          expectAsWritten(read.lines[0], values(), AGGREGATE_NAMES)
        }

        expectHolder(yield* db.aggregates.Holders.create(holder("empty", empty)), empty)
        yield* db.aggregates.Holders.create(holder("full", full))
        expectHolder(yield* db.aggregates.Holders.get({ id: "empty" }), empty)
        expectHolder(yield* db.aggregates.Holders.get({ id: "full" }), full)

        const rows = yield* rowsOf(tableName)
        const of = (id: string) => rows.filter((row) => row.pk?.S?.includes(`#${id}`))
        expect(of("empty").length).toBe(3)
        for (const row of of("empty")) {
          const sk = row.sk?.S
          expectStoredWithoutSets(
            row,
            of("full").find((candidate) => candidate.sk?.S === sk) as Row,
            AGGREGATE_NAMES,
          )
        }

        const updated = yield* db.aggregates.Holders.update({ id: "empty" }, ({ state }: any) => ({
          ...state,
          note: "n",
        }))
        expect(updated.note).toBe("n")
        expectHolder(updated, empty)
        expectHolder(yield* db.aggregates.Holders.get({ id: "empty" }), empty)
        const after = yield* rowsOf(tableName)
        for (const row of after) {
          const old = rows.find(
            (candidate) => candidate.pk?.S === row.pk?.S && candidate.sk?.S === row.sk?.S,
          ) as Row
          for (const name of AGGREGATE_NAMES) expect(row[name]).toEqual(old[name])
        }

        yield* db.aggregates.Holders.update({ id: "empty" }, ({ state }: any) => state)
        expect(yield* rowsOf(tableName)).toEqual(after)
      }),
    ),
  )

  it.effect("a stream appends one, in an event, its metadata and a snapshot", () =>
    onTable(Base, () =>
      Effect.gen(function* () {
        const id = { id: "a" }
        const metadata = { m: Option.some({ s: new Set<string>(), n: "x" }) }
        yield* Notes.append(id, [{ _tag: "Noted", ...empty() }], 0, { metadata })
        const events: ReadonlyArray<any> = yield* Notes.read(id)
        expect(events.length).toBe(1)
        expectAsWritten(events[0].data, empty())
        expect(events[0].metadata.m).toEqual(metadata.m)

        yield* Notes.writeSnapshot(id, empty(), 1)
        const snapshot = Option.getOrThrow<any>(yield* Notes.readSnapshot(id))
        expectAsWritten(snapshot.state, empty())
      }),
    ),
  )

  it.effect("an empty set directly in a list is still refused, with nothing stored", () =>
    onTable(Base, (tableName) =>
      Effect.gen(function* () {
        const db = yield* client
        const failed = yield* db.entities.Lists.put({ id: "a", sets: [new Set()] })
          .asEffect()
          .pipe(Effect.flip)
        expect(failed._tag).toBe("ValidationError")
        expect(String(failed.cause)).toContain('"sets[0]"')
        expect(yield* rowsOf(tableName)).toEqual([])
      }),
    ),
  )
})
