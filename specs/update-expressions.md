# Update Expressions — API Specification

> **Status:** Draft
> **Scope:** `Entity` update combinators, `PathBuilder`, expression compilation
> **Target:** `packages/effect-dynamodb/src/Entity.ts`, `packages/effect-dynamodb/src/internal/EntityCombinators.ts`

## 1. Overview

Update combinators are methods on **entity definitions** (e.g., `Teams.set`, `Products.add`) that describe DynamoDB update operations. They are pure data — no DynamoDB calls happen until the combinator is applied to an `EntityUpdate` and executed via a bound entity.

Each combinator has two overloads:

- **Record** — operates on top-level fields using an object literal. Type-safe against the entity's `Update` type.
- **Path** — operates on nested or indexed attributes using a callback `(t) => t.field.nested`. Type-safe against the entity's `Model` schema via `PathBuilder<Model>`.

Combinators compose via variadic arguments on `BoundEntity.update()` or via `pipe` on `EntityUpdate`:

```typescript
// Variadic (preferred)
yield* teams.update(
  { id: teamId },
  Teams.set({ name: "New Name" }),
  Teams.add({ wins: 1 }),
  Teams.remove((t) => t.roster.at(5)),
)

// Pipe (equivalent)
yield* Teams.update({ id: teamId }).pipe(
  Teams.set({ name: "New Name" }),
  Teams.add({ wins: 1 }),
  Teams.remove((t) => t.roster.at(5)),
  Teams.asModel,
)
```

## 2. DynamoDB Update Expression Grammar

For reference, the full DynamoDB grammar this API covers:

```
update-expression ::=
    [ SET action [, action] ... ]
    [ REMOVE action [, action] ... ]
    [ ADD action [, action] ... ]
    [ DELETE action [, action] ... ]

set-action    ::= path = value
value         ::= operand | operand '+' operand | operand '-' operand
operand       ::= path | :val | if_not_exists(path, value) | list_append(list1, list2)

remove-action ::= path

add-action    ::= path :val        -- number (atomic increment) or set (union)

delete-action ::= path :subset     -- set types only (SS, NS, BS)
```

`path` = attribute name, nested document path (`map.nested`), or list index (`list[0]`).

Each action keyword (SET, REMOVE, ADD, DELETE) appears **at most once** in the expression. Multiple actions within each keyword are comma-separated.

## 3. PathBuilder

### 3.1 Construction

`PathBuilder<Model>` is a `Proxy`-based type derived from the entity's model schema. It records property accesses into a `segments` array and returns typed `Path` objects.

Accessed via a property on the entity definition:

```typescript
// Internally: Entity.make(...) creates a PathBuilder from the model schema
// Exposed as a getter used by the path callback overloads
```

The path builder is never exposed directly to the user. It is the parameter of the callback in path overloads:

```typescript
Teams.set((t) => t.address.city, "NYC")
//         ^ t is PathBuilder<Team>
```

### 3.2 Path Type

```typescript
interface Path<Root, Value> {
  readonly _tag: "Path"
  readonly segments: ReadonlyArray<string | number>
  // Phantom types
  readonly _Root: (_: never) => Root
  readonly _Value: (_: never) => Value
}
```

### 3.3 PathBuilder Type

```typescript
type PathBuilder<Model> = {
  [K in keyof Model]-?: Model[K] extends ReadonlyArray<infer E>
    ? ArrayPath<Model, E>
    : Model[K] extends Record<string, unknown>
      ? PathBuilder<Model[K]> & Path<Model, Model[K]>
      : Path<Model, Model[K]>
}

type ArrayPath<Root, Element> = Path<Root, ReadonlyArray<Element>> & {
  at(index: number): Element extends Record<string, unknown>
    ? PathBuilder<Element> & Path<Root, Element>
    : Path<Root, Element>
}
```

### 3.4 Runtime Implementation

`PathBuilder` is a recursive `Proxy`. Each property access returns a new `Proxy` with the accessed key appended to `segments`. The `.at(n)` method appends the numeric index.

