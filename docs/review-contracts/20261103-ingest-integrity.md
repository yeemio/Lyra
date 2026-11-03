# 修复来源错误、重复抓取和导入质量门

状态：修复合同；当前仅建立 Draft PR，尚无修复接受。

审查候选：[`6c7cd196f20a4222d1f97708de7402b2c50ebeb0`](https://github.com/yeemio/Lyra/tree/6c7cd196f20a4222d1f97708de7402b2c50ebeb0)，tree `843eb5b97617ffda179ebb06e2ee2adf03bf19fc`。PR base=`main@6c7cd196f20a4222d1f97708de7402b2c50ebeb0`；head=`review-20261103/ingest-integrity`，初始合同提交身份见 PR。

## 确认问题与原证据

以下原报告行仅作问题依据。审查方的实测声明保持原身份；总控以固定源码及就近合同/调用链核对，未把它们改记为本机执行。

| 编号、分类 | 源码证据 | 触发及影响 | 修复方向与验收 |
|---|---|---|---|
| **I-06** `candidate_defect`：SW 相同数据重复抓取不满足幂等 | [事实构造 328–347](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/adapters/sw.ts#L328-L347)；[正常写入 561–577](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/adapters/sw.ts#L561-L577)；[事实比较 62–79](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/db/pintime.ts#L62-L79) | 相同业务行形成相同 fact ID，但每次带新的 `firstObservedAt`，部分情形还带新的批次原件引用；数据库将其认作同 ID 异内容。**实测：相同数据晚一秒重放抛 `FACT_CONFLICT`。**正常重试和重复回填不能可靠收敛。 | 保留首次事实和原件身份，新抓取只追加观察收据；真实语义修订另建版本。验收：顺序重放、并发重叠都幂等；有效期或内容变化仍形成可追溯修订，不能靠一概跳过掩盖。 |
| **I-07** `candidate_defect`：来源错误被包装成空集并永久标完成 | [Python 桥 123–136](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/adapters/emrisk/bridge.py#L123-L136)；[适配器 390–438](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/adapters/emrisk.ts#L390-L438)；[回填账本 154–188](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/backfill/emrisk.ts#L154-L188) | HTTP 200 但 `success:false, result:null` 时，桥直接返回 `ok:true, rows:[]`；回填登记 completed，以后跳过。**实测合成错误信封得到上述成功空集返回；持久化后果由正常调用链确认。**后续页错误还可能丢掉前页结果。 | 区分业务空集、源错误、结构异常、分页不完整；只有经协议确认的空集可完成。验收：首/后页错误均不得写 completed，故障后重跑可重新获取；保留错误原件和分页状态。 |
| **M-04** `candidate_defect`：估值导入质量门在写入之后，失败仍成功退出 | [valuation.ts:238–264](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/backfill/valuation.ts#L238-L264)；[307–319](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/backfill/valuation.ts#L307-L319) | 先入库，再检查拒绝率；超过门槛仍输出 IMPORT OK，没有非零退出或回滚。**静态确认，未运行 DB 场景。**坏行本身被拒绝，问题是部分批次和失败状态不符合硬门合同。 | 先解析核验或事务回滚；若允许部分导入，改为显式部分完成状态。验收100行中6行非法时，按现合同零新增事实、非零退出，保留错误报告。 |

## 完整行为与验证

相同语义 SW 行重复/并发观察幂等，保留首次事实和原件身份，真实内容或有效期改变仍形成修订；来源 success=false、结构异常及分页失败不得伪装成功空集或 completed；估值拒绝率硬门失败应零新增事实、非零退出并保留错误报告。

使用合成响应/缓存与隔离数据库覆盖晚一秒重复、并发重叠、真实修订、首/后页错误与真正空集、100行6行非法批次；不得发起真实采集、补数或业务库写入。

允许路径：

- `src/adapters/sw*`
- `src/db/pintime*`
- `adapters/emrisk/**`
- `src/adapters/emrisk*`
- `src/backfill/emrisk*`
- `src/backfill/valuation*`
- `src/adapters/valuation*`
- `docs/review-contracts/20261103-ingest-integrity.md`

## 授权、交付和停止条件

Owner 已授权这批经核对的问题修复、验证、对应分支提交/推送及 Draft PR 迭代。唯一代码作者为原普通 Chat（6ae99497-9154-83e8-ba4d-807175210ae2），当前总控负责合同、传输和稳定候选接受。若 Chat 无写工具，可提交完整补丁/文件，由总控机械发布同一作者的结果。保持同一 Chat，不另派作者。

只允许该 PR head 与下列源码/就近测试及本合同。确有必要的类型/调用者联动须在交付中逐项解释；不得顺手重构。所有 PR 初始 base 均为审查基线；同一作者可按依赖选择顺序，在对应修复 head 上非强制更新或显式采用另一已接受 PR 的提交，不向 main 合并。

禁止 main merge、release、部署、服务安装、真实模型调用、采集补数、真实账户与业务库写入/迁移、P5激活/重跑/历史改写，以及发布 data/var/delivery/.owlcoda 或凭据。源 SQL 及隔离测试库可作为源码修复，不向原业务库应用。PM 独占文件（README、AGENTS、PRODUCT、REQUIREMENTS、PRODUCT-LIFECYCLE、PROJECT-TASKS、REVISION-LOG）不并写。I-05 属现行合同冲突，排除此批修复，不改变 ASHARE-RULES §6 及冻结停牌/窗口口径。

适用验证在稳定候选完成后运行：项目 typecheck、受影响行为/调用链回归、diff检查；使用公开合成输入/隔离数据库。不是严格 TDD 授权，不强制先写失败测试。每条通过必须附实际命令、输出、环境与准确 head；未运行列明原因，不把报告原93测试当新候选证明。UI/PDF变动须提供与候选绑定的实际呈现证据。

停止条件：每个问题的完整行为出口成立，提供稳定 head、完整 changed paths/diff 与适用验证；当前总控接收。若无 GitHub 写工具，完整可发布补丁/文件即本次传输出口。一个初始结果加一次具名窄返工后先由总控重评，不自动无限重试或改换作者。源码接受不自动等于安装、整体L2、真实A/J或效果接受。
