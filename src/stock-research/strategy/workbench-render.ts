import { escapeHtml } from '../../web/pages.js';
import type { FrozenPlan, Metrics, ReplayResult } from './contracts.js';
import type { L2WorkbenchStore } from './workbench-contracts.js';
import { RISK_LOT_LIMIT } from './risk-input.js';

export type WorkbenchPageState = { status: 'NOT_CONFIGURED' | 'FAILED'; detail: string } | { status: 'LOADED'; loaded: Awaited<ReturnType<L2WorkbenchStore['load']>> };
const esc = (v: unknown): string => escapeHtml(v === null || v === undefined ? '未计算 / 未提供' : String(v));
const labels: Record<string, string> = {
  NOT_CONFIGURED: '尚未载入工作区', FAILED: '工作区校验失败', INPUT_BLOCKED: '资料不足，尚不能生成计划', COMPUTED_OFFLINE: '已生成离线研究结果',
  TREND_CANDIDATE: '趋势条件匹配，仍待复核与成交检查', WAIT_NO_TRIGGER: '条件未触发，继续等待', NO_FIT_ENVIRONMENT: '当前环境不适配', DATA_PENDING: '资料不足', LOGIC_INVALID: '研究逻辑失效', TECHNICAL_FAILURE: '计算失败', ALREADY_POSITIONED: '已有模拟持仓，占用当日机会', PENDING_ENTRY: '等待进入条件',
  COMPUTED_SYNTHETIC: '合成数据计算完成', COMPUTED_HISTORICAL: '历史资料计算完成，尚未接受效果', INSUFFICIENT_SAMPLE: '样本不足', DATA_INSUFFICIENT: '资料不足，计算不完整', REVIEW_BLOCKED: '复核未通过，模拟受限',
  SYNTHETIC_BEHAVIOR_ONLY: '仅验证合成离线行为', HISTORICAL_COMPUTED_NOT_ACCEPTED: '已计算历史结果，尚未接受效果', INCOMPLETE: '历史验证不完整',
  UNTRIGGERED: '未触发', TRIGGERED: '已触发离线条件', INVALID: '已失效', EXPIRED: '已过期', MISSED: '已错过',
  VALIDATION_PENDING: '等待历史验证', DRAFT: '待复核草案', J_BLOCKED: '复核阻断', OFFLINE_DEMO_REVIEWED: '合成演示的离线复核完成',
  SIZED: '已按所列风险输入计算', MISSING_ACCOUNT: '缺少风险输入', ACCOUNT_NOT_AVAILABLE: '风险输入在该截点尚不可得', RISK_REJECTED: '不满足风险约束',
  RESEARCH: '研究判断', TIMING: '条件时机', RISK: '风险约束', EXECUTION: '模拟成交', DATA: '资料', RULE: '规则',
  BUY: '模拟买入', SELL: '模拟卖出', EXIT_SCHEDULED: '安排下一开盘退出', ENTRY_SCHEDULED: '安排下一开盘进入',
  HOLDING_TIME_EXIT: '达到持有期限', NEXT_OPEN_FILL: '在下一开盘按规则模拟成交', STOP_EXIT: '收盘价格失效', PROFIT_EXIT: '达到收盘止盈条件',
  DAILY_TREND: '日线趋势策略', WAIT_CASH: '等待 / 全现金对照',
};
const label = (value: string | null | undefined): string => value == null ? '尚未计算' : labels[value] ?? value;
const reason = (value: string): string => value.split(':').map((part) => label(part)).join('；');
function decimal(n: number | null | undefined): string {
  if (n == null) return '未计算';
  const value = BigInt(n), absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${(absolute / 100n).toLocaleString('zh-CN')}.${String(absolute % 100n).padStart(2, '0')}`;
}
const money = (n: number | null | undefined): string => n == null ? '未计算' : `${decimal(n)} 元`;
const percent = (n: number | null | undefined): string => n == null ? '未计算' : `${decimal(n)}%`;
const count = (n: number | null | undefined, unit: string): string => n == null ? '未计算' : `${n.toLocaleString('zh-CN')} ${unit}`;
function table(headings: string[], rows: unknown[][]): string {
  return `<div class="sr-table-scroll" tabindex="0" role="region" aria-label="${esc(headings[0])}"><table class="sr-table"><thead><tr>${headings.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headings.length}">无记录</td></tr>`}</tbody></table></div>`;
}
const denominatorLabels: Record<string, string> = { opportunities: '全部机会', fills: '模拟成交', unfilledAttempts: '未成交尝试', closedTrades: '完整平仓', netReturn: '净收益率', maximumDrawdown: '最大回撤', exposure: '持仓暴露', turnover: '换手', benchmark: '市场基准', waitCash: '全现金对照', sampleSplit: '样本内外分界' };
function metrics(m: Metrics): string {
  return table(['指标', '计算结果'], [
    ['初始组合净值', money(m.initialEquityFen)], ['期末组合净值', money(m.finalEquityFen)], ['净损益', money(m.netPnlFen)], ['净收益率', percent(m.netReturnBps)],
    ['最大收盘回撤', percent(m.maximumDrawdownBps)], ['平均持仓暴露', percent(m.meanExposureBps)], ['双边换手比例', percent(m.turnoverBps)], ['累计费用', money(m.feesFen)],
    ['完整平仓', count(m.closedTrades, '次')], ['模拟成交', count(m.fills, '次')], ['尝试后未成交', count(m.unfilledAttempts, '次')], ['可估值交易日', count(m.valuedSessions, '日')], ['全部机会分母', count(m.allOpportunities, '次')],
    ['市场基准收益率', percent(m.benchmarkReturnBps)], ['全现金等待对照收益率', percent(m.waitCashReturnBps)],
  ]);
}
function replay(title: string, r: ReplayResult): string {
  return `<section class="sr-section"><h2 class="sr-sec-h">${esc(title)}</h2><p><strong>${esc(label(r.status))}</strong> · ${esc(r.window.from)} → ${esc(r.window.to)}；当前条件：${esc(label(r.condition))}。</p>
${r.metrics ? metrics(r.metrics) : '<p>指标尚未计算；无收益或数量结论。</p>'}
${r.issues.length ? table(['计算限制', '日期'], r.issues.map((i) => [i.detail, i.date])) : ''}
<details><summary>全部机会分母（${r.opportunities.length}条，含等待、拒绝与占用）</summary>${table(['日期', '当日判断', '原因'], r.opportunities.map((o) => [o.date, label(o.decision), o.reasonCodes.map(reason).join('；') || '无补充原因']))}</details>
<details><summary>全部事件与归因（${r.events.length}条，含未成交与失败）</summary>${table(['时间', '事件', '归因', '原因', '数量', '价格', '费用', '净损益'], r.events.map((e) => [e.at, label(e.kind), label(e.attribution), reason(e.reason), count(e.quantity, '股'), money(e.priceFen), money(e.feesFen), money(e.netPnlFen)]))}</details></section>`;
}
function planContent(plan: FrozenPlan): string {
  const risk = plan.indicativeRisk;
  return `<section class="sr-section"><h2 class="sr-sec-h">冻结计划：条件、期限与风险</h2><p>资料截点 ${esc(plan.cutoff)}；信号日 ${esc(plan.signalDate)}；计划到期日 ${esc(plan.expiresOn)}。</p>
${table(['价格条款', '冻结值'], [['进入价格下界', money(plan.terms?.entryLowerFen)], ['进入价格上界', money(plan.terms?.entryUpperFen)], ['收盘价格失效阈值', money(plan.terms?.priceInvalidBelowFen)], ['收盘止盈阈值', money(plan.terms?.profitAboveFen)]])}
${table(['期限与成本假设', '冻结值'], [['最长持有期限', count(plan.rules.maxHoldingSessions, '交易日')], ['进入等待期限', count(plan.rules.pendingEntrySessions, '交易日')], ['佣金比例', percent(plan.rules.costs.commissionBps)], ['最低佣金', money(plan.rules.costs.minCommissionFen)], ['卖出税费比例', percent(plan.rules.costs.sellTaxBps)], ['过户费比例', percent(plan.rules.costs.transferBps)], ['不利滑点比例', percent(plan.rules.costs.slippageBps)]])}
<h3>进入、等待与退出条件</h3><ul>${plan.conditions.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
${table(['备选方案', '当前选择', '理由'], plan.alternatives.map((a) => [label(a.family), a.selected ? '选中' : '保留对照', a.reason]))}
<h3>按结果所用输入计算的压力情景</h3><p>${esc(risk ? label(risk.status) : '尚未计算风险数量')}。合成结果中的数量和资金只属于演示；下方新录入不会自动改写本计划。</p>
${risk ? table(['情景项目', '计算值'], [['数量', count(risk.quantity, '股')], ['进入价格', money(risk.buyPriceFen)], ['压力退出价', money(risk.stressExitFen)], ['进入金额', money(risk.buyGrossFen)], ['进入费用', money(risk.buyFeesFen)], ['压力损失', money(risk.stressLossFen)]]) : ''}
<h3>计划限制</h3><ul>${plan.limitations.map((text) => `<li>${esc(text)}</li>`).join('')}</ul></section>`;
}
function riskForm(csrf: string, values: Record<string, string>, error?: string): string {
  const rawCount = Number(values.lotCount ?? 1), lotCount = Number.isSafeInteger(rawCount) && rawCount > 0 && rawCount <= RISK_LOT_LIMIT ? rawCount : 1;
  const field = (name: string, text: string, type = 'text', required = true) => `<div class="sr-field"><label for="risk-${name}">${esc(text)}</label><input id="risk-${name}" name="${name}" type="${type}" value="${esc(values[name] ?? '')}"${required ? ' required' : ''}${type === 'text' ? ' inputmode="decimal"' : ''}></div>`;
  const lots = Array.from({ length: lotCount }, (_, n) => {
    const prefix = `lot_${n + 1}_`;
    return `<fieldset><legend>第 ${n + 1} 批持仓</legend><div class="sr-form-grid">${field(prefix+'quantity', '持有股数（整数股）', 'text', false)}${field(prefix+'sellableQuantity', '可卖股数（整数股）', 'text', false)}${field(prefix+'acquiredOn', '取得日期', 'date', false)}${field(prefix+'unlocksOn', '解锁日期', 'date', false)}${field(prefix+'costYuan', '该批全部持仓总成本（元，含费用）', 'text', false)}</div></fieldset>`;
  }).join('');
  return `<section class="sr-section" id="risk-input"><h2 class="sr-sec-h">录入并导出本地风险前提</h2>
<p>标的601919。请完整填写自己的资金与持仓；没有这些资料时不计算个人数量。输入仅用于创建一份本地研究快照，不表示已取得真实研究调用或实际运行授权。确认后下载文件；不会自动运行历史验证或模拟，也不会改写已有研究。</p>
<p>历史快照日只描述输入归属；确认、首次取得与可得时间均为本次实际时间，不能用于证明过去已可得。压力损失是情景预算，跳空假设不保证损失上限。</p>
${error ? `<div class="sr-alert sr-alert-amber" role="alert">${esc(error)}。请修正后重新确认；已输入值保留。</div>` : ''}
<form method="post" action="/strategies/601919/workbench/risk-export" class="sr-form">
<input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="subject" value="601919"><input type="hidden" name="lotCount" value="${lotCount}">
<div class="sr-form-grid">${field('asOf', '快照归属日期（UTC）', 'date')}${field('cashYuan', '可用资金（元，最多两位小数）')}${field('maxPositionYuan', '该标的最大持仓金额（元）')}${field('maxLossYuan', '该标的最大压力损失预算（元）')}${field('stressGapPercent', '压力向下跳空假设（%，不小于0且小于100）')}</div>
<h3>逐批填写该标的持仓</h3><p>每批分别填写；填写一项后，该批五项都需完整。未使用的批次保持全部空白。没有持仓时请明确勾选下方确认；没有资料时不要填0冒充空仓。</p>
${lots}<button class="sr-btn" name="action" value="add-lot" type="submit" formnovalidate>增加一批持仓</button>
<div class="sr-check"><input id="risk-noHoldings" name="noHoldings" type="checkbox" value="yes"${values.noHoldings === 'yes' ? ' checked' : ''}><label for="risk-noHoldings">我明确确认没有该标的持仓（与上方持仓二选一）</label></div>
<div class="sr-check"><input id="risk-confirm" name="confirm" type="checkbox" value="yes" required><label for="risk-confirm">我确认本次资金、每批持仓、日期、成本与风险假设完整准确，并理解这会创建当前时间的新输入</label></div>
<button class="sr-btn sr-btn-primary" type="submit">确认并下载新风险快照</button></form></section>`;
}

