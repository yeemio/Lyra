# Lyra · A 股个人研究平台 — 项目控制入口

**2026-10-31 当前职责**：Owner指定的唯一执行总控为 **Lyra 总控 · Astra-max**（`gpt-6-astra / max`，聊天 `01a190b9-2256-7563-9353-29af2c6f4d98`），已[明确接管](docs/handoff/controller-transfer-20261031/TAKEOVER.md)。它负责完整后续工程推进、安排、返工、验收、技术整合及唯一RunKit写入。原 `Lyra-PM`（`01a176df-5175-7c10-9555-28903cd71d3b`）回归产品定义、优先级和生命周期管理，不再工程派工或接收验收。PM独占PRODUCT、REQUIREMENTS、PRODUCT-LIFECYCLE、PROJECT-TASKS、REVISION-LOG及本文件/README的PM入口投影；新总控不并写，执行事实记录在RunKit与交付原件。以下2026-10-29及此前的“本聊天总控”是历史责任，不覆盖本次转交。

**2026-10-29 当前完整产品定义：本机单用户的 A 股研究与交易策略工作台，包含公司研究、市场机会、策略方案、持仓风险、跟踪复盘。** 单股报告为已有基础层，不再把“不自动下单”解释为排除交易策略。详见 [PRODUCT v3.0](docs/PRODUCT.md)、[REQUIREMENTS v4.0](docs/REQUIREMENTS.md)、[Mionyee 全链路研究](docs/MIONYEE-RESEARCH-20261029.md)。推进顺序为 L1 报告收口→L2 含风险/历史验证的日线策略闭环→L3 日常跟踪复盘→L4 逐族与条件式盘中/做 T 扩展。Owner 随后已授权按此顺序实施，2026-10-29 首项海控引用/阅读修复由 `/root/cosco_report_sol`（gpt-6.1-sol + high）冻结交付；主控已接受引用/源码/PDF；Owner已明确允许HTML视觉待确认并继续策略。日线策略已获 [R2源码与离线路径接受](delivery/CODEX-DAILY-STRATEGY-20261029/REVIEW.md)，两项具名返工关闭，唯一源码writer `/root/daily_strategy_sol`（gpt-6.1-sol + max）已冻结停止。该离线轮当时的海控资料不完整；后续补数/客户端进展取下段，真实A/J、安装和策略效果未接受，L3/L4未启动。海控原接受见 [报告裁定](delivery/CODEX-COSCO-REPORT-REPAIR-20261029/REVIEW.md)。项目本地 `owlrunkit@0.23.0` 已获准接入，控制状态由主控唯一维护；真实调用、产品服务安装、监控未启动，历史接受与 P5 冻结边界保留。

**本轮接受与阻塞（2026-10-29）**：Owner授权的海控缺段定位、真实补数和客户端接线由原writer `/root/daily_strategy_sol`（Sol-6.1 max，会话01a1858c-4bfb-7561-b041-1b5608b1f798）完成并冻结；[主控裁定](delivery/CODEX-STRATEGY-CLIENT-20261029/REVIEW.md)接受R2候选 `468f899d437fd6f3f42164a881afd8161b877cbb5ee3cb22ab130c6b3f840733` 的源码、海控/市场连续数据和临时客户端/策略页视觉。海控补807日，股票与市场各1162/1162；行业1154/1162，仍缺8日，完整输入和整体L2未接受。RunKit project=`lyra-strategy-client-20261029`保留外部依赖阻塞，不签完成；有同口径新原件后再沿[本轮合同](delivery/CODEX-STRATEGY-CLIENT-20261029/BRIEF.md)补封复核。原临时入口http://127.0.0.1:61279/strategies/601919于2026-10-31核实已离线，旧PID611已是系统进程，不据旧回执操作，无模型发送/业务库写入/安装；原服务、P5及Git未动，L3/L4未启动。

