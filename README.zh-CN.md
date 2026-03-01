# ai-mcp

[English](./README.md) | 简体中文

一个基于 TypeScript 的 MCP Monorepo，包含 MCP Server 与 MCP Client（SDK + CLI），支持 `stdio`、`http`、`sse` 三种传输方式。

## 包结构

- `@ai-mcp/shared`: 协议类型、zod schema、统一错误模型
- `@ai-mcp/mcp-server`: MCP Server 实现与传输适配器
- `@ai-mcp/mcp-client`: MCP Client SDK 与 CLI

内置能力：

- Tools: `echo`、`time`
- Resource: `server-info`
- Prompt: `tool-guide`

## 仓库描述（可用于 Git 平台简介）

TypeScript MCP Monorepo，包含 MCP Server 与 MCP Client（SDK/CLI），提供共享协议 schema、统一错误模型，以及 `stdio/http/sse` 传输适配能力。

## 快速开始

```bash
pnpm install
pnpm build
```

启动 HTTP Server：

```bash
pnpm --filter @ai-mcp/mcp-server dev -- --transport http --port 3000
```

通过 CLI 调用 Tool：

```bash
pnpm --filter @ai-mcp/mcp-client dev -- tools call echo --transport http --endpoint http://localhost:3000/mcp --json '{"text":"hello"}'
```

## 架构约束

- 协议边界：所有外部输入输出统一放在 `@ai-mcp/shared`，并使用 `zod` 做运行时校验。
- 传输策略：传输层与业务逻辑解耦，当前支持 `stdio`、`http`、`sse`。
- 错误模型：统一标准化为 `{ code, message, traceId, details? }`。
- 扩展机制：支持 Tool/Resource/Prompt 注册和中间件链（鉴权、限流、审计占位）。

## 质量门禁

CI 执行以下检查：

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:coverage`
- `pnpm build`

覆盖率门槛为 80%（lines/functions/branches/statements）。

## 提交与协作

- 提交规范：Conventional Commits（`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`）。
- PR 建议包含：变更动机、影响范围、测试说明。

## 示例

- `examples/stdio-basic`
- `examples/http-sse-basic`

## License

MIT
