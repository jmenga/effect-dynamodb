# Condition & Filter Expressions — API Specification

> **Status:** Draft
> **Scope:** `Teams.condition()`, `Teams.filter()`, `Expr` ADT, expression compilation
> **Related:** [Update Expressions](./update-expressions.md) (shared `PathBuilder`, shared callback pattern)

## 1. Overview

Condition expressions and filter expressions share **identical DynamoDB grammar** — the only difference is where they are used:

| Expression Type | DynamoDB Parameter | Used In | Effect on Failure |
|---|---|---|---|
| `ConditionExpression` | PutItem, UpdateItem, DeleteItem | Fails the write → `ConditionalCheckFailed` |
| `FilterExpression` | Query, Scan | Removes non-matching items from results (post-read) |

Both are exposed as entity-level combinators with a **callback API** consistent with the update expression API:

```typescript
// Condition — on writes (PutItem, UpdateItem, DeleteItem)
Teams.condition((t, { eq }) => eq(t.status, "active"))

// Filter — on queries (Query, Scan)
Teams.filter((t, { eq }) => eq(t.status, "active"))
```

The callback receives:
1. `t` — `PathBuilder<Model>` for type-safe attribute access (same as update combinators)
2. Operations object — comparators, functions, and boolean combinators that return `Expr` nodes

A **shorthand object syntax** is also supported for simple AND-only conditions.

## 2. DynamoDB Grammar Reference

```
condition ::=
    operand comparator operand
  | operand BETWEEN operand AND operand
  | operand IN (operand, operand, ...)        -- up to 100 values
  | function
  | condition AND condition
  | condition OR condition
  | NOT condition
  | ( condition )

comparator ::= = | <> | < | <= | > | >=

operand ::= path | :value | size(path)

function ::=
    attribute_exists(path)
  | attribute_not_exists(path)
  | attribute_type(path, type)
  | begins_with(path, substr)
  | contains(path, operand)
  | size(path)
```

`path` = top-level attribute, nested document path (`map.nested`), or list index (`list[0]`).

### Operator Precedence (highest to lowest)

1. `= <> < <= > >=`
2. `IN`
3. `BETWEEN`
4. `attribute_exists`, `attribute_not_exists`, `begins_with`, `contains`
5. Parentheses
6. `NOT`
7. `AND`
8. `OR`

### FilterExpression Behavior

FilterExpression is applied **after** items are read from disk but **before** results are returned:

- Read capacity is consumed **regardless** of filtering — you pay for all items matched by `KeyConditionExpression`
- The 1MB per-page limit applies **before** filter evaluation
- A page may return zero items but still have a `LastEvaluatedKey` (more pages to scan)
- Filter expressions **cannot** reference partition key or sort key attributes

This means `Teams.filter()` is post-read narrowing. For efficient pre-read narrowing, use sort key conditions (covered in a separate spec).

## 3. Callback API

### 3.1 Signature

Both `Teams.condition()` and `Teams.filter()` accept two overloads:

```typescript
// Callback overload — full grammar
Teams.condition((t, ops) => ops.eq(t.status, "active"))

// Shorthand overload — AND-only, equality-dominant
Teams.condition({ status: "active" })
```

**Discrimination:** first argument is function → callback, object → shorthand.

### 3.2 PathBuilder Parameter

The first callback parameter `t` is `PathBuilder<Model>` — the same proxy type used by update expression path overloads. Attribute access returns typed `Path<Model, V>` objects:

```typescript
Teams.condition((t, { eq }) => {
  t.status         // Path<Team, string>
  t.memberCount    // Path<Team, number>
  t.address.city   // Path<Team, string>
  t.roster.at(0)   // Path<Team, Player>
  t.tags           // Path<Team, string[]>
  return eq(t.status, "active")
})
```

### 3.3 Operations Object

The second callback parameter provides all DynamoDB condition operations:

