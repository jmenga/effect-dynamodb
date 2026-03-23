import type { ResolvedCollection, ResolvedEntity } from "./EntityResolver.js"

interface CacheEntry {
  readonly version: number
  readonly entities: ReadonlyArray<ResolvedEntity>
  readonly collections: ReadonlyArray<ResolvedCollection>
}

const cache = new Map<string, CacheEntry>()

export const getEntities = (
  fileName: string,
  version: number,
): ReadonlyArray<ResolvedEntity> | undefined => {
  const entry = cache.get(fileName)
  if (entry && entry.version === version) {
    return entry.entities
  }
  return undefined
}

export const getCollections = (
  fileName: string,
  version: number,
): ReadonlyArray<ResolvedCollection> | undefined => {
  const entry = cache.get(fileName)
  if (entry && entry.version === version) {
    return entry.collections
  }
  return undefined
}

export const setEntities = (
  fileName: string,
  version: number,
  entities: ReadonlyArray<ResolvedEntity>,
  collections: ReadonlyArray<ResolvedCollection> = [],
): void => {
  cache.set(fileName, { version, entities, collections })
}

export const invalidate = (fileName: string): void => {
  cache.delete(fileName)
}

export const clear = (): void => {
  cache.clear()
}
