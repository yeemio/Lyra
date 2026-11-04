# 修复报告版本、不可变证据、对齐计算与追问引用

状态：R1 源码候选，待总控对准确提交验收；不自行宣告 ACCEPT_SOURCE。

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

## R1 实施与依赖边界

本候选以初始 PR5 合同提交 `a62e6857b0f053d49edd2d95f57b89b8526ea01b` 为分支起点，显式合入已接受的 PR1 `c5964ee9e7a2c11541ed7f3ef1148f81cdda827d`（其历史包含 PR3 `9b3714e2eff3a6bd12b71cc1c2950639a8a98507`）。合并提交 `4061592cfb09eadc879d74adc32867d2eb7af7d4` 的两个 parent 按顺序即前述 PR5 合同、PR1；本批源码提交以该合并为 parent。没有合入 PR2、PR6、PR7，也没有改写其已接受身份。相对已接受 PR1，合并本身只带入本 PR 的原合同。

| 问题 | 本次行为出口 |
|---|---|
| I-17 | 统一规范化报告正文、ISO 时间与哈希；DB 写入被签入的同一时间，读回必须复算。步骤产物写入带任务/步骤身份的 CAS，绑定引用只可首次写入；报告签入全部十个主链产物引用。恢复及 HTML/PDF/追问读取 CAS 并核包、A、清单、J、QA，不读取固定 JSON 副本。工作文件覆盖不会改旧版；原件缺失/损坏具名拒绝。 |
| I-18 | ASSEMBLE 按任务行锁与组装步骤身份幂等；首次写盘失败后重入返回原版本，正文不同拒绝。读报告明确 `(reportId, version)`，未指定才按降序取最新；错误显式版本不得回退。表单、线程、PDF、回答均绑定所选版本。导航把不可验旧版标为不可用，不让旧坏正文阻断有效版。传统结论列表两处链接均携原 `conclusionId`。 |
| I-19 | 所有股票共用逐窗口日期序列/同原始价格口径检查：首尾及中间日期、重复/非法日期、缺行、非正/空价、未知口径均不能计算基准比较值和超额。每个不可比较窗口保留具名原因；本标的独立有效收益可保留。 |
| I-20 | CHAT 输入包含所选报告身份和本次实际发送表的内容哈希/定位。校验引用的 tableId、hash、版本；原证据保持 FACT/FILE 类型，计算表才标 COMPUTED。答案绑定成功 callId；CAS 保存原始发送 JSON 字节与接受输出，读取页面和复用已成功答案时复核调用输入哈希、状态及消息正文。无证据允许空引用。 |
| M-02 | HTML、正文 PDF 与证据附册共用实际包表行的财报期次、行情观察时间、运价日和日线末日；缺元数据明确缺失，不再推断“无三季报”。 |
| M-03 | 通用列名保持“来源收入字段 MBRevenue”。官方对照追加来源公司身份，只有同公司同期间数值核对才使用具名科目；其他公司或期次不能借用该结论。 |

### 最小联动与兼容性

`src/db/sr-migration.sql` 是本次必要的源 SQL 联动：增加步骤 `output_artifact` 及不可覆盖触发器、报告 `(report_id,version)` 唯一索引、线程 `report_version` 与版本唯一索引。理由是引用不可变性和线程版本不能只靠页面参数或内存保证。沿用原迁移入口，不新增安装/部署流程；未向业务库执行。旧线程不猜配版本；旧报告 hash 或产物证明不足时不重签、不从当前工作文件补配，导航明确不可验证。

`materials.ts` 为官方对照表增加 `sourceSubject`；`evidence.ts` 仅在适配器已给出 `adjustflag=3` 的全表事实中声明原始价格口径。SW 序列未证明此价格口径时保留不可比原因，不因同日期就默认为同口径。这里检查的是已提供的观测日期序列和原始价格收益，不证明交易所日历完整、分红总收益、严格历史 PIT，也不改变 I-05/P5 停牌或结算窗口。

### 检查与待验门

纯行为/近调用者命令（公开合成输入；字体通过 `LYRA_PDF_FONT` 指向可用中文字体）：

```sh
npm run typecheck
node --import tsx --test --test-concurrency=1 src/stock-research/report-identity.test.ts src/stock-research/report-calculation.test.ts src/stock-research/compute.test.ts src/stock-research/sr-real-transport.test.ts src/stock-research/render.test.ts src/stock-research/pdf.test.ts src/web/pages.test.ts src/stock-research/evidence-pit.test.ts
git diff --check
```

`evidence-pit.test.ts` 的内存查询端口只验证证据组装行为，不作为 SQL 通过。PDF 测试实际生成、由 `pdftotext` 校核；`LYRA_REPAIR_PDF_DIR` 可另外保存两份公开合成 PDF，以 `pdftoppm` 渲染后逐页检查。准确运行输出、文件哈希、视觉观察与最终 head 一同在交付记录，网页内容断言不等于网页视觉接受。

独立实际 PG 门：显式指定仅回环地址的 `LYRA_REPAIR_TEST_PG` 后运行 `node --import tsx --test src/stock-research/report-identity.pg.test.ts`。门使用随机专用 schema、两个连接池、临时 CAS、合成账户和注入模拟通道；验证源 DDL 幂等/不可覆盖、DB 往返、并发组装、真实 EISDIR 后恢复、HTML/PDF/版本线程与回答调用收据，结束清理 schema/CAS。未提供环境变量时仅跳过，不能记为通过。本 Chat 当前无 PostgreSQL/容器运行时，实际 PG 门为 NOT_RUN，由总控在准确候选补验；既有依赖接受不替代此门。

本次不把主链调用完成到步骤落位之间的崩溃恢复、待处理/UNKNOWN 追问重发与并发请求键、执行租约/预算称为已修；它们仍属 PR4 I-09/I-10/I-11/I-12/I-13/I-16。本次恢复保证覆盖已经 SUCCEEDED 且有绑定产物的步骤、已落报告的 ASSEMBLE 重入及终态材料核验。无真实模型/账户/采集、私有材料、业务库或 P5 操作；自然语言质量、严格 PIT、安装、效果、PR1/PR7 与本批网页视觉均不提升接受层。
