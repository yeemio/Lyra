#!/usr/bin/env python3
"""Lyra · 东财资产负债表桥：个股资产负债表按报告期全历史（P1 W30: code-writer）。

容器化运行（与 sw / emrisk / emdc / emfund 桥同模式；akshare 1.19.3 在命名卷 lyra-akshare-py311）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/embalance/bridge.py balance <SYMBOL>

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/{baostock,sw,emrisk,emfund}/bridge.py
同合同）：成功 {ok: true, rows: [...], meta}，失败 {ok: false, error_code, error}；退出码 0/1。

选型（W30 2026-10-26 实测，探测证据 /tmp/lyra-w30/probe-balance.json + /tmp/lyra-w30/probe-bs.py
输出，另见 src/adapters/embalance.ts 文件头"来源与选型"节）：
- 派发预设 BaoStock query_balance_data **不含商誉**：venv baostock 0.9.40 实测（sh.600519
  2024Q4 一次真实调用）仅返回 9 列偿债比率（code/pubDate/statDate/currentRatio/quickRatio/
  cashRatio/YOYLiability/liabilityToAsset/assetToEquity）；穷举包源码无任何 goodwill 字段。
  "baostock balance 取商誉"前提不成立，按 Owner 渠道指令"东财优先"改走东财（总控回传中说明）。
- 选定：akshare.stock_balance_sheet_by_report_em（东财 F10 资产负债表按报告期）——**每股一次
  调用拿全历史**（600519 实测 103 行，1998-12-31 → 2026-06-30，全部报告期含一季报/中报/三季报/
  年报；列含 GOODWILL / TOTAL_ASSETS / TOTAL_EQUITY / TOTAL_PARENT_EQUITY，单位元 CNY）。
  逐行 NOTICE_DATE（公告披露日，实测 600519 103 行 0 空值）供时点口径；与 BaoStock pubDate
  交叉验证一致（600519 2024-12-31 两源同 2025-04-03）。

参数形态：symbol 须为 <交易所前缀><6 位代码>（SH600519 / SZ000938——akshare 该包装的原生形态；
前缀由 TS 侧按主板规则（R17：6→SH，0→SZ）派生，桥只做形态校验透传）。

时点口径（映射层 src/adapters/embalance.ts 冻结，桥只取数不改语义）：
- BALANCE：公告披露口径（与 BaoStock FINANCIAL pubDate 同法）——availableAt=NOTICE_DATE 次日
  00:00 Asia/Shanghai（披露日精度 → 保守 D+1）；无 NOTICE_DATE 行由映射器具名拒绝、不落库。
- 桥自加确定性前缀转换字段 REPORT_DATE_ISO / NOTICE_DATE_ISO（YYYY-MM-DD；原文两列原样保留，
  与 emrisk 桥 TRADE_DATE_ISO 同法）。
"""
import datetime as _dt
import json
import os
import re
import sys

USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "EMBALANCE_QUERY_FAILED"
SYMBOL_PATTERN = re.compile(r"^(SH|SZ)\d{6}$")
DATE_PREFIX_PATTERN = re.compile(r"^(\d{4}-\d{2}-\d{2})")
ISO_FIELDS = ("REPORT_DATE", "NOTICE_DATE")


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require(cond, message):
    if not cond:
        raise BridgeError(USAGE_ERROR, message)


def parse_args(argv):
    _require(len(argv) == 2, "缺子命令或代码；用法：balance <SYMBOL>（如 SH600519）")
    cmd, symbol = argv
    _require(cmd == "balance", f"未知子命令：{cmd}")
    _require(SYMBOL_PATTERN.match(symbol) is not None, f"symbol 须为 SH/SZ+6 位代码：{symbol}")
    return cmd, symbol


def jsonable(value):
    """JSON 反序列化产物直接可输出；datetime 等兜底转字符串；NaN → null。"""
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, float) and value != value:  # NaN
        return None
    return value


def with_date_iso(row):
    """附 REPORT_DATE_ISO / NOTICE_DATE_ISO（YYYY-MM-DD 前缀，确定性转换；原文列原样保留）。"""
    out = row
    for field in ISO_FIELDS:
        raw = out.get(field)
        if isinstance(raw, str):
            m = DATE_PREFIX_PATTERN.match(raw)
            if m is not None:
                out[f"{field}_ISO"] = m.group(1)
    return out


def cmd_balance(symbol):
    try:
        import akshare as ak

        df = ak.stock_balance_sheet_by_report_em(symbol=symbol)
    except Exception as exc:
        raise BridgeError(QUERY_ERROR, f"{type(exc).__name__}: {exc}") from exc
    rows = [with_date_iso(jsonable(dict(rec))) for rec in df.to_dict(orient="records")]
    meta = {"resource": "balance_sheet", "symbol": symbol, "rows": len(rows)}
    if not rows:
        meta["emptySource"] = True  # 来源无该股序列：如实空集返回（不报错、不造数）
    return {"ok": True, "rows": rows, "meta": meta}


def main(argv):
    # fd 级压制三方库输出（akshare tqdm 走 stderr，pandas 可能 print 到 stdout），
    # stdout 只留一个 JSON 对象（与 baostock/sw/emrisk/emfund 桥同法）。
    saved_obj = sys.stdout
    sys.stdout.flush()
    saved_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, 1)
    sys.stdout = os.fdopen(os.dup(devnull_fd), "w")
    payload = {"ok": False}
    try:
        cmd, symbol = parse_args(argv)
        payload = cmd_balance(symbol)
    except BridgeError as exc:
        payload = {"ok": False, "error_code": exc.code, "error": str(exc)}
    except Exception as exc:  # 未预期异常按瞬态查询失败上报（TS 侧退避重试）
        payload = {"ok": False, "error_code": QUERY_ERROR, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        sys.stdout.flush()
        sys.stdout.close()
        sys.stdout = saved_obj
        os.dup2(saved_fd, 1)
        os.close(saved_fd)
        os.close(devnull_fd)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
