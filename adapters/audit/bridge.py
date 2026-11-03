#!/usr/bin/env python3
"""Lyra · 年报审计意见抽取桥（A 类 A5 / W32: code-writer-pro）。

容器化运行（与 adapters/valuation/bridge.py 同模式，不装 host；pypdf 已装入
lyra-akshare-py311 命名卷——W32 2026-10-25 登记，pypdf 6.21.2，仅本桥使用）：
  docker run --rm \\
    -v lyra-akshare-py311:/usr/local/lib/python3.11/site-packages \\
    -v <repo>:/work python:3.11-slim python /work/adapters/audit/bridge.py \\
    extract /work/data/artifacts/<shard>/<sha256> [...]

单文件多子命令 CLI，stdout 只输出一个 JSON 对象（与 adapters/sw/bridge.py 同合同）：
成功 {ok: true, results: [...]}, 失败 {ok: false, error_code, error}；退出码 0/1。
本地计算（读挂载卷内 PDF），无网络请求。

子命令：
  extract <pdf_path> [...]   读一至多份 PDF（批量摊薄容器启动开销），逐份：
    1. 字节 sha256（回传，TS 侧与 pdf_backfill_state.pdf_sha256 比对，防错文件）；
    2. pypdf 逐页 extract_text，页与页以 \\n 连接并记录每页起始偏移；
    3. 审计节定位（锚点为显式常量，不做判类——判类规则表在 TS 侧单一来源）：
       - 前向锚 "审计意见"：审计报告意见节标题（"一、审计意见"/"形成审计意见的基础"），
         窗口 = 出现处前 40 字至后 1000 字；
       - 后向锚 "意见的审计报告"：年报重要提示句（"……为本公司出具了标准无保留意见的
         审计报告"），窗口 = 出现处前 160 字至后 120 字；
       - 后向锚 "意见审计报告"：同句无"的"的旧式写法，窗口同上。
    4. 每锚点产出 {anchor, page, text}（text 为窗口原文，页码为 PDF 页序 1 起）。

实测依据（W32 探测 2026-10-25，600519 2018/2023 两份年报，pypdf 6.21.2）：
- 标准无保留意见的意见节窗口（"一、审计意见"后 ~1000 字）内**不含**"无保留意见"字样
  （意见段为"我们认为，后附的财务报表……公允反映了……"），判类关键词集中在重要提示句
  ——故必须有后向锚；
- "持续经营"在标准报告的责任段/关键审计事项中即出现（探测样本 11 次/份）——判类复合词
  的精确化在 TS 侧规则表处理，本桥只做位置定位；
- pypdf 抽取在词内插空格/换行伪影（"无保留意见的审 计报告"）——锚点定位一律在去空白
  文本上进行（W32 全量首跑实证 5 份年报因此零命中）；
- 143 页年报全文 ~16 万字，全文本不回传（只回传窗口；窗口文本为去空白原文）。
"""
import hashlib
import json
import os
import sys

USAGE_ERROR = "USAGE_ERROR"
PDF_ERROR = "AUDIT_PDF_FAILED"

# ===== 审计节定位锚点与窗口参数（显式常量；判类关键词表在 src/adapters/audit.ts）=====
# 锚点定位在去空白文本上：pypdf 抽取会在词内插空格/换行伪影（W32 全量实证："无保留意见的审
# 计报告"被抽成"……意见的审 计报告"，字面锚点丢失——600105/600276/600522/603259/603993
# 各年零命中根因）。去空白语义与 TS 侧 normalizeAuditText 一致。
FORWARD_ANCHOR = "审计意见"        # 审计报告意见节标题
BACKWARD_ANCHORS = (                # 年报重要提示句 "...出具了<类型>意见的审计报告"
    "意见的审计报告",
    "意见审计报告",                 # 旧式写法（无"的"）
)
FORWARD_BEFORE = 40      # 前向锚窗口：锚点前取字数
FORWARD_AFTER = 1000     # 前向锚窗口：锚点后取字数
BACKWARD_BEFORE = 240    # 后向锚窗口：锚点前取字数（覆盖"带有强调事项段、持续经营重大
                         # 不确定性段落、其他信息段落中包含其他信息未更正重大错报说明的"
                         # 等长前缀——W32 实证 600105 2023 截断窗曾致 R4/R5 冲突）
BACKWARD_AFTER = 120     # 后向锚窗口：锚点后取字数
MAX_WINDOWS = 80         # 单份 PDF 窗口数上限（超出置 truncated 标记，防关键词塞满的噪声文档）


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _require(cond, message):
    if not cond:
        raise BridgeError(USAGE_ERROR, message)


def parse_args(argv):
    _require(len(argv) >= 1, "缺子命令；用法：extract <pdf_path> [...]")
    cmd, args = argv[0], argv[1:]
    if cmd == "extract":
        _require(len(args) >= 1, "extract <pdf_path> [...]（至少一份 PDF）")
        return cmd, args
    raise BridgeError(USAGE_ERROR, f"未知子命令：{cmd}")


def extract_one(path):
    """单份 PDF → {ok, path, sha256, pages, textLen, windows, truncatedWindows}。"""
    with open(path, "rb") as fh:
        data = fh.read()
    from pypdf import PdfReader

    reader = PdfReader(path)  # 解析失败按本份 PDF_ERROR 上报，不影响同批其余
    page_texts = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:  # 单页抽取失败按空页处理，不弃整份
            text = ""
        page_texts.append("".join(text.split()))  # 去空白（锚点定位鲁棒性，见常量注）
    offsets = [0]
    for text in page_texts:
        offsets.append(offsets[-1] + len(text) + 1)  # +1 为页间 \n
    full = "\n".join(page_texts)

    def page_at(offset):
        last = 1
        for index, start in enumerate(offsets[:-1]):
            if start <= offset:
                last = index + 1
            else:
                break
        return last

    windows = []
    start = 0
    while True:
        index = full.find(FORWARD_ANCHOR, start)
        if index < 0:
            break
        windows.append({
            "anchor": FORWARD_ANCHOR,
            "page": page_at(index),
            "text": full[max(0, index - FORWARD_BEFORE): index + FORWARD_AFTER],
        })
        start = index + len(FORWARD_ANCHOR)
    for anchor in BACKWARD_ANCHORS:
        start = 0
        while True:
            index = full.find(anchor, start)
            if index < 0:
                break
            windows.append({
                "anchor": anchor,
                "page": page_at(index),
                "text": full[max(0, index - BACKWARD_BEFORE): index + len(anchor) + BACKWARD_AFTER],
            })
            start = index + len(anchor)
    windows.sort(key=lambda w: (w["page"], w["anchor"]))
    truncated = len(windows) > MAX_WINDOWS
    return {
        "ok": True,
        "path": path,
        "sha256": hashlib.sha256(data).hexdigest(),
        "pages": len(page_texts),
        "textLen": len(full),
        "windows": windows[:MAX_WINDOWS],
        "truncatedWindows": truncated,
    }


def run(cmd, args):
    results = []
    for path in args:
        try:
            results.append(extract_one(path))
        except BridgeError:
            raise
        except Exception as exc:
            results.append({
                "ok": False,
                "path": path,
                "error_code": PDF_ERROR,
                "error": f"{type(exc).__name__}: {exc}",
            })
    return {"ok": True, "results": results}


def main(argv):
    # fd 级压制三方库输出（pypdf 解析告警等），stdout 只留一个 JSON 对象
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
    except Exception as exc:
        payload = {"ok": False, "error_code": PDF_ERROR, "error": f"{type(exc).__name__}: {exc}"}
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
