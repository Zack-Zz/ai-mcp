# ai-mcp

[English](./README.md) | 简体中文

一个基于 TypeScript 的 MCP Monorepo，包含 MCP Server 与 MCP Client（SDK + CLI），支持 `stdio`、`http`、`sse` 三种传输方式。

## 包结构

- `@ai-mcp/shared`: 协议类型、zod schema、统一错误模型
- `@ai-mcp/mcp-server`: MCP Server 实现与传输适配器
- `@ai-mcp/mcp-client`: MCP Client SDK 与 CLI
- `@ai-mcp/gateway`: MCP Gateway（基于官方 SDK 构建）

内置能力（另支持任意业务工具，见下）：

- Tools: `echo`、`time`
- Resource: `server-info`
- Prompt: `tool-guide`

## 通用工具注册

任意合法业务名（`a-z A-Z 0-9 _ - .`，1-128 字符）都可用自己的 zod 输入/输出 schema 注册，handler 获得经解析的类型化入参，返回值先通过输出校验再上链：

```ts
import { createServer, defineTool } from '@ai-mcp/mcp-server';
import { z } from 'zod';

const server = createServer({ includeBuiltInTools: false });
server.registerTool(
  defineTool({
    name: 'catalog.lookup',
    description: '查询目录商品',
    inputSchema: z.strictObject({ sku: z.string().min(3) }),
    outputSchema: z.strictObject({ sku: z.string() }),
    handler: async (input) => ({ sku: input.sku })
  })
);
```

- 原生 MCP 调用与 legacy `handleRawRequest` 复用同一 dispatcher；非法输入不会执行 handler。
- 服务开始接入后注册关闭（本阶段不做热插拔）。
- Client 提供 `discoverTools()`（全分页完整 descriptor）、`callToolResult(name, args)`（错误优先的原生结果）与 `callValidatedTool(name, args, outputSchema)`；CLI `tools list --full` 输出完整 descriptor。
- 错误保留旧字符串 code（`INVALID_PARAMS` 等），原生路径额外携带机器可读的 `category`/`projectCode`/`traceId`。

## 仓库描述

TypeScript MCP Monorepo，包含 MCP Server 与 MCP Client（SDK/CLI），提供共享协议 schema、统一错误模型，以及 `stdio/http/sse` 传输适配能力。

## 快速开始

```bash
pnpm install
pnpm build
```

启动 HTTP Server：

```bash
pnpm --filter @ai-mcp/mcp-server dev --transport http --port 3000
```

通过 CLI 调用 Tool：

```bash
pnpm --filter @ai-mcp/mcp-client dev tools call echo --transport http --endpoint http://localhost:3000/mcp --json '{"text":"hello"}'
```

## 架构约束

