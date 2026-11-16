/**
 * Ops that read a row and then write, with a concurrent write landing between the read and the
 * write, against DynamoDB Local (#132). The concurrent write is injected through a decorated
 * `DynamoClient` (`helpers/RaceAfterRead.ts`): straight after the op's read returns, another
 * client writes, so the op's read is the stale one. DynamoDB itself evaluates every condition the
 * op sends. Covers the updates that set nothing (their read held to the commit, their condition
 * sent with no `UpdateExpression`, the check-only transaction), `purge` of a unique entity,
 * cascade updates, and the paths whose existing guard already closes the race. Unit twin:
 * `ReadWriteRaces.test.ts`.
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *   (or set DYNAMODB_ENDPOINT to another port)
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Config, Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect } from "vitest"
import { BlobStore } from "../src/BlobStore.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { MemoryBlobStore } from "../src/internal/MemoryBlobStore.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { raceAfterRead } from "./helpers/RaceAfterRead.js"

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

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The pass's own key setting: `escapeKeys` on in the escape-on pass, off otherwise. */
const AppSchema = DynamoSchema.make({ name: "races", version: 1 })
/** Offloading requires escaped keys, in both passes. */
const OffloadSchema = DynamoSchema.make({ name: "races-offload", version: 1, escapeKeys: true })
const tableName = `read-write-races-${Date.now()}`

class Account extends Schema.Class<Account>("Account")({
  accountId: Schema.String,
  email: Schema.String,
  name: Schema.String,
}) {}

const key = {
  pk: { field: "pk", composite: ["accountId"] },
  sk: { field: "sk", composite: [] },
} as const

const Accounts = Entity.make({
  model: Account,
  entityType: "Account",
  primaryKey: key,
  unique: { email: ["email"] },
})
const VersionedAccounts = Entity.make({
  model: Account,
  entityType: "VersionedAccount",
  primaryKey: key,
  unique: { email: ["email"] },
  versioned: true,
})
const RetainedNotes = Entity.make({
  model: Account,
  entityType: "RetainedNote",
  primaryKey: key,
  versioned: { retain: true },
})
const SoftAccounts = Entity.make({
  model: Account,
  entityType: "SoftAccount",
  primaryKey: key,
  softDelete: true,
})
const Plain = Entity.make({ model: Account, entityType: "Plain", primaryKey: key })
/** Versioned with retained history, unique email. */
const RetainedAccounts = Entity.make({
  model: Account,
  entityType: "RetainedAccount",
  primaryKey: key,
  unique: { email: ["email"] },
  versioned: { retain: true },
})

class Team extends Schema.Class<Team>("Team")({
  teamId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
}) {}
class Player extends Schema.Class<Player>("Player")({
  playerId: Schema.String,
  team: Team.pipe(DynamoModel.ref),
}) {}
const Teams = Entity.make({
  model: Team,
  entityType: "Team",
  primaryKey: { pk: { field: "pk", composite: ["teamId"] }, sk: { field: "sk", composite: [] } },
})
const Players = Entity.make({
  model: Player,
  entityType: "Player",
  primaryKey: { pk: { field: "pk", composite: ["playerId"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byTeam: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["teamId"] },
      sk: { field: "gsi1sk", composite: ["playerId"] },
    },
  },
  refs: { team: { entity: Teams } },
})
const Members = Entity.make({
  model: Player,
  entityType: "Member",
  primaryKey: { pk: { field: "pk", composite: ["playerId"] }, sk: { field: "sk", composite: [] } },
  refs: { team: { entity: Teams } },
})

class Profile extends Schema.Class<Profile>("Profile")({
  accountId: Schema.String,
  email: Schema.String,
  bio: Schema.Struct({ text: Schema.String }),
}) {}
/** A unique entity whose `bio` is offloaded: purge deletes its objects after its rows. */
const Profiles = Entity.make({
  model: DynamoModel.configure(Profile, {
    bio: { storedAs: DynamoModel.Packed({ format: "json", external: { threshold: 64 } }) },
  }),
  entityType: "Profile",
  primaryKey: key,
  unique: { email: ["email"] },
})

