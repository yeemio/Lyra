# 限制本机客户端的 Host 与写请求来源

状态：修复合同；当前仅建立 Draft PR，尚无修复接受。

审查候选：[`6c7cd196f20a4222d1f97708de7402b2c50ebeb0`](https://github.com/yeemio/Lyra/tree/6c7cd196f20a4222d1f97708de7402b2c50ebeb0)，tree `843eb5b97617ffda179ebb06e2ee2adf03bf19fc`。PR base=`main@6c7cd196f20a4222d1f97708de7402b2c50ebeb0`；head=`review-20261103/local-origin`，初始合同提交身份见 PR。

## 确认问题与原证据

以下原报告行仅作问题依据。审查方的实测声明保持原身份；总控以固定源码及就近合同/调用链核对，未把它们改记为本机执行。

| 编号、分类 | 源码证据 | 触发及影响 | 修复方向与验收 |
|---|---|---|---|
| **I-21** `candidate_defect`：local 模式没有校验请求的本机来源身份 | [自动 owner 129–138](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/server.ts#L129-L138)；[请求入口 769–790](https://github.com/yeemio/Lyra/blob/6c7cd196f20a4222d1f97708de7402b2c50ebeb0/src/stock-research/server.ts#L769-L790) | 免登录符合产品范围，但任意 Host 的请求也被赋予 owner。**临时 HTTP 探针：`Host: untrusted.example`、同名 Origin 请求仍取得 owner 风险表单和 CSRF token。**浏览器 DNS 重绑定等可达条件未做端到端验证，不能宣称已完成远程利用。 | local 模式限制合法本机 Host，写请求核查 Origin/Fetch Metadata 并保留 CSRF；非本机监听需明确配置。验收：非法 Host 在身份建立前拒绝，正常 localhost/127.0.0.1/IPv6 本机入口可用。无需增加 SaaS 登录体系。 |

## 完整行为与验证

local 模式在建立 owner 身份前拒绝不合法 Host；写请求校验适用 Origin/Fetch Metadata，并保留 CSRF。正常 localhost、127.0.0.1、IPv6本机入口可用；非本机监听需明确配置。保持本机单用户产品范围。

临时隔离HTTP服务覆盖非法Host、跨站写请求、CSRF、正常三个本机入口和显式监听配置。只证明请求边界，不声称已完成DNS重绑定远程利用或全面安全审计。

允许路径：

- `src/stock-research/server*`
- `src/stock-research/server-journey*`
- `src/stock-research/web*`
- `docs/review-contracts/20261103-local-origin.md`

## 授权、交付和停止条件

Owner 已授权这批经核对的问题修复、验证、对应分支提交/推送及 Draft PR 迭代。唯一代码作者为原普通 Chat（6ae99497-9154-83e8-ba4d-807175210ae2），当前总控负责合同、传输和稳定候选接受。若 Chat 无写工具，可提交完整补丁/文件，由总控机械发布同一作者的结果。保持同一 Chat，不另派作者。

只允许该 PR head 与下列源码/就近测试及本合同。确有必要的类型/调用者联动须在交付中逐项解释；不得顺手重构。所有 PR 初始 base 均为审查基线；同一作者可按依赖选择顺序，在对应修复 head 上非强制更新或显式采用另一已接受 PR 的提交，不向 main 合并。

禁止 main merge、release、部署、服务安装、真实模型调用、采集补数、真实账户与业务库写入/迁移、P5激活/重跑/历史改写，以及发布 data/var/delivery/.owlcoda 或凭据。源 SQL 及隔离测试库可作为源码修复，不向原业务库应用。PM 独占文件（README、AGENTS、PRODUCT、REQUIREMENTS、PRODUCT-LIFECYCLE、PROJECT-TASKS、REVISION-LOG）不并写。I-05 属现行合同冲突，排除此批修复，不改变 ASHARE-RULES §6 及冻结停牌/窗口口径。

适用验证在稳定候选完成后运行：项目 typecheck、受影响行为/调用链回归、diff检查；使用公开合成输入/隔离数据库。不是严格 TDD 授权，不强制先写失败测试。每条通过必须附实际命令、输出、环境与准确 head；未运行列明原因，不把报告原93测试当新候选证明。UI/PDF变动须提供与候选绑定的实际呈现证据。

停止条件：每个问题的完整行为出口成立，提供稳定 head、完整 changed paths/diff 与适用验证；当前总控接收。若无 GitHub 写工具，完整可发布补丁/文件即本次传输出口。一个初始结果加一次具名窄返工后先由总控重评，不自动无限重试或改换作者。源码接受不自动等于安装、整体L2、真实A/J或效果接受。
