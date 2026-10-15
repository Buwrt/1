#!/usr/bin/env python3
# 一次性验证：YunX 的默认 GitHub 镜像前缀能不能真拿到 Release 附件
import time, urllib.request, urllib.error, ssl

TARGET = ("https://github.com/Buwrt/githup/releases/download/"
          "v1.2.15/githup-v1.2.15.apk")
CANDS = [
    ("cdn.gh-proxy.org (YunX 默认)", "https://cdn.gh-proxy.org/"),
    ("gh-proxy.com (现有加速1)",     "https://gh-proxy.com/"),
    ("直连",                          ""),
]
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

for label, prefix in CANDS:
    url = prefix + TARGET
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "githup"})
        c = urllib.request.urlopen(req, timeout=40, context=ctx)
        code = c.getcode()
        ct = c.headers.get("Content-Type", "?")
        cl = c.headers.get("Content-Length", "?")
        n = 0
        first = None
        last = None
        while True:
            b = c.read(65536)
            if not b:
                break
            now = time.time()
            if first is None:
                first = now
            last = now
            n += len(b)
            if n >= 512 * 1024:
                break
        c.close()
        dur = (last - first) if (first and last) else 0.001
        spd = n / dur if dur > 0 else 0
        print(f"{label:32s} HTTP={code} type={ct[:40]:40s} "
              f"bytes={n} ttfb={(first-t0)*1000:.0f}ms speed={spd/1024:.0f} KB/s")
    except urllib.error.HTTPError as e:
        print(f"{label:32s} HTTP={e.code} 失败")
    except Exception as e:
        print(f"{label:32s} 异常 {type(e).__name__}: {str(e)[:70]}")
