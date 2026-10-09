# ai-mcp 文档导航

更新：2026-10-09（Asia/Shanghai）。设计状态与实际实现证据分别阅读。

## 总体架构与模块

- [总体架构与多模块边界](architecture.md)：公共底座、独立 MCP 能力模块、CLI/API 与 ai-code 分工。
- [Agent Bridge 模块设计](modules/agent-bridge.md)：统一适配、任务服务、CLI/MCP/API、会话和验收要求。
- [Bridge 使用入口](../packages/agent-bridge/README.md)、[本轮实现与验证记录](reviews/2026-10-08-agent-bridge-implementation.md)：候选源码、实际测试及未完成的原生/宿主验收。
- [首版开发收口](reviews/2026-10-09-agent-bridge-development-delivery.md)：当前源码、Codex 默认会话协议、停止确认修复、最终 review 与 Git 交付边界。
- [完整目标核对](reviews/2026-10-08-agent-bridge-completion-audit.md)、[模型与 CLI 验证](reviews/2026-10-09-model-policy-and-cli-validation.md)、[真实跨工具与 stdin 补验](reviews/2026-10-09-native-cross-agent-and-stdin.md)：当前工程门禁、原生字节绑定证据及未完成项。
- [原生协议与账户路径核对](reviews/2026-10-09-native-protocol-and-account-path.md)：ZCode 认证语义更正、Codex 原生 MCP 握手，以及公开会话生命周期补验。
- [ai-code 多插件架构](../../ai-code/docs/architecture.md)与[派发插件设计](../../ai-code/docs/design/2026-10-08-agent-delegation-plugin-design.md)：独立插件及明确派发规范。

## 底座规格与实际交付

- [P0 架构](superpowers/specs/2026-10-01-mcp-foundation-architecture.md)、[详细改造](superpowers/specs/2026-10-01-mcp-foundation-refactoring-detail.md)、[实施路线](superpowers/plans/2026-10-01-mcp-foundation-implementation-plan.md)：历史规格，部分首页仍保留当时状态。
- [P0 修复](superpowers/reviews/2026-10-02-mcp-p0-repair-report.md)、[整体返修](superpowers/reviews/2026-10-03-mcp-overall-review-repair-report.md)、[连接与错误传播修复](superpowers/reviews/2026-10-08-mcp-foundation-defect-repair-report.md)：实际命令与验证边界记录。
- [SDK v2 现代化设计](superpowers/specs/2026-10-03-mcp-v2-modernization-design.md)：独立后续阶段，尚不代表迁移完成。

## 历史背景与操作说明

- [平台设想](ai-mcp_design_document.md)、[历史 Gateway V2](mcp-gateway-architecture-v2.md)：保留原日期、方案与后续补充，不能直接作为新模块实施清单。
- [2026-09-30 协作设计](superpowers/specs/2026-09-30-agent-collaboration-design.md)：历史背景；本次 Bridge 及插件稿更新调用者、目标和触发边界。
- [Gateway 运维](gateway-operations.md)：阅读时结合当前 README 与实际修复报告核对版本和行为。
