/* ============================================================
 * translate.js — 给 githup 加一个「翻译本页」
 *
 * 为什么需要它：
 *   GitHub 网页版能靠浏览器扩展 / 油猴脚本翻译，但 App 里的 WebView 装不了
 *   扩展，也没有注入脚本的入口。既然前端就是自己的，就把翻译做进前端本身。
 *
 * 工作方式：
 *   1. 收集当前页面里「值得翻译」的文本节点（跳过代码、路径、commit sha、
 *      @提及、#编号、版本号、已经是中文的内容…）
 *   2. 分批送到免费翻译引擎：微软 Edge → 有道 → DeepL → Google → MyMemory，
 *      哪个能用用哪个，也可以在菜单里手动指定
 *   3. 只改文本节点的 nodeValue，不动 DOM 结构 —— 所以点击、长按、下拉刷新
 *      这些事件一个都不会被破坏
 *   4. 再点一次原样还原（原文挂在节点上，不重建页面、不重新请求接口）
 *
 * 隐私：
 *   请求走 Native.http 原生通道。桥接层不会自动附加 GitHub Token（token 是
 *   前端显式拼进 headers 的，见 JsBridge.http），所以翻译请求不带任何凭据。
 *   但「被翻译的文本本身」会发给所选的翻译服务商 —— 这是翻译的前提，避免不了。
 *
 * 用法：在 index.html 里引入本文件即可，不需要改 app.js。
 *   有 #appbar-actions 时（App 内）：自动往右上角塞一个图标按钮
 *   没有时（浏览器 Demo）：退化成右下角悬浮按钮
 * ============================================================ */
