# Mionyee 股票分析与交易策略研究

日期：2026-10-29。结论用于重订 Lyra 的产品定义、范围和推进顺序。

**Mionyee 的完整对象是从市场和个股判断到策略选择、风险约束、验证、跟踪与复盘的研究系统。公司报告只是其中一个交付物。** Lyra 应以自己的时点证据、确定性计算、A→程序清单→J 和一次发送机制承接这条业务链；不照搬旧系统的评分、固定参数或运行拓扑。

本次范围覆盖 `mionyee` 的股票分析域、后期作战室、`mionyee-agent` 业务规划，以及 `mionyee-hermes` 的实际桥接、策略和短周期计划代码。以下将源码能力、设计意图和历史运行记录分别标注；没有启动参考项目、读取账户持仓或凭据，也没有重新跑其模型、回测或服务。源码存在不证明当前运行有效，更不证明策略盈利。各历史模块也未被证明已在同一公开入口端到端接通；样本外、风险和反馈服务的存在不能提升为全链路运行接受。

## 1 三条演进路线

| 路线 | 原件与性质 | 已经表达的产品能力 | 不能从中推出的结论 |
| --- | --- | --- | --- |
| 早期股票分析与策略引擎 | [五维评估源码](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/supporting/analysis/services/evaluation/stock_evaluation_service.py:768)、[策略分类源码](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/supporting/strategy/types.py:20) | 技术、资金、基本面、情绪、策略回测；观察与信念分层；策略筛选、参数、模拟和反馈 | 五维总分不能替代证据充分性；八种枚举不能证明八类实盘可用 |
| 智能体与作战室 | [Agent 业务规划](/Users/yeemio/AI/gitrep/mionyee-agent/docs/STOCK_ANALYSIS_BUSINESS_PLAN.md)、[作战室产品与架构决定](/Users/yeemio/AI/gitrep/mionyee/docs/superpowers/specs/2026-06-26-stock-war-room-product-architecture-decision.md) | 自然语言入口、历史研究延续；市场风格→题材轮动→个股打法；候选、持仓、传感器分开；监控与证据回流 | 规划中的工具与时间表不是交付；2026-06-26 文档自述 API 失败、fixture/degraded，不能当成今日稳定运行 |
| Hermes 后续承接 | [个股场景](/Users/yeemio/AI/gitrep/mionyee-hermes/mionyee_hermes/single_stock_scene_builder.py:24)、[股票脑适配](/Users/yeemio/AI/gitrep/mionyee-hermes/mionyee_hermes/stock_brain_adapter.py)、[真实对话接线](/Users/yeemio/AI/gitrep/mionyee-hermes/mionyee_hermes/mionyee_stock_conversation.py:774) | 注入行情/持仓/历史/审议，展示能力缺口；八策略本地适配、主线趋势约束、短周期计划与输出检查 | 本地评分不是旧库回测；场景构造器接受注入数据，单凭页面或状态名不能证明真实数据齐全 |

这三条路线有不同职责和时期，不能把后期某个只读 playbook 的禁止指令边界，扩大为“整个 Mionyee 不研究交易策略”。也不能把早期模拟模块的名字解读为已经连接券商。

## 2 完整业务链与源码证据

