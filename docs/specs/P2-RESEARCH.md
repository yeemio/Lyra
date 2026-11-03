# P2 研究阶段 — 实施合同

状态：v1，2026-10-25，总控冻结（P1 已验收，按 `docs/PLAN.md` §8 进入 P2）。上位合同：`docs/specs/RESEARCH-METHOD.md`（§2 研究链/§3 决策合同/§5 输入分层/§6 判断义务/§7 继承/§8 结论对象）、`docs/specs/EXECUTION-KERNEL.md`（EK-4.4 输入预算、EK-10 安装门）。修订依据：R2（输入分层与行情表格化）、R12（指引降权）、R18（两类标的）。

## Goal

把研究链从"模拟模型的骨架"推进到"真实可运行的周度研究"：冻结方法正文 v1；实现研究输入组装器（封存材料→A 的分层输入包）；实现模型路由接口（模拟已通、真实端点为具名待授权占位）；扩展研究报告读回。**真实模型调用是本合同内的一个独立门（Gate-M），待 Owner 有界授权后执行；不阻塞其余构建。**

## Done-when

1. **方法正文 v1 冻结**：A 指令全文（八维度评估框架 + 财务数字声明 + 候选决策与最强反证结构）、J 裁决义务全文（逐项裁决/decision_bearing/最强待回应论证/改判理由/判断义务〔R12 降权版〕）、清单抽取规则 P2 版（八维度来源映射）。以带 SHA-256 的冻结文本对象入库（方法版本轴 `method@p2-v1`），代码常量与文档镜像一致（哈希钉扎）。
2. **研究输入组装器**：`assembleResearchInput(subject, cutoff)` → 复用封存（seal）→ 按八维度映射候选材料（行情表/财务指标表/公告摘录/行业归属与基准/指数与成分/复权因子/风险项）→ 行情序列**表格化无损表示**〔R2〕→ L0（背景）/L1（会改变判断的证据）/L2（索引目录）分层 + 每层字节预算 + coverage 回执（送达/裁剪/缺口三态）→ 超总预算时 INPUT_OVER_BUDGET（不截断）。**用冻结池真实数据产出 ≥3 份样本输入包**（至少 2 股 + 1 ETF），程序校验：引用全部可解析（factId/artifact 哈希）、行情表可逆无损（与库内事实逐值一致）、coverage 完整、分层可读回。
3. **模型路由接口**：`ModelTransport` 抽象（调用合同→输出，接 EK permit/runModelCall）；`SimulatedTransport`（现有模拟模型升级接线，安装门继续使用）；真实端点占位返回具名 `MODEL_PROVIDER_UNAUTHORIZED`（无凭据、无猜测端点）。集成测试：真实组装器 → SimulatedTransport → A → 清单 → J → 结论对象落库 → 读回，全链走公开 API。
4. **研究报告读回**：结论对象扩展研究报告视图（A 摘要、清单逐项、J 裁决、证据引用下钻到原件哈希、输入包 coverage）；CLI 可读回渲染（P2 无 UI 要求）。
5. **Gate-M（真实模型，待授权）**：Owner 授权（通道、账户、有界额度）后，对 1 个冻结池标的跑一次真实周度研究（A=Sol/high 1 次、J=Astra/xhigh 1 次，permit 全程绑定），产出真实研究报告；**人工审阅通过 = P2 停止条件**。授权申请与花费预算单列，不并入本合同默认范围。

## 非目标

调度与四时段（P3）；事件检测（P3）；历史参照消费（P4；P2 的 J 义务文本含其判断义务框架但不接参照数据）；真实模型通道的实现与凭据（Gate-M 授权后另立合同）；UI。

## 工件与 writer 边界

| 工件 | 文件 | writer |
|---|---|---|
| 方法正文冻结 | `src/method/text.ts`（+文档镜像 `docs/method/P2-METHOD-TEXT.md`） | W12（pro） |
| 模型路由 | `src/kernel/transport.ts` + simulated 接线 | W12（pro） |
| 研究输入组装器 | `src/research/inputs.ts`、`src/research/tables.ts` | W11（pro） |
| 报告视图与读回 | `src/research/report.ts`（视图）+ CLI | W11（pro） |
| 集成测试（组装器→模拟→落库→读回） | `src/research/research-journey.test.ts` | 总控（整合波） |

W11/W12 只新建文件，不改既有文件；`src/journey/*`、kernel 既有文件不动。

## 验收

总控整合后按 AGENTS 分级派 code-reviewer（研究链为高判断密度域）；Done-when 1–4 为本合同可验收面，Gate-M 单独验收（人工审阅）。
