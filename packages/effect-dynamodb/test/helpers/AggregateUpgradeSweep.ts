/**
 * Aggregates published 1.40.0 wrote, continued by this release (#241): the upgrade every shape of
 * the aggregate fixtures takes. Each shape is written by 1.40.0 (`create`), then read, updated with
 * no change, updated three times, updated while its second transaction fails (an earlier group has
 * committed, a later one hasn't), read, the failed update retried, and updated with no change again,
 * a read after each update. `fixtures/aggregate-upgrade-sweep-1.40.0.json` holds what published
 * 1.40.0 did for every step on DynamoDB Local; `AggregateUpgradeSweepSuite.ts` runs the same steps
 * with this release on the rows 1.40.0 wrote and asserts it never refuses one, and sends, stores,
 * reads and returns what 1.40.0 did, apart from the changes the changeset names.
 *
 * No runtime import: the shapes and steps are run with whichever release's modules they're handed
 * (`SweepLib`), published 1.40.0's by the capture and this release's by the suite.
 */

import type { AttributeValue } from "@aws-sdk/client-dynamodb"
import type { Cause, DateTime, Effect, Exit, Layer, Schema, SchemaGetter } from "effect"

export type Row = Record<string, AttributeValue>
export type Request = { readonly command: string; readonly input: unknown }

/** The modules of one release the sweep is run with. */
export type SweepLib = {
  readonly Aggregate: any
  readonly DynamoClient: any
  readonly DynamoError: any
  readonly Table: any
  readonly DynamoSchema: any
  readonly DynamoModel: any
  readonly Schema: typeof Schema
  readonly SchemaGetter: typeof SchemaGetter
  readonly Effect: typeof Effect
  readonly DateTime: typeof DateTime
  readonly Exit: typeof Exit
  readonly Cause: typeof Cause
  readonly Layer: typeof Layer
}

export type Change = { readonly label: string; readonly change: (state: any) => any }

export type Shape = {
  /** The root's fields beside `id`, `title` and `aside`. */
  readonly fields: Record<string, Schema.Top>
  readonly edges: Record<string, unknown>
  /** The input beside `id`, `title` and `aside`. */
  readonly input: Record<string, unknown>
  /** The partition key attribute, when it isn't `pk`. */
  readonly pk?: string
  readonly collection?: unknown
  readonly list?: unknown
  readonly context?: ReadonlyArray<string>
  readonly timestamps?: unknown
  /** The shape's own changes, run after `title t2`. */
  readonly changes?: ReadonlyArray<Change>
  /** What the failing update and its retry change beside the title and `aside`'s note. */
  readonly failing?: (state: any) => any
}

/** What a step did: its update's outcome, the requests sent, the rows after, the read after. */
export type Outcome = {
  readonly ok?: unknown
  readonly failed?: string
  readonly operation?: string
  /** A refusal's member and reason, as this release reports them: the fixture holds neither. */
  readonly member?: string
  readonly reason?: string
}
export type StepRecord = {
  readonly step: string
  readonly update: Outcome
  readonly requests: ReadonlyArray<Request>
  /** The transaction the injected failure refused, unsent. */
  readonly refused: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
}
export type Recorded = {
  readonly create: Outcome
  readonly requests: ReadonlyArray<Request>
  readonly rows: ReadonlyArray<Row>
  readonly get: Outcome
  readonly steps: ReadonlyArray<StepRecord>
}

/** What one run of the sweep records: a run on rows already stored has no `create`. */
export type Run = {
  readonly [K in "create" | "requests" | "rows"]?: Recorded[K] | undefined
} & Pick<Recorded, "get" | "steps">

export const SCHEMA_NAME = "sweep"
/** The local index every table has: the collection sort key's copy `csk` is its sort key. */
export const INDEX = { name: "lsi1", sk: "csk" } as const

/** What a row attribute the library writes holds, as `EDD-9159` names it. */
export const PARTITION = "the attribute holding the partition key"
export const SORT = "the attribute holding its sort key"
export const TYPE = "the attribute holding its entity type"
export const MIRRORED = "the attribute holding the collection sort key's copy"
export const CONTEXT = "a context attribute the aggregate copies onto its rows"
export const LIST_PK = "the attribute holding its list partition key"
export const LIST_SK = "the attribute holding its list sort key"

/**
 * What a read of a member returns at a name, as `EDD-9159` shows it: a string value, `undefined`
 * where the read returns nothing there, or the read's failure. `{ shown }` is a value already
 * rendered as the refusal renders it (a set, a date, a number).
 */
export type ReadBack = string | undefined | { readonly fails: string } | { readonly shown: string }

/** A value as `EDD-9159` renders it: a string quoted, a `{ shown }` as rendered. */
const shownAs = (value: string | { readonly shown: string }) =>
  typeof value === "string" ? JSON.stringify(value) : value.shown

/**
 * `EDD-9159`'s refusal of a `create` giving `name` a value a read of `member` doesn't return:
 * `given` (a string value, or `{ shown }`), and what the read returns there (`read`).
 */
export const givenOverRow = (
  member: string,
  name: string,
  given: string | { readonly shown: string },
  what: string,
  read: ReadBack,
) => {
  const returned =
    read === undefined || (typeof read === "object" && "fails" in read) ? undefined : shownAs(read)
  const reads =
    typeof read === "object" && read !== null && "fails" in read
      ? `fails there (${read.fails})`
      : returned === undefined
        ? "returns nothing for it"
        : `returns ${returned} for it`
  return (
    `[EDD-9159] "${member}" gives "${name}" the value ${shownAs(given)} at the top of its value, ` +
    `which is also ${what}. The library writes its own value there, and a read of "${member}" ` +
    `${reads}, so the value would not read back as given. ` +
    (typeof read === "object" && read !== null && "fails" in read
      ? `Name it something else, or declare "${name}" so a read of "${member}" takes the library's value.`
      : returned === undefined
        ? "Leave it out of the value, or name it something else."
        : `Give it ${returned}, leave it out of the value, or name it something else.`)
  )
}

/**
 * `EDD-9159`'s refusal of a `create` giving `name` no value where the library writes its own and a
 * read of `member` fails there (`fails`).
 */
