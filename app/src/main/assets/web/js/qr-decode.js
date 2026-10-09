/* ============================================================
 * qr-decode.js — 纯 JS 二维码解码器
 *
 * 为什么自己写：
 *   系统 WebView 不提供 BarcodeDetector（实测 Android WebView 上没有
 *   可用的二维码检测后端），而本项目是「零第三方依赖」的 ——
 *   引一个解码库进来会破坏这个前提。所以在本地实现完整链路。
 *
 * 解码链路（逐段可独立验证）：
 *   1. 灰度化 + 自适应二值化（局部均值，抗不均匀光照）
 *   2. 定位图案（Finder Pattern）扫描：1:1:3:1:1 的比例特征
 *   3. 由三个定位点 + 对齐图案求出透视变换，把码「拉正」
 *   4. 按模块中心采样，得到 0/1 位矩阵
 *   5. 解析格式信息（版本 + 纠错级别），用 BCH 纠错
 *   6. 掩码去除
 *   7. Reed-Solomon 纠错，还原数据码字
 *   8. 按模式段解析位流（数字 / 字母数字 / 字节 / 汉字）
 *
 * 对外只有一个入口：
 *   window.QRDecode.fromImageData(imageData) -> string | null
 *     imageData: { data: Uint8ClampedArray, width, height }（RGBA）
 *   解不出来返回 null，绝不抛异常。
 *
 * 参考：ISO/IEC 18004（二维码规范）。实现思路与 jsQR 同源，
 * 但按本项目的 ES5 风格重写，不引任何外部代码。
 * ============================================================ */
