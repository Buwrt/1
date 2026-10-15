/* ============================================================
 * wiki.js — 仓库 Wiki 页
 *
 * GitHub 没有给 Wiki 开任何 REST 接口：/repos/:o/:r/wiki 是 404，
 * wiki 仓库（xxx.wiki.git）也进不了 API，只能走 git 协议。
 * 所以这里走的是官网自己渲染 Wiki 用的那条路 ——
 * raw.githubusercontent.com/wiki/:o/:r/<页名>.md，拿回来的是纯 Markdown。
 *
 * 拿得到「某一页」，拿不到「一共有哪几页」（没有列表接口）。
 * 于是目录从 _Sidebar.md 里扒：绝大多数有 Wiki 的仓库都会在它里面
 * 列一份链接清单，这正是官网页面上左边那棵树。没有 _Sidebar 就退回
 * 只显示正文里的 [[双括号]] 链接 —— 至少能顺着往下翻。
 * ============================================================ */
(function () {
  'use strict';

  var U = window.Util, UI = window.UI;

  var DEFAULT_PAGE = 'Home';
  /** 内部路由标记：不会被 DOMPurify 当成协议扔掉，挂载后再换成真链接 */
  var PREFIX = '#wiki:';

  function base(full) {
    return 'https://raw.githubusercontent.com/wiki/' + full + '/';
  }

  /**
   * 页名 → 文件名。
   *
   * GitHub 的规矩是空格换连字符（"Getting Started" → Getting-Started.md），
   * 但 _Sidebar 里写什么的全都有，所以两个形态都试：原名先上，
   * 404 了再试连字符版。
   */
  function candidates(name) {
    var out = [name];
    var dashed = String(name).trim().replace(/\s+/g, '-');
    if (dashed !== name) out.push(dashed);
    return out;
  }

  function fetchPage(full, name, cacheMs) {
    var tries = candidates(name);
    var i = 0;
    function next() {
      if (i >= tries.length) return Promise.reject(new Error('这一页不存在'));
      var url = base(full) + encodeURIComponent(tries[i++]) + '.md';
      // 绝对 URL：buildUrl 认得 http 前缀，不会再去拼 api.github.com
      return window.API.text(url, 'text/plain', { cache: cacheMs || 300000 })
        .then(function (s) {
          if (s === null || s === undefined) throw new Error('读不到内容');
          return s;
        })
        .catch(function (e) {
          // 最后一试也失败才认输；中间失败只是页名形态不对，继续换
          if (i >= tries.length) return Promise.reject(e);
          return next();
        });
    }
    return next();
  }

  /**
   * 把 Markdown 里的相对链接补成绝对地址。
   *
   * Wiki 的正文里图片都是 ./img/x.png 这种相对写法，而这份文档不在
   * 仓库代码里、在 wiki 仓库里 —— 不补的话每张图都会去代码仓库找，
   * 一律 404，整页看起来像「图全裂了」。
   */
  function absolutize(md, full) {
    return String(md || '').replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, function (m, head, href, tail) {
      if (/^(https?:|#|mailto:|data:)/i.test(href)) return m;
      return head + base(full) + href + tail;
    });
  }

  /** [[页名]] —— Wiki 特有的跨页引用，标准 Markdown 不认，先换成普通链接 */
  function expandWikiLinks(md) {
    return String(md || '').replace(/\[\[([^\]]+)\]\]/g, function (m, name) {
      var t = name.trim();
      // [[Page|显示名]] 这种带别名的写法也要认
      var bar = t.indexOf('|');
      var label = bar >= 0 ? t.substring(bar + 1).trim() : t;
      var target = bar >= 0 ? t.substring(0, bar).trim() : t;
      return '[' + label + '](' + PREFIX + encodeURIComponent(target) + ')';
    });
  }

  /** 从 _Sidebar.md（或任意 Markdown）里扒出目录项 */
  function parseNav(md) {
    var out = [];
    var seen = Object.create(null);
    function add(name, label) {
      if (!name || seen[name]) return;
      seen[name] = 1;
      out.push({ name: name, label: label || name });
    }
    // [文字](页名) —— 链接形式的目录
    String(md || '').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
      if (/^(https?:|mailto:)/i.test(href)) return m;
      var n = href.charAt(0) === '#' ? href.slice(1) : href;
      if (n.indexOf(PREFIX) === 0) n = decodeURIComponent(n.slice(PREFIX.length));
      add(n, label);
      return m;
    });
    // [[页名]] —— 双括号形式
    String(md || '').replace(/\[\[([^\]]+)\]\]/g, function (m, name) {
      var bar = name.indexOf('|');
      add(bar >= 0 ? name.substring(0, bar).trim() : name.trim());
      return m;
    });
    return out;
  }

  function navHtml(full, items, cur) {
    if (!items.length) return '';
    return '<div class="section-title">' + window.icon('list-unordered', 14) + ' 页面</div>' +
      '<div class="list">' + items.map(function (it) {
        var on = it.name === cur;
        return '<div class="rowflex" style="padding:10px 14px' + (on ? ';background:var(--bg-subtle)' : '') + '">' +
          '<a href="#/' + U.esc(full) + '/wiki?page=' + encodeURIComponent(it.name) + '"' +
          ' style="flex:1;' + (on ? 'font-weight:600' : '') + '">' + U.esc(it.label) + '</a></div>';
      }).join('') + '</div>';
  }

  /**
   * 渲染 Wiki 页。
   * @param repo  仓库对象（要有 full_name / has_wiki / html_url）
   * @param page  页名，空则 Home
   * @param host  容器
   */
  function render(repo, page, host) {
    var full = repo.full_name;
    var name = page || DEFAULT_PAGE;

    // 仓库压根没开 Wiki：连请求都不必发，直接说清原因
    if (repo.has_wiki === false) {
      host.innerHTML = UI.empty('book', '这个仓库没有开启 Wiki', '仓库设置里关掉了 Wiki，或者从来没建过页面。');
      return Promise.resolve();
    }

    var epoch = window.Router.viewEpoch;
    host.innerHTML = '<div id="wnav"></div><div id="wbody" style="padding:14px">' + UI.skeleton(6) + '</div>';

    // 目录与正文并发：目录拿不到也不该拖住正文
    fetchPage(full, '_Sidebar', 600000).then(function (side) {
      if (epoch !== window.Router.viewEpoch) return;
      var box = UI.$('#wnav', host);
      if (box) box.innerHTML = navHtml(full, parseNav(side), name);
    }).catch(function () { /* 没有侧边栏是常态，静默 */ });

    return fetchPage(full, name).then(function (md) {
      if (epoch !== window.Router.viewEpoch) return;
      var box = UI.$('#wbody', host);
      if (!box) return;

      var src = expandWikiLinks(absolutize(md, full));
      box.innerHTML = '<div class="md" id="wmd"></div>';
      window.MD.mount(UI.$('#wmd', box), src, { repo: full, ref: 'wiki', path: '' });

      // 挂载完再把 #wiki: 标记换成真链接 —— 提前写在源码里会被净化掉
      UI.$$('a[href^="' + PREFIX + '"]', box).forEach(function (a) {
        var target = decodeURIComponent(a.getAttribute('href').slice(PREFIX.length));
        a.setAttribute('href', '#/' + full + '/wiki?page=' + encodeURIComponent(target));
      });

      // 目录没拿到时（无 _Sidebar），把正文里的 [[页名]] 收集起来当目录
      var nav = UI.$('#wnav', host);
      if (nav && !nav.innerHTML) {
        var items = parseNav(md);
        if (items.length) nav.innerHTML = navHtml(full, items, name);
      }
    }).catch(function (e) {
      if (epoch !== window.Router.viewEpoch) return;
      // 首页都打不开 = 这个仓库挂着 Wiki 开关却没有内容，这是最常见的情况
      var box = UI.$('#wbody', host);
      if (box) {
        box.innerHTML = name === DEFAULT_PAGE
          ? UI.empty('book', '这个仓库还没有 Wiki 内容', '开启了 Wiki，但没有可读取的页面。')
          : UI.errorBox(e);
      }
    });
  }

  window.Wiki = { render: render, DEFAULT_PAGE: DEFAULT_PAGE };
})();
