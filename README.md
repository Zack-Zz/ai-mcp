# ai-mcp

English | [简体中文](./README.zh-CN.md)

TypeScript monorepo for an MCP Server and MCP Client (SDK + CLI), including `stdio`, `http`, and `sse` transport support.

## Packages

- `@ai-mcp/shared`: protocol types, zod schemas, error model
- `@ai-mcp/mcp-server`: MCP server implementation and transport adapters
- `@ai-mcp/mcp-client`: MCP client SDK and CLI

Built-in capabilities:

- Tools: `echo`, `time`
- Resource: `server-info`
- Prompt: `tool-guide`

## Quickstart

```bash
pnpm install
pnpm build
```

Run HTTP server:

```bash
pnpm --filter @ai-mcp/mcp-server dev -- --transport http --port 3000
```

Call tool via CLI:

```bash
pnpm --filter @ai-mcp/mcp-client dev -- tools call echo --transport http --endpoint http://localhost:3000/mcp --json '{"text":"hello"}'
```

## Quality gates

CI runs:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

## Examples

- `examples/stdio-basic`
- `examples/http-sse-basic`

## License

MIT
