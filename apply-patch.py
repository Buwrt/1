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

    # 角标元素必须挂在「我的」这个 tab 内部 —— .badge 是 absolute 定位，
    # 靠父级 .tab 的 relative 定位，放到外面会飘到屏幕别处。
    replace_once(
        os.path.join(src, "app/src/main/assets/web/index.html"),
        '<button class="tab" data-tab="profile"><span class="tab-ico" data-icon="person"></span>'
        '<span class="tab-label">我的</span></button>',
        '<button class="tab" data-tab="profile"><span class="tab-ico" data-icon="person"></span>'
        '<span class="tab-label">我的</span><i class="badge" id="tab-lib-badge" hidden></i></button>',
        "index.html 我的 tab 加角标元素")

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

    # 3c. 应用库角标：先画本地台账（秒回），再静默查一轮
    replace_once(
        os.path.join(W, "app.js"),
        "      App.refreshBadge();\n      /*\n        首次启动自动播一遍新手引导。",
        "      App.refreshBadge();\n      App.refreshLibBadge();\n      /*\n"
        "        首次启动自动播一遍新手引导。",
        "app.js 启动时刷新应用库角标")

    replace_once(
        os.path.join(W, "app.js"),
        "      setInterval(function () { App.refreshBadge(); }, 120000);",
        "      setInterval(function () { App.refreshBadge(); }, 120000);\n"
        "      /* 应用库更新不用两分钟一查：仓库发版没那么频繁，30 分钟\n"
        "         一次足够，也省 GitHub 配额。LibBadge 内部还有 6 小时节流，\n"
        "         所以这里大部分调用其实只查一次本地表就返回了。 */\n"
        "      setInterval(function () { App.refreshLibBadge(); }, 1800000);",
        "app.js 定时刷新应用库角标")

    replace_once(
        os.path.join(W, "app.js"),
        "    window.AppOnResume = function () {\n      App.refreshBadge();",
        "    window.AppOnResume = function () {\n      App.refreshBadge();\n"
        "      App.refreshLibBadge();",
        "app.js 回前台刷新应用库角标")

    # 3d. 两个方法本体，插在 refreshBadge 之后（App 对象末尾）
    replace_once(
        os.path.join(W, "app.js"),
        "      }).catch(function () {});\n    }\n  };",
        """      }).catch(function () {});
    },

    /* ═══ 应用库角标：底部「我的」标签上的红点 ═══
       应用库藏在二级页里，光在「我的」页内给角标还不够 —— 得先点进
       「我的」才看得见，跟「藏在应用库页里」是同一个毛病。所以真正的
       提示要落在底栏上，打开 App 第一眼就看见。

       刻意做成两段：先按本地台账画（查 SQLite，毫秒级，不等网络），
       再让 LibBadge 静默查一轮把数字改准。这样底栏永远不会因为等请求
       而空着转圈，也不会一开机就打一串 GitHub 请求。 */
    updateLibBadge: function (n) {
      var b = document.getElementById('tab-lib-badge');
      if (!b) return;
      if (n > 0) { b.hidden = false; b.textContent = n > 99 ? '99+' : n; }
      else b.hidden = true;
    },

    refreshLibBadge: function () {
      try {
        if (!window.LibBadge) { this.updateLibBadge(0); return; }
        this.updateLibBadge(window.LibBadge.count());
        var self = this;
        window.LibBadge.refresh(6 * 3600 * 1000).then(function (m) {
          self.updateLibBadge(m);
        });
      } catch (e) { /* 角标画不出来不能影响其它功能 */ }
    }
  };""",
        "app.js 应用库角标方法")

    print("== 4. page-user.js：我的页入口（带可更新角标）==")
    # 4a. 插入 libRow 定义：放在 setRow 之前，两个函数同作用域
    replace_once(
        os.path.join(W, "page-user.js"),
        "  function setRow(icon, label, path) {",
        """  /* 应用库入口。
     跟旁边几行的差别是右侧多一枚数字角标：有几个应用可更新就写几。
     应用库藏在二级页里，不给提示的话更新永远不会被发现 —— 这正是
     「明明有更新、主界面一点动静都没有」的原因。

     角标先按本地台账画（秒回，不发请求），渲染完再让 LibBadge 静默
     查一轮；查出新结果就只改这一枚角标，不整页重画。 */
  function libRow() {
    var n = (window.LibBadge && window.LibBadge.count) ? window.LibBadge.count() : 0;
    // 角标元素始终渲染，没更新时只是隐藏 —— 不然静默查出新结果后
    // 无处安放（原本没这个元素，insert 要找父节点，不如开关 display）
    var badge = '<span class="lib-badge" style="flex:none;min-width:18px;height:18px;'
      + 'padding:0 6px;border-radius:9px;background:var(--danger,#e5534b);color:#fff;'
      + 'font-size:11px;line-height:18px;text-align:center;font-weight:600;'
      + (n > 0 ? '' : 'display:none') + '">' + (n > 0 ? n : '') + '</span>';
    setTimeout(function () {
      if (!window.LibBadge || !window.LibBadge.refresh) return;
      window.LibBadge.refresh(6 * 3600 * 1000).then(function (m) {
        var el = document.querySelector('.lib-badge');
        if (!el) return;
        if (m > 0) { el.textContent = m; el.style.display = ''; }
        else { el.style.display = 'none'; }
      });
    }, 400);
    return '<button class="set-row" data-p="/library">'
      + '<span class="ico">' + window.icon('package', 16) + '</span>'
      + '<span class="k">应用库</span>' + badge
      + window.icon('chevron-right', 16) + '</button>';
  }

  function setRow(icon, label, path) {""",
        "page-user.js libRow 定义")

    # 4b. 挂上入口
    replace_once(
        os.path.join(W, "page-user.js"),
        "          setRow('bell', '通知', '/notifications') +\n",
        "          setRow('bell', '通知', '/notifications') +\n"
        "          libRow() +\n",
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
