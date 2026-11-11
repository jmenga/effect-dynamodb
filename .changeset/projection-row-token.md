---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Projections sharing a read model's rows (#237). A read model several projections write carries a row token (`__edd_rt__`) on its rows: every projection write, and `create` over a tombstone, is conditioned on the token it read, so a write that read the row before another projection's write fails and retries instead of replacing it. A tombstone keeps the other projections' checkpoints and revision, and a row written over it keeps them, so their redeliveries are recognised instead of applying again, bringing a removed row back or removing a row written after the removal. A read model with one projection carries no token and sends what 1.40.0 did, except that a projection with `removal` and no revision, writing over a tombstone it read, now checks it is still a tombstone, so it no longer replaces a row `create` wrote there.
