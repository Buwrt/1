/* ============================================================
 * desktop-bridge.js — 桌面版（Tauri/Windows）原生桥
 *
 * 目的：让 Android 那套前端在 Windows 上原样跑起来。
 * 前端只认一个契约：window.NativeBridge.xxx()。Android 由 Java 实现，
 * 桌面版由本文件实现 —— 前端一行都不用改。
 *
 * 分工：
 *   · 能用 Web 平台 API 完成的 → 这里直接用 JS 做（文件选择、读文件、
 *     上传、剪贴板、偏好存储、扫码）
 *   · Web 做不到的（写磁盘、开浏览器）→ 调 Rust 命令
 *   · 签名密钥生成 → 用 node-forge 生成 PKCS12
 *
 * 加载顺序：必须在 api.js 之前（index.html 里已放在最前）。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 基础工具 ---------------- */

  var HAS_TAURI = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

  function invoke(cmd, args) {
    if (!HAS_TAURI) return Promise.reject(new Error('非桌面环境'));
    try {
      var t = window.__TAURI_INTERNALS__ || window.__TAURI__;
      var fn = (t.core && t.core.invoke) || t.invoke;
      if (typeof fn !== 'function') return Promise.reject(new Error('invoke 不可用'));
      return fn(cmd, args || {});
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function store(key, val) {
    try {
      if (arguments.length > 1) { localStorage.setItem(key, val); return true; }
      return localStorage.getItem(key);
    } catch (e) { return arguments.length > 1 ? false : null; }
  }

  var FALLBACK_VERSION = '1.2.17';   // 与 src-tauri/tauri.conf.json 的 version 保持一致
  var cachedVersion = FALLBACK_VERSION;

  function toast(msg, ms) {
    try {
      if (window.UI && typeof window.UI.toast === 'function') { window.UI.toast(msg, ms || 3000); return; }
    } catch (e) { /* ignore */ }
    try { console.log('[githup] ' + msg); } catch (e) { /* ignore */ }
  }

  function b64OfBytes(bytes) {
    var s = '', CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      s += CH[b0 >> 2];
      s += CH[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      s += (b1 === undefined) ? '=' : CH[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      s += (b2 === undefined) ? '=' : CH[b2 & 63];
    }
    return s;
  }

  function utf8Bytes(str) {
    var out = [], s = unescape(encodeURIComponent(str || ''));
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
    return out;
  }

  function concatBytes(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), p = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], p); p += parts[i].length; }
    return out;
  }

  function guessMime(name) {
    var ext = String(name || '').toLowerCase().split('.').pop();
    var m = {
      apk: 'application/vnd.android.package-archive',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
      pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
      json: 'application/json', txt: 'text/plain', md: 'text/markdown',
      html: 'text/html', css: 'text/css', js: 'text/javascript',
      mp4: 'video/mp4', mp3: 'audio/mpeg', jar: 'application/java-archive'
    };
    return m[ext] || 'application/octet-stream';
  }

  /* ---------------- 文件注册表 ----------------
   * 桌面端没有 content:// Uri，用 ghfile://<n> 作句柄，
   * 真正的 File 对象存在这里，readFileBase64 时再取出来读。 */

  var fileSeq = 0;
  var fileMap = Object.create(null);   // uri -> File
  var dirMap = Object.create(null);    // uri -> File[]

  function regFile(f, displayName) {
    var uri = 'ghfile://' + (++fileSeq);
    fileMap[uri] = f;
    return {
      name: displayName || f.name,
      size: f.size,
      mime: f.type || guessMime(f.name),
      uri: uri
    };
  }

  function fileOf(uri) {
    return fileMap[String(uri)] || null;
  }

  function readFileBytes(uri) {
    var f = fileOf(uri);
    if (!f) return Promise.reject(new Error('文件句柄已失效，请重新选择文件'));
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result || new ArrayBuffer(0))); };
      r.onerror = function () { reject(new Error('读取文件失败')); };
      r.readAsArrayBuffer(f);
    });
  }

  function readFileB64(uri, maxBytes) {
    var f = fileOf(uri);
    if (!f) return Promise.reject(new Error('文件句柄已失效，请重新选择文件'));
    return new Promise(function (resolve, reject) {
      var slice = (maxBytes && maxBytes > 0) ? f.slice(0, maxBytes) : f;
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result || '');
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      r.onerror = function () { reject(new Error('读取文件失败')); };
      r.readAsDataURL(slice);
    });
  }

  /* ---------------- 文件/文件夹选择 ---------------- */

  function openPicker(opt) {
    return new Promise(function (resolve, reject) {
      var input = document.createElement('input');
      input.type = 'file';
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      if (opt.dir) {
        input.multiple = true;
        input.webkitdirectory = true;
        try { input.directory = true; } catch (e) { /* ignore */ }
      } else {
        input.multiple = opt.multiple !== false;
        if (opt.accept && opt.accept !== '*/*') input.accept = opt.accept;
      }
      var settled = false;
      function done(fn) {
        if (settled) return;
        settled = true;
        window.removeEventListener('focus', onFocus, true);
        try { input.remove(); } catch (e) { /* ignore */ }
        fn();
      }
      // 用户在原生对话框里点了「取消」：Chromium 113+ 会发 cancel 事件，
      // 老版本只能靠窗口重新获得焦点来推断。
      function onFocus() { setTimeout(function () { done(function () { resolve(null); }); }, 300); }
      input.addEventListener('cancel', function () { done(function () { resolve(null); }); });
      input.addEventListener('change', function () {
        var list = input.files;
        if (!list || !list.length) return done(function () { resolve(null); });
        done(function () { resolve(list); });
      });
      document.body.appendChild(input);
      window.addEventListener('focus', onFocus, true);
      try { input.click(); } catch (e) { done(function () { reject(e); }); }
    });
  }

  /* ---------------- 下载 ---------------- */

  var DL_KEY = 'gh_download_history';

  function pushDownloadHistory(name, path) {
    try {
      var arr = JSON.parse(store(DL_KEY) || '[]');
      if (!Array.isArray(arr)) arr = [];
      arr.unshift({ name: name, path: path, at: Date.now() });
      store(DL_KEY, JSON.stringify(arr.slice(0, 50)));
    } catch (e) { /* ignore */ }
  }

  function saveBytes(name, bytes) {
    return invoke('save_file', { name: name, b64: b64OfBytes(bytes) }).then(function (p) {
      pushDownloadHistory(name, p);
      toast('已保存到：' + p, 6000);
      return p;
    });
  }

  function downloadToDisk(url, name) {
    toast('正在下载 ' + name + ' …');
    return fetch(url, { mode: 'cors', credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('下载失败：HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      return saveBytes(name, new Uint8Array(buf));
    }).catch(function (e) {
      toast('下载失败：' + (e && e.message ? e.message : e));
      throw e;
    });
  }

  /* ---------------- 上传 ---------------- */

  function headersToObj(h, res) {
    var out = {};
    try {
      if (h) {
        res.headers.forEach(function (v, k) { out[k] = v; });
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function finishUpload(id, r) {
    var body = '', hdrs = headersToObj(true, r);
    return r.text().then(function (t) {
      body = t;
    }).catch(function () { body = ''; }).then(function () {
      // 与 Java 侧一致：统一回灌到 window.Native._cb
      if (window.Native && typeof window.Native._cb === 'function') {
        window.Native._cb(id, r.status, body, JSON.stringify(hdrs));
      }
    });
  }

  function failUpload(id, e) {
    if (window.Native && typeof window.Native._cb === 'function') {
      window.Native._cb(id, 0, '', JSON.stringify({ error: String(e && e.message ? e.message : e) }));
    }
  }

  function doUpload(id, url, uri, headersJson, method, head, tail, maxBytes) {
    var headers = {};
    try { headers = JSON.parse(headersJson || '{}') || {}; } catch (e) { headers = {}; }
    var ctype = headers['Content-Type'] || headers['content-type'] || 'application/octet-stream';
    delete headers['Content-Type'];
    delete headers['content-type'];

    readFileBytes(uri).then(function (fileBytes) {
      if (maxBytes && fileBytes.length > maxBytes) {
        throw new Error('文件过大（' + fileBytes.length + ' 字节）');
      }
      var parts = [];
      if (head) parts.push(new Uint8Array(utf8Bytes(head)));
      parts.push(fileBytes);
      if (tail) parts.push(new Uint8Array(utf8Bytes(tail)));
      var body = concatBytes(parts);

      var init = { method: method, headers: headers, mode: 'cors', credentials: 'omit', body: body };
      // Content-Type 单独设置：某些头（如 Content-Length）浏览器不让设，逐个塞会抛错
      try {
        var h2 = {};
        for (var k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) h2[k] = headers[k];
        h2['Content-Type'] = ctype;
        init.headers = h2;
      } catch (e) { /* ignore */ }

      return fetch(url, init).then(function (r) { return finishUpload(id, r); },
        function (e) { failUpload(id, e); });
    }).catch(function (e) { failUpload(id, e); });
  }

  /* ============================================================
   * 签名密钥（PKCS12）—— 云端打包 APK 用
   *
   * Android 端用 JDK 的 KeyStore 生成 PKCS12。桌面端用 node-forge：
   * 同一串口令 → 同一把钥匙（密钥生成的随机数由口令派生）。
   * 生成结果缓存在 localStorage，第二次起秒出。
   * ============================================================ */

  var KS_CACHE_PREFIX = 'gh_ks_cache_';

  function deterministicPrng(seed) {
    var forge = window.forge;
    var counter = 0, pool = '';
    function more() {
      var md = forge.md.sha256.create();
      md.update('githup-keystore:' + seed + ':' + (counter++));
      pool += md.digest().getBytes();
    }
    function next(n) {
      while (pool.length < n) more();
      var out = pool.slice(0, n);
      pool = pool.slice(n);
      return out;
    }
    // forge 不同版本取随机数的入口不一样，三个都挂上，保证命中
    var prng = {
      generate: function (n, cb) { var o = next(n); if (cb) { cb(null, o); return undefined; } return o; },
      getBytes: function (n, cb) { var o = next(n); if (cb) { cb(null, o); return undefined; } return o; },
      getBytesSync: function (n) { return next(n); }
    };
    return prng;
  }

  function buildKeystore(seed, alias, storePass, keyPass) {
    var forge = window.forge;
    var prng = deterministicPrng(seed);

    // 证书签名那一步会去取 forge 的全局随机源，这里临时接管成同一条
    // 确定性随机流，保证「同一串口令 = 同一把钥匙」整条链路都成立。
    // 用 finally 还原，不影响页面里其它用到随机数的功能。
    var saved = {
      g: forge.random.getBytes,
      gs: forge.random.getBytesSync,
      gen: forge.random.generate
    };
    forge.random.getBytes = prng.getBytes;
    forge.random.getBytesSync = prng.getBytesSync;
    forge.random.generate = prng.generate;

    try {
      return buildKeystoreInner(forge, prng, seed, alias, storePass);
    } finally {
      forge.random.getBytes = saved.g;
      forge.random.getBytesSync = saved.gs;
      forge.random.generate = saved.gen;
    }
  }

  function buildKeystoreInner(forge, prng, seed, alias, storePass) {
    var kp = forge.pki.rsa.generateKeyPair({
      bits: 2048,
      e: 65537,
      prng: prng
    });

    var cert = forge.pki.createCertificate();
    cert.publicKey = kp.publicKey;
    // 序列号由口令派生，保证「同一串口令 = 同一张证书」
    var md = forge.md.sha256.create();
    md.update('serial:' + seed);
    cert.serialNumber = forge.util.bytesToHex(md.digest().getBytes()).slice(0, 16);
    cert.validity.notBefore = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
    cert.validity.notAfter = new Date(Date.UTC(2049, 11, 31, 23, 59, 59));

    var attrs = [
      { name: 'commonName', value: 'githup' },
      { name: 'countryName', value: 'CN' },
      { shortName: 'ST', value: 'Beijing' },
      { name: 'localityName', value: 'Beijing' },
      { name: 'organizationName', value: 'githup' },
      { shortName: 'OU', value: 'Mobile' }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(kp.privateKey, forge.md.sha256.create());

    var p12 = forge.pkcs12.toPkcs12Asn1(kp.privateKey, cert, storePass || '', {
      algorithm: '3des',
      friendlyName: alias || 'githup',
      generateLocalKeyId: true
    });
    return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
  }

  function makeKeystoreAsync(seed, alias, storePass, keyPass) {
    var cacheKey = KS_CACHE_PREFIX + (window.forge ? window.forge.md.sha256.create()
      .update(seed + '|' + alias + '|' + storePass + '|' + keyPass).digest().toHex() : String(seed).length);
    try {
      var hit = localStorage.getItem(cacheKey);
      if (hit && hit.length > 200) return Promise.resolve(hit);
    } catch (e) { /* ignore */ }

    // 纯 JS 生成 2048 位 RSA 会比较慢（通常十几到四十秒），
    // 先让浏览器把提示画出来，再开始阻塞式计算。
    toast('首次生成签名密钥，需要十几秒到几十秒，请稍候…', 30000);
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try {
          var b64 = buildKeystore(seed, alias, storePass, keyPass);
          try { localStorage.setItem(cacheKey, b64); } catch (e) { /* ignore */ }
          resolve(b64);
        } catch (e) {
          reject(e);
        }
      }, 80);
    });
  }

  /* ============================================================
   * NativeBridge 实现
   * ============================================================ */

  var clipboardCache = '';

  var Bridge = {

    /* ---------- 身份与外观 ---------- */
    appVersion: function () { return cachedVersion; },
    version: function () { return cachedVersion; },
    systemDark: function () {
      try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
      catch (e) { return false; }
    },
    safeInsets: function () { return '[0,0,0,0]'; },
    certSha256: function () { return ''; },      // 桌面包不做 APK 签名链校验
    apkSha256: function () { return ''; },
    imageProxyReady: function () { return false; },
    setStatusBar: function () { },
    haptic: function () { },
    exit: function () {
      invoke('app_exit', {}).catch(function () { try { window.close(); } catch (e) { /* ignore */ } });
    },

    /* ---------- 偏好与令牌（同步读写，落 localStorage） ---------- */
    getPref: function (k) { var v = store('gh_pref_' + k); return v === null ? '' : v; },
    setPref: function (k, v) { store('gh_pref_' + k, String(v)); },
    getToken: function () { var v = store('gh_token'); return v === null ? '' : v; },
    setToken: function (t) { store('gh_token', String(t || '')); },

    /* ---------- 剪贴板 ---------- */
    copy: function (text) {
      clipboardCache = String(text || '');
      var p = Promise.resolve();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        p = navigator.clipboard.writeText(clipboardCache).catch(function () { });
      }
      // 兜底（无 https / 无权限时）：用隐藏 textarea + execCommand
      return p.then(function () {
        try {
          var ta = document.createElement('textarea');
          ta.value = clipboardCache;
          ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy');
          ta.remove();
        } catch (e) { /* ignore */ }
      });
    },
    getClipboard: function () { return clipboardCache || ''; },

    /* ---------- 网络：走 Rust 原生通道 ---------- */
    /*
     * 为什么不直接 fetch：页面 origin 是 http://tauri.localhost，往
     * api.github.com 打要过 CSP + CORS，还受系统代理影响 —— 登录那句
     * "Failed to fetch" 就是这么来的。这里和安卓端走同一条路：
     * 交给 Rust 发，结果由 window.Native._cb 回收。
     *
     * 契约跟安卓端一模一样，所以 api.js 里 Native.has() 会判定为 true，
     * 所有请求自动走原生通道，无需改动任何调用方。
     */
    isDesktop: function () { return true; },

    http: function (id, method, url, body, headersJson) {
      invoke('http_request', {
        id: String(id),
        method: String(method || 'GET'),
        url: String(url || ''),
        body: body === null || body === undefined ? null : String(body),
        headers: String(headersJson || '{}')
      }).catch(function (e) {
        // 命令本身没跑起来（没注册 / 崩溃）时不会有 eval 回调，
        // 这里必须自己收场，否则前端那个 Promise 会永远挂起，界面一直转圈。
        if (window.Native && typeof window.Native._cb === 'function') {
          window.Native._cb(id, 502, JSON.stringify({
            message: '网络通道不可用：' + (e && e.message ? e.message : e)
          }), '{}');
        }
      });
    },

    httpB64: function (id, url, headersJson) {
      invoke('http_b64', {
        id: String(id),
        url: String(url || ''),
        headers: String(headersJson || '{}')
      }).catch(function (e) {
        if (window.Native && typeof window.Native._cb === 'function') {
          window.Native._cb(id, 502, JSON.stringify({
            message: '网络通道不可用：' + (e && e.message ? e.message : e)
          }), '{}');
        }
      });
    },

    /* ---------- 局域网同步 ---------- */
    /*
     * 由 Rust 侧 lansync.rs 实现，协议与安卓端 LanSync.java 完全一致，
     * 所以两端能互相发现、配对、同步。
     *
     * 注意这里绝大多数返回 Promise：Tauri 的 invoke 本来就是异步的，
     * 而安卓端 Java 桥是同步返回字符串。lan-sync.js 里做了两套兼容，
     * 一份代码两端通用。
     */
    lanStart: function () {
      return invoke('lan_start', {}).then(function () { return true; },
        function (e) { console.warn('[lan] 启动失败', e); return false; });
    },
    lanStop: function () { return invoke('lan_stop', {}); },
    lanStatus: function () { return invoke('lan_status', {}); },
    lanDiscover: function () { return invoke('lan_discover', {}); },
    lanPeers: function () { return invoke('lan_peers', {}); },
    lanFound: function () { return invoke('lan_found', {}); },
    lanNewPairCode: function () { return invoke('lan_new_pair_code', {}); },
    lanPairEnvelope: function () { return invoke('lan_pair_envelope', {}); },
    lanPair: function (peerId, pin) { return invoke('lan_pair', { peerId: peerId, pin: pin }); },
    lanRemovePeer: function (peerId) { return invoke('lan_remove_peer', { peerId: peerId }); },
    lanPush: function (peerId, payload) {
      return invoke('lan_push', { peerId: peerId, payload: payload });
    },
    lanPull: function (peerId) { return invoke('lan_pull', { peerId: peerId }); },
    lanApprove: function (reqId, granted) {
      return invoke('lan_approve', { reqId: reqId, granted: !!granted });
    },
    /** 回应原生的 onCollect：把本机 localStorage 数据交给它打包发出去 */
    lanSubmitCollect: function (token, payload) {
      return invoke('lan_submit_collect', { token: token, payload: payload });
    },
    lanDeviceName: function () { return invoke('lan_device_name', {}); },

    /* ---------- 打开外部 ---------- */
    openExternal: function (url) {
      invoke('open_url', { url: String(url || '') }).catch(function () { window.open(url, '_blank'); });
    },
    openInApp: function (url) {
      invoke('open_url', { url: String(url || '') }).catch(function () { window.open(url, '_blank'); });
    },
    share: function (url) { Bridge.copy(String(url || '')); },

    /* ---------- 文件选择 ---------- */
    pickFile: function (id, accept) {
      openPicker({ accept: accept, multiple: true }).then(function (list) {
        var meta = null, err = '';
        if (list) {
          meta = [];
          for (var i = 0; i < list.length; i++) meta.push(regFile(list[i]));
        }
        if (window.Native && typeof window.Native._pick === 'function') window.Native._pick(id, meta, err);
      }).catch(function (e) {
        if (window.Native && typeof window.Native._pick === 'function') {
          window.Native._pick(id, null, String(e && e.message ? e.message : e));
        }
      });
    },
    pickFolder: function (id) {
      openPicker({ dir: true }).then(function (list) {
        var meta = null;
        if (list && list.length) {
          var uri = 'ghdir://' + (++fileSeq);
          dirMap[uri] = Array.prototype.slice.call(list);
          var first = String(list[0].webkitRelativePath || list[0].name).split('/')[0];
          meta = { folder: true, name: first || 'folder', uri: uri };
        }
        if (window.Native && typeof window.Native._pick === 'function') window.Native._pick(id, meta, '');
      }).catch(function (e) {
        if (window.Native && typeof window.Native._pick === 'function') {
          window.Native._pick(id, null, String(e && e.message ? e.message : e));
        }
      });
    },
    listFolder: function (id, uri) {
      var files = dirMap[String(uri)] || [];
      var out = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var rel = String(f.webkitRelativePath || f.name).replace(/^[^/]+\//, '');
        var m = regFile(f, rel);
        m.path = rel;
        out.push(m);
      }
      setTimeout(function () {
        if (window.Native && typeof window.Native._list === 'function') window.Native._list(id, out, '');
      }, 0);
    },
    readFileBase64: function (id, uri, maxBytes) {
      readFileB64(uri, maxBytes).then(function (b64) {
        if (window.Native && typeof window.Native._read === 'function') window.Native._read(id, b64, '');
      }).catch(function (e) {
        if (window.Native && typeof window.Native._read === 'function') {
          window.Native._read(id, null, String(e && e.message ? e.message : e));
        }
      });
    },

    /* ---------- 上传 ---------- */
    uploadBinary: function (id, url, uri, headersJson) {
      doUpload(id, url, uri, headersJson, 'POST', null, null, 50 * 1024 * 1024);
    },
    uploadRaw: function (id, url, uri, headersJson) {
      doUpload(id, url, uri, headersJson, 'POST', null, null, 0);
    },
    uploadMultipart: function (id, url, uri, headersJson, head, tail) {
      doUpload(id, url, uri, headersJson, 'POST', head, tail, 50 * 1024 * 1024);
    },
    uploadMultipartB64: function (id, url, uri, headersJson, head, tail) {
      // Contents API 只认 PUT，且文件部分要编成 Base64
      var f = fileOf(uri);
      if (!f) { failUpload(id, new Error('文件句柄已失效，请重新选择文件')); return; }
      readFileB64(uri, 0).then(function (b64) {
        doUploadB64(id, url, headersJson, head, b64, tail);
      }).catch(function (e) { failUpload(id, e); });
    },

    /* ---------- 相机（扫码登录用） ---------- */
    requestCamera: function (id) {
      // WebView2 自带 getUserMedia，直接放行；页面自己会去开摄像头
      setTimeout(function () {
        if (window.Native && typeof window.Native._camera === 'function') window.Native._camera(id, true);
      }, 0);
    },

    /* ---------- 签名密钥 ---------- */
    makeKeystore: function (id, seed, alias, storePass, keyPass) {
      if (!window.forge) {
        if (window.Native && typeof window.Native._ks === 'function') window.Native._ks(id, null, '签名库未加载');
        return;
      }
      makeKeystoreAsync(String(seed || ''), alias || 'githup', storePass, keyPass).then(function (b64) {
        if (window.Native && typeof window.Native._ks === 'function') window.Native._ks(id, b64, '');
      }).catch(function (e) {
        if (window.Native && typeof window.Native._ks === 'function') {
          window.Native._ks(id, null, String(e && e.message ? e.message : e));
        }
      });
    },

    /* ---------- 下载 ---------- */
    download: function (url, name) { downloadToDisk(url, name || 'download'); },
    downloadWithHeaders: function (url, name) { downloadToDisk(url, name || 'download'); },
    downloadStatus: function () {
      try { return store(DL_KEY) || '[]'; } catch (e) { return '[]'; }
    },
    downloadHistory: function () { return Bridge.downloadStatus(); },
    saveImage: function (b64, name) {
      var bin = '';
      try { bin = atob(String(b64 || '')); } catch (e) { bin = ''; }
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
      return saveBytes(name || 'image.png', bytes).catch(function () { });
    },

    /* ---------- 日志 / 杂项 ---------- */
    saveLog: function () { },
    exportLog: function (text, name) {
      return saveBytes(name || 'githup-log.txt', new Uint8Array(utf8Bytes(String(text || '')))).catch(function () { });
    },
    shareLog: function () { },
    logNote: function () { },
    logError: function () { },
    clearCache: function () { },
    checkNotificationsNow: function () { },
    prefetchImages: function () { },
    totpSync: function () { },
    totpBackgroundEnabled: function () { return false; },
    isAppForeground: function () { return true; },
    installApkChecked: function () { return false; },
    installApk: function () { return false; },
    installApkTracked: function () { return false; },
    downloadAction: function () { },
    stopChannelProbe: function () { },
    startChannelProbe: function () { },
    getChannel: function () { return ''; },
    setChannel: function () { },
    dismissSlowAdvice: function () { },
    notifWatchEnabled: function () { return false; },
    notifWatchLastCheck: function () { return 0; },
    setNotifWatch: function () { },
    libAbi: function () { return ''; },
    libList: function () { return '[]'; },
    libSync: function () { },
    libOpen: function () { return false; },
    libUninstall: function () { return false; },
    fetchRunLogs: function () { return ''; }
  };

  function doUploadB64(id, url, headersJson, head, b64, tail) {
    var headers = {};
    try { headers = JSON.parse(headersJson || '{}') || {}; } catch (e) { headers = {}; }
    var ctype = headers['Content-Type'] || headers['content-type'] || 'application/json';
    delete headers['Content-Type'];
    delete headers['content-type'];
    headers['Content-Type'] = ctype;
    var body = String(head || '') + b64 + String(tail || '');
    fetch(url, { method: 'PUT', headers: headers, mode: 'cors', credentials: 'omit', body: body })
      .then(function (r) { return finishUpload(id, r); }, function (e) { failUpload(id, e); })
      .catch(function (e) { failUpload(id, e); });
  }

  window.NativeBridge = Bridge;
  window.GithupDesktop = {
    isDesktop: HAS_TAURI,
    hasForge: !!window.forge,
    clearKeystoreCache: function () {
      try {
        var kill = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(KS_CACHE_PREFIX) === 0) kill.push(k);
        }
        for (var j = 0; j < kill.length; j++) localStorage.removeItem(kill[j]);
        return kill.length;
      } catch (e) { return 0; }
    }
  };

  // 版本号以 Rust 侧的 Cargo.toml 为准（异步取，取不到用内置兜底值）
  invoke('app_version', {}).then(function (v) {
    if (v) cachedVersion = String(v);
  }).catch(function () { /* ignore */ });

  // 剪贴板内容异步预热，让 getClipboard 的同步读取有值可用
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (t) { clipboardCache = t || ''; }).catch(function () { });
    }
  } catch (e) { /* ignore */ }
})();
