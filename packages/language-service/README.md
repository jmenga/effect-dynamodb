# @effect-dynamodb/language-service

TypeScript Language Service Plugin for [`effect-dynamodb`](https://www.npmjs.com/package/effect-dynamodb). Shows DynamoDB operation details — partition key, sort key, index name, conditions — directly in editor hover tooltips.

[![npm](https://img.shields.io/npm/v/@effect-dynamodb/language-service)](https://www.npmjs.com/package/@effect-dynamodb/language-service)
[![license](https://img.shields.io/npm/l/@effect-dynamodb/language-service)](./LICENSE)

**Documentation:** https://jmenga.github.io/effect-dynamodb

## Installation

```bash
pnpm add -D @effect-dynamodb/language-service
```

Then enable in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@effect-dynamodb/language-service" }]
  }
}
```

VS Code: ensure "TypeScript › Tsserver: Use Workspace TSDK" is enabled, or run **TypeScript: Select TypeScript Version → Use Workspace Version**.

## License

[MIT](./LICENSE)