```typescript
interface ConditionOps<Model> {
  // --- Comparators ---
  eq<V>(left: Path<Model, V>, right: V | Path<Model, V>): Expr
  ne<V>(left: Path<Model, V>, right: V | Path<Model, V>): Expr
  lt<V>(left: Path<Model, V> | SizeOperand, right: V | Path<Model, V>): Expr
  lte<V>(left: Path<Model, V> | SizeOperand, right: V | Path<Model, V>): Expr
  gt<V>(left: Path<Model, V> | SizeOperand, right: V | Path<Model, V>): Expr
  gte<V>(left: Path<Model, V> | SizeOperand, right: V | Path<Model, V>): Expr

  // --- Range & Membership ---
  between<V>(operand: Path<Model, V> | SizeOperand, low: V, high: V): Expr
  in<V>(path: Path<Model, V>, values: ReadonlyArray<V>): Expr

  // --- Functions ---
  exists(path: Path<Model, any>): Expr
  notExists(path: Path<Model, any>): Expr
  type(path: Path<Model, any>, attributeType: DynamoAttributeType): Expr
  beginsWith(path: Path<Model, string>, prefix: string): Expr
  contains<V>(path: Path<Model, string | ReadonlyArray<V> | ReadonlySet<V>>, value: V | string): Expr

  // --- Size (returns numeric operand, not Expr) ---
  size(path: Path<Model, any>): SizeOperand

  // --- Boolean Combinators ---
  and(...conditions: ReadonlyArray<Expr>): Expr
  or(...conditions: ReadonlyArray<Expr>): Expr
  not(condition: Expr): Expr
}

type DynamoAttributeType = "S" | "SS" | "N" | "NS" | "B" | "BS" | "BOOL" | "NULL" | "L" | "M"
```

### 3.4 Operand Discrimination

Operations accept `Path<Model, V>` (attribute reference), literal values, or `SizeOperand`. Discrimination is by runtime type:

| Argument | Has `_tag: "Path"` | Has `_tag: "size"` | Otherwise |
|---|---|---|---|
| `t.status` | Path → `#status` | — | — |
| `t.address.city` | Path → `#address.#city` | — | — |
| `"active"` | — | — | Literal → `:v0` |
| `42` | — | — | Literal → `:v0` |
| `size(t.tags)` | — | SizeOperand → `size(#tags)` | — |

This means attribute-to-attribute comparisons work naturally when both arguments are paths:

```typescript
// Path vs literal → #status = :v0
eq(t.status, "active")

// Path vs path → #lastFedBy <> #keeper
ne(t.lastFedBy, t.keeper)

// Size vs literal → size(#tags) > :v0
gt(size(t.tags), 3)

// Size vs path → size(#items) > #minItems
gt(size(t.items), t.minItems)
```

## 4. Comparators

Each comparator maps to a DynamoDB comparison operator.

### 4.1 `eq` — Equal (`=`)

```typescript
Teams.condition((t, { eq }) => eq(t.status, "active"))
```

```
ConditionExpression: #p0 = :v0
ExpressionAttributeNames: { "#p0": "status" }
ExpressionAttributeValues: { ":v0": { "S": "active" } }
```

Attribute-to-attribute:

```typescript
Teams.condition((t, { eq }) => eq(t.backupEmail, t.email))
```

```
ConditionExpression: #p0 = #p1
ExpressionAttributeNames: { "#p0": "backupEmail", "#p1": "email" }
```

### 4.2 `ne` — Not Equal (`<>`)

```typescript
Teams.condition((t, { ne }) => ne(t.status, "archived"))
```

```
ConditionExpression: #p0 <> :v0
ExpressionAttributeNames: { "#p0": "status" }
ExpressionAttributeValues: { ":v0": { "S": "archived" } }
```

### 4.3 `lt` — Less Than (`<`)

```typescript
Teams.condition((t, { lt }) => lt(t.age, 18))
```

```
ConditionExpression: #p0 < :v0
ExpressionAttributeNames: { "#p0": "age" }
ExpressionAttributeValues: { ":v0": { "N": "18" } }
```

### 4.4 `lte` — Less Than or Equal (`<=`)

```typescript
Teams.condition((t, { lte }) => lte(t.price, 99.99))
```

```
ConditionExpression: #p0 <= :v0
```

### 4.5 `gt` — Greater Than (`>`)

```typescript
Teams.condition((t, { gt }) => gt(t.score, 100))
```

```
ConditionExpression: #p0 > :v0
```

### 4.6 `gte` — Greater Than or Equal (`>=`)

```typescript
Teams.condition((t, { gte }) => gte(t.rating, 4.5))
```

```
ConditionExpression: #p0 >= :v0
```

## 5. Range & Membership

### 5.1 `between` — Inclusive Range

```typescript
Teams.condition((t, { between }) => between(t.age, 18, 65))
```

