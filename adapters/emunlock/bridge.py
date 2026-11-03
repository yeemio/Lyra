#!/usr/bin/env python3
"""Lyra · 限售解禁批次明细（东财 datacenter）桥（P2 W42: code-writer，C4）。

容器化运行（与 adapters/emblock/bridge.py 同模式）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/emunlock/bridge.py <cmd> ...

单文件单子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/{baostock,sw,emdc,emblock}/bridge.py
同合同）：成功 {ok: true, rows: [...], meta?}，失败 {ok: false, error_code, error}；退出码 0/1。
rows 字段原样保留来源字段名（DATA-SOURCES §6.2），数值保持来源类型（int/float）。

子命令（W42 探测实测 2026-10-25，容器 akshare 1.19.3；探测脚本 var/w42-probe{,2,3}.py）：
  queue <6 位股票代码>
      ak.stock_restricted_release_queue_em(symbol=<code>)——东财 datacenter-web
      RPT_LIFT_STAGE（个股限售解禁批次），单 HTTP 请求 pageSize=500 pageNumber=1、
      无分页循环 → **按个股全历史形态**（C4 派发选型）：一次调用返回该股全部解禁批次
      （含未来未到期批次；603986 实测 23 行 2017-08-18~2025-12-22，002384 实测 7 行
      2010-07-09~2028-06-28，600176 实测 5 行 2014-08-04~2030-07-01）。TS 侧以 rows>=500
      具名错误防静默截断（EMUNLOCK_SUSPECTED_TRUNCATION）。
      列（实测 13 列，剔除 序号 后 12）：解禁时间/解禁股东数/解禁数量/实际解禁数量/
      未解禁数量/实际解禁数量市值/占总市值比例/占流通市值比例/解禁前一交易日收盘价/
      限售股类型/解禁前20日涨跌幅/解禁后20日涨跌幅。
      来源行**无股票代码列**（akshare 列重命名时丢弃 SECURITY_CODE/SECURITY_NAME_ABBR）——
      代码 = 调用参数绑定，TS 适配器侧经 map context 注入 typedValue，raw 不掺合成列。
      来源行**无公告日列**（实测 announce_like_cols=[]）→ availableAt 口径见 TS 侧
      EMUNLOCK_REVISION_NOTICE（保守：解禁日次日 00:00+08）。
      单位（akshare 换算后）：解禁数量/实际解禁数量/未解禁数量 = 股（来源原始万股 ×10000）、
      实际解禁数量市值 = 元（来源原始万元 ×10000）——值保持 akshare 输出原样。
      空结果（如 600036 实测 0 行，东财该报告无此股记录）如实返回 rows=[]，TS 侧空原件
      入档非失败。

选型依据（C4 派发：容器探测 ≤6 请求实测后裁定按个股全历史形态）：
- queue_em：按个股全历史、单请求、含明细股数/市值/比例/限售股类型——正中 C4 目标
  （明细金额/股数充实参照库）；26 股 = 26 次调用，全历史一次到位。
- summary_em：市场级每日汇总（当日解禁家数/总量/总市值），无个股明细——不符。
- detail_em：同为 RPT_LIFT_STAGE 但按日期区间全市场分页拉取（toqdm 循环）——需按日历
  窗口切块、行数以全市场为分母，比逐股多数量级调用且无个股绑定优势——不选。
- stockholder_em：解禁股东级明细（需 symbol+date 二元定位，600036 默认参数实测报错）——
  调用量 = 26 股 × 各股批次数，超出本任务边界；批次级明细已含 C4 要的股数/金额——不选。

桥侧剔除 序号 列：akshare 对响应 reset_index 后生成的重排序号（FREE_DATE 降序下 index+1，
随抓取批次漂移），非来源数据——剔除后同业务键重放 raw 稳定，TS 侧 factId 去重（§6.5）
跨窗口成立。其余列原样保留。
"""
import json
import sys


USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "EMUNLOCK_QUERY_FAILED"

CODE_RE_ERROR = "股票代码须 6 位数字"


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
    if cmd == "queue":
        _require(len(args) == 1 and len(args[0]) == 6 and args[0].isdigit(), f"queue <6位股票代码>：{args}")
        return cmd, args
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def jsonable(value):
    """numpy/pandas 标量与日期 → JSON 原生类型；NaN → None。

    注意：pandas 3.x 的 to_dict(orient="records") 已把 int64 列解为原生 Python int
    （不命中 np.integer），须显式处理原生 int/float，否则落到末尾 str(value) 被误转字符串。
    bool 须在 int 之前判（bool 是 int 子类）。
    """
    import datetime as _dt

    import numpy as np
    import pandas as pd

    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
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

    if cmd == "queue":
        df = ak.stock_restricted_release_queue_em(symbol=args[0])
        dropped = []
        if "序号" in df.columns:
            df = df.drop(columns=["序号"])  # akshare reset_index 产物，随批次漂移，非来源数据
            dropped.append("序号")
        return {
            "ok": True,
            "rows": df_rows(df),
            "meta": {
                "interface": "stock_restricted_release_queue_em",
                "symbol": args[0],
                "droppedColumns": dropped,
            },
        }
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def main(argv):
    # fd 级压制三方库输出（akshare tqdm/requests 的 print/warning），stdout 只留一个 JSON
    # 对象（与 baostock/sw/emdc/emblock 桥同法：dup2 换 fd + 换 sys.stdout 对象）。
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
