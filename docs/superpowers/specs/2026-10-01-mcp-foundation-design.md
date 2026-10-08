# ai-mcp 通用 MCP 底座设计

状态：待用户审阅；未授权实施。日期：2026-10-01（Asia/Shanghai）。

调查基线：`main`，`8dad112cb633bffbdc7ae893b7efc87acbb958a1`。本文与同日期的实施路线配套，批准前不编写产品代码或测试，不安装依赖，不执行 Git 写操作。

本轮补充当前成熟架构后，新增 [架构设计](./2026-10-01-mcp-foundation-architecture.md) 与 [详细改造设计](./2026-10-01-mcp-foundation-refactoring-detail.md)。本稿侧重现状与 P0；两份新增文档进一步确定版本无关内核、模块接口和 SDK v2/2026-07-28 的 P1 迁移边界。具体 SDK 类不得穿入 shared 运行契约；现代协议支持需另行确认，不把本稿的旧会话/取消规则推广到新协议。

## 1. 目标、范围与调查边界

本阶段让业务工具可以通过 ai-mcp 注册、发现、校验、调用和聚合，同时保证错误语义、HTTP 会话隔离与现有调用兼容。成功的标准是实际协议调用与资源生命周期正确，不是接口存在或 HTTP 200。

已有 [协作设计稿](/Users/zhouze/Documents/git-projects/ai-mcp/docs/superpowers/specs/2026-09-30-agent-collaboration-design.md) 仅作后续需求背景；保留原文。其执行器、Task 状态机、开发/自审/返修/验收流程、skill、插件、聊天唤醒、模型/供应商/账号管理均不进入本阶段。本阶段传递 taskId/runId，不创建任务执行系统。

调查读取了祖先目录及仓库范围的规则位置，没有找到适用的 AGENTS.md 或本地 .agents/.codex 规则文件；`.gitignore` 虽忽略这些名称，但调查包含被忽略文件。项目贡献约定见 [CONTRIBUTING.md](/Users/zhouze/Documents/git-projects/ai-mcp/CONTRIBUTING.md:3)，TypeScript 开启 strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes，ESLint 禁止显式 any。用户本轮给出的先设计、再确认、TDD、独立审阅和分项 Git 授权规则优先。

开始时仅有未跟踪文件 `docs/superpowers/specs/2026-09-30-agent-collaboration-design.md`；没有已跟踪文件的暂存或未暂存 diff。HEAD 与本地 origin/main 引用相同，未执行 fetch，不能据此保证远端此刻没有新提交。未切换分支或创建 worktree。

本地 Node 为 22.16.0、pnpm 为 9.12.0；CI 使用 Node 20。已安装及锁文件的 MCP SDK 为 1.27.1，Server/Client 的依赖范围仍为 `^1.17.5`，Gateway 为 `^1.27.1`。本轮只阅读源码、SDK 源码、测试和脚本，没有运行项目测试、构建、服务或真实客户端。

## 2. 当前已有能力

| 已有能力                         | 当前源码证据                                                                                                                                                                                                                                   | 能力边界                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 统一结果、错误与产物引用         | [shared/types.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/shared/src/types.ts:34)、[error.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/shared/src/error.ts:4)                                                         | StandardToolResult、ArtifactRef、RunContext、StepContext 已存在；不是运行状态存储或产物服务 |
| 官方 SDK Server 注册与校验       | [server.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:80)                                                                                                                                                  | 原生路径使用注册 schema，输出也校验；工具名称与兼容路径仍受 demo 类型限制                   |
| 官方 SDK Client、三种传输与 CLI  | [client.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/src/client.ts:124)、[cli.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/src/cli.ts:20)                                                        | CLI 实际能发送动态名字，但靠断言绕过 echo/time 静态约束；不代表通用 SDK 契约已正确          |
| 工具聚合与路由                   | [gateway-core.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-core.ts:36)                                                                                                                                         | 已有 backend\_\_tool 与冲突检查；未保留完整 descriptor，未消费所有列表分页                  |
| 风险、条件策略、限流与目录元数据 | [policy.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/policy.ts:38)、[capability-registry.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/capability-registry.ts:24)                               | 不能继续标成“未实现”；requiredPermissions 是元数据，不等于已实现用户权限系统                |
| 内存/JSONL 审计与输入 HMAC       | [audit-jsonl.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/audit-jsonl.ts:5)、[gateway-server.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:88)                                | 有持久化与摘要；调用级身份、结果 outcome 和 trace 关联有缺口                                |
| 质量门禁                         | [package.json](/Users/zhouze/Documents/git-projects/ai-mcp/package.json:6)、[vitest.config.ts](/Users/zhouze/Documents/git-projects/ai-mcp/vitest.config.ts:15)、[CI](/Users/zhouze/Documents/git-projects/ai-mcp/.github/workflows/ci.yml:20) | 七个要求的命令均存在；覆盖率门槛 80%，排除了 CLI 与部分旧 transport，不能代替协议验收       |

## 3. 确定问题与首次产生位置

以下“确定”指源码行为或结构可以直接证实，不代表本轮已运行复现。

