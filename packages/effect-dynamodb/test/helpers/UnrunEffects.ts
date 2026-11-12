/**
 * Finds tests whose Effect never runs (#243).
 *
 * A plain `it("…", () => Effect.gen(…))` returns a lazy Effect that vitest ignores, so the test
 * passes whatever its assertions say. The same goes for an Effect built and dropped, and for an
 * `Effect.runPromise(…)` nobody awaits: the test ends before it settles.
 *
 * This is a syntactic check (the TypeScript parser, no type checker), so it is fast enough to run
 * over every test file of the workspace on each run. Names are resolved by scope, so a local that
 * shadows an import is the local.
 *
 * It reports only what the file itself proves. An Effect is recognised by how it is built: a
 * member of `Effect`, `Stream` or `Layer` imported from `effect` (`Effect.gen(…)`, `Effect.void`,
 * `Fx.Effect.gen(…)` under `import * as Fx`, `gen(…)` imported from `effect/Effect`; never a
 * `run*`, an `is*` predicate, a `to*` conversion or `Effect.fn`, which builds a function); a
 * `.pipe(…)` or `pipe(…)` whose last stage is such a member (`Effect.provide(layer)`) or a function
 * every return of which builds an Effect (a pipe returns what its last stage does, so a pipe ending
 * in anything else is not one, whatever it starts with); `.asEffect()`; a typed client's operation
 * (a call chain off `db.entities.<Name>`, `db.aggregates.<Name>` or `db.collections.<name>`, `db` a
 * local `const` bound by `yield* DynamoClient.make(…)`); a `const` holding one; and a call of a
 * local function every return of which is one. A runner is `Effect.run*` (the `*With` forms once
 * given their context), another object's `run*` member (`runtime.runPromise`,
 * `NodeRuntime.runMain`), a local alias of one, or a local function that returns a run or runs one
 * of its parameters anywhere in its body (`async (e) => await Effect.runPromise(e)`,
 * `(e) => { Effect.runSync(e) }`).
 *
 * A test is a call of `it` / `test` / `describe` / `bench` / `suite` or a hook (`beforeAll`,
 * `beforeEach`, `afterAll`, `afterEach`) imported from vitest (an alias, a namespace member, an
 * undeclared global, `layer`'s body parameter, or a local function passing its parameter to one
 * included) other than `it.effect` / `scoped` / `live` / `scopedLive`. A conditional alias is a
 * plain test when every branch is.
 *
 * Reported:
 * - `unrun-test-body`: a plain test's callback returns an Effect (through `?:`, `&&`, `||`, `??`
 *   and `,` too), or the callback is itself `Effect.fn(…)` or a local function returning an Effect.
 * - `dropped-effect`: an Effect left as a statement (`void` included) or on the left of a `,`,
 *   awaited (which yields the Effect, unrun), returned from a `forEach` callback or from a `map`
 *   callback when the `map` call is itself left as a statement, or held in a local `const` nothing
 *   reads. Not inside a callback handed to `expect(…)` (a construction asserted to throw), nor in a
 *   `*.types.test.ts` file, which only type-checks.
 * - `unawaited-run`: a promise run left as a statement or on the left of a `,` (`.then` / `.catch`
 *   / `.finally` on one, an un-awaited `expect(…).resolves` / `.rejects` of one, `Promise.all` and
 *   kin over an array literal holding one or a `map` returning one, a call of a local runner that
 *   is `async` or returns one, or a `forEach` / `map` callback returning one, included) or held in a
 *   local `const` nothing reads; and a dropped `runFork` / `runCallback` in a test callback that is
 *   not `async`.
 *
 * In a `*.types.test.ts` file a returned Effect is reported only when it holds an `expect(…)`.
 *
 * Not reported, as the file alone doesn't prove it (each is a named case in
 * `unrun-effects-guard.test.ts`):
 * - a value only its type shows to be an Effect: an imported helper's or a method's result
 *   (`(): Effect.Effect<void> => makeProgram()`); a pipe ending in an imported function, an
 *   object's member (`h.run`) or a local function not known to build an Effect
 *   (`pipe(program, withLayer)`); a typed client not bound in the file by
 *   `yield* DynamoClient.make(…)`, or its groups destructured (`const { entities } = db`);
 *   `Effect`'s members destructured (`const { gen } = Effect`); a registrar or `Effect` re-exported
 *   by another module;
 * - a registrar reached by element access (`it["skip"](…)`); a wrapper that hands its test body on
 *   inside another function (`(n, f) => it(n, () => f())`), takes it in a destructured parameter,
 *   or is itself wrapped by another wrapper;
 * - an Effect returned from inside `Effect.gen` (it may be returned on purpose, for
 *   `Effect.flatten` or `Stream.unwrap`);
 * - an Effect or promise kept in a variable that is read but never yielded or awaited, in a `let`
 *   nothing reads, assigned to a variable declared outside the test, or in a `const` holding a
 *   `map`'s result;
 * - an Effect handed to a function that ignores it (a local one included), to `setTimeout`, or
 *   returned from a `.then` callback (`Promise.resolve().then(() => Effect.void)`);
 * - a `forEach` callback passed by name (`xs.forEach(check)`), or an `async` one that awaits a run;
 * - `void` on a run (`void Effect.runPromise(…)`), which says the promise is dropped on purpose;
 * - a `runFork` in an `async` test, which may await the fiber.
 *
 * `yield` without `*` inside `Effect.gen` is not reported: Effect 4 runs whatever is yielded.
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
const REGISTRARS = new Set([
  "it",
  "test",
  "describe",
  "bench",
  "suite",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
])
/** The `it` members that run the Effect a test returns. */
const RUNNERS = new Set(["effect", "scoped", "live", "scopedLive"])
/** Members whose call returns a registrar: `it.each([…])(…)`, `it.skipIf(c)(…)`. */
const FACTORIES = new Set(["each", "for", "skipIf", "runIf", "extend"])
const EFFECT_MODULES = new Set(["Effect", "Stream", "Layer"])
const RUN = /^run(Promise|PromiseExit|Sync|SyncExit|Fork|Callback)(With)?$/
/** A member that runs an Effect on an object of another kind: `runtime.runPromise`, `NodeRuntime.runMain`. */
const OTHER_RUN = /^run[A-Z]/
/** `Effect.isEffect`, `Stream.isStream`, …: a boolean. */
const PREDICATE = /^is[A-Z]/
/** `Stream.toReadableStream`, `Stream.toAsyncIterable`, …: may convert to something else. */
const CONVERSION = /^to[A-Z]/
/** `Effect.fn(…)` builds a function that returns an Effect. */
const FUNCTION_BUILDERS = new Set(["fn", "fnUntraced"])
/** A typed client's members: `db.entities.Users.put(…)`. */
const CLIENT_GROUPS = new Set(["entities", "aggregates", "collections"])
const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"])

