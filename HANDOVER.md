# Lyra · A 股个人研究平台 — 完整交接文档

> **2026-10-27 当前入口更正**：本文保留为 2026-10-26 的历史交接，不再作为当前派工或实时状态。现行形态为单平台客户端；最近正式裁定 C8 ACCEPT（工程候选），C7-01 已关闭，本轮返工结束，真实调用待明确授权与精确调用条件。当前产品、阶段与下一责任分别取 [产品合同](docs/PRODUCT.md)、[生命周期地图](docs/PRODUCT-LIFECYCLE.md)、[任务表](docs/status/PROJECT-TASKS.md)。下文 C1/SaaS、旧 M1–M5 开工顺序、PID/在线状态与“无在飞”等均为原时点记录，不延续为今天事实。P5 的 R29/R30 与明确保留的 Q3 收尾待办仍按其原范围有效；旧定时器不因本次整理恢复。

> **2026-10-26 R31 增补**：单股研究报告产品线已落地（任务 LYRA-SINGLE-STOCK-REPORT-SAAS-20261026，候选 C1 冻结于 `delivery/SINGLE-STOCK-RESEARCH-DELIVERY/`）——PRODUCT v2/REQUIREMENTS v3.0、sr 命名空间产品实现（`src/stock-research/` + `src/db/sr-migration.sql`）、执行器泛化 `runPermittedCall`（A/J 零变化）、三份样板、868/868 测试、浏览器全链实证。真实模型调用未授权未发生（申请 DECISIONS.md §2）。本文以下内容为产品线之前的轨 A 交接，仍然有效。

状态：2026-10-26，总控编制。交接目的：Owner 要求新线程先根据 Metis 实现写完整需求文档。本文覆盖背景、现状、全部资产与未竟事项，使新线程无需读会话记录即可接手。

---

## 一、项目是什么

Lyra 是 Metis（足球研究平台，`/Users/yeemio/AI/gitrep/metis`，**只读参照不得修改**）架构向 A 股研究的移植。核心结构继承自 Metis 并在 Lyra 中重新实现：

| 继承结构 | Metis 出处 | Lyra 实现 |
|---|---|---|
| 原件库（CAS 内容寻址、哈希校验读、不可变） | `packages/storage/src/artifacts.ts` | `src/artifacts/store.ts` |
| 时点读取（五时间字段、as-of 过滤、封存 manifest） | SPEC §6 | `src/pintime/*`、`docs/specs/POINT-IN-TIME.md` |
| 执行内核（permit + send-once + UNKNOWN + 截止） | `packages/persistence/src/execution.ts` | `src/kernel/*`、`docs/specs/EXECUTION-KERNEL.md` |
| A→程序清单→必经 J（方法12结构） | `packages/method-football/src/method12.ts` | `src/method/text.ts`、`src/research/*` |
| 结论继承（方法15 INHERITED/STANDALONE） | `method15.ts` | `src/research/post-event.ts` |
| 全机会分母复盘 | `packages/result-review` | `src/settlement/*`、`src/schedule/*` |
| 旅程测试安装门 | `tests/runtime-closure/product-journey.test.ts` | `src/journey/journey.test.ts`（13/13） |

**项目定位**：个人 A 股研究工作台。不提供投资建议、不对外分享、不自动下单。界面标注"个人研究记录，非投资建议"。

## 二、关键决定（已冻结，不可绕过）

| 决定 | 出处 | 理由 |
|---|---|---|
| 研究范围：沪深主板个股 26 + 宽基 ETF 4（上证50/沪深300/中证500/中证1000） | R17/R18 | 排除创业板/科创板/北交所 |
| 研究池 v2：中远海控+中国移动替换入（宏和科技+永鼎股份出） | R29.2 | Owner 指定 4 标的，513330/195901 不加入 |
| 模型：A=Sol/high、J=Sol/high（sol-high 双阶段） | R27 | Owner"模型用sol-high"；J 用同模型合法两阶段，不宣称跨模型独立 |
| 失效阈值：个股 12%、宽基 5% | R29.3 | 预声明规则 B 击穿 10%（业绩预告类 51.21%>50%），按纪律升 12% |
| 方法版本：method@p2-v1（哈希 bb4d6e6a…） | P2 冻结 | A 指令/J 义务/清单规则/八维度映射 |
| 三条独立版本轴：方法 / 数据与适配器 / 执行计划与授权 | PLAN §10 | Metis 最贵返工教训的预防 |
| 20 日窗口 / 下一交易日开盘价 / 后复权自算因子链 / 行业基准=申万一级（当时版本） | SETTLEMENT-REVIEW | 结算口径全部冻结 |
| 预注册主指标：可成交选择样本 20 日方向命中率 | R13/P5 | 子分组一律描述性；最小样本量每方向 ≥30 |
| P5 观察起点 2026-10-26 → 首评最早 2027-05-31 | R29.3 | 评价窗口内零阈值/方法/指标变更 |

