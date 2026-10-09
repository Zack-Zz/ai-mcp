# Bridge 完整目标核对

日期：2026-10-08；2026-10-09 补充当前证据。结论：候选源码与
本地工程门禁通过，完整目标尚未证明。用户已明确允许当前可用官方或第三方模型，
不把 fixture 成功、技能加载或 unsupported 能力替代原生完整闭环。

## 原设计第 9 节的逐项结果

| 原验收要求             | 当前权威证据                                                                                     | 状态                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 普通请求不派发         | 插件 33 项测试；Claude/Codex 普通开发、架构、引用负例真实日志                                    | 部分证明；ZCode 宿主场景未完成                       |
| 跨工具、同工具独立会话 | 三 driver fixture、真实 Claude/Codex 精确 session；同引擎 gate                                   | 驱动部分证明；ZCode 原生执行与各宿主矩阵未完成       |
| CLI/MCP/API 一致       | contracts/application/ipc/cli/mcp/mcp-cli/integration tests；编译 CLI + 真正薄 client fixture 链 | 本地实现已证明；原生宿主 MCP 接入不由 SDK 测试推导   |
| 不同模块共存           | 官方 v2 factory 的另一受控 fixture module 组合调用                                               | 已证明受控组合；现有 v1 Gateway 接入属于独立迁移     |
| 幂等、未知结果         | duplicate start/continue/cancel 与 RPC 断开；Journal replay；原始错误恢复 regression             | 已证明实现与 fixture 分支                            |
| 准确续接               | exact native session、多个 workspace、租约、caller、项目指纹、权限变更拒绝                       | 已证明实现；真实 ZCode 续接未完成                    |
| 取消、恢复             | owned group 及后代 fixture、exit/close、PID复用拒绝、dead-owner原子恢复；Claude/Codex 原生取消   | 代码与受限原生证明；ZCode 全链未完成                 |
| 权限、工作区           | workspace.test 基线/dirty/links/Git状态/范围/验证；Codex read-only 实际写入证据                  | 完整权限一致性未证明；该只读模式已拒绝，不能宣称通过 |
| 交付准确               | 新增/删除/mode diff、验证失败、outOfScope、failed task query exit0                               | 已证明实际临时 filesystem 与受控 runner              |
| API 易用               | 所有 verb help、参数/JSON/退出码、typed client 和 compiled consumer                              | 自动化消费已证明；未用脚本代替三端首次用户使用验收   |
| 输出消费               | UTF8/NDJSON、分页、cursor、stdout/stderr、native终态验证                                         | 已证明本地入口与 fixture 协议                        |
| 插件互不影响           | 两插件统一5组门禁、6包来源检查、CodeVow源树哈希不变                                              | 资源/工程已证明；各真实宿主完整行为仍未证明          |

## Named gate 与产物

2026-10-09 app-server、停止证明持久化修复与测试文件拆分后 Bridge 全仓70 test files / 615 tests；原80%覆盖阈值保持，
行/语句90.21%、分支85.49%、函数96.35%。全仓类型检查、lint、build通过；
三条既有 Gateway e2e 已通过。ai-code 注册/源校验、5组统一门禁、两插件
三宿主构建、6个trusted package checks、marketplace sync --check、check_dist
及文档链接已通过。没有源码 Git 提交、安装或发行结论。

[技术实现记录](2026-10-08-agent-bridge-implementation.md)、
[模块使用说明](../../packages/agent-bridge/README.md)、
[ai-code 设计](../../../ai-code/docs/design/2026-10-08-agent-delegation-plugin-design.md)、
[插件记录](../../../ai-code/docs/reviews/2026-10-08-agent-delegation-implementation.md)
保留各自产物与证据边界。过去的原生/宿主测试绑定当时包字节，源码变化后
不自动写 accepted。所有正式 host acceptance 仍为 null。

## 当前原生边界

- ZCode 0.16.9 当前 standalone 账户路径不支持桌面的 start-plan JWT/Bearer
  注入，existing individual 账户索引也缺失。前次 API-key 转换改变了认证
  语义，其签名失败不能证明桌面凭据失效。未改全局配置、伪造授权或关闭
  签名；需要核对实际可用入口，成功执行与续接仍待终态。
- Claude 的真实自然加载、fixture 派发/产物读取与三个负例已证明；另有
  当前 54b/e71ad Claude→真实 Codex 新正例已完整完成，isolated、原件保留、
  独立验证与最终报告通过；此前 existing/混合候选轮次仍按历史边界记录。
  当前人类澄清后外层审批获准。旧审批拒绝保留为历史事实。
  CLI 沙箱禁查 ps 的连接缺陷已修复并验证，不用不可信文件代替身份校验。
- Codex 全候选 capability root 自然加载、三个负例已有原生 fixture 证据；
  新候选 54b06e1e… 的 Codex→真实 Claude（glm-5.3）完整正例已完成，包含
  原目录 stdin 调用、独立隔离目标、注册验证、产物回收与最终用户报告。
  早期 ephemeral caller 的 90 秒中断及 no rollout 仍保留，未伪造恢复。
- ZCode 宿主及三端真实目标的完整正负矩阵仍未完成。目标三端完整验收不
  等于 adapter 能运行或 skills-only 包可以构建。
- 旧 exec 的真实 Codex 同工具独立会话两轮 leader 退出后仍有 Git 子进程，
  原 failed/unknown 保留。默认 app-server 的后续整链已观察到新建、服务
  重启后准确续接/随机值记忆和实际工具执行期间取消，三轮停止确认成立。
  期间全局配置哈希变化导致整体验收脚本 exit1，正式 acceptance 仍未通过。

[2026-10-09 补充记录](2026-10-09-model-policy-and-cli-validation.md)说明
模型原则、当前原生配置及认证控制面修复。三端正式 host acceptance 仍未
从部分场景或 fixture 结果自动填写。

[跨工具与 stdin 补验](2026-10-09-native-cross-agent-and-stdin.md)记录后续
真实 Codex/Claude 两方向的具体包字节、最终报告、工作区和验证边界。

[原生协议与账户补充](2026-10-09-native-protocol-and-account-path.md)记录
认证解释更正、Codex 原生 MCP 旧协议的真实拒绝，以及公开 app-server
生命周期。最新源码收口、停止确认修复、615项回归与 native 整链边界见
[开发收口记录](2026-10-09-agent-bridge-development-delivery.md)。
