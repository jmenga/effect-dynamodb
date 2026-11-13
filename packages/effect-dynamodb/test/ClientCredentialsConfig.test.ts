/**
 * `layerConfig`'s `credentials`, read from a config provider.
 *
 * Up to 1.40.0 they were read with `Config.option`, which reads a group with
 * any part missing as absent. Credentials given in part (a key without its
 * secret, a key and secret beside a token that isn't there) were dropped, and
 * the SDK's default credential chain signed the request, as whatever identity
 * it held. Credentials given in part now fail the layer, with the `Config`'s
 * error for what is missing. Credentials wholly absent, and wholly present,
 * read as they did.
 *
 * The layer fails only on proof that a value the source holds is a part of the
 * credentials and that what is missing is all that is wrong. A value that
 * selects what to read, a flag, or anything else that can't be shown to be a
 * part leaves the `Config` absent, as it was.
 */

import { describe, expect, it } from "@effect/vitest"
import { Cause, Config, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { afterEach, beforeEach, vi } from "vitest"
import { DynamoStreamsClient } from "../src/change-feed/DynamoStreamsClient.js"
import { DynamoClient } from "../src/DynamoClient.js"
import { type Credentials, readCredentials } from "../src/internal/ClientOptions.js"
import { localServer } from "./helpers/LocalServer.js"
import { wire } from "./helpers/SigV4.js"

type Read =
  | { readonly _tag: "Given"; readonly credentials: unknown }
  | { readonly _tag: "None" }
  | { readonly _tag: "Fails"; readonly error: string }

/** What `readCredentials` makes of `config` under `provider`. */
const read = (config: Config.Config<Credentials>, provider: ConfigProvider.ConfigProvider) =>
  readCredentials(config).pipe(
    Effect.provide(ConfigProvider.layer(provider)),
    Effect.match({
      onSuccess: (credentials): Read =>
        credentials === undefined ? { _tag: "None" } : { _tag: "Given", credentials },
      onFailure: (error): Read => ({ _tag: "Fails", error: String(error) }),
    }),
  )

/** What 1.40.0 made of it: `Config.option`, a failure being the layer's. */
const readAsBefore = (
  config: Config.Config<Credentials>,
  provider: ConfigProvider.ConfigProvider,
) =>
  Effect.gen(function* () {
    return yield* Config.option(config)
  }).pipe(
    Effect.provide(ConfigProvider.layer(provider)),
    Effect.match({
      onSuccess: (credentials): Read =>
        Option.isSome(credentials)
          ? { _tag: "Given", credentials: credentials.value }
          : { _tag: "None" },
      onFailure: (error): Read => ({ _tag: "Fails", error: String(error) }),
    }),
  )

const providers = {
  "the env provider": (values: Record<string, string>) => ConfigProvider.fromEnv({ env: values }),
  "a map provider": (values: Record<string, string>) => ConfigProvider.fromUnknown(values),
} as const

const states = ["present", "absent", "empty"] as const
type State = (typeof states)[number]

const tokens = {
  "a required token": Config.String("TOKEN"),
  "a token defaulting to undefined": Config.String("TOKEN").pipe(Config.withDefault(undefined)),
  "a token defaulting to null": Config.String("TOKEN").pipe(Config.withDefault(null)),
} as const
const tokenDefaults = {
  "a required token": "none",
  "a token defaulting to undefined": undefined,
  "a token defaulting to null": null,
} as const

const group = (token: Config.Config<string | null | undefined>) =>
  Config.all({
    accessKeyId: Config.String("KEY"),
    secretAccessKey: Config.String("SECRET"),
    sessionToken: token,
  })

const valuesOf = (key: State, secret: State, token: State) => {
  const values: Record<string, string> = {}
  for (const [name, state, value] of [
    ["KEY", key, "k"],
    ["SECRET", secret, "s"],
    ["TOKEN", token, "t"],
  ] as const) {
    if (state !== "absent") values[name] = state === "present" ? value : ""
  }
  return values
}

describe("readCredentials: every combination of the three parts", () => {
  for (const [providerName, provider] of Object.entries(providers)) {
    for (const [tokenName, token] of Object.entries(tokens)) {
      const fallback = tokenDefaults[tokenName as keyof typeof tokens]
      for (const key of states) {
        for (const secret of states) {
          for (const given of states) {
            const name = `${providerName}, ${tokenName}: key ${key}, secret ${secret}, token ${given}`
            it.effect(name, () =>
              Effect.gen(function* () {
                const config = group(token)
                const source = provider(valuesOf(key, secret, given))
                const now = yield* read(config, source)
                const before = yield* readAsBefore(config, source)

                // An empty value is a missing one, to both providers.
                const any = [key, secret, given].includes("present")
                const missing =
                  key !== "present"
                    ? "KEY"
                    : secret !== "present"
                      ? "SECRET"
                      : given !== "present" && fallback === "none"
                        ? "TOKEN"
                        : undefined
                if (!any) {
                  expect(now).toEqual({ _tag: "None" })
                  expect(before).toEqual(now)
                } else if (missing === undefined) {
                  expect(now).toEqual({
                    _tag: "Given",
                    credentials: {
                      accessKeyId: "k",
                      secretAccessKey: "s",
                      sessionToken: given === "present" ? "t" : fallback,
                    },
                  })
                  expect(before).toEqual(now)
                } else {
                  expect(now._tag).toBe("Fails")
                  expect((now as { readonly error: string }).error).toContain(`["${missing}"]`)
                  // Refused only where the credentials given were dropped.
                  expect(before).toEqual({ _tag: "None" })
                }
              }),
            )
          }
        }
      }
    }
  }
})

const keys = { accessKeyId: Config.String("KEY"), secretAccessKey: Config.String("SECRET") }
const map = providers["a map provider"]

describe("readCredentials: the shapes of a credentials Config", () => {
  it.effect("no Config: none", () =>
    Effect.gen(function* () {
      expect(yield* readCredentials(undefined)).toBeUndefined()
    }),
  )

  it.effect("a Config that reads nothing is taken as given", () =>
    Effect.gen(function* () {
      const credentials = { accessKeyId: "k", secretAccessKey: "s" }
      const now = yield* read(Config.succeed(credentials), map({}))
      expect(now).toEqual({ _tag: "Given", credentials })
      expect((now as { readonly credentials: unknown }).credentials).toBe(credentials)
    }),
  )

  it.effect("nested under a name", () =>
    Effect.gen(function* () {
      const config = Config.all(keys).pipe(Config.nested("AWS"))
      const whole = ConfigProvider.fromUnknown({ AWS: { KEY: "k", SECRET: "s" } })
      const part = ConfigProvider.fromUnknown({ AWS: { KEY: "k" } })
      const other = ConfigProvider.fromUnknown({ AWS: { REGION: "us-east-1" }, KEY: "elsewhere" })
      expect((yield* read(config, whole))._tag).toBe("Given")
      expect(yield* read(config, part)).toMatchObject({ _tag: "Fails" })
      expect(((yield* read(config, part)) as { error: string }).error).toContain('"SECRET"')
      // Values beside it, which it doesn't read, are not parts of it.
      expect(yield* read(config, other)).toEqual({ _tag: "None" })
    }),
  )

  it.effect("mapped", () =>
    Effect.gen(function* () {
      const config = Config.all(keys).pipe(
        Config.map((read) => ({ ...read, sessionToken: "fixed" })),
      )
      expect(yield* read(config, map({}))).toEqual({ _tag: "None" })
      expect((yield* read(config, map({ SECRET: "s" })))._tag).toBe("Fails")
    }),
  )

  it.effect("with an alternative group: one whole group is enough", () =>
    Effect.gen(function* () {
      const config = Config.all(keys).pipe(
        Config.orElse(() =>
          Config.all({
            accessKeyId: Config.String("ALT_KEY"),
            secretAccessKey: Config.String("ALT_SECRET"),
          }),
        ),
      )
      expect(yield* read(config, map({}))).toEqual({ _tag: "None" })
      expect(yield* read(config, map({ KEY: "k", ALT_KEY: "a", ALT_SECRET: "b" }))).toEqual({
        _tag: "Given",
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
      })
      const part = yield* read(config, map({ KEY: "k", ALT_KEY: "a" }))
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["ALT_SECRET"]')
    }),
  )

  it.effect("a struct read as one schema beside a token", () =>
    Effect.gen(function* () {
      const config = Config.all({
        keys: Config.schema(
          Schema.Struct({ accessKeyId: Schema.String, secretAccessKey: Schema.String }),
          "KEYS",
        ),
        sessionToken: Config.String("TOKEN"),
      }).pipe(Config.map((read) => ({ ...read.keys, sessionToken: read.sessionToken })))
      const whole = { KEYS: { accessKeyId: "k", secretAccessKey: "s" } }
      expect(yield* read(config, ConfigProvider.fromUnknown({}))).toEqual({ _tag: "None" })
      expect(yield* read(config, ConfigProvider.fromUnknown({ ...whole, TOKEN: "t" }))).toEqual({
        _tag: "Given",
        credentials: { accessKeyId: "k", secretAccessKey: "s", sessionToken: "t" },
      })
      const part = yield* read(config, ConfigProvider.fromUnknown(whole))
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["TOKEN"]')
      expect(yield* readAsBefore(config, ConfigProvider.fromUnknown(whole))).toEqual({
        _tag: "None",
      })
    }),
  )

  it.effect("a struct missing a field already failed, and fails the same", () =>
    Effect.gen(function* () {
      const config = Config.schema(
        Schema.Struct({ accessKeyId: Schema.String, secretAccessKey: Schema.String }),
        "KEYS",
      )
      for (const values of [
        {},
        { KEYS: { accessKeyId: "k" } },
        { KEYS: { accessKeyId: "k", secretAccessKey: "s" } },
      ]) {
        const source = ConfigProvider.fromUnknown(values)
        expect(yield* read(config, source)).toEqual(yield* readAsBefore(config, source))
      }
      expect(
        (yield* read(config, ConfigProvider.fromUnknown({ KEYS: { accessKeyId: "k" } })))._tag,
      ).toBe("Fails")
    }),
  )

  it.effect("an invalid value fails as it did", () =>
    Effect.gen(function* () {
      const config = Config.all({
        ...keys,
        sessionToken: Config.String("TOKEN").pipe(
          Config.mapEffect((token) =>
            token.startsWith("tok-")
              ? Effect.succeed(token)
              : Effect.fail(
                  new Config.ConfigError(
                    new ConfigProvider.SourceError({ message: "not a token" }),
                  ),
                ),
          ),
        ),
      })
      for (const values of [
        { KEY: "k", SECRET: "s", TOKEN: "bad" },
        { TOKEN: "bad" },
        { KEY: "k", SECRET: "s", TOKEN: "tok-1" },
      ]) {
        expect(yield* read(config, map(values))).toEqual(yield* readAsBefore(config, map(values)))
      }
      expect(yield* read(config, map({ TOKEN: "bad" }))).toMatchObject({ _tag: "Fails" })
      expect(((yield* read(config, map({ TOKEN: "bad" }))) as { error: string }).error).toContain(
        "not a token",
      )
    }),
  )

  it.effect("a Config that always fails, fails as it did", () =>
    Effect.gen(function* () {
      const config: Config.Config<Credentials> = Config.fail(
        new ConfigProvider.SourceError({ message: "no credentials here" }),
      )
      expect(yield* read(config, map({}))).toEqual(yield* readAsBefore(config, map({})))
      expect((yield* read(config, map({})))._tag).toBe("Fails")
    }),
  )

  it.effect("a struct's path holding a value that is no struct: absent, as it was", () =>
    Effect.gen(function* () {
      const config = Config.schema(
        Schema.Struct({ accessKeyId: Schema.String, secretAccessKey: Schema.String }),
        "KEYS",
      )
      for (const values of [{ KEYS: "none" }, { KEYS: false }, { KEYS: 0 }]) {
        const source = ConfigProvider.fromUnknown(values)
        expect(yield* read(config, source)).toEqual({ _tag: "None" })
        expect(yield* readAsBefore(config, source)).toEqual({ _tag: "None" })
      }
    }),
  )

  it.effect("a token beside a struct that isn't there: no value stands in for a struct", () =>
    Effect.gen(function* () {
      const config = Config.all({
        keys: Config.schema(
          Schema.Struct({ accessKeyId: Schema.String, secretAccessKey: Schema.String }),
          "KEYS",
        ),
        sessionToken: Config.String("TOKEN"),
      }).pipe(Config.map((read) => ({ ...read.keys, sessionToken: read.sessionToken })))
      const labelled = Config.all({
        keys: Config.schema(
          Schema.Struct({
            accessKeyId: Schema.String,
            secretAccessKey: Schema.String,
            label: Schema.optional(Schema.String),
          }),
          "KEYS",
        ),
        sessionToken: Config.String("TOKEN"),
      }).pipe(
        Config.map((read) => ({
          accessKeyId: read.keys.accessKeyId,
          secretAccessKey: read.keys.secretAccessKey,
          sessionToken: read.sessionToken,
        })),
      )
      const source = ConfigProvider.fromUnknown({ TOKEN: "t" })
      for (const each of [config, labelled]) {
        expect(yield* read(each, source)).toEqual({ _tag: "None" })
        expect(yield* readAsBefore(each, source)).toEqual({ _tag: "None" })
      }
    }),
  )

  it.effect("parts that fail the Config when missing, beside one that is only absent", () =>
    Effect.gen(function* () {
      const required = (name: string) =>
        Config.String(name).pipe(
          Config.orElse(() =>
            Config.fail(new ConfigProvider.SourceError({ message: `${name} is required` })),
          ),
        )
      const config = Config.all({
        accessKeyId: required("KEY"),
        secretAccessKey: required("SECRET"),
        sessionToken: Config.String("TOKEN"),
      })
      const part = yield* read(config, map({ KEY: "k", SECRET: "s" }))
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["TOKEN"]')
      expect(yield* readAsBefore(config, map({ KEY: "k", SECRET: "s" }))).toEqual({ _tag: "None" })
      // Nothing configured already failed, with the caller's own error.
      for (const values of [{}, { TOKEN: "t" }, { KEY: "k" }]) {
        expect(yield* read(config, map(values))).toEqual(yield* readAsBefore(config, map(values)))
        expect(((yield* read(config, map(values))) as { error: string }).error).toContain(
          "is required",
        )
      }
    }),
  )

  it.effect("a part trimmed or changed in case by the Config is still that part", () =>
    Effect.gen(function* () {
      const config = Config.all({
        accessKeyId: Config.String("KEY").pipe(Config.map((key) => key.trim().toUpperCase())),
        secretAccessKey: Config.String("SECRET"),
      })
      const part = yield* read(config, map({ KEY: " akid " }))
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["SECRET"]')
    }),
  )
})

// What a `Config` reads may be chosen from a value it read (`Config.flatMap`).
// A value that only selects is not a part of the credentials. A part given
// under the selection is.
describe("readCredentials: a Config that chooses what it reads", () => {
  const byProfile = Config.String("PROFILE").pipe(
    Config.flatMap((profile) =>
      Config.all({
        accessKeyId: Config.String(`${profile}_KEY`),
        secretAccessKey: Config.String(`${profile}_SECRET`),
      }),
    ),
  )
  const byMode = Config.String("MODE").pipe(
    Config.withDefault("static"),
    Config.flatMap((mode) =>
      mode === "static"
        ? Config.all(keys)
        : Config.all({
            accessKeyId: Config.String("OTHER_KEY"),
            secretAccessKey: Config.String("OTHER_SECRET"),
          }),
    ),
  )
  const local = { accessKeyId: "local", secretAccessKey: "local" }
  const byFlag = Config.Boolean("USE_LOCAL").pipe(
    Config.withDefault(false),
    Config.flatMap((use) => (use ? Config.succeed(local) : Config.all(keys))),
  )
  const byDefaultedProfile = Config.String("PROFILE").pipe(
    Config.orElse(() => Config.succeed("default")),
    Config.flatMap((profile) => Config.all(keys).pipe(Config.nested(profile))),
  )
  const byStruct = Config.schema(Schema.Struct({ PROFILE: Schema.String })).pipe(
    Config.flatMap(({ PROFILE }) => Config.all(keys).pipe(Config.nested(PROFILE))),
  )
  const byRoot = Config.String().pipe(
    Config.flatMap((profile) => Config.all(keys).pipe(Config.nested(profile))),
  )

  it.effect.each([
    ["a profile", byProfile, { PROFILE: "dev" }],
    ["a mode, set to its default", byMode, { MODE: "static" }],
    ["a mode, set to another", byMode, { MODE: "other" }],
    ["a flag with a default", byFlag, { USE_LOCAL: "false" }],
    ["a profile with a fallback", byDefaultedProfile, { PROFILE: "default" }],
    ["a profile read as a struct", byStruct, { PROFILE: "dev" }],
    ["a profile at the root", byRoot, "dev"],
  ] as const)("%s alone is no part: absent, as it was", ([, config, values]) =>
    Effect.gen(function* () {
      const source = ConfigProvider.fromUnknown(values)
      expect(yield* read(config, source)).toEqual({ _tag: "None" })
      expect(yield* readAsBefore(config, source)).toEqual({ _tag: "None" })
    }),
  )

  it.effect.each([
    ["a profile", byProfile, { PROFILE: "dev", dev_KEY: "k" }, '["dev_SECRET"]'],
    ["a mode left to its default", byMode, { KEY: "k" }, '["SECRET"]'],
    ["a mode", byMode, { MODE: "other", OTHER_KEY: "k" }, '["OTHER_SECRET"]'],
    ["a flag", byFlag, { USE_LOCAL: "false", SECRET: "s" }, '["KEY"]'],
    ["a profile with a fallback", byDefaultedProfile, { default: { KEY: "k" } }, '["SECRET"]'],
    ["a profile read as a struct", byStruct, { PROFILE: "dev", dev: { KEY: "k" } }, '["SECRET"]'],
  ] as const)("a part given under %s, another missing: fails", ([, config, values, missing]) =>
    Effect.gen(function* () {
      const source = ConfigProvider.fromUnknown(values)
      const part = yield* read(config, source)
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain(missing)
      expect(yield* readAsBefore(config, source)).toEqual({ _tag: "None" })
    }),
  )

  it.effect("parts read one after another", () =>
    Effect.gen(function* () {
      const tokenLast = Config.all(keys).pipe(
        Config.flatMap((read) =>
          Config.String("TOKEN").pipe(Config.map((sessionToken) => ({ ...read, sessionToken }))),
        ),
      )
      const secretLast = Config.String("KEY").pipe(
        Config.flatMap((accessKeyId) =>
          Config.String("SECRET").pipe(
            Config.map((secretAccessKey) => ({ accessKeyId, secretAccessKey })),
          ),
        ),
      )
      const noToken = yield* read(tokenLast, map({ KEY: "k", SECRET: "s" }))
      expect(noToken._tag).toBe("Fails")
      expect((noToken as { error: string }).error).toContain('["TOKEN"]')
      const noSecret = yield* read(secretLast, map({ KEY: "k" }))
      expect(noSecret._tag).toBe("Fails")
      expect((noSecret as { error: string }).error).toContain('["SECRET"]')
      for (const config of [tokenLast, secretLast]) {
        expect(yield* read(config, map({}))).toEqual({ _tag: "None" })
      }
    }),
  )
})

// Credentials given in part in less plain ways, each shown to be so.
describe("readCredentials: a part given, another missing, in other shapes", () => {
  const failing = (message: string) =>
    Effect.fail(new Config.ConfigError(new ConfigProvider.SourceError({ message })))

  it.effect.each([
    [
      "a part under its second name",
      Config.all({
        accessKeyId: Config.String("KEY").pipe(Config.orElse(() => Config.String("LEGACY_KEY"))),
        secretAccessKey: Config.String("SECRET"),
      }),
      { LEGACY_KEY: "k" },
      '["SECRET"]',
    ],
    [
      "a part of the alternative group, the first group absent",
      Config.all(keys).pipe(
        Config.orElse(() =>
          Config.all({
            accessKeyId: Config.String("ALT_KEY"),
            secretAccessKey: Config.String("ALT_SECRET"),
          }),
        ),
      ),
      { ALT_KEY: "a" },
      '["ALT_SECRET"]',
    ],
    [
      "a key beside two settings with defaults that are no strings",
      Config.all({
        ...keys,
        verbose: Config.Boolean("VERBOSE").pipe(Config.withDefault(false)),
        retries: Config.Int("RETRIES").pipe(Config.withDefault(3)),
      }),
      { KEY: "k" },
      '["SECRET"]',
    ],
    [
      "a key beside a secret that must be forty characters",
      Config.all({
        accessKeyId: Config.String("KEY"),
        secretAccessKey: Config.String("SECRET").pipe(
          Config.mapEffect((secret) =>
            secret.length >= 40 ? Effect.succeed(secret) : failing("a short secret"),
          ),
        ),
      }),
      { KEY: "k" },
      '["SECRET"]',
    ],
    [
      "a key, the group it is in read once for each part",
      Config.all({
        accessKeyId: Config.all(keys).pipe(Config.map((read) => read.accessKeyId)),
        secretAccessKey: Config.all(keys).pipe(Config.map((read) => read.secretAccessKey)),
      }),
      { KEY: "k" },
      '["SECRET"]',
    ],
    [
      "a key, with six values missing in all",
      Config.all({
        ...keys,
        a: Config.String("A").pipe(Config.withDefault("")),
        b: Config.String("B").pipe(Config.withDefault("")),
        c: Config.String("C").pipe(Config.withDefault("")),
        d: Config.String("D").pipe(Config.withDefault("")),
        e: Config.String("E").pipe(Config.withDefault("")),
      }),
      { KEY: "k" },
      '["SECRET"]',
    ],
    ["a part with no letter or digit", Config.all(keys), { KEY: "---" }, '["SECRET"]'],
  ] as const)("%s: fails", ([, config, values, missing]) =>
    Effect.gen(function* () {
      const source = ConfigProvider.fromUnknown(values)
      const part = yield* read(config as Config.Config<Credentials>, source)
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain(missing)
      expect(yield* readAsBefore(config as Config.Config<Credentials>, source)).toEqual({
        _tag: "None",
      })
    }),
  )

  // Named for what it is. The profile is the key for the name given (a name
  // the `Config` maps to itself) and for the text it is changed to; that other
  // names map to fixed keys can't be seen from outside the `Config`.
  it.effect("a name that is the key itself, in a Config that maps other names to fixed keys", () =>
    Effect.gen(function* () {
      const known: Record<string, string> = { local: "local", prod: "AKIDPROD" }
      const config = Config.String("PROFILE").pipe(
        Config.flatMap((profile) =>
          Config.all({
            accessKeyId: Config.succeed(known[profile] ?? profile),
            secretAccessKey: Config.String("SECRET"),
          }),
        ),
      )
      const part = yield* read(config, map({ PROFILE: "local" }))
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["SECRET"]')
      // A name mapped to other text is no part as given: absent, as it was.
      expect(yield* read(config, map({ PROFILE: "prod" }))).toEqual({ _tag: "None" })
    }),
  )

  // Named for what it is: the value is a part in one way of completing the
  // `Config`, and that is taken as given in part.
  it.effect("a value that is a part under a mode that is missing and is a part itself", () =>
    Effect.gen(function* () {
      const config = Config.all({
        mode: Config.String("MODE").pipe(Config.withDefault("env")),
        profile: Config.String("PROFILE"),
        key: Config.option(Config.String("KEY")),
        secret: Config.option(Config.String("SECRET")),
      }).pipe(
        Config.flatMap((read) =>
          read.mode === "env"
            ? Config.all(keys)
            : Config.succeed({ accessKeyId: read.profile, secretAccessKey: read.mode }),
        ),
      )
      expect((yield* read(config, map({ PROFILE: "dev" })))._tag).toBe("Fails")
    }),
  )
})

// The layer fails only on proof. Each of these holds a value where something
// is missing, and none can be shown to be credentials given in part: absent,
// as it was.
describe("readCredentials: values that can't be shown to be a part", () => {
  it.effect.each([
    [
      "a flag read in the same group",
      Config.all({ ...keys, debug: Config.Boolean("DEBUG") }),
      { DEBUG: "true" },
    ],
    [
      "another setting read in the same group",
      Config.all({ ...keys, label: Config.String("LABEL") }),
      { LABEL: "blue" },
    ],
    [
      // The value is also a part's fixed text: the part doesn't follow it.
      "a setting whose value is also a part's fixed text",
      Config.all({ ...keys, sessionToken: Config.succeed("none"), mode: Config.String("MODE") }),
      { MODE: "none" },
    ],
    [
      // Changed to `1` the selector picks credentials that hold a `1`.
      "a selector whose other choice is credentials naming it",
      Config.String("STAGE").pipe(
        Config.flatMap((stage) =>
          stage === "1"
            ? Config.succeed({ accessKeyId: "1", secretAccessKey: "stage1" })
            : Config.all(keys),
        ),
      ),
      { STAGE: "0" },
    ],
    [
      "a part that reaches the credentials as other text",
      Config.all({
        accessKeyId: Config.String("KEY").pipe(Config.map((key) => `id-${key.length}`)),
        secretAccessKey: Config.String("SECRET"),
      }),
      { KEY: "k" },
    ],
    [
      "a part the Config rejects once changed",
      Config.all({
        accessKeyId: Config.Literal("AKIDFIXED", "KEY"),
        secretAccessKey: Config.String("SECRET"),
      }),
      { KEY: "AKIDFIXED" },
    ],
    [
      "a part given as a list",
      Config.all({
        accessKeyId: Config.schema(Schema.Array(Schema.String), "KEY").pipe(
          Config.map((parts) => parts.join("") || "BUILTIN"),
        ),
        secretAccessKey: Config.String("SECRET"),
      }),
      { KEY: ["ab", "cd"] },
    ],
    [
      "an empty list",
      Config.all({
        accessKeyId: Config.schema(Schema.Array(Schema.String), "KEY").pipe(
          Config.map((parts) => parts.join("") || "BUILTIN"),
        ),
        secretAccessKey: Config.String("SECRET"),
      }),
      { KEY: [] },
    ],
    [
      // Stood in for, `MODE` would make `PROFILE` the key: it is a mode, not a part.
      "a setting that would be a part under a mode that is missing",
      Config.all({
        mode: Config.String("MODE").pipe(Config.withDefault("env")),
        profile: Config.String("PROFILE"),
        key: Config.option(Config.String("KEY")),
        secret: Config.option(Config.String("SECRET")),
      }).pipe(
        Config.flatMap((read) =>
          read.mode === "env"
            ? Config.all(keys)
            : Config.succeed({ accessKeyId: read.profile, secretAccessKey: "fixed" }),
        ),
      ),
      { PROFILE: "dev" },
    ],
    [
      // Changed, the selector picks other fixed text for the token.
      "a selector that is also a part's fixed text, with other text for its other values",
      Config.String("STAGE").pipe(
        Config.flatMap((stage) =>
          Config.all({ ...keys, sessionToken: Config.succeed(stage === "0" ? "0" : "01") }),
        ),
      ),
      { STAGE: "0" },
    ],
    [
      "a key and secret given, another setting in the group missing",
      Config.all({ ...keys, label: Config.String("LABEL") }),
      { KEY: "k", SECRET: "s" },
    ],
    [
      "keys with defaults, behind a setting that is missing",
      Config.all({
        endpoint: Config.String("ENDPOINT"),
        accessKeyId: Config.String("KEY").pipe(Config.withDefault("local")),
        secretAccessKey: Config.String("SECRET").pipe(Config.withDefault("local")),
      }),
      { KEY: "k", SECRET: "s" },
    ],
    [
      "a part the Config accepts only in a form the changed value doesn't meet",
      Config.all({
        accessKeyId: Config.String("KEY").pipe(
          Config.mapEffect((key) =>
            /^AKIA[A-Z0-9]{16}$/.test(key)
              ? Effect.succeed(key)
              : Effect.fail(
                  new Config.ConfigError(new ConfigProvider.SourceError({ message: "no key id" })),
                ),
          ),
        ),
        secretAccessKey: Config.String("SECRET"),
      }),
      { KEY: "AKIAABCDEFGHIJKLMNOP" },
    ],
    [
      "something missing that the stand-in's forty letters and digits don't meet",
      Config.all({
        accessKeyId: Config.String("KEY"),
        secretAccessKey: Config.String("SECRET").pipe(
          Config.mapEffect((secret) =>
            secret.length === 8
              ? Effect.succeed(secret)
              : Effect.fail(
                  new Config.ConfigError(new ConfigProvider.SourceError({ message: "no secret" })),
                ),
          ),
        ),
      }),
      { KEY: "k" },
    ],
    [
      "more values missing than are searched",
      Config.all({
        ...keys,
        a: Config.String("A").pipe(Config.withDefault("")),
        b: Config.String("B").pipe(Config.withDefault("")),
        c: Config.String("C").pipe(Config.withDefault("")),
        d: Config.String("D").pipe(Config.withDefault("")),
        e: Config.String("E").pipe(Config.withDefault("")),
        f: Config.String("F").pipe(Config.withDefault("")),
      }),
      { KEY: "k" },
    ],
    [
      // Stood in for, `AUTH` would be a mode, and the secret read below it.
      "a setting that would be a part under a mode that is missing, the secret read below the mode",
      Config.all({
        profile: Config.String("PROFILE"),
        mode: Config.String("AUTH").pipe(Config.withDefault("env")),
      }).pipe(
        Config.flatMap(({ profile, mode }) =>
          mode === "env"
            ? Config.all(keys)
            : Config.all({
                accessKeyId: Config.succeed(profile),
                secretAccessKey: Config.String("SECRET").pipe(Config.nested("AUTH")),
              }),
        ),
      ),
      { PROFILE: "dev" },
    ],
    [
      // Changed, the selector is the key; as given it only names fixed text.
      "a selector that picks fixed text of its own name, and is the key under any other name",
      Config.String("PROFILE").pipe(
        Config.flatMap((profile) =>
          profile === "local"
            ? Config.all({
                accessKeyId: Config.succeed("local"),
                secretAccessKey: Config.String("SECRET"),
              })
            : Config.succeed({ accessKeyId: profile, secretAccessKey: "fixed" }),
        ),
      ),
      { PROFILE: "local" },
    ],
    [
      // The source is asked no more than the `Config` asks it.
      "a part that is there, the Config having stopped at one read before it",
      Config.String("KEY").pipe(
        Config.flatMap((accessKeyId) =>
          Config.String("SECRET").pipe(
            Config.map((secretAccessKey) => ({ accessKeyId, secretAccessKey })),
          ),
        ),
      ),
      { SECRET: "s" },
    ],
    [
      "the later parts, the Config having stopped at the first",
      Config.String("KEY").pipe(
        Config.flatMap((accessKeyId) =>
          Config.String("SECRET").pipe(
            Config.flatMap((secretAccessKey) =>
              Config.String("TOKEN").pipe(
                Config.map((sessionToken) => ({ accessKeyId, secretAccessKey, sessionToken })),
              ),
            ),
          ),
        ),
      ),
      { SECRET: "s", TOKEN: "t" },
    ],
    [
      "a token read after the keys, the Config having stopped at the keys",
      Config.all(keys).pipe(
        Config.flatMap((read) =>
          Config.String("TOKEN").pipe(Config.map((sessionToken) => ({ ...read, sessionToken }))),
        ),
      ),
      { TOKEN: "t" },
    ],
    [
      // Changed, the stage is the key and the keys are not read.
      "a selector that is fixed text of a part as given, and another part under any other name",
      Config.String("STAGE").pipe(
        Config.flatMap((stage) =>
          stage === "prod"
            ? Config.all({ ...keys, sessionToken: Config.succeed("prod") })
            : Config.succeed({ accessKeyId: stage, secretAccessKey: "local" }),
        ),
      ),
      { STAGE: "prod" },
    ],
    [
      // The same, the keys read either way: changed, the other parts change too.
      "a selector read beside the keys, a part's fixed text as given and another part otherwise",
      Config.all({ ...keys, stage: Config.String("STAGE") }).pipe(
        Config.map(({ stage, ...read }) =>
          stage === "prod"
            ? { ...read, sessionToken: "prod" }
            : { accessKeyId: stage, secretAccessKey: "local" },
        ),
      ),
      { STAGE: "prod" },
    ],
    [
      // With the secret alone stood in the `Config` is whole, and the profile
      // no part of it: the mode is not stood in for as well.
      "a setting that would be a part with a mode stood in for as well as the secret",
      Config.all({
        mode: Config.String("MODE").pipe(Config.withDefault("env")),
        profile: Config.String("PROFILE"),
        accessKeyId: Config.String("KEY").pipe(Config.withDefault("fixed")),
        secretAccessKey: Config.String("SECRET"),
      }).pipe(
        Config.map(({ mode, profile, accessKeyId, secretAccessKey }) =>
          mode === "env"
            ? { accessKeyId, secretAccessKey }
            : { accessKeyId: profile, secretAccessKey, sessionToken: mode },
        ),
      ),
      { PROFILE: "dev" },
    ],
    [
      "a key whose value means none, the secret missing",
      Config.all(keys).pipe(
        Config.map((read) =>
          read.accessKeyId === "none" ? (undefined as unknown as Credentials) : read,
        ),
      ),
      { KEY: "none" },
    ],
    [
      // Changed, the key names another path, which the source was never asked for.
      "a key that also names where its secret is read",
      Config.String("KEY").pipe(
        Config.flatMap((accessKeyId) =>
          Config.String(`${accessKeyId}_SECRET`).pipe(
            Config.map((secretAccessKey) => ({ accessKeyId, secretAccessKey })),
          ),
        ),
      ),
      { KEY: "AKID" },
    ],
    // The `Config` stopped at what is missing and would read on from there:
    // what the source holds at a path it wasn't asked for isn't known.
    [
      "the first of three read one after another, the third not asked for",
      Config.String("KEY").pipe(
        Config.flatMap((accessKeyId) =>
          Config.String("SECRET").pipe(
            Config.flatMap((secretAccessKey) =>
              Config.String("TOKEN").pipe(
                Config.map((sessionToken) => ({ accessKeyId, secretAccessKey, sessionToken })),
              ),
            ),
          ),
        ),
      ),
      { KEY: "k" },
    ],
    [
      "a later part, the one read before it missing",
      Config.all({
        pair: Config.String("KEY").pipe(
          Config.flatMap((accessKeyId) =>
            Config.String("SECRET").pipe(
              Config.map((secretAccessKey) => ({ accessKeyId, secretAccessKey })),
            ),
          ),
        ),
        sessionToken: Config.String("TOKEN"),
      }).pipe(Config.map((read) => ({ ...read.pair, sessionToken: read.sessionToken }))),
      { SECRET: "s", TOKEN: "t" },
    ],
    [
      "a key, a flag with a default read after the keys",
      Config.all(keys).pipe(
        Config.flatMap((read) =>
          Config.Boolean("USE_TOKEN").pipe(
            Config.withDefault(false),
            Config.flatMap((use) =>
              use
                ? Config.String("TOKEN").pipe(
                    Config.map((sessionToken) => ({ ...read, sessionToken })),
                  )
                : Config.succeed(read),
            ),
          ),
        ),
      ),
      { KEY: "k" },
    ],
    [
      "a key, a label with a default read after the keys",
      Config.all(keys).pipe(
        Config.flatMap((read) =>
          Config.String("LABEL").pipe(
            Config.withDefault("none"),
            Config.map(() => read),
          ),
        ),
      ),
      { KEY: "k" },
    ],
    [
      "a key, a flag read after the keys and set against its default",
      Config.all(keys).pipe(
        Config.flatMap((read) =>
          Config.Boolean("USE_STATIC").pipe(
            Config.withDefault(true),
            Config.flatMap((use) =>
              use
                ? Config.succeed(read)
                : Config.all({
                    accessKeyId: Config.String("STS_KEY"),
                    secretAccessKey: Config.String("STS_SECRET"),
                  }),
            ),
          ),
        ),
      ),
      { KEY: "k", USE_STATIC: "false" },
    ],
    [
      "a key, read again after the keys",
      Config.all(keys).pipe(
        Config.flatMap((read) =>
          Config.String("KEY").pipe(
            Config.flatMap((key) =>
              key.startsWith("ASIA")
                ? Config.String("TOKEN").pipe(
                    Config.map((sessionToken) => ({ ...read, sessionToken })),
                  )
                : Config.succeed(read),
            ),
          ),
        ),
      ),
      { KEY: "k" },
    ],
    [
      // What the `Config` reads from the provider in context is not watched.
      "a key, beside a setting whose effect reads the provider in context",
      Config.all({
        ...keys,
        label: Config.String("LABEL").pipe(
          Config.mapEffect((label) => Config.String("AUX").pipe(Effect.as(label))),
        ),
      }),
      { KEY: "k", LABEL: "blue", AUX: "x" },
    ],
    [
      "a key, beside a setting whose effect reads the provider in context, with a default",
      Config.all({
        ...keys,
        label: Config.String("LABEL").pipe(
          Config.mapEffect((label) =>
            Config.String("AUX").pipe(Config.withDefault("none"), Effect.as(label)),
          ),
        ),
      }),
      { KEY: "k", LABEL: "blue" },
    ],
    [
      // The mode alone completes the `Config`, and is no part of it: it is
      // not stood in for again beside another setting.
      "a setting that would be a part with a mode and another setting stood in for",
      Config.all({
        mode: Config.String("MODE").pipe(Config.withDefault("env")),
        profile: Config.String("PROFILE"),
        other: Config.String("OTHER").pipe(Config.withDefault("none")),
      }).pipe(
        Config.flatMap(({ mode, profile, other }) =>
          mode === "env"
            ? Config.all(keys)
            : Config.succeed({
                accessKeyId: profile,
                secretAccessKey: other,
                ...(other === "none" ? {} : { sessionToken: mode }),
              }),
        ),
      ),
      { PROFILE: "dev" },
    ],
    [
      // Changed, the stage is the token; as given it is no token, only the
      // text of the fixed key.
      "a selector that is a fixed part's text as given, and another part once changed",
      Config.all({ stage: Config.String("STAGE"), secretAccessKey: Config.String("SECRET") }).pipe(
        Config.map(({ stage, secretAccessKey }) =>
          stage === "prod"
            ? { accessKeyId: "prod", secretAccessKey }
            : { accessKeyId: "prod", secretAccessKey, sessionToken: stage },
        ),
      ),
      { STAGE: "prod" },
    ],
    ["a key of spaces only", Config.all(keys), { KEY: "   " }],
    // A setting the `Config` requires that is missing can't be told from a
    // mode that is missing: stood in for, it is no part.
    [
      "a key, its secret and a label the group requires both missing",
      Config.all({ ...keys, label: Config.String("LABEL") }),
      { KEY: "k" },
    ],
    [
      "a key and secret, a required token and an account id the group requires both missing",
      Config.all({
        ...keys,
        sessionToken: Config.String("TOKEN"),
        accountId: Config.String("ACCOUNT_ID"),
      }),
      { KEY: "k", SECRET: "s" },
    ],
    [
      // The token alone stood in for completes the alternative, as no part of
      // it: it is not stood in for again beside the secret.
      "a key, its secret and a required token missing, the alternative choosing by the token's path",
      Config.all({ ...keys, sessionToken: Config.String("TOKEN") }).pipe(
        Config.orElse(() =>
          Config.String("TOKEN").pipe(
            Config.map(() => ({ accessKeyId: "other", secretAccessKey: "other" })),
          ),
        ),
      ),
      { KEY: "k" },
    ],
    [
      "something missing that no string stands in for",
      Config.all({ ...keys, retries: Config.Int("RETRIES") }),
      { KEY: "k", SECRET: "s" },
    ],
  ] as const)("%s", ([, config, values]) =>
    Effect.gen(function* () {
      const source = ConfigProvider.fromUnknown(values)
      expect(yield* read(config as Config.Config<Credentials>, source)).toEqual({ _tag: "None" })
      expect(yield* readAsBefore(config as Config.Config<Credentials>, source)).toEqual({
        _tag: "None",
      })
    }),
  )
})

describe("readCredentials: the provider", () => {
  const custom = (values: Record<string, string>, asked: Array<string>) =>
    ConfigProvider.make((path) =>
      Effect.sync(() => {
        const name = path.join(".")
        asked.push(name)
        const value = values[name]
        return value === undefined ? undefined : ConfigProvider.makeValue(value)
      }),
    )

  it.effect("the source is asked what the Config alone asks, and no more", () =>
    Effect.gen(function* () {
      for (const [values, tag] of [
        [{}, "None"],
        [{ KEY: "k" }, "Fails"],
        [{ SECRET: "s" }, "Fails"],
        [{ KEY: "k", SECRET: "s" }, "Given"],
      ] as const) {
        const asked: Array<string> = []
        const before: Array<string> = []
        expect((yield* read(Config.all(keys), custom(values, asked)))._tag).toBe(tag)
        yield* readAsBefore(Config.all(keys), custom(values, before))
        expect(asked).toEqual(["KEY", "SECRET"])
        expect(asked).toEqual(before)
      }
    }),
  )

  it.effect("a path read twice is asked twice, and each answer kept", () =>
    Effect.gen(function* () {
      // The source answers the same path with the key, then with the secret.
      const config = Config.String("PAIR").pipe(
        Config.flatMap((accessKeyId) =>
          Config.String("PAIR").pipe(
            Config.map((secretAccessKey) => ({ accessKeyId, secretAccessKey })),
          ),
        ),
      )
      const inTurn = (asked: Array<string>) => {
        let next = 0
        return ConfigProvider.make((path) =>
          Effect.sync(() => {
            asked.push(path.join("."))
            return ConfigProvider.makeValue(["k", "s"][next++] ?? "unexpected")
          }),
        )
      }
      const asked: Array<string> = []
      const before: Array<string> = []
      const now = yield* read(config, inTurn(asked))
      expect(now).toEqual({
        _tag: "Given",
        credentials: { accessKeyId: "k", secretAccessKey: "s" },
      })
      expect(now).toEqual(yield* readAsBefore(config, inTurn(before)))
      expect(asked).toEqual(before)
    }),
  )

  it.effect("a source that failed once is not asked again", () =>
    Effect.gen(function* () {
      // `KEY` fails the first time it is asked and would answer the second.
      const flaky = (asked: Array<string>) => {
        let failed = false
        const values: Record<string, string> = { KEY: "k", SECRET: "s", ALT_KEY: "a" }
        return ConfigProvider.make((path) =>
          Effect.suspend(() => {
            const name = path.join(".")
            asked.push(name)
            if (name === "KEY" && !failed) {
              failed = true
              return Effect.fail(new ConfigProvider.SourceError({ message: "not now" }))
            }
            const value = values[name]
            return Effect.succeed(value === undefined ? undefined : ConfigProvider.makeValue(value))
          }),
        )
      }
      const config = Config.all(keys).pipe(
        Config.orElse(() =>
          Config.all({
            accessKeyId: Config.String("ALT_KEY"),
            secretAccessKey: Config.String("ALT_SECRET"),
          }),
        ),
      )
      const asked: Array<string> = []
      const before: Array<string> = []
      const now = yield* read(config, flaky(asked))
      expect(now._tag).toBe("Fails")
      expect((now as { error: string }).error).toContain('["ALT_SECRET"]')
      expect(yield* readAsBefore(config, flaky(before))).toEqual({ _tag: "None" })
      expect(asked).toEqual(["KEY", "ALT_KEY", "ALT_SECRET"])
      expect(asked).toEqual(before)
    }),
  )

  it.effect("a path that answers a key, then a secret, beside a token that is missing", () =>
    Effect.gen(function* () {
      const config = Config.all({
        accessKeyId: Config.String("PAIR"),
        secretAccessKey: Config.String("PAIR"),
        sessionToken: Config.String("TOKEN"),
      })
      const both = () => {
        let next = 0
        return ConfigProvider.make((path) =>
          Effect.sync(() =>
            path[0] === "PAIR" ? ConfigProvider.makeValue(next++ === 0 ? "k" : "s") : undefined,
          ),
        )
      }
      const part = yield* read(config, both())
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["TOKEN"]')
      expect(yield* readAsBefore(config, both())).toEqual({ _tag: "None" })
    }),
  )

  it.effect("a path asked for but not read, then read by the alternative", () =>
    Effect.gen(function* () {
      // `KEY` fails, so the first group's `SECRET` is asked for and never
      // read. The alternative reads `SECRET` too: that is its second ask.
      const failing = ConfigProvider.make((path) =>
        path[0] === "KEY"
          ? Effect.fail(new ConfigProvider.SourceError({ message: "not now" }))
          : Effect.succeed(path[0] === "ALT_KEY" ? ConfigProvider.makeValue("a") : undefined),
      )
      const config = Config.all(keys).pipe(
        Config.orElse(() =>
          Config.all({
            accessKeyId: Config.String("ALT_KEY"),
            secretAccessKey: Config.String("SECRET"),
          }),
        ),
      )
      const now = yield* read(config, failing)
      expect(now._tag).toBe("Fails")
      expect((now as { error: string }).error).toContain('["SECRET"]')
      expect(yield* readAsBefore(config, failing)).toEqual({ _tag: "None" })
    }),
  )

  it.effect("an alternative chosen from the first error", () =>
    Effect.gen(function* () {
      const down = ConfigProvider.make((path) =>
        path[0] === "KEY"
          ? Effect.fail(new ConfigProvider.SourceError({ message: "the source is down" }))
          : Effect.succeed(path[0] === "ALT_KEY" ? ConfigProvider.makeValue("a") : undefined),
      )
      const named = (error: Config.ConfigError) =>
        error.cause._tag === "SourceError" ? "ALT" : "BACKUP"
      const config = Config.all(keys).pipe(
        Config.orElse((error) =>
          Config.all({
            accessKeyId: Config.String(`${named(error)}_KEY`),
            secretAccessKey: Config.String(`${named(error)}_SECRET`),
          }),
        ),
      )
      const now = yield* read(config, down)
      expect(now._tag).toBe("Fails")
      expect((now as { error: string }).error).toContain('["ALT_SECRET"]')
    }),
  )

  it.effect("a Config's own effects run once, and again only to prove a part", () =>
    Effect.gen(function* () {
      const seen: Array<string> = []
      const config = Config.all({
        accessKeyId: Config.String("KEY"),
        secretAccessKey: Config.String("SECRET").pipe(
          Config.mapEffect((secret) =>
            Effect.sync(() => {
              seen.push(secret)
              return secret
            }),
          ),
        ),
      })
      const flag = Config.Boolean("USE_LOCAL").pipe(
        Config.withDefault(false),
        Config.flatMap((use) =>
          use ? Config.succeed({ accessKeyId: "local", secretAccessKey: "local" }) : config,
        ),
      )
      const mode = Config.String("MODE").pipe(
        Config.withDefault("static"),
        Config.flatMap((mode) =>
          // Any other mode reads the same secret, under a fixed key.
          mode === "static"
            ? config
            : config.pipe(Config.map((read) => ({ ...read, accessKeyId: "other" }))),
        ),
      )
      const runs = (credentials: Config.Config<Credentials>, values: Record<string, string>) =>
        Effect.gen(function* () {
          seen.length = 0
          const tag = (yield* read(credentials, map(values)))._tag
          return { tag, real: seen.filter((secret) => secret === "s").length, all: seen.length }
        })
      // Nothing given, or everything: once, as before.
      expect(yield* runs(config, {})).toEqual({ tag: "None", real: 0, all: 0 })
      expect(yield* runs(config, { KEY: "k", SECRET: "s" })).toEqual({
        tag: "Given",
        real: 1,
        all: 1,
      })
      expect(yield* runs(config, { SECRET: "s" })).toEqual({ tag: "Fails", real: 3, all: 4 })
      // A secret without its key: again for each evaluation of the proof, once changed.
      const [changed] = seen.filter((secret) => secret !== "s")
      expect(changed).toMatch(/^s[0-9a-z]{16}$/)
      yield* runs(config, { SECRET: "s" })
      // Changed to text no `Config` can hold: other text each time.
      expect(seen.filter((secret) => secret !== "s")).not.toEqual([changed])

      // A flag or a mode alone, which is no part: with a stand-in, never a
      // value of the source's, and never with the flag or mode changed.
      for (const [credentials, values] of [
        [flag, { USE_LOCAL: "false" }],
        [mode, { MODE: "static" }],
      ] as const) {
        expect(yield* runs(credentials, values)).toEqual({ tag: "None", real: 0, all: 2 })
        expect(seen.every((secret) => /^[0-9a-z]{40}$/.test(secret))).toBe(true)
        const [standIn] = seen
        yield* runs(credentials, values)
        expect(seen).not.toContain(standIn)
      }
    }),
  )

  it.effect("a Config read inside the Config reads the source no more than before", () =>
    Effect.gen(function* () {
      const config = Config.all({
        ...keys,
        label: Config.String("LABEL").pipe(
          Config.mapEffect((label) => Config.String("AUX").pipe(Effect.as(label))),
        ),
      }) as Config.Config<Credentials>
      const values = { LABEL: "blue", AUX: "x" }
      const asked: Array<string> = []
      const before: Array<string> = []
      expect(yield* read(config, custom(values, asked))).toEqual({ _tag: "None" })
      const source = custom(values, before)
      yield* readAsBefore(config, source).pipe(Effect.provide(ConfigProvider.layer(source)))
      expect(asked).toEqual(["KEY", "SECRET", "LABEL", "AUX"])
      expect(asked).toEqual(before)
    }),
  )

  it.effect("a path asked twice, holding a part the first time only", () =>
    Effect.gen(function* () {
      const config = Config.String("PAIR").pipe(
        Config.flatMap((accessKeyId) =>
          Config.String("PAIR").pipe(
            Config.map((secretAccessKey) => ({ accessKeyId, secretAccessKey })),
          ),
        ),
      )
      const once = () => {
        let next = 0
        return ConfigProvider.make(() =>
          Effect.sync(() => (next++ === 0 ? ConfigProvider.makeValue("k") : undefined)),
        )
      }
      const part = yield* read(config, once())
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["PAIR"]')
      expect(yield* readAsBefore(config, once())).toEqual({ _tag: "None" })
    }),
  )

  it.effect("a path asked twice, holding a part the second time only", () =>
    Effect.gen(function* () {
      // Both reads run: the error is that of the first, as the source answered it.
      const config = Config.all({
        accessKeyId: Config.String("PAIR"),
        secretAccessKey: Config.String("PAIR"),
      })
      const later = () => {
        let next = 0
        return ConfigProvider.make(() =>
          Effect.sync(() => (next++ === 0 ? undefined : ConfigProvider.makeValue("s"))),
        )
      }
      const part = yield* read(config, later())
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["PAIR"]')
      expect(yield* readAsBefore(config, later())).toEqual({ _tag: "None" })
    }),
  )

  it.effect(
    "whole credentials read through the provider in context, changed, are read as before",
    () =>
      Effect.gen(function* () {
        // The `Config` takes the provider in context and reads through it in
        // constant case. The provider is itself nested under a name.
        const config = Config.succeed(undefined).pipe(
          Config.mapEffect(() =>
            Effect.gen(function* () {
              const provider = yield* ConfigProvider.ConfigProvider
              return yield* Config.all({
                accessKeyId: Config.String("key"),
                secretAccessKey: Config.String("secret"),
              }).parse(ConfigProvider.constantCase(provider))
            }),
          ),
        )
        const source = ConfigProvider.fromUnknown({ APP: { KEY: "k", SECRET: "s" } }).pipe(
          ConfigProvider.nested("app"),
        )
        const given = { _tag: "Given", credentials: { accessKeyId: "k", secretAccessKey: "s" } }
        expect(yield* readAsBefore(config, source)).toEqual(given)
        expect(yield* read(config, source)).toEqual(given)
      }),
  )

  it.effect("a Config that yields credentials on a later evaluation proves nothing", () =>
    Effect.gen(function* () {
      // Its fourth evaluation finds a secret of its own.
      let runs = 0
      const config = Config.String("KEY").pipe(
        Config.mapEffect((key) =>
          Effect.sync(() => {
            runs++
            return key
          }),
        ),
        Config.flatMap((accessKeyId) =>
          Config.all({
            accessKeyId: Config.succeed(accessKeyId),
            secretAccessKey: runs >= 4 ? Config.succeed("late") : Config.String("SECRET"),
          }),
        ),
      )
      expect(yield* read(config, map({ KEY: "k" }))).toEqual({ _tag: "None" })
      expect(runs).toBe(4)
    }),
  )

  it.effect("a Config whose last evaluation reads on to what the source wasn't asked for", () =>
    Effect.gen(function* () {
      // Its fourth evaluation, the one for the error, reads `EXTRA` first.
      let runs = 0
      const config = Config.succeed(undefined).pipe(
        Config.flatMap(() => (++runs >= 4 ? Config.String("EXTRA") : Config.succeed(""))),
        Config.flatMap(() => Config.all(keys)),
      )
      expect(yield* read(config, map({ KEY: "k" }))).toEqual({ _tag: "None" })
      expect(runs).toBe(4)
    }),
  )

  it.effect.each([
    ["no value, then a label's", [undefined, "label"], "Fails"],
    ["a key, then no value", ["k", undefined], "None"],
  ] as const)(
    "a source that hands out one node and changes it is read by what the node holds last: %s",
    ([, values, tag]) =>
      Effect.gen(function* () {
        // A named limit: the answers are kept as given, and this source changes
        // them. The node answers `KEY`, then is changed and answers `LABEL`.
        const config = Config.all({
          key: Config.option(Config.String("KEY")),
          label: Config.option(Config.String("LABEL")),
          secretAccessKey: Config.String("SECRET"),
        }).pipe(
          Config.map(({ key, secretAccessKey }) => ({
            accessKeyId: Option.getOrElse(key, () => "fixed"),
            secretAccessKey,
          })),
        )
        const reused = () => {
          const node: { _tag: "Record"; keys: ReadonlySet<string>; value: string | undefined } = {
            _tag: "Record",
            keys: new Set(),
            value: undefined,
          }
          return ConfigProvider.make((path) =>
            Effect.sync(() => {
              if (path[0] === "SECRET") return undefined
              node.value = values[path[0] === "KEY" ? 0 : 1]
              return node
            }),
          )
        }
        expect((yield* read(config, reused()))._tag).toBe(tag)
        expect(yield* readAsBefore(config, reused())).toEqual({ _tag: "None" })
      }),
  )

  it.effect("what an untyped caller passes for none is none, as it was", () =>
    Effect.gen(function* () {
      for (const none of [null, false, 0, ""]) {
        expect(yield* readCredentials(none as never)).toBeUndefined()
      }
    }),
  )

  it.effect("an empty value a provider keeps is no part", () =>
    Effect.gen(function* () {
      const kept = (values: Record<string, string>) =>
        ConfigProvider.fromEnv({ env: values, preserveEmptyStrings: true })
      expect(yield* read(Config.all(keys), kept({ KEY: "", SECRET: "" }))).toEqual({
        _tag: "Given",
        credentials: { accessKeyId: "", secretAccessKey: "" },
      })
      expect(yield* read(Config.all(keys), kept({ KEY: "" }))).toEqual({ _tag: "None" })
      // Beside a part that is given, it is not what is missing.
      const part = yield* read(group(Config.String("TOKEN")), kept({ KEY: "", SECRET: "s" }))
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["TOKEN"]')
    }),
  )

  it.effect("a name that only prefixes other settings holds no value", () =>
    Effect.gen(function* () {
      // To the env provider `KEY_ROTATION` makes `KEY` a record, not a value.
      const env = providers["the env provider"]
      expect(yield* read(Config.all(keys), env({ KEY_ROTATION: "30d" }))).toEqual({ _tag: "None" })
      const part = yield* read(Config.all(keys), env({ KEY_ROTATION: "30d", SECRET: "s" }))
      expect(part._tag).toBe("Fails")
      expect((part as { error: string }).error).toContain('["KEY"]')
    }),
  )

  it.effect("providers combined, renamed and nested", () =>
    Effect.gen(function* () {
      const config = Config.all({
        accessKeyId: Config.String("accessKeyId"),
        secretAccessKey: Config.String("secretAccessKey"),
      })
      const combined = (first: Record<string, string>, second: Record<string, string>) =>
        ConfigProvider.fromEnv({ env: first }).pipe(
          ConfigProvider.constantCase,
          ConfigProvider.orElse(ConfigProvider.fromUnknown(second)),
        )
      expect(yield* read(config, combined({}, {}))).toEqual({ _tag: "None" })
      expect(
        yield* read(config, combined({ ACCESS_KEY_ID: "k" }, { secretAccessKey: "s" })),
      ).toEqual({ _tag: "Given", credentials: { accessKeyId: "k", secretAccessKey: "s" } })
      expect((yield* read(config, combined({ ACCESS_KEY_ID: "k" }, {})))._tag).toBe("Fails")
      expect((yield* read(config, combined({}, { secretAccessKey: "s" })))._tag).toBe("Fails")
    }),
  )

  it.effect("a provider that fails, fails the read as it did", () =>
    Effect.gen(function* () {
      const failing = ConfigProvider.make((path) =>
        path[0] === "SECRET"
          ? Effect.fail(new ConfigProvider.SourceError({ message: "the source is down" }))
          : Effect.succeed(ConfigProvider.makeValue("k")),
      )
      const now = yield* read(Config.all(keys), failing)
      expect(now).toEqual(yield* readAsBefore(Config.all(keys), failing))
      expect((now as { error: string }).error).toContain("the source is down")
    }),
  )
})

// ---------------------------------------------------------------------------
// On the wire: who signs. The SDK's default chain is given an identity of its
// own through the environment it reads, so a request it signed is told from one
// signed with the credentials configured.
// ---------------------------------------------------------------------------

const DEFAULT = { accessKeyId: "AKIDDEFAULT", secretAccessKey: "default-secret", token: "DEFAULT" }

const clients = {
  DynamoClient: {
    layer: (endpoint: string, credentials: Config.Config<Credentials>) =>
      DynamoClient.layerConfig({
        region: Config.succeed("us-east-1"),
        endpoint: Config.succeed(endpoint),
        credentials,
        maxAttempts: Config.succeed(1),
      }),
    call: Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.getItem({ TableName: "t", Key: { pk: { S: "a" } } })
    }),
  },
  DynamoStreamsClient: {
    layer: (endpoint: string, credentials: Config.Config<Credentials>) =>
      DynamoStreamsClient.layerConfig({
        region: Config.succeed("us-east-1"),
        endpoint: Config.succeed(endpoint),
        credentials,
        maxAttempts: Config.succeed(1),
      }),
    call: Effect.gen(function* () {
      const client = yield* DynamoStreamsClient
      yield* client.getRecords({ ShardIterator: "iterator" })
    }),
  },
} as const

