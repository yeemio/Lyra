#!/usr/bin/env python3
"""Lyra · 东财机构调研记录桥：个股调研明细近窗（P2 W41b: code-writer，C2/D5-D7）。

容器化运行（与 emfund / eminstitution / embalance 桥同模式；akshare 1.19.3 在命名卷
lyra-akshare-py311，本桥只用其卷内 requests，不调 akshare 包装函数）：
  docker run --rm \
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \
    -v <repo>:/work python:3.11-slim python /work/adapters/emsurvey/bridge.py \
    survey <code 6位裸码> <sinceExclusive YYYYMMDD>

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/embalance/bridge.py 同合同）：
成功 {ok: true, rows: [...], meta}，失败 {ok: false, error_code, error}；退出码 0/1。

选型（W41b 2026-10-26 容器内实测十轮鉴别，证据 /tmp/w41b/probe1..10-out.txt；另见
src/adapters/emsurvey.ts 文件头"来源与选型"节）：
- akshare 1.19.3 调研一族仅两函数：stock_jgdy_detail_em（RPT_ORG_SURVEY 逐条调研明细，
  按起始日全市场分页）与 stock_jgdy_tj_em（RPT_ORG_SURVEYNEW 按股统计聚合）。
  近 2 年按日全市场形态实测 total=632,672 行（12,654 页）调用过重 → 选按个股过滤形态。
- 最终形态（probe9..12 实证）：datacenter-web /api/data/v1/get + reportName=
  RPT_ORG_SURVEY + columns=ALL + filter (SECURITY_CODE="<code>")(IS_SOURCE="1")
  (RECEIVE_START_DATE 起止双向窗)——三 term 组合可用（603986 近 2 年实测 664 行、
  002384 实测 115 行）；起止双向日期算子 >=/<= 沿用 emdc 桥 LHB 区间过滤生产先例。
  完整性机制（probe11/12）：pageSize>50 一律 9701 拒绝（50 为实际上限）；源侧存在
  同键重复行（同 NOTICE_DATE×ORG_CODE 多版本行），任何排序键都不唯一 → 整窗分页
  存在页间漂移（probe 实测单列排序实取 618 < 总数 664；加 ORG_CODE tiebreaker 后
  一次会话 664/664，但跨会话仍不稳）——故桥内按**月度双向子窗分块**取数（块通常
  单页，与排序稳定性彻底解耦），逐块 fetched-vs-total 自校验，不齐重试一次，残余
  不齐如实计入 meta.gapTotal（不静默、不造数）。
  诊断弯路如实记录：①自定义 headers（Chrome UA+Referer）与急促连发触发 code=9701
  '服务器繁忙'（探测五连 0 数据）——默认 UA 裸请求（akshare 同款、无 ut、页间 sleep 1s）
  是硬前提；②601318/600519 两样本在近 2 年窗口为**合法空集**（601318 全历史止于
  2023-10-27，600519 全程无记录），早期"三 term 组合必 9201"的误判由这两只零覆盖样本
  造成，probe9 在 603986（超重数据集）上以 code+IS_SOURCE 成功证伪；③code-only 过滤
  对超重数据集（603986 全历史 6,049+ 行）会 9701（后端查询过载），加 IS_SOURCE="1"
  收窄即解（IS_SOURCE="1" 同时与映射层时点口径自洽：只收有披露来源的记录行）。
- 行=一次调研活动 × 一家接待机构（columns=ALL 含 ORG_NAME/ORG_CODE/ORG_TYPE/
  ORG_TYPE_CODE/IS_QFII/NUMBERNEW/CONTENT 等完整明细字段，比 akshare 11 列清单更全，
  D5/D7 关注度的机构构成可用）；NOTICE_DATE=纪要披露日；RECEIVE_START_DATE=接待日。
- 9201 '返回数据为空' 在该过滤组合下为该股近窗空集语义（首页 9201 如实空集返回，
  不报错、不造数）；页 >1 的 9201 仍归瞬态（TS 侧退避）。

前视防泄漏（本桥强制，TS/单测背书）：
- 请求不带 quoteColumns/quoteType（akshare 原版带此参数拉 CLOSE_PRICE/CHANGE_RATE——
  那是抓取时点的**当前**行情，随行入库会把今天的价格塞进历史调研事实）；
- 响应行防御性剔除 CLOSE_PRICE / CHANGE_RATE 两键（即便来源侧变化返回也绝不入档）。

时点口径（映射层 src/adapters/emsurvey.ts 冻结，桥只取数不改语义）：
- SURVEY_RECORD：逐行 NOTICE_DATE（纪要披露日）——availableAt=NOTICE_DATE 次日
  00:00 Asia/Shanghai（披露日精度保守 D+1，embalance 先例）；sourcePublishedAt=
  NOTICE_DATE 00:00+08；eventAt=validFrom=RECEIVE_START_DATE 00:00+08（调研活动
  发生时点）。无 NOTICE_DATE 行由映射器具名拒绝、不落库、不编造。
- 桥自加确定性前缀转换字段 RECEIVE_START_DATE_ISO / NOTICE_DATE_ISO（YYYY-MM-DD，
  emrisk/embalance 桥同法；原文列原样保留）。
"""
import datetime as _dt
import json
import os
import re
import sys
import time

