#!/usr/bin/env python3
"""Lyra · 指数估值桥（P2 W31: code-writer-pro）。

容器化运行（与 adapters/sw/bridge.py 同模式，不装 host）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/valuation/bridge.py <cmd> ...

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/sw/bridge.py 同合同）：
成功 {ok: true, rows: [...], meta?}，失败 {ok: false, error_code, error}；退出码 0/1。
rows 字段原样保留来源字段名（DATA-SOURCES §6.2），数值保持来源类型（int/float）。

子命令：
  csindex_daily <code> [--use-cache]  中证指数公司官网 OSS autofile indicator/{code}indicator.xls
                                      （官方日频：市盈率1（总股本）/市盈率2（计算用股本）/股息率
                                      两种口径；实测为近 20 个交易日滚动窗口，非全史——W31 探测
                                      2026-10-25，000300/000016 均 20 行）。
                                      字节另存 /work/var/valuation-csindex-<code>indicator.xls
                                      （供原件入库）；--use-cache 时该文件已存在则不再联网。
                                      rows 每行附 日期ISO（yyyymmdd→ISO，确定性算术转换，
                                      原始整数值原样保留）。
  lg_pe <key>                         乐咕乐股指数市盈率（ak.stock_index_pe_lg，经 AKShare 1.19.3；
                                      月末频率全史 + 最新一日；六口径列：等权静态/静态/静态中位数/
                                      等权滚动/滚动/滚动中位数）。
  lg_pb <key>                         乐咕乐股指数市净率（ak.stock_index_pb_lg；月末频率全史 +
                                      最新一日；三口径列：市净率/等权市净率/市净率中位数）。
                                      key ∈ sz50|hs300|zz500|zz1000（桥内映射中文 symbol：
                                      上证50/沪深300/中证500/中证1000）。
  all_a_pe                            全A 市盈率（ak.stock_a_ttm_lyr，月末全史：middlePETTM/
                                      averagePETTM/middlePELYR/averagePELYR + 来源自带分位列）。
  all_a_pb                            全A 市净率（ak.stock_a_all_pb，月末全史：middlePB/
                                      equalWeightAveragePB + 来源自带分位列）。

实测运行事实（2026-10-25，W31 探测，证据 var/w31-probe-result.json，8/8 调用成功）：
- csindex indicator.xls：000300/000016 各 20 行（2026-09-28~2026-10-23），10 列原生中英混排表头；
  日期/代码/指标列以文本存储（探测期 pandas 类型推断为 int64/float64，xlrd 直读为 str——
  桥内 coerce_text 做确定性无损数值转换）；
- lg_pe/lg_pb：上证50 262 行（2005-01-31~2026-10-23，月末），中证1000 145 行（2014-10-31 起）；
- all_a_pe/all_a_pb：262 行（2005-01-31~2026-10-23，月末）。
频度口径：lg_* 与 all_a_* 为月末频率（非日频）；csindex_daily 为日频但仅近 20 交易日窗口。
"""
import hashlib
import json
import os
import sys

USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "VALUATION_QUERY_FAILED"
XLS_ERROR = "VALUATION_XLS_FAILED"

CSINDEX_URL_TMPL = (
    "https://oss-ch.csindex.com.cn/static/"
    "html/csindex/public/uploads/file/autofile/indicator/{code}indicator.xls"
)
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/114.0.0.0 Safari/537.36"
)

LG_KEYS = {"sz50": "上证50", "hs300": "沪深300", "zz500": "中证500", "zz1000": "中证1000"}


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
    if cmd == "csindex_daily":
        _require(1 <= len(args) <= 2 and args[0].isdigit() and len(args[0]) == 6
                 and (len(args) == 1 or args[1] == "--use-cache"),
                 "csindex_daily <6位指数代码> [--use-cache]")
        return cmd, args
    if cmd in ("lg_pe", "lg_pb"):
        _require(len(args) == 1 and args[0] in LG_KEYS, f"{cmd} <key>（key ∈ {'|'.join(LG_KEYS)}）")
        return cmd, args
    if cmd in ("all_a_pe", "all_a_pb"):
        _require(len(args) == 0, f"{cmd}（无参数）")
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


def yyyymmdd_to_iso(value):
    """csindex 日期整数（20261023）→ ISO 字符串（确定性算术转换，原始值原样保留）。"""
    s = str(int(value))
    return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"


