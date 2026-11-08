# 修复传统研究证据、复核语义与指标公式

状态：第三批源码修复候选；同一 Chat 唯一作者已实施，待总控在准确候选上 ACCEPT/REWORK。没有新增真实运行或效果接受。

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

## 第三批实施记录（2026-11-03）

本次只提交 PR #3：I-08、I-14、I-15。父提交为初始合同 head `2a6680c59ec9f1f19db2653b2bf8e17e5ef87f54`；PR base 保持原审查 main。没有 merge/cherry-pick PR #2/#6/#7，没有改写其已接受候选。准确新 head/tree、全部变化文件字节与 SHA-256、最终命令原始输出及 bundle 身份由本合同所在提交的冻结交付 MANIFEST/CHECKS 记录，不能引用旧候选测试为新候选通过。

### I-08：实际送达与结论的共同领域门

`validation.ts` 对输入包/封存内容哈希、业务键/版本、材料/层块唯一性、字节回执及 factId→原件的配对校验；引用资格限于实际 L0/L1 送达，封存目录中存在不等于送达。组装器在计算层字节前记录 `evidenceRefs`，数据库包复核继续检查实际 fact/hash 配对。A/J 都经过同一领域门；直接调用结论构造也无法以 hash-only manifest 绕过。

J 收到完整 L0/L1/L2 载荷、A 原文及程序清单，输入哈希绑定该材料包/A/清单。逐项理由、送达证据、非承重项的剩余依据、全部未解项 limitations、承重/最强论证未知时 ABSTAIN、真实方向差异和 J 自身改判理由均程序校验。方向结论至少有一条支持/收窄的承重决定性连接。无效 A 不进入 J；无效 J 不产生结论。程序不能判定自然语言论据是否在业务上充分，本次不声称该能力。

`requests.ts` 是 Gate-M、事件研究和 nightly 直接调用者共用的序列化入口；contract.inputBytes 取实际 prompt 的 UTF-8 字节数，发送前核对组装身份。新结论在落库前将原输入/A/清单/J 作为 canonical JSON 保存 CAS，并在结论证据中绑定 `researchTraceSha256`。

旧 `aFrom` 仅凭文件路径时间猜配封存，不具备可信原轮恢复证明；现从正常入口立即 `SALVAGE_A_UNBOUND` 拒绝，零组装/零读取/零 permit。可信检查点恢复仍属于 PR #4，此处不宣称完成 I-16。

### I-14：新方法与冻结边界

新 DEA 用与 EMA12/26 相同的 EMA 实现：`(8×prev + 2×DIF)/10`，种子仍为首九个 DIF 的 SMA（第 34 根）；第 35 根起递推。新增 `method@p2-v2-20261103` / `indicators@p2-v2-ema9`，普通 Gate-M 缺省使用新身份，材料明确标记公式版本。未知个股方法在事实读取/封存前具名拒绝。独立 Python Decimal 对照覆盖非线性平方序列、种子边界、新公式及旧公式。

`method@p2-v1` 明确保留旧 DEA 供冻结公式复现；本候选不回写旧结论、旧 CAS、旧 P5 样本或冻结正文。新增协议产生的新包/输出哈希与旧结果不同，不借用旧复核接受。真实 A 请求禁止沿旧方法发送；nightly 的冻结 P5 真实 commit 入口在计划、准入、permit 和模型发送前 `P5_PROTOCOL_FROZEN` 拒绝。真实 P5 的新方法迁移与重新接受须另行授权，绝非本次激活。模拟演练仍可显式使用旧公式，但不是旧样本或业务接受。

### I-15：原文继承或明确完整重研

正常事件入口从结论行及 CAS 读回、校验原结论与原输入/A/清单/J；只接受同股、本周准入前已完成、先验截点早于事件且方法兼容的周度结论。数据库/CAS 原文校验签发进程内不可序列化的收据，结论构造同时核验收据与完整先验、事件及准入时点，调用者自报时间或 hash 指针不能伪造继承。

原结论/哈希、原 A/J 判断与条件、触发事件及实际锚定事实进入不可裁剪 L0；重算材料索引、内外字节回执和输入身份，超预算具名拒绝。A/J 实际 payload 都携带这些内容；J 对原判断/新增事件的比较理由在维持时也必填。新事实须同股、在本轮封存中且不晚于截点。缺原文或资格不符记录 `STANDALONE` 和 `完整重研：原因`；原件损坏/身份矛盾直接拒绝，不能静默声称继承。历史/实时数据是否完整、事件识别正确性和自然语言比较质量不由这些合成测试证明。

### 必要调用者联动与验证范围

- `src/schedule/nightly.ts`：既有周度调用者必须传完整材料、共用 A/J 领域门和原文持久化；加入上述冻结 P5 真实发送拒绝，不修改调度日历/停牌/结算窗口。
- `src/schedule/nightly.test.ts`、`src/schedule/weekend-runner.test.ts`：结论夹具从 hash-only 改为完整公开合成包；nightly 的真实入口断言改为发送前拒绝。
- `src/journey/journey.test.ts`：P0 合成夹具绑定送达包及新 J 输入；保留 J 决定最终方向、不可变落库与结算断言；无原文继承的旧正例不再伪装通过，完整继承正/反例由新增具名测试覆盖。
- `src/web/server.test.ts`：仅适配 J 类型夹具的必填字段，没有改页面、PDF 或下载实现。
- 其余变更在原允许路径内；`research-test-helper.ts` / `research-semantics.test.ts` 只使用公开合成内容、临时 CAS、无外发 fake transport。内存回执不冒充真实 SQL/并发验证。

适用稳定候选检查命令：

```sh
npm run typecheck
node --import tsx --test --test-concurrency=1 --test-reporter=spec src/research/research-semantics.test.ts src/research/indicators.test.ts src/kernel/sol-transport.test.ts src/kernel/transport.test.ts src/research/checklist.test.ts
git diff --check 2a6680c59ec9f1f19db2653b2bf8e17e5ef87f54 HEAD
git status --porcelain=v1
```

新增隔离 PG 用例只在显式提供 `LYRA_REPAIR_TEST_PG` 时连接该测试库，建立随机 schema 并在结束后清理；绝不回退默认业务库。当前 Chat 未提供隔离 PG，因此该项为 `NOT_RUN`，不能用内存 SQL 回执替代；其余依赖默认数据库或未公开原件的 inputs/gate-m/post-event/research-journey/nightly/weekend/P0 完整集成用例也列 `NOT_RUN`。真实 A/J、真实资料兼容性、默认 L0 预算在真实先验上的适配、严格历史 PIT、账户/安装/效果接受均未验证。未改 UI/PDF 产品实现，PR #7 视觉缺口保持原状态。I-05 和其余 PR 的问题不在本次完成范围。
