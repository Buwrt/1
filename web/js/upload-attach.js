/* ============================================================
 * upload-attach.js —— 往 GitHub 上传图片 / 视频，拿到可直接粘贴的链接
 *
 * 解决的问题：
 *   评论框、Issue 正文、Release 说明里都想插图插视频，但网页端
 *   GitHub 提供的是「拖拽 / 选择文件」，我们没法用 —— 需要自己走一遍
 *   GitHub 的上传流程，再把拿到的链接塞进 Markdown。
 *
 * 现在走的是哪条路（一步到位）：
 *   POST https://uploads.github.com/user-attachments/assets
 *        ?name=<文件名>&content_type=<mime>&repository_id=<仓库数字 id>
 *   Authorization: Bearer <token>，请求体就是文件的原始字节。
 *   成功回 201 + {"url": "https://github.com/user-attachments/assets/<uuid>"}
 *
 *   这正是网页端拖拽上传用的那个接口，所以上传出来的附件会**继承仓库的
 *   可见性**（私有仓库里的图，外人打不开），比传到公共图床安全。
 *
 * 为什么不再用「先取策略再传 S3」的老三步：
 *   老流程第一步要打 https://api.github.com/upload/policies/assets，
 *   而 /upload/... 是 github.com（网页）的路由，api.github.com 上根本没有，
 *   服务端直接回 404 —— 界面上就只剩一句莫名其妙的「上传失败：Not Found」。
 *   老流程现在只作为兜底保留（万一新接口哪天被改掉），而且把域名改成了
 *   正确的 github.com。
 *
 * 关于「Validation Failed」（HTTP 422）：
 *   议题附件接口有**内容类型白名单** —— 只接受图片
 *   png/jpg/gif/webp/svg 和视频 mp4/mov/webm；bmp/heic/avif/mkv、
 *   zip/txt/pdf/apk/音频等一律 422，而且文件名扩展名必须与
 *   content_type 一致。directInfo 负责判定；不在白名单的文件改走
 *   「专用 Release 资产」兜底（见 uploadFallback，需要推送权限）。
 *
 * 关于 repository_id：
 *   必须是**数字 id**（GET /repos/{full} 的 .id）。用 GraphQL 那种
 *   MDEwOlJlcG9zaXRvcnkx… 的节点 id 会 404。拿不到就先不带这个参数上传。
 *
 * 依赖的原生能力：
 *   pickFile     选文件（可以限定 accept，比如 image/*,video/*）
 *   uploadRaw    流式二进制 POST（不把文件读进内存，适合十几 MB 的视频）
 *   http         普通 JSON 请求（查仓库 id 用）
 * ============================================================ */