/** One call through `layerConfig`: how the layer and call ended, and what was sent. */
const oneCall = (
  name: keyof typeof clients,
  credentials: Config.Config<Credentials>,
  values: Record<string, string>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* localServer()
      const client = clients[name]
      const call: Effect.Effect<void, unknown, DynamoClient | DynamoStreamsClient> = client.call
      const layer = (
        client.layer(server.endpoint, credentials) as Layer.Layer<
          DynamoClient | DynamoStreamsClient,
          Config.ConfigError
        >
      ).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: values }))))
      const exit = yield* Effect.exit(call.pipe(Effect.provide(layer)))
      return {
        failure: Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : undefined,
        requests: server.requests,
      }
    }),
  )

describe.each([
  "DynamoClient",
  "DynamoStreamsClient",
] as const)("%s.layerConfig credentials, on the wire", (name) => {
  beforeEach(() => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", DEFAULT.accessKeyId)
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", DEFAULT.secretAccessKey)
    vi.stubEnv("AWS_SESSION_TOKEN", DEFAULT.token)
    vi.stubEnv("AWS_PROFILE", undefined)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const required = group(Config.String("TOKEN"))
  const optional = group(Config.String("TOKEN").pipe(Config.withDefault(undefined)))

  it.live("none configured: the default chain signs, as it did", () =>
    Effect.gen(function* () {
      const { failure, requests } = yield* oneCall(name, required, {})
      expect(failure).toBeUndefined()
      expect(wire(requests, [DEFAULT.secretAccessKey])).toEqual([
        [DEFAULT.accessKeyId, DEFAULT.token, true],
      ])
    }),
  )

  it.live("all configured: they sign, as they did", () =>
    Effect.gen(function* () {
      const values = { KEY: "AKIDGIVEN", SECRET: "given", TOKEN: "GIVEN" }
      const { failure, requests } = yield* oneCall(name, required, values)
      expect(failure).toBeUndefined()
      expect(wire(requests, ["given"])).toEqual([["AKIDGIVEN", "GIVEN", true]])
    }),
  )

  it.live("a key and secret, the token optional and absent: they sign, with no token", () =>
    Effect.gen(function* () {
      const values = { KEY: "AKIDGIVEN", SECRET: "given" }
      const { failure, requests } = yield* oneCall(name, optional, values)
      expect(failure).toBeUndefined()
      expect(wire(requests, ["given"])).toEqual([["AKIDGIVEN", undefined, true]])
    }),
  )

  it.live.each([
    [
      "a key and secret, the token required and absent",
      { KEY: "AKIDGIVEN", SECRET: "given" },
      "TOKEN",
    ],
    [
      "a key and secret, the token required and empty",
      { KEY: "AKIDGIVEN", SECRET: "given", TOKEN: "" },
      "TOKEN",
    ],
    ["a key without its secret", { KEY: "AKIDGIVEN" }, "SECRET"],
    ["a secret without its key", { SECRET: "given" }, "KEY"],
    ["a token alone", { TOKEN: "GIVEN" }, "KEY"],
  ] as const)("%s: the layer fails and nothing is sent", ([, values, missing]) =>
    Effect.gen(function* () {
      const { failure, requests } = yield* oneCall(name, required, values)
      expect(failure).toContain("ConfigError")
      expect(failure).toContain(`["${missing}"]`)
      // Up to 1.40.0 this request went out signed by the default chain's identity.
      expect(requests).toEqual([])
    }),
  )

  const byProfile = Config.String("PROFILE").pipe(
    Config.flatMap((profile) =>
      Config.all({
        accessKeyId: Config.String(`${profile}_KEY`),
        secretAccessKey: Config.String(`${profile}_SECRET`),
      }),
    ),
  )

  it.live("a value that only selects what to read: the default chain signs, as it did", () =>
    Effect.gen(function* () {
      const { failure, requests } = yield* oneCall(name, byProfile, { PROFILE: "dev" })
      expect(failure).toBeUndefined()
      expect(wire(requests, [DEFAULT.secretAccessKey])).toEqual([
        [DEFAULT.accessKeyId, DEFAULT.token, true],
      ])
    }),
  )

  it.live(
    "a key under the selection, without its secret: the layer fails and nothing is sent",
    () =>
      Effect.gen(function* () {
        const values = { PROFILE: "dev", dev_KEY: "AKIDGIVEN" }
        const { failure, requests } = yield* oneCall(name, byProfile, values)
        expect(failure).toContain("ConfigError")
        expect(failure).toContain('["dev_SECRET"]')
        expect(requests).toEqual([])
      }),
  )

  it.live("a part that can't be shown to be one: the default chain signs, as it did", () =>
    Effect.gen(function* () {
      const config = Config.all({
        accessKeyId: Config.String("KEY").pipe(Config.map((key) => `id-${key.length}`)),
        secretAccessKey: Config.String("SECRET"),
      })
      const { failure, requests } = yield* oneCall(name, config, { KEY: "AKIDGIVEN" })
      expect(failure).toBeUndefined()
      expect(wire(requests, [DEFAULT.secretAccessKey])).toEqual([
        [DEFAULT.accessKeyId, DEFAULT.token, true],
      ])
    }),
  )
})
