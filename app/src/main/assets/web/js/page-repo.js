/* ============================================================
 * page-repo.js — 仓库主页：代码、议题、拉取请求、Actions、发布等
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});

  var TABS = [
    { key: 'code', label: '代码', icon: 'code' },
    { key: 'issues', label: '议题', icon: 'issue-opened' },
    { key: 'pulls', label: '拉取请求', icon: 'git-pull-request' },
    { key: 'actions', label: 'Actions', icon: 'workflow' },
    { key: 'releases', label: '发布', icon: 'tag' },
    { key: 'more', label: '更多', icon: 'three-bars' }
  ];
  var TAB_KEYS = TABS.map(function (t) { return t.key; });

  /* tabX：每个仓库各自记住 tab 栏横向滚到哪了。
     原来每次进/切 tab 都是全新 DOM，scrollLeft 一律归零 —— 用户为了够到最右的
     「发布」「更多」，每次都得重新拉一遍，拉完一刷新还弹回最左。

     tabX 只是内存里的值，SPA 内部切 tab 够用，但 App 重启 / WebView 重载后
     JS 重新执行，它就归零了。要真正做到「刷新后还在原位」，必须落盘一份，
     见下面的 rememberTabX / readTabX（走 Store，它优先写原生侧存储）。

     navTo：用户亲手点了哪个 tab。用来区分「主动导航」和「被动刷新」——
     主动点的要滚到可见，被动刷新的则一步都不能挪。 */
  var state = { repo: null, starred: false, watching: false, ref: null, tabX: Object.create(null), navTo: null,
                /* 已数出来的未关闭 PR 数：null=还没数，>=0=数到了，-1=没数出来 */
                pullCount: null, pullKey: null };
  var TABX_KEY = 'repoTabX', tabxTimer = 0;
  /* 程序设置横向位置的痕迹。
   *
   * .tabs 在 CSS 里开了 scroll-behavior: smooth —— 那是给手指划的手感，
   * 但程序赋值走的也是这条平滑通道：设 scrollLeft 不是瞬间到位，而是起一段
   * 几百毫秒的动画。动画还没跑完，接口回来触发的第二次渲染就把这一排按钮
   * 整块重建（paint 里 host.innerHTML 是整块重写的），新元素从 0 重新开始 ——
   * 用户看到的就是「滚过去一半又弹回左边」。接口快时必现，慢时反而看不出来。
   * 而且动画期间 scroll 连着派发，中间值会被当成「用户滑到这儿」记进记忆。
   *
   * 所以：程序设置一律走 instant（临时关掉平滑），并在这段时间里把 scroll
   * 事件认成自己干的，不记进记忆、也不当成「用户改主意了」。 */
  var progScroll = -1, progTimer = 0;
  function setTabScroll(box, x) {
    var prev = box.style.scrollBehavior;
    box.style.scrollBehavior = 'auto';
    box.scrollLeft = x;
    progScroll = x;
    // 下一帧再放开：有的内核在 style 改回去的同一帧内仍按平滑处理
    requestAnimationFrame(function () { box.style.scrollBehavior = prev; });
    clearTimeout(progTimer);
    progTimer = setTimeout(function () { progScroll = -1; }, 400);
  }

  /** 记住位置：内存即时更新，落盘防抖 200ms（scroll 太密，不能每次都写） */
  function rememberTabX(full, x) {
    state.tabX[full] = x;
    clearTimeout(tabxTimer);
    tabxTimer = setTimeout(function () {
      try {
        var m = window.Store.getJSON(TABX_KEY, null) || {};
        m[full] = Math.round(x);
        // 只留最近 50 个仓库，别让这个映射无限涨
        var keys = Object.keys(m);
        if (keys.length > 50) keys.slice(0, keys.length - 50).forEach(function (k) { delete m[k]; });
        window.Store.setJSON(TABX_KEY, m);
      } catch (e) {}
    }, 200);
  }

  /** 读位置：内存优先，没有再回落到本地存储（应对 App 重启后内存已清空） */
  function readTabX(full) {
    if (typeof state.tabX[full] === 'number') return state.tabX[full];
    try {
      var m = window.Store.getJSON(TABX_KEY, null);
      if (m && typeof m[full] === 'number') return m[full];
    } catch (e) {}
    return 0;
  }

  /* ---------------- 入口 ---------------- */
  P.repo = {
    title: function (ctx) { return ctx.owner + '/' + ctx.repo; },
    subtitle: function (ctx) { return ctx.owner; },
    render: function (ctx, host) {
      var full = ctx.owner + '/' + ctx.repo;
      var tab = ctx.tab || 'code';
      var key = 'repo_' + full;
      var cached = window.App.cacheGet(key);

      /** 只认服务端刚返回的那份，避免用缓存里的旧对象画页面 */
      var latest = null;

      /* final：这一次是不是「最终」那次渲染。
       * 有缓存时页面会画两遍 —— 先拿缓存铺骨架，等接口回来再画一遍真的。
       * 而「用户刚点了哪个 tab」(state.navTo) 只够用一次：以前在第一遍的
       * requestAnimationFrame 里就把它清了，第二遍（真正呈现在眼前那次）
       * 已经不记得用户点的是谁，只能退回去按记忆位置摆 ——
       * 于是点了最右边的「发布」，它先滚过去，数据一到又弹回左边。
       * 现在只有最终那次才清。 */
      var paint = function (repo, final) {
        state.repo = repo;
        state.ref = ctx.ref || repo.default_branch;
        host.innerHTML = headHtml(repo, tab, ctx) + '<div id="tabbody">' + UI.skeleton(4) + '</div>';
        bindHead(host, repo, tab, ctx);
        restoreTabs(host, final);
        renderTab(tab, repo, ctx, UI.$('#tabbody', host), host);
        setupFab(tab, repo, ctx);
        refreshFlags(repo, host);
        // 渲染用的是这一份，设置页里的切换就拿它当基准
        if (tab === 'settings') latest = repo;
        syncPullCount(host, repo);
      };

      /*
       * 把「拉取请求数」数出来，并据此把「议题数」修正成真实值。
       *
       * 为什么放在渲染之后单独跑 —— 数 PR 要多打一次接口，不能让它挡着
       * 页面出来（页面先按已有的字段画好，数到了再改那两个小标签）。
       * 同一个仓库 60 秒内只数一次，来回切 tab 不会反复打接口。
       */
      /* 用函数声明而不是 var —— paint 可能在下面这一行赋值之前
         就被调用（有缓存时先拿缓存画第一遍），var 提升只提到 undefined，
         那时调用会直接抛错；函数声明是整体提升，什么时候调都安全。 */
      function syncPullCount(host, repo) {
        var full = repo.full_name;
        if (!full) return;
        if (state.pullKey !== full) { state.pullCount = null; state.pullKey = full; }
        if (state.pullCount === null || state.pullCount === undefined) {
          countOpenPulls(full).then(function (n) {
            // 页面已经切到别的仓库了：这次结果作废，别改到人家的标签上
            if (state.repo !== repo || state.pullKey !== full) return;
            state.pullCount = n;
            setCnt(host, 'cnt-issues', issueCount(repo));
            setCnt(host, 'cnt-pulls', n);
          })['catch'](function () {
            if (state.repo !== repo || state.pullKey !== full) return;
            state.pullCount = -1;   // 数不出来：议题数退回用 open_issues_count
            setCnt(host, 'cnt-issues', issueCount(repo));
          });
        } else {
          // 已经数过了（切 tab 重绘）：直接把数贴回新画的标签上
          setCnt(host, 'cnt-issues', issueCount(repo));
          setCnt(host, 'cnt-pulls', state.pullCount > 0 ? state.pullCount : 0);
        }
      };

      // 缓存只用来先铺个骨架，不当作最终状态（否则上次切换的结果不会体现）
      if (cached) { paint(Object.assign({}, cached), false); }
      else {
        host.innerHTML = '<div class="repo-head"><div class="skel" style="height:18px;width:55%;margin-bottom:8px"></div>' +
          '<div class="skel" style="height:14px;width:80%"></div></div><div id="tabbody">' + UI.skeleton(4) + '</div>';
      }
      // 渲染纪元：详情接口比用户的返回键慢是常事。响应落地时页面要是
      // 已经切走（回搜索、回列表），这里整份丢弃 —— paint 会把整个 #view
      // 重写成仓库页，把刚画好的新页面顶掉，屏幕就成了「顶栏一个页、
      // 内容另一个页」的缝合画面（见 Router.render 里 viewEpoch 的注释）。
      var epoch = window.Router.viewEpoch;
      return window.API.get('/repos/' + full, null, { cache: 0, dedupe: false }).then(function (r) {
        if (epoch !== window.Router.viewEpoch) return;
        if (!r.data || !r.data.full_name) throw new Error('仓库不存在或无访问权限');
        window.App.cacheSet(key, r.data);
        paint(r.data, true);
      }).catch(function (e) {
        if (epoch !== window.Router.viewEpoch) return;
        host.innerHTML = UI.errorBox(e);
      });
    }
  };

  /* ---------- 议题 / 拉取请求 的计数 ----------
   *
   * GitHub 的 open_issues_count 是个陷阱：它【包含】未关闭的拉取请求 ——
   * 在 GitHub 内部 PR 本来就是一种特殊的 issue，所以这个字段实际是
   * 「议题 + 拉取请求」的和。直接拿它当议题数显示，就会比真实议题数大，
   * 仓库 PR 越多差得越多；而拉取请求那一栏又一直空着没有数。
   *
   * 仓库对象里并没有单独的「PR 数」字段，想分开只能自己数：
   *   拉取请求数 = 单独去数 PR（下面的 countOpenPulls）
   *   议题数     = open_issues_count - 拉取请求数
   */

  /** 真实议题数。还没数出 PR 数（null）时先不给数，
      免得先显示一个偏大的、过一会儿又跳小。 */
  function issueCount(repo) {
    var total = repo.open_issues_count || 0;
    if (!total) return 0;
    if (state.pullCount === null || state.pullCount === undefined) return 0;
    if (state.pullCount < 0) return total;      // 数不出来：退回用总数（老行为）
    var n = total - state.pullCount;
    return n > 0 ? n : 0;
  }

  /**
   * 数一个仓库有多少个未关闭的拉取请求。
   *
   * 只取 1 条（per_page=1），再看响应头 Link 里 rel="last" 指向第几页 ——
   * 那个页码就是总条数。这样不管仓库有 3 个 PR 还是 3000 个，
   * 都只花一个来回、只传回一个对象。
   */
  function countOpenPulls(fullName) {
    return window.API.get('/repos/' + fullName + '/pulls',
      { state: 'open', per_page: 1 }, { cache: 60000 })
      .then(function (r) {
        var last = r.link && r.link.last;
        if (last) {
          var m = last.match(/[?&]page=(\d+)/);
          if (m) return parseInt(m[1], 10) || 0;
        }
        // 没有 last 说明总共就一页，数一下这一页里有几条
        return (r.data && r.data.length) || 0;
      });
  }

  /** 计数小标签：数为 0 时整个藏起来，免得挂一个空气泡 */
  function cntHtml(id, n) {
    n = n || 0;
    return '<span class="cnt" id="' + id + '"'
      + (n > 0 ? '' : ' style="display:none"') + '>' + (n > 0 ? U.num(n) : '') + '</span>';
  }

  /** 只改这两个小标签 —— 整块重画会把用户刚拉到一半的 tab 栏弹回最左 */
  function setCnt(host, id, n) {
    var el = UI.$('#' + id, host);
    if (!el) return;
    if (n > 0) { el.textContent = U.num(n); el.style.display = ''; }
    else { el.textContent = ''; el.style.display = 'none'; }
  }

  function headHtml(repo, tab, ctx) {
    var parts = repo.full_name.split('/');
    var isSub = ['issues', 'pulls', 'actions', 'releases', 'commits', 'contributors', 'branches', 'tags', 'settings', 'stargazers', 'watchers', 'forks'].indexOf(tab) >= 0;
    /* tab 栏上只有六个按钮（代码/议题/拉取请求/Actions/发布/更多）。
       从「更多」里进去的那些页面（提交记录、分支、标签、里程碑、贡献者、
       协作者、仓库设置、star/fork/关注名单）在这排按钮上没有自己的位置 ——
       以前拿子页名去比对按钮，一个都对不上，于是整排按钮没有一项是高亮的，
       看着像「我没选中任何东西」。它们都从「更多」来，就高亮「更多」。 */
    var activeTab = TAB_KEYS.indexOf(tab) >= 0 ? tab : (isSub ? 'more' : 'code');
    return '<div class="repo-head">' +
      '<div class="repo-name">' + window.icon(repo.fork ? 'repo-forked' : 'repo', 16) +
      '<a class="owner" href="#/' + U.esc(parts[0]) + '">' + U.esc(parts[0]) + '</a>' +
      '<span class="slash">/</span><span class="name">' + U.esc(parts[1]) + '</span>' +
      (repo.private ? '<span class="chip" style="padding:0 6px">私有</span>' : '') +
      (repo.archived ? '<span class="chip" style="padding:0 6px">已归档</span>' : '') + '</div>' +
      (repo.description ? '<div class="repo-desc">' + U.esc(repo.description) + '</div>' : '') +
      /* 「关于」卡的内容整体上移到这条摘要里（用户要求的合并）：
         描述在顶上，接着是 topics、主页链接，再往后统计行把语言 / 许可证 /
         默认分支 / 更新时间一并带上 —— 信息还是那些信息，只是不再单独
         占一张卡、star/fork/关注也不再重复两遍。这些只在代码 tab 出现：
         议题 / PR / Actions 这些 tab 顶一坨标签纯粹是占地。 */
      (activeTab === 'code' && repo.topics && repo.topics.length ?
        '<div class="about-topics">' + repo.topics.map(function (t) {
          /* href 也过一遍 esc：& 在属性里该是 &amp;，原「关于」卡这里漏了 */
          return '<a class="chip" href="' + U.esc('#/search?q=' + encodeURIComponent('topic:' + t) + '&type=repositories') + '">' + U.esc(t) + '</a>';
        }).join('') + '</div>' : '') +
      (activeTab === 'code' && repo.homepage ?
        '<div class="about-link">' + window.icon('link', 15) +
        '<a href="' + U.esc(repo.homepage) + '" target="_blank" rel="noopener">' +
        U.esc(String(repo.homepage).replace(/^https?:\/\//, '')) + '</a></div>' : '') +
      '<div class="repo-stats">' +
      '<span data-act="stargazers">' + window.icon('star', 14) + U.num(repo.stargazers_count) + ' star</span>' +
      '<span data-act="forks">' + window.icon('repo-forked', 14) + U.num(repo.forks_count) + ' fork</span>' +
      '<span data-act="watchers">' + window.icon('eye', 14) + U.num(repo.subscribers_count) + ' 关注</span>' +
      (repo.language ? '<span><i style="width:8px;height:8px;border-radius:50%;background:' + U.langColor(repo.language) + ';display:inline-block"></i>' + U.esc(repo.language) + '</span>' : '') +
      (repo.license && repo.license.spdx_id !== 'NOASSERTION' ? '<span>' + window.icon('law', 14) + U.esc(repo.license.spdx_id) + '</span>' : '') +
      (activeTab === 'code' && repo.default_branch ? '<span>' + window.icon('git-branch', 14) + '<span class="mono">' + U.esc(repo.default_branch) + '</span></span>' : '') +
      (activeTab === 'code' && repo.pushed_at ? '<span>' + window.icon('history', 14) + '更新于 ' + U.timeAgo(repo.pushed_at) + '</span>' : '') +
      '</div>' +
      '<div class="repo-actions">' +
      '<button class="btn" id="btn-star">' + window.icon(state.starred ? 'star-fill' : 'star', 15) + '<span id="star-txt">Star</span></button>' +
      '<button class="btn" id="btn-watch">' + window.icon('eye', 15) + '<span id="watch-txt">关注</span></button>' +
      '<button class="btn" id="btn-fork">' + window.icon('repo-forked', 15) + 'Fork</button>' +
      '</div>' +
      '</div>' +
      '<div class="tabs" id="rtabs">' + TABS.map(function (t) {
        var cnt = '';
        /* 议题：open_issues_count 里混着 PR，减掉才是真的；
           拉取请求：以前这一栏一个数都没有，现在补上数出来的 PR 数。 */
        if (t.key === 'issues') cnt = cntHtml('cnt-issues', issueCount(repo));
        else if (t.key === 'pulls') cnt = cntHtml('cnt-pulls', state.pullCount || 0);
        return '<button data-t="' + t.key + '" class="' + (activeTab === t.key ? 'active' : '') + '">' +
          window.icon(t.icon, 15) + '<span>' + t.label + '</span>' + cnt + '</button>';
      }).join('') + '</div>';
  }

  function bindHead(host, repo, tab, ctx) {
    UI.$$('#rtabs button', host).forEach(function (b) {
      b.onclick = function () {
        var t = b.getAttribute('data-t');
        if (t === 'more') return moreMenu(repo);
        state.navTo = t;   // 主动导航：渲染时把这个 tab 滚进视野
        window.Router.go('/' + repo.full_name + (t === 'code' ? '' : '/' + (t === 'pulls' ? 'pulls' : t)));
      };
    });
    /* 记住用户把这一排拉到了哪（内存即时 + 落盘防抖）。
       用 passive 监听：不阻滞滚动，滚动中也不做重活（只读一个数字）。 */
    var rtabs = UI.$('#rtabs', host);
    if (rtabs) {
      rtabs.addEventListener('scroll', function () {
        var x = rtabs.scrollLeft;
        /* 自己刚设的那一下（含 ±2px 的取整误差）不算用户操作：
           既不能记进记忆（那是程序算出来的目标位，不是他滑到的地方），
           也不能当成「他改主意了」。 */
        if (progScroll >= 0 && Math.abs(x - progScroll) <= 2) return;
        /* 位置对不上 = 不是我们干的，是手指。窗口立刻作废，免得接下来
           一连串真实的滚动事件里，恰好有一下落在 ±2px 内被误吞。 */
        if (progScroll >= 0) { progScroll = -1; clearTimeout(progTimer); }
        /* 用户亲手滑了这一排：导航意图作废 —— 之后「他在哪儿」由他说的算，
           不再被下一次渲染拉回某个 tab 上。 */
        state.navTo = null;
        if (state.repo) rememberTabX(state.repo.full_name, x);
      }, { passive: true });
    }
    UI.$$('.repo-stats span[data-act]', host).forEach(function (s) {
      s.onclick = function () { window.Router.go('/' + repo.full_name + '/' + s.getAttribute('data-act')); };
    });
    UI.$('#btn-star', host).onclick = function () { toggleStar(repo, host); };
    UI.$('#btn-watch', host).onclick = function () { toggleWatch(repo, host); };
    UI.$('#btn-fork', host).onclick = function () { doFork(repo); };
  }

  /**
   * 恢复 tab 栏的横向滚动位置。
   *
   * 两个目标：
   *  1. 用户上次拉到哪，这次还在哪 —— 省掉「每次都重新拉到最后」；
   *  2. 当前高亮的那一项必须看得见。从「更多」菜单点进发布/贡献者/设置后回到
   *     仓库页，高亮项在很右边，如果还停在最左，用户会以为点没生效。
   *
   * 跑两遍是有意的：innerHTML 刚落地时宽度还没算稳，同步跑一次先到位，
   * 下一帧再对一次，避免布局撑开后被夹回去。
   */
  function restoreTabs(host, final) {
    var box = UI.$('#rtabs', host);
    if (!box || !state.repo) return;
    var full = state.repo.full_name;
    var apply = function () {
      /* ⓪ 高亮落在「代码」：把这一排拉回最左。

         「代码」是这一排的第一个按钮，它要是在视野外，用户看到的就是
         「页面确实回到代码了，可那一排还停在后面」—— 高亮看不见，
         像没生效。什么时候会这样？

           · 从「发布」「更多」按返回回到代码：位置记忆还记着右边
             （用户上次为了够到「发布」拉过去的），而返回不是点击，
             navTo 是空的，于是下面 ② 会照着记忆原样恢复到右边；
           · 任何其它「人已经在代码 tab」的渲染。

         所以只要高亮是代码，就无条件归零，并把记忆一起清掉 ——
         不然下次再回来又被记忆拽到右边。

         只认代码 tab：在「发布」「议题」上刷新，位置照旧不动
         （那是「刷新后位置不跑」，另一条需求，不能一起改没）。 */
      var first = UI.$('#rtabs button.active', host);
      if (first && first.getAttribute('data-t') === 'code') {
        setTabScroll(box, 0);
        rememberTabX(full, 0);
        return;
      }
      /* ① 主动点了某个 tab：把它滚进视野。这是导航不是刷新 ——
            点哪个就该看见哪个，此时记忆位置让位。 */
      if (state.navTo) {
        var btn = UI.$('#rtabs button[data-t="' + state.navTo + '"]', host);
        if (btn) { ensureTabVisible(box, btn, true); return; }
        /* 从「更多」里选的页面在栏上没有自己的按钮（提交记录、分支…）——
           退一步让高亮的那枚「更多」露出来，别停在原地让人以为没点上。 */
        var nav = UI.$('#rtabs button.active', host);
        if (nav) { ensureTabVisible(box, nav, true); return; }
      }
      /* ② 否则：有记忆就原样恢复，一步都不挪。
            这里是「刷新后位置不动」的关键 —— 不能因为高亮项（比如最左的
            「代码」）不在视野里就把它拉回去，那正是「刷新一下又跑了」。
            用户自己滑到哪儿，就是哪儿。 */
      var remembered = readTabX(full);
      if (remembered > 0) { setTabScroll(box, remembered); return; }
      /* ③ 首次进这个仓库、还没有记忆：让高亮项露出来 */
      var active = UI.$('#rtabs button.active', host);
      if (active) ensureTabVisible(box, active, true);
    };
    apply();
    /* navTo 只在最终那次渲染后才清 —— 见上面 paint(repo, final) 的注释：
       先铺骨架再画真的这两遍，都得记得用户点的是哪个 tab。 */
    requestAnimationFrame(function () { apply(); if (final) state.navTo = null; });
  }

  /** 把 el 滚进 box 的可视范围；center=true 时居中，否则只做最小移动 */
  function ensureTabVisible(box, el, center) {
    var l = el.offsetLeft, r = l + el.offsetWidth;
    var vl = box.scrollLeft, vr = vl + box.clientWidth;
    var max = Math.max(0, box.scrollWidth - box.clientWidth);
    if (l >= vl && r <= vr) return;
    var target = center
      ? Math.max(0, l - (box.clientWidth - el.offsetWidth) / 2)
      : (l < vl ? l - 12 : r - box.clientWidth + 12);
    setTabScroll(box, Math.max(0, Math.min(target, max)));
  }

  function refreshFlags(repo, host) {
    if (!window.Session.isLogin) return;
    /* 这两个请求原来是 cache: 0 —— 每进一次仓库页都各发一次，跟页面的
     * 内容请求、跟翻译请求一起抢那 8 个原生网络线程。
     * 给 30 秒缓存：这两个标志（是否已 Star / 是否关注）不会自己变，
     * 用户亲手点了也有本地状态顶上（见 toggleStar / toggleWatch），
     * 30 秒内看到旧值的概率极低，省下的是每次进详情页的两个来回。 */
    window.API.get('/user/starred/' + repo.full_name, null, { cache: 30000 }).then(function () {
      state.starred = true; paintFlags(host);
    }).catch(function (e) { state.starred = !(e.status === 404); paintFlags(host); });
    window.API.get('/repos/' + repo.full_name + '/subscription', null, { cache: 30000 }).then(function (r) {
      state.watching = !!(r.data && (r.data.subscribed || r.data.reason)); paintFlags(host);
    }).catch(function () { state.watching = false; paintFlags(host); });
  }
  function paintFlags(host) {
    var st = UI.$('#star-txt', host), wt = UI.$('#watch-txt', host);
    if (st) st.textContent = state.starred ? '已 Star' : 'Star';
    if (wt) wt.textContent = state.watching ? '已关注' : '关注';
  }
  function toggleStar(repo, host) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    var next = !state.starred;
    var call = next ? window.API.put('/user/starred/' + repo.full_name, {}) : window.API.del('/user/starred/' + repo.full_name);
    call.then(function () {
      state.starred = next; paintFlags(host);
      repo.stargazers_count += next ? 1 : -1;
      UI.toast(next ? '已 Star' : '已取消 Star');
    }).catch(function (e) { UI.toast('操作失败：' + e.message); });
  }
  function toggleWatch(repo, host) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    var next = !state.watching;
    window.API.put('/repos/' + repo.full_name + '/subscription', { subscribed: next, ignored: false }).then(function () {
      state.watching = next; paintFlags(host); UI.toast(next ? '已关注' : '已取消关注');
    }).catch(function (e) { UI.toast('操作失败：' + e.message); });
  }
  function doFork(repo) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    UI.confirm('Fork 仓库', '将在你的账号下创建 ' + repo.full_name + ' 的副本。', 'Fork').then(function (ok) {
      if (!ok) return;
      UI.loading(true);
      window.API.post('/repos/' + repo.full_name + '/forks', {}).then(function (r) {
        UI.loading(false);
        UI.toast('Fork 成功');
        if (r.data && r.data.full_name) window.Router.go('/' + r.data.full_name);
      }).catch(function (e) { UI.loading(false); UI.toast('Fork 失败：' + e.message); });
    });
  }

  function moreMenu(repo) {
    UI.menu('更多', [
      { icon: 'git-commit', label: '提交记录', key: 'commits' },
      { icon: 'people', label: '贡献者', key: 'contributors' },
      { icon: 'git-branch', label: '分支', key: 'branches' },
      { icon: 'tag', label: '标签', key: 'tags' },
      { icon: 'milestone', label: '里程碑', key: 'milestones' },
      { icon: 'people', label: '协作者', key: 'collaborators' },
      { icon: 'star', label: '加入列表', key: 'starlists' },
      { icon: 'gear', label: '仓库设置', key: 'settings' },
      '-',
      { icon: 'link-external', label: '在浏览器打开', key: 'web' },
      { icon: 'share-android', label: '分享仓库', key: 'share' },
      { icon: 'copy', label: '复制克隆地址', key: 'clone' }
    ]).then(function (k) {
      if (!k) return;
      if (k === 'web') return window.NativeBridge && NativeBridge.openExternal ? NativeBridge.openExternal(repo.html_url) : window.open(repo.html_url, '_blank');
      if (k === 'share') return window.NativeBridge && NativeBridge.share ? NativeBridge.share(repo.html_url, repo.full_name) : UI.copy(repo.html_url, '链接已复制');
      if (k === 'clone') return UI.copy(repo.clone_url, '克隆地址已复制');
      if (k === 'starlists') return window.StarLists ? window.StarLists.picker(repo) : UI.toast('列表功能加载失败');
      state.navTo = k;   // 从「更多」里选的也是主动导航，同理滚进视野
      window.Router.go('/' + repo.full_name + '/' + k);
    });
  }

  function setupFab(tab, repo, ctx) {
    var fab = document.getElementById('fab');
    if (tab === 'issues') {
      fab.hidden = false; fab.innerHTML = window.icon('plus', 24);
      fab.onclick = function () { newIssue(repo); };
    } else if (tab === 'releases') {
      // 有写权限才显示发布按钮
      var can = canPush(repo);
      fab.hidden = !can;
      if (can) {
        fab.innerHTML = window.icon('tag', 22);
        fab.onclick = function () { newRelease(repo); };
      }
    } else if (tab === 'pulls') {
      fab.hidden = false; fab.innerHTML = window.icon('git-compare', 22);
      fab.onclick = function () { newPullRequest(repo); };
    } else {
      fab.hidden = true;
    }
  }

  /* ---------------- Tab 分发 ---------------- */
  function renderTab(tab, repo, ctx, box, host) {
    switch (tab) {
      case 'issues': return tabIssues(repo, ctx, box);
      case 'pulls': return tabPulls(repo, ctx, box);
      case 'actions': return tabActions(repo, ctx, box);
      case 'releases': return tabReleases(repo, ctx, box);
      case 'commits': return tabCommits(repo, ctx, box);
      case 'contributors': return tabContributors(repo, ctx, box);
      case 'branches': return tabRefs(repo, ctx, box, 'branches');
      case 'tags': return tabRefs(repo, ctx, box, 'tags');
      case 'stargazers': return tabPeople(repo, ctx, box, 'stargazers', 'Star 的人');
      case 'watchers': return tabPeople(repo, ctx, box, 'subscribers', '关注者');
      case 'forks': return tabForks(repo, ctx, box);
      case 'milestones': return tabMilestones(repo, ctx, box);
      case 'settings': return tabSettings(repo, ctx, box);
      case 'collaborators': return tabCollaborators(repo, ctx, box);
      default: return tabCode(repo, ctx, box);
    }
  }

  /* ============ 代码 ============ */
  function tabCode(repo, ctx, box) {
    var ref = ctx.ref || repo.default_branch;
    var path = ctx.path || '';
    state.ref = ref;

    if (ctx.kind === 'blob' && path) return showFile(repo, ref, path, box, ctx.query.view === 'src');

    box.innerHTML = '<div class="breadcrumb" id="bc"></div>' +
      /* 看的不是默认分支时给一条提示：目录长得不一样很容易被误判成「这仓库
         怎么少了一堆文件」，说一句「你正在看 X」能省掉这个误会，顺手给一个
         回默认分支的口子。放在面包屑**外面**——面包屑是单行横向滚动的，
         塞进去会被文件按钮挤到视野外，等于白给。 */
      (ref !== repo.default_branch ? '<div class="ref-note" id="refnote">' +
        window.icon('info', 12) + '<span>正在看 <b class="mono">' + U.esc(ref) + '</b>，不是默认分支</span>' +
        '<span class="ref-note-go">回到 ' + U.esc(repo.default_branch) + '</span></div>' : '');
    var bc = UI.$('#bc', box);
    bc.innerHTML = '<button data-root="1">' + window.icon('repo', 14) + '</button>' +
      '<button data-root="1" style="margin-left:4px">' + U.esc(repo.name) + '</button>' +
      '<span style="margin-left:auto;display:flex;align-items:center;gap:6px">' +
      /* 上传是把本地文件搬进来，新建是直接在仓库里写一份 —— 官网的 Add file
         下拉里这两项是分开的，这里也给两个口子。 */
      (canPush(repo) ? '<button id="nfbtn" title="新建文件" style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:3px 8px">' +
        window.icon('plus', 13) + '</button>' : '') +
      (window.Session.isLogin ? '<button id="upbtn" title="上传文件" style="display:flex;align-items:center;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:3px 8px">' +
        window.icon('upload', 13) + '</button>' : '') +
      refBtnHtml(ref, repo) +
      '</span>';
    // 面包屑：一层一层往回退，而不是不管在第几层都跳回仓库首页
    // 当前层自己不给点（点了是原地重载，看着像"卡住"）
    // 插入位置在右侧按钮组之前，顺序才对：仓库名 › 一级 › 二级
    var crumbs = path ? path.split('/') : [];
    var tail = bc.lastElementChild;
    crumbs.forEach(function (name, i) {
      var sub = crumbs.slice(0, i + 1);
      var btn = document.createElement('button');
      btn.className = 'crumb-seg';
      btn.innerHTML = window.icon('chevron-right', 12) + '<span>' + U.esc(name) + '</span>';
      btn.onclick = function () {
        if (i === crumbs.length - 1) return;
        window.Router.go(refUrl(repo, 'tree', sub.join('/'), ref));
      };
      bc.insertBefore(btn, tail);
    });
    // 回到仓库根目录；已经在根目录就不重复加载（否则看着像点了没反应）
    UI.$$('#bc > button[data-root="1"]', bc).forEach(function (b) {
      b.onclick = function () {
        if (!path) return;
        window.Router.go(refUrl(repo, 'tree', '', ref));
      };
    });
    UI.$('#refbtn', bc).onclick = function () { pickRef(repo, ref, path, 'tree'); };
    var backNote = UI.$('#refnote', box);
    if (backNote) backNote.onclick = function () {
      window.Router.go(refUrl(repo, 'tree', path, repo.default_branch));
    };
    var up = UI.$('#upbtn', bc);
    if (up) up.onclick = function () { uploadFile(repo, ref, path); };
    var nf = UI.$('#nfbtn', bc);
    if (nf) nf.onclick = function () { newFile(repo, ref, path); };

    return Promise.all([
      window.API.get('/repos/' + repo.full_name + '/contents/' + encodePath(path), { ref: ref }, { cache: 30000 }),
      path ? null : window.API.get('/repos/' + repo.full_name + '/readme', { ref: ref }, { cache: 60000 }).catch(function () { return null; }),
      path ? null : window.API.get('/repos/' + repo.full_name + '/languages', null, { cache: 300000 }).catch(function () { return null; })
    ]).then(function (rs) {
      var entries = rs[0].data || [];
      if (!Array.isArray(entries)) return showFile(repo, ref, path, box);
      entries.sort(function (a, b) {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'dir' ? -1 : 1;
      });
      var html = '<div class="list">' + entries.map(function (e) {
        var isDir = e.type === 'dir';
        var sub = isDir ? '' : '<span class="fmeta">' + U.bytes(e.size) + '</span>';
        // 在子目录里，接口返回的 path 是相对当前目录的（GitHub 就是这个约定），
        // 直接拼会把父级目录丢掉，点进去就跳到同级去了。这里补全成完整路径。
        var full = String(e.path || e.name || '');
        if (path && full.indexOf(path + '/') !== 0) full = path + '/' + full;
        // 目录名里的 # 和 ? 不转义会在 hash 路由里被当成片段/查询分隔符，
        // 结果就是点进去跳回仓库首页，所以路径必须走 encodePath
        var target = refUrl(repo, isDir ? 'tree' : 'blob', full, ref);
        return '<button class="file-row" data-go="' + U.esc(target) + '">' +
          '<span class="file-ico' + (isDir ? ' dir' : '') + '">' + window.icon(isDir ? 'file-directory-fill' : 'file', 16) + '</span>' +
          '<span class="fname">' + U.esc(e.name) + '</span>' + sub + '</button>';
      }).join('') + '</div>';

      // 根目录额外拼上「关于」卡片、语言分布和 README；
      // 子目录只用文件列表（原来整块都写在 if (!path) 里，
      // 导致点进任何文件夹都只剩一个空壳）
      if (!path) html = cloneCard(repo) + html;

      // README 在根目录默认展开；子目录里有 README 也在列表下面带上
      if (path && entries.some(function (e) { return /^readme(\.md|\.markdown)?$/i.test(e.name); })) {
        rs[1] = null;   // 子目录不重复请求 /readme，由下面按需加载
      }

      if (!path) {
        var langs = rs[2] && rs[2].data;
        if (langs && Object.keys(langs).length) {
          html += '<div class="card"><div class="list-row static" style="flex-direction:column;align-items:stretch">' +
            '<div style="font-weight:600;margin-bottom:4px">语言</div>' + UI.langBar(langs) + '</div></div>';
        }
        var readme = rs[1] && rs[1].data;
        if (readme && readme.content) {
          /* 文件页对 .md 默认渲染（官网 Preview 同款）。这枚按钮写的是
             「查看源码」，就得真的落在源码上 —— 带着 view=src 进去。 */
          var rmUrl = refUrl(repo, 'blob', readme.path, ref);
          html += '<div class="card"><div class="list-row static" style="flex-direction:column;align-items:stretch">' +
            '<div class="rowflex" style="justify-content:space-between;margin-bottom:8px">' +
            '<span style="font-weight:600">' + U.esc(readme.name) + '</span>' +
            '<button class="btn sm" data-go="' + U.esc(rmUrl + (rmUrl.indexOf('?') >= 0 ? '&' : '?') + 'view=src') + '">查看源码</button></div>' +
            '<div id="readme"></div></div></div>';
        }
      }

      box.insertAdjacentHTML('beforeend', html);
      window.bindRepoCards(box);
      if (!path) {
        bindAbout(repo, box);
        var rm = UI.$('#readme', box);
        if (rm) {
          var rdata = rs[1].data;
          // 带上 ref 和 README 自己的路径：图片多为相对地址，
          // 渲染器要靠这俩才能补成 raw 地址（见 md.js 的 resolveImgUrl）
          window.MD.mount(rm, U.decodeBase64(rdata.content),
            { repo: repo.full_name, ref: ref, path: rdata.path });
          /* README 是文件列表画完之后才被塞进来的，翻译的第一轮根本看不见它。
           * 这里打一声招呼：翻译模块认出 .md 容器，会按整篇模式一次翻完，
           * 而不是等用户一屏一屏往下滚（实测一篇 1813 段的 README，
           * 滚动驱动要 25 秒才翻完，整篇模式 2.4 秒）。 */
          if (window.UI) UI.noticeRefresh(rm);
        }
      }
      window.bindHashLinks(box);
    }).catch(function (e) {
      box.insertAdjacentHTML('beforeend', e.status === 404 ? UI.empty('file', '路径不存在', U.esc(path) + ' 在 ' + ref + ' 上找不到')
        : UI.errorBox(e));
    });
  }

  function encodePath(p) { return String(p || '').split('/').map(encodeURIComponent).join('/'); }

  /**
   * 是否对仓库有写权限。
   * 官方 API 在 permissions 里给 push/admin；但部分接口（如搜索结果、缓存数据）
   * 不带 permissions，此时用「仓库归属人 == 当前登录用户」兜底，避免自己的仓库
   * 反而看不到新建/上传/发布入口。
   */
  function canPush(repo) {
    if (!window.Session.user) return false;
    if (repo.permissions && (repo.permissions.push || repo.permissions.admin)) return true;
    var owner = repo.owner || {};
    return !!owner.login && owner.login === window.Session.user.login;
  }

  /* ---------------- 克隆地址卡（原「关于」卡剩下的那部分） ----------------
   * 「关于」卡的正文（描述 / topics / 主页链接 / 许可证 / 分支 / 更新时间 /
   * star·fork·关注）已经整体上移进页首的摘要条 —— 那条本来就有描述和
   * star/fork/关注，信息留在两张卡里只会重复两遍、还占一整屏。
   * 卡片里跟正文无关的克隆地址块是件正经工具，单独留成一张卡。 */
  function cloneCard(repo) {
    return '<div class="card about-card"><div class="clone-box" style="margin-top:0;border-top:0;padding-top:0">' +
      '<div class="clone-head"><span class="t">克隆地址</span>' +
      '<button class="btn sm" id="clone-copy">' + window.icon('copy', 13) + '<span id="clone-copy-t">复制</span></button></div>' +
      '<div class="clone-seg" id="clone-seg">' +
      '<button data-k="https" class="active">HTTPS</button>' +
      '<button data-k="ssh">SSH</button>' +
      '<button data-k="zip">下载 ZIP</button>' +
      '</div>' +
      '<div class="clone-row">' +
      '<input class="input" id="clone-input" type="text" readonly spellcheck="false" autocomplete="off">' +
      '</div>' +
      '<div class="clone-tip" id="clone-tip">点击输入框可全选地址，长按可复制。</div>' +
      '</div></div>';
  }

  function bindAbout(repo, box) {
    var input = UI.$('#clone-input', box);
    if (!input) return;
    var urls = {
      https: repo.clone_url || ('https://github.com/' + repo.full_name + '.git'),
      ssh: repo.ssh_url || ('git@github.com:' + repo.full_name + '.git'),
      zip: repo.html_url + '/archive/refs/heads/' + (repo.default_branch || 'main') + '.zip'
    };
    var kind = 'https';

    var paint = function () {
      input.value = urls[kind] || '';
      input.title = urls[kind] || '';
      var tip = UI.$('#clone-tip', box);
      if (tip) {
        tip.textContent = kind === 'zip' ? '点击输入框可全选地址，或点右上角复制。' : '点击输入框可全选地址，长按可复制。';
      }
      var cb = UI.$('#clone-copy-t', box);
      if (cb) cb.textContent = kind === 'zip' ? '复制链接' : '复制';
    };
    paint();

    UI.$$('#clone-seg button', box).forEach(function (b) {
      b.onclick = function () {
        kind = b.getAttribute('data-k');
        UI.$$('#clone-seg button', box).forEach(function (x) { x.classList.toggle('active', x === b); });
        paint();
      };
    });

    // 点击输入框 -> 自动全选，便于用户直接用键盘/输入法操作
    input.onclick = function () { input.focus(); input.select(); };
    input.onfocus = function () {
      // 粘性全选：避免每次点都反选
      if (input.selectionStart === input.selectionEnd) input.setSelectionRange(0, input.value.length);
    };

    var copyBtn = UI.$('#clone-copy', box);
    if (copyBtn) {
      copyBtn.onclick = function () {
        UI.copy(urls[kind], kind === 'zip' ? '下载链接已复制' : '克隆地址已复制');
        var t = UI.$('#clone-copy-t', box);
        if (t) { var old = t.textContent; t.textContent = '已复制'; setTimeout(function () { t.textContent = old; }, 1500); }
      };
    }
  }

  /**
   * 切换分支 / 标签 / 提交的选择器。
   *
   * 原来这里只是把 100 条分支和 100 条标签平铺出来，实际用起来有三个够不着：
   *   1. 分支多的仓库（几百条）找不到 —— 现在有搜索框；
   *   2. 超过 100 条就看不到后面的了 —— 现在能一页一页往下加载；
   *   3. 列表里没有的老标签、或者想直接看某次提交 —— 现在能手动填名字/SHA。
   *
   * 切换后**留在当前路径**：在 src/main.js 上切分支，切完还在 src/main.js
   * （新 ref 上没有这个文件时会退回目录视图，见 showFile 的兜底）。
   */
  function pickRef(repo, cur, path, kind) {
    var PAGE = 100;
    var st = { tab: 'branches', q: '', loaded: {}, done: {}, list: {}, err: {} };
    st.list.branches = []; st.list.tags = [];
    st.loaded.branches = 0; st.loaded.tags = 0;
    st.done.branches = false; st.done.tags = false;
    st.err.branches = false; st.err.tags = false;

    function load(which, cb) {
      if (st.done[which]) return cb && cb();
      var page = Math.floor(st.loaded[which] / PAGE) + 1;
      window.API.get('/repos/' + repo.full_name + '/' + which, { per_page: PAGE, page: page }, { cache: 60000 })
        .then(function (r) {
          var arr = r.data || [];
          st.list[which] = st.list[which].concat(arr);
          st.loaded[which] = st.list[which].length;
          if (arr.length < PAGE) st.done[which] = true;
          cb && cb();
        })
        .catch(function () {
          /* 拉失败和「真的没有」要分开说。原来两种情况都只显示一个空列表，
             标签本来就没有的仓库和标签拉挂了的仓库长得一模一样，
             用户只能猜是不是自己网络的问题。 */
          st.err[which] = true;
          st.done[which] = true;
          cb && cb();
        });
    }

    /** 分段标题上的数量。没加载出来时不标数字，免得「分支 ()」这种半截样子 */
    function segLabel(key, base) {
      if (!st.done[key] && !st.loaded[key]) return base;
      return base + ' (' + st.loaded[key] + ')';
    }

    /** 相对时间：标签列表里分得清哪个新哪个旧，比一串 SHA 有用 */
    function relTime(iso) {
      if (!iso) return '';
      return U.timeAgo(iso);
    }

    function rowsHtml() {
      var which = st.tab;
      var q = st.q.trim().toLowerCase();
      var all = st.list[which];
      var hit = q ? all.filter(function (x) { return String(x.name).toLowerCase().indexOf(q) >= 0; }) : all;
      var isTag = which === 'tags';
      var noun = isTag ? '标签' : '分支';
      if (!hit.length) {
        if (q) {
          return UI.empty(isTag ? 'tag' : 'git-branch', '没有匹配「' + U.esc(st.q) + '」的' + noun,
            '换一个关键词，或点下面「手动输入」直接填名字');
        }
        /* 三种「空」要分清：加载失败 / 这个仓库真没有 / 还在路上。
           原来一律显示「暂无标签」，拉挂了看着和真没有一样。 */
        if (st.err[which]) {
          return UI.empty(isTag ? 'tag' : 'git-branch', noun + '没加载出来',
            '网络或接口出了点问题。点下面「手动输入」可以直接填名字，不用等列表。');
        }
        if (st.done[which]) {
          return UI.empty(isTag ? 'tag' : 'git-branch', '这个仓库还没有' + noun,
            isTag ? '还没有打过任何版本标签。也点下面「手动输入」直接填提交号看某一版。'
                  : '点下面「手动输入」可以直接填名字。');
        }
        return '<div class="ref-loading"><div class="spinner"></div><span>正在加载' + noun + '…</span></div>';
      }
      return '<div class="list">' + hit.map(function (x) {
        var name = x.name;
        var isDef = which === 'branches' && name === repo.default_branch;
        var when = relTime(x.commit && (x.commit.commit && x.commit.commit.author
          ? x.commit.commit.author.date : x.commit.date));
        return '<button class="list-row' + (name === cur ? ' sel' : '') + '" data-r="' + U.esc(name) + '">' +
          '<span style="color:var(--fg-muted)">' + window.icon(isTag ? 'tag' : 'git-branch', 16) + '</span>' +
          '<span class="row-main"><span class="row-title mono">' + U.esc(name) + '</span>' +
          (x.commit && x.commit.sha ? '<span class="row-desc mono">' + U.esc(x.commit.sha.substring(0, 7)) + '</span>' : '') + '</span>' +
          (when ? '<span class="row-desc">' + U.esc(when) + '</span>' : '') +
          (isDef ? '<span class="chip">默认</span>' : '') +
          (x.protected ? '<span class="chip">' + window.icon('shield', 12) + '</span>' : '') +
          (name === cur ? '<span style="color:var(--accent)">' + window.icon('check', 16) + '</span>' : '') + '</button>';
      }).join('') + '</div>' +
        (!st.done[which] ? '<button class="btn block mt8" id="refmore">加载更多</button>' : '');
    }

    UI.sheet({
      title: '切换分支 / 标签', full: true,
      body: '<div class="ref-pick">' +
        '<div class="ref-hint">当前：<b class="mono">' + U.esc(cur || repo.default_branch) + '</b>' +
        (path ? '　·　切完仍停在 <span class="mono">' + U.esc(path) + '</span>' : '') + '</div>' +
        '<div id="refsegwrap">' + UI.seg('refseg',
          [{ key: 'branches', label: segLabel('branches', '分支') },
           { key: 'tags', label: segLabel('tags', '标签 / 版本') }], 'branches') + '</div>' +
        '<div class="search-bar" style="position:static;border:0;padding:8px 0">' +
        '<div class="search-input">' + window.icon('search', 15) +
        '<input id="refq" type="search" placeholder="搜索分支名" autocomplete="off" style="flex:1;min-width:0;border:0;background:none;outline:none;font-size:15px;color:var(--fg);font-family:inherit"></div></div>' +
        '<div id="reflist">' + '<div class="ref-loading"><div class="spinner"></div><span>正在加载…</span></div>' + '</div>' +
        '<button class="btn block mt8" id="refmanual">手动输入分支名 / 标签名 / 提交号</button>' +
        '</div>',
      onMount: function (body) {
        var listBox = UI.$('#reflist', body);
        var input = UI.$('#refq', body);
        var segWrap = UI.$('#refsegwrap', body);

        function paint() {
          listBox.innerHTML = rowsHtml();
          UI.$$('.list-row', listBox).forEach(function (b) {
            b.onclick = function () { goRef(b.getAttribute('data-r')); };
          });
          var more = UI.$('#refmore', listBox);
          if (more) more.onclick = function () {
            more.textContent = '加载中…';
            load(st.tab, paint);
          };
          /* 分段上的数量要跟着加载进度更新，所以每次重画都要把标签换掉。
             重建整块并把点击重新挂上，比只改文字更省心（按钮就两个）。 */
          var cur0 = st.tab;
          segWrap.innerHTML = UI.seg('refseg',
            [{ key: 'branches', label: segLabel('branches', '分支') },
             { key: 'tags', label: segLabel('tags', '标签 / 版本') }], cur0);
          bindSeg();
        }

        function bindSeg() {
          UI.$$('#refseg button', segWrap).forEach(function (b) {
            b.onclick = function () {
              st.tab = b.getAttribute('data-v');
              st.q = input.value = '';
              input.placeholder = st.tab === 'tags' ? '搜索标签 / 版本号' : '搜索分支名';
              if (!st.loaded[st.tab] && !st.done[st.tab]) {
                listBox.innerHTML = '<div class="ref-loading"><div class="spinner"></div><span>正在加载…</span></div>';
                load(st.tab, paint);
              } else paint();
            };
          });
        }

        function goRef(r) {
          if (!r || r === cur) return UI.closeSheet();
          UI.closeSheet();
          /* 目标是文件就还去文件（新 ref 上没有这个文件，showFile 会兜底
             退回目录），是目录就去目录 —— 总之不把人丢回仓库首页。 */
          window.Router.go(refUrl(repo, (kind === 'blob' ? 'blob' : 'tree'), path, r));
        }

        /* 输入即过滤（本地过滤已加载的）。不加防抖：这里最多几百条，
           每次按键重画一遍列表的开销肉眼看不见，加了反而有输入延迟感。 */
        input.oninput = function () { st.q = input.value; paint(); };

        UI.$('#refmanual', body).onclick = function () {
          UI.prompt('查看指定的分支 / 标签 / 提交', {
            desc: '填分支名（如 feature/login）、标签名（如 v1.1.5）或某次提交的完整 SHA。' +
                  '列表里没列全的老版本也能这么看。',
            value: '', placeholder: 'main / v1.1.5 / 提交号'
          }).then(function (v) {
            v = (v || '').trim();
            if (v) goRef(v);
          });
        };

        bindSeg();
        load('branches', paint);
        /* 标签顺手预取：多数人切过去是要找某个老版本，点开就在，不用等一轮。
           预取回来如果数量变了，分段上的数字要跟着更新。 */
        load('tags', function () {
          if (st.tab === 'tags') paint();
          else UI.$$('#refseg button', segWrap).forEach(function (b) {
            if (b.getAttribute('data-v') === 'tags') {
              b.textContent = segLabel('tags', '标签 / 版本');
            }
          });
        });
      }
    });
  }

  /**
   * 生成一个 ref 下的链接。
   * ref 走 ?ref= 而不是塞在路径里 —— 见 app.js parseHash 里的说明。
   */
  function refUrl(repo, kind, path, ref) {
    var base = '/' + repo.full_name + '/' + kind + (path ? '/' + encodePath(path) : '');
    if (!ref) return base;
    return base + '?ref=' + encodeURIComponent(ref);
  }

  /** 面包屑/文件头里那枚「当前 ref」按钮：点开就能换分支、换标签、换版本 */
  function refBtnHtml(ref, repo) {
    var isDef = ref === repo.default_branch;
    return '<button id="refbtn" class="' + (isDef ? '' : 'alt') + '" style="display:flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:3px 8px">' +
      window.icon('git-branch', 13) + '<span>' + U.esc(ref || repo.default_branch) + '</span>' + window.icon('chevron-down', 12) + '</button>';
  }

  /* ---- 单文件查看 ---- */
  /* Markdown 文件的双态视图：官网的文件页对 .md 默认就是 Preview ——
   * README 里的语言切换、目录里的文档链接，点进来该看到的是排版好的正文，
   * 不是一屏行号。以前这里只有源码，于是点「简体中文」落到的是
   * README.zh-CN.md 的代码页，跟官网的行为对不上。
   * 源码仍一键可切；README 卡片上那枚「查看源码」带着 ?view=src 进来，
   * 落地就是源码态，语义不变。 */
  function mountMdViewer(text, box, repo, ref, path, name, startInSrc) {
    var body = UI.$('#fbody', box);
    var bar = '<div class="rowflex" style="gap:6px;padding:8px 14px;border-bottom:1px solid var(--border-muted)">' +
      '<button class="btn sm" data-mdv="render">渲染</button>' +
      '<button class="btn sm" data-mdv="code">源码</button></div>';
    function setBtn(active) {
      UI.$$('button[data-mdv]', body).forEach(function (b) {
        b.classList.toggle('primary', b.getAttribute('data-mdv') === active);
      });
    }
    function paintRender() {
      /* .md 自带的是排版，不带外边距（README 卡片的外壳才是 .card）；
         文件页没有那层壳，得自己留白，否则正文贴着边缘。 */
      body.innerHTML = bar + '<div id="mdv" style="padding:14px"></div>';
      /* path 原样传给渲染器：相对图片要按这份文档自己的目录去补 raw 地址，
         和官网在 Preview 里显示这张图用的是同一条路。 */
      window.MD.mount(UI.$('#mdv', body), text, { repo: repo.full_name, ref: ref, path: path });
      setBtn('render');
      UI.$('button[data-mdv="code"]', body).onclick = paintSource;
    }
    function paintSource() {
      body.innerHTML = bar + '<div id="srcholder"></div>';
      paintCode(text, name, box, 'srcholder');
      setBtn('code');
      UI.$('button[data-mdv="render"]', body).onclick = paintRender;
    }
    /* 从「查看源码」进来的人，眼里要的是源码；但从 README 语言切换进来的人，
       眼里要的是中文正文 —— 切换条两种情况下都长在，谁都能一键切到另一边，
       官网就是这么排的。 */
    if (startInSrc) paintSource(); else paintRender();
  }

  function showFile(repo, ref, path, box, startInSrc) {
    var name = path.split('/').pop();
    /* 看文件的人才是最需要换分支的那一批 —— 原来这枚按钮只长在目录页的
       面包屑上，进了文件就再也切不了 ref，只能退两级回去切完再一路点回来。
       现在文件页也带一枚，切完仍停在这同一个文件上。 */
    /* 有写权限就给一枚「编辑」：看代码看出问题的时候，改一行的成本应该是
       就地改掉，而不是记下来回电脑前面开网页去改。 */
    var canEdit = window.Session.isLogin && canPush(repo);
    box.innerHTML = '<div class="code-meta"><span class="mono">' + U.esc(path) + '</span>' +
      '<span class="rowflex">' +
      refBtnHtml(ref, repo) +
      (canEdit ? '<button class="btn sm" id="edf">' + window.icon('pencil', 13) + '编辑</button>' : '') +
      '<button class="btn sm" id="cpf">' + window.icon('copy', 13) + '复制</button>' +
      '<button class="btn sm" id="dlf">' + window.icon('download', 13) + '下载</button>' +
      '<button class="btn sm" id="shf">' + window.icon('share-android', 13) + '</button>' +
      '</span></div><div id="fbody"><div style="padding:20px"><div class="spinner"></div></div></div>';

    UI.$('#refbtn', box).onclick = function () { pickRef(repo, ref, path, 'blob'); };
    var edf = UI.$('#edf', box);
    if (edf) edf.onclick = function () { editFile(repo, ref, path); };
    /* 复制到剪贴板：优先用取回来的原文，而不是从 DOM 里读。
     *
     * 原因有两个，第二个是 PR #12 之后才有的：
     *   1. 渲染态下正文是渲染结果（图片、表格都成型了），页面上压根没有源码，
     *      老写法读 DOM 会复制到一份空字符串 —— 用取回来的原文兜住。
     *   2. 就算在源码态，代码现在是按行渲染的：每行是
     *      <span class="ln">行号</span><code class="lc">这一行</code>，
     *      直接 textContent 会把「1」「2」这些行号一起复制进去。
     *
     * 以前这里找的是 #srccode，而 paintCode 生成的 id 是 #codeview ——
     * 那个分支从来没被走到过（一直走 rawText 兜底），等于写错了 id 的死代码。 */
    var rawText = null;
    UI.$('#cpf', box).onclick = function () {
      var txt = rawText;
      if (!txt) {
        var cv = UI.$('#codeview', box);
        if (cv) {
          txt = UI.$$('.lc', cv).map(function (el) { return el.textContent; }).join('\n');
        }
      }
      UI.copy(txt || '', '已复制文件内容');
    };
    UI.$('#dlf', box).onclick = function () {
      var url = 'https://raw.githubusercontent.com/' + repo.full_name + '/' + encodeURIComponent(ref) + '/' + encodePath(path);
      if (window.NativeBridge && NativeBridge.download) NativeBridge.download(url, name);
      else window.open(url, '_blank');
    };
    UI.$('#shf', box).onclick = function () {
      var url = repo.html_url + '/blob/' + encodeURIComponent(ref) + '/' + path;
      window.NativeBridge && NativeBridge.share ? NativeBridge.share(url, name) : UI.copy(url, '链接已复制');
    };

    var isImage = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(name);
    if (isImage) {
      var url = 'https://raw.githubusercontent.com/' + repo.full_name + '/' + encodeURIComponent(ref) + '/' + encodePath(path);
      UI.$('#fbody', box).innerHTML = '<div style="padding:14px;text-align:center"><img src="' + U.esc(url) + '" style="max-width:100%" onclick="window.UI.viewImage(this.src)"></div>';
      return;
    }

    /* .md 一律走双态容器；?view=src（README 卡片上的「查看源码」）决定落地在
       哪一边，其余入口（README 里的语言切换、目录里点 .md）默认渲染态 —— 官网同款。 */
    var isMd = /\.(?:md|markdown)$/i.test(name);

    return window.API.get('/repos/' + repo.full_name + '/contents/' + encodePath(path), { ref: ref }, { cache: 60000 })
      .then(function (r) {
        var f = r.data;
        if (Array.isArray(f)) throw new Error('这是一个目录');
        if (!f.content) throw new Error('文件过大，请使用下载');
        var text = U.decodeBase64(f.content);
        rawText = text;
        if (isMd) { mountMdViewer(text, box, repo, ref, path, name, startInSrc); return; }
        paintCode(text, name, box);
      })
      .catch(function (e) {
        /* 刚切过分支 / 标签是最容易撞上 404 的时候：这个 ref 上压根没这个文件
           （新分支还没合、老版本里它还没被创建）。原来这里只会说「无法预览」，
           让人以为是文件坏了。先认出 404，明确告诉他是「这个分支上没有」，
           并给一个回到该 ref 目录的口子。 */
        var gone = e && (e.status === 404 || e.notFound);
        return fetchRaw(repo, ref, path).then(function (text) {
          if (text === null) throw e;
          rawText = text;
          if (isMd) { mountMdViewer(text, box, repo, ref, path, name, startInSrc); return; }
          paintCode(text, name, box);
        }).catch(function (e2) {
          var missing = gone || (e2 && (e2.status === 404 || e2.notFound));
          UI.$('#fbody', box).innerHTML = missing
            ? '<div style="padding:24px 16px;text-align:center">' +
              '<div style="color:var(--fg-muted);margin-bottom:12px">' +
              window.icon('file', 28) + '</div>' +
              '<div style="font-weight:600;margin-bottom:4px">' + U.esc(name) + ' 在 ' + U.esc(ref) + ' 上不存在</div>' +
              '<div style="color:var(--fg-muted);font-size:13px;margin-bottom:14px">' +
              '这个分支 / 版本里可能还没有这个文件，或者它已被删除。</div>' +
              '<button class="btn primary" id="gotodir">看看 ' + U.esc(ref) + ' 的目录</button>' +
              '<button class="btn block mt8" id="goref">换个分支 / 版本</button></div>'
            : UI.empty('file', '无法预览', '文件可能过大或为二进制格式，请点击下载');
          var gd = UI.$('#gotodir', box);
          if (gd) gd.onclick = function () { window.Router.go(refUrl(repo, 'tree', path.split('/').slice(0, -1).join('/'), ref)); };
          var gr = UI.$('#goref', box);
          if (gr) gr.onclick = function () { pickRef(repo, ref, path, 'blob'); };
        });
      });
  }

  function fetchRaw(repo, ref, path) {
    var url = 'https://raw.githubusercontent.com/' + repo.full_name + '/' + encodeURIComponent(ref) + '/' + encodePath(path);
    if (window.Native.has()) {
      return window.Native.http('GET', url, null, { 'Accept': 'text/plain' }).then(function (res) {
        return res.status === 200 ? res.body : null;
      }).catch(function () { return null; });
    }
    return fetch(url).then(function (r) { return r.ok ? r.text() : null; }).catch(function () { return null; });
  }

  /* ============================================================
   * 代码展示 / 编辑的公共件：语言判定、高亮、按行切分、行号
   *
   * 为什么要「按行切分」：预览和编辑器都要「行号 + 自动换行」同时成立。
   * 若把整段高亮塞进一个 <pre> 再让它换行，一个逻辑行会占好几行，而旁边
   * 按逻辑行排的行号就对不上了。所以把高亮后的 HTML 拆成一行一个 <div>，
   * 每行左侧带自己的行号，换行时行号仍钉在该逻辑行首，不会错位。
   *
   * ⚠️ 不能对高亮后的 HTML 直接 split('\n') —— 一个 <span>（比如多行注释、
   * 多行字符串）会跨行，硬切会把标签撕断。这里按标签平衡来切：到行尾把
   * 未闭合的 <span> 补齐，行首再补回，保证每行都是独立合法的 HTML。
   * ============================================================ */
  var CODE_LANG = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash', kt: 'kotlin', kts: 'kotlin', java: 'java', go: 'go', rs: 'rust', json: 'json', html: 'xml', htm: 'xml', xml: 'xml', css: 'css', scss: 'scss', less: 'less', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift', sql: 'sql', vue: 'xml', gradle: 'groovy', groovy: 'groovy', pl: 'perl', lua: 'lua', dart: 'dart' };

  function langOf(name) {
    var ext = String(name || '').split('.').pop().toLowerCase();
    return CODE_LANG[ext] || '';
  }

  function closeSpans(n) { var s = ''; for (var k = 0; k < n; k++) s += '</span>'; return s; }

  /** 把高亮后的 HTML 按换行拆成「每行一段独立合法 HTML」 */
  function splitHlLines(html) {
    var lines = [], open = [], buf = '', i = 0, len = html.length;
    while (i < len) {
      var c = html.charAt(i);
      if (c === '<') {
        var end = html.indexOf('>', i);
        if (end < 0) { buf += html.slice(i); break; }
        var tag = html.slice(i, end + 1);
        if (tag.charAt(1) === '/') { if (open.length) open.pop(); }
        else if (tag.charAt(tag.length - 2) !== '/') open.push(tag);
        buf += tag;
        i = end + 1;
      } else if (c === '\n') {
        lines.push(buf + closeSpans(open.length));
        buf = open.join('');
        i++;
      } else { buf += c; i++; }
    }
    lines.push(buf + closeSpans(open.length));
    return lines;
  }

  /** 高亮整段文本 → 每行 HTML 的数组 */
  function highlightLines(text, name) {
    var lang = langOf(name);
    var html;
    try {
      if (lang && window.hljs && hljs.getLanguage(lang)) {
        html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      } else if (window.hljs && text.length < 200000) {
        html = hljs.highlightAuto(text).value;
      } else {
        html = U.esc(text);
      }
    } catch (e) { html = U.esc(text); }
    return splitHlLines(html);
  }

  /** 每行 HTML → 「行号 + 代码」的行 */
  function codeRowsHtml(lines) {
    var h = '';
    for (var i = 0; i < lines.length; i++) {
      h += '<div class="crow"><span class="ln">' + (i + 1) + '</span>' +
        '<code class="lc hljs">' + lines[i] + '</code></div>';
    }
    return h;
  }

  /** 代码是否自动换行（预览与编辑器共用，记忆在设置里） */
  function isCodeWrap() {
    var v = window.Store.get('codeWrap');
    return v === undefined || v === null ? true : !!v;
  }
  function setCodeWrap(on) { window.Store.set('codeWrap', !!on); }

  function paintCode(text, name, box, holderId) {
    var lines = highlightLines(text, name);
    var wrap = isCodeWrap();
    var size = window.Store.get('codeFont') || 13;
    /* holderId：Markdown 双态视图里的「源码」态 —— 切换条已经占着 #fbody
       的顶部，代码只能写进它下面的容器里。不传就还是原来的整块 #fbody。 */
    var host = holderId ? UI.$('#' + holderId, box) : UI.$('#fbody', box);
    if (!host) host = UI.$('#fbody', box);
    if (!host) return;
    host.innerHTML =
      '<div class="code-view' + (wrap ? ' wrap' : '') + '" id="codeview">' +
        '<div class="code-tools"><button class="btn sm" id="wraptgl"></button></div>' +
        '<div class="code-lines" style="font-size:' + size + 'px">' + codeRowsHtml(lines) + '</div>' +
      '</div>';
    var tgl = UI.$('#wraptgl', host);
    if (tgl) {
      var paintTgl = function () {
        var on = isCodeWrap();
        tgl.innerHTML = window.icon('three-bars', 13) + ' ' + (on ? '不换行' : '自动换行');
      };
      paintTgl();
      tgl.onclick = function () {
        var next = !isCodeWrap();
        setCodeWrap(next);
        var cv = UI.$('#codeview', host);
        if (cv) cv.classList.toggle('wrap', next);
        paintTgl();
      };
    }
    if (window.UI) UI.noticeRefresh(host);
  }

  /* ============ 议题 / PR 列表 ============ */

  /* 议题/PR 列表每页条数。GitHub 单页最多 100，取 30 与网页端默认一致，
     翻页时加载更多追加到列表末尾。 */
  var ISSUE_PAGE_SIZE = 30;

  function issueParams(ctx, isPR, page) {
    /* 默认排序与 GitHub 网页端一致：按创建时间倒序（最新创建在前）。
       原来写死 sort=updated，导致 App 里的议题顺序和网页端对不上，
       用户以为「漏了几条」。现在默认 created，用户仍可在筛选里手动切回 updated。 */
    var sort = ctx.query.sort || 'created';
    var p = { state: ctx.query.state || 'open', per_page: ISSUE_PAGE_SIZE, sort: sort, direction: 'desc' };
    if (page) p.page = page;
    if (ctx.query.labels) p.labels = ctx.query.labels;
    if (ctx.query.assignee) p.assignee = ctx.query.assignee;
    if (ctx.query.creator) p.creator = ctx.query.creator;
    if (ctx.query.milestone) p.milestone = ctx.query.milestone;
    return p;
  }

  function listFilterBar(repo, ctx, isPR, box, onReload) {
    var base = '/' + repo.full_name + (isPR ? '/pulls' : '/issues');
    var html = '<div style="padding:10px 12px 4px">' +
      UI.seg('ist', [{ key: 'open', label: '待处理' }, { key: 'closed', label: '已完成' }, { key: 'all', label: '全部' }], ctx.query.state || 'open') +
      '</div><div class="chips">' +
      '<span class="chip" id="f-label">' + window.icon('tag', 13) + '标签</span>' +
      '<span class="chip' + (ctx.query.milestone ? ' active' : '') + '" id="f-ms">' + window.icon('milestone', 13) +
      (ctx.query.milestone ? U.esc(ctx.query.milestone) : '里程碑') + '</span>' +
      '<span class="chip" id="f-assign">' + window.icon('person', 13) + '指派</span>' +
      '<span class="chip" id="f-sort">' + window.icon('filter', 13) + '排序</span>' +
      (ctx.query.labels || ctx.query.assignee || ctx.query.milestone ? '<span class="chip" id="f-clear">' + window.icon('x', 13) + '清除筛选</span>' : '') +
      '</div>';
    return html;
  }

  function bindFilters(repo, ctx, isPR, box, reload) {
    var base = '/' + repo.full_name + (isPR ? '/pulls' : '/issues');
    UI.$$('#ist button', box).forEach(function (b) {
      b.onclick = function () {
        var q = Object.assign({}, ctx.query, { state: b.getAttribute('data-v') });
        window.Router.go(base + '?' + qs(q));
      };
    });
    var fl = UI.$('#f-label', box);
    if (fl) fl.onclick = function () {
      window.API.get('/repos/' + repo.full_name + '/labels', { per_page: 100 }, { cache: 60000 }).then(function (r) {
        var items = (r.data || []).map(function (l) { return { icon: 'tag', label: l.name, key: l.name }; });
        if (!items.length) return UI.toast('该仓库没有标签');
        UI.menu('按标签筛选', items, {}).then(function (k) {
          if (k) window.Router.go(base + '?' + qs(Object.assign({}, ctx.query, { labels: k })));
        });
      });
    };
    var fa = UI.$('#f-assign', box);
    if (fa) fa.onclick = function () {
      window.API.get('/repos/' + repo.full_name + '/assignees', { per_page: 100 }, { cache: 60000 }).then(function (r) {
        var users = r.data || [];
        var items = users.map(function (u) { return { icon: 'person', label: u.login, key: u.login }; });
        if (window.Session.user) items.unshift({ icon: 'person', label: '指派给我（@' + window.Session.user.login + '）', key: window.Session.user.login });
        items.push({ icon: 'circle-slash', label: '未指派', key: 'none' });
        UI.menu('按指派人筛选', items, {}).then(function (k) {
          if (k) window.Router.go(base + '?' + qs(Object.assign({}, ctx.query, { assignee: k })));
        });
      });
    };
    /* 里程碑筛选：顺手给一个「管理」入口 —— 想改的人多半是从这里发现
       还缺一个里程碑，而不是先想到去「更多」里找。 */
    var fm = UI.$('#f-ms', box);
    if (fm) fm.onclick = function () {
      window.API.get('/repos/' + repo.full_name + '/milestones',
        { state: 'all', per_page: 100, sort: 'due_date', direction: 'asc' }, { cache: 30000 }).then(function (r) {
        var ms = r.data || [];
        var items = ms.map(function (m) {
          return { icon: m.state === 'open' ? 'milestone' : 'issue-closed', label: m.title, key: String(m.number) };
        });
        if (ctx.query.milestone) items.unshift({ icon: 'x', label: '不按里程碑筛选', key: '__none' });
        items.push('-');
        items.push({ icon: 'gear', label: '管理里程碑…', key: '__manage' });
        if (!items.length) UI.toast('该仓库还没有里程碑');
        UI.menu('按里程碑筛选', items).then(function (k) {
          if (!k) return;
          if (k === '__manage') return window.Router.go('/' + repo.full_name + '/milestones');
          if (k === '__none') {
            var q = Object.assign({}, ctx.query); delete q.milestone;
            return window.Router.go(base + '?' + qs(q));
          }
          window.Router.go(base + '?' + qs(Object.assign({}, ctx.query, { milestone: k })));
        });
      }).catch(function () { UI.toast('读取里程碑失败'); });
    };
    var fs = UI.$('#f-sort', box);
    if (fs) fs.onclick = function () {
      UI.menu('排序方式', [
        { icon: 'clock', label: '最近更新', key: 'updated' },
        { icon: 'plus', label: '最新创建', key: 'created' },
        { icon: 'comment', label: '评论最多', key: 'comments' }
      ]).then(function (k) {
        if (k) window.Router.go(base + '?' + qs(Object.assign({}, ctx.query, { sort: k })));
      });
    };
    var fc = UI.$('#f-clear', box);
    if (fc) fc.onclick = function () {
      var q = Object.assign({}, ctx.query); delete q.labels; delete q.assignee; delete q.milestone;
      window.Router.go(base + '?' + qs(q));
    };
  }
  function qs(o) {
    return Object.keys(o).filter(function (k) { return o[k]; }).map(function (k) { return k + '=' + encodeURIComponent(o[k]); }).join('&');
  }
  window.qs = qs;

  function issueRow(it, repo, isPR) {
    var num = isPR ? 'pull/' + it.number : 'issues/' + it.number;
    return '<button class="list-row" data-go="/' + U.esc(repo.full_name) + '/' + num + '">' +
      '<span style="margin-top:2px;color:' + (isPR ? (it.merged ? 'var(--done)' : it.state === 'open' ? 'var(--success)' : 'var(--danger)') : (it.state === 'open' ? 'var(--success)' : 'var(--done)')) + '">' +
      window.icon(isPR ? (it.merged ? 'git-merge' : it.draft ? 'git-pull-request-draft' : 'git-pull-request') : (it.state === 'open' ? 'issue-opened' : 'issue-closed'), 16) + '</span>' +
      '<span class="row-main"><span class="row-title">' + U.esc(it.title) + '</span>' +
      '<span class="row-desc">#' + it.number + ' ' + (it.state === 'open' ? '由' : '由') + ' ' + U.esc((it.user && it.user.login) || '') + ' ' + (it.state === 'open' ? '创建于' : '创建于') + ' ' + U.timeAgo(it.created_at) + '</span>' +
      (it.labels && it.labels.length ? '<span class="rowflex wrap mt8">' + it.labels.map(function (l) {
        return '<span class="label" style="' + U.labelStyle(l.color) + '">' + U.esc(l.name) + '</span>';
      }).join('') + '</span>' : '') +
      '<span class="row-meta">' +
      (it.comments ? '<span>' + window.icon('comment', 12) + it.comments + '</span>' : '') +
      (it.assignee ? '<span>' + window.icon('person', 12) + U.esc(it.assignee.login) + '</span>' : '') +
      (it.milestone ? '<span>' + window.icon('milestone', 12) + U.esc(it.milestone.title) + '</span>' : '') +
      '</span></span></button>';
  }
  window.issueRow = issueRow;

  /**
   * 议题 / PR 列表的分页加载。
   *
   * 原来只拉第一页（per_page=30，不带 page），议题多的仓库后面的就看不到了；
   * 现在做成「加载更多」：第一页渲染完后，底部放一个按钮，点一下拉下一页追加到末尾。
   * 当某一页返回的条数 < ISSUE_PAGE_SIZE，说明已经到底，按钮自动消失。
   *
   * isPR=false 走 /issues 接口，需要过滤掉 pull_request（/issues 会把 PR 也带回来）；
   * isPR=true 走 /pulls 接口，返回的全是 PR，不过滤。
   */
  function issueListWithPaging(repo, ctx, box, listId, isPR) {
    var ep = '/repos/' + repo.full_name + (isPR ? '/pulls' : '/issues');
    var st = { page: 1, items: [], done: false, loading: false };

    function render() {
      var b = UI.$('#' + listId, box);
      if (!b) return;
      if (!st.items.length) {
        b.innerHTML = isPR
          ? UI.empty('git-pull-request', '没有符合条件的拉取请求', '')
          : UI.empty('issue-opened', '没有符合条件的议题', '试试切换筛选条件');
        return;
      }
      var noun = isPR ? '拉取请求' : '议题';
      var rows = '<div class="list">' + st.items.map(function (i) { return issueRow(i, repo, isPR); }).join('') + '</div>';
      var more = '';
      if (st.done) {
        /* 到底了：给一个轻量的提示，不占地方、也不打扰。
           只有在确实加载过、且总数超过一页时才显示，不然第一页就 3 条还挂个
           「没有更多了」显得多余。 */
        if (st.items.length > ISSUE_PAGE_SIZE) {
          more = '<div class="list-end">已加载全部 ' + st.items.length + ' 条' + noun + '</div>';
        }
      } else {
        more = '<button class="btn block mt8" id="' + listId + '-more">' +
          (st.loading ? '加载中…' : '加载更多') + '</button>';
      }
      b.innerHTML = rows + more;
      var mb = UI.$('#' + listId + '-more', box);
      if (mb) mb.onclick = loadNext;
      window.bindRepoCards(b);
      bindIssueLongPress(b, st.items, repo, isPR);
    }

    function loadPage(pageNum) {
      st.loading = true;
      /* 按钮文字变「加载中…」给即时反馈，免得用户连点两下发两次请求 */
      var mb = UI.$('#' + listId + '-more', box);
      if (mb) mb.textContent = '加载中…';
      var p = issueParams(ctx, isPR, pageNum);
      return window.API.get(ep, p).then(function (r) {
        var arr = r.data || [];
        if (!isPR) arr = arr.filter(function (i) { return !i.pull_request; });
        st.items = st.items.concat(arr);
        /* 不足一页 = 没有更多了。注意：即使这一页恰好装满，下一页也可能是空的，
           所以严格来说应该再请求一次确认；但 GitHub 的 /issues 在无数据时返回空数组，
           那时 arr.length===0 < ISSUE_PAGE_SIZE，done 会被置 true，不会死循环。 */
        if (arr.length < ISSUE_PAGE_SIZE) st.done = true;
        st.page = pageNum;
        st.loading = false;
        render();
      }).catch(function (e) {
        st.loading = false;
        var b = UI.$('#' + listId, box);
        if (b && st.items.length === 0) {
          /* 第一页就挂了：显示错误框 */
          b.innerHTML = UI.errorBox(e);
        } else {
          /* 已经加载了几页，后续某页挂了：保留已加载的，按钮上提示重试 */
          render();
          var btn = UI.$('#' + listId + '-more', box);
          if (btn) {
            btn.textContent = '加载失败，点此重试';
            btn.onclick = function () { loadPage(st.page + 1); };
          }
        }
      });
    }

    function loadNext() {
      if (st.loading || st.done) return;
      loadPage(st.page + 1);
    }

    /* 初始渲染骨架，再拉第一页 */
    var b = UI.$('#' + listId, box);
    if (b) b.innerHTML = UI.skeleton(4);
    loadPage(1);
  }

  function tabIssues(repo, ctx, box) {
    box.innerHTML = listFilterBar(repo, ctx, false, box) + '<div id="ilist"></div>';
    bindFilters(repo, ctx, false, box);
    issueListWithPaging(repo, ctx, box, 'ilist', false);
  }

  function tabPulls(repo, ctx, box) {
    box.innerHTML = listFilterBar(repo, ctx, true, box) + '<div id="plist"></div>';
    bindFilters(repo, ctx, true, box);
    issueListWithPaging(repo, ctx, box, 'plist', true);
  }

  /**
   * 议题 / PR 列表条目的长按绑定（两 tab 共用）。
   * 与发布列表同款：点一下照常进详情，长按 550ms 出管理菜单。
   *
   * ⚠️ GitHub 平台**没有删除议题/PR 的接口**（连作者、仓库 owner 都不行，
   * 只能联系 GitHub 支持），所以菜单里给的是「关闭 / 重新打开」，
   * 不摆一个点了必然 404 的假「删除」。
   */
  function bindIssueLongPress(hostEl, list, repo, isPR) {
    UI.$$('.list .list-row', hostEl).forEach(function (el, i) {
      var it = list[i];
      if (!it) return;
      var wasLong = UI.bindLongPress(el, function () { issueRowMenu(it, repo, isPR); }, 550);
      /* 长按松手带出的合成 click：吞掉，不然 data-go 委托会把页面跳走 */
      el.addEventListener('click', function (e) {
        if (wasLong()) { e.stopPropagation(); e.preventDefault(); }
      });
    });
  }

  /** 长按某条议题 / PR：打开 / 关闭或重开 / 复制链接 */
  function issueRowMenu(it, repo, isPR) {
    var noun = isPR ? '拉取请求' : '议题';
    var isOpen = it.state === 'open';
    UI.menu((isPR ? '#' : '#') + it.number + ' ' + noun, [
      { icon: isPR ? 'git-pull-request' : 'issue-opened', label: '打开' + noun, key: 'open' },
      { icon: isOpen ? 'issue-closed' : 'issue-opened',
        label: isOpen ? '关闭' + noun : '重新打开' + noun, key: 'toggle' },
      '-',
      { icon: 'link', label: '复制链接', key: 'link' }
    ]).then(function (k) {
      if (!k) return;
      var seg = isPR ? 'pull' : 'issues';
      if (k === 'open') return window.Router.go('/' + repo.full_name + '/' + seg + '/' + it.number);
      if (k === 'link') {
        var url = 'https://github.com/' + repo.full_name + '/' + seg + '/' + it.number;
        return UI.copy(url, '链接已复制');
      }
      if (k === 'toggle') {
        var want = isOpen ? 'closed' : 'open';
        UI.loading(true);
        /* 议题与 PR 都能走 /issues/{number} 改状态 */
        window.API.patch('/repos/' + repo.full_name + '/issues/' + it.number, { state: want })
          .then(function () {
            UI.loading(false);
            UI.toast(isOpen ? noun + '已关闭' : noun + '已重新打开');
            window.App.invalidate('/repos/' + repo.full_name + '/issues');
            window.Router.reload();
          })
          .catch(function (e) {
            UI.loading(false);
            UI.toast((e.status === 403 ? '没有权限：需要作者本人或仓库写权限。' : '操作失败：') + e.message);
          });
      }
    });
  }

  /* ============ Actions ============ */

  /** 状态筛选的合法值：分段控件能产生的就这三项，再加"全部" */
  var RUN_STATUSES = ['all', 'success', 'failure', 'in_progress'];

  /**
   * 把 ?status= 收敛到合法值。
   * 链接里可能混进别的值（手敲的、旧版本分享出去的、别的客户端生成的），
   * GitHub 遇到不认识的 status 会直接回 422，整页变成一个报错框，
   * 所以认不出的值一律退回"全部"，而不是原样透传。
   */
  function normStatus(s) {
    return RUN_STATUSES.indexOf(s) >= 0 ? s : 'all';
  }

  /**
   * 把 ?wf= 收敛到合法值：工作流 id（纯数字）或工作流文件名（xxx.yml）。
   * 它会被拼进接口路径里，放开的话等于让用户控制一段 URL 路径。
   */
  function normWf(w) {
    if (!w || w === 'all') return '';
    if (/^\d{1,20}$/.test(w)) return w;
    if (/^[\w.\- ]+\.(yml|yaml)$/.test(w)) return w;
    return '';
  }

  /** 把 Actions 接口的报错翻成人话 */
  function actionErr(e) {
    if (e && e.status === 403) return '没有权限（需要对该仓库的写权限）';
    if (e && e.status === 404) return '运行记录不存在或已被删除';
    if (e && e.status === 409) return '该运行正在进行中，先取消再删除';
    return (e && e.message) || '操作失败';
  }

  /**
   * 删除一次运行记录（连同它的日志与产物）。
   * 对应 DELETE /repos/{o}/{r}/actions/runs/{run_id}，需要写权限。
   * full 传 "owner/repo" 字符串，方便详情页也复用。
   */
  function deleteRun(full, runId, after) {
    // 整条链 return 出去：调用方（详情页、行尾菜单）才知道什么时候可以刷新
    return UI.confirm('删除运行记录',
      '将删除这次运行及其日志、产物，删除后无法恢复。确定删除？',
      '删除', true).then(function (ok) {
      if (!ok) return false;
      UI.loading(true);
      return window.API.del('/repos/' + full + '/actions/runs/' + runId).then(function () {
        UI.loading(false);
        UI.toastOk('运行记录已删除');
        if (after) after();
        return true;
      });
    }).catch(function (e) {
      UI.loading(false);
      UI.toast('删除失败：' + actionErr(e));
      return false;   // 失败已经提示过了，不再往外抛
    });
  }
  window.actionsDeleteRun = deleteRun;

  /** 单条运行记录的操作菜单（行尾 ⋮ 触发） */
  function openRunMenu(full, runId, after) {
    return UI.menu('运行记录', [
      { icon: 'trash', label: '删除运行记录', key: 'del' },
      { icon: 'link-external', label: '在浏览器打开', key: 'web' }
    ]).then(function (k) {
      if (k === 'del') return deleteRun(full, runId, after);
      if (k === 'web') {
        var u = 'https://github.com/' + full + '/actions/runs/' + runId;
        if (window.NativeBridge && NativeBridge.openExternal) NativeBridge.openExternal(u);
        else window.open(u, '_blank');
      }
    });
  }

  function tabActions(repo, ctx, box) {
    var canRun = canPush(repo);
    var full = repo.full_name;
    var status = normStatus(ctx.query.status);
    var wf = normWf(ctx.query.wf);   // 选中的工作流 id 或文件名（空 = 全部）

    // 状态 / 工作流两个筛选都塞进 query，返回、分享链接都能还原
    function urlFor(st, w) {
      var q = [];
      if (st && st !== 'all') q.push('status=' + encodeURIComponent(st));
      if (w && w !== 'all') q.push('wf=' + encodeURIComponent(w));
      return '/' + full + '/actions' + (q.length ? '?' + q.join('&') : '');
    }

    box.innerHTML = '<div style="padding:10px 12px 4px">' +
      UI.seg('aseg', [{ key: 'all', label: '全部' }, { key: 'success', label: '成功' }, { key: 'failure', label: '失败' }, { key: 'in_progress', label: '运行中' }], status) +
      '<button class="btn block mt8" id="wffilter">' + window.icon('workflow', 15) +
        ' <span id="wfname">工作流：全部</span> ' + window.icon('chevron-down', 14) + '</button>' +
      (canRun ? '<button class="btn primary block mt8" id="addwf">' + window.icon('rocket', 15) + ' 一键打包 APK</button>' +
        '<button class="btn block mt8" id="runwf">' + window.icon('zap', 15) + ' 手动触发构建</button>' : '') +
      '</div><div id="alist">' + UI.skeleton(4) + '</div>';

    UI.$$('#aseg button', box).forEach(function (b) {
      b.onclick = function () { window.Router.go(urlFor(b.getAttribute('data-v'), wf)); };
    });
    var runBtn = UI.$('#runwf', box);
    if (runBtn) runBtn.onclick = function () { triggerWorkflow(repo); };
    var addBtn = UI.$('#addwf', box);
    if (addBtn) addBtn.onclick = function () { buildApkWizard(repo); };

    /* 工作流筛选：拉一次工作流清单，选中后按它的 id 过滤运行记录。
       注意 /actions/runs 本身不支持按工作流过滤，得走
       /actions/workflows/{id}/runs 这个端点。 */
    var wfBtn = UI.$('#wffilter', box);
    window.API.get('/repos/' + full + '/actions/workflows', { per_page: 100 }, { cache: 300000 })
      .then(function (r) {
        var wfs = (r.data && r.data.workflows) || [];
        if (wf) {
          var cur = null;
          for (var i = 0; i < wfs.length; i++) if (String(wfs[i].id) === String(wf)) cur = wfs[i];
          var nEl = UI.$('#wfname', box);
          if (cur && nEl) nEl.textContent = '工作流：' + (cur.name || cur.path);
        }
        if (!wfs.length) { if (wfBtn) wfBtn.disabled = true; return; }
        wfBtn.onclick = function () {
          var items = [{ key: 'all', label: '全部工作流', icon: 'workflow' }];
          wfs.forEach(function (w) {
            items.push({ key: String(w.id), label: w.name || w.path, value: w.path, icon: w.state === 'active' ? 'play' : 'skip' });
          });
          UI.menu('按工作流筛选', items).then(function (k) {
            if (k == null) return;
            window.Router.go(urlFor(status, k === 'all' ? '' : k));
          });
        };
      })
      .catch(function () {
        if (wfBtn) wfBtn.onclick = function () { UI.toast('工作流列表读取失败'); };
      });

    function paint() {
      var p = { per_page: 30 };
      if (status !== 'all') p.status = status;
      var ep = wf
        ? '/repos/' + full + '/actions/workflows/' + encodeURIComponent(wf) + '/runs'
        : '/repos/' + full + '/actions/runs';
      return window.API.get(ep, p).then(function (r) {
        var runs = (r.data && r.data.workflow_runs) || [];
        var b = UI.$('#alist', box); if (!b) return;
        if (!runs.length) {
          b.innerHTML = UI.empty('workflow', '暂无运行记录',
            wf ? '这个工作流还没有运行记录' : '仓库启用 Actions 后，运行记录会显示在这里');
          return;
        }
        b.innerHTML = '<div class="list">' + runs.map(function (run) {
          var st = run.conclusion || run.status;
          var color = st === 'success' ? 'var(--success)' : st === 'failure' ? 'var(--danger)' : st === 'in_progress' || st === 'queued' ? 'var(--attention)' : 'var(--fg-muted)';
          var ico = st === 'success' ? 'check-circle-fill' : st === 'failure' ? 'x-circle-fill' : st === 'in_progress' ? 'play' : st === 'cancelled' ? 'skip' : 'dot-fill';
          return '<button class="list-row" data-go="/' + U.esc(full) + '/actions/' + run.id + '">' +
            '<span style="color:' + color + ';margin-top:3px">' + window.icon(ico, 16) + '</span>' +
            '<span class="row-main"><span class="row-title">' + U.esc(run.display_title || run.name) + '</span>' +
            '<span class="row-desc">' + U.esc(run.name || '') + ' · ' + U.esc(run.head_branch || '') + '</span>' +
            '<span class="row-meta"><span>' + U.timeAgo(run.created_at) + '</span>' +
            '<span class="mono">' + U.esc((run.head_sha || '').substring(0, 7)) + '</span>' +
            '<span># ' + run.run_number + '</span></span></span>' +
            (canRun ? '<span class="row-side"><span class="icon-btn" data-rmenu="' + run.id + '" role="button" aria-label="更多操作">' + window.icon('kebab-horizontal', 16) + '</span></span>' : '') +
            '</button>';
        }).join('') + '</div>';

        /* 行尾 ⋮ 自己处理点击：全局 data-go 委托跑在捕获阶段，冒泡的
           stopPropagation 拦不住它。按 App 的约定给每行绑 onclick 并置 __bound，
           让全局委托跳过，由这里区分「点行进详情 / 点 ⋮ 开菜单」。 */
        if (canRun) UI.$$('.list-row', b).forEach(function (row) {
          var dest = row.getAttribute('data-go');
          row.__bound = true;
          row.onclick = function (e) {
            var el = e.target;
            var hit = el && el.closest ? el.closest('[data-rmenu]') : null;
            e.preventDefault();
            if (hit) openRunMenu(full, hit.getAttribute('data-rmenu'), paint);
            else if (dest) window.Router.go(dest);
          };
        });
        window.bindRepoCards(b);
      }).catch(function (e) { var b = UI.$('#alist', box); if (b) b.innerHTML = UI.errorBox(e); });
    }
    return paint();
  }

  /* ============ 手动触发构建（workflow_dispatch） ============ */
  /**
   * 官网在 Actions 页右上角提供「Run workflow」。
   * 只有声明了 workflow_dispatch 的工作流才能手动触发，这里先筛选再让用户选分支。
   */
  function triggerWorkflow(repo) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    UI.loading(true);
    window.API.get('/repos/' + repo.full_name + '/actions/workflows', { per_page: 100 })
      .then(function (r) {
        UI.loading(false);
        var all = (r.data && r.data.workflows) || [];
        var list = all.filter(function (w) { return w.state === 'active'; });
        // 仓库还没有工作流时，直接引导到「一键打包 APK」：自动写入构建配置
        if (!list.length) return buildApkWizard(repo, '这个仓库还没有工作流，可以直接生成一个打包 APK 的配置。');
        pickWorkflow(repo, list);
      })
      .catch(function (e) {
        UI.loading(false);
        UI.toast('加载工作流失败：' + e.message);
      });
  }

  function pickWorkflow(repo, list) {
    var body = '<div class="muted tiny" style="margin-bottom:10px">选择一个工作流，然后指定在哪个分支上构建。</div>' +
      '<div class="list">' + list.map(function (w) {
        return '<button class="list-row" data-wf="' + U.esc(w.id) + '" data-wn="' + U.esc(w.name || '') +
          '" data-wp="' + U.esc(w.path || '') + '">' +
          window.icon('workflow', 16) +
          '<span class="row-main"><span class="row-title">' + U.esc(w.name || w.path) + '</span>' +
          '<span class="row-desc mono tiny">' + U.esc(w.path || '') + '</span></span>' +
          window.icon('chevron-right', 16) + '</button>';
      }).join('') + '</div>';
    var root = document.getElementById('sheet-root');
    UI.sheet({
      title: '触发构建', body: body, full: true,
      onMount: function () {
        UI.$$('[data-wf]', root).forEach(function (b) {
          b.onclick = function () {
            pickBranchAndRun(repo, b.getAttribute('data-wf'), b.getAttribute('data-wn'), b.getAttribute('data-wp'));
          };
        });
      }
    });
  }

  function pickBranchAndRun(repo, wfId, wfName, wfPath) {
    UI.loading(true);
    window.API.get('/repos/' + repo.full_name + '/branches', { per_page: 100 })
      .then(function (r) {
        UI.loading(false);
        var branches = r.data || [];
        var names = branches.map(function (x) { return x.name; });
        if (names.indexOf(repo.default_branch) < 0) names.unshift(repo.default_branch);
        var body =
          '<div class="field"><label>工作流</label>' +
          '<div class="del-target">' + window.icon('workflow', 15) +
          '<span class="mono">' + U.esc(wfName || wfId) + '</span></div></div>' +
          '<div class="field"><label>在哪个分支上构建</label>' +
          '<select class="input" id="wf-ref">' + names.map(function (n) {
            return '<option value="' + U.esc(n) + '"' + (n === repo.default_branch ? ' selected' : '') + '>' + U.esc(n) + '</option>';
          }).join('') + '</select>' +
          '<div class="hint">换分支会重新读取那个分支上的工作流参数。</div></div>' +
          '<div id="wf-inputs"><div class="muted tiny">正在读取这个工作流声明的参数…</div></div>' +
          '<div class="hint" style="margin-top:8px">触发后 GitHub 会开始构建，完成后回到这里点开运行记录即可下载产物（APK）。</div>';
        var root = document.getElementById('sheet-root');
        var inputs = [];
        UI.sheet({
          title: '触发构建', body: body,
          foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>开始构建</button>',
          onMount: function () {
            var sel = root.querySelector('#wf-ref');
            // 参数写在 .yml 里，不同分支可能不一样，所以换分支就重读一次
            function load() {
              var box = root.querySelector('#wf-inputs');
              if (box) box.innerHTML = '<div class="muted tiny">正在读取这个工作流声明的参数…</div>';
              fetchDispatchInputs(repo, wfPath, sel.value).then(function (list) {
                inputs = list || [];
                var b = root.querySelector('#wf-inputs');
                if (!b) return;
                b.innerHTML = inputs.length
                  ? '<div class="muted tiny" style="margin-bottom:2px">这个工作流声明了 ' + inputs.length + ' 个参数</div>' +
                    dispatchInputsHtml(inputs)
                  : '<div class="muted tiny">这个工作流没有声明参数，直接开始即可。</div>';
              });
            }
            sel.onchange = load;
            load();
            root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
            root.querySelector('[data-yes]').onclick = function () {
              var ref = root.querySelector('#wf-ref').value;
              var got = readDispatchInputs(root, inputs);
              if (got.err) return UI.toast(got.err);
              var payload = { ref: ref };
              if (inputs.length) payload.inputs = got.inputs;
              UI.loading(true);
              window.API.post('/repos/' + repo.full_name + '/actions/workflows/' + wfId + '/dispatches', payload)
                .then(function () {
                  UI.loading(false);
                  UI.closeSheet();
                  UI.toast('已触发构建，稍后刷新查看进度');
                  window.Router.go('/' + repo.full_name + '/actions');
                  window.Router.reload();
                })
                .catch(function (e) {
                  UI.loading(false);
                  UI.toast(e.status === 404 ? '该工作流不支持手动触发'
                    : e.status === 422 ? '参数不对：' + e.message
                    : '触发失败：' + e.message);
                });
            };
          }
        });
      })
      .catch(function (e) { UI.loading(false); UI.toast('加载分支失败：' + e.message); });
  }

  /* ---- 工作流声明的输入参数：读取、解析、渲染、回收 ---- */
  /**
   * GitHub 的 REST API 只回答「有哪些工作流、叫什么名字」，不回答它声明了哪些
   * 手动触发参数 —— /actions/workflows 的返回里压根没有 inputs 字段。
   * 于是只能把 .yml 原文取回来自己认。
   *
   * 下面这个不是通用 YAML 解析器：需要的只是「名字 / 说明 / 是否必填 / 默认值 /
   * 类型 / 选项」这几项，所以只认 on → workflow_dispatch → inputs 这一小块。
   * 认不出来就返回空数组，调用方退回「只选分支」的老行为，不会把人卡住。
   */
  function parseDispatchInputs(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');

    function isNoise(L) { return /^\s*$/.test(L) || /^\s*#/.test(L) || /^---\s*$/.test(L); }
    function indentOf(L) { var m = L.match(/^(\s*)/); return m ? m[1].length : 0; }
    // 一个块到「缩进回到同级或更外层」为止 —— YAML 就靠缩进分层
    function blockEnd(start, indent) {
      for (var j = start + 1; j < lines.length; j++) {
        if (isNoise(lines[j])) continue;
        if (indentOf(lines[j]) <= indent) return j;
      }
      return lines.length;
    }
    function findKey(from, to, key) {
      var re = new RegExp('^\\s*(["\']?)' + key + '\\1\\s*:');
      for (var j = from; j < to; j++) {
        if (isNoise(lines[j])) continue;
        if (re.test(lines[j])) return j;
      }
      return -1;
    }
    // 剥行尾注释：只在 # 不在引号里、且前面有空白时才算注释，
    // 否则 default: "v1 #2" 会被砍成 "v1
    function stripComment(s) {
      var t = String(s == null ? '' : s), out = '', q = '';
      for (var i = 0; i < t.length; i++) {
        var c = t.charAt(i);
        if (q) { out += c; if (c === q) q = ''; continue; }
        if (c === '"' || c === "'") { q = c; out += c; continue; }
        if (c === '#' && out.length && /\s/.test(out.charAt(out.length - 1))) break;
        out += c;
      }
      return out;
    }
    function unquote(s) {
      s = stripComment(s).trim();
      var q = s.charAt(0);
      if ((q === '"' || q === "'") && s.length > 1 && s.charAt(s.length - 1) === q) {
        return s.slice(1, -1).split(q + q).join(q);
      }
      return s;
    }
    function setAttr(it, key, rest) {
      if (key === 'required') it.required = /^(true|yes|on)$/i.test(unquote(rest));
      else if (key === 'default') it.default = unquote(rest);
      else if (key === 'description') it.description = unquote(rest);
      else if (key === 'type') it.type = unquote(rest) || 'string';
    }

    var i, onIdx = -1, onRe = /^\s*(["']?)on\1\s*:/;
    for (i = 0; i < lines.length; i++) {
      if (isNoise(lines[i])) continue;
      if (onRe.test(lines[i])) { onIdx = i; break; }
    }
    if (onIdx < 0) return [];

    var onInd = indentOf(lines[onIdx]);
    var onEnd = blockEnd(onIdx, onInd);
    // on: workflow_dispatch 这种简写没有参数块
    var wdIdx = findKey(onIdx + 1, onEnd, 'workflow_dispatch');
    if (wdIdx < 0) return [];
    var wdInd = indentOf(lines[wdIdx]);
    var wdEnd = blockEnd(wdIdx, wdInd);
    var inIdx = findKey(wdIdx + 1, wdEnd, 'inputs');
    if (inIdx < 0) return [];
    var inInd = indentOf(lines[inIdx]);
    var inEnd = blockEnd(inIdx, inInd);

    var out = [], cur = null, entryInd = -1;
    for (i = inIdx + 1; i < inEnd; i++) {
      var L = lines[i];
      if (isNoise(L)) continue;
      var ind = indentOf(L);
      // 列表项：options: 下面那一串 - xxx
      var lm = L.match(/^\s*-\s*(.*)$/);
      if (lm && cur && cur._inOptions) {
        cur.options.push(unquote(lm[1]));
        continue;
      }
      var m = L.match(/^\s*(?:"([^"]+)"|'([^']+)'|([^:\s]+))\s*:\s*(.*)$/);
      if (!m || ind <= inInd) continue;
      var key = m[1] || m[2] || m[3];
      var rest = m[4];
      if (entryInd < 0) entryInd = ind;
      if (cur) cur._inOptions = false;
      if (ind === entryInd) {
        cur = { name: key, description: '', required: false, default: '', type: 'string', options: [], _inOptions: false };
        out.push(cur);
        // 行内写法：name: {type: choice, default: a}
        var flow = rest.match(/^\{(.*)\}\s*$/);
        if (flow) {
          flow[1].split(',').forEach(function (kv) {
            var p = kv.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
            if (p) setAttr(cur, p[1], p[2]);
          });
        }
        continue;
      }
      if (!cur || ind <= entryInd) continue;
      if (key === 'options') {
        cur._inOptions = true;
        var seq = rest.match(/^\[(.*)\]\s*$/);
        if (seq) {
          seq[1].split(',').forEach(function (v) { if (unquote(v)) cur.options.push(unquote(v)); });
          cur._inOptions = false;
        }
        continue;
      }
      setAttr(cur, key, rest);
    }
    out.forEach(function (it) { delete it._inOptions; });
    return out;
  }

  function fetchDispatchInputs(repo, wfPath, ref) {
    var p = String(wfPath || '');
    if (!p) return Promise.resolve([]);
    var enc = p.split('/').map(encodeURIComponent).join('/');
    return window.API.get('/repos/' + repo.full_name + '/contents/' + enc, { ref: ref }, { cache: 60000 })
      .then(function (r) {
        var d = r && r.data;
        // 目录、空文件、超过 1MB 拿不到内容的情况都当「没有参数」
        if (!d || Array.isArray(d) || !d.content) return [];
        return parseDispatchInputs(U.decodeBase64(d.content));
      })
      .catch(function () { return []; });
  }

  function dispatchInputsHtml(list) {
    return list.map(function (it) {
      var id = 'wf-in-' + String(it.name).replace(/[^A-Za-z0-9_-]/g, '_');
      var hint = it.description ? '<div class="hint">' + U.esc(it.description) + '</div>' : '';
      var ctl;
      if (it.type === 'choice' && it.options.length) {
        ctl = '<select class="input" id="' + id + '">' + it.options.map(function (o) {
          return '<option value="' + U.esc(o) + '"' + (o === it.default ? ' selected' : '') + '>' + U.esc(o) + '</option>';
        }).join('') + '</select>';
      } else if (it.type === 'boolean') {
        var dflt = String(it.default || '').toLowerCase() === 'true' ? 'true' : 'false';
        ctl = '<select class="input" id="' + id + '">' +
          '<option value="true"' + (dflt === 'true' ? ' selected' : '') + '>是</option>' +
          '<option value="false"' + (dflt === 'false' ? ' selected' : '') + '>否</option></select>';
      } else {
        ctl = '<input class="input" id="' + id + '" type="' + (it.type === 'number' ? 'number' : 'text') +
          '" value="' + U.esc(it.default || '') + '"' +
          (it.type === 'environment' ? ' placeholder="环境名，如 production"' : '') + '>';
      }
      return '<div class="field"><label>' + U.esc(it.name) +
        (it.required ? ' <b style="color:var(--danger)">*</b>' : '') + '</label>' + ctl + hint +
        (it.type && it.type !== 'string' ? '<div class="hint tiny">类型：' + U.esc(it.type) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function readDispatchInputs(root, list) {
    var obj = {}, missing = [];
    (list || []).forEach(function (it) {
      var id = 'wf-in-' + String(it.name).replace(/[^A-Za-z0-9_-]/g, '_');
      var el = root.querySelector('#' + id);
      // 参数还没渲染出来（网络慢）就点了开始：当成用默认值，别把人卡住
      var v = el ? String(el.value || '') : String(it.default || '');
      if (it.required && !v.trim()) missing.push(it.name);
      obj[it.name] = v;
    });
    if (missing.length) return { err: '缺少必填参数：' + missing.join('、') };
    return { inputs: obj };
  }

  /* ============ 一键打包 APK ============ */
  /**
   * 官网本身不会"打包 APK"——它靠仓库里的 Actions 工作流去构建。
   * 这里把这个门槛也做掉：App 内直接生成构建配置并触发，
   * 用户不需要在电脑上写 .github/workflows/*.yml。
   */
  /**
   * 构建配置模板。
   *
   * 生成的 YAML 每一步都带中文注释，并且可以直接在手机上改；
   * yaml(variant, sign, note)：
   *   variant = 'debug' | 'release'
   *   sign    = 签名配置对象（不需要签名为 null）
   *   note    = 修改说明，会写进文件头部注释
   */
  /**
   * 构建配置模板。
   *
   * 生成的 YAML 每一步都带中文注释，可以直接在手机上改；
   * yaml(variant, sign, note, info)：
   *   variant = 'debug' | 'release'
   *   sign    = 签名配置对象（不需要签名为 null）
   *   note    = 修改说明，会写进文件头部注释
   *   info    = {appName, versionName, versionCode} 自定义名称与版本号
   */
  var WF_TEMPLATES = {
    android: {
      key: 'android',
      label: 'Android（Gradle）',
      desc: '检测到 settings.gradle / build.gradle / gradlew',
      file: '.github/workflows/build-apk.yml',
      yaml: function (variant, sign, note, info) {
        var rel = variant === 'release';
        return yamlHead(note, 'Android Gradle') +
          'name: Build APK\n' +
          '\n' +
          onBlock(info) +
          'jobs:\n' +
          '  build:\n' +
          '    runs-on: ubuntu-latest   # GitHub 免费提供的 Linux 构建机\n' +
          '    steps:\n' +
          '      # 1. 把仓库代码拉到构建机上\n' +
          '      - name: Checkout\n' +
          '        uses: actions/checkout@v4\n' +
          '\n' +
          '      # 2. 准备 JDK（Gradle 8 需要 17，老项目可改成 11）\n' +
          '      - name: Set up JDK 17\n' +
          '        uses: actions/setup-java@v4\n' +
          '        with:\n' +
          '          distribution: temurin\n' +
          "          java-version: '17'\n" +
          '\n' +
          '      # 3. gradlew 必须可执行，否则报 Permission denied\n' +
          '      - name: Grant execute permission for gradlew\n' +
          '        run: chmod +x ./gradlew || true\n' +
          '\n' +
          versionStep(info) +
          '      # 5. 构建；命令可以按需改，例如只编某个模块 :app:assembleDebug\n' +
          '      - name: Build ' + (rel ? 'Release' : 'Debug') + ' APK\n' +
          '        run: ./gradlew ' + (rel ? 'assembleRelease' : 'assembleDebug') + ' --no-daemon\n' +
          '\n' +
          (rel && sign ? signStep(sign, '*/outputs/apk/release/*') : '') +
          renameStep(info) +
          '      # 上传产物：构建完后在 App 里点开这条运行记录即可下载、自动安装\n' +
          '      - name: Upload APK\n' +
          '        uses: actions/upload-artifact@v4\n' +
          '        with:\n' +
          '          name: ' + artifactName() + '\n' +
          '          path: |\n' +
          '            **/build/outputs/apk/**/*.apk\n' +
          '            **/build/outputs/bundle/**/*.aab\n' +
          '          if-no-files-found: error\n';
      }
    },
    flutter: {
      key: 'flutter',
      label: 'Flutter',
      desc: '检测到 pubspec.yaml',
      file: '.github/workflows/build-apk.yml',
      yaml: function (variant, sign, note, info) {
        var rel = variant === 'release';
        return yamlHead(note, 'Flutter') +
          'name: Build APK\n' +
          '\n' +
          onBlock(info) +
          'jobs:\n' +
          '  build:\n' +
          '    runs-on: ubuntu-latest   # GitHub 免费提供的 Linux 构建机\n' +
          '    steps:\n' +
          '      # 1. 把仓库代码拉到构建机上\n' +
          '      - name: Checkout\n' +
          '        uses: actions/checkout@v4\n' +
          '\n' +
          '      # 2. 准备 JDK（打 Android 包必备）\n' +
          '      - name: Set up JDK 17\n' +
          '        uses: actions/setup-java@v4\n' +
          '        with:\n' +
          '          distribution: temurin\n' +
          "          java-version: '17'\n" +
          '\n' +
          '      # 3. 安装 Flutter SDK；channel 可改成 beta / master\n' +
          '      - name: Set up Flutter\n' +
          '        uses: subosito/flutter-action@v2\n' +
          '        with:\n' +
          '          channel: stable\n' +
          '\n' +
          '      # 4. 拉依赖\n' +
          '      - name: Install dependencies\n' +
          '        run: flutter pub get\n' +
          '\n' +
          versionStep(info) +
          '      # 6. 构建；--split-per-abi 可拆成多个架构包\n' +
          '      - name: Build ' + (rel ? 'Release' : 'Debug') + ' APK\n' +
          '        run: flutter build apk --' + (rel ? 'release' : 'debug') + '\n' +
          '\n' +
          (rel && sign ? signStep(sign, '*/flutter-apk/*') : '') +
          renameStep(info) +
          '      # 上传产物：构建完后在 App 里点开这条运行记录即可下载、自动安装\n' +
          '      - name: Upload APK\n' +
          '        uses: actions/upload-artifact@v4\n' +
          '        with:\n' +
          '          name: ' + artifactName() + '\n' +
          '          path: build/app/outputs/flutter-apk/*.apk\n' +
          '          if-no-files-found: error\n';
      }
    },
    zip: {
      key: 'zip',
      label: '通用打包（ZIP）',
      desc: '把仓库打成压缩包作为产物',
      file: '.github/workflows/build-package.yml',
      yaml: function (variant, sign, note, info) {
        return yamlHead(note, '通用 ZIP 打包') +
          'name: Build Package\n' +
          '\n' +
          onBlock(info) +
          'jobs:\n' +
          '  build:\n' +
          '    runs-on: ubuntu-latest\n' +
          '    steps:\n' +
          '      # 1. 拉取代码\n' +
          '      - name: Checkout\n' +
          '        uses: actions/checkout@v4\n' +
          '\n' +
          '      # 2. 打包；-x 后面是要排除的目录\n' +
          '      - name: Zip\n' +
          "        run: zip -r app.zip . -x '.git/*'\n" +
          '\n' +
          renameStep(info) +
          '      # 上传产物\n' +
          '      - name: Upload\n' +
          '        uses: actions/upload-artifact@v4\n' +
          '        with:\n' +
          '          name: ' + artifactName() + '\n' +
          '          path: app.zip\n' +
          '          if-no-files-found: error\n';
      }
    }
  };

  /** YAML 里的单引号字符串转义 */
  function yq(s) {
    return String(s == null ? '' : s).replace(/'/g, "''");
  }

  /**
   * 文件头部注释：谁生成、改了什么。
   * 用户要求「改配置必须带注释」，这里把说明同时落进文件和提交信息。
   */
  function yamlHead(note, kind) {
    var d = new Date();
    var stamp = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) +
      '-' + ('0' + d.getDate()).slice(-2);
    return '# 由 githup App 生成（' + kind + '）· ' + stamp + '\n' +
      '# 修改说明：' + (note && note.trim() ? note.trim() : '首次生成，未做改动') + '\n' +
      '# 每个步骤都带注释，可直接修改；改完请在上方填写修改说明再保存。\n' +
      '\n';
  }

  /**
   * 手动触发时可以临时改名称与版本号，不用改配置。
   * 默认值就是用户在 App 里填的那些。
   */
  function onBlock(info) {
    var i = info || {};
    return 'on:\n' +
      '  workflow_dispatch:   # 允许在 App 里点「手动触发构建」\n' +
      '    inputs:\n' +
      '      app_name:\n' +
      '        description: 安装包名称\n' +
      "        default: '" + yq(i.appName || 'app') + "'\n" +
      '      version_name:\n' +
      '        description: 版本号（versionName）\n' +
      "        default: '" + yq(i.versionName || '1.0.0') + "'\n" +
      '      version_code:\n' +
      '        description: 版本代号（versionCode，整数）\n' +
      "        default: '" + yq(String(i.versionCode || '1')) + "'\n" +
      '\n';
  }

  /** 产物名：名称-版本号 */
  function artifactName() {
    return '${{ github.event.inputs.app_name }}-${{ github.event.inputs.version_name }}';
  }

  /** 把 build.gradle / build.gradle.kts 里的版本号改成用户填的值 */
  function versionStep(info) {
    if (!info || !info.versionName) return '';
    var L = [];
    L.push('      # 4. 改成你在 App 里填的版本号（同时兼容 build.gradle 与 .kts）');
    L.push('      - name: Set version');
    L.push('        env:');
    L.push('          VN: ' + artifactVN());
    L.push('          VC: ' + artifactVC());
    L.push('        run: |');
    L.push('          for f in $(find . -name "build.gradle" -o -name "build.gradle.kts"); do');
    L.push('            sed -i -E "s/versionName.*/versionName = \\"$VN\\"/" "$f"');
    L.push('            sed -i -E "s/versionCode.*/versionCode = $VC/" "$f"');
    L.push('          done');
    L.push('          echo "版本已设为 $VN ($VC)"');
    return L.join('\n') + '\n\n';
  }

  function artifactVN() { return '${{ github.event.inputs.version_name }}'; }
  function artifactVC() { return '${{ github.event.inputs.version_code }}'; }

  /** 把产物改名成「名称-版本号.apk」 */
  function renameStep(info) {
    if (!info || !info.appName) return '';
    var L = [];
    L.push('      # 把产物改成你指定的安装包名称');
    L.push('      - name: Rename APK');
    L.push('        env:');
    L.push('          NAME: ${{ github.event.inputs.app_name }}');
    L.push('          VN: ' + artifactVN());
    L.push('        run: |');
    L.push('          APK=$(find . -name "*.apk" | head -1)');
    L.push('          if [ -n "$APK" ]; then');
    L.push('            D=$(dirname "$APK")');
    L.push('            mv "$APK" "$D/$NAME-$VN.apk"');
    L.push('            echo "产物: $D/$NAME-$VN.apk"');
    L.push('          fi');
    return L.join('\n') + '\n\n';
  }

  /**
   * 签名步骤：把 Base64 还原成 keystore，再用 apksigner 给 APK 签名。
   * apksigner 在 GitHub 构建机自带的 Android SDK 里，不需额外安装。
   */
  function signStep(sign, glob) {
    var plain = sign && sign.mode === 'plain';
    var env = plain
      ? "          KEYSTORE_BASE64: '" + yq(sign.b64) + "'\n" +
        "          KEYSTORE_PASSWORD: '" + yq(sign.storePass) + "'\n" +
        "          KEY_ALIAS: '" + yq(sign.alias) + "'\n" +
        "          KEY_PASSWORD: '" + yq(sign.keyPass) + "'\n"
      : '          KEYSTORE_BASE64: ${{ secrets.KEYSTORE_BASE64 }}\n' +
        '          KEYSTORE_PASSWORD: ${{ secrets.KEYSTORE_PASSWORD }}\n' +
        '          KEY_ALIAS: ${{ secrets.KEY_ALIAS }}\n' +
        '          KEY_PASSWORD: ${{ secrets.KEY_PASSWORD }}\n';
    return '      # 签名：Base64 还原成 keystore，再用 apksigner 给 APK 签名\n' +
      (plain ? '      # 警告：密钥以明文写在配置里，公开仓库请勿这样用！\n' : '') +
      '      - name: Sign APK\n' +
      '        env:\n' + env +
      '        run: |\n' +
      '          echo "$KEYSTORE_BASE64" | base64 -d > /tmp/app.keystore\n' +
      '          APK=$(find . -name "*.apk" -path "' + glob + '" | head -1)\n' +
      '          if [ -z "$APK" ]; then echo "没有找到 APK"; exit 1; fi\n' +
      '          SIGNER=$(ls $ANDROID_HOME/build-tools/*/apksigner | head -1)\n' +
      '          "$SIGNER" sign --ks /tmp/app.keystore --ks-key-alias "$KEY_ALIAS" \\\n' +
      '            --ks-pass pass:"$KEYSTORE_PASSWORD" --key-pass pass:"$KEY_PASSWORD" \\\n' +
      '            --out "$APK.signed" "$APK"\n' +
      '          mv "$APK.signed" "$APK"\n' +
      '\n';
  }

  /** 需要用户在 GitHub 网页里添加的 4 个 Secret 名称 */
  var SIGN_SECRETS = ['KEYSTORE_BASE64', 'KEYSTORE_PASSWORD', 'KEY_ALIAS', 'KEY_PASSWORD'];

  /** 读仓库根目录，猜项目类型，选不准也没关系——用户可以手动改。 */
  function detectProject(repo) {
    return window.API.get('/repos/' + repo.full_name + '/contents/', { ref: repo.default_branch }, { cache: 0 })
      .then(function (r) {
        var files = r.data || [];
        var names = files.map(function (f) { return f.name; });
        var has = function (re) { return names.some(function (n) { return re.test(n); }); };
        if (names.indexOf('pubspec.yaml') >= 0) return 'flutter';
        if (has(/^settings\.gradle(\.kts)?$/) || has(/^build\.gradle(\.kts)?$/) || names.indexOf('gradlew') >= 0) return 'android';
        if (names.indexOf('package.json') >= 0) return 'zip';
        return 'android';
      })
      .catch(function () { return 'android'; });
  }

  function b64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function buildApkWizard(repo, notice) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    if (!canPush(repo)) return UI.toast('没有该仓库的写入权限');
    UI.loading(true);
    Promise.all([
      detectProject(repo),
      window.API.get('/repos/' + repo.full_name + '/branches', { per_page: 100 }).catch(function () { return { data: [] }; })
    ]).then(function (rs) {
      UI.loading(false);
      var kind = rs[0];
      var branches = (rs[1].data || []).map(function (x) { return x.name; });
      if (branches.indexOf(repo.default_branch) < 0) branches.unshift(repo.default_branch);
      pickBuildTemplate(repo, kind, branches, notice);
    }).catch(function (e) {
      UI.loading(false);
      UI.toast('初始化失败：' + e.message);
    });
  }

  function pickBuildTemplate(repo, kind, branches, notice) {
    var order = ['android', 'flutter', 'zip'];
    // 检测出来的类型排在最前面，减少用户选择成本
    order.sort(function (a, b) { return (b === kind ? 1 : 0) - (a === kind ? 1 : 0); });
    // 用户点的是「打包 APK」：没识别出 Android/Flutter 时也默认给 Android，
    // 而不是给一个根本产不出 APK 的 ZIP 模板
    var picked = (kind === 'zip') ? 'android' : kind;
    var variant = 'debug';
    /** 用户是否手动改过配置：改过就必须填修改说明，且不再被模板覆盖 */
    var edited = false;
    /** App 内生成的签名结果（由口令派生） */
    var madeKs = null;

    var body =
      (notice ? '<div class="hint" style="margin-bottom:10px">' + U.esc(notice) + '</div>' : '') +
      (kind === 'zip' ? '<div class="hint" style="margin-bottom:10px">' +
        '没有检测到 Android / Flutter 项目特征，已默认按 Android Gradle 生成；' +
        '如果构建失败，请在下面改选项目类型。</div>' : '') +
      '<div class="field"><label>项目类型</label><div class="list" id="tpl-list">' +
      order.map(function (k) {
        var t = WF_TEMPLATES[k];
        return '<button class="list-row tpl" data-tpl="' + k + '">' +
          '<span style="color:' + (k === picked ? 'var(--accent)' : 'var(--fg-muted)') + '">' +
          window.icon(k === picked ? 'check-circle-fill' : 'circle', 16) + '</span>' +
          '<span class="row-main"><span class="row-title">' + U.esc(t.label) + '</span>' +
          '<span class="row-desc tiny">' + U.esc(t.desc) + '</span></span></button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>构建类型</label>' +
      '<select class="input" id="wf-variant">' +
      '<option value="debug" selected>Debug（无需签名，装到手机就能跑）</option>' +
      '<option value="release">Release（未签名，正式发布不能上架）</option>' +
      '<option value="sign">Release + 签名</option>' +
      '</select></div>' +
      '<div class="field"><label>安装包名称</label>' +
      '<input class="input mono" id="wf-name" type="text" autocomplete="off" ' +
      'autocapitalize="none" spellcheck="false" placeholder="例如 MyApp">' +
      '<div class="hint">产物会命名为「名称-版本号.apk」。</div></div>' +
      '<div class="field"><label>版本号（versionName）</label>' +
      '<input class="input mono" id="wf-ver" type="text" autocomplete="off" ' +
      'spellcheck="false" placeholder="例如 1.0.0">' +
      '<div class="hint">会写进 build.gradle / build.gradle.kts。</div></div>' +
      '<div class="field"><label>版本代号（versionCode）</label>' +
      '<input class="input mono" id="wf-vcode" type="text" inputmode="numeric" ' +
      'autocomplete="off" spellcheck="false" placeholder="例如 1">' +
      '<div class="hint">必须是整数，每次发版递增。</div></div>' +
      // 签名配置：只在选了「Release + 签名」时出现
      '<div class="field" id="sign-box" hidden>' +
      '<label>签名方式</label>' +
      '<select class="input" id="sg-kind">' +
      '<option value="make" selected>用口令生成（在 App 内生成，推荐）</option>' +
      '<option value="import">用已有的 keystore（粘贴 Base64）</option>' +
      '</select>' +
      '<div id="sg-make" style="margin-top:10px">' +
      '<div class="field"><label class="sub">签名口令</label>' +
      '<input class="input mono" id="sg-seed" type="text" autocomplete="off" ' +
      'autocapitalize="none" spellcheck="false" placeholder="输入英文字母和数字，例如 githup2024abc">' +
      '<div class="hint">这串字符就是你的签名：口令相同，签名就完全相同，' +
      '新包可以直接覆盖安装。口令不同就是另一个签名，请务必记牢。</div></div>' +
      '<button class="btn block" id="sg-gen">' + window.icon('key', 15) + ' 生成签名</button>' +
      '<div class="hint" id="sg-res"></div>' +
      '</div>' +
      '<div id="sg-import" hidden style="margin-top:10px">' +
      '<div class="field"><label class="sub">keystore（Base64）</label>' +
      '<textarea class="textarea mono tiny" id="sg-b64" rows="3" spellcheck="false"' +
      ' autocapitalize="none" autocorrect="off" ' +
      'placeholder="粘贴 keystore 文件的 Base64，是一长串数字和字母"></textarea>' +
      '<div class="hint">电脑上生成：' +
      'keytool -genkey -v -keystore app.keystore -alias mykey -keyalg RSA -keysize 2048 -validity 10000' +
      '，再执行 base64 app.keystore，把输出整段粘进来。</div></div>' +
      '<div class="field"><label class="sub">密钥库密码</label>' +
      '<input class="input" id="sg-sp" type="text" autocomplete="off" spellcheck="false" placeholder="store password"></div>' +
      '<div class="field"><label class="sub">密钥别名</label>' +
      '<input class="input mono" id="sg-alias" type="text" autocomplete="off" spellcheck="false" placeholder="例如 mykey"></div>' +
      '<div class="field"><label class="sub">密钥密码</label>' +
      '<input class="input" id="sg-kp" type="text" autocomplete="off" spellcheck="false" placeholder="key password"></div>' +
      '</div>' +
      '<div class="field" style="margin-top:10px"><label class="sub">密钥写在哪里</label>' +
      '<select class="input" id="sg-mode">' +
      '<option value="secrets" selected>仓库 Secrets（推荐，配置里只留变量名）</option>' +
      '<option value="plain">明文写进配置（仅私有仓库，公开仓库会泄露密钥）</option>' +
      '</select>' +
      '<div class="hint" id="sg-tip"></div>' +
      '<button class="btn block mt8" id="sg-help" hidden>' + window.icon('link-external', 15) +
      ' 去 GitHub 添加这 4 个 Secret</button>' +
      '</div></div>' +
      '<div class="field"><label>目标分支</label>' +
      '<select class="input" id="wf-ref2">' + branches.map(function (n) {
        return '<option value="' + U.esc(n) + '"' + (n === repo.default_branch ? ' selected' : '') + '>' + U.esc(n) + '</option>';
      }).join('') + '</select>' +
      '<div class="hint" id="wf-path"></div></div>' +
      '<div class="field"><label id="wf-note-label">修改说明</label>' +
      '<input class="input" id="wf-note" type="text" autocomplete="off" ' +
      'placeholder="例如：改成 JDK 11、只编 app 模块">' +
      '<div class="hint">改了下面的配置就必填，会同时写进文件头部的注释和提交信息。</div></div>' +
      // 默认展开：藏在折叠区里用户根本点不到，更别说改
      '<details class="wf-preview" id="wf-box" open><summary>查看并编辑将要写入的配置</summary>' +
      '<textarea class="textarea mono tiny" id="wf-code" rows="16" spellcheck="false"' +
      ' autocapitalize="none" autocorrect="off"></textarea>' +
      '<div style="margin-top:6px"><button class="btn sm" data-reset>恢复默认模板</button></div>' +
      '<div class="hint err-hint" id="wf-err"></div></details>';

    var root = document.getElementById('sheet-root');

    function v(sel) {
      var el = root.querySelector(sel);
      return el ? String(el.value || '').trim() : '';
    }

    /** 前端算个短指纹，让用户确认签名确实生成了（不参与密码学） */
    function fp(s) {
      var h = 5381, i;
      for (i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) & 0x7fffffff;
      return ('0000000' + h.toString(16)).slice(-8);
    }

    /**
     * 读取并校验签名表单。
     * silent=true 用于实时预览（还没填完不算错，不弹提示）；
     * silent=false 用于点「写入并构建」时做完整校验。
     */
    function readSign(silent) {
      function bad(id, msg) {
        if (silent) return null;
        var el = root.querySelector(id);
        if (el) { el.focus(); el.classList.add('bad'); }
        UI.toast(msg);
        return null;
      }
      UI.$$('#sign-box .input, #sign-box .textarea', root).forEach(function (el) {
        el.classList.remove('bad');
      });
      var mode = v('#sg-mode') || 'secrets';
      if (v('#sg-kind') === 'make') {
        if (!madeKs) return bad('#sg-gen', '请先点「生成签名」');
        madeKs.mode = mode;
        return madeKs;
      }
      var b64 = v('#sg-b64'), sp = v('#sg-sp'), alias = v('#sg-alias'), kp = v('#sg-kp');
      if (!b64) return bad('#sg-b64', '请粘贴 keystore 的 Base64');
      if (b64.length < 80) return bad('#sg-b64', 'Base64 太短了，应该是一长串数字字母');
      if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return bad('#sg-b64', 'Base64 只能包含数字、字母和 + / =');
      if (!sp) return bad('#sg-sp', '请填写密钥库密码');
      if (!alias) return bad('#sg-alias', '请填写密钥别名');
      if (!kp) return bad('#sg-kp', '请填写密钥密码');
      return {
        b64: b64.replace(/\s+/g, ''), storePass: sp, alias: alias, keyPass: kp, mode: mode
      };
    }

    function note() { return v('#wf-note'); }

    function info() {
      return {
        appName: v('#wf-name') || 'app',
        versionName: v('#wf-ver') || '1.0.0',
        versionCode: v('#wf-vcode') || '1'
      };
    }

    function sync() {
      var ta = root.querySelector('#wf-code');
      // 用户手动改过就不再覆盖，避免把人家的改动冲掉
      if (ta && !edited) {
        var s = null;
        if (variant === 'sign') s = readSign(true);
        ta.value = WF_TEMPLATES[picked].yaml(
          variant === 'sign' ? 'release' : variant, s, note(), info());
      }
      var pathTip = root.querySelector('#wf-path');
      if (pathTip) pathTip.textContent = '配置文件：' + WF_TEMPLATES[picked].file;
      UI.$$('#tpl-list .tpl', root).forEach(function (b) {
        var on = b.getAttribute('data-tpl') === picked;
        b.classList.toggle('sel', on);
        var wrap = b.firstElementChild;
        if (wrap && wrap.tagName === 'SPAN') {
          wrap.innerHTML = window.icon(on ? 'check-circle-fill' : 'circle', 16);
          wrap.style.color = on ? 'var(--accent)' : 'var(--fg-muted)';
        }
      });
      var box = root.querySelector('#sign-box');
      if (box) box.hidden = variant !== 'sign';
      var mk = root.querySelector('#sg-make'), im = root.querySelector('#sg-import');
      if (mk) mk.hidden = v('#sg-kind') !== 'make';
      if (im) im.hidden = v('#sg-kind') === 'make';
      var tip = root.querySelector('#sg-tip');
      if (tip) {
        var plain = v('#sg-mode') === 'plain';
        tip.innerHTML = plain
          ? '<b style="color:var(--danger)">密钥会明文写进配置文件，公开仓库任何人都能看到，请谨慎。</b>'
          : '需要在仓库里添加 ' + SIGN_SECRETS.join('、') + ' 四个 Secret，配置里只会出现变量名。';
      }
      var help = root.querySelector('#sg-help');
      if (help) help.hidden = v('#sg-mode') === 'plain' || variant !== 'sign';
    }

    UI.sheet({
      title: '一键打包 APK', body: body, full: true,
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>写入并构建</button>',
      onMount: function () {
        UI.$$('#tpl-list .tpl', root).forEach(function (b) {
          b.onclick = function () {
            picked = b.getAttribute('data-tpl');
            sync();
          };
        });
        root.querySelector('#wf-variant').onchange = function () { variant = this.value; sync(); };
        ['#sg-kind', '#sg-mode'].forEach(function (sel) {
          var el = root.querySelector(sel);
          if (el) el.onchange = function () { sync(); };
        });
        ['#wf-name', '#wf-ver', '#wf-vcode'].forEach(function (sel) {
          var el = root.querySelector(sel);
          if (el) el.addEventListener('input', function () { if (!edited) sync(); });
        });
        UI.$$('#sign-box .input, #sign-box .textarea', root).forEach(function (el) {
          el.addEventListener('input', function () { if (!edited) sync(); });
        });

        var help = root.querySelector('#sg-help');
        if (help) help.onclick = function () {
          window.Native.openInApp('https://github.com/' + repo.full_name +
            '/settings/secrets/actions/new', '添加 Secret');
        };

        // 在 App 内把口令变成真正的签名密钥
        var gen = root.querySelector('#sg-gen');
        if (gen) gen.onclick = function () {
          var seed = v('#sg-seed');
          if (seed.length < 6) return UI.toast('口令至少 6 位');
          if (!/^[A-Za-z0-9]+$/.test(seed)) return UI.toast('口令只能用英文字母和数字');
          UI.loading(true);
          window.Native.makeKeystore(seed, 'githup', seed).then(function (b64) {
            UI.loading(false);
            madeKs = { b64: b64, storePass: seed, alias: 'githup', keyPass: seed };
            var res = root.querySelector('#sg-res');
            if (res) {
              res.innerHTML = '<b style="color:var(--success)">签名已生成</b>，指纹 <span class="mono">' +
                fp(b64) + '</span>　<button class="btn sm" id="sg-copy">复制密钥</button>' +
                '<div class="tiny muted">同一串口令 → 同一个签名，可覆盖安装；换口令就是另一个签名。</div>';
              var cp = root.querySelector('#sg-copy');
              if (cp) cp.onclick = function () {
                window.Native.copy(b64);
                UI.toast('密钥已复制，去 GitHub 存为 KEYSTORE_BASE64');
                window.Native.openInApp('https://github.com/' + repo.full_name +
                  '/settings/secrets/actions/new', '添加 Secret');
              };
            }
            sync();
          }).catch(function (e) {
            UI.loading(false);
            UI.toast('生成失败：' + e.message);
          });
        };

        var noteEl = root.querySelector('#wf-note');
        if (noteEl) noteEl.addEventListener('input', function () { if (!edited) sync(); });

        var ta = root.querySelector('#wf-code');
        ta.addEventListener('input', function () {
          edited = true;
          var lab = root.querySelector('#wf-note-label');
          if (lab) lab.innerHTML = '修改说明 <b style="color:var(--danger)">（改了配置，必填）</b>';
          validate();
        });
        var reset = root.querySelector('[data-reset]');
        if (reset) reset.onclick = function () {
          edited = false;
          var lab = root.querySelector('#wf-note-label');
          if (lab) lab.textContent = '修改说明';
          sync();
          UI.toast('已恢复默认模板');
        };

        /** 编辑后做基本校验，把错误直接写在编辑区下面 */
        function validate() {
          var err = root.querySelector('#wf-err');
          var msg = '';
          var val = ta.value;
          if (!val.trim()) msg = '配置内容不能为空';
          else if (val.indexOf('jobs:') < 0) msg = '配置里必须有 jobs: 段落';
          else if (/\t/.test(val)) msg = 'YAML 不能用 Tab 缩进，请改用空格';
          if (err) err.textContent = msg;
          return !msg;
        }

        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        root.querySelector('[data-yes]').onclick = function () {
          var ref = root.querySelector('#wf-ref2').value;
          if (!validate()) return UI.toast('请先修正配置里的错误');
          var s = null;
          if (variant === 'sign') {
            s = readSign(false);
            if (!s) return;
          }
          // 改过配置就必须写说明：这是硬要求，不然以后没人知道改了什么
          if (edited && !note()) {
            UI.toast('你修改了配置，请先填写修改说明');
            noteEl.classList.add('bad');
            noteEl.focus();
            return;
          }
          noteEl.classList.remove('bad');
          writeWorkflowAndRun(repo, WF_TEMPLATES[picked], ta.value, ref, note(), edited, info());
        };
        sync();
      }
    });
  }

  function writeWorkflowAndRun(repo, tpl, content, ref, note, edited, info) {
    UI.loading(true);
    var path = tpl.file;
    var enc = path.split('/').map(encodeURIComponent).join('/');
    // 说明既进提交信息，也进文件头部注释——配置里看不到改了什么是很痛苦的
    if (note) {
      if (/#\s*修改说明：/.test(content)) {
        content = content.replace(/#\s*修改说明：.*\n/, '# 修改说明：' + note + '\n');
      } else {
        content = '# 修改说明：' + note + '\n' + content;
      }
    }
    // 已存在则覆盖（需要 sha）
    window.API.get('/repos/' + repo.full_name + '/contents/' + enc, { ref: ref }, { cache: 0 })
      .catch(function (e) {
        if (e && (e.status === 404 || e.status === 422)) return { data: null };
        throw e;
      })
      .then(function (r) {
        var sha = (r && r.data && !Array.isArray(r.data)) ? r.data.sha : null;
        var payload = {
          message: 'ci: ' + (edited ? 'update ' : 'add ') + path +
            (note ? ' — ' + note : ' (build APK)'),
          content: b64(content),
          branch: ref
        };
        if (sha) payload.sha = sha;
        return window.API.put('/repos/' + repo.full_name + '/contents/' + enc, payload);
      })
      .then(function () {
        // 新写入的工作流 GitHub 需要几秒才可见，用文件名触发，失败也只是晚几秒
        var i = info || {};
        return window.API.post('/repos/' + repo.full_name + '/actions/workflows/' +
          path.split('/').pop() + '/dispatches', {
            ref: ref,
            inputs: {
              app_name: i.appName || 'app',
              version_name: i.versionName || '1.0.0',
              version_code: String(i.versionCode || '1')
            }
          }).catch(function (e) { return { pending: true, err: e }; });
      })
      .then(function (r) {
        UI.loading(false);
        UI.closeSheet();
        if (r && r.pending) {
          UI.toast('配置已写入，GitHub 正在识别，请稍等几秒后点「手动触发构建」');
        } else {
          UI.toast('已开始构建，完成后点开运行记录即可下载 APK');
        }
        try { window.App.cacheDel('repo_' + repo.full_name); } catch (e) {}
        window.Router.go('/' + repo.full_name + '/actions');
        window.Router.reload();
      })
      .catch(function (e) {
        UI.loading(false);
        UI.toast('写入失败：' + (e.status === 404 ? '找不到该分支' : e.status === 422 ? '无写入权限' : e.message));
      });
  }

  /* ============ 发布 ============ */
  function tabReleases(repo, ctx, box) {
    var canRelease = canPush(repo);

    box.innerHTML =
      (canRelease ? '<div style="padding:10px 12px">' +
        '<button class="btn primary block" id="newrel">' + window.icon('tag', 15) + ' 创建新的发布版本</button></div>' : '') +
      '<div id="rlist">' + UI.skeleton(4) + '</div>';

    var nb = UI.$('#newrel', box);
    if (nb) nb.onclick = function () { newRelease(repo); };

    /** 长按发布条目 → 菜单（删除藏在菜单里，避免手滑点错）。
     *  与通知/收藏夹同款手势：点一下照常进详情，长按 550ms 出菜单 ——
     *  比 500 稍长一点，快滚列表不容易误弹。 */
    function bindRelLongPress(list) {
      UI.$$('.list .list-row', b2root()).forEach(function (el) {
        var rel = list[Number(el.getAttribute('data-i'))];
        if (!rel) return;
        var wasLong = UI.bindLongPress(el, function () { relMenu(rel, el); }, 550);
        /* 长按松手会带出一次合成 click —— 在这里吞掉，
           不然全局 data-go 委托会把「菜单背后的页面」跳走 */
        el.addEventListener('click', function (e) {
          if (wasLong()) { e.stopPropagation(); e.preventDefault(); }
        });
      });
      function b2root() { return UI.$('#rlist', box) || box; }
    }

    /** 长按某个发布：查看详情 / 上传附件 / 删除附件 / 删除发布 */
    function relMenu(rel, el) {
      if (!canRelease) return UI.toast('需要仓库写权限才能管理发布');
      var hasAssets = rel.assets && rel.assets.length > 0;
      UI.menu(rel.name || rel.tag_name, [
        { icon: 'eye', label: '查看发布详情', key: 'open' },
        { icon: 'upload', label: '上传 APK 附件', key: 'apk' },
        { icon: 'x', label: '删除附件' + (hasAssets ? '（' + rel.assets.length + ' 个）' : '（暂无附件）'), key: 'delasset', disabled: !hasAssets },
        '-',
        { icon: 'trash', label: '删除此发布', key: 'del' }
      ]).then(function (k) {
        if (!k) return;
        if (k === 'open') return window.Router.go('/' + repo.full_name + '/releases/' + rel.tag_name);
        if (k === 'apk') return upApkRel(rel);
        if (k === 'delasset') return delAssetRel(rel, el);
        if (k === 'del') return delRelease(rel, el);
      });
    }

    /** 删除发布的某个附件：列出所有附件供选择 → 确认 → DELETE asset。
     *  误删了附件不影响发布本身，重新上传即可，所以不需要二次确认之外的保护。 */
    function delAssetRel(rel, el) {
      if (!rel.assets || !rel.assets.length) return UI.toast('该发布暂无附件');
      var items = rel.assets.map(function (a) {
        return { icon: 'package', label: a.name + '（' + U.bytes(a.size) + '）', key: String(a.id) };
      });
      UI.menu('删除附件', items).then(function (id) {
        if (!id) return;
        var asset = rel.assets.filter(function (a) { return String(a.id) === id; })[0];
        if (!asset) return;
        UI.confirm('删除附件',
          '将从 ' + rel.tag_name + ' 中删除附件「' + asset.name + '」。' +
          '发布本身不会被删除，附件删除后可重新上传。',
          '删除', true).then(function (ok) {
            if (!ok) return;
            UI.loading(true);
            window.API.del('/repos/' + repo.full_name + '/releases/assets/' + asset.id)
              .then(function () {
                UI.loading(false);
                UI.toast('已删除附件 ' + asset.name);
                /* 从本地列表里移除这个附件，不用整页刷新 */
                rel.assets = rel.assets.filter(function (a) { return a.id !== asset.id; });
                window.Router.reload();
              })
              .catch(function (e) {
                UI.loading(false);
                UI.toast('删除失败：' + (e.message || e));
              });
          });
      });
    }

    /** 给某条发布补传附件（漏传的 APK 就靠这个）：选文件 → 同名旧附件先删 → 原生直传。
     *  与「创建发布」的附件上传走同一条原生二进制通道，复用同款 200MB 上限。 */
    function upApkRel(rel) {
      if (!window.Native.canPick()) {
        return UI.confirm('需要应用内支持', '当前环境无法选择本地文件。请安装最新版应用后重试。', '知道了').then(function () {});
      }
      window.Native.pickFile('*/*').then(function (meta) {
        if (!meta) return;
        if (meta.size > 200 * 1024 * 1024) return UI.toast('文件过大，单个附件不超过 200MB');
        var olds = (rel.assets || []).filter(function (a) { return a.name === meta.name; });
        UI.confirm('上传附件到 ' + rel.tag_name,
          '将上传「' + meta.name + '」（' + U.bytes(meta.size) + '）' +
          (olds.length ? '，并替换同名旧附件（' + U.bytes(olds[0].size) + '）' : '，支持 APK / AAB / ZIP 等任意文件') + '。',
          '上传').then(function (go) {
            if (!go) return;
            UI.loading(true);
            /* GitHub 不允许同名附件并存 —— 传之前把同名的旧附件删掉，失败才算失败 */
            var pre = Promise.resolve();
            olds.forEach(function (a) {
              pre = pre.then(function () {
                return window.API.del('/repos/' + repo.full_name + '/releases/assets/' + a.id);
              });
            });
            pre.then(function () {
              var url = 'https://uploads.github.com/repos/' + repo.full_name +
                '/releases/' + rel.id + '/assets?name=' + encodeURIComponent(meta.name) +
                '&label=' + encodeURIComponent(meta.name);
              return window.Native.uploadBinary(url, meta.uri, {
                'Authorization': 'Bearer ' + window.Session.token,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': meta.mime || 'application/octet-stream'
              }).then(function (res) {
                /* 原生回执是 {status, body}：status=0 是本地异常（内存/网络），
                   >=400 是 GitHub 拒绝 —— 都要转成失败，不然这里会把
                   「上传失败」当成「上传完成」报喜。 */
                if (res && (res.status === 0 || res.status >= 400)) {
                  var m = '';
                  try { m = (JSON.parse(res.body) || {}).error
                        || (JSON.parse(res.body) || {}).message || ''; } catch (e) {}
                  throw new Error(m || ('HTTP ' + res.status));
                }
                return res;
              });
            }).then(function () {
              UI.loading(false);
              UI.toast('附件已上传到 ' + rel.tag_name);
              try { window.App.invalidate('/repos/' + repo.full_name + '/releases'); } catch (e) {}
              window.Router.reload();
            }).catch(function (e) {
              UI.loading(false);
              UI.toast('上传失败：' + (e.status === 422 ? '同名附件冲突或无权限' : e.message));
            });
          });
      }).catch(function (e) {
        if (e.message !== '选择文件超时') UI.toast('选择失败：' + e.message);
      });
    }

    /** 删除发布： danger 确认 → DELETE → 行从列表里消失（删光了自动重画空态） */
    function delRelease(rel, el) {
      var n = rel.assets ? rel.assets.length : 0;
      UI.confirm('删除发布 ' + rel.tag_name,
        '将删除发布「' + (rel.name || rel.tag_name) + '」' +
        (n ? '及其 ' + n + ' 个附件' : '') +
        '。git 标签会保留，但这个版本会从 Release 列表里消失，操作不可撤销。',
        '删除', true).then(function (ok) {
          if (!ok) return;
          UI.loading(true);
          window.API.del('/repos/' + repo.full_name + '/releases/' + rel.id)
            .then(function () {
              UI.loading(false);
              UI.toast('已删除 ' + rel.tag_name);
              el.remove();
              var rl = UI.$('#rlist', box);
              if (rl && !UI.$$('.list .list-row', rl).length) window.Router.reload();
            })
            .catch(function (e) {
              UI.loading(false);
              UI.toast('删除失败：' + (e.status === 403 ? '需要仓库写权限' : e.message));
            });
        });
    }

    return window.API.get('/repos/' + repo.full_name + '/releases', { per_page: 50 }, { cache: 60000 }).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#rlist', box); if (!b) return;
      if (!list.length) {
        b.innerHTML = UI.empty('tag', '暂无发布版本',
          canRelease ? '点上方按钮发布第一个版本，可附加 APK 等文件；发布后长按条目可删除' : '维护者发布版本后会显示在这里');
        return;
      }
      b.innerHTML = '<div class="list">' + list.map(function (rel, i) {
        var assets = rel.assets || [];
        return '<button class="list-row" data-go="/' + U.esc(repo.full_name) + '/releases/' + U.esc(rel.tag_name) + '" data-i="' + i + '">' +
          '<span style="color:' + (rel.prerelease ? 'var(--attention)' : 'var(--success)') + ';margin-top:3px">' + window.icon('tag', 16) + '</span>' +
          '<span class="row-main"><span class="row-title">' + U.esc(rel.name || rel.tag_name) +
          (rel.draft ? ' <span class="chip" style="padding:0 5px">草稿</span>' : '') + '</span>' +
          '<span class="row-desc mono">' + U.esc(rel.tag_name) + (rel.prerelease ? ' · 预览版' : '') + '</span>' +
          '<span class="row-meta"><span>' + U.esc((rel.author && rel.author.login) || '') + '</span><span>' + U.date(rel.published_at) + '</span>' +
          (assets.length ? '<span>' + window.icon('package', 12) + assets.length + ' 个附件 · ' +
            U.num(assets.reduce(function (s, a) { return s + (a.download_count || 0); }, 0)) + ' 次下载</span>' : '') +
          '</span></span></button>';
      }).join('') + '</div>';
      window.bindRepoCards(b);
      bindRelLongPress(list);
    }).catch(function (e) { UI.$('#rlist', box).innerHTML = UI.errorBox(e); });
  }

  /* ============ 创建 Release（可上传 APK 等附件） ============ */
  function newRelease(repo) {
    if (!window.Session.isLogin) return UI.toast('请先登录');

    var files = [];      // [{name,size,mime,uri}]
    var MAX_ASSET = 200 * 1024 * 1024;

    var body =
      '<div class="field"><label>标签版本 <span style="color:var(--danger)">*</span></label>' +
      '<input class="input mono" id="rl-tag" placeholder="v1.0.0" autocomplete="off">' +
      '<div class="hint">如果标签不存在，会自动基于目标分支创建。</div></div>' +
      '<div class="field"><label>目标分支</label>' +
      '<input class="input mono" id="rl-branch" value="' + U.esc(repo.default_branch || 'main') + '" autocomplete="off"></div>' +
      '<div class="field"><label>发布标题</label>' +
      '<input class="input" id="rl-name" placeholder="留空则使用标签名"></div>' +
      '<div class="field"><label>说明</label>' +
      '<textarea class="textarea" id="rl-body" rows="5" placeholder="本次更新内容…"></textarea></div>' +
      '<div class="field"><label>附加文件（APK 等）</label>' +
      '<div class="upload-box">' +
      '<button class="btn block" id="rl-pick">' + window.icon('upload', 15) + ' 选择文件</button>' +
      '<div id="rl-files" class="upload-list"></div>' +
      '<div class="hint">支持 APK / AAB / ZIP 等任意文件，单个不超过 200MB。</div>' +
      '</div></div>' +
      '<div class="field"><label>选项</label>' +
      '<label class="rowflex" style="gap:8px;padding:8px 0"><input type="checkbox" id="rl-pre" style="width:16px;height:16px">' +
      '<span>标记为预发布版本</span></label>' +
      '<label class="rowflex" style="gap:8px;padding:8px 0"><input type="checkbox" id="rl-draft" style="width:16px;height:16px">' +
      '<span>保存为草稿（暂不公开）</span></label>' +
      '</div>';

    var root = document.getElementById('sheet-root');
    UI.sheet({
      title: '创建发布版本', full: true, body: body,
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>发布</button>',
      onMount: function () {
        var pick = root.querySelector('#rl-pick');
        var listEl = root.querySelector('#rl-files');

        function paintFiles() {
          if (!files.length) { listEl.innerHTML = ''; return; }
          listEl.innerHTML = files.map(function (f, i) {
            return '<div class="upload-item">' +
              '<span class="fi">' + window.icon(isApk(f.name) ? 'package' : 'file', 18) + '</span>' +
              '<span class="grow"><span class="fn">' + U.esc(f.name) + '</span>' +
              '<span class="fs">' + U.bytes(f.size) + ' · ' + U.esc(f.mime) + '</span></span>' +
              '<button class="icon-btn" data-rm="' + i + '" aria-label="移除">' + window.icon('x', 16) + '</button></div>';
          }).join('');
          UI.$$('[data-rm]', listEl).forEach(function (b) {
            b.onclick = function () {
              files.splice(parseInt(b.getAttribute('data-rm'), 10), 1);
              paintFiles();
            };
          });
        }

        pick.onclick = function () {
          if (!window.Native.canPick()) {
            return UI.confirm('需要应用内支持',
              '当前环境无法选择本地文件。请安装最新版应用后重试。', '知道了').then(function () {});
          }
          window.Native.pickFile('*/*').then(function (meta) {
            if (!meta) return;
            if (meta.size > MAX_ASSET) return UI.toast('文件过大，单个附件不超过 200MB');
            files.push(meta);
            paintFiles();
          }).catch(function (e) {
            if (e.message !== '选择文件超时') UI.toast('选择失败：' + e.message);
          });
        };

        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        root.querySelector('[data-yes]').onclick = function () {
          var tag = root.querySelector('#rl-tag').value.trim();
          if (!tag) return UI.toast('请填写标签版本');
          var isPre = root.querySelector('#rl-pre').checked;
          var isDraft = root.querySelector('#rl-draft').checked;

          UI.loading(true);
          window.API.post('/repos/' + repo.full_name + '/releases', {
            tag_name: tag,
            target_commitish: root.querySelector('#rl-branch').value.trim() || repo.default_branch,
            name: root.querySelector('#rl-name').value.trim() || tag,
            body: root.querySelector('#rl-body').value || '',
            draft: isDraft,
            prerelease: isPre
          }).then(function (r) {
            var rel = r.data;
            if (!files.length) { UI.loading(false); return rel; }
            // 逐个上传附件（二进制走原生）
            var chain = Promise.resolve();
            files.forEach(function (f) {
              chain = chain.then(function () {
                var url = 'https://uploads.github.com/repos/' + repo.full_name +
                  '/releases/' + rel.id + '/assets?name=' + encodeURIComponent(f.name) +
                  '&label=' + encodeURIComponent(f.name);
                return window.Native.uploadBinary(url, f.uri, {
                  'Authorization': 'Bearer ' + window.Session.token,
                  'Accept': 'application/vnd.github+json',
                  'X-GitHub-Api-Version': '2022-11-28',
                  'Content-Type': f.mime || 'application/octet-stream'
                }).then(function (res) {
                  // status=0 本地异常 / >=400 GitHub 拒绝：转失败，别报喜
                  if (res && (res.status === 0 || res.status >= 400)) {
                    var m = '';
                    try { m = (JSON.parse(res.body) || {}).error
                          || (JSON.parse(res.body) || {}).message || ''; } catch (e) {}
                    throw new Error(m || ('HTTP ' + res.status));
                  }
                  return res;
                });
              });
            });
            return chain.then(function () { return rel; });
          }).then(function (rel) {
            UI.loading(false);
            UI.closeSheet();
            UI.toast(files.length ? '已发布，附件上传完成' : '发布成功');
            try { window.App.invalidate('/repos/' + repo.full_name + '/releases'); } catch (e) {}
            window.Router.go('/' + repo.full_name + '/releases/' + encodeURIComponent(rel.tag_name));
          }).catch(function (e) {
            UI.loading(false);
            UI.toast('发布失败：' + (e.status === 422 ? '标签已存在或无权限' : e.message));
          });
        };
      }
    });
  }

  function isApk(name) { return /\.apk$/i.test(name || ''); }
  window.newRelease = newRelease;

  /* ============================================================
   * 在线编辑 / 新建文件（对标官网的铅笔图标与 Add file → Create new file）
   *
   * GitHub 的 contents 接口只用一个 PUT 就能写完，靠「带不带 sha」区分
   * 新建与更新：带 sha 是更新已有文件，不带就是新建。所以编辑器可以做成
   * 同一套界面，只是预填的来源不同。
   * ============================================================ */

  /**
   * 读某个分支上某文件的文本 + sha。
   * 返回 null 有三种情况：文件不存在、这是个目录、文件超过 1MB（接口不吐 content）。
   * 前两种对「新建」来说完全正常，所以这里不抛错，交给调用方判断。
   */
  function readFileText(repo, ref, path) {
    return window.API.get('/repos/' + repo.full_name + '/contents/' + encodePath(path), { ref: ref }, { cache: 0 })
      .then(function (r) {
        var d = r && r.data;
        if (!d || Array.isArray(d) || !d.content) return null;
        return { text: U.decodeBase64(d.content), sha: d.sha };
      })
      .catch(function (e) {
        if (e && (e.status === 404 || e.status === 422)) return null;
        throw e;
      });
  }

  /** 拉分支名做下拉；失败时至少保证当前 ref 可选，不给空的下拉 */
  function loadBranchNames(repo, cur) {
    return window.API.get('/repos/' + repo.full_name + '/branches', { per_page: 100 }, { cache: 30000 })
      .then(function (r) {
        var bs = (r.data || []).map(function (x) { return x.name; });
        if (cur && bs.indexOf(cur) < 0) bs.unshift(cur);
        return bs.length ? bs : [cur || repo.default_branch];
      })
      .catch(function () { return [cur || repo.default_branch]; });
  }

  function branchSelectHtml(id, branches, cur) {
    return '<select class="input mono" id="' + id + '">' + branches.map(function (b) {
      return '<option value="' + U.esc(b) + '"' + (b === cur ? ' selected' : '') + '>' + U.esc(b) + '</option>';
    }).join('') + '</select>';
  }

  /**
   * 编辑器本体。opt.isNew = 新建（路径可改、不带 sha）；否则是编辑已有文件。
   * 预填数据由调用方准备好传进来，编辑器自己不发「读」请求，
   * 这样加载态和错误提示都在入口处统一处理。
   */
  function openEditor(repo, ref, opt) {
    opt = opt || {};
    var isNew = !!opt.isNew;
    var path = opt.path || '';
    var sha = opt.sha || null;
    var text = opt.text || '';
    var branches = opt.branches || [ref || repo.default_branch];
    var name = path.split('/').pop();
    var root = document.getElementById('sheet-root');

    var body =
      '<div class="field"><label>文件路径' + (isNew ? ' <span style="color:var(--danger)">*</span>' : '') + '</label>' +
      (isNew
        ? '<input class="input mono" id="ef-path" value="' + U.esc(path) + '" placeholder="例如 docs/guide.md" spellcheck="false">'
        : '<input class="input mono" id="ef-path" value="' + U.esc(path) + '" readonly>' +
          '<div class="hint">要改文件名请用/web 端的重命名，或直接新建到新路径。</div>') +
      '</div>' +
      '<div class="field"><label>提交到分支</label>' + branchSelectHtml('ef-branch', branches, ref) +
      '<div class="hint">' + (isNew
        ? '这个分支上还不存在该文件，提交后会新建它。'
        : '换成本仓库其他分支就能把改动提交过去；当前分支以外的分支需要有写权限。') + '</div></div>' +
      '<div class="field"><label>文件内容' + (isNew ? '' : ' <span class="muted" style="font-weight:400">（' +
        U.esc(U.bytes(text.length)) + '）</span>') + '</label>' +
      '<div class="rowflex" style="justify-content:flex-end;margin-bottom:6px"><button class="btn sm" id="ef-wrap"></button></div>' +
      '<div class="editor' + (isCodeWrap() ? ' wrap' : '') + '" id="ef-ed" style="font-size:' + (window.Store.get('codeFont') || 13) + 'px">' +
        '<div class="ed-hl" aria-hidden="true"><div class="ed-inner" id="ef-hl"></div></div>' +
        '<textarea class="ed-ta" id="ef-body" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"></textarea>' +
      '</div>' +
      '<div class="hint" id="ef-stat"></div></div>' +
      '<div class="field"><label>提交信息 <span style="color:var(--danger)">*</span></label>' +
      '<input class="input" id="ef-msg" placeholder="' + U.esc(isNew ? 'Create ' + name : 'Update ' + name) + '"></div>' +
      '<div class="muted tiny">提交后会立即写入该分支。若改动涉及多个文件，建议在网页端一起处理。</div>';

    UI.sheet({
      title: isNew ? '新建文件' : '编辑 ' + U.esc(name),
      full: true, body: body,
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>' +
        (isNew ? '创建文件' : '提交更改') + '</button>',
      onMount: function () {
        var ta = root.querySelector('#ef-body');
        var stat = root.querySelector('#ef-stat');
        var hl = root.querySelector('#ef-hl');
        var edEl = root.querySelector('#ef-ed');
        var wbtn = root.querySelector('#ef-wrap');

        /* 高亮层跟着 textarea 一起滚：textarea 是唯一的滚动条，
           高亮层用 transform 平移对齐它。换行态下不横向滚。 */
        function syncScroll() {
          hl.style.transform = 'translate(' + (-ta.scrollLeft) + 'px,' + (-ta.scrollTop) + 'px)';
        }
        function renderHl() {
          hl.innerHTML = codeRowsHtml(highlightLines(ta.value, name));
          syncScroll();
        }
        function updStat() {
          var v = ta.value;
          var lines = v.split('\n').length;
          stat.textContent = lines + ' 行 · ' + U.bytes(v.length) +
            (opt.text !== undefined && v === opt.text ? ' · 未修改' : '');
        }
        function paintWrap() {
          var on = isCodeWrap();
          edEl.classList.toggle('wrap', on);
          ta.setAttribute('wrap', on ? 'soft' : 'off');
          wbtn.innerHTML = window.icon('three-bars', 13) + ' ' + (on ? '不换行' : '自动换行');
        }

        ta.value = text;
        paintWrap();
        renderHl();
        updStat();

        var hlTimer = null;
        ta.oninput = function () {
          updStat();
          if (hlTimer) clearTimeout(hlTimer);
          hlTimer = setTimeout(renderHl, 150);
        };
        ta.onscroll = syncScroll;
        wbtn.onclick = function () {
          setCodeWrap(!isCodeWrap());
          paintWrap();
          renderHl();
        };

        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        root.querySelector('[data-yes]').onclick = function () {
          var p = root.querySelector('#ef-path').value.trim().replace(/^\/+|\/+$/g, '');
          if (!p) return UI.toast('请填写文件路径');
          var msg = root.querySelector('#ef-msg').value.trim() || (isNew ? 'Create ' + p : 'Update ' + p);
          var branch = root.querySelector('#ef-branch').value || repo.default_branch;
          var content = ta.value;
          if (!isNew && content === text) return UI.toast('内容没有变化');

          UI.loading(true);
          var payload = { message: msg, content: b64(content), branch: branch };
          /* 不换分支就用现成的 sha；换了分支必须在目标分支重取，
             因为同一个路径在不同分支上指向的 blob 可能不同。 */
          var getSha = !isNew && branch === ref
            ? Promise.resolve(sha)
            : readFileText(repo, branch, p).then(function (r) { return r ? r.sha : null; });

          getSha.then(function (s) {
            if (s) payload.sha = s;
            return window.API.put('/repos/' + repo.full_name + '/contents/' + encodePath(p), payload);
          }).then(function () {
            UI.loading(false);
            UI.closeSheet();
            UI.toast(isNew ? '文件已创建' : '已提交更改');
            try { window.App.cacheDel('repo_' + repo.full_name); } catch (e) {}
            window.Router.go(refUrl(repo, 'blob', p, branch));
            window.Router.reload();
          }).catch(function (e) {
            UI.loading(false);
            UI.toast('提交失败：' + (e.status === 422 ? '无写入权限或内容与分支不匹配' : e.message));
          });
        };
      }
    });
  }

  /** 编辑已有文件：从文件页的「编辑」进入 */
  function editFile(repo, ref, path) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    if (!canPush(repo)) return UI.toast('没有该仓库的写入权限');
    UI.loading(true);
    Promise.all([readFileText(repo, ref, path), loadBranchNames(repo, ref)])
      .then(function (rs) {
        UI.loading(false);
        var f = rs[0];
        if (!f) {
          return UI.confirm('无法在线编辑',
            '这个文件太大（超过 1MB）、是二进制格式，或者在 ' + ref + ' 上不存在。\n\n可以新建一个同名文件覆盖它，二进制文件建议在网页端处理。',
            '仍然新建', true).then(function (ok) {
            if (!ok) return;
            openEditor(repo, ref, { isNew: true, path: path, branches: rs[1] });
          });
        }
        openEditor(repo, ref, { isNew: false, path: path, text: f.text, sha: f.sha, branches: rs[1] });
      })
      .catch(function (e) {
        UI.loading(false);
        UI.toast('读取文件失败：' + e.message);
      });
  }

  /** 新建文件：从目录页的「＋」进入，dirpath 决定默认落在哪个目录 */
  function newFile(repo, ref, dirpath) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    if (!canPush(repo)) return UI.toast('没有该仓库的写入权限');
    UI.loading(true);
    loadBranchNames(repo, ref).then(function (bs) {
      UI.loading(false);
      openEditor(repo, ref, { isNew: true, path: (dirpath ? dirpath + '/' : ''), branches: bs });
    });
  }

  window.editFile = editFile;
  window.newFile = newFile;

  /* ============ 上传文件到仓库（对标官网 Add file → Upload files） ============ */
  function uploadFile(repo, ref, dirpath) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    if (!window.Native.canPick()) {
      return UI.confirm('需要应用内支持',
        '当前环境无法选择本地文件。请安装最新版应用后重试。', '知道了').then(function () {});
    }
    var MAX = 25 * 1024 * 1024;   // 与官网网页上传的单文件上限一致
    var file = null;      // 单文件模式（pickFile 的结果）
    var folder = null;    // 文件夹模式：{folder:true, name, uri}
    var files = null;     // 文件夹展开后的文件清单（含相对路径）

    var body =
      '<div class="field"><label>选择文件或文件夹 <span style="color:var(--danger)">*</span></label>' +
      '<div class="upload-box">' +
      '<div style="display:flex;gap:8px">' +
      '<button class="btn block" style="flex:1" id="uf-pick">' + window.icon('upload', 15) + ' 选择文件</button>' +
      '<button class="btn block" style="flex:1" id="uf-folder">' + window.icon('upload', 15) + ' 选择文件夹</button>' +
      '</div>' +
      '<div id="uf-file" class="upload-list"></div>' +
      '<div class="hint">单个文件不超过 25MB；选文件夹会连同子目录一起上传，整批合成一个提交。</div>' +
      '</div></div>' +
      '<div class="field"><label>上传到目录</label>' +
      '<input class="input mono" id="uf-dir" value="' + U.esc(dirpath || '') + '" placeholder="留空则上传到仓库根目录"></div>' +
      '<div class="field"><label>提交信息 <span style="color:var(--danger)">*</span></label>' +
      '<input class="input" id="uf-msg" placeholder="Add files via upload"></div>' +
      '<div class="field"><label>分支</label>' +
      '<input class="input mono" id="uf-branch" value="' + U.esc(ref || repo.default_branch) + '"></div>';

    var root = document.getElementById('sheet-root');
    UI.sheet({
      title: '上传文件', full: true, body: body,
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>提交</button>',
      onMount: function () {
        var fileEl = root.querySelector('#uf-file');
        var pick = root.querySelector('#uf-pick');
        var folderBtn = root.querySelector('#uf-folder');

        function paint() {
          pick.textContent = file ? '重新选择文件' : '选择文件';
          folderBtn.textContent = folder ? '更换文件夹' : '选择文件夹';
          if (file) {
            fileEl.innerHTML = '<div class="upload-item">' +
              '<span class="fi">' + window.icon('file', 18) + '</span>' +
              '<span class="grow"><span class="fn">' + U.esc(file.name) + '</span>' +
              '<span class="fs">' + U.bytes(file.size) + ' · ' + U.esc(file.mime) + '</span></span></div>';
          } else if (folder && files) {
            var total = 0;
            files.forEach(function (f) { total += f.size; });
            var preview = files.slice(0, 3).map(function (f) { return f.path; }).join(' · ');
            fileEl.innerHTML = '<div class="upload-item">' +
              '<span class="fi">' + window.icon('file', 18) + '</span>' +
              '<span class="grow"><span class="fn">' + U.esc(folder.name) + '/</span>' +
              '<span class="fs">' + files.length + ' 个文件 · ' + U.bytes(total) +
              (preview ? ' · ' + U.esc(preview) + (files.length > 3 ? ' …' : '') : '') +
              '</span></span></div>';
          } else {
            fileEl.innerHTML = '';
          }
        }

        pick.onclick = function () {
          window.Native.pickFile('*/*').then(function (meta) {
            if (!meta) return;
            if (meta.size > MAX) return UI.toast('文件过大（' + U.bytes(meta.size) + '），请控制在 25MB 内');
            file = meta;
            folder = null; files = null;    // 两种模式互斥
            paint();
          }).catch(function (e) {
            if (e.message !== '选择文件超时') UI.toast('选择失败：' + e.message);
          });
        };

        folderBtn.onclick = function () {
          window.Native.pickFolder().then(function (meta) {
            if (!meta) return;
            UI.loading(true);
            return window.Native.listFolder(meta.uri).then(function (list) {
              UI.loading(false);
              if (!list.length) { UI.toast('这个文件夹里没有文件'); return; }
              file = null;
              folder = meta;
              files = list;
              paint();
            });
          }).catch(function (e) {
            UI.loading(false);
            if (e.message !== '选择文件夹超时') UI.toast('选择失败：' + e.message);
          });
        };

        /* ───────── 文件夹上传：整批文件合成**一个提交**（对齐官网） ─────────
         *
         * 逐文件 PUT Contents API 会刷出 N 个提交，历史没法看。
         * 官网网页上传是把整批文件放进同一个 commit —— 用 Git Data API 复刻：
         *   1) 每个文件 POST /git/blobs（内容走原生流式 b64，前端只拿 sha）
         *   2) 读分支顶端 commit → 它的 tree（作 base_tree）
         *   3) POST /git/trees：以 base_tree 为底，把整批文件一次性挂上
         *      （子目录路径自动创建中间节点，与官网一致）
         *   4) POST /git/commits → PATCH ref
         * 全程原子：中途失败仓库不会有半套文件。
         */
        function uploadTree(branch, msg, items, dir) {
          var hdr = {
            'Authorization': 'Bearer ' + window.Session.token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
          };
          var entries = [];
          var chain = Promise.resolve();
          items.forEach(function (f) {
            chain = chain.then(function () {
              var url = 'https://api.github.com/repos/' + repo.full_name + '/git/blobs';
              return window.Native.uploadMultipartB64(url, f.uri, hdr,
                '{"content":"', '","encoding":"base64"}').then(function (res) {
                if (res && (res.status === 0 || res.status >= 400)) {
                  var m = '';
                  try { m = (JSON.parse(res.body) || {}).message || ''; } catch (e) {}
                  throw new Error('上传 ' + f.path + ' 失败' + (m ? '：' + m : '（HTTP ' + res.status + '）'));
                }
                var sha = null;
                try { sha = (JSON.parse(res.body) || {}).sha; } catch (e) {}
                if (!sha) throw new Error('上传 ' + f.path + ' 失败：没有返回 sha');
                entries.push({ path: (dir ? dir + '/' : '') + f.path,
                  mode: '100644', type: 'blob', sha: sha });
              });
            });
          });
          return chain.then(function () {
            return window.API.get('/repos/' + repo.full_name + '/git/ref/heads/' + branch,
              null, { cache: 0 }).then(function (r) {
                var parentSha = r.data.object.sha;
                return window.API.get('/repos/' + repo.full_name + '/git/commits/' + parentSha,
                  null, { cache: 0 }).then(function (cr) {
                    return window.API.post('/repos/' + repo.full_name + '/git/trees', {
                      base_tree: cr.data.tree.sha,
                      tree: entries
                    }).then(function (tr) {
                      return window.API.post('/repos/' + repo.full_name + '/git/commits', {
                        message: msg,
                        tree: tr.data.sha,
                        parents: [parentSha]
                      });
                    }).then(function (cm) {
                      return window.API.patch('/repos/' + repo.full_name +
                        '/git/refs/heads/' + branch, { sha: cm.data.sha, force: false });
                    });
                  });
              });
          });
        }

        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        root.querySelector('[data-yes]').onclick = function () {
          var dir = root.querySelector('#uf-dir').value.trim().replace(/^\/+|\/+$/g, '');
          var branch = root.querySelector('#uf-branch').value.trim() || repo.default_branch;

          /* ═══ 文件夹模式 ═══ */
          if (folder) {
            if (!files || !files.length) return UI.toast('请先选择文件夹');
            var tooBig = files.filter(function (f) { return f.size > MAX; });
            var items = files.filter(function (f) { return f.size <= MAX; });
            if (!items.length) return UI.toast('文件都超过 25MB，无法上传');
            var msg = root.querySelector('#uf-msg').value.trim() || 'Add files via upload';

            UI.loading(true);
            uploadTree(branch, msg, items, dir).then(function () {
              UI.loading(false);
              UI.closeSheet();
              UI.toast('已上传 ' + items.length + ' 个文件' +
                (tooBig.length ? '（' + tooBig.length + ' 个超限文件已跳过）' : ''));
              try { window.App.cacheDel('repo_' + repo.full_name); } catch (e) {}
              window.Router.go('/' + repo.full_name + '/tree/' + encodeURIComponent(branch) +
                (dir ? '/' + encodePath(dir) : ''));
              window.Router.reload();
            }).catch(function (e) {
              UI.loading(false);
              UI.toast('上传失败：' + (e.message || '未知错误'));
            });
            return;
          }

          /* ═══ 单文件模式 ═══ */
          if (!file) return UI.toast('请先选择文件');
          var msg = root.querySelector('#uf-msg').value.trim();
          if (!msg) msg = 'Add ' + file.name + ' via upload';
          var path = (dir ? dir + '/' : '') + file.name;

          UI.loading(true);
          var existed = false;
          // 1) 若文件已存在，需要先取 sha（走更新而非新建）
          window.API.get('/repos/' + repo.full_name + '/contents/' + encodePath(path),
            { ref: branch }, { cache: 0 }).catch(function (e) {
              // 404 = 文件还不存在，属于正常的新建上传，不能当成失败
              if (e && (e.status === 404 || e.status === 422)) return { data: null };
              throw e;
            }).then(function (r) {
              var sha = (r && r.data && !Array.isArray(r.data)) ? r.data.sha : null;
              existed = !!sha;
              /* 2) 原生流式直传，文件内容**不回前端**。
               *
               * 以前是 readFileBase64 把整个文件编成 Base64 拿回 JS 再拼 JSON：
               * 25MB 文件就是 33MB 字符串，evaluateJavascript 与拼接的每一步
               * 都在撑内存 —— 中低端机「一上传就闪退」的真身就是它。
               *
               * 现在原生把 head + 文件(边读边编 Base64) + tail 拼成流直接
               * PUT 出去，内存占用与文件大小无关。 */
              var url = 'https://api.github.com/repos/' + repo.full_name +
                '/contents/' + encodePath(path);
              var head = '{"message":' + JSON.stringify(msg) + ',"content":"';
              var tail = '","branch":' + JSON.stringify(branch) +
                (sha ? ',"sha":' + JSON.stringify(sha) : '') + '}';
              return window.Native.uploadMultipartB64(url, file.uri, {
                'Authorization': 'Bearer ' + window.Session.token,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json'
              }, head, tail).then(function (res) {
                // _cb 的回执是 {status, body} —— 4xx/5xx 在这里转成失败，
                // 让后面的 .catch 统一给提示（GitHub 的报错正文就在 body 里）
                if (res && res.status >= 400) {
                  var m = '';
                  try { m = (JSON.parse(res.body) || {}).message || ''; } catch (e) {}
                  throw new Error(m || ('HTTP ' + res.status));
                }
                return res;
              });
            }).then(function () {
              UI.loading(false);
              UI.closeSheet();
              UI.toast(existed ? '文件已更新' : '文件已上传');
              try { window.App.cacheDel('repo_' + repo.full_name); } catch (e) {}
              window.Router.go('/' + repo.full_name + '/tree/' + encodeURIComponent(branch) +
                (dir ? '/' + encodePath(dir) : ''));
              window.Router.reload();
            }).catch(function (e) {
              UI.loading(false);
              UI.toast('上传失败：' + (e.status === 422 ? '无写入权限或内容不合法' : e.message));
            });
        };
      }
    });
  }
  window.uploadFile = uploadFile;

  /* ============ 提交 / 贡献者 / 分支 ============ */
  /* ============================================================
   * 提交记录的两种「反做」：撤销（Revert）与回滚（Reset）
   *
   *  - 撤销提交：保留历史，在分支顶端**新增一个反向提交**，把所选提交的
   *    改动原样抵消。相当于 `git revert <sha>`。
   *  - 回滚提交：把分支指针**直接移回**该提交，丢弃它之后的提交。
   *    相当于 `git reset --hard <sha>`，会改写历史、不可恢复。
   *
   * ⚠️ GitHub 的 REST 没有现成的 revert 接口（GraphQL 那个 revertPullRequest
   * 只对「已合并的 PR」有效），撤销只能自己用 Git Data API 拼：
   *   1. 读目标提交 → 它改了哪些文件、父提交是谁；
   *   2. 读父提交的完整文件树 → 这些文件当时的 blob sha（只搬 sha，不下载内容，
   *      二进制文件同样成立）；
   *   3. 以当前分支顶端为 base_tree，把这些文件覆盖回父提交里的版本
   *      （新增的文件则 sha 置 null 删掉）；
   *   4. 建 tree → 建 commit（parent = 分支顶端）→ 更新 ref。
   * 这样即使被撤销的提交之后又有别的提交，反向提交也能正确地叠在最上面。
   * ============================================================ */

  /** 单个提交能拿回的改动文件上限（GitHub 的 /commits/{sha} 限制） */
  var FILE_CAP = 300;

  /** 分支名可能带斜杠（feature/x），逐段编码后再拼进 git ref 路径 */
  function encRef(ref) {
    return String(ref || '').split('/').map(encodeURIComponent).join('/');
  }

  /** 读某个分支当前指向的提交 sha */
  function refHeadSha(full, branch) {
    return window.API.get('/repos/' + full + '/git/ref/heads/' + encRef(branch))
      .then(function (r) { return r.data.object.sha; });
  }

  /** 读某个提交对应的 tree sha */
  function commitTreeSha(full, sha) {
    return window.API.get('/repos/' + full + '/git/commits/' + sha)
      .then(function (r) { return r.data.tree.sha; });
  }

  /** 把 Git 接口的报错翻成人话 */
  function commitOpError(e) {
    if (e && e.status === 403) return '没有权限（需要写权限，或对应分支受保护）';
    if (e && e.status === 404) return '目标分支不存在（当前 ref 可能是个标签）';
    if (e && e.status === 409) return '分支已被改动，请刷新后重试';
    if (e && e.status === 422) return (e.message || '分支受保护或参数被拒绝');
    return (e && e.message) || '操作失败';
  }

  /**
   * 撤销：在 branch 顶端新建一个「反向提交」，抵消 sha 这个提交的改动。
   * 全程只引用 blob 的 sha，不下载文件内容。
   */
  function revertCommit(repo, branch, sha) {
    var full = repo.full_name;
    var files, parentSha, title;
    return window.API.get('/repos/' + full + '/commits/' + sha).then(function (r) {
      var c = r.data;
      if (!c) throw new Error('读取提交失败');
      if (!c.parents || !c.parents.length) throw new Error('这是根提交，没有可回退的父提交');
      if (c.parents.length > 1) throw new Error('这是合并提交，请到网页端撤销');
      parentSha = c.parents[0].sha;
      title = c.commit && c.commit.message ? String(c.commit.message).split('\n')[0] : String(sha).substring(0, 7);
      files = c.files || [];
      if (!files.length) throw new Error('该提交没有文件改动，无需撤销');
      /* GitHub 对单个提交只吐前 300 个改动文件，而且不像 /compare 那样给
         truncated 标记 —— 超限时 files 被悄悄砍掉一截，下面的 entries 就只覆盖
         前面这几百个，反向提交会**少还原一部分还不报错**，用户以为成功了。
         宁可拒做让人去网页端，也不能静默交出一个半成品反向提交。 */
      if (files.length >= FILE_CAP) {
        throw new Error('该提交改动的文件过多（已达接口单次上限），请到网页端撤销才可靠');
      }
      /* 先由父提交解析出它的 tree sha，再取整棵树 —— /git/trees 端点对「提交 sha」
         的支持不明确，先转一次最稳。 */
      return commitTreeSha(full, parentSha).then(function (pt) {
        return window.API.get('/repos/' + full + '/git/trees/' + pt, { recursive: 1 });
      });
    }).then(function (tr) {
      var t = tr.data || {};
      if (t.truncated) throw new Error('仓库文件过多，文件树被截断，请到网页端撤销');
      var blobOf = {}, modeOf = {};
      /* mode 必须从父提交那棵树里一起带出来，不能一律写 100644：
         除了普通文件，Git tree 里还有可执行文件 100755、符号链接 120000、
         子模块 160000。写死了会把 build.sh 的可执行位弄丢，也会把符号链接
         还原成「内容是目标路径文本」的普通文件 —— 都不是原来那个东西了。 */
      (t.tree || []).forEach(function (e) {
        if (e.type === 'blob') { blobOf[e.path] = e.sha; modeOf[e.path] = e.mode; }
      });

      var entries = [];
      files.forEach(function (f) {
        var path = f.filename;
        if (f.status === 'added') {
          // 反向：这个文件是那次提交新增的 → 删掉
          entries.push({ path: path, mode: '100644', type: 'blob', sha: null });
        } else if (f.status === 'renamed') {
          // 反向：删掉改名后的新路径，恢复旧路径
          entries.push({ path: path, mode: '100644', type: 'blob', sha: null });
          var old = f.previous_filename || path;
          if (!blobOf[old]) throw new Error('找不到文件在上一版中的内容，请到网页端撤销');
          entries.push({ path: old, mode: modeOf[old] || '100644', type: 'blob', sha: blobOf[old] });
        } else {
          // modified / changed / removed 都还原到父提交里的那一版
          if (!blobOf[path]) throw new Error('找不到文件在上一版中的内容，请到网页端撤销');
          entries.push({ path: path, mode: modeOf[path] || '100644', type: 'blob', sha: blobOf[path] });
        }
      });

      return refHeadSha(full, branch).then(function (headSha) {
        return commitTreeSha(full, headSha).then(function (headTree) {
          return window.API.post('/repos/' + full + '/git/trees', { base_tree: headTree, tree: entries })
            .then(function (nt) {
              return window.API.post('/repos/' + full + '/git/commits', {
                message: 'Revert "' + title + '"',
                tree: nt.data.sha,
                parents: [headSha]
              });
            });
        });
      }).then(function (nc) {
        return window.API.patch('/repos/' + full + '/git/refs/heads/' + encRef(branch), { sha: nc.data.sha });
      });
    });
  }

  /** 回滚：把 branch 的指针直接重置到 sha（force，会改写历史） */
  function rollbackCommit(repo, branch, sha) {
    var full = repo.full_name;
    return window.API.patch('/repos/' + full + '/git/refs/heads/' + encRef(branch), { sha: sha, force: true });
  }

  /**
   * 谁能做「回滚」这种破坏性操作。
   *
   * 回滚等于 force push —— 它会把这个分支指针直接挪回某个提交，之后那串提交
   * 就从分支历史上消失了，App 里也没有任何办法找回。所以它的门槛要比普通的
   * 「能写代码」更高：canPush 只表示有 Write（能推分支、能合并 PR），
   * 那还不够格抹掉别人的提交历史。
   *
   * 认三类人：仓库所有者本人、Admin、Maintain。
   */
  function canForcePush(repo) {
    if (!window.Session.user) return false;
    var p = repo.permissions || {};
    var owner = repo.owner || {};
    return !!(p.admin || p.maintain || (!!owner.login && owner.login === window.Session.user.login));
  }

  /** 单条提交的操作菜单（列表行尾 ⋮ 触发） */
  function openCommitMenu(repo, branch, sha, reload) {
    var short = String(sha).substring(0, 7);
    var mayRollback = canForcePush(repo);
    UI.menu('提交 ' + short, [
      { icon: 'history', label: '撤销提交', value: '新建反向提交', key: 'revert' },
      {
        icon: 'sync', label: '回滚提交', key: 'rollback',
        // 不够格就置灰并写明缺什么，而不是把这个入口悄悄藏掉
        value: mayRollback ? '分支重置到此' : '需要 Admin / Maintain',
        disabled: !mayRollback
      }
    ]).then(function (k) {
      if (k === 'revert') doRevert(repo, branch, sha, reload);
      else if (k === 'rollback') doRollback(repo, branch, sha, reload);
    });
  }

  function doRevert(repo, branch, sha, reload) {
    var short = String(sha).substring(0, 7);
    UI.confirm('撤销提交',
      '将在分支 ' + branch + ' 上新建一个反向提交，把 ' + short + ' 的改动抵消掉，原提交仍保留在历史里。若同一文件之后又被改过，会按该提交的上一版覆盖，请留意。',
      '撤销', true).then(function (ok) {
      if (!ok) return;
      UI.loading(true);
      return revertCommit(repo, branch, sha).then(function () {
        UI.loading(false);
        window.API.clearCache();
        UI.toastOk('已创建反向提交');
        if (reload) reload();
      });
    }).catch(function (e) {
      UI.loading(false);
      UI.toast('撤销失败：' + commitOpError(e));
    });
  }

  function doRollback(repo, branch, sha, reload) {
    /* 菜单那层已经置灰了，这里再问一次 —— 这个入口将来可能被别的地方调用，
       而 force push 是不可逆的，纵深多一道闸值得。 */
    if (!canForcePush(repo)) {
      UI.toast('回滚需要 Admin / Maintain 权限（它会改写分支历史）');
      return;
    }
    var short = String(sha).substring(0, 7);
    UI.confirm('回滚分支',
      '将把分支 ' + branch + ' 直接重置到 ' + short + '，它之后的提交会从该分支上消失。这会改写历史、无法从 App 里恢复，请确认这些提交已不需要。',
      '回滚', true).then(function (ok) {
      if (!ok) return;
      UI.loading(true);
      return rollbackCommit(repo, branch, sha).then(function () {
        UI.loading(false);
        window.API.clearCache();
        UI.toastOk('分支已回滚到 ' + short);
        if (reload) reload();
      });
    }).catch(function (e) {
      UI.loading(false);
      UI.toast('回滚失败：' + commitOpError(e));
    });
  }

  function tabCommits(repo, ctx, box) {
    var ref = ctx.query.ref || repo.default_branch;
    var canWrite = canPush(repo);
    box.innerHTML = '<div id="clist">' + UI.skeleton(5) + '</div>';

    function paint(bypass) {
      return window.API.get('/repos/' + repo.full_name + '/commits', { sha: ref, per_page: 40 },
        { cache: bypass ? 0 : 30000 }).then(function (r) {
        var list = r.data || [];
        var b = UI.$('#clist', box); if (!b) return;
        if (!list.length) { b.innerHTML = UI.empty('git-commit', '暂无提交', ''); return; }
        b.innerHTML = '<div class="list">' + list.map(function (c) {
          var au = c.author && c.author.login;
          var sha = c.sha;
          return '<button class="list-row" data-go="/' + U.esc(repo.full_name) + '/commit/' + sha + '">' +
            (c.author && c.author.avatar_url ? UI.avatar(au, c.author.avatar_url, 24) : '') +
            '<span class="row-main"><span class="row-title">' + U.esc((c.commit.message || '').split('\n')[0]) + '</span>' +
            '<span class="row-desc">' + U.esc(c.commit.author ? c.commit.author.name : '') + ' · ' + U.timeAgo(c.commit.author ? c.commit.author.date : '') + '</span></span>' +
            '<span class="row-side"><span class="mono tiny">' + U.esc(sha.substring(0, 7)) + '</span>' +
            (canWrite ? '<span class="icon-btn" data-cmenu="' + U.esc(sha) + '" role="button" aria-label="更多操作">' + window.icon('kebab-horizontal', 16) + '</span>' : '') +
            '</span></button>';
        }).join('') + '</div>';

        /* 行尾的 ⋮ 必须自己处理点击：全局 data-go 委托跑在**捕获阶段**，
           冒泡阶段再 stopPropagation 已经晚了 —— 点 ⋮ 会先被它带进提交详情。
           按 App 里的约定给每一行单独绑 onclick 并置 __bound：全局委托见到
           __bound 会跳过，于是由这里决定「点整行进详情 / 点 ⋮ 开操作菜单」。 */
        UI.$$('.list-row', b).forEach(function (row) {
          var dest = row.getAttribute('data-go');
          row.__bound = true;
          row.onclick = function (e) {
            var el = e.target;
            var hit = el && el.closest ? el.closest('[data-cmenu]') : null;
            e.preventDefault();
            if (hit) openCommitMenu(repo, ref, hit.getAttribute('data-cmenu'), function () { paint(true); });
            else if (dest) window.Router.go(dest);
          };
        });
        window.bindRepoCards(b);
      }).catch(function (e) { var b = UI.$('#clist', box); if (b) b.innerHTML = UI.errorBox(e); });
    }
    return paint(false);
  }

  function tabContributors(repo, ctx, box) {
    box.innerHTML = '<div id="colist">' + UI.skeleton(5) + '</div>';
    return window.API.get('/repos/' + repo.full_name + '/contributors', { per_page: 100 }, { cache: 300000 }).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#colist', box); if (!b) return;
      if (!list.length) { b.innerHTML = UI.empty('people', '暂无贡献者数据', ''); return; }
      var max = list[0].contributions || 1;
      b.innerHTML = '<div class="list">' + list.map(function (c) {
        return '<button class="list-row" data-go="/' + U.esc(c.login) + '">' +
          UI.avatar(c.login, c.avatar_url, 32) +
          '<span class="row-main"><span class="row-title">' + U.esc(c.login) + '</span>' +
          '<span class="skel" style="height:5px;border-radius:3px;margin-top:6px;width:' + Math.max(6, (c.contributions / max * 100)) + '%"></span></span>' +
          '<span class="row-side tiny">' + U.num(c.contributions) + ' 次提交</span></button>';
      }).join('') + '</div>';
      window.bindRepoCards(b);
    }).catch(function (e) { UI.$('#colist', box).innerHTML = UI.errorBox(e); });
  }

  function tabRefs(repo, ctx, box, kind) {
    box.innerHTML = '<div id="blist">' + UI.skeleton(5) + '</div>';
    return window.API.get('/repos/' + repo.full_name + '/' + kind, { per_page: 100 }, { cache: 60000 }).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#blist', box); if (!b) return;
      if (!list.length) { b.innerHTML = UI.empty(kind === 'tags' ? 'tag' : 'git-branch', '暂无' + (kind === 'tags' ? '标签' : '分支'), ''); return; }
      b.innerHTML = '<div class="list">' + list.map(function (x) {
        var name = x.name;
        var isDefault = name === repo.default_branch;
        return '<button class="list-row" data-go="' + U.esc(refUrl(repo, 'tree', '', name)) + '">' +
          '<span style="color:var(--fg-muted)">' + window.icon(kind === 'tags' ? 'tag' : 'git-branch', 16) + '</span>' +
          '<span class="row-main"><span class="row-title mono">' + U.esc(name) + '</span>' +
          (x.commit ? '<span class="row-desc mono">' + U.esc((x.commit.sha || '').substring(0, 7)) + '</span>' : '') + '</span>' +
          (isDefault ? '<span class="chip">默认</span>' : '') +
          (x.protected ? '<span class="chip">' + window.icon('shield', 12) + '受保护</span>' : '') + '</button>';
      }).join('') + '</div>';
      window.bindRepoCards(b);
    }).catch(function (e) { UI.$('#blist', box).innerHTML = UI.errorBox(e); });
  }

  function tabPeople(repo, ctx, box, ep, title) {
    box.innerHTML = '<div id="pelist">' + UI.skeleton(5) + '</div>';
    return window.API.get('/repos/' + repo.full_name + '/' + ep, { per_page: 100 }, { cache: 60000 }).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#pelist', box); if (!b) return;
      if (!list.length) { b.innerHTML = UI.empty('people', '暂无' + title, ''); return; }
      b.innerHTML = '<div class="list">' + list.map(function (u) {
        return '<button class="list-row" data-go="/' + U.esc(u.login) + '">' + UI.avatar(u.login, u.avatar_url, 32) +
          '<span class="row-main"><span class="row-title">' + U.esc(u.login) + '</span>' +
          (u.name ? '<span class="row-desc">' + U.esc(u.name) + '</span>' : '') + '</span></button>';
      }).join('') + '</div>';
      window.bindRepoCards(b);
    }).catch(function (e) { UI.$('#pelist', box).innerHTML = UI.errorBox(e); });
  }

  function tabForks(repo, ctx, box) {
    box.innerHTML = '<div id="flist">' + UI.skeleton(4) + '</div>';
    return window.API.get('/repos/' + repo.full_name + '/forks', { per_page: 50, sort: 'stargazers' }, { cache: 60000 }).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#flist', box); if (!b) return;
      if (!list.length) { b.innerHTML = UI.empty('repo-forked', '暂无 fork', ''); return; }
      b.innerHTML = '<div class="list">' + list.map(function (f) {
        return '<button class="list-row" data-go="/' + U.esc(f.full_name) + '">' + UI.avatar(f.owner.login, f.owner.avatar_url, 32) +
          '<span class="row-main"><span class="row-title">' + U.esc(f.full_name) + '</span>' +
          (f.description ? '<span class="row-desc">' + U.esc(f.description) + '</span>' : '') +
          '<span class="row-meta"><span>' + window.icon('star', 12) + U.num(f.stargazers_count) + '</span></span></span></button>';
      }).join('') + '</div>';
      window.bindRepoCards(b);
    }).catch(function (e) { UI.$('#flist', box).innerHTML = UI.errorBox(e); });
  }

  /* ============================================================
   * 里程碑（Milestones）
   *
   * 原来 App 只会在议题详情里把所属的里程碑名显示成一个 chip —— 想知道
   * 「这一版还剩多少没做」就得回网页端。这里补齐三件事：看进度、新建、
   * 把挂在它下面的议题逐条勾掉。
   * GitHub 没给「完成某个议题」这种语义的接口，「勾掉」实际就是把它关闭，
   * 所以下面走的是改 issue 的 state。
   * ============================================================ */
  function msStat(m) {
    var closed = m.closed_issues || 0;
    var open = m.open_issues || 0;
    var total = closed + open;
    return { closed: closed, open: open, total: total, pct: total ? Math.round(closed * 100 / total) : 0 };
  }

  /** 到期日那一行；open 且已过期要显式染红，否则一堆 milestone 里看不出来是哪条卡住了 */
  function msDueHtml(m) {
    if (!m.due_on) return '';
    var d = Date.parse(m.due_on);
    if (isNaN(d)) return '';
    var days = Math.round((d - Date.now()) / 86400000);
    var over = m.state === 'open' && days < 0;
    var txt = over ? '已逾期 ' + Math.abs(days) + ' 天'
      : days === 0 ? '今天到期'
        : days < 0 ? U.timeAgo(m.due_on)
          : '还剩 ' + days + ' 天';
    return '<span class="' + (over ? 'due-over' : '') + '">' + window.icon('calendar', 12) +
      U.esc(m.due_on) + ' · ' + U.esc(txt) + '</span>';
  }

  function loadMilestones(repo, state) {
    return window.API.get('/repos/' + repo.full_name + '/milestones',
      { state: state, per_page: 100, sort: 'due_date', direction: 'asc' }, { cache: 30000 });
  }

  function tabMilestones(repo, ctx, box) {
    var state = ctx.query.ms || 'open';
    var canEdit = window.Session.isLogin && canPush(repo);
    box.innerHTML = '<div style="padding:10px 12px">' +
      UI.seg('msseg', [{ key: 'all', label: '全部' }, { key: 'open', label: '进行中' }, { key: 'closed', label: '已结束' }], state) +
      '</div><div id="msl">' + UI.skeleton(4) + '</div>';
    UI.$$('#msseg button', box).forEach(function (b) {
      b.onclick = function () { window.Router.go('/' + repo.full_name + '/milestones?ms=' + b.getAttribute('data-v')); };
    });

    if (canEdit) {
      var newWrap = document.createElement('div');
      newWrap.style.cssText = 'padding:4px 12px 12px';
      newWrap.innerHTML = '<button class="btn block" id="ms-new">' + window.icon('plus', 14) + ' 新建里程碑</button>';
      box.appendChild(newWrap);
      UI.$('#ms-new', box).onclick = function () { newMilestone(repo); };
    }

    loadMilestones(repo, state).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#msl', box); if (!b) return;
      if (!list.length) {
        b.innerHTML = UI.empty('milestone', '没有里程碑', '里程碑用来给一批议题定同一个交付节点');
        return;
      }
      b.innerHTML = '<div class="card">' + list.map(function (m) {
        var p = msStat(m);
        return '<div class="ms-row" data-ms="' + m.number + '">' +
          '<div class="ms-top"><b>' + U.esc(m.title) + '</b>' +
          '<span class="chip">' + (m.state === 'open' ? '进行中' : '已结束') + '</span></div>' +
          (m.description ? '<div class="ms-desc">' + U.esc(m.description) + '</div>' : '') +
          '<div class="ms-bar"><i style="width:' + p.pct + '%"></i></div>' +
          '<div class="ms-meta"><span>' + p.pct + '% 完成</span>' +
          '<span>' + p.closed + ' 已完成 · ' + p.open + ' 待处理</span>' +
          msDueHtml(m) + '</div></div>';
      }).join('') + '</div>';
      UI.$$('.ms-row', b).forEach(function (row) {
        row.onclick = function () { milestoneDetail(repo, +row.getAttribute('data-ms')); };
      });
    }).catch(function (e) {
      var x = UI.$('#msl', box); if (x) x.innerHTML = UI.errorBox(e);
    });
  }

  /** 单个里程碑：把挂在它下面的议题列出来，逐条勾掉 */
  function milestoneDetail(repo, num) {
    var root = document.getElementById('sheet-root');
    UI.loading(true);
    Promise.all([
      window.API.get('/repos/' + repo.full_name + '/milestones/' + num, null, { cache: 0 }),
      window.API.get('/repos/' + repo.full_name + '/issues',
        { milestone: num, state: 'all', per_page: 100 }, { cache: 0 })
    ]).then(function (rs) {
      UI.loading(false);
      var m = rs[0].data;
      var items = rs[1].data || [];
      var done = [], todo = [];
      items.forEach(function (i) { (i.state === 'closed' ? done : todo).push(i); });
      var canEdit = window.Session.isLogin && canPush(repo);

      var row = function (i) {
        var isPR = !!i.pull_request;
        return '<div class="ms-item' + (i.state === 'closed' ? ' done' : '') + '" data-n="' + i.number + '">' +
          '<span class="ms-ck">' + window.icon(i.state === 'closed' ? 'check-circle-fill' : 'circle', 18) + '</span>' +
          '<span class="row-main"><span class="row-title tiny">#' + i.number + ' ' + U.esc(i.title) + '</span>' +
          '<span class="row-meta">' + (isPR ? '拉取请求' : '议题') +
          (i.assignee ? ' · ' + U.esc(i.assignee.login) : '') + '</span></span></div>';
      };

      var body =
        '<div class="ms-detail-head">' +
        '<div class="bar"><span class="ms-bar wide"><i style="width:' + msStat(m).pct + '%"></i></span>' +
        '<b>' + msStat(m).pct + '%</b></div>' +
        '<div class="ms-meta">' + msStat(m).closed + ' 已完成 · ' + msStat(m).open + ' 待处理' +
        (m.due_on ? ' · 截止 ' + U.esc(m.due_on) : '') + '</div>' +
        (m.description ? '<div class="ms-desc">' + U.esc(m.description) + '</div>' : '') +
        '</div>' +
        '<div class="section-title">' + window.icon('issue-opened', 14) + ' 待处理（' + todo.length + '）</div>' +
        (todo.length ? '<div class="list">' + todo.map(row).join('') + '</div>'
          : '<div class="muted tiny" style="padding:8px 12px">全部勾完了。</div>') +
        '<div class="section-title">' + window.icon('issue-closed', 14) + ' 已完成（' + done.length + '）</div>' +
        (done.length ? '<div class="list">' + done.map(row).join('') + '</div>'
          : '<div class="muted tiny" style="padding:8px 12px">还没有。</div>') +
        '<div class="muted tiny" style="padding:12px">' +
        (canEdit ? '点一条议题就把它关闭 / 重新打开 —— GitHub 没有单独的「完成」语义，勾掉就是关闭。' +
          (items.some(function (i) { return i.pull_request; }) ? '列表里的拉取请求也是同理，不会被真的合并。' : '')
          : '没有写权限，只能看进度。') + '</div>';

      UI.sheet({
        title: U.esc(m.title), full: true, body: body,
        foot: '<button class="btn" data-no>关闭</button>' +
          (canEdit ? '<button class="btn" data-more>' + window.icon('kebab-horizontal', 13) + '</button>' : ''),
        onMount: function () {
          root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
          var mb = root.querySelector('[data-more]');
          if (mb) mb.onclick = function () {
            UI.menu('里程碑操作', [
              { icon: 'pencil', label: '编辑', key: 'edit' },
              { icon: m.state === 'open' ? 'issue-closed' : 'issue-opened', label: m.state === 'open' ? '结束里程碑' : '重新打开', key: 'state' },
              { icon: 'trash', label: '删除', key: 'del' }
            ]).then(function (k) {
              if (!k) return;
              if (k === 'state') return msToggleState(repo, m);
              if (k === 'del') return msDelete(repo, m);
              /* 编辑器要把详情页整个换掉，先收起当前这层，否则两层 sheet 叠在一起 */
              UI.closeSheet();
              newMilestone(repo, m);
            });
          };
          if (!canEdit) return;
          UI.$$('.ms-item', root).forEach(function (el) {
            el.onclick = function () {
              var n = +el.getAttribute('data-n');
              var wasOpen = el.className.indexOf('done') < 0;
              UI.loading(true);
              window.API.patch('/repos/' + repo.full_name + '/issues/' + n,
                { state: wasOpen ? 'closed' : 'open' })
                .then(function () {
                  UI.loading(false);
                  UI.closeSheet();
                  UI.toast(wasOpen ? '#' + n + ' 已完成' : '#' + n + ' 已重新打开');
                  milestoneDetail(repo, num);   // 重开面板，勾选立刻反映到进度条
                })
                .catch(function (e) {
                  UI.loading(false);
                  UI.toast('操作失败：' + e.message);
                });
            };
          });
        },
        onClose: function () { window.Router.reload(); }
      });
    }).catch(function (e) {
      UI.loading(false);
      UI.toast('读取里程碑失败：' + e.message);
    });
  }

  function newMilestone(repo, edit) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    if (!canPush(repo)) return UI.toast('没有该仓库的写入权限');
    var root = document.getElementById('sheet-root');
    var isNew = !edit;
    var due = isNew || !edit.due_on ? '' : String(edit.due_on).substring(0, 10);

    UI.sheet({
      title: isNew ? '新建里程碑' : '编辑里程碑',
      body: '<div class="field"><label>标题 <span style="color:var(--danger)">*</span></label>' +
        '<input class="input" id="ms-t" value="' + U.esc(edit ? edit.title : '') + '" placeholder="例如 v1.2.0"></div>' +
        '<div class="field"><label>截止日期</label>' +
        '<input class="input" id="ms-d" type="date" value="' + U.esc(due) + '">' +
        '<div class="hint">Github 的时间按 UTC 计；留空表示不设期限。</div></div>' +
        '<div class="field"><label>说明</label>' +
        '<textarea class="textarea" id="ms-b" style="min-height:100px" placeholder="这一版要做什么">' +
        U.esc(edit ? (edit.description || '') : '') + '</textarea></div>',
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>' +
        (isNew ? '创建' : '保存') + '</button>',
      onMount: function () {
        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        root.querySelector('[data-yes]').onclick = function () {
          var t = root.querySelector('#ms-t').value.trim();
          if (!t) return UI.toast('请填标题');
          var d = root.querySelector('#ms-d').value;
          var payload = {
            title: t,
            description: root.querySelector('#ms-b').value.trim(),
            due_on: d ? d + 'T00:00:00Z' : null
          };
          if (isNew) payload.state = 'open';
          UI.loading(true);
          var call = isNew
            ? window.API.post('/repos/' + repo.full_name + '/milestones', payload)
            : window.API.patch('/repos/' + repo.full_name + '/milestones/' + edit.number, payload);
          call.then(function () {
            UI.loading(false); UI.closeSheet();
            UI.toast(isNew ? '里程碑已创建' : '已保存');
            window.Router.reload();
          }).catch(function (e) {
            UI.loading(false);
            UI.toast((isNew ? '创建失败：' : '保存失败：') + (e.status === 422 ? '标题可能重复' : e.message));
          });
        };
      }
    });
  }

  function msToggleState(repo, m) {
    var next = m.state === 'open' ? 'closed' : 'open';
    UI.loading(true);
    window.API.patch('/repos/' + repo.full_name + '/milestones/' + m.number, { state: next })
      .then(function () {
        UI.loading(false); UI.closeSheet();
        UI.toast(next === 'closed' ? '里程碑已结束' : '已重新打开');
        window.Router.reload();
      })
      .catch(function (e) { UI.loading(false); UI.toast('操作失败：' + e.message); });
  }

  function msDelete(repo, m) {
    UI.confirm('删除里程碑？',
      '「' + m.title + '」会被删除，挂在它下面的议题不会被删，只是失去归属。',
      '删除', true).then(function (ok) {
      if (!ok) return;
      UI.loading(true);
      window.API.del('/repos/' + repo.full_name + '/milestones/' + m.number)
        .then(function () {
          UI.loading(false); UI.closeSheet(); UI.toast('已删除');
          window.Router.reload();
        })
        .catch(function (e) { UI.loading(false); UI.toast('删除失败：' + e.message); });
    });
  }

  /* ============ 仓库设置（可编辑，对标官网 Settings） ============ */
  function tabSettings(repo, ctx, box) {
    var canEdit = !!(window.Session.user && repo.owner &&
      window.Session.user.login === repo.owner.login);

    box.innerHTML =
      (canEdit ? '' :
        '<div class="card" style="padding:12px 14px"><div class="muted tiny">' +
        '你不是该仓库的所有者，只能查看设置信息。</div></div>') +

      /* ---- 基础信息（可编辑） ---- */
      '<div class="set-group-title">基础信息</div>' +
      '<div class="card" style="padding:14px">' +
      '<div class="field"><label>仓库名称</label>' +
      '<input class="input" id="s-name" value="' + U.esc(repo.name) + '"' + (canEdit ? '' : ' disabled') + '>' +
      '<div class="hint">重命名后旧地址会自动跳转到新地址。</div></div>' +
      '<div class="field"><label>简介</label>' +
      '<input class="input" id="s-desc" value="' + U.esc(repo.description || '') + '" placeholder="一句话描述这个仓库"' + (canEdit ? '' : ' disabled') + '></div>' +
      '<div class="field"><label>网站</label>' +
      '<input class="input" id="s-home" value="' + U.esc(repo.homepage || '') + '" placeholder="https://example.com"' + (canEdit ? '' : ' disabled') + '></div>' +
      '<div class="field"><label>Topics</label>' +
      '<input class="input" id="s-topics" value="' + U.esc((repo.topics || []).join(', ')) + '" placeholder="用英文逗号分隔，如 android, root, kernel"' + (canEdit ? '' : ' disabled') + '>' +
      '<div class="hint">最多 20 个，只能包含小写字母、数字和连字符。</div></div>' +
      (canEdit ? '<button class="btn primary block" id="s-save">' + window.icon('check', 15) + ' 保存修改</button>' : '') +
      '</div>' +

      '<div class="section"></div>' +

      /* ---- 协作者与邀请 ---- */
      '<div class="set-group-title">协作者与邀请</div>' +
      '<div class="card" style="padding:14px">' +
      '<div class="rowflex" style="gap:10px;align-items:flex-start">' +
      '<span style="flex:none;margin-top:2px">' + window.icon('people', 16) + '</span>' +
      '<span class="grow"><b>谁能动这个仓库</b>' +
      '<div class="tiny muted" style="margin-top:4px;line-height:1.5">' +
      '五个等级：Read / Triage / Write / Maintain / Admin。可以邀请人、改权限、移除，' +
      '以及处理还没被接受的邀请。</div></span></div>' +
      '<button class="btn block mt12" id="s-collab">' + window.icon('people', 14) +
      ' 管理协作者与邀请</button>' +
      '</div>' +

      '<div class="section"></div>' +

      /* ---- 可见性 ---- */
      '<div class="set-group-title">可见性</div>' +
      '<div class="card" style="padding:14px">' +
      '<div class="rowflex" style="gap:10px;align-items:flex-start">' +
      '<span style="flex:none;margin-top:2px">' + window.icon(repo.private ? 'lock' : 'globe', 16) + '</span>' +
      '<span class="grow"><b>' + (repo.private ? '私有仓库' : '公开仓库') + '</b>' +
      '<div class="tiny muted" style="margin-top:4px">' +
      (repo.private ? '只有你和你选择的人可以查看。' : '任何人都可以查看这个仓库。') + '</div></span></div>' +
      (canEdit ? '<button class="btn block mt12" id="s-vis">' + window.icon('sync', 14) +
        ' 改为' + (repo.private ? '公开' : '私有') + '</button>' : '') +
      '</div>' +

      (canEdit ? '<div class="section"></div>' +
        '<div class="set-group-title" style="color:var(--danger)">危险区域</div>' +
        '<div class="card" style="padding:14px">' +
        '<div class="rowflex" style="gap:10px;align-items:flex-start;padding-bottom:12px;border-bottom:1px solid var(--border-muted)">' +
        '<span class="grow"><b>' + (repo.archived ? '取消归档' : '归档仓库') + '</b>' +
        '<div class="tiny muted" style="margin-top:4px">' +
        (repo.archived ? '归档后仓库为只读状态，取消后可恢复写入。' : '归档后仓库变为只读，任何人都无法推送。') + '</div></span>' +
        '<button class="btn sm" style="flex:none" id="s-arch">' + (repo.archived ? '取消归档' : '归档') + '</button></div>' +
        '<div class="rowflex" style="gap:10px;align-items:flex-start;padding-top:12px">' +
        '<span class="grow"><b style="color:var(--danger)">删除仓库</b>' +
        '<div class="tiny muted" style="margin-top:4px">此操作不可撤销，所有代码、议题、PR 都会被永久删除。</div></span>' +
        '<button class="btn sm danger" style="flex:none;border-color:var(--danger)" id="s-del">删除</button></div>' +
        '</div>' : '') +

      '<div class="section"></div>' +

      /* ---- 只读信息 ---- */
      '<div class="set-group-title">仓库信息（只读）</div>' +
      '<div class="set-group">' +
      setInfoRow('默认分支', repo.default_branch || '—') +
      setInfoRow('议题', repo.has_issues ? '已启用' : '已关闭') +
      setInfoRow('Projects', repo.has_projects ? '已启用' : '已关闭') +
      setInfoRow('Wiki', repo.has_wiki ? '已启用' : '已关闭') +
      setInfoRow('Discussions', repo.has_discussions ? '已启用' : '已关闭') +
      setInfoRow('Fork 数量', String(repo.forks_count)) +
      setInfoRow('Star 数量', String(repo.stargazers_count)) +
      setInfoRow('创建时间', U.date(repo.created_at)) +
      setInfoRow('最近推送', U.timeAgo(repo.pushed_at)) +
      '</div>' +
      '<div class="card" style="padding:12px 14px;margin-top:12px"><div class="tiny muted">' +
      '议题 / Projects / Wiki / Discussions 的开关，GitHub 未开放 REST API，' +
      '需要前往网页端设置。</div></div>' +
      '<div class="card" style="margin-top:12px"><button class="btn block" id="s-web">' +
      window.icon('link-external', 14) + ' 在浏览器打开仓库设置</button></div>';

    // ---- 绑定 ----
    var collabBtn = UI.$('#s-collab', box);
    if (collabBtn) collabBtn.onclick = function () {
      window.Router.go('/' + repo.full_name + '/collaborators');
    };

    UI.$('#s-web', box).onclick = function () {
      openWeb(repo.html_url + '/settings');
    };

    var saveBtn = UI.$('#s-save', box);
    if (saveBtn) {
      saveBtn.onclick = function () {
        var name = UI.$('#s-name', box).value.trim();
        if (!name) return UI.toast('仓库名称不能为空');
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return UI.toast('仓库名只能包含字母、数字、- _ .');
        var topics = UI.$('#s-topics', box).value.split(',')
          .map(function (t) { return t.trim().toLowerCase(); })
          .filter(function (t) { return t; });
        if (topics.some(function (t) { return !/^[a-z0-9][a-z0-9-]*$/.test(t); })) {
          return UI.toast('Topics 只能包含小写字母、数字和连字符');
        }
        var payload = {
          name: name,
          description: UI.$('#s-desc', box).value.trim() || null,
          homepage: UI.$('#s-home', box).value.trim() || null,
          topics: topics
        };
        UI.loading(true);
        window.API.patch('/repos/' + repo.full_name, payload).then(function (r) {
          UI.loading(false);
          var full = (r.data && r.data.full_name) || repo.full_name;
          try { window.App.invalidate('/user/repos'); } catch (e) {}
          try { window.App.cacheDel('repo_' + repo.full_name); } catch (e) {}
          UI.toast(full === repo.full_name ? '已保存' : '已重命名');
          if (full !== repo.full_name) window.Router.go('/' + full + '/settings');
          else window.Router.reload();
        }).catch(function (e) {
          UI.loading(false);
          UI.toast('保存失败：' + (e.status === 422 ? '仓库名已存在或 Topics 不合法' : e.message));
        });
      };

      // 切换可见性 / 归档：先取服务端最新状态，再决定方向。
      // 直接用传入的 repo.private 判断是不行的——这个对象可能来自页面缓存，
      // 上一次切换过的结果没同步进来，就会出现「点了改为私有、弹窗却说改为公开」。
      function withFreshRepo(run) {
        // cache:0 跳过 TTL 缓存；dedupe:false 还要绕开「同一请求正在飞行中」的复用——
        // 否则刚渲染过的 GET /repos/xxx 会被原样复用，拿回来的还是旧状态。
        return window.API.get('/repos/' + repo.full_name, null, { cache: 0, dedupe: false })
          .then(function (r) {
            var fresh = r.data || repo;
            // 顺手把本地这份也同步了，页面上的按钮文案立刻跟着变
            Object.keys(fresh).forEach(function (k) { repo[k] = fresh[k]; });
            return run(fresh);
          })
          .catch(function () { return run(repo); });
      }

      UI.$('#s-vis', box).onclick = function () {
        withFreshRepo(function (cur) {
          // next 是「切换后的 private 值」：true = 要变成私有
          // 所以文案要在 next 为 true 时说「改为私有」，别再写反
          var next = !cur.private;
          UI.confirm(next ? '改为私有仓库' : '改为公开仓库',
            next ? '改为私有后，只有你和你选择的人可以查看。' : '公开后任何人都能查看这个仓库的代码。',
            '确认修改', next).then(function (ok) {
              if (!ok) return;
              UI.loading(true);
              window.API.patch('/repos/' + repo.full_name, { private: next }).then(function (r) {
                UI.loading(false);
                repo.private = next;                 // 本地状态立刻翻转
                if (r && r.data) Object.keys(r.data).forEach(function (k) { repo[k] = r.data[k]; });
                // 仓库对象和列表都缓存在内存里，不清掉的话刷新还会看到旧值
                try { window.API.clearCache(); } catch (e) {}
                try { window.App.clearPageCache(); } catch (e) {}
                try { window.App.invalidate('/user/repos'); } catch (e) {}
                try { window.App.invalidate('/search/repositories'); } catch (e) {}
                UI.toast(next ? '已改为私有' : '已改为公开');
                window.Router.reload();
              }).catch(function (e) { UI.loading(false); UI.toast('修改失败：' + e.message); });
            });
        });
      };

      UI.$('#s-arch', box).onclick = function () {
        withFreshRepo(function (cur) {
          var next = !cur.archived;
          UI.confirm(next ? '归档仓库' : '取消归档',
            next ? '归档后仓库变为只读，所有人都无法推送。' : '取消归档后恢复可写入状态。',
            '确认', false).then(function (ok) {
              if (!ok) return;
              UI.loading(true);
              window.API.patch('/repos/' + repo.full_name, { archived: next }).then(function (r) {
                UI.loading(false);
                repo.archived = next;
                if (r && r.data) Object.keys(r.data).forEach(function (k) { repo[k] = r.data[k]; });
                try { window.API.clearCache(); } catch (e) {}
                try { window.App.clearPageCache(); } catch (e) {}
                UI.toast(next ? '已归档' : '已取消归档');
                window.Router.reload();
              }).catch(function (e) { UI.loading(false); UI.toast('操作失败：' + e.message); });
            });
        });
      };

      UI.$('#s-del', box).onclick = function () {
        // 二次确认：要求用户手动输入仓库名，避免误删（对齐官网）
        // 注意：提示里必须明确写出「要输入的是哪个名字」，不能只放 placeholder，
        // 否则用户不知道输入什么；输入框也用明文（仓库名不是敏感信息）。
        var body =
          '<div class="field">' +
          '<label>要删除的仓库</label>' +
          '<div class="del-target">' + window.icon('repo', 15) +
          '<span class="mono">' + U.esc(repo.full_name) + '</span></div></div>' +
          '<div class="field">' +
          '<label>请输入仓库名称 <b class="mono">' + U.esc(repo.name) + '</b> 以确认删除</label>' +
          '<input class="input mono" id="del-cf" type="text" inputmode="text" ' +
          'autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" ' +
          'enterkeyhint="done" placeholder="在此输入 ' + U.esc(repo.name) + '">' +
          '<div class="hint">必须与仓库名称完全一致，包括大小写。删除后此仓库及其全部代码、议题、发布版本都会被永久移除，此操作不可撤销。</div>' +
          '<div class="hint" id="del-tip"></div>' +
          '</div>';
        var root = document.getElementById('sheet-root');
        UI.sheet({
          title: '删除仓库',
          body: body,
          foot: '<button class="btn" data-no>取消</button><button class="btn danger" data-yes disabled>确认删除</button>',
          onMount: function () {
            var inp = root.querySelector('#del-cf');
            var yes = root.querySelector('[data-yes]');
            setTimeout(function () { inp.focus(); }, 260);
            inp.addEventListener('input', function () {
              var match = inp.value.trim() === repo.name;
              yes.disabled = !match;
              // 实时反馈：让用户明确看到「还差什么 / 已经对了」
              inp.classList.toggle('ok', match);
              var tip = root.querySelector('#del-tip');
              if (tip) {
                tip.textContent = match ? '名称一致，可以确认删除' : '';
                tip.className = match ? 'hint ok-hint' : 'hint';
              }
            });
            // 回车直接提交（名称一致时）
            inp.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') { e.preventDefault(); if (!yes.disabled) yes.click(); }
            });
            root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
            yes.onclick = function () {
              UI.closeSheet();
              UI.loading(true);
              window.API.del('/repos/' + repo.full_name).then(function () {
                UI.loading(false);
                try { window.App.invalidate('/user/repos'); } catch (e) {}
                try { window.App.cacheDel('repo_' + repo.full_name); } catch (e) {}
                UI.toast('仓库已删除');
                window.Router.go('/' + (window.Session.user ? window.Session.user.login : ''));
              }).catch(function (e) { UI.loading(false); UI.toast('删除失败：' + e.message); });
            };
          }
        });
      };
    }
  }

  function setInfoRow(k, v) {
    return '<div class="set-row static"><span class="k">' + U.esc(k) + '</span>' +
      '<span class="v">' + U.esc(v) + '</span></div>';
  }

  /** 统一的「在浏览器打开」：优先内置浏览器 */
  function openWeb(url, title) {
    if (window.Native && window.Native.openInApp) return window.Native.openInApp(url, title || 'GitHub');
    if (window.NativeBridge && NativeBridge.openInApp) return NativeBridge.openInApp(url, title || 'GitHub');
    if (window.NativeBridge && NativeBridge.openExternal) return NativeBridge.openExternal(url);
    window.open(url, '_blank');
  }
  window.openWeb = openWeb;

  /* ============ 新建议题 ============ */
  function newIssue(repo) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    var labels = [];
    var body =
      '<div class="field"><label>标题</label><input class="input" id="it" placeholder="简洁描述问题"></div>' +
      '<div class="field"><label>内容（支持 Markdown）</label>' +
      '<div class="rowflex" style="gap:4px;margin-bottom:6px">' + ['bold', 'italic', 'quote', 'code', 'link', 'list-unordered', 'tasklist'].map(function (i) {
        var t = i === 'link' ? ' title="上传附件"' : '';
        return '<button class="btn sm" data-md="' + i + '"' + t + '>' + window.icon(i, 14) + '</button>';
      }).join('') +
      '<button class="btn sm" data-md="attach" title="插入图片或视频">' + window.icon('image', 14) + '</button>' +
      '<button class="btn sm" data-md="preview" style="margin-left:auto">预览</button></div>' +
      '<textarea class="textarea" id="ib" placeholder="详细描述、复现步骤、环境信息…"></textarea></div>' +
      '<div class="field"><label>标签</label><div id="lbwrap" class="rowflex wrap"><span class="muted tiny">加载中…</span></div></div>' +
      '<div id="prev" class="card" hidden style="padding:12px"></div>';
    var root = document.getElementById('sheet-root');
    UI.sheet({
      title: '新建议题', full: true, body: body,
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>提交</button>',
      onMount: function () {
        var titleEl = root.querySelector('#it'), bodyEl = root.querySelector('#ib');
        window.API.get('/repos/' + repo.full_name + '/labels', { per_page: 100 }, { cache: 60000 }).then(function (r) {
          var ls = r.data || [];
          root.querySelector('#lbwrap').innerHTML = ls.length ? ls.map(function (l) {
            return '<span class="chip" data-l="' + U.esc(l.name) + '" style="' + U.labelStyle(l.color) + '">' + U.esc(l.name) + '</span>';
          }).join('') : '<span class="muted tiny">无可用标签</span>';
          UI.$$('#lbwrap .chip[data-l]', root).forEach(function (c) {
            c.onclick = function () {
              var n = c.getAttribute('data-l');
              var i = labels.indexOf(n);
              if (i >= 0) { labels.splice(i, 1); c.style.opacity = '.5'; }
              else { labels.push(n); c.style.opacity = '1'; c.style.outline = '2px solid var(--accent)'; }
            };
          });
        });
        UI.$$('[data-md]', root).forEach(function (b) {
          b.onclick = function () {
            var k = b.getAttribute('data-md');
            if (k === 'attach') {
              // 图片按钮：只选图片或视频
              window.Attach.pickInsert(b, bodyEl,
                { repoFull: repo.full_name, accept: 'image/*,video/*', hint: '请选择图片或视频' });
              return;
            }
            if (k === 'link') {
              // 链条按钮：上传任意附件（不再插入空的链接语法）
              window.Attach.pickInsert(b, bodyEl,
                { repoFull: repo.full_name, accept: '*/*', hint: '请选择要上传的文件' });
              return;
            }
            if (k === 'preview') {
              var pv = root.querySelector('#prev');
              pv.hidden = !pv.hidden;
              if (!pv.hidden) window.MD.mount(pv, bodyEl.value || '（无内容）', { repo: repo.full_name });
              return;
            }
            wrapSelection(bodyEl, k);
          };
        });
        root.querySelector('[data-yes]').onclick = function () {
          var t = titleEl.value.trim();
          if (!t) return UI.toast('请填写标题');
          UI.loading(true);
          window.API.post('/repos/' + repo.full_name + '/issues', { title: t, body: bodyEl.value, labels: labels }).then(function (r) {
            UI.loading(false);
            UI.closeSheet(); UI.toast('议题已创建');
            window.App.invalidate('/repos/' + repo.full_name + '/issues');
            /* 创建成功但响应体没带上 number 时不要崩 —— 回列表页就行，
             * 议题其实已经建好了。 */
            var num = r.data && r.data.number;
            window.Router.go(num
              ? '/' + repo.full_name + '/issues/' + num
              : '/' + repo.full_name + '/issues');
          }).catch(function (e) { UI.loading(false); UI.toast('创建失败：' + e.message); });
        };
        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
      }
    });
  }
  window.newIssue = newIssue;

  /* ============ 新建拉取请求 ============ */

  /**
   * 列出仓库的分支名（用于「源分支 / 目标分支」两个下拉）。
   *
   * 用 /branches 而不是 /git/refs?refs/heads —— 前者带 protection 等信息、
   * 对私有仓库的权限也更宽松；只取名字，per_page 给满，够用。
   */
  function listBranches(fullName) {
    return window.API.get('/repos/' + fullName + '/branches',
      { per_page: 100 }, { cache: 60000 }).then(function (r) {
        return (r.data || []).map(function (b) { return b.name; });
      });
  }

  /**
   * 解析「来源仓库」这一栏用户敲的字符串。
   *
   * 支持四种写法，按用户实际会敲的顺序排：
   *   `main`               → 当前仓库的 main 分支（frok 里开同仓 PR 的常见写法）
   *   `owner:branch`       → owner 的同名仓库的 branch（GitHub 网页版的语法）
   *   `owner/repo`         → owner/repo 的默认分支
   *   `owner/repo:branch`  → owner/repo 的 branch
   *
   * 解析不了就返回 null，由调用方给出具体提示 —— 比默默当成当前仓库好，
   * 否则用户以为在往别的仓库提，实际提到了本仓库。
   */
  function parseHeadRepo(text, curFull, curOwner, curName) {
    text = String(text || '').trim().replace(/^\/+|\/+$/g, '');
    if (!text) return { full: curFull, branch: '', same: true };
    var full = curFull, branch = '';
    var ci = text.lastIndexOf(':');
    if (ci > 0) { branch = text.slice(ci + 1).trim(); text = text.slice(0, ci).trim(); }
    if (text.indexOf('/') >= 0) {
      var segs = text.split('/').filter(function (s) { return s; });
      if (segs.length !== 2) return null;
      full = segs[0] + '/' + segs[1];
    } else if (text) {
      // 只写了一个词：有冒号当 owner（`owner:branch`），没冒号当分支
      if (branch && ci > 0) full = text + '/' + curName;
      else { branch = text; full = curFull; }
    }
    if (!full || full.indexOf('/') < 0) return null;
    return { full: full, branch: branch, same: full.toLowerCase() === String(curFull).toLowerCase() };
  }

  function newPullRequest(repo) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    var me = (window.Session.user && window.Session.user.login) || '';
    var owner = (repo.owner && repo.owner.login) || String(repo.full_name).split('/')[0];
    var name = repo.name || String(repo.full_name).split('/')[1];
    var base = repo.default_branch || 'main';

    // 跨 fork 提 PR 时，「来源仓库」默认猜成自己的同名 fork（GitHub 网页版也是这个默认）
    var guessHead = (me && me.toLowerCase() !== String(owner).toLowerCase())
      ? me + '/' + name : repo.full_name;

    var st = { head: guessHead, headBranch: '', baseBranch: base };

    var body =
      '<div class="field"><label>来源仓库</label>' +
      '<input class="input mono" id="pr-head" value="' + U.esc(guessHead) + '" spellcheck="false" autocomplete="off">' +
      '<div class="hint">从哪个仓库拉代码。支持 <span class="mono">owner/repo</span>、' +
      '<span class="mono">owner:分支</span>，只写分支名则视为本仓库的分支。</div></div>' +

      '<div class="field"><label>源分支 <span style="color:var(--danger)">*</span></label>' +
      '<div id="pr-hb-wrap"><input class="input mono" id="pr-hb" placeholder="选择来源仓库后自动加载" autocomplete="off"></div></div>' +

      '<div class="field"><label>目标分支 <span style="color:var(--danger)">*</span></label>' +
      '<div id="pr-bb-wrap"><input class="input mono" id="pr-bb" value="' + U.esc(base) + '" autocomplete="off"></div>' +
      '<div class="hint">合进 ' + U.esc(owner) + '/' + U.esc(name) + ' 的哪个分支。</div></div>' +

      '<div class="field"><label>标题 <span style="color:var(--danger)">*</span></label>' +
      '<input class="input" id="pr-title" placeholder="简洁描述这次改动"></div>' +

      '<div class="field"><label>说明（支持 Markdown）</label>' +
      '<div class="rowflex" style="gap:4px;margin-bottom:6px">' + ['bold', 'italic', 'quote', 'code', 'link', 'list-unordered', 'tasklist'].map(function (i) {
        var t = i === 'link' ? ' title="上传附件"' : '';
        return '<button class="btn sm" data-md="' + i + '"' + t + '>' + window.icon(i, 14) + '</button>';
      }).join('') +
      '<button class="btn sm" data-md="attach" title="插入图片或视频">' + window.icon('image', 14) + '</button>' +
      '<button class="btn sm" data-md="preview" style="margin-left:auto">预览</button></div>' +
      '<textarea class="textarea" id="pr-body" placeholder="改了什么、为什么改、怎么验证…"></textarea></div>' +

      '<div class="field"><label>选项</label>' +
      '<label class="rowflex" style="gap:8px;padding:8px 0"><input type="checkbox" id="pr-draft" style="width:16px;height:16px">' +
      '<span>创建为草稿（暂不请求审查）</span></label>' +
      '<label class="rowflex" style="gap:8px;padding:8px 0"><input type="checkbox" id="pr-maint" style="width:16px;height:16px" checked>' +
      '<span>允许维护者修改此分支</span></label>' +
      '</div>' +

      '<div id="pr-cmp" class="card" hidden style="padding:10px 12px;margin-top:4px"></div>' +
      '<div id="pr-prev" class="card" hidden style="padding:12px"></div>';

    var root = document.getElementById('sheet-root');
    UI.sheet({
      title: '新建拉取请求', full: true, body: body,
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>创建</button>',
      onMount: function () {
        var headEl = root.querySelector('#pr-head');
        var hbEl = root.querySelector('#pr-hb');
        var bbEl = root.querySelector('#pr-bb');
        var bodyEl = root.querySelector('#pr-body');
        var cmpEl = root.querySelector('#pr-cmp');
        var hbWrap = root.querySelector('#pr-hb-wrap');
        var bbWrap = root.querySelector('#pr-bb-wrap');

        /** 把 <input> 换成 <select>，保留当前值（值不在列表里就补进去） */
        function toSelect(wrap, id, names, value) {
          if (!names.length) return;
          if (value && names.indexOf(value) < 0) names = [value].concat(names);
          var sel = document.createElement('select');
          sel.className = 'input mono';
          sel.id = id;
          sel.innerHTML = names.map(function (n) {
            return '<option value="' + U.esc(n) + '"' + (n === value ? ' selected' : '') + '>' + U.esc(n) + '</option>';
          }).join('');
          var old = wrap.querySelector('#' + id);
          if (old) wrap.replaceChild(sel, old);
          else wrap.appendChild(sel);
          return sel;
        }

        /**
         * 加载某个仓库的分支列表并填充两个下拉。
         * 目标分支用当前仓库（repo）的列表，源分支用来源仓库的列表；
         * 同一个仓库时只请求一次，两个下拉共用。
         *
         * 注意：`pr-hb` / `pr-bb` 这两个节点会被 toSelect 整个换掉，
         * 所以每次重建后都要重新取一遍，不能攥着旧引用。
         */
        function loadBranches() {
          var hFull = st.head.full;
          var tFull = repo.full_name;
          var same = hFull.toLowerCase() === String(tFull).toLowerCase();

          hbWrap.innerHTML = '<input class="input mono" id="pr-hb" placeholder="加载中…" disabled>';
          hbEl = root.querySelector('#pr-hb');

          var headP = listBranches(hFull);
          var baseP = same ? headP : listBranches(tFull);

          return Promise.all([headP, baseP]).then(function (arr) {
            var heads = arr[0] || [], bases = arr[1] || [];
            var wantBase = (st.baseBranch && bases.indexOf(st.baseBranch) >= 0)
              ? st.baseBranch
              : (heads.indexOf(base) >= 0 ? base : (bases[0] || base));
            st.baseBranch = wantBase;
            st.head.branches = heads;

            hbWrap.innerHTML = '';
            bbWrap.innerHTML = '';
            hbEl = toSelect(hbWrap, 'pr-hb', heads, st.headBranch || '');
            bbEl = toSelect(bbWrap, 'pr-bb', bases, wantBase);
            bindSelects();
            if (st.headBranch) loadCompare();
          }).catch(function (e) {
            hbWrap.innerHTML = '<input class="input mono" id="pr-hb" placeholder="分支名（列表拉不到，手动填）">';
            hbEl = root.querySelector('#pr-hb');
            bindSelects();
            UI.toast('拉取分支列表失败：' + e.message);
          });
        }

        /* 下拉换值时重新比对：提交数、文件数、以及标题的自动填充都靠它 */
        function bindSelects() {
          if (hbEl) hbEl.onchange = loadCompare;
          if (bbEl) bbEl.onchange = loadCompare;
        }

        /** 比对选定的两个分支，显示「N 个提交 · M 个文件」并生成标题 */
        function loadCompare() {
          var h = st.head.full, hb = hbEl.value, bb = bbEl.value;
          if (!hb || !bb) { cmpEl.hidden = true; return; }
          st.headBranch = hb; st.baseBranch = bb;
          cmpEl.hidden = false;
          cmpEl.innerHTML = '<span class="muted tiny">正在比对 ' + U.esc(hb) + ' → ' + U.esc(bb) + ' …</span>';
          window.API.get('/repos/' + repo.full_name + '/compare/' + encodeURIComponent(bb) + '...' +
            h.split('/')[0] + ':' + encodeURIComponent(hb), null, { cache: 0 }).then(function (r) {
            var d = r.data || {};
            var n = d.total_commits || 0;
            var files = (d.files || []).length;
            if (!n) {
              cmpEl.innerHTML = '<span class="muted tiny">' + window.icon('info', 14) +
                ' 这两个分支没有差异，没什么可合并的。</span>';
              return;
            }
            cmpEl.innerHTML = '<div class="muted tiny" style="line-height:1.7">' +
              window.icon('git-commit', 13) + ' ' + n + ' 个提交　' +
              window.icon('file', 13) + ' ' + files + ' 个文件变更</div>' +
              ((d.commits && d.commits[0]) ? '<div class="tiny" style="margin-top:4px">最新：' +
                U.esc(d.commits[0].commit.message.split('\n')[0]) + '</div>' : '');
            // 标题留空时用最新提交的标题兜底，跟 GitHub 网页版一样
            var tEl = root.querySelector('#pr-title');
            if (tEl && !tEl.value.trim() && d.commits && d.commits.length) {
              tEl.value = d.commits[d.commits.length - 1].commit.message.split('\n')[0].slice(0, 120);
            }
          }).catch(function (e) {
            var msg = e.status === 404 ? '找不到这个分支，确认名字对不对'
              : e.status === 403 ? '没有权限比对（来源仓库可能是私有的）' : e.message;
            cmpEl.innerHTML = '<span class="muted tiny">' + U.esc(msg) + '</span>';
          });
        }

        /** 来源仓库输入框 → 解析并重载分支 */
        function applyHead() {
          var p = parseHeadRepo(headEl.value, repo.full_name, owner, name);
          if (!p) { UI.toast('来源仓库格式不对，用 owner/repo 或 owner:分支'); return false; }
          var same = p.same;
          st.head = { full: p.full, branch: p.branch, same: same, branches: [] };
          st.headBranch = p.branch;
          if (p.branch) {
            // 直接给了分支名，分支列表慢慢加载，不阻塞
            st.baseBranch = base;
          }
          // 跨仓库时需要仓库对象来对齐默认分支；命中缓存就免一次请求
          if (!same) {
            var cached = window.API.cachedGet('/repos/' + p.full, null);
            if (cached && cached.data && cached.data.default_branch) {
              st.headRepo = cached.data;
            } else {
              window.API.get('/repos/' + p.full, null, { cache: 60000 }).then(function (r) {
                st.headRepo = r.data;
              }).catch(function (e) {
                UI.toast('读不到来源仓库 ' + p.full + '：' + e.message);
              });
            }
          } else {
            st.headRepo = repo;
          }
          return true;
        }

        headEl.onchange = function () { if (applyHead()) loadBranches(); };

        applyHead();
        loadBranches();

        UI.$$('[data-md]', root).forEach(function (b) {
          b.onclick = function () {
            var k = b.getAttribute('data-md');
            if (k === 'attach') {
              // 图片按钮：只选图片或视频
              window.Attach.pickInsert(b, bodyEl,
                { repoFull: repo.full_name, accept: 'image/*,video/*', hint: '请选择图片或视频' });
              return;
            }
            if (k === 'link') {
              // 链条按钮：上传任意附件
              window.Attach.pickInsert(b, bodyEl,
                { repoFull: repo.full_name, accept: '*/*', hint: '请选择要上传的文件' });
              return;
            }
            if (k === 'preview') {
              var pv = root.querySelector('#pr-prev');
              pv.hidden = !pv.hidden;
              if (!pv.hidden) window.MD.mount(pv, bodyEl.value || '（无内容）', { repo: repo.full_name });
              return;
            }
            wrapSelection(bodyEl, k);
          };
        });

        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        root.querySelector('[data-yes]').onclick = function () {
          // 提交前再解析一次：用户可能改了来源仓库却没触发 change（比如直接点创建）
          var p = parseHeadRepo(headEl.value, repo.full_name, owner, name);
          if (!p) return UI.toast('来源仓库格式不对，用 owner/repo 或 owner:分支');
          var hFull = p.full;
          var hb = (hbEl.value || '').trim() || p.branch;
          var bb = (bbEl.value || '').trim();
          var title = root.querySelector('#pr-title').value.trim();
          if (!hb) return UI.toast('请选择源分支');
          if (!bb) return UI.toast('请选择目标分支');
          if (hb === bb && p.same) return UI.toast('源分支与目标分支不能相同');
          if (!title) return UI.toast('请填写标题');

          var payload = {
            title: title,
            body: bodyEl.value || '',
            /* head 的写法有讲究：跨仓库必须写 `owner:branch`，
             * 同仓库只写分支名 —— 写成 `owner:branch` 时 GitHub 会当成
             * 「从 owner 的同名 fork 拉」，自己的仓库反而报 head 无效。 */
            head: p.same ? hb : (hFull.split('/')[0] + ':' + hb),
            base: bb,
            draft: root.querySelector('#pr-draft').checked
          };
          if (root.querySelector('#pr-maint').checked) payload.maintainer_can_modify = true;

          UI.loading(true);
          window.API.post('/repos/' + repo.full_name + '/pulls', payload).then(function (r) {
            UI.loading(false);
            UI.closeSheet();
            UI.toast('拉取请求已创建');
            window.App.invalidate('/repos/' + repo.full_name + '/pulls');
            var num = r.data && r.data.number;
            /* 创建成功但响应体没带 number 时不要崩 —— 列表刷新一下就行，
             * PR 其实已经建好了（跟 newIssue 同样的处理）。 */
            window.Router.go(num
              ? '/' + repo.full_name + '/pull/' + num
              : '/' + repo.full_name + '/pulls');
          }).catch(function (e) { UI.loading(false); UI.toast('创建失败：' + prErrorText(e)); });
        };
      }
    });
  }

  /**
   * 把 GitHub 建 PR 时最常见的几个 422 翻译成人话。
   * 原文太术语化（"Validation Failed"），用户看不出该改哪儿。
   */
  function prErrorText(e) {
    var msg = (e && e.message) || '未知错误';
    var errs = e && e.data && e.data.errors;
    if (errs && errs.length && errs[0].message) msg = errs[0].message;
    if (/already exists/i.test(msg)) return '这两个分支之间已经有未关闭的拉取请求了';
    if (/no commits between/i.test(msg)) return '源分支与目标分支没有差异，没什么可合并的';
    if (/not all refs are readable|invalid head/i.test(msg)) return '来源分支不存在或不可读，检查一下仓库名和分支名';
    if (/permission/i.test(msg)) return '没有权限从该来源分支创建拉取请求';
    return msg;
  }
  window.newPullRequest = newPullRequest;

  /* ============ 新建 / 导入仓库 ============ */

  /**
   * 生成一个可复用的「克隆地址」控件（表单预览与创建成功弹窗共用）。
   * @param {string} id      控件唯一后缀
   * @param {object} opts    {https, ssh, zip, hint}
   */
  function cloneWidget(id, opts) {
    opts = opts || {};
    return '<div class="clone-box" style="border-top:0;padding-top:0;margin-top:10px" data-clone="' + id + '">' +
      '<div class="clone-seg" id="seg-' + id + '">' +
      '<button data-k="https" class="active">HTTPS</button>' +
      '<button data-k="ssh">SSH</button>' +
      (opts.zip ? '<button data-k="zip">ZIP</button>' : '') +
      '</div>' +
      '<div class="clone-row">' +
      '<input class="input" id="in-' + id + '" type="text" readonly spellcheck="false" autocomplete="off" placeholder="输入仓库名称后自动生成">' +
      '<button class="btn" id="cp-' + id + '" title="复制">' + window.icon('copy', 14) + '</button>' +
      '</div>' +
      '<div class="clone-tip" id="tip-' + id + '">' + (opts.hint || '点击输入框可全选地址，长按可复制。') + '</div>' +
      '</div>';
  }

  /** 绑定克隆控件行为；返回 {set: fn({https,ssh,zip})} 供外部更新地址 */
  function bindClone(root, id) {
    var seg = root.querySelector('#seg-' + id);
    var input = root.querySelector('#in-' + id);
    var copyBtn = root.querySelector('#cp-' + id);
    var urls = {};
    var kind = 'https';

    var paint = function () {
      if (!input) return;
      input.value = urls[kind] || (urls.https || '');
      input.title = urls[kind] || '';
    };
    if (seg) {
      UI.$$('button', seg).forEach(function (b) {
        b.onclick = function () {
          kind = b.getAttribute('data-k');
          UI.$$('button', seg).forEach(function (x) { x.classList.toggle('active', x === b); });
          paint();
        };
      });
    }
    if (input) {
      input.onclick = function () { input.focus(); input.select(); };
      input.onfocus = function () {
        if (input.selectionStart === input.selectionEnd) input.setSelectionRange(0, input.value.length);
      };
    }
    if (copyBtn) {
      copyBtn.onclick = function () {
        var v = urls[kind] || urls.https || '';
        if (!v) return UI.toast('请先填写仓库名称');
        UI.copy(v, kind === 'zip' ? '下载链接已复制' : '克隆地址已复制');
        var old = copyBtn.innerHTML;
        copyBtn.innerHTML = window.icon('check', 14);
        setTimeout(function () { copyBtn.innerHTML = old; }, 1400);
      };
    }
    return {
      set: function (u) { urls = u || {}; paint(); }
    };
  }

  /** 根据账号与仓库名生成三种克隆地址 */
  function cloneUrls(owner, name) {
    if (!owner || !name) return {};
    return {
      https: 'https://github.com/' + owner + '/' + name + '.git',
      ssh: 'git@github.com:' + owner + '/' + name + '.git',
      zip: 'https://github.com/' + owner + '/' + name + '/archive/refs/heads/main.zip'
    };
  }

  function newRepo(opts) {
    opts = opts || {};
    if (!window.Session.isLogin) {
      return UI.confirm('需要登录', '创建仓库需要先登录 GitHub 账号。', '去登录').then(function (ok) {
        if (ok) window.Router.go('/login');
      });
    }
    var owner = (window.Session.user && window.Session.user.login) || '';
    var gitignore = [
      { v: '', t: '无' }, { v: 'Node', t: 'Node' }, { v: 'Python', t: 'Python' },
      { v: 'Java', t: 'Java' }, { v: 'Android', t: 'Android' }, { v: 'Gradle', t: 'Gradle' },
      { v: 'C++', t: 'C++' }, { v: 'Go', t: 'Go' }, { v: 'Rust', t: 'Rust' },
      { v: 'Swift', t: 'Swift' }, { v: 'Xcode', t: 'Xcode' }, { v: 'VisualStudio', t: 'Visual Studio' }
    ];
    var licenses = [
      { v: '', t: '无' }, { v: 'mit', t: 'MIT License' }, { v: 'apache-2.0', t: 'Apache License 2.0' },
      { v: 'gpl-3.0', t: 'GNU GPLv3' }, { v: 'agpl-3.0', t: 'GNU AGPLv3' },
      { v: 'lgpl-3.0', t: 'GNU LGPLv3' }, { v: 'mpl-2.0', t: 'Mozilla Public License 2.0' },
      { v: 'bsd-3-clause', t: 'BSD 3-Clause' }, { v: 'unlicense', t: 'The Unlicense' }
    ];

    var body =
      '<div class="seg-wrap" style="margin-bottom:12px">' + UI.seg('nmode', [
        { key: 'create', label: '新建仓库' }, { key: 'import', label: '导入仓库' }], 'create') + '</div>' +
      '<div class="card" style="margin:0 0 12px;padding:12px">' +
      '<div class="muted tiny">仓库将创建在你的账号 <b>@' + U.esc(owner) + '</b> 下</div></div>' +

      /* ---------- 新建模式 ---------- */
      '<div id="m-create">' +
      '<div class="field"><label>仓库名称 <span style="color:var(--danger)">*</span></label>' +
      '<input class="input" id="rn" placeholder="my-awesome-project" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<div class="hint">只能包含字母、数字、连字符（-）、下划线（_）和点（.）</div></div>' +
      '<div class="field"><label>简介</label>' +
      '<input class="input" id="rd" placeholder="一句话描述这个仓库（可选）"></div>' +
      '<div class="field"><label>可见性</label>' +
      '<div class="newrepo-radio on" data-vis="public"><span class="dot"></span><span class="grow">' +
      '<span class="rt">公开</span><span class="rd">任何人都可以看到这个仓库</span></span></div>' +
      '<div class="newrepo-radio" data-vis="private"><span class="dot"></span><span class="grow">' +
      '<span class="rt">私有</span><span class="rd">只有你和你选择的人可以看到</span></span></div>' +
      '</div>' +
      '<div class="field"><label>初始化选项</label>' +
      '<label class="rowflex" style="gap:8px;padding:8px 0"><input type="checkbox" id="rreadme" checked style="width:16px;height:16px">' +
      '<span>添加 README 文件</span></label>' +
      '<div class="subfield">' +
      '<label class="tiny muted">.gitignore 模板</label>' +
      '<select class="input" id="rgi">' + gitignore.map(function (g) {
        return '<option value="' + U.esc(g.v) + '">' + U.esc(g.t) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="subfield">' +
      '<label class="tiny muted">开源许可证</label>' +
      '<select class="input" id="rlic">' + licenses.map(function (l) {
        return '<option value="' + U.esc(l.v) + '">' + U.esc(l.t) + '</option>';
      }).join('') + '</select></div>' +
      '</div>' +
      /* 克隆地址实时预览 */
      '<div class="field"><label>克隆地址（创建后即可使用）</label>' +
      cloneWidget('new', { hint: '地址会随仓库名称自动生成，可先复制备用。' }) +
      '</div>' +
      '</div>' +

      /* ---------- 导入模式 ---------- */
      '<div id="m-import" hidden>' +
      '<div class="field"><label>源仓库地址 <span style="color:var(--danger)">*</span></label>' +
      '<input class="input" id="iurl" type="text" placeholder="https://github.com/用户名/仓库.git" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<div class="hint">填写要导入的 Git 仓库地址，支持 GitHub / GitLab / Bitbucket 等公开仓库。</div></div>' +
      '<div class="field"><label>新仓库名称 <span style="color:var(--danger)">*</span></label>' +
      '<input class="input" id="iname" placeholder="导入后在你账号下的仓库名" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div>' +
      '<div class="field"><label>可见性</label>' +
      '<div class="newrepo-radio on" data-vis="public"><span class="dot"></span><span class="grow">' +
      '<span class="rt">公开</span><span class="rd">任何人都可以看到这个仓库</span></span></div>' +
      '<div class="newrepo-radio" data-vis="private"><span class="dot"></span><span class="grow">' +
      '<span class="rt">私有</span><span class="rd">只有你和你选择的人可以看到</span></span></div>' +
      '</div>' +
      '<div class="card" style="padding:12px;margin-bottom:12px">' +
      '<div class="muted tiny">导入说明</div>' +
      '<div class="tiny muted" style="margin-top:6px;line-height:1.6">' +
      'GitHub 会在服务端拉取源仓库的全部提交历史与分支，大型仓库可能需要较长时间。' +
      '导入开始后可在仓库页查看进度。</div></div>' +
      '<div class="field"><label>克隆地址（创建后即可使用）</label>' +
      cloneWidget('imp', { hint: '地址会随新仓库名称自动生成，可先复制备用。' }) +
      '</div>' +
      '</div>';

    var root = document.getElementById('sheet-root');
    var mode = 'create';
    UI.sheet({
      title: '新建仓库', full: true, body: body,
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>创建仓库</button>',
      onMount: function () {
        var vis = { create: 'public', import: 'public' };
        var cloneNew = bindClone(root, 'new');
        var cloneImp = bindClone(root, 'imp');
        var nameEl = root.querySelector('#rn');
        var impUrl = root.querySelector('#iurl');
        var impName = root.querySelector('#iname');

        // 可见性单选（两个模式各自独立）
        var bindRadios = function () {
          UI.$$('.newrepo-radio', root).forEach(function (r) {
            r.onclick = function () {
              var box = r.closest('#m-create') || r.closest('#m-import');
              if (!box) return;
              var m = box.id === 'm-import' ? 'import' : 'create';
              vis[m] = r.getAttribute('data-vis');
              UI.$$('.newrepo-radio', box).forEach(function (x) { x.classList.toggle('on', x === r); });
            };
          });
        };
        bindRadios();

        // ---- 模式切换 ----
        UI.$$('#nmode button', root).forEach(function (b) {
          b.onclick = function () {
            mode = b.getAttribute('data-v');
            UI.$$('#nmode button', root).forEach(function (x) { x.classList.toggle('active', x === b); });
            root.querySelector('#m-create').hidden = mode !== 'create';
            root.querySelector('#m-import').hidden = mode !== 'import';
            root.querySelector('[data-yes]').textContent = mode === 'import' ? '导入仓库' : '创建仓库';
            setTimeout(function () {
              if (mode === 'create') nameEl.focus(); else impUrl.focus();
            }, 120);
          };
        });

        // ---- 实时生成克隆地址 ----
        var syncClone = function () {
          var n = nameEl.value.trim();
          cloneNew.set(cloneUrls(owner, n));
          var in2 = impName.value.trim();
          cloneImp.set(cloneUrls(owner, in2));
        };
        // 仓库名：空格转连字符（对齐官网）
        nameEl.addEventListener('input', function () {
          var p = nameEl.selectionStart;
          var v = nameEl.value.replace(/\s+/g, '-');
          if (v !== nameEl.value) { nameEl.value = v; nameEl.setSelectionRange(p, p); }
          syncClone();
        });
        // 从源地址自动推断新仓库名
        impUrl.addEventListener('input', function () {
          if (!impName.dataset.touched) {
            var m = impUrl.value.trim().match(/\/([^\/]+?)(?:\.git)?$/);
            if (m) impName.value = m[1];
          }
          syncClone();
        });
        impName.addEventListener('input', function () {
          impName.dataset.touched = '1';
          impName.value = impName.value.replace(/\s+/g, '-');
          syncClone();
        });
        syncClone();
        setTimeout(function () { nameEl.focus(); }, 260);

        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        root.querySelector('[data-yes]').onclick = function () {
          if (mode === 'import') return doImport();
          return doCreate();
        };

        // ---- 新建 ----
        function doCreate() {
          var name = nameEl.value.trim();
          if (!name) return UI.toast('请填写仓库名称');
          if (!/^[A-Za-z0-9._-]+$/.test(name)) return UI.toast('仓库名只能包含字母、数字、- _ .');
          var payload = {
            name: name,
            description: (root.querySelector('#rd').value || '').trim() || null,
            private: vis.create === 'private',
            has_issues: true, has_projects: true, has_wiki: true,
            auto_init: !!root.querySelector('#rreadme').checked
          };
          var gi = root.querySelector('#rgi').value;
          var lic = root.querySelector('#rlic').value;
          if (gi) payload.gitignore_template = gi;
          if (lic) payload.license_template = lic;

          UI.loading(true);
          window.API.post('/user/repos', payload).then(function (r) {
            UI.loading(false);
            afterCreate(r.data, name);
          }).catch(function (e) {
            UI.loading(false);
            UI.toast('创建失败：' + (e.status === 422 ? '仓库名已存在或不可用' : e.message));
          });
        }

        // ---- 导入 ----
        function doImport() {
          var src = impUrl.value.trim();
          var name = impName.value.trim();
          if (!src) return UI.toast('请填写源仓库地址');
          if (!/^(https?:\/\/|git@)/.test(src)) return UI.toast('源地址需以 https:// 或 git@ 开头');
          if (!name) return UI.toast('请填写新仓库名称');
          if (!/^[A-Za-z0-9._-]+$/.test(name)) return UI.toast('仓库名只能包含字母、数字、- _ .');

          UI.loading(true);
          // 1) 先建一个空仓库（不用 auto_init，导入需要空仓库）
          window.API.post('/user/repos', {
            name: name,
            private: vis.import === 'private',
            has_issues: true, has_projects: true, has_wiki: true,
            auto_init: false
          }).then(function (r) {
            // 2) 发起导入
            /* 建仓库这一步如果没返回 full_name，说明请求没真的成功，
             * 别拿 undefined 去拼下一请求的 URL —— 那样既看不出错在哪，
             * 还会在 )/import 这种畸形地址上再失败一次。 */
            var full = r.data && r.data.full_name;
            if (!full) throw new Error('仓库创建失败，请重试');
            return window.API.put('/repos/' + full + '/import',
              { vcs: 'git', vcs_url: src }).then(function () {
              return { data: { full_name: full } };
            });
          }).then(function (repo) {
            UI.loading(false);
            try { window.App.invalidate('/user/repos'); } catch (e) {}
            UI.closeSheet();
            UI.toast('导入已开始，可在仓库页查看进度');
            window.Router.go('/' + repo.full_name + '?importing=1');
          }).catch(function (e) {
            UI.loading(false);
            UI.toast('导入失败：' + (e.status === 422 ? '仓库名已存在，或源地址不可访问' : e.message));
          });
        }

        /** 创建/导入成功后：弹层展示仓库信息 + 克隆地址，再前往仓库 */
        function afterCreate(repo, name) {
          try { window.App.invalidate('/user/repos'); } catch (e) {}
          try { window.App.cacheDel('repo_' + repo.full_name); } catch (e) {}
          var full = repo.full_name || (owner + '/' + name);
          var url = repo.html_url || ('https://github.com/' + full);
          // sheet() 会整体替换 sheet-root，必须先收起当前弹层
          UI.closeSheet();
          setTimeout(function () {
            var r2 = document.getElementById('sheet-root');
            UI.sheet({
              title: '仓库已创建',
              body: '<div class="card" style="padding:14px;margin-bottom:12px">' +
                '<div class="rowflex" style="gap:10px;align-items:center">' +
                '<span class="ok-badge">' + window.icon('check', 15) + '</span>' +
                '<span class="grow"><b>' + U.esc(full) + '</b>' +
                '<div class="tiny muted" style="margin-top:2px">' + (repo.private ? '私有仓库' : '公开仓库') +
                ' · 可直接克隆到本地</div></span></div></div>' +
                '<div class="field"><label>克隆地址</label>' + cloneWidget('done', { zip: true }) + '</div>',
              foot: '<button class="btn" data-no>留在首页</button><button class="btn primary" data-yes>前往仓库</button>',
              onMount: function () {
                var u = cloneUrls(owner, name);
                u.zip = url + '/archive/refs/heads/main.zip';
                bindClone(r2, 'done').set(u);
                r2.querySelector('[data-no]').onclick = function () {
                  UI.closeSheet();
                  window.Router.reload();
                };
                r2.querySelector('[data-yes]').onclick = function () {
                  UI.closeSheet();
                  window.Router.go('/' + full);
                };
              }
            });
          }, 60);
        }
      }
    });
  }
  window.newRepo = newRepo;

  function wrapSelection(ta, kind) {
    var s = ta.selectionStart, e = ta.selectionEnd, v = ta.value, sel = v.substring(s, e);
    var map = { bold: ['**', '**'], italic: ['*', '*'], code: ['`', '`'], quote: ['\n> ', ''], link: ['[](', ')'], 'list-unordered': ['\n- ', ''], tasklist: ['\n- [ ] ', ''] };
    var p = map[kind] || ['', ''];
    ta.value = v.substring(0, s) + p[0] + sel + p[1] + v.substring(e);
    ta.focus();
    ta.selectionStart = s + p[0].length; ta.selectionEnd = s + p[0].length + sel.length;
  }
  window.wrapSelection = wrapSelection;

  /** 把文本插到光标处（插图 / 插视频用） */
  function insertAtCursor(ta, text) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    if (s == null || s < 0) s = e = ta.value.length;
    ta.value = ta.value.substring(0, s) + text + ta.value.substring(e);
    var pos = s + text.length;
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (err) { }
  }
  window.insertAtCursor = insertAtCursor;
  /* ============================================================
   * 协作者与邀请
   *
   * 核心是五个权限等级，先把话说清楚：
   *   Read     能看、能 clone、能开议题、能评论
   *   Triage   + 能管议题和 PR（打标签、指派、关里程碑、标重复），一行代码都不能写
   *   Write    + 能推分支、能合并 PR（日常协作者默认档）
   *   Maintain + 能管仓库大部分设置（分支保护、webhook 这类），
   *             但不能删仓库、不能转让、不能改可见性
   *   Admin    全部 —— 删仓库、转让、改可见性、管安全设置、再邀请别人
   *
   * ⚠️ GitHub 对同一件事用了三套叫法，这里集中映射一次，别散在业务代码里：
   *   - 协作者列表 / 加人改权限：pull / triage / push / maintain / admin
   *   - 邀请（列出、改、撤）    ：read / triage / write / maintain / admin
   *   - 查某个人的权限          ：read / write / admin
   * 对外一律用左边的 key，真正发请求前再换成那套接口认的词。
   * 混着写的话，「Read」在邀请那边得发成 read、在协作者那边得发成 pull，
   * 写反了不报错，只是等级对不上 —— 这种错最难查。
   * ============================================================ */
  var COLLAB_LEVELS = [
    { key: 'pull', inv: 'read', label: 'Read', cn: '只读', icon: 'eye',
      desc: '能看、能 clone、能开议题、能评论。给只是想围观的人。' },
    { key: 'triage', inv: 'triage', label: 'Triage', cn: '分类', icon: 'tag',
      desc: '上面全部，外加能管议题和 PR —— 打标签、指派、关里程碑、标重复。但一行代码都不能写。适合帮你当客服、整理议题的人。' },
    { key: 'push', inv: 'write', label: 'Write', cn: '写', icon: 'pencil',
      desc: '上面全部，外加能推分支、能合并 PR。日常协作者默认给这个。' },
    { key: 'maintain', inv: 'maintain', label: 'Maintain', cn: '维护', icon: 'gear',
      desc: '上面全部，外加能管仓库大部分设置（分支保护、webhook 这类）。但不能删仓库、不能转让、不能改可见性。' },
    { key: 'admin', inv: 'admin', label: 'Admin', cn: '管理员', icon: 'shield',
      desc: '全部 —— 删仓库、转让、改可见性、管安全设置、再邀请别人。' }
  ];

  function levelOf(key) {
    for (var i = 0; i < COLLAB_LEVELS.length; i++) {
      if (COLLAB_LEVELS[i].key === key) return COLLAB_LEVELS[i];
    }
    return null;
  }

  /** 邀请接口认 read/write，协作者接口认 pull/push —— 发请求前换一下 */
  function levelToInvite(key) { var l = levelOf(key); return l ? l.inv : key; }

  /** 服务端返回的角色名（read / write / admin / …）→ 内部 key */
  function roleToLevel(role) {
    if (role === 'admin') return 'admin';
    if (role === 'maintain') return 'maintain';
    if (role === 'write') return 'push';
    if (role === 'triage') return 'triage';
    if (role === 'read') return 'pull';
    return null;
  }

  /** 从 permissions 布尔集合里取最高的那一档（由高到低扫） */
  function permLevel(p) {
    if (!p) return null;
    for (var i = COLLAB_LEVELS.length - 1; i >= 0; i--) {
      if (p[COLLAB_LEVELS[i].key]) return COLLAB_LEVELS[i].key;
    }
    return null;
  }

  function levelText(key) {
    var l = levelOf(key);
    return l ? l.label + '（' + l.cn + '）' : (key || '未知');
  }

  /**
   * 我在这个仓库是第几档。
   * 仓库对象自带 permissions 就直接用它，省一次请求 —— 但搜索结果、页面缓存
   * 里那份常常不带这个字段，那时才去问一次 /collaborators/:me/permission。
   */
  function myLevel(repo) {
    var me = window.Session.user && window.Session.user.login;
    if (!me) return Promise.resolve(null);
    var owner = repo.owner || {};
    if (owner.login && owner.login === me) return Promise.resolve('admin');
    var lv = permLevel(repo.permissions);
    if (lv) return Promise.resolve(lv);
    return window.API
      .get('/repos/' + repo.full_name + '/collaborators/' + encodeURIComponent(me) + '/permission')
      .then(function (r) { return roleToLevel(r.data && r.data.permission); })
      .catch(function () { return null; });
  }

  /** 五档选择器：每档都带一句说明，不然光看 Read/Triage 没人知道差在哪 */
  function pickLevel(title, cur, onPick) {
    var body = '<div class="tiny muted" style="padding:0 0 8px">点一档就立刻生效。</div>' +
      '<div class="list">' + COLLAB_LEVELS.map(function (l) {
        return '<button class="list-row" data-k="' + U.esc(l.key) + '">' +
          '<span class="row-main">' +
          '<span class="row-title">' + U.esc(l.label + '（' + l.cn + '）') +
          (l.key === cur ? '　<span class="chip" style="padding:0 6px">当前</span>' : '') + '</span>' +
          '<span class="row-desc">' + U.esc(l.desc) + '</span>' +
          '</span>' +
          (l.key === cur ? '<span class="row-side">' + window.icon('check', 16) + '</span>' : '') +
          '</button>';
      }).join('') + '</div>';
    var root = document.getElementById('sheet-root');
    UI.sheet({
      title: title, body: body, full: true,
      onMount: function () {
        UI.$$('.list-row', root).forEach(function (b) {
          b.onclick = function () {
            var k = b.getAttribute('data-k');
            UI.closeSheet();
            onPick(k);
          };
        });
      }
    });
  }

  /** 协作者那一页 */
  function tabCollaborators(repo, ctx, box) {
    var me = (window.Session.user && window.Session.user.login) || '';
    var ownerLogin = (repo.owner && repo.owner.login) || '';
    var mine = null, people = [], invites = [], isAdmin = false;
    var listErr = '', invErr = '';

    function rowBtn(o) {
      /* 置灰而不是隐藏：让人看见「有这个操作，只是我现在级别不够」，
         比整个按钮消失更容易理解为什么不能用 */
      return '<button class="btn block' + (o.primary ? ' primary' : '') + '" id="' + o.id + '"' +
        (o.on ? '' : ' disabled') + '>' +
        window.icon(o.icon, 15) + ' ' + U.esc(o.label) + '</button>';
    }

    /** 一个人当前是第几档：permissions 优先，退回 role_name */
    function levelOfUser(u) {
      return permLevel(u && u.permissions) || roleToLevel(u && u.role_name) || 'pull';
    }

    function personRow(u) {
      var level = levelOfUser(u);
      var lv = levelOf(level) || {};
      return '<button class="list-row" data-u="' + U.esc(u.login) + '">' +
        UI.avatar(u.login, u.avatar_url, 32) +
        '<span class="row-main">' +
        '<span class="row-title">' + U.esc(u.login) +
        (u.login === ownerLogin ? ' <span class="chip" style="padding:0 6px">所有者</span>' : '') +
        (u.login === me ? ' <span class="chip" style="padding:0 6px">我</span>' : '') + '</span>' +
        '<span class="row-desc">' + U.esc(levelText(level)) + '</span>' +
        '</span>' +
        '<span class="row-side">' + window.icon(lv.icon || 'person', 16) + '</span>' +
        '</button>';
    }

    function inviteRow(v) {
      var who = (v.invitee && v.invitee.login) || v.email || '（未知）';
      var level = roleToLevel(v.permissions) || 'pull';
      return '<button class="list-row" data-v="' + U.esc(String(v.id)) + '">' +
        UI.avatar(who, v.invitee && v.invitee.avatar_url, 32) +
        '<span class="row-main">' +
        '<span class="row-title">' + U.esc(who) + '</span>' +
        '<span class="row-desc">' + U.esc(levelText(level)) + '　待接受</span>' +
        '</span>' +
        '<span class="row-side">' + window.icon('hourglass', 16) + '</span>' +
        '</button>';
    }

    function draw() {
      box.innerHTML =
        /* ---- 我的权限 ---- */
        '<div class="set-group-title">我的权限</div>' +
        '<div class="card" style="padding:14px">' +
        '<div class="rowflex" style="gap:10px;align-items:flex-start">' +
        '<span style="flex:none;margin-top:2px">' + window.icon((levelOf(mine) || {}).icon || 'person', 18) + '</span>' +
        '<span class="grow"><b>' + U.esc(me || '未登录') + '　' + U.esc(levelText(mine)) + '</b>' +
        '<div class="tiny muted" style="margin-top:4px;line-height:1.5">' +
        U.esc((levelOf(mine) || {}).desc || '取不到你的权限，可能没有访问这个仓库。') +
        '</div></span></div>' +
        (isAdmin ? '' : '<div class="tiny muted" style="margin-top:10px">' +
          '邀请、改权限、移除都只有 Admin 能做，下面的按钮已置灰。</div>') +
        '</div>' +

        /* ---- 协作者 ---- */
        '<div class="section"></div>' +
        '<div class="set-group-title">协作者（' + people.length + '）</div>' +
        (people.length ? '<div class="list">' + people.map(personRow).join('') + '</div>'
          : '<div class="card" style="padding:12px 14px"><div class="tiny muted">' +
            (listErr || '还没有协作者。') + '</div></div>') +
        (people.length ? '<div class="tiny muted" style="padding:8px 14px 0;line-height:1.5">' +
          '点一条 = 改权限；长按一条 = 移除等操作。</div>' : '') +
        '<div class="card" style="margin-top:12px">' +
        rowBtn({ id: 'cb-inv', icon: 'person', label: '邀请协作者', primary: true, on: isAdmin }) +
        '</div>' +

        /* ---- 待处理邀请 ---- */
        '<div class="section"></div>' +
        '<div class="set-group-title">待处理邀请（' + invites.length + '）</div>' +
        (invites.length ? '<div class="list">' + invites.map(inviteRow).join('') + '</div>'
          : '<div class="card" style="padding:12px 14px"><div class="tiny muted">' +
            (invErr || '没有待处理的邀请。') + '</div></div>') +

        /* ---- 说明 ---- */
        '<div class="card" style="padding:12px 14px;margin-top:12px"><div class="tiny muted">' +
        '组织内的成员点了就立刻生效；组织外的人会收到一封邀请邮件，进到上面' +
        '「待处理邀请」里，接受之后才算是协作者。移除某人后他已经 fork 出去的' +
        '仓库不受影响。</div></div>';

      UI.noticeRefresh(box);
      bind();
    }

    function bind() {
      var inv = UI.$('#cb-inv', box);
      if (inv && !inv.disabled) inv.onclick = function () { doInvite(); };

      UI.$$('[data-u]', box).forEach(function (b) {
        /* 长按走菜单（移除等破坏性操作藏在这里，避免手滑点错），
           单击保持「点一下就选等级」的直觉 */
        var wasLong = UI.bindLongPress(b, function () {
          personMenu(b.getAttribute('data-u'));
        });
        b.onclick = function () {
          if (wasLong && wasLong()) return;   // 长按松手带出来的 click：吞掉
          changeLevel(b.getAttribute('data-u'));
        };
      });

      UI.$$('[data-v]', box).forEach(function (b) {
        b.onclick = function () {
          var id = b.getAttribute('data-v');
          var v = null;
          invites.forEach(function (x) { if (String(x.id) === id) v = x; });
          if (v) inviteSheet(v);
        };
      });
    }

    /** 长按某一位协作者：改权限 / 看主页 / 移除 */
    function personMenu(login) {
      if (!isAdmin) return UI.toast('只有 Admin 能改权限或移除协作者');
      if (login === ownerLogin) return UI.toast('仓库所有者不能被改权限，也不能被移除');
      UI.menu(login, [
        { icon: 'shield', label: '改权限', key: 'lv' },
        { icon: 'person', label: '查看他的主页', key: 'user' },
        '-',
        { icon: 'trash', label: '移除协作者', key: 'rm' }
      ]).then(function (k) {
        if (!k) return;
        if (k === 'lv') return changeLevel(login);
        if (k === 'user') return window.Router.go('/' + login);
        if (k === 'rm') return doRemove(login);
      });
    }

    /** 改某人的权限：点人 → 选等级 → 立刻生效 */
    function changeLevel(login) {
      if (!isAdmin) return UI.toast('只有 Admin 能改权限');
      if (login === ownerLogin) return UI.toast('仓库所有者的权限不能改');
      var u = null;
      people.forEach(function (x) { if (x.login === login) u = x; });
      var cur = levelOfUser(u);
      pickLevel(login + ' 的权限', cur, function (k) {
        if (k === cur) return;
        UI.loading(true);
        window.API.put('/repos/' + repo.full_name + '/collaborators/' + encodeURIComponent(login),
          { permission: k })
          .then(function () {
            UI.loading(false); UI.toast('已改为 ' + levelText(k)); reload();
          })
          .catch(function (e) {
            UI.loading(false);
            UI.toast('改权限失败：' + (e.status === 403 ? '需要 Admin 权限' : e.message));
          });
      });
    }

    /** 某一条待处理邀请：改权限 / 复制链接 / 撤销 */
    function inviteSheet(v) {
      var who = (v.invitee && v.invitee.login) || v.email || '这条邀请';
      var cur = roleToLevel(v.permissions) || 'pull';
      var link = v.html_url || ('https://github.com/' + repo.full_name + '/invitations');
      var root = document.getElementById('sheet-root');
      UI.sheet({
        title: who + ' 的邀请',
        body: '<div class="card" style="padding:12px 14px"><div class="tiny muted">' +
          '当前：' + U.esc(levelText(cur)) + '。对方还没接受，可以先改等级再通知他。</div></div>' +
          '<div class="card" style="margin-top:12px">' +
          '<button class="btn block" id="iv-lv"' + (isAdmin ? '' : ' disabled') + '>' +
          window.icon('shield', 15) + ' 改邀请的权限</button>' +
          '<button class="btn block" id="iv-link">' + window.icon('link', 15) + ' 复制链接催他</button>' +
          '<button class="btn block danger" id="iv-cancel"' + (isAdmin ? '' : ' disabled') + '>' +
          window.icon('trash', 15) + ' 撤销邀请</button>' +
          '</div>' +
          (isAdmin ? '' : '<div class="tiny muted" style="padding:0 14px">' +
            '只有 Admin 能改邀请或撤销。</div>'),
        onMount: function () {
          var lv = root.querySelector('#iv-lv');
          var lk = root.querySelector('#iv-link');
          var cc = root.querySelector('#iv-cancel');
          if (lv && !lv.disabled) lv.onclick = function () {
            UI.closeSheet();
            pickLevel('邀请 ' + who + ' 的权限', cur, function (k) {
              if (k === cur) return;
              UI.loading(true);
              window.API.patch('/repos/' + repo.full_name + '/invitations/' + v.id,
                { permissions: levelToInvite(k) })
                .then(function () {
                  UI.loading(false); UI.toast('已改为 ' + levelText(k)); reload();
                })
                .catch(function (e) {
                  UI.loading(false);
                  UI.toast('改邀请失败：' + (e.status === 403 ? '需要 Admin 权限' : e.message));
                });
            });
          };
          if (lk) lk.onclick = function () {
            UI.closeSheet();
            UI.copy(link, '邀请链接已复制');
          };
          if (cc && !cc.disabled) cc.onclick = function () {
            UI.confirm('撤销邀请', '将撤销发给 ' + who + ' 的邀请，他点开那个链接会失效。', '撤销', true)
              .then(function (ok) {
                if (!ok) return;
                UI.loading(true);
                window.API.del('/repos/' + repo.full_name + '/invitations/' + v.id)
                  .then(function () { UI.loading(false); UI.toast('已撤销'); reload(); })
                  .catch(function (e) {
                    UI.loading(false);
                    UI.toast('撤销失败：' + (e.status === 403 ? '需要 Admin 权限' : e.message));
                  });
              });
          };
        }
      });
    }

    /** 移除协作者：二次确认，说清楚后果 */
    function doRemove(login) {
      UI.confirm('移除协作者',
        '将移除 ' + login + '，他立刻失去这个仓库的访问权。他已经 fork 出去的仓库不受影响。',
        '移除', true).then(function (ok) {
        if (!ok) return;
        UI.loading(true);
        window.API.del('/repos/' + repo.full_name + '/collaborators/' + encodeURIComponent(login))
          .then(function () { UI.loading(false); UI.toast('已移除 ' + login); reload(); })
          .catch(function (e) {
            UI.loading(false);
            UI.toast('移除失败：' + (e.status === 403 ? '需要 Admin 权限' : e.message));
          });
      });
    }

    /** 邀请：输用户名 → 选等级 → 发。返回里带 id 说明是给组织外的人发了邮件 */
    function doInvite() {
      UI.prompt('邀请协作者', {
        placeholder: 'GitHub 用户名', ok: '下一步',
        desc: '填对方的 GitHub 用户名。组织内的人点了立刻生效；组织外的人会收到一封邀请邮件。'
      }).then(function (name) {
        name = (name || '').trim();
        if (!name) return;
        if (name === me) return UI.toast('不用邀请自己');
        if (name === ownerLogin) return UI.toast('对方就是仓库所有者');
        pickLevel('邀请 ' + name + ' 的权限', 'push', function (k) {
          UI.loading(true);
          window.API.put('/repos/' + repo.full_name + '/collaborators/' + encodeURIComponent(name),
            { permission: k })
            .then(function (r) {
              UI.loading(false);
              var pending = !!(r && r.data && r.data.id);
              UI.toast(pending
                ? '邀请已发出，等 ' + name + ' 接受（' + levelText(k) + '）'
                : '已把 ' + name + ' 加为协作者（' + levelText(k) + '）');
              reload();
            })
            .catch(function (e) {
              UI.loading(false);
              UI.toast('邀请失败：' + (e.status === 404 ? '找不到这个用户'
                : e.status === 403 ? '需要 Admin 权限' : e.message));
            });
        });
      });
    }

    function reload() {
      UI.loading(true);
      Promise.all([
        myLevel(repo),
        window.API.get('/repos/' + repo.full_name + '/collaborators',
          { per_page: 100, affiliation: 'all' }).catch(function () { return { data: null }; }),
        window.API.get('/repos/' + repo.full_name + '/invitations', { per_page: 100 })
          .catch(function () { return { data: null }; })
      ]).then(function (rs) {
        UI.loading(false);
        mine = rs[0];
        isAdmin = mine === 'admin';
        people = (rs[1] && rs[1].data) || [];
        invites = (rs[2] && rs[2].data) || [];
        /* 列表取不回来通常是权限不够（要 push 以上），不是接口坏了 ——
           按「没有」处理并说一句，比甩一个红字错误框体面 */
        listErr = (rs[1] && rs[1].data) ? '' : '没有查看协作者列表的权限（需要 Write 以上）。';
        invErr = (rs[2] && rs[2].data) ? '' : '没有查看邀请的权限（需要 Admin）。';
        draw();
      });
    }

    box.innerHTML = '<div id="cbwait">' + UI.skeleton(3) + '</div>';
    reload();
  }

})();
