# @effect-dynamodb/language-service

## 1.41.0

### Minor Changes

- [#253](https://github.com/jmenga/effect-dynamodb/pull/253) [`32c5337`](https://github.com/jmenga/effect-dynamodb/commit/32c53376922bd1e83f652e7beb0a7fb8a4f7a49b) Thanks [@jmenga](https://github.com/jmenga)! - Add `Entity.insert`, which writes through a PartiQL `INSERT` so that a role holding only `dynamodb:PartiQLInsert` can add items and IAM stops it changing them. It stores what `put` would store, in one write with no reads (an entity with `refs` still reads each referenced item, as `put` does), and fails with the new `ItemAlreadyExists` when the key is taken. An entity with `unique` constraints sends one `INSERT`-only transaction. `versioned: { retain: true }` is refused (`EDD-9110`). See the [Add-only writes](https://jmenga.github.io/effect-dynamodb/guides/add-only-writes/) guide.

  `DynamoClientService` gains `executeStatement` and `executeTransaction`, which a hand-written full mock of the service must add.

- [#246](https://github.com/jmenga/effect-dynamodb/pull/246) [`ee78d3e`](https://github.com/jmenga/effect-dynamodb/commit/ee78d3e65fa9c0fb5ab05de32076480788c8cd4b) Thanks [@jmenga](https://github.com/jmenga)! - **An aggregate's `delete` now deletes only its own rows.** It deletes the rows of its partition whose `__edd_e__` is one of the aggregate's entity types (its root's, each edge's and each sub-aggregate's, at any depth) and leaves every other row there: an entity's, another aggregate's, a row with no entity type. Up to 1.40.0, and on 1.39.0, it deleted every row its read returned, so an entity or another aggregate sharing the partition lost its rows too. If you relied on `delete` clearing the whole partition, delete those rows yourself. The read is the one sent before, a row of one of the aggregate's types is still deleted whoever wrote it, and a partition holding only the aggregate's rows gets the same requests as on 1.40.0. A partition holding rows but none of the aggregate's now fails with `AggregateAssemblyError` and deletes nothing, as an empty partition does; 1.40.0 deleted those rows and succeeded.

  **An entity's `refs` fetch the referenced entity under its key.** `Entity.make({ refs })` fetched a referenced entity under its `DynamoModel.identifier`, while the `${field}Id` it takes is the entity's key composite, as aggregate edges have used since 1.40.0. A ref entity whose identifier is another field than its key failed every `put`, `upsert` and `update` naming the ref with a `ValidationError` (`get.decode`, `Missing key`, or `put.decode` for a number key), on 1.39.0 too; it is now fetched under its key composite, and `rekey`'s read-back of the ref, the `.within()` row check and cascades read that composite. A ref entity whose identifier is its key sends and stores what it did. A ref entity keyed by more than one composite is fetched under its identifier, as before: where the other composites are filled in when the key is encoded (an encoding default) the ref is fetched and stored as on 1.40.0, and where they aren't the write fails as it did (`get.decode`, `Missing key`).

  **A cascade from an entity keyed by a number finds the rows that reference it.** It queried the ref's index with the id as unpadded text (`teamid_5`), while a `put` stores the padded key text (`teamid_0000000000000005`), so it updated nothing, on 1.39.0 too. It now reads the key text the rows are stored under. Rows that an earlier cascade missed still hold the old copy of the referenced entity until the next update of that entity cascades to them. A cascade from an entity whose identifier isn't its key read the identifier and sent no query; it now cascades.

  **A cascade stores the referenced entity as a `put` naming it stores it.** A cascade (`update(...).cascade({ targets })`) wrote the referenced entity's domain values as they were, where a `put` stores them encoded: a `Schema.Redacted` field was stored as an empty map, after which every read of the referencing row died (`Unable to get redacted value`); a date as its `DateTime`'s internal fields (read back as the same instant, in no encoding a `put` writes); a `Schema.NumberFromString` as a number. A ref stored under another attribute (`DynamoModel.configure(Player, { team: { field: "teamData" } })`) was written under its field name, so the row gained a `team` attribute its model doesn't declare and `teamData` kept its old copy, which every read returned. Both on 1.40.0 and 1.39.0, for every string-keyed referenced entity. A cascade now writes exactly what a `put` naming the entity writes, one function encoding both, into the attribute the ref is stored in, encoded as every update encodes a field. **Rows already stored:** a row a cascade corrupted keeps what it holds until its ref is next written (the next cascade from that entity, or a `put` or `update` naming it), which rewrites it in its stored form; a row holding a stray `team` attribute beside its renamed ref keeps that attribute, which nothing reads.

  **Every write keys the indexes a ref's id is a composite of, as `put` does.** For an entity with `refs`, an index keyed by a `${field}Id` (a cascade index, or one of your own) is now keyed from the id given by `upsert`, and by an `update`, `patch` or `Transaction.transactWrite` update that reassigns the ref (`.set({ teamId })`), through the index's policy like any other composite. On 1.40.0 and 1.39.0 `upsert` wrote no key for such an index, and an update reassigning the ref kept the old key, so a cascade from the entity the row names missed it, and one from the entity it used to name rewrote it with that entity. A write that doesn't name the id sends what it did. **Rows already stored:** a row an earlier `upsert` wrote, or whose ref an earlier update reassigned, keeps its missing or old key until a write names its ref again, and until then a cascade misses it; `db.tables.<Table>.rekey({ repairIndexKeys: true })` rewrites those keys (with `dryRun: true` it only counts them).

  **A ref to an entity keyed by a transformed field works.** A `${field}Id` is taken as a value of the referenced entity's key, so an entity keyed by a `Schema.NumberFromString`, `Schema.BigIntFromString` or `DynamoModel.DateEpochSeconds` field is fetched; every `put`, `upsert` and `update` naming one failed with a `ValidationError` (`get.decode`) on 1.40.0 and 1.39.0. A stored ref's id is read back the same way. For an entity keyed by a date stored as epoch milliseconds (`storedAs(DynamoModel.DateEpochMs)`), a `.within()` bound on the id matched no row, and `rekey({ repairIndexKeys: true })` judged a correct row's cascade key lagging and rewrote it as epoch text, which every cascade then missed; both now read the id as the date it is. **Rows already stored:** a row such a `rekey` rewrote is now judged lagging, and the next `rekey({ repairIndexKeys: true })` rewrites its key back.

  **A ref to an entity with a required `DynamoModel.Hidden` field works.** A ref holds what a read of the entity returns, which leaves its hidden fields out, and `put`-time hydration, an aggregate's `create` and a cascade all store that. The read of the ref decoded it as the whole entity, so with a hidden field required, a `put` naming the ref wrote its row and then failed with a `ValidationError` (`Missing key at ["team"]["secret"]`), as did every read of the row, under every lifecycle (plain, `versioned: { retain: true }`, `unique`, `softDelete`), on 1.39.0 too; an aggregate's `create` holding such a ref in a `one` edge, a `many` element (the entity itself, or a field of a wrapper element) or a sub-aggregate failed the same way, or stored rows it then couldn't read. It now reads the ref as the entity's own read does: its other fields, as a plain object, not an instance of the entity's class. That is the only change, and only where 1.40.0's read failed: wherever 1.40.0's read returned an instance of the entity's class (every hidden field optional, or with a default, or none hidden), it returns the same instance, with the same fields, in every one of those places. Rows are stored as before, byte for byte, and the rows such a write left behind now read. An aggregate ref whose hidden field is `Schema.Unknown`, `Schema.Any` or `Schema.UndefinedOr` fails `create` in a `one` edge or a `many` element as it did on 1.40.0. Two levels deep (`League` refs `Club`, which refs `Team`, whose hidden field is required), `League`'s write still fails, as on 1.40.0: its ref's read builds a `Club` by the class's constructor, which checks `team` as a whole `Team`.

  **A ref the model declares optional can be left out.** With `Schema.optionalKey(Team.pipe(DynamoModel.ref))` or `Schema.optional(Team).pipe(DynamoModel.ref)`, `teamId` is optional in `put`, `create` and `upsert`, in their types too: nothing is fetched, and the row stores no ref and no key of an index keyed by `teamId`, so a cascade skips it. `.remove(["team"])` removes the ref, and the row leaves that index. On 1.40.0 the id was required (`Missing key`) and removing the ref was refused; on 1.39.0 the id was required and `.remove(["team"])` removed the ref, leaving a row every read then failed (`Missing key`), which now reads without it. A required ref is unchanged. `.remove(["teamId"])`, `.set({ teamId: undefined })` and `pathRemove(["team"])` are still refused, and for an optional ref their message now names `.remove(["team"])`.

  **A value that keeps what it's given reads as on 1.40.0.** A value of `Schema.Unknown` or `Schema.Any` (alone, behind `Schema.suspend`, or in a union) is stored as its row's attributes, so its row is its value, and a read hands it back with what the library stores beside it on that row: a sub-aggregate's discriminator, a `one` edge's own, the root fields `context` copies onto every edge's row, the partition key attribute under a name other than `pk` and, with a collection index, the collection sort key's copy, as on 1.40.0 and 1.39.0. Nothing stored tells those from keys the value held itself, so such rows read exactly as before.

  **`create` refuses a value a `get` wouldn't return.** On every row it writes, the library writes attributes of its own over what the row's value holds there: `__edd_e__`, the partition key attribute, `sk`, the collection sort key's copy, the root's list keys when the write composes them, and, on every row beneath the root, the root fields `context` copies there. Up to 1.40.0 a value given for one of those names was replaced by the library's, and a read handed back something else: the library's value, its stored text where the member declares the name in another form, nothing, or a failure. `pk: { field: "id", composite: ["id"] }` read `id` back as `$app#v1#orders#a`; `{ text, tenantId: "t2" }` under `context: ["tenantId"]`, on a root holding `t1`, read back `t1`; a member declaring `v: Schema.Number` under a root's `v: Schema.NumberFromString` failed every read (`Expected number`); a `many` edge's sort key composite named `sk` failed every read (`Missing key`). A `create` is now refused with `EDD-9159` and `AggregateDecompositionError`, nothing written, exactly where a `get` right after wouldn't return the value given: each row as the write builds it is read the way a `get` reads that member (its packed attributes unpacked, renamed, decoded by the member's own schema), and what it reads is compared with the value given: a set by its members, a date by its instant (and zone where the type carries one), a class, `Option` or `Data` value structurally, and otherwise strictly, as a read returns it: `5n` is not `5`, `-0` is not `0`, and a `BigDecimal` is its digits and its scale (`1.5` is not `1.50`), each of which 1.40.0's `get` handed back as the root's value. The comparison leaves the value given untouched. Equal, and the `create` is written byte for byte as on 1.40.0; different, or a read that fails there, and it is refused. A member given no value for a `context` field it declares in another form than the root is refused where the root's value doesn't read as it (a root's `Schema.NumberFromString` under a member's `Schema.Number`), which 1.40.0 stored and then failed every read of. The message names the member and the field and shows the value given and what the read would return, each so the two can be told apart (`"5"` and `5`, `Set { "a", "c" }`, `6n`, `DateTime.Utc(…)`), or the read's failure. It applies to the root's row, a `one` edge's value, a `many` element, a sub-aggregate's root (a root or sub-aggregate whose schema is a union or `Schema.suspend` read whole, by the schema `get` decodes it with), and a `many` edge with a custom `decompose` or `assemble` (read whole, through them), and to a `many` value given under its `inputField`, at the root or beneath a sub-aggregate. Not judged, and written and read as on 1.40.0: a name given no value (an optional field left out, a decoding default) whose read succeeds; a discriminator (below); a name the library doesn't write on that row, such as an index key name no list key composes there (`gsi1pk` on an edge, or on a root whose list composite has no value), which a read takes off as before, and a timestamp the library stamps; and a value nested below the top level. `Aggregate.make` refuses nothing. **`update` isn't judged:** a value given there for such a name is replaced by the library's, as on 1.40.0. The state an update mutates is the one its read gave, and what the read filled in (a context copy, a key's text, a discriminator) can't be told from what the caller set, so judging it would refuse updates 1.40.0 made. Rows already stored read as before. **To repair a refused `create`**, give the value the read returns, leave the field out of the value, or rename it; on rows already written a renamed field holds nothing until the aggregate is next written, so declare it optional until then.

  **A discriminator stays the library's to fill:** a field named like a sub-aggregate's discriminator or a `one` edge's own is written with the discriminator's value whatever the value holds there, and read back so, as on 1.40.0, so an `update` copying an element from one sub-aggregate to another of the same model works as it did.

  **A field a row's value declares now reads back even when its name begins like an index key** (`gsiNote` on a `one` edge, `skills` on a sub-aggregate with edges of its own, an optional `gsi2pk` on a root with no list key of that name), which 1.40.0 and 1.39.0 took off every read, failing it (`Missing key`) or leaving the field out; a name the value doesn't declare is taken off as before, another writer's index key included. An optional one such a read left out was then missing from an `update`'s state, so 1.40.0's next changed write of its row dropped it from the row; that write now keeps it.

  **An aggregate's `update` returns 1.40.0's object, each context copy as its row holds it.** It returns the state the mutation produced, as decoded, as 1.40.0 did: the same classes, element order and own properties (an explicit `undefined` stays). One thing changes: where a member's value holds a copy of a `context` field, the copy is set to what its row holds after the write. 1.40.0 returned the copy the state was read with, so after an update changing the root's context field it returned the old value on every member, where a `get` read the new one. A copy is corrected, never added or removed, and the value holding it is built as a read builds it: a `Schema.Class` instance by its class's constructor, so its private fields and methods work; an object no constructor of a schema builds (an instance of a class of your own under `Schema.Unknown`) is returned as the mutation gave it, as on 1.40.0. A `many` edge with a custom `decompose` or `assemble` returns its elements' copies as 1.40.0 did, since which row a copy came from can't be told there. No request is added. A `get` right after still reads otherwise where it did on 1.40.0: `many` elements the mutation holds out of key order (a read returns key order), a custom `assemble`'s derived values, a discriminator or a key attribute the value holds another value in (a root field that is also a list key attribute holds the key's text), a name a read takes off, the copies a read hands back inside a `Schema.Unknown` value the update added, and another writer's write in between.

  **An `update` repairs context copies a failed write left behind.** A write copies the root's `context` fields onto every row beneath the root. When an update changed a context field and a later group's transaction failed after the root's committed, the rows of the groups not written kept the old value, and 1.40.0 left them so until something else in their group changed. A group one of whose rows holds a copy that differs, read through its member, from the root's stored value now counts as changed, and the next `update`, its retry included, writes it. An attribute the library manages on each row is never a copy, whatever `context` names: a discriminator, a timestamp it stamps, a key attribute (the partition key, `sk`, the collection sort key's copy, a list key). So an aggregate nobody left half-written sends exactly what 1.40.0 sent on every update, a no-op included (one `Query`).

  **A `many` value given under its `inputField` is taken whether or not the `create` fetches an id.** 1.40.0 renamed it to its field only when an id was fetched, so a `create` with nothing to fetch failed with a `ValidationError`, though the input type names the field so. It is now stored and read as the same value under its field's name is, request for request.

  **An `update` over rows the other `escapeKeys` setting keyed is refused until `rekey` moves them.** A sort key built from a `many` element's composites or a discriminator value composes different text under the two settings when it holds a `$`, `#` or other escaped character, a number other than a non-negative integer below 1e16 (a fraction, a negative, a date stored as an epoch before 1970), or a negative `bigint`; so does an `entity:` edge's composite its model encodes (`Schema.NumberFromString`). Up to 1.40.0 an update writing such a group after the setting was turned over put its rows under the new text beside the old, so every element read twice, a sub-aggregate whose root was doubled failed to read, and where one value's text under one setting is another's under the other (`a b` escapes to `a%20b`) one element's row overwrote another's. Before writing a group, an update now compares the key of each row it read for it with the key this configuration composes for the same value, through the function the write keys rows with; any difference fails the update with `EDD-9160` and a `ValidationError` naming the member, both keys and `rekey`, after its read and before anything is written. Run `db.tables.<Table>.rekey()` to move the rows, then update. Not refused, and sent as before: an update that doesn't write such a group, every key whose text is the same under both settings, and an `entity:` edge's rows 1.40.0 wrote, which an update under `escapeKeys: true` moves itself. `delete` removes the rows it reads, under either setting, as on 1.40.0.

  **A `many` element whose schema shows no fields of its own is stored in its stored form.** An element that is a union (a member renaming a field among them), a `Schema.NullOr`, or a transformation of the whole element (`Schema.encodeKeys`, a struct decoded to another) is now encoded through its schema, once, as every other attribute is, whether it's given as its domain value or already in its stored form. Up to 1.40.0 nothing encoded it, so it was stored as the domain value it held: a union member storing `line` and holding `text` was stored under `text`, a `Schema.NumberFromString` in a union member as a number (`N`), and a `Schema.DateTimeUtcFromString` in a `Schema.NullOr` as a `DateTime`'s internal fields (a map). It's now stored as its schema encodes it (`line`, `S` `"5"`, ISO text). 1.39.0 stored the same, and refused a renaming member's domain value; given its stored form, it stored `text` and couldn't read it back (`Missing key`), and those rows read now. Reads return the value as before, with one difference: a union member that transforms its value is read through its transformation, which takes only its own fields, so a sub-aggregate's discriminator that 1.40.0 handed back inside such an element stays out of one stored in its stored form. Keys don't change. An element whose schema shows its fields (a struct, a class), an element that is a ref, and an edge with a custom `decompose` are stored as before. **Rows already stored keep the domain value until their group's next changed write: they switch per group, never on a no-op.** A read takes either form. An `update` that changes nothing writes nothing; one that changes a group rewrites every row of that group, as it always has, with the element in its stored form; the aggregate's other groups keep what they hold. So until each group is next changed, one attribute can hold the domain value on some rows and the stored form on others: `text` on older rows and `line` on newer ones, a number on older rows and text on newer ones. A filter on it (`aggregate.list({ filter })` or a query of your own) has to allow for both forms, and a secondary index of your own keyed on such an attribute rejects writes in the form its `AttributeType` doesn't name: DynamoDB refuses an item whose index key attribute has another type. Such an index has to be keyed on another attribute before you upgrade.

  **An aggregate stores a date declared `Schema.optional` in the encoding it declares**, as an entity's write of the same model does: `due: Schema.optional(DynamoModel.DateEpochMs)` is stored as a number (`N`), where 1.40.0 and 1.39.0 stored it as ISO text (`S`), on the root, an edge, a `many` element or a sub-aggregate. Timestamps the library stamps into such a field follow the same rule, and a row that doesn't declare the field holds the root's form. Key text doesn't change: a collection, list or `many` sort key over such a date, passed or stamped, is composed as it was, byte for byte. **Rows already stored keep ISO text until their group's next changed write: they switch per group, on that group's next changed write, never on a no-op.** A read takes either form. An `update` that changes nothing writes nothing, as before. An `update` that changes a group rewrites every row of that group, as it always has, and writes them in the declared encoding, a kept `createdAt` included (the same instant); the aggregate's other groups keep what they hold. So until each group is next changed, one attribute holds ISO text on some rows and a number on others. A filter on it (`aggregate.list({ filter })` or a query of your own) compares like with like, so a condition written against ISO text no longer matches the rows written since, and one written against a number doesn't match the older rows; write it for both forms, or rewrite the aggregates first (an `update` that changes them). A secondary index of your own keyed on the attribute itself, with `AttributeType: "S"`, rejects the new writes: DynamoDB refuses an item whose index key attribute has another type. Such an index has to be keyed on another attribute before you upgrade.

  **Under `escapeKeys: true`, an aggregate's `entity:` edge composes its sort key as a plain edge does.** Up to 1.40.0 a `many` edge declaring `entity:` composed its declared sort key from the field's stored text, where a plain edge composes it from the value: `byn#5` where a plain edge writes `byn#0000000000000005`. With `escapeKeys: true` it now composes it from the value. With `escapeKeys: false`, the default, nothing changes: every request and row is 1.40.0's, byte for byte. A row is affected when all four hold: the table has `escapeKeys: true`; the row is an element of a `many` edge declaring `entity:`; a composite of the edge's declared `sk.composite` is a field of the element, or a path into one (`entry.n`), whose top-level name is a field the entity's model encodes (its schema, optional or not, is a transformation: a codec, a date stored as a number, a `Schema.Class`); and that composite's text, read off the encoded field, differs from its value's text. That includes a wrapper element's own field named like an encoded field of the entity's model (the wrapper's `n: Schema.Number` beside the entity's `n: Schema.NumberFromString`), which 1.40.0 ran through the entity's encoder. Each sort key segment, 1.40.0's and now, measured:

  | Field the entity's model declares                                                                                                                                                     | 1.40.0                                        | Now                                      |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------- |
  | `Schema.NumberFromString` `5`                                                                                                                                                         | `5`                                           | `0000000000000005`                       |
  | `Schema.BigIntFromString` `5n`                                                                                                                                                        | `5`                                           | `00000000000000000000000000000000000005` |
  | `DynamoModel.DateEpochMs`, `storedAs(DynamoModel.DateEpochMs)`                                                                                                                        | `0001714979289000`                            | `2024-05-06t07:08:09.000z`               |
  | `DynamoModel.DateEpochSeconds`                                                                                                                                                        | `0000001714979289`                            | `2024-05-06t07:08:09.000z`               |
  | `Schema.DateTimeZonedFromString`                                                                                                                                                      | `2024-05-06t09:08:09.000+02:00[europe/paris]` | `2024-05-06t07:08:09.000z`               |
  | A codec of your own whose stored text differs (`x` stored as `x `, `A` as `41`)                                                                                                       | `x%20`, `41`                                  | `x`, `a`                                 |
  | `Schema.optionalKey(Schema.NumberFromString)` `5`                                                                                                                                     | `5`                                           | `0000000000000005`                       |
  | A path into a field encoded as a whole: `entry.n` of a `Schema.Class` whose `n` is a `Schema.NumberFromString`, or of a codec of the whole object (`{ n: 5 }` stored as `{ n: "5" }`) | `5`                                           | `0000000000000005`                       |

  Not affected: `Schema.DateTimeUtc` and `Schema.DateTimeUtcFromString` (ISO text either way), a path into a `Schema.Struct` (`entry.n` where only `n` is transformed: the struct isn't encoded for a key), a path into a `Schema.Class` whose leaf isn't transformed, a union or `Schema.NullOr`, an edge with no declared sort key (keyed by the entity's identifier), plain edges, `one` edges, roots, sub-aggregates, partition keys, discriminators and context values.

  **Rows already stored, with `escapeKeys: true`:** they read as before, with the same request. A group's next changed `update` moves its rows: it writes the group under the new keys, as it always writes a changed group whole, and deletes in the same transaction each row it read under 1.40.0's text, each row keeping its `created`. An `update` that changes nothing writes nothing, and `delete` removes the rows under either text. **Who must run `rekey`: on an `escapeKeys: true` table, a group whose rows plus its rows under 1.40.0's text come to more than 100 can't be updated until `db.tables.<Table>.rekey()` has run. Every other group needs nothing.** A group's write is one transaction of at most 100 items: one for each row of the group, and one more for each row it moves, the delete of the row under 1.40.0's text beside its write under the new text. A root group holding the root and 49 such rows is 99 items and moves on its next update; with 50 it is 101. A group holding other rows counts them too: the root, 9 rows that don't move and 45 that do are 100 items, and with a tenth row that doesn't move, 101. Over 100 the update fails with `AggregateTransactionOverflow`: that group writes nothing and its rows still read as before, while groups the update wrote before it stay written, as on any group's failure (the error's `committed` names them), and its message says how many of its items are those deletes and that `rekey` moves them. `rekey` (`dryRun: true` to count first) moves them, after which the update goes through. A group too large without its moves fails as it did, and its message names no `rekey`. Turning `escapeKeys` on later moves 1.40.0's rows to the new text with the rest, through `rekey`, and turning it off moves rows back.

  **With `escapeKeys: true` and an `entity:` `many` edge keyed by an affected composite, move every writer to 1.41 together: a 1.40.0 writer left beside this release doubles the groups this release has written.** Reading such a group, 1.40.0 writes it under 1.40.0's key text beside the rows this release stored and deletes none of them, so every element is stored twice, and an element it removes stays under this release's text, where every read, its own included, finds it again. This release reads two rows of one element that hold the same value (they differ only in key text and in the timestamps the library stamps) as the element once; the group's next changed `update` deletes the copies under 1.40.0's text, each element keeping its row's `created`, and `rekey` deletes them too. Two rows of one element that differ, because 1.40.0 changed the element, read as two elements: a write of the group holding both is refused with `AggregateDecompositionError` naming both rows, nothing written, and `rekey` reports them (`bothKeys`, naming both) and moves nothing of the aggregate. **To repair a group a 1.40.0 writer touched**, `update` the aggregate stating the elements the group should hold, one for each key, leaving out any element 1.40.0 removed: that write stores exactly those under this release's text and deletes the rest.

  **Two elements that compose one key now.** The new key text drops two distinctions 1.40.0's stored text kept: letter case under the default `lowercase` casing (or `uppercase`), through a codec whose stored text keeps it (a hex or base64 codec, `A` and `a`), and a zoned date's zone (one instant in two zones, through `Schema.DateTimeZonedFromString`). On 1.40.0 such a pair was two rows; a plain edge refuses it. The pair reads as before. A changed `update` of its group is refused with `AggregateDecompositionError`, the error a plain edge gives (`"cased" and "cased" both compose the sort key …`), and nothing is written; an `update` of another group of the aggregate goes ahead. On either setting an `update` now refuses a pair only in a group it writes, where 1.40.0 refused any `update` of an aggregate whose stored rows held one. `rekey` reports the aggregate `failed` with that reason and moves none of its rows. To repair it, remove one element of the pair, or change it so the two differ, with an `update`: that update writes the group under the new keys and deletes the old rows, and `rekey` then has nothing to do.

- [#251](https://github.com/jmenga/effect-dynamodb/pull/251) [`5119bad`](https://github.com/jmenga/effect-dynamodb/commit/5119badc4603bfa78bbf11f336d3f05e25b6b8e3) Thanks [@jmenga](https://github.com/jmenga)! - Effect's own value types: packed storage, key composites, and two fixes found on the way.

  **Run `rekey` first if you ran 1.38.0, 1.39.0 or 1.40.0 with `effect` 4.1.3 and a key or a unique constraint holds a zoned date or a named zone, at any depth (a list of them, a tuple, an `Option`), whose id the runtime resolves to a different id (an alias such as `Etc/UTC`, `GMT` or `US/Pacific`, or a renamed zone such as `Asia/Kolkata`): run `db.tables.<Table>.rekey({ repairIndexKeys: true })` before the table serves traffic on 1.41.0. Those releases keyed such a row by the name the zone was given, and 1.41.0 keys it by the name the runtime resolves it to, the key 1.40.0 composed on `effect` 4.1.2. `rekey` moves those rows, their snapshots, tombstones, time-series events, unique sentinels and aggregate rows, and rewrites their index keys. Before it runs, 1.41.0 treats such a row as absent, as at any key holding nothing: `get` reports `ItemNotFound` and an index accessor returns nothing; an `update` reports `ItemNotFound` and writes nothing; a `delete` reports success and leaves the row, except on an entity with a unique constraint or soft delete, whose delete reads the item first and reports `ItemNotFound`; an aggregate's `get`, `update` and `delete` report `AggregateAssemblyError`; a `put` writes a second row beside it, which `rekey` then reports as `bothKeys` and leaves; and the unique value the row holds isn't enforced, so another item can take it: then every `rekey` reports the row `taken` and leaves the row as it was (its zones and its index keys) and that value's sentinel where it is, as a dry run says, both items holding the value, until the other item lets go of it (a `delete`, say), after which the next `rekey` moves the sentinel and rewrites the row in one run and the value is enforced again. Separately, and for every named zone those releases stored on `effect` 4.1.3, whatever its name, not only an alias in a key: an equality condition or filter on a named-zone field, or a zoned date's, doesn't match the rows they wrote, on either Effect, as they stored the zone with its `resolvedId` (a date's text under the name given); `rekey` rewrites those values in the same pass (`zonesRewritten`) wherever the schema puts a zone in an entity's field, and leaves a zone in a sparse map's entries, in an aggregate's rows under their current keys, in an event stream's events and in an untyped field as 1.40.0 left it, matched once the row is next written. The resolved name is what the runtime's `Intl` makes of a zone's name, as it has been since 1.38.0, so it depends on the runtime's time zone data: a runtime that resolves a zone to another name keys it under another text.**
  - **Packed storage takes Effect's instances.** A packed write refused a real `Duration`, `BigDecimal`, time zone, cookie or cookie jar, `UrlParams`, `SemVer` / `SemVerRange`, address, network, interface or host, DNS record, `Option` or `Result` ("an instance of Object"), in an entity's packed field, an aggregate edge's, event data and an inline snapshot alike, though a native attribute stores each as a map and reads it back. Each is now packed as that map, keys in the order DynamoDB Local hands it back, as a real `DateTime` already was: exactly the bytes 1.40.0 packed for the map a native read hands back for it. Where the schema declares one it reads back as the instance, which writes back as the same bytes; in a `Schema.Unknown` it reads back as the map, as it does natively. What JSON can't hold is still refused at its path: a `MacAddress`'s or a TLSA record's bytes, a `BigDecimal` or a `Duration` past 2^53, and a bigint, a `Date` or bytes inside an `Option` or a `Result`. Nothing 1.40.0 packed changes by a byte, with one exception: a named zone's map holding a `resolvedId` (what 1.40.0 packed for every named zone on `effect` 4.1.3, and any map in an untyped field shaped like one) is packed as 1.40.0 packed it on 4.1.2, its `id` the resolved name and no `resolvedId` (below).
  - **Effect's look-alikes as key composites.** A `Duration`, `BigDecimal`, time zone, `UrlParams`, `SemVer` / `SemVerRange`, address or DNS record composite, or an `Option` or `Result` holding one, was refused with `EDD-9128` (a row read back composed `[object Object]`). A key read back from a row now composes from the instance it stands for, so it's the key `put` wrote, and rows 1.39.0 wrote under such a key are found, restored, updated and released as before. `restore` of a 1.39.0 tombstone lands under the key `put` wrote, an aggregate `update` of such a root works, and `rekey` moves none of these rows. An item 1.39.0's or 1.40.0's `restore` put back under `[object object]`, where `get` didn't find it, is moved by `rekey` to the key `put` wrote, with its index keys; the unique sentinel that `restore` wrote there is left and counted `unrecognizedKey`, and the value stays reserved by the one `put` wrote, which moves with the item when `escapeKeys` is turned on. `rekey` reads each composite of a key as each earlier release keyed it, in every combination (up to 64 readings of a row, each release's reading by itself always among them, and two readings composing one key text counted as two; a row past that is left and counted `unrecognizedKey`), so an item 1.39.0 restored on `effect` 4.1.3 under a key holding both a map's text and a zone under its given name is moved too. A `Cookie` or `Cookies` composite stays refused.
  - **A named time zone is stored the same on Effect 4.1.2 and 4.1.3.** Effect 4.1.3 gave a named zone a `resolvedId` and kept the name it was made from (`Etc/UTC`, where 4.1.2 resolved it to `UTC`), so on 4.1.3 every stored named zone, native or packed, gained an entry, and a zone made from an alias was stored, keyed and written as ISO text under another name. A named zone is now stored, keyed and compared as 1.40.0 stored it on 4.1.2, whichever Effect is installed, however it's reached (in a date, an `Option`, a list, an untyped field, behind a getter) and whether it was made or read: two zones Effect holds equal have one key text, unique sentinel and ISO text, wherever the schema puts them (a list or a tuple of zones or of zoned dates, an `Option`, a `Result`, a struct or a record in one, a union, a class instance in an `Option`, a list or an `Option` of one of Effect's string codecs). On 4.1.3 a list of zones keyed `timezone.named(etc/utc)`, so a `get` with the zone made from `UTC` didn't find the item and a unique constraint took both names. A zone already stored with a `resolvedId` reads back as the same zone on either Effect (where no schema types it, as the map it is, as 4.1.2's map always has), and is written in 4.1.2's form the next time the item is written; an `update` that doesn't touch the field leaves it as it is. `rekey` rewrites every such zone, and a zoned date's text naming the zone as given, wherever the schema puts one in an entity's rows (a field, a list, an `Option`, a struct, a packed field; items, snapshots, tombstones and time-series events), in place under a condition that each attribute is still as read, or in the row's move, and counts them in `zonesRewritten`; a value no schema types, Effect's codecs' text, a sparse map's entries, an aggregate's rows under their current keys and an event stream's events keep theirs, left as 1.40.0 left them until the row is next written, and a row holding none costs no request. Effect's own string codecs (`Schema.TimeZoneNamedFromString`, `Schema.TimeZoneFromString`, `Schema.DateTimeZonedFromString`) are Effect's, and still write the name the zone was made from on 4.1.3: the stored string for an alias zone differs after an upgrade from Effect 4.1.2 to 4.1.3 (`Etc/UTC` where 4.1.2 wrote `UTC`). Reads take both, and every key composed from such a field (a sort key, an index key, a unique sentinel, a time-series event's key, a `history().where()` bound) names the zone as 4.1.2 did, on either Effect. An equality condition or filter on that attribute compares the stored string, so it matches only the form the row holds.
  - **A condition or filter on a date, a `Redacted` or a `DurationFromMillis` compares what the row holds.** An operand that is one of Effect's instances was sent as the instance's map, and a `Date` as an empty map, so where the field stores the value another way it matched no row: `eq(t.at, at)` on a `Schema.DateTimeZoned` or a `Schema.DateTimeUtc` (stored as ISO text, or as a number under `storedAs`), a `Schema.Redacted`, a `Schema.DurationFromMillis` or a `Schema.Date` never matched, and a condition naming one always failed. Such an operand is now sent as a write of it there stores it, wherever the schema alone decides that: every way a row can hold the compared path (each member of a union holding it) that takes the value stores it the same. Where it doesn't (members of a union storing the path differently, an `Unknown` or `Any` on the path, a suspended schema, an `Option` or a class the path goes into) the operand is sent as 1.40.0 sent it. It covers every comparator, `between`, `isIn` and `contains`, callback or shorthand, in an entity's conditions (a transaction's included), a query's, scan's or collection's filter, `Entity.filter`, `Query.filterExpr` on an entity's query, a vector search's filters and an aggregate's `list` filter. `contains` compares an element of what the field stores: a member of a set (`Schema.ReadonlySet`, stored as DynamoDB's set), an element of a list, or a substring of text. A `.where()` bound already composed its key text. An instance whose map is what the field stores (a zone, a `Duration`, a `BigDecimal`, an `Option` of a number, any value in an untyped field) is sent as the same bytes, and any other operand as given, a plain map or list holding instances included. Finding an instance reads the operand's prototype once, which a `Proxy` sees as one `getPrototypeOf`. `Transaction.check` takes a condition `Expression.condition` compiled without an entity, and an event stream's query has no entity: their operands are still sent as given.
  - **A time-series `orderBy` stored as a type DynamoDB's `<` doesn't take** (a map: an `Option`, a `Result`, Effect 4's `Either`, a `Duration`, a `BigDecimal`, a named or an offset zone; a list; a boolean) failed every `append` with DynamoDB's bare `DynamoValidationError`, as an append writes only when the stored `orderBy` is below the new one; a nullable `orderBy` failed each append holding null. Each is now a `ValidationError` naming `timeSeries.orderBy`, the field and the type it's stored as (`EDD-9163`), with DynamoDB's error as its cause and nothing written, when the request sent confirms it: DynamoDB named `<` and a type the append's own new `orderBy` is stored as. A refusal of the caller's own condition (comparing the `orderBy`, or anything, with a null, a map, a list or a boolean) is DynamoDB's `DynamoValidationError`, unchanged, as 1.40.0 gave it. Such an entity is still made, and nothing is checked before sending. A struct `orderBy` is refused before sending, as an object composed into a key (`EDD-9162`). A date, a `Schema.DurationFromMillis`, a number, a literal or a `Redacted` string appends as it did, and any other write DynamoDB refuses this way fails as it did.
  - **A value DynamoDB doesn't store, in an untyped field, is refused at write.** In a `Schema.Unknown` or `Schema.Any` position, at any depth, 1.40.0 wrote a `Date` as an empty map and read it back as `{}`, with no error; a `RegExp`, a `WeakMap`, `WeakSet`, `WeakRef`, `FinalizationRegistry` or `Promise` the same; an `Error`'s message and cause were dropped, a `Redacted` was stored as its marker alone, a `Map`'s non-string keys came back as text; and binary data, measured kind by kind on 1.40.0: an `ArrayBuffer`, a `DataView`, a `Blob` or a `File` came back as empty bytes, a `SharedArrayBuffer` as `{}`, a subclass of any of these as the map of its enumerable properties (none of its bytes), and an `Int8Array`, `Uint8ClampedArray`, `Int16Array`, `Uint16Array`, `Int32Array`, `Uint32Array`, `Float32Array`, `Float64Array`, `BigInt64Array` or `BigUint64Array` failed the write with a `DynamoError` holding the AWS SDK's `TypeError`. Each is now a `ValidationError` naming the path (`EDD-9161`), with nothing written, on every write path: `put`, `create`, `upsert`, an update's `.set` and path operations, `transactWrite`, `Batch.write`, a time-series `append`, an aggregate's `create` and `update`, an event stream's events, metadata and snapshot, and a projection's outbox. A packed field already refused each, and now says so in the same words, through the same function. Every other binary kind is stored as 1.40.0 stored it: a `Uint8Array` or a `Buffer` as its bytes, and a `Float16Array`, a subclass of a typed array (a `Uint8Array`'s included) or a kind a later runtime adds as the map of its elements, which reads back as their numbers. A part behind a getter is judged as the write calls the getter, which is called exactly as often as 1.40.0 called it; a getter a list inherits at an index (one on the list's prototype) isn't looked behind, and what it returns is stored as 1.40.0 stored it. At an untyped position the check reads a value's prototypes and descriptors (`getPrototypeOf`, `getOwnPropertyDescriptor` and `ownKeys` traps, and reads of a list's `length`), which only a `Proxy` sees; the payload and its declared fields see exactly 1.40.0's traps, a condition's or filter's operand one `getPrototypeOf` more, and, once a getter in an untyped field has been met in the process, its descriptors are read too. Rows already holding `{}` read as `{}`, a list holding `undefined` still closes up as it always has, and a model without an untyped position pays nothing.
  - **An Effect `Chunk` in an untyped field** died with a stack overflow on every write path, as its empty end holds itself. It's now the `ValidationError` a `HashSet` there gets (`EDD-9124`), naming where it holds itself, with nothing written. Every other Effect collection and data type in an untyped field (`HashMap`, the mutable ones, `Trie`, `Graph`, `Option`, `Result`, `Exit`, `Cause`, `Duration`, `BigDecimal`, `DateTime`, `Redacted`, a `Data` class or tagged class, a `Schema.Class` instance) is either refused with a `ValidationError` or stored as the map of its properties and read back as that map, natively and packed.
  - **An object as a key composite is refused at write.** A struct, a `Data` class or an instance of a class of your own without a `toString` composed the key text `[object Object]`, the same for every value, so items written with different values shared one key and overwrote each other. A write composing a key from one (`put`, `create`, `upsert`, an update recomposing an index key, `append`, a transaction's or a batch's put) is now a `ValidationError` naming the field (`EDD-9162`), with nothing written. Only a key the write composes is refused: an index or a unique constraint missing a value composes nothing, and such an item is stored as before. An aggregate's write is refused the same way: `create` composing its partition key, `collection` sort key, `list` keys or a row's discriminator from such an object, and `update` composing any of them but the partition key, which it composes from the key it's given (up to 1.40.0 a second aggregate with another such partition value failed `create` as already there and `get` given it returned the first, aggregates with different list values shared one list key, and a sub-aggregate bound to such a discriminator was never read back). An `update` leaving the value as it read it writes the row where it is. A `get`, a `delete`, a `list` or a query given such a value still composes that text, so rows already written under it stay reachable. A value with a key form (a `Duration`, a list, a class with a `toString`) is untouched.
  - **A history row whose sort key text holds a line break** (a sort key composite holding one, with `escapeKeys` off) was taken for an item: a scan or a primary-key query returned the snapshot or tombstone as an item, and `rekey` reported it as an unrecognised key. It's recognised as history now.
  - **An aggregate `update` holding a `BigDecimal` that was compared or hashed** died with a defect and wrote nothing: comparing the rows to write with the rows read followed the decimal's cached normalized form, which holds itself, until the stack ran out. It now compares the decimal as it's stored, so an equal decimal writes nothing and another one is written as a fresh decimal of its value.

- [#252](https://github.com/jmenga/effect-dynamodb/pull/252) [`584936b`](https://github.com/jmenga/effect-dynamodb/commit/584936b64563c833da5328509f61b9fb152ad2e4) Thanks [@jmenga](https://github.com/jmenga)! - `rekey`'s report, and the rows one run leaves, no longer depend on the order its visits meet the rows in. Each row, aggregate partition, event stream and unique reservation is judged once a run, by whichever visit reaches it first (the scan, or the move of a row it's in the way of), and counted once whoever judged it. An item's live row and its tombstones, which all name the item's key, are told apart through delete and re-create cycles whose keys chain across the settings: up to 1.40.0 a tombstone without `preserveUnique` could take the sentinel the live row held, so the live value could be taken again, and with `preserveUnique` a chain could end in `bothKeys` or need several runs, depending on the order. A run no longer meets its own writes: the scan passes a row the run put, and `scanned` counts each row stored when the run met it once, so a row moved before its segment was scanned is still counted and a row written ahead of the scan isn't counted again, or as `unchanged`. Aggregates sharing a partition are placed by which row is stored at a key, not by which keys are held, so three whose escaped sort keys chain all move in one run, whatever the order. A dry run sees what its earlier decisions would have written, so it reports what the run does, from a table a run cut short too: for an event stream already part-moved it plans only the copies the run sends, and judges the rows left under the old key as the run does, where 1.40.0 reported moved a stream whose left rows the run refuses as `bothKeys`. Up to 1.40.0 a chain could report `moved: 1` plus `unchanged: 1` where the dry run said `moved: 2`, a sentinel cycle across constraints `sentinelsMoved: 0` after moving all four, and three segments `scanned: 3` against a dry run's 4. Dense chains now finish in one run: a sentinel in a moving row's way moves out by itself, naming its row where it is, instead of with its row, so a row and another item whose key and sentinel chain the other way no longer wait on each other. Up to 1.40.0 about one dense random table in ten ended with conflicts no rerun cleared. A tombstone without `preserveUnique` no longer points a live item's sentinel at itself where its item's key under the other text is that live item's, and under `preserveUnique` a sentinel naming an item is attributed to the row of it whose value it holds. A unique sentinel no row holds, counted `skipped.unrecognizedKey` without `reservations` as 1.40.0 counted it, is now counted once the scan is over, unless by then a move took it or re-pointed it: under `preserveUnique` a move of a tombstone of its item can take it along, so the count depended on whether the scan met it first. Nor does the outcome depend on how a run's segments and concurrent rows interleave: a move that finds its unique value's current key held by a sentinel naming a row that is gone reads the key again before refusing, since a move of the same run may just have taken that row with its sentinel, where it was reported `taken` (on DynamoDB, about one random table in four could end so). And an item whose sentinel another move of the run takes out of its way is counted the same whichever of that move's writes the table answers first: its pass could read the sentinel's new key before the move's put landed and its old key after the move's delete, find it under neither, and count the item `unchanged` (with every request delayed 0 to 30 ms on DynamoDB Local, 2 of 24 runs of the chain scenarios did). A pass that finds the sentinel under neither key reads the new key again when the run has put, or is putting, a row there.

  Two or three runs started at once over the same table no longer leave a live row's unique sentinel naming the key the row left, which up to 1.40.0 about one random table in 240 was left with: a move held only the sentinel key it wrote, not the one it read beside it, so another run could move that one in between. A move now holds each sentinel key it read and doesn't write as read, and sentinels brought to a row that stays where it is hold that row as read, so a re-point whose row has moved or changed since fails and is judged again from a fresh read. An update giving the row another value in between is such a change: the sentinel under the old key text is left where it is, rather than brought to the current key naming a row that no longer holds its value, where up to 1.40.0 it refused that value to every new item. A run also repairs a table runs of 1.40.0 left so: a sentinel whose named row is absent while a row of its entity under another text of that key holds its value is re-pointed to that row, not taken for an orphan, so `releaseOrphanedReservations` no longer frees a value a live row holds.

  Nor do runs started at once take another aggregate's rows or mark another stream's events. Once one run had moved an aggregate away, another run moving the same aggregate read its old partition, where an aggregate whose current key that partition is could have moved its rows by then, and took them for its own: it moved them into its partition, or refused them as two elements at one sort key. And a stream's move, run after another run had moved the stream away, could mark the first event of a stream moved into its old partition as moved, so every later run reported that stream `bothKeys`. Rows under an aggregate's old partition are now its own only while its root is there, and a stream's move marks and checks only rows that name the stream (`streamId`). Over 80 random tables, each rekeyed six times by runs at once with their requests delayed at random, 4 of 1.40.0's 480 cases ended so (two with an aggregate's rows, two with a stream's event), and none does now. And a move whose way another value's row or sentinel was in reads the key again before reporting it `taken`, since another run may have moved it first: over 960 random cases of two and three runs at once, the runs reported 558 conflicts that one run alone doesn't, and now report 9.

  Which requests a run sends. Over a table with nothing to move, a run without `reservations` sends exactly the requests 1.40.0 sent, request for request. Over a table with rows to move, a row that doesn't move is sent no request 1.40.0 didn't send it, and an aggregate that doesn't move can be sent one read fewer (a consistent read of its root). A row that moves costs fewer requests, since a run doesn't read again what it wrote (a moving item with a unique constraint or a soft-delete tombstone can take 6 where 1.40.0 sent 9), and its transactions can carry `ConditionCheck` items 1.40.0's didn't: the sentinel keys a move read and doesn't write, and the row sentinels are brought to. A moving stream's mark and its check on the stream's head also name the stream. Over 120 random tables with rows to move, one default run each: 6,354 requests against 8,259, 1,536 transactions against 1,475, and 393 `ConditionCheck` items against 308.

  What a run remembers to do this is bounded, and costs nothing for a row it doesn't move, write or report: a table of rows already under their current keys, or of another application's rows, is scanned in flat memory. Each entry is a 128-bit digest with a few flags, never key text or a row (a real run keeps no image of a row it moved, but the last 64 it put; a dry run keeps the rows it plans to put, which its reads see). The new `journalCapacity` option bounds the entries (default 1,000,000, about 138 MiB when full; moving a row costs about five, an aggregate's row one, as does a unique sentinel under `preserveUnique` whose value's key text differs between the settings), and the new `report.journal` says how many the run kept and whether it ran out. Past the capacity the run carries on, every write as guarded as ever, and `report.journal.inexact` names the counts that may be off. 1.40.0 kept the text of two claims for every live entity item and of every aggregate partition, unbounded, which a `Set`'s limit of 2^24 entries stops near 8.4 million entity items.

  A dry run with `repairIndexKeys` counts no key `repaired`: it writes none. 1.40.0 counted the keys it would have written.

  With the new `reservations: true` option, `rekey` judges unique-constraint sentinels no row holds and counts them in the new `report.reservations` (`orphaned`, `undecided`, an entry for each), writing nothing; under `preserveUnique` that costs a query for an item's tombstones where its sentinel names an item that is gone or holds another value. Without the option a run judges none and reads nothing more than 1.40.0 did: such a sentinel is counted in `skipped.unrecognizedKey`, or, one naming a tombstone, not at all, as in 1.40.0. `rekey({ releaseOrphanedReservations: true, writesStopped: true })` also deletes the orphaned ones, so their values can be taken again: the reservations a delete, update or soft delete on 1.39 or earlier left for a unique value that read back otherwise than `put` keyed it, such as a `Schema.BigInt`. Releasing is a maintenance step, run with every writer to the table stopped, a second run releasing reservations included: without `writesStopped: true` the run fails with a `ValidationError` before anything is read. Each release is one transaction, conditioned on the sentinel and on the row it names as read: when another item claims the value first, or a write gives the named row its value back, the sentinel is read again, and held or deleted by then it is left and counted `raced`, apart from `orphaned`; changed under it twice, `skipped`. These conditions don't make a release safe while the application writes, which is why it needs the promise: the named item can be put again with the value and soft-deleted under `preserveUnique` in between, which leaves the sentinel as read and its tombstone holding the value. A move whose unique value's current key holds such a reservation is `taken`, as in 1.40.0, unless the option releases it first.

  Two writes a move used to lose now cancel it, so the row moves with them: a `reembed` landing on a versioned item with a vector index (the move also holds its vector attributes as read), and a write adding a field of an aggregate node declared as an annotated class or a union (the move holds each property the node's schema can store still absent). What no condition on the move can see is counted in the new `report.guardGaps`, with writes going on: `stamp` (a wide row guarded on its `updatedAt`), `sparse` (a row with a sparse map, guarded whole) and `strongest` (a row of a part-moved aggregate or stream), and named in `report.guardGaps.rows` (member, kind, count, stored key and target): the first 100 by member, kind and key, the same whatever order the run meets them in, while the counts stay exact. A row is counted only where a library write can be missed, an entity's tombstones and time-series events included: a soft delete of an item put again within the stamp's resolution replaces its tombstone at the same key with the same `updatedAt`, and an `append` after the current item was deleted can replace an event, so a tombstone or event moved under its `updatedAt` is counted like an item. A write from outside the library is seen only through the move's condition, and the upgrading guide lists exactly which such writes no condition sees. With `writesStopped: true` nothing is counted. Counting reads and writes nothing.

  `reembed` no longer overwrites a write that lands between its read of an item and its rewrite. Each rewrite is conditioned on the item's source fields and partition composites as `reembed` read them, so an update that changed the text (and embedded it) or moved the item's partition in between cancels it, and `reembed` skips the item: neither retried nor counted in the number it returns. Up to 1.40.0 the condition was `attribute_exists` alone, and such an update was left with the old text's vector or partition. A source of hundreds of fields can be too many for one condition: the rewrite then holds the item's vector and partition attributes as read instead, which such an update changes too, and as many source fields as fit. `reembed` never writes without a condition: an item neither fits fails it with a `ValidationError` naming the item. The other way round, a soft delete of a versioned item with a vector index, and an update of one too wide for one expression, now hold its vector and partition attributes as they read them, since they copy them: a `reembed` landing in between is a lost race (`ConcurrentModification`), so the soft delete reads again and deletes again (with a `.condition()`, it fails), and the update fails. Up to 1.40.0 the tombstone stashed the old vector, which `restore` brought back, and the update wrote the old vector over the new one. For 1,536 dimensions the condition adds about one vector, 13 to 18 KB, to the request. Other writes, and every write of an entity without a vector index, send what 1.40.0 sent.

### Patch Changes

- [#254](https://github.com/jmenga/effect-dynamodb/pull/254) [`3e69271`](https://github.com/jmenga/effect-dynamodb/commit/3e692716336de2172fe3d595b79315485b42032e) Thanks [@jmenga](https://github.com/jmenga)! - Accept a `sessionToken` in `credentials`. `DynamoClient.layer`, `DynamoClient.layerConfig`, `DynamoStreamsClient.layer` and `DynamoStreamsClient.layerConfig` typed credentials as `{ accessKeyId, secretAccessKey }`, so a literal with temporary credentials (an assumed role) needed a cast, although the SDK sent the token. `sessionToken` is now optional: a string, or `undefined` or `null` for none. In `layerConfig` it's read through the same `Config` as the other two, as a plain string. The credentials object still goes to the SDK as given, so nothing is sent differently. As before, an unknown key in an object literal given to `layer` is a compile error, and `layerConfig` checks keys no more than it did. A token that's neither a string nor `undefined` or `null` is now a compile error too; it compiled through a variable or a `Config` before.

- [#253](https://github.com/jmenga/effect-dynamodb/pull/253) [`32c5337`](https://github.com/jmenga/effect-dynamodb/commit/32c53376922bd1e83f652e7beb0a7fb8a4f7a49b) Thanks [@jmenga](https://github.com/jmenga)! - Two places where an error printed values beyond the item's key, and from there reached logs: the `key` of a write's error and the stored row on its `cause`. Schema errors (`ValidationError`'s `cause`) quote no value and are unchanged.

  **`key` on an error from `put`, `create`, `upsert`, a time-series `append` or a transaction's `put` now holds exactly the entity's primary key composites, by model field name and in their encoded form: the same record that `get`, `update` and `delete` errors carry for that item. It used to hold the whole encoded input. The primary key fields are still there; every other field of the input is not, so a `Schema.RedactedFromValue` field is no longer on the error in plaintext.** Code that read a non-key field off `error.key` needs another source for it.

  When a condition fails, AWS returns the stored row on the SDK's error (`Item`, or `CancellationReasons[i].Item` in a transaction). On an error's `cause` that row is still readable, but no longer enumerable, so `JSON.stringify` and structured loggers don't print it.

- [#247](https://github.com/jmenga/effect-dynamodb/pull/247) [`23aba89`](https://github.com/jmenga/effect-dynamodb/commit/23aba89e13659848ad3847234e12ed755799441b) Thanks [@jmenga](https://github.com/jmenga)! - **This release requires `effect@4.1.3`** (the peer range is now `^4.1.3`). **Under it, a field whose name is also an `Object.prototype` member (`toString`, `constructor`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `__proto__` …) is read from a payload only when it is the payload's own property. Given through a prototype (`Object.create`), a class getter or a proxy without own-key traps, it is not seen: an optional field is left out, and a required one fails with `Missing key`. On Effect 4.1.2 it was read.** Effect's schema parser decides this, at any depth. The library hands it each payload as given, but on four paths, where it adds to the payload first and hands the parser a copy made exactly as 1.40.0 made it (the same construct, reading the same properties as often, in the same order): a write filling a decoding default an index key needs (`put`, `create`, `upsert`, a transaction's or a batch's put, a time-series `put`, and an `append` whose `.remove()` names such a field: a spread of the payload and the defaults), an aggregate's stamped dates (a spread of each object stamped and its dates), an aggregate's `create` fetching ids for `ref` edges (a copy of the whole input's own enumerable properties, the fetched items and renamed lists put into it), and a `GeoIndex`'s `put` and `enrich` (a spread of the input and its cells). A spread copies own properties alone, so on those paths an input given by `Object.create`, a class with getters or a proxy loses its fields, as on 1.40.0. Effect 4.1.2's parser also read such a field that a payload left out as the inherited member, and refused it, so a value without an optional field so named failed to decode; 4.1.3 leaves it out.

  A name every JavaScript object inherits (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `toLocaleString`, `__defineGetter__` and the rest of `Object.prototype`'s members) now works as an ordinary name does wherever a definition gives one ([#239](https://github.com/jmenga/effect-dynamodb/issues/239)): a model field, a packed field, the attribute a field is stored under or a field stored under another, a path segment, a key composite (of the table or an index, required or optional), a unique constraint's field, a ref field, the timestamps and the version field, a time-series `orderBy`, a Z-order dimension, a projection's checkpoint, revision, checkpoint map and instance field, an aggregate's root field, context field and edges, the field a `many` element holds its entity in, and an event's fields. The library looked such names up in its own maps (definition maps, encoded payloads, rows read back, a schema's fields) with `obj[name]` or `name in obj` and found the inherited member; it now finds only what the map holds itself. The exceptions are `__proto__` (below), a payload giving the name otherwise than as its own property (above), and a function a caller's object inherits from its class under such a name (a method, or the class itself under `constructor`), which is read as 1.40.0 read it (below), where an ordinary name the class doesn't define reads as absent. On 1.40.0, measured on Effect 4.1.3: `.set()` of a field so named died with a defect, and a condition, filter, projection or `.remove()` naming it was refused by DynamoDB; a packed field so named and left out of a payload was refused as a function; a field stored under an attribute so named read back as the inherited function where the row lacked it, failing `put` and updates; a field so named stored under another attribute failed `put` when left out, and `.set()`, a condition or a projection of it died or found nothing; a path segment so named and naming no field died; a timestamp so named threw at `Entity.make`; a version field so named was missing from what `put`, `update`, `upsert` and `get` returned; a query on an index whose key composite is so named composed the inherited function's text into its key condition and found nothing, and `.set()` of another field was refused as setting that composite; an optional index sort key composite so named and left out put the row in the index under the function's text, `.set()` of it died, and its `.remove()` was refused by DynamoDB; a unique constraint's field so named and left out reserved a sentinel keyed by the function's text, so every other write leaving it out failed with `UniqueConstraintViolation`, and an update, a delete or a soft delete of the row was refused by DynamoDB (below); a time-series `orderBy` so named failed every `append` (refused by DynamoDB); a Z-order index with a dimension so named failed every query (its accessor took the inherited member for a dimension given to it, and died), `.set()` of the dimension died, and `.set()` of another field was refused as placing a function (`EDD-9092`); a projection's checkpoint, revision, checkpoint map or instance field so named failed to apply to a row it had written (refused by DynamoDB) and to a row written before it (`UnstorableValue`, `NaN`); a `ref` field's update by id died; an aggregate root field or context field so named failed `create`, `get` or `update`, or stored `[object Undefined]`; an optional `one` edge so named failed `get` when the aggregate had none; a `ref` edge so named failed `create` or `get`; a `many` edge whose element holds its entity in a field so named threw at `Aggregate.make`; and an event holding a field named `constructor` was stored under a type read off that field (1.40.0 took the field for its class): where the field holds text, with no type, so no read could decode it; where it holds an object with a `name` or an `identifier` (`{ constructor: { name: "Acme Builders" } }`), under that text (`"Acme Builders"`), which read back. **Both are now stored under the event's class's type** (a `Schema.Class` event's identifier, `"Object"` for a plain object), so an event of the second kind written now holds another `eventType` than the same event written by 1.40.0; both read back. Measured against 1.40.0 on Effect 4.1.3, every case it handled as it handles an ordinary name sends the same requests, stores the same rows and returns the same results.

  **A row 1.40.0 wrote with a unique field so named left out holds a sentinel this release never reads.** 1.40.0 reserved it under the inherited function's text (a key ending `#function tostring() { [native code] }`, under `toString`). This release composes no sentinel for a field the row doesn't hold, so it writes, updates, deletes (hard, soft or in a transaction), restores and purges such a row without touching that sentinel, and `rekey` leaves it too. Nothing reads or releases it: delete each by its key (its `__edd_e__` is `<entityType>._unique.<constraint>`).

  `__proto__` can't be held by a JavaScript object by assignment, and the AWS SDK's marshaller drops an attribute or a map entry so named. A definition naming it where every item or row written would hold it is now refused at `make`, naming where it is: for an entity (`EDD-9152`), an attribute the library writes (a timestamp, the version field, a key attribute of the table, and one of an index whose every composite, both halves, is a required field), the attribute a required field is stored under, a required model field stored under its own name (a key composite or a ref among them), or a required property of one reached through required struct properties; for a projection (`EDD-9152`, at `EventStore.projection` or `multiProjection`), its checkpoint, revision, checkpoint map or an instance field, renamed to another attribute or not (the projection sets and reads it by name on each row); for an aggregate (`EDD-9153`), a required field of the root or of a required sub-aggregate's root, a `ref` edge, a required sub-aggregate's discriminator, or a required property of a root field's or a required `one` edge's value. A name is certain to be stored only where every container above it is required and certain to hold a map; a sub-aggregate's own `Aggregate.make` takes it, and the aggregate holding it decides. A property counts as required only where its stored form is known exactly (through transformations, classes and `suspend`) and no value of it stores nothing: a required one typed `NullOr` or `OptionFromNullOr` (which store `null`) is refused, and one whose stored form admits `undefined` (`UndefinedOr`, `NullishOr`, a union with `Undefined`, `OptionFromUndefinedOr`, `OptionFromNullishOr`, a decoding default), `Unknown`, or a declaration the library can't see into loads. None of the refused definitions ever worked: 1.40.0 stored the item without the value, failed the write or the read, or threw at `make`, and DynamoDB refused every write of an entity holding a `NullOr` or `OptionFromNullOr` one (an aggregate's `OptionFromNullOr` one completed and lost the value). Everything else naming `__proto__` loads, as on 1.40.0: an optional field or property so named, a renamed optional field, a key attribute of an index that can be left out, and a required one below an optional or `optionalKey` field, a nullable one, a union's alternative, a list's element or a tuple's rest element, a record's value, an `Option`, an optional `one` edge or sub-aggregate, a `many` element, or JSON text (a packed field, `Schema.fromJsonString`). A write leaving it out or storing nothing under it (`undefined`, a `None` encoded `undefined`, an empty set, a default omitted on encoding) sends the requests 1.40.0 sent, stores its rows and returns what 1.40.0 returned, and reads of those rows return what 1.40.0's did: where 1.40.0 derived a struct without the field (an entity's payload and record schemas, a struct the library rebuilds), it's derived as an optional field that takes no value storing something. A write giving it a value is refused before it's sent (next paragraph). One case does otherwise, named here and not reworked: an aggregate's field so named typed `OptionFromOptionalNullOr(…, { onNoneEncoding: null })` (whose `None` stores `null`), left out of an `update`, is refused (`EDD-9165`, nothing written), where 1.40.0's `update` completed and stored the row without it. A field so named stored under another attribute, and a `one`, `many` or sub-aggregate edge so named (a property of the assembled aggregate, never an attribute), now store and read their value, where 1.40.0 lost it or failed.

  A write holding an attribute or a map entry named `__proto__` is now refused before anything is sent (`EDD-9165`), with a `ValidationError` naming the field and the key (`"data.__proto__"`): an optional field so named given a value (a packed one included), `.set()`, `.add()`, `.subtract()` or `.append()` of one, a field stored under an attribute so named given a value, an index key attribute so named given a key (its composites present, on a `put`, `create`, `upsert`, update, transaction or batch), a `Schema.Record` entry, a `Map` entry or any object stored as a map at any depth, and a path operation with a `__proto__` segment (`pathSet`, `pathAdd`, `pathSubtract`, `pathAppend`, `pathPrepend`, `pathIfNotExists`, `pathDelete`), on a `put`, `create`, `upsert`, update, `Transaction.transactWrite`, `Batch.write`, a time-series `append`, an aggregate's `create` or `update`, and an event stream's `append`. The AWS SDK's marshaller and unmarshaller assign each attribute and entry to a plain object, and assigning that name sets the object's prototype instead of holding the value. On 1.40.0 an attribute so named was dropped and the item stored without it (an index key so named left the row out of the index; a field stored under it failed every `put` and `get`, and `upsert` died), a write holding such an entry was sent and refused by DynamoDB ("Supplied AttributeValue is empty"; an aggregate's `create` of an `Option` encoded through such an entry completed and lost it), and a path operation through the key stored the entry, which no read returned. Only that name, and only one the value holds itself: the `__proto__` every object inherits isn't one, every other `Object.prototype` name is an entry like any other, and two kinds of map keep the entry and store and read it as on 1.40.0: a sparse map's (its own attribute, `data#__proto__`) and JSON text's. A row holding such an attribute or entry (stored before, or by another writer) now reads without it, whatever it holds: on 1.40.0 any read of a row holding such an attribute died with a defect whatever it held (a string too), on a `get`, a query, a scan, `Batch.get`, `Transaction.transactGet` and an update returning the new item alike, and the AWS SDK's unmarshaller made a map stored under such an entry the read object's prototype, so a struct field holding one read that map's entries as its own fields. `pathRemove(["data", "__proto__"])` removes one. `Marshaller.toAttributeValue` and `Marshaller.toAttributeMap` throw `UnstorableValue` (`EDD-9165`) for such an entry, where 1.40.0 returned the map without it.

  A condition or filter comparing with a value that holds a map entry keyed `__proto__` (from `JSON.parse`, from `Object.defineProperty`, nested in another map, beside another entry, or in a list's element), with any comparison (`eq`, `ne`, `lt`, `le`, `gt`, `ge`, `between`, `beginsWith`): on 1.40.0, `Expression.condition` compiled it with the entry left out (`{ M: {} }` where it was the map's only entry), and DynamoDB refused every request sending it ("Supplied AttributeValue is empty"): an update's or a put's condition, alone or in a transaction, `Transaction.check`, and a scan's filter, given as a record or a callback. The `Expression` builders compile it as 1.40.0 did. Each of those requests is now refused with a `ValidationError` (`EDD-9165`) on its error channel, naming the entry, before anything is sent, `Transaction.check`'s transaction included.

  A key given as an object whose composites aren't its own enumerable properties (one made by `Object.create`, an instance of a class whose fields are getters, a proxy) is now read by name (`key[name]`) for each composite its own properties lack: on 1.40.0 an index accessor, a collection, `Batch.get`, `Batch.write`, `Transaction.transactGet` and `Transaction.transactWrite` died with a defect ("Missing composite attribute"). A strict proxy (one that throws when asked for a name it doesn't hold) is read by the names it holds where 1.40.0 died with a defect: an index accessor's key, `.set()`'s payload, and an aggregate's `create` and `update` (an event stream's `append` of a strict proxy event with no `_tag` still dies, as it did). A record argument (a condition, a filter, `.add()`, `.subtract()`, `.append()`, `.within()`'s bounds, an aggregate `list`'s filter) is read as 1.40.0 read it, by its own enumerable entries: one whose fields aren't its own properties still gives none (a condition so given asserts nothing, a filter reads every row, `.add()`, `.subtract()` and `.append()` find nothing to write, and `.within()`'s bounds given by a strict proxy die), so give a record as a plain object. Where the library reads a caller's object by name, the one value it doesn't take from that read is the member every object inherits under the name, judged by identity: `Object.prototype[name]` (`Object.prototype.toString` under `toString`), and under `__proto__`, where `Object.prototype["__proto__"]` is `null`, `Object.prototype` itself (what a plain object's `__proto__` reads). 1.40.0 took it for a value; such a name reads as absent. Anything else is a value, as on 1.40.0, a function included: one the object holds itself (a key composite is composed from its text, a condition, a filter or an update operand sends what 1.40.0 sent), and a class's own method or `constructor` under such a name. Where 1.40.0 took no function for a value (an aggregate's ids, `many` lists and sub-aggregates) or read nothing (a key composite the key's own properties lack), a function is no value. An object holding its fields as its own properties is read as 1.40.0 read it: on every entry point a proxy over it, and over each object nested in it, receives the same traps, of the same names, as many times, in the same order, under ordinary names and under `Object.prototype`'s names alike. A read asks more only where 1.40.0 failed or took the inherited member for a value: where a key's own properties lack a composite, after a read throws (a strict proxy, or a getter the object inherits), and where the value read is that inherited member (one `getOwnPropertyDescriptor`, asking whether the object holds it). A key, payload or record whose class or prototype claims a name the library reads with a getter that throws now fails with a `ValidationError` naming the field before anything is sent, and so does a write filling a decoding default or an aggregate stamping a date where the payload claims that name so (1.40.0 died there with a defect). A declared own getter that throws while Effect's parser reads it is a defect, as on 1.40.0. An argument that is no object (`undefined`, `null`, a string, a number, an array), given to any combinator or accessor that takes a record, a key or a callback, or returned by a callback, does what it did on 1.40.0, and so does `append` of an event that is `undefined` or `null`. An event naming no event type (no `_tag`, and no class to name one: an object made by `Object.create(null)`) is refused with a `ValidationError` before anything is sent, where 1.40.0 died with a defect before sending.

  A `GeoIndex`'s `nearby` given a `pkFilter` made by `Object.create`, a class with getters or a proxy died with a defect ("Missing composite attribute"); it is now read by name. Every other geo input is read as 1.40.0 read it, trap for trap.

- [#255](https://github.com/jmenga/effect-dynamodb/pull/255) [`94f747d`](https://github.com/jmenga/effect-dynamodb/commit/94f747d834022e63f0b424c082b5f369c2283c1c) Thanks [@jmenga](https://github.com/jmenga)! - Fix `layerConfig` dropping credentials given in part. `DynamoClient.layerConfig` and `DynamoStreamsClient.layerConfig` read `credentials` as absent when any part of a `Config.all` group was missing: a key without its secret, or a key and secret beside a required token that wasn't there. The parts given were dropped, and the SDK's default credential chain signed every request, as whatever identity it held.

  **Credentials given in part now fail the layer with the `Config`'s error for what is missing, and nothing is sent. A deployment that sets a key and secret, reads the token with `Config.String("TOKEN")` and has no token, started and signed with the default chain; it now fails at startup. Read a token that may be absent with `Config.String("TOKEN").pipe(Config.withDefault(undefined))`.** An empty value counts as missing, as it did.

  The layer fails only when the credentials are shown to be given in part. With one or two of the missing values stood in for, the `Config` must yield credentials, and each stand-in must be one of their three parts. A value the provider holds must be one of the parts too (trimming and case aside), and when it changes, that part must change with it and the other parts must not. Anything else still reads as absent, as before:
  - a profile, mode or flag that selects what to read, set with no keys, also when its value is the fixed text of a part;
  - a setting that would be a part only under a mode that is missing and has a default;
  - a key whose value the `Config` takes for none (`KEY=none`);
  - another setting read in the same group that is given, or that has a default;
  - a part given and another missing when a setting the same `Config` requires is missing too (a required label, account id or expiration read beside them): a required setting that is missing can't be told from a mode that is missing;
  - a part the `Config` turns into other text (a prefix added, a list joined, a secret read from the file or the store the value names) or reads as a list;
  - a part the `Config` accepts only in some form (a literal, a pattern, a length);
  - anything the `Config` would read only after what is missing, through `Config.flatMap`: a part that is there when the `Config` stopped at a read before it (`KEY` then `SECRET`, with only the secret given), a third part or a setting read after the keys when the key is given and its secret is missing, a key that also names where its secret is read (`KEY`, then `<KEY>_SECRET`). The provider is asked no more than the `Config` asks, and what it holds where it wasn't asked isn't known;
  - anything the `Config` reads from the provider in context by itself, in a `Config.mapEffect`;
  - a struct read through one schema (`Config.schema`) that is wholly missing, beside a token that is given, and a value at a struct's path that is no struct;
  - an empty value a provider keeps, or a value of spaces only, alone;
  - more than six values missing among those the `Config` read;
  - a `Config` that yields credentials when evaluated again (its own state changed).

  Two shapes fail the layer that a stricter reading might leave to the default chain. A value that is a part only under a mode that is missing, when the mode's own text is a part too. And a name the `Config` maps to itself, when the `Config` maps other names to fixed keys and uses any unknown name as the key: from outside the `Config`, that name is the key.

  To show it, the `Config` is evaluated again from the answers the provider already gave, with stand-in and changed values. The provider is read once, as before. The `Config`'s own functions (`Config.mapEffect`, `Config.flatMap`) run again, with those values, whenever the `Config` comes back absent although the provider held a value it read, a flag or a mode included. The answers are kept as the provider gave them: a provider of the caller's own that hands out one object for several paths and changes it between them is read by what that object holds last.

  Unchanged: with none of the parts in the provider, the default chain applies; with all of them, they're used; an invalid value or a failing provider fails the layer. With `Config.orElse`, the error is the alternative's, as Effect reports it.

- [#248](https://github.com/jmenga/effect-dynamodb/pull/248) [`0b3d21e`](https://github.com/jmenga/effect-dynamodb/commit/0b3d21e1b6533e07440661a3adab4ea2a63b70c8) Thanks [@jmenga](https://github.com/jmenga)! - A `.select()` naming a sparse map field returns the map. A `ProjectionExpression` can't name a map's entries (`<prefix>#<key>`), so the select projected the field's own name, which no row holds, and the map came back absent, on an entity's queries and scans and on a collection, as on 1.39.0. A select of the whole map now sends its request without a projection, rebuilds the map from each row's entries as a read does, and hands back every other path selected as its projection did, however it was spelled (a stored name, an entry's attribute, a key attribute), without unpacking, decompressing or checking anything the select doesn't name. It consumes the capacity a projected read consumes (DynamoDB charges by the items read, not what it returns) and returns every attribute of each row. A select of one entry (`t.f.entry("k")`, or `t.f.k`) projects the attribute the entry is stored under and returns the map trimmed to that entry, `{ f: { k } }`, with a list below it as DynamoDB projects it (`t.f.k.at(2)` of `[10, 20, 30]` gives `[30]`). For a map a `field:` rename stores whole it also projects that attribute whole, and returns what a read returns: through 1.40.0 such a select projected `sr.k`, which returned nothing from a row an update wrote. Two selected paths that overlap, a projection DynamoDB refuses, come back once beside the map. A select naming no sparse map sends the projection it always sent, and `.filterBy()` after any select is still refused (`EDD-9054`).

  A model field whose own name holds `#` and is stored under another name (`field:`) is named by that name in path writes and conditions, as filters and projections already named it. A path write and a condition took such a first segment as a literal attribute name, so `pathSet(["a#b"])` on a field `a#b` stored as `stored` set a top-level `a#b` that no read looks at, and a condition on `t["a#b"]` tested an attribute `put` never stores, failing whatever the row held, as on 1.39.0. The refusal of a `pathRemove` of a sparse map's entry asks about the attribute the path names after that rename, as `.remove()`'s does, so a field named like an entry (`data#x#y`, stored as `counter`) is removed where it's stored. 1.39.0 removed the entry `x#y` instead, and 1.40.0 refused the removal. An entry named through its map (`.entry("b")`, `.set({ g: { b } })`, `removeEntries`, `clearMap`) is still the entry's attribute when a field carries the same name: only a bare segment the caller spells like an entry names the field. A path write on segments `.entry()` built, on an entity whose unique constraint names such a field, wrote the field on 1.40.0; it writes the entry.

  A `pathRemove` that leaves a row no read can decode is refused in more places, with a `ValidationError` and nothing sent, and each was sent on 1.39.0 and 1.40.0:
  - Below a sparse map's entry (`pathRemove(["data#2026-01", "views"])`): judged against the map's own schema, as a read rebuilds the map. A map a `field:` rename stores whole isn't judged.
  - A list position whose removal moves a value where its position can't hold it: `f[0]` of a `[string, number?]` leaves the number where the string was.
  - A list position whose shortened list only a member its tag rules out reads: `p[0]` of `{ kind: "a", p: [string, string] }` beside `{ kind: "b", p: [string] }`.
  - Below a record with several index signatures, judged by the signatures its key matches: on `{ [open-*]: [string, string?], [fixed-*]: [string, string] }`, `["fixed-k", 0]` is refused and `["open-k", 0]` is sent. A record keyed by a template literal of strings is judged too.

  Anything the guard can't model exactly is still sent, as before. A removal is judged against the update as a whole: where another clause of the same update writes or removes what a list position's judgement reads (another position of the list, a tag beside it), the position is judged as 1.40.0 judged it, so `f.kind = "b"` beside the removal of `f.p[0]` above is sent and reads back as `{ kind: "b", p: ["second"] }`, as on 1.40.0.

  A condition or filter comparing the path builder itself (`eq(t, 1)`, `t.size()`) is refused with a `ValidationError` before anything is sent (`EDD-9149`), as an empty part under `or()` is. It names the whole item, not an attribute. 1.40.0 sent it as `( = :e0)` and DynamoDB rejected it with a `DynamoValidationError`. 1.39.0 did the same for a condition, and its filter died with a `TypeError`.

  A sparse map renamed with `field:` (`{ storedAs: SparseMap(), field: "sr" }`) is stored whole as `sr` by `put` and as one attribute per entry by an update, and a read takes `sr` when the row holds it. An update of its entries on a row `put` wrote reported success and changed nothing a read sees (a `.subtract()` failed naming no attribute), on 1.39.0 and 1.40.0. An update that reads the row (a retained entity's, `clearMap`, any update in `Transaction.transactWrite`) now writes the entry where the row holds the map, inside `sr` or as its own attribute, and `clearMap` removes `sr` too, writing the map's entries as their own attributes. One that doesn't read the row, and a plain entity's `upsert` of the map's entries, is sent as before, guarded on the row not holding `sr`, and on a row that does it's refused with a `ValidationError` (`EDD-9150`) and nothing is written: through 1.40.0 such an `upsert` reported success and its entries were lost. A condition or `expectedVersion` the row doesn't meet fails as it did (`ConditionalCheckFailed`, `OptimisticLockError`), and on a row holding `sr` so does a condition the library can't judge from the row (a `size()` of text beyond ASCII whose answer depends on how its length is counted): the refusal answers only where they're known to hold. **A condition the library can't evaluate itself (a `size()` of text beyond ASCII) that DynamoDB finds false, on a write whose map another writer moves between `sr` and its entries at that moment, costs a second read and write before the caller's error (4 requests where 1.40.0 took 2), and where the map moves before every attempt it ends in `OptimisticLockError` or `ConcurrentModification` naming the map instead of the caller's error.** An update that reads the row and finds, when it writes, that another writer changed the map's form reads it again and writes again; where the form changes before each of three attempts it fails with `OptimisticLockError` (a versioned or retained entity) or `ConcurrentModification`, naming the map in `attributes`, an optional field new on `OptimisticLockError`. A copy from an entry (`pathSet` or `pathSubtract` with `isPath`) writes no entry and isn't guarded; spelled through the map (`counts.entry("a")`, `["counts", "a"]`) it reads where a read takes the entry when the update reads the row (a retained entity's, any update in `Transaction.transactWrite`), and is otherwise sent as before. A condition or filter on an entry (`t.counts.a`, `t.counts.entry("a")`) asks the row where it holds the map, so it holds on rows of either form: through 1.40.0, `.entry("a")` failed on a row `put` wrote, and `t.counts.a` on one an update wrote. `put`, `create`, a retained or unique entity's `upsert`, `Batch.write` and a map stored only as entries send what they sent.

  A path below a struct that renames its keys as they're stored (`Schema.encodeKeys`) names the stored attribute when it's spelled by a property's own name, in path writes, conditions, filters (an aggregate `list` filter's on its root too) and selects alike: on `meta` encoding `amount` as `am`, `pathSet(["meta", "amount"])` and `t.meta.amount` name `meta.am`, and a select of it hands the value back as `meta.amount`. Through 1.40.0 such a path was sent as written: a write stored a stray `meta.amount` that no read saw, a condition or filter on it failed whatever the row held, and a select of it came back without it. A stray `meta.amount` such a write left stays on the row, unread, and a path of either spelling now names `meta.am`: `.set({ meta: { ... } })` writes the struct whole and drops it. A path spelled by stored names (`meta.am`) sends what it sent, including a name that is both one property's own name and another's stored name (`encodeKeys({ a: "b", b: "a" })`: `["swap", "a"]` names the attribute `a`, as before). Where the schema can't say what a segment is stored as (a union whose members don't name every key alike: one storing it renamed beside one that doesn't, or two renaming `x` and `y` crosswise), the path is sent as written from that union on, as before. A `pathRemove` of a property such a struct requires is refused with a `ValidationError` and nothing sent, by either spelling: 1.40.0 removed it by its stored name and left a row no read could decode.

  A path operation's value written into a sparse map's entry by the entry's own attribute (`pathSet({ segments: ["counts#z"], value })`, a `pathAppend` to `["lists#k"]`, a path below an entry `.entry()` built) is checked against the map's value schema, as one written into a field is against the field's, and a value the schema refuses is refused with that `ValidationError` before anything is read or sent. Through 1.40.0 it was written as given: into an entry the row held, where every read of the row then failed; beside a map a `field:` rename stores whole, where no read took it and the update reported success; or DynamoDB refused it. A value a read takes as given is still written as given (a number on a map stored as text, which a read takes as earlier releases left it), and so is one below an opaque class, which the schema can't follow. In a field holding a custom declaration, a value its schema refuses is now refused as that operand (`update.pathSet`), naming what the schema refuses, where 1.40.0 refused it as a declaration's value no read takes (`EDD-9126`).

  `.entry(key)` resolves the same way on every terminal that takes a path callback: an entity's query accessors, `scan()`, `.history()`, `versions()` and `deleted.list()`, a collection's accessors, a write's `.condition()`, and the entity's own `condition`, `filter` and `select`. Through 1.40.0 it threw ("not configured as a sparse map") in every query callback, and the entity's own `filter` and `select` (on an unbound query) named the entry of a map a `field:` rename stores whole, and a key below an entry that its struct renames as stored, as written, so they matched rows wrongly; they now name what a bound query names. A filter on an entry names the attribute a condition on it names. `.entry()` on a nested field that shares a sparse map's name (`t.inner.zones`), or on a field named like an `Object.prototype` member (`constructor`), is refused like any other field that isn't a sparse map: through 1.40.0 the first tested `inner.z#east`, which no row holds, and the second `undefined#k`. An update of a field named `valueOf` or `constructor` on an entity with a sparse map writes the field: through 1.40.0 it wrote `undefined#…` attributes and returned the old value. In a collection each member names the entry by its own prefix, and a member without the map reads every entry as absent: `eq` on one never matches its rows, `notExists` matches every one. A model field named like one of the path builder's own members (`at`, `size`, `entry`, `segments`, `pipe`, `then`, `toJSON`, `_tag`) is still that member in a callback, not the field, as on 1.40.0; reach it with an equality shorthand (`.filter({ at: 1 })`), a record operation or a path operation's segments (`["at"]`).

  `.clearMap()` comes first, whatever order the update's combinators were written in, and one request never names an entry twice. Through 1.40.0 a clear with any other write to an entry the row held was sent as written: an entry held as its own attribute was named twice and DynamoDB refused the request; on a row holding a renamed map whole the clear removed nothing a read takes, and a `.subtract()`, `.append()` or path operation into an entry failed naming an attribute the row lacks; and a retained entity applied the `.set()` before the clear and stored `{}`. Now, wherever the row held the entry, a `.set()` of it replaces it, an `.add()` or `pathAdd()` starts it from nothing, a `pathIfNotExists()` sets it, and a `.removeEntries()`, `.deleteFromSet()` or `pathRemove()` below it is the clear's own; a `.subtract()`, `.append()`, or a path operation reading it or writing below it, which has nothing left to work on, is refused with a `ValidationError` (`EDD-9151`) before anything is written. One on an entry the row doesn't hold is still sent, and DynamoDB refuses it with a `DynamoValidationError`, as on 1.40.0. A retained entity's `.subtract()` and `.append()` still apply to the cleared map in memory, starting from nothing, as they did.

  A time-series `.append()` whose payload carries entries of a sparse map without a `field:` rename is refused with a `ValidationError` before anything is sent, as its `.remove()` of the map is: through 1.40.0 it wrote the map whole under the field's name beside the row's entries, reported success, and every read returned the entries the row already held. Write a map's entries with `update().set(...)`; an empty map, and a renamed map (whose whole attribute a read takes), are appended as before.

  A retained entity's `.removeEntries()` of a sparse map a `field:` rename stores whole no longer removes the entries from the version snapshot it writes: through 1.40.0 the snapshot of the version replaced lost them too, and `versions()` read it without them.

  A `pathSet` into a member of a union is checked against every member that holds its path, not only the first. Through 1.40.0 the first member that held the path's next segment alone checked the value, so `pathSet(["tag", "kind"], "b")` on `Union([{ kind: "a", x }, { kind: "b", y }])` was refused with `Expected "a"` whatever the row held, as was a string on `Union([{ v: number }, { v: string }])`. A path write reads nothing of the row, so such a value is written, as the member that takes it stores it, only where what the update leaves reads whatever the row held, at every union its paths pass through or end at: every member there reads it, or the update writes every property of one member that does (a property holding a struct counts when it's set whole or every property of it is written). `tag.kind = "b"` beside `tag.y = 2` is written, and so is the string on `{ v: string }`. Anywhere else it stays refused as on 1.40.0: `tag.kind = "b"` alone would leave `{ kind: "b", x }` on a row holding `a`, and `pass.inner.v = "str"` on `Union([{ kind: "a", inner: { v: number } }, { kind: "b", inner: { v: string } }])` would leave `kind: "a"` beside a string, rows no read could decode. Beside an increment, an append, a `pathIfNotExists` or a copy in the field it stays refused too. Values the first member takes are sent as on 1.40.0, unless no member can read what the field's path writes and removals leave together: `tag.kind = "a"` beside `pathRemove(["tag", "x"])` is now refused with nothing sent, where 1.40.0 applied it and left a row no read could decode. Inside a union whose members rename their keys with `encodeKeys` alike, a path write names the stored keys only where what it leaves reads whatever the row held, and is refused with nothing sent otherwise (`renamed.kind = "b"` alone, or a `pathRemove` of a property one member requires), where 1.40.0 wrote the names given, which no read took. Members that rename them differently (crosswise, or a discriminator stored as `ka` in one and `kb` in the other) get the names given, as on 1.40.0, and the row reads as it did on 1.40.0. Left as 1.40.0 behaves: with a discriminator stored under different names, `kind = "b"` beside `y = 2` still reads as the member the row held; a discriminator set alone to another member's tag where 1.40.0 sent it (`kind = "a"` on a row holding `b` in a field, any member's tag in a sparse map's entry) is still sent, leaving a row no read takes; and a path through a recursive union (`Schema.suspend`) is written as on 1.40.0.

- [#256](https://github.com/jmenga/effect-dynamodb/pull/256) [`e8e050b`](https://github.com/jmenga/effect-dynamodb/commit/e8e050b93c91df28fbcb1749e2073108e3dc2a26) Thanks [@jmenga](https://github.com/jmenga)! - A projection's `rebuild` enqueues nothing in the outbox ([#237](https://github.com/jmenga/effect-dynamodb/issues/237)).

  **On 1.40.0 a rebuild of a projection with an outbox wrote the effects of the events it re-derived into the outbox again, so each was delivered again. It now writes none, as the guide says. Anyone who used a rebuild to re-send effects must re-send them themselves.**

  A rebuild, single- or multi-source, writes the rows it re-derives, with their checkpoints and revision as before, and no outbox item, whatever the row's stored state. Items already pending at the row are untouched and delivered once, and live delivery after the rebuild enqueues the effects of new events only. `effects` still runs in the rebuild's fold, so its failures decide the fold as they did, and the row written is the same.

  **Request change: a rebuild's row write that carried outbox items is no longer a `TransactWriteItems` holding the row's `Put` and the items, but the write every projection write that enqueues nothing sends: a `PutItem` of the same item, conditioned on the row's guard.** Over a live row that is the revision read (`rev = :v`, the same condition under other placeholder names). Over a row read absent it is `create`'s condition, that nothing is at the row's key (`attribute_not_exists(<pk>) AND attribute_not_exists(<sk>)`), where the transaction asked only for no revision there; an item without a revision at the key then fails it as a lost race, and the retry writes over it as a row read with no revision. A tombstone's `Put` is sent as a `PutItem` unchanged.

  A rebuild of a row behind its stream applies the events the row hadn't seen without their effects: if those effects matter, run `catchUp` first, which applies them with their effects. `catchUp` is unchanged. Another projection of the same read model whose checkpoint a rebuild drops, with its data, folds its stream again on its next event and enqueues those effects again, as on 1.40.0.

- [#250](https://github.com/jmenga/effect-dynamodb/pull/250) [`dbcb808`](https://github.com/jmenga/effect-dynamodb/commit/dbcb808c9d321fd8241129b40893dd0a34ac302f) Thanks [@jmenga](https://github.com/jmenga)! - Projections sharing a read model's rows ([#237](https://github.com/jmenga/effect-dynamodb/issues/237)).

  A read model several projections write carries a row token (`__edd_rt__`) on its rows: every projection write, and `create` over a tombstone, is conditioned on the token it read, so a write that read the row before another projection's write fails and retries instead of replacing it. A failed tokened write asks for the stored row (`ReturnValuesOnConditionCheckFailure: ALL_OLD`), so the `ConcurrentModification` it ends in, when retries run out, names what changed: the projection's own revision or checkpoint, the token, another projection's bookkeeping or the removal stamp.

  **A read model on whose rows `__edd_rt__` is already a name its definitions use (a model field, a `field:` rename, a key attribute of its table or of any index on it, its `created` or `updated` timestamp, the table's TTL attribute, or an outbox's key or index attribute on its table) runs without the token, as a read model with one projection does (below): no token; 1.40.0's requests, rows and refusals but for the exceptions listed there; and the user's value read back as stored. It doesn't get this release's protection for its rows: no write is conditioned on a token, and no tombstone or row keeps another projection's checkpoints. Rename the attribute holding that name to get it.** The decision is made from the definitions and the table's TTL attribute, never from what a stored row holds, so a stored `__edd_rt__` there is always the user's value. **Limit:** the definitions read are the `Table.make` handles bound, so an index attribute named `__edd_rt__` declared only through a second handle on the same physical table isn't seen: the rows carry the token, and enter that index.

  A tombstone keeps the checkpoints and revision of the other projections that have written the row since it gained a token, and a row written over it keeps them, so their redeliveries are recognised instead of applying again, bringing a removed row back or removing a row written after the removal. A row last written under 1.40.0 holds no token, so the first removal after upgrading keeps only the remover's, as on 1.40.0. Carried bookkeeping is stored as the row stores its own (renamed, packed, or as a sparse map's entries), so it reads back as written.

  A write over a live row keeps the other projections' checkpoints and revision only when, with them, it stores every attribute the row holds (but its token) under the name the row holds it by, whatever values or types it gives them. That is judged on two stored things alone, the row's attributes as read and the attributes the write's request carries (encoded, renamed, packed, a sparse map entry by entry, then marshalled), never on a definition of which attributes are data. So whatever the marshaller leaves out drops what the row held: an `Option.none()`, an emptied sparse map, an empty set (DynamoDB has none) or a sparse entry holding one; and so does an attribute another deployment names otherwise: a field one program renames, doesn't define, or keeps inside a packed field, or a sparse map under another prefix. One that drops an attribute drops them as 1.40.0 did, so those projections fold their streams again and put their part back. An empty string, list or map, a set with members removed, and a field one program packs and the other doesn't, are stored under the same name, so they keep them.

  **A projection that overwrites another projection's field on a shared row now leaves it overwritten: each event is applied once, in the order processed, and the other projection goes on from the value written.** B applies 5 to its field, then A resets the row to its initial state, B's field at 0: B's next event (7) gives 7, where 1.40.0 folded B's stream again and gave 12, and B's redelivered 5 is `alreadyApplied` and leaves 0, where 1.40.0 applied it again and gave 5. A write that removes the attribute instead drops the others' checkpoints, and they start over, as on 1.40.0.

  Which projection wrote which data attribute isn't recorded, so a write that removes only its own optional field drops the others' checkpoints too, and a field both projections add to then counts the others' events twice, as on 1.40.0 (B 5, A 1 with a note, A 2 without it, B 7: 20, not 15). On a shared row, give an optional field an empty value rather than removing it, or keep shared totals on a row one projection owns. A set has no empty value: an emptied set is a removed attribute. A field both projections add to is no longer counted twice by a write that stores every data attribute the row holds (13 where 1.40.0 gave 18).

  An attribute one projection keeps as bookkeeping and another in a different role is refused on a row both have written and that holds it (`EDD-9144`), instead of one projection's revision being read as the other's checkpoint; a rebuild, which reads no old checkpoint, is not refused.

  A write over a row 1.40.0 wrote (no token) is conditioned on every projection's bookkeeping as read, so it never replaces a 1.40.0 write landed since and never stalls. The other direction is not fixed in this release: a process still on 1.40.0 conditions its write on its own checkpoint or revision alone, so during a rolling deployment its stale write can still replace another projection's, as on 1.40.0. The token protects a row once every writer of the read model runs 1.41.0 or later.

  A read model with one projection carries no token and sends what 1.40.0 did, with these exceptions:
  - `create` over a tombstone is conditioned on the projections' bookkeeping as it read it, beside the removal stamp, so a row written over the tombstone and removed again within the same millisecond no longer lets `create` carry the older tombstone's checkpoints.
  - A projection with `removal` and no revision, writing over a tombstone it read, checks that it is still a tombstone, so it no longer replaces a row `create` wrote there.
  - On a read model with `removal`, a projection's write for a row it read absent no longer replaces a tombstone written since (1.39.0 and 1.40.0 lost the removal for good), and no longer reads the key a second time.

  `create` over a tombstone written by 1.39.0 that holds a sparse checkpoint map whole writes the map's entries onto the row, so the checkpoints survive and a redelivered event is recognised. An entry whose key a sparse map can't hold is left off.

- [#245](https://github.com/jmenga/effect-dynamodb/pull/245) [`f32989c`](https://github.com/jmenga/effect-dynamodb/commit/f32989ce554ac121ebd4b947ef5aaf07f127678e) Thanks [@jmenga](https://github.com/jmenga)! - Projections sharing an outbox ([#237](https://github.com/jmenga/effect-dynamodb/issues/237)).

  **Outbox items gain an attribute, `__edd_rm__`, their mark: the read model's tag (a hash of its key template), then `.` and a hash of the item's projection and event.** It is part of no key. A 1.40.0 drainer in a rolling deployment delivers and deletes every item this release writes, the ones written beside another included, in order, with the requests this release's drainer sends.

  **Every outbox item's `Put` gains a condition: `ConditionExpression: "attribute_not_exists(#pk) OR #rm = :rm"`, with `ExpressionAttributeNames: { "#pk": <the outbox table's partition key attribute>, "#rm": "__edd_rm__" }` and `ExpressionAttributeValues: { ":rm": { S: <the item's mark> } }`. Nothing else in the request changes, and nothing is read first.** An item replaces only the item of the same effect (a redelivery or a retry). Two items meet at one key when two read models whose row keys are the same text (one keyed by `shop` = `north#branch_b1`, the other by `shop` = `north` then `branch` = `b1`, `escapeKeys` off) write at one revision, when two projections of one read model, each with its own revision, write at one revision, and when a projection's revision starts again (its row deleted outside the projection, or its tombstone expired) with another event's item still pending there. On 1.39.0 and 1.40.0 the second replaced the first, whose effect was never delivered. The condition turns that into a cancelled transaction, read by position: the row's own condition failing is a lost race, as before; an item's alone is a key another effect's item holds, and the whole transaction is sent again with that item beside it, at its key followed by `#` and its mark, which sorts right after it. Both effects are delivered, in order. Items beside one key go in their marks' order: two of one projection's own effects are beside one key only after its revision started again (its row lost, or rebuilt by another projection) while its items were pending, and those two are delivered in their marks' order, which need not be the order they were applied in (1.40.0 kept only the later). **A read model with several projections writing outbox items pays a cancelled transaction on each write where two of them reach one revision, which is their ordinary course.** Should the key beside be held too, by anything but the same effect's item, the write fails with a `ValidationError` (`EDD-9145`) naming the read model, the row, the key, the item's mark and what holds it, with DynamoDB's error as its cause, and nothing is written.

  An item written before 1.41.0 carries no mark. One of the same event (its `source`, `streamId` and `version`) is replaced, as on 1.40.0, where nothing else can have written at its key, decided from the definitions: no other read model whose outbox is on that table can compose the key, and no other projection of the read model writes outbox items. That costs one cancelled transaction, then a `Put` whose condition also accepts it. **Anywhere else an unmarked item may be another's, so it is kept and the new one is written beside it: where it was the projection's own, rewritten after its row was lost, its effect is delivered twice.** That happens only for an item still pending from before the upgrade, at a key another read model or another projection of the read model can write. **Where it is replaced, an item pending from before the upgrade whose row was lost can be delivered twice too: when its event is applied again, a drainer that delivers and deletes it between the cancelled transaction and the one sent next lets that one write it again (1.40.0 replaced it in one request, so it was delivered once).** The outbox delivers at least once.

  **Limit: one physical table under two `Table.make` handles.** These decisions read the `Table.make` definitions, so a second handle on the same physical table isn't seen. Where two read models' row keys meet only through such handles, they count as apart: an unmarked item of the same event at the key is replaced, as on 1.40.0, even where it is the other read model's, whose effect is then lost, as on 1.40.0. And an index attribute named `__edd_rm__` declared only through the other handle doesn't stop the mark: the items carry it, and enter that index.

  **A read model whose outbox items are written where `__edd_rm__` is a key attribute (the outbox table's key or index attributes, or any key attribute of that table: a member's primary or secondary index, a vector index's, an aggregate's made on the table, an event stream's index) runs without the mark, exactly as on 1.40.0: no mark, no condition, the same requests and items. It doesn't get this release's protection: two items at one key replace each other. Rename that attribute to get it.** The decision is made from the definitions, never from what a stored item holds.

  **Where two read models' row keys can be the same text (`escapeKeys` off), upgrade their drainers before their writers.** A 1.40.0 drainer takes the other read model's items at its row for its own, as it always did: it delivers them, or, with another effect schema, fails to decode one and stops there until its claim expires, again and again. Those items now include the ones this release keeps beside its own.

  `drainPending` on an outbox index shared by read models of one entity type drains only its own read model's items, and leaves the others' unclaimed for their drainers (1.39.0 and 1.40.0 claimed them and failed, leaving them claimed). So do `drain` and `deliver` where two read models' row keys are the same text (one keyed by `shop` = `north#branch_b1`, the other by `shop` = `north` then `branch` = `b1`): each item is judged as it comes to the head of the row. The exception is an item written before 1.41.0, which carries no mark, at a key both read models can write (one keyed by `shop`, the other by `shop` then `branch`, a shop holding `#`): both drainers drain it, as on 1.40.0. Those drain away after an upgrade. `EventStore.processBatch` runs a projection object built by hand, carrying the routes but not the read model, as 1.39.0 did, instead of dying with a `TypeError`. A projection whose row key holds a bigint (a `Schema.BigInt` composite) no longer dies with a `TypeError` in `applyBatch`, `rebuild` or a multi-source projection's `applyBatch` (as on 1.40.0): grouping events by row now tells a bigint apart from a number or a string of its digits, and leaves every other key as before. The shared outbox key space check (`EDD-9134`) no longer refuses two layouts 1.39.0 handled: at bind, a date composite the library encodes (a `DynamoModel` date schema, or `Schema.DateTimeUtc`, `Schema.Date` or `Schema.DateTimeZoned`) is taken as the text its encoding writes (an ISO date or instant, or a number); a date with a codec of its own is any text, as before, so a read model keyed by a date beside one keyed by a label the date's text can't spell binds; and the outbox table's `rekey` compares a member keyed as a read model by the kind of each composite, so a literal union where the read model has a string moves its items where the read model reads them.

  The outbox table's `rekey` decides whose an outbox item is item by item, by the same function as `drainPending`, instead of refusing read models whose items it could read as each other's (`EDD-9134`, which 1.40.0 added to `rekey`). An item whose mark names its read model, or one only one read model can have written, or one every possible owner would move to the same key, moves with no extra request. An item written before 1.41.0 that two read models would move to different keys (one keyed by `shop`, the other by `shop` then `branch`, a shop holding `#`) moves by the read model whose own row is at the row it names, read from each read model's table. When no read model has that row, or a row tombstone or more than one row is there, or a read model's table isn't provided, the item is left where it is, counted in `skipped.ambiguousOwner` and listed in the report's new `ambiguous` field with the reason; a rerun leaves it again. `rekey` still refuses, as on 1.40.0, read models whose items overwrite each other with ordinary values (no mark or row can tell those apart), and a member of the outbox table whose items would overwrite a read model's and whose primary key isn't the read model's.

- [#260](https://github.com/jmenga/effect-dynamodb/pull/260) [`6ecc259`](https://github.com/jmenga/effect-dynamodb/commit/6ecc2590237d68e39a6810af644de2adbd7d3a17) Thanks [@jmenga](https://github.com/jmenga)! - **An entity whose primary key holds a ref's id works.** With `primaryKey: { pk: ["projectId"] }` and `refs: { project: ... }`, `Entity.make` accepted the entity and `put`, `create` and `insert` stored it, but `get`, `update`, `patch`, `upsert`, `delete`, `deleteIfExists`, a transaction's update, and every path of a `versioned: { retain: true }`, `unique` or `softDelete` entity (`restore` and `purge` among them) died with `Missing composite attribute "projectId" in record`, on 1.40.0 too. A key now takes the ref's id as the caller gives it, as the input does, and a key composed from a row the operation read takes it from the stored ref. `Entity.Key<E>` includes the id, and the update type and `updateSchema` leave it out, since no update changes the key. An error's `key` from a duplicate `insert` (`ItemAlreadyExists`) or from a `put` / `create` of a `versioned` or `unique` entity now holds the id as given, where it held `undefined`. Rows are stored as before.

  Also fixed: `restore` of an item whose ref's id is an index composite (a `refs` cascade index, or one of your own) wrote no key for that index, so the restored item was missing from it and a cascade skipped it. It now keys the index from the stored ref, as the `put` did.

- [#253](https://github.com/jmenga/effect-dynamodb/pull/253) [`32c5337`](https://github.com/jmenga/effect-dynamodb/commit/32c53376922bd1e83f652e7beb0a7fb8a4f7a49b) Thanks [@jmenga](https://github.com/jmenga)! - **`UniqueConstraintViolation.fields`, `DeleteAppliedButUnreadable.item`, and `current` on `ConditionalCheckFailed`, `ConcurrentModification` and `StaleAppend` are left out of the error's `toJSON`, so `JSON.stringify(error)`, `inspect(error)` and Effect's built-in log formats no longer show them.** `fields` holds the caller's values, a `Schema.RedactedFromValue` field's plaintext among them, and the others hold a whole stored item. A log line that showed which value broke a unique constraint now shows the constraint's name only. **Code that sends an error as JSON (`JSON.stringify(error)`) no longer sends these fields: send a copy (`JSON.stringify({ ...error })`) or the field itself.** Nothing else changes: code reads the fields (`error.fields.email`), and a copy (`{ ...error }`, `Object.assign`), `Object.keys`, `Equal.equals` and test equality (`toEqual`) include them, as they did. A logger of your own that reads an error's properties, instead of its `toJSON`, still sees them.

- [#244](https://github.com/jmenga/effect-dynamodb/pull/244) [`b27fd0d`](https://github.com/jmenga/effect-dynamodb/commit/b27fd0d4f4dca10fe5ffc67a413a3a740c165368) Thanks [@jmenga](https://github.com/jmenga)! - **An update's path operand is checked where a row's read resolves its position.** `pathSet`, `pathAppend`, `pathPrepend` and a record `.append()` sent their operand as given at the positions the write's own check didn't reach: a sparse map's entry named by its stored name (`target#a`), a union's members, a list of a union, a suspended or branded schema, a `Schema.UndefinedOr` field. A value no read decodes was written there, and the row couldn't be read afterwards (a standalone update failed decoding its own result, a transaction reported success). Now, where the read schema resolves the position exactly, an operand a row holding it reads is sent as before, one stored in another form a reader reads (the position's own encoding) is written in that form, and one no reader reads is refused with a `ValidationError`, before anything is read or sent. A `Schema.UndefinedOr` field's position is resolved as a `Schema.optional` field's. Where the read doesn't resolve the position exactly, the operand is sent as 1.40.0 sent it: an `Option`, a transformed or checked node above it, a decoding default, a hidden or packed attribute, an entry keyed `__proto__`, a tuple position that depends on the list's length, an entry of a sparse map stored under a `field:` rename (a read takes it whole from that attribute), and a reader or encoder that can't finish synchronously (an asynchronous step, a defect). This check never refuses or changes an operand 1.40.0 stored in a row it reads back: a property test over generated schemas checks, with Effect's decoder as the oracle, that an operand no reader reads leaves no row that reads, and that one every reader reads leaves every row reading (an operand only some of a union's members read is taken, as before). Also on 1.39.0.

  **A `pathIfNotExists` operand a check refuses is refused only where it would be stored.** DynamoDB stores `if_not_exists`'s operand only where the row lacks the path. 1.40.0 refused such an operand before sending at a top-level attribute and a struct's property, even where the row held the path and DynamoDB would have kept the stored value; at a sparse map's entry's property it didn't check it, and stored it where the row lacked the path, leaving a row that no longer read. Now, at every position: where the row holds the path, the update is written and the stored value kept; where it lacks it, the update is refused with the check's `ValidationError` (`update.pathIfNotExists`) and nothing is written. An update that reads its row decides on that read; one that doesn't sends its write requiring the path (`attribute_exists`) and decides on the row DynamoDB's refusal returns. An operand the checks take is sent as before, with no condition added. A version the update expects and the row isn't at is `OptimisticLockError`, and a row that isn't there is answered as the update is with any operand (`ItemNotFound`), on every path: at a top-level attribute and a struct's property 1.40.0 answered both with the operand's `ValidationError`.

  **A planned update's or delete's condition with an empty part is refused in `Transaction.transactWrite`.** An `or()` with no parts or a `NaN` operand in the condition of an update, or of a retained entity's delete, made the transaction die with a defect (`compileExpr: or() has no parts`), sometimes after a `GetItem`. It's now refused with a `ValidationError` (`transactWrite.condition`) before any op of the transaction reads or sends anything, as the same write alone is. Also on 1.39.0.

  **A record operation on a value of another kind is refused on every path, as DynamoDB refuses its expression.** An update that reads its row first (a `versioned: { retain: true }` entity's, one changing a unique field, one computing an index composite) applies `.add()`, `.subtract()`, `.append()` and `.deleteFromSet()` to the row it read, where any other update sends them as an expression, which DynamoDB refuses on a value of another kind. Each of these now fails as the expression does, with `DynamoValidationError` (`TransactWriteItems`) and nothing written. Some of them completed on 1.40.0, and now fail:
  - `.append()` to a string: wrote the string's characters and the operand as a list, then failed (`ValidationError`), leaving a row that no longer read;
  - `.subtract()` from a string: died on `NaN` (an index composite computed: `ValidationError`, nothing written);
  - `.add()` of a number to a string: stored `"abc2"`;
  - `.add()` of a set to a string: wrote the set, then failed, leaving a row that no longer read (1.39.0 stored `"abc[object Set]"`);
  - `.add()` of a number to a set: wrote `"[object Set]2"`, then failed, leaving a row that no longer read;
  - `.add()` of a set of numbers to a set of strings: stored the union, the number as a string (1.39.0 wrote `"[object Set][object Set]"`, a row that no longer read);
  - `.deleteFromSet()` from a string, from a number, or of a set of the other kind: reported success and wrote the row unchanged.

  The refusal's message is the library's, in DynamoDB Local's wording; the service's may differ. The same updates of an entity without the configuration are refused by DynamoDB, as they were.

  **The arithmetic of an update that reads first is DynamoDB's.** Such an update computes `.add()`, `.subtract()` and the set operations itself. A sum or difference is now exact on both numbers' decimal text, as DynamoDB's: a `bigint` field computes on both sides of 2^53 (it died: `.add()` past 2^53, and a `bigint` operand on a number read back), and `0.2 + 0.1` stores `0.3` (it stored `0.30000000000000004`). A set's members are compared by value, so a `bigint` or binary set's union no longer holds a member twice (DynamoDB refused that write) and a difference removes the members given (it removed nothing). A `NumberValue` operand is the number its text holds (`.add()` of one died, a set of them held a member twice or removed nothing). 1.39.0 got these wrong too; its set union stored `"[object Set][object Set]"`, a row that no longer read.

  **A set operand is sent as the set at its position stores its members.** `.add()`, `.deleteFromSet()`, `pathAdd` and `pathDelete` of a set whose members are stored in another form than the domain's (`Schema.ReadonlySet(Schema.NumberFromString)` stores strings) sent the domain set: a set of the other kind, which DynamoDB refused, and which, on a row without the attribute, stored a number set and left a row that no longer read; an update that reads first applied it as given, so a difference removed nothing. Such an operand is now sent, and applied, in the stored form, where the position is read exactly and exactly one form of it reads back there; any other operand is sent as before, and none is refused.

  **`undefined` for a field with a decoding default is its default, whatever form the rest of the input is in.** `{ id, n: 1, data: undefined }`, with `data` defaulted and `n: Schema.NumberFromString`, was refused by `put`, `create`, `upsert`, and a transaction's or a batch's put (`ValidationError`), though the same input beside `n: Schema.Number` stored `data`'s default. A write's input may be in the domain form or the stored form; where neither takes it whole, a field it gives as `undefined` now holds what a decode of that field makes of it, and the input is encoded. Every write stores what it stores beside `n: Schema.Number`: a `put` or `create` the default, an `upsert` the default's entries beside the row's. An input either form takes is written as before, and one none takes is refused as before.

  **An update sets or clears a `Schema.optional` date stored as the other wire kind.** Under `timestamps: true`, `createdAt: Schema.optional(DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)))` is the caller's field: nothing stamps it, and an update stores the value given. The update types took it for a stamp, so `.set({ createdAt })`, `.remove(["createdAt"])` and `.remove(["updatedAt"])` didn't compile, though each runs. The schema `DynamoModel.storedAs` returns now carries its storage schema's encoded type (`DynamoModel.StoredAs<W>`, type-level only), and the update and `.remove` types leave such a field the caller's. A date whose `storedAs` names the same wire kind, or one without a transform, is still stamped and still refused. `storedAs`'s type parameter is still the domain type (`storedAs<DateTime.Utc>(...)` compiles as before), and the schema it returns is assignable to and from the field schema's type. Also on 1.39.0.

  **`Transaction.check` with a compiled condition names the attribute a renamed field is stored in.** `Expression.condition` has no entity to rename by, so with `count` stored as `renamed`, `Transaction.check(db.entities.E.get(key), Expression.condition({ eq: { count: 1 } }))` named `count`, which no row holds: the check failed whatever the row held, and an `attributeNotExists` held whatever it held. A name used as an attribute (not as a property below one) that is a renamed model field now names its stored attribute. Every other name is sent as given. Also on 1.39.0.

  An `upsert` given `undefined` for a sparse map with a decoding default stores the default's entries beside the row's on every path, as 1.40.0 does; this is now the documented behaviour (1.39.0 gave three outcomes by configuration).

  `.subtract()` and `.append()` on an attribute, or a sparse map's entry, the row lacks, and any record operation on an attribute holding `NULL`, still end differently by path, as on 1.40.0, and this is now documented: a plain update's expression is refused by DynamoDB and writes nothing, while an update that reads the row first (a retained entity's, one changing a unique field, one computing an index composite) starts the attribute from nothing and stores `-v`, `v` or the operand alone (1.39.0 wrote `"0[object Set]"` for a set added to `NULL`, a row that no longer read).

## 1.40.0

### Minor Changes

- [#199](https://github.com/jmenga/effect-dynamodb/pull/199) [`a229b6b`](https://github.com/jmenga/effect-dynamodb/commit/a229b6b3e7ec5c674ad1a736b26ed9568e981ef3) Thanks [@jmenga](https://github.com/jmenga)! - Interrupting a call now ends its request. Every `DynamoClient` and `DynamoStreamsClient` operation passes Effect's abort signal to the SDK, so the connection closes and the SDK makes no further attempt. Aborting ends the wait, not the request: a write already sent may still be applied, and a caller who needs to know settles it with a conditional write or an idempotency token.

  `DynamoClient.layer`, `DynamoClient.layerConfig` and the `DynamoStreamsClient` layers accept `requestHandler` (a handler, or the options of the runtime's handler) and `maxAttempts`, passed to the SDK client with no defaults and no platform handler imported. `layerConfig` reads `maxAttempts` and the handler's timeouts through `Config`. A request in flight when a layer's client is destroyed now fails with a `ClientClosedError` cause instead of being sent again on a new connection.

  The change feed closes the two gaps its lease had. A renewal left unanswered is now aborted and retried inside the `duration − 2 × renewEvery` window, so one hung request no longer costs the lease. Each attempt waits `renewEvery` at most, and until one has gone unanswered it leaves a quarter of the time left for the retry, so at the default ratio a renewal slower than three quarters of `renewEvery` is aborted where it was once waited for. A feed read that times out, with a timeout configured on the client's handler, is now retried like other transient errors instead of ending the feed.

- [#212](https://github.com/jmenga/effect-dynamodb/pull/212) [`be2d94a`](https://github.com/jmenga/effect-dynamodb/commit/be2d94ab593a1402e6ef357482a8a5812f42b249) Thanks [@jmenga](https://github.com/jmenga)! - Aggregates take a new option, `ownsRows`, declaring that every row of the aggregate's entity types in its partition is its own. It's off by default. Without it, `update` and `rekey` behave as they do with this release's other decomposition fixes, which aren't 1.39.0's requests byte for byte: where 1.39.0's `update` stored an ordinary transformed edge field it didn't change transformed once more (a field that multiplies by 10 on decode, stored as 50, rewritten as 500 under a new key), it now leaves it as stored.

  `rekey` moves a custom `decompose`'s rows as stored, with only their keys replaced. 1.39.0 wrote each one from the value read, decomposed again. So a `decompose` that renames a transformed field (`f` stored as `g`, which no field declares, with `assemble` mapping it back) stored it decoded once more on every run. On a field that multiplies by 10 on decode, `g` went from 500 to 5000, and `get` read ten times more after each move.

  Without `ownsRows`, neither `update` nor `rekey` deletes or moves a row the aggregate's value doesn't key. On a `many` edge whose custom `decompose` encodes its keyed field itself (`f / 10` on a field that multiplies by 10), the value read back keys the edge's rows elsewhere. So removing an element leaves its row, and `get` still returns it. Changing the keyed value leaves the old row beside the new one, and `rekey` leaves the edge's rows under the old partition key. An edge row a custom `assemble` drops stays too. Two aggregates that share a partition and an entity type can still delete each other's rows where their keys collide. All of this is as on 1.39.0.

  With `ownsRows: true` on `Aggregate.make`:
  - **`update`** sends the transactions it sends without the option. After the last one commits, it deletes the rows it read of each edge that changed, where the new value doesn't write their keys. An edge changed when the update writes its transaction and the edge's items differ, compared as the update always compares them: entity types and stored attributes in order, not keys. After an update that changes an edge, that edge's rows are exactly what it decomposes to, but for a row another edge of the same entity type could hold, which is left. So a custom `decompose` that leaves out an element the value keeps loses that element's row. An edge the update doesn't change keeps its rows. These `Delete`s go in their own requests, up to 100 at a time, each on condition that the row is gone or still of the type read. A cancelled request is sent once more without the `Delete`s whose condition failed. The mutation never runs again and nothing is read again. If that fails too, the update fails as when a later sub-aggregate's transaction fails, and the rows it didn't delete stay until the next update that changes their edge. An update whose new value decomposes to what the old one did writes nothing: a codec that stores every number as 0 makes changing 50 to 60 a no-op.
  - **`rekey`** moves exactly the rows it moves without the option, with the same requests. Where any other row of the aggregate's types would go can't be told from what's stored, so it isn't moved. When such a row's own partition key changes, `rekey` reports the aggregate as a `failed` conflict naming the row and moves none of it. Otherwise it leaves the row and counts it under `skipped.unrecognizedKey`. An update that changes the row's edge deletes the row, which repairs a failed aggregate, unless another edge of the same entity type could hold the row. The dry run reports the same.
  - Neither reads, assembles or decomposes anything more than without the option.
  - Aggregate updates have no concurrency control. So a concurrent update's row at a key the cleanup deletes can be deleted, as a `Delete` of a key the value decomposes to can be on 1.39.0.

  `DynamoClient.make` refuses an aggregate declaring `ownsRows` (`EDD-9130`, naming the member, the entity type and how it writes the row) when another entity or aggregate it can see can write a row of the aggregate's entity types into its partition. It sees the members of the aggregate's table, the ones the client binds and the ones of the tables it binds. It counts every attribute a member stores, the library's own included, as the row holds it after the last write, on the table each row is written to: a unique sentinel's back-pointer, a projection outbox's event type or index key, or another aggregate's collection sort-key copy (on every one of its rows) under the partition key's attribute, or an aggregate's timestamp stored under `__edd_e__`, which gives its rows any type. A read model's outbox items count on the outbox's table, for every projection defined on it. It reads no schema: a model attribute, an aggregate row's context and discriminator attributes, and whatever a custom `decompose` returns, are any name holding any text. So a member whose rows can carry one of the aggregate's types is refused unless the library writes the partition key's attribute on each of those rows after them, with text that can't be the aggregate's partition key: an entity's table key attributes, or another aggregate's own partition key. It errs toward refusing: with cased keys `line` collides with `Line`, and `Line#Profile` collides with `Line` under any casing. Every row an entity writes counts, even when it declares an edge's keys: an entity puts each key value after its field's name (`id_p`) and an aggregate doesn't, so none of an entity's rows is one of the aggregate's own. The check is a safety net: a writer the client doesn't bind, in this process or another, isn't seen, and its rows are taken for the aggregate's. Every process that writes the table must bind every member that writes it. The check runs in `DynamoClient.make` only: an aggregate whose operations run without it, given a `DynamoClient` and its table's layer directly, is never checked.

  `Entity.make` refuses an entity storing an attribute under one the library writes itself (`EDD-9140`): a model field named or renamed `__edd_e__`, a timestamp or the version field so named, a model field named `__edd_e__` and stored under another name, a model field named or stored as a vector index's attribute (`__edd_v_<index>__`, `__edd_vp_<index>__`), or an attribute the entity writes that a row's reader takes as a sparse map's entry (`<prefix>#` and a non-empty key: `data##` and `data#x#y` for a map `data`, not `data#`). That covers a key attribute (the table's, a secondary index's, a vector index's), a model field by the attribute it's stored in, a sparse map renamed into another's prefix, the timestamps and the version by the attribute they're stored in, and the table's TTL attribute for an entity that writes one (a retained version's, a soft-deleted row's, a time series event's), which `DynamoClient.make` checks. Such an entity loaded on 1.39.0, and its rows didn't hold what it wrote: `__edd_e__` holds every row's entity type and every read filters on it, so the field and the type replaced each other (an `update` setting the field rewrote the type, and the row dropped out of queries). A key attribute read as a sparse entry put a phantom entry in every row read, `clearMap` removed it, and a `put` of that entry replaced the key. A timestamp or a field stored there left the row unreadable, a version read as an entry and the row's version as 0, and a TTL read as an entry (a time series event's was never stored, so the event never expired). A field named in the map's prefix and stored outside it (`data#x#y` stored as `counter`) still loads. A field named `__edd_e__` under a rename took the row's type with it. Give the field another stored name with `DynamoModel.configure`, or the map another prefix.

  `Entity.make` refuses more under `EDD-9109`, which refused a model attribute, a timestamp or the version stored in a table key attribute. It now refuses one stored in any key attribute the entity writes: each secondary index's partition and sort key, a local index's sort key, a Z-order address and a `refs` cascade index's included. On 1.39.0 the value and the key the library composes there replaced each other, so the item fell out of the index or the field read back as key text. It also refuses a model attribute named as a key attribute and stored under another name: a write composes the keys before it renames the fields, so the rename moved the key into the field's attribute, and the row lost its key (DynamoDB refused the `put` when it was the table's). Give the field another name, or the index's key attributes other names.

  Which of a row's attributes are a sparse map's entries is the reader's to say: `<prefix>#` and a non-empty key. A write of an entry checks its key as it did on 1.39.0 and sends the same requests; an update refuses the key before it reads anything, and an update that reads the row and writes it whole writes the row's own entries back whatever their keys.

  An update that reads a row to write it whole (a `versioned: { retain: true }` entity's, and one touching a unique field or a computed index composite) now reads it as every read does, sparse entries first and names after. On 1.39.0 a field named as a sparse map's entry and stored elsewhere (`data#x` stored as `counter`, beside a sparse `data`) was taken for the entry: any `.set()`, `.add()` or `.remove()` on such an entity wrote the field's value over the entry `x` and dropped the field. On such an update, `.add()`, `.subtract()`, `.append()` and `.deleteFromSet()` naming a sparse map's entry by its attribute (`.add({ "data#views": 1 })`) reported success and changed nothing; they now reach the entry, whatever its key is called (`data#constructor` included). A retained `.deleteFromSet()` also no longer shrinks the set in the snapshot of the version before it. An entry keyed `__proto__` is now read back; a read dropped it. `clearMap` removes exactly those, where 1.39.0 also removed an attribute named `<prefix>#` itself (which can be a key attribute, failing the update), and `removeEntries` takes any key the reader reads, one holding `#` included.

  `rekey` of a table holding a read model's projection outbox moves the items of every projection defined on the read model whose outbox is on that table. It moved only the last-defined projection's, and reported the others' items `unregistered`.

  A `many` edge held as a `Schema.Record` without an `entity`, whose custom `decompose` returns a date field's stored form, such as the ISO text of a `Schema.DateTimeUtcFromString` or the epoch milliseconds of a number decoded to a `Date`, stores it as it is and keys it as 1.39.0 did. Since keyed edges took their element's encoders in this release, it had failed `create` with a defect, and every `update` of its 1.39.0 rows too. There a value in neither form is refused with a `ValidationError` (`EDD-9127`), and nothing is written. An array edge, and a keyed edge with an `entity`, fail `create` with a defect on such a value, as on 1.39.0.

  A `Schema.Record` `many` edge now encodes its fields as an array edge does, where 1.39.0 stored what `decompose` returned. A `Schema.NumberFromString` is stored as its text, not the number, under the same key, and reads the same value. A field that multiplies by 10 on decode, returned by `decompose` as `f / 10`, reads back the value given, where 1.39.0 read ten times it and multiplied it again on every `update`. A row 1.39.0 wrote reads as it did.

  A custom `assemble` on a `many` edge is handed the rows read, unmarshalled, with packed fields unpacked, under their stored names, before anything is decoded. Removed from each are `__edd_e__`, the attributes named `pk` and `sk`, every attribute whose name begins with `gsi` or `lsi`, and the timestamps the edge's model doesn't declare. A collection sort-key mirror under another name stays. This is unchanged; the guide now says so.

- [#209](https://github.com/jmenga/effect-dynamodb/pull/209) [`6a0ec7c`](https://github.com/jmenga/effect-dynamodb/commit/6a0ec7c77d26d80abc633bdf3f942096f4505d9b) Thanks [@jmenga](https://github.com/jmenga)! - An aggregate takes what a caller holds as a domain value, as an entity does, so `update` no longer changes a field it wasn't asked to.

  Where a transformation has one type on both sides, an aggregate took a value as its stored form if the stored side accepted it. On a field that multiplies by 10 on decode, `create(50)` returned 500 and stored 50, where an entity stores 5. Every `update`, whatever it changed, did it again to every such field in every row: the row then stored 500 and `get` returned 5000, then 5000 and 50000. Context fields and a hydrated ref's fields compounded the same way.

  Now `create(50)` stores 5 and returns 50, `get` returns 50, and an `update` of another field leaves it. A mutation that sets a field stores its encoded form, and a value that's neither form is still refused. An update that changes nothing still writes nothing.
  - **What this affected:** a custom transformation with one type on both sides, whatever the value, and `Schema.StringFromBase64`, `StringFromBase64Url`, `StringFromHex`, `StringFromUriComponent` and `fromJsonString`, for a value already valid in that form (`create("aGVsbG8=")` returned `"hello"`). That includes a plain word that happens to be valid base64: `create("test")` on `Schema.StringFromBase64` returned `"��-"` and stored `77+977+9LQ==`, so what it was given is gone. An entity stores `dGVzdA==` and reads `"test"`. It didn't affect a transformation that gives the same result twice, such as `Schema.Trim`, or one with different types on its two sides, such as `Schema.NumberFromString`, whose stored bytes don't move.
  - **If you pass the stored form to `create`, you need to change it, and nothing will warn you.** On 1.39.0 the stored form was the only input on these fields that read back as you meant: on a field that multiplies by 10, `create(5)` read 50, and on `Schema.StringFromBase64`, `create("aGVsbG8=")` read `"hello"`. It's a valid domain value too, and no check can tell the two apart, so it's now taken as one, with no error. `create(5)` now stores `0.5` and reads 5, and `create("aGVsbG8=")` stores `YUdWc2JHOD0=` and reads `"aGVsbG8="`. Pass the value you want to read instead: `create(50)` and `create("hello")` store `5` and `aGVsbG8=`, what those two calls stored before. If you encode a value before passing it to `create`, or set an encoded value in an `update`, stop encoding it.
  - **Rows already stored stay as they are, and can't be recovered.** The library can't tell what such a row should have held, so those rows keep what they store and read as they did on 1.39.0. A row that went through `update` has compounded, once for each update. An `update` no longer makes it worse. To repair a row you need to know the right value yourself: set it in an `update`, which stores its encoded form.
  - **A `many` edge's custom `decompose` is handed a write's value as on 1.39.0, so its rows store, key and read as they did.** Where a transformation has one type on both sides, it's handed the value decoded once more: on a field that multiplies by 10, `create(50)` hands it 500. A `decompose` that encodes such a field itself (`f / 10`) stores 5 under the sort key text 50 and reads 50, as on 1.39.0, and an `update` leaves the row where it is, including a row 1.39.0 wrote. One that hands the field back unchanged still has it decoded once more on every write, as on 1.39.0: encode the field in `decompose`. Each `update` of such an edge rewrites its rows, as on 1.39.0.
  - **A `Schema.encodeKeys` struct with optional fields is stored as on an entity.** `create` stored `{}` and returned `{}`, so its value was lost. It now stores the renamed keys and reads back.
  - **`update` works where a transformation decodes to something holding a set, a class or another declaration.** A list decoded to sets, a struct or a list holding a set or a class, and a set or a class under a `Schema.suspend`: `create` took them, and a mutation returning `{ ...state, note }` failed with `Expected array`, because a mutation's state holds those as plain values. What's stored doesn't move.
  - **A decoding default stands for what its stored form reads as**, and stays stored as it was: `update` used to compound it like any other value.

- [#210](https://github.com/jmenga/effect-dynamodb/pull/210) [`8c50236`](https://github.com/jmenga/effect-dynamodb/commit/8c50236ad295f4d28efdb05ae30e6caddd3d5c0a) Thanks [@jmenga](https://github.com/jmenga)! - An aggregate write refuses a value its field's schema can't encode when, stored as given, the aggregate wouldn't read back. It fails with a `ValidationError` naming the field (`EDD-9127`), and nothing is written.

  Such a value is stored as it was given. A one-way transformation's value reads back that way, and is still stored. A transformation over itself, such as `s.pipe(Schema.decodeTo(s, SchemaTransformation.passthrough()))` where `s` holds a transformation, can't encode or decode any value, so `create` and `update` refuse it at every position: root, `one` edge, `many` element and sub-aggregate. A write that stores nothing as given does no extra work.

- [#195](https://github.com/jmenga/effect-dynamodb/pull/195) [`c8128b7`](https://github.com/jmenga/effect-dynamodb/commit/c8128b72d6f0505806914b944b2e75587df33727) Thanks [@jmenga](https://github.com/jmenga)! - Clearing a field has one form and can't leave a row unreadable. `.set({ field: undefined })` is `.remove(["field"])`, so it releases a unique value (it kept the sentinel before) and removes the index keys built from the field. Under `preserve` that is a change: the key goes, where it used to be left behind holding a value the row no longer had.

  Clearing a field no row can be without is refused with a `ValidationError` before anything is sent, for `.set`, `.remove`, `pathRemove` and the `.remove` on an `append`. Whether a row can be without a field is decided by the field's schema where none of the model's code takes part (a required field can't, an optional key can). Where a decoding default, a step or a middleware handed the absent key, a suspended schema, or a check on the value an absent attribute stands for takes part, the write that clears the field reads the absence once, as the next read would, and is refused if that fails. Defining an entity runs none of a model's code. It used to write, after which the row couldn't be read. An update naming what the library stores instead of a model field (another field's stored name, an index key attribute, `__edd_*`, the version, timestamp and TTL attributes) is refused the same way, in every record and path operation. An attribute the model doesn't know stays allowed.

  The types follow. `.remove` takes the names of model fields a row can lack, on `BoundUpdate`, `BoundAppend` and `Entity.remove`, and `.set({ required: undefined })` doesn't compile. `updateSchema` refuses `undefined`, and JSON `null`, for such a field. A `string[]` passed to `.remove` no longer compiles, and neither does `Entity.remove` in code generic over the update's payload; use a narrower type, or `.pathRemove([...])` for an attribute the model no longer declares.

  **An `undefined` in an `upsert` means the same however the upsert runs.** An entity with `unique` or `retain`, or an input omitting a defaulted index composite, reads the row first, and that path treated any `undefined` as a clear: a merely optional field lost its attribute, where the single write keeps it. It now keeps the attribute and any key holding it on both paths. A field whose `undefined` is a value (`Schema.UndefinedOr`) is cleared on both, and **an upsert clearing a secondary index composite now reads first**, because what's left of the key depends on the row; it leaves what `.set(...).remove([...])` leaves, under `sparse` and `preserve` alike. That read happens only for such an input. A defaulted index composite given as `undefined` is omitted, so it keeps what the row holds, and it used to be removed. A default no key holds is stored on both paths.

  A field whose `undefined` has a stored form, one a transform writes as `"none"`, is written as that by `.set({ field: undefined })` and by `upsert`, as it always was. `.remove` of it is refused, since a row can't be without what's stored.

  DynamoDB can't store `undefined` or an empty set, and those values now have one rule: on a field whose stored side includes one, the value is an absent attribute, and an absent attribute reads back as that value. A required `Schema.ReadonlySet` holding nothing is a row without the attribute, and reads back as an empty set; a required `Schema.UndefinedOr` likewise, reading back `undefined`. `put` and `.set` of an empty set used to throw a defect, `deleteFromSet` emptying a set left a row that couldn't be read, and so did a `put` with `undefined`. This holds at any depth and on every path, including `Batch`, `Transaction`, version snapshots, aggregates and event streams; any other value is stored exactly as before, with no extra reads. Such a field can be cleared by name, with `.remove`. `eq` / `ne` with an empty set are existence tests, and other comparisons with one are refused. An empty set can't be a list element and is refused there; a record entry holding one loses its key.

  `.add` takes a set in its types, as it always did at run time, and no longer corrupts the row on a path that reads first (a `versioned: { retain: true }` entity, or an index composite): it stored the text `[object Set][object Set]`. An aggregate `update` changing only a set is now written (any two sets compared as equal, so the change was dropped), and a mutation can hand back the plain state, which holds a set as a list (it was refused).

  A value DynamoDB can't store is a `ValidationError` naming the field, sent nowhere, where it used to be a defect from the marshaller: an empty set in a tuple, in a list, in an `.append` operand, in event data, metadata, snapshot state or an outbox effect, and likewise `NaN`, `Infinity` and a number past `MAX_SAFE_INTEGER`, anywhere they reach a write or a vector `.filter`, `.withVector` included. `Expression.condition` and the other `Expression` builders are plain functions, so they throw it at the call, as `UnstorableValue`. A tuple position holding `undefined` is refused too, unless no value follows it in an optional position: the list closed up, so the row read back with its values in the wrong positions, or couldn't be read. A `Schema.Array` holding `undefined` still closes up, as it always has: the put and the read both work, so it stays.

  A relative update that breaks a `.check()` still lands, since it can't be judged without a read, but the `ValidationError` now says the update WAS applied and that the stored row no longer matches the model, and names the field. Guard such an update with `.condition()`.

  `Entity` and `BoundEntity` each gain a type parameter, last and defaulting to `never`. A type written with the old argument count still compiles.

- [#206](https://github.com/jmenga/effect-dynamodb/pull/206) [`a4c5e43`](https://github.com/jmenga/effect-dynamodb/commit/a4c5e431df311ec3dfbf446123076ee914eb816d) Thanks [@jmenga](https://github.com/jmenga)! - An empty set inside an `Option`, a `Result`, an `Exit` or a `Cause` is an absent attribute like any other, and the value reads back as it was written.

  Leaving out an empty set dropped everything an instance keeps on its prototype, so `put` of `Option.some({ tags: new Set(), name: "x" })` stored `{"value":{"name":"x"}}` and every read of the row failed with `Expected Option`. No release wrote such a row: 1.39.0 died in the marshaller on any empty set, with nothing stored.
  - **What's stored** is what the same value with something in the set stores, without the set: the tag, the op and the marker stay. A value holding no empty set is marshalled exactly as before, with nothing extra looked at.
  - **What's read** is the value as written, the absent set an empty set, on entity reads, aggregates, events, their metadata, snapshots and outbox effects. That goes for a struct under a declaration, a `Schema.Class` or `Schema.TaggedClass` under one, one nested in another, an `Option.some` of the set itself, and lists and records of them. It also goes for a `Schema.suspend`, a `Schema.Class` with `.check()` or `.annotate()`, and a transformation's stored side, where an absent set used to be a decode failure.
  - **A union still tries every member as declared first**, so a member reading an absent set doesn't take a row a later member takes. A `oneOf` union stays whole. A set with a `.check()` refusing an empty one still has to be there.

- [#215](https://github.com/jmenga/effect-dynamodb/pull/215) [`13c6f58`](https://github.com/jmenga/effect-dynamodb/commit/13c6f587994df3912dea83c51f1db2b06a2e6fc6) Thanks [@jmenga](https://github.com/jmenga)! - An entity whose key composite is a codec that `encode` takes on its own output is now keyed by the value it stores, so every path finds its items. **Rows 1.39.0 wrote for such an entity can't be read or written by key until you run `db.tables.<Table>.rekey()`, whatever `escapeKeys` says.**

  These are the codecs whose `encode` takes what it returns and changes it again: `Schema.StringFromBase64`, `StringFromBase64Url`, `StringFromHex` and `StringFromUriComponent`, and a custom codec such as one that prepends a prefix (`x:`) and whose `decode` strips it, or one that scales a number. Every other codec keeps every key byte for byte: one whose `encode` gives back what it's given, such as `Schema.Trim`, and one whose `encode` refuses its own output, such as `Schema.NumberFromString` or a date codec.

  `put` stores `"MiX"` under such a prefix codec as `x:MiX`. 1.39.0 keyed that row by the stored text encoded once more (`x:x:mix`), while every path that composed a key from a caller's values encoded the value once (`x:mix`). The entity's own `get`, `update` and `delete` agreed with `put`, and nothing else found the row. Now `put` and every other path key it `x:mix`, once:
  - **Queries and collections find the item.** Index accessors (`db.entities.X.byIndex(...)` and `X.query.byIndex(...)`), `.where()`, `.within()` (a key range, a skip-scan, and a Z-order index's prefix and dimension levels), collections (`db.collections.*` and `Collection.make`), a vector index's `.partition()` and a geo search's composites.
  - **History finds the item.** `versions`, `deleted.list`, `history` and `history().where()`.
  - **`Batch` and `Transaction` find, check and delete the item.** They take the same domain values, and send the same key they sent on 1.39.0. What changed is that `put` now writes there. On 1.39.0, `Batch.get` and `transactGet` returned nothing for the item, a condition check on it was cancelled, and `Batch.write` and `transactWrite` deletes left it in place.
  - **A projection whose read model is keyed by such a codec takes every event.** On 1.39.0 the engine read the row at the once-encoded key, found none, and failed every event after the row's first with `ConcurrentModification`, and a removal tombstoned that key and left the row in place. The row, its tombstone and its outbox items now share one key.
  - **`reembed` keeps the vector partition `put` wrote.** On 1.39.0 it rewrote the partition out of the one queries read.

  **Before serving traffic on 1.40.0, run `rekey`** on every table holding such an entity, whatever `escapeKeys` says. Until it has run, a `get`, `update` or `delete` of a row 1.39.0 wrote finds nothing, and a `put` of the same key writes a second row beside it, which `rekey` then reports as a conflict (`bothKeys`) and leaves. `rekey` moves every row kind 1.39.0 keyed this way, to the key a write gives it now:
  - live items' table keys
  - index keys, including Z-order prefix segments, and vector and geo partitions, rewritten in place
  - version snapshots and soft-delete tombstones
  - time-series events
  - a projection's read-model rows

  Unique sentinels, and a projection's row tombstones and outbox items, already held the stored text, and keep their keys. So does an aggregate keyed by such a codec: only its own operations compose its keys, each from the value it holds, encoded once. A projection row whose new key holds the tombstone 1.39.0 wrote for it is left where it is and reported as a conflict (`taken`).

  One `rekey` pass also handles turning `escapeKeys` on: it moves each row straight to the escaped text of the value it stores. Where that brings a row 1.39.0 keyed and a row keyed by the stored text to one key (the read model's removal tombstone, or a write's row beside 1.39.0's), the second takes it, whichever `rekey` reaches first, and 1.39.0's row is left and reported as above. The bump is minor: nothing else moves, and no other entity's keys change.

- [#208](https://github.com/jmenga/effect-dynamodb/pull/208) [`677faf9`](https://github.com/jmenga/effect-dynamodb/commit/677faf9eb58a81097348fd50f67afb9ee0dd21cd) Thanks [@jmenga](https://github.com/jmenga)! - An aggregate takes what `Schema.OptionFromOptional` makes, and `update` no longer refuses the state it was handed.
  - **`aggregate.create` takes the `Option` that `Schema.OptionFromOptional` and `Schema.OptionFromOptionalKey` make, at any position.** It refused `Option.some(5n)` with a `ValidationError`, writing nothing, and only took what's stored, `"5"`. Both are taken now, in the root, a `one` edge, a `many` element and a sub-aggregate. `Option.none()` stores nothing, as leaving the field out does.
  - **`aggregate.update` works on an aggregate holding one.** A mutation returning `{ ...state, note }` failed with `Expected string`, whatever it changed, so a row with such a field could be created and read but not updated. What it didn't change stays stored as it was, and a value that's neither what the step makes nor what's stored is still refused.
  - **A step of your own encoded as optional reads back when it holds a bigint or a date.** A step from an optional key to a `Schema.Array(Schema.BigInt)`, a struct or a list works the same way as `Schema.OptionFromOptional`, on an entity, an aggregate and a stream.
  - **`Schema.Redacted` beneath a transformation onto another type is refused when the model loads (`EDD-9125`).** That includes `Schema.OptionFromOptional`, `Schema.OptionFromOptionalKey` and `Schema.OptionFromUndefinedOr`. Its value wasn't stored, and every read died. Use `Schema.RedactedFromValue`, which still works beneath them. A transformation ending in `Schema.Redacted` still reads back.
  - **A date or a redacted value decoded to a list of something else is refused when the model loads (`EDD-9125`).** On an entity, a `Schema.Array(Schema.Date)` decoded to a list of numbers or strings stored each date as an empty map, and every read failed. An aggregate already refused it.
  - **A transformation between two lists holding the same type loads on an aggregate again.** A `Schema.Array(Schema.Date)` or a list of `Schema.Redacted` over itself was refused on the way to this release, though it read back on 1.39.0 and still does on an entity.
  - **A list decoded to or from a list of bigints reads back on an entity.** A `Schema.Array(Schema.String)` decoded to a list of bigints, a list of bigints decoded to strings, a list held as `Schema.fromJsonString` holding a `Schema.BigIntFromString`, and a step from an optional list to a list of lists all wrote the row and then failed, so `put`, `create`, `upsert`, an update and a time-series `append` reported a failure for a write that had landed, and every read failed. They read back now, from what was stored already.

  What's stored for these is what 1.39.0 stored, and no row needs rewriting. Three things do change for new writes through an aggregate, and rows already stored read as they did:
  - **A `Schema.Unknown` beneath a step, given as an `Option`.** Beneath `Schema.OptionFromOptional`, `Schema.OptionFromOptionalKey`, `Schema.OptionFromNullOr`, `Schema.OptionFromNullishOr` or `Schema.OptionFromUndefinedOr`, it stored Effect's internal form of the `Option` and read back as an `Option` holding an `Option`. It now stores the value, as an entity does, and reads back as the `Option` it was given.
  - **A transformation with one type on both sides, inside an `Option` or a `Result`.** It ran an extra time on `create`, so a transformation multiplying by ten stored 500 for 50 and read 5000. It now stores 50 and reads 500.
  - **A transformation inside an `Option` or a `Result`, given in its stored form.** It stored the domain form, which its own `get` refused. It now stores what it was given, and that reads.

- [#205](https://github.com/jmenga/effect-dynamodb/pull/205) [`b617f37`](https://github.com/jmenga/effect-dynamodb/commit/b617f37ad932bf01815105ecb95174999992d8f3) Thanks [@jmenga](https://github.com/jmenga)! - A `Schema.BigInt` reads back wherever it's stored, under a declaration, a `Schema.suspend` or a transformation too, and on every owner.
  - **`Schema.Option(Schema.BigInt)`, `Schema.Result`, `Schema.ReadonlySet(Schema.BigInt)` and a `Schema.BigInt` under a `Schema.suspend` now read back on an entity and an aggregate, as they do on a stream.** Each was stored as a number and read as `Expected bigint`, unless it was past 2^53. A recursive schema reads back all the way down. What's stored doesn't change, and no row needs rewriting.
  - **A transformation over `Schema.BigInt` reads back on every owner.** `Schema.DurationFromNanos`, `Schema.ByteSizeFromBigInt`, `Schema.OptionFromNullOr(Schema.BigInt)` and your own were stored as a number, and every read failed. They aren't refused at load any more, and `aggregate.create` and `update` take them.
  - **Fewer unions are refused on a stream, a snapshot and an outbox, judged in the order a read tries the members.** `Schema.Union([Schema.Option(Schema.BigInt), Schema.Struct({ x: Schema.optional(Schema.String) })])` and `Schema.Union([Schema.Struct({ a: Schema.Number, c: Schema.String }), Schema.Struct({ a: Schema.BigInt })])` read back and are taken. `Schema.Union([Schema.Struct({ a: Schema.BigInt }), Schema.Struct({ a: Schema.Number, c: Schema.String })])` is refused (`EDD-9125`), where a value written through the second member read back as the first, without `c`. An entity or an aggregate has the same refusal under a declaration, a `Schema.suspend` or a transformation, where a read lifts the number before the union sees it.

- [#196](https://github.com/jmenga/effect-dynamodb/pull/196) [`8d0247e`](https://github.com/jmenga/effect-dynamodb/commit/8d0247ef46b66717e672f07a01a57929187d20c8) Thanks [@jmenga](https://github.com/jmenga)! - `rekey` reports index keys that aren't what their row's values compose, and repairs them on request.

  Every run now counts them in `report.indexKeys` and per member, from the row the scan already read: `missing`, `truncated`, `lagging` and `ambiguous`. `rekey({ repairIndexKeys: true })`, off by default, writes them with one `UpdateItem` a row, conditioned on each key and each composite as read, so a writer changing any of them wins. It repairs the rows the update gate damaged from v1.7.2 through 1.38. A `sparse` half with no key and two or more composites outside the primary key is counted `ambiguous` and left, as it can't be told from a writer dropping the row on purpose.

  A move no longer writes a key for a half that went without one on purpose.

  A run that didn't read the whole table (`maxPages`, `resume`) now counts an aggregate row with no root in its partition in the new `skipped.rootNotSeen`, not `skipped.unrecognizedKey`, since a later page could bring the root in. A run over the whole table does what it did.

- [#198](https://github.com/jmenga/effect-dynamodb/pull/198) [`138c4e9`](https://github.com/jmenga/effect-dynamodb/commit/138c4e90d89f7e69b51b1fd5144d16f5ea5300ce) Thanks [@jmenga](https://github.com/jmenga)! - An index key over a value the library stamps now holds that value.

  `put` composed its keys before stamping, so with `timestamps: true` and `sk: [createdAt]` or `[updatedAt]`, or under `retain` and `sk: [version]`, a row written without supplying the value was stored with no key for that index and no query could find it. `put`, `create`, `upsert`, `restore`, `Batch.write`, `transactWrite`, `EventStore` additional items and projection rows now stamp first and compose from what they stamped. **Rows that were silently missing from these indexes now appear** when written. Existing rows need `rekey({ repairIndexKeys: true })`, which counts them as `missing` and brings them in.

  An update moves a half holding `updatedAt` when it can compose it. If another of the half's composites is on neither the payload nor the primary key, the key is left under either policy and lags until a write can compose it: `sk: [status, updatedAt]` on `.set({ note })` never drops or truncates. `rekey` doesn't count a key that only lags. An update's `updatedAt` never counts as touching a half. `[status, createdAt]` on `.set({ status })` still truncates to `status_b`, the existing partial-payload rule; `rekey({ repairIndexKeys: true })` restores it.

  **These definitions now fail at load, and each has never worked:** `version` as an index composite without `retain` (`EDD-9121`: no write knows the next value, and no item ever held the key; it's a compile error too); `updatedAt` or `version` in a primary key or `shards.by` (`EDD-9121`: a primary key never changes, and a shard would go stale on every write); and a `configure` `field:` rename of the version attribute (`EDD-9122`: every write after the first failed; use `versioned: { field }`).

  Other behaviour that changes:
  - A `Schema.optional` date `createdAt` or `updatedAt` on an entity is now stamped unless supplied, as `Schema.optionalKey` always was.
  - `upsert` over a secondary index composite that's `createdAt` or `immutable` now keeps the stored value in the key as well as the attribute; before, the key held what the input said, or there was none. It adds no read. It's one `UpdateItem` with a condition, and the rejected write returns the row at no read charge where one write can't get the key right: an input naming another value of an `immutable` composite in a key holding something else, a row with no key, or `[status, createdAt]` with a changed status and no `createdAt` in the input. Those take a second write, and the rejected one is charged write capacity. With a primary key over an unsupplied `createdAt` it creates, where `put` used to die.
  - A time-series `append` over a `createdAt` composite now keeps its key, with no read before the write, so the row joins that index. Where the rest of the key changed, a rejected transaction is followed by a second one. With `skipFollowUp` it sends no read at all.
  - A `configure` rename of `createdAt` or `updatedAt` is now written under the renamed attribute by `update`, `upsert` and `append`, which used to leave an attribute under the model's name and a stale value under the other.
  - A projection's row with an outbox composes its keys from the `createdAt` it keeps.
  - An aggregate's list key or collection sort key over `createdAt` or `updatedAt` now holds what the root row holds, where it used to hold the supplied value until the next update, and then the previous stamp.
  - **An aggregate row that declares a date `createdAt` or `updatedAt` now works as an entity does**, at the root, a sub-aggregate root, a `one` edge and a `many` element. The input doesn't need it, where `create` used to fail with `Missing key` without one. `create` stores the stamp whether or not a value is supplied, as it did, and `create` and `update` return what they stored, where they used to return the supplied value or the one from before the write. A `Schema.optional` date on the root is now stamped, where nothing stamped it, unless `create` is given a value for it, which it stores, as it did. A sub-aggregate or edge that declares a date used to fail every `get` and `update` with `Missing key` and can now be read. `aggregate.update` keeps a stored `createdAt` whatever the mutation did. A field of that name of another type stays the caller's, on that row.
  - **An optional composite in an aggregate key with no value no longer dies with a defect.** In a `list` key, sharded or not, the row is left out of that list, as a sparse index on an entity leaves it out. In a collection sort key or the partition key it's a `ValidationError` (`EDD-9123`) before anything is written, since a root outside the collection index can't be read back; `delete` reports it as `AggregateAssemblyError`. A `list` filter that leaves out a composite of the list's partition key is the same `ValidationError`.
  - **These aggregate definitions now fail at load** (`EDD-9121`): a partition key or a `many` edge's sort key over a stamped `updatedAt`. Both name the row, so every update wrote a new row and left the old one.
  - **A `Schema.ReadonlyMap` on a model's stored side now fails at load** (`EDD-9125`), on `Entity.make` and `Aggregate.make`, pure and operational, at any depth, naming the path. Use `Schema.Record`: it's stored the same way, so existing rows read back with no rewrite. A map field was stored as a DynamoDB map, which reads back as a plain object, so `put` succeeded and every `get` and `update` of that row failed. The one form that got further is an aggregate's `many` edge over a map with `decompose` and `assemble`, where `create` and `get` worked and `update` failed; it's refused too. A map whose stored side is something else, decoded from a record or through `Schema.toCodecJson`, reads back and isn't refused.
  - **`EventStore.makeStream` refuses the same, by the same rule** (`EDD-9125`), for an event, `metadata` and snapshot state, at any depth. A stream was the worst of it: `append` and `writeSnapshot` succeeded, and every `read` of that stream then failed with `Expected ReadonlyMap`, on data nobody could read. `Schema.Record` reads those rows as they are, so changing the schema recovers them with no rewrite. A packed event or snapshot holding a map, whose write already failed, now fails at load instead.
  - **`EventStore.projection` and `EventStore.multiProjection` refuse the same in `outbox.schema`** (`EDD-9125`). An effect holding a map was committed with the row, then failed every `drain` from the head of the row's queue, so nothing after it could be delivered either. `Schema.Record` reads those effects as they are.
  - `put`'s type no longer offers a plain `createdAt: Schema.String` as optional: the runtime always required it. An update may name one, as the runtime always let it.

  **Values that can't be stored are now a `ValidationError`, on every path, with nothing sent.**
  - A `NaN` in a `Schema.Number` key composite is refused with `EDD-9096` with `escapeKeys` off, as it is with it on. The stored text of every other value is unchanged. Up to now it composed `0000000000000NaN`, so `get` and `delete` looked for a key nothing holds, `purge`, a query, a batch and a transactional delete reported success having sent it, and a `put` died in the marshaller. A `Schema.NumberFromString` composite's `NaN`, stored as `"NaN"`, keeps that text with `escapeKeys` off, as up to 1.39.0: its row is written, read, queried, updated and deleted by its key on every path, and `rekey` finds it in place. With `escapeKeys` on it's refused like any `NaN`, and `rekey` reports a row stored under it as the conflict `uncomposable`. 1.37 and 1.38 refused both.
  - A value with no DynamoDB form, `NaN`, `Infinity` or a number past `Number.MAX_SAFE_INTEGER`, is a `ValidationError` (`EDD-9124`) from any write, condition or filter, where it was a defect. `Expression.condition`, a plain builder, throws the tagged `UnstorableValue`.
  - **A query accessor, `.where()` or `.within()` given such a value no longer throws when called.** It returns a builder whose terminal fails with the `ValidationError`, nothing sent, and whose `.explain()` is the `empty` plan with the reason. That includes `versions`, `deleted.list`, `history`, collections, and a Z-order bound a dimension can't place (`EDD-9092`). Code catching the throw should handle the failure instead. A missing composite and other misuse the types catch still throw.
  - Aggregates, event stores and `GeoIndex.nearby` return the `ValidationError` too, where they died. A projection's row key with no text is that row's `Failed` outcome, not the batch's.

  **`upsert` omitting an optional composite no longer leaves the other half stale.** With `pk: [owner]`, `sk: [note]`, `upsert({ owner: "o2" })` stored `owner: o2` under `owner_o1`. Each half is now judged alone, with no read and, when nothing the input names is in a half it leaves, no condition. A half it names part of holds on those values, a rejected write returns the row free and composes from it, and what neither supplies goes by the half's policy. A new row given one half now has that key attribute, without being in the index.

  `.remove()` of a `createdAt` or `updatedAt` that isn't a date now compiles, as it always ran: that field is the caller's. So is `Schema.UndefinedOr` of a date, which nothing stamps, so `put`'s type asks for it as the runtime does. A date under `Schema.optional`, or required, stays a compile error and a `ValidationError`, since the library stamps it.

  **Aggregates:**
  - `create` stamps a `Schema.Record` `many` edge with a custom `decompose` and `assemble`, and its dates are stored in their own form. It failed with `Missing key` before, or with no `entity` stored a date as a map no read could decode. The input type and `inputSchema` make those dates optional.
  - `sk.composite` on a `Schema.Record` `many` edge now compiles, and each name is checked against the record's value. It had been a compile error whatever the name, since the check read only an array's element.
  - A `one` edge with no `entity` takes its value in the input, as `create` always did. The type and `inputSchema` asked for an id it can't use.
  - `@effect-dynamodb/schema`'s `Aggregate.make` refuses a `many` sort key over a stamped `updatedAt` (`EDD-9121`), as the operational one does.

- [#204](https://github.com/jmenga/effect-dynamodb/pull/204) [`f07650b`](https://github.com/jmenga/effect-dynamodb/commit/f07650bd0f7fd5a8ed61daa2ef683bf30c55bdae) Thanks [@jmenga](https://github.com/jmenga)! - Types that can't be read back now fail when the definition loads, and an aggregate's `update` takes back the state it was handed.
  - **`EDD-9125` now covers Effect's other types that can't be read back**, on `Entity.make` and `Aggregate.make`, pure and operational, on `EventStore.makeStream` for an event, `metadata` and snapshot state, and on `outbox.schema`, at any depth, naming the path and the replacement. On every owner: `Schema.URL` (`Schema.URLFromString`), `Schema.ByteSize` (`Schema.ByteSizeFromString`), `Schema.URLSearchParams`, `Schema.RegExp` (`Schema.String`), `Schema.FormData`, `Schema.Headers`, `Schema.HashMap` (`Schema.Record`), `Schema.File` (`Schema.Uint8Array`), `Schema.ErrorInstance` (`Schema.Defect()`), `Schema.Chunk` (`Schema.Array`), and a bigint `Schema.Literal`. Before, `put` succeeded and every `get` failed with a `ValidationError`, or for a `Schema.Chunk` the write died with a stack overflow.
  - **On a stream, a snapshot and an outbox, `Schema.Date` and `Schema.Redacted` are refused too** (`Schema.DateFromString`, `Schema.RedactedFromValue`), as they are on an entity or an aggregate under another declaration such as `Schema.Option`, under a `Schema.suspend`, or under a transformation over a container. `Schema.Date` and `Schema.Redacted` are refused in a struct, a record, a tuple or a union with a decoding default too. Before, `append` of an event holding one succeeded and every `read` of that stream failed. An event holding another member's value, such as `null` under `Schema.NullOr(Schema.Date)` or a string under `Schema.Union([Schema.String, Schema.Date])`, was appended and read back on 1.39.0, and a stream declaring such a union is refused all the same. `Schema.DateTimeUtcFromDate` and any transformation over `Schema.Date` are refused on an entity, a stream, a snapshot and an outbox, and on an aggregate under a union or when it decodes to something other than a date (`Schema.DateTimeUtcFromString`).
  - **A `Schema.BigInt` on a stream, a snapshot and an outbox now reads back.** A number below 2^53 stopped every read of the stream it was in, and of a command handler over it, so a stream holding 2^60, 2^61 and 5 couldn't be read past its third event. Event data, metadata, snapshot state and `outbox.schema` read a stored number as a `bigint`, at any depth, under `Schema.NullOr`, `Schema.optional`, a brand, a check, `Schema.Option`, `Schema.ReadonlySet` and `Schema.suspend`, in change-feed images too, and rows already stored read with no rewrite. What's stored doesn't move. Every member of a union gets its try as declared, and only a number no member takes is lifted. A union that stores something else as a number is refused at load (`EDD-9125`), in that field or across a stream's events, since `5n` and `5` are stored the same: `Schema.Union([Schema.Number, Schema.BigInt])`, `Schema.Literal(5)`, `Schema.Int`, or a number-stored transformation beside it, and `Schema.Unknown` or `Schema.Json`, which would take the number. A stream declaring such a union loaded on 1.39.0, and appended and read its events. Use `Schema.BigIntFromString`. A packed `bigint` is still refused at write, with nothing written, since JSON has no form for it.
  - **A value of a custom declaration that wouldn't read back is refused at write (`EDD-9126`).** A `Schema.instanceOf` over a class of your own has the same AST as a duck-typed `Schema.declare`, so it can't be judged at load. Fields holding one are found at load, and at write their value goes through the real marshaller and back and is decoded by the field's read schema. If that fails, the write is a `ValidationError` and nothing is written. Before, `put` succeeded and every `get` and any query over the row failed. It covers `put`, `create`, `upsert`, `update` and `patch` with their path operations, a time-series `.append()`, `Batch.write`, `Transaction.transactWrite`, an aggregate's `create` and `update`, and on a stream `append`, `commandHandler`, `additionalItems`, `writeSnapshot`, inline snapshots, metadata and outbox effects. A duck-typed `Schema.declare` that takes what's stored keeps writing, and so does a struct decoded to a class, or a union with another member that takes the map. A model with none sends the same requests and does nothing extra. Rows already stored stay as they are and still fail on read.
  - **`Schema.NullOr(Schema.BigInt)` and any other `Schema.BigInt` under a union now read back on an entity and an aggregate.** It was stored as a number and read as `Expected bigint | null`, unless the value was null or past 2^53. Every member gets its try as declared, and a number none of them takes is lifted, at any depth, so `Schema.Union([Schema.String, Schema.BigInt])`, `Schema.NullOr(Schema.Struct({ b: Schema.BigInt }))`, `Schema.Array(Schema.NullOr(Schema.BigInt))` and `Schema.Union([Schema.Number, Schema.Struct({ b: Schema.BigInt })])` come back as written. What's stored doesn't change, and no row needs rewriting. Next to a member that takes a number, that member keeps what it takes: `Schema.Union([Schema.Number, Schema.BigInt])` reads `5n` back as `5`, as the modeling guide says.
  - **What's beneath a decoding default now reads back.** A `Schema.BigInt`, and a date stored as Effect's internal form, in a struct, a record, a tuple or a union with `Schema.withDecodingDefault` or `Schema.withDecodingDefaultKey`, failed the read, or on an aggregate failed `create`. Nothing stored changes.
  - **`Schema.optionalKey` over a union keeps every member on an entity and an aggregate.** Only the first member was kept wherever something needed substituting, so `Schema.optionalKey(Schema.NullOr(Schema.DateFromString))` refused `null`, and `Schema.optionalKey(Schema.Union([Schema.Date, Schema.String]))` refused a string. What's stored for a date doesn't change: the first member is written in its stored form and the later ones as they're declared, so `Schema.optionalKey(Schema.Union([Schema.DateTimeUtc, Schema.String]))` stores a string and `Schema.optionalKey(Schema.Union([Schema.String, Schema.DateTimeUtc]))` stores Effect's internal form, and both read back as the date.
  - **A later member's value isn't turned into the first member any more.** A value the first member could also read was converted to it: under `Schema.optionalKey(Schema.Union([Schema.DateTimeUtc, Schema.Number]))`, `5` was stored as `1970-01-01T00:00:00.005Z` and came back as that date, and under `Schema.optionalKey(Schema.Union([Schema.DateTimeUtc, Schema.String]))`, `"5"` came back as a date in 2001. Each is now stored and read back as it was given. A row stored the old way still reads as the date it holds, and an earlier release reads a row stored the new way as the same date it read before.
  - **`Schema.Date` and `Schema.Redacted` after another member of a `Schema.optionalKey` union are refused**, on an entity and an aggregate, in a struct or a list too. Written as declared, a date is stored as an empty map and a redacted value loses what it holds, so neither reads back. The other member's values (a string, a number, `null`) were stored and read back on 1.39.0, and such a model no longer loads. Declare the member first, or use `Schema.DateFromString` or `Schema.RedactedFromValue`. On an aggregate, `Schema.optionalKey(Schema.Union([Schema.Null, Schema.Date]))` in an attribute of its own isn't refused: its date encoder stores it as a string.
  - **An aggregate reads a date it stored in a union of nothing else but null or another date.** `Schema.NullOr(Schema.DateFromMillis)`, `Schema.NullOr(DynamoModel.DateEpochMs)`, a date with `DynamoModel.storedAs` next to a `Schema.Null`, and `Schema.Union([Schema.DateFromMillis, DynamoModel.DateEpochMs])` are stored as a string on an aggregate, which the read refused, so the row couldn't be read or updated. A value of the later date in such a union no longer dies on `create`. Nothing already stored changes.
  - **A redacted value's label comes back on an entity and an aggregate.** `Schema.RedactedFromValue(Schema.String, { label })` read back without its label.
  - **A definition holding one of these has to change before it loads.** For a type refused on its own, nothing else needs changing, since it never read back. A union with a refused member is the exception: 1.39.0 loaded it and read back the values of its other members, and only a value of the refused member was stored unreadable. A `many` edge's own field isn't refused, since its collection is rows: a `many` edge over a `Schema.ReadonlyMap`, refused in the previous change, is created, read and updated.
  - **`aggregate.update` no longer refuses the state it was handed.** A mutation returning `{ ...state, note }` failed with `Expected Option`, whatever it changed, for a field holding a `Schema.Option`, `Schema.Result`, `Schema.Exit`, `Schema.Cause`, `Schema.HashSet`, `Schema.Graph`, `Schema.Cookies` or `Schema.UrlParams`, and for a `many` edge over a `Schema.Chunk`, `Schema.HashMap`, `Schema.HashSet` or `Schema.ReadonlyMap`. A domain value and the state's plain form are both taken, and anything else is still refused.
  - **`aggregate.create` no longer loses a map decoded from a record.** A `Schema.ReadonlyMap` decoded from a `Schema.Record` with `Schema.decodeTo`, as the guide recommends, was read as a record with no keys, so `create` succeeded and stored an empty map. Its entries are stored now. What an earlier release stored empty stays empty.
  - **`aggregate.create` and `update` take a domain value for any transformation that isn't a class or a struct**, whatever it's stored as: `Schema.Defect()`, `Schema.RecordFromCookies`, `Schema.RecordFromUrlParams`, `Schema.OptionFromNullOr`, `Schema.OptionFromUndefinedOr`, `Schema.OptionFromNullishOr`, `Schema.toCodecJson` and a list held as JSON, and under a declaration with a transformation inside, such as `Schema.Option(Schema.DateFromString)`. `create` refused them with a `ValidationError`, writing nothing, and `update` refused any aggregate holding one. `Schema.Option(Schema.DateFromString)` given in its stored form was stored with its date lost: it's stored as a string now. `Schema.OptionFromOptional` and `Schema.OptionFromOptionalKey` keep their behaviour: `create` takes the stored form and `update` refuses them.
  - **A date on a stream, a snapshot and an outbox now reads back as a real `DateTime`.** `Schema.DateTimeUtc` and `Schema.DateTimeZoned`, in event data, metadata, snapshot state and `outbox.schema`, at any depth, under `Schema.suspend`, a brand, a check and `Schema.Option`, on `read`, `readFrom`, `readLatest`, `readSnapshot`, `readIndex`, `query`, a command's load, projections, `processBatch` and an outbox's `drain`, native and packed. They read back as a plain object with the same fields: `Equal.equals` with the written date was `false`, `.pipe` was `undefined`, and on a zoned date `DateTime.formatIsoZoned` threw. A zoned date's zone is real too. What's stored doesn't change, and rows already stored read back real with no flag and no rewrite, including rows from Effect's betas, marked `~effect/time/DateTime`.
  - **A new date can be written to packed event data and a packed snapshot.** A date a read returned was packed and a new one was refused, so a command that decided on a new date failed its write, and `writeSnapshot` did too. A `DateTime` is now stored as the same text, whichever it is, and it round-trips. Anything else JSON can't represent is still refused. A packed `Schema.Unknown` field takes one too, on a stream and on an entity, and reads back the map, as a native `Schema.Unknown` always did, since nothing declares a date there.
  - **Code holding a date read from a stream sees a real date.** `JSON.stringify` gives its ISO text instead of its map, a spread or `Object.keys` gives only `epochMilliseconds` instead of all its fields, and handing it to a `Schema.Json` field fails validation, as a new date there always did. A struct listed first in a union that takes the same fields still takes them.
  - **The modeling guide says what reads back changed**: `Schema.Duration` as a plain object its functions still work on (use `Schema.DurationFromMillis`), `Schema.Option` stored as Effect's internal form, `Schema.BigDecimal` with arithmetic that throws below 2^53 and a `put` that dies once it's normalised (use `Schema.BigDecimalFromString`).

### Patch Changes

- [#216](https://github.com/jmenga/effect-dynamodb/pull/216) [`ee292fa`](https://github.com/jmenga/effect-dynamodb/commit/ee292fa3840feb84c7214b4581827709a133e4d0) Thanks [@jmenga](https://github.com/jmenga)! - An aggregate's `create` is typed by what it takes. `Aggregate.create` and `db.aggregates.X.create` took `Record<string, unknown>`, so nothing a caller passed was checked. Their parameter is now derived from the model and the edges (`Aggregate.AggregateCreateInputType`).

  The type refuses the inputs that 1.39.0 accepted at compile time and failed on at run time, and takes everything that worked there: each field's domain value or its stored form, an edge's entity by its id or whole, keys the model doesn't declare, and the aggregate's own key composites. Code that passed an input 1.39.0 failed on, such as one without a required edge or a key composite, or a value of another type than its field's, no longer compiles. An input whose static type has a string index signature (`Record<string, unknown>`, parsed JSON, `any`) is taken as it is and judged at run time, as before.

  `Aggregate` and `BoundAggregate` gain a fourth type parameter, `TCreate`, defaulting to `any`, so a type written with three arguments still names every aggregate. Types only: no request, stored byte or run-time behaviour changes.

- [#233](https://github.com/jmenga/effect-dynamodb/pull/233) [`63d2ba5`](https://github.com/jmenga/effect-dynamodb/commit/63d2ba5e64eaaac354be168e3832ffde38cf2b80) Thanks [@jmenga](https://github.com/jmenga)! - An aggregate's `create` returns what 1.39.0 returned when it's given a value in the form a transformation to `Unknown` stores. A field transformed from a struct or a record to `Unknown`, given its stored form (alone, under `NullOr` or `optional`, or in a union with a tagged struct), comes back decoded, not as given. A `many` element given whole, in a union whose wrapping member transforms to `Unknown` or a declaration, comes back with its entity's class instance, not a plain object. What's stored and read back for these doesn't change.

  A union element whose other member renames a field and transforms to `Unknown` (`line` stored, `text` held), given that member's stored form, is stored and returned by `create` as on 1.39.0: the row holds the member's domain field (`text`) unencoded. 1.39.0 couldn't read such a row back. It now reads back, but don't rely on how it does: as the row's attributes, in their stored order, with a sub-aggregate's discriminator among them. Give such a member its domain value instead.

- [#203](https://github.com/jmenga/effect-dynamodb/pull/203) [`a541e2c`](https://github.com/jmenga/effect-dynamodb/commit/a541e2cc5ecaebecfc0c0b0286a7780621498ffd) Thanks [@jmenga](https://github.com/jmenga)! - `Aggregate.list` can page past a key holding text above U+00FF. Such a page used to die with an `InvalidCharacterError` defect, so the caller couldn't get past it. `list` now uses the same cursor codec as `Query`: a key `btoa` can carry keeps the bytes it always had, and any other key gets a `v2.` cursor. A cursor handed out by an earlier release still resumes.

  A cursor `list` can't decode is a `ValidationError` (`[EDD-9094]`, `operation: "list"`) with nothing sent, where it used to be a defect. So is a `.within()` or sharded query's cursor, and so is an empty string, which used to read from the start. A sharded list still refuses every cursor with `EDD-9051`.

- [#214](https://github.com/jmenga/effect-dynamodb/pull/214) [`d8ae91a`](https://github.com/jmenga/effect-dynamodb/commit/d8ae91a923bd5baba81270a4d5f229b1420253cd) Thanks [@jmenga](https://github.com/jmenga)! - An aggregate `create` no longer dies or drops an id hydrating an edge with an `entity`, and a multi-item op finds an item whose key composite is a codec.
  - **A `many` edge whose element is the entity's own model, given whole, is stored as given.** Its key field (`lineId` of a `Line`) was taken for an id to fetch because its name was `${field}Id`, and `create` died with `Missing composite attribute "lineId"`, or fetched it and refused the element without its key. Where 1.39.0 fetched it and completed (the key is the model's identifier, the entity's only key composite, and optional in the model), it is fetched as before, and the element is stored without it. A `many` element takes an id of the entity's key type only where its definition says it holds the entity: the element is the entity, or it is a plain `Schema.Struct` or `Schema.Class` whose field of the entity's name is the entity's own model (under `Schema.optional` at most, `DynamoModel.ref` and checks included) and which declares no `${field}Id` of its own. The entity's own model is the schema the entity was made with (its `DynamoModel.configure` wrapper taken off), or that schema annotated, checked or branded, compared by reference: a class that shares the entity's identifier, or a struct declaring its fields again, is another schema. That element takes the entity whole, its id beside it or not, or its id under `${field}Id`, in its input schema and its input type, beside the forms 1.39.0's input type took, which are kept for an entity one id names. For an entity keyed by more than one composite, the input type takes the entity whole and no longer an id: every such id died at run time on 1.39.0. The type sees that field for an entity whose model is a `Schema.Struct` (in a `DynamoModel.configure` wrapper or not) with a string literal `entityType`; for any other model, a `Schema.Class` included, the element is typed as on 1.39.0.
  - **A `one` or `ref` edge's id follows the rule a `many` element's does.** A string `${field}Id` is fetched exactly as on 1.39.0, whatever the model or the element declares. A number, bigint or `Date` id is fetched only where the model's field of the edge's name is the entity's own model, the model doesn't declare `${field}Id` itself (then it is the model's own data, stored as given), and the entity isn't given whole (then it is stored as given, never replaced or read again).
  - **Every other `many` element hydrates as on 1.39.0.** A union element (through a transformation or `suspend` too), an element through a transformation, and one whose field of the entity's name is a scalar, an `Option`, a `Result`, another struct or the entity under `NullOr`, or which declares `${field}Id` itself, is hydrated when it's given a string `${field}Id` (or a string as the element), at the root and in a sub-aggregate, and its input schema and type are 1.39.0's. The one change is a string id of no type of the entity's key composite (`"5"` for a number key), which fails with `EDD-9131` as everywhere else.
  - **An entity with no `DynamoModel.identifier` is fetched.** `create` fetched each id under the identifier, or under `id` without one, and died composing the entity's key. It now fetches under the entity's primary key's only distinct composite (an attribute in both halves of the key counts once). That covers `one` and `ref` edges, `many` elements given as ids and elements wrapping the entity, and an entity whose identifier names another field.
  - **A number, bigint or `Date` id is fetched.** Only a string was collected, so a number or bigint id was dropped: a required edge failed decoding and an optional edge was created without the entity. An id is now a value of the key composite's type, or of its stored or JSON form (`"5"` of a `NumberFromString`, an ISO string of a `Date`), and the input type and schema take that type, outside a union element. A key composite that is a codec inside a wrapper (`Schema.optional(Schema.NumberFromString)`, a `NumberFromString` in a union with a literal) takes either form too, and is fetched by the key `put` wrote (`lineid_5`).
  - **An id of no type of the key composite fails `create` with a `ValidationError` (`EDD-9131`).** A string of the wrong type failed with `RefNotFound`: `"5"` for a number key was fetched under `lineid_5`, a key no `put` writes. The error is now a `ValidationError`, on the error channel, and nothing is fetched. Code that catches `RefNotFound` for such an id no longer sees it: catch `ValidationError` instead, or pass an id of the key's type. **A value of the wrong type that isn't a string was dropped without an error**: on an optional edge or element, `lineId: 5`, `0` or `false` for a string key created the aggregate without the entity. It is now refused with `EDD-9131` too, and nothing is written. An id `put` refuses fails the same way, before anything is fetched, by `put`'s own rule: one DynamoDB can't store (`Infinity`, alone or anywhere in a struct, an `Option` or a `Result` id), or one that doesn't encode as the key composite is stored (`Infinity` for a digits-only string codec). The error names an object id by its JSON. An id `put` stores is fetched as before, `"Infinity"` for a `NumberFromString` key included. Its key text could name an item of another value, which was fetched in its place.
  - **An entity keyed by more than one composite fails `create` with a `ValidationError` (`EDD-9129`)** naming the edge. No one id names one of its items. It died the same way. Every edge is judged before anything is fetched or written.
  - **`Batch.get`, `Batch.write` deletes, `transactGet`, and `transactWrite` deletes and condition checks compose the key `Entity.put` wrote** for a key composite that is a codec. For a codec whose `encode` takes its own output (a prefix), `put` encodes the composite twice and these paths encoded it once. For a codec inside a wrapper (`Schema.optional(Schema.NumberFromString)`, `Schema.optional(Schema.BigIntFromString)`, a `NumberFromString` in a union with a literal, an optional prefix codec), `put` keys the stored text (`id_5`) and these paths keyed the domain value (`id_0000000000000005`). Either way they found, deleted and checked nothing. Aggregate ref fetches go through the same path. Every other key composes exactly as before.

  **Visible change: a caller's key is a domain value, as `get` takes it.** Given the _stored_ text of a key whose codec's `encode` takes its own output (`Schema.StringFromBase64`, `Schema.StringFromHex`, `Schema.StringFromUriComponent`, a codec that prepends a prefix, alone or inside `Schema.optional` or a union), these multi-item ops and aggregate ref ids now address the item whose domain value is that text, as `get` does. 1.39.0 addressed the item stored under it. Pass the domain value: `{ docId: "MiX" }`, not `{ docId: "x:MiX" }`. A numeric codec (`NumberFromString`, `BigIntFromString`) still takes either form.

  No stored key changes.

- [#232](https://github.com/jmenga/effect-dynamodb/pull/232) [`b5b7454`](https://github.com/jmenga/effect-dynamodb/commit/b5b745415f3399fe978eb7bec015f951a25f53e5) Thanks [@jmenga](https://github.com/jmenga)! - Timestamps are stored the way 1.39.0 stored them, in three places this release had changed.

  **An aggregate stores a timestamp in the form its row stores any value of that field in**, on `create` and `update`, on the root and on edges. A date a row declares is stored in its own encoding, except under `Schema.optional`, where a value is stored as ISO text, as on 1.39.0. The stamp was written in the date's own encoding instead, so a root declaring `updated: Schema.optional(DynamoModel.DateEpochMs)` kept a value passed to `create` as ISO text and then got an epoch-milliseconds number from `update`, and one attribute held two forms. A row that doesn't declare the field is stamped in the root's form. Rows already stored read back in either form, and nothing needs rewriting.

  **An aggregate's `create` stamps a root date declared `Schema.optionalKey` over a value passed for it**, in its own encoding, as 1.39.0 did. Only a date the root declares `Schema.optional` keeps a value passed to `create`. Before, `Schema.optionalKey` kept it too, so a placeholder passed for it became the row's timestamp.

  **An entity's `Schema.optional` date over a transform stored as the other kind is the caller's again**, as on 1.39.0, such as `createdAt: Schema.optional(DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)))` with `timestamps: true`. Without `Schema.optional`, `Entity.make` refuses such a field as a timestamp, since the transform stores its own form and the stamp can't be read back. This release stamped it anyway, in a form the field can't read back: a row written without a value for it, and any time-series `append`, failed with `Expected DateTime.Utc` once written, and so did every read of it. Now `put`, `create`, `update`, `upsert`, `Transaction.transactWrite`, `Batch.write` and a time-series `append` store a value passed for it in the transform's form and store nothing without one, as 1.39.0 did.

- [#230](https://github.com/jmenga/effect-dynamodb/pull/230) [`131b6b9`](https://github.com/jmenga/effect-dynamodb/commit/131b6b96369e7053b3da653894396854d8b3d0c3) Thanks [@jmenga](https://github.com/jmenga)! - An aggregate takes and reads back a union element whose members transform to `Unknown` or a declaration as 1.39.0 did. A member's value given a string id its edge fetches is refused with a `ValidationError` and nothing written, not created with the fetched record in place of the caller's field. Another member's row reads back as that member, not in the row's stored attribute order with a sub-aggregate's discriminator in it. A field transformed from a struct or a record to `Unknown` refuses a value its transformation can't store, as 1.39.0 did, instead of storing it as given.

- [#224](https://github.com/jmenga/effect-dynamodb/pull/224) [`623a299`](https://github.com/jmenga/effect-dynamodb/commit/623a29925c60e060cda90db4a5f589c84ff6907b) Thanks [@jmenga](https://github.com/jmenga)! - `Batch.write` splits its requests at DynamoDB's 16 MB request limit as well as by count. That limit applies to the request body, the JSON text sent, which is larger than the items: a control character takes 1 byte in an item and 6 in JSON, `"` and `\` take 2, and binary values are sent as base64. So 25 items within the 400 KB item limit could pass 16 MB in one `BatchWriteItem`. DynamoDB refused it, and `Batch.write` failed with a `DynamoError` that named no item. `Batch.write` now splits its plain requests at 25 items or 16 MB of request body, whichever comes first, and its versioned-put transactions at 100 items, 4 MB, or 16 MB of request body. An aggregate's `rekey` packs its moves by the same rule. A batch within every limit is sent in the same requests as before.

  A request the library doesn't split (`Transaction.transactWrite`, `EventStore.append`, an aggregate's writes) is still sent as you built it. If DynamoDB refuses it for its size (HTTP 413), the error now names the request's three largest items, once the library has measured the body it sent and confirmed it is over 16 MB. Otherwise DynamoDB's error passes through unchanged.

  Two planning additions:
  - `stream.measureAppend` returns `requestBytes`, the exact request body the append would send. It includes the transaction's client token and, when capacity reporting is on, the `ReturnConsumedCapacity` field. It now also takes the append's `additionalItems` and measures the request with them in it, built by the same code `append` uses, since adding items changes the request: a lone event's `PutItem` becomes a `TransactWriteItems`. `transactionBytes` then counts them too. It still sends no request and keeps its type. An additional item `append` reads the table to build (a put of a versioned or unique-constrained entity, a `create` over a projection tombstone) has no size without that read, so it fails the measurement with a `ValidationError` naming the read; before, every additional item was refused.
  - `StorageEncoding.limits` has `request: 16_777_216`. AWS documents 16 MB for `BatchWriteItem`, and DynamoDB Local rejects any request body over 16 MiB with HTTP 413.

- [#194](https://github.com/jmenga/effect-dynamodb/pull/194) [`79a786c`](https://github.com/jmenga/effect-dynamodb/commit/79a786c8819f11542a134964a25d19fa22637603) Thanks [@jmenga](https://github.com/jmenga)! - Keep a change feed from committing after its lease can have lapsed. A lease renewal the store never answers now ends the feed with `ChangeFeedLeaseLost` at the renewal deadline, without waiting for the call. The deadline and the renewal schedule count from before the write that took or renewed the lease, so a slow store can't push them past the lease's expiry. An attempt to take the lease that fails or is interrupted now releases it, in case its write landed, and a release that gets no answer holds the feed's end for `renewEvery` at most. The in-memory store now treats a lease as held at its exact expiry, as the DynamoDB store does.

- [#229](https://github.com/jmenga/effect-dynamodb/pull/229) [`7e3b929`](https://github.com/jmenga/effect-dynamodb/commit/7e3b929666fa5a8b652bd07090b6f73ecb9b8f37) Thanks [@jmenga](https://github.com/jmenga)! - Keeps three things 1.39.0 did that this release had taken away.

  **A time-series `appendInput` carrying a sharded index's `by` attribute loads, whatever it carries beside it, as on 1.39.0.** This release had refused at `Entity.make` an input none of whose appends could compose the index's key. Such a definition loads again, the appends that compose the key are written as 1.39.0 wrote them, and one that can't compose it fails with `EDD-9100` when it's made, with nothing written, as on 1.39.0.

  **A `Schema.NumberFromString` key composite holding `NaN` works again with `escapeKeys` off.** Such a field stores `NaN` as `"NaN"`, and up to 1.39.0 its row was keyed by 1.36's text, `0000000000000nan`, and written, read, queried, updated and deleted by it. This release refused it with `EDD-9096` on every path, so a row stored that way came back from a query or a scan but couldn't be read, updated or deleted by its key. It now composes that text again on every path that takes a key: `put`, `create`, `get`, `update`, `delete`, index and primary accessors, `.where()`, `.within()`, `Batch`, `Transaction`, an aggregate's partition key and a `many` edge's sort key, and `rekey`, which finds such a row in place. A `Schema.Number`'s `NaN` is still refused, as no row can hold it (1.39.0's `put` died in the marshaller), and with `escapeKeys: true` every `NaN` is refused, as on 1.39.0. Every other value of these fields composes what it did on 1.39.0: `±Infinity`, `-0`, negatives, fractions and `1e21`, and a `Schema.BigIntFromString`'s negatives, `10^38` and values of more than 1,000 digits.

  **An aggregate's `create` stores the stamp over a value supplied for a field its rows declare a timestamp in**, as 1.39.0 did. When a root, a sub-aggregate root, a `one` edge or a `many` element declares the field a timestamp is stored under (`updated`, `created`, `createdAt`, `updatedAt`), 1.39.0's `create` stored the stamp in place of a value the input held, and failed with `Missing key` without one wherever the field is required. This release stored the value instead, so the placeholder every such caller passed became the row's timestamp. `create` now stores the stamp whether or not a value is supplied, in the row and in any key holding it; a missing value is still accepted, and stores what 1.39.0 stored when one was passed. The one exception is 1.39.0's too: a date the root declares with `Schema.optional` was the caller's on 1.39.0, and `create` stores a value supplied for it, in every row that declares the date. A row that doesn't declare it is stamped. `create` returns what it stored, and `update` keeps re-stamping. An entity's `put` is unchanged: a value supplied for a colliding timestamp field wins there, as on 1.39.0.

- [#223](https://github.com/jmenga/effect-dynamodb/pull/223) [`cb12a10`](https://github.com/jmenga/effect-dynamodb/commit/cb12a104507af20d2e6cb117f53f565845cbc6c1) Thanks [@jmenga](https://github.com/jmenga)! - Effect's own value types read back as the instances written, on rows already stored too.

  `Schema.Duration`, `Schema.BigDecimal`, the time zones, `Schema.Cookie` and `Schema.Cookies`, `Schema.UrlParams`, `Schema.SemVer` and `Schema.SemVerRange`, the IP, MAC, socket, host and DNS record types, and a `Schema.DateTimeUtc` or `Schema.DateTimeZoned` inside a `Schema.Option` or a `Schema.Result` are stored as maps. So is a `Schema.DateTimeUtc` or `Schema.DateTimeZoned` directly in a stream's event, snapshot or outbox, which the entry on field types covers. Each type's guard takes that map, so a read handed it back: a plain object that passed for the value and wasn't one. `Equal.equals` with the value written was `false`, `.pipe` was `undefined`, and `BigDecimal.sum` threw below 2^53. Reads on an entity, an aggregate and a stream now return the real instance. What's stored doesn't change, except a cookie's expiry.
  - **Your own code that inspects one of these values on a read now sees the instance, where it saw the map.** That's a `.check()` on it or on what holds it, a transformation from it, and a class or a declaration of your own holding it. A check that passed on the map and fails on the instance now fails the read, and one that failed on the map can now pass. A row is still decoded once, and each check, transformation, constructor and default runs as often as it did.
  - **A transformation of your own onto one of these types reads the instance too**, when its step hands the stored map on as it is. Effect's own codecs (`Schema.DurationFromMillis`, `Schema.BigDecimalFromString`, `Schema.DateTimeUtcFromString`, ...) made the instance already and aren't touched.
  - **A value stored with properties of its own keeps them.** `Object.assign(Duration.millis(5), { source: "invoice" })` is stored with `source`, read back as a `Duration` holding `source`, and written again with it. A value is handed back as an instance only where writing that instance stores what was read: one holding properties of its own inside it, such as a cookie's `maxAge` or a jar's cookie, and a jar keyed other than by its cookies' names, read back as the map stored, as 1.39.0 read them.
  - **A `BigDecimal` that's been compared, hashed or normalised can be written.** Each of those caches a normalized decimal that holds itself, and marshalling it ran out of stack, so every write of one died. It's now stored as a fresh decimal of the same value and scale is.
  - **A real `Cookie`'s expiry is now stored as ISO text wherever it's written, untyped fields included.** Its `expires` is a `Date`, which was stored as an empty map, so the expiry was lost. A field typed as a cookie reads it back as the `Date`. A cookie 1.39.0 stored with an expiry reads back as the map stored, as 1.39.0 read it, since a cookie would be written back without the expiry its row holds.
  - **A condition on a cookie that has an expiry no longer matches a row 1.39.0 wrote for it, since that row's expiry was lost.** 1.39.0's condition matched such a row whatever the cookie's date had been. A condition on a cookie without an expiry, or on the value read from the row, matches as it did.

- [#231](https://github.com/jmenga/effect-dynamodb/pull/231) [`3626bf0`](https://github.com/jmenga/effect-dynamodb/commit/3626bf04ebbf7d0f34694588fbf634ab10f169a2) Thanks [@jmenga](https://github.com/jmenga)! - An aggregate, a stream or a projection reading a stored row that lacks a field fails on the missing key again, as 1.39.0 did, where the field's transformation throws on `undefined`.

  A read now takes an absent attribute as the value it stands for, through the field's own steps, so a step that throws on `undefined` made the read die where 1.39.0 failed with a `ValidationError` on the missing key. Entity rows were already kept as they were; the same is now done for an aggregate's `get`, `list` and the read inside `update` (a root field or an edge's), a stream's events, metadata and snapshot state on `read`, `readFrom`, `readLatest`, `readSnapshot` and `decodeStreamImage`, and a projection's outbox effects on `drain`. Each fails with 1.39.0's error, its operation and message included. The issue is only looked for once the read has died, so a read that succeeds does no more than before, and a step that throws on a value the row holds is still a defect.

- [#226](https://github.com/jmenga/effect-dynamodb/pull/226) [`65552ec`](https://github.com/jmenga/effect-dynamodb/commit/65552ec277143b9cbb53f212c2ad5fba6d0d8e79) Thanks [@jmenga](https://github.com/jmenga)! - A `field:` rename now applies to a path's first segment only, for an update's path operations and a condition as it already did for a filter and a projection. With `count` stored as `renamed`, a path below another field that had a segment spelled `count` was renamed too: `pathSet`, `pathAdd`, `pathAppend` and the other path operations on `["meta", "count"]` wrote a stray `meta.renamed` and left `meta.count`, where `put` stores it, as it was, and a condition on `t.meta.count` tested `meta.renamed`, which no row holds, so the write failed with `ConditionalCheckFailed` whatever the row held. The same went for a path below a `DynamoModel.ref` field. Each now names `meta.count`.

  Rows such a path write touched on an earlier release hold the stray property (`meta.renamed`) beside the one it should have changed, and whatever those writes put in it was never applied to `meta.count`. A read of a struct ignores the stray property; a read of a `Schema.Record` returns it as one more entry. A path with no segment below the first spelled as a renamed field sends the same requests as before.

  A path does not follow a nested struct's own key encoding (`Schema.encodeKeys`), and never did: below the first segment it names the property as written. One case changes because of that. Where a nested struct encoded a property to the very name a top-level field of the same spelling is renamed to (`meta` encoding `count` as `c`, and a top-level `count` stored as `c`), a path on `["meta", "count"]` reached `meta.c` only because the top-level rename was applied to it; it now names `meta.count`, as a path below any other key-encoded struct always has. Set the whole value (`.set({ meta })`) for such a struct.

  `compilePath`, exported from the path builder, returns the new names for a path with segments below the first.

- [#219](https://github.com/jmenga/effect-dynamodb/pull/219) [`7c8c955`](https://github.com/jmenga/effect-dynamodb/commit/7c8c9557bcb9b73901ab0b01685d64787e868cf1) Thanks [@jmenga](https://github.com/jmenga)! - `create` over a projection tombstone carries the checkpoints of the projection that wrote it, with its revision one higher. Before, it carried the fields of the projection with `removal` defined last, so over another projection's tombstone it carried nothing, and a late redelivery of the removal applied again and removed the created row. When a projection's tombstones set the table's TTL attribute, `create` never carries it onto the row. Every projection now records the attributes it keeps on a row, each with its role. On a read model one of whose projections has `removal`, a stored attribute that one projection uses in two roles (checkpoint, checkpoint map, checkpoint owner, revision) is refused by the definition that completes the conflict, whatever order they are defined in (`EDD-9133`). Read models without `removal` are not refused, nor are two projections keeping one attribute in different roles. An attribute a projection keeps that is stored as the table's TTL attribute, while a projection's tombstones set it, refuses the projections' writes with a `ValidationError` before anything is sent. A tombstone write is refused for a checkpoint map key a sparse map can't store, as the row write already was. Everything else on a removal path sends and stores exactly what it did before: a tombstone, a projection's row written over one, `create` over the tombstone of the projection with `removal` defined last, and `drain` and `drainPending`.

- [#218](https://github.com/jmenga/effect-dynamodb/pull/218) [`7831db0`](https://github.com/jmenga/effect-dynamodb/commit/7831db02136679081c64fe496359e05de268f846) Thanks [@jmenga](https://github.com/jmenga)! - `rekey` says why it couldn't move an aggregate. A `failed` conflict's `message` gave only the tag of a decomposition error (`AggregateDecompositionError: `) or a validation error, since neither error has a message of its own. It now gives the decomposition error's reason, such as two edge rows composing one sort key, and the validation error's cause, as an entity's `failed` conflict does.

- [#213](https://github.com/jmenga/effect-dynamodb/pull/213) [`c8bbe4f`](https://github.com/jmenga/effect-dynamodb/commit/c8bbe4f1165438d73250992d2810b95454aaacf8) Thanks [@jmenga](https://github.com/jmenga)! - `rekey` keeps a write that adds a declared attribute to an aggregate row between its read and its move, and leaves a row it can't prove unchanged where it is, unless writes are stopped.

  An aggregate row's move was guarded on the attributes the row was read with, so a write adding one it didn't have yet, such as an optional field set for the first time, didn't cancel it, and the move put the row back without it. The guard is now the one 1.39.0 sent, byte for byte, followed by each attribute the row's entity type declares that the row didn't hold, still absent: such a write cancels the move, and `rekey` reads the row again and moves it with the write. With nothing absent, the request is 1.39.0's. A row too wide for that (DynamoDB's limits on one expression) is guarded as 1.39.0 guarded it, on its `updatedAt` first when the aggregate stamps one (still absent, for a row written before it did), with the absent attributes that fit after it.

  A row too wide to guard whole, with no version and no `updatedAt` the library stamps on it, is one nothing proves unchanged: 1.39.0 moved it under a partial guard, losing a write to an attribute left out of it. That includes an aggregate row whose node declares its own `updatedAt` other than a date, which holds the caller's value: 1.39.0 stored its stamp over that value and couldn't read the aggregate back (or, the field optional, read it without the value), and the release moved it under a guard on that value, losing a write that left it as it was. `rekey` now leaves such a row where it is and reports it as a conflict with the new reason `"unguarded"` (`RekeyConflict.reason` gains the member), in a dry run too. An aggregate or event stream holding one is left as it is while nothing of it has moved; one already part-moved, in this run or a run cut short, is finished under the strongest guard that fits, as 1.39.0 finished it. A projection's row tombstone or outbox item is judged alone. The new option `writesStopped: true` says nothing else writes to the table, and moves such rows under the strongest guard that fits, as 1.39.0 did.

  What a move still doesn't see, as in 1.39.0: a write that only adds an attribute the library can't list from the member's declarations (one written outside the library, a sparse map's entry, a field of an aggregate node declared as an annotated class or a union); and, on a row guarded by its version or `updatedAt`, a write that leaves them as they were, such as `reembed`, one landing within the stamp's resolution, or one from outside the library. A soft, retain or unique delete of a wide row with no version or `updatedAt` still sends the strongest guard that fits, as 1.39.0 did.

- [#220](https://github.com/jmenga/effect-dynamodb/pull/220) [`985f97e`](https://github.com/jmenga/effect-dynamodb/commit/985f97e3b03ed7992a9bf3b23a36cb4365c44909) Thanks [@jmenga](https://github.com/jmenga)! - `rekey` now moves a projection's outbox on a table of its own when the client knows the read model only as a member of another table it binds (`DynamoClient.make({ tables })`). Before, the read model had to be in `entities` or on the table being rekeyed, and the outbox items were reported `unregistered`.

  `rekey` also finds an outbox through another handle on the outbox's table (another `Table.make` the layer gives the same name): tables are the physical tables requests go to. A read model whose projections each have an outbox on a table of their own has every one of them moved; before, only the outbox of the projection defined last was found.

  When read models of one entity type in different schemas or primary collections had their outboxes on one table, `rekey` gave every item to the read model listed first, which counted the others `unrecognizedKey` and left them unmoved. Each item now moves by the read model its key names, whatever the order.

  Two read models whose outboxes are on one table and whose keys can be the same, for values that hold no `#` and that each composite's type can compose, are refused by `DynamoClient.make` and `EventStore.processBatch` (`EDD-9134`): their items would overwrite each other. That is the same schema name and version, primary collection, entity type and key composites; a number's key text holds no letters but `e` and those of `Infinity`, and a literal union's value is one of its members, so a read model keyed by the number `n` binds beside one keyed by the string `n_x`, as on 1.39.0. Two whose keys meet only through a value holding `#` (one led by `shop`, the other by `shop` then `branch`) bind and run as before.

  The outbox table's `rekey` refuses, with a `ValidationError` before it sends anything, two read models whose items it could read as each other's: their leading composites are the same, or the same literal (its reader reads a literal as any text, as it reads a string), or a number followed by the same name. Read models whose keys part after a number, a bigint or a boolean are moved, each item by its own read model. It also refuses a member of the outbox table with a read model's entity type that could read that read model's items as its own and whose primary key isn't the read model's: an entity claims its entity type's outbox items on its table, and moved them by its own key, to a key that wasn't theirs. A member whose primary key is the read model's moves them where the read model would, and isn't refused. The check covers projections defined after the client was made. Tables are compared by the physical name requests go to, so two handles on one table are one table. Read models that never meet at either can't be checked, so their key spaces must be kept apart.

  A row several members claim, such as an aggregate's row whose entity type an entity also has, was counted `unrecognizedKey` by a member that couldn't read its key back even when another member moved it or found it unchanged. Each row is now counted once, by the member it belongs to, so a report's totals add up to `scanned`.

- [#217](https://github.com/jmenga/effect-dynamodb/pull/217) [`3a311fc`](https://github.com/jmenga/effect-dynamodb/commit/3a311fcff0edebf0822a8ce00ea28e4c2ddac469) Thanks [@jmenga](https://github.com/jmenga)! - `rekey` can move an aggregate whose rows together pass 4 MB. It packed each wave of an aggregate's moves into transactions of up to 100 items, counting items only. A move is the row's Put plus a Delete guarded on the row as read, so it sends the row about twice. Fifty moves of rows over about 42 KB each, or six of rows near DynamoDB's 400 KB item limit, passed 4 MB in one transaction. DynamoDB rejected it, and the run failed with a `DynamoValidationError` on every attempt. Each transaction now takes the wave's moves in order while it stays within 100 items and 4 MB, by the same size measure `Batch.write` uses. A move's Put and Delete still go in one transaction, and the root still moves last. A wave that fits in 4 MB is sent in the same requests as before.

- [#234](https://github.com/jmenga/effect-dynamodb/pull/234) [`4025d74`](https://github.com/jmenga/effect-dynamodb/commit/4025d742835d08fa7e61bbda28e7082c8bc2ccd7) Thanks [@jmenga](https://github.com/jmenga)! - Keeps more of what 1.39.0 did that this release had taken away.

  **`pathRemove` below a field is refused only where no stored value survives it, and sent as 1.39.0 sent it otherwise.** A refusal needs the whole way from the field to the removed property or position to pass through schema nodes the guard models exactly as a read decodes them: a struct with fixed properties only, a record with one index signature keyed by plain `Schema.String`, an array, a tuple whose rest (if any) is one element with nothing after it, a union of these, a scalar, a `Schema.Class` as its struct and a `Schema.suspend` as what it suspends, each with no transformation and no check. Anything else (`Schema.Unknown`, a record with several index signatures, a tuple with elements after its rest, a struct with an index signature, `Schema.Struct({})`, a transformed or checked node) makes the verdict unknown, and the removal is sent. Every way through a union is judged against every member, so a member that reads what's left of another member's value, or holds no such value and is left as it was, gets the removal sent: `f.x` of `Union([{ x, y }, { y }])` or of a tagged union whose other member has no `x`, `f.a.x` of `Union([{ a: { x, y }, b }, { b }])`. A list closes up when an element is removed, so a list position is judged by length alone, and refused only when every list there holds the position and none one shorter is a length a list accepts: any position of a `[string, string]`, of a `NullOr([string, string])` or of a `Union([[string, string], [number, number]])`. `f[0]` of a `[string, string?]`, either position of a `Union([[string, string], [string]])`, `f[2]` of a `Union([[string, string, string], []])` holding `[]` (DynamoDB leaves a list too short to hold it as it was) and an array's element are sent, as on 1.39.0. Length alone can't see that what's left puts a value where its position can't hold it (`f[0]` of a `[string, number?]`) or is a list only a member its tag rules out accepts, so such a removal is sent and leaves a row that can't be read, as on 1.39.0. So a removal below a record with two index signatures is sent in either order of its signatures, as on 1.39.0, even where it leaves a row that can't be read; one below a tuple with elements after its rest, or in a union with a `Schema.Unknown` member, is sent and the row reads, as on 1.39.0; and `.remove(["f"])` and `.set({ f: undefined })` of a required field are refused as before. All of these do what 1.39.0 did standalone, in a transaction, on a retained entity and on one with a unique constraint.

- [#211](https://github.com/jmenga/effect-dynamodb/pull/211) [`b6add38`](https://github.com/jmenga/effect-dynamodb/commit/b6add381e0513a7f48d110c5da0fa08a192e10f6) Thanks [@jmenga](https://github.com/jmenga)! - A row read back from DynamoDB composes the keys `put` wrote, on every path that composes keys from a stored row.
  - **`restore`, an update or `patch` of a `versioned: { retain: true }` entity, in a `transactWrite` too, and the updates that read the item first (a unique constraint, a vector index) no longer die with `EDD-9050`** on a `Schema.OptionFromNullOr(Schema.BigInt)` or a `Schema.BigInt` under a decoding default holding a value below 2^53. DynamoDB hands such a value back as a number, and neither form of the schema took one. The composite key form now takes it as the `bigint` it was stored from, so primary, index, history and sentinel keys are the ones `put` wrote, byte for byte. `aggregate.list` lists such an aggregate, and `rekey` moves such a row and repairs its index keys.
  - **A delete releases the unique-constraint sentinel `put` reserved** on a `bigint` field below 2^53, `Schema.BigInt` included. It deleted a key composed from the number DynamoDB handed back, which `put` never wrote, and left the reservation in place, so the value couldn't be taken again. A reservation an earlier release left this way stays until you delete it with the raw `DynamoClient`.
  - **A `Schema.suspend(() => Schema.BigInt)` key composite keeps the keys `put` wrote.** Read back below 2^53 it was taken as a number, so `restore` put the item back under the number's key text, where `get` didn't find it, and an update reading the item first, a delete releasing its unique-constraint sentinel, `rekey` and an aggregate's `update` and `list` composed the same wrong key. A suspended schema is now read as the schema it suspends.
  - **A key composite storing both a `number` and a `bigint` is refused at load (`EDD-9128`).** That's `Schema.Union([Schema.Number, Schema.BigInt])`, or a numeric literal or enum beside `Schema.BigInt`, in an entity's primary key, a secondary index, a unique constraint, a vector partition or a time-series `orderBy`, or in an aggregate's partition, collection or list key or a `many` edge's sort key. DynamoDB stores `5` and `5n` alike and hands either back as the number `5`, whose key text isn't `5n`'s, and nothing on the row says which was written. So `restore`, the updates that read the item first, a delete releasing a unique-constraint sentinel, `rekey` and an aggregate's `update` and `list` composed the number's key for a `bigint`: a `restore` moved the item where nothing found it, an update moved its index key or vector partition, a delete left its sentinel behind, and an aggregate `update` wrote a second edge row. **A model declaring one no longer loads.** Declare the one kind the field holds, then run `rekey`. A row written with the other kind is stored under that kind's key text, which `get` doesn't find under the new declaration. `rekey` moves it to the text of the value as it reads back, along with its index keys, unique-constraint sentinels, tombstone, time-series events and an aggregate's rows. A unique-constraint sentinel moves whichever mix of the two kinds its values were stored under. Two items whose values read back as one, such as `3` and `3n`, are reported as the conflict `bothKeys` and left. Two rows of an aggregate's `many` edge that read back as one element are the conflict `failed`, with the decomposition error a write gets, and left: delete the one you don't want with the raw `DynamoClient`. A row already under its key costs `rekey` nothing more, and one under the other kind's text is found with one composition per numeric key composite. A field no key reads may still store both. A dotted composite (`nested.n`) is checked through `Schema.optional`, `Schema.optionalKey`, `Schema.NullOr`, `Schema.suspend` and a class, and a time-series entity's `appendInput` is checked as its model is, including a field it declares as the other kind than the model's. A key whose kinds can't be read at load, a `Schema.Unknown`, a `Schema.Any`, an opaque `Schema.declare` or a transformation whose stored side is one of those, still loads, and keeps working for strings and numbers. It's judged at write: the value DynamoDB hands back is decoded through the field, and a value that reads back as something else fails with a `ValidationError` (`EDD-9128`) naming what it reads back as, and writes nothing. A `Schema.Unknown` given a `bigint` below 2^53 is refused; a `number` past 2^53 has no stored form, and is refused as in any attribute (`EDD-9124`); a `Schema.Unknown` decoded to a `Schema.BigInt` reads `5n` back as `5n`, and stores it as before. An aggregate's dotted composite (`nested.n`) is judged through the field holding it, decoded as a read decodes it, so a struct storing `{ n: 5n }` and decoding it to `{ n: 5 }` is stored, as before. A row an earlier release stored with a `bigint` below 2^53 there reads back as a number, and `rekey` moves it to the number's key text. A union of one numeric kind and something else (`Schema.Union([Schema.String, Schema.BigInt])`) reads a stored number back as that kind.
  - **A key composite holding a `Schema.Option`, a `Schema.Result` or an array of them keeps the keys `put` wrote.** DynamoDB hands such a value back as a plain map, whose key text is `[object object]`, not the `some(5)` `put` wrote. So `restore` put the item back under `[object object]`, where `get` didn't find it, and a delete left the unique-constraint sentinel behind. A value read back is now decoded through its field before its key text is composed, so those keys are the ones `put` wrote. A key composite whose field takes the map as it is, such as `Schema.Duration`, would compose `[object object]` from any row read back, and is now refused at write (`EDD-9128`). On 1.39.0 `put`, `get`, `update` and `delete` of an item keyed by one worked, by the key `put` composed from the value given (`5 millis`), and `get` returned the map, not a `Duration`; `restore`, and a delete releasing a unique-constraint sentinel, composed `[object object]`. Use `Schema.DurationFromMillis`. A key composite holding a list of `Schema.BigInt` beneath a decoding default or another step now restores: DynamoDB hands `[5n]` back as `[5]`, and `restore` failed with `EDD-9050` composing the key from it. So does a `Schema.Option(Schema.BigInt)`, or an `Option` of a struct holding one, which DynamoDB hands back as a map holding a number: `restore` put the item back under `[object object]`, and a delete left its unique-constraint sentinel behind.
  - **`rekey` leaves a `Schema.BigInt` time-series event where `append` put it.** Under `escapeKeys: false` it composed the event's sort key from the number DynamoDB hands back for a `bigint` below 2^53, and moved the event to the number's key text, where `.history().where()` on the `bigint` didn't find it. It now composes the key from the `bigint`, and moves an event an earlier run moved back to it.
  - **`rekey` leaves a row holding a number its declared kind can't hold exactly.** Once you declare one kind, a `bigint` past 2^53 under `Schema.Number`, or a fraction under `Schema.BigInt`, reads as no value of that kind. It's the conflict `uncomposable` (`EDD-9050`, in `message`), and it and its unique-constraint sentinels stay where they are, never moved to the key of a rounded value. A dry run says the same. 1.39.0 left it too, counting the `bigint` in `skipped.unrecognizedKey` and the fraction as unchanged.
  - **`aggregate.list` and `rekey` find an aggregate whose partition key composite is stored in another form than the one it's keyed by**, such as `Schema.Option(Schema.Number)`, `Schema.Option` of a transformation, or a number stored divided by ten. `create` and `get` compose the key from the domain value and the root stores the encoded one, while `list` and `rekey` composed the key again from what's stored: `list` skipped the aggregate, `rekey` counted it in `skipped.unrecognizedKey`, and after an `escapeKeys` change it stayed where `get` didn't find it. They now decode the root's key composites as a read does first. A root 1.39.0 created under `Schema.Option` of a transformation holds the value its `create` returned, unencoded, so it reads back as another value than the one its key was composed from: `list` and `rekey` still skip it, and `get` with the value `create` returned finds it.
  - **`.history().where()` bounds compose as `append` composes the event key.** A bound was composed from the value you gave. With `escapeKeys` off it named a number's padded key text where a `Schema.NumberFromString` or `Schema.BigIntFromString` event key holds the string `append` stored, so `eq` found nothing; with `escapeKeys: true`, a number stored in another form (a transformation dividing by ten) got every operator wrong. With `escapeKeys` off such events are in text order, so a range in numeric order can be reversed in text: `between(t.n, 9, 10)` now fails with a `ValidationError` naming both bounds, where it returned nothing.
  - **A query operand or accessor key holding a number its composite's kind can't hold exactly fails with a `ValidationError` (`EDD-9050`), and nothing is sent.** That's a `bigint` past 2^53 for a `Schema.Number` or `Schema.NumberFromString` composite, or a fraction for a `Schema.BigInt` or `Schema.BigIntFromString` one, in `.where()`, `.history().where()`, an index accessor, or a collection's query or member selector, bound or made with `Collection.make`. 1.39.0 queried the rounded number for the first, composed a fraction's text for a `Schema.BigInt` and died for a `Schema.BigIntFromString`. An aggregate's `delete` reports one as it reports any key it can't compose, with an `AggregateAssemblyError`, and sends nothing.
  - **A `transactWrite`, or an EventStore append's `additionalItems`, refuses an op before any op reads.** Every op is checked and composed first, so a put its schema refuses, a delete or check whose key holds a number its kind can't hold exactly, an update or `patch` whose payload its schema refuses or that reads back otherwise (`EDD-9128`), or a nested `appendOp` with no events or an event its schema refuses, fails with a `ValidationError` and nothing is read. Placed after a unique-constrained or `versioned: { retain: true }` put, or anywhere beside an update, it was refused only after their reads.
  - **`rekey` names a row whose values compose no key.** A row whose own key holds `NaN` under `escapeKeys: true`, or one of whose key composites holds a value no form of its schema takes, is the conflict `uncomposable`, with the refusal in `message`. It was counted in `skipped.unrecognizedKey`. With `escapeKeys` off a `Schema.NumberFromString` row keyed by `NaN` is where the entity composes its key, and is left as it is.

  What's stored doesn't change.

- [#222](https://github.com/jmenga/effect-dynamodb/pull/222) [`e15a2ac`](https://github.com/jmenga/effect-dynamodb/commit/e15a2acdbc1d0a28739cd369f4c5cc71fe7acbee) Thanks [@jmenga](https://github.com/jmenga)! - An update or `patch` whose `.append()`, `pathSet`, `pathAppend`, `pathPrepend` or `pathIfNotExists` operand its schema refuses now fails with the same `ValidationError` before it reads or sends anything, on its own and in `Transaction.transactWrite`. The refusal used to be made as the write was built, after the reads of an update that reads first (a `versioned: { retain: true }` entity's, and an update `Transaction.transactWrite` plans after another), so those reads were sent for nothing. An update that was also refused for another reason now reports the operand, with nothing sent: an item that isn't there (`ItemNotFound`), a stale `expectedVersion` (`OptimisticLockError`), an immutable field restated with another value on a retained entity (`ValidationError` `update`), a ref whose target isn't there (`RefNotFound`), or a packed value with no compressor registered (`ValidationError` `update.packed`).

  Nothing else about an operand changes: one that was written is written as the same bytes, one that wasn't checked isn't checked, and one that was refused is refused with the same error.

- [#228](https://github.com/jmenga/effect-dynamodb/pull/228) [`4e20821`](https://github.com/jmenga/effect-dynamodb/commit/4e208219499f30f36e5d33a7a12d3a5cd51e73e5) Thanks [@jmenga](https://github.com/jmenga)! - An `upsert` that reads the row first (an entity with `unique` or `versioned: { retain: true }`, or an input omitting a defaulted index composite) checks a sparse map's entry keys as 1.39.0 did, with or without a ref to read. It writes a row that isn't there as a `put`, which refuses an empty key, one holding `#` and an attribute name over 255 bytes, and a row that's there as an update of the fields it names, which refuses the same on a `retain` entity or when it changes a unique field, and otherwise an empty key and one holding `#`. So an entry whose attribute name is over 255 bytes is written into a row that's there, as on 1.39.0. A key both writes refuse is refused before the read, in the `put`'s words: over a row that's there, 1.39.0 read the row first and refused an empty key or one holding `#` with `invalid key`.

## 1.39.0

### Minor Changes

- [#184](https://github.com/jmenga/effect-dynamodb/pull/184) [`f8f7131`](https://github.com/jmenga/effect-dynamodb/commit/f8f71315f1e70ad2e797ef4239744a6a100c21ab) Thanks [@jmenga](https://github.com/jmenga)! - GSI write sharding ([#183](https://github.com/jmenga/effect-dynamodb/issues/183)), one flag for key text, and the fix for inverted indexes. **1.39.0 fixes the inverted index problem 1.37.0 and 1.38.0 have, and reverses 1.37.0's key change by default.**

  **Key text is one setting: `DynamoSchema.make({ escapeKeys })`, off by default for all of 1.x.** On by default is planned for the next major release.
  - **Off, the default,** composes the key text 1.36 composed, for strings and numbers: a string as it is, a number or bigint zero-padded `String(n)`, a time-series event key the `orderBy` attribute's stored value.
  - **`escapeKeys: true`** composes every key, partition and sort, with every character up to `%` as `%` and two hex digits, and numbers in the numeric key text 1.37.0 introduced. Key order is then value order, and a value may hold `#`.
  - A value with none of those characters, and a non-negative integer below 1e16 (1e38 for a `bigint`), compose the same text either way.

  **What to do about your rows:**
  - **From 1.36 or earlier:** nothing. Key text is what 1.36 composed, so every row is where the library looks for it. Upgrade and deploy. The query conditions 1.37.0 changed stay: a full pin sends `sk = key`, and `beginsWith` on a numeric composite sends `eq`.
  - **From 1.37.0 or 1.38.0: run `rekey` before serving traffic.** Those releases escaped sort keys, changed the text of some numbers and put an `orderBy`'s key text in event keys, and the default no longer looks there. That concerns a row with a character up to `%` in a sort key; a row with a number whose text 1.37.0 changed in a key (negative, fractional, 1e16 and up, a `bigint` that's negative or 1e38 and up, `Infinity`, or an epoch date before 1970); and a time-series event of a `NumberFromString` or `BigIntFromString` `orderBy`. Either keep the default, and `db.tables.<Table>.rekey()` moves those rows back to the 1.36 text, or set `escapeKeys: true`, and it moves them, and every row with a character to escape in a partition key, to escaped text. Rows 1.38.0 wrote count the same as rows 1.37.0 wrote: the two store identical keys. An instance of either release still running writes their text, so run `rekey` again once the last one has gone.
  - **To turn `escapeKeys` on over existing data:** set the flag, and run `rekey` before serving traffic.
  - **A new table** needs nothing.

  **No fallback.** Every operation composes the one text its setting chooses, and sends the same requests whatever the value is. The second read in `get`, the second query, the move on first write and the rest of the fallback 1.37.0 shipped are gone, with their row checks and the cursor of a query that read both keys. The `legacyKeys` option and `ItemNotMoved` (`EDD-9097`, retired) are gone too: remove `legacyKeys` from `DynamoSchema.make`. `rekey` is the only thing that moves a row between key texts. Until it finishes on a table with rows under other text, nothing is promised: those rows aren't found by any read, a write of the same key lands beside them (`rekey` reports `bothKeys`), a value can land on another value's old row, and a unique value isn't seen as taken while its sentinel is under other text. A cursor from a 1.37.0 or 1.38.0 query that read both keys fails with `EDD-9094`: restart the listing.

  **`rekey` moves rows to whatever the setting composes, in either direction.** It covers items, index keys including a Z-order index's partition key and prefix, unique-constraint sentinels, snapshots, tombstones, time-series events, aggregates, event streams and projection rows, from the text of 1.36, of 1.37.0 and 1.38.0, and of `escapeKeys: true`. A row is moved or counted, never silently left: what it can't place is in `conflicts` or `skipped.unrecognizedKey`. When keys spell each other's (`foo bar` under escaping belongs where `foo%20bar` was stored) the holder moves first, and nothing is overwritten or merged. A dry run agrees with the real run, a chain blocked by a row that can't move included, and a second run changes nothing. `guides/upgrading` lists what it moves and what it can't. A partition key mixing an escape and a changed number, an escape in each half of a row, an aggregate's mixed partition and a sentinel mixing an escape and a changed number are all recognised now.

  **Limitations of the default,** none of them new against 1.36, and documented in `guides/indexes`:
  - Numbers don't sort numerically in a key, and `.history()` on a string-encoded numeric `orderBy` is in text order.
  - A range on a sort key composite that isn't the last can return wrong rows when a value holds a character below `#`, and `gt` under a pin on the last composite can miss a longer value continuing below `#`.
  - A `#` in a value can imitate a segment: `a#b` + `c` and `a` + `b#c` compose one key.
  - Skip-scan over free-form strings can hide rows, and a `#` stops its probing.
  - A partial pin and an equal `.where()` or `.within()` on a composite that isn't the last send `begins_with`, so a row truncated at that level isn't returned. With `escapeKeys: true` they find it.
  - `NaN` composes 1.36's text rather than failing with `EDD-9096`, which stays under `escapeKeys: true`.

  **GSI write sharding.** `shards: n` or `{ count, by?, previous? }` on a secondary index stores one logical partition in N physical ones, for an index key that takes more than a partition's 1,000 WCU/s. Writes hash the item to pick a shard, and every terminal reads the shards and merges them into index order, so no caller names a shard.
  - **Key text:** `!<count>.<shard>` right after the entity type or collection name, before all values, so no value can spell it and two layouts can't overlap.
  - **`by`:** hash sort key composites instead of the primary key, so a query pinning them reads one shard. An update that changes a `by` attribute moves the entry, and fails with `EDD-9100` when the new key can't be composed, including when the sort key can't follow it under `preserve`. An unsharded key is never written.
  - **Reads:** `.concurrency(n)` and `Query.concurrency`, `QueryExplain.fanOut`, cursors with one position per shard, `.maxPages(n)` counted in rounds. `.within()`, skip-scan, `.zorder()` and `GeoIndex` are refused on a sharded index (`EDD-9104`).
  - **Adoption:** deploy with `previous`, run `db.tables.<Table>.rekey()`, and remove `previous` once a run reports no conflicts. `RekeyConflict.reason` gains `"uncomposable"`.
  - **Pruning:** a query reads one shard when the accessor pins every attribute of the shard source, `by` or the primary key alike. The unbound `Query.where()` replaces what was pinned, so it reads every shard again.
  - **New codes:** `EDD-9099` to `EDD-9106`. An index without `shards` keeps its cursor format and range planning.

  **Fix: inverted indexes, as 1.37.0 and 1.38.0 left them.** With an index half in a table key attribute, those releases composed the attribute's text differently in its two roles, so a value a sort key escapes overwrote a table key: `userId: "u 1"` stored `pk` as `userid_u%201`, so `get` failed and `delete` reported success and left the row, and `groupId: "a b"` made `put` fail. One rule now composes every key, so both roles build one text under either setting. `rekey` recognises the row those releases left and moves it, an escape in each half included. An inverted index is supported, not encouraged: index keys belong in dedicated attributes.

  **Behaviour change: definitions refused at load.**
  - **`EDD-9106`:** two key halves of one entity sharing an attribute without the same fields, in the same order and casing, or a sharded partition key sharing one with a half not sharded the same way. Such a definition worked for `put` and query while no item held both accessors' composites, but a row can't show which half owns the attribute: the one written last overwrites the other, and an ordinary update corrupts even a row that only used one. The check runs per entity, so several entities can still overload one index. Two number-only or numeric Z-order halves with different casings are refused too.
  - **`EDD-9108`:** one entity using one physical index twice, even over the same fields.
  - **`EDD-9109`:** a model attribute, a system timestamp or a version field stored in an attribute of the table's primary key, by a `field` rename or by its own name. A `put` would overwrite the key it composed.
  - **`EDD-9112`:** an aggregate's list key or collection sort key stored in an attribute of the table's primary key.

  To keep an access pattern one of them refuses, give each key its own attribute, which means a new index, and re-put existing rows.

  **Behaviour change: an update refuses to name a table key attribute.** `.remove()`, `.set()` and the other update operations naming an attribute of the table's primary key by its stored name fail with a `ValidationError` and write nothing. No write path sets any part of the primary key: a key changes only by moving the row.

  **Public API.**
  - `KeyComposer.composeEventSk` takes the schema first. The old three-argument form still works, is deprecated, and doesn't follow `escapeKeys`.
  - `KeyComposer.composeSortKeyCondition` can return `{ between }` too: a partial prefix on a secondary index under `escapeKeys: true`. A caller handling only `eq` and `beginsWith` needs a branch for it.
  - `KeyComposer.serializeValue` and `extractComposites` keep the numeric text 1.37.0 gave them under either setting, which differs from 1.36 for a number whose text changed. `compositeText`, `keyValueText` and `extractKeyComposites` follow the setting.
  - `KeyComposer.sortKeyText` and `serializeSortKeyValue` mean what they did, and are deprecated: use `keyText` and `keyValueText`, which follow the setting, or `escapeKeyText`.

  **Fix, every secondary index: a pin finds the row truncated at that level, with `escapeKeys: true`.** A partial sort key pin, `.where(eq)` on a composite that isn't the last, and an `eq` in `.within()` missed a row whose key an update had truncated there, and returned everything under it. Under `escapeKeys: true` they send `BETWEEN <prefix> AND <prefix>#U+FFFF`, which selects that row and its subtree and no longer sibling. The primary key is unchanged (`begins_with`), and the default keeps `begins_with` as 1.36 did.

  **Fix, every secondary index: an unrelated update leaves a half mixing a primary key composite with a mutable one.** Since 1.7.2 one composite in the key woke the half, so `.set({ status })` on `primaryKey: [channel, deviceId]` removed `sk: [zone, deviceId]` under `sparse`, taking the item out of the index, and truncated `sk: [deviceId, zone]` or `pk: [channel, zone]` under `preserve`. `.append` did the same. A half now wakes through the key only when the key holds every composite. An item lacking the mutable composite no longer joins that index on an unrelated write; it joins when a write names the composite. Rows already damaged stay as they are until a write names the half's composites or the item is put again.

  **Fix, every secondary index: `rekey` and truncated keys.** `rekey` now rewrites a sort key truncated under 1.36, which it used to leave, when the key is exactly what 1.36 composed for the composites before the gap. An index key that isn't any text its row's values composed is left, with no count: a row may have cleared one of its composites, or the key may lag them. A pin misses such a row if its text changed, a broader query or `get` still finds it, and writing the composites puts it back.

  **Fix, every secondary index: a retained update keeps an entry `preserve` kept.** An update on a `versioned: { retain: true }` entity deleted an index entry when it could compose neither half, including one `preserve` had just kept for a cleared composite. It now leaves the entry, as an ordinary update does.

  **Fix, every secondary index: an update on an entity with an index half in a table key attribute.** A local index's partition key, an inverted index or a sort key shared with the table made every update fail, as DynamoDB refuses one that names a table key attribute. Updates no longer write one, and a version snapshot, tombstone or event keeps it.

  **Fix: `.remove()` of a primary key composite.** `update(key).remove(["tenant"])` and `Entity.remove` deleted the attribute and kept the key, so the row stopped decoding for `get`, `scan` and every other reader. The update reported the decode failure after the write, a transaction reported success, and a `versioned: { retain: true }` entity failed with a defect and wrote nothing. They now fail with the `ValidationError` a `.set()` of that attribute gets and write nothing, as do `.remove()` and any path operation naming the composite by its stored attribute. A row already damaged isn't repaired, and `rekey` counts it in `skipped.unrecognizedKey`: put the item again to restore it.

  **Fix: `rekey` reporting a false `"bothKeys"`.** A row moved between its two reads, by another row's move in the same run or by a write, read as under both keys. A rerun cleared it.

## 1.38.0

### Minor Changes

- [`5ec0aba`](https://github.com/jmenga/effect-dynamodb/commit/5ec0abaa1a24ffc319900bdadaa7a86693d9cb69) Thanks [@mixja](https://github.com/mixja)! - Require Effect 4.1, and stop installs mixing versions of the lockstep packages ([#191](https://github.com/jmenga/effect-dynamodb/issues/191)).

  **Effect 4.1.** The `effect` peer dependency moves from `^4.0.0` to `^4.1.0`. Effect 4.1 removed its top-level `Crypto` module, so importing 1.37.0 or earlier on it failed with `The requested module 'effect' does not provide an export named 'Crypto'`. Its replacement, `effect/crypto`, does not exist in 4.0, so one build cannot import from both.

  If you cannot move to Effect 4.1 yet, stay on 1.37.0 with Effect 4.0.2 or earlier, and pin `@effect-dynamodb/schema` to 1.37.0 too. The published 1.37.0 depends on `^1.37.0`, so a fresh install would otherwise take a newer schema package: `npm i --save-exact effect-dynamodb@1.37.0 @effect-dynamodb/schema@1.37.0 effect@4.0.2`. Effect 4.0.3 turned `Crypto.randomUUIDv4` and `randomUUIDv7` into functions, so 1.37.0 imports on 4.0.3 to 4.0.7 but its writes to `generatedId` and `versioned` entities die at runtime.
  - **`DynamoClient.make({ crypto })` now takes a `SecureRandom` service from `effect/crypto`** instead of `Crypto.Crypto`. Replace `Crypto.make({ randomBytes, digest })` with `SecureRandom.make(randomBytes)`. Most programs do not pass this option and need no change: the default is still backed by `globalThis.crypto`, and bound operations stay `R = never`.
  - **`generatedId: { version: "v7" }` ids are now monotonic.** Effect 4.1 orders the UUIDv7s of each `SecureRandom`: within a millisecond a counter orders them, in place of random bits, and the timestamp can run slightly ahead of the `Clock`. The default service is per client, so ids sort in creation order within one client. Their text form is unchanged, and so are version 4 ids.
  - **Minting event ids:** `crypto.randomULID` and `crypto.randomUUIDv7` become `random.ulid` and `random.uuidV7()` on the `SecureRandom` service, and `SecureRandom.layerWebCrypto` provides it. ULIDs from one service are monotonic too, so a test with a frozen `TestClock` and fixed bytes gets one value and then its increments, and must build a fresh service for each run to repeat them.
  - **Coming from Effect 4.0.5 or earlier, you also pick up Effect's date fixes from 4.0.6.** `DynamoModel.DateTimeZoned` now handles dates before year 1 in a named zone: earlier releases formatted them with a garbled offset, so a write as a key composite died with `EDD-9050` and a write as an attribute stored text that no read could decode, and such a row still fails to decode. Date strings also accept a lower-case `z` designator, and a `[GMT]` zone on `DateTimeZoned`.

  Key text is unchanged: every key that could be written under Effect 4.0 composes to the same bytes. This release changes no key behaviour, so the problem from 1.37.0 that can store rows under the wrong key on an inverted index over strings is still present in 1.38.0, and is fixed in the next release.

  **Lockstep pins.** `effect-dynamodb@X` now depends on exactly `@effect-dynamodb/schema@X`, and `@effect-dynamodb/geo@X` requires exactly `effect-dynamodb@X`. The caret ranges used before let a fresh install of an older runtime pick up a newer schema package, which holds key composition, so it wrote the newer key text without the newer runtime's migration code. Upgrade the packages together.

## 1.37.0

### Minor Changes

- [#181](https://github.com/jmenga/effect-dynamodb/pull/181) [`ae1930f`](https://github.com/jmenga/effect-dynamodb/commit/ae1930f482f8ed00c106122ccca2fbdf52caa937) Thanks [@jmenga](https://github.com/jmenga)! - Z-order indexes (`sk.zorder`, `sk.prefix`) with binary sort keys and `.within()` queries
  (`naive` / `jump` / `precise`), skip-scan for bounds on non-leading sort-key composites,
  `.explain()` / `.onRequest()`, and cursor v2. Key text now sorts the way values do, and
  `db.tables.<Table>.rekey()` moves the rows 1.36 wrote to their new keys ("Upgrading from 1.36"
  below).

  A Z-order dimension is a plain entry in `sk.zorder`, typed from the model: a bare field name, or
  `{ field, ...options }` whose options follow the field's type (`{ min, max, step? }` for a
  `number` or `bigint`, `{ from, unit, bits }` for a date, the bare name or `{ values?, bits? }` for
  a literal union or `boolean`, `{ bytes }` or `{ values, bits? }` for a plain `string`; a plain
  `number` takes a range only). The editor completes the field names and options. `ZOrder` exports the entry types
  only. A misspelled option (`stpe`) is a compile error on its entry, as on a `{ field, hash }`
  prefix part, and `Entity.make` checks entries at runtime too (`EDD-9087`).

  Every definition config that names a model attribute is now typed from the model: `Entity.make`
  key and index composites, `sk.prefix`, `refs` keys, `unique`, `timeSeries.orderBy` /
  `appendInput`, `generatedId.field` and vector index fields; `DynamoModel.configure` keys;
  `Aggregate.make` composites, `context`, `edges` keys and `many` edges' `sk.composite`;
  `Collections.member` / `Collections.make`; and `GeoIndex.make`'s `index` and `fields`. The editor
  completes the names. Physical attribute names (key `field`s, `configure` renames, timestamp,
  version and TTL names) stay strings.

  **Behaviour change: adaptive request sizing is now the default** for queries with `.limit()`, a
  filter, `filterBy` predicate or history rows, and no `.pageSize()` or `.maxPages()`. Each
  request's `Limit` is sized from the observed pass rate instead of asking for a 1 MB page. The
  items a query returns are unchanged; read units and request counts change, and a low or uneven
  pass rate can take more round trips than one natural page (a logarithmic number more in the worst
  case). A `fetch` cursor resumes at the same place, but its value can differ, and when the limit
  fills on the last row a sized request returned the cursor can be `Some` where it was `None` (null
  before 1.37), so a `fetch` chain can end with one empty page. `Query.paginate` emits one array per request, so
  its page boundaries change; the items it streams are unchanged (a bound query's `.paginate()`
  streams items and is unaffected). Queries with `.maxPages()` keep the previous sizing.
  `.pageSize("natural")` restores the previous behaviour.

  **Behaviour change: sort key text (and numeric partition keys).** 1.37.0 composes some key text
  differently, so that keys sort the way their values do. Three kinds of value change; a value of
  any other kind keeps its 1.36 key text and requests. A row 1.36 wrote with one keeps its old key
  until it moves: through 1.37.x the 1.36 key fallback keeps it working, and `rekey` moves it
  ("Upgrading from 1.36" below).
  - **Numbers, in every key.** `number` and `bigint` key composites (partition, sort and index keys,
    unique-constraint sentinels, a time-series `orderBy`) are written as text that sorts in numeric
    order. Non-negative integers below 1e16 (1e38 for a bigint) keep their exact 1.36 bytes, so a
    row whose numeric key composites all hold such values is unaffected. Negative, fractional,
    1e16-and-up and infinite numbers, `DateEpochMs` and `DateEpochSeconds` dates before 1970, and
    negative or 1e38-and-up bigints compose different text. `NaN` and bigints of more than 1,000
    digits can't be keys (`EDD-9096`): entity operations, `Batch` and `Transaction` fail with a
    `ValidationError` before sending anything, `get` and `delete` included (up to 1.36 they failed
    with `ItemNotFound` and did nothing), and query accessors, `.where()` and `.within()` throw.
  - **Strings in sort keys.** A sort key composite's text escapes every character up to `%`
    (control characters, space, `!`, `"`, `#`, `$`, `%`) as `%` and two hex digits: `new york` is
    stored as `new%20york` and `a#b` as `a%23b`, in table and index sort keys, time-series event
    keys, version snapshot and tombstone keys, aggregate sort keys and Z-order prefix segments
    (`KeyComposer.sortKeyText`). Partition keys and unique-constraint sentinels are unchanged. Key
    order is now value order: up to 1.36 a space, `!`, `"` or control character sorted below the
    `#` after a composite, so `lte: "new york"` left out `new` and `gt: "new"` left out
    `new york`, and `#` split a value in two. Every `.where()` and `.within()` bound is one key
    condition again and returns exactly the rows whose value satisfies it, values may hold `#`, and
    skip-scan runs over string composites too. The language service's params escape the same way,
    and its hover for an accessor named after a collection now shows the accessor's sort key
    condition.
  - **Time-series event keys of a numeric-string `orderBy`** (`NumberFromString`,
    `BigIntFromString`). Event keys hold the number's key text, so `.history()` returns events in
    numeric order and `.where()` bounds return the events they mean; up to 1.36 they held the
    string, which sorted `10` before `9`.

  **Behaviour change: `.append()` on a numeric-string `orderBy`** compares the `orderBy` as a
  number. Up to 1.36 DynamoDB compared the strings, so appending `10` after `9` failed with
  `StaleAppend`, and `9` after `10` was applied. It now reads the current item first (one strongly
  consistent `GetItem` per append, `.skipFollowUp()` included) and guards the write on the stored
  value, reading and deciding again when a concurrent append moves it, up to 8 attempts in all.

  **Behaviour change: `.append()` cancellations.** A user condition that rejects an append creating
  the item now fails with `ConditionalCheckFailed` (no `current`) for every `orderBy` type, where
  1.36 failed with a `ValidationError` (`append.followUp`). A transaction DynamoDB cancels for a
  `TransactionConflict` alone (another transaction in flight on the item: nothing judged, nothing
  written) is sent again, up to 8 attempts in all, then fails with the transaction's error; up to
  1.36 it was reported as a `StaleAppend` or `ConditionalCheckFailed` and the event was not written.
  The read that tells a cancellation's cause is now strongly consistent, and so is the read after an
  applied append that returns `current` (without `.skipFollowUp()`): an eventually consistent read
  could miss the item the append had just created, failing it with a `ValidationError`
  (`append.followUp`), or return the item as it was before the append. Each such read costs one
  read unit per 4 KB, where it cost half of one.

  **Behaviour change: exact sort key matches.** An accessor or `Entity.query.<index>` given every
  sort key composite sends `sk = key` instead of `begins_with(key)`, so `seq: 3` no longer returns
  `3.14` or `3.5` and `name: "a"` no longer returns `"ab"`. `Aggregate.list` applies the same rule to
  its list sort key, and its partial `begins_with` now ends on the delimiter (`owner: "alice"` no
  longer returns `"alicex"`). `.where(beginsWith)` on a `number` or `bigint` composite compiles to
  `eq`. `.history(key).where()` with `lt` / `lte` / `gt` / `gte` stays inside the item's own events;
  it used to return the item's current row and other items' rows in the partition.

  **Upgrading from 1.36.** Deploy 1.37 to every instance with the 1.36 key fallback on (the
  default), dry run `db.tables.<Table>.rekey()`, run it, and once a
  rerun moves nothing and reports no conflicts, turn the fallback off with
  `DynamoSchema.make({ name, version, legacyKeys: false })`. The fallback and the setting are
  removed in the next major release. The new "Upgrading from 1.36" guide walks through it.
  - **What the fallback keeps working.** `get`, `getVersion`, `deleted.get`, `Batch.get` and
    `Transaction.transactGet` read the 1.36 key when the current key misses (`transactGet` with a
    second `TransactGetItems`: two snapshots, not one). `put`, `create`, `upsert`, `update`, `patch`,
    `append`, `delete`, `deleteIfExists`, soft delete, `restore`, `purge` and `Batch.write` act on the
    item wherever it is, and an item written once moves to its current key, its index keys recomposed
    under their index policy, its unique-constraint sentinels and (with `retain`) the snapshot of its
    version moved; a unique value held under its 1.36 sentinel stays taken. A query that pins a key
    prefix — an accessor's pins and an `eq` / `beginsWith` bound, `Entity.query.*`, collections,
    `.history()`, `versions()`, `deleted.list()`, `count()` — also reads the 1.36 key for the same
    pins: first (last under `.reverse()`), one key after the other rather than merged, with `limit`,
    pages, cursors and `count()` spanning both. Aggregates are read under both keys: `update` moves
    every row it finds under a 1.36 key in the same transaction (an `update` that changes nothing
    included), `create` refuses an aggregate that exists under its 1.36 key, and `list` lists it. An
    event-store stream whose stream id's text changed (a number passed as an id) is read and appended
    under its 1.36 key until `rekey` moves it, never split; a new one starts under its current key.
    Projections (`projection` and `multiProjection`) read a read-model row, or its tombstone, under
    its 1.36 key when the current key misses, so they fold onto it rather than from `initial`, and a
    tombstone keeps recognising redeliveries; their next write moves it (the write through the
    entity moves it first; a tombstone's or an outbox transaction puts it at the current key and
    deletes the 1.36 row while it is as read, in the same write). `drain(key)` and `drainPending`
    deliver a row's outbox effects under both keys in one order. Keys whose text did not change
    send exactly the requests they did.
  - **What it doesn't.** Range bounds in `.where()` (`gt`, `gte`, `lt`, `lte`, `between`) and
    `.within()` read the current key only, so they miss rows that haven't moved. Rows from the 1.36
    key come in 1.36's order (a negative number above a smaller one). `.history()` of a
    `NumberFromString` / `BigIntFromString` `orderBy` keeps 1.36's events and the current ones
    apart under their shared prefix, 1.36's first, and holds its bounds on the numbers, reading
    all of the item's events to do so; events of a `Schema.Number` or string `orderBy` under an
    unchanged item key are read in text order. Inside `Transaction.transactWrite` an item can't
    move: an update, patch, conditioned put or delete, guarded put or `Transaction.check` of an
    item still under its 1.36 key fails the transaction with the new `ItemNotMoved` (`EDD-9097`),
    writing nothing; write the item once through the entity, or run `rekey`, first.
  - **What it costs.** A conditioned `put`, `upsert`, `update`, `patch` and `append` are sent first
    as for an item at its current key and move it only when no item is there, so creating a new
    item this way costs one failed conditional write more; concurrent first writes of an unmoved
    item all succeed. An unconditioned `put` of an item whose key text changed is always one
    two-item transaction (Put at the current key, Delete at the 1.36 key): twice a plain put's write
    capacity for each item, and a cancellation by a concurrent transaction is sent again, up to 3
    attempts in all; a value whose 1.36 key can be another value's current key (below) is put as a
    conditioned put is. `Batch.write` deletes a put's 1.36 key in a later request, once the put is written. An
    append to a stream still under its 1.36 key carries one more check, that `rekey` hasn't moved
    it (a `ConditionCheck` on its first event, folded into the contiguity check when the head is
    the first event): an append that loses that race fails with `VersionConflict` and, retried,
    finds the stream at its current key.
  - **Strings holding `%` and two hex digits.** 1.36 didn't escape sort key text, so such a
    string's 1.36 key is another value's current key (`foo%20bar`'s is `foo bar`'s, `x%23y`'s is
    `x#y`'s). Single-item operations, batches, transactions, accessor queries, `.history()`,
    `versions()` and `purge` tell the two apart by the row's values: a read of `foo bar` doesn't
    return `foo%20bar`'s row, a `put` of `foo bar` moves that row to its own current key first, and
    `update` / `delete` leave it alone. A write of `foo%20bar` leaves `foo bar`'s row at its 1.36 key
    alone (`create` and `restore` read that key first), and a retained `foo%20bar` created afresh
    continues its own version count, not `foo bar`'s. `Transaction.transactWrite` fails
    `ItemNotMoved` naming the item whose row holds the key. 1.36 kept `foo%20bar`'s version history
    under the prefix `foo bar`'s is under now: each lists only its own versions, and a write of
    `foo bar` whose version snapshot lands on one of `foo%20bar`'s moves that snapshot to its own
    current key first (inside `Transaction.transactWrite` it fails as before). A projection's row
    tombstone and outbox item hold no values, so 1.37 marks the ones it writes under a key whose text
    changed (`__edd_kt__`): one without the mark is 1.36's, and belongs to the row its key reads back
    as. An effect of `foo bar`'s row never replaces `foo%20bar`'s pending one at the same key (it
    moves that one first), and `drain(key)` of each delivers only its own effects, from both keys, in
    one order. Collection queries don't judge rows this way yet, and a time-series `append` can
    overwrite another value's 1.36 event stored under the same key text.
  - **`rekey`** (`db.tables.<Table>.rekey(options?)`) moves every remaining row 1.36 wrote whose key
    text changed to its current key: items (with their index keys and unique-constraint
    sentinels), version snapshots, soft-delete tombstones (with the sentinels `preserveUnique`
    kept, which then name the item's current key), time-series events, aggregates, and the event
    streams passed in `options.streams` (the client doesn't register streams; a stream is copied,
    flipped in one conditional transaction, then deleted, while writers keep appending). Items
    already at their current key whose index keys still hold 1.36 text, a sort key truncated under
    1.36 among them, are rewritten in place. It
    scans the table in `segments` parallel scan segments, `concurrency` rows of a page at once;
    `dryRun` counts what would move and writes nothing; `maxPages` bounds a run and `resume` goes
    on from its token, as from the last one `onProgress` received before an interruption. A row
    moves only when it is stored under the key 1.36 composed for its values, so a rerun moves
    nothing, and it moves rows whatever `legacyKeys` says. Every write is conditioned on what the
    move read — a row lands only where nothing is (a stream's snapshot: over an older one) and is
    deleted only while it is as read — so an application write that lands during the move wins: a
    row under both keys, a current key another row holds, a row writes changed on every attempt and
    one that can't be moved are reported as `conflicts` and left (a version snapshot whose current
    key holds the same snapshot is a copy, and its 1.36 row is deleted); rows no member owns (not the
    library's, a type the client doesn't know) are counted as `skipped`. A projection's row
    tombstones and outbox items move to their row's current key, an outbox item's row key and sparse
    index sort key rewritten (`tombstone` and `outbox` in the report); an outbox on another table
    moves with that table's `rekey`, for a projection defined where it runs, so outboxes need not be
    drained first (an item a drainer is delivering is left, a `contended` conflict). A table holding only event streams or an outbox can now be passed to
    `DynamoClient.make({ tables })` for its `rekey`: its definition is composed when `create` runs.
    The report (`Table.RekeyReport`) counts rows by kind
    and by member and carries the capacity the run consumed, measured whether or not
    consumed-capacity reporting is on. A bad option or resume token fails with a `ValidationError`
    (`EDD-9098`) before anything is read.
  - **Rolling deploys.** A 1.36 instance still running reads and writes 1.36 keys only: it misses
    rows a 1.37 instance has moved, and a write it makes puts the row under its 1.36 key again, which
    `rekey` then reports as a row under both keys. Finish the rollout before running `rekey`. A 1.36
    write that lands while a row moves isn't lost: a move deletes the 1.36 row only while it is as
    read (its version, or every attribute) and reads it again otherwise.

  **Behaviour change:** `.where()` with a strict `lt` on the last sort key composite, with an earlier
  one pinned, no longer throws `EDD-9046` (retired): it is sent as a `BETWEEN` ending just below the
  value. `.history(key).where()` with `gt` / `gte` on a string `orderBy` now returns stamps that start
  with an emoji.

  **Message change:** the `ValidationError` a write fails with when its version snapshot would
  overwrite different history now ends "The write was not made." (was "Nothing was written.").

  **Behaviour change:** a malformed `.startFrom()` cursor now fails the query with a
  `ValidationError` (`EDD-9094`) instead of throwing from `.startFrom()`.

  **Behaviour change:** an attribute declared both as a key attribute and as a vector filter
  attribute of another type now throws `EDD-9091` at `Table.make` / `Table.definition`, instead of
  silently keeping the first type.

  **Deprecated:** the `(name, config)` forms of `Aggregate.one` and `Aggregate.many`, and `many`'s
  `edgeAttributes`. Neither the name nor `edgeAttributes` is read: the `edges` key names the edge.
  Use `Aggregate.one(config)` / `Aggregate.many(config)` and leave `edgeAttributes` out; the
  deprecated forms keep working and are removed in the next major release. `OneEdge.name` and
  `ManyEdge.name` are now optional (set only by the deprecated form).

  **Behaviour change:** `Entity.make` now refuses a `unique` constraint field the model doesn't have
  (`EDD-9002`) and a `timeSeries.appendInput` field the model doesn't have (`EDD-9013`); both were
  accepted and the field silently ignored.

  **Type changes: misspelled attribute names no longer compile.** Each position listed above
  accepts only the model's field names (an index composite also takes a ref's `${ref}Id` once
  `refs` declares it), so code that named an attribute the model lacks, which ran only if the name
  was never used at runtime, is now a compile error on that name. A config declared outside the
  call (a shared `primaryKey`, an index or a `zorder` list in a variable) needs `as const`, or a
  generic helper, to keep its names literal: widened to `string[]`, they no longer fit the model's
  names. `DynamoModel.configure` refuses a key the model doesn't have even beside valid ones.
  `Collections.make`'s `composite` accepts only fields every member's model has. `GeoIndex.make`'s
  `index` accepts only the entity's index names. `Entity.make`'s `TRefs` type parameter now follows
  `TEntityType` and has no default (left out, refs still resolve to `undefined`), and
  `Aggregate.make` lists its top-level overload first, so `Parameters<typeof Aggregate.make>` reads
  the sub-aggregate form.

  **Type changes: page cursors are `Option<string>`.** `cursor` on query pages (`Query.Page`, every
  `fetch()` and `Query.execute`), on collection pages (`db.collections.<name>(…).fetch()`) and on
  aggregate list results (`Aggregate.ListResult`) was `string | null` and is now
  `Option.Option<string>`: `Some` while there is more, `None` when there are no more results.
  Where a nullable is needed, such as a JSON response, use `Option.getOrNull(page.cursor)` (or a
  `Schema.OptionFromNullOr(Schema.String)` field); otherwise `Option.match` / `Option.map`, such
  as `Option.map(page.cursor, (cursor) => query.startFrom(cursor))` as `Stream.paginate`'s next
  state. `.startFrom()` and `list({ cursor })` still take a string. The new `RekeyReport.resume` is an `Option<string>` too,
  and `rekey({ resume })` takes the token's string.

  **Type changes:** `KeyComposer.composeIndexKeys` / `tryComposeIndexKeys` / `composeAllKeys` and
  `GsiUpdateResult.sets` values widen to `string | Uint8Array` (bytes only for Z-order halves).
  `GsiConfig.sk` is `KeyPart | ZOrderKeyPart` (`composite` is optional on the union), `KeyPart`
  gains `zorder?: never` / `prefix?: never`, and `IndexDefinition.sk` is `KeyPart | ZOrderSkPart`.
  `IndexSkComposites` is `never` for a Z-order half. `pageSize` accepts `number | "natural"` on
  `Query`, bound queries and collection queries. `DynamoSchema` gains `legacyKeys?: false`
  (`DynamoSchema.make` takes `legacyKeys?: boolean`). The new `ItemNotMoved` joins the error
  channels of `Transaction.transactWrite`, an `EventStore` append (through `additionalItems`) and
  `Entity.PlanUpdateError` / `PlanDeleteError`; a time-series `append` and `restore` add
  `ConcurrentModification`. New: `rekey` on the typed client's table operations, and
  `Table.RekeyOptions`, `RekeyReport`, `RekeyCounts`, `RekeyRowKind` (`outbox` among its kinds),
  `RekeyConflict` and `RekeyMemberReport`.

## 1.36.1

## 1.36.0

### Minor Changes

- [#176](https://github.com/jmenga/effect-dynamodb/pull/176) [`fe9f8ae`](https://github.com/jmenga/effect-dynamodb/commit/fe9f8ae511da9f5b53a73bef0ba5fa0e278f52df) Thanks [@jmenga](https://github.com/jmenga)! - Report consumed capacity and request counts for every library operation ([#174](https://github.com/jmenga/effect-dynamodb/issues/174)).

  Provide `ConsumedCapacity.layer()` (off by default) and every library operation (`Entity.get`, `Entity.query`, `EventStream.read`, `EventStream.append`, `Batch.write`, `Transaction.transactWrite`, `Aggregate.update`, projections, geo, checkpoint store, …) asks DynamoDB for its `ConsumedCapacity`, sums it over every request it sends, and:
  - runs in a span `effect-dynamodb.<operation>` (kind `client`, or `internal` when nested in another operation) carrying `aws.dynamodb.consumed_capacity.total` / `.read` / `.write`, `aws.dynamodb.table_names` and `effect_dynamodb.request_count` (pages, for a read);
  - delivers one `OperationReport` per root operation to an optional `onOperation` observer: capacity units (read / write split), requests, requests by command, per-table (and, with `level: "indexes"`, per-index) breakdown, vector bytes, outcome, and the nested library operations it ran. Summing reports never double counts.

  `ConsumedCapacity.withOperation` / `withOperationStream` group application work into one report. The instrumentation wraps whatever `DynamoClient` is in context, so decorated and mocked clients are covered. With reporting off no request, response or return type changes and no span is created.

  Bind sites no longer capture the tracer's parent span current at bind time: spans of bound operations now parent to the caller's span.

## 1.35.0

### Minor Changes

- [`69e309b`](https://github.com/jmenga/effect-dynamodb/commit/69e309b7cc20b9debc096ca074ff5022e2ea90ad) - EventStore: `append({ headProof: "none" })` lets a caller that already guarantees the stream head skip the version-contiguity `ConditionCheck` and write no proof item. The check is billed at 2 WCU per KB of the previous event, so skipping it can remove most of an append's write cost. The caller takes over both of the check's duties. First, `expectedVersion` must never be ahead of the head; the version of any event read from the stream meets this. Second, the caller must refuse to append when the last event it read is sealed. The event puts still reject a stale `expectedVersion` with `VersionConflict`. `append` and `measureAppend` accept `"none"`. `commandHandler` (excluded from its type, and a `ValidationError` at runtime) and a nested `appendOp` refuse it.

  An append whose request is exactly one item, its one event, is now sent as a conditional `PutItem` instead of a `TransactWriteItems`, at half the write cost. That covers the first event of every stream and one-event `"none"` appends. It has the same atomicity, result and errors: `StreamSealed`, `VersionConflict`, a diagnosed `ValidationError`, or `TransactionCancelled` (`operation: "PutItem"`) with the reason a transaction gives its item. The event carries a random write token (`__edd_wt__`, 42 bytes). If the AWS SDK resends a put that committed but lost its response, the resend recognises the event as its own and succeeds, as a transaction's idempotent retry does. A test double of `DynamoClient` that implements only `transactWriteItems` now also needs `putItem` for these appends.

## 1.34.1

## 1.34.0

## 1.33.0

### Minor Changes

- [`7663b91`](https://github.com/jmenga/effect-dynamodb/commit/7663b91f5844f8b3202fc8e69fbac5b80b7a10d7) - An append can now seal its stream, and it can carry another stream's append in its transaction ([#166](https://github.com/jmenga/effect-dynamodb/issues/166)). Without the new options, appends behave as before.
  - **`append(..., { seal: true })`** makes the append's last event the stream's final event. A later append fails with the new `StreamSealed` error (`streamName`, `streamId`, `sealedVersion`), which is exported from `effect-dynamodb` and `@effect-dynamodb/schema`.
    - The library marks the sealing event's item, and the append's inline snapshot, with `__edd_sealed__`. The existing contiguity check now also tests that marker. The failure is diagnosed from the cancellation reasons, so the seal costs no extra items, no extra capacity and no pre-read.
    - `seal` with zero events, or a `seal` that is not a boolean, fails with `ValidationError`. On a `mode: "inline"` stream without `every`, a sealing append also needs `snapshot`.
    - `StreamSealed` is terminal. `commandHandler` never retries it, and it reports the seal from its load, before `decide`. With `loadState`, the handler learns of the seal from `LoadedState.sealedVersion`.
  - **`stream.appendOp(...)`** returns another stream's append as an item of `append`'s or a handler's `additionalItems`. The item commits if and only if the outer append does. With `seal: true`, one transaction seals a stream and opens its successor (a generation changeover). Without `seal`, several streams' events commit together or not at all. A nested op's failures name its own stream. `Transaction.transactWrite` does not accept it.
  - **Reads report the seal.** The sealing event carries `StreamEvent.sealed: true`, and `readLatest` returns it as `LatestState.seal`. A `"withoutMetadata"` stream index does not report it, and neither does `currentVersion`.
  - **`commandHandler` retry.** A `VersionConflict` raised by another stream's `appendOp` is now retried, even on a call with an `expectedVersion`. The retry reloads the handler's own stream and checks its If-Match again.
  - **Type change.** `append`'s `additionalItems` and `AdditionalItemsInput` widen from `TransactWriteOp` to `AppendWriteOp` (`TransactWriteOp | StreamAppendOp`). Passing a `TransactWriteOp[]` still compiles. Code that reads these types and forwards the value to `Transaction.transactWrite` no longer compiles, so annotate that value as `ReadonlyArray<TransactWriteOp>`.
  - **Upgrade every writer before sealing a stream.** A writer on an earlier version doesn't enforce the seal, and one write past the seal reopens the stream for every writer.
  - **`writeSnapshot` is unchanged.** It doesn't know whether a stream is sealed, so it must not target a sealed head with an unmarked snapshot. If it does, a `headProof: "snapshot"` append can land past the seal.

## 1.32.0

### Minor Changes

- [`df17e14`](https://github.com/jmenga/effect-dynamodb/commit/df17e147c392ef570ab7c234c3d1f14f5f772f3c) - An append can now name an item that proves the stream head, in place of the version-contiguity `ConditionCheck`, and `commandHandler` can load state from the caller's own record ([#164](https://github.com/jmenga/effect-dynamodb/issues/164)). Without the new options, nothing changes: every append after version 0 still writes the check.
  - **`append({ headProof })`** takes `{ additionalItem: n }` or `"snapshot"` (the `HeadProof` type). The check reads the event at `expectedVersion`, and inside a transaction DynamoDB bills it at 2 WCU per KB of that event; with a proof it is not written.
    - `{ additionalItem: n }`: `additionalItems[n]` is the proof, for example the caller's state record conditioned on the version it was loaded at. It must carry a condition of its own (`.condition()`, `create()` or `Transaction.check`). An item without one, or an `n` that is out of range, fails with `ValidationError` before anything is written. When its condition fails, the append fails with `VersionConflict`, not `AdditionalItemConditionFailed`. Every writer of the stream must write the record in the same transaction as its events.
    - `"snapshot"`: the inline snapshot `Put` is conditioned on `asOfVersion = expectedVersion`, and its failure is a `VersionConflict`. It requires `snapshot` on the append and a `mode: "inline"` stream without `every`; any other snapshot config dies with `[EDD-9085]`.
    - `measureAppend` accepts `headProof` and leaves the check out of `transactionBytes`.
  - **`commandHandler({ loadState })`** loads the state and head from the caller's record (`Option` of `LoadedState`: `None` is a new stream) instead of the stream. The If-Match check, `decide` and the append run as before, and a `VersionConflict` re-runs `loadState` under `retry`. Its error and requirements join the handler's.
  - **`commandHandler({ headProof })`** applies a head proof to every append the handler makes. With `"snapshot"`, it is applied only when the load found the snapshot at the head; otherwise that append writes the check.
  - Creating a handler throws `[EDD-9085]` for `loadState` with `verifySnapshot: false` or with `headProof: "snapshot"`, and for `headProof: "snapshot"` on a stream that is not inline without `every`.
  - An inline `loadState: (streamId) => …` is contextually typed by the stream id and the decider's state: the handler's options type parameter no longer has a default.

## 1.31.0

### Minor Changes

- [`7aace5c`](https://github.com/jmenga/effect-dynamodb/commit/7aace5c8ed8e70809c76fd17fb6bacb7a2ffc9c0) - A projection's `evolve` can now return `EventStore.skipEvent` to leave the row alone ([#162](https://github.com/jmenga/effect-dynamodb/issues/162)), in `EventStore.projection` and in every `multiProjection` source, with no option to enable it.
  - A skipped event is reported in a new `skipped` array, on instance results, `ProjectionApplied`, `ProjectionCaughtUp` and `ProjectionRebuiltRow`. It is never in `applied`, and it produces no outbox effects.
  - A row whose events are all skipped (or already applied) isn't written, and its revision and checkpoints stay as read. A mixed batch is still one write.
  - An instance's checkpoint stops at its last applied or rejected event. A skipped event above it is read and decided again by the next gap-fill, redelivery or `catchUp`.
  - In `"latest"` mode, a skip falls back to the next older event, as a rejection does.
  - An unowned field-mapped checkpoint is now adopted by the first instance of its source that writes it. Previously the first instance in fold order took it even when every one of its events was skipped, or it failed. In that case the claim wasn't written, but the next instance was still sent to the map, or failed with `ProjectionSourceConflict`.

## 1.30.1

### Patch Changes

- [`32d0f11`](https://github.com/jmenga/effect-dynamodb/commit/32d0f119146e8a3f01290418e6d2e9d954ea0117) - Projection rows read through a `DynamoModel.configure`d read model now hold exactly the model's fields ([#160](https://github.com/jmenga/effect-dynamodb/issues/160)), `Hidden` ones included. The engine looked up the field list on the configured wrapper, found none, and kept the whole decoded item. As a result, `pk`, `sk`, `__edd_e__` and other storage attributes leaked into the state that `evolve` receives and that results carry (for example, the stored row of an already-applied redelivery, or `catchUp`). The make-time check that a named checkpoint, instance, map or revision field belongs to the model (`EDD-9081`) now applies to configured models too.

## 1.30.0

### Minor Changes

- [`433c8cd`](https://github.com/jmenga/effect-dynamodb/commit/433c8cd04816a5e05c4f84a6dc89fbe2ca7f308b) - Projections accept optional checkpoint, instance, map and revision fields ([#158](https://github.com/jmenga/effect-dynamodb/issues/158)). A read model that adopts a projection over existing rows can declare the projection's fields with `Schema.optional`: `checkpoint` and `revision` on `projection`; `checkpoints.field`, a source's `field` and `instanceField`, and `revision` on `multiProjection`. An absent field reads as no checkpoint, unowned, no entries or no revision. A single-source projection without a `revision` now guards its first write on such a row with `attribute_not_exists` on the checkpoint field; it previously retried until it failed. The checkpoint map is written only when it has entries or the row already had it, so a row gains only the fields the projection set.

## 1.29.0

### Minor Changes

- [`3d8713d`](https://github.com/jmenga/effect-dynamodb/commit/3d8713d01ee3efb172f70352df9049ba33a1f2f4) - EventStore projection follow-ups ([#153](https://github.com/jmenga/effect-dynamodb/issues/153), [#154](https://github.com/jmenga/effect-dynamodb/issues/154), [#155](https://github.com/jmenga/effect-dynamodb/issues/155), [#156](https://github.com/jmenga/effect-dynamodb/issues/156)).
  - **Multi-source projections:** `EventStore.multiProjection` maintains rows fed by several streams.
    - Each row keeps a checkpoint per source instance, in a map keyed `<source>#<streamId>`, or in per-source legacy fields recording their owning instance.
    - A second instance moves to the map, or fails with the new `ProjectionSourceConflict`.
    - Sources run in `fold` mode (gap-filled) or `latest` mode (newest event first, falling back past `terminal` rejections; older ones `superseded`). One instance's failure is reported as its own outcome while the row's other sources still apply.
    - It provides `catchUp`, and `rebuild(rowKey, { instances })` as the repair path. `bindProjection` and `EventStore.processBatch` accept it next to single-source projections.
  - **`revision`:** a library-owned write counter. Every write increments it and is conditioned on it, so concurrent writers from different sources serialise and `rebuild` is race-free. It can name an existing counter, with `{ field, initial }` setting a new row's first value. It is required by multi-source projections and the outbox, and is optional on `projection`.
  - **Tombstones:** with `removal`, `evolve` may return `EventStore.removeRow`.
    - The row becomes a tombstone at its own key that keeps its checkpoints (with an optional TTL).
    - Entity `get`, `Batch.get` and `Transaction.transactGet` report the tombstone as absent, and the read model's `create` may replace it.
  - **Ordered outbox:**
    - Effects commit with the row in one `TransactWriteItems`, in the row's partition or in a separate table.
    - `drain` / `deliver` / `drainPending` deliver them strictly in order per row, at least once.
  - **Polled change feed:** a new `effect-dynamodb/change-feed` subpath for consumers outside Lambda, with `@aws-sdk/client-dynamodb-streams` as an optional peer dependency.
    - `changeFeed` reads with shard lineage, iterator recovery and a fallback to a full `DescribeStream`.
    - `CheckpointStore` (memory or DynamoDB) records checkpoints, with a single-consumer lease.
    - `runChangeFeed` feeds `EventStore.processBatch`.
  - Missing shards are confirmed gone before they are written off, and reads are bounded (`maxConcurrentReads`). Invalid feed settings throw `[EDD-9083]`, and a `finishedTtl` under 28 h throws `[EDD-9084]`.
  - **Also:**
    - `readFrom(…, { toVersion })`;
    - a projection read model defined before its table registration now resolves its table lazily.

## 1.28.0

### Minor Changes

- [`f21d781`](https://github.com/jmenga/effect-dynamodb/commit/f21d78148db75528b33acab586b886b7f88e3428) - EventStore change-feed projections ([#151](https://github.com/jmenga/effect-dynamodb/issues/151)). `EventStore.projection({ stream, readModel, key, initial, evolve, checkpoint })` folds a stream's events from DynamoDB Streams into read-model entity rows in version order, taking the order from the event store instead of from delivery. Rows are keyed by `key(streamId, event)` — one per stream instance, or several per instance from event fields — each with its own checkpoint; `Option.none()` from `key` acknowledges an event that addresses no row. `applyBatch` sorts and deduplicates each row's events, reads only the versions the batch lacks (one strongly consistent `readFrom`, bounded by the new `toVersion` option), and writes the row once, conditioned on its checkpoint, keeping `Hidden` fields and `createdAt`; a lost race re-reads under a jittered backoff. Each outcome reports `applied` (at most once per event), `alreadyApplied` (republish for at-least-once) and `rejected` (events a `terminal` predicate acknowledged). Also: `apply`, `catchUp`, `rebuild`, `toItem`, a checkpoint `offset`, `processBatch` per projection and `EventStore.processBatch` across several projections of one feed (record positions, `unrouted` events of streams without a projection, `image` / `identifier` accessors, `onDecodeFailure`), `bindProjection` (`R = never`), `EventStore.decoder`, `EventStore.eventFilterPattern`, and `EventStore.batchResponse` keyed by `dynamodb.SequenceNumber` (Lambda) or `eventID` (Pipes), failing with the new `StreamRecordIdentifierMissing`. Streams expose `streamIdFields`, `eventMarker` and `parseStreamId`. New codes `[EDD-9081]`–`[EDD-9082]`.

## 1.27.0

### Minor Changes

- [#150](https://github.com/jmenga/effect-dynamodb/pull/150) [`8120f58`](https://github.com/jmenga/effect-dynamodb/commit/8120f582a25d54ff56228f9084124f2c50812f8b) Thanks [@jmenga](https://github.com/jmenga)! - EventStore GSI stream indexes can derive their partition, so several streams share one partition of a GSI, and their snapshots can be in it ([#149](https://github.com/jmenga/effect-dynamodb/issues/149)).
  - `partition: (event, version, streamId) => string | undefined` on a `type: "gsi"` index replaces the stream's partition key with a derived value, stored raw. Streams that declare the same GSI write one partition of it, and one query reads the group. The partition can come from the event, for a stream keyed by something other than the group. Both `partition` and `key` run for every appended event, and an event is indexed only when both return a string.
  - `snapshot: (state, asOfVersion, streamId) => { partition, key } | undefined` puts the snapshot item in the index. It requires `partition` and a stream `snapshot` config. The attributes are written by the same `Put`: an inline snapshot enters the index in the append's own transaction, and `writeSnapshot` and `commandHandler` snapshots carry them too. `undefined` leaves the snapshot out, and takes it out of the index.
  - Within one append, every event's partition and the inline snapshot's must be the same. Otherwise the append fails with `ValidationError` before anything is written. An empty or over-long partition is DynamoDB's to reject, and is reported as a `ValidationError` naming the index and the item.
  - `key` also receives the stream id: `key(event, version, streamId)`.
  - `readIndex` and `query.index` take `{ partition }` for such an index and return the given stream id's events in that partition. The types require it, through a new trailing `TPartitionedIndexName` type parameter on `EventStream` and `BoundEventStream`. `query.index` throws `[EDD-9080]` for a missing partition, or for one passed to a stream-scoped index.
  - `indexDefinitions` emits a GSI that several streams declare alike once. A derived partition or snapshot entry is not part of the definition, and a `"withoutMetadata"` index that holds snapshots also projects `asOfVersion` and `state`. `StreamIndexSettings` gains `partition` (`"stream" | "derived"`) and `snapshot` (`boolean`).

  Existing indexes are unchanged: their write layout, reads and `indexDefinitions` output stay the same.

## 1.26.0

### Minor Changes

- [`b393fd8`](https://github.com/jmenga/effect-dynamodb/commit/b393fd8557ec749453149f5e27ffeffdb2230341) - Packed storage: store an entity field, an EventStore event's `data` or a snapshot's `state` as one JSON string, compressed over a threshold ([#147](https://github.com/jmenga/effect-dynamodb/issues/147))

  A large object stored as a native DynamoDB map is slow to read and write, and its size counts every attribute name. `DynamoModel.Packed({ format: "json", compression?: { codec, threshold? } })` is one declarative config, shared by entities and EventStore, that stores such a value as one JSON string (`S`) or, when compression is configured, the JSON is at least `threshold` bytes (default 1024) and compressing makes it smaller, as header-prefixed compressed bytes (`B`). Nothing changes for code that does not opt in: the default stays a native map, and no attribute is added to any item.
  - **Entity fields.** `DynamoModel.configure(model, { field: { storedAs: DynamoModel.Packed(...) } })`, a sibling of `SparseMap`. Packed on every write path (put / create / upsert / update `.set()` / `Batch.write` / `Transaction.transactWrite` / time-series `append`) and read by stored form on every read path. A packed field cannot be a key or index composite, `timeSeries.orderBy`, a unique-constraint field, a ref, or a vector index partition or filter field (`[EDD-9072]`–`[EDD-9075]`). Conditions and filters take only `exists` / `notExists` on the whole field, updates only a whole-value `.set()` / `.remove()`, projections only the whole field (`[EDD-9076]`, `[EDD-9077]`); PathBuilder callbacks refuse the rest at compile time. Aggregate edges store their edge entity's packed fields packed.
  - **EventStore.** `makeStream({ storedAs: { data } })` and `snapshot: { storedAs }`. `append` / `commandHandler` pack each event (and the inline snapshot, inside the append transaction). Every read path decodes by stored form; raw rows (`Query.select`) return `data` as parsed JSON through every stream-index projection; `Query.filterExpr` on `data.*` is refused, pointing to `Query.filterBy`. Metadata stays a map.
  - **Self-describing, no migration.** Readers dispatch on the stored value (native, `S`, or `B` whose first byte names the format and codec), never on the current config, so switching a field or stream between map, JSON and compressed needs no rewrite, and a stream or table holding a mix reads correctly.
  - **Compression.** Compressors are small synchronous `Compressor` implementations registered on the `Compression` service: `Compression.layer(...)` merged into the application layer (recommended), `DynamoClient.make({ compressors })`, or `DynamoClient.layer({ compressors })` (whose `Compression` output does not survive a wrapper layer that consumes it through `Layer.provide`). `node:zlib`-backed gzip, brotli and zstd (zstd needs `zlib.zstdCompressSync`, Node 22.15 or later) ship from the new `effect-dynamodb/compression/zlib` entry point; the library does not assume a runtime, and any runtime can register its own compressors, the only module that imports `node:zlib`; each bounds one value's decompressed size at 64 MiB by default (`maxOutputLength`, a decompression-bomb guard). A codec that a bound entity, aggregate edge or stream config names must be registered where it is bound: `DynamoClient.make` and `EventStore.bind` fail with an `[EDD-9078]` configuration defect otherwise, and an unbound stream does so on its first operation. Any other value whose codec is not registered fails with a `ValidationError` whose `cause` is the new tagged error `CompressorNotRegistered` (naming the codec, direction and attribute).
  - **Size planning (no pre-checks).** `stream.measureAppend` / `measureSnapshot` and `StorageEncoding.valueBytes` give the exact stored size of what a write would send, for planning chunks against `StorageEncoding.limits`; `StorageEncoding.valueBytesSync` gives the same number synchronously, with explicit compressors, for pure planning code. The write-failure diagnosis measures the stored (packed) bytes.
  - **DynamoDB Streams.** `stream.decodeStreamImage(image)` returns the read paths' `StreamEvent` for a stream record image, DynamoDB JSON or unmarshalled, with `B` as bytes or base64 (Lambda, EventBridge Pipes); with `{ raw: true }` each event also carries `rawData`, its `data` as stored in wire form, unmodelled fields included. `StorageEncoding.decode` (an `AttributeValue`) and `decodeUnmarshalled` read one stored value; `encodeSync` / `decodeSync` / `decodeUnmarshalledSync` do the same synchronously, with explicit compressors.
  - **Read cost.** Packed values are read through a synchronous codec core lifted into one Effect per row (none for a row with nothing packed), so a packed value costs about what `JSON.parse`, plus decompression, costs.
  - **Measured.** A downstream benchmark on Lambda (arm64, Node 24; 5,990 small events read from a stream index) read JSON `data` about 2× faster than a map through the library (121 vs 261 ms select + fold), at about 19% more stored bytes and read units. A ~47 KB state took 5 write units as zstd-compressed JSON, against 47 as JSON and 38 as a map. Compressing every small event (threshold `0`) cut read units by 24% but made reads about 4× slower, so keep the 1 KB default threshold. The Packed Storage guide has the full tables and method.

  Compatibility notes:
  - No error channel changes: every operation keeps its 1.25.0 error type and `R`. A missing compressor is reported through the existing `ValidationError` (inspect `cause` for `CompressorNotRegistered`), or, for a codec a bound member or stream config names, as an `[EDD-9078]` defect at bind or first use.
  - `Entity` / `EntityDefinition` gain a trailing, defaulted `TPackedFields` type parameter.
  - `DynamoClient.layer` / `layerConfig` return `Layer<DynamoClient | Compression, …>` only when given `compressors`.
  - `Entity.decodeMarshalledItem` now applies field renames, sparse maps and base64 `B` values, so stream images that failed to decode before now decode.
  - An explicit `DynamoClient.make({ embedder })` now reaches bound entity CRUD and bound aggregates, not only query accessors and collections (as `compressors` does).
  - A `Table.make` that throws no longer rebinds its member entities to the rejected table.
  - A version without this feature cannot read packed values: deploy readers before writers turn packing on.

## 1.25.0

### Minor Changes

- [`4906069`](https://github.com/jmenga/effect-dynamodb/commit/49060695ea5fb9cc5ed19970e6131c9f819ff390) - EventStore per-event metadata and timestamps on `append` and `commandHandler`, and write limits diagnosed from DynamoDB's rejection instead of pre-checked ([#144](https://github.com/jmenga/effect-dynamodb/issues/144))

  `append`'s `metadata` is one value copied onto every event of the append. Metadata that belongs to one event (an event id used as a publish message id, the id of an imported event in the store it came from) had nowhere to go but a list packed into that value, so every item stored every entry: N² entries for an append of N events, copied again by any stream index. The options below are additive; no option combination that works today changes behaviour. Error reporting for writes DynamoDB rejects for a limit changes as described under **Write limits**.
  - **`eventMetadata` on `append`.** One entry per event, in the order of `events`: entry `i` is written onto event `i` and read back as that event's `StreamEvent.metadata`. Each defined entry is encoded through the stream's metadata schema, as `metadata` is, and an encode failure names its index (`operation: "EventStore.append.eventMetadata[<i>]"`). An `undefined` entry writes its event without a `metadata` attribute. A length that differs from `events.length` fails with `ValidationError` before anything is sent, even for an append of no events. The read side is unchanged.
  - **`eventMetadata` on `commandHandler`.** A function of the `Decision` (`{ events, state, previous, version }`, as a function-form `additionalItems` receives) returning the entries, or an `Effect` of them whose error and requirements join the handler's. It runs after the new events are folded and before `additionalItems`, is not called on a no-op, and is re-run on every attempt (each `VersionConflict` retry and the re-decision under `verifySnapshot: false`). A result of the wrong length fails with `ValidationError` (`operation: "EventStore.commandHandler.eventMetadata"`); neither that nor a failure of the returned `Effect` is retried. Minting ids with the `Crypto` service's `randomULID` (or `randomUUIDv7`) keeps them deterministic under `TestClock` and a test `Crypto` layer with fixed bytes.
  - **`metadata` and `eventMetadata` are mutually exclusive**, on `append`, the bound stream and the handler. Passing both is a type error, and a `ValidationError` for untyped callers. `undefined` counts as absent, so `{ metadata: undefined, eventMetadata: [...] }` is accepted.
  - **`eventTimestamps` on `append` and `commandHandler`.** One `DateTime` (or `undefined`) per event, in order: entry `i` is written as event `i`'s `timestamp` and read back as its `StreamEvent.timestamp`, and `undefined` keeps the append's `Clock` time. Entries are written with `DateTime.formatIso`, so a zoned `DateTime` is stored as its UTC instant. It combines with either metadata option, so an import can carry each event's original time (and its source id) instead of pinning the `Clock` per chunk. A length other than `events.length`, or an entry that is neither a `DateTime` nor `undefined`, fails with `ValidationError` (`operation: "EventStore.append.eventTimestamps"`) before anything is sent, even for an append of no events. Only event items change: the idempotency sentinel, its TTL and an inline snapshot keep the append's time, and `version`, not `timestamp`, still orders a stream. On `commandHandler` it is a function of the `Decision` returning the array directly or an `Effect` of it, whose error and requirements join the handler's, run after `eventMetadata` and before `additionalItems` under the same rules; a bad result, plain or from the `Effect`, fails with `ValidationError` (`operation: "EventStore.commandHandler.eventTimestamps"`), and neither that nor a failure of the returned `Effect` is retried.
  - **Write limits: diagnosed from DynamoDB's rejection, no longer pre-checked.** A new library-wide rule: limits DynamoDB enforces itself (100 items and 4 MB per transaction, 400 KB per item, 2048-byte partition keys and 1024-byte sort keys) are not checked before sending, so a passing write does no extra work. A write over one is sent, DynamoDB rejects it whole (nothing is written), and the library recognises the rejection, confirms it by measuring the request it sent, and fails with an error naming the culprit, with DynamoDB's error kept as its `cause`. The 100-item checks of `transactWrite`, `transactGet`, entity transactions, the transactional cascade and `append`, the 4 MB transaction check, and the stream-index 1024-byte key check no longer run before sending; each still produces the error it did (`DynamoError`, `TransactionOverflow`, `CascadePartialFailure`, `AppendTooLarge` with the expanded `count`, `ValidationError`), now from DynamoDB's rejection, so a rejected write costs a round trip. Newly named: an oversized item or an over-long partition or sort key (table or index key, measured in UTF-8 bytes) on single-item entity writes, entity, aggregate and `transactWrite` transactions, `Batch.write`, `EventStore` snapshot writes and `append` (the event, inline snapshot, idempotency sentinel or additional item, e.g. "the event at version 2"), previously DynamoDB's bare `ValidationException`. A rejection the library does not recognise (for example, AWS wording this release does not know) or cannot confirm passes through as the bare `DynamoValidationError` it always was.
  - **Request rules: the remaining pre-checks are converted too.** The same rule now covers every request rule DynamoDB enforces itself. Each former refusal is sent and DynamoDB's rejection diagnosed (wordings probed on DynamoDB Local 3.1.0):
    - **Aggregate groups.** `Aggregate` no longer counts every group before writing the first. Each group is its own transaction, so a multi-group write was never atomic. A group DynamoDB rejects fails as before (`AggregateTransactionOverflow` over 100 items, `ValidationError` for size), and the error now names the sub-aggregates earlier groups already committed (new optional `AggregateTransactionOverflow.committed`). A failed `create` can therefore leave the root written; the message says to `update` or `delete` the partial aggregate.
    - **One operation per item.** A transaction that touches one item twice (in `transactWrite`, `transactGet` or `append`'s additional items, counting the sentinels and snapshots a guarded put adds) is sent. DynamoDB's rejection becomes the same `ValidationError` (`DynamoError` from `transactGet`) naming both ops. DynamoDB can report a repeat as a failed condition, so the repeat is recognised before any conditional mapping: it is never read as a lost race, retried, or reported as `OptimisticLockError` / `VersionConflict`. A `BatchWriteItem` chunk with a duplicate key, previously a bare `DynamoValidationError`, is now a `ValidationError` naming both requests.
    - **Expression limits.** A `.condition()` too large to fit beside an entity write's own guard (4,096 characters, 300 operators, 100 `IN` operands) is sent as built. DynamoDB's rejection becomes a `ValidationError` stating the expression's size and the caller's share of it. The strategies that pick a guard that fits (a wide update writing the whole item, an unversioned delete's fallback guard) are unchanged, and now also respect the 100-operand `IN` limit.
    - **`readIndex` key bounds.** An empty `beginsWith` / `between` bound, or a `between` whose lower bound sorts after its upper bound, is sent. DynamoDB's rejection becomes a `ValidationError` (`operation: "EventStore.readIndex"`) naming the index and the bound. The other option checks (at most one of `beginsWith` / `between`, string bounds, `limit`) stay, because DynamoDB never sees them or would accept them.
    - **Consistent reads of a GSI.** `.consistentRead()` on an entity index accessor, a collection or a GSI-backed `readIndex` is sent. DynamoDB's rejection becomes a `ValidationError` (`operation: "query.consistentRead"`) naming the index. An entity index pointed at an LSI of a table created outside the library now reads consistently, as DynamoDB allows.
    - **Empty stream-index keys.** A stream-index `key` that returns `""` is sent. DynamoDB's rejection becomes a `ValidationError` (`operation: "EventStore.append.indexes"`) naming the index and the event's version. A non-string key is still refused before sending.
    - **Vector-index quotas.** `Entity.make`, `Table.make` and `Table.definition` no longer refuse more than 18 `INLINE_FILTER` attributes per index (`[EDD-9032]` keeps only its duplicate-filter check) or more than 5 vector indexes (`[EDD-9034]`, retired). The per-table quota can be raised through AWS Support, so the old refusal rejected valid configurations. `db.tables.*.create()` and `addVectorIndex` diagnose DynamoDB's rejection, naming the index and every entity sharing it. DynamoDB Local has no vector indexes, so this recognition follows AWS's documented quotas and is covered by unit tests only.
    - **Vector-index dimensions.** `Entity.make` no longer refuses `dimensions` outside 1–4096 (`[EDD-9030]`, retired). `db.tables.*.create()` and `addVectorIndex` send it, and DynamoDB's rejection is diagnosed into the error DynamoDB returned (same tag), its message naming the index, its dimensions and the entities sharing it. A non-integer `dimensions` is still refused at `Entity.make`, now as `[EDD-9070]`: DynamoDB reads an integer leniently (DynamoDB Local creates `2.9` as `2`), so it could accept another, immutable dimensionality. Unit tests only, as above; AWS's wording is unverified.
    - **Vector search `topK` is no longer clamped.** `.topK(k)` sends `k` as given. DynamoDB accepts an integer in 1–100 and rejects anything else; `collect()` then fails with a `ValidationError` (`operation: "vectorSearch.<index>.topK"`) naming the `topK` and the accepted range, with DynamoDB's error as its `cause`. **Behaviour change:** `.topK(k)` above 100 (or below 1) used to be clamped silently, so a call that returned fewer results than it asked for now fails — ask for at most 100. `VectorSearchEmulation` rejects an out-of-range `TopK` as DynamoDB does. `VectorIndex.clampTopK` is deprecated and no longer used.
    - **Aggregate `consistentRead` on a GSI collection index.** `Aggregate.make` no longer refuses it (`[EDD-9042]`, retired). Each assembly read is sent, and DynamoDB's rejection becomes a `ValidationError` (`operation: "get.consistentRead"`, `"update.consistentRead"`, `"list.consistentRead"`) naming the aggregate and the index; `delete`, whose error union has no `ValidationError`, fails with DynamoDB's own `DynamoValidationError`, its message explained. A misconfigured aggregate now fails on its first read rather than at startup.
    - **`isIn` with no values.** It is no longer refused before sending: it compiles to `IN ()`, which DynamoDB rejects as a syntax error, and the rejection becomes a `ValidationError` naming the `isIn()` and its attribute — on entity writes, transactions, `append`'s additional items, entity, collection and scan filters (`operation: "query.filter"`) and aggregate `list` filters (`"list.filter"`). `Query.asParams` no longer fails for it. The other empty-part refusals (`or()` with no parts, `{}` under `or` / `not`) stay.
    - **Key bounds on every query.** An empty key bound or a `between` whose lower bound sorts after its upper bound was named only for `readIndex`; every query now names it — entity index accessors and `.where()` (`"User.byTenant"`), collections (`collection "assignments"`) and other queries (`query of <entity>`), naming the index and the bounds. `Batch.get` still sends a repeated key as given; DynamoDB's rejection of it is now a `DynamoError` naming both positions (`get 0 (User) and get 2 (User)`) instead of the bare one.
    - **What stays a pre-check:** only what DynamoDB cannot see or would accept with another meaning. That is the library's own invariants and option shapes, empty condition parts under `or` / `not` and an `or()` with no parts, a non-integer vector `dimensions`, `Batch.write`'s ordering of versioned puts, the aggregate sort-key collision check, and `[EDD-90xx]` definition errors.
  - **Exact DynamoDB size accounting.** One measure of DynamoDB's item and transaction sizes now serves both failure diagnosis and `Batch.write`'s chunking, replacing the lower and upper estimates. It was measured on DynamoDB Local and confirmed at the 409,600-byte item and 4,194,304-byte transaction boundaries. It fixes three under-counts. The upper estimate left out a map entry's separator byte. The lower one ignored that a number's digits pair up from the decimal point (`120` and `1.5` take 3 bytes, not 2). A transaction's size left out its expressions and their substituted names and values. An oversized item or transaction is now attributed exactly. See "How DynamoDB Sizes Items" in the Data Integrity guide.
  - **`Batch.write` splits versioned-put transactions at exactly DynamoDB's limits:** 100 items and 4,194,304 bytes, each put counted with its create-only condition. This replaces a 3.5 MB budget on an estimate, so fewer transactions are sent. If DynamoDB still rejects a chunk for size, `Batch.write` fails with a `ValidationError` giving the library's measure and DynamoDB's reported size; the chunk is not re-split or retried. A failed batch now says exactly what it had already written (versioned-put transactions and non-versioned requests) and what was not sent. Application transactions (`transactWrite`, `append`, `commandHandler`, entity writes) are never split.

  Type-level notes:
  - `AppendOptions`, `CommandOptions` and `IdempotentCommandOptions` are now type aliases (an intersection with a union, which is how the exclusivity is typed) instead of interfaces. Using them as types is unchanged; an `interface X extends AppendOptions<…>` in user code no longer compiles, since an interface cannot extend a union. Spreading options and adding a key, as in `{ ...options, metadata }` where `options` is one of these types, no longer compiles either, because the spread may already carry `eventMetadata`. Build the object from one branch, or omit `eventMetadata` from the spread. New exported types: `AppendOptionsBase`, `AppendMetadataOptions`, `CommandOptionsBase`, `CommandMetadataOptions` and `EventMetadataInput`.
  - New exported type `EventTimestampsInput`. `CommandHandler` and `BoundCommandHandler` gain four trailing, defaulted type parameters: `E3` / `R3` for an effectful `eventMetadata` and `E4` / `R4` for an effectful `eventTimestamps`, separate from each other and from `additionalItems`' `E2` / `R2` so effects with different error types are inferred as a union; `CommandOptionsBase` gains `E4` / `R4`. Call sites infer them; hand-written instantiations keep working.
  - `AppendTooLarge`, `TransactionOverflow` and `AggregateTransactionOverflow` gain an optional `cause` holding DynamoDB's rejection. Constructing them without it still compiles.
  - `AggregateTransactionOverflow` also gains an optional `committed: ReadonlyArray<string>`, naming the sub-aggregates already written, and an optional `operation: "create" | "update"`; its `message`, previously empty, now states the group, its item count, the limit and what was committed. `[EDD-9030]`, `[EDD-9034]` and `[EDD-9042]` are retired; `[EDD-9070]` is new (a non-integer vector `dimensions`). New exported type `AggregateTransactionOverflowFields` (in `@effect-dynamodb/schema`).
  - No public error union widens.

- **Stream index projection.** Each entry of `EventStore.makeStream({ indexes })` takes `projection?: "all" | "withoutMetadata" | "keys"`, default `"all"`, so `metadata`, often an event's largest attribute, need not be copied into every index. Existing streams are unchanged, and the library migrates nothing.
  - **`indexDefinitions`** emits `ALL` for `"all"`; `INCLUDE` of `__edd_e__`, `data`, `eventType`, `streamId`, `timestamp` and `version` for `"withoutMetadata"`; and `INCLUDE ["__edd_e__"]` for `"keys"`. `keys` is **not** `KEYS_ONLY`: every read filters on `__edd_e__`, and DynamoDB refuses a filter on an attribute an index does not project. Two streams declaring one physical index with different projections throw `[EDD-9067]`.
  - **Reads.** `"withoutMetadata"` is read with one query, and `readIndex` / `query.index` type `metadata` as `undefined` for that index name (the value is dropped even if the deployed index holds it). `"keys"` on an LSI is read with `Select: ALL_ATTRIBUTES`, so DynamoDB fetches each event from the table. `"keys"` on a GSI is read with the index query, then `BatchGetItem` for each page's events (chunks of 100, `UnprocessedKeys` retried with `Batch.get`'s backoff, missing keys re-read once with `ConsistentRead`, index order kept); `query.index` hydrates the same way, and `Query.count` never fetches. A `Query.filter` on a non-`"all"` index may name only projected attributes.
  - **The declared projection must match the deployed index.** Tables deployed with CDK or Terraform copy `Projection` from `indexDefinitions`. A row lacking an attribute its declared projection holds fails the read with a `ValidationError` (`operation: "EventStore.index.decode"`) naming the index, with the decode error as its `cause`; an index deployed without `__edd_e__` fails with DynamoDB's own "does not project one or more filter attributes" `DynamoValidationError`.
  - **Definition time.** An unknown `projection`, or a member an index entry does not declare (such as a misspelled `projection`, which would otherwise silently mean `"all"`), throws `[EDD-9063]` and is a type error.
  - **Types.** `StreamIndexSettings` gains `projection` (optional in `indexDefinitions`' input, so hand-built settings keep compiling). `EventStream` / `BoundEventStream` gain a trailing, defaulted `TIndexProjections` parameter. A wrapper that names the earlier type parameters and omits it still compiles, but its index reads are typed as carrying `metadata` (the default is `"all"`). Pass `IndexProjectionsOf<…>`, or let the type be inferred, so a `withoutMetadata` index reads as `metadata: undefined`. `makeStream`'s index type parameter becomes `TIndexes` (inferred at call sites). `StreamIndexDefinitions` and `Table`'s index types are unchanged. New exported types: `StreamIndexProjection`, `IndexEventMetadata`, `IndexProjectionsOf`, `StreamIndexesConfig`.
  - `Batch.get` now shares the `BatchGetItem` helper (responses matched to positions through a `Map` instead of a linear search per item). Its behaviour is unchanged, except that DynamoDB's rejection of a request that repeats a key is now named (see **Key bounds on every query**).

### Patch Changes

- **`Entity.purge` retries unprocessed deletes.** Purge deleted an item's rows in `BatchWriteItem` chunks of 25 but ignored the response's `UnprocessedItems`, so under throttling it could return success with rows left behind. Unprocessed deletes are now resent with `Batch.write`'s backoff (5 retries); when the retries run out, purge fails with a `DynamoError` (`operation: "BatchWriteItem"`) stating how many rows remain and exactly how many it had deleted. Purge again to finish.
- **`AggregateTransactionOverflow` has a readable message.** It was empty. It now names the aggregate, the sub-aggregate group, its item count and DynamoDB's limit, and says what earlier groups of the write already committed (or that nothing was written); for a failed `create`, it adds that the root may be committed, so a retried `create` fails its root guard (`ConditionalCheckFailed`) and the partial aggregate should be updated or deleted instead. Its fields are unchanged.
- **Examples exit non-zero when they fail.** Every example in `packages/effect-dynamodb/examples`, and the geo package's `vehicle-tracking.ts`, ended with a rejection handler that logged the error and swallowed it. A failing example therefore exited 0, and the docs' runtime test could not catch it. The handler is dropped (keeping the success message), so an unhandled rejection exits Node non-zero, and the tutorial snippets that showed it are updated. Two examples had been failing unseen, and both are fixed with their tutorials: `hr.ts` asserted that a partial GSI update fails, which it has not since the per-half index policy, and `guide-advanced.ts` expected versions one behind.
- **Conflicting declarations of one physical secondary index are refused (`[EDD-9069]`).** `Table.make` and `Table.definition` used to keep the first of two declarations of one physical index (entity indexes, the auto-generated `_cascade_<field>` indexes, an aggregate's collection and list indexes) silently when a later one named other key attributes or the other GSI/LSI classification. The table was created keyed the first declarer's way, and the other declarer's items never appeared in the index, so its queries returned nothing. Entities on one table that declared different primary-key fields were likewise resolved to the first entity's, leaving the others' writes without the table's key attributes. Both now fail at definition time with `[EDD-9069]`, naming both declarers and both key schemas. **Behaviour change:** a table that constructed with such conflicting declarations now throws at `Table.make` / `Table.definition`; tables whose members agree are unchanged. A conflict introduced only by an aggregate registered on `DynamoClient.make` rather than on `Table.make` surfaces when `DynamoClient.make` derives the table definition, as a vector-index conflict does.
- **Ref cascades work on tables not keyed `pk` / `sk`.** The cascade built each update's key from the target item's `pk` / `sk` attributes whatever the target entity's primary key was, so on a table keyed by other attributes (e.g. `PK` / `SK`) every eventual-mode update failed (`CascadePartialFailure` with `succeeded: 0`) and a transactional cascade was rejected whole. Each update is now keyed, and a rejected update diagnosed, by its own target entity's primary-key fields; one transactional cascade may span targets keyed differently. Tables keyed `pk` / `sk` behave as before.

## 1.24.0

## 1.23.0

### Minor Changes

- [#134](https://github.com/jmenga/effect-dynamodb/pull/134) [`a2904f9`](https://github.com/jmenga/effect-dynamodb/commit/a2904f9678ab71aa095959e520a5a9d529408401) Thanks [@jmenga](https://github.com/jmenga)! - Store nested dates and other transformed values in wire form, read the maps earlier versions wrote, and support nested sub-aggregates ([#133](https://github.com/jmenga/effect-dynamodb/issues/133))

  Earlier versions stored some `DateTime` values, and other values whose schema
  transforms them, as a marshalled copy of the domain object, for example
  `{ epochMilliseconds, "~effect/DateTime", _tag: "Utc" }` instead of an ISO
  string. On Effect 4.0.0 those rows either failed to read
  (`Expected DateTime.Utc`, for rows written under an Effect release candidate) or
  read back as plain objects that only looked like `DateTime`s. This release
  writes those values in their schema's wire form and reads the old maps back as
  real `DateTime`s.

  ### Before you upgrade
  - **Upgrade every reader before any writer, and don't roll back past this
    version once new rows are written.** A self date (`Schema.DateTimeUtc`,
    `Schema.Date`, or one with `storedAs`) inside a `NullOr` or other union, a
    `Record` or a `Tuple` is now stored as a string or number, on entities and
    aggregates alike. 1.22.0 fails to read it (`Expected DateTime.Utc`), or, in a
    union with a string member, reads it back as a plain string. The other shapes
    this release writes differently stay readable by 1.22.0: dates in arrays and
    arrays of classes, transform dates such as `DateTimeUtcFromString` in any
    container, refs in `many` elements declared as plain classes, and optional
    `NumberFromString` fields. An entity whose primary sort key has composites
    now keeps each item's version and soft-delete history under its own keys
    (below), which 1.22.0 doesn't read correctly: its `versions` and
    `deleted.get` mix siblings' rows with the item's, and its `getVersion` misses
    every version written in the new format.
  - **Keys are unchanged** for every existing entity and aggregate shape: `pk`,
    `sk`, GSI, unique, version, soft-delete, time-series, collection and
    list-index keys are composed byte-for-byte as before, with one exception:
    the version-snapshot and soft-delete keys of an entity whose primary sort
    key has composites (several items per partition) now carry the item's
    identity, so each item has its own history. History written by earlier
    releases stays readable and restorable. Entities without sort key
    composites keep exactly the keys they had. Rows an earlier release keyed
    differently from today's composer (an unpadded number composite written by
    1.15) are still read by queries and scans as they were. Details under
    "History of items that share a partition".
  - **Some attributes change stored type** on their next write, listed under each
    section below. For example, an optional `NumberFromString` holding `5` was
    stored as `{ "N": "5" }` and is now `{ "S": "5" }`, and a nested self date was
    a map (`M`) and is now a string or number. Until old rows are rewritten, a
    filter on such an attribute (a `filter` expression, or a `filterBy` predicate,
    which sees the stored value) can match old and new rows differently, and
    DynamoDB Streams consumers see the attribute change type.
  - **Two model shapes are now rejected at `make()`.** A union whose date member
    is stored as an epoch number next to a member also stored as a number
    (`Number`, a number literal, `BigInt`, another epoch date) fails with
    `EDD-9058`, because a stored number could belong to either member. On an
    aggregate this also covers a `NumberFromString` or `BigIntFromString` member:
    `update` re-decodes the aggregate's domain values, where those are numbers.
    Entities accept those two. Store the date as a string (the default for a self
    date) or remove the numeric member. A `DynamoModel.configure` `storedAs`
    override on a union field with more than one date member fails with
    `EDD-9057`; annotate the intended member instead.
  - **Update and delete errors changed.** A lost version race is now always an
    `OptimisticLockError` carrying the real `actualVersion`, a failed
    `.condition()` is always a `ConditionalCheckFailed`, and an update of a
    missing item is always an `ItemNotFound` (it used to be
    `OptimisticLockError(-1)` for a versioned update with `expectedVersion`).
    Two new errors exist: `ConcurrentModification` and `UpdateAppliedButUnreadable`.
    Don't retry the second one, because the write was applied. Review your
    `catchTag` handlers; the cases that changed are listed under "Updates and
    deletes".
  - **`update()` of a missing item no longer writes a partial row.** It fails
    with `ItemNotFound` and writes nothing, unless it is a plain `.set()` of a
    complete item, which the library creates through `create`. `patch()` still
    fails with `ConditionalCheckFailed` (see below).
  - **Good news if you enabled `versioned` on an existing table.** Items written
    before the entity was versioned read as version 0 on every path, and
    `expectedVersion(0)` addresses them. Their first versioned write conditions
    on no version existing, adds the incarnation token and writes version 1, and
    their retain snapshot is `v#0000000`. A race on that first write is an
    `OptimisticLockError`. Soft delete and restore work on them.
  - **Items whose version was removed are refused.** An item of a versioned
    entity that has the incarnation token (`__edd_i__`) but no version, because
    its version was removed outside the library, fails with a `ValidationError`
    on reads and on the writes that read or check the version, instead of
    reading as version 0. A query over a partition that holds one such item fails
    as a whole. Restore the version attribute to read it again. Items with
    neither (written before the entity was versioned) still read as version 0.
  - **A `put` over an existing item of a versioned or unique-constrained entity
    now reads it first and continues it** instead of resetting it to version 1.
    A concurrent write between the read and the put is retried, so the last
    writer wins as before; only a race lost on every attempt fails, with
    `OptimisticLockError` or `ConcurrentModification`, which the error channel
    gains. `create` doesn't read the item: it must be missing anyway. **A deleted
    retain item can be created again without `purge`**: it continues after the
    version history its key still holds. Details under "Puts, upserts and
    batches".
  - **Transactions and `EventStore` `additionalItems` now replace existing
    versioned and unique-constrained items.** A put there reads the item and
    writes it exactly as the entity's own `put` does, so a versioned read model
    can be kept in step with the events across appends. A taken unique value in
    `additionalItems` is now a `UniqueConstraintViolation`, not an
    `AdditionalItemConditionFailed`: that error is only for a condition you set.
    `Transaction.transactWrite` and `append` (and `commandHandler`) gain
    `OptimisticLockError` and `ConcurrentModification` (a race lost on every
    attempt), and `append` gains `UniqueConstraintViolation`.
  - **A unique sentinel is released only by the item that owns it.** An item can
    hold a unique value without owning its sentinel (the constraint was added
    later, or a `ttl`'d reservation expired and another item claimed the value).
    Every write that releases a sentinel (a put, update or upsert that changes
    the value, a delete, a soft delete, `purge`, a transaction put) now reads it
    first and releases it only if it names this item, so it can no longer delete
    another item's reservation and let the value be taken twice. That costs one
    consistent read per sentinel released.
  - **A hard delete of a retain entity snapshots the item it deletes.** The
    delete and the snapshot of the final state (`v#N`) are one transaction,
    guarded on the version read, so an item created again at the key continues
    at `N + 1` and a writer still holding version `N` can't overwrite it. That
    makes a retain hard delete a `GetItem` plus a two-item `TransactWriteItems`
    (twice the write capacity of a `DeleteItem`) instead of one `DeleteItem`.
    A delete you set no `.condition()` on is read and written again (up to three
    attempts) when another writer changes or deletes the item in between, as a
    put is; this holds for every delete that reads first (retain, unique and
    soft delete), and a delete that loses the item to a concurrent delete
    reports what a delete of a missing item does (success for retain only,
    `ItemNotFound` with unique constraints or soft delete). `deleteIfExists`
    asserts only that the item exists, which these deletes already check: it
    is retried the same way, and on a missing item it fails with
    `ConditionalCheckFailed` (on unique-constraint and soft-delete entities it
    used to fail with `ItemNotFound`; retain-only entities already gave
    `ConditionalCheckFailed`). A `.condition()` added to `deleteIfExists` is now
    ANDed with its existence check instead of replacing it. With any other
    `.condition()`, such a race fails, as before.
  - **`delete().returnValues("allOld")` returns the item it deleted** (the
    model, `undefined` when there was none), on every delete path — it returned
    nothing. The result is typed by the mode (any `ReturnValuesMode` still
    compiles). A mode DeleteItem doesn't support (`"allNew"`, `"updatedOld"`,
    `"updatedNew"`) fails with a `ValidationError` before anything is sent; it
    used to reach DynamoDB, which rejected it (or, through `Entity.returnValues`,
    was dropped). If the deleted item can't be decoded, the new
    `DeleteAppliedButUnreadable` reports it, with the item as stored: the delete
    WAS applied.
  - **Chained `.filter()`s no longer collide.** Each filter was compiled on its
    own, numbering its attribute placeholders from zero, so the second
    overwrote the first's name and the query matched the wrong attribute; they
    are now compiled as one expression.
  - **Projected names need no particular characters.** `select(["first-name"])`
    built the placeholder `#proj_first-name`, which DynamoDB rejects; a name
    that isn't letters, digits and underscores now gets a numbered placeholder.
  - **Collection queries keep their grouping through every combinator.**
    `db.collections.x(...).filter(...).collect()` returned a flat list of
    internal `{ _memberKey, _decoded }` wrappers (it lost the grouping by
    member); it is grouped like `collect()`, and so is `.fetch()`'s page (it
    returned the same wrappers, though typed as grouped). `.paginate()`, which
    streamed the wrappers too, streams each item tagged with its member
    (`{ member, item }`, typed `CollectionStreamItem`), and `CollectionQuery`
    now declares `.select()` (partial records grouped per member), `.count()`,
    `.paginate()`, `.maxPages()`, `.consistentRead()` and `.ignoreOwnership()`;
    `CollectionQuery`, `CollectionStreamItem`, `CollectionSelected` and
    `CollectionAccessors` are exported. A collection
    filter or select names each member's domain fields. A member without the
    field reads it as absent, exactly as before (so `not(...)` and
    `notExists(...)` still match its rows), and an attribute that member
    stores under that name never stands in for it.
  - **A filter can no longer widen an entity's ownership check.** A filter
    whose top level was an `OR` was ANDed with the `__edd_e__` check without
    parentheses (`#eddE IN (:et0) AND a OR b`), so another entity's rows in the
    same partition matched `b` — returned by `collect` (or failing to decode),
    counted, selected. The filter is now parenthesised.
  - **A `.condition()` no longer replaces an op's own guard.** On 1.22.0
    `create`'s not-exists check and `patch`'s and `deleteIfExists`'s exists
    check were held as the op's condition, so a `.condition()` replaced them:
    `create(item).condition(c)` overwrote an existing item whenever `c` held on
    it (`exists(n)`, say); `patch(key).condition(c)` with a `c` that holds on a
    missing item (`notExists(n)`) wrote a partial item and then failed to decode
    it; and `deleteIfExists(key).condition(c)` of a missing item succeeded,
    deleting nothing, whenever `c` held. They are now the op's own guards, ANDed
    with the caller's condition — bound, unbound, in a transaction and in
    `EventStore` additional items — so each of these fails with
    `ConditionalCheckFailed` (`TransactionCancelled` in a transaction) and writes
    nothing. As on every op, a later `.condition()` replaces an earlier one; the
    guard stays. `patch()` of a missing item now fails with
    `ConditionalCheckFailed` on every entity: one whose update reads first,
    such as a retain entity, failed with `ItemNotFound`. The exception is a
    lost race on a versioned entity — the item is deleted between the read and
    the write — which is an `OptimisticLockError`, like every lost version race.
  - **Empty conditions and filters.** On 1.22.0 `.condition({})` (or `and()`)
    sent an empty `ConditionExpression`, or `()` beside the library's guard
    (`… AND ()`), and an empty part under `or()` or `not()` was sent as
    `… OR ()` / `NOT ()`; DynamoDB rejected each with a `DynamoValidationError`,
    as it did an `isIn` with no values (`IN ()`). A condition that asserts
    nothing is now no condition — the op's own guard alone — on put, create,
    upsert, update, patch, delete, `deleteIfExists`, append and transaction ops,
    and an empty part directly under `and()` is left out. Anywhere else — under
    `or()` (it would match everything) or `not()` (nothing), an `or()` with no
    parts, or an `isIn` with no values — it is refused with a `ValidationError`
    before anything is sent, in conditions, entity and collection filters and
    aggregate `list` filters. Two of these are behaviour changes: a filter of
    `or()` with no parts was dropped, so the query matched everything, and an
    aggregate `list` filter of `or()` returned every aggregate; both now fail
    with a `ValidationError`. `.filter({})` is still no filter, and a
    `Transaction.check()` with an empty condition is refused before sending.
  - **`.consistentRead()` on a GSI is refused before sending.** DynamoDB reads
    a global secondary index only eventually consistently, and rejected the
    request with a `DynamoValidationError`; an entity index query or a
    collection with `.consistentRead()` now fails with a `ValidationError`
    without sending it. The table is read consistently, as before. An entity's
    indexes are always treated as GSIs (`db.tables.*.create()` creates them as
    GSIs), so one pointed at an LSI of a table created outside the library is
    refused too.
  - **`expectedVersion` on an entity that isn't `versioned` is refused
    (behaviour change).** On 1.22.0 a plain `update`, a `patch` and the unbound
    `Entity.expectedVersion` silently ignored it, so the update ran with no
    concurrency check at all; an update that read first (a unique-field change)
    compared it against the missing version and failed with
    `OptimisticLockError`. It now fails with a `ValidationError` before anything
    is read or sent. Add `versioned: true`, or use a `.condition()`.
  - **`Query.asParams` can fail, and `compileExpr` can throw (type-level
    change).** `asParams` now declares `ValidationError` (it declared `never`):
    it fails, as the query would, for a filter with an empty part under `or()` /
    `not()`, an `or()` with no parts or an `isIn` with no values — on 1.22.0 it
    returned params DynamoDB then rejected or, for an `or()` with no parts,
    silently dropped the filter, so the query matched every row. The exported
    `compileExpr` throws on those same expressions instead of compiling them to
    `… OR ()`, `NOT ()`, `IN ()` or an empty string.
  - **Bound queries filter and select renamed fields by their stored names.** A
    field renamed with `DynamoModel.configure(..., { field })` was projected and
    filtered under its domain name, so `select(["name"])` returned `{}` and
    `filter({ name })` matched nothing; they now use the stored attribute and
    hand items back under the domain names. On a collection whose members store
    one field under different names, a filter is judged per member and a select
    reads each member's own attribute.
  - **A transaction that touches one item twice, or passes DynamoDB's 4 MB, is
    refused before it is sent**, with a `ValidationError` naming the entity, in
    `Transaction.transactWrite` and `EventStore.append`. The items an op adds
    count: two puts that swap unique values touch the same sentinels, and a
    retain put counts twice (its item and its snapshot).
  - **Primary-key queries and scans no longer return history rows.** Version
    snapshots, soft-delete tombstones and time-series event items carry their
    entity's type, so a primary-key query with no (or a partial) sort key
    condition, a scan, and a collection on the primary key returned them as if
    they were items (a time-series partition query failed to decode its events).
    They're now left out. A row is left out only when it is positively history:
    its sort key is not the one its own stored composites compose AND it has the
    layout of a snapshot (`#v#…<version>`), a tombstone (`#deleted#…<timestamp>`)
    or an event (`#e#` under the live key). Every other row is read as before —
    including rows an earlier release keyed in a way the current composer
    doesn't reproduce (an unpadded number composite written by 1.15). This runs
    on the rows as they arrive, for queries and scans alike, so a projection
    also reads the sort key and its composites. `limit` is still sent as
    `Limit` on the first request, and each later request asks for twice the
    last, so a run of history rows costs requests logarithmic in its length;
    `maxPages` still bounds requests, so a capped query can return fewer items
    than `limit` when rows are left out. `.history()` still reads
    events. A primary-key `count()` of a retain, soft-delete or time-series
    entity reads the sort key and composites of each row to count them (the
    same read capacity as a server-side count), not whole items.
  - **`purge` removes only its own entity's rows.** It deleted every row in the
    partition, so with a collection on the primary key, purging an order also
    deleted its lines. It now deletes only rows of its own entity type.
  - **`Batch.write` sends puts of a `versioned` entity as transactions.** They go
    first, as create-only `TransactWriteItems` of up to 100 items (and under
    DynamoDB's 4 MB transaction payload), and each chunk costs twice the write
    capacity of a batch write. A put that would replace an existing item fails
    with a `ValidationError` and writes nothing from its chunk. Earlier chunks
    may already have been written, because `Batch.write` was never atomic across
    chunks. A batch that touches a versioned put's item more than once (a
    delete and a put of it, or two puts) is refused before anything is written,
    since the put runs in its own transaction and the order couldn't be kept.
  - **More updates are refused with a `ValidationError`**: a `.set()` that changes
    a primary-key composite (silently ignored before), a `.set()` that changes an
    immutable field (restating its current value is fine), and the path
    operations on index composites and unique fields listed under "Updates and
    deletes".
  - **`returnValues` is honoured, and typed by its mode.** `"none"` now returns
    `undefined` and `"updatedOld"` / `"updatedNew"` return a partial of the
    attributes written, on every update path. A retain update with `"allOld"`
    now returns the replaced item rather than the new one.
  - **Two new hidden attributes.** Versioned entities get `__edd_i__`, set on
    create and added to existing items on their next guarded write. An item whose
    unique field holds only a decoding default that is also an index composite
    gets `__edd_d__`, a string set naming those fields. Decoded models never
    include either, but raw readers, `asNative` and DynamoDB Streams consumers
    will see them.
  - **Writes are validated more strictly**, so some calls that used to succeed
    now fail with a `ValidationError`. Container `.check()` refinements on an
    array, a struct or a checked-struct class that holds a date or another
    substituted value were silently dropped, and are now enforced on every write
    (entities and aggregates; details below). Entity path updates are now
    validated like `.set()`, so a literal outside its set or a string under its
    `minLength` is rejected instead of stored. Reads don't enforce the container
    checks, so existing rows that break them still read. On an aggregate, though,
    such a row refuses every `update` until that same update makes the value
    valid; an entity `.set()` on other fields still succeeds on it.
  - **A canonical ISO string in a string member reads as a date.** In
    `Schema.Union([Schema.DateTimeUtc, Schema.String])`, the exact ISO form the
    library writes for a date (`"2000-01-01T00:00:00.000Z"`) reads back as a
    `DateTime`, even if it was written as a string. Other strings (`"2020"`, `"5"`,
    `"hello"`) stay strings. If a string field may hold ISO instants, use a tagged
    or discriminated shape.
  - **No backfill is performed.** Old rows read correctly as they are, and are
    rewritten in wire form when they are next written. For an aggregate that
    means the next `update` that changes the row's group (the root item or its
    sub-aggregate); an update that changes nothing writes nothing.
  - **Values that were lost stay lost.** A domain object with no enumerable state
    was stored as a map holding no value: a `Schema.Date` (`{M:{}}`), a `URL`, a
    `Duration`, a `BigDecimal`. These cannot be recovered, and reading them fails
    with a `ValidationError`.
  - **Nested sub-aggregates written by earlier versions are not read.** Rows below
    the first sub-aggregate level used different keys, and never read back
    before. Recreate those aggregates.

  ### Aggregates

  **`create` of an existing aggregate fails (behaviour change).** `create`
  wrote plain `Put`s, so creating an aggregate whose root item already existed
  silently overwrote it — and left the old aggregate's edge and sub-aggregate
  rows that the new one didn't rewrite. The root item is now written first, in
  the first transaction, conditioned on `attribute_not_exists`. An existing
  aggregate cancels that transaction, so nothing is written, and `create` fails
  with `ConditionalCheckFailed` (`entityType` is the root's, `key` its `pk` and
  `sk`). Edge and sub-aggregate rows carry no guard of their own; they are only
  written after the root's transaction commits. As before, each sub-aggregate is
  its own transaction: if a later one fails, the earlier ones stay written.
  Replace an existing aggregate with `update`, or `delete` it first. The guard
  sees the root only: edge rows left without a root (an earlier write that
  failed partway) don't stop `create`, and `get` reads them back merged with the
  new rows — `delete` the key first, which removes every row in the partition.

  **`delete` no longer leaves rows behind under throttling.** It ignored the
  `UnprocessedItems` DynamoDB returns from `BatchWriteItem`, so a throttled
  delete succeeded with rows still stored. They are retried with exponential
  backoff, as `Batch.write` retries them (up to 5 retries), and a `delete` that
  still can't remove them fails with a `DynamoError` saying how many remain.

  **Writes.** Aggregates now store every value in its wire form wherever it is
  nested: in root arrays (`Schema.Array(Schema.DateTimeUtcFromString)`), arrays of
  classes (`sessions[].startTime`), `NullOr` and other unions (also inside
  arrays), records, tuples, refs hydrated into `one` / `many` items
  (`player.dateOfBirth` on a `MatchPlayer` item), and edges declared without an
  `entity`. Before, only a field whose own schema was a transform was encoded.

  **Reads.** Date maps written by earlier versions are rebuilt into real
  `DateTime` values, whichever type-id key they carry; `Zoned` values keep their
  named or offset zone. An optional `BigIntFromString` and a plain `Schema.BigInt`
  stored as a number, which could not be read back at all, now read as a `bigint`.

  **Stored-type changes.** A top-level `Schema.optional(...)` or `Schema.NullOr(...)`
  around a non-date transform (such as `NumberFromString` or `BigIntFromString`),
  on the root item, an edge item or a `many` element's own fields, is now stored
  encoded rather than in its domain form. So is a `NumberFromString` nested inside
  a hydrated ref, and a self date inside a union, record or tuple.

  **Now working.** None of these worked on 1.22.0:
  - A ref in a `many` element, declared as `player: Player.pipe(DynamoModel.ref)`
    (it could not be read back even after a fresh write) or as the element itself,
    `Schema.Array(Player.pipe(DynamoModel.ref))` (`update` failed). The plain
    class `player: Player`, matched by name to the edge's entity, also
    round-trips.
  - `update`, even one that changed nothing, on models with unions, records or
    tuples around transforms (it failed with `Expected string`).
  - Unions that mix a date with another type, such as
    `Schema.Union([Schema.DateTimeUtcFromString, Schema.Number])` (`create`
    threw). Each value is now stored and read by the member it belongs to.
  - `create` input carrying a `DateTime`, an `Option` or another Effect value on
    an aggregate with a ref edge. The input was copied with `structuredClone`,
    which stripped those values, so they were rejected. Cyclic input is handled
    too.
  - A nested field that shares a name with a root ref edge (a `coach: Schema.String`
    inside an array, next to a root `coach` edge). Refs are now resolved by field
    schema, so it is no longer decoded as that edge's entity.

  **Container checks.** `create` and `update` enforce `.check()` refinements on
  arrays, structs and checked-struct classes that hold a date or another
  substituted value; earlier versions silently dropped them. A violating value
  fails with a `ValidationError`. Reads don't enforce them, so a stored row that
  breaks one still assembles. Every `update` of that aggregate fails until the
  same update makes the value valid, which repairs the row.

  **Known limitation.** A `many` edge with a custom `decompose` that renames
  element fields still stores the renamed values in their domain form, so a
  `DateTime` there is written as a map. Those values do read back as real
  `DateTime`s.

  ### Entities

  **Self dates in containers.** A self date inside a `NullOr` or other union, a
  nullable class (`NullOr(Stamp)`), an array of a union (`Array(NullOr(date))`), a
  `Record` value, or a `Tuple` / `TupleWithRest` / `StructWithRest` was stored as
  a `DateTime` map. It is now stored in its wire form (a number where `storedAs`
  says so), and existing map rows read back as real `DateTime`s. A
  `DynamoModel.configure` `storedAs` override on a union field now applies to its
  date member. Transform schemas such as `DateTimeUtcFromString` already stored
  their wire form and are unchanged. A `TupleWithRest` field is also no longer
  mis-derived as an array.

  **Container checks.** `.check()` refinements on arrays, structs and
  checked-struct classes that hold a date or another substituted value were
  silently dropped. They are now enforced on every write: `put`, `create`,
  `update` and `.set()`, path operations, `.append()`, Batch and Transaction. A
  violating value fails with a `ValidationError`. Reads don't enforce them, so
  existing rows that break one still read.

  **Path updates.** `pathSet`, `pathAppend`, `pathPrepend`, `pathIfNotExists` and
  the record-based `.append()` (including on versioned entities that retain
  snapshots) now encode their value through the schema at the path, as `.set()`
  does. Before, they wrote the raw value: a `DateTime` became a map even on a
  plain date field, and a `NumberFromString` value was stored as a number. Now:
  - A plain object on a class-typed field is encoded as that class, and a class
    instance is always encoded whole.
  - A plain object or array that mixes wire and domain parts, or holds an
    ambiguous wire part, is encoded part by part, so every `DateTime`, `Date` and
    `Redacted` inside it is stored in wire form.
  - A value already in wire form is normalised the way `.set()` normalises it:
    `NumberFromString` `"05"` is stored as `"5"`, `DateTimeUtcFromString`
    `"2000-01-01"` as `"2000-01-01T00:00:00.000Z"`, and a `Schema.Trim` field
    stores its trimmed form. Read-back values are identical; only the stored
    bytes differ, which filters and Streams consumers will see.
  - A value passes through as given only if it genuinely decodes as the wire form
    of a leaf transform with a primitive wire form AND is also a valid domain
    value, such as `"aGk="` on a `StringFromBase64` field; encoding it would
    double-encode it. A plain string that isn't valid wire (`"hi"`) is a domain
    value and is encoded.
  - Path values into and under a top-level `DynamoModel.ref` field are encoded
    through the ref target's model, like any other path. Only a path no schema
    describes (such as one under a dynamic key of an untyped value) is written as
    given.
  - A value set by path into a class that has lost its fields (one built with
    `.check()` or `.annotate()`, or a `DynamoModel.ref` nested inside a ref
    target) is written as given, in the same form `put` stores it, so the item
    stays readable.
  - Path values are validated like `.set()`, so an invalid value (a literal not
    in the set, a string under `minLength`, a broken container check) fails with a
    `ValidationError` instead of being stored. A key whose value is `undefined`
    is dropped before validation, as it is when stored. List `append` and
    `prepend` validate each element, but can't enforce list-level checks such as
    `maxLength`, because DynamoDB builds the list server-side. An append can
    therefore take a list past such a check. For a list whose check is enforced
    on read (any array holding no date or other substituted value), the item then
    fails to decode on the update's returned item and on every later read. Guard
    such lists with a condition on their size, e.g.
    `.condition((t, { lt }) => lt(t.tags.size(), 2))`, or use `.set()` with the
    full list. This is not new in this release.

  `ADD`, `DELETE` and `SUBTRACT` are unchanged.

  **Path updates on retain entities.** Path operations (`pathSet`,
  `pathAppend`, `pathPrepend`, `pathIfNotExists`, `pathAdd`, `pathSubtract`,
  `pathDelete`, `pathRemove`) on entities with `versioned: { retain: true }` were
  silently ignored: they returned success and wrote nothing. They are now sent to
  DynamoDB as the same update expression used for other entities, in one
  transaction with the version snapshot of the item they replace, so they behave
  exactly as DynamoDB defines: list indexes refer to the item before the update,
  a copy reads the old value, overlapping paths and appends to a missing list are
  rejected, and a rejected update writes no snapshot. `expectedVersion` and
  `.condition()` apply. One update cannot combine path operations with a change
  to a unique-constraint field or a computed change to an index composite; it
  fails with a `ValidationError`, so split it into two updates.

  **Legacy values read back.** The raw values earlier path updates left on
  transform fields now read: a number on a `NumberFromString` field, a
  safe-integer number on a `BigIntFromString` field, a `DateTime` map on a date
  transform. A plain `Schema.BigInt`, stored as a number, now reads back as a
  `bigint`.

  **Known limitation.** Plain dates inside a class that has lost its fields (see
  above), including whole-value `put`, `.set()` and `pathSet` of that class, are
  still stored as maps, as on 1.22.0, and read back as plain objects.

  **Zoned dates.** A zoned date with an offset zone (`+05:00`) now reads back
  with that offset, for both `DynamoModel.DateTimeZoned` and a self
  `Schema.DateTimeZoned`, on entities and aggregates; earlier versions read it
  back as UTC. Named zones and UTC round-trip as before, and the stored form is
  unchanged. Known limitation, as in earlier versions: an offset that isn't a
  whole minute (a historical local-mean-time offset, a sub-minute
  `zoneMakeOffset`) is rounded to the minute by Effect's ISO format, and the
  instant read back moves by the same amount.

  ### Updates and deletes

  **Path operations on index composites and unique fields.** A top-level
  `pathSet` of a value or `pathRemove`, and a numeric `pathAdd` or
  `pathSubtract`, on an index composite or unique field now recompose the keys
  and rotate the unique sentinels exactly as `.set()`, `.remove()`, `.add()` and
  `.subtract()` do. Operations whose result DynamoDB computes at write time
  (copies, `pathIfNotExists`, list and set operations) on such a field, paths
  below such a field, any path operation on a primary-key composite or an
  immutable field, and two operations on the same such field are rejected with a
  `ValidationError` naming the field. An update can't combine path operations
  with a change to a unique field or a computed change to an index composite;
  split it into two updates. `.add()`, `.subtract()`, `.append()` and
  `.deleteFromSet()` on an index composite now recompose the index key on every
  entity.

  **Error mapping.** On every update path a lost version race is an
  `OptimisticLockError` with the real `actualVersion`, a failed `.condition()` is
  a `ConditionalCheckFailed`, and a missing item is an `ItemNotFound`. Three cases
  used to be the other way round:
  - A versioned update with `expectedVersion` and a `.condition()` reported a
    failed condition as `OptimisticLockError(-1)`.
  - A retain update with a `.condition()` did the same.
  - A retain path update with a `.condition()` reported a lost version race as
    `ConditionalCheckFailed`.

  **Guarded read-then-write.** Updates that read the item first (a unique-field
  change, a computed change to an index composite, any retain update) write a
  guarded update of only what changed. A concurrent change to an unrelated
  attribute is preserved. A race on something the update read fails without
  writing: with the new `ConcurrentModification` on an unversioned entity, and
  with `OptimisticLockError` on a versioned one. Soft delete, and a hard delete
  of an entity with unique constraints or `retain`, are guarded the same way;
  with no `.condition()` such a delete reads the item again and is retried. `restore` fails with
  `ItemNotFound` if a concurrent restore won, and with `ItemNotDeleted` if a live
  item exists under the key.

  **Wide items.** An unversioned soft delete is never refused for width. When
  the full guard can't fit DynamoDB's condition limits (4 KB and 300 operators,
  counted on the actual condition including your `.condition()`), it falls back
  to the strongest guard that fits: the item exists, `updatedAt` is unchanged
  (with timestamps), then as many attributes as fit, unique-constraint fields
  first. With timestamps, that detects any concurrent library update except one
  in the same millisecond with an identical `updatedAt`. A writer outside the
  library that leaves `updatedAt` alone can change unguarded attributes
  undetected. Without timestamps, only the guarded attributes are protected. An
  update too wide for one expression writes the whole item, under the version
  condition (versioned) or the same fallback guard (unversioned). A concurrent
  write from outside the library to an attribute the guard doesn't cover is lost,
  which is also what 1.22.0 did for every such update. A `.condition()` too large
  to fit beside the guard fails before writing with a `ValidationError` stating
  its size. Operators are counted as DynamoDB counts them: in a condition, each
  comparison, `AND` / `OR` / `NOT`, `IN` and each function, with `BETWEEN`
  counted once (its own `AND` is part of it); in an update expression, each `+`,
  `-` and function, but not a `SET` clause's `=`.

  **Incarnation token.** Versioned entities carry a hidden `__edd_i__` attribute,
  set on create and backfilled on the next guarded write. It is never in decoded
  models (only in `asNative`). Version-checked writes require it, so an item
  deleted and recreated — at the same version on an entity without `retain`, or
  by a writer outside the library — is never mistaken for the original. (A
  retain item the library creates again continues after its retained history, so
  it never repeats a version.)
  An item that has the token but no version had its version removed outside the
  library. It is refused with a `ValidationError` rather than read as version 0,
  which would let the next update rewrite its history: by every read (`get`,
  queries, the `deleted` views, `decodeMarshalledItem`), and by every update,
  soft delete, hard delete of an entity with unique constraints or `retain`,
  `restore`, versioned `put` and `upsert`. A query over a partition holding one
  fails as a whole. A plain hard delete (no unique constraints, no `retain`) still
  removes it, since it reads nothing and writes no history; `purge` removes it on
  any entity.

  **Version history is never overwritten.** An update, soft or hard delete,
  restore or replacing `put` that would write a `v#N` snapshot holding a different state
  from the row already there fails with a `ValidationError` and writes nothing.
  Rewriting the same state (the same version, incarnation and, with timestamps,
  `updatedAt`) is allowed, which is what the first update after a retain `put`,
  and a restore, do. A write from outside the library that changes an item
  without bumping its version can still be captured into the next `v#N`
  snapshot.

  **Retain return values.** A retain update returns exactly the item it wrote,
  even if another writer has replaced it since. If that can't be proven, it fails
  with the new `UpdateAppliedButUnreadable`: the write WAS applied, so don't
  retry. `allOld` returns the replaced item; on record and unique-field retain
  updates it used to return the new one.

  **`returnValues` on every update path.** `"none"` returns `undefined`,
  `"updatedOld"` / `"updatedNew"` return only the top-level attributes written as
  a partial, and `"allOld"` / `"allNew"` return the whole item. The result type
  follows the mode (`UpdateReturn` is exported), and repeated
  `Entity.returnValues` calls are typed by the last one. A cascade with `allOld`
  or `updatedOld` cascades exactly what this update wrote; combined with path
  operations on an unversioned entity it is refused.

  **`update()` of a missing item** no longer leaves an undecodable partial row.
  A plain update requires the item to exist. If it's missing and the update is a
  plain `.set()` of a complete item (every required field and primary-key
  composite; a field with a decoding default doesn't count as required) with no
  other operations, `expectedVersion`, `.condition()`, cascade, `withVector` or
  old-image `returnValues`, the library creates it through `create` with the same
  payload, so the item is exactly what `put` writes. If another writer creates it
  in between, the update re-runs once on that item. Anything else fails with
  `ItemNotFound` and writes nothing, as do retain entities and updates that read
  first (a unique-field change and the like). `patch()` of a missing item fails
  with `ConditionalCheckFailed` on every path, except a lost race on a versioned
  entity (the item deleted between the read and the write), which is an
  `OptimisticLockError`.

  **Decoding defaults.** Fields with `Schema.withDecodingDefault` now survive on
  read: a `put` that omitted one used to write the item and then fail with a
  `ValidationError`. A defaulted `DateTimeUtc` is stored as an ISO string. A
  defaulted primary-key or index composite that a write omits is stored with its
  default, and keys are composed from it. Other defaulted fields are still not
  stored, and the default is applied on read.

  A default never creates a unique-constraint sentinel. A defaulted unique field
  that is also an index composite is stored and indexed, and is listed in a hidden
  string-set attribute, `__edd_d__`, which never appears in decoded models. It
  gets its sentinel only when a write supplies its value. A `.remove()` of a
  defaulted index composite stores the default again and keeps the item indexed
  under it; on a unique field it releases the old value's sentinel and creates
  none for the default.

  **`.set()` refusals.** A `.set()` of a changed primary-key composite is refused;
  it was silently ignored before. An immutable field can be restated with its
  current value, so spread records work; a different value is refused.

  **Known limitations.** Both are inherent:
  - On unversioned entities, nothing can prove an unguarded attribute unchanged.
    So the item a unique-field update returns may show stale values for
    attributes it neither reads nor writes, wide items use the fallback guard
    above, and the whole-item write of a wide update can overwrite writers
    outside the library. Use `versioned` where that matters.
  - A plain `.expectedVersion(n)` can't detect a delete-and-recreate that has
    climbed back to version `n` on an entity without `retain`: its versions
    restart at 1, so it takes `n − 1` updates after the recreate.

  ### Puts, upserts and batches

  **Replacing puts.** A `put` of a versioned or unique-constrained entity reads
  the item first. Over an existing item it continues that item: it takes the
  next version, keeps the same incarnation and `createdAt` (unless the input
  supplies one; unique-only entities keep `createdAt` too), writes a retain
  snapshot of the item it replaces, and rotates the unique sentinels of changed
  values. It never resets the item to version 1 or orphans a sentinel. The write
  is guarded by what it read; a put replaces the whole item, so when another
  writer creates, changes or deletes it in between, the put reads it again and
  retries, and the last writer wins. A race lost on every attempt fails with
  `OptimisticLockError` (versioned) or `ConcurrentModification` (unversioned) and
  writes nothing. A soft-deleted item counts as missing. `create` no longer reads
  the item first; it still fails with `ConditionalCheckFailed` on an existing
  item. A retain `create` runs one `Limit 1` query of its version history, and,
  when the primary sort key has composites, a second, keys-only `Limit 1` query
  for history an earlier release wrote (and reads that history only if it finds
  some).

  **Re-creating a deleted retain item.** Its version history outlives it, and
  the key can be used again without `purge`. Deleting it, hard or soft, snapshots
  its final state at its own version in the same transaction (1.22.0 wrote no
  snapshot on a hard delete). A `put`, `create`, `upsert` or transaction put of
  the missing item reads the highest version retained for its key and continues
  after it, with a new incarnation token: an item deleted at version 3 comes back
  at version 4 with its own `v#0000004` snapshot, and the earlier history is never
  overwritten. A writer still holding version 3 fails with `OptimisticLockError`.
  `restore` of the old tombstone while the new item is live fails with
  `ItemNotDeleted`. A hard delete of a missing retain item writes nothing, as
  before; with a `.condition()` the condition is judged against no item, and the
  delete never removes an item created since its read.

  **Sentinel ownership.** A sentinel is released only by the item that owns it
  (`_entity_pk` / `_entity_sk`): the write reads it first and conditions the
  release on that ownership. A release whose reservation changed hands in
  between fails an update, or a delete with a `.condition()`, with
  `ConcurrentModification` on the unique fields; a put, an `upsert`, a
  transaction put and an unconditioned delete plan the write again from a
  fresh read (up to three attempts, then `ConcurrentModification`). `purge` releases the sentinels of the live item and of
  every tombstone, each only if owned. Each sentinel a write would release costs
  one consistent `GetItem`. An update that changes the value of a unique
  constraint with a `ttl` now gives the new sentinel that expiry, as a put does
  (it was written without one).

  **`upsert` that reads first.** One `UpdateItem` can't write, rotate or check a
  sentinel, or snapshot the item it replaces, so `upsert` of an entity with
  unique constraints or `versioned: { retain: true }` reads the item once first.
  (A retain entity's upsert used to write no snapshot at all.) A missing item is
  created with its sentinels and snapshot. An existing item is updated from that
  same read: sentinels rotate for changed unique values and are left alone for
  unchanged ones, the replaced item is snapshotted, under the update's version
  and incarnation guards (versioned) or attribute guards (unversioned). The whole
  input is validated either way, so an `upsert` missing a required field fails
  with a `ValidationError` even when the item exists. A concurrent create or
  delete in between is retried the other way, and a sentinel release whose
  reservation changed hands is planned again from a fresh read, as a put's is; a
  concurrent change of the item itself fails the upsert, as it fails an update.
  A race lost on every attempt fails
  with `OptimisticLockError` or `ConcurrentModification` (never a
  `ConditionalCheckFailed` you didn't ask for), and a value another item holds
  with `UniqueConstraintViolation`. Its errors name the `upsert`. An `upsert`
  whose input omits a defaulted index composite also reads first: it stores the
  default only when it creates the item and keeps the stored value otherwise, on
  every entity (a plain upsert used to overwrite the stored value with the
  default). Other upserts are a single `UpdateItem`, as before.

  **Transactions.** In `Transaction.transactWrite` and `EventStore`
  `additionalItems`, a `put` of a versioned or unique-constrained entity is
  written exactly as the entity's own `put` writes it: the item is read, a
  replaced item continues its version, incarnation and `createdAt` and is
  snapshotted, changed sentinels rotate (releasing only owned ones), and a
  re-created retain item continues after its history — all in the one
  transaction. A race between the read and the transaction cancels it, and it is
  built and written again. A taken unique value is a `UniqueConstraintViolation`
  from both; only an op's own condition is `TransactionCancelled` from
  `transactWrite` and `AdditionalItemConditionFailed` from `append`.

  Both are checked before anything is sent. DynamoDB allows one operation per
  item in a transaction, and the reasons it gives for a repeated item can read as
  a lost race, so the transaction was retried and misreported (as
  `OptimisticLockError`, or a `DynamoValidationError`, depending on the backend).
  Now any item touched twice, counting the sentinels and snapshots an op adds
  (two puts that swap unique values touch the same sentinels), fails with a
  `ValidationError` naming the entity and both ops, and nothing is sent. So does
  an `additionalItems` op that repeats an event or the idempotency sentinel of the
  append. A transaction whose items pass DynamoDB's 4 MB (4,194,304 bytes) fails
  with a `ValidationError` naming its largest item, instead of DynamoDB's bare
  `ValidationException`. The size is a lower bound by DynamoDB's item-size rules
  (numbers count a byte per two significant digits, plus one, and zero one byte;
  list and map overheads aren't counted; an update counts only its key; a retain
  put counts twice), so a transaction DynamoDB would accept is never refused. Deletes of `unique`, retain and `softDelete` entities
  are still refused (`EDD-9048`), and `Batch.write` still sends versioned puts as
  create-only transactions (below).

  **Error channels.** Compared with 1.22.0, these operations declare new errors.
  Review `catchTag` handlers and exhaustive matches on them:

  | Operation                               | New in its error channel                                                                                                |
  | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
  | `put`, `create`                         | `OptimisticLockError`, `ConcurrentModification`, `TransactionOverflow`                                                  |
  | `upsert`                                | `UniqueConstraintViolation`, `OptimisticLockError`, `ConcurrentModification`, `TransactionOverflow`                     |
  | `update`, `patch`                       | `ConcurrentModification`, `UpdateAppliedButUnreadable`, `TransactionOverflow`                                           |
  | `delete`, `deleteIfExists`              | `OptimisticLockError`, `ConcurrentModification`, `ValidationError`, `TransactionOverflow`, `DeleteAppliedButUnreadable` |
  | `restore`                               | `ItemNotDeleted`, `TransactionOverflow`                                                                                 |
  | `Transaction.transactWrite`             | `OptimisticLockError`, `ConcurrentModification`                                                                         |
  | `EventStore` `append`, `commandHandler` | `UniqueConstraintViolation`, `OptimisticLockError`, `ConcurrentModification`                                            |
  | Aggregate `create`                      | `ConditionalCheckFailed`                                                                                                |

  `TransactionOverflow` could already be raised when an item's own transaction
  would pass 100 items; it is now declared. `GeoIndex.bind`'s `put` declares the
  errors the entity's `put` raises.

  **`Batch.write` of a `versioned` entity.** Its puts are sent first, as
  create-only `TransactWriteItems` of up to 100 items, each conditioned on
  `attribute_not_exists`; a chunk also closes before it would pass DynamoDB's
  4 MB transaction payload. There is no read, so there is no race window. A batch
  that touches a versioned put's item more than once is refused with a
  `ValidationError` before anything is written. A put
  that would replace an existing item cancels its whole chunk, so nothing in that
  chunk is written, and fails with a `ValidationError`. Earlier chunks may
  already have been written, since `Batch.write` was never atomic across chunks,
  and the batch's other requests aren't sent. Each chunk costs twice the write
  capacity of a batch write. Contention cancellations (`TransactionConflict`,
  throttling) are retried with the batch's backoff settings; any other
  cancellation is a `DynamoError` that keeps each reason's message and the SDK
  exception. Puts of other
  entities, and deletes, are still plain `BatchWriteItem` requests.

  ### History of items that share a partition

  An entity whose primary sort key has composites keeps several items in one
  partition. Their version snapshots and soft-delete tombstones used to share one
  key space (`$app#v1#line#v#0000001`, `$app#v1#line#deleted#<timestamp>`), so
  siblings shared one version sequence, a second item's history collided with
  the first's, `deleted.get` and `restore` found the partition's latest
  tombstone rather than the item's, and `purge` removed every sibling. Each item
  now has its own: its history keys carry the composite part of its sort key
  after the marker (`$app#v1#line#v#line_a#0000001`,
  `$app#v1#line#deleted#line_a#<timestamp>`), and `versions`, `getVersion`,
  `deleted.get`, `restore`, the version a re-created item continues from, and
  `purge` all key by the item. `deleted.list` still lists the partition's
  tombstones, every item's. An entity without sort key composites writes and
  reads exactly the keys it did.

  History an earlier release wrote for such an entity keeps its old keys and
  stays readable. A row under the partition-wide keys belongs to the item whose
  key its stored composites compose, and every reader of one item's history
  reads those rows too: `versions` and `getVersion`, `deleted.get` and `restore`
  (which restores from such a tombstone and consumes it), `deleted.list`, the
  version an item created again continues from, and `purge`. A version held both
  ways is read from the item's own row; of two tombstones, the later one wins.
  Reading it costs one keys-only `Limit 1` query of the partition's unsegmented
  range, per `versions`, `deleted.get`, `restore` and `create` (and per
  `getVersion` that misses the item's own key: one more `GetItem`); only when that
  finds a row is the range read in full. `versions` then reads the partition's
  history (and filters it, after one more keys-only query of the item's own
  range); otherwise it reads the item's own range.

  ### Nested sub-aggregates

  A sub-aggregate bound inside another sub-aggregate now works end to end
  (`create`, `get`, `list`, `update`, `delete`). Before, it was written but failed
  to read (`Missing key at ["club"]["squad"]`). The nested level inherits its
  parent's discriminator, its sort keys are prefixed with the parent's
  discriminator values, and it is its own transaction group, so `update` rewrites
  only the inner group that changed. Sub-aggregates bound directly on the root
  keep their keys.

  A nested binding that reuses a discriminator attribute it inherits from its
  parent (`{ clubNo: 9 }` inside `{ clubNo: 1 }`) would overwrite the parent's
  value on the inner rows. `Aggregate.make` now rejects it with `EDD-9056`.

  Fixes [#133](https://github.com/jmenga/effect-dynamodb/issues/133).

## 1.22.0

### Minor Changes

- [`573d567`](https://github.com/jmenga/effect-dynamodb/commit/573d5674c766c279c482db15e55d057470a4d98d) Thanks [@mixja](https://github.com/mixja)! - `EventStore.makeStream` accepts `casing`, the stream's key casing — the same option, with the same values, that indexes and vector indexes already take. Set, the stream name, stream ids and command ids in the stream's keys all take that casing (the `$<schema>#v<n>` prefix keeps the schema's). Omitted, the stream keeps the layout it has always had: name lower-cased, the rest following the schema. Setting `casing` on a stream that already holds data moves its keys whenever they come out different (e.g. `"preserve"` with a capitalised `streamName`), so its history is no longer read. The `__edd_e__` discriminators stay lower-cased. In the next major, omitting `casing` will mean the schema's casing.

  Index-level `casing` now works on GSIs. `indexes.<name>.casing` was accepted by the types but dropped during normalization, so GSI keys silently used the schema's casing (`primaryKey.casing` always worked). It now overrides the schema's casing for that index on every path — put, query accessors, `.where()` operands, policy-aware updates and collection queries. Collection members must agree on the collection index's casing; a mismatch fails at `DynamoClient.make()` / `Collection.make()` with `EDD-9055`. **If you had set `casing` on an `indexes` entry**, items written by earlier versions carry schema-cased keys for that index and won't be found through it until rewritten. Time-series event SKs keep using the schema's casing for the `#e#` suffix even under a `primaryKey.casing` override, so existing event items stay readable.

  The language-service hover tooltips now show the keys the library actually writes — attribute-name prefixes, cased composite values, padded numbers, GSI `casing`, the `"isolated"` collection default and the `begins_with` delimiter rule — and a parity test pins them to `@effect-dynamodb/schema`. The docs playground now composes keys with `@effect-dynamodb/schema` directly.

  Docs: the `casing` option is described as casing composite values too (it always has), with a warning — now also on the home page, getting-started guide, starter tutorial and both READMEs — that ids differing only by case share a key, that `casing` is part of the storage format, and which fixed key markers (`v1`, `#v#`, `#deleted#`, `_1`) are never cased. Tests pin those markers.

## 1.21.0

### Minor Changes

- [`e1b5f0d`](https://github.com/jmenga/effect-dynamodb/commit/e1b5f0d311195c200215e2f7d366bd167ac65f5b) Thanks [@mixja](https://github.com/mixja)! - Require Effect 4.0.0 (stable). The `effect` peer dependency moves from `^4.0.0-rc.112` to `^4.0.0`, so pre-release builds of Effect no longer satisfy it. Consumers on an Effect 4 release candidate should upgrade to `effect@4.0.0` and apply the GA renames that affect application code: `Config.string`/`Config.int` → `Config.String`/`Config.Int`, `SchemaGetter.transformOrFail` → `SchemaGetter.transformEffect`, and `effect/unstable/http` / `effect/unstable/httpapi` → `effect/http` / `effect/http-api`. Tests built on `@effect/vitest@4.0.0` need vitest 5. The language-service plugin now compiles with TypeScript 6 and its emitted output is unchanged.

## 1.20.1

### Patch Changes

- [`66427e2`](https://github.com/jmenga/effect-dynamodb/commit/66427e21a97634988b9e4adc99945b9b3b9008d2) Thanks [@mixja](https://github.com/mixja)! - Fix the lifecycle paths that read a stored row by domain field name ([#127](https://github.com/jmenga/effect-dynamodb/issues/127))

  A row read back from DynamoDB is keyed by its **stored attribute** name, but key
  composition and unique-sentinel composition name **domain** fields. Under a
  `DynamoModel.configure(Model, { id: { field: "widgetId" } })` rename the two
  differ, and two families of bugs followed.

  **Soft-delete reads and `restore`** never applied `renameFromDynamo`:
  `deleted.get` and `deleted.list` decoded an attribute-keyed row against the
  domain-keyed `deletedRecordSchema` and failed with
  `ValidationError` ("Missing key"), while `restore` composed keys from it and died
  with a **defect** out of `KeyComposer.extractComposites`. Any entity with both
  `softDelete` and a renamed field could write a tombstone it could never read back
  or undo.

  **Unique-sentinel composition** read the constraint field off the raw row at five
  call sites — soft delete, hard delete, `restore`, `purge`, and the
  `transactWrite` put-expansion (`Entity._buildPutSideItems`). A renamed field read
  as `undefined`, which the sparse rule treats as "constraint unset", so the
  sentinel was silently skipped: deletes orphaned the sentinel (making the value
  unusable forever), `restore` re-established nothing (allowing duplicates), and a
  put issued through `transactWrite` enforced no uniqueness at all.

  Every one of those sites now composes from a domain-keyed view of the row; the
  item written back stays attribute-keyed.

  Two further bugs on the `restore` path, both independent of any rename, are
  fixed alongside:
  - **`softDelete: { preserveUnique: true }` made `restore` impossible.** The
    delete deliberately keeps the reservation, so the restore-time sentinel Put's
    `attribute_not_exists` guard could never hold: every restore of a constrained
    entity was cancelled and reported as a `UniqueConstraintViolation` against its
    own reservation. Under `preserveUnique` the guard is now
    `attribute_not_exists(#pk) OR (#epk = :epk AND #esk = :esk)`, so the row
    re-claims the sentinel it still owns while a value taken by anybody else is
    still refused. With `preserveUnique` off the plain absence guard is unchanged.
  - **The restore-time retain snapshot inherited `deletedAt` and the soft-delete
    TTL.** It was built straight from the tombstone, and it lands on the same
    `#v#<version>` SK the delete-time snapshot used — so it replaced a clean
    snapshot with one that looked deleted and expired on the `softDelete.ttl`
    clock. The snapshot source is now stripped of both markers; `versioned.ttl`,
    when configured, still applies. `buildSnapshotItem` also strips the
    soft-delete vector stash (`__edd_vs_<index>__`), so a restore-time snapshot
    of a vector-indexed entity no longer carries the whole embedding blob.

## 1.20.0

### Minor Changes

- [`f2871b9`](https://github.com/jmenga/effect-dynamodb/commit/f2871b90dc897ff2de101012292e142b45a4a87b) Thanks [@mixja](https://github.com/mixja)! - Add `.filterBy()` — a client-side predicate that takes part in `limit` and cursor rebuilding

  `limit` is a contract on **results**: the request loop accumulates until `n` items are accepted and rebuilds the cursor from the last accepted item. Only a `FilterExpression` could take part in that, so a predicate DynamoDB cannot express had to be applied after the query returned — which breaks pagination two ways. The page comes back short, and its cursor resumes after the last item _returned_ rather than the last one _kept_, so the next page skips rows. `Page<A>` exposes one page-level cursor and no per-item resume token, so a caller filtering externally could not construct a correct resume point at all.

  The motivating case is case-insensitive matching. DynamoDB has no `lower()`, so a `FilterExpression` compares the stored attribute byte-for-byte:

  ```ts
  // stored: name = "Melbourne Cricket Ground"
  .filter((t, { beginsWith }) => beginsWith(t.name, "melbourne"))   // no match
  .filterBy((v) => v.name.toLowerCase().startsWith("melbourne"))    // matches
  ```

  Composite **keys** never had this problem — `applyCasing` folds both the stored key and the operand — but a sort key is one string, so its members are only usable as a contiguous leading prefix. "As much as the key prefix can take, the rest matched case-insensitively" was not expressible without dropping to the raw SDK and reimplementing the accumulate-and-rebuild loop.

  Added on `Query`, `BoundQuery` and `Aggregate.list`'s `ListOptions` (as `filterBy`), so there is one vocabulary rather than three. On an aggregate it runs on the root item **before assembly**, for the same reason `ListOptions.filter` is worth pushing server-side: a rejected root item never pays for its partition read.

  Two corners are closed rather than left to be discovered:
  - **`.count()`** would have reported the unfiltered count, since `Select: "COUNT"` returns no items to run the predicate against. It now reads the rows and counts the accepted ones — correct, at the cost of the read. Its error channel gains `ValidationError` accordingly, since decoding can now fail during a count.
  - **`.select()` with a predicate** raises **EDD-9054**. A projection returns only the attributes it names, and a predicate is an opaque closure whose attribute reads the library cannot see — so it cannot borrow them into the `ProjectionExpression` the way key attributes are borrowed for cursor rebuilding, and the predicate would be handed items missing the fields it tests.

  Prefer `.filter()` whenever DynamoDB can express the condition: a `FilterExpression` rejects rows before they cross the wire, while this runs after decode, so every examined row is still read and paid for.

  Collection queries (`db.collections.*`) are unchanged — their result is a per-entity grouping rather than a single item stream, so a per-item predicate has no single shape there.

## 1.19.1

### Patch Changes

- [`75e562c`](https://github.com/jmenga/effect-dynamodb/commit/75e562ccfd4900ccb4e227935cdfe035bd26fac0) Thanks [@mixja](https://github.com/mixja)! - Accept a caller-supplied generated id in `transactWrite`, `Batch.write` and `EventStore.append`

  `rejectUnsupportedOp` gated the `generatedId` check on the entity's **configuration**, so any entity declaring `generatedId` was barred from every multi-item write path — with the reason "id generation needs the Crypto service, which is not in scope here."

  That reason does not hold when the caller supplies the id. `Entity.put` reaches `Crypto` only for an _absent_ field: `fillGeneratedId` returns the input untouched when the value is present. So the rejected call needed nothing the path lacked, and the workaround the message pointed at — supply the id yourself — was already in effect and did not lift the rejection.

  The gate now reads the op's input. An omitted id is still refused, because this path builds the item straight from the encoded input and never calls `fillGeneratedId`, so the id would stay missing and the primary key would compose around an `undefined`. The message names the field and says which case is unsupported, rather than reading as a ban on the entity.

  This unblocks committing a `generatedId` read model atomically with the events that produced it (`EventStore.append({ additionalItems })`) — the pattern [#100](https://github.com/jmenga/effect-dynamodb/issues/100) exists to enable.

  The neighbouring `refs` and `vectorIndexes` gates are unchanged and stay configuration-gated: `refs` always hydrates at write time and `vectorIndexes` always needs the `Embedder`, so neither dependency is something the caller can remove. The 1.16.0 changelog grouped all three as needing "a read, `Crypto` or an `Embedder`", which was accurate for those two and wrong for this one; that entry is left as the historical record of what shipped.

## 1.19.0

### Minor Changes

- [`e82e78c`](https://github.com/jmenga/effect-dynamodb/commit/e82e78c0154b84f89d4a71d50f9b59789ec057c9) Thanks [@mixja](https://github.com/mixja)! - Refuse `.where()` on a sort-key composite the accessor already pinned (EDD-9053)

  DynamoDB allows exactly one sort key condition, and `Query.where` **replaces** the `begins_with` an index accessor installs for its pinned prefix. A condition on a composite the accessor had already pinned therefore discarded that pin instead of narrowing within it, and the query ran against the whole partition.

  Every operator was affected, not only the one-sided ones that the clamping logic guarded: `pinnedKeyForm` is built from composites strictly to the left of the target, so at target index 0 it was empty and `eq` / `beginsWith` / `between` lost the pin too. Under a pinned `label = "ship"`, `eq(t.label, "shine")` composed `#sk = "…#label_shine"` and returned rows whose label was **not** the pinned value.

  The clamping predicate was `targetIndex === 0`, standing in for "the accessor pinned nothing". Those coincided for every shape under test but are different claims — an accessor can pin composite[0] itself. It now asks what the accessor actually pinned, and a condition targeting a pinned composite raises **EDD-9053** rather than silently returning wrong rows.

  `ResolveSkFields` is repaired alongside it. It resolved to `{}` rather than `never` when no composite remained, so `BoundQuery`'s `[SkRemaining] extends [never]` gate never fired and `.where()` was offered on every accessor — including ones that had pinned every composite (the no-cast route to this bug) and ones whose index has no sort key composites at all (the only reason `EDD-9045` needed to exist as a runtime throw). `.where()` now disappears from both, so well-typed code cannot reach either diagnostic.

## 1.18.1

### Patch Changes

- [#119](https://github.com/jmenga/effect-dynamodb/pull/119) [`9d6decf`](https://github.com/jmenga/effect-dynamodb/commit/9d6decf94580326c5ccfa40c5ad0bbaad2afe821) Thanks [@jmenga](https://github.com/jmenga)! - Fix `EventStream` variance so the pipeable `commandHandler` form type-checks ([#106](https://github.com/jmenga/effect-dynamodb/issues/106))

  `EventStream`'s operations were declared as function-typed properties, so `strictFunctionTypes` checked their parameters contravariantly. A stream with no `snapshot` config has `TState = never`, and `writeSnapshot(…, state: never, …)` made that stream assignable to no other `EventStream` — not even one instantiated at `any`, since `any` is not assignable to `never`. `append`'s `options?: AppendOptions<TMetadata>` did the same for `TMetadata = undefined`.

  The effect: **every data-last / pipeable `commandHandler` call on a snapshot-less stream failed to compile** — `MatchEvents.pipe(EventStore.commandHandler(decider))`, `pipe(MatchEvents, …)` and the `BoundEventStream` equivalents. `pipe` infers its subject from the callback's parameter, erasing the generic function's type parameters to their constraints, which is where the invariance bites. The data-first form (`commandHandler(decider, MatchEvents)`) always worked, which is why this went unnoticed.

  `writeSnapshot`, `readSnapshot`, `append`, `read`, `readFrom`, `currentVersion` and `query.events` are now **method** declarations on both `EventStream` and `BoundEventStream`, which makes their parameters bivariant. This is a type-only change with no runtime effect, and supplying a `state` still requires `TState`, so the compile-time guarantee that a snapshot-less stream cannot write a snapshot is unchanged.

  One narrowing is lost: `commandHandler`'s `TState extends State` check no longer applies in the _data-last_ form. The data-first overloads still enforce it.

  Found while making every test file type-checked: `tsconfig.test.json` compiled only four files in `effect-dynamodb` and one in `schema`, and the `geo` and `language-service` packages had no test tsconfig at all. All four now compile their whole `test` directory as part of `pnpm check`, which is what surfaced this. No test assertion changed.

## 1.18.0

### Minor Changes

- [#118](https://github.com/jmenga/effect-dynamodb/pull/118) [`49913c9`](https://github.com/jmenga/effect-dynamodb/commit/49913c9a49ecb65c3922992db70d21f6854b7ea5) Thanks [@jmenga](https://github.com/jmenga)! - Accept bound-client `get` in `Batch.get`, `Transaction.transactGet` and `Transaction.check`

  `db.entities.X.get(key)` now returns a `BoundGet`. It **is** an `Effect<Model, …, never>` exactly as before — `yield*` it, `.pipe(Effect.catchTag("ItemNotFound", …))` it, hand it to `Effect.map` / `Effect.all` — and it is additionally a read descriptor, so it can be passed straight to `Batch.get`, `Transaction.transactGet` and `Transaction.check`.

  This closes the read half of the gap [#100](https://github.com/jmenga/effect-dynamodb/issues/100) closed for writes: an entity authored with the pure, AWS-free `@effect-dynamodb/schema` `Entity.make` carries no operations, so the bound client is the only surface its author holds. Until now that meant such an entity could not take part in batch reads, transactional reads, or condition checks at all — and `Transaction.check` is the sharpest loss, since a condition check on a row you are not writing is the standard way to assert an invariant across entities inside one transaction.

  Bound and unbound get descriptors unwrap through the same protocol (`Entity.extractTransactable`) and may be mixed freely in one array. A value that is not a get descriptor now fails with a `ValidationError` carrying `EDD-9051` on the error channel, where it used to be a thrown defect callers could neither catch nor discriminate.

  No change to the existing `get` surface.

## 1.17.0

### Minor Changes

- [#117](https://github.com/jmenga/effect-dynamodb/pull/117) [`98472f6`](https://github.com/jmenga/effect-dynamodb/commit/98472f6fda2f13b8eb744c9ee6246c2eb5be1d08) Thanks [@jmenga](https://github.com/jmenga)! - Filtered pagination for `Aggregate.list` ([#104](https://github.com/jmenga/effect-dynamodb/issues/104))

  `list` now takes the paging vocabulary the rest of the library settled on in
  1.16.0, plus a server-side predicate:
  - **`filter`** — a `FilterExpression` on the **root-item** query, in the same
    callback and shorthand forms `BoundQuery.filter()` takes. This is a
    performance fix as much as an ergonomic one: `list` assembles each surviving
    root item with its own partition read, so filtering the result afterwards paid
    a full assembly for every aggregate it then discarded.
  - **`limit` means "this many aggregates"** even under a filter — the query
    accumulates across as many requests as it takes, and **`pageSize`** sets
    DynamoDB's `Limit` (rows examined per request). Once a request over-reads, the
    returned cursor is rebuilt from the last item actually returned, so
    `cursor: null` still means genuinely exhausted.
  - **`reverse`** — walk the list index descending (`ScanIndexForward: false`),
    which `list` previously could not express at all.

  The sharded (`list.cardinality`) branch no longer discards paging options in
  silence: `limit` now truncates the merged fan-out, and a `cursor` is rejected
  with a `ValidationError` (**`EDD-9051`**) because a fan-out across N partitions
  has no resumable position — previously it was accepted and the list silently
  restarted from the beginning.

  Also fixes an empty shorthand filter (`.filter({})`) compiling to
  `FilterExpression: ""`, which DynamoDB rejects; it is now a no-op.

## 1.16.0

### Minor Changes

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`e1ecfb4`](https://github.com/jmenga/effect-dynamodb/commit/e1ecfb4def8c7d04faa62cf3fc9d3f66002dd7ff) Thanks [@jmenga](https://github.com/jmenga)! - Aggregates round-trip fields with a schema transformation

  An aggregate whose model carried a transformed field could not round-trip: the write path stored Type-side values, so a `bigint` landed as `{"N":"5"}` and assembly's `Schema.BigIntFromString` decode rejected a number. Aggregate attributes are now encoded to their wire form before marshalling, at the root, sub-aggregate roots, `one` edges, `many` elements and propagated context values.

  Two further causes are fixed with it:
  - **`fieldsOf` did not see through `DynamoModel.configure`**, so any edge whose model is configured — which is most, since `identifier: true` requires it — received **no encoders at all**. Dates on those edges were stored as `{"M":{…}}` or `{"M":{}}`, meaning the date handling added in [#72](https://github.com/jmenga/effect-dynamodb/issues/72) was silently not applying to them.
  - **`aggregate.update` recognised only date transforms** when re-decoding mutated state, so a non-date transform was rejected before any item was built — even when the mutation touched only an untransformed field. The tolerance now covers every leaf transform, and remains scoped to the aggregate decode path: entities pass no such option.

  Only `BigIntFromString` and `NumberFromString` attributes change on the wire, and both were unreadable before, so **no migration is required**. Composed keys are byte-identical.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`1e20c24`](https://github.com/jmenga/effect-dynamodb/commit/1e20c240ab44533495451c65b279f185b2c04e7a) Thanks [@jmenga](https://github.com/jmenga)! - Accept bound-client CRUD builders in `Batch.write`, `Transaction.transactWrite` and `EventStore.append({ additionalItems })`, and stop silently reinterpreting ops ([#100](https://github.com/jmenga/effect-dynamodb/issues/100))

  `db.entities.X.put(...)` returns a `BoundPut`, which the shared transactable-extraction protocol did
  not recognise — every multi-item write path rejected it with `ValidationError { entityType: "unknown" }`.
  This blocked entities authored with the pure, AWS-free `@effect-dynamodb/schema` `Entity.make`
  entirely: a pure definition carries no CRUD ops, so the bound builder is the only write descriptor
  its author can hold, which made "commit a read model atomically with the events that produced it"
  impossible. `extractTransactable` now unwraps bound builders to the intermediate they wrap.

  **Conditions on transact items are no longer silently dropped.** `.condition(...)`,
  `Entity.condition(...)`, and the implicit guards carried by `create()` (`attribute_not_exists`) and
  `deleteIfExists()` (`attribute_exists`) are compiled onto the `Put` / `Delete`. Previously
  `Transaction.transactWrite([Users.create(x)])` degraded to a blind overwrite.
  `ExpressionAttributeValues` is omitted when a condition carries no values, which also fixes
  `Transaction.check` with a value-free condition.

  **Ops the compile path cannot reproduce faithfully are rejected rather than reinterpreted.**
  `upsert` is an `UpdateItem` using `if_not_exists` for `createdAt`, immutable fields and the version
  counter — compiling it as a `Put` reset all three, including silently resetting the optimistic-lock
  counter. It now fails with a `ValidationError` on all three paths, as do entities configured with
  `refs`, `generatedId` or `vectorIndexes`, whose write contracts need a read, `Crypto` or an
  `Embedder`. `Batch.write` additionally rejects any conditioned op (`BatchWriteItem` has no
  `ConditionExpression`) and now reports unsupported ops on the error channel instead of as an
  untyped defect.

  Known gap, unchanged and now documented: entities with `unique`, `versioned: { retain: true }` or
  `softDelete` still write a single item through these paths, so their sentinel, snapshot or tombstone
  is not written. Prefer the entity's own operation for those. Tracked in [#113](https://github.com/jmenga/effect-dynamodb/issues/113).

  `@effect-dynamodb/schema` is unchanged and remains free of any AWS SDK dependency.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`1e20c24`](https://github.com/jmenga/effect-dynamodb/commit/1e20c240ab44533495451c65b279f185b2c04e7a) Thanks [@jmenga](https://github.com/jmenga)! - `.condition(...)` now declares `ConditionalCheckFailed` on the error channel ([#102](https://github.com/jmenga/effect-dynamodb/issues/102)).

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

  The widening is precise: an _unconditional_ `put` / `update` / `delete` keeps its narrow channel,
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
  reports `ConditionalCheckFailed`. When a version CAS _is_ present, both predicates ride the same
  `ConditionExpression` and DynamoDB does not say which half failed, so the rejection is still
  attributed to the CAS as `OptimisticLockError`.

  **Semver note.** Released as a minor, not a major. Widening an error channel is technically
  breaking for code that matches the union exhaustively (`Effect.catchTags` over every tag, or a
  hand-written exhaustive `switch` on `_tag`), and the unversioned-unique fix changes which tag such
  code sees. Both are narrow, and neither breaks the common `catchTag` / `catchAll` shapes; staying
  within 1.x is the deliberate call.

  **`.condition()` on `delete` now reaches DynamoDB on every path.** The compiled condition was
  attached only in the simple `DeleteItem` branch. On entities configured with `softDelete` or a
  `unique` constraint — both of which delete via `transactWriteItems` — the guard was built and then
  dropped, and the delete proceeded unconditionally. The condition now rides the current item's own
  `Delete` in both transactions, so a rejection rolls the whole transaction back: no tombstone is
  written, no unique sentinel is released. `deleteIfExists` rode the same drop (it is `delete` plus
  `attribute_exists(pk)`) and is fixed with it, closing a read-then-write window in which a
  concurrently-deleted item could be resurrected as a tombstone.

  **`purge()` now rejects `.condition()` instead of ignoring it** — `ValidationError`, `EDD-9047`.
  `purge` deletes a whole partition across batched writes, so no single `ConditionExpression` can
  guard it atomically. Guard the individual write with `delete(key).condition(...)`.

  Without these, the error-channel widening above would declare a `ConditionalCheckFailed` that those
  entity shapes could never raise.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`e1ecfb4`](https://github.com/jmenga/effect-dynamodb/commit/e1ecfb4def8c7d04faa62cf3fc9d3f66002dd7ff) Thanks [@jmenga](https://github.com/jmenga)! - Composite keys are composed by one rule everywhere — **storage-format change, migration required for two shapes** ([#101](https://github.com/jmenga/effect-dynamodb/issues/101), [#113](https://github.com/jmenga/effect-dynamodb/issues/113), [#114](https://github.com/jmenga/effect-dynamodb/issues/114), [#115](https://github.com/jmenga/effect-dynamodb/issues/115))

  Key composition ran on the encoded value, so a composite whose domain type is a `number` or `bigint` but whose encoded form is a **string** — `Schema.BigIntFromString`, `Schema.NumberFromString` — was written to the key as text, skipping the zero-padding that makes numbers sort correctly. Values 5 / 42 / 100 stored as `seq_5` / `seq_42` / `seq_100` and sorted `100 < 42 < 5`, so `gte(42n)` returned 42 and 5 instead of 42 and 100.

  Composition now follows one rule at every site: compose from the Encoded form, except when the domain type is numeric and the encoded form is a string, where the numeric Type form is used so it pads. `DynamoModel.DateEpochMs` composites use the padded epoch.

  **⚠️ Migration.** Rows keyed on either shape below were written under the old key and will not be found after upgrading — no error, the partition simply does not resolve. Read them by scan and re-`put` before or during the upgrade.
  - **Entity primary keys and GSI keys** with a `Schema.BigIntFromString` or `Schema.NumberFromString` composite. On 1.15.0 `put` **succeeded** and wrote these rows (only `get` was broken), so this data exists.
  - **Aggregate partition and collection keys** with a `DateEpochMs` / `DateEpochSeconds` composite, which move from their ISO form to the padded epoch.

  Composites of every other shape — plain numbers, bigints, strings, `Schema.Date`, `DateTimeUtc`, literals — are byte-identical and need no migration.

  Eleven modules previously decided independently what to hand the key composer, which is what produced the divergence. `test/KeyFormInvariant.test.ts` now reads each module as source text and fails if a `KeyComposer` call receives a record that did not go through the shared form.

  Fixed by the same change, each previously a silent wrong result:
  - `update()` rewrote GSI keys in a different format than `put()` wrote them, evicting the row from its own GSI.
  - `Transaction.transactWrite` / `Batch.write` composed a different primary key than `Entity.put`, producing unreadable orphan rows; `Batch.get`, `transactGet`, `transactWrite(delete)` and `Transaction.check` used the caller's raw key.
  - `purge()` reported success and deleted nothing.
  - `reembed()` skipped every live item — its guard compared a Type-side recompose against a stored key.
  - `getVersion()`, `deleted.get()` and `restore()` raised `ItemNotFound` for rows that exist, while `versions()` and `deleted.list()` worked.
  - `db.collections.*` and `Collections.make()` returned zero rows for values the equivalent entity accessor found.
  - Vector search composed a different partition than the write path.
  - Aggregate `list()` could not find rows `create` had written.

  Key input on `get` / `update` / `delete` and friends now takes the model's **Type** side — the same value the domain model holds and the query path accepts. Passing the wire form fails with a `ValidationError` naming the attribute rather than returning an empty result.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`0d67a51`](https://github.com/jmenga/effect-dynamodb/commit/0d67a51b1b27907c746c6fe808f929716d12f504) Thanks [@jmenga](https://github.com/jmenga)! - Separate `limit` (results) from `pageSize` (round trips) on queries and scans

  `limit` and page size were two different ideas sharing one word. They are now two combinators:
  - **`limit(n)`** — return **at most `n` items**. A contract on results. It no longer sets DynamoDB's `Limit`; the query accumulates across as many requests as it takes to reach `n` accepted items or exhaust the key range.
  - **`pageSize(n)`** — fetch in **batches of `n` rows**. This is what sets DynamoDB's `Limit` (rows _examined_ per request). A contract on round trips, not on what comes back.
  - **`maxPages(n)`** — unchanged. Still the hard stop on the number of requests, and the escape hatch when a filter is selective enough that `limit` would otherwise walk a large partition.

  Both compose: `.pageSize(50).limit(120)` fetches in requests of at most 50 examined rows, accumulating until 120 items.

  **This is why they had to split.** DynamoDB's `Limit` bounds rows _examined_, and a `FilterExpression` is applied _after_ it — so `Limit` can never express "give me 3 matching items". Under a filter, `limit` is now satisfied by accumulating across requests; `pageSize` (or an unbounded natural page when unset) is what each request asks for. Every entity query and scan therefore gets correct filtered pagination.

  **Cursors.** Once a request can over-read and discard the surplus, `fetch()`'s cursor can no longer be the raw `LastEvaluatedKey` — that points at the last row _examined_, not the last one returned. It is rebuilt from the last item actually handed back (every item carries the table key and the index key), so the next page resumes after what the caller saw. `cursor: null` still means genuinely exhausted. When a `.select()` projection is active alongside a `limit`, the key attributes are added to the request's `ProjectionExpression` and stripped from the items returned, so a truncated page still carries an accurate cursor.

  **`count()`.** `limit(n)` caps the count: `.limit(n).count()` returns `min(matching, n)` and stops counting once `n` is reached, keeping `count()` equal to `collect().length` for the same query — and making `.limit(1).count()` a cheap existence check. `pageSize(n)` sizes each `Select: "COUNT"` request.

  ## Migration — if you used `limit` as a page-size hint, move to `pageSize`

  `limit` changes meaning on `collect()` and `paginate()`. The same call keeps compiling and quietly means something else, so check every call site:

  | Before                                             | After                                         |
  | -------------------------------------------------- | --------------------------------------------- |
  | `.limit(3).collect()` → every item, in pages of 3  | `.limit(3).collect()` → **3 items**           |
  | `.limit(2).paginate()` → everything, in pages of 2 | `.pageSize(2).paginate()`                     |
  | `.limit(100)` to size a scan's requests            | `.pageSize(100)`                              |
  | `.limit(25).fetch()`                               | unchanged — still up to 25 items and a cursor |

  Callers who wrote what the documentation showed (`.limit(3).collect()` for "the first 3") were getting every matching item; they are now correct without a change. This ships as a minor within 1.x rather than waiting for a 2.0 because the old behaviour is a trap the docs already described incorrectly.

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`1e20c24`](https://github.com/jmenga/effect-dynamodb/commit/1e20c240ab44533495451c65b279f185b2c04e7a) Thanks [@jmenga](https://github.com/jmenga)! - Aggregate: honour `sk.composite` on `many` edges, so one entity can appear more than once in an aggregate (closes [#103](https://github.com/jmenga/effect-dynamodb/issues/103))

  `ManyEdgeConfig.sk.composite` was declared, type-checked and stored on the edge, but never read — the decompose walk composed each element's sort key from the referenced entity's identifier alone. Two elements sharing a ref composed one sort key, and DynamoDB rejected the entire aggregate write with `ValidationException: Transaction request cannot include multiple operations on one item`.

  A declared `sk.composite` is now **authoritative**: it replaces the ref-identifier heuristic rather than extending it, so it decides both uniqueness and the order elements sort in. Entries name attributes on the decomposed element and may use a dotted path to reach a hydrated ref (`"umpire.id"` — hydration replaces the id field with the referenced object, so the bare name no longer exists at the top level).

  Two related fixes for the same defect — a `many` edge whose sort key is not derived from anything distinguishing:
  - **"Element IS the ref" edges now compose a sort key.** `Schema.Array(Player)` hydrates each element to the entity's own flat fields, and the identifier fallback only recognised a field literally named `id`. An entity whose identifier is `playerId` produced _no_ composites, so every element collapsed onto one row. The edge entity's declared `DynamoModel.identifier` field is now used.
  - **Colliding sort keys fail as `AggregateDecompositionError`.** Decomposition detects two items composing the same sort key and fails with the aggregate, the edge and the colliding key — instead of an opaque `DynamoValidationError` naming nothing. This is checked before any write, so nothing is persisted.

  A declared composite must resolve to a **scalar** — string, number, bigint, boolean or date. Naming the hydrated ref object itself (`sk: { composite: ["umpire"] }`) rather than a scalar path (`"umpire.id"`) previously serialised the whole object into the sort key; it now fails with `AggregateDecompositionError` pointing at the dotted form.

  **Migration.** Sort keys change for two shapes, both of which could not previously hold more than one element:
  - edges that already declared `sk.composite` (previously ignored)
  - "element IS the ref" edges whose entity identifier is not named `id` — a single-element edge stored as `$app#v1#matchplayer` now stores as `$app#v1#matchplayer#p-1`

  Existing rows in either shape are orphaned on the next update. Entity-less `many` edges over plain structs now require a declared `sk.composite`; without one, a multi-element edge fails with `AggregateDecompositionError` rather than silently writing one row per aggregate.

### Patch Changes

- [#112](https://github.com/jmenga/effect-dynamodb/pull/112) [`1e20c24`](https://github.com/jmenga/effect-dynamodb/commit/1e20c240ab44533495451c65b279f185b2c04e7a) Thanks [@jmenga](https://github.com/jmenga)! - Compose `.where()` sort key conditions into full sort key values (closes [#101](https://github.com/jmenga/effect-dynamodb/issues/101))

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

## 1.15.0

## 1.14.0

## 1.13.0

## 1.12.1

## 1.12.0

### Minor Changes

- [#89](https://github.com/jmenga/effect-dynamodb/pull/89) [`63eaed6`](https://github.com/jmenga/effect-dynamodb/commit/63eaed62a5cad7d57c87e9fe0de5ca52f3388071) Thanks [@jmenga](https://github.com/jmenga)! - EventStore: additional transaction items in `append` + command idempotency (closes [#85](https://github.com/jmenga/effect-dynamodb/issues/85))

  **`append(streamId, events, expectedVersion, { additionalItems })`** — commit caller-owned
  transact items atomically with the event puts. `additionalItems` accepts the same op union
  `Transaction.transactWrite` takes (`Entity.put`, `Entity.delete`, `Transaction.check`),
  compiled through a new shared builder so the two APIs cannot drift. `EntityUpdate` remains
  unsupported in both; it will land for both at once.

  **Position-aware cancellation mapping.** Previously _any_ `ConditionalCheckFailed` in
  `CancellationReasons` became `VersionConflict` — which, with caller-owned items in the
  transaction, would misreport a failed user condition and send callers into a
  read-decide-retry loop that could never succeed. Reasons are now matched by transaction
  index, with precedence `DuplicateCommand` > `VersionConflict` >
  `AdditionalItemConditionFailed` > `TransactionCancelled`.

  **Command idempotency.** `commandHandler(decider, stream, { idempotency: { ttl? } })` plus a
  per-call `commandId` writes a dedup sentinel guarded by `attribute_not_exists` into the same
  transaction, co-located in the stream partition and invisible to `read` / `readFrom` /
  `currentVersion`. A replayed `commandId` is rejected with `DuplicateCommand`. Without
  `idempotency`, command processing remains **at-least-once** — now documented in the tutorial.
  Configuring `idempotency` makes `commandId` required at the type level.

  **Transaction size guard.** `events + additionalItems + sentinel + the version-contiguity
ConditionCheck` is checked against the shared `TRANSACT_WRITE_ITEMS_LIMIT` (100) before any
  AWS call, failing with `AppendTooLarge`.

  New tagged errors: `AdditionalItemConditionFailed`, `DuplicateCommand` (both exported from
  `effect-dynamodb` and `@effect-dynamodb/schema`).

  Also fixes the data-last (pipeable) form of `EventStore.commandHandler`, which passed the
  stream and decider to the implementation in swapped order and could never have worked.

  **Type-level note:** `append`'s error channel now unconditionally includes
  `DuplicateCommand | AdditionalItemConditionFailed | AppendTooLarge`, rather than varying
  with the options passed. `Effect.catchTag` / `catchTags` callers are unaffected; a caller
  exhaustively matching on `append`'s error union will need three more cases.

- [#87](https://github.com/jmenga/effect-dynamodb/pull/87) [`f846367`](https://github.com/jmenga/effect-dynamodb/commit/f846367a541fefb9c29f40684f87f89c8333745b) Thanks [@jmenga](https://github.com/jmenga)! - EventStore: guard `append` against TransactWriteItems limits and expectedVersion-ahead version gaps ([#82](https://github.com/jmenga/effect-dynamodb/issues/82))
  - New `AppendTooLarge` tagged error and `TRANSACT_WRITE_ITEMS_LIMIT` constant, exported from both `@effect-dynamodb/schema` and `effect-dynamodb`. `append` now pre-validates the transact-item count and fails with `AppendTooLarge` before issuing any request instead of surfacing a raw AWS validation error. The batch is deliberately never chunked — chunking would break append atomicity.
  - `append` now enforces version contiguity. When `expectedVersion > 0` the transaction carries a `ConditionCheck` requiring the event at exactly `expectedVersion` to exist, so an _ahead_ expected version fails with `VersionConflict` instead of silently writing past the stream head and leaving a permanent gap in the version sequence. The check occupies one transact item, so a single append holds up to 100 events at `expectedVersion === 0` and up to 99 otherwise.

- [#90](https://github.com/jmenga/effect-dynamodb/pull/90) [`5127a60`](https://github.com/jmenga/effect-dynamodb/commit/5127a606049d89da5de92b44f74dc2182e8b4418) Thanks [@jmenga](https://github.com/jmenga)! - EventStore: snapshot support and a `commandHandler` retry option ([#84](https://github.com/jmenga/effect-dynamodb/issues/84)).
  - **Snapshots** — opt in with `makeStream({ ..., snapshot: { schema, every? } })`. One
    snapshot item per stream lives in the stream partition under a distinct sort key
    (`$<schema>#v<n>#<stream>.snapshot`) that can never collide with an event sort key.
    State round-trips through the supplied schema (encode on write, decode on read), so
    transforming schemas work. New primitives: `writeSnapshot` / `readSnapshot` (also on
    `BoundEventStream`). Snapshot writes are monotonic — losing the race is a no-op, never
    a cache regression.
  - **Snapshot-aware `commandHandler`** — when a stream declares `snapshot`, each command
    runs `readSnapshot → readFrom(asOfVersion) → foldFrom → decide → append` instead of a
    full replay. With `every: N`, a fresh snapshot is written (best-effort) after a
    successful append once N events have accumulated since the last one.
  - **Retry** — `commandHandler(decider, stream, { retry })` accepts a max-attempts number
    or an Effect `Schedule`. On `VersionConflict` the **full** read-decide-append cycle
    re-runs, so every attempt decides against fresh state; a blind re-append is impossible
    by construction. Domain and infrastructure errors are never retried. Default: no retry.
  - **Event reads are SK-range hardened** — `read` / `readFrom` / `currentVersion` /
    `query.events` now bound the key condition to the event sort-key range instead of
    relying on the `__edd_e__` filter alone (DynamoDB applies `Limit` before
    `FilterExpression`). `currentVersion` also switched from `Query.collect` to the
    single-page terminal — it previously walked the whole partition one request per item.
  - **Fixed: `commandHandler`'s data-last form.** It was declared with `Function.dual`,
    whose data-last path assumes the data is the _first_ parameter — here the stream is the
    second, so `stream.pipe(commandHandler(decider))` passed the arguments swapped and threw.
    Replaced with a dispatch on the stream's `EventStreamTypeId` brand. `EventStream` and
    `BoundEventStream` are now `Pipeable`.
  - New: `DynamoSchema.composeEventVersionKeyPrefix` and `DynamoSchema.MAX_EVENT_VERSION`.

  Fully backward compatible: streams without `snapshot` and handlers without options behave
  exactly as before.

### Patch Changes

- [#88](https://github.com/jmenga/effect-dynamodb/pull/88) [`f903422`](https://github.com/jmenga/effect-dynamodb/commit/f90342267928cdc0cb50d0d4ef522dc54689de1a) Thanks [@jmenga](https://github.com/jmenga)! - fix(eventstore): codec symmetry — encode on write, decode on read

  `EventStore.append` previously spread the event instance and marshalled it raw,
  so any event schema carrying a transformation (`Schema.DateTimeUtc`,
  `Schema.Date`, branded transforms, fields with defaults) stored its **runtime**
  representation and then failed or drifted when the read path decoded it.
  Events are now run through `Schema.encode` before marshalling, mirroring the
  Entity/Aggregate write path.

  Metadata had the same asymmetry — validated with `Schema.decode` on write and
  returned via a raw cast on read. It is now encoded on write and decoded on
  read, so `StreamEvent.metadata` is the decoded schema type.

  The persisted event envelope (`streamId`, `version`, `eventType`, `timestamp`)
  is decoded through a schema instead of unchecked casts. Encode failures map to
  `ValidationError` with `operation: "EventStore.append"` (or
  `"EventStore.append.metadata"`).

  The injected `_tag` on stored event data keeps working for both `Schema.Class`
  and `Schema.TaggedClass` events.

## 1.11.0

### Minor Changes

- [`c754d7d`](https://github.com/jmenga/effect-dynamodb/commit/c754d7d4a070090c2968a815486796326e4a722b) Thanks [@mixja](https://github.com/mixja)! - Native DynamoDB vector search (closes [#78](https://github.com/jmenga/effect-dynamodb/issues/78)).

  Declare vector indexes on an entity and the library handles the rest — embedding
  generation on write, partition composition, lifecycle stripping, and a fluent
  search builder:

  ```ts
  const Products = Entity.make({
    model: Product,
    entityType: "Product",
    primaryKey: {
      pk: { field: "pk", composite: ["tenantId", "productId"] },
      sk: { field: "sk", composite: [] },
    },
    vectorIndexes: {
      byDescription: {
        name: "vec1",
        dimensions: 1024,
        distance: "cosine",
        source: { fields: ["name", "description"] },
        partition: ["tenantId"],
        filters: ["category"],
      },
    },
  });

  const hits =
    yield *
    db.entities.Products.byDescription("waterproof hiking boots")
      .partition({ tenantId })
      .filter({ category: "footwear" })
      .topK(25)
      .collect();
  ```

  - **Pure models.** The embedding (`__edd_v_<index>__`) and composed HASH
    partition (`__edd_vp_<index>__`) are library-managed and never surface in a
    decoded record.
  - **Automatic entity + tenant scoping.** The partition value is composed by
    `KeyComposer` as `$schema#v1#<entityType>[#composites]`, so a search on a
    shared physical index cannot cross entity types or tenants.
  - **`Embedder` service** (`@effect-dynamodb/schema`, AWS-free) with an in-library
    `Embedder.layerTest`. Dimension agreement is validated at `DynamoClient.make`.
  - **Write gating.** `put`/`create`/`upsert` always embed; `update`/`patch` embed
    only when the write touches a `source.fields` member — by `set()`, `remove()`,
    a null clear, or a path operation. Clearing every source field removes the item
    from the index. `.withVector()` supplies a pre-computed embedding (its name is
    typed and validated); `reembed({ concurrency })` migrates stale vectors.
  - **Declared filters only.** Only attributes listed in an index's `filters: [...]`
    are filterable — enforced by the accessor types, at runtime, and by the
    emulation layer. Entities sharing a physical index union their filters.
  - **Typed errors.** `EmbeddingError` is in the `put`/`create`/`update`/`patch`/
    `upsert` error channel for entities that declare `vectorIndexes`, and absent
    for those that don't.
  - **Lifecycle-aware.** Version snapshots, soft-delete tombstones and time-series
    event items drop out of the index; the tombstone stashes the embedding so
    `restore()` never re-embeds.
  - **Table ops.** `create()` emits merged `VectorIndexes`; `addVectorIndex`,
    `removeVectorIndex` and `waitForVectorIndex` manage them on a live table.
  - **`VectorSearchEmulation.layer`** stands in for DynamoDB Local, which discards
    `VectorIndexes` and rejects `SearchVectors`.

  Requires `@aws-sdk/client-dynamodb` >= 3.1104.0 (bumped). The raw operation needs
  the new `dynamodb:SearchVectors` IAM action, which existing read policies do not
  cover.

  Also fixes an unrelated pre-existing bug found along the way: `upsert` did not
  store the model fields that compose the primary key (it skipped them as "already
  in the Key", but the Key holds the _composed_ `pk`/`sk` strings, not the
  composite source values). Upserted items were stored without e.g. `productId`,
  so every subsequent read — including `upsert`'s own `ReturnValues: ALL_NEW`
  decode — failed with `Missing key`.

## 1.10.0

### Minor Changes

- [`bfec5f2`](https://github.com/jmenga/effect-dynamodb/commit/bfec5f22ca03961b2bcc13dfa62b323a7bab6375) Thanks [@mixja](https://github.com/mixja)! - Upgrade to Effect 4.0.0-rc.109 (release candidate)

  The workspace moves from `effect@4.0.0-beta.85` to `effect@4.0.0-rc.109` (now published from the main Effect-TS/effect repo). The `effect` peer range is raised to `^4.0.0-rc.109` accordingly. Migrations applied:
  - **`Schema.DateValid` removed** — `Schema.Date` now rejects invalid dates itself; all `DateValid` usages (DynamoModel Unsafe date codecs, date-transform substitution) migrate to `Schema.Date` with identical validation semantics.
  - **AST introspection moved to `representation` identities** — the RC removed the `typeConstructor` / `meta` annotation payloads that date/Redacted detection sniffed via `SchemaAST.resolve`. Detection now reads the stable `representation.id` (`effect/schema/Date`, `effect/schema/DateTimeUtc`, `effect/schema/DateTimeZoned`, `effect/schema/Redacted`) through a shared `matchDateRepresentation` helper (deduplicating the former Aggregate.ts matchers).
  - **`Schema.Struct(...)` is now a function** — the `isSchemaClass` detection gains an AST-tag guard (`Declaration` vs `Objects`); without it, Struct-modeled entities were decoded through `new Struct(...)` and silently returned empty objects. A canary test locks the discriminator down.
  - **`SchemaIssue.InvalidType` signature** — the constructor takes the raw rejected input instead of an `Option`; all five custom-getter call sites updated.
  - **`DateTime.toEpochSeconds`** — replaces hand-rolled `Math.floor(toEpochMillis(...) / 1000)` TTL math in Entity and the DateEpochSeconds codec.

## 1.9.5

## 1.9.4

## 1.9.3

## 1.9.2

### Patch Changes

- fix(schema): make the AWS-free pure-authoring path actually usable (closes #66, closes #67).

  Two follow-ups to the #62 schema/runtime split, both blocking its headline use case
  (deriving a typed aggregate input/create payload from `@effect-dynamodb/schema` with
  no AWS SDK):
  - **#66** — the pure edge constructors (`Aggregate.ref` / `one` / `many`) required a
    `RefEntity` with a runtime `get` method, so aggregate edges could not be authored
    from pure `Entity.make` definitions (which have no `get`). `RefEntity` is now the
    minimal structural bound used only for derivation (`_tag`/`entityType`/`model`/
    `indexes`/`schemas`); the runtime ref-hydration narrows back to a `get`-bearing
    entity at its single call site.
  - **#67** — `deriveAggregateSchemas` (the table-free derivation entry point) returned
    `Schema.Top` members, so `typeof result.inputSchema.Type` collapsed to `unknown`.
    It is now generic and returns `Schema.Codec<AggregateInputType<…>>` (plus a
    `createSchema` alias), so the table-free path is as typed as the top-level
    `Aggregate.make` — no stub `table` tag or GSI key config needed.

  Type-checked regression tests for both land in the schema package's `tsconfig.test.json`
  gate (now wired into `pnpm check`).

## 1.9.1

### Patch Changes

- fix(release): resolve `workspace:` protocol at publish time (closes #64).

  `1.9.0` shipped with an unresolved `workspace:` spec (`effect-dynamodb`'s
  `dependencies."@effect-dynamodb/schema": "workspace:^"`, and `@effect-dynamodb/geo`'s
  `peerDependencies.effect-dynamodb`), making `effect-dynamodb@1.9.0` uninstallable for
  consumers. Root cause: `release.yml` published via `npm publish`, which does not
  rewrite the `workspace:` protocol.

  The publish step now packs each package with `pnpm pack` (which rewrites `workspace:`
  in `dependencies` and `peerDependencies` to concrete ranges) and publishes the
  resulting tarball via `npm publish` (preserving OIDC Trusted Publishing + provenance),
  with a guard that refuses to publish if any `workspace:` spec remains in the packed
  manifest. No runtime/API changes — 1.9.1 republishes 1.9.0 with correctly resolved
  dependency ranges.

## 1.9.0

### Minor Changes

- 0e56c83: feat: split pure schema/relationship-derivation layer into the new @effect-dynamodb/schema package (importable without @aws-sdk); effect-dynamodb re-exports it, non-breaking (closes #62).
  - New `@effect-dynamodb/schema` package owns the AWS-free core: `DynamoModel`, `DynamoSchema`, `KeyComposer`, the tagged `Errors`, `Projection`, the entity/aggregate derivation internals, and pure `Entity.make` / `Aggregate.make` definition builders carrying the derived `inputSchema` / `updateSchema` / `createSchema`. It has ZERO `@aws-sdk` dependency in both its runtime import graph and its emitted `.d.ts` surface — guarded by an automated test.
  - `effect-dynamodb` depends on and re-exports the entire public surface of `@effect-dynamodb/schema`, then adds the AWS runtime (DynamoClient, CRUD/query operations, Batch/Transaction/Collection, Marshaller). Existing consumers (and `@effect-dynamodb/geo`) are unaffected — every import keeps working unchanged.
  - Consumers who only need an entity/aggregate's derived schemas (e.g. HttpApi payloads, validation) can now `import { Entity, Aggregate, DynamoModel, DynamoSchema } from "@effect-dynamodb/schema"` without pulling `@aws-sdk/*` into their dependency graph or type surface.

### Patch Changes

- e0cf0ad: chore(deps): upgrade Effect v4 beta.74 → beta.85. No source changes — type-check, unit, lint all green; no breaking upstream changes affect this codebase.

## 1.8.2

### Patch Changes

- Fix EDD-9002 false positive on ref-derived `<field>Id` composites in the language-service. Closes [#54](https://github.com/jmenga/effect-dynamodb/issues/54).

  Index and primary-key composites that reference a ref's surfaced identifier attribute (e.g. `teamId` for a `team` ref) were incorrectly flagged as unknown attributes. The diagnostic's valid-attribute set was derived only from the model schema's read-side fields and never accounted for the `${field}Id` substitution the runtime applies for `refs`.

  The diagnostic now mirrors the runtime key/input schema: each field listed in the entity's `refs` config is removed from the valid-composite set and replaced by its `<field>Id` form. Referencing the bare ref field name (e.g. `team`) is still reported as an error, matching what `tsc` rejects.

## 1.8.1

### Patch Changes

- Upgrade to Effect v4 beta.74 and fix two breaking changes from the bump.
  - **`Effect.fromYieldable` removal** — `Config<T>` now extends `Effect.Effect<T, ConfigError>` directly, so the `Effect.fromYieldable(config)` wrapper is gone. Config values resolve straight through `Effect.runSync(config)`.
  - **`Schema.Array` element accessor** — beta.71 reintroduced `.value` on `Schema.Array`/`NonEmptyArray`; the element moved off `.schema`. `Aggregate` input-schema derivation read array elements via `.schema`, which silently broke ref→ID field rewriting (many-edge fields were no longer replaced with ID-string arrays). `extractArrayElement` now reads `.value` (with a `.schema` fallback for resilience across beta releases).

## 1.8.0

### Minor Changes

- Add `TableConfig.ttlAttributeName` (default `"_ttl"`) so the library writes TTL values to a configurable attribute name instead of the hardcoded `_ttl`. Closes [#51](https://github.com/jmenga/effect-dynamodb/issues/51).

  A single setting applies to every lifecycle feature on the physical table — `timeSeries: { ttl }`, `softDelete: { ttl }`, and `versioned: { retain, ttl }` write to the same attribute and `Entity.restore()` strips it. This matches DynamoDB's per-table `TimeToLiveSpecification.AttributeName`, which permits exactly one TTL attribute.

  ```ts
  const MainTable = Table.make({ schema, entities: { Users } });

  // Default (unchanged): writes to "_ttl"
  MainTable.layer({ name: "users-prod" });

  // Override: align with a TimeToLiveSpecification.AttributeName = "ttl"
  MainTable.layer({ name: "users-prod", ttlAttributeName: "ttl" });

  // Or from Effect Config
  MainTable.layerConfig({
    name: Config.string("TABLE_NAME"),
    ttlAttributeName: Config.string("TTL_ATTR").pipe(
      Config.withDefault("_ttl"),
    ),
  });
  ```

  This is fully backwards compatible — consumers who don't set the field continue to write to `_ttl`. Use it to align the library's writes with a pre-existing or migrated DynamoDB table whose TTL attribute differs, without the destructive table replacement or multi-deploy DDB rename dance.

## 1.7.4

### Patch Changes

- **`.append(input).remove(attrs)` — atomic SET + REMOVE + CAS on time-series entities (closes [#49](https://github.com/jmenga/effect-dynamodb/issues/49)).**

  `BoundAppend` gains a `.remove(attrs)` combinator that emits `REMOVE` clauses on the same `UpdateItem` that carries the scoped `SET` and CAS predicate. Use it when an event needs to clear one or more `appendInput` attributes atomically — e.g. an IoT status event whose absence of an `alert` field means "no alert this cycle; drop the existing alert state on the current item."

  **Motivating problem.** Before v1.7.4, callers wanting to clear an `appendInput` attribute were stuck with three unsatisfactory workarounds:
  - `.append(...)` then `.update().remove([...])` (two writes) — race window: a concurrent writer between the two writes could clobber the cleared state.
  - Sentinel value (e.g. `alertState: "DISABLED"`) — keeps the attribute set, leaves the item in any `'sparse'`-policied GSI half that composes it.
  - `Schema.NullOr` + null payload — writes a literal `NULL` into the item; downstream readers must tolerate it.

  `.append(input).remove(attrs)` closes the race window structurally: a single `UpdateItem` carries `SET + REMOVE + CAS`, atomic with the event `Put`.

  **GSI cascade.** Any GSI half whose composite list intersects `attrs` follows the v1.7.1 cascade-override semantics — the half evaluates with the removed composite treated as absent. Under `'sparse'` the half drops; under `'preserve'` it's a no-op (the stored key field is left as-is unless overridden). The motivating shape is a sparse-PK GSI keyed on the cleared attribute — the item drops out of that GSI in the same write.

  **Validation.** Names listed in `.remove()` are checked at execution time. The Effect fails with `ValidationError(operation: "append.remove")` if any name:
  - is not declared in `appendInput` (enrichment-preservation contract — use `.update().remove([...])` for fields outside `appendInput`);
  - names `orderBy` (would invalidate the CAS anchor);
  - names a primary-key composite (would orphan the item);
  - names a ref field (refs are create-time denormalisations — reassign via `.update()`);
  - also appears in the encoded payload with a non-`undefined` value (DynamoDB rejects `SET`/`REMOVE` overlap).

  Chained `.remove()` calls accumulate. The combinator composes with `.condition()` and `.skipFollowUp()` in any order.

  **API.** New fluent combinator on `BoundAppend`:

  ```ts
  yield *
    db.entities.Telemetry.append({ channel, deviceId, timestamp }).remove([
      "alertState",
    ]);
  ```

  The entity-level unbound `Entity.append()` also gains an optional fourth positional argument (`removeAttrs?: ReadonlyArray<string>`) — used by `BoundAppend`'s `.remove()` wiring; library consumers should prefer the fluent form on `BoundAppend`.

  **No on-disk impact, no backfill required.** Pure feature add — existing time-series entities and existing items are unaffected.

  See `guides/timeseries.mdx` for the documented usage pattern and the issue [#49](https://github.com/jmenga/effect-dynamodb/issues/49) motivating IoT case.

## 1.7.3

### Patch Changes

- **indexPolicy v1.7.3 — reframe per-half evaluation gate as skip-predicate (closes [#46](https://github.com/jmenga/effect-dynamodb/issues/46)).**

  **What broke.** Under v1.7.0 / v1.7.1 / v1.7.2, `Entity.update()` silently skipped composing GSI keys for halves declared with `composite: []` (the standard "bare entity prefix" pattern, common in single-table-design lookup GSIs like `byDeviceBinding: { pk: [deviceBinding], sk: { composite: [] } }`). Items written via `.put()` were correct — but any subsequent `.update()` that touched the OTHER half left the empty-composite half missing → invisible to the GSI. Worse, an `.update()` that bound a previously-sparse GSI for the first time wrote only the PK half, leaving the SK missing.

  **What was wrong.** The per-half evaluation gate was a "touched" predicate — a chain of `||` clauses each enumerating a shape for which to evaluate the half (payload membership in v1.7.0; `removedSet` in v1.7.1; `keyRecord` in v1.7.2). Each missed shape required another tactical patch — `.some(...)` over an empty composite array trivially returns `false`, so empty-composite halves got classified as untouched and skipped.

  **Fix.** Reframe the gate as a **skip-predicate** keyed on the gate's actual purpose (multi-writer protection): skip iff composites exist (otherwise the half value is a constant prefix), no composite was explicitly removed, and every composite is absent from BOTH `updatePayload` AND `keyRecord`. The skip-predicate's negation is observably equivalent to the cumulative `||`-chain plus `composites.length === 0` — same SET/REMOVE outcomes for every existing input. Closes [#46](https://github.com/jmenga/effect-dynamodb/issues/46) directly and the class of degenerate-case bugs that v1.7.0 → v1.7.2 patches were chasing as separate `||` arms.

  **Affected items.** Items written under v1.7.0 / v1.7.1 / v1.7.2 against entities with empty-composite-half GSIs will repair themselves on the next `Entity.update()` against them under v1.7.3. The next write composes the missing half from the constant prefix and the item rejoins the GSI. No data migration is needed; reads via the GSI start returning these items as their next update lands.

  **No API changes.** Purely an internal gate-logic refactor — same observable behavior for every input the previous gate already handled correctly, plus correct behavior for the empty-composite-half shape that was silently broken.

## 1.7.2

### Patch Changes

- **indexPolicy v1.7.2 — fix PK-composites-only GSI regression (closes [#43](https://github.com/jmenga/effect-dynamodb/issues/43)).**

  v1.7.1 introduced a per-half evaluation gate that — by design — skipped GSI evaluation on halves the writer didn't touch. Unfortunately the gate consulted only `updatePayload` and so silently classified entire GSIs as untouched whenever their composites were entirely entity primary-key composites. Those PK composites never appear in `updatePayload` (writers address the row by key, never restate them in `.set({...})`, and `.append()` filtered them out before passing to the composer). The composer never ran, `gsiNpk` and `gsiNsk` were never written, and items were invisible to the GSI for their lifetime.

  Concretely: an entity with `primaryKey: [channel, deviceId]` and a `byChannel: { pk: [channel], sk: [deviceId] }` GSI saw zero items returned from any channel-scoped query under v1.7.0 / v1.7.1, regardless of whether the writes used `.put()`, `.update()`, or `.append()` — the latter two never composed the keys, and `.update()` only re-composed them on calls that explicitly restated `channel` / `deviceId` in the payload (which no realistic writer does).

  **The fix** (two minimal patches working together):
  1. **`KeyComposer.composeGsiKeysForUpdatePolicyAware`** — the per-half gate now also counts `keyRecord` membership (the entity primary-key attributes carried into the composer alongside the payload). PK-composite-only GSI halves are now correctly classified as touched on every write that has a `keyRecord`.
  2. **`Entity.append()`** — no longer filters PK composites out of the payload it passes to the composer. The filter never solved a real problem (the composer doesn't emit redundant SETs for the underlying composite fields, and idempotent recomposition from immutable PK composites is benign) and combined with the v1.7.1 gate to silently break this pattern.

  The change is idempotent for entity-PK composites (re-composing the same value from immutable PK composites produces the same key) and preserves the v1.7.1 multi-writer fix: stamps' GSI composites are not in `updatePayload` AND not in `keyRecord` either (they're enrichment-owned model attrs), so their halves remain untouched as designed.

  **Affected items:** items written to PK-composites-only GSIs under v1.7.0 or v1.7.1 will repair themselves on the next `Entity.update()` against them. The gate now fires correctly, the structural rule composes the immutable PK values, and the missing GSI keys are SET. **No data migration required** — reads via the GSI start returning these items as their next update lands. If you have items that aren't naturally updated, a one-shot bulk `Entity.update(key).set({ otherField: value })` (or even an empty-payload update touching only `updatedAt` + version) is enough to repair them.

  **No API changes** — same `indexPolicy: { pk, sk }` declaration shape, same `Entity.update` / `Entity.append` signatures, same EDD-9025 invariants. Behavior change is strictly more correct than v1.7.1.

  See `DESIGN.md §7` for the updated decision algorithm and `guides/index-policy.mdx` for the updated walkthrough plus the _byChannel GSI returns 0 items_ pitfall.

## 1.7.1

### Patch Changes

- **indexPolicy v1.7.1 — per-half roll-up corrections (closes [#41](https://github.com/jmenga/effect-dynamodb/issues/41)).**

  v1.7.0 shipped the per-key declaration model (`indexPolicy: { pk, sk }`) but had three connected bugs in how outcomes were rolled up. All three were rooted in the same defect: the model was per-half on declaration but not on evaluation, outcome, or cascade. v1.7.1 makes all four uniformly per-half.

  **Bug fixes** (strictly more correct than v1.7.0):
  1. **GSI-wide cascade on can't-compose → per-key REMOVE.** v1.7.0 REMOVE'd both `gsiNpk` AND `gsiNsk` whenever either half couldn't compose. v1.7.1 REMOVEs only the half that couldn't compose; the other half's stored value persists. Closes the multi-writer enrichment-on-pk + telemetry-on-sk scenario that v1.7.0 was designed to enable but didn't actually enable correctly.
  2. **`CompositeKeyHoleError` (EDD-9024) deprecated — no longer thrown.** The v1.7.0 throw under preserve+hole was a defensive runtime safety net for a case the type system already catches (required composites can't be omitted under `exactOptionalPropertyTypes` since v1.7.0 reverted the NullishOr widening). The class export is preserved for back-compat with consumers who type-imported it for `Effect.catchTag` handlers, but no code path raises it anymore. Hole patterns now collapse into the unified per-half can't-compose rule.
  3. **Per-half evaluation gate (NEW in v1.7.1).** v1.7.0 fired the policy on every update of every GSI declaring `indexPolicy`, regardless of whether the writer touched the half. This made stamps and unrelated writers blow away sparse halves they didn't own. v1.7.1 skips untouched halves entirely — a half is touched iff at least one of its composite names appears in the update payload OR in `Entity.remove([...])`.

  **Behavior change:**
  - **`Entity.remove([attr])` is now per-half** (no longer GSI-wide). Removing a composite REMOVEs only the half(s) whose composite list contains it. Other halves follow the per-half evaluation gate (untouched → noop). Combined with the new "cascade override under preserve" rule, the consumer's explicit signal still gets honored — preserve + can't-compose + composite in `removedSet` → REMOVE that half.

  **No API changes:**
  - Same `indexPolicy: { pk, sk }` declaration shape.
  - Same `Entity.remove([...])` API.
  - Same EDD-9025 invariants (composite attributes can't be `Schema.NullOr`).
  - Same `Schema.optional(...)` pattern for sparse composites.

  **v3 model preserved:** the per-key declaration, two-way payload classification, and EDD-9025 footgun gate from v1.7.0 are all preserved unchanged. v1.7.1 only fixes the roll-up.

  See `DESIGN.md §7` for the full v1.7.1 decision algorithm and the `guides/index-policy.mdx` rewrite for the concept-first walkthrough.

## 1.7.0

### Minor Changes

- [`5825d73`](https://github.com/jmenga/effect-dynamodb/commit/5825d73488a255733b965ab2c8e93e1c92c38517) Thanks [@mixja](https://github.com/mixja)! - **indexPolicy v3 — per-half model, structural composition, EDD-9025 invariant.** Closes [#39](https://github.com/jmenga/effect-dynamodb/issues/39) and supersedes [#38](https://github.com/jmenga/effect-dynamodb/issues/38).

  > **Heads up — breaking changes inside a minor bump.** The 1.6.0 → 1.7.0 transition would normally be a major bump on semver grounds, but in-the-wild consumer count is currently ~1 (the author's own consumer migration), so the bump is shipped as minor to accelerate iteration. Future consumers should treat 1.7.0 as if it were 2.0.0 and read this entry before upgrading.

  The v1.6 per-attribute `indexPolicy` callback model proved unwieldy in practice. The standard `update`/`patch` path has only payload-level information (no read-before-write), so per-attribute granularity within a single composed-key half collapsed to per-half outcomes anyway. v3 simplifies to a per-half declaration with a structural composition rule, and closes the `set({composite: null})` footgun at the type level.

  ### What's new in v1.7.0
  - **Per-half `indexPolicy: { pk, sk }`.** Both halves default to `'preserve'` when omitted. Replaces the v1.6 `indexPolicy: (item) => ({ attr: 'sparse' | 'preserve' })` callback API.
  - **Structural composition (longest valid leading prefix).** Symmetric on PK and SK — the v1.6 PK-clear-degrades-to-sparse asymmetry is gone. Hierarchical PK truncation (e.g. `pk.composite = ['accountId', 'fleetId']` → omit `fleetId` → partition key truncates to `account#A`) is **new and additive**.
  - **Two-way payload classification.** `null` = `undefined` = absent. The v1.6 three-way classification (present / explicit-clear / omitted) collapses; `set({attr: null})` no longer separately cascades GSI keys.
  - **Two coherent drop triggers** — both predictable, both tied to clear caller intent:
    - `Entity.remove([attr])` cascade (per-attribute, explicit, per call) — unchanged.
    - `'sparse'` policy + whole-half-empty (per-half, implicit, declared at the index) — narrower than v1.6's per-composite leakage.
  - **Policy-aware hole detection.** Hole pattern (`[A, _, C]`) under `'preserve'` throws `CompositeKeyHoleError` (EDD-9024); under `'sparse'` truncates to the leading prefix (or, if the leading prefix is empty, collapses to whole-half-empty + drop).
  - **EDD-9025 — `CompositeNullableError`.** New `Entity.make()` validation that walks every composite (across `primaryKey`, every entry in `indexes`, every entry in `unique` constraints) and throws if the composite's Schema includes `null` in its type union (`Schema.NullOr`, `Schema.NullishOr`, `Schema.Union` with a Null branch). Composites participate in string composition; null is not a meaningful slot value.
  - **Append unifies with update.** `.append()` now calls the same composer as `.update().set()` — the v1.6 `appendInput`-policy-filter wrapper is gone. Composites outside `appendInput` are simply absent under the structural rule.
  - **`writerScope` (proposal [#38](https://github.com/jmenga/effect-dynamodb/issues/38)) is superseded.** v3's narrower implicit-drop trigger eliminates the cross-writer leakage that motivated `writerScope`.

  ### Breaking changes — migration

  **Per-attribute callback → per-half object literal.** Take the most-restrictive per-attribute policy on each half:

  ```diff
   indexes: {
     byAlert: {
       name: "gsi1",
       pk: { field: "gsi1pk", composite: ["alertState"] },
       sk: { field: "gsi1sk", composite: ["deviceId"] },
  -    indexPolicy: () => ({ alertState: "sparse" }),
  +    indexPolicy: { pk: "sparse", sk: "preserve" },
     },
   }
  ```

  **`set({attr: null})` no longer cascades GSI drop.** Use `Entity.remove([attr])` for atomic remove + GSI cascade:

  ```diff
  - yield* db.entities.Devices.update(key).set({ alertState: null })
  + yield* db.entities.Devices.update(key).remove(["alertState"])
  ```

  **Update-payload type widening reverted.** v1.6 wrapped each update field in `Schema.NullishOr`. v1.7 reverts this; `set({ attr: null })` only compiles when the model declares the attr as nullable. Combined with EDD-9025, this closes the stale-GSI footgun at the type level — `set({composite: null})` no longer compiles.

  **EDD-9025 — composite attribute schemas can't include `null`.** Convert nullable composites to `Schema.optional(...)` (T | undefined; the sparse pattern):

  ```diff
   class Device extends Schema.Class<Device>("Device")({
     channel: Schema.String,
     deviceId: Schema.String,
  -  tenantId: Schema.NullOr(Schema.String),    // ← composite, EDD-9025 rejects
  +  tenantId: Schema.optional(Schema.String),  // ← T | undefined, allowed
   }) {}
  ```

  **Hierarchical PK truncation is now supported (additive).** If you relied on the v1.6 PK-drop behavior on `set({pkComposite: null})`, declare the PK half as `'sparse'` to keep that semantic. Otherwise, the new behavior — truncate to leading prefix — is the right default for multi-tenant fleet / multi-org-project shapes.

  **Hole detection is now policy-aware.** Under `'preserve'`, holes still throw `CompositeKeyHoleError` (EDD-9024). Under `'sparse'`, holes silently truncate (or drop when the leading prefix is empty). If your code relied on the v1.6 strict throw on a sparse half, restructure so holes can't form (e.g. by putting only one composite on each half).

  **Mixed sparse/preserve attrs in same half → not expressible.** Pick one per half. The half is a single concatenated string; per-attribute mixing within a half had no coherent runtime semantic anyway.

  See `DESIGN.md §7 Policy-Aware GSI Composition` and `guides/index-policy.mdx` for the full v3 model + worked examples.

## 1.6.0

### Minor Changes

- indexPolicy v2 — unified-hierarchy attribute model, three-way payload classification, hierarchical SK pruning, hole detection. Plus the SparseMap opt-in is renamed to a typed callable.

  **indexPolicy v2 — behavior changes (closes [#36](https://github.com/jmenga/effect-dynamodb/issues/36))**
  - The runtime now distinguishes three payload states per composite attribute: present-with-value, explicit clear (`null` or `undefined`), and omitted. `null` and `undefined` collapse — both signal "explicit clear, drop this composite from the key now" — and they cascade unconditionally regardless of policy.
  - Omission still defers to `indexPolicy` (`'sparse'` drops the GSI; `'preserve'` is a no-op).
  - Pre-1.6 collapsed omission and explicit `null`/`undefined`, with `'sparse'` firing on every update regardless of whether the caller touched that composite. **Audit any existing `set({ attr: null })` paths** — intent is now unambiguous (always cascades). Switch any `'sparse'` policies that aren't really membership-driving (hybrid-writer GSIs) to `'preserve'`. See the migration table in the [indexPolicy guide](https://github.com/jmenga/effect-dynamodb/blob/main/packages/docs/src/content/docs/guides/index-policy.mdx#migrating-from-150).

  **Hierarchical SK pruning — new opt-in feature**
  - When a _trailing_ SK composite is explicitly cleared with `'preserve'` policy, `gsiNsk` truncates to the leading prefix instead of dropping the GSI entirely. The item stays queryable at the parent (coarser) hierarchy depth — geographic, org, workflow, content classification, permission scope, order grouping. See DESIGN.md §7.6.

  **Hole detection — new write-time validation**
  - An SK composite cleared at position `i` with another SK composite at position `j > i` still present produces a syntactically invalid prefix that no `begins_with` query would match. The library now throws `CompositeKeyHoleError` (EDD-9024) at write time, naming the GSI, the cleared composite, and the offending trailing composite. Pre-existing latent bugs (silent broken keys) become loud failures.

  **SparseMap API rename — breaking change, low blast radius**
  - `storedAs: 'sparse'` (magic string) → `storedAs: DynamoModel.SparseMap()` (typed callable). The `prefix` option moves from a sibling on `ConfigureAttributes` into the `SparseMap({ prefix })` config object — where it semantically belongs.
  - 1.5.0 was the only release that used the magic string; consumer adoption is minimal. No backward-compat shim — mechanical rename.
  - Two motivations: (1) the magic-string `'sparse'` collided with the `indexPolicy` `'sparse'` value (opposite meanings), confusing consumers; (2) the callable form lets options live where they belong rather than as siblings only meaningful when paired with the right `storedAs` value.

  **Type-level changes**
  - `EntityUpdateType` now widens each field to `T | null | undefined` so consumers can express explicit clears through TypeScript without casting. The runtime already accepted them via `Schema.NullishOr` wrap.
  - `ConfigureAttributes.storedAs` becomes `Schema.Schema<A> | SparseMapConfig`. The `| 'sparse'` literal union is dropped.
  - `ConfigureAttributes.prefix` removed from top level.
  - New exports: `DynamoModel.SparseMap`, `DynamoModel.SparseMapConfig`, `DynamoModel.isSparseMapConfig`, `CompositeKeyHoleError`, `makeCompositeKeyHoleError`, `KeyComposer.composeSkPrefixUpTo`.

## 1.5.0

### Minor Changes

- 7a7e72f: Add **SparseMap** storage primitive (`storedAs: 'sparse'`) — flattened storage for logical `Record<K, V>` fields, with each map entry stored as an independently addressable top-level DynamoDB attribute named `<prefix>#<key>`.

  The headline win is per-bucket atomic counters on a fresh item without parent-map ceremony — `ADD totals#2026-01 :1` works as a single op on a row that has never been touched before. Concurrent writers to disjoint buckets never race.

  **API surface:**
  - `DynamoModel.configure(model, { field: { storedAs: 'sparse' } })` — opt in. Optional `prefix` override.
  - Reads transparent — `get` / `query` / `scan` / batch / streams rebuild the domain `Record<K, V>` from flattened attributes.
  - Record-style writes: `.set({ field: { ... } })` decomposes into one SET per bucket (whole-bucket replace; concurrent disjoint-bucket writes safe).
  - Path-style writes: `PathBuilder.entry(key)` plus `.pathAdd` / `.pathSet` for atomic per-leaf updates within a known bucket. Counter case (scalar buckets) needs no bucket ceremony.
  - `.removeEntries(field, keys)` — explicit per-key REMOVE (`null` in record-style is **not** REMOVE — too footgunny).
  - `.clearMap(field)` — Get-then-Update helper that folds REMOVE clauses into the same final UpdateItem as the rest of the builder's combinators. Atomic for `versioned: { retain: true }` entities; best-effort for non-versioned.
  - Conditional ops: `attribute_exists(<prefix>#<key>)` via the path API.

  **Lifecycle interactions:**
  - `versioned: { retain: true }` — snapshots preserve flattened attrs verbatim.
  - `softDelete` — sparse data is preserved across soft-delete and restore.
  - `timeSeries` — sparse fields are aggregate state, not event state. They live on the current item only and are **not** carried on event items (`#e#<orderBy>`).

  **Validation at `Entity.make()` (EDD-9020..9023):** sparse fields must be `Schema.Record`, must not be nested-sparse, must not participate in primary-key/GSI composites or unique constraints, must have distinct prefixes that don't collide with non-sparse field names. User-supplied keys must not contain `#` (validated at write time; no silent escaping).

  See `docs/guides/sparse-maps` for the full guide and `examples/guide-sparse-maps.ts` for a runnable program.

## 1.4.0

### Minor Changes

- fix(entity): correct codec direction so RedactedFromValue and other transform schemas round-trip ([#29](https://github.com/jmenga/effect-dynamodb/issues/29))

  The write paths (`put`, `create`, `update`, `upsert`, `append`, batch/transaction puts) now run `Schema.encode` end-to-end against the entity's input/update schema so any Effect Schema transform (e.g. `Schema.RedactedFromValue`, `Schema.NumberFromString`, `Schema.DateTimeUtcFromString`, custom `decodeTo` chains) round-trips cleanly. Previously the put path validated against the encoded form, which rejected domain instances like `Redacted.make(...)` with `Invalid data <redacted>`.

  Storage-format substitution: at `Entity.make()` time, self date schemas (`Schema.DateTimeUtc`, `Schema.DateTimeZoned`, `Schema.DateValid`) carrying a `DynamoEncoding` annotation are substituted with bidirectional date transforms whose wire format matches the legacy `serializeDateForDynamo` output byte-for-byte. `Schema.RedactedFromValue(...)` fields are substituted with a tolerant Redacted transform (Effect v4's `RedactedFromValue` forbids encoding by default).

  **Breaking change** (narrow): combining a transform schema with a `DynamoEncoding` storage override now raises a clear error at `Entity.make()` time, e.g.

  ```
  [effect-dynamodb] Field "createdAt": cannot apply DynamoEncoding storage override to a transform schema. Either declare a self schema (Schema.DateTimeUtc) and let the annotation drive storage, OR declare a transform and own the wire format — not both.
  ```

  Migrate by either declaring a self schema (`Schema.DateTimeUtc.pipe(DynamoModel.storedAs(...))`) or dropping the override.

  Closes [#29](https://github.com/jmenga/effect-dynamodb/issues/29).

## 1.3.3

### Patch Changes

- [#28](https://github.com/jmenga/effect-dynamodb/pull/28) [`520035b`](https://github.com/jmenga/effect-dynamodb/commit/520035b844e1c49b06bbaefdeba7d99e522b63b5) Thanks [@jmenga](https://github.com/jmenga)! - Fix: unique-constraint sentinels are now sparse — they are only written when every composing field is present on the record (mirrors GSI sparse semantics). Previously, `Entity.put` / `.create` and the related update / delete / restore / purge paths called `KeyComposer.serializeValue(undefined)`, which coerced missing values to the literal string `"undefined"` and synthesized a sentinel keyed on that string. The first record with the field unset succeeded; every subsequent record collided with a false `UniqueConstraintViolation` (issue [#25](https://github.com/jmenga/effect-dynamodb/issues/25)).

  The sparse rule applies symmetrically across all six sentinel sites: `put`/`create`, `update` rotation, hard-delete cleanup, soft-delete cleanup, `restore` re-establish, and `purge` cleanup. The update path now distinguishes four transition states — `undefined → undefined` (no-op), `undefined → defined` (Put only), `defined → undefined` (Delete only), and `defined → defined, changed` (Delete + Put) — instead of unconditionally rotating both sides.

  Migration: any deployment running 1.3.x with a unique constraint on an optional field may have phantom sentinel rows of the form `<entity>._unique.<name>#undefined`. The new code never reads or writes them, so they are harmless; clean them up with a one-time scan if desired.

## 1.3.2

### Patch Changes

- fix(entity): `decodeMarshalledItem` tolerates missing GSI key attributes on sparse-indexed items. `itemSchema` previously required every GSI pk/sk field as `Schema.String`, so decoding a DynamoDB Stream `NewImage` for an item whose GSI composites haven't been stamped yet (e.g. ingest-before-enrichment patterns) failed with `ValidationError: MissingKey`. GSI key fields are now `Schema.optional(Schema.String)` in `itemSchema`; primary pk/sk remain required. Closes [#16](https://github.com/jmenga/effect-dynamodb/issues/16).

## 1.3.1

### Patch Changes

- Fix: `Entity.update` retain path (`versioned: { retain: true }`) marshalled domain `DateTime.Utc` values as DynamoDB Maps, corrupting writes and breaking subsequent reads.

  **Regression introduced in 1.3.0.** The retain path built `newItem` by spreading `currentRaw` (storage primitives from DynamoDB) with `hydratedUpdates` (decoded via the new `fromSelf` variants, so date fields are domain `DateTime.Utc` instances), then called `toAttributeMap(newItem)` without a `serializeDateFields` pass. AWS SDK's `marshall` with `convertClassInstanceToMap: true` then stored the DateTime class as a Map:

  ```json
  "updatedAt": { "M": { "epochMilliseconds": { "N": "..." }, "~effect/time/DateTime": { "S": "..." }, "_tag": { "S": "Utc" } } }
  ```

  Subsequent reads failed with `deserializeDateFromDynamo: expected string for DateTime.Utc/string, got object`.

  **Fix:** Pre-serialize `hydratedUpdates` to storage primitives before merging into `newItem`, mirroring what the non-retain path already does. The system-field block reads from the serialized map, so user-supplied colliding `updatedAt` values also land as storage primitives (not Maps). Affects any entity with `versioned: { retain: true }` that has model-declared date fields or uses the collision-aware timestamp pattern from 1.3.0.

  Put, upsert, append, and non-retain update paths were already correct — only the retain path was missing the serialization step.

## 1.3.0

### Minor Changes

- Domain-value input decode, timestamp collision handling, and adaptive generation.

  **Fixes [#19](https://github.com/jmenga/effect-dynamodb/issues/19)** — `Entity.put/create/update/upsert` (and `Transaction`/`Batch` put paths) now correctly decode domain values. Previously, TypeScript said "pass me a `DateTime.Utc`" but the runtime decoded via a transform schema that expected an ISO string — callers who followed the TS contract hit a `ValidationError`. The runtime decode now uses `fromSelf` variants for date-annotated fields, matching the TS contract.

  **New: declare system-field-colliding timestamps in your model.** If your domain model declares `createdAt` / `updatedAt` with a date-compatible schema (e.g. `Schema.DateTimeUtcFromString`, `Schema.DateFromString`, `Schema.DateTimeUtc`), and `timestamps: true` is set:
  - The input type marks the colliding fields as optional — caller may omit them (library auto-generates) or supply their own value (user value wins, useful for imports/backfill).
  - The library-generated timestamp respects the model field's storage encoding, so declaring `createdAt: Schema.DateTimeUtcFromString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))` yields epoch-seconds storage even though the library is generating the value.
  - `createdAt` is treated as immutable in the update schema (stripped entirely).

  **New: user-owned non-date fields that collide with a system field name.** If your model declares e.g. `createdAt: Schema.String` (as a user-managed composite value, not a timestamp), the library detects the non-date collision and yields the field to the user — library timestamp management applies only to non-colliding fields (e.g. `updatedAt`). Preserves existing patterns that use `createdAt` as a plain string SK composite.

  **Errors:**
  - `EDD-9021` — the `version` field cannot be declared in the model alongside `versioned: true`, because optimistic locking requires library-managed increment.

  **Type ergonomics.** The exposed `inputSchema` / `createSchema` / `updateSchema` codec types (and the corresponding `Entity.put` / `create` / `update` call signatures) now flatten into plain object literals in hover tooltips instead of showing as wrapped generic aliases.

## 1.2.0

## 1.1.0

## 1.0.0

### Minor Changes

- [#4](https://github.com/jmenga/effect-dynamodb/pull/4) [`76654b7`](https://github.com/jmenga/effect-dynamodb/commit/76654b7a6d35a361fe74a2733bdfb1ce837504bf) Thanks [@jmenga](https://github.com/jmenga)! - Add `.primary()` query accessor on the bound client

  Every entity now exposes a `.primary(...)` accessor on `db.entities.*` alongside the existing GSI accessors. The primary index is treated symmetrically with GSIs: pass required PK composites (and optionally one or more SK composites) to get back a `BoundQuery` with the full combinator surface (`.where()`, `.filter()`, `.select()`, `.limit()`, `.reverse()`, `.startFrom()`, `.consistentRead()`, `.collect()`, `.fetch()`, `.paginate()`, `.count()`).

  Previously the primary index was deliberately excluded from accessor generation, so the shared-PK join-table pattern (many items under one partition key, distinguished by SK) had no first-class typed query path — only `.get(fullKey)` or a raw `Query.make` escape hatch.

  ```ts
  // List every membership in an organization — PK only, SK composites omitted
  const allMembers =
    yield *
    db.entities.Memberships.primary({
      orgId: "org-acme",
    }).collect();

  // Narrow by partial SK composite (begins_with prefix match)
  const bobs =
    yield *
    db.entities.Memberships.primary({
      orgId: "org-acme",
      userId: "u-bob",
    }).collect();
  ```

  `.get(fullKey)` remains the dedicated `GetItem` path for single-item strongly-consistent reads. Resolves [#2](https://github.com/jmenga/effect-dynamodb/issues/2).
