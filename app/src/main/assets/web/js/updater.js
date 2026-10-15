/* ============================================================
 * updater.js — 内置更新检测
 *
 * 版本号规则（x.y.z 三段，更新源为 GitHub Release 的 tag）：
 *
 *   x 第一位 —— 大版本。这一位变了，强制更新：
 *               弹层不可关闭，必须下载安装才能继续用。
 *               例：1.1.1 -> 2.0.0
 *   y 第二位 —— 功能更新。这一位变了，同样强制更新：
 *               带了新功能，不装不让用，弹层同样不可关闭。
 *               例：1.1.1 -> 1.2.0
 *   z 第三位 —— 修复更新。只修 bug、不影响使用，可更可不更：
 *               给「立即更新 / 稍后提醒 / 跳过此版」三个按钮。
 *               例：1.1.1 -> 1.1.2
 *
 * 一句话概括：前两位变 = 强制，只有第三位变 = 可选。
 *
 * 判定方式：从高位往下比，「第一个出现差异的那一位」决定更新级别。
 * 比不出大小（版本相同、或服务端版本更旧）就不提示。
 *
 * 更新有两个数据来源，先试 Release，拿不到就用仓库里的版本清单：
 *
 *   1. Release —— 仓库 Buwrt/githup 最新一个正式版（跳过 draft / prerelease），
 *      取其 .apk 附件，交给原生层的 installApk 下载并拉起安装器。
 *   2. version.json —— 仓库根目录的版本清单。用于仓库还没发 Release、
 *      或当前 Token 没有 Release 读取权限的情况。内容形如：
 *        { "version": "1.2.0", "apk": "apk/githup-V5.apk", "notes": "..." }
 *      APK 直接走 raw 地址下载。
 *
 * 两条路拿到的结果结构完全一致，界面层不需要区分。
 * ============================================================ */
