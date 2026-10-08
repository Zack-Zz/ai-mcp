# Gateway Operations Runbook

Status: v1  
Last updated: 2026-03-02

Source review note (2026-10-01, main@8dad112): the existing implementation still needs schema forwarding, error-semantics, HTTP ownership, and cleanup work. The proposed [architecture](./superpowers/specs/2026-10-01-mcp-foundation-architecture.md), [detailed refactoring design](./superpowers/specs/2026-10-01-mcp-foundation-refactoring-detail.md), and [plan](./superpowers/plans/2026-10-01-mcp-foundation-implementation-plan.md) are pending approval. The -320xx gateway meanings below describe the legacy path; they must not be reused on the 2026-07-28 protocol. This note is a source review, not a deployment or runtime verification record.

## 1. Deployment

### 1.1 Build

```bash
pnpm install
pnpm build
```

### 1.2 Start (HTTP upstream)

```bash
node packages/gateway/dist/cli.js \
  --config examples/gateway-basic/gateway-config-http.json \
  --transport http \
  --port 4000
```

### 1.3 Start (stdio upstream)

```bash
node packages/gateway/dist/cli.js \
  --config examples/gateway-basic/gateway-config.json \
  --transport stdio
```

### 1.4 Runtime override flags

- `--tenantId`: override tenant id from config.
- `--allowLegacyHttpSse`: enable/disable `2024-11-05` protocol compatibility.
- `--auditFilePath`: override JSONL audit path.
- `--auditHashSecret`: override HMAC secret for `inputHash`.

## 2. SLO and Alert Suggestions

### 2.1 Suggested SLOs

- Availability: `>= 99.9%` successful MCP request completion per rolling 30 days.
- Latency:
  - `tools/list` P95 `< 300ms`
  - `tools/call` P95 `< 1500ms`
- Error budget split:
  - Gateway internal errors (`-32603`) `< 0.1%`
  - Backend unavailable (`-32030`) `< 0.5%`
  - Backend timeout (`-32040`) `< 0.5%`

### 2.2 Alert rules

- Critical:
  - `5xx` ratio > `2%` for 5 minutes
  - `-32030` ratio > `3%` for 5 minutes
- Warning:
  - `-32010` ratio > `10%` for 10 minutes (indicates aggressive client traffic)
  - `tools/call` P95 > `2s` for 10 minutes
- Audit pipeline:
  - audit file write failures > `0` for 1 minute
  - no audit events for expected active tenants > 15 minutes

## 3. Failure Handling

### 3.1 Symptom: `-32030 backend_unavailable`

Check:

