# MCP P0 审阅返修交付（2026-10-02）

本轮由用户“那剩下的 你直接完成”授权，修复上一轮实际源码审阅和真实 SDK/TCP 探针确认的问题。继续使用 main@8dad112 的现有未提交工作树；未执行 commit/push/merge/PR。协作设计背景稿 SHA-256 保持 28bba425025a41d94e6041d520425107f3660a5808419aba1c5f2ff2f96afeda。SDK 仍为 1.27.1；不实施 SDK v2/现代协议迁移、CLI 执行器和 Agent Runtime。

## 已修复的问题和证据

以下回归均先观察到失败，再修改实现。旧测试中把 standard outputSchema 写成内层 payload、把 HTTP socket reset 当成 body 限额验收、拒绝媒体内容等错误预期已同步校正，未削弱校验或覆盖率门槛。

| 问题                                                         | 最终处理                                                                             | 主要回归                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| stateful Server/Gateway 收到 JSON null 会崩溃                | 解析结果先检查对象形状，返回 400；子进程仍可服务 health                              | gateway/test/http-safety.test.ts 的真实子进程                               |
| Schema 遍历误把业务字段/常量中的 `$async`/`$ref` 当作关键词  | 仅遍历实际 schema 位置，保留 const/enum/default/examples 数据                        | shared/test/schema-safety.test.ts                                           |
| `$async` Ajv validator 返回 Promise 被当作 true              | 编译前拒绝异步 schema，递归检查数组中的引用                                          | shared/test/schema-safety.test.ts                                           |
| Connector metadata 丢失使 critical/hidden 变成 medium/public | 快照携带 metadata，发现、授权和审计统一使用；title/icons 进入 wire                   | gateway/test/governance-regressions.test.ts                                 |
| standard/v1 的完整 outputSchema 被误当 payload schema        | 按完整 envelope 验证、公开原 schema；闭合正文不补不允许的字段                        | gateway/test/contract-regressions.test.ts、gateway-server.test.ts           |
| Client 跳过 standard 结果校验                                | 严格解析 standard envelope；成功校验整个结果，失败设置 isError                       | mcp-client/test/call-tool.test.ts                                           |
| 本地 standard ok:false 被标记成功并记录成功审计              | Registry/Dispatcher/Presenter 均使用 tool_failure                                    | mcp-server/test/invocation-regressions.test.ts                              |
| SSE onclose 再调 instance.close 导致递归溢出                 | onclose 仅解除引用，SDK 完成协议清理；服务 close 只关一次                            | mcp-server/test/sse-lifecycle.test.ts                                       |
| 标准原生错误再次包装、丢失业务 code/artifacts                | isError 优先，但保留有效标准失败外壳                                                 | gateway/test/contract-regressions.test.ts                                   |
| 忽略 signal 的 handler 在 deadline 后返回成功                | 调用与 deadline/取消竞争，超时返回明确类别与 unknown 执行状态                        | mcp-server/test/invocation-regressions.test.ts                              |
| 输入异步校验结束后仍执行已经超时的调用                       | handler 开始前检查 signal；未开始时 disposition=not_started                          | 同上                                                                        |
| 未完成 HTTP body 阻塞服务 close                              | 监听器拥有全部 socket，停接入并按 grace 关闭残留连接，读 body 响应取消               | gateway/test/http-safety.test.ts                                            |
| Gateway close 不等待审计落盘                                 | 跟踪调用终态，关闭协议/下游后 flush 可关闭的 AuditStore；重复 close 共用完成 Promise | gateway/test/governance-regressions.test.ts                                 |
| 非协作下游阻塞 Gateway close                                 | 服务级取消与业务等待竞争，不等下游配合；记录 cancelled/unknown                       | 同上                                                                        |
| 媒体内容在 Connector/Gateway 被误报 invalid_result           | 兼容投影与适配器保留 content-only，公开 schema 允许有内容的成功外壳，外层保留媒体块  | gateway/test/connectors.test.ts、contract-regressions.test.ts               |
| pinned transport 缺少 terminateSession                       | 委托 DELETE 生命周期与 send options                                                  | gateway/test/connection-recovery.test.ts 的真实 HTTP Client                 |
| 已连接 HTTP 下游离线被分类为 backend_error                   | 按 typed HTTP 状态/网络 cause 分类 unavailable，后续调用可重建 Client                | gateway/test/connection-recovery.test.ts                                    |
| permanent 错误未丢弃旧 Client                                | 分类后只丢弃当前失败实例，下一次独立调用重连；不重放失败业务调用                     | gateway/test/connection-recovery.test.ts                                    |
| 关闭遗漏正在握手的 HTTP candidate                            | Connector 拥有 active 和 candidate，并等待连接完成清理                               | 同上的真实 HTTP 挂起握手                                                    |
| runId/taskId 没有 trace 时丢失                               | Client 生成 trace，保留两身份并验证 metadata                                         | mcp-server/test/invocation-regressions.test.ts                              |
| 超大 body 直接 destroy，客户端拿不到 413                     | 限制缓存并响应 Connection: close 的 413，然后结束连接                                | gateway/test/http-safety.test.ts                                            |
| 调用/发现逐阶段重置预算                                      | Client 与 Connector 使用总预算，分页仅使用剩余时长                                   | mcp-client/test/call-tool.test.ts、gateway/test/connection-recovery.test.ts |
| 通用 JSON-RPC code 覆盖了 typed category                     | 已验证的 category/projectCode 优先，保留原始 code/data                               | mcp-client/test/errors-classify.test.ts                                     |
| close 后可以重新创建未被关闭流程拥有的 listener              | start/initialize 终态防护；连接失败也清理实例                                        | gateway/test/http-safety.test.ts                                            |
| coverage 排除了旧 HTTP/SSE Client 文件                       | 恢复 HEAD 原统计范围，四项门槛仍为 80%                                               | vitest.config.ts 与完整 coverage 命令                                       |

