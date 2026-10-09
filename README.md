# ai-mcp

English | [简体中文](./README.zh-CN.md)

TypeScript monorepo for an MCP Server and MCP Client (SDK + CLI), including `stdio`, `http`, and `sse` transport support.

## Packages

- `@ai-mcp/shared`: protocol types, zod schemas, error model
- `@ai-mcp/mcp-server`: MCP server implementation and transport adapters
- `@ai-mcp/mcp-client`: MCP client SDK and CLI
- `@ai-mcp/gateway`: MCP gateway (SDK-based upstream + downstream connectors)
- [`@ai-mcp/agent-bridge`](./packages/agent-bridge/README.md): explicit persistent native-agent tasks through one CLI, MCP and control API; candidate `0.1.0`

Agent Bridge is an independent capability module. Ordinary development and native
subagents keep their existing behavior; cross-tool or independent-session dispatch
requires an explicit user request. See the [architecture](./docs/architecture.md)
and [development record](./docs/reviews/2026-10-09-agent-bridge-development-delivery.md).

Built-in capabilities (plus arbitrary business tools, see below):

- Tools: `echo`, `time`
- Resource: `server-info`
- Prompt: `tool-guide`

## Generic Tools

Any legal business tool name (`a-z A-Z 0-9 _ - .`, 1-128 chars) can be registered with its own zod input/output schemas; the handler receives schema-parsed types and outputs are validated before they are returned:

```ts
import { createServer, defineTool } from '@ai-mcp/mcp-server';
import { z } from 'zod';

const server = createServer({ includeBuiltInTools: false });
server.registerTool(
  defineTool({
    name: 'catalog.lookup',
    description: 'Look up catalog items',
    inputSchema: z.strictObject({ sku: z.string().min(3) }),
    outputSchema: z.strictObject({ sku: z.string() }),
    handler: async (input) => ({ sku: input.sku })
  })
);
```

- Native MCP calls and the legacy `handleRawRequest` share the same dispatcher; invalid input never executes the handler.
- Registration closes once the server starts serving (no hot reload in this phase).
- The client exposes `discoverTools()` (full descriptors, all pages), `callToolResult(name, args)` (native results, error-first) and `callValidatedTool(name, args, outputSchema)`; `tools list --full` prints complete descriptors.
- Errors keep the legacy string codes (`INVALID_PARAMS`, ...) plus machine-readable categories (`category`, `projectCode`, `traceId`) on native paths.

## Repository Description

TypeScript MCP monorepo with MCP Server and MCP Client (SDK/CLI), providing shared protocol schemas, unified error model, and stdio/http/sse transport adapters.

## Quickstart

```bash
pnpm install
pnpm build
```

Run HTTP server:

```bash
pnpm --filter @ai-mcp/mcp-server dev --transport http --port 3000
```

Call tool via CLI:

```bash
pnpm --filter @ai-mcp/mcp-client dev tools call echo --transport http --endpoint http://localhost:3000/mcp --json '{"text":"hello"}'
```

## Architecture Constraints