```typescript
function createPathBuilder<Model>(segments: ReadonlyArray<string | number> = []): PathBuilder<Model> {
  return new Proxy({} as any, {
    get(_, prop) {
      if (prop === "_tag") return "Path"
      if (prop === "segments") return segments
      if (prop === "at") return (index: number) => createPathBuilder([...segments, index])
      if (typeof prop === "string") return createPathBuilder([...segments, prop])
      return undefined
    },
  })
}
```

### 3.5 Compilation to DynamoDB Expression

Segments compile to DynamoDB document path notation:

- String segment `"field"` → `#pN` with `ExpressionAttributeNames[#pN] = "field"`
- Number segment `N` → `[N]` (literal, no name alias)

Examples:

| Path | Segments | Expression | Names |
|---|---|---|---|
| `t.name` | `["name"]` | `#p0` | `{ "#p0": "name" }` |
| `t.address.city` | `["address", "city"]` | `#p0.#p1` | `{ "#p0": "address", "#p1": "city" }` |
| `t.tags.at(0)` | `["tags", 0]` | `#p0[0]` | `{ "#p0": "tags" }` |
| `t.scores.at(1).bonus` | `["scores", 1, "bonus"]` | `#p0[1].#p1` | `{ "#p0": "scores", "#p1": "bonus" }` |
| `t.matrix.at(0).at(1)` | `["matrix", 0, 1]` | `#p0[0][1]` | `{ "#p0": "matrix" }` |

Field name resolution: string segments pass through `resolveDbName()` to support `DynamoModel.configure(Model, { field: { field: "dbName" } })` renaming. Only the first segment (top-level attribute) is subject to renaming — nested map keys are not renamed.

## 4. Combinators

### 4.1 `set` — SET

Assigns values to attributes. Four overloads discriminated by argument type.

#### Overload 1: Record

Batch-assign top-level fields. Values are literal replacements.

```typescript
Teams.set({ name: "Alice", status: "active" })
```

```
SET #name = :name, #status = :status
```

**Type:** `(updates: Entity.Update<typeof Teams>) => UpdateCombinator<Team>`

Note: passing a nested object (e.g., `{ address: { city: "NYC" } }`) replaces the **entire** attribute, not a deep merge.

#### Overload 2: Path + Value

Set a single attribute at any depth. Value is type-checked against the path's target type.

```typescript
Teams.set((t) => t.address.city, "NYC")
Teams.set((t) => t.tags.at(0), "primary")
Teams.set((t) => t.scores.at(1).bonus, 10)
```

```
SET #address.#city = :val
SET #tags[0] = :val
SET #scores[1].#bonus = :val
```

**Type:** `<V>(accessor: (p: PathBuilder<Model>) => Path<Model, V>, value: V) => UpdateCombinator<Model>`

**Discrimination:** 2 arguments, second argument is not a function.

#### Overload 3: Path + Path (Copy Attribute)

Set one attribute to another attribute's current value.

```typescript
Teams.set((t) => t.backup, (t) => t.original)
Teams.set((t) => t.backup.coach, (t) => t.current.coach)
```

```
SET #backup = #original
SET #backup.#coach = #current.#coach
```

**Type:** `<V>(target: (p: PathBuilder<Model>) => Path<Model, V>, source: (p: PathBuilder<Model>) => Path<Model, V>) => UpdateCombinator<Model>`

**Discrimination:** 2 arguments, second argument is a function.

Both paths must resolve to the same value type `V`.

#### Overload 4: Expression Callback (Attribute Arithmetic)

Set an attribute using arithmetic between two attribute references. The callback receives the path builder and an operations object with `add` and `subtract`.

```typescript
Teams.set((t, { add }) => add(t.budget, t.bonus))
Teams.set((t, { subtract }) => subtract(t.balance, t.fees))
Teams.set((t, { add }) => add(t.stats.total, t.stats.increment))
```

```
SET #budget = #budget + #bonus
SET #balance = #balance - #fees
SET #stats.#total = #stats.#total + #stats.#increment
```

**Type:** `(expr: (p: PathBuilder<Model>, ops: SetOps<Model>) => SetAssignment) => UpdateCombinator<Model>`

**Discrimination:** 1 argument, argument is a function.

**SetOps interface:**

```typescript
interface SetOps<Model> {
  add(target: Path<Model, number>, source: Path<Model, number>): SetAssignment
  subtract(target: Path<Model, number>, source: Path<Model, number>): SetAssignment
}
```

