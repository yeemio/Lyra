# Lyra · 架构总纲

> 客户端产品扩展〔R31，2026-10-29〕：[PRODUCT v3.0](PRODUCT.md)纳入市场机会、策略、风险和跟踪复盘，以下冻结基础保证保留。新增客户端策略应复用 CAS/时点读取、唯一 permit/执行器、三版本轴、A→清单→J和完整机会分母纪律；报告、策略、验证、持仓与观察记录分别绑定身份和截点。具体 schema/接口尚未实施，本次不迁移数据库，不改 P5，也不新建旁路执行器。旧报告工程合同不冒充新增策略合同。

状态：**v1 已冻结，2026-10-25**（随 P0 冻结，审阅记录 `docs/FREEZE-P0-20261025.md`）。各层细节在 `docs/specs/` 对应合同中；本文是结构与边界的权威表述。

## 继承声明

Lyra 的架构不是重新发明，而是 Metis 已验证结构向 A 股域的移植与**裁剪**。继承什么、裁剪什么、为什么，全部可追溯：

| 结构 | 来源（Metis 证据） | Lyra 处置 |
|---|---|---|
| 原件库（CAS 内容寻址、哈希校验读、字节区间读、不可变） | `packages/storage/src/artifacts.ts` | 继承，P0 |
| 时点读取（available_at 五时间字段、as-of 过滤、封存 manifest） | `docs/specs/SPEC.md` §6 | 继承，P0/P1 |
| 执行内核：permit + 一次发送 + UNKNOWN 处置 + 恢复 | `packages/persistence/src/execution.ts`、`native-authorization.ts`、`host-unreleased-recovery.ts`；返工教训见收尾复盘 | **简化继承**，P0（见下） |
| A→程序清单→必经 J（方法12结构） | `packages/method-football/src/method12.ts` | 继承，P2（域对象替换） |
| 结论继承语义（方法15） | `method15.ts` INHERITED_VALID_AJ / STANDALONE | 继承，P3 |
| 历史参照判断义务（方法14） | `historical-atlas-consumer-20261024/CONTRACT.json` | 继承，P4 |
| 全机会分母复盘 | `packages/result-review` | 继承，P3 |
| 旅程测试安装门（零释放断言 + 完整公开路径） | `tests/runtime-closure/product-journey.test.ts` | 继承，P0 |
| 方法资格链 / graph release / hybrid qualification 机器 | Metis 为方法版本切换资格所建 | **不建**（首版方法冻结，无版本切换需求；P5 前不引入） |

## 四项结构约束（第一天生效）

1. **唯一的授权模型**：每次模型调用绑定一个 permit 与确切调用合同（研究身份、资料截点、输入哈希、截止）；无 permit 的模型调用不存在；permit 状态可审计。
2. **唯一的执行器**：同一时刻只有一个执行进程持有执行权；模型调用、原件写入、结算计算都经它；不存在第二条并行执行链。
3. **三条独立的版本轴**：
   - **方法版本轴**：研究方法文本与裁决结构的冻结版本（A→清单→J 的义务、判断尺度）。
   - **数据与适配器版本轴**：每个数据源适配器独立版本号；解析合同变更可用同一原件生成新事实版本；历史按当时的适配器与分类版本读取。
   - **执行计划与授权版本轴**：研究计划（哪些股票、哪个窗口、什么预算）与调用授权（上限、并发、截止）独立版本化；新计划、新额度、新安装都不自然等同于新方法版本。
   三轴任何一轴变化都产生新身份，不互相推导、不互相牵连（Metis 收尾复盘第 3 条教训的出处）。
4. **旅程测试作为安装门**：旅程测试（模拟模型）全绿是安装新版本的必要条件；测试含"未授权时零模型调用"断言、时点泄漏测试、send-once 幂等断言、恢复路径断言。

## 分层

```
数据层    原件库(CAS) ── 数据适配器(巨潮/BaoStock/AKShare/交易所/中证/申万，各自版本号)
             │  原始价与复权因子、公告PDF、元数据、分类版本、成分归属 —— 全部不可变、带抓取时间
时点层    时点读取(as-of) ── 五时间字段、四类时点对象过滤、封存 manifest
             │  任何研究只读封存 manifest 指向的内容
执行层    执行内核 ── permit + send-once + UNKNOWN处置 + 截止自身持有 + 恢复(RECONCILING/确认)
             │  唯一执行器；并发上限2；两级限流退避
研究层    研究方法 ── A(Sol/high) → 程序清单(无模型) → 必经J(Astra/xhigh)
             │  决策合同三选项；判断义务；输入分层；结论对象(disposition, adoption=false)
结算层    结算与复盘 ── 行情原件程序结算；全机会分母；不重叠样本；预注册主指标
```

层间依赖单向向下；研究层不直接触碰数据源，只经时点层读封存内容；结算层只读行情原件与结论对象，不回写研究层。

## P0 简化内核的范围边界

**保留**（Metis 代价最高的教训所在）：permit 与调用合同绑定；send-once（同业务键不重发）；UNKNOWN attempt 状态机与本地退役回执（远端结果未知时不重发、不伪造）；执行截止时间属于单次执行自身、不从计划模板继承；启动诊断（RECONCILING 状态、恢复需显式确认、冷启动诊断面板）；旅程测试框架与安装门。

**不建**（P5 前明确排除）：方法资格链与版本切换机器、graph release 管理、hybrid qualification、多方法并存注册。方法文本在 P2 冻结后即固定；若 P5 后确需方法演进，按新版本轴追加，不复活 Metis 的资格链复杂度。

**理由**：Metis 的资格链机器服务于"方法版本切换需资格证明"这一需求，其构建与多轮返工的成本远超 P0 预算；Lyra 首版方法冻结、无切换需求。裁剪不降低上述保留项的强度。

## 关键机制速览（细节在 specs/）

- **一次发送**：`specs/EXECUTION-KERNEL.md`
- **时点与封存**：`specs/POINT-IN-TIME.md`
- **A 股市场规则（涨跌停/ST/停牌/复权/披露日历）**：`specs/ASHARE-RULES.md`
- **数据源与三层回填**：`specs/DATA-SOURCES.md`
- **研究方法与结论对象**：`specs/RESEARCH-METHOD.md`
- **调度与溢出**：`specs/SCHEDULING.md`
- **历史参照库**：`specs/HISTORICAL-REFERENCE.md`
- **结算与复盘**：`specs/SETTLEMENT-REVIEW.md`
