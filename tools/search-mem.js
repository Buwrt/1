#!/usr/bin/env node
/* ============================================================
 * search-mem.js —— 搜索结果缓存在内存里到底占多少
 *
 * 为什么要有它：
 *   「用着用着界面变成一张不会动的图」听起来像渲染问题，实际多半是内存账。
 *   搜索页把每个关键词的结果都缓存进 SEARCH_STATE（为了从详情页回来能还原），
 *   而那里面存的是 GitHub 返回的**完整对象**。这个写入以前没有上限、
 *   也从来不删。这份 ciashych㎡ 就是把它量成具体数字 ——
 *   堆 inactivated而不是凭一句「字段很多」拍脑袋。
 *
 * 怎么量的：
 *   把一份真实的 /search 响应解析进 V8，读 process.memoryUsage().heapUsed()
 *   的增量；再把「瘦身」过的对象同样解析一份，对比两者。
 *   V8 就是 WebView 里的那个引擎，所以这个差值是可信的。
 *
 * 用法：
 *   node tools/search-mem.js                  联网取一份真实数据（公开接口，有配额）
 *   node tools/search-mem.js /path/resp.json  用拉好的响应离线跑
 *
 * 注意：瘦身的那份字段表要和 page-home.js 里的 SEARCH_SLIM 保持一致，
 *      两边对不上这份测量就没有意义了。
 * ============================================================ */
'use strict';

var fs = require('fs');
var https = require('https');

/* 跟 page-home.js 的 SEARCH_SLIM 同款：只留这一页画得出来的字段 */
var SLIM_SHAPE = {
  repositories: ['full_name', 'private', 'description', 'language',
    'stargazers_count', 'forks_count', 'updated_at'],
  users: ['login', 'avatar_url', 'type'],
  topics: ['name', 'display_name', 'short_description'],
  issues: ['repository_url', 'number', 'pull_request', 'state', 'title',
    'created_at', 'comments']
};

function slim(item, fields) {
  var o = {};
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (item[f] !== undefined) o[f] = item[f];
  }
  return o;
}

function fetchJson(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, {
      headers: { 'User-Agent': 'githup-mem-probe', 'Accept': 'application/vnd.github+json' }
    }, function (res) {
      var b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('响应不是 JSON：' + b.slice(0, 120))); }
      });
    }).on('error', reject);
  });
}

/** 装 n 份同样的列表到堆里，返回 heapUsed 增量（KB） */
function heapOf(makeList, n) {
  global.gc && global.gc();
  var held = [];
  var before = process.memoryUsage().heapUsed;
  for (var i = 0; i < n; i++) held.push(makeList(i));
  var after = process.memoryUsage().heapUsed;
  held.length = 0;
  return { kb: (after - before) / 1024, per: (after - before) / 1024 / n };
}

var KEYS = 30;          // 假设用户敲过 30 个不同的关键词
var ITEMS = 30;         // 每个词缓存一页 30 条

function main(items) {
  var fields = SLIM_SHAPE.repositories;
  var rawTF = 0, slimTF = 0;
  items.forEach(function (it) {
    rawTF += JSON.stringify(it).length;
    slimTF += JSON.stringify(slim(it, fields)).length;
  });

  console.log('样本：' + items.length + ' 条真实仓库结果');
  console.log('  JSON 体积     瘦身前 ' + (rawTF / 1024).toFixed(1) + ' KB' +
    '  →  瘦身后 ' + (slimTF / 1024).toFixed(1) + ' KB' +
    '   （' + (rawTF / slimTF).toFixed(0) + ' 倍）');

  var raw = heapOf(function () { return items.map(function (x) { return JSON.parse(JSON.stringify(x)); }); }, KEYS);
  var sm = heapOf(function (i) { return items.map(function (x) { return slim(x, fields); }); }, KEYS);

  console.log('  堆内实测      ' + KEYS + ' 个关键词 × ' + ITEMS + ' 条');
  console.log('      瘦身前 ' + (raw.kb / 1024).toFixed(2) + ' MB  （每个词 ' + raw.per.toFixed(0) + ' KB）');
  console.log('      瘦身后 ' + (sm.kb / 1024).toFixed(2) + ' MB  （每个词 ' + sm.per.toFixed(0) + ' KB）');
  console.log('      省下   ' + (100 * (1 - sm.kb / raw.kb)).toFixed(1) + '%');
  console.log('');
  console.log('  注：瘦身前这份内存是「敲一个词就涨一笔、从来不释放」的。');
  console.log('      它是把 WebView 渲染进程喂到被系统回收的那笔账 —— 进程一死，');
  console.log('      画面就停在最后一帧，也就是用户讲的「变成图片的样子」。');
}

var arg = process.argv[2];
var p = arg ? Promise.resolve(JSON.parse(fs.readFileSync(arg, 'utf8')))
  : fetchJson('https://api.github.com/search/repositories?q=stars:%3E50000&per_page=30');
p.then(function (d) {
  if (!d || !d.items || !d.items.length) throw new Error('没取到结果（可能被限流了）；把响应存成文件再跑');
  main(d.items);
}).catch(function (e) {
  console.error('失败：' + e.message);
  process.exit(1);
});
