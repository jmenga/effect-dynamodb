---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Projections sharing a read model's rows (#237).

A read model several projections write carries a row token (`__edd_rt__`) on its rows: every projection write, and `create` over a tombstone, is conditioned on the token it read, so a write that read the row before another projection's write fails and retries instead of replacing it. A failed tokened write asks for the stored row (`ReturnValuesOnConditionCheckFailure: ALL_OLD`), so the `ConcurrentModification` it ends in, when retries run out, names what changed: the projection's own revision or checkpoint, the token, another projection's bookkeeping or the removal stamp.

**A read model on whose rows `__edd_rt__` is already a name its definitions use (a model field, a `field:` rename, a key attribute of its table or of any index on it, its `created` or `updated` timestamp, the table's TTL attribute, or an outbox's key or index attribute on its table) runs without the token, exactly as on 1.40.0: no token, the same requests, rows and refusals, and the user's value read back as stored. It doesn't get this release's protection for its rows: no write is conditioned on a token, and no tombstone or row keeps another projection's checkpoints. Rename the attribute holding that name to get it.** The decision is made from the definitions and the table's TTL attribute, never from what a stored row holds, so a stored `__edd_rt__` there is always the user's value.

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
