# 修复历史材料截点与冻结基准身份

状态：修复合同；当前仅建立 Draft PR，尚无修复接受。

审查候选：[`6c7cd196f20a4222d1f97708de7402b2c50ebeb0`](https://github.com/yeemio/Lyra/tree/6c7cd196f20a4222d1f97708de7402b2c50ebeb0)，tree `843eb5b97617ffda179ebb06e2ee2adf03bf19fc`。PR base=`main@6c7cd196f20a4222d1f97708de7402b2c50ebeb0`；head=`review-20261103/pit-lineage`，初始合同提交身份见 PR。

## 确认问题与原证据

以下原报告行仅作问题依据。审查方的实测声明保持原身份；总控以固定源码及就近合同/调用链核对，未把它们改记为本机执行。

| 编号、分类 | 源码证据 | 触发及影响 | 修复方向与验收 |
|---|---|---|---|
| **I-01** `candidate_defect`：解禁事后结果被提前放入历史研究 | [适配器 171–194](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/adapters/emunlock.ts#L171-L194)；[研究输入 629–650](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/inputs.ts#L629-L650) | 解禁明细整行存入 `typedValue`，统一标为解禁日次日可得；研究输入仅删“序号”。返回行含“解禁后20日涨幅”等字段时，未来结果会跟随明细进入较早截点。**实测：D+20 的 77.7 数值在 D+1 的模型材料中仍存在。** | 对事件事实使用字段白名单；事后表现拆成独立事实并绑定自身成熟时间和取得时间。验收：D+1、D+19 输入不得含 D+20 结果；较晚资料到达不改变旧封存。 |
| **I-02** `candidate_defect`：历史参照群组是可变现值，读取不受研究截点约束 | [构建 238–280](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/reference/build.cli.ts#L238-L280)；[存储 271–295](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/reference/library.ts#L271-L295)；[读取 1306–1315](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/inputs.ts#L1306-L1315) | 后一天构建含事后窗口的群组，再研究较早 cutoff，读取的是按 `group_key` 覆盖后的统计；查询没有 cutoff，存储也没有保存顶层版本绑定。**静态完整调用链确认。**事后统计本身合理，但这样送入历史研究会泄漏后来事件及结果。 | 群组按不可变版本发布，保存成员、成熟窗口、输入最大可用时间和 materialized time；研究包固定引用具体版本。验收：追加未来事件或结果后，旧 cutoff 的材料与哈希不变。 |
| **I-03** `candidate_defect`：行业估值把精确截点推进到当日收盘 | [截断时间 1361–1366](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/inputs.ts#L1361-L1366)；[重建截点 413–425、459](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/industry-valuation.ts#L413-L459) | 原始 cutoff 被 `slice(0,10)`，随后重建为上海时间 15:00。盘前或盘中研究可能使用原截点之后才可见的收盘事实。**静态确认**，不是仅显示时间不准确。 | 全链传递原始 instant，业务日期另作字段；派生材料绑定实际输入 fact IDs。验收：上午研究在插入当日下午行情后不发生变化；时区跨日用例也保持正确。 |
| **I-04** `candidate_defect`：行业/指数基准身份没有贯穿冻结与结算 | [结论身份 204–220](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/conclusion/object.ts#L204-L220)；[结算重新解析 136–149](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/settlement/settle.ts#L136-L149)；[SR 当前池回退 280–304](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/evidence.ts#L280-L304) | 传统结算在当前数据库重新按 cutoff 找行业，未直接使用原研究冻结的基准身份；后来回填的历史归属能改变选择。SR 缺历史归属时回退当前池代码，行业名称还优先取当前池。ETF 也存在当前池映射依赖。**静态确认。** | 冻结基准代码、归属 fact ID、映射版本与哈希，结算和报告共同消费。缺历史归属应具名缺口，当前代理须显式降级。验收：修改当前池、增加历史回填后，旧报告与旧结算仍使用原基准。 |
| **M-01** `candidate_defect`：行业 PE 和分位被转成对象字符串 | [inputs.ts:1367–1374](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/inputs.ts#L1367-L1374) | `Dec` 对象使用 `String()`。**实测应为10的值得到 `[object Object]`。**污染正常 D2 材料，但没有证明所有结论因此变化。 | 使用 `decToString`；验收检查最终研究输入中的数值文本，而非只检查底层计算。 |

## 完整行为与验证

解禁材料仅含该字段自身可用时间内的白名单事实；参照群组发布不可变版本并由输入包绑定，旧截点不读取后来统计；行业估值保留精确 instant，业务日期独立；冻结并消费原行业/指数及归属事实身份，缺历史映射具名降级；Dec 数值正确序列化。不得把最新修订历史值提升为严格 PIT，不得借机改变停牌/结算窗口规则。

覆盖 D+1/D+19 不含 D+20字段、后续群组/归属/当前池变化不改变旧材料、上午截点不读下午事实、UTC/上海跨日、冻结基准结算一致、最终材料数值字符串。源 SQL 变动仅用隔离测试数据库，不触及本机业务数据库。

允许路径：

- `src/adapters/emunlock*`
- `src/research/inputs*`
- `src/research/industry-valuation*`
- `src/reference/**`
- `src/db/reference-migration.sql`
- `src/conclusion/**`
- `src/settlement/settle*`
- `src/settlement/excess*`
- `src/settlement/etf*`
- `src/stock-research/evidence*`
- `docs/review-contracts/20261103-pit-lineage.md`

## 授权、交付和停止条件

Owner 已授权这批经核对的问题修复、验证、对应分支提交/推送及 Draft PR 迭代。唯一代码作者为原普通 Chat（6ae99497-9154-83e8-ba4d-807175210ae2），当前总控负责合同、传输和稳定候选接受。若 Chat 无写工具，可提交完整补丁/文件，由总控机械发布同一作者的结果。保持同一 Chat，不另派作者。

只允许该 PR head 与下列源码/就近测试及本合同。确有必要的类型/调用者联动须在交付中逐项解释；不得顺手重构。所有 PR 初始 base 均为审查基线；同一作者可按依赖选择顺序，在对应修复 head 上非强制更新或显式采用另一已接受 PR 的提交，不向 main 合并。

禁止 main merge、release、部署、服务安装、真实模型调用、采集补数、真实账户与业务库写入/迁移、P5激活/重跑/历史改写，以及发布 data/var/delivery/.owlcoda 或凭据。源 SQL 及隔离测试库可作为源码修复，不向原业务库应用。PM 独占文件（README、AGENTS、PRODUCT、REQUIREMENTS、PRODUCT-LIFECYCLE、PROJECT-TASKS、REVISION-LOG）不并写。I-05 属现行合同冲突，排除此批修复，不改变 ASHARE-RULES §6 及冻结停牌/窗口口径。

适用验证在稳定候选完成后运行：项目 typecheck、受影响行为/调用链回归、diff检查；使用公开合成输入/隔离数据库。不是严格 TDD 授权，不强制先写失败测试。每条通过必须附实际命令、输出、环境与准确 head；未运行列明原因，不把报告原93测试当新候选证明。UI/PDF变动须提供与候选绑定的实际呈现证据。

停止条件：每个问题的完整行为出口成立，提供稳定 head、完整 changed paths/diff 与适用验证；当前总控接收。若无 GitHub 写工具，完整可发布补丁/文件即本次传输出口。一个初始结果加一次具名窄返工后先由总控重评，不自动无限重试或改换作者。源码接受不自动等于安装、整体L2、真实A/J或效果接受。
