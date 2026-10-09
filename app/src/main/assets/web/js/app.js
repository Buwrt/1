/* ============================================================
 * app.js — 路由、主题、导航、通知轮询与启动流程
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = window.Pages;

  var RESERVED = ['login', 'notifications', 'explore', 'search', 'settings', 'downloads', 'gists', 'gist', 'issues', 'pulls', 'orgs', 'topics', 'apps', 'sponsors', 'collections', 'trending', 'events', 'marketplace', 'about', 'profile', 'totp'];

  /* 右上角「下载管理」入口的当前按钮实例（角标刷新用；不在该页时为 null） */
  var dlBtn = null;

  var App = {
    pageCache: Object.create(null),
    cacheGet: function (k) { return this.pageCache[k]; },
    cacheSet: function (k, v) { this.pageCache[k] = v; },
    clearPageCache: function () { this.pageCache = Object.create(null); },
    invalidate: function (prefix) {
      Object.keys(this.pageCache).forEach(function (k) {
        if (k.indexOf(prefix) === 0) delete App.pageCache[k];
      });
    },

    title: function (t, sub) {
      var el = document.getElementById('appbar-title');
      el.innerHTML = U.esc(t) + (sub ? ' <span class="muted" style="font-weight:400;font-size:12px">' + U.esc(sub) + '</span>' : '');
    },

    setActions: function (list) {
      var box = document.getElementById('appbar-actions');
      box.innerHTML = '';
      (list || []).forEach(function (a) {
        var b = document.createElement('button');
        b.className = 'icon-btn';
        b.innerHTML = window.icon(a.icon, 22);
        b.onclick = a.onClick;
        box.appendChild(b);
      });
      App.appendDownloadAction();
    },

    /**
     * 右上角常驻的「下载管理」入口。
     *
     * 必须挂在 setActions 末尾而不是让页面自己加：路由每次渲染都会先
     * setActions([]) 清空，页面自己的菜单又是异步挂上去的 —— 只有在这里
     * 兜底追加，才能保证任何页面（含异步渲染完的页面）右上角都有它。
     *
     * 图标特意用 archive 而不是 download：发布详情页自己有一个
     * 「下载源码包」的 download 按钮，两个一样的图标并排，用户分不清
     * 哪个是哪个（真实反馈）—— archive 是「管理/收纳」，download 是「下载」。
     */
    appendDownloadAction: function () {
      if (!(window.NativeBridge && typeof window.NativeBridge.downloadStatus === 'function')) return;
      var box = document.getElementById('appbar-actions');
      if (!box) return;
      var h = (location.hash || '').replace(/^#/, '').split('?')[0];
      if (h === '/downloads') { dlBtn = null; return; }   // 已经在下载页，不必再给入口
      var b = document.createElement('button');
      b.className = 'icon-btn dl-action';
      b.setAttribute('aria-label', '下载管理');
      b.title = '下载管理';
      b.innerHTML = window.icon('archive', 22) + '<i class="dl-badge" hidden></i>';
      b.onclick = function () { Router.go('/downloads'); };
      box.appendChild(b);
      dlBtn = b;
      App.refreshDownloadBadge();
    },

    /** 右上角下载入口的角标：还在跑的任务数（成功/失败的不算） */
    refreshDownloadBadge: function () {
      if (!dlBtn) return;
      var badge = dlBtn.querySelector('.dl-badge');
      if (!badge) return;
      var n = 0;
      try {
        var list = JSON.parse(window.NativeBridge.downloadStatus() || '[]') || [];
        n = list.filter(function (t) {
          return t.status !== 8 && t.status !== 16;   // 8=成功 16=失败
        }).length;
      } catch (e) { return; }
      if (n > 0) { badge.hidden = false; badge.textContent = n > 9 ? '9+' : String(n); }
      else badge.hidden = true;
    },

    /* 系统当前是不是深色。
       优先级：原生 systemDark() → 浏览器 prefers-color-scheme → 当作浅色。
       为什么原生优先（这是真机反馈「系统浅色、App 却渲染成深色」之后修的）：
       Android WebView 里的 prefers-color-scheme 并不可靠 —— 它受 WebSettings
       的 force-dark / algorithmic-darkening 影响，部分机型或 WebView 版本下
       会一直返回 light，或者反过来一直返回 dark，于是「跟随系统」就跟着错了。
       Configuration.uiMode 是系统给的权威值，不受 WebView 配置干扰。
       浏览器里没有 NativeBridge，退回媒体查询，保证桌面调试行为一致。 */
    systemIsDark: function () {
      try {
        if (window.NativeBridge && typeof NativeBridge.systemDark === 'function') {
          return !!NativeBridge.systemDark();
        }
      } catch (e) {}
      try {
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      } catch (e) {
        return false;
      }
    },

    applyTheme: function () {
      var s = window.Store.load();
      var t = s.theme || 'auto';
      if (t === 'auto') t = App.systemIsDark() ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', t);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', t === 'dark' ? '#010409' : '#ffffff');
      /* color-scheme 交给实际主题，不再写死 "light dark"。
         写死时浏览器会认为「页面自己做深浅色」，于是滚动条、输入框这类
         原生控件按**系统**着色，而系统可能是浅色、页面却是深色，两者就错位。
         现在它跟 data-theme 一致，原生控件和页面永远同色。 */
      var cs = document.querySelector('meta[name="color-scheme"]');
      if (cs) cs.setAttribute('content', t === 'dark' ? 'dark' : 'light');
      var l = document.getElementById('hljs-light'), d = document.getElementById('hljs-dark');
      if (l && d) { l.disabled = t === 'dark'; d.disabled = t !== 'dark'; }
      try {
        if (window.NativeBridge && NativeBridge.setStatusBar) {
          /* ⚠️ 这里传的颜色**已经不会被采用了**（原生侧强制透明），
             保留只是为了让它顺带刷新状态栏图标的明暗。
             状态栏必须是透明的，理由见 app.css 里「顶栏浮到状态栏底下」那节：
             给它上实色，就等于在页面顶上贴一条不透明的色带，
             玻璃再怎么调也接不上，看着就是「标题被顶下去、上面空一块」。 */
          NativeBridge.setStatusBar(t === 'dark' ? '#010409' : '#ffffff');
        }
      } catch (e) {}
    },

    /**
     * 把原生量出来的安全区写进 CSS 变量 --safe-t / --safe-b / --safe-l / --safe-r。
     *
     * ⚠️ 为什么不能只靠 CSS 的 env(safe-area-inset-top)：
     * Android WebView 对它的支持不可靠 —— 只在部分版本 + viewport-fit=cover
     * 的组合下才返回非 0，而且返回的是「刘海高度」而非「状态栏高度」，
     * 大多数机型上这两个值并不相等。
     *
     * 本应用是 edge-to-edge（SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN），WebView 铺满
     * 整个屏幕、含被状态栏盖住的那一条。前端拿不到状态栏高度的话，
     * 顶栏就会被状态栏压住一截 —— 表现出来就是「首页/搜索页的标题位置不对」。
     *
     * 原生返回的是「设备像素」数组 [top, bottom, left, right]，这里要除以 DPR
     * 换成 CSS px —— 魅族 20 这类 DPR≈3 的机器，状态栏量出来是 100+ 设备像素，
     * 不除就是 100px，顶栏会被撑到半屏高。
     *
     * 左右两值（第 3、4 位）是「适配所有机型」补上的：横屏时刘海/挖孔跑到
     * 侧边，曲面屏左右本来就有不可触控的弧面。老版本 NativeBridge 只返回两个
     * 值，这里用 `|| 0` 兜住，不会把变量写成 NaN。
     *
     * ⚠️ 第 2 位（bottom）的语义已经在原生侧订正过了 —— 它是「页面还要让多少」，
     * 不再是「系统导航栏有多高」。minSdk 是 24，Android 7~10 以前一律塞的是
     * navigation_bar_height 资源（写死的 48dp），跟「这台机器当下画没画导航栏」
     * 毫无关系：手势导航的机器、压根没有软导航栏的实体键机器，照样拿到 48dp。
     * 朴素样式下 --nav-lift 为 0，这 48dp 就整条变成「底栏到屏幕底边的缝」——
     * 「有的手机上这一排离家出走」就是它。改成去量「WebView 到底伸没伸到屏幕
     * 底边」之后，这个数在正常机型上就是 0 或很小的值。
     *
     * 这里再补一道防御上限：某些 ROM 会把底部避让量报成离谱的大数。
     * 屏幕底那一条再怎么样也到不了屏高的 8%，超了铁定是错的 ——
     * 宁可贴底，也不要让底栏飞到半空中。
     */
    applySafeInsets: function () {
      var root = document.documentElement;
      var dpr = window.devicePixelRatio || 1;
      try {
        if (!(window.NativeBridge && NativeBridge.safeInsets)) return;
        var raw = NativeBridge.safeInsets();
        var v = JSON.parse(raw);
        if (!v || v.length < 2) return;
        var top = Math.max(0, Math.round((v[0] || 0) / dpr));
        var bot = Math.max(0, Math.round((v[1] || 0) / dpr));
        var lft = Math.max(0, Math.round((v[2] || 0) / dpr));
        var rgt = Math.max(0, Math.round((v[3] || 0) / dpr));
        var cap = Math.max(12, Math.min(32, Math.round((window.innerHeight || 640) * 0.08)));
        if (bot > cap) bot = cap;
        /* 第 5 位是导航栏模式（0 未知 / 1 三键 / 2 两键 / 3 手势 / 9 无软导航栏），
           不参与排版，挂在根元素上纯粹是为了万一再出问题能一眼看出来。 */
        if (v.length > 4) root.setAttribute('data-navmode', String(v[4] | 0));
        root.style.setProperty('--safe-t', top + 'px');
        root.style.setProperty('--safe-b', bot + 'px');
        root.style.setProperty('--safe-l', lft + 'px');
        root.style.setProperty('--safe-r', rgt + 'px');
      } catch (e) {
        /* 拿不到就保持 CSS 里的 env() 兜底，不要把变量写成 0 ——
           写 0 会让顶栏彻底贴到屏幕最顶上，比原来更糟。 */
      }
    },

    /**
     * 这个 WebView 认不认 backdrop-filter。
     *
     * 老机型 / 定制 ROM（老款 Flyme、运营商机）的 WebView 不认，此时玻璃层
     * 只剩一层半透明色罩，底下滚过的列表会直接透上来，比不做玻璃还难看。
     * 认不出来时 app.css 会把色罩提到接近不透明（见「全机型适配」一节）。
     *
     * 两个属性都要试：只认 -webkit- 前缀的引擎（Chromium 76~117）和只认标准
     * 名的引擎都存在，任一认即可。
     */
    detectGlassSupport: function () {
      var ok = false;
      try {
        if (window.CSS && CSS.supports) {
          ok = CSS.supports('backdrop-filter', 'blur(2px)') ||
               CSS.supports('-webkit-backdrop-filter', 'blur(2px)');
        } else {
          // CSS.supports 都没有的老引擎，玻璃基本也不用想了
          ok = false;
        }
      } catch (e) { ok = false; }
      document.documentElement.setAttribute('data-glass-support', ok ? '1' : '0');
      return ok;
    },

    /**
     * 底栏风格：玻璃 / classic。
     *
     * 与主题分开成两条轴：data-theme 管深浅，data-nav 管底栏形态。
     * 分开的好处是切风格不用重算主题，切主题也不用重算风格 ——
     * 而且「跟随系统 + 玻璃」这种组合天然可用（混成一条轴就得开方阵）。
     *
     * 默认值放在这里（而不是 CSS 或 index.html 里）：只有一处说了算，
     * 免得「默认打开」这个约定散落三处、改一处忘两处。
     * 当前约定：**默认开**（没存过设置时按 glass）。
     */
    NAV_GLASS_DEFAULT: true,

    navGlass: function () {
      var v = window.Store.get('navGlass');
      /* 三态都要认：
           undefined / null —— 老版本升上来的，设置里从来没这个键
           true  / false    —— Store 存的是 JSON，布尔值原样往返
           '1'   / '0'      —— 早期写法留下的字符串
         ⚠️ 别写成 `v || true`：'0' 在 JS 里是真值，关掉开关会被当成打开。 */
      if (v === undefined || v === null || v === '') return App.NAV_GLASS_DEFAULT;
      if (typeof v === 'boolean') return v;
      return String(v) === '1' || String(v) === 'true';
    },

    applyNav: function () {
      document.documentElement.setAttribute('data-nav', App.navGlass() ? 'glass' : 'classic');
    },

    /** 设置页开关的落点：存偏好 + 立刻生效（不用重启） */
    setNavGlass: function (on) {
      window.Store.set('navGlass', !!on);
      App.applyNav();
    },

    showBack: function (show) {
      var b = document.getElementById('btn-back');
      b.hidden = !show;
      if (show && !b.innerHTML) b.innerHTML = window.icon('arrow-left', 22);
      // 返回按钮与系统返回键走同一套逻辑，保证行为一致
      if (show) b.onclick = function () { App.handleBack(); };
    },

    /**
     * 统一的返回处理，返回 true 表示「已消费」（调用方不应再退出应用）。
     *
     * 优先级（从内到外，符合用户直觉）：
     *   1. 图片查看器（全屏覆盖）
     *   2. 打开的弹层 / 确认框 / 菜单（最新打开的最先关）
     *   3. 仓库页的 tab 层：回到「代码」
     *   4. 纵向层级回退（详情 / 议题 / Release 这类，逐级退回）
     *   5. 停在标签页上：回到首页
     *   6. 已经在首页：交给「再按一次退出」
     */
    handleBack: function () {
      /* 0) 新手引导：优先级最高。
         引导期间整屏都是遮罩，返回键必须能把它退掉 —— 否则用户会被
         困在遮罩里（点哪都没反应，只能杀进程重开）。 */
      if (window.Onboarding && window.Onboarding.isActive()) {
        window.Onboarding.quit();
        return true;
      }
      // 1) 图片查看器
      var viewer = document.getElementById('viewer-root');
      if (viewer && viewer.classList.contains('show')) {
        if (window.UI && UI.closeViewer) { UI.closeViewer(); return true; }
        viewer.classList.remove('show');
        viewer.innerHTML = '';
        return true;
      }

      // 2) 弹层
      var sheet = document.getElementById('sheet-root');
      if (sheet && sheet.classList.contains('show')) {
        // 强制更新这类弹层标记为不可关闭：吞掉返回键，不给绕过的路径
        if (sheet.dataset.lock === '1') return true;
        if (window.UI && UI.closeSheet) UI.closeSheet();
        return true;
      }

      /*
        3) 仓库页：只要人在这个仓库里、且不在「代码」tab，返回一律先回代码。

        仓库页顶上那一排 tab（代码 / 议题 / 拉取请求 / Actions / 发布 / 更多），
        加上「更多」里进去的提交记录、分支、标签、贡献者…，以前是跟着 history
        逐级退，于是：

          · 从「代码」连点「议题 → 拉取请求 → 发布」之后，要按三次返回才回得到
            代码 —— 用户只想「退出这一个 tab」，不是把刚才走过的路倒着走一遍；
          · 从搜索结果 / 通知直接点进「议题」时，历史里压根没有「代码」这一条，
            一按返回就整个退出仓库页了 —— 明明还在仓库里，人却被弹走了。

        现在统一：在仓库里、不在代码 tab → 落到代码 tab；已经在代码 tab →
        继续往上退（回搜索 / 回首页…），也就是第 4 步那些。

        用 replace 而不是 go：tab 之间是不堆历史的横向切换（见 pushRoute），
        这里再 push 一条的话，历史会攒成「代码 → 议题 → 代码 → 议题」，
        按返回变成在这两页之间来回跳，永远退不出去。

        tree/blob 这类「代码 tab 里再往里走」的不在此列 —— 它们的 tab 就是
        code，返回照旧逐级退回仓库根；议题详情 / Release 详情 / 提交详情同理，
        先退回它自己那个 tab。
      */
      var cur = parseHash(location.hash);
      if (cur && cur.name === 'repo' && cur.ctx && cur.ctx.tab && cur.ctx.tab !== 'code'
          && repoTabKey(location.hash)) {
        Router.replace('/' + cur.ctx.owner + '/' + cur.ctx.repo);
        return true;
      }

      // 4) 纵向层级：有就逐级退回去
      if (Router.canGoBack()) {
        history.back();
        return true;
      }

      /*
        5) 已经没有纵向层级了，但人还没回到首页 —— 回首页，别直接退出。

        底部五个标签是并列的一级入口，用户从「探索」切到「通知」再按返回时，
        期望的是「退回到主界面」而不是「App 直接没了」。
        这里用 Router.go('/') 而不是 history.back()：横向切标签走的是
        replaceState，history 里根本没有标签之间的条目可退。

        注意这一步只是「兜底」：正常的二级页面（下载管理、登录、仓库详情…）
        都是 pushState 进来的，routeDepth > 0，会在第 3 步就逐级退回「进来前
        的那个页面」，根本走不到这里。曾经把 /downloads 也塞进 TAB_ROOTS，
        结果从探索页进下载管理被当成「横向切标签」replace 掉了历史，
        一按返回就落到这里被甩回首页 —— 所以 TAB_ROOTS 只准放底部标签。
      */
      var here = (location.hash || '#/').replace(/^#/, '').split('?')[0];
      if (here !== '' && here !== '/') {
        Router.go('/');
        return true;
      }
      // 6) 就在首页：交给「再按一次退出」
      return false;
    },

    /* ---- 悬浮胶囊底栏：跟手拖动 + 滑动指示器 ----
       violet_Box 这枚指示器由 DampedDragAnimation 的三根弹簧（位移 / 速度 /
       按压进度）实时驱动，按住底栏左右拖，指示器跟手，松手吸附到最近一格。
       那套依赖 Compose 的 backdrop / capsule 库，githup 是纯 WebView 拿不到，
       所以这里用「直接写 transform + CSS transition 分段」做近似：
         - 拖动中：关掉 transition，transform 直接跟随手指（绝不掉帧）
         - 松手后：打开 transition，用 cubic-bezier 做阻尼回弹
       回弹曲线抄的是 violet 的 value spring(1f, 1000f)：快起、慢收、几乎不过冲，
       对应 cubic-bezier(.2,.9,.2,1)。

       手势冲突的处理（这是能不能做成的关键）：
         底栏是 fixed 的独立层，不参与 #view 的滚动，所以横滑不会和页面滚动打架。
         但「竖直方向起手、结果横着划」这类误判必须挡掉 —— 起手 8px 内若纵向
         位移大于横向，判定为纵向手势直接放弃接管，交给系统。
       还有两件事 CSS 仍然还原不了，写在这里备忘：
         1. vibrancy()：真实的高光色分离（下面用 saturate()+blur() 逼近）
         2. lens()：透镜折射边缘，CSS 没有对应能力 */
    _tabIdx: -1,
    _indSx: 1,
    _indSy: 1,
    _indX: 0,        // 拖动中的实时位移（px，相对胶囊内衬）
    _dragging: false,

    _tabStep: function () {
      var bar = document.getElementById('tabbar');
      var n = UI.$$('#tabbar .tab').length || 1;
      return bar && bar.clientWidth > 0 ? (bar.clientWidth - 8) / n : 0;
    },

    paintTabIndicator: function () {
      var bar = document.getElementById('tabbar');
      var ind = document.getElementById('tab-ind');
      if (!bar || !ind) return;
      var n = UI.$$('#tabbar .tab').length || 1;
      ind.style.setProperty('--tab-count', n);
      if (App._tabIdx < 0) ind.classList.add('idle');
      else ind.classList.remove('idle');
      var x = App._dragging ? App._indX : App._tabIdx * App._tabStep();
      if (App._tabIdx < 0 && !App._dragging) x = 0;
      ind.style.transform = 'translateX(' + x.toFixed(2) + 'px) scale(' +
        App._indSx + ',' + App._indSy + ')';
    },

    /* 拖动中直接把位移喂进去，不经过任何缓动 */
    dragTabIndicator: function (x) {
      App._indX = x;
      App.paintTabIndicator();
    },

    /* 按压时压扁指示器，松开回弹 —— violet 的 pressedScale = 78/56 那路 check */
    setTabIndicatorScale: function (sx, sy) {
      App._indSx = sx; App._indSy = sy;
      App.paintTabIndicator();
    },

    setTab: function (name) {
      var idx = -1;
      UI.$$('#tabbar .tab').forEach(function (t, i) {
        var on = t.getAttribute('data-tab') === name;
        t.classList.toggle('active', on);
        if (on) idx = i;
      });
      App._tabIdx = idx;
      App.paintTabIndicator();
    },

    /* 拖动结束：吸附到最近一格并切页。
       阈值取半格，和 violet 的「过半即切」一致；即使没到半格也会回弹到原格，
       所以不会出现「松手后停在两格中间」这种脏状态。 */
    settleTabIndicator: function () {
      var step = App._tabStep();
      var idx = step > 0 ? Math.round(App._indX / step) : 0;
      var n = UI.$$('#tabbar .tab').length;
      idx = Math.max(0, Math.min(n - 1, idx));
      App._dragging = false;
      var tabs = UI.$$('#tabbar .tab');
      var name = tabs[idx] && tabs[idx].getAttribute('data-tab');
      var map = { home: '/', notifications: '/notifications', explore: '/explore', search: '/search', profile: '/profile' };
      if (name && idx !== App._tabIdx) {
        App.setTab(name);
        if (map[name]) Router.go(map[name]);
      } else {
        App.paintTabIndicator();
      }
    },

    updateBadge: function (n) {
      var b = document.getElementById('tab-badge');
      if (n === undefined) return;
      if (n > 0) { b.hidden = false; b.textContent = n > 99 ? '99+' : n; }
      else b.hidden = true;
    },

    refreshBadge: function () {
      if (!window.Session.isLogin) { this.updateBadge(0); return Promise.resolve(); }
      return window.API.get('/notifications', { per_page: 1, all: 'false' }).then(function (r) {
        var h = r.headers || {};
        var rem = h['x-ratelimit-remaining'];
        var link = r.link && r.link.last ? r.link.last : null;
        // 未读数用列表长度估算（未读视图）
        var n = (r.data || []).length;
        App.updateBadge(n > 0 ? n : 0);
      }).catch(function () {});
    }
  };
  window.App = App;

  /* ---------------- 路由解析 ---------------- */
  function parseHash(hash) {
    var raw = (hash || '').replace(/^#/, '');
    if (!raw || raw === '/') return { name: 'feed', ctx: {} };
    var qi = raw.indexOf('?');
    var query = {};
    if (qi >= 0) {
      raw.substring(qi + 1).split('&').forEach(function (kv) {
        if (!kv) return;
        var p = kv.split('=');
        query[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
      });
      raw = raw.substring(0, qi);
    }
    var segs = raw.split('/').filter(function (s) { return s !== ''; }).map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });
    var first = (segs[0] || '').toLowerCase();

    if (segs.length === 1) {
      if (RESERVED.indexOf(first) < 0) return { name: 'user', ctx: { login: segs[0], query: query } };
      if (first === 'gist') return null;
    }
    switch (first) {
      case 'login': return { name: 'login', ctx: { query: query } };
      case 'notifications': return { name: 'notifications', ctx: { query: query } };
      case 'explore': return { name: 'explore', ctx: { query: query } };
      case 'search': return { name: 'search', ctx: { query: query } };
      case 'settings': return { name: 'settings', ctx: { query: query } };
      case 'downloads': return { name: 'downloads', ctx: { query: query } };
      case 'profile': return { name: 'profile', ctx: { query: query } };
      case 'totp': return { name: 'totp', ctx: { query: query } };
      case 'gists': return { name: 'gists', ctx: { query: query } };
      case 'gist': return { name: 'gist', ctx: { id: segs[1], query: query } };
      case 'issues': return { name: 'issuesMine', ctx: { query: query } };
      case 'pulls': return { name: 'pullsMine', ctx: { query: query } };
    }

    if (segs.length >= 2) {
      /* ref 在这里兜一次底：/owner/repo?ref=main 这种「只换了分支」的链接
         （解析 GitHub 链接时会产出这种形式），不带过来就默认分支。
         tree/blob 分支后面还会按 ?ref= 再算一遍路径，两边不冲突。 */
      var ctx = { owner: segs[0], repo: segs[1], query: query, tab: 'code', ref: query.ref || '' };
      if (segs.length === 2) return { name: 'repo', ctx: ctx };
      var sub = segs[2];
      if (sub === 'tree' || sub === 'blob') {
        ctx.kind = sub;
        /* ref 优先走 ?ref=：分支名 / 标签名常常自带斜杠（feature/login、
           release/v1.2），放在路径里只能靠 %2F 撑着不被拆成两段，而部分
           WebView 会把 %2F 又解码回 '/'，结果 ref 只剩第一段、后半截被当成
           文件路径 —— 表现出来就是「切到这个分支却说什么都找不到」。
           查询参数不参与 split('/')，带几个斜杠都稳。
           旧的 /tree/<ref>/<path> 形式继续认，老链接和历史记录不失效。 */
        var from = 3;   // 文件路径从第几段开始
        if (query.ref) {
          ctx.ref = query.ref;   // ref 在查询参数里，路径就紧跟着 tree/blob
        } else {
          ctx.ref = segs[3] || '';
          from = 4;              // 旧格式：第 3 段让给 ref
        }
        ctx.path = segs.slice(from).join('/');
        // blob 后面没跟路径就当目录看，否则会拿空路径去要文件内容，必然 404
        if (sub === 'blob' && !ctx.path) ctx.kind = 'tree';
        return { name: 'repo', ctx: ctx };
      }
      if (sub === 'issues' && segs[3]) return { name: 'issue', ctx: Object.assign(ctx, { tab: 'issues', number: segs[3] }) };
      if (sub === 'pull' && segs[3]) return { name: 'issue', ctx: Object.assign(ctx, { tab: 'pulls', number: segs[3], isPR: true }) };
      if (sub === 'actions' && segs[3]) return { name: 'run', ctx: Object.assign(ctx, { tab: 'actions', id: segs[3] }) };
      if (sub === 'releases') {
        /* tag 优先走 ?tag=：标签名自带斜杠的仓库不止一家（release/2026-09），
           放在路径里会被 split('/') 切成好几段，只剩第一段去查 ——
           必然 404。查询参数不参与分段，带几个斜杠都稳，
           和上面 tree/blob 的 ref 是同一处考虑。
           老形式（第 4 段即 tag）继续认，历史链接不失效。 */
        if (query.tag) return { name: 'release', ctx: Object.assign(ctx, { tab: 'releases', tag: query.tag }) };
        if (segs[3]) return { name: 'release', ctx: Object.assign(ctx, { tab: 'releases', tag: segs[3] }) };
      }
      if (sub === 'commit' && segs[3]) return { name: 'commit', ctx: Object.assign(ctx, { tab: 'commits', sha: segs[3] }) };
      // 仓库子页白名单：不在名单里的第 3 段会被当成文件路径，
      // 所以每加一个 tab 都必须来这里登记，否则点进去只会落到代码页
      var allow = ['issues', 'pulls', 'actions', 'releases', 'commits', 'contributors', 'branches', 'tags', 'settings', 'stargazers', 'watchers', 'forks', 'milestones', 'collaborators'];
      if (allow.indexOf(sub) >= 0) { ctx.tab = sub; return { name: 'repo', ctx: ctx }; }
      return { name: 'repo', ctx: ctx };
    }
    return { name: 'feed', ctx: {} };
  }

  /* ---------------- 路由控制 ---------------- */
  // 标签根页面：这些是「顶层」，从它们再返回应当退出应用而不是继续回退
  /*
    标签根页面：底部五个并列的一级入口（首页 / 通知 / 探索 / 搜索 / 我的）。
    在它们之间横向切换不堆历史、也不算「深入一层」。

    这里**只放底部标签**，别把 /downloads、/login 这类也算进来：
    下载管理和登录页是从右上角入口或流程里进去的内页，有各自的返回按钮，
    用户按返回时期望「退回到刚才那个页面」，而不是被甩回首页。
    定这份名单的判据是「底部导航栏上有没有它的位置」，不是「路径看起来短不短」。
  */
  var TAB_ROOTS = ['/', '/notifications', '/explore', '/search', '/profile'];

  /**
   * 这个路径是不是「某个仓库的 tab 层」—— /owner/repo 后面最多只跟一个 tab 名
   * （代码 / 议题 / 拉取请求 / Actions / 发布 / 更多，以及「更多」里进去的
   * 提交记录、分支、标签、贡献者、里程碑…）。
   *
   * 是的话返回 'owner/repo' 作为「同一个仓库」的判据，否则返回 null。
   *
   * 文件浏览（tree / blob）、议题详情、Release 详情、提交详情都不算 ——
   * 那些是从 tab 再往里走的一层，返回要先退回它自己的 tab，不能直接跳到代码页。
   */
  function repoTabKey(hashOrPath) {
    var r = parseHash(hashOrPath || '');
    if (!r || r.name !== 'repo') return null;
    var c = r.ctx || {};
    if (!c.owner || !c.repo) return null;
    if (c.kind || c.number || c.sha || c.tag || c.id) return null;
    return c.owner + '/' + c.repo;
  }

  /**
   * 应用内路由深度。
   * 不从 history.length 推断（那个值包含应用外的历史），而是自己计数：
   * pushState 前进 +1，popstate / replace 回退 -1，下限 0。
   */
  var routeDepth = 0;

  /**
   * 统一的「向前导航」：写入历史栈并渲染。
   * 用 pushState 而不是 location.hash —— 后者在部分 WebView 下与
   * goBack() 配合不稳定（回退后 hash 与历史条目对不上，页面不刷新）。
   */
  function pushRoute(path) {
    var target = '#' + path;
    var base = location.pathname + location.search;
    // 已经在目标页：原地重渲染即可，不要再堆一条历史
    if (location.hash === target) { Router.render(); return; }

    /*
      标签根页面之间横向切换：只在「当前也确实在标签页」时才 replace，
      不堆历史条目。底部标签是并列的一级入口，来回切不该在历史里留痕 ——
      留了就会变成「首页→通知→探索→按返回，退到通知，再返回退到首页，
      再返回才退出」，返回键像是在把标签倒着走一遍。

      但「从详情页点标签栏」不能算横向：那是真的往回退了一层，必须 push，
      否则 replace 会把详情页那条历史覆盖掉，用户再按返回就直接退出了。
      判据因此是「当前位置也是标签页」——注意比的是当前位置，不是目标位置。
    */
    // 横向 = 当前位置是标签根页（不管目标是哪，详情页回标签一定走 push）
    var hereIsRoot = Router.isRoot(location.hash || '#/');
    var isLateral = hereIsRoot && Router.isRoot(path);
    /*
      同一个仓库里换 tab（代码 → 议题 → 发布…）也算横向，同样不堆历史。

      这跟底部标签是同一个道理：那一排 tab 是仓库页内部的并列视图，来回切
      不该在历史里留痕 —— 留了就成了「议题 → 拉取请求 → 发布 → 按返回退到
      拉取请求 → 再退到议题」，返回键在把刚才走过的 tab 倒着走一遍，而用户
      想的是「退出这个 tab，回代码」。

      配合 handleBack 里那条「不在代码 tab 就回到代码」，历史栈里始终只有
      「进仓库前那一页 + 当前 tab」两条，一次返回到代码、再一次返回出仓库。

      只认 tab 层：从议题详情回议题列表、从文件浏览回仓库根，都是真的退了一层，
      必须 push，否则 replace 会把详情那条历史盖掉，用户再按返回就退出仓库了。
    */
    if (!isLateral) {
      var tk1 = repoTabKey(location.hash), tk2 = repoTabKey(path);
      if (tk1 && tk2 && tk1 === tk2) isLateral = true;
    }
    if (isLateral) {
      if (window.history && history.replaceState) {
        history.replaceState({ ghRoute: true, depth: routeDepth, lateral: true }, '', base + target);
        Router.render();
        return;
      }
      location.replace(target);
      Router.render();
      return;
    }
    routeDepth++;
    try {
      if (window.history && history.pushState) {
        history.pushState({ ghRoute: true, depth: routeDepth, lateral: false },
            '', base + target);
        Router.render();
        return;
      }
    } catch (e) { /* 降级 */ }
    location.hash = target;
    setTimeout(function () {
      if (location.hash === target && Router.current !== target) Router.render();
    }, 30);
  }

  var Router = {
    current: null,
    /* 每个路由的滚动位置。返回时按路由还原，避免「点进详情再返回回到顶部」*/
    scrollMemo: Object.create(null),
    backNav: false,          // 本次 render 是不是「回退」触发的
    go: function (path) {
      path = path || '/';
      if (path.charAt(0) !== '/') path = '/' + path;
      var target = '#' + path;
      if (location.hash === target) { this.reload(); return; }
      /*
        注意：这里不能对标签根页面用 location.replace。
        replace 会「替换」当前历史条目而不是新增，导致从某个详情页点首页后
        再按返回键直接退出应用（回不到原来的详情页）。
        统一用 pushState：既产生历史条目，又能自定义状态。
      */
      pushRoute(path);
    },
    /** 替换当前历史条目（登录跳转、退出登录等「不该回退」的场景用） */
    replace: function (path) {
      path = path || '/';
      if (path.charAt(0) !== '/') path = '/' + path;
      var target = '#' + path;
      if (location.hash === target) { this.render(); return; }
      var base = location.pathname + location.search;
      if (window.history && history.replaceState) {
        // replace 不改变层级：登录成功等场景要「抹掉」上一页而不是堆叠
        history.replaceState({ ghRoute: true, replace: true, depth: routeDepth }, '', base + target);
        Router.render();
      } else {
        location.replace(target);
        setTimeout(function () { Router.render(); }, 30);
      }
    },
    reload: function () { this.render(); },
    /** 当前路由是否属于「标签根页面」（首页 / 通知 / 探索 / 搜索 / 我的） */
    isRoot: function (path) {
      var p = (path || '').replace(/^#/, '').split('?')[0];
      return p === '' || p === '/' || TAB_ROOTS.indexOf(p) >= 0;
    },

    /**
     * 是否还有可回退的上一层。
     *
     * 只看纵向深度，不看「当前在不在标签页」。
     *
     * 这里原来还有一条兜底：深度为 0 但当前停留在某个标签页时，也返回 true，
     * 想着「让用户能退回起始页」。但它跟 pushRoute 里的 isLateral 是矛盾的 ——
     * 横向切标签时深度故意不加（pushRoute 里 `if (!isLateral) routeDepth++`），
     * 兜底却反过来认定「横向也有一层可退」。结果是：
     *
     *   首页 → 点「通知」→ 点「探索」→ 按返回
     *   退到「通知」→ 再按返回 → 退到「首页」→ 再按返回 → 才退出
     *
     * 用户看到的就是「返回键在标签页之间倒着走一遍」。底部五个标签是并列的
     * 一级入口，来回切不该攒出返回层 —— 在任何一个标签页按返回，都应当是
     * 「没有上一层了」，交给「再按一次退出」。
     *
     * 纵向层级（详情页、议题、Release…）不受影响，仍然逐级回退。
     */
    canGoBack: function () {
      return routeDepth > 0;
    },
    render: function () {
      var hash = location.hash || '#/';
      /*
        渲染纪元（viewEpoch）：每进一次 render 就换一把新令牌。

        为什么需要它 —— 页面的异步回调会裸写 #view。

        各页面的 render 都是「先同步铺骨架，再发请求，等响应回来把内容
        写进 host」。这条链有个致命的竞态：响应比用户的返回键慢时，
        回调落地时页面已经换了人 —— 回调不知道，照旧 host.innerHTML = ...
        把刚画好的新页面整个覆盖掉。实测路径：

          搜索页点进仓库 → 详情接口还没回 → 按返回（路由已画好搜索页、
          顶栏已是「搜索」）→ 仓库响应这时才落地 → 搜索页被整个顶掉，
          屏幕上变成「顶栏是搜索、内容是仓库详情」的缝合画面。

        搜索页自己有 renderSeq 防护（page-home.js），但那是补丁不是制度 ——
        首页 / 仓库 / 议题 / 用户…全都裸奔。现在把令牌升级到 Router：
        render 一进来就递增，页面在 render 里把当前纪元拍下来，
        异步回调落地前先对一下纪元，对不上就整份丢弃（含错误框，
        错误框同样会把新页面顶掉）。写子容器（#tabbody、#nlist 这类）
        的回调不需要这个 —— 页面被清空后子容器已脱离文档，写了也看不见。
      */
      Router.viewEpoch = (Router.viewEpoch || 0) + 1;
      // 离开上一页前记下滚动位置，回退时要还原（议题 #2）
      var prev = document.getElementById('view');
      if (prev && Router.current && Router.current !== hash) {
        Router.scrollMemo[Router.current] = prev.scrollTop;
      }
      Router.current = hash;
      var r = parseHash(hash);
      if (!r) { location.hash = '#/'; return; }
      /* 保存当前匹配到的路由（页面名 + ctx），供下载等逻辑判断
         「现在身处议题还是 Release」，不用各处再去解析 hash */
      Router.route = r;
      var page = P[r.name] || P.feed;
      var host = document.getElementById('view');
      var restore = Router.backNav ? (Router.scrollMemo[hash] || 0) : 0;
      host.innerHTML = '';
      host.scrollTop = 0;
      App.setActions([]);
      document.getElementById('fab').hidden = true;

      var noTab = !!page.noTab;
      document.getElementById('tabbar').hidden = noTab;
      host.classList.toggle('no-tabbar', noTab);
      App.showBack(!noTab && !(page.tab) && hash !== '#/' && !isTabPath(hash));

      var title = typeof page.title === 'function' ? page.title(r.ctx) : (page.title || 'githup');
      var sub = typeof page.subtitle === 'function' ? page.subtitle(r.ctx) : page.subtitle;
      App.title(title, sub);
      App.setTab(page.tab || '');
      if (page.menu) {
        App.setActions([{
          icon: 'kebab-horizontal', onClick: function () {
            UI.menu('菜单', page.menu()).then(function (k) { if (k && page.onMenu) page.onMenu(k); });
          }
        }]);
      }

      UI.loading(true);
      var done = function () {
        UI.loading(false);
        if (restore) requestAnimationFrame(applyRestore);
      };
      /*
        还原滚动位置：页面内容可能是异步画出来的，所以先同步来一次
        （搜索结果这类有缓存、同步出内容的页面立刻就位），
        内容撑开后再来一次，避免高度不够被夹回 0。
      */
      function applyRestore() { host.scrollTop = restore; }
      try {
        var ret = page.render(r.ctx, host);
        if (restore) applyRestore();
        if (ret && ret.then) ret.then(done, done); else done();
      } catch (e) {
        done();
        host.innerHTML = UI.errorBox(e);
      }
      var path = hash.substring(1);
      var qi = path.indexOf('?');
      if (qi > 0) path = path.substring(0, qi);
      window.Store.set('lastPath', path);
    }
  };
  window.Router = Router;

  /**
   * 这个路径在不在底部导航栏上。
   *
   * 名单直接复用 TAB_ROOTS，不另抄一份 —— 之前两处各写一遍，改了一处漏了
   * 另一处，就是「下载管理被当成底部标签」这类问题的温床。
   */
  function isTabPath(hash) {
    var h = (hash || '').replace(/^#/, '').split('?')[0];
    return TAB_ROOTS.indexOf(h) >= 0;
  }

  /* ---------------- 底部导航 ----------------
     按压反馈和拖动都统一由胶囊那一层的 pointer 处理（见下方 initTabDrag），
     这里只留点击。指针事件会从按钮冒泡到胶囊，所以不需要在按钮上再挂一遍 ——
     挂两遍的后果是 setTabIndicatorScale 被调用两次，松手时的回弹会打架。 */
  UI.$$('#tabbar .tab').forEach(function (t) {
    t.onclick = function () {
      var name = t.getAttribute('data-tab');
      var map = { home: '/', notifications: '/notifications', explore: '/explore', search: '/search', profile: '/profile' };
      // 先落指示器再跳路由：否则要等页面渲染完才动，手感像是「点了没反应」
      App.setTab(name);
      Router.go(map[name]);
    };
  });
  // 胶囊宽度随视口变化，等分步长要跟着重算，旋屏/分屏后指示器才不会错位
  window.addEventListener('resize', function () { App.paintTabIndicator(); });

  /* ---------------- 底栏跟手拖动 ----------------
     把整条胶囊当成一个可拖的滑块：按住往左右划，指示器实时跟手，
     松手吸附到最近一格并切页。

     为什么用 pointer 事件而不是 touch：
       pointer 一套就能覆盖触摸和鼠标，桌面调试和真机行为一致，
       setPointerCapture 还能保证手指划出胶囊范围也不会丢事件。

     为什么必须做「纵向放弃」判定：
       底栏只有 64px 高，用户很容易在划页面时误触到它。起手 8px 内如果
       纵向位移大于横向，判定不是横滑手势，直接不接管 —— 否则页面就划不动了。
     下面两个监听器一个挂胶囊、一个挂每个 tab：
       - 挂胶囊：处理在胶囊空白处（内衬、格子之间）起手的情况
       - 挂 tab：处理从按钮上起手的情况，按钮自身有 :active 反馈，两边都要管 */
  (function initTabDrag() {
    var bar = document.getElementById('tabbar');
    if (!bar) return;
    var startX = 0, startY = 0, baseX = 0, moved = false, decided = false, active = false, pid = null;

    function onDown(e) {
      if (App._tabIdx < 0) return;       // 无选中页（详情页）时底栏是隐藏的
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      active = true; pid = e.pointerId;
      startX = e.clientX; startY = e.clientY;
      baseX = App._tabIdx * App._tabStep();
      App._indX = baseX;
      moved = false; decided = false;
      App.setTabIndicatorScale(1.06, .9);
    }

    function onMove(e) {
      if (!active || e.pointerId !== pid) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (!decided) {
        // 前 8px 定性质：纵向为主就放弃，把页面滚动的权利还给用户
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = true;
        if (Math.abs(dy) > Math.abs(dx)) { onCancel(); return; }
        App._dragging = true;
        // 接管之后关掉过渡，位移直接跟手，绝不能有缓动延迟
        bar.classList.add('dragging');
        var ind = document.getElementById('tab-ind');
        if (ind) ind.style.transition = 'none';
        try { bar.setPointerCapture(pid); } catch (err) {}
      }
      moved = true;
      var step = App._tabStep();
      var max = step * ((UI.$$('#tabbar .tab').length || 1) - 1);
      // 拖到两端之外要有阻尼：位移按 1/3 折算，给出「到头了」的手感
      var x = baseX + dx;
      if (x < 0) x = x / 3;
      else if (x > max) x = max + (x - max) / 3;
      App.dragTabIndicator(x);
    }

    function finish(e) {
      if (!active || (e && e.pointerId !== pid)) return;
      active = false;
      bar.classList.remove('dragging');
      var ind = document.getElementById('tab-ind');
      if (ind) ind.style.transition = '';
      App.setTabIndicatorScale(1, 1);
      if (App._dragging) {
        try { bar.releasePointerCapture(pid); } catch (err) {}
        App.settleTabIndicator();
      }
      App._dragging = false;
      pid = null;
    }

    function onCancel(e) {
      if (!active || (e && e.pointerId && e.pointerId !== pid)) return;
      active = false; decided = true;
      bar.classList.remove('dragging');
      var ind = document.getElementById('tab-ind');
      if (ind) ind.style.transition = '';
      App.setTabIndicatorScale(1, 1);
      App._dragging = false;
      App.paintTabIndicator();   // 回弹到当前格
      pid = null;
    }

    bar.addEventListener('pointerdown', onDown);
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', finish);
    bar.addEventListener('pointercancel', onCancel);

    // 拖动结束后浏览器还会补一个 click。如果不拦，松手就会顺手把
    // 「手指停在哪一格的按钮」也点一遍，出现切了两页的怪事。
    bar.addEventListener('click', function (e) {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    }, true);
  })();

  /* ---------------- 启动 ---------------- */
  /**
   * 清掉历史版本遗留在 localStorage 里的明文令牌。
   *
   * 早期版本把令牌用明文存在 gh_token / gh_saved_token 两个键里。
   * 现在虽然不写了，但老用户升级上来之后那两个键还在原地躺着 ——
   * 必须主动抹掉，否则修了等于没修。
   */
  function purgeLegacyToken() {
    try {
      ['gh_token', 'gh_saved_token'].forEach(function (k) {
        if (localStorage.getItem(k) !== null) localStorage.removeItem(k);
      });
    } catch (e) {}
  }

  function start() {
    purgeLegacyToken();
    window.iconFill();
    App.applySafeInsets(); // 必须先拿真实状态栏高度：顶栏高度和 #view 的让位量都依赖它
    App.detectGlassSupport(); // 玻璃能力要早于 applyNav，CSS 降级规则才能落在首帧
    App.applyTheme();
    App.applyNav();      // 底栏风格要**赶在首帧之前**定下来，否则会看到一次形态跳变
    // 旋转屏幕 / 分屏 / 手势导航切换都会改变安全区，跟着重算
    window.addEventListener('resize', function () { App.applySafeInsets(); });
    window.addEventListener('orientationchange', function () { App.applySafeInsets(); });
    /* 系统主题变化的监听。媒体查询这条只在浏览器/支持的 WebView 上有效，
       所以另外挂在 AppOnResume 上（见下）—— 从系统设置改完主题切回 App 时，
       Activity 会 resume，那时再对一次系统的权威值，保证跟随系统不跑偏。 */
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', function () { if (window.Store.get('theme') === 'auto') App.applyTheme(); });
    }

    var token = window.Session.init();
    var boot = function () {
      document.getElementById('splash').remove();
      document.getElementById('app').hidden = false;
      var hash = location.hash;
      if (!hash || hash === '#' || hash === '#/') {
        var startTab = window.Store.get('startTab') || 'home';
        var map = { home: '/', notifications: '/notifications', explore: '/explore', profile: '/profile' };
        if (startTab !== 'home' && window.Session.isLogin) location.replace('#' + map[startTab]);
        else if (startTab !== 'home') location.replace('#/');
      }
      Router.render();
      App.refreshBadge();
      /*
        首次启动自动播一遍新手引导。
        只在「从没看过 / 看过的是旧版本」时弹，跳过或看完都会记状态，
        之后不再打扰；设置 → 新手指导 可以随时重看。
        放在这里而不是 start() 开头：要等 Router.render() 把首屏画出来，
        否则遮罩会盖在一个空白页面上，洞也定位不到任何东西。
      */
      try { if (window.Onboarding) window.Onboarding.autoStart(); } catch (e) { /* 引导挂了也不能影响启动 */ }
      setInterval(function () { App.refreshBadge(); }, 120000);
      /* 右上角下载入口的角标：2 秒一刷（没入口时函数自己立刻返回，不打扰） */
      setInterval(function () { App.refreshDownloadBadge(); }, 2000);

      /*
        打开软件的瞬间就检查更新 —— 不等延时、不等界面渲染完。
          有新版本：第一位变化弹不可关闭的强制更新，第二、三位给可选按钮
          已是最新：什么都不做，跟没检查过一样
          断网或取不到：静默，不打扰
        每次打开都会真的去查一次，所以新版本随时能在下次打开时被发现。
      */
      try { if (window.Updater) window.Updater.startCheck(); } catch (e) { /* 检查失败不影响使用 */ }

      /*
        从后台切回前台时再查一次（离上次超过 30 分钟才算）。
        很多人是关屏再亮、切走再回来的，这时候也该有机会发现新版本。
      */
      try {
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden && window.Updater) {
            try { window.Updater.resumeCheck(); } catch (e) { /* 忽略 */ }
          }
        });
      } catch (e) { /* 忽略 */ }
    };

    if (token) {
      window.API.me().then(function (r) {
        /* r.data 必须是对象才认。
         * 解析失败（网络层把 body 弄丢、返回空串等）时 r.data 是 null，
         * 这里若直接赋值，后面任何读 user.login 的地方都会抛
         * "Cannot read properties of null"，整个首页白屏只剩一个报错。
         * 与其让一处小故障炸掉整个页面，不如当成「没登录」继续启动。 */
        if (r && r.data && typeof r.data === 'object') {
          window.Session.user = r.data;
        } else {
          window.Session.user = null;
        }
        boot();
      }).catch(function (e) {
        if (e.status === 401) {
          window.Session.clear();
          UI.toast('登录状态已失效，请重新登录');
        }
        boot();
      });
    } else boot();

    window.addEventListener('hashchange', function () {
      /*
        回退时 popstate 已经渲染过（并且还原了滚动位置），这里再渲染一次
        会把刚还原的位置冲掉 —— hash 没变就跳过。
      */
      if ((location.hash || '#/') === Router.current) return;
      Router.backNav = true;      // 单独由 hashchange 触发的，多半也是前进/后退
      Router.render();
      Router.backNav = false;
    });

    /*
      浏览器/系统返回键的回退入口。
      用 popstate 而不是只靠 hashchange：pushState 产生的条目不会触发
      hashchange，只有 popstate 能捕获回退，并用 state.depth 还原层级。
    */
    window.addEventListener('popstate', function (e) {
      var d = e && e.state && typeof e.state.depth === 'number' ? e.state.depth : null;
      if (d !== null) routeDepth = Math.max(0, d);
      else routeDepth = Math.max(0, routeDepth - 1);
      Router.backNav = true;
      Router.render();
      Router.backNav = false;
    });

    /*
      下拉刷新（顶部下拉手势）

      这里必须做「手势方向判定」，否则会误伤所有横向滚动的条：仓库页那一排
      tab（代码/议题/拉取请求/Actions/发布/更多）、文件树的面包屑，都是
      overflow-x: auto 的横向滚动容器。手指横着划不可能绝对水平，必然带竖向
      抖动，只按 dy 判断的话，dy 攒到 70px 就触发 reload —— 用户看到的就是
      「在 tab 栏上拖一下，页面自己刷新了，还把拉到最右的位置弹回最左」。

      判定规则（一次手势只判定一次，判定后不再改判）：
        1. 起点落在某个可横向滚动的容器里 → 这次手势归那个容器，页面不接管；
        2. 否则比较 |dx| 与 |dy|：横向位移占优 → 同样放弃；
        3. 只有明确是竖向下拉（dy > 0 且竖向占优）才继续走刷新逻辑。

      另外：判定前留 8px 死区，手指刚落下时的微小抖动不参与判定，避免
      「点一下 tab 就被判成横向」这种误杀（真要竖向下拉的人不会只动 8px）。
    */
    var view = document.getElementById('view');
    var startX = 0, startY = 0, pulling = false, decided = false, xHost = null;
    var DEAD_ZONE = 8, REFRESH_DIST = 70;

    /** 从 target 往上找第一个真正能横向滚动的祖先（含自身），找不到返回 null */
    function findScrollableX(el) {
      while (el && el !== view && el.nodeType === 1) {
        if (el.scrollWidth - el.clientWidth > 2) {
          var ox = window.getComputedStyle(el).overflowX;
          if (ox === 'auto' || ox === 'scroll') return el;
        }
        el = el.parentElement;
      }
      return null;
    }

    view.addEventListener('touchstart', function (e) {
      if (view.scrollTop > 0 || !e.touches || !e.touches[0]) { pulling = false; return; }
      var t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      pulling = true; decided = false;
      xHost = findScrollableX(e.target);
    }, { passive: true });

    view.addEventListener('touchmove', function (e) {
      if (!pulling || !e.touches || !e.touches[0]) return;
      var t = e.touches[0];
      var dx = t.clientX - startX, dy = t.clientY - startY;

      if (!decided) {
        if (Math.abs(dx) < DEAD_ZONE && Math.abs(dy) < DEAD_ZONE) return;
        decided = true;
        // 起点在横向滚动容器里，或手指主要在横着走 → 交给那个容器，页面不接管
        if (xHost || Math.abs(dx) > Math.abs(dy)) { pulling = false; return; }
      }
      if (dy > REFRESH_DIST && view.scrollTop <= 0) {
        pulling = false; UI.haptic();
        // 下拉刷新同样要先清缓存：菜单「刷新」和下拉手势都只是 Router.reload，
        // 而不少页面（首页 /user 60s、/user/repos 30s、搜索 5 分钟）带内存缓存，
        // 不清的话手势拉到底、请求却命中旧缓存，用户看到的就是「拉了没反应」。
        try { window.API.clearCache(); } catch (e) {}
        Router.reload();
      }
    }, { passive: true });

    function endPull() { pulling = false; decided = false; xHost = null; }
    view.addEventListener('touchend', endPull, { passive: true });
    view.addEventListener('touchcancel', endPull, { passive: true });

    // 兜底委托：任何带 data-go / data-p 的元素都能导航
    // 用标记位去重，已单独绑定 onclick 的元素不会重复触发
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var hit = t.closest('[data-go],[data-p]');
      if (!hit || hit.__bound) return;
      var dest = hit.getAttribute('data-go') || hit.getAttribute('data-p');
      if (dest) { e.preventDefault(); window.Router.go(dest); }
    }, true);

    // 外链统一交给系统浏览器
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
      if (!a) return;
      /* 正文里的图片让路：GitHub 把上传的截图包在 <a target=_blank> 里，
       * 点图片应该看大图（md.js 绑的），长按才是打开这个链接页。
       * 这里挂在捕获阶段，跑在 img 自己的 onclick 之前 —— 不让路的话
       * 内嵌浏览器直接就开了，「查看大图」永远轮不到出场。 */
      if (e.target.tagName === 'IMG' && e.target.closest('.md')) return;
      e.preventDefault();
      var href = a.getAttribute('href') || '';
      if (/^(mailto:|tel:|https?:)/i.test(href)) {
        if (window.NativeBridge && NativeBridge.openExternal) NativeBridge.openExternal(href);
        else window.open(href, '_blank');
      }
    }, true);

    // 原生侧触发的刷新/返回
    window.AppOnResume = function () {
      App.refreshBadge();
      /* 安全区可能变了（横竖屏、导航方式切换、部分机型状态栏高度随设置变化），
         每次回前台都对一次。 */
      App.applySafeInsets();
      /* 从系统设置里改完深浅色再切回来时，WebView 的媒体查询往往不触发，
         这里借 resume 重新对一次系统的权威值，保证「跟随系统」不跑偏。 */
      if ((window.Store.get('theme') || 'auto') === 'auto') App.applyTheme();
    };

    initKeyboardAware();
  }

  /**
   * 键盘感知：把键盘占用的高度写入 CSS 变量 --kb，并同步 --vvh（可视视口高度）。
   * 底部弹层据此抬到键盘之上，保证表单输入框始终可见。
   *
   * 关键点：这里不能依赖「窗口变小」来判断键盘，因为 WebView 在 adjustPan 下
   * 窗口尺寸不变；统一用 visualViewport 与 layout viewport 的高度差来算。
   */
  function initKeyboardAware() {
    var vv = window.visualViewport;
    var root = document.documentElement;
    var raf = 0;

    function measure() {
      var layoutH = window.innerHeight || root.clientHeight || 0;
      var vvH = (vv && vv.height) ? vv.height : layoutH;
      var kb = Math.max(0, Math.round(layoutH - vvH));
      // 小于一个键盘的最小高度时视为没弹出，避免地址栏收缩等噪声
      if (kb < 120) kb = 0;
      var prev = root.style.getPropertyValue('--kb');
      var next = kb + 'px';
      if (prev !== next) root.style.setProperty('--kb', next);
      root.style.setProperty('--vvh', Math.round(vvH) + 'px');
      root.classList.toggle('kb-open', kb > 0);

      // 键盘弹出后，把当前聚焦的输入框滚进可视区域
      if (kb > 0) {
        var ae = document.activeElement;
        if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) {
          setTimeout(function () {
            try { ae.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { ae.scrollIntoView(); }
          }, 60);
        }
        // 焦点不在输入框（例如在按钮上触发）时，把弹层里第一个被键盘遮住的控件滚出来
        ensureSheetVisible();
      }
    }

    /**
     * 弹层内容可能在视口之外（例如底部弹层里的靠下字段）。
     * 键盘弹出后，把第一个落在键盘线以下的表单控件滚进可视区。
     */
    function sheetBottomLimit() {
      return window.innerHeight - (parseInt(root.style.getPropertyValue('--kb'), 10) || 0);
    }

    function ensureSheetVisible() {
      setTimeout(function () {
        var sheetRoot = document.getElementById('sheet-root');
        if (!sheetRoot || !sheetRoot.classList.contains('show')) return;
        var body = sheetRoot.querySelector('.sheet-body');
        if (!body) return;
        var limit = sheetBottomLimit();
        var bodyRect = body.getBoundingClientRect();
        // 点击目标必须是「弹层内可见区域底部」与「键盘线」中的较小值
        var visibleBottom = Math.min(limit, bodyRect.bottom);
        var nodes = body.querySelectorAll('input, textarea, select, .upload-box');
        for (var i = 0; i < nodes.length; i++) {
          var r = nodes[i].getBoundingClientRect();
          if (r.height > 0 && r.bottom > visibleBottom - 8) {
            // 需要往下滚的距离 = 目标底边超出可见底部的部分 + 一点余量
            var delta = r.bottom - visibleBottom + 16;
            var max = Math.max(0, body.scrollHeight - body.clientHeight);
            body.scrollTop = Math.min(max, body.scrollTop + delta);
            // 滚动到底仍露不出来（内容比可视区还高很多）时，用块居中兜底
            if (nodes[i].getBoundingClientRect().bottom > visibleBottom) {
              try { nodes[i].scrollIntoView({ block: 'center' }); } catch (e) {}
            }
            return;
          }
        }
      }, 120);
    }

    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; measure(); });
    }

    if (vv) {
      vv.addEventListener('resize', schedule);
      vv.addEventListener('scroll', schedule);
    }
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);

    // 输入框获得焦点时也要重新测量（部分机型键盘动画结束才更新尺寸）
    document.addEventListener('focusin', function () { schedule(); setTimeout(schedule, 260); }, true);

    // 弹层打开时重置一次，避免上一个页面的键盘状态残留
    window.addEventListener('hashchange', function () { root.style.setProperty('--kb', '0px'); });

    measure();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

/* ============================================================
   顶栏发丝线（iOS 15+ 行为）
   iOS 的导航栏在「内容滚到它下面之前」是完全没有下边框的，
   看上去跟背景融成一片；只有内容开始从下面穿过去，底边才浮出
   一条 0.5px 的发丝线，用来把导航栏和内容划开。
   这条线没法纯靠 CSS 判断，得跟着滚动状态开关类名。
   样式只在 data-nav="glass" 下生效，关掉玻璃就回到原本的样子。
   ============================================================ */
(function () {
  var bar = document.getElementById('appbar');
  var view = document.getElementById('view');
  if (!bar || !view) return;

  var last = null;
  function sync() {
    var on = (view.scrollTop || 0) > 1;
    if (on === last) return;
    last = on;
    bar.classList.toggle('is-scrolled', on);
  }

  view.addEventListener('scroll', sync, { passive: true });
  // 切页面后滚动位置归零，类名要跟着撤掉
  window.addEventListener('hashchange', function () { setTimeout(sync, 60); });
  sync();
})();
