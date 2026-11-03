# Lyra · 研究方法合同（RESEARCH-METHOD）

状态：**v1 已冻结，2026-10-25**（随 P0 冻结，审阅记录 `docs/FREEZE-P0-20261025.md`；结构与选项空间冻结，八维度与宽基七维的方法正文 P2 冻结）；冻结后变更须按 PLAN 修订程序。

上位文档：`../PLAN.md`（§4 研究维度、§5 历史参照判断义务、§6 继承规则、§9 合规边界）、`../ARCHITECTURE.md`。
关联合同：`ASHARE-RULES.md`（A 股市场规则与可成交性）、`SCHEDULING.md`（时段与调度）、`SETTLEMENT-REVIEW.md`（结算与复盘）、`HISTORICAL-REFERENCE.md`（历史参照库）、`DATA-SOURCES.md`（数据源）、`POINT-IN-TIME.md`（时点读取）、`P0-FOUNDATION.md` / `EXECUTION-KERNEL.md`（执行内核）。
Metis 只读参照：`/Users/yeemio/AI/gitrep/metis`。〔R-n〕编号指向 `../REVIEW-20261025.md`。

---

## 1. 合同范围

本合同定义 Lyra 的**研究链结构（A → 程序清单 → 必经 J）、决策合同、判断义务、输入分层、结论继承语义与研究结论对象**。维度清单见本文 §4，历史参照库的数据构建见 `HISTORICAL-REFERENCE.md`。

不在本合同内、由相邻合同承担：

- A 股市场规则（涨跌幅、ST 时点表、T+1、停牌、复权、可成交性分类、披露日历、更正公告）——`ASHARE-RULES.md`。
- 研究时段、触发、资料截点与溢出降级——`SCHEDULING.md`。
- 结算口径、复盘分母、预注册主指标——`SETTLEMENT-REVIEW.md`。

## 2. 研究链结构

结构移植自 Metis 方法12（`packages/method-football/src/method12.ts`，`METHOD12_INSTRUCTIONS.precedence`：A → deterministic PROGRAM_CHECKLIST → mandatory J），域对象替换如下。**A 单独永远不是最终结论**；每个通过结构校验的有效 A 必须进入 J，J 未完成即本轮无结论，按调度合同处置，不得把 A 输出冒充结论，也不得把技术失败冒充放弃。

### 2.1 A（分析者，Sol/high）

在封存材料（含 §6 分层与 coverage）上逐项评估 §5 八维度，产出：

- **候选决策**：一个 disposition 候选（§4 三选项之一）与理由，理由含选择阈值（该阈值同时进入清单供 J 复核）。
- **决定性连接（decisive links）**：逐条列出支撑候选的实际前提及其证据引用；每条是独立可裁决单元。
- **最强反证（strongest counterevidence）**：逐条列出与候选方向相反的实际证据。
- **信心**：按方向支持与证据质量分别报告，不报概率数字（对应方法12 "confidence … probability 保持 null"）。
- **限制（limitations）**：单列实际限制，含资料缺口与被裁剪材料（§6）。

A 的输入与禁止事项（对应方法12 precedence 的"No new evidence, post-cutoff information, outside quote, retry or extra research round"）：

- 只使用该轮封存池内材料及 §5 分层实际送达的内容；不得引入池外信息、截点之后的信息、外部报价或额外研究轮。
- 财务数字遵守 §4 财务数字声明；历史参照遵守 §6 判断义务；预期差维度按 §4 第 3 条的降权口径执行。
- A 输出未通过结构校验（维度、决定性连接、证据引用、数字声明任一不完整）→ 该轮无有效 A，不得生成清单，不得进入 J；该轮按调度合同的技术失败路径处置，不冒充放弃。

### 2.2 程序清单（PROGRAM_CHECKLIST，无模型）

由程序从**实际 A 输出与封存池**机械抽取（对应 `method12Checklist()`），程序不表达任何独立意见。条目类别：

| 类别 | 抽取来源 | 说明 |
|---|---|---|
| DECISIVE_LINK | A 决定性连接 | 逐条；含其 evidence_refs |
| DECISIVE_LINKS_EMPTY | A 决定性连接为空时单列 | J 须独立评估 A 剩余实际推理 |
| METHOD_APPLICATION | A 的方法应用说明 | 八维度适用情况与维度缺口声明 |
| CONTRACT_COMPARISON | A 的决策合同比较 | 候选方向与对立方向的比较 |
| STRONGEST_COUNTER | A 的最强反证论证 | 最强反证击败什么、剩下什么 |
| COUNTEREVIDENCE | A 反证数组 | 逐条 |
| CANDIDATE | A 的候选决策 | 候选方向与理由 |
| SELECTION_THRESHOLD | A 的决策理由（含阈值） | J 须把同一阈值应用于裁决后的剩余联合支持 |

