# 修复传统研究证据、复核语义与指标公式

状态：修复合同；当前仅建立 Draft PR，尚无修复接受。

审查候选：[`6c7cd196f20a4222d1f97708de7402b2c50ebeb0`](https://github.com/yeemio/Lyra/tree/6c7cd196f20a4222d1f97708de7402b2c50ebeb0)，tree `843eb5b97617ffda179ebb06e2ee2adf03bf19fc`。PR base=`main@6c7cd196f20a4222d1f97708de7402b2c50ebeb0`；head=`review-20261103/research-semantics`，初始合同提交身份见 PR。

## 确认问题与原证据

以下原报告行仅作问题依据。审查方的实测声明保持原身份；总控以固定源码及就近合同/调用链核对，未把它们改记为本机执行。

| 编号、分类 | 源码证据 | 触发及影响 | 修复方向与验收 |
|---|---|---|---|
| **I-08** `candidate_defect`：传统 A/J 校验允许无据、无承重或未解结论通过 | [A/J 校验 242–362](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/kernel/sol-transport.ts#L242-L362)；[结论构造 134–220](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/conclusion/object.ts#L134-L220) | A 的证据只验 64 位哈希形状，不验是否属于送达封存；J 可全非承重，或承重项 UNRESOLVED 仍给方向；实际改判可自报 `changedFromA=false`。**合成输出经过校验和结论构造被接受。**传统 J 的输入也未充分携带其核查所需实际材料。 | 在研究领域层统一校验送达证据、承重关系、未知处置及真实 A/J 差异；J 接收可核查材料。验收：未封存哈希、全非承重、未处置承重未知、改判无理由均不能形成有效方向结论。不能用新 SR 的较强校验替传统链背书。 |
| **I-14** `candidate_defect`：MACD 的 DEA 使用了错误平滑公式 | [公式合同 16–20](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/indicators.ts#L16-L20)；[实现 163–169](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/indicators.ts#L163-L169) | 声称 DEA=EMA9，却实现 `(8×prev+DIF)/9`；按同文件 EMA 定义应为 `(8×prev+2×DIF)/10`。**实测非线性价格序列：DEA 359.6455，而 EMA9 为 396.8209；柱值也明显不同。**影响传统 D5 材料，不应误称 L2 均线策略直接依赖 MACD。 | 统一 EMA 实现，或将自定义指标明确改名。验收使用独立非恒定序列与明确种子；若影响冻结方法，新增方法版本并保留旧样本身份。 |
| **I-15** `candidate_defect`：事件研究“继承”声明未进入实际模型输入 | [先验选择与输入 232–293](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/post-event.ts#L232-L293)；[J 与继承写入 303–349](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/post-event.ts#L303-L349) | 程序选取原结论并写“继承”关系，但 A/J 输入没有原结论与原判断，仅组装普通材料；事后再写继承和改判理由。**静态确认。**审计记录不能证明模型真的比较过原判断与新增事件。 | 继承研究必须显式传原结论/哈希、原条件和新增证据；若完整重研，则记录为完整重研。验收检查实际序列化模型输入，移除先验应使继承模式拒绝或降级。 |

## 完整行为与验证

传统链在领域边界校验 A 证据属于送达封存；J 能获得实际材料并校验承重关系、未解项处置和真实 A/J 差异；不能由自报 changedFromA 绕过。DEA 按明确种子的 EMA9 计算，并记录新方法身份，保留既有冻结样本身份。继承模式实际序列化原结论、原条件/哈希和新增事件；完整重研不得冒称继承。

无外发 fake transport 验证未封存哈希、全非承重、承重未知及无理由改判被阻断；独立非线性序列核对 DEA/MACD；检查实际 A/J payload 包含先验及增量。不得调用真实模型、重跑或重写 P5 样本。

允许路径：

- `src/kernel/sol-transport*`
- `src/research/**`
- `src/conclusion/**`
- `src/contracts.ts`
- `docs/review-contracts/20261103-research-semantics.md`

## 授权、交付和停止条件

Owner 已授权这批经核对的问题修复、验证、对应分支提交/推送及 Draft PR 迭代。唯一代码作者为原普通 Chat（6ae99497-9154-83e8-ba4d-807175210ae2），当前总控负责合同、传输和稳定候选接受。若 Chat 无写工具，可提交完整补丁/文件，由总控机械发布同一作者的结果。保持同一 Chat，不另派作者。

只允许该 PR head 与下列源码/就近测试及本合同。确有必要的类型/调用者联动须在交付中逐项解释；不得顺手重构。所有 PR 初始 base 均为审查基线；同一作者可按依赖选择顺序，在对应修复 head 上非强制更新或显式采用另一已接受 PR 的提交，不向 main 合并。

禁止 main merge、release、部署、服务安装、真实模型调用、采集补数、真实账户与业务库写入/迁移、P5激活/重跑/历史改写，以及发布 data/var/delivery/.owlcoda 或凭据。源 SQL 及隔离测试库可作为源码修复，不向原业务库应用。PM 独占文件（README、AGENTS、PRODUCT、REQUIREMENTS、PRODUCT-LIFECYCLE、PROJECT-TASKS、REVISION-LOG）不并写。I-05 属现行合同冲突，排除此批修复，不改变 ASHARE-RULES §6 及冻结停牌/窗口口径。

适用验证在稳定候选完成后运行：项目 typecheck、受影响行为/调用链回归、diff检查；使用公开合成输入/隔离数据库。不是严格 TDD 授权，不强制先写失败测试。每条通过必须附实际命令、输出、环境与准确 head；未运行列明原因，不把报告原93测试当新候选证明。UI/PDF变动须提供与候选绑定的实际呈现证据。

停止条件：每个问题的完整行为出口成立，提供稳定 head、完整 changed paths/diff 与适用验证；当前总控接收。若无 GitHub 写工具，完整可发布补丁/文件即本次传输出口。一个初始结果加一次具名窄返工后先由总控重评，不自动无限重试或改换作者。源码接受不自动等于安装、整体L2、真实A/J或效果接受。
