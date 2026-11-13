import type { AttributeValue } from "@aws-sdk/client-dynamodb"

/** The most characters DynamoDB accepts in one PartiQL statement. */
export const STATEMENT_MAX_LENGTH = 8192

/**
 * @internal The PartiQL `INSERT` of one marshalled item (`Entity.insert`, #189).
 *
 * Every value is a parameter. The attribute names are inline, because DynamoDB
 * rejects a whole item as one parameter (`VALUE ?`), so an item's names count
 * towards {@link STATEMENT_MAX_LENGTH}.
 */
export const insertStatement = (
  tableName: string,
  item: Readonly<Record<string, AttributeValue>>,
): {
  readonly Statement: string
  readonly Parameters: Array<AttributeValue>
} => {
  const names = Object.keys(item)
  const attributes = names.map((name) => `'${name.replaceAll("'", "''")}': ?`).join(", ")
  return {
    Statement: `INSERT INTO "${tableName}" VALUE {${attributes}}`,
    Parameters: names.map((name) => item[name] as AttributeValue),
  }
}
