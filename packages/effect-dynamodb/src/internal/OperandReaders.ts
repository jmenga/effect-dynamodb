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
 * An operand 1.40.0 stored as a row that reads is never refused or written otherwise.
 */

import type { OperandKind } from "@effect-dynamodb/schema/internal/SchemaAccessors.js"
import { Exit, Schema, type SchemaAST } from "effect"
import { toAttributeValue } from "../Marshaller.js"
import { asRead } from "./RoundTrip.js"

/** What an operand is written as, and the issue that refuses it (`undefined`: it's written). */
export type OperandVerdict = { readonly encoded: unknown; readonly issue: unknown }

/** A reader's verdict on a value as a read returns it: `undefined` when it decodes. */
type Reader = (read: unknown) => unknown

const readers = new WeakMap<SchemaAST.AST, Reader>()
const encoders = new WeakMap<SchemaAST.AST, (value: unknown) => Exit.Exit<unknown, unknown>>()

const readerOf = (ast: SchemaAST.AST): Reader => {
  const known = readers.get(ast)
  if (known !== undefined) return known
  const decode = Schema.decodeUnknownExit(Schema.make<Schema.Codec<unknown>>(ast))
  const reader: Reader = (read) => {
    try {
      const exit = decode(read)
      return Exit.isSuccess(exit) ? undefined : exit.cause
    } catch (defect) {
      return defect
    }
  }
  readers.set(ast, reader)
  return reader
}

const encoderOf = (ast: SchemaAST.AST) => {
  const known = encoders.get(ast)
  if (known !== undefined) return known
  const encode = Schema.encodeUnknownExit(Schema.make<Schema.Codec<unknown>>(ast))
  const encoder = (value: unknown): Exit.Exit<unknown, unknown> => {
    try {
      return encode(value)
    } catch (defect) {
      return Exit.die(defect)
    }
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
 * reads it. For elements, each element is read by one of them, and a value that isn't a list is
 * DynamoDB's to refuse.
 */
const issueOf = (readers: ReadonlyArray<Reader>, kind: OperandKind, read: unknown): unknown => {
  const one = (value: unknown): unknown => {
    let first: unknown
    for (const [i, reader] of readers.entries()) {
      const issue = reader(value)
      if (issue === undefined) return undefined
      if (i === 0) first = issue
    }
    return first
  }
  if (kind === "value") return one(read)
  if (!Array.isArray(read)) return undefined
  for (const element of read) {
    const issue = one(element)
    if (issue !== undefined) return issue
  }
  return undefined
}

/** The caller's operand encoded by one reader: for elements, every element by it. */
const encodedBy = (ast: SchemaAST.AST, kind: OperandKind, value: unknown): unknown[] => {
  const encode = encoderOf(ast)
  if (kind === "value") {
    const exit = encode(value)
    return Exit.isSuccess(exit) ? [exit.value] : []
  }
  if (!Array.isArray(value)) return []
  const out: Array<unknown> = []
  for (const element of value) {
    const exit = encode(element)
    if (!Exit.isSuccess(exit)) return []
    out.push(exit.value)
  }
  return [out]
}

/**
 * The operand where `positions` read it (see the module comment). `sent` is what 1.40.0 sends,
 * already past every check 1.40.0 made; `modelled` is the operand encoded by the model at the
 * position it's read back at, where that isn't how `sent` was made.
 */
export const judgeOperand = (
  positions: ReadonlyArray<SchemaAST.AST>,
  kind: OperandKind,
  value: unknown,
  sent: unknown,
  modelled: () => ReadonlyArray<unknown>,
): OperandVerdict => {
  const reading = positions.map(readerOf)
  const asSent = readBack(sent)
  // What can't be stored at all is the marshalling's to refuse, in its own words.
  if (asSent === undefined) return { encoded: sent, issue: undefined }
  const refused = issueOf(reading, kind, asSent.read)
  if (refused === undefined) return { encoded: sent, issue: undefined }
  // No row holding what 1.40.0 sent reads. The one stored form the readers read back, if any.
  const taken = new Map<string, unknown>()
  const sentBytes = storedBytes(sent)
  for (const form of [...modelled(), ...positions.flatMap((ast) => encodedBy(ast, kind, value))]) {
    const bytes = storedBytes(form)
    if (bytes === undefined || bytes === sentBytes || taken.has(bytes)) continue
    const read = readBack(form)
    if (read !== undefined && issueOf(reading, kind, read.read) === undefined)
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
