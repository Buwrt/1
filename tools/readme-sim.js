#!/usr/bin/env node
/* ============================================================
 * readme-sim.js —— README「翻译慢」的对照实验台
 *
 * 为什么单独为 README 开一个台子
 *   README 跟搜索结果、列表页都不是一类东西：
 *     1. 长 —— 正文几万字，文本节点上千个（system-design-primer 实测 1669 个）
 *     2. 代码块被 highlight.js 切成几千个 span，还每行多一个行号 <div>；
 *        这些全落在 <pre> 里、翻译一个都不碰，但每次 collect() 都要走过去
 *     3. 挂载晚 —— 文件列表画完之后 MD.mount 才把 README 塞进来，
 *        翻译的第一轮根本看不见它
 *     4. 只能滚着看 —— 一屏只装得下 40~60 段，读完一篇要滚十几二十屏
 *
 *   所以它慢在哪，必须按「一屏一屏往下滚」这条真机路径来量，
 *   拿 tr-sim.js 那种「40 段等长短句一次性翻完」的假页面量不出来。
 *
 * 假引擎这回会「翻不出来」
 *   真有道端点实测（tools/yd-probe.sh）：
 *       单段  800 字符 → errorCode 0
 *       单段 1500 字符 → 103 内容过长
 *       12 行 × 60 字符（731）→ 0；12 行 × 200 字符（2411）→ 103
 *   卡的是单次请求的【总字符数】，不是行数。所以这里照实模拟：
 *   请求体超过 800 字符就回 103。不这么做的话，长段会被假引擎顺顺利利翻出来，
 *   而真机上它们一个字都翻不动 —— 测出来的结论是反的。
 *
 * 用法
 *   node tools/readme-sim.js <translate.js 路径> <标签> [README.md 路径]
 *   TR_SIM_VERBOSE=1   打印每个请求
 *   TR_SIM_VH=800      视口高度
 *   TR_SIM_SCREENS=8   往下滚几屏
 *
 * 依赖：jsdom、marked、highlight.js（只在本工具用，不进 APK）
 * ============================================================ */
'use strict';

var fs = require('fs');
var path = require('path');

var SRC = process.argv[2];
var LABEL = process.argv[3] || '当前';
var MD_FILE = process.argv[4] ||
  path.join(__dirname, 'readme', 'donnemartin_system-design-primer.md');

var RTT = Number(process.env.TR_SIM_RTT || 120);
var VH = Number(process.env.TR_SIM_VH || 800);
var YD_LIMIT = Number(process.env.TR_SIM_YD_LIMIT || 800);
var SCREENS = Number(process.env.TR_SIM_SCREENS || 8);
var STEP = Number(process.env.TR_SIM_STEP || VH);      // 每次往下滚多少
var ROUND_CAP = Number(process.env.TR_SIM_ROUND_CAP || 12000);

var JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (e) { console.error('缺少 jsdom：  npm i jsdom'); process.exit(2); }
var marked = require('marked').marked;
var hljs = require('highlight.js');

/* ---------------- 假页面 ---------------- */
var dom = new JSDOM(
  '<!doctype html><html><body><div id="appbar-actions"></div><div id="view"></div></body></html>',
  { runScripts: 'outside-only', pretendToBeVisual: true });
var w = dom.window;
Object.defineProperty(w, 'innerHeight', { value: VH });

/* ---------------- 假网络 ---------------- */
var reqCount = 0, overLimit = 0, timeline = [];
var T0 = Date.now();
var inflight = 0, maxInflight = 0;
function nowMs() { return Date.now() - T0; }

