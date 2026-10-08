# MCP 底座两项缺陷修复记录（2026-10-08）

本轮基于 `main@cec9f97b3c4c769c2e38eb9e8abfba1b3910fd52`。开始时重新检查 Git，工作树干净，结束时 HEAD 未变；全部改动保留为未提交状态。没有 commit、push、tag、merge、PR、安装、全局配置修改、SDK v2 迁移或 Agent Bridge 工作。2026-10-02 和 2026-10-03 的历史报告原文及 `vitest.config.ts` 与 HEAD 一致。

## 根因与修复

### 下游空闲断线恢复

SDK 在 transport 关闭时清除其连接，但 Client 原先保留已完成的 `connectPromise` 与目录；普通 `Not connected` 被标记为非永久错误，Connector 也就继续复用旧实例。

- `packages/mcp-client/src/client.ts` 观察 SDK `onclose`，使已连接实例永久失效、清除连接 Promise 和目录。新增 `isConnected` 供 Connector 判断实例是否仍可复用。初始化完成前检查 transport 关闭事件，避免把已断开的候选发布为活跃连接。
- `packages/mcp-client/src/errors.ts` 将 SDK 脱离 transport 的 `Not connected` 归为永久 `backend_unavailable`；不凭该错误推断业务执行完成。
- HTTP/stdio Connector 在下一次独立操作前退休失效实例、清除目录和 result contract，再构建新 Client；stdio 重新启动子进程。断线中的调用仍只返回原错误，不重放已提交的 `tools/call`。
- `connectors/client-operations.ts` 跟踪已接收操作。退休实例立即退出复用，等这些操作结束后关闭，避免单个 HTTP 请求失败导致健康并发调用被取消。服务关闭则主动关闭当前、候选和退休实例，并等待所有清理。
- 退休实例的旧发现结果可交付给原调用方，但只有当前 Client 且服务未关闭时才可写入 Connector 缓存。每次调用持有自身的 contract，避免跨连接目录串用。

### 下游错误执行状态和来源

Client 将真实 SDK error data 放在 `details.data`，Connector 原先未解包，Gateway 只识别 details 顶层。`audit_unavailable` 因而经过兼容类别投影成为 `backend_error/INTERNAL`，完整 peer 的执行状态和来源丢失。另外内层审计失败响应缺少完整 fault 所需的 message/disposition，无法在下一层严格识别。

- `packages/gateway/src/connectors/result.ts` 只解包通过 `InvocationFault` 校验的 SDK peer data；有效的 `operationCompleted` 只能为 boolean/null，且必须与 completed/not_started/unknown 一致。
- Client 既有仅含 category/projectCode 的兼容分类保留，但这种不完整数据不能提供执行状态知识。非法来源、缺失身份、无效 disposition、字符串 operationCompleted 或矛盾状态均保持 unknown。
- Gateway 保留有效 peer 的 category、projectCode、executionDisposition、source、details 和 operationCompleted。响应顶层 trace/invocation 使用本次本地身份；完整下游身份和原来源位于 `details.peerFault`，有源 trace 时用于审计关联，缺失时使用 peer trace。
- Gateway 发出的协议错误包含完整 message/details；审计持久化失败发出完整 `audit_unavailable/AUDIT_UNAVAILABLE` fault，并明确已完成、未开始或未知。外层不会重新执行内层已经完成的业务。
- 查询失败任务得到 `ok:false` 业务数据时，只要 native 结果没有 isError，该查询仍成功，响应和审计均按操作成功记录。

## TDD 证据

所有行为性修复先记录有效 RED，再最小实现和 GREEN。fixture/typecheck 错误与环境失败不计入 RED。

| 回归                   | 有效 RED                                                                                 | 最终 GREEN                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 连接失效及并发退休     | 13 项中 3 失败：空闲 stdio 失效仍非永久、Not connected 非永久、HTTP 退休取消另一在途调用 | 新增真实 transport 文件 7/7；Client 分类及相邻回归一起 31/31 |
| 旧目录晚完成回写       | 新连接第二代 tools/list 应 1 次、实际 2 次，旧 discovery 污染当前缓存                    | 当前实例/关闭状态保护后通过                                  |
| 初始化关闭交接竞态     | 真 SDK initialized notification 内关闭后 connect 应 reject，实际 resolve undefined       | 真 SDK InMemory 补充回归及 Client 文件 9/9                   |
| 真实 SDK peer fault    | 初轮 24 项中 15 失败、9 通过，类别、执行状态、来源及嵌套审计失败按预期断言失败           | 扩展到所有 12 类别及保守处理后 37/37                         |
| peer source 没有 trace | 37 项中新增用例 1 失败、36 通过，审计未关联 peer trace                                   | fallback 后 37/37                                            |