Both `add` and `subtract` require the target and source paths to be `Path<Model, number>`.

Semantics: `add(t.f, t.g)` means `SET #f = #f + #g`. The first argument is both the assignment target and the left operand.

**Runtime discrimination summary:**

| Args | First arg | Second arg | Overload |
|---|---|---|---|
| 1 | object | — | Record |
| 1 | function | — | Expression callback |
| 2 | function | not function | Path + value |
| 2 | function | function | Path + path (copy) |

### 4.2 `subtract` — SET (arithmetic subtraction)

Subtract a literal value from an attribute. Generates `SET #f = #f - :val`.

#### Record overload

```typescript
Teams.subtract({ stock: 3, budget: 5000 })
```

```
SET #stock = #stock - :stock, #budget = #budget - :budget
```

**Type:** `(values: Record<UpdatableKeys<Model>, number>) => UpdateCombinator<Model>`

#### Path overload

```typescript
Teams.subtract((t) => t.inventory.warehouse1, 5)
Teams.subtract((t) => t.stats.losses, 1)
```

```
SET #inventory.#warehouse1 = #inventory.#warehouse1 - :val
SET #stats.#losses = #stats.#losses - :val
```

**Type:** `(accessor: (p: PathBuilder<Model>) => Path<Model, number>, value: number) => UpdateCombinator<Model>`

### 4.3 `append` — SET (list_append, append)

Append elements to the end of a list attribute. Generates `SET #f = list_append(#f, :val)`.

#### Record overload

Value is an array of elements to append.

```typescript
Teams.append({ tags: ["new-tag", "featured"], history: [newEvent] })
```

```
SET #tags = list_append(#tags, :tags), #history = list_append(#history, :history)
```

**Type:** `(values: Record<string, ReadonlyArray<unknown>>) => UpdateCombinator<Model>`

#### Path overload

Arguments are individual elements (variadic), not arrays. Element type `E` is inferred from the path's array element type.

```typescript
Teams.append((t) => t.tags, "new-tag", "featured")
Teams.append((t) => t.user.orders, orderId)
Teams.append((t) => t.feed.items, post1, post2, post3)
```

```
SET #tags = list_append(#tags, :val)             -- :val = ["new-tag", "featured"]
SET #user.#orders = list_append(#user.#orders, :val)  -- :val = [orderId]
SET #feed.#items = list_append(#feed.#items, :val)    -- :val = [post1, post2, post3]
```

**Type:** `<E>(accessor: (p: PathBuilder<Model>) => Path<Model, ReadonlyArray<E>>, ...items: Array<E>) => UpdateCombinator<Model>`

Elements are wrapped in an array internally before marshalling.

### 4.4 `prepend` — SET (list_append, prepend)

Prepend elements to the beginning of a list attribute. Generates `SET #f = list_append(:val, #f)`. Note the reversed argument order vs `append`.

#### Record overload

```typescript
Teams.prepend({ history: [latestEvent], alerts: [urgentAlert] })
```

```
SET #history = list_append(:history, #history), #alerts = list_append(:alerts, #alerts)
```

**Type:** `(values: Record<string, ReadonlyArray<unknown>>) => UpdateCombinator<Model>`

#### Path overload

```typescript
Teams.prepend((t) => t.feed.items, newPost)
Teams.prepend((t) => t.alerts, alert1, alert2)
```

```
SET #feed.#items = list_append(:val, #feed.#items)
SET #alerts = list_append(:val, #alerts)
```

**Type:** `<E>(accessor: (p: PathBuilder<Model>) => Path<Model, ReadonlyArray<E>>, ...items: Array<E>) => UpdateCombinator<Model>`

### 4.5 `ifNotExists` — SET (conditional)

Set an attribute only if it does not already exist. Generates `SET #f = if_not_exists(#f, :val)`.

If the attribute already exists, the value is unchanged. Useful for initializing defaults on first write.

#### Record overload

```typescript
Teams.ifNotExists({ score: 0, status: "pending", tags: [] })
```

```
SET #score = if_not_exists(#score, :score),
    #status = if_not_exists(#status, :status),
    #tags = if_not_exists(#tags, :tags)
```

