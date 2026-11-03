# Lyra · 执行内核与旅程测试安装门合同（EXECUTION-KERNEL）

状态：**v1 已冻结，2026-10-25**（随 P0 冻结，审阅记录 `docs/FREEZE-P0-20261025.md`）。上位合同：`docs/ARCHITECTURE.md`（四项结构约束、三条版本轴、P0 简化内核边界）、`docs/PLAN.md` v1.1（§8、§10；修订 R1/R5/R6/R14/R15，R 编号指向 `docs/REVIEW-20261025.md`）、`docs/specs/P0-FOUNDATION.md`（实施分期与 Done-when）。关联合同：`docs/specs/POINT-IN-TIME.md`（时点读取与泄漏测试本体）、`docs/specs/SCHEDULING.md`（时段、队列准入与溢出判定）、`docs/specs/SETTLEMENT-REVIEW.md`（复盘分母）、`docs/specs/RESEARCH-METHOD.md`（输入分层与行情表格化）、`docs/specs/DATA-SOURCES.md`（数据源适配器与退避）。Metis 为只读参照：`/Users/yeemio/AI/gitrep/metis`。

本文每条规则写成可验收判定：能针对它设计一条证伪测试。规则编号 `EK-n.m`，供旅程测试与其他合同引用。

---

## 1. 合同范围

**管：** 执行内核的行为合同——唯一执行器、permit 与调用合同、send-once、UNKNOWN 处置与本地退役、执行截止、并发与限流退避、启动诊断与恢复、溢出降级的执行侧分类，以及旅程测试安装门。

**不管：**
- 封存什么、as-of 怎么过滤、五时间字段——`docs/specs/POINT-IN-TIME.md`；
- 时段何时触发、队列怎么排、溢出何时判定准入——`docs/specs/SCHEDULING.md`（本合同只定义超额者落库时的分类与标注）；
- 研究内容、维度、输入分层与表格化表示——`docs/specs/RESEARCH-METHOD.md`；
- 结算口径与复盘统计——`docs/specs/SETTLEMENT-REVIEW.md`；
- 数据源适配器的抓取与校验——`docs/specs/DATA-SOURCES.md`。

**术语：** "模型调用"指一次对外部模型端点（P0 为模拟模型，P2 起为真实端点）的发送；"执行单元"指一次模型调用在内核中的载体（permit 绑定于它）；"研究执行"指一只股票一次研究的完整模型调用序列（A 与 J）。本合同的 permit 语义在调用级，研究执行级的状态由调度合同组合。

**EK-1.1（边界判定）** 任何"内核应选择研究什么"或"封存应包含什么"的规则出现在本文件中即为越界；反之，任何一次模型发送未持有 permit、任何断点不可恢复的设计，无论写在哪个合同里都违反本文件。

**教训映射（本文条款对 Metis 真实返工的覆盖，出处均为仓库内可查记录）：**

| Metis 教训 | 出处（metis 仓库内路径） | 落入条款 |
|---|---|---|
| J 输入 1,126,506 字符超长 NOT_SENT，无损表格压缩后同窗续接 | `docs/controller/project-closeout-20261024/source-preimage/AGENTS.md` | EK-4.4、EK-4.5 |
| 可复用计划继承 deliveryMs=660000，物化截止早于调用窗口，J 被 SIGTERM | 同上 | EK-6.1 |
| 原 J 缺 Session/Checkpoint 保存链，引发整套恢复修复 | `docs/controller/today-t6-20261024/`（ORIGINAL-RECOVERY-CLOSEOUT） | EK-5.5、EK-8 |
| 远端结果未知的本地退役（不重发、不退款、保留 UNKNOWN 计数、不伪造回执） | `packages/persistence/src/host-unreleased-recovery.ts`、`packages/persistence/src/execution.ts` | EK-5.2、EK-5.3 |

## 2. 唯一执行器