## 三、五阶段完成状态

| 阶段 | 状态 | 停止条件 | 证据 |
|---|---|---|---|
| P0 底座 | ✅ ACCEPT | 旅程测试全绿（模拟模型） | `delivery/P0-DELIVERY.md` |
| P1 数据 | ✅ ACCEPT | 任意历史日期完整封存零泄漏（86 封存实证） | `delivery/P1-DELIVERY.md` |
| P2 研究 | ✅ 收口（Gate-M 代审通过 R29.1） | 一份真实周度研究通过人工审阅 | `delivery/P2-DELIVERY.md`、`delivery/GATE-M-REPORT-601318.md` |
| P3 事件与复盘 | ✅ 收口 | 一次真实事件完整旅程 + 结算器（9 例真实手算全对） | `delivery/P3P4-DELIVERY.md` |
| P4 历史参照 | ✅ 收口 | 一份有合法匹配 + 一份只有缺口的研究都通过审阅；阈值校准报告产出 | `delivery/P3P4-DELIVERY.md` |
| P5 前瞻观察 | **进行中**（2026-10-26 起） | 2027-05-31 首评 | `delivery/P5-FREEZE-CHECKLIST.md` |

**数据扩张波（W27–W46）**：P5 前的数据面增强——15 个适配器、20 处材料接线、约 13 万条新事实。证据 `delivery/DATA-EXPANSION-DELIVERY.md`。

## 四、系统现状数字

| 项 | 值 |
|---|---|
| 测试电池 | **804/804 全绿**（2026-10-26 13:15 交接收口复验：零失败 43.6s；`node --import tsx --test --test-concurrency=1 $(find src -name '*.test.ts' \| sort)`） |
| TypeScript | tsc --noEmit 零错误 |
| 真实事实总量 | **523,272 条**（PG 表 pintime_fact） |
| 原件库 | ~200MB CAS（data/artifacts/） |
| 研究结论 | 2 条（真实 sol-high：601318 ABSTAIN / 002384 ABSTAIN） |
| 真实模型调用 | 5 次（Gate-M 2 + P5 首跑 2 + 骨架 1），全部 permit 审计 |
| 文档 | 1191 行（PLAN/AGENTS/README/specs ×10/delivery ×6/REVISION-LOG/需求池） |
| 修订记录 | R1–R30（`docs/REVISION-LOG.md`） |
| 运行环境 | OrbStack PG18（lyra-pg，127.0.0.1:5433）+ Node 24.18.0（nvm）+ codex CLI |

## 五、代码结构（src/ 全览）

```
src/
├── contracts.ts          # 全部共享类型（三版本轴/SettlementZone/AOutput/JOutput 等）
├── canonical.ts           # canonicalJsonSha256 哈希
├── artifacts/store.ts     # CAS 原件库（六条款：写入校验/哈希读/区间读/不可变/0700）
├── pintime/               # 时点读取（五时间字段/as-of/supersedes/封存/泄漏测试）
├── kernel/                # 执行内核（lock/permit/executor/recovery/transport/sol-transport）
├── method/text.ts         # 方法正文 v1 冻结（A 指令/J 义务/清单规则，哈希钉扎）
├── research/              # 研究链（inputs/checklist/simulated/tables/report/gate-m/rotation/quality/industry-valuation/indicators）
├── conclusion/            # 结论对象（object/settlement——字段间校验/SettlementZone ANOMALY 扩展）
├── settlement/            # 结算（decimal 定点/reference/excess/tradability/settle/etf/denominator）
├── rules/                 # A 股规则（limit 涨跌幅/st-timeline ST 时点表）
├── schedule/              # 调度（windows 四时段/queue/overflow/weekly 轮转/weekend-runner/metrics/nightly 引擎）
├── events/                # 事件检测（detect 六类/inquiry 问询）
├── reference/             # 历史参照（excess/groups/library/calibrate/broadbase）
├── adapters/              # 15 个数据适配器（baostock/cninfo/sw/sina/emrisk/emfund/embalance/emdc/valuation/audit/emblock/eminstitution/emsurvey/emunlock）
├── backfill/              # 全部回填 runner（pool-market/pool-financials/l1/l2-pdf/membership/pool-candidate/emdc/emrisk/emfund/embalance/emunlock/emblock/eminstitution/emsurvey/audit/sw/valuation）
├── verify/                # 封存验证（seal-any-date）
├── journey/               # 旅程测试安装门（13 测试：零释放/send-once/UNKNOWN/截止/泄漏/三版本轴）
└── web/                   # 本地 Web 看板（W47 已交付：Metis 设计系统全量移植，style.css 26KB + report-reader 形态）
```

