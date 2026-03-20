/**
 * @internal Aggregate cursor and update context types.
 *
 * Extracted from Aggregate.ts for decomposition. Not part of the public API.
 */

import type { Optic } from "effect"

// ---------------------------------------------------------------------------
// UpdateContext — optics support for Aggregate.update
// ---------------------------------------------------------------------------

/**
 * A pre-bound optic rooted at the current aggregate state.
 * Navigate with `.key()`, `.optionalKey()`, or `.at()`, then apply terminals
 * `.get()`, `.replace()`, or `.modify()` — no need to pass the source explicitly.
 * For composing externally-defined optics, use `optic` + `state`.
 */
export interface Cursor<S, A = S> {
  /** Focus on a required key */
  readonly key: <K extends keyof A & string>(k: K) => Cursor<S, A[K]>
  /** Focus on an optional key (narrows away `undefined`) */
  readonly optionalKey: <K extends keyof A & string>(k: K) => Cursor<S, NonNullable<A[K]>>
  /** Focus on an array element by index (available when focused on an array) */
  readonly at: A extends ReadonlyArray<infer E> ? (index: number) => Cursor<S, E> : never
  /** Read the focused value (returns `undefined` for absent optional/indexed focuses) */
  readonly get: () => A
  /** Replace the focused value, returning the full updated state */
  readonly replace: (value: A) => S
  /** Modify the focused value with a function, returning the full updated state */
  readonly modify: (f: (a: A) => A) => S
}

/** @internal Build a cursor by binding a source value into an optic */
export const makeCursor = <S>(source: S, optic: Optic.Iso<S, S>): Cursor<S, S> => {
  const build = <A>(op: any): Cursor<S, A> => ({
    key: (k) => build(op.key(k)),
    optionalKey: (k) => build(op.optionalKey(k)),
    at: ((index: number) => build(op.at(index))) as any,
    get: () => (op.get ? op.get(source) : op.getResult(source)?.value),
    replace: (value) => op.replace(value, source),
    modify: (f) => op.modify(f)(source),
  })
  return build(optic)
}

/** Context provided to the aggregate update mutation function */
export interface UpdateContext<TIso, TClass = unknown> {
  /** The current aggregate state as a plain object */
  readonly state: TIso
  /** Pre-bound cursor — navigate with `.key()`, then `.get()` / `.replace()` / `.modify()` */
  readonly cursor: Cursor<TIso>
  /** Composable optic rooted at the plain type — use with externally-defined lenses and `state` */
  readonly optic: Optic.Iso<TIso, TIso>
  /** The current state as a Schema.Class instance (rarely needed) */
  readonly current: TClass
}

/** Discriminator config for binding a sub-aggregate */
export interface DiscriminatorConfig {
  readonly discriminator: Record<string, unknown>
}
