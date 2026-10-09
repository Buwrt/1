/* ============================================================
 * page-totp.js — 两步验证器页面（"我的"里的功能）
 *
 * 不依赖 GitHub 登录：密钥存在本机，算法在本地算，断网也能出码。
 * 列表上方是实时动态码，下方是账户；每 30 秒（或账户自定义周期）
 * 自动刷新一次。
 *
 * 存哪：window.Store（原生 SharedPreferences）。
 * 绝不进 WebView 的 localStorage —— 跟令牌一个待遇。
 * ============================================================ */
(function () {
  'use strict';

  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});

  var STORE_KEY = 'totp_accounts';
  /* 定时器只留一个：页面切走时一定要清掉，
     否则每进一次这个页面就多一个 1 秒的定时器，越积越多。 */
  var tickTimer = null;

  /* ---------- 账户读写 ---------- */

  function load() {
    try {
      var raw = window.Store.get(STORE_KEY);
      if (!raw) return [];
      var arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return dedupe(Array.isArray(arr) ? arr : []);
    } catch (e) { return []; }
  }

  /** 判定「是不是同一个账户」用的指纹：规整后的密钥 + 发行方 + 账户名。
      历史数据里出现过同一账户被存两份（改过 issuer / name、导入重复），
      通知栏就会并排出现两行一模一样的码 —— 存之前先去重。 */
  function fp(a) {
    var s = String(a && a.secret || '').toUpperCase().replace(/[\s\-_]/g, '').replace(/=+$/, '');
    return s + '|' + String(a && a.issuer || '') + '|' + String(a && a.name || '');
  }

  function dedupe(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (a) {
      if (!a) return;
      var k = fp(a);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(a);
    });
    return out;
  }

  function save(list) {
    try {
      list = dedupe(list);
      window.Store.set(STORE_KEY, JSON.stringify(list));
      /* 顺手让原生层知道「当前有哪些账户」——
         后台常驻通知要拿它来展示动态码（见 TotpService）。 */
      if (window.NativeBridge && typeof NativeBridge.totpSync === 'function') {
        try { NativeBridge.totpSync(JSON.stringify(list)); } catch (e) {}
      }
      return true;
    } catch (e) { return false; }
  }

  function uid() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** 补一条账户缺省的 id / 参数（老数据、手改过的数据都能兜住）。
      recovery（恢复密钥）只认数组（一行一条，来自用户导入的 txt）——
      上一版误生成过的整串随机码是字符串，这里直接不认；
      这里是白名单式重建，不写进去的字段会在每次 normalize 时被无声丢掉。 */
  function normalize(a) {
    return {
      id: a.id || uid(),
      secret: String(a.secret || '').toUpperCase().replace(/\s/g, ''),
      issuer: a.issuer || '',
      name: a.name || '',
      digits: a.digits || 6,
      period: a.period || 30,
      algo: a.algo || 'SHA1',
      type: a.type || 'totp',
      counter: a.counter || 0,
      recovery: Array.isArray(a.recovery)
        ? a.recovery.filter(function (x) { return typeof x === 'string' && x.trim(); })
              .map(function (x) { return x.trim(); })
        : []
    };
  }

  function title(a) {
    return a.issuer || a.name || '未命名账户';
  }

  function subtitle(a) {
    if (a.issuer && a.name && a.name !== a.issuer) return a.name;
    return a.issuer ? '' : '未命名账户';
  }

  /* ---------- 分段显示 ---------- */

  /**
   * 把 6 位码按「XXX XXX」拆开渲染。
   *
   * 每 30 秒会整块重画一次数字：如果不去比较，用户就会看到数字在
   * 毫无必要地闪。这里只对「变了的字符」换文本，静态的一律保留。
   */
  function paintCode(el, code) {
    if (!el) return;
    var text = window.TOTP.group(code);
    if (el._last === text) return;
    el._last = text;
    var want = text.split('');
    var have = el.querySelectorAll('span.d');
    if (have.length !== want.length) {
      el.innerHTML = want.map(function (c) {
        return c === ' ' ? '<span class="sp"></span>' : '<span class="d">' + c + '</span>';
      }).join('');
      return;
    }
    for (var i = 0; i < want.length; i++) {
      if (have[i].textContent !== want[i]) have[i].textContent = want[i];
    }
  }

  /** 倒计时环：用 conic-gradient 画，不引 SVG，省体积 */
  function paintRing(el, left, period) {
    if (!el) return;
    if (el._lastLeft === left) return;
    el._lastLeft = left;
    var pct = Math.max(0, Math.min(1, left / period));
    var color = left <= 5 ? '#E5534B' : (left <= 10 ? '#D29922' : '#3FB950');
    el.style.background = 'conic-gradient(' + color + ' ' + (pct * 360) + 'deg, rgba(128,128,128,.22) 0)';
  }

  function copy(text) {
    if (!text) return;
    try {
      if (window.NativeBridge && typeof NativeBridge.copy === 'function') {
        NativeBridge.copy(text);
        UI.toast('已复制');
        return;
      }
    } catch (e) {}
    try { UI.copy(text); UI.toast('已复制'); return; } catch (e) {}
    UI.toast('复制失败，请长按选择');
  }

  /* ---------- 恢复密钥 ---------- */

  /* 恢复密钥从哪来 —— 从你自己上传的 txt 来（比如 GitHub 给的
     github-recovery-codes.txt，一行一条，长得像 c7abd-aaef5）。
     App 不凭空造码：文件里能按行挑出「像码的行」的才算数，
     标题、说明这些带空格/中文的行自动过滤。 */
  function parseRecoveryTxt(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var s = line.trim();
      if (!s) return;
      /* 只收「无空格的字母数字连字符串」——GitHub 的码（xxxxx-xxxxx）
         天然满足；带空格的标题行、中文说明行进不来。 */
      if (/^[0-9A-Za-z\-]{6,40}$/.test(s)) out.push(s);
    });
    return out;
  }

  /* base64 -> 文本（GitHub 的 txt 是 ASCII，但保不齐有 BOM/UTF-8 标题行） */
  function b64ToText(b64) {
    try {
      var bin = window.atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (window.TextDecoder) return new TextDecoder('utf-8').decode(bytes);
      return bin;
    } catch (e) { return ''; }
  }

  /* 复制一条恢复码。idx 给了就顺带说清楚是第几条（共几条）。 */
  function copyCode(text, idx, total) {
    if (!text) return;
    var done = false;
    try {
      if (window.NativeBridge && typeof NativeBridge.copy === 'function') {
        NativeBridge.copy(text);
        done = true;
      }
    } catch (e) {}
    if (!done) { try { UI.copy(text); done = true; } catch (e) {} }
    if (done && idx) UI.toast('已复制第 ' + idx + ' 条，共 ' + total + ' 条');
    else if (done) UI.toast('已复制');
    else UI.toast('复制失败，请长按选择');
  }

  /* 导入：拉系统文件选择器选 txt，按行解析后整批存进这个账户。
     用户在选择器里取消（file 为空）就安静回来，什么都不说。 */
  function importRecovery(id) {
    try {
      if (!(window.Native && typeof Native.pickFile === 'function')) {
        UI.toast('当前环境不支持选择文件');
        return;
      }
      if (typeof Native.canPick === 'function' && !Native.canPick()) {
        UI.toast('当前环境不支持选择文件');
        return;
      }
      Native.pickFile('*/*').then(function (file) {
        if (!file || !file.uri) return;
        return window.Native.readFileBase64(file.uri, 1024 * 1024).then(function (b64) {
          if (!b64) { UI.toast('读不出文件内容'); return; }
          var codes = parseRecoveryTxt(b64ToText(b64));
          if (!codes.length) { UI.toast('这个文件里没识别到恢复密钥'); return; }
          var list = load();
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) { list[i].recovery = codes; break; }
          }
          if (!save(list)) { UI.toast('保存失败，本机存储不可用'); return; }
          UI.toast('已导入 ' + codes.length + ' 条恢复密钥');
          showRecoveryOnce(id);
        });
      }).catch(function () {
        UI.toast('导入没完成');
      });
    } catch (e) {}
  }

  /* 闪现的这条恢复码，10 秒后自动收起，回到「没长按」的样子。
     计时器挂在模块上：再次长按 / 换账户 / 页面离开都要能清掉。 */
  var recTimer = null;       // 收起计时器
  var recShownId = null;     // 当前正在闪现的账户 id

  /* 收起某个账户的恢复密钥区（清空内容 + 藏起来），回到默认样子。 */
  function hideRecovery(id) {
    var box = document.querySelector('[data-rec="' + id + '"]');
    if (!box) return;
    box.setAttribute('hidden', '');
    box.innerHTML = '<span class="tr-lb">恢复密钥</span>';
    if (recShownId === id) { recShownId = null; }
  }

  /* 清掉正在跑的收起计时器（换账户或离开页面时用）。 */
  function clearRecTimer() {
    if (recTimer) { clearTimeout(recTimer); recTimer = null; }
  }

  /* 就地重画某个账户的恢复密钥区，只显示「一条」恢复码。
     只换 innerHTML 不整页重画，倒计时环和动态码不受打扰。 */
  function paintRecoveryOne(id, code) {
    var box = document.querySelector('[data-rec="' + id + '"]');
    if (!box) return;
    box.innerHTML = '<span class="tr-lb">恢复密钥 · 点一下可复制</span>' +
        '<button type="button" class="tr-row" data-i="0">' + U.esc(code) + '</button>';
    box.removeAttribute('hidden');
  }

  /* 长按已导入账户：随机挑一条恢复码 → 复制 → 只把这一条显示出来，
     10 秒后自动收起，回到图 1 的样子。 */
  function showRecoveryOnce(id) {
    var list = load();
    var a = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { a = list[i]; break; }
    }
    if (!a) return;
    var codes = Array.isArray(a.recovery) ? a.recovery : [];
    if (!codes.length) return;

    clearRecTimer();
    /* 换账户时先把上一个账户的闪现收掉，避免两条同时挂着 */
    if (recShownId && recShownId !== id) hideRecovery(recShownId);

    var code = codes[Math.floor(Math.random() * codes.length)];
    paintRecoveryOne(id, code);
    recShownId = id;
    copyCode(code);

    recTimer = setTimeout(function () {
      recTimer = null;
      hideRecovery(id);
    }, 10000);
  }

  /* 长按账户：
     · 还没导入过 → 拉文件选择器，上传 GitHub 给的 txt（.txt 结尾的那个）；
     · 已经导入 → 随机闪现一条恢复码（同时复制），10 秒后自动收起。 */
  function handleLongPress(id) {
    var list = load();
    var a = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { a = list[i]; break; }
    }
    if (!a) return;
    var codes = Array.isArray(a.recovery) ? a.recovery : [];
    if (!codes.length) { importRecovery(id); return; }
    showRecoveryOnce(id);
  }

  /* 长按手势：550ms 起效（与全 App 其他长按一致），手指挪动超过
     12px 按滚动处理、不触发。长按松手后系统偶尔还会派发一次
     click，用一次性捕获监听把它吃掉，免得顺手又打开了别的。 */
  function bindLongPress(item, id) {
    var timer = null, fired = false, sx = 0, sy = 0;
    item.addEventListener('touchstart', function (ev) {
      if (ev.touches.length !== 1) return;
      fired = false;
      sx = ev.touches[0].clientX;
      sy = ev.touches[0].clientY;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fired = true;
        try { handleLongPress(id); } catch (e) {}
      }, 550);
    }, { passive: true });
    item.addEventListener('touchmove', function (ev) {
      if (!timer) return;
      var t = ev.touches[0];
      if (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12) {
        clearTimeout(timer);
        timer = null;
      }
    }, { passive: true });
    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }
    item.addEventListener('touchend', function () {
      var wasLong = fired;
      cancel();
      if (wasLong) {
        var swallow = function (ev) {
          ev.stopPropagation();
          ev.preventDefault();
        };
        item.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(function () {
          item.removeEventListener('click', swallow, true);
        }, 350);
      }
      fired = false;
    });
    item.addEventListener('touchcancel', cancel);
  }

  /* ---------- 添加 / 编辑弹层 ---------- */

  function openEditor(acct, onDone) {
    var isNew = !acct;
    var a = acct ? normalize(acct) : {
      id: uid(), secret: '', issuer: '', name: '',
      digits: 6, period: 30, algo: 'SHA1', type: 'totp', counter: 0
    };

    var body =
      '<div class="totp-form">' +
        '<label class="totp-field"><span class="lb">密钥 / otpauth 链接</span>' +
          '<textarea id="tp-secret" rows="3" spellcheck="false" ' +
            'placeholder="粘贴 Base32 密钥，或 otpauth:// 链接&#10;支持 Google Authenticator 导出链接"></textarea></label>' +
        '<div class="totp-hint" id="tp-hint">密钥就是网站上那一串字母数字，通常在二维码下面。</div>' +
        '<button class="btn block" id="tp-live" style="margin-top:8px">' +
          '<span class="tp-scan-ico">⛶</span> 扫一扫（对准二维码）</button>' +
        '<button class="btn block" id="tp-scan" style="margin-top:8px">' +
          '<span class="tp-scan-ico">▣</span> 从图片识别二维码</button>' +
        '<button class="btn block" id="tp-paste" style="margin-top:8px">从剪贴板粘贴</button>' +
        (!isNew ? '<button class="btn block" id="tp-import" style="margin-top:8px">导入恢复密钥（txt）</button>' : '') +
        '<button class="btn block" id="tp-help2" style="margin-top:8px">怎么找到密钥？</button>' +
        '<div class="totp-row2">' +
          '<label class="totp-field"><span class="lb">发行方</span>' +
            '<input id="tp-issuer" type="text" placeholder="如 GitHub" value="' + U.esc(a.issuer) + '"></label>' +
          '<label class="totp-field"><span class="lb">账户</span>' +
            '<input id="tp-name" type="text" placeholder="如 alice@mail" value="' + U.esc(a.name) + '"></label>' +
        '</div>' +
        '<div class="totp-row2">' +
          '<label class="totp-field"><span class="lb">位数</span>' +
            '<select id="tp-digits">' +
              '<option value="6"' + (a.digits === 6 ? ' selected' : '') + '>6 位</option>' +
              '<option value="8"' + (a.digits === 8 ? ' selected' : '') + '>8 位</option>' +
            '</select></label>' +
          '<label class="totp-field"><span class="lb">周期</span>' +
            '<select id="tp-period">' +
              '<option value="30"' + (a.period === 30 ? ' selected' : '') + '>30 秒</option>' +
              '<option value="60"' + (a.period === 60 ? ' selected' : '') + '>60 秒</option>' +
            '</select></label>' +
        '</div>' +
        '<div class="totp-preview"><div class="pv-label">实时预览</div>' +
          '<div class="pv-code" id="tp-pv">------</div></div>' +
      '</div>';

    var foot = '<button class="btn" data-close="1">取消</button>' +
      (isNew ? '' : '<button class="btn danger" id="tp-del">删除</button>') +
      '<button class="btn primary" id="tp-save">保存</button>';

    var pvTimer = null;

    UI.sheet({
      title: isNew ? '添加两步验证账户' : '编辑账户',
      body: body,
      foot: foot,
      onMount: function (root, close) {
        var $secret = UI.$('#tp-secret', root);
        var $issuer = UI.$('#tp-issuer', root);
        var $name = UI.$('#tp-name', root);
        var $digits = UI.$('#tp-digits', root);
        var $period = UI.$('#tp-period', root);
        var $hint = UI.$('#tp-hint', root);
        var $pv = UI.$('#tp-pv', root);
        if (acct) $secret.value = a.secret;

        /* 输入变化就顺手预览 —— 用户粘完密钥立刻能看到码，
           不用先保存再回来确认「有没有填对」。 */
        function preview() {
          var v = $secret.value.trim();
          if (!v) { $pv.textContent = '------'; $hint.textContent = '密钥就是网站上那一串字母数字，通常在二维码下面。'; return; }
          var parsed = window.TOTP.parseAny(v);
          if (!parsed || !parsed.length) {
            $pv.textContent = '无效';
            $hint.textContent = '这串内容看起来不是有效的密钥或链接，请核对后再试。';
            return;
          }
          var first = parsed[0];
          /* 链接里带了发行方/账户名，而用户还没手填时，自动补上 */
          if (first.issuer && !$issuer.value.trim()) $issuer.value = first.issuer;
          if (first.name && !$name.value.trim() && first.name !== first.issuer) $name.value = first.name;
          if (first.digits && first.digits !== 6) $digits.value = String(first.digits);
          if (first.period && first.period !== 30) $period.value = String(first.period);
          var c = window.TOTP.code(first);
          $pv.textContent = c ? window.TOTP.group(c) : '——';
          $hint.textContent = parsed.length > 1
            ? ('识别出 ' + parsed.length + ' 个账户，保存后会一起添加。')
            : '密钥有效，上面是实时动态码。';
        }

        $secret.addEventListener('input', preview);
        preview();
        pvTimer = setInterval(preview, 1000);

        /* ---- 两种「扫」的共用出口：拿到二维码文本后填框、预览、提示 ---- */
        function applyScanText(text) {
          var parsed = window.TOTP.parseAny(text);
          if (!parsed || !parsed.length) {
            /* 扫到的不是密钥链接（比如扫到了别的码）。
               把原文塞进输入框，让用户自己看一眼。 */
            $secret.value = text;
            preview();
            UI.toast('读到了二维码，但内容不是两步验证密钥');
            return;
          }
          $secret.value = text;
          preview();
          UI.toast(parsed.length > 1
            ? ('识别成功，共 ' + parsed.length + ' 个账户')
            : '识别成功');
        }

        /* ---- 扫一扫：开后置摄像头对准二维码，解出自动填入。
           走 WebView 的 getUserMedia，权限链见 JsBridge.requestCamera。
           解不出来的情况取景框里一直扫就是了，✕ 随时退出。 ---- */
        var $live = UI.$('#tp-live', root);
        if ($live) {
          if (!(window.QRLive && window.QRLive.available())) {
            $live.style.display = 'none';   /* 没摄像头/老版本包：不显示免得点了没反应 */
          } else {
            $live.onclick = function () {
              if ($live._busy) return;
              $live._busy = true;
              window.QRLive.scanLive().then(function (text) {
                $live._busy = false;
                if (text) applyScanText(text);
              });
            };
          }
        }

        /* ---- 从相册选一张图（多半是网站给的二维码截图），在本地解出来，
           直接填进密钥框。全程不联网、不申请相机权限。 ---- */
        var $scan = UI.$('#tp-scan', root);
        if ($scan) {
          if (!(window.QRScan && window.QRScan.available())) {
            $scan.style.display = 'none';        /* 环境不支持就干脆不显示，免得点了没反应 */
          } else {
            $scan.onclick = function () {
              if ($scan._busy) return;
              $scan._busy = true;
              var old = $scan.textContent;
              $scan.textContent = '正在识别…';
              window.QRScan.scanFromGallery().then(function (res) {
                $scan._busy = false;
                $scan.innerHTML = old;
                if (!res) {
                  UI.toast('没认出二维码，试试图片更清晰、二维码更完整的');
                  return;
                }
                applyScanText(res.text);
              });
            };
          }
        }

        UI.$('#tp-paste', root).onclick = function () {
          var text = '';
          try {
            if (window.NativeBridge && typeof NativeBridge.getClipboard === 'function') {
              text = NativeBridge.getClipboard() || '';
            }
          } catch (e) {}
          if (!text) text = window.prompt('粘贴密钥或 otpauth 链接：') || '';
          if (!text) return;
          $secret.value = text.trim();
          preview();
        };
        /* 重新导入恢复密钥：长按被「复制」占用了，换一批走这里。
           编辑已有账户才显示这个按钮（新账户还没落库，导入没地方存）。 */
        var $import = UI.$('#tp-import', root);
        if ($import) {
          $import.onclick = function () { importRecovery(a.id); };
        }
        UI.$('#tp-help2', root).onclick = function () { P.totp.help(); };

        /* 删除/保存按钮在 sheet-foot 里，是 .sheet-body 的兄弟节点 ——
           用 onMount 传入的 root（=.sheet-body）永远查不到，返回 null，
           null.onclick 直接抛 TypeError、绑定中断，按钮就"点了没反应"。
           全项目其他弹层绑 foot 按钮用的都是 #sheet-root，这里对齐。 */
        var sheetAll = document.getElementById('sheet-root');
        if (!isNew) {
          UI.$('#tp-del', sheetAll).onclick = function () {
            UI.confirm('删除账户', '删除后这串密钥就不在本机了，需要重新从网站获取。', '删除')
              .then(function (ok) {
                if (!ok) return;
                save(load().filter(function (x) { return x.id !== a.id; }));
                close();
                onDone();
              });
          };
        }

        UI.$('#tp-save', sheetAll).onclick = function () {
          var v = $secret.value.trim();
          if (!v) { UI.toast('请填写密钥'); return; }
          var parsed = window.TOTP.parseAny(v);
          if (!parsed || !parsed.length) { UI.toast('密钥无效，请检查'); return; }

          var list = load();
          var added = 0;
          parsed.forEach(function (item) {
            var digits = parseInt($digits.value, 10) || 6;
            var period = parseInt($period.value, 10) || 30;
            var rec = normalize({
              id: parsed.length > 1 ? uid() : a.id,
              secret: item.secret,
              issuer: $issuer.value.trim() || item.issuer || '',
              name: $name.value.trim() || item.name || '',
              digits: item.digits && item.digits !== 6 ? item.digits : digits,
              period: item.period && item.period !== 30 ? item.period : period,
              algo: item.algo || 'SHA1',
              type: item.type || 'totp',
              counter: item.counter || 0,
              recovery: a.recovery || []   /* 编辑保存别把已导入的恢复密钥弄丢 */
            });
            var dup = list.some(function (x) {
              return x.secret === rec.secret && (x.issuer || '') === (rec.issuer || '')
                && (x.name || '') === (rec.name || '');
            });
            if (dup) return;
            list.push(rec);
            added++;
          });
          if (!added) { UI.toast('这个账户已经在列表里了'); return; }
          if (!save(list)) { UI.toast('保存失败，本机存储不可用'); return; }
          UI.toast(parsed.length > 1 ? ('已添加 ' + added + ' 个账户') : '已保存');
          close();
          onDone();
        };
      },
      onClose: function () { if (pvTimer) { clearInterval(pvTimer); pvTimer = null; } }
    });
  }

  /* ---------- 页面 ---------- */

  P.totp = {
    /* 不给 tab：它不是底部一级入口，是从「我的」点进来的内页，
       所以有返回按钮、不显示底部标签栏。 */
    title: '两步验证器',
    menu: function () {
      return [
        { icon: 'plus', label: '添加账户', key: 'add' },
        { icon: 'info', label: '使用说明', key: 'help' }
      ];
    },
    onMenu: function (k) {
      if (k === 'add') P.totp.addAccount();
      else if (k === 'help') P.totp.help();
    },

    addAccount: function () {
      openEditor(null, function () { window.Router.reload(); });
    },

    help: function () {
      UI.sheet({
        title: '使用说明',
        body:
          '<div class="totp-help">' +
          '<p><b>它是什么</b><br>两步验证（2FA）会在密码之外再加一道动态码，' +
          '每 30 秒变一次。这个页面就是用来生成那个码的，跟 Google Authenticator 是同一套算法。</p>' +
          '<p><b>怎么添加</b><br>在网站的安全设置里开启两步验证，会看到一个二维码，' +
          '二维码下面通常有一行「密钥」或「手动输入」的字母数字 —— 把那串复制过来粘进去就行。</p>' +
          '<p><b>要联网吗</b><br>不用。密钥存在你手机上，码是本地算出来的，飞机上、断网时照样出码。</p>' +
          '<p><b>删了会怎样</b><br>密钥只存在这台设备上，卸载或清除数据后就没了。' +
          '重要账户建议同时在网站保存一份恢复码，免得手机丢了进不去。</p>' +
          '<p><b>恢复密钥</b><br>先去 GitHub 把恢复码存成文件：网页端 Settings → ' +
          'Password and authentication → Recovery codes → 下载（得到 ' +
          'github-recovery-codes.txt，一行一条）。然后在这个页面<b>长按对应的账户</b>，' +
          '选中那个 txt 文件导入。平时账户卡片上不会显示恢复密钥；' +
          '导入后<b>长按账户</b>，会随机闪出其中一条并自动复制，' +
          '约 10 秒后自动收起、回到原样（登录验证时用哪一条都行）；' +
          '闪出时点一下那条也能再复制一次。要换一批，进「编辑账户」点' +
          '「导入恢复密钥」重新选文件，导入后整批替换。</p>' +
          '<p><b>后台也能看</b><br>App 退到后台时，通知栏会自动常驻一个实时刷新的动态码；' +
          '回到 App 里时通知会自动收起，不打扰你。没有账户时不显示。</p>' +
          '</div>',
        foot: '<button class="btn primary" data-close="1">知道了</button>'
      });
    },

    render: function (ctx, host) {
      var list = load();

      var head =
        '<div class="totp-tip">' + window.icon('shield-check', 16) +
        '<span>密钥只保存在本机，不联网、不需要登录 GitHub。</span></div>';

      if (!list.length) {
        host.innerHTML =
          '<div class="page">' + head +
          '<div class="totp-empty">' +
            '<div class="te-ico">' + window.icon('key', 40) + '</div>' +
            '<div class="te-title">还没有两步验证账户</div>' +
            '<div class="te-desc">把网站上的密钥粘进来，就能在这里看到 6 位动态码。</div>' +
            '<button class="btn primary block" id="tp-add">添加账号</button>' +
            '<button class="btn block" id="tp-help">使用说明</button>' +
          '</div></div>';
        UI.$('#tp-add', host).onclick = P.totp.addAccount;
        UI.$('#tp-help', host).onclick = P.totp.help;
        return;
      }

      var cards = list.map(function (raw) {
        var a = normalize(raw);
        var sub = subtitle(a);
        /* 恢复密钥区默认整块藏着（= 图 1 的样子）：没长按就什么都不显示，
           长按后才会临时闪出随机一条，10 秒后自动收起。 */
        var recHtml = '<div class="ti-recovery" data-rec="' + U.esc(a.id) + '" hidden>' +
            '<span class="tr-lb">恢复密钥</span></div>';
        return '<div class="totp-item" data-id="' + U.esc(a.id) + '">' +
            '<div class="ti-main">' +
              '<div class="ti-head">' +
                '<span class="ti-issuer">' + U.esc(title(a)) + '</span>' +
                '<span class="ti-ring" data-ring="' + U.esc(a.id) + '"></span>' +
              '</div>' +
              (sub ? '<div class="ti-name">' + U.esc(sub) + '</div>' : '') +
              '<div class="ti-code" data-code="' + U.esc(a.id) + '"></div>' +
              recHtml +
            '</div>' +
            '<div class="ti-actions">' +
              '<button class="ti-btn" data-copy="' + U.esc(a.id) + '" title="复制">' + window.icon('copy', 16) + '</button>' +
              '<button class="ti-btn" data-edit="' + U.esc(a.id) + '" title="编辑">' + window.icon('pencil', 16) + '</button>' +
            '</div>' +
          '</div>';
      }).join('');

      host.innerHTML =
        '<div class="page">' + head +
        '<div class="totp-list">' + cards + '</div>' +
        '<div class="totp-foot"><button class="btn block" id="tp-add">添加账户</button></div>' +
        '</div>';

      UI.$('#tp-add', host).onclick = P.totp.addAccount;

      list.forEach(function (raw) {
        var a = normalize(raw);
        var item = host.querySelector('.totp-item[data-id="' + a.id + '"]');
        if (!item) return;
        var cp = item.querySelector('[data-copy]');
        if (cp) cp.onclick = function (ev) {
          ev.stopPropagation();
          copy(window.TOTP.code(a));
        };
        var ed = item.querySelector('[data-edit]');
        if (ed) ed.onclick = function (ev) {
          ev.stopPropagation();
          openEditor(a, function () { window.Router.reload(); });
        };
        /* 恢复密钥区：闪现的那一条点一下就复制（委托到容器，
           长按后 innerHTML 重建也不用重绑） */
        var recBox = item.querySelector('[data-rec="' + a.id + '"]');
        if (recBox) {
          recBox.addEventListener('click', function (ev) {
            var btn = ev.target && ev.target.closest ? ev.target.closest('.tr-row') : null;
            if (!btn) return;
            ev.stopPropagation();
            copyCode(btn.textContent.trim());
          });
        }
        /* 长按条目：没导入过 → 上传恢复码 txt；导入过 → 随机闪现一条 + 复制 */
        bindLongPress(item, a.id);
      });

      /* ---- 每秒走一次：算码 + 画环 ---- */
      function tick() {
        var now = Date.now();
        list.forEach(function (raw) {
          var a = normalize(raw);
          paintCode(host.querySelector('[data-code="' + a.id + '"]'), window.TOTP.code(a, now));
          paintRing(host.querySelector('[data-ring="' + a.id + '"]'),
                    window.TOTP.remaining(a, now), a.period || 30);
        });
      }

      tick();
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(tick, 1000);

      /* 页面被换掉时要收掉定时器。路由不会通知页面「你被替换了」，
         所以用轻量自查：节点脱离文档就停。 */
      var guard = setInterval(function () {
        if (!document.body.contains(host)) {
          clearInterval(guard);
          if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
          clearRecTimer();
        }
      }, 2000);
    }
  };
})();