export const unreadOverRow = (member: string, name: string, what: string, fails: string) =>
  `[EDD-9159] "${member}" gives "${name}" no value, and "${name}" is also ${what}. The library ` +
  `writes its own value there, and a read of "${member}" fails there (${fails}), so the row would ` +
  `not read back. Declare "${name}" in "${member}"'s value so it reads the library's value, or ` +
  "name it something else."

/**
 * `EDD-9159`'s refusal of a `create` whose `many` edge with a custom `decompose` gives `name` on its
 * rows `own`: a read of `member` returns `read` there, not `asReturned`, what it would return had
 * the rows kept their own value.
 */
export const customOverRow = (
  member: string,
  name: string,
  own: string | { readonly shown: string },
  what: string,
  asReturned: string | { readonly shown: string },
  read: string | { readonly shown: string } | { readonly fails: string },
) =>
  `[EDD-9159] "${member}"'s rows give "${name}" the value ${shownAs(own)}, which is also ${what}. ` +
  `The library writes its own value there, and a read of "${member}" ` +
  (typeof read === "object" && "fails" in read
    ? `fails (${read.fails})`
    : `returns ${shownAs(read)}, not ${shownAs(asReturned)}`) +
  ", so the value would not read back as given. Leave it out of the rows, or name it something else."

/** The builders a shape is defined with, over one release's modules. */
const kit = (lib: SweepLib) => {
  const { Schema, SchemaGetter } = lib
  const S = Schema.String
  const N = Schema.Number
  const U = Schema.Unknown
  const opt = (schema: Schema.Top): Schema.Top => Schema.optional(schema as never) as never
  const one = (extra: Record<string, unknown> = {}) =>
    lib.Aggregate.one({ entityType: "Note", ...extra })
  const many = (extra: Record<string, unknown> = {}) =>
    lib.Aggregate.many({ entityType: "Line", sk: { composite: ["qty"] }, ...extra })
  const sheets = () => lib.Aggregate.many({ entityType: "Sheet", sk: { composite: ["qty"] } })
  const sub = (Part: Schema.Top, edges: Record<string, unknown>, discriminator: unknown) =>
    lib.Aggregate.make(Part, { root: { entityType: "Part" }, edges }).with({ discriminator })
  const mirror = { name: SCHEMA_NAME, index: INDEX.name, sk: { field: INDEX.sk, composite: [] } }
  const isObject = (x: unknown): x is object => typeof x === "object" && x !== null
  const requiresSide = (u: unknown): u is { readonly side: 1 } =>
    isObject(u) && (u as { readonly side?: unknown }).side === 1
  const identity = {
    decode: SchemaGetter.transform((x: unknown) => x),
    encode: SchemaGetter.transform((x: unknown) => x),
  }
  const rename = {
    decode: SchemaGetter.transform(({ line, ...rest }: any) => ({ ...rest, text: line })),
    encode: SchemaGetter.transform(({ text, ...rest }: any) => ({ ...rest, line: text })),
  }
  /** A union whose second member renames a field: `line` stored, `text` held. */
  const renaming = () =>
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("ref"), qty: N, line: S }),
      (Schema.Struct({ kind: Schema.Literal("own"), qty: N, line: S }) as any).pipe(
        Schema.decodeTo(U, rename as never),
      ),
    ] as never) as unknown as Schema.Top
  return {
    lib,
    Schema,
    S,
    N,
    U,
    opt,
    one,
    many,
    sheets,
    sub,
    mirror,
    isObject,
    requiresSide,
    identity,
    renaming,
  }
}
type Kit = ReturnType<typeof kit>

const rootTenant: Change = { label: "root tenantId t2", change: (s) => ({ ...s, tenantId: "t2" }) }
const tenantFailing = (s: any) => ({ ...s, tenantId: "t9" })
/** A context shape: `tenantId` copied onto every row beneath the root. */
const tenant = (
  k: Kit,
  shape: Omit<Shape, "context">,
  changes: ReadonlyArray<Change> = [],
): Shape => ({
  ...shape,
  fields: { tenantId: k.S, ...shape.fields },
  input: { tenantId: "t1", ...shape.input },
  context: ["tenantId"],
  changes: [rootTenant, ...changes],
  failing: tenantFailing,
})

/** A `many` edge of `element`s: on the root, or on a sub-aggregate bound with `side: 1`. */
const manyShape = (k: Kit, element: Schema.Top, value: unknown, sub: boolean): Shape => {
  if (!sub) {
    return {
      fields: { lines: k.Schema.Array(element as never) },
      edges: { lines: k.sheets() },
      input: { lines: [value] },
    }
  }
  const Part = k.Schema.Struct({ lines: k.Schema.Array(element as never) })
  return {
    fields: { part: Part },
    edges: { part: k.sub(Part, { lines: k.sheets() }, { side: 1 }) },
    input: { part: { lines: [value] } },
  }
}

const note = { qty: 1, note: "n" }