工程根 `/Users/yeemio/AI/gitrep/Lyra`。当前产品为**单平台客户端**，SaaS/账户/套餐/收费/商业发布退出当前范围。2026-10-28 的 **DSH R2 ACCEPT（通道源码与离线产品路径）**（[裁定](delivery/CODEX-DSH-CHANNEL-20261028/REVIEW.txt)）；[研究内容 R1 接受](delivery/CODEX-RESEARCH-CONTENT-20261028/REVIEW.txt)、C10 首页与报告 UI 离线接受、C8 工程接受及 C7-01 关闭保留，Owner 视觉与实际使用接受待确认。原工程接受与当前 PM 增量必须保留。Owner 先后批准海控DSH与Codex修订验证：原DSH在2次请求后停止并保留[记录](delivery/CODEX-COSCO-REAL-RUN-20261028/RESULT.txt)；后续Codex的5次分析/成稿成功，第6次J返回后因“未改判却重写结论”被本地校验拒绝，本轮已停止，见[结果](delivery/CODEX-COSCO-CODEX-REAL-20261028/RESULT.txt)。后续两项阻塞已[离线修正并验证](delivery/CODEX-COSCO-OFFLINE-REPAIR-20261028/REVIEW.txt)。Owner再授权的成稿及J两次补跑均成功，形成[受限报告](delivery/CODEX-COSCO-CODEX-TAIL-20261028/RESULT.txt)：原分章7段表格正文误填引用编号，QA阻止完整发布；PDF可读性未接受，HTML网页核验未完成。本轮已停止，完整发布、安装运行、报告质量和DS未获接受。当前优先级与责任取 [唯一任务表](docs/status/PROJECT-TASKS.md)，全阶段状态取 [生命周期地图](docs/PRODUCT-LIFECYCLE.md)，目标与 PM 方法取 [产品合同](docs/PRODUCT.md)。

轨 A 独立保留 P5 冻结观察：P0–P4 和数据扩张历史接受有效，Gate-M 已按 R29.1 代审收口；研究池 v2（R29.2），个股失效阈值 12%、宽基 5%，首次效果评价最早 2027-05-31 且须满足原样本条件，窗口内三不改。原授权见 R30；本次 PM 未核实时运行或累计样本，不将其写成每天成功运行。历史数量与执行证据见 [修订日志](docs/REVISION-LOG.md)及原交付，不用测试数或旧库计数表示当前产品完成率。

研究范围：沪深主板个股 26 只 + 宽基 ETF 4 只（R17、R18）；创业板、科创板、北交所不在范围。

## 项目身份

Lyra 是 Metis（`/Users/yeemio/AI/gitrep/metis`，只读参照，不得修改）架构向 A 股研究的移植：原件库 + 时点读取 + 执行内核（一次发送语义）+ A→程序清单→必经 J 的研究链 + 全机会分母复盘。继承关系与核对证据见 `docs/REVIEW-20261025.md` 第二节。

## 第一天就生效的项目约定（不可绕过）

1. **时点泄漏测试**：任意历史日期封存，读回资料不得含该日期之后发布的任何内容；覆盖四类时点对象（公告/财务发布时间、行业分类版本、指数成分归属、复权因子）。此测试是 P1 的停止条件之一，也是安装门的一部分。
2. **四项结构约束**：唯一的授权模型（每次模型调用绑定 permit 与调用合同）、唯一的执行器、三条独立的版本轴（方法版本 / 数据与适配器版本 / 执行计划与授权版本）、旅程测试作为安装门。
3. **一次发送语义**：同业务键（股票 × 研究类型 × 资料截点）不重发；UNKNOWN attempt 不自动重采样；执行截止时间不从计划模板隐式继承。
4. **诚实边界**：未绑定当前候选或真实状态的证据，不宣称完成；技术失败不冒充放弃；技术检查通过不冒充业务验收；预测效果在 2027 年 5 月底前不做任何宣称。