(function () {
  'use strict';

  /* ============================================================
   * 第一部分：位流读取器
   * ============================================================ */

  function BitStream(bytes) {
    this.bytes = bytes;
    this.byteOffset = 0;
    this.bitOffset = 0;
  }

  BitStream.prototype.readBits = function (n) {
    var result = 0;
    for (var i = 0; i < n; i++) {
      var b = this.bytes[this.byteOffset];
      if (b === undefined) return -1;
      var bit = (b >> (7 - this.bitOffset)) & 1;
      result = (result << 1) | bit;
      this.bitOffset++;
      if (this.bitOffset === 8) { this.bitOffset = 0; this.byteOffset++; }
    }
    return result;
  };

  BitStream.prototype.available = function () {
    return (this.bytes.length - this.byteOffset) * 8 - this.bitOffset;
  };

  /* ============================================================
   * 第二部分：Reed-Solomon 纠错
   *
   * 二维码用 GF(256)，本原多项式 0x11D，生成元 2。
   * 每个块尾部带着若干纠错码字，最多能纠正 每块ec/2 个符号错误。
   * ============================================================ */

  /* GF(256) 的指数 / 对数表：预计算，避免运行时反复乘除 */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x = x << 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /**
   * 生成多项式 g(x) = (x - a^0)(x - a^1)...(x - a^(n-1))
   * 以「系数从高次到低次」的数组返回。
   */
  function rsGenPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var ng = new Array(g.length + 1);
      for (var k = 0; k < ng.length; k++) ng[k] = 0;
      for (var j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gfMul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  /* 生成多项式缓存：同 ec 长度反复用 */
  var GEN_CACHE = {};
  function genPoly(n) {
    if (!GEN_CACHE[n]) GEN_CACHE[n] = rsGenPoly(n);
    return GEN_CACHE[n];
  }

  /**
   * 计算纠错码字。
   * @param {number[]} data 数据码字
   * @param {number} ecCount 需要的纠错码字个数
   * @return {number[]} ecCount 个纠错码字
   */
  function rsEncode(data, ecCount) {
    var gen = genPoly(ecCount);
    var res = new Array(ecCount);
    for (var i = 0; i < ecCount; i++) res[i] = 0;
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ res[0];
      res.shift();
      res.push(0);
      if (factor !== 0) {
        for (var j = 0; j < ecCount; j++) {
          res[j] ^= gfMul(gen[j + 1], factor);
        }
      }
    }
    return res;
  }

  /**
   * 多项式求值（Horner），用于求 syndrome。
   */
  function polyEval(poly, x) {
    var y = poly[0];
    for (var i = 1; i < poly.length; i++) y = gfMul(y, x) ^ poly[i];
    return y;
  }

  /**
   * 用 Berlekamp-Massey + Chien + Forney 做 RS 纠错。
   *
   * @param {number[]} received 收到的码字（数据+纠错，长度 = n）
   * @param {number} ecCount 纠错码字个数
   * @return {number[]|null} 纠错后的完整码字；修不出来返回 null
   */
  /* ────────────────────────────────────────────────────────────
   * Reed-Solomon 纠错（标准 Berlekamp-Massey + Chien + Forney）
   *
   * 约定（与 rsEncode / genPoly 保持一致）：
   *   码字多项式 R(x) 的「系数高次在前」，即 received[0] 是最高次项。
   *   生成多项式 g(x) = (x-α^0)(x-α^1)...(x-α^(ec-1))
   *   所以合法的码字满足 R(α^i) = 0，i = 0..ec-1。
   *
   * 算法分四步：
   *   1) 求 syndrome  s[i] = R(α^i)     —— 全零说明没错，直接返回
   *   2) BM 迭代求错误定位多项式 Λ(x)  —— Λ 的根对应错误位置
   *   3) Chien search 找根            —— 把幂次换算成码字下标
   *   4) Forney 求错误值 ω(x)/Λ'(x)   —— 逐位异或修正
   *
   * 关于数组方向的说明（这是最容易写错的地方）：
   *   syndrome 序列 s[0], s[1], ... 用的是**升幂**索引（s[i] 对应 α^i），
   *   而 Λ(x) 用**降幂**存储（λ[0] 是最高次）。两处方向不同，
   *   写的时候必须心里有数，否则 BM 的 discrepancy 累加会全错 ——
   *   这正是旧版实现「一位错都纠不了」的原因。
   * ────────────────────────────────────────────────────────────
   */
  function rsDecode(received, ecCount) {
    var n = received.length;
    if (n === 0 || ecCount <= 0 || n <= ecCount) return null;

    /* ---- 1. syndrome：升幂存，s[i] = R(α^i) ---- */
    var syn = new Array(ecCount);
    var hasError = false;
    for (var i = 0; i < ecCount; i++) {
      syn[i] = polyEval(received, EXP[i]);
      if (syn[i] !== 0) hasError = true;
    }
    if (!hasError) return received.slice();

    /* ---- 2. Berlekamp-Massey ----
     * Λ 用「降幂」数组表示：lambda[0] 恒为 1（首一多项式），
     * lambda[j] 是 x^(deg-j) 的系数。
     * 迭代中维护 prev（上一轮的 Λ）与 prevDegL 的位移量。 */
    var lambda = new Array(ecCount + 1);
    var prev = new Array(ecCount + 1);
    for (i = 0; i <= ecCount; i++) { lambda[i] = 0; prev[i] = 0; }
    /* ── 统一的数组约定：定长降幂 ──────────────────────────────
     * 所有多项式都存成长度 ecCount+1 的数组，且
     *     arr[k] 恒表示 x^(ecCount-k) 的系数
     * 于是 arr[0] = x^ecCount 的系数，arr[ecCount] = 常数项。
     * 常数多项式 1 就是 arr[ecCount] = 1。
     *
     * 用这个约定有两个好处：
     *   - 乘 x^shift 只是「下标整体减小 shift」，不用管次数变化；
     *   - 两式相加天然对齐，不需要先补齐长度。
     * 早先版本混用了「不定长降幂」和「定长降幂」两套下标，
     * 结果 Λ 算出来是个常数 1，一位错都纠不了。 */
    lambda[ecCount] = 1;
    prev[ecCount] = 1;
    var L = 0;          /* 当前 LFSR 长度 = 已定位的错误数 */
    var m = 1;          /* prev 相对当前的位移量 */
    var b = 1;          /* prev 归一化时用到的常数 */

    /* 「x^j 的系数」的下标：定长降幂下是 ecCount - j */
    for (var nIdx = 0; nIdx < ecCount; nIdx++) {
      /* discrepancy：d = Σ_{j=0..L} λ_j · s[n-j]，λ_j 是 x^j 的系数 */
      var d = syn[nIdx];
      for (var j = 1; j <= L; j++) {
        d ^= gfMul(lambda[ecCount - j], syn[nIdx - j]);
      }

      if (d === 0) {
        m++;
      } else if (2 * L <= nIdx) {
        var t = lambda.slice();
        var coef = gfMul(d, gfInv(b));
        /* Λ ← Λ + (d/b)·x^m·prev ：乘 x^m 即下标整体减 m */
        for (var q = 0; q <= ecCount; q++) {
          if (prev[q] === 0) continue;
          var qi = q - m;
          if (qi >= 0) lambda[qi] ^= gfMul(coef, prev[q]);
        }
        L = nIdx + 1 - L;
        prev = t;
        b = d;
        m = 1;
      } else {
        var coef2 = gfMul(d, gfInv(b));
        for (var q2 = 0; q2 <= ecCount; q2++) {
          if (prev[q2] === 0) continue;
          var qi2 = q2 - m;
          if (qi2 >= 0) lambda[qi2] ^= gfMul(coef2, prev[q2]);
        }
        m++;
      }
    }

    /* 定位出的错误数若超过 ec/2，超出纠错能力，放弃 */
    if (L * 2 > ecCount || L === 0) return null;

    /* ---- 3. Chien search ----
     * syndrome 定义为 s[i] = R(α^i)，i = 0..ec-1（从 α^0 起）。
     * 这种约定下，码字下标 i 处的错误位置是 X = α^(n-1-i)，
     * 而 Λ(x) = ∏(1 - X_j·x) 的根是 **X_j 的逆**，不是 X_j 本身。
     * 所以这里要代入 α^(-(n-1-i))。
     * （旧版代入的是 X 本身，方向反了 —— 一个根都找不到，
     *   于是任何错误都直接判失败。） */
    var errPowers = [];   /* 存"幂次"(n-1-i)，Forney 里换成 X 和 X^-1 */
    for (i = 0; i < n; i++) {
      var pwr = n - 1 - i;
      var xv = EXP[(255 - pwr % 255) % 255];    /* α^(-pwr) = X^-1 */
      if (polyEval(lambda, xv) === 0) errPowers.push(pwr);
    }
    if (errPowers.length !== L) return null;

    /* ---- 4. Forney：错误值 e = X · ω(X^-1) / Λ'(X^-1) ----
     * ω(x) = (s(x)·Λ(x)) mod x^ec，s(x) 按升幂（s[a] 是 x^a 的系数）。
     * omega 同样用「定长降幂」存：omega[k] = x^(ecCount-k) 的系数。
     * ω 的次数最多 ec-1，所以 x^ec 那一格恒为 0。 */
    var omega = new Array(ecCount + 1);
    for (i = 0; i <= ecCount; i++) omega[i] = 0;
    for (var a = 0; a < ecCount; a++) {
      if (syn[a] === 0) continue;
      for (var bIdx = 0; bIdx <= L; bIdx++) {
        var lb = lambda[ecCount - bIdx];       /* x^bIdx 的系数 */
        if (lb === 0) continue;
        var deg = a + bIdx;                    /* 乘积的 x^deg 项 */
        if (deg < ecCount) {
          omega[ecCount - deg] ^= gfMul(syn[a], lb);
        }
      }
    }

    var out = received.slice();
    for (i = 0; i < errPowers.length; i++) {
      var X = EXP[errPowers[i] % 255];          /* 错误位置的幂 α^pwr */
      var Xin = EXP[(255 - errPowers[i] % 255) % 255];   /* α^(-pwr) */

      /* ω(X^-1)：omega 是定长降幂，polyEval 直接可用 */
      var num = polyEval(omega, Xin);

      /* Λ'(X^-1)：形式导数只保留奇次项。
         x^j 的系数是 lambda[ecCount-j]，求导后成为 j·x^(j-1)，
         j 为奇数时才有贡献（偶数项求导含 x^(j-1) 但系数 j 在
         GF(2) 上为 0）。 */
      var den = 0;
      for (j = 1; j <= L; j += 2) {             /* 只看奇次项 */
        var lj = lambda[ecCount - j];
        if (lj === 0) continue;
        den ^= gfMul(lj, EXP[(LOG[Xin] * (j - 1)) % 255]);
      }
      if (den === 0) return null;

      var mag = gfMul(X, gfMul(num, gfInv(den)));
      out[n - 1 - errPowers[i]] ^= mag;
    }
    return out;
  }

  /** GF(256) 上的乘法逆元 */
  function gfInv(a) {
    if (a === 0) return 0;
    return EXP[(255 - LOG[a]) % 255];
  }

  /* ============================================================
   * 第三部分：版本与纠错参数表
   *
   * 版本 1~40。每个版本给出：
   *   - 总码字数
   *   - 每块的纠错参数表（按纠错级别 L/M/Q/H）
   * ============================================================ */

  /* 每个版本的纠错块结构，按 ISO/IEC 18004 规范。
     格式： [每块纠错码字数, [[组内块数, 每块数据码字], ...]]
     同一纠错级别下，块可能分两组且大小不同（版本越大越常见），
     所以不能简单用「块数 × 每块数据」来算 —— 那样算出来的总长
     对不上，反交错会整块错位。

     数值已按「数据总数 + 纠错总数 = 该版本总码字数」逐条校验过。 */
  var EC_TABLE = {
    1:  { L: [7,  [[1, 19]]],                 M: [10, [[1, 16]]],
          Q: [13, [[1, 13]]],                 H: [17, [[1, 9]]] },
    2:  { L: [10, [[1, 34]]],                 M: [16, [[1, 28]]],
          Q: [22, [[1, 22]]],                 H: [28, [[1, 16]]] },
    3:  { L: [15, [[1, 55]]],                 M: [26, [[1, 44]]],
          Q: [18, [[2, 17]]],                 H: [22, [[2, 13]]] },
    4:  { L: [20, [[1, 80]]],                 M: [18, [[2, 32]]],
          Q: [26, [[2, 24]]],                 H: [16, [[4, 9]]] },
    5:  { L: [26, [[1, 108]]],                M: [24, [[2, 43]]],
          Q: [18, [[2, 15], [2, 16]]],        H: [22, [[2, 11], [2, 12]]] },
    6:  { L: [18, [[2, 68]]],                 M: [16, [[4, 27]]],
          Q: [24, [[4, 19]]],                 H: [28, [[4, 15]]] },
    7:  { L: [20, [[2, 78]]],                 M: [18, [[4, 31]]],
          Q: [18, [[2, 14], [4, 15]]],        H: [26, [[4, 13], [1, 14]]] },
    8:  { L: [24, [[2, 97]]],                 M: [22, [[2, 38], [2, 39]]],
          Q: [22, [[4, 18], [2, 19]]],        H: [26, [[4, 14], [2, 15]]] },
    9:  { L: [30, [[2, 116]]],                M: [22, [[3, 36], [2, 37]]],
          Q: [20, [[4, 16], [4, 17]]],        H: [24, [[4, 12], [4, 13]]] },
    10: { L: [18, [[2, 68], [2, 69]]],        M: [26, [[4, 43], [1, 44]]],
          Q: [24, [[6, 19], [2, 20]]],        H: [28, [[6, 15], [2, 16]]] }
  };

  /* 各版本总码字数（数据+纠错） */
  var TOTAL_CODEWORDS = {
    1: 26, 2: 44, 3: 70, 4: 100, 5: 134,
    6: 172, 7: 196, 8: 242, 9: 292, 10: 346
  };

  /* ============================================================
   * 第四部分：格式信息（纠错级别 + 掩码）
   *
   * 15 位 BCH(15,5)，生成多项式 0x537，掩码 0x5412。
   * 预计算全部 32 种合法码字，解码时按汉明距离取最近。
   * ============================================================ */
  var FORMAT_INFO = null;
  function buildFormatTable() {
    if (FORMAT_INFO) return FORMAT_INFO;
    FORMAT_INFO = [];
    for (var data = 0; data < 32; data++) {
      var d = data << 10;
      for (var i = 4; i >= 0; i--) {
        if (d & (1 << (i + 10))) d ^= 0x537 << i;
      }
      var full = ((data << 10) | d) ^ 0x5412;
      FORMAT_INFO.push(full);
    }
    return FORMAT_INFO;
  }

  function hammingWeight(x) {
    var c = 0;
    while (x !== 0) { c += x & 1; x >>= 1; }
    return c;
  }

  /**
   * 解码 15 位格式信息。
   * @return {{ec:string, mask:number}|null}
   */
  function decodeFormat(bits) {
    var table = buildFormatTable();
    var best = -1, bestDist = 999;
    for (var i = 0; i < table.length; i++) {
      var dist = hammingWeight(bits ^ table[i]);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    if (bestDist > 3) return null;   // BCH(15,5) 最多纠 3 位

    var ecBits = (best >> 3) & 3;
    var mask = best & 7;
    /* 纠错级别的 2 位编码：L=01 M=00 Q=11 H=10 */
    var ec = ['M', 'L', 'H', 'Q'][ecBits];
    return { ec: ec, mask: mask };
  }

  /* ============================================================
   * 第五部分：图像处理（灰度 + 二值化）
   * ============================================================ */

  /**
   * 灰度化 + 局部自适应二值化。
   *
   * 用「积分图」求局部块均值：一次前缀和，之后任意矩形均值 O(1)。
   * 比逐像素开窗快两个数量级，低端机上也能秒出。
   *
   * @return {{bits:Uint8Array, width:number, height:number}} bits 里 1=黑
   */
  function binarize(imageData) {
    var w = imageData.width, h = imageData.height;
    var src = imageData.data;
    var gray = new Uint8Array(w * h);

    for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
      /* 人眼亮度权重：0.299R + 0.587G + 0.114B，用整数近似 */
      gray[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
    }

    /* 积分图：sum[y*w+x] = 左上角矩形内像素和（多一行一列哨兵） */
    var iw = w + 1;
    var integral = new Uint32Array(iw * (h + 1));
    for (var y = 0; y < h; y++) {
      var rowSum = 0;
      for (var x = 0; x < w; x++) {
        rowSum += gray[y * w + x];
        integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
      }
    }

    /* 块大小取图像短边的 1/8，至少 8px —— 二维码单个「模块」通常
       在几十像素量级，这个窗口能覆盖几个模块，局部光照也能跟上。 */
    var block = Math.max(8, (Math.min(w, h) / 8) | 0);
    var bits = new Uint8Array(w * h);
    var half = block >> 1;

    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - half), y1 = Math.min(h - 1, y + half);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - half), x1 = Math.min(w - 1, x + half);
        var area = (y1 - y0 + 1) * (x1 - x0 + 1);
        var sum = integral[(y1 + 1) * iw + (x1 + 1)]
                - integral[y0 * iw + (x1 + 1)]
                - integral[(y1 + 1) * iw + x0]
                + integral[y0 * iw + x0];
        var mean = sum / area;
        bits[y * w + x] = gray[y * w + x] < mean * 0.92 ? 1 : 0;
      }
    }

    return { bits: bits, width: w, height: h };
  }

  /* ============================================================
   * 第六部分：定位图案检测
   *
   * 定位图案（Finder Pattern）是 7x7 的方块，横向扫过一行时，
   * 黑白宽度比例恰好是 1:1:3:1:1。找到三组就定位了二维码。
   * ============================================================ */

  /**
   * 在给定的「行 / 列」上扫 1:1:3:1:1 的图案。
   *
   * @param {Uint8Array} bits 二值图（1=黑）
   * @param {number} w
   * @param {number} h
   * @param {boolean} horizontal true 扫行，false 扫列
   * @return {Array<{x:number,y:number,size:number}>} 候选中心点
   */
  function finderScan(bits, w, h, horizontal) {
    var candidates = [];
    var maxCount = horizontal ? h : w;
    var lineLen = horizontal ? w : h;

    for (var i = 0; i < maxCount; i++) {
      /* 先把这一行/列压成「游程」序列：每段记 (颜色, 长度)。
         比边扫边维护状态机清楚得多 —— 状态机一旦错位，
         后面每一段都跟着错，还很难查。 */
      var runs = [];
      var prev = horizontal ? bits[i * w] : bits[i];
      var runLen = 1;
      for (var j = 1; j < lineLen; j++) {
        var cur = horizontal ? bits[i * w + j] : bits[j * w + i];
        if (cur === prev) {
          runLen++;
        } else {
          runs.push({ color: prev, len: runLen, start: j - runLen });
          prev = cur;
          runLen = 1;
        }
      }
      runs.push({ color: prev, len: runLen, start: lineLen - runLen });

      /* 在游程序列里滑一个长度 5 的窗口。
         定位图案的横截面恒为 黑:白:黑:白:黑 = 1:1:3:1:1，
         所以窗口的第一段必须是黑。 */
      for (var k = 0; k + 4 < runs.length; k++) {
        var r0 = runs[k], r1 = runs[k + 1], r2 = runs[k + 2],
            r3 = runs[k + 3], r4 = runs[k + 4];

        if (r0.color !== 1) continue;      // 必须从黑开始
        if (r1.color !== 0 || r2.color !== 1 || r3.color !== 0 || r4.color !== 1) continue;

        var total = r0.len + r1.len + r2.len + r3.len + r4.len;
        var unit = total / 7;
        if (unit < 1) continue;

        /* 容差用「比例误差」而不是绝对值：模块越小，像素抖动越敏感，
           固定容差会误判。这里允许每段 ±50% 的偏差。 */
        var tol = unit * 0.5;
        if (Math.abs(r0.len - unit) > tol) continue;
        if (Math.abs(r1.len - unit) > tol) continue;
        if (Math.abs(r2.len - 3 * unit) > 3 * tol) continue;
        if (Math.abs(r3.len - unit) > tol) continue;
        if (Math.abs(r4.len - unit) > tol) continue;

        /* 中心在第 3 段（那条 3 模块宽的黑条）的正中 */
        var centerPos = r2.start + r2.len / 2;
        var cand = horizontal
          ? { x: centerPos, y: i, size: total }
          : { x: i, y: centerPos, size: total };
        candidates.push(cand);
      }
    }
    return candidates;
  }

  /**
   * 把候选点聚成真正的定位图案中心。
   *
   * 一个 7x7 图案会被扫到很多次（每一行都扫到），所以要按距离归并，
   * 位置接近的算同一个，取平均中心和平均大小。
   *
   * 归并半径取「图案宽度的一半左右」：图案中心被扫到时，
   * 横竖两个方向的命中点都落在中心附近，半径太大会把旁边的
   * 噪声（数据区里偶然凑出 1:1:3:1:1 的地方）也吸进来，
   * 把中心拉偏 —— 中心一偏，整张采样网格就跟着歪。
   */
  function clusterCandidates(hCands, vCands, bits, w, h) {
    var all = [];
    var i;
    /* 给每个候选打上来源标记：0=水平扫到，1=垂直扫到。
       后面 pickThreeCombos 要靠「横竖都命中」来识别真定位图案 ——
       数据区的大块黑斑常常只有一个方向吻合，双向命中是很强的信号。 */
    for (i = 0; i < hCands.length; i++) { hCands[i]._dir = 0; all.push(hCands[i]); }
    for (i = 0; i < vCands.length; i++) { vCands[i]._dir = 1; all.push(vCands[i]); }
    var clusters = [];

    for (i = 0; i < all.length; i++) {
      var c = all[i];
      if (!(c.size > 0)) continue;

      var merged = false;
      for (var k = 0; k < clusters.length; k++) {
        var cl = clusters[k];
        /* 半径 = 两者尺寸均值的 0.4 倍。size 是 7 个模块的总宽，
           0.4 * size ≈ 2.8 个模块，足以吸收同一图案的抖动，
           又不会碰到 3.5 个模块外的邻居。 */
        var avgSize = (cl.size + c.size) / 2;
        var radius = avgSize * 0.4;
        var dx = cl.x - c.x, dy = cl.y - c.y;
        if (dx * dx + dy * dy < radius * radius) {
          cl.x = (cl.x * cl.n + c.x) / (cl.n + 1);
          cl.y = (cl.y * cl.n + c.y) / (cl.n + 1);
          cl.size = (cl.size * cl.n + c.size) / (cl.n + 1);
          cl.n++;
          if (c._dir === 0) cl.hN++; else cl.vN++;
          merged = true;
          break;
        }
      }
      if (!merged) {
        clusters.push({
          x: c.x, y: c.y, size: c.size, n: 1,
          hN: c._dir === 0 ? 1 : 0,
          vN: c._dir === 1 ? 1 : 0
        });
      }
    }

    var out = clusters.filter(function (c) { return c.n >= 3; });

    /* 中心精修。
       上面的中心是「很多次扫描的平均」，但每次扫描到的中心本身
       是有偏差的：横向扫时，扫线如果没穿过图案正中心（图案有旋转、
       或扫线恰好骑在边界上），量到的 3 模块黑条会被"切歪"，
       算出的中点就偏离真实中心。横向扫偏一点、纵向扫再偏一点，
       合并之后仍会残留 1~2 像素的误差。
       别小看这 1~2 像素 —— 采样网格是拿三个中心去撑起来的，
       中心偏 1 像素，跨 21 个模块后就是几个模块的错位，
       高版本直接整块解不出来。

       精修办法（ZXing 的同款思路）：在估计中心处，分别沿横向和
       纵向重新扫一遍 1:1:3:1:1，用两方向各自的中点互相校正，
       迭代两三轮。

       注意：模块很小时（比如 box=4，一个模块才 4 像素），
       精修的扫描窗口容易碰到相邻模块，反而把中心带偏。
       所以只在「模块足够大」时才精修，而且**以原中心为准、
       只在精修结果更合理时才采纳**。 */
    for (var t = 0; t < out.length; t++) {
      var c0 = out[t];
      var moduleSize = c0.size / 7;
      if (moduleSize < 6) continue;          /* 太小，不折腾 */
      refineFinderCenter(bits, w, h, c0);
    }
    return out;
  }

  /**
   * 精修单个定位图案的中心。
   *
   * 在 (cx,cy) 附近，先横向找 1:1:3:1:1 的中心 x，再在 (x,cy) 处
   * 纵向找中心 y，再回到 (x,y) 横向找 x…… 交替迭代。
   * 每轮都把中心朝真实位置推一点，通常 2~3 轮就稳定。
   *
   * 加了两道保险：
   *   - 每一步的位移不超过「0.7 个模块」（真中心不会离初始估计太远，
   *     跑太远一定是扫到别的结构了）；
   *   - 迭代后若总位移超过 1.2 个模块，整体放弃精修，保留原值。
   */
  function refineFinderCenter(bits, w, h, cl) {
    var moduleSize = cl.size / 7;
    if (!(moduleSize > 0)) return;
    var maxStep = moduleSize * 0.7;
    var maxTotal = moduleSize * 1.2;

    var ox = cl.x, oy = cl.y;
    var x = ox, y = oy;

    for (var iter = 0; iter < 4; iter++) {
      var nx = scanLineForCenter(bits, w, h, Math.round(x), Math.round(y), true, cl.size);
      if (nx !== null && Math.abs(nx - x) <= maxStep) x = nx;
      var ny = scanLineForCenter(bits, w, h, Math.round(x), Math.round(y), false, cl.size);
      if (ny !== null && Math.abs(ny - y) <= maxStep) y = ny;
    }

    /* 总位移不合理就放弃 */
    if (Math.abs(x - ox) > maxTotal || Math.abs(y - oy) > maxTotal) return;
    cl.x = x;
    cl.y = y;
  }

  /**
   * 以 (cx,cy) 为起点，沿指定方向扫一条线，找 1:1:3:1:1 的中点。
   * 返回该方向上的中心坐标（横向返回 x，纵向返回 y）；没找到返回 null。
   *
   * 不直接在 (cx,cy) 上看，而是把它当成"大致位置"，
   * 在一小段范围内（±size/4）逐条平行线试，取最像的那条的结论。
   * 这样即使当前位置偏离中心，也能拉回来。
   */
  function scanLineForCenter(bits, w, h, cx, cy, horizontal, size) {
    var span = Math.max(2, Math.round(size * 0.25));
    var best = null, bestErr = Infinity;

    for (var off = -span; off <= span; off++) {
      var fx = horizontal ? cx : cx + off;
      var fy = horizontal ? cy + off : cy;
      if (fx < 0 || fx >= w || fy < 0 || fy >= h) continue;

      var r = readCrossSection(bits, w, h, fx, fy, horizontal, size);
      if (!r) continue;
      if (r.err < bestErr) { bestErr = r.err; best = r.center; }
    }
    return best;
  }

  /**
   * 从 (x,y) 出发，沿指定方向向两侧展开，读出一段游程，
   * 在其中寻找「黑:白:黑:白:黑 = 1:1:3:1:1」的窗口。
   *
   * 返回 { center: 中心坐标, err: 各段与理论宽度的相对偏差之和 }，
   * 找不到返回 null。
   *
   * 与 finderScan 的区别：这里是"已知大概在哪儿，来精修"，
   * 所以只看中心附近 ±4 个模块，而且**允许窗口起点不为黑**
   * （因为可能从中间某段进入），最后只要求 5 段颜色和宽度对得上。
   */
  function readCrossSection(bits, w, h, x, y, horizontal, size) {
    var lim = Math.ceil(size * 1.2);   /* 往两侧各看 ~1.2 个图案宽，足够覆盖 7 模块 */
    var runs = [];
    var prev = null, len = 0, startPos = 0;

    for (var t = -lim; t <= lim; t++) {
      var px = horizontal ? x + t : x;
      var py = horizontal ? y : y + t;
      if (px < 0 || px >= w || py < 0 || py >= h) return null;
      var b = bits[py * w + px];
      if (prev === null) { prev = b; len = 1; startPos = t; continue; }
      if (b === prev) { len++; }
      else { runs.push({ color: prev, len: len, start: startPos }); prev = b; len = 1; startPos = t; }
    }
    runs.push({ color: prev, len: len, start: startPos });

    var best = null, bestErr = Infinity;
    for (var k = 0; k + 4 < runs.length; k++) {
      var r0 = runs[k], r1 = runs[k + 1], r2 = runs[k + 2], r3 = runs[k + 3], r4 = runs[k + 4];
      if (r0.color !== 1) continue;
      if (r1.color !== 0 || r2.color !== 1 || r3.color !== 0 || r4.color !== 1) continue;

      var total = r0.len + r1.len + r2.len + r3.len + r4.len;
      var unit = total / 7;
      if (unit < 1) continue;
      /* 精修的目的是"找得更准"，所以容差比粗扫更严：±35% */
      var tol = unit * 0.35;
      var err = 0;
      err += Math.abs(r0.len - unit) / unit;
      err += Math.abs(r1.len - unit) / unit;
      err += Math.abs(r2.len - 3 * unit) / (3 * unit);
      err += Math.abs(r3.len - unit) / unit;
      err += Math.abs(r4.len - unit) / unit;
      if (err > 5 * 0.35) continue;             /* 完全不像，跳过 */

      /* 窗口中心：第 3 段的中点（相对 x 的偏移） */
      var centerOff = r2.start + r2.len / 2;
      var c = horizontal ? x + centerOff : y + centerOff;
      if (err < bestErr) {
        bestErr = err;
        best = { center: c, err: err };
      }
    }
    return best;
  }

  /**
   * 从候选点里挑出三个定位图案：左上、右上、左下。
   *
   * 判据：
   *   - 三个点两两距离中，最长的那条是斜边（对应左上↔右下的对角线）
   *   - 直角顶点就是左上
   *   - 用叉积判断另外两个哪个在右上、哪个在左下
   */
  function pickThree(cands) {
    if (cands.length < 3) return null;

    /* 候选通常不多，直接三重循环找「最接近等腰直角三角形」的一组 */
    var best = null, bestScore = Infinity;
    var limit = Math.min(cands.length, 12);

    for (var i = 0; i < limit; i++) {
      for (var j = i + 1; j < limit; j++) {
        for (var k = j + 1; k < limit; k++) {
          var a = cands[i], b = cands[j], c = cands[k];
          var score = rightAngleScore(a, b, c);
          if (score < bestScore) { bestScore = score; best = [a, b, c]; }
        }
      }
    }
    if (!best) return null;

    /* 三个点里，直角顶点是左上；用叉积分左右 */
    return orderCorners(best[0], best[1], best[2]);
  }

  /** 三个点构成「等腰直角三角形」的契合度，越小越好 */
  function rightAngleScore(a, b, c) {
    var pairs = [[a, b, c], [b, a, c], [c, a, b]];
    var best = Infinity, bestD = 0;
    for (var i = 0; i < 3; i++) {
      var v = pairs[i][0], p1 = pairs[i][1], p2 = pairs[i][2];
      var d1 = dist(v, p1), d2 = dist(v, p2), d3 = dist(p1, p2);
      /* 直角边应该差不多长，斜边 ≈ sqrt(2) * 直角边 */
      var sizePenalty = Math.abs(d1 - d2) / (d1 + d2 + 1e-6);
      var pythPenalty = Math.abs(d3 - Math.sqrt(d1 * d1 + d2 * d2)) / (d3 + 1e-6);
      var s = sizePenalty * 2 + pythPenalty;
      if (s < best) { best = s; bestD = (d1 + d2) / 2; }
    }

    /* 光看几何还不够 —— 三个「定位图案」的**模块大小必须一致**，
       因为同一个二维码里所有模块一样大。这一条能有效排除
       「把别处的巧合结构也当成定位图案」的组合。 */
    var s1 = a.size, s2 = b.size, s3 = c.size;
    var avgS = (s1 + s2 + s3) / 3;
    if (avgS <= 0) return Infinity;
    var spread = (Math.abs(s1 - avgS) + Math.abs(s2 - avgS) + Math.abs(s3 - avgS)) / avgS;
    if (spread > 0.55) return Infinity;       /* 差太多，直接判不是同一个码 */

    /* 置信度：三个图案被扫到的次数（n）越多越可信。
       取三次里的最小值 —— 木桶效应，有一个弱就不可靠。 */
    var minN = Math.min(a.n, b.n, c.n);
    var confPenalty = minN < 6 ? 0.6 : 0;

    /* ── 尺度自洽性（这是剔除「真假混搭」三元组的关键） ──────────
     *
     * 同一条直角边跨 (m-7) 个模块，所以有两种独立估算模块大小的办法：
     *   (a) bySize = size/7        —— 由定位图案自身像素宽度来
     *   (b) byEdge = bestD/(m-7)   —— 由两图案中心距来，但需要先知道 m
     *
     * 二者的比值 byEdge/sizePerModule 直接透露了 m：
     *     比值 r = bestD / (size/7) = m - 7
     *   →  m = r + 7
     * 这是个**不含未知量**的等式，因为 bestD 和 size 都是量出来的。
     *
     * 于是可以反过来卡：真正的三元组必须满足
     *   (i)  m 落在 21..57（版本 1~10，覆盖到版本 10 已足够）；
     *   (ii) m 与「整数版本 ⇒ m = 4v+17」足够接近。
     *
     * 早先只判了「m 太小」（<14），漏了「m 太大」这一半 ——
     * 结果把「两个真图案 + 一个远处的假图案」放了过去：
     * 实测有个用例 size 算出模块 5.1px、中心距却对应 10.7px，
     * 反推 m≈36（真值只有 m≈25），真假混搭就这么混进了首位。
     */
    var sizePerModule = avgS / 7;
    if (!(sizePerModule > 0)) return Infinity;
    var rMod = bestD / sizePerModule;          /* = m - 7 */
    var mEst = rMod + 7;
    var scalePenalty = 0;
    if (mEst < 21 || mEst > 57) {
      scalePenalty = 0.6;                      /* 超出所有版本的模块数范围 */
    } else {
      /* 与最近的「合法模块数」的差距，按模块数归一 */
      var vEst = (mEst - 17) / 4;
      var vNear = Math.round(vEst);
      if (vNear < 1) vNear = 1;
      if (vNear > 10) vNear = 10;
      var mLegal = 4 * vNear + 17;
      scalePenalty = Math.abs(mEst - mLegal) / mLegal * 4;
    }

    return best * 2 + spread * 1.5 + confPenalty + scalePenalty;
  }

  function dist(p, q) {
    var dx = p.x - q.x, dy = p.y - q.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * 给定三个定位图案，确定 左上 / 右上 / 左下。
   *
   * 做法：找出距离最长的一对（那是左上-左下或左上-右上的斜边对应的
   * 另外两点其实是对角）。更稳的办法 —— 三个点两两距离：
   *   最长的一条是「右上 ↔ 左下」吗？不是。最长的一条是斜边，
   *   斜边两端是右上和左下，剩下那个是左上。
   */
  function orderCorners(p1, p2, p3) {
    var d12 = dist(p1, p2), d13 = dist(p1, p3), d23 = dist(p2, p3);
    var topLeft, other1, other2;

    if (d12 >= d13 && d12 >= d23) {
      topLeft = p3; other1 = p1; other2 = p2;
    } else if (d13 >= d12 && d13 >= d23) {
      topLeft = p2; other1 = p1; other2 = p3;
    } else {
      topLeft = p1; other1 = p2; other2 = p3;
    }

    /* 用叉积判断 other1/other2 谁是右上、谁是左下。
       坐标系 y 向下：若 other 在 topLeft 的「右上方」，
       则 (other - topLeft) 的 x 为正、y 为负。 */
    var vx = other1.x - topLeft.x, vy = other1.y - topLeft.y;
    var cross = vx * (other2.y - topLeft.y) - vy * (other2.x - topLeft.x);
    /* cross > 0 表示 other1 在逆时针侧（本坐标系下即右上） */
    if (cross > 0) {
      return { topLeft: topLeft, topRight: other1, bottomLeft: other2 };
    }
    return { topLeft: topLeft, topRight: other2, bottomLeft: other1 };
  }

  /* ============================================================
   * 第七部分：透视校正 + 采样
   *
   * 已知三点的图像坐标 + 二维码里的理论坐标，求一个射影变换，
   * 把每个模块的中心映射回图像上采样。
   * ============================================================ */

  /**
   * 用「四点透视变换」把二维码拉正。
   *
   * 只找到 3 个定位图案时，第 4 个点（右下）由平行四边形估算 ——
   * 版本 1 没有对齐图案，只能这样估；有对齐图案的版本后面会再用
   * 对齐点微调，但为了控制复杂度，这里统一用平行四边形 + 中心微调。
   */
  function buildTransform(corners) {
    var tl = corners.topLeft, tr = corners.topRight, bl = corners.bottomLeft;
    /* 右下角 = 右上 + 左下 - 左上（平行四边形） */
    var br = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y };

    /* 每个定位图案的中心，在二维码矩阵里位于 (3.5, 3.5) 模块处
       （7x7 图案的中心）。设模块数为 m，则：
         tl -> (3.5, 3.5)
         tr -> (m - 3.5, 3.5)
         bl -> (3.5, m - 3.5)
       我们先把「模块坐标」映射到「图像坐标」。 */
    return { tl: tl, tr: tr, bl: bl, br: br };
  }

  /**
   * 求「图像坐标 -> 单位方格坐标」的变换。
   *
   * 用 4 点对应关系解一个 8 元线性方程组（射影变换的 h33=1 规范）。
   * 采用高斯消元，规模只有 8x9，很快。
   */
  function solveHomography(src, dst) {
    /* src/dst 各 4 点，求把 src 映到 dst 的 3x3 矩阵 */
    var A = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i].x, y = src[i].y;
      var u = dst[i].x, v = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    var h = gaussSolve(A);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  /** 8x9 增广矩阵高斯消元 */
  function gaussSolve(M) {
    var n = 8;
    for (var col = 0; col < n; col++) {
      /* 选主元 */
      var piv = col;
      for (var r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-10) return null;
      var tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;

      var pv = M[col][col];
      for (var c = col; c <= n; c++) M[col][c] /= pv;

      for (r = 0; r < n; r++) {
        if (r === col) continue;
        var f = M[r][col];
        if (f === 0) continue;
        for (c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = M[i][n];
    return out;
  }

  /** 用 3x3 单应对点做映射 */
  function applyH(H, x, y) {
    var d = H[6] * x + H[7] * y + H[8];
    if (Math.abs(d) < 1e-12) d = 1e-12;
    return {
      x: (H[0] * x + H[1] * y + H[2]) / d,
      y: (H[3] * x + H[4] * y + H[5]) / d
    };
  }

  /* ============================================================
   * 第八部分：模块矩阵 -> 位流
   * ============================================================ */

  /** 各版本对齐图案中心坐标（版本 1 没有对齐图案） */
  var ALIGN_POS = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50]
  };

  /** 某版本二维码的模块总数（不含静区）= 4 * version + 17 */
  function moduleCount(version) { return version * 4 + 17; }

  /**
   * 生成「功能模块」掩码图：定位图案、分隔符、时序图案、
   * 格式信息、版本信息、对齐图案 —— 这些位置不参与数据读取。
   */
  function functionMask(version) {
    var m = moduleCount(version);
    var mask = [];
    for (var i = 0; i < m; i++) {
      mask.push(new Uint8Array(m));
    }

    function setBlock(r0, c0, r1, c1) {
      for (var r = r0; r <= r1; r++) {
        for (var c = c0; c <= c1; c++) {
          if (r >= 0 && r < m && c >= 0 && c < m) mask[r][c] = 1;
        }
      }
    }

    /* 三个定位图案 + 分隔符（8x8 含分隔线） */
    setBlock(0, 0, 8, 8);
    setBlock(0, m - 8, 8, m - 1);
    setBlock(m - 8, 0, m - 1, 8);

    /* 时序图案：第 6 行 / 第 6 列 */
    for (var i = 0; i < m; i++) { mask[6][i] = 1; mask[i][6] = 1; }

    /* 格式信息区（两处） */
    setBlock(0, 8, 8, 8);          /* 左上竖条 */
    setBlock(8, 0, 8, 8);          /* 左上横条 */
    setBlock(8, m - 8, 8, m - 1);  /* 右上 */
    setBlock(m - 7, 8, m - 1, 8);  /* 左下 */

    /* 版本信息（版本 >= 7） */
    if (version >= 7) {
      setBlock(0, m - 11, 5, m - 9);
      setBlock(m - 11, 0, m - 9, 5);
    }

    /* 对齐图案 */
    var pos = ALIGN_POS[version] || [];
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        var r = pos[a], c = pos[b];
        /* 三个角上的对齐图案与定位图案重叠，跳过 */
        if ((r === 6 && c === 6) ||
            (r === 6 && c === m - 7) ||
            (r === m - 7 && c === 6)) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            if (r + dr >= 0 && r + dr < m && c + dc >= 0 && c + dc < m) {
              mask[r + dr][c + dc] = 1;
            }
          }
        }
      }
    }
    return mask;
  }

  /**
   * 从图像里按变换采样出模块矩阵。
   */
  function sampleMatrix(bits, w, h, version, H) {
    var m = moduleCount(version);
    var grid = [];
    for (var r = 0; r < m; r++) {
      grid.push(new Uint8Array(m));
    }

    /* 模块坐标 (u,v)（0..m）映射到图像坐标。
       定位图案中心在 (3.5, 3.5)，所以模块 (r,c) 的中心是 (c+0.5, r+0.5)。 */
    for (r = 0; r < m; r++) {
      for (var c = 0; c < m; c++) {
        var pt = applyH(H, c + 0.5, r + 0.5);
        var px = Math.round(pt.x), py = Math.round(pt.y);
        if (px < 0 || px >= w || py < 0 || py >= h) { grid[r][c] = 0; continue; }
        grid[r][c] = bits[py * w + px];
      }
    }
    return grid;
  }

  /* ============================================================
   * 第九部分：掩码 + 码字提取
   * ============================================================ */

  var MASK_FN = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r, c) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
  ];

  /**
   * 按「Z 字形」顺序把模块读成位流（跳过功能模块）。
   */
  function readCodewords(grid, version, maskId) {
    var m = moduleCount(version);
    var fmask = functionMask(version);
    var maskFn = MASK_FN[maskId];
    var bits = [];

    var upward = true;
    for (var col = m - 1; col > 0; col -= 2) {
      /* 第 6 列是时序图案，跳过一整列 */
      if (col === 6) col = 5;
      for (var rowIdx = 0; rowIdx < m; rowIdx++) {
        var r = upward ? (m - 1 - rowIdx) : rowIdx;
        for (var dx = 0; dx < 2; dx++) {
          var c = col - dx;
          if (fmask[r][c]) continue;
          var bit = grid[r][c];
          if (maskFn(r, c)) bit ^= 1;   /* 掩码是异或 */
          bits.push(bit);
        }
      }
      upward = !upward;
    }

    /* 每 8 位拼成一个码字 */
    var bytes = [];
    for (var i = 0; i + 8 <= bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      bytes.push(b);
    }
    return bytes;
  }

  /**
   * 读格式信息（15 位），还原出纠错级别和掩码号。
   *
   * 格式信息在矩阵里存了两份（冗余）：左上角一份，右上+左下一份。
   * 两份都读，各自纠错，哪份能用就用哪份。
   */
  function readFormat(grid, m) {
    /* 第一份：左上角，按规范顺序 */
    var bits1 = 0;
    var coords1 = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ];
    for (var i = 0; i < coords1.length; i++) {
      bits1 = (bits1 << 1) | grid[coords1[i][0]][coords1[i][1]];
    }
    var r1 = decodeFormat(bits1);

    /* 第二份：右上横向 + 左下纵向 */
    var bits2 = 0;
    var coords2 = [
      [m - 1, 8], [m - 2, 8], [m - 3, 8], [m - 4, 8], [m - 5, 8],
      [m - 6, 8], [m - 7, 8],
      [8, m - 8], [8, m - 7], [8, m - 6], [8, m - 5], [8, m - 4],
      [8, m - 3], [8, m - 2], [8, m - 1]
    ];
    for (i = 0; i < coords2.length; i++) {
      bits2 = (bits2 << 1) | grid[coords2[i][0]][coords2[i][1]];
    }
    var r2 = decodeFormat(bits2);

    return r1 || r2;
  }

  /**
   * 反交错：把读出的码字按块结构拆开，纠错，再拼回数据段。
   *
   * 交错规则（ISO/IEC 18004 第 8.6 节）：
   *   所有块的第 1 个数据码字先依次排列，再排所有块的第 2 个……
   *   较短的块先排完就跳过（所以各块数据长度可以不同）。
   *   纠错码字同理，按「第 1 个纠错码字轮一遍，再第 2 个」排。
   *
   * 不能假设所有块一样大：版本 5 往上，同一纠错级别下经常是
   * 「n 块短的 + m 块长的」，用均匀块去切必然错位。
   */
  function deinterleave(bytes, version, ec) {
    var rule = EC_TABLE[version] && EC_TABLE[version][ec];
    if (!rule) return null;
    var ecPerBlock = rule[0];
    var groups = rule[1];

    /* 展开成「每一块的数据长度」列表 */
    var blockDataLens = [];
    var totalData = 0;
    for (var g = 0; g < groups.length; g++) {
      var cnt = groups[g][0], dLen = groups[g][1];
      for (var i = 0; i < cnt; i++) {
        blockDataLens.push(dLen);
        totalData += dLen;
      }
    }
    var blockCount = blockDataLens.length;
    var totalNeeded = totalData + blockCount * ecPerBlock;
    if (bytes.length < totalNeeded) return null;

    var maxDataLen = 0;
    for (i = 0; i < blockDataLens.length; i++) {
      if (blockDataLens[i] > maxDataLen) maxDataLen = blockDataLens[i];
    }

    /* 每个块的数据 / 纠错分开存 */
    var blocks = [];
    for (i = 0; i < blockCount; i++) blocks.push({ data: [], ec: [] });

    var idx = 0;

    /* --- 数据码字：按列（第 k 个）轮着发 --- */
    for (var k = 0; k < maxDataLen; k++) {
      for (i = 0; i < blockCount; i++) {
        if (k < blockDataLens[i]) {
          if (idx >= bytes.length) return null;
          blocks[i].data.push(bytes[idx++]);
        }
      }
    }

    /* --- 纠错码字：同样按列轮着发（各块纠错长度相同） --- */
    for (k = 0; k < ecPerBlock; k++) {
      for (i = 0; i < blockCount; i++) {
        if (idx >= bytes.length) return null;
        blocks[i].ec.push(bytes[idx++]);
      }
    }

    /* --- 逐块纠错，按块顺序拼回数据 --- */
    var out = [];
    for (i = 0; i < blockCount; i++) {
      var full = blocks[i].data.concat(blocks[i].ec);
      var fixed = rsDecode(full, ecPerBlock);
      if (!fixed) return null;
      for (var k2 = 0; k2 < blockDataLens[i]; k2++) out.push(fixed[k2]);
    }
    return out;
  }

  /* ============================================================
   * 第十部分：位流 -> 文本
   * ============================================================ */

  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  function decodePayload(stream, version) {
    var out = '';
    while (stream.available() >= 4) {
      var mode = stream.readBits(4);
      if (mode === 0) break;   /* 终止符 */
      if (mode === -1) break;

      if (mode === 1) {
        /* 数字模式：3 个数字 10 位，2 个 7 位，1 个 4 位 */
        var count = readCount(stream, 1, version);
        while (count >= 3) {
          var v3 = stream.readBits(10);
          if (v3 < 0 || v3 > 999) return null;
          out += ('000' + v3).slice(-3);
          count -= 3;
        }
        if (count === 2) {
          var v2 = stream.readBits(7);
          if (v2 < 0 || v2 > 99) return null;
          out += ('00' + v2).slice(-2);
        } else if (count === 1) {
          var v1 = stream.readBits(4);
          if (v1 < 0 || v1 > 9) return null;
          out += String(v1);
        }
      } else if (mode === 2) {
        /* 字母数字模式：2 字符 11 位，1 字符 6 位 */
        var c2 = readCount(stream, 2, version);
        while (c2 >= 2) {
          var p = stream.readBits(11);
          if (p < 0) return null;
          out += ALNUM.charAt((p / 45) | 0) + ALNUM.charAt(p % 45);
          c2 -= 2;
        }
        if (c2 === 1) {
          var p1 = stream.readBits(6);
          if (p1 < 0) return null;
          out += ALNUM.charAt(p1);
        }
      } else if (mode === 4) {
        /* 字节模式：UTF-8 */
        var c4 = readCount(stream, 4, version);
        var raw = [];
        for (var i = 0; i < c4; i++) {
          var byteVal = stream.readBits(8);
          if (byteVal < 0) return null;
          raw.push(byteVal);
        }
        out += utf8Decode(raw);
      } else if (mode === 8) {
        /* 汉字模式（GB2312） */
        var c8 = readCount(stream, 8, version);
        for (var k = 0; k < c8; k++) {
          var two = stream.readBits(13);
          if (two < 0) return null;
          var vv = ((two / 0xC0) | 0) * 0x100 + (two % 0xC0);
          if (vv < 0x1000) vv += 0x160;
          out += gb2312Char(vv);
        }
      } else {
        return null;   /* 不认识模式，放弃 */
      }
    }
    return out;
  }

  /**
   * 读「字符数」字段。
   *
   * 位宽随模式和版本变化（ISO/IEC 18004 表 3）。版本 1~9 一档，
   * 10~26 一档，27~40 一档 —— 读错宽度后面全乱，必须按版本选。
   */
  function readCount(stream, mode, version) {
    var tier = version <= 9 ? 0 : (version <= 26 ? 1 : 2);
    var widths;
    if (mode === 1) widths = [10, 12, 14];        /* 数字 */
    else if (mode === 2) widths = [9, 11, 13];    /* 字母数字 */
    else if (mode === 4) widths = [8, 16, 16];    /* 字节 */
    else widths = [8, 10, 12];                    /* 汉字 */
    return stream.readBits(widths[tier]);
  }

  function utf8Decode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i];
      if (c < 0x80) {
        s += String.fromCharCode(c);
      } else if (c >= 0xC0 && c < 0xE0) {
        s += String.fromCharCode(((c & 0x1F) << 6) | (bytes[++i] & 0x3F));
      } else if (c >= 0xE0 && c < 0xF0) {
        s += String.fromCharCode(
          ((c & 0x0F) << 12) | ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F));
      } else if (c >= 0xF0) {
        var cp = ((c & 0x07) << 18) | ((bytes[++i] & 0x3F) << 12) |
                 ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F);
        cp -= 0x10000;
        s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return s;
  }

  /* GB2312 解码：这里不做完整字库映射（体积太大），
     汉字模式主要用于中日韩网站，otpauth 链接不会用到。
     真遇到就退化为占位，不影响英文/字节模式。 */
  function gb2312Char(code) {
    try {
      return decodeURIComponent('%' + code.toString(16).slice(-2) +
        '%' + code.toString(16).padStart(4, '0').slice(0, 2));
    } catch (e) { return ''; }
  }

  /* ============================================================
   * 第十一部分：主流程
   * ============================================================ */

  /**
   * 尝试用给定的三个定位图案解码。
   */
  function tryDecodeWithCorners(bits, w, h, corners) {
    var dTop = dist(corners.topLeft, corners.topRight);
    var dLeft = dist(corners.topLeft, corners.bottomLeft);
    var avgDim = (dTop + dLeft) / 2;
    if (avgDim <= 0) return null;

    /* 两条边的长度不该差太多（正方形码），差太多说明定位错了。
       注意：这个门限要留得宽 —— 手机斜拍带来的透视会让两边差
       百分之几十，拦太狠会把能解的码直接拒掉。 */
    if (Math.abs(dTop - dLeft) > Math.max(dTop, dLeft) * 0.45) return null;

    var sizeAvg = (corners.topLeft.size + corners.topRight.size + corners.bottomLeft.size) / 3;

    /* ── 模块大小的两条独立估计 ─────────────────────────────
     *
     * (1) bySize：扫描游程量到的图案宽度 / 7。
     *     优点：直接反映图案本身的像素跨度。
     *     缺点：静态图像里一旋转就废 —— 水平扫描线斜穿 7x7 图案时，
     *     走过的弦长是 (7) * (|cosθ| + |sinθ|) 而非 7，20° 时就已经
     *     放大 1.28 倍，量出来的模块大小虚高近三成。
     *
     * (2) byDist：中心距 / (m - 7)。中心距是欧氏距离，与旋转无关；
     *     透视会带来偏差，但透视是「真正的几何形变」，本来就该由
     *     单应矩阵去吸收，用它估模块大小反而更接近真值。
     *
     * 但 byDist 有个循环依赖：它需要先知道 m，而 m 又取决于版本 ——
     * 版本正是我们要求的。所以下面不走「先估版本再解」的单线思路，
     * 而是**对所有候选版本各算一遍**，用「估出的模块大小与该版本
     * 应有的模块大小是否自洽」来排序。这样既绕开了循环依赖，
     * 又顺便把版本估计的不确定性转成了一条稳定的打分。
     */
    var bySize = sizeAvg / 7;
    if (!(bySize > 0)) return null;

    /* ── 候选版本排序 ───────────────────────────────────────
     * 对每个版本 v：m = 4v + 17，模块大小 = avgDim / (m - 7)。
     * 让这个值和 bySize 尽量接近的版本，最可能是真版本。
     * 但 bySize 本身有旋转偏差（偏大），所以只用它做**粗排**，
     * 真正定版本还得靠采样 + 纠错能不能过。 */
    var cands = [];
    for (var v = 1; v <= 40; v++) {
      var mm = 4 * v + 17;
      if (mm <= 7) continue;
      var byDist = avgDim / (mm - 7);
      /* 相对误差（取 log 比），bySize 偏大时所有版本都会被惩罚，
         但惩罚量随版本单调变化，最小值仍落在真版本附近 */
      var err = Math.abs(Math.log(byDist / bySize));
      cands.push({ v: v, err: err, byDist: byDist });
    }
    cands.sort(function (a, b) { return a.err - b.err; });

    /* 按打分从近到远，取前 12 个版本试。
       再多也没意义 —— 版本 10 以上要 m>57 模块，实测极少出现，
       而且每次尝试都要走一遍采样+纠错，排在后面的基本是废努力。
       前 12 个已能覆盖「bySize 偏差到 2 倍」的极端情况。 */
    var order = [];
    for (var ci = 0; ci < cands.length && ci < 12; ci++) order.push(cands[ci].v);

    var tried = {};

    for (var oi = 0; oi < order.length; oi++) {
      var version = order[oi];
      if (version < 1 || version > 10) continue;
      if (tried[version]) continue;
      tried[version] = 1;
      var text = decodeWithVersion(bits, w, h, corners, version);
      if (text) return text;
    }
    return null;
  }

  /** 按指定的版本走完采样 → 纠错 → 解析 */
  function decodeWithVersion(bits, w, h, corners, version) {
    var m = moduleCount(version);

    /* 三个定位图案的中心，在模块坐标系里分别落在
       (3.5,3.5) / (m-3.5,3.5) / (3.5,m-3.5)。这三个点已经定死。
       第 4 个点有两种取法（下面依次尝试）：

       A. 平行四边形猜出来的右下角 —— 无透视时精确；
       B. 用真实存在的「对齐图案」当第 4 对应点 ——
          它带真实透视信息，是梯形/斜拍场景的救命稻草。
          注意 B 的 src 不再是 (m-3.5,m-3.5)，而是对齐图案
          自己的模块坐标 (ac+0.5, ar+0.5)。 */
    var brEst = findGuessFourthCorner(bits, w, h, corners, version, m);

    var variants = [];

    /* 变体 A：三个定位图案 + 平行四边形估的右下角（版本 1 也适用） */
    variants.push({
      src: [
        { x: 3.5, y: 3.5 },
        { x: m - 3.5, y: 3.5 },
        { x: m - 3.5, y: m - 3.5 },
        { x: 3.5, y: m - 3.5 }
      ],
      dst: [corners.topLeft, corners.topRight, brEst, corners.bottomLeft]
    });

    /* 变体 B：三个定位图案 + 对齐图案（真正的第 4 个对应点）。
       对齐图案在版本 1 不存在，高版本才逐步出现。 */
    var align = findAlignCorrespondence(bits, w, h, corners, brEst, version, m);
    if (align) {
      variants.push({
        src: [
          { x: 3.5, y: 3.5 },
          { x: m - 3.5, y: 3.5 },
          { x: align.ac + 0.5, y: align.ar + 0.5 },
          { x: 3.5, y: m - 3.5 }
        ],
        dst: [corners.topLeft, corners.topRight, { x: align.px, y: align.py }, corners.bottomLeft]
      });
    }

    /* 变体 C：变体 A 的角点 + 组合方案（透视更强时，
       A 能过就先过；过不了再退回 B）。这里先 A 后 B，
       哪个解得出来算哪个。 */
    for (var vi = 0; vi < variants.length; vi++) {
      var H = solveHomography(variants[vi].src, variants[vi].dst);
      if (!H) continue;

      var grid = sampleMatrix(bits, w, h, version, H);
      var fmt = readFormat(grid, m);
      if (!fmt) continue;

      var codewords = readCodewords(grid, version, fmt.mask);
      var data = deinterleave(codewords, version, fmt.ec);
      if (!data) continue;

      var text = decodePayload(new BitStream(data), version);
      if (text) return text;
    }
    return null;
  }

  /** 平行四边形猜出的右下角（模块坐标 (m-3.5,m-3.5) 对应的图像点） */
  function findGuessFourthCorner(bits, w, h, corners, version, m) {
    return {
      x: corners.topRight.x + corners.bottomLeft.x - corners.topLeft.x,
      y: corners.topRight.y + corners.bottomLeft.y - corners.topLeft.y
    };
  }

  /**
   * 在右下角附近找「对齐图案」，并把它作为**真正的第 4 个对应点**返回。
   *
   * 返回 { ac, ar, px, py }：对齐图案中心的理论模块坐标 (ac+0.5, ar+0.5)
   * 与它在图像里的实测像素位置 (px, py)。
   *
   * 为什么这一步关键：三个定位图案 + 平行四边形假设，等于认定
   * 二维码是平行四边形（无透视）。而手机拍屏幕/拍纸面几乎一定带透视，
   * 右下角会被估偏，越往右下采样越歪。对齐图案是规范里真实存在的
   * 第 4 个参照物，把它的实测位置喂进单应矩阵，就能把透视吃进去。
   */
  function findAlignCorrespondence(bits, w, h, corners, brEst, version, m) {
    var pos = ALIGN_POS[version];
    if (!pos || !pos.length) return null;

    /* 右下角那个对齐图案的模块坐标。
       规范里 3 个角上的对齐图案与定位图案重合，只有右下这个是独立的。 */
    var ar = pos[pos.length - 1], ac = pos[pos.length - 1];
    if (ar <= 6 || ac <= 6) return null;   /* 与定位图案重合，没有独立的 */

    /* 先用「平行四边形」变换估一下对齐图案大概在哪，
       作为搜索中心。这一步只求「大概」，所以用简单模型就够了。 */
    var srcImg = [
      { x: 3.5, y: 3.5 },
      { x: m - 3.5, y: 3.5 },
      { x: m - 3.5, y: m - 3.5 },
      { x: 3.5, y: m - 3.5 }
    ];
    var dstImg = [corners.topLeft, corners.topRight, brEst, corners.bottomLeft];
    var H = solveHomography(srcImg, dstImg);
    if (!H) return null;

    var guess = applyH(H, ac + 0.5, ar + 0.5);

    /* 搜索半径：透视会让估的位置偏出几个模块。给 5 个模块的余量。 */
    var moduleSize = dist(corners.topLeft, corners.topRight) / (m - 7);
    var radius = Math.max(6, Math.round(moduleSize * 5));
    var found = searchAlignPattern(bits, w, h, guess.x, guess.y, radius, moduleSize);
    if (!found) return null;

    /* 用「估出来的位置」到「找到的位置」的偏移量，反推右下角。
       —— 注意这里只是把对齐图案当作一个「校准点」，
       真正的 4 点单应由调用方用 align 里的模块坐标 + 实测像素坐标建立。 */
    return { ac: ac, ar: ar, px: found.x, py: found.y };
  }

  /**
   * 在 (cx, cy) 附近找一个 5x5 对齐图案。
   *
   * 只取「单点最优」是不稳的 —— 模糊会让真正的图案中心稍微偏一点，
   * 而图像别处偶尔会凑出一个数值上更"标准"的假图案。
   * 所以这里分三步：
   *   1. 在半径内逐像素打分，收集所有通过判据的点；
   *   2. 把这些点按空间位置聚类（同一个图案中心附近会有一簇点）；
   *   3. 给每个簇算一个综合分 = 簇内最优分 + 距离惩罚，
   *      取综合分最低的簇，用它的质心作为结果。
   *
   * 距离惩罚让「离估计位置近的簇」优先 —— 估计位置是由三个定位
   * 图案+平行四边形推出来的，虽有透视误差但通常只偏几个模块，
   * 足以排除掉图像另一角的偶然相似结构。
   */
  function searchAlignPattern(bits, w, h, cx, cy, radius, moduleSize) {
    var pts = [];

    for (var dy = -radius; dy <= radius; dy++) {
      for (var dx = -radius; dx <= radius; dx++) {
        var x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x < 6 || y < 6 || x >= w - 6 || y >= h - 6) continue;

        var sc = scoreAlignAt(bits, w, h, x, y, moduleSize);
        if (sc === null) continue;
        /* 太差的直接丢，省得污染聚类。
           阈值随模块大小放宽：模块越小（3~4px），二值化后边缘的
           游程抖动越大，真图案的单点分数也会偏高。用固定 2.8 会把
           小码的真对齐图案整个滤掉。 */
        var scLim = moduleSize < 5 ? 4.2 : 2.8;
        if (sc > scLim) continue;
        pts.push({ x: x, y: y, s: sc });
      }
    }
    if (pts.length === 0) return null;

    /* 聚类：半径取「1 个模块」—— 同一个图案中心附近的点会落进来，
       不同的图案（相距 ≥5 模块）不会混。 */
    var clR = Math.max(2, moduleSize);
    var used = new Array(pts.length);
    var clusters = [];
    for (var i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      var members = [pts[i]];
      used[i] = true;
      var changed = true;
      /* 简单的单链聚类：反复扩张，直到没有新点 */
      while (changed) {
        changed = false;
        for (var j = 0; j < pts.length; j++) {
          if (used[j]) continue;
          for (var k = 0; k < members.length; k++) {
            if (dist(pts[j], members[k]) <= clR) {
              members.push(pts[j]); used[j] = true; changed = true; break;
            }
          }
        }
      }
      clusters.push(members);
    }

    /* 每个簇算综合分 */
    var best = null, bestTotal = Infinity;
    for (var c = 0; c < clusters.length; c++) {
      var mem = clusters[c];
      /* 簇内最优分、质心 */
      var minS = Infinity, sx = 0, sy = 0;
      for (var t = 0; t < mem.length; t++) {
        if (mem[t].s < minS) minS = mem[t].s;
        sx += mem[t].x; sy += mem[t].y;
      }
      var cxx = sx / mem.length, cyy = sy / mem.length;
      var d = Math.sqrt((cxx - cx) * (cxx - cx) + (cyy - cy) * (cyy - cy));

      /* 综合分由三部分组成：
         1) 簇内最优分 —— 图案本身的"标准程度"；
         2) 距离惩罚 —— 越靠近估计位置越好，每偏 1 个模块加 0.08；
         3) 密度奖励 —— 这是**区分真假的关键**。
            真对齐图案周围有一大片像素都满足游程判据（实测能到 70+ 个点），
            而数据区偶然凑出来的假图案只有零星几个点（个位数）。
            所以这里对簇大小给一个强奖励：用 log 压缩后线性扣分，
            让「大簇」无条件赢过「小簇」，哪怕小簇的单点分数更低。
            归一化：8 个点以下视为噪声（后面直接丢弃），
            70 个点左右扣到接近 0。 */
      var distTerm = (d / moduleSize) * 0.08;
      var densityTerm = 1.6 / (1 + mem.length / 12);
      var total = minS + distTerm + densityTerm;
      if (total < bestTotal) {
        bestTotal = total;
        best = { x: Math.round(cxx), y: Math.round(cyy), score: minS, n: mem.length };
      }
    }
    if (!best) return null;
    /* 低于 8 个点的簇太稀疏，多半是噪声凑出来的，不要。
       小模块时判据放宽、命中点本就少，门槛跟着降。 */
    var minPts = moduleSize < 5 ? 4 : 8;
    if (best.n < minPts) return null;
    return bestTotal < 4.2 ? { x: best.x, y: best.y } : null;
  }

  /** 在 (x,y) 处给「是不是对齐图案中心」打分，越小越像；不像返回 null */
  function scoreAlignAt(bits, w, h, x, y, moduleSize) {
    var hScore = alignRunScore(bits, w, h, x, y, true, moduleSize);
    if (hScore === null) return null;
    var vScore = alignRunScore(bits, w, h, x, y, false, moduleSize);
    if (vScore === null) return null;
    return hScore + vScore;
  }

  /**
   * 沿一个方向给「(x,y) 是不是对齐图案中心」打分。
   *
   * 对齐图案（ISO/IEC 18004）是 5x5：
   *
   *      #####
   *      #...#
   *      #.#.#     ← 中心 1x1 黑
   *      #...#
   *      #####
   *
   * 也就是「黑1 白1 黑1 白1 黑1」，五段各一个模块。
   *
   * 难点在于：最外面那圈黑**经常紧贴数据区的黑模块**，于是
   * 首段或尾段会和邻块融合，实测游程会变成
   *   「黑10 白9 黑9 白9 黑28」    ← 尾段 9+19 融合
   * 或
   *   「黑25 白9 黑9 白10 黑8」    ← 首段 19+9 融合
   * 如果硬要求「正好 5 段」，这两种都会漏检。
   *
   * 所以这里改成只用**中心三要素**做判据 ——
   * 它们是这个图案最稳、也最独特的特征：
   *   1. 中心像素是黑；                （黑1）
   *   2. 中心两侧各紧邻一段宽度 ≈1 模块的白；   （白1，左右各一）
   *   3. 两段白再往外，各自紧邻一段黑。        （黑1，左右各一）
   *
   * 最外圈黑（第 5 段）即便融合也不影响判定，因为它不参与判据。
   */
  function alignRunScore(bits, w, h, x, y, horizontal, moduleSize) {
    var m = moduleSize;
    if (!(m > 2)) return null;

    /* 中心必须黑 */
    if (bits[y * w + x] !== 1) return null;

    /* 用一个方向上的扫描器，量「从中心出发依次遇到的各段长度」。
       返回 [{color,len}, ...]，最多三段（黑、白、黑）；
       不足三段就返回已有部分，由调用方判断。 */
    function scanSide(sign) {
      var lim = Math.ceil(m * 4);          /* 4 个模块足够覆盖 1+1+1 还留余量 */
      var seq = [];
      var prev = bits[y * w + x];           /* 先按中心色起算 */
      var len = 1;                          /* 含中心自己 */
      for (var t = 1; t <= lim; t++) {
        var px = horizontal ? x + sign * t : x;
        var py = horizontal ? y : y + sign * t;
        if (px < 0 || px >= w || py < 0 || py >= h) break;
        var b = bits[py * w + px];
        if (b === prev) { len++; }
        else { seq.push({ color: prev, len: len }); prev = b; len = 1; }
        if (seq.length >= 3) break;         /* 黑白黑 都拿到了就够 */
      }
      if (seq.length < 3) seq.push({ color: prev, len: len });
      return seq;
    }

    var fs = scanSide(+1), rs = scanSide(-1);
    if (fs.length < 3 || rs.length < 3) return null;

    /* 期望：第 1 段黑（中心），第 2 段白 ≈1m，第 3 段黑 ≥0.6m */
    function sideScore(seq) {
      if (seq[0].color !== 1) return null;         /* 中心该是黑 */
      if (seq[1].color !== 0) return null;         /* 接着该是白 */
      if (seq[2].color !== 1) return null;         /* 再往外该是黑 */
      var wLen = seq[1].len;                        /* 白环宽度 */
      var bLen = seq[2].len;                        /* 外圈黑宽度（可能融合，只设下限） */
      if (wLen < m * 0.35 || wLen > m * 1.9) return null;
      if (bLen < m * 0.45) return null;             /* 至少得有半个模块的黑 */
      if (seq[0].len > m * 2.2) return null;        /* 中心黑不该太胖 */
      var s = Math.abs(wLen - m) / m;               /* 白环越接近 1m 越好 */
      s += Math.abs(seq[0].len - m) / m * 0.6;      /* 中心黑也接近 1m */
      return s;
    }

    var s1 = sideScore(fs), s2 = sideScore(rs);
    if (s1 === null || s2 === null) return null;

    /* 两侧白环宽度不该差太多（透视会带来差异，但不会差一倍以上） */
    var w1 = fs[1].len, w2 = rs[1].len;
    var asym = Math.abs(w1 - w2) / Math.max(w1, w2);
    if (asym > 0.7) return null;

    return s1 + s2 + asym * 0.5;
  }

  /**
   * 对外唯一入口。
   *
   * @param {{data:Uint8ClampedArray,width:number,height:number}} imageData
   * @return {string|null}
   */
  function fromImageData(imageData) {
    try {
      if (!imageData || !imageData.data || !imageData.width || !imageData.height) return null;

      var bin = binarize(imageData);
      var bits = bin.bits, w = bin.width, h = bin.height;

      var hCands = finderScan(bits, w, h, true);
      var vCands = finderScan(bits, w, h, false);
      if (hCands.length + vCands.length < 3) return null;

      var clusters = clusterCandidates(hCands, vCands, bits, w, h);

      /* 候选很多时，逐个三元组试太慢。先挑最像的三个；
         失败再退化为「按位置粗分」再试一次。 */
      var combos = pickThreeCombos(clusters);
      for (var i = 0; i < combos.length; i++) {
        var text = tryDecodeWithCorners(bits, w, h, combos[i]);
        if (text) return text;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * 生成若干组「三个定位图案」的备选组合，按可信度排序。
   *
   * ── 为什么不能按命中次数（n）排序 ────────────────────────────
   * 早先的写法是「n 大说明被扫到多次，更可信」。这个直觉是错的：
   *   定位图案只有 7 个模块宽，能同时满足 1:1:3:1:1 的扫描线不多；
   *   而二维码数据区里的大块黑斑，动辄十几个模块宽，
   *   每一行扫过去都吻合 —— 命中次数反而更高。
   * 实测（旋转 20° 的版本 1）：
   *   真定位图案簇 n = 47 / 47 / 7
   *   数据区黑斑簇   n = 86 / 43 / 13
   * 按 n 取前 10 名，真值的左下角（n=7）直接被截掉 —— 三个点里
   * 一个真两个假，后面怎么解都解不出来。
   *
   * ── 改用「像不像定位图案」的三个特征 ────────────────────────
   * 1) 横竖双向都命中：真正的定位图案在水平扫描和垂直扫描里
   *    都会留下 1:1:3:1:1，而数据区黑斑往往只有一个方向吻合。
   *    给「两个方向都有」的簇加权，是最强的判据。
   * 2) 簇的紧致度：n 大但散布广 = 其实是被很多条扫线"蹭"过，
   *    真正图案的命中点应该聚在中心附近。
   * 3) 与其他簇的尺寸一致性：同一张码里三个定位图案的像素跨度
   *    应当接近，尺寸离群的簇多半是假货。
   */
  function pickThreeCombos(cands) {
    var results = [];
    if (cands.length < 3) return results;

    /* ① 尺寸中位数 —— 用来识别"尺寸离群"的假簇 */
    var sizes = [];
    for (var si = 0; si < cands.length; si++) sizes.push(cands[si].size);
    sizes.sort(function (a, b) { return a - b; });
    var medSize = sizes[Math.floor(sizes.length / 2)] || 1;

    /* ② 给每个簇打分（越小越像真图案） */
    for (var ci = 0; ci < cands.length; ci++) {
      var c = cands[ci];
      var s = 0;

      /* 双向命中：clusterCandidates 会把来源方向记在 hN / vN 上。
         没有这两个字段时（旧数据）退化为中性分，不影响兼容。 */
      var hn = c.hN || 0, vn = c.vN || 0;
      if (hn + vn > 0) {
        var bidir = Math.min(hn, vn) / Math.max(hn, vn);
        s += (1 - bidir) * 2.0;            /* 单向命中罚 2 分封顶 */
      }

      /* 尺寸离群：与中位数的比值偏离越大，越可能是假图案 */
      var ratio = c.size / medSize;
      if (ratio < 1) ratio = 1 / ratio;
      s += Math.max(0, Math.log(ratio)) * 1.5;

      /* 命中次数太少：可能是噪声凑出来的巧合 */
      if (c.n < 5) s += (5 - c.n) * 0.25;

      c._ps = s;
    }

    /* ③ 按这个分排序，取前 16 个进三元组候选池。
        16 个簇 → C(16,3) = 560 个三元组，每个只做一次几何打分，
        耗时可忽略；而 16 个足以在「真值排第 7」的情况下仍被包含。 */
    var sorted = cands.slice().sort(function (a, b) { return a._ps - b._ps; });
    var limit = Math.min(sorted.length, 16);

    var scored = [];
    for (var i = 0; i < limit; i++) {
      for (var j = i + 1; j < limit; j++) {
        for (var k = j + 1; k < limit; k++) {
          var trio = [sorted[i], sorted[j], sorted[k]];
          var base = rightAngleScore(trio[0], trio[1], trio[2]);
          if (!isFinite(base)) continue;
          /* 把"像不像"的分数也并进总评 —— 几何再规整，
             若三个点都是数据区黑斑，同样要往后排 */
          scored.push({ trio: trio, score: base + (trio[0]._ps + trio[1]._ps + trio[2]._ps) * 0.5 });
        }
      }
    }
    scored.sort(function (a, b) { return a.score - b.score; });

    var seen = {};
    for (var s2 = 0; s2 < scored.length && results.length < 8; s2++) {
      var ordered = orderCorners(scored[s2].trio[0], scored[s2].trio[1], scored[s2].trio[2]);
      var key = Math.round(ordered.topLeft.x) + ',' + Math.round(ordered.topLeft.y) + '|' +
                Math.round(ordered.topRight.x) + ',' + Math.round(ordered.topRight.y);
      if (seen[key]) continue;
      seen[key] = 1;
      results.push(ordered);
    }
    return results;
  }

  window.QRDecode = {
    fromImageData: fromImageData,
    /* 暴露给测试用 */
    _binarize: binarize,
    _finderScan: finderScan,
    _cluster: clusterCandidates,
    _pickThreeCombos: pickThreeCombos,
    _readFormat: readFormat,
    _moduleCount: moduleCount,
    _rsDecode: rsDecode,
    _rsEncode: rsEncode,
    _decodePayload: decodePayload,
    _BitStream: BitStream
  };
})();
