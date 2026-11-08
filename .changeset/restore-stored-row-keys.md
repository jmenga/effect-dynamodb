---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A row read back from DynamoDB composes the keys `put` wrote, on every path that composes keys from a stored row.

- **`restore`, an update or `patch` of a `versioned: { retain: true }` entity, in a `transactWrite` too, and the updates that read the item first (a unique constraint, a vector index) no longer die with `EDD-9050`** on a `Schema.OptionFromNullOr(Schema.BigInt)` or a `Schema.BigInt` under a decoding default holding a value below 2^53. DynamoDB hands such a value back as a number, and neither form of the schema took one. The composite key form now takes it as the `bigint` it was stored from, so primary, index, history and sentinel keys are the ones `put` wrote, byte for byte. `aggregate.list` lists such an aggregate, and `rekey` moves such a row and repairs its index keys.
- **A delete releases the unique-constraint sentinel `put` reserved** on a `bigint` field below 2^53, `Schema.BigInt` included. It deleted a key composed from the number DynamoDB handed back, which `put` never wrote, and left the reservation in place, so the value couldn't be taken again. A reservation an earlier release left this way stays until you delete it with the raw `DynamoClient`.
- **A key composite storing both a `number` and a `bigint` (`Schema.Union([Schema.Number, Schema.BigInt])`) keeps the keys `put` wrote.** DynamoDB stores `5` and `5n` alike, and hands either back as the number `5`, whose key text isn't `5n`'s. `restore`, the updates that read the item first, a delete releasing a unique-constraint sentinel, `purge`, `rekey` and an aggregate's `update` and `list` read such a value as the kind the keys its row holds say. A `restore` moved a `bigint` item to the number's key, where nothing found it; an update moved its index key or vector partition; a delete left its sentinel behind; an update of another field of a unique constraint over it reserved the new sentinel under the number's key, so a second item could take the same values; `rekey` left a negative value's sentinel at its old text; an aggregate `update` wrote a second edge row. Where no key on the row says, as for a `restore` of a value in an index only or in a unique constraint only, the write fails with a `ValidationError` (`EDD-9128`), writes nothing and keeps the tombstone. A sentinel is found by the owner read the write already makes, which names one more key for such a value. A union of one numeric kind and something else (`Schema.Union([Schema.String, Schema.BigInt])`) reads a stored number back as that kind.
- **`rekey` names a row whose values compose no key.** A row whose own key holds `NaN`, or one of whose key composites holds a value no form of its schema takes, is the conflict `uncomposable`, with the refusal in `message`. It was counted in `skipped.unrecognizedKey`.

What's stored doesn't change.
