/**
 * Lyra · 结算域精确十进制定点单测（P3 W13: code-writer-pro）。纯函数，无 DB。
 * 合同判定：SETTLEMENT-REVIEW SR-2.2 数值纪律（禁浮点漂移；未决 3 scale=12 冻结）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEC_ONE,
  DEC_ZERO,
  SettlementError,
  decAbs,
  decAdd,
  decCmp,
  decDiv,
  decFrom,
  decFromInt,
  decFromJsonNumber,
  decFromString,
  decIsZero,
  decMax,
  decMin,
  decMul,
  decNeg,
  decSub,
  decToString,
} from './decimal.js';

test('decFromString/decToString 往返与展示（去尾零、零恒 0）', () => {
  assert.equal(decToString(decFromString('34.5100')), '34.51');
  assert.equal(decToString(decFromString('0.000000000001')), '0.000000000001'); // scale 边界
  assert.equal(decToString(decFromString('-0.5000')), '-0.5');
  assert.equal(decToString(decFromString('1000')), '1000');
  assert.equal(decToString(decFromString('-0.0000')), '0'); // 不产生 '-0'
  assert.equal(decToString(DEC_ZERO), '0');
  assert.equal(decToString(DEC_ONE), '1');
});

test('decFromString 具名拒绝：非定点/超 scale/空串', () => {
  const bad = ['1e3', '1.2e-3', '', 'abc', '1.2.3', '.5', '5.', '+5', '0.1234567890123'];
  for (const s of bad) {
    assert.throws(() => decFromString(s), (e: unknown) => e instanceof SettlementError, s);
  }
});

test('decFromJsonNumber：jsonb number 经 String(n) 最短往返表示取回（指数点位量级无损）', () => {
  assert.equal(decToString(decFromJsonNumber(17656.79)), '17656.79');
  assert.equal(decToString(decFromJsonNumber(1000)), '1000');
  assert.equal(decToString(decFromJsonNumber(1024.64)), '1024.64');
  assert.throws(() => decFromJsonNumber(1e21), (e: unknown) => e instanceof SettlementError); // 指数形式拒绝
  assert.throws(() => decFromJsonNumber(Number.NaN), (e: unknown) => e instanceof SettlementError);
  // decFrom 分派：字符串与 number 同一入口
  assert.equal(decToString(decFrom('12.34')), '12.34');
  assert.equal(decToString(decFrom(12.34)), '12.34');
});

test('加減乘：精确无浮点漂移（0.1+0.2 === 0.3；大整数安全）', () => {
  const a = decFromString('0.1');
  const b = decFromString('0.2');
  assert.equal(decToString(decAdd(a, b)), '0.3'); // 浮点下为 0.30000000000000004
  assert.equal(decCmp(decAdd(a, b), decFromString('0.3')), 0);
  assert.equal(decToString(decSub(decFromString('0.3'), a)), '0.2');
  assert.equal(decToString(decMul(decFromString('1.1'), decFromString('1.1'))), '1.21');
  assert.equal(decToString(decMul(decFromString('-2.5'), decFromString('4'))), '-10');
  assert.equal(decToString(decFromInt(123)), '123');
});

test('除法：scale-12 half-up 舍入（1/3 与 2/3 的第 12 位）', () => {
  // 1/3 = 0.3333333333333… → half-up 第 12 位 = 0.333333333333
  assert.equal(decToString(decDiv(DEC_ONE, decFromInt(3))), '0.333333333333');
  // 2/3 = 0.6666666666666… → half-up = 0.666666666667
  assert.equal(decToString(decDiv(decFromInt(2), decFromInt(3))), '0.666666666667');
  // 负数 half 远离零：-1/2 整除、-1/3 → -0.333333333333（第 13 位 3，舍去）
  assert.equal(decToString(decDiv(decFromInt(-1), decFromInt(3))), '-0.333333333333');
  // half 精确触发：1/8 = 0.125（scale 12 内精确，无舍入）
  assert.equal(decToString(decDiv(DEC_ONE, decFromInt(8))), '0.125');
  // 除零具名错误
  assert.throws(() => decDiv(DEC_ONE, DEC_ZERO), (e: unknown) => e instanceof SettlementError);
});

test('比较与极值：decCmp 精确（浮点会误判的边界）', () => {
  // 浮点：0.1*3 === 0.3 为 false；定点为真
  const threeTenths = decAdd(decAdd(decFromString('0.1'), decFromString('0.1')), decFromString('0.1'));
  assert.equal(decCmp(threeTenths, decFromString('0.3')), 0);
  assert.equal(decCmp(decFromString('0.300000000001'), decFromString('0.3')), 1);
  assert.equal(decCmp(decFromString('-0.000000000001'), DEC_ZERO), -1);
  assert.equal(decIsZero(DEC_ZERO), true);
  assert.equal(decIsZero(decFromString('-0.0000')), true);
  assert.equal(decToString(decAbs(decFromString('-0.5'))), '0.5');
  assert.equal(decToString(decNeg(decFromString('0.5'))), '-0.5');
  assert.equal(decToString(decMin(decFromString('-0.2'), decFromString('0.1'))), '-0.2');
  assert.equal(decToString(decMax(decFromString('-0.2'), decFromString('0.1'))), '0.1');
});

test('价格与指数量级运算的精确性（结算量级冒烟）', () => {
  // 后复权比价：1521.50 × 6.969311 / (1501.00 × 7.113689)（600519 2024-06-18/19 真实因子链量级）
  const adjA = decMul(decFromString('1521.50'), decFromString('6.969311'));
  const adjB = decMul(decFromString('1501.00'), decFromString('7.113689'));
  const ratio = decDiv(adjA, adjB);
  // 期望值独立复核：python decimal（prec 50）同链路 half-up 12 位 = 0.993084571798
  assert.equal(decToString(ratio), '0.993084571798');
  assert.equal(decCmp(ratio, DEC_ONE), -1);
});
