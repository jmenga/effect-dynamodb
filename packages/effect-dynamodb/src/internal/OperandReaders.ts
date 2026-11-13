/**
 * An update's operand where a row's read decides exactly what reads it back (#236).
 *
 * `pathSet`, `pathIfNotExists`, `pathAppend`, `pathPrepend` and `.append()` write a value, or list
 * elements, below a field. Where the operand lands, the walk of the field's read schema
 * (`readersAt`) names what decodes it there, or says it can't tell. Where it can't, the operand is
 * sent as 1.40.0 sent it, refused only where 1.40.0 refused it. Where it can:
 *
 * - what 1.40.0 sent is sent when one of those readers reads it back as stored;
 * - otherwise no row holding it reads, and the operand is written in another form only where that
 *   form is the one stored value the readers read back (the caller's operand encoded by the
 *   model at that position, or by a reader there);
 * - and refused when there's none, or the readers would store it differently.
 *
 * Only a schema issue is an answer: a reader or encoder that can't finish synchronously (an
 * asynchronous step, a defect) says nothing of the value, and the operand is sent as 1.40.0 sent
 * it (`SchemaIssue.issueOf`). An operand 1.40.0 stored as a row that reads is never refused or
 * written otherwise. Nor is one holding a part behind a getter (`LostValues.holdsMarked`): reading
 * it back would call the getter once more than 1.40.0 called it.
 */

import { holdsMarked } from "@effect-dynamodb/schema/internal/LostValues.js"
import type { OperandKind } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import { CANT_SAY, type CantSay, issueOf } from "@effect-dynamodb/schema/internal/SchemaIssue.js"
import { Exit, Schema, type SchemaAST } from "effect"
import { toAttributeValue } from "../Marshaller.js"
import { asRead } from "./RoundTrip.js"

/** What an operand is written as, and the issue that refuses it (`undefined`: it's written). */
export type OperandVerdict = { readonly encoded: unknown; readonly issue: unknown }

/**
 * A reader's verdict on a value as a read returns it: `undefined` when it decodes, the issue when
 * it refuses it, {@link CANT_SAY} when it can't finish synchronously.
 */
type Reader = (read: unknown) => unknown

/** An encoder's form of a value: `undefined` on a schema issue, {@link CANT_SAY} when it can't finish. */
type Encoder = (value: unknown) => { readonly form: unknown } | CantSay | undefined

const readers = new WeakMap<SchemaAST.AST, Reader>()
const encoders = new WeakMap<SchemaAST.AST, Encoder>()

const readerOf = (ast: SchemaAST.AST): Reader => {
  const known = readers.get(ast)
  if (known !== undefined) return known
  const decode = Schema.decodeUnknownExit(Schema.make<Schema.Codec<unknown>>(ast))
  const reader: Reader = (read) => issueOf(() => decode(read))
  readers.set(ast, reader)
  return reader
}

const encoderOf = (ast: SchemaAST.AST): Encoder => {
  const known = encoders.get(ast)
  if (known !== undefined) return known
  const encode = Schema.encodeUnknownExit(Schema.make<Schema.Codec<unknown>>(ast))
  const encoder: Encoder = (value) => {
    let exit: Exit.Exit<unknown, unknown> | undefined
    const issue = issueOf(() => {
      exit = encode(value)
      return exit
    })
    if (issue === CANT_SAY) return CANT_SAY
    return exit !== undefined && Exit.isSuccess(exit) ? { form: exit.value } : undefined
  }
  encoders.set(ast, encoder)
  return encoder
}

/** A value as a read returns it, or nothing for one that can't be stored. */
const readBack = (stored: unknown): { readonly read: unknown } | undefined => {
  try {
    return { read: asRead(stored) }
  } catch {
    return undefined
  }
}

/** The stored bytes of a value, to tell two forms apart; `undefined` for one that can't be stored. */
const storedBytes = (stored: unknown): string | undefined => {
  try {
    return JSON.stringify(toAttributeValue(stored), (_key, held) =>
      held instanceof Uint8Array ? [...held] : held,
    )
  } catch {
    return undefined
  }
}

