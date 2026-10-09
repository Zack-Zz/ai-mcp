# Agent Bridge 首版开发收口

日期：2026-10-09（Asia/Shanghai）。本记录面向本轮开发、review 与 Git 交付，
不代替三个宿主的正式安装和完整原生验收。用户本次已明确授权：开发完成、
review 无阻塞问题后 commit、push；没有扩大到 tag、PR、安装或公开发行。

## 开发范围与当前实现

`@ai-mcp/agent-bridge` 0.1.0 候选包含一个独立本地任务服务，以及共用它的
CLI、MCP stdio/HTTP、TypeScript 控制客户端。契约、持久化、幂等、准确
会话绑定、恢复、取消、工作区租约、快照、diff、注册验证和产物读取均有
源码与回归覆盖。ai-code 的独立派发插件负责明示意图、交接和结果验收，
不嵌入另一套驱动或执行状态。

三执行器的公开入口已适配。Claude 使用非交互 CLI；ZCode 使用已安装
CLI 的 prompt/cwd/json/mode/resume；Codex 默认使用公开 app-server
JSON-RPC，也允许受控配置显式选择 exec。缺少实际运行证据的能力保持
unverified，默认客户端拒绝自动启动，限定原生验证才可由受控配置允许。
不设模型白名单，不修改用户模型、账号、全局配置或宿主缓存。

ZCode 0.16.9 的公开 CLI 适配没有发现遗漏参数。当前 standalone 的
账户服务未提供桌面 start-plan 的 JWT/Bearer 路径；官方 Agent、Remote
Control、Bot Channel 文档也未提供 Bridge 可精确创建/恢复会话的公开
桌面 API。该限制属于当前宿主入口，不能通过伪造 entitlement、变换密钥
语义或更换模型修复。成功新建/续接与 ZCode 宿主矩阵仍未验收。

## Codex 生命周期与两个停止确认问题

旧 exec 的原生 Git 子进程残留证据保留为 failed/unknown。新的默认路径
以 thread/start 或准确 thread/resume 创建持久根会话，再按准确 turn ID
执行、接收原生终态并有序关闭 owned app-server。不会关闭原生插件、
覆盖模型或把 app-server 当作 MCP。

独立 review 确认以下停止证明问题，按有效 RED/GREEN 修复：

- 原生 group 消失但逃离该 group 的后代仍持有 stdout 时，不能证明停止。
  适配器返回 `executionStopped:false`；Core 保留 recovery_required 和
  lease，不抓取交付、不运行 verifier、不允许下一写任务。重启后的
  cancel/continue 也不能只凭 PID 消失解除隔离。
- 日志/observer 失败不能丢弃已取得的停止证据。Core 捕获原生 outcome
  中的退出与停止标记；已启动但未取得结果时保守标为停止未知，避免用
  一条新的通用错误结果放行工作区。
- 停止结果写入 Journal 之前失败或崩溃，不能让重启恢复仅凭进程消失
  解除隔离。Codex app-server 的 run 在原生 launch 前持久化
  `terminationProofRequired:true`；恢复要求明确持久化的停止证明，缺失
  或不完整的 outcome 也保持 lease。真实临时 Journal 的 ENOSPC 故障
  注入与生产 Core 复现两项失败，加上两项直接恢复反例构成有效 RED；
  修复后3files/28tests通过。已确认未启动的错误可记录肯定停止证据，
  不把启动前明确拒绝误报为仍在运行。

## 当前工程与原生记录

最终停止证明修复及测试文件拆分后的完整回归为70 test files / 615 tests，行与语句
90.21%、分支85.49%、函数96.35%，原80%阈值保持。全仓 lint、typecheck、
build 及三条既有Gateway E2E通过。测试自身的多次服务启停超出默认5秒后，两个集成场景改用
独立30秒测试时限；未放宽产品的执行或退出期限。最终 review 和本轮
工程复验结果在下节记录，不能用旧记录替代后续改动的验证。
应用测试的公共harness与准确绑定场景纯拆分到独立文件，测试数保持615，
各源码/测试文件符合800行上限；拆分后定向、类型检查、lint及全仓覆盖率
已重新通过，生产代码不因该整理改变。

