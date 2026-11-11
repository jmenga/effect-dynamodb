/**
 * Finds tests whose Effect never runs (#243).
 *
 * A plain `it("…", () => Effect.gen(…))` returns a lazy Effect that vitest
 * ignores, so the test passes whatever its assertions say. The same goes for
 * an Effect built as a statement and never yielded, and for an
 * `Effect.runPromise(…)` nobody awaits: the test ends before it settles.
 *
 * This is a syntactic check (the TypeScript parser, no type checker), so it is
 * fast enough to run over every test file of the workspace on each run. It
 * recognises an Effect by how it is built: a member of `Effect`, `Stream` or
 * `Layer` imported from `effect` (`Effect.gen(…)`, `Effect.void`; never a
 * `run*`), a `.pipe(…)` over one or with one among its arguments, or
 * `.asEffect()`. A test is a call of `it` / `test` / `describe` / `bench` /
 * `suite` imported from vitest (aliases and `layer`'s `it` parameter included)
 * other than `it.effect` / `scoped` / `live` / `scopedLive`. A value only its
 * type shows to be an Effect (a helper's result) is not reported: a sweep of
 * every test project with the type checker found no such test (#243).
 */
import ts from "typescript"

export type Rule = "unrun-test-body" | "dropped-effect" | "unawaited-run"

export type Finding = {
  readonly rule: Rule
  readonly line: number
  readonly test: string
  readonly text: string
}

const VITEST_MODULES = new Set(["vitest", "@effect/vitest"])
const REGISTRARS = new Set(["it", "test", "describe", "bench", "suite"])
/** The `it` members that run the Effect a test returns. */
const RUNNERS = new Set(["effect", "scoped", "live", "scopedLive"])
const EFFECT_MODULES = new Set(["Effect", "Stream", "Layer"])
const RUN = /^run(Promise|PromiseExit|Sync|SyncExit|Fork|Callback)$/
const AWAITED_RUN = /^run(Promise|PromiseExit)$/

const strip = (node: ts.Expression): ts.Expression => {
  let at = node
  while (
    ts.isParenthesizedExpression(at) ||
    ts.isAsExpression(at) ||
    ts.isSatisfiesExpression(at) ||
    ts.isNonNullExpression(at) ||
    ts.isTypeAssertionExpression(at)
  ) {
    at = at.expression
  }
  return at
}

const functionBoundary = (node: ts.Node): boolean => ts.isFunctionLike(node) || ts.isClassLike(node)

