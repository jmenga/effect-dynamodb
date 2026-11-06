---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Require Effect 4.1, and stop installs mixing versions of the lockstep packages (#191).

**Effect 4.1.** The `effect` peer dependency moves from `^4.0.0` to `^4.1.0`. Effect 4.1 removed its top-level `Crypto` module, so importing 1.37.0 or earlier on it failed with `The requested module 'effect' does not provide an export named 'Crypto'`. Its replacement, `effect/crypto`, does not exist in 4.0, so one build cannot import from both.

If you cannot move to Effect 4.1 yet, stay on 1.37.0 with Effect 4.0.2 or earlier, and pin `@effect-dynamodb/schema` to 1.37.0 too. The published 1.37.0 depends on `^1.37.0`, so a fresh install would otherwise take a newer schema package: `npm i --save-exact effect-dynamodb@1.37.0 @effect-dynamodb/schema@1.37.0 effect@4.0.2`. Effect 4.0.3 turned `Crypto.randomUUIDv4` and `randomUUIDv7` into functions, so 1.37.0 imports on 4.0.3 to 4.0.7 but its writes to `generatedId` and `versioned` entities die at runtime.

- **`DynamoClient.make({ crypto })` now takes a `SecureRandom` service from `effect/crypto`** instead of `Crypto.Crypto`. Replace `Crypto.make({ randomBytes, digest })` with `SecureRandom.make(randomBytes)`. Most programs do not pass this option and need no change: the default is still backed by `globalThis.crypto`, and bound operations stay `R = never`.
- **`generatedId: { version: "v7" }` ids are now monotonic.** Effect 4.1 orders the UUIDv7s of each `SecureRandom`: within a millisecond a counter orders them, in place of random bits, and the timestamp can run slightly ahead of the `Clock`. The default service is per client, so ids sort in creation order within one client. Their text form is unchanged, and so are version 4 ids.
- **Minting event ids:** `crypto.randomULID` and `crypto.randomUUIDv7` become `random.ulid` and `random.uuidV7()` on the `SecureRandom` service, and `SecureRandom.layerWebCrypto` provides it. ULIDs from one service are monotonic too, so a test with a frozen `TestClock` and fixed bytes gets one value and then its increments, and must build a fresh service for each run to repeat them.
- **Coming from Effect 4.0.5 or earlier, you also pick up Effect's date fixes from 4.0.6.** `DynamoModel.DateTimeZoned` now handles dates before year 1 in a named zone: earlier releases formatted them with a garbled offset, so a write as a key composite died with `EDD-9050` and a write as an attribute stored text that no read could decode, and such a row still fails to decode. Date strings also accept a lower-case `z` designator, and a `[GMT]` zone on `DateTimeZoned`.

Key text is unchanged: every key that could be written under Effect 4.0 composes to the same bytes. This release changes no key behaviour, so the problem from 1.37.0 that can store rows under the wrong key on an inverted index over strings is still present in 1.38.0, and is fixed in the next release.

**Lockstep pins.** `effect-dynamodb@X` now depends on exactly `@effect-dynamodb/schema@X`, and `@effect-dynamodb/geo@X` requires exactly `effect-dynamodb@X`. The caret ranges used before let a fresh install of an older runtime pick up a newer schema package, which holds key composition, so it wrote the newer key text without the newer runtime's migration code. Upgrade the packages together.
