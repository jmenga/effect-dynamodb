/**
 * @internal Reading Effect's own declarations back as real instances.
 *
 * DynamoDB hands back a `BigDecimal`, a `Duration`, a zone, a cookie, a version, an address, a DNS
 * record, or a `DateTime` inside an `Option` or a `Result`, as the map the marshaller made of it,
 * and the declaration's parser takes that map as it is. {@link readingInstances} gives a read schema
 * each of these declarations as {@link readingDeclaration} builds it: its parser decides on what's
 * stored exactly as it always did, and what it takes comes back as the instance it stands for.
 *
 * A row is decoded once. Nothing is decoded twice, and nothing a schema runs (a check, a
 * transformation, a class's constructor, a declaration's parser, a default) runs more often than it
 * did. What changes is what such code sees at one of these positions: the instance, where it saw a
 * map that only looked like one.
 *
 * What a schema needs is decided once, when it's built: a schema holding none of these declarations
 * is returned as it is, the same object, and costs nothing on a read.
 */
import { Schema, SchemaAST } from "effect"
import {
  type InstanceKind,
  isReadingDeclaration,
  readDeclarationOf,
  readingDeclaration,
} from "./EffectInstances.js"

type AST = SchemaAST.AST

const astWith = <A extends AST>(ast: A, changes: Partial<A>): A =>
  Object.assign(Object.create(Object.getPrototypeOf(ast)), ast, changes)

/** Every node a value of this node passes through: its children, and what its encoding reads. */
const childrenOf = (ast: AST): ReadonlyArray<AST> => {
  const encoded = ast.encoding?.map((link) => link.to) ?? []
  switch (ast._tag) {
    case "Declaration":
      return [...ast.typeParameters, ...encoded]
    case "Arrays":
      return [...ast.elements, ...ast.rest, ...encoded]
    case "Objects":
      return [
        ...ast.propertySignatures.map((property) => property.type),
        ...ast.indexSignatures.map((index) => index.type),
        ...encoded,
      ]
    case "Union":
      return [...ast.types, ...encoded]
    case "Suspend":
      return [ast.thunk(), ...encoded]
    default:
      return encoded
  }
}

/** The same node with its children, and its encoding's, through `f`; itself when none changed. */
export const rebuiltChildren = (ast: AST, f: (child: AST) => AST): AST => {
  let read: AST
  switch (ast._tag) {
    case "Declaration": {
      const typeParameters = SchemaAST.mapOrSame(ast.typeParameters, f)
      read = typeParameters === ast.typeParameters ? ast : astWith(ast, { typeParameters })
      break
    }
    case "Arrays": {
      const elements = SchemaAST.mapOrSame(ast.elements, f)
      const rest = SchemaAST.mapOrSame(ast.rest, f)
      read = elements === ast.elements && rest === ast.rest ? ast : astWith(ast, { elements, rest })
      break
    }
    case "Objects": {
      const propertySignatures = SchemaAST.mapOrSame(ast.propertySignatures, (property) => {
        const type = f(property.type)
        return type === property.type
          ? property
          : new SchemaAST.PropertySignature(property.name, type)
      })
      const indexSignatures = SchemaAST.mapOrSame(ast.indexSignatures, (index) => {
        const type = f(index.type)
        return type === index.type ? index : new SchemaAST.IndexSignature(index.parameter, type)
      })
      read =
        propertySignatures === ast.propertySignatures && indexSignatures === ast.indexSignatures
          ? ast
          : astWith(ast, { propertySignatures, indexSignatures })
      break
    }
    case "Union": {
      const types = SchemaAST.mapOrSame(ast.types, f)
      read = types === ast.types ? ast : astWith(ast, { types })
      break
    }
    case "Suspend": {
      const inner = ast.thunk()
      read = astWith(ast, { thunk: () => f(inner) })
      break
    }
    default:
      read = ast
  }
  const encoding =
    ast.encoding &&
    (SchemaAST.mapOrSame(ast.encoding, (link) => {
      const to = f(link.to)
      return to === link.to ? link : new SchemaAST.Link(to, link.transformation)
    }) as SchemaAST.Encoding)
  return encoding === ast.encoding ? read : astWith(read, { encoding })
}

/**
 * Whether anything reachable from a node satisfies `test`. A recursive schema reaches itself through a
 * suspension: a node is only remembered as not satisfying when nothing it reached was still open.
 */
export const reaching = (test: (ast: AST) => boolean) => {
  const memo = new WeakMap<AST, boolean>()
  return (root: AST): boolean => {
    const open = new Set<AST>()
    const visit = (ast: AST): { readonly found: boolean; readonly cyclic: boolean } => {
      const known = memo.get(ast)
      if (known !== undefined) return { found: known, cyclic: false }
      if (open.has(ast)) return { found: false, cyclic: true }
      if (test(ast)) {
        memo.set(ast, true)
        return { found: true, cyclic: false }
      }
      open.add(ast)
      let cyclic = false
      for (const child of childrenOf(ast)) {
        const reached = visit(child)
        if (reached.found) {
          open.delete(ast)
          memo.set(ast, true)
          return reached
        }
        cyclic ||= reached.cyclic
      }
      open.delete(ast)
      if (!cyclic) memo.set(ast, false)
      return { found: false, cyclic }
    }
    return visit(root).found
  }
}

/**
 * A read of each of Effect's look-alike declarations of the kinds `takes` names back as a real
 * instance, memoised per schema; one reader per rule, so each is built once.
 */
const readerOf = (takes: (kind: InstanceKind) => boolean) => {
  const kindOf = (ast: AST): InstanceKind | undefined => {
    const kind = readDeclarationOf(ast)
    return kind !== undefined && takes(kind) ? kind : undefined
  }
  /** Whether a node holds one of these declarations anywhere, not yet read. */
  const holds = reaching((ast) => kindOf(ast) !== undefined && !isReadingDeclaration(ast))
  const memo = new WeakMap<AST, AST>()
  /** A node with each of these declarations in it read back as the instance. */
  const reading = (ast: AST): AST => {
    const known = memo.get(ast)
    if (known !== undefined) return known
    const kind = kindOf(ast)
    const built =
      kind !== undefined
        ? isReadingDeclaration(ast)
          ? ast
          : rebuiltChildren(readingDeclaration(ast as SchemaAST.Declaration, kind), reading)
        : holds(ast)
          ? rebuiltChildren(ast, reading)
          : ast
    memo.set(ast, built)
    return built
  }
  const schemas = new WeakMap<Schema.Top, Schema.Top>()
  return <S extends Schema.Top>(schema: S): S => {
    const known = schemas.get(schema)
    if (known !== undefined) return known as S
    const ast = reading(schema.ast)
    const read = ast === schema.ast ? schema : (Schema.make<Schema.Top>(ast) as unknown as S)
    schemas.set(schema, read)
    return read
  }
}

/**
 * A read schema with each of Effect's look-alike declarations in it read back as a real instance
 * ({@link readingDeclaration}). The schema itself, the same object, when it holds none.
 */
export const readingInstances: <S extends Schema.Top>(schema: S) => S = readerOf(() => true)

/**
 * {@link readingInstances} for composing a key from a value read back: every kind but a cookie and
 * a jar of them, which stay the map they're read back as, so a key composite holding one composes
 * `[object Object]` from a row and is refused at write as it was (`EDD-9128`). A cookie's key text
 * is its whole printed form, options and all.
 */
export const readingKeyInstances: <S extends Schema.Top>(schema: S) => S = readerOf(
  (kind) => kind !== "Cookie" && kind !== "Cookies",
)
