#!/usr/bin/env python3
"""Lyra · 东财风险面桥：股权质押比例 + 股东户数（P1 W29: code-writer）。

容器化运行（与 sw / baostock 桥同模式；akshare 1.19.3 在命名卷 lyra-akshare-py311）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/emrisk/bridge.py <cmd> <code>

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/{baostock,sw}/bridge.py 同合同）：
成功 {ok: true, rows: [...], meta}，失败 {ok: false, error_code, error}；退出码 0/1。
rows 字段原样保留来源字段名（DATA-SOURCES §6.2）；空集如实返回 rows=[]（不报错、不造数）。

选型（W29 2026-10-25 容器内实测，证据 /tmp/lyra-w29/probe*.json 探测输出与
src/adapters/emrisk.ts 文件头"来源与选型"节）：
- 质押子命令 pledge：派发候选 akshare.stock_gpzy_pledge_ratio_em 是"按周快照日"全市场接口
  （每日期一次调用返回全 A 股 2294+ 行、内部 5 页分页）——26 股 × 全历史周度（2014 起 ≈600 周）
  按日调用法调用量与原件库规模均不可行。实测其底层 report RPT_CSDC_LIST 支持任意列过滤，
  改用同源同报告按个股过滤：datacenter-web.eastmoney.com/api/data/v1/get，
  reportName=RPT_CSDC_LIST、filter=(SECURITY_CODE="<code>")、columns=ALL、按 TRADE_DATE 升序
  分页（pageSize=500）——一次调用拿该股全历史周度快照（600519 实测 608 行，2014-03-07 起）。
  列为东财原生字段名（SECURITY_CODE/TRADE_DATE/PLEDGE_RATIO/PLEDGE_DEAL_NUM/PLEDGE_MARKET_CAP/
  REPURCHASE_BALANCE/…），另附 TRADE_DATE_ISO（YYYY-MM-DD，确定性前缀转换）。
- 股东户数子命令 gdhs：派发候选实测通过——akshare.stock_zh_a_gdhs_detail_em(symbol=<code>)
  （东财数据中心 RPT_HOLDERNUM_DET 按个股过滤，一次调用全历史；600519 实测 63 行，
  2013-03-22 → 2026-06-30；列含统计截止日与公告披露日两个时点字段）。
  该 akshare 包装在来源空集时因 result=None 崩溃（TypeError）——此处捕获该形态按空集返回
  （真查询失败仍按 QUERY_ERROR 上报）。

时点口径（映射层 src/adapters/emrisk.ts 冻结，桥只取数不改语义）：
- 质押：周度快照口径，快照日=TRADE_DATE；availableAt=快照日次日 00:00 Asia/Shanghai（保守）。
- 股东户数：公告披露口径，事件=统计截止日、披露=公告日期；availableAt=披露日次日 00:00（保守）。
"""
import json
import os
import re
import sys
import urllib.parse

EM_DATA_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
PLEDGE_REPORT = "RPT_CSDC_LIST"

USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "EMRISK_QUERY_FAILED"
CODE_PATTERN = re.compile(r"^\d{6}$")
DATE_PREFIX_PATTERN = re.compile(r"^(\d{4}-\d{2}-\d{2})")


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require(cond, message):
    if not cond:
        raise BridgeError(USAGE_ERROR, message)


def parse_args(argv):
    _require(len(argv) == 2, "缺子命令或代码；用法：pledge <code> / gdhs <code>（6 位裸码）")
    cmd, code = argv
    _require(cmd in ("pledge", "gdhs"), f"未知子命令：{cmd}")
    _require(CODE_PATTERN.match(code) is not None, f"代码须为 6 位裸码：{code}")
    return cmd, code


def jsonable(value):
    """JSON 反序列化产物直接可输出；datetime 等兜底转字符串。"""
    import datetime as _dt

    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, float) and value != value:  # NaN
        return None
    return value


def with_trade_date_iso(row):
    """附 TRADE_DATE_ISO（YYYY-MM-DD 前缀，确定性转换；原文 TRADE_DATE 原样保留）。"""
    out = jsonable(dict(row))
    raw = out.get("TRADE_DATE")
    if isinstance(raw, str):
        m = DATE_PREFIX_PATTERN.match(raw)
        if m is not None:
            out["TRADE_DATE_ISO"] = m.group(1)
    return out


