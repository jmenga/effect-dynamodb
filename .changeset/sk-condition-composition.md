---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Compose `.where()` sort key conditions into full sort key values (closes #101)

A sort key condition applied through a named-index or primary-key accessor did
not narrow the query. Stored sort keys are composed as
`$schema#v1#entity#<name>_<cased value>`, but `.where()` concatenated the raw
operand onto the entity prefix — so `gte` matched the whole partition (a raw
value sorts below every `<name>_`-prefixed segment) while `beginsWith`, `eq`,
`between`, `lt` and `lte` matched nothing.

The operand is now placed in the position of the SK composite it targets and run
through the same composer the write path uses, applying value serialization, the
`<name>_` prefix and the schema casing. Additional behaviour that follows from
composing correctly:

- A condition on a **non-terminal** SK composite covers that value's whole
  subtree — `eq` compiles to a subtree `begins_with`, and inclusive upper bounds
  span the subtree.
- When the accessor has already pinned leading SK composites, one-sided
  operators are clamped to that prefix (`Query.where` replaces the accessor's
  own `begins_with`, so an unclamped `>=` would leak into neighbouring
  composite values).
- New `EDD-9045` when `.where()` is used on an index whose sort key has no
  composites, and `EDD-9046` for a strict `lt` on the last SK composite while an
  earlier one is pinned — DynamoDB cannot express `begins_with(prefix) AND sk <
  value` in a single key condition, so this is refused rather than silently
  returning the boundary item.