## 兼容契约

- echo/time、local\_\_echo 外壳、旧 CLI `{output}`、legacy RPC 以及原四字符串错误码保留。
- 有意修正：standard ok:false 统一为原生工具失败；无效成功结果不再透传为成功；HTTP body 超限明确返回 413；标准错误保留业务 code 和 artifacts。
- standard outputSchema 从来描述整个 MCP structuredContent。源 schema 若限制额外字段，trace/run/task 不修改正文，通过 result.\_meta 提供。native-json/v1 的业务 payload ok:false 和“成功查询一个失败任务”仍为成功。
- 默认会话模式不变；关闭 A 不关闭 B 或服务级 Connector。close 后禁止新增入口。
- `$async` 是本期不支持的 JSON Schema 扩展，不代表拒绝本地 Zod 异步校验；异步 Zod 校验和 handler 同样受调用 deadline 管理。
- 注入 AuditStore 的可选 close 表示生命周期交给 Gateway；Gateway 保持原仅有 record 的结构兼容。操作未知时 audit_unavailable 的 operationCompleted 为 null，避免把未知误称已完成。

## 验证分层

源码复核覆盖 Registry → Dispatcher → SDK Presenter、Client → Connector → Catalog → Gateway Adapter，以及会话/请求/候选连接/listener/audit 所有权。复核在实现完成后重新读取实际 diff 和调用链；未沿用上次交付报告中的“pass”作为本轮依据。本轮未另行启动独立 Reviewer 子代理。

单元及协议集成测试采用真实 SDK InMemoryTransport、真实 HTTP/SSE Client、TCP socket、真实 stdio 子进程及 HTTP 子进程。已有两客户端 barrier 测试和真实进程 e2e 保留：只有双方都进入 handler 后才放行，关闭 A 时 B 的在途和后续调用都成功，共享 Connector 不关闭。

最初审阅的探针重跑针对 dist，证据保存在 `/private/tmp/ai-mcp-p0-repair-20261002/`：20ms 本地 deadline 实测约 22ms 返回 -32001/backend_timeout/unknown；JSON null 返回 400 且进程未自行退出；标准成功按公开完整 schema 验证通过；纯图片保留原生内容；pending body 在 30ms grace 下关闭；审计写入尚未放行时 Gateway close 未返回；body 超限为 413；pinned close 发 DELETE，后续会话 404、实例数 0；两次独立 stdio 失败调用创建两个进程；SSE stderr 无递归溢出。

## 完整检查

环境：macOS darwin 25.6.0 arm64；pnpm 9.12.0；Node 22.16.0 与隔离的 Node 20.20.2。以下均基于最终源码重复验证，exit code 为 0。

| 命令                         | Node 22      | Node 20      |
| ---------------------------- | ------------ | ------------ |
| pnpm lint                    | 通过         | 通过         |
| pnpm typecheck               | 通过         | 通过         |
| pnpm test:coverage           | 273/273 通过 | 273/273 通过 |
| pnpm build                   | 通过         | 通过         |
| pnpm test:e2e:gateway        | 通过         | 通过         |
| pnpm test:e2e:gateway:http   | 通过         | 通过         |
| pnpm test:e2e:gateway:matrix | 通过         | 通过         |

覆盖率统计使用 HEAD 原始排除范围；旧 HTTP/SSE Client 文件重新参与统计。Node 22 为 85.12% lines/statements、82.35% branches、95.25% functions；Node 20 为 85.20% lines/statements、82.34% branches、95.25% functions，全部高于原四项 80% 门槛。Vitest 输出没有 Unhandled Errors/SSE RangeError。git diff --check 通过；vitest.config.ts 与 HEAD 相同。

七项命令原始输出位于 `/private/tmp/ai-mcp-repair-{lint,typecheck,coverage,build,e2e-basic,e2e-http,e2e-matrix}.log` 和 `/private/tmp/ai-mcp-node20-{lint,typecheck,coverage,build,e2e-basic,e2e-http,e2e-matrix}.log`。Node 20 只在临时目录下载，不改项目依赖与用户默认 Node；没有声称 GitHub Actions/Linux CI 已运行。

核对 SDK 1.27.1 的实际 ToolSchema，execution.taskSupport 可保留（例如 forbidden）；不能沿用上一交付中“SDK 1.x 一概剥离”的描述。这并不代表 Gateway 实现了 MCP Tasks，本期仍拒绝 required 并将 optional 公开为 forbidden。

## 保留边界

- 未运行远程 GitHub Actions 的 Ubuntu 环境；本机 macOS 上验证 Node 22 和 Node 20。
- stateless 旧协议不承诺跨请求 MCP 取消。非协作 handler/第三方 Connector 的业务代码无法强制终止，返回超时/取消时执行状态仍可能未知；等待与协议资源可以回收，禁止自动重放。
- 审计队列饱和可能发生在工具执行后；失败明确报告 audit_unavailable，业务不重放。任意注入审计 sink 的无限挂起无法在保证 flush 的同时被声明为成功，测试只在受控 barrier 最终放行后确认完整写入。
- 不承诺第三方 host 对所有元数据的展示行为，不实现 experimental task APIs；SDK v2/新协议迁移继续属于另行确认的 P1。
- 所有修改和原有文档改动保留未提交，Git 集成未授权。
