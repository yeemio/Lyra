# Lyra · 唯一任务与责任表

> 当前职责投影：2026-10-31（Asia/Shanghai）；产品候选事实保留各自证据日期。维护人：Lyra-PM。
> [产品合同](../PRODUCT.md)｜[生命周期地图](../PRODUCT-LIFECYCLE.md)。这是目标层任务与次序入口；具体实施仍使用既有持续目标、交付清单与验收记录，不另开 assignment 或缺陷账本。

## 当前工作顺序

**执行总控已转交**：Lyra 总控 · Astra-max（`01a190b9-2256-7563-9353-29af2c6f4d98`）已[接管](../handoff/controller-transfer-20261031/TAKEOVER.md)，负责后续工程推进、安排和验收，独占RunKit写入；本聊天回归PM。新总控已开始核对行业缺日补查的请求与接口口径，只有新证据支持才补取，不盲重试。PM不巡检执行、不另派writer。

**本轮已验收可完成部分，完整输入仍阻塞**：海控缺段定位、807日补数和现有客户端接线已完成；主控接受冻结R2源码、股票/市场各1162/1162以及新增策略页的IAB导航/视觉。行业1154/1162，8日外部缺口未解，整体L2不能关闭。[本轮裁定](../../delivery/CODEX-STRATEGY-CLIENT-20261029/REVIEW.md)。Sol writer已停止，唯一下步为取得缺日同口径可核原件后补封复核；没有新来源证据不轮询或另起采集链。

**完整产品已重订为公司研究、市场机会、交易策略、持仓风险、跟踪复盘五部分。** Mionyee 全链路研究与文档修订已完成；Owner 随后授权按此顺序实施。首项海控引用和阅读修复已由 Sol 子代理 `/root/cosco_report_sol` 冻结交付；主控已接受引用/源码/PDF，HTML实际视觉因工具安全策略待Owner确认；Owner已明确允许继续。第一条日线策略源码与离线闭环已由 `/root/daily_strategy_sol`（Sol-6.1 max）交付R2并获[主控接受](../../delivery/CODEX-DAILY-STRATEGY-20261029/REVIEW.md)，两项返工关闭，writer已停止。此为此前离线轮；新增策略页视觉及真实补数见当前裁定，严格历史验证、真实A/J与使用仍未接受。详细范围与阶段出口见 [PRODUCT v3.0](../PRODUCT.md) 和 [研究依据](../MIONYEE-RESEARCH-20261029.md)。原报告工程接受继续保留，不扩成完整产品接受。

实施重启顺序为 **L1 已有报告收口和数据契约 → L2 日线趋势策略的计划/风险/验证/离线复盘闭环 → L3 关注池、持仓、显式跟踪与前向复盘 → L4 其他策略及条件式盘中/做 T**。L2 已含基本风险和验证，不把它们拖到策略发布以后。本次源码实施和主控验收已完成，停止于此授权边界；真实模型调用、产品服务安装与监控未授权新增。

**海控两次补跑已结束：A_FINAL与J均成功，生成PARTIAL / PUBLISHED_RESTRICTED报告，完整发布尚未通过。** J覆盖28项、无承重未解，完整29表808行已送达；原分章的7段Markdown表格正文误填引用编号，QA因此阻断。PDF本地视觉读回发现原始Markdown及冗长字段附录，可读性未接受；HTML网页核验未完成。见[本轮结果](../../delivery/CODEX-COSCO-CODEX-TAIL-20261028/RESULT.txt)。随后具名离线引用/呈现修正已接收引用、源码与PDF边界，未追加模型调用；原受限报告和HTML视觉待确认状态保留。原DSH尝试、Codex六次失败轮、研究内容R1、DSH R2及C8/C10历史接受保留，P5及DS边界不变。Owner明确只用主会话侧边栏，不能因子代理IAB不可见而切换日常浏览器。

Owner 后续补充：本次执行结束是因为关机。该说明已记入本轮结果，原始 `DSH_OUTPUT_INCOMPLETE` 回执保留，未据此自动续跑。

Owner 已指定客户端 Codex 默认模型分工：分析链 `gpt-6.1-terra / max`、J 复核 `gpt-6.1-sol / high`。本次调整源码默认与逐步调用身份记录，具体配置见 README；真实调用授权、海控停止状态及显式 DSH 配置保持原边界。

