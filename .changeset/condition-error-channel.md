---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

`.condition(...)` now declares `ConditionalCheckFailed` on the error channel (#102).

A conditional write raised `ConditionalCheckFailed` at runtime but did not declare it, so
`Effect.catchTag("ConditionalCheckFailed", ...)` — the whole reason to write a conditional put —
was a type error. Callers had to `catchAll` and re-inspect `_tag`, losing exactly the
exhaustiveness that makes `catchTags` worth using.

Applying `.condition(...)` now widens the operation's error channel with `ConditionalCheckFailed`,
on every surface it is exposed:

- `BoundPut.condition()` — `db.entities.Users.put(input).condition(...)`
- `BoundUpdate.condition()` — `db.entities.Users.update(key).set(...).condition(...)`
- `BoundDelete.condition()` — `db.entities.Users.delete(key).condition(...)`
- the entity-scoped pipeable — `Users.put(input).pipe(Users.condition(...))`, on unbound
  `EntityPut` / `EntityUpdate` / `EntityDelete`

The widening is precise: an *unconditional* `put` / `update` / `delete` keeps its narrow channel,
and operations that already declare the error (`create`, `patch`, `upsert`, `deleteIfExists`) are
unchanged — the union collapses. `.asEffect()` and every combinator chained after `.condition()`
carry the widened channel. An update piped through the combinator stays an `EntityUpdate`; its
update-payload parameter is not flattened.

`.expectedVersion(...)` deliberately does **not** widen, and never did: `OptimisticLockError` is
unconditional on `update` because the `versioned` and unique-constraint write paths CAS whether or
not an expected version was supplied. The two combinators are now consistent in principle — each
operation declares exactly the failures reachable on it.

Also fixed on the unique-constraint transaction path: an update on an **unversioned** entity that
touched a unique field and was rejected by a user `.condition(...)` reported `OptimisticLockError`
— naming a version conflict that cannot occur on an entity with no version attribute. It now
reports `ConditionalCheckFailed`. When a version CAS *is* present, both predicates ride the same
`ConditionExpression` and DynamoDB does not say which half failed, so the rejection is still
attributed to the CAS as `OptimisticLockError`.

**Semver note.** Released as a minor, not a major. Widening an error channel is technically
breaking for code that matches the union exhaustively (`Effect.catchTags` over every tag, or a
hand-written exhaustive `switch` on `_tag`), and the unversioned-unique fix changes which tag such
code sees. Both are narrow, and neither breaks the common `catchTag` / `catchAll` shapes; staying
within 1.x is the deliberate call.
