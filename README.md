# Lyra · A 股研究与交易策略工作台

**执行与PM已分工（2026-10-31）**：[Lyra 总控 · Astra-max 接管回执](docs/handoff/controller-transfer-20261031/TAKEOVER.md)确认聊天 `01a190b9-2256-7563-9353-29af2c6f4d98` 为唯一执行总控，负责后续工程安排与推进；本聊天 Lyra-PM 保留产品、优先级和生命周期管理。既有接受、行业8日缺口和权限边界原样交接。

**本机单用户的 A 股研究与交易策略工作台**：公司研究、市场机会、策略计划、持仓风险、跟踪复盘连成完整流程；单股是研究单元。研究报告、策略与验证记录、观察及复盘均须可查证、追问和保留版本。SaaS、账户套餐、收费、商业发布和券商自动执行不在当前范围。P5 冻结观察轨 A 独立保留。

2026-10-29 按 Owner 要求完成 [Mionyee 全链路研究](docs/MIONYEE-RESEARCH-20261029.md)和[完整产品重订](docs/PRODUCT.md)。海控引用/源码/PDF与首族[日线策略离线R2](delivery/CODEX-DAILY-STRATEGY-20261029/REVIEW.md)接受保留。随后已查明海控缺段并补入807个交易日，海控/沪深300各1162/1162；现有客户端已接入日线策略，新增策略页已在主会话侧边栏读回。[本轮裁定](delivery/CODEX-STRATEGY-CLIENT-20261029/REVIEW.md)接受源码、已齐资料与临时客户端路径；行业仍缺8日，完整输入及整体L2保持阻塞。真实A/J、严格历史验证、安装与Owner使用未接受，writer已停止。

## 当前状态

截至 2026-10-28：**研究内容 R1 ACCEPT（源码与离线内容链）**，财务口径修正及茅台的问题—原件—经营计算—A/J—报告已接通（[内容裁定](delivery/CODEX-RESEARCH-CONTENT-20261028/REVIEW.txt)、[离线模拟报告](delivery/CODEX-RESEARCH-CONTENT-20261028/offline-engine/REPORT.html)）。[C10 首页与报告 UI 离线接受](delivery/CODEX-C10-ACCEPTANCE-20261028/REVIEW.txt)保留，Owner 视觉与实际使用接受待确认。C9 视觉 REWORK；此前 [C8 工程接受](delivery/CODEX-C8-ACCEPTANCE-20261027/REVIEW.txt)与 C7-01 关闭保持有效。本聊天 Codex 负责产品/架构与 PM；真实调用已获单独授权并执行：原海控Codex六次轮在第6次J的改判绑定校验失败后停止，完整报告未发布；[结果](delivery/CODEX-COSCO-CODEX-REAL-20261028/RESULT.txt)保留。两项阻塞已完成[离线修正](delivery/CODEX-COSCO-OFFLINE-REPAIR-20261028/REVIEW.txt)；Owner随后授权的成稿/J两次补跑均成功，生成[受限报告](delivery/CODEX-COSCO-CODEX-TAIL-20261028/RESULT.txt)。原分章的7段表格正文误填引用编号，QA阻止完整发布；PDF可读性未接受，HTML网页视觉核验未完成。本轮已停止，没有追加调用。DS NOT_RUN，离线接受不代签运行安装或报告质量。准确状态和下一责任见[任务表](docs/status/PROJECT-TASKS.md)。

DSH 通道 R2 已[接收源码与离线产品路径](delivery/CODEX-DSH-CHANNEL-20261028/REVIEW.txt)：可显式选择 DSH，官方 SDK 与现有只读凭据已接线，原授权、一次发送、UNKNOWN 与发布门保留。配置与依赖见[交付说明](delivery/CODEX-DSH-CHANNEL-20261028/DELIVERY.md)，R2 修正与勘误见[返工交付](delivery/CODEX-DSH-CHANNEL-20261028/r2/DELIVERY.md)和[证据勘误](delivery/CODEX-DSH-CHANNEL-20261028/r2/EVIDENCE-CORRECTION.md)。上述R2接收时真实服务调用为零；后续DSH与Codex尝试见当前任务表，完整真实报告与安装运行仍未接受。

本机产品入口：`npm run sr:web` → `http://127.0.0.1:3470`；本次未核正式进程或安装身份。2026-10-31核实此前61279临时预览已离线，旧PID611已是系统进程，不据旧回执停止或重启。新总控按需要在原授权内另建隔离回环实例并记录新身份；原运行指引见[RUNBOOK](delivery/SINGLE-STOCK-RESEARCH-DELIVERY/RUNBOOK.md)，策略资料路径及SHA见[交付](delivery/CODEX-STRATEGY-CLIENT-20261029/DELIVERY.md)。

客户端 Codex 通道的默认分工（Owner 2026-10-28 指定）：规划、分析、成稿与追问使用 `gpt-6.1-terra / max`，必经 J 复核使用 `gpt-6.1-sol / high`。每步调用账分别记录模型和推理档位。`LYRA_SR_REAL_MODEL` / `LYRA_SR_REAL_EFFORT` 仍可显式覆盖整轮；`LYRA_SR_REAL_REVIEW_MODEL` / `LYRA_SR_REAL_REVIEW_EFFORT` 可单独覆盖复核。该分工适用于 `LYRA_SR_TRANSPORT=real`；显式 DSH 仍使用其 DeepSeek 配置。默认模拟模式及真实调用授权门保持不变，模型默认设置不自动启动或恢复任务。

