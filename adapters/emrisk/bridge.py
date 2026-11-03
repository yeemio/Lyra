#!/usr/bin/env python3
"""Lyra · 东财风险面桥：股权质押比例 + 股东户数（P1 W29: code-writer）。

容器化运行（与 sw / baostock 桥同模式；akshare 1.19.3 在命名卷 lyra-akshare-py311）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/emrisk/bridge.py <cmd> <code>

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/{baostock,sw}/bridge.py 同合同）：
成功 {ok: true, rows: [...], meta}，失败 {ok: false, error_code, error, meta}；退出码 0/1。
只有来源成功且计数/分页证明完整时才可返回 rows=[]；错误原文和已收分页状态随 meta 保存。

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
  当前桥直接核验同一报告的成功信封与全部分页，并保留既有中文列映射；
  result=None、TypeError 和未完成的分页均为失败，不能解释为来源空集。

时点口径（映射层 src/adapters/emrisk.ts 冻结，桥只取数不改语义）：
- 质押：周度快照口径，快照日=TRADE_DATE；availableAt=快照日次日 00:00 Asia/Shanghai（保守）。
- 股东户数：公告披露口径，事件=统计截止日、披露=公告日期；availableAt=披露日次日 00:00（保守）。
"""
import json
import math
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
    def __init__(self, code, message, meta=None):
        super().__init__(message)
        self.code = code
        self.meta = meta


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


def fetch_report(code, resource, report, sort_column):
    """Only a successful, complete protocol response can establish an empty set.

    Keep every HTTP body (including a failing later page) in the receipt. A
    missing/changed count, page drift or duplicate page is an incomplete query,
    never a completed empty segment. No partially collected rows are published.
    """
    import requests

    base = {
        "sortColumns": sort_column,
        "sortTypes": "1",
        "pageSize": "500",
        "reportName": report,
        "columns": "ALL",
        "source": "WEB",
        "client": "WEB",
        "filter": f'(SECURITY_CODE="{code}")',
    }
    rows, receipts, seen = [], [], set()
    page, pages, count = 1, None, None

    def meta(complete=False):
        return {
            "protocol": "emrisk-pages-v1", "resource": resource, "code": code,
            "complete": complete, "emptySource": complete and count == 0,
            "expectedPages": pages, "expectedRows": count,
            "receivedRows": len(rows), "failedPage": None if complete else page,
            "httpCalls": len(receipts), "rawPages": receipts,
            "sourceUrl": EM_DATA_URL + "?" + urllib.parse.urlencode(dict(base, pageNumber="1")),
        }

    def fail(error_code, message):
        raise BridgeError(error_code, message, meta())

    while True:
        params = dict(base, pageNumber=str(page))
        try:
            resp = requests.get(EM_DATA_URL, params=params, timeout=60)
        except Exception as exc:
            receipts.append({"page": page, "error": f"{type(exc).__name__}: {exc}"})
            fail(QUERY_ERROR, f"HTTP 异常（第 {page} 页）：{exc}")
        receipts.append({"page": page, "status": resp.status_code, "body": resp.text})
        if resp.status_code != 200:
            fail(QUERY_ERROR, f"HTTP {resp.status_code}（第 {page} 页）")
        try:
            data = json.loads(resp.text)
        except Exception as exc:
            fail("EMRISK_RESPONSE_INVALID", f"JSON 解析失败（第 {page} 页）：{exc}")
        if not isinstance(data, dict) or data.get("success") is not True:
            fail("EMRISK_SOURCE_ERROR", f"来源未确认成功（第 {page} 页）")
        result = data.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("data"), list):
            fail("EMRISK_RESPONSE_INVALID", f"result/data 形状错误（第 {page} 页）")
        current_pages, current_count = result.get("pages"), result.get("count")
        if (type(current_pages) is not int or type(current_count) is not int
                or current_pages < 0 or current_pages > 10000 or current_count < 0):
            fail("EMRISK_PAGINATION_INVALID", f"pages/count 非法（第 {page} 页）")
        if page == 1:
            pages, count = current_pages, current_count
        elif (pages, count) != (current_pages, current_count):
            fail("EMRISK_PAGINATION_INVALID", f"分页总量发生变化（第 {page} 页）")
        page_rows = result["data"]
        if count == 0:
            if page != 1 or pages not in (0, 1) or page_rows:
                fail("EMRISK_PAGINATION_INVALID", "空集与分页计数不一致")
            break
        if pages != math.ceil(count / 500) or page > pages:
            fail("EMRISK_PAGINATION_INVALID", f"分页数量不一致（第 {page} 页）")
        if len(page_rows) != min(500, count - (page - 1) * 500):
            fail("EMRISK_PAGINATION_INVALID", f"分页行数不完整（第 {page} 页）")
        for row in page_rows:
            if not isinstance(row, dict) or row.get("SECURITY_CODE") != code:
                fail("EMRISK_RESPONSE_INVALID", f"行或主体错误（第 {page} 页）")
            fingerprint = json.dumps(row, sort_keys=True, ensure_ascii=False)
            if fingerprint in seen:
                fail("EMRISK_PAGINATION_INVALID", f"分页重复行（第 {page} 页）")
            seen.add(fingerprint)
        rows.extend(page_rows)
        if page == pages:
            break
        page += 1
    return {"ok": True, "rows": rows, "meta": meta(True)}


def cmd_pledge(code):
    result = fetch_report(code, "pledge_ratio", PLEDGE_REPORT, "TRADE_DATE")
    result["rows"] = [with_trade_date_iso(row) for row in result["rows"]]
    return result


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
    # Same report and field meanings as AKShare's detail API, with explicit
    # source-envelope verification instead of inferring emptiness from TypeError.
    fields = {
        "END_DATE": "股东户数统计截止日", "INTERVAL_CHRATE": "区间涨跌幅",
        "HOLDER_NUM": "股东户数-本次", "PRE_HOLDER_NUM": "股东户数-上次",
        "HOLDER_NUM_CHANGE": "股东户数-增减", "HOLDER_NUM_RATIO": "股东户数-增减比例",
        "AVG_MARKET_CAP": "户均持股市值", "AVG_HOLD_NUM": "户均持股数量",
        "TOTAL_MARKET_CAP": "总市值", "TOTAL_A_SHARES": "总股本",
        "CHANGE_SHARES": "股本变动", "CHANGE_REASON": "股本变动原因",
        "HOLD_NOTICE_DATE": "股东户数公告日期", "SECURITY_CODE": "代码",
        "SECURITY_NAME_ABBR": "名称",
    }
    text_fields = {"END_DATE", "HOLD_NOTICE_DATE", "SECURITY_CODE", "SECURITY_NAME_ABBR", "CHANGE_REASON"}
    result = fetch_report(code, "holder_count", "RPT_HOLDERNUM_DET", "END_DATE")
    rows = []
    for raw in result["rows"]:
        row = {}
        for source, target in fields.items():
            value = raw.get(source)
            if source not in text_fields:
                try:
                    value = float(value)
                    if not math.isfinite(value):
                        value = None
                except (TypeError, ValueError):
                    value = None
            row[target] = value
        rows.append(normalize_gdhs_dates(row))
    result["rows"] = rows
    return result


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
        payload = {"ok": False, "error_code": exc.code, "error": str(exc), "meta": exc.meta}
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
