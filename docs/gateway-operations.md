# Gateway Operations Runbook

Status: v1  
Last updated: 2026-03-02

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
2. Backend endpoint connectivity (`curl http://backend/mcp` for basic reachability).
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