## 控制约定

- 唯一执行控制/整合 writer 为 Lyra 总控 · Astra-max（聊天 `01a190b9-2256-7563-9353-29af2c6f4d98`）；PM文件仍由 Lyra-PM 唯一维护。每份文件同一时刻只有一个writer，派工和接受由新总控负责。
- 未经用户要求不 commit、不 push；当前目录尚非 git 仓库，初始化须用户明示。
- 文档体系见下；结构性增删由总架构/产品负责人裁定并维护入口。本次新增生命周期地图与任务表，复用 PRODUCT 作为产品合同，不复制另一套 PM 账本。
- P0–P4 原阶段合同与已接受证据保留；客户端当前实施沿 [持续目标](delivery/CODEX-C3-ACCEPTANCE-20261027/CONTINUOUS-GOAL.txt)与接收差集推进，不恢复旧 SaaS 分期或 Dossier/Thesis M1–M5 路线。
- 历史上 Lyra-PM 同时负责产品/架构/PM与候选接收；自2026-10-31起执行职责已按顶部转交。2026-10-28 Owner 明确指定 Sol 子代理直接实施研究内容主线，本轮源码由 `/root/research_content_sol`（gpt-6.1-sol + high）交付并已获主控接收，writer 已冻结停止；原 ZCode 工程链与 C10 UI writer 均保持冻结，未被续派。本轮限客户端财务口径、问题取证、经营情景及离线报告链，不含真实发送、运行安装或 P5。PM 只在有意义事件到达时维护状态，不另设控制器、轮询或定时派工，不将记账当成派发/验收。
- 2026-10-28 Owner 新增 DSH 通道接入：由唯一源码 writer `/root/dsh_channel_sol`（gpt-6.1-sol + high）完成，R2 已获本聊天[接收](delivery/CODEX-DSH-CHANNEL-20261028/REVIEW.txt)，writer 冻结停止。只读参考 Metis 与现有 DSH 账户凭据，限客户端通道、必要精确依赖及离线验证；不改凭据/Metis，不发起真实服务请求，不改 P5 或启停服务。起点及恢复源为 `delivery/CODEX-DSH-CHANNEL-20261028/baseline.json` 与 `before/`；原研究内容和 UI writer 保持停止。
- 历史 C7 文档原件保存在 `delivery/PM-SETUP-20261027/`；C8 已冻结此前九份 PM 增量，本次接收后的六份状态更新原件及前后身份保存在 `delivery/CODEX-C8-ACCEPTANCE-20261027/`。工程文件未因 PM 工作改变；后续 writer 必须保留当前 PM 文档并重新冻结身份，不能覆盖回旧入口或悄改历史候选清单。

## 文档体系地图

