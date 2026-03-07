# ai-mcp 平台设计文档

## 1. 文档目标

本文档用于定义 `ai-mcp` 的平台定位、架构分层、核心模块、协议抽象、治理能力、扩展机制与实施路线，用于支撑多个 AI Agent 通过 MCP（Model Context Protocol）访问统一的工具、资源、Prompt 与下游系统。

本文档重点解决以下问题：

- `ai-mcp` 在整体体系中的职责边界是什么
- 当前项目能力有哪些，距离“平台层”还缺什么
- 如何从 MCP 协议骨架演进为可治理、可扩展、可审计的工具平台
- 如何为未来的 `ai-agent` 与 `ai-agent-app-*` 提供稳定能力底座

---

## 2. 设计目标

### 2.1 核心目标

`ai-mcp` 定位为：

**面向 AI Agent 的 MCP 平台层 / 工具接入层 / 协议与治理层。**

核心目标如下：

- 统一封装 MCP Client / Server / Gateway 能力
- 统一接入 Tools / Resources / Prompts
- 为上层 Agent 提供稳定的能力平面
- 为下游 MCP Server 和内部工具提供统一接入方式
- 提供鉴权、审计、限流、策略控制、会话隔离等治理能力
- 支撑本地和远程两类 MCP 调用链路

### 2.2 非目标

`ai-mcp` 不负责以下内容：

- 不负责具体业务型 Agent 的任务规划与状态机决策
- 不负责垂类业务 Prompt 编排
- 不负责根因分析、补丁生成、发布决策
- 不直接承载复杂业务工作流

这些能力应由上层 `ai-agent` 或 `ai-agent-app-*` 实现。

---

## 3. 当前项目现状评估

基于当前公开仓库，`ai-mcp` 已具备如下基础：

- Monorepo 结构
- `@ai-mcp/shared`
- `@ai-mcp/mcp-server`
- `@ai-mcp/mcp-client`
- `@ai-mcp/gateway`
- 支持 `stdio` / `http` / `sse` 传输
- 使用 `zod` 做 schema 校验
- 有统一错误模型
- 有基本工具、资源、Prompt 注册机制
- Gateway 已有一定审计和策略基础

当前短板：

- 内置能力仍偏 demo，缺乏平台级能力目录
- 缺少面向 Agent 的统一结果模型
- 缺少 artifact / resource 的系统化建模
- 现有策略引擎仍为基础版（allowlist + rate limit），缺少条件策略与风险分级
- 已支持多下游工具聚合与 `backend__tool` 命名空间，但缺少 Resource/Prompt 聚合治理
- 缺少执行态对象体系化建模（Task / Run / Step / Artifact / AuditEvent）

因此，当前 `ai-mcp` 更接近：

**一个 MCP 协议框架骨架，而非完整平台。**

### 3.1 已实现能力与平台级缺口边界

为避免“能力全缺失”或“能力已完整”的误判，建议明确边界：

- 已实现（MVP 基础）：
  - `tools/list` / `tools/call` 主链路
  - stdio / HTTP 下游接入
  - 网关工具聚合与命名空间映射（`backend__tool`）
  - 基础策略（allowlist + rate limit）
  - 基础审计（内存/JSONL）
- 未完成（平台化能力）：
  - 统一结果模型（含 artifact/run/task 语义）
  - 风险分级与条件策略
  - capability registry（版本、权限、可见性）
  - runtime metadata 贯通
  - Resource/Prompt 聚合与治理

---

## 4. 总体定位与职责边界

### 4.1 在整体体系中的位置

推荐整体分层如下：

```text
ai-agent-app-*   -> 垂类业务 Agent
ai-agent         -> 通用 Agent Runtime / Framework
ai-mcp           -> 工具协议、接入、治理、网关平台
Downstream MCPs  -> Playwright MCP / GitHub MCP / Logs MCP / Pipeline MCP / 内部工具
```

### 4.2 `ai-mcp` 的职责

`ai-mcp` 负责：

- MCP 标准协议实现与适配
- Tools / Resources / Prompts 的统一暴露
- 下游 MCP 服务或内部工具的接入与路由
- 统一错误模型与结果内容模型
- 工具注册、能力目录、命名空间
- 策略控制、权限模型、审计、限流
- 会话、运行上下文、trace 贯通
- artifact、资源 URI 与内容管理

### 4.3 `ai-mcp` 不负责的职责

不负责：

- Planner / Executor / Evaluator 逻辑
- Agent 自主决策
- 业务成功/失败判定
- 垂类 Prompt 策略
- 长流程状态机

---

## 5. 设计原则

### 5.1 平台与场景分离

`ai-mcp` 只做平台，不做业务 Agent。

### 5.2 协议标准优先

