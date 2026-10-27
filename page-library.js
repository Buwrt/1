/* ============================================================
 * page-library.js — 应用库
 *
 * 一张「本机应用 ↔ GitHub 仓库 ↔ Release」的台账。
 *
 * 分工（跟项目一贯的架构一致）：
 *   原生层（AppLibrary.java）：SQLite 台账读写、读系统里的真实版本与
 *     签名指纹、拉起 / 卸载 —— 这些 Web 干不了。
 *   前端（本文件）：发 GitHub 请求、比对新旧、画界面 —— 网络层完全
 *     复用 api.js，令牌注入和加速通道一处没动。
 *
 * 三段分组：待安装 / 有更新 / 已是最新。同一仓库下的多个应用合并成
 * 一张组卡（owner/repo 抬头 + 若干行），避免同一个仓库重复出现好几张。
 *
 * 每行：图标、名称、owner、状态行、非默认设置的标签、进度条、
 * 尾部操作（一个主操作 + 一个「更多」菜单）。
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});
  var NB = window.NativeBridge;

  var CTX = {
    items: [],
    query: '',
    sort: window.Store ? window.Store.get('lib_sort', 'updates') : 'updates',
    expanded: { pending: true, updates: true, idle: true }
  };

  function has() {
    return !!(NB && typeof NB.libList === 'function');
  }

  function load() {
    if (!has()) return Promise.resolve([]);
    try {
      return Promise.resolve(JSON.parse(NB.libList() || '[]'));
    } catch (e) {
      return Promise.resolve([]);
    }
  }

  /* ---------- 版本 ---------- */

  /**
   * 版本号归一成可比较的数字：x.y.z -> x*1000000 + y*1000 + z。
   * 解析不出来返回 0 —— 0 表示「认不出来」，不是「很小」，
   * 调用方必须特殊处理，否则会把「认不出来」误判成「有更新」。
   */
  function codeOf(tag) {
    var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(tag || ''));
    if (!m) return 0;
    return (+m[1]) * 1000000 + (+m[2]) * 1000 + (+m[3]);
  }

  /* ---------- 挑 asset ---------- */

  var ABI = '';
  function abi() {
    if (ABI) return ABI;
    try { ABI = (NB && NB.libAbi && NB.libAbi()) || ''; } catch (e) { ABI = ''; }
    return ABI;
  }

  function abiKeys() {
    var a = abi().toLowerCase();
    if (a.indexOf('arm64') >= 0 || a.indexOf('v8a') >= 0) return ['arm64', 'v8a', 'aarch64'];
    if (a.indexOf('arm') >= 0 || a.indexOf('v7a') >= 0) return ['armeabi-v7a', 'v7a', 'arm32'];
    if (a.indexOf('x86_64') >= 0) return ['x86_64'];
    if (a.indexOf('x86') >= 0) return ['x86'];
    return [];
  }

  function apkOnly(list) {
    return list.filter(function (a) {
      var n = (a.name || '').toLowerCase();
      if (!/\.apk$/i.test(n)) return false;
      // 校验文件、签名块不是安装包
      return !/\.(sha256|sha1|md5|sig|asc|pem|json)$/i.test(n);
    });
  }

  /**
   * 从一堆附件里挑出该装的那个。
   *
   * 一个 Release 常常挂好几个 APK（arm64 / armv7 × foss / premium），
   * 光按体积挑最大的是错的。优先级：钉住的变体 > 设备 ABI > universal > 体积。
   */
  /* ── 变体指纹 ──
     一个仓库发多个包名（foss / premium、A / B、arm64 / armv7）是常态。
     光按体积挑最大的，就会「点 A 的更新，下载并装上 B」——
     用户看到的就是「我装的是 A，怎么绑成 B 了」。

     所以从「这一行实际装的那个 asset 名」里提取身份特征，
     挑更新时要求候选**必须带有全部这些特征**。 */
  var GENERIC = { apk: 1, signed: 1, unsigned: 1, release: 1, debug: 1, app: 1, android: 1 };
  var ARCH = { arm64: 1, v8a: 1, aarch64: 1, arm: 1, v7a: 1, armeabi: 1, arm32: 1,
    x86: 1, x86_64: 1, universal: 1, noarch: 1, all: 1 };

  function isVersionToken(t) {
    return /^v?\d+(\.\d+)*$/.test(t) || /^\d+[a-z]$/.test(t) || /^(beta|alpha|rc)\d*$/.test(t);
  }

  /** 把 asset 名拆成身份 token：去掉版本号、扩展名和通用词。 */
  function tokensOf(name) {
    return String(name || '').toLowerCase()
      .replace(/\.apk$/i, '')
      .split(/[^a-z0-9]+/i)
      .filter(function (t) {
        return t && t.length > 1 && !GENERIC[t] && !isVersionToken(t);
      });
  }

  /** 必需特征：全部命中才算「同一个应用」。arch 单独留一份，用于放宽。 */
  function identityOf(name) {
    var ts = tokensOf(name);
    return { core: ts.filter(function (t) { return !ARCH[t]; }), arch: ts.filter(function (t) { return ARCH[t]; }) };
  }

  function hasAll(name, need) {
    var ts = tokensOf(name);
    var set = Object.create(null);
    ts.forEach(function (t) { set[t] = 1; });
    for (var i = 0; i < need.length; i++) if (!set[need[i]]) return false;
    return true;
  }

  function pickAsset(rel, it) {
    var all = apkOnly((rel && rel.assets) || []);
    if (!all.length) return null;
    var list = all;

    var regex = it && it.asset_regex;
    if (regex) {
      try {
        var re = new RegExp(regex, 'i');
        var filtered = list.filter(function (a) { return re.test(a.name); });
        if (filtered.length) list = filtered;
      } catch (e) { /* 正则写错就当没设 */ }
    }

    var pin = it && it.pinned_variant;
    var keys = abiKeys();

    /* 身份优先：这一行装的是谁，就只能更新成谁。 */
    var mine = it && (it.asset || it.latest_asset);
    if (mine && !pin) {
      var id = identityOf(mine);
      var need = id.core.concat(id.arch);
      var strict = list.filter(function (a) { return hasAll(a.name, need); });
      if (!strict.length && id.arch.length) {
        // 新版可能不再分包（只留 universal）：放宽架构，但身份词一个不能少
        strict = list.filter(function (a) { return hasAll(a.name, id.core); });
      }
      if (!strict.length && all.length === 1) strict = all;   // 只有一份，没得挑
      if (strict.length) list = strict;
      /* ⚠️ 一个都没匹配上就**不让挑** —— 宁可提示「这一版没有匹配的包」，
         也不能把 B 装到 A 的头上。返回 null 由调用方给出明确提示。 */
      else if (id.core.length) return null;
    }

    function score(a) {
      var n = (a.name || '').toLowerCase();
      if (pin) return n.indexOf(pin.toLowerCase()) >= 0 ? 200 : -1;
      for (var i = 0; i < keys.length; i++) if (n.indexOf(keys[i]) >= 0) return 100 - i;
      if (n.indexOf('universal') >= 0 || n.indexOf('noarch') >= 0) return 50;
      return 0;
    }

    list = list.slice().sort(function (a, b) {
      var d = score(b) - score(a);
      return d !== 0 ? d : (b.size || 0) - (a.size || 0);
    });
    return list[0] || null;
  }

  /** 变体选项：把当前 release 里的 APK 列出来给用户钉。 */
  function variantOptions(rel) {
    var seen = Object.create(null);
    return apkOnly((rel && rel.assets) || []).map(function (a) {
      var n = a.name.replace(/\.apk$/i, '');
      // 去掉版本号尾巴，剩下的就是变体标识
      var m = n.replace(/[-_](v?\d+(\.\d+){0,3})$/i, '');
      var key = m || n;
      if (seen[key]) return null;
      seen[key] = 1;
      return { key: key, name: a.name, size: a.size || 0 };
    }).filter(Boolean);
  }

  /* ---------- 更新检查 ---------- */

  /**
   * 取某个 release（默认最新正式版；收预发布时取列表第一个）。
   *
   * ⚠️ 请求由前端发，走 api.js：令牌注入、加速通道、限流兜底全部复用，
   * 不重复造一遍网络层。cache:0 —— 检查更新必须真发一次，不能吃缓存。
   */
  function fetchRelease(it, opts) {
    opts = opts || {};
    var path = '/repos/' + it.owner + '/' + it.repo + '/releases';
    if (it.preRelease) {
      return window.API.get(path, { per_page: 5 }, { cache: 0 }).then(function (res) {
        var list = (res && res.data) || [];
        for (var i = 0; i < list.length; i++) {
          var a = pickAsset(list[i], it);
          if (a) return { rel: list[i], asset: a };
        }
        return null;
      });
    }
    return window.API.get(path + '/latest', null, { cache: 0 }).then(function (res) {
      var rel = res && res.data;
      var a = pickAsset(rel, it);
      return a ? { rel: rel, asset: a } : null;
    });
  }

  /**
   * 查一个应用的更新。
   *
   * 「存储匹配优先」：更新和重新下载都从上一次存在行里的 release + asset
   * 出发，只有没存过、或用存过的匹配下载失败过，才真的去请求 GitHub。
   * 这是能管几十个应用还不被限流的关键。
   */
  function checkOne(it, force) {
    if (!it || !it.owner || !it.repo) return Promise.resolve(false);
    var stored = it.latest_tag && it.latest_asset && it.latest_url;
    if (stored && !force && !(it.pendingFailed > 0)) {
      return Promise.resolve(true);   // 存过的直接用，不发请求
    }
    return fetchRelease(it).then(function (r) {
      if (!r) {
        NB.libNotePendingFailure && NB.libNotePendingFailure(it.pkg);
        return false;
      }
      NB.libSetLatest(it.pkg, JSON.stringify({
        tag: r.rel.tag_name || '',
        vName: r.rel.name || r.rel.tag_name || '',
        vCode: codeOf(r.rel.tag_name),
        asset: r.asset.name,
        url: r.asset.browser_download_url,
        size: r.asset.size || 0,
        notes: (r.rel.body || '').slice(0, 400)
      }));
      return true;
    }, function () {
      return false;   // 单个失败不打断整批
    });
  }

  function checkAll() {
    var targets = CTX.items.filter(function (it) { return !it.ignoreUpdate && !it.pending; });
    if (!targets.length) { UI.toast('没有需要检查的应用'); return Promise.resolve(); }
    UI.loading(true);
    var i = 0, done = 0;
    UI.toast('正在检查 ' + targets.length + ' 个应用');
    function next() {
      if (i >= targets.length) {
        UI.loading(false);
        UI.toast('检查完成，' + done + ' 个有更新');
        return render();
      }
      return checkOne(targets[i++]).then(function (ok) {
        if (ok) done++;
        return next();
      }, next);
    }
    return next();
  }

  /* ---------- 操作 ---------- */

  /**
   * 点「更新」。
   *
   * ⚠️ 之前这里是：latest_url 为空就弹一句「没找到 APK」然后 return。
   *    但**老数据行根本没有 latest_url** —— 第一版的 add() 只写了
   *    installed_* 列，latest_* 三列（tag / asset / url）是空的。
   *    于是卡片明明写着「有更新 2.0.11 → 2.0.12」，点下去却一点动静都没有。
   *
   * 所以改成：没有 URL 就**现场补查一次**，查到再下载；查不到才报错。
   * 顺手把查到的落库，下次点就不用再查了。
   *
   * 另外每一步都别默默做：下载是异步的，不给反馈用户就以为按钮坏了。
   */
  /**
   * 下载并安装更新。
   *
   * ⚠️ 踩过的坑：installApk 在 **window.Native** 上，不在 window.API 上。
   *    api.js 里 Native（第 15 行起）和 API（第 1084 行起）是两个对象，
   *    window.API 只有 get / post / put / del 那些请求方法。写成
   *    window.API.installApk(...) 拿到的是 undefined，一调用就抛 TypeError，
   *    而且没有任何 toast —— 表现就是「点了更新，什么都没发生」。
   *
   * 另外两点：
   *   - Release 附件用 browser_download_url，是公开直链，**别带认证头**
   *     （带 Bearer 反而容易在 302 跳对象存储时出问题）。只给一个 Accept。
   *   - 下载交给原生 DownloadManager，进度在「下载管理」页看；这里只负责
   *     发起来，并且**必须给一句反馈**，否则用户以为按钮坏了。
   */
  function startInstall(url, name, it) {
    if (!url) return false;
    var headers = JSON.stringify({ Accept: 'application/vnd.android.package-archive' });
    try {
      var b = window.NativeBridge;
      // 优先走 tracked：带上 owner/repo/tag，装完自动落在台账里。
      // 应用库本来就知道来源，没理由让原生再猜一次。
      if (b && typeof b.installApkTracked === 'function' && it && it.owner && it.repo) {
        b.installApkTracked(url, name, headers, it.owner, it.repo,
          it.latest_tag || '', it.latest_asset || name, 'release');
        return true;
      }
      if (b && typeof b.installApk === 'function') {
        b.installApk(url, name, headers, 'release');
        return true;
      }
    } catch (e) { /* 落到下面 */ }
    try {
      if (window.Native && typeof window.Native.installApk === 'function') {
        window.Native.installApk(url, name, { Accept: 'application/vnd.android.package-archive' }, 'release');
        return true;
      }
    } catch (e) { /* 落到下面 */ }
    return false;
  }

  function doUpdate(it) {
    function go(url, name, tag, asset) {
      if (!url) { UI.toast('这一版没找到可安装的 APK'); return; }
      /* ⚠️ 这里**不要**置 pending。
         下载是异步的，用户完全可能在系统安装器上点取消 —— 那一装没成，
         版本没变，行却永远卡在「待安装」，角标也随之消失，看起来像
         应用库把这条弄丢了。
         真正的 pending 时机是「下完、拉起安装器之前」，由原生
         trackFromApk() 去做（那一刻文件确实在，路径是真的）。 */
      if (startInstall(url, name, it)) {
        UI.toast('开始下载 ' + name + '，完成后会拉起安装器');
      } else {
        // 一个出口都不能少：原生能力不在时也要有地方可去，不能点了没反应
        try { NB.openExternal && NB.openExternal(url); } catch (e) { }
        UI.toast('无法直接安装，已在浏览器中打开下载链接');
      }
    }

    if (it.latest_url) {
      go(it.latest_url, it.latest_asset || (it.pkg + '.apk'), it.latest_tag, it.latest_asset);
      return;
    }
    UI.loading(true);
    fetchRelease(it).then(function (r) {
      UI.loading(false);
      if (!r) {
        /* 区分两种「没有」：
           仓库压根没 APK，和「新版里没有跟这一行匹配的那个包」——
           后者常见于一个仓库发多个包名，用户点 A 的更新却找不到 A。
           含糊说一句「没有 APK」会让人以为软件坏了。 */
        UI.toast((it && it.asset)
          ? '新版里没有跟「' + it.asset + '」匹配的安装包，可长按 ⋯ 重新选择'
          : '这一版没有可安装的 APK');
        return;
      }
      try {
        NB.libSetLatest(it.pkg, JSON.stringify({
          tag: r.rel.tag_name || '',
          vName: r.rel.name || r.rel.tag_name || '',
          vCode: codeOf(r.rel.tag_name),
          asset: r.asset.name,
          url: r.asset.browser_download_url,
          size: r.asset.size || 0,
          notes: (r.rel.body || '').slice(0, 400)
        }));
      } catch (e) { }
      go(r.asset.browser_download_url, r.asset.name, r.rel.tag_name, r.asset.name);
    }, function () {
      UI.loading(false);
      UI.toast('取不到 Release，检查网络或登录状态');
    });
  }

  /** 待安装的那一行：文件还在就直接装，没了就重新下载。 */
  /**
   * 待安装那一行点「安装」：文件还在就重新拉起安装器，没了就重新下载。
   * 原生没有「装任意本地文件」的通用入口，所以两条路都走重新下载 ——
   * 至少按钮永远有反应，不会是个死按钮。
   */
  function doInstallPending(it) {
    /* 已经下载好的包还在本地：直接用它拉起安装器，不再下一遍。
       典型场景是「在系统安装器上点了取消」—— 文件没丢，重下纯属浪费。 */
    var ok = false;
    try { ok = !!(NB.libInstallPending && NB.libInstallPending(it.pkg)); } catch (e) { ok = false; }
    if (ok) { UI.toast('正在拉起安装器'); return; }
    UI.toast('安装包已丢失，重新下载');
    doUpdate(it);
  }

  function doOpen(it) {
    var ok = false;
    try { ok = NB.libOpen(it.pkg); } catch (e) { }
    if (!ok) UI.toast('打不开（可能已经卸载了）');
  }

  /**
   * 卸载。
   *
   * 先弹确认（照抄 komi 的 PendingUninstallSheet），确认后拉起系统卸载界面。
   * 卸载结果不由这里判定 —— 下次进页面时 libSync() 去问系统，
   * 回调里猜「卸成功了没」必然出错（用户可能在系统弹窗上点取消）。
   */
  function doUninstall(it) {
    UI.confirm(
      '卸载 ' + (it.app_name || it.pkg) + '？',
      '这会从你的设备上移除 ' + (it.app_name || it.pkg) + '。此操作无法撤消。',
      '卸载', true
    ).then(function (yes) {
      if (!yes) return;
      var ok = false;
      try { ok = NB.libUninstall(it.pkg); } catch (e) { ok = false; }
      // 返回值说明「真的弹出了系统卸载框」还是「只打开了应用信息页兜底」。
      // 不能统一说「请在系统弹窗中确认」—— 兜底时根本没有弹窗在等你。
      UI.toast(ok ? '请在系统弹窗中确认卸载' : '已打开应用信息页，请在其中卸载');
      reconcileAfterUninstall(it.pkg);
    });
  }

  /**
   * 卸载完之后把这一行清掉。
   *
   * 为什么必须延时轮询：卸载是在**系统界面**里完成的，用户什么时候
   * 点「确定」我们根本不知道，也没有回调能拿（系统卸载框不告诉我们结果）。
   * 而过一次 libSync() 是带防误删护栏的 —— 扫描结果一残缺就一个都不删。
   *
   * 所以这里走「显式确认」路径：隔一会儿单点查一次这个包名还在不在，
   * 不在就删行并重画。查几次，覆盖用户读提示、点确认的那段时间。
   */
  function reconcileAfterUninstall(pkg) {
    var tries = [2500, 7000, 15000, 30000];
    tries.forEach(function (ms) {
      setTimeout(function () {
        try {
          NB.libRemoveIfGone(pkg);
          NB.libSync();
        } catch (e) { }
        // 页面可能已经切走了，render 会自己找 #view；找不到就静默
        if (document.getElementById('view')) render();
      }, ms);
    });
  }

  /* ---------- 单项设置 ---------- */

  function openSettings(it) {
    UI.menu(it.app_name || it.pkg, [
      { key: 'check', label: '检查更新', icon: 'sync' },
      { key: 'pre', label: it.preRelease ? '不收预发布版' : '接收预发布版', icon: 'tag' },
      { key: 'ignore', label: it.ignoreUpdate ? '恢复更新提醒' : '忽略此应用的更新', icon: 'bell-slash' },
      { key: 'skip', label: '跳过当前这一版', icon: 'skip' },
      '-',
      { key: 'rebind', label: '重新选择装的哪个包', icon: 'package' },
      { key: 'variant', label: it.pinned_variant ? '改钉的变体（' + it.pinned_variant + '）' : '钉住一个变体', icon: 'package' },
      { key: 'advanced', label: '高级过滤（asset 正则）', icon: 'filter' },
      '-',
      { key: 'repo', label: '打开仓库', icon: 'repo' },
      { key: 'copy', label: '复制包名', icon: 'copy' },
      '-',
      { key: 'unlink', label: '从应用库移除', icon: 'x' },
      { key: 'uninstall', label: '卸载', icon: 'trash' }
    ]).then(function (k) {
      if (!k) return;
      if (k === 'check') { UI.loading(true); return checkOne(it, true).then(function () { UI.loading(false); render(); }); }
      if (k === 'pre') { NB.libSetFlag(it.pkg, 'pre', it.preRelease ? '0' : '1'); return render(); }
      if (k === 'ignore') { NB.libSetFlag(it.pkg, 'ignore', it.ignoreUpdate ? '0' : '1'); return render(); }
      if (k === 'skip') { NB.libSetFlag(it.pkg, 'skipped', it.latest_tag || ''); return render(); }
      if (k === 'rebind') return rebind(it);
      if (k === 'variant') return pickVariant(it);
      if (k === 'advanced') return advancedFilter(it);
      if (k === 'repo') { window.Router.go('/' + it.owner + '/' + it.repo); return; }
      if (k === 'copy') { NB.copy(it.pkg); UI.toast('已复制包名'); return; }
      if (k === 'unlink') {
        UI.confirm('移出应用库', '只是不再跟踪更新，不会卸载手机上的应用。', '移除', true)
          .then(function (yes) { if (yes) { NB.libRemove(it.pkg); render(); } });
        return;
      }
      if (k === 'uninstall') return doUninstall(it);
    });
  }

  /**
   * 重新选择「这一行装的是哪个包」。
   *
   * 一个仓库发多个包名时，自动挑可能挑错（尤其装的时候还没记账、
   * 后来才补的）。给个明确入口让用户自己指定，选中后写进 installed_asset，
   * 之后的更新就只认这一种 —— 「装 A 绑 B」这类错绑也能一键纠正。
   */
  function rebind(it) {
    UI.loading(true);
    fetchRelease(it, { force: true }).then(function (r) {
      UI.loading(false);
      if (!r) { UI.toast('取不到这个仓库的 Release'); return; }
      var list = apkOnly(r.rel.assets || []);
      if (!list.length) { UI.toast('这一版没有 APK 附件'); return; }
      var now = it.asset || '';
      UI.menu('这个应用装的是哪个包？', list.map(function (a) {
        var label = a.name + (a.name === now ? '（当前）' : '');
        return { key: a.browser_download_url, label: label, value: (a.size / 1048576).toFixed(1) + ' MB' };
      })).then(function (url) {
        if (!url) return;
        var picked = null;
        list.forEach(function (a) { if (a.browser_download_url === url) picked = a; });
        if (!picked) return;
        NB.libSetLatest(it.pkg, JSON.stringify({
          tag: r.rel.tag_name || '',
          vName: r.rel.name || r.rel.tag_name || '',
          vCode: codeOf(r.rel.tag_name),
          asset: picked.name,
          url: picked.browser_download_url,
          size: picked.size || 0,
          notes: (r.rel.body || '').slice(0, 400)
        }));
        // 关键：把「装的是哪个包」也改掉，否则下次还会按旧身份去挑
        try { NB.libSetVariant(it.pkg, ''); } catch (e) { }
        libRebindAsset(it.pkg, picked.name);
        UI.toast('已绑定为 ' + picked.name);
        render();
      });
    }, function () { UI.loading(false); });
  }

  /** 写回 installed_asset。没有专门接口时退回用 add 重建这一行。 */
  function libRebindAsset(pkg, assetName) {
    try {
      if (NB.libSetInstalledAsset) { NB.libSetInstalledAsset(pkg, assetName); return; }
    } catch (e) { }
    try {
      var cur = null;
      CTX.items.forEach(function (x) { if (x.pkg === pkg) cur = x; });
      if (cur) NB.libAdd(pkg, cur.owner, cur.repo, cur.app_name, cur.latest_tag, assetName, cur.latest_url);
    } catch (e) { }
  }

  /** 变体选择：列出当前 release 的 APK，让用户钉一个。 */
  function pickVariant(it) {
    UI.loading(true);
    fetchRelease(it, { force: true }).then(function (r) {
      UI.loading(false);
      if (!r) { UI.toast('取不到这个仓库的 Release'); return; }
      var opts = variantOptions(r.rel);
      if (!opts.length) { UI.toast('这一版没有 APK 附件'); return; }
      var items = opts.map(function (o) {
        return { key: o.key, label: o.name, value: (o.size / 1048576).toFixed(1) + ' MB' };
      });
      items.push({ key: '__none__', label: '不钉（自动挑）' });
      UI.menu('钉住哪个变体？', items).then(function (k) {
        if (!k) return;
        NB.libSetVariant(it.pkg, k === '__none__' ? '' : k);
        UI.toast(k === '__none__' ? '已取消钉住' : '已钉住 ' + k);
        render();
      });
    }, function () { UI.loading(false); });
  }

  /** 高级过滤：正则 + 是否退到更旧的 release。 */
  function advancedFilter(it) {
    UI.prompt('asset 名正则', {
      desc: '只有名字匹配这个正则的 APK 才会被挑中。留空表示不限制。',
      value: it.asset_regex || '',
      placeholder: '例如 foss|universal',
      ok: '下一步'
    }).then(function (v) {
      if (v === null) return;
      UI.loading(true);
      fetchRelease(it, { force: true }).then(function (r) {
        UI.loading(false);
        if (!r) { UI.toast('取不到 Release'); return; }
        var names = apkOnly(r.rel.assets || []).map(function (a) { return a.name; });
        var matched = [];
        try { matched = JSON.parse(NB.libPreviewMatch(JSON.stringify(names), v) || '[]'); } catch (e) { }
        var msg = v
          ? '匹配到 ' + matched.length + ' 个：\n' + (matched.slice(0, 6).join('\n') || '（一个都没匹配上）')
          : '未设置过滤，将自动挑合适的那个。';
        UI.confirm('过滤结果', msg, '保存').then(function (yes) {
          if (!yes) return;
          NB.libSetAdvanced(it.pkg, v, false);
          render();
        });
      }, function () { UI.loading(false); });
    });
  }

  /* ---------- 关联（把本机应用纳入管理） ---------- */

  function linkFlow() {
    UI.loading(true);
    var apps = [];
    try { apps = JSON.parse(NB.libScan() || '[]'); } catch (e) { apps = []; }
    UI.loading(false);

    if (!apps.length) {
      UI.toast('没扫到本机应用（可能缺少「查询全部应用」权限）');
      return;
    }
    // 按安装来源排序：侧载商店 → 侧载 → Play → 厂商 → 系统
    apps.sort(function (a, b) {
      var d = (a.priority || 1) - (b.priority || 1);
      return d !== 0 ? d : String(a.name || '').localeCompare(String(b.name || ''));
    });

    var shown = apps;
    function rows(list) {
      if (!list.length) return UI.empty('search', '没有匹配的应用');
      return list.slice(0, 150).map(function (a) {
        return '<button class="opt" data-pkg="' + U.esc(a.pkg) + '" data-name="' + U.esc(a.name) + '">' +
          '<span class="opt-ico">' + window.icon(a.priority === 0 ? 'package' : (a.system ? 'shield' : 'circle'), 18) + '</span>' +
          '<span>' + U.esc(a.name) + '<br><span class="muted tiny">' + U.esc(a.pkg) + '</span></span>' +
          (a.sourceLabel ? '<span class="muted tiny" style="margin-left:auto">' + U.esc(a.sourceLabel) + '</span>' : '') +
          '</button>';
      }).join('');
    }

    UI.sheet({
      title: '选择要跟踪的应用',
      full: true,
      body: '<div class="field"><input class="input" id="lk-q" placeholder="搜索应用名或包名"></div>' +
        '<div id="lk-list">' + rows(shown) + '</div>',
      onMount: function () {
        var root = document.getElementById('sheet-root');
        var q = root.querySelector('#lk-q');
        function bind() {
          UI.$$('#lk-list .opt', root).forEach(function (btn) {
            btn.onclick = function () {
              var pkg = btn.getAttribute('data-pkg');
              var name = btn.getAttribute('data-name');
              UI.closeSheet();
              askRepo(pkg, name);
            };
          });
        }
        q.oninput = function () {
          var k = q.value.trim().toLowerCase();
          shown = !k ? apps : apps.filter(function (a) {
            return String(a.name || '').toLowerCase().indexOf(k) >= 0
              || String(a.pkg || '').toLowerCase().indexOf(k) >= 0;
          });
          root.querySelector('#lk-list').innerHTML = rows(shown);
          bind();
        };
        bind();
      }
    });
  }

  function askRepo(pkg, name) {
    UI.prompt('这个应用来自哪个仓库？', {
      desc: '填 owner/repo，例如 Buwrt/githup。',
      placeholder: 'owner/repo',
      ok: '下一步'
    }).then(function (v) {
      if (!v) return;
      var m = /^([^/\s]+)\/([^/\s]+)$/.exec(v.trim());
      if (!m) { UI.toast('格式不对，要像 owner/repo 这样'); return; }
      var owner = m[1], repo = m[2].replace(/\.git$/, '');
      UI.loading(true);
      window.API.get('/repos/' + owner + '/' + repo + '/releases/latest', null, { cache: 0 })
        .then(function (res) {
          UI.loading(false);
          var rel = res && res.data;
          var a = pickAsset(rel, null);
          if (!a) { UI.toast('这个仓库最新一版里没有 APK 附件'); return; }
          UI.confirm('关联 ' + name, (rel.tag_name || '') + ' · ' + a.name, '加入应用库').then(function (yes) {
            if (!yes) return;
            NB.libAdd(pkg, owner, repo, name, rel.tag_name, a.name, a.browser_download_url);
            UI.toast('已加入应用库');
            render();
          });
        }, function () {
          UI.loading(false);
          UI.toast('取不到这个仓库的 Release');
        });
    });
  }

  /* ---------- 渲染 ---------- */

  /** 状态行 + 色调。 */
  function statusOf(it) {
    /* 显示哪个版本？
       installed_tag   = 我们记录的「装的是哪个 release」（跟 latest_tag 同体系）
       installed_vname = APK 里写的 versionName（跟 tag 常常对不上）

       优先显示 installed_tag —— 它跟右侧「最新 X」是同一套体系，
       显示它才不会出现「1.1.1 → V15」这种自己跟自己打架的文案
       （用户装的就是 V15，只因 APK 里 versionName 写着 1.1.1）。 */
    var cur = it.installed_tag || it.installed_vname || '';
    if (it.pending) return { text: '已下载，等待安装', tone: 'accent' };
    if (it.hasUpdate) return { text: '有更新：' + (cur || '?') + ' → ' + (it.latest_tag || '?'), tone: 'accent' };
    if (!it.present) return { text: '手机上已不存在', tone: 'err' };
    if (it.sysFingerprint && it.fingerprint && it.sysFingerprint !== it.fingerprint) {
      return { text: '签名变了，注意来源', tone: 'err' };
    }
    return { text: '已是最新' + (cur ? '（' + cur + '）' : ''), tone: '' };
  }

  function tagsOf(it) {
    var t = '';
    if (it.ignoreUpdate) t += ' <span class="chip">忽略更新</span>';
    if (it.preRelease) t += ' <span class="chip">含预发布</span>';
    if (it.skipped_tag) t += ' <span class="chip">跳过 ' + U.esc(it.skipped_tag) + '</span>';
    if (it.pinned_variant) t += ' <span class="chip">钉 ' + U.esc(it.pinned_variant) + '</span>';
    if (it.asset_regex) t += ' <span class="chip">有过滤</span>';
    return t;
  }

  function rowHtml(it, inGroup) {
    var name = it.app_name || it.pkg;
    // 同一个仓库常发多个包名（foss / premium、arm64 / armv7），界面上
    // 名字和 owner/repo 完全一样，只有包名能区分。组卡内一律显示包名。
    /* 副标题**始终带包名**。
       一个仓库常发多个包名（foss / premium、arm64 / armv7，甚至两个
       完全不同的软件挂在同一仓库下），名字可以一样、owner/repo 也一样，
       只有包名能把它们分开。用户要确认「装的是不是这个」时看的就是这行。 */
    var sub = (it.owner && it.repo)
      ? (it.owner + '/' + it.repo + ' · ' + it.pkg)
      : it.pkg;
    var st = statusOf(it);
    var main;
    if (it.pending) main = '<button class="btn sm primary" data-act="install">安装</button>';
    else if (it.hasUpdate) main = '<button class="btn sm primary" data-act="update">更新</button>';
    else main = '<button class="btn sm" data-act="open">打开</button>';

    return '<div class="lib-row' + (inGroup ? ' in-group' : '') + '" data-pkg="' + U.esc(it.pkg) + '">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
      '<span>' + window.icon('package', 22) + '</span>' +
      '<div style="min-width:0;flex:1">' +
      '<div style="font-weight:600">' + U.esc(name) + '</div>' +
      '<div class="muted tiny" style="overflow:hidden;text-overflow:ellipsis">' + U.esc(sub) + '</div>' +
      '</div>' +
      '<button class="icon-btn" data-act="menu">' + window.icon('kebab-horizontal', 20) + '</button>' +
      '</div>' +
      '<div class="' + (st.tone === 'accent' ? '' : 'muted') + ' tiny" style="margin:8px 0">'
      + U.esc(st.text) + tagsOf(it) + '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' + main +
      '<button class="btn sm" data-act="uninstall">卸载</button></div>' +
      '</div>';
  }

  /** 同一 owner/repo 的合并成一张组卡，位置取组内第一个成员的位置。 */
  function groupByRepo(list) {
    var out = [], seen = Object.create(null);
    list.forEach(function (it) {
      var key = (it.owner || '') + '/' + (it.repo || '');
      if (seen[key] !== undefined) { out[seen[key]].members.push(it); return; }
      seen[key] = out.length;
      out.push({ key: key, owner: it.owner, repo: it.repo, members: [it] });
    });
    return out;
  }

  function groupHtml(g) {
    if (g.members.length === 1) return rowHtml(g.members[0], false);
    var rows = g.members.map(function (m) { return rowHtml(m, true); }).join('');
    return '<div class="card">' +
      '<div class="muted tiny" style="margin-bottom:6px">' + U.esc(g.owner + '/' + g.repo)
      + ' · ' + g.members.length + ' 个应用</div>' + rows + '</div>';
  }

  function section(title, key, list) {
    if (!list.length) return '';
    var open = CTX.expanded[key] !== false;
    var groups = groupByRepo(list);
    var body = open ? groups.map(groupHtml).join('') : '';
    return '<div class="muted tiny lib-sec" data-sec="' + key + '" style="margin:8px 2px 2px;display:flex;align-items:center;gap:6px">'
      + window.icon(open ? 'chevron-down' : 'chevron-right', 14)
      + U.esc(title) + ' · ' + list.length + '</div>' + body;
  }

  function sortList(list) {
    var s = CTX.sort;
    return list.slice().sort(function (a, b) {
      if (s === 'name') return String(a.app_name || a.pkg).localeCompare(String(b.app_name || b.pkg));
      if (s === 'recent') return (b.checkedAt || 0) - (a.checkedAt || 0);
      // updates：有更新 > 待安装 > 已是最新
      var pa = a.hasUpdate ? 0 : (a.pending ? 1 : 2);
      var pb = b.hasUpdate ? 0 : (b.pending ? 1 : 2);
      return pa !== pb ? pa - pb : String(a.app_name || a.pkg).localeCompare(String(b.app_name || b.pkg));
    });
  }

  function render() {
    var host = document.getElementById('view');
    if (!has()) {
      host.innerHTML = UI.empty('package', '当前环境没有应用库能力');
      return Promise.resolve();
    }

    // 进页面先对一次账：卸掉的、装上的、版本变了的，都由原生核一遍
    try { NB.libSync(); } catch (e) { }

    return load().then(function (items) {
      CTX.items = items;
      var q = (CTX.query || '').trim().toLowerCase();
      var all = !q ? items : items.filter(function (it) {
        return String((it.app_name || '') + ' ' + (it.owner || '') + '/' + (it.repo || '')).toLowerCase().indexOf(q) >= 0;
      });

      // 重名统计：同名应用靠包名区分，副标题据此切换
      var nc = Object.create(null);
      items.forEach(function (it) { var n = it.app_name || it.pkg; nc[n] = (nc[n] || 0) + 1; });
      CTX.dupNames = nc;

      var pend = sortList(all.filter(function (it) { return it.pending; }));
      var upd = sortList(all.filter(function (it) { return it.hasUpdate && !it.pending; }));
      var idle = sortList(all.filter(function (it) { return !it.hasUpdate && !it.pending; }));

      var html = '<div style="padding:12px;display:flex;flex-direction:column;gap:10px">' +
        '<div class="field"><input class="input" id="lib-q" placeholder="搜索应用" value="' + U.esc(CTX.query) + '"></div>';

      if (!items.length) {
        html += UI.empty('package', '应用库还是空的', '点右上角 ➕ 加入本机已装的应用，开始跟踪它的更新');
      } else {
        html += section('待安装', 'pending', pend)
          + section('有更新', 'updates', upd)
          + section('已是最新', 'idle', idle);
      }
      html += '</div>';
      host.innerHTML = html;

      window.App.setActions([
        { icon: 'sync', onClick: checkAll },
        { icon: 'plus', onClick: linkFlow },
        {
          icon: 'kebab-horizontal', onClick: function () {
            UI.menu('应用库', [
              { key: 'sort', label: '排序：' + ({ updates: '有更新优先', recent: '最近检查', name: '名称' }[CTX.sort]), icon: 'filter' },
              { key: 'sync', label: '与本机对账', icon: 'sync' },
              '-',
              { key: 'export', label: '导出清单（复制）', icon: 'copy' },
              { key: 'import', label: '从剪贴板导入', icon: 'download' }
            ]).then(function (k) {
              if (!k) return;
              if (k === 'sync') { NB.libSync(); UI.toast('已对账'); return render(); }
              if (k === 'export') { NB.copy(NB.libExport()); UI.toast('清单已复制到剪贴板'); return; }
              if (k === 'import') {
                var s = NB.getClipboard();
                if (!s) { UI.toast('剪贴板是空的'); return; }
                UI.toast(NB.libImport(s));
                return render();
              }
              if (k === 'sort') {
                UI.menu('排序方式', [
                  { key: 'updates', label: '有更新优先', icon: 'circle' },
                  { key: 'recent', label: '最近检查', icon: 'circle' },
                  { key: 'name', label: '名称', icon: 'circle' }
                ]).then(function (s2) {
                  if (!s2) return;
                  CTX.sort = s2;
                  if (window.Store) window.Store.set('lib_sort', s2);
                  render();
                });
              }
            });
          }
        }
      ]);

      var qEl = host.querySelector('#lib-q');
      if (qEl) qEl.oninput = function () { CTX.query = qEl.value; render(); };

      UI.$$('.lib-sec', host).forEach(function (sec) {
        sec.onclick = function () {
          var k = sec.getAttribute('data-sec');
          CTX.expanded[k] = CTX.expanded[k] === false;
          render();
        };
      });

      UI.$$('.lib-row', host).forEach(function (row) {
        var pkg = row.getAttribute('data-pkg');
        var it = null;
        for (var i = 0; i < items.length; i++) if (items[i].pkg === pkg) { it = items[i]; break; }
        if (!it) return;
        UI.$$('[data-act]', row).forEach(function (b) {
          b.onclick = function () {
            var a = b.getAttribute('data-act');
            if (a === 'update') doUpdate(it);
            else if (a === 'install') doInstallPending(it);
            else if (a === 'open') doOpen(it);
            else if (a === 'uninstall') doUninstall(it);
            else if (a === 'menu') openSettings(it);
          };
        });
      });
    });
  }

  /* ---------- 对外：给「我的」页用的角标 ---------- */

  /**
   * 「我的」页的「应用库」入口要能显示「N 个可更新」。
   * 这个数必须**秒回**——它在一进页面就渲染，不能让人等着转圈。
   * 所以只查本地台账，不发请求；真正的联网检查由后台那次静默检查去做。
   */
  window.LibBadge = {
    count: function () {
      if (!has()) return 0;
      try { return NB.libUpdateCount() || 0; } catch (e) { return 0; }
    },
    /**
     * 静默检查一次（带节流）。
     *
     * 节流按「台账里最早一次检查时间」算，而不是按「上次点检查的时间」——
     * 后者会在新加应用后失效（新行 checked_at=0，却被认为刚查过）。
     */
    refresh: function (minGapMs) {
      if (!has()) return Promise.resolve(0);
      var gap = minGapMs || 6 * 3600 * 1000;
      try {
        if (Date.now() - (NB.libOldestCheckedAt() || 0) < gap) {
          return Promise.resolve(NB.libUpdateCount() || 0);
        }
      } catch (e) { }
      return load().then(function (items) {
        var targets = items.filter(function (it) { return !it.ignoreUpdate && !it.pending; });
        if (!targets.length) return 0;
        var i = 0;
        function next() {
          if (i >= targets.length) return Promise.resolve(NB.libUpdateCount() || 0);
          return checkOne(targets[i++]).then(next, next);
        }
        return next();
      }, function () { return 0; });
    }
  };

  P.library = {
    title: '应用库',
    render: function (ctx, host) {
      host.innerHTML = UI.skeleton(4);
      return render();
    }
  };
})();
