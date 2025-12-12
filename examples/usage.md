# Usage examples

## Run locally
```bash
pnpm install
pnpm dev
```

## Run with explicit config
```bash
MCP_CONFIG=path/to/custom.yaml pnpm dev
```

## Build and run compiled output
```bash
pnpm build
pnpm start
```

## Call tools via MCP CLI
Use the MCP CLI (or any client) and point it at the server process.

```bash
npx @modelcontextprotocol/cli@latest call \
  --command list_repos \
  --server "node dist/index.js"
```

`list_repos` returns the repositories defined in your config.