def xls_cache_path(code):
    return f"/work/var/valuation-csindex-{code}indicator.xls"


def download_xls(code, use_cache):
    import urllib.request

    path = xls_cache_path(code)
    if use_cache and os.path.exists(path):
        with open(path, "rb") as fh:
            data = fh.read()
        return data, True
    req = urllib.request.Request(CSINDEX_URL_TMPL.format(code=code), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = resp.read()
    if len(data) < 256:
        raise BridgeError(XLS_ERROR, f"XLS 字节数异常：{len(data)}")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)
    return data, False


def coerce_text(v):
    """数值形态文本 → int/float（确定性无损转换；与 pandas read_excel 的类型推断一致——
    实测该 XLS 的日期/代码/指标列以文本存储，探测期 pandas 推断为 int64/float64）。"""
    s = str(v).strip()
    if s == "":
        return None
    try:
        return int(s)
    except ValueError:
        pass
    try:
        f = float(s)
        return None if f != f else f  # NaN 文本不出现，防御
    except ValueError:
        return str(v)


def cmd_csindex_daily(code, use_cache):
    import xlrd

    data, cached = download_xls(code, use_cache)
    book = xlrd.open_workbook(file_contents=data)
    sheet = book.sheet_by_index(0)
    if sheet.ncols != 10:
        raise BridgeError(XLS_ERROR, f"列数异常：{sheet.ncols}（预期 10）")
    header = [str(sheet.cell_value(0, c)) for c in range(sheet.ncols)]
    expected = [
        "日期Date", "指数代码Index Code", "指数中文全称Chinese Name(Full)", "指数中文简称Index Chinese Name",
        "指数英文全称English Name(Full)", "指数英文简称Index English Name",
        "市盈率1（总股本）P/E1", "市盈率2（计算用股本）P/E2",
        "股息率1（总股本）D/P1", "股息率2（计算用股本）D/P2",
    ]
    if header != expected:
        raise BridgeError(XLS_ERROR, f"表头异常：{header}")
    rows = []
    for r in range(1, sheet.nrows):
        row = {}
        for c in range(sheet.ncols):
            ct = sheet.cell_type(r, c)
            v = sheet.cell_value(r, c)
            if ct == xlrd.XL_CELL_NUMBER:
                # 数值单元格：日期/代码列取整，指标列保持 float
                row[header[c]] = int(v) if header[c].endswith(("Date", "Code")) else float(v)
            elif ct == xlrd.XL_CELL_TEXT:
                row[header[c]] = coerce_text(v)  # 数值形态文本 → int/float（见函数注）
            else:  # EMPTY/BLANK/其余 → None
                row[header[c]] = None
        date_int = row["日期Date"]
        if not (isinstance(date_int, int) and 19000101 <= date_int <= 29991231):
            raise BridgeError(XLS_ERROR, f"第 {r + 1} 行日期非 yyyymmdd 整数：{date_int!r}")
        row["日期ISO"] = yyyymmdd_to_iso(date_int)
        rows.append(row)
    meta = {
        "sourceUrl": CSINDEX_URL_TMPL.format(code=code),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "xlsCachePath": xls_cache_path(code),
        "cached": cached,
        "dataRows": len(rows),
        "windowNote": "官方 autofile 为近约 20 个交易日滚动窗口（W31 探测实测），非全史",
    }
    return {"ok": True, "rows": rows, "meta": meta}


def run(cmd, args):
    if cmd == "csindex_daily":
        return cmd_csindex_daily(args[0], use_cache="--use-cache" in args)
    import akshare as ak

    if cmd == "lg_pe":
        return {"ok": True, "rows": df_rows(ak.stock_index_pe_lg(symbol=LG_KEYS[args[0]]))}
    if cmd == "lg_pb":
        return {"ok": True, "rows": df_rows(ak.stock_index_pb_lg(symbol=LG_KEYS[args[0]]))}
    if cmd == "all_a_pe":
        return {"ok": True, "rows": df_rows(ak.stock_a_ttm_lyr())}
    if cmd == "all_a_pb":
        return {"ok": True, "rows": df_rows(ak.stock_a_all_pb())}
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def main(argv):
    # fd 级压制三方库输出（requests/urllib3/pandas 的 print/warning），stdout 只留一个 JSON 对象
    # （与 adapters/sw/bridge.py 同法：dup2 换 fd + 换 sys.stdout 对象）。
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
