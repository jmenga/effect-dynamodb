/**
 * Static guard for #190.
 *
 * `Effect.tryPromise` hands its `try` a signal that aborts when the fiber is
 * interrupted, and the SDK only ends a request if it is given that signal. A send
 * without it still works and still interrupts, but the request runs on, unseen, with
 * every retry it has. This test fails on any `.send(` in a `src/` file of
 * `effect-dynamodb` or `effect-dynamodb-geo` that doesn't pass `abortSignal`, so a new
 * operation can't miss it. Comments and strings don't count.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"

const packages = fileURLToPath(new URL("../../", import.meta.url))

const roots = [
  join(packages, "effect-dynamodb", "src"),
  join(packages, "effect-dynamodb-geo", "src"),
]

/** Sends that aren't an SDK client's: `file` + the call, written as the source has it. */
const notSdkSends = new Set(["effect-dynamodb/src/Entity.ts args.send(sent)"])

/** Strip comments and string / template contents, keeping line structure. */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, (template) => template.replace(/[^\n]/g, " "))

/** Every `.send(...)`, whole however many lines it spans, with the receiver before it. */
const sendsIn = (source: string): Array<{ line: number; call: string; args: string }> => {
  const text = code(source)
  const found: Array<{ line: number; call: string; args: string }> = []
  for (const match of text.matchAll(/([\w$.]*)\.send\(/g)) {
    const open = match.index + match[0].length
    let depth = 1
    let end = open
    while (depth > 0 && end < text.length) {
      if ("([{".includes(text[end]!)) depth++
      else if (")]}".includes(text[end]!)) depth--
      end++
    }
    const args = text.slice(open, end - 1)
    found.push({
      line: text.slice(0, match.index).split("\n").length,
      call: `${match[1]}.send(${args.replace(/\s+/g, " ").trim()})`,
      args,
    })
  }
  return found
}

const offenders = (source: string) =>
  sendsIn(source).filter(({ args }) => !/\babortSignal\s*:\s*signal\b/.test(args))

const files = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : []
  })

const sources = () =>
  roots.flatMap((root) =>
    files(root).map((file) => ({
      name: relative(packages, file).split("\\").join("/"),
      source: readFileSync(file, "utf8"),
    })),
  )

describe("abort signal static guard", () => {
  it("recognises a send that drops the signal, on one line or several", () => {
    const forms = [
      "client.send(new GetItemCommand(input))",
      "yield* Effect.tryPromise({ try: () => client.send(new GetItemCommand(input)), catch })",
      "client\n  .send(new GetItemCommand(input))",
      "client.send(\n  new GetItemCommand(input),\n)",
      "client.send(new GetItemCommand(input), {})",
      "this.sdk.send(command, { requestTimeout: 5 })",
    ]
    for (const form of forms) expect([form, offenders(form).length]).toEqual([form, 1])
    const fine = [
      "client.send(new GetItemCommand(input), { abortSignal: signal })",
      "client.send(\n  new GetItemCommand(input),\n  { abortSignal: signal },\n)",
      "try: (signal) => client.send(new GetItemCommand(input), { abortSignal: signal }),",
      "// client.send(new GetItemCommand(input))",
      '"client.send(new GetItemCommand(input))"',
      "resend(input)",
    ]
    for (const form of fine) expect([form, offenders(form).length]).toEqual([form, 0])
  })

  it("every send it lets through is still there", () => {
    const seen = new Set(
      sources().flatMap(({ name, source }) => sendsIn(source).map(({ call }) => `${name} ${call}`)),
    )
    for (const allowed of notSdkSends) expect([allowed, seen.has(allowed)]).toEqual([allowed, true])
  })

  it("every SDK send in src passes the abort signal", () => {
    const found: Array<string> = []
    for (const { name, source } of sources()) {
      for (const { line, call } of offenders(source)) {
        if (!notSdkSends.has(`${name} ${call}`)) found.push(`${name}:${line}: ${call}`)
      }
    }
    expect(found).toEqual([])
  })

  it("is looking at the clients' sends", () => {
    const count = (file: string) =>
      sendsIn(readFileSync(join(packages, "effect-dynamodb", "src", file), "utf8")).length
    expect(count("DynamoClient.ts")).toBeGreaterThanOrEqual(30)
    expect(count("change-feed/DynamoStreamsClient.ts")).toBeGreaterThanOrEqual(4)
  })
})