## 六、数据面全景（15 个适配器 × 研究池 30 标的）

| factKind | 适配器 | 事实数 | 时点口径 | 消费维度 |
|---|---|---|---|---|
| DAILY_BAR | baostock | ~145K | 交易日 15:00 | D5 表格 |
| ADJUST_FACTOR | baostock | ~350 | 除权日 15:00 | D5 复权列 |
| FINANCIAL | baostock | ~2.3K + 604 候选 | pubDate 次日 00:00 | D1 财务+质量指标 |
| BALANCE | embalance | 2.3K | 披露日次日 00:00 | D1/D7 商誉 |
| ANNOUNCEMENT | cninfo | ~41K | 公告时刻（日精度 D+1） | D3/D4 标题摘录 |
| SW_INDEX_BAR | sw | 149K | 交易日 15:00 | D6 行业基准+E1 宽基 |
| INDEX_VALUATION | valuation | 2.4K | 数据日次日 00:00 | E1 估值序列 |
| INDEX_MEMBERSHIP | baostock | 105K | 当日 15:00 | 历史参照 |
| INDUSTRY_CLASS_VERSION | sw | 18K | 计入日期+1 | D6 归属 |
| PLEDGE_RATIO | emrisk | 12.5K | 快照日+1 00:00 | D7 风险 |
| HOLDER_COUNT | emrisk | 2.4K | 披露日+1 00:00 | D7 风险 |
| MARGIN_BALANCE | emdc | 12.1K | 交易日 15:00 | D5 资金 |
| DRAGON_TIGER | emdc | 258 | 上榜日 15:00 | D5（前视列剔除） |
| BLOCK_TRADE | emblock | 1.5K | 交易日+1 00:00 | D5（含折溢率） |
| ETF_SHARE | emfund | 264 | 季末+92 天 | E4 份额 |
| FUND_HOLD | eminstitution | 209 | 报告期+92 天 | D5 机构关注度 |
| SURVEY_RECORD | emsurvey | 5.8K | 披露日+1 00:00 | D5 机构调研 |
| UNLOCK_DETAIL | emunlock | 204 | 解禁日+1 00:00 | D4 解禁明细 |
| AUDIT_OPINION | audit | 300 | 年报公告口径 | D7 审计意见 |
| REGULATORY_INQUIRY | events | 195 | 事件时点 | D7 问询事件 |
| TRADE_CALENDAR | baostock | 4.3K | 当日 15:00 | 调度 |
| STOCK_BASIC | baostock | 604+ | 抓取时刻 | D7（截点不可见时缺口） |
| STOCK_POOL | baostock | — | 当日 15:00 | 历史参照 |

## 七、运行命令速查

```bash
# 环境
export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"
cd /Users/yeemio/AI/gitrep/Lyra

# 测试
npm run typecheck
node --import tsx --test --test-concurrency=1 $(find src -name '*.test.ts' | sort)

# 旅程安装门
node --import tsx --test --test-concurrency=1 src/journey/journey.test.ts

# 真实研究（单标的 Gate-M 路径）
node --import tsx src/research/gate-m.ts --subject 600519 --dry-run     # 干跑
node --import tsx src/research/gate-m.ts --subject 600519 --execute    # 真跑

# 夜间引擎（周度轮转 6 标的/晚）
node --import tsx src/schedule/nightly.ts --date 2026-10-27 --dry-run        # 骨架干跑
node --import tsx src/schedule/nightly.ts --date 2026-10-27 --commit          # 模拟 commit
node --import tsx src/schedule/nightly.ts --date 2026-10-27 --commit --transport real  # 真实 sol-high

# 结算回填
node --import tsx src/schedule/nightly.ts --date 2026-10-27 --settle-due

# Web 看板
node --import tsx src/web/server.ts  # → http://127.0.0.1:3456

# 数据回填（全部断点续跑）
node --import tsx src/backfill/pool-financials.ts   # 财务（Q3 刷新同命令）
node --import tsx src/backfill/l1.ts --stocks data/pool-stocks.txt  # 公告元数据
node --import tsx src/backfill/emdc.ts --from 2024-10-25 --to 2026-10-25  # 两融/龙虎榜
# 其余 runner 各自 CLI 参数见文件头

# PG 容器
docker exec lyra-pg psql -U lyra -d lyra  # 交互
docker exec lyra-pg pg_isready -U lyra     # 健康检查
```

