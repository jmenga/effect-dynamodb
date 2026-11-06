---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Interrupting a call now ends its request. Every `DynamoClient` and `DynamoStreamsClient` operation passes Effect's abort signal to the SDK, so the connection closes and the SDK makes no further attempt. Aborting ends the wait, not the request: a write already sent may still be applied, and a caller who needs to know settles it with a conditional write or an idempotency token.

`DynamoClient.layer`, `DynamoClient.layerConfig` and the `DynamoStreamsClient` layers accept `requestHandler` (a handler, or the options of the runtime's handler) and `maxAttempts`, passed to the SDK client with no defaults and no platform handler imported. `layerConfig` reads `maxAttempts` and the handler's timeouts through `Config`. A request in flight when a layer's client is destroyed now fails with a `ClientClosedError` cause instead of being sent again on a new connection.

The change feed closes the two gaps its lease had. A renewal left unanswered is now aborted and retried inside the `duration − 2 × renewEvery` window, so one hung request no longer costs the lease. Each attempt waits `renewEvery` at most, and until one has gone unanswered it leaves a quarter of the time left for the retry, so at the default ratio a renewal slower than three quarters of `renewEvery` is aborted where it was once waited for. A feed read that times out, with a timeout configured on the client's handler, is now retried like other transient errors instead of ending the feed.