| ID / 目标 | 状态 | 责任 | 完成条件与依赖 | 唯一下步 / 原件 |
| --- | --- | --- | --- | --- |
| PRODUCT-SCOPE 完整定义与顺序 | **完整定义已修订；策略源码/离线增量见下项** | 本聊天 Codex 唯一文档 writer；Owner 产品反馈 | Mionyee 股票分析/策略/验证/风险/跟踪研究与 Lyra 范围一致，原接受和 P5 保留 | 定义阶段已完成，后续按Owner授权顺序实施；[研究](../MIONYEE-RESEARCH-20261029.md)、[产品合同](../PRODUCT.md)、[变更记录](../../delivery/PRODUCT-REDEFINITION-20261029/CHANGES.md) |
| STRATEGY-CORE 最小策略闭环 | **源码/已齐真实资料/临时客户端 ACCEPT；完整输入 BLOCKED** | 历史 `/root/daily_strategy_sol` 冻结；当前Astra总控接管推进/验收，PM记录产品状态 | 原离线R2接受保留；海控/沪深300各1162/1162，客户端来源/覆盖/条件/验证可读；行业缺8日，严格PIT、真实A/J、账户及效果未接受 | 取得8日同口径可核原件后补封并复核受影响部分；无新增证据时停止。[本轮裁定](../../delivery/CODEX-STRATEGY-CLIENT-20261029/REVIEW.md)、原61279临时策略页已于10月31日核实离线。L3/L4未启动 |
| WORKBENCH 日常研究与跟踪 | **L3 待实施，未派发** | 同一产品主控；运行、通知、真实记录授权在启动时绑定 | 依赖 L2；市场/候选比较、用户确认的持仓及组合风险、显式跟踪、前向模拟、人工记录与全分母复盘 | 按 L2 产物补使用闭环；FR-13/17–21。范围登记不激活定时任务或消息发送 |
| STRATEGY-EXPAND 策略与频率扩展 | **L4 有序后续范围，未派发** | 产品负责人按验证缺口选择，Owner 决定新数据/权限 | 价值/持有、波段、突破、均值回归逐族验证；日内/有底仓做 T 先满足行情、持仓、交易规则和成交模型 | 不移植八套旧实现；FR-22。无底仓现货当日往返按机制阻断，不连接券商自动下单 |
| CLIENT-QUALITY 真实报告价值 | **R1 源码与离线内容链 ACCEPT；真实报告质量未验** | 原 writer `/root/research_content_sol` 已冻结；本聊天 Codex 接收；Owner 内容接受 | 财务口径、两份茅台原件与经营计算已贯通；模拟报告承重未知受限发布，未替代真实链 | 已授权实施块结束；随 CLIENT-REAL 绑定真实验证条件；[裁定](../../delivery/CODEX-RESEARCH-CONTENT-20261028/REVIEW.txt)、[离线报告](../../delivery/CODEX-RESEARCH-CONTENT-20261028/offline-engine/REPORT.html) |
| CLIENT-UI 首页与报告阅读体验 | **C10 源码及离线界面 ACCEPT；全面 UI 改版未发出** | 本聊天 Codex 接收；特种兵 `/root/metis_ui_special`（gpt-6-astra + xhigh）已冻结停止 | 既有离线证据保留，Owner 视觉/实际使用仍待确认；新增界面范围随真实内容和阅读反馈确定 | 按 L1 阅读问题补差，L2/L3 随对应能力增加策略与跟踪界面；[C10 裁定](../../delivery/CODEX-C10-ACCEPTANCE-20261028/REVIEW.txt)、[C9 裁定](../../delivery/CODEX-C9-ACCEPTANCE-20261028/REVIEW.txt) |
| CLIENT-ENG 客户端工程闭环 | **C8 ACCEPT（工程）；C7-01 CLOSED** | 原 ZCode 实施已结束；本聊天 Codex 已接收 | 原八项工程出口按逐轮接受范围收口；本轮协议适配与 PM 保留已核对，真实质量单列 | 保持冻结，停止本轮返工；[正式裁定](../../delivery/CODEX-C8-ACCEPTANCE-20261027/REVIEW.txt)、[原长任务](../../delivery/CODEX-C3-ACCEPTANCE-20261027/CONTINUOUS-GOAL.txt) |
| CLIENT-DSH DSH 通道接入 | **R2 ACCEPT（源码与离线产品路径）；两项返工关闭** | 原 writer `/root/dsh_channel_sol`（gpt-6.1-sol + high）冻结停止；本聊天 Codex 已接收 | 官方 SDK、只读凭据、显式选择、授权守门、一次发送/UNKNOWN、输出校验及产品引擎链成立；凭据重复元数据读取的声明已勘误 | 本轮结束；[裁定](../../delivery/CODEX-DSH-CHANNEL-20261028/REVIEW.txt)、[R2 交付](../../delivery/CODEX-DSH-CHANNEL-20261028/r2/DELIVERY.md)；真实服务/安装/P5 不在接受范围 |
| CLIENT-REAL 真实生成验证 | **原受限稿保留；七项引用/源码/PDF ACCEPT，HTML视觉待确认** | 源码 writer `/root/cosco_report_sol`（Sol-6.1 high）已冻结；主控已接受约定边界；HTML视觉由Owner后续确认 | 原J 28项全覆盖、29表808行完整送达；七项引用与PDF可读性已离线修正并接受，HTML视觉与Owner质量接受仍待确认 | [本轮结果](../../delivery/CODEX-COSCO-CODEX-TAIL-20261028/RESULT.txt)、[字段问题](../../delivery/CODEX-COSCO-CODEX-TAIL-20261028/citation-findings.json)；[本次裁定](../../delivery/CODEX-COSCO-REPORT-REPAIR-20261029/REVIEW.md)：Owner已决定继续策略，HTML视觉保留待确认，不自动调用模型 |
| CLIENT-USE 本机使用接受 | **模拟证据与 C8 消费影响面已接受；实际安装/Owner 使用待核** | Codex 工程读回；Owner 使用接受 | 发起→查证→追问→显式修订→旧版→PDF→关闭重开，同一候选身份；只补受影响覆盖 | 随获准真实验证核对实际使用，不重跑无变化旧旅程；[C4](../../delivery/CODEX-C4-ACCEPTANCE-20261027/REVIEW.txt)、[C5](../../delivery/CODEX-C5-ACCEPTANCE-20261027/REVIEW.txt)、[C8](../../delivery/CODEX-C8-ACCEPTANCE-20261027/REVIEW.txt) |
| CLIENT-DS 适用独立审查 | **NOT_RUN，外部边界未绑定** | Owner 确定外发；实际审查方审阅；Codex 接收 | 实际 provider/model、准确候选、材料使用/外发范围和意见回收可核；内部接受不代签 | 绑定范围及许可后发出；不因任务表出现就发送；[DS 记录](../../delivery/SINGLE-STOCK-RESEARCH-DELIVERY/DS-REVIEW.md) |
| OBSERVE P5 冻结观察与首评 | **观察窗口已生效；当前运行/累计样本本轮未核验** | 沿原 P5 执行链；本聊天 PM 登记；Owner 效果决定 | R29/R30、池 v2、12%/5%、三不改、原全机会分母；首评最早 2027-05-31 且满足原样本条件 | 沿原授权运行；下一次实际运行/结算事件到达时更新事实，不安排 PM 轮询；[R29/R30](../REVISION-LOG.md) |
| OBSERVE-OPS 运行前提核实 | **历史已知缺口待核，非已确认当前故障** | 当前 P5 执行责任须在下次实际操作前绑定；Codex 管理责任 | 交接称日历截至 2026-10-23；须以最新日历覆盖和实际调度/结算记录确认是否仍有缺口 | 下次有 P5 运行操作时先核这一前提，只处理确认的差集；[历史交接“已知缺口”](../../HANDOVER.md) |
| DATA-Q3 三季报收尾 | **既有待办，时间条件未到** | 沿原数据维护执行链；责任在实际执行前绑定 | 2026-10-31 披露期结束后，按原时点/修订口径补齐当时尚缺项；不回写旧报告 | 最早 2026-11-01 检查实际进度再按原方案处理；本轮不清进度、不回填、不设提醒；[历史交接“定时器”中的保留待办](../../HANDOVER.md) |
| DATA-EXPAND 已有数据需求收口 | **原范围已接受，来源缺口保留** | PM 引用原验收，不派新 writer | A/B 类及后续已完成项按下表去重；源无记录/北向缺口不冒充完整覆盖 | 无新产品阻塞则保持已关闭；[数据交付](../../delivery/DATA-EXPANSION-DELIVERY.md)、[后续收口](../REVISION-LOG.md) |
| FUTURE 后续需求与扩张 | **延后 / 未授权** | 产品负责人筛选，Owner 决定真实范围变化 | 池外扩张、分红/股息率补充、独立档案/论点平台、SaaS/商业发布分别评估；不能借空闲自动展开 | 只有当前使用事实或 Owner 决定证明必要时转成具名任务；[历史需求池](../REQUIREMENTS-BACKLOG.md) |

