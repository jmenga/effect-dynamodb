---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Accept a caller-supplied generated id in `transactWrite`, `Batch.write` and `EventStore.append`

`rejectUnsupportedOp` gated the `generatedId` check on the entity's **configuration**, so any entity declaring `generatedId` was barred from every multi-item write path — with the reason "id generation needs the Crypto service, which is not in scope here."

That reason does not hold when the caller supplies the id. `Entity.put` reaches `Crypto` only for an *absent* field: `fillGeneratedId` returns the input untouched when the value is present. So the rejected call needed nothing the path lacked, and the workaround the message pointed at — supply the id yourself — was already in effect and did not lift the rejection.

The gate now reads the op's input. An omitted id is still refused, because this path builds the item straight from the encoded input and never calls `fillGeneratedId`, so the id would stay missing and the primary key would compose around an `undefined`. The message names the field and says which case is unsupported, rather than reading as a ban on the entity.

This unblocks committing a `generatedId` read model atomically with the events that produced it (`EventStore.append({ additionalItems })`) — the pattern #100 exists to enable.

The neighbouring `refs` and `vectorIndexes` gates are unchanged and stay configuration-gated: `refs` always hydrates at write time and `vectorIndexes` always needs the `Embedder`, so neither dependency is something the caller can remove. The 1.16.0 changelog grouped all three as needing "a read, `Crypto` or an `Embedder`", which was accurate for those two and wrong for this one; that entry is left as the historical record of what shipped.
