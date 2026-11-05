/**
 * `[EDD-9106]`: two key halves stored in one attribute, one of them on a sharded
 * index (#183). Whichever is written last overwrites the other, so they may share
 * it only when they provably compose the same bytes for every item.
 *
 * A pair of unsharded halves isn't judged. Whether two different texts clash depends
 * on data a definition can't show: two accessors on one physical index over composites
 * no item holds together work, and they predate sharding. A pair with a sharded half
 * can only be in a new definition, so refusing it breaks nothing.
 */

import type { Schema } from "effect"
import * as DynamoSchema from "../DynamoSchema.js"
import {
  composePk,
  composeSk,
  type IndexDefinition,
  isZOrderHalf,
  unshardedView,
} from "../KeyComposer.js"
import { keyFormValueKind } from "./CompositeCodec.js"

/** A model's fields, by name: what says which composites hold numbers. */
type Fields = Readonly<Record<string, Schema.Top>> | undefined

interface KeyHalf {
  readonly owner: string
  readonly half: "pk" | "sk"
  readonly index: IndexDefinition
  readonly field: string
}

const describe = ({ owner, half }: KeyHalf): string =>
  `${owner === "primary" ? "the primary key" : `index "${owner}"`}'s ${
    half === "pk" ? "partition" : "sort"
  } key`

const isZOrder = ({ half, index }: KeyHalf): boolean => half === "sk" && isZOrderHalf(index.sk)

/**
 * A number or bigint's key text has no letters and nothing a sort key escapes
 * (`NumericKey`), so neither a casing nor the half it's in changes it. A field whose
 * schema doesn't pin one of those two can hold anything.
 */
const holdsOnlyNumbers = (fields: Fields, attr: string): boolean => {
  const field = fields?.[attr]
  if (field === undefined) return false
  const kind = keyFormValueKind(field)
  return kind === "number" || kind === "bigint"
}

/** The hash a sharded partition key's marker depends on; nothing on any other half. */
const shardForm = ({ half, index }: KeyHalf): string | undefined =>
  half === "pk" && index.shards !== undefined
    ? JSON.stringify([index.shards.count, index.shards.source])
    : undefined

/**
 * The text a half composes, with each value replaced by a stand-in, from the composers
 * themselves so this can't drift from them. A stand-in is unique to the exact attribute
 * (`tenant` and `Tenant` have one label between them, and different values), and holds
 * letters of both cases and a character a sort key escapes, so a casing or a half's kind
 * shows wherever it reaches a value. A number's holds neither, as a number's text doesn't.
 */
const textForm = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  fields: Fields,
  standIns: Map<string, string>,
  { half, index }: KeyHalf,
): string => {
  const composites = half === "pk" ? index.pk.composite : index.sk.composite
  const record: Record<string, string> = {}
  for (const attr of composites) {
    if (!standIns.has(attr)) {
      const mark = String.fromCharCode(0xe000 + standIns.size)
      standIns.set(attr, holdsOnlyNumbers(fields, attr) ? mark : `${mark}aB%`)
    }
    record[attr] = standIns.get(attr)!
  }
  return half === "pk"
    ? composePk(schema, entityType, unshardedView(index), record)
    : composeSk(schema, entityType, 1, index, record)
}

/**
 * What a Z-order half's bytes depend on: each prefix composite with its hash and, unless
 * it holds only numbers, its casing (nothing else in the address is cased), and every
 * dimension's options, in interleave order.
 */
const zOrderForm = (casing: DynamoSchema.Casing, fields: Fields, { index }: KeyHalf): string => {
  if (!isZOrderHalf(index.sk)) return ""
  const { prefix, dimensions } = index.sk.zorderHalf
  return JSON.stringify({
    prefix: prefix.map(({ field, hash }) => ({
      field,
      hash: hash ?? null,
      casing: holdsOnlyNumbers(fields, field) ? null : (index.casing ?? casing),
    })),
    // A date's `from` is held normalized, so two spellings of one instant are the same.
    dimensions,
  })
}

