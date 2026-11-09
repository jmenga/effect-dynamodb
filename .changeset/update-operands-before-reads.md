---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

An update or `patch` whose `.append()`, `pathSet`, `pathAppend`, `pathPrepend` or `pathIfNotExists` operand its schema refuses now fails with the same `ValidationError` before it reads or sends anything, on its own and in `Transaction.transactWrite`. The refusal used to be made as the write was built, after the reads of an update that reads first (a `versioned: { retain: true }` entity's, and an update `Transaction.transactWrite` plans after another), so those reads were sent for nothing. An update that was also refused for another reason (an item that isn't there, a stale `expectedVersion`, a sparse map key it can't hold) now reports the operand.

Nothing else about an operand changes: one that was written is written as the same bytes, one that wasn't checked isn't checked, and one that was refused is refused with the same error.