type Chain = ReadonlyArray<string>
type Run = { readonly promise: boolean; readonly fork: boolean }
type Meaning =
  | { readonly kind: "registrar"; readonly chains: ReadonlyArray<Chain> }
  | { readonly kind: "vitest" }
  | { readonly kind: "layer" }
  | { readonly kind: "module"; readonly module: string }
  | { readonly kind: "effect" }
  | { readonly kind: "member"; readonly module: string; readonly member: string }
  | { readonly kind: "pipe" }
  | { readonly kind: "runner"; readonly run: Run }
  | { readonly kind: "built" }
  | { readonly kind: "builder" }
  | { readonly kind: "client" }
  | { readonly kind: "wrapper"; readonly indexes: ReadonlyArray<number> }

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration

const runOf = (name: string): Run => ({
  promise: /^run(Promise|PromiseExit)/.test(name),
  fork: /^run(Fork|Callback)/.test(name),
})

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

const isFunction = (node: ts.Node): node is FunctionNode =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)

const functionBoundary = (node: ts.Node): boolean => ts.isFunctionLike(node) || ts.isClassLike(node)

const isAsync = (fn: ts.Node): boolean =>
  ts.canHaveModifiers(fn) &&
  (ts.getModifiers(fn) ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)

/** What an expression may evaluate to: both branches of `?:`, the right of `&&` and `,`, either side of `||` / `??`. */
const outcomes = (node: ts.Expression): ReadonlyArray<ts.Expression> => {
  const at = strip(node)
  if (ts.isConditionalExpression(at)) return [...outcomes(at.whenTrue), ...outcomes(at.whenFalse)]
  if (ts.isBinaryExpression(at)) {
    const operator = at.operatorToken.kind
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandToken ||
      operator === ts.SyntaxKind.CommaToken
    ) {
      return outcomes(at.right)
    }
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [...outcomes(at.left), ...outcomes(at.right)]
    }
  }
  return [at]
}

/** The expressions a function returns (its body, for a concise arrow), not crossing nested functions. */
const returned = (fn: FunctionNode): ReadonlyArray<ts.Expression> => {
  if (fn.body === undefined) return []
  if (!ts.isBlock(fn.body)) return outcomes(fn.body)
  const found: Array<ts.Expression> = []
  const visit = (node: ts.Node): void => {
    if (functionBoundary(node)) return
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      found.push(...outcomes(node.expression))
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(fn.body, visit)
  return found
}

const moduleOf = (node: ts.Node): string | undefined => {
  for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
    if (ts.isImportDeclaration(at)) {
      return ts.isStringLiteral(at.moduleSpecifier) ? at.moduleSpecifier.text : undefined
    }
  }
  return undefined
}

