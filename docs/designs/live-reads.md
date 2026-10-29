# Design: live reads — streaming changes to connected clients (#180)

**Issue:** [#180](https://github.com/jmenga/effect-dynamodb/issues/180)
**Status:** Proposed. Spikes run 2026-10-29 (§13); scoping decisions (§14) open for owner review before implementation.
**Builds on:** `change-feed.md` (#156), `stream-seal.md` (#166), Effect's `Reactivity` (`effect/unstable/reactivity`).
**Affected packages:** `packages/effect-dynamodb` (core: keys, write invalidation, live reads, `Live`; new subpath `effect-dynamodb/live/appsync`).
**Semver impact:** `minor`. Purely additive: new methods, a new layer and a new subpath. Existing operations don't change unless `Reactivity` is provided, in which case writes also invalidate (§4.2).

---

## 1. Summary

Server push needs each server instance to learn when the data its connected clients are watching changes, including writes made by other instances, Lambdas and other services. Push here means Effect RPC streaming over SSE or chunked HTTP, or WebSockets. DynamoDB has no way to push changes into a running process.

This adds **live reads**: `Stream`s that re-read a partition whenever it changes.

| API | Emits | Resumable |
|---|---|---|
| `eventStream.subscribe(streamId, { afterVersion })` | Each new event, in version order | Yes, exactly, from any version |
| `entity.watch(key)` | The item (`Option`) on start and on each change | Latest snapshot |
| `query.watch()` on a `BoundQuery` | The full result on start and on each change | Latest snapshot |

Live reads are **woken** by Effect's `Reactivity` and **hydrated** by DynamoDB reads. Two things wake them:

- **local writes** through effect-dynamodb in the same process;
- **a change-notification transport** carrying notifications from elsewhere: AWS AppSync Events (first adapter), or polling (no infrastructure).

A notification is thin: "partition *X* of table *T* changed", never the data. The table stays the source of truth. A lost, duplicated, reordered or late notification therefore costs at most an extra read or a slower update, never a wrong or missing event.

## 2. Background

### 2.1 The deployment problem

Instances behind a load balancer each hold some client connections. A write made anywhere must reach the clients connected to every instance.

AWS Lambda Web Functions (October 2026) make this pressing. A Web Function runs a standard HTTP server, and its constraints shape this design:
- **Concurrency:** up to 128 concurrent requests per environment.
- **Streaming:** SSE and chunked streaming are supported; incoming WebSockets are not.
- **Background work:** continues after a response is sent.
- **Request cap:** each request is cut at `timeoutSeconds` (900 s max).
- **Addressing:** idle environments are reclaimed after a few minutes, and an individual environment can't be addressed.

Two consequences follow. A client connection drops at least every 15 minutes and must resume without loss. And nothing can push into a chosen environment. ECS has the same routing problem, only without the request cap.

### 2.2 Approaches considered

| Approach | Verdict |
|---|---|
| Every instance reads DynamoDB Streams (`change-feed` in tail mode) | Rejected as the primary mechanism. AWS advises at most two concurrent readers per shard, counting Lambda triggers, Pipes and other consumers, so it stops at 1–2 instances. A position is a per-shard sequence number, not something a client can resume from. Order is per item, not per item collection, so two events of one aggregate on different shards can arrive out of version order. Every instance also processes every write to the table. |
| Kinesis Data Streams for DynamoDB with enhanced fan-out | Rejected. `SubscribeToShard` is real push, but a stream allows at most 20 registered consumers. Registration is too slow for environments that come and go, and records can be duplicated or out of order. |
| EventBridge rules | Rejected. They deliver to targets configured in advance; an instance that comes and goes isn't one. Per-instance queues and rules mean slow churn and orphaned resources. |
| Pipe pushing stream batches into the service over HTTP | Rejected. Each batch lands on an arbitrary environment. |
| Effect Cluster | Rejected for this purpose. It's point-to-point entity messaging, and runners must connect to each other directly, which Web Functions don't allow. |
| Managed pub/sub that instances subscribe to at runtime (AppSync Events, IoT Core, Valkey) | **Chosen as the push transport**, paired with table re-reads for correctness. AppSync Events first: a JSON WebSocket protocol small enough to implement on Effect's `Socket` with no dependency, higher per-connection subscription limits than IoT Core, and IAM auth. |
| Table polling | **Chosen** as the zero-infrastructure transport and as the safety net under push. |

## 3. Architecture

```
 writes: any instance, Lambda, service
            │
            ▼
        DynamoDB ──► Stream ──► Pipe (§6.3) ──► AppSync Events channel /edd/changes
            ▲                                      │ { table, item, partitions, version? }
            │                                      ▼
            │          ┌─ instance ─────────────────────────────────────────────┐
            │          │  transport receiver ───┐                                │
            │          │  local writes (§4.2) ──┴─► Reactivity.invalidate(keys)  │
            │          │                              │ wakes                    │
            └──────────┼── re-read ◄── followers (§5.1), one per watched key     │
                       │                  │ PubSub                               │
                       │                  ▼                                      │
                       │  subscribe / watch Streams ─► Effect RPC handlers ─────┼─► clients
                       └────────────────────────────────────────────────────────┘
```

## 4. Change keys

### 4.1 Definition

| Key | Names | Woken by a change to | Used by |
|---|---|---|---|
| **Partition** `(table, attribute, value)` | All items whose key attribute `attribute` (the table's partition key or a GSI's) equals `value` | Any item entering, changing in, or leaving the partition | `query.watch()`, `subscribe` |
| **Item** `(table, pk, sk)` | One item | That item | `entity.watch` |

- **Physical names throughout:** the table name and attribute names are physical. They read the same in a composed query and in a stream record, so a publisher needs nothing but the record.
- **Sharing an attribute:** two GSIs that share a partition-key attribute share partition keys. A notification for one wakes readers of both, which is harmless: an extra read.
- **Array form in `Reactivity`:** keys are passed as strings in array form, not record form. A record-form registration (`{ table: [id] }`) also registers on the bare table name, so it would wake on every write to the table.
- **`Live.keys.item(entity, key)` / `Live.keys.partition(query)`** expose the derivation, so application code can run its own `Reactivity.stream` reads against the same wake-ups.

### 4.2 Keys of a local write

`DynamoClient.make` and `EventStore.bind` capture `Reactivity` from context at bind time, the same way they capture `Embedder` and `Compression`. When it's present, each successful write invalidates the following, computed from the keys the write composed (never by parsing expressions):
- the item key and its table-partition key;
- each GSI partition whose partition-key attribute the write **sets**: every GSI key present on a put, and the GSI keys the policy-aware composer sets on an update.

Covered write paths:
- `put` / `create` / `upsert`, `update` and `delete`;
- `Transaction.transactWrite` and `Batch.write`;
- aggregate writes;
- EventStore `append` and `commandHandler`;
- time-series `append`;
- soft delete, restore and purge.

The keys of a multi-item operation are invalidated once, inside `Reactivity.withBatch`, after it succeeds.

**Not known locally:** the GSI partition an item *leaves* on an update or delete. Learning it would need the old image, through `ReturnValues`, and changing return values isn't worth it. The remote notification covers it (§4.3). So local invalidation is an optimisation that makes an instance's own writes appear at once; the transport is what makes live reads correct.

### 4.3 Keys of a stream record

`ChangeNotification.fromStreamRecords(tables, records)` is pure: no AWS SDK, and it accepts both Lambda- and SDK-shaped records.
- **Item:** taken from `Keys`, which every stream view type includes.
- **Partitions:**
  - the table's partition key, from `Keys`;
  - every GSI partition-key attribute present in `NewImage` or `OldImage`, deduplicated. The attribute list comes from the table definition: the indexes of its registered entities, plus EventStore stream indexes.
- **Version (optional):** the event version for an EventStore event item, or `version` for a versioned entity. Receivers use it to skip a re-read a follower has already covered.

What each stream view type supports:
- `KEYS_ONLY` is enough for `entity.watch`, `subscribe` and queries on the table's own key.
- GSI query watches need `NEW_IMAGE` to see items enter or change in a partition, and `NEW_AND_OLD_IMAGES` to see them leave one.
- The guide recommends `NEW_AND_OLD_IMAGES`.

Wire format: compact, versioned JSON. One AppSync event carries **all the notifications of a stream batch** (spike 2, §13). Each notification is a few hundred bytes, so a batch of 100 records is one publish of about 30 KB, well under AppSync's 240 KB event limit.

```json
{"f":1,"n":[
  {"t":"main-table","i":["$app#v1#order#o-1","$app#v1#order"],
   "p":[["pk","$app#v1#order#o-1"],["gsi1pk","$app#v1#customer#c-9"]],"v":42}
]}
```

## 5. Live reads

### 5.1 Followers

A **follower** is a process-wide reader for one live-read identity: an event stream, an item, or a compiled query. Every subscriber to that identity shares it.

- **Registration.** A follower registers through `Reactivity.query(read, keys)`, which registers the handler *before* the first read. A change landing between the read and the registration therefore can't be missed. If invalidations arrive while a read is running, they trigger exactly one more read when it finishes.
- **Lifecycle.** Followers are ref-counted. The first subscriber starts one, scoped to the `Live` layer. It stops a short linger after the last subscriber leaves (default 5 s), which absorbs reconnect churn, such as every client of an environment reconnecting at the request cap.
- **Consistency.** Base-table reads are strongly consistent: a notification arrives after the write committed, but an eventually consistent read could still miss it. GSI reads can't be strongly consistent, so a GSI follower schedules one **settle re-read** (default 1 s) after each wake.
- **Errors.** Throttling and internal server errors are retried with jittered backoff. Anything else, such as a `ValidationError` decoding a stored item, fails every current subscriber; the next subscriber starts a fresh follower.
- **Interest.** The registry tracks which keys have followers. A notification whose keys have none is dropped without a read. The sweep (§6.1) and polling wake exactly the followed keys.

### 5.2 `eventStream.subscribe`

```ts
subscribe(
  streamId: StreamIdInput<TStreamIdFields>,
  options?: { readonly afterVersion?: number | "latest" },  // default 0: from the start
): Stream.Stream<StreamEvent<TEvent, StreamMetadata<TMetadata>>, DynamoClientError | ValidationError>
```

- **Follower:** keyed on the stream's partition. It keeps a head cursor; on each wake it reads `readFrom(head)` with a consistent read, publishes the new events to a `PubSub`, and advances the head.
- **Joining:** a subscriber first subscribes to the follower's `PubSub`, then catches up from its own `afterVersion` with `readFrom`, then emits buffered events whose version is greater than the last one it emitted. Each event is delivered once, in order, with no gap between the catch-up and the live part.
- **Slow subscribers:** each has a bounded buffer (default 1,024 events). On overflow the buffer is dropped and the subscriber goes back to catching up from its last emitted version. A slow client never blocks the follower or other clients.
- **Ending:** the stream ends after emitting an event with `sealed: true` (#166), because a sealed stream accepts no more events. Otherwise it runs until interrupted.
- `"latest"` reads `currentVersion` first and starts after it.

### 5.3 `entity.watch`

```ts
watch(key: Entity.Key<E>): Stream.Stream<Option.Option<Model>, DynamoClientError | ValidationError>
```

- **Follower:** keyed on the item. On each wake it does a consistent `get` and emits when the item changed. Changed means a different `version` for versioned entities, otherwise a different `updatedAt` with timestamps, otherwise structural inequality of the stored item.
- **Values:** it emits the current value first. An absent item, including a deleted or soft-deleted one, is `Option.none()`. The value is the model type, as with `get`.
- **Slow subscribers:** each subscriber buffers only the latest value, so a slow client gets the newest snapshot and skips the ones in between.

### 5.4 `query.watch()`

```ts
db.entities.Tasks.byProject({ project }).filter(...).limit(50).watch()
// Stream<ReadonlyArray<Task>, DynamoClientError | ValidationError>
```

- **Terminal:** it's a terminal like `.collect()`, and the usual combinators apply (`where`, `filter`, `select`, `limit`, `maxPages`, `reverse`).
- **Follower:** keyed on the query's partition (the table or GSI partition key and composed value from the query state's `pkField` / `pkValue`). The follower is identified by the compiled query input, and on each wake it re-runs `collect`.
- **Emits** the result when it differs from the previous one: different item keys, or a different change marker per item (as in §5.3). Slow subscribers get the latest result.
- **Result size:** the result must be bounded. Without an explicit `limit` or `maxPages`, `watch()` applies `maxPages(1)` (at most 1 MB per re-read).
- **Not available:** scan mode (no partition) and collection queries (§11).

### 5.5 Requirements

- Live methods keep `R = never`: they use the `Reactivity` and live registry captured at bind time (§4.2).
- Calling a live method on a client bound without `Live.layer` in context is a configuration defect: `[EDD-90xx]`, naming the layer to provide.
- Writes invalidate whenever `Reactivity` is captured, with or without the live layer. Application `Reactivity.stream` reads keyed with `Live.keys.*` then see local writes even with no transport.

## 6. Transports

### 6.1 `Live.layer`

```ts
Live.layer(options: {
  readonly transport: ChangeTransport
  readonly sweepInterval?: Duration.Input   // default 30 seconds
  readonly linger?: Duration.Input          // default 5 seconds (§5.1)
}): Layer.Layer<LiveRegistry, never, Reactivity>
```

- **What it provides:** the registry, and it runs the transport for the layer's lifetime. It requires `Reactivity` rather than creating one, so the application's other `Reactivity` users (e.g. `SqlClient`) share it.
- **The transport's job:** deliver notifications to the registry, which turns them into `Reactivity.invalidate` calls for followed keys.
- **The sweep:** every `sweepInterval`, and whenever the transport (re)connects, all followed keys are woken. A lost notification, or a stretch while the transport was disconnected, therefore heals within one sweep.
- **Transport failures** (connection drops, auth errors, protocol errors) are logged and retried with jittered backoff. They never fail a live read; they only make updates slower until the sweep catches up.

Transports in the first cut:

| Transport | Where | Behaviour |
|---|---|---|
| `Live.polling({ interval, maxInterval })` | core | Wakes each followed key every `interval`. It backs off ×2 per idle wake up to `maxInterval`, and resets after a wake that found a change. No infrastructure. |
| `Live.memory()` | core | An in-process transport with a `publish` function, for tests and single-process apps. |
| `AppSyncEvents.receiver(...)` | `effect-dynamodb/live/appsync` | §6.2 |

### 6.2 AppSync Events receiver

```ts
AppSyncEvents.receiver({
  realtimeUrl: "wss://<id>.appsync-realtime-api.<region>.amazonaws.com/event/realtime",
  httpHost: "<id>.appsync-api.<region>.amazonaws.com",
  channel: "/edd/changes",
  auth: AppSyncEvents.auth.iam({ region, credentials }),
})
```

- **Runtime-neutral.** It's built on `Socket.makeWebSocket` with the `WebSocketConstructor` service, which uses the global `WebSocket` in Node ≥ 22, Bun, Deno and Workers. No `ws` dependency.
- **Protocol:**
  - **Connect:** subprotocols `aws-appsync-event-ws` and `header-<base64url(auth)>`, then `connection_init` → `connection_ack { connectionTimeoutMs }`.
  - **Keep-alive:** a `ka` arrives about every 60 s; the receiver reconnects if none arrives within `connectionTimeoutMs`.
  - **Subscribe:** `subscribe { id, channel, authorization }` → `subscribe_success` / `subscribe_error`.
  - **Messages:** `data { id, event: string[] }`; a `broadcast_error` is logged.
  - **Lifetime:** AppSync caps a connection at 24 h. Reconnecting is routine, and each reconnect triggers a sweep.
- **Channel.** One fixed channel by default. Every instance receives every notification and drops the ones it doesn't follow (§5.1). Channel names are 1–5 segments of up to 50 `[A-Za-z0-9-]` characters, so raw keys can't be channel names. Bucketed channels (hashing keys into `/edd/b17` and so on) are a follow-up (§11).
- **Auth:**
  - **`auth.apiKey(key)`:** no dependencies.
  - **`auth.iam({ region, credentials })`:** SigV4 signs the connect and each subscribe, using `@smithy/signature-v4` and `@aws-crypto/sha256-js` as optional peer dependencies (both pure JS). The caller supplies credentials (e.g. the AWS SDK's `fromNodeProviderChain()`), so the library picks no runtime-specific provider.
  - **`auth.token(effect)`:** for Cognito, OIDC and Lambda authorizers.
- **Isolation.** The subpath stays out of the main entry's import graph, enforced by a guard test like `change-feed`'s.

### 6.3 Publishing

Each option below takes one of the stream's two reader slots (§2.2). They share a pure core:
- `ChangeNotification.fromStreamRecords` (§4.3);
- `AppSyncEvents.publishBody(channel, notifications)`, which builds a single publish body whose one event (a stringified JSON value) carries every notification. It's escaped by `JSON.stringify`, so any key value is safe.

1. **Pipe with an enrichment Lambda (recommended).**
   - **Source:** the table's stream. **Filter:** the item types that matter (e.g. `__edd_e__`).
   - **Enrichment:** a Lambda that calls `AppSyncEvents.enrich({ tables, channel })(records)`. It returns **one** publish body per batch, never an array (spike 2).
   - **Target:** an API destination posting to `https://<httpHost>/event`, through a connection that carries the `x-api-key` header.
   - **Required Pipe settings**, which the guide documents and an infrastructure-as-code snippet carries:
     - `BatchSize` ≤ 100, which keeps one batch's notifications inside one 240 KB event;
     - `MaximumBatchingWindowInSeconds: 0` (latency);
     - a bounded `MaximumRetryAttempts` (e.g. 5) and `MaximumRecordAgeInSeconds` (e.g. 300). By default a Pipe retries a failed batch indefinitely, which stalls every later notification on that shard. A dropped batch is healed by the sweep.
2. **A `changeFeed` sink:** `Live.publishChangeFeed(feed, publish)` runs `fromStreamRecords` on each batch, publishes it, then commits the batch. It's for deployments already running a leased change-feed consumer (§6 of `change-feed.md`), and needs no Pipe. On Web Functions the lease moves between environments as they come and go; the sweep covers the handover. A batch larger than one event allows is split across several publishes, because the sink makes its own HTTP calls.

**No Pipe without code.** A Pipe that uses only an input transformer was dropped after spike 1. The transformer escapes a value once, for the outer JSON, so a key containing a quote, backslash or control character becomes an invalid event. AppSync then reports the bad event in its `failed` array with HTTP 200, so the Pipe records success and the notification is lost with no retry and no dead-letter queue.

**AppSync's HTTP 200 can still mean failure.** AppSync's publish endpoint returns 200 even when it rejects an event, listing it in `failed`. The library's publishers (the change-feed sink, and anything built on `publishBody`) treat a non-empty `failed` as a publish error.

Publish failures are retried by the Pipe (bounded, as above) or by the change-feed's batch retry. A notification lost for good is healed by the sweep. A newly created or updated Pipe that starts at `LATEST` can miss writes made in its first minute or two (§13), which the sweep also covers.

## 7. Effect RPC end to end (illustrative)

```ts
class LiveRpcs extends RpcGroup.make(
  Rpc.make("SubscribeOrder", {
    payload: { orderId: Schema.String, afterVersion: Schema.Number },
    success: OrderEventMessage,
    stream: true,
  }),
  Rpc.make("WatchTask", {
    payload: { taskId: Schema.String },
    success: Schema.Option(Task),
    stream: true,
  }),
) {}

const LiveRpcsHandlers = LiveRpcs.toLayer(
  Effect.gen(function* () {
    const orders = yield* EventStore.bind(OrderStream)
    const db = yield* DynamoClient.make({ entities: { Tasks }, tables: { MainTable } })
    return {
      SubscribeOrder: ({ orderId, afterVersion }) =>
        orders.subscribe({ orderId }, { afterVersion }).pipe(Stream.map(toMessage)),
      WatchTask: ({ taskId }) => db.entities.Tasks.watch({ taskId }),
    }
  }),
)

const LiveLayer = Live.layer({
  transport: AppSyncEvents.receiver({ realtimeUrl, httpHost, channel: "/edd/changes", auth }),
}).pipe(Layer.provideMerge(Reactivity.layer))
```

**Client resume (documented recipe, not shipped).** The client keeps the last version it received. When the stream fails, for example when a Web Function cuts the request at `timeoutSeconds`, it resubscribes from that version:

```ts
const followOrder = (client: RpcClient.FromGroup<typeof LiveRpcs>, orderId: string) =>
  Stream.unwrap(
    Effect.map(Ref.make(0), (last) =>
      Stream.unwrap(
        Effect.map(Ref.get(last), (afterVersion) => client.SubscribeOrder({ orderId, afterVersion })),
      ).pipe(
        Stream.tap((event) => Ref.set(last, event.version)),
        Stream.retry(Schedule.exponential("100 millis").pipe(Schedule.jittered)),
      ),
    ),
  )
```

## 8. Platform notes

- **Lambda Web Functions** (confirmed by spikes 3 and 4, §13)
  - The transport receiver and followers run as background fibers in the `Live` layer's scope. They keep receiving while no request is in flight, and live as long as the environment.
  - An idle environment is still reclaimed even with the receiver's WebSocket open, so scale-to-zero and memory billing are unaffected. The next environment's receiver connects on start-up.
  - Effect RPC's chunked `application/ndjson` responses (not `text/event-stream`) stream as they're written.
  - Requests are cut at `timeoutSeconds`. The Effect RPC client sees the cut as a stream failure, `RpcClientError` (*"HTTP response ended before RPC request completed"*), not as a clean end. So the `Stream.retry` resume recipe in §7 catches it, and clients resume from their last version.
- **ECS:** the same design, with no request cap; load-balancer idle timeouts apply.
- **Single instance:** `Live.polling` alone, or local invalidation alone if every write goes through the one instance.

## 9. Cost

- **Reads.** Each wake costs one read per followed key per instance, not per client. Base-table follower reads are consistent, at 1 RRU per 4 KB. With polling at 1 Hz, an idle followed key costs about 2.6M RRU a month per instance; backing off to `maxInterval` cuts that by the idle ratio.
- **AppSync Events.** Charged per publish operation, per delivered message and per connection-minute. With a single channel, each notification is delivered once to every instance.
- **Pipe.** Charged per request, plus the enrichment Lambda.

## 10. Errors

- **No new runtime error types.** Live reads fail with the errors of the read they run (`DynamoClientError | ValidationError`). Transport errors are internal: logged and retried (§6.1).
- **Configuration defects:**
  - a live method on a client bound without `Live.layer`;
  - `watch()` on a scan;
  - an invalid AppSync channel name;
  - `linger` or `sweepInterval` out of range.

  Codes are assigned at implementation, after the codes taken by in-flight work.

## 11. Phasing

**This issue, one PR:**
1. **Foundation:** change keys, local-write invalidation on every write path, the registry and followers, `Live.layer`, `Live.polling`, `Live.memory`, `ChangeNotification.fromStreamRecords` and `Live.publishChangeFeed`.
2. **Live reads:** `eventStream.subscribe`, `entity.watch` and `query.watch()`.
3. **AppSync Events:** receiver, auth, `publishBody` and `enrich`. Plus the guide (`guides/live-reads.mdx`), an example (`examples/guide-live-reads.ts`) using `Live.polling` against DynamoDB Local, and a `DESIGN.md` section.

**Follow-up issues:**
- live collection queries, aggregate `watch` (re-assembled on change), time-series `history().watch()`, geo queries and `readIndex` subscriptions;
- bucketed AppSync channels, which need a publisher that can hash (enrichment or change-feed sink), with receivers subscribing per bucket;
- IoT Core and Valkey transports;
- delta subscriptions for queries (a cursor on the sort key);
- a shipped client-side resume helper.

## 12. Testing

- **Unit:**
  - **Key derivation** from entity, index and EventStore definitions, and from stream records:
    - sparse GSIs (the attribute is absent);
    - partition moves (old and new images);
    - `KEYS_ONLY` versus image view types;
    - EventStore stream indexes;
    - Lambda- and SDK-shaped records.
  - **Local invalidation** on every write path in §4.2, including failure (nothing invalidated) and multi-item batching.
  - **Followers**, under `TestClock` and `Live.memory`:
    - registration before the first read;
    - coalescing invalidations during a read;
    - `subscribe` joining at, before and after the head;
    - slow-subscriber fallback to catch-up;
    - sealed streams ending;
    - `watch` change detection (version, `updatedAt`, structural);
    - GSI settle re-reads;
    - linger;
    - sweep and reconnect wakes;
    - interest filtering.
  - **AppSync receiver** against a mock `WebSocketConstructor`:
    - the handshake and subprotocol encoding;
    - keep-alive timeout and reconnect;
    - `subscribe_error` and `broadcast_error`;
    - SigV4 headers for a fixed clock and credentials;
    - `publishBody` packing and escaping (quote, backslash, control characters and Unicode in key values: the spike 1 failure cases);
    - a 200 response with a non-empty `failed` array treated as a publish error.
- **Connected (DynamoDB Local):** two bound clients, one writing and one watching.
  - Writes are delivered through local invalidation.
  - A `changeFeed` publishing to `Live.memory` delivers writes from the other client, including a GSI partition move.
  - `Live.polling` delivers them with no publisher.
- **Gap:** AppSync has no local emulator, so its adapter is covered by unit tests only. A manual script against a real AppSync Events API goes in the guide.

## 13. Spike results (2026-10-29)

The spikes ran in us-east-1 against real services:
- a DynamoDB table (`NEW_AND_OLD_IMAGES`);
- an AppSync Events API (API key);
- two EventBridge Pipes through an API destination;
- a Lambda Web Function running Effect `4.0.0-rc.109` with `@effect/platform-node`.

Latencies were measured from the client machine (6 ms from the CloudFront edge). Everything was deleted afterwards.

| # | Question | Result |
|---|---|---|
| 1 | Can a Pipe input transformer emit AppSync's stringified-event body safely? | **No.** Plain and Unicode keys arrived. Keys containing a quote, backslash, newline or tab were silently dropped: the transformer escapes once, for the outer JSON. AppSync answered 200 and listed the event in `failed`, and the Pipe logged a successful target invocation. The no-code Pipe option was removed (§6.3). |
| 2 | Does a Pipe deliver each element of an enrichment Lambda's array to an API destination? | **No.** An API destination accepts exactly one event per invocation. A Lambda returning 2 or more elements fails the batch (*"Events received a batch size of 2 events and only accepts 1"*, HTTP 400), and the default retry policy then stalled the shard (30 failed attempts). Returning **one object per batch, with all notifications in one event**, delivered 45 of 45, quote, backslash, newline, tab and Unicode keys included, in batches up to the configured 10. The wire format and the enrichment contract were changed accordingly (§4.3, §6.3). |
| 3 | Can a Web Function environment keep an outgoing WebSocket going in the background while idle? | **Yes.** Over 3 minutes with no request in flight, the background receiver got 35 of 35 events (p50 253 ms, max 420 ms, from publish to receipt). Keep-alives kept arriving and nothing disconnected. The receiver connected as soon as the environment started. |
| 3b | Does an open background WebSocket keep an idle environment alive? | **No.** After 8 minutes with no requests, the environment had been reclaimed. The next request cold-started a new environment, whose receiver connected immediately. Scale-to-zero still works. |
| 4 | Do Web Functions stream Effect RPC's chunked `application/ndjson` responses as they're written? | **Yes.** A streaming RPC sending an element every 500 ms delivered 20 of 20, with arrival gaps of 493–508 ms (first element at 359 ms). A raw `application/ndjson` route behaved the same. |
| 4b | What does the client see when `timeoutSeconds` cuts a stream? | A 1-per-second stream on a 120 s timeout delivered 120 elements. The client's stream then **failed** at 120.3 s with `RpcClientError` (*"HTTP response ended before RPC request completed"*), a typed failure that `Stream.retry` catches (§7, §8). |
| 5 | What delivery rate does one AppSync Events connection sustain on one channel? | **No ceiling found up to 5,000 events/s.** At 50, 200, 500, 1,000, 2,000 and 5,000 events/s for 10 s each, 100% of events were delivered (50,000 of 50,000 at the top rate), with p50 about 150 ms and p99 about 420 ms. Because notifications are batched one event per stream batch, the event rate is far below the write rate. The single channel stands; bucketing stays a follow-up. |

**End-to-end latency** was measured from the write call to an AppSync receiver, over 10 writes spaced 3 s apart, with a batching window of 0:

| Path | p50 | min | max |
|---|---|---|---|
| Transformer-only Pipe | 506 ms | 357 ms | 1,473 ms |
| Enrichment Pipe | 585 ms | 412 ms | 1,500 ms |

The enrichment Lambda adds about 80 ms. A 2 s batching window raised p50 to about 2 s.

**Pipe start-up.** A Pipe created, or just updated, with `StartingPosition: LATEST` processed nothing written in its first minute or two after reporting `RUNNING`. This is an operational note, and the sweep covers it.

**Web Functions.** The minimum for `--max-environments` is 2. `aws lambda-web deploy` creates an execution role named `awscli-lambdaweb-<name>` and uploads into a managed bucket, `awscli-lambdaweb-<account>-<region>-an`.

## 14. Scoping decisions (for owner review)

| # | Decision | Proposed |
|---|---|---|
| S1 | Mechanism: re-read the table on thin notifications (keys only) | In |
| S2 | Wake-up primitive: Effect's `Reactivity` (array-form string keys), shared with the app | In |
| S3 | Local writes invalidate on every write path when `Reactivity` is captured | In |
| S4 | First live reads: `eventStream.subscribe`, `entity.watch`, `query.watch()` | In |
| S5 | Naming: `watch` for snapshots, `subscribe` for event deltas (earlier sketches said `.live()`) | Proposed |
| S6 | `subscribe` ends after a sealed event | In |
| S7 | Consistent reads for base-table followers; settle re-read for GSI followers | In |
| S8 | `query.watch()` defaults to `maxPages(1)` when unbounded | In |
| S9 | Transports: polling and memory (core), AppSync Events (subpath) | In |
| S10 | AppSync auth: API key, IAM (optional peer dependencies, caller-supplied credentials), bearer token | In |
| S11 | Publishers: enrichment function (one body per batch) and `changeFeed` sink. The input-transformer template is dropped (spike 1) | In |
| S20 | Documented Pipe settings: `BatchSize` ≤ 100, no batching window, bounded retries and record age (spike 2) | In |
| S12 | Single fixed channel; bucketed channels deferred | Out (follow-up) |
| S13 | Collections, aggregates, time-series `history`, geo, `readIndex` subscriptions | Out (follow-up) |
| S14 | IoT Core and Valkey transports | Out (follow-up) |
| S15 | Delta subscriptions for queries | Out (follow-up) |
| S16 | Browser clients subscribing to AppSync directly | Out |
| S17 | Client resume helper: documented recipe only | Out (recipe) |
| S18 | Per-instance stream tailing as a supported mode | Out (documented as an alternative for single instances) |
| S19 | Live code in core (no new dependencies); only AppSync in a subpath | Proposed |
