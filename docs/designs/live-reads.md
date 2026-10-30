# Design: live reads — streaming changes to connected clients (#180)

**Issue:** [#180](https://github.com/jmenga/effect-dynamodb/issues/180)
**Status:** Proposed. Spikes run 2026-10-29 and 2026-10-30 (§13); scoping decisions (§14) open for owner review before implementation.
**Builds on:** `change-feed.md` (#156), `stream-seal.md` (#166), Effect's `Reactivity` (`effect/unstable/reactivity`).
**Affected packages:** `packages/effect-dynamodb` (core: keys, write invalidation, live reads, `Live`, the publish pipeline; new subpath `effect-dynamodb/live/appsync`, free of the AWS SDK so browsers can use it in direct mode).
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

Notifications come from one publisher: a Lambda function triggered by the table's stream, built as an Effect pipeline that ends in a publish `Sink` (§6.3). Two delivery modes share everything up to the channel:
- **Server mode.** Every server instance receives every notification on one broadcast channel, re-reads, and pushes to its clients over Effect RPC streams (§5.1–§5.4).
- **Direct mode.** Clients subscribe to AppSync themselves, one channel per partition, and re-read through the application's own RPC on each notification (§5.6). No server holds a long-lived request, which matters on Web Functions, where an open stream occupies a request slot (§8).

## 2. Background

### 2.1 The deployment problem

Instances behind a load balancer each hold some client connections. A write made anywhere must reach the clients connected to every instance.

AWS Lambda Web Functions (October 2026) make this pressing. A Web Function runs a standard HTTP server, and its constraints shape this design:
- **Concurrency:** 64 concurrent requests per environment by default (`--max-concurrency-per-environment`), across at most `--max-environments` environments. An open streaming response holds a slot for its whole life; once every slot is taken, every further request is rejected with HTTP 429 (spike 9, §13.2).
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
| Managed pub/sub that instances subscribe to at runtime (AppSync Events, IoT Core, Valkey) | **Chosen as the push transport**, paired with table re-reads for correctness. AppSync Events first: a JSON WebSocket protocol small enough to implement on Effect's `Socket` with no dependency, 200 subscriptions per connection (IoT Core: 50), no per-connection delivery cap (IoT Core: 100 messages/s per connection, in and out combined, not adjustable, which a broadcast receiver hits first), and IAM auth. Prices are equal below about a billion messages a month (§9). |
| Table polling | **Chosen** as the zero-infrastructure transport and as the safety net under push. |
| An EventBridge Pipe from the stream to AppSync | **Replaced** by a Lambda stream trigger (§6.3). A Pipe needs a Lambda anyway (spikes 1 and 2), and the trigger alone gives the same batching, filtering and bounded retries without the extra hop and per-request charge. |
| Effect RPC as the client's transport to AppSync (direct mode) | Not possible as an RPC protocol: RPC replies are correlated to a request and produced by a handler, and a channel has neither. Direct-mode clients consume the channel as a `Stream` and read through ordinary RPC calls (§5.6). |

## 3. Architecture

```
 writes: any instance, Lambda, service
            │
            ▼
        DynamoDB ──► Stream ──► Lambda trigger (§6.3)
                                records ─► filter ─► notifications ─► publish Sink
                                                                         │
                              ┌──────────────────────────────────────────┴──────────────────┐
                              ▼ /edd/changes (server mode)                                  ▼ /edd/p/<hash> (direct mode)

 Server mode (§5.1–§5.4)                                   Direct mode (§5.6)
 ┌─ instance ──────────────────────────────────────┐       ┌─ client (browser, app) ─────────────────────┐
 │ receiver ──────────┐                            │       │ one subscription per followed partition     │
 │ local writes (§4.2)┴─► Reactivity.invalidate    │       │   └─► follower ─► read through the app's   ─┼─► short RPC
 │                          │ wakes                │       │       RPC on notification, reconnect, sweep │   (get / query)
 │ followers (§5.1) ─► re-read DynamoDB            │       └─────────────────────────────────────────────┘
 │   └─► subscribe / watch ─► Effect RPC streams ──┼─► clients
 └─────────────────────────────────────────────────┘
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

Wire format: compact, versioned JSON. Notifications are packed into events of up to 5 KB, AppSync's metering unit, and a publish request carries up to 5 events for one channel. A notification is about 170 bytes, so a full event carries about 24 (spike 6, §13.2).

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

### 5.6 Direct mode

Clients subscribe to AppSync themselves and read through the application's RPC. The server only serves short requests.

```ts
// server: an ordinary, authorized read
Rpc.make("GetTask", { payload: { taskId: Schema.String }, success: Schema.Option(Task) })

// client: follow the task's partition on AppSync, read through RPC
const task = AppSyncEvents.follow({
  connection,                                          // one AppSync connection per client
  channel: Live.channels.partition(Tasks, { taskId }),
  match: Live.keys.item(Tasks, { taskId }),            // ignore other items in the same partition
  read: client.GetTask({ taskId }),
}) // Stream<Option<Task>, ...>
```

- **Same follower.** It's the §5.1 follower with the read swapped for an RPC call. It reads on start, after each matching notification (coalescing those that arrive mid-read), on every reconnect, and every `sweepInterval`. A query follows the same way: a query RPC, keyed on the query's partition.
- **Channels.**
  - Format: `/edd/p/<32 hex>`, the first 128 bits of SHA-256 over (table, attribute, value).
  - Computed in the client: from the entity definition and key values, through `@effect-dynamodb/schema` and WebCrypto, so no AWS SDK reaches a browser bundle.
  - What each carries: only its own partition's notifications (spike 7a). A GSI partition gets its own channel.
- **Security.**
  - **Wildcards.** AppSync accepts wildcard subscriptions: with API-key auth, `/edd/*` received every notification on every channel (spike 7a).
  - **Required guard.** The namespace needs an `onSubscribe` handler that rejects any path containing `*`, and the guide ships it:
    ```js
    export function onSubscribe(ctx) {
      if (ctx.info.channel.path.includes("*")) util.unauthorized()
    }
    ```
  - **Deploy the guard first.** A handler change took 2–5 minutes to reach every AppSync node, with mixed results in between (spike 7c), so it must be in place before clients connect.
  - **What a channel name reveals.** A channel derived from public key values tells anyone who can compute it *when* that partition changes, never what changed. Where that matters, the server hands out the channel instead: a keyed hash, with the publisher holding the same key, returned by the read RPC.
  - **Data authorization** stays in the RPC handler.
- **Auth to AppSync.** Clients connect with whatever the API allows: Cognito, OIDC, a Lambda authorizer or an API key (`auth.token`, `auth.apiKey`).
- **Cost and load.**
  - **Reads.** Every subscribed client re-reads on every notification for its partition. A partition with 1,000 watchers costs 1,000 RPC reads per change; server mode costs one per instance.
  - **Publishing.** Each partition touched by a batch needs its own publish (§9).
  - **Fit.** Direct mode suits many clients spread over many partitions. Server mode suits hot partitions with many watchers. The publisher can feed both at once (§6.3).
- **Latency.** The same as server mode within noise, including the extra RPC read: p50 687 ms against 628 ms from the write (spike 8).
- **Not in direct mode: notifications that carry the data.**
  - Why not:
    - the data itself would need per-channel authorization in AppSync;
    - a lost notification would no longer be harmless;
    - an item can be larger than AppSync's 240 KB event limit.
  - The exception worth a follow-up is `eventStream.subscribe`. Events are immutable and versioned, so a client can detect a gap and catch up through a `readFrom` RPC.

## 6. Transports

### 6.1 `Live.layer`

```ts
Live.layer(options: {
  readonly receiver: ChangeReceiver
  readonly sweepInterval?: Duration.Input   // default 30 seconds
  readonly linger?: Duration.Input          // default 5 seconds (§5.1)
}): Layer.Layer<LiveRegistry, never, Reactivity>
```

- **What it provides:** the registry, and it runs the receiver for the layer's lifetime. It requires `Reactivity` rather than creating one, so the application's other `Reactivity` users (e.g. `SqlClient`) share it.
- **The receiver's job:** deliver notifications to the registry, which turns them into `Reactivity.invalidate` calls for followed keys.
- **The sweep:** every `sweepInterval`, and whenever the transport (re)connects, all followed keys are woken. A lost notification, or a stretch while the transport was disconnected, therefore heals within one sweep.
- **Transport failures** (connection drops, auth errors, protocol errors) are logged and retried with jittered backoff. They never fail a live read; they only make updates slower until the sweep catches up.

A transport is a pair: a receiving side that `Live.layer` runs, and, for transports that carry notifications between processes, a publishing side that the publish pipeline (§6.3) runs into.

```ts
type ChangeReceiver = Stream.Stream<ChangeNotification, TransportError>
type ChangePublisher = Sink.Sink<void, ChangeNotification, never, TransportError>
```

Transports in the first cut:

| Transport | Where | Receive (`Stream`) | Publish (`Sink`) |
|---|---|---|---|
| `Live.polling({ interval, maxInterval })` | core | Wakes each followed key every `interval`. It backs off ×2 per idle wake up to `maxInterval`, and resets after a wake that found a change. No infrastructure. | None |
| `Live.memory()` | core | A `PubSub` | The same `PubSub`. For tests and single-process apps. |
| `AppSyncEvents` | `effect-dynamodb/live/appsync` | `receiver(...)`: the WebSocket subscription (§6.2) | `publisher(...)`: HTTP publish (§6.3) |

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
- **Channel.** In server mode, one broadcast channel: every instance receives every notification and drops the ones it doesn't follow (§5.1). Channel names are 1–5 segments of up to 50 `[A-Za-z0-9-]` characters, so raw keys can't be channel names. Direct mode uses one hashed channel per partition (§5.6).
- **Auth:**
  - **`auth.apiKey(key)`:** no dependencies.
  - **`auth.iam({ region, credentials })`:** SigV4 signs the connect and each subscribe, using `@smithy/signature-v4` and `@aws-crypto/sha256-js` as optional peer dependencies (both pure JS). The caller supplies credentials (e.g. the AWS SDK's `fromNodeProviderChain()`), so the library picks no runtime-specific provider.
  - **`auth.token(effect)`:** for Cognito, OIDC and Lambda authorizers.
- **Isolation.** The subpath stays out of the main entry's import graph, enforced by a guard test like `change-feed`'s.

### 6.3 Publishing

Publishing is one Effect pipeline, `records → filter → notifications → publish Sink`, run wherever stream records arrive. Either way it takes one of the stream's two reader slots (§2.2).

```ts
// recommended: a Lambda function with the table's stream as its trigger
export const handler = Live.lambdaHandler({
  tables: { MainTable },   // change keys and live entity types come from the definitions
  publisher: AppSyncEvents.publisher({ httpHost, auth, broadcast: "/edd/changes", partitions: true }),
})

// or a process that already runs a leased change feed (§6 of change-feed.md)
Live.publishChangeFeed(feed, { tables: { MainTable }, publisher })
```

The pipeline's steps:
1. **Filter (S21).** Only items of entity types a live read can observe pass, decided from the table's entity definitions. Rows no live read sees are dropped:
   - version snapshots;
   - soft-delete tombstones;
   - time-series event rows, until `history().watch()` exists.

   In spike 6b, 25 records became 20 notifications.
2. **Notifications.** `ChangeNotification.fromStreamRecords` (§4.3).
3. **Collapse.** Within a batch, notifications for one item merge into one, keeping the union of partitions and the highest version. Ten back-to-back writes to one item became 3 notifications (spike 6d).
4. **Route.**
   - Server mode: every notification goes to the broadcast channel.
   - Direct mode: each notification also goes to each of its partitions' channels (§5.6).
   - Both can be on at once.
5. **Pack and publish.**
   - Events are packed to at most 5 KB, with up to 5 events per request, sent concurrently.
   - Values are escaped by `JSON.stringify`, so any key is safe. Quote, backslash, newline, tab, control-character, Unicode, emoji and `%`/`#` keys were all delivered (spike 6a).
   - **AppSync's HTTP 200 can still mean failure.** The endpoint returns 200 even when it rejects an event, listing it in `failed`, so a non-empty `failed` is a publish error.
6. **Failure.**
   - The handler fails the invocation. The trigger's bisect and bounded retries isolate the bad record and drop it: in spike 6f, 3 attempts within 0.8 s, then the shard moved on.
   - A notification lost for good is healed by the sweep.

**`Live.lambdaHandler`** accepts both shapes of records: a trigger's `{ Records: [...] }`, and the bare array a Pipe passes to a Lambda target. `Live.triggerFilterCriteria({ tables })` generates the trigger's `FilterCriteria` from the same declaration (`__edd_e__` in `NewImage` or `OldImage`). Records of other types then never invoke the function, and aren't billed (spike 6b).

**Required trigger settings**, documented in the guide with an infrastructure-as-code snippet:
- **Batching:** `BatchSize: 100`, `MaximumBatchingWindowInSeconds: 0` (latency).
- **Bounded failure:** `MaximumRetryAttempts` of 2–5, `MaximumRecordAgeInSeconds` (e.g. 300) and `BisectBatchOnFunctionError: true`. Unbounded retries stall every later notification on the shard.
- **Filter:** `FilterCriteria` from `Live.triggerFilterCriteria`.
- **Start-up:** a new trigger at `LATEST` missed the writes made in its first ~40 s (spike 6e), which the sweep covers.

**The change-feed path** (`Live.publishChangeFeed`) runs the same pipeline per batch and commits after publishing. It's for deployments already running a leased change-feed consumer, with no Lambda. On Web Functions the lease moves between environments as they come and go; the sweep covers the handover.

**Pipes.** A Pipe adds a hop and a per-request charge on top of the Lambda it needs anyway.
- **A Pipe with only an input transformer stays dropped** (spike 1).
  - The transformer escapes a value once, for the outer JSON, so a key containing a quote, backslash or control character becomes an invalid event. AppSync reports it in `failed` with HTTP 200, and the Pipe records success.
  - #171's percent-escaping doesn't change this. It covers sort-key composite values only, characters U+0000–U+0025, so partition keys and backslashes still reach the stream unescaped.
- **An API destination accepts one event per invocation** (spike 2), so it can't carry a packed batch to several channels.

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
  receiver: AppSyncEvents.receiver({ realtimeUrl, httpHost, channel: "/edd/changes", auth }),
}).pipe(Layer.provideMerge(Reactivity.layer))
```

This is server mode. In direct mode the same group needs only the short reads (`GetTask`, a query RPC), and clients follow AppSync themselves (§5.6).

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
  - **Open streams hold request slots** (spike 9). Capacity is `--max-environments × --max-concurrency-per-environment` (64 by default). With every slot held by a stream, every other request was rejected at once with HTTP 429 (`Platform.EndpointMaxEnvThrottle`), health checks and short RPCs included; nothing queues.
    - **What the client sees:** the Effect RPC client reports the 429 as `RpcClientError` (*"Error decoding HTTP response"*), so the resume recipe retries it as well.
    - **Server-mode sizing:** capacity must cover the open streams plus headroom for ordinary requests.
    - **Direct mode** avoids the problem: no request outlives a read.
- **ECS:** the same design, with no request cap; load-balancer idle timeouts apply.
- **Single instance:** `Live.polling` alone, or local invalidation alone if every write goes through the one instance.

## 9. Cost

**AppSync Events pricing:**
- **Operations:** $1.00 per million, flat. Every published event and every delivery to each subscribed connection is an operation per 5 KB. Connect, subscribe and ping requests are operations too, negligible here.
- **Connections:** $0.08 per million connection-minutes.
- **Rule of thumb:** one event per second delivered to one connection costs about **$2.59 a month** (2.592 million seconds × $1 per million).

| | Server mode | Direct mode |
|---|---|---|
| Publishes | One event per 5 KB of notifications per batch: one per write when writes trickle in, about one per 24 writes in full batches (spike 6: 500 writes, 21 events) | At least one event per partition a batch touches: about 1.2 per write with one GSI (spike 7: 500 writes, 616 events, 29× server mode) |
| Deliveries | Every event × every instance | Every partition event × the clients subscribed to that partition |
| Connections | One per instance | One per client, about $0.0035 a month for a client connected all the time |
| Reads | One per followed key per instance per change | One RPC request and one read per subscribed client per change |
| Web Function | Each open stream holds a request slot, so environments stay up while streams are open (§8) | Short requests only; environments scale to zero between reads |

- **Worked example (server mode).** 10 instances, with the publisher producing 5 events a second. That's 5 × (1 publish + 10 deliveries) × $2.59 ≈ $143 a month.
- **Reads.**
  - Base-table follower reads are consistent, at 1 RRU per 4 KB.
  - With polling at 1 Hz, an idle followed key costs about 2.6M RRU a month per instance. Backing off to `maxInterval` cuts that by the idle ratio.
- **Publisher.**
  - One Lambda invocation per batch: 500 writes took 8 invocations in spike 6 and 11 in spike 7.
  - Broadcast-only invocations finished in under 0.7 s at 512 MB. Partition fan-out raised the longest to 1.9 s (111 publish requests).
  - No Pipe charge.
- **IoT Core instead of AppSync.**
  - **Price:** the same per message ($1.00 per million, per 5 KB, deliveries and publishes both counted) up to a billion messages a month, then lower at volume (down to $0.70 per million).
  - **Why it isn't first (S14):** its limit of 100 messages a second per connection caps a broadcast receiver's entire feed.

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
1. **Foundation:**
   - change keys and local-write invalidation on every write path;
   - the registry and followers, `Live.layer`, `Live.polling` and `Live.memory`;
   - `ChangeNotification.fromStreamRecords`;
   - the publish pipeline (filter, collapse, route, pack), `Live.lambdaHandler`, `Live.triggerFilterCriteria` and `Live.publishChangeFeed`.
2. **Live reads:** `eventStream.subscribe`, `entity.watch` and `query.watch()`.
3. **AppSync Events:** the receiver, the publisher and auth.
4. **Direct mode (if S25 is in):**
   - partition channels and `Live.channels`;
   - `AppSyncEvents.follow`;
   - the `onSubscribe` guard snippet;
   - a guard test keeping `effect-dynamodb/live/appsync` free of the AWS SDK.
5. **Docs:** the guide (`guides/live-reads.mdx`), an example (`examples/guide-live-reads.ts`) using `Live.polling` against DynamoDB Local, and a `DESIGN.md` section.

**Follow-up issues:**
- live collection queries, aggregate `watch` (re-assembled on change), time-series `history().watch()`, geo queries and `readIndex` subscriptions;
- direct-mode `eventStream.subscribe` with event payloads (§5.6);
- bucketed partition channels: fewer publishes, more deliveries per client;
- IoT Core and Valkey transports;
- delta subscriptions for queries (a cursor on the sort key);
- a shipped client-side resume helper for server-mode `subscribe`.

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
    - SigV4 headers for a fixed clock and credentials.
  - **Publish pipeline**, against a mock HTTP client:
    - filtering from entity definitions (other entity types, version snapshots, tombstones);
    - collapse (union of partitions, highest version);
    - routing to the broadcast and partition channels;
    - packing (events ≤ 5 KB, ≤ 5 events per request);
    - escaping (quote, backslash, control characters, Unicode and emoji in key values: the spike 1 failure cases);
    - a 200 response with a non-empty `failed` array treated as a publish error;
    - `Live.lambdaHandler` with trigger- and Pipe-shaped events, failing the invocation on a publish error;
    - `Live.triggerFilterCriteria` output.
  - **Direct-mode follower** with a mock receiver and a mock read: reads on start, notification, reconnect and sweep; `match` filtering; coalescing; channel names equal across Node `crypto` and WebCrypto.
- **Connected (DynamoDB Local):** two bound clients, one writing and one watching.
  - Writes are delivered through local invalidation.
  - A `changeFeed` publishing to `Live.memory` delivers writes from the other client, including a GSI partition move.
  - `Live.polling` delivers them with no publisher.
- **Gap:** AppSync has no local emulator, so its adapter is covered by unit tests only. A manual script against a real AppSync Events API goes in the guide.

## 13. Spike results

### 13.1 Round 1 (2026-10-29): Pipes, AppSync, Web Functions

Round 1 tested publishing through EventBridge Pipes. Its findings led round 2 to replace the Pipe with a Lambda stream trigger (§6.3).

The spikes ran in us-east-1 against real services:
- a DynamoDB table (`NEW_AND_OLD_IMAGES`);
- an AppSync Events API (API key);
- two EventBridge Pipes through an API destination;
- a Lambda Web Function running Effect `4.0.0-rc.109` with `@effect/platform-node`.

Latencies were measured from the client machine (6 ms from the CloudFront edge). Everything was deleted afterwards.

| # | Question | Result |
|---|---|---|
| 1 | Can a Pipe input transformer emit AppSync's stringified-event body safely? | **No.** Plain and Unicode keys arrived. Keys containing a quote, backslash, newline or tab were silently dropped: the transformer escapes once, for the outer JSON. AppSync answered 200 and listed the event in `failed`, and the Pipe logged a successful target invocation. The no-code Pipe option was removed (§6.3). |
| 2 | Does a Pipe deliver each element of an enrichment Lambda's array to an API destination? | **No.** An API destination accepts exactly one event per invocation. A Lambda returning 2 or more elements fails the batch (*"Events received a batch size of 2 events and only accepts 1"*, HTTP 400), and the default retry policy then stalled the shard (30 failed attempts). Returning **one object per batch, with all notifications in one event**, delivered 45 of 45, quote, backslash, newline, tab and Unicode keys included, in batches up to the configured 10. Round 2 replaced the enrichment Pipe with a Lambda trigger that packs notifications itself (§6.3). |
| 3 | Can a Web Function environment keep an outgoing WebSocket going in the background while idle? | **Yes.** Over 3 minutes with no request in flight, the background receiver got 35 of 35 events (p50 253 ms, max 420 ms, from publish to receipt). Keep-alives kept arriving and nothing disconnected. The receiver connected as soon as the environment started. |
| 3b | Does an open background WebSocket keep an idle environment alive? | **No.** After 8 minutes with no requests, the environment had been reclaimed. The next request cold-started a new environment, whose receiver connected immediately. Scale-to-zero still works. |
| 4 | Do Web Functions stream Effect RPC's chunked `application/ndjson` responses as they're written? | **Yes.** A streaming RPC sending an element every 500 ms delivered 20 of 20, with arrival gaps of 493–508 ms (first element at 359 ms). A raw `application/ndjson` route behaved the same. |
| 4b | What does the client see when `timeoutSeconds` cuts a stream? | A 1-per-second stream on a 120 s timeout delivered 120 elements. The client's stream then **failed** at 120.3 s with `RpcClientError` (*"HTTP response ended before RPC request completed"*), a typed failure that `Stream.retry` catches (§7, §8). |
| 5 | What delivery rate does one AppSync Events connection sustain on one channel? | **No ceiling found up to 5,000 events/s.** At 50, 200, 500, 1,000, 2,000 and 5,000 events/s for 10 s each, 100% of events were delivered (50,000 of 50,000 at the top rate), with p50 about 150 ms and p99 about 420 ms. Because notifications are batched one event per stream batch, the event rate is far below the write rate. A single broadcast channel is enough for server mode. |

**End-to-end latency** was measured from the write call to an AppSync receiver, over 10 writes spaced 3 s apart, with a batching window of 0:

| Path | p50 | min | max |
|---|---|---|---|
| Transformer-only Pipe | 506 ms | 357 ms | 1,473 ms |
| Enrichment Pipe | 585 ms | 412 ms | 1,500 ms |

The enrichment Lambda adds about 80 ms. A 2 s batching window raised p50 to about 2 s.

**Pipe start-up.** A Pipe created, or just updated, with `StartingPosition: LATEST` processed nothing written in its first minute or two after reporting `RUNNING`. This is an operational note, and the sweep covers it.

**Web Functions.** The minimum for `--max-environments` is 2. `aws lambda-web deploy` creates an execution role named `awscli-lambdaweb-<name>` and uploads into a managed bucket, `awscli-lambdaweb-<account>-<region>-an`.

### 13.2 Round 2 (2026-10-30): Lambda trigger, partition channels, direct mode

The services, all in us-east-1:
- a DynamoDB table (`NEW_AND_OLD_IMAGES`, 4 stream shards);
- an AppSync Events API (API key);
- a Lambda function (Node.js 22, 512 MB) with the stream as its trigger. It ran the §6.3 pipeline in Effect `4.0.0-rc.109` as `Stream.fromIterable(records) → filter → map → Stream.run(publishSink)`, with trigger settings `BatchSize 100`, window 0, `MaximumRetryAttempts 2`, bisect, and filter criteria on `__edd_e__`;
- a Web Function serving Effect RPC (`GetOrder`, a `WatchOrder` stream backed by `Reactivity.stream`, `Ticks`), with a background AppSync receiver calling `Reactivity.invalidate`.

Latencies were measured from the client machine. Everything was deleted afterwards.

| # | Question | Result |
|---|---|---|
| 6a | Does the Effect publisher deliver the keys that broke the transformer Pipe? | **Yes.** All 9 delivered: plain, quote, backslash, newline, tab, a control character, Unicode, emoji, and `%`/`#`. |
| 6b | Do the trigger's filter criteria and the in-code filter drop what they should? | **Yes.** 20 `audit` items never invoked the function. Of the 25 `order` records that did, the 5 version snapshots were dropped in code, leaving 20 notifications, all delivered. |
| 6c | What is the latency from write to a broadcast receiver? | 10 writes 3 s apart: p50 589 ms, min 391 ms, max 762 ms. Round 1's enrichment Pipe: p50 585 ms, max 1,500 ms. |
| 6d | Does collapsing work? | 10 back-to-back writes to one item arrived in 3 batches and became 3 notifications. |
| 6 (burst) | How does packing hold up under load (broadcast only)? | 500 writes through parallel `BatchWriteItem` calls took 8 invocations, 8 publish requests and 21 events (about 4 KB each; 168 bytes per notification). All 500 were delivered, p50 760 ms and max 986 ms from the start of the burst. |
| 6e | How soon does a new trigger at `LATEST` deliver? | Writes made in the first 38 s after creation were missed. The first delivered write was made at 43 s, and none were missed after it. Round 1's Pipe took one to two minutes. |
| 6f | What does a record that can never be published do to its shard? | With `MaximumRetryAttempts: 2` and bisect, it was attempted 3 times within 0.8 s, then dropped. Writes made after it were delivered in 282–766 ms. |
| 7a | Are partition channels isolated? | **Yes.** A client on item A's partition got only A's 5 notifications, and B's client only B's 5. The shared GSI partition's channel got all 10. |
| 7a | Can a client subscribe to everything with a wildcard? | **Yes, by default.** With API-key auth, `/edd/*` received all 30 notifications (broadcast and partition channels), and `/edd/p/*` all 20 partition notifications. |
| 7c | Does an `onSubscribe` handler block wildcards? | **Yes, once the change has propagated.** `path.includes("*") → util.unauthorized()` rejected `/edd/*` and `/edd/p/*` (`subscribe_error`, `Unauthorized`) and allowed exact channels. A handler change took 2–5 minutes to apply to every connection, with mixed results in between. |
| 7 (burst) | What does partition fan-out cost? | The same 500-write burst (10 customers on a GSI), routed to broadcast and partition channels, took 604 publish requests and 616 events, against 21 events for broadcast alone (29×). The busiest invocation made 111 requests and took 1.9 s. Delivery slowed to p50 1,662 ms, max 2,987 ms. |
| 8 | How does direct mode compare with server mode on the same writes? | 15 writes 3 s apart; both modes delivered 15 of 15. **Server mode** (an Effect RPC `WatchOrder` stream; the Web Function's receiver wakes a `Reactivity.stream` follower): p50 628 ms, max 1,328 ms. **Direct mode** (a partition-channel subscription in the client, then an RPC `GetOrder` per notification): p50 687 ms, max 1,457 ms, with 15 notifications and 15 reads. |
| 9 | Do open streams hold Web Function request slots? | **Yes.** Setup: 4 requests per environment, 2 environments, 12 simultaneous 40 s streams. 8 streams ran (4 per environment), and the other 4 were rejected within 250 ms. Short `GetOrder` calls and `/health` made while the 8 were open got HTTP 429 `Platform.EndpointMaxEnvThrottle`. The default per-environment concurrency is 64. |

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
| S11 | Publisher: one Effect pipeline ending in a publish `Sink`, run by `Live.lambdaHandler` (stream trigger) or `Live.publishChangeFeed`. The input-transformer Pipe and the enrichment-Pipe contract are dropped (spikes 1, 2 and 6) | In (revised 2026-10-30) |
| S12 | Channels: one broadcast channel for server mode, one hashed channel per partition for direct mode. Bucketed channels deferred | In; bucketing is a follow-up (revised 2026-10-30) |
| S13 | Collections, aggregates, time-series `history`, geo, `readIndex` subscriptions | Out (follow-up) |
| S14 | IoT Core and Valkey transports | Out (follow-up) |
| S15 | Delta subscriptions for queries | Out (follow-up) |
| S16 | Browser clients subscribing to AppSync directly | Superseded by S25 |
| S17 | Client resume helper: documented recipe only, for server-mode `subscribe` | Out (recipe) |
| S18 | Per-instance stream tailing as a supported mode | Out (documented as an alternative for single instances) |
| S19 | Live code in core (no new dependencies); only AppSync in a subpath, kept free of the AWS SDK so browsers can import it | Proposed |
| S20 | Documented trigger settings: `BatchSize` 100, no batching window, `MaximumRetryAttempts` 2–5, `MaximumRecordAgeInSeconds`, bisect, generated `FilterCriteria` (spikes 6e, 6f) | In (revised 2026-10-30) |
| S21 | The publisher filters to what live reads can observe (declared entity types; no version snapshots, tombstones or time-series event rows) and collapses per item, all from the table's entity definitions. `Live.triggerFilterCriteria` generates the trigger's filter from the same declaration | In |
| S22 | A Lambda stream trigger is the recommended publisher, not a Pipe. `Live.lambdaHandler` still accepts Pipe-shaped events | In |
| S23 | A transport is a `Stream` (receive) and `Sink` (publish) pair. `Live.layer` takes the receiver; the publish pipeline runs into the publisher | In |
| S24 | IoT Core: compared and kept out. The price is the same as AppSync below about a billion messages a month, but its 100-messages-per-second limit per connection caps a broadcast receiver (§9). Covered by S14 | Out (follow-up) |
| S25 | Direct mode: clients follow per-partition AppSync channels and read through the application's RPC (`AppSyncEvents.follow`, `Live.channels`). The `onSubscribe` wildcard guard ships as a snippet. Thin notifications only; payload-carrying events for `subscribe` are a follow-up | Proposed (in) |