/**
 * The issue that refuses a value as read where `readers` read it, `undefined` when one of them
 * reads it, and {@link CANT_SAY} when none refuses it for certain. For elements, each element is
 * read by one of them; an element refused for certain refuses the list, and a value that isn't a
 * list is DynamoDB's to refuse.
 */
const verdictOf = (readers: ReadonlyArray<Reader>, kind: OperandKind, read: unknown): unknown => {
  const one = (value: unknown): unknown => {
    let first: unknown
    let cantSay = false
    for (const reader of readers) {
      const issue = reader(value)
      if (issue === undefined) return undefined
      if (issue === CANT_SAY) cantSay = true
      else first ??= issue
    }
    return cantSay ? CANT_SAY : first
  }
  if (kind === "value") return one(read)
  if (!Array.isArray(read)) return undefined
  let cantSay = false
  for (const element of read) {
    const issue = one(element)
    if (issue === CANT_SAY) cantSay = true
    else if (issue !== undefined) return issue
  }
  return cantSay ? CANT_SAY : undefined
}

/**
 * The caller's operand encoded by one reader (for elements, every element by it): none on a
 * schema issue, {@link CANT_SAY} when the encoder can't finish.
 */
const encodedBy = (
  ast: SchemaAST.AST,
  kind: OperandKind,
  value: unknown,
): ReadonlyArray<unknown> | CantSay => {
  const encode = encoderOf(ast)
  if (kind === "value") {
    const encoded = encode(value)
    return encoded === CANT_SAY ? CANT_SAY : encoded === undefined ? [] : [encoded.form]
  }
  if (!Array.isArray(value)) return []
  const out: Array<unknown> = []
  for (const element of value) {
    const encoded = encode(element)
    if (encoded === CANT_SAY) return CANT_SAY
    if (encoded === undefined) return []
    out.push(encoded.form)
  }
  return [out]
}

/**
 * The operand where `positions` read it (see the module comment). `sent` is what 1.40.0 sends,
 * already past every check 1.40.0 made; `modelled` is the operand encoded by the model at the
 * position it's read back at, where that isn't how `sent` was made ({@link CANT_SAY} when that
 * encoding can't finish).
 */
export const judgeOperand = (
  positions: ReadonlyArray<SchemaAST.AST>,
  kind: OperandKind,
  value: unknown,
  sent: unknown,
  modelled: () => ReadonlyArray<unknown> | CantSay,
): OperandVerdict => {
  // A part behind a getter is called as the marshaller calls it, as often as 1.40.0 called it
  // (`readJudged`): reading it back here would call it once more, so it's sent as 1.40.0 sent it.
  if (holdsMarked(sent)) return { encoded: sent, issue: undefined }
  const reading = positions.map(readerOf)
  const asSent = readBack(sent)
  // What can't be stored at all is the marshalling's to refuse, in its own words.
  if (asSent === undefined) return { encoded: sent, issue: undefined }
  const refused = verdictOf(reading, kind, asSent.read)
  // Read back, or nothing can be said of it: sent as 1.40.0 sent it.
  if (refused === undefined || refused === CANT_SAY) return { encoded: sent, issue: undefined }
  // No row holding what 1.40.0 sent reads. The one stored form the readers read back, if any;
  // where a form can't be computed, there's no telling it's the one, and the operand is refused.
  const forms = [modelled(), ...positions.map((ast) => encodedBy(ast, kind, value))]
  const taken = new Map<string, unknown>()
  const sentBytes = storedBytes(sent)
  for (const form of forms.includes(CANT_SAY)
    ? []
    : (forms as Array<ReadonlyArray<unknown>>).flat()) {
    const bytes = storedBytes(form)
    if (bytes === undefined || bytes === sentBytes || taken.has(bytes)) continue
    const read = readBack(form)
    if (read !== undefined && verdictOf(reading, kind, read.read) === undefined)
      taken.set(bytes, form)
  }
  if (taken.size === 1) return { encoded: [...taken.values()][0], issue: undefined }
  return {
    encoded: sent,
    issue:
      taken.size === 0
        ? refused
        : "The value has no one stored form here: the members of the union at its path " +
          "would store it differently, and as given none of them reads it back.",
  }
}