API_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"

USAGE_ERROR = "USAGE_ERROR"
QUERY_ERROR = "EMSURVEY_QUERY_FAILED"
CODE_PATTERN = re.compile(r"^\d{6}$")
DATE_PATTERN = re.compile(r"^\d{8}$")
ISO_PREFIX_PATTERN = re.compile(r"^(\d{4}-\d{2}-\d{2})")
ISO_FIELDS = ("RECEIVE_START_DATE", "NOTICE_DATE")
PAGE_SIZE = 50           # 东财个股调研页同款分页大小（社区抓包一致）
MAX_PAGES = 200          # 分页护栏：单股近窗行数异常放大时快速失败而非无限翻页
PAGE_SLEEP_SECONDS = 1.0 # 页间退避（datacenter-web 急促连发触发 9701 的实测教训）
# 行情快照列防泄漏黑名单（不请求 + 防御性剔除；见文件头"前视防泄漏"节）
QUOTE_COLUMNS_BLACKLIST = ("CLOSE_PRICE", "CHANGE_RATE")


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require(cond, message):
    if not cond:
        raise BridgeError(USAGE_ERROR, message)


def parse_args(argv):
    _require(len(argv) == 3, "缺参数；用法：survey <code 6位裸码> <sinceExclusive YYYYMMDD>")
    cmd, code, since = argv
    _require(cmd == "survey", f"未知子命令：{cmd}")
    _require(CODE_PATTERN.match(code) is not None, f"代码须为 6 位裸码：{code}")
    _require(DATE_PATTERN.match(since) is not None, f"窗界须为 YYYYMMDD：{since}")
    return cmd, code, since


def jsonable(value):
    """JSON 反序列化产物直接可输出；datetime 等兜底转字符串；NaN → null。"""
    if isinstance(value, (_dt.datetime, _dt.date)):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    if isinstance(value, float) and value != value:  # NaN
        return None
    return value


def sanitize_row(row):
    """前视防泄漏：剔除行情快照列（不请求，防来源侧变化返回）；附 *_ISO 前缀转换列。"""
    for key in QUOTE_COLUMNS_BLACKLIST:
        row.pop(key, None)
    for field in ISO_FIELDS:
        raw = row.get(field)
        if isinstance(raw, str):
            m = ISO_PREFIX_PATTERN.match(raw)
            if m is not None:
                row[f"{field}_ISO"] = m.group(1)
    return row