**Type:** `(values: Record<string, unknown>) => UpdateCombinator<Model>`

#### Path overload

```typescript
Teams.ifNotExists((t) => t.prefs.theme, "light")
Teams.ifNotExists((t) => t.metadata.rating, 0)
```

```
SET #prefs.#theme = if_not_exists(#prefs.#theme, :val)
SET #metadata.#rating = if_not_exists(#metadata.#rating, :val)
```

**Type:** `<V>(accessor: (p: PathBuilder<Model>) => Path<Model, V>, value: V) => UpdateCombinator<Model>`

### 4.6 `remove` — REMOVE

Remove attributes from the item. If the attribute does not exist, no error.

#### Record overload

Accepts an array of top-level field names. Type-checked against updatable keys (keys and immutable fields excluded).

```typescript
Teams.remove(["description", "tempFlag", "obsoleteFlag"])
```

```
REMOVE #description, #tempFlag, #obsoleteFlag
```

**Type:** `(fields: ReadonlyArray<UpdatableKeys<Model>>) => UpdateCombinator<Model>`

#### Path overload

```typescript
Teams.remove((t) => t.address.zip)
Teams.remove((t) => t.tags.at(2))
Teams.remove((t) => t.items.at(0).discount)
```

```
REMOVE #address.#zip
REMOVE #tags[2]
REMOVE #items[0].#discount
```

**Type:** `(accessor: (p: PathBuilder<Model>) => Path<Model, any>) => UpdateCombinator<Model>`

Note: removing a list element by index shifts subsequent elements (DynamoDB behavior). Removing a GSI composite attribute auto-removes the corresponding GSI key fields so the item drops out of the sparse index (existing behavior, preserved).

### 4.7 `add` — ADD

Atomically add to a number or union into a set. Generates `ADD #f :val`.

DynamoDB ADD behavior:
- **Number:** adds the value (negative values subtract). If attribute doesn't exist, initializes to the value.
- **Set (SS/NS/BS):** unions the provided set with the existing set. If attribute doesn't exist, creates the set.

#### Record overload

```typescript
Teams.add({ matchesPlayed: 1, wins: 1 })
Teams.add({ balance: -50 })
Teams.add({ tags: new Set(["urgent", "reviewed"]) })
Teams.add({ scores: new Set([100, 200]) })
```

```
ADD #matchesPlayed :mp, #wins :wins
ADD #balance :balance
ADD #tags :tags
ADD #scores :scores
```

**Type:** `(values: Record<string, number | ReadonlySet<string> | ReadonlySet<number>>) => UpdateCombinator<Model>`

#### Path overload

```typescript
Teams.add((t) => t.stats.views, 1)
Teams.add((t) => t.user.roles, new Set(["admin"]))
```

```
ADD #stats.#views :val
ADD #user.#roles :val
```

**Type:**
```typescript
{
  (accessor: (p: PathBuilder<Model>) => Path<Model, number>, value: number): UpdateCombinator<Model>
  <V extends ReadonlySet<string> | ReadonlySet<number>>(
    accessor: (p: PathBuilder<Model>) => Path<Model, V>, value: V
  ): UpdateCombinator<Model>
}
```

### 4.8 `delete` — DELETE

Remove elements from a set attribute. Generates `DELETE #f :subset`.

DynamoDB DELETE only works on set types (SS, NS, BS). The provided value must be a set of the same type as the attribute.

#### Record overload

```typescript
Teams.delete({ tags: new Set(["old", "deprecated"]) })
Teams.delete({ scores: new Set([0]) })
```

```
DELETE #tags :tags
DELETE #scores :scores
```

**Type:** `(values: Record<string, ReadonlySet<string> | ReadonlySet<number>>) => UpdateCombinator<Model>`

#### Path overload

```typescript
Teams.delete((t) => t.user.roles, new Set(["viewer"]))
Teams.delete((t) => t.metadata.categories, new Set(["old"]))
```

```
DELETE #user.#roles :val
DELETE #metadata.#categories :val
```

**Type:**
```typescript
<V extends ReadonlySet<string> | ReadonlySet<number>>(
  accessor: (p: PathBuilder<Model>) => Path<Model, V>, value: V
) => UpdateCombinator<Model>
```