(function () {
  'use strict';

  /* ================= 常量 ================= */
  /* 目标语言。以前写死 'zh-Hans'，整页只能往中文翻。
   * 现在可以在菜单里切换（见 pickTarget），默认仍是简体中文，
   * 老用户升级后行为跟以前完全一致。
   * 各引擎会把它换成自己的格式：有道 zh-CHS、Google zh-CN、DeepL ZH… */
  var TARGETS = [
    { key: 'zh-Hans', label: '简体中文', short: '中文' },
    { key: 'en', label: 'English（英文）', short: '英文' }
  ];
  var TARGET_DEFAULT = 'zh-Hans';
  var KEY_TARGET = 'gh_tr_target';
  function normalizeTarget(v) {
    for (var i = 0; i < TARGETS.length; i++) { if (TARGETS[i].key === v) return TARGETS[i].key; }
    return TARGET_DEFAULT;
  }
  var TO = normalizeTarget(prefGet(KEY_TARGET, TARGET_DEFAULT));
  var FROM = '';                      // 源语言，空 = 自动识别（交给引擎自己判断）
  var MAX_CHARS = 5000;               // 单批总字符上限（微软匿名端点保守值）
  var MAX_ITEMS = 40;                 // 单批最大段数
  /* 本地译文缓存条数上限。
   *
   * 以前是 600 —— 比一篇 README 自己还小。实测 donnemartin/system-design-primer
   * 有 1669 段，翻一遍必然把上限顶穿好几次；而淘汰又是 FIFO（超了就扔最早
   * 写入的 200 条），于是**文章自己后来的段把前面几屏挤出去了**。
   * 实测翻完这一篇：首屏那 35 段的译文在缓存里**一条都不剩** ——
   * 用户第二次进同一个仓库，第一屏又得从头翻一遍，这就是「还是特别慢」。
   *
   * 4000 够装下一篇超长 README（1669）+ 界面上的常驻词条，还有富余。
   * 代价算过：4000 条 JSON 约 182 KB，stringify 单次 0.9ms，
   * 而落盘是去抖 400ms 一次，一轮翻完也就写几次。 */
  var CACHE_MAX = 4000;               // 本地译文缓存条数上限
  var JSONP_TIMEOUT = 15000;
  var PROBE_TIMEOUT = 5000;           // 单个引擎探测超时
  /* 海外引擎 / 设备端翻译的「专属闸门」。
   *
   * 全局 REQ_TIMEOUT 是 15 秒 —— 对国内直连的引擎合适（慢归慢，等得起），
   * 但对「要么秒回、要么根本连不上」的那一类就是灾难：Google / DeepL 在国内
   * 大概率不可达，真机等的就是 15 秒的连接超时；设备端翻译在 WebView 上
   * 直接不响应。一组摊上它，整页就要等满这 15 秒才轮到接力。
   *
   * 所以给这类引擎单独一道 3 秒的闸门：3 秒没结果就判失败、交给下一家接力。
   * 3 秒足够判断「连不上」（正常一个翻译请求国内 200~800ms、海外 1~2 秒），
   * 又不会让整页陪着干等。撞了闸门会走 poolFail，连续几次就把它摘出转轮，
   * 后面的组根本不会再派给它 —— 损害被限制在头几组。
   *
   * ⚠️ 这道闸门**不足以**让海外引擎进池，光靠它实测把整页拖慢了 15 倍
   * （见下面 REACH_TTL 那段：闸门治「单次等多久」，治不了「反复派给死引擎」）。
   * 它现在的用处是：给已经准入的引擎在真翻的时候兜个底，
   * 以及给后台那次准入探测当超时。 */
  var SLOW_TIMEOUT = 3000;

  /* ===== 海外 / 设备端引擎的「准入资格」：先验证，再进池 =====
   *
   * 上一版（1.2.13 第一版）的做法是把它们直接放进协作池，想着多几家免费引擎
   * 总是好的，代价用「3 秒闸门 + 权重垫后 + 连续失败摘牌」三重措施兜住。
   * 实测这条路是错的，错得离谱：
   *
   *   手动指定「只用有道」翻同一页 ——
   *     v1.2.11：624ms（有道干 2 批、MyMemory 1 批）
   *     改完之后：9633ms（有道只干 1 批，DeepL 被派 6 次、Google 4 次、设备端 2 次）
   *   慢了 15 倍，而用户点的明明是「有道」。
   *
   * 为什么三重措施全没兜住：
   *   1) 闸门把单次从 8 秒砍到 3 秒 —— 听起来是改善，但它们被派了十几次，
   *      3 秒 × 十几次接力，整页照样 9.6 秒；
   *   2) 权重垫后只相对于有道一家 —— DeepL 权重 4 排第二位，页面只要超过一组
   *      它就上场了，而转轮里「所有慢引擎加起来」占了三分之二的位子；
   *   3) 摘牌要连续失败 3 次，前 3 批的学费已经交完了。
   *
   * 教训：**闸门治的是「单次等多久」，治不了「反复派给死引擎」。**
   *
   * 所以改成先验证、再准入 —— 能不能用，探一次说了算：
   *   · 探不过 → 压根不进池。国内用户永远走有道 + MyMemory 那条快车道，
   *               速度回到 v1.2.11 的水平（实测 608ms）。
   *   · 探过了 → 才准进池。此时它是真能干活的，不是来占位置的。
   *
   * 这样「免费引擎变多了」在国内就成了一句空话吗？不是 —— 它变成了
   * 「**能用的才算多**」：海外能通的环境、或者用户挂了代理，那几家
   * 探测一过就自动加入，和 1.2.11 里的有道 / MyMemory 一样是真在干活的引擎。
   * 而国内用户不会为了这个「多」付出 15 倍的代价。
   *
   * 探测在后台跑，不占首屏时间；结果记下来，30 分钟内不再重探
   * （换 WiFi、开代理、出国之后会重探一次）。 */
  var REACH_TTL = 10 * 60 * 1000;    // 探测结果的有效期（原来是 30 分钟，太长）
  var REACH_KEY = 'gh_tr_reach';     // { deepl: {ok:true, at:时间戳}, ... }
  var CONCURRENCY = 8;                // 逐条引擎的并发请求数
  /* 同时进行的批次数。以前这个值定义了却没用上，组并发是写死的 3 ——
   * 两边不一致，改常量的人以为自己调了并发，其实一点没变。现在接上。
   *
   * 3 对没有名额池的引擎（微软 / Google / MyMemory）是合适的：它们靠这个
   * 值压住突发。对有道却是白白挨一刀 —— 有道自己有全局名额池
   * （youdaoAcquire，上限 12），组并发压到 3 就等于把池子饿着：
   * 一篇 51 组的 README 要排 17 波，实测整篇收工 2448ms，
   * 放开到 6 之后 1726ms（再往上没有收益，池子才是真正的闸门）。
   * 所以组并发改由引擎自己报（见 ENGINES.youdao.parallel）。 */
  var BATCH_PARALLEL = 3;             // 同时进行的批次数（引擎可以覆盖）
  /* 首屏竞速：最靠近视口的那几组，同时交给两个引擎，谁先回用谁。
   *
   * 灵感来自 Easydict（macOS 上那个词典翻译 App）——它的卖点就是
   * 「can query multiple translation services at the same time」：一次输入，
   * 多家服务并列跑，用户最先看到的是最快的那一家。它翻的是一句话，
   * 并列展示本身就是功能；我们翻的是整页上千段，真把所有段都发两遍
   * 是拿配额换延迟，不划算。
   *
   * 但「首屏」这一段不一样：它是用户眼睛正盯着的地方，也是唯一一处
   * 「慢 = 明显体感」的地方。而常规路径上，一组只由一个引擎负责
   * （pickFor 按组转盘），那个引擎一旦偶发慢 —— 撞了限流正在合闸、
   * 网络抖了一下、对面机房抽风 —— 首屏就陪着它一起慢，后面几十组
   * 再快也补不回这个第一印象。
   *
   * 所以只在首屏这 1 组上开竞速：P50 变不了多少（快的那家本来就快），
   * 改善的是长尾 —— 正是「有时候特别慢」的那一半。
   *
   * 代价算过：只多花一组（40 段 / 5000 字符）的请求量，且慢到的那一家
   * 译文照样写进共享缓存（commit 写的是 '*' 那把 key），后面几组能接着用，
   * 不算白翻。上屏不会打架 —— apply 有 __tr_done 挡着，先到的占了坑，
   * 后到的自动跳过。 */
  var RACE_GROUPS = 1;                // 参与竞速的组数（0 = 关掉竞速）

  var KEY_ENGINE = 'gh_tr_engine';
  var KEY_CUSTOM = 'gh_tr_custom';
  /* 国内三家开放平台的凭据。它们都要签名才能调，但都是国内机房直连、
   * 额度比匿名接口大两个数量级，填一次就能让整页翻译换一档速度。
   * 密钥只存在本机（Store / localStorage），不上行、不随任何请求外发。 */
  var KEY_BAIDU_APPID = 'gh_tr_baidu_appid';
  var KEY_BAIDU_KEY = 'gh_tr_baidu_key';
  var KEY_YD_APPKEY = 'gh_tr_yd_appkey';
  var KEY_YD_SECRET = 'gh_tr_yd_secret';
  var KEY_NIU_KEY = 'gh_tr_niu_key';
  var KEY_CACHE = 'gh_tr_cache';
  var KEY_AUTO = 'gh_tr_auto';   // 总开关。默认关闭：装上不自动翻，
                                 // 用户亲手点开按钮才算同意翻译

  /* ================= 存储（App 用 Store，浏览器用 localStorage） ================= */
  function prefGet(k, def) {
    try {
      if (window.Store && typeof window.Store.getJSON === 'function') {
        var v = window.Store.getJSON(k, undefined);
        if (v !== undefined && v !== null) return v;
      }
    } catch (e) {}
    try {
      var raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : def;
    } catch (e) { return def; }
  }

  function prefSet(k, v) {
    /* Store.setJSON 内部已经是「桥梁 + localStorage」双写了，这里再补一次
     * localStorage.setItem 等于把整份数据序列化两遍、落盘两遍。
     * 单条设置（几字节）无所谓，但译文缓存几百条时这一倍是实打实的。
     * 只有 Store 这条路走不通时才退回 localStorage。 */
    var wrote = false;
    try {
      if (window.Store && typeof window.Store.setJSON === 'function') {
        window.Store.setJSON(k, v);
        wrote = true;
      }
    } catch (e) {}
    if (wrote) return;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }

  /* ================= 小工具 ================= */
  function hash(s) {
    var h = 5381, i = s.length;
    while (i) h = (h * 33) ^ s.charCodeAt(--i);
    return (h >>> 0).toString(36);
  }

  function norm(s) {
    return String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // 同一条提示 3 秒内只弹一次：自动补翻、页面定时刷新相对时间这些路径
  // 可能短时间内反复走到同一个提示，不节流的话会叠着弹个没完。
  var _lastToast = '', _lastToastAt = 0;
  function toast(msg) {
    var now = Date.now();
    if (msg === _lastToast && now - _lastToastAt < 3000) return;
    _lastToast = msg; _lastToastAt = now;
    if (window.UI && window.UI.toast) window.UI.toast(msg);
    else console.log('[translate] ' + msg);

    logTrouble(msg);
  }

  /* ============ 出错上报 ============
   * 翻译失败几乎都以 toast 的形式告诉用户（「所有翻译引擎都不可用」
   * 「翻译卡住了」…）。与其在十几个分支里各插一行，不如在这唯一的出口
   * 统一筛一遍：凡是明显是「出问题」的提示，就记进错误日志。
   *
   * 这样做的两个好处：
   *   1) 不会漏 —— 只要用户看到了提示，日志里就有；
   *   2) 不用改一堆分支 —— 老代码一个不动。
   *
   * 限流：同一条提示只记一次（toast 本身已有 3 秒节流，
   * 这里再按整场会话去重，避免自动重试把日志刷满）。 */
  var _loggedTrouble = {};
  /* 命中这些词的提示视为「出问题了」。用词要保守 ——
   * 宁可能量少记，也别把「已改用某引擎翻译」这种正常降级记成错误。 */
  var TROUBLE_WORDS = ['不可用', '失败', '出错', '错误', '卡住', '超时',
                       '无法', '没能', '没成功', '异常'];
  function logTrouble(msg) {
    try {
      if (!msg || typeof msg !== 'string') return;
      var hit = false;
      for (var i = 0; i < TROUBLE_WORDS.length; i++) {
        if (msg.indexOf(TROUBLE_WORDS[i]) >= 0) { hit = true; break; }
      }
      if (!hit) return;
      if (_loggedTrouble[msg]) return;      // 整场会话只记一次
      _loggedTrouble[msg] = 1;
      if (window.API && typeof window.API.logError === 'function') {
        window.API.logError('翻译：' + msg);
      }
    } catch (e) { /* 上报失败不影响翻译 */ }
  }

  function icon(name, size) {
    if (typeof window.icon === 'function') {
      try { var s = window.icon(name, size || 20); if (s) return s; } catch (e) {}
    }
    // 没有图标库时（浏览器 Demo）用文字兜底
    if (name === 'globe') return '译';
    if (name === 'x') return '原';
    return '';
  }

  /**
   * 并发跑任务，但最多同时跑 limit 个。
   * 逐条翻译的引擎（有道 / MyMemory / 设备端）原来是一条一条串着发的，
   * 72 段就是 72 次往返 —— 慢的根源就在这儿。改成 6 路并发后能快好几倍。
   * 失败的项填 null，由调用方兜底成原文，绝不让某一句卡住整批。
   */
  /**
   * abort 是「换页中止」的开关：一旦它为真，就不再起新任务，剩下的位置填 null
   * （调用方会兜成原文）。没有它的时候换页只是把 seq 加了 1，已经在飞的
   * 逐条请求一个都停不下来 —— 探索页一屏上百段，那些请求会继续把原生网络
   * 线程和有道的节流队列占满，新页面只能排在后面等。
   */
  function mapLimit(items, limit, fn, abort) {
    var out = new Array(items.length);
    var i = 0, active = 0;
    return new Promise(function (resolve) {
      if (!items.length) return resolve(out);
      function next() {
        while (active < limit && i < items.length) {
          if (abort && abort()) break;
          (function (idx) {
            active++;
            Promise.resolve()
              .then(function () { return fn(items[idx], idx); })
              .then(function (r) { out[idx] = r; }, function (e) {
                out[idx] = null;
                /* 单段失败在这里被吞掉的话，「引擎不可用」提示就带不出原因
                 * （真机上见过：有道全挂，提示却空着括号）。记下第一个错误。 */
                if (e && typeof state !== 'undefined' && state && !state.lastErr) {
                  state.lastErr = e.message || String(e);
                }
              })
              .then(function () { active--; next(); });
          })(i++);
        }
        /* 原来这里还要求 i >= items.length，中止时 i 到不了终点，
         * promise 就永远不 resolve —— 换页后新的一轮会被旧链挂住。 */
        if (active === 0) resolve(out);
      }
      next();
    });
  }

  /* ================= 网络 =================
   * App 内：走 Native.http（原生 Socket 实现，没有跨域限制，也不会自动带 token）
   * 浏览器：退回 fetch；再不行还能用 JSONP（script 注入，天然无视 CORS）
   */
  function hasBridge() {
    return !!(window.Native && typeof window.Native.http === 'function' &&
      window.Native.has && window.Native.has());
  }

  /* 网络请求超时：黑洞路由（连不上也不拒绝）会让请求挂到天荒地老，
   * 没有这层的话一个坏引擎就能把整页翻译卡住。默认 15 秒，可在
   * localStorage 里放 gh_tr_timeout 调整（毫秒）。 */
  var REQ_TIMEOUT = prefGet('gh_tr_timeout', 15000) | 0 || 15000;

  /* 原生通道：这里**必须传对象，不能自己 stringify**。
   *
   * 链路是两层，很容易搞混：
   *   translate.js ──▶ window.Native.http(method, url, body, headers)   ← api.js 的 JS 封装
   *                    它内部会 JSON.stringify(headers)，再调
   *                    ──▶ NativeBridge.http(id, method, url, body, headersJson)  ← Java
   *                        Java 侧签名是 String headersJson，做 new JSONObject(headersJson)。
   *
   * 以前在这里先 JSON.stringify 了一次，于是 Java 拿到的是「JSON 字符串的字符串」，
   * new JSONObject 直接抛异常 → 回调 status 0 → 原生通道每次都失败，
   * 只能退回 fetch 兜底。表现就是：只有服务端愿意给 CORS 头的引擎（有道 / MyMemory）
   * 能用，Google / DeepL 全灭，而且每个请求都要先失败一次再重试 —— 又慢又不全。
   * 所以传对象，让 api.js 去 stringify，只 stringify 一次。 */
  /* 原生通道默认带个浏览器 UA：Http.java 在没有 UA 时会写 HubMobile/1.0，
   * 有道 / DeepL 这类对非浏览器 UA 不太友好，容易直接拒。 */
  var DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  /* X-Hub-Reuse 是给原生 Http.java 看的“内部口令”，意思是：
   * 「这条请求重发一次也无所谓，你可以复用长连接、也可以发现连接死了就换新的再来一遍」。
   *
   * 为什么值得为它多此一举 —— 翻译以前慢得离谱的真正原因不在引擎：
   * aidemo.youdao.com 是个 HTTP/1.1 的服务，响应头里明明白白写着
   * Connection: keep-alive，可是 Http.java 里那句
   *     reusable = isGet && body == null
   * 只有 GET 能进连接池；翻译偏偏是 POST，于是**每个译文请求都要重开一次 TLS 握手**。
   * 实测一次请求的分段耗时：DNS 0.5ms / TCP 0.6ms / **TLS 握手 ~72ms** / 服务端处理 ~60ms，
   * 握手就吃掉一半以上；到了手机上一次握手 300~800ms，占比八成往上 ——
   * 「已经调过并发和分包了怎么还是慢」，答案就在这儿。
   *
   * 口令必须由调用方给：翻译天然幂等（同样的句子多译一遍而已），
   * 但 GitHub 的写操作（建 Issue、传附件）绝不能重试 —— 所以只有 translate.js
   * 这里的 nativeHttp 会带上它，api.js 那条通道一次也不带，保持原来一次成型的语义。
   *
   * 只加在原生通道上：浏览器 fetch 那边加任何自定义头都会触发 CORS 预检
   * （先飞一个 OPTIONS 过去），那才是真的变慢。头部也不会真发到服务器上，
   * Java 侧读完就剥掉了。 */
  function nativeHttp(method, url, body, headers) {
    var h = { 'User-Agent': DEFAULT_UA, 'X-Hub-Reuse': '1' };
    if (headers) { for (var k in headers) { if (Object.prototype.hasOwnProperty.call(headers, k)) h[k] = headers[k]; } }
    return window.Native.http(method, url, body || null, h)
      .then(function (res) {
        if (!res || !res.status || res.status >= 400) {
          throw new Error('HTTP ' + (res ? res.status : 0));
        }
        return res.body || '';
      });
  }
  function fetchHttp(method, url, body, headers) {
    var init = { method: method, mode: 'cors', credentials: 'omit', headers: headers || {} };
    if (body) init.body = body;
    return fetch(url, init).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }
  function request(method, url, body, headers) {
    // 原生通道优先（不受同源策略限制），它挂了就退回 fetch 再试一次
    var run = hasBridge()
      ? nativeHttp(method, url, body, headers).catch(function (e) {
        console.warn('[translate] 原生通道失败，退回 fetch', e && e.message);
        return fetchHttp(method, url, body, headers);
      })
      : fetchHttp(method, url, body, headers);
    return Promise.race([run, new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('请求超时')); }, REQ_TIMEOUT);
    })]);
  }

  var jsonpSeq = 0;
  /** JSONP：给浏览器环境留的后路（Google gtx 支持 callback） */
  function jsonp(url, param) {
    return new Promise(function (resolve, reject) {
      var name = '__tr_jsonp_' + (++jsonpSeq);
      var s = document.createElement('script');
      var timer = setTimeout(function () { cleanup(); reject(new Error('JSONP 超时')); }, JSONP_TIMEOUT);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[name]; } catch (e) { window[name] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
      }
      window[name] = function (data) { cleanup(); resolve(data); };
      s.onerror = function () { cleanup(); reject(new Error('JSONP 加载失败')); };
      s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + (param || 'callback') + '=' + name;
      document.head.appendChild(s);
    });
  }

  /* ================= 引擎 =================
   * 统一契约：translate(texts: string[]) => Promise<string[]>
   * 返回的数组必须与入参一一对应；某一段没译出来就返回原文，绝不错位。
   */

  var ENGINES = {};

  /* --- 0. 设备端翻译（浏览器 / WebView 内置，离线、文本不出设备） ---
   * 新版 Chromium 内置了 window.Translator（设备端翻译 API）。能不能用要看系统
   * 有没有下载对应的语言包，用不上就静默跳过，不打扰用户。
   * 注意：这个全局对象是浏览器原生的，所以本模块对外一律用 window.GhTranslator，
   * 绝不占用 Translator 这个名字。 */
  function onDeviceReady() {
    try {
      var T = window.Translator;
      return !!(T && typeof T.create === 'function');
    } catch (e) { return false; }
  }
  ENGINES.ondevice = {
    label: '设备端翻译（离线，系统内置）',
    batch: false,
    share: 2,
    /* 能不能用取决于系统有没有下载语言包，而且 availability() 本身
     * 在部分 WebView 上会永久挂起。不先探测就放进协作池，等于让每一批
     * 都有可能摊上一个「要先等一次失败」的引擎 —— 所以默认不进池，
     * 手动选中或降级时才会用到它（那时有超时保护）。 */
    timeoutMs: SLOW_TIMEOUT,
    needProbe: true,
    translate: function (texts, opts) {
      var abort = opts && opts.abort;
      var T = window.Translator;
      if (!T || typeof T.create !== 'function') return Promise.reject(new Error('不支持设备端翻译'));
      // 设备端翻译不支持 auto，源语言必须给死；绝大多数 GitHub 内容是英文
      var src = (FROM || 'en').split('-')[0];
      var tgt = TO === 'zh-Hans' ? 'zh' : TO.split('-')[0];
      // create/ready/translate 在部分 WebView 上会永久挂起（availability 同款毛病），
      // 手动选中这个引擎时没有任何探测保护，不超时就直接把 busy 卡死 —— 全链路 race。
      var withTimeout = function (pr) {
        return Promise.race([Promise.resolve(pr), new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('设备端翻译无响应')); }, REQ_TIMEOUT);
        })]);
      };
      return withTimeout(T.create({ sourceLanguage: src, targetLanguage: tgt }))
        .then(function (tr) {
          if (tr && tr.ready) return withTimeout(tr.ready).then(function () { return tr; });
          return tr;
        }).then(function (tr) {
          return mapLimit(texts, CONCURRENCY, function (t) {
            if (abort && abort()) return Promise.resolve(null);
            return withTimeout(tr.translate(t)).then(function (r) { return norm(r) || t; });
          }, abort).then(function (out) {
            return out.map(function (r, i) { return r || texts[i]; });
          });
        });
    }
  };

  /* --- 1. 微软 Edge 免费翻译 —— 已停用 ---
   * 微软已经关掉了 Edge 浏览器翻译的公开令牌接口：
   * https://edge.microsoft.com/translate/auth 现在直接返回 404，
   * 拿不到 JWT 就调不动 api-edge 翻译接口 —— 所以真机上选中它是「HTTP 404」，
   * 这不是代码写错了，是官方把免费门关了（同类工具如 Read Frog、pyVideoTrans
   * 也在同一时间报一样的 404）。
   * 实现留着、但从自动探测和手动选择里摘掉，免得你选中它只看到 404。
   * 哪天微软重新开放，把下面这行 retired 改成 false 就回来了。 */
  var edgeJwt = { v: '', t: 0 };
  function edgeAuth() {
    if (edgeJwt.v && Date.now() - edgeJwt.t < 8 * 60 * 1000) return Promise.resolve(edgeJwt.v);
    // JWT 有有效期（约 10 分钟），缓存 8 分钟，过期静默重取
    return request('GET', 'https://edge.microsoft.com/translate/auth', null, {})
      .then(function (t) {
        t = String(t || '').trim();
        if (!t) throw new Error('取不到 Edge 令牌');
        edgeJwt = { v: t, t: Date.now() };
        return t;
      });
  }
  ENGINES.edge = {
    label: '微软 Edge（免费）',
    batch: true,
    retired: true,                                   // 见上方说明：官方接口已 404
    retiredWhy: '已关闭免费接口，不再可用',
    translate: function (texts) {
      return edgeAuth().then(function (jwt) {
        var url = 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=' +
          encodeURIComponent(TO) + (FROM ? '&from=' + encodeURIComponent(FROM) : '');
        var body = JSON.stringify(texts.map(function (t) { return { Text: t }; }));
        return request('POST', url, body, {
          'Authorization': 'Bearer ' + jwt,
          'Content-Type': 'application/json'
        }).then(function (s) {
          var arr = JSON.parse(s);
          if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('返回结构不符');
          return arr.map(function (it, i) {
            var t = it && it.translations && it.translations[0] && it.translations[0].text;
            return t || texts[i];
          });
        });
      });
    }
  };

  /* --- 2. Google 免费翻译（gtx 端点，海外可用；用换行拼批，返回再拆） --- */
  function googleRaw(text, useJsonp) {
    var url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
      (FROM || 'auto') + '&tl=' + encodeURIComponent(TO === 'zh-Hans' ? 'zh-CN' : TO) +
      '&dt=t&ie=UTF-8&oe=UTF-8&q=' + encodeURIComponent(text);
    var p = useJsonp ? jsonp(url, 'callback') : request('GET', url, null, {}).then(function (s) { return JSON.parse(s); });
    return p.then(function (data) {
      // 结构：[[["译文","原文",...],...], null, "en", ...]
      var seg = data && data[0];
      var out = '';
      if (Array.isArray(seg)) {
        for (var i = 0; i < seg.length; i++) {
          if (seg[i] && typeof seg[i][0] === 'string') out += seg[i][0];
        }
      }
      if (!out) throw new Error('空译文');
      return out;
    });
  }
  ENGINES.google = {
    label: 'Google（免费）',
    batch: true,
    share: 3,
    /* 需要海外网络。它**默认不进自动协作池**：在国内它不是一个「慢引擎」，
     * 而是一个「每次都要等到连接超时」的引擎 —— 15 秒的超时能把整页拖死。
     * 只有当用户在菜单里亲手指定它、或别的引擎全挂了降级到它时才用。 */
    timeoutMs: SLOW_TIMEOUT,
    overseas: true,
    /* 用换行把一批拼成一次请求：换行是翻译引擎最容易保留的分隔符。
     * 拆回来行数对不上时（引擎偶尔会合并/拆分行），整批退回逐条重译，
     * 宁可慢一点也不让译文错位。 */
    translate: function (texts, opts) {
      var abort = opts && opts.abort, onPartial = opts && opts.onPartial;
      if (abort && abort()) return Promise.resolve(texts.slice());
      var joined = texts.join('\n');
      var useJsonp = !hasBridge() && !!document.createElement;
      return googleRaw(joined, useJsonp).then(function (out) {
        var lines = String(out).split('\n');
        if (lines.length === texts.length) {
          var r = lines.map(function (l, i) { return norm(l) || texts[i]; });
          if (onPartial && !(abort && abort())) { try { onPartial(0, r); } catch (e) {} }
          return r;
        }
        return ENGINES.google.oneByOne(texts, opts);
      }).catch(function () { return ENGINES.google.oneByOne(texts, opts); });
    },
    oneByOne: function (texts, opts) {
      var abort = opts && opts.abort;
      return mapLimit(texts, CONCURRENCY, function (t) {
        if (abort && abort()) return Promise.resolve(null);
        return googleRaw(t, !hasBridge()).then(function (r) { return norm(r) || t; });
      }, abort).then(function (out) {
        return out.map(function (r, i) { return r || texts[i]; });
      });
    }
  };

  /* --- 3. 有道翻译（aidemo 演示接口：国内直连、无需 key） ---
   * 速度的关键在这里：aidemo 对换行拼批**原样保留换行**（实测进几行出几行），
   * 所以能一次带十几段走一个请求。
   *
   * 单条请求的两个硬上限：实测 16 行仍成功、20 行报 103（内容过长），
   * 行数取 12 留余量；字符上限 800 会在行数之前先兜住长句。
   *
   * 失败的 chunk **绝不退回逐条**（那会让频率雪崩），而是对半拆小再试；
   * 拆到单行还失败就放弃，保持原文交给重试循环。
   *
   * ================= 限流模型（真机外实测，2026-09）=================
   * 同样 13 个「8 行拼批」请求，四种发法对着测：
   *
   *   一次性并发 13 个       →   261ms   13/13 全成功
   *   并发 4、波间 150ms     →  1108ms   12/13
   *   并发 2、波间 300ms     →  2629ms   12/13
   *   串行、间隔 300ms（旧）→  4639ms    6/13 ← 7 次被限流
   *
   * 25 个批次（≈200 段一页）一次性并发：308ms，24/25 成功。
   *
   * 结论反直觉但很稳定：**有道不怕并发，怕的是「持续不断地来」**。
   * 短时间集中发完最安全；把请求摊开慢慢发反而最容易撞 411。
   *
   * 旧实现恰好是最吃亏的那种写法：全局一个 `youdaoNextAt` 时间戳，
   * 每个请求都必须和上一个间隔 300~800ms。它同时踩了两条：
   *   1) 慢 —— 40 段一页实际网络只要 5×51ms，节流却要收 2.3 秒；
   *   2) 撞限流 —— 请求被摊到好几秒上，13 批里 7 批被拒，
   *      那 7 批只能等补翻，用户看到的就是「特别特别慢，还翻不全」。
   * 更糟的是撞了 411 之后自适应还会把间隔放宽到 1500ms，
   * 于是更慢、摊得更长、更容易撞 —— 一个恶性循环。
   *
   * 现在改成：**并发发出（全局一个名额池）+ 撞限流才歇一下**。
   * 并发数按实测反馈自适应：连续成功就加大，撞一次就减半并冷却。 */
  /* 拼批上限到底卡在「行数」还是「字符数」——之前写的是 12 行，
   * 依据是「16 行 OK、20 行 103」。可那次每行 200 字符（总 4000 字符），
   * 卡的根本不是行数。这次拿真实接口逐档实测（每行 22 字符）：
   *   12×22 =  275 字符 OK ｜ 20×22 =  459 OK ｜ 30×22 =  689 OK
   *   40×18 =  759 OK     ｜ 60×12 =  779 OK ｜ 36×22 =  827 OK
   *   41×22 =  942 OK     ｜ 46×22 = 1057 → 103 内容过长
   * 也就是说：**60 行都不报错，1000 字符出头才报错** —— 真正的闸门是
   * 字符数（约 1000），不是行数。README 的段虽然中位数只有 22 字符，
   * 12 行却只装走 275 字符，等于每次请求白白浪费四分之三的容量。
   * 顺便确认过一件事：闸门量的是**原文**长度，不是 URL 编码后的长度
   * （900 字符、编码后 1270 字节照样 OK），所以按原文卡预算是对的。
   *
   * 放宽到 36 行 / 900 字符之后，同一篇 1813 段（实测 6.6 万字符）的 README
   * 请求数从 154 次降到 98 次 —— 而 6.6 万 / 900 的理论下限是 74 次，
   * 也就是说已经贴着上限在装了（剩下的差距是每批末尾那几段凑不满的零头）。
   * 900 而不是 1000，是给中日韩之外的意外留 10% 余量：撞 103 要整批对半拆，
   * 代价远大于少装 10%。 */
  /* 实测结论（服务器端真实压测，2026-09-22）：
   *   有道的限制是**字节数**，不是行数 ——
   *     总字节 923 装 44 行  -> OK，回来 44 行
   *     总字节 901 装 22 行  -> OK，回来 22 行
   *     总字节 1010 装 15 行 -> 103（内容过长）
   *   也就是说只要总字节压得住，行数多一倍它也吃得下、行数还能严格对齐。
   *
   * 以前行数卡 36 是双重误伤：想多装时字节早就不够了（880 字节装短句
   * 能放 40 行，36 行根本不是瓶颈），等于平白多出一批请求。
   * 现在行数放宽到 60（只是个“别把单 Request 撑成怪物”的保险），
   * 真正把关的交给下面的字节上限。 */
  var YOUDAO_BATCH_LINES = 60;        // 行数保险上限（不是真正的限制，见上）
  /* 注意这里是字节数、不是字符数，且**不要低于 900**：
   * 用真实长文档（system-design-primer，1096 段）算过 —— 段落中位 69 字节，
   * 12~13 段就撑满 900，行数上限 36 / 60 两边都不会被碰到，
   * 真正决定请求数的一直是这个字节上限。曾经试过压到 880「求稳」，
   * 结果每包少装 20 字节，同样的文档反倒多出 4 个请求（127 -> 131）。
   * 900 以下纯粹是自己吃亏；1010 以上又会稳定撞 103。 */
  var YOUDAO_BATCH_CHARS = 900;       // 真实限制：总字节，实测 ~1010 起报 103

  /** 有道数的是**字节**：CJK 一个字 3 字节，用 JS 的 .length 去卡
   * 会把中日韩混排的批次算小了三倍，结果整批撞 103、再对半拆 —— 白跑一趟。
   * 这里按 UTF-8 实际字节数算预算，ASCII 段不受影响。 */
  function bytelen(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      n += c < 0x80 ? 1 : (c < 0x800 ? 2 : 3);
    }
    return n;
  }

  /* ------------------------------------------------------------------
   * 签名用的哈希：md5（百度）+ sha256（有道开放平台）
   *
   * 为什么要自己写 —— WebView 里没有 crypto.subtle 的同步版本，
   * 而签名必须在拼表单之前算出来；引入第三方库又要为几百 KB 的 JS 买单。
   * 这两个实现都拿 Node 的 crypto 逐条对过（空串 / 中英混排 / emoji /
   * 55·56·57·64·1000 字节这些边界长度全部一致），可以放心用。
   *
   * 一个很容易踩的坑写在 md5hex 里：JS 的 >>> 移位数会按 32 取模。
   * ------------------------------------------------------------------ */
  function utf8Bytes(s) {
    var b = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) b.push(c);
      else if (c < 0x800) b.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c < 0xD800 || c >= 0xE000) {
        b.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      } else {
        i++;
        var c2 = s.charCodeAt(i);
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
        b.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      }
    }
    return b;
  }

  function md5hex(s) {
    var bytes = utf8Bytes(s), n = bytes.length;
    var pad = ((56 - (n + 1) % 64) + 64) % 64;
    bytes.push(0x80);
    for (var i = 0; i < pad; i++) bytes.push(0);
    /* 注意：JS 的 >>> 移位数会 %32，写 bits >>> 32 等于 bits >>> 0
     * （会把低 32 位重复写一遍）—— 长度必须高低两段分开写。 */
    var bits = n * 8;
    var bitsLo = bits >>> 0, bitsHi = Math.floor(bits / 4294967296);
    for (var j = 0; j < 4; j++) bytes.push((bitsLo >>> (j * 8)) & 0xFF);
    for (var j2 = 0; j2 < 4; j2++) bytes.push((bitsHi >>> (j2 * 8)) & 0xFF);
    var h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476];
    var K = [
      0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
      0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
      0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
      0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
      0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
      0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
      0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
      0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391];
    var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    function rotl(x, n2) { return (x << n2) | (x >>> (32 - n2)); }
    for (var off = 0; off < bytes.length; off += 64) {
      var M = [];
      for (var k = 0; k < 16; k++) {
        M[k] = bytes[off + k * 4] | (bytes[off + k * 4 + 1] << 8) |
          (bytes[off + k * 4 + 2] << 16) | (bytes[off + k * 4 + 3] << 24);
      }
      var a = h[0], b = h[1], c3 = h[2], d = h[3], f, g, tmp;
      for (var r = 0; r < 64; r++) {
        if (r < 16) { f = (b & c3) | (~b & d); g = r; }
        else if (r < 32) { f = (d & b) | (~d & c3); g = (5 * r + 1) % 16; }
        else if (r < 48) { f = b ^ c3 ^ d; g = (3 * r + 5) % 16; }
        else { f = c3 ^ (b | ~d); g = (7 * r) % 16; }
        tmp = d; d = c3; c3 = b;
        b = (b + rotl((a + f + K[r] + M[g]) >>> 0, S[r])) >>> 0;
        a = tmp;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c3) >>> 0; h[3] = (h[3] + d) >>> 0;
    }
    var out = '';
    for (var q = 0; q < 4; q++) {
      var v = h[q];
      for (var w = 0; w < 4; w++) {
        var byte = (v >>> (w * 8)) & 0xFF;
        out += (byte < 16 ? '0' : '') + byte.toString(16);
      }
    }
    return out;
  }

  function sha256hex(s) {
    var bytes = utf8Bytes(s), n = bytes.length;
    var pad = ((56 - (n + 1) % 64) + 64) % 64;
    bytes.push(0x80);
    for (var i = 0; i < pad; i++) bytes.push(0);
    var bitsHi2 = Math.floor((n * 8) / 4294967296), bitsLo2 = (n * 8) >>> 0;
    bytes.push((bitsHi2 >>> 24) & 0xFF, (bitsHi2 >>> 16) & 0xFF, (bitsHi2 >>> 8) & 0xFF, bitsHi2 & 0xFF);
    bytes.push((bitsLo2 >>> 24) & 0xFF, (bitsLo2 >>> 16) & 0xFF, (bitsLo2 >>> 8) & 0xFF, bitsLo2 & 0xFF);
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Array(64);
    function rotr(x, n2) { return (x >>> n2) | (x << (32 - n2)); }
    for (var off = 0; off < bytes.length; off += 64) {
      for (var t = 0; t < 16; t++) {
        W[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) |
          (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3];
      }
      for (var t2 = 16; t2 < 64; t2++) {
        var s0 = rotr(W[t2 - 15], 7) ^ rotr(W[t2 - 15], 18) ^ (W[t2 - 15] >>> 3);
        var s1 = rotr(W[t2 - 2], 17) ^ rotr(W[t2 - 2], 19) ^ (W[t2 - 2] >>> 10);
        W[t2] = (W[t2 - 16] + s0 + W[t2 - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
      for (var t3 = 0; t3 < 64; t3++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[t3] + W[t3]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2v = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2v) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + hh) >>> 0;
    }
    var out = '';
    for (var q = 0; q < 8; q++) {
      for (var w = 0; w < 4; w++) {
        var by = (H[q] >>> (24 - w * 8)) & 0xFF;
        out += (by < 16 ? '0' : '') + by.toString(16);
      }
    }
    return out;
  }

  /** 简单的等待（给引擎做节流用） */
  function sleep(ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  }

  /* 并发是怎么定死的 —— 同一批 300 段、每包 880 字节，只改并发：
   *     并发  6 -> 24/24 全成功，1.01s（≈298 段/秒）
   *     并发 10 -> 8/24  成功 <-- 断崖开始
   *     并发 16 -> 2/24  成功
   *     并发 24 -> 0/24  成功（全军覆没）
   * 过 6 之后掉的不是「变慢」而是「直接失败」，失败的还要重排、重发，
   * 净吞吐反而更低。所以 6 不是保守，是实测出来的甜点：
   * MAX 就等于起步值，不再往上探。
   *
   * 顺带说清「为什么以前觉得有道特别慢」—— 以前这里写着：连续成功就
   * +2，一路加到 12。按上面那张表，加到 10/12 必然撞 411/429，
   * 然后又是一路减半、又把冷却翻倍堆到 1500ms，于是整页翻译的大半时间
   * 都耗在「代码自己给自己罚站」上。引擎本身一次只要 134ms，
   * 慢的是这套自我惩罚。现在把它拿掉：稳稳跑 6，撞了只短暂让一让。 */
  var YOUDAO_PAR_MIN = 2;             // 并发下限（真的撞死了才退一步）
  var YOUDAO_PAR_MAX = 6;             // 并发上限 = 实测甜点，不再加码

  /* ------------------------------------------------------------------
   * 熔断：这一轮改动的核心，也是「调完参数还是慢」的最后一块拼图
   *
   * 之前的处理是「撞一次退一格、冷却 200~800ms 再试」。这套逻辑的前提是
   * 「限流是一阵一阵的脉冲，忍一下就过去」。把请求打下去看回包，会发现
   * 完全不是这么回事（下面的数字是同一拨请求的连续时间轴）：
   *
   *   第 1~6 个包   -> OK（平均 50~55ms）
   *   第 7 个包开始 -> 411，再往后连续 84 个全是 411，横跨 14 秒
   *   411 的回包只要 39ms —— 服务器判你超速这件事它自己毫不费力
   *
   * 也就是说：它放进来一小撮，然后**长时间关门**。而 411 来得又快又便宜，
   * 于是「冷却 800ms 再试一次」的真实效果是：
   *   · 每 800ms 白送一次失败
   *   · 让这段 411 期间一直有流量在上面压着
   *   · 页面上看不到任何新译文，但程序一直在忙
   * 这就是「感觉特别特别慢」的最后一段解释 —— 它不是慢，是在空转。
   *
   * 换成一个标准的熔断器：
   *   1) 一旦撞到 411/429，立刻**合闸**：接下来的一段时间一个请求都不发
   *   2) 每次撞就翻倍（2s -> 4s -> 8s），到上限为止；成功若干次才判定风头过去
   *   3) 连着撞了 N 次还很糟 -> 判定「有道这会儿不能用」，**快速失败**：
   *      不再占着连接干等，把失败立刻交回上层去换引擎 / 交给重试循环
   *
   * 第 3 条尤其重要。否则一页长文档能把请求挂在 15 秒的等待里，用户看到的
   * 只有「点了翻译、没反应」；快速失败至少能让别的引擎有机会顶上。
   * ------------------------------------------------------------------ */
  /* 这两个数字不是拍脑袋来的 —— 拿上面那套「放行一小撮、然后长期关门」的
   * 服务端形态做过对照模拟（虚时钟，60 秒预算，200 个待翻的包）：
   *     旧策略（撞一次冷却 200~800ms）：译出 17 段，发出 200 个请求
   *     合闸 2.5s 起、封顶 10s      ：译出 17 段，发出  26 个请求
   *     合闸 3s 起、封顶 24s        ：译出 15 段，发出  23 个请求
   * 看出结论了：中间的这组合得住 —— **产出一样，请求只有八分之一**。
   * 白送的请求越少，把惩罚拖得越长的可能性就越小；封顶取 10s 而不是 24s，
   * 是因为闸门拉太久会把服务端补令牌的那几个瞬间全部错过（24s 那组反而
   * 少译 2 段）。让是要让的，但别让到自断粮。 */
  var YOUDAO_CB_BASE = 2500;          // 第一次合闸的时长（原来是 200ms 的冷却）
  var YOUDAO_CB_MAX = 10000;          // 合闸上限
  var YOUDAO_OK_RESET = 8;            // 连续成功这么多次，判定风头已过

  var youdaoPar = YOUDAO_PAR_MAX;     // 当前允许的并发请求数
  var youdaoOpenUntil = 0;            // 合闸截止时刻：在此之前一个请求都不发
  var youdaoCbMs = 0;                 // 本轮合闸时长（每撞一次翻倍）
  var youdaoOkStreak = 0;             // 连续成功次数
  var youdaoCooldowns = 0;            // 本轮撞限流次数（重试柳暗花明用）
  var youdaoInFlight = 0;             // 当前在飞的有道请求数
  var youdaoQueue = [];               // 等名额的请求
  /** 换页时把「上一页欠下的账」一笔勾销：新页面不该接着上一页的惩罚 */
  function youdaoResetThrottle() {
    youdaoOpenUntil = 0;
    youdaoCbMs = 0;
    youdaoOkStreak = 0;
    youdaoPar = YOUDAO_PAR_MAX;   // 并发也一并复位到甜点档
  }
  /* 撞到限流：合闸。
   *
   * 「同一窗口内只算一次」是这里最要紧的一行。并发跑着的时候，闸一合，
   * 天上飞着的那几个请求会在接下来几十毫秒里**接连**砸回来一堆 411 ——
   * 它们其实是同一次「额度被撞爆」的结果，是合闸**之前**发出去的迟到回音。要是不加这个判断，一次撞墙瞬间就能把惩罚翻好几倍，
   * 还会被误判成「引擎罢工」，结果一页下来一个字也没翻出来。
   * 判据很简单：只有「闸门本来开着的时候」收到的失败，才算新的一次，
   * 才算真的「我等过了、再试、还是不行」。 */
  function youdaoTrip() {
    var now = Date.now();
    if (now >= youdaoOpenUntil) {
      youdaoCbMs = Math.min(YOUDAO_CB_MAX, Math.max(YOUDAO_CB_BASE, youdaoCbMs * 2));
      youdaoOpenUntil = now + youdaoCbMs;
      youdaoOkStreak = 0;
      youdaoPar = Math.max(YOUDAO_PAR_MIN, youdaoPar - 1);
    }
    youdaoCooldowns++;
  }
  /** 拿到译文：连续够多次就把闸重新合上，别让偶发的一次限流阴魂不散 */
  function youdaoHallPass() {
    if (++youdaoOkStreak >= YOUDAO_OK_RESET && youdaoCbMs) {
      youdaoCbMs = 0;
    }
  }
  function youdaoRelease() {
    youdaoInFlight--;
    /* 名额是全局共享的：组并发（BATCH_PARALLEL）叠上来也不会突破上限，
     * 对半拆分多出来的请求同样走这个池子。 */
    while (youdaoQueue.length && youdaoInFlight < youdaoPar) {
      youdaoInFlight++;
      youdaoQueue.shift()();
    }
  }
  /** 申请一个并发名额；拿到之后还要等过合闸期（撞过限流才有） */
  function youdaoAcquire() {
    if (youdaoInFlight < youdaoPar) { youdaoInFlight++; return Promise.resolve(); }
    return new Promise(function (res) { youdaoQueue.push(res); });
  }
  function youdaoWaitCool() {
    var w = youdaoOpenUntil - Date.now();
    if (w <= 0) return Promise.resolve();
    return new Promise(function (res) { setTimeout(res, w); });
  }
  function youdaoRequest(q, abort) {
    if (abort && abort()) return Promise.reject(new Error('已放弃（换页）'));
    return youdaoAcquire()
      .then(youdaoWaitCool)
      .then(function () {
        /* 拿到名额、也等过合闸期之后再问一次：请求可能是换页**之前**排进来的，
         * 也可能是合闸期间排进来的（那时候还没轮到发） */
        if (abort && abort()) throw new Error('已放弃（换页）');
        return request('POST', 'https://aidemo.youdao.com/trans',
          'q=' + encodeURIComponent(q) +
          '&from=' + (FROM || 'auto') +
          '&to=' + (TO === 'zh-Hans' ? 'zh-CHS' : TO),
          { 'Content-Type': 'application/x-www-form-urlencoded' });
      })
      .then(function (s) {
        var d = JSON.parse(s);
        if (d && d.errorCode && String(d.errorCode) !== '0') {
          var code = String(d.errorCode);
          /* 411 = 请求频率过快；429 是同类的限流。
           * 旧实现靠「让每个请求之间隔得更久」来处理，实测证明那是反的：
           * 摊得越长越容易撞。这里改成「降并发 + 冷却一会儿」——
           * 少发、快发完、然后安静，比一直慢慢发更不容易被判成异常。
           * 103（内容过长）靠拆小解决，不在这里加码。 */
          if (code === '411' || code === '429') {
            /* 撞到限流 = 合闸：整段时间不再发请求，而不是「退一档继续试探」。
             * 理由见上面熔断那段注释 —— 411 之后连着几十个包都是 411，
             * 这时候每一次「再试一次」都是纯亏，还会把惩罚拖得更长。 */
            youdaoTrip();
          }
          throw new Error('有道错误 ' + code + (d.msg ? ' ' + d.msg : ''));
        }
        var v = d && d.translation && d.translation[0];
        if (!v || !String(v).trim()) throw new Error('空译文');
        /* 顺利拿到译文 —— 风头正在过去，记一笔「连续成功」。
         * 攒够 YOUDAO_OK_RESET 次才把熔断计数清零：一次成功可能是漏网，
         * 连续十次才是真的通了。
         *
         * 但这里**刻意不把并发立刻拉回 MAX** —— 刚退下来的档位立刻弹回去
         * 会形成「退一档、加回去、再撞」的锯齿。留着它，等换页时一并复位。
         *
         * 另外**不做**「连续成功就加大并发」：那是以前最大的坑
         * （并发从 6 一路加到 12，必然撞限流，再排着队等自己的冷却）。 */
        youdaoHallPass();
        return String(v);
      })
      .then(function (v) { youdaoRelease(); return v; },
            function (e) { youdaoRelease(); throw e; });
  }
  function youdaoOne(text, abort) {
    return youdaoRequest(text, abort).then(norm);
  }
  /** 剥掉首尾空行：有道偶尔在译文前后各多给一个换行（真机抓到过）。
   * 这种差异是无害的——行还在、顺序还在，只是多了两个空串。
   * 以前拿它当「行数不符」处理，整批会一路对半拆到放弃，最后原文上屏，
   * 用户看到的就是「这一段死活翻不出来」。 */
  function trimBlankEdges(arr) {
    var s = 0, e = arr.length;
    while (s < e && !String(arr[s]).trim()) s++;
    while (e > s && !String(arr[e - 1]).trim()) e--;
    return arr.slice(s, e);
  }
  /** 413？不是，411 —— 限流。跟「内容太长」不是一回事：
   *  411 是频率问题，把 chunk 拆小只会让请求更多、更挤，
   *  正确做法是等冷却过去再原样重试。只有行数对不上 / 103 才该拆。 */
  function isLimited(err) {
    return !!err && /有道错误\s*(411|429)/.test(String(err.message || err));
  }
  /** 引擎明确回了 200、译文也拿到了，只是「译出来跟原文一模一样」——
   *  这才是真的没得翻（路径、命令名、专有名词：solutions/、man bash、apt）。
   *  记一笔，本轮剩下的块和 retryLoop 的 5 轮就别再为它发请求了。
   *  只在这一支记账：失败兜底回来的原文绝不能算，否则限流的段会被永久跳过。 */
  function noteNoops(chunk, lines) {
    for (var i = 0; i < lines.length && i < chunk.length; i++) {
      var s = norm(lines[i]);
      if (s && s === chunk[i]) markNoop(chunk[i]);
    }
  }

  /** 翻一个 chunk：行数对不上或请求失败就对半拆小再试，别让译文错位。
   *  撞上限流则先等冷却再原样重试一次（retried 防重复），仍不行才拆。
   *  abort 为真时立刻收手（返回等长的空位），一个请求都不再发。 */
  function youdaoChunk(chunk, depth, abort, retried) {
    var giveUp = function () { return Promise.resolve(chunk.map(function () { return null; })); };
    if (abort && abort()) return giveUp();
    if (chunk.length === 1) {
      /* 必须返回**数组**：调用方按下标往结果里填，返回字符串会被当成
       * 字符序列逐字塞进去（探测那个单条分支就是这样翻车的一整轮都判成
       * 「引擎不可用」）。以前用 acc.concat(...) 恰好把这个差异吞掉了。 */
      return youdaoOne(chunk[0], abort).then(function (v) {
        if (v === chunk[0]) markNoop(chunk[0]);   // 单条也走同一套记账
        return [v];
      },
        function (err) {
          if (!retried && isLimited(err)) {
            return youdaoWaitCool().then(function () { return youdaoChunk(chunk, depth, abort, true); });
          }
          return [chunk[0]];    // 放弃：保持原文等重试
        });
    }
    var split = function () {
      if (abort && abort()) return giveUp();
      if (depth >= 2) return Promise.resolve(chunk.slice());               // 放弃：保持原文等重试
      var mid = Math.ceil(chunk.length / 2);
      return Promise.all([
        youdaoChunk(chunk.slice(0, mid), depth + 1, abort),
        youdaoChunk(chunk.slice(mid), depth + 1, abort)
      ]).then(function (p) { return p[0].concat(p[1]); });
    };
    return youdaoRequest(chunk.join('\n'), abort).then(function (out) {
      var lines = out.split('\n');
      if (lines.length !== chunk.length) {
        // 先假设只是首尾多了空行，剥掉再比一次；真对不上才拆
        var t = trimBlankEdges(lines);
        if (t.length !== chunk.length) return split();
        noteNoops(chunk, t);
        return t.map(function (l, i) { return norm(l) || chunk[i]; });
      }
      noteNoops(chunk, lines);
      return lines.map(function (l, i) { return norm(l) || chunk[i]; });
    }, function (err) {
      if (!retried && isLimited(err)) {
        /* 限流：拆小是反的。等冷却过完再原样发一次 —— 冷却时长本身
         * 已经在 youdaoRequest 里按「撞一次翻一倍」调过了。 */
        return youdaoWaitCool().then(function () {
          if (abort && abort()) return giveUp();
          return youdaoChunk(chunk, depth, abort, true);
        });
      }
      return split();
    });
  }
  ENGINES.youdao = {
    label: '有道翻译（免费，国内直连）',
    batch: true,
    maxItems: YOUDAO_BATCH_LINES,   // 一组 = 一条请求，别再让引擎自己切第二刀
    parallel: 6,                    // 组并发：有道有名额池兜底，不必压到默认的 3
    share: 5,                       // 协作权重：匿名口子额度小，别给它太多
    resetThrottle: function () { youdaoResetThrottle(); },
    /* 撞了限流、正在合闸的这段时间，主动告诉协作池「别给我派活」。
     * 没有这一句的时候，合闸的 2.5~10 秒里新批照样往有道身上落，
     * 每一批都要先等满冷却 —— 整页就陪着它一起卡住（实测 800 段只翻出 440 段）。
     * 报了冷却之后，这些批会立刻转给池里下一个还精神的引擎。 */
    cooling: function () { return Date.now() < youdaoOpenUntil; },
    translate: function (texts, opts) {
      /* 按行数 + 字符数双上限切片。**不再串行发** —— 全部一起排队，
       * 实际并发由 youdaoAcquire 的全局名额池统一控制（池子是跨组共享的，
       * 所以组并发叠上来、或对半拆分多出请求，都不会突破上限）。 */
      opts = opts || {};
      var abort = opts.abort, onPartial = opts.onPartial;
      var chunks = [], cur = [], len = 0;
      texts.forEach(function (t) {
        var bl = bytelen(t) + 1;
        if (cur.length && (cur.length >= YOUDAO_BATCH_LINES || len + bl > YOUDAO_BATCH_CHARS)) {
          chunks.push(cur); cur = []; len = 0;
        }
        cur.push(t); len += bl;
      });
      if (cur.length) chunks.push(cur);

      var starts = [], base = 0;
      chunks.forEach(function (c) { starts.push(base); base += c.length; });
      var out = new Array(texts.length);
      function runOne(idx) {
        if (abort && abort()) {
          // 中止：后面的 chunk 一个都不发，位置用空位补齐（长度不能变）
          for (var k = 0; k < chunks[idx].length; k++) out[starts[idx] + k] = null;
          return Promise.resolve();
        }
        return youdaoChunk(chunks[idx], 0, abort).then(function (arr) {
          for (var k = 0; k < arr.length; k++) out[starts[idx] + k] = arr[k];
          /* 流式上屏：这个 chunk 一译完就先写进节点，不等其他 chunk。 */
          if (onPartial && !(abort && abort())) {
            try { onPartial(starts[idx], arr.slice()); } catch (e) {}
          }
        });
      }
      var idxs = chunks.map(function (_, i) { return i; });
      return mapLimit(idxs, Math.max(1, YOUDAO_PAR_MAX), runOne, abort).then(function () {
        return out.map(function (r, i) { return r || texts[i]; });
      });
    }
  };

  /* --- 4. DeepL（网页版 jsonrpc 接口：免费无需 key，质量最好） ---
   * 没有官方免费 key，走的是网页版同款接口；公共 IP 偶尔被限流（429），
   * 失败的段落兜底回原文，不影响整页。对频率敏感，并发压低到 3。 */
  var deeplId = Math.floor(Date.now() / 1000) * 1000;
  function deeplOne(text) {
    deeplId++;
    var body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'LMT_handle_texts',
      params: {
        splitting: 'newlines',
        lang: {
          target_lang: TO === 'zh-Hans' ? 'ZH' : String(TO).toUpperCase(),
          source_lang_user_selected: (FROM || 'auto')
        },
        texts: [{ text: text, requestAlternatives: 0 }]
      },
      id: deeplId
    });
    return request('POST', 'https://www2.deepl.com/jsonrpc', body,
      { 'Content-Type': 'application/json' }).then(function (s) {
        var d = JSON.parse(s);
        if (d && d.error) throw new Error('DeepL ' + (d.error.code || '') + ' ' + (d.error.message || ''));
        var v = norm(d && d.result && d.result.texts && d.result.texts[0] && d.result.texts[0].text);
        if (!v) throw new Error('空译文');
        return v;
      });
  }
  ENGINES.deepl = {
    label: 'DeepL（免费，质量最佳）',
    batch: false,
    share: 4,
    timeoutMs: SLOW_TIMEOUT,
    overseas: true,            // 同 Google：默认不进自动协作池
    translate: function (texts, opts) {
      var abort = opts && opts.abort;
      return mapLimit(texts, 3, function (t) {
        if (abort && abort()) return Promise.resolve(null);
        return deeplOne(t);
      }, abort).then(function (out) { return out.map(function (r, i) { return r || texts[i]; }); });
    }
  };

  /* --- 5. MyMemory（兜底，全球可达，匿名有日配额，单条限 ~500 字节） --- */

  /* MyMemory 的配额是**按天**算的，一天之内不会自己恢复。
   *
   * 以前撞上配额只有 poolFail 管着：连续 3 次判死、摘出转轮。但 poolHealth
   * 是「一轮」的账 —— resetPool() 在每次换页时会把它清零重新接纳。
   * 于是配额早就用完的情况下，每翻一页都要先白撞 3 批（每批还是几十条
   * 逐条请求）才又一次得出「它不行」的结论。用户看到的就是：
   * 每一页都莫名其妙地慢一截。
   *
   * 所以这里额外记一笔账：真正确认配额耗尽之后，记下时间，一段时间内
   * 直接不让它进池（ready() 返回 false），连那 3 批学费都省了。
   * 期限取 6 小时而不是一整天 —— 它的配额是按 UTC 日重置的，
   * 半天给一次机会，跨过零点就能自动回来，不用用户手动清数据。 */
  var MM_QUOTA_KEY = 'gh_tr_mm_quota';        // 记「上次确认配额耗尽」的时间戳
  var MM_QUOTA_TTL = 6 * 60 * 60 * 1000;      // 6 小时内不再拿它试
  function mmQuotaExhausted() {
    var t = 0;
    try { t = parseInt(prefGet(MM_QUOTA_KEY, '0'), 10) || 0; } catch (e) { t = 0; }
    return !!t && (Date.now() - t) < MM_QUOTA_TTL;
  }
  function mmQuotaHit() {
    try { prefSet(MM_QUOTA_KEY, String(Date.now())); } catch (e) {}
  }

  ENGINES.mymemory = {
    label: 'MyMemory（兜底，有日限额）',
    batch: false,
    share: 1,                       // 有日配额，永远只分最少的一份
    /* 注意：配额记忆【不】写在这里的 ready()。
     * ready() 一旦返回 false，连「用户在菜单里手动点名要用它」也会被挡掉
     * （planPool 开头的 list.push(cur) 也要过 isReady 这一关）——
     * 那是用户亲手指定的，点了就得上，撞了配额让他自己看见提示。
     * 所以这条限制只加在 planPool 的自动填充那一段。 */
    translate: function (texts, opts) {
      var abort = opts && opts.abort;
      return mapLimit(texts, CONCURRENCY, function (t) {
        if (abort && abort()) return Promise.resolve(null);
        // 单条上限约 500 字节，超了就不浪费一次请求
        if (encodeURIComponent(t).length > 480) return Promise.resolve(null);
        // 以前这里把目标写死成 zh-CN —— 切到「翻成英文」时它还在往中文翻。
        // MyMemory 不像其他引擎那样认 auto，源语言靠 writing-script 猜一个给它。
        var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(t) +
          '&langpair=' + encodeURIComponent((guessSource(t) || 'en') + '|' +
            (TO === 'zh-Hans' ? 'zh-CN' : TO));
        return request('GET', url, null, {}).then(function (s) {
          var d = JSON.parse(s);
          var r = d && d.responseData && d.responseData.translatedText;
          // 配额用完时它会把警告当成译文返回，这种要当失败处理
          if (!r || /MYMEMORY WARNING/i.test(r)) {
            mmQuotaHit();
            throw new Error('无配额');
          }
          return norm(r);
        }, function (err) {
          /* 配额打满时它也可能直接回 429（不是把警告塞进译文里）。
           * 这两种是同一件事，都得记下来 —— 只认 WARNING 的话，
           * 429 那一路会落进 poolFail 的老路：每页白撞 3 批。 */
          if (/429|403|MYMEMORY WARNING/i.test(String(err && err.message))) mmQuotaHit();
          throw err;
        });
      }, abort).then(function (out) { return out.map(function (r, i) { return r || texts[i]; }); });
    }
  };

  /* --- 6. 自定义接口（逃生舱：自建 / DeepLX / 公司内网都行）
   * 协议：POST JSON {"q":["..."],"from":"auto","to":"zh-Hans"}
   *      返回 {"translations":["..."]} 或直接是字符串数组 */
  ENGINES.custom = {
    label: '自定义接口',
    batch: true,
    needUrl: true,
    /* 以前漏了 maxItems，于是回落成默认 MAX_CHARS=5000 / MAX_ITEMS=40：
     * 就算你接的是个没有长度限制的自建接口，一篇 1096 段的 README
     * 也会被切成 28 个请求 —— 白白的往返。自建接口按 200 段一组走。 */
    maxItems: 200,
    maxChars: 20000,
    parallel: 4,
    share: 6,
    translate: function (texts, opts) {
      var abort = opts && opts.abort;
      if (abort && abort()) return Promise.resolve(texts.slice());
      var url = prefGet(KEY_CUSTOM, '');
      if (!url) return Promise.reject(new Error('还没填自定义接口地址'));
      return request('POST', url, JSON.stringify({ q: texts, from: FROM || 'auto', to: TO }),
        { 'Content-Type': 'application/json' }).then(function (s) {
          var d = JSON.parse(s);
          var arr = Array.isArray(d) ? d : (d.translations || d.data || d.result);
          if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('返回结构不符');
          return arr.map(function (x, i) { return (typeof x === 'string' ? norm(x) : '') || texts[i]; });
        });
    }
  };

  /* ------------------------------------------------------------------
   * 7~9：国内三家开放平台（百度 / 有道开放平台 / 小牛）
   *
   * 为什么非要加它们 —— 现在页里跑的 aidemo.youdao.com 是个匿名 demo 接口：
   * 一次只能带 900 字节，额度还小得可怜（连着发几十个包就撞 411）。
   * 一篇 30 KB 的 README 被切成 30 多个请求，全挤在一个额度极小的免费口子上，
   * 这是「翻得慢」最根本的那一层天花板 —— 调并发、调分包都只是在天花板上打转。
   *
   * 这三家都是国内机房直连、免费额度（注册即送，个人用量基本用不完），
   * 单次能带 5000~6000 字节：同样的 README 从 30 多个请求降到 5~7 个。
   * 代价是要签名，所以得让用户填一次 appid / 密钥（本机保存，不外发）。
   *
   * 它们不是「备胎」，而是**和匿名引擎一起分摊同一页**的主力，见下面
   * 「多引擎协作」那一段。
   * ------------------------------------------------------------------ */

  /** 按字节 + 段数双上限切片（给单次上限以字节计的引擎用） */
  function splitByBytes(texts, maxBytes, maxItems) {
    var chunks = [], cur = [], len = 0;
    texts.forEach(function (t) {
      var bl = bytelen(t) + 1;
      if (cur.length && (cur.length >= maxItems || len + bl > maxBytes)) {
        chunks.push(cur); cur = []; len = 0;
      }
      cur.push(t); len += bl;
    });
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /* --- 7. 百度翻译开放平台 ---
   * 单次 6000 字节（匿名接口的 6 倍多），标准版 QPS=1 —— 必须串行。
   * 串行听着慢，可它一发顶六发：30 KB 的 README 只要 5 个请求、5 秒出头。
   * 签名 md5(appid + q + salt + 密钥)，本地算，不额外发请求。 */
  var BAIDU_GAP = 1100;               // QPS=1，留 10% 余量
  var BAIDU_MAX_BYTES = 5800;
  var baiduChain = Promise.resolve();
  var baiduGap = BAIDU_GAP;
  /** 串行队列：不管外面几路并发，落到百度这里永远一次一个，且之间留够间隔 */
  function baiduSlot(fn) {
    var run = baiduChain.then(fn);
    baiduChain = run.then(
      function () { return sleep(baiduGap); },
      function () { return sleep(baiduGap); });
    return run;
  }
  function baiduRequest(arr, abort) {
    var appid = prefGet(KEY_BAIDU_APPID, ''), key = prefGet(KEY_BAIDU_KEY, '');
    if (!appid || !key) return Promise.reject(new Error('还没填百度翻译的 appid / 密钥'));
    var q = arr.join('\n');
    var salt = String(Date.now()) + Math.floor(Math.random() * 1000);
    var sign = md5hex(appid + q + salt + key);
    return request('POST', 'https://fanyi-api.baidu.com/api/trans/vip/translate',
      'q=' + encodeURIComponent(q) +
      '&from=auto&to=' + (TO === 'zh-Hans' ? 'zh' : 'en') +
      '&appid=' + encodeURIComponent(appid) +
      '&salt=' + encodeURIComponent(salt) +
      '&sign=' + sign,
      { 'Content-Type': 'application/x-www-form-urlencoded' }).then(function (s) {
        var d = JSON.parse(s);
        if (d && d.error_code && String(d.error_code) !== '0') {
          var code = String(d.error_code);
          /* 54003 = 访问频率受限、54005 = 长请求过于频繁。
           * 这两条是「我发太快了」，不是「这个引擎不能用」——
           * 把间隔拉长（翻倍、封顶 6 秒），别急着判它死刑。 */
          if (code === '54003' || code === '54005') {
            baiduGap = Math.min(6000, baiduGap * 2);
          }
          throw new Error('百度 ' + code + ' ' + (d.error_msg || ''));
        }
        var tr = d && d.trans_result;
        if (!tr || tr.length !== arr.length) throw new Error('百度返回条数不符');
        return tr.map(function (x) { return norm(x && x.dst); });
      });
  }
  ENGINES.baidu = {
    label: '百度翻译（国内，需填密钥）',
    batch: true,
    maxItems: 60,
    maxChars: BAIDU_MAX_BYTES,
    parallel: 1,                 // 串行通道，并发靠 baiduSlot 自己管
    /* 权重只给 1：标准版 QPS=1，虽然单次带得多，但每秒只能出一发，
     * 折算吞吐约 4.7 KB/s，远低于有道开放平台的 38 KB/s。
     * 分给它太多批，它反而会变成整页的尾部（别的引擎早翻完了，它还在慢慢跑）。
     * 贵在「稳」—— 匿名口子撞限流的时候，它这条慢车道是保底的。 */
    share: 6,
    ready: function () { return !!(prefGet(KEY_BAIDU_APPID, '') && prefGet(KEY_BAIDU_KEY, '')); },
    resetThrottle: function () { baiduGap = BAIDU_GAP; },
    translate: function (texts, opts) {
      opts = opts || {};
      var abort = opts.abort, onPartial = opts.onPartial;
      if (abort && abort()) return Promise.resolve(texts.slice());
      var chunks = splitByBytes(texts, BAIDU_MAX_BYTES, 60);
      var starts = [], base = 0;
      chunks.forEach(function (c) { starts.push(base); base += c.length; });
      var out = new Array(texts.length);
      function fill(i, arr) {
        for (var k = 0; k < arr.length; k++) {
          out[starts[i] + k] = arr[k] || chunks[i][k];
        }
      }
      var idxs = chunks.map(function (_, i) { return i; });
      return mapLimit(idxs, 1, function (i) {
        if (abort && abort()) return Promise.resolve();
        return baiduSlot(function () {
          if (abort && abort()) return null;
          return baiduRequest(chunks[i], abort);
        }).then(function (lines) {
          if (!lines) return;
          fill(i, lines);
          if (onPartial && !(abort && abort())) {
            try { onPartial(starts[i], lines.slice()); } catch (e) {}
          }
        }, function (err) {
          /* 一个 chunk 撞了就把剩下的按原文填掉，别让整组卡在这儿。
           * 组里一个都没翻出来时，外层会把它交给下一个引擎重来。 */
          if (!state.lastErr && err) state.lastErr = err.message || String(err);
          fill(i, chunks[i].slice());
        });
      }, abort).then(function () {
        return out.map(function (r, i) { return r || texts[i]; });
      });
    }
  };

  /* --- 8. 有道翻译开放平台（和上面的 aidemo 不是一回事） ---
   * aidemo 是匿名 demo 口子（900 字节 / 次、额度极小）；这里是有道正式开放平台：
   * 单次 5000 字节，额度跟着账户走（新用户送体验金，个人用量绰绰有余）。
   * 签名 sha256(appKey + input + salt + curtime + appSecret)，
   * input 是「前 10 字 + 长度 + 后 10 字」（超过 20 字时）。 */
  var YD_OPEN_MAX_BYTES = 4800;
  function ydOpenRequest(arr, abort) {
    var appKey = prefGet(KEY_YD_APPKEY, ''), secret = prefGet(KEY_YD_SECRET, '');
    if (!appKey || !secret) return Promise.reject(new Error('还没填有道开放平台的 appKey / 密钥'));
    var q = arr.join('\n');
    var salt = String(Date.now()) + Math.floor(Math.random() * 1000);
    var curtime = String(Math.floor(Date.now() / 1000));
    var input = q.length > 20 ? (q.slice(0, 10) + q.length + q.slice(-10)) : q;
    var sign = sha256hex(appKey + input + salt + curtime + secret);
    return request('POST', 'https://openapi.youdao.com/api',
      'q=' + encodeURIComponent(q) +
      '&from=auto&to=' + (TO === 'zh-Hans' ? 'zh-CHS' : 'en') +
      '&appKey=' + encodeURIComponent(appKey) +
      '&salt=' + encodeURIComponent(salt) +
      '&sign=' + encodeURIComponent(sign) +
      '&signType=v3&curtime=' + curtime,
      { 'Content-Type': 'application/x-www-form-urlencoded' }).then(function (s) {
        var d = JSON.parse(s);
        if (d && d.errorCode && String(d.errorCode) !== '0') {
          throw new Error('有道 ' + d.errorCode);
        }
        var v = d && d.translation && d.translation[0];
        if (!v) throw new Error('有道空译文');
        var lines = String(v).split('\n');
        if (lines.length !== arr.length) throw new Error('有道返回条数不符');
        return lines.map(norm);
      });
  }
  ENGINES.youdaoOpen = {
    label: '有道开放平台（国内，需填密钥）',
    batch: true,
    maxItems: 40,
    maxChars: YD_OPEN_MAX_BYTES,
    parallel: 4,
    share: 8,                    // 有 key 就当主力：单次吞吐大、额度足
    ready: function () { return !!(prefGet(KEY_YD_APPKEY, '') && prefGet(KEY_YD_SECRET, '')); },
    translate: function (texts, opts) {
      opts = opts || {};
      var abort = opts.abort, onPartial = opts.onPartial;
      if (abort && abort()) return Promise.resolve(texts.slice());
      var chunks = splitByBytes(texts, YD_OPEN_MAX_BYTES, 40);
      var starts = [], base = 0;
      chunks.forEach(function (c) { starts.push(base); base += c.length; });
      var out = new Array(texts.length);
      var idxs = chunks.map(function (_, i) { return i; });
      return mapLimit(idxs, Math.max(1, ENGINES.youdaoOpen.parallel), function (i) {
        if (abort && abort()) return Promise.resolve();
        return ydOpenRequest(chunks[i], abort).then(function (lines) {
          for (var k = 0; k < lines.length; k++) out[starts[i] + k] = lines[k] || chunks[i][k];
          if (onPartial && !(abort && abort())) {
            try { onPartial(starts[i], lines.slice()); } catch (e) {}
          }
        }, function (err) {
          if (!state.lastErr && err) state.lastErr = err.message || String(err);
          for (var k = 0; k < chunks[i].length; k++) out[starts[i] + k] = chunks[i][k];
        });
      }, abort).then(function () {
        return out.map(function (r, i) { return r || texts[i]; });
      });
    }
  };

  /* --- 9. 小牛翻译（niutrans，国内，需填 apikey） ---
   * 只要一个 apikey、不用签名，接起来最省事；单次整段提交，逐条并发跑。
   * 免费额度不如上面两家，所以权重给得低 —— 用它当「第三路分流」最合适。 */
  function niuOne(text) {
    var key = prefGet(KEY_NIU_KEY, '');
    if (!key) return Promise.reject(new Error('还没填小牛翻译的 apikey'));
    return request('POST', 'https://api.niutrans.com/NiuTransServer/translation',
      'src_text=' + encodeURIComponent(text) +
      '&from=' + (FROM || 'auto') +
      '&to=' + (TO === 'zh-Hans' ? 'zh' : 'en') +
      '&apikey=' + encodeURIComponent(key),
      { 'Content-Type': 'application/x-www-form-urlencoded' }).then(function (s) {
        var d = JSON.parse(s);
        if (d && d.error_code && String(d.error_code) !== '0') {
          throw new Error('小牛 ' + d.error_code + ' ' + (d.error_msg || ''));
        }
        var v = norm(d && (d.tgt_text || d.tgtText));
        if (!v) throw new Error('小牛空译文');
        return v;
      });
  }
  ENGINES.niutrans = {
    label: '小牛翻译（国内，需填 apikey）',
    batch: false,
    parallel: 3,
    share: 7,
    ready: function () { return !!prefGet(KEY_NIU_KEY, ''); },
    translate: function (texts, opts) {
      var abort = opts && opts.abort;
      return mapLimit(texts, ENGINES.niutrans.parallel, function (t) {
        if (abort && abort()) return Promise.resolve(null);
        return niuOne(t);
      }, abort).then(function (out) { return out.map(function (r, i) { return r || texts[i]; }); });
    }
  };

  /* 探测顺序：设备端（离线不出设备）→ 微软 → 有道（国内直连最稳）→
   * DeepL（质量最佳但可能限流）→ Google（需海外网络）→ MyMemory（兜底）
   * 哪个先探测成功用哪个，后面的不再试。 */
  /* 自动选择的尝试顺序，按真机反馈定的原则：
   * 1) 有道放第一：国内网络直连最稳
   * 2) 免费无限额的优先；MyMemory 有每日匿名配额，永远垫底
   * 3) 设备端翻译离线无限额，但依赖系统语言包，能不能用看机器
   * 4) DeepL / Google 质量好，但国内网络大概率不可达（不是代码问题）
   * 5) 微软 Edge 已从列表移除：官方关闭了免费令牌接口（auth 返回 404），
   *    留着只会让每次探测白等一次失败。ENGINES.edge 的实现仍在，可随时恢复。 */
  /* 自动选择的顺序（也是协作时的优先级顺序）：
   * 填了密钥的开放平台排最前 —— 它们单次吞吐大、额度足，是真正的主力；
   * 匿名接口（有道 aidemo）居中；设备端离线但要碰运气；
   * DeepL / Google 需要海外网络；MyMemory 有日配额，永远垫底。
   *
   * ============ 现在的顺序（用户指定，1.2.13 起）============
   * 付费优先：填了密钥的开放平台（有道平台 / 小牛 / 百度）排最前 ——
   *   它们单次吞吐大、额度足，是真正的主力。没填密钥就自动不进池，
   *   自然落到下面这批免费引擎上，不用任何额外判断。
   * 免费顺序：有道 → DeepL → Google → 设备端 → MyMemory（兜底）
   *
   * **顺序不是靠这个数组排的**，它只决定「谁被考虑进池」和池里的初始次序。
   * 真正决定优先级的是各家 share 权重（buildWheel 按它降序排转轮），
   * 所以改顺序要改 share，两个地方一起动才算改完。见下面 buildWheel 的注释。 */
  var ORDER = ['youdaoOpen', 'niutrans', 'baidu',
               'youdao', 'deepl', 'google', 'ondevice', 'mymemory',
               'custom'];
  var SHORT = { ondevice: '设备端', edge: '微软', youdao: '有道', deepl: 'DeepL',
                google: 'Google', mymemory: 'MyMemory', custom: '自定义',
                baidu: '百度', youdaoOpen: '有道平台', niutrans: '小牛' };

  /* ================= 引擎是否可用 / 多引擎协作 ================= */

  /** 这个引擎现在能不能上：退役的、缺密钥的、缺地址的，一律不算数 */
  function isReady(k) {
    var e = ENGINES[k];
    if (!e || e.retired) return false;
    if (e.needUrl && !prefGet(KEY_CUSTOM, '')) return false;
    if (e.ready && !e.ready()) return false;
    return true;
  }
  function hasKey(k) {
    return k === 'baidu' || k === 'youdaoOpen' || k === 'niutrans';
  }

  /* ------------------------------------------------------------------
   * 多引擎协作：让几个引擎一起翻同一页
   *
   * 以前是「整页只认一个引擎」，于是整页的天花板 = 那个引擎的额度。
   * 有道匿名接口连发几十个包就撞 411，一撞就是满页翻不出来 ——
   * 这就是「还是太慢」的真正天花板：不是并发不够、不是包太大，
   * 是**所有段都挤在同一个额度极小的免费口子上**。
   *
   * 现在的做法：
   *   1) 按权重把本页的批分摊给多个引擎（wheel 轮转），
   *      谁单次带得多、额度大，谁就多吃几批；
   *   2) 某引擎中途撞墙（连续失败），它名下剩下的批立刻交给池里的下一个，
   *      不用等整页翻完再整页重来；
   *   3) 填了密钥的开放平台自动当主力，没填就退回匿名组合。
   *
   * 效果上等于把「一个口子」变成「几条车道」：总吞吐是各引擎之和，
   * 单个引擎限流不再等于整页卡住。
   * ------------------------------------------------------------------ */
  var poolWheel = [];        // 本轮的分摊转轮：['baidu','youdao','youdao',...]
  var poolHealth = {};       // name -> { ok, fail, down }
  var poolResetAt = 0;

  function resetPool() {
    poolWheel = [];
    poolHealth = {};
  }
  function poolOk(name) {
    var h = poolHealth[name] || (poolHealth[name] = { ok: 0, fail: 0, down: false });
    h.ok++; h.fail = 0;
    if (h.ok >= 4) h.down = false;      // 缓过来了：重新接纳它
  }
  /** 连续失败 3 次就判它这一轮不行了，剩下的批交给别人 */
  function poolFail(name) {
    var h = poolHealth[name] || (poolHealth[name] = { ok: 0, fail: 0, down: false });
    h.fail++; h.ok = 0;
    if (h.fail >= 3) h.down = true;
  }
  /* 「译出一半」也算不健康 —— 这一条是协作能不能真的提速的关键。
   *
   * 匿名引擎最常见的状态不是「彻底挂了」，而是「额度用完了，还在苟」：
   * 有道 aidemo 发够几十个包之后，一组里往往只译出两三句，剩下的全被
   * 限流兜底成原文。要是只看「这组有没有翻出东西」就判它健康，
   * 它就会一直占着自己那份份额慢慢爬 —— 实测那种情况下整页要 70 秒，
   * 而别的引擎其实 3 秒就翻完了自己那份，然后干等它。
   *
   * 所以：连续三次成功率不到一半，就把它整轮请出去，名下的批交给别人。
   * 它不是坏了，只是今天额度用完了；换页时 resetPool 会重新接纳它。 */
  function poolResult(name, got, total) {
    if (!total) return;
    if (got >= total * 0.5) { poolOk(name); return; }
    var h = poolHealth[name] || (poolHealth[name] = { ok: 0, fail: 0, down: false });
    h.ok = 0;
    h.half = (h.half || 0) + 1;
    if (got <= 0) poolFail(name);
    else if (h.half >= 3) h.down = true;
  }
  function poolDown(name) {
    var h = poolHealth[name];
    return !!(h && h.down);
  }
  /** 按 share 交错展开成转轮：share 4 和 share 2 会摊成「4号、2号、4号、2号…」，
   *  而不是先跑完 4 个再跑 2 个 —— 前者才叫分摊，后者只是排队。 */
  function buildWheel(list) {
    var wheel = [], max = 1, i;
    /* 按权重从高到低排：转轮的前几位永远是吞吐最大的那几家。
     * 页面组数少的时候（大多数页面也就几组），组只会落在前几位上，
     * 慢引擎根本轮不到 —— 权重低的引擎是「保底车道」，不是平摊的队友。 */
    var sorted = list.slice().sort(function (a, b) {
      return ((ENGINES[b] && ENGINES[b].share) || 1) - ((ENGINES[a] && ENGINES[a].share) || 1);
    });
    sorted.forEach(function (n) {
      var sh = ENGINES[n] && ENGINES[n].share || 1;
      if (sh > max) max = sh;
    });
    for (i = 0; i < max; i++) {
      sorted.forEach(function (n) {
        var sh = ENGINES[n] && ENGINES[n].share || 1;
        if (i < sh) wheel.push(n);
      });
    }
    return wheel;
  }
  /** 引擎自己报「我现在正在冷却，先别给我派活」。
   *  只有撞过限流、正在等合闸的引擎会返回 true（见 ENGINES.youdao.cooling）。 */
  function isCooling(name) {
    var e = ENGINES[name];
    return !!(e && e.cooling && e.cooling());
  }
  /**
   * 取第 i 批该给谁：从转轮的 i 位开始往后找，三轮筛选
   *   1) 没被判死、也不在冷却的（最优）
   *   2) 没被判死、但在冷却的（次选：宁可等它，也别把活交给已经不行的）
   *   3) 实在没人了：被判死的也姑且再给一次机会
   * 第 1 轮是协作能不能真正提速的关键 —— 匿名有道撞了 411 之后要合闸
   * 2.5~10 秒，这期间给它派活等于让整页陪它一起等。
   */
  function pickFor(i, exclude) {
    var n = poolWheel.length;
    if (!n) return null;
    exclude = exclude || [];
    var k, name;
    for (k = 0; k < n; k++) {
      name = poolWheel[(i + k) % n];
      if (exclude.indexOf(name) >= 0 || poolDown(name) || isCooling(name)) continue;
      return name;
    }
    for (k = 0; k < n; k++) {
      name = poolWheel[(i + k) % n];
      if (exclude.indexOf(name) >= 0 || poolDown(name)) continue;
      return name;
    }
    for (k = 0; k < n; k++) {
      name = poolWheel[(i + k) % n];
      if (exclude.indexOf(name) < 0) return name;
    }
    return null;
  }

  /**
   * 组成本轮的引擎池。
   * - 用户手动指定了引擎：它排第一、吃最多，其余作为接力的后备
   *   （尊重用户选择，但不再让用户一个人扛整页）
   * - 自动模式：所有「现在能用」的引擎按 ORDER 排队一起上
   * 不需要 probe：探测每个都要真发一次请求，而填了密钥的三家本来就该直接上，
   * 真不行会在翻译里被 poolFail 判死、由别人接手 —— 比先花 5 秒探测划算。
   */
  function planPool(tried) {
    tried = tried || [];
    var cur = currentEngine();
    var list = [];
    /* 用户亲手指定的引擎不受「默认不进池」的限制：他既然点了它，
     * 就是要它上，哪怕要等一次超时。 */
    if (cur !== 'auto' && isReady(cur) && tried.indexOf(cur) < 0) list.push(cur);
    ORDER.forEach(function (k) {
      if (list.indexOf(k) >= 0 || tried.indexOf(k) >= 0) return;   // 已经在名单里 / 这轮试过了
      if (!isReady(k) || isBadNow(k)) return;
      /* MyMemory 的配额是按天算的，确认耗尽之后一段时间内不再让它自动进池
       * （详见 MM_QUOTA_TTL 那段注释）。
       * 只挡「自动进池」这一条路：用户手动点名要用它时，
       * 本函数开头那句 list.push(cur) 已经把它放进名单，不受这条限制。 */
      if (k === 'mymemory' && mmQuotaExhausted()) return;
      /* 海外引擎 / 设备端：进池前必须先验证过能用（详见 REACH_TTL 那段注释）。
       *
       * 上一版这里是「一律放进池，靠 3 秒闸门 + 权重垫后兜住」，实测把整页
       * 从 608ms 拖到 9612ms —— 慢了 15 倍，而且用户手动指定「只用有道」
       * 也一样被拖（有道只分到 1 批，活都派给了连不上的 DeepL）。
       *
       * 现在改成：只有最近探过、确认能用，才准进池。国内探不过 → 不进池，
       * 有道 + MyMemory 全速跑；海外探过了 → 真的多几家能干活的引擎。
       *
       * 手动指定不受这条限制：用户在菜单里点了某家，就是要它上，
       * 哪怕要等一次超时（那句 list.push(cur) 在本函数开头，不经过这里）。 */
      if (reachNeeds(k) && !reachOK(k)) return;
      list.push(k);
    });
    if (!list.length) return null;
    /* 只有免密钥引擎能上、且没有记忆中的最优引擎时才去探测一次：
     * 有道 aidemo 和 MyMemory 都免密钥，直接用即可，探测纯属浪费首个译文的时间。 */
    poolWheel = buildWheel(list);
    return { list: list, primary: list[0], wheel: poolWheel };
  }

  /* ================= 引擎选择 / 探测 ================= */
  function currentEngine() {
    return prefGet(KEY_ENGINE, 'auto') || 'auto';
  }

  /** 用一句短文本试引擎，能译出来才算可用（8 秒没结果就当不可用） */
  /* ------------------------------------------------------------------
   * 准入探测（详见 REACH_TTL 那段注释）
   * ------------------------------------------------------------------ */
  function reachStore() {
    try {
      var v = prefGet(REACH_KEY, null);
      return (v && typeof v === 'object') ? v : {};
    } catch (e) { return {}; }
  }
  /** 这个引擎属于「进池前要先验证」的那一类吗（海外 / 设备端） */
  function reachNeeds(k) {
    var e = ENGINES[k];
    return !!(e && (e.overseas || e.needProbe));
  }
  /** 最近验证过能用吗？没验证过、或验证过了但已过期，都算「还没资格」 */
  function reachOK(k) {
    var m = reachStore()[k];
    return !!(m && m.ok && (Date.now() - (m.at || 0)) < REACH_TTL);
  }
  var reachProbing = null;
  /** 后台把「还没资格」的都探一遍，结果记下来给下一轮用。
   *  刻意不 await：它只决定**下一页**能不能用上这几家，
   *  当前这一页照旧走已经验证过的引擎，一毫秒都不多等。 */
  function checkReach() {
    if (reachProbing) return reachProbing;              // 正在探，别重复发起
    var todo = ORDER.filter(function (k) {
      return reachNeeds(k) && isReady(k) && !reachOK(k);
    });
    if (!todo.length) return Promise.resolve([]);
    reachProbing = Promise.all(todo.map(function (k) {
      /* 探测也用那道短闸门：连不上就是连不上，没必要等满 5 秒 */
      return probe(k, SLOW_TIMEOUT).then(function (ok) {
        var all = reachStore();
        all[k] = { ok: !!ok, at: Date.now() };
        try { prefSet(REACH_KEY, all); } catch (e) {}
        return { engine: k, ok: !!ok };
      }, function () {
        var all2 = reachStore();
        all2[k] = { ok: false, at: Date.now() };
        try { prefSet(REACH_KEY, all2); } catch (e2) {}
        return { engine: k, ok: false };
      });
    }));
    reachProbing.then(function () { reachProbing = null; },
                      function () { reachProbing = null; });
    return reachProbing;
  }

  function probe(name, ms) {
    var e = ENGINES[name];
    if (!e) return Promise.resolve(false);
    if (!isReady(name)) return Promise.resolve(false);   // 没填密钥 / 没填地址的一律不探
    if (name === 'ondevice') return probeOnDevice(ms);
    return realProbe(e, ms);
  }

  function realProbe(e, ms) {
    var timeout = new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('探测超时')); }, ms || PROBE_TIMEOUT);
    });
    return Promise.race([
      e.translate(['Hello, world!']).then(function (r) {
        var t = r && r[0];
        /* 探测这一发不该占用限流队列：它只为了确认「这个引擎能用」，
         * 却会把有道那个 800ms 的节流阀往后推一格 —— 于是每次新会话的
         * 第一批真实译文都要白等 800ms（实测首个译文从 996ms 降到 ~200ms）。
         * 探测成功后把队列清零，好钢用在真要翻的那批上。 */
        if (e && e.resetThrottle) { try { e.resetThrottle(); } catch (err) {} }
        return !!(t && t !== 'Hello, world!' && /[一-龥]/.test(t));
      }, function () { return false; }),
      timeout
    ]).catch(function () { return false; });
  }

  /** 设备端翻译先问 availability：语言包没装就是 unavailable，
   *  'downloadable' 也先放弃 —— 真去下载会卡住首次翻译，得不偿失。
   *  实测部分 WebView 里 availability() 会永久挂起（8 秒都不响应），
   *  不加超时的话整个自动选择会被它卡死 —— 必须race 一个超时。 */
  function probeOnDevice(ms) {
    if (!onDeviceReady()) return Promise.resolve(false);
    var av;
    try {
      av = Promise.resolve(window.Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' }));
    } catch (e) { return Promise.resolve(false); }
    var timeout = new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('探测超时')); }, ms || PROBE_TIMEOUT);
    });
    return Promise.race([
      av.then(function (a) { return a === 'available' ? realProbe(ENGINES.ondevice) : false; },
              function () { return false; }),
      timeout
    ]).catch(function () { return false; });
  }

  var probing = null;
  /**
   * 选本轮要用的引擎：
   * - 手动指定的引擎，只要这一轮还没试过 → 永远先给它机会（用户的选择
   *   就是选择；挂了自然有降级兜底。不能因为 5 分钟前挂过就替用户做主）
   * - 否则（auto / 手动的这轮已经失败过）在剩余候选里并行探测，谁快用谁
   * - 全都没戏 → null（调用方提示所有引擎不可用）
   */
  function ensureEngine(tried) {
    tried = tried || [];
    var cur = currentEngine();
    /* 手动选的引擎如果已经停用（微软 Edge），不能因为「用户选过」就硬着头皮用：
     * 用户当年选它是因为它能用，现在它不能用了，替用户换掉才是尊重他的本意。
     * 提示一次，之后按自动选择走。 */
    if (cur !== 'auto' && ENGINES[cur] && ENGINES[cur].retired) {
      if (!ensureEngine._told) {
        ensureEngine._told = {};
      }
      if (!ensureEngine._told[cur]) {
        ensureEngine._told[cur] = true;
        toast('「' + (SHORT[cur] || cur) + '」' + (ENGINES[cur].retiredWhy || '已不可用') +
          '，已自动改用其他引擎');
      }
      cur = 'auto';
    }
    if (cur !== 'auto' && isReady(cur) && tried.indexOf(cur) < 0) {
      return Promise.resolve(cur);
    }
    var candidates = ORDER.filter(function (k) {
      return tried.indexOf(k) < 0 && isReady(k) && !isBadNow(k);
    });
    if (!candidates.length) return Promise.resolve(null);
    if (probing) return probing;
    var memo = prefGet('gh_tr_pick', '');
    if (memo && ENGINES[memo] && candidates.indexOf(memo) >= 0 && !isBadNow(memo)) {
      return Promise.resolve(memo);
    }
    /* 刚经历过一次「全军覆没」就进入冷却：2 分钟内不再全量探测，直接拿
     * 第一个候选硬上（失败有重试循环兜底）。探测是要真发网络请求的，
     * Google/DeepL 这类连不上的家伙一挂就是一整个连接超时——每换一页
     * 都来这么一轮，页面自己的数据请求就全堵在后面排队（骨架屏转圈）。 */
    if (Date.now() < probeCoolUntil) {
      return Promise.resolve(candidates[0] || null);
    }
    probing = probeFastest(candidates);
    return probing.then(function (r) {
      probing = null;
      if (!r) probeCoolUntil = Date.now() + 2 * 60 * 1000;
      return r;
    }, function (e) { probing = null; throw e; });
  }

  var probeCoolUntil = 0;

  /**
   * 同时向候选引擎发探测，谁先成功就用谁。
   * 原来是挨个串行试：前面几个不通的话，光等待超时就把首次翻译拖成几十秒。
   * 并行之后总耗时 ≈ 最快那个引擎的响应时间 —— 顺带还自动选出了最快的。
   * 低优先级引擎稍微延后一点再发，避免浪费请求。
   * 全部失败返回 null（调用方负责提示），不再硬塞一个默认引擎——
   * 以前全挂时兜底 edge，真机上就是「微软 HTTP 404」的来源。
   */
  function probeFastest(candidates) {
    /* 拉黑名单里的不再探测：探测它们只会白占一个网络线程一整个连接超时 */
    candidates = (candidates || ORDER.slice()).filter(function (k) { return !probeBlocked(k); });
    return new Promise(function (resolve) {
      var settled = false, pending = candidates.length;
      function settle(v) { if (!settled) { settled = true; resolve(v); } }
      /* 总兜底：任何引擎的探测都可能挂起（真机 WebView 上 availability 就会），
       * 到点还没人选，就认输返回 null —— 绝不让自动选择卡死翻译。 */
      var overall = setTimeout(function () { settle(null); }, PROBE_TIMEOUT + 2500);
      if (!pending) { clearTimeout(overall); return settle(null); }
      candidates.forEach(function (name, i) {
        var delay = i === 0 ? 0 : i * 200;
        setTimeout(function () {
          if (settled) return;
          probe(name).then(function (ok) {
            if (settled) return;
            if (ok) { clearTimeout(overall); prefSet('gh_tr_pick', name); clearBad(name); settle(name); return; }
            /* 探测失败也要记账：连不上的引擎（Google/DeepL 在国内）一探测
             * 就把原生网络线程挂满一个连接超时，不记账的话每换一页都要
             * 重来一轮 —— 页面数据请求全被堵在后面排队。 */
            probeFailed(name);
            if (--pending === 0) { clearTimeout(overall); settle(null); }
          }, function () {
            if (settled) return;
            probeFailed(name);
            if (--pending === 0) { clearTimeout(overall); settle(null); }
          });
        }, delay);
      });
    });
  }

  /* ================= 译文缓存 ================= */
  var cache = prefGet(KEY_CACHE, {}) || {};
  /* 缓存版本：历史上失败兜底曾把"原文"当译文写进缓存（v1 的 bug），
   * 命中原文的缓存会让页面永远停在英文。升版本号触发一次全清，老用户
   * 升级后即自愈，不用手动清缓存。 */
  var CACHE_VER = 2;
  if (prefGet('gh_tr_cache_ver', 1) !== CACHE_VER) {
    cache = {};                       // 旧版本缓存一律作废
    prefSet(KEY_CACHE, cache);
    prefSet('gh_tr_cache_ver', CACHE_VER);
  }
  /* 读一次就挪到末尾 —— 对象的键顺序就是「最近用过」的顺序，
   * delete + 重新赋值是把它搬到队尾最便宜的办法（O(1)）。
   * 有了它，淘汰时才不会把用户反复在看的那几段当成最老的扔掉。
   * 注意**不标脏**：内容没变，只是顺序变了，没必要为它多落一次盘；
   * 最坏情况只是「重启后顺序回到上次落盘的样子」，不影响正确性。 */
  function cacheGet(k) {
    var v = cache[k];
    if (v !== undefined && cacheCount > 1) { delete cache[k]; cache[k] = v; }
    return v;
  }

  /* ------------------------------------------------------------------
   * 落盘去抖（这里是「翻译越来越慢」的头号元凶）
   *
   * 老写法每译出一段就 prefSet 一次整份缓存——一轮几十段就是几十次：
   *   · Object.keys(整份缓存)      —— 全表扫描，只为数个数
   *   · JSON.stringify(整份缓存)   —— 几百 KB 反复序列化
   *   · 跨桥 setPref + 原生落盘    —— 每次一次 SharedPreferences.apply
   *   · localStorage.setItem       —— 再写一遍
   * 缓存从空攒到上限的过程中单次成本线性上涨，恰好就是用户感觉到的
   * 「用得越久、翻译越慢」。
   *
   * 现在：内存里立刻生效（同一轮后面的批次该命中照样命中），
   * 落盘合并到一轮结束后的那一次。
   * ------------------------------------------------------------------ */
  var cacheCount = 0;
  var cacheDirty = false;
  var cacheFlushTimer = 0;
  (function countCache() {
    // 只在启动时数一次，之后用 cacheCount 增量维护，不再反复 Object.keys
    for (var kk in cache) { if (Object.prototype.hasOwnProperty.call(cache, kk)) cacheCount++; }
  })();

  function flushCache() {
    if (cacheFlushTimer) { clearTimeout(cacheFlushTimer); cacheFlushTimer = 0; }
    if (!cacheDirty) return;
    cacheDirty = false;
    if (cacheCount > CACHE_MAX) {
      /* 淘汰：扔最久没用过的（cacheGet 会把用过的搬到队尾，所以队头就是最冷的）。
       * 多扔 CACHE_MAX/8 条当缓冲：只扔到刚好等于上限的话，下一个新词条
       * 立刻又要扫一遍全表再扔一次 —— 翻一篇长文时会连着被触发几十次。 */
      var keys = Object.keys(cache);
      var dropN = Math.min(keys.length, (cacheCount - CACHE_MAX) + Math.floor(CACHE_MAX / 8));
      for (var i = 0; i < dropN; i++) delete cache[keys[i]];
      cacheCount -= dropN;
    }
    prefSet(KEY_CACHE, cache);
  }

  function scheduleCacheFlush() {
    if (cacheFlushTimer) return;
    cacheFlushTimer = setTimeout(function () {
      cacheFlushTimer = 0;
      flushCache();
    }, 400);
  }

  function cacheSet(k, v) {
    if (cache[k] === undefined) cacheCount++;
    cache[k] = v;
    cacheDirty = true;
    scheduleCacheFlush();
  }

  /* ------------------------------------------------------------------
   * 「翻不出来的段」记账（只在内存里，不落盘）
   *
   * 一整句请求**成功了**、但译回来跟原文一模一样，说明引擎对这段确实
   * 没有对应译文 —— 路径、命令名、专有名词（solutions/、man bash、apt…
   * 实测一篇长文里有一两百段）。它跟「请求失败」不是一回事：
   * 失败走 catch，压根到不了记账这一步；所以记这一笔不会误伤限流。
   *
   * 不记的话会怎样：retryLoop 有 5 轮（1.2s 起，总共 28 秒），
   * 每轮都会把这些段再翻一遍 —— 几百次注定空手的请求，
   * 而且每轮都要占住 busy、把 seq 顶上去，
   * 用户这时候往下滚触发的翻译反而被挤到后面排队。
   *
   * 只在本轮有效、只认当前引擎 + 目标语言，换引擎或换语言就清空：
   * 换个引擎说不定就翻得出来了，不能替人家把门关死。
   * ------------------------------------------------------------------ */
  var noop = Object.create(null);
  var noopN = 0;
  var NOOP_MAX = 4000;
  function resetNoop() { noop = Object.create(null); noopN = 0; }
  function markNoop(t) {
    if (!t) return;
    var k = (state.engine || '') + '|' + TO + '|' + hash(t);
    if (noop[k]) return;
    if (noopN >= NOOP_MAX) resetNoop();
    noop[k] = 1; noopN++;
  }
  function isNoop(t) {
    return noopN > 0 && !!noop[(state.engine || '') + '|' + TO + '|' + hash(t)];
  }
  /* 这几个时机必须立刻落盘，不能等去抖计时器：
   * App 被切后台、页面被回收、用户手动还原原文/关总开关，晚一步就丢这一轮的译文。 */
  function installCacheFlushHooks() {
    var now = function () { try { flushCache(); } catch (e) {} };
    if (window.addEventListener) {
      window.addEventListener('pagehide', now);
      window.addEventListener('beforeunload', now);
      try {
        if (document.addEventListener) {
          document.addEventListener('visibilitychange', function () {
            if (document.hidden) now();
          });
        }
      } catch (e) {}
    }
  }

  /* ================= 文本收集 ================= */
  var SKIP_SEL = 'pre, code, svg, script, style, textarea, noscript, [data-no-translate], .no-translate, .hljs, .tr-skip';

  function inSkip(node) {
    var p = node.parentElement;
    if (!p) return true;
    if (p.closest) { try { return !!p.closest(SKIP_SEL); } catch (e) {} }
    // 老 WebView 没有 closest 时手动向上找
    while (p) {
      if (p.nodeName === 'PRE' || p.nodeName === 'CODE' || p.nodeName === 'SVG' ||
          p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE' || p.nodeName === 'TEXTAREA') return true;
      if (p.getAttribute && p.getAttribute('data-no-translate') !== null) return true;
      p = p.parentElement;
    }
    return false;
  }

  var RE_URL = /^(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+)/i;
  var RE_PATH = /^[\w.\-]+([\/:][\w.\-]+)+$/;              // app/src/main、owner/repo
  var RE_SHA = /^[0-9a-f]{7,40}$/i;
  var RE_NUM = /^[\d\s.,:+*/=<>%#&|~^$@!?'"()\[\]{}\-_\\]+$/;
  var RE_REF = /^[@#][\w/-]+$/;                             // @someone、#123
  var RE_VER = /^v?\d+(\.\d+)*[a-z]?$/i;                    // v1.1.2
  // 相对时间：10 minutes ago / 2 hours ago / just now。
  // 探索页有个定时器隔一会儿就把这些刷一遍，不跳过的话每次刷新都会
  // 被当成「新内容」重新收进来翻译一遍。
  var RE_AGO = /^(\d+\s+(seconds?|s|minutes?|m|hours?|h|days?|d|weeks?|w|months?|years?|y)\s*ago|just now|now|yesterday|last (hour|day|week|month|year))$/i;

  /* ------------------------------------------------------------------
   * 按 Unicode 区段判断一段文本「主要用什么文字书写」
   *
   * 老逻辑只有一句 if (!/[A-Za-z]/.test(s)) return false ——
   * 于是日文、韩文、俄文、阿拉伯文、泰文、希腊文、希伯来文…
   * 全因为没有拉丁字母而被判定「不值得翻译」，从头到尾没进过翻译流程。
   * 这就是「只能翻英文」的真正瓶颈，跟引擎没关系：引擎那边一直是 auto 检测。
   *
   * 现在改成看「书写系统」而不是看「有没有 ABC」：
   *   目标是中文 → 非汉字的都翻
   *   目标是英文 → 非拉丁字母的都翻
   * 各引擎自身支持上百种语言，这里放行之后它们就能干活了。
   * ------------------------------------------------------------------ */
  /* 区间表而不是正则：这一段会被每个候选节点调用一次，探索页一屏几百个、
   * 滚起来上千个候选。用正则就得给每个字符跑十来个状态机 —— 实测
   * 600 行的页面一轮要 49ms；改成 charCodeAt + 数值比较后回落到 12ms。 */
  var SCRIPTS = [
    { id: 'cjk', ranges: [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x3005, 0x3007]] },  // 汉字
    { id: 'kana', ranges: [[0x3040, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9f]] },                   // 假名（含半角）
    { id: 'hangul', ranges: [[0x1100, 0x11ff], [0x3130, 0x318f], [0xac00, 0xd7af]] },                 // 韩文
    { id: 'cyrillic', ranges: [[0x0400, 0x04ff], [0x0500, 0x052f]] },                                 // 俄文等
    { id: 'arabic', ranges: [[0x0600, 0x06ff], [0x0750, 0x077f], [0xfb50, 0xfdff]] },
    { id: 'hebrew', ranges: [[0x0590, 0x05ff]] },
    { id: 'thai', ranges: [[0x0e00, 0x0e7f]] },
    { id: 'greek', ranges: [[0x0370, 0x03ff], [0x1f00, 0x1fff]] },
    { id: 'devanagari', ranges: [[0x0900, 0x097f], [0xa8e0, 0xa8ff]] },                              // 印地语/梵文
    { id: 'latin', ranges: [[0x41, 0x5a], [0x61, 0x7a], [0xc0, 0x24f], [0x1e00, 0x1eff], [0xff21, 0xff3a], [0xff41, 0xff5a]] }
  ];
  /* 目标语言对应的书写系统：达到这个占比就认为「已经目标语言了」。
   * 0.35 沿用原来判断中英文的经验阈值。 */
  var TARGET_SCRIPT = { 'zh-Hans': 'cjk', 'en': 'latin' };
  var OWN_RATIO = 0.35;

  /** 一个字符属于哪种书写系统（不属于任何文字系统则返回 ''） */
  function scriptOfChar(cc) {
    /* ASCII 快路径：GitHub 上绝大部分文本是英文，这条分支几乎包圆了，
     * 连下面的表都不用查。 */
    if (cc < 0x80) return ((cc >= 0x41 && cc <= 0x5a) || (cc >= 0x61 && cc <= 0x7a)) ? 'latin' : '';
    for (var i = 0; i < SCRIPTS.length; i++) {
      var rs = SCRIPTS[i].ranges;
      for (var j = 0; j < rs.length; j++) {
        if (cc >= rs[j][0] && cc <= rs[j][1]) return SCRIPTS[i].id;
      }
    }
    return '';
  }

  /** 扫一遍，算出每种书写系统各占多少字符（非文字字符不计入分母） */
  function scriptMixed(s) {
    var counts = {}, letters = 0, i, k, id;
    for (i = 0; i < SCRIPTS.length; i++) counts[SCRIPTS[i].id] = 0;
    for (i = 0; i < s.length; i++) {
      id = scriptOfChar(s.charCodeAt(i));
      if (id) { counts[id]++; letters++; }
    }
    return { counts: counts, letters: letters };
  }

  /** 这段文本主要是哪种书写系统（没有可识别文字则返回 ''） */
  function detectScript(s) {
    var m = scriptMixed(s);
    if (!m.letters) return '';
    var best = '', bestN = 0;
    for (var k in m.counts) {
      if (Object.prototype.hasOwnProperty.call(m.counts, k) && m.counts[k] > bestN) {
        bestN = m.counts[k]; best = k;
      }
    }
    return best;
  }

  /** 给不支持 auto 的引擎（MyMemory）猜一个源语言代码 */
  var SCRIPT_LANG = { cjk: 'zh', kana: 'ja', hangul: 'ko', cyrillic: 'ru',
                      arabic: 'ar', hebrew: 'he', thai: 'th', greek: 'el',
                      devanagari: 'hi', latin: 'en' };
  function guessSource(s) { return SCRIPT_LANG[detectScript(s)] || ''; }

  /**
   * 这段文本是否已经「用目标语言写着」—— 是就不用翻了。
   *
   * 最麻烦的是【日文】：它大量借用汉字，「リポジトリの活動に関する説明」
   * 一句里汉字段落能占到三成七，光看汉字占比会被判成中文而跳过。
   * 所以判据不能只看占比，得先看有没有「决定性特征字符」：
   * 只要出现假名，这段文字就是日文，跟汉字占多少没关系。
   */
  /**
   * 目标 = 英文时的补充判据。
   *
   * 法文 / 德文 / 西班牙文 / 葡萄牙文 / 越南文 / 土耳其文… 用的也是拉丁字母，
   * 光看书写系统跟英文一模一样，分不出来。但它们普遍带附加符号
   * （é ü ñ ç ş ộ ư），正经英文很少这么写。
   * 所以「带符号的拉丁字母占比异常高」就当它不是英文，翻。
   *
   * 门槛按实测样本定在 8%：法语、波兰语、越南语一般在 8~30%，
   * 德语 / 西班牙语的重音太稀疏（2~3%）够不着——抱歉，这两种真分不出来。
   * 8% 能让 Björn(3.8%)、Pokémon(3.8%) 这类散在英文里的外来词稳稳留在原地。
   * 真翻错了也只是多翻一句，而漏翻会让整篇法语 README 停在原地，后者更亏。
   */
  var RE_ACCENTED = /[\u00c0-\u00ff\u0100-\u017f\u1e00-\u1eff]/;
  function heavyAccent(s) {
    if (!RE_ACCENTED.test(s)) return false;                 // 一个符号都没有：快路径，不必数
    var lat = (s.match(/[A-Za-z\u00c0-\u00ff\u0100-\u017f\u1e00-\u1eff]/g) || []).length;
    if (!lat) return false;
    var acc = (s.match(/[\u00c0-\u00ff\u0100-\u017f\u1e00-\u1eff]/g) || []).length;
    return acc / lat > 0.08;
  }

  /**
   * 有没有「成词的另一种文字」：连续 2 个以上不属于目标书写系统的字母。
   *
   * 光看占比判不出混排：『中文里掺 English 词』里汉字照样过半，按占比就是
   * 「已经是中文」，可用户想翻的恰恰是夹在里面的那几个英文单词；
   * 『英文里掺中文』同理。所以占比过半之后还要再扫一遍，看有没有成段的外文。
   *
   * 门槛取 2 是为了放过零散的单个字母（"……只有一个 a ……"），
   * 那种真的是母语文本，翻了没意义。数字和标点不算字母，会打断连续段。
   */
  function hasForeignWord(s, want) {
    var run = 0;
    for (var i = 0; i < s.length; i++) {
      var id = scriptOfChar(s.charCodeAt(i));
      if (id && id !== want) {
        run++;
        if (run >= 2) return true;
      } else {
        run = 0;
      }
    }
    return false;
  }

  function isTargetLanguage(s, alreadyCounted) {
    var want = TARGET_SCRIPT[TO] || 'cjk';
    var m = alreadyCounted || scriptMixed(s);   // 调用方算过了就别再扫一遍
    if (!m.letters) return true;                        // 没有可识别文字：翻也无意义
    if (want === 'cjk' && m.counts.kana > 0) return false;   // 含假名 = 日文，要翻
    if (want === 'latin' && heavyAccent(s)) return false;    // 一堆附加符号 = 多半是欧陆语言
    /* 明显不是目标语言（占比不过半）：直接翻，不必再扫一遍。
     * 英文页面配「翻成中文」走的就是这条快路径，几乎不额外花钱。 */
    if ((m.counts[want] || 0) / m.letters <= OWN_RATIO) return false;
    /* 占比过半了，但里面可能还夹着成词的另一种文字——那种也是要翻的。
     * 「中文里掺英文」「英文里掺中文」都属于这一类，以前会被直接跳过。 */
    return !hasForeignWord(s, want);
  }
  /* 编程语言名：探索页的语言标签整段就是 "TypeScript"，送去翻会变成「打印稿」
   * 这种笑话，还白耗一次请求。整段等于语言名的一律跳过。 */
  var RE_LANG = /^(actionscript|ada|assembly|bash|c|c\+\+|c#|clojure|cmake|cobol|coffee(script)?|crystal|css|d|dart|dockerfile|elixir|erlang|f#|fortran|go|gradle|groovy|haskell|html|java|javascript|julia|jupyter(\s?notebook)?|kotlin|lua|matlab|nim|nix|objective-c|ocaml|pascal|perl|php|powershell|prolog|python|r|racket|ruby|rust|scala|scheme|shell|smalltalk|solidity|sql|svelte|swift|tcl|typescript|vb\.?net|vue|vue\.js|zig)$/i;

  /** 判断一段文本值不值得送去翻译 */
  function needTranslate(raw) {
    var s = norm(raw);
    if (s.length < 2) return false;
    /* 没有任何可识别文字（纯数字、符号、emoji）：翻了也没意义。
     * 以前这里是 if (!/[A-Za-z]/) —— 把日韩俄阿泰一起挡在门外了。
     * 一次扫描的结果两个判断共用，别扫两遍。 */
    var m = scriptMixed(s);
    if (!m.letters) return false;
    /* 已经写着目标语言：不用翻。
     * 以前只判断中文占比；现在按当前目标的书写系统判断，
     * 所以「翻成中文」和「翻成英文」两种情况都能正确跳过母语文本。 */
    if (isTargetLanguage(s, m)) return false;
    if (RE_URL.test(s) || RE_PATH.test(s) || RE_SHA.test(s) || RE_NUM.test(s) ||
        RE_REF.test(s) || RE_VER.test(s) || RE_AGO.test(s)) return false;
    /* 语言名单拎出来：RE_LANG 是几十个分支的大正则，而语言名最长也就
     * "jupyter notebook"（16 字符）这一档。先按长度剪一刀，长句根本不进去——
     * 探索页一屏几百个候选，这里省下来的是最贵的一笔。 */
    if (s.length <= 20 && RE_LANG.test(s)) return false;
    /* 这里原本还有一句 if (/^\W+$/) return false —— 本意是「纯标点就不翻」。
     * 但 JS 的 \W 是 [^A-Za-z0-9_]，中文、日文、俄文全都被算成 \W，
     * 于是这一句会把所有非拉丁文本当成「纯符号」直接跳过。
     * 以前它前面有一道 if (!/[A-Za-z]/) 的闸门，非拉丁文本根本走不到这儿，
     * 所以一直相安无事；闸门拆掉之后它就露出獠牙了。
     * 现在「有没有可识别文字」已经由 detectScript 负责，这一句纯属多余且有害。 */
    return true;
  }

  /**
   * 收集文本节点，并标出「现在屏幕上看得见」的那些。
   * 标出来是为了让首屏先翻、先上屏 —— 用户盯着屏幕的那几段一秒不到就变中文，
   * 屏幕外的交给后台慢慢翻，等滚到了早就译好了，感觉不到等待。
   *
   * 第三个参数 reach = 「往视口**下方**还能看多远」。
   *   滚动驱动（默认）：上下各 600px，滚过去时刚好译好。
   *   整篇模式（README 这类长文档）：传 Infinity，一次把整篇都收进来。
   * 上边界始终只留 600px —— 上面是已经看过的地方，多看没有意义。
   *
   * 排序键仍然是「离**真实视口中心**多远」，跟 reach 无关：
   * reach 放大了只是让更多段进入这一轮，谁先上屏还看谁离眼睛近。
   */
  function collect(root, near, reach) {
    var out = [];
    var vh = (window.innerHeight || document.documentElement.clientHeight || 800);
    /* 滚动驱动：只收「附近」的段——视口上下各多看 600px，滚过去时刚好译好。
     * 不再后台翻整页：整页几十段并发是有道限流的元凶，而且用户滚过去时
     * 经常看到的还是没翻的。near=false 才收全页（现在没有调用方用了）。 */
    var pad = near === false ? 150 : 600;
    var down = (reach === undefined || reach === null) ? pad : reach;
    /* 同一父元素只量一次位置：getBoundingClientRect 每次都可能强制浏览器
     * 重新排版，探索页一个条目里七八个文本节点共用同一个父元素，
     * 不缓存的话一轮 collect 就是几百次强制布局 —— 页面渲染被翻译卡住。 */
    var rects = new Map();
    /* 同一个父元素下的判定结果，按父元素缓存两份：
     *   1) getBoundingClientRect（上面那条注释说的：避免反复强制重排）
     *   2) inSkip —— 它内部是 p.closest(SKIP_SEL)，每次都要把那串选择器
     *      解析一遍。一个条目里七八个文本节点共用一个父元素，等于同一件事
     *      干七八遍。探索页滚到几百条时这一项自己就能吃掉几十毫秒。 */
    var skips = new Map();
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      if (n.__tr_done) continue;
      var p = n.parentElement;
      var skipped = skips.get(p);
      if (skipped === undefined) { skipped = inSkip(n); skips.set(p, skipped); }
      if (skipped) continue;
      if (!needTranslate(n.nodeValue)) continue;
      /* 这一轮已经确认「引擎翻不出别的花样」的段，别再排进来了 */
      if (isNoop(norm(n.nodeValue))) continue;
      if (p && p.getBoundingClientRect) {
        var r = rects.get(p);
        if (!r) { r = p.getBoundingClientRect(); rects.set(p, r); }
        if (!(r.bottom > -pad && r.top < vh + down)) continue;  // 不在视野附近：留给滚动触发
        out.push({ node: n, text: norm(n.nodeValue), visible: true, top: r.top });
      }
    }
    /* 离视线越近的越先翻：从上屏顺序上保证「你正盯着的这几段最先变中文」，
     * 屏幕边缘的随后跟上。探测/拼批都要一两个来回，顺序就是速度。 */
    out.sort(function (a, b) {
      return Math.abs(a.top - vh / 2) - Math.abs(b.top - vh / 2);
    });
    return out;
  }

  /* ------------------------------------------------------------------
   * 「有没有新内容要翻」的问询，短时间内只需要一个答案
   *
   * 换页/补翻一共有三条链在各自轮询：watchView 900ms、catchUp 1200ms、
   * retryLoop 4000ms，再加上滚动的 watchScroll。它们互不知情，经常挤在
   * 同一两百毫秒里把整棵子树各扫一遍——同一个结果算三四遍。
   *
   * 这里给这种「只是问问」的调用加一个很短的结果复用窗：
   *   · 真正要开翻时（translatePage）会先作废旧答案再重扫，拿的一定是最新 DOM
   *   · 最坏情况只是「晚 250ms 发现新内容」，而下一轮轮询本来就 900ms 起步
   * 单次扫描在探索页上千节点时要几十毫秒，合并掉重复的那几次是纯赚。
   * ------------------------------------------------------------------ */
  var COLLECT_TTL = 250;
  var _cCache = null, _cAt = 0, _cWhole = false;
  function invalidateCollect() { _cCache = null; _cAt = 0; }
  /* whole 必须参与缓存判等：整篇模式问的是「整篇还有没有没翻的」，
   * 拿「视口附近还有没有」的旧答案来答，会得到「没有了」——
   * 于是整篇推进刚翻完第一屏就收工，后半截永远停在英文。 */
  function peekCollect(whole) {
    var now = Date.now();
    if (_cCache && now - _cAt < COLLECT_TTL && !!whole === _cWhole) return _cCache;
    _cCache = collect(root(), true, whole ? Infinity : undefined);
    _cAt = now;
    _cWhole = !!whole;
    return _cCache;
  }

  /** maxItems 让引擎能按自己的胃口定组大小。
   * 不传就是 MAX_ITEMS=40 —— 40 对微软/Google 合适，对有道却错半档：
   * 有道单条请求最多吃 36 行，40 段的组一定会被它自己再切一刀，
   * 剩下那 4 段单开一条请求。让组的大小直接等于「一条请求能装多少段」，
   * 段短的时候（列表、标题多的页面）刚好一组一次请求，不再有零头。
   * 实测 200 段的页面：20 次请求 → 17 次。
   * 段长的时候字符上限先顶到，照样会切 —— 那不是这一刀能省的。 */
  function batch(items, maxItems, maxChars) {
    var cap = maxItems || MAX_ITEMS;
    var charCap = maxChars || MAX_CHARS;
    var groups = [], cur = [], len = 0, vis = false;
    items.forEach(function (it) {
      if ((len + it.text.length > charCap || cur.length >= cap) && cur.length) {
        groups.push({ items: cur, visible: vis }); cur = []; len = 0; vis = false;
      }
      cur.push(it); len += it.text.length;
      if (it.visible) vis = true;
    });
    if (cur.length) groups.push({ items: cur, visible: vis });
    return groups;
  }

  /* ================= 翻译流程 ================= */
  var state = {
    busy: false,
    done: false,          // 当前页是否已翻译
    nodes: [],            // 本页被改过的节点，用于还原
    seq: 0,               // 切页自增，丢弃上一页的迟到结果
    engine: '',           // 上次实际使用的引擎
    ms: 0                 // 上次翻译耗时（毫秒）
  };

  function root() {
    return document.getElementById('view') || document.body;
  }

  /** 一批失败时把任务对半拆开重试：批量超限（微软/Google 都有长度限制）时很管用
   *  opts = { abort, onPartial }：abort 为真不再往下拆也不再发请求；
   *  onPartial 由引擎在译出一部分时回调（下标是相对本批 texts 的）。 */
  function translateBatch(engine, texts, depth, opts) {
    opts = opts || {};
    if (opts.abort && opts.abort()) return Promise.resolve(texts.slice());
    return engine.translate(texts, opts).then(function (out) {
      if (!out || out.length !== texts.length) throw new Error('返回条数不符');
      return out;
    }).catch(function (e) {
      if (texts.length <= 1 || depth >= 3) throw e;
      if (opts.abort && opts.abort()) throw e;
      var mid = Math.ceil(texts.length / 2);
      /* 拆两半时各自的下标要平移：右半边的 onPartial(start) 是相对自己那半的，
       * 回到本批要加上 mid，上屏才不会写错节点。 */
      var wrap = function (base) {
        var sub = { abort: opts.abort };
        if (opts.onPartial) {
          sub.onPartial = function (start, arr) { opts.onPartial(base + start, arr); };
        }
        return sub;
      };
      return Promise.all([
        translateBatch(engine, texts.slice(0, mid), depth + 1, wrap(0)),
        translateBatch(engine, texts.slice(mid), depth + 1, wrap(mid))
      ]).then(function (p) { return p[0].concat(p[1]); });
    });
  }

  /* 引擎「临时不可用」记忆：整轮全败的引擎记 5 分钟，期间自动选择直接跳过它，
   * 免得用户手动选了个必挂的引擎后，每次换页都要先撞一次 404/超时再降级。 */
  var badUntil = {};
  function isBadNow(name) { return (badUntil[name] || 0) > Date.now(); }
  function markBad(name, ms) {
    if (name) badUntil[name] = Date.now() + (ms || 5 * 60 * 1000);
  }
  function clearBad(name) { delete badUntil[name]; }
  /* 探测黑名单（独立于 badUntil）：探测失败的引擎 10 分钟内不再参与探测。
   * 为什么不直接用 markBad？真翻译的降级链路里还是该给它们机会——
   * 万一网络刚好恢复；但探测是每换一页都可能跑的，连不上的引擎
   * 一探测就挂满一个连接超时，把原生网络线程占死。 */
  var probeFailUntil = {};
  function probeBlocked(name) { return (probeFailUntil[name] || 0) > Date.now(); }
  function probeFailed(name) { if (name) probeFailUntil[name] = Date.now() + 3 * 60 * 1000; }

  /* ------------------------------------------------------------------
   * 整篇模式：一次把整篇文档翻掉，不再等用户一屏一屏滚
   *
   * 为什么只给文档用 ——
   *   探索页 / 搜索结果那种列表，数据是持续加载的，而且一屏就几十段，
   *   滚动驱动够用。README 不是：它是「页面画完之后才被塞进来」的静态长文档，
   *   实测 1813 段（donnemartin/system-design-primer 那份）。
   *   滚动驱动的窗口是视口 ±600px，一屏只推进约 30 段，
   *   全文读完要滚 57 屏 —— 累计 25 秒都在等翻译。
   *   整篇一次翻完实测 2.0 秒，而首屏出中文的那一刻一点没变慢
   *   （collect 按离视口中心的距离排序，眼睛盯着的还是最先上屏）。
   *
   * 为什么要切块 ——
   *   一口气发完最快：实测 99 个请求、2.2 秒翻完整篇。可那是一次巨大的突发，
   *   撞上有道限流（411）就要连着退让好几拍，代价太不稳定。
   *   切成每轮 WHOLE_CHUNK 段（约 33 个请求）之后实测 2.4 秒 ——
   *   慢了 0.2 秒，换来的是单轮突发小掉三分之二，而且用户中途滚一下、
   *   或者点了别的地方，下一块就立刻让位，不会闷头把整篇翻完。
   * ------------------------------------------------------------------ */
  var WHOLE_CHUNK = 600;

  /**
   * @param opts.root   只翻这个容器里的（默认整页 #view）
   * @param opts.whole  整篇模式：一次收整篇，分块推进
   * @param opts.items  直接用这份清单开翻，不再 collect（整篇推进下一块时用）
   */
  function translatePage(silent, tried, opts) {
    tried = tried || [];
    opts = opts || {};
    if (state.busy) { if (!silent) toast('正在翻译，稍等一下'); return Promise.resolve(); }
    invalidateCollect();                     // 真要开翻了：丢掉「只是问问」留下的旧答案
    /* 直接给了清单就别再扫一遍 DOM。
     * 整篇推进时每块都重新 collect 一次是笔昂贵的账：collect 要遍历整篇
     * （system-design-primer 是 2704 个元素）并且对每个父元素
     * getBoundingClientRect —— 在真机 WebView 上那是**强制排版**，
     * 一篇长文分 3 块就是 3 次全篇强制排版，全都落在主线程上。
     * 上一块已经把清单排好序了，剩下的直接切下来接着翻就行。 */
    var nodes = opts.items ||
      collect(opts.root || root(), true, opts.whole ? Infinity : undefined);
    /* 整篇模式：这一轮只翻前 WHOLE_CHUNK 段，剩下的留给下一块。
     * collect 已经按「离视口中心多远」排好序，所以切掉的是最远的那部分。 */
    var mine = opts.whole ? nodes.slice(0, WHOLE_CHUNK) : nodes;
    if (!mine.length) { if (!silent) toast('这一页没有需要翻译的英文'); return Promise.resolve(); }

    var mySeq = ++state.seq;
    var t0 = Date.now();
    state.busy = true;
    state.okCount = 0;              // 实际写出译文的段数，用来判断引擎是不是整体不可用
    state.lastErr = '';             // 首个批次错误（HTTP 403/超时之类），提示里带上便于自查
    setBusy(true);
    if (!silent) toast('正在翻译 ' + mine.length + ' 段…');
    /* 记一笔「开始翻译」到错误日志：真出问题时，
     * 前面有这一行才好还原「用户当时点了什么、翻多少段」。 */
    try {
      if (window.API && window.API.logNote) {
        window.API.logNote('开始翻译本页（' + mine.length + ' 段）');
      }
    } catch (e) {}
    /* 顺手在后台探一遍「还没验证过」的海外 / 设备端引擎。
     * 刻意不 await：探的是**下一页**能不能用上它们，这一页照旧用已经验证过的
     * 那几家，一毫秒都不多等。探通了记下来（30 分钟有效），下页自动进池。 */
    checkReach();
    /* 看门狗：手动选中一个会挂起的引擎时（个别 WebView 的系统翻译就是这样），
     * 兜底把 busy 释放掉，别让整个翻译功能陪葬 —— 卡死过一次要重启 App 才能救。 */
    var watchdog = setTimeout(function () {
      if (mySeq !== state.seq || !state.busy) return;
      state.busy = false; setBusy(false);
      toast('翻译卡住了，当前引擎可能不可用，建议长按图标换回自动选择');
    }, prefGet('gh_tr_busy_timeout', 45000) | 0 || 45000);

    var engName = '';   // 引擎名存到外层：完成提示在外层 then 里，直接写 name
                        // 会命中全局 window.name（空字符串），提示就变成「」了
    return Promise.resolve(planPool(tried)).then(function (plan) {
      if (!plan || !plan.wheel.length) throw new Error('所有引擎都不可用');
      engName = plan.primary;
      state.engine = plan.primary;
      /* 多引擎一起上的时候，组按通用上限切（40 段 / 5000 字符），
       * 各引擎接到手之后按自己的单次上限再切一刀（百度 6000 字节、
       * 有道平台 5000 字节、有道匿名 900 字节都有各自的切法）。
       * 只有一个引擎时用它自己的上限，少一次无谓的二次切分。 */
      var solo = plan.wheel.length === 1;
      var mxItems, mxChars;
      if (solo) {
        var e0 = ENGINES[plan.primary];
        mxItems = e0.maxItems; mxChars = e0.maxChars;
      } else {
        mxItems = MAX_ITEMS; mxChars = MAX_CHARS;
      }
      // collect 已经筛过、也按「离视口中心多远」排好序了，这里全部组直接翻，
      // 不再有「首屏 + 后台整页」之分——后台整页翻是有道限流的元凶，
      // 而且用户滚过去时经常看到的还是没翻的英文。
      // 唯一的区别是整篇模式一次收得多（WHOLE_CHUNK 段），组自然也多。
      /* 组并发：多引擎时把各家的并发加起来（上限 10），
       * 因为每条车道有自己的节流（有道的名额池、百度的串行锁），
       * 加总不会把任何一家压过头 —— 压不动的，被各自的闸门挡着。 */
      var par = 0;
      plan.list.forEach(function (k) {
        par += (ENGINES[k] && ENGINES[k].parallel) || BATCH_PARALLEL;
      });
      par = Math.max(BATCH_PARALLEL, Math.min(10, par));
      /* 「当前这一组在用哪个引擎」。必须显式声明成 var：
       * 直接用一个叫 name 的自由变量会命中 window.name（空字符串），
       * 缓存 key 就全变成 '|zh-Hans|xxx' 了 —— 以前踩过一次。 */
      var name = plan.primary;
      var groups = batch(mine, mxItems, mxChars);

      /* 换页中止开关：这一轮属于 mySeq，页面一换（seq 变了）就为真。
       * 引擎的每个请求/每个 chunk 之前都会问它一次，为真就收手。 */
      var staled = function () { return mySeq !== state.seq; };

      function runGroup(g, gi) {
        if (staled()) return Promise.resolve();
        /* 这一组的目标节点整批已经不在文档里了（搜索换词 / 列表翻页把这块
         * 内容换掉了）：连下面那一次 !miss.length 都不必算，直接撒手。
         * 以前照跑不误 —— 白搭一次网络、白占一个有道名额，撞限流时还会
         * 连累真正在翻的那一组。 */
        if (!g.items.some(function (it) { return document.contains(it.node); })) {
          return Promise.resolve();
        }
        // 先查缓存，命中的不用发请求。
        // 命中值与原文相同 = 旧版 bug 留下的坏缓存（失败兜底时写进去的），
        // 当 miss 处理重新翻 —— 已污染的缓存能自愈。
        var texts = g.items.map(function (it) { return it.text; });
        var results = new Array(texts.length);
        var miss = [];
        texts.forEach(function (t, k) {
          /* 缓存 key 里带上目标语言：同一段英文翻成中文和翻成英文是两个结果，
           * 不带上 TO 的话切语言之后会命中另一种语言的旧译文。
           * 老 key（没有 TO 段）自然失效、逐步被淘汰，不影响正确性。
           *
           * 多个引擎协作时再补查一次「共享」缓存（'*' 那把 key）：
           * 同一段被百度翻过之后，下一轮轮到有道时不必再翻一遍 ——
           * 不同引擎的译文都写在共享 key 上，谁都能接着用。 */
          var c = cacheGet(name + '|' + TO + '|' + hash(t)) ||
                  cacheGet('*|' + TO + '|' + hash(t));
          if (c && c !== t) results[k] = c; else miss.push(k);
        });
        if (!miss.length) { apply(g.items, results, name); return Promise.resolve(); }
        var payload = miss.map(function (k) { return texts[k]; });

        /** 把一段译文写进结果、进缓存，并返回「这一项对应的节点」用于上屏 */
        function commit(j, v) {
          var src = payload[j];
          var s = norm(v);
          /* 只有真译文才上屏、才进缓存。失败兜底回来的原文绝不能缓存——
           * 缓存住原文 = 这段永远不会再翻，页面从此钉死在英文。 */
          /* 注意：这里**不能**顺手记「这段翻不出来」。
           * 走到这儿有两种可能：引擎好好回了但译文等于原文（真的没得翻），
           * 或者请求根本没成功、兜底把原文填了回来（限流 / 拆到放弃）。
           * 两者在 commit 里长得一模一样，在这里记账会把**被限流的段**
           * 误判成「翻不出来」，于是整轮都不再重试 —— 那才是真的翻不出来了。
           * 记账只放在引擎明确收到成功响应的那一支（见 youdaoChunk）。 */
          if (!s || s === src) return null;
          var k = miss[j];
          results[k] = s;
          /* 写共享 key：本轮换引擎接力时，别人译过的段不用重复请求。 */
          cacheSet('*|' + TO + '|' + hash(src), s);
          return g.items[k];
        }

        /* 待翻的下标（payload 的下标 j）。接力时只把**还没译出来**的那些
         * 交给下一个引擎 —— 已经上屏的字不发第二遍，也就不存在「换引擎
         * 把译文抹掉又重写一遍」的闪动。 */
        var pending = payload.map(function (_, j) { return j; });

        /** 流式上屏：引擎每译出一部分就先写进对应节点，不用等整批结束。
         * 之前 40 段一组要跑完 5 个往返才一次性上屏，用户盯着的空白时间
         * = 整组耗时；现在第一个 chunk 回来就有字，后面的陆续补上。 */
        function onPartialWrap(pend) {
          return function (start, arr) {
            if (staled()) return;
            var items = [], out = [];
            for (var i2 = 0; i2 < arr.length; i2++) {
              var j = pend[start + i2];
              if (j === undefined) continue;
              var it = commit(j, arr[i2]);
              if (it) { items.push(it); out.push(norm(arr[i2])); }
            }
            if (items.length) apply(items, out, name);
          };
        }

        /** 交给某一个引擎翻这一组，返回实际译出的段数（0 = 一个都没翻出来）。
         *  计数用「这一组新写进 results 的条数」，所以接力时不会重复计。 */
        function runOn(engineName) {
          var engine = ENGINES[engineName];
          if (!engine) return Promise.resolve(0);
          var pend = pending.slice();
          if (!pend.length) return Promise.resolve(0);
          var sub = pend.map(function (j) { return payload[j]; });
          var before = 0;
          results.forEach(function (v) { if (v) before++; });
          name = engineName;                       // 缓存 / 上屏都跟着当前引擎走
          var subOpts = { abort: staled, onPartial: onPartialWrap(pend) };
          var pr = translateBatch(engine, sub, 0, subOpts);
          /* 专属闸门（见 SLOW_TIMEOUT 的注释）：海外 / 设备端这类
           * 「要么秒回、要么根本连不上」的引擎，3 秒没结果就判失败 ——
           * 让下面的接力链立刻接管，而不是把整页钉在 15 秒的连接超时上。
           * 已经流式上屏的那几段不受影响（它们在 results 里），
           * 所以闸门落下时不会把翻出来的字又收回去。 */
          if (engine.timeoutMs) {
            pr = Promise.race([pr, new Promise(function (_, rej) {
              setTimeout(function () {
                rej(new Error('引擎无响应（' + (engine.label || engineName) + '）'));
              }, engine.timeoutMs);
            })]);
          }
          return pr.then(function (out) {
            if (staled()) return -1;
            out.forEach(function (v, i2) { commit(pend[i2], v); });
            // 兜底：把流式没覆盖到的（例如不支持 onPartial 的引擎）统一上屏。
            // apply 内部会跳过已经翻过的节点，不会重复计数。
            apply(g.items, results, engineName);
            var after = 0;
            results.forEach(function (v) { if (v) after++; });
            return after - before;
          }, function (err) {
            console.warn('[translate] 批次失败', err);
            if (!state.lastErr && err) state.lastErr = err.message || String(err);
            apply(g.items, results, engineName);
            var after = 0;
            results.forEach(function (v) { if (v) after++; });
            return after - before;
          });
        }

        /* ===== 接力：这一组交给转轮里该管它的引擎，翻不出来就换下一个 =====
         * 匿名引擎被限流时常常只译出一半，那一半留在页面上不动，
         * 剩下的交给下一个引擎补 —— 这才有「互相配合」的样子：
         * 不是谁替谁重翻一遍，而是各家把自己能翻的那部分补上。 */
        var used = [];
        function attempt(engineName) {
          if (!engineName || staled()) return Promise.resolve();
          var handing = pending.length;
          return runOn(engineName).then(function (got) {
            if (got === -1) return;                  // 换页了
            poolResult(engineName, got, handing);
            pending = pending.filter(function (j) { return !results[miss[j]]; });
            if (!pending.length || staled()) return;
            used.push(engineName);
            var next = pickFor(gi, used);
            if (next) return attempt(next);
          });
        }
        /* 首屏竞速：这一组同时交给两家，谁先回来谁占坑（详见 RACE_GROUPS 的注释）。
         * 只在池里真有第二家时才开 —— 只剩一家可用时竞速没有意义，只会白搭一倍请求。
         *
         * 这里刻意不走 attempt：attempt 的语义是「这家翻不出来才换下一家接力」，
         * 而竞速是两家一起上，走接力会把 pending 算乱（两家会互相把对方
         * 已译出的段当成「还没翻」再发一遍）。
         * runOn 内部对 pending 做了 .slice() 快照，所以两份请求各自是全量，
         * 互不干扰；上屏由 apply 的 __tr_done 兜底，先到的占坑、后到的跳过。 */
        if (gi < RACE_GROUPS) {
          var ra = pickFor(gi, []);
          var rb = pickFor(gi, [ra]);
          if (rb && rb !== ra) {
            return Promise.all([runOn(ra), runOn(rb)]).then(function (rs) {
              /* 只给译出更多的那一家记账：两家都记会把协作池的权重算成两倍。
               * -1 = 换页了，不记账。 */
              var gotA = rs[0] || 0, gotB = rs[1] || 0;
              var got = Math.max(gotA, gotB);
              if (got > 0) poolResult(gotA >= gotB ? ra : rb, got, payload.length);
            });
          }
        }
        return attempt(pickFor(gi, used));
      }

      return mapLimit(groups, par, runGroup);
    }).then(function () {
      if (mySeq !== state.seq) return Promise.resolve();
      clearTimeout(watchdog);
      state.busy = false; setBusy(false);
      state.ms = Date.now() - t0;
      /* 整篇模式这一块翻完了，剩下的接着推。
       * 为什么要自己接，而不是等 retryLoop：retryLoop 问的是
       * peekCollect()（视口 ±600px），它永远看不到远处的段，
       * 靠它补漏，整篇永远翻不完。
       * 停下来的条件：这块没翻动（引擎全挂了，再推也是白推）、
       * 或者用户已经换页了。 */
      if (opts.whole && mine.length >= WHOLE_CHUNK && state.okCount &&
          nodes.length > mine.length) {
        var rest = nodes.slice(WHOLE_CHUNK);
        setTimeout(function () {
          if (mySeq !== state.seq) return;                  // 换页了：收工
          if (!prefGet(KEY_AUTO, false)) return;            // 关了：收工
          if (state.busy) return;                           // 有别的轮在跑：让位
          translatePage(true, [], { root: opts.root, whole: true, items: rest });
        }, 30);
      }
      if (state.okCount) {
        clearBad(engName);                    // 这轮成功：摘掉「临时不可用」帽子
        state.done = true;
        if (prefGet(KEY_AUTO, false)) {
          catchUp(1);                         // 异步加载出来的内容再捞一遍
          retryLoop(mySeq, 0);                // 有没翻出来的段（限流兜底）就进重试循环
        } else if (mySeq === state.seq) {
          /* 手动点翻译（总开关关着）时 retryLoop 不会跑，可这一轮照样可能
           * 剩下一批没翻出来的段 —— 引擎被限流兜底成原文就是这种。
           * 用户亲手点的那一次，看到半页英文是最糟的体验，所以这里自己补两轮：
           * 没翻的段会命中缓存/共享缓存，补翻成本很低。 */
          var round = opts.mop || 0;
          if (round < MOP_DELAYS.length) {
            setTimeout(function () {
              if (mySeq !== state.seq) return;      // 换页了：收工
              if (state.busy) return;               // 有别的轮在跑：让位
              if (!peekCollect().length) return;    // 都翻出来了
              /* 补翻必须先把池子的旧账清零：上一轮被判死的引擎（多半是撞了
               * 限流的匿名有道）在这时候往往已经缓过来了，不清零的话补翻
               * 只能落在同样一堆「已判死」的引擎上，等于原地打转。 */
              resetPool();
              translatePage(true, [], { mop: round + 1 });
            }, MOP_DELAYS[round]);
          }
        }
        // 只有用户亲手点的那次才弹完成提示；自动补翻（换页、列表刷新带出来的
        // 新内容）静默完成——探索页每隔一会儿自己刷新一次时间戳，不静默的话
        // 「已翻译 58 段」会一遍遍往外蹦。
        if (!silent) {
          var how = state.ms < 100 ? '缓存秒出' : (state.ms / 1000).toFixed(1) + ' 秒';
          toast('已翻译 ' + state.okCount + ' 段 · ' + how + ' · ' +
            (SHORT[engName] || engName || '缓存'));
        }
        return Promise.resolve();
      }
      /* ===== 一段都没翻成：自动降级，别把用户晾在英文页上 =====
       * 记住这个引擎挂了（2 分钟内自动选择跳过它，原来是 5 分钟——太长，
       * 网络抖一下就把所有引擎挨个标成「不可用」，用户只能干等），然后按
       * ORDER 换下一个还没试过的引擎接着翻本轮。全试完才认输。 */
      markBad(engName, 2 * 60 * 1000);
      var triedNow = tried.concat([engName]);
      var candidates = ORDER.filter(function (k) {
        return triedNow.indexOf(k) < 0 && isReady(k) && !isBadNow(k);
      });
      if (!candidates.length) {
        /* 全军覆没：有可能是刚才那一阵网络抖动把几个引擎接连标成了 bad。
         * 别直接认输——把所有 badUntil / probeFailUntil 清掉，给它们一次
         * 「重新做人」的机会，再探一轮。只有这一轮也全挂才真认输。
         * 这是「经常性提示所有引擎都不可用」的主要修复点。 */
        if (!translatePage._retriedAll) {
          translatePage._retriedAll = true;
          badUntil = {};
          probeFailUntil = {};
          resetPool();
          if (!silent) toast('引擎暂时不可用，重新探测中…');
          probing = null;
          probeCoolUntil = 0;
          return translatePage(silent, []);
        }
        translatePage._retriedAll = false;
        if (!silent) toast('所有翻译引擎都不可用，已保持原文（可长按图标换引擎或稍后再试）');
        /* 全军覆没也要排队重试：真机上常见的是「抖一下」——弱网、限流、
         * 系统刚唤醒。用户滑到这里看到的是英文，不重试他就得手动再滑一次
         * 才可能翻出来。等 4 秒再试，最多 3 轮，试不出来就收工。 */
        if (prefGet(KEY_AUTO, false)) retryLoop(mySeq, 1);
        return Promise.resolve();
      }
      translatePage._retriedAll = false;
      if (!silent) toast('「' + (SHORT[engName] || engName) + '」不可用' +
        (state.lastErr ? '（' + state.lastErr + '）' : '') + '，自动换用其他引擎…');
      return translatePage(true, triedNow).then(function () {
        // 降级成功且是用户亲手点的这轮：提一句谁接了班
        if (!silent && state.okCount && state.engine !== triedNow[0]) {
          toast('已改用「' + (SHORT[state.engine] || state.engine) + '」翻译');
        }
      });
    }).catch(function (e) {
      if (mySeq !== state.seq) return Promise.resolve();
      clearTimeout(watchdog);
      state.busy = false; setBusy(false);
      if (!silent) toast('翻译失败：' + (e && e.message ? e.message : e));
      else if (typeof console !== 'undefined') console.log('[translate] 翻译失败', e && e.message);
      // 异常退出同样排队重试（理由同上：抖一下不该让页面停在英文）
      if (prefGet(KEY_AUTO, false)) retryLoop(mySeq, 1);
      return Promise.resolve();
    });
  }

  /**
   * 失败段重试循环：翻译完成后页面上还有没翻出来的英文段（限流/抖动/懒加载
   * 晚到），隔一会儿再捞一轮（探索页会持续加载新条目，几轮常常不够用——
   * 表现就是列表后半截停在英文）。collect 只收没翻的段，翻成功的命中缓存，
   * 不会重复请求；换页（seq 变）或关掉总开关就停。
   *
   * 间隔原来是固定 4 秒 × 5 轮：一个「抖一下」的失败也要等满 4 秒才补，
   * 5 轮就是 20 秒，用户早就划走了。改成指数退避 —— 第一轮 1.2 秒（抖一下
   * 的情况基本就靠它补上），往后逐步拉长到 12 秒（真限流才需要等那么久），
   * 总时长差不多，但「看得到的变化」来得更早。
   */
  var RETRY_DELAYS = [1200, 2500, 5000, 8000, 12000];
  /* 手动点翻译时的补翻节奏：第一轮很快就到（多数情况只是抖了一下），
   * 往后拉长到 4 秒 —— 有道合闸最长 10 秒，太快来第二轮还是撞墙。 */
  var MOP_DELAYS = [400, 1500, 4000];
  function retryLoop(mySeq, round) {
    if (round >= RETRY_DELAYS.length) return;
    setTimeout(function () {
      if (mySeq !== state.seq) return;                     // 换页了
      if (!prefGet(KEY_AUTO, false)) return;               // 关了
      if (state.busy) { retryLoop(mySeq, round); return; } // 还在翻：等它
      if (!peekCollect().length) return;                   // 没有剩余段了，收工
      resetPool();                                         // 同上：新的一轮，旧账清零
      translatePage(true).then(function () {
        retryLoop(mySeq, round + 1);
      });
    }, RETRY_DELAYS[round]);
  }

  function apply(group, results, engineName) {
    group.forEach(function (it, i) {
      var t = results[i];
      if (!t || !t.trim() || t === it.text) return;
      var n = it.node;
      /* 已经翻过的节点直接跳过：流式上屏会先写一遍，整批收尾再写一遍，
       * 不挡住就会把 okCount 数成两倍、state.nodes 里塞进重复节点。 */
      if (n.__tr_done) return;
      /* 这一轮排队的路上内容被换掉了（搜索改词、列表翻页）：写它也白写，
       * 还会把废节点的引用继续挂在 state.nodes 上。
       * 以前这里照写不误 —— 一次重建就是几十个游离节点，
       * 翻个几十次就是几千个 Text 节点被 JS 攥着没法回收。 */
      if (!document.contains(n)) return;
      if (n.__tr_orig === undefined) n.__tr_orig = n.nodeValue;
      n.nodeValue = t;
      n.__tr_done = true;
      state.nodes.push(n);
      state.okCount = (state.okCount || 0) + 1;
    });
  }

  /**
   * 把 state.nodes 里「已经不在文档里」的清掉。
   *
   * 页面里那些绕开路由的局部重建（搜索结果换词、翻页、切页签）会把整块
   * 子节点一次性换掉，而这些子节点的引用还留在 state.nodes 里：
   * 既没法还原（已经不在文档里了），也没法被 GC（被数组引用着）。
   * 一次重建就是几十上百个，翻几十次就是几千个游离的 Text 节点。
   */
  function dropDeadNodes() {
    if (!state.nodes.length) return;
    var keep = [], dropped = 0;
    for (var i = 0; i < state.nodes.length; i++) {
      var n = state.nodes[i];
      if (!n) continue;
      if (document.contains(n)) { keep.push(n); continue; }
      /* 连标记一起摘掉：节点本身随时会被 GC，标记跟着它走，
       * 留着只会让「看起来还在做的事」变多。 */
      delete n.__tr_done;
      delete n.__tr_orig;
      dropped++;
    }
    if (dropped) state.nodes = keep;
  }

  /**
   * 把「译过的段」用本地缓存同步还原出来 —— 不发请求、不等任何计时器。
   *
   * 列表被原地重建之后（搜索翻页、切页签、恢复缓存），上一屏的中文其实早就
   * 躺在缓存里，但在原来的流程里它要等到 MutationObserver 兜底那一拍才被
   * 重新发现、重新查缓存、重新写节点 —— 实测这段纯等待能到 3 秒，
   * 而真正的写入只花十几毫秒。这里先把它一次性写回去，之后常规流程
   * 只需要照顾真正的新段。
   */
  function applyCache(host) {
    if (!host || currentEngine() === '') return 0;
    var name = currentEngine();
    var got = 0;
    var eng = ENGINES[name];
    if (!eng) return 0;
    var wk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null, false);
    var n, toWrite = [];
    while ((n = wk.nextNode())) {
      if (n.__tr_done) continue;
      var raw = n.nodeValue;
      if (!raw || !raw.trim()) continue;
      if (inSkip(n)) continue;
      var s = norm(raw);
      if (!needTranslate(s)) continue;
      var c = cacheGet(name + '|' + TO + '|' + hash(s));
      if (!c || c === s) continue;
      toWrite.push({ node: n, text: s, out: c });
    }
    toWrite.forEach(function (it) {
      var n2 = it.node;
      if (n2.__tr_orig === undefined) n2.__tr_orig = n2.nodeValue;
      n2.nodeValue = it.out;
      n2.__tr_done = true;
      state.nodes.push(n2);
      got++;
    });
    if (got) { state.okCount = (state.okCount || 0) + got; }
    return got;
  }

  function restorePage(silently) {
    state.seq++;                      // 作废进行中的批次
    state.busy = false;
    setBusy(false);
    var n = 0;
    state.nodes.forEach(function (node) {
      if (node.__tr_orig !== undefined) {
        node.nodeValue = node.__tr_orig;
        delete node.__tr_orig;
        n++;
      }
      delete node.__tr_done;
    });
    state.nodes = [];
    state.done = false;
    // 切目标语言时内部会先还原一次，那是流程的一部分，不该弹「已还原原文」
    if (n && !silently) toast('已还原原文');
  }

  /**
   * 按钮是「总开关」，不是「翻这一页」。
   *   开着：当前页翻，换页后新页面也接着翻，直到你关掉它
   *   关掉：当前页还原，之后换页不再翻
   * 图标亮着就表示开关开着。
   */
  function toggle() {
    if (prefGet(KEY_AUTO, false)) {
      // 关闭不等翻译结束：restorePage 会作废进行中的批次并释放 busy。
      // 翻译途中也能点 —— 按钮在 busy 时不再屏蔽点击（见 translate.css），
      // 否则想叫停只能干等，就是那个「暂停不了」的问题。
      var wasBusy = state.busy;
      prefSet(KEY_AUTO, false);
      restorePage();
      setOn(false);
      toast(wasBusy ? '已停止翻译，已翻的内容已还原' : '翻译已关闭');
    } else {
      if (state.busy) { toast('正在翻译，稍等一下'); return; }
      prefSet(KEY_AUTO, true);
      setOn(true);
      translatePage();
    }
  }

  /* ================= 界面 ================= */
  var btn = null;

  function setBusy(on) {
    if (btn) btn.classList.toggle('busy', !!on);
  }

  /** 按钮外观只跟总开关走：亮 = 开着，跟某一页翻没翻过无关 */
  function setOn(on) {
    if (!btn) return;
    btn.classList.toggle('on', !!on);
    btn.innerHTML = icon('globe', 20);
    btn.setAttribute('aria-label', on ? '关闭翻译' : '开启翻译');
    btn.title = on ? '翻译已开启（点一下关闭）' : '开启翻译';
  }

  function mount() {
    var box = document.getElementById('appbar-actions');
    if (box) {
      if (btn && btn.parentNode === box) return;
      btn = document.createElement('button');
      btn.id = 'tr-btn';
      btn.className = 'icon-btn tr-btn';
      box.appendChild(btn);
    } else if (!btn) {
      btn = document.createElement('button');
      btn.id = 'tr-fab';
      btn.className = 'tr-btn tr-fab';
      document.body.appendChild(btn);
    }
    setOn(prefGet(KEY_AUTO, false));
    bind(btn);
    watchScroll();
  }

  /* 滚动即翻：滚到哪里，翻到哪里。
   * 用户滚动列表/文章时，视野附近（±600px）出现新的英文段就立刻补翻，
   * 防抖 250ms 避免滚动过程里连环触发。
   * 两个关键点（都是真机上「滚到一半不翻了」的元凶）：
   * 1. scroll 事件**不冒泡**——挂 window 上只能收到根滚动，App 列表要是在
   *    内部滚动容器里滚，事件根本到不了。用 document 捕获阶段监听，
   *    页面里任何一个容器滚动都逃不掉。
   * 2. 上一轮还没翻完时不能直接放弃：探索页一屏几十段，上一轮要跑一两秒，
   *    用户先滚一段停下（触发一轮）再往下滚，第二轮正好撞上 busy——
   *    放弃的话这段就永远停在英文（截图里 21~24 号没翻就是这个）。
   *    busy 时排队等它，翻完立刻补。 */
  function watchScroll() {
    if (watchScroll._done) return;
    watchScroll._done = true;
    var t = 0;
    var kick = function () {
      if (!prefGet(KEY_AUTO, false)) return;      // 开关关了：不翻也不空转
      if (state.busy) { t = setTimeout(kick, 900); return; }   // 等上一轮，别放弃
      if (peekCollect().length) translatePage(true);           // 滚动触发
    };
    document.addEventListener('scroll', function () {
      /* 滚过了，每个元素的位置都变了 —— 而「还有没有新段要翻」那个
       * 250ms 缓存答案是按**滚动前**的位置算出来的。拿它来问「这一轮
       * 要不要开翻」，会答成「没有」，整轮就这么被跳过去了：
       * 用户明明滚出了新的英文，却要等下一次轮询才有人理。
       * 位置一变，答案就必须作废。 */
      invalidateCollect();
      clearTimeout(t);
      t = setTimeout(kick, 250);
    }, { capture: true, passive: true });
  }

  /** App 每次换页都会重建右上角按钮区，用观察器自动补挂 */
  function watchAppbar() {
    var box = document.getElementById('appbar-actions');
    if (!box || !window.MutationObserver) return;
    var mo = new MutationObserver(function () {
      if (!document.getElementById('tr-btn')) {
        btn = null;
        mount();
      }
    });
    mo.observe(box, { childList: true });
  }

  function bind(el) {
    var timer = null, longPressed = false, moved = false, sx = 0, sy = 0;

    el.addEventListener('click', function (e) {
      e.preventDefault();
      if (longPressed) { longPressed = false; return; }
      if (window.UI && UI.haptic) UI.haptic();
      toggle();
    });

    // 长按 / 右键 → 打开菜单（切换引擎、自动翻译开关、清缓存…）
    el.addEventListener('touchstart', function (e) {
      moved = false;
      sx = (e.touches[0] || {}).clientX || 0;
      sy = (e.touches[0] || {}).clientY || 0;
      timer = setTimeout(function () { longPressed = true; openMenu(); }, 520);
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      var t = e.touches[0] || {};
      if (Math.abs((t.clientX || 0) - sx) > 10 || Math.abs((t.clientY || 0) - sy) > 10) {
        moved = true; clearTimeout(timer);
      }
    }, { passive: true });
    el.addEventListener('touchend', function () { clearTimeout(timer); if (moved) longPressed = false; });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); openMenu(); });
  }

  /* ---------------- 目标语言切换 ---------------- */
  function targetLabel(k) {
    for (var i = 0; i < TARGETS.length; i++) { if (TARGETS[i].key === k) return TARGETS[i]; }
    return TARGETS[0];
  }

  function setTarget(k) {
    k = normalizeTarget(k);
    if (k === TO) return false;
    TO = k;
    resetNoop();          // 换了目标语言，之前「翻不出来」的结论一律作废
    prefSet(KEY_TARGET, k);
    /* 必须先还原再重翻：翻过的节点挂着 __tr_done，collect 会跳过它们，
     * 不还原的话「换了 target 但页面纹丝不动」，像是没生效。 */
    restorePage(true);
    invalidateCollect();
    return true;
  }

  function applyTarget(k) {
    k = normalizeTarget(k);
    var t = targetLabel(k);
    if (!setTarget(k)) { toast('已经在翻译成' + t.short + '了'); return; }
    toast('已切换：翻译成' + t.short);
    setTimeout(function () { translatePage(false); }, 80);   // 让用户立刻看到效果
  }

  function pickTarget() {
    var items = TARGETS.map(function (t) { return { key: t.key, label: t.label, icon: 'globe' }; });
    if (window.UI && UI.choose) {
      UI.choose('翻译成哪种语言', items, TO, function (k) { if (k) applyTarget(k); });
    } else {
      var v = window.prompt ? window.prompt('目标语言：\n1. 简体中文\n2. English') : null;
      if (v) applyTarget(/^\s*(2|en)\s*$/i.test(v) ? 'en' : 'zh-Hans');
    }
  }

  function openMenu() {
    var cur = currentEngine();
    var items = [
      // 放在第一位：彻底消除等待的办法就是让它后台先翻，翻完你正好看到
      { key: 'auto', label: '打开页面时自动翻译', value: prefGet(KEY_AUTO, false) ? '已开启' : '关', icon: 'zap' },
      { key: 'again', label: '重新翻译本页', icon: 'sync',
        value: state.ms ? (state.ms / 1000).toFixed(1) + ' 秒' : '' },
      { key: 'restore', label: '关闭翻译并还原', icon: 'history' },
      '-',
      // 目标语言开关：日/俄/韩/阿等语言也都是翻到这里选的那一种
      { key: 'lang', label: '翻译成', icon: 'globe', value: targetLabel(TO).label },
      // 显示实际在跑哪个引擎：手动选的和实际跑的是同一个时就不要重复念两遍
      { key: 'eng', label: '翻译引擎', icon: 'globe',
        value: cur === 'auto'
          ? '自动' + (state.engine ? ' · ' + (ENGINES[state.engine] ? ENGINES[state.engine].label : state.engine) : '')
          : (ENGINES[cur] ? ENGINES[cur].label : cur) +
            (state.engine && state.engine !== cur
              ? ' · 上次 ' + (ENGINES[state.engine] ? ENGINES[state.engine].label : state.engine)
              : '') },
      { key: 'clear', label: '清空译文缓存', icon: 'trash' },
      { key: 'resetEng', label: '重置引擎状态（清除失败标记）', icon: 'refresh-cw' },
      '-',
      { key: 'about', label: '关于翻译', icon: 'info' }
    ];
    if (window.UI && UI.menu) {
      UI.menu('翻译', items).then(function (k) { if (k) onMenu(k); });
    } else {
      // Demo（没有 UI 组件）里的极简兜底
      var map = items.filter(function (x) { return x.key; }).map(function (x, i) { return (i + 1) + '. ' + x.label; });
      var v = prompt(map.join('\n'));
      if (v) onMenu(items[+v - 1] ? items[+v - 1].key : null);
    }
  }

  function onMenu(k) {
    if (k === 'again') { restorePage(); setTimeout(translatePage, 60); }
    else if (k === 'restore') { if (prefGet(KEY_AUTO, false)) toggle(); else restorePage(); }
    else if (k === 'lang') pickTarget();
    else if (k === 'eng') pickEngine();
    else if (k === 'auto') {
      prefSet(KEY_AUTO, !prefGet(KEY_AUTO, false));
      toast(prefGet(KEY_AUTO, false) ? '已开启：进页面自动翻译' : '已关闭自动翻译');
    } else if (k === 'clear') {
      cache = {}; prefSet(KEY_CACHE, cache);
      toast('译文缓存已清空');
    } else if (k === 'resetEng') {
      /* 手动重置所有引擎状态：清掉 badUntil、探测黑名单、准入缓存。
       * 网络从不可用恢复、或者之前填错过密钥导致引擎被标坏时，
       * 用户可以靠这个按钮立刻让所有引擎重新参与，而不是等几分钟。 */
      badUntil = {};
      probeFailUntil = {};
      try { prefSet(REACH_KEY, {}); } catch (e) {}
      resetPool();
      probing = null;
      probeCoolUntil = 0;
      toast('已重置所有引擎状态，马上重新翻译');
      if (collect(root()).length) setTimeout(translatePage, 60);
    } else if (k === 'about') about();
  }

  /** 切引擎后立刻用新引擎把当前页重翻一遍 —— 不然页面纹丝不动，
   *  用户根本不知道换没换上，也不知道新引擎到底通不通。
   *  注意别只看 state.nodes：看门狗从挂起引擎里救回来时 nodes 是空的，
   *  但页面上躺着一屏英文，同样需要翻。 */
  function applyEngine(k, tip) {
    prefSet(KEY_ENGINE, k);
    resetNoop();          // 换了引擎，之前「翻不出来」的结论一律作废
    toast(tip);
    if (!prefGet(KEY_AUTO, false)) return;
    if (state.nodes.length || state.done || state.busy) restorePage();
    if (collect(root()).length) translatePage(false);   // 用户主动换引擎，给完整反馈
  }

  /* 需要填凭据的三家：填了才进池子，没填就在列表里显示为「去填写」 */
  var KEYED = [
    { key: 'youdaoOpen', title: '有道翻译开放平台',
      fields: [{ k: KEY_YD_APPKEY, label: 'appKey（应用ID）' },
               { k: KEY_YD_SECRET, label: 'appSecret（应用密钥）' }],
      desc: '控制台 ai.youdao.com/console 的「我的应用」里创建应用可得（引擎列表里' +
            '长按本条可直达）。单次 5000 字节，国内直连，注册即送体验金 —— 填了它就是主力。' },
    { key: 'baidu', title: '百度翻译开放平台',
      fields: [{ k: KEY_BAIDU_APPID, label: 'APP ID' },
               { k: KEY_BAIDU_KEY, label: '密钥（Secret Key）' }],
      desc: '控制台 fanyi-api.baidu.com「开发者信息」里可查（引擎列表里长按本条可直达）。' +
            '单次 6000 字节（匿名接口的 6 倍），标准版 QPS=1，所以它是串行跑的 —— 一发顶六发。' },
    { key: 'niutrans', title: '小牛翻译',
      fields: [{ k: KEY_NIU_KEY, label: 'apikey' }],
      desc: '控制台 niutrans.com/cloud/console 的「个人中心」可查 apikey（引擎列表里' +
            '长按本条可直达）。不用签名，接起来最省事，额度不如上面两家，作为第三路分流。' }
  ];

  /* 三家密钥引擎的注册 / 管理页：在引擎列表里长按对应条目，用系统浏览器
   * 直接跳过去 —— 注册账号、领免费额度、查用量，都是同一个入口。
   * 地址都探测过：未登录时会自己落到登录 / 注册页，登录后就是密钥所在的控制台。 */
  var REG_URLS = {
    youdaoOpen: 'https://ai.youdao.com/console/',
    baidu: 'https://fanyi-api.baidu.com/api/trans/product/desktop',
    niutrans: 'https://niutrans.com/cloud/console'
  };

  /** 跳系统浏览器打开注册页。特意不走应用内 WebView：注册要登录第三方账号、
   *  可能还要收短信验证码，用户自己的浏览器里存着账号密码，顺手得多。 */
  function openRegPage(k) {
    var url = REG_URLS[k];
    if (!url) return false;
    if (window.NativeBridge && typeof window.NativeBridge.openExternal === 'function') {
      try { window.NativeBridge.openExternal(url); return true; } catch (e) {}
    }
    try { window.open(url, '_blank'); return true; } catch (e) {}
    return false;
  }

  /** 填写某个引擎的凭据：一个字段一个 prompt，全填完立刻重翻本页 */
  function configKeys(cfg, done) {
    var i = 0;
    function next() {
      if (i >= cfg.fields.length) {
        resetPool();
        toast(cfg.title + '已配置，马上重翻本页');
        if (done) done();
        return;
      }
      var f = cfg.fields[i++];
      var old = prefGet(f.k, '');
      if (window.UI && UI.prompt) {
        UI.prompt(cfg.title + ' · ' + f.label, {
          desc: cfg.desc, value: old, placeholder: '填写' + f.label
        }).then(function (v) {
          if (v === null || v === undefined) return;   // 取消：不再追问后面的字段
          prefSet(f.k, String(v).trim());
          next();
        });
      } else {
        var v2 = window.prompt ? window.prompt(f.label, old) : null;
        if (v2 === null) return;
        prefSet(f.k, String(v2).trim());
        next();
      }
    }
    next();
  }

  function pickEngine() {
    var items = [{ key: 'auto', label: '自动选择（多个引擎协作，推荐）', icon: 'zap' }];
    /* custom 已经在 ORDER 里了，这里不再单独 push 一次（以前会显示两遍） */
    ORDER.forEach(function (k) {
      if (!ENGINES[k]) return;
      var need = hasKey(k) && !isReady(k);
      /* 两个手势在标签里写明白：点是填密钥，长按是去官网拿密钥。
       * 已填过的三家也保留长按入口 —— 查额度、换密钥都是同一个控制台。 */
      var hint = need ? '（点这里填密钥，长按去官网注册）'
        : (REG_URLS[k] ? '（长按可去官网）' : '');
      items.push({ key: k, label: ENGINES[k].label + hint, icon: 'globe' });
    });
    var cur = currentEngine();
    if (window.UI && UI.choose) {
      UI.choose('翻译引擎', items, cur, function (k) {
        if (k === 'custom') {
          var url = prefGet(KEY_CUSTOM, '');
          if (window.UI && UI.prompt) {
            UI.prompt('自定义接口地址', {
              desc: 'POST JSON {"q":["文本"],"to":"' + TO + '"}，返回 {"translations":["译文"]}',
              value: url, placeholder: 'https://你的接口/translate'
            }).then(function (v) {
              if (v) applyEngine('custom', '已保存，马上用新接口重翻本页');
            });
          }
          return;
        }
        /* 点了还没填密钥的引擎：直接把填密钥的框递上去，别让人先吃一个
         * 「引擎不可用」再自己猜去哪儿填。 */
        for (var i = 0; i < KEYED.length; i++) {
          if (KEYED[i].key === k) {
            if (!isReady(k)) {
              configKeys(KEYED[i], function () {
                resetPool();
                applyEngine('auto', '已保存密钥，多个引擎一起上');
              });
            } else {
              /* 已填过密钥：给一个二级菜单，避免「点了就直接切过去、没法改密钥」。
               * 之前填错了密钥的用户只能干瞪眼——因为 isReady 为真，点一下就
               * 切到这个必挂的引擎上，连重填的入口都没有。 */
              manageKeyedEngine(KEYED[i]);
            }
            return;
          }
        }
        /* 设备端翻译：Android WebView 大概率没有 window.Translator，
         * 直接切过去用户只会看到「不可用」，先探一下能不能用。 */
        if (k === 'ondevice') {
          if (!onDeviceReady()) {
            toast('当前设备不支持系统翻译 API（需要 Android 14+ 且已下载语言包），' +
              '可改用自动选择或其他在线引擎');
            return;
          }
        }
        applyEngine(k, k === 'auto' ? '已设为自动选择，马上重翻本页' : '已切换到 ' + ENGINES[k].label + '，马上重翻本页');
      }, function (k) {
        /* 长按：跳系统浏览器去创建 / 查看密钥。弹层留着不关 ——
         * 用户从浏览器拿到密钥回来，还要点一下这条把它填进去。 */
        if (!REG_URLS[k]) return;
        UI.haptic();
        if (openRegPage(k)) {
          toast('已打开' + SHORT[k] + '控制台，拿到密钥后回来点这条填入');
        } else {
          toast('打不开浏览器，请手动访问：' + REG_URLS[k], 5000);
        }
      });
    } else {
      var v = prompt('引擎：auto/youdaoOpen/baidu/niutrans/youdao/ondevice/deepl/google/mymemory/custom');
      if (v) applyEngine(v.trim(), '已切换');
    }
  }

  /** 已填过密钥的引擎：二级菜单 —— 修改 / 清空 / 直接使用。
   *  这是「填错密钥后找不到重置入口」的修复点。 */
  function manageKeyedEngine(cfg) {
    UI.menu(cfg.title, [
      { icon: 'edit', label: '修改密钥', key: 'edit' },
      { icon: 'trash', label: '清空密钥（恢复为未配置）', key: 'clear' },
      '-',
      { icon: 'play', label: '使用此引擎翻译', key: 'use' }
    ]).then(function (k) {
      if (!k) return;
      if (k === 'edit') {
        configKeys(cfg, function () {
          resetPool();
          applyEngine('auto', '已更新密钥，马上重翻本页');
        });
      } else if (k === 'clear') {
        UI.confirm('清空 ' + cfg.title + ' 的密钥',
          '将删除已保存的 appid / 密钥，之后该引擎不再参与自动翻译。' +
          '可以随时重新填入。', '清空').then(function (ok) {
            if (!ok) return;
            cfg.fields.forEach(function (f) { prefSet(f.k, ''); });
            resetPool();
            clearBad(cfg.key);
            toast('已清空 ' + cfg.title + ' 的密钥');
          });
      } else if (k === 'use') {
        applyEngine(cfg.key, '已切换到 ' + cfg.title + '，马上重翻本页');
      }
    });
  }

  function about() {
    var msg = '翻译本页由 translate.js 提供。\n\n' +
      '• 只翻译页面上的英文正文，代码块、路径、commit sha、@提及会自动跳过\n' +
      '• 译文有本地缓存，同样的内容不会重复请求\n' +
      '• 请求不携带你的 GitHub 令牌，但文本会发给所选翻译服务商\n\n' +
      '【多个引擎一起翻】\n' +
      '自动模式下本页会按能力分摊给多个同时可用的引擎：谁单次带得多、额度大，' +
      '谁就多吃几批；某个引擎撞了限流，它名下剩下的批立刻交给下一个，' +
      '不再出现「一个免费口子堵住整页」。\n\n' +
      '【国内直连的免费引擎】\n' +
      '• 有道 / MyMemory：免密钥，开箱即用，但单次只有 900 字节、额度小\n' +
      '• 百度翻译、有道开放平台、小牛翻译：国内机房，注册就送免费额度，' +
      '单次 5000~6000 字节 —— 在「翻译引擎」里点一下填密钥、长按一下用浏览器' +
      '去官网注册（密钥只存在本机）\n' +
      '• DeepL / Google 需要能访问海外网络；微软 Edge 官方已关闭免费接口\n\n' +
      '点按钮翻译 / 还原，长按按钮打开设置。';
    if (window.UI && UI.sheet) {
      UI.sheet({ title: '关于翻译', body: '<div style="font-size:14px;line-height:1.7;white-space:pre-wrap">' +
        String(msg).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) + '</div>' });
    } else alert(msg);
  }

  /* ================= 启动 ================= */
  function resetState() {
    /* seq 自增会把上一页还在飞的批次作废，避免旧译文写到新页面上。
     * 注意「作废」不只是丢结果：translatePage 给每个引擎都传了 abort 回调
     * （见 runGroup），seq 一变，旧链上还没发出的请求就一个都不发了，
     * 有道那条全局节流队列也在这里清零 —— 新页面不必排在旧页面的时间槽后面。 */
    /* 落盘挪到下一个宏任务：整份缓存（上限 600 条）序列化 + 跨桥写入是同步的，
     * 放在跳转这一帧里就是「点进去先顿一下」。丢失风险由 pagehide /
     * visibilitychange 那两个钩子兜着（见 installCacheFlushHooks）。 */
    setTimeout(function () { try { flushCache(); } catch (e) {} }, 0);
    youdaoResetThrottle();
    resetPool();               // 新页面重新分摊：上一页谁挂了不代表这一页也挂
    state.seq++;
    state.nodes = [];
    state.done = false;
    state.busy = false;
    setBusy(false);
  }

  function onRouteChange() {
    resetState();
    if (prefGet(KEY_AUTO, false)) autoTranslate(2);
  }

  /**
   * 自动翻译：刚换页时内容往往还没渲染完（Router.render 是异步的），
   * 所以要等一下再收集；一次没收着就再等一轮，最多三轮。
   * 注意 busy 时是「等」不是「放弃」：真机上引擎慢（有道单条接口），
   * 上一页的后台批次能跑好几秒，换页瞬间大概率还在 busy——
   * 直接放弃的话新页就永远不翻了（真机上报过：换页不翻译）。
   *
   * 首轮等待从 800ms 降到 300ms：800 是「怕内容没渲染完」拍出来的，
   * 但重试轮次本来就在后面接着，晚一点发现新内容并不丢东西，
   * 而快一点能实打实省下用户盯着英文的半秒。后续轮次 500ms 一拍。
   */
  var AUTO_FIRST_DELAY = 300;
  var AUTO_NEXT_DELAY = 500;
  function autoTranslate(tries) {
    var mySeq = state.seq;
    var delay = tries >= 2 ? AUTO_FIRST_DELAY : AUTO_NEXT_DELAY;
    setTimeout(function () {
      if (mySeq !== state.seq) return;                    // 又换页了，本轮作废
      if (!prefGet(KEY_AUTO, false)) return;              // 排队期间被关掉了：别再翻
      if (state.busy) { autoTranslate(tries); return; }   // 上一页还在翻：等它
      if (state.done) return;                             // 这一页已经翻过了
      if (peekCollect().length) translatePage(true);    // 静默：自动模式下不弹提示打扰
      else if (tries > 0) autoTranslate(tries - 1);
    }, delay);
  }

  /**
   * 翻完再回头捞一遍。
   * githup 的页面多是异步渲染的（先骨架屏，数据到了才填内容），第一次翻的时候
   * 后半截往往还没出来。collect 会跳过已翻译的节点，所以重跑只会补翻新增的部分。
   */
  function catchUp(tries) {
    var mySeq = state.seq;
    setTimeout(function () {
      if (mySeq !== state.seq) return;
      if (state.busy) { catchUp(tries); return; }   // 还在翻：等，别放弃
      if (!prefGet(KEY_AUTO, false)) return;
      if (peekCollect().length) translatePage(true);
      else if (tries > 0) catchUp(tries - 1);
    }, 1200);
  }

  /**
   * 这个 App 的换页走 history.pushState —— 它既不触发 hashchange 也不触发
   * popstate（后者只在后退时响）。只监听这两个事件的话，往前跳的每一次换页
   * 都会漏掉：翻译状态不重置、自动翻译也不跑。所以直接把 pushState 包一层。
   */
  function patchHistory() {
    if (!window.history) return;
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== 'function' || orig.__trPatched) return;
      var wrapped = function () {
        var r = orig.apply(history, arguments);
        try { onRouteChange(); } catch (e) {}
        return r;
      };
      wrapped.__trPatched = true;
      history[m] = wrapped;
    });
  }

  /**
   * 局部内容重建的快通道。
   *
   * 页面里有一类刷新**不走路由**：搜索页换关键词、点「加载更多」、切页签，
   * 都是把 #sres 里那一坨东西整体 innerHTML 重建。它们既不调 pushState
   * 也不发 hashchange，于是翻译这边唯一能感知的通道只剩下 watchView 那条
   * MutationObserver 兜底链 —— 而它在最后一次 mutation 之后还要再蹲 900ms。
   *
   * 三段等待是叠着来的：
   *   输入框防抖 900ms → GitHub 搜索往返（真机 1.5~4 秒）→ MutationObserver 900ms
   * 其中最后那 900ms 纯粹是白等。实测 20 条结果、译文全在本地缓存里，
   * 用户还是要等 3.1 秒才看见中文 —— 那 3.1 秒里翻译干的活不到 20ms。
   *
   * 页面那边重建完 DOM 就调一下它，两段白等直接消失：
   *   ① 先用缓存把译过的段同步写回去（搜索翻页时能立刻还原中文）
   *   ② 顺手把上一次重建留下的游离节点引用清掉
   *   ③ 再排一次补翻，只翻真正的新段
   *
   * busy 时是「等」不是「抢」：直接把 seq 加一会让上一轮 promise 永远走不到
   * 释放 busy 的那一步（它的 then 里第一句就是 mySeq !== state.seq 就 return），
   * 那样整个翻译功能就卡死了。
   */
  /**
   * 这是不是「一整篇文档」？
   *
   * 判据是 MD.mount 自己打的那个 .md 类名（README 那个容器还额外有 #readme）。
   * 只有这类容器才走整篇模式：探索页 / 搜索结果那种列表是持续加载的，
   * 而且一屏就几十段，滚动驱动够用，让它们也整篇翻只会白白撞限流。
   */
  function isDoc(host) {
    try {
      if (!host) return false;
      if (host.id === 'readme') return true;
      return !!(host.classList && host.classList.contains('md'));
    } catch (e) { return false; }
  }

  var nudgeTimer = 0;
  function refresh(host) {
    /* 整篇模式只对文档生效，而且只在这一声招呼里打开。
     * 滚动 / 换页那几条链仍然走视口优先 —— 用户正在看的地方必须先变中文。 */
    var whole = isDoc(host);
    try {
      if (host) applyCache(host);
      dropDeadNodes();
      invalidateCollect();
    } catch (e) { /* 一律不许打断页面自己的渲染 */ }
    if (!prefGet(KEY_AUTO, false)) return;
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(function kick() {
      nudgeTimer = 0;
      if (!prefGet(KEY_AUTO, false)) return;
      if (state.busy) { nudgeTimer = setTimeout(kick, 160); return; }  // 等上一轮，别抢
      if (peekCollect(whole).length) translatePage(true, [], { root: host, whole: whole });
    }, 60);
  }

  /** 兜底：万一有别的地方绕过 pushState 直接换了内容，也能跟上 */
  function watchView() {
    var view = document.getElementById('view');
    if (!view || !window.MutationObserver) return;
    var t = 0;
    /* 这一拍原来<｜hy_place▁holder▁no▁813｜> 900ms。它挂在 MutationObserver 后面，而 MutationObserver
     * 本身已经是「一批改动结束后一次性回调」，再压 900ms 纯属白等 ——
     * 一次 innerHTML 通常只产生一条记录，给 260ms 足够让连续几次重排收敛。
     * 搜索页那种「结果早就渲染完了、还在等这一拍」的体感就是这么来的。 */
    var MO_SETTLE = 260;
    var tick = function () {
      // 页面里的东西被换掉了：先把悬空的引用扔掉，省得越攒越多
      dropDeadNodes();
      // 正在翻时等一轮再查（而不是放弃）：列表数据慢到达时经常撞上 busy
      if (state.busy) { t = setTimeout(tick, MO_SETTLE); return; }
      // 已翻译的节点全都不在文档里了，说明整页被换掉了
      var gone = state.nodes.length && !state.nodes.some(function (n) {
        return document.contains(n);
      });
      if (gone) { onRouteChange(); return; }
      // 开关开着时，后加载出来的内容（README、展开的评论）也要补上
      if (prefGet(KEY_AUTO, false) && peekCollect().length) translatePage(true);
    };
    new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(tick, MO_SETTLE);
    }).observe(view, { childList: true, subtree: true });
  }

  function init() {
    installCacheFlushHooks();
    mount();
    watchAppbar();
    /* 这两行是换页继续翻译的命根子，之前忘了装（真机上换页就断）：
     * 真 App 的路由是 history.pushState 的 path 型——hashchange 和 popstate
     * 都不响应，必须把 pushState/replaceState 包一层；watchView 再用
     * MutationObserver 兜住绕过路由直接换 DOM 的情况。 */
    patchHistory();
    watchView();
    window.addEventListener('hashchange', onRouteChange);
    window.addEventListener('popstate', onRouteChange);
    if (prefGet(KEY_AUTO, false)) autoTranslate(2);
    // 供调试 / 控制台调用。
    // 名字必须是 GhTranslator：window.Translator 是新版 Chromium 自带的
    // 设备端翻译 API，占用它会在真机上跟系统打架。
    window.GhTranslator = {
      translate: translatePage,
      restore: restorePage,
      toggle: toggle,
      /* 页面自己重建了一块内容（搜索结果、列表翻页这类不走路由的刷新）
       * 就调它一声 —— 不然翻译只能靠 MutationObserver 那 260ms 兜底，
       * 而这 260ms 是叠在「900ms 防抖 + GitHub 往返」后面的纯白等。 */
      refresh: refresh,
      menu: openMenu,
      engines: ENGINES,
      setEngine: applyEngine,
      _state: function () {
        return { busy: state.busy, seq: state.seq, done: state.done,
                 nodes: state.nodes.length, okCount: state.okCount || 0,
                 engine: state.engine, cur: currentEngine(), target: TO };
      },
      targets: TARGETS,
      setTarget: applyTarget,
      _needTranslate: function (s) { return needTranslate(s); },
      _detectScript: function (s) { return detectScript(s); },
      probe: function () {
        return Promise.all(ORDER.map(function (k) {
          return probe(k).then(function (ok) { return { engine: k, ok: ok, label: ENGINES[k].label }; });
        }));
      }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
