#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
新手引导探针：把 onboarding.js 挂到一个模拟骨架上，逐步驱动，
量「洞」和气泡的位置是否正确、跨页跳转能否等到目标、跳过/完成是否落库。
"""
import json, os, threading, functools, http.server, socketserver
from playwright.sync_api import sync_playwright

WEB = '/tmp/work/rel/app/src/main/assets/web'

HTML = """<!DOCTYPE html>
<html lang="zh-CN" data-theme="light" data-nav="glass">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="css/app.css">
<link rel="stylesheet" href="css/onboarding.css">
</head>
<body>
<div id="app">
  <header id="appbar"><div class="appbar-inner">
    <button class="icon-btn" id="btn-back" hidden></button>
    <div class="appbar-title" id="appbar-title">首页</div>
    <div class="appbar-actions" id="appbar-actions"><button class="icon-btn" aria-label="下载管理"><svg width="22" height="22"></svg></button></div>
  </div></header>
  <main id="view"></main>
  <nav id="tabbar">
    <button class="tab" data-tab="home"><span class="tab-label">首页</span></button>
    <button class="tab" data-tab="notifications"><span class="tab-label">通知</span></button>
    <button class="tab" data-tab="explore"><span class="tab-label">探索</span></button>
    <button class="tab" data-tab="search"><span class="tab-label">搜索</span></button>
    <button class="tab" data-tab="profile"><span class="tab-label">我的</span></button>
  </nav>