本轮新增 46 项：真实连接生命周期 7、peer fault 37、错误分类 1、初始化关闭 1。原基线 52 文件/342 测试；本轮最终 **54 文件/388 测试全部通过**。

持久回归：

- [真实 stdio/HTTP 生命周期回归](../../../packages/gateway/test/idle-connection-recovery.test.ts) 与 [stdio SDK 子进程 fixture](../../../packages/gateway/test/fixtures/stdio-lifecycle-server.mjs)。
- [真实 SDK peer fault 端到端回归](../../../packages/gateway/test/peer-fault-regressions.test.ts)。
- [错误分类回归](../../../packages/mcp-client/test/errors-classify.test.ts) 与 [Client 关闭交接回归](../../../packages/mcp-client/test/overall-review-regressions.test.ts)。

RED 日志：`/private/tmp/ai-mcp-idle-red.log`、`ai-mcp-idle-catalog-red.log`、`ai-mcp-handshake-close-red.log`、`ai-mcp-peer-fault-red.log`、`ai-mcp-peer-fault-source-red.log`（均在 `/private/tmp`）。GREEN 日志：`/private/tmp/ai-mcp-idle-green.log`、`ai-mcp-peer-fault-gateway-green.log`。临时日志可能被系统清理，仓库中的测试可重复运行。

## 真实传输验收

| 场景                  | 实际传输与断言                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stdio 空闲退出        | 真实 Node 子进程和 SDK Stdio transport；成功调用后对 PID 发 SIGTERM，等待实际关闭事件；下一独立调用第二代成功，第一代目录不复用，恰好执行 2 次、启动 2 次，旧 PID 为空，旧 Client 被关闭；close 后调用/发现拒绝且无第三次启动        |
| stdio 已执行后退出    | 子进程先向 JSONL 写执行记录再退出且不响应；该调用失败后执行记录仍只有 1 条，下一独立调用成功后总共 2 条，不自动重放                                                                                                                  |
| HTTP 空闲会话过期     | 真 TCP + SDK StreamableHTTP transport；peer 关闭旧 session，后续请求收到 404 后退休 Client；不重试该调用，下一独立操作第二代成功，执行 2 次，旧实例被关闭，服务 close 后 session 为 0，无新初始化                                    |
| HTTP 执行后断 socket  | 真 TCP tools/call 已进入业务计数后销毁该请求 socket；原调用失败、执行仍为 1，下一独立调用成功后为 2                                                                                                                                  |
| HTTP 并发与目录       | barrier 保持旧 Client 的健康调用/发现仍在途，另请求 503 后新 Client 独立成功；旧健康调用也成功，tools/call 请求恰为 3、进入 SDK 业务 handler 恰为 2；旧目录晚完成不覆盖第二代，第二代发现恰为 1 次                                   |
| HTTP 关闭退休资源     | 健康调用在退休 Client 上仍挂起时 close，当前和退休 Client 全部失效，调用取消；后续操作拒绝，无第三代连接                                                                                                                             |
| peer fault 完整链路   | HTTP peer 使用真 TCP SDK 错误响应，经过 Client → HttpConnector → Gateway → 上游 SDK error；检查最终类别/状态/本地身份/来源、审计字段和执行次数。StdioConnector 错误传播采用真实 SDK InMemory seam，真实子进程验收来自上述生命周期组  |
| 嵌套 Gateway 审计失败 | leaf 的真实 HTTP peer → 内层 Gateway；内外 Gateway 间也是实际 HTTP TCP。业务执行恰 1 次后内层 auditStore 拒绝，外层 SDK error 仍 audit_unavailable + completed + operationCompleted=true，本地 invocation 不被内层覆盖，外层审计一致 |
| 失败任务查询          | 真实 HTTP SDK native 查询返回失败任务数据，Gateway isError=false、查询外壳 ok=true，审计 outcome=success                                                                                                                             |

