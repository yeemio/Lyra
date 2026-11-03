#!/usr/bin/env python3
"""Lyra · 申万（swsresearch / legulegu，经 AKShare）桥（P1 W7: code-writer-pro）。

容器化运行（本机 Python 3.14 无 akshare wheel；与 lyra-pg 同模式，不装 host）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/sw/bridge.py <cmd> ...

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/baostock/bridge.py 同合同）：
成功 {ok: true, rows: [...], meta?}，失败 {ok: false, error_code, error}；退出码 0/1。
rows 字段原样保留来源字段名（DATA-SOURCES §6.2），数值保持来源类型（int/float）。

子命令：
  classify_xls [--use-cache]   下载申万 2021 目录下的逐股分类变更史 XLS（StockClassifyUse_stock.xls，
                               12,930 行：股票代码/计入日期/行业代码/更新日期，Excel 序列日期），
                               字节另存 /work/var/sw-StockClassifyUse_stock.xls（供原件入库）；
                               --use-cache 时该文件已存在则不再联网。rows 每行附 ISO 转换字段
                               （计入日期ISO / 更新日期ISO；确定性算术转换，原始序列值原样保留）。
  l1_list                      申万一级行业分类（akshare.sw_index_first_info，legulegu，31 行）。
  l1_daily <code>              一级行业指数日线全历史（akshare.index_hist_sw，swsresearch API）。
  l1_component <code>          一级行业当前成分股（akshare.index_component_sw，含计入日期）。

实测运行事实（2026-10-25，总控 R23）：swsresearch API 需浏览器 UA（akshare 内部已带，
verify=False）；XLS 直链无强校验，仍带 UA/Referer 以稳。
"""
import hashlib
import json
import os
import sys
import urllib.request

XLS_URL = "https://www.swsresearch.com/swindex/pdf/SwClass2021/StockClassifyUse_stock.xls"
XLS_CACHE = "/work/var/sw-StockClassifyUse_stock.xls"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/114.0.0.0 Safari/537.36"
)

USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "SW_QUERY_FAILED"
XLS_ERROR = "SW_XLS_FAILED"


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
    if cmd == "classify_xls":
        _require(len(args) <= 1 and all(a == "--use-cache" for a in args), "classify_xls [--use-cache]")
        return cmd, args
    if cmd == "l1_list":
        _require(len(args) == 0, "l1_list（无参数）")
        return cmd, args
    if cmd in ("l1_daily", "l1_component"):
        _require(len(args) == 1, f"{cmd} <code>（申万一级指数代码，如 801010）")
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
    if isinstance(value, (np.integer,)):
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


def download_xls(use_cache):
    if use_cache and os.path.exists(XLS_CACHE):
        with open(XLS_CACHE, "rb") as fh:
            data = fh.read()
        return data, True
    req = urllib.request.Request(XLS_URL, headers={"User-Agent": UA, "Referer": "https://www.swsresearch.com/"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    if len(data) < 1024:
        raise BridgeError(XLS_ERROR, f"XLS 字节数异常：{len(data)}")
    os.makedirs(os.path.dirname(XLS_CACHE), exist_ok=True)
    tmp = XLS_CACHE + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, XLS_CACHE)
    return data, False


def excel_serial_to_datetime(serial, datemode):
    """Excel 序列值 → datetime（1900 体系锚 1899-12-30；xlrd 处理 datemode）。带小数部分（时刻）。"""
    import datetime as _dt

    import xlrd

    return xlrd.xldate.xldate_as_datetime(serial, datemode)


def cmd_classify_xls(use_cache):
    import xlrd

    data, cached = download_xls(use_cache)
    book = xlrd.open_workbook(file_contents=data)
    sheet = book.sheet_by_index(0)
    if sheet.ncols != 4:
        raise BridgeError(XLS_ERROR, f"列数异常：{sheet.ncols}（预期 4）")
    header = [str(sheet.cell_value(0, c)) for c in range(4)]
    if header != ["股票代码", "计入日期", "行业代码", "更新日期"]:
        raise BridgeError(XLS_ERROR, f"表头异常：{header}")
    rows = []
    for r in range(1, sheet.nrows):
        code = sheet.cell_value(r, 0)
        serial_in = sheet.cell_value(r, 1)
        ind_code = sheet.cell_value(r, 2)
        serial_upd = sheet.cell_value(r, 3)
        if not (isinstance(code, str) and code and isinstance(ind_code, str) and ind_code):
            raise BridgeError(XLS_ERROR, f"第 {r + 1} 行类型异常：{code!r}/{ind_code!r}")
        if not (isinstance(serial_in, float) and isinstance(serial_upd, float)):
            raise BridgeError(XLS_ERROR, f"第 {r + 1} 行日期序列非数值：{serial_in!r}/{serial_upd!r}")
        rows.append({
            "股票代码": code,
            "计入日期": serial_in,
            "计入日期ISO": excel_serial_to_datetime(serial_in, book.datemode).strftime("%Y-%m-%d"),
            "行业代码": ind_code,
            "更新日期": serial_upd,
            "更新日期ISO": excel_serial_to_datetime(serial_upd, book.datemode).strftime("%Y-%m-%d %H:%M:%S"),
        })
    meta = {
        "sourceUrl": XLS_URL,
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "xlsCachePath": XLS_CACHE,
        "cached": cached,
        "dataRows": len(rows),
    }
    return {"ok": True, "rows": rows, "meta": meta}


def run(cmd, args):
    if cmd == "classify_xls":
        return cmd_classify_xls(use_cache="--use-cache" in args)
    import akshare as ak

    if cmd == "l1_list":
        return {"ok": True, "rows": df_rows(ak.sw_index_first_info())}
    if cmd == "l1_daily":
        return {"ok": True, "rows": df_rows(ak.index_hist_sw(symbol=args[0], period="day"))}
    if cmd == "l1_component":
        return {"ok": True, "rows": df_rows(ak.index_component_sw(symbol=args[0]))}
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def main(argv):
    # fd 级压制三方库输出（requests/urllib3/pandas 的 print/warning），stdout 只留一个 JSON 对象
    # （与 baostock 桥同法：dup2 换 fd + 换 sys.stdout 对象）。
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
