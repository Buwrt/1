#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实测所有加速通道能不能真的代理 GitHub Release 附件。

═══ 为什么这个脚本要丢到 GitHub Actions 里跑 ═══

打包环境（沙盒）的外网出口有白名单策略：所有不在名单里的域名一律
403，连直连 GitHub 都被拒。也就是说在那里测出来的「不可用」是
**环境拦截**，不是通道真的挂了 —— 用它做判据会把一批好通道误杀。

CI runner 没有这个限制，是真实的公网出口。所以验证必须在那里跑。

═══ 判据 ═══

一条通道算「可用」，必须同时满足：
  1. HTTP 状态码 200 或 206
  2. 真的读到了字节（不是空响应）
  3. 内容类型像是要下载的东西（有些镜像会把 HTML 错误页当 200 返回）

速度 = 读到的字节数 / (最后字节时间 − 首字节时间)
—— 跟 App 里 measureChannel() 的算法一致，这样两边结果可比。

用法：
    python3 tools/probe-channels.py                 # 用默认目标
    python3 tools/probe-channels.py <release-url>   # 指定目标
"""

import sys
import time
import json
import urllib.request
import urllib.error
import concurrent.futures as cf

# 默认测速目标：本软件自己的 Release 附件（真实存在，且体积够大）
DEFAULT_TARGET = ("https://github.com/Buwrt/githup/releases/download/"
                  "v1.2.15/githup-v1.2.15.apk")

# 通道清单 —— 必须与 DownloadChannels.MIRRORS 保持一致
# （CI 里会从源码里读，这里的副本只是本地跑时的兜底）
MIRRORS = [
    # 第一组：CI 实测可用
    "https://cdn.gh-proxy.org/",   # 云析（YunX）默认镜像，实测最快
    "https://gh-proxy.com/",
    "https://gh.llkk.cc/",
    "https://cors.isteed.cc/",
    "https://gh-proxy.at9.net/",
    "https://gh.noki.icu/",
    "https://ghfile.geekertao.top/",
    "https://ghproxy.net/",
    "https://ghfast.top/",
    # 第二组：CI 海外 IP 被拒，保留待观察
    "https://ghproxy.imciel.com/",
    "https://gh.idayer.com/",
    "https://gh.ddlc.top/",
    "https://github.boki.moe/",
    "https://gh.h233.eu.org/",
    "https://proxy.vvvv.ee/",
    "https://ghproxy.homeboyc.cn/",
    "https://gh.zwy.one/",
]

UA = "githup"
CONNECT_TIMEOUT = 12
READ_TIMEOUT = 12
WINDOW_MS = 2000          # 读多久（跟 App 的 PROBE_WINDOW_MS 一致）
MAX_BYTES = 256 * 1024    # 最多读多少
RETRY_GAP_SEC = 3         # 复核时每条之间隔多久（避免继续被限流）


def probe(mirror, target):
    """测一条通道。返回 dict。"""
    url = mirror + target
    req = urllib.request.Request(url, method="GET", headers={
        "User-Agent": UA,
        "Range": "bytes=0-%d" % (MAX_BYTES - 1),
    })
    t0 = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=CONNECT_TIMEOUT)
        code = r.status
        ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()

        buf = 16 * 1024
        got = 0
        first_at = None
        last_at = None
        while got < MAX_BYTES:
            chunk = r.read(buf)
            if not chunk:
                break
            now = time.time()
            if first_at is None:
                first_at = now
            got += len(chunk)
            last_at = now
            if last_at - first_at >= WINDOW_MS / 1000.0:
                break
        r.close()

        # 判据 3：HTML 当 200 返回的一律算不可用（多半是错误页/拦截页）
        if "html" in ctype.lower():
            return {"mirror": mirror, "ok": False, "code": code,
                    "bytes": got, "bps": 0, "ctype": ctype,
                    "note": "返回的是 HTML 页面，不是文件"}

        if code not in (200, 206) or got <= 0:
            return {"mirror": mirror, "ok": False, "code": code,
                    "bytes": got, "bps": 0, "ctype": ctype,
                    "note": "状态码 %s / 读到 %d 字节" % (code, got)}

        dt = (last_at or first_at or t0) - (first_at or t0)
        if dt < 0.2:
            dt = 0.2
        bps = int(got * 1000 / (dt * 1000)) if dt > 0 else 0
        return {"mirror": mirror, "ok": True, "code": code,
                "bytes": got, "bps": bps, "ctype": ctype,
                "ttfb_ms": int((first_at - t0) * 1000) if first_at else -1,
                "note": ""}

    except urllib.error.HTTPError as e:
        return {"mirror": mirror, "ok": False, "code": e.code,
                "bytes": 0, "bps": 0, "ctype": "", "note": "HTTP %s" % e.code}
    except Exception as e:
        return {"mirror": mirror, "ok": False, "code": "ERR",
                "bytes": 0, "bps": 0, "ctype": "",
                "note": type(e).__name__ + ": " + str(e)[:60]}


def kb(bps):
    if bps >= 1024 * 1024:
        return "%.1f MB/s" % (bps / 1048576)
    if bps >= 1024:
        return "%d KB/s" % (bps // 1024)
    return "%d B/s" % bps


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TARGET

    # 尽量从源码里读通道清单，避免脚本和 Java 不同步
    mirrors = list(MIRRORS)
    try:
        src = open("app/src/main/java/com/hubmobile/app/DownloadChannels.java",
                   encoding="utf-8").read()
        i = src.index("static final String[] MIRRORS")
        j = src.index("};", i)
        import re
        found = re.findall(r'"(https://[^"]+)"', src[i:j])
        if len(found) >= 10:
            mirrors = found
            print("[通道清单] 从源码读到 %d 条" % len(mirrors))
    except Exception as e:
        print("[通道清单] 读源码失败（%s），用脚本内置副本 %d 条"
              % (str(e)[:40], len(mirrors)))

    print("[目标] %s" % target)
    print("[开始] 第 1 轮：并发实测 %d 条通道\n" % len(mirrors))

    results = []
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(probe, m, target): m for m in mirrors}
        for f in cf.as_completed(futs):
            results.append(f.result())

    # 按原顺序排回来，方便和清单对照
    order = {m: i for i, m in enumerate(mirrors)}
    results.sort(key=lambda r: order.get(r["mirror"], 999))

    # ── 第 2 轮：对失败的做降速复核 ──
    #
    # ⚠️ 这一步不能省。并发 8 条同时打，很容易把镜像打到限流（429）。
    #    而 429 是「你太快了」，不是「我挂了」—— 拿它当判据会把一批
    #    好通道误杀掉（实测里第一组就有 3 条栽在这上面）。
    #
    #    所以对失败的通道串行重试一遍，中间留间隔。仍然失败才算真不可用。
    first_fail = [r for r in results if not r["ok"]]
    if first_fail:
        print("\n[第 2 轮] 对 %d 条失败的做降速复核（串行 + 间隔）\n"
              % len(first_fail))
        retry_map = {}
        for r in first_fail:
            time.sleep(RETRY_GAP_SEC)          # 给对方喘口气
            retry_map[r["mirror"]] = probe(r["mirror"], target)
            print("  %-34s %s" % (r["mirror"],
                                  "✅ 复核通过" if retry_map[r["mirror"]]["ok"]
                                  else "❌ 仍失败：" + retry_map[r["mirror"]]["note"]))

        # 用复核结果覆盖第一轮
        for r in results:
            if not r["ok"] and r["mirror"] in retry_map:
                nr = retry_map[r["mirror"]]
                if nr["ok"]:
                    r.update(nr)
                    r["note"] = "首轮被限流，降速复核通过"
                    r["retried"] = True

    ok = [r for r in results if r["ok"]]
    ok.sort(key=lambda r: -r["bps"])

    print("═" * 68)
    print("可用 %d / %d 条" % (len(ok), len(results)))
    print("═" * 68)
    for r in ok:
        tag = "（复核救回）" if r.get("retried") else "           "
        print("  ✅ %-34s %-10s TTFB %5dms  %s %s"
              % (r["mirror"], kb(r["bps"]), r.get("ttfb_ms", -1),
                 tag, r.get("ctype", "")))

    bad = [r for r in results if not r["ok"]]
    if bad:
        print("\n不可用 %d 条：" % len(bad))
        for r in bad:
            print("  ❌ %-34s %s" % (r["mirror"], r["note"]))

    # 机器可读的结果，CI 会归档
    out = {
        "target": target,
        "probed_at": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()),
        "total": len(results),
        "ok_count": len(ok),
        "results": results,
    }
    with open("channel-probe.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("\n[结果] 已写入 channel-probe.json")

    # 给 CI 用的纯文本摘要
    lines = ["可用 %d / %d 条（%s UTC）"
             % (len(ok), len(results), out["probed_at"]), ""]
    for r in ok:
        lines.append("OK   %s  %s%s" % (r["mirror"], kb(r["bps"]),
                                        "  [复核救回]" if r.get("retried") else ""))
    for r in bad:
        lines.append("FAIL %s  %s" % (r["mirror"], r["note"]))
    with open("channel-probe.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("[结果] 已写入 channel-probe.txt")

    return 0


if __name__ == "__main__":
    sys.exit(main())
