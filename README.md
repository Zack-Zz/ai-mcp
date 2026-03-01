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

## Repository Description

TypeScript MCP monorepo with MCP Server and MCP Client (SDK/CLI), providing shared protocol schemas, unified error model, and stdio/http/sse transport adapters.

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

## Architecture Constraints

- Shared protocol boundary: all external I/O is defined in `@ai-mcp/shared` and validated by `zod`.
- Transport strategy: keep business logic decoupled from transport; current adapters are `stdio`, `http`, and `sse`.
- Unified error model: normalize all failures into `{ code, message, traceId, details? }`.
- Extension points: tool/resource/prompt registration and middleware pipeline (`auth`, `rate-limit`, `audit` placeholders).

## Quality gates

CI runs:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:coverage`
- `pnpm build`

Coverage thresholds are enforced at 80% (lines/functions/branches/statements).

## Contribution and Git

- Commit style: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- PRs should include motivation, change scope, and test notes.

## Examples

- `examples/stdio-basic`
- `examples/http-sse-basic`

## License

MIT