| 编号 | 确定问题及影响                                                                                                                            | 问题首次产生位置 / 相邻调用证据                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01  | 工具名、输入输出映射和旧 RPC 绑定 echo/time；自定义名称无法通过公共类型正常注册                                                           | [shared/types.ts:87](/Users/zhouze/Documents/git-projects/ai-mcp/packages/shared/src/types.ts:87)、[Server types:17](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/types.ts:17)                                                                                                                                                                                                                                |
| F02  | handleRawRequest 使用全局 demo 输入 schema，而非注册工具的 inputSchema；同名自定义定义也会收到错误校验                                    | [server.ts:402](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:402)、[validateInput:415](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:415)                                                                                                                                                                                                                           |
| F03  | Client callTool 只提供 demo 泛型；CLI 将任意字符串断言为 echo/time，返回也没有项目层结果校验                                              | [client.ts:46](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/src/client.ts:46)、[cli.ts:63](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/src/cli.ts:63)                                                                                                                                                                                                                                         |
| F04  | Client 在 isError 前返回 structuredContent，带结构化数据的失败会变成成功返回                                                              | [client.ts:60](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/src/client.ts:60)、[迟到的错误检查:75](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/src/client.ts:75)                                                                                                                                                                                                                              |
| F05  | Connector 抹掉 inputSchema/outputSchema/annotations/\_meta；Gateway 只公开空对象 passthrough 输入                                         | [stdio.ts:33](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/stdio.ts:33)、[http.ts:27](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/http.ts:27)、[core.ts:53](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-core.ts:53)、[server.ts:79](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:79)               |
| F06  | Connector 提取 payload 前后均未读取原生 isError；只要有 structuredContent 或可读文本就可能包装成 ok:true                                  | [result.ts:4](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/result.ts:4)、[标准化:36](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/result.ts:36)、[调用点:56](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/stdio.ts:56)                                                                                                                  |
| F07  | Gateway 即使收到 StandardToolResult.ok:false，也没有返回原生 isError:true；失败审计也没有对应 outcome                                     | [gateway-server.ts:128](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:128)、[返回:156](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:156)                                                                                                                                                                                                                  |
| F08  | 普通 Server 的每个 HTTP 请求关闭共享 SDK server 的已有 transport；并发请求互相影响的所有权条件存在                                        | [server.ts:53](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:53)、[每请求连接:271](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:271)、[关闭旧连接:360](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:360)                                                                                                                           |
| F09  | Gateway 保存多个 session transport，却用一个 SDK server 在它们之间切换；切换关闭前一个会话                                                | [gateway-server.ts:198](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:198)、[切换:270](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:270)、[关闭旧连接:315](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:315)                                                                                                        |
| F10  | Gateway close 只关闭当前 SDK transport 与下游，不持有 HTTP listener 或所有 session；普通 Server 无公共 close；SSE 同样复用共享 SDK server | [gateway close:302](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:302)、[Server SSE:300](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:300)                                                                                                                                                                                                                     |
| F11  | Gateway runId 仅来自服务配置、taskId 固定 undefined；traceId 用可能跨客户端重复的 requestId，未传给下游，返回与审计可能不是同一 trace     | [gateway-server.ts:54](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:54)、[trace:86](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:86)、[补字段:400](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-server.ts:400)、[Connector 参数:44](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/stdio.ts:44) |
| F12  | Server 中间件的 next 没有包含业务执行；auditMiddleware 能在 handler 失败前记录成功                                                        | [server.ts:95](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:95)、[旧入口:238](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:238)、[middleware:426](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/server.ts:426)、[audit:33](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/src/middlewares.ts:33)                            |
| F13  | 连接阶段发生在 Connector 的 try 外；异常分类、signal 与连接超时没有覆盖整个操作；abort 被按文本当作超时                                   | [http.ts:35](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/http.ts:35)、[stdio.ts:41](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/stdio.ts:41)、[文本分类:59](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/result.ts:59)                                                                                                                |
| F14  | Connector 只读取一页工具列表；Core.close 串行遇错停止，后续连接可能没被关闭；初始化失败无统一回收                                         | [http.ts:25](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/http.ts:25)、[stdio.ts:31](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/connectors/stdio.ts:31)、[core close:104](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-core.ts:104)                                                                                                                 |
| F15  | protocolVersion 配置没从 Gateway Core 传到 Connector；Client 只在 connect 前设置 transport 版本，SDK 初始化会用 LATEST 并随后覆盖它       | [core.ts:8](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/src/gateway-core.ts:8)、[client.ts:135](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/src/client.ts:135)、[已安装 SDK Client:285](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:285)                                                                    |
| F16  | 旧设计仍把 StandardToolResult、风险策略、registry 记为缺失；README 将内部错误/旧 RPC 契约泛称成全部原生协议契约                           | [旧设计:64](/Users/zhouze/Documents/git-projects/ai-mcp/docs/ai-mcp_design_document.md:64)、[旧设计:85](/Users/zhouze/Documents/git-projects/ai-mcp/docs/ai-mcp_design_document.md:85)、[README:45](/Users/zhouze/Documents/git-projects/ai-mcp/README.zh-CN.md:45)                                                                                                                                                                  |

### 3.1 SDK 行为必须进入设计

已安装 SDK 的 [高层 tools/call handler](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:135) 捕获多数异常，返回只有文本的 isError；Gateway 抛出的数字码可能只残留在文本而非 JSON-RPC error.data。已安装 SDK 的 [Client.callTool](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:490) 在错误结果带 structuredContent 时仍尝试套成功 outputSchema，可能把原始工具失败覆盖成校验异常。其 listTools 还会替换整个 output validator cache，分页时不能依赖缓存保留此前页。

[SDK Protocol.connect](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:215) 明确要求一个 protocol 实例独占一个 transport；close 会中止该实例的所有活动请求。[HTTP transport.close](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:280) 只关客户端连接，[terminateSession](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:431) 才发送 DELETE。服务端 onsessionclosed 主要覆盖 DELETE，不能替代 transport.onclose 上的完整清理。

这些结论已由本地版本源码复核，并与 [SDK v1.27.1 官方源码](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.27.1/src/server/mcp.ts) 对照；本阶段不通过升级 SDK 来替代修复。

### 3.2 待验证风险

| 风险                                         | 目前证据边界                                                                                 | 实施后验证方式                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 双客户端竞态的具体报错、串扰与失败频率       | 所有权错误已确定，本轮未现场复现；历史症状不能当成本轮结果                                   | 两个独立 SDK Client、相同 request ID 空间、重叠调用、交错关闭       |
| session、socket、timer、stdio 子进程泄漏     | 缺少关闭路径已确定；未测量资源数量                                                           | 受控创建/销毁循环、连接/关闭计数、PID 与端口可回收                  |
| 复杂 JSON Schema 的组合、引用和方言兼容      | 尚未做运行时验证，不能直接使用默认 Ajv provider 宣称 2020-12 全支持                          | 嵌套、oneOf、$defs/$ref、draft-07、2020-12、闭合对象、错误方言      |
| 原生错误带结构化数据经 SDK 的真实表现        | Client 与 Connector 分支问题已确定；是否先被 SDK validator 拦截取决于是否已发现 outputSchema | 有/无成功 outputSchema 两组协议验证                                 |
| 审计写失败后的结果、是否重复事件             | 当前 try 内包含审计写入；无完整失败策略                                                      | 写失败时只执行一次 handler，返回带 operationCompleted 的审计错误    |
| 协议矩阵是否真的请求了指定版本               | 脚本只检查工具名和回显；SDK 覆盖版本已确定                                                   | 抓取 initialize body、response version、后续 HTTP header 与协议错误 |
| 真实第三方消费者依赖旧错误文本或自动解包行为 | 仓库内消费路径已阅读，外部调用方未知                                                         | 固定现有示例与 CLI golden response；发布明确兼容说明                |

