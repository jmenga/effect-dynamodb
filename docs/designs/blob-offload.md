# Design: offload large and binary attribute values to S3 (versioned blob storage)

**Issue:** [#179](https://github.com/jmenga/effect-dynamodb/issues/179)
**Status:** Designed and confirmed by the user (2026-11-01) → implemented in the same PR
(single-PR workflow — this doc is commit 1).
**Affected packages:** `packages/schema` (`DynamoModel.Packed({ external })`,
`DynamoModel.External`, the pointer codec (Packed layout `010`), a vendored CRC64NVME and
SHA-256, entity definition guards, the `BlobStoreError` tagged error and its type helper),
`packages/effect-dynamodb` (Entity, Aggregate, EventStore, Query, BoundQuery, Batch,
Transaction, Collection, DynamoClient, StorageEncoding, projections, new `BlobStore`,
`Offload` and `BlobGc` modules, new subpath `effect-dynamodb/blob/s3`),
`packages/effect-dynamodb-geo` (`GeoSearch` / `GeoIndex` decode, error types and store check —
§8.4, §9.3), CI, docs, examples
**Semver impact:** `minor` (lockstep across the four publishable packages). Additive and
opt-in; nothing changes for an entity or stream that declares no offloaded field — see §22.

> **Reading guide.** The user's decisions in the brief (§2.2) are the starting point. Where
> they were silent, or where this design narrows or deviates from them, the design's choice
> was put to the user and **confirmed as written on 2026-11-01**; items marked **(confirmed)**
> are those refinements of a brief decision. §23 lists every scoping decision with its source
> and the alternative that was considered and rejected; §24 records the design's own decisions
> and the resolved questions. The implementation plan (§21) builds the design exactly as
> written here.

---

## 1. Executive summary

A DynamoDB item is capped at 400 KB and every write is billed per KB of the whole item, so a
field that is *occasionally* large makes every write of its item expensive and some writes
impossible; binary content (scans, images, exports) does not belong in DynamoDB at all.
Applications end up hand-building the claim-check pattern: upload to S3, store a pointer, keep
the two consistent, clean up superseded objects, and resolve pointers on every read and stream
consumer.

This design makes that pattern a storage option of a declared field:

```ts
const DocumentModel = DynamoModel.configure(Document, {
  // overflow field: inline (S, or compressed B) below the threshold, S3 at or above it
  body: { storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" },
                                         external: { threshold: 65_536 } }) },
  // binary field: always S3
  scan: { storedAs: DynamoModel.External({ contentType: "application/pdf" }) },
})

const Documents = Entity.make({ model: DocumentModel, …, offload: { itemBudget: 300_000 } })

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({ region: "eu-west-1" }),
  S3BlobStore.layer({ bucket: "documents-blobs", prefix: "prod/" }),   // effect-dynamodb/blob/s3
)
```

- **Stored form.** An offloaded value is a *pointer* — a new Packed header layout (`010`)
  carrying the object key, the S3 `VersionId`, the sizes, a CRC64NVME content checksum and
  the codec or content type (§4). An overflow field stores it as a `B` value; a binary field
  stores the same bytes as `S` text behind a sentinel, so that
  readers without this feature fail loudly for both kinds (§4.7). Readers dispatch on the
  stored form as they do for Packed, so one field can be inline in one item and in S3 in the
  next.
- **Consistency by versioning.** Each item attribute has a stable hashed object key; every
  write uploads a new version and the pointer pins its `VersionId`. S3 is written first, then
  DynamoDB. A write DynamoDB *provably* rejected deletes exactly the version it uploaded; a
  write whose outcome is unknown keeps it, reports it, and leaves it for GC (§6.2). A
  `PutObject` response without a real `VersionId` fails the write before DynamoDB is touched.
  A pointer the operation did not upload is only ever written under a condition that pins it
  (§6.4).
- **Reads.** Overflow fields resolve eagerly (bounded concurrency, page-level prefetch); binary
  fields come back as lazy `BlobHandle`s (`read`, `stream`, byte ranges, `presignedUrl`). Both
  are overridable per read with `.offloaded(mode)` (bound builders) or `Entity.offloaded` /
  `Query.offloaded` (unbound), which re-type the result (§8, §9). A projection that omits the
  field never fetches it.
- **Streams.** Stream-image decoding is lazy by default (decision 5): `Entity.decodeMarshalledItem`,
  `stream.decodeStreamImage` and the projection runtime. A new `Entity.decodeStreamRecord`
  classifies each offloaded field of a `MODIFY` as unchanged / rewritten / changed from the
  two pointers, without touching S3 (§10). Making the EventStore side eager by default was
  considered and rejected (§10.2).
- **Garbage collection** ships but is opt-in (`BlobGc`) and is **table-local**: it only ever
  deletes versions under the key space of the table it reads. A change-feed reaper frees a
  superseded version directly for members whose rows never copy pointers, and after a
  bracketed confirm-read of the item family otherwise; a two-pass per-item sweep deletes a
  version only after it has been seen unreferenced for the whole grace period; a store-wide
  sweep is the backstop for leaks no row records (§11). `NoncurrentVersionExpiration` is
  never safe on the offload prefix.
- **Escaped key text required.** Offloading requires `DynamoSchema.make({ escapeKeys: true })`
  (owner decision, 2026-11-14). Object keys are named from the owning row's key text and S3 has
  no rename, so a row holding a pointer must never move to other key text. With the
  requirement, pointer rows are only ever written at their final key text and `rekey` never
  needs to move one; a member that offloads under any other setting is refused where it is
  bound (`[EDD-9146]`), and `rekey` refuses to move a row holding a pointer (§11.10).
- **Errors.** A tagged `BlobStoreError` joins the error channel of an operation only when the
  entity (or stream, or aggregate) declares an offloaded field and the operation can reach the
  store in its effective read mode — including multi-op entry points (`Batch.write`,
  `Transaction.transactWrite`, `EventStream.append`'s additional items) (§9.3, §14).
- **Runtime-neutral.** The `BlobStore` contract is read with `Effect.serviceOption` (no new
  `R`); the S3 implementation is a subpath with `@aws-sdk/client-s3` as an optional peer
  dependency; the in-memory store serves tests; checksums and object-key digests are computed
  by vendored pure-JS CRC64NVME and SHA-256 implementations, independent of any overridable
  service.

---

## 2. Context

### 2.1 Why

- **The 400 KB item limit.** An item that holds one large field cannot grow past the limit,
  and `Packed` compression (#147) only moves the cliff.
- **Write cost.** DynamoDB bills a write per 1 KB of the *whole item*, on every write of the
  item — a 300 KB item costs ~300 write units even when only its status changed. An S3 `PUT`
  is a flat per-request charge, paid only when the offloaded value itself is written.
- **Binary content** (PDFs, images, exports) has no business in DynamoDB: it bloats every read
  of the item, every stream record and every backup.
- **The claim-check pattern done by hand** gets the hard parts wrong: upload/write ordering,
  rollback on a failed conditional write, superseded-object cleanup, pointers that outlive the
  object they name, and stream consumers that must resolve pointers too.

### 2.2 What the user fixed before this design

1. Field-level offload only (declared fields), never whole items. Two kinds: **overflow
   fields** (Packed JSON with an external threshold: inline below, S3 at/above) and **binary
   fields** (`Uint8Array` marked External, always S3).
2. Both a per-field threshold **and** an entity-level item budget (offload overflow fields
   largest-first until the item fits).
3. Applies to Entity, Aggregate edges, EventStore event `data` and snapshot `state`.
4. GC ships with the feature but is optional/opt-in: a change-feed reaper (primary) and a
   per-item reconciliation sweep with a grace period (backstop). Never rely on
   `NoncurrentVersionExpiration` for referenced data.
5. Reads: overflow fields eager by default, binary fields lazy handles (read / stream with an
   optional byte range / `presignedUrl`) by default; both overridable per query, with the mode
   reflected in the result type. A `select()` that omits the field never fetches it.
   Stream-image / change-feed decoding is lazy by default.
6. A new tagged `BlobStoreError`, carried only by operations on entities with offloaded fields,
   tracked at the type level like `TPackedFields`.
7. S3 versioning is the consistency mechanism: stable hashed key per item + attribute, pointer
   pins `VersionId`; write S3 first, then DynamoDB; on DynamoDB failure delete exactly the
   written version. Reject `PutObject` responses without a real `VersionId` (detected from the
   response, no `GetBucketVersioning` pre-check). The contract is "put returns an immutable
   reference"; stores without versioning may satisfy it with a new key per write; the S3
   implementation refuses unversioned buckets.
8. Bucket / prefix configured on the BlobStore layer, optional per-entity prefix override.
   Hashed S3 keys, item key in object metadata.
9. The pointer is a new reserved Packed header layout (`010`) carrying key, `VersionId`, size,
   a content checksum + its algorithm, inner format/codec or content type. Self-describing;
   old readers fail with the existing unsupported-layout error.
10. S3 ships as subpath `effect-dynamodb/blob/s3` with `@aws-sdk/client-s3` as an optional
    peer; runtime-neutral contract read via `Effect.serviceOption` like `Compression`;
    in-memory store for tests.
11. Connected tests add a MinIO container (versioning enabled) beside DynamoDB Local.
12. Streaming / multipart uploads in scope for binary fields: input `Uint8Array |
    Stream<Uint8Array>`, multipart written directly against `@aws-sdk/client-s3` (not
    `lib-storage`), interruption aborts the upload, consumed streams can't be replayed. The
    checksum must be identical for single-PUT and multipart; choose between pure-JS incremental
    SHA-256 and S3 full-object CRC64NVME (preferred only if the JS SDK computes it without the
    native CRT package).
13. Stream change detection by pointer comparison (same `VersionId` = unchanged; different
    `VersionId`, same checksum = rewritten identical; different checksum = changed). Requires
    `NEW_AND_OLD_IMAGES`, detected from the first record.

Out of scope (fixed): whole-item offload, content-hash dedup, SSE configuration beyond
passthrough.

Two decisions the owner added on 2026-11-14, after the rebase onto 1.42.2:

14. **Offloading requires `escapeKeys: true`.** Any member with offloaded fields (an entity, an
    aggregate through its edge entities, an EventStore stream, a `GeoIndex` through its entity)
    is refused where it is bound unless its table's schema sets `escapeKeys: true`
    (`[EDD-9146]`, §13). `rekey` refuses to move a row that holds a blob pointer (§11.10).
15. **PartiQL `insert()` offloads** as `put` does: route and upload before the `INSERT`, decode
    the result with the written values, and settle `ExecuteStatement` / `ExecuteTransaction` in
    the ledger (§6.2, §6.5).

### 2.3 External facts this design rests on

Verified against AWS documentation, AWS SDK source and npm metadata, vendor documentation, and
a probe of a local MinIO build (`cgr.dev/chainguard/minio`, `RELEASE.2026-10-23T20-06-51Z`)
with `@aws-sdk/client-s3` 3.1159.0. "Status" is what the evidence supports. Sources are
listed under the table (URLs as of 2026-10).

| # | Fact | Status | Consequence here |
|---|---|---|---|
| F1 | A versioned bucket's `PutObject` / `CompleteMultipartUpload` / `CopyObject` returns `VersionId`; an unversioned bucket returns none; a suspended bucket stores a `null` version. Whether AWS sends the header as `"null"` or omits it on a suspended PUT is **undocumented** (MinIO omits it) | confirmed, one gap | reject both a missing and a `"null"` `VersionId`, on uploads and copies (§12.2) |
| F2 | `DeleteObject` with `VersionId` permanently deletes that version (no delete marker). Deleting an absent version: MinIO 204; AWS undocumented | confirmed | rollback and GC treat 204 and `NoSuchVersion` as success |
| F3 | `NoncurrentVersionExpiration` counts days from when the *successor* was created | confirmed | it can delete referenced versions — never allowed on the offload prefix (§11.1, §11.7) |
| F4 | S3 replication keeps `VersionId`s; deletes by version are **not** replicated; replicas of large objects can lag by hours without RTC | confirmed | per-region GC; replica reads may see `NotFound` (§16) |
| F5 | Parts are 5 MiB–5 GiB (last part unbounded below), ≤ 10,000 parts; single PUT ≤ 5 GB; max object 50 TB (48.8 TiB) since December 2025 | confirmed | part sizing (§7) |
| F6 | Full-object multipart checksums exist for CRC64NVME, CRC-32 and CRC-32C (CRC64NVME is full-object only); SHA-1 and SHA-256 are composite-only for multipart | confirmed | CRC64NVME is chosen over CRC-32 / CRC-32C for its 64-bit width, which keeps accidental collisions negligible for change detection — not because it is the only full-object option (§5) |
| F7 | `@aws-sdk/client-s3` ≥ 3.957.0 computes CRC64NVME in pure JS when the CRT package is absent | confirmed | decision 12's condition holds; peer floor ≥ 3.957.0 |
| F8 | The JS SDK's *default* request checksum is CRC32 | confirmed | the S3 store sets CRC64NVME explicitly on every upload call |
| F9 | Web Crypto has no streaming digest | confirmed | a library-computed SHA-256 over a stream would need a pure-JS hash (~314 MiB/s measured) vs CRC64NVME (~1 GiB/s) |
| F10 | User metadata ≤ 2 KB total, US-ASCII; object keys ≤ 1,024 bytes; `VersionId` is an opaque string ≤ 1,024 bytes | confirmed | hashed keys; length-prefixed pointer fields; item key in metadata only while the 2 KB total allows (§4.6) |
| F11 | Millions of versions on one key cause `503 Slow Down` throttling; AWS's guidance is to keep versions per key well below that (~100,000) | confirmed | time-series objects are keyed per event item (§4.5) |
| F12 | Without `s3:ListBucket`, a missing version reads as `403 AccessDenied`, not `404` | confirmed | in the IAM set (§17) |
| F13 | Object Lock and MFA Delete block deletes by version | confirmed | unsupported for rollback / GC (§12.2) |
| F14 | The MinIO upstream repository is archived and no longer publishes official images; `cgr.dev/chainguard/minio` is maintained and supports versioning (single drive) and CRC64NVME full-object | confirmed (repository archive banner; Chainguard image catalogue; local probe) | CI image (§19.4) |
| F15 | MinIO differs: suspended PUT omits `VersionId`; checksum mismatch is `XAmzContentChecksumMismatch` (not `BadDigest`); Complete omits `ChecksumType` | confirmed (local probe) | tests never assert AWS-specific codes |
| F16 | Cloudflare R2 has no versioning; GCS needs Object Versioning (S3-interop `x-amz-version-id` unverified); Azure returns `x-ms-version-id` | refuted / likely | R2 needs a key-per-write store; GCS / Azure need native stores (out of scope) |
| F17 | `StreamViewType` is per record but optional; Kinesis Data Streams records can be reordered and duplicated | likely | view-type check falls back to image presence on every record; the reaper is order-independent and idempotent (§11.3) |
| F18 | DynamoDB `Query` / `Scan` are only *read-committed* with respect to `TransactWriteItems`: a transaction committing during a query is visible only to the part read after it. `GetItem` and `TransactGetItems` are serializable with it | confirmed | the GC's "no holder" decision brackets its queries with transactional reads of the live row (§11.3) |
| F19 | `TransactWriteItems` with a `ClientRequestToken` is idempotent for 10 minutes: a resend after a commit returns success without re-applying | confirmed | the library sets the token itself, so a cancellation proves non-commit whatever retries sit below it (§6.2) |
| F20 | In a versioning-*suspended* bucket, a `DeleteObject` without `VersionId` removes the `null` version and inserts a `null` delete marker; with `VersionId` it deletes that version permanently | confirmed | the unversioned-write cleanup deletes by `VersionId: "null"` (§12.2) |

Sources:

- F1, F2, F20: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html>,
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html>,
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectsfromVersioningSuspendedBuckets.html>,
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshooting-versioning.html>
- F3: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html>
- F4: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-what-is-isnot-replicated.html>,
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html>
- F5: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html>
- F6: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html>
- F7: aws-sdk-js-v3 pull requests #7592 and #7595 (<https://github.com/aws/aws-sdk-js-v3/pull/7592>,
  <https://github.com/aws/aws-sdk-js-v3/pull/7595>) and the `@aws-sdk/client-s3` 3.957.0 release notes
- F8: <https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html>
- F9: <https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest> (one-shot `BufferSource` input only)
- F10: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html>,
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html>
- F11: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/troubleshooting-versioning.html>
- F12: <https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html> (Permissions)
- F13: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html>,
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/MultiFactorAuthenticationDelete.html>
- F14: <https://github.com/minio/minio> (archived), <https://images.chainguard.dev/directory/image/minio/overview>
- F15: local probe (above)
- F16: <https://developers.cloudflare.com/r2/api/s3/api/>, <https://cloud.google.com/storage/docs/object-versioning>,
  <https://learn.microsoft.com/azure/storage/blobs/versioning-overview>
- F17: <https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_StreamRecord.html>,
  <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/kds.html>
- F18, F19: <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html>
  (isolation levels; idempotency), <https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html>

---

## 3. API

### 3.1 Overflow fields — `DynamoModel.Packed({ external })` (schema package)

```ts
export interface ExternalOptions {
  /**
   * Stored bytes of the packed value (the `S` UTF-8 length, or the `B` length after
   * compression) at or above which it is written to the blob store instead.
   * A non-negative safe integer; `0` always offloads. Default 65,536.
   */
  readonly threshold?: number | undefined
}

export interface PackedOptions {
  readonly format: PackedFormat
  readonly compression?: { readonly codec: CompressionCodec; readonly threshold?: number } | undefined
  /** Not accepted here: offloading is only reachable through the overload below. */
  readonly external?: never | undefined
}
export interface ExternalPackedOptions extends Omit<PackedOptions, "external"> {
  readonly external: ExternalOptions
}

/** Always inline. */
export interface PackedConfig {
  readonly [PackedTag]: true
  readonly format: PackedFormat
  readonly compression: { readonly codec: CompressionCodec; readonly threshold: number } | undefined
  readonly external: undefined
}

/** Values may be offloaded — what the type level keys on. Disjoint from `PackedConfig`. */
export interface ExternalPackedConfig {
  readonly [PackedTag]: true
  readonly format: PackedFormat
  readonly compression: { readonly codec: CompressionCodec; readonly threshold: number } | undefined
  readonly external: { readonly threshold: number }
}

export function Packed(options: ExternalPackedOptions): ExternalPackedConfig
export function Packed(options: PackedOptions): PackedConfig
export const isPackedConfig: (value: unknown) => value is PackedConfig | ExternalPackedConfig
export const isExternalPackedConfig: (value: unknown) => value is ExternalPackedConfig
```

- The plain overload types `external` as `never`, so options held in a variable typed
  `PackedOptions` cannot carry `external` and return a plain `PackedConfig` the type level
  would not see as offloaded. `makeStream`'s `storedAs` takes the same two option types.
- **The two configs are disjoint** (deviation, from the review of commit 4): an
  `ExternalPackedConfig` is not assignable to `PackedConfig`, so the config side cannot be
  widened either — `const c: PackedConfig = Packed({ format: "json", external: {} })` is a
  compile error. Were it a subtype (as first drafted), that line would compile, offload at
  runtime, and read as inline at the type level, so `WriteBlobErrors` / `ReadBlobErrors` would
  drop `BlobStoreError` for the member (and `makeStream`'s storedAs inference, item 13, would
  miss it likewise). Every API that takes or reports a packed config takes or reports either,
  `PackedConfig | ExternalPackedConfig`: `configure`'s `storedAs`, `getPackedFields`,
  `isPackedConfig`, `StorageEncoding`'s `storedAs` arguments, and `makeStream`'s
  `StreamStorageConfig`, `snapshot.storedAs` and `stream.storedAs`. A config typed
  `PackedConfig` — a plain one, as existing helpers type it — stays provably inline, so nothing
  over-reports either. (The alternative, counting every `PackedConfig` not provably inline as
  overflow, would add `BlobStoreError` to members that offload nothing whenever their config is
  annotated `PackedConfig`.)

- The threshold compares **stored** bytes — what the item pays for and what the item budget
  (§6.3) measures — so compression runs first and a value that compresses under the threshold
  stays inline.
- Default **65,536** bytes. Below ~8 KB an S3 `PUT` costs more than the DynamoDB write units
  it saves, and every offloaded read adds an S3 round trip; 64 KiB keeps that round trip for
  values that are genuinely large. The docs say to tune it per workload.
- Validation at call time, `[EDD-9141]`: `external` not an object, an unknown key, a
  `threshold` that is not a non-negative safe integer.
- An overflow field **is** a packed field: every Packed rule (§15) applies unchanged, and its
  inline values are byte-identical to today's.

### 3.2 Binary fields — `DynamoModel.External` (schema package)

```ts
export interface ExternalBinaryOptions {
  /** Content-Type of the stored object when a write does not name one. Default "application/octet-stream". */
  readonly contentType?: string | undefined
}
export interface ExternalConfig {
  readonly [ExternalTag]: true
  readonly contentType: string
}
export const External: (options?: ExternalBinaryOptions) => ExternalConfig
export const isExternalConfig: (value: unknown) => value is ExternalConfig
/** Domain field name → config, for every field configured `storedAs: External(...)`. */
export const getExternalFields: (model: Schema.Top) => Record<string, ExternalConfig>
```

- Admitted by `configure` only where `NonNullable<A> extends Uint8Array` (type level); the
  runtime rule at `Entity.make` is authoritative (`[EDD-9111]`): the field's **encoded** side
  must be `Uint8Array` (`Schema.Uint8Array`, optionally under `optional` / `optionalKey` /
  `NullOr`). `Uint8ArrayFromBase64` encodes to a string and is refused — it stores text, not
  bytes.
- Invalid options are `[EDD-9141]` (an unknown key; a `contentType` that is not a non-empty
  US-ASCII string of at most 255 bytes).
- `field` (rename) and `immutable` combine with `External`; nothing else does (§15). An
  `External` field is not the entity's `identifier` either (`[EDD-9142]`): refs and their
  cascade indexes compose the identifier into keys.
- `ConfiguredModel.attributes[field]` gains `external?: ExternalConfig` beside `packed` and
  `sparse`. A field has one `storedAs`, so it is never both.

### 3.3 Entity — `offload`

```ts
Entity.make({
  model: DocumentModel, entityType: "Document", primaryKey: { … },
  offload: {
    /** Stored item bytes the library keeps the item under by offloading overflow fields, largest first. */
    itemBudget: 300_000,
    /** Replaces the store's prefix for every object key this entity writes. */
    prefix: "prod/documents/",
  },
})
```

- `itemBudget`: a safe integer in 1 … 409,600. Absent: no budget (thresholds only).
  It is a **routing decision, not a limit check** — DynamoDB's own limits are still diagnosed
  from the failed request (§6.3).
- `prefix`: an **override** of the store layer's prefix (decision 8), not a suffix to it, so an
  entity can place its objects under a prefix with its own lifecycle, replication or IAM rule.
  A non-empty string of RFC 3986 unreserved characters and `/`, at most 256 bytes, not
  starting with `/`. The IAM policy must then cover that prefix too (§17).
- `[EDD-9114]` for an unknown key, a bad value, `itemBudget` on an entity with no overflow
  field, or `offload` on an entity with no offloaded field at all.
- Exposed resolved on the entity as `entity.offload: { itemBudget, prefix, overflow, binary }`
  (the last two: domain field names), mirroring `stream.storedAs`.

### 3.4 EventStore

```ts
EventStore.makeStream({
  …,
  storedAs: { data: DynamoModel.Packed({ format: "json", external: { threshold: 131_072 } }) },
  snapshot: { schema: State, mode: "inline",
              storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" },
                                             external: {} }) },
  offload: { itemBudget: 350_000, prefix: "prod/ledger/" },
})
```

- Event `data` and snapshot `state` are overflow values (only `Packed({ external })`;
  `External` is a binary *field* config and is `[EDD-9079]` here, as any non-Packed
  `storedAs` already is).
- `offload.itemBudget` applies per event item and per snapshot item (each has one offloadable
  attribute: an item over budget offloads it whatever its threshold). `offload.prefix` as for
  entities. `[EDD-9114]` as for entities.
- `stream.storedAs` reports `external` in the resolved configs.

### 3.5 Aggregates

Edges are entities, so an edge entity's overflow and binary fields are offloaded per its own
config. `Aggregate.make` adds no option. Three aggregate-specific choices (§6.9, §8.4): aggregate reads resolve **both** kinds eagerly; aggregate inputs
accept only `Uint8Array` for a binary edge field; and a changed group re-uploads its
offloaded values (aggregate writes never carry a read pointer).

### 3.6 `BlobStore` service and layers

Core module `BlobStore.ts` (runtime-neutral; full contract in §12.1):

```ts
export class BlobStore extends Context.Service<BlobStore, BlobStoreService>()(
  "@effect-dynamodb/BlobStore",
) {
  /** Provide a store implementation. */
  static readonly layer: (service: BlobStoreService) => Layer.Layer<BlobStore>
  /** In-memory store for tests: versioned (stable key + version ids) or key-per-write. */
  static readonly memory: (options?: MemoryBlobStoreOptions) => BlobStoreService
  static readonly layerMemory: (options?: MemoryBlobStoreOptions) => Layer.Layer<BlobStore>
}
```

S3 subpath `effect-dynamodb/blob/s3` (§12.2):

```ts
import * as S3BlobStore from "effect-dynamodb/blob/s3"

S3BlobStore.layer({
  bucket: "documents-blobs",
  prefix: "prod/",                       // optional; ends with "/" by convention
  client: new S3Client({ region: "eu-west-1" }),   // or `clientConfig: S3ClientConfig`
  partSize: 8 * 1024 * 1024,             // optional, 5 MiB – 5 GiB
  uploadConcurrency: 4, readConcurrency: 16, writeConcurrency: 8,
  maxUploadAge: "1 hour",                // optional; an upload older than this never reaches DynamoDB (§6.1)
  serverSideEncryption: { ServerSideEncryption: "aws:kms", SSEKMSKeyId: "…" },   // passthrough
  presign: { getSignedUrl },             // optional: from @aws-sdk/s3-request-presigner
})
S3BlobStore.layerConfig({ bucket: Config.string("BLOB_BUCKET"), … })
S3BlobStore.make(options): Effect<BlobStoreService, never, Scope>   // owns the S3Client when built from config
```

`maxUploadAge` is part of the store's configuration because writers
and GC must agree on it:
writers refuse to commit an older upload, and GC treats anything younger as possibly in flight
(§11.4). Every process that writes or collects against one bucket configures the same value.

**Resolution without a new `R`** (as `Compression`, `DESIGN.md §7`): every site reads the store
with `Effect.serviceOption(BlobStore)`. Precedence:

1. `DynamoClient.make({ …, blobStore })` — explicit, bundled into the captured context of every
   bound entity / aggregate / collection operation. A bound builder handed to `Batch.get`,
   `Batch.write`, `Transaction.transactGet`, `Transaction.transactWrite` or
   `EventStream.append({ additionalItems })` keeps it: `extractTransactable` returns the
   builder's captured `BlobStore` and compressor registry, and those entry points build that
   op's item under them (today they run every op in the caller's context, so a compressor
   given only to `DynamoClient.make` does not reach a bound op inside `Batch.write` — the same
   gap for compressors is fixed in this change).
2. An ambient `BlobStore` when the client or stream is bound (`DynamoClient.make`,
   `EventStore.bind`, `EventStore.bindProjection`, `GeoIndex.bind`).
3. An ambient `BlobStore` at run time, for unbound operations and the decode helpers.

A member with an offloaded field needs a store where it is first resolvable (§13).

**Observer**. `Offload.layerObserver({ onUnsettled })` (a `Context.Reference`, off by default,
like `ConsumedCapacity`'s `onOperation`) receives every upload the library could not settle —
in-doubt outcomes, failed rollback deletes, lost multipart completions and (*added in
commit 6*) store answers refused as naming no version of the requested key (`answerRefused`,
§6.2) — with the table, entity type, attribute, row key and ref (§6.2), so an application can
queue those items for `gc.sweep`.

### 3.7 Read modes and result types — `.offloaded(mode)`

```ts
export type OffloadMode = "eager" | "lazy"
export type OffloadModes = { readonly overflow?: OffloadMode; readonly binary?: OffloadMode }

db.entities.Documents.get({ id }).offloaded("eager")          // body: Body, scan: Uint8Array
db.entities.Documents.byOwner({ owner }).offloaded("lazy")    // body: OffloadedValue<Body>, scan: BlobHandle
db.entities.Documents.byOwner({ owner }).offloaded({ binary: "eager" })
```

Defaults: `{ overflow: "eager", binary: "lazy" }`. A string sets both kinds; an object
overrides the kinds it names. Available:

- on bound builders: `BoundGet`, `BoundQuery` (index accessors, scans, `history()`,
  `versions()`, `deleted.list()`), collection queries (per member), vector searches
  (`BoundVectorQuery`, its hits), `BoundPut` / `BoundUpdate` / `BoundDelete` / `upsert` /
  `append` (their return values);
- on unbound descriptors, as `Function.dual` combinators (the dual-API convention):
  `Entity.offloaded(mode)` for `EntityGet` and the write intermediates (`EntityPut`,
  `EntityUpdate`, `EntityDelete`), and `Query.offloaded(mode)` for `Query<A, E>` — including the
  EventStore descriptors `query.events()` / `query.index()`, where lazy mode re-types the
  item to `LazyStreamEvent` (§10.2);
- as an option `{ offloaded }` where an operation takes options instead of a builder
  (`EventStream` reads, `Entity.decodeMarshalledItem`, `decodeStreamRecord`,
  `decodeStreamImage`, `EventProjection` / `MultiProjection`). Geo reads take no mode: they
  are eager for both kinds (§8.4).

`Batch.get` and `Transaction.transactGet` take each get's own mode. The `EntityOp` terminals
follow the op's mode: `asModel` and `asRecord` / `asItem` (which add system fields and keys)
resolve offloaded fields per mode exactly as `asModel` does; `asNative` returns the stored
pointers untouched.

```ts
/** An overflow field read lazily. Inline values are already resolved; `read` then does no I/O. */
export interface OffloadedValue<A> extends Pipeable, Inspectable {
  readonly [OffloadedValueTypeId]: OffloadedValueTypeId
  readonly location: "inline" | "external"
  readonly ref: Option<BlobRef>          // external only
  readonly size: number                  // stored bytes: the attribute's, or the object's
  readonly checksum: BlobChecksum        // content checksum (§5)
  readonly read: () => Effect<A, BlobStoreError | ValidationError>   // fetch, verify, decompress, schema-decode
}

/** A binary field read lazily. */
export interface BlobHandle extends Pipeable, Inspectable, Equal.Equal {
  readonly [BlobHandleTypeId]: BlobHandleTypeId
  readonly location: "inline" | "external"   // inline: a native value stored before External was configured
  readonly ref: Option<BlobRef>
  readonly size: number
  readonly contentType: string
  readonly checksum: BlobChecksum
  readonly read: (options?: { readonly range?: ByteRange }) => Effect<Uint8Array, BlobStoreError>
  readonly stream: (options?: { readonly range?: ByteRange }) => Stream<Uint8Array, BlobStoreError>
  readonly presignedUrl: (options?: { readonly expiresIn?: Duration.Input }) => Effect<string, BlobStoreError>
}
export interface ByteRange { readonly offset: number; readonly length?: number | undefined }
```

- Handles capture the store and the compressor registry of the fiber that decoded them, so
  `read()` / `stream()` have `R = never`.
- `presignedUrl` fails with `BlobStoreError { reason: "Unsupported" }` on an inline handle or
  a store without the `presign` capability. Default `expiresIn` 15 minutes — equal to the
  reaper's default grace (§11.3), so a URL issued for a version that is then superseded
  stays valid for its whole life under the defaults. A longer `expiresIn` needs a reaper grace
  at least as long; the docs say so.
- `BlobHandle` equality is by location and ref (external) or content checksum (inline), so
  `Equal.equals(a, b)` is a cheap "same stored value" test. *(Commit 5: the inline comparison
  also requires equal checksum algorithm and size — the `rewritten` test of §10.3 — so it only
  ever errs towards "different".)*
- Module `Offload` (core) exports the types, the type ids, `isBlobHandle`,
  `isOffloadedValue`, `Offload.source` (§3.8) and the type-level view `Offload.View` (§9.2).

### 3.8 Write inputs for binary fields

```ts
type BinaryInput =
  | Uint8Array
  | Stream.Stream<Uint8Array, unknown, never>
  | BlobHandle
  | BlobSource

/** Attach per-value upload options. */
export const source: (
  body: Uint8Array | Stream.Stream<Uint8Array, unknown, never>,
  options?: { readonly contentType?: string; readonly contentLength?: number },
) => BlobSource

db.entities.Documents.put({ id, owner, body, scan: Offload.source(fileStream, { contentType: "image/png" }) })
```

- A **`Stream`** is **single-use** (§7). The library runs a given `Stream` value at most once,
  for one target object; a retry or re-plan of that same upload reuses it through the ledger
  memo. Giving the same `Stream` value for a second target — another attribute, another item
  of a `Batch.write`, a later operation — fails with `[EDD-9120]` instead of reusing the first
  upload (which would share one version between two rows) or re-running a source that may
  already be drained (which could upload empty content). A re-runnable source is passed as a
  `Uint8Array` or as a fresh `Stream` per use.
- A failure of the source stream fails the operation with `BlobStoreError { reason:
  "SourceFailed", cause }`; the source's own error type is not threaded into the operation's
  channel (it cannot be inferred through the derived input type).
- A **`BlobHandle`** is content to copy, never a pointer to share: the store's `copy`
  capability (server-side `CopyObject` for S3) writes a new version under this item's key, or
  the library streams `handle.stream()` into `put` when the store has no `copy`. This holds
  even when the handle names the version the field already holds.
- Overflow fields take their domain value, as today. A `Stream`, handle or source given to an
  overflow field, or a value of the wrong shape to a binary field, is a `ValidationError`
  (`[EDD-9120]`) — reachable only from untyped code.

### 3.9 Stream decoding and change detection

```ts
// existing, extended — lazy by default (decision 5). For an entity with offloaded fields a
// new overload types the result as Entity.Read<E, M> (today's signature returns unknown).
Entity.decodeMarshalledItem(entity, image, options?: { readonly offloaded?: OffloadMode | OffloadModes })

// new — both images, plus offload change classification
Entity.decodeStreamRecord(entity, record: StreamRecordLike, options?: { readonly offloaded?: … }):
  Effect<Option<EntityChange<View>>, ValidationError | ModeErrors>

interface EntityChange<A> {
  readonly eventName: "INSERT" | "MODIFY" | "REMOVE"
  readonly oldItem: Option<A>
  readonly newItem: Option<A>
  /** Per offloaded field present in either image (domain names). */
  readonly offloaded: Readonly<Record<string, "unchanged" | "rewritten" | "changed" | "added" | "removed">>
}

// EventStore — lazy by default (decision 5); an eager default was rejected (§10.2)
stream.decodeStreamImage(image, { offloaded?: "eager" | "lazy", raw?: boolean })
```

`StreamRecordLike` is structural: the SDK `_Record`, a Lambda `DynamoDBRecord` and an
EventBridge Pipes record all fit (`eventName`, `dynamodb.{ Keys, OldImage?, NewImage?,
StreamViewType?, ApproximateCreationDateTime? }`). `Option.none()` for a record of another
entity type, as `decodeStreamImage` does today.

### 3.10 Garbage collection — `BlobGc` (core)

```ts
const gc = yield* BlobGc.make({
  entities: { Documents }, aggregates: { Orders }, streams: { Ledger },
  reaper: { gracePeriod: "15 minutes", confirm: "auto" },   // confirm: "auto" | "always"
  sweep:  { gracePeriod: "1 day" },
})
// R = never once made; requires DynamoClient | TableConfig(s) | BlobStore to make

gc.reap(records: Iterable<StreamRecordLike>): Effect<ReapReport, DynamoClientError | BlobStoreError | ValidationError>
gc.sweep(member, key):                        Effect<SweepReport, DynamoClientError | BlobStoreError | ValidationError>
gc.sweepPartition(member, partitionKey):      Effect<SweepReport, …>
gc.sweepStore(options?: { prefix?; startAfter?; maxFamilies? }):
                                              Stream<StoreSweepFamily, DynamoClientError | BlobStoreError | ValidationError>
```

`reap` is a records-to-Effect batch processor, usable from a Lambda handler, an EventBridge
Pipe target, or the polled change feed's `runChangeFeed({ onBatch })`. `sweepStore` is the
backstop for leaks no row records (§11.5). Details in §11.

### 3.11 `StorageEncoding` additions

```ts
/** The pointer an attribute value holds, if it is one (pure; no I/O). Accepts both stored
 *  forms: a layout-010 `B` value and a binary field's `~edbp:` `S` text (§4.2). */
StorageEncoding.pointer(stored: AttributeValue | Uint8Array | string): Option<BlobPointer>

interface BlobPointer {
  readonly kind: "json" | "bytes"
  readonly codec: CompressionCodec | "none"
  readonly ref: BlobRef
  readonly objectSize: number
  readonly contentSize: number
  readonly checksum: BlobChecksum
  readonly contentType: Option<string>
}
```

- `decode` / `decodeUnmarshalled` resolve a pointer through the ambient store; a store failure
  is the `cause` of their `ValidationError` (the `CompressorNotRegistered` precedent), so their
  types do not change.
- The `*Sync` twins cannot do I/O: on a pointer they fail with a `ValidationError` naming the
  attribute and pointing at `decode` or `pointer`.
- `valueBytes` / `valueBytesSync` keep measuring the **inline packed** value (their existing
  meaning). A planner compares that with `storedAs.external.threshold` to know whether it
  would be offloaded; `measureAppend` reports what `append` would actually do (§6.10).

---

## 4. Stored form

### 4.1 Dispatch table (extended)

Readers look at the stored value, never at the current config:

| Stored | Attribute kind | Read as |
|---|---|---|
| absent / `NULL` | any | absent / `null` |
| native (`M`, `L`, `N`, …) | packed or eligible | legacy native value (unchanged) |
| `S` | packed or eligible | `JSON.parse` (unchanged) |
| `B`, byte 0 layout `001` | packed or eligible | header → decompress → `JSON.parse` (unchanged) |
| `B`, byte 0 layout `010`, kind json | packed or eligible | **pointer** → resolve per mode (§8) → payload → decompress per pointer codec → `JSON.parse` |
| `B` | binary field (`Uint8Array` encoded side) | native bytes, always (a value stored before `External`, or a field that never was) |
| `S` starting with `~edbp:` | binary field | **pointer** (§4.2) → handle or bytes per mode |
| any other `S` | binary field | a `ValidationError` ("not a binary value or blob pointer"), except in an unmarshalled stream image, where it is base64 of a `B` value (§4.3) |

A pointer on a packed or eligible attribute that is malformed (bad magic, bad trailer,
truncated) is a `ValidationError`: no native value of such an attribute is ever `B` (shape
rule, #147 §4.5). A binary field's pointer is malformed in the same cases, and is a
`ValidationError` too: no native value of a binary attribute is ever `S`.

### 4.2 Pointer layout — Packed layout `010`

```
 bit   7   6   5 | 4   3 | 2   1   0
      layout 010 |  kind |   codec
```

| Field | Bits | Values |
|---|---|---|
| layout version | 7–5 | `010` = blob pointer (this design) |
| kind | 4–3 | `00` json (an overflow value), `01` bytes (a binary field). `10`, `11` reserved |
| codec | 2–0 | codec of the **object bytes**: `000` none, `001` gzip, `010` brotli, `011` zstd (json only; bytes must be `000`). `100`–`111` reserved |

Writers emit only `0x40`–`0x43` (json, none / gzip / brotli / zstd) and `0x48` (bytes). Every
other byte with layout `010` is a `ValidationError` naming the byte ("reserved pointer kind",
"unknown codec code", "compressed bytes pointer is reserved").

Body (all integers unsigned LEB128 unless sized; multi-byte fixed fields big-endian):

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | header (above) |
| 1 | 4 | magic `0x45 0x44 0x42 0x50` (ASCII `EDBP`) |
| 5 | 1 | flags — bit 0: a content type follows; bits 1–7 reserved, must be 0 |
| 6 | 1 | checksum algorithm — `0x01` CRC64NVME (8 bytes); `0x02` SHA-256 (32 bytes, reserved, not written); others reserved |
| 7 | n | checksum (n per algorithm) |
| … | var | object size — bytes of the stored object |
| … | var | content size — bytes the checksum covers (§5): the uncompressed JSON (json), the object (bytes) |
| … | var + k | key length k (1 … 1,024), key (UTF-8) |
| … | var + v | version length v (0 … 1,024), version (UTF-8; `0` length = an immutable key from a key-per-write store) |
| … | var + c | when flags bit 0: content-type length c (1 … 255), content type (US-ASCII) |
| end − 4 | 4 | trailer — low 32 bits of CRC64NVME over bytes `0 … end − 5` |

**Two stored forms of the same bytes**:

- **Overflow fields** store the pointer as a `B` value (decision 9 as written).
- **Binary fields** store it as an `S` value: the ASCII sentinel `~edbp:` followed by the
  unpadded base64url encoding of the same bytes (header `0x48`). `~` and `:` are outside every
  base64 alphabet, so no base64 text starts with the sentinel.

Why binary fields need the `S` form: before 1.43.0 a `Uint8Array` attribute is never dispatch-eligible
(`PackedCodec.classify` treats a binary declaration as `Refused`, and `isDispatchEligible` is
true only for `Structured` shapes). An older reader, including an older stream consumer, would
therefore pass a `B` pointer straight through `Schema.Uint8Array` and return the ~200 pointer
bytes as the field's content, with no error. An older reader that meets an `S` value on a
`Uint8Array` field fails the schema decode with a `ValidationError`, so a mixed-version fleet
fails loudly for both kinds, as decision 9 intends. The alternative — keep `B` and rely on the
rollout order alone, accepting that an old reader silently returns pointer bytes — is listed
in §24.2.

Notes:

- **The bucket is not in the pointer.** It is the layer's configuration, so one pointer
  resolves against each region's replica bucket (§16) and a bucket can be renamed by copying.
- **Lengths, not delimiters**: keys and versions are opaque strings up to 1,024 bytes (F10).
- **Magic + trailer** catch truncation and corruption of a stored pointer.
- **Typical size** ~200 bytes as `B` (98-byte hashed key + prefix, 32-byte S3 version id, a
  short content type), ~275 bytes as `S`. The **upper bound** the item budget uses is computed
  from the actual key length and the store's declared `limits.maxVersionBytes` (S3: 1,024;
  §6.3).
- The trailer and the content checksum both use the vendored CRC64NVME (§5), so the schema
  package needs one checksum implementation.
- **Strict decoding.** A pointer has exactly one encoding in each form. Besides the refusals
  above, readers refuse non-minimal or unsafe LEB128 integers, bytes left over before the
  trailer, a key or version that is not valid UTF-8, an object size that differs from the
  content size when the codec is `000`, and `S` text that is padded or not canonical base64url.
  A pointer of the other kind than its attribute stores — a bytes pointer as `B` on a packed
  attribute, a json pointer as `S` text on a binary one — is malformed too.

`PackedCodec.parseHeader` recognises layout `010`; `unpackBytesSync` returns a decoded
`BlobPointer` value for it instead of fetching (the codec stays synchronous and AWS-free), and a
new `parseBinaryPointerText` decodes the `S` form. The caller resolves pointers (§8.1). Readers
before 1.43.0 meet byte 0 `0x40`–`0x5F` on a packed or dispatch-eligible attribute and fail with
today's "layout version 2, which this version does not support (written by a newer
effect-dynamodb?)", and meet an `S` value on a binary attribute and fail its schema decode.

**One case still misreads before 1.43.0**, as it already does for #147's packed values: an overflow
field whose schema is `Opaque` (`Unknown`, `Json`, `object`) and that the old reader's code does
not configure `Packed` is not dispatch-eligible there, so the old reader returns the `B`
pointer as the field's value. The guide states it beside #147's identical caveat.

### 4.3 Base64 disambiguation (widened)

Layout `010` header bytes `0x40`–`0x5F` base64-encode to a first character in `Q`–`X`
(`0x40`–`0x43` → `Q`, `0x48` → `S`). `isBase64PackedText` widens from `I`–`P` to **`I`–`X`**.
Packed JSON text starts with `{` or `[` (the object/array shape rule), never a base64
character, so §4.3 of #147 still holds and every future layout keeps it (layout `011` would
encode to `Y`, `Z`, `a`–`f`).

For a binary field in an **unmarshalled** image, a string starting with `~edbp:` is a binary
pointer; any other string is base64 of a `B` value (the only way an unmarshalled binary
arrives as text) and is decoded to native bytes. In DynamoDB JSON the `S` / `B` tags decide.

### 4.4 What the object holds

| Kind | Object bytes | `Content-Type` |
|---|---|---|
| json (overflow) | the packed payload **without** the header byte: the UTF-8 JSON (codec none) or its compressed bytes | `application/json` (codec none), else `application/octet-stream` |
| bytes (binary) | the field's bytes | the write's `Offload.source` content type, else `External({ contentType })`, else `application/octet-stream` |

No `Content-Encoding` is set: a fetch-based client (browsers through a presigned URL, a web
runtime's SDK handler) would transparently decompress and break both the byte count and the
checksum. The codec lives in the pointer and in object metadata (§4.6).

### 4.5 Object keys

Each object key is hashed, so item keys never leak into S3 logs and inventories and always fit
1,024 bytes:

```
key = <offload.prefix, else the store prefix> <P> "/" <F> "/" <O>

P = hex128(SHA-256("edd-blob/1" 0x00 table 0x00 canon(pk)))           — the partition
F = hex128(SHA-256(P 0x00 canon(family sk)))                           — the item family
O = hex128(SHA-256(F 0x00 canon(row sk) 0x00 attribute))               — the row + attribute
```

`hex128` is the first 16 bytes of the digest as 32 lowercase hex characters (collision
probability is negligible at 128 bits; a collision would let the sweep see another item's
versions, which is why the digest is cryptographic). `canon` writes a key attribute value with
its type (`s:` + text, `n:` + the number's canonical text, `b:` + standard base64), so `S "1"`
and `N 1` differ. `table` is the physical table name. Strings enter the digests as UTF-8, and
`P` and `F` enter the next level as their hex text. *(Implementation notes, commit 5: a number
is canonicalised — digits without leading or trailing zeros and a decimal exponent, `"1.50"` →
`15e-1`, zero → `0` — rather than hashed as spelled, so a key DynamoDB returns with its zeros
trimmed hashes like the one written; the library's own tables key only on strings. The parts are
separated by `0x00` and only the last part may contain it, except that the row key precedes
the attribute name in `O`: an attribute name containing U+0000 is refused, which keeps the digest
input unambiguous.)*

*Key text (`escapeKeys: true`, §11.10).* Offloading requires `escapeKeys: true`, and `canon`
hashes a key's text exactly as stored, so that setting's key text enters the digests as it is: a
number composite in its order-preserving text (`-5` → `-9999999999999994:`, `-3.14` →
`-9999999999999996.85:`), and every composite's U+0000–U+0025 escaped as `%XX` (`#` → `%23`,
space → `%20`, `%` → `%25`, U+0000 → `%00`), in partition and sort keys alike, with non-ASCII text
as UTF-8. Nothing is re-escaped or decoded first: two rows have the same object keys only when
their stored keys are equal. A composed key therefore never holds U+0000; a raw one may, and stays
unambiguous by the rule above. The same values' key text under `escapeKeys` off is another
partition's `P`, which is why a row holding a pointer must never move to it (§11.10). A binary key
value (a raw table's, or a Z-order index's — never a primary key the library composes) is
`b:` + standard padded base64. Pinned by `BlobKeys.test.ts` ("key text the composer writes":
fixed vectors cross-checked with Python's `hashlib`).

The digest is a **fixed SHA-256**, a pure-JS implementation vendored in the schema package
beside CRC64NVME (`internal/Sha256.ts`, synchronous, ~120 lines, tested against Web Crypto's
`subtle.digest`). It does **not** go through Effect's services (Effect 4.1 has no `Crypto`
service: randomness is `effect/crypto`'s `SecureRandom`, hashing its `Digest`): the key is a
storage format that GC trusts to decide what to delete, so it must not depend on a service a
caller can replace — a deterministic `SecureRandom` given to `DynamoClient.make({ crypto })` for
tests, or a `Digest` layer — and it must be computed synchronously on every runtime, where
`Digest` is effectful (Web Crypto's `digest` returns a promise). Unbound write paths
(`TransactableOps`, EventStore) have neither service in context either.

**What a key says about ownership.** The trailing `P/F/O` identifies a table (by name), a
partition, an item family and a row attribute; the leading prefix only places it. GC uses this
to stay table-local (§11.2): a version is *own* to a member only if its key's `P` and `F` are
the ones that member computes for its own table, whatever the prefix in front of them.

| Row | family sk | row sk | Objects per key |
|---|---|---|---|
| entity live item | live SK | live SK | one version per write of the field |
| retain snapshot `#v#N`, tombstone `#deleted#…` | live SK | — (they copy the live row's pointers; never upload) | — |
| time-series append | live SK | **the event item's SK** | one (the current item and the event item share it) |
| time-series `.update().set()` of an `appendInput` field | live SK | live SK | one per such update |
| EventStore event | `""` (the stream) | event SK | one (events are immutable) |
| EventStore snapshot | `""` | snapshot SK | one version per snapshot write |
| aggregate edge item | edge item's SK | edge item's SK | one version per write of the edge |

Why three levels:

- **The family prefix makes the sweep local**: one `ListObjectVersions` with prefix `…P/F/`
  finds every object any row of the item ever had, including uploads of crashed writes that
  no row names (§11.4).
- **The partition prefix** lets an aggregate or a stream be swept as a whole.
- **Per-event keys for time-series appends** **(confirmed)** keep a hot series under
  S3's ~100,000 versions per key (F11). A stable key per item and attribute, as decision 7
  states, would put one version per append on a single key. Every row still has its own
  stable key; an append's object simply belongs to the event item it is first written for.

### 4.6 Object metadata

`x-amz-meta-*`, US-ASCII, kept under the 2 KB limit (F10):

| Key | Value |
|---|---|
| `edd-v` | `1` |
| `edd-table` | physical table name |
| `edd-entity` | entity type, or `<stream>.event` / `<stream>.snapshot` |
| `edd-attr` | stored attribute name |
| `edd-item` | base64url of the canonical `[pk, sk]` of the row, whenever the whole metadata set still fits in 2 KB (a canonical row key up to roughly 1,100 bytes); otherwise omitted and `edd-item-sha256` (hex SHA-256 of it) is set instead |
| `edd-kind` | `json` / `bytes` |
| `edd-codec` | json only: `none` / `gzip` / `brotli` / `zstd` |
| `edd-checksum` | json with a codec: base64 of the content CRC64NVME (S3's own checksum covers the compressed object, §5) |

Metadata is for traceability (inventory, logs, incident tooling) and for one library reader:
the store-wide sweep recovers an orphaned family's item key from `edd-item` (§11.5). A family
whose keys are too long for `edd-item` is reported by that sweep as unattributable rather than
swept.

*Implementation notes (commit 5, `internal/BlobMetadata.ts`):* the canonical `[pk, sk]` is the
UTF-8 JSON text of `[canon(pk), canon(sk)]` (§4.5's `canon`), `edd-item` its unpadded
base64url, `edd-item-sha256` the hex SHA-256 of the same bytes, `edd-checksum` standard
(padded) base64. The 2 KB is counted conservatively: the UTF-8 bytes of every value and of every
key with its `x-amz-meta-` header prefix. An entity type or attribute name that is not printable
US-ASCII without `%` is written with `%XX` UTF-8 escapes for the other characters (`%` itself is
`%25`), so every value is US-ASCII and reads back exactly. A set that does not fit even with
`edd-item-sha256` (an entity type or attribute name of kilobytes) is left for the store to
refuse — diagnosed on failure, not pre-checked. The parser refuses anything this scheme did not
write (another `edd-v`, a missing or malformed field, both or neither of `edd-item` /
`edd-item-sha256`) and matches keys case-insensitively, as S3 lowercases them.
 The `edd-item` JSON
escapes what JSON escapes (`"`, `\`, U+0000–U+001F) and keeps the rest as UTF-8, so the
composer's key text (§4.5), raw text holding control characters, numbers (read back by their
canonical text) and binary keys all round-trip (`BlobMetadata.test.ts`, "round-trips edd-item").

### 4.7 Binary fields: dispatch eligibility and switching

Every attribute whose encoded side is `Uint8Array` is dispatch-eligible for **bytes pointers**,
whether or not it is configured `External` — the binary analogue of #147 §4.6. A native binary
value is always `B` and a pointer always `S`, so the check costs one `typeof` on a native value
and no native value can be misread as a pointer.

- **Switching on** (`External` added to an existing `Uint8Array` field): existing native values
  keep reading, as inline `BlobHandle`s (`location: "inline"`) or `Uint8Array` per mode. New
  writes go to the store.
- **Switching off** (`External` removed): the field's type reverts to
  `Uint8Array` and the entity no longer carries `BlobStoreError`. Existing pointers still
  resolve, eagerly, through the ambient store; a store failure there is the `cause` of a
  `ValidationError` (the `CompressorNotRegistered` precedent), so error types stay honest. GC
  no longer covers the field. The docs therefore recommend rewriting the items (any `put` /
  `.set()` of the field stores it natively) before removing `External`, and keeping the reaper
  configured until then.
- **Overflow fields** switch like Packed, with the same trade-off: removing `external`
  (keeping `Packed`) or `Packed` altogether leaves pointers readable through the same
  `ValidationError`-cause path, and GC no longer covers the field. A "retired" declaration that
  keeps GC coverage for either kind is the alternative (§24.2).

---

## 5. Content checksum

**Decision: CRC64NVME (the NVMe CRC-64), over the field's *content* bytes, computed by the
library with a vendored pure-JS implementation, handed to S3 for server-side validation.**

| Requirement | SHA-256 (pure-JS, library) | CRC-32 / CRC-32C (S3 full-object) | CRC64NVME (this design) |
|---|---|---|---|
| Same value for single PUT and multipart (decision 12) | yes (library-computed) | yes (F6) | yes — S3 full-object CRC64NVME is defined over the whole byte stream, and the library computes the same value (F6) |
| Validated by S3 on upload | single PUT only; multipart SHA-256 is composite-only (F6) | yes, both paths | yes, both paths (`ChecksumType: FULL_OBJECT`) |
| Accidental collision between two different contents | negligible | ~2⁻³² per comparison — too high for change detection over millions of writes | ~2⁻⁶⁴ |
| Runtime-neutral | pure-JS hash needed (F9) | pure JS | pure JS (~1 GiB/s measured on Node 24) |
| CRT-free | n/a | yes | yes: the SDK ≥ 3.957.0 falls back to pure JS (F7), and the library supplies the value anyway |
| Cost | ~314 MiB/s | fastest | ~1 GiB/s |
| Collision-resistant against crafted input | yes | no | **no** — fine for change detection and integrity, never described as tamper evidence |

CRC64NVME is not the only full-object option (F6): it is chosen over CRC-32 / CRC-32C for its
width, and over SHA-256 because S3 can validate it on both upload paths.

**What the checksum covers.** The pointer's checksum is over the **content**:

- the field's bytes (binary) — identical to the object's bytes, so it *is* S3's full-object
  checksum of the object;
- the **uncompressed UTF-8 JSON** (overflow), before compression, exactly as the packer
  serialised it (insertion key order). When the object is compressed, the S3 store also sends
  S3 a CRC64NVME of the compressed object bytes for upload validation. S3 keeps that second
  checksum with the object; the pointer does not carry it.

Covering content, not object bytes, makes the checksum independent of codec and of storage
location. That is what lets change detection (§10.3) compare an inline value with a pointer —
the CRC of an inline `S` text, or of a decompressed inline `B` payload, is computed locally —
and treat a codec change as "rewritten", not "changed". A legacy native map (`M`) has no
canonical JSON bytes, so native-vs-pointer always classifies as "changed".

**What a checksum match is allowed to decide.** CRC64NVME is linear: anyone who can write a
field can craft content with a chosen checksum and length. So the library never lets a match
alone skip a write or carry a pointer (§6.4). It uses checksums only where a false match is
harmless or is backed by a real comparison:

- **Read verification** (§8.6) — integrity against corruption, not tampering.
- **Change classification** (§10.3) — `rewritten` means "probably identical": equal checksum
  algorithm, checksum **and content size**. The docs say a consumer that must not miss a
  change (an indexer, a scanner) treats `rewritten` as `changed`, or compares content.
- **Immutable assertions** (§6.5) — a match is the fast path; a mismatch is confirmed by a
  structural comparison of the fetched value before the write is refused, because the JSON's
  key order is part of the bytes and a restated record with the same entries in another order
  must not fail as "immutable differs". A restated immutable value that passes is dropped from
  the write — the attribute is left exactly as stored, never re-uploaded or re-pointed — so a
  crafted match lets different bytes through the check but never into the item.

Members that need adversarial integrity are a follow-up: algorithm code `0x02` (SHA-256) is
reserved in the pointer for it.

**Implementation.** `packages/schema/src/internal/Crc64Nvme.ts`: slice-by-8 over `Uint32Array`
pairs (no `BigInt` in the loop), with an incremental `make() → { update(bytes), digest(): Uint8Array(8) }`
API. It is ~100 lines, so it is vendored rather than taken as a dependency: the schema
package's pointer codec needs it (trailer) and must stay AWS-free (`aws-free-guard.test.ts`).
The test suite checks:

- the standard check value (`"123456789"` → `ae8b14860a799888`);
- the value of `@aws-sdk/crc64-nvme` (a dev dependency of `effect-dynamodb` only) over
  random inputs and chunkings;
- S3's / MinIO's returned `ChecksumCRC64NVME` for single-PUT and multipart uploads of the
  same bytes (connected).

Core re-exports it as `BlobStore.crc64nvme` for store implementers.

**Fallback if a fact is wrong.** If a target S3-compatible store cannot validate full-object
CRC64NVME, the S3 store omits the upload checksum headers. The pointer checksum is still the
library's own, so change detection and read verification are unaffected; only server-side
upload validation is lost, and the connected tests detect which case applies.

---

## 6. Write path

### 6.1 Phases

Every write that can carry an offloaded value runs these phases in order:

1. **Encode and pack inline** — today's path, unchanged: schema encode, renames, sparse
   flattening, `packValueSync`. An overflow value is now its inline stored form (`S` / `B`).
2. **Local guards** — the checks that can refuse the write without sending anything
   (immutable assertions, expression guards, refusals). They are reordered to run before
   step 4 where they ran after packing (read-merge update immutables, `Entity.ts:6168-6176`).
3. **Route** — overflow values at/above their threshold, then the item budget (§6.3), decide
   what goes to the store. Binary inputs always do. Attributes the write does not change keep
   their stored value (§6.4).
4. **Upload** — through the operation's upload ledger (§6.2), at the store's
   `writeConcurrency` (default 8). Each upload replaces the attribute's stored value with its
   pointer. The ledger records when each upload started.
5. **DynamoDB request** — unchanged builders; the request now carries pointers. Before sending,
   the choke point refuses any request that carries an upload started more than the store's
   `maxUploadAge` ago (default 1 hour): the operation fails with `BlobStoreError { reason:
   "Expired" }` and its uploads, still `pending`, are deleted at exit. This is what makes "an
   upload younger than `maxUploadAge` may still be in flight; an older one never commits" an
   enforced invariant that GC can rely on (§11.4) — however long a multipart upload of another
   field of the same operation takes.
6. **Settle** — at the DynamoDB client choke point (§6.2), from the request's outcome.

Uploads happen as late as possible, so a write refused by a local guard uploads nothing; a
write refused by DynamoDB rolls back.

### 6.2 The upload ledger

**Why a ledger, not "delete on failure" inside each op.** The brief's rule — "on DynamoDB
failure delete exactly the written version" — is unsafe as stated, for two reasons:

- **Transaction planning.** `Transaction.transactWrite` plans an update or delete by running
  the real op against a recording client that answers its write with a "recorded, not sent"
  failure (`internal/TransactPlan.ts`), and re-plans on every attempt (up to 3). A per-op
  rollback would delete the very version the transaction then commits.
- **Unknown outcomes.** A timeout, an `InternalServerError` or an interruption after sending
  can follow a *committed* write; deleting then leaves a committed pointer to a deleted
  version.

So rollback deletes only what DynamoDB **provably** did not commit **(confirmed**:
decision 7 says "on DynamoDB failure delete exactly the written version"; this narrows it).

**Mechanism.** `internal/BlobLedger.ts` — a `Context.Reference<Ledger | undefined>`, scoped like
consumed capacity's `CurrentOperation`:

- **Root.** The outermost library operation that can upload opens the ledger; nested library
  calls reuse it. Roots include an entity write, `Transaction.transactWrite`, `Batch.write`,
  `EventStream.append` / `writeSnapshot` / `commandHandler`, an aggregate write, each
  projection row's read-fold-write (retries included; *as built in commit 6*, it was "a
  projection's batch") and `GeoIndex.put` (through the entity put it runs). Bound clients'
  captured context is detached from it (`detachContext` clears it, as it clears
  `CurrentOperation`), and so is a long-lived forked fiber's (`Capacity.detached`).
- **Entries.** Each upload is an entry `{ ref, store, memo, startedAt, state }`, starting
  `pending`. `memo` is `(key, contentChecksum, contentSize, kind, contentType)` for buffered
  content, or **(input `Stream` identity, target object key)** for a stream. An upload whose
  memo matches an entry reuses it: a re-planned transaction, a rebuilt `additionalItems`, or a
  `commandHandler` retry that decides the same content uploads once. A `Stream` already used
  for another target is refused (`[EDD-9120]`, §3.8), never matched. `store` is the store the
  upload went to (an op's captured store, §3.6), so rollback deletes from the right one.
- **Settling at the choke point.** `Capacity.client` (the one place every library DynamoDB
  request goes through; it wraps whatever `DynamoClient` is in context) settles entries. When
  a ledger with entries is active, it scans each write request (`PutItem`, `UpdateItem`,
  `DeleteItem`, `TransactWriteItems`, `BatchWriteItem`) for pointer values (both stored forms)
  and settles the entries they name by the outcome (table below). With no ledger, or an empty
  one, nothing is scanned.
- **Lattice.** `pending < rejected < inDoubt < committed`: an entry only moves up, so a version
  committed by attempt 2 is never deleted because attempt 1 was rejected.
- **Exit.** On the root's exit (success, failure or interruption) it **deletes `pending` and
  `rejected` entries** and keeps `inDoubt` and `committed` ones. The delete runs uninterruptibly,
  in one `store.delete` call per store, best-effort. A failed rollback delete never replaces the
  operation's own outcome.
- **Unsettled uploads are reported, not just logged.** `inDoubt` entries and failed rollback
  deletes are logged at `Warning` with the table, entity type, attribute, row key and refs, and
  delivered to the `Offload.layerObserver({ onUnsettled })` observer when one is provided
  (§3.6), so the application can queue the item for `gc.sweep`. So are, when the root exits,
  uploads whose version no entry names (*as built in commit 6*): a lost multipart completion
  (`completeLost`, §7) and a store `put` answer refused as naming no version of the requested
  key (`answerRefused`: no ref, a ref outside the key, a ref already returned for another
  upload), reported by the requested key with no ref — the answer's ref is never deleted. Leaks no process could report
  (a crash between upload and exit) are found by `gc.sweepStore` (§11.5). The library never
  interrupts an upload it has sent (*as built in commit 7*): the uploads of one write run
  concurrently, and a failed one fails the write only once every other has settled, so each
  version a store wrote is registered — and rolled back — rather than left behind by a
  sibling's failure.
- **Read cache.** The ledger also maps each entry's ref to the wire value or bytes it uploaded,
  so decoding what the op just wrote (§6.13) never re-fetches it.

**Transactions carry the library's own idempotency token.** Every `TransactWriteItems` the
library sends with a pointer in it carries a `ClientRequestToken` the library generated for
that built request (a fresh one per re-plan or attempt, since the content may differ), kept on
the ledger. A resend of the same request object — by the SDK, or by a retrying wrapper inside
a custom `DynamoClient` — is then idempotent for 10 minutes (F19), so a cancellation proves the
transaction did not commit.

Settlement by outcome (evidence first, metadata second):

| Request outcome | Pointers it carried become |
|---|---|
| Success (`PutItem`, `UpdateItem`, `DeleteItem`, `TransactWriteItems`) | `committed`. Exception: an `UpdateItem` that writes an offloaded attribute with `if_not_exists` (upsert of an immutable field) settles by the returned `ALL_NEW` image — a pointer the item did not keep is `rejected` |
| `BatchWriteItem` | processed requests → `committed` — per pointer: one a processed request carried is `committed` even when another request in the same call that carried it is unprocessed (*as built in commit 6*). A request still in `UnprocessedItems` after the library's retries → `rejected` only if **every** `BatchWriteItem` response that carried it reported `$metadata.attempts === 1`; otherwise (an SDK resend, an unknown attempt count, a chunk lost to a transport error) → `inDoubt`. `BatchWriteItem` has no idempotency token, so a lost response followed by a throttled resend may hide a commit |
| Not sent (marked `NotSent`: recorded for a transaction, answered locally) | unchanged |
| `TransactionCanceled`, `ValidationException` or `ConditionalCheckFailed` on a `TransactWriteItems` carrying the library's token | `rejected` |
| `IdempotentParameterMismatch` or `TransactionInProgress` on a `TransactWriteItems` | `inDoubt` |
| `ConditionalCheckFailed` on a single-item write (always sent with `ReturnValuesOnConditionCheckFailure: ALL_OLD` when it carries a pointer) | **by the returned item**: it holds the pointer → `committed` (an earlier attempt applied it). It is absent or does not hold the pointer → `rejected` for members whose rows never copy pointers (plain entities, EventStore snapshot rows, projection rows); `inDoubt` for `retain`, `softDelete` and `timeSeries` members, where an earlier commit's pointer may have been copied into a snapshot or tombstone the live row no longer shows |
| `ValidationException`, `ResourceNotFound`, `ItemCollectionSizeLimitExceeded`, throttling, `TransactionConflict`, `AccessDenied` on a single-item write | `rejected` when the error reports `$metadata.attempts === 1`; `inDoubt` when it reports more, or reports none (a mock, a wrapper, or a client that hides the SDK error) |
| `ValidationException`, `ResourceNotFound`, throttling or `AccessDenied` refusing a whole `TransactWriteItems` or `BatchWriteItem` (*added in commit 6*) | `rejected` when the error reports `$metadata.attempts === 1` — DynamoDB applies nothing of a request it refuses; `inDoubt` otherwise (a `TransactWriteItems` `ValidationException` carrying the library's token is `rejected` by the row above) |
| Transport error, `InternalServerError`, any other `DynamoError`, or interruption while the request is in flight | `inDoubt` |

Notes:

- `rejected` by `ALL_OLD` evidence on a plain member can delete a version that an earlier
  attempt committed and a concurrent writer has since superseded. No row references it any
  more, so this only skips the reaper's grace for that version; the docs state it.
- **A retry layer inside a custom `DynamoClient`** (an Effect-level retry or timeout under the
  library's choke point) is invisible to the ledger: it sees only the last call's outcome. With
  the evidence rules above such a layer can only turn a rollback into `inDoubt` (kept), except
  for a non-`ConditionalCheckFailed` refusal whose final call reports one SDK attempt after an
  earlier call committed. The guide therefore says: put retries in the SDK client's retry
  strategy, not in a wrapper, for a table with offloaded fields.
- A version deleted by rollback is one no committed row can name.

**PartiQL writes (`insert()`, #189; owner decision 2026-11-14).** `insert()` of an offloading
entity routes and uploads as `put` does (§6.5) and sends the item as one `ExecuteStatement`
`INSERT`, or, with unique sentinels, an `INSERT`-only `ExecuteTransaction`. The choke point
settles both: `ExecuteStatement` and `ExecuteTransaction` join the write commands it scans, their
pointers read from `Parameters` and `TransactStatements[].Parameters` (a `SELECT` is a read and
settles nothing). An `ExecuteTransaction` carrying a pointer carries the library's own
`ClientRequestToken`, as a `TransactWriteItems` does: the SDK models it as an idempotency token,
so a resend of the same request object is idempotent and a cancellation proves no attempt
committed. By outcome:

| Request outcome | Pointers it carried become |
|---|---|
| Success | `committed` |
| `ExecuteStatement` refused with `DuplicateItemException` (the item exists; DynamoDB Local names it `DuplicateItem`), `ConditionalCheckFailedException`, or a single-item refusal of the table above, reporting `$metadata.attempts === 1` | `rejected` |
| The same, reporting more attempts or none | `inDoubt`. An `INSERT` is not idempotent: a resend after a commit whose response was lost is refused as a duplicate of the item it wrote, so `DuplicateItemException` proves non-commit only for a statement sent once |
| `TransactionCanceledException`, `ValidationException` or `ConditionalCheckFailedException` on an `ExecuteTransaction` carrying the library's token | `rejected` (a duplicate item or sentinel cancels the transaction) |
| `IdempotentParameterMismatchException` or `TransactionInProgressException` on an `ExecuteTransaction` | `inDoubt` |
| A whole-request refusal of an `ExecuteTransaction` (as for `TransactWriteItems`) | `rejected` when sent once; `inDoubt` otherwise |
| Transport error, `InternalServerError`, any other error, or interruption in flight | `inDoubt` |

### 6.3 Item budget

Where the library builds the **whole item** — put / create, the read-merge update, the guarded
put, `Batch.write` / transaction puts, aggregate edge items, event items, snapshot items — after
phase 1:

```
route(item):
  out = { f ∈ overflow fields : bytes(stored f) ≥ f.threshold }         // per-field thresholds
  if itemBudget === undefined → out
  size = itemBytes(item with every f ∈ out as a pointer at its upper bound)
  for f in overflow fields \ out, by attributeBytes(stored f) desc, then attribute name:
    if size ≤ itemBudget → break
    out ∪= { f }; size = itemBytes(…)
  → out      // may still exceed the budget: DynamoDB's own limit is then diagnosed on failure
```

- Sizes are `internal/ItemSize.ts`'s — the bytes the failure diagnosis and `Batch.write` chunking
  already use (`itemBytes`, `attributeBytes`).
- The pointer's real size depends on the `VersionId`, known only after upload, so routing
  counts each pointer at an **upper bound**: its key length (known: §4.5) plus
  `store.limits.maxVersionBytes` (S3: 1,024; memory: 32), the content type and the fixed
  fields. The real pointer is never larger, so an item the planner fits does fit.
  Deterministic tie-breaking keeps two writers of the same item routing alike.
- **UpdateItem paths** (standard `update().set()`, `upsert`, time-series `append`) send only
  the changed attributes, so the whole item is not in hand. Per-field thresholds apply. The
  budget applies **on failure**, the diagnose-on-failure way: when
  DynamoDB rejects the request for item size (the existing diagnosis names it) and the entity
  has a budget, the update runs **once more on the read-merge path**, which has the whole item
  and routes it. The retry runs in the same operation and ledger, so it reuses the first
  attempt's upload of any content it routes again (the ledger's memo, §6.2); a first-attempt
  upload the retry does not reuse is deleted when the operation exits, as every upload no
  committed request names is. Two paths
  cannot take that retry and apply thresholds only (documented, and pinned by tests):
  - time-series `append`: its CAS transaction has no read-merge form;
  - an update that mixes record operations with path operations (`.pathSet()` and friends):
    the read-merge path is gated on `!pathOpsPresent` (`Entity.ts:5820-5826`), so such an
    update fails with the diagnosed item-size error as today.

### 6.4 Which pointers a write may carry

A write request may contain a pointer in only three ways, and **every pointer the operation did
not upload itself is pinned by the request's own condition**:

1. **Uploaded by this operation.** Every attribute the write names — `put` / `create` (the
   whole item), `.set()`, `upsert`, an `appendInput` field — is uploaded afresh, even when its
   content equals what the row holds. Nothing is compared by checksum to skip an upload (§5).
2. **Copied within one transaction** — retain snapshots, soft-delete tombstones and restore
   copy the stored value of a row the same `TransactWriteItems` also writes, under conditions
   that pin it: a retain update or delete is guarded by the exact version it read; a
   soft delete copies the live row under `deleteGuard(current, "item")`, which compares every
   attribute (and whose too-wide fallback now orders offloaded attributes first, so they are
   always compared); a restore copies a tombstone (tombstones never change) under
   `attribute_exists` on it. Time-series event items hold the pointer the same append
   uploaded. Unchanged behaviour: the bytes are copied (`buildSnapshotItem`, `{ ...raw }`
   tombstones, `restoredItem = { ...deletedRaw }`, `packedStored` on both append items).
3. **Kept because the write does not change the attribute.** On the read-merge path an
   attribute the update does not name is carried byte-identical (#147 §6.2), and the "write
   only what differs" diff leaves it out of the request altogether. Only a whole-item `Put`
   — the read-merge update's too-wide fallback — writes such a value back, and then under
   the exact version guard (versioned) or a `deleteGuard(current, "item")` that compares every
   offloaded attribute (unversioned; offloaded attributes come first in the fallback's order,
   so a narrowed guard never drops them).

Two consequences:

- **No "carry-on-equal".** The previous draft let a read-merge update, a guarded put, an
  aggregate update or a projection write the pointer it read when the new content's checksum
  matched. On an unversioned entity those writes are not conditioned on the offloaded
  attribute (`Entity.ts:6243-6299` guards `attribute_exists` plus computed inputs;
  `planPut` guards the unique attributes, `Entity.ts:4644-4663`; aggregate group `Put`s carry no
  condition, `Aggregate.ts:3593-3607`), so a stale writer could put back a pointer a concurrent
  writer had already superseded and the reaper had freed. And a checksum match is forgeable
  (§5). Restated identical content therefore costs one `PUT`; the docs point "change one
  field" at `update().set()`. The one remaining reuse — projection row rewrites — compares the
  actual content and adds its own pin (§6.11).
- **A superseded pointer never comes back.** Once a version leaves a row, no library write can
  put it back: every non-uploaded pointer in a request is pinned to the row still holding it.
  That is what makes the reaper's direct free (§11.3) sound. A `BlobHandle` given as input is
  copied (§3.8). Writers outside the library (raw SDK writes, scripts that round-trip
  `asNative` rows, pre-#179 writers during a rollout) are outside this guarantee; the guide
  says so.

### 6.5 Entity single-item writes

| Path | Where (today) | Change |
|---|---|---|
| `put` / `create` | `Entity.ts` `put`, after `packFields` (~`:5443`) | route + upload after the tombstone read and local guards, before `runGuardedPut` / `putItem`. Every offloaded value uploads, guarded put included |
| `upsert` | `upsert` SET builder (~`:8610`) | each offloaded value uploads before it becomes `:v`; immutable offloaded fields keep `if_not_exists` and settle by `ALL_NEW` (§6.2) |
| `update` record `.set()` (UpdateItem) | `runUpdate` SET loop (~`:6814`) | upload, `SET #f = :ptr`; `.remove()` / `null` unchanged (`REMOVE #f`) |
| `update` read-merge (retain / unique / computed composites / both images) | `runUpdate` (~`:6161`) | named fields route per §6.3 on the merged item and upload; untouched pointers stay byte-identical and out of the request; immutables run before uploads |
| `update` too-wide fallback `Put` | `runUpdate` (~`:6320`) | unchanged guard choice (version when versioned, else `deleteGuard(current, "item")`), with offloaded attributes first in the fallback order so every carried pointer is compared |
| immutable assertions | `packedImmutableMismatch` (~`:2463`) | a stored pointer compares by content checksum and size with the restated value's JSON / bytes. A match passes; a mismatch is confirmed by fetching the stored value and comparing structurally (`attributeValueEquals`, key-order-insensitive, as today) before refusing. A restated immutable value that passes is dropped from the write: the attribute stays as stored |
| vector source text | `unpackedDomainCopy` (~`:2608`) | an untouched offloaded source field is resolved eagerly (one GET) when the embedding must be recomputed; documented |
| `patch` / `updateOrCreate` / `deleteIfExists` | as `update` / `delete` | — |
| `delete` | — | no uploads; `ALL_OLD` return values decode per mode (§8.4) |
| `insert` (PartiQL, #189) | `Entity.ts` `put`, its `insert` branch before `runInsert` | route + upload as `put` does, after the local guards (`[EDD-9110]`); the `INSERT` (or `INSERT`-only transaction) is settled by the ledger (§6.2); the result decodes the written values (`decodeWritten`, no GET) |

*Escaped keys only (§11.10), commit 7:* an offloading entity is bound only on a schema with
`escapeKeys: true` (`[EDD-9146]`, §13), so every op composes the one key text it writes and
there is no other key text an item could be under: routing runs on that key and every pointer
is keyed by it. `append`'s result and its stale `current` decode through the offload decoder
in the follow-up read and compare-and-swap paths. An index a collection injects after
`make()` (`_injectIndex`) is checked against offloaded fields as a declared one is, then added
to the mutable `allIndexes` the write paths compose from.

### 6.6 `Batch.write`

`validateAndBuildPutItem` (`TransactableOps.ts:543`), the put builder `Batch.write`, transaction
puts, `additionalItems` and projections share, gains the route + upload phases. Each op is
built under its own captured `BlobStore` and compressor registry when it is a bound builder
(§3.6), the ambient ones otherwise. `Batch.write` builds every item (uploading) before sending
chunks, as today. Settlement is per request (§6.2):

- processed requests → `committed` (per pointer: one any processed request carried, §6.2);
- `UnprocessedItems` left after retries → `rejected` only when every response that carried the
  request was a first attempt, else `inDoubt`;
- a chunk lost to a transport error → `inDoubt`;
- versioned create-only chunks are transactions → §6.2's `TransactWriteItems` rule;
- a chunk whose uploads exceeded `maxUploadAge` before it was sent fails with `Expired`
  (§6.1); the batch reports what it had already written, as for any other mid-batch failure.

A partial batch therefore leaves exactly the uploads of written (or possibly written) items.
Its error type is in §9.3.

### 6.7 `Transaction.transactWrite`

- **Puts** upload in the shared builder, under each bound op's captured store (§3.6).
  **Planned updates and deletes** run under the recording client: their uploads go into the
  transaction's ledger, and their recorded write is `NotSent`, so nothing settles until the
  transaction's own `TransactWriteItems` does.
- **Re-planning** on a lost race hits the memo, so a retry with the same content uploads
  nothing new. Content that changed between attempts (a planned update recomputed from a newer
  row) uploads afresh, and the superseded attempt's entry stays `pending` → deleted at exit.
- **Each attempt** carries a fresh library `ClientRequestToken` (§6.2), so its cancellation
  (`TransactionCanceled`) is `rejected` for every pointer in the request.

### 6.8 Time-series `append`

`appendCore` packs `appendInput` fields once; the route + upload phase
runs on that one value:

- the object key is the **event item's** (§4.5);
- the same pointer is `SET` on the current item and written on the event item;
- a stale CAS or user-condition failure is `TransactionCanceled` → `rejected` → deleted. The
  operation fails with `StaleAppend` (or the condition's error), as it would without offloading;
- the follow-up `GetItem` decodes the current item; offloaded fields this append wrote come
  from the ledger's read cache, others per mode;
- `.update().set()` of an `appendInput` field writes no event and keys its object by the
  current item (§4.5). The reaper confirms against the family before freeing it (§11.3).

### 6.9 Aggregates

Aggregates build items outside entity ops (`decomposeAggregate`, `packAggregateGroups`,
`buildDynamoItems`, `writeTransactionGroups`), so the edge entity's offload is applied
explicitly, as #147 did for packing:

- **Where.** Route + upload run **after `buildDynamoItems`**, on the built items: that is where
  each edge item's `pk`, `sk`, `__edd_e__`, collection-SK mirror and list-GSI keys are composed
  (`Aggregate.ts:3431-3460`), and the object key (§4.5) and the whole-item budget need them.
  `packAggregateGroups` stays the synchronous inline packer it is today.
- **Diff first, then upload.** `update` already compares decomposed groups before writing
  (`Aggregate.ts:1717`); uploads now happen only for the items of changed groups. Unchanged
  groups upload nothing.
- **No reuse of read pointers**. Group `Put`s carry no condition
  (only `create`'s root guard, `Aggregate.ts:3593-3607`; `update` passes no `rootGuard`,
  `:1736-1742`), so a pointer read from the partition cannot be safely written back (§6.4).
  Within a changed group every offloaded edge value is uploaded afresh. The side map of read
  pointers the previous draft proposed is dropped.
- **Groups are separate transactions**, so settlement is per group: a failed group's uploads
  roll back and committed groups keep theirs. `AggregateTransactionOverflow.committed` already
  reports partial writes.
- **Edge rows never copy pointers.** Aggregate writes create no snapshots, tombstones or events,
  whatever the edge entity's `versioned` / `softDelete` / `timeSeries` config (`Aggregate.ts`
  has no lifecycle handling), so GC treats aggregate edge rows as plain (§11.3).
- **Inputs.** A binary edge field accepts `Uint8Array` only (no `Stream`, handle or source). The
  aggregate's input type is the user's aggregate schema, and threading `BinaryInput` through
  nested sub-aggregate schemas is out of this design (§23).

### 6.10 EventStore

| Path | Change |
|---|---|
| `append` — event items | `buildEventItem` packs `data`, then routes (threshold, `offload.itemBudget` per event item) and uploads, keyed by the event's SK. The append's ledger is the root (or `commandHandler`'s) |
| `append` — inline snapshot | `buildSnapshotItem` likewise, keyed by the snapshot SK |
| `append` attempt loop | `additionalItems` are rebuilt per attempt (`EventStore.ts:4109`), so their uploads hit the memo; bound ops among them build under their captured store (§3.6) |
| `commandHandler` | the root: a `VersionConflict` retry re-decides; identical content is memoised, and a lost attempt's other uploads are `rejected` (cancelled transaction) → deleted at exit |
| `writeSnapshot` | the monotonic `PutItem` losing its race is swallowed as `void` today (`:4479-4513`); the CCF's `ALL_OLD` item does not hold the pointer, so the upload is `rejected` and deleted |
| `measureAppend` / `measureSnapshot` | **never upload**. They route as `append` would and count each offloaded value as a pointer at its upper bound; `AppendMeasurement` gains `offloaded: ReadonlyArray<{ item: number \| "snapshot"; attribute: "data" \| "state"; objectBytes: number }>`. Exact except for the pointer's `VersionId` bytes, which the docs state |

### 6.11 Projections

`ProjectionEngine` reads the read-model row (`readRow`, a consistent `GetItem`, eager), folds,
and rewrites it as a whole-item put. Uploading every offloaded field on every fold would cost a
`PUT` per event per field, so projection row rewrites are the one place a read pointer is
reused, under two conditions that make it safe:

- **Content, not checksum.** The engine keeps the value it fetched for each offloaded field
  of the row it read. A field whose folded value deep-equals that fetched value (structural
  equality of the domain value) keeps the read pointer; any other value uploads.
  *(Implemented, commit 9, over the encoded content snapshotted at the read — the canonical
  JSON of an overflow value, the bytes of a binary one — see §21 item 9.)*
- **Pinned.** The row write's condition gains `#f = :P` for every reused pointer `P`, beside
  the existing revision / checkpoint guard (`ProjectionEngine.ts:514-554`). A concurrent write
  of the row — by the projection or by anything else — fails it as `LostRace`, which the
  engine already retries (re-read, re-fold); the attempt's uploads are `rejected` and deleted.

### 6.12 Lifecycle copies

| Feature | Behaviour |
|---|---|
| `versioned: { retain: true }` | snapshots copy pointers (no upload); a snapshot holds the version it captured |
| `softDelete` | the tombstone copies pointers; `restore` writes them back; nothing uploads |
| `purge` | after its DynamoDB deletes all succeed, re-reads the family and deletes the unreferenced own versions the purged rows named or that are provably not in flight; younger unnamed ones are left for the sweep (§11.6) |
| `timeSeries` | one object per append, shared by current and event item (§6.8) |
| `put` over an existing item | re-routes every offloaded field under the current config and uploads all of them. The docs point "change one field" at `update().set()` |

### 6.13 Write results

`put` returns the item it wrote, `update` defaults to `allNew`, `append` reads the current item
back, and cascades / `ConcurrentModification.current` decode rows. Rules:

- What this operation **uploaded** resolves from the ledger's read cache (no GET).
- Untouched offloaded fields resolve **per the builder's mode** (overflow eager by default, so
  `update(...).set({ title })` fetches an untouched `body` for its `allNew` result). The docs
  point at `.returnValues("none")` or `.offloaded("lazy")` when that is not wanted.
- **Error payloads** (`ConcurrentModification.current: Option<unknown>`) decode offloaded
  fields as lazy handles regardless of mode, so failing never does I/O.
- A store failure while building the result of a **committed** write fails with
  `BlobStoreError { committed: true }` ("the write was applied; do not retry a non-idempotent
  write"), the `UpdateAppliedButUnreadable` precedent.

---

## 7. Streaming and multipart uploads (binary fields)

**Input handling.** A `Uint8Array` (or a `source` with one) is buffered content: its length
and checksum are known before upload. A `Stream` is **single-use** (§3.8): run once, for one
target object.

```
body ≤ partSize (buffered, or a stream that ends within one part) → single PutObject
otherwise                                                        → multipart upload
```

The library re-chunks the stream into exactly `partSize` parts (the last may be shorter) and
taps it with the incremental CRC64NVME, so the content checksum is computed in the same pass.
The store receives `request.checksum` as an `Effect` that resolves when the body ends (§12.1);
the S3 store awaits it for `CompleteMultipartUpload`.

**Multipart against `@aws-sdk/client-s3` directly** (decision 12):

1. `CreateMultipartUpload` — `ChecksumAlgorithm: "CRC64NVME"`, `ChecksumType: "FULL_OBJECT"`,
   content type, metadata, SSE passthrough. The ledger's `startedAt` for the entry is taken
   before this call, so it is never later than the date S3 gives the object (the upload's
   initiation).
2. `UploadPart` × n, at `uploadConcurrency` (default 4) — each with its own `ChecksumCRC64NVME`,
   computed by the library, so the SDK computes nothing. Memory held is ≤ `partSize ×
   (uploadConcurrency + 1)`. The SDK's retry strategy resends a failed part from its buffered
   chunk.
3. `CompleteMultipartUpload` — parts (ETag + part checksum), `ChecksumCRC64NVME` of the whole
   content, `ChecksumType: "FULL_OBJECT"`, `MpuObjectSize`. S3 validates the full-object
   checksum against the parts (F6). The response's `VersionId` is checked as for `PutObject`.

**Part size.** Default 8 MiB (bounds: 5 MiB … 5 GiB, `[EDD-9116]`). With a known
`contentLength` (a `source` option, or a `Uint8Array`) the part size is raised to
`ceil(length / 10,000)` when needed. For an unknown-length stream the part size is fixed:
8 MiB parts cap a stream at ~78 GiB. Part 10,001 is S3's to reject, diagnosed as
`BlobStoreError { reason: "TooLarge" }` naming the part size (diagnose on failure, not a
pre-check).

**Upload duration.** An operation whose uploads take longer than `maxUploadAge` (default
1 hour) fails with `Expired` before reaching DynamoDB (§6.1). A deployment that writes very
large binary values over slow links raises `maxUploadAge` on the store — and with it the
minimum sweep grace (§11.4).

**Failure and interruption.**

- Any failure or interruption between Create and Complete runs `AbortMultipartUpload`, in an
  uninterruptible finalizer, after in-flight part uploads are interrupted.
- An abort that fails is logged. A lifecycle `AbortIncompleteMultipartUpload` rule is the
  backstop for processes that crashed (§11.7).
- A source-stream failure fails the operation (`SourceFailed`). An upload that fails outright
  — `PutObject`, an `UploadPart` after the SDK's retries, or `CompleteMultipartUpload` —
  aborts any multipart upload, fails the operation with `BlobStoreError`, and sends nothing to
  DynamoDB.
- **Consumed streams are never replayed.** Re-planning and retries of the same upload reuse
  it through the memo (stream identity + target key); a stream whose upload failed or was
  rolled back and is needed again, or a stream given for a second target, fails with
  `[EDD-9120]`.
- A `CompleteMultipartUpload` whose success response was lost can turn into `NoSuchUpload` on
  the SDK's retry, leaving a version the library never learned of. That version has no
  pointer. The library reports it to the observer (`reason: "completeLost"`, with the object
  key and row key, §6.2) and the per-item sweep, or the store-wide sweep, reclaims it.

**Single PUT** of buffered content sends `ChecksumAlgorithm: "CRC64NVME"` and the precomputed
`ChecksumCRC64NVME`; S3 validates it (`BadDigest` / MinIO `XAmzContentChecksumMismatch` →
`BlobStoreError { reason: "ChecksumMismatch" }`).

**Overflow values** are always buffered (they are in-memory JSON) and use a single PUT. A
value over `partSize` uses the multipart path above.

---

## 8. Read path

### 8.1 Two-phase decode

The codec stays synchronous (#147 §11). Every decoder becomes:

1. **Unpack (sync, unchanged cost)** — `unpackRow` / `unpackItemSync` / `decodeImageSync` return
   the row with each pointer replaced by a `PendingBlob { pointer, attribute, field, kind }`
   placeholder (rows without pointers are untouched; no extra work).
2. **Resolve (effectful, batched)** — `internal/BlobResolver.ts` takes every placeholder of the
   batch (a page, a batch-get response, a partition, one item):
   - **eager** → fetch at the store's `readConcurrency` (default 16), verify (§8.6),
     decompress, `JSON.parse` (overflow) or concatenate bytes (binary);
   - **lazy** → construct an `OffloadedValue` / `BlobHandle` (no I/O).

   Before fetching it consults the ledger's read cache.
3. **Schema decode** — the record schema substitutes a handle schema (a `Schema.declare` guarded
   by `isBlobHandle` / `isOffloadedValue`) for each field in lazy mode. Read schemas are plain
   `Schema.Struct`s built from fields (`EntitySchemas.ts:2019-2044`), so the substitution needs
   no class reconstruction.

A row whose offloaded fields are all inline resolves with no I/O in either mode.

### 8.2 Eager resolution in queries

`Query.examinePage` (`Query.ts:1271-1330`) decodes row by row inside a budget window. A
**prefetch step** is added next to `hydrateRows` (the existing page-level step for keys-only
indexes):

- **Window.** For each window, it unpacks the rows, resolves their placeholders together, then
  decodes and accepts. Without a client predicate the window is only the rows the `limit`
  budget can still take, so rows past `limit` are never fetched.
- **With `filterBy`.** Acceptance is only known after decode, so the whole response is decoded,
  and in eager mode resolved too. The docs say `.offloaded("lazy")` keeps a `filterBy` scan
  from downloading every row.
- **`count()`** decodes nothing unless `filterBy` is present.
- **`paginate()`** prefetches per page.

The same batched step serves scans, collections (per member), `Batch.get`,
`Transaction.transactGet`, `history()`, `versions()`, `deleted.list()`, vector search hits,
EventStore event queries (`read`, `readFrom`, `readLatest`'s delta, `readIndex`,
`query.events` / `query.index`), aggregate assembly (one partition) and `GeoSearch.nearby`
(per cell query).

### 8.3 Lazy handles

A lazy value holds the pointer and the fiber's store and compressor registry (§3.7). `read()`
fetches, verifies and decodes on each call (no memoisation: a handle is a value, and caching
would pin bytes in memory). A handle for an inline value serves its bytes or JSON without
I/O.

### 8.4 Per operation

| Read | Default modes | Notes |
|---|---|---|
| `get`, queries, scans, collections, vector search hits, `Batch.get`, `transactGet`, `history()`, `versions()` / `getVersion()`, `deleted.get` / `deleted.list`, `ReturnValues` | overflow eager, binary lazy | `.offloaded()` per builder |
| `asNative` | — | returns the stored pointer (`B`, or a binary field's `S`) unchanged |
| `asRecord` / `asItem` | the op's modes | resolve like `asModel`, then add system fields (and keys) |
| raw projections (`select`, `selectPaths`, `Entity.project`, vector `select`) | overflow eager (parsed JSON wire form, as #147's raw rows), binary lazy | via the raw-row hook, which declares the offloaded attributes in `QueryRawRow.attributes`, so a projection that names none of them installs no hook and fetches nothing |
| aggregate `get` / list / assembly | **both eager** | the assembled value is the user's aggregate schema and `update` re-validates the whole state through it (`Aggregate.ts` ~`:1606`). A handle there would fail a `Uint8Array` schema, and typing handles through nested sub-aggregates is out of this design (§23) |
| EventStore reads (`read`, `readFrom`, `readLatest`, `readSnapshot`, `readIndex`, `fold`, `query.*`) | eager (event `data` and snapshot `state` are overflow values, eager by default per decision 5) | `ReadOptions.offloaded: "lazy"` / `Query.offloaded("lazy")` → `LazyStreamEvent` (§10.2) |
| `GeoSearch.nearby` (geo package) | **both eager** | it decodes through the entity's own two-phase row decoder (unpack + resolve) instead of running `recordSchema` over the raw row (`GeoSearch.ts:107-116`), which also fixes #147's gap: geo reads do not unpack packed fields today. `GeoIndex<A, P>` uses one `A` for its input and its results, so a lazy handle cannot be typed there without splitting it; `GeoIndex.put` takes `Uint8Array` for binary fields, as aggregates do |
| ref hydration (`hydrateRefs`) | lazy internally | the ref copy takes only the ref schema's fields (§15), so offloaded fields of the target are never fetched |
| projection engine `readRow` | eager internally | it folds over the row |

### 8.5 Filters and conditions

Server-side expressions on offloaded fields are limited to `attribute_exists` /
`attribute_not_exists` on the whole field (§15). `filterBy` predicates see the value in the
query's effective mode.

`.offloaded()` re-types the item. Called after `.filterBy()`, whose predicate was typed on the
previous item type, it throws `[EDD-9117]`; the order rule is documented as
"`.offloaded()` first".

### 8.6 Integrity verification

A **full** read verifies before returning:

- the object's size equals the pointer's object size;
- CRC64NVME over the content equals the pointer's checksum — over the bytes (binary), or over
  the decompressed JSON (overflow), which also catches a corrupt or wrong-codec payload.

Mismatch → `BlobStoreError { reason: "ChecksumMismatch" }`. A buffered full read (eager, or a
lazy `read()`) fails as soon as the bytes run past the pointer's object size, so an oversized
or corrupt object is never buffered whole (*as built in commit 6*). A **ranged** read
(`read({ range })`, `stream({ range })`) cannot verify a full-object checksum and does not;
the docs say so.
`stream()` without a range verifies as the last chunk arrives, failing the stream after the
bytes were emitted, which is documented on `stream()`.

### 8.7 Missing objects

`NoSuchVersion` / `NoSuchKey` → `BlobStoreError { reason: "NotFound" }` (and `AccessDenied`
without `s3:ListBucket`, F12). Causes include GC run against a version a reader still holds
(a long-lived handle past the grace period, a restored backup, §11.8), replica lag (§16), or a
version deleted out of band. The store option `notFoundRetry?: Schedule` (default none) retries
a `NotFound` for replica regions; the library does not re-read the item (it cannot know a
newer pointer is what the caller wants).

**From a stream image.** A handle decoded from a stream image (its error's `operation` is
`decodeStreamRecord.read` / `decodeMarshalledItem.read`) that reads `NotFound` usually names a
version that was superseded and then reaped after the reaper's grace: the consumer is lagging
by more than the grace. The newer record carries the newer pointer, so the guide tells a
change-feed consumer to treat that `NotFound` as "superseded" and skip the field rather than
fail the batch, which would wedge the shard until the records are trimmed. It recommends a
reaper grace at least as long as the slowest consumer's tolerated lag (§11.3).

---

## 9. Type level

### 9.1 The offload type parameter

```ts
export interface OffloadFields { readonly overflow: string; readonly binary: string }
export type NoOffload = { readonly overflow: never; readonly binary: never }

export type ExtractOffloadFields<Model> = Model extends ConfiguredModel<any, infer A>
  ? {
      // Overflow when `storedAs` MAY be an overflow config (a union-typed one included).
      readonly overflow: { [K in keyof A & string]: A[K] extends { readonly storedAs: infer S }
        ? [Extract<S, ExternalPackedConfig>] extends [never] ? never : K
        : never }[keyof A & string]
      readonly binary:   { [K in keyof A & string]: A[K] extends { readonly storedAs: ExternalConfig } ? K : never }[keyof A & string]
    }
  : NoOffload
```

`Packed` is overloaded (§3.1) precisely so `ExternalPackedConfig` is visible here: today
`PackedConfig` is not generic and an `external` option would be invisible to the types. The
two configs are disjoint (§3.1), so a `PackedConfig`-typed value is provably inline; a value
typed `PackedConfig | ExternalPackedConfig` (legal: it may offload) counts as overflow, so the
blob-store errors are never under-reported. `ExtractPackedFields` keys on the union, so an
overflow field stays a packed field.

- `Entity` (14th) and the schema package's `EntityDefinition` gain a trailing
  `TOffload extends OffloadFields = NoOffload`; `BoundEntity` its 11th.
- `TypedClient`'s two positional `infer` patterns (`DynamoClient.ts:776-826`) gain the parameter
  and pass it to `BoundEntity`, `scan`, `EntityIndexAccessors` and `BoundQuery`. (The doc
  comment there still says "the same 11 type parameters" — adjacent debt fixed in the same
  change.)
- `TPackedFields` (the `PathBuilder` marker) is fed `ExtractPackedFields<M> | binary fields`,
  so an External field's paths are `PackedPath`s too: only `exists` / `notExists` and
  projections accept them (§15).
- The marker checks keep #147's guards against `any` / `never` (`[T] extends [never]`,
  `0 extends 1 & T`), and `test/ErrorChannels.types.test.ts` pins every non-offloading
  entity's types.

### 9.2 Result views and the builders' offload state

```ts
type DefaultModes = { readonly overflow: "eager"; readonly binary: "lazy" }
type Resolve<M extends OffloadModes> = { overflow: [M["overflow"]] extends [OffloadMode] ? M["overflow"] : Extract<M["overflow"], OffloadMode> | "eager"; … }

export type View<A, T extends OffloadFields, M> =
  [T["overflow"] | T["binary"]] extends [never] ? A : {
    readonly [K in keyof A]:
      K extends T["overflow"] ? (M["overflow"] extends "lazy" ? Lazy<A[K], OffloadedValue<NonNullable<A[K]>>> : A[K]) :
      K extends T["binary"]   ? (M["binary"]   extends "lazy" ? Lazy<A[K], BlobHandle>                         : A[K]) :
      A[K]
  }
/** Keeps `null` / `undefined` members: an absent optional field stays absent. */
type Lazy<V, H> = V extends null | undefined ? V : H

/** What a builder needs to re-type its result under another mode. */
export interface OffloadState {
  readonly fields: OffloadFields   // the entity's TOffload
  readonly modes: ResolvedModes    // the builder's effective modes
  readonly item: unknown           // the pre-view item: model, record, a selected partial, an UpdateReturn
}
export type NoOffloadState = { readonly fields: NoOffload; readonly modes: DefaultModes; readonly item: never }
```

- *Implementation notes (commit 5, `Offload.ts`):* a mode that is not a single literal (the
  widened `OffloadMode`, from generic or untyped code) types the field as either form
  (`A[K] | Lazy<…>`), matching `ReadBlobErrors`' "counts as eager" (§9.3), so neither the value
  type nor the error union under-reports. `Offload.ResolveModes<M, Base = DefaultOffloadModes>`
  resolves `.offloaded(m)`'s argument over `Base` — a string sets both kinds, an object
  overrides the kinds it names — so commit 8 can resolve over a builder's current modes or the
  defaults. A kind the argument may or may not set (an optional property, or `OffloadModes`
  itself, from generic code) resolves to the union of its mode and `Base`'s
  (`[V] extends [OffloadMode] ? V : Extract<V, OffloadMode> | Base`), not to `Base` alone, so
  the widening reaches `View` and `ReadBlobErrors` instead of being narrowed away first: a
  binary-only member read with `OffloadModes` keeps `BlobStoreError`. `{}` and an explicit
  `undefined` still give `Base`. `Offload.ViewOf<O>` is `View<O["item"], O["fields"], O["modes"]>`.
- Reads of an entity without offloaded fields return exactly today's types (the first branch).
- `BoundEntity`'s read results are `View<Model, TOffload, DefaultModes>`. For an entity with a
  binary field this **is** a change of the read type (`scan: BlobHandle`, not `Uint8Array`) —
  decision 5, opt-in by declaring `External`.
- **Builders carry the state, not just `A`.** Today `BoundQuery<Model, SkRemaining, A>` holds only
  the result type, `BoundGet<A, E>` two parameters, and `BoundUpdate.returnValues` derives its
  result from `Model` through `UpdateReturn<Model, M>` (`BoundQuery.ts:191-283`,
  `BoundCrud.ts:254-256`, `:376-378`, `:624`). None of them could re-type an eager overflow
  field into `OffloadedValue` because nothing in their type says which fields are offloaded.
  So each builder gains one trailing parameter `O extends OffloadState = NoOffloadState`:
  `BoundQuery<Model, SkRemaining, A, O>`, `BoundGet<A, E, O>`, `BoundPut<…, O>`,
  `BoundUpdate<…, O>`, `BoundDelete<…, O>`, the time-series append builder, the collection
  query builder (a per-member map of states), and the unbound `Query<A, E, O>`.
  - `.offloaded(m)` (and `Entity.offloaded` / `Query.offloaded`) sets `O["modes"]` and
    recomputes `A = View<O["item"], O["fields"], O["modes"]>` and the blob errors (§9.3).
  - `select` / `selectPaths` and `returnValues<M>` set `O["item"]` (the selected partial,
    `UpdateReturn<Model, M>`) and recompute `A` under the current modes, so the order of
    `returnValues`, `select`, `limit`, `filter` and `offloaded` does not matter — except
    `filterBy` before `offloaded`, which `[EDD-9117]` refuses (§8.5).
  - Every other combinator passes `O` through unchanged.
  - For an entity without offloaded fields, `O` stays `NoOffloadState`: `A` and every error
    union are exactly today's, and existing annotations (which omit the trailing parameter)
    still name the same types.
- `Entity.Record<E>` / `Entity.Model<E>` keep the **domain** type (what the schema describes);
  `Entity.Read<E, M = DefaultModes>` names the view.

### 9.3 Error tracking

```ts
/** Errors a read in modes `M` can raise from the store. */
export type ReadBlobErrors<T extends OffloadFields, M extends ResolvedOffloadModes> =
  | ([T["overflow"]] extends [never] ? never : "eager" extends M["overflow"] ? BlobStoreError : never)
  | ([T["binary"]]   extends [never] ? never : "eager" extends M["binary"]   ? BlobStoreError : never)
/** Errors a write can raise from the store. */
export type WriteBlobErrors<T extends OffloadFields> =
  [T["overflow"] | T["binary"]] extends [never] ? never : BlobStoreError
/** The blob errors of an operation's own error type, `never` for `any`. */
type OpBlobErrors<E> = 0 extends 1 & E ? never : Extract<E, BlobStoreError>
```

Mirrors `RefErrors` / `VectorErrors` (`schema/src/internal/EntityTypes.ts:362-374`), in the same
module. `M` is bounded by `ResolvedOffloadModes` (`{ overflow: OffloadMode; binary: OffloadMode }`,
`OffloadMode = "eager" | "lazy"`, default `DefaultOffloadModes`), and the mode test reads
`"eager" extends M[k]` rather than `M[k] extends "eager"`: a mode that is not one literal (the
widened `OffloadMode`, from untyped or generic code) counts as eager, so the error union never
under-reports. For a literal mode the two agree. `ReadBlobErrors<any, M>` and
`WriteBlobErrors<any>` are `never`, like `OpBlobErrors<any>`. (Implementation note, commit 4.)

The rules:

- **Write ops** (put / create / upsert / update / patch / delete / restore / purge / append) add
  `WriteBlobErrors<TOffload>`. A delete without return values reaches no store but `purge` does,
  and per-method precision is not worth the surface, so all writes carry it.
- **Read terminals** add `ReadBlobErrors<O["fields"], O["modes"]>`. An entity with only binary
  fields keeps today's read error types under the default modes (binary is lazy).
- **`BoundQuery`** terminals widen from the hard-coded `DynamoClientError | ValidationError`
  (`BoundQuery.ts:266-282`) to that plus `ReadBlobErrors` of its `O`.
- **`Query<A, E = never, O = NoOffloadState>`**: `Query.collect` / `paginate` / `fetch` / `count`
  propagate `E`. Existing `Query<A>` annotations mean `E = never`.
- **`BoundGet`** carries its `E` plus `ReadBlobErrors` of its `O`; `Batch.get` /
  `Transaction.transactGet` widen to the union of their gets' errors (today a fixed union over
  the tuple).
- **Multi-op write entry points.** `Batch.write`, `Transaction.transactWrite` and
  `EventStream.append` / `commandHandler` with `additionalItems` or nested `appendOp`s upload
  for the ops they are given (§6.6, §6.7, §6.10), but take type-erased arrays today
  (`ReadonlyArray<BatchWriteOp>`, `Batch.ts:296-300`; the fixed union of `Transaction.ts:319-331`).
  They become `const`-generic over their ops, as `Batch.get` already is, and add the union of
  `OpBlobErrors` of the ops' error types. `EventStream.append` adds them to its own
  `WriteBlobErrors`, so a non-offloading stream appending an offloading entity's put still
  carries `BlobStoreError`. An op typed `any` (an untyped array built elsewhere) contributes
  nothing — the documented price of erasing the type; passing the ops inline or as a `const`
  tuple keeps them typed. Callers of non-offloading entities see exactly today's unions.
- **Geo.** `GeoIndex.put` (today the entity put's union hard-coded, `GeoIndex.ts:205-214`) adds
  the entity's `WriteBlobErrors`; `nearby` adds `BlobStoreError` when the entity offloads any
  field (geo reads are eager for both kinds, §8.4).
- **Collections** union their members' `ReadBlobErrors` under the collection query's modes.
- **Aggregates**: `Aggregate.make` computes `TBlobErrors` from its edge entities' `TOffload`
  (`AggregateType` gains a trailing parameter), applied to every aggregate operation (reads are
  eager, §8.4).
- **`EventStream`** gains a trailing `TOffloaded extends "data" | "state" = never`, inferred by
  a `const` generic on `makeStream`'s `storedAs` / `snapshot.storedAs`. Appends, snapshot
  writes and eager reads carry `BlobStoreError` when it is not `never`; lazy reads do not.
- **Lazy handles** carry the error on their own `read()` / `stream()` / `presignedUrl()`.
- **Stream decoders**: `Entity.decodeMarshalledItem` keeps `Effect<unknown, ValidationError>` for
  an entity without offloaded fields; for one with them a new overload returns
  `Effect<Entity.Read<E, M>, ValidationError | ReadBlobErrors<…>>`, lazy by default, so the
  result's shape is in its type (§10.1).

### 9.4 Inputs

`Entity.Input<E>` / `Create<E>` / `Update<E>` replace each binary field's type with
`BinaryInput` (§3.8), preserving optionality. Overflow fields' input types are unchanged.

---

## 10. Streams and change detection

### 10.1 `Entity.decodeMarshalledItem` — lazy by default

As decision 5 fixed. It normalises the image (#147 §3.5) and unpacks; pointers become lazy
values, so a stream consumer pays for a GET only when it reads the field. `{ offloaded:
"eager" }` resolves them.

- **Typed for offloading entities.** Today it returns `Effect<unknown, ValidationError>`
  (`Entity.ts:11352-11358`), so decision 5's "mode reflected in the result type" cannot hold
  through it. For an entity with offloaded fields a new overload returns `Entity.Read<E, M>`
  (§9.3); entities without them keep today's signature.
- **The shape changes when `external` is added.** Under the lazy default every overflow field —
  inline values included (`OffloadedValue.location: "inline"`) — decodes as `OffloadedValue<A>`
  rather than `A`. A consumer that casts the old `unknown` result to its model would break at
  run time when a field gains `external`. The overload makes the change visible to typed
  callers, and the rollout section of the guide lists it (§22).
- **Pure definitions** (the schema package's `Entity.make`, no runtime `_decodeImage`) are
  decoded today by `itemSchema` alone, without unpacking (`Entity.ts:11359-11377`) — a
  pre-existing gap for #147's packed fields. The fallback gains the same normalise + unpack +
  pointer dispatch as `_decodeImage`; it can resolve pointers through an ambient store, and its
  lazy handles' `read` fails with `NotProvided` when none is ambient.
- **`NotFound` on a lagging consumer**: see §8.7.

### 10.2 `EventStream.decodeStreamImage` and projections — lazy by default (decision 5)

**Baseline (adopted, decision 5; confirmed 2026-11-01).** Stream-image and change-feed decoding of EventStore events
is lazy by default, across the whole EventStore change-feed surface: `stream.decodeStreamImage`,
`EventProjection.processBatch`, `MultiProjection`, and `EventStore.processBatch` /
`runChangeFeed` (which run `processBatch`, including the "unrouted" streams decode,
`change-feed/ChangeFeed.ts:833-860`).

- For a stream whose `data` is not `external` (`TOffloaded` excludes `"data"`), nothing changes:
  the result is today's `StreamEvent`.
- For a stream whose `data` is `external`, the result is `LazyStreamEvent<TEvent>`: the
  envelope (`eventType`, version, metadata, timestamps) decoded, and `data:
  OffloadedValue<TEvent>`. Inline data resolves through `read()` with no I/O.
- Projection handlers over such a stream receive `LazyStreamEvent`s and dispatch on
  `eventType`; a handler that needs the payload yields `event.data.read()`, which adds
  `BlobStoreError` to the handler's error channel. `EventProjection.make` / `MultiProjection`
  take `{ offloaded: "eager" }` to receive resolved `StreamEvent`s instead.
- `decodeStreamImage(image, { offloaded: "eager" })` resolves `data`.

**Alternative considered and rejected (2026-11-01).** Make the EventStore side **eager** by default
— `decodeStreamImage`, `processBatch` / `runChangeFeed` and both projection runtimes — with
`{ offloaded: "lazy" }` returning `LazyStreamEvent`, while `Entity.decodeMarshalledItem` and
`decodeStreamRecord` stay lazy. The case for it:

- The event's `_tag` lives **inside** `data` (only `eventType` is in the envelope), so an
  offloaded `data` cannot be schema-decoded into `TEvent` without fetching it.
- `decodeStreamImage` exists to return the read paths' exact `StreamEvent` (#147 R2), which
  projections fold; nearly every projection reads the payload of every event it handles.
- Under the baseline, adding `external` to a stream's `data` changes the event type every
  projection handler of that stream receives.

The cost of the alternative: a projection that only counts or routes events pays a GET per
offloaded event. The user confirmed the lazy baseline (decision 5 as written); the
implementation plan (§21) builds it, and `{ offloaded: "eager" }` remains the per-call opt-in.

### 10.3 `Entity.decodeStreamRecord` and change classification

Decodes both images (per mode) and classifies every offloaded field present in either:

| Old | New | Result |
|---|---|---|
| absent | present | `added` |
| present | absent | `removed` |
| pointer | pointer, same ref (key + version) | `unchanged` |
| pointer | pointer, different ref, same checksum algorithm, checksum and content size | `rewritten` |
| any stored form | any stored form, different checksum or content size | `changed` |
| inline (`S` / `B`) | pointer, or the reverse | checksum and size of the inline content computed locally (§5): equal → `rewritten`, else `changed` |
| inline | inline | equal content checksums and sizes → `unchanged`, else `changed` |
| native `M` | anything else | `changed` (no canonical bytes) |

None of it touches the store. The low-level form is exported for raw consumers:
`Offload.compareStored(oldAttributeValue, newAttributeValue, kind)`.

`rewritten` means **probably identical**, not proven (§5): a CRC can be matched by crafted
content. A JSON value restated with the same entries in another key order is `changed`. The
docs tell a consumer that must not miss a change (an indexer, a content scanner) to treat
`rewritten` as `changed`, or to compare the content.

### 10.4 Stream view type

Change detection and the reaper need `NEW_AND_OLD_IMAGES`. Checked from the records themselves,
never with `DescribeTable`:

- `dynamodb.StreamViewType` present and not `NEW_AND_OLD_IMAGES` → `[EDD-9119]`.
- Absent (an EventBridge Pipe input template may strip it): a `MODIFY` / `REMOVE` without
  `OldImage`, or a `MODIFY` / `INSERT` without `NewImage`, → `[EDD-9119]`.
- `BlobGc.reap` checks **every** record of the call before acting on any (a cheap presence
  test), and dies on the first violation (a deployment defect: a batch whose first record is an
  `INSERT` would otherwise pass a `NEW_IMAGE` stream, and every later `MODIFY` / `REMOVE` would
  silently free nothing). `decodeStreamRecord` checks each record it is given and fails with a
  `ValidationError` carrying the code.

### 10.5 Projections and poison records

`EventProjection.processBatch` treats any decode failure as a poison record that
`onDecodeFailure: "skip"` can drop (`EventProjection.ts:1560-1566`). A `BlobStoreError` is
transient, not poison: it fails the batch (redelivered) and is never skipped. That is safe for
projections because the objects they read never go away while the event exists: event objects
are immutable and never reaped (§11.3), only purged with the stream. A store `NotFound` that
persists past the store's `notFoundRetry` therefore means data loss or an out-of-band delete,
and failing loudly is right. A pointer that fails to parse is still a `ValidationError` and
poison.

---

## 11. Garbage collection

Without GC, superseded versions accumulate and are billed. GC is opt-in (decision 4).

### 11.1 What must never run on the offload prefix

The **current** S3 version of a key is not necessarily the **referenced** one: concurrent
writers, a crashed rollback, a retain snapshot, a tombstone or a time-series event can each pin
a noncurrent version. `NoncurrentVersionExpiration` counts days from the successor's creation
(F3), so it deletes live data. Neither it nor `Expiration` (which adds delete markers) may
apply to the offload prefix; safe rules are in §11.7.

### 11.2 Who can reference a version, and which versions are a table's own

| Member | Rows that may hold a version |
|---|---|
| plain entity | the live row only |
| `versioned: { retain: true }` | the live row and any number of `#v#N` snapshots (untouched fields share one version across many snapshots) |
| `softDelete` | the live row, tombstones (`#deleted#…`), and a restored live row |
| `timeSeries` | the current item and event items (`#e#…`) |
| aggregate edge | the edge item only — aggregate writes never create snapshots, tombstones or events, whatever the edge entity's `versioned` / `softDelete` / `timeSeries` config (§6.9) |
| EventStore | each event row (its own object, immutable); the snapshot row |

Refs never copy offloaded values (`[EDD-9143]`, §15), so no library write makes a reference
cross an item family.

**An aggregate member reads only its own partitions.** An edge item carries its edge entity type
in `__edd_e__`, which may be the entity's own type when the edge declares it so — and the same
entity may be used standalone on the same table, its rows holding retain snapshots, tombstones
and events. The aggregate rules above (free directly; a sweep reads the edge row alone) hold only
for rows in the aggregate's partitions, so the reaper reads a record as an aggregate member's only
when its partition key is the aggregate's (its collection head, continued after `#` when it has
composites: `AggregateGcSupport.ownsPartition`), and `sweepStore` attributes a family to an
aggregate on the same test. A standalone row of the edge type is the entity member's, when the
collector has one, and otherwise no member's (skipped by the reaper, `Foreign` to `sweepStore`),
never freed as an edge row. Pinned by `BlobGc.test.ts` ("an aggregates-only collector never reads
a standalone row of its edge type", "a standalone row of an aggregate's edge type is not the
aggregate's family"). Named limit: an entity whose type label equals the aggregate's collection
name would share its partition head; collection names and entity types are expected to differ.

**GC is table-local.** Pointers carry the full key and no bucket, so a copy of a table — a
point-in-time or backup restore (always to a new table name), an import from S3, a migration
or archive script copying `asNative` rows — references the same versions as its source. GC on
either table must not delete the other's live data. So every GC path (reaper, sweeps, purge)
acts only on **own** versions: a version is own to a member when its key's `P` and `F`
(§4.5) are the ones the member computes from **its own physical table name** and the row's
partition and family. Any other pointer a GC'd row holds is **foreign**: never a candidate,
never listed, never deleted (reported as `foreign`). A changed `offload.prefix` or store
prefix keeps the same `P/F`, so its older objects stay own and are still swept.

**The item family's rows.** An item family is not one sort-key range. For an entity with sort-key
composites it spans disjoint ranges of the partition, with sibling items' rows in between
(`DynamoSchema.ts:298-320`); purge already reads them by querying the whole partition and
classifying rows with `belongsToItem` (`Entity.ts:10010-10066`). GC reads them as explicit
strongly consistent `Query` ranges, each projecting keys and offloaded attributes, and filters
with the same classification:

| # | Range (key condition) | Rows |
|---|---|---|
| R1 | `begins_with(sk, liveSk)`, kept when `sk = liveSk` or `sk` starts with `liveSk#` | the live row; time-series events nested under it |
| R2 | `begins_with(sk, "…#<type>#v#<item>#")` | the item's retain snapshots |
| R3 | `begins_with(sk, "…#<type>#deleted#<item>#")` | the item's tombstones |
| R4 | `sk BETWEEN "…#<type>#v#0" AND "…#<type>#v#9￿"`, kept when the row's composites compose `liveSk` | legacy snapshots written without an item segment (their keys end in the zero-padded version, so this range holds no segmented row unless a composite *name* starts with a digit, which the filter drops) |
| R5 | the same over `…#<type>#deleted#` | legacy tombstones without an item segment (their keys end in the ISO timestamp) |

An entity without sort-key composites has one item per partition: GC reads the partition
filtered by `__edd_e__`, as purge does. Ranges with no rows cost one read unit each.

### 11.3 Reaper (primary)

`gc.reap(records)`:

1. **Check** every record's view type and images (§10.4).
2. **Candidates.** For every record of a configured member, every **own** pointer in `OldImage`
   whose ref does not appear in `NewImage` for the same attribute (all of them on `REMOVE`,
   including TTL deletes) is a candidate. `INSERT` produces none. Records of other types, rows
   that are not a member's (sentinels), and foreign pointers are ignored.
3. **Grace.** Wait until `ApproximateCreationDateTime + gracePeriod ≤ now` for the newest
   candidate record of the call (`Effect.sleep`; default grace **15 minutes**, ≥ 0,
   `[EDD-9118]`). The grace covers GSI and eventually consistent reads, replica-region reads
   (§16), lazy handles captured from the superseded row, and presigned URLs: the default equals
   `presignedUrl`'s default `expiresIn` (§3.7). The docs recommend a grace at least as long as
   the longest presign expiry an application issues and the slowest stream consumer's
   tolerated lag (§8.7).
4. **Free**, by member:

   | Member | Rule |
   |---|---|
   | plain entity, aggregate edge (always — §11.2), EventStore snapshot | free the candidate directly. Sound because a superseded pointer is never written back (§6.4): every pointer a library write did not upload is pinned to the row still holding it |
   | `retain`, `softDelete` or `timeSeries` entity | the **confirm-read** below; free only candidates no row of the family holds |
   | `retain` live-row `MODIFY` | no candidates by construction (the same transaction wrote a snapshot holding the old value); skipped without reading |
   | EventStore event | none (immutable; removed only by purge) |

   `BlobGc.make({ reaper: { confirm: "always" } })` confirm-reads for every entity member,
   reading all five ranges. It is for an entity whose `retain` or `softDelete` was turned off
   while its history rows still exist (the member now looks plain, but old snapshots or
   tombstones may share its live row's versions), or whose rows other tooling copies. The
   docs say so where those options are described. The default, `"auto"`, decides from the
   member's current config and reads only the ranges that config can populate (`retain`: R1,
   R2, R4; `softDelete`: R1, R3, R5; `timeSeries`: R1).
5. **Delete** freed versions in one `store.delete` per call. Deletes are idempotent (F2), so
   at-least-once delivery, duplicates and reordering (Kinesis, F17) are harmless.
6. Report `ReapReport { records, candidates, freed, retained, foreign, skipped }`.

**The confirm-read** (shared with the sweeps and purge). A `Query` is only read-committed with
respect to `TransactWriteItems` (F18): a restore that commits between the read of the live
range and the read of the tombstone range is invisible to both, so a single family read can
see no holder of a version the restored row holds. The confirm-read therefore brackets its
range queries with strongly consistent `GetItem`s of the family's live key, which are
serializable with transactions (F18):

```
confirm(family, candidates):
  up to 3 times:
    before = GetItem(liveKey, consistent)
    rows   = the family's ranges (§11.2)
    after  = GetItem(liveKey, consistent)
    if before and after differ (existence, or any attribute) → try again
    return candidates \ refs(rows ∪ after)           // the ones to free
  → free none of them; report "family busy" (retained)
```

Why it is sound:

- **Every library transaction that creates a row holding an existing pointer also writes the
  live row**: a retain update or delete (snapshot + live row), a soft delete (tombstone + live
  delete), a restore (live put + tombstone delete, plus a snapshot with retain), a time-series
  append (event + current item). So if the live row is unchanged between `before` and `after`,
  no holder was created while the ranges were read — with one exception, when both find it
  absent (below). A holder that exists at `after` then existed throughout and was read; a holder
  deleted meanwhile (a TTL expiry) only shrinks the set.
- **Named limit: absent at both ends.** "Unchanged" cannot see two transactions that each write
  the live row and leave it as it was. With the live row present, the holder they leave is the
  live row or a row whose write changed it (a retain snapshot bumps the version), so `after` or
  the comparison catches it. With it absent at both ends, a `restore` and then a soft delete of
  the same item can both commit inside one confirm-read: the restore moves the only holder from
  tombstone T1 to the live row after the live range was read, the delete moves it on to a new
  tombstone T2 after the tombstone range was read, and the version T2 holds is freed. It needs
  two writes to one item within the milliseconds one confirm-read takes, at the moment the
  reaper confirms that item. It is recorded as a limit, not closed: leaving every `softDelete`
  version whose live row is gone to the sweeps (the sound cheap fix) would take the reaper off
  its main `softDelete` path, tombstone TTL expiry; a family fence written by every
  holder-moving transaction would add a write to each of them.
- **"No holder" is permanent.** With no row holding a version, no library write can copy or
  carry it (§6.4). Two concurrent last-holder records both see no holder and both delete
  (idempotent).

Cost: two `GetItem`s and one to five `Query`s per item family per call (candidates of one
family share them), only for `retain`, `softDelete` and `timeSeries` members (or `confirm:
"always"`).

The issue's sketch ("retain: removing the snapshot frees it"; "REMOVE frees all of the item's
versions") misses that one version is shared by many snapshots, a tombstone and a restored row;
the confirm-read is what makes those configs safe **(confirmed**: this replaces the
issue's rules).

Time-series specifics fall out of the same rule:

- an event's TTL `REMOVE` frees its object unless the current item still points at it;
- a version set by `.update()` (no event) is freed when the current item moves on;
- without `timeSeries.ttl`, events never expire, so their versions are kept forever (by design;
  documented).

**Where it runs.**

- The polled change feed (`effect-dynamodb/change-feed`, one batch per shard in flight) is the
  natural home: a batch can wait out the grace at no cost.
- In Lambda the grace is spent sleeping inside the invocation. The 15-minute default equals
  Lambda's maximum timeout, so a Lambda reaper must set an explicit, shorter `gracePeriod`
  (and keep presign expiries and consumer lag within it), or run on the polled change feed
  instead. The docs put this next to the option (§24.2 asks whether the default should differ).
- AWS advises at most two simultaneous readers per shard (Lambda ESMs and Pipes count), which
  is why the reaper is a batch processor that can run inside an existing consumer rather than
  a reader of its own.

### 11.4 Per-item reconciliation sweep (backstop)

`gc.sweep(member, key)` (also `gc.sweepPartition(member, partitionKey)` for an aggregate or a
stream):

1. **Read the family** with the confirm-read's bracket (§11.3), over **all five ranges**
   whatever the member's current config, giving the referenced refs `R`.
2. **List** `store.list` over the member's own family prefix — the current one, plus any own
   family prefix under another leading prefix that a pointer in `R` names (an earlier
   `offload.prefix` or store prefix). Foreign pointers are never listed.
3. **Decide per listed version**, in two passes over time (an *unreferenced-since mark*):

   | Version | Action |
   |---|---|
   | in `R` | keep |
   | not in `R`, last modified less than `maxUploadAge` + 15 minutes ago | keep, unmarked: it may be an upload whose DynamoDB write is still in flight |
   | not in `R`, older, not marked | **mark** it unreferenced since now; keep |
   | not in `R`, marked at least `gracePeriod` ago | **delete** |
   | not in `R`, marked less than `gracePeriod` ago | keep |

4. Report `SweepReport { referenced, listed, marked, deleted, retainedYoung, foreign }`.

Why the marks:

- **Grace is "unreferenced for at least the grace".** A version is deleted only after a sweep
  saw it unreferenced and a later sweep, at least `gracePeriod` afterwards, saw it unreferenced
  again. This holds whether the version stopped being referenced because a newer version
  replaced it, its item was deleted, its field was removed, or its value moved back inline —
  the previous draft's "noncurrent clock" measured from the successor's creation, and deleted
  a last version with no successor at once. It protects readers of an old version and is what
  makes the PITR guidance (§11.8) hold.
- **In-flight writes.** An upload can commit only within `maxUploadAge` of its start, and the
  ledger takes the start before S3 dates the object (§6.1, §7). A version last modified more
  than `maxUploadAge` + 15 minutes ago (the margin absorbs clock skew between writer and S3)
  can no longer be committed by anyone, so it is safe to mark; a younger one is left alone.
  Because only such versions are marked, a marked version can never become referenced again
  ("no holder" is permanent, §11.3), so the sweep never has to read the marks of referenced
  versions.
- **Marks are S3 object tags** on the version (`edd-unref-since`, ISO-8601), written with
  `PutObjectTagging` / read with `GetObjectTagging` by `VersionId`, merged with any tags the
  version already has. Tagging does not create a version. This is the store's `marks`
  capability (§12.1); the memory store implements it too.

Settings: default grace 24 hours, at least 1 hour (`[EDD-9118]`). A sweep needs a store with
`list` and `marks`. Run periodically (daily with the default grace removes a version 24–48
hours after it was first seen unreferenced). Key-per-write stores work the same way (marks
are per ref).

The sweep reads every row of the family (an EventStore stream: every event), which the docs
state; it is a backstop, not a routine pass.

### 11.5 Store-wide sweep (backstop for leaks no row records)

Some leaks leave no row and may leave no log: a process that crashed between upload and
exit, an in-doubt outcome nobody queued, a failed rollback delete, a lost
`CompleteMultipartUpload` response, a reaper outage longer than the stream's 24-hour
retention. The per-item sweep finds them only for items someone names. The observer (§6.2)
reports the ones a live process sees; `gc.sweepStore` finds the rest without a table scan:

```ts
gc.sweepStore(options?: {
  readonly prefix?: string          // default: the store prefix and every member's offload.prefix
  readonly startAfter?: string      // resume after this family prefix
  readonly maxFamilies?: number     // bound one run
}): Stream<StoreSweepFamily, DynamoClientError | BlobStoreError | ValidationError>

type StoreSweepFamily =
  | { readonly _tag: "Swept"; readonly familyPrefix: string; readonly member: string; readonly report: SweepReport }
  | { readonly _tag: "Foreign"; readonly familyPrefix: string; readonly table: string | undefined }
  | { readonly _tag: "Unattributable"; readonly familyPrefix: string; readonly versions: number; readonly bytes: number }
```

1. `store.list` in key order; the versions of one item family are contiguous (`…P/F/…`).
2. Per family, `store.head` of one version gives its metadata (§4.6). A table that is not a
   member's, or an entity that is not a configured member, is `Foreign` — skipped, never
   deleted. A version without `edd-item` (the key was too long for metadata) makes the family
   `Unattributable`, reported for manual handling.
3. Otherwise the row key gives the member's item family (for a time-series event row, its
   current item; for an EventStore row, its stream); if that family's own `P/F` is not the
   listed prefix, the family is `Foreign`. Else the per-item sweep (§11.4) runs on it.

It needs `list`, `head` and `marks` (`[EDD-9118]`). Cost: one `ListObjectVersions` page per 1,000
versions, plus one `HeadObject` and one per-item sweep per family — meant to run rarely (weekly),
resumably. A table-wide sweep (Scan joined with S3 Inventory) remains out of scope (§18).

### 11.6 Purge

`purge` deletes the family's rows first, as today, now also projecting the offloaded
attributes so it knows the set `N` of pointers the purged rows named. Only after every
DynamoDB delete succeeded does it touch the store:

1. **Re-read the family** with the confirm-read's bracket (§11.3), giving the refs `R` still
   referenced — normally none; some if a concurrent `put`, `create` or time-series `append`
   re-created the item (an append's CAS `attribute_not_exists(pk) OR #orderBy < :new` passes
   once the current item is gone).
2. **List** the own family prefixes (the current one, plus own prefixes that pointers in `N`
   name).
3. **Delete** each listed version not in `R` that is named in `N`, or that was last modified
   more than `maxUploadAge` + 15 minutes ago (it cannot be in flight, §11.4). Younger,
   unnamed versions — possibly the upload of a write racing the purge — are left for the
   sweep, which deletes them only once they are old enough and still unreferenced.
4. On a store without `list`, steps 2–3 delete the versions in `N` that are not in `R`.

A partial purge (a DynamoDB delete failed) leaves the store untouched. Purge is an explicit
"delete this item's data": it does not wait for any grace, and a point-in-time restore from
before the purge reads `NotFound` for the purged versions (§11.8).

### 11.7 Lifecycle rules

| Rule on the offload prefix | Safe? |
|---|---|
| `AbortIncompleteMultipartUpload` (days > `maxUploadAge`) | **yes** — the backstop for crashed multipart uploads (prefix filter only; tag filters are not allowed with it) |
| `ExpiredObjectDeleteMarker` | **yes**. The library never creates a delete marker in a versioned bucket. The one exception is the cleanup after a write to a versioning-*suspended* bucket, if the store falls back to a plain `DeleteObject` (§12.2): that leaves a `null` delete marker (F20), harmless to version-pinned reads and removed by this rule |
| Transition to Standard-IA, Intelligent-Tiering (without archive tiers), Glacier Instant Retrieval | yes (cost/latency trade-off only) |
| Transition to Glacier Flexible Retrieval / Deep Archive, or Intelligent-Tiering archive tiers | **no** — GETs fail until restored |
| `NoncurrentVersionExpiration`, `NewerNoncurrentVersions`, `Expiration` | **no** (§11.1) |
| Any rule filtered on the `edd-unref-since` tag | **no** — a mark is not a decision to delete (§11.4) |

### 11.8 Backups, point-in-time recovery and table copies

- **A copy never deletes its source's data.** A PITR or backup restore (a new table name), an
  import or a copied table references the source's versions as **foreign** (§11.2): its GC
  never deletes them, and its own writes upload under its own keys, so it diverges
  copy-on-write. This holds only if the copy's table name differs from the source's or it
  uses another bucket: a restore into another region or account that keeps the name and points
  at the same bucket computes the same `P` and would treat the source's versions as its own.
  The guide says so. (Global Tables replicas share a name by design, each with its own bucket,
  §16.)
- **The source's GC does not know about its copies.** A version the source frees may still be
  referenced by a restored copy, which then reads `NotFound` for that field. The reaper's grace
  is bounded by stream retention (24 hours), so it cannot cover a 35-day PITR window. For
  tables whose restores must be whole, the docs recommend running only the sweep, with a grace
  at least as long as the restore window, and no reaper: the sweep keeps every version for at
  least its grace after it was first seen unreferenced (§11.4), so any point inside the window
  restores whole. Purge and rollback deletes are not covered: purged data is gone by request,
  and a rolled-back version was never committed, so no point in time references it. There is
  no separate "never delete" GC mode (confirmed 2026-11-01): sweep-only GC with a grace at
  least the restore window is the documented answer.
- **A copy that must outlive the window** rewrites its offloaded values into its own keys
  (any `put` / `.set()` of the field).

### 11.9 Versions per key

Every write of an offloaded field adds a version to its key. Two cases can still pile up
versions:

- a hot item updated millions of times between GC passes;
- a `retain` entity keeping that many snapshots.

Both can exceed S3's ~100,000 versions per key (F11), and S3 then throttles the bucket. The docs
state this, and the reaper is what keeps a hot item's key short. Time-series appends are keyed
per event (§4.5) and are immune.

### 11.10 Pointer rows never move: offloading requires `escapeKeys: true`

Object keys (§4.5) are computed **at upload** from the owning row's stored key text: the
partition's `P` from its partition key, the family's `F` from its live sort key. S3 has no
rename, so a pointer that moved with its row to other key text would keep the old text's `P` and
`F`, and every GC path would misjudge it: under its new key it is foreign (never reaped or swept,
a leak), and under the key it left it is own — the reaper would free a snapshot's version from
the move's `REMOVE` (a snapshot is freed directly, §11.3), and a sweep of the old family would
find it unreferenced — while the moved row still names it.

**Invariant: every row that holds a blob pointer is stored at the key text `escapeKeys: true`
composes from its values, and no library operation moves it to other key text.** GC therefore
needs no knowledge of any other key text. The requirement (owner decision, 2026-11-14) is what
makes the invariant hold without per-row machinery: under `escapeKeys: true` the key text a write
composes is final, and `rekey` (DESIGN.md §7 "`rekey`") never moves a row already under it. Under
`escapeKeys: false` it would not hold: `rekey` and the next major's default (escaped text) both
move every row whose text differs.

Proof, over every write and move path on 1.42.2 plus this feature:

1. **Only `escapeKeys: true` writes pointers.** A member with an offloaded field is refused where
   it is bound when its table's schema doesn't set `escapeKeys: true` — `DynamoClient.make`,
   `Entity.bind`, `Aggregate.bind`, `EventStore.bind` / `bindProjection`, `GeoIndex.bind`,
   `BlobGc.make`, and the streams `rekey` is given — with the `[EDD-9146]` defect (§13). An unbound operation, which
   no bind sees, is refused where it routes: every upload goes through `OffloadWrite.route`,
   whose row (`OffloadRow`) carries its schema's setting, and a row under any other setting fails
   with a `ValidationError` (`[EDD-9146]`) before anything is uploaded or sent. So 1.42.2 and
   earlier (which had no offloading) and every `escapeKeys: false` writer wrote only pointer-free
   rows.
2. **Every write composes one text.** Since 1.39 (#183) an operation composes the one text its
   setting chooses and looks nowhere else: no fallback read, no move on first write, no row check
   on another value's text (DESIGN.md §7 "Key text", pinned by `test/KeyRequests.test.ts`). The
   1.37–1.38 machinery that moved an item from its 1.36 key on its next write is gone. So `put`,
   `create`, `upsert`, `insert`, `update`, `patch`, `delete`, `restore`, time-series `append`,
   `Batch.write`, `Transaction.transactWrite`, aggregate writes, EventStore appends and snapshots,
   projection rows and `GeoIndex.put` each write their row at its final text.
3. **Copies land at keys of the same text.** The rows a write copies pointers into — retain
   snapshots, soft-delete tombstones, a restored live row, a time-series event item (§6.4, §6.12)
   — are keyed in the same partition, their item segment taken from the escaped live key, and
   GC reads them as the item family's ranges (§11.2). They are copies, never moves of the
   pointer to other text.
4. **The only moves are of rows no pointer can be in.** Two paths move a row from one key text
   to another, and both move only rows under text an `escapeKeys: true` writer of this release
   never composes:
   - **`rekey`** moves a row under another form's text (up to 1.36 and `escapeKeys` off; 1.37.0
     and 1.38.0; a codec's doubled text up to 1.39.0; an aggregate `entity:` edge's 1.40.0 text;
     a row under the other numeric kind's text, written before 1.40.0 by a key composite declared
     both kinds — 1.40.0 refuses that declaration and a `Schema.Unknown` key composite with
     `EDD-9128`, so a 1.43.0 writer never produces one; an item 1.39.0's or 1.40.0's `restore`
     left under `[object object]`) to the current one. Every such row was written by a release
     without offloading or under `escapeKeys: false`, so by 1 it holds no pointer. A row at its current text is never moved:
     its stale index keys and sentinels are rewritten in place (`UpdateItem` of key attributes
     only, which never names an offloaded attribute), and another value's old row in the way is
     itself a row under other text. A run that meets a row both at its old and its current key
     reports `bothKeys` and moves neither.
   - **An aggregate `update` under `escapeKeys: true`** deletes, in a changed group's own
     transaction, each element row it read under 1.40.0's `entity:` edge text, and writes the
     group at the current keys, uploading every offloaded edge field afresh (§6.9). The row it
     deletes was written by 1.40.0: pointer-free.
5. **Backstop.** `rekey` refuses to move a row that holds a blob pointer: before any write of a
   move (the item's or a history row's, read consistently) it looks for a pointer in the row —
   both stored forms, at any depth, whatever the member now declares — and fails the run with a
   `ValidationError` (`[EDD-9146]`) naming the row's key, leaving it where it is. Under the
   requirement nothing reaches it; it can fire only if `escapeKeys` was turned off over rows
   offloading wrote (and the offloaded declarations removed, since the members are refused at
   bind). Such a table cannot be rekeyed off escaped text while pointers remain. Every row holding
   one must go first, not only live items: live items' values rewritten inline (`put` /
   `.set()`); retain snapshots, soft-delete tombstones and time-series event items, which keep
   the pointers they copied and which nothing rewrites, purged, deleted or expired; and an
   EventStore stream that ever offloaded event data or a snapshot can't be rekeyed off escaped
   text at all, since events are immutable. Otherwise the table keeps `escapeKeys: true`. A dry
   run refuses the same row. The refusal is met where the scan meets the row: the run stops
   there, rows any segment reached before it may already have moved, and the failed run returns
   no report or resume token (a named limit: the path exists only after the setting was turned
   off against this section's requirement).

On the change feed, nothing here produces an `INSERT` / `REMOVE` pair for a pointer row, so the
reaper never sees a pointer leave a row that still exists elsewhere. Pinned by
`Entity.offload.test.ts` ("bind-time checks": `[EDD-9146]` from `DynamoClient.make`, `Entity.bind`
and `Aggregate.bind`, and from an unbound write's routing, nothing uploaded; "rekey never moves a
pointer row": `rekey` over a table offloading wrote, under the same setting, moves nothing, and
with `escapeKeys` turned off refuses the row naming its key, a dry run included), and by the
aggregate, EventStore and geo suites for their members.

---

## 12. `BlobStore` contract and implementations

### 12.1 Contract

```ts
export interface BlobRef { readonly key: string; readonly version: string }   // version "" = immutable key
export interface BlobChecksum { readonly algorithm: "crc64nvme"; readonly value: Uint8Array }

export interface BlobPutRequest {
  /** The library-derived key (§4.5). A key-per-write store may extend it, never move it out of its family prefix. */
  readonly key: string
  readonly body: Uint8Array | Stream.Stream<Uint8Array, BlobSourceFailure>
  readonly contentLength: number | undefined
  /** CRC64NVME of the body bytes; resolves when `body` has been consumed. */
  readonly checksum: Effect.Effect<BlobChecksum>
  readonly contentType: string
  readonly metadata: Readonly<Record<string, string>>
}
export interface BlobPutResult { readonly ref: BlobRef; readonly size: number }
export interface BlobListing {
  readonly ref: BlobRef; readonly size: number; readonly lastModified: Date; readonly isLatest: boolean
}

export interface BlobStoreService {
  /** For messages, e.g. "s3://documents-blobs/prod/". */
  readonly name: string
  /** The store prefix; an entity's `offload.prefix` replaces it for that entity (§3.3). */
  readonly prefix: string
  /** Upper bounds the item-budget planner counts a pointer at. */
  readonly limits: { readonly maxVersionBytes: number; readonly maxKeySuffixBytes: number }
  /** An upload not committed by this age after it started fails with `Expired` (§6.1); GC relies on it (§11.4). */
  readonly maxUploadAge: Duration.Duration
  readonly readConcurrency: number
  readonly writeConcurrency: number
  /** MUST return an immutable reference: the bytes `ref` names never change. */
  readonly put: (request: BlobPutRequest) => Effect.Effect<BlobPutResult, BlobStoreFailure>
  /** Each chunk is handed over: never reused or changed once emitted (commit 6). */
  readonly get: (ref: BlobRef, options?: { readonly range?: ByteRange }) => Stream.Stream<Uint8Array, BlobStoreFailure>
  /** Idempotent: deleting an absent ref succeeds. */
  readonly delete: (refs: ReadonlyArray<BlobRef>) => Effect.Effect<void, BlobStoreFailure>
  readonly copy?: (source: BlobRef, request: Omit<BlobPutRequest, "body" | "checksum">) =>
    Effect.Effect<BlobPutResult, BlobStoreFailure>
  readonly list?: (prefix: string, options?: { readonly startAfter?: string }) =>
    Stream.Stream<BlobListing, BlobStoreFailure>
  /** The metadata the library wrote with the version (§4.6). */
  readonly head?: (ref: BlobRef) => Effect.Effect<Readonly<Record<string, string>>, BlobStoreFailure>
  /** Unreferenced-since marks (§11.4). Absent refs: `get` succeeds with `undefined`, `set` / `clear` succeed. */
  readonly marks?: {
    readonly get: (ref: BlobRef) => Effect.Effect<Date | undefined, BlobStoreFailure>
    readonly set: (ref: BlobRef, since: Date) => Effect.Effect<void, BlobStoreFailure>
    readonly clear: (ref: BlobRef) => Effect.Effect<void, BlobStoreFailure>
  }
  readonly presign?: (ref: BlobRef, options: { readonly expiresIn: Duration.Duration; readonly contentType?: string }) =>
    Effect.Effect<string, BlobStoreFailure>
}

/** What a store fails with; the library wraps it into `BlobStoreError` with operation context. */
export class BlobStoreFailure extends Data.TaggedError("BlobStoreFailure")<{
  readonly reason: BlobStoreReason
  readonly ref?: BlobRef | undefined
  readonly cause: unknown
}> {}
```

- **`BlobSourceFailure`** (commit 5) is `BlobStoreFailure & { reason: "SourceFailed" }`: the
  library wraps the input `Stream`'s error (its `cause`) before handing the body to the store,
  so a store's `put` lets a source failure through as its own failure, with no second error
  type in the contract.
- **Where `BlobRef` and `BlobChecksum` live.** They are defined in the schema package, in
  `@effect-dynamodb/schema` `internal/BlobPointer.ts` beside the pointer codec, because the
  codec and `BlobStoreError` (`ref?: BlobRef`, §14.1) live there and the schema package cannot
  import from core. Core's `BlobStore.ts` re-exports them and does not declare its own.
- **Library vs store.** The library computes the checksum and verifies sizes and checksums on
  read; a store never has to be trusted for either. The library also enforces `maxUploadAge`
  (§6.1): a store only declares it.
- **Delete semantics.** `delete` takes refs (versions), never bare keys, so no store
  implementation can delete a version it was not named. (The S3 store's one plain
  `DeleteObject`, cleaning up after a write to an unversioned bucket, is internal to its
  `put`, §12.2.)
- **Capabilities.** `list`, `head`, `marks`, `copy` and `presign` are optional. GC states what
  it needs (`[EDD-9118]`): the per-item sweep `list` + `marks`, the store-wide sweep `list` +
  `head` + `marks`; purge uses `list` when present (§11.6).
- **No `R`.** The contract has no `R`: an implementation closes over its client.
- **Tracing.** Every call is wrapped in a span (`BlobStore.put`, `.get`, …) by the library.

### 12.2 S3 store (`effect-dynamodb/blob/s3`)

- **Dependencies.** `src/blob/s3.ts`, `package.json` `exports["./blob/s3"]`.
  `@aws-sdk/client-s3` is an optional peer at `^3.1104.0`, the repo's SDK floor and above the
  3.957.0 CRC64NVME requirement (F7); it is also a dev dependency. A guard test
  (`test/blob-s3-subpath-guard.test.ts`) keeps it out of the main entry's import graph, as the
  change-feed and compression guards do.
- **Put.** `PutObject` (or multipart, §7) with `ChecksumAlgorithm: "CRC64NVME"` and the
  precomputed value (F8: never rely on the SDK default). The `VersionId` in the response must
  be present and not `"null"` (F1); otherwise the store fails with `reason: "Unversioned"`,
  whose message names the bucket and says to enable versioning, after cleaning up what it
  wrote:
  - `VersionId` `"null"` (versioning **suspended**): `DeleteObject` with `VersionId: "null"`,
    which removes exactly that object and creates no delete marker (F20). If the deletion is
    refused, a plain `DeleteObject` of the key follows, which leaves a `null` delete marker
    (harmless, §11.7).
  - No `VersionId` (versioning never enabled): a plain `DeleteObject` of the key.
  No pointer can name either object. No `GetBucketVersioning` pre-check. S3 Express One Zone
  directory buckets have no versioning and are refused the same way.
- **Copy.** `CopyObject` with `CopySource: bucket/key?versionId=…` (≤ 5 GB; larger via
  `UploadPartCopy` parts and `CompleteMultipartUpload`). The response's `VersionId` is checked
  exactly as for a put — on `CopyObject`, and on the `Complete` that ends an `UploadPartCopy`
  sequence — with the same cleanup.
- **Get.** `GetObject` with `VersionId` and `Range`. The body is read through
  `transformToWebStream()` (runtime-neutral) into an Effect `Stream`. `ChecksumMode` is not set
  (the library verifies itself, §8.6).
- **Delete.** `DeleteObjects` with `VersionId`s, ≤ 1,000 per request. Per-key errors are
  classified, and `NoSuchVersion` / `NoSuchKey` count as success.
- **List.** `ListObjectVersions(Prefix, KeyMarker)` (delete markers excluded).
- **Head.** `HeadObject` with `VersionId`, returning the user metadata.
- **Marks.** Object version tags: `GetObjectTagging` / `PutObjectTagging` with `VersionId`.
  `set` and `clear` read the version's tags first and write the set back with `edd-unref-since`
  added or removed (an empty set is allowed), so tags set by other tooling survive — unless that
  tooling rewrites the same version's tags at the same moment, which the docs warn against.
  Tagging does not create a version.
- **Presign.** Only when the layer is given `presign: { getSignedUrl }` from
  `@aws-sdk/s3-request-presigner`. The library never imports it, so it is not even an optional
  peer.
- **Options.**
  - SSE and storage class pass through (`ServerSideEncryption`, `SSEKMSKeyId`,
    `BucketKeyEnabled`, `StorageClass`).
  - `forcePathStyle` and `endpoint` come through the client config (MinIO).
  - `notFoundRetry?: Schedule`.
  - `maxUploadAge` (default 1 hour, from 1 minute to 7 days).
  - Invalid options are `[EDD-9116]`: an empty bucket, a prefix starting with `/` or longer
    than 256 bytes, a `partSize` out of range, a concurrency that is not a positive integer, a
    `maxUploadAge` out of range.
- **Errors.** SDK errors classify into `BlobStoreReason`:

  | Reason | From |
  |---|---|
  | `NotFound` | `NoSuchVersion`, `NoSuchKey`, `NoSuchBucket` |
  | `AccessDenied` | `AccessDenied` (incl. an Object Lock or MFA Delete refusal on delete, F13) |
  | `Throttled` | `SlowDown`, 503 |
  | `ChecksumMismatch` | `BadDigest`, `XAmzContentChecksumMismatch`, `InvalidDigest` |
  | `Unavailable` | 5xx and transport failures after the SDK's retries |
  | `TooLarge` | `EntityTooLarge`, part number out of range |
  | `Rejected` | other 4xx |

  The SDK error is the `cause`.
- **Unsupported bucket settings.** Object Lock and MFA Delete make rollback and GC deletes fail.
  Writes and reads work, deletes surface as `AccessDenied`, and the docs list these settings
  as unsupported for GC.

### 12.3 In-memory store

`BlobStore.memory({ versioning?: "versioned" | "keyPerWrite", presign?: boolean,
maxVersionBytes?, maxUploadAge?, clock?, failures?: … })`:

- **`"versioned"`** (default): stable keys, version ids of 32 random hex characters (like S3's).
- **`"keyPerWrite"`**: each put gets `key + "/" + 26-char suffix` and version `""` — the
  contract's no-versioning path, so tests can exercise both.
- **Behaviour.** `copy`, `list`, `head`, `marks` and `presign` (a fake `memory://` URL) are
  implemented, ranged reads honour offsets, and `lastModified` comes from Effect's `Clock`, so
  `TestClock` drives GC and `maxUploadAge` tests.
- **Fault injection.** A `failures` hook lets tests fail the n-th call of an action with a
  reason (including an outright `put` failure after the body was consumed), drop a response
  after the write took effect, or interrupt mid-stream.
- **Inspection.** `inspect()` exposes the store's contents (versions, metadata, marks) for
  assertions.

*Implementation notes (commit 5):*

- **Options** beyond the list above: `prefix` (default `""`, the store-prefix rule of `[EDD-9116]`),
  `readConcurrency` / `writeConcurrency` (defaults 16 / 8) and `readChunkBytes` (default
  65,536, the chunk size of a `get`, so tests can exercise multi-chunk reads). Unknown keys are
  refused. `maxVersionBytes` is the declared `limits.maxVersionBytes`: from the ids the store
  makes (32 versioned, 0 key-per-write) to 1,024. `maxKeySuffixBytes` is 0 versioned, 27
  key-per-write. `name` is `memory://<prefix>`.
- **Ids.** Version ids are 32 lowercase hex characters from Effect's `Random` (so
  `Random.withSeed` reproduces them); a key-per-write suffix is a 10-character millisecond
  timestamp plus 16 random characters, Crockford base32, monotonic per store as a monotonic
  ULID is: when the clock has not passed the last suffix's millisecond (the same millisecond, a
  frozen `TestClock`, a clock that stepped back) the suffix keeps that timestamp and counts the
  random part up by one, so a family's keys list in write order even within one millisecond.
- **Like S3.** A `put` checks the body against its `checksum` (`ChecksumMismatch`) and
  `contentLength`, and refuses (`Rejected`) a key over 1,024 bytes (after the key-per-write
  suffix), an empty content type, and metadata that is not US-ASCII or exceeds 2 KB (§4.6's
  count); metadata keys are stored lowercased. A range must have a non-negative integer offset
  no greater than the size, and an optional non-negative integer length (clipped at the end).
  Listings are in UTF-8 (code point) key order, versions newest first, `startAfter` exclusive.
  Every byte array in and out is copied.
- **The `failures` hook** receives `{ action, n, key?, ref?, refs?, mark? }` (`n` counts calls per
  action; `mark` names the marks operation) and returns `undefined` or a fault, directly or as
  an `Effect` (so a test can pause a call on a `Deferred`): `{ _tag: "Fail", reason }` or
  `{ _tag: "Interrupt" }`, each with `at: "request"` (default: no effect — a `put` first consumes
  its whole body, or `afterChunks` chunks; a `get` / `list` first emits `afterChunks` items,
  default none) or `at: "response"` (the call takes effect, then fails or is interrupted — a
  lost response; a `put` or `copy` failure names the version it stored, while a request-time
  `copy` fault names the source). Naming the stored ref is a **test convenience the S3 store
  cannot provide**: when a response is lost, S3 never reported the version. So no settlement
  may depend on a failed upload's `ref` — a failed upload fails the operation and is found by
  the sweeps (§7, §11.5) — and tests that inspect the stored version should use `inspect()`.
- **`inspect()`** returns `{ versions, calls }`: every version (ref, size, a copy of the bytes,
  content type, metadata, `lastModified`, `isLatest`, `mark`) in listing order, and the number
  of calls per action.

### 12.4 Stores without versioning

The contract allows a store that returns `{ key: <unique key under the family prefix>,
version: "" }` (decision 7). Such a store works with everything above. The reaper and sweep
delete by `{ key, version: "" }`, and marks are per ref, so the two-pass sweep (§11.4) works
unchanged. Cloudflare R2 (F16) and GCS / Azure (native stores) are follow-ups, not shipped
(§18).

---

## 13. Configuration validation at bind time

A member with an offloaded field meets pointers on every read and needs the store on every
write, so the store is a configuration requirement, checked where it is first resolvable —
the `[EDD-9078]` pattern:

- **`DynamoClient.make`** checks every bound entity with an offloaded field, and every bound
  aggregate whose edge entities have one, against the store it binds with (§3.6 rules 1–2).
  None → the `[EDD-9115]` defect, naming every member and field.
- **`EventStore.bind(stream)`** and **`EventStore.bindProjection`** check `storedAs.data` /
  `snapshot.storedAs` with `external`.
- **An unbound `EventStream`**, and **`EventStore.processBatch` / `runChangeFeed`** over
  streams that offload, check on their first operation per context (the `runtimeCodecCheck`
  `WeakSet` pattern, `Packed.ts:152-166`).
- **`GeoIndex.bind`** checks the geo entity (geo reads resolve eagerly, §8.4).
- **`BlobGc.make`** checks its own context.
- **`Batch` / `Transaction`** need no check of their own: bound builders carry the store they
  were bound with (§3.6 rule 1), and unbound ops follow the next rule.
- **Unbound entity operations** cannot be checked at bind. A write that needs to upload, or a
  read that meets a pointer, with no store fails with `BlobStoreError { reason: "NotProvided"
  }` — typed, since those entities carry `BlobStoreError`.
- **Adjacent debt, fixed in the same change:** `Entity.bind` and `Aggregate.bind` skip the
  `[EDD-9078]` codec check today (`Entity.ts:10460`, `Aggregate.ts:1972`). Both gain the
  codec check and the store check.

**Escaped key text (`[EDD-9146]`, owner decision 2026-11-14).** Offloading requires the table's
schema to set `escapeKeys: true` (§11.10). Wherever a member is bound with the store check above —
`DynamoClient.make`, `Entity.bind`, `Aggregate.bind`, `EventStore.bind` / `bindProjection`,
`GeoIndex.bind` (through its entity), and `rekey`'s binding of the streams it is given — a member
with an offloaded field on a schema without it is the `[EDD-9146]` defect, naming every such
member and field, before the store check (a store doesn't make the key text right). `Table.make`
binds nothing and checks nothing. An unbound write is refused where it routes (§11.10, 1): a
`ValidationError` (`[EDD-9146]`), nothing uploaded or sent. Reads are not refused: a pointer
already stored resolves whatever the setting, so a table whose setting was turned off stays
readable.

Store options are validated when the layer is built (`[EDD-9116]`); `BlobGc` options when it is
made (`[EDD-9118]`).

---

## 14. Errors

### 14.1 `BlobStoreError` (`packages/schema/src/Errors.ts`, re-exported)

```ts
export type BlobStoreReason =
  | "NotProvided"       // no BlobStore in context
  | "Unversioned"       // PutObject / CopyObject / Complete returned no real VersionId
  | "NotFound"          // NoSuchVersion / NoSuchKey (or AccessDenied without s3:ListBucket, F12)
  | "AccessDenied"
  | "Throttled"
  | "ChecksumMismatch"  // upload validation, or read verification (§8.6)
  | "TooLarge"
  | "SourceFailed"      // the input Stream failed
  | "Expired"           // the upload finished after maxUploadAge (§6.1); nothing was written to DynamoDB
  | "Unsupported"       // a capability the store lacks (presign, list, head, marks), or presign of an inline handle
  | "Unavailable"       // 5xx / transport after retries
  | "Rejected"          // any other store refusal

export class BlobStoreError extends Data.TaggedError("BlobStoreError")<{
  readonly entityType: string          // entity type, or "<stream>.event" / "<stream>.snapshot"
  readonly attribute: string           // stored attribute name
  readonly operation: string           // e.g. "put", "get.offload", "EventStore.append"
  readonly action: "put" | "get" | "delete" | "copy" | "list" | "head" | "mark" | "presign"
  readonly reason: BlobStoreReason
  readonly ref?: BlobRef | undefined
  /** The DynamoDB write committed; only reading its result back failed (§6.13). Do not retry. */
  readonly committed: boolean
  readonly cause: unknown              // the store's BlobStoreFailure (its cause: the SDK error)
}> {}
```

It lives in the schema package beside `EmbeddingError` and `CompressorNotRegistered`, so the
type helpers of §9.3 sit next to `VectorErrors`. It is AWS-free (`cause: unknown`).

### 14.2 What is a `ValidationError` instead

Everything about the **stored form** stays a `ValidationError`, as for Packed:

- a malformed pointer (reserved header, bad magic or trailer, truncated, lengths out of range,
  an `S` value that starts with `~edbp:` but is not valid base64url);
- a corrupt payload that fails decompression or `JSON.parse` after a verified fetch;
- an input of the wrong shape, or a reused `Stream` (`[EDD-9120]`);
- a pointer met on a field that is no longer offloaded, whose resolution failure is the
  `cause` (§4.7).

### 14.3 New EDD codes (band 9111, 9114–9120, 9141–9143 and 9146, registry rows added to `DESIGN.md` in this commit)

The design allocated the contiguous block `9110`–`9120` on 1.37.0. While the branch was in
review, main released `EDD-9110` (PartiQL `insert`), `EDD-9112` (an aggregate key attribute)
and retired `EDD-9113`, so on the rebase onto 1.42.2 those three became `EDD-9141`, `EDD-9142`
and `EDD-9143`; `9111` and `9114`–`9120` were held for this branch in main's registry and are
kept. Every use (code, tests, docs, examples, this document) carries the new numbers.
`EDD-9146` (offloading without `escapeKeys: true`) was added for the owner's decision of
2026-11-14: the next code free in main's registry after `9145`.

| Code | Raised in | Condition |
|---|---|---|
| `EDD-9111` | `Entity.ts` (schema), `Aggregate.ts` | An `External` field does not exist on the model, or its encoded side is not `Uint8Array` (e.g. `Uint8ArrayFromBase64`, a string, a union with a non-binary member) |
| `EDD-9114` | `Entity.ts` (schema), `EventStore.ts` | `offload` options invalid: an unknown key, `itemBudget` not a safe integer in 1 … 409,600, `prefix` not a non-empty string of unreserved characters and `/` ≤ 256 bytes, `itemBudget` without an overflow field, or `offload` on a member without an offloaded field |
| `EDD-9115` | `DynamoClient.ts`, `EventStore.ts`, `GeoIndex.ts` (geo), `BlobGc.ts`, `Entity.ts` (`bind`), `Aggregate.ts` (`bind`) | A member with an offloaded field is bound (`DynamoClient.make`, `EventStore.bind`, `EventStore.bindProjection`, `GeoIndex.bind`, `Entity.bind`, `Aggregate.bind`, `BlobGc.make`), or an unbound stream or `EventStore.processBatch` / `runChangeFeed` runs its first operation, with no `BlobStore` resolvable |
| `EDD-9116` | `BlobStore.ts`, `blob/s3.ts` | Store options invalid: an empty bucket, a prefix starting with `/` or over 256 bytes, `partSize` outside 5 MiB … 5 GiB, a concurrency that is not a positive integer, `maxUploadAge` outside 1 minute … 7 days, memory-store options invalid, or a custom store (`BlobStore.layer`) whose `limits` are not non-negative integers (`maxVersionBytes` at most 1,024, `maxKeySuffixBytes` at most 670), whose `maxUploadAge` is not a positive finite duration, or whose name, prefix, concurrencies or operations are invalid |
| `EDD-9117` | `internal/BoundQuery.ts`, `Query.ts`, `Entity.ts`, `EventStore.ts` | An offload mode the library cannot honour (reachable from untyped code): an unknown mode string or key, or `.offloaded()` after `.filterBy()` |
| `EDD-9118` | `BlobGc.ts` | `BlobGc.make` options invalid: a reaper grace that is not a non-negative duration; a sweep grace under 1 hour or under the store's `maxUploadAge` + 15 minutes; an unknown `reaper.confirm` value; a member without offloaded fields; or a sweep (per-item or store-wide) on a store without the capabilities it needs (`list` and `marks`; `sweepStore` also `head`) |
| `EDD-9119` | `BlobGc.ts`, `Entity.ts` (`decodeStreamRecord`) | A stream record lacks the images reaping or change detection needs: its `StreamViewType` is not `NEW_AND_OLD_IMAGES`, or (no view type on the record) a `MODIFY` / `REMOVE` without `OldImage` or a `MODIFY` / `INSERT` without `NewImage`. A defect from `reap` (every record checked before any is acted on), a `ValidationError` from `decodeStreamRecord` |
| `EDD-9120` | `Entity.ts`, `internal/TransactableOps.ts`, `Aggregate.ts`, `EventStore.ts` | An offloaded field's write input is unusable (`ValidationError` at execution): a `Stream`, handle or source for an overflow field; a value that is not `Uint8Array` / `Stream` / `BlobHandle` / `Offload.source` for a binary field; a `Stream` or source for an aggregate edge; or a `Stream` given to a second target (another field, item or op) or to a later operation after its first use — a `Stream` is single-use (§3.8) |
| `EDD-9141` | `DynamoModel.ts` | `DynamoModel.Packed({ external })` or `DynamoModel.External(...)` options invalid: not an object, an unknown key, a `threshold` that is not a non-negative safe integer, a `contentType` that is not a non-empty US-ASCII string ≤ 255 bytes |
| `EDD-9142` | `Entity.ts` (schema), `Aggregate.ts` | An `External` field is a key or index attribute source (primary-key / GSI / LSI composite, a GSI's `shards.by` source, `timeSeries.orderBy`), a unique-constraint field, a ref field, the entity's identifier, a vector index source, partition or filter field, or an aggregate discriminator / `many` sort-key composite. (An aggregate's list and collection composites are root fields, and a root model takes no `configure`, so none can be `External`: there is nothing to check there.) |
| `EDD-9143` | `Entity.ts` (schema), `Aggregate.ts` | A ref (entity ref, aggregate ref edge, or the ref a `many` edge's element wraps — `PlayerSheet { player }`, which hydration fills by name — at any depth) whose schema includes a field the referenced entity offloads — the denormalised copy would inline it (400 KB risk), need to marshal a lazy handle, or copy a pointer across item families (§11.2). Reference a subset model without the field |
| `EDD-9146` | `DynamoClient.ts`, `Entity.ts` (`bind`), `Aggregate.ts` (`bind`), `EventStore.ts`, `GeoIndex.ts` (geo), `internal/OffloadWrite.ts` (`route`), `internal/Rekey.ts` | A member with an offloaded field on a table whose schema doesn't set `escapeKeys: true`: bound (`DynamoClient.make`, `Entity.bind`, `Aggregate.bind`, `EventStore.bind`, `EventStore.bindProjection`, `GeoIndex.bind`, the streams given to `rekey`) — a defect naming every such member and field; or written unbound — a `ValidationError` from the routing, nothing uploaded or sent. Also `rekey` about to move a row that holds a blob pointer — a `ValidationError` naming the row's key, nothing written (only after `escapeKeys` was turned off over rows offloading wrote, §11.10) |

**Extended, not new:** `EDD-9076` (expressions / projections) and `EDD-9077` (update ops) now
also cover `External` binary fields — the same condition (an attribute DynamoDB sees as one
opaque value), raised by the same walker. A note under the registry records it (this commit),
and the implementation's messages say "packed or External".

The registry's "next free" line is updated in this commit to skip the codes above.

---

## 15. Constraints inherited from Packed (and their binary equivalents)

| Rule | Overflow field | Binary field |
|---|---|---|
| Not a key / index composite, `shards.by` source, `orderBy`, unique field, ref field | `EDD-9072` / `9074` / `9075` (it is Packed; `shards.by` names only composites) | `EDD-9142` (nor the entity's identifier) |
| Not a vector index filter field | `EDD-9072` | `EDD-9142` (nor a vector *source*: the embedder reads text) |
| May be a vector source field | yes (an untouched source costs a GET when re-embedding, §6.5) | no |
| Conditions / filters: only `attribute_exists` / `attribute_not_exists`, whole field | `EDD-9076` | `EDD-9076` (extended); `PackedPath` at the type level |
| Projections: whole field only | `EDD-9076` | `EDD-9076` (extended) |
| Updates: whole-value `.set()` / `.remove()` only | `EDD-9077` | `EDD-9077` (extended) — `.add` / `.deleteFromSet` on a binary attribute are refused, and a path copy (`pathSet` / `pathSubtract` with `isPath` + `valueSegments`) FROM a packed or External field: it would put the opaque stored value, a blob pointer included, in an attribute GC never reads for pointers, which the reaper would then free under it |
| `immutable` | yes: checksum and size as the fast path, a structural comparison before refusing; a restated value that passes is dropped from the write (§5, §6.5) | yes, likewise (byte comparison) |
| `field` rename | yes | yes |
| `timeSeries.appendInput` | yes (one object, two items, §6.8) | yes |
| Ref copies | a ref schema — entity ref, aggregate ref edge, or the ref a `many` element wraps — must not include the field (`EDD-9143`), so no pointer crosses an item family (§11.2) | likewise |
| Sparse | impossible (one `storedAs`) | impossible |

**Why whole items are never offloaded** (decision 1, kept): DynamoDB evaluates conditions and
filters against the stored item. A whole item spilled to S3 would make every expression run
against a stub and silently return wrong results. Because offloaded fields are limited to
existence tests, nothing DynamoDB evaluates depends on their contents.

**Key composer**: untouched. No offloaded field can be a composite, so
`composeGsiKeysForUpdatePolicyAware` never sees one.

---

## 16. Global Tables and replication

- **One pointer, many buckets.** The pointer carries no bucket (§4.2): each region's layer names
  its replica bucket, and S3 replication keeps keys and `VersionId`s (F4). Both buckets need
  versioning; multi-active writers need two-way replication.
- **Replica lag.** S3 replication of a large object can lag DynamoDB's by minutes to hours
  without S3 RTC (15-minute SLA). A replica-region read can therefore get `NotFound` until the
  object arrives — `notFoundRetry` on the store helps only for short lags. The docs recommend
  S3 RTC for latency-sensitive replica reads.
- **Per-region GC.** Deletes by `VersionId` are **not replicated** (F4), so rollback deletes and
  GC act in one bucket only. Each region runs its own reaper over its own stream replica (Global
  Tables emit records in every region) against its own bucket. A version the writer's region
  rolled back but had already replicated is an orphan in the replica bucket that only that
  region's sweep reclaims.
- **Same table name, same keys.** Global Tables replicas share the table name, so every region
  computes the same `P` and treats the versions as its own — right, since each region GCs its own
  bucket. Deployments that point every region at **one** bucket work too; then every region's GC
  acts on the same versions (deletes are idempotent), and the docs recommend running GC in one
  region only.
- **Marks are per bucket.** The sweep's marks (§11.4) are object tags written in the region's
  own bucket. Where the replication configuration carries tag changes to the replica, a replica
  region's sweep can see a mark the writer region set; that is still sound, because a mark means
  "no row of this table held the version at that time", Global Tables replicate the same rows,
  and a sweep deletes only versions its own bracketed read finds unreferenced.
- **Live replication does not copy pre-existing objects** (Batch Replication does); a region
  added later needs a backfill. The docs state it.

---

## 17. IAM

| Permission | Needed for |
|---|---|
| `s3:PutObject` | `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `CopyObject` target |
| `s3:AbortMultipartUpload` | aborting on failure / interruption |
| `s3:GetObjectVersion` | reads by `VersionId`; `HeadObject` by `VersionId` (store-wide sweep); `CopyObject` source |
| `s3:ListBucket` | so a missing version is `404 NotFound`, not `403 AccessDenied` (F12) |
| `s3:DeleteObject` | the store's cleanup of an object written to an unversioned bucket (§12.2) |
| `s3:DeleteObjectVersion` | rollback, reaper, sweep, purge; the cleanup of a `null` version in a suspended bucket (§12.2) |
| `s3:GetObjectVersionTagging`, `s3:PutObjectVersionTagging` | the sweep's unreferenced-since marks (§11.4) |
| `s3:ListBucketVersions` | sweeps (per-item and store-wide); purge on S3 (lists the family) |
| `kms:GenerateDataKey`, `kms:Decrypt` | SSE-KMS uploads (multipart needs both) and reads |

The guide gives a policy scoped to `arn:aws:s3:::<bucket>/<prefix>*` for object actions and the
bucket ARN with an `s3:prefix` condition for the list actions. An entity's `offload.prefix`
replaces the store prefix for that entity (§3.3), so the policy must cover every such prefix as
well (and any earlier prefix whose objects GC still has to delete).

---

## 18. Out of scope

- Whole-item offload (decision 1; §15).
- Content-hash deduplication (needs reference counting across items).
- SSE configuration beyond passthrough.
- Native GCS, Azure Blob and Cloudflare R2 stores (F16). The contract supports them; none ships.
- A table-wide sweep (Scan joined with S3 Inventory). `gc.sweepStore` (§11.5) finds leaks by
  listing the store instead, one item family at a time.
- Adversarial integrity of offloaded content (the pointer reserves algorithm `0x02`, SHA-256, §5).
- Lazy aggregate reads and `Stream` / handle inputs for aggregate edges (§6.9, §8.4).
- Server-side compression of binary fields (pointer codec bits are reserved for it).
- S3 request counts in consumed-capacity reports (#174 reports DynamoDB capacity only).
- A library re-encoder that migrates existing items into or out of offload (natural writes do
  it; §4.7).

---

## 19. Testing

### 19.1 Unit — schema package

- `test/Crc64Nvme.test.ts`: the check value; empty input; incremental equals one-shot over
  random chunkings; known vectors.
- `test/Sha256.test.ts`: the FIPS 180-4 test vectors; incremental equals one-shot; the key
  derivation of §4.5 is stable (fixed vectors), independent of any `SecureRandom` or `Digest` service in context.
- `test/BlobPointer.test.ts`:
  - encode / decode round trip of every field and length extreme (key 1 / 1,024, version 0 /
    1,024, content type 1 / 255), in both stored forms (`B` bytes; `S` = `~edbp:` + unpadded
    base64url, header `0x48`);
  - every reserved header value refused;
  - bad magic, bad trailer and truncation at every offset refused;
  - `parseHeader` on `0x40`–`0x5F`;
  - `parseBinaryPointerText`: valid text, `~edbp:` with invalid base64url (a
    `ValidationError`), text without the prefix (not a pointer);
  - `isBase64PackedText` widened (all 64 header bytes of layouts `001` / `010`; JSON first
    characters never match);
  - `unpackBytesSync` returns a pointer value for layout `010` and still rejects layout `011+`;
  - **an S-form binary pointer through an older reader**: a binary attribute's
    `Uint8Array` schema decoding an `S` value fails with a `ValidationError` (never decodes to
    the pointer's bytes).
- `test/Packed.test.ts` / `test/External.test.ts`: `EDD-9141` cases; `threshold` default 65,536;
  `ExternalPackedConfig` / `ExternalConfig` brands; the plain `Packed` overload refuses
  `external` at the type level; `PackedConfig` / `ExternalPackedConfig` disjoint (widening is a
  compile error; a union-typed config counts as overflow); `configure` with renames and
  `immutable`; `getExternalFields`; `ExtractOffloadFields` (type tests).
- Entity definition guards: `EDD-9111` (missing field, `Uint8ArrayFromBase64`, string, mixed
  union), `EDD-9142` (each role), `EDD-9143` (a ref schema with and without the offloaded
  field), `EDD-9114` (each option, including `prefix`).
- `aws-free-guard.test.ts` and `node-free-guard.test.ts` still pass.

### 19.2 Unit — effect-dynamodb (mocked `DynamoClient`, in-memory store)

The canonical failure paths, each asserting that **the previous version stays referenced and
the written version is deleted only when the write provably did not commit**, and that
in-doubt outcomes are **kept and reported**:

- **Ledger** (`test/BlobLedger.test.ts`):
  - every row of §6.2's settlement table: `$metadata.attempts` 1, 2 and absent; ALL_OLD with
    and without the pointer, per member kind (plain entity, EventStore snapshot row and
    projection row → rejected; retain / softDelete / timeSeries → in doubt); `NotSent`;
    interruption during the request;
  - `BatchWriteItem`: an item unprocessed by a response whose earlier attempt lost its response
    (`attempts` 2) is **in doubt**, not rejected; unprocessed with every carrying response at
    `attempts` 1 is rejected;
  - `TransactWriteItems` with the library's `ClientRequestToken`: cancellation / validation →
    rejected; `IdempotentParameterMismatch` / `TransactionInProgress` → in doubt; the token is
    the same across SDK retries of one built request and new for a re-planned attempt;
  - a custom `DynamoClient` layer that retries itself (attempts unknown) → every refusal in
    doubt;
  - the lattice (committed after rejected);
  - memo hits, keyed by input identity **and** target key: the same `Uint8Array` put to two
    items uploads twice;
  - a rollback delete that fails, leaving the operation's error unchanged, a `Warning` log entry
    and an observer call;
  - `Offload.layerObserver` receives every unsettled ref (in doubt, failed rollback delete,
    lost `Complete`, a refused store answer) with its entity, attribute and operation;
  - `maxUploadAge`: an upload whose `startedAt` is older than the store's `maxUploadAge` when its
    write is about to be sent fails with `Expired`, sends nothing to DynamoDB and deletes the
    version (`TestClock`).
- **Entity** (`test/Entity.offload.test.ts`, capturing requests):
  - put / create (under, at and over threshold; budget routing largest-first with ties; budget
    unreachable → DynamoDB's diagnosed rejection);
  - create over an existing item (CCF + ALL_OLD without the pointer → deleted);
  - a put over an existing item uploads every offloaded field, including values equal to the
    stored ones;
  - upsert (immutable `if_not_exists`, settled by `ALL_NEW`);
  - `update().set()` (standard and read-merge): named fields always upload (no carry); untouched
    pointers byte-identical; the read-merge `Put`'s wide fallback guard orders offloaded
    attributes first;
  - immutables: equal by checksum → passes and the attribute is **absent** from the write; a
    restated value with the same entries in another key order → structural confirm passes;
    different content → refused; a crafted CRC match with different bytes passes the fast
    path but is dropped from the write (the stored attribute is unchanged);
  - `.remove()`;
  - an item-size rejection retried on the read-merge path with the budget; an append and a
    path-op update are **not** retried (thresholds only, §6.3);
  - `Transaction.transactWrite` (cancel → all deleted; lost race re-planned → memo, superseded
    attempt deleted; planned update's recorded write not settled);
  - `Batch.write` with bound builders uses each builder's captured store and compressor
    registry, not the ambient ones (and the compressor fix holds for packed fields without
    `external`);
  - a `Stream` given to two fields of one put, or to a later operation, → `EDD-9120`;
  - time-series append (one upload keyed by the event SK, same pointer on both items; stale →
    deleted, the append failing with `StaleAppend`);
  - retain snapshot / tombstone / restore copy pointers without uploading (pinned, §6.4);
  - purge (below).
- **Interleavings** (`test/Offload.interleaving.test.ts`, two fibers over one mocked table with
  a scripted step order, the scenarios the removed carry-on-equal rule got wrong):
  - an unversioned entity with a unique constraint: writer A reads the row holding version V1,
    writer B replaces the field with V2, the reaper frees V1, A writes again — A's write
    uploads its own version and never re-points the row at V1;
  - the same over an aggregate edge (diff against a read; the changed group re-uploads);
  - a projection whose fold leaves a field equal to the fetched row reuses the pointer only
    with `#f = :P` in its condition; a concurrent change of the field makes it `LostRace` and
    retry.
- **Reads:**
  - every decoder of #147 §6.3 on rows mixing inline and pointer values, per mode;
  - `asNative` returns the pointer (`B` or `S`); `asRecord` / `asItem` resolve per mode;
  - `select` that omits the field makes zero store calls (call counter), and one that names it
    resolves it;
  - budget window: no fetch past `limit`; `filterBy` + lazy fetches nothing;
  - checksum and size mismatch → `ChecksumMismatch`;
  - `NotFound`;
  - write results from the read cache (zero GETs after a put);
  - `committed: true` on a failed result read;
  - error payloads lazy;
  - `Entity.decodeMarshalledItem` on a **pure definition** (schema package `Entity.make`):
    unpacks packed fields (the #147 gap) and dispatches pointers; lazy handles fail with
    `NotProvided` when no store is ambient.
- **Streaming** (`test/Offload.stream.test.ts`, in-memory multipart simulation and a stubbed
  `S3Client.send`):
  - single PUT and multipart give the **same checksum** for the same bytes;
  - part-size adaptation from `contentLength`;
  - interruption aborts the upload (Abort called, no Complete);
  - a part failure retried;
  - a source failure → `SourceFailed`, nothing written to DynamoDB;
  - a store `put` that fails outright after consuming the stream (in-memory `failures` hook) →
    the operation fails, nothing is written, a reuse of the stream → `EDD-9120`;
  - a `Complete` whose response is lost → the observer's `completeLost`, nothing written;
  - a `BlobHandle` input copies (with and without `copy`); the copy's `VersionId` is checked.
- **Change detection** (`test/Entity.decodeStreamRecord.test.ts`): every row of §10.3,
  including equal checksums with different content sizes → `changed`, and a key-order restatement
  → `changed`; view type and image checks (`EDD-9119`); Lambda base64 images.
- **GC** (`test/BlobGc.test.ts`):
  - the reaper free rules per config — plain (no read), aggregate edge of an entity with
    `retain` (still plain), retain (MODIFY skipped; snapshot TTL REMOVE confirmed against
    other snapshots), softDelete (live REMOVE kept by the tombstone; restore keeps it),
    timeSeries (event TTL REMOVE vs current item; `.update()` version freed), EventStore
    snapshot (direct) and events (none), `confirm: "always"` on an entity whose `retain` was
    turned off with snapshots left;
  - **bracketed confirm-read**: a restore committing between the live-range and tombstone-range
    queries changes the live key between the two `GetItem`s, so the confirm-read retries and
    keeps the version; three busy attempts → retained as `family busy`;
  - **disjoint family ranges**: an entity with sort-key composites whose sibling items'
    snapshots and tombstones interleave the item's own (and legacy rows without an item
    segment) — every holder found, no sibling's version freed;
  - **table-local**: a second table holding copies of the first table's pointers — its reaper,
    sweeps and purge never delete them (`foreign`), and the first table's GC ignores the copy;
  - **every-record view check**: a batch whose first record is an `INSERT` and whose later
    `MODIFY` lacks `OldImage` dies before any delete;
  - duplicate and reordered records;
  - grace waiting (`TestClock`); the 15-minute default;
  - the per-item sweep, two passes (`TestClock`): referenced kept; unreferenced younger than
    `maxUploadAge` + 15 minutes kept unmarked; older marked, kept; marked less than the grace
    ago kept; marked at least the grace ago deleted; a last version with no successor is not
    deleted on the first pass; key-per-write mode; own older-prefix versions listed, foreign
    pointers never listed;
  - `gc.sweepStore`: own families swept; a foreign table's family and an unconfigured entity's
    family skipped; a version without `edd-item` reported unattributable; `startAfter` and
    `maxFamilies` resume;
  - `EDD-9118` for a sweep grace under `maxUploadAge` + 15 minutes and for stores without
    `list` / `marks` / `head`.
- **Purge** (`test/Entity.purge.offload.test.ts`): versions are deleted only after every
  DynamoDB delete succeeded; a partial purge leaves the store untouched; a **concurrent
  `create` and a concurrent time-series `append`** between the row deletes and the store step
  keep their new versions (re-read finds them; young unnamed versions are left for the sweep);
  on a store without `list`, only versions the purged rows named are deleted.
- **Aggregates** (`test/Aggregate.offload.test.ts`):
  - an unchanged group uploads nothing (diff before upload);
  - a changed group re-uploads its offloaded fields (no read-pointer reuse);
  - routing and upload happen after `buildDynamoItems`, on the stored attribute names;
  - per-group settlement;
  - eager assembly;
  - `EDD-9142` for edge composites;
  - `EDD-9143` for a `many` element wrapping a ref that copies an offloaded field (binary,
    overflow, unannotated, in a sub-aggregate) and its subset-model acceptance (commit 4,
    `test/Offload.config.test.ts`).
- **EventStore** (`test/EventStore.offload.test.ts`):
  - append, inline snapshot, `writeSnapshot` (lost race → ALL_OLD without the pointer →
    deleted);
  - `commandHandler` retry with memo;
  - `measureAppend` makes no uploads and reports `offloaded`;
  - every read path of #147 §7.3 with pointer rows, eager by default, `Query.offloaded` on
    `query.events`;
  - raw rows;
  - `decodeStreamImage` lazy by default (`LazyStreamEvent`) and eager on request; the same for
    `EventProjection.processBatch`, `MultiProjection`, `EventStore.processBatch` /
    `runChangeFeed`;
  - the bind and first-operation checks (`EDD-9115`), including `bindProjection` and
    `processBatch`;
  - projection poison-record exclusion for `BlobStoreError`.
- **Geo** (`packages/effect-dynamodb-geo/test/GeoIndex.offload.test.ts`): `nearby` resolves
  overflow and binary fields eagerly and decodes packed fields (the #147 gap); `GeoIndex.put`
  of a binary field; `GeoIndex.bind` without a store → `EDD-9115`.
- **Bind:** `EDD-9115` from `DynamoClient.make`, `Entity.bind`, `Aggregate.bind`,
  `EventStore.bind`, `bindProjection`, `GeoIndex.bind`; precedence (explicit > ambient at bind >
  ambient at run time; a bound builder's captured store inside `Batch` / `Transaction`);
  `NotProvided` from unbound ops; the codec check now also on `Entity.bind` / `Aggregate.bind`
  (debt fix).
- **Key text** (§11.10): `EDD-9146` from every bind site of every member kind, before the store
  check, on a schema without `escapeKeys: true`, and from an unbound write's routing (nothing
  uploaded or sent); `rekey` over rows offloading wrote moves nothing under the same setting, and
  with `escapeKeys` turned off (offloaded declarations removed) refuses each kind of pointer row —
  live item, snapshot, tombstone, event item, aggregate edge row, event and snapshot of a stream —
  naming its key, a dry run included, writing nothing.
- **`insert()`** (§6.2, §6.5): routes and uploads as `put`; a duplicate item
  (`DuplicateItemException`, sent once) and a cancelled sentinel transaction roll the uploads
  back; a statement whose outcome is unknown (a transport failure after the request was sent, or
  a duplicate reported after an SDK resend) keeps them and reports them unsettled; the
  `ExecuteTransaction` carries the library's `ClientRequestToken`.
- `test/StorageEncoding.test.ts`: `pointer` on both stored forms; `decode` resolving through the
  ambient store with the `ValidationError` cause on failure; `*Sync` refusal.
- `test/blob-s3-subpath-guard.test.ts`.

### 19.3 Types

- `test/Offload.types.test.ts`:
  - `View` under every mode, including optional and nullable fields;
  - `.offloaded()` re-types `get` / queries / collections / CRUD returns, in every order with
    `select`, `returnValues`, `limit` and `filter` (e.g. `returnValues("ALL_NEW")` then
    `.offloaded({ overflow: "lazy" })`, and the reverse; `limit` then `offloaded`);
  - `Entity.offloaded` / `Query.offloaded` in data-first and data-last forms, including
    `query.events`;
  - an entity without offloaded fields: every builder's type and error union is identical to
    today's, with and without the trailing `O` parameter in annotations;
  - `BinaryInput` on put / update;
  - `ReadBlobErrors` / `WriteBlobErrors` per mode — a binary-only entity's default reads keep
    today's errors;
  - `PackedPath` for External fields;
  - `Batch.get` / `transactGet` unions;
  - `Batch.write` / `Transaction.transactWrite` / `EventStream.append` with `additionalItems`:
    an offloading op adds `BlobStoreError`, a non-offloading one adds nothing, an `any`-typed
    array adds nothing;
  - `decodeMarshalledItem` overload for offloading entities;
  - `GeoIndex.put` / `nearby` error unions;
  - `EventStream` / aggregate error parameters.
- `test/ErrorChannels.types.test.ts`: every existing pin unchanged for non-offloading members.
- `packages/schema/test/EntityOffload.types.test.ts`: a sharded index's `shards.by` on an offloading entity
  completes and checks its names as on any entity (a misspelled name is an error); naming an
  `External` field there is refused at `Entity.make` (`EDD-9142`, run time, as for every other
  key position of an offloaded field).

### 19.4 Connected (mandatory — gate 4) — MinIO beside DynamoDB Local

- **CI.** `.github/workflows/ci.yml` adds a service container (`command:` is supported for
  services; a `docker run -d -p 9000:9000 … server /data` step is the fallback):

  ```yaml
  minio:
    image: cgr.dev/chainguard/minio@sha256:<pinned digest>
    command: server /data
    env: { MINIO_ROOT_USER: minioadmin, MINIO_ROOT_PASSWORD: minioadmin }
    ports: [ "9000:9000" ]
  ```

  plus a wait loop on `/minio/health/live`, and `S3_ENDPOINT: http://localhost:9000` for
  `test:connected`.
- **Locally.** `docker run -d --rm -p 9000:9000 cgr.dev/chainguard/minio server /data`.
- **Test setup.** Each connected file reads `S3_ENDPOINT` through `Config`, never `process`,
  probes it, and `describe.skip`s when unreachable, as `DYNAMODB_ENDPOINT` is handled today.
  Setup creates buckets with the SDK (`CreateBucket`, `PutBucketVersioning Status=Enabled` —
  test setup, not a library pre-check; `forcePathStyle: true`).
- **No AWS-specific error codes** are asserted (F15).

`test/connected.blob-s3.test.ts` (store level):

- versioned put / get / ranged get / delete by version / list / head / copy;
- marks: set, get and clear through version tags, preserving another tag on the version;
- an **unversioned bucket** and a **suspended bucket** are refused (`Unversioned`), leaving no
  object behind; a suspended bucket's cleanup leaves no delete marker;
- `CopyObject` into an unversioned bucket is refused the same way;
- single PUT and multipart of the same 11 MB give the same CRC64NVME, equal to the library's
  value and to the one S3 returns;
- a wrong checksum is rejected;
- a store-side outright upload failure (a part upload refused by a bucket policy denying
  `PutObject` on the key) fails the put with no completed upload;
- interruption mid-multipart leaves no upload in `ListMultipartUploads`.

`test/connected.blob-offload.test.ts` (end to end):

- an entity with an overflow field (under / over threshold, zstd) and a binary field
  (`Uint8Array` and a 12 MB `Stream`), stored as `B` and `S` respectively;
- put, get (eager / lazy), query with `select` omitting the field (no GET, asserted through a
  counting store wrapper), `update().set()`, conditional create over an existing item (written
  version deleted, previous still readable);
- `transactWrite` cancellation (all deleted), `Batch.write`, time-series append (stale →
  deleted);
- retain + softDelete + restore keep pointers resolving;
- an entity with sort-key composites and interleaved sibling items: `gc.sweep` and the
  reaper's confirm-read keep every version the item's snapshots and tombstones hold, and free
  none of a sibling's;
- two tables sharing one bucket, the second holding copies of the first's rows: GC on each
  never deletes the other's versions;
- purge empties the item's own family prefix; a `create` racing the purge keeps its version;
- an aggregate with an offloaded edge field;
- an EventStore stream with external `data` and an external inline snapshot, read through
  `read`, `readLatest`, `readIndex` and raw rows;
- a geo entity with an offloaded field through `nearby`;
- `decodeStreamRecord` and `gc.reap` over records built from items fetched with the raw client
  and rewritten into Lambda's DynamoDB-JSON shape (as #147 simulated stream records; no
  Streams dev dependency);
- `gc.sweep` (two passes, with marks as MinIO version tags) after a simulated crashed rollback,
  and `gc.sweepStore` over the bucket.

Canonical GSI-composite shapes: **not applicable** — the composer is untouched (§15), and the
guard tests prove an offloaded field cannot enter a composite.

### 19.5 Doctest / examples

`examples/guide-blob-offload.ts` (runs against DynamoDB Local + MinIO; skips the S3 sections
with a message when `S3_ENDPOINT` is unset, through `Config`) with regions for: configuring
both field kinds and the budget; the layers (with `maxUploadAge` and an observer); put with a
stream; lazy handles (`read`, ranged `stream`, `presignedUrl` with an injected presigner);
`.offloaded()`; `decodeStreamRecord`; `BlobGc` reaper, sweep and `sweepStore`.
`pnpm --filter @effect-dynamodb/doctest test` verifies the MDX snippets.

---

## 20. Documentation and examples

| Artifact | Change |
|---|---|
| `examples/guide-blob-offload.ts` (new) | §19.5 |
| `guides/blob-offload.mdx` (new, under Guides) | backed by the example: when to offload (item limit, write cost, binary); the two field kinds and thresholds; item budget; the layers, `maxUploadAge`, the observer and IAM policy (incl. `offload.prefix` overrides); consistency model (versioning, settlement rules, in-doubt and how leaks are found); which pointers a write may carry (restated content re-uploads; `update().set()` for one field); reads and modes; handles (presign expiry vs reaper grace); streams and change detection (`rewritten` is probable, not proven); GC (table-local ownership, reaper and its grace in Lambda, `confirm: "always"`, two-pass sweep, `sweepStore`, purge, lifecycle table, PITR and table copies); Global Tables; rollout order and its caveats (§22); limits (versions per key, unsupported bucket settings) |
| `astro.config.mjs` | a sidebar entry for the new guide beside "Packed Storage" (the sidebar is manual) |
| `guides/packed-storage.mdx` | pointer to the new guide (`external`), the widened dispatch table |
| `guides/streams.mdx` + `examples/guide-streams.ts` | lazy `decodeMarshalledItem` (and its typed overload / shape change), `decodeStreamRecord`, `NEW_AND_OLD_IMAGES`, `NotFound` from a lagging consumer |
| `guides/change-feed.mdx` | `EventStore.processBatch` / `runChangeFeed` hand `LazyStreamEvent`s for streams with external `data`; the reaper as a batch processor beside existing consumers |
| `guides/projections.mdx`, `tutorials/projections.mdx` | handlers over streams with external `data` receive `LazyStreamEvent`s; the `{ offloaded: "eager" }` option; `BlobStoreError` is never a poison record |
| `tutorials/event-sourcing.mdx` | a short "large event payloads" note linking the guide |
| `guides/lifecycle.mdx` | retain / softDelete / restore share offloaded versions; turning either off needs `reaper.confirm: "always"` while history rows exist |
| `guides/timeseries.mdx` | event-keyed objects; events without `ttl` keep their objects forever |
| `guides/aggregates.mdx` | offloaded edge fields: eager reads, `Uint8Array` inputs, a changed group re-uploads |
| `guides/geospatial.mdx` | `nearby` resolves offloaded fields eagerly |
| `guides/modeling.mdx` | `storedAs` options list gains `External` |
| `guides/testing.mdx` | `BlobStore.memory` (versioning modes, `failures`, `inspect`, `TestClock`), MinIO for connected tests |
| `reference/api-reference.mdx` | `BlobStore`, `Offload`, `BlobGc`, `effect-dynamodb/blob/s3`, `DynamoModel.External`, `Packed({ external })`, `BlobStoreError` |
| `DESIGN.md` | §7 "Offloaded Storage" summary, §15 taxonomy row (`BlobStoreError`) and "Declared Errors per Operation" paragraph, EDD band and registry rows 9111, 9114–9120 and 9141–9143 (this commit); §12 EventStore paragraph and the per-operation table rows (implementation commits) |
| `CLAUDE.md` | module structure (`BlobStore`, `Offload`, `BlobGc`, `blob/s3`), quality gate 4 mentions MinIO, test counts |
| `README.md` | feature list |
| changeset | `minor`, all four packages; `pnpm changeset version` in the PR |

---

## 21. Implementation plan

Ordered commits on `feat/179-s3-offload`. Each is independently green: `pnpm lint`,
`pnpm check`, `pnpm test`, and — for every commit touching Entity, Query, Collection,
Transaction, Aggregate, EventStore, Errors or `internal/` — `test:connected` against
DynamoDB Local (and MinIO from commit 15 on).

**No intermediate commit can write a value it cannot read or settle.** From commit 4 until
commit 13, a member configured with `external` / `External` is refused at `Entity.make` /
`makeStream` with a "not yet supported" message. Tests of the commits in between lift the
refusal through an internal, test-only gate (`internal/OffloadGate.ts`, a `Context.Reference`
not exported from any entry point). Every ledger root is wired in commit 6, before any write
path can upload, so no write path ever runs without settlement. Commit 13, the last that wires
a write path, deletes the gate.

1. **Design** — this document, the `DESIGN.md` summary and registry rows.
2. **Checksums and hashing** — `schema/src/internal/Crc64Nvme.ts` and `internal/Sha256.ts`
   (vendored, pure JS), tests (CRC check value and a cross-check against `@aws-sdk/crc64-nvme`,
   added as a dev dependency of `effect-dynamodb`; the SHA-256 FIPS vectors).
3. **Pointer codec** — layout `010` encode / decode in `schema/src/internal/BlobPointer.ts`,
   both stored forms (`B`, and the `~edbp:` `S` form with `parseBinaryPointerText`),
   `parseHeader` / `unpackBytesSync` / `isBase64PackedText` changes. Every runtime site still
   treats a pointer as an unsupported value (`ValidationError`, a clearer message): no behaviour
   change for stored data. The one read path this does not reach is `GeoSearch.nearby`, which
   does not unpack at all (the #147 gap, §8.4); item 12 routes it through the entity's decoder.
   Offload stays refused outside the test gate until item 13, so no user write can store a
   pointer meanwhile.
4. **Config surface** — `Packed({ external })` overloads (and `external?: never` on the plain
   one), `External`, `configure`, `ExtractOffloadFields`, `offload` on `Entity.make` /
   `makeStream`, guards `EDD-9141`, `EDD-9111`, `EDD-9142`, `EDD-9143`, `EDD-9114`, `BlobStoreError` (12 reasons),
   `ReadBlobErrors` / `WriteBlobErrors`; the "not yet supported" refusal and the test gate.
   *Implementation notes (commit 4):* the gate lives in the schema package
   (`packages/schema/src/internal/OffloadGate.ts`, reachable only through the `internal/*`
   subpath), because the pure and the runtime `Entity.make` share one derivation
   (`buildEntityDefinition`) and `makeStream` imports it from there. `Entity.make` and
   `makeStream` are synchronous, so the refusal reads the `Context.Reference` from the current
   fiber (`Fiber.getCurrent()?.getRef(OffloadGate)`, `false` outside one); tests define
   members inside `Effect.runSync(Effect.sync(define).pipe(Effect.provideService(OffloadGate,
   true)))` (`test/helpers/OffloadGate.ts` in both packages). Every guard (`EDD-9072`–`9075`,
   `EDD-9141`, `EDD-9111`, `EDD-9142`, `EDD-9143`, `EDD-9114`, `EDD-9079`) runs before the refusal, so guard tests need no gate. The
   refusal is a plain `Error` with no EDD code: it is never released, and commit 13 deletes it.
   `entity.offload` is `undefined` for an entity that offloads nothing. A stream validates
   `offload` here but does not expose it until the commit that wires its writes (13); its
   `storedAs` already reports `external`. The aggregate guards cover the edge item schemas
   (`EDD-9111` for a `many` element that redeclares an `External` field, `EDD-9142` for a
   discriminator or `many` sort-key composite) and, at any depth, `Aggregate.ref` edges and the
   ref a `many` element wraps (`PlayerSheet { player }`, `EDD-9143`); hydrating a `one` /
   `many` edge's offloaded fields is commit 11's. The wrapped ref is found by name — the
   element field `deriveEntityFieldName(entity)` names, as hydration and
   `deriveElementInputSchema` find it — whether or not it is `DynamoModel.ref`-annotated: its
   hydrated copy is a nested map in the edge item, which no routing reaches. An element that
   *is* the entity is the edge item's own attributes, covered by `EDD-9111` / `EDD-9142` and
   the entity's own routing.
   *Review fixes (commit 4):* `PackedConfig` and `ExternalPackedConfig` are disjoint (§3.1, a
   deviation), so widening an overflow config to `PackedConfig` is a compile error and
   `ExtractOffloadFields` counts a union-typed config as overflow (§9.1). The `_injectIndex`
   hook had no caller in the library (collections moved to entity indexes), so
   `Collections.buildMemberIndexDef` and its tests are deleted (adjacent #147 debt).
   *Rebase onto 1.37 (#171):* the hook itself stays — #171 gave it the `EDD-9090` refusal of a
   Z-order index and tests that call it — and it runs the `EDD-9142` `externalIndexRefusal`
   beside the packed `EDD-9072` one, in both packages, so the registry rows keep naming
   collection-injected indexes. The two
   refusals (and the definition-time guards beside them) match composites, sparse fields and
   discriminators by own key (`Object.hasOwn`): `in` also matched names `Object.prototype`
   defines (`valueOf`, `constructor`, …). Until item 7, `_packedFields` leaves `External`
   fields out, so `EDD-9076` / `EDD-9077` do not yet cover them — harmless while the gate
   refuses every offloading member.
5. **BlobStore contract + in-memory store + `Offload` types** — `BlobStore.ts`, `Offload.ts`,
   key derivation (`internal/BlobKeys.ts`, vendored SHA-256), metadata builder,
   `maxUploadAge`, capabilities (`list`, `head`, `marks`), `EDD-9116`.
   *Implementation notes (commit 5):* the public modules are `src/BlobStore.ts` (the service with
   `layer`, `memory`, `layerMemory` and `crc64nvme` — `crc64nvme(bytes)` one-shot,
   `crc64nvme.make()` incremental — re-exporting the contract types, `BlobRef` / `BlobChecksum`
   and `BlobStoreFailure`) and `src/Offload.ts` (modes, `OffloadedValue` / `BlobHandle` with
   their type ids and guards, `View`, `ResolveModes`, `OffloadState` / `NoOffloadState` /
   `ViewOf`, re-exporting `OffloadFields` / `NoOffload` / `ExtractOffloadFields` and the blob
   error helpers). The barrel exports `BlobStore`, `BlobStoreFailure` and the contract types
   directly and `Offload` as a namespace. The internals are `internal/BlobStoreContract.ts` (the
   contract, `BlobStoreFailure`, defaults and the `EDD-9116` checks, which the S3 store of
   commit 15 reuses), `internal/MemoryBlobStore.ts` (§12.3), `internal/BlobKeys.ts` (§4.5) and
   `internal/BlobMetadata.ts` (§4.6, builder and parser), all in core — their callers are core's
   write paths and GC, so the key derivation's fixed vectors are in core's
   `test/BlobKeys.test.ts` rather than the schema package's SHA-256 test (§19.1) — and
   `internal/OffloadValues.ts`, whose `OffloadedValue` / `BlobHandle` constructors are for the
   read path (commit 6) and are not exported. `BlobStore.layer` checks a store when it is called,
   as `Compression.layer` does, and `BlobStore.memory` its options and its result. Beyond
   §14.3's `limits` and `maxUploadAge`, a custom store must have a non-empty `name`, a prefix
   that passes the store-prefix rule, `limits.maxVersionBytes` ≤ 1,024 (the pointer's bound),
   `limits.maxKeySuffixBytes` ≤ 670 (1,024 − the longest prefix, 256, − the hashed `P/F/O`, 98,
   so every key fits a pointer), a *finite* `maxUploadAge` (GC adds 15 minutes to it), positive
   integer concurrencies, `put` / `get` / `delete` functions and well-formed optional
   capabilities; other properties are allowed (the memory store's `inspect`). `BlobSourceFailure`
   is defined in §12.1. Nothing calls the store, the keys or the metadata yet — no write path
   uploads until commit 7, and offloading members stay refused — and the spans around store
   calls and the `BlobStoreFailure` → `BlobStoreError` wrapping are their callers' (commit 6).
   `Offload.source` (10), `Offload.layerObserver` (6), `Offload.compareStored` (14),
   `DynamoClient.make({ blobStore })` (6–7) and run-time mode resolution with `EDD-9117` (8) are
   not in this commit.
6. **Ledger + resolver** — `internal/BlobLedger.ts` (entries, memo by identity and target key,
   lattice, exit, `maxUploadAge` → `Expired`), settling at `Capacity.client` per §6.2's table
   (library `ClientRequestToken`s, `$metadata.attempts`, ALL_OLD evidence), `Warning` logs and
   `Offload.layerObserver`, `detachContext`; **every root wired**: entity CRUD terminals,
   `Batch.write`, `Transaction.transactWrite`, aggregate operations, `EventStream.append` /
   `commandHandler` / `writeSnapshot`, projection writes, `GeoIndex.put`.
   `internal/BlobResolver.ts` (two-phase decode, read cache, verification). Unit-tested with
   synthetic ops.
   *Implementation notes (commit 6):* three internal modules, none importing the AWS SDK —
   `internal/BlobCalls.ts` (new: every store call in an `effect-dynamodb.BlobStore.<action>`
   client span, its `BlobStoreFailure` wrapped as a `BlobStoreError` with the operation's
   context; a store failing with anything else is `Rejected` with that as the cause),
   `internal/BlobLedger.ts` and `internal/BlobResolver.ts`. `Offload.layerObserver` and the
   `UnsettledUpload` / `UnsettledReason` / `ObserverOptions` types re-export the ledger's, so
   `Offload.ts` stays AWS-free (the import-graph guard of `test/BlobStore.test.ts` holds). The
   ledger is a `Context.Reference`; `Capacity.client`'s instrumented view hands a write request
   to `BlobLedger.guard` only when the fiber's ledger is open and holds entries, so a ledger
   that uploaded nothing costs nothing per request. `BlobLedger.upload` takes buffered content
   (the stream memo and `EDD-9120` are commit 10's) and computes its CRC-64/NVME itself — the
   memo key and the pointer — plus the body's for a compressed body. The roots:
   `EntityOps`' put / update / delete terminals and `Entity.append`, each gated on
   `entity.offload !== undefined` (an entity that offloads nothing pays nothing); and,
   unconditionally (one object and one finalizer), `Batch.write`, `Transaction.transactWrite`
   (its planning and its send in one ledger), `Aggregate` create / update / delete,
   `EventStream.append` / `writeSnapshot` (the public methods, bound and unbound),
   `commandHandler` (load, decide, append and retries) and the projection engine's `withRetry`
   (one row's read-fold-write). `GeoIndex.put` — bound and unbound — runs the entity's put
   terminal, which is its root. `Capacity.detachContext` and `Capacity.detached` clear the
   ledger. `DynamoClient.make({ blobStore })` (all four overloads) bundles a store into the
   client's captured context, validated with `EDD-9116`; an explicit store wins over one in
   context at bind time, which is captured otherwise (the `EDD-9115` bind checks are
   commit 7's). The resolver's placeholders (`PendingBlob`) and `resolveRows` / `resolveAll`
   are ready for commit 8's decoders: eager values are fetched at the store's
   `readConcurrency` (the ledger's read cache first; a copy of cached bytes is returned, and
   fetched bytes are handed out uncopied — the `get` contract now says a store's chunks are
   handed over), the read failing as soon as it runs past the pointer's object size, then
   verified (object size, then content size and CRC-64/NVME after decompression), decompressed
   and `JSON.parse`d; a lazy value captures the resolving fiber's store and compressor registry
   but never its ledger, fetches and verifies on every `read()` (errors name
   `<operation>.read`), serves ranged reads unverified, and verifies a whole `stream()` as it
   ends; `presignedUrl` defaults to 15 minutes. `inlineOffloadedValue` / `inlineBlobHandle`
   build the lazy forms of values stored inline. A failure after a verified fetch (no
   compressor, a decompressor that throws, content that is not UTF-8 JSON) is a
   `ValidationError`; size and checksum mismatches are `ChecksumMismatch`; a missing store is
   `NotProvided`. No write path uploads and no decoder resolves yet, so nothing user-visible
   changes: the refusal and the test-only gate stay.
   *Deviations (commit 6):*
   - Whole-request refusals of a `TransactWriteItems` / `BatchWriteItem` the SDK sent once
     are `rejected` (§6.2's table gains the row): DynamoDB applies nothing of a request it
     refuses, exactly as for a single-item write.
   - A `BatchWriteItem` response settles per pointer, not per request: `UnprocessedItems`
     holds copies of the requests it left, so a pointer is `committed` when more of the call's
     put requests carried it than were left (some processed request wrote it), and only a
     pointer every carrying request left takes the unprocessed rule. No path sends one
     pointer twice in a call today; this keeps the rule from drifting once later commits copy
     pointers.
   - A `TransactWriteItems` refusal proves the write did not commit only when it carries a
     token **this ledger** generated (`Ledger.tokens`); a caller-set token is kept and leaves
     the entry `inDoubt`. The library sets none itself, so this only guards a future caller.
   - `ReturnValuesOnConditionCheckFailure: "ALL_OLD"` is added at the choke point, to a
     single-item write that carries a ledger pointer and does not set it, rather than by each
     builder; a caller's own setting is kept (and a `ConditionalCheckFailed` without `ALL_OLD`
     is `inDoubt`).
   - The store's `put` answer is checked before it is trusted: its ref must extend the
     requested key by at most `limits.maxKeySuffixBytes`, its version fit
     `limits.maxVersionBytes`, its `size` equal the body's length, and the ref be new to the
     ledger — else `BlobStoreError { reason: "Rejected" }`. A ref in the requested key that
     breaks a limit or misreports the size names what the store wrote for this upload: it is
     registered as `pending` first, so it is rolled back like any other. An answer with no
     ref, a ref outside the requested key, or a ref already returned for another upload names
     nothing this upload provably wrote — deleting it could delete another row's committed
     version (§6.2: a rollback deletes only versions no committed row can name) — so it is
     neither recorded nor deleted; the requested key is reported at exit with the new observer
     reason `answerRefused` (no ref), for `gc.sweep` / `gc.sweepStore` to reclaim the version
     the store actually wrote.
   - `UnsettledReason` gains `answerRefused` (above), and every upload whose version no entry
     names — `answerRefused`, and `completeLost` reported inside an open ledger — is reported
     when the root exits, with the rest, as `onUnsettled`'s contract says ("after the
     operation that made it exits"); `reportCompleteLost` outside a ledger still reports at
     once.
   - Uploads run at the store's `writeConcurrency` per ledger (a semaphore per store), not
     per process.
   - A memoised upload older than its store's `maxUploadAge` that nothing committed (`pending`
     or `rejected`) is not reused: a fresh upload replaces it, and the stale one is deleted at
     exit. Reusing it would fail every later request with `Expired`.
   - Transaction planning's recording client is marked (`Capacity.markRecording`): its
     recorded writes are neither prepared nor settled — the transaction that sends the plan
     is. (§6.2's "Not sent" row still applies to a client failure marked `NotSent`.)
   - Roots: a projection row, not a projection's batch (each row's write is the only request
     carrying its uploads, so a batch root would only hold them, and their cached content,
     longer); `EventStream.writeSnapshot` is a root too; `GeoIndex.put` needs no root of its
     own.
   - `Expired` reaches the caller as a `BlobStoreError` from the raw client call, outside
     `DynamoClientService`'s static error type; commit 7 declares it on the write paths that
     upload (`WriteBlobErrors`) and lets it through their catch-alls and failure diagnosis.
7. **Entity writes** — put / create / upsert / update (both paths): named fields always upload,
   untouched pointers pinned, budget routing, the size-rejection retry on the read-merge path
   only (not append or path-op updates); immutables (checksum fast path, structural confirm,
   passing value dropped from the write); time-series append (event-keyed); lifecycle copies;
   write results; `TOffload` through `Entity` / `BoundEntity` / `TypedClient` (and the
   doc-comment debt); bind checks `EDD-9115` incl. `Entity.bind` / `Aggregate.bind` (and their
   missing `EDD-9078` check). **The `EDD-9076` / `EDD-9077` extension to `External` fields**
   (§14.3, §15, decision 47): `externalFields` feed the walker that reads only packed fields
   today — the entity's `_packedFields` / `_packedGuards` (conditions, filters and projections:
   `packedExprRefusal` / `packedProjectionRefusal` in `Query.ts`, the CRUD builders and
   `Transaction.ts`) and the update-op refusals in `Entity.ts` — with messages that say
   "packed or External"; and `TPackedFields` gains the binary fields (§9.1), so their paths are
   `PackedPath`s. Only the guards: the packed codec and stored-form dispatch stay packed-only.
   Item 8's read paths inherit the walker.
   *Implementation notes (commit 7):* the write side is `internal/OffloadWrite.ts` (no AWS SDK
   import): per member, stored attribute → config for both kinds; `route` (thresholds, every
   binary value, then the budget loop of §6.3 sorting by `attributeBytes` of the stored value —
   the attribute name is not counted — ties by stored name, each pointer at its bound: the real
   key plus `limits.maxKeySuffixBytes`, a `limits.maxVersionBytes` version, the largest content
   size while a compressed value's is unknown); `setValues` for an `UpdateItem`'s `SET`s
   (thresholds only, one `route` of them all); the eager read-back of a write's result; the
   checksum fast path of an immutable; and the `EDD-9115` requirement builders. Uploads run on
   the packed, stored-name item just before marshalling — after every local guard, the
   tombstone read and the immutable checks, so a refused write uploads nothing — and an
   upload's object key is the row's (live SK for both family and row, the event SK as the row
   of a time-series event). `route` builds every upload of a write before starting any, runs
   them concurrently, and fails only once all have settled (`forEachSettled`, §6.2): an upload
   already sent is never interrupted by a sibling's failure. The ledger computes each
   content's CRC-64/NVME once (`UploadSpec.metadata` may be a builder given it), for the memo
   key, the pointer and the object metadata.
   The update paths (`runUpdate`, both branches) and `upsert` record each offloaded `:value` as
   they build the request and upload once it is otherwise built. A size rejection of the
   standard `UpdateItem` under an `itemBudget` (and with no path operation) raises an internal
   `OffloadSizeRetry`, which `runUpdateSized` (every caller of `runUpdate`: `update`,
   `patch`, `updateOrCreate`, the guarded upsert) turns into one forced read-merge run; the
   retry reuses the first attempt's uploads of the same content through the ledger's memo. A
   plain `upsert` rejected for size runs the guarded upsert with that forced read-merge (a
   missing item is then created by a routed put). On the read-merge path a restated offloaded
   immutable that passed is put back to its stored value on the merged item and left out of
   the "named" set, so the diff drops it; only named, non-cleared offloaded attributes route.
   Every write result (put / create / upsert / update / patch / delete `allOld` / restore /
   append's `current`) resolves its pointers eagerly — this operation's uploads from the
   ledger's read cache, any other pointer fetched — with `committed: true` on a failed fetch;
   `delete` passes a `BlobStoreError` through rather than wrapping it in
   `DeleteAppliedButUnreadable`. `Entity.bind` gains the `EDD-9078` codec check and both binds
   the `EDD-9115` check, named by entity type there and by the client key in
   `DynamoClient.make`; `Aggregate` records `_offloadByType` (edge entity type → offloaded
   fields of its items) and `_name` for them. `TOffload` is carried by a type-only optional
   member, `_offloadFields?: TOffload` (never set), on `Entity` and `EntityDefinition`: an
   unused type parameter cannot be inferred by `TypedClient`'s `infer` patterns, and a
   conditional use (`WriteBlobErrors<TOffload>`) is not a reliable inference site.
   `TypedClient` passes it to `BoundEntity` only — `scan`, `EntityIndexAccessors` and
   `BoundQuery` gain it with the read types (commit 8). The schema package's `_packedFields`
   lists External fields too. Restore uploads nothing and runs outside a ledger root.
   Unit tests are `test/Entity.offload.test.ts` (requests captured from the in-memory tables)
   and `test/Entity.offload.types.test.ts`; `test/connected.entity-offload.test.ts` checks
   settlement against DynamoDB Local's own answers (`ALL_OLD` on a refused create, `ALL_NEW`
   after `if_not_exists`, the 400 KB rejection that triggers the read-merge retry, a cancelled
   append) with the in-memory store; S3 and MinIO end to end stay item 17's.
   *Owner decisions applied in commit 7 (2026-11-14):* offloading requires `escapeKeys: true`
   (§11.10): `DynamoClient.make`, `Entity.bind` and `Aggregate.bind` throw `[EDD-9146]` before
   the store check, and `route` refuses an unbound write (`OffloadRow.escapeKeys`, a required
   field every later write path supplies) with the same code as a `ValidationError`. Rekey's
   backstop is `refuseMovingPointerRow` in the entity's `moveItem` / `moveHistoryRow`: judged on
   the consistent read the move acts on (dry run included), before anything is written, by the
   first attribute holding a well-formed pointer in either form at any depth, whatever the
   entity now declares (`BlobLedger.pointerAttributeOf`); the member raises
   `Rekey.PointerRowRefusal` as a defect (its error channel is the client's) and `Rekey.run`
   turns it into its `ValidationError`, naming the row's key. Valueless rows hold no values,
   so they move as before. `insert()` routes and uploads before `runInsert` and decodes the
   written values; the ledger scans `ExecuteStatement` / `ExecuteTransaction` parameters (not a
   `SELECT`'s), gives an `ExecuteTransaction` its token, and settles them by §6.2's table.
   *Deviations (commit 7):*
   - Write results resolve **both** kinds eagerly and keep today's result types: the lazy
     binary default and the `View` result types are commit 8's, and a lazy value cannot be
     typed as the model's `Uint8Array` meanwhile.
   - Error payloads that carry the stored item (the `current` of `ConcurrentModification`,
     `ConditionalCheckFailed` and `StaleAppend`) are decoded without store I/O (§6.13): an item
     holding a pointer gives `Option.none()` until commit 8's lazy handles can stand in for it.
     Only a pointer does: a stale append's `current` that fails to decode for any other reason
     (a corrupt item) still fails with `ValidationError`, as for an entity that offloads
     nothing.
   - A **binary** immutable that fails the checksum-and-size fast path is refused without
     fetching the stored value: bytes have no other equality, and a size or CRC-64/NVME
     mismatch proves the bytes differ. Only an overflow immutable is confirmed by a fetch and
     the key-order-insensitive comparison.
   - Transaction planning runs the update path, so a planned update of an offloading entity
     uploads (and the transaction's root settles it), but a `BlobStoreError` raised while
     planning is still a defect (`isPlanUpdateError`): typing it is commit 9's, with
     `Transaction.transactWrite`'s error union. `Batch.write` and transaction puts do not
     route yet (commit 9); aggregate writes do not (commit 11).
8. **Entity reads** — all decoders, the trailing `O` state on every builder, `.offloaded()` on
   `BoundGet`, `BoundQuery` and CRUD builders, `Entity.offloaded` / `Query.offloaded` duals,
   `Query<A, E, O>` / `BoundQuery<…, O>`, page prefetch in `examinePage`, raw-row hook, scans,
   collections, `Batch.get` / `transactGet` typing, `decodeMarshalledItem`'s typed overload and
   the pure-definition fallback (normalise + unpack + pointer dispatch), `EDD-9117`.
   *Implementation notes (commit 8):* the read side is `internal/OffloadRead.ts` (no AWS SDK
   import) and the type helpers `internal/OffloadTypes.ts`. Each member builds a `ReadPlan` once
   (its dispatch-eligible and bytes attributes, offloaded attribute → kind, content types and a
   per-field decoder for lazy overflow reads); `loadRows` unpacks a batch of rows in one pass —
   packed values to their JSON wire form, pointers to `PendingBlob`s, inline values of lazily
   read fields to inline handles — then resolves every placeholder of the batch together
   through `resolveAll` in the operation's modes. Rows a page prefetch already loaded are
   marked (a `WeakSet`), so the per-row decoder only schema-decodes them. Schema decode runs
   over `lazyReadSchema(base, lazyFields)`: the read schema with each lazily read field
   accepting its `OffloadedValue` / `BlobHandle` (`Schema.declare`), cached per base and field
   set. The modes reach a decoder explicitly (the query decoder's second argument, the
   prefetch's options, `_decodeRecord(raw, modes, operation)`) or, for entity operations,
   through the `CurrentReadModes` `Context.Reference` that `withReadModes` sets around every
   operation of an offloading entity (`_offloadModes` on the unbound ops, `offloadModes` on
   `UpdateState`). Parsing — `parseModes` for builders and duals (throws `[EDD-9117]` for an
   unknown mode or key, and for `.offloaded()` after `.filterBy()`), `parseModesOption` for
   option-taking calls (`decodeMarshalledItem`: a `ValidationError` whose cause names
   `EDD-9117`) — resolves an argument over the builder's current modes, so a string sets both
   kinds and an object the kinds it names, in any order with `select`, `returnValues`,
   `limit` and `filter`. `examinePage` loads each window (the rows `limit` can still take, the
   whole response under `filterBy`) before decoding it; `count()` loads nothing without
   `filterBy`. A raw projection runs the raw-row hook over the window in raw mode (wire forms;
   a lazy overflow value's `read()` returns its wire form), and a projection naming no
   offloaded, packed or bytes attribute installs no hook and prefetches nothing.
   `Batch.get` and `Transaction.transactGet` group their rows by member and by the value of
   their modes and load each group once (`TransactableOps.loadGetRows`), one group after
   another, so the reads in flight stay within the store's `readConcurrency`; each get
   carries its own modes. Error
   payloads (`current` of `ConcurrentModification`, `ConditionalCheckFailed`, `StaleAppend`)
   load with `noFetch` — lazy whatever the operation's modes, and a pointer on an attribute the
   member no longer offloads fails the load, which needs a fetch (a `ValidationError` naming
   the attribute; `current: Option.none()` on a `ConcurrentModification`, whose payload is
   optional). Write results load in the operation's modes with `committed: true`, the binary
   default lazy (the read cache serves this operation's uploads) — except where the result is
   typed as the domain model: the bound `GeoIndex.put` (`A`, §8.4) and a projection's row
   write (the outcome's `state`) read eagerly. A pointer on an attribute the member does not offload (§4.7)
   resolves eagerly through the ambient store; a failure is a `ValidationError` whose cause is
   the `BlobStoreError` (`NotProvided` with no store). `hydrateRefs` reads a target that
   offloads lazily and drops its offloaded fields before the ref copy, so they are never
   fetched; the projection engine reads eagerly. `decodeMarshalledItem` is lazy by default and
   decodes a pure definition through the runtime decoder of a `makeImpl` built once per
   definition (a `WeakMap`), fixing the #147 gap (row 71). `Entity.Read<E, M>` names the view.
   The types: `Query<A, E = never, O = NoOffloadState>` (`E` the items' read blob errors, which
   every terminal adds), `BoundQuery<Model, SkRemaining, A, O>`, `BoundGet<A, E, O>` and the
   CRUD and append builders carry `O`; `OffloadedView` / `OffloadedErrors` re-type a read,
   `WithItem` a `select` / `returnValues`, and an unbound op's state also records the record
   type `asRecord` views, whether it is a read or a write (a write's errors carry
   `BlobStoreError` whatever its result's modes) and the model it was made over. The unbound
   `Entity.query.*` / `Entity.scan`, the bound `paginate` / `collect` / `fetch` / `scanFetch`
   helpers and `Entity.filter` / `Entity.select` take queries of any `E` and `O`, and the
   structural op unions (`Batch.write`'s, `TransactWriteOp`, `TransactWriteUpdateOp`,
   `ProjectionReadModel`) ops of any state; `ProjectionState` is the read model's domain type
   (the engine reads and writes rows eagerly). An explicit `Collection.make` collection is
   typed per member: a member selector is that member's query (`StateOf` its fields and
   record), and the grouped `query`'s items are `{ _entityKey, _entityType, _decoded }`, its
   state a per-member map (`MembersOffloadState`), so `Query.offloaded` re-types each
   member's record. Unit tests
   are `test/Entity.offload.read.test.ts`; type tests are in `test/Entity.offload.types.test.ts`
   ("the read types"); `test/connected.entity-offload.test.ts` gains reads against DynamoDB
   Local (gets per mode, index queries with projections, `limit` and `filterBy`, scans,
   `Batch.get`, `transactGet`, versions, tombstones and stream images).
   *Deviations (commit 8):*
   - Auto-discovered collections (`db.collections.*`) are typed with the offloaded fields of
     **all** the client's entities together, not a per-member map of states: the accessor is
     an index signature over every collection name, so it cannot be typed per member. Its
     result stays `any`, as before; only its blob errors and `.offloaded()` track the modes,
     never under-reporting. (An explicit `Collection.make` collection is typed per member.)
   - `getVersion`, `deleted.get` and `restore` on `BoundEntity` stay plain `Effect`s typed as
     views under the default modes, without `.offloaded()`: making them `BoundGet`s would let
     `Batch.get` and `transactGet` accept them, which read only live items. Their unbound
     forms are `EntityGet`s and take `Entity.offloaded`.
   - `decodeMarshalledItem` keeps one signature, conditional on the entity: its result is
     `unknown` and its error union unchanged for an entity that offloads nothing, and
     `Entity.Read<E, M>` for one that does — the overload of §10.1, without a second
     signature that a widened entity type could fall through to.
   - Vector search hits and `reembed` decode eagerly until commit 9 (vector), and both report
     a `BlobStoreError` as a `ValidationError`'s cause (operation
     `vectorSearch.<index>.decode` / `reembed.decode`), as `VectorSearchError` and `reembed`'s
     union have no `BlobStoreError` yet; aggregate (11), geo (12, but for `GeoIndex.put`'s
     eager result) and EventStore (13) reads are unchanged.
   - Type-erased offloaded fields (`any`, from `TypedClient`'s and the type helpers' own
     `infer … any` patterns) read as none in `View` and the builder states, as
     `ReadBlobErrors<any, M>` already did, so generic code over erased entities keeps today's
     types.
   - `.skipFollowUp()` on an append returns nothing, so its state is `NoOffloadState`.
   *Debt fixed (commit 8):* `queryNamespace` spread `packedQueryOptions` twice; commit 7's
   write-result read-back resolved pointers before unpacking (now one pass, and its
   `OffloadWrite.resolveStored` / `pendingPointers` are gone); the pure-definition fallback
   of `decodeMarshalledItem` (row 71). `Collection.make`'s grouped query was typed as one
   `{ [member]: records[] }` object per item, though its terminals return each item tagged
   with its member, and its member records were `any` (read off `recordSchema`, typed
   `Codec<any>`): they are the members' `Entity.Record` views now; two doc comments there
   sat on the wrong declarations. `DynamoClient`'s `EntityLike._decodeRecord` was typed
   `Effect<any, any>`, which hid the vector decode's untyped `BlobStoreError`.
   *Rebase onto 1.37 (#171, commit 8):* `Query<A, E, O>` keeps its offload parameters
   through #171's combinators (`pageSize("natural")`, `onRequest`, the internal planning
   helpers, `explain`), and `BoundQuery` takes the offload state **fifth**, after
   #171's `W` (`BoundQuery<Model, SkRemaining, A, W, O>`), so 1.37's public
   `BoundQuery<Model, SkRemaining, A, W>` keeps its meaning; `makeBoundQuery` keeps its
   four parameters and returns `W = never`. Collection pages keep 1.37's
   `cursor: Option<string>` with the blob errors added. *Prefetch on the planned loop (risk
   c):* every `examinePage` caller — the key loop, the planned window
   (`executePlanned` / the planned `pageStream`) and `collectRanges` — passes the budget
   still open, and a window member read alongside others but discarded (§3.6 of
   `zorder-indexes.md`), or a page read ahead and never emitted, is never examined, so
   nothing is prefetched for it. One gap closed here: rows a query drops by their raw form
   (`liveRows` history rows, #171's per-row bound check `rowCheck`, `keepRow`) used to open
   the whole response as a client predicate does, so an eager read prefetched every
   surviving row past `limit`. They are judged before hydration and load, so they now never
   take a place in the window; only a client predicate (`filterBy`) still examines — and
   eagerly fetches — the whole response. `Entity.offload.read.test.ts` pins it (a scan over
   live rows and their snapshots, `limit(1)`, fetches one value).
   *Port onto 1.42.2 (commit 8):* the 1.39–1.42 query paths keep the offload parameters
   too — the sharded fan-out (`fanOut`, `concurrency`, `whereUnderPins`, `refuse` /
   `refused` / `orRefusal`) and `selectWhole`. A fan-out round examines only the rows
   `ShardMerge.select` took for the round's budget, so a row another partition's page
   outranks, or one past `limit`, is never prefetched; `Entity.offload.plans.test.ts` pins
   it with the planned paths. `selectWhole` (a sparse map in a select, #238) reads whole
   rows, so it installs no page prefetch: its raw-row hook loads the selected subset of
   each row, and an offloaded field the select doesn't name is never fetched. The bound
   update takes the offload state after main's `RN` / `KR`
   (`BoundUpdate<Model, A, U, E, VN, P, RN, KR, O>`), `BoundAppend` after `RN`, and
   `insert` (1.41) reads its result per the operation's modes like `put`, with
   `.offloaded()` on `BoundInsert`. Ref hydration and the cascade from a referenced entity
   both store a ref through `refDataOf`, which leaves out every field the referenced entity
   offloads (its value is read lazily, so nothing is fetched; the cascade decodes its
   source row lazily too): a ref never holds a blob pointer, and never a copy of a value
   whose object another row owns (row 55). A read of the ref holds the same: the
   referencing entity's ref field is what a read of the target returns (`refHeldTarget`,
   #241), which leaves the fields the target offloads out as it leaves a required hidden
   field out (`registerOffloadedFields`, recorded by the target's definition). Without it
   the subset model `EDD-9143` asks for was replaced by the target's whole model, and every
   read of the referencing row failed (`Missing key at ["owner"]["avatar"]`).
   `Entity.offload.refs.test.ts` pins it, plain and retained (the two cascade paths). Two
   entities of one model that offload different fields leave the union out of a ref to
   either (a named limit).
9. **Batch / Transaction / projections / vector** — `validateAndBuildPutItem`, bound builders'
   captured store and compressor registry in `extractTransactable` (the compressor fix),
   `Batch.write` settlement, transaction planning and re-planning, `const`-generic op typing,
   projection pointer reuse (deep-equal + `#f = :P`), vector source and projections.
   *Implementation notes (commit 9):* `validateAndBuildPutItem` builds the stored-name item
   and no longer marshals it: its callers route and upload through the member's
   `_offloadItem(item, table, operation, reuse?)` (the put core's `OffloadWrite.route`, under
   the full operation name) and marshal after. A bound builder carries the services its
   `Entity.bind` resolved (`BoundCrudConfig.captured`: the `BlobStore` and `Compression` of the
   bind context, `TransactableOps.capturedServices`), `extractTransactable` surfaces them as
   `TransactableInfo.captured`, and `underCaptured` provides them (`Effect.provideContext`, so
   the client, ledger and operation are untouched) around everything done for that op: the
   item build (packing), the uploads, a planned update's or delete's plan, and the decode of
   a `Batch.get` / `transactGet` row (`loadGetRows` also groups rows by captured context).
   `Batch.write` builds every op first (local work, so a refused op uploads nothing), runs the
   repeated-key check, then uploads every offloading put through `forEachSettled` before any
   request; settlement is the ledger's at the choke point (commit 6: per ref by
   `UnprocessedItems` and `$metadata.attempts`, a versioned chunk by its token), and an
   `Expired` refusal of a later request is rebuilt to say what the batch had already written
   (`withCommitted`, the clause the batch's other mid-batch failures use).
   `buildTransactWriteItems` builds every put's item first (local work, so a refused op reads
   and uploads nothing), then runs the plan pre-pass it is given (`plans`, the effect
   `planTransactWriteOps(operations)`), then uploads each put's values after its tombstone read
   and before a guarded put's read; planned updates upload under the recording client into
   the transaction's ledger, and a re-plan after a lost race hits the memo. `Batch.write` and `transactWrite` are `const`-generic over their ops and add
   `WriteOpBlobErrors<T[number]>` (`BlobStoreError` for an op whose own error type has it,
   nothing for a plain op or one typed `any`); `PlanUpdateError` / `PlanDeleteError` gain
   `BlobStoreError`. Projections: `readRow` of an offloading read model reads the row through
   `_loadForReuse`, which loads it eagerly, snapshots each pointer it held
   (`OffloadWrite.ReadPointers`: the pointer, its stored attribute value, and the content it
   named — the canonical JSON of the loaded overflow value, sorted keys on null-prototype
   copies so an own `__proto__` key stays in the text, or a copy of the bytes), and decodes it
   as an item — Hidden fields included, as the plain read model's `decodeMarshalledItem` does,
   since the row is written back whole; the row write passes them
   as `reuse` (`EntityPutOpts.reuse` on the entity-put path, `_offloadItem`'s fourth argument
   on the outbox path) and `OffloadWrite.reuse` keeps, before routing, every uploadable value
   whose encoded content equals its snapshot: the item takes the stored pointer value, the
   write's condition gains `#eddPin<i> = :eddPin<i>` (`withPins`), and the content seeds the
   ledger's read cache (`BlobLedger.remember`), so the outcome's eager `state` fetches
   nothing. Upload operation names are the builders' validation names (`batchWrite.put`,
   `transactWrite.put`, `<projection label>.write`). Vector searches: `BoundVectorQuery`
   carries the trailing `O`, gains `.offloaded()` and adds `ReadErrors<O>` to `collect`; the
   hits load in one `loadRows` batch under the builder's modes (operation
   `vectorSearch.<index>.decode`), a `select` naming a read attribute in raw mode
   (`vectorSearch.<index>.select`), and decode through `_decodeRecord(raw, modes)`. `reembed`
   decodes lazily and reads only the source fields' offloaded values, of live rows only (a
   retained snapshot or tombstone is skipped on its sort key before any read); the standard update's
   vector path and the retain path's domain copy fetch only the source fields the payload
   does not supply (`keepOffloaded`). Unit tests: `test/Entity.offload.multi.test.ts`
   (`Batch.write` settlement per answer, `Expired` on a later chunk, transactions committed,
   cancelled and re-planned, captured stores and compressors), the projection-reuse tests of
   `test/EventStore.projection-rows.test.ts` (kept and pinned, changed and uploaded, a
   concurrent change of the field lost and retried, the outbox transaction; an overflow field
   unchanged, restated in another key order, changed, differing only under a `__proto__` key,
   and gzip-compressed; a required and an optional Hidden field on an offloading read model),
   the transaction tests of a refused put beside a planned update and of a store failure while
   planning one, and the vector tests of `test/Entity.offload.read.test.ts` (with a retained
   member: the read-merge update's source reads, and `reembed` over its snapshots); type tests in
   `test/Entity.offload.types.test.ts`; `test/connected.entity-offload.test.ts` gains
   `Batch.write` and `transactWrite` (committed and cancelled) against DynamoDB Local.
   *Deviations (commit 9):*
   - A projection keeps a read pointer when the folded value's **encoded** content equals the
     content the pointer named when the row was read (canonical JSON, key order ignored, for
     an overflow field; the bytes for a binary one), not when the domain values are
     structurally equal (§6.11). The snapshot is taken at the read, so an `evolve` that
     mutates its state in place cannot make a changed value compare equal to itself, and the
     comparison is over exactly what an upload would store; a restatement in another key order
     keeps the pointer, as the immutable confirm of commit 7 accepts it. The canonical text is
     built on null-prototype objects: values that differ only under an own `__proto__` key
     (which `JSON.parse` creates) are different content.
   - `BoundVectorQuery` gains `.offloaded()` (decision 43: every read builder), which §3.7's
     list did not name; §3.7 and §8.4 now do.
   - The typing of `EventStream.append` / `commandHandler`'s `additionalItems` (`const`
     generics, `BlobStoreError` in `AppendError`) moves to commit 13 (EventStore, item 13's
     scope) with the rest of the stream's offload types. Their puts already route and upload through the shared
     builder; nothing reaches them outside the test-only gate until then.
   - The projection interleaving of the test plan (§19) is in
     `test/EventStore.projection-rows.test.ts`, the concurrent writer scripted between the
     row's read and its write by the in-memory tables' `afterGet` hook;
     `test/Offload.interleaving.test.ts` moves to commit 16 (GC, item 16's scope): its other
     two scenarios, a unique-constraint entity and an aggregate edge (commit 11), both need
     the reaper.
   *Debt fixed (commit 9):* bound builders inside `Batch` / `Transaction` ignored the
   compressor registry they were bound with, for writes and for `Batch.get` / `transactGet`
   decodes (row 71's compressor fix); a `BlobStoreError` raised while planning a transaction's
   update or delete died as a defect (`PlanUpdateError` / `PlanDeleteError` lacked it); a
   vector `select` naming an offloaded field returned the raw pointer (only packed fields were
   unpacked); `reembed`, the update vector path and the retain path's domain copy fetched
   every offloaded field rather than the sources (commit 8's eager decode); commit 8's
   deviation for vector hits and `reembed` (eager, a `BlobStoreError` reported as a
   `ValidationError`'s cause) is gone; `extractTransactable`'s doc comment sat on
   `createGuard`; `transactWrite` planned its updates and multi-item deletes (reading their
   rows) before building any put, so a put refused by its own validation cost those reads —
   and, with offloading, a planned update's uploads — and the build now plans once every put
   is built.
   *Port onto 1.42.2 (commit 9):* main checks and composes every op of a transaction before
   anything reads (`prepareTransactWriteOps`, #236) and plans from that (`planTransactWriteOps(
   prepared)`), so the put items are already built when the plans read: the prepared op carries
   its `captured` services, the put item is built under them and a plan thunk runs under them,
   and `buildTransactWriteItems` keeps main's `{ prepared, plans }` options (no plan effect).
   Main marshals the built item through `marshalOrFail`, which names a field DynamoDB can't
   store; the port keeps that marshal (so the refusal still comes before any read or upload,
   and a getter in a value is called as often as main calls it, `LostBehindGetters.test.ts`)
   and returns it again: an entity that offloads nothing stores it as it is, and one that
   offloads a field marshals its routed item again through `marshalPutItem` (the same
   refusal). This supersedes "no longer marshals it" above. `Batch.write` keeps main's request packing (`packRequests`: 25 requests and
   16 MB of body; versioned chunks by transaction size) around the build / upload / request
   stages. `OffloadWrite.rowOf` of `_offloadItem` passes the schema's `escapeKeys` like the put
   core's. The 1.36 key paths are gone (no `aliasOf`, `old`, `held`, `leftBehind`,
   `Planning`, `ItemNotMoved`), and so are their tests; the multi-item fixtures use
   `escapeKeys: true`. A projection row write adds the row token (#237) before routing, so the
   item budget counts it, and pins the reused pointers onto the row-token condition.
10. **Binary inputs and streaming** — `BinaryInput`, `Offload.source`, single-use streams +
    memo, handle copy (with `VersionId` check), in-memory multipart simulation, `EDD-9120`.
11. **Aggregates** — diff first, route + upload after `buildDynamoItems` on stored attributes,
    no read-pointer reuse, per-group settlement, eager assembly, `AggregateType` error
    parameter. (The aggregate-edge interleaving of §19 is item 16's: it needs the reaper.)
12. **Geo** — `GeoSearch.nearby` decoding through the entity's two-phase decoder (fixing the
    #147 packed gap), eager resolution, `GeoIndex.put` binary input, `GeoIndex.bind` check,
    error unions.
13. **EventStore** — data / state offload, append / `commandHandler` / `writeSnapshot` /
    `measure*`, reads + `offloaded` option and `Query.offloaded` on `query.events`,
    `decodeStreamImage` / projections / `processBatch` / `runChangeFeed` lazy by default with
    `LazyStreamEvent`, `EventStream` parameter, `EventStore.bind` / `bindProjection` /
    first-operation checks; the typing of `EventStream.append` / `commandHandler`'s
    `additionalItems` (`const` generics over the ops, `BlobStoreError` in `AppendError`; moved
    from commit 9). **The gate is deleted**: the refusal is lifted for every member.
14. **Streams** — `decodeStreamRecord`, `Offload.compareStored`, `StorageEncoding.pointer` and
    pointer-aware `decode`, projection poison-record exclusion, `EDD-9119` (decoder side).
15. **S3 store + CI** — `src/blob/s3.ts` (put / copy `VersionId` checks and cleanup, list, head,
    tag marks), subpath export, optional peer, guard test, unit tests on a stubbed `S3Client`;
    MinIO in CI; `connected.blob-s3.test.ts`.
16. **GC** — `BlobGc`: reaper (table-local candidates, every-record view check, free rules,
    bracketed confirm-read, `confirm` option), per-item two-pass sweep and `sweepPartition`,
    `sweepStore`, purge integration, `EDD-9118` / `9119`; `test/Offload.interleaving.test.ts`
    (§19, moved from commit 9): the unique-constraint and aggregate-edge interleavings, which
    need the reaper.
17. **End-to-end connected** — `connected.blob-offload.test.ts`.
18. **Docs** — the §20 table: the new guide and its sidebar entry, the example, the guide and
    tutorial updates, `api-reference.mdx` (including the `PackedConfig | ExternalPackedConfig`
    signatures of `Packed`, `isPackedConfig`, `getPackedFields` and `stream.storedAs`, §3.1),
    `DESIGN.md` §12 EventStore paragraph and per-operation declared-errors rows, `CLAUDE.md`,
    `README.md`.
19. **Release** — changeset (`minor`, lockstep), then `pnpm changeset version` (CHANGELOGs,
    versions).

---

## 22. Semver and compatibility

`minor`. For code that declares no offloaded field:

- **Storage and types.** Stored forms, requests and every operation's types are unchanged.
  New type parameters default to "none", and `test/ErrorChannels.types.test.ts` pins this.
- **`R` unchanged** (`Effect.serviceOption`).
- **Readers.** `Uint8Array` fields gain a one-type check on read (§4.7): a `B` value reads
  exactly as before; an `S` value that is not an `~edbp:` pointer still fails as it does today.
- **`isBase64PackedText`** accepts `Q`–`X` too; JSON text is never affected.
- **Packed and geo reads.** `Entity.decodeMarshalledItem` on pure definitions and
  `GeoSearch.nearby` now unpack #147 packed fields, which they returned raw before (a bug fix).
- **Bound builders in `Batch` / `Transaction`** now use the compressor registry they were bound
  with, not the ambient one (a bug fix; identical when only one registry exists).

For code that declares offloaded fields:

- **Entities with binary `External` fields read `BlobHandle`s by default** — the feature's
  documented type change, opt-in by declaration.
- **Adding `external` to a field changes what lazy decoders return.** `decodeMarshalledItem`
  and `decodeStreamRecord` return `OffloadedValue`s for that field (inline values included), and
  stream-image / projection decoding of an EventStore stream with external `data` returns
  `LazyStreamEvent`s (§10.1, §10.2). The typed overloads make this visible; code that casts an
  `unknown` result does not see it until run time. The guide lists it.
- **Rollout order:** every reader (including stream consumers) must run a version with this
  feature before any writer enables offload (decision 9). Older readers fail loudly: an
  overflow pointer with the unsupported-layout `ValidationError`, a binary pointer (stored as
  `S`, §4.2) with a schema `ValidationError`. Two caveats, both in the guide:
  - an overflow field whose schema is `Opaque` and that the old reader does not configure
    `Packed` reads the pointer bytes as its value (#147's identical caveat);
  - an older **writer** that round-trips such a value (or `asNative` rows) can write a stale
    pointer back, outside the guarantee of §6.4. Upgrade writers before enabling GC.
- **Turning offload off** later leaves pointers readable; GC of that field stops (§4.7).
- **Offloading requires `escapeKeys: true`** (§11.10, `[EDD-9146]`). It is new with this
  release, so no existing configuration is refused: a table adopting offload over rows written
  under `escapeKeys` off turns the setting on and runs `rekey` first, as DESIGN.md §7 already
  asks of any change of the setting (no row offloading writes is ever under other text). Turning
  the setting off later is refused at bind while a member offloads, and `rekey` refuses to move
  a row that holds a pointer.

---

## 23. Scoping decisions

Every item in issue #179, the brief's decisions, and the boundaries this design introduced.
**Source** says who decided. Every proposal the design made where the brief was silent, or that
narrows or changes a brief decision, was **confirmed** by the user as written on 2026-11-01;
its row names the alternative that was considered and rejected.

| # | Item | Decision | Source |
|---|---|---|---|
| 1 | Field-level offload; overflow and binary kinds | **In** (§3.1, §3.2) | user |
| 2 | Whole-item offload | **Out** (§15) | user |
| 3 | Per-field threshold | **In**: `Packed({ external: { threshold } })`, stored bytes, default 65,536 | user; default + measure: design |
| 4 | Entity item budget, largest-first | **In**: `offload.itemBudget` (§6.3); pointer counted at an upper bound; ties by name | user; mechanics: design |
| 5 | Budget on UpdateItem paths | **Changed**: thresholds only up front; on an item-size rejection the update re-runs once on the read-merge path with the budget; `append` and path-op updates thresholds only (the read-merge path is not available to them) *Rejected: thresholds only everywhere.* | design — **confirmed** 2026-11-01 |
| 6 | Entity, Aggregate edges, EventStore data + state | **In** (§6.5–§6.10) | user |
| 7 | Aggregate reads | **Narrowed**: eager for both kinds; lazy aggregate reads out *Rejected: lazy aggregate reads (handles typed through nested sub-aggregates).* | design — **confirmed** 2026-11-01 |
| 8 | Aggregate binary inputs | **Narrowed**: `Uint8Array` only (no `Stream` / handle) *Rejected: `Stream` / handle inputs for aggregate edges.* | design — **confirmed** 2026-11-01 |
| 9 | Aggregate updates and read pointers | **Changed**: a changed group re-uploads its offloaded fields; no pointer read from the current state is reused (group `Put`s are unconditioned, §6.9) *Rejected: reusing read pointers through a side map (previous draft).* | design — **confirmed** 2026-11-01 |
| 10 | Pointer = Packed layout `010`, self-describing | **In**: byte layout §4.2 (kind bits, magic, length-prefixed key / version, flags, trailer) | user; layout: design |
| 11 | Binary pointer stored form | **`S`** text `~edbp:` + base64url of the pointer bytes, so older readers fail loudly; overflow pointers stay `B` (§4.2). *Rejected: `B` for both kinds, with the rollout order alone.* | design — **confirmed** 2026-11-01 |
| 12 | Bucket in the pointer | **Out**: layer config, so replicas resolve the same pointer | design |
| 13 | Stable hashed key per item + attribute | **In** as a three-level hash (partition / family / row + attribute) with a vendored SHA-256, independent of any `SecureRandom` or `Digest` service; under `offload.prefix`, else the store prefix | user; scheme: design |
| 14 | Time-series append key | **Changed**: keyed by the event item (one version per key), not the current item — S3's ~100k versions/key *Rejected: one stable key per current item and attribute (decision 7 as written).* | design — **confirmed** 2026-11-01 |
| 15 | Item key in object metadata | **In** as `edd-item` while the whole metadata set fits in 2 KB (row keys up to roughly 1,100 bytes); otherwise `edd-item-sha256` only, and the store-wide sweep reports such families as unattributable *Rejected: always storing `edd-item`, which can exceed the 2 KB metadata limit.* | user; cap: design — **confirmed** 2026-11-01 |
| 16 | Per-entity prefix override | **In**: `offload.prefix` replaces the store prefix for that entity; IAM must cover it | user |
| 17 | Write S3 first, then DynamoDB | **In** | user |
| 18 | "On DynamoDB failure delete exactly the written version" | **Changed (narrowed)**: delete only when the failure proves non-commit (§6.2's settlement table: `$metadata.attempts`, library `ClientRequestToken`s, ALL_OLD evidence for plain members); unknown outcomes kept, logged at `Warning`, reported to the observer, found by the sweeps *Rejected: deleting on every DynamoDB failure (decision 7 as written), which can delete the version a committed pointer names.* | user; narrowing: design — **confirmed** 2026-11-01 |
| 19 | Upload age limit | **New**: `maxUploadAge` (default 1 hour) on the store; an upload that would commit later fails with `Expired` and writes nothing. It is what lets GC tell an in-flight upload from a leak (§6.1, §11.4) *Rejected: no age limit, which leaves GC unable to tell an in-flight upload from a leak.* | design — **confirmed** 2026-11-01 |
| 20 | Reject responses without a real `VersionId` | **In**: missing or `"null"`, on `PutObject`, `CompleteMultipartUpload` and `CopyObject`; the stray object is deleted (`VersionId: "null"` in a suspended bucket, F20) | user; cleanup: design |
| 21 | Stores without versioning: new key per write | **In** in the contract and the memory store; no such production store ships | user; scope: design |
| 22 | Checksum algorithm | **CRC64NVME** over content bytes (uncompressed JSON for overflow), vendored pure-JS, S3-validated (§5); chosen over CRC-32 / CRC-32C for width; a match never skips a write | user (preference); coverage: design |
| 23 | Streaming / multipart for binary fields | **In** (§7): direct SDK multipart, 8 MiB default parts, interruption aborts | user; parameters: design |
| 24 | `Stream` inputs reused | **Refused**: a `Stream` is single-use, one target per value (`EDD-9120`) *Rejected: allowing a second target when the store can `copy` the first upload.* | design — **confirmed** 2026-11-01 |
| 25 | Overflow values and multipart | **In** only past `partSize` (normally single PUT) | design |
| 26 | Reads: overflow eager, binary lazy, overridable, typed | **In**: `.offloaded(mode)` on bound builders, `Entity.offloaded` / `Query.offloaded` duals for unbound ones (§3.7), `View` (§9.2) | user; names: design |
| 27 | `select()` omitting the field never fetches | **In** (raw-row hook attributes, §8.4) | user |
| 28 | Eager fetches at bounded concurrency | **In**: page prefetch inside the limit window; `readConcurrency` 16 | issue; design |
| 29 | Lazy handle API | `read` / `stream` (optional `{ offset, length }`) / `presignedUrl`; inline handles for legacy native values | user; names: design |
| 30 | `presignedUrl` | **In** when the store has `presign`; S3 takes an injected `getSignedUrl` (no presigner dependency); default expiry 15 minutes, equal to the reaper's default grace | user; injection + default: design |
| 31 | Stream decoding lazy by default | **In** everywhere (decision 5): `Entity.decodeMarshalledItem`, `decodeStreamRecord`, `stream.decodeStreamImage`, `EventProjection` / `MultiProjection`, `EventStore.processBatch` / `runChangeFeed` (`LazyStreamEvent`). *Rejected: an eager EventStore default (§10.2).* | user; lazy baseline **confirmed** 2026-11-01 |
| 32 | Change detection by pointer comparison | **In** (§10.3), plus inline ↔ pointer via the content checksum and size; `rewritten` documented as probable, not proven | user |
| 33 | `NEW_AND_OLD_IMAGES` from the records | **In** (§10.4); every record of a reap call checked before any is acted on; falls back to image presence when the record omits the view type | user; fallback: design |
| 34 | GC optional: reaper + sweep with grace | **In** (§11): table-local; reaper grace 15 minutes, `confirm: "auto" \| "always"`; two-pass sweep with unreferenced-since marks, grace 24 h (≥ 1 h and ≥ `maxUploadAge` + 15 min) | user; rules + defaults: design |
| 35 | Issue's free rules ("REMOVE frees all", "removing the snapshot frees it") | **Changed**: unsafe when versions are shared; replaced by the bracketed confirm-read (§11.3); plain members and aggregate edges free directly *Rejected: the issue's direct free rules.* | design — **confirmed** 2026-11-01 |
| 36 | Store-wide sweep | **New**: `gc.sweepStore` lists the store and sweeps each own item family named by its metadata (§11.5) *Rejected: deferring it to a later release.* | design — **confirmed** 2026-11-01 (scope addition) |
| 37 | Unsettled-upload observer | **New**: `Offload.layerObserver({ onUnsettled })` (§3.6) *Rejected: deferring it (logs only).* | design — **confirmed** 2026-11-01 (scope addition) |
| 38 | Inline freeing of superseded versions on writes | **Out**: only rollback of the op's own uploads, and purge; superseded versions are GC's *Rejected: freeing superseded versions inline on writes.* | design — **confirmed** 2026-11-01 |
| 39 | Purge deletes every version | **In**, after DynamoDB succeeded: bracketed re-read, then deletes listed own versions that the purged rows named or that are too old to be in flight; younger unnamed ones are left for the sweep (§11.6) | issue; mechanics: design |
| 40 | `NoncurrentVersionExpiration` never relied on | **In** (§11.7 table) | user |
| 41 | Copies of a table (PITR / backup restore, import, copied rows) | **Protected**: GC is table-local, so a copy never deletes its source's versions; the source's GC does not know its copies (§11.8) | design |
| 42 | `BlobStoreError`, typed like `TPackedFields` | **In**: `TOffload` parameter; errors only where the mode reaches the store (§9.3); 12 reasons incl. `Expired` | user; precision: design |
| 43 | Builder offload state | **In**: a trailing `O` state parameter on every builder and `Query<A, E, O>`, so `.offloaded()` re-types whatever the builder returns (§9.2) | design |
| 44 | Multi-op write entry points | **Typed**: `Batch.write`, `Transaction.transactWrite`, `EventStream.append` / `commandHandler` become `const`-generic over their ops and add the ops' `BlobStoreError` (`any` ops contribute nothing) | design |
| 45 | Error payloads (`ConcurrentModification.current`) | lazy, no I/O while failing | design |
| 46 | Post-commit read failure | `BlobStoreError { committed: true }` | design |
| 47 | Configuration errors | `EDD-9111`, `EDD-9114`–`9120`, `EDD-9141`–`9143` and `EDD-9146` (§14.3); `EDD-9076` / `9077` **extended** to External fields instead of new codes *Rejected: new codes for External fields.* | design — **confirmed** 2026-11-01 |
| 48 | Bind-time store check | **In** (`EDD-9115`), incl. `Entity.bind` / `Aggregate.bind` (which also gain the missing `EDD-9078` codec check, debt), `EventStore.bindProjection`, `processBatch` / `runChangeFeed`, `GeoIndex.bind` | issue; debt: design |
| 49 | Subpath `effect-dynamodb/blob/s3`, optional peer | **In**, `^3.1104.0` | user |
| 50 | In-memory store | **In**, versioned and key-per-write modes, `list` / `head` / `marks`, fault injection | user; modes: design |
| 51 | Connected tests with MinIO | **In**: `cgr.dev/chainguard/minio` pinned by digest (upstream archived) | user; image: design |
| 52 | Switching offload on / off without rewrite | **On: in** (legacy values read inline). **Off: reads only** — pointers resolve via the `ValidationError`-cause path and GC stops covering the field; the same for removing `external` from an overflow field *Rejected: a "retired" declaration that keeps GC coverage.* | design — **confirmed** 2026-11-01 |
| 53 | `BlobHandle` as a write input | **In** as content to copy (server-side `copy` or streamed), always — even when it names the version the field holds | design |
| 54 | Carry-on-equal (writing a read pointer back when the checksum matches) | **Out** (the previous draft had it in): named attributes always upload; only pinned copies and unchanged attributes keep a pointer (§6.4); projection rows reuse one only when the folded value deep-equals the fetched one, under `#f = :P` (§6.11) *Rejected: carry-on-equal (previous draft).* | design — **confirmed** 2026-11-01 (cost: restated content re-uploads) |
| 55 | Refs to entities with offloaded fields | **Refused** when the ref schema includes the field (`EDD-9143`); ref hydration reads lazily, and hydration and the cascade from the referenced entity (`refDataOf`) leave the offloaded fields out, so no ref ever holds a pointer *Rejected: stripping such fields from ref hydration automatically.* | design — **confirmed** 2026-11-01 |
| 56 | `StorageEncoding` helpers | `pointer()` added (both stored forms); `decode` resolves via the ambient store; `*Sync` refuse pointers; `valueBytes` unchanged (inline size) | design |
| 57 | `measureAppend` / `measureSnapshot` | never upload; pointers at the upper bound; `offloaded` field added | design |
| 58 | Geo | **In**: `GeoSearch.nearby` resolves both kinds eagerly through the entity's two-phase decoder; `GeoIndex.put` takes `Uint8Array` for binary fields; error unions and bind check (§8.4, §9.3, §13) *Rejected: refusing `GeoIndex` on entities that offload.* | design — **confirmed** 2026-11-01 |
| 59 | Global Tables | per-region buckets, reaper and sweep; same table name → same keys; one shared bucket → GC in one region; `notFoundRetry` option; docs on RTC and backfill (§16) | issue; design |
| 60 | IAM | §17 (adds `s3:ListBucket`, `s3:DeleteObject`, version tagging, KMS) | issue; additions: design |
| 61 | PITR / backups | **Documented**: no separate "never delete" GC mode; tables whose restores must be whole run sweep-only GC (no reaper) with a grace at least the restore window, which keeps restores whole (sound through marks); purge and rollback deletes are not covered (§11.8). *Rejected: a "never delete" GC mode.* | design — **confirmed** 2026-11-01 |
| 62 | Object Lock / MFA Delete | unsupported for GC; documented | design |
| 63 | SSE beyond passthrough | **Out** | user |
| 64 | Content-hash dedup | **Out** | user |
| 65 | Native GCS / Azure / R2 stores | **Out** | design |
| 66 | Table-wide sweep (Scan + S3 Inventory) | **Out** (`sweepStore` covers leaks by listing) | design |
| 67 | Adversarial integrity (SHA-256 content checksum) | **Out**; algorithm `0x02` reserved | design |
| 68 | Server-side compression of binary fields | **Out**; pointer codec bits reserved (§18) | design |
| 69 | S3 request counts in consumed-capacity reports | **Out**: #174 reports DynamoDB capacity only (§18) | design |
| 70 | A library re-encoder migrating existing items into or out of offload | **Out**: natural writes migrate (§4.7, §18) | design |
| 71 | Adjacent debt | **Fixed**: `TypedClient` "11 type parameters" comment (commit 7); `DESIGN.md` EDD band table missing 9068–9070 and 9080–9085 (this commit); bound builders inside `Batch` / `Transaction` ignoring their compressor registry (commit 9); `decodeMarshalledItem`'s pure-definition fallback not unpacking (commit 8); geo reads not unpacking packed fields (commit 12) | design (golden rule) |
| 72 | Key text of tables that offload | **Required: `escapeKeys: true`.** Refused at bind (`EDD-9146`) for every member that offloads, and at an unbound write's routing; `rekey` refuses to move a row holding a pointer (§11.10). *Rejected: keeping offloaded values inline on rows under 1.36 key text and moving pointer rows (the 1.37-based design, whose machinery main removed in 1.39).* | owner — 2026-11-14 |
| 73 | PartiQL `insert()` (1.41.0) | **Offloads**: routes and uploads before the `INSERT`, decodes the written values, and the ledger settles `ExecuteStatement` / `ExecuteTransaction` (§6.2) | owner — 2026-11-14 |
| 74 | Offloaded fields as GSI shard sources | **Refused**: an `External` field named by `shards.by` is `EDD-9142` (an overflow field, as a packed one, is refused as a composite), so the shard hash never reads a stored pointer | design (rebase onto 1.42.2) |

---

## 24. Decisions this design made that the brief left open, and resolved questions

### 24.1 Decisions (beyond §2.2)

All confirmed by the user as written on 2026-11-01, including every name and default below.

1. **Names.**
   - Field config: `Packed({ external: { threshold } })` → `ExternalPackedConfig`;
     `DynamoModel.External({ contentType })`.
   - Item config: `offload: { itemBudget, prefix }` on `Entity.make` / `makeStream`.
   - Reads: `.offloaded(mode)`, `Entity.offloaded` / `Query.offloaded`, with
     `"eager" | "lazy" | { overflow?, binary? }`; `OffloadedValue<A>`, `BlobHandle`,
     `LazyStreamEvent<A>`, `Offload.source`, `Offload.View`, `Offload.compareStored`.
   - Store: `BlobStore` (service, `layer`, `memory`, `layerMemory`, `crc64nvme`);
     `S3BlobStore.layer` / `layerConfig` / `make`; `Offload.layerObserver`.
   - GC and streams: `BlobGc.make` → `reap` / `sweep` / `sweepPartition` / `sweepStore`;
     `Entity.decodeStreamRecord`; `StorageEncoding.pointer`.
2. **Defaults.** `threshold` 65,536 stored bytes; no item budget; `partSize` 8 MiB;
   `uploadConcurrency` 4, `readConcurrency` 16, `writeConcurrency` 8; `maxUploadAge` 1 hour;
   reaper grace 15 minutes, `confirm: "auto"`; sweep grace 24 hours (≥ 1 hour and ≥
   `maxUploadAge` + 15 minutes); `presignedUrl` 15 minutes.
3. **Checksum.** CRC64NVME over content bytes (uncompressed JSON for overflow), vendored in the
   schema package; matches decide only probabilistic or confirmed questions (§5); SHA-256 code
   reserved.
4. **Pointer layout.** §4.2: kind bits, 4-byte magic `EDBP`, flags, algorithm byte,
   LEB128-length-prefixed key / version / content type, 4-byte CRC trailer; no bucket. Stored
   as `B` (overflow) or `~edbp:` base64url `S` text (binary).
5. **Keys.** Three-level SHA-256/128 hash computed by a vendored implementation; time-series
   appends keyed by event item; table name in the partition hash; `offload.prefix` replaces the
   store prefix.
6. **Consistency.** Root-scoped upload ledger settled at `Capacity.client`; delete only on
   proven non-commit (§6.2's table); `maxUploadAge` enforced; unsettled uploads logged and
   observable.
7. **Pinned pointers.** Every pointer a write did not upload is pinned by the request's own
   condition; no carry-on-equal; handles are content to copy; streams are single-use.
8. **GC.** Table-local; reaper frees directly for plain members and aggregate edges, otherwise
   after a bracketed confirm-read over the family's explicit ranges; two-pass sweep with
   unreferenced-since marks; store-wide sweep; purge re-reads before deleting; no inline
   freeing.
9. **Types.** `TOffload` (14th on `Entity`, 11th on `BoundEntity`), `View`, the trailing `O`
   builder state, `ReadBlobErrors` / `WriteBlobErrors` / `OpBlobErrors`, trailing parameters
   on `AggregateType` / `EventStream`; `Entity.Model` stays the domain type, `Entity.Read` names
   the view.
10. **EDD codes** `9111`, `9114`–`9120` and `9141`–`9143` (allocated as `9110`–`9120`; three
    renumbered on the rebase onto 1.42.2, §14.3), and `9146` (2026-11-14); `9076` / `9077`
    extended.
11. **Key text** (owner, 2026-11-14): offloading requires `escapeKeys: true`, and `rekey` never
    moves a pointer row (§11.10).
12. **PartiQL** (owner, 2026-11-14): `insert()` offloads, and the ledger settles
    `ExecuteStatement` / `ExecuteTransaction`, `DuplicateItemException` proving non-commit only
    for a statement sent once (§6.2).

### 24.2 Resolved questions

Each question this design put to the user was answered on 2026-11-01: the design's answer is
confirmed as written, and the alternative was considered and rejected.

1. **EventStore stream-image default** (§10.2): the lazy baseline stays (decision 5 as written,
   `LazyStreamEvent` for streams with external `data`; `{ offloaded: "eager" }` per call).
   *Rejected:* an eager EventStore default.
2. **Aggregates** (§3.5, §6.9, §8.4): eager-only reads, `Uint8Array`-only binary inputs, and a
   changed group re-uploads its offloaded fields in this release. *Rejected:* lazy aggregate
   reads, `Stream` / handle edge inputs, and reusing read pointers.
3. **Settle rule** (§6.2): rollback only on provable non-commit; an unknown outcome keeps its
   uploads, which are logged, reported to the observer and found by `gc.sweepStore`.
   *Rejected:* deleting on every DynamoDB failure.
4. **Item budget on UpdateItem paths** (§6.3): thresholds up front, one retry through the
   read-merge path on an item-size rejection; `append` and path-op updates use thresholds only.
   *Rejected:* thresholds only everywhere.
5. **Time-series event-keyed objects** (§4.5): an append's object is keyed by its event item,
   one version per key. *Rejected:* one stable key per current item and attribute.
6. **Switching offload off** (§4.7): reads only; GC no longer covers the field, and the docs
   recommend rewriting items first. *Rejected:* a "retired" declaration that keeps GC
   coverage.
7. **Reaper grace in Lambda** (§11.3): the 15-minute default stays, equal to the presign
   default; Lambda reapers set a shorter grace (documented). *Rejected:* a shorter default
   with presign expiries bounded to match.
8. **`EDD-9076` / `9077`** are extended to External fields (§14.3). *Rejected:* new codes.
9. **Default threshold** 65,536 stored bytes. *Rejected:* a smaller default (e.g. 32 KiB).
10. **EDD codes** `9111`, `9114`–`9120`, `9141`–`9143` and `9146` (§14.3). *Rejected:* starting at `9100`.
11. **PITR / backups** (§11.8): no separate "never delete" GC mode. Tables whose restores must
    be whole run sweep-only GC with a grace at least the restore window, as documented.
    *Rejected:* a "never delete" GC mode.
12. **Binary pointer stored form** (§4.2): `S` text with the `~edbp:` sentinel, so older
    readers fail loudly. *Rejected:* `B` for both kinds with the rollout order as the only
    protection.
13. **Scope additions**: `gc.sweepStore` (§11.5) and `Offload.layerObserver` (§3.6) ship in this
    release, as do sweep marks as S3 version tags (§11.4), geo wiring (§8.4) and the
    pre-existing #147 gap fixes (§23 row 71). *Rejected:* deferring them.
14. **`maxUploadAge`** (§6.1): default 1 hour, `Expired` for slower uploads, bounds 1 minute …
    7 days. *Rejected:* no age limit.
15. **Geo** (§8.4): `GeoIndex` is wired (eager reads, `Uint8Array` puts). *Rejected:* refusing
    `GeoIndex` on entities that offload.
16. **No carry-on-equal** (§6.4): restating identical content re-uploads it. *Rejected:*
    writing a read pointer back on a checksum match.
17. **Single-use streams** (§3.8): a `Stream` given to a second target is refused
    (`EDD-9120`). *Rejected:* allowing it when the store can `copy` the first upload.
18. **Object metadata cap** (§4.6): `edd-item-sha256` for long row keys, those families
    reported as unattributable by `sweepStore`. *Rejected:* always storing `edd-item`.
19. **Refs** (§15): a ref schema that includes an offloaded field is refused (`EDD-9143`).
    *Rejected:* stripping such fields from ref hydration automatically.
20. **Reaper free rules** (§11.3): the bracketed confirm-read replaces the issue's "REMOVE frees
    all" / "removing the snapshot frees it" sketch for `retain`, `softDelete` and `timeSeries`
    members. *Rejected:* the issue's direct free rules.
21. **Inline freeing on writes** (§6.2): none; writes roll back only their own uploads, and
    superseded versions are GC's. *Rejected:* freeing superseded versions inline.