```
ConditionExpression: #p0 BETWEEN :v0 AND :v1
ExpressionAttributeNames: { "#p0": "age" }
ExpressionAttributeValues: { ":v0": { "N": "18" }, ":v1": { "N": "65" } }
```

With `size()`:

```typescript
Teams.condition((t, { between, size }) => between(size(t.items), 1, 100))
```

```
ConditionExpression: size(#p0) BETWEEN :v0 AND :v1
```

### 5.2 `in` — Membership Test

Tests whether an attribute equals any value in a list. DynamoDB allows up to 100 values.

```typescript
Teams.condition((t, { in: in_ }) => in_(t.status, ["active", "pending", "review"]))
```

```
ConditionExpression: #p0 IN (:v0, :v1, :v2)
ExpressionAttributeNames: { "#p0": "status" }
ExpressionAttributeValues: { ":v0": { "S": "active" }, ":v1": { "S": "pending" }, ":v2": { "S": "review" } }
```

Note: `in` is a reserved word in JavaScript. Destructure as `{ in: in_ }` in the callback.

## 6. Functions

### 6.1 `exists` — `attribute_exists(path)`

True if the item contains the attribute.

```typescript
Teams.condition((t, { exists }) => exists(t.email))
```

```
ConditionExpression: attribute_exists(#p0)
ExpressionAttributeNames: { "#p0": "email" }
```

Nested path:

```typescript
Teams.condition((t, { exists }) => exists(t.config.features.darkMode))
```

```
ConditionExpression: attribute_exists(#p0.#p1.#p2)
ExpressionAttributeNames: { "#p0": "config", "#p1": "features", "#p2": "darkMode" }
```

### 6.2 `notExists` — `attribute_not_exists(path)`

True if the attribute does not exist.

```typescript
Teams.condition((t, { notExists }) => notExists(t.deletedAt))
```

```
ConditionExpression: attribute_not_exists(#p0)
```

### 6.3 `type` — `attribute_type(path, type)`

True if the attribute is of a particular DynamoDB data type.

```typescript
Teams.condition((t, { type }) => type(t.data, "M"))
Teams.condition((t, { type }) => type(t.score, "N"))
```

```
ConditionExpression: attribute_type(#p0, :v0)
ExpressionAttributeNames: { "#p0": "data" }
ExpressionAttributeValues: { ":v0": { "S": "M" } }
```

Valid types: `S`, `SS`, `N`, `NS`, `B`, `BS`, `BOOL`, `NULL`, `L`, `M`.

### 6.4 `beginsWith` — `begins_with(path, prefix)`

True if the string attribute begins with the given prefix.

```typescript
Teams.condition((t, { beginsWith }) => beginsWith(t.email, "admin@"))
```

```
ConditionExpression: begins_with(#p0, :v0)
ExpressionAttributeNames: { "#p0": "email" }
ExpressionAttributeValues: { ":v0": { "S": "admin@" } }
```

Type constraint: `path` must be `Path<Model, string>`.

### 6.5 `contains` — `contains(path, operand)`

True if:
- A `String` attribute contains the substring
- A `Set` attribute contains the element
- A `List` attribute contains the element

```typescript
// Substring match
Teams.condition((t, { contains }) => contains(t.bio, "engineer"))

// Set/list element match
Teams.condition((t, { contains }) => contains(t.tags, "urgent"))
```

```
ConditionExpression: contains(#p0, :v0)
ExpressionAttributeNames: { "#p0": "tags" }
ExpressionAttributeValues: { ":v0": { "S": "urgent" } }
```

### 6.6 `size` — `size(path)`

Returns a **numeric operand** representing the attribute's size. Not an `Expr` — used as the left-hand side of a comparator.

| Data Type | Returns |
|---|---|
| String | Character length |
| Binary | Byte count |
| Set (SS/NS/BS) | Element count |
| List | Element count |
| Map | Key count |

```typescript
// size(tags) > 3
Teams.condition((t, { gt, size }) => gt(size(t.tags), 3))

// size(name) = 10
Teams.condition((t, { eq, size }) => eq(size(t.name), 10))

// size(items) BETWEEN 1 AND 100
Teams.condition((t, { between, size }) => between(size(t.items), 1, 100))

// size(items) >= minItems (attribute reference)
Teams.condition((t, { gte, size }) => gte(size(t.items), t.minItems))
```

