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
        ("page-stats.js", W),
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
        '<script src="js/page-library.js"></script>\n'
        '<script src="js/page-stats.js"></script>\n',
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

    print("== 8. JsBridge.java：APK 装之前自动入账 ==")
    # 位置必须在「拷进 ApkProvider 之后、openInstaller 之前」：
    # 此刻文件一定在，包名也读得出来；等装完再找，文件早被清了。
    replace_once(
        os.path.join(J, "JsBridge.java"),
        """            Uri uri = ApkProvider.uriFor(
                    activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX, outName);
            openInstaller(uri);
        } catch (Throwable e) {
            Toast.makeText(activity,
                    "请在下载目录中找到该 APK 并安装", Toast.LENGTH_LONG).show();
        }""",
        """            /* 装之前先把这一笔落进应用库：此刻包名读得到、文件也在。
               失败不能影响安装本身，所以整段吞异常。 */
            try {
                AppLibrary.trackFromApk(activity, t.originUrl, dst);
            } catch (Throwable ignored) { }
            Uri uri = ApkProvider.uriFor(
                    activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX, outName);
            openInstaller(uri);
        } catch (Throwable e) {
            Toast.makeText(activity,
                    "请在下载目录中找到该 APK 并安装", Toast.LENGTH_LONG).show();
        }""",
        "JsBridge 安装前入账")

    print("== 9. page-detail.js：下载即关联（来源钉在按钮上）==")

    # 9a. helper
    replace_once(
        os.path.join(W, "page-detail.js"),
        """  var FULL = 'application/vnd.github.full+json';""",
        """  var FULL = 'application/vnd.github.full+json';

  /* ── 下载即关联 ──

     ⚠️ 来源**必须钉在按钮上**，不能存在模块级变量里。

     早先的写法是一个全局 _curFull，进 release / run 页时赋值，下载时读它。
     问题：它是**陈旧状态** —— 用户看完 A 仓库的发布页，再切到 B 仓库从
     别处（文件页、仓库主页）下载一个 APK，_curFull 还停在 A，于是装了
     B 的软件却绑成 A 的仓库。表现就是「我下的是这个，怎么绑的是那个」。

     现在渲染按钮时把 owner/repo 直接写进 data-repo，点哪个按钮就用哪个
     来源 —— 来源跟按钮同生共死，不存在过期这回事。

     入账用的是**实际安装的 APK 的包名**（原生 getPackageArchiveInfo 读的），
     不是文件名猜的。所以「装 a 就绑 a」是硬的。 */
  function parseRepo(s) {
    var m = /^([^/\\s]+)\\/([^/\\s]+)$/.exec(String(s || '').trim());
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  /**
   * @param repoStr 显式来源 "owner/repo"，优先用它；
   *                没有才退回（老路径）。传 null 即「来源不明，不关联」。
   */
  function installTracked(url, name, tag, asset, repoStr) {
    var b = window.NativeBridge;
    var r = parseRepo(repoStr);
    var headers = { Accept: 'application/vnd.android.package-archive' };
    try {
      if (b && typeof b.installApkTracked === 'function' && r) {
        b.installApkTracked(url, name, JSON.stringify(headers),
          r.owner, r.repo, tag || '', asset || name, 'release');
        return true;
      }
      if (b && typeof b.installApk === 'function') {
        b.installApk(url, name, JSON.stringify(headers), 'release');
        return true;
      }
      if (window.Native && typeof window.Native.installApk === 'function') {
        window.Native.installApk(url, name, headers, 'release');
        return true;
      }
    } catch (e) { /* 落到下面 */ }
    return false;
  }""",
        "page-detail.js 注入 helper")

    # 9b. Release 附件：把 full 写进每个按钮
    replace_once(
        os.path.join(W, "page-detail.js"),
        """              return '<button class="list-row" data-dl="' + U.esc(a.browser_download_url) + '" data-n="' + U.esc(a.name) + '">' +""",
        """              /* data-repo：来源钉死在这一行上，点它就只会绑这个仓库 */
              return '<button class="list-row" data-dl="' + U.esc(a.browser_download_url) + '" data-n="' + U.esc(a.name) + '" data-repo="' + U.esc(full) + '">' +""",
        "page-detail.js 附件带 data-repo")

    # 9c. 点击时从按钮读来源（直接改原始那段 onclick）
    replace_once(
        os.path.join(W, "page-detail.js"),
        """        UI.$$('[data-dl]', host).forEach(function (b) {
          b.onclick = function () {
            var url = b.getAttribute('data-dl'), name = b.getAttribute('data-n');
            // 带认证头：私有仓库的资产、以及 API 返回的下载链接都需要 Authorization
            // Release 附件统一落 githup/release
            var ok = window.Native.download(url, name, window.Native.authHeaders(), 'release');
            if (ok) UI.toast('开始下载 ' + name);
          };
        });""",
        """        UI.$$('[data-dl]', host).forEach(function (b) {
          b.onclick = function () {
            var url = b.getAttribute('data-dl'), name = b.getAttribute('data-n');
            /* APK 附件：装，并把来源记下来自动进应用库。
               来源从这一行自己带的 data-repo 读 —— 不是全局变量，
               所以不存在「看完 A 仓库再下 B 的软件却绑成 A」这种串味。
               其它类型（zip / tar.gz / 校验文件）照旧只下载。 */
            if (/\\.apk$/i.test(name || '')) {
              if (installTracked(url, name, rel.tag_name, name,
                    b.getAttribute('data-repo'))) {
                UI.toast('开始下载 ' + name + '，装完自动加入应用库');
                return;
              }
            }
            // 带认证头：私有仓库的资产、以及 API 返回的下载链接都需要 Authorization
            // Release 附件统一落 githup/release
            var ok = window.Native.download(url, name, window.Native.authHeaders(), 'release');
            if (ok) UI.toast('开始下载 ' + name);
          };
        });""",
        "page-detail.js 附件点击读 data-repo")

    # 9d. Actions 产物：bindArtifacts 接收 full，按钮带 data-repo
    replace_once(
        os.path.join(W, "page-detail.js"),
        "        bindArtifacts(host);",
        "        bindArtifacts(host, full);",
        "page-detail.js bindArtifacts 传 full")

    replace_once(
        os.path.join(W, "page-detail.js"),
        """  /** 绑定构建产物的下载事件 */
  function bindArtifacts(host) {
    UI.$$('[data-art]', host).forEach(function (b) {""",
        """  /** 绑定构建产物的下载事件。repoFull 是本页的 owner/repo，挂到按钮上 */
  function bindArtifacts(host, repoFull) {
    UI.$$('[data-art]', host).forEach(function (b) {
      if (repoFull && !b.getAttribute('data-repo')) b.setAttribute('data-repo', repoFull);""",
        "page-detail.js bindArtifacts 签名")

    replace_once(
        os.path.join(W, "page-detail.js"),
        """        if (mode === 'install') {
          window.Native.installApk(url, name, window.Native.authHeaders());
          UI.toast('开始下载，完成后会自动解压安装');
        } else {""",
        """        if (mode === 'install') {
          /* 来源同样从按钮自己带的 data-repo 读 */
          if (installTracked(url, name, '', '', b.getAttribute('data-repo'))) {
            UI.toast('开始下载，完成后会自动解压安装');
          } else {
            window.Native.installApk(url, name, window.Native.authHeaders());
            UI.toast('开始下载，完成后会自动解压安装');
          }
        } else {""",
        "page-detail.js 产物点击读 data-repo")

    print("== 12. 数据概览页：路由与入口 ==")

    # 12a. RESERVED：不加的话 /stats 会被当成用户名，去查 stats 这个 GitHub 账号
    replace_once(
        os.path.join(W, "app.js"),
        "'about', 'profile', 'totp', 'library'];",
        "'about', 'profile', 'totp', 'library', 'stats'];",
        "app.js RESERVED 加 stats")

    # 12b. 路由分支
    replace_once(
        os.path.join(W, "app.js"),
        "      case 'library': return { name: 'library', ctx: { query: query } };\n",
        "      case 'library': return { name: 'library', ctx: { query: query } };\n"
        "      case 'stats': return { name: 'stats', ctx: { query: query } };\n",
        "app.js 路由加 stats")

    # 12c. 「我的」页入口
    replace_once(
        os.path.join(W, "page-user.js"),
        "          setRow('graph', 'API 配额', '/settings?tab=quota') +\n",
        "          setRow('graph', '数据概览', '/stats') +\n"
        "          setRow('graph', 'API 配额', '/settings?tab=quota') +\n",
        "page-user.js 加数据概览入口")

    print("== 13. 单文件直取：仓库里的文件不走 DownloadManager ==")

    replace_once(
        os.path.join(J, "JsBridge.java"),
        """        if (url == null || url.isEmpty()) return;
        final String name = (filename == null || filename.isEmpty()) ? "download" : filename;
        final String dlCategory = safeCategory(category);
""",
        """        if (url == null || url.isEmpty()) return;
        final String name = (filename == null || filename.isEmpty()) ? "download" : filename;
        final String dlCategory = safeCategory(category);

        /*
          单文件（仓库里的 yml / md / 源码）直接抓，别送进 DownloadManager。
          那条通道是给大文件（Release 附件、源码包）准备的，中间要绕第三方
          加速镜像 —— 那些镜像是免费的第三方服务，随时限流或关停。一个小文件
          绕这一圈，慢和失败都出在代理那头，用户换自己的网络当然没用。
          而 raw.githubusercontent.com 正是 App 自己读 README、代码用的域名，
          同一套原生栈本来就是通的。
          大文件（Release 附件 / 源码包）不在这里拦，照旧走镜像换道。
        */
        if (isRawFileUrl(url) && expectedBytes <= DIRECT_FETCH_MAX_BYTES) {
            startDirectFileFetch(url, name, headersJson, dlCategory);
            return;
        }
""",
        "JsBridge 单文件直取拦截")

    print("补丁应用完成")

    print("== 10. 下载历史：本地文件删了，记录跟着走 ==")

    # 10a. 安全网加下限：记录少的时候「全没了」就是真没了
    replace_once(
        os.path.join(J, "JsBridge.java"),
        """        /* 安全网 3：全军覆没 = 查询本身不可信，一条都不删 */
        if (total > 0 && dead == total) {
            android.util.Log.w("githup",
                    "历史核对：全部 " + total + " 条都判为文件不存在，疑查询失效，跳过剔除");
            return false;
        }""",
        """        /* 安全网 3：全军覆没 = 查询本身不可信，一条都不删。

           ⚠️ 但必须有下限 —— 以前写成 total > 0 就生效，于是历史里
           **只有 1 条**时，用户把那个文件删掉，total=1 且 dead=1，
           直接被当成「查询失效」跳过剔除 —— 记录永远留着，用户看到的
           就是「本地明明删了，App 里还有」。

           少量记录全没了就是真没了，保护只在样本够多时才有意义。 */
        final int SAFETY_MIN = 3;
        if (total >= SAFETY_MIN && dead == total) {
            android.util.Log.w("githup",
                    "历史核对：全部 " + total + " 条都判为文件不存在，疑查询失效，跳过剔除");
            return false;
        }""",
        "JsBridge 安全网加下限")

    # 10b. 手动核对入口（跳过节流，且忽略安全网）
    replace_once(
        os.path.join(J, "JsBridge.java"),
        """    /** 历史核对节流：页面 800ms 轮询一次，不必每次都查 uri */
    private static final long URI_CHECK_GAP_MS = 5_000L;""",
        """    /**
     * 手动核对：跳过节流，也忽略「全军覆没」那条安全网。
     *
     * 用户主动点的那一次，意图是明确的 —— 「我删了文件，把记录也清掉」。
     * 这时候再拿安全网拦着，用户只会觉得点了没反应。
     * 自动核对才需要保守，手动核对应该照做。
     */
    private int pruneMissingNow() {
        synchronized (dlHistory) {
            loadHistoryLocked();
            int removed = 0;
            for (int i = dlHistory.length() - 1; i >= 0; i--) {
                JSONObject o = dlHistory.optJSONObject(i);
                if (o == null) continue;
                if (!o.optBoolean("ok", false)) continue;   // 失败记录本来就没文件
                String uri = o.optString("uri", "");
                if (uri.isEmpty()) continue;                // 没位置信息，不判断
                if (!fileReallyGone(o, uri)) continue;
                dlHistory.remove(i);
                removed++;
            }
            if (removed > 0) saveHistoryLocked();
            return removed;
        }
    }

    /** 历史核对节流：页面 800ms 轮询一次，不必每次都查 uri */
    private static final long URI_CHECK_GAP_MS = 5_000L;""",
        "JsBridge 手动核对方法")

    # 10c. 前端：「清空记录」旁边加「核对本地文件」
    replace_once(
        os.path.join(W, "page-downloads.js"),
        """        '<button class="dl-clear" id="dl-clear">清空记录</button></div>' +""",
        """        '<button class="dl-clear" id="dl-verify">核对本地文件</button>' +
        '<button class="dl-clear" id="dl-clear">清空记录</button></div>' +""",
        "page-downloads 加核对按钮")

    replace_once(
        os.path.join(W, "page-downloads.js"),
        """      var clear = UI.$('#dl-clear', host);
      if (clear) clear.onclick = clearHistory;""",
        """      var clear = UI.$('#dl-clear', host);
      if (clear) clear.onclick = clearHistory;

      /* 核对本地文件：用户在文件管理器里删了文件，这里还留着记录 ——
         点一下把「本地确实没了」的那几条清掉。
         自动核对有 5 秒节流、还有一条防误删的安全网，手动点这一次
         两个都跳过去，意图明确就该照做。 */
      var verify = UI.$('#dl-verify', host);
      if (verify) verify.onclick = function () {
        var n = 0;
        try { n = NB.pruneDownloadHistory() || 0; } catch (e) { n = 0; }
        if (n > 0) UI.toast('已清掉 ' + n + ' 条（本地文件已不存在）');
        else UI.toast('都在，没有失效的记录');
        setTimeout(refreshHistory, 300);
      };""",
        "page-downloads 核对按钮逻辑")

    print("== 11. 加速通道 / ZIP 解压 也入账 ==")

    # 11a. installFinished：加速通道（点了 Star 走这条）下完直接装，
    #      原本根本没经过入账 —— 只有没点 Star 的限速通道才会关联。
    replace_once(
        os.path.join(J, "JsBridge.java"),
        """            if (inst && isZip) {
                pool.execute(() -> extractAndInstall(uri, name));
            } else {
                openInstaller(uri);
            }""",
        """            if (inst && isZip) {
                pool.execute(() -> extractAndInstall(uri, name, t.originUrl));
            } else if (inst && name.toLowerCase().endsWith(".apk")) {
                /* 入账：加速通道下完给的是 content://，不是 File，
                   所以先落进 ApkProvider 目录（顺便就能读包名），
                   装的时候也用同一个地址。
                   入账失败不能影响安装 —— 落 null 就照原样装。 */
                File staged = null;
                try {
                    staged = AppLibrary.stageApk(activity, t.originUrl, uri, name);
                } catch (Throwable ignored) { }
                if (staged != null) {
                    openInstaller(ApkProvider.uriFor(
                            activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX,
                            staged.getName()));
                } else {
                    openInstaller(uri);
                }
            } else {
                openInstaller(uri);
            }""",
        "JsBridge installFinished 入账")

    # 11b. extractAndInstall：ZIP 解压出 APK 后也带上来源
    replace_once(
        os.path.join(J, "JsBridge.java"),
        "    private void extractAndInstall(Uri zipUri, String zipName) {",
        "    private void extractAndInstall(Uri zipUri, String zipName, String originUrl) {",
        "JsBridge extractAndInstall 加 originUrl")

    replace_once(
        os.path.join(J, "JsBridge.java"),
        """        Uri uri = ApkProvider.uriFor(
                activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX, best.getName());
        openInstaller(uri);
    }""",
        """        /* 解压出来的 APK 也是「从 githup 装的」，同样入账 */
        try {
            AppLibrary.trackFromApk(activity, originUrl, best);
        } catch (Throwable ignored) { }
        Uri uri = ApkProvider.uriFor(
                activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX, best.getName());
        openInstaller(uri);
    }""",
        "JsBridge extractAndInstall 入账")

    print("补丁应用完成")


if __name__ == "__main__":
    main()