w.NativeBridge = {
  http: function (id, method, url, body) {
    reqCount++;
    inflight++; if (inflight > maxInflight) maxInflight = inflight;
    timeline.push(nowMs());
    var q = decodeURIComponent(String(body || '').replace(/^q=/, '').split('&')[0]);
    var lines = q.split('\n');
    var payload;
    if (q.length > YD_LIMIT) {                    // 真机就是这样
      overLimit++;
      payload = { errorCode: '103', msg: '内容过长' };
    } else {
      /* TR_SIM_NOOP=1：让「路径 / 命令名」这类段原样返回，跟真机一样。
       * 默认的假翻译永远不等于原文，于是「引擎翻不出来」那条路径
       * 在仿真里一次都走不到 —— 记账和跳过逻辑就没人验。
       * 判断跟真机对得上：不带空格、且不是一句话的（solutions/、man bash、
       * apt、Total…）译出来就是它自己。 */
      payload = {
        errorCode: '0',
        translation: [lines.map(function (l, i) {
          if (process.env.TR_SIM_NOOP && /^[\w./:#+~-]+$/.test(l)) return l;
          return '【译' + (i + 1) + '】' + l.slice(0, 10);
        }).join('\n')]
      };
    }
    if (process.env.TR_SIM_VERBOSE) {
      console.log('        [req#' + reqCount + ' ' + nowMs() + 'ms] 入 ' + lines.length +
        ' 行 / ' + q.length + ' 字符 → ' + (q.length > YD_LIMIT ? '103 内容过长' : '0'));
    }
    setTimeout(function () {
      inflight--;
      w.Native._cb(id, 200, JSON.stringify(payload), '{}');
    }, RTT);
  }
};
w.Native = {
  has: function () { return true; },
  pending: {},
  _cb: function (id, status, body) {
    var p = w.Native.pending[id];
    if (p) { delete w.Native.pending[id]; p(status, body); }
  },
  http: function (method, url, body, headers) {
    var self = this;
    return new Promise(function (resolve) {
      var id = String(Math.random()).slice(2);
      self.pending[id] = function (s, b) { resolve({ status: s, body: b }); };
      w.NativeBridge.http(id, method, url, body, JSON.stringify(headers || {}));
    });
  }
};
w.UI = { toast: function (m) { if (process.env.TR_SIM_VERBOSE) console.log('        [toast] ' + m); } };
var _store = {};
w.Store = {
  getJSON: function (k, d) { return Object.prototype.hasOwnProperty.call(_store, k) ? _store[k] : d; },
  setJSON: function (k, v) { _store[k] = v; },
  get: function (k, d) { return Object.prototype.hasOwnProperty.call(_store, k) ? _store[k] : d; },
  set: function (k, v) { _store[k] = v; }
};
/* README 是页面渲染完之后才被塞进来的，真机上只能靠总开关 +
 * MutationObserver 自己补翻，所以这里必须把开关开着。 */
_store.gh_tr_auto = true;

/* ---------------- 按 md.js 的原样渲染 ---------------- */
var renderer = {
  code: function (a, b) {
    var code = (a && typeof a === 'object') ? a.text : a;
    var lang = (a && typeof a === 'object') ? a.lang : b;
    var html;
    try {
      if (lang && hljs.getLanguage(lang)) html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      else html = hljs.highlightAuto(code).value;
    } catch (e) { html = String(code).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
    var lines = String(code).split('\n').length;
    var gutter = '';
    if (lines > 1 && lines < 400) { for (var i = 1; i <= lines; i++) gutter += '<div>' + i + '</div>'; }
    return '<pre class="md-code"><div class="code-lines">' +
      (gutter ? '<div class="gutter">' + gutter + '</div>' : '') +
      '<code class="hljs language-' + (lang || 'text') + '">' + html + '</code></div></pre>';
  }
};
marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
marked.use({ renderer: renderer });

var view = w.document.getElementById('view');
var src = fs.readFileSync(MD_FILE, 'utf8');
var html = marked.parse(src);
view.innerHTML = '<div class="card"><div class="list-row static"><div id="readme" class="md">' + html + '</div></div></div>';
var readme = w.document.getElementById('readme');

/* ---------------- 估算版式 ----------------
 * jsdom 不排版，getBoundingClientRect 全是 0，得自己算。
 * 手机宽 360px、正文 14px → 一行约 42 个 ASCII 字符，行高 22px。
 * 滚动用 scrollY 平移，模拟「一屏一屏往下滚」。 */
var CH = 42, LH = 22, GAP = 10;
var scrollY = 0;
var rects = new Map();
(function layout() {
  var top = 0;
  Array.prototype.forEach.call(readme.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,th,pre,blockquote,div,tr'), function (el) {
    var isCell = el.tagName === 'TD' || el.tagName === 'TH';
    if (!isCell) top += GAP;
    var txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    var h = Math.max(1, Math.ceil(txt.length / CH)) * LH;
    rects.set(el, { top: top, bottom: top + h });
    if (!isCell) top += h;
  });
})();
function rectOf(el) { while (el) { if (rects.has(el)) return rects.get(el); el = el.parentElement; } return { top: 0, bottom: 0 }; }
(function patch() {
  Array.prototype.forEach.call(readme.querySelectorAll('*'), function (el) {
    var r = rectOf(el);
    el.getBoundingClientRect = function () { return { top: r.top - scrollY, bottom: r.bottom - scrollY }; };
  });
})();

/* ---------------- 装 translate.js ---------------- */
w.eval(fs.readFileSync(path.resolve(SRC), 'utf8'));
if (typeof w.GhTranslator === 'undefined') w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
w.GhTranslator.setEngine('youdao');
var needTr = w.GhTranslator._needTranslate;
/* 计时基准定在模块装好的这一刻：
 * translate.js 自己会在 AUTO_FIRST_DELAY(300ms) 之后自动开一轮，
 * 要是从「refresh 那一声」才开始计时，那 300ms 就凭空消失了 ——
 * 量出来的「首字 22ms」比一个往返还短，本身就是不可能的数。 */
var T_LOAD = Date.now();

/* ---------------- 谁该翻、谁不该翻 ----------------
 * 「还剩下几段英文」不能用「不是中文」来数：链接、路径、版本号
 * 本来就不该翻，数进去会永远等不到零。用翻译模块自己的判据圈定范围。 */
var targets = [];
(function mark() {
  var wk = w.document.createTreeWalker(readme, 4, null, false), n;
  while ((n = wk.nextNode())) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    if (!needTr(n.nodeValue)) continue;
    var r = rectOf(n.parentElement);
    targets.push({ node: n, top: r.top, bottom: r.bottom });
  }
})();
function isZh(n) { return /^【译/.test(n.nodeValue); }
function doneCount() { var c = 0; targets.forEach(function (t) { if (isZh(t.node)) c++; }); return c; }
function nearTargets() {
  var pad = 600;
  return targets.filter(function (t) { return t.bottom - scrollY > -pad && t.top - scrollY < VH + pad; });
}
function nearDone() { var c = 0; nearTargets().forEach(function (t) { if (isZh(t.node)) c++; }); return c; }

/* 眼睛真正盯着的那一屏（不带 600px 预取）。
 * 「这一屏翻完了吗」跟「这一轮收工了吗」是两件事：
 * 整篇模式下这一轮会一直往外冒译文，用 QUIET 判据量出来的必然是整轮收工，
 * 拿它当「首屏翻完」就会把整篇的时间算到第一屏头上。 */
function screenTargets() {
  return targets.filter(function (t) { return t.bottom - scrollY > 0 && t.top - scrollY < VH; });
}
function screenDone() {
  var c = 0;
  screenTargets().forEach(function (t) { if (isZh(t.node)) c++; });
  return c;
}

/* 主线程被占掉多少 —— 用「心跳间隔的最大延迟」来量，不碰模块内部。
 * collect() 走 TreeWalker + getBoundingClientRect、apply() 往 DOM 写译文，
 * 两样都在主线程上同步跑，期间心跳就跳不动。
 * 真机 WebView 上 getBoundingClientRect 会强制排版，比 jsdom 里贵得多，
 * 所以这里量出来的数字只能当**下限**看：jsdom 里都卡，真机只会更卡。 */
var MT = { maxGap: 0, gaps: [], last: Date.now(), n: 0 };
var _hb = setInterval(function () {
  var now = Date.now();
  var g = now - MT.last;
  MT.last = now;
  MT.n++;
  if (g > MT.maxGap) MT.maxGap = g;
  if (g >= 30) MT.gaps.push(g);          // 掉帧级别（>30ms）的卡顿单独记一笔
}, 10);

/* ---------------- 跑 ---------------- */
var rounds = [];
/**
 * 等这一屏翻完。
 * 判据不能是「出现了第一段译文」——上一轮的请求可能还在飞，
 * 那样一量到就滚下一屏，量出来的每一屏都是半截的。
 * 这里改成「连续 QUIET ms 没有新译文上屏」才算这一屏收工。
 */
var QUIET = Number(process.env.TR_SIM_QUIET || 800);
function waitNear() {
  var t0 = Date.now();
  var seen = -1, quietSince = Date.now();
  return new Promise(function (resolve) {
    var poll = setInterval(function () {
      var nd = nearDone();
      if (nd !== seen) { seen = nd; quietSince = Date.now(); }
      /* 记这一屏「眼睛里那一段」什么时候全变中文 —— 跟整轮收工分开记 */
      if (Date.now() - quietSince >= QUIET || Date.now() - t0 > ROUND_CAP) {
        clearInterval(poll);
        resolve({ ms: quietSince - t0, nearDone: nd, total: doneCount() });
      }
    }, 20);
  });
}

setTimeout(function () {
  /* 真机：仓库页先画完 → 翻译第一轮（看不见 README）→ MD.mount 把 README 塞进来
   * → 翻译靠自己那条链补上。改过的 page-repo.js 会在 mount 后打一声招呼，
   * 旧版没这个 API，缺了它正是「改前」的真实情况。 */
  try { if (w.GhTranslator.refresh) w.GhTranslator.refresh(readme); } catch (e) {}
  var t0 = T_LOAD;
  var first = 0;
  var fseen = -1, fquiet = Date.now();
  /* 眼睛里那一屏自己的收工时刻：这一屏的译文 200ms 没再增加就算翻完了。
   * 不能用「等于这一段的总数」—— 里面混着 solutions/、man bash 这类
   * 本来就翻不出中文的段，等号永远等不到。 */
  var sseen = -1, squiet = Date.now(), sfull = 0;
  (function settleFirst() {
    var poll = setInterval(function () {
      var d = doneCount();
      if (d >= 1 && !first) first = Date.now() - t0;
      if (d !== fseen) { fseen = d; fquiet = Date.now(); }
      var sd = screenDone();
      if (sd !== sseen) { sseen = sd; squiet = Date.now(); }
      if (!sfull && sd > 0 && Date.now() - squiet >= 200) sfull = squiet - t0;
      if (Date.now() - fquiet >= QUIET || Date.now() - t0 > ROUND_CAP) {
        clearInterval(poll);
        /* 把「首屏那一段」的清单当场存下来：报告是在滚完 8 屏之后才打的，
         * 那时候 screenTargets() 取到的是第 8 屏，拿它当首屏量就全错了。 */
        rounds.push({ name: '首屏（README 挂载后）', ms: fquiet - t0, first: first,
          screen: sfull, screenN: screenTargets().length, screenDone: sd,
          screenList: screenTargets().slice(),
          near: nearTargets().length, done: d, req: reqCount });
        chain(1);
      }
    }, 20);
  })();
}, 200);

function chain(i) {
  if (i > SCREENS) { report(); return; }
  var req0 = reqCount;
  scrollY += STEP;                                   // 往下滚一屏
  /* 真机是 watchScroll 在 document 捕获阶段收 scroll 事件，250ms 防抖 */
  w.document.dispatchEvent(new w.Event('scroll'));
  waitNear().then(function (m) {
    rounds.push({ name: '第 ' + i + ' 屏', ms: m.ms, first: 0, near: nearTargets().length,
      done: m.nearDone, req: reqCount - req0 });
    chain(i + 1);
  });
}

function report() {
  clearInterval(_hb);
  var name = path.basename(MD_FILE);
  console.log('[' + LABEL + '] ' + name + ' · 有道 · 单请求上限 ' + YD_LIMIT + ' 字符 · 视口 ' + VH + 'px');
  console.log('        全文 ' + targets.length + ' 段待翻，DOM ' + readme.querySelectorAll('*').length + ' 个元素');
  console.log('        ┌──────────────────────────┬────────┬────────┬────────┬────────┐');
  console.log('        │ 阶段                     │ 首字   │ 全屏   │ 本屏段 │ 请求   │');
  console.log('        ├──────────────────────────┼────────┼────────┼────────┼────────┤');
  rounds.forEach(function (r) {
    console.log('        │ ' + P(r.name, 24) + ' │ ' + P(r.first ? r.first + 'ms' : '—') +
      ' │ ' + P(r.ms + 'ms') + ' │ ' + P(r.near) + ' │ ' + P(r.req + ' 次') + ' │');
  });
  console.log('        └──────────────────────────┴────────┴────────┴────────┴────────┘');
  var totalMs = rounds.reduce(function (a, r) { return a + r.ms; }, 0);
  var r0 = rounds[0] || {};
  console.log('        ★ 眼睛里那一屏（' + r0.screenDone + '/' + r0.screenN +
    ' 段）翻完：' + r0.screen + 'ms ｜ 首字 ' + r0.first + 'ms ｜ 整轮收工 ' + r0.ms + 'ms');
  console.log('        滚完 ' + SCREENS + ' 屏累计 ' + totalMs + 'ms ｜ 全程译文上屏 ' +
    doneCount() + '/' + targets.length + ' 段 ｜ 请求 ' + reqCount +
    ' 次 ｜ 被 103 拦下 ' + overLimit + ' 次 ｜ 峰值并发 ' + maxInflight);
  console.log('        主线程最长卡顿 ' + MT.maxGap + 'ms ｜ ≥30ms 的卡顿 ' + MT.gaps.length +
    ' 次' + (MT.gaps.length ? '（' + MT.gaps.slice(0, 8).join(', ') + 'ms）' : ''));

  /* 翻完之后缓存还剩什么？——第二次进同一个仓库还能不能白嫖
   * 缓存上限只有 600 条、淘汰又是 FIFO（超了就扔最早写入的 200 条），
   * 而一篇 README 自己就有上千段。翻完一遍，最前面那几屏很可能已经被
   * 自己后来的段挤出去了：用户再进来，第一屏又得从头翻一遍。 */
  var c = _store.gh_tr_cache || {};
  var keys = Object.keys(c);
  /* 首屏那段用的 key 跟模块里一样：engine|TO|hash(原文) */
  var eng = 'youdao', tgt = 'zh-CHS';
  function h(s) { var x = 5381, i = s.length; while (i) x = (x * 33) ^ s.charCodeAt(--i); return (x >>> 0).toString(36); }
  /* 只数「真的译出来了」的段：路径 / 命令名那类本来就翻不出中文的
   * 不进缓存（这是设计如此），把它们算进分母会让数字永远难看，也不诚实。 */
  var scr = (r0.screenList || []).filter(function (t) { return isZh(t.node); });
  var hit = 0;
  scr.forEach(function (t) {
    /* 节点上现在写的是译文，原文已经不在 DOM 里了 —— 用译文反查：
     * 只要缓存里还留着「这段原文的译文」，就说明没被挤掉 */
    var cur = String(t.node.nodeValue || '');
    for (var k in c) if (c[k] === cur) { hit++; break; }
  });
  console.log('        翻完落盘 ' + keys.length + ' 条缓存 ｜ 首屏真正译出的 ' + scr.length +
    ' 段里还在缓存中的：' + hit + ' 段' +
    (hit < scr.length ? '  ← 少的那几段被自己后来的段挤出去了，再进来要重翻' : '  ✓ 再进来直接命中'));
  /* 剩下的那几段到底是不是「没翻出来」？拿 TR_SIM_DUMP=1 看一眼：
   * 如果剩下的全是版本号 / 路径 / 专有名词，那它们本来就不该变中文，
   * 计数差不是 bug。只有出现整句英文才算漏翻。 */
  if (process.env.TR_SIM_DUMP) {
    var left = targets.filter(function (t) { return !isZh(t.node); });
    console.log('        仍非中文 ' + left.length + ' 段，抽样：');
    left.slice(0, 12).forEach(function (t) {
      var s = String(t.node.nodeValue || '').trim().replace(/\s+/g, ' ');
      console.log('          · ' + (s.length > 60 ? s.slice(0, 60) + '…' : s));
    });
  }
}
function P(s, n) { s = String(s); n = n || 8; while (s.length < n) s = ' ' + s; return s; }