每条字段：`checklist_id`、`category`、`a_text`（≤160 字符的定位摘录，非全文）、`source_path`、`source_hash`、`evidence_refs`、`instruction`；`assessment` 与 `decision_bearing` 一律初始化为 NOT_ASSESSED。清单整体绑定 `a_output_hash`、`material_hash`、资料截点与候选决策空间。

### 2.3 J（裁决者，Astra/xhigh）

逐项裁决清单**恰好一次**（对应 `METHOD12_J_SCHEMA.reviews`）：

- `verdict ∈ {SUPPORTED, NARROWED, REJECTED, UNRESOLVED}`。
- `decision_bearing`（布尔）+ `bearing_reason` + `bearing_evidence_refs`：复核后该条是否仍影响最终选择，必须写具体理由与真实引用。
- 非承重项必须给出 `remaining_basis_checklist_ids`，指向已经核查且仍承重、非 UNRESOLVED 的清单项，说明未解问题为何不能改变这些剩余依据下的比较。**不得把所有项设为非承重**（程序校验：至少一项承重），不得用 NARROWED 或低信心掩盖仍承重的未解项。
- **承重 UNRESOLVED → 必须 ABSTAIN**（程序校验：选定方向时不得存在承重 UNRESOLVED）。非承重 UNRESOLVED 可与选定并存，保留为 limitations。
- 程序只能核对结构与绑定，不能代替审阅论证。

J 必须完整回应**最强待回应论证**后才决定（对应 `decision_audit`）：`strongest_selectable_direction` 是回应之前最强可选方向（不是预先指定的最终选择），写出 `ACCEPTED / NARROWED / REFUTED / UNRESOLVED` 的实际处置，并通过 `decision_bridge` 把回应连接到最终决定；**放弃也必须完整回应最强论证**，指明无法完成的具体比较连接。允许回应并推翻后选择另一方向。改判（J 最终决定与 A 候选不一致）必须写明改判理由（`change_reason`）。

J 输出必须完整返回 schema 全部字段：reviews、方向比较（选定方向与其真实对立方向的比较，绑定同一股票、同一期间、同一行业基准、同一参考价）、决策范围（candidate_scope：A 候选方向对 / J 最终方向对 / strongest 方向对，及差异理由）、decision、decision_audit、confidence、limitations、evidence_refs。

J 的绑定与证据纪律：

- **输入哈希回抄**：J 输入携带 `required_input_hash`（程序对该轮 J 输入整体计算），J 必须将其原样回抄至输出的 `input_hash`；不回抄或回抄不一致即输出无效（对应方法12 J 指令与 `validateMethod12J` 的绑定校验）。
- **证据引用只指向实际送达的材料**：J 输出中全部 `evidence_refs`（含 reviews、比较、decision_audit 内的引用）必须能在该轮送达材料的引用目录中命中；引用未送达材料即为结构违规（§5 第 4 条同一纪律的裁决侧）。
- **程序只能核对结构与绑定，不能代替审阅论证**；语义质量由 J 的判断义务承担，二者不得互相替代。

## 3. 决策合同

| 选项 | 代码 | 含义 |
|---|---|---|
| 相对申万一级行业跑赢 | `RESEARCH_OUTPERFORM` | 预期未来 20 个交易日相对当时版本申万一级行业指数取得正超额收益 |
| 相对申万一级行业跑输 | `RESEARCH_UNDERPERFORM` | 预期负超额收益；含义为**回避或减持，不是做空**（A 股融券受限，PLAN §1） |
| 放弃 | `ABSTAIN` | 不表达方向判断；仍产生结论对象并进入复盘分母的放弃分类 |

**宽基 ETF 的决策合同〔R18〕**（出处 `../FREEZE-P0-20261025.md`）：

| 选项 | 代码 | 含义 |
|---|---|---|
| 20 日上涨 | `RESEARCH_UP` | 预期跟踪指数未来 20 个交易日绝对收益为正 |
| 20 日下跌 | `RESEARCH_DOWN` | 预期绝对收益为负；含义为**回避或减持，不是做空** |
| 放弃 | `ABSTAIN` | 同个股 |

两类标的的选项空间互不通用：个股结论不得出现 UP/DOWN，宽基结论不得出现 OUTPERFORM/UNDERPERFORM（程序校验）。宽基无行业基准，下文方向比较的"同一行业基准"对宽基改为"同一跟踪指数"；结算口径见 `SETTLEMENT-REVIEW.md` 宽基节。

