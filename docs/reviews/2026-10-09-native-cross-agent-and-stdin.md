# 真实跨工具执行与 stdin 修复

日期：2026-10-09（Asia/Shanghai）。本记录补充当前原生调用，不覆盖旧证据。

## Codex 发起、真实 Claude 执行

原生 persistent caller 为 `01a11eb5-8143-74e1-965d-775928891d04`。
实际默认模型为 `gpt-6-astra/openai`；Claude 2.1.177 的实际目标模型为
`glm-5.3`。未设置 model override，沿用调用时可用原生配置。

目标 `task_3fdc83d7-b6b8-4c78-ae3f-c04188b96ee7` 与
`c11f788f-2993-4676-a99d-4ec4827ae79d` 是真实独立 task/session，非 fixture。
任务 completed，独立 Node `value-one` 验证 exit 0，6 个产物哈希/大小一致。
仅隔离交付的 src/value.txt 变为 ONE 加换行，原件仍 ZERO 加换行。
发起端准确续接原 caller 后 completed，并返回验证及交付结果。

证据目录：`/private/tmp/agent-delegation-codex-to-native-claude-20261009-5kxrnmfv`，
`binding-and-terminal.json`、`independent-proof.json`、`target-session-metadata.json`
与原生 followup 事件。目标 Bash 不可用；未安装、修改全局配置或替换供应商。
该轮绑定旧候选 b17748ca…，不直接验收之后的客户端修改。

## 已发现并修复的默认调用缺陷

旧 Python 薄客户端通过 NamedTemporaryFile 传递 spec/message。Codex 的
命令沙箱可以把临时目录回退到当前 cwd；cwd 为项目时，preflight 的临时
spec 留在源码中，Git 检查返回 DIRTY_SOURCE，清理后又显示 clean。
真实日志捕获了项目内 tmp\*.json，不能把此失败归为目标未认证或模型不可用。

当前修复使用 `--spec-file -` / `--message-file -` 与 subprocess stdin，
不再为控制输入创建文件。CLI 接收有界 UTF-8，校验原 TaskSpec/续接契约，
stdin 不作为命令执行；双输入提前拒绝，requestId/receipt 行为保留。
有效 RED：插件 5 项与 CLI 4 项因旧行为失败；修复后插件 33 项、CLI 20 项通过。

编译 CLI 与真实 Python 薄客户端/独立 daemon/fixture 的实物联调通过，
强制 TMPDIR 指向源码项目后零控制临时文件、任务完成、原件保留、重复请求
零额外启动。证据为
`/private/var/folders/2l/73r8_l3s7dv0hd955602j3pr0000gn/T/agent-bridge-thin-compiled-997h4tqv/evidence.json`。
fixture 不代替该修改后的真实宿主补验。

三宿主新包 trusted source checks 通过，当前插件源树为
`54b06e1e156e4846719de18a41a1d748bdab9e43afc1bfd6c8f36a690e54713d`；
Claude/Codex/ZCode content hash 分别为 e71ad4d2…、93472c38…、5fa8dad0…。
全仓 66 files / 565 tests，行/语句89.58%、分支85.18%、函数96.35%，原80%
阈值不变；ai-code 5组统一门禁通过。

## stdin 新候选的真实补验

新源树 54b06e1e…、Codex content hash 93472c38… 的完整候选通过原生
selectedCapabilityRoots 加载。发起端 `01a11ece-0ad5-7053-abae-7aa9fe22eba0`
沿用 gpt-6-astra/openai，119291ms 内完成并返回最终用户报告。
16 次 Bridge 控制调用均以已登记源码项目为 cwd；3 次 spec 输入均为 stdin，
没有 DIRTY_SOURCE 或控制输入临时 JSON 文件。未用候选目录替换 cwd。

独立任务 `task_ec808a52-9a42-43fb-898b-8a78fa0c570e` completed、仅一轮；
真实 Claude Code session 为 `198090af-d875-4925-b1eb-14baca905afe`，
实际模型 glm-5.3。目标 Read/Edit 各一次，Bash 禁止，未继承 Bridge 权限环境。
独立 Node 校验 baseline exit 1、交付 exit 0；原件 ZERO 加换行，隔离交付
ONE 加换行。仅 src/value.txt 改变、outOfScope 为空、6 个产物哈希/大小匹配。
发起端读取 diff/manifest/verification/result，回执与准确 task/session 一致。
runtime.stop exit 0；作用范围仍为 detect_only。

证据：`/private/tmp/agent-delegation-codex-stdin-native-20261009-q6lowe45/REPORT.md`，
以及 evidence.json、task-record.json、原生 events、控制调用日志和 receipt。
Bridge 编译 CLI SHA256 为
`b010ff817b50de075fc85e22af22a38635aff991c06712be384a954a0fea31ed`，
运行前后字节一致。完整候选包资源闭包与哈希均匹配，未安装或注入技能正文。

