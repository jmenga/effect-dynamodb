import type { ResolvedEntity } from "./EntityResolver.js"

interface CacheEntry {
  readonly version: number
  readonly entities: ReadonlyArray<ResolvedEntity>
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

export const setEntities = (
  fileName: string,
  version: number,
  entities: ReadonlyArray<ResolvedEntity>,
): void => {
  cache.set(fileName, { version, entities })
}

export const invalidate = (fileName: string): void => {
  cache.delete(fileName)
}

export const clear = (): void => {
  cache.clear()
}
