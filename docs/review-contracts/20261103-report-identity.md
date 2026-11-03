# 修复报告版本、不可变证据、对齐计算与追问引用

状态：修复合同；当前仅建立 Draft PR，尚无修复接受。

审查候选：[`6c7cd196f20a4222d1f97708de7402b2c50ebeb0`](https://github.com/yeemio/Lyra/tree/6c7cd196f20a4222d1f97708de7402b2c50ebeb0)，tree `843eb5b97617ffda179ebb06e2ee2adf03bf19fc`。PR base=`main@6c7cd196f20a4222d1f97708de7402b2c50ebeb0`；head=`review-20261103/report-identity`，初始合同提交身份见 PR。

## 确认问题与原证据

以下原报告行仅作问题依据。审查方的实测声明保持原身份；总控以固定源码及就近合同/调用链核对，未把它们改记为本机执行。

| 编号、分类 | 源码证据 | 触发及影响 | 修复方向与验收 |
|---|---|---|---|
| **I-17** `candidate_defect`：报告与证据在持久化后不能保持可验证一致 | [报告 hash 写入 683–699](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/store.ts#L683-L699)；[读回 740–762](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/store.ts#L740-L762)；[页面证据读回 383–392](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/server.ts#L383-L392) | hash 包含应用端时间，DB 却另用 `now()`，正常往返后可能无法按合同复算。HTML/PDF/追问及恢复读取任务目录固定 JSON，未按已接受包哈希重新验证；可解析的覆盖或损坏能改变旧版证据或恢复材料。**静态确认；未声称每次时间必不同。** | 持久化同一规范化报告正文；证据、计算、A/J/QA 按不可变 artifact 身份引用并校验。验收：DB 往返 hash 一致，改单字段即失败；发布后修改工作文件不能改变旧版呈现和恢复结果。 |
| **I-18** `candidate_defect`：版本身份未贯穿组装、HTML、追问与历史导航 | [版本生成 674–678](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/engine.ts#L674-L678)；[HTML 与线程查询 374–407](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/server.ts#L374-L407)；[旧看板链接 944–955](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/web/pages.ts#L944-L955) | HTML 算出了 `v` 对应版本，最终仍渲染未指定版本的 `report`；追问同样未绑定所选版本。组装插入后写盘失败，再次执行可产生同 reportId 多版本；聊天线程中的标量子查询遇多行会失败。旧看板历史行也丢 conclusionId，转到默认最新。**静态确认。PDF 路由确实使用所选版本，未混同。** | 组装幂等；读取明确 `(reportId, version)`，默认最新显式排序；追问和链接携带版本，消除多行标量查询。验收：两个明显不同版本的 HTML/PDF/追问一致，历史行打开原结论，中断重跑不凭空增版。 |
| **I-19** `candidate_defect`：不同日期窗口仍计算“超额” | [计算与检查 309–384](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/compute.ts#L309-L384)；[航运专用修正 466–477](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/compute.ts#L466-L477) | 股票与基准分别取最后 N 根，再直接相减；日期不一致仅登记检查失败。只有特定航运修正路径把部分不匹配值置空。**实测：股票 10/1–10/20 涨10%，指数 10/3–10/22 涨20%，仍产出 −10 个百分点“超额”。** | 所有标的共用同起止日、同价格口径的比较计算；不可比较时置空并保留原因。验收覆盖缺日、不同末日、不同基日，不能只修一个样板公司。 |
| **I-20** `candidate_defect`：追问引用没有验证其确实来自送达材料 | [校验 358–363](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/transport.ts#L358-L363)；[保存 1071–1080](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/engine.ts#L1071-L1080) | 只验证 citations 是数组，任意 tableId 都能保存，并统一标成 COMPUTED；`callId` 也为空。**实测 `NOT_DELIVERED` 引用被接受。**主报告较严格的证据约束没有覆盖正常追问。 | 校验器接收实际送达表目录、版本及 hash；证据类型保真，绑定调用收据。验收：不存在/未送达/错版本引用被拒绝；缺证据可诚实回答，但不能呈现伪引用。 |
| **M-02** `candidate_defect`：报告材料日期和缺口文案写死 | [HTML 897–902](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/render.ts#L897-L902)；[PDF 194](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/pdf.ts#L194) | 只要有 market-snapshot，仍写固定年报/半年报、10/23运价、没有三季报；PDF 还固定行情及历史日线日期。新材料到达后会错误描述时点。**静态确认；原固定样板未必受影响。** | 日期和缺口从实际包元数据派生。验收换一份新快照或增加三季报，HTML/PDF同步变化。 |
| **M-03** `candidate_defect`：通用表头提前把 MBRevenue 认作营业收入 | [report-tables.ts:23](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/report-tables.ts#L23)；[计算口径限制 200–202](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/compute.ts#L200-L202) | 计算层明确要求同公司同期间核实前不得改称营业收入，通用渲染却固定标“来源营业收入”。**静态确认。**属于语义标签越界，未证明数值本身错。 | 未核实时保留“来源收入字段 MBRevenue”；经核对后才使用具名科目。验收覆盖有/无官方对照的不同公司和期间。 |

## 完整行为与验证

报告规范化正文和持久化时间一致可复算；发布、恢复、HTML/PDF/追问消费绑定哈希的不可变材料，拒绝工作目录覆盖。组装幂等，读取显式 reportId+version，默认最新有排序，线程查询不因多版本失败；历史链接携带原结论身份。超额比较必须同起止日期和价格口径，不可比置空并具名说明。追问引用限实际送达表/版本/哈希，保留真实类型及调用收据。HTML/PDF材料日期和缺口来自包元数据；MBRevenue未经同公司同期间官方对照不得改称营业收入。

两个明显不同版本的HTML/PDF/追问一致、DB往返hash一致/改单字段拒绝、发布后工作文件覆盖不改变旧产物、插入后写盘失败不凭空增版；非航运标的缺日/不同末日/基日不可比；无效/未送达/错版引用拒绝；不同快照和三季报元数据同步渲染；MBRevenue有/无官方对照。使用合成材料，PDF变动需实际渲染检查；不引入普通客户端新L2接线或新产品阶段。

允许路径：

- `src/stock-research/**`
- `src/web/pages*`
- `docs/review-contracts/20261103-report-identity.md`

## 授权、交付和停止条件

Owner 已授权这批经核对的问题修复、验证、对应分支提交/推送及 Draft PR 迭代。唯一代码作者为原普通 Chat（6ae99497-9154-83e8-ba4d-807175210ae2），当前总控负责合同、传输和稳定候选接受。若 Chat 无写工具，可提交完整补丁/文件，由总控机械发布同一作者的结果。保持同一 Chat，不另派作者。

只允许该 PR head 与下列源码/就近测试及本合同。确有必要的类型/调用者联动须在交付中逐项解释；不得顺手重构。所有 PR 初始 base 均为审查基线；同一作者可按依赖选择顺序，在对应修复 head 上非强制更新或显式采用另一已接受 PR 的提交，不向 main 合并。

禁止 main merge、release、部署、服务安装、真实模型调用、采集补数、真实账户与业务库写入/迁移、P5激活/重跑/历史改写，以及发布 data/var/delivery/.owlcoda 或凭据。源 SQL 及隔离测试库可作为源码修复，不向原业务库应用。PM 独占文件（README、AGENTS、PRODUCT、REQUIREMENTS、PRODUCT-LIFECYCLE、PROJECT-TASKS、REVISION-LOG）不并写。I-05 属现行合同冲突，排除此批修复，不改变 ASHARE-RULES §6 及冻结停牌/窗口口径。

适用验证在稳定候选完成后运行：项目 typecheck、受影响行为/调用链回归、diff检查；使用公开合成输入/隔离数据库。不是严格 TDD 授权，不强制先写失败测试。每条通过必须附实际命令、输出、环境与准确 head；未运行列明原因，不把报告原93测试当新候选证明。UI/PDF变动须提供与候选绑定的实际呈现证据。

停止条件：每个问题的完整行为出口成立，提供稳定 head、完整 changed paths/diff 与适用验证；当前总控接收。若无 GitHub 写工具，完整可发布补丁/文件即本次传输出口。一个初始结果加一次具名窄返工后先由总控重评，不自动无限重试或改换作者。源码接受不自动等于安装、整体L2、真实A/J或效果接受。