## 4. P0 范围与方案选择

P0 是“完成本阶段必须通过”的集合，包含测试和交付文档，不仅是高优先级缺陷修复。

| 项目        | P0 必须完成                                                                                         | 后续项                                             |
| ----------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 注册        | 任意符合项目名称规则的工具、自己的 schema、重复拒绝、共享调用管线                                   | 运行时替换/卸载、跨实例通知、插件发现              |
| Client      | 完整动态发现、动态调用、原生结果保留、旧 demo API 与 CLI 兼容                                       | 自动热刷新、生成所有业务工具静态 SDK               |
| Gateway     | descriptor 与分页不丢失、参数验证、正确标准包装 outputSchema、错误语义                              | 新的结果透传模式、Resource/Prompt 聚合、alias 平台 |
| HTTP        | Server 保留 stateless 默认、Gateway 保留 stateful 默认；独立 server/transport；取消、关闭和失败回收 | 跨节点 session、事件重放、分布式连接池             |
| 上下文/审计 | 单次调用 trace/run/task 贯通，策略决定与执行结果分开                                                | Task 生命周期、Agent Runtime、全链路 exporter      |
| 工程交付    | TDD、真实双客户端、旧路径回归、七项命令、实际 diff 审阅、文档一致性                                 | OAuth、多租户平台、企业审批                        |

比较三种结果策略：

| 策略                       | 优点                                                                            | 代价与选择                                                                        |
| -------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **兼容的标准包装（采用）** | 保持 Gateway 当前 StandardToolResult 返回层级；复用 shared，错误和 trace 可统一 | 需要按实际变换生成 outputSchema，并保留原生 content；P0 完成                      |
| 全部原生透传               | 公开 schema 与下游一致，变换少                                                  | 会把现有 local\_\_echo 的外层 ok/code/message 去掉，破坏已有 Gateway 契约；不采用 |
| 同时提供包装/透传双模式    | 可分场景选用                                                                    | 增加配置、每工具模式矩阵与迁移成本；后续有真实消费者需求再设计                    |

HTTP 同样比较：复用单个 SDK server 并加串行锁不能实现连接隔离；每客户端创建完整业务服务会重复下游进程和策略状态。采用每连接创建协议实例、服务级共享业务状态，并保留原有默认模式。

## 5. 公共契约与 schema 边界

### 5.1 shared 的分工

保留 ToolName、ToolInputMap、ToolOutputMap、toolSchemas 作为 echo/time 兼容导出；新增 BuiltInToolName 等更准确的别名，不扩大枚举作为通用注册方法。旧工具列表简要类型仍保留。

旧 toolsCallRequestSchema/ToolCallParams 等导出保留原 demo 约束；新增通用 tools-call 请求 schema 和动态请求类型供 dispatcher 使用，不把原有强类型参数改成 string 后声称兼容。handleRawRequest 的通用化通过新解析器完成，旧合法请求格式和结果不变。

shared 新增版本无关的工具 descriptor、NativeToolResult、InvocationContext/Outcome、JSON object、通用工具名称、标准结果专用 schema/转换函数。原生 MCP 内容块与 wire schema 在 Server/Client 的本代 SDK adapter 验证；不能将项目内核类型直接当 raw wire 类型。原生 JSON-RPC error 的数字 code 不与项目 McpErrorShape 的字符串 code 混淆。

shared 增加 Ajv/ajv-formats 的直接依赖用于 JSON Schema 校验，不依赖 SDK 运行时；SDK 直接依赖留在 Server/Client/Gateway adapter 所属包，禁止依赖传递依赖。P0 统一当前 SDK 版本，P1 再单独迁移官方 v2；本阶段不引入模型依赖或无关包拆分。

StandardToolResult、ArtifactRef、RunContext、StepContext 继续作为内部契约；旧宽泛 schema 保留兼容导出。新协议边界使用严格的 JSON 可序列化值与官方内容块校验，不能因为旧类型有 unknown 就接收非 JSON 值、Date、循环引用、NaN 或伪造 content 块。

### 5.2 本地工具注册与类型安全

现有 `registerTool<TInput,TOutput>(ToolDefinition<TInput,TOutput>)` 调用形式保留；ToolDefinition.name 改为 string，新增可选 title/annotations/\_meta 和 `resultContract`。inputSchema/outputSchema 仍是注册者提供的 Zod schema，handler 参数由解析成功的数据提供，不能直接断言输入类型。

新增 `defineTool` 辅助推断 schema 与 handler 的输入输出类型。名称采用大小写敏感、1–128 字符、ASCII 字母/数字/下划线/连字符/点的规则；这是项目支持规则，依据 MCP 的名称建议，不宣称是所有 MCP 实现的强制限制。Gateway 最终 publicName 同样验证，过长不截断，backend ID 唯一且路由按保存的二元键查找，不按分隔符反向猜测。

异构 registry 保存的是类型擦除后的闭包 `invoke(input: unknown, context): Promise<ValidatedInvocation>`，闭包在注册时捕获具体 schema 和 handler。闭包内依次解析输入、运行 handler、解析输出、验证 JSON 对象；handler 使用解析所得的 TInput，返回值通过真实 schema 得到 TOutput。Map 不保存 `ToolDefinition<unknown,unknown>` 再强转。unknown 只留在外部边界与异构分发边界，不能当成免校验通行证。

注册时生成对应 wire JSON Schema，明确 input/output 的导出方向。输入与结构化输出的根为 JSON 对象，数组/标量可作为具名字段。不能导出的 transform/custom schema 或非 JSON 输出在注册阶段明确拒绝；不生成空对象代替。可表达的普通约束正常导出，业务额外约束仍执行并写进描述。Zod 默认 stripping 等既有行为保持，但 Gateway 的第三方 JSON Schema 验证不修改参数。

