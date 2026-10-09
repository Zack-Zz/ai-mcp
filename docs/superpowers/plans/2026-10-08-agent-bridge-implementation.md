# Agent Bridge Implementation Plan

> **For agentic workers:** 按 executing-plans 分组执行并保留有效 RED/GREEN。用户已要求完整实现；普通开发由当前会话负责，只有边界稳定的独立文件组并行。此计划不授权 Git 提交、推送、安装或发布。

**Goal:** 完成 agent-bridge/v1 的独立持久任务服务、CLI/MCP/API、三执行器适配和 ai-code 消费插件，按设计逐项取得真实证据。

**Architecture:** Bridge 是独立能力模块；三入口共用应用操作，独立 runtime 拥有任务和进程。ai-code 插件只处理明确派发、交接与验收，公共发行改造由并行发布会话维护。

**Tech Stack:** TypeScript、Zod、Node 本地 IPC/文件与子进程、Vitest、官方 MCP SDK v2；插件使用 Python 标准库与原生技能资源。

## 基线与范围

- ai-mcp 基线 main@2c6a767，保留此前新设计文档。
- ai-code 的公共发布修改正在另一会话中进行；本任务不编辑其 release/distribution/Actions，最后协调实际源码中的 catalog 和统一门禁。
- 本轮完成 Bridge 新原生 MCP v2 入口；已有四包的全面 SDK v2 迁移仍是独立设计，不通过 Bridge 宣称其已迁移。
- 模块私有 CLI 与新插件源码属于本轮；用户全局配置、宿主持久安装和 Git 发布不属于本轮。

## 验收清单与执行顺序

- [x] 契约：严格 StartArgs/TaskSpec/Config、canonical engine、同引擎明示字段、范围和错误；有效 RED 后 GREEN。
- [x] 状态：单 writer 可校验事件日志、原子 snapshot、requestId 并发幂等与冲突、截断/中间损坏、启动 intent 与恢复。
- [x] 工作区：登记项目、isolated/existing、基线/新增/删除/模式/链接状态、写租约及范围检测；不复制未批准的 dirty 起点。
- [x] 适配器：probe/start/continue/interrupt，真实 argv 和 JSON 事件，精确会话、进程树退出、时间与日志预算；不覆盖模型/账号。
- [x] 应用服务：start/get/list/events/continue/cancel/artifacts/read，共用权限与绑定；未知执行不重放，业务失败查询仍成功。
- [x] IPC：独立服务、受控凭据、关闭/重启/锁、配置绑定；CLI 或 MCP 断开不取消任务。
- [x] CLI：help、JSON、stderr、退出码、保存自动 requestId、控制客户端同语义；全路径真实子进程验收。
- [x] MCP：官方 v2 factory、独立请求、schema、原生错误、同操作 DTO、多模块共存；真实 SDK/stdio/HTTP 测试。
- [x] 插件：独立 product/技能/三宿主适配/白名单/薄 client/正负触发；真实 fixture RED 与消费测试。
- [x] 集成：登记正式插件，源码验证、统一测试、三宿主构建/可信包检查；保留兄弟插件哈希。
- [ ] 真实引擎：三个执行器的独立持久新建、精确续接、修改/验证、失败与取消，记录实际版本/权限/产物。
- [ ] 宿主：自然语言与显式入口、普通开发负例零派发、同引擎独立会话；桌面可见性不在本期。
- [ ] 最终：全量 lint/typecheck/coverage/build/e2e，文档/证据更新及源码自查/限定独立审阅。

## 文件所有权

主会话拥有 packages/agent-bridge 的 contracts/application/runtime/workspaces/client/entrypoints、包清单/锁文件、公共测试配置及集成记录。适配工作者只拥有 src/adapters 与对应 adapter 测试。插件工作者只拥有 ai-code/plugins/ai-agent-delegation；主会话拥有 catalog 最终登记。公共发布文件保持其他会话所有权。

## 契约冻结

TaskSpec 的需求版本为字符串 "1"，字段 objective、acceptanceCriteria[]、constraints[]、writeScope[]、contextRefs[{path,description?}]、scopeReference、verificationIds[]。start 外层包含 engine、projectId、workspacePolicy、requestId、sameEngineIntent?、taskSpec。caller 来源于受控控制连接；不接受请求自行提升 role。get 的 TaskView 包含 taskId/engine/projectId/state、sessionId?、runs 和 deliveries；queued 时 sessionId 可为空。

Driver 通过 probe/launch 返回真实事件与 terminal promise；runtime 不以 stdout 最后一行自由文本判定成功。三个原生 CLI 先真实探测并实测，fixture 只验证错误/生命周期分支。

## 实际门禁

定向 Vitest 使用仓库 node_modules/.bin/vitest；随后 npm_config_manage_package_manager_versions=false pnpm -r lint/typecheck/build、pnpm test:coverage 及已有三条 Gateway e2e。新模块真实进程测试覆盖 CLI/IPC/MCP，插件执行 root npm test 和 trusted plugin_tool validate/build/package check。每组 RED/GREEN 与最终输出记录到交付报告，未知或未验证项保持未完成。

## 当前收尾状态

上述完成标记指源码及受限实测/fixture门禁，不推广为全部原生能力。2026-10-09
stdin 修复后为 66 files / 565 tests，覆盖率保持原80%门禁；全仓
lint/typecheck/build、Gateway3条e2e、两插件3宿主构建/可信包检查、市场一致性
已有通过证据。后续真实 Codex→Claude（glm-5.3）完成创建、隔离修改、
注册验证、回收及最终报告；Claude→Codex 的目标和准确 caller 续接收尾也完成，
后者实际 existing 工作区，不宣称原件保留。

用户已明确允许当前官方或第三方模型，限定原生调用的外层审批已获准。
ZCode 已有 GLM profile，公开CLI适配已实现；当前 standalone 不提供桌面
start-plan 的账户JWT/Bearer路径。前次API-key转换不符合原生语义，不能
据签名失败推导桌面credential无效、没有第三方模型或仍等待Claude授权。
三端全部原生与宿主矩阵仍未完成。Codex readonly 真实写入已转为明确
unsupported，不默认扩大权限。详见 [后续原生记录](../../reviews/2026-10-09-native-cross-agent-and-stdin.md)。

完整目标逐项审计见 [completion audit](../../reviews/2026-10-08-agent-bridge-completion-audit.md)，保留原设计全部验收要求与未完成状态，不按已完成的fixture范围收缩目标。

后续默认Codex app-server、停止未知隔离与observer异常修复后，全仓为
68files/610tests，行90.05%、分支85.49%、函数96.35%；lint/typecheck/build
通过。上述565项保留为stdin阶段记录。源码开发与真实宿主完整验收分开，
本次已取得review后commit/push授权，当前收口见
[开发交付记录](../../reviews/2026-10-09-agent-bridge-development-delivery.md)。
