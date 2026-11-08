# 修复发送终态、执行租约、请求幂等与任务恢复

状态：PR4 R1 源码候选已实现，待总控接收与隔离 PostgreSQL／页面呈现验收；本文件不授予源码或业务接受。

审查候选：[`6c7cd196f20a4222d1f97708de7402b2c50ebeb0`](https://github.com/yeemio/Lyra/tree/6c7cd196f20a4222d1f97708de7402b2c50ebeb0)，tree `843eb5b97617ffda179ebb06e2ee2adf03bf19fc`。PR base=`main@6c7cd196f20a4222d1f97708de7402b2c50ebeb0`；head=`review-20261103/execution-recovery`，初始合同提交身份见 PR。

## 确认问题与原证据

以下原报告行仅作问题依据。审查方的实测声明保持原身份；总控以固定源码及就近合同/调用链核对，未把它们改记为本机执行。

| 编号、分类 | 源码证据 | 触发及影响 | 修复方向与验收 |
|---|---|---|---|
| **I-09** `candidate_defect`：发送后本地超时被错误落为 FAILED | [进程超时 620–624](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/kernel/sol-transport.ts#L620-L624)；[执行器分类 235–273](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/kernel/executor.ts#L235-L273) | 子进程本地超时、远端结果未知，但发生在业务 deadline 前时落 `FAILED/DEADLINE_EXCEEDED`。**内存 permit 探针复现。**执行器自己的 deadline 竞速会正确落 UNKNOWN，两条超时路径不一致。`sent_at` 仍阻止同键重发，不能夸大为必然重发。 | 用“是否实际发送、是否收到远端确定终态”分类，不能由本地杀进程推断远端失败。验收：发送后失联/本地超时为 UNKNOWN，发送前拒绝和远端明确失败另列，费用未知不写零。 |
| **I-10** `candidate_defect`：长调用期间租约不续，持有者校验又可省略 | [60 秒租约及校验](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/kernel/lock.ts#L118-L135)；[可选 holder 校验](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/kernel/executor.ts#L159-L164)；[SR worker 807–836](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/server.ts#L807-L836) | heartbeat 在整项任务前或整轮 A/J 后进行。模型调用超过 TTL，传统链可能在 J 前失去执行权；SR 将 holder 留在 worker 外层，没有贯穿发送，另一个 worker 可取得过期租约而旧 worker 继续。**静态确认，未跑真实多进程 DB 试验。** | 执行期间独立续租；所有发送入口必须带 fencing token，数据库原子检查当前持有者。验收：两进程、超 TTL 慢调用、暂停恢复时不出现双持有者继续发送；旧 token 必须被拒绝。 |
| **I-11** `candidate_defect`：原业务任务缺少完整、可信的恢复检查点 | [传统打捞 371–423](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/gate-m.ts#L371-L423)；[SR 只领取 QUEUED 233–244](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/store.ts#L233-L244)；[SR 恢复 881–930](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/engine.ts#L881-L930) | 传统 A 成功后中断，不能可靠按原 permit 恢复；`--a-from` 依文件名时间和较早 seal 猜配，未绑定原 permit/inputHash/真实身份。SR 重启不重新领取 RUNNING，步骤只在“零行”时创建，部分骨架不能补齐；若加载池/目录失败，还可能停在 RUNNING。**静态确认，已检查其他生产恢复入口。** | 建立业务键、阶段、permit、输入包、输出哈希绑定的持久检查点；原任务对账、补齐确定性步骤、显式处置 UNKNOWN。验收：A 后、J 后、发布前崩溃均恢复原任务；已发送步骤不重发，错绑或模拟 A 不能冒充真实 A 打捞。 |
| **I-12** `candidate_defect`：nightly 的真实通道正常入口接错，修正接线后仍缺 prompt | [CLI 1046–1057](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/nightly.ts#L1046-L1057)；[依赖读取 495–504](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/nightly.ts#L495-L504)；[调用材料 337–359](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/nightly.ts#L337-L359) | CLI 将 transport 放进 options，实际读取 `deps.transport`，所以正常 real 入口得到未授权占位。即使调用者正确注入，weekly/post-event payload 仍没有 SolTransport 必需的 prompt，且校验发生在 permit SENT 之后。**静态确认，未进行真实调用。** | 共用经过绑定的研究输入构造器；传输预检在占用一次发送资格前完成。验收：用无外发 fake transport 从 CLI 参数走到实际 dispatch，核对 prompt、哈希、身份；预检失败零 SENT。 |
| **I-13** `candidate_defect`：调度预算存在双上限和部分失败漏计 | [预算守卫 377–389](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/queue.ts#L377-L389)；[调用者 615–674](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/nightly.ts#L615-L674) | 两类预算都满时守卫仅返回 POST_EVENT，weekly 调用者因此不阻断；A 已发送、J 失败时内存计数不增加；只剩一个额度也未先保护两阶段需求。**实测 weekly=60/event=10 时得到 POST_EVENT，weeklyBlocked=false；其他后果来自静态调用链。** | 各预算独立判定，以实际 permit/发送收据原子计数；明确阶段预约与释放。验收：双上限、只剩一次、A 成功 J 失败、UNKNOWN、并发启动均不能绕过授权上限，报表保留全部尝试。 |
| **I-16** `candidate_defect`：追问及修订重试可生成新的业务调用身份 | [追问去重与新 step 1030–1071](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/engine.ts#L1030-L1071)；[重试提示与修订入口 486–520](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/server.ts#L486-L520) | 只有已经存在 USER→ASSISTANT 成功答案才去重。并发点击、发送后 UNKNOWN、回答落库前失败，重试会创建新的 step；permit 对新 step 是新键。修订幂等键包含当前时间，也不能识别同一次 POST 重试。**静态确认，未真实重发。** | 在发送前原子创建稳定请求身份，绑定报告版本、问题和输入哈希；重试返回原 pending/UNKNOWN/结果。验收：双击、断线重投和 UNKNOWN 重试只对应一次发送；明确的新意图才建立新身份。 |

## 完整行为与验证

区分发送前拒绝、远端确定失败及发送后未知，本地杀进程不推断远端失败；调用期间持续持有有效执行权，全部发送入口校验当前持有者/代际并拒绝旧执行者。业务任务检查点绑定原业务键、permit、真实输入和输出，补齐确定性步骤，恢复 RUNNING 不重发已发送步骤；打捞不猜文件名/时间。nightly CLI 注入正确 transport，生成完整绑定 prompt 并在 SENT 前预检。预算按各 scope 和实际发送收据原子约束，覆盖 A 成功 J 失败/UNKNOWN。追问与修订在发送前建立稳定请求身份，重投返回原 pending/UNKNOWN/结果，明确新意图才开新调用。

fake transport 与隔离测试数据库覆盖 A后/J后/发布前/保存答案前中断；长于 TTL 慢调用和双worker、旧token拒绝；CLI到dispatch绑定、预检失败零SENT；双预算满/剩一次/部分失败/并发；双击、断线和UNKNOWN重投最多一次发送。不得真实外发或操作业务库、P5服务。

允许路径：

- `src/kernel/**`
- `src/schedule/**`
- `src/research/gate-m*`
- `src/research/weekly*`
- `src/research/post-event*`
- `src/stock-research/engine*`
- `src/stock-research/store*`
- `src/stock-research/kernel*`
- `src/stock-research/server*`
- `src/stock-research/contracts*`
- `src/stock-research/*schema*.sql`
- `docs/review-contracts/20261103-execution-recovery.md`

## 授权、交付和停止条件

Owner 已授权这批经核对的问题修复、验证、对应分支提交/推送及 Draft PR 迭代。唯一代码作者为原普通 Chat（6ae99497-9154-83e8-ba4d-807175210ae2），当前总控负责合同、传输和稳定候选接受。若 Chat 无写工具，可提交完整补丁/文件，由总控机械发布同一作者的结果。保持同一 Chat，不另派作者。

只允许该 PR head 与下列源码/就近测试及本合同。确有必要的类型/调用者联动须在交付中逐项解释；不得顺手重构。所有 PR 初始 base 均为审查基线；同一作者可按依赖选择顺序，在对应修复 head 上非强制更新或显式采用另一已接受 PR 的提交，不向 main 合并。

禁止 main merge、release、部署、服务安装、真实模型调用、采集补数、真实账户与业务库写入/迁移、P5激活/重跑/历史改写，以及发布 data/var/delivery/.owlcoda 或凭据。源 SQL 及隔离测试库可作为源码修复，不向原业务库应用。PM 独占文件（README、AGENTS、PRODUCT、REQUIREMENTS、PRODUCT-LIFECYCLE、PROJECT-TASKS、REVISION-LOG）不并写。I-05 属现行合同冲突，排除此批修复，不改变 ASHARE-RULES §6 及冻结停牌/窗口口径。

适用验证在稳定候选完成后运行：项目 typecheck、受影响行为/调用链回归、diff检查；使用公开合成输入/隔离数据库。不是严格 TDD 授权，不强制先写失败测试。每条通过必须附实际命令、输出、环境与准确 head；未运行列明原因，不把报告原93测试当新候选证明。UI/PDF变动须提供与候选绑定的实际呈现证据。

停止条件：每个问题的完整行为出口成立，提供稳定 head、完整 changed paths/diff 与适用验证；当前总控接收。若无 GitHub 写工具，完整可发布补丁/文件即本次传输出口。一个初始结果加一次具名窄返工后先由总控重评，不自动无限重试或改换作者。源码接受不自动等于安装、整体L2、真实A/J或效果接受。

## PR4 R1 实施与依赖（2026-11-04）

唯一作者在原 PR4 分支上采用已接受 PR5 `5ecf5e87a2dfec261ddaa1e044085caa5cb62b26`（其祖先包含已接受 PR1、PR3）。依赖合并提交 `32baeae7b8af459fdfa722c44f1f5cc9a416776e` 的第一父为本 PR 初始合同 `3a97bf4283be95b3a3a3c0afab2e116ba64d3d70`，第二父为上述 PR5；tree `1d2f119edc823d6fbfafdf3a9b508d4e60a4384f`。未采用 PR2、PR6、PR7；未更改其旧身份。R1 修复提交以该合并为唯一父，精确 head/tree/raw commit、全量增量和哈希由冻结交付 manifest 记录。

| 出口 | 本候选行为与证据位置 |
|---|---|
| I-09 | 发送后的本地超时、失联、失去租约、结果检查点提交失败、无法证明远端终态的进程失败归 UNKNOWN；明确响应合同失败仍 FAILED。取消信号在等待落库之前传播到 Sol/SR runner/DSH worker，晚到输出不能改写已关闭结果。真实费用未知不填零。`executor`、`response`、两套 transport 与 DSH。 |
| I-10 | kernel/SR 各有数据库 acquisition generation、截止与独立续租；发送、检查点和任务写入在同一事务内校验原 token，等待锁后再查 DB 时钟。holder 名不能借用新 token。两发送门不接受高于绑定预算的独立并发参数；过期 FULL 等待者不得关闭新代际 SENT 或同代际替换合同。`lease`、`permit`、`store`、`engine-checkpoint`。 |
| I-11 | 传统链冻结原输入 CAS、业务键、授权/预算、身份和阶段截止；A/J 成功与响应检查点原子提交，A 后/J 后/发布前故障通过正常业务键恢复原回执，校验完整 J 后才发布。事件链同时冻结原准入/初始事实/先验，后来的结算回填不改先验研究身份。SR 冻结 pre-PLAN 证据、补齐原 11 步骨架、验证已完成步骤的原调用/CAS，重领本引擎旧代际 RUNNING 或显式继续原 FAILED；无原身份、冻结策略或 UNKNOWN 不自动重发。文件名猜配 `--a-from` 继续拒绝，不能据此冒称恢复成功。 |
| I-12 | nightly CLI 的真实工厂进入 `deps.transport`，周度与事件调用共用正常研究请求构造器；完整 prompt 字节、哈希、身份在 SENT 前预检。CLI 合成工厂从参数走到实际 dispatch 的 PG 用例仍保留 7 研究/14 permit/7 结论。非模拟 P5 commit 始终在执行前 `P5_PROTOCOL_FROZEN`。 |
| I-13 | DB 实际上海发送周计数；scope 独立上限、同授权版本不可增容；A 原子预约未发送 A/J，J 消耗原预约，失败只释放未发送槽，UNKNOWN/已发送永不退还。并发在 SENT 事务计数。nightly 从实际收据回填部分失败、准入和日志。不可变 `execution_attempt` 保留执行器入口的拒绝/未完成/返回，计费调用仍只数 `sent_at`，旧缺失审计不伪报零拒绝。 |
| I-16 | 追问/修订发送前原子建立 account＋稳定意图键，绑定报告版本/hash、问题及输入；任务/步骤/USER 消息/配额一并落位。双击和刷新默认复用原 pending/UNKNOWN/答案；页面显式 NEW 才采用新意图键。答案落位失败可从原成功响应检查点完成原请求，不重发、不重复计额。修订重投使用原 DB 截止及原任务。原任务继续入口保留鉴权/CSRF。 |

### 必要调用者联动与修改边界

合同目录外只做这些必要联动：`src/contracts.ts` 增加 scope 预算类型；`src/db/exec.ts` 将源执行 DDL 纳入对应隔离初始化；`src/journey/journey.test.ts`、研究旅程/语义测试迁移真实租约调用并把需要事务的调用者明确标为 PG 门；`src/research/inheritance.ts` 区分先验研究不可变身份与结算后补字段；`src/stock-research/transport.ts`、`dsh.ts` 和就近测试实现发送前校验/取消/完整身份；`render.ts` 与内容测试承接稳定意图/原任务继续入口；`sr-engine.test.ts` 与 `report-identity.pg.test.ts` 保留原恢复场景，要求真实原调用检查点，不再伪造成功步骤；`strategy/real-review*` 和 `review-isolated.ts` 传递实际 lease 并适配同一执行器，新增 `execution-port.test.ts` 明确只是 SQL 替身。该联动未变更策略规则、资金股数计算、P5 激活或 I-05 冻结窗口。

`dsh.test.ts` 的原费用写失败夹具改在其独占测试 schema 中对 `durationMs` 更新注入 SQL 失败；原因是生产元数据现通过租约事务 client 写入，原 pool.query 替身不再命中。该旧套件依赖私有输入/原运行目录/原凭据，本环境未运行；新 DSH 取消回归单独使用临时合成凭据和 loopback，绝不读取旧原件。

源 SQL 只随源码交付，未迁移业务库。没有修改 PM 独占文件、I-05、依赖包或 PDF 渲染源码。

### 本作者实际检查与待验门

当前 Linux / Node v24.22.1；既有依赖通过工作区符号链接复用，未执行服务安装。适用纯行为/注入传输/内容回归 126/126、0 失败、0 跳过；typecheck 与 diff 检查通过。冻结后复核的精确命令、完整 stdout/stderr、退出码、候选 head/tree 在交付日志中固定；不把修改前或总控历史测试数量当本候选重跑。

行为命令：`node --import tsx --test src/kernel/execution-recovery.test.ts src/kernel/transport.test.ts src/kernel/sol-transport.test.ts src/schedule/queue.test.ts src/stock-research/sr-real-transport.test.ts src/stock-research/dsh-recovery.test.ts src/stock-research/render.test.ts src/stock-research/report-identity.test.ts src/stock-research/strategy/execution-port.test.ts`。新增取消用例只向合成 loopback Messages 服务发送一次请求，无真实模型或真实凭据；Sol 与 SR runner 使用注入替身。SQL 查询替身不算 PostgreSQL。

**NOT_RUN：真实隔离 PostgreSQL。** 当前 `postgres/initdb/pg_ctl/psql/docker/podman` 均不可用，`LYRA_REPAIR_TEST_PG` 与 `LYRA_PG_PASSWORD` 均未设置。`execution-recovery.pg.test.ts`、`engine-recovery.pg.test.ts` 及调整后的 `report-identity.pg.test.ts` 必须由总控在准确新 head 的自建 PG 上补验。门覆盖源 DDL 重入、两池/两进程、超 TTL 续租与接管、锁等待后过期、旧 token/旧合同拒绝、双预算与 A/J 预约/UNKNOWN、审计计数、检查点失败回滚、A 后/J 后/发布前恢复、双击/HTTP 刷新/答案落位故障/修订重投、8 次 task 额度和原任务 worker 恢复。缺少 URL 时显式跳过即 NOT_RUN，不是通过。原 kernel/研究/调度/SR 集成调用者还需总控在其公开合成事实、研究池及临时 schema 上运行；未触碰真实资料或业务库。

**NOT_RUN：网页实际呈现。** 新意图/原任务继续表单只有 HTML 内容、安全和提交字段断言；未通过浏览器或截图路径绕过已有访问限制，不能签视觉接受。PDF 源码未变，不复报旧 PDF 为新检查。PR1/PR7/PR5 网页及原私有资料兼容性、严格 PIT、真实 A/J 语义、账户、安装、行业八日、效果、六项 NOT_ASSESSED 边界均保留。总控 ACCEPT_SOURCE 前，累计接受仍为 21/27。

## PR4 R2：两项具名生产回归（2026-11-08）

本轮唯一父提交为 C03 `bd161d976370bbdc4a9f8f78529b634283b67962`（tree `291860aaa207996e22d0b3de43eb570ad4975df6`）。原 C01/C02/C03、依赖父顺序、首次失败及交付原件均保留；只追加原作者一个提交，不重写历史。本节记录修复，不代表总控接受。

- **I-11 / SR 成功检查点恢复**：CAS 中的 `inputJson` 原字符串按 UTF-8 计算 SHA-256 与字节数，核对原冻结合同；其解析值、CAS 结构化输入与 JSONB 检查点按规范化结构比较。原成功响应、合同/通道身份及 CAS 步骤身份仍分别由 `restoreSrResponse`、`verifyCompletedModel` 与 `readStepArtifact` 核验。JSONB 重排键不再误报冲突；原字节、输入、输出或身份真的变化仍拒绝，缺 CAS/无成功回执不补配，UNKNOWN 不退额、不重发。
- **I-12 / POST_EVENT dry**：在原组装包上读取锚点事实与原先验，复用 `loadPriorResearch`、`withPostEventContext` 的同股/截点/封存/实际送达及继承资格校验，随后调用原 `buildARequest` 和 transport preflight。预览不创建执行检查点、permit、结论、计划或准入行。保留原启动窗预览语义；非模拟 dry 沿冻结方法被 `RESEARCH_METHOD_PROTOCOL_MISMATCH` 拒绝，非模拟 commit 仍在写入前 `P5_PROTOCOL_FROZEN`，不切换模拟身份。

原四个失败用例的症状和断言保留：`report-identity.pg.test.ts` 的实际 EISDIR/ASSEMBLE 续跑、`sr-engine.test.ts` 的 C4-03 QA 阻断恢复与 R2 已发送失败拒绝、`nightly.test.ts` 的 7 DRY + 1 SKIPPED。只增加原 CAS/JSONB 差异证据、原任务/步骤/调用/报告身份不变及事件送达/预检/零发送断言；CLI commit 的 7 研究/14 permit/7 结论与冻结拒绝不减。DSH 旧夹具不改。新增 `engine-checkpoint.test.ts` 只验证原字节与结构、真实临时 CAS 读回/错绑/缺失，明确不算 PostgreSQL。

本作者 Linux 环境的 typecheck、上述新纯检查及就近执行/报告纯回归合计 34/34、零失败/跳过，diff 检查通过；精确命令、stdout/stderr、退出码与冻结 head 以本轮交付日志为准。**隔离 PostgreSQL NOT_RUN**：无 `postgres/initdb/pg_ctl/psql/docker/podman`、无隔离连接配置；未运行默认库调用者、未把跳过或 SQL 替身称为 PG 通过。四个原失败用例须由总控在准确 R2 的自建 PG 上聚焦补验，原正向证据只按未变范围复用。不扩大真实资料、P5、网页呈现或业务/效果接受。
