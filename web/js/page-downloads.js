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

  /*
    ═══ 下载偏慢时的建议条 ═══

    原生层盯着速度：30 秒窗口内平均低于 100KB/s、10 分钟里累计 3 次，
    就调 window.DlAdvice.show() 提醒一次（参数沿用 komi-store 的取值）。

    为什么要有这一层：换道是**静默**的。用户只看到进度条一直在爬，
    不知道软件已经在后台换了好几条通道，更不知道可以自己挑一条。
    这里把那件事说出来，并给一个直达通道面板的按钮。

    只提醒一次（原生侧有 10 分钟静默），点「不再提示」后永久不再问。
  */
  var adviceOn = false;

  window.DlAdvice = {
    show: function () {
      adviceOn = true;
      try {
        UI.toast('下载偏慢，可以去「下载通道」挑一条更快的');
      } catch (e) { }
      /* 人正好在下载管理页：就地插一条，不用等下次 render */
      try {
        var box = document.getElementById('dl-page');
        if (box && !document.getElementById('dl-advice')) insertAdvice(box);
      } catch (e) { }
    },
    banner: function () { return adviceOn ? adviceHtml() : ''; }
  };

  function adviceHtml() {
    return '<div class="list dl-advice" id="dl-advice">' +
      '<div class="dl-advice-in">' +
      '<span class="dl-advice-ico">' + window.icon('alert', 16) + '</span>' +
      '<span class="row-main">' +
      '<span class="row-title">下载偏慢</span>' +
      '<span class="row-desc">软件已自动换过几次通道。可以自己挑一条 —— ' +
      '面板里能看到每条的实时速度。</span>' +
      '</span></div>' +
      '<div class="dl-advice-acts">' +
      '<button class="dl-advice-btn primary" id="dl-advice-go">去挑选</button>' +
      '<button class="dl-advice-btn" id="dl-advice-off">不再提示</button>' +
      '</div></div>';
  }

  function insertAdvice(box) {
    var wrap = document.createElement('div');
    wrap.innerHTML = adviceHtml();
    var el = wrap.firstChild;
    /* 插在最前面：一进页面就看得到，不用滚 */
    box.insertBefore(el, box.firstChild);
    bindAdvice(el);
  }

  function bindAdvice(box) {
    var go = document.getElementById('dl-advice-go');
    var off = document.getElementById('dl-advice-off');
    if (go && window.App && typeof window.App.openChannelPicker === 'function') {
      go.onclick = function () { window.App.openChannelPicker(); };
    }
    if (off) {
      off.onclick = function () {
        try { NB.dismissSlowAdvice && NB.dismissSlowAdvice(); } catch (e) { }
        adviceOn = false;
        var el = document.getElementById('dl-advice');
        if (el && el.parentNode) el.parentNode.removeChild(el);
      };
    }
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
    /*
      确切落盘位置（content:// URI 或绝对路径）。

      原生层下载完成时记下来的真实位置（见 JsBridge.queryFinalUri）。
      打开 / 删除都优先用它 —— 不用再拿文件名去拼路径猜文件在哪，
      也就不会「明明在却说不在」「删了同名文件」。
      老记录没有这个字段（空串），原生层会退回原来的按名定位。
    */
    var uri = U.esc(r.uri || '');
    /* 子目录（release / 议题 / file）：文件按来源分目录存放。
     * 原生层兜底定位（uri 查不到时按名找）要靠它，不带就只去根目录找。 */
    var sub = U.esc(r.sub || '');
    var acts = '';
    if (ok) {
      acts += '<span class="row-act" data-open="' + name + '" data-id="' + dlId +
        '" data-uri="' + uri + '" data-sub="' + sub + '" title="打开">打开</span>';
    } else {
      acts += '<span class="row-act" data-retry="' + name + '" title="重新下载">重试</span>';
    }
    acts += '<span class="row-act danger" data-del="' + name + '" data-id="' + dlId +
      '" data-uri="' + uri + '" data-sub="' + sub + '" title="删除">' +
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
        act({
          action: 'open', name: b.getAttribute('data-open'),
          uri: b.getAttribute('data-uri') || '',
          sub: b.getAttribute('data-sub') || ''
        });
      };
    });
    UI.$$('[data-del]', host).forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var name = b.getAttribute('data-del');
        var id = Number(b.getAttribute('data-id') || 0);
        UI.confirm('删除下载记录', '把「' + name + '」的文件和记录一起删掉？').then(function (yes) {
          if (!yes) return;
          act({
            action: 'delete', name: name, dlId: id,
            uri: b.getAttribute('data-uri') || '',
            sub: b.getAttribute('data-sub') || ''
          });
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
        '<button class="dl-clear" id="dl-verify">核对本地文件</button>' +
        '<button class="dl-clear" id="dl-clear">清空记录</button></div>' +
        '<div class="list" id="dl-history"></div>' +
        /*
          ═══ 这一块是 v1.2.14 之后加的「下载通道」入口，按用户要求**保留** ═══

          用户要的是：下载管理还原 v1.2.14，但脉冲图标（通道选择）那套不动。
          所以这里只保留入口，其余（历史记录的字段、说明文案、清空行为）
          全部回到 v1.2.14 的样子。
        */
        '<div class="list" id="dl-chan">' +
        '<div class="list-row ch-open" id="ch-open">' +
        '<span class="ch-ico">' + window.icon('pulse', 15) + '</span>' +
        '<span class="row-main"><span class="row-title">下载通道</span>' +
        '<span class="row-desc" id="ch-cur">自动选择（最快的通道）</span></span>' +
        '<span class="row-acts">' + window.icon('chevron-right', 16) + '</span>' +
        '</div></div>' +
        '<div class="dl-note">下载的文件按来源分目录保存：Release 附件在 ' +
          'Download/githup/release/，仓库文件在 Download/githup/file/，' +
          '议题附件在 Download/githup/议题/（其余直接放在 Download/githup/）。' +
          '记录右侧会标出这一条实际存在哪个目录；' +
        '公开资源走加速通道，太慢或失败会自动换通道重试。</div>' +
        '</div>';

      /* 原生层判定「慢」过就把建议条插在最前面 */
      var page = UI.$('#dl-page', host);
      if (page && adviceOn) insertAdvice(page);

      var clear = UI.$('#dl-clear', host);
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
      };

      /* 通道入口：点这一行打开通道选择面板（右上角脉冲按钮同款）。
         再兜底挂一次右上角脉冲按钮 —— 路由可能先 setActions 再 render，
         也可能反过来，两头都调才稳。appendChannelAction 内部有防重复，
         且只在 /downloads 生效，重复调用没有副作用。 */
      var chOpen = UI.$('#ch-open', host);
      if (chOpen && window.App && typeof window.App.openChannelPicker === 'function') {
        chOpen.onclick = function () { window.App.openChannelPicker(); };
      }
      if (window.App && typeof window.App.appendChannelAction === 'function') {
        window.App.appendChannelAction();
      }
      var chCur = UI.$('#ch-cur', host);
      if (chCur) {
        try {
          var cur = (NB.getChannel && NB.getChannel()) || '';
          if (cur && cur !== 'auto') {
            var h2 = cur;
            var i = h2.indexOf('://');
            if (i >= 0) h2 = h2.substring(i + 3);
            while (h2.charAt(h2.length - 1) === '/') h2 = h2.substring(0, h2.length - 1);
            chCur.textContent = '已指定：' + (h2 === 'direct' ? '直连' : h2);
          }
        } catch (e) { }
      }

      refreshHistory();
      lastActive = -1;
      start();
    }
  };
})();