/** Every shape of the aggregate fixtures, and the shapes the third review reproduced. */
export const sweepShapes: Record<string, (k: Kit) => Shape> = {
  // fixtures/aggregate-held-over-rows-1.40.0.json
  ...Object.fromEntries(
    (
      [
        ["pk", "mine"],
        ["sk", "mine"],
        ["__edd_e__", "mine"],
        ["gsi1pk", "mine"],
        ["lsiNote", "mine"],
      ] as const
    ).map(([name, value]) => [
      `held: an Unknown one edge holding ${name}`,
      (k: Kit): Shape => ({
        fields: { note: k.U },
        edges: { note: k.one() },
        input: { note: { text: "n", [name]: value } },
      }),
    ]),
  ),
  "held: an Unknown one edge holding createdAt, with timestamps": (k) => ({
    fields: { note: k.U },
    edges: { note: k.one() },
    input: { note: { text: "n", createdAt: "mine" } },
    timestamps: true,
  }),
  "held: an Unknown element holding gsiTag": (k) => ({
    fields: { lines: k.Schema.Array(k.U) },
    edges: { lines: k.many() },
    input: { lines: [{ qty: 1, gsiTag: "mine" }] },
  }),
  "held: a record element holding gsiTag": (k) => ({
    fields: { lines: k.Schema.Array(k.Schema.Record(k.S, k.U)) },
    edges: { lines: k.many() },
    input: { lines: [{ qty: 1, gsiTag: "mine" }] },
  }),
  "held: a custom decompose's row holding gsiTag": (k) => ({
    fields: { lines: k.Schema.Array(k.Schema.Struct({ qty: k.N })) },
    edges: {
      lines: k.many({
        decompose: (lines: ReadonlyArray<object>) =>
          lines.map((line) => ({ ...line, gsiTag: "mine" })),
        assemble: (rows: ReadonlyArray<{ readonly qty: number }>) =>
          rows.map((row) => ({ qty: row.qty })),
      }),
    },
    input: { lines: [{ qty: 1 }] },
  }),
  "held: a sub-aggregate's Unknown one edge holding gsi1sk": (k) => {
    const Part = k.Schema.Struct({ name: k.S, note: k.U })
    return {
      fields: { part: Part },
      edges: { part: k.sub(Part, { note: k.one() }, { side: 1 }) },
      input: { part: { name: "p", note: { text: "n", gsi1sk: "mine" } } },
    }
  },
  "held: a struct one edge declaring pk (optional), keyed under PK, given mine": (k) => ({
    pk: "PK",
    fields: { note: k.Schema.Struct({ text: k.S, pk: k.opt(k.S) }) },
    edges: { note: k.one() },
    input: { note: { text: "n", pk: "mine" } },
  }),
  "held: an Unknown one edge holding them nested": (k) => ({
    fields: { note: k.U },
    edges: { note: k.one() },
    input: {
      note: {
        text: "n",
        meta: { pk: "x", sk: "y", __edd_e__: "z", gsi1pk: "w", lsiNote: "v", createdAt: "u" },
      },
    },
  }),
  "held: an Unknown element holding them nested": (k) => ({
    fields: { lines: k.Schema.Array(k.U) },
    edges: { lines: k.many() },
    input: { lines: [{ qty: 1, meta: { pk: "x", gsiTag: "w" } }] },
  }),
  "held: an Unknown one edge holding names a read leaves": (k) => ({
    fields: { note: k.U },
    edges: { note: k.one() },
    input: { note: { text: "n", pkg: "x", skill: "y", gs: "z" } },
  }),
  ...Object.fromEntries(
    (
      [
        ["the other member", { kind: "text", text: "hello" }],
        ["that member", { kind: "key", csk: "mine" }],
      ] as const
    ).map(([given, value]) => [
      `held: a one edge union, a member declaring csk, given ${given}`,
      (k: Kit): Shape => ({
        collection: k.mirror,
        fields: {
          note: k.Schema.Union([
            k.Schema.Struct({ kind: k.Schema.Literal("text"), text: k.S }),
            k.Schema.Struct({ kind: k.Schema.Literal("key"), csk: k.S }),
          ]),
        },
        edges: { note: k.one() },
        input: { note: value },
      }),
    ]),
  ),
  "held: a one edge declaring csk (required)": (k) => ({
    collection: k.mirror,
    fields: { note: k.Schema.Struct({ text: k.S, csk: k.S }) },
    edges: { note: k.one() },
    input: { note: { text: "n", csk: "mine" } },
  }),
  "held: a one edge declaring csk (optional), given none": (k) => ({
    collection: k.mirror,
    fields: { note: k.Schema.Struct({ text: k.S, csk: k.opt(k.S) }) },
    edges: { note: k.one() },
    input: { note: { text: "n" } },
  }),
  "held: an Unknown one edge holding csk, the collection sort key's copy, given the copy": (k) => ({
    collection: k.mirror,
    fields: { note: k.U },
    edges: { note: k.one() },
    input: { note: { text: "n", csk: `$${SCHEMA_NAME}#v1#note` } },
  }),
  "held: context: an Unknown one edge, updates": (k) =>
    tenant(k, { fields: { note: k.U }, edges: { note: k.one() }, input: { note: { text: "n" } } }, [
      {
        label: "note tenantId other",
        change: (s) => ({ ...s, note: { ...s.note, tenantId: "other" } }),
      },
      {
        label: "note tenantId t2",
        change: (s) => ({ ...s, note: { ...s.note, tenantId: "t2" } }),
      },
      {
        label: "note without tenantId",
        change: (s) => {
          const { tenantId: _, ...rest } = s.note
          return { ...s, note: rest }
        },
      },
    ]),
  "held: context: an Unknown element, updates": (k) =>
    tenant(
      k,
      {
        fields: { lines: k.Schema.Array(k.U) },
        edges: { lines: k.many() },
        input: { lines: [{ qty: 1, text: "n" }] },
      },
      [
        {
          label: "element tenantId other",
          change: (s) => ({
            ...s,
            lines: s.lines.map((line: object) => ({ ...line, tenantId: "other" })),
          }),
        },
      ],
    ),
  "held: context: a struct one edge declaring tenantId": (k) =>
    tenant(k, {
      fields: { note: k.Schema.Struct({ text: k.S, tenantId: k.opt(k.S) }) },
      edges: { note: k.one() },
      input: { note: { text: "n" } },
    }),
  "held: context: a struct element declaring tenantId": (k) =>
    tenant(k, {
      fields: { lines: k.Schema.Array(k.Schema.Struct({ qty: k.N, tenantId: k.opt(k.S) })) },
      edges: { lines: k.many() },
      input: { lines: [{ qty: 1 }] },
    }),
  "held: context: a childless sub-aggregate declaring tenantId": (k) => {
    const Part = k.Schema.Struct({ name: k.S, tenantId: k.opt(k.S) })
    return tenant(k, {
      fields: { part: Part },
      edges: { part: k.sub(Part, {}, { side: 1 }) },
      input: { part: { name: "p" } },
    })
  },
  "held: context: a sub-aggregate with an edge, both declaring tenantId": (k) => {
    const Part = k.Schema.Struct({
      name: k.S,
      tenantId: k.opt(k.S),
      note: k.Schema.Struct({ text: k.S, tenantId: k.opt(k.S) }),
    })
    return tenant(k, {
      fields: { part: Part },
      edges: { part: k.sub(Part, { note: k.one() }, { side: 1 }) },
      input: { part: { name: "p", note: { text: "n" } } },
    })
  },
  "held: context: a custom decompose and assemble": (k) =>
    tenant(k, {
      fields: { lines: k.Schema.Array(k.Schema.Struct({ qty: k.N, tenantId: k.opt(k.S) })) },
      edges: {
        lines: k.many({
          decompose: (lines: ReadonlyArray<unknown>) => lines,
          assemble: (rows: ReadonlyArray<{ readonly qty: number; readonly tenantId?: string }>) =>
            rows.map((row) => ({
              qty: row.qty,
              ...(row.tenantId === undefined ? {} : { tenantId: row.tenantId }),
            })),
        }),
      },
      input: { lines: [{ qty: 1 }] },
    }),
  "held: a childless sub-aggregate declaring teamNumber as BigInt, its discriminator 1, given 1n": (
    k,
  ) => {
    const Part = k.Schema.Struct({ teamNumber: k.Schema.BigInt, note: k.S })
    return {
      fields: { part: Part },
      edges: { part: k.sub(Part, {}, { teamNumber: 1 }) },
      input: { part: { teamNumber: 1n, note: "x" } },
      changes: [{ label: "note y", change: (s) => ({ ...s, part: { ...s.part, note: "y" } }) }],
    }
  },
  "held: two childless sub-aggregates of one model, an update copying one into the other": (k) => {
    const Part = k.Schema.Struct({ name: k.S, side: k.opt(k.N) })
    return {
      fields: { one: Part, two: Part },
      edges: { one: k.sub(Part, {}, { side: 1 }), two: k.sub(Part, {}, { side: 2 }) },
      input: { one: { name: "a" }, two: { name: "b" } },
      changes: [{ label: "two = one", change: (s) => ({ ...s, two: { ...s.one } }) }],
    }
  },
  "held: two sub-aggregates of one model, an update copying one's elements into the other": (k) => {
    const Part = k.Schema.Struct({
      lines: k.Schema.Array(k.Schema.Struct({ qty: k.N, side: k.opt(k.N) })),
    })
    return {
      fields: { one: Part, two: Part },
      edges: {
        one: k.sub(Part, { lines: k.many() }, { side: 1 }),
        two: k.sub(Part, { lines: k.many() }, { side: 2 }),
      },
      input: { one: { lines: [{ qty: 1 }] }, two: { lines: [{ qty: 2 }] } },
      changes: [
        { label: "two.lines = one.lines", change: (s) => ({ ...s, two: { lines: s.one.lines } }) },
      ],
    }
  },

  // fixtures/aggregate-context-read-1.40.0.json
  ...Object.fromEntries(
    (
      [
        ["no tenantId", {}],
        ["the root's tenantId", { tenantId: "t1" }],
        ["another tenantId", { tenantId: "other" }],
      ] as const
    ).flatMap(([holding, extra]) => [
      [
        `context: an Unknown one edge holding ${holding}`,
        (k: Kit): Shape =>
          tenant(k, {
            fields: { note: k.U },
            edges: { note: k.one() },
            input: { note: { text: "n", ...extra } },
          }),
      ],
      [
        `context: an Unknown element holding ${holding}`,
        (k: Kit): Shape =>
          tenant(k, {
            fields: { lines: k.Schema.Array(k.U) },
            edges: { lines: k.many() },
            input: { lines: [{ qty: 1, text: "n", ...extra }] },
          }),
      ],
      [
        `context: a struct one edge declaring tenantId, given ${holding === "no tenantId" ? "none" : holding === "another tenantId" ? "another" : "the root's"}`,
        (k: Kit): Shape =>
          tenant(k, {
            fields: { note: k.Schema.Struct({ text: k.S, tenantId: k.opt(k.S) }) },
            edges: { note: k.one() },
            input: { note: { text: "n", ...extra } },
          }),
      ],
    ]),
  ),
  "context: an Unknown element with a custom assemble holding another tenantId": (k) =>
    tenant(k, {
      fields: { lines: k.Schema.Array(k.U) },
      edges: {
        lines: k.many({
          assemble: (items: ReadonlyArray<unknown>) => items,
          decompose: (value: unknown) => value,
        }),
      },
      input: { lines: [{ qty: 1, text: "n", tenantId: "other" }] },
    }),
  "context: a sub-aggregate declaring tenantId, given another": (k) => {
    const Part = k.Schema.Struct({ name: k.S, tenantId: k.opt(k.S) })
    return tenant(k, {
      fields: { part: Part },
      edges: { part: k.sub(Part, {}, { side: 1 }) },
      input: { part: { name: "p", tenantId: "other" } },
    })
  },
  ...Object.fromEntries(
    ([1, 2] as const).map((side) => [
      `context: sub-aggregate, an Unknown element holding ${side === 1 ? "its discriminator's value" : "another value in its discriminator"}`,
      (k: Kit): Shape => {
        const Part = k.Schema.Struct({ lines: k.Schema.Array(k.U) })
        return {
          fields: { tenantId: k.S, part: Part },
          edges: { part: k.sub(Part, { lines: k.many() }, { side: 1 }) },
          input: { tenantId: "t1", part: { lines: [{ qty: 1, text: "n", side }] } },
        }
      },
    ]),
  ),
  "context: an Unknown one edge holding csk, the collection sort key's copy": (k) =>
    tenant(k, {
      collection: k.mirror,
      fields: { note: k.U },
      edges: { note: k.one() },
      input: { note: { text: "n", csk: "mine" } },
    }),

  // fixtures/aggregate-row-key-fields-1.40.0.json
  "keys: root declares pk (optional), given mine": (k) => ({
    fields: { pk: k.opt(k.S) },
    edges: {},
    input: { pk: "mine" },
  }),
  "keys: root declares pk (optional), given none": (k) => ({
    fields: { pk: k.opt(k.S) },
    edges: {},
    input: {},
    changes: [{ label: "pk mine", change: (s) => ({ ...s, pk: "mine" }) }],
  }),
  "keys: root's composite id is the pk attribute": () => ({
    pk: "id",
    fields: {},
    edges: {},
    input: {},
  }),
  "keys: root declares sk (optional), given mine": (k) => ({
    fields: { sk: k.opt(k.S) },
    edges: {},
    input: { sk: "mine" },
  }),
  "keys: root declares __edd_e__ (optional), given mine": (k) => ({
    fields: { __edd_e__: k.opt(k.S) },
    edges: {},
    input: { __edd_e__: "mine" },
  }),
  "keys: root declares the list pk attribute status": (k) => ({
    fields: { status: k.S },
    edges: {},
    input: { status: "open" },
    list: {
      index: "gsi1",
      name: "byStatus",
      pk: { field: "status", composite: ["status"] },
      sk: { field: "lsk", composite: ["id"] },
    },
    changes: [{ label: "status closed", change: (s) => ({ ...s, status: "closed" }) }],
  }),
  "keys: root declares the list sk attribute rank": (k) => ({
    fields: { rank: k.S },
    edges: {},
    input: { rank: "r1" },
    list: byRank,
    changes: [{ label: "rank r2", change: (s) => ({ ...s, rank: "r2" }) }],
  }),
  "keys: root declares the list sk attribute rank (optional), given none": (k) => ({
    fields: { rank: k.opt(k.S) },
    edges: {},
    input: {},
    list: byRank,
    changes: [{ label: "rank r1", change: (s) => ({ ...s, rank: "r1" }) }],
  }),
  "keys: root declares the list sk attribute lsk, given mine, its list composite prio given none": (
    k,
  ) => ({
    fields: { lsk: k.opt(k.S), prio: k.opt(k.S) },
    edges: {},
    input: { lsk: "mine" },
    list: byPrio("lpk", "lsk"),
    changes: [{ label: "prio p1", change: (s) => ({ ...s, prio: "p1" }) }],
  }),
  "keys: root declares the list sk attribute lsk, given mine, its list composite prio given": (
    k,
  ) => ({
    fields: { lsk: k.opt(k.S), prio: k.opt(k.S) },
    edges: {},
    input: { lsk: "mine", prio: "p1" },
    list: byPrio("lpk", "lsk"),
    changes: [{ label: "prio p2", change: (s) => ({ ...s, prio: "p2" }) }],
  }),
  "keys: root declares the list sk attribute lsk (optional), its list composite prio given": (
    k,
  ) => ({
    fields: { lsk: k.opt(k.S), prio: k.opt(k.S) },
    edges: {},
    input: { prio: "p1" },
    list: byPrio("lpk", "lsk"),
    changes: [{ label: "prio p2", change: (s) => ({ ...s, prio: "p2" }) }],
  }),
  "keys: root declares the list pk attribute gsi1pk (optional), given mine": (k) => ({
    fields: { gsi1pk: k.opt(k.S), prio: k.opt(k.S) },
    edges: {},
    input: { gsi1pk: "mine" },
    list: byPrio("gsi1pk", "gsi1sk"),
    changes: [{ label: "prio p1", change: (s) => ({ ...s, prio: "p1" }) }],
  }),
  "keys: one edge value declares sk (optional), given mine": (k) => ({
    fields: { note: k.Schema.Struct({ text: k.S, sk: k.opt(k.S) }) },
    edges: { note: k.one() },
    input: { note: { text: "n", sk: "mine" } },
  }),
  "keys: one edge value declares pk (optional), given none": (k) => ({
    fields: { note: k.Schema.Struct({ text: k.S, pk: k.opt(k.S) }) },
    edges: { note: k.one() },
    input: { note: { text: "n" } },
    changes: [
      { label: "note pk mine", change: (s) => ({ ...s, note: { ...s.note, pk: "mine" } }) },
    ],
  }),
  "keys: many element declares __edd_e__ (optional), given mine": (k) => ({
    fields: { lines: k.Schema.Array(k.Schema.Struct({ qty: k.N, __edd_e__: k.opt(k.S) })) },
    edges: { lines: k.many() },
    input: { lines: [{ qty: 1, __edd_e__: "mine" }] },
  }),
  "keys: sub-aggregate declares pk (optional), given mine": (k) => {
    const Part = k.Schema.Struct({ name: k.S, pk: k.opt(k.S) })
    return {
      fields: { part: Part },
      edges: { part: k.sub(Part, {}, { side: "x" }) },
      input: { part: { name: "p", pk: "mine" } },
    }
  },
  "keys: one edge value declares csk, the collection sk mirror, given mine": (k) => ({
    collection: k.mirror,
    fields: { note: k.Schema.Struct({ text: k.S, csk: k.opt(k.S) }) },
    edges: { note: k.one() },
    input: { note: { text: "n", csk: "mine" } },
  }),
  ...Object.fromEntries(
    (
      [
        ["another", "b"],
        ["it", "a"],
      ] as const
    ).map(([given, kind]) => [
      `keys: one edge value declares its discriminator kind, given ${given}`,
      (k: Kit): Shape => ({
        fields: { note: k.Schema.Struct({ text: k.S, kind: k.S }) },
        edges: { note: k.one({ discriminator: { kind: "a" } }) },
        input: { note: { text: "n", kind } },
        changes: [
          {
            label: "note kind b, text m",
            change: (s) => ({ ...s, note: { ...s.note, kind: "b", text: "m" } }),
          },
        ],
      }),
    ]),
  ),
  "keys: one edge value declares its discriminator kind (optional), given none": (k) => ({
    fields: { note: k.Schema.Struct({ text: k.S, kind: k.opt(k.S) }) },
    edges: { note: k.one({ discriminator: { kind: "a" } }) },
    input: { note: { text: "n" } },
  }),
  "keys: one edge value declares its numeric discriminator n as NumberFromString, given it": (
    k,
  ) => ({
    fields: { note: k.Schema.Struct({ text: k.S, n: k.Schema.NumberFromString }) },
    edges: { note: k.one({ discriminator: { n: 1 } }) },
    input: { note: { text: "n", n: 1 } },
  }),
  "keys: many element under a sub-aggregate declares its discriminator side, given another": (
    k,
  ) => {
    const Part = k.Schema.Struct({
      name: k.S,
      lines: k.Schema.Array(k.Schema.Struct({ qty: k.N, side: k.S })),
    })
    return {
      fields: { part: Part },
      edges: { part: k.sub(Part, { lines: k.many() }, { side: "x" }) },
      input: { part: { name: "p", lines: [{ qty: 1, side: "y" }] } },
    }
  },
  ...Object.fromEntries(
    (
      [
        ["another", "y"],
        ["it", "x"],
      ] as const
    ).map(([given, side]) => [
      `keys: sub-aggregate declares its discriminator side, given ${given}`,
      (k: Kit): Shape => {
        const Part = k.Schema.Struct({ name: k.S, side: k.S })
        return {
          fields: { part: Part },
          edges: { part: k.sub(Part, {}, { side: "x" }) },
          input: { part: { name: "p", side } },
          changes: [
            { label: "part side y", change: (s) => ({ ...s, part: { ...s.part, side: "y" } }) },
          ],
        }
      },
    ]),
  ),

  // fixtures/aggregate-read-strip-1.40.0.json: the shapes 1.40.0 reads (one declaring a name it
  // took off by its prefix, required, failed every read on 1.40.0: no upgrade continues from it).
  "strip: sub-aggregate declaring skills": (k) => {
    const Part = k.Schema.Struct({ name: k.S, skills: k.S })
    return {
      fields: { part: Part },
      edges: { part: k.sub(Part, {}, { side: 1 }) },
      input: { part: { name: "p", skills: "ts" } },
    }
  },
  "strip: sub-aggregate declaring pkg (optional)": (k) => {
    const Part = k.Schema.Struct({ name: k.S, pkg: k.opt(k.S) })
    return {
      fields: { part: Part },
      edges: { part: k.sub(Part, {}, { side: 1 }) },
      input: { part: { name: "p", pkg: "x" } },
    }
  },
  "strip: root declaring gsi2pk (optional), no list": (k) => ({
    fields: { gsi2pk: k.opt(k.S) },
    edges: {},
    input: { gsi2pk: "x" },
  }),
  ...Object.fromEntries(
    (
      [
        [
          "childless sub-aggregate declaring pkey (optional), keyed under pkey, given none",
          false,
          undefined,
        ],
        [
          "sub-aggregate with an edge declaring pkey (optional), keyed under pkey, given none",
          true,
          undefined,
        ],
        [
          "sub-aggregate with an edge declaring pkey (optional), keyed under pkey, given mine",
          true,
          "mine",
        ],
        [
          "childless sub-aggregate declaring pkey (optional), keyed under pkey, given mine",
          false,
          "mine",
        ],
      ] as const
    ).map(([label, withEdge, pkey]) => [
      `strip: ${label}`,
      (k: Kit): Shape => {
        const Part = k.Schema.Struct({
          name: k.S,
          pkey: k.opt(k.S),
          ...(withEdge ? { note: k.Schema.Struct({ text: k.S }) } : {}),
        })
        return {
          pk: "pkey",
          fields: { part: Part },
          edges: { part: k.sub(Part, withEdge ? { note: k.one() } : {}, { side: 1 }) },
          input: {
            part: {
              name: "p",
              ...(pkey === undefined ? {} : { pkey }),
              ...(withEdge ? { note: { text: "n" } } : {}),
            },
          },
        }
      },
    ]),
  ),

  // fixtures/aggregate-discriminator-read-1.39.0.json and -opaque-1.40.0.json
  "disc: a union member renaming a field, given its domain value": (k) =>
    manyShape(k, k.renaming(), { kind: "own", qty: 3, text: "KEEP" }, false),
  "disc: sub-aggregate, a union member renaming a field, given its domain value": (k) =>
    manyShape(k, k.renaming(), { kind: "own", qty: 3, text: "KEEP" }, true),
  "disc: sub-aggregate, an Unknown element": (k) => manyShape(k, k.U, note, true),
  "disc: sub-aggregate, a declared element": (k) =>
    manyShape(k, k.Schema.declare(k.isObject), note, true),
  "disc: sub-aggregate, a struct element declaring the discriminator's name": (k) =>
    manyShape(k, k.Schema.Struct({ qty: k.N, side: k.N }), { qty: 1, side: 1 }, true),
  "disc: sub-aggregate, a record element": (k) =>
    manyShape(k, k.Schema.Record(k.S, k.U), note, true),
  "disc: sub-aggregate, an Unknown one edge": (k) => {
    const Part = k.Schema.Struct({ title: k.S, note: k.U })
    return {
      fields: { part: Part },
      edges: { part: k.sub(Part, { note: k.one() }, { side: 1 }) },
      input: { part: { title: "p", note: { text: "n" } } },
    }
  },
  "disc: an Unknown one edge with its own discriminator": (k) => ({
    fields: { note: k.U },
    edges: { note: k.one({ discriminator: { slot: "main" } }) },
    input: { note: { text: "n" } },
  }),
  "disc: sub-aggregate, an Unknown element with a custom assemble": (k) => {
    const Part = k.Schema.Struct({ lines: k.Schema.Array(k.U) })
    return {
      fields: { part: Part },
      edges: {
        part: k.sub(
          Part,
          {
            lines: k.lib.Aggregate.many({
              entityType: "Sheet",
              sk: { composite: ["qty"] },
              assemble: (items: ReadonlyArray<unknown>) => items,
              decompose: (value: unknown) => value,
            }),
          },
          { side: 1 },
        ),
      },
      input: { part: { lines: [note] } },
    }
  },
  "disc: an Unknown element, the collection sort key mirrored in csk": (k) => ({
    ...manyShape(k, k.U, note, false),
    collection: k.mirror,
  }),
  "disc: an Unknown one edge, the collection sort key mirrored in csk": (k) => ({
    collection: k.mirror,
    fields: { note: k.U },
    edges: { note: k.one() },
    input: { note: { text: "n" } },
  }),
  "disc: a struct element declaring csk, the collection sort key mirrored in csk": (k) => ({
    ...manyShape(k, k.Schema.Struct({ qty: k.N, csk: k.opt(k.S) }), { qty: 1 }, false),
    collection: k.mirror,
  }),
  "disc: sub-aggregate, a declared element requiring the discriminator": (k) =>
    manyShape(
      k,
      k.Schema.declare(
        (u): u is { qty: number; side: 1 } =>
          k.requiresSide(u) && typeof (u as { qty?: unknown }).qty === "number",
      ),
      { qty: 1, side: 1 },
      true,
    ),
  "disc: sub-aggregate, a union of a struct and a declared element": (k) =>
    manyShape(
      k,
      k.Schema.Union([
        k.Schema.Struct({ kind: k.Schema.Literal("a"), qty: k.N }),
        k.Schema.declare(k.isObject),
      ]),
      note,
      true,
    ),
  "disc: sub-aggregate, a transformed element": (k) =>
    manyShape(
      k,
      (k.Schema.Struct({ qty: k.N, note: k.S }) as any).pipe(
        k.Schema.decodeTo(k.U, k.identity as never),
      ),
      note,
      true,
    ),
  "disc: sub-aggregate, a suspended Unknown element": (k) =>
    manyShape(
      k,
      k.Schema.suspend(() => k.U),
      note,
      true,
    ),
  "disc: sub-aggregate, a union of a struct and Unknown": (k) =>
    manyShape(
      k,
      k.Schema.Union([k.Schema.Struct({ kind: k.Schema.Literal("a"), qty: k.N }), k.U]),
      note,
      true,
    ),
  "disc: sub-aggregate, a declared one edge requiring the discriminator": (k) => {
    const Part = k.Schema.Struct({ title: k.S, note: k.Schema.declare(k.requiresSide) })
    return {
      fields: { part: Part },
      edges: { part: k.sub(Part, { note: k.one() }, { side: 1 }) },
      input: { part: { title: "p", note: { text: "n", side: 1 } } },
    }
  },
  "disc: an Unknown element, keyed under PK": (k) => ({
    ...manyShape(k, k.U, note, false),
    collection: k.mirror,
    pk: "PK",
  }),
  "disc: an Unknown one edge, keyed under PK": (k) => ({
    collection: k.mirror,
    pk: "PK",
    fields: { note: k.U },
    edges: { note: k.one() },
    input: { note: { text: "n" } },
  }),
  "disc: a struct element declaring PK, keyed under PK": (k) => ({
    ...manyShape(k, k.Schema.Struct({ qty: k.N, PK: k.opt(k.S) }), { qty: 1 }, false),
    collection: k.mirror,
    pk: "PK",
  }),

  // The third review's reproductions.
  "repro: context over a Schema.optional date beside an Unknown value under a sub-aggregate": (
    k,
  ) => {
    const Part = k.Schema.Struct({ name: k.S, note: k.U })
    return {
      fields: { since: k.opt(k.lib.DynamoModel.DateEpochMs), part: Part },
      edges: { part: k.sub(Part, { note: k.one() }, { side: 1 }) },
      input: {
        since: k.lib.DateTime.makeUnsafe(1714979289000),
        part: { name: "p", note: { text: "n" } },
      },
      context: ["since"],
      failing: (s) => ({ ...s, since: k.lib.DateTime.makeUnsafe(1714979300000) }),
    }
  },
  "repro: context changed while a later group's transaction fails": (k) => {
    const Part = k.Schema.Struct({ name: k.S, note: k.U })
    return tenant(k, {
      fields: { part: Part },
      edges: { part: k.sub(Part, { note: k.one() }, { side: 1 }) },
      input: { part: { name: "p", note: { text: "n" } } },
    })
  },
  "repro: a value a read handed back, moved to another edge while the context changes": (k) => ({
    fields: { tenantId: k.S, draft: k.opt(k.U), pinned: k.opt(k.U) },
    edges: { draft: k.one({ entityType: "Draft" }), pinned: k.one({ entityType: "Pinned" }) },
    input: { tenantId: "t1", draft: { text: "n" } },
    context: ["tenantId"],
    changes: [
      {
        label: "pinned = draft, tenantId t2",
        change: (s) => {
          const { draft, ...rest } = s
          return { ...rest, tenantId: "t2", pinned: draft }
        },
      },
    ],
    failing: tenantFailing,
  }),
  "repro: an edge field named sk with a decoding default, never given": (k) => ({
    fields: {
      note: k.Schema.Struct({
        text: k.S,
        sk: k.S.pipe(k.opt, k.Schema.withDecodingDefault(k.lib.Effect.succeed("none"))),
      }),
    },
    edges: { note: k.one() },
    input: { note: { text: "x" } },
  }),
  "repro: a required csk whose every value is the mirror": (k) => ({
    collection: k.mirror,
    fields: {
      note: k.Schema.Struct({ text: k.S, csk: k.Schema.Literal(`$${SCHEMA_NAME}#v1#note`) }),
    },
    edges: { note: k.one() },
    input: { note: { text: "n", csk: `$${SCHEMA_NAME}#v1#note` } },
  }),
  "repro: new elements an update adds out of order, the list checked sorted": (k) => ({
    fields: {
      lines: k.Schema.Array(k.Schema.Struct({ qty: k.N })).check(
        k.Schema.makeFilter(
          (lines: ReadonlyArray<{ readonly qty: number }>) =>
            lines.every((line, i) => i === 0 || lines[i - 1]!.qty <= line.qty) ||
            "lines must be sorted",
        ),
      ),
    },
    edges: { lines: k.many() },
    input: { lines: [{ qty: 2 }, { qty: 4 }] },
    changes: [
      {
        label: "lines 1, 2, 3, 4",
        change: (s) => ({ ...s, lines: [{ qty: 1 }, { qty: 2 }, { qty: 3 }, { qty: 4 }] }),
      },
    ],
  }),
}