- **结算周期**：20 个交易日；诊断周期 5 日、60 日只记录不参与决策（PLAN §1）。
- **参考价**：研究完成后的下一交易日开盘价（T+1 下最现实的可成交价）；因停牌顺延等规则见 `ASHARE-RULES.md`。
- **可成交性**：一字涨停时 OUTPERFORM、一字跌停时 UNDERPERFORM、停牌时均标为不可成交，仍结算但单独分类——完整分类表与判定口径见 `ASHARE-RULES.md` §5。
- 行业基准按资料截点当时的申万分类版本（2015–2021 区间用 2014 版，之后用 2021 版）〔R8〕。
- **结算本体不在本合同**：方向命中、超额收益、最大不利波动、失效条件触发（价格失效阈值当前为预留值 10%，P4 校准后冻结〔R3〕）与可成交分类的计算、不重叠样本规则、预注册主指标，全部见 `SETTLEMENT-REVIEW.md`；本合同只定义选项语义与周期。
- 三选项是穷尽的：J 不得输出第四种状态；UNKNOWN、技术失败、错过窗口是**执行层状态**而非研究选项，各按 `EXECUTION-KERNEL.md` / `SCHEDULING.md` 处置并单独计数，不混入三选项。

## 4. 研究维度（八维度）

宽基 ETF 不适用本节八维度，改用七维（估值分位、成分盈利趋势、宏观与政策、资金、价格行为与市场宽度、风格相对、历史状态参照；清单出处 `../FREEZE-P0-20261025.md` §四〔R18〕），P2 写入方法正文；A→清单→J 结构、判断义务、财务数字声明与输入分层对宽基同样适用。

个股由 A 逐项评估以下维度（PLAN §4 原样），未评估的维度必须作为缺口写入 limitations：

1. **基本面变化**：营收和利润增速的变化、毛利率趋势、现金流质量。
2. **估值**：市盈率、市净率在自身历史和所属行业中的分位。
3. **预期差**：业绩预告和快报与上年同期、与行业景气的对比；指引兑现记录降权参与〔R12〕（A 股少有正式指引，业绩预告本身即主要指引形式）。
4. **公司事件**：限售解禁、大股东增减持、回购、分红送转、定增。
5. **资金与价格行为**：量价关系、换手率、融资余额变化、龙虎榜。
6. **行业景气与政策**：行业指数趋势、相关政策公告。
7. **风险项**：股权质押比例、商誉占净资产比例、审计意见、监管问询（数据来源与首版缺口见 `DATA-SOURCES.md`）。
8. **历史事件参照**：判断义务见本文 §7，库的构建见 `HISTORICAL-REFERENCE.md`。

**财务数字声明**：所有财务数字必须引用确切的报表期间和科目，由程序复算核对。正文里只核对统计形态的数字（比例、百分比、样本数），其余数字照常书写。

## 5. 输入分层合同〔R2〕

Metis 真实事故：J 因 1.1M 字符输入 NOT_SENT，修复靠无损表格压缩（1,126,506 → 715,867 字符，`../REVIEW-20261025.md` R1/R2；Metis SPEC §9.1 条款"资料容量超过预算时分层传递并记 coverage，不静默截断"）。Lyra 从第一次模型调用起执行：

1. **分层传递**：封存材料容量超过模型输入预算时，按层传递，每层有事先登记的**字节预算**（数值在 P2 实施合同冻结登记）与**回执**（程序记录每层实际送达内容的哈希与字节数）。层职责示例（具体切分在 P2 冻结，原则先冻结）：
   - **L0 身份层**：研究身份、资料截点、方法版本、封存 manifest、coverage 与回执清单——任何调用不得裁剪。
   - **L1 工作层**：A 逐维度评估所需的材料（财务指标、公告原文摘录、行情表格、历史参照块），按维度归属切分，逐块记 coverage。
   - **L2 裁决层**：J 输入（A 输出、程序清单、封存材料、§6 有界历史参照上下文），裁剪决策同受 coverage 约束。
2. **coverage 记录**：每次调用记录送达了什么、裁了什么；**不得静默截断**。被裁剪材料在 coverage 中逐项可见，并进入该轮 A/J 的 limitations。
3. **行情序列一律表格化无损表示**：从第一天起，行情类数据（日线、复权因子、序列指标）只用表格化无损格式进入输入，不做叙事化改写。
4. J 的输入绑定各层 coverage 与回执清单；J 对未送达材料不得假装读过，引用未送达材料即为结构违规。
5. 验收规则：任何一轮研究的输入可在本地从 coverage + 回执完整重建裁剪决策（送达了什么、为什么裁、裁了多少字节）。

