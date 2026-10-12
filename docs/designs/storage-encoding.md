# Design: packed storage encoding (JSON string, optional compression) for entity fields and EventStore data

**Issue:** [#147](https://github.com/jmenga/effect-dynamodb/issues/147)
**Status:** Designed → implemented in the same PR (single-PR workflow — this doc is commit 1).
**Affected packages:** `packages/schema` (`DynamoModel.Packed`, `Compression` service +
`Compressor` interface, the pure pack/unpack codec, entity definition guards, the
`CompressorNotRegistered` error), `packages/effect-dynamodb` (Entity, EventStore, Query,
Aggregate, Batch, Transaction, Collection, DynamoClient, new `StorageEncoding` module, new
subpath `effect-dynamodb/compression/node`), docs, examples
**Semver impact:** `minor` (lockstep across the four publishable packages). Additive API
surface; the default storage is unchanged — see §14.

---

## 1. Executive summary

`EventStream.append` stores each event's `data` as a native DynamoDB map, and an entity
stores every structured field the same way. A map is the most expensive shape DynamoDB can
hand back: the SDK parses a type-wrapped node per value and `unmarshall` rebuilds the graph
a second time. The issue's measurements (Lambda, arm64, nodejs24.x) show a sub-stream read
of ~6,000 small events is **~3× faster** when `data` is one JSON string (`S`) instead of a
map, and a ~48 KB folded state shrinks from ~39 WCU to ~4–5 WCU when that JSON is
compressed.

This design adds **one declarative storage config**, defined once in
`@effect-dynamodb/schema`:

```ts
DynamoModel.Packed({ format: "json" })                                         // JSON string (S)
DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } })         // + compression ≥ 1 KiB
DynamoModel.Packed({ format: "json", compression: { codec: "gzip", threshold: 4096 } })
```

and applies it in two places:

```ts
// 1. Entity fields — a sibling of the SparseMap storage layout
const OrderModel = DynamoModel.configure(Order, {
  lines: { storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }) },
})

// 2. EventStore event data and snapshot state
const Ledger = EventStore.makeStream({
  table, streamName: "Ledger", events: [Recorded, Voided], streamId: { composite: ["ledgerId"] },
  storedAs: { data: DynamoModel.Packed({ format: "json" }) },
  snapshot: {
    schema: LedgerState, mode: "inline",
    storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
  },
})
```

Compression implementations are **pluggable**: a small synchronous `Compressor` interface
(`codec` + `compress` + `decompress` on `Uint8Array`), registered through a `Compression`
service that `DynamoClient.layer({ compressors })` provides. Node implementations
(`node:zlib`) ship from a new subpath, `effect-dynamodb/compression/node`; the core never
imports `node:zlib`.

The stored form is **self-describing per attribute**. Readers dispatch on what is stored,
not on the current config: a native map (or other native type) is a legacy value, `S` is
uncompressed JSON, and `B` is a one-byte header (layout version, format, codec) followed by
the payload. Turning packing on, off, or changing codec needs no rewrite — items written
before keep decoding. No marker attribute is added (it would fall outside every deployed
`"withoutMetadata"` stream index's `INCLUDE` projection, which cannot be changed in place).

The downstream consumer's requirements are all in scope: a stored-size helper for
caller-side chunking (R1), a DynamoDB Streams image decoder returning the read paths'
exact `StreamEvent` (R2), raw rows (`Query.select`) returning `data` as plain parsed JSON
whatever its stored form, through every index projection (R3), and compressed inline and
async snapshots whose **stored** size is what the size diagnosis counts (R4).

The default stays the native map. Metadata stays a map. `SchemaBinary` (`format:
"binary"`) is out of this PR; the header reserves a format value for it.

---

## 2. Context

### 2.1 Why a map is slow to read

DynamoDB's API is JSON over HTTP. A map attribute arrives as DynamoDB JSON with a type
wrapper around every value (`{"M":{…}}`, `{"N":"0"}`), so the SDK's `JsonShapeDeserializer`
and `readAttributeValue` run per attribute value, and `fromAttributeMap` → `convertToNative`
builds the graph again. An `S` attribute holding the same content as JSON is one node: the
SDK parses one string, `unmarshall` copies one string, and `JSON.parse` (native code) does
the rest.

Measured by the consumer (issue comment, run 1 medians, 5,990 events, 5 `Query` pages):

| `data` encoding | Stored B/item | Wire | SDK parse | Unmarshall | Fold path | GC / alloc |
|---|---|---|---|---|---|---|
| map (today) | 481 | 5.36 MB | 136 ms | 73 ms | 227 ms | 46 ms / 106 MB |
| JSON string (`S`) | 610 | 4.43 MB | 29 ms | 1.4 ms | 76 ms | 2 ms / 26 MB |
| JSON + zstd/gzip/brotli (small items) | 367–404 | 3.15–3.45 MB | 42–46 ms | ~1.6 ms | 224–246 ms | ~40 ms |

Large payloads (~48 KB as JSON, per item): map 38.5 KB stored / ~39 WCU; JSON 47.4 KB /
~47 WCU; JSON + zstd 4.1 KB / 5 WCU (+0.13 ms write, +0.05 ms read).

Two consequences shape the design:

- **JSON is stored ~18–27% larger than the map** for this data. Anything that sizes items
  (the failure diagnosis, `Batch.write` chunking, a caller planning chunks) must count the
  stored bytes, not estimate from the map.
- **Compression only pays on large values.** Below ~150 B it grows the payload; between
  150 B and 1 KB it saves no WCU (an item under 1 KB is already one WCU) and costs ~20 µs
  per read. Hence a threshold, defaulting to 1,024 bytes, and "store compressed only when
  smaller".

### 2.2 What the user fixed before this design

- Format: JSON string only, optional compression over a threshold. `SchemaBinary` out; the
  `B` header reserves a format value for it.
- One config in `@effect-dynamodb/schema`, shared by Entity and EventStore.
- Consumers in this PR: EventStore event `data` and snapshot `state`; entity fields via
  `storedAs` (so aggregate edges, which are entities, too).
- Default map; metadata map; no zstd dictionary; no per-event-type override.
- Self-describing stored form, no marker attribute; readers dispatch on the stored value.
- Compress only at ≥ threshold *and* when smaller; default threshold 1,024.
- Pluggable sync compressors; Node implementations from a subpath; unregistered codec on
  read or write fails with a tagged error naming it.
- Guards, refusals and helpers as listed in §6–§8; diagnose-on-failure for sizes.

---

## 3. API

### 3.1 `DynamoModel.Packed` (schema package, `DynamoModel.ts`)

```ts
export type PackedFormat = "json"                       // "binary" reserved (§4.2), not accepted yet
export type CompressionCodec = "gzip" | "brotli" | "zstd"

export interface PackedOptions {
  readonly format: PackedFormat
  readonly compression?: {
    readonly codec: CompressionCodec
    /** UTF-8 byte length of the JSON at or above which compression is tried. Default 1024. */
    readonly threshold?: number | undefined
  } | undefined
}

/** Branded, frozen config — the value of a `storedAs`. */
export interface PackedConfig {
  readonly [PackedTag]: true
  readonly format: PackedFormat
  readonly compression: { readonly codec: CompressionCodec; readonly threshold: number } | undefined
}

export const Packed: (options: PackedOptions) => PackedConfig
export const isPackedConfig: (value: unknown) => value is PackedConfig
/** Domain field name → config, for every field configured `storedAs: Packed(...)`. */
export const getPackedFields: (model: Schema.Top) => Record<string, PackedConfig>
```

- `format` is **required**, so `"binary"` can be added later without changing what an
  existing call means.
- `compression.codec` is **required** when `compression` is given. The issue comment
  suggested defaulting to zstd; zstd needs Node ≥ 22.15, and a default that fails on some
  runtimes only when a value first crosses the threshold is a trap. The docs recommend
  zstd (cheapest write, ~equal ratio).
- `threshold` defaults to **1024** (WCU rounds per item at 1 KB). It must be a
  non-negative safe integer; `0` means "always try".
- Validation is at call time (`[EDD-9071]`): a `format` other than `"json"` (with a
  message saying `"binary"` is reserved and not yet supported), an unknown codec, a bad
  threshold, or an unknown option key.
- Compressor tuning (zstd level, brotli quality) is **not** in the config: the config
  names *what* the stored bytes are, the registered compressor decides *how* to produce
  them. Readers need only the codec, which the header carries.

`ConfiguredModel.attributes[field]` gains `packed?: PackedConfig` (beside `sparse`), and
`AttributeConfig<A>.storedAs` widens to `Schema.Schema<A> | SparseMapConfig | PackedConfig`.
At the type level `PackedConfig` is admitted only where `NonNullable<A> extends object`
(scalars are a compile error); the runtime shape rule (§4.5) is authoritative. A field has
one `storedAs`, so a field can never be both sparse and packed.

### 3.2 Entity configuration

```ts
const OrderModel = DynamoModel.configure(Order, {
  lines:   { storedAs: DynamoModel.Packed({ format: "json" }) },
  details: { field: "d", storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }) },
})
```

`field` (rename) and `immutable` combine with `Packed`; `ref` and `identifier` do not
(§6.1). The packed attribute is stored under the renamed name.

### 3.3 EventStore configuration

```ts
EventStore.makeStream({
  …,
  storedAs: { data: DynamoModel.Packed({ format: "json" }) },          // event data
  snapshot: { schema: State, storedAs: DynamoModel.Packed({ … }) },  // snapshot state
})
```

- `storedAs` on the stream takes exactly one key, `data`. Metadata stays a map, and the
  type admits no `metadata` key. Any other key, or a value that is not a `Packed` config,
  is `[EDD-9079]` at `makeStream`.
- `snapshot.storedAs` lives with the state schema it encodes. The state schema's encoded
  side must be object/array-shaped (`[EDD-9073]`, §4.5).
- The stream exposes the resolved settings: `stream.storedAs: { data: PackedConfig |
  undefined; state: PackedConfig | undefined }` (also on `BoundEventStream`).

The issue proposed `encoding: { data: "json", compression }`. It is replaced by the shared
config so Entity and EventStore have one spelling (§15, item 2).

### 3.4 Compression: interface, service, registration

In `@effect-dynamodb/schema` (pure; no `node:zlib`, no `@aws-sdk`), new module
`Compression.ts`, re-exported by `effect-dynamodb`:

```ts
export interface Compressor {
  readonly codec: CompressionCodec
  /** Synchronous. May throw; the library wraps the throw (§5.3). */
  readonly compress: (input: Uint8Array) => Uint8Array
  readonly decompress: (input: Uint8Array) => Uint8Array
}

export interface CompressionRegistry {
  readonly get: (codec: CompressionCodec) => Compressor | undefined
  readonly codecs: ReadonlyArray<CompressionCodec>
}

/** `[EDD-9078]` on two compressors for one codec, or an unknown `codec`. */
export const make: (compressors: ReadonlyArray<Compressor>) => CompressionRegistry

export class Compression extends Context.Service<Compression, CompressionRegistry>()(
  "@effect-dynamodb/Compression",
) {
  static readonly layer: (compressors: ReadonlyArray<Compressor>) => Layer.Layer<Compression>
  static readonly make: typeof make     // so `Compression.make([...])` works from the class export
  static readonly empty: CompressionRegistry
}
```

**Resolution without a new `R`.** Every pack/unpack site reads the registry with
`Effect.serviceOption(Compression)`, which adds nothing to `R`. Entity and EventStore op
types are unchanged; `R` stays `DynamoClient | TableConfig` for unbound ops and `never`
for bound ones. An absent service behaves as an empty registry: packing without
compression and reading `S` values work everywhere; only a value that actually needs a
codec fails, with a `ValidationError` whose `cause` is a `CompressorNotRegistered` (§5.3).

**Registration** — any of, in this precedence (mirrors `embedder`, `DESIGN.md §14`):

1. `DynamoClient.make({ entities, …, compressors })` — explicit, bundled into the captured
   context of every bound entity/aggregate/collection operation.
2. An ambient `Compression` service when the client or stream is bound
   (`DynamoClient.make` reads `Context.getOption(baseCtx, Compression)`; `EventStore.bind`
   captures the whole context).
3. An ambient `Compression` at run time, for unbound operations and the decode helpers.

Convenience: `DynamoClient.layer({ region, endpoint?, credentials?, compressors? })` and
`DynamoClient.layerConfig({ …, compressors? })` also provide `Compression` from the same
layer, so "registered where DynamoClient is" is one line:

```ts
import * as NodeCompression from "effect-dynamodb/compression/node"
const live = DynamoClient.layer({ region: "us-east-1", compressors: [NodeCompression.zstd()] })
```

The layers are overloaded on `compressors`: given, the return type is
`Layer<DynamoClient | Compression, …>`; omitted, it stays `Layer<DynamoClient, …>` and no
`Compression` is provided, so an ambient registry provided beside the client is never
shadowed by an empty one. (A layer's output is not contravariant —
`Layer<DynamoClient | Compression>` is not assignable to `Layer<DynamoClient>` — so a single
widened return type would have broken existing annotations.) The registry is validated
(`[EDD-9078]`) when the layer is constructed.

`Compression` is a `Context.Service` (gate 9), not a `Context.Reference`: both avoid an
`R`, but the service + `serviceOption` matches the `Embedder` precedent and keeps "no
registry" distinguishable from "empty registry" for the bind-time precedence above.

**Node implementations** — new subpath export `effect-dynamodb/compression/node`
(`src/compression/node.ts`, `package.json` `exports["./compression/node"]`):

```ts
export const gzip:   (options?: { readonly level?: number; readonly maxOutputLength?: number }) => Compressor
export const brotli: (options?: { readonly quality?: number; readonly maxOutputLength?: number }) => Compressor
export const zstd:   (options?: { readonly level?: number; readonly maxOutputLength?: number }) => Compressor
/** gzip + brotli, plus zstd when this runtime has it. */
export const available: (options?: { readonly maxOutputLength?: number }) => ReadonlyArray<Compressor>
/** True iff this runtime has zstd (Node ≥ 22.15). */
export const hasZstd: () => boolean
```

`gzipSync`/`gunzipSync`, `brotliCompressSync`/`brotliDecompressSync`,
`zstdCompressSync`/`zstdDecompressSync`. `zstd()` throws at construction (a plain `Error`
naming the Node ≥ 22.15 requirement) when `zlib.zstdCompressSync` is absent.
`maxOutputLength` passes through to Node to bound decompression output (decompression
bombs); default is Node's own. zstd defaults to level 3 (the benchmark's setting), gzip
and brotli to Node's defaults. The subpath is the only file in the package that imports
`node:zlib`; the main entry stays runtime-neutral.

### 3.5 Public helpers

**`StorageEncoding` (new core module, `effect-dynamodb`):**

```ts
/** The AttributeValue a packed attribute is stored as (S, B, NULL for null; undefined for undefined — no attribute). */
export const encode: (storedAs: PackedConfig, wire: unknown) =>
  Effect<AttributeValue | undefined, ValidationError>
/** Stored-form dispatch (§4.1) on an AttributeValue (DynamoDB JSON), B as bytes or base64. */
export const decode: (stored: AttributeValue | { readonly B: string } | undefined) =>
  Effect<unknown, ValidationError>
/** The same on an already-unmarshalled value: a JSON string, bytes or base64 B, or a native value. */
export const decodeUnmarshalled: (stored: unknown) =>
  Effect<unknown, ValidationError>
/** R1: DynamoDB size of the attribute VALUE as stored (excl. the attribute name). */
export const valueBytes: <S extends Schema.Top>(options: {
  readonly schema: S
  readonly value: Schema.Schema.Type<S>
  readonly storedAs?: PackedConfig | undefined      // omitted → native map size
}) => Effect<number, ValidationError>
/** DynamoDB limits, in bytes: { item: 409_600, transaction: 4_194_304 }. */
export const limits: { readonly item: number; readonly transaction: number }
```

The two forms are separate functions because they cannot be told apart by shape: an
unmarshalled one-key map `{ N: "5" }` or `{ L: [1, 2] }` is also a valid-looking
`AttributeValue`, so the caller states which form it passes.

`valueBytes` encodes through the schema (encode, with the `decode → encode` fallback
EventStore uses), packs, and measures with `internal/ItemSize.ts`'s `attributeBytes` —
the same rules the diagnosis uses. Item size = Σ `utf8(name)` + value bytes; the docs
say so.

**`EventStream.measureAppend` / `measureSnapshot` (R1, on `EventStream` and
`BoundEventStream`):**

```ts
measureAppend(streamId, events, expectedVersion, options?: Omit<AppendOptions<…>, "additionalItems">):
  Effect<AppendMeasurement, ValidationError, TableConfig>
measureSnapshot(streamId, state, asOfVersion):
  Effect<number, ValidationError, TableConfig>

interface AppendMeasurement {
  /** Item bytes of each event Put, in order — what DynamoDB's 400 KB item limit measures. */
  readonly events: ReadonlyArray<number>
  readonly sentinel: number | undefined
  /** Item bytes of the inline snapshot Put (options.snapshot). */
  readonly snapshot: number | undefined
  /** Bytes the stream-owned actions add to the TransactWriteItems request (4 MB limit). */
  readonly transactionBytes: number
}
```

Built by the **same item builder `append` uses** (refactored out of `append`, §7.2), then
measured with `itemBytes` / `transactItemBytes`, so the numbers are the bytes DynamoDB
would count for that exact request — envelope, keys, packed `data`, metadata, stream-index
attributes, contiguity check, expressions. `additionalItems` are excluded: building a
guarded additional put reads the table, and they are the caller's own items; the docs
tell callers to add them. This is caller-side planning, not a library pre-check:
`append` itself still never measures before sending (§8.1). `R` is `TableConfig` only
(the TTL attribute name for the sentinel); nothing is read or written.

**`EventStream.decodeStreamImage` (R2, on `EventStream` and `BoundEventStream`):**

```ts
decodeStreamImage(image: StreamImage): Effect<
  Option<StreamEvent<TEvent, StreamMetadata<TMetadata>>>,
  ValidationError
>
type StreamImage =
  | Record<string, AttributeValue | LambdaAttributeValue>   // DynamoDB JSON; B/BS may be base64
  | Record<string, unknown>                                  // already unmarshalled
```

- Returns **exactly** the `StreamEvent` the read paths return — it calls the same
  `decodeStreamEvent` (data schema-decoded, metadata through the metadata schema when
  declared, envelope validated).
- `Option.none()` when the image is not one of this stream's events (`__edd_e__ !==
  <stream>.event`: its snapshot, an idempotency sentinel, another stream, an entity), so
  a handler can fan one table's records across decoders. The type is read off the raw
  image before anything is unmarshalled (§7.7), so nothing in a foreign image can fail
  the decode. An image that *is* this stream's event but does not decode fails with
  `ValidationError`.
- Input detection: DynamoDB JSON when the `pk` attribute is an object with a string `S`
  member; otherwise unmarshalled. `B` and `BS` members given as strings are base64-decoded
  (Lambda and EventBridge Pipes deliver them that way; `@aws-sdk/util-dynamodb`'s
  `unmarshall` does not decode them), at any depth. In the unmarshalled form a packed
  attribute's `B` may arrive as a `Uint8Array` or still as base64 text — §4.3 shows the
  two are told apart from JSON text without ambiguity.
- `R = never`.

**`Entity.decodeMarshalledItem` (existing, extended):** applies the same image
normalisation (base64 `B`/`BS`), stored-form dispatch for the entity's packed and
dispatch-eligible fields (§4.6), sparse rebuild and field renames before the item-schema
decode. The last two fix **adjacent debt**: today it decodes the unmarshalled image
straight through `itemSchema`, so an entity with a `field:` rename or a `SparseMap` field
fails to decode its own stream images. Its error type is unchanged (`ValidationError`).
`Entity.itemSchema(entity)` stays a pure schema over unmarshalled items and does **not**
unpack (it cannot decompress); the streams guide says to use `decodeMarshalledItem` for
entities with packed fields.

---

## 4. Stored form

### 4.1 Dispatch table

Readers look at the stored value of a dispatch-eligible attribute (§4.6), never at the
current config:

| Stored | Unmarshalled as | Read as |
|---|---|---|
| absent | `undefined` | absent (optional field / no attribute) |
| `NULL` | `null` | `null` |
| `M`, `L`, `N`, `BOOL`, `SS`, `NS`, `BS` | object / array / … | **legacy native value**, unchanged (today's behaviour) |
| `S` | `string` | `JSON.parse` |
| `B` | `Uint8Array` | header (§4.2) → decompress per codec → UTF-8 decode (fatal) → `JSON.parse` |

The result is the attribute's **wire form as plain JSON** — the same value a native map
yields after `unmarshall` (for JSON-representable data, §4.4). It then goes through the
schema decode the field (or event, or state) uses today.

### 4.2 `B` header: byte 0

```
 bit   7   6   5 | 4   3 | 2   1   0
      layout ver | format|   codec
```

| Field | Bits | Values |
|---|---|---|
| layout version | 7–5 | `001` = v1 (this design). `000` invalid. `010`–`111` reserved for future layouts, which may add bytes after byte 0 (e.g. a dictionary id). |
| format | 4–3 | `00` = json. `01` = **binary — reserved for `SchemaBinary`**. `10`, `11` reserved. |
| codec | 2–0 | `000` none, `001` gzip, `010` brotli, `011` zstd. `100`–`111` reserved. |

Bytes 1… are the payload (the compressed UTF-8 JSON). v1 writers emit only:

| Byte 0 | Meaning |
|---|---|
| `0x21` | v1, json, gzip |
| `0x22` | v1, json, brotli |
| `0x23` | v1, json, zstd |

v1 readers also accept `0x20` (v1, json, uncompressed UTF-8 JSON in `B`), which no v1
writer emits but a future binary-aware writer might. Everything else fails with a
`ValidationError` naming the attribute and the byte: unsupported layout version ("written
by a newer effect-dynamodb?"), format `binary` ("reserved; not supported by this
version"), an unknown format or codec code, or an empty `B`.

### 4.3 Base64 disambiguation (unmarshalled stream images)

Every v1 header byte lies in `0x20`–`0x3F`, whose top six bits are `001000`–`001111`, so
the base64 text of a v1 `B` value always starts with one of `I J K L M N O P`. JSON text
produced by `JSON.stringify` starts with `{ [ " - 0-9 t f n` — never one of those. So in an
unmarshalled image, a string on a packed attribute that starts with `I`–`P` is base64 of a
`B` value; any other string is JSON. In DynamoDB JSON the `S`/`B` tag removes the question
entirely. (A future layout version must keep this property, or the helper must require
DynamoDB JSON for it; noted in the header comment.)

### 4.4 What a packed value contains

The packed value is **the attribute's wire form exactly as the existing write path
produces it**, serialised with `JSON.stringify`:

- **Entity field:** the field's value after the entity's write-schema encode (the same
  substituted schema whose output is marshalled for a map today — self dates become their
  wire primitive per their own `storedAs` annotation, `Redacted` is unwrapped, transforms
  own their wire form).
- **Event data:** `{ _tag, ...encodeToWire(memberSchema, event) }`, as today.
- **Snapshot state:** `encodeSnapshotState(state)`, as today.

So M, S and B of the same value decode through the same read schema and produce the same
result, which is what makes switching encodings rewrite-free and keeps raw rows
identical across a mixed stream (R3).

**JSON strictness.** Values that are not JSON are refused at write time with a
`ValidationError` (operation `<op>.packed`) naming the field, the path inside it and the
JS type: `bigint`, `Uint8Array`/`ArrayBuffer`/typed arrays, `Set`, `Map`, `Date`, any other
non-plain object (including one with `toJSON`), non-finite numbers, `undefined` as an array
element, symbols, functions. `undefined` object properties are omitted (as
`removeUndefinedValues` omits them from a map). The check runs in the same pass as
serialisation. These are exactly the values a map would have stored as `SS`/`B`/`N` or as a
marshalled class map; a field that needs them stays native, or uses a JSON-shaped schema
(`DateTimeUtcFromString`, `BigIntFromString`, `Uint8ArrayFromBase64`, an array instead of a
set).

**What does not apply inside a packed value:** anything that exists only because
DynamoDB's attribute types differ from JSON — marshalling (`Set` → `SS`, binary → `B`,
number → `N` text), `SparseMap` flattening, and `DynamoModel.configure` storage overrides
(they target top-level fields; the packed field's own `storedAs` is `Packed`). Storage
annotations *on nested schemas* (`.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))`)
are part of the field's schema and do shape its wire form, as they do for a map. The docs
state this explicitly. (The brief phrased it as "nested date storage overrides do not
apply"; see §15, item 38 for why the wire form follows the map's.)

### 4.5 Shape rule (`[EDD-9073]`)

`S` must be unambiguous: a legacy native value of a packed attribute must never itself be
an `S`. So the **encoded side** of a packed field (and of a state schema with
`snapshot.storedAs`) must be object- or array-shaped:

- accepted: `Struct`, `Class`, `Record`, `Array`, `Tuple`/`*WithRest`, a `Union` whose
  every member is accepted, any of those under `optional` / `optionalKey` / `NullOr` /
  a decoding default, `Suspend` resolved; and `Unknown` / `Any` / `Json` (an opaque
  document — with a documented caveat: switching an *existing* native field of such a type
  to `Packed` misreads any value that was stored natively as a string);
- refused: any scalar encoded side — `String`, `Number`, `Boolean`, literals, enums,
  template literals, `BigInt`, symbols, dates (self or transform: their wire form is a
  string or epoch number — this is the **TTL guard**: a TTL attribute is an epoch-seconds
  date), `Uint8Array` and other declarations, sets, and a union with any such member.

Event `data` always satisfies the rule (an event is a tagged struct), so it needs no check.

### 4.6 Dispatch eligibility

Which attributes readers dispatch on:

| Store | Attribute | Dispatched when |
|---|---|---|
| Entity | a model field | configured `Packed` **or** its encoded side passes the shape rule without `Unknown`/`Any`/`Json` (then a native `S`/`B` is impossible, so dispatch is free and safe) |
| EventStore | `data` | always (an event's native form is always `M`) |
| EventStore | `state` | `snapshot.storedAs` configured, **or** the state schema passes the shape rule without `Unknown`/`Any`/`Json` |
| EventStore | `metadata` | never (stays a map) |

This is what lets a field or stream go back from packed to native without a rewrite: the
reader still recognises `S`/`B` values written while it was packed. The cost on a native
value is one `typeof` check per eligible attribute per row.

---

## 5. Algorithms

Pure, AWS-free implementation in `packages/schema/src/internal/PackedCodec.ts`
(header constants, `packValue`, `unpackValue`, `stringifyStrict`, `isPackedShape`), wired to
items in `packages/effect-dynamodb/src/internal/Packed.ts` (attribute-level pack/unpack over
an item, image normalisation, base64).

### 5.1 Write

```
packValue(config, wire, registry):
  if wire === undefined → leave the attribute absent
  if wire === null      → store null (NULL)
  json  = stringifyStrict(wire)                      // §4.4; ValidationError on non-JSON
  if config.compression === undefined → S json
  bytes = utf8(json)
  if bytes.length < config.compression.threshold → S json
  c = registry.get(codec) ?? fail ValidationError(cause: CompressorNotRegistered(codec, "compress"))
  z = c.compress(bytes)                              // throw → ValidationError (§5.3)
  if 1 + z.length < bytes.length → B [header(codec), ...z]
  else                            → S json           // compression did not pay
```

- The threshold and the comparison use UTF-8 bytes, which is what DynamoDB charges for an
  `S` (`internal/ItemSize.ts`).
- Packing runs **after** the schema encode, rename and sparse flattening, **before**
  `toAttributeMap`, so every size measured afterwards (§8) is the stored size.
- A compressor that is registered but never needed (value under threshold) is never
  called; a missing one fails only when a value crosses the threshold.

### 5.2 Read

```
unpackValue(stored, registry):
  typeof stored === "string"   → JSON.parse(stored)
  stored instanceof Uint8Array → h = parseHeader(stored[0])            // §4.2
                                 payload = stored.subarray(1)
                                 if h.codec !== none:
                                   c = registry.get(h.codec) ?? fail ValidationError(cause: CompressorNotRegistered(h.codec, "decompress"))
                                   payload = c.decompress(payload)
                                 JSON.parse(utf8DecodeFatal(payload))
  otherwise                    → stored                                 // legacy native / null / absent
```

Runs **after** `fromAttributeMap`, **before** sparse rebuild and rename, keyed by the
stored attribute name. Decoding then proceeds exactly as today.

### 5.3 Errors

**New tagged error** (`packages/schema/src/Errors.ts`, re-exported):

```ts
export class CompressorNotRegistered extends Data.TaggedError("CompressorNotRegistered")<{
  readonly codec: CompressionCodec
  readonly direction: "compress" | "decompress"
  readonly entityType: string          // entity type, or "<stream>.event" / "<stream>.snapshot"
  readonly attribute: string           // stored attribute name
  readonly operation: string
}> {}
```

It is **never a member of an error channel**. A missing compressor fails the operation
with its existing `ValidationError` (same `entityType` and `operation`), whose `cause` is
a `CompressorNotRegistered` value naming the codec, direction and attribute. Packing is
opt-in, so this is what keeps the release minor: every public error type — entity,
aggregate, batch, transaction, collection, `Query` terminals and decoder, EventStream,
geo `nearby` — is exactly its 1.25.0 type, and a consumer that never packs (annotated
error unions, exhaustive `catchTags`) compiles unchanged. A caller that wants to react
to a misconfigured deployment inspects the cause:

```ts
Effect.catchTag("ValidationError", (e) =>
  e.cause instanceof CompressorNotRegistered ? alertOps(e.cause) : Effect.fail(e))
```

(The first cut of this PR added `CompressorNotRegistered` to every union, following the
`EmbeddingError` precedent; downstream review found that broke a never-packing monorepo's
`tsc` with 263 errors, so it was reverted to the cause form. `EmbeddingError` differs: an
entity with vector indexes declares it only through `VectorErrors<TVectorIndexes>`, i.e.
only when the feature is configured.) `test/ErrorChannels.types.test.ts` pins the 1.25.0
types for a packed and an unpacked entity alike.

**Everything else is `ValidationError`**, as any undecodable row or unencodable input is
today, with the attribute named in the cause:

| Case | `operation` |
|---|---|
| non-JSON value on write (§4.4) | `<op>.packed` |
| compressor `compress` throws | `<op>.packed` |
| bad header / unsupported version / reserved `binary` format / unknown code / empty `B` | `<op>.decode` (entity `decode`, stream `EventStore.decode`, …) |
| compressor `decompress` throws (corrupt payload, `maxOutputLength` exceeded) | `<op>.decode` |
| payload not valid UTF-8, or not valid JSON | `<op>.decode` |

### 5.4 New EDD codes (band 9071–9079, registry rows added to `DESIGN.md`)

| Code | Raised in | Condition |
|---|---|---|
| `EDD-9071` | `DynamoModel.ts` | `DynamoModel.Packed(...)` options invalid: `format` other than `"json"` (`"binary"` is reserved, not yet supported), unknown `compression.codec`, `threshold` not a non-negative safe integer, or an unknown option key |
| `EDD-9072` | `Entity.ts` (schema), `Aggregate.ts`, `DynamoClient.ts` | A packed field is a key or index attribute source: a primary-key or secondary-index composite (incl. collection-injected indexes), `timeSeries.orderBy`, a vector index filter field, or an aggregate discriminator / list / collection composite |
| `EDD-9073` | `Entity.ts` (schema), `EventStore.ts` | A packed field's (or packed snapshot state's) encoded side is not object/array-shaped — a scalar, a date (so never a TTL attribute), binary, a set, or a union with such a member — or the packed field does not exist on the model |
| `EDD-9074` | `Entity.ts` (schema) | A unique constraint names a packed field |
| `EDD-9075` | `Entity.ts` (schema) | A packed field is a `DynamoModel.ref` field |
| `EDD-9076` | `Query.ts`, `Entity.ts`, `internal/BoundCrud.ts`, `Transaction.ts` | A condition, filter or projection addresses a path inside a packed attribute, or applies anything but `attribute_exists` / `attribute_not_exists` to it (thrown when the expression is built) |
| `EDD-9077` | `Entity.ts` | An update applies anything but a whole-value `.set()` / `.remove()` to a packed field (`add`, `subtract`, `append`, `deleteFromSet`, any `path*`) — `ValidationError` at execution, like the #133 path-op refusals |
| `EDD-9078` | `Compression.ts` | A compressor registry is given two compressors for one codec, or a compressor whose `codec` is not `gzip` / `brotli` / `zstd` |
| `EDD-9079` | `EventStore.ts` | `makeStream` `storedAs` declares a key other than `data`, or a `storedAs` / `snapshot.storedAs` value that is not a `DynamoModel.Packed(...)` config |

Next free code after this PR: `EDD-9080`. (`9059`–`9061` stay reserved for PR #129.)

---

## 6. Entity integration

The plumbing follows `SparseMap`: derived once in `buildEntityDefinition`
(`packages/schema/src/Entity.ts`), carried on `EntityDefinitionData`, applied at the
points where sparse flattening/rebuilding happens today.

`EntityDefinitionData` gains:

- `packedFields: Record<domainName, PackedConfig>`
- `packedAttributes: Record<storedName, PackedConfig>` (after `field` renames)
- `dispatchAttributes: ReadonlySet<storedName>` (packed ∪ eligible, §4.6)
- `hasPackedFields: boolean`

### 6.1 Definition-time guards (`buildEntityDefinition`, beside the EDD-9020–9023 checks)

| Rule | Code |
|---|---|
| packed field does not exist on the model | `EDD-9073` (message: unknown field) |
| encoded side not object/array-shaped (incl. dates → TTL) | `EDD-9073` |
| primary-key / GSI / LSI composite, collection-owned index composite (checked again when `_injectIndex` adds one), `timeSeries.orderBy`, vector index filter field | `EDD-9072` |
| unique-constraint field | `EDD-9074` |
| `ref: true`, or a field resolved as a ref | `EDD-9075` |
| sparse | impossible by construction: one `storedAs` per field |

`timeSeries.appendInput` may include a packed field (it is written to the current item and
copied onto the event item, §6.7). A vector index *source* field may be packed (the
embedder reads the domain value before the write).

The key composer is untouched: a packed field can never be a composite, so no
`composeGsiKeysForUpdatePolicyAware` path ever sees one.

### 6.2 Write paths

New closure helpers in `Entity.ts`: `packFields(item): Effect<void, ValidationError>`
(in place, stored names) and `packAttribute(attr, wire)` (one
value → `AttributeValue`), resolving the registry with `Effect.serviceOption(Compression)`.
Exposed to siblings as `entity._packFields` (beside `_serializeSparseFields`).

| Path | Where | Change |
|---|---|---|
| `put` / `create` | `Entity.ts` `put` (after `serializeSparseFields(item)`) | `packFields(item)` |
| `upsert` / `guardedUpsert` | `Entity.ts` `upsert` (if_not_exists SET builder) | pack each packed value before it becomes `:v` |
| `update` record `.set()` (UpdateItem) | `Entity.ts` `runUpdate`, `encodedUpdatesMap` SET loop | `SET #f = :v` with `:v = packAttribute(f, wire)`; `null`/`remove` → `REMOVE #f` |
| `update` retain/read-merge path | `Entity.ts` `runUpdate` (`currentDomainItem` → `newItem` → `marshalledNewItem`) | unpack the read item (§6.3); packed attributes **not named** by the update are carried as their **stored `AttributeValue`** (never decoded and re-packed, so the "write only what differs" diff sees them unchanged); named ones are packed fresh |
| `updateOrCreate` | `Entity.ts` | as `update` |
| immutable assertions | `assertedImmutables` / `immutableMismatch` | for a packed immutable field, compare the stored value's **unpacked JSON** with the encoded payload (structural equality) — never bytes, which differ by codec and threshold |
| `Transaction.transactWrite` / `EventStore` `additionalItems` | `internal/TransactableOps.ts` `validateAndBuildPutItem` | `entity._packFields(item)` after `_serializeSparseFields` |
| `Batch.write` | via `validateAndBuildPutItem` | same |
| time-series `append` | `Entity.ts` `append` | pack each packed `appendInput` field once; the same `AttributeValue` is used in the current item's `SET` and the event item `Put` |
| cascade (`.cascade()`) | `SET #ref = :refData` | unaffected: refs cannot be packed; a ref target's packed field is stored **natively** inside the denormalised ref copy (packing is the owning entity's storage, not part of the model) |

### 6.3 Read paths

New `unpackFields(raw)` (in place, stored names, only `dispatchAttributes`) runs before
`deserializeSparseFields` in every decoder:

`decodeRecord` (→ `_decodeRecord`, used by Batch.get, Transaction.transactGet, Collection,
query/scan decoders), `decodeAs` (except `mode === "native"`, which returns the item **as
stored** — packed values stay `S`/`B` `AttributeValue`s, the point of native), `decodePartial`
(`versions()` / history snapshots), `decodeHistory` (time-series events), the soft-delete
decoders (`deleted.get` / `deleted.list`), the `ReturnValues` decodes of update/delete,
`Entity.decodeMarshalledItem` (§3.5), and the `select` projection decoder (§6.6).

`toDomainView` (key recomposition on restore, purge, sentinel composition) needs no
unpack: it reads composites only, and packed fields are never composites.

### 6.4 Expressions (conditions and filters)

Allowed on a packed field: `attribute_exists(f)` / `attribute_not_exists(f)` on the
**whole** field (`exists(t.lines)`, `{ exists: "lines" }`). Refused with `[EDD-9076]`, thrown
when the expression is built: any path below it (`t.lines.at(0).sku`, `t.details.total`),
any comparison / `between` / `in` / `begins_with` / `contains` / `size` / `attribute_type`
with it as an operand. One walker, `refusePackedPaths(expr, isPacked, describe)` in
`internal/Packed.ts`, is called from: `BoundCrud` `buildCondition` (put/update/delete
`.condition()`), `Entity.condition` (unbound), `Transaction.check`, the entity `filter`
path into `Query.filterExpr`, and `Query.filterExpr` itself (§7.5). The message names the
field, the encoding and the alternative (`filterBy` for reads; read-then-write for
conditions).

### 6.5 Updates

Only whole-value replacement: `.set({ f })` (packs the new value) and `.remove(["f"])` /
`set({ f: null })`. Refused with `[EDD-9077]` (a `ValidationError` at execution, from the
same normalisation step that refuses #133 path ops, `normalizeDerivedPathOps`): `.add`,
`.subtract`, `.append`, `.deleteFromSet` on `f`, and every `path*` op whose path starts at
`f` (`pathSet`, `pathRemove`, `pathAdd`, `pathSubtract`, `pathAppend`, `pathPrepend`,
`pathIfNotExists`, `pathDelete`) — including a top-level `pathSet((t) => t.f, v)`, which
the docs point at `.set({ f: v })`.

### 6.6 Projections

`select` / `selectPaths` may name a packed field only whole. A nested path is
`[EDD-9076]`. A projected packed field comes back as its **parsed JSON wire form** (not
schema-decoded) — the same contract as an unprojected map field in a raw projection, and
as EventStore raw rows (§7.4). Implemented by the `QueryState.rawRow` hook (§7.4), which
the entity query builder sets to `unpackFields` **for the entity's own rows only**
(`ownRowsRawRow`): `ignoreOwnership()` lets rows of other types through, and a plain
string attribute of another type that shares a name with a packed or dispatch-eligible
attribute must come back exactly as 1.25.0 returned it — never `JSON.parse`d into a
`ValidationError`. The hook reads `__edd_e__` (borrowed into the projection and stripped
again when not selected); a row without it is not attributable and is left as is. The
same gate applies to scans, bound and unbound queries, `BoundQuery` and collections (a
row of a non-member type is untouched); aggregates already pick the edge entity by
`__edd_e__`; a vector search hit is scoped to the entity by its partition value, and is
left untouched if it carries a different `__edd_e__`.

The hook is only installed when it can matter: not on an entity with no dispatch
attribute, and not on a projection that names none of them (`QueryRawRow.attributes`) —
then nothing is borrowed and no row is examined.

### 6.7 Lifecycle

| Feature | Behaviour |
|---|---|
| `versioned: { retain: true }` | `buildSnapshotItem` copies the stored item (`currentRaw`: `S` → string, `B` → `Uint8Array`, re-marshalled losslessly), so snapshots hold the stored bytes as-is. |
| `softDelete` | the tombstone copies stored values as-is; `restore` rebuilds keys from `toDomainView` and writes the stored packed values back unchanged. |
| `purge` | deletes by key; unaffected. |
| `timeSeries` | current item and event item get the same packed value (§6.2); `history()` unpacks event items. |
| `put` over an existing item | re-packs every packed field in the current config — the natural "migrate on write". |

### 6.8 Type level

- `Entity` and the schema package's `EntityDefinition` gain a trailing type parameter
  `TPackedFields extends string = never`, extracted from the configured model with
  `ExtractPackedFields<ConfiguredModel<TModel, TAttrs>>` (as `ExtractIdentifier` is).
- `PathBuilder<Root, Model, Keys, TPacked>` maps a top-level key in `TPacked` to
  `PackedPath<Root, V>`: a branded leaf with no property, `.at`, `.entry` or `.size`
  accessors, **not** assignable to `Path`. So comparisons, `size`, `contains` and
  `beginsWith` in PathBuilder-typed callbacks (conditions, filters) reject it at compile
  time; `exists` / `notExists` and `select` callbacks accept `Path | PackedPath`.
- The marker check is guarded against `any` and `never` (`0 extends 1 & T`, `[T] extends
  [never]`): a bare conditional distributes over `any`, which turned every `Schema.Any`
  field into `PackedPath | ArrayPath | …` and broke `eq(t.anyField, 1)` even on entities
  with no packed field. A field that is not packed maps exactly as in 1.25.0 (pinned
  against a verbatim copy of the 1.25.0 mapping in `test/PathBuilder.types.test.ts`); a
  packed `any` field is marked whole (`PackedValue<any>`) so it is still a `PackedPath`.
- `Entity.Marshalled<E>` gains the `B` member.

Only the PathBuilder-typed surface is guarded at the type level. The record update ops
(`add`, `subtract`, `append`, `deleteFromSet`) take an untyped `Record<string, …>` for
every entity, and the `path*` update ops take raw `segments`, so neither can see
`TPackedFields`; typing them per entity would change their signatures for every entity,
which is out of scope here. They are refused at run time with `[EDD-9077]` (§6.5).

The runtime guards stay authoritative for shorthand conditions, the record and `path*`
update ops, untyped callers, and every `Query`-level path (EventStore).

### 6.9 Aggregates

Aggregates build and read their items themselves (`Aggregate.ts` decomposition writes
`toAttributeMap(attrs)`, assembly reads `fromAttributeMap` rows), not through entity ops, so
the edge entity's packing is applied explicitly:

- **Write:** the decomposition item builder (the `toAttributeMap(attrs)` site, ~`Aggregate.ts:3267`)
  calls the edge entity's `_packFields` on `attrs` before marshalling.
- **Read:** every `fromAttributeMap` that feeds assembly or list decoding (~`:2170`,
  `:3703`) runs the edge entity's `_unpackFields` chosen by the row's `__edd_e__`.
- **Diff:** `update` compares decomposed groups **before** packing, so an unchanged packed
  value is not rewritten.
- **Guards:** `Aggregate.make` refuses a packed edge-entity field used as a discriminator,
  a `many` edge `sk.composite`, a list or collection composite (`[EDD-9072]`).

### 6.10 Collections, Batch, Transaction, vector search

All decode through `entity._decodeRecord` and write through `validateAndBuildPutItem`, so
they inherit §6.2–§6.3. A collection-level `filter` refuses a path that is packed in **any**
member, naming the member, and an unbound collection `Query.select` borrows `__edd_e__`
into its projection (stripped again after the raw-row hook ran) so each row's packed
attributes are read by its member. Vector-index source fields read the value, never the
stored form: the update paths unpack the item they read (or the read-merge item, on a
copy that leaves the stored bytes for the write diff) before deriving the source text,
and a vector search `.select()` returns a projected packed field as parsed JSON. Filter
fields cannot be packed (§6.1).

---

## 7. EventStore integration

### 7.1 Config

`makeStream` validates `storedAs` (`[EDD-9079]`) and `snapshot.storedAs` (`[EDD-9079]`, plus
`[EDD-9073]` on the state schema's shape). Resolved: `dataStoredAs`, `stateStoredAs`,
`stateDispatch` (§4.6).

### 7.2 Write paths

| Function | Change |
|---|---|
| `append` — event items | the per-event item builder (extracted from the `Effect.forEach(events, …)` body into `buildEventItem(…)`, shared with `measureAppend`) packs `eventData` when `dataStoredAs` is set: `item.data = packAttribute("data", eventData)` |
| `append` — inline snapshot | `snapshotPut` packs `state` when `stateStoredAs` is set (shared builder `buildSnapshotItem(…)`, also used by `writeSnapshot` and `measureSnapshot`/`measureAppend`) |
| `writeSnapshot` | same builder → packed `state` |
| `commandHandler` | no change of its own: it appends (inline snapshot via `append({ snapshot })`) and calls `writeSnapshot` (after-append) |
| idempotency sentinel | unchanged (no data) |

Packing happens before `toAttributeMap`, so the `TransactWriteItems` request carries the
stored bytes (§8).

### 7.3 Read paths

| Function | Change |
|---|---|
| `decodeStreamEvent` | `data = unpack(raw.data)` (always dispatched) before the union decode. Every event read goes through it: `read`, `readFrom`, `currentVersion` / `headAbove` (decode the one row), `readLatest` (delta events), `readIndex`, `query.events`, `query.index` (all projections, incl. `"keys"` → LSI fetch / GSI `BatchGetItem` hydration, whose rows reach the same decoder), `fold` / `foldFrom`, `decodeStreamImage` |
| `decodeSnapshotItem` | `state = unpack(raw.state)` when `stateDispatch` before the state-schema decode: `readSnapshot`, `readLatest` (verified `Query` and `verifySnapshot: false` `GetItem`), `commandHandler` loads |
| `indexDecoder` | unchanged; it wraps `decodeStreamEvent` |

### 7.4 Raw rows (`Query.select` / `selectPaths`) — R3

`select` replaces a query's decoder with the identity, so today a raw row's `data` is
whatever `fromAttributeMap` produced — a string or bytes for a packed value. New
`QueryState.rawRow?: (raw) => Effect<raw, ValidationError>`, set
via `Query.make({ rawRow })`; `select`, `selectPaths` and `selectProjected` use
`state.rawRow ?? Effect.succeed` instead of the identity. `buildEventsQuery` and
`buildIndexQuery` set it to "unpack `data` if present, on this stream's event rows" (a row
whose `__edd_e__` is another type, reachable with `Query.ignoreOwnership`, is untouched; the
hook declares `reads: ["__edd_e__"]`, `attributes: ["data"]`). Hydrated (`"keys"` GSI) rows
pass through the same decoder after `BatchGetItem`, so the `"keys"` path is covered without
a separate hook; what the hook borrowed into the hydrating fetch is stripped after it ran,
as on the base-table path.

Result: for a stream holding a mix of `M`, `S` and `B` items, a raw row's `data` is the
same plain JSON value in all three cases — parsed or decompressed, **not schema-decoded** —
through `"all"`, `"withoutMetadata"` and `"keys"` indexes alike, and through
`query.events`.

### 7.5 Filters and projections

`Query.filterExpr` on a query whose state lists packed attributes (`QueryState.packed:
ReadonlyArray<{ attribute, describe }>`, set by `buildEventsQuery` / `buildIndexQuery` when
`dataStoredAs` is set, and by entity queries for their packed fields) runs
`refusePackedPaths`: `data.amount` (or `eq(data, …)`) throws `[EDD-9076]`:

```
[EDD-9076] EventStream "Ledger": the filter addresses "data.amount", but `data` is stored
packed (format "json"): DynamoDB sees one opaque string or binary value and cannot evaluate a
path inside it. Use Query.filterBy((event) => event.data.amount > 100), which runs on the
decoded event inside the same paging loop.
```

`select(["data.amount"])` / `selectPaths([["data", "amount"]])` throw the same code;
`select(["data"])` is allowed. A stream **without** `storedAs.data` keeps accepting
`data.*` filters (a stream that went back from packed to map will not match its packed
rows — the docs say so).

### 7.6 Stream indexes and projections

Unaffected. `data` is never a key; `"all"` and `"withoutMetadata"` project it whatever its
type (`withoutMetadata` is `INCLUDE` of the fixed `EVENT_ITEM_ATTRIBUTES`, which already
includes `data`); `"keys"` hydrates from the table. This is why the stored form is
self-describing instead of carrying an `__edd_enc__` marker: a new attribute would be
missing from every deployed `withoutMetadata` index, and a GSI's projection cannot be
updated in place.

### 7.7 DynamoDB Streams — R2

`decodeStreamImage` (§3.5) first reads `__edd_e__` straight off the raw image (`{ S }` in
DynamoDB JSON, a string unmarshalled) and returns `Option.none()` for any other type
**before** unmarshalling anything — so a foreign image holding an attribute the SDK cannot
unmarshall (`N: "12345678901234567890.5"`, an invalid base64 `B`) is skipped, not a
`ValidationError` that fails a whole Lambda batch. Only then does it normalise the image
(DynamoDB JSON vs unmarshalled; base64 `B`/`BS` at any depth) and call `decodeStreamEvent`
— so its output is the read paths' `StreamEvent`, by construction. The same raw-image
check gates `Entity.decodeMarshalledItem`: an image naming another entity type is decoded as
1.25.0 decoded it, its attributes never read as packed values (it still fails the schema
decode with a `ValidationError`, now never a thrown defect). Snapshot images return `Option.none()`
(a snapshot-image decoder is out of scope, §15).

---

## 8. Size accounting

### 8.1 Diagnosis (no pre-checks)

Per the repo's diagnose-on-failure rule, nothing new is pre-checked. Because packing
happens before marshalling, every existing measurement already sees stored bytes with no
change to `internal/ItemSize.ts` or `internal/WriteDiagnosis.ts`:

- `append`'s failure diagnosis (`sendAppendTransaction` → `diagnoseFailure`) measures the
  `TransactWriteItems` it sent — packed `data`, packed inline `state` — when it attributes an
  item over 400 KB or a request over 4 MB; `AppendTooLarge` counts items, unaffected.
- `writeSnapshot`'s diagnosis measures its packed `Put`.
- Entity put/update/transaction diagnosis and `Batch.write`'s size-based chunking of
  versioned-put transactions measure packed items.

Tests assert these numbers equal the stored bytes (R4).

### 8.2 Caller-side planning — R1

`StorageEncoding.valueBytes` (a value under a config, or native), `stream.measureAppend`
(each event item, sentinel, inline snapshot, stream-owned transaction bytes) and
`stream.measureSnapshot` (§3.5), plus `StorageEncoding.limits`. They share the builders and
size functions the write and diagnosis use, so a measurement is exact for the request
`append` would send at that moment. Compression output can vary across compressor
versions, so a plan made by one runtime is exact for that runtime; the docs advise a
margin when planning on one runtime and writing on another.

### 8.3 Inline snapshots — R4

The inline snapshot rides in the append transaction; with `snapshot.storedAs` +
compression, its `Put` carries the compressed `B` (~48 KB state → ~4 KB per the
benchmark), and both the 4 MB request diagnosis and the 400 KB item attribution count that
size. `measureAppend({ snapshot })` reports it.

---

## 9. Schema evolution

A packed value is decoded through the current schema exactly as a map value is, so the
evolution rules are the map's: an added optional field decodes on old values, a removed
field is ignored, a required field added without a default fails, a type change fails — on
`M`, `S` and `B` alike. JSON adds no positional or fingerprint coupling (unlike
`SchemaBinary`'s fingerprint mode, which is out). Differences from a map that the docs list:

- JSON has no `undefined`, sets or binary; the strictness rule (§4.4) keeps them out at write
  time rather than letting them change shape silently.
- A storage annotation change on a nested date (ISO → epoch) changes the wire form of new
  values only; the tolerant date decoders read both, as for a map.
- The header's layout version and reserved codes make a future wire change detectable (a
  `ValidationError` naming the byte) rather than a silent misdecode.

---

## 10. Migration and rollout

- **Map → packed:** set `storedAs`. New writes are packed; existing items stay native and
  keep decoding (§4.1). Nothing is rewritten, no Streams records are produced for old items,
  and no WCU is spent. Optional background re-encode: an entity `put` (or `update().set()`
  of the field) rewrites it packed; events are immutable and the library does not offer a
  re-encode for them (the application may `UpdateItem` them if it wants to).
- **Rollout order:** every *reader* must run a version with this feature before any
  *writer* enables packing — older versions fail to decode `S`/`B` values (a
  `ValidationError`). That includes DynamoDB Streams consumers, which must move to
  `decodeStreamImage` / `decodeMarshalledItem`. The docs put this first.
- **Changing codec:** new writes use the new codec; keep registering the old one for as
  long as values written with it exist.
- **Packed → native:** remove `storedAs`; eligible attributes (§4.6) still decode their
  packed values.
- **Stream indexes / GSIs projecting `data` or a packed field:** nothing to redeploy.

---

## 11. Performance notes

Read: per eligible attribute, one `typeof`; per packed `S`, one `JSON.parse`; per `B`, one
header byte, one sync decompress, one `TextDecoder` pass. The schema decode is unchanged
(a fold over raw rows skips it entirely, R3). Write: one strict serialisation pass; one
UTF-8 encode and one compress only when compression is configured and the JSON is over the
threshold. The registry lookup is per op, not per value. No measurable cost for entities
and streams that do not use the feature beyond the eligibility check.

---

## 12. Testing

### 12.1 Unit — schema package

- `test/Packed.test.ts`: `Packed` validation (`EDD-9071` for each case, `"binary"` message),
  defaults (threshold 1024), `isPackedConfig`, `getPackedFields`, `configure` with
  `storedAs: Packed` + `field` + `immutable`.
- `test/PackedCodec.test.ts`: header encode/decode for every valid and reserved value;
  `packValue` (absent, null, under threshold → S, over threshold smaller → B, over threshold
  not smaller → S, threshold 0, exact boundary); `unpackValue` dispatch for every row of
  §4.1; strict JSON refusals for each non-JSON type with path in the message; base64
  first-character property for all 32 v1 header bytes; `isPackedShape` accept/refuse matrix.
- `test/Compression.test.ts`: `make` (`EDD-9078` duplicates / unknown codec), `layer`.
- Entity definition guards: `EDD-9072` (pk, sk, GSI pk/sk composites, collection index,
  `timeSeries.orderBy`, vector filter), `EDD-9073` (string, number, date, TTL-style epoch
  date, `Uint8Array`, set, mixed union, missing field), `EDD-9074`, `EDD-9075`.
- The existing `aws-free-guard.test.ts` must still pass: no `node:zlib`, no `@aws-sdk` in
  the schema package's runtime graph or `.d.ts`.

### 12.2 Unit — effect-dynamodb (mocked `DynamoClient`)

- `test/compression-node.test.ts`: gzip/brotli/zstd round-trip, `available()`,
  `maxOutputLength` enforcement, `zstd()` error when unavailable (stubbed).
- `test/StorageEncoding.test.ts`: `encode` / `decode` / `decodeUnmarshalled` / `valueBytes` (equals
  `attributeBytes` of the stored value; native vs packed), `limits`.
- `test/Entity.packed.test.ts`, capturing requests: put/create (S and B on the wire),
  upsert, record `.set` (SET with packed `:v`), `.remove`, retain read-merge path (unnamed
  packed attribute byte-identical, not in the SET list), immutable assertion by unpacked
  equality (same JSON under a different codec passes, different JSON fails), transactWrite,
  Batch.write, time-series append (same value on current and event item), version snapshot
  copy, soft delete + restore copy, decode of M / S / B / NULL / absent through get, query,
  scan, batch get, transactGet, collection, history, versions, deleted list; `asNative`
  returns stored `S`/`B`; projections return parsed JSON, nested projection `EDD-9076`;
  condition/filter refusals (`EDD-9076`, each operator, nested path, shorthand and
  callback); update refusals (`EDD-9077`, each op); a `ValidationError` caused by
  `CompressorNotRegistered` on write over
  threshold without a registry, on read of a `B` with an unregistered codec, and not raised
  under threshold; registry precedence (explicit `DynamoClient.make({ compressors })` >
  ambient at bind > ambient at run time); dispatch-eligible native field reads a packed
  value after `storedAs` is removed; `decodeMarshalledItem` with base64 `B`, renamed field
  and sparse field (debt fix).
- `test/Aggregate.packed.test.ts`: edge entity with a packed field — create, update (diff
  does not rewrite unchanged packed values), assembly read, list; `EDD-9072` for a packed
  discriminator / list composite.
- `test/EventStore.packed.test.ts`: `EDD-9079` / `EDD-9073`; append with `storedAs.data`
  (S under threshold, B over); inline and async snapshot packed; every read path of §7.3 on
  M / S / B rows; mixed stream through `query.events`, `"all"` / `"withoutMetadata"` /
  `"keys"` (LSI fetch and GSI BatchGet) with `Query.select` raw rows → identical plain JSON
  (R3); filter / select refusals with the `filterBy` hint (`EDD-9076`); no refusal on an
  unpacked stream; `decodeStreamImage` — DynamoDB JSON with `B` as `Uint8Array` and as
  base64, unmarshalled with `B` as `Uint8Array` and as base64, metadata schema decode,
  `Option.none()` for snapshot / sentinel / foreign images, `ValidationError` for a
  malformed event image, result `deepStrictEqual` to the `read` result for the same item
  (R2); `measureAppend` / `measureSnapshot` equal `itemBytes` / `transactItemBytes` of the
  request the mock captures from `append` / `writeSnapshot` (R1); the 400 KB / 4 MB
  diagnosis on a packed append reports the packed (stored) byte counts (R4).
- `test/Query.test.ts`: `rawRow` hook used by `select` / `selectPaths` / `selectProjected`
  and the hydration path; `packed` refusals.

### 12.3 Types

- `test/Entity.types.test.ts`: `storedAs: Packed` on a scalar field is a compile error;
  `PackedPath` rejected by `eq`, `gt`, `.size()`, `contains`, `beginsWith`, nested
  properties and `.at()`; accepted by `exists`, `notExists`, `select`; `Entity.Marshalled`
  admits `B`. (The record and `path*` update ops are untyped, so their `[EDD-9077]`
  refusals are tested at run time in `Entity.packed.test.ts`, §6.8.)
- `test/EventStore.types.test.ts`: `storedAs` admits only `data`; `snapshot.storedAs`
  only a `PackedConfig`; error channels are exactly 1.25.0's; `measureAppend`
  / `decodeStreamImage` signatures on bound and unbound streams.

### 12.4 Connected (`test/connected.test.ts`, mandatory — gate 4)

DynamoDB Local (`DYNAMODB_ENDPOINT`). Node 24 in CI has zstd.

- Entity: packed field round-trip with gzip and zstd, value under and over threshold; the
  same item written native, then packed `S`, then packed `B` (config changed between
  writes), read back each time; `update().set` / `remove`; retain snapshots; soft delete +
  restore; transactWrite; Batch.write; a 300 KB-as-JSON value that compresses under the
  item limit is accepted.
- EventStore: a stream whose events are written in three phases (map, json, json+zstd)
  read through `read`, `readFrom`, `readLatest`, `readIndex` on an LSI `"all"`, a GSI
  `"withoutMetadata"` and a GSI `"keys"` index, and through `Query.select` raw rows on each
  (R3); a ~48 KB state inline snapshot (compressed `B`) and an async `writeSnapshot`, both
  read back via `readLatest` with and without `verifySnapshot: false` (R4); an append
  whose packed event item measures exactly 409,600 bytes by `measureAppend` is accepted and
  409,601 is rejected with the diagnosed `ValidationError` reporting the packed size (R1,
  R4); `decodeStreamImage` on an item fetched with the raw client and rewritten into
  Lambda's DynamoDB-JSON shape with base64 `B` (R2). A real Streams `GetRecords` read
  would need `@aws-sdk/client-dynamodb-streams` as a dev dependency; the fetched-item
  simulation exercises the same bytes, so it is not added.

### 12.5 Canonical GSI-composite shapes

**Not applicable.** A packed field can never be a primary-key or index composite
(`EDD-9072`), so `KeyComposer` and `composeGsiKeysForUpdatePolicyAware` are untouched and
no composer fixture changes. The six canonical shapes need no new coverage; the guard tests
in §12.1 prove a packed field cannot enter a composite.

### 12.6 Other gates

`pnpm lint`, `pnpm check`, `pnpm test`, doctest sync, examples run against DynamoDB Local.

---

## 13. Documentation and examples

| Artifact | Change |
|---|---|
| `examples/guide-packed-storage.ts` (new) | entity packed field; registering compressors (`DynamoClient.layer({ compressors })`); EventStore `storedAs` + compressed inline snapshot; raw rows; `measureAppend`; `decodeStreamImage`; migration (native → packed on one item) |
| `guides/packed-storage.mdx` (new, sidebar under Guides) | backed by the example: when to use (bulk reads, large values), stored form and header, threshold and smaller-only, compressors and runtimes, what a packed value contains (§4.4) and the nested-storage note, guards and refusals, sizing (JSON ~18–27% larger than map; use the helpers), schema evolution, migration and rollout order |
| `guides/streams.mdx` + `examples/guide-streams.ts` | base64 `B` in Lambda / EventBridge Pipes images; `decodeMarshalledItem` with packed fields; `EventStream.decodeStreamImage`; `itemSchema` does not unpack |
| `tutorials/event-sourcing.mdx`, `guides/modeling.mdx`, `guides/sparse-maps.mdx` | one-paragraph pointers to the new guide (`storedAs` options list in modeling) |
| `DESIGN.md` | §7 "Packed Storage" (short, this commit); EDD registry rows 9071–9079 (this commit); §12 EventStore paragraph, §15 error taxonomy and "Declared Errors per Operation" (implementation commits) |
| `CLAUDE.md` | module structure (`Compression`, `StorageEncoding`, `compression/node`), test counts |
| `README.md` | feature list mention |
| changeset | `minor`, all four packages; `pnpm changeset version` in the PR (Release Workflow) |

---

## 14. Semver and compatibility

`minor`. Nothing changes for code that does not opt in:

- Default storage stays native; no attribute is added to any item.
- `R` of every operation is unchanged (`Effect.serviceOption`).
- Error channels are unchanged: a missing compressor is a `ValidationError` whose `cause`
  is `CompressorNotRegistered` (§5.3), so annotated error unions and exact-type assertions
  written against 1.25.0 keep compiling.
- `Entity` / `EntityDefinition` gain a trailing defaulted type parameter.
- `DynamoClient.layer` / `layerConfig` return `Layer<DynamoClient | Compression, …>` only
  when given `compressors` (overloads); calls without it keep `Layer<DynamoClient, …>`, so
  existing annotations remain valid.
- `Entity.decodeMarshalledItem` now honours renames, sparse maps and base64 `B` — images
  that failed before now decode (behaviour fix, changelog).
- Reading: any version without this feature cannot read packed values (§10 rollout).

---

## 15. Scoping decisions

Every item in issue #147 (body and comment), the consumer requirements, and the boundaries
this design introduced. **Source** says who decided.

| # | Item (issue / brief) | Decision | Source |
|---|---|---|---|
| 1 | Encoding `"map"` (default) | **In, unchanged default** | issue; user |
| 2 | Option shape `makeStream({ encoding: { data, compression } })` | **Changed** → `storedAs: { data: DynamoModel.Packed(...) }` + `snapshot.storedAs`, one config shared with Entity (§3.3) | user (one shared config); naming: design |
| 3 | Encoding `"json"` (`S`, `JSON.stringify` of the encoded event incl. `_tag`) | **In** (§4.4) | issue; user |
| 4 | Encoding `"binary"` (`SchemaBinary`, `B`) | **Out**; header reserves format `01` (§4.2) | user |
| 5 | SchemaBinary fingerprint mode | **Out** (with binary) | user |
| 6 | Compression for json, codecs gzip / brotli / zstd | **In** | issue; user |
| 7 | Compressed payload stored as `B` | **In** (§4.2) | issue; user |
| 8 | `threshold` (payloads below stored uncompressed) | **In**, default 1024 bytes of UTF-8 JSON | issue; user |
| 9 | Fall back to uncompressed when compression does not save bytes (open question) | **In**: compress only if `1 + compressed < json bytes` | issue (open Q); user |
| 10 | Optional zstd `dictionary` | **Out** | user |
| 11 | "Compression should default to zstd" (comment) | **Changed**: `codec` required, no default — zstd is unavailable before Node 22.15; docs recommend zstd (§3.1) | design |
| 12 | Every item says how it is encoded — marker attribute (`__edd_enc__`) | **Out**: breaks deployed `"withoutMetadata"` INCLUDE projections (§7.6) | user |
| 13 | … or a header byte for `B` | **In**: v1 header byte, layout version + format + codec (§4.2) | user; layout: design |
| 14 | Codec version recorded for `binary` | **Changed**: a layout version for every `B` value (bits 7–5) covers it; binary itself out | design |
| 15 | Readers decode by the stored form, not the current setting | **In** (§4.1, §4.6), incl. packed → native | user; eligibility rule: design |
| 16 | Migration optional; background re-encode or leave as is | **In** as documented behaviour (§10); no library re-encoder for events | issue; user |
| 17 | `append` / `commandHandler` encode (and compress) per event | **In** (§7.2) | issue; user |
| 18 | Size checks and diagnosis count stored bytes; `AppendTooLarge` / 400 KB diagnosis unchanged | **In**: no pre-checks; diagnosis measures the packed request (§8.1) | issue; user |
| 19 | Reads: `read`, `readFrom`, `readRange`, `readLatest`, `readIndex`, `query.events` / `query.index`, snapshot replay | **In** (§7.3). `readRange` does not exist in the codebase; range reads are `readFrom` and `query.events` + `Query.where`, both covered | issue; user |
| 20 | `Query.select` raw rows return decoded plain JSON | **In** for every index projection and the `keys` BatchGet path (§7.4) — R3 | issue; user; consumer |
| 21 | DynamoDB Streams helper (`NewImage` → `StreamEvent`, marker-driven) | **In** as `decodeStreamImage` (§3.5, §7.7) — R2; base64 `B` | issue; user; consumer |
| 22 | Stream index projections unaffected | **In** as stated (§7.6) | issue |
| 23 | Filters on `data.x` refused at build time with a clear error naming the encoding | **In**: `[EDD-9076]`, points to `Query.filterBy` (§7.5). The Query module's combinator is `Query.filterExpr` (there is no `Query.filter`) | issue; user |
| 24 | Snapshots: same option for inline / async state (possibly in scope) | **In** (`snapshot.storedAs`) — R4 | issue; user |
| 25 | Metadata: probably stays a map | **In as map**; type admits no `storedAs.metadata` | issue; user |
| 26 | Entity attributes ("a later extension, not part of this issue") | **Changed → In**: `storedAs: DynamoModel.Packed()` on entity fields; aggregates via edge entities (§6) | user |
| 27 | Open Q: one stream-wide encoding or per-event-type override | **Stream-wide only**; per-type out | user |
| 28 | Open Q: default threshold | **1024** | user |
| 29 | Open Q: exposing fingerprint mode | **Out** | user |
| 30 | Open Q: zstd / brotli optional for runtimes without them | **In**: compressors are pluggable; `NodeCompression.zstd()` errors on Node < 22.15, `available()` omits it | user; design |
| 31 | Not in scope: changing the default encoding | **Out** | issue |
| 32 | Not in scope: re-encoding existing data | **Out** | issue |
| 33 | R1 stored-size helper (value under a config; full event item incl. metadata) | **In**: `StorageEncoding.valueBytes`, `stream.measureAppend`, `stream.measureSnapshot`, `StorageEncoding.limits` (§3.5, §8.2) | consumer |
| 34 | R1: `measureAppend` measuring caller `additionalItems` | **Out**: building guarded puts reads the table; documented that callers add their own | design |
| 35 | Entity-level item-size measure (`measurePut`) | **Out**: not requested; `valueBytes` + `limits` cover field planning | design |
| 36 | R2 accept unmarshalled images too | **In**: auto-detected; base64 vs JSON disambiguated by the header's base64 range (§4.3) | consumer; design |
| 37 | Snapshot-image decoder for Streams | **Out**: `decodeStreamImage` returns `none` for snapshots; not requested | design |
| 38 | Packed value = field's encoded form; "nested date storage overrides do not apply" | **Changed (narrowed)**: the wire form is the one map storage already writes (so M/S/B decode identically and raw rows match across a mixed stream); storage-*layer* concerns — marshalling, sparse, `configure` overrides — do not apply inside; storage annotations on nested schemas still shape the wire form (§4.4). Using the field's raw codec instead would make self dates (`DateTimeUtc`) non-JSON | design — **please confirm** |
| 39 | Non-JSON wire values (bigint, binary, sets, dates as objects) | **Refused at write** with `ValidationError` naming the path (§4.4) | design |
| 40 | Shape rule: packed only on object/array-shaped encoded sides | **In** (`EDD-9073`, §4.5): keeps `S` unambiguous; doubles as the TTL guard | design |
| 41 | Guards: key composite, TTL, unique, ref, sparse | **In** (`EDD-9072`–`9075`; sparse impossible by construction) | user |
| 42 | Expressions: only `attribute_exists` / `attribute_not_exists` on the whole field | **In** (`EDD-9076`) | user |
| 43 | `attribute_type(f, "M")` on a packed field (useful to find unmigrated items) | **Not added** (refused like other operators) — can be widened later | design: your call |
| 44 | Updates: whole-value set / remove only | **In** (`EDD-9077`) | user |
| 45 | Projections: whole field only | **In** (`EDD-9076`); projected value is parsed JSON | user |
| 46 | Versioned snapshots / softDelete / timeSeries copy stored values as-is | **In** (§6.7) | user |
| 47 | Retain read-merge update carries unnamed packed values byte-identical | **In** (§6.2) — avoids rewriting values on unrelated updates | design |
| 48 | Immutable packed fields compared by unpacked JSON, not bytes | **In** (§6.2) | design |
| 49 | Type-level guards where PathBuilder is typed | **In** for PathBuilder-typed conditions, filters and projections: `TPackedFields` type parameter, `PackedPath` (§6.8). The untyped record and `path*` update ops are guarded at run time only (`[EDD-9077]`) | user |
| 50 | Compressor registration mechanism | `Compression` `Context.Service`, resolved with `Effect.serviceOption` (no new `R`); `DynamoClient.layer/layerConfig({ compressors })`, `DynamoClient.make({ compressors })`, `Compression.layer` (§3.4) | user (recommended DynamoClient); mechanism: design |
| 51 | Fail-fast check at `DynamoClient.make` that every configured codec is registered | **Not added**: a read-only process would be forced to register codecs it never writes; the op-time tagged error is the single failure mode | design: your call |
| 52 | Unregistered codec → tagged error naming the codec | **Changed**: `CompressorNotRegistered` names it, as the `cause` of a `ValidationError` — not a new error-channel member, which broke never-packing consumers (§5.3) | user |
| 53 | Corrupt / unsupported packed values | **`ValidationError`** (§5.3), like any undecodable row | design |
| 54 | Node compressors from a subpath (`effect-dynamodb/compression/node`) | **In**; `maxOutputLength` option added for decompression bombs | user; option: design |
| 55 | Compressor tuning in the config (level, quality) | **Out of the config**: on the compressor factory (§3.1) | design |
| 56 | `Entity.decodeMarshalledItem` ignores renames and sparse maps (found while designing R2) | **In — adjacent debt** fixed in the same change (§3.5) | design (golden rule) |
| 57 | `Entity.itemSchema` unpacking | **Out**: a pure schema cannot decompress; documented (§3.5) | design |
| 58 | Aggregates build/read items outside entity ops | **In**: explicit pack/unpack + guards in `Aggregate.ts` (§6.9) | design (required by "aggregates inherit") |
| 59 | Real DynamoDB Streams (`GetRecords`) connected test | **Out**: simulated from a fetched item; avoids a new dev dependency (§12.4) | design |
| 60 | Canonical GSI-composite shapes | **Not applicable**: composer untouched (§12.5) | design |
| 61 | New error codes | `EDD-9071`–`EDD-9079`, registry rows added in this commit | design |

---

## 16. Decisions this design made that the brief left open

1. **Registration:** `Compression` is a `Context.Service` in `@effect-dynamodb/schema`
   (`@effect-dynamodb/Compression`), read with `Effect.serviceOption` so no operation gains
   an `R`. Provided by `DynamoClient.layer/layerConfig({ compressors })`,
   `DynamoClient.make({ compressors })` (wins, bundled into bound ops), or
   `Compression.layer(...)` / any ambient provision.
2. **Names:** `DynamoModel.Packed({ format: "json", compression?: { codec, threshold? } })`
   → `PackedConfig`; entity `storedAs`; stream `storedAs: { data }` and
   `snapshot.storedAs`; `Compressor { codec, compress, decompress }`; `StorageEncoding`
   module (`encode`, `decode`, `valueBytes`, `limits`); stream methods `measureAppend`,
   `measureSnapshot`, `decodeStreamImage`; Node factories `gzip`, `brotli`, `zstd`,
   `available` from `effect-dynamodb/compression/node`.
3. **Header:** one byte, `vvv ff ccc`: version `001`; format `00` json, `01` binary
   (reserved); codec `000` none, `001` gzip, `010` brotli, `011` zstd. Writers emit
   `0x21`/`0x22`/`0x23`.
4. **Errors:** `CompressorNotRegistered { codec, direction, entityType, attribute,
   operation }` (new tagged error), carried as the `cause` of a `ValidationError` — never
   added to an error channel; corrupt values and non-JSON input are `ValidationError`.
5. **EDD codes:** 9071 Packed options; 9072 key/index source; 9073 shape (incl. TTL/dates);
   9074 unique; 9075 ref; 9076 expression/projection; 9077 update op; 9078 registry; 9079
   stream `storedAs` config.
6. **Codec required, no default** (deviation from the issue comment's "default zstd").
7. **Wire form follows the map's** (deviation in wording from the brief — §15 item 38).
