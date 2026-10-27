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
 * 页面的三块：待安装 / 有更新 / 已是最新。
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});
  var NB = window.NativeBridge;

  var CTX = { items: [], query: '' };

  /* 有没有原生能力：浏览器里打开时退化成一句说明，不报错。 */
  function has() {
    return !!(NB && typeof NB.libList === 'function');
  }

  function load() {
    if (!has()) return Promise.resolve([]);
    try {
      var s = NB.libList() || '[]';
      return Promise.resolve(JSON.parse(s));
    } catch (e) {
      return Promise.resolve([]);
    }
  }

  /* ---------- 版本 ---------- */

  /**
   * tag -> 可比较的数字。跟 version.lock 里那套换算保持一致
   * （x.y.z -> x*1000000 + y*1000 + z），解析不出来就返回 0，
   * 由原生侧退化成「tag 字符串不相等即算更新」。
   */
  function codeOf(tag) {
    var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(tag || ''));
    if (!m) return 0;
    return (+m[1]) * 1000000 + (+m[2]) * 1000 + (+m[3]);
  }

  /**
   * 从一堆附件里挑出该装的那个。
   *
   * 一个 Release 常常挂好几个 APK（arm64 / armv7 × foss / premium），
   * 光按体积挑最大的是错的 —— 会挑到错架构，或者挑到付费版。
   * 顺序：设备 ABI 优先 > universal > 体积最大的兜底。
   */
  var ABI = '';
  function abi() {
    if (ABI) return ABI;
    try { ABI = (NB && NB.libAbi && NB.libAbi()) || ''; } catch (e) { ABI = ''; }
    return ABI;
  }

  function pickAsset(rel, regex) {
    var list = (rel && rel.assets) || [];
    var out = list.filter(function (a) {
      var n = (a.name || '').toLowerCase();
      if (!/\.apk$/i.test(n)) return false;
      // 校验文件、签名块不是安装包
      if (/\.(sha256|sha1|md5|sig|asc|pem|json)$/i.test(n)) return false;
      if (regex) { try { return new RegExp(regex, 'i').test(a.name); } catch (e) { return true; } }
      return true;
    });
    if (!out.length) return null;
    // arm64-v8a -> arm64 / v8a 两种写法都要认
    var a0 = abi().toLowerCase();
    var keys = [];
    if (a0.indexOf('arm64') >= 0 || a0.indexOf('v8a') >= 0) keys = ['arm64', 'v8a', 'aarch64'];
    else if (a0.indexOf('arm') >= 0 || a0.indexOf('v7a') >= 0) keys = ['armeabi-v7a', 'v7a', 'arm32'];
    else if (a0.indexOf('x86_64') >= 0) keys = ['x86_64'];
    else if (a0.indexOf('x86') >= 0) keys = ['x86'];

    function score(a) {
      var n = (a.name || '').toLowerCase();
      for (var i = 0; i < keys.length; i++) if (n.indexOf(keys[i]) >= 0) return 100 - i;
      if (n.indexOf('universal') >= 0 || n.indexOf('noarch') >= 0) return 50;
      return 0;
    }
    out.sort(function (a, b) {
      var d = score(b) - score(a);
      return d !== 0 ? d : (b.size || 0) - (a.size || 0);
    });
    return out[0] || null;
  }

  /* ---------- 更新检查 ---------- */

  /**
   * 查一个应用的最新 Release。
   *
   * ⚠️ 这里是前端发请求，不是原生 —— 令牌注入、加速通道、限流兜底
   * 全部走 api.js 既有实现，不重复造一遍网络层。
   */
  function checkOne(it) {
    if (!it.owner || !it.repo) return Promise.resolve(false);
    var path = '/repos/' + it.owner + '/' + it.repo + '/releases/latest';
    // cache:0 —— 检查更新必须真发一次请求，不能吃到列表页留下的缓存
    return window.API.get(path, null, { cache: 0 }).then(function (res) {
      var rel = res && res.data;
      var a = pickAsset(rel, it.asset_regex);
      if (!rel || !rel.tag_name) return false;
      NB.libSetLatest(it.pkg, JSON.stringify({
        tag: rel.tag_name || '',
        vName: rel.name || rel.tag_name || '',
        vCode: codeOf(rel.tag_name),
        asset: a ? a.name : '',
        url: a ? a.browser_download_url : '',
        size: a ? (a.size || 0) : 0,
        notes: (rel.body || '').slice(0, 400)
      }));
      return true;
    }, function () {
      return false;   // 单个失败不打断整批
    });
  }

  function checkAll() {
    UI.loading(true);
    var targets = CTX.items.filter(function (it) { return !it.ignoreUpdate; });
    var i = 0;
    function next() {
      if (i >= targets.length) {
        UI.loading(false);
        return render();
      }
      return checkOne(targets[i++]).then(next, next);
    }
    UI.toast('正在检查 ' + targets.length + ' 个应用');
    return next();
  }

  /* ---------- 操作 ---------- */

  function doUpdate(it) {
    if (!it.latest_url) { UI.toast('这一版没找到可安装的 APK'); return; }
    var name = (it.latest_asset || (it.pkg + '.apk'));
    // 先记一笔「待安装」：装没装成由下次进页面时的对账（libSync）来定论，
    // 这里不猜结果。
    NB.libSetPending(it.pkg, true);
    window.API.installApk(it.latest_url, name);
  }

  function doOpen(it) {
    var ok = NB.libOpen(it.pkg);
    if (!ok) UI.toast('打不开（可能已经卸载了）');
  }

  function doUninstall(it) {
    UI.confirm('卸载 ' + (it.app_name || it.pkg), '会从手机上移除这个应用，台账里的记录也会一并删掉。', '卸载', true)
      .then(function (yes) {
        if (!yes) return;
        NB.libUninstall(it.pkg);
        NB.libRemove(it.pkg);
        render();
      });
  }

  function doMenu(it) {
    UI.menu(it.app_name || it.pkg, [
      { key: 'open', label: '打开', icon: 'play' },
      { key: 'repo', label: '打开仓库', icon: 'repo' },
      { key: 'copy', label: '复制包名', icon: 'copy' },
      '-',
      { key: 'ignore', label: it.ignoreUpdate ? '恢复更新提醒' : '忽略这个应用的更新', icon: 'bell-slash' },
      { key: 'skip', label: '跳过当前这一版', icon: 'skip' },
      { key: 'recheck', label: '重新检查更新', icon: 'sync' },
      '-',
      { key: 'remove', label: '从应用库移除', icon: 'trash' }
    ]).then(function (k) {
      if (!k) return;
      if (k === 'open') return doOpen(it);
      if (k === 'repo') { window.Router.go('/' + it.owner + '/' + it.repo); return; }
      if (k === 'copy') { NB.copy(it.pkg); UI.toast('已复制包名'); return; }
      if (k === 'ignore') { NB.libSetFlag(it.pkg, 'ignore', it.ignoreUpdate ? '0' : '1'); return render(); }
      if (k === 'skip') { NB.libSetFlag(it.pkg, 'skipped', it.latest_tag || ''); return render(); }
      if (k === 'recheck') { UI.loading(true); return checkOne(it).then(function () { UI.loading(false); render(); }); }
      if (k === 'remove') {
        UI.confirm('移出应用库', '只是不再跟踪更新，不会卸载手机上的应用。', '移除', true)
          .then(function (yes) { if (yes) { NB.libRemove(it.pkg); render(); } });
      }
    });
  }

  /* ---------- 关联（把本机应用纳入管理） ---------- */

  function linkFlow() {
    UI.loading(true);
    var apps = [];
    try { apps = JSON.parse(NB.libScan() || '[]'); } catch (e) { apps = []; }
    UI.loading(false);

    // 系统应用排在后面：用户想管的是自己装的那些
    apps.sort(function (a, b) { return (a.system ? 1 : 0) - (b.system ? 1 : 0); });
    if (!apps.length) {
      UI.toast('没扫到本机应用（可能缺少「查询全部应用」权限）');
      return;
    }

    var shown = apps;
    function body() {
      return '<div class="field"><input class="input" id="lk-q" placeholder="搜索应用名或包名"></div>' +
        '<div id="lk-list">' + rows(shown.slice(0, 120)) + '</div>';
    }
    function rows(list) {
      if (!list.length) return UI.empty('search', '没有匹配的应用');
      return list.map(function (a) {
        return '<button class="opt" data-pkg="' + U.esc(a.pkg) + '" data-name="' + U.esc(a.name) + '">' +
          '<span class="opt-ico">' + window.icon(a.system ? 'shield' : 'package', 18) + '</span>' +
          '<span>' + U.esc(a.name) + '<br><span class="muted tiny">' + U.esc(a.pkg) + '</span></span>' +
          (a.system ? '<span class="muted tiny" style="margin-left:auto">系统</span>' : '') +
          '</button>';
      }).join('');
    }

    UI.sheet({
      title: '选择要跟踪的应用',
      body: body(),
      full: true,
      onMount: function (b) {
        var root = document.getElementById('sheet-root');
        var q = root.querySelector('#lk-q');
        q.oninput = function () {
          var k = q.value.trim().toLowerCase();
          shown = !k ? apps : apps.filter(function (a) {
            return (a.name || '').toLowerCase().indexOf(k) >= 0 || (a.pkg || '').toLowerCase().indexOf(k) >= 0;
          });
          root.querySelector('#lk-list').innerHTML = rows(shown.slice(0, 120));
          bind();
        };
        bind();
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
      }
    });
  }

  /** 选定应用后问它来自哪个仓库，再挑一个 asset 落库。 */
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
        UI.confirm('关联 ' + name, rel.tag_name + ' · ' + a.name, '加入应用库').then(function (yes) {
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

  function rowHtml(it) {
    var name = it.app_name || it.pkg;
    var sub = (it.owner && it.repo) ? (it.owner + '/' + it.repo) : it.pkg;
    // 已装版本只看系统读到的 versionName。installed_tag 只是「我们认为装的是
    // 哪一版」的备注，拿它来显示就会把最新版错报成已装版本。
    var cur = it.installed_vname || it.installed_tag || '';
    var status, tone = 'muted';
    if (it.pending) { status = '已下载，等待安装'; tone = 'accent'; }
    else if (it.hasUpdate) {
      status = '有更新：' + (cur || '?') + ' → ' + (it.latest_tag || '?');
      tone = 'accent';
    } else if (!it.present) { status = '手机上已不存在'; tone = 'err'; }
    else if (it.sysFingerprint && it.fingerprint && it.sysFingerprint !== it.fingerprint) {
      status = '签名变了，注意来源'; tone = 'err';
    } else { status = '已是最新' + (cur ? '（' + cur + '）' : ''); }

    var tags = '';
    if (it.ignoreUpdate) tags += ' <span class="chip">忽略更新</span>';
    if (it.preRelease) tags += ' <span class="chip">含预发布</span>';
    if (it.skipped_tag) tags += ' <span class="chip">跳过 ' + U.esc(it.skipped_tag) + '</span>';

    var act = it.hasUpdate
      ? '<button class="btn sm primary" data-act="update">更新</button>'
      : '<button class="btn sm" data-act="open">打开</button>';

    return '<div class="card" data-pkg="' + U.esc(it.pkg) + '">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
      '<span>' + window.icon('package', 22) + '</span>' +
      '<div style="min-width:0;flex:1">' +
      '<div style="font-weight:600">' + U.esc(name) + '</div>' +
      '<div class="muted tiny" style="overflow:hidden;text-overflow:ellipsis">' + U.esc(sub) + '</div>' +
      '</div>' +
      '<button class="icon-btn" data-act="menu">' + window.icon('kebab-horizontal', 20) + '</button>' +
      '</div>' +
      '<div class="' + (tone === 'accent' ? '' : 'muted') + ' tiny" style="margin:8px 0">' + U.esc(status) + tags + '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' + act +
      '<button class="btn sm" data-act="uninstall">卸载</button></div>' +
      '</div>';
  }

  function section(title, list, emptyIcon, emptyText) {
    if (!list.length) return '';
    return '<div class="muted tiny" style="margin:8px 2px 2px">' + U.esc(title) + ' · ' + list.length + '</div>' +
      list.map(rowHtml).join('');
  }

  function render() {
    var host = document.getElementById('view');
    if (!has()) {
      host.innerHTML = UI.empty('package', '当前环境没有应用库能力');
      return;
    }
    return load().then(function (items) {
      // 进页面先对一次账：卸掉的、装上的、版本变了的，都由原生核一遍
      try { NB.libSync(); } catch (e) { }
      return load();
    }).then(function (items) {
      CTX.items = items;

      var q = (CTX.query || '').trim().toLowerCase();
      var all = !q ? items : items.filter(function (it) {
        return ((it.app_name || '') + ' ' + (it.owner || '') + '/' + (it.repo || '')).toLowerCase().indexOf(q) >= 0;
      });

      var pend = all.filter(function (it) { return it.pending; });
      var upd = all.filter(function (it) { return it.hasUpdate && !it.pending; });
      var idle = all.filter(function (it) { return !it.hasUpdate && !it.pending; });

      var html = '<div style="padding:12px;display:flex;flex-direction:column;gap:10px">' +
        '<div class="field"><input class="input" id="lib-q" placeholder="搜索应用" value="' + U.esc(CTX.query) + '"></div>';

      if (!items.length) {
        html += UI.empty('package', '应用库还是空的', '点右上角加入本机已装的应用，开始跟踪它的更新');
      } else {
        html += section('待安装', pend, 'download', '') +
          section('有更新', upd, 'sync', '') +
          section('已是最新', idle, 'check', '');
      }
      html += '</div>';

      host.innerHTML = html;

      // 顶栏：检查全部 / 添加 / 菜单
      window.App.setActions([
        { icon: 'sync', onClick: checkAll },
        { icon: 'plus', onClick: linkFlow },
        {
          icon: 'kebab-horizontal', onClick: function () {
            UI.menu('应用库', [
              { key: 'sync', label: '与本机对账', icon: 'sync' },
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
            });
          }
        }
      ]);

      var qEl = host.querySelector('#lib-q');
      if (qEl) qEl.oninput = function () { CTX.query = qEl.value; render(); };

      UI.$$('.card[data-pkg]', host).forEach(function (card) {
        var pkg = card.getAttribute('data-pkg');
        var it = null;
        for (var i = 0; i < items.length; i++) if (items[i].pkg === pkg) { it = items[i]; break; }
        if (!it) return;
        UI.$$('[data-act]', card).forEach(function (b) {
          b.onclick = function () {
            var a = b.getAttribute('data-act');
            if (a === 'update') doUpdate(it);
            else if (a === 'open') doOpen(it);
            else if (a === 'uninstall') doUninstall(it);
            else if (a === 'menu') doMenu(it);
          };
        });
      });
    });
  }

  P.library = {
    title: '应用库',
    render: function (ctx, host) {
      host.innerHTML = UI.skeleton(4);
      return render();
    }
  };
})();