## 6. 判断义务：历史参照（方法14 移植）

移植自 `metis/docs/controller/historical-atlas-consumer-20261024/CONTRACT.json` 的验收条件（经 `../REVIEW-20261025.md` §二核对）。历史参照材料进入 A/J 上下文时：

1. **前缀 only，无未来泄漏**：只允许分析截点前可获得的前缀进入当前上下文；任何截点后的路径或结果不得进入。时点保证由 `POINT-IN-TIME.md` 的封存机制承担，方法层复核引用的参照材料确实来自封存池。
2. **精确匹配，缺口不伪造**：参照事件与当前研究的股票、行业（当时版本）、时间窗口必须精确匹配；缺失的时点或样本不可虚构，如实标注。
3. **显式回应**：A/J 引用历史参照时必须写明——(a) 对决定性连接的作用（支持 / 反证 / 不足）；(b) 权重等级；(c) 对结论强度的影响。收到有界上下文而不作显式回应，即未完成判断义务。
4. **回应不等于改判**：回应了历史证据，不等于结论必须改变。
5. **描述与预测分开**：历史描述性关联与预测分开呈现；样本数、来源与时间限制可见；群组嵌套（事件类型→行业→市值档→市场状态）不冒充独立证据（`HISTORICAL-REFERENCE.md`）。
6. **口径换算须有真实数据**：历史口径换算到当前口径（行业分类版本、复权口径等）必须有真实数据支撑，不得凭空转换。

验收方式：第 1、2 条由程序对引用的参照材料做封存池绑定校验；第 3、5、6 条由程序核对 A/J 输出中存在对应字段（作用/权重/强度、样本数/来源/时限、换算依据），缺失即结构违规退回；第 4 条是裁决纪律，由 J 自身执行并接受复盘检查。

## 7. 结论继承语义（方法15 移植）

移植自 `metis/packages/method-football/src/method15.ts` 的 `INHERITED_VALID_AJ / STANDALONE_PREMATCH` 二分（经 `../REVIEW-20261025.md` §二核对）。适用于事件后研究（调度见 `SCHEDULING.md`）：

1. **INHERITED_VALID_AJ（继承）**：事件后研究优先继承本周已完成的周度结论。继承的是**先验模型判断，不是当前事实，不构成自动选择**；先验 A/J 原文作为先验证据保留，本轮只重新评估新公告（新证据）并写明改判理由——维持与改判都要写桥接。继承资格：同股票、方法版本兼容、先验资料截点早于本次截点、先验 A/J 完整有效；不满足任一条即不继承。
2. **STANDALONE（独立研究）**：无可继承结论时，独立完整研究（A → 清单 → J 全程），结论对象标注"无基础结论可继承"。STANDALONE 不是对任何旧研究的重试或重采样。
3. **资料不全**：照常研究，但写明缺口（进入 limitations）；缺口击败方向判断时弃权；缺口不冒称确认。
4. 事件前研究并入周度队列、按周度研究处理（PLAN §6），不适用本节继承规则。

## 8. 研究结论对象

每个完成的研究轮（J 已裁决）产出一个结论对象，字段：

| 字段 | 定义 |
|---|---|
| 研究身份 | 标的类别 ∈ {STOCK, BROAD_ETF}〔R18〕；标的代码；研究类型 ∈ {WEEKLY, POST_EVENT, PRE_EVENT}（宽基首版只有 WEEKLY）；资料截点（knowledge cutoff） |
| 方法版本 | 本合同及裁决结构的冻结版本标识（三条版本轴之一，见 `../PLAN.md` §10：方法版本 / 数据与适配器版本 / 执行计划与授权版本，结论对象同时登记后两者） |
| disposition | 个股：`RESEARCH_OUTPERFORM` / `RESEARCH_UNDERPERFORM` / `ABSTAIN`；宽基：`RESEARCH_UP` / `RESEARCH_DOWN` / `ABSTAIN`（J 裁决后的最终值，§3） |
| adoption | 恒为 false——首版无正式采用、无资金结算（PLAN §9） |
| 结算字段占位 | 结算状态与结果（方向命中、超额收益、最大不利波动、失效触发、可成交分类）由 `SETTLEMENT-REVIEW.md` 定义并回填至占位区；回填不改动研究字段，研究字段一经写入不可变 |
| 证据引用 | A 输出哈希、清单哈希、J 输出哈希、封存材料 manifest 哈希 |
| 继承来源指针 | 有继承时指向所继承结论对象的身份与哈希；STANDALONE 时为 null 并标注"无基础结论可继承" |
| 改判理由 | 继承研究改判、或 J 改判 A 候选时必填（§2.3、§7） |

