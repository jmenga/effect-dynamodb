---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Fix `layerConfig` dropping credentials given in part. `DynamoClient.layerConfig` and `DynamoStreamsClient.layerConfig` read `credentials` as absent when any part of a `Config.all` group was missing: a key without its secret, or a key and secret beside a required token that wasn't there. The parts given were dropped, and the SDK's default credential chain signed every request, as whatever identity it held.

**Credentials given in part now fail the layer with the `Config`'s error for what is missing, and nothing is sent. A deployment that sets a key and secret, reads the token with `Config.String("TOKEN")` and has no token, started and signed with the default chain; it now fails at startup. Read a token that may be absent with `Config.String("TOKEN").pipe(Config.withDefault(undefined))`.** An empty value counts as missing, as it did.

The layer fails only when the credentials are shown to be given in part. With one or two of the missing values stood in for, the `Config` must yield credentials, and each stand-in must be one of their three parts. A value the provider holds must be one of the parts too (trimming and case aside), and when it changes, that part must change with it and the other parts must not. Anything else still reads as absent, as before:

- a profile, mode or flag that selects what to read, set with no keys, also when its value is the fixed text of a part;
- a setting that would be a part only under a mode that is missing and has a default;
- a key whose value the `Config` takes for none (`KEY=none`);
- another setting read in the same group that is given, or that has a default;
- a part given and another missing when a setting the same `Config` requires is missing too (a required label, account id or expiration read beside them): a required setting that is missing can't be told from a mode that is missing;
- a part the `Config` turns into other text (a prefix added, a list joined, a secret read from the file or the store the value names) or reads as a list;
- a part the `Config` accepts only in some form (a literal, a pattern, a length);
- anything the `Config` would read only after what is missing, through `Config.flatMap`: a part that is there when the `Config` stopped at a read before it (`KEY` then `SECRET`, with only the secret given), a third part or a setting read after the keys when the key is given and its secret is missing, a key that also names where its secret is read (`KEY`, then `<KEY>_SECRET`). The provider is asked no more than the `Config` asks, and what it holds where it wasn't asked isn't known;
- anything the `Config` reads from the provider in context by itself, in a `Config.mapEffect`;
- a struct read through one schema (`Config.schema`) that is wholly missing, beside a token that is given, and a value at a struct's path that is no struct;
- an empty value a provider keeps, or a value of spaces only, alone;
- more than six values missing among those the `Config` read;
- a `Config` that yields credentials when evaluated again (its own state changed).

Two shapes fail the layer that a stricter reading might leave to the default chain. A value that is a part only under a mode that is missing, when the mode's own text is a part too. And a name the `Config` maps to itself, when the `Config` maps other names to fixed keys and uses any unknown name as the key: from outside the `Config`, that name is the key.

To show it, the `Config` is evaluated again from the answers the provider already gave, with stand-in and changed values. The provider is read once, as before. The `Config`'s own functions (`Config.mapEffect`, `Config.flatMap`) run again, with those values, whenever the `Config` comes back absent although the provider held a value it read, a flag or a mode included. The answers are kept as the provider gave them: a provider of the caller's own that hands out one object for several paths and changes it between them is read by what that object holds last.

Unchanged: with none of the parts in the provider, the default chain applies; with all of them, they're used; an invalid value or a failing provider fails the layer. With `Config.orElse`, the error is the alternative's, as Effect reports it.