```
ConditionExpression: size(#p0) > :v0
ExpressionAttributeNames: { "#p0": "tags" }
ExpressionAttributeValues: { ":v0": { "N": "3" } }
```

`size()` return type is `SizeOperand`, not `Expr`. It can only be used as the first argument to a comparator (`eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `between`).

## 7. Boolean Combinators

### 7.1 `and` — Logical AND

All conditions must be true. Accepts variadic arguments.

```typescript
Teams.condition((t, { and, eq, exists }) => and(
  eq(t.status, "active"),
  exists(t.email),
))
```

```
ConditionExpression: (#p0 = :v0) AND (attribute_exists(#p1))
```

Three or more:

```typescript
Teams.condition((t, { and, eq, gt, exists }) => and(
  eq(t.status, "active"),
  gt(t.age, 18),
  exists(t.email),
))
```

```
ConditionExpression: (#p0 = :v0) AND (#p1 > :v1) AND (attribute_exists(#p2))
```

### 7.2 `or` — Logical OR

At least one condition must be true. Accepts variadic arguments.

```typescript
Teams.condition((t, { or, eq }) => or(
  eq(t.status, "active"),
  eq(t.status, "pending"),
))
```

```
ConditionExpression: (#p0 = :v0) OR (#p1 = :v1)
```

### 7.3 `not` — Logical NOT

Negates a condition.

```typescript
Teams.condition((t, { not, exists }) => not(exists(t.offspring)))
```

```
ConditionExpression: NOT (attribute_exists(#p0))
```

```typescript
Teams.condition((t, { not, contains }) => not(contains(t.tags, "archived")))
```

```
ConditionExpression: NOT (contains(#p0, :v0))
```

### 7.4 Nested Composition

Boolean combinators compose naturally via nesting. Parentheses are generated automatically based on tree structure.

```typescript
// (A OR B) AND C
Teams.condition((t, { and, or, eq, gt }) => and(
  or(eq(t.dangerous, true), eq(t.isPregnant, true)),
  gt(t.age, 5),
))
```

```
ConditionExpression: ((#p0 = :v0) OR (#p1 = :v1)) AND (#p2 > :v2)
```

```typescript
// A AND (B OR C) AND NOT D
Teams.condition((t, { and, or, eq, gte, exists, not, contains }) => and(
  eq(t.status, "active"),
  or(gte(t.priority, 3), exists(t.escalatedAt)),
  not(contains(t.tags, "muted")),
))
```

```
ConditionExpression: (#p0 = :v0) AND ((#p1 >= :v1) OR (attribute_exists(#p2))) AND (NOT (contains(#p3, :v2)))
```

```typescript
// Complex: (type=admin AND level>=5) OR (type=superuser AND NOT suspended) OR (type=service AND name begins sys- AND has permissions)
Teams.condition((t, { or, and, eq, gte, not, exists, beginsWith, gt, size }) => or(
  and(eq(t.type, "admin"), gte(t.level, 5)),
  and(eq(t.type, "superuser"), not(exists(t.suspended))),
  and(eq(t.type, "service"), beginsWith(t.name, "sys-"), gt(size(t.permissions), 0)),
))
```

```
ConditionExpression:
  ((#p0 = :v0) AND (#p1 >= :v1))
  OR ((#p2 = :v2) AND (NOT (attribute_exists(#p3))))
  OR ((#p4 = :v3) AND (begins_with(#p5, :v4)) AND (size(#p6) > :v5))
```

## 8. Nested Document Paths

All operations support nested attribute access via the `PathBuilder` proxy.

```typescript
// Map attribute
Teams.condition((t, { eq }) => eq(t.address.city, "Melbourne"))
// attribute_exists(#p0.#p1) → names: { "#p0": "address", "#p1": "city" }

// List element
Teams.condition((t, { gt }) => gt(t.scores.at(0), 90))
// #p0[0] > :v0 → names: { "#p0": "scores" }

// Nested in list element
Teams.condition((t, { eq }) => eq(t.roster.at(0).role, "captain"))
// #p0[0].#p1 = :v0 → names: { "#p0": "roster", "#p1": "role" }

// Deep nesting
Teams.condition((t, { exists }) => exists(t.config.features.darkMode))
// attribute_exists(#p0.#p1.#p2)

// Size of nested attribute
Teams.condition((t, { gt, size }) => gt(size(t.user.permissions), 0))
// size(#p0.#p1) > :v0
```

Path compilation follows the same rules as update expressions (see [Update Expressions spec §3.5](./update-expressions.md)).

## 9. Shorthand Object Syntax

For the common case of AND-only conditions with simple comparisons, a plain object can be used instead of a callback.

```typescript
// Plain values → equality
Teams.condition({ status: "active" })
// Expr: eq(status, "active")

// Multiple keys → AND
Teams.condition({ status: "active", region: "APAC" })
// Expr: and(eq(status, "active"), eq(region, "APAC"))

// Operator objects
Teams.condition({ status: { ne: "archived" } })          // ne(status, "archived")
Teams.condition({ age: { gt: 18 } })                     // gt(age, 18)
Teams.condition({ age: { gte: 18 } })                    // gte(age, 18)
Teams.condition({ age: { lt: 65 } })                     // lt(age, 65)
Teams.condition({ age: { lte: 65 } })                    // lte(age, 65)
Teams.condition({ age: { between: [18, 65] } })          // between(age, 18, 65)
Teams.condition({ email: { beginsWith: "admin@" } })     // beginsWith(email, "admin@")
Teams.condition({ tags: { contains: "urgent" } })        // contains(tags, "urgent")
Teams.condition({ email: { exists: true } })             // exists(email)
Teams.condition({ deletedAt: { notExists: true } })      // notExists(deletedAt)
Teams.condition({ status: { in: ["a", "b", "c"] } })    // in(status, ["a", "b", "c"])

// Mixed
Teams.condition({ status: "active", age: { gte: 18 }, email: { exists: true } })
// and(eq(status, "active"), gte(age, 18), exists(email))
```

**Limitations of shorthand:**
- AND only — no OR, NOT, or grouping
- No `size()` comparisons
- No attribute-to-attribute comparisons
- No `attribute_type` checks
- No nested document paths (use callback for `t.address.city`)

For any of the above, use the callback overload.

### Shorthand Type

```typescript
type ConditionShorthand = Record<string, ShorthandValue>

type ShorthandValue =
  | string | number | boolean | null              // equality
  | { ne: unknown }
  | { gt: unknown }
  | { gte: unknown }
  | { lt: unknown }
  | { lte: unknown }
  | { between: [unknown, unknown] }
  | { beginsWith: string }
  | { contains: unknown }
  | { exists: true }
  | { notExists: true }
  | { in: ReadonlyArray<unknown> }
```

## 10. Application

### 10.1 `Teams.condition()` — ConditionExpression on Writes

Applied to PutItem, UpdateItem, and DeleteItem. Fails with `ConditionalCheckFailed` if the condition evaluates to false.

```typescript
// On put
yield* teams.put(data,
  Teams.condition((t, { notExists }) => notExists(t.id)),
)

// On update (composes with other update combinators)
yield* teams.update(
  { id: teamId },
  Teams.set({ status: "quarantine" }),
  Teams.condition((t, { and, or, eq, gt }) => and(
    or(eq(t.dangerous, true), eq(t.isPregnant, true)),
    gt(t.age, 5),
  )),
)

// On delete
yield* teams.delete({ id: teamId },
  Teams.condition((t, { eq }) => eq(t.status, "retired")),
)

// Shorthand on put
yield* teams.put(data,
  Teams.condition({ id: { notExists: true } }),
)
```

**Return type:** Polymorphic combinator applicable to `EntityPut`, `EntityUpdate`, or `EntityDelete`:

```typescript
type ConditionCombinator<Model> = <T extends EntityPut<any, any, any, any> | EntityUpdate<any, any, any, any, any> | EntityDelete<any, any>>(self: T) => T
```

**Multiple `condition()` calls are ANDed together:**

```typescript
yield* teams.update(
  { id: teamId },
  Teams.set({ status: "active" }),
  Teams.condition((t, { eq }) => eq(t.approvedBy, "admin")),
  Teams.condition((t, { exists }) => exists(t.email)),
  // → ConditionExpression: (#approvedBy = :v0) AND (attribute_exists(#email))
)
```

**Interaction with `expectedVersion()`:**

`expectedVersion(n)` adds its own condition (`#ver = :expected`). User conditions are ANDed with the version check:

```typescript
yield* teams.update(
  { id: teamId },
  Teams.set({ status: "active" }),
  Teams.expectedVersion(5),
  Teams.condition((t, { eq }) => eq(t.approvedBy, "admin")),
  // → ConditionExpression: (#__edd_v__ = :expectedVer) AND (#approvedBy = :v0)
)
```

### 10.2 `Teams.filter()` — FilterExpression on Queries

Applied to Query and Scan operations. Filters results after reading from DynamoDB (does NOT reduce read capacity).

```typescript
// On query
yield* teams.collect(
  Teams.query.byRegion({ region: "APAC" }),
  Teams.filter((t, { eq }) => eq(t.status, "active")),
)

// On scan
yield* teams.collect(
  Teams.scan(),
  Teams.filter((t, { and, gte, not, contains }) => and(
    gte(t.memberCount, 5),
    not(contains(t.tags, "suspended")),
  )),
)

// Shorthand
yield* teams.collect(
  Teams.query.byRegion({ region: "APAC" }),
  Teams.filter({ status: "active", memberCount: { gte: 5 } }),
)
```

**Return type:** Query combinator:

```typescript
type FilterCombinator<Model> = <A>(self: Query<A>) => Query<A>
```

**Multiple `filter()` calls are ANDed together:**

```typescript
yield* teams.collect(
  Teams.query.byRegion({ region: "APAC" }),
  Teams.filter((t, { eq }) => eq(t.status, "active")),
  Teams.filter((t, { gte }) => gte(t.memberCount, 5)),
  // → FilterExpression: (#status = :v0) AND (#memberCount >= :v1)
)
```

**Composes with sort key conditions and other query combinators:**

```typescript
yield* teams.collect(
  Teams.query.byRegion({ region: "APAC" }),
  Query.begins({ status: "active" }),               // KeyConditionExpression (pre-read, efficient)
  Teams.filter((t, { gte }) => gte(t.rating, 4)),   // FilterExpression (post-read)
  Query.reverse,
  Query.limit(25),
)
```

### 10.3 Restriction: No PK/SK in FilterExpression

DynamoDB does not allow partition key or sort key attributes in `FilterExpression`. The expression compiler should validate this and raise a `ValidationError` if a filter references a key attribute.

## 11. Expr ADT

The callback operations build an `Expr` tree. This is the internal representation compiled to DynamoDB expression strings.

### 11.1 Type Definition

```typescript
type Expr =
  // Comparators
  | { readonly _tag: "eq"; readonly left: Operand; readonly right: Operand }
  | { readonly _tag: "ne"; readonly left: Operand; readonly right: Operand }
  | { readonly _tag: "lt"; readonly left: Operand; readonly right: Operand }
  | { readonly _tag: "lte"; readonly left: Operand; readonly right: Operand }
  | { readonly _tag: "gt"; readonly left: Operand; readonly right: Operand }
  | { readonly _tag: "gte"; readonly left: Operand; readonly right: Operand }
  // Range & membership
  | { readonly _tag: "between"; readonly operand: Operand; readonly low: Operand; readonly high: Operand }
  | { readonly _tag: "in"; readonly operand: Operand; readonly values: ReadonlyArray<unknown> }
  // Functions
  | { readonly _tag: "exists"; readonly path: PathSegments }
  | { readonly _tag: "notExists"; readonly path: PathSegments }
  | { readonly _tag: "type"; readonly path: PathSegments; readonly attributeType: DynamoAttributeType }
  | { readonly _tag: "beginsWith"; readonly path: PathSegments; readonly prefix: string }
  | { readonly _tag: "contains"; readonly path: PathSegments; readonly value: unknown }
  // Boolean
  | { readonly _tag: "and"; readonly conditions: ReadonlyArray<Expr> }
  | { readonly _tag: "or"; readonly conditions: ReadonlyArray<Expr> }
  | { readonly _tag: "not"; readonly condition: Expr }

type Operand =
  | { readonly _tag: "path"; readonly segments: PathSegments }
  | { readonly _tag: "value"; readonly value: unknown }
  | { readonly _tag: "size"; readonly segments: PathSegments }

type PathSegments = ReadonlyArray<string | number>

type SizeOperand = { readonly _tag: "size"; readonly segments: PathSegments }
```

### 11.2 Standalone Constructors

For generic/library code that doesn't have a typed entity context, standalone `Expr.*` constructors are also available. These accept string attribute names instead of `Path` objects:

```typescript
import { Expr } from "effect-dynamodb"

Expr.eq("status", "active")
Expr.and(Expr.gt("age", 18), Expr.exists("email"))
Expr.or(Expr.eq("region", "APAC"), Expr.eq("region", "EMEA"))
Expr.gt(Expr.size("tags"), 3)
Expr.ne(Expr.ref("lastFedBy"), Expr.ref("keeper"))
```

These are untyped — no attribute name validation or value type checking. Prefer entity-level `Teams.condition()` / `Teams.filter()` callbacks for application code.

## 12. Expression Compilation

### 12.1 Compiler Input

The compiler receives an `Expr` tree and produces:

```typescript
interface CompiledExpression {
  readonly expression: string
  readonly names: Record<string, string>
  readonly values: Record<string, AttributeValue>
}
```

### 12.2 Compilation Rules

| Expr Node | Output Template |
|---|---|
| `eq` | `<left> = <right>` |
| `ne` | `<left> <> <right>` |
| `lt` | `<left> < <right>` |
| `lte` | `<left> <= <right>` |
| `gt` | `<left> > <right>` |
| `gte` | `<left> >= <right>` |
| `between` | `<operand> BETWEEN <low> AND <high>` |
| `in` | `<operand> IN (:v0, :v1, ...)` |
| `exists` | `attribute_exists(<path>)` |
| `notExists` | `attribute_not_exists(<path>)` |
| `type` | `attribute_type(<path>, :vN)` |
| `beginsWith` | `begins_with(<path>, :vN)` |
| `contains` | `contains(<path>, :vN)` |
| `and` | `(<c1>) AND (<c2>) AND ...` |
| `or` | `(<c1>) OR (<c2>) OR ...` |
| `not` | `NOT (<c>)` |

Operand compilation:

| Operand | Output | Names/Values |
|---|---|---|
| `{ _tag: "path", segments: ["status"] }` | `#p0` | `names["#p0"] = "status"` |
| `{ _tag: "path", segments: ["address", "city"] }` | `#p0.#p1` | `names["#p0"] = "address"`, `names["#p1"] = "city"` |
| `{ _tag: "path", segments: ["scores", 0] }` | `#p0[0]` | `names["#p0"] = "scores"` |
| `{ _tag: "value", value: "active" }` | `:v0` | `values[":v0"] = { "S": "active" }` |
| `{ _tag: "size", segments: ["tags"] }` | `size(#p0)` | `names["#p0"] = "tags"` |

### 12.3 Parenthesization

Boolean combinators (`and`, `or`, `not`) always wrap child conditions in parentheses. This ensures correct evaluation regardless of DynamoDB's operator precedence:

```typescript
// and(or(a, b), c) →
// ((a) OR (b)) AND (c)
// Not: a OR b AND c (which would evaluate as a OR (b AND c))
```

### 12.4 Name/Value Counter

A shared counter allocates unique placeholder keys across the entire expression:

- Path names: `#p0`, `#p1`, `#p2`, ...
- Values: `:v0`, `:v1`, `:v2`, ...

The counter is scoped to a single compilation call — no global state.

## 13. Type Safety

### 13.1 Value Type Checking

The `V` type parameter on comparator operations ensures values match the attribute type:

```typescript
// t.status is Path<Team, string>
eq(t.status, "active")     // ✅ V = string, "active" is string
eq(t.status, 123)          // ❌ V = string, 123 is number

// t.memberCount is Path<Team, number>
gt(t.memberCount, 5)       // ✅ V = number
gt(t.memberCount, "five")  // ❌ V = number, "five" is string

// Attribute-to-attribute: both must be same V
eq(t.email, t.backupEmail) // ✅ both Path<Team, string>
gt(t.name, t.age)          // ❌ string ≠ number
```

### 13.2 Function Constraints

```typescript
// beginsWith: path must be string
beginsWith(t.email, "admin@")   // ✅ Path<Team, string>
beginsWith(t.age, "1")          // ❌ Path<Team, number>

// contains: path must be string, array, or set
contains(t.bio, "engineer")     // ✅ string contains substring
contains(t.tags, "urgent")      // ✅ array contains element
contains(t.age, 5)              // ❌ number is not searchable

// size: returns SizeOperand, only usable in comparators
gt(size(t.tags), 3)             // ✅
and(size(t.tags), eq(...))      // ❌ size is not Expr
```

### 13.3 Shorthand — No Type Checking

The shorthand object syntax uses string attribute names — no compile-time type checking on attribute names or value types. Runtime validation catches mismatches when the expression is compiled against the entity schema.

## 14. Migration from Current API

| Current | Proposed | Notes |
|---|---|---|
| `Entity.condition({ eq: { status: "active" } })` | `Teams.condition((t, { eq }) => eq(t.status, "active"))` | Typed, nested paths |
| `Entity.condition({ eq: { status: "active" }, attributeExists: "email" })` | `Teams.condition((t, { and, eq, exists }) => and(eq(t.status, "active"), exists(t.email)))` | Explicit AND |
| `Entity.condition({ attributeExists: "email" })` | `Teams.condition((t, { exists }) => exists(t.email))` | Simpler |
| `Entity.condition({ attributeNotExists: "deletedAt" })` | `Teams.condition((t, { notExists }) => notExists(t.deletedAt))` | Simpler |
| `Query.filter({ status: "active" })` | `Teams.filter((t, { eq }) => eq(t.status, "active"))` | Entity-scoped |
| `Query.filter({ priority: { gte: 3 } })` | `Teams.filter((t, { gte }) => gte(t.priority, 3))` | Typed |
| N/A (not possible) | `Teams.condition((t, { or, eq }) => or(eq(t.a, 1), eq(t.b, 2)))` | OR support |
| N/A (not possible) | `Teams.condition((t, { not, exists }) => not(exists(t.f)))` | NOT support |
| N/A (not possible) | `Teams.condition((t, { in: in_ }) => in_(t.status, ["a", "b"]))` | IN support |
| N/A (not possible) | `Teams.condition((t, { gt, size }) => gt(size(t.tags), 3))` | size() support |
| N/A (not possible) | `Teams.condition((t, { ne }) => ne(t.fieldA, t.fieldB))` | Attr-to-attr |
| N/A (not possible) | `Teams.condition((t, { type }) => type(t.data, "M"))` | type() support |
| `Query.where({ beginsWith: prefix })` | See key condition expressions spec | Separate spec |

`Entity.condition(input)` and `Query.filter(conditions)` accept `ConditionInput` objects for generic or dynamic conditions. `ConditionInput` shorthand is also accepted by `Teams.condition()` as the object overload.

## 15. Full Example

```typescript
const { Teams: teams } = yield* DynamoClient.make(MainTable)

// --- PutItem with condition ---
yield* teams.put(newTeam,
  Teams.condition((t, { notExists }) => notExists(t.id)),
)

// --- UpdateItem with complex condition ---
yield* teams.update(
  { id: teamId },
  Teams.set({ status: "quarantine" }),
  Teams.set((t) => t.address.city, "Melbourne"),
  Teams.add({ incidentCount: 1 }),
  Teams.condition((t, { and, or, eq, gt, size }) => and(
    or(eq(t.dangerous, true), gt(size(t.incidents), 3)),
    eq(t.address.country, "AU"),
  )),
  Teams.expectedVersion(12),
)
// ConditionExpression:
//   (#__edd_v__ = :expectedVer)
//   AND (((#dangerous = :v0) OR (size(#incidents) > :v1)) AND (#address.#country = :v2))

// --- DeleteItem with OR condition ---
yield* teams.delete({ id: teamId },
  Teams.condition((t, { or, eq, notExists }) => or(
    eq(t.status, "deactivated"),
    notExists(t.activeMembers),
  )),
)

// --- Query with typed filter ---
yield* teams.collect(
  Teams.query.byRegion({ region: "APAC" }),
  Query.begins({ status: "active" }),
  Teams.filter((t, { and, gte, not, contains, gt, size }) => and(
    gte(t.memberCount, 5),
    not(contains(t.tags, "suspended")),
    gt(size(t.roster), 0),
  )),
  Query.reverse,
  Query.limit(25),
)

// --- Scan with complex OR filter ---
yield* teams.collect(
  Teams.scan(),
  Teams.filter((t, { or, and, eq, gt }) => or(
    and(eq(t.region, "APAC"), gt(t.memberCount, 10)),
    and(eq(t.region, "EMEA"), gt(t.memberCount, 20)),
  )),
)

// --- Shorthand for simple cases ---
yield* teams.collect(
  Teams.query.byRegion({ region: "APAC" }),
  Teams.filter({ status: "active", memberCount: { gte: 5 } }),
)

yield* teams.put(data,
  Teams.condition({ id: { notExists: true } }),
)
```