**EK-2.1** 同一时刻至多一个进程持有执行权。执行权以可观察的占有凭据实现（数据库租约或等价机制），凭据含持有者标识与取得时间。证伪：启动第二个执行器进程，其任何执行操作（模型调用、结算计算、原件写入）必须被拒绝并返回命名错误（如 `EXECUTION_LOCK_HELD`），而不是静默排队形成第二条执行链。

**EK-2.2** 模型调用、结算计算、原件写入三类操作只经执行器发起。证伪：原件库写入记录全部可追溯到执行器日志条目；绕过执行器的直连写入路径在代码中不存在，测试中以非执行器身份调用写入接口应被拒绝。

**EK-2.3** 并发上限 2（§7）是执行器内部的并行度，不通过启动多个执行器实现。证伪：任意时刻在途（SENT 且未终止）的模型调用数 ≤ 2，从 permit 表按时间窗断言。

## 3. permit 模型

**EK-3.1（绑定）** 每次模型调用在发送前绑定一个 permit，permit 记录确切调用合同，字段为：研究身份（本次研究的唯一标识）、股票、研究类型（周度 W / 事件后 POST-EVENT / 事件前 PRE-EVENT）、资料截点（as-of 时刻）、输入哈希（封存 manifest 的哈希）、方法版本（当前方法轴版本号）、执行截止（§6）。证伪：存在任一 SENT 及之后状态的 permit 缺任一字段，或任一成功模型调用找不到对应 permit 记录。

**EK-3.2（拒绝）** 无 permit 的模型调用被拒绝，错误可读：错误码命名（如 `MODEL_CALL_WITHOUT_PERMIT`）并指明缺失的 permit 与所属研究身份。证伪：绕过执行器直接调用模型客户端接口，收到命名错误而非成功响应；permit 计数不增加。（Metis 形态：`tests/runtime-closure/product-journey.test.ts` R1-01 以 `modelPermits()==0` 断言未授权状态零释放。）

**EK-3.3（状态机）** permit 生命周期五态，迁移仅限：
- `PREPARED`：permit 已创建并绑定调用合同，发送尚未发起；
- `SENT`：发送已发起。PREPARED→SENT 的迁移只记录在发送动作实际启动之后——进入 SENT 即不能再断言"确定没有发出"；
- `SUCCEEDED`：远端返回确认可用结果且输出已落库；
- `FAILED`：确认失败（远端显式失败，或本地验证拒绝），如实记录失败原因；
- `UNKNOWN`：发送已发起但无确认终态（进程中断、连接断、远端结局不明）。UNKNOWN 是本 permit 的终态，只经 §5 本地退役关闭，不自动重采样。

SUCCEEDED / FAILED / UNKNOWN 均为终态，无出边。迁移表：

| 当前态 | 事件 | 迁移 | 记录义务 |
|---|---|---|---|
| — | 调用合同齐备、同键检查通过 | → PREPARED | 落全部合同字段（EK-3.1） |
| PREPARED | 发送动作实际发起 | → SENT | 记发起时刻；此后不得声明"确定未发送" |
| SENT | 远端确认成功且输出落库 | → SUCCEEDED | 输出哈希、检查点 |
| SENT | 远端显式失败或本地验证拒绝 | → FAILED | 具名失败原因 |
| SENT | 中断/失联/截止且无确认终态 | → UNKNOWN | 依据与时刻；仅经 EK-5.3 关闭 |
| PREPARED | 发送前置检查未通过 | NOT_SENT 出口（非状态） | 具名阻断；permit 不进 SENT（EK-4.4） |

证伪：状态迁移表中任何其他迁移路径在实现中可达即为违约。

**EK-3.4（可审计）** permit 记录可按研究身份、股票、状态、时间查询，含每次状态迁移的时间与触发者。证伪：任一终态 permit 的完整迁移历史（创建→发送→终态）可从存储完整读回；读不回即违约。