def fetch_survey(code, since_yyyymmdd):
    import requests  # 卷内 requests（与 eminstitution 桥同法，不调 akshare 包装函数）

    since_iso = f"{since_yyyymmdd[:4]}-{since_yyyymmdd[4:6]}-{since_yyyymmdd[6:]}"
    # 严格大于 sinceExclusive → 块起点 = 窗界（sinceExclusive+1 日）；终点 +1 日防容器
    # UTC 时区与 Asia/Shanghai 日期差漏行（未来日期不存在，边界无害）。
    window_start = _dt.date.fromisoformat(since_iso) + _dt.timedelta(days=1)
    end_date = _dt.date.today() + _dt.timedelta(days=1)

    def month_windows(start_date, end_date):
        """[start_date, end_date] 的自然月双向窗列表（含端点；首窗以 start_date 对齐）。"""
        windows = []
        y, m = start_date.year, start_date.month
        while True:
            first = _dt.date(y, m, 1)
            nxt_y, nxt_m = (y + 1, 1) if m == 12 else (y, m + 1)
            last = _dt.date(nxt_y, nxt_m, 1) - _dt.timedelta(days=1)
            w_start = max(first, start_date)
            w_end = min(last, end_date)
            if w_start <= w_end:
                windows.append((w_start.isoformat(), w_end.isoformat()))
            if last >= end_date:
                break
            y, m = nxt_y, nxt_m
        return windows

    def get_page(params, page, label):
        if page > 1:
            time.sleep(PAGE_SLEEP_SECONDS)
        params["pageNumber"] = str(page)
        try:
            resp = requests.get(API_URL, params=params, timeout=15)
        except Exception as exc:
            raise BridgeError(QUERY_ERROR, f"HTTP 异常（{label} 第 {page} 页）：{type(exc).__name__}: {exc}") from exc
        if resp.status_code != 200:
            raise BridgeError(QUERY_ERROR, f"HTTP {resp.status_code}（{label} 第 {page} 页）")
        try:
            body = resp.json()
        except Exception as exc:
            raise BridgeError(QUERY_ERROR, f"响应非 JSON（{label}）：{type(exc).__name__}: {exc}") from exc
        return body

    def fetch_chunk(w_start, w_end):
        """单月双向窗取数：首页 9201 如实空集；逐块 fetched-vs-total 自校验，不齐重试一次，
        残余不齐以 gap 如实申报（不静默、不造数）。"""
        label = f"{code} {w_start}..{w_end}"
        base_params = {
            "sortColumns": "NOTICE_DATE,ORG_CODE",
            "sortTypes": "-1,1",
            "pageSize": str(PAGE_SIZE),
            "pageNumber": "1",
            "reportName": "RPT_ORG_SURVEY",
            "columns": "ALL",
            "source": "WEB",
            "client": "WEB",
            "filter": (
                f'(SECURITY_CODE="{code}")(IS_SOURCE="1")'
                f"(RECEIVE_START_DATE>='{w_start}')(RECEIVE_START_DATE<='{w_end}')"
            ),
        }
        for attempt in (1, 2):  # 块级自校验：不齐整窗重取一次（排序漂移主要来自跨页会话）
            body = get_page(base_params, 1, label)
            if body.get("success") is not True:
                # 9201 '返回数据为空' = 该股该月无调研记录（合法空集，不造数）；
                # 9701 '服务器繁忙' 等其余失败归瞬态（TS 侧退避重试，DATA-SOURCES §7）。
                if str(body.get("code")) == "9201":
                    return {"rows": [], "total": 0, "gap": 0}
                raise BridgeError(QUERY_ERROR, f"来源返回失败 code={body.get('code')} message={body.get('message')!r}（{label}）")
            result = body.get("result") or {}
            pages = result.get("pages")
            _require(isinstance(pages, int) and pages >= 0, f"pages 字段异常：{pages!r}")
            _require(pages <= MAX_PAGES, f"分页超护栏：pages={pages} > {MAX_PAGES}")
            total = result.get("count") or 0
            rows = []
            data = result.get("data")
            if isinstance(data, list):
                rows.extend(jsonable(sanitize_row(dict(rec))) for rec in data)
            for page in range(2, pages + 1):
                body = get_page(base_params, page, label)
                if body.get("success") is not True:
                    raise BridgeError(QUERY_ERROR, f"来源返回失败 code={body.get('code')}（{label} 第 {page} 页）")
                result = body.get("result") or {}
                data = result.get("data")
                if not isinstance(data, list):
                    if page != pages:  # 中间页缺 data 视为瞬态源异常
                        raise BridgeError(QUERY_ERROR, f"第 {page} 页缺 data 字段（{label}）")
                    break
                rows.extend(jsonable(sanitize_row(dict(rec))) for rec in data)
            gap = max(0, total - len(rows))
            if gap == 0:
                return {"rows": rows, "total": total, "gap": 0}
            # gap>0（排序漂移漏行）：重试一次整窗；仍不齐则如实申报 gap。
        return {"rows": rows, "total": total, "gap": gap}

    rows = []
    chunk_meta = []
    gap_total = 0
    first_chunk = True
    for w_start, w_end in month_windows(window_start, end_date):
        if not first_chunk:
            time.sleep(PAGE_SLEEP_SECONDS)  # 块间退避（连发 9701 实证教训，与页间同值）
        first_chunk = False
        chunk = fetch_chunk(w_start, w_end)
        rows.extend(chunk["rows"])
        gap_total += chunk["gap"]
        chunk_meta.append({
            "start": w_start,
            "end": w_end,
            "total": chunk["total"],
            "fetched": len(chunk["rows"]),
            "gap": chunk["gap"],
        })

    meta = {
        "resource": "survey",
        "code": code,
        "sinceExclusive": since_iso,
        "rows": len(rows),
        "gapTotal": gap_total,  # 块级自校验后仍缺失的行数（如实申报；0=窗口内零缺失）
        "chunks": chunk_meta,
        "sourceUrl": API_URL,
    }
    if not rows:
        meta["emptySource"] = True  # 该股近窗无调研记录：如实空集（不报错、不造数）
    return {"ok": True, "rows": rows, "meta": meta}


def main(argv):
    # fd 级压制三方库输出（requests/urllib3 可能 print 到 stdout），stdout 只留一个 JSON 对象
    # （与 emfund/eminstitution/embalance 桥同法）。
    saved_obj = sys.stdout
    sys.stdout.flush()
    saved_fd = os.dup(1)
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull_fd, 1)
    sys.stdout = os.fdopen(os.dup(devnull_fd), "w")
    payload = {"ok": False}
    try:
        cmd, code, since = parse_args(argv)
        payload = fetch_survey(code, since)
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
