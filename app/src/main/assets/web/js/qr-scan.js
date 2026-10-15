/* ============================================================
 * qr-scan.js —— 「从相册选一张图，把里面的二维码读出来」
 *
 * 为什么不用系统扫码 / 相机：
 *   扫码加入 TOTP 账户这个场景，用户手里往往**已经有**那张二维码
 *   截图（网站给的就是一张图，很多人先截图再切过来）。
 *   走相册比调相机更快，而且——
 *     - 不需要申请相机权限（少一条权限就少一层顾虑）；
 *     - 不需要额外依赖（解码逻辑自带，见 qr-decode.js）；
 *     - 装在模拟器/平板/没有摄像头的设备上照样能用；
 *     - 截图、翻拍的屏、别人发来的图，都能读。
 *
 * 对外只暴露两个方法：
 *   QRScan.available()            —— 当前环境能不能用
 *   QRScan.scanFromGallery()      —— 返回 Promise<string|null>
 *                                    解出二维码文本，取消或失败返回 null
 * ============================================================ */
(function () {
  'use strict';

  /* 解码前先把图缩到这个边长以内。
     为什么这么做：
       1) 手机照片动辄 3000~4000 万像素，整图 getImageData 会吃几十 MB 内存，
          低端机上直接 OOM；二维码本身不需要那么高的分辨率。
       2) 解码是逐像素扫的，图越大越慢。缩到 1400 左右，
          足够「截图里的二维码」和「拍屏幕」这类场景，耗时也能压到几十毫秒。
     为什么不缩得更小：QR 的模块最少只有 1~2 像素宽，
     缩太狠会把模块糊成一片，反而解不出来。1400 是实测的平衡点。 */
  var MAX_EDGE = 1400;

  /* Base64 -> Blob。比拼 data: URL 稳：
     data URL 在部分 WebView 上对超长字符串（几 MB 的照片）会截断。 */
  function b64ToBlob(b64, mime) {
    var bin = window.atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'image/jpeg' });
  }

  /* Blob -> ImageBitmap（优先）或 Image（兜底） */
  function blobToBitmap(blob) {
    if (window.createImageBitmap) {
      return window.createImageBitmap(blob).catch(function () {
        return blobToImage(blob);
      });
    }
    return blobToImage(blob);
  }

  function blobToImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片无法解码')); };
      img.src = url;
    });
  }

  /* 把任意尺寸的图，等比缩到 MAX_EDGE 以内，并取回 ImageData */
  function toImageData(bitmap) {
    var sw = bitmap.width || bitmap.naturalWidth;
    var sh = bitmap.height || bitmap.naturalHeight;
    if (!sw || !sh) throw new Error('图片尺寸无效');

    var scale = 1;
    if (Math.max(sw, sh) > MAX_EDGE) scale = MAX_EDGE / Math.max(sw, sh);
    var tw = Math.max(1, Math.round(sw * scale));
    var th = Math.max(1, Math.round(sh * scale));

    var canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    var ctx = canvas.getContext('2d');
    /* 缩放时开平滑 —— 相当于给图像做了一次抗锯齿，
       比「最近邻缩放」更容易被解码器采到正确的模块边界。 */
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, tw, th);
    var out = ctx.getImageData(0, 0, tw, th);

    /* 用完即放，别等 GC */
    if (bitmap.close) { try { bitmap.close(); } catch (e) {} }
    canvas.width = canvas.height = 0;
    return out;
  }

  /* 环境自检：需要有选文件能力 + 二维码解码器 + canvas
     注意选文件方法挂在 window.Native 上（page-repo / upload-attach 同款），
     window.API 是 GitHub REST 封装、没有这些方法 —— 之前写错过一回，
     结果真机上按钮被 available() 判成不可用直接隐藏了。 */
  function available() {
    try {
      if (!window.QRDecode || typeof window.QRDecode.fromImageData !== 'function') return false;
      if (!window.Native || typeof window.Native.pickFile !== 'function') return false;
      if (!window.Native.canPick || !window.Native.canPick()) return false;
      var c = document.createElement('canvas');
      return !!(c.getContext && c.getContext('2d'));
    } catch (e) {
      return false;
    }
  }

  /**
   * 从相册选一张图并识别其中的二维码。
   *
   * @return {Promise<{text:string,meta:object}|null>}
   *         成功： { text: 二维码内容, meta: 原文件信息 }
   *         取消 / 认不出 / 出错： null（不抛异常，调用方只需判空）
   */
  function scanFromGallery() {
    if (!available()) return Promise.resolve(null);

    return window.Native.pickFile('image/*').then(function (file) {
      if (!file || !file.uri) return null;

      /* 读图上限设 12MB —— 手机原图一般 3~8MB，12MB 能覆盖绝大多数，
         又挡住了「误选几十 MB 的 RAW/全景图」把内存打爆的情况。 */
      return window.Native.readFileBase64(file.uri, 12 * 1024 * 1024)
        .then(function (b64) {
          if (!b64) return null;
          var blob = b64ToBlob(b64, file.mime || 'image/jpeg');
          return blobToBitmap(blob);
        })
        .then(function (bitmap) {
          if (!bitmap) return null;
          var imgData = toImageData(bitmap);
          var text = window.QRDecode.fromImageData(imgData);
          imgData = null;
          if (!text) return null;
          return { text: text, meta: file };
        });
    }).catch(function () {
      /* 选图失败、读取失败、图片损坏……统一返回 null。
         调用方只关心「有没有读到东西」。 */
      return null;
    });
  }

  window.QRScan = {
    available: available,
    scanFromGallery: scanFromGallery,
    MAX_EDGE: MAX_EDGE
  };
})();