优先遵循 MCP 官方协议与内容模型，避免自造不兼容协议。

### 5.3 结果结构化优先

工具输出必须兼顾：

- 机器可读
- 模型可消费
- 用户可审计

### 5.4 高风险能力默认受控

涉及代码变更、环境发布、生产日志访问等高风险工具，必须受策略、审批与审计控制。

### 5.5 下游可替换

Playwright MCP、GitHub MCP、自研 MCP 等都应该可替换，避免上层 Agent 感知实现差异。

---

## 6. 总体架构设计

### 6.1 架构概览

```text
Upstream Agent / Host
        |
        v
+-----------------------+
|      ai-mcp Gateway   |
| auth / policy / audit |
| routing / aggregation |
+-----------------------+
   |         |         |
   v         v         v
Browser   Repo      Logs/Pipeline
Connector Connector Connector
   |         |         |
   v         v         v
Playwright GitHub    Internal MCPs
MCP        MCP       / Services
```

### 6.2 核心分层

1. **Protocol Layer**
   - MCP Server / Client
   - Transport adapters
   - JSON-RPC message handling

2. **Capability Layer**
   - Tools
   - Resources
   - Prompts
   - Capability registry

3. **Governance Layer**
   - Auth
   - Policy
   - Audit
   - Rate limit
   - Approval hooks

4. **Connector Layer**
   - Downstream MCP connectors
   - Internal service adapters

5. **Runtime Metadata Layer**
   - Run context
   - Trace metadata
   - Artifact model
   - Session propagation

---

## 7. 推荐包结构

```text
packages/
  shared/
  mcp-client/
  mcp-server/
  gateway/
  capability-registry/
  policy-engine/
  audit-model/
  artifacts/
  runtime-types/
  connectors-playwright/
  connectors-github/
  connectors-logs/
  connectors-pipeline/
```

### 7.1 `shared`

职责：

- 通用类型
- zod schema
- 错误模型
- MCP 相关公共常量
- 公共内容模型

### 7.2 `mcp-client`

职责：

- 基于官方 SDK 的 client 封装
- 统一 downstream session 创建
- request/response/notification 处理
- transport 抽象

### 7.3 `mcp-server`

职责：

- MCP Server 基础封装
- Tools / Resources / Prompts 注册能力
- 标准结果输出适配

### 7.4 `gateway`

职责：

- 对上游提供统一 MCP 能力入口
- 对下游做路由与聚合
- 策略控制、限流、审计
- 下游能力可见性控制

### 7.5 `capability-registry`

职责：

- 注册工具、资源、Prompt 元数据
- 能力目录与命名空间
- 版本和标签管理
- 风险等级与权限要求

### 7.6 `policy-engine`

职责：

- 工具调用鉴权
- 环境级限制
- 用户级权限
- 风险动作审批钩子
- deny / allow / conditional allow 策略

### 7.7 `audit-model`

职责：

- 审计事件 schema
- 调用链、traceId、taskId 关联
- 审计持久化模型

### 7.8 `artifacts`

职责：

- 截图、视频、trace、HAR、日志片段、patch、报告的统一引用模型
- Resource URI 管理
- Artifact metadata

### 7.9 `runtime-types`

职责：

- Task / Run / Step / Session / Approval / PolicyDecision 等通用运行态对象

### 7.10 `connectors-*`

职责：

- 连接官方或自研下游 MCP / 服务
- 屏蔽具体实现差异
- 转换为平台统一的结果模型

---

## 8. 能力模型设计

### 8.1 Tool Model

每个 Tool 应具备：

- `name`
- `namespace`
- `description`
- `inputSchema`
- `outputSchema`
- `riskLevel`
- `requiredPermissions`
- `tags`
- `version`
- `visibility`

### 8.2 Resource Model

每个 Resource 应具备：

- `uri`
- `mimeType`
- `name`
- `source`
- `owner`
- `createdAt`
- `retentionPolicy`
- `accessPolicy`

### 8.3 Prompt Model

每个 Prompt 应具备：

- `name`
- `description`
- `arguments`
- `outputIntent`
- `riskTag`
- `audience`

---

## 9. 统一结果模型设计

推荐统一工具结果结构：

```ts
interface StandardToolResult<T = unknown> {
  ok: boolean;
  code: string;
  message: string;
  structuredContent?: T;
  content?: Array<unknown>;
  artifacts?: ArtifactRef[];
  traceId?: string;
  runId?: string;
  taskId?: string;
  details?: Record<string, unknown>;
}
```

### 9.1 设计要求

- `structuredContent` 给机器和上层 Agent 使用
- `content[]` 兼容 MCP 内容模型
- `artifacts[]` 用于挂接截图、日志、trace 等证据
- `traceId / runId / taskId` 用于调用链追踪