def cmd_pledge(code):
    import requests

    base = {
        "sortColumns": "TRADE_DATE",
        "sortTypes": "1",
        "pageSize": "500",
        "reportName": PLEDGE_REPORT,
        "columns": "ALL",
        "source": "WEB",
        "client": "WEB",
        "filter": f'(SECURITY_CODE="{code}")',
    }
    rows = []
    page = 1
    pages = None
    http_calls = 0
    while True:
        params = dict(base, pageNumber=str(page))
        try:
            resp = requests.get(EM_DATA_URL, params=params, timeout=60)
        except Exception as exc:
            raise BridgeError(QUERY_ERROR, f"HTTP 异常：{type(exc).__name__}: {exc}") from exc
        http_calls += 1
        if resp.status_code != 200:
            raise BridgeError(QUERY_ERROR, f"HTTP {resp.status_code}（第 {page} 页）")
        try:
            data = resp.json()
        except Exception as exc:
            raise BridgeError(QUERY_ERROR, f"JSON 解析失败（第 {page} 页）：{exc}") from exc
        result = data.get("result")
        if result is None:
            # 来源空集（该股在 RPT_CSDC_LIST 无快照行）：如实空集返回（success/message 进 meta）。
            return {
                "ok": True,
                "rows": [],
                "meta": {
                    "resource": "pledge_ratio",
                    "code": code,
                    "emptySource": True,
                    "sourceMessage": data.get("message"),
                    "httpCalls": http_calls,
                },
            }
        page_rows = result.get("data") or []
        rows.extend(with_trade_date_iso(r) for r in page_rows)
        pages = result.get("pages")
        if not isinstance(pages, int) or pages < 1 or page >= pages:
            break
        page += 1
    return {
        "ok": True,
        "rows": rows,
        "meta": {
            "resource": "pledge_ratio",
            "code": code,
            "rows": len(rows),
            "pages": pages,
            "httpCalls": http_calls,
            "sourceUrl": EM_DATA_URL + "?" + urllib.parse.urlencode(dict(base, pageNumber="1")),
        },
    }


GDHS_DATE_FIELDS = ("股东户数统计截止日", "股东户数公告日期")


def normalize_gdhs_dates(row):
    """户数行两个时点字段归一为 YYYY-MM-DD（akshare .dt.date 产物在 pandas to_dict 时可能被
    框回带 00:00:00 时刻的 Timestamp；取日期前缀，确定性转换，无前缀匹配则原样保留）。"""
    out = dict(row)
    for field in GDHS_DATE_FIELDS:
        v = out.get(field)
        if isinstance(v, str):
            m = DATE_PREFIX_PATTERN.match(v)
            if m is not None:
                out[field] = m.group(1)
    return out


def cmd_gdhs(code):
    # 空集形态（akshare 对 result=None 下标崩溃）在包装内先探一次空集再调正式接口不可行
    # （多一次真实请求）；改为捕获该 TypeError 形态按空集返回，其余异常照常上报。
    try:
        import akshare as ak

        df = ak.stock_zh_a_gdhs_detail_em(symbol=code)
    except TypeError as exc:
        if "NoneType" in str(exc):
            return {
                "ok": True,
                "rows": [],
                "meta": {
                    "resource": "holder_count",
                    "code": code,
                    "emptySource": True,
                    "note": "akshare 对空结果集崩溃，按空集如实返回",
                },
            }
        raise BridgeError(QUERY_ERROR, f"akshare TypeError：{exc}") from exc
    except Exception as exc:
        raise BridgeError(QUERY_ERROR, f"{type(exc).__name__}: {exc}") from exc
    rows = [normalize_gdhs_dates(jsonable(dict(rec))) for rec in df.to_dict(orient="records")]
    return {
        "ok": True,
        "rows": rows,
        "meta": {"resource": "holder_count", "code": code, "rows": len(rows)},
    }


def run(cmd, code):
    if cmd == "pledge":
        return cmd_pledge(code)
    return cmd_gdhs(code)


def main(argv):
    # fd 级压制三方库输出（akshare tqdm 走 stderr，requests/pandas 可能 print 到 stdout），
    # stdout 只留一个 JSON 对象（与 baostock/sw 桥同法）。
    saved_obj = sys.stdout
    sys.stdout.flush()
    saved_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, 1)
    sys.stdout = os.fdopen(os.dup(devnull_fd), "w")
    payload = {"ok": False}
    try:
        cmd, code = parse_args(argv)
        payload = run(cmd, code)
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
