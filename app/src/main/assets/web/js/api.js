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
            reject(new Error(window.I18n.t('请求超时')));
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
            reject(new Error(window.I18n.t('请求超时')));
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
    /**
     * 「记住的令牌」—— 退出登录时不删的那一分，供登录页回填。
     *
     * 和 setToken 分开：setToken 管的是「当前是否登录」，退出必须清；
     * 这一份管的是「下次能不能一键登回来」，只有「忘记此令牌」才清。
     * 合成一个的话，退出登录就没法记住了（清了就没了）。
     */
    getSavedToken: function () {
      if (window.NativeBridge && typeof window.NativeBridge.getSavedToken === 'function') {
        try { return window.NativeBridge.getSavedToken() || ''; } catch (e) { return ''; }
      }
      return '';
    },
    /** 记住 / 忘掉一份令牌（传空即删除） */
    setSavedToken: function (t) {
      if (window.NativeBridge && typeof window.NativeBridge.setSavedToken === 'function') {
        try { window.NativeBridge.setSavedToken(t || ''); } catch (e) {}
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
      if (!this.canPick()) return Promise.reject(new Error(window.I18n.t('当前环境不支持选择文件')));
      return new Promise(function (resolve, reject) {
        var id = 'p' + (self.seq++);
        var timer = setTimeout(function () {
          delete self._pickCbs[id];
          reject(new Error(window.I18n.t('选择文件超时')));
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
      if (!this.canPick()) return Promise.reject(new Error(window.I18n.t('当前环境不支持选择文件')));
      if (!(window.NativeBridge && typeof window.NativeBridge.pickFile === 'function')) {
        return Promise.reject(new Error(window.I18n.t('当前环境不支持选择文件')));
      }
      return new Promise(function (resolve, reject) {
        var id = 'p' + (self.seq++);
        var timer = setTimeout(function () {
          delete self._pickCbs[id];
          reject(new Error(window.I18n.t('选择文件超时')));
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
        return Promise.reject(new Error(window.I18n.t('当前环境不支持选择文件夹')));
      }
      return new Promise(function (resolve, reject) {
        var id = 'd' + (self.seq++);
        var timer = setTimeout(function () {
          delete self._pickCbs[id];
          reject(new Error(window.I18n.t('选择文件夹超时')));
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
        return Promise.reject(new Error(window.I18n.t('当前环境不支持读取文件夹')));
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
        return Promise.reject(new Error(window.I18n.t('当前环境不支持读取文件')));
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
        return Promise.reject(new Error(window.I18n.t('当前版本不支持在应用内生成签名')));
      }
      return new Promise(function (resolve, reject) {
        var id = 'k' + (self.seq++);
        var timer = setTimeout(function () {
          delete self._ksCbs[id];
          reject(new Error(window.I18n.t('生成签名超时，请重试')));
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
        return Promise.reject(new Error(window.I18n.t('当前环境不支持二进制上传')));
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
        return Promise.reject(new Error(window.I18n.t('当前环境不支持附件上传')));
      }
      return new Promise(function (resolve, reject) {
        var id = 'm' + (self.seq++);
        // 文件可能很大、网络可能很慢，2 分钟还没回音才算失败
        var timer = setTimeout(function () {
          if (self.pending[id]) { delete self.pending[id]; reject(new Error(window.I18n.t('上传超时'))); }
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
        return Promise.reject(new Error(window.I18n.t('当前环境不支持文件上传')));
      }
      return new Promise(function (resolve, reject) {
        var id = 'b' + (self.seq++);
        var timer = setTimeout(function () {
          if (self.pending[id]) { delete self.pending[id]; reject(new Error(window.I18n.t('上传超时'))); }
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
     * 算文件的 **Git blob SHA-1**（sha1("blob " + 长度 + "\\0" + 内容)）。
     *
     * 上传前拿它跟远程 tree 里同路径的 sha 比对：一样就说明这个文件
     * 仓库里已经有了、内容没变，根本不用再传一遍 —— 直接复用远程那个
     * sha 去建 tree。传一批文件时这一条能砍掉大半的请求数，而请求数
     * 正是「整批失败概率」的指数底数。
     *
     * 走原生流式计算，文件不进内存。失败时 resolve(null)，调用方当成
     * 「不知道，照常传」，不能因为算不出哈希就让上传失败。
     *
     * @returns {Promise<string|null>} 40 位小写十六进制，或 null
     */
    gitBlobSha: function (uri) {
      var self = this;
      var NB = window.NativeBridge || window.Native;
      if (!(NB && typeof NB.gitBlobSha === 'function')) {
        return Promise.resolve(null);
      }
      return new Promise(function (resolve) {
        var id = 'h' + (self.seq++);
        var timer = setTimeout(function () {
          if (self.pending[id]) { delete self.pending[id]; resolve(null); }
        }, 60000);
        self.pending[id] = {
          resolve: function (v) {
            clearTimeout(timer);
            var sha = (v && v.status === 200 && v.body) ? v.body : null;
            resolve(/^[0-9a-f]{40}$/.test(sha || '') ? sha : null);
          },
          reject: function () { clearTimeout(timer); resolve(null); }
        };
        try {
          NB.gitBlobSha(id, uri);
        } catch (e) {
          clearTimeout(timer);
          delete self.pending[id];
          resolve(null);
        }
      });
    },

    /**
     * 读上次没传完留下的 blob 账本：{@code path → {s: sha, t: 写入时刻}}。
     *
     * 传一半断掉时，已经 POST 上去的那些 blob 其实安安稳稳躺在 GitHub
     * 上，只是没挂进任何 tree（所以仓库里看不见）。它们记在这里，下次
     * 开传前查一眼就能直接复用，不用再传一遍。
     *
     * 已过期的条目原生侧就筛掉了，这里拿到的都是还在有效期内的。
     */
    uploadLedgerGet: function (key) {
      try {
        var NB = window.NativeBridge || window.Native;
        if (!(NB && typeof NB.uploadLedgerGet === 'function')) return {};
        var raw = NB.uploadLedgerGet(key);
        return JSON.parse(raw || '{}') || {};
      } catch (e) { return {}; }
    },

    /** 记一批 {@code path → sha} 进账本 */
    uploadLedgerPut: function (key, pairs) {
      try {
        var NB = window.NativeBridge || window.Native;
        if (!(NB && typeof NB.uploadLedgerPut === 'function')) return;
        NB.uploadLedgerPut(key, JSON.stringify(pairs || {}));
      } catch (e) { }
    },

    /** 整批成功之后清掉 —— 都提交了，账本没用了 */
    uploadLedgerClear: function (key) {
      try {
        var NB = window.NativeBridge || window.Native;
        if (!(NB && typeof NB.uploadLedgerClear === 'function')) return;
        NB.uploadLedgerClear(key);
      } catch (e) { }
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
        return Promise.reject(new Error(window.I18n.t('当前环境不支持附件上传')));
      }
      return new Promise(function (resolve, reject) {
        var id = 'w' + (self.seq++);
        var timer = setTimeout(function () {
          if (self.pending[id]) { delete self.pending[id]; reject(new Error(window.I18n.t('上传超时'))); }
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
        if (window.UI && window.UI.toast) window.UI.toast(window.I18n.t('当前版本不支持保存图片'));
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

    /* ----------------------------------------------------------------
     * Actions 运行日志：取 zip 并在 App 内渲染
     *
     * 官网的日志是「点开就展开一大片等宽文本，带 ANSI 颜色」，
     * 以前我们只能把用户丢去浏览器 —— 等于这个功能在 App 里等于没有。
     *
     * 原生侧负责「带令牌去要 → 跳到签名地址后摘掉令牌 → 解压」，
     * 这里只负责拿到文本后的呈现，职责分得很清楚。
     * ---------------------------------------------------------------- */
    _logCbs: Object.create(null),

    /**
     * @param {string} url /repos/{o}/{r}/actions/runs/{id}/logs
     * @returns {Promise<{files:Array<{name,text}>, truncated:boolean}>}
     */
    fetchRunLogs: function (url) {
      var self = this;
      var NB = window.NativeBridge;
      if (!(NB && typeof NB.fetchRunLogs === 'function')) {
        return Promise.reject(new Error(window.I18n.t('当前版本不支持 App 内查看日志')));
      }
      return new Promise(function (resolve, reject) {
        var id = 'l' + (self.seq++);
        // 日志包可能几 MB，解压+回灌给的时间给足，宁可慢也别让用户看到一个假的失败
        var timer = setTimeout(function () {
          delete self._logCbs[id];
          reject(new Error(window.I18n.t('读取日志超时')));
        }, 60000);
        self._logCbs[id] = function (data, err) {
          clearTimeout(timer);
          if (err) reject(new Error(err));
          else resolve(data);
        };
        try {
          NB.fetchRunLogs(id, url);
        } catch (e) {
          clearTimeout(timer);
          delete self._logCbs[id];
          reject(e);
        }
      });
    },

    /** 原生回调：解开 JSON 交给对应的 Promise */
    _runlogs: function (id, json, err) {
      var cb = this._logCbs[id];
      if (!cb) return;
      delete this._logCbs[id];
      if (err) return cb(null, err);
      var data = null;
      try { data = typeof json === 'string' ? JSON.parse(json) : json; }
      catch (e) { return cb(null, window.I18n.t('日志解析失败')); }
      cb(data, null);
    },

    /**
     * 应用版本号（原生 BuildConfig.VERSION_NAME）；拿不到原生环境时用内置常量。
     * 读不到具体值时宁可返回空串，也不要编一个 0.0.0 —— 假版本号会被
     * 更新检测当成「大版本升级」而弹强制更新。
     */
    APP_VERSION: '1.2.18',
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
      /* 原生 prefs 与 WebView localStorage 是两份独立存档。
         强杀进程时 SharedPreferences.apply() 可能还未来得及落盘，
         原生留在上一份旧 JSON（没有新加的 gh_lang 等字段）；
         以前「原生非空就直接用、不再看 localStorage」，于是设置悄悄丢失。
         现在两份都读、逐字段合并，后写的 localStorage 覆盖旧值。 */
      var raws = [];
      if (window.NativeBridge && typeof window.NativeBridge.getPref === 'function') {
        try { var a = window.NativeBridge.getPref(SETTINGS_KEY); if (a) raws.push(a); } catch (e) {}
      }
      try { var b = localStorage.getItem(SETTINGS_KEY); if (b) raws.push(b); } catch (e) {}
      for (var i = 0; i < raws.length; i++) {
        try {
          var o = JSON.parse(raws[i]);
          if (o && typeof o === 'object') {
            for (var j in o) {
              if (Object.prototype.hasOwnProperty.call(o, j)) s[j] = o[j];
            }
          }
        } catch (e) {}
      }
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
  /**
   * 内置默认令牌 —— 由 js/embedded-token.js 提供（构建时注入，不进仓库）。
   * 留空就是普通的「需要登录」模式，一切照旧。
   */
  function embeddedToken() {
    /* 内置令牌一旦被证明无效（401），本次会话内不再回落 ——
       否则退了又立刻用坏令牌登回来，界面卡在「已登录但什么都刷不出来」。 */
    if (Session && Session._embeddedBroken) return '';
    return (window.EMBEDDED_TOKEN || '').trim();
  }

  var Session = {
    token: '',
    user: null,
    savedToken: '',
    /**
     * 内置令牌是「兜底」而不是「存进去的一份」：
     *  · 用户没存过令牌 → 用内置的，打开就能用，不用登录；
     *  · 用户存了自己的 → 用他自己那个（内置的不覆盖他）；
     *  · 用户退出 / 忘记 → 清掉存的，自动回落到内置的。
     *
     * 内置这份**不写进加密存储**，这样「退出」才有意义 —— 否则退了又
     * 立刻自己登回来，等于退不掉。
     */
    init: function () {
      var t = Native.getToken();
      if (!t) t = embeddedToken();
      /* 必须让**原生层**也知道内置令牌。
         原生读的是加密存储，那里没东西 —— 于是下载限速的 Star 判定、
         保存私有图片、拉 Actions 日志这些跑在原生的功能全都认为
         「没登录」，点了 Star 也照样限速。 */
      try {
        if (Native.has && Native.has()) {
          var nb = window.NativeBridge || null;
          if (nb && typeof nb.setEmbeddedToken === 'function') nb.setEmbeddedToken(embeddedToken());
        }
      } catch (e) {}
      this.token = t;
      /* savedToken 只记用户**自己**存过的，用于登录页回填。
         内置那份不回填，否则「忘记此令牌」清不掉它。
         两个来源都要看：登录态下是 getToken（当前生效那份）；
         退出过的情况下它已被清空，只剩 getSavedToken 里记住的那份 ——
         少看这一个，退出后重开 App 就回填不出来了。 */
      this.savedToken = Native.getToken() || Native.getSavedToken() || '';
      return this.token;
    },
    setToken: function (t) {
      this.token = t || '';
      this.user = null;
      Native.setToken(this.token);
      if (this.token) {
        this.savedToken = this.token;
        /* 落盘一份：退出登录时 getToken 已被清，只有这里留了底，
           下次打开才能回填。 */
        Native.setSavedToken(this.token);
      }
    },
    /**
     * 退出登录：清掉用户存的令牌。
     * 有内置令牌时会回落到内置（免登录的本意就是「总能用」）；
     * 没有内置令牌就是常规的未登录态。
     */
    /**
     * 退出登录。
     *
     * 只结束「登录态」（当前生效的令牌被清），**记住的那份留着** ——
     * 下次打开登录页能一键登回来。这是「记住我」的常规行为：
     * 令牌是 9 段乱码，退出一次就要求重新去官网复制一遍不现实。
     *
     * 想彻底清除走 forget()（登录页的「忘记此令牌」）。
     *
     * 注意 savedToken 不能直接沿用 this.token —— 内置令牌回落时
     * this.token 就是内置的，把它记住会导致「忘记此令牌」清不掉，
     * 而且内置那份本来就不该出现在登录页输入框里。
     */
    clear: function () {
      /*
        先把「当前正在用的、且是用户自己的」那份抓在手里，再去动 this.token。

        顺序很要紧：下面第一件事就是把 this.token 改成内置令牌，
        改完内存里就没有用户那份了。以前先改后读，唯一能依靠的只剩
        Native.getToken() —— 而它走的是 Keystore 解密，任何一步出岔子
        （密钥异常、桥接抖动）就返回空串，令牌当场蒸发，界面却还提示
        「已保留」。内存这份不会失败，优先用它。
      */
      var mine = (this.token && this.token !== embeddedToken()) ? this.token : '';
      this.token = embeddedToken();
      this.user = null;

      /*
        三个来源按可靠度排：内存里刚抓的 → 当前生效的 → 记住的那份。
        少了内存这一档，老版本升级上来的用户（只写过 getToken、没写过
        saved）在退出时会发现三处全空 —— 升级后第一次退出反而把令牌丢了。
      */
      var keep = mine || Native.getToken() || Native.getSavedToken() || '';
      var remembered = false;
      if (keep) {
        Native.setSavedToken(keep);
        /* 写完立刻读回验证。
           不验证的话，落盘失败（Keystore 不可用等）仍然会提示「已保留」，
           用户下次打开才发现令牌没了 —— 那时候他只会以为是 App 坏了。
           宁可当场说没记住，也别给一个假的安心。 */
        remembered = Native.getSavedToken() === keep;
      }
      this.savedToken = remembered ? keep : '';
      Native.setToken('');
      return remembered;
    },
    /** 彻底忘记令牌（登录页「忘记此令牌」）；当前生效的与记住的一起清 */
    forget: function () {
      this.token = embeddedToken();
      this.user = null;
      this.savedToken = '';
      Native.setToken('');
      Native.setSavedToken('');
      return true;
    },
    /** 当前用的是不是内置那份（界面据此决定要不要显示「登录」入口） */
    get usingEmbedded() {
      return !!embeddedToken() && this.token === embeddedToken();
    },
    /* ───────── 多账号 ─────────
       账号串存在原生 SecurePrefs（加密）里，这里只做读写和切换编排。

       一条硬规则：切换账号时必须把「上个账号的痕迹」清干净。
       漏一处就是串号 bug —— 而且这类 bug 很隐蔽，要两个号都登录过
       才复现，测的时候很容易单次登录测不出来。 */

    /** 账号串（含内置那份）。结构：[{id,login,name,avatar,token,current}] */
    accounts: [],

    /** 从原生读一次账号串 */
    refreshAccounts: function () {
      var list = [];
      try {
        if (window.NativeBridge && window.NativeBridge.listAccounts) {
          var raw = window.NativeBridge.listAccounts();
          list = JSON.parse(raw || '[]');
        }
      } catch (e) { list = []; }
      if (!Array.isArray(list)) list = [];

      /*
        内置令牌也算一个账号 —— 它是「没登录也能用」的那份身份，
        在列表里应该看得见、能切回去。标成内置，不可删除：
        删掉它等于把免登录这个能力一起删了，那不是用户想要的。
      */
      var emb = embeddedToken();
      if (emb) {
        var has = list.some(function (a) { return a && a.token === emb; });
        if (!has) {
          list.unshift({
            id: '', login: '', name: window.I18n.t('内置账号'), avatar: '',
            token: emb, builtin: true,
            current: (!this.token || this.token === emb)
          });
        } else {
          list.forEach(function (a) { if (a && a.token === emb) a.builtin = true; });
        }
      }
      this.accounts = list;
      return list;
    },

    /**
     * 登录成功后登记。同 login 视为同一账号，覆盖旧记录。
     * 内置令牌不用登记 —— 它已经在 refreshAccounts 里了。
     */
    register: function (user, token) {
      var t = token || this.token;
      if (!user || !user.login || !t || t === embeddedToken()) return;
      try {
        if (window.NativeBridge && window.NativeBridge.addAccount) {
          window.NativeBridge.addAccount(
            String(user.id || ''), user.login,
            user.name || '', user.avatar_url || '', t);
        }
      } catch (e) { }
      this.refreshAccounts();
    },

    /**
     * 切换到另一个账号。
     *
     * 按**令牌**定位而不是 login：列表是刚读出来的，每项都带 token，
     * 直接按它定位就不会认错行。按 login 匹配时，内置那份的 login 是
     * 空串，一旦混进来，点第一行可能切到第二行去。
     *
     * 切完还要**回读校验**：写进去不等于生效，Keystore 异常、存储抖动
     * 都可能让 put 静默失败。读回来不是目标令牌就判失败 ——
     * 失败时一点状态都不改，否则会把当前账号的令牌也弄丢。
     */
    switchTo: function (login) {
      var rec = null;
      this.refreshAccounts();
      for (var i = 0; i < this.accounts.length; i++) {
        var a = this.accounts[i];
        if (a && a.login === login) { rec = a; break; }
      }
      if (!rec || !rec.token) return false;
      return this.switchToToken(rec.token);
    },

    /** 按令牌切换（推荐入口，避开 login 匹配） */
    switchToToken: function (token) {
      if (!token) return false;
      var ok = false;
      try {
        if (window.NativeBridge && window.NativeBridge.switchAccountByToken) {
          ok = window.NativeBridge.switchAccountByToken(token);
        } else if (window.NativeBridge && window.NativeBridge.switchAccount) {
          ok = window.NativeBridge.switchAccount(this._loginOf(token));
        }
      } catch (e) { ok = false; }
      if (!ok) return false;

      /* 回读校验：写入失败要当场发现，不能继续换内存里的状态 */
      var live = '';
      try { live = window.NativeBridge.getToken() || ''; } catch (e) { live = ''; }
      if (!live || live !== token) return false;

      this.token = token;
      this.user = null;
      this.savedToken = token;
      this.refreshAccounts();
      this._afterSwitch();
      return true;
    },

    _loginOf: function (token) {
      for (var i = 0; i < this.accounts.length; i++) {
        var a = this.accounts[i];
        if (a && a.token === token) return a.login || '';
      }
      return '';
    },

    /** 切到内置令牌（等于「不登录也能用」的那份身份） */
    switchToBuiltin: function () {
      var emb = embeddedToken();
      if (!emb) return false;
      try {
        if (window.NativeBridge) {
          window.NativeBridge.setToken(emb);
          window.NativeBridge.setSavedToken('');
          if (window.NativeBridge.addAccount) {
            window.NativeBridge.addAccount('', '', window.I18n.t('内置账号'), '', emb);
          }
          if (window.NativeBridge.switchAccount) window.NativeBridge.switchAccount('');
        }
      } catch (e) { }
      this.token = emb;
      this.user = null;
      this.savedToken = '';
      this.refreshAccounts();
      this._afterSwitch();
      return true;
    },

    /**
     * 删除一个账号。删的是当前账号时会顺带结束登录态（原生已处理），
     * 这里只负责把 JS 侧的会话状态对齐。
     */
    removeAccount: function (login) {
      var ok = false;
      try {
        if (window.NativeBridge && window.NativeBridge.removeAccount) {
          ok = window.NativeBridge.removeAccount(login);
        }
      } catch (e) { ok = false; }
      if (ok) {
        /* 删的正是当前在用的人 → 退回内置 / 未登录 */
        var cur = (this.user && this.user.login) === login;
        if (cur) {
          this.token = embeddedToken();
          this.user = null;
          this.savedToken = '';
        }
        this.refreshAccounts();
        this._afterSwitch();
      }
      return ok;
    },

    /** 切换/删除之后统一要做的清理。集中放，避免各处漏掉某一项。 */
    _afterSwitch: function () {
      /* 页面缓存：不清会看到上个账号的私有仓库 / 通知 */
      try { window.App.clearPageCache(); } catch (e) {}
      /* 接口缓存：换人了，上个账号拉过的仓库 / 通知 / Star 一律作废。
         不清的话首页会显示上个账号的内容 —— 人换了，数据没换。 */
      try { window.API.clearCache(); } catch (e) {}
      /* 记住的用户名：不清的话顶栏还显示上个账号 */
      try { window.Store.set('lastUser', ''); } catch (e) {}
      /* Star 收藏夹镜像：按登录名隔离，换人必须重载 */
      try { if (window.StarLists && window.StarLists.reload) window.StarLists.reload(); } catch (e) {}
      /* 访问判定作废：bl_uid 还留着上个账号的 ID，
         不清的话新账号会被上个账号的结论误伤。切换时明确知道新 ID，
         直接重判即可，不需要那份兜底。 */
      try { if (window.Blocklist && window.Blocklist.forget) window.Blocklist.forget(); } catch (e) {}
      try { window.App.updateBadge(); } catch (e) {}
    },

    /** 内置令牌被证明无效时调用：真正清空，不再回落 */
    markEmbeddedBroken: function () {
      this._embeddedBroken = true;
      this.token = '';
      this.user = null;
      this.savedToken = '';
      Native.setToken('');
      Native.setSavedToken('');
    },
    _embeddedBroken: false,
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
    var e = new Error(window.I18n.t('响应内容读取失败'));
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

  /* ============================================================
   * 网络诊断 —— 精确定位「假 404 / 假 403」
   *
   * 实测抓到过这样一次响应：
   *   HTTP 403 + server: github.com + x-ratelimit-remaining: 4999
   *   + body 是完整的 current_user_url 那份正常 JSON
   * 状态码被链路上的某一环改写了，数据本身完好。旧逻辑只看
   * status >= 400 就抛错，于是网络明明通着，用户却看到「404」。
   *
   * 这里做两件事：
   *  1) 逐条留存**原始证据**：时间、完整 URL、状态码、响应体指纹、
   *     关键响应头、网络类型、分类结论。故意**不去重** ——
   *     「地方不一样 / 时间不一样 / 结果不一样」正是要靠这些差异定位，
   *     按签名去重会把证据抹平。
   *  2) 给出可复核的分类，供 settle() 决定「按成功用」还是「真抛错」。
   *
   * 安全：完整令牌绝不进日志；URL 去掉 query；body 只取前 160 字节
   *       且先脱敏；响应头只挑白名单字段。
   * ============================================================ */
  var DIAG_MAX = 120;
  var diagBuf = [];
  try { diagBuf = Store.getJSON('netdiag', []) || []; } catch (e) { diagBuf = []; }

  function diagTime() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function diagNet() {
    try {
      var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c) return String(c.type || c.effectiveType || 'unknown');
    } catch (e) {}
    return 'unknown';
  }

  function diagClean(v) {
    var x = String(v == null ? '' : v);
    /* 万一令牌被拼进来了，先抹掉，绝不落盘 */
    x = x.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***');
    x = x.replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer ***');
    return x.replace(/[\r\n\t]+/g, ' ').slice(0, 160);
  }

  function diagSafeUrl(url) {
    var u = String(url || '');
    var q = u.indexOf('?');
    if (q >= 0) u = u.slice(0, q) + '?<omitted>';
    return diagClean(u);
  }

  /* 响应体是不是「完好的 GitHub 数据」而不是错误对象。
   * 最硬的闸门：只要带 message 字段，就是 GitHub 的错误体，不算数据。
   * 这样 {message:"Not Found"} / {message:"API rate limit exceeded"}
   * 永远不会被误判成数据，也就不会被「自愈」吞掉。 */
  function diagIsData(data) {
    if (data === null || data === undefined) return false;
    if (Array.isArray(data)) return data.length > 0;
    if (typeof data !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(data, 'message')) return false;
    var keys = Object.keys(data);
    if (!keys.length) return false;
    var marks = ['url', 'login', 'id', 'full_name', 'items', 'current_user_url',
                 'resources', 'rate', 'name', 'html_url', 'total_count', 'sha'];
    for (var i = 0; i < marks.length; i++) {
      if (Object.prototype.hasOwnProperty.call(data, marks[i])) return true;
    }
    return keys.length >= 3;
  }

  var DIAG_HEADERS = ['server', 'x-github-request-id', 'x-ratelimit-remaining',
                      'x-ratelimit-limit', 'x-ratelimit-reset', 'content-type',
                      'via', 'date', 'retry-after'];

  function diagHeaders(h) {
    var out = {};
    h = h || {};
    for (var i = 0; i < DIAG_HEADERS.length; i++) {
      var k = DIAG_HEADERS[i];
      var v = (h[k] !== undefined && h[k] !== null) ? h[k] : null;
      if (v !== null && v !== '') out[k] = diagClean(v);
    }
    return out;
  }

  /**
   * 分类。kind 的取值本身就是跨语言的代号，诊断页直接用。
   *   ok        正常
   *   bogus     状态码被改写但数据完好（可自愈）
   *   real404   真的资源不存在
   *   token     令牌作废
   *   ratelimit 配额用尽
   *   permission 权限不足
   *   server    5xx
   *   network   无响应 / 超时
   *   empty     有状态码但响应体不是 JSON（常见：网关代答的 HTML 404 页）
   *   other     其它
   */
  function diagClassify(res, data) {
    res = res || {};
    var s = Number(res.status) || 0;
    var h = res.headers || {};
    var msg = (data && typeof data === 'object' && !Array.isArray(data))
      ? String(data.message || '') : '';
    var remain = h['x-ratelimit-remaining'];
    var rid = h['x-github-request-id'] || '';
    var server = h['server'] || '';

    if (!s) return { kind: 'network', bogus: false, why: 'no HTTP status (timeout / not sent)' };
    if (s === 401) return { kind: 'token', bogus: false, why: msg || 'credential rejected', rid: rid };
    if (s === 404 && /not found/i.test(msg)) return { kind: 'real404', bogus: false, why: msg, rid: rid };
    if (s === 403 && String(remain) === '0') return { kind: 'ratelimit', bogus: false, why: 'remaining=0', rid: rid };
    if (s >= 500) return { kind: 'server', bogus: false, why: 'HTTP ' + s + (msg ? ' / ' + msg : ''), rid: rid };

    var isData = diagIsData(data);
    if (s >= 400 && isData) {
      return { kind: 'bogus', bogus: true,
               why: 'HTTP ' + s + ' but body is valid GitHub data (no message field)',
               rid: rid, server: server };
    }
    if (s >= 400 && data === null) {
      return { kind: 'empty', bogus: false,
               why: 'HTTP ' + s + ' with non-JSON body (gateway page?)', rid: rid, server: server };
    }
    if (s >= 400 && msg) {
      return { kind: (s === 403 ? 'permission' : 'other'), bogus: false, why: msg, rid: rid };
    }
    if (s < 400) return { kind: 'ok', bogus: false, why: 'ok' };
    return { kind: 'other', bogus: false, why: 'HTTP ' + s, rid: rid };
  }

  function diagRecord(rec) {
    rec.t = rec.t || diagTime();
    rec.net = rec.net || diagNet();
    diagBuf.push(rec);
    if (diagBuf.length > DIAG_MAX) diagBuf.splice(0, diagBuf.length - DIAG_MAX);
    try { Store.setJSON('netdiag', diagBuf.slice(-40)); } catch (e) {}
    return rec;
  }

  /** 一条证据 → 可读的一行，错误日志 / 诊断页 / 分享共用 */
  function diagLine(rec) {
    var hs = rec.headers || {}, bits = [];
    for (var k in hs) if (Object.prototype.hasOwnProperty.call(hs, k)) bits.push(k + '=' + hs[k]);
    return '[' + (rec.t || '') + '] ' + (rec.outcome || '') + ' ' + (rec.kind || '') +
      ' | ' + (rec.method || 'GET') + ' ' + (rec.url || '') +
      ' | HTTP ' + (rec.status === undefined ? '?' : rec.status) +
      ' | net=' + (rec.net || '?') +
      (rec.ms !== undefined ? ' | ' + rec.ms + 'ms' : '') +
      ' | ' + (rec.why || '') +
      (bits.length ? ' | ' + bits.join(' ') : '') +
      (rec.body ? ' | body=' + rec.body : '');
  }

  /**
   * 统一收口两个网络分支的响应判定。
   * 返回 {data,status,link,headers} 或抛出带原始证据的 error。
   */
  function settle(res, data, method, url) {
    var s = Number(res.status) || 0;
    var h = res.headers || {};
    var d = diagClassify(res, data);
    var suspicious = (s >= 400) || (data === null && s !== 204 && s !== 205 && s !== 304);

    if (suspicious) {
      var rec = diagRecord({
        method: method, url: diagSafeUrl(url), status: s,
        kind: d.kind, why: d.why, headers: diagHeaders(h),
        body: diagClean(res.body), outcome: d.bogus ? 'auto-fixed' : 'failed'
      });
      /* 同时写一条进「错误日志」，用户从设置里导出时带得走 */
      try {
        if (window.API && typeof window.API.logError === 'function') {
          window.API.logError(window.I18n.t('网络诊断'), diagLine(rec));
        }
      } catch (e) {}
    }

    if (s >= 400) {
      if (d.bogus) {
        /* 状态码被改写，但数据完好 —— 按成功用，并留一条自愈记录。
           对外给的 status 归正为 200，免得调用方按 403 走进错误分支。 */
        return {
          data: data, status: 200,
          link: parseLink(h.link || h.Link), headers: h, _diagFixed: true
        };
      }
      var e = makeError(res, data);
      e.diag = d;
      e.rawRes = { status: s, body: String(res.body || '').slice(0, 4000), headers: h };
      throw e;
    }
    if (data === null && s !== 204 && s !== 205 && s !== 304) {
      var e2 = emptyBodyError(res);
      e2.rawRes = { status: s, body: String(res.body || '').slice(0, 4000), headers: h };
      throw e2;
    }
    return { data: data, status: s, link: parseLink(h.link || h.Link), headers: h };
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
    /*
      缓存 key 必须带上「是谁在请求」。

      以前 key 只有「方法 + URL」，于是 /user 的 60 秒缓存是**跨账号共享**的：
      账号 A 拉过一次后，60 秒内切到账号 B 再调 me()，命中的是 A 那份 ——
      表现就是「点了第一个账号，登录的却是第二个」。

      带上令牌尾缀后不同账号各存一份，天然隔离。只取最后 8 位：
      够区分账号，又不会把完整令牌当 key 留在内存里。
    */
    var ckey = method + ' ' + url + '|' + (Session.token ? Session.token.slice(-8) : 'anon');
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
        // 204/205/304 本来就无体；其余情况解不出内容按故障处理，别把 null 往下传
        // （205 Reset Content：GitHub 单条「标已读」PATCH /notifications/threads/{id}
        //  的成功返回码；「标 Done」的 DELETE 是 204。205 不进白名单的话，
        //  标已读会被误抛「响应内容读取失败」——在静默 catch 下表现为「打开了还是未读」。）
        var out = settle(res, data, method, url);
        if (isGet && opts.cache) cache[ckey] = { t: Date.now(), v: out };
        return out;
      });
    } else {
      var init = { method: method, headers: headers, mode: 'cors', credentials: 'omit' };
      if (body) init.body = body;
      p = fetch(url, init).then(function (r) {
        return r.text().then(function (txt) {
          var res = { status: r.status, body: txt, headers: { link: r.headers.get('Link'), 'x-ratelimit-remaining': r.headers.get('X-RateLimit-Remaining'), server: r.headers.get('Server') } };
          var data = parseJSON(res);
          var out = settle(res, data, method, url);
          if (isGet && opts.cache) cache[ckey] = { t: Date.now(), v: out };
          return out;
        });
      });
    }
    /*
      请求失败统一采集。

      ═══ 为什么插在这里 ═══

      App 里几乎所有操作 —— 浏览仓库、拉 Issue、上传文件、看 Actions、
      下载、翻译 —— 最后都要走这个 req()。以前只有个别分支手动上报
      （翻译那块），其余请求失败了日志里什么都没有，用户反馈「上传失败」
      我们却查不到当时的接口返回。

      插在这唯一的出口：所有请求一旦失败，自动留一条，不用改任何调用方。

      ═══ 三条规矩 ═══

      1) **绝不吞错误**：用 then(null, fn) 旁路记录后再把原错误原样抛出，
         调用方的 catch / 界面提示完全不受影响。写成 catch 就会吞。
      2) **限流**：按「方法 + 路径骨架 + 状态码」去重，同一类只记一次；
         整场会话最多 REQ_LOG_MAX 条。接口连环失败时能刷出上千行，
         会把真正有价值的第一条淹没掉。
      3) **不记正常业务分支**：404 在很多地方是「有没有这个东西」的
         正常查询（检查文件是否存在），只在没有 silent 标记时记，
         且措辞是「没找到」而不是「出错了」。
    */
    p = p.then(null, function (err) {
      try { reportReqFail(method, path, err, opts); } catch (e) { }
      throw err;
    });

    if (isGet) {
      inflight[ckey] = p;
      var clear = function () { delete inflight[ckey]; };
      p.then(clear, clear);
    }
    return p;
  }

  /* ---------------- 请求失败上报 ---------------- */

  var REQ_LOG_MAX = 50;          // 整场会话最多记多少条请求失败
  var _reqLogged = Object.create(null);
  var _reqCount = 0;

  /** 把 /repos/foo/bar/issues/123 这种收敛成骨架，避免每个 id 各记一条 */
  function pathSkeleton(p) {
    try {
      var s = String(p || '').split('?')[0];
      var segs = s.split('/').filter(function (x) { return x !== ''; });
      var out = [];
      for (var i = 0; i < segs.length && i < 6; i++) {
        var g = segs[i];
        // 纯数字（id）、40 位 hex（commit sha）、UUID 都归为占位符
        if (/^\d+$/.test(g) || /^[0-9a-f]{7,40}$/i.test(g)) g = '*';
        out.push(g);
      }
      return out.join('/');
    } catch (e) { return String(p || ''); }
  }

  function reportReqFail(method, path, err, opts) {
    if (opts && opts.noLog) return;
    if (_reqCount >= REQ_LOG_MAX) return;
    var status = err && (err.status || err.code) || 0;
    var sig = method + ' ' + pathSkeleton(path) + ' ' + status;
    if (_reqLogged[sig]) return;
    _reqLogged[sig] = 1;
    _reqCount++;

    var what, why = '';
    if (status === 401) {
      what = window.I18n.t('登录状态失效（401）');
      why = window.I18n.t('可能是令牌过期或被撤销，重新登录即可');
    } else if (status === 403) {
      what = window.I18n.t('没有权限或被限流（403）');
      why = err && err.rateLimited ? window.I18n.t('接口调用次数已用完，等一会再试') : window.I18n.t('这个操作需要更高权限');
    } else if (status === 404) {
      what = window.I18n.t('没找到这个东西（404）');
      why = String(path || '').split('?')[0];
    } else if (status >= 500) {
      what = window.I18n.t('服务器端出错（') + status + '）';
      why = window.I18n.t('GitHub 那边的问题，稍后重试');
    } else if (status === 0 || !status) {
      what = window.I18n.t('网络连不上');
      why = String((err && err.message) || window.I18n.t('请求没能发出去或没等到回应')).slice(0, 120);
    } else {
      what = window.I18n.t('请求失败（') + status + '）';
      why = String((err && err.message) || '').slice(0, 120);
    }
    try {
      if (window.API && typeof window.API.logError === 'function') {
        var ev = '';
        if (err && err.rawRes) {
          var hs = diagHeaders(err.rawRes.headers), bits = [];
          for (var k in hs) if (Object.prototype.hasOwnProperty.call(hs, k)) bits.push(k + '=' + hs[k]);
          ev = ' | HTTP ' + (err.status || 0) +
               ' | kind=' + ((err.diag && err.diag.kind) || '?') +
               (bits.length ? ' | ' + bits.join(' ') : '') +
               ' | body=' + diagClean(err.rawRes.body);
        }
        window.API.logError(window.I18n.t('请求：') + method + ' ' + String(path || '').split('?')[0],
          what + (why ? '。' + why : '') + ev);
      }
    } catch (e) { }
  }

  var API = {
    base: API_BASE,
    /* 转发到原生日志桥。
     * 原来 logError/logNote 定义在 Native 上，可 reportReqFail 等调用方
     * 写的却是 window.API.logError —— 方法不存在，错误日志一直是空的。
     * 在这里补一层转发，顺带让诊断证据能真正写进「下载错误日志」。 */
    logError: function (w, y) { return Native.logError(w, y); },
    logNote: function (w) { return Native.logNote(w); },

    /* ---------- 网络诊断（对外） ---------- */
    diagLog: function () { return diagBuf.slice(); },
    diagClear: function () { diagBuf.length = 0; try { Store.setJSON('netdiag', []); } catch (e) {} },
    diagLine: diagLine,
    diagClassify: diagClassify,
    diagText: function () { return diagBuf.map(diagLine).join('\n'); },

    /**
     * 主动探测：直接打原生通道，**绕过 settle() 的自愈** ——
     * 诊断必须看原始状态码，看自愈后的结果就分不出真假了。
     * 每个地址连打 times 次，逐次留证，用来复现「时间不一样结果不一样」。
     */
    diagProbe: function (paths, times) {
      paths = paths || ['/', '/rate_limit', '/repos/Buwrt/githup'];
      times = times || 3;
      var chain = Promise.resolve(), out = [];

      paths.forEach(function (p) {
        for (var i = 0; i < times; i++) {
          (function (p, i) {
            chain = chain.then(function () {
              var url = API_BASE + p;
              var hd = { 'Accept': ACCEPT, 'X-GitHub-Api-Version': X_VERSION, 'User-Agent': 'githup/1.0' };
              if (Session.token) hd['Authorization'] = 'Bearer ' + Session.token;
              var t0 = Date.now();

              function done(res) {
                var data = parseJSON(res);
                var d = diagClassify(res, data);
                var rec = diagRecord({
                  method: 'GET', url: diagSafeUrl(url), status: Number(res.status) || 0,
                  kind: d.kind, why: d.why, headers: diagHeaders(res.headers),
                  body: diagClean(res.body), ms: Date.now() - t0, outcome: 'probe'
                });
                out.push(rec);
                return rec;
              }
              function fail(err) {
                var rec = diagRecord({
                  method: 'GET', url: diagSafeUrl(url), status: 0,
                  kind: 'network', why: String((err && err.message) || 'request failed'),
                  headers: {}, body: '', ms: Date.now() - t0, outcome: 'probe'
                });
                out.push(rec);
                return rec;
              }

              if (Native.has()) return Native.http('GET', url, null, hd).then(done, fail);
              return fetch(url, { method: 'GET', headers: hd, credentials: 'omit' }).then(function (r) {
                return r.text().then(function (txt) {
                  return done({ status: r.status, body: txt, headers: {
                    'server': r.headers.get('Server'),
                    'x-github-request-id': r.headers.get('X-GitHub-Request-Id'),
                    'x-ratelimit-remaining': r.headers.get('X-RateLimit-Remaining'),
                    'content-type': r.headers.get('Content-Type')
                  } });
                });
              }, fail);
            });
          })(p, i);
        }
      });
      return chain.then(function () { return out; });
    },

    get: function (p, params, opts) { return req('GET', p, Object.assign({ params: params }, opts)); },
    post: function (p, body, opts) { return req('POST', p, Object.assign({ body: body }, opts)); },
    patch: function (p, body, opts) { return req('PATCH', p, Object.assign({ body: body }, opts)); },
    put: function (p, body, opts) { return req('PUT', p, Object.assign({ body: body }, opts)); },
    del: function (p, body, opts) { return req('DELETE', p, Object.assign({ body: body === undefined ? {} : body }, opts)); },

    /**
     * GraphQL 请求。
     *
     * 为什么需要它：GitHub 的 **Lists（星标列表）没有 REST 端点** ——
     * /user/starred_lists 直接 404。官网那个「收藏夹分组」走的就是 GraphQL，
     * 我们要读/写同一份数据，只能走同一条路。
     *
     * 注意：这不是 REST，错误形态不一样 —— HTTP 200 也可能带着 errors 数组
     * （比如 scope 不够会返回 INSUFFICIENT_SCOPES），所以这里要把 errors
     * 翻成 reject，不能只看状态码。
     *
     * @param {string} query     GraphQL 查询/变更文本
     * @param {object} variables 变量
     * @returns {Promise<object>} data 部分
     */
    graphql: function (query, variables, opts) {
      opts = opts || {};
      if (!Session.token) return Promise.reject(new Error(window.I18n.t('未登录')));
      var body = JSON.stringify({ query: query, variables: variables || {} });
      var headers = {
        'Authorization': 'Bearer ' + Session.token,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'githup/1.0'
      };

      /*
       * 必须走原生通道，不能用 fetch。
       *
       * 页面跑在 WebView 里，源是本地的（file://），直接 fetch
       * api.github.com 是跨域请求，会被 CORS 拦掉 —— 结果就是列表同步
       * 静默失效：代码在、逻辑对，但一次都没真正发出去过。
       * 所有 REST 早就走原生了，GraphQL 只是这一条漏网。
       */
      var viaNative = Native.has()
        ? Native.http('POST', 'https://api.github.com/graphql', body, headers)
            .then(function (r) { return { status: r.status, text: r.body }; })
        : fetch('https://api.github.com/graphql', {
            method: 'POST', headers: headers, body: body
          }).then(function (r) {
            return r.text().then(function (t) { return { status: r.status, text: t }; });
          });

      return viaNative.then(function (res) {
          var j = null;
          try { j = JSON.parse(res.text); } catch (e) { j = null; }
          if (!j) {
            var err = new Error(window.I18n.t('GraphQL 返回无法解析'));
            err.status = res.status;
            throw err;
          }
          /* GraphQL 的错误在 body 里，状态码常常还是 200 */
          if (j.errors && j.errors.length) {
            var msg = (j.errors[0] && j.errors[0].message) || window.I18n.t('GraphQL 错误');
            var type = (j.errors[0] && j.errors[0].type) || '';
            var e = new Error(msg);
            e.status = res.status;
            e.gqlType = type;
            /* 权限不够的标记，上层据此引导用户重新授权 */
            if (type === 'INSUFFICIENT_SCOPES' || /INSUFFICIENT_SCOPES/i.test(msg)) {
              e.needUserScope = true;
            }
            throw e;
          }
          if (res.status && (res.status < 200 || res.status >= 300)) {
            var e2 = new Error('HTTP ' + res.status);
            e2.status = res.status;
            throw e2;
          }
          return (j && j.data) || {};
      });
    },

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

    /*
     * 清缓存。传 prefix 就只清 URL 里含该前缀的那些（比如 fork 完只清
     * '/user/repos'，别的页面缓存不受影响）；不传就是全清。
     */
    clearCache: function (prefix) {
      if (!prefix) { cache = Object.create(null); return; }
      var next = Object.create(null);
      Object.keys(cache).forEach(function (k) {
        if (k.indexOf(prefix) < 0) next[k] = cache[k];
      });
      cache = next;
    },

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
    SRC_SHA256: 'abfaf86aa29962a5e972e86262fcf85bd3b1dad9587015946fe50534b4497db8'
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
      if (s < 45) return window.I18n.t('刚刚');
      if (s < 3600) return Math.floor(s / 60) + window.I18n.t(' 分钟前');
      if (s < 86400) return Math.floor(s / 3600) + window.I18n.t(' 小时前');
      if (s < 2592000) return Math.floor(s / 86400) + window.I18n.t(' 天前');
      if (s < 31536000) return Math.floor(s / 2592000) + window.I18n.t(' 个月前');
      return Math.floor(s / 31536000) + window.I18n.t(' 年前');
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