export function renderWorkbenchContent(state: WorkbenchPageState, csrf: string, values: Record<string, string> = {}, error?: string): string {
  let content = `<header class="sr-report-head"><h1 class="sr-h1">L2 工作区</h1><p><a href="/strategies/601919">返回真实资料条件草案</a> · <a href="#risk-input">录入风险前提</a> · <a href="#workbench-originals">查看原件与复核详情</a></p><p>先核对资料与风险前提，再阅读计划、样本内外验证和模拟归因。合成演示独立标明，不代表当前真实草案已通过验证。</p></header>`;
  if (state.status !== 'LOADED') content += `<section class="sr-section"><h2>${esc(label(state.status))}</h2><p role="status">${state.status === 'FAILED' ? '封存文件未通过校验，请重新载入有效文件包。' : '尚未选择有效的封存文件包。'}</p><p>没有载入结果，不回退演示；计划、数量、指标均未计算。</p><details id="workbench-originals"><summary>原件与错误详情</summary><p>${esc(state.status)} · ${esc(state.detail)}</p><a href="/api/strategies/601919/workbench">查看工作区完整 JSON</a></details></section>`;
  else {
    const { result: r, manifestSha256, sources } = state.loaded;
    content += `<section class="sr-section"><h2 class="sr-sec-h">${esc(r.subjectName)}</h2><p class="sr-alert sr-alert-amber">${r.inputIdentity === 'SYNTHETIC' ? '合成离线演示：仅检查工程行为，不是当前真实草案的历史验证。' : '真实封存资料：资料覆盖与离线计算不能代替真实历史及效果接受。'}</p><p>结果创建时间 ${esc(r.createdAt)}。真实复核未完成；实际运行未授权；策略效果尚未接受。</p>
${table(['资料', '规则适配', '历史验证', '当前条件'], [[label(r.status), label(r.plan?.snapshot.decision), label(r.validation?.status), label(r.simulation?.condition)]])}
${r.blockers.length ? table(['当前阻断原因', '对应日期'], r.blockers.map((b) => [b.detail, b.date])) : ''}</section>`;
    if (r.account) content += `<section class="sr-section"><h2 class="sr-sec-h">结果所用风险输入</h2><p>${r.account.identity === 'SYNTHETIC_ACCOUNT' ? '合成演示资金与持仓，不是您的实际账户' : '用户确认的本地研究快照，不代表实际运行账户授权'}。归属日期 ${esc(r.account.asOf)}；确认时间 ${esc(r.account.confirmedAt)}；可得时间 ${esc(r.account.availableAt)}。</p>${table(['可用资金', '最大持仓金额', '最大压力损失预算', '向下跳空假设'], [[money(r.account.cashFen), money(r.account.constraints.maxPositionValueFen), money(r.account.constraints.maxLossFen), percent(r.account.constraints.stressGapBps)]])}${table(['标的', '持有股数', '可卖股数', '取得日', '解锁日', '该批总成本'], r.account.holdings.map((h) => [h.subject, count(h.quantity, '股'), count(h.sellableQuantity, '股'), h.acquiredOn, h.unlocksOn, money(h.costFen)]))}</section>`;
    else content += '<p>结果没有账户快照；未假设空仓或个人默认资金。</p>';
    if (r.status === 'INPUT_BLOCKED') content += '<p>输入阻断，未生成计划、样本内外验证、复核与模拟；数量和收益均未计算。</p>';
    else content += `${planContent(r.plan)}<section class="sr-section"><h2 class="sr-sec-h">历史验证与离线复核边界</h2><p>历史验证：${esc(label(r.validation.status))}。复核记录：${esc(label(r.review.publication))}。${r.review.gate.passed ? '本文件的离线复核门通过，仍不等于真实模型复核或实际运行授权。' : '离线复核门阻断，不能将本结果视为已验证方案。'}</p>${r.review.gate.blockers.length ? table(['复核阻断原因'], r.review.gate.blockers.map((b) => [reason(b)])) : ''}<details><summary>统计口径与全部机会分母定义</summary>${table(['统计项目', '口径'], Object.entries(r.validation.denominatorDefinitions).map(([key, value]) => [denominatorLabels[key] ?? key, value]))}</details></section>${replay('样本内 IS', r.validation.inSample)}${replay('样本外 OOS', r.validation.outOfSample)}${replay('冻结计划离线模拟与归因', r.simulation)}`;
    content += `<section class="sr-section" id="workbench-originals"><details><summary>原件与复核详情：文件身份、版本、完整计划和数据</summary><p>以下保留原始身份和程序状态，供逐项查证；不改变上面的研究边界。</p>
${table(['技术状态', '原值'], [['输入身份', r.inputIdentity], ['结果状态', r.status], ['历史验证状态', r.validation?.status], ['离线复核状态', r.review?.publication], ['模拟状态', r.simulation?.status]])}
${table(['原件身份', 'SHA-256'], [['结果', r.resultHash], ['文件清单', manifestSha256], ['请求', r.binding.requestSha256], ['数据', r.binding.dataHash], ['规则', r.binding.rulesHash], ['原资料清单', r.binding.baseManifestSha256], ['风险输入原件', r.account?.artifactSha256]])}
${r.plan ? table(['方法版本', '数据/适配器版本', '计划/授权版本'], [[r.plan.rules.methodVersion, r.plan.rules.dataContractVersion, r.plan.rules.planAuthVersion]]) : ''}
<ul>${sources.map((s) => `<li><a href="/api/strategies/601919/workbench/sources/${encodeURIComponent(s.id)}">${esc(s.label)}</a> · ${esc(s.mediaType)}</li>`).join('')}</ul><p><a href="/api/strategies/601919/workbench">查看工作区完整 JSON（API）</a></p>
${r.plan ? `<details><summary>完整冻结计划 JSON</summary><pre class="sr-table-scroll">${esc(JSON.stringify(r.plan, null, 2))}</pre></details>` : ''}<details><summary>具名阻断与完整结果 JSON</summary><pre class="sr-table-scroll">${esc(JSON.stringify(r, null, 2))}</pre></details></details></section>`;
  }
  return content + riskForm(csrf, values, error);
}