(function () {
  'use strict';

  /* 一步直传的端点 */
  var UPLOAD_URL = 'https://uploads.github.com/user-attachments/assets';

  /* 兜底用：网页端同款的「上传策略」接口。
   * 注意是 github.com —— 写 api.github.com 会 404（就是之前那个 Not Found）。 */
  var LEGACY_POLICY_URL = 'https://github.com/upload/policies/assets';

  /**
   * GitHub 附件大小上限。
   * 图片 / GIF / 普通文件 10MB；视频免费计划 10MB、付费计划 100MB，
   * 所以视频先按 100MB 放行，超了让服务端自己说话（会带具体原因）。
   */
  var LIMIT_IMAGE = 10 * 1024 * 1024;
  var LIMIT_VIDEO = 100 * 1024 * 1024;
  var LIMIT_FILE = 10 * 1024 * 1024;

  /**
   * 议题附件接口的内容类型白名单（2026-10 实测）。
   * 白名单 MIME → 要求的扩展名（服务端会核对二者一致）。
   */
  var DIRECT_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm'
  };
  /* 扩展名 → 规范 MIME：提供方报的 MIME 不可靠（octet-stream 等）时按扩展名定 */
  var EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm'
  };

  /* 专用 Release 的 tag：白名单外的附件都挂在它下面，不污染代码分支 */
  var ATTACH_TAG = 'githup-attachments';

  /* 兜底附件大小上限：Release 资产官方允许 2GB，移动网络保守取 100MB */
  var LIMIT_FALLBACK = 100 * 1024 * 1024;

  /** 判断能不能选文件（浏览器环境没有原生桥，就退化成提示） */
  function canUpload() {
    return !!(window.Native && window.Native.canPick && window.Native.canPick());
  }

  /**
   * 根据当前所在页面判定下载分类：
   *   议题 / PR 详情 → '议题'；
   *   Release 详情   → 'release'；
   *   其它页面       → ''（直接放 githup/ 根目录）。
   * 依赖 Router.route（app.js 渲染时写入）。
   */
  function currentCategory() {
    var r = window.Router && Router.route;
    var name = r && r.name;
    if (name === 'issue') return '议题';
    if (name === 'release') return 'release';
    return '';
  }

  /** 人类可读的大小 */
  function fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** 是图片还是视频 —— 决定 Markdown 里怎么贴、按哪个上限卡 */
  function isImage(mime, name) {
    if (mime && /^image\//i.test(mime)) return true;
    return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i.test(name || '');
  }
  function isVideo(mime, name) {
    if (mime && /^video\//i.test(mime)) return true;
    return /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(name || '');
  }

  function kindOf(file) {
    return isImage(file.mime, file.name) ? 'image' : (isVideo(file.mime, file.name) ? 'video' : 'file');
  }

  /** 取小写扩展名（不含点）；没有返回空串 */
  function extOf(name) {
    var m = String(name || '').match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }

  /**
   * 判断文件能否走议题附件直传。
   * 先看 MIME 是否在白名单；MIME 不明确时退按扩展名判定。
   * 返回 {mime, name}：mime 为白名单规范类型，name 保证带匹配扩展名
   * （服务端校验「扩展名 == content_type」，不符就 422）；不能直传返回 null。
   */
  function directInfo(file) {
    var mime = file.mime ? String(file.mime).toLowerCase().split(';')[0].replace(/\s/g, '') : '';
    var ext = extOf(file.name);
    var canon = null;
    if (Object.prototype.hasOwnProperty.call(DIRECT_MIME, mime)) canon = mime;
    else if (Object.prototype.hasOwnProperty.call(EXT_MIME, ext)) canon = EXT_MIME[ext];
    if (!canon) return null;

    var wantExt = DIRECT_MIME[canon];
    var name = file.name || 'file';
    // 扩展名缺失 / 与规范类型不符：补或换成对的，否则必然 422
    if (ext !== wantExt) {
      name = (ext ? name.replace(/\.[a-z0-9]+$/i, '') : name) + '.' + wantExt;
    }
    return { mime: canon, name: name };
  }

  /** 把上传结果包成界面要的形状（图片用 ![]()，视频裸链，其它普通链接） */
  function pack(url, file) {
    var kind = kindOf(file);
    var md;
    if (kind === 'image') md = '![' + (file.name || '图片') + '](' + url + ')';
    else if (kind === 'video') md = url;      // GitHub 会自己渲染成播放器
    else md = '[' + (file.name || '附件') + '](' + url + ')';
    return { url: url, markdown: md, kind: kind, name: file.name, size: file.size };
  }

  /** 从 GitHub 的报错体里抠一句人话 */
  function parseErr(res) {
    try {
      var d = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
      var m = (d && (d.message || (d.errors && d.errors[0] && d.errors[0].message))) || '';
      if (m) return m;
    } catch (e) { /* 不是 JSON，走下面 */ }
    // S3 那类返回的是 XML，抠一下 <Message>...</Message>
    try {
      var mm = String(res && res.body || '').match(/<Message>([^<]+)<\/Message>/);
      if (mm) return mm[1];
    } catch (e2) { /* 忽略 */ }
    return '';
  }

  /** 把常见状态码翻成中文，别让用户对着 422 发呆 */
  function httpHint(code, msg) {
    if (code === 401) return '登录状态已失效，请重新登录';
    if (code === 403) return '没有该仓库的权限，或已触发速率限制';
    if (code === 404) return '上传接口不可用（404），可能是仓库 id 失效或仓库不可见';
    if (code === 422) return msg || '文件类型或大小不被接受（422）';
    return msg || ('上传失败（HTTP ' + code + '）');
  }

  /* ---------- 仓库数字 id ---------- */
  var _repoIds = Object.create(null);

  /**
   * 拿仓库的**数字** id（不是 GraphQL 的 node id）。
   * 拿不到就返回 null —— 调用方照样能传，只是附件不挂到具体仓库上。
   */
  function repoId(full) {
    if (!full || full.indexOf('/') < 0) return Promise.resolve(null);
    if (_repoIds[full] !== undefined) return Promise.resolve(_repoIds[full]);
    return window.API.get('/repos/' + full, null, { cache: 3600000 }).then(function (r) {
      var id = r && r.data && r.data.id;
      _repoIds[full] = id || null;
      return _repoIds[full];
    }).catch(function () {
      _repoIds[full] = null;
      return null;
    });
  }

  /**
   * 一步直传：POST uploads.github.com/user-attachments/assets
   * 请求体就是文件本身，走原生流式发送，十几 MB 的视频也不会撑爆内存。
   * @param info directInfo 的结果：用规范 MIME 与已校正扩展名的文件名
   */
  function uploadDirect(file, info, repoFull) {
    return repoId(repoFull).then(function (rid) {
      var q = 'name=' + encodeURIComponent(info.name) +
        '&content_type=' + encodeURIComponent(info.mime);
      if (rid) q += '&repository_id=' + encodeURIComponent(rid);
      var url = UPLOAD_URL + '?' + q;

      var headers = {
        'Authorization': 'Bearer ' + ((window.Session && window.Session.token) || ''),
        'Accept': 'application/json',
        'Content-Type': info.mime,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'githup/1.0'
      };

      // 有专用流式通道就用；老版本应用没有 uploadRaw 时，
      // 退成「头尾为空的 multipart」—— 效果等价于裸体 POST。
      var p;
      if (window.Native && window.Native.uploadRaw) {
        p = window.Native.uploadRaw(url, file.uri, headers);
      } else {
        p = window.Native.uploadMultipart(url, file.uri, headers, '', '');
      }

      return p.then(function (res) {
        var code = (res && res.status) || 0;
        if (!code || code >= 400) {
          var e = new Error(httpHint(code, parseErr(res)));
          e.status = code;
          throw e;
        }
        var data = null;
        try { data = res.body ? JSON.parse(res.body) : null; } catch (e2) { data = null; }
        // 成功体形如 {"url":"https://github.com/user-attachments/assets/<uuid>"}
        // 也见过套一层 asset 的，一并兜住
        var u = data && (data.url || data.href ||
          (data.asset && (data.asset.href || data.asset.url)));
        if (!u) {
          var e3 = new Error('上传成功但没拿到链接，请重试');
          e3.status = code;
          throw e3;
        }
        return pack(u, file);
      });
    });
  }

  /**
   * 老三步（兜底）：取策略 → 传 S3 → 拼链接。
   * 只在直传接口整个不存在（404/405/410/501）时才试，平时用不到。
   */
  function requestPolicy(file) {
    var body = {
      name: file.name,
      size: file.size,
      content_type: file.mime || 'application/octet-stream'
    };
    return window.API.post(LEGACY_POLICY_URL, body).then(function (r) {
      var d = r && r.data;
      if (!d || !d.upload_url) throw new Error('拿不到上传策略（登录状态或网络异常）');
      return d;
    });
  }

  /** 把策略字段拼成 multipart 表单体；file 必须是最后一个字段，否则 S3 拒收 */
  function buildMultipart(policy, file) {
    var boundary = '----githup' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    var CRLF = '\r\n';
    var head = '';

    var fields = policy.form || policy.upload_authenticity_token || {};
    var pairs = [];
    if (Array.isArray(policy.form)) {
      pairs = policy.form;
    } else if (policy.form && typeof policy.form === 'object') {
      Object.keys(policy.form).forEach(function (k) { pairs.push({ key: k, value: policy.form[k] }); });
    } else if (fields && typeof fields === 'string') {
      pairs.push({ key: 'authenticity_token', value: fields });
    }

    pairs.forEach(function (p) {
      head += '--' + boundary + CRLF;
      head += 'Content-Disposition: form-data; name="' + p.key + '"' + CRLF + CRLF;
      head += String(p.value == null ? '' : p.value) + CRLF;
    });

    head += '--' + boundary + CRLF;
    head += 'Content-Disposition: form-data; name="file"; filename="' + encodeURIComponent(file.name) + '"' + CRLF;
    head += 'Content-Type: ' + (file.mime || 'application/octet-stream') + CRLF + CRLF;

    return {
      boundary: boundary,
      head: head,
      tail: CRLF + '--' + boundary + '--' + CRLF
    };
  }

  /** 老流程里「拿到最终链接」这一步 */
  function legacyFinish(policy, file) {
    var asset = policy.asset || {};
    var finalUrl = asset.href || asset.url || '';
    if (!finalUrl && asset.id) finalUrl = 'https://github.com/user-attachments/assets/' + asset.id;
    if (!finalUrl) throw new Error('上传成功但没拿到链接，请重试或改用网页端');
    return pack(finalUrl, file);
  }

  function uploadLegacy(file) {
    return requestPolicy(file).then(function (policy) {
      var mp = buildMultipart(policy, file);
      var url = policy.upload_url + (policy.upload_url.indexOf('?') >= 0 ? '&' : '?') +
        'name=' + encodeURIComponent(file.name);
      var headers = {
        'Content-Type': 'multipart/form-data; boundary=' + mp.boundary,
        'Accept': 'application/json, text/plain, */*'
      };
      return window.Native.uploadMultipart(url, file.uri, headers, mp.head, mp.tail).then(function (res) {
        var code = res && res.status;
        if (!code || code >= 400) {
          var e = new Error(parseErr(res) || ('上传失败（HTTP ' + code + '）'));
          e.status = code || 0;
          throw e;
        }
        return legacyFinish(policy, file);
      });
    });
  }

  /* ---------- 白名单外的文件：专用 Release 兜底 ---------- */
  var _attachRel = Object.create(null);   // full → release 对象缓存

  /**
   * 找到（没有就自动创建）存放议题附件的专用 Release。
   * 需要对仓库有推送权限；失败错误带 status，由上层翻译成人话。
   */
  function ensureAttachRelease(full) {
    if (!full || full.indexOf('/') < 0) {
      return Promise.reject(new Error('缺少仓库信息，无法上传此类文件'));
    }
    if (_attachRel[full]) return Promise.resolve(_attachRel[full]);
    return window.API.get('/repos/' + full + '/releases', { per_page: 100 }).then(function (r) {
      var hit = (r.data || []).filter(function (x) { return x.tag_name === ATTACH_TAG; })[0];
      if (hit) return hit;
      return window.API.post('/repos/' + full + '/releases', {
        tag_name: ATTACH_TAG,
        name: '议题附件（githup 自动）',
        body: '由 githup App 自动创建，用来存放议题中上传的非图片/视频附件。可随时删除。'
      }).then(function (rr) { return rr.data; });
    }).then(function (rel) {
      _attachRel[full] = rel;
      return rel;
    });
  }

  /**
   * 把白名单外的文件传到专用 Release，返回与直传同形状的结果。
   * 资产名加「日期-时间」前缀，同一秒重复上传再追加序号，保证不撞名。
   */
  function uploadFallback(file, repoFull) {
    return ensureAttachRelease(repoFull).then(function (rel) {
      var d = new Date();
      var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
      var stamp = String(d.getFullYear()) + p2(d.getMonth() + 1) + p2(d.getDate()) +
        '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
      var base = file.name || 'file';
      var taken = {};
      (rel.assets || []).forEach(function (a) { taken[a.name] = 1; });
      var finalName = stamp + '-' + base;
      var n = 1;
      while (taken[finalName]) {
        finalName = stamp + '-' + n + '-' + base;
        n++;
      }

      var up = 'https://uploads.github.com/repos/' + repoFull + '/releases/' +
        rel.id + '/assets?name=' + encodeURIComponent(finalName);
      var headers = {
        'Authorization': 'Bearer ' + ((window.Session && window.Session.token) || ''),
        'Accept': 'application/json',
        'Content-Type': file.mime || 'application/octet-stream',
        'User-Agent': 'githup/1.0'
      };
      var q;
      if (window.Native && window.Native.uploadRaw) {
        q = window.Native.uploadRaw(up, file.uri, headers);
      } else {
        q = window.Native.uploadMultipart(up, file.uri, headers, '', '');
      }
      return q.then(function (res) {
        var code = res && res.status;
        if (!code || code >= 400) {
          var e = new Error(httpHint(code, parseErr(res)));
          e.status = code;
          throw e;
        }
        var data = null;
        try { data = res.body ? JSON.parse(res.body) : null; } catch (e2) { data = null; }
        var u = data && data.browser_download_url;
        if (!u) throw new Error('上传成功但没拿到下载链接，请重试');
        // 白名单外的图片/视频（bmp/heic/mkv…）GitHub 不保证内联，统一做成
        // 可点击的下载链接，避免贴一条光秃秃、不渲染的网址
        var packed = pack(u, file);
        if (packed.kind !== 'file') {
          packed.kind = 'file';
          packed.markdown = '[' + (file.name || '附件') + '](' + u + ')';
        }
        return packed;
      });
    }).catch(function (e) {
      // 403/404 基本就是没权限或仓库不可见：把 GitHub 的平台限制讲清楚
      if (e && (e.status === 403 || e.status === 404)) {
        throw new Error('GitHub 只允许在议题中直接附加图片和视频；「' +
          (file.name || '该文件') + '」属于其他类型，需要先推送到仓库或 Release，' +
          '而你对该仓库没有推送权限。');
      }
      throw e;
    });
  }

  /**
   * 上传一个文件，返回可直接写进 Markdown 的链接。
   *
   * @param {object} file  pickFile 返回的 {uri,name,size,mime}
   * @param {string} repoFull 形如 Buwrt/githup
   * @return {Promise<{url:string, markdown:string, kind:string, name:string, size:number}>}
   */
  function upload(file, repoFull) {
    if (!file || !file.uri) return Promise.reject(new Error('没有选中文件'));

    var info = directInfo(file);
    var limit = info
      ? (/^image\//.test(info.mime) ? LIMIT_IMAGE : LIMIT_VIDEO)
      : LIMIT_FALLBACK;
    if (file.size && file.size > limit) {
      return Promise.reject(new Error('文件 ' + fmtSize(file.size) + ' 超过上限（' + fmtSize(limit) + '）'));
    }
    if (window.Native && !window.Native.uploadRaw && !window.Native.uploadMultipart) {
      return Promise.reject(new Error('当前版本不支持附件上传'));
    }

    // 不在白名单：走专用 Release 兜底
    if (!info) return uploadFallback(file, repoFull);

    return uploadDirect(file, info, repoFull).catch(function (e) {
      var s = e && e.status;
      // 只有「接口本身不存在/不支持」时才换老路走一遍
      if (s === 404 || s === 405 || s === 410 || s === 501) return uploadLegacy(file);
      throw e;
    });
  }

  /**
   * 一站式：选文件 → 上传 → 回调链接。
   * 界面层只要调这个就够。
   *
   * 支持一次选多个：逐个上传（串行，避免同时开好几条大流量连接），
   * 全部完成后一起返回 —— 界面上表现为「按钮一直转，转完把链接都插进去」。
   *
   * @param {object} opt {repoFull, accept, onProgress, multiple}
   * @return {Promise<Array>} 上传结果数组（取消时为空数组）
   */
  function pickAndUpload(opt) {
    opt = opt || {};
    if (!window.Session || !window.Session.isLogin) {
      return Promise.reject(new Error('请先登录'));
    }
    if (!canUpload()) {
      return Promise.reject(new Error('当前环境不支持选择文件'));
    }

    var accept = opt.accept || 'image/*,video/*';
    // 多选走 pickFiles；只有明确单选时才用 pickFile
    var picker = (opt.multiple === false) ? window.Native.pickFile(accept).then(function (m) {
      return m ? [m] : [];
    }) : window.Native.pickFiles(accept);

    return picker.then(function (list) {
      if (!list || !list.length) return [];   // 用户取消了

      var out = [];
      var failed = [];
      // 串行上传：大文件并发会把连接和内存一起挤爆
      var chain = Promise.resolve();
      list.forEach(function (meta, idx) {
        chain = chain.then(function () {
          if (opt.onProgress) opt.onProgress(idx / list.length, meta);
          return upload(meta, opt.repoFull).then(function (r) {
            out.push(r);
            if (opt.onProgress) opt.onProgress((idx + 1) / list.length, meta);
          }).catch(function (e) {
            // 一个失败不拖累其它：记下来继续传下一个
            failed.push({ name: meta.name, message: e && e.message ? e.message : '上传失败' });
          });
        });
      });

      return chain.then(function () {
        if (!out.length && failed.length) {
          throw new Error(failed.length === 1
            ? failed[0].message
            : (failed.length + ' 个文件上传失败：' + failed[0].message));
        }
        // 部分成功时把失败的一并告知，界面层决定怎么提示
        out.failed = failed;
        return out;
      });
    });
  }

  /**
   * 完整的「点按钮 → 选文件 → 上传 → 插入 Markdown」一条龙，
   * 供各处编辑器（议题评论 / 新建议题 / 新建 PR）共用，避免每处各写一遍。
   *
   * @param {HTMLElement} btn 被点的按钮：上传期间禁用，结束/失败后恢复
   * @param {HTMLTextAreaElement} ta 要插入内容的输入框
   * @param {object} opt
   *   repoFull 仓库全名（如 Buwrt/githup）
   *   accept   文件类型过滤：图片视频给 image、video 类型；任意附件给全类型
   *   hint     弹选择器前的提示语
   * @return {Promise} 已做完全部兜底，调用方不用再 catch
   */
  function pickInsert(btn, ta, opt) {
    opt = opt || {};
    if (!window.Session || !window.Session.isLogin) {
      return Promise.resolve(UI.toast('请先登录'));
    }
    if (!canUpload()) {
      return UI.confirm('需要应用内支持',
        '当前环境无法选择本地文件，请安装最新版应用后重试。', '知道了')
        .then(function () {});
    }
    btn.disabled = true;
    UI.toast(opt.hint || '请选择文件');
    return pickAndUpload({
      repoFull: opt.repoFull,
      multiple: true,
      accept: opt.accept || '*/*'
    }).then(function (arr) {
      btn.disabled = false;
      if (!arr || !arr.length) return;             // 用户取消
      var md = arr.map(function (r) { return r.markdown; }).join('\n\n');
      // insertAtCursor 由 page-repo.js 挂到 window；没有时就地兜底
      if (window.insertAtCursor) window.insertAtCursor(ta, '\n' + md + '\n');
      else ta.value += '\n' + md + '\n';
      var nImg = arr.filter(function (r) { return r.kind === 'image'; }).length;
      var nVid = arr.filter(function (r) { return r.kind === 'video'; }).length;
      var nFile = arr.filter(function (r) { return r.kind === 'file'; }).length;
      var parts = [];
      if (nImg) parts.push(nImg + ' 张图片');
      if (nVid) parts.push(nVid + ' 个视频');
      if (nFile) parts.push(nFile + ' 个文件');
      UI.toast((parts.join('、') || '附件') + '已插入');
      if (arr.failed && arr.failed.length) {
        UI.toast(arr.failed.length + ' 个文件上传失败：' + arr.failed[0].message);
      }
    }).catch(function (e) {
      btn.disabled = false;
      UI.toast('上传失败：' + (e && e.message ? e.message : '未知错误'));
    });
  }

  window.Attach = {
    MAX_SIZE: LIMIT_FILE,
    LIMIT_IMAGE: LIMIT_IMAGE,
    LIMIT_VIDEO: LIMIT_VIDEO,
    canUpload: canUpload,
    currentCategory: currentCategory,
    isImage: isImage,
    isVideo: isVideo,
    fmtSize: fmtSize,
    upload: upload,
    pickAndUpload: pickAndUpload,
    pickInsert: pickInsert,
    requestPolicy: requestPolicy,
    buildMultipart: buildMultipart
  };
})();
