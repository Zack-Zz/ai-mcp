# ai-mcp 项目设计讨论文档

- 项目仓库: https://github.com/Zack-Zz/ai-mcp
- 文档目的: 在项目正式开发前，统一技术选型、架构边界、代码规范与开源治理约束，作为后续实现基线。
- 讨论日期: 2026-02-28

## 1. 项目目标

构建一个标准开源 MCP 项目，包含:

- MCP Server: 对外提供工具能力（Tool/Resource/Prompt）
- MCP Client: 负责连接、调用、协议适配与示例集成

核心目标:

- 可维护: 统一语言和工程体系，降低协作与维护成本
- 可扩展: 支持后续新增工具、传输方式、鉴权与可观测能力
- 可开源协作: 具备标准开源项目结构与治理文件

## 2. 技术选型结论

### 2.1 开发语言

首选 `TypeScript (Node.js 20+)`。

选择原因:

- MCP 与 AI 工具链生态匹配度高
- Server 与 Client 同语言可复用类型与工具
- 开源协作门槛较低，社区贡献更容易

### 2.2 工程与工具链

- Monorepo: `pnpm workspace`
- 构建: `tsup`
- 本地开发: `tsx`
- 测试: `vitest`
- 代码规范: `eslint + @typescript-eslint + prettier`
- 提交流程: `husky + lint-staged + commitlint`
- 版本发布: `changesets`

## 3. 推荐目录结构

```text
ai-mcp/
  packages/
    mcp-server/       # MCP Server 实现
    mcp-client/       # MCP Client SDK/CLI
    shared/           # 协议类型、通用工具
  examples/           # 最小可运行示例
  docs/               # 架构与使用文档
  .github/workflows/  # CI/CD
```

说明:

- `shared` 用于复用类型定义和基础工具，避免 server/client 重复实现。
- `examples` 用于提供开箱即用的最小运行路径，降低上手成本。

## 4. 架构设计约束

### 4.1 协议边界

- 明确 Server 暴露的 Tool/Resource/Prompt 清单
- 所有输入输出使用 `zod` 做 runtime 校验
- 统一协议类型定义放在 `packages/shared`

### 4.2 传输层策略

- 第一阶段优先 `stdio`
- 设计时预留 `http/sse` 扩展接口
- 传输层与业务逻辑解耦，避免后续迁移成本

### 4.3 错误模型

- 定义统一错误码（如参数错误、鉴权失败、内部错误、依赖超时）
- 错误响应包含最小可观测字段（code/message/traceId）
- 日志字段标准化，便于后续接入日志平台

### 4.4 扩展机制

- Tool 注册机制（集中注册 + 自动发现可二期评估）
- 中间件机制（鉴权、限流、审计、指标）
- 面向接口编程，避免具体实现耦合到核心流程

## 5. 代码规范与质量门禁

### 5.1 TypeScript 约束

- `tsconfig` 启用 `strict: true`
- 禁止随意使用 `any`，优先 `unknown` + 类型收窄
- 对外导出 API 必须有明确类型

### 5.2 校验与错误处理

- 所有外部输入必须进行 runtime 校验（`zod`）
- 不吞异常，必须转换为统一错误模型
- 保留必要上下文，避免定位信息丢失

### 5.3 测试策略

- 单元测试覆盖协议转换、核心逻辑、错误路径
- 关键路径设置覆盖率门槛（建议 80%）
- 后续补充 server-client 端到端联调测试

### 5.4 CI 门禁

CI 必须包含且通过:

- lint
- typecheck
- test
- build

## 6. Git 与提交规范

- 分支命名: `feat/*`、`fix/*`、`chore/*`
- 提交规范: `Conventional Commits`
  - `feat: ...`
  - `fix: ...`
  - `docs: ...`
  - `refactor: ...`
  - `test: ...`
  - `chore: ...`
- PR 要求:
  - 描述变更动机与影响范围
  - 关联 issue（如有）
  - 附最小测试说明

## 7. 开源治理标准清单

项目初始化阶段应包含:

- `LICENSE`（推荐 MIT 或 Apache-2.0）
- `README.md`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `CHANGELOG.md`
- Issue/PR 模板
- `CODEOWNERS`

## 8. 版本与发布策略

- 版本规范: `SemVer`
- 使用 `changesets` 管理版本与变更日志
- 发布前要求 CI 全绿
- 发布内容包含:
  - 功能变更
  - 破坏性变更说明
  - 升级指引（如有）

## 9. 里程碑计划（建议）

### M1: 工程骨架

- 初始化 Monorepo
- 建立 server/client/shared 三包结构
- 接入 lint/test/typecheck/build 基础能力

### M2: 最小可用链路

- 提供 1-2 个基础 Tool
- 完成 client 到 server 的最小调用闭环
- 提供可运行示例与文档

### M3: 工程增强

- 接入统一错误模型与日志规范
- 增加中间件机制（鉴权/限流占位实现）
- 完善测试与 CI 门禁

### M4: 开源发布准备

- 完成治理文件与模板
- 完成首版 CHANGELOG 与发布流程
- 对外发布 v0.x 版本

## 10. 待确认事项

- License 最终选择: `MIT` 或 `Apache-2.0`
- MCP Client 的交付形态优先级: SDK、CLI、或两者同时
- 第一批 Tool 的业务范围与优先级
- 是否在 M2 阶段即引入 `http/sse` 传输支持

---

该文档作为当前讨论结论，后续如方案调整，建议通过 PR 方式更新并记录变更原因。