const byRank = {
  index: "gsi1",
  name: "byRank",
  pk: { field: "lpk", composite: [] },
  sk: { field: "rank", composite: ["rank"] },
}
const byPrio = (pk: string, sk: string) => ({
  index: "gsi1",
  name: "byPrio",
  pk: { field: pk, composite: [] },
  sk: { field: sk, composite: ["prio"] },
})

/** A shape's definition over one release's modules. */
export const shapeOf = (lib: SweepLib, label: string): Shape => sweepShapes[label]!(kit(lib))

/** The steps every shape takes after `create`, by label, each followed by a read. */
export const stepsOf = (shape: Shape): ReadonlyArray<Change & { readonly fails?: true }> => {
  const failing = (s: any) => {
    const changed = { ...s, title: "t4", aside: { ...s.aside, note: "d" } }
    return shape.failing === undefined ? changed : shape.failing(changed)
  }
  return [
    { label: "noop", change: (s) => ({ ...s }) },
    { label: "title t2", change: (s) => ({ ...s, title: "t2" }) },
    ...(shape.changes ?? []),
    { label: "aside note b", change: (s) => ({ ...s, aside: { ...s.aside, note: "b" } }) },
    {
      label: "title t3, aside tag t3",
      change: (s) => ({ ...s, title: "t3", aside: { ...s.aside, tag: { text: "t3" } } }),
    },
    { label: "failing: its second transaction refused", change: failing, fails: true },
    { label: "retry", change: failing },
    { label: "noop again", change: (s) => ({ ...s }) },
  ]
}

