/* ============================================================
 * onboarding.js — 新手指导（边做边学的高亮引导）
 * ------------------------------------------------------------
 * 设计要点：
 *
 * 1. 「挖洞」遮罩
 *    不用 SVG mask、也不用 clip-path —— 一个透明的 div 配一圈
 *    `box-shadow: 0 0 0 9999px` 就是遮罩，洞里能看到真实界面。
 *    老 WebView 也认 box-shadow，clip-path 在部分 ROM 上会锯齿。
 *
 * 2. 每一步自己声明在哪一页、高亮谁
 *    跨页的步骤会先 Router.go(route)，再轮询等目标元素出现。
 *    页面是异步渲染的（骨架同步、内容异步），所以必须轮询，
 *    直接 querySelector 会拿到 null。
 *
 * 3. 拿不到目标就退化成居中弹窗
 *    任何一个环节出问题（接口挂了、页面结构变了、选择器写错），
 *    都不能把用户卡在遮罩里。超时 2.5 秒直接当「没有目标」继续走。
 *
 * 4. 随时可跳过
 *    「跳过」放在气泡按钮行的最右边（不另占屏幕一角），系统返回键也等同跳过
 *    （在 App.handleBack 里挂的）。
 *    跳过和看完都会记状态，下次不再自动弹；设置里可以手动重看。
 *
 * 5. 关键步骤要「真的动手」—— 这是这一版最大的改动
 *    光看一遍记不住，尤其是长按这类没有任何视觉提示的功能：
 *    用户压根不知道那个按钮能长按。所以带 act 的步骤会：
 *      · 遮罩自己不吃点击（pointer-events:none），能点的只有气泡本身；
 *      · 在 document 上用**委托**监听对应手势（元素被重渲染也不会丢）；
 *      · 判定命中后不打断 —— 真实功能照常发生（长按翻译按钮会真的弹出菜单）；
 *      · 命中后遮罩先退到弹层背后（.behind），让用户把弹出来的东西看清楚，
 *        1.3 秒后关掉弹层、自动进入下一步。
 *    用委托而不是直接给元素挂监听：下拉刷新、点设置项都会 Router.reload()
 *    重建整片 DOM，挂在元素上的监听会随旧节点一起被扔掉。
 *
 * 6. 只允许点「这一步的目标」，其余点击一律吞掉
 *    放开点击是为了让人真的操作，代价就是可能点错地方跳走。
 *    所以捕获阶段有 guard：不在当前目标内的 click 直接拦掉并轻提示。
 *    展示型步骤（没有 act）保持原来的全拦策略，跟手点的风险不值得冒。
 * ============================================================ */