</div>
<script>
window.__toasts = [];
window.Store = { _d: {}, get: function (k) { return this._d[k]; }, set: function (k, v) { this._d[k] = v; return v; } };
window.UI = { toast: function (m) { window.__toasts.push(m); } };
var PAGES = {
  '/': '<div class="page"><div class="card">首页内容</div></div>',
  '/search': '<div class="search-bar"><div class="search-input"><input placeholder="搜索"><button class="clear">x</button></div>' +
             '<button class="btn" id="go">搜索</button></div>' +
             '<div class="chips" id="tabs"><span class="chip">仓库</span><span class="chip">用户</span></div>',
  '/explore': '<div class="seg-wrap"><button>今日</button><button>本周</button><button>本月</button></div>' +
              '<div class="chips" id="langs"><span class="chip">全部语言</span><span class="chip">Go</span></div>' +
              '<div id="eres"></div>',
  '/settings': '<div class="set-group"><button class="set-row" data-s="glass"><span class="k">液态玻璃底栏</span></button>' +
               '<button class="set-row" data-s="guide"><span class="k">新手指导</span></button></div>'
};
window.__rendered = [];
function render(p) { window.__rendered.push(p); document.getElementById('view').innerHTML = PAGES[p] || PAGES['/']; }
window.Router = {
  go: function (p) { p = p || '/'; location.hash = '#' + p; render(p); },
  replace: function (p) { p = p || '/'; location.hash = '#' + p; render(p); },
  render: function () { render((location.hash || '#/').replace(/^#/, '')); },
  reload: function () { this.render(); }
};
render('/');
</script>
<script src="js/onboarding.js"></script>
</body></html>
"""

os.makedirs('/tmp/probe2', exist_ok=True)
open('/tmp/probe2/index.html', 'w', encoding='utf-8').write(HTML)
os.system('rm -rf /tmp/probe2/css /tmp/probe2/js')
os.system('ln -s %s/css /tmp/probe2/css && ln -s %s/js /tmp/probe2/js' % (WEB, WEB))

class Q(socketserver.TCPServer):
    allow_reuse_address = True
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory='/tmp/probe2')
httpd = Q(('127.0.0.1', 8741), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

PROBE = """() => {
  var r = {};
  var root = document.getElementById('ob-root');
  r.shown = !!root && root.classList.contains('show');
  r.noTarget = !!root && root.classList.contains('no-target');
  var h = document.getElementById('ob-hole'), t = document.getElementById('ob-tip');
  var hb = h.getBoundingClientRect(), tb = t.getBoundingClientRect();
  r.hole = { x: Math.round(hb.left), y: Math.round(hb.top), w: Math.round(hb.width), h: Math.round(hb.height),
             round: h.classList.contains('round') };
  r.tip = { x: Math.round(tb.left), y: Math.round(tb.top), w: Math.round(tb.width), h: Math.round(tb.height) };
  r.title = document.getElementById('ob-title').textContent;
  r.num = document.getElementById('ob-step-num').textContent;
  r.bar = document.querySelector('#ob-progress > i').style.width;
  r.nextText = document.getElementById('ob-next').textContent;
  r.prevHidden = document.getElementById('ob-prev').hidden;
  r.skipVisible = document.getElementById('ob-skip').getBoundingClientRect().width > 0;
  r.hash = location.hash;
  r.tipInside = tb.left >= 0 && tb.top >= 0 && tb.right <= window.innerWidth + 1 && tb.bottom <= window.innerHeight + 1;
  r.holeInside = hb.left >= -1 && hb.top >= -1 && hb.right <= window.innerWidth + 1 && hb.bottom <= window.innerHeight + 1;
  return r;
}"""

DEVICES = [
    ('魅族20 360x780', 360, 780, {'--safe-t': '32px', '--safe-b': '18px'}),
    ('小屏 320x569',   320, 569, {'--safe-t': '24px', '--safe-b': '0px'}),
    ('大屏 480x1040',  480, 1040, {'--safe-t': '36px', '--safe-b': '24px'}),
    ('横屏 852x393',   852, 393, {'--safe-t': '0px', '--safe-b': '0px'}),
]

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, w, h, ins in DEVICES:
        ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2)
        pg = ctx.new_page()
        pg.goto('http://127.0.0.1:8741/index.html')
        pg.wait_for_timeout(200)
        pg.evaluate("(a)=>{for(var k in a) document.documentElement.style.setProperty(k,a[k]);}", ins)
        print('\n===== %s =====' % name)
        pg.evaluate("window.Onboarding.start()")
        pg.wait_for_timeout(350)
        for i in range(10):
            r = pg.evaluate(PROBE)
            ok = r['tipInside'] and r['holeInside']
            print('  %-2s %-14s 洞(%d,%d %dx%d%s) 气泡(%d,%d) %-6s 内=%s'
                  % (r['num'], r['title'][:14], r['hole']['x'], r['hole']['y'], r['hole']['w'], r['hole']['h'],
                     ' R' if r['hole']['round'] else '', r['tip']['x'], r['tip']['y'], r['hash'], ok))
            pg.click('#ob-next')
            pg.wait_for_timeout(320)
        r = pg.evaluate(PROBE)
        done = pg.evaluate("window.Store.get('onboarded')")
        shown = r['shown']
        print('  走完 10 步后：遮罩已关=%s  onboarded=%s  回到=%s' % (not shown, done, r['hash']))
        ctx.close()

    # ---- 跳过路径 ----
    print('\n===== 跳过 / 返回键 / 重看 =====')
    ctx = b.new_context(viewport={'width': 393, 'height': 852}, device_scale_factor=2)
    pg = ctx.new_page()
    pg.goto('http://127.0.0.1:8741/index.html'); pg.wait_for_timeout(200)
    print('  初始 isDone =', pg.evaluate("window.Onboarding.isDone()"))
    pg.evaluate("window.Onboarding.start()"); pg.wait_for_timeout(300)
    print('  启动后 isActive =', pg.evaluate("window.Onboarding.isActive()"))
    pg.click('#ob-next'); pg.wait_for_timeout(250)
    pg.click('#ob-skip'); pg.wait_for_timeout(250)
    print('  点跳过后：isActive =', pg.evaluate("window.Onboarding.isActive()"),
          ' onboarded =', pg.evaluate("window.Store.get('onboarded')"))
    # 上一步
    pg.evaluate("window.Onboarding.restart()"); pg.wait_for_timeout(300)
    print('  重看：isDone =', pg.evaluate("window.Onboarding.isDone()"), '(restart 会先清状态)')
    pg.click('#ob-next'); pg.wait_for_timeout(250)
    print('  第2步 prev 隐藏 =', pg.evaluate("document.getElementById('ob-prev').hidden"))
    pg.click('#ob-prev'); pg.wait_for_timeout(250)
    print('  点上一步后编号 =', pg.evaluate("document.getElementById('ob-step-num').textContent"))
    pg.evaluate("window.Onboarding.quit()"); pg.wait_for_timeout(200)
    print('  quit 后 isActive =', pg.evaluate("window.Onboarding.isActive()"),
          ' onboarded =', pg.evaluate("window.Store.get('onboarded')"))
    # 自动启动：看过就不再弹
    print('  autoStart（已看过）返回 =', pg.evaluate("window.Onboarding.autoStart()"))
    pg.evaluate("window.Store.set('onboarded', 0)")
    print('  autoStart（清掉状态）返回 =', pg.evaluate("window.Onboarding.autoStart()"))
    pg.wait_for_timeout(700)
    print('  自动弹出了吗 isActive =', pg.evaluate("window.Onboarding.isActive()"))
    ctx.close()
    b.close()