/** As the fixture holds it: a `bigint` as `1n`. */
export const plain = <A>(value: A): A =>
  value === undefined
    ? value
    : JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v)))

const outcomeOf = (lib: SweepLib, exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (lib.Exit.isSuccess(exit)) return { ok: plain(exit.value) }
  const error = lib.Cause.squash(exit.cause) as {
    _tag?: string
    operation?: string
    member?: string
    reason?: string
  }
  return {
    failed: error._tag ?? "defect",
    ...(error.operation !== undefined && { operation: error.operation }),
    ...(error.member !== undefined && { member: error.member }),
    ...(error.reason !== undefined && { reason: error.reason }),
  }
}

/** What the sweep runs on: a table of its own, its client recording what's sent. */
export type SweepIo = {
  readonly tableName: string
  /** The `DynamoClient` service, recording each request. */
  readonly client: any
  /** The requests sent since the last call, the table's name as `<table>`. */
  readonly take: () => ReadonlyArray<Request>
  /** Every row, in key order. */
  readonly scan: () => Effect.Effect<ReadonlyArray<Row>, unknown>
}

const keyOf = (row: Row) => `${(row.pk ?? row.PK ?? row.id ?? row.pkey)?.S} ${row.sk?.S}`
export const inKeyOrder = (rows: ReadonlyArray<Row>): ReadonlyArray<Row> =>
  [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))