## 八、修订记录编号体系

- **R1–R16**：`docs/REVIEW-20261025.md`（规划评审）
- **R17–R21**：`docs/FREEZE-P0-20261025.md`（P0 冻结审阅）
- **R22 起**：`docs/REVISION-LOG.md`（运行修订——每条含裁定/理由/落点/证据）

关键修订：R22（截止终态三分支）、R23（申万轴来源落实）、R24（池冻结 v1）、R25（参照库过滤）、R26（结算面三项裁定）、R27（模型 sol-high）、R28（simulated 字段语义）、R29（Owner 授权代决三项：Gate-M 通过/池 v2/P5 冻结 12%）、R30（真实通道持续授权）。

## 九、P5 观察期运行计划

| 时段 | 动作 | 调用量 |
|---|---|---|
| 每交易日晚 18:00–23:30 | `nightly --real --commit`（周度轮转 6 标的 × A+J） | ~12 次/晚 |
| 公告检测（15:30–23:00 每 30 分钟） | 事件后研究（优先于周度，继承周度结论） | ~10 次/周 |
| 周六 | 结算回填 + 周报（零模型调用） | 0 |
| 财报季（4/8/10 月） | 事件翻倍 | ~20 次/周 |
| **合计** | | **~70 次/周**（SC-8 预算闸冻结） |

第一次效果评价：**2027-05-31**（预注册主指标：可成交选择样本 20 日方向命中率，最小样本量每方向 ≥30）。

## 十、未竟事项与 Owner 期望

### Owner 刚要求的（本文档的目的）
> "写一次完整的交接文档……然后要求新线程，先根据 metis 的实现，对照股票分析场景，写完整的需求文档。"

**新线程的首要任务（2026-10-26 二次更新）**：Owner 灵魂批评后追加指令"从市场分析和调研、需求分析的层面，结合已落地功能，倒推完整需求文档规划"，再追加"多线程完成需求文档""一次性多派点"——**已完成：`docs/REQUIREMENTS.md` v2.1 完成稿（正文总纲 + 六分册 2,747 行深度规格）**。分册（var/req-parts/）：A 对象规格（字段级/状态机/路由映射）、B 功能规格（27 条 FR 五件套）、C 市场矩阵（13 产品 × 8 维证据矩阵）、D UI/UX 规格（五页线框/47 组件类核对）、E 实施与评价（M1–M5 合同要点/轨 B 指标公式/预算总账）、F 驱动变量源（当日实测，可用源 9 个）。编制记录（writer 身份 + 子代理会话 ID）在正文 §11。实核更正已入正文：库内 factKind 实为 24 类（试运行 2 类未入官方清单）。**待 Owner 评审冻结（R31，决策点 14 项分四组见 §10）后，新线程从 M1（对象层与金样板）开工**；冻结前的任何实施不动。

### Owner 灵魂批评（2026-10-26 交接收口后，浏览交付物时）——需求文档的第一约束

> "我们大概看了你的交付物，感觉没有自己的灵魂。就是到底有没有站在股票分析的角度，来做一个AI应用？"

总控裁定：**批评成立**。诊断五条：①研究对象是"一场比赛"不是"一家公司"——一次性研究→20 日判决，无随时间加深的公司认知档案，两连 ABSTAIN 是判决合同问错了问题的症状；②输入按数据源（19 面）组织，不按公司特异的提问组织（茅台问批价、海控问运价周期、运营商问 capex 与分红）；③AI 被当判卷器——固定包/固定表/一次性，不能追证、不能迭代假设、不能与过去的自己辩论；④交付的是判决不是认知——论点、收敛机制、证伪条件缺失，读者读完学不到关于公司的东西；⑤人不在环里——系统"对 Owner 运行"，Owner 只能读不能问。**保留项（资产不拆）**：时点纪律/执行内核/结算口径/诚实 ABSTAIN——灵魂装在这副骨架上，不推倒。**对需求文档的强制要求**：从股票分析的第一性问题出发（公司档案怎么组织、论点树怎么生成演化、模型怎么多步取证、论点交付物长什么样、论点怎么审计兑现），Metis 降级为工程参照（内核/时点/结算），不再是产品模板。**待 Owner 拍板**：方法层重做与 P5 评价窗口"三不改"冻结的张力——总控建议双轨（冻结轨照跑不掺假，新方法层另立评价口径，互不污染）。

