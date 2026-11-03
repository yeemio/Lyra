# P1 数据阶段 — 实施合同

状态：v1，2026-10-25，总控冻结（P0 已验收，按 `docs/PLAN.md` §8 进入 P1）。上位合同：`docs/specs/DATA-SOURCES.md`（随 P1 冻结）、`docs/specs/POINT-IN-TIME.md`、`docs/specs/EXECUTION-KERNEL.md` EK-7（两级退避，本阶段落地）。修订依据：R16a/b/c、R4、R8、R11、R15、R17（主板收窄）、R18（宽基）、R22（截止归属，不涉数据面）。

## Goal

建立四个数据面的真实接入与回填，使**研究池 30 标的 + 覆盖池（中证 800 历史成分中的沪深主板股票）能按任意历史日期完整封存且不泄漏未来信息**；冻结研究池清单。

## Done-when（全部满足即停）

1. **适配器真实冒烟**：BaoStock（日线原始价/复权因子/季频财务带 pubDate/交易日历/按日股票池/沪深300+中证500 按日成分）与巨潮（公告元数据，含 orgId/column 正确处理）各以真实小窗请求成功，响应原件入库（带 first_observed_at）。
2. **EK-7 两级退避落地**：适配器层退避（30s 起步逐次加倍、至少 3 次后暂停上报落库为状态记录）有注入测试；数据源并发 ≤2。
3. **四类时点对象真实样本**：公告/财务 pubDate、行业分类版本、指数成分归属、复权因子——各有真实数据入库且 as-of 读回正确（含 supersedes 链例：复权因子按日版本）。
4. **任意历史日期封存验证**：抽定 ≥3 个历史日期（跨申万 2014/2021 版本切换两侧），对研究池标的执行 buildSeal → verifySeal 全绿 + assertNoLeakage 零 violation（真实数据，非合成）。
5. **研究池 30 标的冻结**：候选计算器按 PLAN §1 标准（主板、非 ST、上市满一年、60 日日均成交额 ≥1 亿、申万一级行业每业 ≤3 只）从真实数据算出候选，总控裁定冻结清单（个股 26 + 宽基 ETF 4，ETF 代码按流动性核定）；计算依据可回溯（输入数据与参数随清单存档）。
6. **回填启动且可持续**：L1 公告元数据（研究池范围全量优先）与覆盖池行情/成分/复权/财务回填以断点续跑方式运行，完成度可从 DB 读出；**全量完成不是本合同停止条件**（回填可跨日继续），但研究池标的范围内的数据必须齐至可支撑第 4 条验证。

## 非目标

- 事件检测与调度（P3）；PDF 正文解析为结构化事实（L3 按需）；AKShare 全量接入（退市补缺按 DATA-SOURCES §3 触发时再做）；宽基估值历史与 ETF 份额来源若 P1 内核实不完，登记缺口并后置（FREEZE §五）。
- 不调用任何模型（模拟模型仍是唯一模型面）。

## 工件与 writer 边界

| 工件 | 文件 | writer |
|---|---|---|
| BaoStock 桥 + 适配器 + 退避 | `adapters/baostock/*.py`、`src/adapters/baostock.ts`、`src/adapters/backoff.ts` | W4（pro） |
| 巨潮元数据适配器 + L1 回填 | `src/adapters/cninfo.ts`、`src/backfill/l1.ts` | W5 |
| 申万分类版本 + 交易日历 + ETF/指数 + 封存验证 + 池候选 | `src/adapters/swclass.ts`、`src/adapters/calendar.ts`、`src/backfill/pool-candidate.ts`、`src/verify/seal-any-date.ts` | W6（后波） |
| 事实入库/映射 | 复用 `src/pintime/*`、`src/db/pintime.ts`（只读依赖，不改） | — |

## 运行事实

- BaoStock：项目本地 venv `.venv-p1`（baostock 0.9.40，Python 3.14），连通已证（600519 真实日线）。
- 巨潮：`www.cninfo.com.cn/new/hisAnnouncement/query` 连通已证；参数格式（orgId、沪市 column）在适配器内修正。
- 全部请求走适配器（版本化、退避、原件入库）；绝不绕过适配器直连写库。
