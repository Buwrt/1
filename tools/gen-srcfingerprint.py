#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
源码指纹：把「这份 APK 是由哪一份源码构建的」烙进包里。

为什么需要它 ——
  版本号相同、源码却不同的两个包，光看「关于 v1.1.5」是分不出来的。
  v1.1.5 就出过这么一回事：tag 指向旧提交，APK 却是新代码，
  于是「release 页面上看到的源码」和「用户装的那个包」对不上，
  排查起来只能靠人肉比对文案。

  有了指纹，两边一比就知道：包里这个哈希，和仓库里那份源码算出来的
  是不是同一个。

它是怎么算的 ——
  遍历 java 源码和前端资源，逐个文件算 SHA-256，把
  「相对路径 + 指纹」排序后拼成一整块文本，再对这块文本算一次 SHA-256。
  排序是必须的：不同机器上遍历顺序可能不同，不排序就会算出两个值。

  单文件改动 → 那一行变 → 整块文本变 → 总指纹变。牵一发动全身，
  正是想要的。

  指纹写进 api.js 的 SRC_SHA256 常量。这个文件自身被排除在外 ——
  它装的就是别人的指纹，自己参与计算会变成「自己算自己」，永远对不上。

用什么核对 ——
    python3 tools/gen-srcfingerprint.py           # 重算并回写 api.js
    python3 tools/gen-srcfingerprint.py --check   # 只核对，不写文件

  在仓库里跑一遍，拿输出的哈希去对「关于 → 源码指纹」里显示的那一串，
  一致就说明手上的包确实来自这份源码。

诚实的边界 ——
  这不是可复现构建（reproducible build）。严格意义上要两个人在不同机器上
  构建出「字节完全相同」的 APK，在 Android 上很难做到 —— Gradle 会塞时间戳，
  资源表排序也不保证稳定。这里做的是「源码 → 包内常量」的近似校验：
  能确认包对应哪份源码，但不能确认 APK 字节级可复现。
"""
import hashlib
import os
import sys

# 参与计算的目录（相对项目根）
SCAN_DIRS = [
    'app/src/main/java',
    'app/src/main/assets/web',
]

# 参与计算的扩展名（空集表示不限制）
EXTS = {'.java', '.js', '.css', '.html', '.json', '.py'}

# 被排除的文件（相对项目根，用 / 分隔）
# api.js 装指纹本身，参与计算会造成自指
EXCLUDE_FILES = {
    'app/src/main/assets/web/js/api.js',
}

# 被排除的目录片段
EXCLUDE_DIR_PARTS = {'build', '.git', 'node_modules', '__pycache__'}

# 指纹写进这里
API_JS = 'app/src/main/assets/web/js/api.js'
CONST_NAME = 'SRC_SHA256'


def norm(p):
    return p.replace(os.sep, '/').lstrip('./')


def should_skip(rel):
    if rel in EXCLUDE_FILES:
        return True
    parts = rel.split('/')
    return any(x in EXCLUDE_DIR_PARTS for x in parts[:-1])


def collect(root):
    rows = []
    for d in SCAN_DIRS:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in EXCLUDE_DIR_PARTS]
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                rel = norm(os.path.relpath(full, root))
                if should_skip(rel):
                    continue
                ext = os.path.splitext(fn)[1].lower()
                if EXTS and ext not in EXTS:
                    continue
                try:
                    with open(full, 'rb') as f:
                        data = f.read()
                except OSError:
                    continue
                rows.append((rel, hashlib.sha256(data).hexdigest()))
    rows.sort(key=lambda r: r[0])
    return rows


def fingerprint(rows):
    blob = ''.join('%s  %s\n' % (sha, rel) for rel, sha in rows)
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()


def read_const(api_js):
    try:
        with open(api_js, encoding='utf-8') as f:
            for line in f:
                s = line.strip()
                if s.startswith(CONST_NAME + ':'):
                    v = s.split(':', 1)[1].strip()
                    return v.strip().rstrip(',').strip().strip("'\"")
    except OSError:
        pass
    return None


def write_const(api_js, value):
    import re
    with open(api_js, encoding='utf-8') as f:
        src = f.read()
    pat = re.compile(r"(\n\s*" + CONST_NAME + r":\s*)'[^']*'")
    if not pat.search(src):
        print('[源码指纹] api.js 里找不到 %s 常量，已跳过写入' % CONST_NAME, file=sys.stderr)
        return False
    src = pat.sub(lambda m: m.group(1) + "'" + value + "'", src, count=1)
    with open(api_js, 'w', encoding='utf-8') as f:
        f.write(src)
    return True


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    check_only = '--check' in sys.argv[1:]

    root = args[0] if args else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    root = os.path.abspath(root)

    rows = collect(root)
    fp = fingerprint(rows)
    api_js = os.path.join(root, API_JS)

    print('[源码指纹] 纳入 %d 个文件' % len(rows))
    print('[源码指纹] SRC_SHA256 = %s' % fp)

    if check_only:
        cur = read_const(api_js)
        if cur == fp:
            print('[源码指纹] 与 api.js 中的常量一致 ✓')
            return 0
        print('[源码指纹] 不一致：api.js 里是 %s' % (cur or '(无)'), file=sys.stderr)
        return 1

    if write_const(api_js, fp):
        print('[源码指纹] 已写入 %s' % API_JS)
    return 0


if __name__ == '__main__':
    sys.exit(main())