| 环节 | Mionyee 实际内容与定位 | Lyra 应承接的问题 |
| --- | --- | --- |
| 研究输入与连续性 | Agent 规划支持自然语言问题、行情/K线/新闻、历史分析检索和复盘；其中工具示例和部分 Skill 标注待创建 | 研究目的、周期、截点、关注池、是否持有及上次判断必须明确，规划不算实现 |
| 资料与证据组织 | [stock_packet_service.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/supporting/market/services/stock_packet_service.py)、[stock_evidence_packet.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/supporting/market/services/stock_evidence_packet.py) | 行情、公司、事件等材料按问题组织，逐项来源、时间、新鲜度和缺口；复用 Lyra CAS 与时点库 |
| 公司研究 | 早期五维评估包含基本面；Lyra 已有业务、行业、经营驱动、财务、情景、估值、反证的十章内容合同 | 保留并完成 Lyra 深研优势，不能将技术分数替代现金流、业务机制或估值假设 |
| 市场与行业环境 | [market_style_packet.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/supporting/market/services/market_style_packet.py:46)：风险偏好、大小盘、成长价值、趋势压力、流动性等；缺核心材料返回限制 | 同一截点回答当前环境是否支持某种策略；行情缺失不能被公司叙事填补 |
| 题材与机会 | [theme_rotation_packet.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/supporting/market/services/theme_rotation_packet.py)、[stock_playbook_packet.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/supporting/market/services/stock_playbook_packet.py)：阶段、驱动、角色、失效与监控条件 | 在支持池/自选池内发现和比较机会，解释入选、排除及等待；指数/ETF 可作环境参照，不混成个股候选 |
| 策略分类与比较 | [StrategyType](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/supporting/strategy/types.py:20)、[StrategySelectionService](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/strategy/strategy_selection_service.py)：生成候选、验证、选择并留存结果 | 对同一股票比较策略适配和周期，保留未选方案及理由；可以没有可用策略 |
| 策略参数与方案 | [ai_strategy_generation_service.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/strategy/ai_strategy_generation_service.py:1)、[entry_strategy_service.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/position/entry_strategy_service.py) | 入场/退出触发、价格依据、数量上限、失效、时间窗、风险预算构成有版本的条件方案；不是一句方向判断 |
| 历史验证 | [backtest_validation_service.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/validation/backtest_validation_service.py)、[out_of_sample_validation_service.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/validation/out_of_sample_validation_service.py)、[walk_forward_service.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/validation/walk_forward_service.py) | 确定性回测、样本外与滚动验证；公布样本、费用、成交假设、基准、回撤和失败，不只显示胜率 |
| 模拟与执行记录 | [ai_auto_trading_service.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/decision/ai_auto_trading_service.py:1)明确以自动模拟积累结果；[执行监控](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/strategy/strategy_execution_monitor.py:1968)对真实执行返回未实现 | 影子观察/模拟账本与用户真实成交记录分别保存，不能伪造真实交易或自动跟随 |
| 持仓与组合风险 | [portfolio_risk_service.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/risk/portfolio_risk_service.py:33)有集中度、相关性、回撤、VaR/ES 等路径 | 同一个股方案要结合持仓、可用资金、可卖数量、行业暴露与风险上限；复杂指标须满足数据条件 |
| 监控与提醒 | [a_share_war_room_trend_monitor_task.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/supporting/market/services/a_share_war_room_trend_monitor_task.py)、作战室决定区分任务提交与持续闭环 | 显式激活、有截止/频率/预算的条件跟踪；记录漏评、过期、失败和触发；通知权限另绑定 |
| 复盘与学习 | [decision_tracking_service.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/tracking/decision_tracking_service.py)、[strategy_effectiveness_evaluator.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/strategy/strategy_effectiveness_evaluator.py)、[strategy_feedback_loop.py](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/strategy/strategy_feedback_loop.py) | 比较当时证据/计划与后果，区分研究错误、择时、成交、风险及执行偏离；改方法产生新版本，不回写旧结论 |

## 3 交易策略不能省略的具体内容

早期八类分别是长期持有、趋势跟随、波段、均值回归、突破、做 T、日内，以及不适合交易。最后一项是合法的否决/等待结果，不是必须消除的失败。

| 策略族 | 核心问题 | Lyra 的承接顺序与条件 |
| --- | --- | --- |
| 长期持有/价值与分红 | 公司质量、合理估值、现金流与逻辑失效能否支持长期持有 | 纳入完整范围；先用报告给出的经营/估值条件，不硬套技术止损或短窗胜率 |
| 趋势跟随 | 大环境、行业及个股趋势是否一致，何时开始、失效或退出 | 第一个日线策略闭环的优先实现对象，与等待/无适配策略基线比较 |
| 波段 | 区间、回撤与反弹的可重复条件是什么 | 基础闭环成立后扩展，单独验证持有窗、退出规则与成本 |
| 突破 | 突破确认、量能、假突破风险和成交约束是否成立 | 与波段分别验证，不把“创新高”直接写成有效策略 |
| 均值回归 | 何时是可恢复偏离，何时是趋势改变 | 独立适用状态与否决条件，不能用越跌越买替代论证 |
| 有底仓做 T | 已有可卖持仓、资金、成本和日内成交条件是否允许 | 保留在完整路线后段；日内数据、准确可卖数量与交易机制就绪后才进入实现 |
| 无底仓日内往返 | 所研究证券和账户是否允许这一交易方式 | 不能照搬旧枚举；对不支持的 A 股现货场景明确不可执行，不能虚构可成交回测 |
| 不适合/等待 | 资料不足、环境不适配、没有触发、收益风险条件不足，分别是什么 | 第一轮即支持；技术故障、证据不足与研究上的否决是不同状态 |

Hermes 的[主线趋势框架](/Users/yeemio/AI/gitrep/mionyee-hermes/mionyee_hermes/ai_mainline_trend_strategy.py:104)按主线阶段→板块资金→相对强弱→入场质量→仓位→失效约束判断，并要求比较机会成本。可继承的是分析顺序；其中 AI 产业链映射和固定默认阶段属于特定策略假设，不能成为 Lyra 所有行业的永久真值。

Hermes 的[短周期计划](/Users/yeemio/AI/gitrep/mionyee-hermes/mionyee_hermes/short_term_trade_plan.py:11)明确要求标的、进入条件、仓位、预期收益、最大亏损、盈亏比、退出、止损、时间窗和失效条件。Lyra 应使用结构化事实和可复算公式完成这些义务。旧文件的 1R/1.5R、仓位百分比与 3–5 日模板只能作原项目实例，不能直接成为 Lyra 默认值。

