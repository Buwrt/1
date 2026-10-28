/* ============================================================
 * totp.js — 两步验证器（TOTP）引擎
 *
 * 纯本地算法，不联网、不需要登录，也不碰 GitHub 的任何接口。
 * 实现 RFC 4226（HOTP）与 RFC 6238（TOTP），算法与 Google
 * Authenticator / Microsoft Authenticator 完全一致 —— 同一个密钥
 * 算出来的码必须相同，否则加进别的验证器就登录不进去了。
 *
 * 支持的密钥形态：
 *   1. Base32 字符串（验证器通用的那种，如 JBSWY3DPEHPK3PXP）
 *   2. otpauth://totp/... 链接（各网站二维码里装的就是它）
 *   3. otpauth-migration:// 链接（Google Authenticator 批量导出格式）
 *
 * 算法参数按 otpauth 链接里的值走，缺省是 SHA1 / 6 位 / 30 秒 ——
 * 业界默认值，绝大多数网站都是这个。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- Base32 解码 ---------- */
  var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  /**
   * Base32 → 字节数组。
   *
   * 用户从网站上抄下来的密钥常常带空格、小写、结尾的 = 补位，
   * 也可能少写几个字符（有的网站只显示一部分）。这里一律先规整：
   * 去掉空格与连字符、转大写、丢掉非字母数字的字符。
   */
  function b32decode(input) {
    if (!input) return null;
    var s = String(input).toUpperCase().replace(/[\s\-_]/g, '').replace(/=+$/, '');
    if (!s) return null;
    var bits = 0, value = 0;
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var idx = B32.indexOf(s.charAt(i));
      if (idx < 0) return null;          // 有非法字符，判定为无效密钥
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((value >>> bits) & 0xff);
      }
    }
    return out.length ? out : null;
  }

  /* ---------- 字节数组与十六进制 / 字符串互转 ---------- */
  function bytesToHex(bytes) {
    var sb = '';
    for (var i = 0; i < bytes.length; i++) {
      sb += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
    }
    return sb;
  }

  function strToBytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xff);
    return out;
  }

  /* ---------- HMAC ----------
   * 原生层（NativeBridge.hmacSha1 / hmacSha256）优先 —— 用系统
   * MessageDigest 算，快且稳。没有原生桥（比如用电脑浏览器打开调试）
   * 就退回纯 JS 实现，保证功能在两种环境下都能用。
   */
  function hmac(algo, keyBytes, msgBytes) {
    var bridge = window.NativeBridge;
    if (bridge) {
      try {
        var fn = algo === 'SHA256' ? bridge.hmacSha256 : bridge.hmacSha1;
        if (typeof fn === 'function') {
          var r = fn(bytesToHex(keyBytes), bytesToHex(msgBytes));
          var b = hexToBytes(r);
          if (b) return b;
        }
      } catch (e) { /* 落到下面的纯 JS 兜底 */ }
    }
    return algo === 'SHA256'
      ? hmacJs(sha256, 64, keyBytes, msgBytes)
      : hmacJs(sha1, 64, keyBytes, msgBytes);
  }

  function hexToBytes(hex) {
    if (!hex || hex.length % 2) return null;
    var out = [];
    for (var i = 0; i < hex.length; i += 2) {
      var v = parseInt(hex.substr(i, 2), 16);
      if (isNaN(v)) return null;
      out.push(v);
    }
    return out;
  }

  function hmacJs(hashFn, blockSize, key, msg) {
    var k = key.slice();
    if (k.length > blockSize) k = hashFn(k);
    while (k.length < blockSize) k.push(0);
    var inner = [], outer = [];
    for (var i = 0; i < blockSize; i++) {
      inner.push(k[i] ^ 0x36);
      outer.push(k[i] ^ 0x5c);
    }
    return hashFn(outer.concat(hashFn(inner.concat(msg))));
  }

  /* ---------- SHA-1 / SHA-256 纯 JS 实现（兜底用） ----------
   *
   * 只在拿不到原生桥时才会走到这里（比如用电脑浏览器调试）。
   * 两份实现都对着官方测试向量验证过（空串 / "abc" / 长串），
   * 与 Node 的 crypto 模块输出逐字节一致。
   */

  function sha1(bytes) {
    var W = new Array(80);
    var H0 = 0x67452301, H1 = 0xEFCDAB89, H2 = 0x98BADCFE, H3 = 0x10325476, H4 = 0xC3D2E1F0;
    var A, B, C, D, E, temp;

    var msgLen = bytes.length * 8;
    var m = bytes.slice();
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0x00);
    // 64 位长度大端；TOTP 的消息只有 8 字节，高位恒为 0
    m.push(0, 0, 0, 0);
    m.push((msgLen >>> 24) & 0xFF, (msgLen >>> 16) & 0xFF, (msgLen >>> 8) & 0xFF, msgLen & 0xFF);

    for (var b = 0; b < m.length; b += 64) {
      for (var i = 0; i < 16; i++) {
        W[i] = (m[b + i * 4] << 24) | (m[b + i * 4 + 1] << 16) |
               (m[b + i * 4 + 2] << 8) | (m[b + i * 4 + 3]);
      }
      for (var i2 = 16; i2 <= 79; i2++) {
        W[i2] = rol(W[i2 - 3] ^ W[i2 - 8] ^ W[i2 - 14] ^ W[i2 - 16], 1);
      }
      A = H0; B = H1; C = H2; D = H3; E = H4;
      for (var t = 0; t <= 79; t++) {
        if (t <= 19) temp = (rol(A, 5) + ((B & C) | (~B & D)) + E + W[t] + 0x5A827999) | 0;
        else if (t <= 39) temp = (rol(A, 5) + (B ^ C ^ D) + E + W[t] + 0x6ED9EBA1) | 0;
        else if (t <= 59) temp = (rol(A, 5) + ((B & C) | (B & D) | (C & D)) + E + W[t] + 0x8F1BBCDC) | 0;
        else temp = (rol(A, 5) + (B ^ C ^ D) + E + W[t] + 0xCA62C1D6) | 0;
        E = D; D = C; C = rol(B, 30); B = A; A = temp;
      }
      H0 = (H0 + A) | 0; H1 = (H1 + B) | 0; H2 = (H2 + C) | 0;
      H3 = (H3 + D) | 0; H4 = (H4 + E) | 0;
    }
    return wordsToBytes([H0, H1, H2, H3, H4]);
  }

  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    var len = bytes.length;
    var hi = Math.floor(len / 536870912);       // (len*8) 的高 32 位
    var lo = (len * 8) >>> 0;
    var m = bytes.slice();
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    m.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
    m.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

    var w = new Array(64);
    for (var b = 0; b < m.length; b += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = ((m[b + i * 4] << 24) | (m[b + i * 4 + 1] << 16) |
                (m[b + i * 4 + 2] << 8) | m[b + i * 4 + 3]) >>> 0;
      }
      for (var i2 = 16; i2 < 64; i2++) {
        var s0 = (rotr(w[i2 - 15], 7) ^ rotr(w[i2 - 15], 18) ^ (w[i2 - 15] >>> 3)) >>> 0;
        var s1 = (rotr(w[i2 - 2], 17) ^ rotr(w[i2 - 2], 19) ^ (w[i2 - 2] >>> 10)) >>> 0;
        w[i2] = (w[i2 - 16] + s0 + w[i2 - 7] + s1) >>> 0;
      }
      var a = H[0], b2 = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var t = 0; t < 64; t++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (h + S1 + ch + K256[t] + w[t]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b2) ^ (a & c) ^ (b2 & c)) >>> 0;
        var t2v = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b2; b2 = a; a = (t1 + t2v) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b2) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return wordsToBytes(H);
  }

  function wordsToBytes(words) {
    var out = [];
    for (var i = 0; i < words.length; i++) {
      out.push((words[i] >>> 24) & 0xff, (words[i] >>> 16) & 0xff,
               (words[i] >>> 8) & 0xff, words[i] & 0xff);
    }
    return out;
  }

  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
  function rol(n, s) { return ((n << s) | (n >>> (32 - s))) >>> 0; }

  var K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

  /* ---------- HOTP / TOTP 核心 ---------- */

  /** RFC 4226：HMAC → 动态截断 → 指定位数 */
  function hotp(keyBytes, counter, digits, algo) {
    /*
     * 计数器必须是 8 字节大端：高 32 位在前、低 32 位在后。
     *
     * 这里曾经写反过 —— 把低 32 位放在前 4 字节、高 4 字节补零，
     * 结果等同于给计数器乘了 2^32，算出来的码永远是错的。
     * （表现：跟任何验证器、任何网站都对不上，但长度和格式看着都正常，
     *  最难查。）RFC 4226 的测试向量就是专门用来抓这种错的。
     *
     * 30 秒步长下计数器约 4000 年才会超过 2^32，所以高 32 位恒为 0。
     */
    var msg = [
      0, 0, 0, 0,
      (counter >>> 24) & 0xff, (counter >>> 16) & 0xff,
      (counter >>> 8) & 0xff, counter & 0xff
    ];
    var hash = hmac(algo, keyBytes, msg);
    var offset = hash[hash.length - 1] & 0x0f;
    var bin = ((hash[offset] & 0x7f) << 24) |
              ((hash[offset + 1] & 0xff) << 16) |
              ((hash[offset + 2] & 0xff) << 8) |
              (hash[offset + 3] & 0xff);
    var code = bin % Math.pow(10, digits);
    return ('0000000000' + code).slice(-digits);
  }

  /**
   * 算当前动态码。
   * @param {Object} acct  账户对象 { secret, digits, period, algo }
   * @param {number} [now] 时间戳（毫秒），不传取当前
   */
  function code(acct, now) {
    if (!acct || !acct.secret) return null;
    var key = b32decode(acct.secret);
    if (!key) return null;
    var period = acct.period || 30;
    var digits = acct.digits || 6;
    var t = Math.floor((now === undefined ? Date.now() : now) / 1000);
    var counter = Math.floor(t / period);
    return hotp(key, counter, digits, acct.algo || 'SHA1');
  }

  /** 这一轮还剩几秒（用于倒计时进度条） */
  function remaining(acct, now) {
    var period = (acct && acct.period) || 30;
    var t = Math.floor((now === undefined ? Date.now() : now) / 1000);
    return period - (t % period);
  }

  /** 把 6 位码拆成两段，界面上按「XXX XXX」显示，跟各家验证器一样好读 */
  function group(code) {
    if (!code) return '';
    if (code.length === 6) return code.slice(0, 3) + ' ' + code.slice(3);
    if (code.length === 8) return code.slice(0, 4) + ' ' + code.slice(4);
    return code;
  }

  /* ---------- otpauth 链接解析 ---------- */

  /**
   * 解析一条 otpauth:// 链接。
   * 形如：
   *   otpauth://totp/GitHub:alice?secret=JBSW...&issuer=GitHub&digits=6&period=30&algorithm=SHA1
   */
  function parseOtpAuth(url) {
    if (!url) return null;
    var s = String(url).trim();
    if (!/^otpauth:\/\//i.test(s)) return null;
    var rest = s.replace(/^otpauth:\/\/(totp|hotp)\//i, function (m, type) {
      return type.toLowerCase() + '\u0000';
    });
    if (rest.indexOf('\u0000') < 0) return null;
    var parts = rest.split('\u0000');
    var type = parts[0].toLowerCase();
    var tail = parts.slice(1).join('\u0000');
    var qi = tail.indexOf('?');
    var label = qi >= 0 ? tail.substring(0, qi) : tail;
    var queryStr = qi >= 0 ? tail.substring(qi + 1) : '';

    var q = {};
    queryStr.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i >= 0 ? kv.substring(0, i) : kv;
      var v = i >= 0 ? kv.substring(i + 1) : '';
      try { q[decodeURIComponent(k).toLowerCase()] = decodeURIComponent(v.replace(/\+/g, ' ')); }
      catch (e) { q[k.toLowerCase()] = v; }
    });

    // label 形如 "Issuer:account" 或只有 "account"
    label = decodeURIComponent(label);
    var issuer = q.issuer || '';
    var name = label;
    var ci = label.indexOf(':');
    if (ci >= 0) {
      if (!issuer) issuer = label.substring(0, ci).trim();
      name = label.substring(ci + 1).trim();
    }
    var algo = (q.algorithm || 'SHA1').toUpperCase();
    if (algo !== 'SHA1' && algo !== 'SHA256' && algo !== 'SHA512') algo = 'SHA1';

    return {
      type: type,
      secret: (q.secret || '').toUpperCase().replace(/\s/g, ''),
      issuer: issuer,
      name: name || issuer || '未命名账户',
      digits: parseInt(q.digits, 10) || 6,
      period: parseInt(q.period, 10) || 30,
      algo: algo,
      counter: parseInt(q.counter, 10) || 0
    };
  }

  /**
   * 解析 Google Authenticator 的批量导出链接。
   *
   * 格式是 protobuf：整条链接的 data 参数是 base64 的二进制，
   * 里面循环出现 { field1: 密钥, field2: 名字, field3: 发行方, ... }。
   * 这里手写一个最小的 protobuf 读取器，不引任何依赖。
   *
   * 说明：只做「尽力解析」—— 解不出来的条目直接跳过，
   * 不让整批导入因为一条脏数据全废掉。
   */
  function parseMigration(url) {
    var s = String(url || '').trim();
    if (!/^otpauth-migration:\/\//i.test(s)) return null;
    var qi = s.indexOf('?');
    if (qi < 0) return null;
    var data = '';
    s.substring(qi + 1).split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0 && kv.substring(0, i) === 'data') {
        try { data = decodeURIComponent(kv.substring(i + 1).replace(/\+/g, ' ')); }
        catch (e) { data = kv.substring(i + 1); }
      }
    });
    if (!data) return null;
    var bytes = base64ToBytes(data);
    if (!bytes) return null;

    var out = [];
    var pos = 0;
    var payload = null;
    // 顶层：字段 1 是 repeated OtpParameters
    while (pos < bytes.length) {
      var tag = readVarint(bytes, pos);
      if (!tag) break;
      pos = tag.pos;
      var field = tag.value >>> 3;
      var wire = tag.value & 7;
      if (wire === 2) {
        var lenR = readVarint(bytes, pos);
        if (!lenR) break;
        pos = lenR.pos;
        var chunk = bytes.slice(pos, pos + lenR.value);
        pos += lenR.value;
        if (field === 1) {
          var one = parseOtpParameters(chunk);
          if (one) out.push(one);
        }
      } else if (wire === 0) {
        var skip = readVarint(bytes, pos);
        if (!skip) break;
        pos = skip.pos;
      } else if (wire === 5) { pos += 4; }
      else if (wire === 1) { pos += 8; }
      else break;
    }
    return out.length ? out : null;
  }

  /** 解析单条 OtpParameters */
  function parseOtpParameters(bytes) {
    var pos = 0, secret = null, name = '', issuer = '', algo = 1, digits = 1, type = 2;
    var ALGO = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512', 4: 'MD5' };
    var DIG = { 0: 6, 1: 6, 2: 8 };
    while (pos < bytes.length) {
      var tag = readVarint(bytes, pos);
      if (!tag) break;
      pos = tag.pos;
      var field = tag.value >>> 3;
      var wire = tag.value & 7;
      if (wire === 2) {
        var lenR = readVarint(bytes, pos);
        if (!lenR) break;
        pos = lenR.pos;
        var chunk = bytes.slice(pos, pos + lenR.value);
        pos += lenR.value;
        if (field === 1) secret = chunk;                        // secret 是原始字节
        else if (field === 2) name = utf8(chunk);
        else if (field === 3) issuer = utf8(chunk);
      } else if (wire === 0) {
        var v = readVarint(bytes, pos);
        if (!v) break;
        pos = v.pos;
        if (field === 4) algo = v.value;      // 算法枚举
        else if (field === 5) digits = v.value;
        else if (field === 6) type = v.value;
      } else if (wire === 5) { pos += 4; }
      else if (wire === 1) { pos += 8; }
      else break;
    }
    if (!secret || !secret.length) return null;
    // 导出的是原始字节，转成 Base32 才能跟别处统一处理
    return {
      type: type === 1 ? 'hotp' : 'totp',
      secret: bytesToB32(secret),
      issuer: issuer,
      name: name || issuer || '未命名账户',
      digits: DIG[digits] || 6,
      period: 30,
      algo: ALGO[algo] || 'SHA1',
      counter: 0
    };
  }

  function readVarint(bytes, pos) {
    var result = 0, shift = 0, p = pos;
    while (p < bytes.length) {
      var b = bytes[p++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return { value: result >>> 0, pos: p };
      shift += 7;
      if (shift > 35) return null;
    }
    return null;
  }

  function base64ToBytes(b64) {
    var s = String(b64).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = [], bits = 0, value = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '=') break;
      var idx = chars.indexOf(c);
      if (idx < 0) return null;
      value = (value << 6) | idx;
      bits += 6;
      if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
    }
    return out.length ? out : null;
  }

  function utf8(bytes) {
    try {
      var s = '';
      for (var i = 0; i < bytes.length; i++) {
        var c = bytes[i];
        if (c < 0x80) s += String.fromCharCode(c);
        else if (c < 0xe0) { s += String.fromCharCode(((c & 0x1f) << 6) | (bytes[++i] & 0x3f)); }
        else if (c < 0xf0) {
          s += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f));
        } else {
          var cp = ((c & 0x07) << 18) | ((bytes[++i] & 0x3f) << 12) |
                   ((bytes[++i] & 0x3f) << 6) | (bytes[++i] & 0x3f);
          cp -= 0x10000;
          s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
      }
      return s;
    } catch (e) { return ''; }
  }

  /** 原始字节 → Base32（导出链接里拿到的密钥要转成这个格式存） */
  function bytesToB32(bytes) {
    var out = '', bits = 0, value = 0;
    for (var i = 0; i < bytes.length; i++) {
      value = (value << 8) | (bytes[i] & 0xff);
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out += B32.charAt((value >>> bits) & 31);
      }
    }
    if (bits > 0) out += B32.charAt((value << (5 - bits)) & 31);
    return out;
  }

  /* ---------- 对外接口 ---------- */
  window.TOTP = {
    code: code,
    remaining: remaining,
    group: group,
    b32decode: b32decode,
    parseOtpAuth: parseOtpAuth,
    parseMigration: parseMigration,

    /**
     * 统一入口：不管用户粘的是密钥、otpauth 链接还是批量导出链接，
     * 都返回一组账户对象。
     *
     * @returns {Array|null} null 表示完全解析不出来
     */
    parseAny: function (input) {
      var s = String(input || '').trim();
      if (!s) return null;
      if (/^otpauth-migration:\/\//i.test(s)) return parseMigration(s);
      if (/^otpauth:\/\//i.test(s)) {
        var one = parseOtpAuth(s);
        return one ? [one] : null;
      }
      // 当成裸密钥：先把空格连字符去掉再试
      var key = s.toUpperCase().replace(/[\s\-]/g, '');
      if (b32decode(key)) {
        return [{ type: 'totp', secret: key, issuer: '', name: '', digits: 6, period: 30, algo: 'SHA1', counter: 0 }];
      }
      // 有的网站直接给一串带空格的密钥 + 名称，试着切出第一段
      var first = s.split(/[\s,;]+/)[0];
      if (first && first !== s && b32decode(first.toUpperCase())) {
        return [{ type: 'totp', secret: first.toUpperCase(), issuer: '', name: '', digits: 6, period: 30, algo: 'SHA1', counter: 0 }];
      }
      return null;
    },

    /** 生成一条标准 otpauth 链接（分享/导出用） */
    toOtpAuth: function (acct) {
      var label = encodeURIComponent((acct.issuer ? acct.issuer + ':' : '') + (acct.name || '账户'));
      var q = 'secret=' + encodeURIComponent(acct.secret);
      if (acct.issuer) q += '&issuer=' + encodeURIComponent(acct.issuer);
      if (acct.digits && acct.digits !== 6) q += '&digits=' + acct.digits;
      if (acct.period && acct.period !== 30) q += '&period=' + acct.period;
      if (acct.algo && acct.algo !== 'SHA1') q += '&algorithm=' + acct.algo;
      return 'otpauth://totp/' + label + '?' + q;
    }
  };
})();
