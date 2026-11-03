/**
 * Lyra · 适配器共享契约（P1 W4: code-writer-pro）。
 * 合同：docs/specs/DATA-SOURCES.md §6（适配器规则）§7（限流退避）§5（修订口径声明）。
 *
 * 各来源适配器（baostock / cninfo / …）共用的类型、具名错误与常量；
 * 退避器与并发闸在 ./backoff.ts，各来源适配器只 import、不重复实现。
 */

// ===== 桥响应（Python 桥 stdout JSON 的 TS 侧形态）=====

/** 单行来源数据：键为来源原生字段名（BaoStock 字段原样保留，DATA-SOURCES §6.2），值一律字符串。 */
export type BridgeRow = Record<string, string>;

/**
 * 桥一次调用的输出合同：{ok, error?, error_code?, rows}。
 * ok=false 时 error_code 供退避器分类（USAGE_ERROR 等永久错误不重试）。
 */
export interface BridgeResponse {
  ok: boolean;
  error?: string | undefined;
  error_code?: string | undefined;
  rows?: BridgeRow[] | undefined;
}

// ===== 资源类别（DATA-SOURCES §6.5 去重键的 resource 段）=====

export type AdapterResource =
  | 'daily_kline'
  | 'adjust_factor'
  | 'quarter_financial'
  | 'trade_calendar'
  | 'stock_pool'
  | 'index_constituents';

// ===== 具名错误 =====

/** 适配器层具名错误基类。code 为稳定错误名，不携带实现细节。 */
export class AdapterError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'AdapterError';
  }
}

/**
 * 瞬态错误（限流/超时/临时不可用）：退避器只重试本类（DATA-SOURCES §7）。
 * 永久错误（参数/配置错，如 USAGE_ERROR、BAOSTOCK_PYTHON_MISSING）直接抛出不重试、不暂停。
 */
export class TransientAdapterError extends AdapterError {}

// ===== 修订口径声明（DATA-SOURCES §5 / POINT-IN-TIME §6，原文，不改写不省略）=====

export const BACKFILL_REVISION_NOTICE =
  '修订口径声明：一次性回填 2015–2026 拿到的是当前最新修订值，与当时公告值可能不同且不可复原；历史参照库的事件主证据以公告 PDF 原文为准，结构化数据做辅助。';