/** The aggregate of a shape, over one release's modules. */
export const defineShape = (lib: SweepLib, shape: Shape) => {
  const { Schema } = lib
  // 1.40.0's default, which the capture ran under. A `test:escape-on` run turns the default over,
  // and key text escaped differs from 1.40.0's wherever a composite holds `$` or `#` (a list key's
  // copy a read handed back, recomposed), which is `rekey`'s to move, not this sweep's to compare.
  const schema = lib.DynamoSchema.make({ name: SCHEMA_NAME, version: 1, escapeKeys: false })
  const Main = lib.Table.make({ schema, entities: {} })
  const Aside = Schema.Struct({ note: Schema.String, tag: Schema.Struct({ text: Schema.String }) })
  const A = lib.Aggregate.make(
    Schema.Struct({ id: Schema.String, title: Schema.String, ...shape.fields, aside: Aside }),
    {
      table: Main,
      schema,
      pk: { field: shape.pk ?? "pk", composite: ["id"] },
      collection: shape.collection ?? { name: SCHEMA_NAME },
      root: { entityType: "Root" },
      edges: {
        ...shape.edges,
        aside: lib.Aggregate.make(Aside, {
          root: { entityType: "Aside" },
          edges: { tag: lib.Aggregate.one({ entityType: "Tag" }) },
        }).with({ discriminator: { bay: 1 } }),
      },
      ...(shape.list !== undefined && { list: shape.list }),
      ...(shape.context !== undefined && { context: shape.context }),
      ...(shape.timestamps !== undefined && { timestamps: shape.timestamps }),
    },
  )
  return { A, Main }
}

