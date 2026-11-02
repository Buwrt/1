/* ============================================================
 * page-stats.js — 数据概览
 *
 * 把「我的仓库」里已有的数据算一算、画出来：
 *   - 总览：仓库数 / 收到的 Star / Fork / 关注者
 *   - Star 都在哪些仓库上（环形图 + 可点进仓库）
 *   - 这些仓库用什么语言写的（环形图）
 *   - 趋势：每天存一份快照，攒够几天才画折线
 *
 * 分工跟项目一贯的架构一致：**不发任何新的原生请求**，
 * 数据全走 api.js（令牌注入、加速通道、限流兜底一处没动），
 * 图表是纯 SVG 手绘 —— 不引第三方库，保持「无第三方依赖」。
 *
 * ═══ 为什么趋势图默认不显示 ═══
 *
 * GitHub API **只给当前值，不给历史**。所以趋势只能自己攒：
 * 每次进这一页存一份快照，同一天只留最后一条。
 * 刚装上只有 1 个点，画出来是一条平线，只会让人觉得这功能没用 ——
 * 所以攒够 3 天（3 个点）才把折线显示出来，之前只提示「正在攒数据」。
 *
 * 后台偷偷攒是做不到的：Android 后台执行受限，WorkManager 最短
 * 15 分钟且不保证准时。进页面时顺手记一笔，是唯一稳的路。
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});

  var SNAP_KEY = 'stats_snap';
  var SNAP_MAX = 400;        // 最多存多少天
  var TREND_MIN = 3;         // 攒够几个点才画折线
  var REPO_PAGES = 5;        // 最多翻 5 页 = 500 个仓库

  /* GitHub 的语义色，浅色深色下都能看清 */
  var PALETTE = [
    '#0969da', '#1a7f37', '#9a6700', '#8250df', '#cf222e',
    '#bf3989', '#1b7c83', '#6e7781', '#4d2d8c', '#0f766e'
  ];

  var CTX = { me: null, repos: [], includeFork: false, busy: false };

  function color(i) { return PALETTE[i % PALETTE.length]; }

  /* ---------- 环形图（纯 SVG，不引库） ---------- */

  /**
   * @param items [{label, value, color}]
   * @param center 圆心主文字 / centerSub 副文字
   */
  function donut(items, center, centerSub) {
    var size = 148, cx = size / 2, cy = size / 2;
    var sw = 24, r = size / 2 - sw / 2 - 2;
    var C = 2 * Math.PI * r;
    var total = 0;
    items.forEach(function (it) { total += it.value; });
    if (total <= 0) return '';

    var off = 0;
    var segs = items.map(function (it) {
      var len = C * (it.value / total);
      /* 段太短时留一丝缝（dasharray 减去 1），否则 0.1% 的扇区
         看起来像一条莫名其妙的细线 */
      var gap = (it.value / total) > 0.02 ? 0 : 1;
      var s = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none"'
        + ' stroke="' + it.color + '" stroke-width="' + sw + '"'
        + ' stroke-dasharray="' + Math.max(0, len - gap).toFixed(2) + ' ' + (C - len + gap).toFixed(2) + '"'
        + ' stroke-dashoffset="' + (-off).toFixed(2) + '"'
        + ' transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
      off += len;
      return s;
    }).join('');

    return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '"'
      + ' style="flex:none;display:block">'
      + '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none"'
      + ' stroke="var(--border-muted)" stroke-width="' + sw + '"/>'
      + segs
      + '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" fill="var(--fg)"'
      + ' font-size="20" font-weight="600">' + U.esc(center) + '</text>'
      + '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" fill="var(--fg-muted)"'
      + ' font-size="11">' + U.esc(centerSub) + '</text>'
      + '</svg>';
  }

  /** 迷你折线（趋势）。values 是数字数组 */
  function sparkline(values, w, h) {
    if (!values || values.length < 2) return '';
    w = w || 260; h = h || 56;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var span = max - min;
    if (span <= 0) span = 1;                 // 全平：画在中间，不要贴底边
    var pad = 6;
    var pts = values.map(function (v, i) {
      var x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * (w - pad * 2) + pad;
      var y = h - pad - ((v - min) / span) * (h - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '"'
      + ' preserveAspectRatio="none" style="display:block">'
      + '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--accent)"'
      + ' stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'
      + '<circle cx="' + pts[pts.length - 1].split(',')[0] + '" cy="' + pts[pts.length - 1].split(',')[1]
      + '" r="3" fill="var(--accent)"/></svg>';
  }

  /* ---------- 快照（趋势的数据来源） ---------- */

  function dayStart(t) {
    var d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function snapshots(login) {
    var arr = [];
    try { arr = window.Store ? window.Store.getJSON(SNAP_KEY, []) : []; } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    return arr.filter(function (x) {
      return x && x.login === login && typeof x.stars === 'number';
    }).sort(function (a, b) { return a.t - b.t; });
  }

  /**
   * 记一笔。同一天只留最后一条 —— 一天进十次不该攒十个点。
   * login 一并存进去：换账号时各算各的，不然两条曲线会串味。
   */
  function pushSnapshot(login, s) {
    try {
      if (!window.Store) return;
      var arr = snapshots(login);
      var dk = dayStart(Date.now());
      arr = arr.filter(function (x) { return x.t < dk; });   // 丢掉今天早些时候那笔
      arr.push({
        t: Date.now(), login: login,
        repos: s.repos, stars: s.stars, forks: s.forks, followers: s.followers
      });
      if (arr.length > SNAP_MAX) arr = arr.slice(arr.length - SNAP_MAX);
      /* 别的账号的快照要保住，不能只写回当前 login 的 */
      var all = [];
      try { all = window.Store.getJSON(SNAP_KEY, []); } catch (e) { all = []; }
      if (!Array.isArray(all)) all = [];
      all = all.filter(function (x) { return !x || x.login !== login; }).concat(arr);
      window.Store.setJSON(SNAP_KEY, all);
    } catch (e) { /* 攒不上不影响看数据 */ }
  }

  /* ---------- 取数 ---------- */

  function fetchAll(force) {
    var cache = force ? 0 : 300000;      // 5 分钟：这页的数据不会分钟级变化
    return Promise.all([
      window.API.get('/user', null, { cache: cache }),
      window.API.paged('/user/repos', { per_page: 100, sort: 'updated' }, REPO_PAGES, { cache: cache })
    ]).then(function (rs) {
      var me = (rs[0] && rs[0].data) || null;
      var repos = (rs[1] && rs[1].data) || [];
      if (!Array.isArray(repos)) repos = [];
      return { me: me, repos: repos };
    });
  }

  /* ---------- 汇总 ---------- */

  function summarize() {
    var repos = CTX.includeFork ? CTX.repos : CTX.repos.filter(function (r) { return !r.fork; });
    var stars = 0, forks = 0;
    var byLang = Object.create(null);
    repos.forEach(function (r) {
      stars += r.stargazers_count || 0;
      forks += r.forks_count || 0;
      var lg = String(r.language || '').trim() || '未标注';
      byLang[lg] = (byLang[lg] || 0) + 1;
    });

    var top = repos.slice().filter(function (r) { return (r.stargazers_count || 0) > 0; })
      .sort(function (a, b) { return (b.stargazers_count || 0) - (a.stargazers_count || 0); });

    return {
      repos: repos, count: repos.length, stars: stars, forks: forks,
      top: top, byLang: byLang
    };
  }

  /** 取前 N 项，其余并成「其它」 —— 不然几十种语言画出来是彩虹 */
  function topN(map, n) {
    var arr = [];
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) arr.push({ label: k, value: map[k] });
    arr.sort(function (a, b) { return b.value - a.value; });
    if (arr.length <= n) return arr;
    var head = arr.slice(0, n - 1);
    var rest = 0;
    for (var i = n - 1; i < arr.length; i++) rest += arr[i].value;
    head.push({ label: '其它', value: rest });
    return head;
  }

  /* ---------- 渲染 ---------- */

  function statCards(s, me) {
    var items = [
      { icon: 'repo', label: '仓库', value: U.num(s.count) },
      { icon: 'star', label: '收到 Star', value: U.num(s.stars) },
      { icon: 'code-square', label: '被 Fork', value: U.num(s.forks) },
      { icon: 'people', label: me && me.type === 'Organization' ? '成员' : '粉丝',
        value: U.num((me && me.followers) || 0) }
    ];
    return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      items.map(function (it) {
        return '<div class="card" style="padding:12px;display:flex;align-items:center;gap:10px">'
          + '<span style="color:var(--fg-muted)">' + window.icon(it.icon, 20) + '</span>'
          + '<span style="min-width:0">'
          + '<div style="font-size:18px;font-weight:600;line-height:1.2">' + it.value + '</div>'
          + '<div class="muted tiny">' + it.label + '</div></span></div>';
      }).join('') + '</div>';
  }

  function legend(items, total, unit, goPrefix) {
    if (!items.length) return '<div class="muted tiny" style="padding:8px 0">还没有数据</div>';
    return '<div style="flex:1;min-width:0">' + items.map(function (it, i) {
      var pct = total > 0 ? Math.round(it.value / total * 1000) / 10 : 0;
      var go = it.go ? ' data-go="' + U.esc(it.go) + '"' : '';
      var tag = go ? 'button' : 'div';
      return '<' + tag + go + ' style="display:flex;align-items:center;gap:8px;padding:5px 0;'
        + 'width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit">'
        + '<span style="flex:none;width:10px;height:10px;border-radius:2px;background:'
        + (it.color || color(i)) + '"></span>'
        + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
        + U.esc(it.label) + '</span>'
        + '<span class="muted tiny" style="flex:none">' + U.num(it.value) + unit
        + ' · ' + pct + '%</span>'
        + '</' + tag + '>';
    }).join('') + '</div>';
  }

  function chartBlock(title, sub, items, total, unit, center, centerSub) {
    var legendItems = items.map(function (it, i) {
      return {
        label: it.label, value: it.value, color: color(i),
        go: it.go || (unit === ' 个仓库' && it.label !== '其它' ? null : null)
      };
    });
    return '<div class="card" style="padding:14px">'
      + '<div style="font-weight:600;margin-bottom:2px">' + U.esc(title) + '</div>'
      + '<div class="muted tiny" style="margin-bottom:12px">' + U.esc(sub) + '</div>'
      + '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">'
      + donut(legendItems, center, centerSub)
      + legend(legendItems, total, unit)
      + '</div></div>';
  }

  function render() {
    var host = document.getElementById('view');
    var me = CTX.me;
    var s = summarize();

    /* Star 分布：图例可点进对应仓库 */
    var starItems = s.top.slice(0, 7).map(function (r) {
      return { label: r.name, value: r.stargazers_count || 0, go: '/' + r.full_name };
    });
    var starTop = starItems.slice(0, 8);
    if (s.top.length > 8) {
      var rest = 0;
      for (var i = 8; i < s.top.length; i++) rest += s.top[i].stargazers_count || 0;
      starTop.push({ label: '其它', value: rest });
    }

    var langItems = topN(s.byLang, 9).map(function (it) {
      return { label: it.label, value: it.value };
    });

    // 攒快照 + 取历史
    pushSnapshot(me && me.login, {
      repos: s.count, stars: s.stars, forks: s.forks,
      followers: (me && me.followers) || 0
    });
    var snaps = snapshots(me && me.login);

    var trendHtml;
    if (snaps.length >= TREND_MIN) {
      var vals = snaps.map(function (x) { return x.stars; });
      var d0 = snaps[0].stars, d1 = snaps[snaps.length - 1].stars;
      var delta = d1 - d0;
      var sign = delta > 0 ? '+' : '';
      trendHtml = '<div class="card" style="padding:14px">'
        + '<div style="font-weight:600">Star 总数趋势</div>'
        + '<div class="muted tiny" style="margin:2px 0 10px">已攒 ' + snaps.length + ' 天 · '
        + '相比起点 ' + sign + U.num(delta) + '</div>'
        + sparkline(vals)
        + '<div class="muted tiny" style="margin-top:6px">'
        + U.num(d0) + ' → ' + U.num(d1) + '</div></div>';
    } else {
      trendHtml = '<div class="card" style="padding:14px">'
        + '<div style="font-weight:600">Star 总数趋势</div>'
        + '<div class="muted tiny" style="margin-top:4px">正在攒数据（'
        + snaps.length + '/' + TREND_MIN + '）。'
        + 'GitHub 不提供历史数据，只能自己一天记一笔 —— 再来几天就能看到曲线了。</div></div>';
    }

    host.innerHTML = '<div style="padding:12px;display:flex;flex-direction:column;gap:12px">'
      + statCards(s, me)
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<button class="btn sm" id="st-fork">' + window.icon('repo', 13)
      + (CTX.includeFork ? ' 含 fork' : ' 不含 fork') + '</button>'
      + '<span class="muted tiny">共 ' + U.num(CTX.repos.length) + ' 个仓库'
      + (CTX.includeFork ? '' : '（已排除 ' + U.num(CTX.repos.length - s.count) + ' 个 fork）')
      + '</span></div>'
      + chartBlock('Star 分布', '收到的 Star 都落在哪些仓库上', starTop, s.stars, ' 个',
        U.num(s.stars), 'Star')
      + chartBlock('语言分布', '这些仓库主要用什么语言', langItems, s.count, ' 个',
        U.num(s.count), '仓库')
      + trendHtml
      + '<div class="muted tiny" style="padding:0 2px 8px">'
      + '数据来自 GitHub 当前值；趋势由本机每天记一笔攒出来，'
      + '换设备或清数据会重新攒。</div>'
      + '</div>';

    var fb = host.querySelector('#st-fork');
    if (fb) fb.onclick = function () { CTX.includeFork = !CTX.includeFork; render(); };

    UI.$$('[data-go]', host).forEach(function (b) {
      b.onclick = function () { window.Router.go(b.getAttribute('data-go')); };
    });

    window.App.setActions([{
      icon: 'sync', onClick: function () {
        if (CTX.busy) return;
        CTX.busy = true;
        UI.loading(true);
        fetchAll(true).then(function (r) {
          UI.loading(false); CTX.busy = false;
          if (r.me) CTX.me = r.me;
          CTX.repos = r.repos;
          render();
          UI.toast('已刷新');
        }, function () {
          UI.loading(false); CTX.busy = false;
          UI.toast('刷新失败');
        });
      }
    }]);
  }

  P.stats = {
    title: '数据概览',
    render: function (ctx, host) {
      host.innerHTML = UI.skeleton(4);
      CTX.busy = true;
      return fetchAll(false).then(function (r) {
        CTX.busy = false;
        if (!r.me) {
          host.innerHTML = UI.empty('graph', '需要登录才能看数据概览');
          return;
        }
        CTX.me = r.me;
        CTX.repos = r.repos;
        render();
      }, function () {
        CTX.busy = false;
        host.innerHTML = UI.empty('alert', '取不到数据', '检查网络或令牌配额后重试');
      });
    }
  };
})();
