/* ============================================================
 * ghlink.js — 把一条 GitHub 链接翻译成 App 里的那一页
 *
 * 为什么单独一个文件：搜索框要用，以后分享进来、剪贴板唤起也会用，
 * 而且它是一段「纯字符串 → 字符串」的映射 —— 不碰 DOM、不发请求，
 * 单独放着最好验证（tools 下可以用 node 直接跑）。
 *
 * 三条定死的规矩：
 *
 *  1. 认不出来就别猜，返回 null，让调用方当普通关键词去搜。
 *     猜错的代价比不跳大得多：用户会落到一个 404、或者一个
 *     风马牛不相及的页面上，而且不知道发生了什么。
 *
 *  2. 够得着的一律进原生的那一页 —— 这才是「用 App 看 GitHub」的意义；
 *     够不着的（网页端的设置页、marketplace、wiki、discussions…）
 *     明明白白标成 external，交给内置浏览器，绝不硬塞进路由。
 *     别偷那种手脚：parseHash 里第 3 段不在白名单就会被当成文件路径，
 *     硬塞过去的结果是一个空空的代码页，还不如直接交给浏览器。
 *
 *  3. 下载直链（releases/download/…、codeload 的打包下载）交给下载通道，
 *     而不是「打开一个二进制文件页面」。
 * ============================================================ */