工具注册在服务开始接入前完成，启动时冻结 immutable snapshot。重复注册、非法名称及启动后变更给明确错误；后者是需要说明的生命周期收敛。Core 的 refreshTools 仍可构建新快照，服务侧 initialize 幂等，本期不提供活动 session 热替换。Resource/Prompt 的名称与行为保留，受同一协议实例工厂重新绑定，暂不通用化它们。

### 5.3 统一调用管线

`原生 tools/call / handleRawRequest → 请求格式解析 → registry 查找 → 上下文解析 → middleware(ctx, terminal) → 注册 schema 输入解析 → handler → 输出解析/序列化校验 → 对应结果编码`。

legacy 入口只负责把 `{name,input}` 与 `{output}` 转换为项目兼容形式，调用相同 registry 闭包；移除按名字索引 demo schema 的依赖。请求 envelope 错误显式转换 INVALID_PARAMS，不能由 Zod 异常跌落为 INTERNAL。

middleware 的 terminal 必须包括实际校验与执行；ServerContext 增量记录 invocation outcome，auditMiddleware 在 next 返回后读取该结果，返回式工具失败也不能记录成 ok。保留 use、authMiddleware、rateLimitMiddleware、auditMiddleware 的已有调用形式。SDK 列表行为与 legacy 列表差异写清：旧列表保持简要字段，新增完整 descriptor 发现路径。

### 5.4 JSON Schema 执行规则

外部 descriptor 的 inputSchema 原样保留；有 outputSchema 时原样保留其原始版本。运行时在调用前/返回后按对应 descriptor 编译的 validator 验证，不尝试把任意 JSON Schema 逆向转换成 Zod。

P0 支持默认 2020-12 与显式 draft-07，各自使用对应 Ajv 实例；不支持的方言报 SCHEMA_UNSUPPORTED。编译时验证 schema，禁用 coerceTypes、useDefaults、removeAdditional；支持本 schema 内的 $defs/definitions/$ref 与组合。只解析本地引用，不联网取得外部 $ref；外部引用需提供自包含 schema，失败时不发布伪描述。

schema 原文保留在 descriptor；封装 payload schema 时解决引用作用域：把整个下游 schema 保留为独立资源，使用不会碰撞的合成绝对 $id 或 bundle/rebase 本地引用，不能只把含 `#/$defs/...` 的对象塞进 properties 后让它引用包装根。公开包装采用 payload 的相同方言（无显式声明则 2020-12），对应生成 draft-07 或 2020-12 的 envelope，避免混合方言；不能仅删除 $schema 假定关键字语义相同。生成的公开包装 schema 必须以独立 validator 和 SDK Client 实际消费验证；官方 SDK Client 的 JSON Schema provider 显式配置为对应方言实现，不能用缺乏 2020-12 能力的默认 provider 作为规范适配结论。

## 6. 动态 Client 与 CLI

保留 `listTools(): Promise<{name,description}[]>` 的简要输出以及 `callTool<TName extends ToolName>(name,input): Promise<ToolOutputMap[TName]>`。内置 callTool 增加运行时输入/输出校验，错误优先；成功结果及文本 JSON 兼容回退不变。

新增接口：

| 接口                                                         | 输入 / 返回                                            | 语义                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `discoverTools()`                                            | 完整 ToolDescriptor[]                                  | 消费全部分页，缓存 descriptor 与 validators；显式调用刷新，不做热更新系统                                                      |
| `callToolResult(name, arguments, options?)`                  | string、JSON object、signal/context → NativeToolResult | 通用原生语义结果 API；协议/传输错误抛分类错误，工具失败保留 isError:true，调用者须检查；版本 wire bookkeeping 留在 SDK adapter |
| `callValidatedTool(name, arguments, outputSchema, options?)` | schema 推断的 T → Promise<T>                           | 检查原生失败后解码并真实解析，业务代码获得类型保证；不提供只写泛型却不校验的接口                                               |

通用调用会在必要时发现工具，并用发现的 schema 检查输入和成功输出。未知名字不得靠扩大 echo/time 枚举通过。没有 outputSchema 的原生 content-only 结果也是合法结果，保持所有内容块；不把 image/audio/resource-only 自动当成无效。

SDK 1.27.1 的错误结果自动输出校验有覆盖语义的风险，通用通道使用官方 `request(CallToolRequest, CallToolResultSchema)`，由项目统一执行错误优先和成功输出校验。仍复用 SDK 初始化、通知、取消、transport 和 request 生命周期；不复制 JSON-RPC 实现。

CLI 保留 tools list/call、--transport、--endpoint、--json、--protocolVersion 的名称、默认端口与 stdout `{tools}` / `{output}` 层级。内置名字用兼容调用；动态名字用新结果 API，成功优先取 structuredContent，无结构化结果时保留旧单文本 JSON 解码；一般 content-only 返回包含完整 content 的对象。失败输出 stderr 并退出非零。新增可选 `tools list --full` 展示 schema，不改变默认简要列表。

Client.close 幂等。拥有 stateful HTTP session 时先有界 terminateSession，再关闭 SDK；stateless 无 DELETE。远端不支持 DELETE 的 405 不当成本地无法关闭；服务端 TTL 回收仍负责遗留 session。close 后新调用明确拒绝，连接失败不复用损坏 transport。

### 6.1 指定协议版本的真实语义

保留 --protocolVersion，但修复它只在初始化前设置 header 的现状：通过公开 Transport 接口的薄包装把初始 initialize.params.protocolVersion 设置为指定版本，初始化结果决定后续 header。不得写 SDK 私有字段或在握手后强改 header 为未协商版本。

同一适配逻辑放在 Client 包内，供 Gateway Connector 复用（Gateway 增加对 mcp-client 的单向依赖）；Client 不依赖 Gateway。未指定时沿用 SDK 默认协商。GatewayBackend.protocolVersion 传到连接适配器；CLI 参数保持原形式。协议矩阵断言实际 body/result/header，不以业务 text 中写入版本证明协议。

## 7. Gateway schema、元数据与结果契约

### 7.1 完整 descriptor 流转

`下游 tools/list 所有页 → Connector ToolDescriptor → Core GatewayTool（publicName 与原 descriptor）→ policy/capability view → tools/list`。

保留 inputSchema、原 outputSchema、title、annotations、icons、\_meta 与 supported execution 信息；只变换名称、已有描述后缀和与包装相关的 outputSchema。原始 \_meta 不覆盖；Gateway 新信息在 `org.ai-mcp/*` 命名空间，冲突保留来源并明确拒绝不可判定冲突。配置 capability overrides 优先于已验证的下游自定义 capability 元数据，再用服务默认值。annotations 只作提示，不据此自动降低风险或重试。