CLIENT-QUALITY 与 CLIENT-USE 是不同的产品接受面，不各自派一条平行实现链；同一交付可同时提供两者证据。CLIENT-DS 的启动次序由准确审查合同决定，不擅自要求必须在真调用前或后。

## 原需求池去重映射

以下只纠正任务身份与历史完成状态，不重新验收、回填或承诺源持续可用。原需求池的“实施中/排队/自动补池”保留为旧记录，不再用于当前调度。

| 原编号 | 已有归属 / 证据 | 当前处置 |
| --- | --- | --- |
| A1/A2 两融、龙虎榜 | W28；数据扩张统一验收 | 已关闭原实施项 |
| A3/A4 质押、户数 | W29；数据扩张统一验收 | 已关闭，空源边界保留 |
| A5 审计意见 | W32/W43 | 已关闭原范围，UNDETERMINED/SKIPPED 不改成成功 |
| A6 问询、A7 ETF 份额、A8 指数估值、A9 商誉 | W33/W30/W31/资产负债材料接线 | 已关闭原范围，来源近似/历史窗边界保留 |
| B1 大宗、B3 技术指标、B4 财报质量、B5 行业轮动 | W37/W40/W35/W34 | 已关闭原实施项 |
| B2 机构持仓 | W39 基金持仓已接受；北向个股缺口有原证据 | 部分能力已接受，北向不重复发出同源重试任务 |
| B6 与“C 轮 C2”调研 | W41b 后续收口 5,821 条见修订日志 | 同一项，已关闭，不另建需求 |
| “C 轮 C4”解禁明细 | W42 | 已关闭原实施项 |
| “C 轮 C1/C3”分红/股息率 | 旧池分别为暂缓/待核 | 归 FUTURE，不因旧优先级自动采集 |
| 旧 Dossier/Thesis M1–M5 路线 | REQUIREMENTS v2.1 已归档，现行 v4.0 继续选择性复用 | 非当前实施顺序，不恢复旧 14 项待决或整套路线 |

