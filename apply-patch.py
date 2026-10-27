#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「应用库」改动打到 githup 源码上。

用法：
    python3 apply-patch.py <源码目录> <补丁目录>

每一处改动都是**精确字符串替换**，找不到锚点就立刻 exit 1 并打印原因 ——
静默失败的代价太大：界面上一个入口都没有，却看不出是补丁没打上。
"""
import os
import sys
import shutil
import io

def fail(msg):
    print("::error::" + msg)
    sys.exit(1)

def read(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()

def write(p, s):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)

def replace_once(path, old, new, what):
    """只替换第一处；old 必须存在且唯一，否则视为补丁与源码不匹配。"""
    s = read(path)
    n = s.count(old)
    if n == 0:
        fail("%s：找不到锚点 —— %s" % (what, old[:70].replace("\n", "\\n")))
    if n > 1:
        fail("%s：锚点出现 %d 次，不唯一，拒绝改动" % (what, n))
    write(path, s.replace(old, new, 1))
    print("  OK  %s" % what)

def main():
    if len(sys.argv) < 3:
        fail("用法: python3 apply-patch.py <源码目录> <补丁目录>")
    src = os.path.abspath(sys.argv[1])
    patch = os.path.abspath(sys.argv[2])

    J = os.path.join(src, "app/src/main/java/com/hubmobile/app")
    W = os.path.join(src, "app/src/main/assets/web/js")

    for d in (J, W):
        if not os.path.isdir(d):
            fail("源码目录结构不对：%s" % d)

    print("== 1. 复制新文件 ==")
    for name, dst in (
        ("AppLibrary.java", J),
        ("page-library.js", W),
    ):
        s = os.path.join(patch, name)
        if not os.path.isfile(s):
            fail("补丁缺少 %s" % name)
        shutil.copy(s, os.path.join(dst, name))
        print("  OK  %s -> %s" % (name, dst))

    print("== 2. index.html：引入 page-library.js ==")
    # 必须排在 app.js 之前：app.js 启动时会读 window.Pages，晚了注册不上
    replace_once(
        os.path.join(src, "app/src/main/assets/web/index.html"),
        '<script src="js/page-downloads.js"></script>\n',
        '<script src="js/page-downloads.js"></script>\n'
        '<script src="js/page-library.js"></script>\n',
        "index.html 加 script")

    print("== 3. app.js：路由白名单 + 路由分支 ==")
    # 3a. RESERVED：不加的话 /library 会被当成用户名，去查 library 这个 GitHub 账号
    replace_once(
        os.path.join(W, "app.js"),
        "'about', 'profile', 'totp'];",
        "'about', 'profile', 'totp', 'library'];",
        "app.js RESERVED")
    # 3b. 路由分支
    replace_once(
        os.path.join(W, "app.js"),
        "      case 'downloads': return { name: 'downloads', ctx: { query: query } };\n",
        "      case 'downloads': return { name: 'downloads', ctx: { query: query } };\n"
        "      case 'library': return { name: 'library', ctx: { query: query } };\n",
        "app.js 路由分支")

    print("== 4. page-user.js：我的页入口 ==")
    replace_once(
        os.path.join(W, "page-user.js"),
        "          setRow('bell', '通知', '/notifications') +\n",
        "          setRow('bell', '通知', '/notifications') +\n"
        "          setRow('package', '应用库', '/library') +\n",
        "page-user.js 入口")

    print("== 5. JsBridge.java：插入 lib* 桥接方法 ==")
    seg = read(os.path.join(patch, "JsBridge补丁段.java"))
    replace_once(
        os.path.join(J, "JsBridge.java"),
        "    @JavascriptInterface\n"
        "    public void exit() {\n"
        "        activity.runOnUiThread(() -> activity.finish());\n"
        "    }\n}",
        "    @JavascriptInterface\n"
        "    public void exit() {\n"
        "        activity.runOnUiThread(() -> activity.finish());\n"
        "    }\n\n" + seg + "\n}",
        "JsBridge 插入")

    print("== 6. AndroidManifest.xml：包可见性权限 ==")
    mf = os.path.join(src, "app/src/main/AndroidManifest.xml")
    s = read(mf)
    if "QUERY_ALL_PACKAGES" not in s:
        if "<uses-permission" in s:
            # 插到第一条 uses-permission 之前，保持权限块集中
            i = s.index("<uses-permission")
            s = (s[:i]
                 + '<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />\n    '
                 + s[i:])
        else:
            i = s.index("<manifest")
            j = s.index(">", i) + 1
            s = (s[:j]
                 + '\n    <uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />'
                 + s[j:])
        write(mf, s)
        print("  OK  AndroidManifest 加权限")
    else:
        print("  SKIP 已有 QUERY_ALL_PACKAGES")

    print("== 7. AndroidManifest.xml：卸载权限 ==")
    s = read(mf)
    if "REQUEST_DELETE_PACKAGES" not in s:
        i = s.index("<uses-permission")
        s = (s[:i]
             + '<uses-permission android:name="android.permission.REQUEST_DELETE_PACKAGES" />\n    '
             + s[i:])
        write(mf, s)
        print("  OK  AndroidManifest 加 REQUEST_DELETE_PACKAGES")
    else:
        print("  SKIP 已有 REQUEST_DELETE_PACKAGES")

    print("补丁应用完成")

if __name__ == "__main__":
    main()