**EK-3.5（与 Metis 的对应与差异，如实声明）** Metis 的 permit 状态为 NOT_SENT / MAY_HAVE_SENT / SETTLED / UNKNOWN（`packages/persistence/src/execution.ts`，`exec.permit_state`），attempt 层另有 `UNKNOWN_LOCALLY_TERMINATED` 等中间态，且以 `NOT_SENT_CONTRADICTS_START` 守卫"声称未发送但 permit 已启动"的矛盾。Lyra 五态是简化：NOT_SENT 不是 permit 状态而是发送前置检查的出口（§4 EK-4.4），MAY_HAVE_SENT 语义并入 SENT。此差异是裁剪不是新发明。

## 4. send-once 语义

**EK-4.1（业务键）** 业务键 = 标的（个股或宽基 ETF〔R18〕）× 研究类型 × 资料截点。同一业务键在任一时刻至多存在一个已发送（SENT 及之后）的 permit 链。证伪：对同键并发提交两次，最终 SENT 计数为 1。

**EK-4.2（幂等返回）** 同键重复提交幂等返回首次结果，绝不产生第二次模型发送。提交入口在 PREPARED 之前做同键检查；命中已完成（SUCCEEDED）的键时直接返回既有结果与 permit 标识，不新建 permit。证伪：同键第二次提交后，该键的模型发送次数仍为 1，读回内容与首次一致。（Metis 形态：product-journey.test.ts 以 envelope 重放断言 `graphAttempts` 不变——"Re-running the completed job replays nothing and adds no attempts"。）

**EK-4.3（不伪造对象）** 被同键检查或前置阻断拒绝的提交不落任何研究对象，阻断原因具名返回。证伪：提交一个材料缺失的键，返回具名阻断（如 `MATERIAL_MISSING`），研究对象表中无新行。（Metis 形态：R1-02 "named blockers stay honest without fabricating objects"。）

**EK-4.4（NOT_SENT 不是一次发送）** 发送前置检查（含输入大小检查，见 EK-4.5）未通过时 permit 记为 NOT_SENT 出口、不进入 SENT，发送从未实际发起；修复原因后同键允许再次尝试，这不违反 send-once。NOT_SENT 与"已启动的 permit"不得并存——实现须有与 Metis `NOT_SENT_CONTRADICTS_START` 等价的守卫。证伪：一次 NOT_SENT 后修复重试，该键最终 SENT 计数为 1，且 NOT_SENT 出口记录与任何 SENT permit 的时间线不矛盾。

**EK-4.5（输入大小是执行问题）** 执行器在发送前对输入做大小校验：超过模型输入预算的输入以具名阻断（如 `INPUT_OVER_BUDGET`）拒绝，绝不静默截断；分层传递的合同在 `docs/specs/RESEARCH-METHOD.md`，触发判定在本层。（Metis 教训：J 输入 1,126,506 字符在本地长度检查处 NOT_SENT、permit 为 0，经无损表格表示降至 715,867 字符后只续接原窗口剩余一次 J——机制出处 `metis/docs/controller/project-closeout-20261024/source-preimage/AGENTS.md`，字符数出处 `docs/REVIEW-20261025.md` R1。）

## 5. UNKNOWN 处置

**EK-5.1（判定）** permit 处于 SENT 且无法确认终态（进程死亡、连接中断、远端无响应至截止）即判 UNKNOWN。判 UNKNOWN 的同时不得改写为 FAILED 或 SUCCEEDED——远端可能已成功、可能已计费，本地无证据下不改口。

**EK-5.2（不自动重采样）** UNKNOWN 不触发对同一业务键的自动重发或重采样；同键新 permit 的创建被拒绝（如 `BUSINESS_KEY_UNKNOWN_HELD`），直至该 permit 被本地退役关闭。证伪：注入"发送后失联"故障，等待任意时长并重启进程，该键 SENT 计数仍为 1。

**EK-5.3（本地退役回执）** 远端结果未知的关闭方式是本地退役：落库一份退役回执，如实记录"远端结果未知、费用未知"，不重发、不退款、不伪造任何远端回执、不合成结果或检查点。回执字段含：permit 标识、业务键、判 UNKNOWN 的时刻与依据（中断/截止/恢复流程）、触发退役的操作者（进程或人）与时间。（Metis 形态：`packages/persistence/src/host-unreleased-recovery.ts` 头部声明 "Local closure only. No result, original Session/checkpoint, permit, or usage record is synthesized."，且恢复清单 `allowResend:false`；`packages/persistence/src/execution.ts` 的退役证书 `remoteResult:'UNKNOWN'`、`remoteCost:'UNKNOWN'`。）

