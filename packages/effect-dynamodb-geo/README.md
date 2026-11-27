# @effect-dynamodb/geo

Geospatial index and proximity search for [`effect-dynamodb`](https://www.npmjs.com/package/effect-dynamodb), built on Uber's [H3](https://h3geo.org) hexagonal grid.

[![npm](https://img.shields.io/npm/v/@effect-dynamodb/geo)](https://www.npmjs.com/package/@effect-dynamodb/geo)
[![license](https://img.shields.io/npm/l/@effect-dynamodb/geo)](./LICENSE)

**Documentation:** https://jmenga.github.io/effect-dynamodb/guides/geospatial

## Installation

```bash
pnpm add @effect-dynamodb/geo effect-dynamodb effect
```

`effect` (`^4.1.3`) and `effect-dynamodb` are peer dependencies. Each release of this package requires the same version of `effect-dynamodb`, so upgrade the two together.

## What it does

`GeoIndex.make({ entity, index, coordinates, fields })` binds an entity GSI to H3 cells. For any entity whose items carry a latitude and longitude (read by your `coordinates` extractor):

- **Geo-enriched writes** — `put` computes the item's H3 cell, parent cell and time partition and writes through the entity's own `put`; `enrich` computes them for a `Transaction` or `Batch` write
- **Proximity search** — `nearby` finds items within a radius of a point, inside a time window, sorted by great-circle distance

Implemented as a GSI overlay keyed by a coarse H3 parent cell and time partition, with the fine cell as the sort key, so a search queries only the cells and time partitions it covers instead of scanning the table. Entities with fields [offloaded to a blob store](https://jmenga.github.io/effect-dynamodb/guides/blob-offload) work too, on a table whose schema sets `escapeKeys: true` (`GeoIndex.bind` refuses one that doesn't, `[EDD-9146]`): `nearby` reads their values eagerly.

See the [Geospatial guide](https://jmenga.github.io/effect-dynamodb/guides/geospatial) for setup, indexing strategy, and tradeoffs.

## License

[MIT](./LICENSE)