结论对象不设正式采用、不做资金结算；界面展示须标注"个人研究记录，非投资建议"（PLAN §9）。

字段间约束（程序校验）：

- disposition 必须等于该轮 J 输出的最终决定；不得从 A 候选或先验结论直接抄录。
- 四个证据哈希（A 输出、清单、J 输出、封存 manifest）缺一不可，且清单哈希必须能从 A 输出哈希机械重导出。
- 继承研究必须同时有继承来源指针与改判理由字段（维持也写）；STANDALONE 结论的继承指针为 null 且带标注。
- 结算占位区初始为"未结算"；回填只写占位区，不改研究字段。

## 9. 与 Metis 的对应与裁剪

移植以 `metis/packages/method-football/src/method12.ts` 为基线，逐项核对：

| 方法12 结构 | Metis 出处 | Lyra 域替换 |
|---|---|---|
| 模型组合 `METHOD12_MODELS`（A=Sol/high，J=Astra/xhigh） | `method12.ts` | 原样沿用（PLAN §1） |
| A → 程序清单 → 必经 J；A 单独永不成交 | `METHOD12_INSTRUCTIONS.precedence` | 原样；J 未完成即无结论 |
| 清单条目（decisive-link 逐条 / method_application / contract_comparison / strongest_counter / counterevidence 逐条 / candidate / selection-threshold，含空决定性连接单列） | `method12Checklist()` | 同类别同规则（§2.2），NOT_ASSESSED、程序无意见 |
| `reviews`：四值 verdict + decision_bearing + remaining_basis_checklist_ids | `METHOD12_J_SCHEMA` | 原样；承重 UNRESOLVED → ABSTAIN；不得全项非承重 |
| `comparisons` / `comparison_pairs` / `candidate_scope`（原对/最终对/最强对 + change_reason） | `METHOD12_J_SCHEMA` | 比较对象换为方向对：同股票、同期间、同基准、同参考价的对立方向；scope 绑定研究身份与决策合同；改判理由必写 |
| `decision_audit`：strongest_selectable_candidate_id + ACCEPTED/NARROWED/REFUTED/UNRESOLVED 处置 + decision_bridge | `METHOD12_J_SCHEMA` | strongest_selectable 换为最强可选**方向**；放弃也须完整回应 |
| confidence（方向支持与证据质量分报、不报概率）/ limitations 必填 | `METHOD12_J_SCHEMA` | 原样 |
| 封存池 candidate_pool（报价候选与资格判定） | `adjudication/pool.ts` | 换为候选决策空间（三选项）+ 封存材料 manifest |
| 比赛 fixture / 截点绑定 | `method12.ts` sealedPool | 换为股票 + 资料截点（时点合同 `POINT-IN-TIME.md`） |
| 方法14 历史判断义务 | `docs/controller/historical-atlas-consumer-20261024/CONTRACT.json` acceptance | §6（前缀 only、显式回应、描述与预测分开、样本/来源/时限可见） |
| 方法15 继承语义 | `method15.ts` INHERITED_VALID_AJ / STANDALONE_PREMATCH | §7（先验是模型判断非事实；STANDALONE 非重试；缺口不冒称确认） |

**明确不移植的：**

| Metis 机制 | 不移植理由 |
|---|---|
| KM43 九字段数字合同（`checkNumericDeclarations`，method12.ts 引 `nine-fields.ts`） | A 股无对应物；换成本文 §4 财务数字声明（引用确切报表期与科目 + 程序复算；正文只核对统计形态数字） |
| 十三维评估体系（方法7/9） | 换为 §4 八维度（PLAN §4） |
| 方法15 阵容就绪机器（lineup readiness 的 CONFIRMED/PROJECTED/UNKNOWN 状态机） | 足球域机制；其"缺口是显式证据缺口、永不冒称确认"的精神保留在 §7.3 |
| 方法14 的 WDL→盘口转换禁令（足球口径） | 域无对应物；等价义务保留为 §6.6（口径换算须有真实数据） |
| 亚盘候选对（同场同线对侧、void 规则） | 换为 §3 三选项方向对 |

## 10. 非目标

- **不做日内研究**：无日内数据、无盘中决策。
- **不做一致预期维度**：无可靠免费来源且无法按时点读取；预期差用 §4 第 3 条的替代口径（PLAN §3）。
- **不做做空**：UNDERPERFORM 的含义是回避或减持。
- **首版不做正式采用与资金结算**：adoption 恒 false（PLAN §9）。
