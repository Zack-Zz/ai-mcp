# gateway-basic

Run from repo root in two terminals.

Terminal 1:

```bash
pnpm build
pnpm --filter @ai-mcp/example-gateway-basic gateway:http
```

Terminal 2:

```bash
pnpm --filter @ai-mcp/example-gateway-basic client:call
```
