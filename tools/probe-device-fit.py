#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
机型适配探针：不开网络、不跑整个 App，只把 app.css 挂到一个最小骨架上，
量顶栏标题对齐、搜索按钮尺寸、以及各机型尺寸下的布局是否破版。
"""
import json, os, http.server, socketserver, threading, functools
from playwright.sync_api import sync_playwright

WEB = '/tmp/work/rel/app/src/main/assets/web'

SKELETON = """<!DOCTYPE html>
<html lang="zh-CN" data-theme="light" data-density="comfortable" data-nav="glass">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="stylesheet" href="css/app.css">
</head>
<body>
<div id="app">
  <header id="appbar">
    <div class="appbar-inner">
      <button class="icon-btn" id="btn-back" aria-label="返回" hidden></button>
      <div class="appbar-title" id="appbar-title">搜索</div>
      <div class="appbar-actions" id="appbar-actions"></div>
    </div>
  </header>
  <div id="view">
    <div class="search-bar">
      <div class="search-input">
        <svg width="18" height="18"></svg>
        <input id="q" placeholder="搜索仓库、用户、代码…">
        <button class="clear" id="clr"><svg width="17" height="17"></svg></button>
      </div>
      <button class="btn" id="go">搜索</button>
    </div>
    <div style="height:1200px;background:linear-gradient(#eee,#333)"></div>
  </div>
  <nav id="tabbar"><div class="tab-ind" id="tab-ind"></div></nav>
</div>
<script>
window.__probe = function () {
  var r = {};
  var t = document.getElementById('appbar-title');
  var cs = getComputedStyle(t);
  var tr = t.getBoundingClientRect();
  r.title = { align: cs.textAlign, left: Math.round(tr.left), width: Math.round(tr.width),
              fontSize: cs.fontSize, paddingLeft: cs.paddingLeft };
  var go = document.getElementById('go');
  var gr = go.getBoundingClientRect();
  r.goBtn = { w: Math.round(gr.width), h: Math.round(gr.height), fontSize: getComputedStyle(go).fontSize };
  var si = document.querySelector('.search-input').getBoundingClientRect();
  r.searchInput = { w: Math.round(si.width), h: Math.round(si.height) };
  var bar = document.getElementById('appbar').getBoundingClientRect();
  r.appbar = { top: Math.round(bar.top), h: Math.round(bar.height) };
  var v = document.getElementById('view').getBoundingClientRect();
  r.view = { top: Math.round(v.top), padTop: getComputedStyle(document.getElementById('view')).paddingTop,
             padLeft: getComputedStyle(document.getElementById('view')).paddingLeft,
             padBottom: getComputedStyle(document.getElementById('view')).paddingBottom };
  var tb = document.getElementById('tabbar').getBoundingClientRect();
  r.tabbar = { left: Math.round(tb.left), right: Math.round(tb.right), h: Math.round(tb.height),
               bottom: Math.round(window.innerHeight - tb.bottom) };
  var ib = document.getElementById('btn-back');
  r.iconBtnW = getComputedStyle(ib).width;
  r.docScrollW = document.documentElement.scrollWidth;
  r.winW = window.innerWidth;
  r.overflowX = r.docScrollW > r.winW + 1;
  return r;
};
</script>
</body></html>
"""

os.makedirs('/tmp/probe', exist_ok=True)
open('/tmp/probe/index.html', 'w', encoding='utf-8').write(SKELETON)
os.system('rm -f /tmp/probe/css && ln -s %s/css /tmp/probe/css' % WEB)

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory='/tmp/probe')
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(('127.0.0.1', 8731), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

# 注意：viewport 是 CSS px（物理像素 ÷ DPR），--safe-* 也是 CSS px
# （app.js 里已经把原生返回的设备像素除以 DPR 了）。
DEVICES = [
    # 名称, CSS宽, CSS高, DPR, 安全区
    ('魅族20 360x780 dpr3',        360,  780, 3.0,  {'--safe-t': '32px', '--safe-b': '18px'}),
    ('魅族18 440x977 dpr3.27',     440,  977, 3.27, {'--safe-t': '30px', '--safe-b': '22px'}),
    ('魅族16 432x864 dpr2.5',      432,  864, 2.5,  {'--safe-t': '24px', '--safe-b': '0px'}),
    ('老小屏 320x569 dpr1.5',      320,  569, 1.5,  {'--safe-t': '24px', '--safe-b': '0px'}),
    ('小屏 360x640 dpr2',          360,  640, 2.0,  {'--safe-t': '24px', '--safe-b': '48px'}),
    ('中屏 393x852 dpr2.75',       393,  852, 2.75, {'--safe-t': '28px', '--safe-b': '16px'}),
    ('大屏 480x1040 dpr3',         480, 1040, 3.0,  {'--safe-t': '36px', '--safe-b': '24px'}),
    ('超大 412x915 dpr2.6',        412,  915, 2.6,  {'--safe-t': '30px', '--safe-b': '12px'}),
    ('手机横屏 852x393 dpr2.75',   852,  393, 2.75, {'--safe-t': '0px', '--safe-b': '0px', '--safe-l': '28px', '--safe-r': '28px'}),
    ('平板 800x1280 dpr2',         800, 1280, 2.0,  {'--safe-t': '24px', '--safe-b': '12px'}),
]

MODES = ['glass', 'classic']

with sync_playwright() as p:
    b = p.chromium.launch(args=['--force-device-scale-factor=1'])
    for mode in MODES:
        print('\n===== data-nav=%s =====' % mode)
        for name, w, h, dpr, insets in DEVICES:
            ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=dpr)
            pg = ctx.new_page()
            pg.goto('http://127.0.0.1:8731/index.html')
            pg.wait_for_timeout(150)
            pg.evaluate("""(a) => {
              document.documentElement.setAttribute('data-nav', a.mode);
              for (var k in a.ins) document.documentElement.style.setProperty(k, a.ins[k]);
            }""", {'mode': mode, 'ins': insets})
            pg.wait_for_timeout(80)
            r = pg.evaluate('window.__probe()')
            print('%-26s 标题left=%-4d 对齐=%-5s 字号=%-5s | 搜索钮 %dx%d (input高%d) | 顶栏h=%-3d view上pad=%-4s | 底栏左右=%d/%d 高%d | 横向溢出=%s'
                  % (name, r['title']['left'], r['title']['align'], r['title']['fontSize'],
                     r['goBtn']['w'], r['goBtn']['h'], r['searchInput']['h'],
                     r['appbar']['h'], r['view']['padTop'],
                     r['tabbar']['left'], r['tabbar']['right'], r['tabbar']['h'],
                     r['overflowX']))
            ctx.close()
    b.close()
