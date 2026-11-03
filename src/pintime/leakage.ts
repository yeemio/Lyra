import type { Pool } from 'pg';
import { PintimeError } from '../db/pintime.js';
import { loadFact, asOfFacts, type FactSelector } from './facts.js';
import { readSeal } from './seal.js';

export type LeakageReason = 'FACT_AFTER_CUTOFF' | 'SEALED_FACT_MISSING';

export interface LeakageViolation {
  factId: string;
  availableAt: string | null; // SEALED_FACT_MISSING 时为 null
  asOf: string;
  reason: LeakageReason;
  target: 'SELECTOR' | 'SEAL';
}

export interface LeakageQuery {
  factSelector?: FactSelector; // 与 sealId 二选一
  sealId?: string; // 与 factSelector 二选一
  asOf: Date; // 任选历史日期 D 封存/读回的断言截点
}

/**
 * 时点泄漏断言程序本体（POINT-IN-TIME §8，EK-10.2 第 7 条）：
 * 任选历史日期 D，加载目标集合——即该时点读回内容（selector 经 asOfFacts 解析后的全部事实，
 * 或 seal 封存的事实集与派生引用），断言集合中没有任何 availableAt > asOf 的事实；
 * 返回 violations 数组（空 = 通过）。
 * 封存的派生引用（artifactRefs）无 availableAt 字段，其可解析性由 verifySeal 负责。
 */
export async function assertNoLeakage(pool: Pool, query: LeakageQuery): Promise<LeakageViolation[]> {
  if (!(query.asOf instanceof Date) || Number.isNaN(query.asOf.getTime())) {
    throw new PintimeError('INVALID_ASOF', 'asOf must be a valid Date');
  }
  const hasSelector = query.factSelector !== undefined;
  const hasSeal = query.sealId !== undefined;
  if (hasSelector === hasSeal) {
    throw new PintimeError('INVALID_LEAKAGE_TARGET', 'exactly one of factSelector / sealId is required');
  }
  const asOfMs = query.asOf.getTime();
  const asOfIso = query.asOf.toISOString();
  const violations: LeakageViolation[] = [];

  if (query.factSelector !== undefined) {
    // 读回内容：as-of 解析后的全部事实。此处是对读取路径的独立复核——
    // 若 asOfFacts 解析有缺陷放进未来事实，这里必须报出。
    const facts = await asOfFacts(pool, { ...query.factSelector, asOf: query.asOf });
    for (const fact of facts) {
      if (new Date(fact.availableAt).getTime() > asOfMs) {
        violations.push({
          factId: fact.factId,
          availableAt: fact.availableAt,
          asOf: asOfIso,
          reason: 'FACT_AFTER_CUTOFF',
          target: 'SELECTOR',
        });
      }
    }
    return violations;
  }

  const seal = await readSeal(pool, query.sealId as string);
  if (seal === null) throw new PintimeError('SEAL_MISSING', String(query.sealId));
  for (const factId of seal.factIds) {
    const fact = await loadFact(pool, factId);
    if (fact === null) {
      violations.push({
        factId,
        availableAt: null,
        asOf: asOfIso,
        reason: 'SEALED_FACT_MISSING',
        target: 'SEAL',
      });
      continue;
    }
    if (new Date(fact.availableAt).getTime() > asOfMs) {
      violations.push({
        factId: fact.factId,
        availableAt: fact.availableAt,
        asOf: asOfIso,
        reason: 'FACT_AFTER_CUTOFF',
        target: 'SEAL',
      });
    }
  }
  return violations;
}