const entities = {
  Accounts,
  VersionedAccounts,
  RetainedNotes,
  SoftAccounts,
  Plain,
  RetainedAccounts,
  Teams,
  Players,
  Members,
}
const MainTable = Table.make({ schema: AppSchema, entities })
const OffloadTable = Table.make({ schema: OffloadSchema, entities: { Profiles } })
const database = DynamoClient.make({ entities, tables: { MainTable } })
const offloadDatabase = DynamoClient.make({
  entities: { Profiles },
  tables: { OffloadTable },
})

const ClientLayer = DynamoClient.layer({
  region: "us-east-1",
  endpoint: ENDPOINT,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
})
let blobs: MemoryBlobStore = BlobStore.memory()
const provide = <A, E>(effect: Effect.Effect<A, E, any>) =>
  Effect.suspend(() =>
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          ClientLayer,
          MainTable.layer({ name: tableName }),
          OffloadTable.layer({ name: tableName }),
          BlobStore.layer(blobs),
        ),
      ),
    ),
  ) as Effect.Effect<A, E>

beforeAll(async () => {
  if (!dynamoAvailable) return
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.createTable({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
          { AttributeName: "gsi1pk", AttributeType: "S" },
          { AttributeName: "gsi1sk", AttributeType: "S" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "gsi1",
            KeySchema: [
              { AttributeName: "gsi1pk", KeyType: "HASH" },
              { AttributeName: "gsi1sk", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      })
    }).pipe(Effect.provide(ClientLayer)),
  )
}, 60_000)

afterAll(async () => {
  if (!dynamoAvailable) return
  await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.deleteTable({ TableName: tableName }).pipe(Effect.ignore)
    }).pipe(Effect.provide(ClientLayer)),
  )
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Row = Record<string, AttributeValue>

/** Every row of the table, read consistently. */
const allRows = Effect.gen(function* () {
  const client = yield* DynamoClient
  const found: Array<Row> = []
  let start: Row | undefined
  do {
    const page = yield* client.scan({
      TableName: tableName,
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })
    found.push(...((page.Items ?? []) as Array<Row>))
    start = page.LastEvaluatedKey as Row | undefined
  } while (start !== undefined)
  return found
}).pipe(Effect.orDie)

/** Whether a key text ends with `value` as its last composite (`#value`, or `#attr_value`). */
const endsWithValue = (text: string | undefined, value: string) =>
  text !== undefined && (text.endsWith(`#${value}`) || text.endsWith(`_${value}`))
/** Every row whose partition key's last composite is `id`. */
const rowsAt = (id: string) =>
  allRows.pipe(Effect.map((rows) => rows.filter((row) => endsWithValue(row.pk?.S, id))))
/** The rows of `entityType` under `id`'s partition. */
const rowsOf = (entityType: string, id: string) =>
  rowsAt(id).pipe(Effect.map((rows) => rows.filter((row) => row.__edd_e__?.S === entityType)))
/** The unique sentinels of `entityType` reserving one of `emails`, as the emails they reserve. */
const sentinels = (entityType: string, emails: ReadonlyArray<string>) =>
  allRows.pipe(
    Effect.map((rows) =>
      rows
        .filter((row) => row.__edd_e__?.S === `${entityType}._unique.email`)
        .map((row) => emails.find((email) => endsWithValue(row.pk?.S, email)))
        .filter((email) => email !== undefined)
        .sort(),
    ),
  )
/** Rows of no entity under `id`'s partition: what an unconditioned update of a missing key made. */
const strays = (id: string) =>
  rowsAt(id).pipe(Effect.map((rows) => rows.filter((row) => row.__edd_e__ === undefined)))

const s = (value: AttributeValue | undefined) => value?.S

type Runnable =
  | Effect.Effect<any, any, any>
  | { readonly asEffect: () => Effect.Effect<any, any, any> }
