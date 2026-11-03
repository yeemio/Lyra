# 修复发送终态、执行租约、请求幂等与任务恢复

状态：修复合同；当前仅建立 Draft PR，尚无修复接受。

审查候选：[`6c7cd196f20a4222d1f97708de7402b2c50ebeb0`](https://github.com/yeemio/Lyra/tree/6c7cd196f20a4222d1f97708de7402b2c50ebeb0)，tree `843eb5b97617ffda179ebb06e2ee2adf03bf19fc`。PR base=`main@6c7cd196f20a4222d1f97708de7402b2c50ebeb0`；head=`review-20261103/execution-recovery`，初始合同提交身份见 PR。

## 确认问题与原证据

以下原报告行仅作问题依据。审查方的实测声明保持原身份；总控以固定源码及就近合同/调用链核对，未把它们改记为本机执行。

| 编号、分类 | 源码证据 | 触发及影响 | 修复方向与验收 |
|---|---|---|---|
| **I-09** `candidate_defect`：发送后本地超时被错误落为 FAILED | [进程超时 620–624](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/kernel/sol-transport.ts#L620-L624)；[执行器分类 235–273](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/kernel/executor.ts#L235-L273) | 子进程本地超时、远端结果未知，但发生在业务 deadline 前时落 `FAILED/DEADLINE_EXCEEDED`。**内存 permit 探针复现。**执行器自己的 deadline 竞速会正确落 UNKNOWN，两条超时路径不一致。`sent_at` 仍阻止同键重发，不能夸大为必然重发。 | 用“是否实际发送、是否收到远端确定终态”分类，不能由本地杀进程推断远端失败。验收：发送后失联/本地超时为 UNKNOWN，发送前拒绝和远端明确失败另列，费用未知不写零。 |
| **I-10** `candidate_defect`：长调用期间租约不续，持有者校验又可省略 | [60 秒租约及校验](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/kernel/lock.ts#L118-L135)；[可选 holder 校验](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/kernel/executor.ts#L159-L164)；[SR worker 807–836](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/server.ts#L807-L836) | heartbeat 在整项任务前或整轮 A/J 后进行。模型调用超过 TTL，传统链可能在 J 前失去执行权；SR 将 holder 留在 worker 外层，没有贯穿发送，另一个 worker 可取得过期租约而旧 worker 继续。**静态确认，未跑真实多进程 DB 试验。** | 执行期间独立续租；所有发送入口必须带 fencing token，数据库原子检查当前持有者。验收：两进程、超 TTL 慢调用、暂停恢复时不出现双持有者继续发送；旧 token 必须被拒绝。 |
| **I-11** `candidate_defect`：原业务任务缺少完整、可信的恢复检查点 | [传统打捞 371–423](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/research/gate-m.ts#L371-L423)；[SR 只领取 QUEUED 233–244](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/store.ts#L233-L244)；[SR 恢复 881–930](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/engine.ts#L881-L930) | 传统 A 成功后中断，不能可靠按原 permit 恢复；`--a-from` 依文件名时间和较早 seal 猜配，未绑定原 permit/inputHash/真实身份。SR 重启不重新领取 RUNNING，步骤只在“零行”时创建，部分骨架不能补齐；若加载池/目录失败，还可能停在 RUNNING。**静态确认，已检查其他生产恢复入口。** | 建立业务键、阶段、permit、输入包、输出哈希绑定的持久检查点；原任务对账、补齐确定性步骤、显式处置 UNKNOWN。验收：A 后、J 后、发布前崩溃均恢复原任务；已发送步骤不重发，错绑或模拟 A 不能冒充真实 A 打捞。 |
| **I-12** `candidate_defect`：nightly 的真实通道正常入口接错，修正接线后仍缺 prompt | [CLI 1046–1057](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/nightly.ts#L1046-L1057)；[依赖读取 495–504](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/nightly.ts#L495-L504)；[调用材料 337–359](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/nightly.ts#L337-L359) | CLI 将 transport 放进 options，实际读取 `deps.transport`，所以正常 real 入口得到未授权占位。即使调用者正确注入，weekly/post-event payload 仍没有 SolTransport 必需的 prompt，且校验发生在 permit SENT 之后。**静态确认，未进行真实调用。** | 共用经过绑定的研究输入构造器；传输预检在占用一次发送资格前完成。验收：用无外发 fake transport 从 CLI 参数走到实际 dispatch，核对 prompt、哈希、身份；预检失败零 SENT。 |
| **I-13** `candidate_defect`：调度预算存在双上限和部分失败漏计 | [预算守卫 377–389](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/queue.ts#L377-L389)；[调用者 615–674](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/schedule/nightly.ts#L615-L674) | 两类预算都满时守卫仅返回 POST_EVENT，weekly 调用者因此不阻断；A 已发送、J 失败时内存计数不增加；只剩一个额度也未先保护两阶段需求。**实测 weekly=60/event=10 时得到 POST_EVENT，weeklyBlocked=false；其他后果来自静态调用链。** | 各预算独立判定，以实际 permit/发送收据原子计数；明确阶段预约与释放。验收：双上限、只剩一次、A 成功 J 失败、UNKNOWN、并发启动均不能绕过授权上限，报表保留全部尝试。 |
| **I-16** `candidate_defect`：追问及修订重试可生成新的业务调用身份 | [追问去重与新 step 1030–1071](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/engine.ts#L1030-L1071)；[重试提示与修订入口 486–520](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/server.ts#L486-L520) | 只有已经存在 USER→ASSISTANT 成功答案才去重。并发点击、发送后 UNKNOWN、回答落库前失败，重试会创建新的 step；permit 对新 step 是新键。修订幂等键包含当前时间，也不能识别同一次 POST 重试。**静态确认，未真实重发。** | 在发送前原子创建稳定请求身份，绑定报告版本、问题和输入哈希；重试返回原 pending/UNKNOWN/结果。验收：双击、断线重投和 UNKNOWN 重试只对应一次发送；明确的新意图才建立新身份。 |

## 完整行为与验证

区分发送前拒绝、远端确定失败及发送后未知，本地杀进程不推断远端失败；调用期间持续持有有效执行权，全部发送入口校验当前持有者/代际并拒绝旧执行者。业务任务检查点绑定原业务键、permit、真实输入和输出，补齐确定性步骤，恢复 RUNNING 不重发已发送步骤；打捞不猜文件名/时间。nightly CLI 注入正确 transport，生成完整绑定 prompt 并在 SENT 前预检。预算按各 scope 和实际发送收据原子约束，覆盖 A 成功 J 失败/UNKNOWN。追问与修订在发送前建立稳定请求身份，重投返回原 pending/UNKNOWN/结果，明确新意图才开新调用。

fake transport 与隔离测试数据库覆盖 A后/J后/发布前/保存答案前中断；长于 TTL 慢调用和双worker、旧token拒绝；CLI到dispatch绑定、预检失败零SENT；双预算满/剩一次/部分失败/并发；双击、断线和UNKNOWN重投最多一次发送。不得真实外发或操作业务库、P5服务。

允许路径：

- `src/kernel/**`
- `src/schedule/**`
- `src/research/gate-m*`
- `src/research/weekly*`
- `src/research/post-event*`
- `src/stock-research/engine*`
- `src/stock-research/store*`
- `src/stock-research/kernel*`
- `src/stock-research/server*`
- `src/stock-research/contracts*`
- `src/stock-research/*schema*.sql`
- `docs/review-contracts/20261103-execution-recovery.md`

## 授权、交付和停止条件

Owner 已授权这批经核对的问题修复、验证、对应分支提交/推送及 Draft PR 迭代。唯一代码作者为原普通 Chat（6ae99497-9154-83e8-ba4d-807175210ae2），当前总控负责合同、传输和稳定候选接受。若 Chat 无写工具，可提交完整补丁/文件，由总控机械发布同一作者的结果。保持同一 Chat，不另派作者。

只允许该 PR head 与下列源码/就近测试及本合同。确有必要的类型/调用者联动须在交付中逐项解释；不得顺手重构。所有 PR 初始 base 均为审查基线；同一作者可按依赖选择顺序，在对应修复 head 上非强制更新或显式采用另一已接受 PR 的提交，不向 main 合并。

禁止 main merge、release、部署、服务安装、真实模型调用、采集补数、真实账户与业务库写入/迁移、P5激活/重跑/历史改写，以及发布 data/var/delivery/.owlcoda 或凭据。源 SQL 及隔离测试库可作为源码修复，不向原业务库应用。PM 独占文件（README、AGENTS、PRODUCT、REQUIREMENTS、PRODUCT-LIFECYCLE、PROJECT-TASKS、REVISION-LOG）不并写。I-05 属现行合同冲突，排除此批修复，不改变 ASHARE-RULES §6 及冻结停牌/窗口口径。

适用验证在稳定候选完成后运行：项目 typecheck、受影响行为/调用链回归、diff检查；使用公开合成输入/隔离数据库。不是严格 TDD 授权，不强制先写失败测试。每条通过必须附实际命令、输出、环境与准确 head；未运行列明原因，不把报告原93测试当新候选证明。UI/PDF变动须提供与候选绑定的实际呈现证据。

停止条件：每个问题的完整行为出口成立，提供稳定 head、完整 changed paths/diff 与适用验证；当前总控接收。若无 GitHub 写工具，完整可发布补丁/文件即本次传输出口。一个初始结果加一次具名窄返工后先由总控重评，不自动无限重试或改换作者。源码接受不自动等于安装、整体L2、真实A/J或效果接受。
