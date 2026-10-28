/* ============================================================
 * desktop-ui.js — 桌面端外壳适配
 *
 * 只做两件事，都是「手机上靠系统、电脑上没有」的东西：
 *
 *   1. 顶部导航条 —— 手机有系统返回键 / 侧滑返回，电脑上什么都没有。
 *      进了二级页面就退不出来，只能杀进程重开。这条栏补上返回 / 前进。
 *   2. 键盘快捷键 —— Esc 返回、Alt+← / Alt+→ 前后翻、Ctrl+R 刷新。
 *      Windows 用户的肌肉记忆就在这几个键上。
 *
 * 返回逻辑**不自己实现**，一律转给 App.handleBack()：
 * 它内部已经排好了优先级（扫码浮层 → 引导 → 图片查看器 → 弹层 →
 * 仓库 tab → 路由回退 → 首页），跟手机按返回键的行为完全一致。
 * ============================================================ */
(function () {
  'use strict';

  // 只有在 Tauri 壳里才启用：浏览器直接打开 web/index.html 时不插这条栏，
  // 免得调试时平白多一条。
  var isDesktop = !!(window.__TAURI_INTERNALS__ ||
    (window.NativeBridge && window.NativeBridge.isDesktop &&
      window.NativeBridge.isDesktop()));
  if (!isDesktop) return;

  var BAR_H = 40;

  /* ---------------- 注入样式 ---------------- */

  function injectCss() {
    var st = document.createElement('style');
    st.id = 'gh-desktop-css';
    st.textContent =
      /* 顶栏本身：固定最上层，不随页面滚动 */
      '#gh-topbar{position:fixed;top:0;left:0;right:0;height:' + BAR_H + 'px;z-index:99998;' +
      'display:flex;align-items:center;gap:6px;padding:0 8px;box-sizing:border-box;' +
      'background:#0d1117;border-bottom:1px solid #30363d;' +
      'font:13px/1 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'color:#e6edf3;user-select:none;-webkit-app-region:no-drag}' +

      '#gh-topbar button{width:30px;height:26px;flex:none;display:flex;' +
      'align-items:center;justify-content:center;border:1px solid #30363d;' +
      'border-radius:6px;background:#21262d;color:#e6edf3;cursor:pointer;padding:0}' +
      '#gh-topbar button:hover:not(:disabled){background:#30363d}' +
      '#gh-topbar button:disabled{opacity:.35;cursor:default}' +
      '#gh-topbar button svg{width:16px;height:16px;fill:currentColor}' +

      '#gh-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;' +
      'white-space:nowrap;font-weight:600;font-size:13px;opacity:.9}' +

      /* 主容器下移并减高：顶栏占了 40px，#app 原来是满屏，
         不减的话底部会被挤出窗口，那条导航栏就看不见了 */
      'html.gh-desktop #app{height:calc(100vh - ' + BAR_H + 'px);' +
      'height:calc(100dvh - ' + BAR_H + 'px);margin-top:' + BAR_H + 'px}' +

      /* 弹层同理：--vvh 是 app.js 按整个窗口算的，这里扣掉顶栏 */
      'html.gh-desktop .sheet,html.gh-desktop .sheet.full{' +
      'max-height:calc(var(--vvh,100vh) - ' + (BAR_H + 8) + 'px) !important}' +

      /* 全屏浮层（图片查看器、引导）本来就盖满，让它从顶栏下面开始 */
      'html.gh-desktop #viewer-root{top:' + BAR_H + 'px}' +

      /* 网络设置面板 */
      '#gh-netpanel{position:fixed;top:' + BAR_H + 'px;right:8px;z-index:99999;' +
      'width:330px;padding:12px;box-sizing:border-box;background:#161b22;' +
      'border:1px solid #30363d;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);' +
      'font:12px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
      'color:#e6edf3}' +
      '.gh-np-title{font-weight:700;margin-bottom:8px}' +
      '.gh-np-row{display:flex;align-items:center;gap:6px;margin-bottom:8px}' +
      '.gh-np-row input{flex:1;min-width:0;background:#0d1117;color:#e6edf3;' +
      'border:1px solid #30363d;border-radius:6px;padding:5px 7px;font-size:12px}' +
      '.gh-np-btns{display:flex;gap:8px;margin-bottom:8px}' +
      '.gh-np-btns button{background:#238636;color:#fff;border:0;border-radius:6px;' +
      'padding:5px 14px;font-size:12px;cursor:pointer}' +
      '#gh-np-out{margin:0;padding:8px;background:#0d1117;border:1px solid #30363d;' +
      'border-radius:6px;white-space:pre-wrap;word-break:break-all;max-height:190px;' +
      'overflow:auto;font-size:11px;color:#8b949e}';
    document.head.appendChild(st);
    document.documentElement.classList.add('gh-desktop');
  }

  /* ---------------- 图标 ---------------- */

  function svg(path) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>';
  }

  var ICON_BACK = 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z';
  var ICON_FWD = 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z';
  var ICON_GEAR = 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.06-.94l2.03-1.58' +
    'c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7' +
    '-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54' +
    'c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47' +
    '.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.06.94l-2.03 1.58c-.18.14-.23.41-.12.61' +
    'l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41' +
    '.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96' +
    'c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.49-.12-.61l-2.03-1.58zM12 15.6' +
    'c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';
  var ICON_RELOAD = 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2' +
    'c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z';

  /* ---------------- 建栏 ---------------- */

  var bar, btnBack, btnFwd, elTitle;

  function build() {
    bar = document.createElement('div');
    bar.id = 'gh-topbar';
    bar.innerHTML =
      '<button id="gh-back" title="返回 (Alt+← / Esc)">' + svg(ICON_BACK) + '</button>' +
      '<button id="gh-fwd" title="前进 (Alt+→)">' + svg(ICON_FWD) + '</button>' +
      '<span id="gh-title">githup</span>' +
      '<button id="gh-net" title="网络设置 / 诊断">' + svg(ICON_GEAR) + '</button>' +
      '<button id="gh-reload" title="刷新 (Ctrl+R)">' + svg(ICON_RELOAD) + '</button>';

    document.body.appendChild(bar);

    btnBack = bar.querySelector('#gh-back');
    btnFwd = bar.querySelector('#gh-fwd');
    elTitle = bar.querySelector('#gh-title');
    var btnReload = bar.querySelector('#gh-reload');

    btnBack.onclick = function () { goBack(); };
    btnFwd.onclick = function () { try { history.forward(); } catch (e) { /* ignore */ } };
    btnReload.onclick = function () { try { location.reload(); } catch (e) { /* ignore */ } };
    var btnNet = bar.querySelector('#gh-net');
    btnNet.onclick = function () { toggleNetPanel(); };
  }

  /* ---------------- 网络设置 / 诊断 ----------------
   *
   * 为什么要它：GitHub 在国内常常直连不通，而 Windows 用户多半是在
   * 「系统设置 → 代理」里配的代理（走注册表），reqwest 默认根本不看，
   * 于是就出现「浏览器能开 GitHub，客户端却连不上」。
   * 这个面板让用户能亲眼看到当前用的是什么代理，并能手动指定。
   */

  var netPanel = null;

  function toggleNetPanel() {
    if (netPanel) { netPanel.remove(); netPanel = null; return; }
    netPanel = document.createElement('div');
    netPanel.id = 'gh-netpanel';
    netPanel.innerHTML =
      '<div class="gh-np-title">网络设置</div>' +
      '<div class="gh-np-row">代理地址<input id="gh-np-proxy" placeholder="留空＝自动探测，如 http://127.0.0.1:7890"></div>' +
      '<div class="gh-np-btns">' +
      '<button id="gh-np-save">保存</button>' +
      '<button id="gh-np-diag">诊断</button>' +
      '</div>' +
      '<pre id="gh-np-out">点「诊断」看看是哪一层断了</pre>';
    document.body.appendChild(netPanel);

    netPanel.querySelector('#gh-np-save').onclick = saveProxy;
    netPanel.querySelector('#gh-np-diag').onclick = diagnose;
    loadProxy();
  }

  function invoke(cmd, args) {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args || {});
    }
    // 兜底：按顺序找 Tauri 暴露的全局
    var fn = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    if (fn) return fn(cmd, args || {});
    return Promise.reject(new Error('不在桌面端'));
  }

  function loadProxy() {
    invoke('net_get_proxy', {}).then(function (p) {
      var el = document.getElementById('gh-np-proxy');
      if (el) el.value = p || '';
    }).catch(function () { });
  }

  function saveProxy() {
    var el = document.getElementById('gh-np-proxy');
    invoke('net_set_proxy', { spec: (el && el.value) || '' }).then(function (used) {
      out('已保存。当前生效：' + (used || '（未使用代理，直连）'));
    }).catch(function (e) { out('保存失败：' + e); });
  }

  function diagnose() {
    var o = document.getElementById('gh-np-out');
    if (o) o.textContent = '正在诊断…';
    invoke('net_diagnose', {}).then(function (txt) {
      var d = {};
      try { d = JSON.parse(txt); } catch (e) { }
      var lines = ['当前代理：' + (d.proxy || '？')];
      (d.items || []).forEach(function (it) {
        lines.push((it.ok ? '✓ ' : '✗ ') + it.name + '  '
          + (it.ok ? ('HTTP ' + it.status) : it.error) + '  (' + it.ms + ' ms)');
      });
      out(lines.join('\n'));
    }).catch(function (e) { out('诊断失败：' + e); });
  }

  function out(t) {
    var o = document.getElementById('gh-np-out');
    if (o) o.textContent = t;
  }

  function goBack() {
    // 交给前端统一的返回处理，行为跟手机按返回键一致
    if (window.App && typeof window.App.handleBack === 'function') {
      window.App.handleBack();
      return;
    }
    try { history.back(); } catch (e) { /* ignore */ }
  }

  /* ---------------- 状态同步 ---------------- */

  function sync() {
    if (!btnBack) return;
    var canBack = false;
    try {
      canBack = !!(window.Router && window.Router.canGoBack && window.Router.canGoBack());
    } catch (e) { /* ignore */ }
    btnBack.disabled = !canBack;

    var t = '';
    try {
      if (window.Router && window.Router.current) {
        // #/owner/repo/... 取第一段可读内容当标题
        var h = String(window.Router.current).replace(/^#\/?/, '');
        t = h ? decodeURIComponent(h.split('/')[0]) : '';
      }
      if (!t && document.title) t = document.title;
    } catch (e) { /* ignore */ }
    elTitle.textContent = t || 'githup';
  }

  /* ---------------- 键盘 ---------------- */

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      // 输入框里不抢键，否则打字按 Esc 就跳页了
      var tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;

      if (e.key === 'Escape') {
        goBack();
        e.preventDefault();
      } else if (e.altKey && e.key === 'ArrowLeft') {
        goBack();
        e.preventDefault();
      } else if (e.altKey && e.key === 'ArrowRight') {
        try { history.forward(); } catch (err) { /* ignore */ }
        e.preventDefault();
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  function start() {
    injectCss();
    build();
    bindKeys();
    sync();

    // 路由变化后刷新按钮可用状态和标题
    window.addEventListener('popstate', function () { setTimeout(sync, 0); });
    window.addEventListener('hashchange', function () { setTimeout(sync, 0); });
    // 兜底轮询：前端有些跳转不走 hashchange（replaceState 后手动 render）
    setInterval(sync, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
