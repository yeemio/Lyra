#!/usr/bin/env python3
"""Lyra · BaoStock 桥（P1 W4: code-writer-pro）。

单文件多子命令 CLI，供 src/adapters/baostock.ts 经 venv Python（.venv-p1，baostock 0.9.40）
execFile 调用。每调用一次 login → 查询 → logout；stdout 只输出一个 JSON 对象：
成功 {ok: true, rows: [...]}，失败 {ok: false, error_code, error}；退出码 0/1。
rows 内字段原样保留 BaoStock 字段名（DATA-SOURCES §6.2 来源原生字段不改写）；
桥自加上下文字段（不改写 BaoStock 字段）：financial 行附 bsQuery（'profit'/'growth'，
区分 query_profit_data / query_growth_data），hs300/zz500 行附 bsIndex，stock_pool
行附 bsDay（行本身不含查询日）。

子命令与参数（日期一律 YYYY-MM-DD 或 YYYYMMDD，透传 BaoStock）：
  kline          <code> <start> <end>   日线（不复权 adjustflag='3'）
  adjust_factor  <code> <start> <end>   复权因子
  financial      <code> [year] [quarter]  季频财务（profit + growth）
  trade_dates    <start> <end>          交易日历
  stock_pool     <day>                  按日全部上市股票（query_all_stock）
  hs300          <date>                 沪深300 按日成分
  zz500          <date>                 中证500 按日成分
  stock_basic    <code>                 单只股票基本资料（query_stock_basic，当前快照）
  sw_industry                           全部股票申万行业分类（query_stock_industry，当前快照）

baostock 的 login/logout/查询会向 stdout 打印自身日志，会污染 JSON——本桥在 fd 级
把 stdout 重定向到 /dev/null 完成全部 baostock 交互，再恢复 fd 输出 JSON。
"""
import json
import os
import sys

import baostock as bs

KLINE_FIELDS = (
    "date,code,open,high,low,close,preclose,volume,amount,"
    "adjustflag,turn,tradestatus,pctChg,isST"
)

USAGE_ERROR = "USAGE_ERROR"
LOGIN_ERROR = "BAOSTOCK_LOGIN_FAILED"
QUERY_ERROR = "BAOSTOCK_QUERY_FAILED"


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require(cond, message):
    if not cond:
        raise BridgeError(USAGE_ERROR, message)


def parse_args(argv):
    _require(len(argv) >= 1, "缺子命令；用法见文件头注释")
    cmd = argv[0]
    args = argv[1:]
    if cmd == "kline":
        _require(len(args) == 3, "kline <code> <start> <end>")
        return cmd, args
    if cmd == "adjust_factor":
        _require(len(args) == 3, "adjust_factor <code> <start> <end>")
        return cmd, args
    if cmd == "financial":
        _require(len(args) in (1, 3), "financial <code> [year] [quarter]（year/quarter 同给或同缺）")
        if len(args) == 3:
            try:
                int(args[1]), int(args[2])
            except ValueError:
                raise BridgeError(USAGE_ERROR, "year/quarter 须为整数") from None
        return cmd, args
    if cmd == "trade_dates":
        _require(len(args) == 2, "trade_dates <start> <end>")
        return cmd, args
    if cmd == "stock_pool":
        _require(len(args) == 1, "stock_pool <day>")
        return cmd, args
    if cmd in ("hs300", "zz500"):
        _require(len(args) == 1, f"{cmd} <date>")
        return cmd, args
    if cmd == "stock_basic":
        _require(len(args) == 1, "stock_basic <code>")
        return cmd, args
    if cmd == "sw_industry":
        _require(len(args) == 0, "sw_industry（全量，无参数）")
        return cmd, args
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def collect(rs):
    """把 ResultData 全部行收为 dict 列表；查询失败抛具名错误。"""
    if rs.error_code != "0":
        raise BridgeError(QUERY_ERROR, f"{rs.error_code} {rs.error_msg}")
    rows = []
    while rs.next():
        rows.append(dict(zip(rs.fields, rs.get_row_data())))
    return rows


def run_query(cmd, args):
    """已登录状态下执行子命令，返回 rows。"""
    if cmd == "kline":
        code, start, end = args
        return collect(bs.query_history_k_data_plus(
            code, KLINE_FIELDS, start_date=start, end_date=end, frequency="d", adjustflag="3"))
    if cmd == "adjust_factor":
        code, start, end = args
        return collect(bs.query_adjust_factor(code, start_date=start, end_date=end))
    if cmd == "financial":
        code = args[0]
        year = int(args[1]) if len(args) == 3 else None
        quarter = int(args[2]) if len(args) == 3 else None
        rows = []
        for fn, tag in ((bs.query_profit_data, "profit"), (bs.query_growth_data, "growth")):
            for row in collect(fn(code, year, quarter)):
                row["bsQuery"] = tag  # 桥自加：区分两次查询；BaoStock 字段原样
                rows.append(row)
        return rows
    if cmd == "trade_dates":
        return collect(bs.query_trade_dates(start_date=args[0], end_date=args[1]))
    if cmd == "stock_pool":
        rows = collect(bs.query_all_stock(day=args[0]))
        for row in rows:
            row["bsDay"] = args[0]  # 桥自加：行本身不含查询日，补上下文便于按日检索
        return rows
    if cmd in ("hs300", "zz500"):
        fn = bs.query_hs300_stocks if cmd == "hs300" else bs.query_zz500_stocks
        rows = collect(fn(date=args[0]))
        for row in rows:
            row["bsIndex"] = cmd  # 桥自加：成分行标识所属指数（hs300/zz500）
        return rows
    if cmd == "stock_basic":
        return collect(bs.query_stock_basic(code=args[0]))
    if cmd == "sw_industry":
        return collect(bs.query_stock_industry())
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def main(argv):
    # 压制 baostock 自身输出，stdout 只留一个 JSON 对象。管道下 Python stdout 为块缓冲：
    # 仅 dup2 换 fd 不够（print 的字节留在缓冲，退出时仍 flush 回真实管道），须同时把
    # sys.stdout 对象换成指向 devnull 的流（baostock 全部经 print 输出，动态查找 sys.stdout）。
    saved_obj = sys.stdout
    sys.stdout.flush()
    saved_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, 1)
    sys.stdout = os.fdopen(os.dup(devnull_fd), "w")
    payload = {"ok": False}
    logged_in = False
    try:
        cmd, args = parse_args(argv)
        login_rs = bs.login()
        if login_rs.error_code != "0":
            raise BridgeError(LOGIN_ERROR, f"{login_rs.error_code} {login_rs.error_msg}")
        logged_in = True
        rows = run_query(cmd, args)
        payload = {"ok": True, "rows": rows}
    except BridgeError as exc:
        payload = {"ok": False, "error_code": exc.code, "error": str(exc)}
    except Exception as exc:  # 网络/协议等未预期异常按瞬态查询失败上报
        payload = {"ok": False, "error_code": QUERY_ERROR, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        if logged_in:
            try:
                bs.logout()
            except Exception:
                pass
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
