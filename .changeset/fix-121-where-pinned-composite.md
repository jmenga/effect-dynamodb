---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Refuse `.where()` on a sort-key composite the accessor already pinned (EDD-9053)

DynamoDB allows exactly one sort key condition, and `Query.where` **replaces** the `begins_with` an index accessor installs for its pinned prefix. A condition on a composite the accessor had already pinned therefore discarded that pin instead of narrowing within it, and the query ran against the whole partition.

Every operator was affected, not only the one-sided ones that the clamping logic guarded: `pinnedKeyForm` is built from composites strictly to the left of the target, so at target index 0 it was empty and `eq` / `beginsWith` / `between` lost the pin too. Under a pinned `label = "ship"`, `eq(t.label, "shine")` composed `#sk = "…#label_shine"` and returned rows whose label was **not** the pinned value.

The clamping predicate was `targetIndex === 0`, standing in for "the accessor pinned nothing". Those coincided for every shape under test but are different claims — an accessor can pin composite[0] itself. It now asks what the accessor actually pinned, and a condition targeting a pinned composite raises **EDD-9053** rather than silently returning wrong rows.

`ResolveSkFields` is repaired alongside it. It resolved to `{}` rather than `never` when no composite remained, so `BoundQuery`'s `[SkRemaining] extends [never]` gate never fired and `.where()` was offered on every accessor — including ones that had pinned every composite (the no-cast route to this bug) and ones whose index has no sort key composites at all (the only reason `EDD-9045` needed to exist as a runtime throw). `.where()` now disappears from both, so well-typed code cannot reach either diagnostic.