验证脚本不必要地把原生发起端 TMPDIR 指到源码项目，原生工具另生成了
node-compile-cache，Git 状态保留该未跟踪目录；未删除或忽略以包装干净结果。
这与 Bridge 控制输入零临时文件分开记录，不能声称本轮零原生缓存写入。

## Claude 发起端准确续接收尾

另一真实 Claude→Codex 任务 completed，注册 value-check exit 0，目标准确
session 为 `01a11eb7-e92b-7680-aa5f-97d29fb0ac29`。发起端首轮被 180 秒
观察预算中断；实际选择 existing 工作区，原项目产生预期变更，不能声称
该轮隔离或原件保留。

之后通过同一 Claude caller `04ae0807-7e84-458f-8fda-f3fd9e8a041e` 精确
resume，只读取既有任务/产物并报告，原生 exit 0、正常终态、glm-5.3[1m]。
报告明确 existing 和真实验证边界，没有新建或重跑目标 task；目标仍一轮。
收尾加载新候选 54b06e1e…，首次创建绑定旧候选，不能合并声称全程新包验收。
证据为 `/private/tmp/agent-bridge-native-cross-20261009-u617lams/caller-resume-summary.json`
及 caller-resume-events.json；同目录保留首轮有界中断。

## 保留的未完成边界

ZCode 内置 CLI 的当前账号映射/签名兼容与其实际可用入口仍待核对；
不以模型品牌作为阻塞，不从两个工具的成功推导第三个工具已通过。

## 当前候选的 Claude→Codex 完整补验

独立新轮绑定 54b06e1e… 源树与 e71ad4d2… Claude 包，可信源码检查12文件
通过，全部资源哈希匹配。Claude 2.1.177 caller
`d75c74a0-8f48-4442-9b2d-f44f5145e1d8` 沿用 glm-5.3[1m]，自然选择技能，
216.157s 内 success/exit0，无中断或 permission_denials。

真实 App Codex 0.162.0-alpha.2 沿用 gpt-6-astra，task
`task_f3e594b1-f9a9-4c4d-a242-84608170bea3`、session
`01a11efb-1a97-7fa0-b3e8-24c5c623c034` completed/exit0，全进程组退出。
仅一个 start/run/原生目标调用，零 continue/替换。Node baseline exit1
到交付 exit0/VALUE_ONE_VERIFIED；原件 ZERO 加换行且 Git clean，isolated
交付 ONE 加换行，只改 src/value.txt、outOfScope为空，六产物哈希/大小匹配。
回执准确，caller 已读四类交付并给出最终报告，runtime.stop/exit 均0。

原生插件/MCP/TMPDIR、模型及审批配置保持调用时默认值，未用关闭功能或
候选 cwd 规避问题。作用范围仍 detect_only，不能声称 OS 限制到单文件。
材料在 `/private/tmp/agent-delegation-claude-to-app-codex-54b-20261009-4qsq3hu8`。
该轮编译 CLI 仍绑定 b010ff81…；之后 app-server 候选源码的改动不自动继承
这次原生字节验收，真实新链需另外验证。

## 同工具独立会话与保守退出结果

当前主会话通过 CLI/API 创建另一个真实 Codex 根会话：task 为
`task_36ada0c6-9b3e-4c36-a569-7b6b1fc8baab`，session 为
`01a11ed6-035a-7691-978f-6a0264c7e39f`，与主 caller 不同。
缺少 independent-session 的同工具请求先被拒绝，显式请求才启动。
首次仅读取随机 NONCE.txt 并修改隔离 src/value.txt；原件保留。

两次 native leader 均 exit 0、有真实终态/session，但同组 Git 网络子进程
在 leader 退出后继续运行。Bridge 等待后清理拥有的进程组，全部退出，
任务仍 failed/unknown；不把终态文本或 Node 验证 exit 0 代替完成证明。
owned-group-observations.json 记录第二轮 git/git-remote-https、leader 退出
后 PPID 1，最终组为空。未修改退出判定以让验收通过。

停止/重启服务后，仅显式 continue 同一 task/session，无替代新会话。第二轮
未调用文件/命令工具，注册 stdout 的 message 精确召回前轮随机值；这证明
此次身份与上下文续接，不能消除上述失败或宣称整个同工具场景通过。
目标仍两轮，两次交付验证 exit 0，原件 ZERO、交付 ONE；最终 runtime.stop
exit 0。使用当时默认 gpt-6-astra，不覆盖模型配置。

证据：`/private/tmp/agent-bridge-native-self-resume-ltl7q3db/independent-continuation-proof.json`，
first.json、second.json、两个注册 delivery、准确 rollout、组观察及 stop 回执。
原验证脚本因仅检查失败 outcome 的错误 message 而记 nonceRecalled=false；
原文件保留，独立补证从哈希匹配的注册 stdout 核对真实召回值，两者含义分开。

限定独立 code_reviewer 仅核对源码、orphan-terminal 测试、注册产物哈希
及上述进程证据，未确认 P0/P1/P2 Bridge 缺陷：当前结果符合已有保守完成
边界。该审阅未启动模型/服务或重跑测试，不代表额外原生场景验收。
