/* ============================================================
 * page-downloads.js — 下载管理页
 *
 * 右上角「下载」图标进来的页面。以前下载只有一个顶部悬浮小条，下完了
 * 文件去了哪、失败了怎么办，全都没下文。这里集中管理：
 *
 *   - 进行中：进度、速度、走的哪条通道，可一键取消
 *   - 历史：最近 30 条，成功可打开/删除，失败可重试
 *
 * 数据都来自原生层：downloadStatus()（进行中）/ downloadHistory()（历史）
 * / downloadAction()（取消、打开、删除、重试、清空）。
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});
  var NB = window.NativeBridge;

  if (!(NB && typeof NB.downloadStatus === 'function')) {
    /* 没有原生层（浏览器 Demo）就不注册这个页面，点右上角图标进来给个说明 */
    P.downloads = {
      title: '下载管理',
      render: function (ctx, host) {
        host.innerHTML = '<div class="dl-empty">' + window.icon('download', 40) +
          '<p>当前环境没有原生下载能力</p></div>';
      }
    };
    return;
  }

  var STATUS_PAUSED = 4, STATUS_SUCCESSFUL = 8, STATUS_FAILED = 16;
  var timer = null;
  var lastActive = -1;   // 上一轮进行中数量：一旦归零就刷新历史（刚有任务收尾了）

  function fmtTime(ts) {
    var d = new Date(ts);
    if (isNaN(d)) return '';
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    var today = new Date();
    var sameDay = d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    if (sameDay) return '今天 ' + hm;
    var y = new Date(today.getTime() - 86400000);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate())
      return '昨天 ' + hm;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' + hm;
  }

  function act(payload) {
    try { NB.downloadAction(JSON.stringify(payload)); } catch (e) { }
  }

  /* ---------------- 进行中 ---------------- */

  function activeRow(t) {
    var total = Number(t.total) || 0;
    var sofar = Number(t.sofar) || 0;
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round(sofar * 100 / total))) : null;
    var desc = (pct == null ? U.bytes(sofar) : pct + '% · ' + U.bytes(sofar) + ' / ' + U.bytes(total));
    if (t.ch) desc += ' · ' + t.ch;
    var paused = t.status === STATUS_PAUSED;
    var failed = t.status === STATUS_FAILED;
    if (paused) desc += ' · 等待网络';
    if (failed) desc += ' · 失败';
    return '<div class="list-row dl-row-in" data-id="' + t.id + '">' +
      '<span class="dlh-ico run">' + window.icon('download', 15) + '</span>' +
      '<span class="row-main">' +
      '<span class="row-title mono tiny">' + U.esc(t.name || '下载中') + '</span>' +
      '<span class="row-desc">' + U.esc(desc) + '</span>' +
      '<div class="dlh-track"><div class="dlh-fill' + (pct == null ? ' indeterminate' : '') +
      '" style="width:' + (pct == null ? 30 : pct) + '%"></div></div>' +
      '</span>' +
      '<span class="row-acts"><span class="row-act" data-cancel="' + t.id + '" title="取消下载">' +
      window.icon('x', 16) + '</span></span>' +
      '</div>';
  }

  function renderActive(list) {
    var box = document.getElementById('dl-active');
    var sec = document.getElementById('dl-active-sec');
    if (!box || !sec) return;
    if (!list.length) {
      sec.hidden = true;
      box.innerHTML = '';
      return;
    }
    sec.hidden = false;
    var label = sec.querySelector('.dl-count');
    if (label) label.textContent = '（' + list.length + '）';
    box.innerHTML = list.map(activeRow).join('');
    UI.$$('[data-cancel]', box).forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        act({ action: 'cancel', id: Number(b.getAttribute('data-cancel')) });
      };
    });
  }

  /* ---------------- 历史 ---------------- */

  function histRow(r) {
    var ok = !!r.ok;
    var bits = [];
    if (r.bytes > 0) bits.push(U.bytes(r.bytes));
    bits.push(fmtTime(r.time));
    bits.push(ok ? '已完成' : '失败');
    var name = U.esc(r.name || '');
    /* dlId 是 DownloadManager 的下载 id。原生层「删除」要靠它定位真实文件 ——
     * 光有文件名的话，Android 10+ 分区存储下拼出来的路径删不到东西。 */
    var dlId = r.dlId > 0 ? Number(r.dlId) : 0;
    var acts = '';
    if (ok) {
      acts += '<span class="row-act" data-open="' + name + '" data-id="' + dlId + '" title="打开">打开</span>';
    } else {
      acts += '<span class="row-act" data-retry="' + name + '" title="重新下载">重试</span>';
    }
    acts += '<span class="row-act danger" data-del="' + name + '" data-id="' + dlId + '" title="删除">' +
      window.icon('trash', 15) + '</span>';
    /* 重试需要原始地址，放在 data 里 */
    return '<div class="list-row" data-rec>' +
      '<span class="dlh-ico ' + (ok ? 'ok' : 'bad') + '">' +
      window.icon(ok ? 'check' : 'x', 15) + '</span>' +
      '<span class="row-main">' +
      '<span class="row-title mono tiny">' + name + '</span>' +
      '<span class="row-desc">' + U.esc(bits.join(' · ')) + '</span>' +
      '</span>' +
      '<span class="row-acts">' + acts + '</span>' +
      '<span class="dl-meta" hidden>' + U.esc(JSON.stringify({
        action: 'retry', name: r.name, url: r.url || '',
        install: !!r.install, sha: r.sha || ''
      })) + '</span>' +
      '</div>';
  }

  function bindHistory(host) {
    UI.$$('[data-open]', host).forEach(function (b) {
      b.onclick = function () {
        act({ action: 'open', name: b.getAttribute('data-open') });
      };
    });
    UI.$$('[data-del]', host).forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var name = b.getAttribute('data-del');
        var id = Number(b.getAttribute('data-id') || 0);
        UI.confirm('删除下载记录', '把「' + name + '」的文件和记录一起删掉？').then(function (yes) {
          if (!yes) return;
          act({ action: 'delete', name: name, dlId: id });
          setTimeout(refreshHistory, 400);
        });
      };
    });
    UI.$$('[data-retry]', host).forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var row = b.closest('[data-rec]');
        var meta = row ? row.querySelector('.dl-meta') : null;
        var name = b.getAttribute('data-retry');
        var payload = { action: 'retry', name: name };
        try {
          var m = meta ? JSON.parse(meta.textContent) : {};
          payload.url = m.url || '';
          payload.install = !!m.install;
          payload.sha = m.sha || '';
        } catch (e) { }
        if (!payload.url) { UI.toast('这条记录太老了，重试不了'); return; }
        act(payload);
        UI.toast('开始重新下载 ' + name);
        setTimeout(refreshHistory, 300);
      };
    });
  }

  function renderHistory(raw) {
    var box = document.getElementById('dl-history');
    var sec = document.getElementById('dl-hist-sec');
    if (!box || !sec) return;
    var list;
    try { list = JSON.parse(raw || '[]'); }
    catch (e) { list = []; }
    if (!list.length) {
      sec.hidden = true;
      box.innerHTML = '';
      return;
    }
    sec.hidden = false;
    var label = sec.querySelector('.dl-count');
    if (label) label.textContent = '（' + list.length + '）';
    box.innerHTML = list.map(histRow).join('');
    bindHistory(box);
  }

  function refreshHistory() {
    var raw = NB.downloadHistory();
    lastHistRaw = raw;
    renderHistory(raw);
  }

  function clearHistory() {
    UI.confirm('清空下载记录', '只清掉记录，不删除已下载的文件。继续？').then(function (yes) {
      if (!yes) return;
      act({ action: 'clear' });
      setTimeout(refreshHistory, 300);
    });
  }

  /* ---------------- 轮询 ---------------- */

  var lastHistRaw = null;   // 原始串比对：有变化才重渲染，避免每 800ms 重建 DOM

  function tick() {
    var page = document.getElementById('dl-page');
    if (!page) { stop(); return; }        // 已经离开这个页面
    var list;
    try { list = JSON.parse(NB.downloadStatus() || '[]'); }
    catch (e) { list = []; }
    /* 终态任务不进「进行中」列表：收尾（写历史/弹安装）是原生的事，
     * 这里一旦看到终态就当它不存在，避免完成后还挂在列表里。 */
    list = list.filter(function (t) {
      return t.status !== STATUS_SUCCESSFUL && t.status !== STATUS_FAILED;
    });
    renderActive(list);
    if (lastActive > 0 && !list.length) refreshHistory();   // 刚有任务收尾
    lastActive = list.length;
    var raw = NB.downloadHistory();
    if (raw !== lastHistRaw) { lastHistRaw = raw; renderHistory(raw); }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, 800);
    tick();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    lastActive = -1;
  }

  /* ---------------- 页面 ---------------- */

  P.downloads = {
    title: '下载管理',
    render: function (ctx, host) {
      host.innerHTML =
        '<div class="dl-page" id="dl-page">' +
        '<div class="section-title" id="dl-active-sec" hidden>' + window.icon('download', 14) +
        ' 进行中<span class="dl-count dl-sub"></span></div>' +
        '<div class="list" id="dl-active"></div>' +
        '<div class="section-title" id="dl-hist-sec" hidden>' + window.icon('clock', 14) +
        ' 历史记录<span class="dl-count dl-sub"></span>' +
        '<button class="dl-clear" id="dl-clear">清空记录</button></div>' +
        '<div class="list" id="dl-history"></div>' +
        '<div class="dl-note">下载的文件保存在手机的 Download/githup/ 目录，' +
        '按来源分开存放：议题里下载的在「议题」子目录，Release 里下载的在「release」子目录；' +
        '公开资源走加速通道，太慢或失败会自动换通道重试。</div>' +
        '</div>';

      var clear = UI.$('#dl-clear', host);
      if (clear) clear.onclick = clearHistory;
      refreshHistory();
      lastActive = -1;
      start();
    }
  };
})();
