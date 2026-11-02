/* ============================================================
 * lan-sync.js — 局域网同步（手机端）
 *
 * 业务规则（与 Java 侧 LanSync.needApproval() 一一对应）：
 *
 *   手机 → 电脑 推送     电脑端免确认，直接收
 *   电脑 → 手机 推送     本端弹确认，用户同意才落地
 *   手机 拉取 电脑数据   电脑端弹确认（本端被拉时同样先问自己）
 *
 * 本文件负责三件事：
 *   1. 组装 / 落地 localStorage 里那份数据（设置、Star 列表）
 *   2. 渲染同步面板：设备列表、配对、推送、拉取
 *   3. 渲染审批弹层 —— 这是安全模型的最后一道闸
 * ============================================================ */
(function () {
  'use strict';

  function nb() { return window.NativeBridge; }
  function has(n) { var b = nb(); return !!(b && typeof b[n] === 'function'); }

  function call(n) {
    var b = nb();
    if (!b || typeof b[n] !== 'function') return null;
    try {
      return b[n].apply(b, Array.prototype.slice.call(arguments, 1));
    } catch (e) {
      toast('调用失败：' + (e && e.message ? e.message : n));
      return null;
    }
  }

  function toast(msg) {
    try {
      if (window.UI && typeof window.UI.toast === 'function') { window.UI.toast(msg, 3000); return; }
    } catch (e) { /* ignore */ }
    try { console.log('[githup] ' + msg); } catch (e) { /* ignore */ }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------- 数据：收集与落地 ----------------
   * 原生侧掌管令牌与 TOTP，这里只管 localStorage 里那份：
   * gh_settings（应用设置）与所有 Star 列表（key 按登录名隔离，
   * 所以按名字里含 starlist 动态扫描，不写死前缀）。 */

  var LS_SETTINGS = 'gh_settings';

  function collect() {
    var out = { settings: null, starlists: {} };
    try { out.settings = localStorage.getItem(LS_SETTINGS); } catch (e) { }
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k) continue;
        if (/starlist/i.test(k)) out.starlists[k] = localStorage.getItem(k);
      }
    } catch (e) { }
    return out;
  }

  function applyWeb(data) {
    var n = 0;
    try {
      if (data && data.settings) { localStorage.setItem(LS_SETTINGS, data.settings); n++; }
      if (data && data.starlists) {
        for (var k in data.starlists) {
          if (Object.prototype.hasOwnProperty.call(data.starlists, k)) {
            localStorage.setItem(k, data.starlists[k]);
            n++;
          }
        }
      }
    } catch (e) { }
    return n;
  }

  /* ---------------- 面板 ---------------- */

  var panelEl = null;

  function ensurePanel() {
    if (panelEl) return panelEl;
    var d = document.createElement('div');
    d.id = 'lan-sync-panel';
    d.style.cssText = 'position:fixed;z-index:99990;left:0;right:0;bottom:0;'
      + 'max-height:78vh;overflow:auto;background:#0d1117;color:#e6edf3;'
      + 'border-top:1px solid #30363d;padding:14px 14px 24px;font-size:14px;'
      + 'box-shadow:0 -8px 24px rgba(0,0,0,.5);display:none';
    document.body.appendChild(d);
    panelEl = d;
    return d;
  }

  function close() {
    if (panelEl) panelEl.style.display = 'none';
  }

  function open() {
    var d = ensurePanel();
    d.style.display = 'block';
    render();
    call('lanStart');
    setTimeout(function () { call('lanDiscover'); }, 400);
  }

  var devices = [];
  var peers = [];

  function render() {
    var d = ensurePanel();
    var rows = '';
    for (var i = 0; i < devices.length; i++) {
      var f = devices[i];
      var tag = f.paired ? '<span style="color:#3fb950">已配对</span>'
        : '<span style="color:#8b949e">未配对</span>';
      var kind = f.type === 'pc' ? '电脑' : '手机';
      rows += '<div style="padding:10px 0;border-bottom:1px solid #21262d">'
        + '<div><b>' + esc(f.name) + '</b> '
        + '<span style="color:#8b949e;font-size:12px">' + esc(kind) + ' · '
        + esc(f.host) + '</span></div>'
        + '<div style="margin-top:6px;font-size:12px">' + tag + '</div>'
        + '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">'
        + (f.paired
          ? '<button data-act="push" data-id="' + esc(f.id) + '" class="ls-btn">推送给它</button>'
          + '<button data-act="pull" data-id="' + esc(f.id) + '" class="ls-btn">从它同步</button>'
          + '<button data-act="unpair" data-id="' + esc(f.id) + '" class="ls-btn ls-danger">解除配对</button>'
          : '<button data-act="pair" data-id="' + esc(f.id) + '" class="ls-btn">输入配对码</button>')
        + '</div></div>';
    }
    if (!devices.length) {
      rows = '<div style="color:#8b949e;padding:12px 0">'
        + '正在搜索同一网络下的设备…（两端都要打开本页）</div>';
    }

    d.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between">'
      + '<b style="font-size:15px">局域网同步</b>'
      + '<button id="ls-close" class="ls-btn">关闭</button></div>'
      + '<div style="color:#8b949e;font-size:12px;margin:8px 0 12px">'
      + '手机推给电脑免确认；电脑推给手机、手机拉取电脑，都需要另一端确认。</div>'
      + '<div style="display:flex;gap:8px;margin-bottom:12px">'
      + '<button id="ls-code" class="ls-btn">生成配对码</button>'
      + '<button id="ls-scan" class="ls-btn">刷新设备</button></div>'
      + '<div id="ls-codebox" style="display:none;margin-bottom:12px;padding:10px;'
      + 'background:#161b22;border:1px solid #30363d;border-radius:8px">'
      + '<div style="font-size:26px;letter-spacing:6px;font-weight:700" id="ls-pin">------</div>'
      + '<div style="color:#8b949e;font-size:12px;margin-top:6px">'
      + '在电脑端输入这 6 位码完成配对，5 分钟内有效</div></div>'
      + '<div>' + rows + '</div>'
      + '<style>.ls-btn{background:#21262d;color:#e6edf3;border:1px solid #30363d;'
      + 'border-radius:6px;padding:7px 12px;font-size:13px;cursor:pointer}'
      + '.ls-btn:active{opacity:.7}.ls-danger{border-color:#8b2c2c}</style>';

    bind();
  }

  function bind() {
    var d = ensurePanel();
    var closeBtn = d.querySelector('#ls-close');
    if (closeBtn) closeBtn.onclick = close;

    var codeBtn = d.querySelector('#ls-code');
    if (codeBtn) codeBtn.onclick = function () {
      var pin = call('lanNewPairCode');
      var box = d.querySelector('#ls-codebox');
      if (!pin) { toast('生成失败，请确认已打开同步面板'); return; }
      if (box) {
        box.style.display = 'block';
        var p = d.querySelector('#ls-pin');
        if (p) p.textContent = String(pin);
      }
    };

    var scanBtn = d.querySelector('#ls-scan');
    if (scanBtn) scanBtn.onclick = function () { call('lanDiscover'); toast('已重新搜索'); };

    var btns = d.querySelectorAll('[data-act]');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.onclick = function () {
          var act = b.getAttribute('data-act');
          var id = b.getAttribute('data-id');
          if (act === 'push') doPush(id);
          else if (act === 'pull') doPull(id);
          else if (act === 'pair') doPair(id);
          else if (act === 'unpair') {
            call('lanRemovePeer', id);
            call('lanDiscover');
            toast('已解除配对');
          }
        };
      })(btns[i]);
    }
  }

  function doPush(id) {
    var payload = collect();
    var r = call('lanPush', id, JSON.stringify(payload));
    report(r, '推送');
  }

  function doPull(id) {
    var r = call('lanPull', id);
    report(r, '同步');
  }

  function doPair(id) {
    var pin = window.prompt('输入对方显示的 6 位配对码：');
    if (!pin) return;
    pin = String(pin).trim();
    if (!/^\d{6}$/.test(pin)) { toast('配对码是 6 位数字'); return; }
    var r = call('lanPair', id, pin);
    report(r, '配对');
  }

  function report(r, verb) {
    if (!r) { toast(verb + '失败：本机暂不支持'); return; }
    var ok = false, msg = '';
    try {
      var o = JSON.parse(r);
      ok = !!o.ok;
      msg = o.msg || (ok ? verb + '完成' : verb + '失败');
    } catch (e) { msg = String(r); }
    toast(msg);
  }

  /* ---------------- 审批弹层 ----------------
   * 电脑 → 手机 推送时由 Java 侧回调 onApprove 触发。
   * 用户点了同意/拒绝之前，原生那边的 socket 一直挂着等，
   * 所以这里必须保证任何出口都会回一次 lanApprove。 */

  function approve(info) {
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;z-index:99999;left:0;right:0;top:0;bottom:0;'
      + 'background:rgba(0,0,0,.65);display:flex;align-items:center;'
      + 'justify-content:center;padding:20px';

    var isPush = info.action === 'push';
    var title = isPush ? '允许这台设备写入本机？' : '允许这台设备读取本机数据？';
    var sub = isPush
      ? esc(info.peerName) + ' 想把数据推送到本机，同意后将覆盖本机的对应内容。'
      : esc(info.peerName) + ' 想读取本机的全部可同步数据。';

    wrap.innerHTML =
      '<div style="background:#0d1117;border:1px solid #30363d;border-radius:12px;'
      + 'max-width:340px;width:100%;padding:18px;color:#e6edf3">'
      + '<div style="font-size:16px;font-weight:700;margin-bottom:8px">' + title + '</div>'
      + '<div style="font-size:13px;color:#8b949e;line-height:1.6">' + sub + '</div>'
      + '<div style="margin:12px 0;padding:10px;background:#161b22;border-radius:8px;'
      + 'font-size:13px">涉及内容：<b>' + esc(info.items || '未知') + '</b></div>'
      + '<div style="display:flex;gap:10px;margin-top:14px">'
      + '<button id="ls-no" style="flex:1;padding:11px;border-radius:8px;'
      + 'background:#21262d;color:#e6edf3;border:1px solid #30363d;font-size:14px">拒绝</button>'
      + '<button id="ls-yes" style="flex:1;padding:11px;border-radius:8px;'
      + 'background:#238636;color:#fff;border:0;font-size:14px">同意</button>'
      + '</div></div>';

    function done(ok) {
      call('lanApprove', info.reqId, ok);
      try { wrap.remove(); } catch (e) { /* ignore */ }
    }

    wrap.querySelector('#ls-yes').onclick = function () { done(true); };
    wrap.querySelector('#ls-no').onclick = function () { done(false); };

    document.body.appendChild(wrap);
  }

  /* ---------------- 入口按钮 ---------------- */

  function ensureEntry() {
    if (document.getElementById('lan-sync-entry')) return;
    var b = document.createElement('button');
    b.id = 'lan-sync-entry';
    b.textContent = '局域网同步';
    b.style.cssText = 'position:fixed;z-index:99980;right:12px;bottom:76px;'
      + 'padding:8px 12px;border-radius:20px;background:#21262d;color:#e6edf3;'
      + 'border:1px solid #30363d;font-size:12px;opacity:.9';
    b.onclick = open;
    document.body.appendChild(b);
  }

  /* ---------------- 对原生暴露的回调 ---------------- */

  window.LanSync = {
    /** 设备列表变化（Java 侧的发现线程回调） */
    onDevices: function (json) {
      try { devices = JSON.parse(json) || []; } catch (e) { devices = []; }
      if (panelEl && panelEl.style.display === 'block') render();
    },
    /** 需要用户审批 —— 安全模型的核心入口 */
    onApprove: function (json) {
      var info = null;
      try { info = JSON.parse(json); } catch (e) { return; }
      if (info && info.reqId) approve(info);
    },
    onPaired: function (id, name, sas) {
      toast('已与 ' + name + ' 配对，短认证串 ' + sas + '（请与对方核对）');
      call('lanDiscover');
    },
    onSyncDone: function (dir, peerName, items) {
      toast((dir === 'in' ? '已接收来自 ' : '已发送到 ') + peerName + '：' + items);
    },
    /** 原生已把令牌/设置/TOTP 落盘，这里补上 localStorage 那份 */
    onApply: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      var n = applyWeb(data);
      if (n) toast('已应用 ' + n + ' 项本地数据，重启页面后生效');
    },
    collect: collect,
    open: open,
    close: close
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureEntry);
  } else {
    ensureEntry();
  }
})();
