/**
 * Stored rows as text for comparing tables, every attribute's full typed value included: two rows
 * give the same text exactly when they hold the same attributes with the same types and values.
 * Attribute order and a set's member order don't matter (DynamoDB keeps neither); everything else
 * does, a number's text and a list's order included. `StoredRows.test.ts` checks it tells apart
 * rows differing in one key character, one value, one type or one missing attribute.
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb"

type Row = Record<string, AttributeValue | undefined>

const bytes = (value: Uint8Array): string => `[${Array.from(value).join(",")}]`

/** One attribute value as typed text: its type, then its content, recursively. */
export const valueText = (value: AttributeValue): string => {
  if (value.S !== undefined) return `S${JSON.stringify(value.S)}`
  if (value.N !== undefined) return `N${JSON.stringify(value.N)}`
  if (value.B !== undefined) return `B${bytes(value.B)}`
  if (value.BOOL !== undefined) return `BOOL${value.BOOL}`
  if (value.NULL !== undefined) return `NULL${value.NULL}`
  if (value.SS !== undefined) return `SS[${value.SS.map((s) => JSON.stringify(s)).sort()}]`
  if (value.NS !== undefined) return `NS[${value.NS.map((n) => JSON.stringify(n)).sort()}]`
  if (value.BS !== undefined) return `BS[${value.BS.map(bytes).sort()}]`
  if (value.L !== undefined) return `L[${value.L.map(valueText).join(",")}]`
  if (value.M !== undefined) return `M${rowText(value.M)}`
  throw new Error(`StoredRows: an attribute value of no known type: ${JSON.stringify(value)}`)
}

/** One row as text: each attribute by name, with its typed value. */
export const rowText = (row: Row): string =>
  `{${Object.keys(row)
    .filter((name) => row[name] !== undefined)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${valueText(row[name]!)}`)
    .join(",")}}`

/** A table's rows as text, in an order of their own. */
export const storedRows = (rows: Iterable<Row>): ReadonlyArray<string> =>
  [...rows].map(rowText).sort()