### 4.9 Control Combinators

These have no path overload — they operate on the update operation as a whole.

#### `expectedVersion`

Optimistic locking. Adds a condition that the current item version matches the expected value. Fails with `ConditionalCheckFailed` if versions don't match.

```typescript
Teams.expectedVersion(12)
```

```
ConditionExpression: #__edd_v__ = :expectedVer
```

**Type:** `(version: number) => UpdateCombinator<Model>`

#### `condition`

Arbitrary condition expression. ANDed with optimistic lock condition if both present. Fails with `ConditionalCheckFailed` if condition is not met.

```typescript
Teams.condition(Expr.gt("stock", 0))
Teams.condition(Expr.and(Expr.eq("status", "active"), Expr.exists("assigneeId")))
Teams.condition({ attributeExists: "email" })  // shorthand
```

```
ConditionExpression: ... AND (#stock > :cond0)
```

**Type:** `(expr: Expr | ConditionInput) => UpdateCombinator<Model>`

Accepts either the new `Expr` ADT or the existing `ConditionInput` shorthand for backward compatibility.

#### `returnValues`

Control what DynamoDB returns after the update.

```typescript
Teams.returnValues("allOld")
Teams.returnValues("updatedNew")
```

**Type:** `(mode: "none" | "allOld" | "allNew" | "updatedOld" | "updatedNew") => UpdateCombinator<Model>`

Default is `"allNew"` for updates.

#### `cascade`

Propagate updates to related entities that embed this entity via `DynamoModel.ref`.

```typescript
Teams.cascade({ targets: [MatchEntity], mode: "eventual" })
```

**Type:** `(config: { targets: ReadonlyArray<CascadeTarget>, filter?: Record<string, unknown>, mode?: "eventual" | "transactional" }) => UpdateCombinator<Model>`

## 5. UpdateState

All combinators write into an `UpdateState` record carried by `EntityUpdate`. The expression compiler reads this state to produce the final DynamoDB `UpdateExpression`.

```typescript
interface UpdateState {
  // SET — literal value assignment
  readonly updates: unknown

  // SET — path-based operations (new)
  readonly pathSets: ReadonlyArray<PathSet>

  // SET — subtraction
  readonly subtract: Record<string, number> | undefined
  readonly pathSubtracts: ReadonlyArray<PathSubtract>

  // SET — list append
  readonly append: Record<string, ReadonlyArray<unknown>> | undefined
  readonly pathAppends: ReadonlyArray<PathAppend>

  // SET — list prepend (new)
  readonly prepend: Record<string, ReadonlyArray<unknown>> | undefined
  readonly pathPrepends: ReadonlyArray<PathPrepend>

  // SET — if_not_exists (new)
  readonly ifNotExists: Record<string, unknown> | undefined
  readonly pathIfNotExists: ReadonlyArray<PathIfNotExists>

  // SET — attribute reference (new)
  readonly attrRefs: ReadonlyArray<AttrRef>

  // REMOVE
  readonly remove: ReadonlyArray<string> | undefined
  readonly pathRemoves: ReadonlyArray<Path<any, any>>

  // ADD
  readonly add: Record<string, number | ReadonlySet<string | number>> | undefined
  readonly pathAdds: ReadonlyArray<PathAdd>

  // DELETE
  readonly deleteFromSet: Record<string, unknown> | undefined
  readonly pathDeletes: ReadonlyArray<PathDelete>

  // Control
  readonly expectedVersion: number | undefined
  readonly condition: Expr | ConditionInput | undefined
  readonly returnValues: ReturnValuesMode | undefined
  readonly cascade: CascadeConfig | undefined
}
```

Path operation types:

```typescript
interface PathSet { path: Path<any, any>; value: unknown }
interface PathSubtract { path: Path<any, number>; value: number }
interface PathAppend { path: Path<any, ReadonlyArray<any>>; values: ReadonlyArray<unknown> }
interface PathPrepend { path: Path<any, ReadonlyArray<any>>; values: ReadonlyArray<unknown> }
interface PathIfNotExists { path: Path<any, any>; value: unknown }
interface PathAdd { path: Path<any, any>; value: number | ReadonlySet<string | number> }
interface PathDelete { path: Path<any, any>; value: ReadonlySet<string | number> }

type AttrRef =
  | { type: "copy"; target: Path<any, any>; source: Path<any, any> }
  | { type: "add"; target: Path<any, number>; source: Path<any, number> }
  | { type: "subtract"; target: Path<any, number>; source: Path<any, number> }
```

