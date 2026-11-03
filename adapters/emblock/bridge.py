#!/usr/bin/env python3
"""Lyra · 大宗交易明细（东财 datacenter）桥（P2 W37: code-writer，B1）。

容器化运行（与 adapters/emdc/bridge.py 同模式）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/emblock/bridge.py <cmd> ...

单文件单子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/{baostock,sw,emdc}/bridge.py
同合同）：成功 {ok: true, rows: [...], meta?}，失败 {ok: false, error_code, error}；退出码 0/1。
rows 字段原样保留来源字段名（DATA-SOURCES §6.2），数值保持来源类型（int/float）。

子命令（W37 探测实测 2026-10-25，容器 akshare 1.19.3；探测脚本 var/w37-probe.py）：
  mrmx <start YYYYMMDD> <end YYYYMMDD>
      ak.stock_dzjy_mrmx(symbol="A股", start_date, end_date)——东财 datacenter-web
      （非 R24.4 断连的 push2 报价系；Owner 渠道指令"东财优先"下的首选渠道，探测可用）。
      列（实测 13 列）：序号/交易日期/证券代码/证券简称/涨跌幅/收盘价/成交价/折溢率/
      成交量/成交额/成交额/流通市值/买方营业部/卖方营业部。
      接口形态：单 HTTP 请求 pageSize=5000 pageNumber=1，akshare 无分页循环——31 天窗
      实测 1,720 行（2024-09-20~2024-10-20，含 9·24 行情放量段）远低于 5,000 上限；
      TS 侧以 rows>=5000 具名错误防静默截断（EMBLOCK_SUSPECTED_TRUNCATION）。

选型依据（B1 派发：按个股全历史 vs 按日全市场过滤池内，实测后裁定）：
- akshare 1.19.3 dzjy 族中 stock_dzjy_sctj（市场个股统计，无参，固定区间段聚合）与
  stock_dzjy_hygtj（行业个股统计，固定区间段聚合）均为聚合统计面、无逐笔明细且区间
  不可自选；stock_dzjy_mrtj（每日统计）为市场级每日汇总（且签名无 symbol 参数）——
  三者均非个股级明细。mrmx 是唯一逐笔明细接口且支持任意日期区间 → 选
  **按区间全市场明细 + 事实面按池过滤**（同 W28 龙虎榜形态），比逐股逐日少两个数量级调用。
- 来源行无成交时刻列（实测 time_like_cols=[]）→ availableAt 取交易日次日 00:00 保守口径
  （B1 派发冻结），TS 适配器侧声明。

桥侧剔除 序号 列：akshare 对响应 reset_index 后生成的重排序号（index+1），随调用窗口
选择漂移（同一行在不同窗口下序号不同），非来源数据——剔除后同业务键重放 raw 稳定，
TS 侧 factId 去重（§6.5）跨窗口成立。其余列原样保留。
"""
import json
import sys


USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "EMBLOCK_QUERY_FAILED"


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
    if cmd == "mrmx":
        _require(
            len(args) == 2 and all(len(a) == 8 and a.isdigit() for a in args),
            "mrmx <start YYYYMMDD> <end YYYYMMDD>",
        )
        _require(args[0] <= args[1], f"start > end：{args[0]} > {args[1]}")
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

    if cmd == "mrmx":
        df = ak.stock_dzjy_mrmx(symbol="A股", start_date=args[0], end_date=args[1])
        dropped = []
        if "序号" in df.columns:
            df = df.drop(columns=["序号"])  # akshare reset_index 产物，随窗口漂移，非来源数据
            dropped.append("序号")
        return {
            "ok": True,
            "rows": df_rows(df),
            "meta": {
                "interface": "stock_dzjy_mrmx",
                "symbol": "A股",
                "start": args[0],
                "end": args[1],
                "droppedColumns": dropped,
            },
        }
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def main(argv):
    # fd 级压制三方库输出（akshare tqdm/requests 的 print/warning），stdout 只留一个 JSON
    # 对象（与 baostock/sw/emdc 桥同法：dup2 换 fd + 换 sys.stdout 对象）。
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