| 文件 | 内容 | writer |
|---|---|---|
| `README.md` | 入口、状态、索引 | Lyra-PM |
| `AGENTS.md` | 本文件：控制入口与约定 | Lyra-PM |
| `docs/PRODUCT.md` | 产品合同、用户、边界、成功标准及 PM 维护约定 | Lyra-PM |
| `docs/PRODUCT-LIFECYCLE.md` | 全生命周期状态、分层接受与原始证据索引 | Lyra-PM |
| `docs/status/PROJECT-TASKS.md` | 唯一任务表、优先级、依赖、下一责任与旧需求去重 | Lyra-PM |
| `docs/PLAN.md` | 总规划 v1.1（十节 + 修订记录） | 总控 |
| `docs/REQUIREMENTS.md` | 产品需求 v4.0：研究与交易策略工作台；原报告保证保留，新范围分期实施 | Lyra-PM |
| `docs/REQUIREMENTS-BACKLOG.md` | 历史需求池与来源；当前状态由唯一任务表维护，不自动补池派工 | 总控 |
| `docs/REVISION-LOG.md` | 原 R22 起修订、P5 授权/冻结及管理差量 | Lyra-PM |
| `docs/ARCHITECTURE.md` | 架构总纲：分层、结构约束、版本轴、简化内核边界 | 总控 |
| `docs/MIONYEE-RESEARCH-20261029.md` | 股票分析、策略、验证、风险与跟踪的源码/设计对照；支撑完整产品定义 | 本聊天产品负责人 |
| `docs/REVIEW-20261025.md` | 规划评审归档（R1–R16 出处） | 总控 |
| `docs/FREEZE-P0-20261025.md` | P0 冻结审阅记录（R17–R21 出处） | 总控 |
| `docs/specs/P0-FOUNDATION.md` | P0 实施合同（第一份，已冻结） | 总控 |
| `docs/specs/P1-DATA.md` | P1 数据阶段实施合同 | 总控 |
| `docs/specs/P2-RESEARCH.md` | P2 研究阶段实施合同（含 Gate-M 真实模型授权门） | 总控 |
| `docs/specs/P3-EVENTS-REVIEW.md` | P3 事件与复盘实施合同（可并行面，Owner 开满指令） | 总控 |
| `docs/specs/EXECUTION-KERNEL.md` | 执行内核合同：permit、send-once、UNKNOWN、截止、恢复、旅程测试安装门 | writer |
| `docs/specs/POINT-IN-TIME.md` | 时点读取与原件库合同：五时间字段、四类时点对象、泄漏测试、CAS | writer |
| `docs/specs/ASHARE-RULES.md` | A 股市场规则合同：涨跌停、ST 时点表、T+1、停牌、复权、披露日历、更正 | writer |
| `docs/specs/DATA-SOURCES.md` | 数据源合同：适配器、三层回填、修订口径、限流退避、缺口声明 | writer |
| `docs/specs/RESEARCH-METHOD.md` | 研究方法合同：八维度、决策合同、A→清单→J、判断义务、输入分层、结论对象 | writer |
| `docs/specs/SCHEDULING.md` | 调度合同：四时段、继承、溢出、并发、预算 | writer |
| `docs/specs/HISTORICAL-REFERENCE.md` | 历史参照库合同：六类事件、机械选定、口径、判断义务 | writer |
| `docs/specs/SETTLEMENT-REVIEW.md` | 结算与复盘合同：结算口径、分母、不重叠、预注册主指标 | writer |

## 边界

- 2026-10-28 Owner 指定客户端 Codex 通道默认分工：分析链（PLAN/ANALYZE/A_FINAL/CHAT_ANSWER）为 `gpt-6.1-terra / max`，J 复核为 `gpt-6.1-sol / high`。准确配置与覆盖规则见 README；不改变显式 DSH 的模型、不自动开启真实调用、不恢复已停止的海控任务、不改变 P5。此为产品模型分工，不修改本聊天或工程子代理的默认路由。

- 定位为个人研究工具：不提供投资建议，不对外分享结论，不自动下单；界面结论一律标注"个人研究记录，非投资建议"。
- 数据仅供个人使用，原件不外传。
- Metis 仓库只读：引用其文档与源码作为继承依据，不得写入。
- 客户端真实调用已分别执行海控DSH v1及Codex修订v1的精确授权；此前两轮均已按首次失败停止。Codex首轮6次及后续补跑2次均已执行；补跑生成PARTIAL/PUBLISHED_RESTRICTED报告并停止，DSH原剩余4次不能移借。任何再次发送须有新的明确授权。轨 A 既有 R30 权限仅按原范围有效，不相互借用。

- Owner于2026-10-28明确纠正本次视觉操作：只允许Codex主会话侧边栏，不得转用日常浏览器。子代理不能显示IAB时交还主控；安全策略拒绝不得通过外部浏览器或代理绕过。本次Chrome误操作已停止，记录见[本轮视觉记录](delivery/CODEX-COSCO-CODEX-TAIL-20261028/visual/visual-review.txt)。
