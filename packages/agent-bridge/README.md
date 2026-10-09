# Agent Bridge

`@ai-mcp/agent-bridge` 是 ai-mcp 的独立能力模块。统一 CLI、MCP 和 TypeScript
客户端连接同一个本地任务服务，适配 Claude Code、ZCode、Codex 的独立原生
会话。服务保存任务、精确 session ID、运行日志、工作区基线和交付产物。
ai-code 的 `ai-agent-delegation` 插件负责明确派发、交接与结果验收。

版本：0.1.0 候选。Node >=22.16；本轮实际验证 macOS。普通开发仍沿用当前
会话/原生子代理。仅在用户明确交给其他工具或另一个独立会话时派发。
[设计](../../docs/modules/agent-bridge.md)与[实现证据](../../docs/reviews/2026-10-08-agent-bridge-implementation.md)
分别记录契约和验证边界。

## 构建与受控配置

在仓库根目录执行 `pnpm --filter @ai-mcp/agent-bridge build`。构建后可通过
`node packages/agent-bridge/dist/cli.js --help` 使用；不需要安装系统服务。
发布/安装本包与修改用户全局配置需要单独的用户指令。

配置文件须属于当前用户、权限 0600、非符号链接。stateRoot 使用代码仓库
之外的私有目录（0700），保存任务后保持该目录以便续接。项目和引擎由这份
配置登记，任务输入不能提供任意 executor、提升角色、换账号或覆盖模型。

```json
{
  "schemaVersion": 1,
  "stateRoot": "/absolute/private/bridge-state",
  "defaultCallerRef": "codex-origin",
  "projects": [
    {
      "id": "sample",
      "repoRoot": "/absolute/project",
      "permissionProfile": "workspace-write",
      "verifications": [
        {
          "id": "unit",
          "command": "node",
          "args": ["--test", "test/unit.test.mjs"]
        }
      ]
    }
  ],
  "engines": {
    "claude-code": { "command": "/absolute/path/to/claude" },
    "codex": { "command": "/absolute/path/to/codex" },
    "zcode": { "command": "node", "args": ["/absolute/path/to/zcode.cjs"] }
  },
  "clients": [
    {
      "id": "codex-origin",
      "role": "controller",
      "engine": "codex",
      "sessionId": "trusted-origin-session-id"
    }
  ]
}
```

原生 command 路径是受控配置。args 仅供绝对路径 launcher 前缀（如 ZCode
的 Node 脚本）；不接受覆盖 driver 权限的 CLI flags。原生认证/模型配置沿用
现有工具。不同宿主应使用各自准确、已登记的 callerRef 与 session 绑定。
文件中的 scopeReference、独立会话 flag 或 approved 标记不证明人类授权。

Codex 默认使用其公开 `app-server --listen stdio://` 会话接口；这是一条
JSON-RPC 原生执行通路，与 Bridge 对外的 MCP 入口分别运行。配置省略
`codexTransport` 时归一为 `app-server`；需要原 `exec` 路径时在 codex
引擎配置中显式设置 `"codexTransport": "exec"`。该字段只适用于 Codex，
配置指纹与实际能力证据区分两条通路，不继承旧 exec 的运行证明。

Claude Code、ZCode 的官方与第三方模型均可；Bridge 不维护模型白名单。
例如 GLM-5.3、GLM-5.3-Flash 只是原生模型选择，不是 Bridge engine ID。
模型是否属于某品牌与原生认证、启动、续接和交付是否成功分别判断。

首次验证可由用户在受控客户端中明确配置 `allowUnverified: true`，对选定
安装版本执行限定验收任务；这是验证路径，不是请求内的权限开关。默认
自动化客户端只使用已有新建/续接与结构化事件的实际运行证据。证据按原生
版本和引擎配置绑定，不因 help/version 成功推断模型、认证或任务可用。

## CLI

CLI 自动启动/复用本地 runtime。调用结束或 MCP 断开不取消已有任务。stdout
的 `--json` 输出是单行 `agent-bridge/v1` DTO；诊断和自动 requestId 回执路径
写入 stderr。exit 0 是本次控制操作成功，failed 任务的查询仍可返回 0。