本期不支持 tasks/sampling/elicitation；不宣告它们。taskSupport=required 的工具启动时明确报 UNSUPPORTED_CAPABILITY，不能对上游声称可调用；optional 可走普通调用，公开视图标成 forbidden，同时在 namespaced 源描述中保留原值。该差异属于能力边界声明，不冒充任务代理。

下游分页要检测重复 cursor、同名冲突、配置的最大页数和总发现 deadline；超过界限明确失败，不能静默截成“全部工具”。initialize 先构建/验证完整快照，失败释放已经连上的后端；不半注册。P0 沿用全成功才就绪，不新增部分后端容错目录。

### 7.2 采用兼容标准包装

保持当前 `local__echo` 的成功语义：

```json
{
  "content": [{ "type": "text", "text": "<完整 StandardToolResult JSON>" }],
  "structuredContent": {
    "ok": true,
    "code": "OK",
    "message": "Tool call succeeded",
    "structuredContent": { "text": "hello" },
    "traceId": "..."
  }
}
```

Gateway 的公开 outputSchema 必须描述上面的**外层 StandardToolResult**，下游 echo 的 `{text}` schema 只能约束它内部的 structuredContent，不能直接发布为工具 outputSchema。外层字段名与已有成功层级保持。

下游协议结果先完整保留，再解码；新增 resultContract（本地注册字段/descriptor `_meta['org.ai-mcp/result-contract']`），值为 `native-json/v1` 或 `standard/v1`。Gateway 可按 backend/tool 配置 override，优先级为显式配置、descriptor 声明、旧兼容识别。新本地普通工具默认声明 native-json/v1；标准结果工具显式声明 standard/v1，不把业务 payload 中的 ok 当成通用失败判定。

配置接口确定为 `BackendSpec.resultContract?: 'native-json/v1' | 'standard/v1' | 'legacy-auto'`，以及 `GatewayServerOptions.resultContracts?: { toolOverrides?: Record<string, 'native-json/v1' | 'standard/v1'> }`（键是 publicName）。tool override 优先 backend 设置，backend 未指定时才使用 descriptor 声明，仍未指定则 legacy-auto。CLI 配置文件增加同名字段的 Zod 校验，没有新必填配置，不更名已有参数。

| 下游契约                          | 公开 outputSchema 与实际输出                                                                                                  | 兼容处理                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| native-json/v1，有成功 schema S   | StandardSuccess 的内部 structuredContent 必填且按 S 校验；StandardFailure 分支规定 ok:false/code/message，与成功 payload 分开 | 返回原有 Standard 外壳；所有原生 content 块保留在 envelope.content，并可附在外层 JSON 文本之后供原生客户端消费                                  |
| native-json/v1，没有 outputSchema | StandardSuccess 允许 JSON payload 或合法 content；不能假造具体业务 shape                                                      | 原生形状校验仍必需；无 schema 就标明未声明，不装成已校验业务字段                                                                                |
| standard/v1                       | 先严格解析 StandardToolResult，并按下游声明校验成功结果；保持已是标准结果的层级，不再次包装                                   | 使用该完整标准 schema 作为公开成功结构；统一失败由 isError 和错误契约表达                                                                       |
| 未声明的旧下游                    | 无 outputSchema 时保留旧完整标准结果识别；有 schema 时仅使用已登记的历史兼容模式                                              | 不由任意 schema 推断业务意图；其他工具需 descriptor 声明或显式 override，否则报 RESULT_CONTRACT_AMBIGUOUS。复杂 schema 在显式契约下仍受完整校验 |

没有 outputSchema 的旧兼容工具公开标准 envelope schema，内部 payload 标成 JSON 值；完整 StandardToolResult 才会解包。近似对象（例如 ok 是字符串）在 native 模式按业务 schema处理；声明 standard 的无效 envelope 是 invalid_result，不可再当普通成功包装。

标准下游有闭合 outputSchema 时，不可为了 trace/run/task 加字段而违反 schema。候选补充字段先校验：许可时维持旧补充行为；禁止时保持正文，在 MCP result.\_meta 中放本次上下文。这是对过去未校验增补的明确修正；新 shared 标准 schema 工厂默认声明这些可选字段。协议错误/工具错误若不符合该标准工具的成功 outputSchema，返回错误 content 与 `_meta`，不声称有符合成功 schema 的 structuredContent。

原 outputSchema 与 descriptor 原文保存于 Core，并通过 `_meta['org.ai-mcp/downstream-tool'].descriptor` 提供可追溯来源；该字段另含生效下游 resultContract，对外 result-contract 始终声明 standard/v1。standard 公开视图仅规范化资源 ID 与方言，保持正文层级和约束。standard 与 native 的输出生成必须分别做“用公开 schema 校验真实 structuredContent”的验证，不能只断言字段名出现。标准包装 schema 的 success/failure 区分以 ok 为准；payload 本身的失败任务状态不影响它。

### 7.3 正确结果处理顺序

1. 验证 CallToolResult 外形与 JSON 可序列化内容；保留全部 content、structuredContent、isError、\_meta。
2. **先判断原生 isError。** 为 true 时必为工具失败，不因 structuredContent 存在、ok:true 或成功 schema 拒绝而改成成功。保留原结构化错误为 diagnostics；已有标准 ok:true 与原生失败冲突时标记 conflict，失败优先。
3. 非原生失败时，根据已冻结的 resultContract 解析。standard 的 ok:false 仍转成工具失败；native 的 payload.ok:false 是业务数据。
4. 成功路径有 outputSchema 必须验证实际结构化结果；没有 structuredContent 且声明了成功 outputSchema 时是 invalid_result。错误路径不套成功 schema，但仍验证其协议外形与已声明错误封装。
5. 只有结果符合对应契约才标准化。普通合法文本可以是成功结果，畸形 content、不合法 structuredContent、声明 standard 却无效的 envelope 不能无条件 ok:true。
6. 编码 Gateway 返回：失败设置 isError:true；标准失败 structuredContent 可存在，但不会套成功 payload schema。成功查询失败任务返回 ok:true、isError:false，payload `{task:{state:'failed'}}` 原样保留。