## 4 需要明确拒绝的继承方式

1. **失败放行。** 旧回测验证的异常分支会对数据不足、服务不可用和其他错误返回 `passed=True`（[源码 285 行起](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/validation/backtest_validation_service.py:285)）。这证明存在风险路径，不等于所有回测都失败放行。Lyra 必须将“验证通过、证据不足、计算失败”分开，模型不能把后两者改签为通过。
2. **因反复不通过而降低标准。** 旧策略选择器在连续失败达到条件后启用自适应阈值，并降低胜率、Sharpe、年化门槛（[入口](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/strategy/strategy_selection_service.py:219)、[调整实现](/Users/yeemio/AI/gitrep/mionyee/applications/stock_analysis/domains/core/ai/services/strategy/strategy_selection_service.py:1670)）。Lyra 的验收标准在结果揭晓前冻结；失败保留，调参另立版本和验证窗。
3. **评分冒充验证。** Hermes 的[规则 MVP](/Users/yeemio/AI/gitrep/mionyee-hermes/mionyee_hermes/stock_strategy_evaluator.py:9)评分主要反映输入完整度；[八策略桥](/Users/yeemio/AI/gitrep/mionyee-hermes/mionyee_hermes/legacy_mionyee_brain_pack.py:126)明确不执行旧库回测和持久化。它们可帮助组织界面，不能显示为经验证的策略有效性。
4. **格式完整冒充语义成立。** 短周期计划采用正则检查字段，并在部分路径追加限制说明。文本出现“止损”“仓位”不证明价格关系、数量、资金或交易机制正确。Lyra 需要校验具体值与数据来源，承重未解只能发布研究草案。
5. **模拟冒充真实执行。** 旧自动模拟和真实执行未实现路径分别记录；Lyra 也必须区分信号、模拟成交、用户录入成交与实际账户事实。
6. **历史状态冒充实时判断。** 固定主线映射、旧持仓记忆、旧市场快照、fixture 和历史在线检查都带日期与来源；不跨截点偷用，也不将缺失持仓解释为空仓。
7. **把一次正确变成自动学习有效。** 反馈服务存在不证明反馈改善了后续样本。新的策略版本必须保留旧版本的全部机会、拒绝、失败和未成交分母，禁止事后改写触发条件。

交易规则必须版本化，不能从旧策略描述永久固化。2026-10-29 查询的[上交所现行交易规则通知](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/c_20260424_10816482.shtml)列明 2026-07-06 生效，并存在暂缓实施条文。Lyra 的各交易机制须按证券、交易所、日期和适用条文取值；不能只拿发布日期或一种证券的例外推定全市场规则。本文不据此修改既有规则源码。

## 5 与 Lyra 现有资产的映射

| 产品能力 | Lyra 当前基础 | 仍缺什么 |
| --- | --- | --- |
| 公司研究与证据 | 十章报告、R1 内容链、CAS/时点库、确定性经营计算、A/J、版本和追问 | 海控 7 项引用格式与 HTML/PDF 阅读问题；完整真实质量和使用接受 |
| 市场与机会 | 历史行情、指标、行业/指数、事件与参照库等既有资产 | 客户端同截点的市场/行业/个股联合判断与候选比较，逐项覆盖和新鲜度读回 |
| 策略方案 | 可复用报告结论、事实表、执行内核及 J 机制 | 策略独立身份、适用周期、候选比较、结构化触发/退出/风险、版本和审议合同 |
| 验证与模拟 | 旧 P5 有结算/分母纪律，可参考方法 | 客户端独立的策略回测、样本外、成交约束、模拟账本；P5 结果不能充作策略验证 |
| 持仓风险 | 当前报告主线没有已接受的完整客户端能力 | 用户确认的持仓/资金/可卖数量时点；集中度、关联暴露与方案风险适配 |
| 跟踪与复盘 | 旧事件、调度、版本与全机会分母思想 | 客户端计划条件跟踪、到期/失效、通知、人工记录对照和归因；不复用 P5 权限启动 |

上述“缺少”指未形成已接受的客户端端到端能力，不声称仓库没有任何相关工具或旧模块。

## 6 产品裁定

Lyra 完整定义改为**本机单用户的 A 股研究与交易策略工作台**，覆盖公司研究、市场机会、策略方案、持仓风险、跟踪复盘。报告仍是第一项必须完成的交付物；策略计划、验证记录与复盘是同等明确的后续交付物，不能再排除到产品定义之外。

实施顺序与逐阶段出口由[产品合同](PRODUCT.md)和[唯一任务表](status/PROJECT-TASKS.md)维护。本次完成研究和文档重订，不启动策略实现、不恢复真实模型调用、不启停服务或监控、不改变 P5。原有接受与失败记录继续有效。
