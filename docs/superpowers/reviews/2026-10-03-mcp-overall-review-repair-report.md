# MCP 整体 Review 返修交付（2026-10-03）

用户授权“讲这些问题修复掉”后，修复整体 Review 的3项P1、13项P2、legacy-auto配置语义和审计初始化存量问题。继续在原 main@8dad112 工作树上增量修改，保留既有未提交文件；没有commit/push/merge/PR。

SDK保持1.27.1，不实施SDKv2/新协议迁移、CLI执行器、AgentRuntime、模型/供应商/账号管理。原协作背景设计稿未改，SHA256为28bba425025a41d94e6041d520425107f3660a5808419aba1c5f2ff2f96afeda。

## 逐项关闭证据

每组先写有意义的失败回归并观察RED，再实现GREEN。新增集成保护也覆盖已通过的跨模块行为。初轮root Catalog回归9项均按预期失败；Client/Connector18项RED后通过，另2项保护既有正确行为；schema scope/方言及middleware、慢body、早审计拒绝均有对应RED。独立复审追加的standard ID缓存、无payload legacy标准、非法root及初始化stop竞态也先复现失败再修。

| Review项     | 最终行为                                 | 验证要点                                                                                                                                | 仓库回归                                                                                                                                                               |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-01        | 发现内部错误不再降级为空目录             | Client仅明确MethodNotFound可兼容回退，typed类别优先，非法输入/输出不可借发现错误跳过校验                                                | [packages/mcp-client/test/overall-review-regressions.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/test/overall-review-regressions.test.ts) |
| P1-02        | 慢body归会话所有，TTL/DELETE不再留下悬挂 | 活动读取计数、独立取消jobs、读取完成重验entry；DELETE立即404，B在途/后续调用继续成功                                                    | [packages/gateway/test/lifecycle-review-repairs.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/lifecycle-review-repairs.test.ts)           |
| P1-03        | 生效contract贯通Client/Connector/Core    | CallOptions/CallContextOptions.resultContract显式覆盖下游声明；backend/tool两类真实HTTPoverride正常，错误输出仍被S拒绝                  | [packages/gateway/test/catalog-review-repairs.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/catalog-review-repairs.test.ts)               |
| P2-01        | 完整pipeline统一deadline/stop            | middleware前后、输入校验、handler与legacy/native同预算；执行未开始/完成/未知分别标记，不重放                                            | [packages/mcp-server/test/pipeline-lifecycle-repairs.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-server/test/pipeline-lifecycle-repairs.test.ts) |
| P2-02        | 嵌套Gateway单一外壳                      | 对上游声明standard/v1，下游生效模式及完整descriptor在来源metadata保存，原metadata内含前层来源链                                         | [packages/gateway/test/catalog-review-repairs.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/catalog-review-repairs.test.ts)               |
| P2-03        | 目录发布前检查名字与协议schema根         | 非法backend ID、超过128字符映射名、非object input/publicOutput根在初始化阶段报INVALID_DESCRIPTOR                                        | [packages/gateway/test/catalog-review-repairs.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/catalog-review-repairs.test.ts)               |
| P2-04        | 统一方言规范化                           | 2020-12与draft07支持的别名在compiler/native view/standard view一致，source原文不变                                                      | [packages/shared/test/schema-resource-view.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/shared/test/schema-resource-view.test.ts)                     |
| P2-05        | 保留schema资源scope                      | native W(S)内嵌内容hash唯一$id资源，保留nested$id和local refs；const/enum/default/examples不被改写                                      | [packages/shared/test/schema-resource-view.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/shared/test/schema-resource-view.test.ts)                     |
| P2-06        | 全部原生content保留                      | 兼容JSON文本仍首位，其后保留原文本/媒体块；不为了补充content而改坏闭合标准正文                                                          | [packages/gateway/test/lifecycle-review-repairs.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/lifecycle-review-repairs.test.ts)           |
| P2-07        | Client关闭终态                           | connect/discover/调用不可复活已关闭实例，连接候选也等待清理                                                                             | [packages/mcp-client/test/overall-review-regressions.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/test/overall-review-regressions.test.ts) |
| P2-08        | 退休连接关闭仍归服务所有                 | retiring close Promise受Connector跟踪并在close中等待，HTTP DELETE受控barrier证明不会提前返回                                            | [packages/gateway/test/connector-overall-review.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/connector-overall-review.test.ts)           |
| P2-09        | 合法标准文本回退                         | 未声明outputSchema时可从单text JSON严格解析完整标准；错误语义保持；legacy-auto无payload标准成功也有匹配public view                      | [packages/mcp-client/test/overall-review-regressions.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/test/overall-review-regressions.test.ts) |
| P2-10        | 发现总预算含首次连接                     | 单次timeout/cancel退出等待，不关闭其他调用共享的连接                                                                                    | [packages/mcp-client/test/overall-review-regressions.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/mcp-client/test/overall-review-regressions.test.ts) |
| P2-11        | 公开Core/Connector投影按契约生成         | native业务ok:false（含查询失败任务）仍为操作成功；明确legacy-auto保留旧完整标准识别                                                     | [packages/gateway/test/connector-overall-review.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/connector-overall-review.test.ts)           |
| P2-12        | 两HTTP模式版本策略一致                   | stateful/stateless都执行allowLegacyHttpSse策略，默认拒绝2024初始化                                                                      | [packages/gateway/test/lifecycle-review-repairs.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/lifecycle-review-repairs.test.ts)           |
| P2-13        | 审计记录实际wire协商                     | 观察SDK initialize响应；每协议实例独立记录，真实A/B不同版本并发audit不串                                                                | [packages/gateway/test/lifecycle-review-repairs.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/lifecycle-review-repairs.test.ts)           |
| 配置定案     | 显式legacy-auto优先                      | tool override > 显式backend设置（含legacy-auto）> descriptor > 兼容回退；未知S仍要求明确native/standard，避免猜schema意图               | [packages/gateway/test/catalog-review-repairs.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/catalog-review-repairs.test.ts)               |
| 存量审计     | mkdir早rejection不杀进程                 | 初始化拒绝立即被observe，record/close仍真实reject；Gateway报告audit_unavailable，业务不重放                                             | [packages/gateway/test/audit-ready-review-repair.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/audit-ready-review-repair.test.ts)         |
| 独立复审追加 | 标准根$id不再串validator缓存             | standard passthrough view按canonical dialect+内容隔离根ID，保留正文；官方同provider两异构工具正反验证均正确                             | [packages/shared/test/schema-resource-view.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/shared/test/schema-resource-view.test.ts)                     |
| 独立复审追加 | 初始化stop竞态不复活资源                 | Server/Gateway × stateful/stateless四路径，在实际SDK start barrier后复核终态并统一candidate/raw transport关闭；session/stream/active为0 | [packages/gateway/test/http-initialization-stop-race.test.ts](/Users/zhouze/Documents/git-projects/ai-mcp/packages/gateway/test/http-initialization-stop-race.test.ts) |