- Protocol boundary: native MCP messages use the official SDK. `@ai-mcp/shared` holds project result/context/error contracts, JSON Schema compilation (2020-12 default, draft-07 explicit), and the legacy in-memory RPC contracts; it does not depend on SDK runtime types.
- Transport strategy: business logic decoupled from transport; adapters are `stdio`, `http` and `sse`. Each stateful HTTP session and each stateless request owns a dedicated SDK server/transport pair; registry, policy, audit and downstream connectors are service-owned. `McpServer.close()`/`McpGatewayServer.close()` close all sessions, pending initializations and listeners idempotently. Defaults: server HTTP stateless (`--sessionMode stateful` to opt in), gateway HTTP stateful (`httpSession.sessionMode: 'stateless'` to opt out).
- Project error model: `{ code, message, traceId, details? }`; native MCP distinguishes numeric JSON-RPC errors (`-32010/-32020/-32030/-32040`, `-32602/-32603` with `data.category`) from tool failures (`isError` results). Native `isError` always wins over `structuredContent`; standard `ok:false` downstream results surface as tool failures, while business payloads containing `ok:false` stay successful data.
- Gateway result contract: downstream tools declare `native-json/v1` (payload wrapped into the `StandardToolResult` envelope) or `standard/v1` (envelope passed through, not re-wrapped) via descriptor `_meta['org.ai-mcp/result-contract']`, backend `resultContract`, or per-tool `resultContracts.toolOverrides`. The advertised `outputSchema` always describes the actual wrapped result and can be validated independently; unknown schemas without a contract fail startup with `RESULT_CONTRACT_AMBIGUOUS`.
- Gateway always advertises `standard/v1` to its upstream. The effective downstream contract and original descriptor (including schemas and metadata) remain in `_meta['org.ai-mcp/downstream-tool']`; nested gateways preserve one result envelope. Precedence is tool override → explicit backend setting (including `legacy-auto`) → descriptor declaration → compatibility fallback. An explicit `legacy-auto` with an unknown output schema still requires a native/standard declaration; it does not guess schema intent.
- Mapped `backend__tool` names must satisfy the shared 1–128 character rule. Invalid backend IDs or oversized mapped names fail catalog initialization before a directory is published. JSON Schema resource IDs and dialect spellings are normalized in the public view, preserving validation semantics and the original source descriptor.
- Per-call context (`traceId`/`runId`/`taskId`) travels in request `_meta['org.ai-mcp/context']`, never inside tool arguments, and lands in JSONL audit events together with `invocationId`, outcome and the downstream trace link.
- For `standard/v1`, downstream `outputSchema` describes the entire envelope. Successful results are validated against that schema; closed envelopes keep their body unchanged and receive correlation in result `_meta['org.ai-mcp/context']`. Passing only `runId`/`taskId` generates a trace automatically.
- Call budgets include connection waits, discovery and execution. Native `isError` and declared standard `ok:false` remain failures; media-only results keep their content blocks. Shutdown cancels active calls, releases incomplete HTTP bodies within the grace period and flushes service-owned audit stores. `$async` JSON schemas are rejected at registration/discovery.

The [MCP foundation design](./docs/superpowers/specs/2026-10-01-mcp-foundation-design.md), [implementation plan](./docs/superpowers/plans/2026-10-01-mcp-foundation-implementation-plan.md), [architecture design](./docs/superpowers/specs/2026-10-01-mcp-foundation-architecture.md) and [detailed refactoring design](./docs/superpowers/specs/2026-10-01-mcp-foundation-refactoring-detail.md) document the P0 scope implemented here. The four foundation packages still use SDK v1; their SDK v2 / 2026-07-28 migration (P1) is separate. Agent Bridge already has an independent SDK v2 MCP entrypoint and does not claim compatibility with the existing v1 Gateway or every native host client.

## Quality gates

CI runs:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:coverage`
- `pnpm build`

Coverage thresholds are enforced at 80% (lines/functions/branches/statements).

Gateway regression checks:

- `pnpm test:e2e:gateway` (stdio baseline)
- `pnpm test:e2e:gateway:http` (HTTP path + policy deny + audit persistence)
- `pnpm test:e2e:gateway:matrix` (protocol matrix: `2025-11-25/2025-03-26/2024-11-05`)

## Contribution and Git

- Commit style: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- PRs should include motivation, change scope, and test notes.

## Examples

- `examples/stdio-basic`
- `examples/http-sse-basic`
- `examples/gateway-basic`

## Gateway Runtime Flags

`packages/gateway/src/cli.ts` supports config-file values plus CLI overrides:

- `--tenantId <string>`
- `--allowLegacyHttpSse <true|false>`
- `--auditFilePath <path>`
- `--auditHashSecret <secret>`

Config-file-only fields (no CLI override flags) currently include:

- `who`, `agent`, `runContext.runId`
- `policy.riskPolicy`, `policy.conditionalAllow`
- `capabilities.defaultRiskLevel`, `capabilities.toolOverrides`
- `resultContracts.toolOverrides`, per-backend `resultContract`
- `httpSession.sessionMode` / `sessionIdleTimeoutMs` / `maxSessions` (also `--sessionMode stateful|stateless` on the CLI)

MCP server CLI additionally accepts `--sessionMode stateful|stateless` (default `stateless`). Both CLIs handle SIGINT/SIGTERM by stopping admission, closing sessions/backends and releasing the port.

Operations runbook: `docs/gateway-operations.md`

## License

MIT