## 6. Expression Compilation

The expression compiler reads `UpdateState` and produces:

```typescript
interface CompiledUpdate {
  UpdateExpression: string
  ExpressionAttributeNames: Record<string, string>
  ExpressionAttributeValues: Record<string, AttributeValue>
  ConditionExpression?: string
}
```

### 6.1 Compilation Order

1. **SET clauses** — collected from: `updates` (record), `pathSets`, `subtract`, `pathSubtracts`, `append`, `pathAppends`, `prepend`, `pathPrepends`, `ifNotExists`, `pathIfNotExists`, `attrRefs`, system fields (updatedAt, version increment)
2. **REMOVE clauses** — collected from: `remove` (record), `pathRemoves`, GSI cascade removals
3. **ADD clauses** — collected from: `add` (record), `pathAdds`
4. **DELETE clauses** — collected from: `deleteFromSet` (record), `pathDeletes`

### 6.2 Name/Value Allocation

Each clause allocates expression attribute names and values from a shared counter to avoid collisions:

- Record operations: `#u0`, `#u1`, ... with values `:u0`, `:u1`, ...
- Path operations: `#p0`, `#p1`, ... (one per path segment) with values `:p0`, `:p1`, ...
- Remove operations: `#r0`, `#r1`, ...
- Add operations: `#a0`, `#a1`, ... with values `:a0`, `:a1`, ...
- Delete operations: `#d0`, `#d1`, ... with values `:d0`, `:d1`, ...
- System fields: `#sysUpd`, `#sysVer`, `:sysUpd`, `:vinc`
- Condition: `#condVer`, `#cond0`, ... with values `:expectedVer`, `:cond0`, ...

### 6.3 Path Compilation

```typescript
function compilePath(
  segments: ReadonlyArray<string | number>,
  names: Record<string, string>,
  prefix: string,
  counter: { value: number },
): string {
  return segments.map((seg) => {
    if (typeof seg === "number") return `[${seg}]`
    const key = `#${prefix}${counter.value++}`
    names[key] = resolveDbName(seg)  // only first segment resolves rename
    return key
  }).join("")
    .replace(/\]\[/g, "][")     // consecutive indices
    .replace(/\]#/g, "].#")     // index followed by name
}
```

### 6.4 SET Clause Generation

| Source | Template | Example |
|---|---|---|
| `updates` (record) | `#name = :val` | `#u0 = :u0` |
| `pathSets` | `<path> = :val` | `#p0.#p1 = :p0` |
| `subtract` (record) | `#name = #name - :val` | `#u0 = #u0 - :u0` |
| `pathSubtracts` | `<path> = <path> - :val` | `#p0.#p1 = #p0.#p1 - :p0` |
| `append` (record) | `#name = list_append(#name, :val)` | `#u0 = list_append(#u0, :u0)` |
| `pathAppends` | `<path> = list_append(<path>, :val)` | `#p0.#p1 = list_append(#p0.#p1, :p0)` |
| `prepend` (record) | `#name = list_append(:val, #name)` | `#u0 = list_append(:u0, #u0)` |
| `pathPrepends` | `<path> = list_append(:val, <path>)` | `#p0.#p1 = list_append(:p0, #p0.#p1)` |
| `ifNotExists` (record) | `#name = if_not_exists(#name, :val)` | `#u0 = if_not_exists(#u0, :u0)` |
| `pathIfNotExists` | `<path> = if_not_exists(<path>, :val)` | `#p0.#p1 = if_not_exists(#p0.#p1, :p0)` |
| `attrRefs` (copy) | `<target> = <source>` | `#p0 = #p1` |
| `attrRefs` (add) | `<target> = <target> + <source>` | `#p0 = #p0 + #p1` |
| `attrRefs` (subtract) | `<target> = <target> - <source>` | `#p0 = #p0 - #p1` |
| system updatedAt | `#sysUpd = :sysUpd` | `#sysUpd = :sysUpd` |
| system version | `#sysVer = #sysVer + :vinc` | `#sysVer = #sysVer + :vinc` |

