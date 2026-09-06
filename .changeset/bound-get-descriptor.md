---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Accept bound-client `get` in `Batch.get`, `Transaction.transactGet` and `Transaction.check`

`db.entities.X.get(key)` now returns a `BoundGet`. It **is** an `Effect<Model, …, never>` exactly as before — `yield*` it, `.pipe(Effect.catchTag("ItemNotFound", …))` it, hand it to `Effect.map` / `Effect.all` — and it is additionally a read descriptor, so it can be passed straight to `Batch.get`, `Transaction.transactGet` and `Transaction.check`.

This closes the read half of the gap #100 closed for writes: an entity authored with the pure, AWS-free `@effect-dynamodb/schema` `Entity.make` carries no operations, so the bound client is the only surface its author holds. Until now that meant such an entity could not take part in batch reads, transactional reads, or condition checks at all — and `Transaction.check` is the sharpest loss, since a condition check on a row you are not writing is the standard way to assert an invariant across entities inside one transaction.

Bound and unbound get descriptors unwrap through the same protocol (`Entity.extractTransactable`) and may be mixed freely in one array. A value that is not a get descriptor now fails with a `ValidationError` carrying `EDD-9051` on the error channel, where it used to be a thrown defect callers could neither catch nor discriminate.

No change to the existing `get` surface.
