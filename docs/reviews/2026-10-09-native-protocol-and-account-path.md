# 原生协议与账户路径的补充核对

日期：2026-10-09（Asia/Shanghai）。保留前次原始失败材料，按新的源码与
运行证据修正解释；本记录不构成安装、发布或全目标完成声明。

## ZCode start-plan 的认证语义

前次将 legacy `builtin:bigmodel-start-plan` 的 `apiKey` 字段当作正式 API-key
access，虽然保持了不透明值、endpoint 和 GLM-5.3，仍改变了原生认证语义。
该签名失败只证明测试中的 API-key 表示不适用，不能证明桌面凭据失效，
也不能推广为 GLM 或第三方模型不可用。

只读源码核对确认：桌面 `uj/resolveBigModelStartPlanZcodeJwt` 优先 OAuth
`zcodejwttoken`，再 fallback 旧字段；`P_/AccountProviderRequestAuthService`
将 start-plan 的 `zcodeJwtToken` 作为 Bearer 使用。GUI `qI` 和 CLI `NHa`
均跳过旧 start-plan 的 API-key 导入。原生 `yz` 将旧选择 ID 迁移为
`account:bigmodel-start-plan`，不是密钥格式转换。

当前内置 standalone CLI 0.16.9 的 `nPn/SHo` 只实现 individual-coding-plan，
`Ykt` 拒绝 Host account override；start-plan 需要原生账户 entitlement 与
请求认证注入，静态 personal 配置没有相应入口。未伪造身份、声明 entitlement、
关闭签名、登录另一供应商或修改全局配置。本轮仅阅读规则与实现，未读秘密值、
再次调用模型或验证该账户是否在线可用。

精确位置和安全证据：
`/private/tmp/agent-bridge-zcode-profile-reuse-BJcclG/START-PLAN-SEMANTICS.md`。
包括 builtin provider JSON 行801、CLI bundle 行68/71/15243/15353，
以及桌面 `app.asar!/out/host/index.js` 行170/171 的函数与字节位置。
此前 SAFE-RESULT.md 的测试结果仍保留，认证语义解释以本次核对为准。

ZCode 的下一步仍是取得用户实际可用的原生入口；模型品牌不构成门禁。

## 已安装 Codex 的真实 MCP 握手

以已完成任务 `task_ec808a52-9a42-43fb-898b-8a78fa0c570e` 和原 caller
`01a11ece-0ad5-7053-abae-7aa9fe22eba0` 进行只读接入检查。使用原生
app-server 的 `thread/resume`、`mcpServerStatus/list` 和 `mcpServer/tool/call`；
Bridge stdio 入口为实际编译 CLI，不是另造 MCP fixture。

安装的 Codex 0.162.0-alpha.2 仍请求 `2025-06-18`，Bridge 固定
`2026-07-28`，真实初始化返回 `-32022 Unsupported protocol version`。
临时 invocation feature 和 thread config 的 `mcp_2026_07_28=true` 均未
改变实际 wire 请求；没有据功能名称或 CLI 接受开关就宣布新协议可用。

这与用户已选的新协议设计一致：不加入长期双栈或自动降级。
CLI/控制 API 可以独立使用；当前安装版本的原生 Codex MCP 接入尚未通过。
实际 SDK stdio/HTTP 测试不能替代该原生客户端证据。

该核对未启动模型或目标任务。前后原 task/session、单 run、deliveries 不变，
原配置与编译 CLI 字节不变；三个自有 app-server 进程组均退出，runtime.stop
exit 0。材料在 `/private/tmp/agent-bridge-native-mcp-x0vy7ont`，包括
default/modern/thread-override 的 wire、RPC 记录和 before/after/proof。

公开接口与配置依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、
[CLI invocation overrides](https://learn.chatgpt.com/docs/cli/reference)。
协议是否实际生效由本轮 wire 证明，不从文档或实验功能推导。

## Codex 受控会话生命周期

已批准模块设计允许通过原生 CLI 或公开会话接口适配。原 `exec` 短任务
存在 leader 退出后 Git 网络子进程仍运行的实测；原失败与 unknown 保留。

公开 app-server 的一次原生可行性探测已完成独立持久根会话、限定文件修改、
停止服务后的准确 root resume 和随机 nonce 召回。两轮均完成，有序关服
SIGINT 后 leader exit0、全拥有的进程组退出；沿用当前 gpt-6-astra 与原生
插件、MCP、审批配置，没有强制替换模型或关闭功能。

证据：`/private/tmp/agent-bridge-appserver-lifecycle-pa9uj8gi/proof.json` 与
new/resume 的 result/events/sent。该探测不经过 Bridge Application，
只证明公开接口可行，不能代替生产适配器的 CLI/IPC/native 整链验收。

候选实现将 Codex 默认归一为 `codexTransport: app-server`，也允许显式
`exec`。新配置指纹不会复用此前隐式 exec 的 runtime proof。执行器以
准确 root/cwd/turn、原生终态、有序关服、输出关闭与全组退出共同判断完成；
强制 TERM/KILL、提前退出或未确认结果仍 failed/unknown。

后续停止证明持久化修复与测试文件拆分后已有全仓70files/615tests、lint/typecheck/build通过。真实
编译消费链的新建、重启后准确续接及取消已有记录；全局配置哈希变化使
该轮环境绑定验收未通过。停止确认修复与最终开发 review 分别见
[开发收口记录](2026-10-09-agent-bridge-development-delivery.md)。