/** The input `create` is given. */
export const inputOf = (shape: Shape) => ({
  id: "a",
  title: "t",
  ...shape.input,
  aside: { note: "a", tag: { text: "t" } },
})

/**
 * The steps of `shape` with `lib`'s release: `create` first unless the table holds the rows already
 * (`seeded`), then a read, then each step of {@link stepsOf}, a read after each.
 */
export const runSweep = (
  lib: SweepLib,
  shape: Shape,
  io: SweepIo,
  seeded: boolean,
): Effect.Effect<Run, unknown> => {
  const { Effect, Layer } = lib
  const { A, Main } = defineShape(lib, shape)
  const bind = (client: unknown) =>
    lib.DynamoClient.make({ entities: {}, aggregates: { A }, tables: { Main } }).pipe(
      Effect.map((db: any) => db.aggregates.A),
      Effect.provide(
        Layer.merge(Layer.succeed(lib.DynamoClient, client), Main.layer({ name: io.tableName })),
      ),
    ) as Effect.Effect<any, unknown>
  return Effect.gen(function* () {
    const agg = yield* bind(io.client)
    const key = { id: "a" }
    io.take()
    let created: Pick<Run, "create" | "requests" | "rows"> = {}
    if (!seeded) {
      const create = outcomeOf(lib, yield* Effect.exit(agg.create(inputOf(shape))))
      created = { create, requests: io.take(), rows: inKeyOrder(yield* io.scan()) }
    }
    const get = outcomeOf(lib, yield* Effect.exit(agg.get(key)))
    io.take()
    const steps: Array<StepRecord> = []
    for (const { label, change, fails } of stepsOf(shape)) {
      const refused: Array<Request> = []
      let target = agg
      if (fails === true) {
        let transactions = 0
        target = yield* bind({
          ...io.client,
          transactWriteItems: (input: unknown) => {
            if (++transactions !== 2) return io.client.transactWriteItems(input)
            refused.push({
              command: "TransactWriteItems",
              input: JSON.parse(JSON.stringify(input).replaceAll(io.tableName, "<table>")),
            })
            return Effect.fail(
              new lib.DynamoError({
                operation: "TransactWriteItems",
                cause: new Error("ProvisionedThroughputExceededException"),
              }),
            )
          },
        })
      }
      const update = outcomeOf(
        lib,
        yield* Effect.exit(target.update(key, ({ state }: any) => change(state))),
      )
      const requests = io.take()
      const rows = inKeyOrder(yield* io.scan())
      const after = outcomeOf(lib, yield* Effect.exit(agg.get(key)))
      io.take()
      steps.push({ step: label, update, requests, refused, rows, get: after })
    }
    return { ...created, get, steps }
  }) as unknown as Effect.Effect<Run, unknown>
}