轨 A 的 P0–P4 与数据扩张历史接受保留；P5 按 R29/R30 进入冻结观察期，池 v2、个股 12%/宽基 5%，方法/阈值/指标不改。首评最早 2027-05-31，并须满足原样本条件。旧 Gate-M/池选择/阈值“三项待决”已由 R29 关闭；当前运行连续性和累计样本本轮未核验。历史交接与原验收继续保留，见[生命周期地图](docs/PRODUCT-LIFECYCLE.md)。

## PM 管理入口

| 要回答的问题 | 唯一入口 |
| --- | --- |
| 产品为什么做、怎样算完成、谁能决定什么 | [产品合同与 PM 约定](docs/PRODUCT.md) |
| 从需求到真实使用、维护和退出，走到哪一层 | [全生命周期地图](docs/PRODUCT-LIFECYCLE.md) |
| 当前做什么、谁负责、阻塞在哪里、下一步是什么 | [去重任务表](docs/status/PROJECT-TASKS.md) |

仅有交付、裁定、运行/业务证据或 Owner 决定变化时更新。旧需求池不再自动补池派工；本次未创建定时器或新的执行链。C7 原文档保留于[首次 PM 记录](delivery/PM-SETUP-20261027/CHANGE-RECORD.json)；C8 接收后的状态更新另有[文档前后身份记录](delivery/CODEX-C8-ACCEPTANCE-20261027/PM-UPDATE.json)，不改写冻结清单。

## 阅读顺序

1. **`AGENTS.md`** — 项目控制入口：第一天就生效的约定、控制规则、边界。
2. **`docs/PLAN.md`** — 轨 A 历史总规划 v1.1（已冻结）；当前客户端顺序由 PRODUCT 的 L0–L4 管理，R31 标明边界。
3. **`docs/PRODUCT.md`** — 当前产品合同、成功标准与 PM 维护规则；`docs/REQUIREMENTS.md` 为 v4.0 详细需求。
4. **`docs/ARCHITECTURE.md`** — 架构总纲：继承/裁剪声明、四项结构约束、三条版本轴、分层、P0 简化内核边界。
5. **`docs/specs/`** — 九份专项合同（下表）。
6. **`docs/REVIEW-20261025.md`**（R1–R16 出处）、**`docs/FREEZE-P0-20261025.md`**（R17–R21 出处）— 决策归档。

## 文档体系

| 文档 | 内容 | 冻结状态 |
|---|---|---|
| `docs/specs/P0-FOUNDATION.md` | P0 实施合同：Goal / 六条 Done-when、非目标、工件、技术栈 | **已冻结** |
| `docs/specs/EXECUTION-KERNEL.md` | 执行内核：permit、send-once、UNKNOWN 处置、截止自身持有、恢复、旅程测试安装门（EK-n.m） | **已冻结** |
| `docs/specs/POINT-IN-TIME.md` | 时点读取与原件库：五时间字段、四类时点对象、泄漏测试、CAS（含修订口径声明） | **已冻结** |
| `docs/specs/ASHARE-RULES.md` | A 股市场规则：时点版本化涨跌幅规则表、ST 时点表、T+1、停牌、复权、披露日历、更正公告 | **已冻结** |
| `docs/specs/RESEARCH-METHOD.md` | 研究方法：个股八维度 / 宽基七维、两类决策合同、A→清单→J、判断义务、输入分层、结论对象 | **结构已冻结**，方法正文 P2 |
| `docs/specs/HISTORICAL-REFERENCE.md` | 历史参照库：六类事件、宽基状态参照、机械选定群组、判断义务对接、失效阈值校准程序 | **已冻结**，参数 P4/P5 |
| `docs/specs/DATA-SOURCES.md` | 数据源：来源总表（含宽基）、三层回填、退市缺口、适配器规则、限流退避 | 随 P1 |
| `docs/specs/SCHEDULING.md` | 调度：四时段、优先级、溢出降级、预算、时钟日历、周末复盘（SC-n.m） | 随 P3 |
| `docs/specs/SETTLEMENT-REVIEW.md` | 结算与复盘：参考价裁定、结算字段、全机会分母、不重叠样本、宽基结算、预注册主指标（SR-n.m） | 随 P3，参数 P5 |

各合同内标注"未决问题"的条目由所属阶段实施合同裁定时关闭，不阻塞当前冻结。

## 跨文档裁定记录

- 调度未决 3（溢出降级者与停牌的参考价口径）→ 已由 `SETTLEMENT-REVIEW.md` SR-3.1 裁定关闭（参考价锚定结论完成时刻，统一覆盖四类情形）。
- 执行内核未决 3（截止时钟源）→ 已由 `SCHEDULING.md` SC-10.3 冻结（本地时钟 + 交易日历校准，±60 秒容忍）。
- 执行内核未决 2、4，时点合同未决 3、4 → 已在 P0 冻结审阅中裁定（R21）。
- A 股规则未决 1（创业板/科创板 ST 涨跌幅）→ 随 R17 关闭；主板 ST 系数改为时点规则表（R19）。

## 边界重申

个人研究记录，非投资建议。数据仅个人使用，原件不外传。Metis 仓库只读。未经用户要求不 commit、不 push（当前非 git 仓库）。
