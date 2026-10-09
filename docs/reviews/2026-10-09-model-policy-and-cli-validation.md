# 当前模型配置与 CLI 验证补充

日期：2026-10-09（Asia/Shanghai）。本记录补充前日实现与验收记录，不改变
当时命令、包哈希和拒绝事实。用户明确：Claude Code、ZCode 使用当前可用
官方或第三方模型均可，例如 GLM-5.3/GLM-5.3-Flash；模型品牌不是阻塞项。

## 已落实的契约

两仓架构、Bridge 模块和派发插件设计已明确工具 ID 与模型 ID 分开。
Bridge 沿用原生配置和认证，不维护模型白名单，不自动换模型、供应商或
账号。调用失败按实际原生原因记录，不能要求用户改用官方模型作为验收条件。

## Claude 宿主与控制面

前次外层自动审批拒绝已在当前人类澄清后透明重新提交，限定公开候选插件、
虚拟项目和正常原生状态；本次审批获准。没有使用沙箱绕过、安装或全局
配置修改。该阶段 Claude 2.1.177 沿用当时默认 `deepseek-v4-pro[1m]`；
后续调用时默认配置已变化，真实 glm-5.3 记录见文末链接。

实际发现：启用 Claude Bash 沙箱后，CLI 客户端无法查询 daemon 的 `ps`
启动身份；服务仍存活，客户端却返回 RUNTIME_UNAVAILABLE。候选实现已修复：

- 每次 IPC 请求/响应使用 caller 凭据 HMAC、完整 binding 哈希、随机
  challenge 与不同签名域。socket 对端不接收长期 token。
- 服务端在派发前消费有界有效期 nonce，容量满拒绝而不逐出有效 nonce。
  重放/过期与不可信回复保持 unknown，不能冒称先前写请求未执行。
- 握手只读，启动总期限为 5 秒；慢速未完成回复不能重置绝对 RPC 期限。
  私有 binding 尚未完整发布时仅在该期限内重读，不在坏文件上启动另一服务。
- runtime 仍负责启动、恢复及取消的 PID/进程身份核对。HMAC 不隔离可读取
  同用户其他 caller 凭据或修改配置的进程，也不证明人类授权。

实际有效失败测试覆盖沙箱禁查进程、残留 socket 的延迟启动、部分写入的
binding、慢速回复拖延期限；修复后通过。篡改、跨 key、并发重放、时钟倒退、
签名后帧大小与既有生命周期也有本地回归。

当前插件源树 `b17748ca064786bb9115d00e795b4a8865e5acabbc255a72ca7dbdedaf330056`
的真实 Claude 正例完成自然加载、preflight、start、准确 task/session、
产物读取及登记验证。任务 `task_b75c38e3-dd98-4718-966a-6d47b8867103`，
session `c89c87fd-2c6d-4d79-8a16-c36f95eee173`，隔离代码 ONE、原项目 ZERO。
目标为 fixture engine，这证明宿主消费链，不代表真实 Codex 目标调用。

证据目录：`/private/tmp/agent-delegation-host-model-policy-20261009-_b3126dy`。
其中 `positive-authenticated-success-summary.json` 保存终态；之前的失败阶段
也保留，包含 fixture 缺自身 session 目录导致的 failed，与源码故障分开。
普通开发、架构讨论、引用指令三个真实负例均正常终态、零派发，独立证据为
`/private/tmp/agent-delegation-claude-negatives-20261009-c_tymomf/REPORT.md`。
这些材料绑定记录的候选包和当时 Bridge 字节，不自动变成正式 release acceptance。

## ZCode 原生配置与真实失败

已只读确认既有配置与实际会话使用过 GLM-5.3、GLM-5.3-Flash。原生新建
会话的 personal 配置入口缺默认选择；本轮通过受支持环境入口，在临时
配置中沿用最近的 `account:bigmodel-individual-coding-plan/GLM-5.3`，
继承原生 credential store，没有复制、解密或输出密钥。

真实启动仍失败：所选 BigModel 账号的 identity 索引缺失，CLI 无法构造
该 provider；native exit 1、无有效 session、代码未变、owned group 已退出。
这不是第三方模型被 Bridge 拒绝。现有桌面 legacy 配置与 CLI schema 不同，
没有查到无需转移凭据的受支持复用入口；未擅自登录另一 provider 或手改索引。

实际 Application 生命周期验证仅启动一轮 native run，重复 requestId 始终
返回同 task；关闭重开后仍 failed，登记 Node 校验器实际 exit 7，未冒称通过。
任务为 `task_0b37c442-1d61-47f3-bc8a-d9a59ec62a3f`。证据保留在
`/private/tmp/agent-bridge-zcode-verification-nO42O1/EVIDENCE.md`。

随后已找到当前 enabled 的同 ID `builtin:bigmodel-start-plan` 既有配置，
将同一 endpoint、认证、GLM-5.3 转成私有临时正式 schema，未改全局配置。
operator 准备脚本只在内存/0600 文件内使用值，Bridge 只收到配置路径。
按 legacy 的普通 `api-key` 语义复验后，内置 CLI 仍在 HTTP 之前返回
`ClientRequestSigningV4Error: Client signing credential must contain one separator`。
原 endpoint 会触发其强制签名；未关闭该规则，也未换服务或账号。
四个现存 BigModel 原生 account ID 的 identity 索引均缺失，未找到可直接
沿用的 start-plan/offpeak 账户映射。证据为
`/private/tmp/agent-bridge-zcode-profile-reuse-BJcclG/SAFE-RESULT.md` 和
`native-bigmodel-index-matrix.json`。这些是当前 CLI 的配置/签名兼容限制，
不能推广为 GLM 或第三方模型不可使用。

Codex bundled 0.162.0-alpha.2 的完整候选 selectedCapabilityRoots 自然加载
与三个负例已有真实证据。正例实际取得 completed fixture 任务、回执和
匹配的 6 个产物；人为 90 秒预算中断了发起端最终报告。原 caller 为
ephemeral，准确恢复返回 no rollout，未以新会话替代。相关独立记录为
`/private/tmp/agent-delegation-codex-native-20261009-ysdxq_f1/REPORT.md`。

该阶段全仓 65 files / 557 tests 通过，覆盖率行/语句89.63%、分支85.02%、
函数96.55%，保留原80%门禁。最终源码新增竞态、绝对超时及错误消息回归，
当前 source checks 与编译分别报告，不把之前的 native 字节绑定自动更新。

ZCode 成功新建、续接、写入和取消，及三端完整原生宿主矩阵仍待实际证明。
既有[完整目标核对](2026-10-08-agent-bridge-completion-audit.md)继续逐项报告，
不会因本次模型原则明确或 fixture 通过就把全部目标标为完成。

后续 [真实跨工具执行与 stdin 修复](2026-10-09-native-cross-agent-and-stdin.md)
保留新候选 54b06e1e…、66 files / 565 tests 和真实 GLM-5.3 目标闭环。

随后 [账户认证语义核对](2026-10-09-native-protocol-and-account-path.md)确认
上述 start-plan 的临时 API-key 表示不符合原生 JWT/Bearer 语义，不能据该
签名失败认定桌面 credential 不可用。当前限制是 standalone CLI 的账户
请求认证路径；保留前次材料并更正解释，没有改动实际账户或再调模型。