编译后的新默认路径经真实薄客户端、CLI、IPC 和 Application 实测：
task `task_6c1bc8e7-4a9d-429c-a487-fdbce0bcb001`，独立原生 root
`01a11f44-4809-7602-884a-d9d0ebc1df95`。第一轮隔离改动及注册验证完成；
runtime 停止并重启后，第二轮准确续接并从记忆召回随机值；第三轮在
真实 commandExecution 已启动时显式取消。两次 completed 和一次
cancelled 均记录 processGroupExited/executionStopped 为 true。

三轮原件保持 ZERO 加换行，隔离交付为 ONE 加换行，outOfScope 为空，
产物经 CLI 分页读取并核对哈希/大小；取消轮的 verifier 因取消未完成，
不宣称该轮验收通过。运行前后编译文件、薄客户端与临时配置哈希相同，
但 `~/.codex/config.toml` 哈希变化，整体验收脚本最终 exit1。不能归因
为 Bridge 修改了全局配置，也不能据此填写正式 host acceptance。
自有 runtime 最终 stop exit0。原始材料保留在本机
`/private/tmp/agent-bridge-native-appserver-4f62ly74`，不入公开包。

## 最终 review 与工程复验

独立code_reviewer（GPT-6.1 Sol/max）以指令限制的只读方式检查任务状态、
权限/会话绑定、原生适配、IPC及两仓插件接线。停止确认的正常、observer
异常和outcome落盘窗口已复审修复；其反例使用生产Core与内存替身，主会话
另有真实临时Journal与已退出PID的回归。没有宣称实际磁盘ENOSPC或原生
崩溃实验已经完成。

插件回执并发覆盖的P2另在主会话以两个真实Python进程复现：旧实现两个
不同任务均写成功并覆盖绑定。修复使用私有稳定lock inode上的POSIX
跨进程互斥，覆盖归属检查和原子发布，内核在进程退出时释放锁；明确
繁忙/冲突而不替换任务。插件35项测试通过，包含进程退出后锁释放、
同绑定幂等与null补录准确session。独立reviewer已复审该修复，当前限定
范围无确认的P0/P1/P2遗留；其文件/flock反例使用内存替身，真实子进程
测试由主会话执行。ai-code最终5组统一门禁、lint、两插件源校验、三宿主
六个可信源码包检查、marketplace sync --check及check_dist均通过。
派发插件最终source hash为69b69870…；CodeVow保持24793827…，技能与
工具未改。生成制品绑定当时HEAD和dirty来源，check_dist按其自身清单
校验ZIP完整性并与新构建对比payload，不假装为clean/stable发行。

## 首版之外与未验收的事项

- Bridge MCP 使用 SDK v2 / 2026-07-28，stdio/HTTP 有真实 SDK 测试；本机
  Codex MCP 客户端仍请求旧协议，实际握手拒绝，不加入自动降级。
- shared/server/client/gateway 全面 SDK v2 迁移是独立底座改造，未由本轮
  Bridge 宣称完成。Bridge 不能经当前 v1 Gateway 推导可用。
- 原生 MCP 插件 profile、桌面可见/接管、Windows 和 Codex read-only
  均未声明支持。Codex read-only 的已发现原生写入问题目前明确拒绝。
- 三宿主整包正负矩阵、固定环境原生复验、安装与正式 release 仍各有
  独立证据要求。源码 review 通过不等于这些验收完成。

参考：[模块使用说明](../../packages/agent-bridge/README.md)、
[原生协议与账户核对](2026-10-09-native-protocol-and-account-path.md)、
[原设计完整验收核对](2026-10-08-agent-bridge-completion-audit.md)。
