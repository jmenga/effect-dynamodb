/**
 * What an entity's key definitions may not do (#183).
 *
 * `[EDD-9106]`: two key halves of one entity stored in one attribute (D61). A row can't
 * show which of them owns the attribute: whichever is written last overwrites the other,
 * and a later update corrupts a row that only ever used one. So they may share it only with
 * the same fields, in the same order and casing, and a shard marker only with the same marker.
 * One rule composes every key's values (`KeyComposer.keyText`), so such halves build the
 * same text whichever role each plays: an inverted index needs no case of its own. The
 * check runs per entity, so one index overloaded across entity types is unaffected.
 *
 * `[EDD-9108]`: one entity using one physical index twice. An item has one key in an index,
 * so the second accessor can't have one of its own.
 */

import * as DynamoSchema from "../DynamoSchema.js"
import {
  composePk,
  composeSk,
  type IndexDefinition,
  isZOrderHalf,
  unshardedView,
} from "../KeyComposer.js"

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

/** The hash a sharded partition key's marker depends on; nothing on any other half. */
const shardForm = ({ half, index }: KeyHalf): string | undefined =>
  half === "pk" && index.shards !== undefined
    ? JSON.stringify([index.shards.count, index.shards.source])
    : undefined

/**
 * A half's fields in order, and the label a collection or its absence gives the key. The
 * fields alone can't say: an isolated collection's sort key and a plain one, over the same
 * fields, compose different text. So this composes each value as a stand-in, through the
 * composers, so it can't drift from them. A stand-in is unique to the exact field (`tenant`
 * and `Tenant` have one label between them, and different values).
 */
const textForm = (
  schema: DynamoSchema.DynamoSchema,
  entityType: string,
  standIns: Map<string, string>,
  { half, index }: KeyHalf,
): string => {
  const record: Record<string, string> = {}
  for (const attr of half === "pk" ? index.pk.composite : index.sk.composite) {
    if (!standIns.has(attr)) standIns.set(attr, String.fromCharCode(0xe000 + standIns.size))
    record[attr] = standIns.get(attr)!
  }
  return half === "pk"
    ? composePk(schema, entityType, unshardedView(index), record)
    : composeSk(schema, entityType, 1, index, record)
}

/** A Z-order half's fields: each prefix composite with its hash, and every dimension's options. */
const zOrderForm = ({ index }: KeyHalf): string => {
  if (!isZOrderHalf(index.sk)) return ""
  const { prefix, dimensions } = index.sk.zorderHalf
  return JSON.stringify({
    prefix: prefix.map(({ field, hash }) => ({ field, hash: hash ?? null })),
    // A date's `from` is held normalized, so two spellings of one instant are the same.
    dimensions,
  })
}

/** Do two halves have the same fields, order and casing, under this schema casing? */
const sameDefinition = (
  casing: DynamoSchema.Casing,
  entityType: string,
  a: KeyHalf,
  b: KeyHalf,
): boolean => {
  if ((a.index.casing ?? casing) !== (b.index.casing ?? casing)) return false
  if (isZOrder(a) !== isZOrder(b) || shardForm(a) !== shardForm(b)) return false
  if (isZOrder(a)) return zOrderForm(a) === zOrderForm(b)
  const schema = DynamoSchema.make({ name: "form", version: 1, casing })
  const standIns = new Map<string, string>()
  return textForm(schema, entityType, standIns, a) === textForm(schema, entityType, standIns, b)
}

/** Every pair of an entity's key halves stored in one attribute. */
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
      .filter((b) => a.field === b.field)
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
          ? `they have the casings "${casingA}" and "${casingB}"`
          : isZOrder(a)
            ? "their Z-order layouts differ"
            : "they have different fields, a different order, or a collection's different label"
  return new Error(
    `[EDD-9106] Entity "${entityType}": ${describe(a)} and ${describe(b)} are both stored in the ` +
      `attribute "${a.field}", but ${why}. Two key halves may share an attribute only with the ` +
      `same fields, in the same order and casing, and a sharded partition key only with one ` +
      `sharded the same way. ` +
      `A row can't show which half owns the attribute: the one written last overwrites the ` +
      `other, and an update corrupts even a row that only used one, so an item would be ` +
      `unreachable through the other key. Give each its own attribute.`,
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
): void => {
  for (const [a, b] of sharedHalves(indexes)) {
    if (!CASINGS.some((casing) => sameDefinition(casing, entityType, a, b))) {
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
): void => {
  for (const [a, b] of sharedHalves(indexes)) {
    if (!sameDefinition(schema.casing, entityType, a, b)) {
      throw refusal(entityType, a, b, schema.casing)
    }
  }
}

/**
 * `[EDD-9108]`: `Entity.make` refuses one entity naming one physical index twice, even over
 * the same fields. Different entities sharing an index stay fine.
 */
export const refuseRepeatedIndex = (
  entityType: string,
  indexes: Readonly<Record<string, IndexDefinition>>,
): void => {
  const seen = new Map<string, string>()
  for (const [owner, index] of Object.entries(indexes)) {
    if (index.index === undefined) continue
    const first = seen.get(index.index)
    if (first !== undefined) {
      throw new Error(
        `[EDD-9108] Entity "${entityType}": indexes "${first}" and "${owner}" both use the ` +
          `physical index "${index.index}". One entity can use a physical index once: an item ` +
          `has one key in it, so the second accessor couldn't have its own. Give each its own ` +
          `index. Different entities can share one.`,
      )
    }
    seen.set(index.index, owner)
  }
}
