---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

A projection's `rebuild` enqueues nothing in the outbox (#237).

**On 1.40.0 a rebuild of a projection with an outbox wrote the effects of the events it re-derived into the outbox again, so each was delivered again. It now writes none, as the guide says. Anyone who used a rebuild to re-send effects must re-send them themselves.**

A rebuild, single- or multi-source, writes the rows it re-derives, with their checkpoints and revision as before, and no outbox item, whatever the row's stored state. Items already pending at the row are untouched and delivered once, and live delivery after the rebuild enqueues the effects of new events only. `effects` still runs in the rebuild's fold, so its failures decide the fold as they did, and the row written is the same.

**Request change: a rebuild's row write that carried outbox items is no longer a `TransactWriteItems` holding the row's `Put` and the items, but the write every projection write that enqueues nothing sends: a `PutItem` of the same item, conditioned on the row's guard.** Over a live row that is the revision read (`rev = :v`, the same condition under other placeholder names). Over a row read absent it is `create`'s condition, that nothing is at the row's key (`attribute_not_exists(<pk>) AND attribute_not_exists(<sk>)`), where the transaction asked only for no revision there; an item without a revision at the key then fails it as a lost race, and the retry writes over it as a row read with no revision. A tombstone's `Put` is sent as a `PutItem` unchanged.

A rebuild of a row behind its stream applies the events the row hadn't seen without their effects: if those effects matter, run `catchUp` first, which applies them with their effects. `catchUp` is unchanged. Another projection of the same read model whose checkpoint a rebuild drops, with its data, folds its stream again on its next event and enqueues those effects again, as on 1.40.0.