没有用直接注入 `DownstreamConnectorError` 代替本轮 peer 错误传播测试。

## 最终门禁与环境

本机 macOS arm64，**Node v24.4.1、实际 pnpm 10.32.1、SDK 1.27.1**。仓库声明 pnpm 9.12.0，默认 pnpm 会尝试自动安装该版本，因无安装授权及沙箱限制未执行成功；本轮只运行已有版本，没有安装或修改配置。

每条命令前加 `npm_config_manage_package_manager_versions=false`。根脚本中的嵌套 pnpm 会再次尝试版本管理，因此 lint/typecheck/build 直接执行根脚本等价的 recursive 命令；测试和 e2e 使用原根脚本。

| 实际命令                       | 结果                  | 完整日志                                        |
| ------------------------------ | --------------------- | ----------------------------------------------- |
| `pnpm -r lint`                 | PASS                  | `/private/tmp/ai-mcp-foundation-lint.log`       |
| `pnpm -r typecheck`            | PASS                  | `/private/tmp/ai-mcp-foundation-typecheck.log`  |
| `pnpm test:coverage`           | 54 文件、388/388 PASS | `/private/tmp/ai-mcp-foundation-coverage.log`   |
| `pnpm -r build`                | PASS                  | `/private/tmp/ai-mcp-foundation-build.log`      |
| `pnpm test:e2e:gateway`        | PASS                  | `/private/tmp/ai-mcp-foundation-e2e-basic.log`  |
| `pnpm test:e2e:gateway:http`   | PASS                  | `/private/tmp/ai-mcp-foundation-e2e-http.log`   |
| `pnpm test:e2e:gateway:matrix` | PASS                  | `/private/tmp/ai-mcp-foundation-e2e-matrix.log` |

最终覆盖率：statements/lines **88.23%**、branches **84.60%**、functions **96.62%**。`vitest.config.ts` 与 HEAD 完全一致，包含范围、排除项和四项 80% 门槛未改。`git diff --check` 通过。

## 自查、独立复核与边界

主代理完成连接实现、完整调用链自查和根级全部门禁；独立 `code_implementer` 负责错误传播的有界并行实现，另 `code_reviewer` 只读复核生命周期和 peer fault 风险。Reviewer 独立确认并复验初始化关闭竞态修复，相关 5 文件 74/74；限定范围没有剩余确认缺陷。全量门禁和 e2e 由主代理运行，作者自查与独立审阅不混称。

- 真 HTTP 和真 stdio 均为本机 loopback/子进程验证；没有远程部署、Ubuntu/GitHub Actions、外部生产后端或第三方 Host 验收。
- 本轮实际仅 Node24 + pnpm10；历史报告的 Node20/22 + pnpm9 结果保留为历史证据，没有宣称本轮再次通过这些版本。
- HTTP SDK 不会把所有空闲 SSE/socket 结束立即报告为整个协议连接关闭；session 失效可能在下一请求的 404 才被发现。该请求保持失败且不重放，再下一次独立操作可以恢复。stdio 的实际关闭事件可使下一独立调用直接换实例成功。
- 不自动重放任何已提交业务；执行状态缺乏有效 peer 证据时继续 unknown。非协作业务不能靠本地关闭保证远端强制终止。
- 所有改动等待用户 Review，构建/脚本通过不代表 Git 集成或发布完成。

## 后续提交授权（2026-10-08）

用户在修复交付后明确要求“review 下，没问题就 commit、push”。前文的未提交和等待 Review 描述修复交付时的状态；本次新授权允许在提交前复核通过后提交并推送，实际结果以 Git 记录和交付回复为准。

提交前重新检查：本地 HEAD 和远端 main 都是 cec9f97，14 个变更文件均属于本次修复，没有其他新增改动。主代理重新检查完整生命周期及最终 diff，独立 Reviewer 复核错误传播；验证仍对应当前源码，包含 54 文件/388 项测试和全部七项门禁。安装、全局配置修改、部署、SDK v2、Agent Bridge 和 PR 均未纳入这次授权。