## 管理决定与更新纪律

- 本次 Owner 请求使 PM 管理在本聊天生效；不新建 PM 聊天或第二执行总控，不向 OwlCodaE-PM 发消息。
- C2–C8 是 CLIENT-ENG 的连续候选。C6 两项反例由 C7 验收关闭，C7-01 由 C8 验收关闭；当前工程已接受，真实调用/质量/使用/DS 分层保留。2026-10-28 的 CLIENT-UI 是 Owner 明确新增的有界体验工作，不撤销 C8 接受，也不按候选编号继续拆任务。
- 2026-10-28 的公司研究内容 R1 已接受且 writer 冻结。此前把 Mionyee 的“作战室、自动监控、策略交易”整体排除属于范围收窄，**已由 2026-10-29 Owner 要求与 PRODUCT v3.0 覆盖**：市场、策略、风险、跟踪是完整产品范围；自动真实下单仍不在范围。原 RESEARCH-MAINLINE 只作为公司研究子合同，不再充当完整定义。
- Owner 已授权报告修复→主控验收→日线策略闭环的源码与离线实施，并明确允许本地 `owlrunkit@0.23.0` 接入。首项 assignment=`cosco-report-r1`，合同见 [BRIEF](../../delivery/CODEX-COSCO-REPORT-REPAIR-20261029/BRIEF.md)；第二项由 `daily-strategy-r1` 经一次具名返工 `rework-daily-strategy-r2` 完成并获主控接受，仍限源码与离线。既有真实调用额度不能移借，P5/服务/数据库迁移/Git权利未扩大。
- 在途 writer、已经接受的保证、真实模型许可、P5 冻结和未运行 DS 均保持原边界。新增需求先判断是否阻塞当前目标；无关项延后。
- 只在有意义事件到达时更新状态、证据、下一责任。历史旧状态保留原件，不靠重复读回、消息 ACK、定时检查或测试数量制造进度。
- PM 文档更新不签署真实报告、安装或业务接受。对“目前在线”“已派发”“已开始”等表述，须有相应时点和回执；否则写待接收/未核验。