## 8. 错误分类与完整调用链

保留项目已有 McpErrorShape 字段和四个字符串 code 的兼容性，增量增加通用分类。错误对象至少含 category、code、message、traceId；保留 downstream target、source trace 与必要 details，不把完整敏感输入作为错误日志。

| 场景                                         | 原生 MCP 表达                  | 分类 / 兼容要求                                                     |
| -------------------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| JSON 无法解析、坏 envelope、未知 method/tool | JSON-RPC error                 | 标准 -32700/-32600/-32601/-32602；data 包含 traceId/category        |
| 已知工具的业务参数校验失败                   | isError:true 工具结果          | INVALID_PARAMS；legacy 仍返回字符串 INVALID_PARAMS 的 error         |
| handler 执行失败或 standard.ok:false         | isError:true 工具结果          | TOOL_FAILED / tool_failure，结构化错误优先保留                      |
| Gateway 策略拒绝/限流                        | JSON-RPC error                 | 保留 -32020/-32010，data.category 与 traceId 完整                   |
| 下游连接失败/进程退出                        | Gateway JSON-RPC error         | 保留 -32030 / backend_unavailable；连接阶段也覆盖                   |
| 下游 deadline 到期                           | Gateway JSON-RPC error         | 保留 -32040 / backend_timeout；不能与取消混淆                       |
| 上游显式取消                                 | SDK cancellation + 传播 signal | cancelled；不伪造成业务成功或自动重试；记录审计 outcome             |
| 下游成功结果违约/协议畸形                    | JSON-RPC error                 | -32603 / invalid_result；Client 本地可见同分类                      |
| Gateway 自身异常                             | JSON-RPC error                 | -32603 / internal，含 traceId                                       |
| 审计持久化失败                               | JSON-RPC error                 | -32603 / audit_unavailable，说明 operationCompleted；不重新执行工具 |

为了保持 JSON Schema 原文和上述数字错误语义，工具 handlers 使用 SDK 公开的低层 Server request handler。普通 Server 仍可用 SdkMcpServer 的公开 `.server` 安装 tools/list 与 tools/call handlers，Resource/Prompt 保留高层注册；本期工具不再交给高层 registerTool 的 broad catch。Gateway 用低层 Server。两者均由 registry/dispatcher 驱动；没有私有 SDK 字段或第二套协议。

上述 Gateway -320xx 是现有 legacy 上游兼容映射。P1 的现代规范保留 -32020 至 -32099，不能在 modern wire 复用它们；[详细改造设计](./2026-10-01-mcp-foundation-refactoring-detail.md) 指定按 peer era 映射到合法应用码，并保留 source code/version。协议支持与错误码不能只按 SDK 包版本判断。

Client、Connector 先按阶段与 SDK/网络错误类型判断，消息文本只作最后未知错误兜底，不能因工具失败文本含“connect”“abort”“not found”就改成不可用/超时。已经分类的错误保持 category、traceId 与 cause。结构化错误和旧文本 MCP error 的呈现保持可读，外部 code 消费者使用机器字段。

Connector 连接、发现、调用都纳入 deadline 和 AbortSignal；close 时取消连接重试/backoff 与活动调用。允许既有有界连接重试，不自动重放 tools/call；stdio 连接失败清除失败状态且释放旧进程，服务关闭后不得再建立连接。

## 9. HTTP、SSE 与所有权

### 9.1 所有权矩阵

| 对象                                                               | 创建与持有者               | 关闭条件                                                    |
| ------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------- |
| 工具/Resource/Prompt 定义、中间件、Gateway policy/audit/capability | 服务实例                   | 服务整体关闭；没有客户端独占权                              |
| Gateway Core、下游 connector、stdio 子进程                         | Gateway 服务实例           | 初始化失败或 Gateway.close；单上游 session 关闭不会关闭它们 |
| 下游调用请求与 controller                                          | 单次调用                   | 完成、deadline、显式取消或该请求所属 session 终止           |
| stateful SDK server + transport                                    | 一个 session entry，一对一 | DELETE、session TTL、transport 真正关闭或服务停止           |
| stateless SDK server + transport                                   | 一个请求 entry，一对一     | 响应流真正结束或请求失败；另有服务 shutdown 回收            |
| 旧 HTTP+SSE 的 server + transport                                  | 一个 SSE session entry     | SSE session 真正关闭或服务停止                              |
| HTTP listener、会话表、临时请求表、清理 timer                      | 对应服务实例               | 服务停止时全部回收                                          |

每个协议实例从 immutable registry snapshot 绑定 handlers，一生只 connect 一次。handler 闭包调用同一个服务业务对象。下游 connector 共享并发请求由 SDK request ID 管理，但不共享上游 request ID；没有 session 关闭连带 Core.close。

### 9.2 stateful 模式

Gateway 保留 stateful 默认；普通 Server 新增可选 `sessionMode:'stateful'`。

1. 精确匹配 URL pathname 与方法，先处理 health/版本检查等不需要会话的请求。
2. 无 session 的合法 initialize 才创建新 SDK server/transport，连接成功后处理 initialize。初始化成功时登记 entry；另有 pending entries 集合保证半初始化也能回收。
3. session header 命中时始终路由到这一对实例，不 reconnect、不 close 其他 entry。未知 session 返回 404；非初始化缺 session 返回 400。重复/不合法 header 明确拒绝，不取任意一个值当身份。
4. 同 session 多个并行 POST 使用同 transport 的正常 SDK 生命周期；不同 session 实例完全独立。POST 响应 finish 或 GET stream 断开不能销毁整个 session。
5. DELETE 和真正 transport.onclose 使用同一幂等 cleanup；不能覆盖 SDK 已挂载的 callback。session TTL 处理客户端本地 close 但未 DELETE 的遗留情况。
6. 默认 idle TTL 15 分钟、maxSessions 256，可通过 StartHttpOptions/配置覆盖；活动调用期间不因 idle 过期而关掉，活动调用仍受自身 deadline。过载明确拒绝新 session，不驱逐其他活动客户端。

`StartHttpOptions` 与 `StartGatewayHttpOptions` 增量增加 `sessionMode?: 'stateful' | 'stateless'`、`sessionIdleTimeoutMs?: number`、`maxSessions?: number`。普通 Server CLI 可增量接受 --sessionMode；Gateway 配置增加 `httpSession`（上述三字段），原 --transport/--port 默认行为不变。服务关闭另有可选 shutdownGraceMs，默认 5000；不存在新必填参数。

