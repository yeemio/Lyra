#!/usr/bin/env python3
"""Lyra · 东财机构持仓面桥：基金重仓（按报告期全市场快照，池股过滤）（P1 W39: code-writer）。

容器化运行（与 emfund / emrisk 桥同模式；akshare 1.19.3 在命名卷 lyra-akshare-py311，
本桥只用其卷内 requests，不调 akshare 包装函数）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/eminstitution/bridge.py \
    fund_hold 20260930 601318,000938,...

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/emfund/bridge.py 同合同）：
成功 {ok: true, rows: [...], meta}，失败 {ok: false, error_code, error}；退出码 0/1。

选型（W39 2026-10-25 容器内实测，探测证据 /tmp/w39-probe-call.txt 与 /tmp/w39-north-diag.txt，
另见 src/adapters/eminstitution.ts 文件头"来源与选型"节）：
- 基金重仓面：东财数据中心主力数据接口 data.eastmoney.com/dataapi/zlsj/list
  （date=<报告期>，type=1=基金持仓；akshare.stock_report_fund_hold 同端点，其分页
  pageSize=500 逐页拉全后 pandas 改列名——本桥直接复刻原始端点、不经 pandas，行保留
  原始 JSON 字段名与原生值类型，规避 W37 登记的 pandas jsonable 整型转字符串缺陷类）；
  桥按报告期一次调用（内部逐页），2024-12-31 实测 11 页 5,225 行、2026-09-30 实测 4 页；
- 池过滤：桥内按 SECURITY_CODE ∈ 池码表过滤（量级纪律：回填只入 26 池股事实；
  meta.fullRows=过滤前行数如实申报，池外行不落盘不落库）；
- 北向个股面：东财 RPT_MUTUAL_HOLDSTOCKNDATE_STA 实测存活但序列止于 2024-08-16
  （披露机制调整后停发，count=1698 全部在停发前；601318 降序首行 TRADE_DATE=2024-08-16）——
  近 2 年窗口完全在停发之后，该面不可得，见 W39 回传与 TS 文件头声明，桥不实现。

时点口径（映射层 src/adapters/eminstitution.ts 冻结，桥只取数不改语义）：
- FUND_HOLD：季报口径——事件=报告期季度末（持仓状态成立时点）；来源快照无逐行披露日
  （REPORT_DATE 为报告期非披露日），availableAt 取法定披露期限统一保守上界
  （季度末+92 天 00:00 Asia/Shanghai，同 emfund ETF_SHARE 先例）；sourcePublishedAt=null。
"""
import json
import os
import re
import sys

ZLSJ_URL = "http://data.eastmoney.com/dataapi/zlsj/list"

USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "EMINSTITUTION_QUERY_FAILED"
CODE_PATTERN = re.compile(r"^\d{6}$")
DATE_PATTERN = re.compile(r"^\d{8}$")
PAGE_SIZE = 500          # akshare 同款分页大小（2024-12-31 实测 11 页）
MAX_PAGES = 200          # 分页护栏：异常放大时快速失败而非无限翻页
TIMEOUT_SECONDS = 15     # akshare _FUND_HOLD_TIMEOUT 同值


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require(cond, message):
    if not cond:
        raise BridgeError(USAGE_ERROR, message)


def parse_args(argv):
    _require(len(argv) == 3, "缺参数；用法：fund_hold <date YYYYMMDD> <codes 逗号分隔 6 位裸码>")
    cmd, date, codes_arg = argv
    _require(cmd == "fund_hold", f"未知子命令：{cmd}")
    _require(DATE_PATTERN.match(date) is not None, f"日期须为 YYYYMMDD：{date}")
    codes = []
    for piece in codes_arg.split(","):
        code = piece.strip()
        _require(CODE_PATTERN.match(code) is not None, f"代码须为 6 位裸码：{piece}")
        codes.append(code)
    _require(len(codes) > 0, "池码表不得为空")
    _require(len(codes) == len(set(codes)), "池码表存在重复")
    return cmd, date, codes


def fetch_fund_hold(date_yyyymmdd, codes):
    import requests

    date_iso = f"{date_yyyymmdd[:4]}-{date_yyyymmdd[4:6]}-{date_yyyymmdd[6:]}"
    wanted = set(codes)
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Referer": f"http://data.eastmoney.com/zlsj/{date_iso}-1-2.html",
    }

    def get_page(page):
        params = {
            "date": date_iso,
            "type": "1",  # 1=基金持仓（东财 zlsj 机构类型固定；QFII/社保等不在本面范围）
            "zjc": "0",
            "sortField": "HOULD_NUM",
            "sortDirec": "1",
            "pageNum": str(page),
            "pageSize": str(PAGE_SIZE),
            "p": str(page),
            "pageNo": str(page),
        }
        try:
            resp = requests.get(ZLSJ_URL, params=params, headers=headers, timeout=TIMEOUT_SECONDS)
        except Exception as exc:
            raise BridgeError(QUERY_ERROR, f"HTTP 异常：{type(exc).__name__}: {exc}") from exc
        if resp.status_code != 200:
            raise BridgeError(QUERY_ERROR, f"HTTP {resp.status_code}（第 {page} 页）")
        try:
            body = resp.json()
        except Exception as exc:
            raise BridgeError(QUERY_ERROR, f"响应非 JSON：{type(exc).__name__}: {exc}") from exc
        return body

    body = get_page(1)
    pages = body.get("pages")
    _require(isinstance(pages, int) and pages >= 0, f"pages 字段异常：{pages!r}")
    _require(pages <= MAX_PAGES, f"分页超护栏：pages={pages} > {MAX_PAGES}")

    rows = []
    full_rows = 0
    data = body.get("data")
    if isinstance(data, list):
        for row in data:
            full_rows += 1
            code = str(row.get("SECURITY_CODE", "")).strip().zfill(6)
            if code in wanted:
                rows.append(row)
    for page in range(2, pages + 1):
        body = get_page(page)
        data = body.get("data")
        if not isinstance(data, list):
            if page != pages:  # 末页允许空 data；中间页缺 data 视为瞬态源异常
                raise BridgeError(QUERY_ERROR, f"第 {page} 页缺 data 字段")
            break
        for row in data:
            full_rows += 1
            code = str(row.get("SECURITY_CODE", "")).strip().zfill(6)
            if code in wanted:
                rows.append(row)

    meta = {
        "resource": "fund_hold",
        "date": date_iso,
        "codes": codes,
        "rows": len(rows),
        "fullRows": full_rows,
        "pages": pages,
        "sourceUrl": ZLSJ_URL,
    }
    if not rows:
        meta["emptySource"] = True  # 该报告期池内无基金持仓记录：如实空集（不报错、不造数）
    return {"ok": True, "rows": rows, "meta": meta}


def main(argv):
    # fd 级压制三方库输出（requests/urllib3 可能 print 到 stdout），stdout 只留一个 JSON 对象
    # （与 emfund/baostock/sw 桥同法）。
    saved_obj = sys.stdout
    sys.stdout.flush()
    saved_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, 1)
    sys.stdout = os.fdopen(os.dup(devnull_fd), "w")
    payload = {"ok": False}
    try:
        cmd, date, codes = parse_args(argv)
        payload = fetch_fund_hold(date, codes)
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
