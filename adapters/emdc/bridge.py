#!/usr/bin/env python3
"""Lyra · 两融明细（沪深交易所官方）+ 龙虎榜（东财）桥（P2 W28: code-writer-pro）。

容器化运行（与 adapters/sw/bridge.py 同模式）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/emdc/bridge.py <cmd> ...

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/{baostock,sw}/bridge.py 同合同）：
成功 {ok: true, rows: [...], meta?}，失败 {ok: false, error_code, error}；退出码 0/1。
rows 字段原样保留来源字段名（DATA-SOURCES §6.2），数值保持来源类型（int/float）。

子命令（W28 探测实测 2026-10-25，容器 akshare 1.19.3；探测脚本 var/w28-probe.py）：
  margin_sse <date YYYYMMDD>   ak.stock_margin_detail_sse(date)——上交所官方
                              query.sse.com.cn 单日全市场两融明细（股票+ETF，
                              实测 2026-10-21 返回 2,000 行 9 列；接口单请求
                              pageHelp.pageSize=5000，无分页截断）。列含 信用交易日期。
  margin_szse <date YYYYMMDD>  ak.stock_margin_detail_szse(date)——深交所官方单日
                              全市场明细（实测 2,116 行 8 列，非整数页界无截断）。
                              深市响应**无日期列**：桥为每行附 信用交易日期=<请求参数>
                              （原始 8 列原样保留；该附加字段是请求参数回填，非来源数据）。
  lhb_detail <start> <end>     ak.stock_lhb_detail_em(start_date, end_date)——东财
                              datacenter-web（非 R24.4 断连的 push2 报价系），区间一次
                              调用返回全部上榜行（实测 5 日窗 327 行 21 列，含 上榜日/代码/
                              上榜原因/龙虎榜净买额 与 上榜后1/2/5/10日 前视列——原样保留）。

选型依据（Owner 渠道指令"东财/新浪优先"下的可用性裁选）：
- 两融：akshare 1.19.3 无东财/新浪的个股级日频两融接口（stock_margin_account_info 为
  市场级账户统计；新浪无两融面），交易所官方明细是唯一可得的个股级日频口径（一手来源）。
- 龙虎榜：东财 stock_lhb_detail_em 即 Owner 首选渠道，探测可用。
"""
import json
import sys


USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "EMDC_QUERY_FAILED"


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require(cond, message):
    if not cond:
        raise BridgeError(USAGE_ERROR, message)


def parse_args(argv):
    _require(len(argv) >= 1, "缺子命令；用法见文件头注释")
    cmd, args = argv[0], argv[1:]
    if cmd == "margin_sse":
        _require(len(args) == 1 and len(args[0]) == 8 and args[0].isdigit(), "margin_sse <date YYYYMMDD>")
        return cmd, args
    if cmd == "margin_szse":
        _require(len(args) == 1 and len(args[0]) == 8 and args[0].isdigit(), "margin_szse <date YYYYMMDD>")
        return cmd, args
    if cmd == "lhb_detail":
        _require(
            len(args) == 2 and all(len(a) == 8 and a.isdigit() for a in args),
            "lhb_detail <start YYYYMMDD> <end YYYYMMDD>",
        )
        _require(args[0] <= args[1], f"start > end：{args[0]} > {args[1]}")
        return cmd, args
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def jsonable(value):
    """numpy/pandas 标量与日期 → JSON 原生类型；NaN → None。"""
    import datetime as _dt

    import numpy as np
    import pandas as pd

    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, (int, np.integer)):  # pandas 3.x to_dict 返回原生 int（W37 发现同构缺陷，2026-10-26 修）
        return int(value)
    if isinstance(value, (np.floating, float)):
        f = float(value)
        return None if f != f else f  # NaN 检查（NaN != NaN）
    if isinstance(value, (np.str_, str)):
        return str(value)
    if isinstance(value, (_dt.datetime, pd.Timestamp)):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, _dt.date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, (np.ndarray, list)):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    return str(value)


def df_rows(df):
    return [jsonable(dict(rec)) for rec in df.to_dict(orient="records")]


def run(cmd, args):
    import akshare as ak

    if cmd == "margin_sse":
        df = ak.stock_margin_detail_sse(date=args[0])
        return {"ok": True, "rows": df_rows(df), "meta": {"interface": "stock_margin_detail_sse", "date": args[0]}}
    if cmd == "margin_szse":
        df = ak.stock_margin_detail_szse(date=args[0])
        rows = []
        for rec in df.to_dict(orient="records"):
            row = jsonable(dict(rec))
            row["信用交易日期"] = args[0]  # 深市响应无日期列：请求参数回填（非来源数据）
            rows.append(row)
        return {"ok": True, "rows": rows, "meta": {"interface": "stock_margin_detail_szse", "date": args[0]}}
    if cmd == "lhb_detail":
        df = ak.stock_lhb_detail_em(start_date=args[0], end_date=args[1])
        return {
            "ok": True,
            "rows": df_rows(df),
            "meta": {"interface": "stock_lhb_detail_em", "start": args[0], "end": args[1]},
        }
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def main(argv):
    # fd 级压制三方库输出（akshare tqdm/requests 的 print/warning），stdout 只留一个 JSON
    # 对象（与 baostock/sw 桥同法：dup2 换 fd + 换 sys.stdout 对象）。
    import os

    saved_obj = sys.stdout
    sys.stdout.flush()
    saved_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, 1)
    sys.stdout = os.fdopen(os.dup(devnull_fd), "w")
    payload = {"ok": False}
    try:
        cmd, args = parse_args(argv)
        payload = run(cmd, args)
    except BridgeError as exc:
        payload = {"ok": False, "error_code": exc.code, "error": str(exc)}
    except Exception as exc:  # 网络/解析等未预期异常按瞬态查询失败上报（TS 侧退避重试）
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