const asEffect = (op: Runnable): Effect.Effect<any, any, any> =>
  "asEffect" in op ? Effect.suspend(() => op.asEffect()) : op
/** The tag of `op`'s failure, or "ok". */
const outcome = (op: Runnable) =>
  asEffect(op).pipe(
    Effect.map(() => "ok"),
    Effect.catch((error: { readonly _tag: string }) => Effect.succeed(error._tag)),
  )

let unique = 0
/** A fresh id: every test writes its own items in the one table. */
const fresh = (label: string) => `${label}-${Date.now()}-${unique++}`

/**
 * `op` (built on a client bound inside the race) with `concurrent` (built on the undecorated
 * client) landing straight after `op`'s first read of kind `on`; the tag of `op`'s failure, or
 * "ok".
 */
const race = (
  concurrent: (db: Effect.Success<typeof database>) => Runnable,
  op: (db: Effect.Success<typeof database>) => Runnable,
  options: { readonly on?: "getItem" | "query"; readonly every?: boolean } = {},
) =>
  raceAfterRead(
    Effect.flatMap(database, (db) => asEffect(concurrent(db))),
    Effect.flatMap(database, (db) => outcome(op(db))),
    options,
  )

const account = (accountId: string, email: string) => ({ accountId, email, name: "n" })

// ---------------------------------------------------------------------------
// An update that sets nothing
// ---------------------------------------------------------------------------

describeConnected("an update that sets nothing", () => {
  it.effect("straight after the put that created its row, finds it in every return mode", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* database
        for (const mode of ["allNew", "allOld", "none", "updatedNew", "updatedOld"] as const) {
          const id = fresh("noop-found")
          yield* db.entities.Plain.put(account(id, "a@x.io"))
          expect(
            yield* outcome(db.entities.Plain.update({ accountId: id }).set({}).returnValues(mode)),
          ).toBe("ok")
        }
      }),
    ),
  )

  it.effect(
    "on a missing row is ItemNotFound in every return mode, and patch's is ConditionalCheckFailed",
    () =>
      provide(
        Effect.gen(function* () {
          const db = yield* database
          const id = fresh("noop-missing")
          for (const mode of ["allNew", "allOld", "none", "updatedNew", "updatedOld"] as const) {
            expect(
              yield* outcome(
                db.entities.Plain.update({ accountId: id }).set({}).returnValues(mode),
              ),
            ).toBe("ItemNotFound")
          }
          expect(yield* outcome(db.entities.Plain.patch({ accountId: id }).set({}))).toBe(
            "ConditionalCheckFailed",
          )
          expect(yield* rowsAt(id)).toEqual([])
        }),
      ),
  )

  it.effect("with a condition, DynamoDB evaluates it on an UpdateItem that changes nothing", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* database
        const id = fresh("noop-condition")
        yield* db.entities.Plain.put(account(id, "a@x.io"))
        const before = yield* rowsOf("Plain", id)
        // Held: the item comes back from the request itself.
        const found = yield* db.entities.Plain.update({ accountId: id })
          .set({})
          .condition({ name: "n" })
        expect(found).toEqual(account(id, "a@x.io"))
        // Refused on the row as it is.
        expect(
          yield* outcome(
            db.entities.Plain.update({ accountId: id }).set({}).condition({ name: "zzz" }),
          ),
        ).toBe("ConditionalCheckFailed")
        // Nothing changed either way.
        expect(yield* rowsOf("Plain", id)).toEqual(before)
      }),
    ),
  )

  it.effect("with a condition, on a missing row, creates nothing", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* database
        const id = fresh("noop-condition-missing")
        // A condition a missing row meets: without its existence test, DynamoDB would create a
        // key-only item.
        expect(
          yield* outcome(
            db.entities.Plain.update({ accountId: id })
              .set({})
              .condition((t, { notExists }) => notExists(t.email)),
          ),
        ).toBe("ItemNotFound")
        expect(
          yield* outcome(
            db.entities.Plain.patch({ accountId: id })
              .set({})
              .condition((t, { notExists }) => notExists(t.email)),
          ),
        ).toBe("ConditionalCheckFailed")
        expect(yield* rowsAt(id)).toEqual([])
      }),
    ),
  )

  it.effect("with .keepRefs() naming a ref the row no longer holds, is refused", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* database
        const [one, two, member] = [fresh("team"), fresh("team"), fresh("member")]
        yield* db.entities.Teams.put({ teamId: one, name: "One" })
        yield* db.entities.Teams.put({ teamId: two, name: "Two" })
        yield* db.entities.Members.put({ playerId: member, teamId: two })
        expect(
          yield* outcome(
            db.entities.Members.update({ playerId: member }).set({}).keepRefs({ teamId: one }),
          ),
        ).toBe("ConditionalCheckFailed")
        const held = yield* db.entities.Members.update({ playerId: member })
          .set({})
          .keepRefs({ teamId: two })
        expect(held.team.name).toBe("Two")
      }),
    ),
  )

  it.effect("standalone, racing a delete after its read, answers from the read", () =>
    provide(
      Effect.gen(function* () {
        const id = fresh("noop-race")
        yield* (yield* database).entities.Plain.put(account(id, "a@x.io"))
        // Standalone, the consistent read IS the answer: the row was there.
        const result = yield* race(
          (db) => db.entities.Plain.delete({ accountId: id }),
          (db) => db.entities.Plain.update({ accountId: id }).set({}).returnValues("none"),
        )
        expect(result).toBe("ok")
        expect(yield* strays(id)).toEqual([])
      }),
    ),
  )
})