版本校验同时覆盖 initialize 请求体与后续 header，不能只检查 header 放过 legacy initialize。由公开 transport 消息边界记录实际 InitializeResult.protocolVersion，session entry 保存该值；后续显式 header 必须与已协商版本一致，缺省 header 走现有兼容策略。HTTP JSON 只解析一次并传给 SDK transport，解析失败/禁用版本在创建 session 之前返回明确协议错误。

会话仅有协议状态；session ID 不充当 task/run/执行器 session ID。不做跨实例恢复和持久化会话。

### 9.3 stateless 模式

普通 Server 保留现有 stateless 默认；Gateway 可显式选择 stateless。每个请求创建独立 server/transport，sessionIdGenerator undefined；注册表、middleware 与 Gateway Core 仍服务级复用。

initialize、initialized notification、tools/list/call 每个 HTTP 请求都是独立协议实例；不声称支持跨请求服务端请求、重放或热通知。必须让 SDK 原有 stateless 行为在实际多次请求握手中通过验证。

不能只在 `await transport.handleRequest()` 后立刻 close：SDK 可以先建立响应流再异步完成 handler。cleanup 绑定响应 finish、异常 close 和 handler 生命周期，pending entry 有 close-once 保护；提前失败在 try/finally 回收。正常读取请求 body 导致 IncomingMessage close 不能误判取消。