沙箱中的 CLI 客户端通过认证握手连接服务，无需 `ps` 权限。宿主仍须允许
访问私有配置、stateRoot 和唯一 IPC socket；在受限宿主里，可先在受控环境
执行 `agent-bridge runtime serve --config PATH`，再连接它。不得为此自动
关闭宿主沙箱或扩大目标任务权限。[Claude 沙箱说明](https://code.claude.com/docs/en/sandboxing)
支持按会话配置访问范围，本轮只在 macOS 验证了指定私有 socket 的连接。

IPC 的 HMAC 绑定完整运行实例与每次请求，长期 token 不进入请求帧。启动
认证共用 5 秒绝对期限；请求超时不因对端持续发送未完成数据而延长。状态
文件的 0700/0600 权限只隔离其他 UID；同一用户下能读取其他 caller 凭据
或改配置的进程仍属于信任边界，HMAC 不提供这类进程之间的权限隔离。

```sh
agent-bridge --config ./bridge.json engine list --json
agent-bridge --config ./bridge.json preflight --engine claude-code --project sample --spec-file ./task.json --json
agent-bridge --config ./bridge.json task start --engine claude-code --project sample --spec-file ./task.json --request-id handoff-1 --json
agent-bridge --config ./bridge.json task get task_UUID --json
agent-bridge --config ./bridge.json task watch task_UUID --cursor event_7 --wait-ms 30000 --json
agent-bridge --config ./bridge.json task continue task_UUID --message-file ./feedback.txt --request-id followup-1 --json
agent-bridge --config ./bridge.json artifact list --task task_UUID --json
agent-bridge --config ./bridge.json artifact read artifact_ID --task task_UUID --offset 0 --limit 16384 --json
agent-bridge --config ./bridge.json task cancel task_UUID --request-id cancel-1 --json
agent-bridge --config ./bridge.json runtime stop --request-id stop-1 --json
```

`--spec-file -`（或 `--spec-file=-`）从 stdin 读取 TaskSpec JSON，适用于
preflight/start；`--message-file -` 从 stdin 读取续接文本。输入为 UTF-8，
最多 4 MiB，仍使用同一 schema/长度限制。薄客户端使用该路径，不在源码
目录创建控制临时文件；stdin 结束后才处理控制操作，stdout 仍只有 JSON 响应。

```sh
cat /private/handoff.json | agent-bridge --config ./bridge.json preflight --engine codex --project sample --spec-file - --json
cat /private/feedback.txt | agent-bridge --config ./bridge.json task continue task_UUID --message-file - --request-id followup-1 --json
```

`task_UUID`/`artifact_ID` 替换为响应中的真实 ID；不使用最近会话。需要同引擎
独立会话时显式添加 `--independent-session`。spec-file 只放 TaskSpec：

```json
{
  "taskSpecVersion": "1",
  "objective": "修复指定函数",
  "acceptanceCriteria": ["原失败场景通过已登记的单元测试"],
  "writeScope": ["src/example.ts", "test/unit.test.mjs"],
  "constraints": ["保留其他未提交修改"],
  "contextRefs": [{ "path": "src/example.ts" }],
  "scopeReference": "original-human-request-reference",
  "verificationIds": ["unit"]
}
```

重复写请求复用同一 requestId 与原参数。自动生成 ID 的回执在发送前落盘，
按 caller 隔离，保存原始规范化请求。超时/缺失响应的确定性为 unknown，不
生成新 ID 盲重跑。继续只修原范围；项目、权限、验收契约改变时建立新任务。

## TypeScript 客户端

方法名与 CLI/MCP 的任务语义一致；输入有类型、默认字段可省略，返回业务
对象，不要求消费 SDK wire 外壳。控制连接先选择登记 caller，再调用操作。

```ts
import { BridgeClient, parseConfig } from '@ai-mcp/agent-bridge';

const client = await BridgeClient.connect(parseConfig(controlledConfig), {
  callerRef: 'codex-origin'
});
const task = await client.tasks.start({
  engine: 'claude-code',
  projectId: 'sample',
  requestId: 'handoff-1',
  taskSpec: {
    taskSpecVersion: '1',
    objective: '修复指定函数',
    acceptanceCriteria: ['限定单元测试通过'],
    writeScope: ['src/example.ts'],
    scopeReference: 'original-human-request-reference'
  }
});
const status = await client.tasks.get({ taskId: task.taskId });
const artifacts = await client.artifacts.list({ taskId: task.taskId });
```

`connect()` 默认连接已有 runtime。程序化启动由用户应用明确提供 bootstrap
回调，或先使用 CLI 启动；库不自行安装/管理系统服务。任务执行终态与用户
验收分开，产物和注册验证结果是评估依据，模型自述不代表代码已接受。

## MCP

```sh
agent-bridge mcp stdio --config ./bridge.json --caller-ref codex-origin
agent-bridge mcp http --config ./bridge.json --caller-ref codex-origin --credential-file ./http-token.json --port 7001 --json
```

stdio stdout 只承载协议，不能加 --json。HTTP 仅监听 127.0.0.1，检查 Host /
Origin 和独立 Bearer 凭据；http-token.json 为当前用户的私有 0600 文件，内容
`{"token":"64位随机十六进制值"}`。不复用 runtime caller token，不打印密钥。
关闭 MCP 门面只关闭连接；显式 runtime stop 才结束本地服务及其 owned 运行。

10 个 tool 名称带 `agent_bridge_` 前缀，静态 inputSchema、同一业务 DTO，
操作错误 `isError=true`，成功查询 failed 任务 `isError=false`。使用官方 SDK
v2 factory，目前验证协议 `2026-07-28`，legacy 明确拒绝。既有 v1 Gateway
和各原生宿主 MCP 接入须另行验证/迁移，本包不会据 SDK 测试宣称它们通过。
本机 Codex 0.162.0-alpha.2 的实际 MCP 握手仍请求旧协议，当前不能接入
此 MCP 入口；CLI/API 不受该握手影响。不通过自动降级改变已确认协议。

## 会话、工作区与能力差异

- 默认 isolated，从明确 Git HEAD 建立独立 worktree；dirty 原仓库起点拒绝。
  existing 必须显式选择，并记录原有修改。未删除用户文件、不自动 Git 交付。
- 原生事件/结果持久化；重复 requestId 只登记一次。未知启动进入
  recovery_required，不自动重放。已确认未启动或完整停止证据成立时，
  显式 cancel/continue 可保留原文件状态并安全恢复。app-server 输出未关闭
  时，即使进程组消失也不能认定停止；记录 `executionStopped: false`，
  保留工作区租约，不抓取交付、不运行注册验证。服务重启或取消也不清除
  此隔离状态；不能仅凭 PID 消失批准另一写任务。
  app-server 在启动前持久化 `terminationProofRequired:true`；若服务在
  outcome 落盘前崩溃，缺失停止证明也保持隔离，不从进程消失推导安全。
- 同工作区只允许一个活动/未解决任务。终态先确认 owned process group
  退出；app-server 还核对 leader 退出、输出关闭与可信进程所有权。
  未确认保留租约。写范围为事后检测 `detect_only`，cwd 本身不是沙箱。
- Claude 2.1.177：真实新建、准确续接、限定写入、只读工具限制和取消已有证据。
  实测写入缺少要求的末尾换行，说明原生 completed 仍须按验收条件核对。
- Codex App CLI 0.162.0-alpha.2：workspace-write 的新建/续接及读写已有证据。
  原生 read-only 的 apply_patch 实际写入，Bridge **拒绝此只读模式启动**。
  系统 CLI 0.154.0 在先前验证时默认模型返回 HTTP 400，不能替换两个安装版本的结论。
  旧 exec 两次同工具场景残留原生 Git 子进程，原 failed/unknown 保留。
  新默认 app-server 已实测独立新建、服务重启后准确续接及工具执行期间
  取消，停止确认均成立；该轮期间全局配置哈希变化，完整环境绑定验收
  未通过，不据此填写正式 host acceptance。
- ZCode 0.16.9：当前 standalone 账户路径未接入桌面 start-plan JWT/Bearer，
  existing individual 索引也缺失。前次 API-key 转换不符合 start-plan 的
  原生语义，签名失败不能证明桌面 credential 不可用。失败任务持久化/幂等
  已验证；公开 CLI 参数的适配已实现，未发现可编程接入桌面账户会话的
  公开接口。当前入口的成功执行与续接仍未验证，限制不按模型品牌归类。

桌面可见/桌面会话控制、Windows、三宿主插件完整闭环和正式发布均未据此
验收完成。当前状态见实现证据；真实宿主测试不能由 fixture 或包构建推导。

[最新跨工具记录](../../docs/reviews/2026-10-09-native-cross-agent-and-stdin.md)
保存真实 Codex→Claude（glm-5.3）新候选闭环、stdin 输入及具体终态边界。
[开发收口记录](../../docs/reviews/2026-10-09-agent-bridge-development-delivery.md)
记录本轮源码 review、最终工程验证和外部宿主限制。
