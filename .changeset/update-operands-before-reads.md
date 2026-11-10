---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

An update or `patch` whose `.append()`, `pathSet`, `pathAppend`, `pathPrepend` or `pathIfNotExists` operand its schema refuses now fails with a `ValidationError` before it reads or sends anything, on its own and in `Transaction.transactWrite`. The refusal used to be made as the write was built, after the reads of an update that reads first (a `versioned: { retain: true }` entity's, and every update `Transaction.transactWrite` plans), so those reads were sent for nothing, and a read that failed was reported as a `DynamoError` in place of the `ValidationError`. An operand the schema accepts sends the same requests as before.

An operand is checked where the library can resolve exactly what reads its position back: through structs, records, lists, tuples, unions, suspended schemas and `Schema.Class`es. Anywhere else (below a transformed struct or list, a `Schema.Option`, a decoding default, a packed field) it is sent as before, unchecked.

A path naming a sparse map's entry by its stored name (`pathSet` or `pathIfNotExists` of `["buckets#a", "n"]`) is now checked against what the row's reader reads there. It was checked against nothing: in a transaction the value was committed, and an update on its own wrote it and then failed reading back the row it had just written. A value the reader reads back is written exactly as before, so a number given where the map's schema stores numeric text is still sent as a number. A value it doesn't read back as given is encoded as `put` encodes it (a `Date` was written as given, as an empty map), and refused when the reader doesn't read that either.

A path into a union can't tell which member the stored value is. An operand 1.39.0 accepted and read back is written as 1.39.0 wrote it, and one it refused is still refused. A path op into a union whose members encode the value differently writes it as before (as given under a sparse map's entry, in the first member's form elsewhere), so set the whole value instead. It's refused, with nothing sent, when the reader wouldn't read the value as written and the members would store it differently. An append to a union of lists (`Union([Array(Number), Array(String)])`) is now checked against each list's elements: it was sent unchecked, and elements neither list takes left a row that no longer decoded.

In `Transaction.transactWrite`, a planned update's or delete's condition (every update, and the delete of a `unique`, retained or `softDelete` entity) holding an empty part or a value DynamoDB can't store, such as `NaN`, now fails the transaction with a `ValidationError` before any op reads, as a put's and an unplanned delete's already did. It was checked only after the reads, and a value DynamoDB can't store was a defect.