stateless 独立请求连接异常可以释放该请求持有的本地 handler/下游调用；它是请求作用域资源终止，不能当成已收到 MCP 取消通知。跨 HTTP 请求的 notifications/cancelled 无法在无会话且 request ID 可跨客户端重复的模式下可靠定位原请求，本期 stateless 不承诺这一能力；其清理由本请求响应终止、deadline 和服务停止保证。需要标准跨请求取消的消费者选择 stateful。stateful 的单个网络流断开按 MCP 规则不等同取消整个请求或 session，显式 notifications/cancelled 才进行请求取消。[MCP transport 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 区分这两种语义。

### 9.4 旧 SSE、关闭与服务停止

普通 Server 的 `/sse` 与 `/sse/call` 地址及客户端兼容保留，一 SSE session 对应一 server/transport。旧自定义 transports/\* 并非当前 SDK 入口，保留文件与兼容行为，不删除或冒充原生 MCP 入口；相关 legacy handleRawRequest 仍使用统一 registry。

新增 McpServer.close 与幂等 Gateway.close，服务持有所有 listeners/entries/timers。保持 startHttp/startSse 返回 Node HTTP Server；对返回对象的公开 close 方法做本实例生命周期绑定，在等待 Node close 完成前先启动所属 entries 的清理，不能仅等 close event 后才关长连接。该 listener.close 只回收对应 listener；服务 close 才关闭整个 Core。CLI 注册 SIGINT/SIGTERM 并等待有界 cleanup，不靠进程退出自动清除子进程。

关闭顺序：标记 stopping 并停止新接入 → 对活动调用发出取消并等待最多 5 秒 → close 所有 SDK entries（包括未初始化/stateless/SSE）→ allSettled 关闭全部 connectors → 清理 timers、socket/listener 与审计待写操作。异常不阻止其他资源释放。关闭中/关闭后调用返回明确状态，重复 close 无副作用。

## 10. 上下文与审计贯通

新增 ToolInvocationContext：traceId 必填，requestId/mcpSessionId/signal/runId/taskId 可选。RunContext 不扩展成 Agent Runtime；taskId 作为调用上下文独立字段，避免复用其 sessionId 代表所有会话。

MCP 请求 `_meta['org.ai-mcp/context']` 承载经过长度/形状校验的 traceId/runId/taskId；不混入 arguments，不改变业务工具 inputSchema。traceId 未提供则生成 UUID，requestId 单独记录，不能以 requestId 当全局 trace。runId/taskId 优先单请求上下文，已有 Gateway 配置 runContext.runId 保留作默认值；actor/tenant/risk/权限仍取服务配置，不接受调用者借 `_meta` 提权。

Client options → MCP params.\_meta → Gateway context → Connector call metadata → 下游 handler context → MCP result.\_meta → Gateway AuditEvent 同一条 trace 链。第三方下游若不识别 context，Gateway 仍保持自身关联，另记 downstreamTraceId；不宣称第三方内部运行已贯通。result.\_meta 中的 context 是此次调用身份；保留的标准正文 traceId 可是下游原 trace，必须记录与此次 trace 的关联。正文中的 taskId/runId 可能描述被查询对象，不能反过来改写此次调用身份；冲突保存来源。

AuditEvent 增量增加 requestId、mcpSessionId、outcome（success/tool_error/protocol_error/cancelled）、resultCode、downstreamTraceId。保留 decision=allow/deny，其含义是策略决定，allow 与 tool_error 可以同时存在；返回 failed task 的成功查询记 success。

每次调用只记录一个终态审计，覆盖参数拒绝、策略拒绝、下游失败、取消与输出校验失败。记录 handler 在闭包实际完成后的结果；outcome 与返回一致。JSONL 单进程使用有界串行 append 队列，服务停止 flush；审计写失败返回 audit_unavailable，且标记工具是否已经执行，禁止自动重试业务操作。P0 不引入日志平台、数据库或完整 metrics 系统。

## 11. 兼容承诺与提前说明的变化

| 路径                | 保留                                                                         | 有意修正/新增                                                                            |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 直接 echo/time      | 注册默认、输入字段、成功数据、callTool 泛型与 CLI `{output}`                 | 运行时输出校验及正确错误优先                                                             |
| Gateway echo/time   | backend\_\_tool 名称、StandardToolResult 成功层级、code/message、配置覆盖    | 完整 inputSchema、包装后的 outputSchema、isError 与机器错误分类                          |
| 旧 in-memory RPC    | `{id,method,params:{name,input}}` / `{id,result:{output}}`、原字符串错误字段 | 允许通用名字，使用工具自带 schema，参数异常分类准确                                      |
| stdio/http/sse 示例 | 命令参数、默认端口和 endpoint、旧 SSE 参数正规化                             | 多客户端不互相关闭，关闭资源可观测                                                       |
| 旧列表 API/CLI      | 默认 name/description 简要投影                                               | discoverTools / --full 提供完整字段                                                      |
| 错误与异常          | 保留可读消息、已有数字/字符串错误码用途                                      | 过去误报成功的失败改为失败；numeric JSON-RPC code 从文本升级为机器字段                   |
| 无 schema 原生内容  | 合法文本可成功                                                               | 保留 image/audio/resource/multiple content，畸形内容明确 invalid_result                  |
| schema/生命周期     | 已有有效 echo/time 不变                                                      | 非法名字、违约输出、不支持方言、含外部引用、歧义输出契约与启动后注册会早失败；不静默放宽 |
| 标准下游 trace 补充 | schema 允许时仍补正文                                                        | 闭合 schema 禁止时上下文放 result.\_meta，不再制造违约结果                               |

仓库内已核对 examples/stdio-basic、http-sse-basic、gateway-basic 与三条 Gateway e2e 的消费方式；没有证据证明仓库外所有调用方已适配。审批时需连同上述必要行为修正一起确认。

## 12. 验收标准与证据分层

### 12.1 失败测试与必验行为

| 验收编号 | 必须证明的行为                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A01      | 至少一个非 echo/time 工具正常注册、完整发现、直接调用与经 Gateway 调用；无需扩充枚举或断言                                       |
| A02      | 自定义必填/嵌套/枚举/额外属性约束生效；失败输入不执行 handler；错误输出拒绝；legacy/native 一致                                  |
| A03      | Gateway inputSchema 与下游语义一致；生成的公开 outputSchema 能独立校验真实包装结果，包括闭合对象与引用作用域                     |
| A04      | isError:true + structuredContent 在 Client/stdio Connector/HTTP Connector/Gateway 均失败；与成功 schema 不符时仍保留原始工具失败 |
| A05      | 标准 ok:false、native payload.ok:false、成功查询 failed task 三者正确区分；错误和审计 outcome 对应                               |
| A06      | 超时、连接失败、下游进程退出、畸形结果、缺失声明的 structuredContent、取消、审计写失败分类准确，工具不被重放                     |
| A07      | 两个独立 HTTP SDK Client 同时初始化、发现与重叠调用；各自结果对应 marker；关闭 A 时 B 的活动及后续调用都成功                     |
| A08      | 对 Server 默认 stateless、可选 stateful、Gateway 默认 stateful、可选 stateless 均运行 A07；同 session 并发也验证                 |
| A09      | DELETE、客户端本地关闭后的 TTL、初始化失败、服务关闭、异常连接、取消都回收所属资源；B 或共享下游不被 A 关闭影响                  |
| A10      | 原 echo/time SDK/CLI、旧文本 JSON fallback、Resource/Prompt、legacy handleRawRequest、stdio 与旧 SSE 示例回归                    |
| A11      | 真正 2025-11-25/2025-03-26/开启兼容的 2024-11-05 协商与 header；关闭 legacy、未知版本、缺省路径明确                              |
| A12      | 每调用 trace/run/task 穿过 Client→Gateway→本地下游→结果→JSONL；跨客户端相同 requestId 不混审计；配置默认不污染显式上下文         |
| A13      | 分页工具完整、重复 cursor/映射冲突失败、初始化中途失败释放后端，关闭有一个 connector 失败也释放其余                              |

### 12.2 命令与报告

依次检查 `pnpm lint`、`pnpm typecheck`、`pnpm test:coverage`、`pnpm build`、`pnpm test:e2e:gateway`、`pnpm test:e2e:gateway:http`、`pnpm test:e2e:gateway:matrix`。先构建再使用 dist 的脚本；新增 HTTP 并发/schema/error 验证接入现有 HTTP e2e 命令与 CI。保持 80% 阈值，不扩大排除项掩盖新核心代码。

单元证据是可重复的错误分支与类型断言检查；协议集成证据使用实际 SDK 及 transport、真实本地 TCP/stdio 进程；真实客户端证据使用两个独立 SDK Client（独立 transport 与会话）及项目 CLI/示例消费真实结果。二者可以共用一次实际运行记录，但要分别说明断言层。当前不要求安装宿主插件或启动 Claude/ZCode。Node 20 CI 验证与本地 Node 22 验证分开报告。

交付保留日志、实际协商版本、session 标识摘要、调用 marker、正确响应结构、审计对应和资源关闭计数。HTTP 200、/health、工具可见或进程启动仅作为局部事实。变更完成后按最终 diff 独立重走 Server→Client→Gateway 调用链，审阅不以实现者自报代替，发现问题先返修复验。

## 13. 文档与后续阶段

本轮文档只修正现状和标记计划；实施后再更新 README 双语的通用工具用法、错误边界、真实会话模式与关闭行为，同步旧平台设计、Gateway V2 及运维说明。旧协作设计稿不改；后续协作方案另行确认，本阶段通过不代表 Agent Runtime、CLI 执行器、skill/插件、宿主唤醒或模型管理已完成。

当前官方稳定规范/SDK 的在线补充调查与迁移选择见 [架构设计](./2026-10-01-mcp-foundation-architecture.md)。P0 本稿不声称支持 2026-07-28；P1 的 factory、metadata、取消和 wire codec 使用各自官方公开入口，需单独通过新旧客户端矩阵。

完整实施路线见 [实施计划](/Users/zhouze/Documents/git-projects/ai-mcp/docs/superpowers/plans/2026-10-01-mcp-foundation-implementation-plan.md)。用户确认设计、范围与路线后，按 TDD 顺序实施；保留未提交改动。commit、push、merge、PR 各需独立明确授权。

## 14. 规范参考与设计自检

规范来源：[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[MCP JSON Schema 与 \_meta](https://modelcontextprotocol.io/specification/2025-11-25/basic/index)、[SDK v1.27.1](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.27.1)。本方案是针对当前版本的工程选择，不根据规范链接推断本仓库已经实现。

自检结论：已区分当前事实与方案；结果默认模式、标准/原生 payload 的边界、闭合 schema trace、协议错误与工具错误、stateful/stateless 生命周期均有明确选择。新增输出校验与生命周期拒绝等兼容影响已列出；每个 P0 项有验收编号。没有添加协作运行时、执行器、安装、发布或 Git 集成工作。运行时行为仍需确认后用失败测试与真实协议验证。
