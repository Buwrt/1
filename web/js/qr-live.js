/* ============================================================
 * qr-live.js —— 「扫一扫」：开后置摄像头，对准二维码自动识别
 *
 * 跟 qr-scan.js（从相册选图）是互补的两条路：
 *   相册选图 —— 网站给了截图、或者码在别人发来的图里；
 *   扫一扫   —— 码就在电脑屏幕上，掏出手机对着一照最快。
 *
 * 实现走的 WebView 标准 getUserMedia 路线，零第三方库：
 *   ① Native.requestCamera()  —— 先把原生 CAMERA 权限要到手
 *      （App 没这个权限时 WebView 连问都不问、直接拒绝，见 JsBridge 注释）；
 *   ② MainActivity 的 onPermissionRequest 把摄像头批给渲染进程；
 *   ③ getUserMedia({facingMode:'environment'}) 开后置；
 *   ④ 每 ~130ms 抽一帧缩到 640px 以内，喂给 qr-decode.js 解；
 *   ⑤ 解出即停，返回文本；用户点 ✕ 随时退出。
 *
 * 对外只暴露两个方法：
 *   QRLive.available()      —— 当前环境能不能用
 *   QRLive.scanLive()       —— Promise<string|null>，取消/失败返回 null
 * ============================================================ */
