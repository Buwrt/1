/* ============================================================
 * api.js — 网络通道 + GitHub REST API 封装
 * 在 Android WebView 中通过 NativeBridge 发起请求（无跨域限制，
 * 由原生层统一附加 Authorization）；浏览器中自动降级为 fetch。
 * ============================================================ */
(function () {
  'use strict';

  // 允许通过 window.__GH_API_BASE__ 覆盖（仅用于本地调试/测试）
  var API_BASE = window.__GH_API_BASE__ || 'https://api.github.com';
  var ACCEPT = 'application/vnd.github+json';
  var X_VERSION = '2022-11-28';

  /* ---------- 原生桥 ---------- */
  var Native = {
    has: function () { return !!(window.NativeBridge && typeof window.NativeBridge.http === 'function'); },
    TIMEOUT: 30000,   // 30 秒没回音就判失败，别让界面一直等
    pending: Object.create(null),
    seq: 1,
    http: function (method, url, body, headers) {
      var self = this;
      if (!this.has()) return Promise.reject(new Error('no bridge'));
      return new Promise(function (resolve, reject) {
        var id = 'r' + (self.seq++);
        // 原生层若因异常没有回调，这里必须自己收场，否则这个 Promise
        // 会永远挂起，调用方既不成功也不失败，界面就卡在转圈。
        var timer = setTimeout(function () {
          if (self.pending[id]) {
            delete self.pending[id];
            reject(new Error('请求超时'));
          }
        }, self.TIMEOUT);
        self.pending[id] = {
          resolve: function (v) { clearTimeout(timer); resolve(v); },
          reject: function (e) { clearTimeout(timer); reject(e); }
        };
        try {
          window.NativeBridge.http(id, method, url, body || null, JSON.stringify(headers || {}));
        } catch (e) {
          clearTimeout(timer);
          delete self.pending[id];
          reject(e);
        }
      });
    },
    // 由原生层回调
    _cb: function (id, status, body, headers) {
      var p = this.pending[id];
      if (!p) return;
      delete this.pending[id];
      var res = { status: status, body: body, headers: {} };
      try { res.headers = JSON.parse(headers || '{}'); } catch (e) { res.headers = {}; }
      p.resolve(res);
    },

    /* ============================================================
     * 大响应的分片接收
     *
     * 原生那边用 evaluateJavascript 把 base64 回传，而它底层是 Binder IPC，
     * 单次事务上限约 1MB。README 里一张 417KB 的赞赏码，base64 后 556KB 字符，
     * 几张图并发就轻松顶穿上限 —— 表现得很像是「图片加载不出来」，其实是
     * 传回来的那一大坨根本没落地。
     *
     * 所以超过阈值的响应由原生切成小片下发：_begin 先登记份数，_chunk 逐片塞，
     * 拼齐了再原样交给 _cb。这样上层（md.js 的图片通道）完全不用感知。
     * ============================================================ */
    bigParts: Object.create(null),
    _begin: function (id, status, n, headers) {
      this.bigParts[id] = {
        status: status, n: n | 0, headers: headers,
        parts: new Array(n | 0), got: 0
      };
    },
    _chunk: function (id, i, s) {
      var b = this.bigParts[id];
      if (!b || i < 0 || i >= b.n || b.parts[i] !== undefined) return;   // 重复片直接丢
      b.parts[i] = s || '';
      b.got++;
      if (b.got < b.n) return;
      var body = b.parts.join('');
      delete this.bigParts[id];
      this._cb(id, b.status, body, b.headers);   // 拼齐后才算这一次请求完成
    },
    /**
     * 以 Base64 拉取二进制资源（README 图片等），走原生网络栈。
     *
     * WebView 直连 raw.githubusercontent.com 在不少网络下不通，图片全裂；
     * 而仓库列表能正常加载 —— 因为走的是原生通道。图片也走同一条路，
     * 拉回来转 data URI。图片大、网络慢，超时放宽到 60 秒。
     */
    httpB64: function (url, headers) {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.httpB64 === 'function'))
        return Promise.reject(new Error('no bridge'));
      return new Promise(function (resolve, reject) {
        var id = 'b' + (self.seq++);
        var timer = setTimeout(function () {
          if (self.pending[id]) {
            delete self.pending[id];
            reject(new Error('请求超时'));
          }
        }, 60000);
        self.pending[id] = {
          resolve: function (v) { clearTimeout(timer); resolve(v); },
          reject: function (e) { clearTimeout(timer); reject(e); }
        };
        try {
          window.NativeBridge.httpB64(id, url, JSON.stringify(headers || {}));
        } catch (e) {
          clearTimeout(timer);
          delete self.pending[id];
          reject(e);
        }
      });
    },
    /**
     * 读取令牌。
     *
     * 只从原生加密存储读，**绝不留 localStorage 明文兜底** ——
     * WebView 的 localStorage 是明文文件，root 设备或 adb backup 都能直接读走。
     * 令牌等于仓库写权限，泄露出去别人就能改你的代码、删你的 Release。
     *
     * 没有原生桥（浏览器里跑着玩）时返回空，也就是「未登录」，
     * 这是有意的：宁可不能用，也不把令牌写在明文里。
     */
    getToken: function () {
      if (window.NativeBridge && typeof window.NativeBridge.getToken === 'function') {
        try { return window.NativeBridge.getToken() || ''; } catch (e) { return ''; }
      }
      return '';
    },
    /** 写入令牌：只交给原生加密存储，不落任何明文 */
    setToken: function (t) {
      if (window.NativeBridge && typeof window.NativeBridge.setToken === 'function') {
        try { window.NativeBridge.setToken(t || ''); } catch (e) {}
      }
    },
    /** 在应用内置浏览器中打开（原生 WebView Activity）；无原生环境时降级为系统浏览器/新标签 */
    openInApp: function (url, title) {
      if (window.NativeBridge && typeof window.NativeBridge.openInApp === 'function') {
        try { window.NativeBridge.openInApp(url, title || ''); return; } catch (e) {}
      }
      if (window.NativeBridge && typeof window.NativeBridge.openExternal === 'function') {
        try { window.NativeBridge.openExternal(url); return; } catch (e) {}
      }
      window.open(url, '_blank');
    },

    /* ---------------- 文件能力（上传用） ---------------- */
    _pickCbs: Object.create(null),
    _readCbs: Object.create(null),
    _ksCbs: Object.create(null),

    /** 是否有原生文件选择能力 */
    canPick: function () {
      return !!(window.NativeBridge && typeof window.NativeBridge.pickFile === 'function');
    },

    /**
     * 打开文件选择器。
     * @param {string} accept MIME 类型，可以是 'image/*' 或 'image/*,video/*'
     * @returns {Promise<{name,size,mime,uri}|null>}
     *          用户取消时 resolve(null)。
     *          注意：原生侧现在支持多选，单个文件也会包成数组回来，
     *          这里统一摊平成单个对象，老调用方（如选 APK）不用改。
     */
    pickFile: function (accept) {
      var self = this;
      if (!this.canPick()) return Promise.reject(new Error('当前环境不支持选择文件'));
      return new Promise(function (resolve, reject) {
        var id = 'p' + (self.seq++);
        var timer = setTimeout(function () {
          delete self._pickCbs[id];
          reject(new Error('选择文件超时'));
        }, 180000);
        self._pickCbs[id] = function (meta, err) {
          clearTimeout(timer);
          if (err) reject(new Error(err));
          else if (Array.isArray(meta)) resolve(meta[0] || null);
          else resolve(meta);
        };
        try {
          window.NativeBridge.pickFile(id, accept || '*/*');
        } catch (e) {
          clearTimeout(timer);
          delete self._pickCbs[id];
          reject(e);
        }
      });
    },

    /**
     * 打开文件选择器并返回**全部**选中项（支持多选）。
     * @returns {Promise<Array<{name,size,mime,uri}>>} 取消时 resolve([])
     */
    pickFiles: function (accept) {
      var self = this;
      if (!this.canPick()) return Promise.reject(new Error('当前环境不支持选择文件'));
      if (!(window.NativeBridge && typeof window.NativeBridge.pickFile === 'function')) {
        return Promise.reject(new Error('当前环境不支持选择文件'));
      }
      return new Promise(function (resolve, reject) {
        var id = 'p' + (self.seq++);
        var timer = setTimeout(function () {
          delete self._pickCbs[id];
          reject(new Error('选择文件超时'));
        }, 180000);
        self._pickCbs[id] = function (meta, err) {
          clearTimeout(timer);
          if (err) reject(new Error(err));
          else if (Array.isArray(meta)) resolve(meta);
          else resolve(meta ? [meta] : []);
        };
        try {
          window.NativeBridge.pickFile(id, accept || '*/*');
        } catch (e) {
          clearTimeout(timer);
          delete self._pickCbs[id];
          reject(e);
        }
      });
    },
    _pick: function (id, meta, err) {
      var cb = this._pickCbs[id];
      if (!cb) return;
      delete this._pickCbs[id];
      cb(meta, err);
    },

    /**
     * 选择一个**文件夹**（对齐官网「拖文件夹上传」）。
     * @returns {Promise<{folder:true, name, uri}>} 用户取消时 resolve(null)
     */
    pickFolder: function () {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.pickFolder === 'function')) {
        return Promise.reject(new Error('当前环境不支持选择文件夹'));
      }
      return new Promise(function (resolve, reject) {
        var id = 'd' + (self.seq++);
        var timer = setTimeout(function () {
          delete self._pickCbs[id];
          reject(new Error('选择文件夹超时'));
        }, 180000);
        self._pickCbs[id] = function (meta, err) {
          clearTimeout(timer);
          if (err) reject(new Error(err));
          else resolve(meta || null);
        };
        try {
          window.NativeBridge.pickFolder(id);
        } catch (e) {
          clearTimeout(timer);
          delete self._pickCbs[id];
          reject(e);
        }
      });
    },

    _listCbs: Object.create(null),
    /**
     * 展开已授权的目录树，返回全部文件（含子目录，保留相对路径）。
     * @returns {Promise<Array<{name,path,size,mime,uri}>>} path 是相对
     *          所选目录的路径 —— 上传时它就是 GitHub 仓库里的路径
     */
    listFolder: function (treeUri) {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.listFolder === 'function')) {
        return Promise.reject(new Error('当前环境不支持读取文件夹'));
      }
      return new Promise(function (resolve, reject) {
        var id = 't' + (self.seq++);
        self._listCbs[id] = function (files, err) {
          if (err) reject(new Error(err));
          else resolve(files || []);
        };
        try {
          window.NativeBridge.listFolder(id, treeUri);
        } catch (e) {
          delete self._listCbs[id];
          reject(e);
        }
      });
    },
    // 由原生层回调（目录展开）
    _list: function (id, files, err) {
      var cb = this._listCbs[id];
      if (!cb) return;
      delete this._listCbs[id];
      cb(files, err);
    },

    /** 读取文件的 Base64 内容（用于仓库文件上传）。 */
    readFileBase64: function (uri, maxBytes) {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.readFileBase64 === 'function')) {
        return Promise.reject(new Error('当前环境不支持读取文件'));
      }
      return new Promise(function (resolve, reject) {
        var id = 'f' + (self.seq++);
        self._readCbs[id] = function (b64, err) {
          if (err) reject(new Error(err)); else resolve(b64);
        };
        try {
          window.NativeBridge.readFileBase64(id, uri, maxBytes || 0);
        } catch (e) {
          delete self._readCbs[id];
          reject(e);
        }
      });
    },
    _read: function (id, b64, err) {
      var cb = this._readCbs[id];
      if (!cb) return;
      delete this._readCbs[id];
      cb(b64, err);
    },

    _camCbs: Object.create(null),
    /**
     * 扫一扫用：确认相机权限。
     * resolve(true) = 已授权，可以 getUserMedia 开摄像头了；
     * resolve(false) = 没桥（浏览器 / 老版本包）或用户拒绝了。
     */
    requestCamera: function () {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.requestCamera === 'function')) {
        return Promise.resolve(false);
      }
      return new Promise(function (resolve) {
        var id = 'c' + (self.seq++);
        self._camCbs[id] = resolve;
        try {
          window.NativeBridge.requestCamera(id);
        } catch (e) {
          delete self._camCbs[id];
          resolve(false);
        }
      });
    },
    _camera: function (id, granted) {
      var cb = this._camCbs[id];
      if (!cb) return;
      delete this._camCbs[id];
      cb(granted === true);
    },

    /**
     * 在应用内生成签名密钥。
     * 输入一串英文字母和数字（口令），直接得到可用于签名的 keystore（Base64）。
     * 同一串口令永远得到同一把钥匙 —— 这就是「使用同一个签名」的实现方式。
     */
    makeKeystore: function (seed, alias, pass) {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.makeKeystore === 'function')) {
        return Promise.reject(new Error('当前版本不支持在应用内生成签名'));
      }
      return new Promise(function (resolve, reject) {
        var id = 'k' + (self.seq++);
        var timer = setTimeout(function () {
          delete self._ksCbs[id];
          reject(new Error('生成签名超时，请重试'));
        }, 120000);
        self._ksCbs[id] = function (b64, err) {
          clearTimeout(timer);
          if (err) reject(new Error(err)); else resolve(b64);
        };
        try {
          window.NativeBridge.makeKeystore(id, seed, alias || 'githup', pass, pass);
        } catch (e) {
          clearTimeout(timer);
          delete self._ksCbs[id];
          reject(e);
        }
      });
    },
    _ks: function (id, b64, err) {
      var cb = this._ksCbs[id];
      if (!cb) return;
      delete this._ksCbs[id];
      cb(b64, err);
    },

    /**
     * 二进制上传到指定 URL（Release 附件用）。
     * 走原生读取与发送，避免 JS 侧承载大文件。
     */
    uploadBinary: function (url, uri, headers) {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.uploadBinary === 'function')) {
        return Promise.reject(new Error('当前环境不支持二进制上传'));
      }
      return new Promise(function (resolve, reject) {
        var id = 'u' + (self.seq++);
        self.pending[id] = { resolve: resolve, reject: reject };
        try {
          window.NativeBridge.uploadBinary(id, url, uri, JSON.stringify(headers || {}));
        } catch (e) {
          delete self.pending[id];
          reject(e);
        }
      });
    },

    /**
     * multipart 上传（图片 / 视频附件用）。
     * 头尾在 JS 侧拼好，文件由原生流式读取发送 —— 大文件不会进 JS 内存。
     *
     * @param head 文件之前的内容（含末尾空行）
     * @param tail 文件之后的内容（含结束边界）
     */
    uploadMultipart: function (url, uri, headers, head, tail) {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.uploadMultipart === 'function')) {
        return Promise.reject(new Error('当前环境不支持附件上传'));
      }
      return new Promise(function (resolve, reject) {
        var id = 'm' + (self.seq++);
        // 文件可能很大、网络可能很慢，2 分钟还没回音才算失败
        var timer = setTimeout(function () {
          if (self.pending[id]) { delete self.pending[id]; reject(new Error('上传超时')); }
        }, 120000);
        self.pending[id] = {
          resolve: function (v) { clearTimeout(timer); resolve(v); },
          reject: function (e) { clearTimeout(timer); reject(e); }
        };
        try {
          window.NativeBridge.uploadMultipart(id, url, uri,
            JSON.stringify(headers || {}), head, tail);
        } catch (e) {
          clearTimeout(timer);
          delete self.pending[id];
          reject(e);
        }
      });
    },

    /**
     * 流式上传「JSON 里嵌 Base64 文件」—— 仓库文件上传（Contents API）专用。
     *
     * 为什么不让前端先 readFileBase64 再拼 JSON：25MB 的文件编成 Base64
     * 就是 33MB 的巨型字符串，evaluateJavascript 与 JS 拼接的每一步都在
     * 撑爆内存 —— 中低端机「一上传就闪退」的真身。现在文件内容由原生
     * 边读边编、直接进网络，前端只交 uri 和 JSON 的头尾两段。
     *
     * @param {string} head JSON 前半段，到 content 的左引号为止，
     *                      如 '{"message":"Add file","content":"'
     * @param {string} tail  Base64 之后的 JSON 余下部分（从右引号开始），
     *                      如 '","branch":"main"}'
     */
    uploadMultipartB64: function (url, uri, headers, head, tail) {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.uploadMultipartB64 === 'function')) {
        return Promise.reject(new Error('当前环境不支持文件上传'));
      }
      return new Promise(function (resolve, reject) {
        var id = 'b' + (self.seq++);
        var timer = setTimeout(function () {
          if (self.pending[id]) { delete self.pending[id]; reject(new Error('上传超时')); }
        }, 180000);
        self.pending[id] = {
          resolve: function (v) { clearTimeout(timer); resolve(v); },
          reject: function (e) { clearTimeout(timer); reject(e); }
        };
        try {
          window.NativeBridge.uploadMultipartB64(id, url, uri,
            JSON.stringify(headers || {}), head, tail);
        } catch (e) {
          clearTimeout(timer);
          delete self.pending[id];
          reject(e);
        }
      });
    },

    /**
     * 裸体二进制上传：请求体就是文件本身（不带 multipart 包装）。
     *
     * GitHub 的附件直传端点 POST /user-attachments/assets 要的就是这种
     * 「Content-Type 是文件 mime、body 是原始字节」的请求 —— 老的三步
     * 「取策略 + 传 S3」已经用不上了，而且比这慢一倍。
     *
     * 同样走原生流式发送：文件边读边发，不会整个进内存。
     */
    uploadRaw: function (url, uri, headers) {
      var self = this;
      if (!(window.NativeBridge && typeof window.NativeBridge.uploadRaw === 'function')) {
        return Promise.reject(new Error('当前环境不支持附件上传'));
      }
      return new Promise(function (resolve, reject) {
        var id = 'w' + (self.seq++);
        var timer = setTimeout(function () {
          if (self.pending[id]) { delete self.pending[id]; reject(new Error('上传超时')); }
        }, 120000);
        self.pending[id] = {
          resolve: function (v) { clearTimeout(timer); resolve(v); },
          reject: function (e) { clearTimeout(timer); reject(e); }
        };
        try {
          window.NativeBridge.uploadRaw(id, url, uri, JSON.stringify(headers || {}));
        } catch (e) {
          clearTimeout(timer);
          delete self.pending[id];
          reject(e);
        }
      });
    },

    /**
     * 下载文件到系统下载目录。
     * 带 Authorization 的下载（Release 资产、Actions 构建产物）必须用这个方法，
     * 否则 GitHub 会返回 403。无认证需求时 headers 传 null 即可。
     * @param category 下载分类（子目录）：议题 / release；不传则放 githup/ 根
     */
    download: function (url, filename, headers, category) {
      var NB = window.NativeBridge;
      if (!(NB && typeof NB.downloadWithHeaders === 'function')) {
        // 降级：无原生能力时用浏览器打开
        window.open(url, '_blank');
        return false;
      }
      if (category) {
        NB.downloadWithHeaders(url, filename || 'download',
          headers ? JSON.stringify(headers) : null, category);
      } else {
        NB.downloadWithHeaders(url, filename || 'download',
          headers ? JSON.stringify(headers) : null);
      }
      return true;
    },

    /**
     * 保存图片到系统相册（Pictures/githup/）。
     * 与 download 的区别：download 落到 Download/githup/ 是文件，
     * saveImage 落到相册，系统相册/微信/QQ 选图能直接看到。
     * 原生会自动带 GitHub token 下载私有仓库图片。
     */
    saveImage: function (url) {
      var NB = window.NativeBridge;
      if (!(NB && typeof NB.saveImage === 'function')) {
        if (window.UI && window.UI.toast) window.UI.toast('当前版本不支持保存图片');
        return false;
      }
      NB.saveImage(url);
      return true;
    },

    /**
     * 下载构建产物并自动解压出 APK 安装。
     * 官网只提供 ZIP 下载，解压与安装要用户自己在手机上完成；这里一步到位。
     * 低版本原生没有该方法时，退回普通下载，不会点不出反应。
     * @param category 下载分类子目录
     */
    installApk: function (url, filename, headers, category) {
      var NB = window.NativeBridge;
      if (!(NB && typeof NB.installApk === 'function')) {
        return this.download(url, filename, headers, category);
      }
      if (category) {
        NB.installApk(url, filename || 'artifact.zip',
          headers ? JSON.stringify(headers) : null, category);
      } else {
        NB.installApk(url, filename || 'artifact.zip',
          headers ? JSON.stringify(headers) : null);
      }
      return true;
    },

    /** GitHub 下载用的认证头（未登录时返回 null） */
    authHeaders: function () {
      var t = this.getToken();
      if (!t) return null;
      return {
        Authorization: 'Bearer ' + t,
        Accept: '*/*',
        'X-GitHub-Api-Version': '2022-11-28'
      };
    },

    /**
     * 应用版本号（原生 BuildConfig.VERSION_NAME）；拿不到原生环境时用内置常量。
     * 读不到具体值时宁可返回空串，也不要编一个 0.0.0 —— 假版本号会被
     * 更新检测当成「大版本升级」而弹强制更新。
     */
    APP_VERSION: '1.2.15',
    appVersion: function () {
      try {
        if (window.NativeBridge && typeof window.NativeBridge.appVersion === 'function') {
          var v = window.NativeBridge.appVersion();
          if (v) return String(v).trim();
        }
      } catch (e) {}
      return this.APP_VERSION;
    },
    /**
     * 本机安装包的 SHA-256（原生层直接读 APK 文件算出来的）。
     * 版本号不变但内容换了时，靠它才能发现「包其实不一样」。
     * 读不到返回空串 —— 此时前端跳过指纹比对。
     */
    apkSha256: function () {
      try {
        if (window.NativeBridge && typeof window.NativeBridge.apkSha256 === 'function') {
          return String(window.NativeBridge.apkSha256() || '').trim().toLowerCase();
        }
      } catch (e) {}
      return '';
    },

    /**
     * 上报一条错误到「错误日志」（供「关于 → 下载错误日志」收集）。
     *
     * 用大白话写 what —— 这份日志是给普通用户看的。
     * 例：API.logError('翻译引擎全部不可用', '试了 5 个引擎都没响应');
     * 桥不可用时静默丢弃，绝不影响主流程。
     */
    logError: function (what, why) {
      try {
        if (window.NativeBridge && typeof window.NativeBridge.logError === 'function') {
          window.NativeBridge.logError(String(what || ''), why == null ? '' : String(why));
          return true;
        }
      } catch (e) {}
      return false;
    },

    /** 上报一条关键操作（不是错误，用来还原「当时在干什么」） */
    logNote: function (what) {
      try {
        if (window.NativeBridge && typeof window.NativeBridge.logNote === 'function') {
          window.NativeBridge.logNote(String(what || ''));
          return true;
        }
      } catch (e) {}
      return false;
    },

    /**
     * 导出今天的错误日志。
     * 完全静默：原生侧直接写进 Download/githup/错误日志/，不弹任何提示。
     * 返回 false 表示当前版本不支持（旧版原生）。
     */
    /**
     * 「保存到本地」：把今天的错误日志写进 Download/githup/错误日志/。
     * 结果通过 Native.onLogSaved(cbId, ok) 回执（原生在主线程调回来）。
     */
    saveLog: function (cb) {
      try {
        if (window.NativeBridge && typeof window.NativeBridge.saveLog === 'function') {
          var id = 'logs' + Date.now() + Math.random().toString(36).slice(2, 7);
          window.Native._logSaved = window.Native._logSaved || {};
          window.Native._logSaved[id] = cb || null;
          window.NativeBridge.saveLog(id);
          return true;
        }
      } catch (e) {}
      // 桥不可用：退到旧的静默导出（若有）
      try {
        if (window.NativeBridge && typeof window.NativeBridge.exportLog === 'function') {
          window.NativeBridge.exportLog();
          return true;
        }
      } catch (e2) {}
      return false;
    },

    /** 「分享」：弹出系统分享面板，把今天的错误日志发出去 */
    shareLog: function () {
      try {
        if (window.NativeBridge && typeof window.NativeBridge.shareLog === 'function') {
          window.NativeBridge.shareLog();
          return true;
        }
      } catch (e) {}
      return false;
    },

    /** 原生「保存完成」回执入口（由 JsBridge 调回） */
    onLogSaved: function (cbId, ok) {
      try {
        var m = window.Native._logSaved || {};
        var cb = m[cbId];
        delete m[cbId];
        if (typeof cb === 'function') cb(!!ok);
      } catch (e) {}
    },

    /**
     * 兼容旧调用：既保存又分享（当前界面已不用）。
     */
    exportLog: function () {
      try {
        if (window.NativeBridge && typeof window.NativeBridge.exportLog === 'function') {
          window.NativeBridge.exportLog();
          return true;
        }
      } catch (e) {}
      return false;
    }
  };
  window.Native = Native;

  /* ---------- 设置 / 本地存储 ---------- */
  var SETTINGS_KEY = 'gh_settings';
  var defaults = {
    theme: 'auto',            // auto | light | dark
    density: 'comfortable',
    codeFont: 13,
    /* 代码是否自动换行（预览与编辑器共用）。默认**打开** —— 手机屏窄，
       不换行就只能横向拖动，长行很别扭。 */
    codeWrap: true,
    startTab: 'home',
    markdownZoom: false,
    lastUser: '',
    /* iOS风格（设置里那枚开关，改的是底栏）。默认**打开** —— 与 App.NAV_GLASS_DEFAULT 保持一致。
       写成 true 而不是 '1'：Store 里存的是 JSON，布尔值原样往返，
       读回来还是布尔，不用在判断处做字符串兼容。 */
    navGlass: true
  };
  var Store = {
    settings: null,
    load: function () {
      if (this.settings) return this.settings;
      var s = {};
      for (var k in defaults) s[k] = defaults[k];
      var raw = null;
      if (window.NativeBridge && typeof window.NativeBridge.getPref === 'function') {
        try { raw = window.NativeBridge.getPref(SETTINGS_KEY); } catch (e) {}
      }
      if (!raw) { try { raw = localStorage.getItem(SETTINGS_KEY); } catch (e) {} }
      if (raw) { try { var o = JSON.parse(raw); for (var j in o) s[j] = o[j]; } catch (e) {} }
      this.settings = s;
      return s;
    },
    get: function (k) { return this.load()[k]; },
    set: function (k, v) {
      var s = this.load(); s[k] = v;
      var raw = JSON.stringify(s);
      if (window.NativeBridge && typeof window.NativeBridge.setPref === 'function') {
        try { window.NativeBridge.setPref(SETTINGS_KEY, raw); } catch (e) {}
      }
      try { localStorage.setItem(SETTINGS_KEY, raw); } catch (e) {}
      return v;
    },
    // 通用缓存（历史记录等）
    getJSON: function (k, def) {
      var raw = null;
      if (window.NativeBridge && typeof window.NativeBridge.getPref === 'function') {
        try { raw = window.NativeBridge.getPref(k); } catch (e) {}
      }
      if (!raw) { try { raw = localStorage.getItem(k); } catch (e) {} }
      if (!raw) return def;
      try { return JSON.parse(raw); } catch (e) { return def; }
    },
    setJSON: function (k, v) {
      var raw = JSON.stringify(v);
      if (window.NativeBridge && typeof window.NativeBridge.setPref === 'function') {
        try { window.NativeBridge.setPref(k, raw); } catch (e) {}
      }
      try { localStorage.setItem(k, raw); } catch (e) {}
    }
  };
  window.Store = Store;

  /* ---------- 会话 ----------
   * 两个独立概念：
   *  - token       当前会话令牌，参与请求鉴权；退出登录时清空
   *  - savedToken  记住的令牌，供登录页回填；只有「忘记此令牌」才清除
   *
   * 两个都只存在原生加密存储里（AndroidKeyStore + AES），不再往
   * localStorage 抄明文 —— 之前抄了一份，配合 allowBackup 能被导出，
   * 等于把仓库写权限放在明面上。
   */
  var Session = {
    token: '',
    user: null,
    savedToken: '',
    init: function () {
      var t = Native.getToken();
      this.token = t;
      this.savedToken = t || '';
      return this.token;
    },
    setToken: function (t) {
      this.token = t || '';
      this.user = null;
      Native.setToken(this.token);
      if (this.token) this.savedToken = this.token;
    },
    /** 退出登录：只清当前会话，记住的令牌保留，供下次一键回填 */
    clear: function () {
      this.token = '';
      this.user = null;
      Native.setToken('');
    },
    /** 彻底忘记令牌（用户主动清除时调用） */
    forget: function () {
      this.token = '';
      this.user = null;
      this.savedToken = '';
      Native.setToken('');
    },
    get isLogin() { return !!this.token; }
  };
  window.Session = Session;

  /* ---------- HTTP ---------- */
  function buildUrl(path, params) {
    var url = /^https?:/.test(path) ? path : API_BASE + path;
    if (params) {
      var q = [];
      for (var k in params) {
        var v = params[k];
        if (v === undefined || v === null || v === '') continue;
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
      if (q.length) url += (url.indexOf('?') >= 0 ? '&' : '?') + q.join('&');
    }
    return url;
  }

  function parseLink(header) {
    var out = {};
    if (!header) return out;
    header.split(',').forEach(function (part) {
      var m = part.match(/<([^>]+)>;\s*rel="?(\w+)"?/);
      if (m) out[m[2]] = m[1];
    });
    return out;
  }

  function parseJSON(res) {
    if (!res.body) return null;
    try { return JSON.parse(res.body); } catch (e) { return null; }
  }

  /*
   * 响应体解不出来时的兜底。
   *
   * 正常响应一定带体（204/205/304 除外）。解出来是 null，说明网络层把 body 弄丢了
   * 或者返回了非 JSON —— 这是故障，不是「结果就是空」。
   *
   * 以前直接把 null 当 data 交出去，页面那边 `r.data.login` 就抛
   * "Cannot read properties of null"，整页白屏只剩一句报错。同一类崩
   * 在首页、我的页各发生过一次。与其在每个调用点各写一遍防御，不如在这里
   * 直接当成请求失败抛出去 —— 让各页已有的 .catch() 去展示错误，语义也对。
   */
  function emptyBodyError(res) {
    var e = new Error('响应内容读取失败');
    e.status = res.status || 0;
    e.emptyBody = true;
    return e;
  }

  function makeError(res, data) {
    var msg = (data && data.message) || ('HTTP ' + res.status);
    var e = new Error(msg);
    e.status = res.status;
    e.data = data;
    e.rateLimited = res.status === 403 && (!data || /rate limit/i.test(msg) || (res.headers && res.headers['x-ratelimit-remaining'] === '0'));
    if (res.status === 401) e.unauthorized = true;
    if (res.status === 404) e.notFound = true;
    return e;
  }

  var cache = Object.create(null);
  var inflight = Object.create(null);

  /* 搜索接口的响应缓存时间。
   *
   * 搜索是「先算再答」，服务端本来就慢，而用户来回切「仓库/用户/议题」
   * 这几个页签时问的其实是同一批数据 —— 之前一次都不缓存，每切一次
   * 就重打一遍接口，体感就是「一直在转圈」。给 5 分钟缓存后，
   * 同一关键词下的切换是瞬时的。 */
  function isSearchPath(p) {
    return typeof p === 'string' && p.indexOf('/search/') >= 0;
  }
  var SEARCH_CACHE_MS = 5 * 60 * 1000;

  function req(method, path, opts) {
    opts = opts || {};
    var url = buildUrl(path, opts.params);
    var headers = {
      'Accept': opts.accept || ACCEPT,
      'X-GitHub-Api-Version': X_VERSION,
      'User-Agent': 'githup/1.0'
    };
    if (Session.token && !opts.anonymous) headers['Authorization'] = 'Bearer ' + Session.token;
    if (opts.headers) for (var h in opts.headers) headers[h] = opts.headers[h];

    var body = null;
    if (opts.body !== undefined && opts.body !== null) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }

    var isGet = method === 'GET';
    var ckey = method + ' ' + url;
    // 搜索路径没显式给 cache 时，套用默认的 5 分钟
    if (isGet && !opts.cache && isSearchPath(path)) opts.cache = SEARCH_CACHE_MS;
    if (isGet && opts.cache && cache[ckey] && Date.now() - cache[ckey].t < (opts.cache || 30000)) {
      return Promise.resolve(cache[ckey].v);
    }
    if (isGet && inflight[ckey] && opts.dedupe !== false) return inflight[ckey];

    var p;
    if (Native.has()) {
      p = Native.http(method, url, body, headers).then(function (res) {
        var data = parseJSON(res);
        if (res.status >= 400) throw makeError(res, data);
        // 204/205/304 本来就无体；其余情况解不出内容按故障处理，别把 null 往下传
        // （205 Reset Content：GitHub 单条「标已读」PATCH /notifications/threads/{id}
        //  的成功返回码；「标 Done」的 DELETE 是 204。205 不进白名单的话，
        //  标已读会被误抛「响应内容读取失败」——在静默 catch 下表现为「打开了还是未读」。）
        if (data === null && res.status !== 204 && res.status !== 205 && res.status !== 304) throw emptyBodyError(res);
        var out = { data: data, status: res.status, link: parseLink(res.headers.link || res.headers.Link), headers: res.headers };
        if (isGet && opts.cache) cache[ckey] = { t: Date.now(), v: out };
        return out;
      });
    } else {
      var init = { method: method, headers: headers, mode: 'cors', credentials: 'omit' };
      if (body) init.body = body;
      p = fetch(url, init).then(function (r) {
        return r.text().then(function (txt) {
          var res = { status: r.status, body: txt, headers: { link: r.headers.get('Link'), 'x-ratelimit-remaining': r.headers.get('X-RateLimit-Remaining') } };
          var data = parseJSON(res);
          if (r.status >= 400) throw makeError(res, data);
          if (data === null && r.status !== 204 && r.status !== 205 && r.status !== 304) throw emptyBodyError(res);
          var out = { data: data, status: r.status, link: parseLink(res.headers.link), headers: res.headers };
          if (isGet && opts.cache) cache[ckey] = { t: Date.now(), v: out };
          return out;
        });
      });
    }
    if (isGet) {
      inflight[ckey] = p;
      var clear = function () { delete inflight[ckey]; };
      p.then(clear, clear);
    }
    return p;
  }

  var API = {
    base: API_BASE,
    get: function (p, params, opts) { return req('GET', p, Object.assign({ params: params }, opts)); },
    post: function (p, body, opts) { return req('POST', p, Object.assign({ body: body }, opts)); },
    patch: function (p, body, opts) { return req('PATCH', p, Object.assign({ body: body }, opts)); },
    put: function (p, body, opts) { return req('PUT', p, Object.assign({ body: body }, opts)); },
    del: function (p, body, opts) { return req('DELETE', p, Object.assign({ body: body === undefined ? {} : body }, opts)); },

    /** 自动翻页拉取，返回合并后的数组 */
    paged: function (path, params, maxPages, opts) {
      maxPages = maxPages || 1;
      params = Object.assign({}, params, { per_page: params && params.per_page || 30 });
      var all = [], last = null, page = 1;
      function next() {
        return req('GET', path, Object.assign({ params: Object.assign({}, params, { page: page }) }, opts))
          .then(function (res) {
            var d = res.data;
            if (Array.isArray(d)) all = all.concat(d); else { all.push(d); return { data: all, done: true, link: res.link }; }
            last = res;
            if (res.link && res.link.next && page < maxPages) { page++; return next(); }
            return { data: all, done: !res.link || !res.link.next, link: res.link };
          });
      }
      return next();
    },

    /** 纯文本（raw / diff / 日志） */
    /**
     * 取原始文本（如文件内容、日志、diff）。
     *
     * 注意：非 JSON 响应时 res.data 是 null —— 真实内容在 res.body。
     * 之前这里读 res.data.raw，永远拿到 null，属于埋雷。
     */
    text: function (path, accept, opts) {
      return req('GET', path, Object.assign({ accept: accept || 'application/vnd.github.raw' }, opts))
        .then(function (res) {
          if (!res) return null;
          if (typeof res.body === 'string') return res.body;
          if (res.data && typeof res.data.raw === 'string') return res.data.raw;
          return null;
        });
    },

    clearCache: function () { cache = Object.create(null); },

    /**
     * 只读内存缓存，不发请求、不写缓存。
     *
     * 场景：新建 PR 时要显示「来源仓库」，用户选了另一个仓库就得拿到它的
     * default_branch —— 如果那个仓库刚才在列表或详情页看过，缓存里现成就有，
     * 没必要为了一个字段再打一次接口。命中就返回，没命中返回 null，
     * 调用方自己去请求（缓存本来就是可选的加速，不能当数据源依赖）。
     */
    cachedGet: function (path, params) {
      var key = 'GET ' + buildUrl(path, params);
      var hit = cache[key];
      return hit ? hit.v : null;
    },

    /* ---- 常用业务端点 ---- */
    me: function () { return this.get('/user', null, { cache: 60000 }); },
    rateLimit: function () { return this.get('/rate_limit', null, { cache: 5000 }); },

    /**
     * 应用版本号（原生 BuildConfig.VERSION_NAME）。
     * 失败时返回空串 —— 绝不能返回 '0.0.0' 之类的假版本号，
     * 否则更新检测会把「读不到版本」误判成「从 0.0.0 大版本升级」而强制更新。
     */
    appVersion: function () {
      return window.Native ? window.Native.appVersion() : '';
    },

    /**
     * 源码指纹：把「这个包是由哪一份源码构建的」烙进来。
     *
     * 版本号相同、源码却不同的两个包，光看「关于 v1.1.5」分不出来 ——
     * v1.1.5 就出过这么一回事：tag 停在旧提交、APK 却是新代码，
     * 排查只能靠人肉比对文案。
     *
     * 由 tools/gen-srcfingerprint.py 在构建前写入。本文件自身被排除在计算之外，
     * 否则就成「自己算自己」，永远对不上。
     *
     * 核对办法 —— 在仓库里跑：
     *   python3 tools/gen-srcfingerprint.py --check
     * 拿输出的哈希对「设置 → 关于 → 源码指纹」里显示的那串，
     * 一致就说明手上的包确实来自这份源码。
     */
    SRC_SHA256: '17ec825b340adef6dde0df444176bd634c090f4921be16e2494dd9baca73e0b2'
  };

  window.API = API;

  /* ---------- 通用小工具（供全局使用） ---------- */
  window.Util = {
    esc: function (s) {
      return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    num: function (n) {
      if (n === undefined || n === null) return '0';
      n = +n;
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      return String(n);
    },
    timeAgo: function (iso) {
      if (!iso) return '';
      var t = Date.parse(iso);
      if (isNaN(t)) return '';
      var s = Math.floor((Date.now() - t) / 1000);
      if (s < 45) return '刚刚';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
      if (s < 2592000) return Math.floor(s / 86400) + ' 天前';
      if (s < 31536000) return Math.floor(s / 2592000) + ' 个月前';
      return Math.floor(s / 31536000) + ' 年前';
    },
    date: function (iso) {
      var d = new Date(iso);
      if (isNaN(d)) return '';
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    bytes: function (n) {
      if (n === undefined || n === null) return '';
      var u = ['B', 'KB', 'MB', 'GB'], i = 0;
      n = +n;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    },
    /** 标签文字颜色自适应 */
    labelStyle: function (color) {
      color = (color || 'ededed').replace('#', '');
      var r = parseInt(color.substring(0, 2), 16) || 0;
      var g = parseInt(color.substring(2, 4), 16) || 0;
      var b = parseInt(color.substring(4, 6), 16) || 0;
      var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) {
        return 'background:#' + color + '33;color:rgb(' + Math.min(r + 90, 235) + ',' + Math.min(g + 90, 235) + ',' + Math.min(b + 90, 235) + ');border-color:#' + color + '66';
      }
      return 'background:#' + color + ';color:' + (lum > 0.6 ? '#1f2328' : '#ffffff');
    },
    langColor: function (lang) {
      var M = {
        JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', Java: '#b07219', Kotlin: '#A97BFF',
        Go: '#00ADD8', Rust: '#dea584', 'C++': '#f34b7d', C: '#555555', 'C#': '#178600', Ruby: '#701516',
        PHP: '#4F5D95', Swift: '#F05138', Dart: '#00B4AB', HTML: '#e34c26', CSS: '#563d7c', SCSS: '#c6538c',
        Vue: '#41b883', Shell: '#89e051', Lua: '#000080', Scala: '#c22d40', Perl: '#0298c3', R: '#198CE7',
        'Objective-C': '#438eff', Dockerfile: '#384d54', Makefile: '#427819', 'Jupyter Notebook': '#DA5B0B',
        Elixir: '#6e4a7e', Haskell: '#5e5086', Julia: '#a270ba', Zig: '#ec915c', Vue3: '#41b883',
        'Vim Script': '#199f4b', PowerShell: '#012456', Assembly: '#6E4C13', Nix: '#7e7eff'
      };
      return M[lang] || '#8b949e';
    },
    debounce: function (fn, ms) {
      var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms || 250); };
    },
    decodeBase64: function (b64) {
      try {
        b64 = (b64 || '').replace(/\s/g, '');
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
      } catch (e) { return ''; }
    }
  };
})();
