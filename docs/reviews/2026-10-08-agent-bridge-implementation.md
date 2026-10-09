# Agent Bridge 候选实现与验证记录

日期：2026-10-08。基础源码：`ai-mcp main@2c6a767`；本轮改动保留未提交。
本记录区分源码/fixture 集成、真实原生驱动、宿主加载与用户验收，不把某层
通过推广为其他层通过。实现目标尚未全部完成，仍有本机配置/授权阻断。

## 已实现

`packages/agent-bridge` 0.1.0：严格 TaskSpec/Start/Config、三个 canonical
engine、明确同引擎独立意图、可导入有类型的客户端、CLI、私有 IPC 服务、
持久日志/幂等/恢复、isolated/existing 工作区与租约、精确 session 续接、
owned group 取消、immutable 基线和产物哈希、登记命令验证、MCP v2 门面。

只有显式任务进入 Bridge；客户端配置选择真实 caller，RPC 不接受请求升 role。
用户来源仍为技能指令与受控配置边界，不把 scopeReference/approved/receipt
当作密码学人类授权证明。runtime 在当前 OS 用户信任边界内，CLI/SDK API
并不提供对同 UID 任意代码的隔离；进程写权限依赖实际原生能力与范围检测。

原生 stdout/stderr 事件在执行期间写入私有 run 文件；outcome 先持久化再
捕获交付。caller 断开、MCP 超时/关闭不取消任务。未知运行不自动重放，
旧进程退出未确认时保留 recovery_required 和工作区租约。

CLI 与控制 API 共用服务，MCP static tool 前缀避免模块命名冲突。官方 SDK
v2 factory 的 stdio/HTTP 验证现代协议 `2026-07-28`，legacy 明确拒绝。
原有四个 SDK v1 基础包未迁移；现有 Gateway 接入不在本轮已验收范围。

## 本地门禁与实际边界

本轮已有完整回归：64 个 Vitest 文件、548 项测试通过，v8 行/语句 89.23%、
分支 84.72%、函数 96.48%，原有 80% 阈值未降低。CLI caller 回执命名空间、
项目登记指纹、失败回执恢复均包含定向 RED/GREEN 与完整回归。
全仓 `pnpm -r lint/typecheck/build`、三条原有 Gateway e2e 均通过；最终格式与文档引用独立检查。

证据分层如下：

| 层                                      | 实际观察                                                                                | 能证明的范围                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 契约/日志/工作区/适配器单元             | 有效断言 RED → GREEN；精确绑定、哈希、links、预算、权限拒绝                             | 实现分支和 fixture 生命周期                                  |
| 真实 CLI/IPC/Core/driver/workspace 全链 | 独立 daemon、CLI 断开、准确 resume、基线 diff、验证、分页、范围失败、取消、重启查询     | 临时 Git 项目和 fixture engine；不等于真实模型               |
| MCP 原生 SDK 集成                       | 两独立 stdio/HTTP client、全部 10 verbs、Host/Origin/auth/body limit、另 fixture module | 官方 v2 传输、schema/codec/组合；不等于现有 Gateway/宿主接入 |
| 真实引擎                                | 见下表；本机已有工具和默认账号/模型                                                     | 只覆盖明确记录的版本、权限和任务                             |
| ai-code 发布接入                        | catalog 登记、两插件三宿主构建、可信源码六包检查、统一 5 组测试                         | 资源、测试与制品完整性；不等于安装或正式发布                 |

测试只在 `/private/tmp` 临时 Git 基线 commit，不对业务/工程源码执行 commit、
push、tag、merge、PR 或发布。未手工改全局配置、未安装插件或系统服务。

## 真实引擎观察

原始脱敏证据保留在
[/private/tmp/agent-bridge-native-verification-eMVb2i/VERIFICATION.md](/private/tmp/agent-bridge-native-verification-eMVb2i/VERIFICATION.md)。
由适配工作者采集，主会话据实际失败修正实现；未复制密钥到公开包。

| 引擎/版本                     | 已观察                                                                                        | 未完成/限制                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Claude 2.1.177                | 相同准确 ID 新建/续接与 nonce、限定 Write、Read-only 的受限工具集合、取消、最终 owned PG 退出 | 写入要求的末尾换行未满足；证明执行与字节验收不同                                     |
| Codex App CLI 0.162.0-alpha.2 | workspace-write 下新建/准确续接、nonce 精确、读写与文件哈希检查、group 退出                   | 原生 read-only apply_patch 实际写入，不能宣称受限；Bridge 已直接拒绝此模式           |
| 系统 Codex CLI 0.154.0        | help/version/flags 及主动取消                                                                 | 当前默认 gpt-6.1-sol 返回 ChatGPT account 模型 HTTP 400；不改模型/账号解决           |
| ZCode 0.16.9                  | 真实 launcher/init、既有 bundle 资源定位、日志 cause 检查                                     | CLI profile 无默认模型，`Select a model before continuing`；待用户选可用已有 profile |