### 在飞任务
- **无**（2026-10-26 13:15 交接收口核验：无在飞 writer、无半成品改动、无排队的 workflow/闲时任务）
- **W47 已交付**（2026-10-26 12:00，code-writer-pro · GLM-5.3 · 子代理 agent_196d0311）：照 Metis 设计系统重做 Web 看板（Owner 对 W46 裸 HTML 不满——"metis的源代码你看不到吗？"）——原样移植 Metis 全部 CSS 变量/色板/排版/组件类名/响应式断点/reduced-motion + report-reader 形态（维度导航、A/清单/J/结算 tabs、Coverage 八维 pill、证据抽屉）；零 `<script>`、零 CDN；804/804 全绿、tsc 0、四轮浏览器截图核验无缺陷。服务常驻 **PID 89113 → http://127.0.0.1:3456**（重启命令 `node --import tsx src/web/server.ts`，日志 var/web-w47.log）

### 已知缺口（不阻塞但登记在案）
- 交易日历覆盖止于 2026-10-23（需扩展才能支持 10-26 后的调度预览）
- 申万 2014 版 pre2014 前缀行无 l1IndexCode（2014-02-21 前事件无行业归属——窗口外）
- 北向个股面 2024-08 停发（证据 `var/w39-north-diag.txt`）
- ETF 复权因子未取（宽基结算按指数点位，不阻塞）
- 目录尚非 git 仓库（Owner 未明示初始化）

### 定时器
- **automation-85f03d86 已退役**（2026-10-26 交接收口）：原每 30 分钟循环（迭代+电池+提醒，累计 26 轮）；退役原因=指令基线过时（534+ 基线、"三项待决"均已 R29 关闭），且其"三线派工/WebSearch 补需求池"与交接后模式冲突。完整指令备份在 `var/retired-automation-85f03d86.txt`（可原样重建）。**其承载的唯一仍有效待办转移至本节**：10-31 披露期截止后，清除 `.backfill/pool-fin-progress.json` 中 `2026:Q3` 键并重跑 `node --import tsx src/backfill/pool-financials.ts` 完成 Q3 收尾（当前池内 9/26 股已披露）

---

## 十一、文档体系地图（16 文件）

| 文件 | 内容 |
|---|---|
| `README.md` | 入口、状态、索引 |
| `AGENTS.md` | 控制入口与约定 |
| `docs/PRODUCT.md` | 产品定位 |
| `docs/PLAN.md` | 总规划 v1.1（十节+修订记录） |
| `docs/ARCHITECTURE.md` | 架构总纲 |
| `docs/REVIEW-20261025.md` | R1–R16 出处 |
| `docs/FREEZE-P0-20261025.md` | R17–R21 出处 |
| `docs/REVISION-LOG.md` | R22 起运行修订 |
| `docs/REQUIREMENTS-BACKLOG.md` | 需求池（A 类已清/ B 类已清/ C 轮待评估） |
| `docs/REQUIREMENTS.md` | 产品需求文档 v2.0（灵魂版，草案待 Owner 冻结 R31） |
| `docs/specs/P0-FOUNDATION.md` | P0 合同 |
| `docs/specs/P1-DATA.md` | P1 合同 |
| `docs/specs/P2-RESEARCH.md` | P2 合同（含 Gate-M） |
| `docs/specs/P3-EVENTS-REVIEW.md` | P3 合同 |
| `docs/specs/EXECUTION-KERNEL.md` | 执行内核合同（EK-n.m） |
| `docs/specs/POINT-IN-TIME.md` | 时点合同 |
| `docs/specs/` 其余 6 份 | ASHARE-RULES / DATA-SOURCES / RESEARCH-METHOD / SCHEDULING / HISTORICAL-REFERENCE / SETTLEMENT-REVIEW |
| `delivery/` 6 份 | P0/P1/P2/P3P4/DATA-EXPANSION/GATE-M-REPORT |

---

交接完毕。新线程从"读 Metis 源码 → 写 Lyra 完整需求文档"开始。