describeConnected("an update that sets nothing, in transactWrite", () => {
  it.effect(
    "a transaction of only no-op updates is a check-only transaction DynamoDB accepts",
    () =>
      provide(
        Effect.gen(function* () {
          const db = yield* database
          const [a, b] = [fresh("check-only"), fresh("check-only")]
          yield* db.entities.Plain.put(account(a, "a@x.io"))
          yield* db.entities.Plain.put(account(b, "b@x.io"))
          const before = [...(yield* rowsOf("Plain", a)), ...(yield* rowsOf("Plain", b))]
          yield* Transaction.transactWrite([
            Plain.update({ accountId: a }).pipe(Entity.set({})),
            Plain.update({ accountId: b }).pipe(Entity.set({}), Plain.condition({ name: "n" })),
          ])
          expect([...(yield* rowsOf("Plain", a)), ...(yield* rowsOf("Plain", b))]).toEqual(before)
        }),
      ),
  )

  it.effect("beside a put, on a row deleted after the plan read it, commits nothing", () =>
    provide(
      Effect.gen(function* () {
        const [id, other] = [fresh("tx-noop"), fresh("tx-other")]
        yield* (yield* database).entities.Plain.put(account(id, "a@x.io"))
        const result = yield* race(
          (db) => db.entities.Plain.delete({ accountId: id }),
          () =>
            Transaction.transactWrite([
              Plain.update({ accountId: id }).pipe(Entity.set({})),
              Plain.put(account(other, "o@x.io")),
            ]),
        )
        expect(result).toBe("ItemNotFound")
        expect(yield* rowsAt(other)).toEqual([])
        expect(yield* rowsAt(id)).toEqual([])
      }),
    ),
  )

  it.effect("with a condition, on a row deleted after the plan read it, commits nothing", () =>
    provide(
      Effect.gen(function* () {
        const [id, other] = [fresh("tx-cond"), fresh("tx-other")]
        yield* (yield* database).entities.Plain.put(account(id, "a@x.io"))
        const result = yield* race(
          (db) => db.entities.Plain.delete({ accountId: id }),
          () =>
            Transaction.transactWrite([
              Plain.update({ accountId: id }).pipe(Entity.set({}), Plain.condition({ name: "n" })),
              Plain.put(account(other, "o@x.io")),
            ]),
        )
        expect(result).toBe("ItemNotFound")
        expect(yield* rowsAt(other)).toEqual([])
        expect(yield* rowsAt(id)).toEqual([])
      }),
    ),
  )

  it.effect("with a condition the unchanged row fails, is TransactionCancelled", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* database
        const [id, other] = [fresh("tx-refused"), fresh("tx-other")]
        yield* db.entities.Plain.put(account(id, "a@x.io"))
        const result = yield* outcome(
          Transaction.transactWrite([
            Plain.update({ accountId: id }).pipe(Entity.set({}), Plain.condition({ name: "zzz" })),
            Plain.put(account(other, "o@x.io")),
          ]),
        )
        expect(result).toBe("TransactionCancelled")
        expect(yield* rowsAt(other)).toEqual([])
      }),
    ),
  )

  it.effect("a patch on a missing row is ConditionalCheckFailed and commits nothing", () =>
    provide(
      Effect.gen(function* () {
        const [id, other] = [fresh("tx-patch"), fresh("tx-other")]
        const result = yield* outcome(
          Transaction.transactWrite([
            Plain.patch({ accountId: id }).pipe(Entity.set({})),
            Plain.put(account(other, "o@x.io")),
          ]),
        )
        expect(result).toBe("ConditionalCheckFailed")
        expect(yield* rowsAt(other)).toEqual([])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// purge
// ---------------------------------------------------------------------------

describeConnected("purge", () => {
  it.effect("of a unique entity racing an update of the unique field orphans no sentinel", () =>
    provide(
      Effect.gen(function* () {
        const id = fresh("purge")
        const [a, b] = [`${id}-a@x.io`, `${id}-b@x.io`]
        yield* (yield* database).entities.Accounts.put(account(id, a))
        // The purge reads the live row with email A; the update moves it to B before the purge
        // writes. Its guarded transaction is refused, and the next attempt purges B.
        const result = yield* race(
          (db) => db.entities.Accounts.update({ accountId: id }).set({ email: b }),
          (db) => db.entities.Accounts.purge({ accountId: id }),
        )
        expect(result).toBe("ok")
        expect(yield* rowsAt(id)).toEqual([])
        expect(yield* sentinels("Account", [a, b])).toEqual([])
      }),
    ),
  )

  it.effect(
    "of a unique entity losing every attempt fails ConcurrentModification, deletes nothing",
    () =>
      provide(
        Effect.gen(function* () {
          const id = fresh("purge-lost")
          yield* (yield* database).entities.Accounts.put(account(id, `${id}-0@x.io`))
          // After each attempt's read of the live row, the email moves on: every attempt loses.
          const moved = yield* raceAfterRead(
            (n) =>
              Effect.flatMap(database, (db) =>
                db.entities.Accounts.update({ accountId: id })
                  .set({ email: `${id}-${n + 1}@x.io` })
                  .asEffect(),
              ),
            Effect.flatMap(database, (db) =>
              outcome(db.entities.Accounts.purge({ accountId: id })),
            ),
            { every: true },
          )
          expect(moved).toBe("ConcurrentModification")
          const [live] = yield* rowsOf("Account", id)
          expect(live).toBeDefined()
          // The row and its one sentinel agree: nothing was deleted.
          const all = Array.from({ length: 32 }, (_, n) => `${id}-${n}@x.io`)
          expect(yield* sentinels("Account", all)).toEqual([s(live?.email)])
        }),
      ),
  )

  it.effect("of a versioned unique entity losing every attempt fails OptimisticLockError", () =>
    provide(
      Effect.gen(function* () {
        const id = fresh("purge-versioned")
        yield* (yield* database).entities.VersionedAccounts.put(account(id, `${id}@x.io`))
        const result = yield* raceAfterRead(
          (n) =>
            Effect.flatMap(database, (db) =>
              db.entities.VersionedAccounts.update({ accountId: id })
                .set({ name: `moved ${n}` })
                .asEffect(),
            ),
          Effect.flatMap(database, (db) =>
            outcome(db.entities.VersionedAccounts.purge({ accountId: id })),
          ),
          { every: true },
        )
        expect(result).toBe("OptimisticLockError")
        expect(yield* rowsOf("VersionedAccount", id)).toHaveLength(1)
      }),
    ),
  )

  it.effect(
    "of a retained unique entity, a write after its partition query is purged with its snapshot",
    () =>
      provide(
        Effect.gen(function* () {
          const db = yield* database
          const id = fresh("purge-after-query")
          yield* db.entities.RetainedAccounts.put(account(id, `${id}@x.io`))
          yield* db.entities.RetainedAccounts.update({ accountId: id }).set({ name: "v2" })
          // The live row is read before the query; the update lands after the query, writing a
          // snapshot the query didn't see. The guarded transaction is refused on the version,
          // and the next attempt sees and purges every row.
          const result = yield* race(
            (db) => db.entities.RetainedAccounts.update({ accountId: id }).set({ name: "v3" }),
            (db) => db.entities.RetainedAccounts.purge({ accountId: id }),
            { on: "query" },
          )
          expect(result).toBe("ok")
          expect(yield* rowsAt(id)).toEqual([])
          expect(yield* sentinels("RetainedAccount", [`${id}@x.io`])).toEqual([])
        }),
      ),
  )

  it.effect("straight after a retain update, deletes the snapshot it wrote", () =>
    provide(
      Effect.gen(function* () {
        const db = yield* database
        const id = fresh("purge-retain")
        yield* db.entities.RetainedNotes.put(account(id, "a@x.io"))
        yield* db.entities.RetainedNotes.update({ accountId: id }).set({ name: "later" })
        yield* db.entities.RetainedNotes.purge({ accountId: id })
        expect(yield* rowsAt(id)).toEqual([])
      }),
    ),
  )

  it.effect("of a unique entity with an offloaded field, raced, deletes its rows and objects", () =>
    provide(
      Effect.gen(function* () {
        blobs = BlobStore.memory()
        const id = fresh("purge-offload")
        const [a, b] = [`${id}-a@x.io`, `${id}-b@x.io`]
        const bio = { text: "x".repeat(256) }
        const result = yield* Effect.gen(function* () {
          yield* (yield* offloadDatabase).entities.Profiles.put({ accountId: id, email: a, bio })
          return yield* raceAfterRead(
            Effect.flatMap(offloadDatabase, (db) =>
              db.entities.Profiles.update({ accountId: id }).set({ email: b }).asEffect(),
            ),
            Effect.flatMap(offloadDatabase, (db) =>
              outcome(db.entities.Profiles.purge({ accountId: id })),
            ),
          )
        }).pipe(Effect.provide(BlobStore.layer(blobs)))
        expect(result).toBe("ok")
        expect(yield* rowsAt(id)).toEqual([])
        expect(yield* sentinels("Profile", [a, b])).toEqual([])
        expect(blobs.inspect().versions.filter((version) => version.isLatest)).toEqual([])
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// cascade
// ---------------------------------------------------------------------------

describeConnected("cascade", () => {
  for (const mode of ["eventual", "transactional"] as const) {
    const seed = (team: string, players: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const db = yield* database
        yield* db.entities.Teams.put({ teamId: team, name: "One" })
        for (const playerId of players) yield* db.entities.Players.put({ playerId, teamId: team })
      })
    const rename = (db: Effect.Success<typeof database>, team: string) =>
      db.entities.Teams.update({ teamId: team })
        .set({ name: "Renamed" })
        .cascade({ targets: [Players], mode })
    const teamOf = (playerId: string) =>
      rowsOf("Player", playerId).pipe(Effect.map(([row]) => s(row?.team?.M?.name)))

    it.effect(`${mode}: a target deleted after the cascade's query is not created again`, () =>
      provide(
        Effect.gen(function* () {
          const team = fresh("team")
          const [p1, p2] = [fresh("player"), fresh("player")]
          yield* seed(team, [p1, p2])
          const result = yield* race(
            (db) => db.entities.Players.delete({ playerId: p1 }),
            (db) => rename(db, team),
            { on: "query" },
          )
          expect(result).toBe("ok")
          expect(yield* rowsAt(p1)).toEqual([])
          expect(yield* teamOf(p2)).toBe("Renamed")
        }),
      ),
    )

    it.effect(`${mode}: a target moved to another team after the query keeps its team`, () =>
      provide(
        Effect.gen(function* () {
          const [team, other] = [fresh("team"), fresh("team")]
          const [p1, p2] = [fresh("player"), fresh("player")]
          yield* seed(team, [p1, p2])
          yield* (yield* database).entities.Teams.put({ teamId: other, name: "Two" })
          const result = yield* race(
            (db) => db.entities.Players.update({ playerId: p1 }).set({ teamId: other }),
            (db) => rename(db, team),
            { on: "query" },
          )
          expect(result).toBe("ok")
          expect(yield* teamOf(p1)).toBe("Two")
          expect(yield* teamOf(p2)).toBe("Renamed")
        }),
      ),
    )
  }
})

// ---------------------------------------------------------------------------
// Paths whose existing guard closes the race (regression)
// ---------------------------------------------------------------------------

describeConnected("paths whose existing guard closes the race", () => {
  it.effect("an unversioned soft delete keeps a concurrent change in its tombstone", () =>
    provide(
      Effect.gen(function* () {
        const id = fresh("soft")
        yield* (yield* database).entities.SoftAccounts.put(account(id, "a@x.io"))
        const result = yield* race(
          (db) => db.entities.SoftAccounts.update({ accountId: id }).set({ name: "changed" }),
          (db) => db.entities.SoftAccounts.delete({ accountId: id }),
        )
        expect(result).toBe("ok")
        const rows = yield* rowsOf("SoftAccount", id)
        expect(rows.map((row) => [s(row.name), row.deletedAt !== undefined])).toEqual([
          ["changed", true],
        ])
      }),
    ),
  )

  it.effect("a unique hard delete racing an update of the unique field orphans no sentinel", () =>
    provide(
      Effect.gen(function* () {
        const id = fresh("hard")
        const [a, b] = [`${id}-a@x.io`, `${id}-b@x.io`]
        yield* (yield* database).entities.Accounts.put(account(id, a))
        const result = yield* race(
          (db) => db.entities.Accounts.update({ accountId: id }).set({ email: b }),
          (db) => db.entities.Accounts.delete({ accountId: id }),
        )
        expect(result).toBe("ok")
        expect(yield* rowsAt(id)).toEqual([])
        expect(yield* sentinels("Account", [a, b])).toEqual([])
      }),
    ),
  )

  it.effect("an update of the unique field does not undo a concurrent delete", () =>
    provide(
      Effect.gen(function* () {
        const id = fresh("unique-update")
        const [a, c] = [`${id}-a@x.io`, `${id}-c@x.io`]
        yield* (yield* database).entities.Accounts.put(account(id, a))
        yield* race(
          (db) => db.entities.Accounts.delete({ accountId: id }),
          (db) => db.entities.Accounts.update({ accountId: id }).set({ email: c }),
        )
        expect(yield* rowsAt(id)).toEqual([])
        expect(yield* sentinels("Account", [a, c])).toEqual([])
      }),
    ),
  )

  it.effect("a retain update racing a put back at version 1 writes no stale content", () =>
    provide(
      Effect.gen(function* () {
        const id = fresh("aba")
        yield* (yield* database).entities.RetainedNotes.put(account(id, "a@x.io"))
        const result = yield* race(
          (db) =>
            db.entities.RetainedNotes.put({ accountId: id, email: "b@x.io", name: "overwritten" }),
          (db) => db.entities.RetainedNotes.update({ accountId: id }).set({ name: "late" }),
        )
        const live = (yield* rowsOf("RetainedNote", id)).filter(
          (row) => row.sk?.S?.includes("#v#") !== true,
        )
        expect(live.map((row) => s(row.email))).toEqual(["b@x.io"])
        if (result === "ok") expect(s(live[0]?.name)).toBe("late")
      }),
    ),
  )
})