1. Backend process/container health.
2. Backend endpoint connectivity and its documented health endpoint (this project's server uses `/health`). GET `/mcp` is MCP traffic, not a health check. Use an actual MCP client list/call to verify the protocol and tool path; health HTTP 200 alone is insufficient.
3. Gateway backend config (`id`, `transport`, `endpoint` or stdio `command`).

Actions:

1. Recover backend.
2. Rollback recent endpoint/config changes.
3. If only one backend is impacted, temporarily remove it from config and restart gateway.

### 3.2 Symptom: `-32040 backend_timeout`

Check:

1. Backend latency and resource saturation.
2. Timeout settings (`timeoutMs` in backend config).
3. Tool-level heavy operations or deadlocks.

Actions:

1. Increase backend capacity / scale out.
2. Tune `timeoutMs` conservatively.
3. Add backend-side profiling for slow tools.

### 3.3 Symptom: frequent `-32010 rate_limited`

Check:

1. `policy.rateLimit` settings.
2. Traffic bursts from one tenant/tool.
3. Retry loops in upstream host agent.

Actions:

1. Adjust per-tenant limits.
2. Add jitter/backoff client-side.
3. Move noisy tenant to isolated gateway instance if necessary.

### 3.4 Symptom: protocol handshake errors (HTTP 400)

Check:

1. `mcp-protocol-version` request header.
2. Gateway `allowLegacyHttpSse` flag for `2024-11-05`.

Actions:

1. Prefer `2025-11-25`.
2. Keep `2025-03-26` as fallback.
3. Enable legacy only for temporary compatibility windows.

## 4. Regression and Release Checklist

Before release:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test:coverage`
4. `pnpm build`
5. `pnpm test:e2e:gateway`
6. `pnpm test:e2e:gateway:http`
7. `pnpm test:e2e:gateway:matrix`

Rollback baseline:

1. Revert gateway package + config changes.
2. Restart gateway with previous known-good config.
3. Validate with `test:e2e:gateway` smoke path before reopening traffic.

## P0 运行行为补充（2026-10-01 实施后）

- 会话模式：Gateway HTTP 默认 stateful；配置 `httpSession.sessionMode: "stateless"` 或 CLI `--sessionMode stateless` 切换。MCP Server 默认 stateless。会话上限默认 256，空闲回收默认 15 分钟，均可配置。
- 结果契约：下游未声明契约且带 outputSchema 的工具会在启动时报 `RESULT_CONTRACT_AMBIGUOUS`；通过 backend `resultContract` 或 `resultContracts.toolOverrides` 显式声明解决。
- 错误码：`-32010` 限流、`-32020` 策略拒绝（含隐藏工具调用）、`-32030` 下游不可用、`-32040` 下游超时，`data` 携带 `category`/`projectCode`/`traceId`/`invocationId`；审计失败为 `-32603` + `category: audit_unavailable` + `operationCompleted`。
- 审计：JSONL 为有界串行队列（默认 1024 待写），每行完整 JSON；关闭时 flush；写失败不再重放工具。
- 关闭：SIGTERM/SIGINT 停止新请求（503），关闭全部会话与下游连接器后释放端口；重复关闭无副作用。
- 协议版本：initialize 请求体与后续 header 都会校验；`2024-11-05` 默认拒绝，需 `--allowLegacyHttpSse true`。

### 2026-10-02 P0 审阅返修

`standard/v1` 的原始 outputSchema 描述完整 envelope，Gateway 直接公开该结构并校验整个成功结果；native-json/v1 才生成包装视图 W(S)。闭合 schema 不允许增加身份字段时，结果正文保持原样，身份位于 MCP result.\_meta。

HTTP body 超限明确返回 413，JSON null 初始化返回 400。服务关闭会立即停止接入，终止协议实例，在 `shutdownGraceMs`（默认 5000ms）内清理残留 socket，并等待终态审计写入、关闭服务拥有的 AuditStore。注入的 AuditStore 如实现可选 `close()`，其生命周期由 Gateway 管理；不实现时应在调用方完成其自身 flush。审计写失败里的 operationCompleted 取 true/false/null，分别表示已完成/未开始/未知，禁止据此重放已提交业务调用。

所有调用仍遵循既有 Server stateless/Gateway stateful 默认值、旧 CLI 参数和 echo/time 返回层级。实际验收及兼容修正见 [P0 返修报告](superpowers/reviews/2026-10-02-mcp-p0-repair-report.md)。

### 2026-10-03 整体 Review 返修

公开 metadata 的 `org.ai-mcp/result-contract` 表示 Gateway 实际返回的 standard/v1；下游生效模式和原 descriptor 位于 `org.ai-mcp/downstream-tool`。来源 descriptor 内保留前一层的 metadata，不另复制同一链。CLI/SDK 的 echo/time、外壳及参数不变，必要修正为显式 legacy-auto 覆盖与公开 contract 准确声明。

发现只有明确 MethodNotFound 可以兼容直接调用；普通内部错误、typed无效结果不能降级为无校验目录。stateful body 读取归会话所有，TTL 跳过活动读取，DELETE 结束对应请求；服务停止和初始化交接须复核终态。调用 deadline 覆盖 middleware 前后与 legacy/native 入口；审计采用实际 initialize 响应协商值，两模式统一版本策略。

验收与独立复审结果见 [整体 Review 返修报告](superpowers/reviews/2026-10-03-mcp-overall-review-repair-report.md)。

### 2026-10-08 底座缺陷修复

下游 stdio 空闲退出会使 Client 失效，下一独立操作重新启动后端并刷新目录；HTTP session 失效在请求中被发现后退休旧实例，后续独立操作建立新连接。已发出的 tools/call 不自动重放。退休等待已接收的并发操作，服务关闭仍关闭并等待所有所属实例；旧发现结果不会回写替换后的缓存。

完整且经过校验的 MCP peer fault 保留类别、执行状态及来源，本次 trace/invocation 身份保持本地生成，远端关联保存于 details.peerFault。内层 Gateway 审计失败可向外层传播 audit_unavailable 和 operationCompleted；不完整或矛盾错误保持 unknown。查询失败任务的业务状态不改变查询操作成功语义。

本轮 main@cec9f97 的 TDD、真实 stdio/HTTP 证据、54 文件/388 项测试和七项门禁见 [本轮修复记录](superpowers/reviews/2026-10-08-mcp-foundation-defect-repair-report.md)。前面的报告保留其历史日期和验收边界。
