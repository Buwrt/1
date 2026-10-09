/* ============================================================
 * page-user.js — 用户/组织主页、我的、Gist、设置
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});

  var USER_TABS = [
    { key: 'overview', label: '概览' }, { key: 'repos', label: '仓库' },
    { key: 'stars', label: 'Star' }, { key: 'gists', label: 'Gist' },
    { key: 'activity', label: '动态' }, { key: 'followers', label: '粉丝' },
    { key: 'following', label: '关注' }, { key: 'orgs', label: '组织' }
  ];

  /* ============ 用户 / 组织 ============ */
  P.user = {
    title: function (ctx) { return ctx.login; },
    render: function (ctx, host) {
      var login = ctx.login;
      var tab = ctx.query.tab || 'overview';
      host.innerHTML = '<div class="card flat" style="border:0">' + UI.skeleton(3) + '</div>';
      // 渲染纪元：响应比返回键慢时页面已换人，整份丢弃 —— 回调里还会改顶栏
      // 标题，过期时同样不能放行（见 Router.render 里 viewEpoch 的注释）。
      var epoch = window.Router.viewEpoch;

      return window.API.get('/users/' + login, null, { cache: 60000 }).then(function (r) {
        if (epoch !== window.Router.viewEpoch) return;
        var u = r.data;
        // 响应体丢了就别往下走：下面每一行都在读 u.login/u.type，null 进来必崩
        if (!u || typeof u !== 'object') {
          host.innerHTML = UI.errorBox(new Error('用户信息读取失败'));
          return;
        }
        var isMe = window.Session.user && window.Session.user.login === login;
        window.App.title(login, u.type === 'Organization' ? '组织' : (u.name || '用户'));

        host.innerHTML =
          '<div class="profile-head">' +
          '<div class="profile-top">' + UI.avatar(login, u.avatar_url, 80) +
          '<div class="grow"><div class="profile-name">' + U.esc(u.name || login) + '</div>' +
          '<div class="profile-login">@' + U.esc(login) + (u.type === 'Organization' ? ' · 组织' : '') + '</div></div></div>' +
          (u.bio ? '<div class="profile-bio">' + U.esc(u.bio) + '</div>' : '') +
          '<div class="profile-meta">' +
          (u.company ? '<span>' + window.icon('organization', 14) + U.esc(u.company) + '</span>' : '') +
          (u.location ? '<span>' + window.icon('globe', 14) + U.esc(u.location) + '</span>' : '') +
          (u.email ? '<span>' + window.icon('mail', 14) + U.esc(u.email) + '</span>' : '') +
          (u.blog ? '<span>' + window.icon('link', 14) + '<a href="' + U.esc(u.blog) + '" target="_blank">' + U.esc(u.blog.replace(/^https?:\/\//, '')) + '</a></span>' : '') +
          (u.created_at ? '<span>' + window.icon('clock', 14) + '加入于 ' + U.date(u.created_at) + '</span>' : '') +
          '</div>' +
          '<div class="stat-row">' +
          '<a href="#/' + U.esc(login) + '?tab=repos"><b>' + U.num(u.public_repos) + '</b>仓库</a>' +
          (u.type === 'Organization'
            ? '<a href="#/' + U.esc(login) + '?tab=followers"><b>' + U.num(u.followers) + '</b>成员</a>'
            : '<a href="#/' + U.esc(login) + '?tab=followers"><b>' + U.num(u.followers) + '</b>粉丝</a>' +
              '<a href="#/' + U.esc(login) + '?tab=following"><b>' + U.num(u.following) + '</b>关注</a>') +
          '<a href="#/' + U.esc(login) + '?tab=stars"><b id="starcount">—</b>Star</a>' +
          '<a href="#/' + U.esc(login) + '?tab=gists"><b>' + U.num(u.public_gists || 0) + '</b>Gist</a>' +
          '</div>' +
          (isMe ? '<button class="btn block mt12" id="edit">' + window.icon('pencil', 14) + ' 编辑资料（网页端）</button>'
            : u.type !== 'Organization' ? '<button class="btn block mt12" id="follow">' + window.icon('person', 14) + '<span id="ftxt">关注</span></button>' : '') +
          '</div>' +
          '<div class="tabs" id="utabs">' + USER_TABS.filter(function (t) {
            return !(u.type === 'Organization' && (t.key === 'stars' || t.key === 'following' || t.key === 'gists'));
          }).map(function (t) {
            return '<button data-t="' + t.key + '" class="' + (t.key === tab ? 'active' : '') + '">' + t.label + '</button>';
          }).join('') + '</div>' +
          '<div id="ubody">' + UI.skeleton(4) + '</div>';

        UI.$$('#utabs button', host).forEach(function (b) {
          b.onclick = function () { window.Router.go('/' + login + '?tab=' + b.getAttribute('data-t')); };
        });

        // Star 总数：/users/{login} 不返回，需异步统计（取第一页的 Link 尾页，最多 4 页兜底）
        starCount(login).then(function (n) {
          var el = UI.$('#starcount', host);
          if (el) el.textContent = n === null ? '—' : U.num(n);
        });

        var ed = UI.$('#edit', host);
        if (ed) ed.onclick = function () {
          var url = 'https://github.com/settings/profile';
          window.NativeBridge && NativeBridge.openExternal ? NativeBridge.openExternal(url) : window.open(url, '_blank');
        };
        var fb = UI.$('#follow', host);
        if (fb) {
          if (window.Session.isLogin) {
            window.API.get('/user/following/' + login, null, { cache: 0 }).then(function () {
              UI.$('#ftxt', host).textContent = '已关注'; UI.$('#ftxt', host).dataset.on = '1';
            }).catch(function () {});
          }
          fb.onclick = function () {
            if (!window.Session.isLogin) return UI.toast('请先登录');
            var txt = UI.$('#ftxt', host);
            var following = txt.dataset.on === '1';
            var call = following ? window.API.del('/user/following/' + login) : window.API.put('/user/following/' + login, {});
            call.then(function () {
              txt.dataset.on = following ? '0' : '1';
              txt.textContent = following ? '关注' : '已关注';
              UI.toast(following ? '已取消关注' : '已关注 ' + login);
            }).catch(function (e) { UI.toast('操作失败：' + e.message); });
          };
        }
        renderUserTab(tab, u, UI.$('#ubody', host));
        window.App.setActions([{
          icon: 'kebab-horizontal', onClick: function () {
            UI.menu('操作', [
              { icon: 'link-external', label: '在浏览器打开', key: 'web' },
              { icon: 'share-android', label: '分享主页', key: 'share' },
              { icon: 'copy', label: '复制主页链接', key: 'copy' }
            ]).then(function (k) {
              var url = u.html_url;
              if (k === 'web') NativeBridge.openExternal ? NativeBridge.openExternal(url) : window.open(url, '_blank');
              if (k === 'share') NativeBridge.share ? NativeBridge.share(url, login) : UI.copy(url, '已复制');
              if (k === 'copy') UI.copy(url, '已复制');
            });
          }
        }]);
      }).catch(function (e) {
        if (epoch !== window.Router.viewEpoch) return;
        host.innerHTML = UI.errorBox(e);
      });
    }
  };

  function renderUserTab(tab, u, box) {
    var login = u.login;
    var isOrg = u.type === 'Organization';
    switch (tab) {
      /* ⚠️ 这两个接口不是一回事，混用就会「我的仓库列表里看不到私有仓库」：
       *   /users/:login/repos  —— 只看得到**公开**仓库，哪怕这个人就是你自己、
       *                          令牌也带着 repo 权限，私有的一样拿不到
       *   /user/repos          —— 看「我」的仓库，默认公开 + 私有都有
       * 所以自己看自己时走后者，并显式带上 visibility=all（不给的话，
       * 一旦以后加了 affiliation 之类的筛选条件，私有仓库又会悄悄消失）。 */
      case 'repos': {
        var mine = !!(window.Session.user && login === window.Session.user.login);
        return repoList(mine ? '/user/repos' : '/users/' + login + '/repos',
          { sort: 'pushed', direction: 'desc', per_page: 100, visibility: mine ? 'all' : undefined },
          box, login, true);
      }
      case 'stars': return isOrg ? memberList(login, box) : starList(login, box);
      case 'gists': return gistList('/users/' + login + '/gists', box);
      case 'activity': return activity(login, box);
      case 'followers': return isOrg ? memberList(login, box) : peopleList('/users/' + login + '/followers', box);
      case 'following': return peopleList('/users/' + login + '/following', box);
      case 'orgs': return isOrg ? memberList(login, box) : orgList(login, box);
      default: return overview(u, box);
    }
  }

  function overview(u, box) {
    var login = u.login;
    Promise.all([
      window.API.get('/users/' + login + '/repos', { sort: 'updated', per_page: 6 }, { cache: 60000 }).catch(function () { return { data: [] }; }),
      window.API.get('/users/' + login + '/events/public', { per_page: 15 }, { cache: 60000 }).catch(function () { return { data: [] }; })
    ]).then(function (rs) {
      var repos = rs[0].data || [], evs = rs[1].data || [];
      box.innerHTML =
        (repos.length ? '<div class="section-title">' + window.icon('repo', 14) + ' 最近更新的仓库' +
          '<button class="btn sm" style="margin-left:auto" data-tab="repos">全部</button></div>' +
          '<div class="list">' + repos.map(window.repoRow).join('') + '</div>' : '') +
        (evs.length ? '<div class="section-title">' + window.icon('rss', 14) + ' 近期动态</div>' +
          '<div class="list">' + evs.slice(0, 8).map(window.renderEvent).join('') + '</div>' : '');
      window.bindRepoCards(box); window.bindHashLinks(box);
      var all = UI.$('[data-tab]', box);
      if (all) all.onclick = function () { window.Router.go('/' + login + '?tab=repos'); };
    }).catch(function (e) { box.innerHTML = UI.errorBox(e); });
  }

  function repoList(ep, params, box, login, withFilter) {
    var isSelf = !!(window.Session.user && login === window.Session.user.login);
    var newBtn = (isSelf && withFilter) ? '<button class="btn primary sm" id="newrepo" style="flex:none">' +
      window.icon('plus', 14) + ' 新建</button>' : '';
    box.innerHTML = (withFilter ? '<div class="filterbar">' +
      UI.seg('rseg', [{ key: 'updated', label: '最近更新' }, { key: 'pushed', label: '最近推送' }, { key: 'created', label: '最新创建' }, { key: 'full_name', label: '名称' }], 'updated') +
      newBtn + '</div><div class="search-bar"><div class="search-input">' + window.icon('search', 17) +
      '<input id="rf" placeholder="筛选仓库…"></div></div>' : '') + '<div id="rl">' + UI.skeleton(4) + '</div>';
    // 记住当前选的排序：筛选用的是同一个接口，打字时不能把排序键丢掉，
    // 否则选了「名称」再敲一下关键词，列表又跳回默认的「最近更新」
    var curSort = 'updated';
    /* 各仓库的最新版本时间（fetchReleaseTimes 填进来）；
       还没填时 relMetaHtml 什么都不加，卡片照旧显示 updated_at */
    var relTimes = {};

    /**
     * 取数用的排序键。「最近更新」这一档按 pushed 取，而不是 updated：
     * updated_at 改一句描述、被人点个 Star 都会跳，跟「发没发新版」几乎不相关，
     * 用它取回来的这 100 条里大半是噪声。pushed 与发版强相关，而且没发过版的
     * 那些在兜底排序里也天然落在对的位置上。
     */
    function apiSortFor(k) { return k === 'updated' ? 'pushed' : k; }

    function paint(list, q, pending) {
      var b = UI.$('#rl', box); if (!b) return;
      /* 发布时间要挨个仓库去问，几十个请求下来要几秒。先按兜底顺序画出来，
         别让人盯着一片空白等 —— 时间补齐后再排一次、重画一次。 */
      var note = pending ? '<div class="fnote">' + window.icon('clock', 12) +
        '正在读取各仓库的最新版本时间…</div>' : '';
      b.innerHTML = note + (list.length
        /* ⚠️ 不能写成 map(window.repoRow)：map 会送三个参数（元素、下标、数组），
           下标落到 extra 上，第 2 条起就渲染出 1、2、3 */
        ? '<div class="list">' + list.map(function (r) {
          var st = relSortTime(r, relTimes);
          return window.repoRow(r, null, curSort === 'updated'
            ? { time: st ? new Date(st).toISOString() : null, meta: relMetaHtml(r, relTimes, st) }
            : null);
        }).join('') + '</div>'
        : (isSelf ? (q ? UI.empty('repo', '没有匹配的仓库', '换个关键词试试')
          : '<div class="empty">' + window.icon('repo', 36) + '<div class="t">还没有仓库</div>' +
            '<div class="d">创建第一个仓库，开始托管你的代码。</div>' +
            '<button class="btn primary mt12" id="newrepo2">' + window.icon('plus', 14) + ' 新建仓库</button></div>')
          : UI.empty('repo', '没有仓库', '')));
      /* 这一块是原地重画的，不走 Router —— 不打招呼的话翻译要等
       * MutationObserver 那一拍才发现列表换了（详见 ui.js 的 noticeRefresh）。 */
      if (window.UI) UI.noticeRefresh(b);
      window.bindRepoCards(b);
      bindNewRepo(box);
    }

    var load = function (sort, q) {
      if (sort) curSort = sort;
      var p = Object.assign({}, params);
      p.sort = apiSortFor(curSort);
      /* ⚠️ direction 不传就是 asc：GitHub 的 sort 参数默认升序，
         于是「最近更新」会变成「最久没动的排最前」——看着就是排序坏了。
         除了按名称（正序才符合直觉）之外一律要降序。 */
      p.direction = curSort === 'full_name' ? 'asc' : 'desc';
      return window.API.get(ep, p, { cache: 60000 }).then(function (r) {
        var list = r.data || [];
        if (q) list = list.filter(function (x) { return (x.full_name || '').toLowerCase().indexOf(q.toLowerCase()) >= 0 || (x.description || '').toLowerCase().indexOf(q.toLowerCase()) >= 0; });
        paint(list, q, curSort === 'updated');
        if (curSort !== 'updated' || !list.length) return;
        return fetchReleaseTimes(list.map(function (x) { return x.full_name; }), function (times) {
          relTimes = times;
          list.sort(function (a, b) { return relSortTime(b, times) - relSortTime(a, times); });
          paint(list, q, false);
        });
      });
    };
    UI.$$('#rseg button', box).forEach(function (b2) {
      b2.onclick = function () {
        UI.$$('#rseg button', box).forEach(function (x) { x.classList.remove('active'); });
        b2.classList.add('active');
        load(b2.getAttribute('data-v'), (UI.$('#rf', box) || {}).value);
      };
    });
    var rf = UI.$('#rf', box);
    if (rf) rf.oninput = U.debounce(function () { load(null, rf.value.trim()); }, 300);
    bindNewRepo(box);
    return load();
  }

  /* ============================================================
   * 「更新」= 发过新版本，而不是「仓库被人动过」
   *
   * GitHub 的 updated_at 什么都记：改一句描述、被人点个 Star、加个 topic
   * 都算「更新」。于是「最近更新」这一档里常年飘着一批根本没有新版本的仓库，
   * 真正刚发版的反而被挤到后面。对拿这个 App 看应用更新的人来说，这不是
   * 显示问题，是排序本身排错了对象。
   *
   * 所以这里给每个仓库问一次「你最新的 Release 是什么时候」：
   *   发过版   → 取 max(published_at, 资产里最新的 updated_at)
   *              （发版之后又补传 / 换过包，以包文件的时间为准）
   *   没发过版 → 退回最后一次推代码的时间（pushed_at）
   * 两者混在同一个序列里从新到旧排。
   * ============================================================ */
  var REL_TTL = 10 * 60 * 1000;   // 一份发布时间认 10 分钟
  /* 一次最多问这么多条。以前跟 /starred 的一页（100 条）对齐；现在列表会翻页
     拉全部，这里也相应放宽 —— 否则后几十条 times 里没键、只能退回 pushed_at，
     跟前一批用的不是同一把尺子，排出来就是两截拼起来的。 */
  var REL_MAX = 200;
  var REL_CONC = 8;               // 并发上限，别把接口打爆

  var REL_CACHE_KEY = 'reltimes_v1';

  function loadRelCache() {
    try { return window.Store.getJSON(REL_CACHE_KEY, {}) || {}; } catch (e) { return {}; }
  }

  /** 单个仓库的最新版本时间；没发过版 / 查不动都返回 null（调用方退回 pushed_at） */
  function fetchReleaseTime(full) {
    return window.API.get('/repos/' + full + '/releases', { per_page: 1 }, { cache: 60000 })
      .then(function (r) {
        var rel = (r.data || [])[0];
        if (!rel) return null;
        var best = Date.parse(rel.published_at || rel.created_at || '') || 0;
        var assets = rel.assets || [];
        for (var i = 0; i < assets.length; i++) {
          var a = Date.parse(assets[i].updated_at || assets[i].created_at || '') || 0;
          if (a > best) best = a;
        }
        return best || null;
      })
      .catch(function () { return null; });
  }

  /**
   * 批量取发布时间。缓存里还新鲜的直接用，没问过的并发去问，问完回调一次。
   * 缓存里存 null 也是有意义的 —— 表示「问过了，它确实没发过版」，
   * 下次不必再为它发一次请求。
   */
  function fetchReleaseTimes(fulls, onDone) {
    var cache = loadRelCache();
    var times = {};
    var missing = [];
    fulls.forEach(function (f) {
      var c = cache[f];
      if (c && Date.now() - (c.at || 0) < REL_TTL) times[f] = c.t;
      else if (missing.indexOf(f) < 0) missing.push(f);
    });
    if (!missing.length) { if (onDone) onDone(times); return Promise.resolve(times); }

    var todo = missing.slice(0, REL_MAX);
    var i = 0;
    function next() {
      if (i >= todo.length) return Promise.resolve();
      var f = todo[i++];
      return fetchReleaseTime(f).then(function (t) {
        times[f] = t;
        cache[f] = { t: t, at: Date.now() };
      }).then(next);
    }
    var runners = [];
    for (var k = 0; k < REL_CONC; k++) runners.push(next());
    return Promise.all(runners).then(function () {
      saveRelCache(cache);
      if (onDone) onDone(times);
      return times;
    });
  }

  function saveRelCache(c) {
    try { window.Store.setJSON(REL_CACHE_KEY, c); } catch (e) {}
  }

  /** 毫秒。times 里存的是数字，字段里是 ISO 串，两种都得认 */
  function msOf(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var n = Date.parse(v || '');
    return isNaN(n) ? 0 : n;
  }

  /**
   * 参与排序、并且**就显示在卡片上**的那个时间：取「最近那一次动静」。
   *
   * ⚠️ 改回去之前先看完这段 —— 这是「停留几秒后排序错乱」的根因。
   *
   * 以前的写法是「发过版就用版本时间，没发过版才退回 pushed_at」：
   *   1. 两个含义不同的时间硬混在一列里排。发过版的（版本时间常常是去年、
   *      前年）整片沉到底下，没发过版的（用 pushed_at，常常是几天前）整片
   *      浮在上面，中间那条界线上下完全接不上；
   *   2. 更糟的是卡片上那串时间是 repoRow 里写死的 updated_at —— 跟排序
   *      用的根本不是一个字段。于是从上往下扫会看到
   *      「3天前、1周前、2天前……突然跳到 150天前、120天前」；
   *   3. 发布时间还缓存 10 分钟，所以重新进页面连「刚打开是对的」这一步都没
   *      了，一进来就是乱的。
   *
   * 现在改成 排序键 = 显示的时间 = max(发布时间, 最近推代码时间)：
   *   - 必然单调：显示的那串就是排序用的那串，往下扫只会越来越旧；
   *   - 兜底一致：还没查到发布时间时就是 pushed_at，跟一进页面的顺序完全
   *     相同 —— 不会再出现「先是好的、几秒后乱掉」那种跳变；
   *   - 发版依然算数：只有当发版比最近一次推代码还新时，它才把这行往上提
   *     （发完版又补传 / 换过包的就是这种）。
   */
  function relSortTime(r, times) {
    var base = msOf(r.pushed_at) || msOf(r.updated_at);
    var rel = msOf(times && times[r.full_name]);
    return rel > base ? rel : base;
  }

  /**
   * 卡片上那串「什么时候更新」。
   *
   * 排序改按版本时间之后，显示也必须跟着换成版本时间 —— 否则排序是单调的、
   * 屏幕上那串 updated_at 却不是，看着还是「排序坏了」（值和显示对不上
   * 这个坑，这列表已经踩过一次：服务端按 pushed_at 排、卡片显示 updated_at）。
   *
   * 还没查到（times 里没这个键）就什么都不加：这时列表用的是兜底顺序，
   * 卡片上原本那串 updated_at 反而是对的。查到了但没发过版，标「无发布」。
   */
  function relMetaHtml(r, times, sortVal) {
    if (!times || !Object.prototype.hasOwnProperty.call(times, r.full_name)) return '';
    var t = times[r.full_name];
    if (!t) return '<span class="muted">' + window.icon('tag', 12) + '无发布</span>';
    /* 版本时间比最近一次推代码还老 → 不挂这个角标。这一行的位置已经由那串
       「x 天前」说明了，旁边再来一个「新版 2 年前」，看着就像顺序又乱了。 */
    if (sortVal && t < sortVal) return '';
    return '<span>' + window.icon('tag', 12) + '新版 ' + U.timeAgo(new Date(t).toISOString()) + '</span>';
  }

  /**
   * 「我的 Star」列表（议题 #3）。
   *
   * 需求原文：star 需要「我的列表」，并且能按 Star 添加时间 / 更新时间 /
   * Star 数量排序，最好还有收藏夹。
   *
   * 实现要点：
   *  - Star 时间从小到大（早 Star 的在前），最近更新从大到小（刚有动静的在前）；
   *  - Star 时间 / 最近更新两档交给服务端取数：/starred 的 sort=created 是
   *    「按 Star 时间」，sort=updated 是「按仓库最近有动静的时间」；
   *    ⚠️ /starred 没有 sort=pushed（那是 /repos 的参数），写了会被服务端忽略；
   *  - 列表会翻页拉全部（见 fetchAll / MAX_PAGES），不再只显示前 100 条；
   *  - 「Star 数」GitHub 不提供服务端排序，全部取回后在本地排；
   *  - 最近更新这一档，排序键和卡片上显示的时间必须是同一个（relSortTime），
   *    并且取 max(发布时间, pushed_at)：服务端按 pushed_at 取、卡片写死
   *    updated_at 那套，两者常常不一致，就是「26天前 排在 14天前 前面」；
   *  - 用 Accept: application/vnd.github.star+json 换取 starred_at，
   *    这样每条目能显示「Star 于 x 天前」——不加这个头拿不到 Star 时间；
   *  - 收藏夹是本地的（Store），不占用 GitHub 的 list，也不发请求。
   */
  function starList(login, box) {
    var FAV_KEY = 'fav_stars_' + login;
    var favs = window.Store.getJSON(FAV_KEY, []) || [];
    /* 默认落在「最近更新」：来这一页的人是想看「我关注的那些东西哪个出新版本了」，
       不是想回忆自己最早 star 了谁。 */
    var sortKey = 'updated';
    var onlyFav = false;
    var keyword = '';
    var raw = [];
    // raw 现在是按哪个取数键拿回来的 —— 见 loadOrderFor() 里的说明
    var loaded = null;
    /* 各仓库的最新版本时间，由 fetchReleaseTimes 填进来；
       没填之前 relSortTime 会退回 pushed_at，所以列表始终有一份可用的顺序 */
    var relTimes = {};

    /* 收藏夹里当前选中的隔层（列表）id：'' = 全部收藏 */
    var curList = '';

    box.innerHTML =
      '<div class="filterbar">' +
        UI.seg('sseg', [
          { key: 'updated', label: '最近更新' },
          { key: 'created', label: '最近 Star' },
          { key: 'count', label: 'Star 数' }
        ], 'updated') +
        UI.seg('fseg', [{ key: 'all', label: '全部' }, { key: 'fav', label: '收藏夹' }], 'all') +
      '</div>' +
      /* 收藏夹里的分类隔层：切到「收藏夹」才出现（apply 里控制显隐）。
         全部收藏 / 各列表 / ＋新建，一排横滑 chips，样式全部复用 app.css。 */
      '<div class="chips" id="fav-chips" hidden></div>' +
      '<div class="search-bar"><div class="search-input">' + window.icon('search', 17) +
        '<input id="sf" placeholder="筛选 Star 的仓库…"></div></div>' +
      '<div id="sl">' + UI.skeleton(4) + '</div>';

    function isFav(name) { return favs.indexOf(name) >= 0; }

    /**
     * 一条 Star 的两个附加件。
     *
     * ⚠️ 为什么不再塞进 repoRow 的 extra：extra 会被放进 row-main 里当**新的一行**
     * （.row-meta 是块级）。收藏按钮走那条路，等于每条下面再挂一行，
     * 整个列表每条都鼓出来一块 —— 就是「收藏单独一行太突兀」。
     *
     * 现在「Star 于 x 天前」并进主 meta 那一行（和语言 / 星数 / 更新时间同排），
     * 收藏按钮去行尾的 .row-side：竖着居中、不占整行，和其他列表长得一致。
     */
    function rowParts(r) {
      var fav = isFav(r.full_name);
      var st = relSortTime(r, relTimes);
      var byUpdate = sortKey === 'updated';
      return {
        /* 「最近更新」这一档：卡片上那串时间换成排序真正用的那个（见 relSortTime）。
           不换就会出现「排是按发布/推送时间排的，屏幕上写的是 updated_at，
           两回事」—— 也就是用户看到的「停留几秒后排序错乱」。 */
        time: (byUpdate && st) ? new Date(st).toISOString() : null,
        meta: (r.starred_at
          ? '<span>' + window.icon('star', 12) + 'Star 于 ' + U.timeAgo(r.starred_at) + '</span>'
          : '') + (byUpdate ? relMetaHtml(r, relTimes, st) : ''),
        side: '<button class="btn sm" data-fav="' + U.esc(r.full_name) + '">' +
          window.icon(fav ? 'star-fill' : 'star', 12) + (fav ? '已收藏' : '收藏') + '</button>'
      };
    }

    /** 长按条目 → 「加入列表」勾选层（官方客户端的同款手势）。
     *  点击仍走 data-go 全局委托打开仓库页，两边不打架；
     *  550ms 比默认的 500ms 稍长一点，快滚列表不容易误弹。
     *  onDone 里必须重读 favs：勾进列表 = 自动收藏（starlists.js 联动），
     *  闭包里的 favs 不跟上，星标按钮就会撒谎。 */
    function bindRowLongPress(list) {
      if (!window.StarLists) return;
      var b = UI.$('#sl', box); if (!b) return;
      UI.$$('.list .list-row', b).forEach(function (el) {
        var full = (el.getAttribute('data-go') || '').replace(/^\//, '');
        var r = null;
        for (var i = 0; i < list.length; i++) if (list[i].full_name === full) { r = list[i]; break; }
        if (r) UI.bindLongPress(el, function () {
          window.StarLists.picker(r, function () {
            favs = window.Store.getJSON(FAV_KEY, []) || [];
            apply();
          }, 550);
        });
      });
    }

    function render(list) {
      var b = UI.$('#sl', box); if (!b) return;
      if (!list.length) {
        b.innerHTML = UI.empty('star',
          onlyFav ? '收藏夹还是空的' : '还没有 Star 的仓库',
          onlyFav ? '回到「全部」，点条目上的「收藏」即可加进来；长按仓库还能给它分个类' : 'Star 过的仓库会出现在这里');
        return;
      }
      b.innerHTML = '<div class="list">' + list.map(function (r) {
        return window.repoRow(r, null, rowParts(r));
      }).join('') + '</div>';
      window.bindRepoCards(b);
      if (window.UI) UI.noticeRefresh(b);
      bindRowLongPress(list);
    }

    /** 选中某个隔层：直接画列表快照 —— 不依赖 starred 分页拉没拉全、
        也不依赖用户有没有取消 star，隔层里的仓库就该一直看得见 */
    function renderListSnap() {
      var b = UI.$('#sl', box); if (!b) return;
      var snaps = window.StarLists ? window.StarLists.reposIn(curList) : [];
      if (keyword) {
        snaps = snaps.filter(function (r) {
          return (r.full_name || '').toLowerCase().indexOf(keyword) >= 0 ||
            (r.description || '').toLowerCase().indexOf(keyword) >= 0;
        });
      }
      if (!snaps.length) {
        b.innerHTML = UI.empty('star', '这个隔层还是空的',
          '切回「全部收藏」，长按一个仓库勾进来即可');
        return;
      }
      b.innerHTML = '<div class="list">' + snaps.map(function (r) {
        return window.repoRow(r, null, rowParts(r));
      }).join('') + '</div>';
      window.bindRepoCards(b);
      if (window.UI) UI.noticeRefresh(b);
      bindRowLongPress(snaps);
    }

    /** 收藏夹顶部那排分类 chips：全部收藏 / 各列表 / ＋新建。
     *  点击切换隔层；长按列表 chip 重命名 / 删除（删除要二次确认）。 */
    function renderChips() {
      var el = UI.$('#fav-chips', box); if (!el) return;
      el.hidden = !onlyFav;
      if (!onlyFav || !window.StarLists) return;
      var lists = window.StarLists.all();
      var html = '<button class="chip' + (curList === '' ? ' active' : '') + '" data-c="">全部收藏</button>';
      html += lists.map(function (l) {
        var n = l.repos ? Object.keys(l.repos).length : 0;
        return '<button class="chip' + (curList === l.id ? ' active' : '') + '" data-c="' + U.esc(l.id) + '">' +
          U.esc(l.name) + ' ' + n + '</button>';
      }).join('');
      html += '<button class="chip" data-new="1">' + window.icon('plus', 12) + '新建</button>';
      el.innerHTML = html;
      UI.$$('.chip', el).forEach(function (c) {
        if (c.getAttribute('data-new')) {
          c.onclick = function () { window.StarLists.editor(null, function () { renderChips(); apply(); }); };
          return;
        }
        var cid = c.getAttribute('data-c') || '';
        c.onclick = function () { curList = cid; renderChips(); apply(); };
        if (!cid) return;   // 「全部收藏」没有编辑菜单
        UI.bindLongPress(c, function () {
          var l = null, all = window.StarLists.all();
          for (var i = 0; i < all.length; i++) if (all[i].id === cid) { l = all[i]; break; }
          if (!l) { curList = ''; renderChips(); apply(); return; }
          UI.menu(l.name, [
            { icon: 'pencil', label: '重命名', key: 'rename' },
            { icon: 'trash', label: '删除列表', key: 'del' }
          ]).then(function (k) {
            if (!k) return;
            if (k === 'rename') return window.StarLists.editor(l, function () { renderChips(); apply(); });
            /* 删除是危险操作，菜单里再确认一次 —— 长按容易误触 */
            UI.menu('删除「' + l.name + '」？', [
              { icon: 'trash', label: '删除（收藏与仓库本体不受影响）', key: 'yes' }
            ]).then(function (k2) {
              if (k2 !== 'yes') return;
              window.StarLists.remove(cid);
              if (curList === cid) curList = '';
              UI.toast('列表已删除');
              renderChips();
              apply();
            });
          });
        });
      });
    }

    /** 收藏夹 / 隔层 / 关键词筛选，改完重排一次即可，不用再打接口 */
    function apply() {
      renderChips();   // 每次重排都顺手刷 chips（显隐 / active / 计数最容易过期）
      if (onlyFav && curList) { renderListSnap(); return; }
      var list = raw.slice().sort(cmp());
      if (onlyFav) list = list.filter(function (r) { return isFav(r.full_name); });
      if (keyword) {
        list = list.filter(function (r) {
          return (r.full_name || '').toLowerCase().indexOf(keyword) >= 0 ||
            (r.description || '').toLowerCase().indexOf(keyword) >= 0;
        });
      }
      render(list);
    }

    /**
     * 三档排序。
     *
     * ⚠️ 字段的含义容易记反，这里写死：**created 是「这个仓库被 Star 的时间」**，
     * 不是「仓库的创建时间」。
     *
     *  - 最近更新 —— relSortTime 降序：取「最近那一次动静」，
     *    max(最新版本时间, 最近一次推代码)，从新到旧。发完版又补传过安装包的，
     *    版本时间比推代码时间新，就靠这一下把它提到前面
     *  - 最近 Star —— starred_at 降序：刚刚 Star 的排最前
     *  - Star 数   —— 星数降序：星星多的排最前
     *
     * 「最近更新」这一档为什么不用仓库自带的 updated_at：那个字段改一句描述、
     * 被人点个 Star 都会跳，用它排出来的是「谁最近被人动过」，不是「谁发新版了」。
     * 至于为什么是 max 而不是「发过版就用版本时间」：后者会让发过版的整片
     * 沉底、没发过版的整片浮上来，而且跟卡片上显示的时间对不上，
     * 看起来就是排序乱了 —— 详见 relSortTime 上面那段。
     */
    function t(v) { var n = Date.parse(v || ''); return isNaN(n) ? 0 : n; }

    function cmp() {
      if (sortKey === 'count') {
        return function (a, b) { return (b.stargazers_count || 0) - (a.stargazers_count || 0); };
      }
      if (sortKey === 'updated') {
        return function (a, b) { return relSortTime(b, relTimes) - relSortTime(a, relTimes); };
      }
      // 最近 Star：从大到小
      return function (a, b) { return t(b.starred_at) - t(a.starred_at); };
    }

    /**
     * 取数参数：/starred 的 sort / direction 都是**服务端**参数。
     *
     * ⚠️ GitHub 的 /starred **只认 created / updated 两种 sort，没有 pushed**。
     * 早先这里照着 /repos 那套写了 sort=pushed —— 但 /repos 支持 pushed，
     * /starred 不支持，服务端直接当没看见，于是「最近更新」这一档实际拿到的是
     * 默认的 created 顺序，等于一直在「最近 Star 的那批」里排，怎么排都不对。
     * 现在换成有效的 sort=updated。
     *
     *  - 最近更新 → sort=updated&direction=desc：按仓库最近有动静的时间取数。
     *    真正「发没发新版」仍由本地 relSortTime（发布时间 vs pushed_at）决定。
     *  - 最近 Star → sort=created&direction=desc，最近 Star 的排在前面
     *  - Star 数   → 服务端没有按星数排的参数，复用上面那份数据本地排
     *
     * 返回的字符串同时充当 loaded 的标识：切来切去时靠它判断要不要重新拉。
     */
    function loadOrderFor(k) {
      if (k === 'updated') return 'updated:desc';
      return 'created:desc';
    }

    function requestParams(k) {
      var parts = loadOrderFor(k).split(':');
      return { sort: parts[0], direction: parts[1] };
    }

    /* 「加载全部」的翻页上限。一页 100 条，最多 10 页（1000 条）——
       足以覆盖绝大多数账号，又不至于把接口和手机内存拖垮。 */
    var MAX_PAGES = 10;

    /**
     * 把所有 Star 翻页拉回来。
     *
     * 以前只打一次接口（per_page=100、不翻页），Star 超过 100 个就只显示前
     * 100 个 —— 这就是「星标仓库加载不完整」。现在顺着 Link 头里的 next 一页页
     * 往下取，边取边回调，用户不必等全部页回来才看到东西。
     *
     * onProgress(list, done)：list 是「到目前为止累积到的全部条目」，done 表示没有下一页了。
     */
    function fetchAll(params, onProgress) {
      var acc = [];
      function pull(page) {
        return window.API.get('/users/' + login + '/starred',
          Object.assign({ per_page: 100, page: page }, params),
          { accept: 'application/vnd.github.star+json', cache: 60000 }
        ).then(function (r) {
          // 带 star+json 时，每一项被包成 { starred_at, repo } —— 摊平后继续用
          var items = (r.data || []).map(function (x) {
            var repo = (x && x.repo) ? x.repo : x;
            if (x && x.starred_at) repo.starred_at = x.starred_at;
            return repo;
          });
          acc = acc.concat(items);
          var more = !!(r.link && r.link.next) && !!items.length && page < MAX_PAGES;
          if (onProgress) onProgress(acc, !more);
          if (more) return pull(page + 1);
          return acc;
        });
      }
      return pull(1);
    }

    /* 「最近更新」这一档要按发布时间排，得挨个仓库去问。缓存里还新鲜的直接用，
       没问过的并发去问，问完重排一次 —— 别的档位不需要这份数据，也就不必发请求。 */
    function maybeRel() {
      if (sortKey !== 'updated' || !raw.length) return Promise.resolve();
      return fetchReleaseTimes(raw.map(function (r) { return r.full_name; }), function (times) {
        relTimes = times;
        apply();
      });
    }

    function load() {
      var want = loadOrderFor(sortKey);
      // 已经有一份按同样参数取回来的数据就不必再打接口 ——
      // 「Star 时间」和「Star 数」共用一次请求，来回切换都是本地重排，秒切
      if (loaded === want) { apply(); return maybeRel(); }
      var first = !raw.length;
      var b = UI.$('#sl', box); if (b && first) b.innerHTML = UI.skeleton(4);
      // 换取数键要重新拉：先给个转圈，列表原地不动 ——
      // 否则点下去一秒钟没动静，又变成「看着像没反应」
      if (!first) UI.loading(true);
      loaded = want;
      /* 翻页过程中每拿到一页就先画一遍，别让人盯着一片空白等全部页回来。 */
      return fetchAll(requestParams(sortKey), function (list, done) {
        raw = list;
        apply();
        if (done) maybeRel();
      }).catch(function (e) {
        loaded = null;   // 失败了不算「已加载」，下次进来重新拉
        var b2 = UI.$('#sl', box); if (b2) b2.innerHTML = UI.errorBox(e);
      }).then(function () { if (!first) UI.loading(false); });
    }

    UI.$$('#sseg button', box).forEach(function (btn) {
      btn.onclick = function () {
        UI.$$('#sseg button', box).forEach(function (x) { x.classList.remove('active'); });
        btn.classList.add('active');
        sortKey = btn.getAttribute('data-v') || 'updated';
        load();
      };
    });

    UI.$$('#fseg button', box).forEach(function (btn) {
      btn.onclick = function () {
        UI.$$('#fseg button', box).forEach(function (x) { x.classList.remove('active'); });
        btn.classList.add('active');
        onlyFav = btn.getAttribute('data-v') === 'fav';
        if (raw.length) apply(); else load();
      };
    });

    // 收藏按钮在 data-go 的行内，先拦下来，否则会被全局委托当成「进入仓库」
    box.addEventListener('click', function (e) {
      var t = e.target;
      var hit = t && t.closest ? t.closest('[data-fav]') : null;
      if (!hit) return;
      e.stopPropagation();
      e.preventDefault();
      var name = hit.getAttribute('data-fav');
      var i = favs.indexOf(name);
      if (i >= 0) { favs.splice(i, 1); UI.toast('已移出收藏夹'); }
      else { favs.push(name); UI.toast('已加入收藏夹'); }
      window.Store.setJSON(FAV_KEY, favs);
      apply();
    });

    var sf = UI.$('#sf', box);
    if (sf) sf.oninput = U.debounce(function () { keyword = sf.value.trim().toLowerCase(); apply(); }, 300);

    return load();
  }

  /** 绑定「新建仓库」按钮（列表顶部 + 空态各一个） */
  function bindNewRepo(box) {
    ['#newrepo', '#newrepo2'].forEach(function (sel) {
      var b = UI.$(sel, box);
      if (b) b.onclick = function () { window.newRepo(); };
    });
  }

  function peopleList(ep, box) {
    box.innerHTML = '<div id="pl">' + UI.skeleton(4) + '</div>';
    return window.API.get(ep, { per_page: 100 }, { cache: 60000 }).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#pl', box); if (!b) return;
      b.innerHTML = list.length ? '<div class="list">' + list.map(function (u) {
        return '<button class="list-row" data-go="/' + U.esc(u.login) + '">' + UI.avatar(u.login, u.avatar_url, 40) +
          '<span class="row-main"><span class="row-title">' + U.esc(u.login) + '</span>' +
          (u.name ? '<span class="row-desc">' + U.esc(u.name) + '</span>' : '') + '</span></button>';
      }).join('') + '</div>' : UI.empty('people', '暂无用户', '');
      window.bindRepoCards(b);
    }).catch(function (e) { UI.$('#pl', box).innerHTML = UI.errorBox(e); });
  }

  function orgList(login, box) {
    box.innerHTML = '<div id="ol">' + UI.skeleton(3) + '</div>';
    return window.API.get('/users/' + login + '/orgs', { per_page: 100 }, { cache: 60000 }).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#ol', box); if (!b) return;
      b.innerHTML = list.length ? '<div class="list">' + list.map(function (o) {
        return '<button class="list-row" data-go="/' + U.esc(o.login) + '">' + UI.avatar(o.login, o.avatar_url, 40, true) +
          '<span class="row-main"><span class="row-title">' + U.esc(o.login) + '</span>' +
          (o.description ? '<span class="row-desc">' + U.esc(o.description) + '</span>' : '') + '</span></button>';
      }).join('') + '</div>' : UI.empty('organization', '没有加入的组织', '');
      window.bindRepoCards(b);
    }).catch(function (e) { UI.$('#ol', box).innerHTML = UI.errorBox(e); });
  }

  function memberList(org, box) {
    box.innerHTML = '<div id="ml">' + UI.skeleton(3) + '</div>';
    return window.API.get('/orgs/' + org + '/members', { per_page: 100 }, { cache: 60000 }).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#ml', box); if (!b) return;
      b.innerHTML = list.length ? '<div class="list">' + list.map(function (u) {
        return '<button class="list-row" data-go="/' + U.esc(u.login) + '">' + UI.avatar(u.login, u.avatar_url, 40) +
          '<span class="row-main"><span class="row-title">' + U.esc(u.login) + '</span>' +
          '<span class="row-desc">' + (u.type === 'User' ? '成员' : '机器人') + '</span></span></button>';
      }).join('') + '</div>' : UI.empty('people', '没有公开成员', '');
      window.bindRepoCards(b);
    }).catch(function (e) { UI.$('#ml', box).innerHTML = UI.errorBox(e); });
  }

  function activity(login, box) {
    box.innerHTML = '<div id="al">' + UI.skeleton(4) + '</div>';
    return window.API.get('/users/' + login + '/events/public', { per_page: 50 }, { cache: 30000 }).then(function (r) {
      var list = r.data || [];
      var b = UI.$('#al', box); if (!b) return;
      b.innerHTML = list.length ? '<div class="list">' + list.map(window.renderEvent).join('') + '</div>' : UI.empty('rss', '暂无公开动态', '');
      window.bindHashLinks(b);
    }).catch(function (e) { UI.$('#al', box).innerHTML = UI.errorBox(e); });
  }

  /* ============ Gist ============ */
  P.gists = {
    title: '我的 Gist',
    render: function (ctx, host) {
      if (!window.Session.isLogin) return window.needLogin(host);
      host.innerHTML = '<div style="padding:10px 12px">' +
        UI.seg('gseg', [{ key: 'mine', label: '我的' }, { key: 'starred', label: '已 Star' }], ctx.query.type || 'mine') +
        '</div><div id="gl">' + UI.skeleton(4) + '</div>';
      UI.$$('#gseg button', host).forEach(function (b) {
        b.onclick = function () { window.Router.go('/gists?type=' + b.getAttribute('data-v')); };
      });
      /* 切走 / 切回来都要先把 Fab 收起来：路由只在进页面那一刻清一次，
         从带 Fab 的页面切到「已 Star」列表时没人管它，会残留成可点的新建按钮 */
      document.getElementById('fab').hidden = true;
      var ep = ctx.query.type === 'starred' ? '/gists/starred' : '/gists';
      gistList(ep, UI.$('#gl', host));

      // 新建按钮只长在「我的」列表上；收藏列表里放它是给别人新建
      if (ctx.query.type !== 'starred') {
        var fab = document.getElementById('fab');
        fab.hidden = false;
        fab.innerHTML = window.icon('plus', 24);
        fab.onclick = function () { newGist(); };
      }
    }
  };

  /* ------------------------------------------------------------------
   * Gist 的写操作：新建 / 编辑 / 删除
   *
   * 一个 Gist 就是「一串文件名 → 一堆文本」的 Map，没有 Issue 那种实体：
   * 新建 POST /gists，改内容 PATCH /gists/:id，两者 body 长得一模一样。
   * 改名稍微绕一点：在新名字的对象里塞 filename 字段指向旧名字，
   * GitHub 才认得出「这是重命名」而不是「新建一个 + 留一个空的」。
   * ------------------------------------------------------------------ */
  function gistEditor(opt) {
    opt = opt || {};
    var isNew = !opt.id;
    var root = document.getElementById('sheet-root');
    var originalName = opt.filename || 'snippet.txt';

    var body =
      '<div class="field"><label>描述</label>' +
      '<input class="input" id="gd" value="' + U.esc(opt.description || '') + '" placeholder="一句话说明这段代码是干什么的"></div>' +
      '<div class="field"><label>可见性</label>' +
      UI.seg('gpseg', [{ key: '0', label: '私密' }, { key: '1', label: '公开' }], opt.public === false ? '0' : '1') +
      '<div class="hint">私密 Gist 不会出现在搜索里，但拿到链接的人依然能打开 —— 它不等于安全。</div></div>' +
      '<div class="field"><label>文件名</label>' +
      '<input class="input mono" id="gn" value="' + U.esc(originalName) + '" spellcheck="false">' +
      '<div class="hint">带扩展名才能让 GitHub 认出语言、给出高亮，例如 main.py、app.js。</div></div>' +
      '<div class="field"><label>内容</label>' +
      '<textarea class="textarea" id="gc2" style="min-height:280px" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" placeholder="把代码贴在这里">' +
      U.esc(opt.content || '') + '</textarea></div>';

    UI.sheet({
      title: isNew ? '新建 Gist' : '编辑 Gist', full: true, body: body,
      foot: '<button class="btn" data-no>取消</button>' +
        (isNew ? '' : '<button class="btn danger" data-del>删除</button>') +
        '<button class="btn primary" data-yes>' + (isNew ? '创建' : '保存') + '</button>',
      onMount: function () {
        var pub = opt.public !== false;
        UI.$$('#gpseg button', root).forEach(function (b) {
          b.onclick = function () {
            pub = b.getAttribute('data-v') === '1';
            UI.$$('#gpseg button', root).forEach(function (x) { x.classList.remove('active'); });
            b.classList.add('active');
          };
        });

        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        var db = root.querySelector('[data-del]');
        if (db) db.onclick = function () { UI.closeSheet(); deleteGist(opt.id); };

        root.querySelector('[data-yes]').onclick = function () {
          var desc = root.querySelector('#gd').value.trim();
          var name = root.querySelector('#gn').value.trim().replace(/^\/+/, '');
          var text = root.querySelector('#gc2').value;
          if (!name) return UI.toast('请填文件名');
          if (!text.trim()) return UI.toast('内容不能为空');

          var files = {};
          // 改名要靠 filename 字段指回旧名字，否则旧文件会变成空的留在那里
          if (!isNew && name !== originalName) files[originalName] = { filename: name, content: text };
          else files[name] = { content: text };

          UI.loading(true);
          var payload = { description: desc, files: files };
          // public 只在新建时有效：改一个已公开的 Gist 不会被这份请求变私密
          if (isNew) payload['public'] = pub;
          var call = isNew
            ? window.API.post('/gists', payload)
            : window.API.patch('/gists/' + opt.id, payload);
          call.then(function (r) {
            UI.loading(false);
            UI.closeSheet();
            UI.toast(isNew ? 'Gist 已创建' : '已保存');
            if (isNew) {
              var g = r && r.data;
              if (g && g.id) window.Router.go('/gist/' + g.id);
              else window.Router.reload();
            } else window.Router.reload();
          }).catch(function (e) {
            UI.loading(false);
            UI.toast((isNew ? '创建失败：' : '保存失败：') + (e.status === 422 ? '内容不合法，请检查文件名' : e.message));
          });
        };
      }
    });
  }

  function newGist() {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    gistEditor({});
  }

  /** 从单篇 Gist 详情进入编辑；只有单个文件时才好套进编辑器，多文件的 Gist 走网页端 */
  function editGist(g) {
    var files = g.files || {};
    var names = Object.keys(files);
    if (!names.length) return UI.toast('这个 Gist 没有文件');
    if (names.length > 1) {
      return UI.confirm('多文件 Gist',
        '这个 Gist 里有 ' + names.length + ' 个文件（' + names.join('、') + '）。\n\n' +
        'App 里的编辑器一次改一个文件，多文件的编辑建议在网页端进行。要编辑第一个文件 ' + names[0] + ' 吗？',
        '编辑 ' + names[0]).then(function (ok) {
        if (ok) gistEditor({ id: g.id, filename: names[0], content: files[names[0]].content, description: g.description, public: g.public });
      });
    }
    gistEditor({ id: g.id, filename: names[0], content: files[names[0]].content, description: g.description, public: g.public });
  }

  function deleteGist(id) {
    UI.confirm('删除 Gist？', '连同其中的所有文件和 Fork 关系一起删掉，无法恢复。', '删除', true)
      .then(function (ok) {
        if (!ok) return;
        UI.loading(true);
        window.API.del('/gists/' + id).then(function () {
          UI.loading(false); UI.toast('已删除');
          window.Router.go('/gists');
          window.Router.reload();
        }).catch(function (e) {
          UI.loading(false);
          UI.toast('删除失败：' + (e.status === 403 ? '这个 Gist 不属于你' : e.message));
        });
      });
  }

  window.newGist = newGist;

  function gistList(ep, box) {
    box.innerHTML = UI.skeleton(4);
    return window.API.get(ep, { per_page: 100 }, { cache: 30000 }).then(function (r) {
      var list = r.data || [];
      box.innerHTML = list.length ? '<div class="list">' + list.map(function (g) {
        var files = Object.keys(g.files || {});
        return '<button class="list-row" data-go="/gist/' + U.esc(g.id) + '">' + UI.avatar(g.owner ? g.owner.login : 'ghost', g.owner ? g.owner.avatar_url : '', 32) +
          '<span class="row-main"><span class="row-title mono tiny">' + U.esc(files[0] || '(空)') + '</span>' +
          '<span class="row-desc">' + U.esc(g.description || (files.length > 1 ? files.length + ' 个文件' : '无描述')) + '</span>' +
          '<span class="row-meta"><span>' + window.icon('comment', 12) + g.comments + '</span>' +
          (g.public ? '<span class="chip">公开</span>' : '<span class="chip">私密</span>') +
          '<span>' + U.timeAgo(g.updated_at) + '</span></span></span></button>';
      }).join('') + '</div>' : UI.empty('code-square', '暂无 Gist', '');
      window.bindRepoCards(box);
    }).catch(function (e) { box.innerHTML = UI.errorBox(e); });
  }

  P.gist = {
    title: 'Gist',
    render: function (ctx, host) {
      host.innerHTML = '<div class="card flat" style="border:0">' + UI.skeleton(4) + '</div>';
      // 渲染纪元：响应比返回键慢时页面已换人，整份丢弃（见 Router.render 注释）
      var epoch = window.Router.viewEpoch;
      return window.API.get('/gists/' + ctx.id, null, { cache: 30000 }).then(function (r) {
        if (epoch !== window.Router.viewEpoch) return;
        var g = r.data;
        if (!g || typeof g !== 'object') {
          host.innerHTML = UI.errorBox(new Error('Gist 内容读取失败'));
          return;
        }
        var files = g.files || {};
        var names = Object.keys(files);
        host.innerHTML =
          '<div class="detail-head">' +
          '<div class="detail-title" style="font-size:17px">' + U.esc(g.description || names[0] || 'Gist') + '</div>' +
          '<div class="detail-sub">' + (g.owner ? UI.avatar(g.owner.login, g.owner.avatar_url, 20) + '<a href="#/' + U.esc(g.owner.login) + '">' + U.esc(g.owner.login) + '</a>' : '<span>匿名</span>') +
          '<span>' + U.timeAgo(g.updated_at) + '</span><span class="chip">' + (g.public ? '公开' : '私密') + '</span></div></div>' +
          names.map(function (n) {
            var f = files[n];
            return '<div class="section-title" style="padding-top:12px">' + window.icon('file-code', 14) + ' ' + U.esc(n) +
              '<button class="btn sm" style="margin-left:auto" data-copy="' + U.esc(n) + '">复制</button></div>' +
              '<div class="code-wrap"><pre style="font-size:' + (window.Store.get('codeFont') || 13) + 'px" id="f-' + U.esc(n) + '"></pre></div>';
          }).join('') +
          (g.comments ? '<div class="section-title">' + window.icon('comment', 14) + ' 评论（' + g.comments + '）</div><div id="gc"><div class="spinner"></div></div>' : '');

        names.forEach(function (n) {
          var f = files[n];
          // CSS.escape 个别老 WebView 上没有：缺它整页渲染会挂，这里给个字面量兜底
          var sel = '#f-' + ((window.CSS && window.CSS.escape) ? window.CSS.escape(n) : String(n).replace(/["\\]/g, '\\$&'));
          var pre = UI.$(sel, host) || UI.$$('pre', host)[names.indexOf(n)];
          if (pre) {
            try {
              pre.innerHTML = (window.hljs ? hljs.highlightAuto(f.content || '', [f.language ? f.language.toLowerCase() : '']).value : U.esc(f.content));
            } catch (e) { pre.textContent = f.content; }
          }
        });
        UI.$$('[data-copy]', host).forEach(function (b) {
          b.onclick = function () { UI.copy(files[b.getAttribute('data-copy')].content || '', '已复制'); };
        });
        if (g.comments) {
          window.API.get('/gists/' + ctx.id + '/comments', { per_page: 100 }).then(function (cr) {
            var box = UI.$('#gc', host); if (!box) return;
            var cs = cr.data || [];
            box.innerHTML = cs.length ? '<div class="list">' + cs.map(function (c) {
              return '<div class="comment">' + UI.avatar(c.user.login, c.user.avatar_url, 32) +
                '<div class="bubble"><div class="bubble-head"><b>' + U.esc(c.user.login) + '</b><span class="muted">' + U.timeAgo(c.created_at) + '</span></div>' +
                '<div class="bubble-body md"></div></div></div>';
            }).join('') + '</div>' : '';
            var bodies = UI.$$('.bubble-body', box);
            cs.forEach(function (c, i) { if (bodies[i]) window.MD.mount(bodies[i], c.body || ''); });
          }).catch(function () { var x = UI.$('#gc', host); if (x) x.innerHTML = ''; });
        }
        window.App.setActions([{
          icon: 'kebab-horizontal', onClick: function () {
            // 别人的 Gist 编辑删掉那两项：接口会拒，摆着等于骗人
            var mine = !!(window.Session.user && g.owner && g.owner.login === window.Session.user.login);
            var items = [];
            if (mine) {
              items.push({ icon: 'pencil', label: '编辑', key: 'edit' });
              items.push({ icon: 'trash', label: '删除', key: 'del' });
              items.push('-');
            }
            items = items.concat([
              { icon: 'star', label: 'Star', key: 'star' },
              { icon: 'copy', label: '克隆地址', key: 'clone' },
              { icon: 'link-external', label: '在浏览器打开', key: 'web' },
              { icon: 'share-android', label: '分享', key: 'share' }
            ]);
            UI.menu('操作', items).then(function (k) {
              if (k === 'edit') return editGist(g);
              if (k === 'del') return deleteGist(ctx.id);
              if (k === 'star') window.API.put('/gists/' + ctx.id + '/star', {}).then(function () { UI.toast('已 Star'); }).catch(function (e) { UI.toast('已 Star 或失败'); });
              if (k === 'web') NativeBridge.openExternal ? NativeBridge.openExternal(g.html_url) : window.open(g.html_url, '_blank');
              if (k === 'share') NativeBridge.share ? NativeBridge.share(g.html_url, g.description || 'Gist') : UI.copy(g.html_url);
              if (k === 'clone') UI.copy(g.git_pull_url, '已复制');
            });
          }
        }]);
      }).catch(function (e) {
        if (epoch !== window.Router.viewEpoch) return;
        host.innerHTML = UI.errorBox(e);
      });
    }
  };

  /* ============ 我的 ============ */
  P.profile = {
    tab: 'profile',
    title: '我的',
    menu: function () { return [{ icon: 'gear', label: '设置', key: 'settings' }]; },
    onMenu: function () { window.Router.go('/settings'); },
    render: function (ctx, host) {
      if (!window.Session.isLogin) {
        /* 未登录时也要能进两步验证器 —— 它不依赖 GitHub，
           密钥存在本机、算法也在本机，登录与否跟它没关系。 */
        host.innerHTML = '<div class="page"><div class="card" style="padding:20px;text-align:center">' +
          '<div class="muted mb12">登录后查看你的仓库、Star 与动态</div>' +
          '<button class="btn primary block" id="lg">登录 GitHub</button></div>' +
          '<div class="section"></div>' +
          '<div class="set-group">' +
            setRow('shield-check', '两步验证器', '/totp') +
          '</div>' +
          '<div class="section"></div>' +
          '<div class="set-group"><button class="set-row" id="st">' + window.icon('gear', 16) + '<span class="k">应用设置</span>' + window.icon('chevron-right', 16) + '</button></div></div>';
        UI.$('#lg', host).onclick = function () { window.Router.go('/login'); };
        UI.$('#st', host).onclick = function () { window.Router.go('/settings'); };
        return;
      }
      var me = window.Session.user;
      var paint = function (u) {
      host.innerHTML =
        '<div class="profile-head">' +
        '<div class="profile-top">' + UI.avatar(u.login, u.avatar_url, 64) +
        '<div class="grow"><div class="profile-name">' + U.esc(u.name || u.login) + '</div>' +
        '<div class="profile-login">@' + U.esc(u.login) + '</div></div>' +
        '</div>' +
        (u.bio ? '<div class="profile-bio">' + U.esc(u.bio) + '</div>' : '') +
        '<div class="stat-row">' +
        '<a href="#/' + U.esc(u.login) + '?tab=repos"><b>' + U.num(u.public_repos) + '</b>仓库</a>' +
        '<a href="#/' + U.esc(u.login) + '?tab=followers"><b>' + U.num(u.followers) + '</b>粉丝</a>' +
        '<a href="#/' + U.esc(u.login) + '?tab=following"><b>' + U.num(u.following) + '</b>关注</a>' +
        '<a href="#/' + U.esc(u.login) + '?tab=stars"><b id="starcount">—</b>Star</a>' +
        '<a href="#/gists"><b>' + U.num(u.public_gists || 0) + '</b>Gist</a>' +
        '</div></div>' +
        '<div class="section"></div>' +
        '<div class="set-group">' +
        '<button class="set-row" id="editprofile"><span class="ico">' + window.icon('pencil', 16) + '</span>' +
        '<span class="k">编辑资料</span><span class="v">' + (u.name ? '' : '未设置') + '</span>' + window.icon('chevron-right', 16) + '</button>' +
        '<button class="set-row" id="editavatar"><span class="ico">' + window.icon('person', 16) + '</span>' +
        '<span class="k">更换头像</span><span class="v">需网页端</span>' + window.icon('link-external', 16) + '</button>' +
        '<button class="set-row" id="newrepo"><span class="ico">' + window.icon('plus', 16) + '</span>' +
        '<span class="k">新建仓库</span><span class="v">' + window.icon('chevron-right', 16) + '</span></button>' +
        '</div>' +
        '<div class="section"></div>' +
        '<div class="set-group">' +
          setRow('shield-check', '两步验证器', '/totp') +
          setRow('repo', '我的仓库', '/' + u.login + '?tab=repos') +
          setRow('star', '我的 Star', '/' + u.login + '?tab=stars') +
          setRow('issue-opened', '我的议题', '/issues/mine') +
          setRow('git-pull-request', '我的拉取请求', '/pulls/mine') +
          setRow('code-square', '我的 Gist', '/gists') +
          setRow('organization', '我的组织', '/' + u.login + '?tab=orgs') +
          setRow('bell', '通知', '/notifications') +
        '</div>' +
        '<div class="section"></div>' +
        '<div class="set-group">' +
          setRow('gear', '设置', '/settings') +
          setRow('graph', 'API 配额', '/settings?tab=quota') +
        '</div>';
        // data-go 由 app.js 全局委托处理
        starCount(u.login).then(function (n) {
          var el = UI.$('#starcount', host);
          if (el) el.textContent = n === null ? '—' : U.num(n);
        });
        var ep = UI.$('#editprofile', host);
        if (ep) ep.onclick = function () { editProfile(u, paint); };
        var nr = UI.$('#newrepo', host);
        if (nr) nr.onclick = function () { window.newRepo(); };
        var ea = UI.$('#editavatar', host);
        if (ea) ea.onclick = function () {
          UI.confirm('更换头像',
            'GitHub 未开放头像上传接口，需要在网页端操作。将用应用内浏览器打开，登录态可复用。',
            '打开上传页').then(function (ok) {
            if (!ok) return;
            var url = 'https://github.com/settings/profile';
            if (window.openWeb) window.openWeb(url, '更换头像');
            else if (window.NativeBridge && NativeBridge.openExternal) NativeBridge.openExternal(url);
            else window.open(url, '_blank');
          });
        };
      };
      if (me) { paint(me); }
      /*
       * 注意这里必须判空 —— 这就是「我的」页弹
       * "Cannot read properties of null (reading 'login')" 的地方。
       *
       * paint() 第一件事就是读 u.login。以前不管 r.data 是什么都往里塞，
       * 网络层一旦把响应体弄丢（r.data 为 null），paint(null) 当场抛异常。
       * 现在：拿到用户对象才刷新；拿不到就保留已缓存的 me，
       * 连 me 都没有才显示错误 —— 无论如何不让 null 流进 paint。
       */
      // 渲染纪元：me() 回来时页面可能已被切走（登录后跳转、按返回…），
      // 那就整份丢弃 —— paint 会把整个 #view 重写成「我的」页
      // （见 Router.render 里 viewEpoch 的注释）。
      var epoch = window.Router.viewEpoch;
      return window.API.me().then(function (r) {
        if (epoch !== window.Router.viewEpoch) return;
        var u = r && r.data;
        if (u && typeof u === 'object') {
          window.Session.user = u;
          paint(u);
        } else if (!me) {
          host.innerHTML = UI.errorBox(new Error('用户信息读取失败'));
        }
      }).catch(function (e) {
        if (epoch !== window.Router.viewEpoch) return;
        if (!me) host.innerHTML = UI.errorBox(e);
      });
    }
  };

  /* 统计某用户的 Star 总数。
     GitHub 的 /users/{login} 不含 star 计数；/starred 的 Link 响应头会给出尾页页码。
     这里按尾页反推总数：尾页满 100 则直接 *100，否则需要再取一次尾页。
     失败返回 null（界面显示 —）。 */
  function starCount(login) {
    return window.API.get('/users/' + login + '/starred', { per_page: 100, page: 1 }, { cache: 300000 })
      .then(function (r) {
        var first = (r.data || []).length;
        var lastUrl = r.link && r.link.last;
        if (!lastUrl) return first;             // 只有一页
        var m = String(lastUrl).match(/[?&]page=(\d+)/);
        if (!m) return first;
        var lastPage = +m[1];
        if (lastPage <= 1) return first;
        // 取尾页拿到最后一页的条目数，得出精确总数
        return window.API.get('/users/' + login + '/starred', { per_page: 100, page: lastPage }, { cache: 300000 })
          .then(function (r2) { return (lastPage - 1) * 100 + ((r2.data || []).length); })
          .catch(function () { return (lastPage - 1) * 100; });
      })
      .catch(function () { return null; });
  }

  function setRow(icon, label, path) {    return '<button class="set-row" data-p="' + U.esc(path) + '"><span class="ico">' + window.icon(icon, 16) + '</span>' +
      '<span class="k">' + U.esc(label) + '</span>' + window.icon('chevron-right', 16) + '</button>';
  }

  /* ---- 编辑资料：通过 PATCH /user 修改昵称、简介、公司、地区、博客 ---- */
  function editProfile(u, repaint) {
    // 社交账号：GitHub 存 [{provider, url}]，常见 provider 见下
    var social = {};
    (u.social_accounts || []).forEach(function (s) {
      if (s && s.provider) social[s.provider] = s.url || '';
    });
    var PROVIDERS = [
      { k: 'twitter', label: 'X / Twitter', ph: 'https://x.com/用户名' },
      { k: 'mastodon', label: 'Mastodon', ph: 'https://mastodon.social/@用户名' },
      { k: 'linkedin', label: 'LinkedIn', ph: 'https://linkedin.com/in/用户名' },
      { k: 'zhihu', label: '知乎', ph: 'https://zhihu.com/people/用户名' },
      { k: 'bilibili', label: '哔哩哔哩', ph: 'https://space.bilibili.com/UID' }
    ];

    var body =
      /* 头像：展示 + 跳网页端修改 */
      '<div class="rowflex" style="gap:12px;align-items:center;margin-bottom:14px">' +
      UI.avatar(u.login, u.avatar_url, 56) +
      '<span class="grow"><b>头像</b>' +
      '<div class="tiny muted" style="margin-top:4px">GitHub 未开放头像上传接口，需在网页端修改。</div></span>' +
      '<button class="btn sm" style="flex:none" id="ep_avatar">去修改</button></div>' +

      '<div class="form-row"><label>昵称</label><input class="input" id="ep_name" value="' + U.esc(u.name || '') + '" placeholder="显示名称"></div>' +
      '<div class="form-row"><label>简介</label><textarea class="input" id="ep_bio" rows="3" placeholder="一句话介绍自己">' + U.esc(u.bio || '') + '</textarea></div>' +
      '<div class="form-row"><label>公司</label><input class="input" id="ep_company" value="' + U.esc(u.company || '') + '" placeholder="@company"></div>' +
      '<div class="form-row"><label>地区</label><input class="input" id="ep_location" value="' + U.esc(u.location || '') + '" placeholder="城市"></div>' +
      '<div class="form-row"><label>博客</label><input class="input" id="ep_blog" value="' + U.esc(u.blog || '') + '" placeholder="https://"></div>' +

      '<div class="set-group-title" style="padding-left:0">社交账号</div>' +
      PROVIDERS.map(function (p) {
        return '<div class="form-row"><label>' + U.esc(p.label) + '</label>' +
          '<input class="input" id="ep_soc_' + p.k + '" value="' + U.esc(social[p.k] || '') + '" placeholder="' + U.esc(p.ph) + '"></div>';
      }).join('') +

      '<div class="set-group-title" style="padding-left:0">其他</div>' +
      '<label class="rowflex" style="gap:10px;padding:10px 0">' +
      '<input type="checkbox" id="ep_hire" style="width:16px;height:16px"' + (u.hireable ? ' checked' : '') + '>' +
      '<span>愿意接受工作机会（显示「可雇佣」标记）</span></label>' +
      '<label class="rowflex" style="gap:10px;padding:10px 0">' +
      '<input type="checkbox" id="ep_emailvis" style="width:16px;height:16px"' + (u.email ? ' checked' : '') + '>' +
      '<span>公开显示邮箱' + (u.email ? '：' + U.esc(u.email) : '（未设置）') + '</span></label>' +

      '<div class="set-note">头像与用户名暂不支持在应用内修改，GitHub 未开放对应接口。</div>';

    UI.sheet({
      title: '编辑资料',
      icon: 'pencil',
      full: true,
      body: body,
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>保存</button>',
      onMount: function (b, close) {
        var root = document.getElementById('sheet-root');
        var get = function (id) { var el = root.querySelector('#' + id); return el ? el.value : ''; };
        var chk = function (id) { var el = root.querySelector('#' + id); return !!(el && el.checked); };

        var av = root.querySelector('#ep_avatar');
        if (av) av.onclick = function () {
          var url = 'https://github.com/settings/profile';
          if (window.openWeb) window.openWeb(url, '更换头像');
          else if (window.NativeBridge && NativeBridge.openExternal) NativeBridge.openExternal(url);
          else window.open(url, '_blank');
        };

        root.querySelector('[data-no]').onclick = function () { close(); };
        root.querySelector('[data-yes]').onclick = function () {
          // 社交账号：只提交填了内容的项
          var accounts = [];
          PROVIDERS.forEach(function (p) {
            var v = get('ep_soc_' + p.k).trim();
            if (v) accounts.push({ provider: p.k, url: v });
          });
          var payload = {
            name: get('ep_name').trim() || null,
            bio: get('ep_bio').trim() || null,
            company: get('ep_company').trim() || null,
            location: get('ep_location').trim() || null,
            blog: get('ep_blog').trim() || null,
            hireable: chk('ep_hire'),
            social_accounts: accounts
          };
          // 邮箱：留空表示不公开
          var keepEmail = chk('ep_emailvis');
          if (!keepEmail && u.email) payload.email = '';
          else if (keepEmail && u.email) payload.email = u.email;

          close();
          UI.loading(true);
          window.API.patch('/user', payload).then(function (r) {
            UI.loading(false);
            // 响应体丢了不能覆盖已有的用户对象：保存其实已经成功了，
            // 拿 null 去 repaint 只会让页面崩掉，反而看不到「已更新」
            var u2 = r && r.data;
            if (u2 && typeof u2 === 'object') {
              window.Session.user = u2;
              repaint(u2);
            }
            window.App.clearPageCache();
            UI.toast('资料已更新');
          }).catch(function (e) {
            UI.loading(false);
            UI.toast(e.status === 404 || e.status === 403
              ? '令牌权限不足，需要 user 权限才能修改资料'
              : '保存失败：' + e.message);
          });
        };
      }
    });
  }

  /* ============ 设置 ============ */
  P.settings = {
    title: '设置',
    render: function (ctx, host) {
      var s = window.Store.settings || window.Store.load();
      var ver = 'v' + appVer();
      var themeText = { auto: '跟随系统', light: '浅色', dark: '深色' }[s.theme];
      host.innerHTML =
        '<div class="set-group">' +
        setItem('paintbrush', '主题外观', themeText, 'theme') +
        /*
          「iOS风格」开关。用 set-switch 那种开关样式而不是点进去选 ——
          它是个二选一的开/关，弹一层选择反而多一步。
          名字用「iOS风格」：设置是写给用户看的，得用用户自己的叫法，而不是我们内部的术语。
        */
        switchItem('package', 'iOS风格',
          window.App.navGlass() ? '开启：底栏是悬浮的磨砂胶囊' : '关闭：底栏是贴底的朴素样式',
          'glass') +
        setItem('typography', '代码字号', (s.codeFont || 13) + 'px', 'font') +
        setItem('home', '启动页', { home: '首页', notifications: '通知', explore: '探索', profile: '我的' }[s.startTab], 'start') +
        '</div>' +
        /*
          这里原本挂着一段 .set-note，写的是「启动页决定应用打开时默认显示的标签页。
          iOS风格关掉后会回到朴素的贴底样式，适合在玻璃效果卡顿的机型上使用。」
          按用户要求删掉了 —— 这两句只是把上面两行的字面意思又说了一遍，
          反而让设置页变成一大片灰字。iOS风格 / 启动页 这两项本身已经有开关状态
          和当前取值写着（「开启：底栏是悬浮的磨砂胶囊」/「首页」），看得懂就不用注。
        */
        /*
          这里原本还有一行「后台显示动态码」开关，下面跟着一段 .totp-set-note 说明。
          按用户要求整块删掉了 —— 动态码上线通知栏本来就是加两步验证器时
          一起做的事，不该让用户再去设置里找个开关打开它。

          现在的行为（代码里已无开关可查）：
            · 默认就是开启的（TotpService.isEnabled 的默认值已改为 true）
            · 有账户时才挂通知；一个账户都没有的时候不占通知栏
            · 回到 App 前台自动收起，退到后台再挂出来
        */
        '<div class="section"></div>' +
        '<div class="set-group">' +
        setItem('shield-check', '两步验证器', totpCountText(), 'totp') +
        '</div>' +
        '<div class="section"></div>' +
        '<div class="set-group">' +
        setItem('book', '新手指导', (window.Onboarding && window.Onboarding.isDone()) ? '已完成' : '未开始', 'guide') +
        setItem('history', '重置新手引导', (window.Onboarding && window.Onboarding.isDone()) ? '可重置' : '已是初始状态', 'guideReset') +
        '</div>' +
        /*
          这里原本挂着一大段 .set-note，写的是「十步带你认全顶栏、底栏、搜索、探索和
          设置里的关键开关。看完或跳过之后不会再自动弹出：新手指导是现在立刻再看一遍，
          重置新手引导是抹掉「已看过」的记录，下次打开 App 时自动重播。」
          按用户要求删掉了。

          说明性正文挪走之后，这两行的区别靠**行尾的取值**就能看出来：
            新手指导     已完成 / 未开始     —— 描述「看没看过」的状态
            重置新手引导  可重置 / 已是初始状态 —— 描述「还能不能重置」的操作空间
          「新手指导」点下去是立刻重播（引导会真跑起来，本身就是最好的说明），
          「重置新手引导」点下去只清记录，toast 会说明下次打开自动播。
        */
        '<div class="section"></div>' +
        '<div class="set-group">' +
        setItem('graph', 'API 配额', '', 'quota') +
        setItem('trash', '清除缓存', '', 'cache') +
        '</div>' +
        '<div class="section"></div>' +
        '<div class="set-group">' +
        setItem('sync', '检查更新', ver, 'update') +
        setItem('info', '关于 githup', ver, 'about') +
        '</div>' +
        '<div class="set-note">第一位版本号变化时必须安装新版本才能继续使用，后两位可以选择是否更新。</div>' +
        '<div class="section"></div>' +
        (window.Session.isLogin ?
          '<div class="set-group"><button class="set-row danger" id="logout"><span class="ico">' + window.icon('sign-out', 16) + '</span><span class="k">退出登录</span></button></div>' +
          '<div class="set-note">退出后本机会删除保存的访问令牌。</div>' :
          '<div class="set-group"><button class="set-row" id="login"><span class="ico">' + window.icon('key', 16) + '</span><span class="k">登录 GitHub</span></button></div><div class="set-note">登录后可解锁通知、评论、Star 等完整能力。</div>');

      UI.$$('[data-s]', host).forEach(function (b) {
        b.onclick = function () {
          var k = b.getAttribute('data-s');
          if (k === 'theme') UI.choose('主题外观', [
            { key: 'auto', label: '跟随系统', icon: 'device-desktop' },
            { key: 'light', label: '浅色', icon: 'sun' },
            { key: 'dark', label: '深色', icon: 'moon' }
          ], s.theme, function (v) { window.Store.set('theme', v); window.App.applyTheme(); window.Router.reload(); });
          if (k === 'glass') {
            var on = !window.App.navGlass();
            window.App.setNavGlass(on);
            UI.toast(on ? '已开启 iOS风格' : '已关闭，底栏恢复朴素样式');
            window.Router.reload();
            return;
          }
          if (k === 'font') UI.choose('代码字号', [
            { key: '12', label: '小（12px）', icon: 'typography' },
            { key: '13', label: '标准（13px）', icon: 'typography' },
            { key: '15', label: '大（15px）', icon: 'typography' },
            { key: '17', label: '特大（17px）', icon: 'typography' }
          ], String(s.codeFont), function (v) { window.Store.set('codeFont', +v); UI.toast('已调整'); window.Router.reload(); });
          /* 重新看一遍新手引导。restart() 会先把「已看过」的状态清掉，
             这样引导中途退出、下次打开也不会被当成「已看过」而不弹。*/
          if (k === 'guide') return window.Onboarding ? window.Onboarding.restart() : UI.toast('当前版本不支持');
          /* 重置：只抹记录，不立刻播。抹完把本行刷成「已是初始状态」，
             用户能当场确认生效 —— 否则点一下什么都没变，会以为坏了。 */
          if (k === 'guideReset') {
            if (!window.Onboarding) return UI.toast('当前版本不支持');
            if (!window.Onboarding.isDone()) return UI.toast('已经是初始状态，下次打开会自动播放');
            window.Onboarding.reset();
            UI.toast('已重置，下次打开 App 会自动重新播放引导');
            window.Router.reload();
            return;
          }
          if (k === 'start') UI.choose('启动页', [
            { key: 'home', label: '首页', icon: 'home' },
            { key: 'notifications', label: '通知', icon: 'bell' },
            { key: 'explore', label: '探索', icon: 'telescope' },
            { key: 'profile', label: '我的', icon: 'person' }
          ], s.startTab, function (v) { window.Store.set('startTab', v); window.Router.reload(); });
          if (k === 'quota') return quota(host);
          if (k === 'totp') return window.Router.go('/totp');
          if (k === 'cache') {
            window.API.clearCache(); window.App.clearPageCache();
            try { if (window.NativeBridge && NativeBridge.clearCache) NativeBridge.clearCache(); } catch (e) {}
            UI.toast('缓存已清除');
          }
          if (k === 'update') return window.Updater ? window.Updater.manualCheck() : UI.toast('当前版本不支持在线检查');
          if (k === 'about') return about();
        };
      });
      var lg = UI.$('#logout', host);
      if (lg) lg.onclick = function () {
        UI.confirm('退出登录', '退出后将回到未登录状态。本机保存的令牌会保留，下次可在登录页一键登录。', '退出', true).then(function (ok) {
          if (!ok) return;
          window.Session.clear(); window.App.clearPageCache(); window.App.updateBadge();
          UI.toast('已退出，令牌已保留');
          window.Router.replace('/login');
        });
      };
      var li = UI.$('#login', host);
      if (li) li.onclick = function () { window.Router.go('/login'); };
    }
  };

  function setItem(icon, label, value, key) {
    return '<button class="set-row" data-s="' + key + '"><span class="ico">' + window.icon(icon, 16) + '</span>' +
      '<span class="k">' + U.esc(label) + '</span>' +
      (value ? '<span class="v">' + U.esc(value) + '</span>' : '') + window.icon('chevron-right', 16) + '</button>';
  }

  /**
   * 开关样式的设置行（右侧是一枚会滑动的开关，不是箭头）。
   *
   * 和 setItem 分开：setItem 点下去要弹一层选，这个点下去直接翻 ——
   * 二选一的东西弹层是多一步。data-s 仍走同一套事件绑定，多带一个 data-on。
   */
  function switchItem(icon, label, note, key, onOverride) {
    /* onOverride 给了就用它，没给就按「iOS风格」的开关算。
       两步验证的后台通知用的是另一个开关状态，不能跟玻璃混在一起。 */
    var on = (onOverride === undefined) ? window.App.navGlass() : !!onOverride;
    return '<button class="set-row" data-s="' + key + '" data-on="' + (on ? '1' : '0') + '">' +
      '<span class="ico">' + window.icon(icon, 16) + '</span>' +
      '<span class="k">' + U.esc(label) +
      (note ? '<span class="set-sub">' + U.esc(note) + '</span>' : '') + '</span>' +
      '<span class="switch' + (on ? ' on' : '') + '"><span class="knob"></span></span></button>';
  }

  /* ---------- 两步验证器在设置页里的两个辅助 ---------- */

  /** 已保存的账户数，显示在设置页那一行的右侧 */
  function totpCountText() {
    try {
      var raw = window.Store.get('totp_accounts');
      var arr = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
      if (!Array.isArray(arr) || !arr.length) return '未添加';
      return arr.length + ' 个账户';
    } catch (e) { return '未添加'; }
  }

  /*
    这里原本还有 totpBgOn() / totpBgHint() / toggleTotpBg() 三个函数，供设置页那行
    「后台显示动态码」开关使用。开关整块删掉之后它们没有调用方了，一并清掉。

    后台通知现在由原生侧自己管：TotpService 默认开启，有账户才挂通知，
    回到 App 前台自动收起。前端不需要再读/写这个状态，也就不需要
    NativeBridge.totpBackgroundEnabled / totpSetBackground 这两个接口了
    （原生侧的实现留着，不影响 —— 日后再要开关时不用重写）。
  */

  function quota(host) {
    window.API.rateLimit().then(function (r) {
      var d = r.data && r.data.rate;
      if (!d) return UI.toast('无法获取配额');
      UI.sheet({
        title: 'API 配额',
        body: '<div class="card" style="padding:14px">' +
          '<div class="rowflex" style="justify-content:space-between"><span>核心接口</span><b>' + d.remaining + ' / ' + d.limit + '</b></div>' +
          '<div class="skel" style="height:6px;margin:10px 0;border-radius:3px;position:relative;overflow:hidden">' +
          '<span style="position:absolute;left:0;top:0;bottom:0;width:' + (d.remaining / d.limit * 100) + '%;background:var(--success)"></span></div>' +
          '<div class="tiny muted">重置时间：' + new Date(d.reset * 1000).toLocaleString() + '</div>' +
          '</div>' +
          '<div class="muted tiny" style="padding:0 4px">未登录时每小时 60 次；登录后提升至每小时 5000 次。搜索接口另有独立配额。</div>'
      });
    });
  }

  /** 当前版本号，统一走这条：原生桥优先，取不到再退回内置常量，绝不返回空 */
  function appVer() {
    var v = '';
    try {
      if (window.NativeBridge && typeof window.NativeBridge.appVersion === 'function') {
        v = String(window.NativeBridge.appVersion() || '');
      }
    } catch (e) {}
    if (!v) {
      try { if (window.Native && window.Native.appVersion) v = String(window.Native.appVersion() || ''); } catch (e) {}
    }
    if (!v) { try { v = String(window.API.appVersion() || ''); } catch (e) {} }
    return v.replace(/^v/i, '') || '1.1.2';
  }

  /**
   * 本机安装包的签名证书指纹（前 16 位），拿不到就返回空。
   * 走原生层读 —— 那是系统给的安装包签名，比在 JS 里猜靠谱。
   * 读不到宁可不显示，也不编一个假的出来。
   */
  function certShort() {
    try {
      if (window.NativeBridge && typeof window.NativeBridge.certSha256 === 'function') {
        var s = String(window.NativeBridge.certSha256() || '');
        if (s.length >= 16) return s.slice(0, 16) + '…';
      }
    } catch (e) {}
    return '';
  }

  /** 这些是作者自己的信息，改这一处就行 */
  var ME = {
    qq: '806894257',
    /* 加群链接用官方的 qm.qq.com 分享链接，不要用 mqqapi:// 那套老 scheme：
     * 1) mqqapi:// 是自定义 scheme，openExternal 里那条 CATEGORY_BROWSABLE
     *    会把能接它的 App 全过滤掉，结果就是 startActivity 抛
     *    ActivityNotFoundException，前端只看到「无法打开链接」；
     * 2) 新版 QQ 也不再认 show_pslcard 这个老接口。
     * 用 https 链接无论装没装 QQ 都有人接：装了会跳 QQ 加群页，没装会
     * 打开 qm.qq.com 的网页版引导页。
     */
    qqUrl: 'https://qm.qq.com/q/pFkpHXKCCk',
    repo: 'https://github.com/Buwrt/githup',
    issues: 'https://github.com/Buwrt/githup/issues',
    tips: 'https://github.com/Buwrt/githup/blob/main/TIPS.md'
  };

  /** 打开外链：优先交给原生（用浏览器打开），没有原生桥就新窗口 */
  function openLink(url) {
    try {
      if (window.NativeBridge && typeof NativeBridge.openExternal === 'function') {
        NativeBridge.openExternal(url);
        return;
      }
    } catch (e) {}
    window.open(url, '_blank');
  }

  /** 复制文本（QQ 群号这类） */
  function copyText(t) { if (window.UI && UI.copy) UI.copy(t); }

  /**
   * 「关于 githup」—— 介绍这款软件。
   *
   * 之前这里点了没反应：函数里用了 `ver`，而那是设置页 render 里的局部变量，
   * 在这里根本不存在，一点就抛 ReferenceError，整段弹层都建不出来。
   * 现在版本号统一由 appVer() 取，不依赖任何外部局部变量。
   */
  function about() {
    var appUrl = 'githup://' + ME.qq + '/v' + appVer();
    var row = function (id, icon, k, v) {
      return '<button class="set-row" data-ab="' + id + '"><span class="ico">' + window.icon(icon, 16) + '</span>' +
        '<span class="k">' + k + '</span>' +
        (v ? '<span class="muted tiny" style="margin-left:auto">' + U.esc(v) + '</span>' : '') + '</button>';
    };

    UI.sheet({
      title: '关于 githup',
      body:
        '<div class="center" style="padding:12px 0 6px">' +
        '<div style="display:flex;justify-content:center;color:var(--fg)">' + window.icon('mark-github', 52) + '</div>' +
        '<div style="font-size:20px;font-weight:600;margin-top:12px">githup</div>' +
        '<div class="muted tiny" style="margin-top:4px">版本 ' + U.esc(appVer()) + ' · Android 上的 GitHub 客户端</div>' +
        '<div class="muted tiny" style="margin-top:2px">把手里的 GitHub 装进口袋</div>' +
        '</div>' +

        '<div class="muted" style="font-size:13px;line-height:1.8;margin-top:14px">' +
        '一个轻量的第三方 GitHub 客户端：浏览仓库与代码、读 Issue 和 PR、看 Actions 构建、' +
        '发 Release、上传文件，乃至让 GitHub Actions 在云端替你打包 Android 应用。' +
        '<br><br>' +
        '整个界面是一套纯前端单页应用跑在 WebView 里，原生层只做网页做不到的事 —— ' +
        '绕过跨域发请求、调系统文件选择器、上传二进制、下载 APK 并拉起安装器。' +
        '所以它体积很小，却在手机上把 GitHub 该有的都补齐了。' +
        '</div>' +

        '<div class="section"></div>' +
        '<div class="set-group">' +
        row('repo', 'repo', '开源地址', 'Buwrt/githup') +
        row('qq', 'comment-discussion', 'QQ 群', ME.qq) +
        row('tips', 'heart', '赞赏支持', '微信 / 支付宝') +
        row('issues', 'bug', '反馈问题', '') +
        '</div>' +

        '<div class="section"></div>' +
        '<div class="set-group">' +
        row('update', 'sync', '检查更新', 'v' + appVer()) +
        row('errlog', 'bug', '下载错误日志', '') +
        '</div>' +

        /* 源码指纹 + 签名指纹：让人能核对「手上这个包到底是不是官方那份」。
         *
         * 版本号相同的两个包，光看 v1.1.5 分不出谁是谁 —— 出过这么一回事：
         * tag 停在旧提交、APK 却是新代码。现在把两条指纹摆出来，
         * 仓库里跑一遍 tools/gen-srcfingerprint.py 对一下就知道。
         *
         * 签名指纹走原生层拿（读的是系统给的安装包签名），拿不到就不显示 ——
         * 编一个假的比不显示更有害。 */
        '<div class="set-group">' +
        row('srcsha', 'code', '源码指纹', (window.API && window.API.SRC_SHA256) ? window.API.SRC_SHA256.slice(0, 16) + '…' : '未生成') +
        row('certsha', 'shield-check', '签名指纹', certShort() || '无法读取') +
        '</div>' +
        '<div class="set-note">这两条用来核对安装包来源：在仓库里跑 ' +
        '<code>python3 tools/gen-srcfingerprint.py --check</code> 比对源码指纹；' +
        '签名指纹应与官方发布的一致，不一致说明这个包被人重新打包过。</div>' +

        '<div class="set-note">' +
        '本应用为个人学习用途的第三方客户端，与 GitHub, Inc. 无任何隶属关系。' +
        '所有数据均通过 GitHub 官方公开 API 获取，访问令牌只保存在你的设备本机、不会上传到任何服务器。' +
        '图标取自 GitHub Octicons（MIT），代码高亮基于 highlight.js（BSD），Markdown 解析基于 marked（MIT）。' +
        '</div>',

      onMount: function () {
        UI.$$('[data-ab]').forEach(function (b) {
          b.onclick = function () {
            var k = b.getAttribute('data-ab');

            if (k === 'repo') return openLink(ME.repo);
            if (k === 'issues') return openLink(ME.issues);

            // 赞赏：直接把收款码显示出来，用户拿另一个手机扫或者长按保存。
            // 用的是与你手里那张一模一样的原图（984×1398），存在 App 内部资源里
            // （web/img/tips.png），不联网、不上传任何东西。不裁剪、不压缩，保证能扫。
            if (k === 'tips') {
              UI.sheet({
                title: '赞赏支持',
                body:
                  '<div class="center" style="padding:2px 0 6px">' +
                  '<img id="tip-qr" src="img/tips.png" alt="赞赏码" ' +
                  'style="width:100%;max-width:340px;display:block;margin:0 auto">' +
                  '</div>' +
                  '<div class="muted tiny" style="margin-top:12px;line-height:1.7;text-align:center">' +
                  '如果这个软件帮到了你，可以请我喝杯咖啡。<br>完全自愿，不给也一样能正常使用全部功能。<br>' +
                  '<span style="opacity:.75">长按图片可保存原图到相册</span>' +
                  '</div>',
                foot: '<button class="btn primary" data-close="1">好的</button>',
                onMount: function () {
                  /* 长按赞赏码 → 保存到相册。
                   * tips.png 是本地 assets 资源，saveImage 内部会识别并直接读 assets。 */
                  var qr = document.getElementById('tip-qr');
                  if (qr && window.UI && typeof window.UI.bindLongPress === 'function') {
                    window.UI.bindLongPress(qr, function () {
                      if (window.Native && typeof window.Native.saveImage === 'function') {
                        window.Native.saveImage(qr.src);
                      } else if (window.NativeBridge && typeof window.NativeBridge.saveImage === 'function') {
                        window.NativeBridge.saveImage(qr.src);
                      }
                    });
                  }
                }
              });
              return;
            }

            // QQ 群：给一键加群、复制群号两条路。手机装了 QQ 会直接跳过去，
            // 没装就退化成复制群号，总之不能点了没反应。
            if (k === 'qq') {
              UI.sheet({
                title: '加入 QQ 群',
                body: '<div class="center" style="padding:6px 0 2px">' +
                  '<div style="font-size:22px;font-weight:600;letter-spacing:1px">' + ME.qq + '</div>' +
                  '<div class="muted tiny" style="margin-top:6px">交流使用问题、反馈 Bug、获取更新</div>' +
                  '</div>' +
                  '<div class="muted tiny" style="margin-top:12px;line-height:1.7">' +
                  '点「一键加群」会尝试唤起 QQ；如果手机没装 QQ，选「复制群号」再手动搜索即可。' +
                  '</div>',
                foot: '<button class="btn" data-qq-copy="1">复制群号</button>' +
                  '<button class="btn primary" data-qq-open="1">一键加群</button>',
                onMount: function () {
                  UI.$('[data-qq-copy]').onclick = function () {
                    copyText(ME.qq);
                    UI.closeSheet();
                  };
                  UI.$('[data-qq-open]').onclick = function () {
                    openLink(ME.qqUrl);
                    UI.closeSheet();
                  };
                }
              });
              return;
            }

            if (k === 'update') {
              UI.closeSheet();
              if (window.Updater) return window.Updater.manualCheck();
              return UI.toast('当前版本不支持在线检查');
            }

            // 下载错误日志：把今天出的问题（功能出错 / 脚本报错 / 闪退 / 关键操作）
            // 整理成一份大白话小本子。点完先让用户自己选：
            //   分享        → 弹系统分享面板，发给别人
            //   保存到本地  → 写进 Download/githup/错误日志/，自己留着
            if (k === 'errlog') {
              UI.closeSheet();
              UI.sheet({
                title: '错误日志',
                body: '<div class="muted" style="font-size:14px;line-height:1.7">' +
                  '今天的日志已经整理好了（只记今天，明天自动从头开始）。<br>' +
                  '你想怎么处理它？' +
                  '</div>',
                foot: '<button class="btn" data-log-share="1">分享</button>' +
                  '<button class="btn primary" data-log-save="1">保存到本地</button>',
                onMount: function (body, close) {
                  UI.$('[data-log-share]').onclick = function () {
                    close();
                    if (window.Native && Native.shareLog) Native.shareLog();
                  };
                  UI.$('[data-log-save]').onclick = function () {
                    close();
                    if (window.Native && Native.saveLog) {
                      Native.saveLog(function (ok) {
                        UI.toast(ok ? '已存到 Download/githup/错误日志' : '保存失败，请稍后再试');
                      });
                    } else {
                      UI.toast('当前版本不支持');
                    }
                  };
                }
              });
              return;
            }
          };
        });
      }
    });
  }
})();