/** Do two halves compose the same bytes for every item, under this schema casing? */
const composeTheSame = (
  casing: DynamoSchema.Casing,
  entityType: string,
  fields: Fields,
  a: KeyHalf,
  b: KeyHalf,
): boolean => {
  if (isZOrder(a) !== isZOrder(b) || shardForm(a) !== shardForm(b)) return false
  if (isZOrder(a)) return zOrderForm(casing, fields, a) === zOrderForm(casing, fields, b)
  const schema = DynamoSchema.make({ name: "form", version: 1, casing })
  const standIns = new Map<string, string>()
  return (
    textForm(schema, entityType, fields, standIns, a) ===
    textForm(schema, entityType, fields, standIns, b)
  )
}

/** Every pair of halves in one attribute with a sharded index among them. */
const sharedHalves = (
  indexes: Readonly<Record<string, IndexDefinition>>,
): ReadonlyArray<readonly [KeyHalf, KeyHalf]> => {
  const halves = Object.entries(indexes).flatMap(
    ([owner, index]): ReadonlyArray<KeyHalf> => [
      { owner, half: "pk", index, field: index.pk.field },
      { owner, half: "sk", index, field: index.sk.field },
    ],
  )
  return halves.flatMap((a, i) =>
    halves
      .slice(i + 1)
      .filter(
        (b) =>
          a.field === b.field && (a.index.shards !== undefined || b.index.shards !== undefined),
      )
      .map((b) => [a, b] as const),
  )
}

const refusal = (
  entityType: string,
  a: KeyHalf,
  b: KeyHalf,
  casing: DynamoSchema.Casing | undefined,
): Error => {
  const sharded = [a, b].find((half) => shardForm(half) !== undefined)
  const casingA = a.index.casing ?? casing
  const casingB = b.index.casing ?? casing
  const why =
    shardForm(a) !== shardForm(b)
      ? `${describe(sharded!)} holds a shard marker, and is sharded differently from anything ` +
        `else in that attribute`
      : isZOrder(a) !== isZOrder(b)
        ? "one is a binary Z-order address and the other text"
        : casingA !== undefined && casingB !== undefined && casingA !== casingB
          ? `they compose with the casings "${casingA}" and "${casingB}"`
          : isZOrder(a)
            ? "their Z-order layouts differ"
            : "they compose different composites or text"
  return new Error(
    `[EDD-9106] Entity "${entityType}": ${describe(a)} and ${describe(b)} are both stored in the ` +
      `attribute "${a.field}", and aren't provably the same text: ${why}. The one written last ` +
      `overwrites the other, so an item would be unreachable through the other key. Give each ` +
      `its own attribute.`,
  )
}

const CASINGS: ReadonlyArray<DynamoSchema.Casing> = ["lowercase", "uppercase", "preserve"]

/**
 * `Entity.make`, which knows no schema: refuse what no schema can reconcile. Two halves
 * that differ only by a casing one of them leaves to the schema wait for `Table.make`.
 */
export const refuseSharedKeyAttributeOnEverySchema = (
  entityType: string,
  indexes: Readonly<Record<string, IndexDefinition>>,
  fields: Fields,
): void => {
  for (const [a, b] of sharedHalves(indexes)) {
    if (!CASINGS.some((casing) => composeTheSame(casing, entityType, fields, a, b))) {
      throw refusal(entityType, a, b, undefined)
    }
  }
}

/**
 * `Table.make`, which knows the schema, and so what a casing left to it resolves to. An
 * entity registered on two tables is judged by each table's schema.
 */
export const refuseSharedKeyAttribute = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  indexes: Readonly<Record<string, IndexDefinition>>,
  fields: Fields,
): void => {
  for (const [a, b] of sharedHalves(indexes)) {
    if (!composeTheSame(schema.casing, entityType, fields, a, b)) {
      throw refusal(entityType, a, b, schema.casing)
    }
  }
}