**EK-5.4（分母）** UNKNOWN 计入复盘分母并独立计数，不与技术失败、放弃、错过混同。统计合同在 `docs/specs/SETTLEMENT-REVIEW.md`；本合同的义务是保留可数的原始记录。证伪：一次注入的 UNKNOWN 在复盘原始记录中可作为独立类别数出。

**EK-5.5（断点可恢复性是一等公民）** 每个执行单元在关键步骤（封存完成、A 完成、清单完成、J 完成）落检查点；恢复后先读回断点的实际结果再继续，已完成步骤零重跑、零重发。（Metis 教训：原 J 缺 Session/Checkpoint 保存链导致整套恢复修复——出处 `metis/docs/controller/today-t6-20261024/`（ORIGINAL-RECOVERY-CLOSEOUT）。）证伪：旅程测试注入中断于 A 完成之后，恢复后续跑的模型发送次数只补 J 一次，A 的输出来自原检查点读回。

**EK-5.6（UNKNOWN 处置时序）** 从判定到关闭的固定顺序：
1. 判 UNKNOWN 并冻结该业务键的新 permit 创建（EK-5.2）；
2. 重启/恢复流程进入 RECONCILING（EK-8.2）；
3. 显式确认后读回检查点实际状态，无确认终态的 SENT permit 维持 UNKNOWN（EK-8.3）；
4. 执行本地退役、落退役回执（EK-5.3）；
5. 该键计入复盘分母 UNKNOWN 类（EK-5.4），研究执行按调度合同决定是否以新资料截点另立新键重研——新键重研是调度决策，不是本 permit 的重采样。

证伪：任一步可被跳过（如未落回执即允许新键创建、或跳过读回直接重跑）即为违约。

## 6. 执行截止规则

**EK-6.1（截止自身持有）** 执行截止属于单次执行自身：物化执行时由本次调用的窗口显式计算并写入 permit（EK-3.1 字段），不从计划模板隐式继承任何时长字段。（Metis 教训：可复用计划继承 `deliveryMs=660000`，物化截止 13:58:19 早于 16:35 的调用窗口，J 被 SIGTERM 且远端结局未知——出处 `metis/docs/controller/project-closeout-20261024/source-preimage/AGENTS.md`；评审记录 R1。）证伪一：修改计划模板中的截止/时长字段，已启动执行的 permit 截止字段不变。证伪二：任一 permit 的截止值与"由本次窗口起点与合同计算"的期望值不符即违约。

**EK-6.2（到期分类）** 截止到期仍未完成的执行按"未按窗完成"分类落库（如 `MISSED_WINDOW`），不冒称完成、不计入成功。证伪：注入一个必然超窗的任务，最终分类为未按窗完成，结论对象不产生，且该次计数进入复盘分母的错过类。〔R22 终态归属细化〕三分支：① SENT 态截止先到且远端结局不明 → permit 终态 **UNKNOWN**，"未按窗完成"由 `fail_code='DEADLINE_EXCEEDED'` 承载（处置走 EK-5：不重采样、Owner 确认后退役）；② modelFn 已返回结果但晚于截止 → 按实际结果 settle（成功 → SUCCEEDED + `fail_code='LATE_COMPLETED'`；显式错误晚到 → FAILED + 原错误码）；③ 发送前已过截止 → FAILED/DEADLINE_EXCEEDED（从未发送，结局已知）。理由与出处见 `docs/REVISION-LOG.md` R22。证伪（分支①）：注入短截止 + 挂起型超时，读回 state=UNKNOWN、fail_code=DEADLINE_EXCEEDED、sent_at 非空。

**EK-6.3（先例引用）** "已合法开始但窗口外完成的任务如实标注、不得冒充按窗交付"沿用 Metis `late_completed` 语义（`metis/docs/specs/SPEC.md` §9.3）；溢出降级的"未按最高优先窗完成"标注（§9）是其 A 股版实例化，落在调度侧时同由本条兜底其不冒称。