### 6.5 REMOVE Clause Generation

| Source | Template | Example |
|---|---|---|
| `remove` (record) | `#name` | `#r0` |
| `pathRemoves` | `<path>` | `#p0[2]`, `#p0.#p1` |
| GSI cascade | `#name` | `#r1` (GSI pk/sk fields) |

### 6.6 ADD Clause Generation

| Source | Template | Example |
|---|---|---|
| `add` (record) | `#name :val` | `#a0 :a0` |
| `pathAdds` | `<path> :val` | `#p0.#p1 :p0` |

### 6.7 DELETE Clause Generation

| Source | Template | Example |
|---|---|---|
| `deleteFromSet` (record) | `#name :val` | `#d0 :d0` |
| `pathDeletes` | `<path> :val` | `#p0.#p1 :p0` |

### 6.8 Final Assembly

```typescript
const parts: string[] = []
if (setClauses.length > 0)    parts.push(`SET ${setClauses.join(", ")}`)
if (removeClauses.length > 0) parts.push(`REMOVE ${removeClauses.join(", ")}`)
if (addClauses.length > 0)    parts.push(`ADD ${addClauses.join(", ")}`)
if (deleteClauses.length > 0) parts.push(`DELETE ${deleteClauses.join(", ")}`)
const UpdateExpression = parts.join(" ")
```

## 7. Type Safety

### 7.1 Record Overloads

Record overloads are type-checked against `Entity.Update<typeof E>` — a type derived from the model that excludes key fields and immutable fields.

```typescript
// Entity.Update<typeof Teams> = { name?: string; status?: string; ... }
Teams.set({ name: "Alice" })          // OK
Teams.set({ id: "t-1" })             // Error — id is a key field
Teams.set({ createdBy: "admin" })     // Error — createdBy is immutable
Teams.set({ foo: "bar" })             // Error — foo not in model
```

### 7.2 Path Overloads

Path overloads are type-checked via `Path<Model, V>`:

```typescript
// Path<Team, string>
Teams.set((t) => t.name, "Alice")     // OK — string = string
Teams.set((t) => t.name, 123)         // Error — number != string

// Path<Team, number>
Teams.subtract((t) => t.stats.wins, 1)    // OK — number = number
Teams.subtract((t) => t.name, 1)          // Error — Path<Team, string> != Path<Team, number>

// Path<Team, ReadonlyArray<string>>
Teams.append((t) => t.tags, "new")        // OK — element type is string
Teams.append((t) => t.tags, 123)          // Error — number != string

// Path<Team, ReadonlySet<string>>
Teams.delete((t) => t.roles, new Set(["viewer"]))   // OK
Teams.delete((t) => t.roles, new Set([1]))           // Error — Set<number> != Set<string>
```

### 7.3 Expression Callback

The expression callback receives typed `SetOps`:

```typescript
// Both paths must be Path<Model, number>
Teams.set((t, { add }) => add(t.budget, t.bonus))          // OK — both number
Teams.set((t, { add }) => add(t.budget, t.name))           // Error — name is string
Teams.set((t, { subtract }) => subtract(t.name, t.other))  // Error — name is string
```

### 7.4 Copy (Path + Path)

Both paths must resolve to the same value type:

```typescript
Teams.set((t) => t.backup, (t) => t.original)              // OK — same type
Teams.set((t) => t.backupName, (t) => t.score)             // Error — string != number
```

## 8. Interaction with Existing Behavior

### 8.1 GSI Key Recomposition

When `set` (record overload) includes attributes that are part of a GSI's composite key, the framework automatically recomposes the GSI pk/sk fields. This existing behavior is unchanged.

Path-based `set` on a top-level attribute that is a GSI composite triggers the same recomposition. Path-based `set` on a nested attribute does **not** trigger GSI recomposition (nested attributes are not GSI composites).

### 8.2 GSI Cascade on Remove

When `remove` targets a GSI composite attribute, the corresponding GSI pk/sk fields are automatically removed (item drops out of the sparse index). This existing behavior extends to path-based `remove` — but only when the path targets a top-level attribute that is a GSI composite.