- 协议边界：原生 MCP 消息使用官方 SDK；`@ai-mcp/shared` 保存项目结果/上下文/错误契约、JSON Schema 编译（默认 2020-12，显式 draft-07）与旧版内存 RPC 契约，不依赖 SDK 运行时类型。
- 传输策略：传输层与业务逻辑解耦，支持 `stdio`、`http`、`sse`。每个 stateful 会话与每个 stateless 请求独占一对 SDK server/transport；registry、策略、审计与下游连接由服务持有。`McpServer.close()` / `McpGatewayServer.close()` 幂等关闭全部会话、半初始化连接与监听器。默认行为：Server HTTP stateless（`--sessionMode stateful` 可选开启），Gateway HTTP stateful（`httpSession.sessionMode: 'stateless'` 可选关闭）。
- 项目错误模型：`{ code, message, traceId, details? }`；原生 MCP 区分数字码 JSON-RPC 错误（`-32010/-32020/-32030/-32040`、`-32602/-32603` 附 `data.category`）与工具失败（`isError` 结果）。原生 `isError` 优先于 `structuredContent`；标准 `ok:false` 下游结果上行工具失败，业务 payload 中的 `ok:false` 保持为成功数据。
- Gateway 结果契约：下游工具通过 descriptor `_meta['org.ai-mcp/result-contract']`、backend `resultContract` 或按工具 `resultContracts.toolOverrides` 声明 `native-json/v1`（payload 包装进 `StandardToolResult` 外壳）或 `standard/v1`（外壳透传，不二次包装）。公开 `outputSchema` 始终描述实际包装结果并可独立校验；未知 schema 且未声明契约会在启动时报 `RESULT_CONTRACT_AMBIGUOUS`。
- Gateway 对上游始终声明 `standard/v1`；生效的下游契约及原始 descriptor（含 schema 和 metadata）保存在 `_meta['org.ai-mcp/downstream-tool']`，多层 Gateway 保持单一返回外壳。优先级：tool override → 显式 backend 设置（包括 `legacy-auto`）→ descriptor 声明 → 兼容回退。显式 `legacy-auto` 遇到未知 outputSchema 仍需明确选择 native/standard，避免猜测 schema 语义。
- 映射后的 `backend__tool` 必须满足共享的 1–128 字符规则；非法 backend ID 或超长映射名在发布目录前报错。公开 schema 会规范化方言和资源标识，保持校验语义，来源原文另行保存。
- `standard/v1` 下游的 `outputSchema` 必须描述整个标准外壳，成功结果按完整 schema 校验；闭合外壳保留正文，通过结果 `_meta['org.ai-mcp/context']` 传递关联身份。只传 `runId`/`taskId` 时自动生成 trace。
- 调用预算覆盖连接等待、发现和执行；原生 `isError` 与声明为 standard 的 `ok:false` 均表示失败，纯媒体结果保留原生内容块。关闭会取消活动调用、在 grace 期限内回收未完成 HTTP body 的连接，并 flush 服务拥有的审计存储。注册/发现时拒绝 `$async` JSON Schema。
- 单次调用上下文（`traceId`/`runId`/`taskId`）经请求 `_meta['org.ai-mcp/context']` 传递，不混入工具 arguments，并连同 `invocationId`、outcome 与下游 trace 关联写入 JSONL 审计。

[MCP 底座设计](./docs/superpowers/specs/2026-10-01-mcp-foundation-design.md)、[实施路线](./docs/superpowers/plans/2026-10-01-mcp-foundation-implementation-plan.md)、[架构设计](./docs/superpowers/specs/2026-10-01-mcp-foundation-architecture.md) 与 [详细改造设计](./docs/superpowers/specs/2026-10-01-mcp-foundation-refactoring-detail.md) 记录本轮已实现的 P0 范围。SDK v2 / 2026-07-28 迁移（P1）为后续独立阶段，本仓库尚未启用。

## 质量门禁

CI 执行以下检查：

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:coverage`
- `pnpm build`

覆盖率门槛为 80%（lines/functions/branches/statements）。

Gateway 回归检查：

- `pnpm test:e2e:gateway`（stdio 基线）
- `pnpm test:e2e:gateway:http`（HTTP 路径 + 策略拒绝 + 审计落盘）
- `pnpm test:e2e:gateway:matrix`（协议矩阵：`2025-11-25/2025-03-26/2024-11-05`）

## 提交与协作

- 提交规范：Conventional Commits（`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`）。
- PR 建议包含：变更动机、影响范围、测试说明。

## 示例

- `examples/stdio-basic`
- `examples/http-sse-basic`
- `examples/gateway-basic`

## Gateway 运行参数覆盖

`packages/gateway/src/cli.ts` 支持配置文件 + 命令行覆盖：

- `--tenantId <string>`
- `--allowLegacyHttpSse <true|false>`
- `--auditFilePath <path>`
- `--auditHashSecret <secret>`

当前仅支持配置文件（无 CLI 覆盖参数）的字段：

- `who`、`agent`、`runContext.runId`
- `policy.riskPolicy`、`policy.conditionalAllow`
- `capabilities.defaultRiskLevel`、`capabilities.toolOverrides`
- `resultContracts.toolOverrides`、backend 级 `resultContract`
- `httpSession.sessionMode` / `sessionIdleTimeoutMs` / `maxSessions`（CLI 亦支持 `--sessionMode stateful|stateless`）

MCP Server CLI 另支持 `--sessionMode stateful|stateless`（默认 `stateless`）。两个 CLI 均处理 SIGINT/SIGTERM：停止新请求、关闭会话与下游并释放端口。

运维手册：`docs/gateway-operations.md`

## License

MIT