## 7. 并发与限流

**EK-7.1** 模型调用在途并发上限 2（EK-2.3 的度量形式）。超出即排队，不报错、不降配额。

**EK-7.2（两级退避）** 模型层（429/限额/超时）与数据源层（适配器限流）各自独立退避：首次等待约 30 秒，逐次加倍，同一调用至少重试 3 次；3 次仍失败则停止重试、按暂停上报，不把瞬态问题升级为任务失败。数据源层的适配器侧合同在 `docs/specs/DATA-SOURCES.md`。证伪：注入连续 3 次可恢复限流错误，观察到的重试间隔序列约为 30s/60s/120s 且第 4 次不再发起，任务状态为暂停而非 FAILED。

**EK-7.3（暂停上报格式）** 每次暂停上报固定四要素：已重试次数、最后错误（具名错误码与原文摘要）、恢复位置（检查点/执行单元标识）、唯一下一动作（如"重试该执行单元"或"等待 Owner 确认"）。证伪：任一暂停状态可读出全部四要素；缺任一项即违约。

**EK-7.4** 暂停期间的续跑不构成第二次发送：续跑沿用 send-once 与检查点规则（EK-4、EK-5.5）。

## 8. 启动诊断与恢复

**EK-8.1（冷启动诊断）** 冷启动失败时诊断信息可见，输出必须能回答三问：缺什么（具名缺失项，如配置键、数据目录、版本绑定，不是泛化的"启动失败"）、什么状态（当前生命周期状态）、下一步（可执行的动作）。证伪：抽掉一项必需配置启动，诊断输出包含该配置的确切名称与处置建议。

**EK-8.2（中断重启进 RECONCILING）** 检测到上次运行未干净退出（持有执行权凭据残留、检查点未闭合、SENT 未终止的 permit 存在）时，重启后进入 RECONCILING 状态：不自动续跑、不自动发送、不自动改写任何 permit 状态。证伪：制造非干净退出后重启，任何模型调用计数为 0，状态读回为 RECONCILING。

**EK-8.3（恢复需显式确认）** RECONCILING 退出的唯一路径是显式确认动作（命令行或界面的一次明确确认），确认后执行状态一致读回：每个执行单元的检查点、permit 状态、研究对象三者配对一致；无法配对到确认终态的 SENT permit 走 §5 UNKNOWN 流程。（Metis 形态：恢复流程要求 workspace 处于受 fence 的 RECONCILING/PAUSED 且逐项校验后闭合——`packages/persistence/src/host-unreleased-recovery.ts`。）证伪：注入"J 已发送、进程死亡"，重启后未经确认不发生任何状态变更；确认后读回显示 A 检查点复用、J 进入 UNKNOWN 处置，且全程无第二次 J 发送。

## 9. 溢出降级（执行侧义务）

**EK-9.1** 事件后研究同日待研数超过并发容量（75 分钟窗、并发 2，约 4 只；容量口径见 `docs/PLAN.md` §6〔R6〕）时，超额者的处置由调度侧判定（`docs/specs/SCHEDULING.md`）；执行内核的义务是提供并执行该分类：超额者降级并入次日周度队列，落库标注"事件后研究未按最高优先窗完成"。证伪：构造同日 6 只事件后研究，2 只被标注降级且次日以周度类型执行；无任何记录冒称 6 只均按最高优先窗完成。

**EK-9.2** 降级标注是复盘分母中的独立类别（错过最高优先窗 ≠ 技术失败 ≠ 放弃），原始记录可按该标注独立计数。

## 10. 旅程测试安装门

**EK-10.1（模拟模型）** 旅程测试使用模拟模型：同输入哈希产出确定性输出；输出符合 A/J 简化 schema（P0 口径，见 `docs/specs/P0-FOUNDATION.md`）；可按场景注入故障——超时、发送后失联（UNKNOWN）、显式失败、输入超预算拒绝；模拟身份自我声明，生产配置不得将其标注为真实端点。P2 接真实模型时模拟器保留用于安装门。

