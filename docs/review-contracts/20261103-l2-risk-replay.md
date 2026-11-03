# 修复已有持仓风险与连续回放状态

状态：I-22、I-23、I-24 已实现并完成下列隔离检查；等待总控对稳定候选作 ACCEPT/REWORK，尚无修复接受。

审查候选：[`6c7cd196f20a4222d1f97708de7402b2c50ebeb0`](https://github.com/yeemio/Lyra/tree/6c7cd196f20a4222d1f97708de7402b2c50ebeb0)，tree `843eb5b97617ffda179ebb06e2ee2adf03bf19fc`。PR base=`main@6c7cd196f20a4222d1f97708de7402b2c50ebeb0`；head=`review-20261103/l2-risk-replay`，初始合同提交身份见 PR。

## 确认问题与原证据

以下原报告行仅作问题依据。审查方的实测声明保持原身份；总控以固定源码及就近合同/调用链核对，未把它们改记为本机执行。

| 编号、分类 | 源码证据 | 触发及影响 | 修复方向与验收 |
|---|---|---|---|
| **I-22** `candidate_defect`：已确认的可卖数量被解锁日期覆盖 | [账户映射 37–41](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/strategy/plan.ts#L37-L41)；[可卖计算与卖出 31–64](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/strategy/execution.ts#L31-L64) | 用户输入持有1000、可卖200，取得/解锁日期均已过去；在快照当天，代码直接把全部1000视为可卖，`initialDate` 未发挥约束。**合成输入实测得到 sellable=1000，SELL1000 FILLED。**新买入批次的基本 T+1 并不能消除这个已有持仓问题。 | 快照时点以明确可卖数为权威；后续解锁必须有完整状态转换依据。验收：同日卖出最多200，剩余数量受约束；新买入当日不可卖，下一交易日规则另验证。 |
| **I-23** `candidate_defect`：改变回放开始日可以跳过已错过的首个机会 | [请求校验与调用 59–100](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/strategy/workbench-runner.ts#L59-L100)；[状态初始化和入场 25–97](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/strategy/replay.ts#L25-L97) | 只要求 window.from 晚于 signalDate，再从窗口首日重新初始化 pending。**同一 planHash 实测：7/28 开始为跳空错过、0买入；改为7/29开始则 BUY700@10.82元。**没有承接此前状态，改变统计窗口就改变原计划是否仍可交易。 | 从信号后首个交易日连续回放，或载入绑定完整前史的检查点；展示截取窗口不能重置业务状态。验收：任意截取起点的结果必须等于完整回放的相应切片，先前错过/失效/到期不可复活。 |
| **I-24** `candidate_defect`：标的压力损失预算未扣已有持仓风险 | [数量计算 44–65](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/strategy/plan.ts#L44-L65)；[正常计划调用 78–90](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/strategy/plan.ts#L78-L90)；[输入名称 74](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/strategy/workbench-render.ts#L74) | 最大持仓金额扣了 held，最大压力损失却只计算新增 q。界面称“该标的最大压力损失预算”。**实测：已有1900股，10.70元到10.04元的压力损失在费用前已1254元，预算600元，仍给 SIZED800、显示压力损失559.68元。**这是计划与风险展示错误；当前回放不会因此自动给已有仓位加仓。 | 区分已有、增量和合计风险，并按用户确认的总标的预算约束；已有风险超限必须明确显示。验收：上述例子不再显示满足600元预算；费用、持仓、现金和股数能逐项复算。 |

## 完整行为与验证

账户快照当日以确认的可卖量为权威，之后解锁有明确状态依据并遵守新买入T+1。回放从信号后首个交易日连续推进，或绑定完整前史检查点，展示窗口不得复活此前错过/失效/到期计划。压力损失分已有、增量、合计，按用户确认的总标的预算约束，已有超限明确显示；费用/现金/股数可复算。

持有1000可卖200当天最多卖200、新买入当日不能卖；同planHash换展示起日等于完整回放相应切片，包含跳空错过反例；已有1900股、10.70到10.04、预算600不得再显示SIZED800且满足预算。保留所有机会记录与realReviewDone/executionEligible/efficacyAccepted否定边界，不接真实账户、不改变来源缺口和原八日依赖。

允许路径：

- `src/stock-research/strategy/**`
- `docs/review-contracts/20261103-l2-risk-replay.md`

## 授权、交付和停止条件

Owner 已授权这批经核对的问题修复、验证、对应分支提交/推送及 Draft PR 迭代。唯一代码作者为原普通 Chat（6ae99497-9154-83e8-ba4d-807175210ae2），当前总控负责合同、传输和稳定候选接受。若 Chat 无写工具，可提交完整补丁/文件，由总控机械发布同一作者的结果。保持同一 Chat，不另派作者。

只允许该 PR head 与下列源码/就近测试及本合同。确有必要的类型/调用者联动须在交付中逐项解释；不得顺手重构。所有 PR 初始 base 均为审查基线；同一作者可按依赖选择顺序，在对应修复 head 上非强制更新或显式采用另一已接受 PR 的提交，不向 main 合并。

禁止 main merge、release、部署、服务安装、真实模型调用、采集补数、真实账户与业务库写入/迁移、P5激活/重跑/历史改写，以及发布 data/var/delivery/.owlcoda 或凭据。源 SQL 及隔离测试库可作为源码修复，不向原业务库应用。PM 独占文件（README、AGENTS、PRODUCT、REQUIREMENTS、PRODUCT-LIFECYCLE、PROJECT-TASKS、REVISION-LOG）不并写。I-05 属现行合同冲突，排除此批修复，不改变 ASHARE-RULES §6 及冻结停牌/窗口口径。

适用验证在稳定候选完成后运行：项目 typecheck、受影响行为/调用链回归、diff检查；使用公开合成输入/隔离数据库。不是严格 TDD 授权，不强制先写失败测试。每条通过必须附实际命令、输出、环境与准确 head；未运行列明原因，不把报告原93测试当新候选证明。UI/PDF变动须提供与候选绑定的实际呈现证据。

停止条件：每个问题的完整行为出口成立，提供稳定 head、完整 changed paths/diff 与适用验证；当前总控接收。若无 GitHub 写工具，完整可发布补丁/文件即本次传输出口。一个初始结果加一次具名窄返工后先由总控重评，不自动无限重试或改换作者。源码接受不自动等于安装、整体L2、真实A/J或效果接受。

## 本次实现与实际验证（2026-11-03）

修复父提交：`36a1c84a982a9442562fcff9e15260c572a22b77`；未采用其他 PR 提交，base 不变。唯一代码作者为本 Chat。

| 问题 | 实现行为与文件 |
|---|---|
| I-22 | `execution.ts` 汇总及逐批卖出共用可卖规则。快照确认数量优先；只有快照日之后的明确解锁日才可解锁余量。卖出扣减确认余量，过去解锁日不能在后续回放日自动释放剩余股份；模拟新增股份保留 T+1。 |
| I-23 | `replay.ts` 固定计划从信号后首个交易日连续推进至请求终点，再截取事件、机会和净值。`continuity` 保留所有窗口前记录及明确标注范围的累计指标；展示窗口指标为空，不以累计收益冒充窗口收益。历史规则 IS/OOS 仍独立，J 门仍必经。 |
| I-24 | `plan.ts` 使用 `TOTAL_SUBJECT_MARK_TO_STRESS_V1`：已有持仓按当前参考买价至压力退出价计损失，退出费用按一次合并订单计收，新增损失为合计减已有，合计受总标的预算约束。已有超限时数量为0并给具名原因；不以历史成本抵减当前风险。`contracts.ts` 明确分解字段，旧冻结记录缺字段时不推断合计值。 |

`render.ts` 与 `workbench-render.ts` 同时展示已有/新增/合计损失和合并退出费用，标明已有超限；截取窗口明确展示连续前史与累计指标的时间范围。`risk-replay.test.ts` 使用公开合成生成器创建新的合成 A/J 夹具，身份始终为 STATIC_SIMULATED_FIXTURE；没有生成真实模型意见或覆盖任何既有原件。

兼容性：新增风险口径及情景费用解释进入新计划哈希，并可能改变历史验证哈希。旧静态 A/J 不自动成为新结果的复核；原校验仍拒绝错绑。没有重写旧计划、旧 A/J、旧样本或 P5 参数，也未改 I-05 的停牌/窗口口径。

实际环境为 Node v24.22.1、npm 11.9.0。复用 PR #6 在相同 package-lock 下通过 npm ci 安装的依赖目录，未声称对本工作树另做独立安装接受。

| 检查 | 实际结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `node --import tsx --test src/stock-research/strategy/risk-replay.test.ts src/stock-research/strategy/risk-input.test.ts` | 11 tests，11 pass，0 fail，0 skip；包括正常 strictWorkbenchResult→工作台 HTML 调用链与授权否定字段 |
| `git diff --check` | exit 0 |
| 实际 HTML 生成与内容断言 | 通过；产物为独立合成策略页和工作台片段，含1254元既有风险、0新增数量、超限原因与累计时间范围 |
| 浏览器视觉呈现 | NOT_RUN：尝试启动已有 Chromium 时退出，`process_singleton_posix.cc:297 socket() failed: Operation not permitted (1)`；未取得截图，不声称浏览器视觉通过 |

未验证边界：依赖未公开 delivery 原件的 `strategy.test.ts`、workbench 集成与旧静态夹具复算未运行；实际八日缺口、严格历史 PIT、独立开盘、逐日规则/公司行为、真实账户/A-J、安装及业务效果保持原边界。没有 PDF 改动，没有采集、模型或业务数据库操作。
