#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本轮改动的探针（跑真实 app）：
  1) 设置页：删掉的那两段 .set-note 真的没有了，剩下的说明仍有信息量
  2) 设置项数量与清单不变（11 行）
  3) 回归：新手指导 / 重置新手引导 / iOS风格 三行都在，开关还能切
  4) 回归：多种机型宽度下设置页无横向溢出
  5) 出两张图，给用户看改前改后的设置页
"""
import os, threading, functools, http.server, socketserver
from playwright.sync_api import sync_playwright

WEB = '/tmp/work/rel/app/src/main/assets/web'
PORT = 8761

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=WEB)
class Q(socketserver.TCPServer):
    allow_reuse_address = True
httpd = Q(('127.0.0.1', PORT), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

URL = 'http://127.0.0.1:%d/index.html' % PORT

READ = """() => {
  var rows = [];
  document.querySelectorAll('#view [data-s]').forEach(function (b) {
    rows.push({ s: b.getAttribute('data-s'),
                k: (b.querySelector('.k') ? b.querySelector('.k').textContent : '').trim(),
                v: (b.querySelector('.v') ? b.querySelector('.v').textContent : '').trim(),
                on: b.getAttribute('data-on') });
  });
  var notes = [];
  document.querySelectorAll('#view .set-note').forEach(function (n) {
    notes.push(n.textContent.trim().replace(/\\s+/g, ' '));
  });
  return { rows: rows, notes: notes, count: rows.length,
           overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
           noteH: Array.prototype.reduce.call(document.querySelectorAll('#view .set-note'),
                  function (a, n) { return a + Math.round(n.getBoundingClientRect().height); }, 0) };
}"""

SHOTS = '/workspace'
DEVS = [('魅族20Pro', 393, 852, 2.75), ('魅族20', 320, 800, 2.0), ('Pixel 7', 412, 915, 2.625)]

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------- 1. 设置页内容 ----------
    ctx = b.new_context(viewport={'width': 393, 'height': 852}, device_scale_factor=2.75)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(1200)
    pg.evaluate("window.Onboarding.quit()")
    pg.wait_for_timeout(300)
    pg.evaluate("location.hash = '#/settings'")
    pg.wait_for_timeout(900)

    print('=== 1. 设置页 ===')
    d = pg.evaluate(READ)
    print('  页面错误      :', errs[:2] if errs else '无')
    print('  设置项行数    :', d['count'])
    for r in d['rows']:
        print('     [%-10s] %s%s' % (r['s'], r['k'][:24], ('  → ' + r['v']) if r['v'] else ''))
    print('  灰度说明条数  :', len(d['notes']))
    for i, n in enumerate(d['notes']):
        print('     %d) %s' % (i + 1, n[:70] + ('…' if len(n) > 70 else '')))
    bad = ['启动页决定应用打开时默认显示的标签页', '十步带你认全顶栏']
    print('  删掉的两段没出现 :', not any(k in n for n in d['notes'] for k in bad))
    print('  说明文字总高  : %dpx（0 表示这页已没有灰字块）' % d['noteH'])

    # ---------- 2. 三行关键功能仍在 ----------
    print('\n=== 2. 回归：三行关键功能 ===')
    have = [r['s'] for r in d['rows']]
    for k in ('guide', 'guideReset', 'glass'):
        print('  %-11s: %s' % (k, '在' if k in have else '缺失'))
    before = pg.evaluate("window.App.navGlass()")
    pg.click('[data-s="glass"]')
    pg.wait_for_timeout(500)
    after = pg.evaluate("window.App.navGlass()")
    print('  iOS风格开关  : %s → %s（应翻转） data-nav=%s' %
          (before, after, pg.evaluate("document.documentElement.getAttribute('data-nav')")))
    pg.click('[data-s="glass"]')
    pg.wait_for_timeout(400)

    pg.screenshot(path=os.path.join(SHOTS, '设置页-删掉冗余说明-浅色.png'), full_page=True)
    pg.evaluate("document.documentElement.setAttribute('data-theme','dark')")
    pg.wait_for_timeout(400)
    pg.screenshot(path=os.path.join(SHOTS, '设置页-删掉冗余说明-深色.png'), full_page=True)
    print('  已截图        : 浅色 / 深色')

    # ---------- 3. 多机型无溢出 ----------
    print('\n=== 3. 多机型 ===')
    for name, w, h, sc in DEVS:
        c2 = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=sc)
        p2 = c2.new_page()
        p2.goto(URL)
        p2.wait_for_timeout(1100)
        p2.evaluate("window.Onboarding.quit()")
        p2.wait_for_timeout(250)
        p2.evaluate("location.hash = '#/settings'")
        p2.wait_for_timeout(800)
        r2 = p2.evaluate(READ)
        print('  %-10s %dx%d  行数=%d  横向溢出=%s  灰字高=%dpx' %
              (name, w, h, r2['count'], r2['overflow'], r2['noteH']))
        c2.close()

    ctx.close()
    b.close()
print('\n完成')