**EK-10.2（断言清单）** 旅程测试套件必须包含且全绿：
1. **零释放**：未配置/未授权状态下执行任何研究操作，模型 permit 计数为 0，操作被具名错误拒绝（Metis R1-01 形态）；
2. **无 permit 拒绝**：直接发起模型调用无 permit，收到命名错误（EK-3.2）；
3. **完整公开路径**：封存 → A → 程序清单（无模型）→ J → 结论对象落库 → 读回，全程走公开接口，测试不以内表补丁代替产品路径（Metis R1-02 形态）；
4. **send-once 幂等**：同业务键重复提交，发送次数 1，读回首次结果；重跑已完成研究零新增发送（EK-4.1/4.2）；
5. **UNKNOWN 断点恢复**：注入发送后失联，permit=UNKNOWN、不自动重采样、退役回执落库；显式确认恢复后从断点续跑，已完成步骤零重发（EK-5）；
6. **截止分类**：注入短截止，任务按未按窗完成落库；修改计划模板截止不影响已启动执行（EK-6.1/6.2）；
7. **时点泄漏接线**：四类时点对象（公告/财务发布时间、行业分类版本、指数成分归属、复权因子〔R14〕）的合成泄漏用例在旅程套件内运行并计入安装门；泄漏测试本体合同在 `docs/specs/POINT-IN-TIME.md`。

**EK-10.3（安装门定义）** 旅程测试全绿是安装任何新版本的必要条件：凡产生新版本标识的软件变更（代码、依赖、存储 schema）安装到运行环境，安装流程必须包含旅程套件运行并留下全绿记录（版本标识、测试运行标识与输出摘要、时间）入安装日志；无全绿记录的安装视为未完成。证伪：存在一条无对应全绿记录的版本安装即门失效。数据回填等不产生新版本标识的运行不触发本门，但只能运行在已过门的版本上。

**EK-10.4（断言风格继承）** 断言写法继承 Metis 旅程测试：用计数断言（permit/发送次数）而非旁路日志；阻断具名且不伪造对象；幂等以重放验证；"未授权零释放"是第一优先断言。（参照 `metis/tests/runtime-closure/product-journey.test.ts`。）

## 11. 非目标

**EK-11.1** 不建方法资格链、graph release、hybrid qualification、多方法并存注册机器——P5 前方法冻结无版本切换需求（裁剪声明见 `docs/ARCHITECTURE.md` §P0 简化内核的范围边界）。若 P5 后方法演进，按新版本轴追加，不复活资格链。

**EK-11.2** 不做真实模型路由：P0–P1 模型层只有模拟模型；真实端点调用自 P2 起按有界授权引入（`docs/specs/P0-FOUNDATION.md` 非目标）。执行内核的 permit/send-once/UNKNOWN 合同对模拟与真实端点无差别适用——模拟器不得 bypass permit。

**EK-11.3** 不做多执行器、分布式执行权、跨机接管。执行权单点是接受的取舍（EK-2.1），恢复靠检查点与 RECONCILING 流程，不靠第二执行器热备。

## 12. 已知缺口与未决问题（登记，不在本文裁定）

1. **业务键是否含方法版本：** 冻结键为股票 × 研究类型 × 资料截点（EK-4.1）；首版方法冻结期内无冲突。P5 后若方法版本变化需重研同键，send-once 将拦住新方法的重发——届时需修订键定义（如并入方法版本），现在只登记不改。
2. ~~本地退役的触发集合~~：已裁定（R21）——首版本地退役一律由 Owner 显式确认触发（恢复流程中批量列示，逐条或整批确认），不设自动退役。
3. ~~截止时钟源~~：已由 `docs/specs/SCHEDULING.md` SC-10.3 冻结（本地时钟 + 交易日历校准，±60 秒容忍，只允许让截止提前）。
4. ~~暂停上报通道~~：已裁定（R21）——落库为状态记录，CLI 读出；不另写文件。