(function () {
  'use strict';

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var OWNER = 'Buwrt';
  var REPO = 'githup';
  var MANIFEST = 'version.json';   // 仓库根目录的版本清单（Release 的备用来源）
  var RAW_BASE = 'https://raw.githubusercontent.com/' + OWNER + '/' + REPO + '/main';
  var SKIP_KEY = 'updSkipVersion'; // 用户主动跳过的新版本号
  var SKIP_SHA_KEY = 'updSkipSha'; // 用户主动跳过的那个包的指纹（版本号不变但又重新打包时用）
  var LAST_KEY = 'updLastCheck';   // 上次「回到前台」检查的时间戳（仅用于切后台，不限制冷启动）
  var UPD_KEY = 'updUpdatingSha';  // 用户点了「立即更新」的那个包的指纹（装完之前别再弹）
  var MINE_KEY = 'updUpdatingMine';// 点「立即更新」时本机的指纹（用来判断更新到底装上没有）
  var UPD_AT_KEY = 'updUpdatingAt';// 记下这一笔的时间 —— 是它给「正在装」加了期限

  /**
   * 「正在装这一份」这条记录的有效期。
   *
   * ⚠️ 加这个期限是在修一个真实事故，记下来免得又被删掉：
   *
   *   原来这条记录**没有期限**，只要本机指纹还没变就永远压着不提醒。
   *   而写入它的时机是「按下立即更新」—— 也就是 `install()` 一返回 true 就记，
   *   可那时候只是「原生开始下载」，下载可能失败、系统安装器可能被拒绝、
   *   用户也可能直接退出安装界面。
   *
   *   结果就是：用户点一次「立即更新」没装成，**从此这个更新再也不提醒了**，
   *   干等也不知道为什么。实测反馈就是「第一次让我更新，点完立即更新，
   *   下一次就不弹了，关键是我没更新成功」。
   *
   *   所以给它一个期限：超过这个时间还没装上，就认为上一次尝试已经结束了，
   *   下次启动照常提醒。选 30 分钟是因为正常下载 + 安装远用不了这么久，
   *   而「下载中途切走又回来」这个正常场景在 30 分钟内不会被误判。
   */
  var UPD_TTL = 30 * 60 * 1000;

  /**
   * 内置的官方安装包指纹表（精确版本钉扎）。
   *
   * 表里是「包名 -> 该文件的 SHA-256」。查得到就用它，跟 version.json 里的
   * 清单值交叉比对，两边不一致说明有一方被改了。
   *
   * ⚠️ 为什么这里不写当前这个包自己的哈希 ——
   *    APK 不可能在内部写下自己的哈希：把哈希写进去，包的内容就变了，
   *    哈希也随之改变，永远对不上（鸡生蛋问题）。
   *
   *   真正与字节无关的、能钉死「官方身份」的是**签名证书指纹**，
   *    它由原生层在装包前校验（见 JsBridge.verifyApk），不依赖包本身的哈希。
   *    所以：证书指纹负责「是不是官方签的」，这张表 + 清单负责「是不是该装的那一份」。
   *
   * 用法：发新版时把「下一个版本」的哈希加进来即可（比如发 V8 时填 V8 的）。
   */
  var PINNED_SHA = {
    // 'githup-V8.apk': '将来发新版时填这一份的 SHA-256'
  };

  /** 取某个安装包的内置指纹；查不到返回空（此时退化为只信清单） */
  function pinnedSha(name) {
    if (!name) return '';
    var s = PINNED_SHA[String(name)];
    return s ? String(s).trim().toLowerCase() : '';
  }

  /* 前两位变化 = 强制更新（见上面 pack 里的 force 判定），只有第三位是可选的 */
  var LEVEL_TEXT = {
    major: '大版本更新，安装后才能继续使用',
    minor: '功能更新，安装后才能继续使用',
    patch: '修复更新，可以稍后再装',
    // 版本号没变、但包换了。说成「有新内容」太含糊，用户会以为是同一个包
    // 在反复提醒；这里直接讲明白是「同版本号下的包被重新发布过」。
    content: '这个安装包已更新，可以稍后再装'
  };

  /* ---------- 版本号解析 ---------- */

  /**
   * 解析成 {major, minor, patch}。
   * 'v1.2.3' / '1.2.3' -> {1,2,3}；老代号 'V3' -> {0,0,3}，
   * 这样从代号版升到正规三段号时会被判成大版本变化（强制更新），符合预期。
   */
  function parse(v) {
    var s = String(v == null ? '' : v).trim();
    var m = s.match(/(\d+)\.(\d+)\.(\d+)/);
    if (m) return { major: +m[1], minor: +m[2], patch: +m[3] };
    m = s.match(/(\d+)/);
    return m ? { major: 0, minor: 0, patch: +m[1] } : { major: 0, minor: 0, patch: 0 };
  }

  /** 版本号大小：a > b 返回 1，a < b 返回 -1，相等返回 0 */
  function cmp(a, b) {
    var x = parse(a), y = parse(b);
    var ka = [x.major, x.minor, x.patch], kb = [y.major, y.minor, y.patch];
    for (var i = 0; i < 3; i++) {
      if (ka[i] > kb[i]) return 1;
      if (ka[i] < kb[i]) return -1;
    }
    return 0;
  }

  /**
   * 从 cur 到 next 是哪一级别的更新。
   * @return null（无需更新 / 无法比较）| 'major'（强制）| 'minor'（强制）| 'patch'（可选）
   */
  function diffLevel(cur, next) {
    if (!cur || !next) return null;         // 任一版本号读不到：判定为「无法比较」，不打扰用户
    if (!/\d+\.\d+\.\d+/.test(String(cur))) return null;
    if (cmp(next, cur) <= 0) return null;   // 没更新 / 服务端版本更旧：不打扰
    var a = parse(cur), b = parse(next);
    if (b.major > a.major) return 'major';
    if (b.minor > a.minor) return 'minor';
    return 'patch';
  }

  /* ---------- 数据来源 ---------- */

  /**
   * 当前版本号。两处来源依次尝试：
   *   1. window.Native.appVersion()（原生 BuildConfig.VERSION_NAME）
   *   2. window.API.appVersion()（同源，但兼容旧版本的前端封装）
   * 都拿不到就返回空串。空串在 diffLevel 里会被判定为「无法比较」而静默跳过，
   * 绝不会编造 0.0.0 之类的假版本号 —— 那会让更新检测误报大版本升级。
   */
  function current() {
    var v = '';
    try {
      if (window.Native && typeof window.Native.appVersion === 'function') {
        v = String(window.Native.appVersion() || '').trim();
      }
    } catch (e) {}
    if (!v) {
      try {
        if (window.API && typeof window.API.appVersion === 'function') {
          v = String(window.API.appVersion() || '').trim();
        }
      } catch (e) {}
    }
    return v;
  }

  /** 从 Release 资产里挑出 APK：优先正式包名，退而求其次取第一个 .apk */
  function pickApk(assets) {
    var list = assets || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a) continue;
      if (/\.apk$/i.test(a.name || '') || /android\.package-archive/i.test(a.content_type || '')) return a;
    }
    return null;
  }

  function fmtSize(n) {
    n = +n || 0;
    if (n <= 0) return '';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  /** 打包成统一的检查结果 */
  function pack(cur, latest, level, extra) {
    var info = {
      ok: true, current: cur, latest: latest, level: level,
      hasUpdate: !!level,
      // 前两位（大版本 / 功能更新）都要强制，只有第三位（修复）是可选的。
      // 内容更新（版本号没变、包换了）单独在 check() 里置为可选。
      force: level === 'major' || level === 'minor'
    };
    for (var k in extra) if (extra.hasOwnProperty(k)) info[k] = extra[k];
    return info;
  }

  /**
   * 本机安装包的指纹（SHA-256）。
   * 版本号冻结不变、但包里内容已经换掉的情况下，靠它才能发现「其实是新包」。
   * 读不到就返回空串 —— 前端据此跳过指纹比对，不当成错误。
   */
  function localSha() {
    var v = '';
    try {
      if (window.Native && typeof window.Native.apkSha256 === 'function') {
        v = String(window.Native.apkSha256() || '');
      }
    } catch (e) {}
    return v ? v.trim().toLowerCase() : '';
  }

  function b64(s) {
    try {
      return decodeURIComponent(escape(window.atob(String(s).replace(/\s/g, ''))));
    } catch (e) {
      try { return window.atob(String(s).replace(/\s/g, '')); } catch (e2) { return ''; }
    }
  }

  /** 来源一：最新正式版 Release */
  function fromRelease(cur) {
    return window.API.get('/repos/' + OWNER + '/' + REPO + '/releases/latest').then(function (r) {
      if (!r || r.status >= 400 || !r.data) {
        return { ok: false, current: cur, reason: r && r.status === 404 ? 'no-release' : 'failed' };
      }
      var d = r.data;
      if (d.draft || d.prerelease) return { ok: false, current: cur, reason: 'no-release' };
      var latest = String(d.tag_name || d.name || '').replace(/^[Vv]/, '');
      var asset = pickApk(d.assets);
      if (!asset) return { ok: false, current: cur, reason: 'no-release' };
      /*
        期望指纹第一优先级：GitHub 给每个附件算的 digest（"sha256:xxx"）。
        它在服务端跟着附件走 —— 附件换了它就换，永远同步。以前期望值来自
        version.json 清单，一旦发了包却忘了改清单，好包就会被当成「被篡改」
        拦下来（真实发生过：同版本号重发布后全员装不上）。digest 拿不到
        （老资产没有这个字段）才退回内置表 / version.json。
      */
      var dg = String(asset.digest || '').toLowerCase().trim();
      if (dg.slice(0, 7) === 'sha256:') dg = dg.slice(7).trim();
      if (!/^[0-9a-f]{64}$/.test(dg)) dg = '';
      return pack(cur, latest, diffLevel(cur, latest), {
        source: 'release', asset: asset, name: d.name || latest,
        notes: d.body || '', url: d.html_url || '', published: d.published_at || '',
        size: fmtSize(asset.size),
        // digestSha：纯粹的附件服务端指纹（check() 里与内置表、清单分开比对）
        digestSha: dg,
        // sha256：兼容旧调用方的期望值（digest > 内置表）
        sha256: dg || pinnedSha(asset.name)
      });
    }).catch(function (e) {
      return { ok: false, current: cur, reason: 'failed', error: e };
    });
  }

  /** 来源二：仓库里的 version.json（没有 Release 时的备用通道） */
  function fromManifest(cur) {
    var p = '/repos/' + OWNER + '/' + REPO + '/contents/' + MANIFEST + '?ref=main';
    return window.API.get(p).then(function (r) {
      if (!r || r.status >= 400 || !r.data || !r.data.content) {
        return { ok: false, current: cur, reason: 'no-release' };
      }
      var m;
      try { m = JSON.parse(b64(r.data.content)); }
      catch (e) { return { ok: false, current: cur, reason: 'failed' }; }
      if (!m || !m.version) return { ok: false, current: cur, reason: 'no-release' };
      var latest = String(m.version).replace(/^[Vv]/, '');
      var apkPath = String(m.apk || ('apk/githup-' + latest + '.apk'));
      // apk 字段可以是「仓库内的相对路径」，也可以是完整的 http(s) 直链。
      // 安装包不再提交进仓库（只作为 Release 附件发布），所以这里优先写直链；
      // 相对路径仍然支持，方便老清单继续工作。
      var isAbs = /^https?:\/\//i.test(apkPath);
      var dl = isAbs ? apkPath : (RAW_BASE + '/' + apkPath.replace(/^\/+/, ''));
      return pack(cur, latest, diffLevel(cur, latest), {
        source: 'manifest', name: m.name || latest,
        asset: { name: apkPath.split('/').pop(), browser_download_url: dl },
        notes: m.notes || '', url: 'https://github.com/' + OWNER + '/' + REPO + '/releases',
        published: m.published || '', size: fmtSize(m.size),
        sha256: String(m.sha256 || '').trim().toLowerCase()
      });
    }).catch(function (e) {
      return { ok: false, current: cur, reason: 'failed', error: e };
    });
  }

  /**
   * 拉取最新版本信息，并判断要不要更新。
   *
   * 两条信号，命中任意一条就算「有新版本」：
   *   1. 版本号变大      —— 按 x.y.z 规则决定是强制还是可选
   *   2. 安装包内容变了  —— 版本号完全相同、但校验和不一致，说明是重新打的包
   *
   * 第 2 条是关键：版本号可以冻结不动（比如一直是 1.1.1），
   * 但只要包里的内容换了，用户打开软件照样能收到更新提示。
   *
   * 数据来源：Release 负责 APK 附件与说明，version.json 负责校验和，两者并行请求。
   */
  function check() {
    var cur = current();
    return Promise.all([fromRelease(cur), fromManifest(cur)]).then(function (pair) {
      var rel = pair[0], man = pair[1];

      // 选一个作为主结果：Release 优先（它的 APK 是正式附件），拿不到就用清单
      var info = rel.ok ? rel : (man.ok ? man : rel);
      if (!info.ok) return info;                    // 两条路都没数据

      /* 三路期望指纹分开存，别混进同一个字段 ——
       *   digest   ：Release 附件的服务端指纹（最可信，跟附件天然同步）
       *   pinned   ：编译进 APK 的内置表（查不到为空）
       *   listed   ：version.json 清单值（发布流水线自动回写）
       * 以前它们都挤在 sha256 里，install() 的交叉比对永远比的是自己和自己，
       * 内置表与清单不一致这种「有一方被动过」的情况根本发现不了。 */
      var digest = rel.ok ? String(rel.sha256 || '') : '';
      var pinned = rel.ok ? pinnedSha(rel.asset && rel.asset.name) : '';
      var listed = (man.ok ? man.sha256 : '') || '';
      var expect = digest || pinned || listed;
      var mine = localSha();

      var byVersion = info.level;                   // 版本号比对的结果
      var byContent = null;
      if (mine && expect && mine !== expect) {
        byContent = 'content';                      // 版本号没变，但包不一样
      }

      if (!byVersion && byContent) {
        // 只是内容变了 —— 属于可选更新，给「立即更新 / 稍后提醒 / 跳过此版」
        info.level = 'content';
        info.hasUpdate = true;
        info.force = false;
        info.fromContent = true;
      }
      info.sha256 = expect;       // 期望值（install 时交给原生去比）
      info.expectDigest = digest; // 三路来源分开带上，install 里做交叉比对
      info.listedSha = listed;
      info.localSha = mine;
      return info;
    });
  }

  /* ---------- 下载安装 ---------- */

  /**
   * 下载 APK 并拉起系统安装器。
   *
   * 关键：装之前必须验指纹。HTTPS 只保证「传输路上没被人改」，不保证
   * 「服务端给的包就是对的」—— Release 资产或仓库被替换时用户就会装上
   * 假包。期望的 SHA-256 一起交给原生层，原生下载完先算哈希比对，一致才
   * 拉起安装器；不一致直接删除并提示 —— 装不上，总比装错强。
   *
   * 期望指纹的优先级（取第一个非空的）：
   *   1. Release 附件的 digest —— GitHub 服务端算的，跟附件天然同步（最可信）
   *   2. 内置指纹表 —— 编译进 APK，改不动
   *   3. version.json 清单 —— 兜底；发布流水线会自动回写它
   * 内置表与清单同时存在却不一致时仍然拒绝：说明有一方被动过了。
   */
  function install(info) {
    var a = info && info.asset;
    if (!a) {
      if (window.UI) window.UI.toast('这个版本没有附带 APK，已打开下载页');
      if (info && info.url) openOut(info.url);
      return false;
    }

    // ---- 确定期望指纹（digest > 内置表 > 清单；内置表与清单冲突则拒绝）----
    var pinned = pinnedSha(a.name);
    var digest = String((info && info.expectDigest) || '').trim().toLowerCase();
    var listed = String((info && info.listedSha) || '').trim().toLowerCase();

    if (pinned && listed && pinned !== listed) {
      // 内置的和清单对不上 —— 有一方被改了，直接拒绝
      if (window.UI) window.UI.toast('安装包校验信息不一致，已阻止安装');
      return false;
    }
    var expect = digest || pinned || listed;

    if (!expect) {
      // 拿不到任何指纹：不开这个口子，让用户走官方 Release 页面手动装
      if (window.UI) window.UI.toast('缺少校验信息，已打开官方下载页');
      openOut(info.url || a.browser_download_url);
      return false;
    }

    if (window.NativeBridge && typeof NativeBridge.installApkChecked === 'function') {
      try {
        // 自更新包来自 Release：第 5 个参数传 release，落 githup/release
        NativeBridge.installApkChecked(a.browser_download_url, a.name,
          JSON.stringify({ Accept: 'application/vnd.android.package-archive' }), expect, 'release');
        window.UI.toast('正在下载并校验 ' + a.name);
        return true;
      } catch (e) { /* 落到下面 */ }
    }

    // 老版本原生层没有校验能力：宁可不自动装，也不能装个没法验的包。
    // 统一走 openOut，保证这种情况下也一定有个出口，不会点了没反应。
    if (window.UI) window.UI.toast('当前版本不支持安全校验，已打开官方下载页');
    openOut(info.url || a.browser_download_url);
    return false;
  }

  function openOut(url) {
    if (!url) return;
    if (window.NativeBridge && NativeBridge.openExternal) NativeBridge.openExternal(url);
    else window.open(url, '_blank');
  }

  /* ---------- 界面 ---------- */

  function notesHtml(notes) {
    var s = String(notes || '').trim();
    if (!s) return '<div class="muted tiny" style="padding:0 2px">这个版本没有写更新说明。</div>';
    if (window.MD && typeof MD.render === 'function') {
      try { return '<div class="md" style="font-size:14px">' + MD.render(s) + '</div>'; } catch (e) { /* 退化 */ }
    }
    return '<div style="font-size:13px;line-height:1.7;white-space:pre-wrap">' + esc(s) + '</div>';
  }

  /**
   * 弹出更新提示。
   * @param info  check() 的结果
   * @param opt   { onDone:function } 关闭后回调
   */
  function prompt(info, opt) {
    opt = opt || {};
    if (!info || !info.hasUpdate) return;
    var UI = window.UI;
    var force = !!info.force;
    var byContent = !!info.fromContent;   // 版本号没变，只是包里的内容换了
    /*
      标题按两种情况分开写。

      内容更新（版本号没变、包换了）以前也叫「有新内容可用」—— 用户看完
      一脸问号：「我装的就是 1.1.4，怎么又 1.1.4？」直说「这个安装包更新了」
      才是他在经历的事。
    */
    var head = force ? '必须更新才能继续使用'
                     : (byContent ? '这个安装包已更新' : '发现新版本 ' + info.latest);

    UI.sheet({
      title: head,
      icon: force ? 'rocket' : 'sync',
      dismissible: !force,        // 强制更新时不给关闭按钮、点遮罩无效
      body:
        '<div class="center" style="padding:4px 0 2px">' +
          '<div style="display:flex;justify-content:center;color:var(--fg)">' + window.icon(force ? 'rocket' : 'package', 40) + '</div>' +
          '<div style="font-size:17px;font-weight:600;margin-top:10px">' + esc(info.latest) + '</div>' +
          '<div class="muted tiny" style="margin-top:4px">当前 ' + esc(info.current) +
            (info.size ? ' · APK ' + esc(info.size) : '') +
            (info.published ? ' · ' + esc(fmtDate(info.published)) : '') + '</div>' +
          /*
            内容更新时版本号两边一模一样，光看数字分不出差别。把两份包的
            指纹前 8 位摆出来，用户（和排查问题的人）一眼能确认确实是两份不同的包。
          */
          (byContent && (info.sha256 || info.localSha)
            ? '<div class="muted tiny" style="margin-top:2px;font-family:monospace">' +
                '服务器 ' + esc(String(info.sha256 || '').slice(0, 8)) +
                ' · 本机 ' + esc(String(info.localSha || '').slice(0, 8)) + '</div>'
            : '') +
        '</div>' +
        '<div class="card" style="margin-top:14px;padding:12px">' +
          '<div style="font-weight:600;margin-bottom:8px;font-size:14px">' + esc(LEVEL_TEXT[info.level] || '有新版本') + '</div>' +
          '<div class="muted" style="font-size:13px;line-height:1.6;margin-bottom:10px">' +
            (force
              ? '第' + (info.level === 'major' ? '一' : '二') + '位版本号从 ' +
                esc(parse(info.current).major + '.' + parse(info.current).minor) + ' 升到了 ' +
                esc(parse(info.latest).major + '.' + parse(info.latest).minor) +
                '，属于必须安装的' + (info.level === 'major' ? '大版本' : '功能更新') + ' —— 装好才能继续使用。'
              : byContent
                ? '你装的这个包和服务器上的不是同一份 —— 版本号同为 ' + esc(info.latest) +
                  '，但校验和对不上，说明这个版本号下的安装包被重新发布过（通常是又修了一点东西）。' +
                  '装上去就是最新那份；也可以留在当前版本，不影响使用。'
                : '这一版只改了第三位版本号（修复更新），不影响使用 —— 你可以现在装，也可以留在当前版本。') +
          '</div>' +
          '<div style="border-top:1px solid var(--border-muted);padding-top:10px">' + notesHtml(info.notes) + '</div>' +
        '</div>',
      foot: force
        ? '<button class="btn primary" data-up>立即更新</button>'
        : '<button class="btn" data-skip>跳过此版</button><button class="btn" data-later>稍后提醒</button><button class="btn primary" data-up>立即更新</button>',
      onMount: function (body, close) {
        var root = document.getElementById('sheet-root');
        UI.$('[data-up]', root).onclick = function () {
          var started = install(info);
          /*
            只有**真的开始下载**了才记这一笔。

            install() 返回 false 的三种情况（没有 APK 附件 / 内置表与清单冲突 /
            拿不到任何指纹）都会退化成「打开官方下载页」，那不算「正在装」——
            记了就会把后续提醒一起压住，用户反而收不到更新了。

            强制更新也照记不误：它的弹层本来就不带这些路径，
            记一笔能让「装完之前」不再反复拦人。
          */
          if (started) markUpdating(info);
          close();
          if (opt.onDone) opt.onDone('update');
        };
        var later = UI.$('[data-later]', root);
        if (later) later.onclick = function () { close(); if (opt.onDone) opt.onDone('later'); };
        var skip = UI.$('[data-skip]', root);
        if (skip) skip.onclick = function () {
          // 内容更新时版本号没变，只能按指纹记录跳过；否则版本号一样会永久屏蔽后续更新
          if (info.fromContent && info.sha256) {
            window.Store.set(SKIP_SHA_KEY, info.sha256);
            UI.toast('已跳过这个包，下次换内容时仍会提醒');
          } else {
            window.Store.set(SKIP_KEY, info.latest);
            UI.toast('已跳过 ' + info.latest + '，改前两位版本号时仍会强制提醒');
          }
          close();
          if (opt.onDone) opt.onDone('skip');
        };
      }
    });
  }

  /**
   * 「您已是最新版本」提示（只有手动点检查更新才出现，启动时静默不打扰）。
   *
   * 用小浮条而不是弹层：贴在底部正中间，两三秒自己消失，
   * 期间照常能点页面上的东西，不打断你正在做的事。
   */
  function upToDateToast(info) {
    var msg = '您已是最新版本' + (info && info.current ? '（当前 ' + info.current + '）' : '');
    if (window.UI.toastOk) window.UI.toastOk(msg, 2600);
    else window.UI.toast(msg, 2600);
  }

  /** 手动检查（设置页入口）：无论有没有更新都要给出明确反馈 */
  function manualCheck() {
    var UI = window.UI;
    UI.loading(true);
    return check().then(function (info) {
      UI.loading(false);
      if (!info.ok) {
        UI.toast(info.reason === 'no-release' ? '还没有发布正式版本' : '检查更新失败，请稍后再试');
        return info;
      }
      if (!info.hasUpdate) { upToDateToast(info); return info; }
      prompt(info);
      return info;
    });
  }

  /**
   * 打开软件时的自动检查（每次打开都会执行，不等、不节流）。
   *
   * 三条规则：
   *   - **已是最新版本 → 什么都不做**，不弹窗、不提示，跟没检查过一样。
   *   - **有更新 → 按版本号规则处理**：第一、二位变化弹不可关闭的强制更新，
   *     第三位变化给「立即更新 / 稍后提醒 / 跳过此版」。
   *   - **拿不到数据（断网 / 没有 Release / 版本号读不到）→ 静默**，
   *     失败原因只在手动检查时才告诉用户。
   *
   * 「跳过此版」记下来的版本不再重复提示（内容更新则记指纹），但强制更新永远会拦 ——
   * 也就是第一、二位变化时不认「跳过」，仍会弹。
   *
   * 同理，点过「立即更新」的那一份在装上之前也不再重复弹（见 pendingInstall）——
   * 可选更新的期望指纹来自服务端，本机指纹要等新包真装上才变，
   * 中间这段空窗期不压住，就会「点了立即更新还一直弹」。
   *
   * 注意：这里没有「几小时内不重复检查」的限制 —— 每次打开都真的去查，
   * 只有同一毫秒级的重复触发（同一次会话里多个触发点）才会合并成一次请求。
   */
  /**
   * 这个更新是不是已经被用户跳过过了（版本号 / 指纹两种记法都要查）。
   *
   * 只比「这一个包」，不比版本号笼统地封 —— 见 suppressed() 里对 UPD_KEY 的处理。
   */
  function skipped(info) {
    if (window.Store.get(SKIP_KEY) === info.latest) return true;
    if (info.fromContent && info.sha256 && window.Store.get(SKIP_SHA_KEY) === info.sha256) return true;
    return false;
  }

  /**
   * 用户点过「立即更新」的那个包 —— 记成「正在装」。
   *
   * 为什么必须有这个东西：
   *   可选更新（第三位版本号变化 / 内容变化）的期望指纹来自**服务端**，
   *   而「本机指纹」要等新包真正装上、`apkSha256()` 读到新的 sourceDir 才会变。
   *   中间这段空窗期（下载、等系统安装器、用户还没确认安装）里，
   *   只要再触发一次自动检查（切回前台 / 重新打开），
   *   比对结果必然还是「不一致」，于是同一个更新被一遍又一遍地弹出来 ——
   *   用户看到的就是「我都点了立即更新，怎么还不停地弹」。
   *
   *   记下用过的那条期望指纹，就是在告诉检查逻辑：这一份我已经在处理了，
   *   在你装上之前别再提醒。
   *
   * 为什么这里能安全地按指纹长期忽略：
   *   指纹 = 「是哪一个包」。同一个包不会装两遍，所以忽略它没有代价。
   *   而版本号是「哪一代」，同一代可能被重新打包成不同的包 —— 那是一个
   *   全新的包，指纹对不上，照常会提醒。
   *
   * 什么情况下这条记录会失效（都会被重新提醒）：
   *   - 换了新包重新发布：指纹不同
   *   - 装上了更新的包、本机指纹追平：不再需要提醒
   *   - 用户卸载重装、或清了应用数据：记录随之消失
   *   - 第一、二位版本号变化（强制更新）：压根不看这条记录
   *   - **超过 UPD_TTL 还没装上**：认定上次尝试已经结束，不再压着 ——
   *     这条是后来补的，见 UPD_TTL 上方那段说明
   */
  function pendingInstall(info) {
    var e = String((info && info.sha256) || '').trim().toLowerCase();
    var m = String(window.Store.get(MINE_KEY) || '').trim().toLowerCase();
    var loc = String((info && info.localSha) || '').trim().toLowerCase();

    /*
      本机已经不是当初那个包了 —— 说明更新装上了。
      这种情况下把记录直接清掉，而不是只返回空：清掉之后下次进来
      不会再被这条陈旧记录干扰，状态也干净。
    */
    if (m && m !== loc) {
      window.Store.set(UPD_KEY, '');
      window.Store.set(MINE_KEY, '');
      window.Store.set(UPD_AT_KEY, '');
      return '';
    }

    /*
      过了有效期就当它没记过 —— 这是修「点一次立即更新没装成、
      从此再也不提醒」的关键。记一笔只在「正在装」这段时间内有效。
    */
    var at = +window.Store.get(UPD_AT_KEY) || 0;
    if (!at || Date.now() - at > UPD_TTL) return '';

    /* 本机已经不是当初那个包了 —— 说明更新装上了，这条记录该退休 */
    if (m && m !== String((info && info.localSha) || '').trim().toLowerCase()) return '';
    return e;
  }

  /** 这个更新要不要压住不弹（跳过 / 已经点过立即更新且还没装上） */
  function suppressed(info) {
    if (skipped(info)) return true;
    var p = pendingInstall(info);
    if (p && String(window.Store.get(UPD_KEY) || '').trim().toLowerCase() === p) return true;
    return false;
  }

  /**
   * 记下「我已经在装这一份了」。
   * 期望指纹优先用服务端 digest —— 它才是再次检查时真正会拿来比对的那个值。
   */
  function markUpdating(info) {
    var e = String((info && (info.expectDigest || info.sha256)) || '').trim().toLowerCase();
    if (!e) return;
    window.Store.set(UPD_KEY, e);
    window.Store.set(MINE_KEY, String((info && info.localSha) || '').trim().toLowerCase());
    // 时间戳是这条记录能「过期」的前提，必须一起写
    window.Store.set(UPD_AT_KEY, Date.now());
  }

  var pending = null;                    // 进行中的请求，用来合并重复触发
  var lastStamp = 0;                     // 上次发起请求的时间，防止同一次会话重复打服务端

  /**
   * 撤回「我正在装这一份」这条记录。
   *
   * 两个调用方：
   *   1. 原生侧下载失败 / 校验不过时推过来的回执（notifyUpdateAborted）——
   *      这是主要来源，能让用户在**下次打开**就重新收到提醒，不用干等；
   *   2. 前端自己发现装好了（pendingInstall 里本机指纹追平）。
   *
   * 为什么必须存在：那条记录是**按下按钮时**就写下的，可按下不等于装上 ——
   * 下载可能失败、包可能校验不过。不撤回的话，用户明明没装成，
   * 之后却再也收不到这个更新了。
   */
  function clearUpdating(why) {
    window.Store.set(UPD_KEY, '');
    window.Store.set(MINE_KEY, '');
    window.Store.set(UPD_AT_KEY, '');
    // 撤回之后允许立刻重查一次，不用等 resumeCheck 的 30 分钟门槛
    lastStamp = 0;
    if (+window.Store.get(LAST_KEY) || 0) window.Store.set(LAST_KEY, 0);
    if (why && window.console && console.info) {
      console.info('[updater] 上一次自动更新没有装成，已恢复提醒：' + why);
    }
  }

  function autoCheck() {
    // 同一会话里极短时间内重复触发（间隔 < 3 秒）复用上一次的结果，不重复请求
    if (pending) return pending;
    if (Date.now() - lastStamp < 3000 && lastStamp) return Promise.resolve(null);

    lastStamp = Date.now();
    pending = check().then(function (info) {
      pending = null;
      if (!info.ok || !info.hasUpdate) return info;   // 已是最新 / 拿不到数据：什么都不做
      /*
        强制更新（第一、二位变化）不看这些 —— 不装不让用，跳过和「正在装」
        都不能作为不提醒的理由。可选更新才受理「跳过」和「已经点过立即更新」。
      */
      if (!info.force && suppressed(info)) return info;
      prompt(info);
      return info;
    }).catch(function (e) {
      pending = null;
      return { ok: false, reason: 'failed', error: e };   // 异常也保持静默
    });
    return pending;
  }

  /** 打开软件的入口：立即检查，不延迟、不等界面渲染完 */
  function startCheck() {
    return Promise.resolve(autoCheck());
  }

  /** 回到前台时再查一次（切后台超过 30 分钟才算重新「打开」） */
  function resumeCheck() {
    var last = +window.Store.get(LAST_KEY) || 0;
    if (Date.now() - last < 30 * 60 * 1000) return Promise.resolve(null);
    window.Store.set(LAST_KEY, Date.now());
    lastStamp = 0;                       // 放行本次请求（上面的 3 秒合并仅限同一时刻）
    return autoCheck();
  }

  window.Updater = {
    OWNER: OWNER, REPO: REPO,
    parse: parse, cmp: cmp, diffLevel: diffLevel,
    current: current, check: check, fromRelease: fromRelease, fromManifest: fromManifest,
    prompt: prompt, manualCheck: manualCheck, autoCheck: autoCheck,
    startCheck: startCheck, resumeCheck: resumeCheck,
    markUpdating: markUpdating, suppressed: suppressed, skipped: skipped, pendingInstall: pendingInstall,
    upToDateToast: upToDateToast, install: install, pinnedSha: pinnedSha, PINNED_SHA: PINNED_SHA,
    clearUpdating: clearUpdating, UPD_TTL: UPD_TTL
  };
})();