(function () {
  'use strict';

  /* 抽帧送解的边长上限。取景是「对着屏幕近距离拍」，码通常占画面一大半，
     640 足够；更大只是白白拖慢每次解码。 */
  var SAMPLE_EDGE = 640;
  /* 两次解码之间的间隔。解码本身 10~60ms，这个节奏不卡画面也不费电。 */
  var INTERVAL = 130;

  /* 当前正在进行的那次扫码的「结束」入口。
     扫描中非 null；结束（解出 / 取消 / 失败）后立刻置回 null。

     为什么必须留这个引用 —— 返回键是原生事件，DOM 自己收不到，
     只能由 App.handleBack() 转过来调。没有它，用户在取景界面按返回键
     前端无从下手（这层浮层既不是路由、也不是 #sheet-root 弹层），
     返回键会一路落到「路由回退 / 再按一次退出」，
     而浮层是 body 的直接子元素、盖在路由之上 ——
     于是页面变了、相机却还开着，看着就像返回键没反应。 */
  var activeFinish = null;

  /* ---- 环境自检：解码器 + 浏览器媒体能力 + 原生相机权限通道 ---- */
  function available() {
    try {
      if (!window.QRDecode || typeof window.QRDecode.fromImageData !== 'function') return false;
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return false;
      if (!window.Native || typeof window.Native.requestCamera !== 'function') return false;
      if (!window.NativeBridge || typeof window.NativeBridge.requestCamera !== 'function') return false;
      var v = document.createElement('video');
      return typeof v.play === 'function' && typeof v.srcObject !== 'undefined';
    } catch (e) {
      return false;
    }
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* 停流 + 拆 DOM。stream / raf / timer 全部收掉，别留后台功耗。 */
  function teardown(hold) {
    if (hold.timer) { clearTimeout(hold.timer); hold.timer = null; }
    if (hold.stream) {
      try {
        var tracks = hold.stream.getVideoTracks();
        for (var i = 0; i < tracks.length; i++) {
          try { tracks[i].stop(); } catch (e) {}
        }
      } catch (e) {}
      hold.stream = null;
    }
    if (hold.mask && hold.mask.parentNode) hold.mask.parentNode.removeChild(hold.mask);
    hold.mask = null;
    hold.video = null;
    hold.canvas = null;
  }

  /**
   * 打开取景层并持续识别。
   * @return {Promise<string|null>} 解出二维码文本；用户取消/失败为 null
   */
  function scanLive() {
    return new Promise(function (resolve) {
      if (!available()) { resolve(null); return; }

      var done = false;
      var hold = { stream: null, mask: null, video: null, canvas: null, timer: null };

      function finish(text) {
        if (done) return;
        done = true;
        activeFinish = null;
        teardown(hold);
        /* 振一下当作「扫到了」的触感反馈（不支持就安静跳过） */
        if (text && navigator.vibrate) {
          try { navigator.vibrate(60); } catch (e) {}
        }
        resolve(text || null);
      }

      /* ---- 搭取景层 ---- */
      var mask = el('div', 'qrl-mask');
      var video = el('video', 'qrl-video');
      video.setAttribute('playsinline', 'playsinline');
      video.setAttribute('muted', 'muted');
      video.setAttribute('autoplay', 'autoplay');

      var frame = el('div', 'qrl-frame');
      for (var ci = 0; ci < 4; ci++) frame.appendChild(el('i', 'qrl-c' + ci));
      var laser = el('i', 'qrl-laser');
      frame.appendChild(laser);

      var tip = el('div', 'qrl-tip', '正在打开相机…');
      var closeBtn = el('button', 'qrl-close', '✕ 关闭');
      closeBtn.type = 'button';
      closeBtn.addEventListener('click', function () { finish(null); });

      mask.appendChild(video);
      mask.appendChild(frame);
      mask.appendChild(tip);
      mask.appendChild(closeBtn);
      document.body.appendChild(mask);
      hold.mask = mask;
      hold.video = video;

      /* 登记本次会话：外部（返回键）通过 QRLive.cancel() 收摊。
         解出门的那一刻 finish 会把它清掉，不会留悬空引用。 */
      activeFinish = function () { finish(null); };

      /* ---- ① 原生相机权限（WebView 的 getUserMedia 前置条件） ---- */
      window.Native.requestCamera().then(function (granted) {
        if (done) return;
        if (!granted) {
          tip.textContent = '没有相机权限，去系统设置里允许「相机」后再试';
          setTimeout(function () { finish(null); }, 1800);
          return;
        }

        /* ---- ② 开后置摄像头 ---- */
        var constraints = {
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        };
        navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
          if (done) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} return; }
          hold.stream = stream;
          /* 相机被系统/用户掐断（切后台被回收等）：收摊退出 */
          try {
            var vt = stream.getVideoTracks()[0];
            if (vt && vt.addEventListener) {
              vt.addEventListener('ended', function () { finish(null); });
            }
          } catch (e) {}

          video.srcObject = stream;
          var playP;
          try { playP = video.play(); } catch (e) { playP = null; }
          var ready = Promise.all([
            new Promise(function (res) {
              if (video.readyState >= 2) { res(); return; }
              video.addEventListener('loadeddata', res, { once: true });
              /* 个别机型不发 loadeddata：2 秒后强行开始，靠 readyState 兜 */
              setTimeout(res, 2000);
            }),
            playP ? Promise.resolve(playP).catch(function () {}) : Promise.resolve()
          ]);

          ready.then(function () { startLoop(); });
        }).catch(function () {
          tip.textContent = '相机打开失败，请重试或改用「从图片识别二维码」';
          setTimeout(function () { finish(null); }, 2200);
        });
      });

      /* ---- ③ 抽帧解码循环 ---- */
      function startLoop() {
        if (done) return;
        tip.textContent = '对准二维码，识别后自动填入';
        var vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) { hold.timer = setTimeout(startLoop, 120); return; }

        /* 竖屏时画面常被 object-fit:cover 裁切 —— 但解码用整帧即可，
           cover 只影响观感不影响识别（码只要在画面里就行）。 */
        var scale = Math.min(1, SAMPLE_EDGE / Math.max(vw, vh));
        var tw = Math.max(1, Math.round(vw * scale));
        var th = Math.max(1, Math.round(vh * scale));

        if (!hold.canvas) {
          hold.canvas = document.createElement('canvas');
          hold.canvas.width = tw;
          hold.canvas.height = th;
        }
        var ctx = hold.canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) { finish(null); return; }

        function tick() {
          if (done) return;
          try {
            if (video.readyState >= 2 && video.videoWidth) {
              /* 视频尺寸可能与首次不同（旋转/切镜头）：跟着调 */
              if (hold.canvas.width !== tw || hold.canvas.height !== th) {
                hold.canvas.width = tw;
                hold.canvas.height = th;
              }
              ctx.drawImage(video, 0, 0, tw, th);
              var img = ctx.getImageData(0, 0, tw, th);
              var text = window.QRDecode.fromImageData(img);
              img = null;
              if (text) { finish(text); return; }
            }
          } catch (e) { /* 单帧失败不影响下一帧 */ }
          hold.timer = setTimeout(tick, INTERVAL);
        }
        tick();
      }
    });
  }

  window.QRLive = {
    available: available,
    scanLive: scanLive,
    /** 取景层是否正开着 —— 返回键据此决定要不要先关它 */
    isActive: function () { return activeFinish !== null; },
    /** 关掉取景层（等同用户点「✕ 关闭」），未打开时无事发生 */
    cancel: function () { if (activeFinish) { activeFinish(); return true; } return false; },
    SAMPLE_EDGE: SAMPLE_EDGE,
    INTERVAL: INTERVAL
  };
})();
