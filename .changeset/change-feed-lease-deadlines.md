---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Keep a change feed from committing after its lease can have lapsed. A lease renewal the store never answers now ends the feed with `ChangeFeedLeaseLost` at the renewal deadline, without waiting for the call. The deadline and the renewal schedule count from before the write that took or renewed the lease, so a slow store can't push them past the lease's expiry. An attempt to take the lease that fails or is interrupted now releases it, in case its write landed, and a release that gets no answer holds the feed's end for `renewEvery` at most. The in-memory store now treats a lease as held at its exact expiry, as the DynamoDB store does.
