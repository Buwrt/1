#!/usr/bin/env node
/* 统计真实 README 渲染成 DOM 之后到底有多大 —— 只看不看翻。
 *
 * 为什么要按 md.js 的原样渲染（marked + highlight.js）：
 *   开了高亮之后，一段 100 行的 shell 会被 hljs 切成上千个 <span class="hljs-…">，
 *   行号栏还会每行多一个 <div>。这些都落在 <pre> 里、翻译不会碰，
 *   但 collect() 的 TreeWalker 每一次都要从它们身上走过去。
 *   「翻译慢」的一大半就花在这段谁也看不见的地方。
 *
 * 用法：node tools/readme-stats.js [目录]
 */
'use strict';
var fs = require('fs'), path = require('path');
var JSDOM;
try { JSDOM = require('jsdom').JSDOM; } catch (e) { console.error('需要 jsdom'); process.exit(2); }
var marked = require('marked').marked;
var hljs = require('highlight.js');

var dir = process.argv[2] || path.join(__dirname, 'readme');
var vh = 800, PAD = 600, CH = 42, LH = 22, GAP = 10;

/* 跟 md.js 的 renderer.code 一模一样：高亮 + 行号栏 */
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
    if (lines > 1 && lines < 400) {
      for (var i = 1; i <= lines; i++) gutter += '<div>' + i + '</div>';
    }
    return '<pre class="md-code"><div class="code-lines">' +
      (gutter ? '<div class="gutter">' + gutter + '</div>' : '') +
      '<code class="hljs language-' + (lang || 'text') + '">' + html + '</code></div></pre>';
  }
};
marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
marked.use({ renderer: renderer });

var SKIP_SEL = 'pre, code, svg, script, style, textarea, noscript, [data-no-translate], .no-translate, .hljs, .tr-skip';

function analyse(file) {
  var src = fs.readFileSync(file, 'utf8');
  var t0 = Date.now();
  var html = marked.parse(src);
  var tRender = Date.now() - t0;
  var dom = new JSDOM('<!doctype html><body><div id="readme">' + html + '</div></body>',
    { runScripts: 'outside-only' });
  var w = dom.window;
  var readme = w.document.getElementById('readme');

  var allEl = readme.querySelectorAll('*').length;
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

  /* 模拟 collect() 走一遍：数它到底踩过多少个节点、要给多少个父元素做 closest */
  var visited = 0, skipped = 0, cand = 0, near = 0, nearChars = 0, chars = 0, maxLen = 0;
  var parents = new Set();
  var t1 = Date.now();
  var wk = w.document.createTreeWalker(readme, 4, null, false), n;
  while ((n = wk.nextNode())) {
    visited++;
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    var p = n.parentElement;
    if (!p) { skipped++; continue; }
    parents.add(p);                                  // 每个都要 closest(SKIP_SEL) 一次
    if (p.closest && p.closest(SKIP_SEL)) { skipped++; continue; }
    var s = n.nodeValue.replace(/\s+/g, ' ').trim();
    if (s.length < 2) continue;
    cand++; chars += s.length;
    if (s.length > maxLen) maxLen = s.length;
    var r = rectOf(p);
    if (r.bottom > -PAD && r.top < vh + PAD) { near++; nearChars += s.length; }
  }
  var tWalk = Date.now() - t1;
  return {
    file: path.basename(file), el: allEl, visited: visited, skipped: skipped, parents: parents.size,
    cand: cand, chars: chars, near: near, nearChars: nearChars, maxLen: maxLen,
    tRender: tRender, tWalk: tWalk
  };
}

var rows = fs.readdirSync(dir).filter(function (f) { return /\.md$/.test(f); })
  .map(function (f) { return analyse(path.join(dir, f)); });
console.log('样本                              元素数 文本节点  被跳过  候选段  要翻字 首屏段 首屏字 最长  渲染  遍历');
rows.forEach(function (r) {
  console.log(P(r.file, 33) + P(r.el) + P(r.visited) + P(r.skipped) + P(r.cand) +
    P(r.chars) + P(r.near) + P(r.nearChars) + P(r.maxLen) + P(r.tRender + 'ms') + P(r.tWalk + 'ms'));
});
console.log('\n元素数 = 渲染出来的 HTML 元素总数（含 hljs 的 span 和行号栏的 div）');
console.log('被跳过 = 落在 pre / code / .hljs 里、翻译根本不碰的文本节点');
console.log('候选段 = 值得翻译的文本节点；首屏段 = 视口 ±600px 内真正要翻的那些');
console.log('遍历   = 模拟 collect() 走一遍的耗时（jsdom，真机 WebView 更慢）');
function P(s, n) { s = String(s); n = n || 8; while (s.length < n) s = ' ' + s; return s; }