(function () {
  'use strict';

  /* 仓库页 tab 与路由第 3 段的一一对应。照 app.js 里那份白名单抄的，
     但这是**第二份**，多一个 tab 记得两边都要加 —— 漏一边的结果
     是「链接明明认出来了，跳过去却落在代码页上」。 */
  var REPO_TABS = {
    issues: 'issues', pulls: 'pulls', actions: 'actions', releases: 'releases',
    commits: 'commits', contributors: 'contributors', branches: 'branches',
    tags: 'tags', settings: 'settings', stargazers: 'stargazers',
    watchers: 'watchers', forks: 'forks', milestones: 'milestones',
    collaborators: 'collaborators'
  };

  /* github.com 一级路径里那些「不是某个用户」的名字。
     它们大多不是个人 / 组织主页，照用户页解析就会跳到一个不存在的账号，
     所以逐个按「App 里真正有的那一页」来定去向。 */
  var RESERVED_TOP = ['settings', 'notifications', 'explore', 'trending', 'issues',
    'pulls', 'search', 'login', 'join', 'signup', 'marketplace', 'sponsors',
    'collections', 'events', 'apps', 'about', 'pricing', 'security', 'features',
    'solutions', 'enterprise', 'readme', 'topics', 'orgs', 'gists', 'new',
    'account', 'sessions', 'organizations', 'plans', 'contact', 'site'];

  /* 认域名 + 路径。协议和 www 都可省（聊天窗口里复制出来的常常没有 http://），
     但**必须以域名开头** —— 关键词里夹杂一个链接（"readme github.com/x"）
     不算「用户想打开它」，那只是搜索词的一部分。
     查询串和锚点一律丢弃：utm 参数、?tab=readme、#issuecomment-xxx 都不影响去向。 */
  var URL_RE = /^(?:https?:\/\/)?(?:www\.)?(github\.com|gist\.github\.com|raw\.githubusercontent\.com|codeload\.github\.com)((?:\/[^?#\s]*)?)(?:[?#].*)?$/i;

  var IS_HEXish = /^[0-9a-f]{20,40}$/i;

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /** 路径 -> 分段（去掉空段。返回的是**未解码**的原始段，给 tree/blob 分 ref 用） */
  function splitRaw(p) {
    return String(p || '').split('/').filter(function (s) { return s !== ''; });
  }

  /** 路径 -> 分段（逐段解码） */
  function splitPath(p) {
    return splitRaw(p).map(safeDecode);
  }

  /** 拼内部路径：每段单独编码，整段的 '/' 才不会被吃掉 */
  function joinPath(segs) {
    return '/' + segs.map(function (s) { return encodeURIComponent(s); }).join('/');
  }

  /** 提示条上放不下就截断（默认 28 字） */
  function short(s, n) {
    var v = String(s || '');
    return v.length > (n || 28) ? v.slice(0, (n || 28) - 1) + '…' : v;
  }

  function shortSha(s) { return String(s || '').slice(0, 7); }

  /* ---------- 各个家族的翻译 ---------- */

  /** github.com 的一级保留路径：各回各的那一页 */
  function reservedLevel(segs, url) {
    var top = segs[0].toLowerCase();
    var wrap = function (path, label, sub) {
      return { path: path, label: label, sub: sub || short(url, 40), kind: 'route' };
    };
    /* 通知：App 那一页是自己的收件箱，语义一致 */
    if (top === 'notifications') return wrap('/notifications', '打开通知');
    if (top === 'explore' || top === 'trending') return wrap('/explore', '打开探索');
    if (top === 'issues') return wrap('/issues', '打开我的议题');
    if (top === 'pulls') return wrap('/pulls', '打开我的拉取请求');
    if (top === 'gists') return wrap('/gists', '打开我的 Gist');
    /* 话题：App 没有「话题」这一页，但它在 GitHub 上等价于
       `topic:xxx` 的仓库搜索 —— 直接落到搜索结果比内置浏览器有用。 */
    if (top === 'topics' && segs[1]) {
      return wrap('/search?q=' + encodeURIComponent('topic:' + segs[1]) +
        '&type=repositories', '搜索话题 ' + segs[1]);
    }
    /* 组织：/orgs/<org>/people 这类二级路径也还是那个组织的主页 */
    if (top === 'orgs' && segs[1]) return wrap(joinPath([segs[1]]), '打开组织 ' + segs[1]);
    return null;   // 其余（含网页版设置、marketplace、登录…）一律走内置浏览器
  }

  /** owner/repo 之下的东西。segsRaw 是未解码的同一份分段（分 ref 要用） */
  function repoLevel(segs, url, segsRaw) {
    var owner = segs[0], repo = segs[1];
    var base = '/' + owner + '/' + repo;
    var out = function (path, label) {
      return { path: path, label: label, sub: short(url, 40), kind: 'route' };
    };

    /* 只有 owner —— 这是用户 / 组织主页 */
    if (segs.length === 1) return out(joinPath([owner]), '打开用户 ' + owner);
    if (segs.length === 2) return out(base, '打开仓库 ' + owner + '/' + repo);

    var sub = segs[2], rest = segs.slice(3);

    /* ---- 代码：tree / blob / blame ----
       GitHub 的 tree 是目录、blob 是文件，blame 是逐行标注 ——
       内部只有前两种，blame 落成同路径的文件内容（至少看得见东西，
       比交给浏览器有意义得多，因为标注视图本来也看不了什么）。
       注意 ref 一律塞进 ?ref=：分支名自带斜杠（release/v1.2）时，
       放在路径里会被拆成两段 —— 这是 tree/blob 反复踩过的坑，
       app.js 的那段注释写得很清楚。 */
    if (sub === 'tree' || sub === 'blob' || sub === 'blame') {
      /* ref 必须在**未解码**的分段上取：GitHub 的链接里，带斜杠的分支名
         会被编码成 /tree/release%2Fv1.2/src —— 先解码再切的话 'release/v1.2'
         就散成两段，ref 只剩 'release'，后半截跑进文件路径里。
         先按原始段切开（第 1 段 = ref），ref 自己再解码还原成 release/v1.2。 */
      var restRaw = segsRaw.slice(3);
      if (!restRaw.length) return out(base, '打开仓库 ' + owner + '/' + repo);
      var ref = safeDecode(restRaw[0]);
      var fp = restRaw.slice(1).map(safeDecode);
      if (!fp.length) {
        // /tree/main：只换了分支，还是代码首页
        return out(base + '?ref=' + encodeURIComponent(ref),
          '打开 ' + owner + '/' + repo + ' 的 ' + ref);
      }
      var kind = sub === 'tree' ? 'tree' : 'blob';
      var name = fp[fp.length - 1];
      return out(base + '/' + kind + joinPath(fp) + '?ref=' + encodeURIComponent(ref),
        (kind === 'blob' ? '打开文件 ' : '打开目录 ') + short(name, 24));
    }

    /* ---- 议题 / 拉取请求 ---- */
    if (sub === 'issues' || sub === 'pull') {
      if (/^\d+$/.test(rest[0] || '')) {
        return out(base + '/' + sub + '/' + rest[0],
          (sub === 'issues' ? '打开议题 #' : '打开拉取请求 #') + rest[0]);
      }
      // /issues/new、/issues?q=…、光秃秃的 /issues：都落到列表那一页
      return out(base + '/' + (sub === 'issues' ? 'issues' : 'pulls'),
        '打开' + (sub === 'issues' ? '议题' : '拉取请求') + '列表');
    }
    if (sub === 'pulls') return out(base + '/pulls', '打开拉取请求列表');

    /* ---- 发布 ----
       tag 走查询参数（?tag=）而不是第 4 段：
       tag 里带斜杠的仓库很多（release/2026-09），放在路径里会被切碎，
       而且 App 的 /releases/<tag> 本来就是拿第 4 段当 tag 用的。 */
    if (sub === 'releases') {
      if (!rest.length) return out(base + '/releases', '打开发布列表');
      var head = rest[0];
      if (head === 'tag' && rest[1]) {
        var tag = rest.slice(1).join('/');
        return out(base + '/releases?tag=' + encodeURIComponent(tag),
          '打开发布 ' + short(tag, 24));
      }
      if (head === 'latest') return out(base + '/releases?tag=latest', '打开最新发布');
      if (head === 'download' && rest[1]) {
        /* 附件直链：这是要下载的东西，不是要看的页面 */
        return {
          kind: 'download',
          url: '',                       // 下面统一回填（保留原始编码的那份）
          name: rest[rest.length - 1],
          label: '下载 ' + short(rest[rest.length - 1], 24),
          sub: short(url, 40)
        };
      }
      return out(base + '/releases', '打开发布列表');
    }

    /* ---- 提交 / Actions ---- */
    if (sub === 'commit' && rest[0]) {
      return out(base + '/commit/' + encodeURIComponent(rest[0]),
        '打开提交 ' + shortSha(rest[0]));
    }
    if (sub === 'commits') {
      return out(base + '/commits' + (rest[0] ? '?ref=' + encodeURIComponent(rest[0]) : ''),
        '打开提交历史');
    }
    if (sub === 'actions') {
      if (rest[0] === 'runs' && rest[1]) {
        return out(base + '/actions/' + encodeURIComponent(rest[1]), '打开 Actions 运行记录');
      }
      return out(base + '/actions', '打开 Actions');
    }

    /* ---- 其余 tab ---- */
    if (REPO_TABS[sub]) return out(base + '/' + sub, '打开仓库 ' + short(owner + '/' + repo, 24));

    /* wiki、discussions、projects、compare、security、graph、pulse…
       App 里没有对应页面，别硬塞。 */
    return {
      kind: 'external', url: 'https://github.com' + joinPath(segs),
      label: '用内置浏览器打开', sub: short(url, 40)
    };
  }

  /* ---------- 对外入口 ---------- */

  /**
   * 解析一串文本。
   *
   * @returns null 不是 GitHub 链接（调用方当普通关键词处理）
   *          { kind:'route',    path, label, sub }  可以直接 Router.go 的内部路径
   *          { kind:'external', url,   label, sub }  App 没有那一页，交给内置浏览器
   *          { kind:'download', url,   name, label, sub }  下载直链
   */
  function parse(txt) {
    var s = String(txt == null ? '' : txt).trim();
    if (!s) return null;
    // 聊天软件里复制出来偶尔是 <https://…> 这种带尖括号的
    s = s.replace(/^<|>$/g, '').trim();
    var m = s.match(URL_RE);
    if (!m) return null;

    var host = m[1].toLowerCase();
    var rawPath = m[2] || '';
    var url = m[1] + rawPath;   // 去掉协议/www 的显示用短串
    var segs = splitPath(rawPath);
    var segsRaw = splitRaw(rawPath);

    /* 光一个域名：https://github.com（后面没有路径）→ 首页 */
    if (host === 'github.com' && !segs.length) {
      return { kind: 'route', path: '/', label: '打开首页', sub: 'github.com' };
    }

    if (host === 'gist.github.com') {
      /* 两种写法都给：gist.github.com/<id> 和 gist.github.com/<user>/<id>。
         只看「长得像不像 gist id」（20~40 位十六进制），不猜用户名。 */
      for (var i = segs.length - 1; i >= 0; i--) {
        if (IS_HEXish.test(segs[i])) {
          return { kind: 'route', path: '/gist/' + segs[i], label: '打开 Gist', sub: short(url, 40) };
        }
      }
      return { kind: 'external', url: 'https://' + host + rawPath, label: '用内置浏览器打开', sub: short(url, 40) };
    }

    if (host === 'raw.githubusercontent.com') {
      /* <owner>/<repo>/<ref>/<path…> —— 等价于那个 ref 上的文件 */
      if (segs.length >= 4) {
        var owner = segs[0], repo = segs[1], ref = segs[2], fp = segs.slice(3);
        return {
          kind: 'route',
          path: '/' + owner + '/' + repo + '/blob' + joinPath(fp) + '?ref=' + encodeURIComponent(ref),
          label: '打开文件 ' + short(fp[fp.length - 1], 24),
          sub: short(url, 40)
        };
      }
      return { kind: 'external', url: 'https://' + host + rawPath, label: '用内置浏览器打开', sub: short(url, 40) };
    }

    if (host === 'codeload.github.com') {
      /* 源码打包下载：https://codeload.github.com/<owner>/<repo>/zip/refs/heads/main */
      if (segs.length >= 3) {
        var kindName = segs[2] || 'zip';
        var refName = segs.slice(3).join('/') || 'main';
        var fname = segs[1] + '-' + refName.split('/').pop() + '.' + (kindName === 'legacy.tar.gz' ? 'tar.gz' : kindName);
        return {
          kind: 'download',
          url: 'https://' + host + rawPath,
          name: fname,
          label: '下载源码包 ' + short(fname, 24),
          sub: short(url, 40)
        };
      }
      return { kind: 'external', url: 'https://' + host + rawPath, label: '用内置浏览器打开', sub: short(url, 40) };
    }

    /* host === 'github.com'：一级是保留字就按保留规则走，认不出来 -> 内置浏览器 */
    var res = RESERVED_TOP.indexOf(segs[0].toLowerCase()) >= 0
      ? (reservedLevel(segs, url) || { kind: 'external', label: '用内置浏览器打开', sub: short(url, 40) })
      : repoLevel(segs, url, segsRaw);
    /* 要浏览器打开 / 要下载的地址统一回填：直接用 rawPath，
       百分号编码和特殊字符统统保真（查询串早在 URL_RE 那步就剥掉了，
       utm 之类的参数不会跟着走）。 */
    if (res && (res.kind === 'external' || res.kind === 'download') && !res.url) {
      res.url = 'https://' + host + rawPath;
    }
    return res;
  }

  window.GhLink = { parse: parse };
})();