### 9.2 典型示例

浏览器失败结果可包含：

- 文本失败摘要
- 页面截图
- 失败接口摘要
- trace 文件链接
- DOM 快照资源链接

---

## 10. 治理能力设计

### 10.1 鉴权模型

鉴权维度建议包括：

- 用户身份
- 组织 / 租户
- 运行环境（dev/test/staging/prod）
- 工具风险等级
- Agent 身份

### 10.2 策略控制

策略引擎需支持：

- Allow
- Deny
- Conditional Allow
- Approval Required
- Environment Restricted

### 10.3 限流与配额

需支持：

- 用户级限流
- Agent 级限流
- 工具级限流
- 下游连接池保护

### 10.4 审计模型

每次工具调用至少记录：

- Who
- When
- Which agent
- Which tool
- Input hash
- Output summary
- Policy decision
- Trace metadata
- Duration
- Downstream target

---

## 11. 下游连接器设计

### 11.1 目标

让 `ai-mcp` 可以统一接入：

- 官方 MCP Server
- 自研 MCP Server
- 非 MCP 内部服务

### 11.2 连接器抽象

```ts
interface DownstreamConnector {
  id: string;
  kind: 'mcp' | 'service';
  capabilities(): Promise<CapabilityDescriptor[]>;
  invoke(input: ConnectorInvokeRequest): Promise<StandardToolResult>;
}
```

### 11.3 典型连接器

- `playwright connector`
- `github connector`
- `logs connector`
- `pipeline connector`

---

## 12. Browser / Repo / Logs / Pipeline 接入建议

### 12.1 Browser

短期：接官方 Playwright MCP
长期：增加 `browser-tools` 适配层，将通用浏览器动作封装成高阶业务工具。

### 12.2 Repo

优先接 GitHub MCP，同时为未来本地 Git workspace 预留适配层。

### 12.3 Logs

建议自研 `logs-tools`，统一 K8s、日志检索、traceId 检索、错误窗口聚合。

### 12.4 Pipeline

建议自研 `pipeline-tools`，统一 CI/CD、部署、rollout、rollback 能力。

---

## 13. 运行态对象设计

建议在平台层定义以下对象：

- `TaskRef`
- `RunContext`
- `StepContext`
- `ArtifactRef`
- `PolicyDecision`
- `ApprovalState`
- `AuditEvent`

这样做的价值是为上层 `ai-agent` 提供稳定的运行上下文语义。

---

## 14. 部署模型建议

### 14.1 本地模式

适合开发调试：

- agent 本地
- ai-mcp 本地
- 下游 Playwright / GitHub / 自研工具本地或测试环境

### 14.2 远程模式

适合团队化部署：

- ai-mcp gateway 远程部署
- 下游 connectors 以容器或服务形式部署
- 高风险工具默认受审计与策略约束

### 14.3 混合模式

最推荐：

- Agent 本地
- ai-mcp gateway 远程
- 浏览器 worker 可本地或独立容器
- logs/repo/pipeline 工具更多走远程

---

## 15. 演进路线

### Phase A：平台内核可用（优先）

- 统一结果模型（`StandardToolResult` + artifacts + trace/run/task）
- Audit v2（who/agent/downstream/duration/outputSummary）
- 轻量 capability registry（risk/permissions/tags/version/visibility）

### Phase B：平台化增强

- Policy v2（conditional allow + 风险等级策略）
- runtime types（RunContext/StepContext/ArtifactRef/PolicyDecision）贯通
- connector 抽象增强（标准结果封装与错误分类）

### Phase C：企业级治理（可后置）

- 复杂鉴权（OAuth / 细粒度 ABAC）
- 审批流与高风险动作管控
- Resource/Prompt 聚合暴露
- 多租户强隔离与连接器市场能力

---

## 16. 风险与注意事项

### 16.1 平台过度业务化

要避免把 Agent 逻辑塞回 `ai-mcp`。

### 16.2 工具粒度失控

过细会导致 Agent 高 token 成本和高决策复杂度；过粗会导致复用性差。

### 16.3 治理能力后置

如果先做工具、后补治理，后面风险会非常高。

### 16.4 资源模型缺失

没有 artifact / resource 统一建模，会导致证据链无法复用。

---

## 17. 最终建议

`ai-mcp` 应明确升级为：

**一个具备协议实现、能力接入、治理控制、统一结果模型和多下游聚合能力的 MCP 平台。**

短期重点不是继续扩 transport，而是补齐：

- capability registry
- policy engine
- audit model
- artifact/resource model
- downstream connector abstraction
- runtime metadata model

这样它才能真正成为上层 `ai-agent` 的稳定底座。
