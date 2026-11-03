#!/usr/bin/env python3
"""Lyra · 东财基金面桥：场内基金（ETF）规模变动（季度份额序列）（P1 W30: code-writer）。

容器化运行（与 sw / emrisk / emdc 桥同模式；akshare 1.19.3 在命名卷 lyra-akshare-py311，
本桥只用其卷内 requests，不调 akshare 包装函数）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/emfund/bridge.py fund_share <code>

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/{baostock,sw,emrisk}/bridge.py
同合同）：成功 {ok: true, rows: [...], meta}，失败 {ok: false, error_code, error}；退出码 0/1。

选型（W30 2026-10-26 容器内实测，探测证据 /tmp/lyra-w30/probe-etf.json，另见
src/adapters/emfund.ts 文件头"来源与选型"节）：
- 派发候选 akshare.fund_etf_fund_info_em 实测为天天基金**历史净值表**（api.fund.eastmoney.com
  f10/lsjz，列＝净值日期/单位净值/累计净值/日增长率/申购状态/赎回状态——包源码核对，无份额列，
  不必烧请求实测即排除）；
- akshare.fund_etf_scale_sse（上交所 ETF 份额按日期全市场快照）实测可用（2025-09-30 一次返回
  全所 736 行、池内 4 ETF 全命中），但**按日期一次调用**：2015..2026 全历史 ≈2,800 次调用，量不可行，
  保留为交叉校验参照（2025-09-30 510050 基金份额 57,723,966,800 份已入探测证据）；
- 选定：东财天天基金 F10 规模变动接口 FundArchivesDatas.aspx?type=gmbd&mode=0&code=<code>
  （Owner 渠道指令"东财优先"命中），**按基金一次调用拿全历史季频序列**（510050 实测 53KB、
  自 2005-02 成立起 ~85 个季度行；512100 实测 24KB 自上市季度起）。列为来源原生中文字段名：
  日期 / 期间申购（亿份）/ 期间赎回（亿份）/ 期末总份额（亿份）/ 期末净资产（亿元）/ 净资产变动率，
  值原样保留（字符串，亿份两位小数为来源公布精度）。

时点口径（映射层 src/adapters/emfund.ts 冻结，桥只取数不改语义）：
- ETF_SHARE：季报口径——事件=季度末日（期末份额状态成立时点）；F10 序列无逐行披露日，
  availableAt 取法定披露期限统一保守上界（季度末+92 天 00:00 Asia/Shanghai，覆盖年报 3 个月、
  半年报 2 个月、季报 15 个工作日的全部法定期限，不编造披露日）；sourcePublishedAt=null。
"""
import html
import json
import os
import re
import sys
import time
import urllib.parse

F10_URL = "https://fundf10.eastmoney.com/FundArchivesDatas.aspx"

USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "EMFUND_QUERY_FAILED"
CODE_PATTERN = re.compile(r"^\d{6}$")
CONTENT_PATTERN = re.compile(r'content\s*:\s*"([^"]*)"')
TH_PATTERN = re.compile(r"<th(?:\s[^>]*)?>(.*?)</th>", re.S)  # (?:\s…)? 防 <thead> 误配为 <th> 开标签
TR_PATTERN = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
TD_PATTERN = re.compile(r"<td[^>]*>(.*?)</td>", re.S)


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require(cond, message):
    if not cond:
        raise BridgeError(USAGE_ERROR, message)


def parse_args(argv):
    _require(len(argv) == 2, "缺子命令或代码；用法：fund_share <code>（6 位裸码）")
    cmd, code = argv
    _require(cmd == "fund_share", f"未知子命令：{cmd}")
    _require(CODE_PATTERN.match(code) is not None, f"代码须为 6 位裸码：{code}")
    return cmd, code


def parse_table(table_html):
    """单张 gmbd 表 → 行 dict 列表（列名＝表头原文，值＝单元格文本原样字符串）。"""
    headers = [html.unescape(h.strip()) for h in TH_PATTERN.findall(table_html)]
    if not headers:
        return []
    rows = []
    for tr in TR_PATTERN.findall(table_html):
        cells = [html.unescape(td.strip()) for td in TD_PATTERN.findall(tr)]
        if not cells:
            continue
        row = {headers[i]: cells[i] for i in range(min(len(headers), len(cells)))}
        rows.append(row)
    return rows


def cmd_fund_share(code):
    import requests

    params = {"type": "gmbd", "mode": "0", "code": code, "rt": str(round(time.time() * 1000))}
    headers = {
        "Referer": f"https://fundf10.eastmoney.com/gmbd_{code}.html",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    }
    try:
        resp = requests.get(F10_URL, params=params, headers=headers, timeout=60)
    except Exception as exc:
        raise BridgeError(QUERY_ERROR, f"HTTP 异常：{type(exc).__name__}: {exc}") from exc
    if resp.status_code != 200:
        raise BridgeError(QUERY_ERROR, f"HTTP {resp.status_code}")
    tables = [html.unescape(m) for m in CONTENT_PATTERN.findall(resp.text)]
    rows = []
    for table in tables:
        rows.extend(parse_table(table))
    meta = {
        "resource": "etf_share",
        "code": code,
        "rows": len(rows),
        "tables": len(tables),
        "sourceUrl": F10_URL + "?" + urllib.parse.urlencode({k: v for k, v in params.items() if k != "rt"}),
    }
    if not rows:
        meta["emptySource"] = True  # 来源无该基金序列：如实空集返回（不报错、不造数）
    return {"ok": True, "rows": rows, "meta": meta}


def main(argv):
    # fd 级压制三方库输出（requests/urllib3 可能 print 到 stdout），stdout 只留一个 JSON 对象
    # （与 baostock/sw/emrisk 桥同法）。
    saved_obj = sys.stdout
    sys.stdout.flush()
    saved_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, 1)
    sys.stdout = os.fdopen(os.dup(devnull_fd), "w")
    payload = {"ok": False}
    try:
        cmd, code = parse_args(argv)
        payload = cmd_fund_share(code)
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
