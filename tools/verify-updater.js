#!/usr/bin/env node
/**
 * updater.js —— 更新压制/恢复逻辑的回归用例
 *
 * 背景：这条逻辑靠手点没法验。
 *   一次压制最少要跨几分钟（下载 + 安装），而兜底的自动恢复要等 30 分钟，
 *   手机上「点两下看看」根本等不起；更麻烦的是坏状态一旦写下去，
 *   只能靠清数据才能重来。所以改成在这里直接驱动 Updater 的那几个函数。
 *
 * 做法：给 updater.js 喂一套假的 window（Store / UI / API / Native 全是假的，
 * Date.now 换成手动推进的时钟），然后调用 Updater 暴露出来的
 * markUpdating / suppressed / clearUpdating / pendingInstall。
 *
 * 用法：node tools/verify-updater.js
 * 退出码 0 = 全通过。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SRC = process.argv[2] ||
  path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'web', 'js', 'updater.js');

/* ---- 假时钟：不睡真觉，靠手动往前拨 ---- */
var now = 1758000000000;
function advance(ms) { now += ms; }

function loadUpdater() {
  var store = {};
  var win = {
    Store: {
      get: function (k) { return k in store ? store[k] : null; },
      set: function (k, v) { store[k] = String(v); }
    },
    UI: { toast: noop, toastOk: noop, loading: noop, sheet: noop, $: function () { return null; } },
    API: { get: function () { return Promise.resolve({ status: 404 }); } },
    MD: {}, Native: {}, NativeBridge: {},
    icon: function () { return ''; },
    open: noop, atob: function () { return ''; },
    console: { info: noop, warn: noop, log: noop },
    document: { getElementById: function () { return null; } }
  };
  win.window = win;

  /* Date.now 走假时钟，其余 Date 行为照旧 */
  var Fake = function () { return new RealDate(now); };
  var RealDate = Date;
  Fake.now = function () { return now; };
  Fake.parse = RealDate.parse;
  Fake.UTC = RealDate.UTC;
  Fake.prototype = RealDate.prototype;

  var sandbox = { window: win, console: win.console, Date: Fake, RealDate: RealDate };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf-8'), sandbox);

  return { Updater: win.Updater, Store: win.Store };
}

function noop() { }

var pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

var NEW_SHA = repeat('a', 64);   // 服务器上的新包
var OLD_SHA = repeat('b', 64);   // 本机当前这个包
function repeat(c, n) { return new Array(n + 1).join(c); }

var env = loadUpdater();
var U = env.Updater;
var info = {
  latest: '1.1.5', current: '1.1.5',
  sha256: NEW_SHA, localSha: OLD_SHA, fromContent: true
};

console.log('场景一：点了「立即更新」→ 装上之前不再反复弹');
ok('一开始没有被压制', U.suppressed(info) === false);
U.markUpdating(info);
ok('点完之后被压制住', U.suppressed(info) === true);
advance(10 * 60 * 1000);
ok('10 分钟后（有效期内）仍然压制', U.suppressed(info) === true);

console.log('场景二：下载失败 → 原生推回执 → 立刻恢复提醒');
if (typeof U.clearUpdating !== 'function') {
  ok('收到回执后不再压制', false);   // 旧版没有这个入口，等于坏状态无法恢复
} else {
  U.clearUpdating('download-failed');
  ok('收到回执后不再压制', U.suppressed(info) === false);
}

console.log('场景三：没有回执，纯靠有效期兜底（用户在安装界面点了取消）');
env = loadUpdater(); U = env.Updater;
now = 1758000000000;
U.markUpdating(info);
ok('刚点完被压制', U.suppressed(info) === true);
advance(31 * 60 * 1000);
ok('超过 30 分钟自动解除压制', U.suppressed(info) === false);

console.log('场景四：确实装上了 → 记录自己退休');
env = loadUpdater(); U = env.Updater;
now = 1758000000000;
U.markUpdating(info);
var installed = { latest: '1.1.5', current: '1.1.5', sha256: NEW_SHA, localSha: NEW_SHA };
ok('本机指纹追平后不再压制', U.suppressed(installed) === false);
U.markUpdating(info);
ok('追平后标记被清干净', U.pendingInstall(installed) === '');

console.log('场景五：旧包写下的「无期限」记录自动自愈');
env = loadUpdater(); U = env.Updater;
now = 1758000000000;
U.markUpdating(info);
env.Store.set('updUpdatingAt', '');   // 抹掉时间戳 —— 等价于旧版写下的记录
ok('缺时间戳时不压制（用户能重新收到提醒）', U.suppressed(info) === false);

console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
