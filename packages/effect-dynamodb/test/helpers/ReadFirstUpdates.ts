/**
 * The updates that read the row and apply `.subtract()`, `.append()`, `.add()` and
 * `.deleteFromSet()` to it, where any other update sends them as an expression for DynamoDB to
 * apply (#236): a retained entity's, one changing a unique field, and one computing an index
 * composite (a record operation on it). Each is the entity's configuration and what the update
 * does besides the operation under test; the same update of an entity without the configuration
 * is sent as an expression.
 */

export interface ReadFirstUpdate {
  readonly name: string
  /** Added to the entity's definition. */
  readonly entity: Record<string, unknown>
  /** What the update does besides the operation under test. */
  readonly prefix: (update: any) => any
  /**
   * Whether the update may hold a path operation too: a retained one sends it in its
   * transaction; one changing a unique field or computing an index composite refuses it.
   */
  readonly takesPathOps: boolean
}

/** The model fields the configurations use: `email` and `rank`, both optional, and `name`. */
export const READ_FIRST: ReadonlyArray<ReadFirstUpdate> = [
  {
    name: "a retained entity",
    entity: { versioned: { retain: true } },
    prefix: (u) => u,
    takesPathOps: true,
  },
  {
    name: "a unique field changed",
    entity: { unique: { email: ["email"] } },
    prefix: (u) => u.set({ email: "b" }),
    takesPathOps: false,
  },
  {
    name: "an index composite computed",
    entity: {
      indexes: {
        byRank: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["name"] },
          sk: { field: "gsi1sk", composite: ["rank"] },
        },
      },
    },
    prefix: (u) => u.add({ rank: 1 }),
    takesPathOps: false,
  },
]