export const findUnrunEffects = (fileName: string, source: string): ReadonlyArray<Finding> => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const typesOnly = /\.types\.test\.ts$/.test(fileName)

  // Local names bound by imports: vitest registrars, and the Effect / Stream / Layer modules.
  const registrars = new Map<string, string>()
  const modules = new Map<string, string>()
  const pipes = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const from = statement.moduleSpecifier.text
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) {
      const named = /^effect\/(Effect|Stream|Layer)$/.exec(from)
      if (named?.[1] !== undefined) modules.set(bindings.name.text, named[1])
      continue
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text
      const local = element.name.text
      if (VITEST_MODULES.has(from) && REGISTRARS.has(imported)) registrars.set(local, imported)
      if (from === "effect" && EFFECT_MODULES.has(imported)) modules.set(local, imported)
      if ((from === "effect" || from === "effect/Function") && imported === "pipe") pipes.add(local)
    }
  }

  /** `it` as the parameter of a `layer(…)("…", (it) => …)` body. */
  const isParameter = (node: ts.Node, name: string): boolean => {
    for (let at = node.parent; at !== undefined; at = at.parent) {
      if (
        ts.isFunctionLike(at) &&
        at.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)
      ) {
        return true
      }
    }
    return false
  }

  /** The member names of a callee chain, from its root identifier: `it.each(…)` → [it, each]. */
  const chain = (callee: ts.Expression): ReadonlyArray<string> | undefined => {
    const names: Array<string> = []
    let at: ts.Expression = callee
    for (;;) {
      if (ts.isPropertyAccessExpression(at)) {
        names.unshift(at.name.text)
        at = at.expression
      } else if (ts.isCallExpression(at)) {
        at = at.expression
      } else if (ts.isIdentifier(at)) {
        const alias = aliases.get(at.text)
        if (alias !== undefined) return [...alias, ...names]
        const root =
          registrars.get(at.text) ?? (at.text === "it" && isParameter(at, "it") ? "it" : undefined)
        if (root === undefined) return undefined
        names.unshift(root)
        return names
      } else {
        return undefined
      }
    }
  }

  // `const describeConnected = available ? describe : describe.skip`, `const itLive = it.live`.
  const aliases = new Map<string, ReadonlyArray<string>>()
  const collectAliases = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const init = strip(node.initializer)
      const names = chain(ts.isConditionalExpression(init) ? strip(init.whenTrue) : init)
      if (names !== undefined) aliases.set(node.name.text, names)
    }
    ts.forEachChild(node, collectAliases)
  }
  collectAliases(file)

  const moduleMember = (node: ts.Expression): { module: string; member: string } | undefined => {
    const at = strip(node)
    const target = ts.isCallExpression(at) ? strip(at.expression) : at
    if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression))
      return undefined
    const module = modules.get(target.expression.text)
    return module === undefined ? undefined : { module, member: target.name.text }
  }

  const isRun = (node: ts.Expression, pattern: RegExp): boolean => {
    const found = moduleMember(node)
    return found !== undefined && found.module === "Effect" && pattern.test(found.member)
  }

  const pipeBuildsEffect = (
    receiver: ts.Expression | undefined,
    args: ts.NodeArray<ts.Expression>,
  ): boolean => {
    const last = args[args.length - 1]
    if (last !== undefined && isRun(last, RUN)) return false
    return (
      (receiver !== undefined && buildsEffect(receiver)) ||
      args.some((arg) => moduleMember(arg) !== undefined)
    )
  }

  /** Is this expression, by how it is built, an Effect / Stream / Layer that has not been run? */
  const buildsEffect = (node: ts.Expression): boolean => {
    const at = strip(node)
    if (ts.isPropertyAccessExpression(at)) {
      // `Effect.void`, `Layer.empty`, …
      const found = moduleMember(at)
      return found !== undefined && !(found.module === "Effect" && RUN.test(found.member))
    }
    if (!ts.isCallExpression(at)) return false
    const callee = strip(at.expression)
    if (ts.isPropertyAccessExpression(callee)) {
      const found = moduleMember(callee)
      if (found !== undefined) return !(found.module === "Effect" && RUN.test(found.member))
      if (callee.name.text === "asEffect") return true
      if (callee.name.text === "pipe") return pipeBuildsEffect(callee.expression, at.arguments)
      return false
    }
    if (ts.isIdentifier(callee) && pipes.has(callee.text)) {
      return pipeBuildsEffect(at.arguments[0], ts.factory.createNodeArray(at.arguments.slice(1)))
    }
    return false
  }

  /** A run whose promise the statement drops: `Effect.runPromise(…)` or `….pipe(…, Effect.runPromise)`. */
  const dropsPromise = (node: ts.Expression): boolean => {
    const at = strip(node)
    if (!ts.isCallExpression(at)) return false
    if (isRun(at, AWAITED_RUN)) return true
    const callee = strip(at.expression)
    const last = at.arguments[at.arguments.length - 1]
    const isPipe =
      (ts.isPropertyAccessExpression(callee) && callee.name.text === "pipe") ||
      (ts.isIdentifier(callee) && pipes.has(callee.text))
    return isPipe && last !== undefined && isRun(last, AWAITED_RUN)
  }

  const returned = (fn: ts.ArrowFunction | ts.FunctionExpression): ReadonlyArray<ts.Expression> => {
    if (!ts.isBlock(fn.body)) return [fn.body]
    const found: Array<ts.Expression> = []
    const visit = (node: ts.Node): void => {
      if (functionBoundary(node)) return
      if (ts.isReturnStatement(node) && node.expression !== undefined) found.push(node.expression)
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(fn.body, visit)
    return found
  }

  const testName = (node: ts.Node): string => {
    for (let at = node.parent; at !== undefined; at = at.parent) {
      if (!ts.isCallExpression(at)) continue
      const names = chain(at.expression)
      const first = at.arguments[0]
      if (
        names !== undefined &&
        first !== undefined &&
        (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first))
      ) {
        return `${names.join(".")}(${first.getText(file)})`
      }
    }
    return "(module scope)"
  }

  const findings: Array<Finding> = []
  const report = (rule: Rule, node: ts.Node): void => {
    findings.push({
      rule,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      test: testName(node),
      text: node.getText(file).split("\n")[0] ?? "",
    })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const names = chain(node.expression)
      if (names !== undefined && !names.some((name) => RUNNERS.has(name))) {
        for (const arg of node.arguments) {
          if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) continue
          for (const expression of returned(arg)) {
            if (buildsEffect(expression)) report("unrun-test-body", expression)
          }
        }
      }
    }
    if (ts.isExpressionStatement(node)) {
      if (!typesOnly && buildsEffect(node.expression)) report("dropped-effect", node)
      else if (dropsPromise(node.expression)) report("unawaited-run", node)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return findings
}
