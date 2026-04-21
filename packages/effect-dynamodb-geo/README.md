# @effect-dynamodb/geo

Geospatial index and proximity search for [`effect-dynamodb`](https://www.npmjs.com/package/effect-dynamodb), built on Uber's [H3](https://h3geo.org) hexagonal grid.

[![npm](https://img.shields.io/npm/v/@effect-dynamodb/geo)](https://www.npmjs.com/package/@effect-dynamodb/geo)
[![license](https://img.shields.io/npm/l/@effect-dynamodb/geo)](./LICENSE)

**Documentation:** https://jmenga.github.io/effect-dynamodb/guides/geospatial

## Installation

```bash
pnpm add @effect-dynamodb/geo effect-dynamodb effect
```

`effect` and `effect-dynamodb` are peer dependencies.

## What it does

Adds two operations to any entity with `lat`/`lng` coordinates:

- **Proximity search** — "find items within N kilometers of a point"
- **Bounding-box search** — "find items inside a rectangle"

Implemented as a GSI overlay using H3 cell IDs as the partition key, so reads stay O(visited cells) instead of scanning the table.

See the [Geospatial guide](https://jmenga.github.io/effect-dynamodb/guides/geospatial) for setup, indexing strategy, and tradeoffs.

## License

[MIT](./LICENSE)
