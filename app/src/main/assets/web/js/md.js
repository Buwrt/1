/* ============================================================
 * md.js — Markdown 渲染（GFM），代码高亮、站内链接转换、XSS 过滤
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util;

  // 当前渲染上下文（仓库全名 / 分支 / 文件在仓库里的路径），
  // 用于把相对链接、短 SHA、以及**相对图片地址**还原成能访问的绝对地址
  window.MDContext = { repo: null, ref: null, path: null, user: null };

  var renderer = {
    code: function (a, b) {
      var code = (a && typeof a === 'object') ? a.text : a;
      var lang = (a && typeof a === 'object') ? a.lang : b;
      var html;
      try {
        if (lang && window.hljs && hljs.getLanguage(lang)) {
          html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } else if (window.hljs) {
          html = hljs.highlightAuto(code).value;
        } else html = U.esc(code);
      } catch (e) { html = U.esc(code); }
      var lines = code.split('\n').length;
      var gutter = '';
      if (lines > 1 && lines < 400) {
        for (var i = 1; i <= lines; i++) gutter += '<div>' + i + '</div>';
      }
      return '<pre class="md-code"' + (lang ? ' data-lang="' + U.esc(lang) + '"' : '') + '>' +
        '<div class="code-lines">' +
        (gutter ? '<div class="gutter">' + gutter + '</div>' : '') +
        '<code class="hljs language-' + U.esc(lang || 'text') + '">' + html + '</code></div></pre>';
    },
    link: function (a, b, c) {
      var href = (a && typeof a === 'object') ? a.href : a;
      var text = (a && typeof a === 'object') ? a.text : c;
      return mdLink(href, text);
    },
    image: function (a, b, c) {
      var href = (a && typeof a === 'object') ? a.href : a;
      var text = (a && typeof a === 'object') ? a.text : c;
      /* 以前外链图片（https://…）被包进 <a target="_blank"> 且不带 data-zoom：
       * 内置查看器只认 [data-zoom]，而 WebView 又没开多窗口、也没实现
       * onCreateWindow —— 点下去既不放大也不跳转，看起来就是「图片点不了」。
       * 现在不管内外链一律打上 data-zoom，点击走内置查看器。 */
      return '<img class="md-img" src="' + U.esc(resolveImgUrl(href)) + '" alt="' + U.esc(text || '') +
        '" loading="lazy" data-zoom="1">';
    },
    /* 原始 HTML：以前一律 return ''，于是 GitHub 上传的视频
     * （issue / README 里的 <video src="https://github.com/user-attachments/…">）
     * 在应用里连个影子都没有 —— 这就是「看不了视频」。
     * 现在放行一小撮只影响排版和媒体的标签，其余照旧丢掉；
     * 后面还有 DOMPurify 兜底，script / iframe / 事件属性留不下来。 */
    html: function (a) {
      var h = (a && typeof a === 'object') ? (a.text || a.raw) : a;
      if (!h) return '';
      var names = h.match(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g);
      if (!names) return '';   // 纯注释之类，没有标签
      for (var i = 0; i < names.length; i++) {
        if (!HTML_OK.test(names[i].replace(/^<\/?/, ''))) return '';
      }
      return h;
    }
  };

  /* 允许出现在原始 HTML 里的标签名。凡是影响行为的一律不在表内：
   * script / iframe / style / form / input / object / embed … */
  var HTML_OK = /^(?:video|source|img|picture|figure|figcaption|br|hr|p|div|span|a|b|i|u|s|em|strong|del|ins|sub|sup|kbd|code|pre|blockquote|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|h[1-6]|details|summary|center)$/i;

  /* GitHub 上传的视频 / 图片附件：粘贴进来时是一行裸链接，
   * 光有 <a> 点开只会跳浏览器（视频还得下载），所以就地还原成播放器。 */
  var VIDEO_EXT = /\.(?:mp4|m4v|mov|webm|ogv|ogg|mkv)(?:[?#]|$)/i;
  var IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:[?#]|$)/i;

  function isVideo(u) { return VIDEO_EXT.test(u || ''); }
  function isImage(u) { return IMAGE_EXT.test(u || ''); }

  /* ============================================================
   * 图片地址补全 —— 解决「README 里的图片看不了」
   *
   * README 里的图片几乎都写成相对路径（![图](docs/img/a.png)）。
   * 网页上浏览器会拿当前页地址去补；App 里页面是 file:///android_asset/web/index.html，
   * 补出来是 file:///android_asset/web/docs/img/a.png —— 本地压根没这个文件，
   * 于是图片全部裂开，只剩一个空白框。
   *
   * 这里按 GitHub 的规则自己补全成 raw 地址：
   *   相对路径        → raw.githubusercontent.com/{repo}/{ref}/{README 所在目录}/{路径}
   *   /开头           → 当仓库根目录算
   *   github.com/…/blob/…/x.png → raw.githubusercontent.com（网页版那种写法
   *                     直接当 src 拉到的是 HTML 页面，同样是裂图）
   *   其它绝对地址     → 原样不动
   * ============================================================ */
  function joinPath(basePath, rel) {
    var dir = String(basePath || '').replace(/\\/g, '/');
    var cut = dir.lastIndexOf('/');
    dir = cut >= 0 ? dir.substring(0, cut + 1) : '';   // 只留目录，去掉文件名
    var parts = (dir ? dir.split('/') : []).concat(String(rel || '').split('/'));
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '' || p === '.') continue;
      if (p === '..') { out.pop(); continue; }
      out.push(p);
    }
    return out.join('/');
  }

  function rawUrl(repo, ref, path) {
    var q = '';
    var i = String(path).search(/[?#]/);
    if (i >= 0) { q = path.substring(i); path = path.substring(0, i); }
    return 'https://raw.githubusercontent.com/' + repo + '/' + (ref || 'HEAD') + '/' +
      String(path).split('/').map(encodeURIComponent).join('/') + q;
  }

  function resolveImgUrl(href) {
    var h = String(href == null ? '' : href).trim();
    if (!h) return h;
    if (/^(?:data|blob):/i.test(h)) return h;
    if (/^\/\//.test(h)) return 'https:' + h;                 // 协议相对地址
    var m = h.match(/^https?:\/\/(?:www\.)?github\.com\/([^\/]+)\/([^\/]+)\/(?:blob|raw)\/([^\/]+)\/(.+)$/i);
    if (m) return rawUrl(m[1] + '/' + m[2], m[3], m[4]);
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;             // 其它绝对地址原样
    if (h.charAt(0) === '#') return h;                        // 页内锚点，不是图片
    var ctx = window.MDContext;
    if (!ctx || !ctx.repo) return h;                          // 没有上下文就别乱补
    // 以 / 开头 = 相对仓库根（GitHub 网页版就是这个语义），否则相对 README 所在目录
    return rawUrl(ctx.repo, ctx.ref,
      h.charAt(0) === '/' ? joinPath('', h) : joinPath(ctx.path, h));
  }

  /* ============================================================
   * 图片走原生通道 —— 光补全地址还不够
   *
   * raw.githubusercontent.com 在不少网络下直连是不通的（api.github.com 反而通，
   * 因为 App 内的列表/文本走的是原生网络栈）。所以补全出 raw 地址之后，
   * 加载也交给原生：拉回 base64 转成 data URI 塞回 <img>。
   * 拉不到（超时 / 404 / 太大）就维持原样，交给 img-broken 兜底。
   * 没有原生桥（浏览器 Demo）时保持直连不动。
   * ============================================================ */
  var fetchQueue = [], fetching = 0, FETCH_CONCURRENCY = 4;
  /* 渲染完顺手预热几张图（Java 侧后台下到磁盘，滑到时读本地文件）。
   * 上限与 Java 侧 ImageProxy.PREFETCH_LIMIT 对齐：多发了也是被截断。 */
  var PRELOAD_MAX = 8;
  /* 无扩展名附件单独再限一道：它们可能是几十 MB 的录屏，不值得替用户全买。 */
  var PROBE_PRELOAD_MAX = 3;
  /* 主路迟迟不出图，过了这么久就把备用路也点着（详见 armLineRace）。
   * 不是一上来就两条都下 —— 那等于每图两份流量；只有真的慢，才值得开第二趟。 */
  var RACE_AFTER_MS = 2000;
  /* 同一个 URL 只真正拉一次。
   * README 里常常好几处引用同一张图（正文一张、表格里再列一次地址），
   * 不去重就是同一张几百 KB 的图下三四遍 —— 流量和等待都是白搭。 */
  var fetched = Object.create(null);   // url -> data URI（已完成）
  var inflight = Object.create(null);  // url -> 等待同一份结果的 job 列表（在路上）

  function sniffMime(b64) {
    /* base64 前缀就是文件头魔数的编码，认这几种最常见的就够了 */
    if (/^iVBORw0KGgo/.test(b64)) return 'image/png';         /* \x89PNG */
    if (/^\/9j\//.test(b64))      return 'image/jpeg';        /* FFD8FF */
    if (/^R0lGOD/.test(b64))      return 'image/gif';         /* GIF8   */
    if (/^UklGR/.test(b64))       return 'image/webp';        /* RIFF   */
    /* SVG 是文本格式，没有二进制魔数，但开头就是那几个字符：
     * "<svg" → PHN2Zy，"<?xml" → PD94bW。响应头丢了 Content-Type 时，
     * 就靠它别让 SVG 掉进 application/octet-stream —— 那个类型
     * WebView 是拒绝当成图片渲染的，兜底拉回来了也照样裂。 */
    if (/^PHN2Zy/.test(b64))      return 'image/svg+xml';     /* "<svg"  */
    if (/^PD94bW/.test(b64))      return 'image/svg+xml';     /* "<?xml" */
    return '';
  }

  function mimeOf(headers, url) {
    try {
      var ct = (headers && (headers['content-type'] || headers['Content-Type'])) || '';
      ct = String(ct).split(';')[0].trim();
      if (/^image\//i.test(ct)) return ct;
    } catch (e) {}
    var m = (String(url).match(/\.([a-z0-9]+)(?:[?#]|$)/i) || [])[1] || '';
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
             webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
             ico: 'image/x-icon' }[m.toLowerCase()] || 'application/octet-stream';
  }

  /* 只给 GitHub 自家域名带令牌 —— 把令牌发给第三方图床等于把仓库写权限交出去 */
  function headersFor(url) {
    if (!/^https?:\/\/(?:[^\/]*\.)?(?:githubusercontent\.com|github\.com|github\.io)\//i.test(url))
      return null;
    var t = (window.API && typeof window.API.getToken === 'function') ? window.API.getToken() : '';
    return t ? { Authorization: 'Bearer ' + t, Accept: '*/*' } : null;
  }

  function pumpFetch() {
    while (fetching < FETCH_CONCURRENCY && fetchQueue.length) {
      var job = fetchQueue.shift();
      /* 已经拉到过 —— 直接把现成的贴上，不再走一趟网络 */
      if (fetched[job.url]) {
        job.img.src = fetched[job.url];
        job.img.classList.remove('img-broken');
        continue;
      }
      /* 同一张图正在路上 —— 挂到它的队列上等结果。
       * 少了这一步，README 里三处引用同一张 417KB 的图就会同时发出三个请求
       * （并发 4 条，谁也不知道对方在拉同一个 URL）。 */
      if (inflight[job.url]) { inflight[job.url].push(job); continue; }

      var group = inflight[job.url] = [job];
      fetching++;
      (function (url, jobs) {
        window.Native.httpB64(url, headersFor(url)).then(function (res) {
          try {
            if (res && res.status === 200 && res.body) {
              var mime = sniffMime(res.body) || mimeOf(res.headers, url);
              var uri = 'data:' + mime + ';base64,' + res.body;
              fetched[url] = uri;
              jobs.forEach(function (j) {
                if (!j.img.isConnected) return;
                j.img.src = uri;
                j.img.classList.remove('img-broken');
              });
            }
          } catch (e) {}
          delete inflight[url];
          fetching--;
          pumpFetch();
        }).catch(function () { delete inflight[url]; fetching--; pumpFetch(); });
      })(job.url, group);
    }
  }

  function queueNativeFetch(img) {
    var url = img.getAttribute('src') || '';
    if (!/^https?:/i.test(url)) return;                       // data:/相对地址不处理
    if (img.getAttribute('data-nf')) return;                  // 别重复排队
    img.setAttribute('data-nf', '1');
    fetchQueue.push({ img: img, url: url });
    pumpFetch();
  }

  /* ============================================================
   * 图片的「快车道」开没开？
   *
   * 开了的意思是：App 会在 WebView 伸手取图的时候把字节直接接过去
   * （Java 侧 ImageProxy + shouldInterceptRequest，返回时就已是解好的原始字节）。
   * 那条路没有 Base64 那一层 33% 的体积膨胀，不来回过 Binder，也不必
   * 等整张到齐 —— 浏览器天生的 HTTP 缓存和渐进解码它都有。
   * 所以**开了反倒什么都不必做**：<img src> 保持原样交给 WebView 自己拉，
   * 就是最快的一条路。
   *
   * 没开（浏览器演示模式、或者这个方法压根不在）就退回老的 base64 通道：
   * 慢是慢点，图照样出来。
   * ============================================================ */
  function proxyReady() {
    try {
      return !!(window.NativeBridge
        && typeof window.NativeBridge.imageProxyReady === 'function'
        && window.NativeBridge.imageProxyReady());
    } catch (e) { return false; }
  }

  /* ============================================================
   * 这张图已经在「眼前」了吗？
   *
   * 预热只收**还没滑到**的图。屏幕上这几张此刻正由 WebView 自己拉
   * （Chromium 那条路最快，1.2.1 就是这么出图的），我们再下一遍，
   * 同一份字节买两次单不说，还跟它抢同一根管子 —— 屏幕上那张反而变慢。
   * 这正是「加了预热反而比 1.2.1 慢」的头一条。
   *
   * 取不到位置信息（还没排版、jsdom 之类的环境）一律按「还没看见」算：
   * 宁可多下，也别把「滑到就有」这条路给断了。
   * ============================================================ */
  function belowFold(el) {
    try {
      var r = el.getBoundingClientRect();
      if (!r) return true;
      if (!r.height && !r.top && !r.bottom) return true;      /* 还没排版 */
      var h = window.innerHeight
        || (document.documentElement && document.documentElement.clientHeight) || 0;
      if (!h) return true;
      return r.top > h;                                        /* 整块都在屏幕下面 */
    } catch (e) { return true; }
  }

  /* ============================================================
   * 双路竞速：主路迟迟不出图，就把备用路也点着
   *
   * 同一个附件有两条官方线路（详见 mountHtml 里那段注释）。以前要等主路
   * 走到 error 才换 —— 而那条路要是不通，等的是**连接超时**，十几秒起步，
   * 用户早就把页面划走了。
   *
   * 这里不等失败，只等「慢」：过了 RACE_AFTER_MS 主路还没出来，就悄悄用
   * new Image() 把备用路点着；它先回来就换过去（字节已经在 HTTP 缓存里，
   * 换的这一下是秒出）。主路要是在这之前出来了，第二趟压根不会发起 ——
   * 快的图不该替它付两份流量。
   * ============================================================ */
  function armLineRace(img, alt) {
    if (!alt || img.getAttribute('data-race')) return;
    img.setAttribute('data-race', '1');
    setTimeout(function () {
      try {
        if (!img.isConnected) return;
        if (img.complete && img.naturalWidth > 0) return;      /* 主路已经出来了 */
        var probe = new Image();
        probe.onload = function () {
          if (!img.isConnected) return;
          if (img.complete && img.naturalWidth > 0) return;    /* 主路后发先至 */
          img.setAttribute('src', alt);
        };
        probe.src = alt;
      } catch (e) {}
    }, RACE_AFTER_MS);
  }

  /* ============================================================
   * 点图片 = 查看大图；长按图片 = 打开图片指向的那个页面
   *
   * 官方渲染的正文里，上传的截图几乎都被包在 <a target="_blank"> 里
   * （href 就是 user-attachments 那个地址）。以前只绑 img.onclick，
   * 而 app.js 的外链委托挂在 document 的**捕获**阶段 —— 跑在图片自己的
   * onclick 之前，一点就把整个页面导去 user-attachments：那是一个
   * 顶栏写着 GitHub、下面一片白的窗口（附件地址直接导航只会吐出
   * 一张孤零零的图，什么都排版都没有）。「点开图片」这个最自然的
   * 动作反而永远轮不到查看大图。
   *
   * 所以这里做两件事：
   *   · click 一律 preventDefault —— <a> 的导航默认行为就是由这一次
   *     click 触发的，掐掉它，查看大图才轮得到出场；
   *   · 长按（约 500ms，复用 UI.bindLongPress，它会顺手压掉 Android
   *     长按弹的系统菜单、并吞掉长按松手带出来的那次 click）才把
   *     外层链接交给 openExternal —— 用户想要那个页面时仍然拿得到。
   *
   * postMount 和议题时间线（page-detail）都走这一个入口：
   * 两边先后都绑一遍的话，后绑的会把先绑的冲掉，行为又退回去。
   * ============================================================ */
  function bindImageTap(img) {
    var wasLong = window.UI && typeof window.UI.bindLongPress === 'function'
      ? window.UI.bindLongPress(img, function () {
          /* 长按图片：弹一个操作菜单。
           * 「保存到相册」永远都有；「打开链接」只在外层有 <a href> 时才出现。
           * 以前长按直接跳链接，跟「保存图片」这个更常见的诉求冲突，
           * 现在让用户自己选。 */
          try {
            var a = img.closest ? img.closest('a[href]') : null;
            var href = a ? (a.getAttribute('href') || '') : '';
            var hasLink = !!href && /^(https?:|mailto:|tel:)/i.test(href);

            var items = '<button class="btn" data-save style="width:100%;margin-bottom:8px">保存到相册</button>';
            if (hasLink) {
              items += '<button class="btn" data-open style="width:100%">打开图片所在页面</button>';
            }
            window.UI.sheet({
              title: '图片操作',
              body: '<div style="padding:4px 0">' + items + '</div>',
              onMount: function (body, close) {
                var root = document.getElementById('sheet-root');
                var saveBtn = root.querySelector('[data-save]');
                if (saveBtn) saveBtn.onclick = function () {
                  close();
                  if (window.Native && typeof window.Native.saveImage === 'function') {
                    window.Native.saveImage(img.src);
                  } else if (window.NativeBridge && typeof window.NativeBridge.saveImage === 'function') {
                    window.NativeBridge.saveImage(img.src);
                  }
                };
                var openBtn = root.querySelector('[data-open]');
                if (openBtn) openBtn.onclick = function () {
                  close();
                  if (window.NativeBridge && typeof window.NativeBridge.openExternal === 'function') {
                    window.NativeBridge.openExternal(href);
                  } else if (typeof window.open === 'function') {
                    window.open(href, '_blank');
                  }
                };
              }
            });
          } catch (e) {}
        })
      : function () { return false; };
    img.onclick = function (e) {
      if (wasLong()) return;                       /* 长按松手带出来的 click，不是点击 */
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      window.UI.viewImage(img.src);
    };
  }

  /* GitHub 网页端上传的附件是**没有扩展名**的（拖个视频进 issue，
   * 贴出来就是 github.com/user-attachments/assets/<uuid> 这么一行），
   * 从 URL 上看不出是视频还是图片 —— 所以乐观当视频渲染，
   * 加载失败（多半是张截图）自动降级成图片，再不行退回成链接。
   * 降级链绑在 MD.mount 里，见 probeMedia()。 */
  var ATTACH_RE = /^https?:\/\/(?:www\.)?github\.com\/user-attachments\/[a-z]+\/[0-9a-zA-Z-]{6,}/i;

  /* 官方渲染结果里的图片地址是**带签名**的私有图床：
   *   https://private-user-images.githubusercontent.com/<uid>/<fileid>-<uuid>.png?jwt=…
   * 那个 jwt 只有 5 分钟有效（实测 exp 与 nbf 相差 300 秒）。照搬进 App 会踩两个坑：
   * 懒加载的图滑到那儿才发请求，5 分钟一过就是裂图；而且签名每次请求都不同，
   * 磁盘缓存按 URL 做 key，等于一次也命中不了。
   * 换回不带签名的那份稳定地址（github.com/user-attachments/assets/<uuid>）
   * 就没这些事了 —— 它自己会 302 到真正的字节（S3 预签名），
   * ImageProxy 照旧接得住，缓存在 App 里也只对这一份。 */
  var PRIVATE_IMG_RE = /^https?:\/\/private-user-images\.githubusercontent\.com\/\d+\/\d+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]+(?:[?#].*)?$/i;

  function normalizeAssetUrl(u) {
    var s = String(u == null ? '' : u);
    var m = s.match(PRIVATE_IMG_RE);
    if (m) return 'https://github.com/user-attachments/assets/' + m[1];
    return s;
  }

  /* 从地址后缀认出它是什么视频（给 <source type> 用）。
   * 稳定地址没有扩展名，认不出来就不写 type —— 浏览器照样会去试。 */
  function mimeFromUrl(u) {
    var m = String(u == null ? '' : u).match(/\.(mp4|m4v|mov|webm|ogv|ogg|mkv)(?:[?#]|$)/i);
    if (!m) return '';
    var e = m[1].toLowerCase();
    if (e === 'mp4' || e === 'm4v') return 'video/mp4';
    if (e === 'mov') return 'video/quicktime';
    if (e === 'webm') return 'video/webm';
    if (e === 'ogv' || e === 'ogg') return 'video/ogg';
    return 'video/' + e;
  }

  /**
   * 给官方的 <video> 挂两条 <source>：稳定地址在前，带签名的 CDN 地址在后。
   *
   * 浏览器自己会按顺序试，前一个拉不动就换下一个，不用等 JS 的 error 事件 ——
   * 省一趟往返。两条都是官方服务器（一个 github.com 302 到 S3，一个是
   * githubusercontent.com 的 CDN），只是路线不同：国内常见的是其中一条通、
   * 另一条不通，多给一条路就是多一次机会。
   */
  function attachVideoSources(v) {
    var cdn = v.getAttribute('src');
    var stable = v.getAttribute('data-stable');
    if (!cdn || !stable) return;
    v.removeAttribute('src');           // 还挂着 src 的话，浏览器根本不看 <source>
    var list = [cdn, stable];           // 直出的那条在前，同上：快的先试
    for (var i = 0; i < list.length; i++) {
      var s = document.createElement('source');
      s.setAttribute('src', list[i]);
      var t = mimeFromUrl(list[i]);
      if (t) s.setAttribute('type', t);
      v.appendChild(s);
    }
  }


  function videoTag(u, cls) {
    return '<video class="md-video' + (cls ? ' ' + cls : '') + '" src="' + U.esc(u) +
      '" controls preload="metadata" playsinline webkit-playsinline></video>';
  }

  function imgTag(u, alt) {
    return '<img class="md-img" src="' + U.esc(resolveImgUrl(u)) + '" alt="' + U.esc(alt || '') +
      '" loading="lazy" data-zoom="1">';
  }

  /* 无扩展名附件的降级链：视频加载失败 → 当图片试 → 再失败给个能点的链接。
   * GitHub 上传的截图和视频长得一模一样（都没有扩展名），
   * 唯一可靠的区别就是「让 <video> 自己去拉 metadata，拉不动就换 <img>」。 */
  function probeMedia(v) {
    if (v.getAttribute('data-probed')) return;
    v.setAttribute('data-probed', '1');
    var url = v.getAttribute('src');
    if (!url) return;
    var stepped = false;
    v.addEventListener('error', function () {
      if (stepped) return;
      stepped = true;
      var img = new Image();
      img.onload = function () {
        /* 直接把探测用的这个 Image 换上去 —— 它的字节已经下好了。
         * 以前是再 createElement 一个 <img> 并赋上同样的 src：
         * 于是同一个 URL 又发了一次请求（降级链里的第三趟）。
         * 浏览器缓存多半能接住，但快车道走的是 ImageProxy 的磁盘缓存，
         * 那一层对「刚刚才拉过」没有记忆，白跑一趟网络。 */
        img.className = 'md-img';
        img.alt = '';
        img.setAttribute('data-zoom', '1');
        window.MD.bindImageTap(img);     /* 和正文图片同一套：点 = 看大图，长按 = 开链接页 */
        if (v.parentNode) v.parentNode.replaceChild(img, v);
      };
      img.onerror = function () {
        var a = document.createElement('a');
        a.className = 'md-attach-link';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '📎 打开附件';
        if (v.parentNode) v.parentNode.replaceChild(a, v);
      };
      img.src = url;
    });
  }

  /* ============================================================
   * 链接地址规整 —— 堵住「点一下 README，整个 App 重启」的口子
   *
   * README 里的 <a> 有三种来源：Markdown 链接（走 mdLink）、
   * 原生 HTML 的 <a>（走 html 渲染器原样放行）、还有 mount 之后
   * 各路补丁塞进来的。只要有一条路漏了，<a href="README.zh-CN.md">
   * 就会原样留在 DOM 里 —— WebView 拿页面地址（file:///android_asset/web/index.html）
   * 去解析它，导航到一个不存在的本地文件，onReceivedError 再把整个
   * SPA 重载回首页。用户看到的「点简体中文就重启」就是这么来的。
   *
   * 所以与其在每条渲染路上各自为战，不如在 mount 时对容器里**所有** <a>
   * 统一过一遍这里：
   *   相对路径（x / ./x / ../x / /x）→ #/{repo}/blob/{ref}/{按 README 目录补全}
   *   github.com 绝对链接            → 交给 GhLink.parse 换成站内路由，
   *                                    认不出的（discussions、wiki…）保持外链
   *   页内锚点、mailto 等其他协议    → 原样
   * ============================================================ */
  function normalizeLink(href) {
    var h = String(href == null ? '' : href).trim();
    if (!h) return h;
    if (h.charAt(0) === '#') return h;                        // 锚点，交给点击拦截
    if (/^(?:mailto|tel|sms|ftp|javascript|data|blob):/i.test(h)) return h;
    if (/^\/\//.test(h)) h = 'https:' + h;                    // 协议相对地址
    if (/^https?:\/\//i.test(h)) {
      /* GitHub 上传的附件（issue 里拖进去的截图 / 录屏）不是站内页面，
       * 原样留着 —— 点它没有「仓库内视图」可去，长按图片打开的就是它。
       * 以前掉进下面的兜底规则被站内化成 '#/user-attachments/assets/…'，
       * Router 不认识这个路由，点一下图片就掉进那个顶栏写着 GitHub、
       * 下面一片白的内嵌窗口。 */
      if (/^https?:\/\/(?:www\.)?github\.com\/user-attachments\//i.test(h)) return h;
      if (/^https?:\/\/(?:www\.)?github\.com\//i.test(h) && window.GhLink) {
        var hit = window.GhLink.parse(h);
        if (hit && hit.kind === 'route') return '#' + hit.path;
        if (hit && hit.kind === 'download') return h;         // 下载让点击层去处理
        if (hit) return hit.url;                              // external：内置浏览器打开
      }
      var gh = h.match(/^https?:\/\/(?:www\.)?github\.com\/([^\s#?]+)/i);
      if (gh) return '#/' + gh[1];                            // GhLink 不在（老页面）时的兜底
      return h;
    }
    var ctx = window.MDContext;
    if (!ctx || !ctx.repo) return h;                          // 没有上下文就别乱补
    var path = h.charAt(0) === '/' ? joinPath('', h) : joinPath(ctx.path, h);
    return '#/' + ctx.repo + '/blob/' + (ctx.ref || 'HEAD') + '/' +
      path.split('/').map(encodeURIComponent).join('/');
  }

  function mdLink(href, text) {
    if (!href) return U.esc(text || '');
    if (isVideo(href)) return videoTag(href, 'md-probe');      // 裸的视频链接 → 直接内嵌播放器
    if (ATTACH_RE.test(href)) return videoTag(href, 'md-probe'); // 无扩展名的上传附件 → 乐观当视频，失败自动降级
    /* 裸的图片链接 → 就地显示，可点开。
     *
     * 只有「没有标题」或「标题就是 URL 本身」时才算裸链接 —— 那正是 GitHub
     * 网页端的做法。带标题的标准链接 [标题](url) 一律按链接渲染：
     * 以前不分青红皂白，只要 href 指向图片就渲染成 <img>，于是 README 里
     * [`docs/tips.png`](…/blob/main/docs/tips.png) 这种「反引号路径 + 跳转链接」
     * 也被画成了图 ——— 一张 417KB 的图在同一个 README 里被请求了 5 次，
     * 官网却只显示两条链接。 */
    if (isImage(href) && (!text || text === href)) return imgTag(href, text);
    if (/^https?:/i.test(href)) {
      var norm = normalizeLink(href);
      if (norm.charAt(0) === '#') {
        return '<a href="' + U.esc(norm) + '">' + U.esc(text || href) + '</a>';
      }
      return '<a href="' + U.esc(norm) + '" target="_blank" rel="noopener">' + U.esc(text || href) + '</a>';
    }
    if (/^#/.test(href)) return '<a href="' + U.esc(href) + '">' + U.esc(text || href) + '</a>';
    /* 站内相对路径（x、./x、../x、/x）——以前这里写死 blob/HEAD 且不认
     * 「./ 开头」「/ 开头」，漏网的直接输出相对 href，就是 file:// 导航的源头之一。
     * 现在统一交给 normalizeLink：ref 用当前渲染上下文的，不再钉死 HEAD。 */
    if (window.MDContext.repo) {
      var nb = normalizeLink(href);
      if (nb && nb.charAt(0) === '#') {
        return '<a href="' + U.esc(nb) + '">' + U.esc(text || href) + '</a>';
      }
    }
    return '<a href="' + U.esc(href) + '">' + U.esc(text || href) + '</a>';
  }

  function inlineExtras(src) {
    var repo = window.MDContext.repo;
    src = src.replace(/(^|[^\w@/])@([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})/g,
      function (m, pre, name) {
        if (/^(?:action|actions|apps|auth|blog|business|collections|contact|customer|docs|edu|enterprise|events|explore|features|gist|github|help|issues|jobs|login|marketplace|mirrors|notifications|orgs|pages|pricing|pulls|readme|security|settings|shop|showcases|sponsors|stars|status|topics|trending|users|watching)$/i.test(name)) return m;
        return pre + '<a class="mention" href="#/' + name + '">@' + name + '</a>';
      });
      if (repo) {
        src = src.replace(/(^|[^\w&])#(\d{1,7})\b/g,
          function (m, pre, n) { return pre + '<a href="#/' + repo + '/issues/' + n + '">#' + n + '</a>'; });
        /* SHA 自动链接：只认「前面不是 URL 成分」的裸 SHA。
         * 以前用 \b 边界，结果 GitHub 上传附件的 UUID（user-attachments/assets/b68c927-b888-…）
         * 恰好全是十六进制字符，URL 当场被撕成「半个链接 + 一个假 commit」——
         * 后面视频识别拿到的已经不是完整链接了，怎么看不了视频都找不到原因。
         * 所以前面是 / - . = & % > 或字母数字的一律不碰（那些都是 URL / 词的内部）。 */
        src = src.replace(/(^|[^\/\-.=&%>\w])([0-9a-f]{7,40})\b/g, function (m, pre, sha) {
          if (/^\d+$/.test(sha)) return m;
          return pre + '<a class="mono" href="#/' + repo + '/commit/' + sha + '">' + sha.substring(0, 7) + '</a>';
        });
      }
    return src;
  }

  /* mount / mountHtml 共用的后处理：链接规整、图片点击与兜底、预热、视频降级。 */
  function postMount(container, ctx) {
  /* README 里内联写的 <img src="a.png"> 走的是原始 HTML 那条路，
   * 不经过上面的 image 渲染器，相对地址得在这儿再补一遍。
   * render() 结束后上下文已经还原了，所以先临时挂回去。 */
  var prevR = window.MDContext.repo, prevF = window.MDContext.ref, prevP = window.MDContext.path;
  if (ctx) {
    window.MDContext.repo = ctx.repo || null;
    window.MDContext.ref = ctx.ref || null;
    window.MDContext.path = ctx.path || null;
  }
  /* 所有图片都能点开看（不再区分内外链）；加载失败的给它一个可见的边框，
   * 免得只剩一个空白位置，让人以为是应用坏了。 */
  /* 图片加载是懒加载的：滑到眼前才发请求 —— 那份「每次滑到这儿都要等一下」
   * 就是这么来的。这里有 App 替我们先把前几张偷偷下好，滑到时读的是本地文件。
   * 只取前几张：一份 README 可能有几十张图，全预习等于替用户把他不会滑到的
   * 部分也买了单。 */
  var preload = [];
  /* 这一次渲染要不要走快车道：整份 README 统一判断一次，
   * 免得一半图走这条路、一半图走那条路，出问题对不上账。 */
  var proxyOn = proxyReady();
  /* <a> 的 href 规整必须趁 MDContext 还挂着的时候做（往下到「还原」
   * 那一行就晚了）：原生 HTML 的 <a href="README.zh-CN.md"> 不走 mdLink，
   * 若不在这里统一补，WebView 会拿 file:// 页面地址去解析相对链接 ——
   * 导航到一个不存在的本地文件，然后 onReceivedError 把整个 SPA
   * 重载回首页，用户看到的就是「点一下链接，软件重启了」。 */
  window.UI.$$('a[href]', container).forEach(function (a) {
    var h = a.getAttribute('href') || '';
    var fixed = normalizeLink(h);
    if (fixed && fixed !== h) a.setAttribute('href', fixed);
  });
  window.UI.$$('img', container).forEach(function (img) {
    var s = img.getAttribute('src');
    if (s) {
      var fixed = resolveImgUrl(s);
      if (fixed && fixed !== s) img.setAttribute('src', fixed);
    }
    window.MD.bindImageTap(img);
    img.addEventListener('error', function () {
      img.classList.add('img-broken');
      /* 快车道没接住 —— 私有附件、404、网络抽风都有可能。
       * 先换官方的另一条线路再试一次：data-cdn 里存着带签名的原地址，
       * 域名是 githubusercontent.com（CDN），和刚才那条「github.com 302 → S3」
       * 不是同一条路 —— 国内常常是一条通一条不通。
       * 两条官方线路都不成，才退回老的 base64 通道（那条路自带 Authorization），
       * 再失败也不过是维持现在的裂图状态。 */
      var stable = img.getAttribute('data-stable');
      if (stable && img.getAttribute('src') !== stable) {
        img.setAttribute('src', stable);
        return;
      }
      if (proxyOn) queueNativeFetch(img);
    });
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
      img.classList.add('img-broken');
      /* 这张图在「同步补全 src」之前就已经失败了 —— innerHTML 解析时
       * 发出的那趟请求（比如原生 HTML 里的 <img> 先按 file:// 相对地址
       * 去要一个本地不存在的文件）毫秒级就能撞回来，error 早于监听绑定。
       * 只裂图不兜底的话，小图（几 KB 的 SVG / 图标）永远拿不到
       * 第二次机会；大图反而因为下载慢总能赶上绑定。 */
      if (window.Native && typeof window.Native.httpB64 === 'function') {
        queueNativeFetch(img);
      }
    }
    /* 备用路（data-stable）挂着的话，给它一支秒表：主路慢到一定程度就换它。
     * 见 armLineRace —— 不是一上来就两条都下。 */
    var alt = img.getAttribute('data-stable');
    if (alt && alt !== img.getAttribute('src')) armLineRace(img, alt);
    if (proxyOn) {
      var u = img.getAttribute('src') || '';
      /* 只预热**还没滑到**的：屏幕上这几张 WebView 正在拉，
       * 再下一遍就是同一份字节买两次，还要跟它抢带宽（见 belowFold）。 */
      if (/^https?:/i.test(u) && preload.length < PRELOAD_MAX && belowFold(img)) preload.push(u);
    } else if (window.Native && typeof window.Native.httpB64 === 'function') {
      // 快车道没开着：外链图片一律走原生通道拉（WebView 直连 raw 常常不通）
      queueNativeFetch(img);
    }
  });
  /* 无扩展名的 GitHub 上传附件（issue / PR 里拖进去的截图，绝大多数是图）
   * 在 render 里被渲染成 <video class="md-probe"> 去试探（见 ATTACH_RE 那段）。
   * 问题是：**此刻它们还不是 <img>**，上面那个 $$('img') 循环一个都选不到。
   *
   * 于是 README 的图渲染完就被预热好、滑到时读磁盘；而 issue 里的截图
   * 从来不进预热名单，每次滑到都要现拉一遍 —— 「议题里的图比 README 慢」
   * 的根子就在这儿。这里单独把它们也收进预热。
   *
   * 限量比普通图片更严（见 PROBE_PRELOAD_MAX）：这类地址也可能是录屏。
   * 而且 Java 侧还会先探一下大小再决定下不下，不会替用户把他没点的
   * 几十 MB 视频也买了单。 */
  var probeN = 0;
  window.UI.$$('video.md-probe', container).forEach(function (v) {
    var u = v.getAttribute('src') || '';
    if (!/^https?:/i.test(u)) return;
    if (preload.length >= PRELOAD_MAX || probeN >= PROBE_PRELOAD_MAX) return;
    if (preload.indexOf(u) >= 0) return;
    preload.push(u);
    probeN++;
  });
  if (proxyOn && preload.length) {
    try { window.NativeBridge.prefetchImages(JSON.stringify(preload)); } catch (e) {}
  }
  window.MDContext.repo = prevR; window.MDContext.ref = prevF; window.MDContext.path = prevP;
  /* 无扩展名的 GitHub 上传附件：乐观当视频渲染，这里负责失败后的降级链
   * 视频 → 图片 → 链接。没有这条链，截图类附件会留一块按不动的黑砖。 */
  window.UI.$$('video.md-probe', container).forEach(probeMedia);
  /* 链接点击分流（href 已在上面统一规整过）：
   *   #/…   → 站内路由；
   *   #xxx  → 页内锚点。marked 关了 headerIds，标题本来就没有 id，
   *           锚点跳了也白跳，按住不动比把 location.hash 弄脏强；
   *   http… → 不许 WebView 自己导航。主帧一导航，SPA 就没了 ——
   *           外链交给内置浏览器，下载直链交给原生下载通道；
   *   mailto 等其他协议放行，原生层认得。 */
  window.UI.$$('.md a', container).forEach(function (a) {
    a.onclick = function (e) {
      var href = a.getAttribute('href') || '';
      if (href.charAt(0) === '#') {
        e.preventDefault();
        if (href.charAt(1) === '/') window.Router.go(href.substring(1));
        return;
      }
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        var hit = (window.GhLink && window.GhLink.parse) ? window.GhLink.parse(href) : null;
        if (hit && hit.kind === 'download' && window.Native && window.Native.download) {
          // 按来源页分子目录：议题里点的进 githup/议题，Release 说明里点的进 githup/release
          var cat = (window.Attach && Attach.currentCategory) ? Attach.currentCategory() : '';
          var ok = window.Native.download(hit.url, hit.name, window.Native.authHeaders(), cat);
          window.UI.toast(ok ? '开始下载 ' + hit.name : '下载未能发起');
          return;
        }
        var u = (hit && hit.kind === 'external') ? hit.url : href;
        if (window.Native && window.Native.openInApp) window.Native.openInApp(u, 'GitHub');
        else window.open(u, '_blank');
      }
    };
  });
  }

  var MD = {
    /** 渲染为受信任的 HTML */    render: function (src, ctx) {
      if (!src) return '';
      var prev = { repo: window.MDContext.repo, ref: window.MDContext.ref, path: window.MDContext.path };
      if (ctx) {
        window.MDContext.repo = ctx.repo || null;
        window.MDContext.ref = ctx.ref || null;
        window.MDContext.path = ctx.path || null;
      }
      try {
        // 代码块内容不参与 @/# 自动链接
        var parts = String(src).split(/```/);
        var out = parts.map(function (p, i) { return i % 2 ? p : inlineExtras(p); }).join('```');

        // 渲染器只在模块加载时注册一次（见文件末尾）。
        // 每次渲染都调用 marked.use 会让覆盖层层累积，
        // 长会话下内存和耗时持续上涨，还可能重复处理。
        var html = marked.parse(out);

        html = DOMPurify.sanitize(html, {
          /* controls / playsinline / preload 这些不是 DOMPurify 的默认属性，
           * 不在这里放行的话，视频标签会被扒成光秃秃的 <video src>，按了没反应。 */
          ADD_ATTR: ['target', 'data-zoom', 'data-lang', 'class', 'align', 'colspan', 'rowspan',
            'open', 'controls', 'playsinline', 'webkit-playsinline', 'preload', 'poster',
            'loop', 'muted', 'width', 'height', 'loading'],
          FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'object', 'embed'],
          FORBID_ATTR: ['onerror', 'onload', 'onclick']
        });
        // 补 controls：GitHub 贴进来的 <video> 未必自带 controls，
        // 没这个属性视频就是一块不会动的黑砖 —— 用户只会说「视频放不了」。
        html = html.replace(/<video\b(?![^>]*\bcontrols\b)([^>]*)>/g,
          '<video controls playsinline preload="metadata"$1>');
        return html;
      } catch (e) {
        return '<pre>' + U.esc(src) + '</pre>';
      } finally {
        window.MDContext.repo = prev.repo;
        window.MDContext.ref = prev.ref;
        window.MDContext.path = prev.path;
      }
    },

    /** 渲染并把结果写入容器，同时绑定图片点击查看 */
    /** 渲染并把结果写入容器，同时绑定图片点击查看 */
    mount: function (container, src, ctx) {
      container.innerHTML = this.render(src, ctx) || '<p class="muted">（无内容）</p>';
      container.classList.add('md');
      postMount(container, ctx);
    },

    /**
     * 渲染**官方已经渲染好**的那份 HTML —— 议题 / PR / 评论正文走这条。
     *
     * 官网的正文是服务端渲染的：上传附件时记下了 content_type，渲染时直接
     * 写出 <img width=… height=…> 或 <video>，类型和尺寸都写在 HTML 里，
     * 浏览器一点都不用猜。我们以前拿的是 Markdown 源码，附件是
     * github.com/user-attachments/assets/<uuid> 这种没有扩展名的地址 ——
     * 看不出是截图还是录屏，只能乐观当 <video> 渲染、拉不动再降级成 <img>
     * （见 probeMedia）。代价是绝大多数其实是截图的附件都要先白跑一趟视频
     * metadata，而且拿不到宽高，图一加载完页面就跳一下。
     * 现在改要 body_html（Accept: …full+json，一份请求里 markdown 和 html
     * 都有），类型与宽高都是现成的，议题里的图也终于进到 $$('img') 那条
     * 预热快车道 —— 和 README 的图走同一条路。
     */
    mountHtml: function (container, html, ctx) {
      var clean = '';
      try {
        clean = DOMPurify.sanitize(String(html == null ? '' : html), {
          ADD_ATTR: ['target', 'data-zoom', 'data-lang', 'class', 'align', 'colspan', 'rowspan',
            'open', 'controls', 'playsinline', 'webkit-playsinline', 'preload', 'poster',
            'loop', 'muted', 'width', 'height', 'loading'],
          FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'object', 'embed'],
          FORBID_ATTR: ['onerror', 'onload', 'onclick']
        });
      } catch (e) {
        clean = '';
      }
      /* 官方给的 <video> 常常是裸的（实测 body_html 里就只有 src 一个属性），
       * 没有 controls 就是一块按不动的黑砖 —— 和 Markdown 那条路一样补上。 */
      clean = clean.replace(/<video\b(?![^>]*\bcontrols\b)([^>]*)>/g,
        '<video controls playsinline preload="metadata"$1>');
      container.innerHTML = clean || '<p class="muted">（无内容）</p>';
      container.classList.add('md');
      /* 先把带签名的图床地址换回稳定的那份，再交给 postMount：
       * 预热和磁盘缓存都是按 URL 做 key 的，用带 jwt 的地址等于每 5 分钟
       * 换一次 key —— 永远存不住，懒加载的图还会过期成裂图。 */
      try {
        /* 官方给的这条带签名地址**不换掉** —— 它就照官网的样子用。
         *
         * 为什么：官网的正文里用的就是它（private-user-images.githubusercontent.com，
         * GitHub 自己的 CDN 域名），字节直出、不用跳；而换成不带签名的那份
         * （github.com/user-attachments/assets/<uuid>）要先吃一个 302 才到 S3，
         * 多一趟往返、多一次 TLS 握手。官网图片快，快就快在它走的是这条直路。
         *
         * 不带签名的那份留作第二条路（data-stable）：签名只有 5 分钟有效，
         * 过期了还有它。两条是同一份字节，Java 侧按 uuid 做缓存 key，
         * 所以两条共用一份缓存、预热也不会白做（见 ImageProxy.cacheKey）。
         *
         * 链接（<a href>）是随时会点的，那种地方用不会过期的那份。 */
        var nodes = container.querySelectorAll('img[src],video[src],a[href]');
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          ['src', 'href'].forEach(function (at) {
            var v = n.getAttribute(at);
            if (!v) return;
            var stable = normalizeAssetUrl(v);
            if (stable && stable !== v) {
              if (at === 'src') n.setAttribute('data-stable', stable);
              else n.setAttribute('href', stable);
            }
          });
          /* tagName 在 HTML 文档里是大写（'VIDEO'），直接比 'video' 永远不成立 */
          if (String(n.tagName).toLowerCase() === 'video') attachVideoSources(n);
        }
      } catch (e) {}
      postMount(container, ctx);
    },

    /** 纯文本摘要（列表用） */
    excerpt: function (src, n) {
      if (!src) return '';
      var s = String(src).replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~|-]/g, ' ').replace(/\s+/g, ' ').trim();
      return s.length > (n || 140) ? s.substring(0, n || 140) + '…' : s;
    },

    /** 有没有滑出屏幕。预热名单靠它决定收不收这张图（见 belowFold）。 */
    belowFold: belowFold,

    /** 点图片 = 查看大图，长按 = 打开它指向的页面。时间线那边也用这个入口。 */
    bindImageTap: bindImageTap
  };

  window.MD = MD;

  /**
   * 渲染器与全局选项只在这里注册一次。
   *
   * 放到每次 render() 里调 marked.use 的话，覆盖会一层层叠加：
   * 同一个渲染器被重复挂载，渲染越来越慢、内存只涨不降，长会话下很要命。
   * 注册时机放在模块加载时，MD.render() 里只管 parse。
   */
  try {
    marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
    marked.use({ renderer: renderer });
  } catch (e) {
    // marked 出了问题也不该让整个模块挂掉，render() 里有兜底
  }
})();