(function () {
  'use strict';

  var KEY = 'onboarded';      // Store 里的键
  /* 引导升级成「边做边学」：步骤数、内容和玩法都变了，
     版本号 +1 让已经看过旧版引导的老用户也重新走一遍。 */
  var VERSION = 2;

  /* ---------------- 步骤表 ----------------
     route   这一步要先跳到哪个页面（不填 = 停在当前页）
     target  要高亮的选择器（不填 = 居中弹窗，没有洞）
     round   true 强制用圆形洞（图标按钮这类）
     act     这一步要用户真的做一下（不填 = 看一眼点「下一步」）
       kind  tap 点一下 / long 按住不放 / drag 横向拖 / pull 顶部下拉
       sel   要操作的元素（不填 = 用 target）
       ms    长按判定毫秒数（默认 500）
       hint  气泡里那句「怎么做」的提示
       win   做对之后给的那句确认（顺手把功能再讲一遍） */
  var STEPS = [
    {
      title: '欢迎使用 githup',
      body: '把 GitHub 装进口袋：看动态、收通知、搜仓库、逛趋势，都在这一个 App 里。' +
            '<br>这段引导是<b>边做边学</b>的：有几步会请你真的动手试一下，' +
            '做对了会自动往下走，做不出来也可以点「跳过这步」。' +
            '<br>不想看了，随时点卡片右下角的<b>「跳过」</b>。'
    },
    {
      title: '顶栏：你在哪',
      body: '左边是当前页面的标题。进入二级页面时，最左边会多出一个返回箭头。' +
            '<br>这一栏永远停在屏幕顶部，内容滚动时它不动。',
      target: '#appbar'
    },
    {
      title: '右上角：藏着的下载管理',
      body: '这排图标里最右边那枚<b>收纳箱</b>是下载管理：正在下的 Release 包在这里看进度。' +
            '<br>它常年待在右上角、没有任何文字，是最容易一直没被发现的入口 —— 先点它一下试试。',
      target: '#appbar-actions',
      act: {
        kind: 'tap',
        sel: '.dl-action',
        hint: '点一下右上角那枚收纳箱图标',
        win: '这就是下载管理，以后下 Release 包都在这儿看进度'
      }
    },
    {
      title: '下载管理：任务都在这儿',
      body: 'Release 包、源码包的下条都列在这里，能看到进度、暂停和失败原因。' +
            '<br>右上角那枚图标在任何页面都有，下完东西回来点它就行。',
      route: '/downloads'
    },
    {
      title: '底栏：五个主入口',
      body: '<b>首页</b>看关注的动态，<b>通知</b>收 GitHub 消息，<b>探索</b>逛趋势榜，' +
            '<b>搜索</b>找仓库/用户/代码，<b>我的</b>是你的主页和设置。',
      route: '/home',
      target: '#tabbar'
    },
    {
      title: '底栏还能「拖」着走',
      body: '这枚胶囊上<b>左右拖动可以跟手切换</b>：手指往哪边划，下面的指示条就跟到哪边，' +
            '松手吸附到最近的一格。比一格一格点要快。',
      route: '/home',
      target: '#tabbar',
      act: {
        kind: 'drag',
        hint: '按住底栏胶囊，往左或往右拖出一段距离',
        win: '就是这个手感 —— 拖过头会吸附到最近一格'
      }
    },
    {
      title: '隐藏手势：下拉刷新',
      body: '页面滚到顶之后，<b>按住屏幕往下拖一段再松手</b>就能刷新当前页。' +
            '<br>没有刷新按钮，也没有转圈的提示 —— 这个手势只能自己发现，现在你发现了。',
      act: {
        kind: 'pull',
        sel: '#view',
        hint: '在页面上按住，往下拖出一大段再松手',
        win: '刷新就是这么触发的，随时能用'
      }
    },
    {
      title: '隐藏按钮：翻译键能长按',
      body: '右上角的<b>译</b>字按钮：点一下翻译本页 / 再点还原；' +
            '<b>长按它会打开翻译设置</b> —— 换引擎、开自动翻译、清缓存都在里面。' +
            '<br>长按在界面上没有任何提示，是这里最容易被漏掉的一个按钮。',
      target: '#tr-btn',
      round: true,
      act: {
        kind: 'long',
        ms: 500,
        hint: '按住这个「译」按钮不放，大约 1 秒',
        win: '菜单弹出来了：换引擎、自动翻译、清缓存都在里面'
      }
    },
    {
      title: '翻译菜单里还有什么',
      body: '刚才那个菜单里可以：<b>切换引擎</b>（默认自动，多个引擎一起上）、' +
            '开<b>自动翻译</b>（进页面自己翻，不用点）、<b>清缓存</b>。' +
            '<br>再往下还有一层：菜单里点<b>翻译引擎</b>，在列表里' +
            '<b>长按某一条可以直接用浏览器打开它的官网控制台</b>去拿密钥 —— ' +
            '百度翻译、有道开放平台、小牛翻译三家都走这条路，密钥只存在本机。' +
            '<br>不想填也能用，自动模式会自己挑能用的免费口子。',
      target: '#tr-btn',
      round: true
    },
    {
      title: '搜索：从关键词开始',
      body: '输入关键词，点右边的<b>搜索</b>（或按回车）。' +
            '<br>框里的 × 是一键清空；下方的<b>排序</b>和<b>筛选</b>可以按语言、Star 数再收窄结果。',
      route: '/search',
      target: '.search-bar'
    },
    {
      title: '搜索：先选类型再搜',
      body: '这几个标签决定你搜的是<b>仓库</b>、<b>用户</b>、<b>代码</b>还是<b>议题</b>。' +
            '<br>先选类型再搜，命中率会高很多。',
      route: '/search',
      target: '#tabs'
    },
    {
      title: '探索：时间范围和语言',
      body: '趋势榜的时间范围在这里切：<b>今日 / 本周 / 本月</b>，' +
            '它筛的是「这段时间内新创建的仓库」，和 Star 总数榜不是一回事。' +
            '<br>下面那排<b>语言标签可以左右滑</b>，点一个就只剩那一种语言。',
      route: '/explore',
      target: '.seg-wrap'
    },
    {
      title: '隐藏手势：通知长按进多选',
      body: '通知列表里<b>按住任意一条不放</b>，就进入多选模式：底部浮出操作栏，' +
            '可以勾选、全选、批量删除。' +
            '<br>点一下是打开这条通知，长按才是多选 —— 没有任何角标提示。',
      route: '/notifications',
      target: '.notif',
      act: {
        kind: 'long',
        ms: 500,
        hint: '按住列表里任意一条通知不放',
        win: '底部这条操作栏就是多选，勾完可以批量删'
      }
    },
    {
      title: '设置：界面风格你说了算',
      body: '这个开关是<b>iOS风格</b>：开启时底栏是悬浮的磨砂胶囊（默认开），' +
            '关掉就回到朴素样式。<b>机型较老、觉得卡</b>的时候可以关掉它。',
      route: '/settings',
      target: '[data-s="glass"]'
    },
    {
      title: '设置里还有「再来一次」',
      body: '<b>新手指导</b>是现在立刻再看一遍，<b>重置新手引导</b>是抹掉「已看过」的记录、' +
            '下次打开 App 自动重播。' +
            '<br>点一下重置试试 —— 反正看完这段我们会把它记成「已看过」。',
      route: '/settings',
      target: '[data-s="guideReset"]',
      act: {
        kind: 'tap',
        hint: '点一下「重置新手引导」这行',
        win: '下次打开 App 会自己重播这段引导'
      }
    },
    {
      title: '就这些，开始用吧',
      body: '<b>刚才这些藏起来的：</b>' +
            '<br>· 右上角收纳箱 = 下载管理' +
            '<br>· 底栏可以左右拖着切页' +
            '<br>· 页面顶部下拉 = 刷新' +
            '<br>· 译字按钮<b>长按</b> = 翻译设置' +
            '<br>· 翻译引擎列表里<b>长按</b> = 去官网拿密钥' +
            '<br>· 通知条目<b>长按</b> = 多选批量删' +
            '<br>想再看一遍，随时来 <b>设置 → 新手指导</b>。' +
            '<br>登录后还能收通知、评论 Issue、Star 仓库——去「我的」页面登录即可。'
    }
  ];

  var S = {
    on: false, i: 0, startHash: '', waitTimer: null,
    win: false,          // 当前这步的动手任务是否已做对
    okTimer: null,       // 做对之后「让真实效果露个脸」的那 1.3 秒
    nagTimer: null,      // 迟迟没动手时的软提示
    nudged: false
  };
  var D = null;   // DOM 引用，ensureDom() 里建

  /* ---------------- DOM ---------------- */
  function ensureDom() {
    if (D) return D;
    var root = document.createElement('div');
    root.id = 'ob-root';
    /* 翻译脚本会遍历文本节点往外发请求，引导文案本来就是中文，
       标上 data-no-translate 免得白跑一趟（translate.js 的 SKIP_SEL 认这个）。 */
    root.setAttribute('data-no-translate', '1');
    root.innerHTML =
      '<div id="ob-hole"></div>' +
      '<div id="ob-ring"></div>';
    document.body.appendChild(root);

    /* 气泡特意挂在 body 上、而不是 #ob-root 里面：
       #ob-root 需要在弹层弹出时整体降到弹层背后（.behind），
       而 position:fixed 的元素自己就是一个层叠上下文，里面的子元素
       永远逃不出去 —— 弹层一出来气泡就会跟着被盖住，用户既看不到
       「✓ 就是这个」，也点不到里面的按钮。挂成兄弟节点后两者的
       z-index 各算各的，遮罩退下去、气泡照常浮在最上面。
       「跳过」现在是气泡按钮行里的一枚，跟着气泡走。 */
    var tip = document.createElement('div');
    tip.id = 'ob-tip';
    tip.setAttribute('data-no-translate', '1');
    tip.innerHTML =
      '<div id="ob-step"><span id="ob-step-text"></span><span id="ob-step-num"></span></div>' +
      '<div id="ob-progress"><i></i></div>' +
      '<div id="ob-title"></div>' +
      '<div id="ob-body"></div>' +
      '<div id="ob-hint" hidden></div>' +
      '<div id="ob-win" hidden></div>' +
      '<div id="ob-actions">' +
        '<button class="ob-btn" id="ob-prev" type="button" hidden>上一步</button>' +
        /* 「跳过」就放在按钮行最右边，不另占屏幕一角：原来那枚常驻右上角的
           胶囊会压住顶栏的图标（真机反馈「有点挡」），而它一条水平线上正好
           是页面的菜单/下载/翻译三个按钮 —— 引导本来就要求用户点到那里去。
           这不是一个需要随时能摸到的逃生口：系统返回键在任何一步都等同跳过。 */
        '<button class="ob-btn" id="ob-skip" type="button">跳过</button>' +
        '<button class="ob-btn" id="ob-next" type="button">下一步</button>' +
      '</div>';
    document.body.appendChild(tip);

    D = {
      root: root,
      tip: tip,
      hole: root.querySelector('#ob-hole'),
      ring: root.querySelector('#ob-ring'),
      title: tip.querySelector('#ob-title'),
      body: tip.querySelector('#ob-body'),
      hint: tip.querySelector('#ob-hint'),
      win: tip.querySelector('#ob-win'),
      num: tip.querySelector('#ob-step-num'),
      bar: tip.querySelector('#ob-progress > i'),
      prev: tip.querySelector('#ob-prev'),
      next: tip.querySelector('#ob-next'),
      skip: tip.querySelector('#ob-skip')
    };

    D.next.onclick = function () { go(S.i + 1); };
    D.prev.onclick = function () { if (S.i > 0) go(S.i - 1); };
    D.skip.onclick = function () { quit(); };
    window.addEventListener('resize', function () { if (S.on) locate(); });
    window.addEventListener('orientationchange', function () {
      if (S.on) setTimeout(locate, 260);
    });
    return D;
  }

  /** 这一步要操作/高亮的选择器 */
  function selOf(step) {
    return (step.act && step.act.sel) || step.target || '';
  }

  /* ---------------- 点击守卫 ----------------
     动手步骤要放开点击，可放开的只有「这一步的目标」。
     其余 click 一律吞掉：引导期间跳到别的页面，人就找不回来了。 */
  function guard(e) {
    if (!S.on || !D) return;
    if (S.win) return;                       // 已经做对了：放开手，让人看真实效果
    var t = e.target;
    if (D.tip.contains(t) || t === D.skip || D.tip === t) return;
    var step = STEPS[S.i];
    if (step && step.act) {                  // 动手步骤：目标内的点击放行
      var sel = selOf(step);
      if (sel && t && t.closest && t.closest(sel)) return;
    }
    e.preventDefault();
    e.stopPropagation();
    nudge();
  }

  var nudgeAt = 0;
  function nudge() {
    var now = Date.now();
    if (now - nudgeAt < 2600) return;
    nudgeAt = now;
    try {
      if (window.UI && UI.toast) {
        UI.toast(STEPS[S.i] && STEPS[S.i].act
          ? '先按提示做这一步，做完会自动往下走'
          : '引导进行中，先看完或点卡片里的「跳过」');
      }
    } catch (e) {}
  }

  /* ---------------- 轮询等元素 ----------------
     页面骨架是同步渲染的，但有的块要等接口回来才有，所以轮询。
     超时就返回 null —— 调用方会退化成居中弹窗，绝不把人卡住。 */
  function waitFor(sel, cb) {
    clearTimeout(S.waitTimer);
    if (!sel) return cb(null);
    var t0 = Date.now();
    (function poll() {
      var node = null;
      try { node = document.querySelector(sel); } catch (e) { node = null; }
      if (node) return cb(node);
      if (Date.now() - t0 > 2500) return cb(null);
      S.waitTimer = setTimeout(poll, 80);
    })();
  }

  /* ---------------- 定位洞和气泡 ---------------- */
  function locate() {
    if (!D) return;
    var step = STEPS[S.i];
    var sel = selOf(step);
    var node = sel ? document.querySelector(sel) : null;
    var r0 = node ? node.getBoundingClientRect() : null;

    /* 没有目标，或者目标小到看不见（比如右上角还没有任何按钮时
       #appbar-actions 是空的）—— 都退化成居中弹窗。
       给一个 8px 的门槛：高亮一个 2px 的空壳没有任何意义。 */
    if (!node || !r0 || r0.width < 8 || r0.height < 8) {
      D.root.classList.add('no-target');
      /* ⚠️ 必须把内联样式清掉。
         上一步写过 left/top/width/height，内联的优先级高于
         `#ob-root.no-target #ob-tip { left:50%; top:50% }` 那条规则，
         不清的话居中那两步的气泡会跑到屏幕外面去（欢迎页实测 x=-156）。 */
      D.tip.style.left = '';
      D.tip.style.top = '';
      [D.hole, D.ring].forEach(function (n) {
        n.style.left = ''; n.style.top = '';
        n.style.width = ''; n.style.height = '';
      });
      return;
    }
    D.root.classList.remove('no-target');

    /* 目标在可滚动区域里且不在视口内时，先滚进来再量。
       fixed 的顶栏/底栏调这个没有副作用。 */
    try {
      var vh0 = window.innerHeight;
      if (r0.top < 0 || r0.bottom > vh0) {
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    } catch (e) {}

    var vw = window.innerWidth, vh2 = window.innerHeight;
    var r = node.getBoundingClientRect();
    var pad = 6;
    var x = Math.max(0, r.left - pad);
    var y = Math.max(0, r.top - pad);
    var w = Math.min(Math.max(24, r.width + pad * 2), vw - x);
    var h = Math.min(Math.max(24, r.height + pad * 2), vh2 - y);

    var round = !!step.round || (w <= 56 && h <= 56);
    [D.hole, D.ring].forEach(function (n) {
      n.classList.toggle('round', round);
      n.style.left = x + 'px';
      n.style.top = y + 'px';
      n.style.width = w + 'px';
      n.style.height = h + 'px';
    });

    /* 气泡：优先放洞下方，放不下就放上方，再不行就居中。
       顶部只留出状态栏那条 —— 「跳过」已经收进气泡里，不再占顶栏下方那 56px。 */
    var tipW = D.tip.offsetWidth, tipH = D.tip.offsetHeight;
    var gap = 12;
    var minTop = (parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--safe-t')) || 0) + 12;
    var top;
    if (vh2 - (y + h) >= tipH + gap + 12) top = y + h + gap;
    else if (y >= tipH + gap + 12) top = y - tipH - gap;
    else top = Math.max(minTop, Math.min(vh2 - tipH - 12, (vh2 - tipH) / 2));
    if (top < minTop) top = minTop;

    var left = x + w / 2 - tipW / 2;
    left = Math.max(12, Math.min(vw - tipW - 12, left));
    D.tip.style.left = left + 'px';
    D.tip.style.top = Math.max(minTop, Math.min(top, vh2 - tipH - 12)) + 'px';
  }

  /* ---------------- 动手任务 ----------------
     监听一律挂在 document 上做委托：下拉刷新、点设置项都会触发
     Router.reload() 把整片 DOM 换掉，挂在具体元素上的监听会随旧节点
     一起被回收，第二次就再也收不到事件了。委托 + closest 不受影响。 */
  var TASK = null;

  function clearTask() {
    if (TASK) {
      TASK.forEach(function (h) {
        try { document.removeEventListener(h[0], h[1], h[2]); } catch (e) {}
      });
      TASK = null;
    }
    clearTimeout(S.okTimer);
    clearTimeout(S.nagTimer);
    S.nagTimer = null;
  }

  /** 这一下是不是落在当前目标上 */
  function isHit(node, sel) {
    if (!node || !sel) return false;
    try { return !!(node.closest && node.closest(sel)); } catch (e) { return false; }
  }

  function pointOf(e) {
    return (e.touches && e.touches[0]) || e || {};
  }

  /**
   * 给这一步装上「做对了就往下走」的判定。
   * 目标元素此刻不在页面上时返回 false，调用方会退化成普通展示步骤
   * （比如没登录的通知页里一条通知都没有，长按自然无从谈起）。
   */
  function armTask(step) {
    clearTask();
    var act = step.act;
    if (!act) return false;
    var sel = selOf(step);
    if (!sel) return false;
    try { if (!document.querySelector(sel)) return false; } catch (e) { return false; }

    var T = [];
    var add = function (ev, fn, opt) {
      var o = opt === undefined ? true : opt;
      document.addEventListener(ev, fn, o);
      T.push([ev, fn, o]);
    };
    var passive = { capture: true, passive: true };

    if (act.kind === 'tap') {
      add('click', function (e) { if (isHit(e.target, sel)) succeed(act); });

    } else if (act.kind === 'long') {
      var hold = act.ms || 500, timer = null, sx = 0, sy = 0, moved = false;
      var down = function (e) {
        if (!isHit(e.target, sel)) return;
        var p = pointOf(e);
        sx = p.clientX || 0; sy = p.clientY || 0; moved = false;
        clearTimeout(timer);
        /* 判定比真实功能早一点点没关系：真实的长按（translate.js 520ms、
           UI.bindLongPress 500ms）本身就在同一时间量级上，用户看到的是
           「菜单弹出来了」，而不是「什么都没发生」。 */
        timer = setTimeout(function () { if (!moved) succeed(act); }, hold);
      };
      var mv = function (e) {
        var p = pointOf(e);
        if (Math.abs((p.clientX || 0) - sx) > 10 || Math.abs((p.clientY || 0) - sy) > 10) {
          moved = true; clearTimeout(timer);      // 手指挪开了：当成在滚页面
        }
      };
      var up = function () { clearTimeout(timer); };
      add('touchstart', down, passive);
      add('touchmove', mv, passive);
      add('touchend', up);
      add('touchcancel', up);
      add('mousedown', down);
      add('mousemove', mv);
      add('mouseup', up);
      add('mouseleave', up);

    } else if (act.kind === 'drag') {
      var x0 = null;
      add('pointerdown', function (e) { if (isHit(e.target, sel)) x0 = e.clientX; });
      add('pointermove', function (e) {
        if (x0 === null) return;
        if (Math.abs(e.clientX - x0) > 40) { x0 = null; succeed(act); }
      });
      add('pointerup', function () { x0 = null; });
      add('pointercancel', function () { x0 = null; });
      /* 老 WebView 没有 pointer 事件时退回 touch，别让这一步彻底做不了 */
      var tx0 = null;
      add('touchstart', function (e) { if (isHit(e.target, sel)) tx0 = pointOf(e).clientX; }, passive);
      add('touchmove', function (e) {
        if (tx0 === null) return;
        if (Math.abs(pointOf(e).clientX - tx0) > 40) { tx0 = null; succeed(act); }
      }, passive);
      add('touchend', function () { tx0 = null; });

    } else if (act.kind === 'pull') {
      var y0 = null;
      add('touchstart', function (e) { if (isHit(e.target, sel)) y0 = pointOf(e).clientY; }, passive);
      /* 阈值 75 比 app.js 里真实刷新的 70 略大：先让真刷新发生，
         再判这一步成功 —— 不然用户明明照着做了却没看到页面刷，会以为没生效。 */
      add('touchmove', function (e) {
        if (y0 === null) return;
        if ((pointOf(e).clientY || 0) - y0 > 75) { y0 = null; succeed(act); }
      }, passive);
      add('touchend', function () { y0 = null; });
    }

    TASK = T;
    /* 迟迟没做出来：给一句软提示，别让人对着屏幕猜。
       不做强制跳转 —— 有些人的机器上手势就是不太灵。 */
    S.nagTimer = setTimeout(function () {
      if (S.on && !S.win && window.UI && UI.toast) {
        UI.toast('做不出来也没关系，点「跳过这步」继续', 3000);
      }
    }, act.kind === 'long' ? 9000 : 7000);
    return true;
  }

  /** 做对了：先让真实效果露个脸，再进下一步 */
  function succeed(act) {
    if (!S.on || S.win) return;
    S.win = true;
    clearTask();
    try { if (window.UI && UI.haptic) UI.haptic(); } catch (e) {}

    /* 遮罩退到弹层背后（.behind），气泡本身还在最上面 ——
       这样长按翻译按钮弹出来的菜单、多选浮出来的操作栏都能被看见。
       不然「做了半天什么都没看到」，这一下就白教了。 */
    D.root.classList.add('behind');
    D.tip.classList.add('win');
    D.win.hidden = false;
    D.win.textContent = '✓ ' + (act.win || '就是这个');
    D.hint.hidden = true;
    D.next.textContent = '继续';

    S.okTimer = setTimeout(function () {
      if (!S.on) return;
      D.root.classList.remove('behind');
      try { if (window.UI && UI.closeSheet) UI.closeSheet(); } catch (e) {}
      go(S.i + 1);
    }, 1300);
  }

  /* ---------------- 走一步 ---------------- */
  function go(i) {
    if (i >= STEPS.length) return finish();
    S.i = i;
    var step = STEPS[i];

    /* 上一步的痕迹必须清干净：任务监听、成功态、退位用的 behind */
    clearTask();
    S.win = false;
    S.nudged = false;
    D.root.classList.remove('behind');
    D.tip.classList.remove('win');
    D.win.hidden = true;
    D.hint.hidden = true;

    if (step.route && window.Router) {
      var here = (location.hash || '#/').replace(/^#/, '').split('?')[0];
      if (here !== step.route) window.Router.go(step.route);
    }

    D.title.textContent = step.title;
    D.body.innerHTML = step.body;          // 内容是本文件里的常量，没有外部输入
    D.num.textContent = (i + 1) + ' / ' + STEPS.length;
    D.bar.style.width = ((i + 1) / STEPS.length * 100) + '%';
    D.prev.hidden = (i === 0);
    /* 重播一次气泡的进入动画：CSS animation 挂在元素上，只改内容不会重新播，
       强制回流一下才有效果（每步都有一点「冒出来」的感觉）。 */
    try {
      D.tip.style.animation = 'none';
      void D.tip.offsetWidth;
      D.tip.style.animation = '';
    } catch (e) {}

    waitFor(selOf(step), function () {
      if (!S.on) return;                   // 等待期间被关掉了
      locate();
      /* 目标没等到（接口没回、页面结构变了、未登录没数据）就退化成
         普通展示步骤：宁可这一步没教会，也不能把人卡在遮罩里。 */
      var armed = step.act ? armTask(step) : false;
      if (armed) {
        D.hint.hidden = false;
        D.hint.textContent = '动手试试：' + step.act.hint + '（做完自动进入下一步）';
        D.next.textContent = '跳过这步';
      } else {
        D.next.textContent = (i === STEPS.length - 1) ? '完成' : '下一步';
      }
      D.next.classList.toggle('ghost', armed);
    });
  }

  /* ---------------- 开始 / 结束 ---------------- */
  function start(opts) {
    opts = opts || {};
    if (S.on) return;                      // 已经在跑，不重复启动
    ensureDom();
    S.on = true;
    S.i = 0;
    S.startHash = (location.hash || '#/');
    D.root.classList.add('show');
    document.addEventListener('click', guard, true);
    go(0);
    /* 手动从设置里进来时给个提示，让人知道随时能退 */
    if (opts.manual && window.UI && UI.toast) UI.toast('点卡片里的「跳过」可随时退出引导');
  }

  function teardown() {
    S.on = false;
    S.win = false;
    clearTask();
    clearTimeout(S.waitTimer);
    document.removeEventListener('click', guard, true);
    if (D) {
      D.root.classList.remove('show', 'no-target', 'behind');
      D.tip.classList.remove('win');
      D.win.hidden = true;
      D.hint.hidden = true;
      [D.hole, D.ring].forEach(function (n) {
        n.style.width = '0px'; n.style.height = '0px';
      });
    }
  }

  /** 看完 / 跳过，都算「已经看过」，下次不再自动弹 */
  function finish() {
    markDone();
    var back = S.startHash && S.startHash !== '#' ? S.startHash : '#/';
    teardown();
    if (window.Router) {
      try { window.Router.replace(back.replace(/^#/, '')); } catch (e) { location.hash = back; }
    }
  }

  /** 返回键 / 点跳过：等同看完，也要回到进引导前的页面 */
  function quit() {
    markDone();
    var back = S.startHash && S.startHash !== '#' ? S.startHash : '#/';
    teardown();
    if (window.Router) {
      try { window.Router.replace(back.replace(/^#/, '')); } catch (e) { location.hash = back; }
    }
  }

  function markDone() {
    try { if (window.Store) window.Store.set(KEY, VERSION); } catch (e) {}
  }

  /* ---------------- 对外 ---------------- */
  window.Onboarding = {
    VERSION: VERSION,
    steps: STEPS,
    start: start,
    quit: quit,
    isActive: function () { return S.on; },
    isDone: function () {
      try { return window.Store ? (window.Store.get(KEY) || 0) >= VERSION : true; }
      catch (e) { return true; }
    },
    /** 首次启动自动弹：只看 Store，看过就不再打扰 */
    autoStart: function () {
      try { if (this.isDone()) return false; } catch (e) { return false; }
      var self = this;
      /* 等首屏画完再上遮罩，否则会盖在一个还没渲染好的页面上 */
      setTimeout(function () { if (!S.on) self.start(); }, 400);
      return true;
    },
    /** 重新看一遍（设置里的入口）：清掉状态再走一遍 */
    restart: function () {
      try { if (window.Store) window.Store.set(KEY, 0); } catch (e) {}
      start({ manual: true });
    },
    /**
     * 重置：只抹掉「已经看过」这个记录，回到刚装好的状态，**不立刻播放**。
     * 效果就是下次打开 App 时 autoStart() 会重新把引导走一遍。
     * 和 restart() 的区别：restart 是「现在就看」，reset 是「下次打开再看」。
     */
    reset: function () {
      try { if (window.Store) window.Store.set(KEY, 0); } catch (e) {}
      return true;
    }
  };
})();
