# 修复历史材料截点与冻结基准身份

状态：修复实现候选；待当前总控验证与接受，仍为 Draft PR。

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

## 本轮实现与依赖记录（2026-11-04）

本 PR 初始合同提交为 `5bed83186241cb6b15b6f38c162dde6702f631f2`，GitHub base 仍为原 main 基线。为共同消费已接受的送达证据与结论构造约束，显式采用 PR3 R2 `9b3714e2eff3a6bd12b71cc1c2950639a8a98507`；非快进依赖合并为 `46b36970133065927279a34aa192c599183d1cb0`，两个 parent 依次为上述 PR1 初始提交及 PR3 R2。实现提交直接以该合并为 parent；精确 head/tree、文件字节、SHA-256 和稳定候选检查记录随本次交付 MANIFEST。未采用 PR2、PR6、PR7 的提交，不重写任何已接受身份。

| 问题 | 本轮完整行为与限界 |
|---|---|
| I-01 | `emunlock@p2-pit` 只把白名单事件字段存入事件事实。D+20 结果独立为 `UNLOCK_OUTCOME`，要求逐日完整、无冲突且已观察的交易日历证明 20 个交易日成熟，并以实际取得时间作为可用时间下限。日历缺口不猜成熟；非法结果标量拒绝。正常研究入口也对白名单外的旧整行字段二次剔除。原始 CAS 保留，不将回填事件事实称作严格 PIT。 |
| I-02 | 一次完整构建作为不可变参照版本保存，包括成员、事件证据事实、成熟窗口、输入事实哈希、最大可用/观察时间及构建时间。保存前从绑定事实复算窗口和统计；发布时数据库强制实际 `published_at`，更新、删除和清空被触发器拒绝。研究按精确 cutoff 读取完整版本并绑定其哈希；空版本有独立身份，不回退到旧可变表。旧表留作审计，不自动迁移为历史可见版本。源 DDL 本环境未执行。 |
| I-03 / M-01 | 估值装载全链传递原始 instant，上海业务日另列；实际输入 fact IDs 作为精确子集封存。上午 cutoff 不推进到收盘；PE/分位使用 `decToString`，最终材料可见 `10`、`0` 而非对象字符串。 |
| I-04 | v2 研究包 L0 固定送达基准代码、归属完整事实、映射快照/版本/哈希；新结论强制绑定，结算与报告消费原身份。股票结算核对原 fact ID 内容，不重新选择后来回填；SR 不从当前池回填历史归属/名称，市场代理明确标注。ETF 映射需要 CAS 首次观察证据，配置自报旧 frozenAt 不足以成为历史基准；无法证明时为 CURRENT_PROXY，材料明确降级且正式结算拒绝。旧 v1 包可核验读取，但不自动补写或用于缺冻结身份的新结论。 |

### 必要的类型、调用者及夹具联动

- `src/contracts.ts`、`src/stock-research/contracts.ts`：增加可兼容旧对象的冻结身份字段，生产新对象由构造器强制校验。
- `src/pintime/seal.ts`：新增派生材料精确输入子集；仍必须全部满足现有 selector 与 as-of 可见性，不改变原 as-of 合同。
- `src/research/validation.ts`、`src/research/report.ts`：接入 PR3 已接受的送达门并检查基准 L0 原文/事实封存；文本报告读原结论身份，不猜旧映射。
- `src/schedule/nightly.ts`、`weekend.ts`、`weekend-runner.ts` 及就近测试：结算传递原结论基准/截点；夹具显式构造冻结身份。保持既有结算起点和窗口规则，保留 PR3 R2 的未来排程日期与事件原件路径。
- `src/research/research-test-helper.ts`：合成结论夹具绑定明确的冻结身份，默认缺历史归属如实为 MISSING；不伪装真实来源。
- `src/stock-research/engine.ts`：PLAN 行业提示使用本轮证据包的截点归属，不使用当前池标签。
- 现有输入预算测试精确核对实际送达的材料/层/事实集合；允许同一事实由另一份已送达 L0 材料提供，不将仅降级目录当成送达证据。

### 验证出口与未验边界

公开合成用例覆盖事件白名单及交易日成熟、上午/跨时区估值和数值文本、精确输入封存、不可变参照身份及伪造窗口拒绝、回填后的旧结论/结算/报告稳定、ETF CAS 首见与代理拒绝、SR 归属/名称及市场代理展示，并回归 PR3 证据语义和周末编排。查询端口替身只证明函数行为，不证明 PostgreSQL SQL。

`src/reference/versions.pg.test.ts` 仅在显式提供 `LYRA_REPAIR_TEST_PG` 时执行源迁移、幂等、不可变触发器、强制发布时间、cutoff 与子集封存；无默认业务库回退。本环境没有该隔离连接或 PG/容器工具，源 SQL、新旧 PG 调用者及依赖私有资料的套件列为 NOT_RUN，由总控在准确候选补验。未运行完整取数/建库 CLI、真实模型或自然语言报告、UI/PDF 视觉、安装、历史/P5迁移与效果观察；文本/表内容断言不冒充视觉验收。不得把新身份保证解释为旧修订事实的严格历史 PIT，也不把 PR3 的 aFrom 拒绝解释为 I-16 可信恢复。

I-05 冻结停牌/窗口规则不变；行业八日、真实资料、真实 A/J、账户和效果边界不变。下一步先由总控接受或具名返工本候选，不在本轮继续实施 PR4/PR5。