const isScope = (node: ts.Node): boolean =>
  ts.isSourceFile(node) ||
  ts.isBlock(node) ||
  ts.isModuleBlock(node) ||
  ts.isCaseBlock(node) ||
  ts.isCatchClause(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isFunctionLike(node)

/** Is this identifier a use of a binding (not a property name or a declaration's own name)? */
const isReference = (id: ts.Identifier): boolean => {
  const p = id.parent
  if (ts.isPropertyAccessExpression(p)) return p.name !== id
  if (ts.isQualifiedName(p)) return p.right !== id
  if (ts.isBindingElement(p)) return p.name !== id && p.propertyName !== id
  if (
    ts.isPropertyAssignment(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isPropertySignature(p) ||
    ts.isGetAccessorDeclaration(p) ||
    ts.isSetAccessorDeclaration(p) ||
    ts.isEnumMember(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isParameter(p) ||
    ts.isFunctionDeclaration(p) ||
    ts.isFunctionExpression(p) ||
    ts.isClassDeclaration(p) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p)
  ) {
    return p.name !== id
  }
  return true
}

export const findUnrunEffects = (fileName: string, source: string): ReadonlyArray<Finding> => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const typesOnly = /\.types\.test\.ts$/.test(fileName)

  // -------------------------------------------------------------------------
  // Names, by scope
  // -------------------------------------------------------------------------

  const tables = new Map<ts.Node, Map<string, ts.Node>>()
  /** The names a scope declares, each to its declaration (a destructured name to its binding element). */
  const tableOf = (scope: ts.Node): Map<string, ts.Node> => {
    const known = tables.get(scope)
    if (known !== undefined) return known
    const table = new Map<string, ts.Node>()
    const add = (name: string, node: ts.Node) => {
      if (!table.has(name)) table.set(name, node)
    }
    const bind = (binding: ts.BindingName, holder: ts.Node): void => {
      if (ts.isIdentifier(binding)) {
        add(binding.text, holder)
        return
      }
      for (const element of binding.elements) {
        if (!ts.isOmittedExpression(element)) bind(element.name, element)
      }
    }
    const statements = (list: ReadonlyArray<ts.Statement>) => {
      for (const statement of list) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            bind(declaration.name, declaration)
          }
        } else if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
          statement.name !== undefined
        ) {
          add(statement.name.text, statement)
        } else if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause
          if (clause?.name !== undefined) add(clause.name.text, clause)
          const bindings = clause?.namedBindings
          if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
            add(bindings.name.text, bindings)
          } else if (bindings !== undefined) {
            for (const element of bindings.elements) add(element.name.text, element)
          }
        }
      }
    }
    if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) {
      statements(scope.statements)
    } else if (ts.isCaseBlock(scope)) {
      for (const clause of scope.clauses) statements(clause.statements)
    } else if (ts.isCatchClause(scope)) {
      if (scope.variableDeclaration !== undefined) {
        bind(scope.variableDeclaration.name, scope.variableDeclaration)
      }
    } else if (
      ts.isForStatement(scope) ||
      ts.isForOfStatement(scope) ||
      ts.isForInStatement(scope)
    ) {
      const init = scope.initializer
      if (init !== undefined && ts.isVariableDeclarationList(init)) {
        for (const declaration of init.declarations) bind(declaration.name, declaration)
      }
    } else if (ts.isFunctionLike(scope)) {
      for (const parameter of scope.parameters) bind(parameter.name, parameter)
      if (ts.isFunctionExpression(scope) && scope.name !== undefined) {
        add(scope.name.text, scope)
      }
    }
    tables.set(scope, table)
    return table
  }

  /** The declaration a name resolves to, or `undefined` for a global. */
  const resolved = new Map<ts.Identifier, ts.Node | undefined>()
  const declarationOf = (id: ts.Identifier): ts.Node | undefined => {
    if (resolved.has(id)) return resolved.get(id)
    let found: ts.Node | undefined
    for (let at: ts.Node | undefined = id.parent; at !== undefined; at = at.parent) {
      if (!isScope(at)) continue
      found = tableOf(at).get(id.text)
      if (found !== undefined) break
    }
    resolved.set(id, found)
    return found
  }

  const PENDING = Symbol("pending")
  const meanings = new Map<ts.Node, Meaning | undefined | typeof PENDING>()
  const meaningOf = (id: ts.Identifier): Meaning | undefined => {
    const declaration = declarationOf(id)
    if (declaration === undefined) {
      return REGISTRARS.has(id.text) ? { kind: "registrar", chains: [[id.text]] } : undefined
    }
    const known = meanings.get(declaration)
    if (known === PENDING) return undefined
    if (known !== undefined || meanings.has(declaration)) return known
    meanings.set(declaration, PENDING)
    const meaning = classify(declaration)
    meanings.set(declaration, meaning)
    return meaning
  }

  const classify = (declaration: ts.Node): Meaning | undefined => {
    if (ts.isImportSpecifier(declaration)) {
      const from = moduleOf(declaration)
      const imported = (declaration.propertyName ?? declaration.name).text
      if (from === undefined) return undefined
      if (VITEST_MODULES.has(from)) {
        if (REGISTRARS.has(imported)) return { kind: "registrar", chains: [[imported]] }
        return imported === "layer" ? { kind: "layer" } : undefined
      }
      if (from === "effect" && EFFECT_MODULES.has(imported)) {
        return { kind: "module", module: imported }
      }
      if ((from === "effect" || from === "effect/Function") && imported === "pipe") {
        return { kind: "pipe" }
      }
      const sub = /^effect\/(Effect|Stream|Layer)$/.exec(from)
      return sub?.[1] === undefined
        ? undefined
        : { kind: "member", module: sub[1], member: imported }
    }
    if (ts.isNamespaceImport(declaration)) {
      const from = moduleOf(declaration)
      if (from === undefined) return undefined
      if (VITEST_MODULES.has(from)) return { kind: "vitest" }
      if (from === "effect") return { kind: "effect" }
      const sub = /^effect\/(Effect|Stream|Layer)$/.exec(from)
      return sub?.[1] === undefined ? undefined : { kind: "module", module: sub[1] }
    }
    if (ts.isParameter(declaration)) return layerParameter(declaration)
    if (ts.isVariableDeclaration(declaration)) {
      const init = declaration.initializer
      if (init === undefined || !ts.isIdentifier(declaration.name)) return undefined
      const constant = (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      if (constant && makesClient(init)) return { kind: "client" }
      const chains = aliasChains(init)
      if (chains !== undefined) return { kind: "registrar", chains }
      const meaning = functionMeaning(init)
      if (meaning !== undefined) return meaning
      return constant && outcomes(init).every(buildsEffect) ? { kind: "built" } : undefined
    }
    if (ts.isFunctionDeclaration(declaration)) return functionMeaning(declaration)
    return undefined
  }

  /** `yield* DynamoClient.make(…)`, `DynamoClient` imported by that name: the typed client. */
  const makesClient = (init: ts.Expression): boolean => {
    const at = strip(init)
    if (
      !ts.isYieldExpression(at) ||
      at.asteriskToken === undefined ||
      at.expression === undefined
    ) {
      return false
    }
    const call = strip(at.expression)
    if (!ts.isCallExpression(call)) return false
    const callee = strip(call.expression)
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "make") return false
    const owner = strip(callee.expression)
    if (!ts.isIdentifier(owner)) return false
    const declaration = declarationOf(owner)
    return (
      declaration !== undefined &&
      ts.isImportSpecifier(declaration) &&
      (declaration.propertyName ?? declaration.name).text === "DynamoClient"
    )
  }

  /** The first parameter of a `layer(…)(name, (it) => …)` / `it.layer(…)(…)` body is an `it`. */
  const layerParameter = (parameter: ts.ParameterDeclaration): Meaning | undefined => {
    const fn = parameter.parent
    if (!ts.isIdentifier(parameter.name) || fn.parameters[0] !== parameter) return undefined
    const call = fn.parent
    if (call === undefined || !ts.isCallExpression(call)) return undefined
    if (!call.arguments.some((arg) => arg === fn)) return undefined
    const factory = strip(call.expression)
    if (!ts.isCallExpression(factory)) return undefined
    const callee = strip(factory.expression)
    const isLayer =
      (ts.isIdentifier(callee) && meaningOf(callee)?.kind === "layer") ||
      (ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "layer" &&
        chainsOf(callee.expression) !== undefined)
    return isLayer ? { kind: "registrar", chains: [["it"]] } : undefined
  }

  /** The registrar chains a callee may be: `it.each(…)` → [[it, each]]; an alias of `c ? it : it.skip` → both. */
  const chainsOf = (callee: ts.Expression): ReadonlyArray<Chain> | undefined => {
    const names: Array<string> = []
    let at = strip(callee)
    for (;;) {
      if (ts.isPropertyAccessExpression(at)) {
        names.unshift(at.name.text)
        at = strip(at.expression)
      } else if (ts.isCallExpression(at)) {
        at = strip(at.expression)
      } else if (ts.isIdentifier(at)) {
        const meaning = meaningOf(at)
        if (meaning?.kind === "registrar")
          return meaning.chains.map((chain) => [...chain, ...names])
        if (meaning?.kind === "vitest" && names[0] !== undefined && REGISTRARS.has(names[0])) {
          return [names]
        }
        return undefined
      } else {
        return undefined
      }
    }
  }

  /** A variable's registrar chains: a name, member or factory call of one, or a conditional over them. */
  const aliasChains = (init: ts.Expression): ReadonlyArray<Chain> | undefined => {
    const at = strip(init)
    if (ts.isConditionalExpression(at)) {
      const branches = [aliasChains(at.whenTrue), aliasChains(at.whenFalse)].filter(
        (each) => each !== undefined,
      )
      return branches.length === 0 ? undefined : branches.flat()
    }
    if (ts.isCallExpression(at)) {
      const callee = strip(at.expression)
      if (!ts.isPropertyAccessExpression(callee) || !FACTORIES.has(callee.name.text)) {
        return undefined
      }
      return chainsOf(at)
    }
    return ts.isIdentifier(at) || ts.isPropertyAccessExpression(at) ? chainsOf(at) : undefined
  }

  const plain = (chain: Chain) => !chain.some((name) => RUNNERS.has(name))

  // -------------------------------------------------------------------------
  // Effects and runs
  // -------------------------------------------------------------------------

  /** `Effect.gen`, `Effect["gen"]`, `Fx.Effect.gen`, or `gen` imported from `effect/Effect`. */
  const memberOf = (node: ts.Expression): { module: string; member: string } | undefined => {
    const at = strip(node)
    if (ts.isIdentifier(at)) {
      const meaning = meaningOf(at)
      return meaning?.kind === "member" ? meaning : undefined
    }
    let owner: ts.Expression
    let member: string
    if (ts.isPropertyAccessExpression(at)) {
      owner = strip(at.expression)
      member = at.name.text
    } else if (ts.isElementAccessExpression(at) && ts.isStringLiteralLike(at.argumentExpression)) {
      owner = strip(at.expression)
      member = at.argumentExpression.text
    } else {
      return undefined
    }
    if (ts.isIdentifier(owner)) {
      const meaning = meaningOf(owner)
      return meaning?.kind === "module" ? { module: meaning.module, member } : undefined
    }
    if (
      ts.isPropertyAccessExpression(owner) &&
      EFFECT_MODULES.has(owner.name.text) &&
      ts.isIdentifier(strip(owner.expression)) &&
      meaningOf(strip(owner.expression) as ts.Identifier)?.kind === "effect"
    ) {
      return { module: owner.name.text, member }
    }
    return undefined
  }

  const isEffectMember = (found: { module: string; member: string }) =>
    !(
      found.module === "Effect" &&
      (RUN.test(found.member) || FUNCTION_BUILDERS.has(found.member))
    ) &&
    !PREDICATE.test(found.member) &&
    !CONVERSION.test(found.member)

  /** The run member a node names: `Effect.runPromise`, `runtime.runPromise`, `NodeRuntime.runMain`. */
  const runName = (node: ts.Expression): string | undefined => {
    const at = strip(node)
    const found = memberOf(at)
    if (found !== undefined) {
      return found.module === "Effect" && RUN.test(found.member) ? found.member : undefined
    }
    return ts.isPropertyAccessExpression(at) && OTHER_RUN.test(at.name.text)
      ? at.name.text
      : undefined
  }

  /** A function that runs the Effect it is given, and how. */
  const runner = (node: ts.Expression): Run | undefined => {
    const at = strip(node)
    if (ts.isCallExpression(at)) {
      // `Effect.runPromiseWith(context)`
      const name = runName(at.expression)
      return name?.endsWith("With") ? runOf(name) : undefined
    }
    const name = runName(at)
    if (name !== undefined) return name.endsWith("With") ? undefined : runOf(name)
    if (ts.isIdentifier(at)) {
      const meaning = meaningOf(at)
      return meaning?.kind === "runner" ? meaning.run : undefined
    }
    return ts.isArrowFunction(at) || ts.isFunctionExpression(at) ? functionRun(at) : undefined
  }

  /**
   * How a local function runs an Effect, if it does: it returns a run, or runs one of its
   * parameters anywhere in its body (not in a function nested in it), as `async (e) => await
   * Effect.runPromise(e)` and `(e) => { Effect.runSync(e) }` do. Its call is a promise when it is
   * `async` or returns a run's promise (`.then` on one included).
   */
  const functionRun = (fn: FunctionNode): Run | undefined => {
    if (fn.asteriskToken !== undefined || fn.body === undefined) return undefined
    const results = returned(fn)
    for (const expression of results) {
      const run = runCall(expression)
      if (run !== undefined) return isAsync(fn) ? { promise: true, fork: run.fork } : run
    }
    if (!runsParameter(fn)) return undefined
    return { promise: isAsync(fn) || results.some(promiseOf), fork: false }
  }

  /** Does a run in `fn`'s body (not in a function nested in it) name one of `fn`'s parameters? */
  const runsParameter = (fn: FunctionNode): boolean => {
    const parameters = new Set<ts.Node>()
    for (const parameter of fn.parameters) {
      parameters.add(parameter)
      if (!ts.isIdentifier(parameter.name)) {
        const bind = (name: ts.BindingName): void => {
          if (ts.isIdentifier(name)) return
          for (const element of name.elements) {
            if (!ts.isOmittedExpression(element)) {
              parameters.add(element)
              bind(element.name)
            }
          }
        }
        bind(parameter.name)
      }
    }
    const names = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node) && isReference(node)) {
        const declaration = declarationOf(node)
        if (declaration !== undefined && parameters.has(declaration)) return true
      }
      return ts.forEachChild(node, names) === true
    }
    let found = false
    const visit = (node: ts.Node): void => {
      if (found || functionBoundary(node)) return
      if (ts.isCallExpression(node) && runCall(node) !== undefined && names(node)) {
        found = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(fn.body!)
    return found
  }

  /** `x.pipe(…)` or `pipe(x, …)`: the receiver and the functions piped through. */
  const pipeOf = (
    call: ts.CallExpression,
  ): { receiver: ts.Expression | undefined; args: ReadonlyArray<ts.Expression> } | undefined => {
    const callee = strip(call.expression)
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "pipe") {
      return { receiver: callee.expression, args: call.arguments }
    }
    if (ts.isIdentifier(callee) && meaningOf(callee)?.kind === "pipe") {
      return { receiver: call.arguments[0], args: call.arguments.slice(1) }
    }
    return undefined
  }

  /** A call that runs an Effect: a runner's call, or a pipe through one. */
  const runCalls = new Map<ts.Node, Run | undefined>()
  const runCall = (node: ts.Expression): Run | undefined => {
    const at = strip(node)
    if (!ts.isCallExpression(at)) return undefined
    if (runCalls.has(at)) return runCalls.get(at)
    runCalls.set(at, undefined)
    const run = runOfCall(at)
    runCalls.set(at, run)
    return run
  }
  /** A pipe returns what its last stage does, so it runs an Effect only when that stage is a runner. */
  const runOfCall = (at: ts.CallExpression): Run | undefined => {
    const direct = runner(at.expression)
    if (direct !== undefined) return direct
    const last = pipeOf(at)?.args.at(-1)
    return last === undefined ? undefined : runner(last)
  }

  /**
   * Is this a call chain off a typed client's group (`db.entities.Users.put(…).condition(…)`), the
   * client a local `const` bound by `yield* DynamoClient.make(…)`?
   */
  const clientOperation = (call: ts.CallExpression): boolean => {
    let at: ts.Expression = call.expression
    for (;;) {
      at = strip(at)
      if (ts.isCallExpression(at)) {
        at = at.expression
      } else if (ts.isPropertyAccessExpression(at)) {
        const owner = strip(at.expression)
        if (ts.isPropertyAccessExpression(owner) && CLIENT_GROUPS.has(owner.name.text)) {
          const client = strip(owner.expression)
          return ts.isIdentifier(client) && meaningOf(client)?.kind === "client"
        }
        at = owner
      } else {
        return false
      }
    }
  }

  /** A function that returns an Effect: `Effect.fn(…)`, a local one every return of which builds one. */
  const buildsFunction = (node: ts.Expression): boolean => {
    const at = strip(node)
    if (ts.isIdentifier(at)) return meaningOf(at)?.kind === "builder"
    if (ts.isCallExpression(at)) {
      const found = memberOf(at.expression)
      if (found?.module === "Effect" && FUNCTION_BUILDERS.has(found.member)) return true
      // `Effect.fn("name")(function* …)`
      const inner = strip(at.expression)
      if (ts.isCallExpression(inner)) {
        const named = memberOf(inner.expression)
        return named?.module === "Effect" && FUNCTION_BUILDERS.has(named.member)
      }
      return false
    }
    if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) {
      return functionMeaning(at)?.kind === "builder"
    }
    return false
  }

  const functionMeaning = (node: ts.Node): Meaning | undefined => {
    const at = ts.isFunctionDeclaration(node) ? node : strip(node as ts.Expression)
    if (!isFunction(at)) {
      const run = runner(at as ts.Expression)
      if (run !== undefined) return { kind: "runner", run }
      return buildsFunction(at as ts.Expression) ? { kind: "builder" } : undefined
    }
    if (at.asteriskToken !== undefined) return undefined
    const run = functionRun(at)
    if (run !== undefined) return { kind: "runner", run }
    const wrapper = wrapperOf(at)
    if (wrapper !== undefined) return wrapper
    if (isAsync(at)) return undefined
    const results = returned(at)
    return results.length > 0 && results.every(buildsEffect) ? { kind: "builder" } : undefined
  }

  /** A local function that registers a plain test with its parameters among the arguments. */
  const wrapperOf = (fn: FunctionNode): Meaning | undefined => {
    if (fn.body === undefined) return undefined
    const indexes = new Set<number>()
    const visit = (node: ts.Node): void => {
      if (functionBoundary(node)) return
      if (ts.isCallExpression(node)) {
        const chains = chainsOf(node.expression)
        if (chains?.every(plain)) {
          for (const arg of node.arguments) {
            const at = strip(arg)
            if (!ts.isIdentifier(at)) continue
            const declaration = declarationOf(at)
            const index = fn.parameters.indexOf(declaration as ts.ParameterDeclaration)
            if (index >= 0) indexes.add(index)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(fn.body)
    return indexes.size === 0 ? undefined : { kind: "wrapper", indexes: [...indexes] }
  }

  /** Is this expression, by how it is built, an Effect / Stream / Layer that has not been run? */
  const built = new Map<ts.Node, boolean>()
  const buildsEffect = (node: ts.Expression): boolean => {
    const at = strip(node)
    const known = built.get(at)
    if (known !== undefined) return known
    built.set(at, false)
    const result = buildsEffectOf(at)
    built.set(at, result)
    return result
  }
  const buildsEffectOf = (at: ts.Expression): boolean => {
    if (ts.isIdentifier(at)) {
      const meaning = meaningOf(at)
      return meaning?.kind === "built" || (meaning?.kind === "member" && isEffectMember(meaning))
    }
    if (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at)) {
      // `Effect.void`, `Layer.empty`, …
      const found = memberOf(at)
      return found !== undefined && isEffectMember(found)
    }
    if (!ts.isCallExpression(at) || runCall(at) !== undefined) return false
    const callee = strip(at.expression)
    if (buildsFunction(callee)) return true
    const found = memberOf(callee)
    if (found !== undefined) return isEffectMember(found)
    const piped = pipeOf(at)
    if (piped !== undefined) {
      const last = piped.args.at(-1)
      if (last === undefined) return piped.receiver !== undefined && buildsEffect(piped.receiver)
      return stageBuildsEffect(last)
    }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "asEffect") return true
    return clientOperation(at)
  }

  /**
   * Does a pipe's stage return an Effect, whatever it is given: a member of `Effect`, `Stream` or
   * `Layer` (`Effect.asVoid`, `Effect.provide(layer)`), or a function every return of which builds
   * one (`Effect.fn(…)`, `() => Effect.void`, a local one).
   */
  const stageBuildsEffect = (stage: ts.Expression): boolean => {
    const at = strip(stage)
    const found = memberOf(ts.isCallExpression(at) ? at.expression : at)
    if (found !== undefined) return isEffectMember(found)
    return buildsFunction(at)
  }

  /** A promise from a run: `Effect.runPromise(…)`, and `.then` / `.catch` / `.finally` on one. */
  const promiseOf = (node: ts.Expression): boolean => {
    const at = strip(node)
    if (!ts.isCallExpression(at)) return false
    if (runCall(at)?.promise === true) return true
    const callee = strip(at.expression)
    return (
      ts.isPropertyAccessExpression(callee) &&
      ["then", "catch", "finally"].includes(callee.name.text) &&
      promiseOf(callee.expression)
    )
  }

  /** An `expect(…).resolves` / `.rejects` chain over a run's promise. */
  const settlesPromise = (call: ts.CallExpression): boolean => {
    let settles = false
    let at: ts.Expression = call.expression
    for (;;) {
      at = strip(at)
      if (ts.isPropertyAccessExpression(at)) {
        if (at.name.text === "resolves" || at.name.text === "rejects") settles = true
        at = at.expression
      } else if (ts.isCallExpression(at)) {
        const callee = strip(at.expression)
        if (ts.isIdentifier(callee) && callee.text === "expect") {
          const subject = at.arguments[0]
          return settles && subject !== undefined && promiseOf(subject)
        }
        at = at.expression
      } else {
        return false
      }
    }
  }

  /** A statement that drops a run's promise. */
  const dropsPromise = (node: ts.Expression): boolean => {
    const at = strip(node)
    if (!ts.isCallExpression(at)) return false
    if (promiseOf(at) || settlesPromise(at)) return true
    const callee = strip(at.expression)
    if (
      ts.isPropertyAccessExpression(callee) &&
      PROMISE_COMBINATORS.has(callee.name.text) &&
      ts.isIdentifier(strip(callee.expression)) &&
      (strip(callee.expression) as ts.Identifier).text === "Promise"
    ) {
      return at.arguments.some((arg) => {
        const list = strip(arg)
        if (ts.isArrayLiteralExpression(list)) return list.elements.some((each) => promiseOf(each))
        return callbackReturns(list, ["map"]) === "promise"
      })
    }
    return false
  }

  /**
   * What the callback of a `forEach(…)` / `map(…)` call (of the `methods` named) returns: an Effect,
   * a run's promise, or neither.
   */
  const callbackReturns = (
    node: ts.Expression,
    methods: ReadonlyArray<string> = ["forEach", "map"],
  ): "effect" | "promise" | undefined => {
    const at = strip(node)
    if (!ts.isCallExpression(at)) return undefined
    const callee = strip(at.expression)
    if (!ts.isPropertyAccessExpression(callee)) return undefined
    if (!methods.includes(callee.name.text)) return undefined
    const callback = at.arguments[0] === undefined ? undefined : strip(at.arguments[0])
    if (
      callback === undefined ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ) {
      return undefined
    }
    if (callback.asteriskToken !== undefined || isAsync(callback)) return undefined
    const results = returned(callback)
    if (results.some(buildsEffect)) return "effect"
    return results.some(promiseOf) ? "promise" : undefined
  }

  // -------------------------------------------------------------------------
  // Where
  // -------------------------------------------------------------------------

  const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
    for (let at = node.parent; at !== undefined; at = at.parent) {
      if (ts.isFunctionLike(at)) return at
    }
    return undefined
  }

  /** Inside a callback handed to `expect(…)`: a construction asserted to throw. */
  const insideExpectCallback = (node: ts.Node): boolean => {
    const fn = enclosingFunction(node)
    const call = fn?.parent
    if (call === undefined || !ts.isCallExpression(call)) return false
    const callee = strip(call.expression)
    return ts.isIdentifier(callee) && callee.text === "expect"
  }

  /** Directly inside a test callback that is not `async`. */
  const inSyncTest = (node: ts.Node): boolean => {
    const fn = enclosingFunction(node)
    const call = fn?.parent
    if (fn === undefined || call === undefined || !ts.isCallExpression(call)) return false
    return chainsOf(call.expression) !== undefined && !isAsync(fn)
  }

  const hasAssertion = (node: ts.Node): boolean => {
    let found = false
    const visit = (at: ts.Node): void => {
      if (found) return
      if (ts.isCallExpression(at)) {
        const callee = strip(at.expression)
        if (ts.isIdentifier(callee) && callee.text === "expect") found = true
      }
      ts.forEachChild(at, visit)
    }
    visit(node)
    return found
  }

  const isReferenced = (declaration: ts.VariableDeclaration, scope: ts.Node): boolean => {
    const name = (declaration.name as ts.Identifier).text
    let found = false
    const visit = (node: ts.Node): void => {
      if (found) return
      if (
        ts.isIdentifier(node) &&
        node.text === name &&
        isReference(node) &&
        declarationOf(node) === declaration
      ) {
        found = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(scope)
    return found
  }

  const testName = (node: ts.Node): string => {
    for (let at = node.parent; at !== undefined; at = at.parent) {
      if (!ts.isCallExpression(at)) continue
      const chains = chainsOf(at.expression)
      const first = at.arguments[0]
      if (
        chains?.[0] !== undefined &&
        first !== undefined &&
        (ts.isStringLiteralLike(first) || ts.isTemplateExpression(first))
      ) {
        return `${chains[0].join(".")}(${first.getText(file)})`
      }
    }
    return "(module scope)"
  }

  // -------------------------------------------------------------------------
  // The check
  // -------------------------------------------------------------------------

  const findings: Array<Finding> = []
  const report = (rule: Rule, node: ts.Node): void => {
    findings.push({
      rule,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      test: testName(node),
      text: node.getText(file).split("\n")[0] ?? "",
    })
  }

  /** A test callback, or a test body passed by name. */
  const checkBody = (arg: ts.Expression): void => {
    const at = strip(arg)
    if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) {
      if (at.asteriskToken !== undefined) return
      for (const expression of returned(at)) {
        if (buildsEffect(expression) && (!typesOnly || hasAssertion(expression))) {
          report("unrun-test-body", expression)
        }
      }
      return
    }
    if (!typesOnly && buildsFunction(at)) report("unrun-test-body", at)
  }

  const checkRegistration = (call: ts.CallExpression): void => {
    const callee = strip(call.expression)
    if (ts.isIdentifier(callee)) {
      const meaning = meaningOf(callee)
      if (meaning?.kind === "wrapper") {
        for (const index of meaning.indexes) {
          const body = call.arguments[index]
          if (body !== undefined) checkBody(body)
        }
        return
      }
    }
    const chains = chainsOf(call.expression)
    if (chains === undefined || !chains.every(plain)) return
    for (const arg of call.arguments) checkBody(arg)
  }

  /** What dropping `dropped` (a statement's expression, or the left of a `,`) drops: an Effect, or a run's promise. */
  const droppedBy = (dropped: ts.Expression, at: ts.Node): Rule | undefined => {
    const expression = strip(dropped)
    const operand = ts.isVoidExpression(expression) ? expression.expression : expression
    if (!typesOnly && !insideExpectCallback(at) && outcomes(operand).some(buildsEffect)) {
      return "dropped-effect"
    }
    if (ts.isVoidExpression(expression)) return undefined
    if (dropsPromise(expression)) return "unawaited-run"
    if (runCall(expression)?.fork === true && inSyncTest(at)) return "unawaited-run"
    const callback = callbackReturns(expression)
    if (callback === "effect" && !typesOnly) return "dropped-effect"
    return callback === "promise" ? "unawaited-run" : undefined
  }

  /** A local `const` holding an Effect or a run's promise that nothing reads. */
  const checkUnread = (declaration: ts.VariableDeclaration): void => {
    const list = declaration.parent
    const statement = list.parent
    if (
      typesOnly ||
      declaration.initializer === undefined ||
      !ts.isIdentifier(declaration.name) ||
      (list.flags & ts.NodeFlags.Const) === 0 ||
      !ts.isVariableStatement(statement) ||
      ts.isSourceFile(statement.parent)
    ) {
      return
    }
    const effect = outcomes(declaration.initializer).some(buildsEffect)
    const promise = !effect && promiseOf(declaration.initializer)
    if ((effect || promise) && !isReferenced(declaration, statement.parent)) {
      report(effect ? "dropped-effect" : "unawaited-run", declaration)
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) checkRegistration(node)
    if (ts.isExpressionStatement(node)) {
      const rule = droppedBy(node.expression, node)
      if (rule !== undefined) report(rule, node)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      const rule = droppedBy(node.left, node)
      if (rule !== undefined) report(rule, node.left)
    }
    if (ts.isAwaitExpression(node) && !typesOnly && outcomes(node.expression).some(buildsEffect)) {
      report("dropped-effect", node)
    }
    if (ts.isVariableDeclaration(node)) checkUnread(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return findings
}