Codex 两安装版本分开记录。恢复 native shell/read 工具而沿用原 sandbox
profile，剥离继承的 Bridge 控制环境及 Codex 父 session/IPC/sandbox marker；
实际只读仍失败，因此采用能力拒绝，不静默换成 write 或仅据 help 标支持。
ZCode 可在受控 EngineConfig.env 定位既有 builtin/personal config 文件，
不自动创建 provider、读出密钥或选择模型。

## 风险审阅与修复

主会话承担设计/实现/整合；两个 implementer 独立负责驱动与 IPC、插件与
工作区/MCP，之后做限定原生/宿主证据采集。一次独立 code_reviewer 审阅
Core/runtime/client 边界，返回具体触发路径；主会话复现有效 RED 后修复。

- 持久任务绑定原 permissionProfile；配置变更不能升格原任务。项目目录/
  验证命令等登记指纹变化也要求新的 start。
- 幂等键使用无歧义 owner/requestId 组合；CLI 发送前回执按 caller 隔离。
- 有 durable not_started outcome 的无 PID 失败可安全取消/释放租约；未知
  启动仍保持阻断，不自动重跑。
- 失败 start 的回执持久化 executionDisposition 与 details；重启后重复
  requestId 返回原错误语义，不丢详情、不把明确未启动变成 unknown 或重复错误前缀。
- 原生 leader 退出不等于 group 退出。后台后代 fixture 已复现提前 completed；
  现等待/终止 owned group，并在无法确认时保留 recovery_required。
- 独立监听 Node exit 与 stdio close；信号升级期间发现 group 消失即停止，
  已退出 leader 的占用 PID 被视为未验证/复用，不按数字误杀。
- 死恢复 owner 不永久占用 sentinel；采用原子发布的 populated 私有目录和
  nonce 文件回收，实际两个并发 claimant 测试只有一个 writer。

审阅者未在其限制沙箱内运行真实 ps/IPC。主会话的提升测试仅用于临时
fixture 的 owned 进程身份和本地 socket，真实测试与内存 proof 分开记录。

## 待完成事项

1. ZCode 实际新建、精确续接、写入/取消与交付：依赖用户可用的原生模型 profile。
2. 三宿主派发插件完整正负闭环：Claude 已真实加载/自动触发技能，完整
   Bash→Bridge 正例尚受原生 session-env 的外层 EPERM 及审批阻断；Codex /
   ZCode 宿主未完整验证。详见[ai-code 记录](../../../ai-code/docs/reviews/2026-10-08-agent-delegation-implementation.md)。
3. 用户是否授权一次默认 deepseek-v4-pro[1m] 服务的 Claude 宿主验收：仅公开
   插件与虚拟项目，不含业务代码，允许必要的原生会话状态写入。自动审批
   曾以缺少该具体授权拒绝外层提升，未绕过；已发起用户问题，尚待答复。
4. 已完成 548 项完整 gate、两插件三宿主 source-bound 包检查、生成市场与 dist 一致性复验；后续只在新增改动/失败时重跑对应检查。

桌面可见性/控制、Windows、四个基础模块 SDK v2 迁移及 Git/正式发行
各有独立范围，不能以本次候选实现宣布通过。

编译后 CLI 的实物联调也已通过：真实 Python 薄客户端→编译入口→独立 daemon→fixture engine，正确回执/session、重复请求仅一轮 native 启动，原项目保持 ZERO，isolated worktree 为 ONE。证据保留在 `/private/var/folders/2l/73r8_l3s7dv0hd955602j3pr0000gn/T/agent-bridge-thin-compiled-r_txxhj3/evidence.json`；这证明编译消费链路，不替代真实模型/宿主验收。

## 2026-10-09 后续状态

以上测试数字、原生限制和审批等待描述保留为 2026-10-08 的历史证据。
用户随后已明确允许当前官方或第三方模型，限定原生测试审批获准。
当前不再等待更换官方模型或 Claude 授权；ZCode 已有 GLM 配置，内置
standalone CLI 不提供桌面start-plan的账户JWT/Bearer路径。前次API-key
转换解释已更正，不能据其签名失败判断桌面凭据不可用。

stdin 修复后本地工程门禁为 66 files / 565 tests，保持原80%覆盖阈值。
Codex→真实 Claude（glm-5.3）新候选完整闭环已完成；另有 Claude→Codex
目标完成和准确 caller 续接收尾。真实 Codex 同工具会话准确续接已有观察，
但残留 Git 网络子进程导致任务仍 failed/unknown，未标为通过。
当前范围及具体字节绑定见 [完整目标核对](2026-10-08-agent-bridge-completion-audit.md)
和 [跨工具补验](2026-10-09-native-cross-agent-and-stdin.md)。

后续默认Codex app-server与停止确认修复后，全仓68files/610tests通过；
原生新建、重启后准确续接、工具执行期间取消已有记录，整体验收受期间
全局配置哈希变化影响未通过。当前开发review与本次Git授权见
[2026-10-09开发收口](2026-10-09-agent-bridge-development-delivery.md)。