## 接口和兼容修正

- 保留echo/time、local\_\_echo标准外壳、旧CLI `{output}`、原四字符串legacy错误码、默认Server stateless/Gateway stateful。
- Client CallOptions、Connector CallContextOptions新增可选resultContract；这是本地调用控制，不进入严格的org.ai-mcp/context请求身份metadata。
- Gateway公开result-contract明确standard/v1，生效下游contract和来源原descriptor位于org.ai-mcp/downstream-tool。前一层来源在descriptor.\_meta内，避免另复制整条链。
- standard公开schema仅规范化方言/资源身份，保持正文层级和约束；原S原文在source descriptor保存。native公开schema仍W(S)。无schema的legacy-auto允许旧完整标准成功没有业务payload；空原生结果仍invalid_result。
- 显式legacy-auto覆盖下游声明；有未知outputSchema时仍报RESULT_CONTRACT_AMBIGUOUS，需要选择native/standard。name、input与公开output根不合法时提前拒绝，不静默截断或改写schema。
- 非协作业务执行不可强制终止，timeout/cancel可能executionDisposition=unknown；已完成业务后middleware超时为completed，未进入handler为not_started，禁止自动重放。
- 审计mkdir早拒绝不会成为进程未处理异常；没有把真实record/close失败吞掉。无穷挂起的注入sink仍不能被宣称flush成功。

## 独立复审

两名未参与实施的独立Reviewer重新审实际源码/diff和调用链，均最终PASS，无未解决的确定缺陷：

- 合同/schema/Client：4文件47项专项测试，真实SDK两工具共用root$id、HTTPoverride、两级Gateway、旧文本、补充文本及独立validator正负验证。记录：[/private/tmp/ai-mcp-independent-contract-review-20261003/final-review.md](/private/tmp/ai-mcp-independent-contract-review-20261003/final-review.md)。
- 生命周期：56项专项测试，原probe与新增stop竞态probe转绿；A慢body/DELETE与B在途执行重叠，A404、B在途/后续成功，执行恰2次、共享connector不提前关闭、所有active/session/stream归零。
- 审阅中发现的相邻遗漏均完成返修再复验，没有沿用前轮作者自查作为本轮PASS。

## 最终命令

macOS arm64，pnpm9.12.0。Node22.16.0与临时隔离Node20.20.2（未改默认Node/项目依赖）。基于最终冻结源码执行七项检查：

| 命令                         | Node22       | Node20       |
| ---------------------------- | ------------ | ------------ |
| pnpm lint                    | PASS         | PASS         |
| pnpm typecheck               | PASS         | PASS         |
| pnpm test:coverage           | 342/342 PASS | 342/342 PASS |
| pnpm build                   | PASS         | PASS         |
| pnpm test:e2e:gateway        | PASS         | PASS         |
| pnpm test:e2e:gateway:http   | PASS         | PASS         |
| pnpm test:e2e:gateway:matrix | PASS         | PASS         |

Node22覆盖率87.76% lines/statements、83.79% branches、96.57% functions；Node20为87.76% / 83.73% / 96.57%。vitest.config.ts维持HEAD原统计范围及四项80%门槛，没有扩大排除或降低阈值。输出无Unhandled/RangeError。git diff --check通过。

完整日志位于/private/tmp/ai-mcp-overall-repair-{lint,typecheck,coverage,build,e2e-basic,e2e-http,e2e-matrix}.log和/private/tmp/ai-mcp-overall-node20-{lint,typecheck,coverage,build,e2e-basic,e2e-http,e2e-matrix}.log。完整源码/单元/协议集成/真实进程各层分开验证；HTTP200、工具可见或进程启动不是单独完成证据。

## 保留边界

- 远程Ubuntu/GitHub Actions未实际运行；仅本机两个Node版本验证。
- 旧stateless不承诺跨请求MCP取消；服务停止、请求结束与调用deadline已验证。非协作执行和无限挂起的第三方审计sink不能靠协议关闭强杀。
- 第三方Claude/ZCode Host、SDKv2、完整Tasks Runtime不在本期。未宣称这类宿主或协作工作流已验收。
- 所有改动保持未提交；交付到可Review工作树，Git集成仍分别需要明确授权。