### 8.3 System Fields

The expression compiler automatically adds:

- `updatedAt` timestamp (if `timestamps: true`)
- Version increment (if `versioned: true`)

These are appended to the SET clause regardless of which combinators the user specifies.

### 8.4 Optimistic Locking

`expectedVersion(n)` adds `#__edd_v__ = :expectedVer` to the `ConditionExpression`. If the user also specifies `condition(expr)`, both are ANDed together.

### 8.5 Empty Update

If no combinators produce any SET/REMOVE/ADD/DELETE clauses (e.g., only `expectedVersion` or `condition`), the framework falls back to a `getItem` and returns the current item. This existing behavior is unchanged.

## 9. Migration from `Entity.*` to `EntityDef.*`

| Current (Entity module) | New (Entity definition) | Notes |
|---|---|---|
| `Entity.set(updates)` | `Teams.set(updates)` | Typed against entity's Update type |
| `Entity.remove(fields)` | `Teams.remove(fields)` | Typed against entity's updatable keys |
| `Entity.add(values)` | `Teams.add(values)` | Widened to accept sets |
| `Entity.subtract(values)` | `Teams.subtract(values)` | Unchanged semantics |
| `Entity.append(values)` | `Teams.append(values)` | Unchanged semantics |
| `Entity.deleteFromSet(values)` | `Teams.delete(values)` | Renamed |
| `Entity.expectedVersion(n)` | `Teams.expectedVersion(n)` | Unchanged |
| `Entity.condition(cond)` | `Teams.condition(expr)` | Upgraded to Expr ADT |
| `Entity.returnValues(mode)` | `Teams.returnValues(mode)` | Unchanged |
| `Entity.cascade(config)` | `Teams.cascade(config)` | Unchanged |
| — | `Teams.set((t) => t.f.g, val)` | New: nested path |
| — | `Teams.set((t) => t.f, (t) => t.g)` | New: copy attribute |
| — | `Teams.set((t, { add }) => ...)` | New: attribute arithmetic |
| — | `Teams.prepend(values)` | New: list prepend |
| — | `Teams.ifNotExists(values)` | New: conditional set |

`Entity.set`, `Entity.remove`, etc. operate on top-level fields by name. The entity-level path-based combinators (`Teams.set((t) => ...)`) add type-safe nested path support.

## 10. Full Example

```typescript
const { Teams: teams } = yield* DynamoClient.make(MainTable)

yield* teams.update(
  { id: teamId },

  // SET — record (batch top-level)
  Teams.set({ name: "Thunderbolts", status: "active" }),

  // SET — path (nested)
  Teams.set((t) => t.address.city, "Melbourne"),
  Teams.set((t) => t.roster.at(0).role, "captain"),

  // SET — copy attribute
  Teams.set((t) => t.backup.coach, (t) => t.current.coach),

  // SET — attribute arithmetic
  Teams.set((t, { add }) => add(t.budget, t.bonus)),

  // SET — if_not_exists
  Teams.ifNotExists({ score: 0 }),
  Teams.ifNotExists((t) => t.prefs.theme, "light"),

  // SET — subtract
  Teams.subtract({ budget: 5000 }),
  Teams.subtract((t) => t.stats.losses, 1),

  // SET — append
  Teams.append({ history: [newEvent] }),
  Teams.append((t) => t.feed.items, post1, post2),

  // SET — prepend
  Teams.prepend((t) => t.alerts, urgentAlert),

  // REMOVE — record
  Teams.remove(["tempFlag", "obsoleteFlag"]),

  // REMOVE — path
  Teams.remove((t) => t.roster.at(5)),
  Teams.remove((t) => t.address.zip),

  // ADD — record (number + set)
  Teams.add({ matchesPlayed: 1 }),
  Teams.add({ badges: new Set(["champion"]) }),

  // ADD — path
  Teams.add((t) => t.stats.wins, 1),

  // DELETE — record
  Teams.delete({ tags: new Set(["inactive"]) }),

  // DELETE — path
  Teams.delete((t) => t.user.roles, new Set(["viewer"])),

  // Control
  Teams.expectedVersion(12),
  Teams.condition(Expr.gt("matchesPlayed", 0)),
)
```
