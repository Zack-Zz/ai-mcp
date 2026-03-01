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

## 质量门禁

CI 执行以下检查：

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:coverage`
- `pnpm build`

## 示例

- `examples/stdio-basic`
- `examples/http-sse-basic`

## 相关文档

- Git 仓库描述建议：[docs/git-description.zh-CN.md](./docs/git-description.zh-CN.md)
- 项目设计讨论：[docs/project-design-discussion.md](./docs/project-design-discussion.md)

## License

MIT
